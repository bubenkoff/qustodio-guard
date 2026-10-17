// qustodio-guard — log a kid out of their Mac when Qustodio says their time is up.
//
// Qustodio's Mac agent can be raced: unlock with Touch ID quickly enough and its block screen
// never comes up for the rest of the session. This does not fix the agent. It asks Qustodio's
// cloud — which keeps counting correctly — whether the kid's profile is over its daily quota or
// outside its allowed hours, and if so ends the kid's session. It polls, so there is no unlock
// event to race.
//
// Run by launchd as root every 5 seconds. Each run decides from the cached state — no network —
// and talks to the API at most once a minute (REFRESH_MS), succeed or fail:
//   osascript -l JavaScript guard.js <state-dir> [--dry-run]
// <state-dir> is root-only (700): token (refresh token), state.json, req.cfg, and an optional
// config.json. See README.md.

ObjC.import('Foundation');
const app = Application.currentApplication();
app.includeStandardAdditions = true;

const API = 'https://api.qustodio.com';
// The Qustodio web app's own OAuth client, as used by
// github.com/matt-richardson/home-assistant-qustodio — not a secret of ours.
const CLIENT_ID = '264ca1d226906aa08b03';
const CLIENT_SECRET = '3e8826cbed3b996f8b206c7d6a4b2321529bc6bd';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thr', 'fri', 'sat']; // Qustodio spells Thursday "thr"
const MACOS = 1; // device.platform
const REFRESH_MS = 60e3;  // API at most this often; screen time there lags minutes anyway
const TICK_GAP_MS = 30e3; // a longer gap between runs means the Mac slept: not screen time
const IDLE_MS = 120e3;    // no keyboard/mouse for this long: away, not screen time
// The warning dialog, in the kid's macOS language. config.json "lang" or "message" overrides.
const TEXTS = {
  en: { hours: 'outside allowed hours', quota: 'daily limit used ({used} of {quota} min)',
        text: "Time's up: {why}.\nSave your work — you will be logged out in {seconds} s." },
  uk: { hours: 'поза дозволеними годинами', quota: 'денний ліміт вичерпано ({used} з {quota} хв)',
        text: 'Час вийшов: {why}.\nЗбережи роботу — через {seconds} с буде вихід із системи.' },
  nl: { hours: 'buiten de toegestane uren', quota: 'daglimiet bereikt ({used} van {quota} min)',
        text: 'De tijd is om: {why}.\nSla je werk op — over {seconds} s word je uitgelogd.' },
  de: { hours: 'außerhalb der erlaubten Zeiten', quota: 'Tageslimit erreicht ({used} von {quota} Min.)',
        text: 'Die Zeit ist um: {why}.\nSpeichere deine Arbeit — in {seconds} s wirst du abgemeldet.' },
  es: { hours: 'fuera del horario permitido', quota: 'límite diario agotado ({used} de {quota} min)',
        text: 'Se acabó el tiempo: {why}.\nGuarda tu trabajo: la sesión se cerrará en {seconds} s.' },
  fr: { hours: 'en dehors des heures autorisées', quota: 'limite quotidienne atteinte ({used} sur {quota} min)',
        text: 'Le temps est écoulé : {why}.\nEnregistre ton travail — déconnexion dans {seconds} s.' },
};
function fill(t, v) { return t.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)); }

function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function sh(cmd) { return app.doShellScript(cmd, { alteringLineEndings: false }); }
function log(msg) { console.log(new Date().toISOString() + ' ' + msg); }

function readFile(path) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  return s.isNil() ? null : s.js;
}
function writeFile(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
  sh('/bin/chmod 600 ' + q(path));
}
function readJSON(path, dflt) {
  const s = readFile(path);
  if (s === null) return dflt;
  try { return JSON.parse(s); } catch (e) { return dflt; }
}

// Secrets reach curl through a root-only config file, never argv: a kid can read `ps`.
function curl(dir, url, opts) {
  const lines = ['url = "' + url + '"', 'silent', 'show-error', 'fail', 'connect-timeout = 5', 'max-time = 10'];
  if (opts.bearer) lines.push('header = "Authorization: Bearer ' + opts.bearer + '"');
  for (const [k, v] of Object.entries(opts.form || {}))
    lines.push('data-urlencode = "' + k + '=' + v + '"');
  writeFile(dir + '/req.cfg', lines.join('\n') + '\n');
  try { return JSON.parse(sh('/usr/bin/curl -K ' + q(dir + '/req.cfg'))); }
  finally { writeFile(dir + '/req.cfg', ''); }
}

function accessToken(dir, st) {
  if (st.access_token && st.access_expires > Date.now() + 3600e3) return st.access_token;
  const refresh = (readFile(dir + '/token') || '').trim();
  if (!refresh) throw new Error('no refresh token in ' + dir + '/token — run qustodio-token.sh');
  const r = curl(dir, API + '/v1/oauth2/access_token', {
    form: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refresh },
  });
  if (r.refresh_token && r.refresh_token !== refresh) writeFile(dir + '/token', r.refresh_token + '\n');
  st.access_token = r.access_token;
  st.access_expires = Date.now() + r.expires_in * 1000;
  return st.access_token;
}

function localUser() {
  const name = sh('/usr/bin/stat -f %Su /dev/console').trim();
  const uid = sh('/usr/bin/stat -f %u /dev/console').trim();
  const admin = /^yes/.test(sh('/usr/sbin/dseditgroup -o checkmember -m ' + q(name) + ' admin || true'));
  const rn = sh('/usr/bin/dscl . -read ' + q('/Users/' + name) + ' RealName 2>/dev/null || true');
  const realName = rn.replace(/^RealName:\s*/, '').trim();
  return { name, uid, admin, realName };
}

// First entry of the user's AppleLanguages ("uk-NL" → "uk"), falling back to the system's.
function userLang(u) {
  for (const cmd of ['/usr/bin/sudo -u ' + q(u.name) + ' /usr/bin/defaults read -g AppleLanguages',
                     '/usr/bin/defaults read /Library/Preferences/.GlobalPreferences AppleLanguages']) {
    const m = sh(cmd + ' 2>/dev/null || true').match(/([a-z]{2,3})(?=[-_"\s,]|$)/);
    if (m) return m[1];
  }
  return 'en';
}

// Which Qustodio profile watches this local user. Qustodio knows: every device lists the
// local accounts it monitors, as {uid, name, profile_id}. A config.json "profile" overrides.
function resolveProfile(dir, cfg, u, bearer) {
  const me = curl(dir, API + '/v1/accounts/me', { bearer });
  const profiles = curl(dir, API + '/v1/accounts/' + me.id + '/profiles/', { bearer });
  let p;
  if (cfg.profile) {
    p = profiles.find(x => x.name === cfg.profile);
    if (!p) throw new Error('no Qustodio profile named ' + cfg.profile);
  } else {
    const devices = curl(dir, API + '/v1/accounts/' + me.id + '/devices', { bearer });
    const ids = new Set();
    for (const d of devices.filter(d => d.platform === MACOS))
      for (const du of d.users || [])
        if (String(du.uid) === u.uid && du.name === u.realName && du.profile_id) ids.add(du.profile_id);
    if (ids.size !== 1)
      throw new Error((ids.size ? 'several' : 'no') + ' Qustodio profiles for uid ' + u.uid + ' "' + u.realName +
                      '" — set "profile" in config.json');
    const id = [...ids][0];
    p = profiles.find(x => x.id === id);
  }
  return { account_id: me.id, account_uid: me.uid, profile_id: p.id, profile_uid: p.uid, profile_name: p.name };
}

function refresh(dir, cfg, st, kid, u, today) {
  const bearer = accessToken(dir, st);
  if (!kid.profile_id || kid.resolved_on !== today) {
    Object.assign(kid, resolveProfile(dir, cfg, u, bearer), { resolved_on: today, lang: userLang(u) });
    log(u.name + ' (uid ' + u.uid + ') is watched by Qustodio profile ' + kid.profile_name);
  }
  const rules = curl(dir, API + '/v1/accounts/' + kid.account_id + '/profiles/' + kid.profile_id + '/rules?app_rules=1', { bearer });
  const tr = rules.time_restrictions || {};
  kid.rules = { time_ranges: tr.time_ranges || {}, quotas: tr.quotas || {},
                weekdays_quota: tr.is_weekdays_quota !== false, weekend_quota: tr.is_weekend_quota !== false };
  const hourly = curl(dir, API + '/v2/accounts/' + kid.account_uid + '/profiles/' + kid.profile_uid +
                      '/summary_hourly?date=' + today, { bearer });
  kid.used_min = Math.round(hourly.reduce((a, e) => a + (e.screen_time_seconds || 0), 0) / 60);
  // Extra time granted from the parent app: a window starting when it was granted, which
  // Qustodio honours even outside allowed hours. Re-read every poll — it changes any time.
  const ex = curl(dir, API + '/v2/accounts/' + kid.account_uid + '/profiles/' + kid.profile_uid +
                  '/rules/calendar_restrictions?custom_filter=newest_today_extra_time', { bearer });
  const it = (ex.items_list || [])[0];
  kid.extra = it && it.duration > 0 ? { start: Date.parse(it.rrule_dtstart), seconds: it.duration } : null;
  kid.used_date = today;
  kid.local_ms = 0; // the cloud figure now covers everything up to here
  kid.local_date = today;
}

function idleMs() {
  const m = sh("/usr/sbin/ioreg -c IOHIDSystem -d 4 | /usr/bin/awk '/HIDIdleTime/ {print $NF; exit}'").match(/\d+/);
  return m ? Number(m[0]) / 1e6 : 0; // nanoseconds
}

// Screen time counted on the Mac since the last good API read, so that going offline does not
// freeze the quota. Sleep gaps and idle time are skipped; the counter restarts at midnight.
function tick(kid, now, today) {
  if (kid.local_date !== today) { kid.local_ms = 0; kid.local_date = today; }
  const gap = kid.last_tick ? now - kid.last_tick : 0;
  if (gap > 0 && gap < TICK_GAP_MS && idleMs() < IDLE_MS) kid.local_ms = (kid.local_ms || 0) + gap;
  kid.last_tick = now.getTime();
}

// Why the session must end, or null. Works from cached state when the API is unreachable,
// so switching Wi-Fi off once the limit is hit changes nothing.
// Returns {code: 'hours'|'quota', used, quota}.
function verdict(kid, now, today) {
  if (!kid.rules) return null;
  const extra = kid.used_date === today ? kid.extra : null;
  if (extra && now >= extra.start && now < extra.start + extra.seconds * 1000) return null; // granted time running
  const day = DAYS[now.getDay()];
  const mask = kid.rules.time_ranges[day] || 0; // bit h set = hour h is blocked
  if (mask & (1 << now.getHours())) return { code: 'hours' };
  // A day's quota counts if limits are on for that kind of day. 0 is Qustodio's "Block" (the
  // whole day) — unless every day is 0, which means no limits were ever set.
  const weekend = day === 'sat' || day === 'sun';
  const on = weekend ? kid.rules.weekend_quota !== false : kid.rules.weekdays_quota !== false;
  const configured = Object.values(kid.rules.quotas).some(m => m > 0);
  if (!on || !configured || !(day in kid.rules.quotas)) return null;
  const quota = kid.rules.quotas[day] + (extra ? Math.round(extra.seconds / 60) : 0);
  const used = (kid.used_date === today ? kid.used_min : 0) +
               (kid.local_date === today ? Math.floor((kid.local_ms || 0) / 60e3) : 0);
  if (used >= quota) return { code: 'quota', used, quota };
  return null;
}
function why(v, lang) { return v && fill((TEXTS[lang] || TEXTS.en)[v.code], v); }

function warning(cfg, kid, v, grace) {
  const lang = TEXTS[cfg.lang] ? cfg.lang : TEXTS[kid.lang] ? kid.lang : 'en';
  return fill(cfg.message || TEXTS[lang].text, { why: why(v, lang), seconds: grace / 1000 });
}

function enforce(cfg, kid, u, v, now) {
  const grace = (cfg.grace_seconds || 60) * 1000;
  if (!v) { kid.warned_at = null; return; }
  const reason = why(v, 'en');
  if (!kid.warned_at || now - kid.warned_at > 30 * 60e3) {
    // First strike: warn and give `grace` to save work. Within 30 min of a warning the next
    // poll logs out straight away, so logging back in buys nothing.
    kid.warned_at = now.getTime();
    log('warning ' + u.name + ': ' + reason);
    const text = warning(cfg, kid, v, grace).replace(/["\\]/g, '\\$&');
    sh('/bin/launchctl asuser ' + u.uid + ' /usr/bin/sudo -u ' + q(u.name) + ' /usr/bin/osascript -e ' +
       q('display dialog "' + text + '" buttons {"OK"} with icon caution giving up after ' + (grace / 1000 - 5)) +
       ' >/dev/null 2>&1 &');
  } else if (now - kid.warned_at >= grace) {
    log('logging out ' + u.name + ': ' + reason);
    try { sh('/bin/launchctl bootout gui/' + u.uid); }
    catch (e) { log('bootout failed (' + e.message + '), killing processes'); sh('/usr/bin/pkill -KILL -u ' + u.uid + ' || true'); }
  }
}

function run(argv) {
  const dir = argv[0];
  const dry = argv.includes('--dry-run');
  const cfg = readJSON(dir + '/config.json', {});
  const st = readJSON(dir + '/state.json', {});
  st.kids = st.kids || {};
  const now = new Date();
  const today = sh('/bin/date +%F').trim();
  const save = () => writeFile(dir + '/state.json', JSON.stringify(st));

  const u = localUser();
  if (Number(u.uid) < 501) return save();                     // login window, setup, system users
  if (cfg.user ? u.name !== cfg.user : u.admin && !dry) return save();   // parents are not guarded

  const kid = st.kids[u.uid] = st.kids[u.uid] || {};
  tick(kid, now, today);
  if (dry || !kid.fetched_at || now - kid.fetched_at >= REFRESH_MS) {
    kid.fetched_at = now.getTime(); // failures wait their turn too: no hammering while offline
    try {
      refresh(dir, cfg, st, kid, u, today);
      if (kid.api_fail) log('API back after ' + kid.api_fail + ' failed polls');
      kid.api_fail = 0;
    } catch (e) {
      kid.api_fail = (kid.api_fail || 0) + 1;
      st.access_token = null; // a revoked token would otherwise be reused until it expires
      if (kid.api_fail === 1 || kid.api_fail % 60 === 0)
        log('API failed (' + kid.api_fail + ' in a row), using cache: ' + e.message);
    }
  }

  const v = verdict(kid, now, today);
  if (dry) log('dry run for ' + u.name + ' → ' + (kid.profile_name || '?') + ': used ' + kid.used_min +
               ' min on ' + kid.used_date + ' + ' + Math.floor((kid.local_ms || 0) / 60e3) + ' local, extra ' + JSON.stringify(kid.extra || null) +
               ', lang ' + kid.lang + ', verdict: ' + (why(v, 'en') || 'allowed') +
               (v ? '\n  dialog: ' + warning(cfg, kid, v, (cfg.grace_seconds || 60) * 1000) : ''));
  else enforce(cfg, kid, u, v, now);
  save();
}
