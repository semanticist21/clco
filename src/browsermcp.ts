// Browser control for clco sessions.
//
// Claude Code's own Chrome integration (--chrome) is gated on the session's
// OAuth scope and is therefore always off here: clco authenticates with
// ANTHROPIC_AUTH_TOKEN against its own adapter, which Claude Code treats as an
// env-var session limited to user:inference. An MCP server has no such gate,
// so browser control has to come from one.
//
// Browser MCP drives the Chrome you already have open, with your logins and
// cookies intact, rather than the fresh profile a Playwright-style server
// starts. It is two halves: this server, and a Chrome extension that only the
// user can install.

import { readdir } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { join } from "node:path"

// Two unrelated projects ship under this name, each with its own extension
// and npm package, and they are not interchangeable: the extension talks to
// its own server. So detect which one is actually installed and register that
// one, rather than picking for the user.
export interface BrowserMcpVariant {
  id: string
  label: string
  package: string
  /** Extra CLI args the server needs to attach to the running browser. */
  args: string[]
  storeUrl: string
}

// Ordered by what should win when more than one is installed: Microsoft's
// Playwright MCP first (~4.6M weekly npm downloads, actively released),
// then the smaller projects. browsermcp.io is last because its npm package
// has not been published since 2025-04 even though the extension still
// installs — recommending it would be pointing at an unmaintained half.
export const BROWSER_MCP_VARIANTS: readonly BrowserMcpVariant[] = [
  {
    id: "mmlmfjhmonkocbjadbfplnigmagldckm",
    label: "Playwright MCP Bridge (Microsoft)",
    package: "@playwright/mcp@latest",
    args: ["--extension"],
    storeUrl:
      "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm",
  },
  {
    id: "jdehgalffmffhfhmmhaokfbfnafnmgcl",
    label: "Agent360 Browser MCP",
    package: "@agent360/browser-mcp@latest",
    args: [],
    storeUrl:
      "https://chromewebstore.google.com/detail/agent360-browser-mcp/jdehgalffmffhfhmmhaokfbfnafnmgcl",
  },
  {
    id: "bjfgambnhccakkhmkepdoekmckoijdlc",
    label: "Browser MCP (browsermcp.io, unmaintained since 2025-04)",
    package: "@browsermcp/mcp@latest",
    args: [],
    storeUrl:
      "https://chromewebstore.google.com/detail/bjfgambnhccakkhmkepdoekmckoijdlc",
  },
]

/** Chrome's per-profile extension directories, by platform. */
function chromeRoots(home = homedir()): string[] {
  switch (platform()) {
    case "darwin":
      return [join(home, "Library", "Application Support", "Google", "Chrome")]
    case "win32":
      return [
        join(
          process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
          "Google",
          "Chrome",
          "User Data",
        ),
      ]
    default:
      return [
        join(home, ".config", "google-chrome"),
        join(home, ".config", "chromium"),
      ]
  }
}

/**
 * Whether the Chrome extension is present on disk.
 *
 * Deliberately not probed over the network: the server is spawned per
 * conversation on a port in 9876-9895, so at clco startup nothing is listening
 * and a probe would report "missing" for a working install.
 */
export async function installedVariant(
  home = homedir(),
): Promise<BrowserMcpVariant | null> {
  const present = new Set<string>()
  for (const root of chromeRoots(home)) {
    let profiles: string[]
    try {
      profiles = await readdir(root)
    } catch {
      continue
    }
    for (const profile of profiles) {
      try {
        for (const id of await readdir(join(root, profile, "Extensions"))) {
          present.add(id)
        }
      } catch {
        // not a profile directory, or no extensions in it
      }
    }
  }
  return BROWSER_MCP_VARIANTS.find((v) => present.has(v.id)) ?? null
}

/**
 * The --mcp-config payload registering the server for this session only.
 * Null when no extension is installed: registering a server whose other half
 * is missing only produces tools that fail on every call.
 */
export function browserMcpConfig(variant: BrowserMcpVariant | null): string | null {
  if (!variant) return null
  return JSON.stringify({
    mcpServers: {
      "browser-mcp": {
        command: "npx",
        args: ["-y", variant.package, ...variant.args],
      },
    },
  })
}

export function extensionHint(variant: BrowserMcpVariant | null): string {
  if (variant) {
    return `${variant.label} detected - registering ${variant.package}.\n` +
      `Tools arrive as mcp__browser-mcp__*.`
  }
  return (
    "Browser MCP is two halves, and the Chrome extension is the half only you\n" +
    "can install. Pick either, then re-run `clco setup`:\n" +
    BROWSER_MCP_VARIANTS.map((v) => `  ${v.label}\n    ${v.storeUrl}`).join("\n") +
    "\nUntil one is installed, clco registers no browser server."
  )
}
