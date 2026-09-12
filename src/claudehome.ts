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
async function writeSettings(real: string, home: string): Promise<void> {
  const target = join(home, "settings.json")
  let source: string | null = null
  try {
    source = await readFile(join(real, "settings.json"), "utf8")
  } catch {
    // No global settings: keep what is already private, minus `model`.
  }
  const existing = await readFile(target, "utf8").catch(() => null)
  const raw = source ?? existing
  if (raw === null) return
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    delete parsed.model
    await atomicWrite(target, JSON.stringify(parsed, null, 2) + "\n")
  } catch {
    // claude tolerates comments where JSON.parse does not, so keep the file
    // and strip only the key that must not carry over.
    await atomicWrite(
      target,
      raw.replace(/^\s*"model"\s*:\s*("(?:[^"\\]|\\.)*"|null)\s*,?\s*$/gm, ""),
    )
  }
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
      }
      if (existing) await rm(link, { recursive: true, force: true })
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

  // Trust decisions, MCP servers and project history live here. Seeded once so
  // the first clco session inherits them, then left alone: from that point it
  // is clco's own state and must not be overwritten from the user's copy.
  const stateFile = join(home, ".claude.json")
  if (!(await lstat(stateFile).catch(() => null))) {
    await copyFile(join(userHome, ".claude.json"), stateFile).catch(() => {})
  }

  return home
}
