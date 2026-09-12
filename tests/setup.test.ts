import { describe, expect, test } from "bun:test"
import { setupClaudeArgs, shouldSelectModel } from "../src/setup"

const saved = (over: Partial<Record<string, boolean>> = {}) => ({
  version: 1,
  bypass: true,
  chrome: true,
  select: true,
  ...over,
})

describe("setupClaudeArgs", () => {
  test("adds the flags the saved setup implies", () => {
    expect(setupClaudeArgs(saved(), {}, [])).toEqual([
      "--dangerously-skip-permissions",
      "--chrome",
    ])
  })

  test("adds nothing before setup has ever run", () => {
    expect(setupClaudeArgs(null, {}, [])).toEqual([])
  })

  test("--no-* turns one option off for this run only", () => {
    expect(setupClaudeArgs(saved(), { chrome: false }, [])).toEqual([
      "--dangerously-skip-permissions",
    ])
    expect(setupClaudeArgs(saved(), { bypass: false, chrome: false }, [])).toEqual(
      [],
    )
  })

  test("never duplicates a flag the user already passed", () => {
    expect(setupClaudeArgs(saved(), {}, ["--chrome"])).toEqual([
      "--dangerously-skip-permissions",
    ])
  })

  test("an option saved off stays off", () => {
    expect(setupClaudeArgs(saved({ chrome: false }), {}, [])).toEqual([
      "--dangerously-skip-permissions",
    ])
  })
})

describe("shouldSelectModel", () => {
  test("follows the saved answer", () => {
    expect(shouldSelectModel(saved(), {})).toBe(true)
    expect(shouldSelectModel(saved({ select: false }), {})).toBe(false)
  })

  test("--no-select wins over a saved yes", () => {
    expect(shouldSelectModel(saved(), { select: false })).toBe(false)
  })

  // Asking is what clco did before setup existed; keep that until answered.
  test("asks when setup has never run", () => {
    expect(shouldSelectModel(null, {})).toBe(true)
  })
})
