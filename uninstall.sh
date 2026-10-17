#!/bin/zsh
# Remove qustodio-guard, including the stored Qustodio token.   sudo ./uninstall.sh
set -eu
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
LABEL=io.github.bubenkoff.qustodio-guard
/bin/launchctl bootout system/$LABEL 2>/dev/null || true
rm -f /Library/LaunchDaemons/$LABEL.plist
rm -f "/Library/Application Support/qustodio-guard/guard.js" "/Library/Application Support/qustodio-guard/qustodio-token.sh"
rmdir "/Library/Application Support/qustodio-guard" 2>/dev/null || true
rm -f /var/root/qustodio-guard/token /var/root/qustodio-guard/state.json /var/root/qustodio-guard/req.cfg /var/root/qustodio-guard/config.json
rmdir /var/root/qustodio-guard 2>/dev/null || true
echo "removed (log kept at /var/log/qustodio-guard.log)"
