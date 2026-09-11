import { describe, expect, test } from "bun:test"
import {
  CATALOG_MODEL_IDS,
  advertisedId,
  familyOf,
  resolveBehavesAs,
} from "../src/catalog"

describe("advertisedId", () => {
  test("rewrites dot-form slugs onto their catalog twin", () => {
    expect(advertisedId("claude-haiku-4.5")).toBe("claude-haiku-4-5")
    expect(advertisedId("claude-fable-5.1")).toBe("claude-fable-5-1")
    expect(advertisedId("claude-opus-4.8")).toBe("claude-opus-4-8")
  })

  test("passes through slugs that are already catalog ids", () => {
    expect(advertisedId("claude-sonnet-5")).toBe("claude-sonnet-5")
    expect(advertisedId("claude-opus-5")).toBe("claude-opus-5")
  })

  test("returns null when there is no catalog twin", () => {
    // A real Copilot slug with no catalog counterpart.
    expect(advertisedId("claude-opus-4.8-fast")).toBeNull()
    expect(advertisedId("gpt-6-astra")).toBeNull()
    expect(advertisedId("kimi-k3")).toBeNull()
  })
})

describe("resolveBehavesAs", () => {
  test("prefers a same-family model the upstream actually serves", () => {
    expect(resolveBehavesAs("opus", ["claude-opus-5", "claude-sonnet-5"])).toBe(
      "claude-opus-5",
    )
  })

  test("falls back to a catalog id even when the upstream has no Claude models", () => {
    // Without this the row carries no behavesAs, and claude declines to
    // offer it at all — an empty /model.
    const target = resolveBehavesAs("sonnet", ["gpt-6-astra", "kimi-k3"])
    expect(CATALOG_MODEL_IDS.has(target)).toBe(true)
  })

  test("always resolves to something claude knows", () => {
    for (const family of ["opus", "sonnet", "haiku", "fable"] as const) {
      expect(CATALOG_MODEL_IDS.has(resolveBehavesAs(family, []))).toBe(true)
    }
  })
})

describe("familyOf", () => {
  test("reads the family out of the slug, defaulting to sonnet", () => {
    expect(familyOf("claude-opus-4.8-fast")).toBe("opus")
    expect(familyOf("claude-haiku-4.5")).toBe("haiku")
    expect(familyOf("claude-fable-5.1")).toBe("fable")
    expect(familyOf("gpt-6-astra")).toBe("sonnet")
  })
})
