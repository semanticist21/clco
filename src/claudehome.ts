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

import { readFile, readdir, rm, symlink, writeFile, mkdir, lstat, copyFile } from "node:fs/promises"
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
  let entries: string[]
  try {
    entries = await readdir(real)
  } catch {
    return null
  }
  try {
    await mkdir(home, { recursive: true, mode: 0o700 })
  } catch {
    return null
  }

  for (const name of entries) {
    if (PRIVATE_ENTRIES.has(name)) continue
    const link = join(home, name)
    const target = join(real, name)
    try {
      const existing = await lstat(link).catch(() => null)
      if (existing?.isSymbolicLink()) continue
      // A real file here would be a leftover from an older layout; the shared
      // original is authoritative.
      if (existing) await rm(link, { recursive: true, force: true })
      await symlink(target, link)
    } catch {
      // One unlinkable entry should not sink the session.
    }
  }

  // Seed the settings claude will read, minus the one key it writes back —
  // otherwise a slug left over from an earlier session would seed the next.
  try {
    const raw = await readFile(join(real, "settings.json"), "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    delete parsed.model
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify(parsed, null, 2) + "\n",
      { mode: 0o600 },
    )
  } catch {
    // No settings, or not strict JSON (claude tolerates JSONC). Copy it
    // verbatim rather than dropping the user's configuration entirely.
    await copyFile(
      join(real, "settings.json"),
      join(home, "settings.json"),
    ).catch(() => {})
  }

  // Trust decisions, MCP servers and project history live here. Seeded once so
  // the first clco session inherits them, then left alone: from that point it
  // is clco's own state and must not be overwritten from the user's copy.
  const stateFile = join(home, ".claude.json")
  if (!(await lstat(stateFile).catch(() => null))) {
    await copyFile(join(userHome, ".claude.json"), stateFile).catch(() => {})
  }

  return home
}
