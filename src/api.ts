// Upstream endpoints, OAuth constants, and client identity headers.
// The editor identity mirrors an official Copilot Chat client, which is what
// the Copilot backend expects on api.githubcopilot.com.

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_API_BASE_URL = "https://api.github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = "read:user"
export const GITHUB_API_VERSION = "2025-04-01"

const COPILOT_CHAT_VERSION =
  process.env.CLCO_CHAT_VERSION ?? "0.26.7"
const EDITOR_VERSION = process.env.CLCO_EDITOR_VERSION ?? "1.104.0"

// Test/dev hook: point the adapter at a mock upstream; GitHub auth is skipped.
// Must be a non-empty URL — an empty string is treated as unset everywhere
// (single source of truth via isMockMode/copilotBaseUrl).
export function mockUpstream(): string | undefined {
  const value = process.env.CLCO_UPSTREAM?.trim()
  return value ? value : undefined
}

export function isMockMode(): boolean {
  return mockUpstream() !== undefined
}

// Business/Enterprise accounts get a different API host in the Copilot
// token response's endpoints.api field — official clients route there, so
// clco does too (set by token.ts after each token exchange).
let dynamicCopilotBase: string | null = null

export function setCopilotBase(url: string | null): void {
  dynamicCopilotBase =
    url && url.startsWith("https://") ? url.replace(/\/$/, "") : null
}

export function copilotBaseUrl(): string {
  return mockUpstream() ?? dynamicCopilotBase ?? "https://api.githubcopilot.com"
}

export function copilotRequestHeaders(
  token: string,
  opts?: {
    agentInitiated?: boolean
    vision?: boolean
    accept?: string
  },
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: opts?.accept ?? "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${EDITOR_VERSION}`,
    "editor-plugin-version": `copilot-chat/${COPILOT_CHAT_VERSION}`,
    "user-agent": `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
    "openai-intent": "conversation-panel",
    "x-github-api-version": GITHUB_API_VERSION,
    "x-request-id": crypto.randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
    "x-initiator": opts?.agentInitiated ? "agent" : "user",
  }
  if (opts?.vision) headers["copilot-vision-request"] = "true"
  return headers
}

export function githubRequestHeaders(githubToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `token ${githubToken}`,
    "editor-version": `vscode/${EDITOR_VERSION}`,
    "editor-plugin-version": `copilot-chat/${COPILOT_CHAT_VERSION}`,
    "user-agent": `GitHubCopilotChat/${COPILOT_CHAT_VERSION}`,
    "x-github-api-version": GITHUB_API_VERSION,
  }
}
