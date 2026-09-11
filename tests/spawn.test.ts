import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildModelPickerFrom,
  buildSettingsEnv,
  restoreUserModel,
  snapshotUserModel,
} from "../src/spawn"

describe("buildModelPickerFrom", () => {
  const model = (over: Record<string, unknown>) => ({
    id: "x",
    name: "x",
    endpoints: [] as string[],
    efforts: null,
    ...over,
  })

  test("emits the shape the claude binary validates against", () => {
    expect(buildModelPickerFrom([])).toBeNull()

    const picker = buildModelPickerFrom([
      model({
        id: "gpt-5.6-luna",
        name: "Luna 5.6",
        endpoints: ["/responses"],
        maxContextTokens: 328000,
      }),
      model({
        id: "claude-opus-5",
        name: "claude-opus-5",
        endpoints: ["/v1/messages", "/chat/completions"],
        maxPromptTokens: 200000,
      }),
    ])!
    // { options: [{ model, label?, description?, behavesAs? }] } — a flat
    // array is rejected outright by Claude Code.
    expect(Array.isArray(picker.options)).toBe(true)
    // Non-Claude ids must survive: gateway discovery drops them.
    expect(picker.options[0]).toEqual({
      model: "gpt-5.6-luna",
      label: "Luna 5.6",
      description: "Copilot · responses · 328k",
      behavesAs: "sonnet",
    })
    // No label when it would just repeat the id; family inferred from the id.
    expect(picker.options[1]).toEqual({
      model: "claude-opus-5",
      description: "Copilot · native · 200k",
      behavesAs: "opus",
    })
  })

  test("skips models the upstream hides and caps the lineup", () => {
    expect(
      buildModelPickerFrom([model({ id: "hidden", pickerEnabled: false })]),
    ).toBeNull()
    const big = Array.from({ length: 250 }, (_, i) => model({ id: `m-${i}` }))
    expect(buildModelPickerFrom(big)!.options).toHaveLength(200)
  })
})

describe("buildSettingsEnv", () => {
  const models = { opus: "o", sonnet: "s", haiku: "h", fable: "f" }

  test("native models keep thinking and use the upstream prompt budget", () => {
    const env = buildSettingsEnv("http://127.0.0.1:1", models, "mock-native", {
      id: "mock-native",
      name: "Mock Native",
      endpoints: ["/v1/messages", "/chat/completions"],
      efforts: ["low", "medium", "high"],
      maxPromptTokens: 200000,
      maxContextTokens: 264000,
    })
    expect(env.ANTHROPIC_MODEL).toBe("mock-native")
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000")
    expect(env.CLAUDE_CODE_DISABLE_THINKING).toBeUndefined()
  })

  test("translated dialects still suppress thinking", () => {
    const env = buildSettingsEnv("http://127.0.0.1:1", models, "luna", {
      id: "luna",
      name: "Luna",
      endpoints: ["/responses"],
      efforts: null,
      maxContextTokens: 328000,
    })
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("328000")
    expect(env.CLAUDE_CODE_DISABLE_THINKING).toBe("1")
  })

  test("unknown models fall back to the conservative window", () => {
    const env = buildSettingsEnv("http://127.0.0.1:1", models, "mystery", null)
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("160000")
    expect(env.CLAUDE_CODE_DISABLE_THINKING).toBe("1")
  })
})

describe("user settings protection", () => {
  // Picking a model with Enter in /model writes it to the user's own
  // settings; a Copilot slug must never survive into plain `claude`.
  const tmp = () => join(tmpdir(), `clco-settings-${crypto.randomUUID()}.json`)

  test("restores a model the session overwrote", async () => {
    const path = tmp()
    await writeFile(path, JSON.stringify({ model: "opus", other: 1 }, null, 2))
    const before = await snapshotUserModel(path)
    await writeFile(path, JSON.stringify({ model: "gpt-5.6-luna", other: 1 }))
    expect(await restoreUserModel(path, before)).toBe(true)
    const after = JSON.parse(await readFile(path, "utf8"))
    expect(after).toEqual({ model: "opus", other: 1 })
    await rm(path)
  })

  test("drops a model key the session introduced", async () => {
    const path = tmp()
    await writeFile(path, JSON.stringify({ other: 1 }))
    const before = await snapshotUserModel(path)
    await writeFile(path, JSON.stringify({ model: "gpt-6-astra", other: 1 }))
    expect(await restoreUserModel(path, before)).toBe(true)
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ other: 1 })
    await rm(path)
  })

  test("leaves an untouched file alone, and never creates one", async () => {
    const path = tmp()
    await writeFile(path, JSON.stringify({ model: "opus" }))
    const before = await snapshotUserModel(path)
    expect(await restoreUserModel(path, before)).toBe(false)
    await rm(path)

    const missing = tmp()
    const none = await snapshotUserModel(missing)
    expect(none.existed).toBe(false)
    expect(await restoreUserModel(missing, none)).toBe(false)
    expect(existsSync(missing)).toBe(false)
  })
})
