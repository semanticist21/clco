#!/usr/bin/env bash
# clco installer — GitHub Copilot-backed Claude Code wrapper.
#   curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/semanticist21/clco.git"
CLCO_DIR="${CLCO_DIR:-$HOME/.local/share/clco}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m오류:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git이 필요합니다 — 먼저 설치해 주세요"

# --- Bun (auto-install when missing) ---------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  log "Bun이 없어서 공식 설치 스크립트로 설치합니다"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || fail "Bun 설치 확인 실패 — 터미널을 다시 열고 재실행해 주세요"
fi

# --- Source ------------------------------------------------------------------
if [ -d "$CLCO_DIR/.git" ]; then
  log "기존 설치 업데이트: $CLCO_DIR"
  # Pre-rename clones carry a stale origin — retarget before pulling.
  CURRENT_URL="$(git -C "$CLCO_DIR" remote get-url origin 2>/dev/null || true)"
  case "$CURRENT_URL" in
    *semanticist21/clco.git) ;;
    https://*|git@github.com:*)
      [ -n "$CURRENT_URL" ] && git -C "$CLCO_DIR" remote set-url origin "$REPO"
      ;;
  esac
  git -C "$CLCO_DIR" pull --ff-only >/dev/null 2>&1 || fail "업데이트 실패 — $CLCO_DIR에서 git pull을 직접 확인해 주세요"
else
  [ -e "$CLCO_DIR" ] && fail "$CLCO_DIR 가 이미 있고 git 저장소가 아닙니다 — 지우고 재실행하세요"
  log "저장소 클론: $CLCO_DIR"
  git clone --depth 1 "$REPO" "$CLCO_DIR"
fi

log "의존성 설치 (bun install)"
(cd "$CLCO_DIR" && bun install --frozen-lockfile >/dev/null 2>&1) \
  || (cd "$CLCO_DIR" && bun install >/dev/null 2>&1) \
  || { log "bun install 실패 — 상세 출력:"; (cd "$CLCO_DIR" && bun install) || fail "bun install 실패"; }

# --- Launcher ----------------------------------------------------------------
mkdir -p "$BIN_DIR"
BUN_BIN="$(command -v bun)"
cat > "$BIN_DIR/clco" <<LAUNCHER
#!/bin/sh
# clco launcher (installed by install.sh)
CLCO_APP_DIR="$CLCO_DIR"
export CLCO_APP_DIR
# bun strips a leading "--" before scripts see it — translate it into a
# sentinel that cli.ts understands as "everything after is claude's".
if [ "\$1" = "--" ]; then
  shift
  set -- "__clco_passthrough__" "\$@"
fi
exec "$BUN_BIN" run "$CLCO_DIR/src/cli.ts" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/clco"

command -v claude >/dev/null 2>&1 || log "⚠ claude CLI가 없습니다 — https://claude.com/claude-code 에서 먼저 설치하세요 (clco 실행에 필요)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\033[1;33m참고:\033[0m %s 가 PATH에 없습니다. ~/.zshrc 등에 추가하세요:\n  export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
esac

log "설치 완료: $BIN_DIR/clco"
printf '\n시작하기:\n  clco          ← 첫 실행 시 GitHub 로그인(device flow) → 모델 선택 → claude 실행\n  clco --help   ← 전체 사용법\n\n제거:\n  curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/uninstall.sh | bash\n'
