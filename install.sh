#!/bin/zsh
# Install qustodio-guard on a kid's Mac. Run from a parent (admin) account:
#
#   sudo ./install.sh [--profile <Qustodio profile name>]
#
# Without --profile, the guard works out which Qustodio profile watches whoever is at the
# screen from Qustodio's own device list, and leaves admin accounts alone. Re-running is safe:
# it updates the scripts and reloads the daemons, and asks for the Qustodio login only if there
# is no token yet.
set -eu
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
here=${0:A:h}

profile=
while (( $# )); do
  case $1 in
    --profile) profile=${2:?}; shift 2 ;;
    *) echo "usage: sudo $0 [--profile <name>]" >&2; exit 1 ;;
  esac
done

LABEL=io.github.bubenkoff.qustodio-guard
LIB="/Library/Application Support/qustodio-guard"
STATE=/var/root/qustodio-guard
LOG=/var/log/qustodio-guard.log

install -d -o root -g wheel -m 755 "$LIB"
install -o root -g wheel -m 644 "$here/guard.js" "$LIB/guard.js"
for f in qustodio-token.sh update.sh install.sh uninstall.sh; do
  install -o root -g wheel -m 755 "$here/$f" "$LIB/$f"
done
install -d -o root -g wheel -m 700 $STATE

if [[ -n $profile ]]; then
  /usr/bin/osascript -l JavaScript -e 'function run(a){return JSON.stringify({profile:a[0]})}' "$profile" > $STATE/config.json
  chmod 600 $STATE/config.json
fi
if [[ ! -s $STATE/token ]]; then
  [[ -z ${QG_FROM_UPDATE:-} ]] || { echo "no Qustodio token; run install.sh by hand" >&2; exit 1; }
  "$LIB/qustodio-token.sh" $STATE/token
fi

# daemon <label> <interval-seconds> <program> [args...] — (re)loads only if the plist changed.
# ThrottleInterval = interval: launchd's default of 10 s would otherwise cap the 5 s guard.
daemon() {
  local label=$1 interval=$2; shift 2
  local plist=/Library/LaunchDaemons/$label.plist args= new
  for a in "$@"; do args+="<string>$a</string>"; done
  new=$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>StartInterval</key><integer>$interval</integer>
  <key>ThrottleInterval</key><integer>$interval</integer>
  <key>RunAtLoad</key><true/>
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
# Self-update from GitHub main, every 6 h. Not touched when update.sh itself runs this script:
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
