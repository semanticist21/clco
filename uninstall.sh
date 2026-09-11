#!/usr/bin/env bash
# clco uninstaller.
#   curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/uninstall.sh | bash
#   ... --full   : GitHub 토큰 등 설정(~/.config/clco)까지 삭제
set -euo pipefail

CLCO_DIR="${CLCO_DIR:-$HOME/.local/share/clco}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m오류:\033[0m %s\n' "$*" >&2; exit 1; }

removed=0
if [ -f "$BIN_DIR/clco" ]; then rm -f "$BIN_DIR/clco"; log "제거: $BIN_DIR/clco"; removed=1; fi
if [ -d "$CLCO_DIR" ]; then
  if [ ! -d "$CLCO_DIR/.git" ]; then
    fail "$CLCO_DIR 가 clco 설치(git 저장소)가 아닙니다 — 안전을 위해 직접 확인 후 삭제하세요"
  fi
  rm -rf "$CLCO_DIR"; log "제거: $CLCO_DIR"; removed=1
fi

if [ "${1:-}" = "--full" ]; then
  if [ -d "$HOME/.config/clco" ]; then
    rm -rf "$HOME/.config/clco"
    log "제거: ~/.config/clco (GitHub 토큰 포함)"
  fi
else
  [ -d "$HOME/.config/clco" ] && log "설정 유지: ~/.config/clco (GitHub 토큰 포함) — 완전 삭제는: $0 --full"
fi

[ "$removed" = "1" ] || [ "${1:-}" = "--full" ] || log "제거할 clco 흔적이 없습니다"
log "완료"
