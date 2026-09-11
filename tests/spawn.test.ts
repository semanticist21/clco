import { describe, expect, test } from "bun:test"
import { buildModelPickerFrom, buildSettingsEnv } from "../src/spawn"

describe("buildModelPickerFrom", () => {
  test("pins the modelPicker lineup contract", () => {
    expect(buildModelPickerFrom([])).toBeNull()

    const list = [
      { id: "gpt-5.6-luna", name: "Luna 5.6" },
      { id: "claude-sonnet-5", name: "claude-sonnet-5" },
    ]
    const picker = buildModelPickerFrom(list)!
    // label only when display name differs from the id
    expect(picker.options[0]).toEqual({ model: "gpt-5.6-luna", label: "Luna 5.6" })
    expect(picker.options[1]).toEqual({ model: "claude-sonnet-5" })
    expect(picker.replaceBuiltInOptions).toBe(false)
  })

  test("caps the lineup at 200 entries", () => {
    const big = Array.from({ length: 250 }, (_, i) => ({ id: `m-${i}`, name: "" }))
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
