// A private CLAUDE_CONFIG_DIR for clco sessions.
//
// Claude Code persists a /model pick into its config dir ("saved as your
// default for new sessions"). Pointed at the user's own ~/.claude that leaks
// a Copilot slug into plain `claude` runs, and undoing it afterwards cannot
// be made correct: the value is wrong for as long as the session runs, so a
// second claude started meanwhile still reads it, and an abrupt exit leaves
// it behind for the next run to mistake for the user's real setting.
//
// So give claude somewhere else to write. Everything that shapes behaviour is
// symlinked from the real ~/.claude, so plugins, skills, agents and commands
// stay live and shared; only the files claude writes are private. This is the
// same split Anthropic's own self-hosted runner makes when it seeds a config
// dir ("settings, agents/, skills/, …; runtime state excluded").

import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { isDeepStrictEqual } from "node:util"
import { join } from "node:path"

/** Written by claude during a session — must stay private to clco. */
const PRIVATE_ENTRIES = new Set([
  // Holds the model default a /model pick writes.
  "settings.json",
  // Local/managed overlays sit next to it; keep the whole family private so a
  // write never lands in the user's tree.
  "settings.local.json",
  "backups",
])

/**
 * Keep claude's settings private, without letting a Copilot slug survive in
 * them. Three cases the previous version got wrong: a missing ~/.claude
 * settings.json left the private copy (and its stale `model`) untouched; a
 * JSONC one was copied verbatim, `model` and all; and rewriting from the
 * user's file every launch discarded whatever claude had persisted in the
 * private one.
 */

/**
 * clco owns routing and auth: ANTHROPIC_BASE_URL and the bearer travel in
 * the --settings tier. A provider env block in the user's own settings.json
 * (e.g. z.ai's ANTHROPIC_AUTH_TOKEN) must not survive the copy: claude
 * applies settings-file env over the child environment, so a surviving
 * token would override clco's and every request would 401 against the
 * adapter. ANTHROPIC_MODEL is stripped too: clco pins the session model
 * itself, and a surviving pin makes every /model switch cosmetic.
 */
const ROUTING_ENV = /^ANTHROPIC_(AUTH_TOKEN|API_KEY|BASE_URL|MODEL)$/
function stripRoutingEnv(parsed: Record<string, unknown>): void {
  const env = parsed.env as Record<string, unknown> | undefined
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const key of Object.keys(env)) if (ROUTING_ENV.test(key)) delete env[key]
  }
}

// Claude's built-in WebSearch executes server-side on Anthropic's API and can
// never work through the adapter. Denying it in the private copy keeps the
// model from calling a tool that always no-ops and steering it toward the
// clco_web search tool instead. The user's own file is never touched.
function denyServerWebSearch(parsed: Record<string, unknown>): void {
  const permissions = (parsed.permissions ?? {}) as Record<string, unknown>
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : []
  if (!deny.includes("WebSearch")) deny.push("WebSearch")
  permissions.deny = deny
  parsed.permissions = permissions
}

// What clco last derived from the user's settings.json. A three-way merge
// against it tells the keys claude persisted during a clco session (kept)
// from the ones the user changed in their own file since (taken).
const SETTINGS_BASE = ".clco-settings-base.json"

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Objects merge key by key, lists element by element; on a scalar clash clco's side wins. */
export function merge3(base: unknown, mine: unknown, theirs: unknown): unknown {
  if (isPlainObject(mine) && isPlainObject(theirs)) {
    const b = isPlainObject(base) ? base : {}
    const out: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const v = merge3(b[key], mine[key], theirs[key])
      if (v !== undefined) out[key] = v
    }
    return out
  }
  if (isDeepStrictEqual(mine, base)) return theirs
  if (isDeepStrictEqual(theirs, base)) return mine
  if (Array.isArray(mine) && Array.isArray(theirs) && Array.isArray(base)) {
    // Both edited a list (permissions.allow, hooks): keep each side's
    // additions and removals rather than one side's whole list.
    const has = (list: unknown[], x: unknown) => list.some((y) => isDeepStrictEqual(x, y))
    return [
      ...theirs.filter((x) => !has(base, x) || has(mine, x)),
      ...mine.filter((x) => !has(base, x) && !has(theirs, x)),
    ]
  }
  return mine
}

function parseSettings(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    // claude tolerates comments where JSON.parse does not. A line-based regex
    // was worse than useless here: deleting the last key's line left a
    // dangling comma and broke the file outright, it reached "model" keys
    // nested in other objects, and it missed the key when it shared a line.
    // Strip comments, parse, and re-emit — losing the comments is a smaller
    // loss than losing the settings.
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>
  }
}

function sanitizeSettings(parsed: Record<string, unknown>): Record<string, unknown> {
  delete parsed.model
  stripRoutingEnv(parsed)
  denyServerWebSearch(parsed)
  return parsed
}

async function writeSettings(real: string, home: string): Promise<void> {
  const target = join(home, "settings.json")
  const basePath = join(home, SETTINGS_BASE)
  const source = await readFile(join(real, "settings.json"), "utf8").catch(
    () => null,
  )
  const existing = await readFile(target, "utf8").catch(() => null)
  if (source === null && existing === null) return
  let theirs: Record<string, unknown>
  try {
    theirs = sanitizeSettings(parseSettings(source ?? existing!))
  } catch (err) {
    // Neither form parses: keep the previous private file rather than
    // replace it with something broken, and say so - a stale `model` here
    // is exactly what this function exists to prevent.
    const first = existing === null
    console.error(
      `[clco] could not parse ${join(real, "settings.json")} (${(err as Error).message}) - ` +
        (first
          ? "this session starts with NO settings: no env, no hooks, no permissions."
          : "clco's copy was left as it was."),
    )
    return
  }
  let merged = theirs
  if (source !== null && existing !== null) {
    try {
      const mine = parseSettings(existing)
      const baseRaw = await readFile(basePath, "utf8").catch(() => null)
      // No snapshot (first launch on this version): earlier versions rebuilt
      // the private copy from the user's file every launch, so let it win.
      const base = baseRaw === null ? mine : JSON.parse(baseRaw)
      merged = sanitizeSettings(merge3(base, mine, theirs) as Record<string, unknown>)
    } catch {
      // An unreadable private copy has nothing worth keeping.
    }
  }
  await atomicWrite(target, JSON.stringify(merged, null, 2) + "\n")
  // A briefly missing user file keeps the old snapshot for when it returns.
  if (source !== null) await atomicWrite(basePath, JSON.stringify(theirs, null, 2) + "\n")
}

/** Comments only — string contents are left alone. */
function stripJsonComments(input: string): string {
  let out = ""
  let inString = false
  let escaped = false
  // Positions in `out` of commas that sit outside any string.
  const commaIndices = new Set<number>()
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === ",") commaIndices.add(out.length)
    if (c === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && input[i + 1] === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  // Trailing commas are legal in JSONC and fatal to JSON.parse — but removing
  // them with a regex over the whole document ate commas inside string values
  // (a permission rule like "Bash(awk '{print $1,}')" lost one). Only drop a
  // comma the scanner emitted outside a string.
  let result = ""
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!
    if (c === "," && commaIndices.has(i)) {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j]!)) j++
      if (out[j] === "}" || out[j] === "]") continue
    }
    result += c
  }
  return result
}

// A second clco launch refreshes this file while the first session may be
// reading it; config.ts already writes auth.json this way.
async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`
  try {
    await writeFile(tmp, data, { mode: 0o600 })
    await rename(tmp, path)
  } catch {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

const PROJECT_MCP_KEYS = [
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "enableAllProjectMcpServers",
]
// The real file's per-project MCP keys as last synced. Plain claude writes
// empty defaults for every project, so "absent/empty there" cannot mean
// "removed": only a change since this snapshot propagates.
const CLAUDE_JSON_BASE = ".clco-claude-json-base.json"

function projectMcp(json: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [path, entry] of Object.entries((json.projects ?? {}) as Record<string, Record<string, unknown>>)) {
    const keys: Record<string, unknown> = {}
    for (const key of PROJECT_MCP_KEYS) if (entry?.[key] !== undefined) keys[key] = entry[key]
    out[path] = keys
  }
  return out
}

/**
 * `.claude.json` carries trust decisions, MCP server definitions (with their
 * env secrets) and project history. Seeded once so the first session inherits
 * it — but the security-relevant halves are re-synced every launch, because a
 * copy frozen at first run means deleting a compromised MCP server, or
 * withdrawing trust from a project, silently does not apply to clco sessions.
 * Everything else stays clco's own.
 */
async function syncClaudeState(userHome: string, home: string): Promise<void> {
  const target = join(home, ".claude.json")
  const basePath = join(home, CLAUDE_JSON_BASE)
  const source = await readFile(join(userHome, ".claude.json"), "utf8").catch(
    () => null,
  )
  if (source === null) return
  const existing = await readFile(target, "utf8").catch(() => null)
  try {
    const real = JSON.parse(source) as Record<string, unknown>
    if (existing === null) {
      await copyFile(join(userHome, ".claude.json"), target)
    } else {
      const mine = JSON.parse(existing) as Record<string, unknown>
      mine.mcpServers = real.mcpServers
      const realProjects = (real.projects ?? {}) as Record<string, Record<string, unknown>>
      const myProjects = (mine.projects ?? {}) as Record<string, Record<string, unknown>>
      const baseRaw = await readFile(basePath, "utf8").catch(() => null)
      // No snapshot (first launch on this version): earlier versions never
      // synced these keys, so keep what clco has until the real file changes.
      const base = baseRaw === null ? projectMcp(real) : JSON.parse(baseRaw)
      if (Object.keys(realProjects).length > 0) mine.projects = myProjects
      for (const [path, theirs] of Object.entries(realProjects)) {
        const entry = (myProjects[path] ??= {})
        // Local-scope MCP servers (the `claude mcp add` default) and the
        // .mcp.json approvals live per project; a removal must reach clco.
        for (const key of PROJECT_MCP_KEYS) {
          const v = merge3(base[path]?.[key], entry[key], theirs[key])
          if (v === undefined) delete entry[key]
          else entry[key] = v
        }
        // Absent means "no opinion", not "withdrawn". clco sessions run against
        // the private config dir, so a project only ever used through clco is
        // never recorded in the real file at all — forcing false there re-asked
        // the trust question on every single launch.
        if (theirs.hasTrustDialogAccepted !== undefined) {
          entry.hasTrustDialogAccepted = theirs.hasTrustDialogAccepted
        }
      }
      await atomicWrite(target, JSON.stringify(mine, null, 2) + "\n")
    }
    await atomicWrite(basePath, JSON.stringify(projectMcp(real)) + "\n")
  } catch {
    // Unparseable on either side: leave what is there rather than lose it.
  }
}

export function claudeHome(home = homedir()): string {
  return join(home, ".config", "clco", "claude-home")
}

/**
 * Build (or refresh) the private config dir and return it.
 *
 * Symlinks are refreshed every launch so entries the user adds to ~/.claude
 * show up without any cache to invalidate. Returns null when the real config
 * dir cannot be read, so the caller can fall back to the shared one.
 */
export async function prepareClaudeHome(
  /** Overridden in tests; os.homedir() ignores $HOME on macOS. */
  userHome = homedir(),
): Promise<string | null> {
  const real = join(userHome, ".claude")
  const home = claudeHome(userHome)
  // A missing ~/.claude is no reason to skip isolation - the private dir works
  // fine empty. Only a real read failure is a problem, and returning null then
  // hands the child the user's own config dir, where a /model pick persists.
  // That must never happen quietly.
  let entries: string[]
  try {
    entries = await readdir(real)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `[clco] cannot read ${real} (${(err as Error).message}) - refusing to run` +
          " against your own claude config, where a /model pick would persist.",
      )
      throw err
    }
    entries = []
  }
  try {
    await mkdir(home, { recursive: true, mode: 0o700 })
  } catch (err) {
    console.error(
      `[clco] cannot create ${home} (${(err as Error).message}) - refusing to run` +
        " against your own claude config, where a /model pick would persist.",
    )
    throw err
  }

  for (const name of entries) {
    if (PRIVATE_ENTRIES.has(name)) continue
    const link = join(home, name)
    const target = join(real, name)
    try {
      const existing = await lstat(link).catch(() => null)
      if (existing?.isSymbolicLink()) {
        // Trusting an existing link without checking left ones pointing at a
        // previous $HOME pointing there forever.
        if ((await readlink(link).catch(() => null)) === target) continue
        await rm(link, { force: true })
        await symlink(target, link)
        continue
      }
      if (existing) {
        // A real entry means claude created it here before ~/.claude had one
        // (clco used before plain claude). Folding it in automatically races
        // running sessions and concurrent launches, so leave it and say so.
        console.error(
          `[clco] ${link} is clco's own copy, so ~/.claude/${name} is not shared yet.` +
            ` Merge it into ${target} and delete it to share.`,
        )
        continue
      }
      await symlink(target, link)
    } catch {
      // One unlinkable entry should not sink the session.
    }
  }

  // Reap links whose source is gone: the loop above only visits what exists
  // now, so a deleted entry otherwise dangles here forever.
  const live = new Set(entries)
  for (const name of await readdir(home).catch(() => [])) {
    if (PRIVATE_ENTRIES.has(name) || live.has(name) || name === ".claude.json") {
      continue
    }
    const link = join(home, name)
    const stat = await lstat(link).catch(() => null)
    if (stat?.isSymbolicLink()) await rm(link, { force: true }).catch(() => {})
  }

  await writeSettings(real, home)

  await syncClaudeState(userHome, home)

  return home
}
