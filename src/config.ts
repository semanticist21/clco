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

function authDir(): string {
  return join(homedir(), ".config", "clco")
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
  chrome: boolean
  select: boolean
  /** Register the Browser MCP server for clco sessions. Added in v2. */
  browser?: boolean
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

export async function savePrefs(prefs: Prefs): Promise<void> {
  await migrateFromClcopilot()
  await mkdir(authDir(), { recursive: true })
  await writeFile(prefsPath(), JSON.stringify(prefs, null, 2) + "\n", {
    mode: 0o600,
  })
}

export async function clearAuth(): Promise<void> {
  // Also remove the legacy copy — otherwise migrateFromClcopilot resurrects
  // the old token on the next run (logout would be a no-op).
  await rm(authPath()).catch(() => {})
  await rm(join(homedir(), ".config", "clcopilot", "auth.json")).catch(() => {})
}
