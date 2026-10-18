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
const ROUTINES_MS = 5 * 60e3; // routines and their schedules: 1 + N calls, and they rarely change
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']; // routine schedules, by getDay()
const BLOCK_DEVICE = 2;   // routine policy.block_type: 0 = rules only, 1 = no internet, 2 = device
const TICK_GAP_MS = 30e3; // a longer gap between runs means the Mac slept: not screen time
const IDLE_MS = 120e3;    // no keyboard/mouse for this long: away, not screen time
const ENTERTAINMENT = 6;  // Qustodio web category: YouTube and other video sites
const YT_CHECK_MS = 30e3; // how often to look for offline YouTube playback
const YT_MIN_CHUNKS = 3;  // offline chunks read in the last minute that mean "a video is playing"
const YT_GRACE_MS = 15e3; // between the warning and closing the browser
const APPS_CHECK_MS = 10e3;  // how often to compare running apps with the routine's allow-list
const VIDEO_CHECK_MS = 30e3; // how often to look for local video files open in players
const VIDEO_FILE = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpe?g|ts|m2ts|3gp)$/i;
// Apps that play video. Matched against lsof's full command name (helpers included); iMovie is
// deliberately absent — making videos for school is not watching them.
const PLAYERS = /(Chrome|Chromium|Brave|Edge|Opera|Safari|WebKit|Firefox|plugin-container|QuickTime|VLC|IINA|mpv|Elmedia|Movist|Infuse|^TV$)/;
// Never closed, whatever a routine says: the desktop itself, Qustodio, and remote support.
const ALWAYS_OK = /^(com\.apple\.(finder|dock|loginwindow|systemuiserver|controlcenter|notificationcenterui|spotlight|securityagent|coreservices\..*|screensaver.*|wifi\..*|universalaccess.*)|com\.qustodio\..*|com\.teamviewer\..*)$/;
// Browsers whose YouTube Premium offline downloads live in <profile>/IndexedDB, and their processes.
const BROWSERS = [
  ['Google/Chrome', 'Google Chrome'], ['BraveSoftware/Brave-Browser', 'Brave Browser'],
  ['Microsoft Edge', 'Microsoft Edge'], ['com.operasoftware.Opera', 'Opera'],
];
// The warning dialog, in the kid's macOS language. config.json "lang" or "message" overrides.
const TEXTS = {
  en: { app: '{app} isn\'t allowed during {name}.\nIt will close in {seconds} s.',
        video: 'Watching downloaded videos isn\'t allowed during {name}.\n{app} will close in {seconds} s.',
        offline: 'Offline YouTube isn\'t allowed during {name}.\nThe browser will close in {seconds} s.',
        routine: 'routine: {name} (device blocked)',
        hours: 'outside allowed hours', quota: 'daily limit used ({used} of {quota} min)',
        text: "Time's up: {why}.\nSave your work — you will be logged out in {seconds} s." },
  uk: { app: '{app} під час «{name}» не можна.\nЗастосунок закриється через {seconds} с.',
        video: 'Дивитися завантажені відео під час «{name}» не можна.\n{app} закриється через {seconds} с.',
        offline: 'Офлайн-YouTube під час «{name}» не можна.\nБраузер закриється через {seconds} с.',
        routine: 'розпорядок «{name}» (пристрій заблоковано)',
        hours: 'поза дозволеними годинами', quota: 'денний ліміт вичерпано ({used} з {quota} хв)',
        text: 'Час вийшов: {why}.\nЗбережи роботу — через {seconds} с буде вихід із системи.' },
  nl: { app: '{app} is niet toegestaan tijdens {name}.\nDe app sluit over {seconds} s.',
        video: 'Gedownloade video\'s kijken is niet toegestaan tijdens {name}.\n{app} sluit over {seconds} s.',
        offline: 'Offline YouTube is niet toegestaan tijdens {name}.\nDe browser sluit over {seconds} s.',
        routine: 'routine {name} (apparaat geblokkeerd)',
        hours: 'buiten de toegestane uren', quota: 'daglimiet bereikt ({used} van {quota} min)',
        text: 'De tijd is om: {why}.\nSla je werk op — over {seconds} s word je uitgelogd.' },
  de: { app: '{app} ist während {name} nicht erlaubt.\nDie App wird in {seconds} s geschlossen.',
        video: 'Heruntergeladene Videos sind während {name} nicht erlaubt.\n{app} wird in {seconds} s geschlossen.',
        offline: 'Offline-YouTube ist während {name} nicht erlaubt.\nDer Browser wird in {seconds} s geschlossen.',
        routine: 'Routine {name} (Gerät gesperrt)',
        hours: 'außerhalb der erlaubten Zeiten', quota: 'Tageslimit erreicht ({used} von {quota} Min.)',
        text: 'Die Zeit ist um: {why}.\nSpeichere deine Arbeit — in {seconds} s wirst du abgemeldet.' },
  es: { app: '{app} no está permitido durante {name}.\nSe cerrará en {seconds} s.',
        video: 'Ver vídeos descargados no está permitido durante {name}.\n{app} se cerrará en {seconds} s.',
        offline: 'YouTube sin conexión no está permitido durante {name}.\nEl navegador se cerrará en {seconds} s.',
        routine: 'rutina {name} (dispositivo bloqueado)',
        hours: 'fuera del horario permitido', quota: 'límite diario agotado ({used} de {quota} min)',
        text: 'Se acabó el tiempo: {why}.\nGuarda tu trabajo: la sesión se cerrará en {seconds} s.' },
  fr: { app: '{app} n\'est pas autorisé pendant {name}.\nL\'app se fermera dans {seconds} s.',
        video: 'Regarder des vidéos téléchargées n\'est pas autorisé pendant {name}.\n{app} se fermera dans {seconds} s.',
        offline: 'YouTube hors ligne n\'est pas autorisé pendant {name}.\nLe navigateur se fermera dans {seconds} s.',
        routine: 'routine {name} (appareil bloqué)',
        hours: 'en dehors des heures autorisées', quota: 'limite quotidienne atteinte ({used} sur {quota} min)',
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
  // Qustodio's catalogue of this child's Mac apps: bundle id → category, and whether it can be blocked.
  kid.catalog = {};
  for (const a of (rules.app_rules || {}).application_list || [])
    if (a.platform === MACOS && a.exe) kid.catalog[a.exe.toLowerCase()] = { cat: a.category_id, blockable: a.blockable !== false, name: a.name };
  kid.rules = { time_ranges: tr.time_ranges || {}, quotas: tr.quotas || {},
                weekdays_quota: tr.is_weekdays_quota !== false, weekend_quota: tr.is_weekend_quota !== false };
  const hourly = curl(dir, API + '/v2/accounts/' + kid.account_uid + '/profiles/' + kid.profile_uid +
                      '/summary_hourly?date=' + today, { bearer });
  // Routines: Qustodio's schedules (Bedtime, School…). A routine either blocks the device or
  // swaps in its own rules, and its time counts towards the daily quota only if it says so.
  if (!kid.routines_at || Date.now() - kid.routines_at >= ROUTINES_MS || kid.routines_on !== today) {
    const base = API + '/v2/accounts/' + kid.account_uid + '/profiles/' + kid.profile_uid + '/routines';
    kid.routines = (curl(dir, base + '?include_disabled=1', { bearer }).items_list || []).map(r => ({
      uid: r.uid, name: r.name, on: r.enabled && !r.paused,
      counts: !!(r.policy || {}).counts_towards_daily_time_quota, block: (r.policy || {}).block_type || 0,
      noVideo: entertainmentBlocked((r.policy || {}).web_rules),
      apps: appRules((r.policy || {}).app_rules),
      schedules: r.enabled && !r.paused ? (curl(dir, base + '/' + r.uid + '/schedules', { bearer }).items_list || []) : [],
    }));
    kid.routines_at = Date.now();
    kid.routines_on = today;
  }
  // Quota time = time under the default rules + time in routines that count towards it.
  const counting = new Set(kid.routines.filter(r => r.counts).map(r => r.uid));
  kid.used_min = Math.round(hourly.reduce((a, e) => a + (e.default_rules_screen_time || 0) +
    (e.routines_screen_time || []).reduce((b, x) => b + (counting.has(x.uid) ? x.seconds : 0), 0), 0) / 60);
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

// Does a routine's web policy block Entertainment? An allow-list (default 1) that does not list
// it, or a block-list (default 0) that does. action: 0 = allow, 1 = block.
function entertainmentBlocked(web) {
  if (!web) return false;
  const rule = (web.web_rules_list || []).find(w => w.category === ENTERTAINMENT);
  return web.default_action === 1 ? !(rule && rule.action === 0) : !!(rule && rule.action === 1);
}

// A routine's app policy, Mac part only: default action, per-app and per-category rules.
function appRules(ar) {
  if (!ar) return null;
  const apps = {};
  for (const a of ar.app_rules_list || []) if (a.platform === MACOS && a.exe) apps[a.exe.toLowerCase()] = a.action;
  const cats = {};
  for (const c of ar.app_category_rules_list || []) cats[c.category_id] = c.action;
  return { def: ar.default_action || 0, apps, cats };
}

// Would Qustodio let this app run during the routine? action: 0 = allow, 1 = block.
function appAllowed(routine, kid, bundle) {
  const r = routine.apps;
  if (!r || ALWAYS_OK.test(bundle)) return true;
  const known = (kid.catalog || {})[bundle];
  if (known && !known.blockable) return true;
  if (bundle in r.apps) return r.apps[bundle] === 0;
  if (known && known.cat in r.cats) return r.cats[known.cat] === 0;
  return r.def === 0;
}

function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Routines running now. A schedule that started yesterday may run past midnight (Bedtime).
function activeRoutines(kid, now) {
  return (kid.routines || []).filter(r => r.on && r.schedules.some(s => {
    if (s.enabled === false) return false;
    for (const back of [0, 1]) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      if (!(s.weekdays || []).includes(WEEKDAYS[d.getDay()])) continue;
      if ((s.from_date && ymd(d) < s.from_date) || (s.to_date && ymd(d) > s.to_date)) continue;
      const [h, m, sec] = String(s.start_time).split(':').map(Number);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, sec || 0);
      if (now >= start && now - start < s.duration_minutes * 60e3) return true;
    }
    return false;
  }));
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
  const free = activeRoutines(kid, now).some(r => r.block !== BLOCK_DEVICE && !r.counts); // not quota time
  if (gap > 0 && gap < TICK_GAP_MS && !free && idleMs() < IDLE_MS) kid.local_ms = (kid.local_ms || 0) + gap;
  kid.last_tick = now.getTime();
}

// Why the session must end, or null. Works from cached state when the API is unreachable,
// so switching Wi-Fi off once the limit is hit changes nothing.
// Returns {code: 'routine'|'hours'|'quota', name, used, quota}.
function verdict(kid, now, today) {
  if (!kid.rules) return null;
  const extra = kid.used_date === today ? kid.extra : null;
  if (extra && now >= extra.start && now < extra.start + extra.seconds * 1000) return null; // granted time running
  const day = DAYS[now.getDay()];
  if (kid.routines && kid.routines.length) {
    // With routines, they are the schedule; the legacy restricted-times mask is not used.
    const active = activeRoutines(kid, now);
    const blocking = active.find(r => r.block === BLOCK_DEVICE);
    if (blocking) return { code: 'routine', name: blocking.name };
    // "No internet" routines (block 1) are Qustodio's to enforce: the guard only logs out.
    if (active.some(r => !r.counts)) return null; // e.g. School, Homework: outside the daily limit
  } else {
    const mask = kid.rules.time_ranges[day] || 0; // bit h set = hour h is blocked
    if (mask & (1 << now.getHours())) return { code: 'hours' };
  }
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

function dialog(u, text, seconds) {
  sh('/bin/launchctl asuser ' + u.uid + ' /usr/bin/sudo -u ' + q(u.name) + ' /usr/bin/osascript -e ' +
     q('display dialog "' + text.replace(/["\\]/g, '\\$&') + '" buttons {"OK"} with icon caution giving up after ' +
       Math.max(5, seconds - 5)) + ' >/dev/null 2>&1 &');
}

// Warn once, close after `graceMs`; within 30 min of a warning, close straight away.
function strike(kid, key, now, graceMs, warn, close) {
  kid.strikes = kid.strikes || {};
  const at = kid.strikes[key];
  if (!at || now - at > 30 * 60e3) { kid.strikes[key] = now.getTime(); warn(); }
  else if (now - at >= graceMs) close();
}

function langOf(cfg, kid) { return TEXTS[cfg.lang] ? cfg.lang : TEXTS[kid.lang] ? kid.lang : 'en'; }

function quit(u, proc) { sh('/usr/bin/pkill -TERM -u ' + u.uid + ' -x ' + q(proc) + ' || true'); }

// Foreground apps in the child's session: [{name, bundle, pid}].
function runningApps(u) {
  const out = sh('/bin/launchctl asuser ' + u.uid + ' /usr/bin/lsappinfo list 2>/dev/null || true');
  return out.split(/\n\s*\d+\) /).map(b => ({
    name: (b.match(/^"([^"]*)"/) || [])[1],
    bundle: ((b.match(/bundleID="([^"]+)"/) || [])[1] || '').toLowerCase(),
    pid: (b.match(/\bpid = (\d+)/) || [])[1],
    fg: /type="Foreground"/.test(b),
  })).filter(a => a.fg && a.bundle && a.pid);
}

// Qustodio's app blocking goes down with its agent, so enforce the routine's allow-list here.
function routineApps(cfg, kid, u, now, routine) {
  const mode = cfg.routine_apps || 'block';
  if (mode === 'off' || !routine.apps) return;
  if (kid.apps_checked_at && now - kid.apps_checked_at < APPS_CHECK_MS) return;
  kid.apps_checked_at = now.getTime();
  const lang = langOf(cfg, kid);
  for (const a of runningApps(u)) {
    if (appAllowed(routine, kid, a.bundle)) continue;
    if (mode === 'log') { log('not allowed during ' + routine.name + ': ' + a.name + ' (' + a.bundle + '), log only'); continue; }
    strike(kid, 'app:' + a.bundle, now, YT_GRACE_MS,
      () => { log('not allowed during ' + routine.name + ': ' + a.name + ' (' + a.bundle + ')');
              dialog(u, fill(TEXTS[lang].app, { app: a.name, name: routine.name, seconds: YT_GRACE_MS / 1000 }), YT_GRACE_MS / 1000); },
      () => { log('closing ' + a.name + ' (' + a.bundle + '): not allowed during ' + routine.name);
              sh('/bin/kill -TERM ' + a.pid + ' 2>/dev/null || true'); });
  }
}

// The app to close for a process that has a video open: browsers by their main process.
function playerApp(cmd) {
  for (const [re, app] of [[/Chrome/, 'Google Chrome'], [/Brave/, 'Brave Browser'], [/Edge/, 'Microsoft Edge'],
                           [/Opera/, 'Opera'], [/WebKit|Safari/, 'Safari'], [/Firefox|plugin-container/, 'firefox']])
    if (re.test(cmd)) return app;
  return cmd;
}

// Downloaded films and clips played from disk — in a browser via file://, QuickTime, VLC… —
// are invisible to Qustodio too. Files open for reading only (recording writes), outside apps.
function localVideo(cfg, kid, u, now, routine) {
  const mode = cfg.local_video || 'block';
  if (mode === 'off' || !routine.noVideo) return;
  if (kid.video_checked_at && now - kid.video_checked_at < VIDEO_CHECK_MS) return;
  kid.video_checked_at = now.getTime();
  const out = sh('/usr/sbin/lsof -nP +c 0 -u ' + u.uid + ' -Fcan 2>/dev/null || true');
  const hits = {};
  let cmd = '', mode_ = '';
  for (const line of out.split('\n')) {
    const t = line[0], v = line.slice(1);
    if (t === 'c') cmd = v;
    else if (t === 'a') mode_ = v;
    else if (t === 'n' && mode_ === 'r' && PLAYERS.test(cmd) && VIDEO_FILE.test(v) &&
             /^\/(Users|Volumes)\//.test(v) && !/\.app\//.test(v)) hits[playerApp(cmd)] = v;
  }
  const lang = langOf(cfg, kid);
  for (const [app, file] of Object.entries(hits)) {
    log('local video during ' + routine.name + ' in ' + app + ': ' + file.split('/').pop() + (mode === 'log' ? ' (log only)' : ''));
    if (mode === 'log') continue;
    strike(kid, 'video:' + app, now, YT_GRACE_MS,
      () => dialog(u, fill(TEXTS[lang].video, { app, name: routine.name, seconds: YT_GRACE_MS / 1000 }), YT_GRACE_MS / 1000),
      () => { log('closing ' + app + ' (local video during ' + routine.name + ')'); quit(u, app); });
  }
}

// YouTube Premium lets a browser download videos into the site's own storage and play them with no
// network request, so Qustodio's web filter never sees them. While a routine that blocks
// Entertainment runs (Homework…), a browser reading those files means a video is playing:
// warn, then close the browser. The files' access time is the signal (APFS updates it on read;
// looking with stat/find does not).
function offlineYouTube(cfg, kid, u, now) {
  const mode = cfg.offline_youtube || 'block';
  const routine = mode !== 'off' && activeRoutines(kid, now).find(r => r.noVideo && r.block !== BLOCK_DEVICE);
  if (!routine) return;
  if (kid.yt_checked_at && now - kid.yt_checked_at < YT_CHECK_MS) return;
  kid.yt_checked_at = now.getTime();
  if (!kid.yt_dirs || kid.yt_dirs_on !== ymd(now)) {
    const support = '/Users/' + u.name + '/Library/Application Support/';
    kid.yt_dirs = BROWSERS.map(([d]) => support + d).filter(d => $.NSFileManager.defaultManager.fileExistsAtPath(d))
      .flatMap(d => sh('/usr/bin/find ' + q(d) + ' -maxdepth 4 -type d -name "https_www.youtube.com_*.indexeddb.blob" 2>/dev/null || true')
      .split('\n').filter(Boolean));
    kid.yt_dirs_on = ymd(now);
  }
  if (!kid.yt_dirs.length) return;
  const chunks = Number(sh('/usr/bin/find ' + kid.yt_dirs.map(q).join(' ') +
    ' -type f -amin -1 2>/dev/null | /usr/bin/head -50 | /usr/bin/wc -l').trim()) || 0;
  if (chunks < YT_MIN_CHUNKS) return;
  log('offline YouTube during ' + routine.name + ': ' + chunks + ' chunks read in the last minute' +
      (mode === 'log' ? ' (log only)' : ''));
  if (mode === 'log') return;
  const lang = langOf(cfg, kid);
  strike(kid, 'offline-youtube', now, YT_GRACE_MS,
    () => dialog(u, fill(TEXTS[lang].offline, { name: routine.name, seconds: YT_GRACE_MS / 1000 }), YT_GRACE_MS / 1000),
    () => { log('closing browsers of ' + u.name + ' (offline YouTube during ' + routine.name + ')');
            for (const [, proc] of BROWSERS) quit(u, proc); });
}

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
    dialog(u, warning(cfg, kid, v, grace), grace / 1000);
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
               ', lang ' + kid.lang + ', routines now: ' + JSON.stringify(activeRoutines(kid, now).map(r => r.name)) +
               ', verdict: ' + (why(v, 'en') || 'allowed') +
               (v ? '\n  dialog: ' + warning(cfg, kid, v, (cfg.grace_seconds || 60) * 1000) : ''));
  else {
    enforce(cfg, kid, u, v, now);
    if (!v) {
      offlineYouTube(cfg, kid, u, now);
      const routine = activeRoutines(kid, now).find(r => r.block !== BLOCK_DEVICE && (r.apps || r.noVideo));
      if (routine) { routineApps(cfg, kid, u, now, routine); localVideo(cfg, kid, u, now, routine); }
    }
  }
  save();
}
