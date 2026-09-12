import { describe, expect, test } from "bun:test"
import {
  BROWSER_MCP_VARIANTS,
  browserMcpConfig,
  extensionHint,
  installedVariant,
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

describe("browser MCP registration", () => {
  test("registers the server for the session, without touching MCP config", () => {
    const variant = BROWSER_MCP_VARIANTS[0]!
    const args = setupClaudeArgs(saved({ browser: true }), {}, [], variant)
    const i = args.indexOf("--mcp-config")
    expect(i).toBeGreaterThan(-1)
    expect(JSON.parse(args[i + 1]!).mcpServers["browser-mcp"].args).toContain(
      variant.package,
    )
  })

  test("--no-browser skips it for one run", () => {
    expect(
      setupClaudeArgs(
        saved({ browser: true }),
        { browser: false },
        [],
        BROWSER_MCP_VARIANTS[0]!,
      ),
    ).not.toContain("--mcp-config")
  })

  // A user-supplied --mcp-config owns the session's MCP set; adding a second
  // one silently would change what they asked for.
  test("defers to an --mcp-config the user passed", () => {
    expect(
      setupClaudeArgs(
        saved({ browser: true }),
        {},
        ["--mcp-config", "x.json"],
        BROWSER_MCP_VARIANTS[0]!,
      ),
    ).not.toContain("--mcp-config")
  })
})

describe("extension detection", () => {
  test("reports no variant without probing the network", async () => {
    // The server is spawned per conversation, so nothing listens at startup;
    // detection has to be filesystem-based to avoid a false negative.
    expect(await installedVariant("/nonexistent-home")).toBeNull()
    expect(extensionHint(null)).toContain("chromewebstore.google.com")
    expect(extensionHint(BROWSER_MCP_VARIANTS[0]!)).toContain("detected")
  })

  // Each extension only talks to its own server, so registering the wrong
  // package yields tools that fail on every call.
  test("registers the package matching the installed extension", () => {
    for (const v of BROWSER_MCP_VARIANTS) {
      expect(JSON.parse(browserMcpConfig(v)!).mcpServers["browser-mcp"].args)
        .toContain(v.package)
    }
    expect(browserMcpConfig(null)).toBeNull()
  })

  // Microsoft's is an order of magnitude more used and still shipping, so it
  // wins when a machine has more than one extension installed.
  test("prefers Playwright MCP, and passes the flag it needs to attach", () => {
    const first = BROWSER_MCP_VARIANTS[0]!
    expect(first.package).toBe("@playwright/mcp@latest")
    expect(JSON.parse(browserMcpConfig(first)!).mcpServers["browser-mcp"].args)
      .toContain("--extension")
  })
})
