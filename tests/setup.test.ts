import { describe, expect, test } from "bun:test"
import {
  MCP_PACKAGE,
  browserMcpConfig,
  extensionHint,
  extensionInstalled,
  parseToken,
} from "../src/browsermcp"
import { setupClaudeArgs, setupEnv, shouldSelectModel } from "../src/setup"

const saved = (over: Partial<Record<string, boolean>> = {}) => ({
  version: 2,
  bypass: true,
  select: true,
  browser: false,
  ...over,
})

describe("setupClaudeArgs", () => {
  test("adds the flags the saved setup implies", () => {
    expect(setupClaudeArgs(saved(), {}, [])).toEqual([
      "--dangerously-skip-permissions",
    ])
  })

  test("adds nothing before setup has ever run", () => {
    expect(setupClaudeArgs(null, {}, [])).toEqual([])
  })

  test("--no-* turns one option off for this run only", () => {
    expect(setupClaudeArgs(saved(), { bypass: false }, [])).toEqual([])
  })

  test("never duplicates a flag the user already passed", () => {
    expect(
      setupClaudeArgs(saved(), {}, ["--dangerously-skip-permissions"]),
    ).toEqual([])
  })

  test("an option saved off stays off", () => {
    expect(setupClaudeArgs(saved({ bypass: false }), {}, [])).toEqual([])
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

describe("extension token", () => {
  const withToken = { ...saved({ browser: true }), browserToken: "tok123" }

  test("is passed to the child so sessions skip the connect dialog", () => {
    expect(setupEnv(withToken, {})).toEqual({
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "tok123",
    })
  })

  test("an exported value wins over the stored one", () => {
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = "from-shell"
    try {
      expect(setupEnv(withToken, {})).toEqual({})
    } finally {
      delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
    }
  })

  test("nothing to pass without a token, or with browser off for the run", () => {
    expect(setupEnv(saved({ browser: true }), {})).toEqual({})
    expect(setupEnv(withToken, { browser: false })).toEqual({})
    expect(setupEnv(null, {})).toEqual({})
  })

  // Connection itself cannot be known at startup, so the hint reports the
  // token instead - it is what decides whether a dialog appears.
  test("the hint distinguishes stored token from none", () => {
    expect(extensionHint(true, "tok")).toContain("without the connect dialog")
    expect(extensionHint(true)).toContain("connect dialog")
    expect(extensionHint(true)).toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN")
  })
})

describe("token parsing", () => {
  // The extension displays the whole assignment, so that is what gets pasted.
  test("accepts the value, the assignment, or an exported line", () => {
    const want = "vsniGjCK1P0voIepAYLL"
    for (const input of [
      want,
      `PLAYWRIGHT_MCP_EXTENSION_TOKEN=${want}`,
      `export PLAYWRIGHT_MCP_EXTENSION_TOKEN=${want}`,
      `  PLAYWRIGHT_MCP_EXTENSION_TOKEN="${want}"  `,
      `PLAYWRIGHT_MCP_EXTENSION_TOKEN='${want}'`,
    ]) {
      expect(parseToken(input)).toBe(want)
    }
  })

  test("treats an empty answer as skipped", () => {
    expect(parseToken("")).toBeUndefined()
    expect(parseToken("   ")).toBeUndefined()
    expect(parseToken("PLAYWRIGHT_MCP_EXTENSION_TOKEN=")).toBeUndefined()
  })
})
