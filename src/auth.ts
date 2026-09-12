// GitHub OAuth device flow. The resulting user token (gho_...) is long-lived
// and stored via config.ts; it is exchanged for short-lived Copilot tokens in
// token.ts.

import {
  GITHUB_API_BASE_URL,
  GITHUB_APP_SCOPES,
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  copilotFetch,
  githubRequestHeaders,
  isMockMode,
} from "./api"
import { loadAuth, saveAuth } from "./config"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface GithubIdentity {
  token: string
  login?: string
  fresh: boolean
}

export async function ensureGithubToken(): Promise<GithubIdentity> {
  // Mock mode (CLCO_UPSTREAM set): no GitHub involved at all.
  if (isMockMode()) {
    return { token: "mock", fresh: false }
  }
  const saved = await loadAuth()
  if (saved?.github_token) {
    return { token: saved.github_token, login: saved.login, fresh: false }
  }
  const { token, login } = await runDeviceFlow()
  return { token, login, fresh: true }
}

export async function runDeviceFlow(): Promise<{ token: string; login?: string }> {
  const res = await copilotFetch(`${GITHUB_BASE_URL}/login/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_APP_SCOPES,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`device code request failed: HTTP ${res.status}`)
  }
  const dc = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
  }

  console.log("\nGitHub authentication required:")
  console.log(`  1. Open in your browser: ${dc.verification_uri}`)
  console.log(`  2. Enter the code: \x1b[1m${dc.user_code}\x1b[0m\n`)

  if (process.platform === "darwin") {
    const open = Bun.spawn(["open", dc.verification_uri], {
      stdout: "ignore",
      stderr: "ignore",
    })
    await open.exited.catch(() => {})
  }

  let interval = (dc.interval + 1) * 1000
  const deadline = Date.now() + dc.expires_in * 1000
  while (Date.now() < deadline) {
    await sleep(interval)
    let body: {
      access_token?: string
      error?: string
      error_description?: string
    }
    try {
      const poll = await copilotFetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: dc.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!poll.ok) {
        // 4xx won't heal by waiting; 5xx might.
        if (poll.status >= 400 && poll.status < 500) {
          throw new Error(`device flow polling failed: HTTP ${poll.status}`)
        }
        console.error(`[clco] polling error HTTP ${poll.status} - retrying`)
        continue
      }
      body = (await poll.json()) as typeof body
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("device flow")) throw err
      continue
    }

    if (body.access_token) {
      const token = body.access_token
      let login: string | undefined
      try {
        const user = await copilotFetch(`${GITHUB_API_BASE_URL}/user`, {
          headers: githubRequestHeaders(token),
        })
        if (user.ok) login = ((await user.json()) as { login?: string }).login
      } catch {
        // login display is best-effort
      }
      await saveAuth({ github_token: token, login })
      return { token, login }
    }
    if (body.error === "slow_down") {
      interval += 5000
    } else if (body.error && body.error !== "authorization_pending") {
      throw new Error(
        `device flow failed: ${body.error} ${body.error_description ?? ""}`,
      )
    }
  }
  throw new Error("device flow timed out")
}
