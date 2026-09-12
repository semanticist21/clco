import { describe, expect, test } from "bun:test"
import { setupClaudeArgs, shouldSelectModel } from "../src/setup"

const saved = (over: Partial<Record<string, boolean>> = {}) => ({
  version: 2,
  bypass: true,
  chrome: true,
  select: true,
  browser: false,
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

describe("defaults", () => {
  // The flags people install clco for; Enter-through should land on them.
  test("first-run prompts come pre-filled with yes", async () => {
    const { SETUP_DEFAULTS } = await import("../src/setup")
    expect(SETUP_DEFAULTS).toEqual({
      bypass: true,
      chrome: true,
      select: true,
      browser: true,
    })
  })
})

describe("browser MCP registration", () => {
  test("registers the server for the session, without touching MCP config", () => {
    const args = setupClaudeArgs(saved({ browser: true }), {}, [])
    const i = args.indexOf("--mcp-config")
    expect(i).toBeGreaterThan(-1)
    expect(JSON.parse(args[i + 1]!).mcpServers["browser-mcp"].command).toBe("npx")
  })

  test("--no-browser skips it for one run", () => {
    expect(
      setupClaudeArgs(saved({ browser: true }), { browser: false }, []),
    ).not.toContain("--mcp-config")
  })

  // A user-supplied --mcp-config owns the session's MCP set; adding a second
  // one silently would change what they asked for.
  test("defers to an --mcp-config the user passed", () => {
    expect(
      setupClaudeArgs(saved({ browser: true }), {}, ["--mcp-config", "x.json"]),
    ).not.toContain("--mcp-config")
  })
})

describe("extension detection", () => {
  test("reports a missing extension without probing the network", async () => {
    const { extensionInstalled, extensionHint } = await import("../src/browsermcp")
    // The server is spawned per conversation, so nothing listens at startup;
    // detection has to be filesystem-based to avoid a false negative.
    const installed = await extensionInstalled("/nonexistent-home")
    expect(installed).toBe(false)
    expect(extensionHint(false)).toContain("chromewebstore.google.com")
    expect(extensionHint(true)).toContain("detected")
  })
})
