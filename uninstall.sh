#!/bin/zsh
# Remove qustodio-guard, including the stored Qustodio token.
#   sudo "/Library/Application Support/qustodio-guard/uninstall.sh"
set -eu
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
LABEL=io.github.bubenkoff.qustodio-guard
for l in $LABEL $LABEL.update; do
  /bin/launchctl bootout system/$l 2>/dev/null || true
  rm -f /Library/LaunchDaemons/$l.plist
done
rm -rf "/Library/Application Support/qustodio-guard" /var/root/qustodio-guard
echo "removed (log kept at /var/log/qustodio-guard.log)"
