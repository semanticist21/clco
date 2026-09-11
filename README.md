# clco

Run Claude Code with your GitHub Copilot subscription as the backend. **clco never touches the claude binary or your existing `~/.claude` config** — it spins up a local adapter that translates Anthropic Messages ↔ GitHub Copilot on the fly.

```
clco
✓ GitHub token        (0.0s)
✓ Copilot token + models (0.4s)
┌  Pick a model — type to search
│  ● Claude Sonnet 5        claude-sonnet-5
│  ○ Luna 5.6               gpt-5.6-luna
│  ...
```

## Requirements

- The [claude CLI](https://claude.com/claude-code) on your PATH
- A GitHub account with an active Copilot subscription
- [Bun](https://bun.sh) — installed automatically by the install script if missing

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/install.sh | bash
```

Installs to `~/.local/share/clco` and creates a launcher at `~/.local/bin/clco`.
Prefer a different location: `CLCO_DIR=~/somewhere curl -fsSL ... | bash`

## Usage

```sh
clco                      # first run: GitHub device-flow login → pick a model → claude
clco -- -p "question"     # args after -- go straight to claude (skips the model picker)
clco serve                # run the adapter server only
clco login / clco auth    # (re)authenticate — also switches accounts
clco logout               # delete the stored token (model preference is kept)
clco update               # update to the latest version (git pull + deps)
clco help
```

- **Models**: clco fetches every model your Copilot plan offers and lets you search them at startup. Your last pick is remembered as the default.
  Switch mid-session with `/model` inside claude, or pin one: `clco -- --model luna-5.6` / `CLCO_SONNET=luna-5.6 clco`
  (slot overrides: `CLCO_OPUS` / `CLCO_SONNET` / `CLCO_HAIKU` / `CLCO_FABLE`)
- **Typo guard**: unknown args before `--` fail fast with the full command list instead of silently starting a session.
- **Auth**: the token is stored once at `~/.config/clco/auth.json` (mode 600). If it's ever rejected, `clco auth` re-authenticates.
- **Debug**: `CLCO_DEBUG=1 clco` — adapter request logs go to `~/.config/clco/adapter.log`.

## Uninstall

```sh
# remove the app + launcher (keeps your GitHub token)
curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/uninstall.sh | bash

# also wipe config incl. the token (~/.config/clco)
curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/uninstall.sh | bash -s -- --full
```

## How it works

1. One-time GitHub OAuth device flow → long-lived token stored locally.
2. That token mints short-lived Copilot tokens automatically while a local adapter (127.0.0.1, ephemeral port) is running.
3. claude is pointed at the adapter via `--settings` (no config files modified) — the adapter translates Anthropic Messages ↔ Copilot (`chat/completions`, with an automatic fallback to the Responses API for models like the GPT-5.x family). SSE streaming, tool calling, images, and parallel tool calls are supported.

## Development

```sh
bun install
bun test          # unit + mock-upstream integration tests
bun run check     # tsc --noEmit
CLCO_UPSTREAM=http://127.0.0.1:9099 bun run scripts/mock-upstream.ts  # mock upstream
```

## Caveats

- Using Copilot outside official clients is a gray area of GitHub's terms. Heavy use may flag your account, and Claude models consume premium quota. Intended for personal use.
- Extended thinking is not supported. `stop_sequences` are not enforced on Responses-API models (the GPT-5.x family).
- License: [MIT](LICENSE)
