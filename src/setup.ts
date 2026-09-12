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

const DEFAULTS: Omit<SetupPrefs, "version"> = {
  bypass: false,
  chrome: false,
  select: false,
}

export async function runSetup(): Promise<SetupPrefs> {
  const prefs = await loadPrefs()
  const current = prefs.setup ?? { ...DEFAULTS, version: SETUP_VERSION }

  p.intro("clco 설정 — 매번 붙이던 옵션을 기본값으로 저장합니다")
  const ask = async (message: string, initialValue: boolean): Promise<boolean> => {
    const answer = await p.confirm({ message, initialValue })
    if (p.isCancel(answer)) {
      p.cancel("취소됨 — 기존 설정을 유지합니다")
      process.exit(0)
    }
    return answer as boolean
  }

  const setup: SetupPrefs = {
    version: SETUP_VERSION,
    bypass: await ask(
      "권한 확인 없이 실행할까요? (--dangerously-skip-permissions)",
      current.bypass,
    ),
    chrome: await ask("Chrome 연동을 켤까요? (--chrome)", current.chrome),
    select: await ask("시작할 때 모델을 고를까요?", current.select),
  }

  await savePrefs({ ...prefs, setup })
  p.outro("저장했습니다 — 바꾸려면 `clco setup`, 이번만 끄려면 --no-bypass / --no-chrome / --no-select")
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
      "[clco] 새 설정 항목이 있습니다 (기본값 off) — 켜려면 `clco setup`",
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
