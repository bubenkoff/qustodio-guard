#!/bin/zsh
# Self-update from GitHub main. Run by launchd as root every 6 hours (installed by install.sh).
# Only files that changed are replaced, and only after guard.js compiles — a broken push must
# not leave the kid unguarded. A change to install.sh itself (the plists) needs a manual re-run.
set -eu
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
cmp -s $src/install.sh "$LIB/install.sh" 2>/dev/null || log "install.sh changed on main — re-run it to apply"
exit 0
