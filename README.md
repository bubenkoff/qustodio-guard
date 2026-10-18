# qustodio-guard

A small root daemon for macOS. It logs a child out when [Qustodio](https://www.qustodio.com)
says their time is up, because Qustodio's own Mac agent can be beaten.

## Why this exists

On macOS the Qustodio agent can be raced at unlock. If the child unlocks with **Touch ID** and
is quick enough to bring a browser to the front, Qustodio's block screen never comes up. It then
stays down for the rest of the session. Our child found this on his own and used it every day.
The cloud dashboard kept counting correctly (10–11 hours of screen time on days with a
1-hour limit), but nothing was enforced.

We reported it in August 2026 (request 856745) and sent a screen recording of the
reproduction. Qustodio confirmed it as a bug and opened an engineering report. They gave no ETA.
Their suggested workaround was to delete the child's Touch ID fingerprints. That takes away a
normal macOS feature to cover for a defect in a paid parental-control product. Two months
later, on agent 207.0.7475.1, the bypass still worked. So we built this instead.

## What it does

A LaunchDaemon runs as root every 5 seconds. Each run decides from cached state, with no network.
It talks to the Qustodio API at most once a minute; screen time there lags a few minutes anyway.
On each run it:

1. Looks at who is at the screen. It skips the login window and **admin accounts**, so parents
   are never guarded (an admin could remove the guard anyway).
2. Asks Qustodio's cloud which profile watches that local account. Qustodio lists the accounts it
   monitors on every Mac as `{uid, name, profile}`.
3. Reads that profile's rules (the daily quota and the allowed hours), its **Routines**, today's
   screen time, and any **extra time** granted from the parent app today.
   - Routines (Bedtime, School, Homework…) are the schedule. A routine whose policy blocks the
     device (`block_type` 2, e.g. Bedtime) ends the session. A routine that does not count
     towards the daily limit (`counts_towards_daily_time_quota: false`, e.g. School) suspends
     the quota while it runs. Paused routines are ignored. "No internet" routines are left to
     Qustodio, because the guard can only log out. Schedules are re-read every 5 minutes, and
     those running past midnight are handled.
   - Quota time is what Qustodio counts: time under the default rules plus time in routines
     that count, not the raw screen-time total. On a school day those differ by hours.
   - Without any routines, the older "Restricted times" (`time_ranges`) are used instead.
   - The quota follows Qustodio. It counts only if limits are on for weekdays or weekends.
     A quota of 0 is Qustodio's *Block* (the whole day), unless every day is 0, which means
     limits were never set. Screen time is the profile's total across its devices, which is
     how Qustodio describes it: "all devices under one child profile share the same time limits".
   - Extra time is added to the day's quota, as Qustodio documents it. While a grant runs,
     Qustodio puts the child under the free rules (it books the time to the "Free" routine), so
     the guard also suspends a running routine's app and video checks. In addition, and this
     is our own choice, nothing is enforced for `duration` seconds from the moment of the
     grant, even outside the allowed hours. Qustodio's docs do not say whether a grant beats
     restricted hours, and a parent who grants time at 22:02 means for it to be used.
4. If the quota is used up, or the current hour is outside the allowed hours, it warns the child
   with a dialog in their macOS language (English, Ukrainian, Dutch, German, Spanish, French;
   anything else falls back to English). After 60 seconds it ends that user's session, and only
   that user's, with `launchctl bootout gui/<uid>`. For 30 minutes after a warning, every new
   login is ended within about 5 seconds.

It polls rather than reacting to an unlock event, so there is no event to race.

**Routine app rules.** When the agent is beaten, Qustodio's app blocking goes down with it. So
while a routine runs, the guard compares the child's foreground apps (`lsappinfo`) with the
routine's Mac app rules: apps allowed by name or by category (Qustodio's catalogue gives each
app's bundle id and category), and the routine's default. Anything not allowed gets a warning
and is closed 15 s later. The Finder and the rest of the desktop, Qustodio itself, TeamViewer,
apps Qustodio marks unblockable, and **browsers** are never touched. Browsers are exempt because
the web rules decide what they may open, and a routine that forgot to allow one would otherwise
take school away with it. Apps Qustodio has never seen fall to the
routine's default, as they would in Qustodio, so add a new school app to the routine's
allow-list. `"routine_apps": "log"` or `"off"` in `config.json`.

**Local video.** Films and clips played from disk (a browser via `file://`, QuickTime, VLC,
IINA…) are invisible to Qustodio as well. During a routine that blocks Entertainment, the guard
checks every 30 s with `lsof` for a video file open *for reading* by a player. If it finds one,
it warns and then closes that player. iMovie is deliberately not a player: making a video for
school is not watching one. Recording, which writes, does not count, and neither do videos
inside app bundles. `"local_video": "log"` or `"off"`.

**Offline YouTube.** YouTube Premium can download videos into the browser's own storage and play
them with no network request, so Qustodio's web filter never sees them. A child can download in
free time and watch during a routine that blocks Entertainment (e.g. Homework). While such a
routine runs, the guard checks every 30 s whether Chrome, Brave, Edge or Opera has read three
or more chunks of offline YouTube in the last minute. If so, it shows a warning, and 15 s later
closes the browser. It reads the files' access times (APFS updates them on read) and does not
delete anything. Set `"offline_youtube": "log"` in `config.json` to only log, or `"off"` to
disable it.

**Offline.** The rules, today's usage and any running grant are cached. While the API cannot
be reached, the guard adds the screen time it counts on the Mac itself to the last figure it
got from the cloud. Sleep and more than 2 minutes without keyboard or mouse input do not count.
So switching Wi-Fi off near the limit does not stop the clock, and the allowed hours still
apply. Failed API calls are retried once a minute, not every 5 seconds. Offline counting
restarts at midnight.

Your settings stay in one place, Qustodio. The daemon only enforces them.

## Install

From a parent (admin) account on the child's Mac:

```bash
curl -fsSL https://github.com/bubenkoff/qustodio-guard/archive/refs/heads/main.tar.gz | tar xz -C /tmp
sudo /tmp/qustodio-guard-main/install.sh
```

The installer asks once for the **parent's** Qustodio e-mail and password. It stores only the
OAuth refresh token, in `/var/root/qustodio-guard/token` (root-only, mode 600). The password
never touches disk or any process's argv.

If automatic detection cannot match the account (for example, it was renamed after Qustodio was
installed), name the profile yourself:

```bash
sudo /tmp/qustodio-guard-main/install.sh --profile "Alex"
```

To check what it would do without logging anyone out:

```bash
sudo osascript -l JavaScript "/Library/Application Support/qustodio-guard/guard.js" /var/root/qustodio-guard --dry-run
```

The log is in `/var/log/qustodio-guard.log`. To remove everything, including the token:
`sudo "/Library/Application Support/qustodio-guard/uninstall.sh"`.

**Updates.** A second daemon pulls `main` from this repository every 6 hours and replaces the
installed scripts that changed. It only does so if the new `guard.js` compiles, so a broken
push leaves the old version running. If `install.sh` changed, the updater runs it, and it
reloads only the launchd jobs whose plist changed. The one exception is the updater's own
plist, which needs a manual re-run. Remember what this means: whoever can push to `main` runs code
as root on the child's Mac. Fork it if you want to own that.

Optional `/var/root/qustodio-guard/config.json`:

```json
{ "profile": "Alex", "user": "alex", "grace_seconds": 60, "lang": "uk",
  "offline_youtube": "block", "routine_apps": "block", "local_video": "block",
  "message": "Time's up: {why}.\nSave your work — you will be logged out in {seconds} s." }
```

## Home Assistant reports (optional)

Install with `--ha-webhook <url>` (stored in the root-only `config.json`), and the guard reports
to a Home Assistant webhook:
- a **heartbeat** every 15 min while the Mac is awake: version, who is at the screen, routine,
  quota time, API state, offline stores found;
- **alerts** when it cannot do its job: the API has been failing for ~3 h, the Qustodio login
  is rejected, the profile is not found, or the browsers' storage cannot be read. Each alert
  repeats every 12 h while it lasts, and a resolved message follows when it ends;
- **actions** at the first warning: logging out, closing an app, stopping offline or local video.

Alerts and actions are queued while HA is unreachable, for example at school. Payload:
`{host, kid, event: heartbeat|alert|resolved|action, key, message, status}`. A Home Assistant
package that turns these into per-child sensors and Telegram messages, plus a 26-hour silence
watchdog, is in [docs/home-assistant.yaml](docs/home-assistant.yaml).

```bash
sudo "/Library/Application Support/qustodio-guard/install.sh" --ha-webhook "http://<ha>:8123/api/webhook/<id>"
```

## The API

What this uses, and what else the unofficial API can do (including changing routines), is in
[docs/API.md](docs/API.md), along with how to find the endpoints again when Qustodio changes them.

## Requirements and caveats

- A routine's own app and website rules (e.g. "only these apps during Homework") are
  Qustodio's to enforce. The guard only decides whether the session may continue at all.
- **It always logs out**, which is Qustodio's *Lock device* on a Mac. With *Lock navigation*
  only, Qustodio would just block browsing; the guard is stricter.
- **The child's account must be a standard (non-admin) user.** Otherwise they can unload the
  daemon. The installer lists which accounts are which.
- **The Qustodio API is unofficial.** It is the same API the Qustodio web app uses; the endpoints
  come from [home-assistant-qustodio](https://github.com/matt-richardson/home-assistant-qustodio).
  It can change without notice. API failures are logged, and the guard falls back to its cache.
- **Screen time is per profile**, summed over all of the child's devices, which is how
  Qustodio's own quota counts it. The cloud total lags a few minutes behind real usage.
- The token belongs to the parent account, so anyone with root on that Mac can use it. That is
  the same trust boundary as the Qustodio agent itself.
- Written in JXA (`osascript -l JavaScript`) with `curl`, both shipped with macOS. There is
  nothing to install.

## License

MIT
