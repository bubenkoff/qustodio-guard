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

A LaunchDaemon runs every minute as root. On each run it:

1. Looks at who is at the screen. It skips the login window and **admin accounts**, so parents
   are never guarded (an admin could remove the guard anyway).
2. Asks Qustodio's cloud which profile watches that local account. Qustodio lists the accounts it
   monitors on every Mac as `{uid, name, profile}`.
3. Reads that profile's rules (the daily quota and the allowed hours) and today's screen time.
4. If the quota is used up, or the current hour is outside the allowed hours, it warns the child
   with a dialog. After 60 seconds it ends the session with `launchctl bootout gui/<uid>`. Within
   30 minutes of a warning it logs the child out without warning again, so logging back in
   gains nothing.

It polls rather than reacting to an unlock event, so there is no event to race. The rules
and today's usage are cached. If the child switches off Wi-Fi after the limit is hit, they
stay locked out, and the allowed hours still apply offline.

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

The log is in `/var/log/qustodio-guard.log`. To remove it: `sudo ./uninstall.sh`.

Optional `/var/root/qustodio-guard/config.json`:

```json
{ "profile": "Alex", "user": "alex", "grace_seconds": 60,
  "message": "Time's up: {why}.\nSave your work — you will be logged out in {seconds} s." }
```

## Requirements and caveats

- **The child's account must be a standard (non-admin) user.** Otherwise they can unload the
  daemon. The installer lists which accounts are which.
- **The Qustodio API is unofficial.** It is the same API the Qustodio web app uses; the endpoints
  come from [home-assistant-qustodio](https://github.com/matt-richardson/home-assistant-qustodio).
  It can change without notice. API failures are logged, and the guard falls back to its cache.
- **Screen time is per profile**, summed over all of the child's devices, which is how
  Qustodio's own quota counts it. The cloud total lags a few minutes behind real usage.
- **Extra time granted from the Qustodio app is not seen yet.** Raise the quota for the day
  instead.
- The token belongs to the parent account, so anyone with root on that Mac can use it. That is
  the same trust boundary as the Qustodio agent itself.
- Written in JXA (`osascript -l JavaScript`) with `curl`, both shipped with macOS. There is
  nothing to install.

## License

MIT
