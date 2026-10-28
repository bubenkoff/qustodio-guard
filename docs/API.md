# Qustodio API notes

Qustodio has no public API. This is the API its own parent web app uses, as observed on
**2026-10-18 against parents-app `PAR-182.41.0`**. It can change at any time. Everything below
was exercised for real unless it says otherwise.

## Re-deriving it when it changes

Every endpoint the web app uses is declared in one place in its bundle:

```bash
curl -fsSL "https://static.qustodio.com/parents-app/<version>/family/browser/static/js/main.<hash>.js" -o main.js
# endpoint table: this.endpoint("<name>", ["get","patch",...], function(e){ return "v2/accounts/..." })
grep -o 'this\.[a-zA-Z]*=this\.endpoint("[^"]*",\[[^]]*\],(function(e){return"[^"]*"' main.js
```

The version and hash are in the `<script>` tags of `https://family.qustodio.com/parents-app`.
The same bundle holds the web category map: search for `{educational:4,`.

## Auth

`POST https://api.qustodio.com/v1/oauth2/access_token`, form-encoded:
- `client_id=264ca1d226906aa08b03`, `client_secret=3e8826cbed3b996f8b206c7d6a4b2321529bc6bd`
  (the web app's own client, not a secret of ours);
- `grant_type=password` with `username` and `password`, or `grant_type=refresh_token` with
  `refresh_token`.

The response carries `access_token`, `refresh_token` and `expires_in`, about 30 days. Send
`Authorization: Bearer <access_token>`. See `qustodio-token.sh`.

## IDs

`GET /v1/accounts/me` gives `id` (numeric, used by v1) and `uid` (hex, used by v2). Profiles
and devices have both as well. v1 paths take the numeric ids, v2 paths take the uids.

## Read

| What | Request |
|---|---|
| Account | `GET /v1/accounts/me` |
| Profiles | `GET /v1/accounts/{id}/profiles/`, including `status.is_online` and last location |
| Devices | `GET /v1/accounts/{id}/devices`. `users[]` maps each local account (`uid` = macOS uid, `name` = full name) to a `profile_id`. Also `version`, `platform` (1 macOS, 2 Android, 4 iOS), `alerts.unauthorized_remove` |
| Rules (default) | `GET /v1/accounts/{id}/profiles/{pid}/rules?app_rules=1`, see below |
| Screen time by hour | `GET /v2/accounts/{uid}/profiles/{puid}/summary_hourly?date=YYYY-MM-DD`, see below |
| Apps and sites per day | `GET /v2/accounts/{uid}/profiles/{puid}/summary/domains-and-apps?min_date=…&max_date=…`. `type` 101 = site (with `categories`), 301 = app (with `platform`) |
| Routines | `GET /v2/accounts/{uid}/profiles/{puid}/routines?include_disabled=1&filter_app_rules=false` |
| Routine schedules | `GET /v2/accounts/{uid}/profiles/{puid}/routines/{ruid}/schedules` |
| Extra time today | `GET /v2/accounts/{uid}/profiles/{puid}/rules/calendar_restrictions?custom_filter=newest_today_extra_time` |
| Safe networks | `GET /v2/accounts/{uid}/profiles/{puid}/rules/safe-networks` |

### `rules` (v1)

- `time_restrictions`:
  - `quotas{mon,tue,wed,thr,fri,sat,sun}` in minutes. Note `thr`. 0 means *Block*.
  - `is_weekdays_quota`, `is_weekend_quota`.
  - `time_ranges{day}`: legacy restricted times, a 24-bit mask, bit *h* = hour *h* blocked.
    Accounts with Routines still carry it, but it is not what is enforced.
  - `is_lock_computer`, `is_lock_navigation`.
  - `usage.nav_elapsed` in seconds. It is the agent's own counter, and on a bypassed Mac it
    stops at the quota.
- `web`: `categories[{category, action: "ALLOW"|"BLOCK"}]`, `domains{host: 0 = allow}`,
  `is_safe_search`, `is_allow_unknown_sites`.
- `app_rules.application_list[]`: `{name, exe, platform, action, mon_quota…}`.
- Also present: `location`, `panic`, `call_sms_monitoring`, `social_monitoring`,
  `unsupported_browsers`, `safe_networks_rules`.

### `summary_hourly` (v2)

A list of `{datetime (UTC hour), screen_time_seconds, default_rules_screen_time,
routines_screen_time: [{uid, seconds}]}`. **Quota time is `default_rules_screen_time` plus the
seconds of routines whose policy counts** (`counts_towards_daily_time_quota`).
`screen_time_seconds` is the raw total, and during School or Homework it is mostly time that
does not count. A `device_uid` parameter is accepted but ignored: there is no per-device split.

### Routine object

```
{uid, enabled, paused, name, description, color, icon,
 policy: {counts_towards_daily_time_quota, block_type,          # 0 rules only, 1 no internet, 2 device blocked
          app_rules: {default_action, app_rules_list[{name, exe, platform, action}],
                      app_category_rules_list[{category_id, action}]},
          web_rules: {default_action, web_rules_list[{category, action}]}}}
```

**Always pass `filter_app_rules=false`**, on GET and on PATCH, as the web app does. Without it the server
filters `app_rules`: a GET leaves out the allow entries, and a PATCH drops `app_category_rules_list` and
the allow entries. Switching `default_action` without it also erases the category rules (seen 2026-10-20).
`app_category_rules_list[{category_id, action}]` uses the app catalogue's categories: `social_media`,
`gaming`, `entertainment`, `education`, `ai`, `other`. A named app entry overrides its category.

`action` / `default_action`: **0 = allow, 1 = block**. So `default_action: 1` with a list of
`action: 0` is an allow-list ("Only educational websites"). `default_action: 0` with
`action: 1` entries is a block-list.

Schedules: `{uid, weekdays: ["MO",…,"SU"], start_time: "HH:MM:SS" (local), duration_minutes,
from_date, to_date, enabled, overrides}`. A schedule can run past midnight (Bedtime).
**Switching the routine** in the parent app ("Switched routine" on the dashboard) adds a one-day
schedule to the chosen routine: `from_date` = `to_date` = today, `start_time` the moment of the
switch, `duration_minutes` as chosen, `overrides: true`. While it runs it replaces every other
routine, Bedtime included (seen 2026-10-28: Homework at 20:05 for 30 min, over Bedtime from 20:00).

### Extra time (calendar restriction)

`{restriction_type: 2, duration (s), rrule: "DTSTART:YYYYMMDDTHHMMSS\nFREQ=DAILY;COUNT=1",
rrule_dtstart (local)}`. It is the newest of today's; a later grant replaces the earlier one,
and `duration: 0` clears it. **While it runs, the child is under the free rules:**
`summary_hourly` books that time to the profile's "Free" routine (seen 2026-10-18, a bonus in
the middle of Homework), even while Free itself is paused.

## Write

| What | Request | Tested |
|---|---|---|
| Change a routine | `PATCH /v2/accounts/{uid}/profiles/{puid}/routines/{ruid}?filter_app_rules=false` with `{"policy": {…}}`, the whole policy object as read, modified | **yes**, 2026-10-18: only the changed part moved |
| Create a routine | `POST …/routines` | no |
| Delete a routine | `DELETE …/routines/{ruid}` | no |
| Schedules | `POST …/routines/{ruid}/schedules`, `PATCH`/`DELETE …/schedules/{suid}` | no |
| Extra time | `POST`/`PUT …/rules/calendar_restrictions` (per home-assistant-qustodio) | no |
| Default rules | `PUT /v1/accounts/{id}/profiles/{pid}/rules` (per home-assistant-qustodio) | no |
| Safe networks | `PATCH …/rules/safe-networks` | no |

Read the object, change only what you mean to, write it back, then read it again and diff.

## Web categories

From the bundle (`{educational:4,…}`), with the names as the web app shows them:

| id | category | id | category | id | category |
|---|---|---|---|---|---|
| 1 | Alcohol | 12 | Mature content | 22 | Travel |
| 2 | Chat | 13 | News | 23 | Violence |
| 3 | Drugs | 14 | Pornography | 24 | Weapons |
| 4 | Educational | 15 | Profanity | 25 | Webmail |
| 5 | Employment | 16 | Religion | 26 | Business |
| 6 | Entertainment (YouTube) | 17 | Search engines | 27 | Technology |
| 7 | Gambling | 18 | Shopping | 28 | File sharing |
| 8 | Games | 19 | Social networks | 29 | Proxies/Loopholes |
| 9 | Government | 20 | Sports | 30 | Forums |
| 10 | Health | 21 | Tobacco | 31 | AI |

There is no 11.
