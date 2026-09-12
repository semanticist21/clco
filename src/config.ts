// Durable auth storage: ~/.config/clco/auth.json (mode 600).
// Writes go through a temp file + rename so a crash or a pre-existing
// symlink/permission can never leave the token readable or half-written.

import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AuthStore {
  github_token: string
  login?: string
}

// Overridable so tests can exercise the real read/merge/write path without
// writing into the user's live install.
let configDir: string | null = null

export function setConfigDir(dir: string | null): void {
  configDir = dir
}

function authDir(): string {
  return configDir ?? join(homedir(), ".config", "clco")
}

function authPath(): string {
  return join(authDir(), "auth.json")
}

// One-time migration from the pre-rename config directory.
let migrated = false
async function migrateFromClcopilot(): Promise<void> {
  if (migrated) return
  migrated = true
  const legacyDir = join(homedir(), ".config", "clcopilot")
  await mkdir(authDir(), { recursive: true, mode: 0o700 }).catch(() => {})
  await chmod(authDir(), 0o700).catch(() => {})
  for (const name of ["auth.json", "prefs.json"]) {
    const target = join(authDir(), name)
    try {
      await readFile(target, "utf8")
      continue // already present in the new location
    } catch {
      // not migrated yet
    }
    try {
      const data = await readFile(join(legacyDir, name), "utf8")
      await writeFile(target, data, { mode: 0o600 })
    } catch {
      // nothing to migrate
    }
  }
}

export async function loadAuth(): Promise<AuthStore | null> {
  await migrateFromClcopilot()
  try {
    return JSON.parse(await readFile(authPath(), "utf8")) as AuthStore
  } catch {
    return null
  }
}

export async function saveAuth(auth: AuthStore): Promise<void> {
  await mkdir(authDir(), { recursive: true })
  await chmod(authDir(), 0o700).catch(() => {})
  const tmp = join(authDir(), `.auth.${process.pid}.tmp`)
  const handle = await openExclusive(tmp)
  try {
    await handle.writeFile(JSON.stringify(auth, null, 2) + "\n")
    await handle.close()
    await rename(tmp, authPath())
    await chmod(authPath(), 0o600).catch(() => {})
  } catch (err) {
    await handle.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw err
  }
}

// "wx": fail if the temp file already exists (never truncate through a
// symlink); creation mode 0600.
async function openExclusive(path: string) {
  const { open } = await import("node:fs/promises")
  return open(path, "wx", 0o600)
}

/** Startup options answered once, changed with `clco setup`. */
export interface SetupPrefs {
  version: number
  bypass: boolean
  select: boolean
  /** Register the Playwright MCP server for clco sessions. Added in v2. */
  browser?: boolean
  /**
   * Playwright MCP's extension token. Skips the connect dialog every session.
   * Kept here because prefs.json is already written 0600, alongside no other
   * secret — the GitHub token lives in auth.json.
   */
  browserToken?: string
}

export interface Prefs {
  last_model?: string
  setup?: SetupPrefs
}

function prefsPath(): string {
  return join(authDir(), "prefs.json")
}

export async function loadPrefs(): Promise<Prefs> {
  await migrateFromClcopilot()
  try {
    return JSON.parse(await readFile(prefsPath(), "utf8")) as Prefs
  } catch {
    return {}
  }
}

/**
 * Merge into the stored preferences.
 *
 * Every caller holds one concern — the model prompt writes `last_model`, setup
 * writes `setup` — and a plain write let whichever ran last erase the other.
 * Picking a model really did discard the setup answers.
 */
async function writeSecret(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`
  await rm(tmp, { force: true }).catch(() => {})
  const handle = await openExclusive(tmp)
  try {
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
  await chmod(tmp, 0o600).catch(() => {})
  await rename(tmp, path)
}

export async function savePrefs(prefs: Prefs): Promise<void> {
  await migrateFromClcopilot()
  await mkdir(authDir(), { recursive: true })
  const merged = { ...(await loadPrefs()), ...prefs }
  // prefs now holds the Playwright extension token, so it gets the same
  // treatment as auth.json: exclusive create, explicit mode, atomic rename.
  // A plain write leaves an existing 0644 file at 0644 and can truncate.
  await writeSecret(prefsPath(), JSON.stringify(merged, null, 2) + "\n")
}

export async function clearAuth(): Promise<void> {
  // Also remove the legacy copy — otherwise migrateFromClcopilot resurrects
  // the old token on the next run (logout would be a no-op).
  await rm(authPath()).catch(() => {})
  await rm(join(homedir(), ".config", "clcopilot", "auth.json")).catch(() => {})
}
