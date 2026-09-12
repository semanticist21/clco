# clco

Run Claude Code on your GitHub Copilot subscription. It starts a local adapter that translates Anthropic Messages ↔ GitHub Copilot, and runs claude against a config directory of its own — so **a `/model` pick inside clco never changes the model your plain `claude` uses**.

```
$ clco
│
◇  Checking GitHub token ✓ 0.0s
│
◇  Fetching Copilot token and model list ✓ 1.8s
│
◆  Pick a model - type to search
│  Search models...
│  ● Claude Sonnet 5   claude-sonnet-5 · native · 200k
│  ○ GPT-5.6 Luna      gpt-5.6-luna · responses · 200k
│  ○ Kimi K3           kimi-k3 · chat · 918k
└
+ adapter: http://127.0.0.1:56844
+ model: claude-sonnet-5 (sonnet=claude-sonnet-5 opus=claude-opus-5 haiku=claude-haiku-4.5)
+ browser: @playwright/mcp@latest
```

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/install.sh | bash
```

Installs to `~/.local/share/clco`, launcher at `~/.local/bin/clco`.
Elsewhere: `CLCO_DIR=~/somewhere curl -fsSL ... | bash`

Needs the [claude CLI](https://claude.com/claude-code) (the installer offers to
fetch it), a GitHub account with Copilot, and [Bun](https://bun.sh) (installed
automatically if missing).

## First run

```sh
clco
```

1. **GitHub login**, once — a device-flow code to paste in your browser. The
   token is stored at `~/.config/clco/auth.json` (mode 600).
2. **Three questions**, once. Re-run them any time with `clco setup`:

   | Question | Default | What it does |
   |---|---|---|
   | Run without permission prompts? | **Yes** | Passes `--dangerously-skip-permissions`, so claude edits files and runs commands without asking. `clco --no-bypass` for one session. |
   | Enable Playwright MCP for browser control? | **Yes** | Registers the Playwright MCP server for clco sessions only. Needs an extension — see [Browser control](#browser-control). `clco --no-browser` for one session. |
   | Pick a model each time clco starts? | **Yes** | Shows the model prompt at launch. Answering No reuses your last pick. `clco --no-select` for one session. |

3. **Pick a model**, then claude starts. Switch mid-session with `/model`.

   Answering yes to the first two together is worth understanding: claude runs
   without permission prompts, and each session resolves the current
   `@playwright/mcp` release from npm (`bunx -y @playwright/mcp@latest`) and runs
   it with access to the browser tab you share. The version is re-resolved every
   session, so a release published today runs on your machine today; nothing in
   this path checks an integrity hash. Either answer is reasonable alone; both at
   once is a lot of trust in one command. `clco setup` changes them,
   `--no-bypass` / `--no-browser` skip them for a single run, and
   `CLCO_MCP_PACKAGE` pins or redirects the package — see
   [Browser control](#browser-control).

## Usage

```sh
clco                   # a session
clco -p "question"     # anything clco doesn't own goes straight to claude
clco status            # account, plan, and every model's route/policy/context
clco setup             # change the three answers above
clco help              # all commands and environment variables
```

## Models

`/model` lists every conversational model your Copilot account offers, not just
the Claude ones. Each row shows the upstream id, its route, its real context
window, and whether it supports `/effort`.

What your plan actually allows is a separate matter, and Copilot's metadata does
not predict it — a model can be marked `enabled` and still refuse. Picking one
your plan does not cover answers `400 The requested model is not supported`.

Pin a model instead of choosing: `clco --model kimi-k3`, or per slot with
`CLCO_OPUS` / `CLCO_SONNET` / `CLCO_HAIKU` / `CLCO_FABLE` — the four model
slots Claude Code asks for by name.

## Browser control

Claude's own Chrome extension cannot work here: Claude Code gates it on the
session's OAuth scope, and clco authenticates with `ANTHROPIC_AUTH_TOKEN`, which
is always `user:inference`. Passing `--chrome` registers nothing.

Playwright MCP has no such gate, and in `--extension` mode it drives the tab you
share from your own browser — logins and cookies intact — rather than a fresh
profile. Install [Playwright MCP
Bridge](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm),
then answer yes at `clco setup`. Tools arrive as `mcp__playwright__*` once you
click the extension to share a tab.

The extension shows a `PLAYWRIGHT_MCP_EXTENSION_TOKEN`; storing it skips the
connect dialog every session:

```sh
pbpaste | clco token       # clco token --clear to remove it
```

Started with `bunx` (or `npx`) and fetched from npm each session. If that fails,
clco says which way it failed at startup rather than leaving you with tools that
silently never appear — unless `CLCO_MCP_PACKAGE` points at another registry,
which clco cannot probe and says so:

```
! browser: cannot reach registry.npmjs.org - browser tools will not appear
! browser: registry.npmjs.org is slow to answer - browser tools may be slow to appear
! browser: TLS rejected by registry.npmjs.org - ... Set CLCO_CA_BUNDLE to your company CA.
+ browser: @corp/playwright-mcp@1.2.3 (registry not checked)
```

That check only knows about `registry.npmjs.org`, so it cannot speak for an
internal mirror. `CLCO_MCP_PACKAGE` overrides the package spec for one — or to
pin a version, or roll back past a bad release:

```sh
CLCO_MCP_PACKAGE=@playwright/mcp@0.0.80 clco
```

Pinning is not an offline mode: browser control needs npm either way.

## What clco reads

Nothing clco reads from your disk leaves the machine. Its outbound requests are
GitHub login, the Copilot token exchange, the model list, your chat itself,
plus — with browser control on — resolving `@playwright/mcp` against npm each
session, and `git pull` when you run `clco update`.

- **Chrome, Chromium and Edge profile directories** — directory *names* only, to
  see whether the Playwright extension is installed.
- **The claude binary** — scanned once per claude version for the model ids it
  knows, cached in `~/.config/clco/catalog.json`. Without it clco cannot tell
  which ids `/model` will accept.
- **`~/.claude`** — every entry is symlinked into `~/.config/clco/claude-home`
  except `settings.json`, `settings.local.json` and `backups`, which are
  private copies. So plugins, skills, agents, projects, history and shell
  snapshots stay shared and are written into `~/.claude` exactly as a plain
  `claude` run would; only the settings file, where a `/model` pick would land,
  is clco's own.
- **`~/.claude.json`** — copied into clco's config dir, since it holds trust
  decisions and MCP servers, and it carries account identifiers and any secrets
  your MCP servers declare. Your MCP servers and per-project trust are re-read
  from the real file on every launch, so deleting a server or withdrawing trust
  there applies to clco too; everything else in the copy is clco's own.
  `uninstall.sh --full` removes it; a plain uninstall leaves it.

## Corporate networks

Behind a TLS-inspecting proxy, export your company CA and point clco at it:

```sh
security find-certificate -a -p -c "<CA name>" > ~/ca.pem   # macOS
CLCO_CA_BUNDLE=~/ca.pem clco
```

clco **adds** it to the OS trust store rather than replacing it, so everything
that worked before still does. Several paths can be joined with `:`.

Prefer this to `NODE_EXTRA_CA_CERTS`, which has been reported to supplant the
system store on macOS and break trust that already worked. `NODE_USE_SYSTEM_CA`
does nothing on Bun — its default set already includes the system roots.

## Uninstall

```sh
# app + launcher (keeps your GitHub token)
curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/uninstall.sh | bash

# also wipe ~/.config/clco, token included
curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/uninstall.sh | bash -s -- --full
```

## How it works

1. One-time GitHub OAuth device flow → a long-lived token stored locally.
2. That token mints short-lived Copilot tokens while a local adapter
   (127.0.0.1, ephemeral port) runs.
3. claude is launched against that adapter with `--settings`, and against a
   private `CLAUDE_CONFIG_DIR` at `~/.config/clco/claude-home`. Your plugins,
   skills, agents and commands are symlinked in, so they stay shared and live;
   the files claude writes back — including the model a `/model` pick saves as
   your default — stay inside clco's directory and never reach `~/.claude`.
4. The adapter picks a route per model from Copilot's own `/models`:
   - **native** — Copilot serves Claude models on `/v1/messages`, the real
     Anthropic endpoint, so those requests pass through untranslated: thinking,
     `cache_control`, `/effort` and tool blocks stay intact.
   - **translated** — everything else becomes `chat/completions`, or the
     Responses API where a model requires it (the GPT-5.x family). SSE
     streaming, tool calling, images and parallel tool calls work on both.

   A rejected native attempt falls back to the translated path and is
   remembered. `CLCO_NO_PASSTHROUGH=1` forces translation everywhere.

## Development

```sh
bun install
bun test          # unit + mock-upstream integration tests
bun run check     # tsc --noEmit
CLCO_UPSTREAM=http://127.0.0.1:9099 bun run scripts/mock-upstream.ts
```

## Caveats

- Using Copilot outside official clients is a gray area of GitHub's terms. clco
  authenticates with the VS Code Copilot OAuth client id and sends the same
  editor headers, so its requests are indistinguishable from the official
  client — that is what makes it work, and what makes it a gray area. Heavy use
  may flag your account, and Claude models consume premium quota. Intended for
  personal use.
- Extended thinking works on the native route only; it stays disabled on
  translated routes. `stop_sequences` are not enforced on Responses-API models.
- `/effort` is forwarded when the selected model declares that level, and
  dropped otherwise — rows in `/model` say which do not support it.
- The context window is fixed at launch from the model you start with, so
  switching to a much smaller one mid-session can exceed its real limit. The
  adapter catches that and says so rather than letting the request fail
  upstream.
- License: [MIT](LICENSE)
