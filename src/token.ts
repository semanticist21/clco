// Short-lived Copilot token management (exchange + cache + refresh) and
// Copilot model discovery.

import {
  GITHUB_API_BASE_URL,
  copilotBaseUrl,
  copilotFetch,
  copilotRequestHeaders,
  githubRequestHeaders,
  isMockMode,
  setCopilotBase,
} from "./api"
import { ensureGithubToken } from "./auth"
import { advertisedId } from "./catalog"
import { isTlsTrustError } from "./tls"
import { setModelAliases } from "./translate"

export interface ModelMapping {
  opus: string
  sonnet: string
  haiku: string
  fable: string
}

interface CopilotTokenResponse {
  token: string
  expires_at: number // epoch seconds
  refresh_in?: number
  // Business/Enterprise accounts are served from a different host — official
  // clients route to whatever this field names.
  endpoints?: { api?: string }
}

let cached: { token: string; expiresAt: number } | null = null
let githubToken: string | null = null
let pending: Promise<string> | null = null

const EXPIRY_MARGIN_MS = 5 * 60 * 1000

export async function getCopilotToken(force = false): Promise<string> {
  if (isMockMode()) return "mock"
  if (!force && cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return cached.token
  }
  // Deduplicate concurrent refreshes — including forced ones after a 401.
  // Any in-flight fetch returns a freshly minted token, so sharing is always
  // correct and concurrent retries never race into parallel exchanges.
  if (pending) return pending
  pending = fetchCopilotToken().finally(() => {
    pending = null
  })
  return pending
}

async function fetchCopilotToken(): Promise<string> {
  githubToken ??= (await ensureGithubToken()).token
  const res = await copilotFetch(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, {
    headers: githubRequestHeaders(githubToken),
    // Short metadata call — never let a hung connection stall startup.
    signal: AbortSignal.timeout(10_000),
  })
  if (res.status === 401 || res.status === 403) {
    // The stored GitHub token is revoked/expired — drop it so the next
    // ensureGithubToken can pick up a fresh one after re-auth.
    githubToken = null
    cached = null
    throw new Error(
      "GitHub 토큰이 거부됐습니다 — `clco auth`로 재인증하세요",
    )
  }
  if (!res.ok) {
    throw new Error(
      `Copilot 토큰 발급 실패: HTTP ${res.status} (Copilot 구독이 활성화되어 있는지 확인하세요)`,
    )
  }
  const data = (await res.json()) as CopilotTokenResponse
  if (typeof data.expires_at !== "number" || !Number.isFinite(data.expires_at)) {
    throw new Error("Copilot 토큰 응답에 expires_at이 없습니다")
  }
  cached = { token: data.token, expiresAt: data.expires_at * 1000 }
  setCopilotBase(data.endpoints?.api ?? null)
  return cached.token
}

export function invalidateCopilotToken(): void {
  cached = null
}

/**
 * Non-secret facts Copilot encodes in its own token (plan and expiry). The
 * plan is what actually explains a 402, and it needs no extra network call.
 */
export async function copilotTokenFacts(): Promise<{
  sku?: string
  expiresAt?: number
}> {
  if (isMockMode()) return {}
  const token = await getCopilotToken()
  const field = (key: string) =>
    token
      .split(";")
      .find((part) => part.startsWith(`${key}=`))
      ?.slice(key.length + 1)
  const exp = Number(field("exp"))
  return {
    sku: field("sku"),
    expiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined,
  }
}

const FALLBACK_MODELS: ModelMapping = {
  opus: "claude-opus-4.1",
  sonnet: "claude-sonnet-4.5",
  haiku: "claude-sonnet-4.5",
  fable: "claude-sonnet-4.5",
}

// Highest version wins ("claude-sonnet-4.5" > "claude-sonnet-4" > "...-3.7").
function pickModel(ids: string[], needle: string): string | undefined {
  const matches = ids.filter((id) => id.includes(needle))
  matches.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return matches[0]
}

/** What Copilot's /models tells us about one model. */
export interface UpstreamModel {
  id: string
  name: string
  /** e.g. ["/v1/messages", "/chat/completions"] — drives dialect routing. */
  endpoints: string[]
  /** Declared reasoning_effort values, or null when the model has none. */
  efforts: string[] | null
  maxPromptTokens?: number
  maxContextTokens?: number
  policyState?: string
  pickerEnabled?: boolean
  /** capabilities.type — "chat" for anything you can hold a turn with. */
  type?: string
  /** capabilities.family — a model name, or a role for internal plumbing. */
  family?: string
}

// Raw upstream model list, captured during discovery at startup. The server
// serves GET /v1/models from this so Claude Code's 3-second discovery
// timeout is never hit waiting on a live upstream fetch.
let cachedModelList: UpstreamModel[] | null = null

export function upstreamModels(): UpstreamModel[] {
  return cachedModelList ?? []
}

export function modelInfo(id: string): UpstreamModel | undefined {
  return cachedModelList?.find((m) => m.id === id)
}

/** Copilot serves Claude models through the native Anthropic endpoint. */
export function supportsNativeMessages(id: string): boolean {
  return modelInfo(id)?.endpoints.includes("/v1/messages") ?? false
}

interface RawModel {
  id?: string
  name?: string
  slug?: string
  supported_endpoints?: string[]
  model_picker_enabled?: boolean
  policy?: { state?: string }
  capabilities?: {
    type?: string
    family?: string
    limits?: { max_prompt_tokens?: number; max_context_window_tokens?: number }
    supports?: { reasoning_effort?: string[] }
  }
}

function toUpstreamModel(m: RawModel): UpstreamModel | null {
  const id = m.id ?? m.slug
  if (!id) return null
  const limits = m.capabilities?.limits
  return {
    id,
    name: m.name ?? id,
    endpoints: Array.isArray(m.supported_endpoints) ? m.supported_endpoints : [],
    efforts: Array.isArray(m.capabilities?.supports?.reasoning_effort)
      ? m.capabilities.supports.reasoning_effort
      : null,
    maxPromptTokens: numberOrUndefined(limits?.max_prompt_tokens),
    maxContextTokens: numberOrUndefined(limits?.max_context_window_tokens),
    policyState: m.policy?.state,
    pickerEnabled: m.model_picker_enabled,
    type: m.capabilities?.type,
    family: m.capabilities?.family,
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

// Why discovery fell back, if it did. Held rather than printed so the caller
// can surface it after its spinner stops.
let softFailure: string | null = null

export function takeDiscoverySoftFailure(): string | null {
  const out = softFailure
  softFailure = null
  return out
}

// Resolve Copilot model slugs for Claude Code's opus/sonnet/haiku slots.
// Priority: env overrides > Copilot /models discovery > hardcoded fallback.
export async function discoverModels(): Promise<ModelMapping> {
  softFailure = null
  const env = (name: string) => process.env[name]?.trim() || undefined
  const overrides = {
    opus: env("CLCO_OPUS"),
    sonnet: env("CLCO_SONNET"),
    haiku: env("CLCO_HAIKU"),
    fable: env("CLCO_FABLE"),
  }
  let reason = ""
  try {
    const token = await getCopilotToken()
    const res = await copilotFetch(`${copilotBaseUrl()}/models`, {
      headers: copilotRequestHeaders(token),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const body = (await res.json()) as {
        data?: RawModel[]
        models?: RawModel[]
      }
      const raw = body.models ?? body.data ?? []
      cachedModelList = raw
        .map(toUpstreamModel)
        .filter((m): m is UpstreamModel => m !== null)
      // Teach the translator every id the picker is about to advertise, so a
      // model chosen by its catalog-form id still reaches the right slug.
      setModelAliases(
        new Map(
          cachedModelList.flatMap((m) => {
            const advertised = advertisedId(m.id)
            return advertised && advertised !== m.id
              ? ([[advertised, m.id]] as [string, string][])
              : []
          }),
        ),
      )
      const ids = cachedModelList.map((m) => m.id)
      const opus = overrides.opus ?? pickModel(ids, "claude-opus")
      const sonnet = overrides.sonnet ?? pickModel(ids, "claude-sonnet")
      const haiku =
        overrides.haiku ??
        pickModel(ids, "claude-haiku") ??
        pickModel(ids, "claude-sonnet")
      const fable =
        overrides.fable ??
        pickModel(ids, "claude-fable") ??
        sonnet ??
        FALLBACK_MODELS.fable
      if (sonnet) {
        return {
          opus: opus ?? FALLBACK_MODELS.opus,
          sonnet,
          haiku: haiku ?? FALLBACK_MODELS.haiku,
          fable,
        }
      }
    }
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
    // A broken trust chain is not a "carry on with fallback slugs" situation
    // — it is the user's actual blocker, and every later request will fail
    // the same way. Let it reach main().catch so the TLS hint gets printed.
    if (isTlsTrustError(reason)) throw err
  }
  // Reported by the caller after any progress spinner has stopped; printing
  // here would be painted over by the spinner that wraps this call.
  softFailure =
    `[clco] Copilot /models 감지 실패 (${copilotBaseUrl()}${reason ? `: ${reason}` : ""})` +
    ` — 기본 슬러그 사용 (CLCO_OPUS/SONNET/HAIKU로 지정 가능)`
  return {
    opus: overrides.opus ?? FALLBACK_MODELS.opus,
    sonnet: overrides.sonnet ?? FALLBACK_MODELS.sonnet,
    haiku: overrides.haiku ?? FALLBACK_MODELS.haiku,
    fable: overrides.fable ?? FALLBACK_MODELS.fable,
  }
}
