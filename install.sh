#!/usr/bin/env bash
# clco installer — GitHub Copilot-backed Claude Code wrapper.
#   curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/semanticist21/clco.git"
CLCO_DIR="${CLCO_DIR:-$HOME/.local/share/clco}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required - please install it first"

install_dependencies() {
  local target="$1"
  local frozen_output
  log "Installing dependencies (bun install)"
  if frozen_output="$(cd "$target" && bun install --frozen-lockfile 2>&1)"; then
    return 0
  fi
  if [[ "$frozen_output" != *"Unknown lockfile version"* &&
    "$frozen_output" != *"UnknownLockfileVersion"* &&
    "$frozen_output" != *"failed to parse lockfile"* ]]; then
    printf '%s\n' "$frozen_output" >&2
    return 1
  fi
  if (cd "$target" && bun install --no-save >/dev/null 2>&1); then
    return 0
  fi
  log "bun install failed - full output:"
  printf '%s\n' "$frozen_output" >&2
  (cd "$target" && bun install --no-save) || return 1
}

# --- Bun --------------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  fail "Bun is not installed. Please install using: curl -fsSL https://bun.sh/install | bash. Or visit https://bun.sh/docs/installation to install it."
fi

# --- Source ------------------------------------------------------------------
if [ ! -e "$CLCO_DIR" ] && [ -d "$CLCO_DIR.previous/.git" ]; then
  log "Recovering the previous install after an interrupted update"
  mv "$CLCO_DIR.previous" "$CLCO_DIR" \
    || fail "Could not recover the previous clco install"
fi
if [ -d "$CLCO_DIR/.git" ]; then
  log "Updating the existing install: $CLCO_DIR"
  grep -Eq '^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"clco"[[:space:]]*,?[[:space:]]*$' \
    "$CLCO_DIR/package.json" \
    || fail "$CLCO_DIR is a git repo, but not a clco install"
  CURRENT_URL="$(git -C "$CLCO_DIR" remote get-url origin 2>/dev/null || true)"
  case "$CURRENT_URL" in
    "$REPO"|git@github.com:semanticist21/clco.git) ;;
    *) fail "$CLCO_DIR does not point to the canonical clco repository" ;;
  esac
  [ -z "$(git -C "$CLCO_DIR" status --porcelain)" ] \
    || fail "Update aborted - local changes exist in $CLCO_DIR; commit or stash them first"
  CURRENT_HEAD="$(git -C "$CLCO_DIR" rev-parse HEAD)" \
    || fail "Could not read the current revision in $CLCO_DIR"
  BRANCH="$(git -C "$CLCO_DIR" rev-parse --abbrev-ref HEAD)" \
    || fail "Could not read the current branch in $CLCO_DIR"
  [ "$BRANCH" != HEAD ] || fail "Update requires a checked-out branch in $CLCO_DIR"

  UPDATE_LOCK="$CLCO_DIR.update.lock"
  mkdir "$UPDATE_LOCK" \
    || fail "Another clco update is already running (or left an update lock; remove it after verifying)"
  STAGE_ROOT="$(mktemp -d "$(dirname "$CLCO_DIR")/.clco-install.XXXXXX")" \
    || fail "Could not create a temporary update directory"
  STAGE="$STAGE_ROOT/app"
  trap 'rm -rf "$STAGE_ROOT" "$UPDATE_LOCK"' EXIT
  git clone --local "$CLCO_DIR" "$STAGE" >/dev/null \
    || fail "Could not create a staged update checkout"
  git -C "$STAGE" remote set-url origin "$REPO" 2>/dev/null \
    || git -C "$STAGE" remote add origin "$REPO" \
    || fail "Could not set the canonical clco origin"
  git -C "$STAGE" fetch --quiet origin "$BRANCH" \
    || fail "Could not fetch the latest clco revision"
  git -C "$STAGE" merge-base --is-ancestor "$CURRENT_HEAD" "origin/$BRANCH" \
    || fail "Update is not a fast-forward - resolve the branch manually first"
  git -C "$STAGE" checkout --quiet -B "$BRANCH" "origin/$BRANCH" \
    || fail "Could not check out the staged clco revision"
  install_dependencies "$STAGE" \
    || fail "bun install failed - the previous revision is still active"
  (cd "$STAGE" && bun run --no-install src/cli.ts version >/dev/null) \
    || fail "Updated checkout failed its smoke test - the previous revision is still active"

  LIVE_HEAD="$(git -C "$CLCO_DIR" rev-parse HEAD)" \
    || fail "Could not re-check the live revision before activation"
  LIVE_STATUS="$(git -C "$CLCO_DIR" status --porcelain)" \
    || fail "Could not re-check the live checkout before activation"
  [ "$LIVE_HEAD" = "$CURRENT_HEAD" ] && [ -z "$LIVE_STATUS" ] \
    || fail "The live checkout changed while it was being updated"
  git -C "$CLCO_DIR" config --replace-all remote.origin.url "$REPO" \
    || fail "Could not sanitize the clco origin before activation"
  git -C "$CLCO_DIR" config --unset-all remote.origin.pushurl 2>/dev/null || true
  [ -z "$(git -C "$CLCO_DIR" config --get-all remote.origin.pushurl 2>/dev/null || true)" ] \
    || fail "Could not remove credentials from the clco origin before activation"
  if [ -e "$CLCO_DIR.previous" ]; then
    [ -d "$CLCO_DIR.previous/.git" ] \
      || fail "$CLCO_DIR.previous is not a clco rollback directory - refusing to replace it"
    rm -rf "$CLCO_DIR.previous"
  fi
  mv "$CLCO_DIR" "$CLCO_DIR.previous" \
    || fail "Could not prepare the existing install for activation"
  if ! mv "$STAGE" "$CLCO_DIR"; then
    mv "$CLCO_DIR.previous" "$CLCO_DIR" || true
    fail "Could not activate the staged install"
  fi
  trap - EXIT
  rm -rf "$STAGE_ROOT"
  rmdir "$UPDATE_LOCK" 2>/dev/null || true
  NEEDS_INSTALL=0
else
  [ -e "$CLCO_DIR" ] && fail "$CLCO_DIR already exists and is not a git repo - remove it and retry"
  log "Cloning into $CLCO_DIR"
  git clone --depth 1 "$REPO" "$CLCO_DIR"
  NEEDS_INSTALL=1
fi

if [ "$NEEDS_INSTALL" = 1 ]; then
  install_dependencies "$CLCO_DIR" || fail "bun install failed"
fi

# --- claude CLI (required by clco; offer to install) -------------------------
CLAUDE_WARN="Install it later with: curl -fsSL https://claude.ai/install.sh | bash"
if command -v claude >/dev/null 2>&1; then
  log "Found the claude CLI"
else
  log "The claude CLI is missing (clco needs it)"
  INSTALL_CLAUDE=n
  if [ -e /dev/tty ]; then
    printf 'Install it now? [y/N] '
    answer=n
    read -r answer < /dev/tty || answer=n
    case "$answer" in y|Y|yes|Yes) INSTALL_CLAUDE=y ;; esac
  fi
  if [ "$INSTALL_CLAUDE" = y ]; then
    log "Installing the claude CLI (official script)"
    curl -fsSL https://claude.ai/install.sh | bash
    export PATH="$HOME/.local/bin:$PATH"
    command -v claude >/dev/null 2>&1 \
      || log "! Could not verify the claude install - reopen your terminal and check. $CLAUDE_WARN"
  else
    log "! Skipped - clco needs the claude CLI before it can run. $CLAUDE_WARN"
  fi
fi

# --- Launcher ----------------------------------------------------------------
# Generated by a script the repo owns, so `clco update` refreshes it too.
bash "$CLCO_DIR/scripts/write-launcher.sh" "$CLCO_DIR" "$BIN_DIR"



case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\033[1;33mNote:\033[0m %s is not on your PATH. Add it to ~/.zshrc or similar:\n  export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
esac

log "Installed: $BIN_DIR/clco"
printf '\nGetting started:\n  clco          first run: GitHub device login, pick a model, launch claude\n  clco setup    set your startup defaults\n  clco --help   full usage\n\nUninstall:\n  curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/uninstall.sh | bash\n'
