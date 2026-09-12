// One-time startup preferences, so the flags you always pass don't have to be
// typed every run. Asked once on the first interactive launch, changed later
// with `clco setup`, and overridable per run with the --no-* flags.

import * as p from "@clack/prompts"
import {
  TOKEN_ENV,
  browserMcpConfig,
  extensionHint,
  extensionInstalled,
} from "./browsermcp"
import { loadPrefs, savePrefs, type SetupPrefs } from "./config"

/** Bump when an option is added, so existing users get told once. */
export const SETUP_VERSION = 2

export interface SetupOverrides {
  bypass?: boolean
  select?: boolean
  browser?: boolean
}

// What the first-run prompts come pre-filled with: these are the options
// people install clco for, so Enter-through should land on the useful setup.
// A future option added to an EXISTING setup is absent from the stored
// object, i.e. off, which is the conservative direction for a change nobody
// asked for.
export const SETUP_DEFAULTS: Omit<SetupPrefs, "version"> = {
  bypass: true,
  select: true,
  browser: true,
}

export async function runSetup(): Promise<SetupPrefs> {
  const prefs = await loadPrefs()
  const current = prefs.setup ?? { ...SETUP_DEFAULTS, version: SETUP_VERSION }

  p.intro("clco setup - save the flags you would otherwise type every run")
  const ask = async (message: string, initialValue: boolean): Promise<boolean> => {
    const answer = await p.confirm({ message, initialValue })
    if (p.isCancel(answer)) {
      p.cancel("Cancelled - keeping the previous settings")
      process.exit(0)
    }
    return answer as boolean
  }

  const setup: SetupPrefs = {
    version: SETUP_VERSION,
    bypass: await ask(
      "Run without permission prompts? (--dangerously-skip-permissions)",
      current.bypass,
    ),
    // Claude's own Chrome integration cannot work here, so there is nothing to
    // ask about it — only an alternative to offer.
    browser: await ask(
      "Claude Chrome is not available in clco.\n" +
        "  Enable Playwright MCP for browser control instead?",
      current.browser ?? true,
    ),
    select: await ask("Pick a model each time clco starts?", current.select),
  }

  if (setup.browser) {
    const installed = await extensionInstalled()
    if (installed) {
      // Offered rather than required: without it the session still attaches,
      // just with a click each time.
      const token = await p.text({
        message:
          `${TOKEN_ENV} (optional) - the extension shows one; storing it\n` +
          "  skips the connect dialog every session. Enter to skip.",
        placeholder: "leave empty to skip",
        defaultValue: current.browserToken ?? "",
      })
      if (!p.isCancel(token)) {
        const trimmed = String(token).trim()
        if (trimmed) setup.browserToken = trimmed
      }
    }
    // Registering the server is only half an install; the extension is the
    // half only the user can add.
    p.note(extensionHint(installed, setup.browserToken), "Playwright MCP")
  }

  await savePrefs({ ...prefs, setup })
  p.outro(
    "Saved. Re-run `clco setup` to change it, or turn one off for a single\n" +
      "run with --no-bypass / --no-select / --no-browser.",
  )
  return setup
}

/**
 * The saved setup, or null when it has never been run. Also reports a version
 * bump once: a new option defaults to off, and saying so beats leaving it
 * undiscovered — but nagging on every launch afterwards does not.
 */
export async function loadSetup(): Promise<SetupPrefs | null> {
  const prefs = await loadPrefs()
  if (!prefs.setup) return null
  if (prefs.setup.version < SETUP_VERSION) {
    console.error(
      "[clco] New setup options are available (off by default) - run `clco setup` to enable them",
    )
    // Record that the notice was shown; the options themselves stay off.
    await savePrefs({
      ...prefs,
      setup: { ...prefs.setup, version: SETUP_VERSION },
    }).catch(() => {})
  }
  return prefs.setup
}

/**
 * Claude flags implied by the saved setup, minus anything the user already
 * passed by hand or turned off for this run. Passing a flag twice is not
 * harmless for every claude flag, so each is added only when absent.
 */
export function setupClaudeArgs(
  setup: SetupPrefs | null,
  overrides: SetupOverrides,
  claudeArgs: string[],
  /** Whether the Playwright MCP Bridge extension is installed. */
  browserExtension = false,
): string[] {
  if (!setup) return []
  const has = (flag: string) => claudeArgs.some((a) => a === flag)
  const out: string[] = []
  if (
    setup.bypass &&
    overrides.bypass !== false &&
    !has("--dangerously-skip-permissions")
  ) {
    out.push("--dangerously-skip-permissions")
  }
  // Registered per session rather than written into the user's MCP config, so
  // clco never edits configuration that outlives it.
  if (
    setup.browser &&
    overrides.browser !== false &&
    !claudeArgs.includes("--mcp-config")
  ) {
    const config = browserMcpConfig(browserExtension)
    if (config) out.push("--mcp-config", config)
  }
  return out
}

/** Whether to show the startup model picker for this run. */
/** Environment the saved setup implies for the claude child. */
export function setupEnv(
  setup: SetupPrefs | null,
  overrides: SetupOverrides,
): Record<string, string> {
  if (!setup?.browserToken || overrides.browser === false) return {}
  // An exported value wins: it is the more immediate intent.
  if (process.env[TOKEN_ENV]) return {}
  return { [TOKEN_ENV]: setup.browserToken }
}

export function shouldSelectModel(
  setup: SetupPrefs | null,
  overrides: SetupOverrides,
): boolean {
  if (overrides.select === false) return false
  // Before setup runs, keep the long-standing behaviour of asking.
  return setup === null ? true : setup.select
}
