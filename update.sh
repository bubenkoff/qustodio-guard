#!/bin/zsh
# Self-update from GitHub main. Run by launchd as root every 6 hours (installed by install.sh).
# Only files that changed are replaced, and only after guard.js compiles — a broken push must
# not leave the kid unguarded. A changed install.sh is run too (plists); the updater's own plist
# is the one thing that still needs a manual re-run.
set -eu -o pipefail
REPO=bubenkoff/qustodio-guard
LIB="/Library/Application Support/qustodio-guard"
log() { print -r -- "$(date -u +%FT%TZ) update: $*"; }

tmp=$(mktemp -d); trap 'rm -rf $tmp' EXIT
/usr/bin/curl -fsSL --max-time 60 https://github.com/$REPO/archive/refs/heads/main.tar.gz | tar xz -C $tmp \
  || { log "download failed"; exit 0; }
src=$tmp/${REPO:t}-main

/usr/bin/osacompile -l JavaScript -o $tmp/check.scpt $src/guard.js 2>/dev/null \
  || { log "guard.js on main does not compile, keeping the installed one"; exit 0; }

changed=()
for f in guard.js qustodio-token.sh update.sh uninstall.sh; do
  [[ -f $src/$f ]] || continue
  cmp -s $src/$f "$LIB/$f" && continue
  [[ $f == guard.js ]] && mode=644 || mode=755
  install -o root -g wheel -m $mode $src/$f "$LIB/$f"
  changed+=($f)
done
(( $#changed )) && log "updated ${changed[*]}"
# A new install.sh may carry new launchd plists; it reloads only the jobs whose plist changed,
# and leaves this updater's own job alone while we are inside it.
if ! cmp -s $src/install.sh "$LIB/install.sh"; then
  QG_FROM_UPDATE=1 /bin/zsh $src/install.sh </dev/null && log "applied new install.sh" \
    || log "new install.sh failed, re-run it by hand"
fi
exit 0
