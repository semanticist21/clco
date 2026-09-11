// Launch the stock claude CLI pointed at the local adapter. Endpoint and
// model overrides are injected via `claude --settings '<json>'`, which ranks
// above user/project settings (so an existing ~/.claude/settings.json env
// block cannot swallow it) without touching any config file. The same env is
// also merged into the child process environment.

import { homedir } from "node:os"
import {
  modelInfo,
  upstreamModels,
  type ModelMapping,
  type UpstreamModel,
} from "./token"

export function buildSettingsEnv(
  baseUrl: string,
  models: ModelMapping,
  defaultModel?: string,
  /** Defaults to the discovery cache; injected directly in tests. */
  modelMeta?: UpstreamModel | null,
): Record<string, string> {
  const selected = defaultModel ?? models.sonnet
  const info = modelMeta === undefined ? modelInfo(selected) : modelMeta
  // Claude models are served through Copilot's native Anthropic endpoint, so
  // the adapter forwards thinking blocks untouched; only the translation
  // dialects need them suppressed.
  const native = info?.endpoints.includes("/v1/messages") === true
  // Prefer the upstream's own prompt budget so auto-compact fires before the
  // model rejects the conversation.
  const window = info?.maxPromptTokens ?? info?.maxContextTokens ?? 160000

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "clco-local",
    ANTHROPIC_MODEL: selected,
    ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
    ANTHROPIC_DEFAULT_FABLE_MODEL: models.fable,
    // Let /model list every model the upstream offers (adapter proxies
    // Copilot's /models at GET /v1/models).
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Keep traffic contained: no auto-update, telemetry, or side calls.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    // Translation dialects drop thinking blocks; the native one keeps them.
    ...(native ? {} : { CLAUDE_CODE_DISABLE_THINKING: "1" }),
    // Model slugs are unknown to Claude Code's context-window table.
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    // Never inherit a larger user setting than the upstream actually accepts.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window),
    // Slow upstream: never abort a stream for idling.
    API_FORCE_IDLE_TIMEOUT: "0",
    API_TIMEOUT_MS: "3000000",
  }
}

let resolvedClaude: string | null = null

// Resolve and verify the claude binary. Called before the adapter binds a
// port so a missing binary fails fast with an actionable message.
export async function resolveClaude(): Promise<string> {
  if (resolvedClaude) return resolvedClaude
  const candidate = Bun.which("claude") ?? `${homedir()}/.local/bin/claude`
  if (!(await Bun.file(candidate).exists())) {
    throw new Error(
      `claude 실행 파일을 찾을 수 없습니다: ${candidate} (PATH 또는 ~/.local/bin 확인)`,
    )
  }
  resolvedClaude = candidate
  return candidate
}

// One process-level SIGTERM handler tracking the current child — registering
// per runClaude call would stack handlers whose stale closures can kill a
// newer run.
let currentChild: Bun.Subprocess<"inherit", "inherit", "inherit"> | null = null
let escalateTimer: ReturnType<typeof setTimeout> | undefined
process.on("SIGTERM", () => {
  if (!currentChild) process.exit(143) // serve mode: no child to forward to
  try {
    currentChild.kill("SIGTERM")
  } catch {
    // already exited
  }
  escalateTimer ??= setTimeout(() => {
    try {
      currentChild?.kill("SIGKILL")
    } catch {
      // already exited
    }
    process.exit(143)
  }, 5000)
})

// Put every model the upstream offers into /model directly, with its own
// label. Claude's gateway-discovery filter only keeps ids containing
// "claude"/"anthropic", but a modelPicker lineup accepts any id verbatim.
interface PickerEntry {
  id: string
  name?: string
  description?: string
}

// Claude Code's gateway discovery only keeps ids containing "claude" or
// "anthropic", so every other Copilot model (luna, astra, grok, gemini…)
// can only reach /model through an explicit modelPicker lineup.
export function buildModelPickerFrom(list: UpstreamModel[]): PickerEntry[] | null {
  const usable = list.filter((m) => m.pickerEnabled !== false)
  if (usable.length === 0) return null
  return usable.slice(0, 200).map((m) => {
    const route = m.endpoints.includes("/v1/messages")
      ? "native"
      : m.endpoints.includes("/responses")
        ? "responses"
        : "chat"
    const ctx = m.maxPromptTokens ?? m.maxContextTokens
    return {
      id: m.id,
      ...(m.name && m.name !== m.id ? { name: m.name } : {}),
      description: `Copilot · ${route}${ctx ? ` · ${Math.round(ctx / 1000)}k` : ""}`,
    }
  })
}

function buildModelPicker() {
  return buildModelPickerFrom(upstreamModels())
}

export async function runClaude(opts: {
  baseUrl: string
  models: ModelMapping
  defaultModel?: string
  claudeArgs: string[]
}): Promise<number> {
  const claude = await resolveClaude()
  const env = buildSettingsEnv(opts.baseUrl, opts.models, opts.defaultModel)
  const picker = buildModelPicker()
  const settings = JSON.stringify({
    env,
    ...(picker ? { modelPicker: picker } : {}),
  })

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
  }
  // Never let a parent-exported key override the adapter routing.
  delete childEnv.ANTHROPIC_API_KEY

  const proc = Bun.spawn(
    [claude, "--settings", settings, ...opts.claudeArgs],
    {
      stdio: ["inherit", "inherit", "inherit"],
      env: childEnv,
    },
  )
  currentChild = proc

  const code = await proc.exited
  if (currentChild === proc) {
    currentChild = null
    if (escalateTimer) {
      clearTimeout(escalateTimer)
      escalateTimer = undefined
    }
  }
  return code ?? 0
}
