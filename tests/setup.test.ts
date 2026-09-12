import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MCP_PACKAGE,
  browserMcpConfig,
  extensionHint,
  extensionInstalled,
  parseToken,
  startupLine,
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
  // setupEnv reads this variable, and it is the one clco tells users to
  // export - without isolating it the suite fails for anyone who followed
  // that advice, and passes here only by accident.
  const KEY = "PLAYWRIGHT_MCP_EXTENSION_TOKEN"
  let saved_env: string | undefined
  beforeEach(() => {
    saved_env = process.env[KEY]
    delete process.env[KEY]
  })
  afterEach(() => {
    if (saved_env === undefined) delete process.env[KEY]
    else process.env[KEY] = saved_env
  })

  test("is passed to the child so sessions skip the connect dialog", () => {
    expect(setupEnv(withToken, {})).toEqual({
      PLAYWRIGHT_MCP_EXTENSION_TOKEN: "tok123",
    })
  })

  test("an exported value wins over the stored one", () => {
    process.env[KEY] = "from-shell"
    expect(setupEnv(withToken, {})).toEqual({})
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
  const want = "vsniGjCK1P0voIepAYLL_hVbDXq_tgzoHjH5aFa8Ffk"

  // The extension displays the whole assignment, so that is what gets pasted.
  test("accepts the value, the assignment, or an exported line", () => {
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

  // A terminal submits at the first newline, so a multi-line paste would
  // otherwise store whichever line happened to come first.
  test("picks the token line out of a multi-line paste", () => {
    expect(parseToken(`Set this to bypass the dialog:\nPLAYWRIGHT_MCP_EXTENSION_TOKEN=${want}\n`))
      .toBe(want)
    expect(parseToken(`${want}\nkkomi@host ~ % clco setup`)).toBe(want)
  })

  // The shape check is what stopped a pasted shell prompt being saved as a
  // token that could never work, with nothing to explain why.
  test("rejects input that is not a token", () => {
    expect(parseToken("kkomi@semanticist ~ % clco setup")).toBeNull()
    expect(parseToken("no")).toBeNull()
  })

  test("treats an empty answer as skipped", () => {
    expect(parseToken("")).toBeUndefined()
    expect(parseToken("   ")).toBeUndefined()
    expect(parseToken("PLAYWRIGHT_MCP_EXTENSION_TOKEN=")).toBeUndefined()
  })
})

describe("startup line", () => {
  test("reports what clco did, and whether a dialog is coming", () => {
    expect(startupLine(true, true, "tok")).toBe("+ browser: Playwright MCP")
    expect(startupLine(true, true)).toContain("connect dialog each session")
    expect(startupLine(true, false)).toContain("not installed")
    expect(startupLine(true, false)).toContain("chromewebstore.google.com")
  })

  // Nothing to say when browser control is off, or off for this run.
  test("stays quiet when the feature is not in play", () => {
    expect(startupLine(false, true, "tok")).toBeNull()
  })
})

describe("browser MCP under a TLS-inspecting proxy", () => {
  // npx fetches from the npm registry over its own TLS, outside clco's
  // copilotFetch, so without this the browser feature is the one part that
  // still fails on the network the CA work exists for.
  test("hands the corporate CA down to the MCP child", () => {
    const server = JSON.parse(browserMcpConfig(true, "/tmp/ca.pem")!)
      .mcpServers.playwright
    expect(server.env).toEqual({ NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" })
  })

  test("sets no env when neither a CA nor a token is configured", () => {
    expect(JSON.parse(browserMcpConfig(true, undefined)!).mcpServers.playwright.env)
      .toBeUndefined()
  })

  // This object becomes an --mcp-config argv element, and argv is readable by
  // other local users. The token travels through claude's environment, which
  // MCP children inherit, so it must never appear here.
  test("keeps the extension token out of argv", () => {
    const config = browserMcpConfig(true, "/tmp/ca.pem")!
    expect(config).not.toContain("PLAYWRIGHT_MCP_EXTENSION_TOKEN")
    const args = setupClaudeArgs(
      { ...saved({ browser: true }), browserToken: "SECRET" },
      {},
      [],
      true,
    )
    expect(args.join(" ")).not.toContain("SECRET")
    // ...while still reaching the server by the route that is not public.
    expect(setupEnv({ ...saved({ browser: true }), browserToken: "SECRET" }, {}))
      .toEqual({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: "SECRET" })
  })

  // The installer guarantees bun, not Node, while startupLine would otherwise
  // report success for a server that cannot spawn.
  test("says so when npx is missing", () => {
    expect(startupLine(true, true, "tok", false)).toContain("npx not found")
    expect(startupLine(true, true, "tok", true)).not.toContain("npx")
  })
})

describe("prefs merging", () => {
  // The model prompt wrote { last_model } and the setup answers went with it,
  // so choosing a model reset the wizard - observed on a live install.
  test("writing one concern does not erase another", async () => {
    const { loadPrefs, savePrefs, setConfigDir } = await import("../src/config")
    const dir = join(tmpdir(), `clco-prefs-${Date.now()}`)
    setConfigDir(dir)
    try {
      await savePrefs({
        setup: { version: 2, bypass: true, select: true, browser: true },
      })
      await savePrefs({ last_model: "kimi-k3" })
      const after = await loadPrefs()
      expect(after.last_model).toBe("kimi-k3")
      expect(after.setup?.browser).toBe(true)
    } finally {
      setConfigDir(null)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("token clearing", () => {
  // Merging made this the one path that has to delete rather than add, and
  // it works only because the caller spreads the whole setup object.
  test("--clear removes the key from the file on disk", async () => {
    const { loadPrefs, savePrefs, setConfigDir } = await import("../src/config")
    const dir = join(tmpdir(), `clco-clear-${Date.now()}`)
    setConfigDir(dir)
    try {
      await savePrefs({
        setup: { version: 2, bypass: true, select: true, browser: true, browserToken: "tok" },
      })
      expect((await loadPrefs()).setup?.browserToken).toBe("tok")
      const prefs = await loadPrefs()
      await savePrefs({ setup: { ...prefs.setup!, browserToken: undefined } })
      const raw = await readFile(join(dir, "prefs.json"), "utf8")
      expect(raw).not.toContain("browserToken")
      expect((await loadPrefs()).setup?.bypass).toBe(true)
    } finally {
      setConfigDir(null)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
