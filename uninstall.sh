#!/usr/bin/env bash
# clco uninstaller.
#   curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/uninstall.sh | bash
#   ... --full   : also remove config and the GitHub token (~/.config/clco)
set -euo pipefail

CLCO_DIR="${CLCO_DIR:-$HOME/.local/share/clco}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

removed=0
if [ -f "$BIN_DIR/clco" ]; then rm -f "$BIN_DIR/clco"; log "Removed: $BIN_DIR/clco"; removed=1; fi
if [ -d "$CLCO_DIR" ]; then
  if [ ! -d "$CLCO_DIR/.git" ]; then
    fail "$CLCO_DIR is not a clco install (git repo) - check it yourself before deleting"
  fi
  rm -rf "$CLCO_DIR"; log "Removed: $CLCO_DIR"; removed=1
fi
if [ -d "$CLCO_DIR.previous" ]; then
  [ -d "$CLCO_DIR.previous/.git" ] \
    || fail "$CLCO_DIR.previous is not a clco rollback install - check it yourself before deleting"
  rm -rf "$CLCO_DIR.previous"; log "Removed: $CLCO_DIR.previous"; removed=1
fi
if [ -d "$CLCO_DIR.update.lock" ]; then
  rmdir "$CLCO_DIR.update.lock" \
    || fail "$CLCO_DIR.update.lock is not empty - verify no update is running before removing it"
  log "Removed stale update lock: $CLCO_DIR.update.lock"; removed=1
fi

if [ "${1:-}" = "--full" ]; then
  if [ -d "$HOME/.config/clco" ]; then
    rm -rf "$HOME/.config/clco"
    log "Removed: ~/.config/clco (including the GitHub token)"
  fi
else
  [ -d "$HOME/.config/clco" ] && log "Kept config: ~/.config/clco (including the GitHub token) - remove it with: $0 --full"
fi

[ "$removed" = "1" ] || [ "${1:-}" = "--full" ] || log "Nothing to remove"
log "Done"
