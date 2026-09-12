// Browser control for clco sessions, via Playwright MCP.
//
// Claude Code's own Chrome integration (--chrome) is gated on the session's
// OAuth scope and is therefore always off here: clco authenticates with
// ANTHROPIC_AUTH_TOKEN against its own adapter, which Claude Code treats as an
// env-var session limited to user:inference. An MCP server has no such gate,
// so browser control has to come from one.
//
// Playwright MCP in --extension mode attaches to a tab already open in the
// user's own browser, with their logins and cookies intact, rather than the
// fresh profile a headless run would get. Other projects do the same thing,
// but this is the one with ~4.6M weekly downloads and active releases, so
// clco supports exactly it rather than maintaining a catalogue.

import { readdir } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { join } from "node:path"

export const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"
export const EXTENSION_NAME = "Playwright MCP Bridge"
export const EXTENSION_URL =
  `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`
export const MCP_PACKAGE = "@playwright/mcp@latest"
/** Set by the extension; with it the bridge attaches without a dialog. */
export const TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN"

/**
 * Per-profile extension directories, by platform. Edge is included because
 * both the extension and --extension mode support it.
 */
function browserRoots(home = homedir()): string[] {
  switch (platform()) {
    case "darwin":
      return [
        join(home, "Library", "Application Support", "Google", "Chrome"),
        join(home, "Library", "Application Support", "Microsoft Edge"),
      ]
    case "win32": {
      const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local")
      return [
        join(local, "Google", "Chrome", "User Data"),
        join(local, "Microsoft", "Edge", "User Data"),
      ]
    }
    default:
      return [
        join(home, ".config", "google-chrome"),
        join(home, ".config", "chromium"),
        join(home, ".config", "microsoft-edge"),
      ]
  }
}

/**
 * Whether the bridge extension is installed.
 *
 * Deliberately not probed over the network: the MCP server is spawned per
 * conversation, so at clco startup nothing is listening and a probe would
 * report "missing" for a working install.
 */
export async function extensionInstalled(home = homedir()): Promise<boolean> {
  for (const root of browserRoots(home)) {
    let profiles: string[]
    try {
      profiles = await readdir(root)
    } catch {
      continue
    }
    for (const profile of profiles) {
      try {
        const ids = await readdir(join(root, profile, "Extensions"))
        if (ids.includes(EXTENSION_ID)) return true
      } catch {
        // not a profile directory, or no extensions in it
      }
    }
  }
  return false
}

/**
 * The --mcp-config payload registering the server for this session only.
 * Null without the extension: the server is only half of it, and registering
 * it alone produces tools that fail on every call.
 */
export function browserMcpConfig(installed: boolean): string | null {
  if (!installed) return null
  return JSON.stringify({
    mcpServers: {
      playwright: { command: "npx", args: ["-y", MCP_PACKAGE, "--extension"] },
    },
  })
}

/**
 * Accept what the extension actually puts on screen. It shows the whole
 * assignment, so pasting that verbatim is the obvious move — as is pasting
 * just the value, or a line copied with `export` in front. Take any of them.
 */
export function parseToken(input: string): string | undefined {
  const line = input.trim().replace(/^export\s+/, "")
  const value = line.startsWith(`${TOKEN_ENV}=`)
    ? line.slice(TOKEN_ENV.length + 1)
    : line
  // Shell-style quoting survives a copy from a snippet.
  return value.trim().replace(/^(['"])(.*)\1$/, "$2").trim() || undefined
}

/**
 * One line for the startup summary, alongside adapter and model. Whether a
 * session is attached is not knowable here — the server starts per
 * conversation — so this reports what clco did, and whether a connect dialog
 * is coming.
 */
export function startupLine(
  enabled: boolean,
  installed: boolean,
  token?: string,
): string | null {
  if (!enabled) return null
  if (!installed) {
    return `! browser: ${EXTENSION_NAME} not installed - ${EXTENSION_URL}`
  }
  return `+ browser: Playwright MCP${token ? "" : " (connect dialog each session)"}`
}

/**
 * What setup shows before asking anything: the state, without advice to run
 * the very command that is running.
 */
export function setupNote(installed: boolean): string {
  return installed
    ? `${EXTENSION_NAME} detected - registering ${MCP_PACKAGE} --extension.\n` +
        `Tools arrive as mcp__playwright__*. Click the extension to share a tab.`
    : `The ${EXTENSION_NAME} extension is not installed, and only you can\n` +
        `add it:\n  ${EXTENSION_URL}\n` +
        `Until then clco registers no browser server, so no tools appear.`
}

export function extensionHint(installed: boolean, token?: string): string {
  if (!installed) {
    return (
      `Browser control needs the ${EXTENSION_NAME} extension, which only you\n` +
      `can install:\n  ${EXTENSION_URL}\n` +
      `Until then clco registers no browser server, so no tools appear.`
    )
  }
  // Whether a session is actually attached cannot be known here: the server
  // starts per conversation and the extension connects to it afterwards. A
  // stored token is the closest thing to a prediction, since it is exactly
  // what removes the manual connect step.
  return (
    `${EXTENSION_NAME} detected - registering ${MCP_PACKAGE} --extension.\n` +
    `Tools arrive as mcp__playwright__*.\n` +
    (token
      ? `Extension token stored, so sessions attach without the connect dialog.`
      : `No extension token: each session shows the connect dialog. The\n` +
        `extension offers a ${TOKEN_ENV} value - \`clco setup\` can store it.`)
  )
}
