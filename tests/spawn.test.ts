import { describe, expect, test } from "bun:test"
import { buildModelPickerFrom, buildSettingsEnv } from "../src/spawn"

describe("buildModelPickerFrom", () => {
  const model = (over: Record<string, unknown>) => ({
    id: "x",
    name: "x",
    endpoints: [] as string[],
    efforts: null,
    ...over,
  })

  test("emits the documented {id,name,description} lineup", () => {
    expect(buildModelPickerFrom([])).toBeNull()

    const picker = buildModelPickerFrom([
      model({
        id: "gpt-5.6-luna",
        name: "Luna 5.6",
        endpoints: ["/responses"],
        maxContextTokens: 328000,
      }),
      model({
        id: "claude-sonnet-5",
        name: "claude-sonnet-5",
        endpoints: ["/v1/messages", "/chat/completions"],
        maxPromptTokens: 200000,
      }),
    ])!
    // Non-Claude ids must survive: gateway discovery would have dropped them.
    expect(picker[0]).toEqual({
      id: "gpt-5.6-luna",
      name: "Luna 5.6",
      description: "Copilot · responses · 328k",
    })
    // No `name` when it would just repeat the id.
    expect(picker[1]).toEqual({
      id: "claude-sonnet-5",
      description: "Copilot · native · 200k",
    })
  })

  test("skips models the upstream hides and caps the lineup", () => {
    expect(
      buildModelPickerFrom([model({ id: "hidden", pickerEnabled: false })]),
    ).toBeNull()
    const big = Array.from({ length: 250 }, (_, i) => model({ id: `m-${i}` }))
    expect(buildModelPickerFrom(big)!).toHaveLength(200)
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
