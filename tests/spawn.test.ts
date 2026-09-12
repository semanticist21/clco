import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { catalogModelIds } from "../src/catalog"
import {
  buildModelOverridesFrom,
  buildModelPickerFrom,
  buildSettingsEnv,
} from "../src/spawn"

describe("buildModelPickerFrom", () => {
  const model = (over: Record<string, unknown>) => ({
    id: "x",
    name: "x",
    endpoints: ["/chat/completions"] as string[],
    efforts: null,
    ...over,
  })

  // Every model GitHub currently returns carries model_picker_enabled:false,
  // so honouring that field emptied the lineup completely. The lineup must
  // survive it.
  test("a lineup where the upstream hides every model still renders", () => {
    const picker = buildModelPickerFrom([
      model({ id: "gpt-5.6-luna", pickerEnabled: false, maxPromptTokens: 200000 }),
      model({ id: "claude-opus-5", pickerEnabled: false, maxPromptTokens: 200000 }),
    ])!
    expect(picker.options).toHaveLength(2)
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
        efforts: ["low", "high"],
      }),
    ])!
    expect(Array.isArray(picker.options)).toBe(true)
    // Native rows sort ahead of the rest.
    expect(picker.options[0]).toEqual({
      model: "claude-opus-5",
      description: "claude-opus-5 · native · 200k",
    })
    // A non-catalog id needs behavesAs or claude silently declines the row,
    // and the target must be a real catalog id — never a family alias.
    expect(picker.options[1]).toEqual({
      model: "gpt-5.6-luna",
      label: "Luna 5.6",
      description: "gpt-5.6-luna · responses · 328k · no effort tiers",
      behavesAs: "claude-opus-5",
    })
  })

  test("dot-form Claude slugs are advertised in catalog form, unborrowed", () => {
    const picker = buildModelPickerFrom([
      model({ id: "claude-haiku-4.5", maxPromptTokens: 128000 }),
      model({ id: "claude-opus-4.8-fast", maxPromptTokens: 200000 }),
    ])!
    const haiku = picker.options.find((o) => o.model.startsWith("claude-haiku"))!
    expect(haiku.model).toBe("claude-haiku-4-5")
    expect(haiku.behavesAs).toBeUndefined()
    // No catalog twin for the -fast variant, so it has to borrow one.
    const fast = picker.options.find((o) => o.model.includes("fast"))!
    expect(fast.model).toBe("claude-opus-4.8-fast")
    expect(fast.behavesAs).toBe("claude-haiku-4-5")
  })

  test("every behavesAs target is a real catalog id", () => {
    const picker = buildModelPickerFrom([
      model({ id: "claude-sonnet-5", endpoints: ["/v1/messages"] }),
      model({ id: "gpt-6-astra", endpoints: ["/responses"] }),
      model({ id: "kimi-k3" }),
      model({ id: "gemini-3.8-flash" }),
    ])!
    for (const o of picker.options) {
      if (o.behavesAs) expect(catalogModelIds().has(o.behavesAs)).toBe(true)
    }
  })

  // [1m] tells Claude Code the model has a 1M window, and server.ts only
  // forwards the matching beta at a real 1M. Claiming it below that told the
  // client 1M while delivering 200k - the two must agree on the threshold.
  test("[1m] is claimed only at a real 1M window", () => {
    const picker = buildModelPickerFrom([
      model({ id: "small", maxPromptTokens: 12288 }),
      model({ id: "mid", maxPromptTokens: 272000 }),
      model({ id: "big", maxPromptTokens: 917504 }),
      model({ id: "huge", maxPromptTokens: 1000000 }),
    ])!
    const by = (id: string) => picker.options.find((o) => o.description!.startsWith(id))!
    expect(by("small").model).toBe("small")
    expect(by("mid").model).toBe("mid")
    expect(by("big").model).toBe("big")
    expect(by("huge").model).toBe("huge[1m]")
  })

  test("models that cannot hold a conversation are excluded", () => {
    expect(
      buildModelPickerFrom([
        model({ id: "text-embedding-3-small", type: "embeddings", endpoints: [] }),
      ]),
    ).toBeNull()
  })

  // Older Copilot entries declare neither capabilities.type nor
  // supported_endpoints; Copilot serves them over /chat/completions and so
  // does the adapter, so absent metadata must not drop them.
  test("entries with no declared capability metadata are still offered", () => {
    const picker = buildModelPickerFrom([
      model({ id: "gpt-4o", type: undefined, endpoints: [] }),
    ])!
    expect(picker.options).toHaveLength(1)
  })

  // Replacing the built-in lineup while offering nothing leaves /model empty.
  test("replaceBuiltInOptions rides only on a non-empty lineup", () => {
    expect(buildModelPickerFrom([model({ id: "a" })])!.replaceBuiltInOptions).toBe(
      true,
    )
    expect(
      buildModelPickerFrom([model({ type: "embeddings", endpoints: [] })]),
    ).toBeNull()
  })

  test("caps the lineup", () => {
    const big = Array.from({ length: 250 }, (_, i) => model({ id: `m-${i}` }))
    expect(buildModelPickerFrom(big)!.options).toHaveLength(200)
  })
})

describe("buildModelOverridesFrom", () => {
  test("maps advertised catalog ids back to the upstream slug", () => {
    expect(
      buildModelOverridesFrom([
        { id: "claude-haiku-4.5", name: "", endpoints: [], efforts: null },
        { id: "claude-opus-5", name: "", endpoints: [], efforts: null },
      ]),
    ).toEqual({ "claude-haiku-4-5": "claude-haiku-4.5" })
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
    // Pinning ANTHROPIC_MODEL makes every /model switch cosmetic — claude
    // keeps using the pinned id and says so. The choice travels as --model.
    expect(env.ANTHROPIC_MODEL).toBeUndefined()
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


describe("duplicate display names", () => {
  const m = (id: string, name: string) => ({
    id,
    name,
    endpoints: ["/chat/completions"],
    efforts: null,
    maxPromptTokens: 200000,
  })

  // Titles stay clean; the subtitle's leading id is what tells them apart.
  test("rows sharing a display name stay distinguishable", () => {
    const picker = buildModelPickerFrom([
      m("gpt-5.6-luna", "GPT-5.6 Luna"),
      m("gpt-5.6-luna-free-auto", "GPT-5.6 Luna"),
    ])!
    expect(picker.options.map((o) => o.label)).toEqual([
      "GPT-5.6 Luna",
      "GPT-5.6 Luna",
    ])
    expect(picker.options[0]!.description).toStartWith("gpt-5.6-luna ·")
    expect(picker.options[1]!.description).toStartWith("gpt-5.6-luna-free-auto ·")
  })

  test("the window warning marks only models smaller than the session budget", () => {
    const picker = buildModelPickerFrom(
      [m("small", "Small"), m("big", "Big")].map((x, i) => ({
        ...x,
        maxPromptTokens: i === 0 ? 12288 : 917504,
      })),
      { sessionWindow: 200000 },
    )!
    const by = (id: string) =>
      picker.options.find((o) => o.description!.startsWith(id))!
    expect(by("small").description).toContain("! caps at 12k")
    expect(by("big").description).not.toContain("⚠")
  })
})

describe("internal Copilot plumbing", () => {
  const m = (id: string, family: string) => ({
    id,
    name: id,
    endpoints: ["/chat/completions"],
    efforts: null,
    maxPromptTokens: 244000,
    type: "chat",
    family,
  })

  // These answer like models but are Copilot's own search/exec/compaction
  // machinery. They declare a role as their family where a real model
  // declares its own name, which is the only signal separating them.
  test("role-family entries are hidden, real models are not", () => {
    const picker = buildModelPickerFrom([
      m("copilot-search-a", "search-agent"),
      m("exec-agent-a", "exec-agent"),
      m("trajectory-compaction", "trajectory-compaction"),
      m("gpt-4o", "gpt-4o"),
    ])!
    expect(picker.options.map((o) => o.model)).toEqual(["gpt-4o"])
  })

  test("CLCO_SHOW_INTERNAL brings them back", () => {
    const prev = process.env.CLCO_SHOW_INTERNAL
    process.env.CLCO_SHOW_INTERNAL = "1"
    try {
      const picker = buildModelPickerFrom([m("copilot-search-a", "search-agent")])!
      expect(picker.options).toHaveLength(1)
    } finally {
      if (prev === undefined) delete process.env.CLCO_SHOW_INTERNAL
      else process.env.CLCO_SHOW_INTERNAL = prev
    }
  })
})

describe("buildSettingsEnv — what must not be there", () => {
  const models = { opus: "o", sonnet: "s", haiku: "h", fable: "f" }

  // Gateway discovery wrote a dead adapter port into the user's own
  // ~/.claude/cache/gateway-models.json. It is now absent rather than set to
  // "0", and an absence survives no refactor unless something asserts it.
  test("gateway discovery stays off, so nothing writes into ~/.claude", () => {
    const env = buildSettingsEnv("http://127.0.0.1:1", models, "m", null)
    expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined()
  })
})
