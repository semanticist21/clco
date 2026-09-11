// Launch the stock claude CLI pointed at the local adapter. Endpoint and
// model overrides are injected via `claude --settings '<json>'`, which ranks
// above user/project settings (so an existing ~/.claude/settings.json env
// block cannot swallow it) without touching any config file. The same env is
// also merged into the child process environment.

import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  advertisedId,
  familyOf,
  resolveBehavesAs,
} from "./catalog"
import {
  modelInfo,
  upstreamModels,
  type ModelMapping,
  type UpstreamModel,
} from "./token"
import { normalizeModel } from "./translate"

/** Endpoints a model must serve to hold a conversation at all. */
const CHAT_ENDPOINTS = ["/v1/messages", "/responses", "/chat/completions"]

/** Above this, Claude Code needs the [1m] suffix to unlock the real window. */
const DEFAULT_WINDOW_CEILING = 200_000

export function windowOf(m: UpstreamModel): number | undefined {
  return m.maxPromptTokens ?? m.maxContextTokens
}

export function buildSettingsEnv(
  baseUrl: string,
  models: ModelMapping,
  defaultModel?: string,
  /** Defaults to the discovery cache; injected directly in tests. */
  modelMeta?: UpstreamModel | null,
): Record<string, string> {
  const selected = defaultModel ?? models.sonnet
  // The selection may be an advertised catalog-form id; the discovery cache
  // is keyed by upstream slug, so resolve before looking it up.
  const info =
    modelMeta === undefined ? modelInfo(normalizeModel(selected)) : modelMeta
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
    // Gateway discovery is deliberately NOT enabled: Claude Code keeps only
    // ids matching /claude|anthropic/i, so it would add nothing the picker
    // lineup does not already carry — while writing a stale adapter port
    // into the user's own ~/.claude/cache/gateway-models.json.
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

// Picking a model with Enter in /model makes Claude Code write it to the
// user's own settings ("becomes the default for new sessions"), which would
// leak a Copilot slug into plain `claude` runs. clco snapshots that one key
// and puts it back when the session ends.
const USER_SETTINGS = join(homedir(), ".claude", "settings.json")

interface ModelSnapshot {
  existed: boolean
  model?: unknown
}

export async function snapshotUserModel(path: string): Promise<ModelSnapshot> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
    return { existed: true, model: parsed.model }
  } catch {
    return { existed: false }
  }
}

/** Returns true when a changed model key had to be put back. */
export async function restoreUserModel(
  path: string,
  before: ModelSnapshot,
): Promise<boolean> {
  if (!before.existed) return false
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  } catch {
    return false
  }
  if (parsed.model === before.model) return false
  if (before.model === undefined) delete parsed.model
  else parsed.model = before.model
  try {
    await writeFile(path, JSON.stringify(parsed, null, 2) + "\n")
    return true
  } catch {
    return false
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

// Claude Code's /model lineup. The picker row shape is the one the binary
// validates against: { model, label?, description?, behavesAs? }, plus a
// sibling `replaceBuiltInOptions`. Rows are validated individually — a row
// the binary rejects is dropped with a warning while the rest still apply,
// so depending on `behavesAs` degrades gracefully if the schema changes.
interface PickerOption {
  model: string
  label?: string
  description?: string
  behavesAs?: string
}

interface ModelPicker {
  options: PickerOption[]
  replaceBuiltInOptions: true
}

function routeOf(m: UpstreamModel): string {
  if (m.endpoints.includes("/v1/messages")) return "native"
  if (m.endpoints.includes("/responses")) return "responses"
  return "chat"
}

// Copilot's `model_picker_enabled` is VS Code UI metadata, not an
// entitlement — GitHub currently returns false for every model, which is why
// filtering on it emptied the lineup entirely. Filter on declared capability
// instead: `capabilities.type` is "chat" for everything you can hold a turn
// with, which drops embeddings and nothing else. Older entries omit both that
// and `supported_endpoints`; Copilot serves those over /chat/completions, and
// so does the adapter, so absent metadata must not exclude them.
function conversational(m: UpstreamModel): boolean {
  if (m.type) return m.type === "chat"
  if (m.endpoints.length === 0) return true
  return m.endpoints.some((e) => CHAT_ENDPOINTS.includes(e))
}

export function buildModelPickerFrom(
  list: UpstreamModel[],
  opts?: { selected?: string; sessionWindow?: number },
): ModelPicker | null {
  const floor = Number(process.env.CLCO_MIN_WINDOW ?? "0")
  const usable = list.filter(
    (m) => conversational(m) && (windowOf(m) ?? 0) >= floor,
  )
  const ids = list.map((m) => m.id)
  const selected = opts?.selected ? normalizeModel(opts.selected) : undefined

  const options: PickerOption[] = []
  for (const m of usable) {
    const advertised = advertisedId(m.id)
    // A row whose id Claude Code cannot resolve is silently not offered
    // unless it carries `behavesAs`, so every non-catalog row borrows one.
    const borrowed = advertised ? null : resolveBehavesAs(familyOf(m.id), ids)

    const ctx = windowOf(m)
    // [1m] is the only per-row window channel the schema has, and it is
    // binary. Claim it only where the model genuinely exceeds the default
    // ceiling — overclaiming a small model is the dangerous direction.
    const suffix = (ctx ?? 0) > DEFAULT_WINDOW_CEILING ? "[1m]" : ""
    const parts = [`Copilot · ${routeOf(m)}`]
    if (ctx) parts.push(`${Math.round(ctx / 1000)}k`)
    if (!m.efforts) parts.push("effort 없음")
    // The session's auto-compact budget is fixed at launch, so a row on a
    // different tier will not get its true window until clco restarts.
    if (ctx && opts?.sessionWindow && ctx !== opts.sessionWindow) {
      parts.push("⚠세션 한도 다름")
    }
    options.push({
      model: (advertised ?? m.id) + suffix,
      ...(m.name && m.name !== m.id ? { label: m.name } : {}),
      description: parts.join(" · "),
      ...(borrowed ? { behavesAs: borrowed } : {}),
    })
  }

  if (options.length === 0) return null
  options.sort((a, b) => rank(a, list, selected) - rank(b, list, selected))
  // Only ever set with a non-empty lineup: replacing the built-in options
  // while offering none of our own leaves /model completely empty.
  return { options: options.slice(0, 200), replaceBuiltInOptions: true }
}

// Selected model first, then native rows, then widest window first.
function rank(
  o: PickerOption,
  list: UpstreamModel[],
  selected?: string,
): number {
  const id = normalizeModel(o.model)
  if (selected && id === selected) return -1_000_000
  const m = list.find((u) => u.id === id)
  if (!m) return 0
  return (routeOf(m) === "native" ? -100_000 : 0) - (windowOf(m) ?? 0) / 1000
}

function buildModelPicker(selected?: string, sessionWindow?: number) {
  return buildModelPickerFrom(upstreamModels(), { selected, sessionWindow })
}

// The documented channel for "this provider id is really that model": a map
// from the id clco advertises to the slug the upstream wants. Where it is
// honoured the adapter receives the upstream slug directly; where it is not,
// translate.ts's alias table catches the same case. They compose.
export function buildModelOverridesFrom(
  list: UpstreamModel[],
): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const m of list) {
    const advertised = advertisedId(m.id)
    if (advertised && advertised !== m.id) out[advertised] = m.id
  }
  return Object.keys(out).length > 0 ? out : null
}

export async function runClaude(opts: {
  baseUrl: string
  models: ModelMapping
  defaultModel?: string
  claudeArgs: string[]
}): Promise<number> {
  const claude = await resolveClaude()
  const modelBefore = await snapshotUserModel(USER_SETTINGS)
  const env = buildSettingsEnv(opts.baseUrl, opts.models, opts.defaultModel)
  const picker = buildModelPicker(
    opts.defaultModel ?? opts.models.sonnet,
    Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW),
  )
  const overrides = buildModelOverridesFrom(upstreamModels())
  const settings = JSON.stringify({
    env,
    ...(picker ? { modelPicker: picker } : {}),
    ...(overrides ? { modelOverrides: overrides } : {}),
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
  if (await restoreUserModel(USER_SETTINGS, modelBefore)) {
    console.error(
      "[clco] /model 선택은 clco 세션에만 적용됩니다 — ~/.claude/settings.json의 model을 되돌렸습니다",
    )
  }
  return code ?? 0
}
