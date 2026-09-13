#!/usr/bin/env bun
// clco — run the stock Claude Code CLI backed by a GitHub Copilot
// subscription: device-flow OAuth, a local Anthropic-compatible adapter, and
// claude launched with injected settings.

import * as p from "@clack/prompts"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { appendFile, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { clearAuth, loadPrefs, savePrefs, saveAuth } from "./config"
import { ensureGithubToken, runDeviceFlow } from "./auth"
import {
  GITHUB_API_BASE_URL,
  copilotFetch,
  githubRequestHeaders,
  isMockMode,
} from "./api"
import {
  copilotTokenFacts,
  discoverModels,
  takeDiscoverySoftFailure,
  upstreamModels,
} from "./token"
import { setAdapterLogSink, startServer } from "./server"
import { buildModelPickerFrom, resolveClaude, runClaude } from "./spawn"
import { isTlsTrustError, tlsHint } from "./tls"
import {
  extensionHint,
  extensionInstalled,
  parseToken,
  probesDefaultRegistry,
  registryStatus,
  startupLine,
} from "./browsermcp"
import {
  loadSetup,
  runSetup,
  setupClaudeArgs,
  setupEnv,
  modelWithoutPrompt,
  shouldSelectModel,
  type SetupOverrides,
} from "./setup"
import { normalizeModel } from "./translate"

// Single source: the package manifest. appDir() resolves the install even
// when clco is started through the launcher from another directory.
const VERSION: string = await (async () => {
  try {
    const dir = appDir() ?? join(import.meta.dir, "..")
    const raw = await readFile(join(dir, "package.json"), "utf8")
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown"
  } catch {
    return "unknown"
  }
})()

interface Args {
  command:
    | "run" | "serve" | "auth" | "login" | "logout" | "update" | "status"
    | "setup" | "version" | "token"
  port?: number
  /** Saved setup options turned off for this run via --no-*. */
  overrides: SetupOverrides
  claudeArgs: string[]
}

// One list, two renderings: help and the typo path used to drift apart, and
// the typo path was the only place `setup` was mentioned.
const COMMANDS: ReadonlyArray<[string, string]> = [
  ["clco", "Start a session (prompts for a model)"],
  ["clco serve", "Run only the adapter; point your own claude at it"],
  ["clco status", "Show account, plan, model policy and routing"],
  ["clco setup", "Set startup defaults (permissions, browser control, model prompt)"],
  ["clco token", "Store the Playwright MCP token: pbpaste | clco token"],
  ["clco token --clear", "Remove the stored token"],
  ["clco login|auth", "(Re)authenticate with GitHub; also switches accounts"],
  ["clco logout", "Delete the stored GitHub token"],
  ["clco update", "Update this install to the latest revision"],
  ["clco version", "Print the version"],
  ["clco help", "Show this help"],
  ["clco --port N", "Pin the adapter port"],
  ["clco --no-bypass", "Re-enable permission prompts for this run"],
  ["clco --no-select", "Skip the model prompt for this run"],
  ["clco --no-browser", "Skip Playwright MCP for this run"],
]

const ENVIRONMENT: ReadonlyArray<[string, string]> = [
  ["CLCO_CA_BUNDLE", "CA file(s) to add to the OS trust store (TLS-inspecting proxies)"],
  ["CLCO_OPUS/SONNET/HAIKU/FABLE", "Override the model slug for a slot"],
  ["CLCO_MIN_WINDOW", "Hide models with a smaller context window"],
  ["CLCO_SHOW_INTERNAL", "Also list Copilot's internal search/exec models"],
  ["CLCO_NO_SELECT=1", "Skip the startup model prompt"],
  ["CLCO_NO_PASSTHROUGH=1", "Disable the native /v1/messages route (always translate)"],
  ["CLCO_DEBUG=1", "Write adapter request logs to ~/.config/clco/adapter.log"],
  ["CLCO_MCP_PACKAGE", "Override the Playwright MCP package spec (mirror, pin, rollback)"],
  ["CLCO_UPSTREAM", "Override the upstream base URL (mock testing; skips auth)"],
]

const pad = (rows: ReadonlyArray<[string, string]>, width: number) =>
  rows.map(([k, v]) => `  ${k.padEnd(width)} ${v}`).join("\n")

export const COMMAND_LIST = `Commands:\n${pad(COMMANDS, 20)}`

const HELP = `clco v${VERSION} — run Claude Code on your GitHub Copilot subscription

Usage:
  clco [--port N] [claude args...]
      GitHub auth (first run only) -> pick a model -> start the local
      adapter -> launch claude. Any dashed argument clco does not own is
      passed straight through:
        clco -p "ask"  /  clco --resume  /  clco --model gpt-4.1
      The first interactive run also asks for your startup defaults.

${COMMAND_LIST}

Environment:
${pad(ENVIRONMENT, 28)}

claude's own flags pass through unchanged.`

export function parseArgs(rawArgv: string[]): Args {
  // The launcher replaces a leading "--" with this sentinel because bun
  // strips the bare separator before scripts ever see it; it is consumed in
  // the scan below.
  const argv = rawArgv
  const sep = argv.indexOf("--")
  const leading = sep === -1 ? argv : argv.slice(0, sep)
  const trailing = sep === -1 ? [] : argv.slice(sep + 1)

  let command: Args["command"] = "run"
  let port: number | undefined
  const overrides: SetupOverrides = {}
  let i = 0
  while (i < leading.length) {
    const arg = leading[i]
    if (
      (arg === "serve" || arg === "auth" || arg === "login" ||
        arg === "logout" || arg === "update" || arg === "status" ||
        arg === "setup" || arg === "version" || arg === "token") &&
      command === "run"
    ) {
      command = arg
      i++
      continue
    }
    if (arg === "--port") {
      const raw = leading[i + 1]
      const n = Number(raw)
      if (raw === undefined || !Number.isInteger(n) || n <= 0) {
        throw new Error(`--port needs a positive integer\n\n${COMMAND_LIST}`)
      }
      port = n
      i += 2
      continue
    }
    // Turn a saved setup option off for this run. Consumed here so it never
    // reaches claude, which has no --no-* form for any of these.
    if (
      arg === "--no-bypass" ||
      arg === "--no-select" ||
      arg === "--no-browser"
    ) {
      overrides[arg.slice(5) as keyof SetupOverrides] = false
      i++
      continue
    }
    if (arg === "__clco_passthrough__") {
      return { command, port, overrides, claudeArgs: [...leading.slice(i + 1), ...trailing] }
    }
    // A dashed flag we don't own is claude's (--chrome, -p,
    // --dangerously-skip-permissions, ...). A bare word is almost always a
    // mistyped subcommand, so that still fails loudly.
    if (arg !== undefined && arg.startsWith("-")) {
      return { command, port, overrides, claudeArgs: [...leading.slice(i), ...trailing] }
    }
    throw new Error(
      `unknown command: "${arg}"\n(for a claude argument, put it after --: clco -- ${leading.slice(i).join(" ")})\n\n${COMMAND_LIST}`,
    )
  }
  return { command, port, overrides, claudeArgs: trailing }
}

const interactive = process.stdout.isTTY === true

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  if (interactive) {
    const spinner = p.spinner()
    spinner.start(name)
    try {
      const value = await fn()
      spinner.stop(`${name} ✓ ${seconds(Date.now() - t0)}`)
      return value
    } catch (err) {
      spinner.stop(`${name} failed (${seconds(Date.now() - t0)})`)
      throw err
    }
  } else {
    console.error(`… ${name}`)
    const value = await fn()
    console.error(`✓ ${name} (${seconds(Date.now() - t0)})`)
    return value
  }
}

// Where the running installation lives: explicit env from the installed
// launcher, then the standard install location, then a dev checkout.
function appDir(): string | null {
  const recover = (candidate: string): string | null => {
    if (existsSync(join(candidate, ".git"))) return candidate
    const previous = `${candidate}.previous`
    if (!existsSync(candidate) && existsSync(join(previous, ".git"))) {
      try {
        renameSync(previous, candidate)
      } catch {
        return null
      }
    }
    return existsSync(join(candidate, ".git")) ? candidate : null
  }
  if (process.env.CLCO_APP_DIR) return recover(process.env.CLCO_APP_DIR)
  const installed = join(homedir(), ".local", "share", "clco")
  const recovered = recover(installed)
  if (recovered) return recovered
  const devRoot = join(import.meta.dir, "..")
  return recover(devRoot)
}

const CANONICAL_REPOSITORY = "https://github.com/semanticist21/clco.git"

/** Update one checkout without changing it until the replacement is healthy. */
export async function updateInstall(
  dir: string,
  binDir: string,
  canonical = CANONICAL_REPOSITORY,
  bunCommand = "bun",
): Promise<void> {
  console.error(`... updating: ${dir}`)
  if (bunCommand === "bun" && !Bun.which("bun")) {
    throw new Error(
      "Bun is required to update clco. Install it with `curl -fsSL https://bun.sh/install | bash`, then reopen your terminal. Node is not a runtime fallback yet.",
    )
  }

  const lock = `${dir}.update.lock`
  try {
    await mkdir(lock)
  } catch {
    throw new Error(
      "another clco update is already running (or left an update lock; remove the lock after verifying)",
    )
  }

  try {
    const run = (args: string[], cwd?: string) =>
      Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const output = (result: { stdout: Uint8Array; stderr: Uint8Array }) =>
    (result.stderr.toString().trim() || result.stdout.toString().trim()).replace(
      /([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi,
      "$1[redacted]@",
    )
  const commandFailure = (name: string, result: { stdout: Uint8Array; stderr: Uint8Array }) =>
    `${name}: ${output(result) || "unknown error"}`

  // Never mutate an install that contains local work. The staged checkout is
  // what makes dependency failures safe: the live revision and node_modules
  // stay untouched until the new checkout passes both install and smoke test.
  const status = run(["git", "-C", dir, "status", "--porcelain"])
  if (status.exitCode !== 0) throw new Error(commandFailure("git status failed", status))
  if (status.stdout.toString().trim()) {
    throw new Error("update aborted: local changes exist; commit or stash them first")
  }
  const currentHead = run(["git", "-C", dir, "rev-parse", "HEAD"])
  if (currentHead.exitCode !== 0) {
    throw new Error(commandFailure("could not read current revision", currentHead))
  }
  const branch = run(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])
  if (branch.exitCode !== 0 || branch.stdout.toString().trim() === "HEAD") {
    throw new Error("update requires a checked-out branch")
  }
  const branchName = branch.stdout.toString().trim()
  try {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      name?: string
    }
    if (manifest.name !== "clco" && manifest.name !== "@semanticist14/clco") {
      throw new Error("not clco")
    }
  } catch {
    throw new Error("update refused: the target is not a clco installation")
  }
  const stageRoot = await mkdtemp(join(dirname(dir), ".clco-update-"))
  const stage = join(stageRoot, "app")

  try {
    const clone = run(["git", "clone", "--local", dir, stage])
    if (clone.exitCode !== 0) throw new Error(commandFailure("staging checkout failed", clone))

    // A legacy install may have a stale or credential-bearing origin. The
    // staged clone never contacts it: replace it before the fetch and never
    // print the old URL.
    let origin = run(["git", "-C", stage, "remote", "set-url", "origin", canonical])
    if (origin.exitCode !== 0) {
      origin = run(["git", "-C", stage, "remote", "add", "origin", canonical])
    }
    if (origin.exitCode !== 0) {
      throw new Error(commandFailure("could not set the canonical origin", origin))
    }
    const fetch = run(["git", "-C", stage, "fetch", "--quiet", "origin", branchName])
    if (fetch.exitCode !== 0) throw new Error(commandFailure("git fetch failed", fetch))
    const remoteHead = `origin/${branchName}`
    const fastForward = run(["git", "-C", stage, "merge-base", "--is-ancestor", currentHead.stdout.toString().trim(), remoteHead])
    if (fastForward.exitCode !== 0) {
      throw new Error("update is not a fast-forward; resolve the branch manually before updating")
    }
    const checkout = run(["git", "-C", stage, "checkout", "--quiet", "-B", branchName, remoteHead])
    if (checkout.exitCode !== 0) throw new Error(commandFailure("staged checkout failed", checkout))

    let install = run([bunCommand, "install", "--frozen-lockfile"], stage)
    const frozenFailure = output(install)
    const incompatibleLockfile =
      /unknown lockfile version|unknownlockfileversion|failed to parse lockfile/i.test(
        frozenFailure,
      )
    if (install.exitCode !== 0 && incompatibleLockfile) {
      install = run([bunCommand, "install", "--no-save"], stage)
    }
    if (install.exitCode !== 0) {
      throw new Error(
        `${commandFailure("bun install failed; the previous revision is still active", install)}`,
      )
    }
    const smoke = run([bunCommand, "run", "--no-install", "src/cli.ts", "version"], stage)
    if (smoke.exitCode !== 0) {
      throw new Error(commandFailure("updated checkout failed its smoke test", smoke))
    }

    // Detect another updater or a local process changing the live checkout
    // while the staged work was running.
    const liveHead = run(["git", "-C", dir, "rev-parse", "HEAD"])
    const liveStatus = run(["git", "-C", dir, "status", "--porcelain"])
    if (
      liveHead.exitCode !== 0 ||
      liveHead.stdout.toString().trim() !== currentHead.stdout.toString().trim() ||
      liveStatus.exitCode !== 0 ||
      liveStatus.stdout.toString().trim()
    ) {
      throw new Error("update aborted: the live checkout changed while it was being updated")
    }

    const sanitizedOrigin = run([
      "git",
      "-C",
      dir,
      "config",
      "--replace-all",
      "remote.origin.url",
      canonical,
    ])
    if (sanitizedOrigin.exitCode !== 0) {
      throw new Error(commandFailure("could not sanitize the live origin", sanitizedOrigin))
    }
    run(["git", "-C", dir, "config", "--unset-all", "remote.origin.pushurl"])
    const remainingPushUrl = run([
      "git",
      "-C",
      dir,
      "config",
      "--get-all",
      "remote.origin.pushurl",
    ])
    if (remainingPushUrl.stdout.toString().trim()) {
      throw new Error("could not remove credentials from the live origin")
    }

    const previous = `${dir}.previous`
    if (existsSync(previous) && !existsSync(join(previous, ".git"))) {
      throw new Error("refusing to replace a non-clco rollback directory")
    }
    await rm(previous, { recursive: true, force: true })
    await rename(dir, previous)
    try {
      await rename(stage, dir)
    } catch (err) {
      await rename(previous, dir)
      throw err
    }

    // Refresh the launcher too. It used to be baked once by install.sh, so an
    // existing install never picked up launcher changes no matter how often it
    // updated. A launcher failure is non-fatal because it still points at the
    // same app directory.
    const launcher = run([
      "bash",
      join(dir, "scripts", "write-launcher.sh"),
      dir,
      binDir,
      bunCommand,
    ])
    if (launcher.exitCode === 0) {
      console.error(`... launcher updated: ${join(binDir, "clco")}`)
    } else {
      console.error(
        `! launcher update failed - re-run install.sh (${output(launcher) || "unknown error"})`,
      )
    }
    const head = run(["git", "-C", dir, "rev-parse", "--short", "HEAD"])
    console.error(`+ updated (${head.stdout.toString().trim()}) - applies from the next run`)
  } finally {
    await rm(stageRoot, { recursive: true, force: true })
  }
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

export function npmUpdateMessage(): string {
  return "This clco installation came from npm. Update it with `npm install --global @semanticist14/clco@latest`."
}

async function runUpdate(): Promise<void> {
  if (process.env.CLCO_NPM_INSTALL === "1") {
    throw new Error(npmUpdateMessage())
  }
  const dir = appDir()
  if (!dir) {
    throw new Error(
      "no installation to update (need an install directory or git repo)",
    )
  }
  await updateInstall(
    dir,
    process.env.CLCO_BIN_DIR ?? join(homedir(), ".local", "bin"),
    CANONICAL_REPOSITORY,
    process.env.CLCO_BUN_BIN ?? process.execPath,
  )
}

// Show what this account can actually reach: which models are enabled, which
// dialect each one routes through, and their declared effort/context limits.
async function runStatus(): Promise<void> {
  const identity = await ensureGithubToken()
  // The stored token may predate login capture. Ask GitHub once, remember the
  // answer, and say plainly why it is missing when the lookup is refused —
  // corporate policy blocks personal-account API calls on some networks.
  let login = identity.login
  let lookupNote = ""
  if (!login && !isMockMode()) {
    try {
      const res = await copilotFetch(`${GITHUB_API_BASE_URL}/user`, {
        headers: githubRequestHeaders(identity.token),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        login = ((await res.json()) as { login?: string }).login
        if (login) {
          // Cache it so the next run needs no network at all.
          await saveAuth({ github_token: identity.token, login }).catch(() => {})
        }
      } else {
        lookupNote = `lookup refused (HTTP ${res.status})`
      }
    } catch (err) {
      lookupNote = `lookup failed (${err instanceof Error ? err.message : String(err)})`
    }
  }
  console.log(`clco v${VERSION}`)
  console.log(
    `Account: ${login ? `@${login}` : `(signed in${lookupNote ? ` - username ${lookupNote}` : ""})`}`,
  )

  const facts = await copilotTokenFacts().catch(() => ({}) as { sku?: string })
  if (facts.sku) console.log(`Plan: ${facts.sku}`)
  await discoverModels()
  // Populates the model catalog from the installed binary so the /model
  // preview below matches what a real session would offer. Diagnostics must
  // still work without claude present, so a failure is not fatal here.
  await resolveClaude().catch(() => undefined)
  const discoveryNote = takeDiscoverySoftFailure()
  if (discoveryNote) console.error(discoveryNote)
  const models = upstreamModels()
  if (models.length === 0) {
    console.log("Could not fetch the model list (check your network or subscription)")
    return
  }
  const route = (m: (typeof models)[number]) =>
    m.endpoints.includes("/v1/messages")
      ? "native"
      : m.endpoints.includes("/responses")
        ? "responses"
        : "chat"
  // `model_picker_enabled` is not filtered here: GitHub returns false for
  // every model, so honouring it emptied this table (and /model) entirely.
  const picker = buildModelPickerFrom(models)
  const offered = new Map(
    (picker?.options ?? []).map((o) => [normalizeModel(o.model), o] as const),
  )
  console.log(
    `\n${"model".padEnd(26)} ${"shown in /model".padEnd(38)} ${"route".padEnd(10)} ` +
      `${"policy".padEnd(10)} ${"context".padEnd(10)} effort`,
  )
  for (const m of models) {
    const row = offered.get(m.id)
    const shown = row
      ? row.model + (row.behavesAs ? ` (→${row.behavesAs})` : "")
      : "-"
    const ctx = m.maxPromptTokens ?? m.maxContextTokens
    console.log(
      `${m.id.padEnd(26)} ${shown.padEnd(38)} ${route(m).padEnd(10)} ` +
        `${(m.policyState ?? "?").padEnd(10)} ` +
        `${String(ctx ?? "?").padEnd(10)} ${m.efforts ? m.efforts.join(",") : "-"}`,
    )
  }
  console.log(
    `\n${picker?.options.length ?? 0} rows in /model, ${models.length} models upstream`,
  )
  await reportClaudeInstallNotes()
  console.log(
    "\nQuota is only known at request time - Copilot has no API to check it\n" +
      "up front. When it runs out you get a 402 with the details.",
  )
}

// Things in the user's own claude install that change what clco's lineup
// does, plus leftovers older clco versions wrote there.
// Claude Code gates the Chrome extension on the OAuth scope of the session:
// "[Claude in Chrome] Disabled: OAuth token has no scope accepted by
// /api/oauth/validate (needs user:profile, user:office, or user:ccr_inference;
// env-var and setup-token sessions default to user:inference only)". clco
// authenticates with ANTHROPIC_AUTH_TOKEN against its own adapter, so it is
// always an env-var session and the browser tools are never registered —
// measured: mcp__claude-in-chrome__* appears in zero requests. clco therefore
// never passes --chrome itself; this only catches someone passing it by hand.
// A terminal submits a text prompt at the first newline, so pasting anything
// with a trailing line break loses the rest — and the leftover runs as shell
// input. Reading stdin sidesteps that entirely: `pbpaste | clco token`.
async function runToken(clear = false): Promise<void> {
  const prefs = await loadPrefs()
  if (!prefs.setup) {
    throw new Error("Run `clco setup` first, then store the token.")
  }
  if (clear) {
    await savePrefs({ ...prefs, setup: { ...prefs.setup, browserToken: undefined } })
    console.log("+ token cleared (sessions show the connect dialog)")
    return
  }
  // Reading stdin on a terminal waits forever, and this is the command the
  // setup outro tells people to run.
  if (process.stdin.isTTY) {
    throw new Error(
      "usage: pbpaste | clco token   (or `clco token --clear` to remove it)",
    )
  }
  const parsed = parseToken(await new Response(Bun.stdin.stream()).text())
  if (parsed === null) {
    throw new Error(
      "That does not look like the token - it is a long string of letters, digits, - and _.",
    )
  }
  // An empty pipe is an accident, not a request to delete a working token.
  if (parsed === undefined) {
    throw new Error(
      "nothing on stdin - to remove a stored token, run `clco token --clear`",
    )
  }
  await savePrefs({ ...prefs, setup: { ...prefs.setup, browserToken: parsed } })
  console.log("+ token stored")
}

async function reportBrowserNotes(): Promise<void> {
  if (process.argv.includes("--chrome")) {
    console.log(
      "\nNote: --chrome cannot work here - the Claude Chrome extension needs a\n" +
        "  claude.ai login, and clco is always an env-var session.",
    )
  }
  const prefs = await loadPrefs().catch(() => ({}) as Awaited<ReturnType<typeof loadPrefs>>)
  if (prefs.setup?.browser) {
    console.log(
      "\n" + extensionHint(await extensionInstalled(), prefs.setup?.browserToken),
    )
  }
}

/** Matches LAUNCHER_VERSION in scripts/write-launcher.sh. */
const LAUNCHER_VERSION = 4

function reportStaleLauncher(): void {
  // CLCO_APP_DIR is set by every launcher; without it clco was started
  // directly (bun run src/cli.ts), where there is no launcher to be stale.
  if (!process.env.CLCO_APP_DIR) return
  const running = Number(process.env.CLCO_LAUNCHER_VERSION ?? "0")
  if (running >= LAUNCHER_VERSION) return
  console.log(
    `\nNote: the clco launcher is out of date (v${running || "?"} < v${LAUNCHER_VERSION}).` +
      " Refresh it with `clco update`, or by re-running install.sh with the same custom paths.",
  )
}

async function reportClaudeInstallNotes(): Promise<void> {
  reportStaleLauncher()
  await reportBrowserNotes()
  const home = homedir()
  const stale = join(home, ".claude", "cache", "gateway-models.json")
  if (await Bun.file(stale).exists()) {
    console.log(
      `\nNote: ${stale} is left over from an older clco - safe to delete.`,
    )
  }
  try {
    const raw = await readFile(join(home, ".claude", "settings.json"), "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Both outrank or filter what --settings injects.
    if (parsed.availableModels) {
      console.log(
        "Warning: availableModels in ~/.claude/settings.json filters clco's /model rows.",
      )
    }
    if (parsed.modelPicker) {
      console.log(
        "Note: ~/.claude/settings.json defines modelPicker - clco's --settings wins outright; the two are not merged.",
      )
    }
  } catch {
    // no settings file, or not strict JSON — nothing to warn about
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (["help", "--help", "-h"].includes(argv[0] ?? "")) {
    console.log(HELP)
    return
  }
  const args = parseArgs(argv)
  // Ask whenever a human is actually there. Print mode (-p) and non-TTY runs
  // must stay unattended, but ordinary flags like --dangerously-skip-permissions
  // or --chrome should not cost you the model choice.
  const printMode = args.claudeArgs.some(
    (a) => a === "-p" || a === "--print" || a.startsWith("--print="),
  )

  if (args.command === "update") {
    await runUpdate()
    return
  }

  if (args.command === "token") {
    await runToken(args.claudeArgs.includes("--clear"))
    return
  }

  if (args.command === "version") {
    console.log(VERSION)
    return
  }

  if (args.command === "setup") {
    await runSetup()
    return
  }

  if (args.command === "status") {
    await runStatus()
    return
  }

  if (args.command === "logout") {
    await clearAuth()
    console.log("+ Signed out - removed ~/.config/clco/auth.json. Sign in again: clco login")
    return
  }

  if (args.command === "auth" || args.command === "login") {
    if (args.port !== undefined) {
      console.error(`[clco] --port is ignored in ${args.command} mode`)
    }
    if (isMockMode()) {
      console.log("Mock mode (CLCO_UPSTREAM) - skipping auth")
      return
    }
    const { token, login } = await runDeviceFlow()
    console.log(
      `+ GitHub authenticated${login ? ` (@${login})` : ""} - saved to ~/.config/clco/auth.json`,
    )
    if (process.env.CLCO_DEBUG) {
      console.error(`[clco:debug] token prefix: ${token.slice(0, 4)}…`)
    }
    return
  }

  if (
    args.claudeArgs.some(
      (a) => a === "--settings" || a.startsWith("--settings="),
    )
  ) {
    throw new Error(
      "--settings is injected by clco; passing your own would overwrite the adapter routing",
    )
  }
  if (args.command === "serve" && args.claudeArgs.length > 0) {
    throw new Error(
      `serve mode takes no claude arguments: ${args.claudeArgs.join(" ")}`,
    )
  }

  // Fail fast, before binding the adapter port. `serve` is adapter-only and
  // never spawns claude, so it must not require the binary.
  if (args.command !== "serve") {
    await resolveClaude()
  }

  if (isMockMode()) {
    console.error(
      `! Mock mode: CLCO_UPSTREAM=${process.env.CLCO_UPSTREAM}\n` +
        `  Every request goes there and GitHub auth is skipped. Unset it for real use.`,
    )
  }

  await step("Checking GitHub token", async () => {
    const identity = await ensureGithubToken()
    if (identity.fresh && !isMockMode()) {
      console.error(
        `  └ newly authenticated: @${identity.login ?? "unknown"} - saved to ~/.config/clco/auth.json`,
      )
    }
  })

  let setup = await loadSetup()
  if (!setup && args.command === "run") {
    if (interactive && !printMode) {
      setup = await runSetup()
    } else {
      // Never block an unattended run on a prompt; everything stays off,
      // which is exactly how clco behaved before setup existed.
      console.error(
        "[clco] No startup defaults yet - run `clco setup` to set them.",
      )
    }
  }

  const models = await step("Fetching Copilot token and model list", () =>
    discoverModels(),
  )
  // Printed here, not inside discoverModels: step() runs a spinner that would
  // paint over anything written while it is active.
  const discoveryNote = takeDiscoverySoftFailure()
  if (discoveryNote) console.error(discoveryNote)
  const list = upstreamModels()

  let defaultModel: string | undefined
  const prefs = await loadPrefs()
  // Offer exactly what /model will: the raw upstream list also carries
  // embeddings and Copilot's internal plumbing, which cannot hold a
  // conversation at all, and repeats display names across several slugs.
  const pickerRows = buildModelPickerFrom(list)?.options ?? []
  const offered = pickerRows.map((o) => normalizeModel(o.model))
  // A remembered model the current account no longer offers would preselect a
  // row that is not there.
  const remembered =
    prefs.last_model && offered.includes(prefs.last_model)
      ? prefs.last_model
      : undefined
  if (
    args.command === "run" &&
    !printMode &&
    interactive &&
    !process.env.CLCO_NO_SELECT &&
    shouldSelectModel(setup, args.overrides) &&
    list.length > 0
  ) {
    const rows = pickerRows
    const last = remembered
    const selected = await p.autocomplete({
      message: "Pick a model - type to search",
      placeholder: "Search models...",
      initialValue: last,
      maxItems: 12,
      options: rows.map((o) => {
        const id = normalizeModel(o.model)
        return {
          value: id,
          label: o.label ?? id,
          hint: id === last ? `${o.description} · last used` : o.description,
        }
      }),
    })
    if (p.isCancel(selected)) {
      p.cancel("Cancelled")
      process.exit(0)
    }
    defaultModel = selected as string
    try {
      await savePrefs({ last_model: defaultModel })
    } catch {
      console.error("[clco] ! could not save the model choice (check permissions on the config directory)")
    }
  } else if (args.command !== "serve") {
    // serve never calls runClaude, so a model resolved here is unreachable -
    // and a live-looking variable on a dead path is a trap for the next reader.
    defaultModel = modelWithoutPrompt(remembered, offered, models.sonnet)
  }

  const server = await startServer({ port: args.port })
  if (args.command === "run") {
    // claude's TUI owns the terminal; adapter request logs must not paint
    // over it. Debug mode appends them to a file instead.
    if (process.env.CLCO_DEBUG) {
      const logDir = join(homedir(), ".config", "clco")
      mkdirSync(logDir, { recursive: true })
      const logPath = join(logDir, "adapter.log")
      setAdapterLogSink((line) => {
        void appendFile(logPath, `${line}\n`).catch(() => {})
      })
      console.error(`+ adapter log: ${logPath}`)
    } else {
      setAdapterLogSink(null)
    }
  }
  console.error(`+ adapter: ${server.url}`)
  // serve never spawns claude, so naming a session model there would advertise
  // a routing decision no process makes. The slot list is still useful to
  // someone pointing their own claude at the adapter.
  const slots = `sonnet=${models.sonnet} opus=${models.opus} haiku=${models.haiku} fable=${models.fable}`
  console.error(
    args.command === "serve"
      ? `+ slots: ${slots}`
      : `+ model: ${defaultModel ?? "(claude default)"} (${slots})`,
  )
  const browserEnabled =
    setup?.browser === true && args.overrides.browser !== false
  const browserExtension = browserEnabled ? await extensionInstalled() : false
  // Computed from the arguments actually produced: clco stands aside when the
  // user passes their own --mcp-config, and claiming success there would be
  // the same trap as registering a server with no extension.
  const injected = setupClaudeArgs(
    setup,
    args.overrides,
    args.claudeArgs,
    browserExtension,
  )
  const registered = injected.includes("--mcp-config")
  const browserLine = startupLine(
    browserEnabled,
    browserExtension,
    setup?.browserToken,
    undefined,
    // Only worth asking when everything else is in place - and only about the
    // default spec, since the probe hits registry.npmjs.org and can say
    // nothing true about an internal mirror named by CLCO_MCP_PACKAGE.
    browserExtension && registered && probesDefaultRegistry()
      ? await registryStatus()
      : undefined,
    browserEnabled && browserExtension ? registered : undefined,
  )
  if (browserLine) console.error(browserLine)

  if (args.command === "serve") {
    console.error("Adapter running... (Ctrl+C to stop)")
    await new Promise<never>(() => {})
  }

  const code = await runClaude({
    baseUrl: server.url,
    models,
    defaultModel,
    claudeArgs: [...injected, ...args.claudeArgs],
    extraEnv: setupEnv(setup, args.overrides),
  })
  server.stop()
  process.exit(code)
}

// Only run when invoked as the CLI — tests import parseArgs from here.
if (import.meta.main) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(
      `Error: ${message}${isTlsTrustError(err) ? tlsHint() : ""}`,
    )
    process.exit(1)
  })
}
