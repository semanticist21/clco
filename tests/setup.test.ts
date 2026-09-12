import { describe, expect, test } from "bun:test"
import {
  MCP_PACKAGE,
  browserMcpConfig,
  extensionHint,
  extensionInstalled,
} from "../src/browsermcp"
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

describe("browser control", () => {
  test("registers the server for the session, without touching MCP config", () => {
    const args = setupClaudeArgs(saved({ browser: true }), {}, [], true)
    const i = args.indexOf("--mcp-config")
    expect(i).toBeGreaterThan(-1)
    const server = JSON.parse(args[i + 1]!).mcpServers.playwright
    expect(server.args).toContain(MCP_PACKAGE)
    // Without this the server drives its own browser instead of attaching to
    // the tab the user shared.
    expect(server.args).toContain("--extension")
  })

  // The extension is the half clco cannot install; registering the server
  // alone would surface tools that fail on every call.
  test("registers nothing when the extension is missing", () => {
    expect(setupClaudeArgs(saved({ browser: true }), {}, [], false)).not.toContain(
      "--mcp-config",
    )
    expect(browserMcpConfig(false)).toBeNull()
  })

  test("--no-browser skips it for one run", () => {
    expect(
      setupClaudeArgs(saved({ browser: true }), { browser: false }, [], true),
    ).not.toContain("--mcp-config")
  })

  // A user-supplied --mcp-config owns the session's MCP set; adding a second
  // one silently would change what they asked for.
  test("defers to an --mcp-config the user passed", () => {
    expect(
      setupClaudeArgs(saved({ browser: true }), {}, ["--mcp-config", "x.json"], true),
    ).not.toContain("--mcp-config")
  })

  test("reports the extension without probing the network", async () => {
    // The server is spawned per conversation, so nothing listens at startup;
    // detection has to be filesystem-based to avoid a false negative.
    expect(await extensionInstalled("/nonexistent-home")).toBe(false)
    expect(extensionHint(false)).toContain("chromewebstore.google.com")
    expect(extensionHint(true)).toContain("detected")
  })
})
