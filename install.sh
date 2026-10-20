#!/bin/zsh
# Install qustodio-guard on a kid's Mac. Run from a parent (admin) account:
#
#   sudo ./install.sh [--profile <Qustodio profile name>] [--ha-webhook <local HA webhook URL>]
#                     [--ha-webhook-external <the same webhook via HA's external URL>]
#
# Without --profile, the guard works out which Qustodio profile watches whoever is at the
# screen from Qustodio's own device list, and leaves admin accounts alone. Re-running is safe:
# it updates the scripts and reloads the daemons, and asks for the Qustodio login only if there
# is no token yet.
set -eu
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
here=${0:A:h}

profile= webhook= webhook_ext=
while (( $# )); do
  case $1 in
    --profile) profile=${2:?}; shift 2 ;;
    --ha-webhook) webhook=${2:?}; shift 2 ;;
    --ha-webhook-external) webhook_ext=${2:?}; shift 2 ;;
    *) echo "usage: sudo $0 [--profile <name>] [--ha-webhook <url>] [--ha-webhook-external <url>]" >&2; exit 1 ;;
  esac
done

LABEL=io.github.bubenkoff.qustodio-guard
LIB="/Library/Application Support/qustodio-guard"
STATE=/var/root/qustodio-guard
LOG=/var/log/qustodio-guard.log

install -d -o root -g wheel -m 755 "$LIB"
if [[ $here != "$LIB" ]]; then   # re-running the installed copy (e.g. to add --ha-webhook): nothing to copy
  install -o root -g wheel -m 644 "$here/guard.js" "$LIB/guard.js"
  for f in qustodio-token.sh update.sh install.sh uninstall.sh; do
    install -o root -g wheel -m 755 "$here/$f" "$LIB/$f"
  done
fi
install -d -o root -g wheel -m 700 $STATE

# config.json is merged, never replaced: other keys (lang, routine_apps…) survive a re-install.
setcfg() {
  local f=$STATE/config.json
  /usr/bin/osascript -l JavaScript -e '
    ObjC.import("Foundation");
    function run(a) {
      const s = $.NSString.stringWithContentsOfFileEncodingError(a[0], 4, null);
      const c = s.isNil() ? {} : JSON.parse(s.js || "{}");
      c[a[1]] = a[2];
      return JSON.stringify(c, null, 1);
    }' "$f" "$1" "$2" > $f.new && mv $f.new $f && chmod 600 $f
}
[[ -z $profile ]] || setcfg profile "$profile"
[[ -z $webhook ]] || setcfg ha_webhook "$webhook"
[[ -z $webhook_ext ]] || setcfg ha_webhook_external "$webhook_ext"
if [[ ! -s $STATE/token ]]; then
  [[ -z ${QG_FROM_UPDATE:-} ]] || { echo "no Qustodio token; run install.sh by hand" >&2; exit 1; }
  "$LIB/qustodio-token.sh" $STATE/token
fi

# daemon <label> <interval-seconds> <program> [args...] — (re)loads only if the plist changed.
# AbandonProcessGroup: launchd otherwise kills every process a run started when the run ends —
# which took the guard's warning dialogs down within a second, so none was ever seen.
daemon() {
  local label=$1 interval=$2; shift 2
  local plist=/Library/LaunchDaemons/$label.plist args= new throttle=
  for a in "$@"; do args+="<string>$a</string>"; done
  # Only to go *below* launchd's default of 10 s. On a long interval it would also forbid
  # kickstarting the job by hand until that much time has passed (it did, for the updater: 6 h).
  (( interval < 10 )) && throttle="
  <key>ThrottleInterval</key><integer>$interval</integer>"
  new=$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>StartInterval</key><integer>$interval</integer>$throttle
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
)
  if [[ -f $plist && "$(<$plist)" == "$new" ]] && /bin/launchctl print system/$label >/dev/null 2>&1; then
    return
  fi
  print -r -- "$new" > $plist
  chown root:wheel $plist; chmod 644 $plist
  /bin/launchctl bootout system/$label 2>/dev/null || true
  /bin/launchctl bootstrap system $plist
  echo "loaded $label"
}
daemon $LABEL 5 /usr/bin/osascript -l JavaScript "$LIB/guard.js" $STATE
# Self-update from GitHub main. guard.js starts it every 15 min; this 6 h interval is the fallback
# for a guard that is not running. Not touched when update.sh itself runs this script:
# reloading that job would kill the run doing the reloading.
[[ -n ${QG_FROM_UPDATE:-} ]] || daemon $LABEL.update 21600 /bin/zsh "$LIB/update.sh"

[[ -z ${QG_FROM_UPDATE:-} ]] || exit 0

# Warn about kid accounts that could simply remove all this.
admins=() kids=()
for u in $(dscl . -list /Users UniqueID | awk '$2 >= 501 {print $1}'); do
  dseditgroup -o checkmember -m $u admin | grep -q '^yes' && admins+=($u) || kids+=($u)
done
echo "installed; log: $LOG"
echo "admin accounts (never guarded): ${admins[*]:-none}"
echo "standard accounts (guarded if Qustodio watches them): ${kids[*]:-none}"
