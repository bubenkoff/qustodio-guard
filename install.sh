#!/bin/zsh
# Install qustodio-guard on a kid's Mac. Run from a parent (admin) account:
#
#   sudo ./install.sh [--profile <Qustodio profile name>]
#
# Without --profile, the guard works out which Qustodio profile watches whoever is at the
# screen from Qustodio's own device list, and leaves admin accounts alone. Re-running is safe:
# it updates the script and reloads the daemon, and asks for the Qustodio login only if there
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
PLIST=/Library/LaunchDaemons/$LABEL.plist
LOG=/var/log/qustodio-guard.log

install -d -o root -g wheel -m 755 "$LIB"
install -o root -g wheel -m 644 "$here/guard.js" "$LIB/guard.js"
install -o root -g wheel -m 755 "$here/qustodio-token.sh" "$LIB/qustodio-token.sh"
install -d -o root -g wheel -m 700 $STATE

if [[ -n $profile ]]; then
  /usr/bin/osascript -l JavaScript -e 'function run(a){return JSON.stringify({profile:a[0]})}' "$profile" > $STATE/config.json
  chmod 600 $STATE/config.json
fi
[[ -s $STATE/token ]] || "$LIB/qustodio-token.sh" $STATE/token

cat > $PLIST <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/osascript</string><string>-l</string><string>JavaScript</string>
    <string>$LIB/guard.js</string><string>$STATE</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
chown root:wheel $PLIST; chmod 644 $PLIST

/bin/launchctl bootout system/$LABEL 2>/dev/null || true
/bin/launchctl bootstrap system $PLIST

# Warn about kid accounts that could simply remove all this.
for u in $(dscl . -list /Users UniqueID | awk '$2 >= 501 {print $1}'); do
  dseditgroup -o checkmember -m $u admin | grep -q '^yes' && admins+=($u) || kids+=($u)
done
echo "installed; log: $LOG"
echo "admin accounts (never guarded): ${admins[*]:-none}"
echo "standard accounts (guarded if Qustodio watches them): ${kids[*]:-none}"
