// One-time startup preferences, so the flags you always pass don't have to be
// typed every run. Asked once on the first interactive launch, changed later
// with `clco setup`, and overridable per run with the --no-* flags.

import * as p from "@clack/prompts"
import { loadPrefs, savePrefs, type SetupPrefs } from "./config"

/** Bump when an option is added, so existing users get told once. */
export const SETUP_VERSION = 1

export interface SetupOverrides {
  bypass?: boolean
  chrome?: boolean
  select?: boolean
}

// What the first-run prompts come pre-filled with: these are the options
// people install clco for, so Enter-through should land on the useful setup.
// A future option added to an EXISTING setup is absent from the stored
// object, i.e. off, which is the conservative direction for a change nobody
// asked for.
export const DEFAULTS_FOR_TESTS: Omit<SetupPrefs, "version"> = {
  bypass: true,
  chrome: true,
  select: true,
}

export async function runSetup(): Promise<SetupPrefs> {
  const prefs = await loadPrefs()
  const current = prefs.setup ?? { ...DEFAULTS_FOR_TESTS, version: SETUP_VERSION }

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
    chrome: await ask(
      "Pass --chrome? (the extension needs a claude.ai login, so it stays\n" +
      "  disabled on a Copilot backend - a browser MCP server works instead)",
      current.chrome,
    ),
    select: await ask("Pick a model each time clco starts?", current.select),
  }

  await savePrefs({ ...prefs, setup })
  p.outro("Saved. Change it with `clco setup`; turn one off for a single run with --no-bypass / --no-chrome / --no-select")
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
  if (setup.chrome && overrides.chrome !== false && !has("--chrome")) {
    out.push("--chrome")
  }
  return out
}

/** Whether to show the startup model picker for this run. */
export function shouldSelectModel(
  setup: SetupPrefs | null,
  overrides: SetupOverrides,
): boolean {
  if (overrides.select === false) return false
  // Before setup runs, keep the long-standing behaviour of asking.
  return setup === null ? true : setup.select
}
