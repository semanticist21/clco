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

export const BROWSER_MCP_PACKAGE = "@agent360/browser-mcp@latest"
const EXTENSION_ID = "jdehgalffmffhfhmmhaokfbfnafnmgcl"
export const EXTENSION_URL =
  `https://chromewebstore.google.com/detail/agent360-browser-mcp/${EXTENSION_ID}`

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
export async function extensionInstalled(home = homedir()): Promise<boolean> {
  for (const root of chromeRoots(home)) {
    let profiles: string[]
    try {
      profiles = await readdir(root)
    } catch {
      continue
    }
    for (const profile of profiles) {
      try {
        const entries = await readdir(join(root, profile, "Extensions"))
        if (entries.includes(EXTENSION_ID)) return true
      } catch {
        // not a profile directory, or no extensions in it
      }
    }
  }
  return false
}

/** The --mcp-config payload registering the server for this session only. */
export function browserMcpConfig(): string {
  return JSON.stringify({
    mcpServers: {
      "browser-mcp": { command: "npx", args: ["-y", BROWSER_MCP_PACKAGE] },
    },
  })
}

export function extensionHint(installed: boolean): string {
  return installed
    ? `Browser MCP extension detected. Tools arrive as mcp__browser-mcp__*.`
    : `Browser MCP needs its Chrome extension, which is not installed yet:\n` +
      `  ${EXTENSION_URL}\n` +
      `  Until it is, the tools appear but every call fails.`
}
