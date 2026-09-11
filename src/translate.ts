// Translation between the Anthropic Messages API (what Claude Code speaks)
// and GitHub Copilot's OpenAI-style chat/completions API.
//
// Request direction happens once per call; the response direction comes in
// two flavors: non-streaming (translateResponse) and streaming (a
// StreamTranslator state machine fed OpenAI chunks, emitting Anthropic SSE
// events).

// ---------------------------------------------------------------------------
// Anthropic types (subset Claude Code actually sends)
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  type: "text"
  text: string
}

interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
}

interface AnthropicImageBlock {
  type: "image"
  source: { type: string; media_type: string; data: string }
}

interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  is_error?: boolean
  content?:
    | string
    | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicThinkingBlock>
}

type AnthropicUserBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock

type AnthropicAssistantBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock

interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | Array<AnthropicUserBlock | AnthropicAssistantBlock>
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string | Array<AnthropicTextBlock>
  tools?: AnthropicTool[]
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string }
  stream?: boolean
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  metadata?: { user_id?: string }
  thinking?: unknown
}

// ---------------------------------------------------------------------------
// OpenAI types (subset Copilot accepts)
// ---------------------------------------------------------------------------

interface OpenAITextPart {
  type: "text"
  text: string
}

interface OpenAIImagePart {
  type: "image_url"
  image_url: { url: string }
}

type OpenAIContent = string | Array<OpenAITextPart | OpenAIImagePart> | null

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: OpenAIContent
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  stop?: string[] | null
  stream?: boolean
  stream_options?: { include_usage: boolean }
  temperature?: number
  top_p?: number
  user?: string | null
  tools?: Array<{
    type: "function"
    function: {
      name: string
      description?: string
      parameters: Record<string, unknown>
    }
  }> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
}

interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface OpenAIChoice {
  index: number
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  message?: { role: "assistant"; content: OpenAIContent; tool_calls?: OpenAIToolCall[] }
  delta?: {
    role?: string
    content?: string | null
    tool_calls?: Array<{
      index: number
      id?: string
      function?: { name?: string; arguments?: string }
    }>
  }
}

export interface OpenAIResponse {
  id: string
  model: string
  choices?: OpenAIChoice[]
  usage?: OpenAIUsage
  error?: { message?: string; code?: string | number }
}

// ---------------------------------------------------------------------------
// Anthropic response types
// ---------------------------------------------------------------------------

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock

export interface AnthropicResponse {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: AnthropicContentBlock[]
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | null
  stop_sequence: null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
  }
}

export interface StreamEventData {
  event: string
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Request direction: Anthropic -> OpenAI
// ---------------------------------------------------------------------------

// Copilot slugs are dot-form ("claude-sonnet-4.5"). Claude Code may echo back
// dash-form, a date suffix, or a bracket suffix like [1m]; normalize all.
export function normalizeModel(model: string): string {
  let m = model.replace(/\[[^\]]*\]$/, "")
  m = m.replace(/-\d{8}$/, "")
  m = m.replace(
    /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/,
    "claude-$1-$2.$3",
  )
  m = m.replace(/^claude-(\d+)-(\d+)-(sonnet|haiku|opus)$/, "claude-$1.$2-$3")
  return m
}

function debugWarn(message: string): void {
  if (process.env.CLCO_DEBUG) console.error("[clco:debug]", message)
}

function toImagePart(block: AnthropicImageBlock): OpenAIImagePart {
  return {
    type: "image_url",
    image_url: {
      url: `data:${block.source.media_type};base64,${block.source.data}`,
    },
  }
}

// Tool messages must carry string content (OpenAI schema); images are moved
// into the adjacent user message instead, otherwise one image tool_result
// would poison every subsequent request in the session.
function toolResultText(result: AnthropicToolResultBlock): {
  text: string
  images: OpenAIImagePart[]
} {
  const images: OpenAIImagePart[] = []
  let text: string
  if (typeof result.content === "string") {
    text = result.content
  } else if (Array.isArray(result.content)) {
    const texts: string[] = []
    for (const block of result.content) {
      if (block.type === "text") texts.push(block.text)
      else if (block.type === "thinking") texts.push(block.thinking)
      else if (block.type === "image") images.push(toImagePart(block))
    }
    text = texts.join("\n\n")
  } else {
    text = ""
  }
  if (result.is_error) text = `[error] ${text}`
  if (images.length > 0) {
    text =
      (text ? `${text}\n\n` : "") +
      `[이미지 ${images.length}개 — 다음 사용자 메시지에 첨부됨]`
  }
  return { text, images }
}

function translateUserMessage(message: AnthropicMessage): OpenAIMessage[] {
  if (typeof message.content === "string") {
    return [{ role: "user", content: message.content }]
  }
  const out: OpenAIMessage[] = []
  const toolResults = message.content.filter(
    (b): b is AnthropicToolResultBlock => b.type === "tool_result",
  )
  const rest = message.content.filter((b) => b.type !== "tool_result")

  // Protocol order: tool_use -> tool_result -> user.
  const images: OpenAIImagePart[] = []
  for (const result of toolResults) {
    const { text, images: resultImages } = toolResultText(result)
    images.push(...resultImages)
    out.push({ role: "tool", tool_call_id: result.tool_use_id, content: text })
  }

  const restTexts: string[] = []
  const restImages: OpenAIImagePart[] = []
  for (const block of rest) {
    if (block.type === "text") restTexts.push(block.text)
    else if (block.type === "thinking") restTexts.push(block.thinking)
    else if (block.type === "image") restImages.push(toImagePart(block))
  }

  if (images.length > 0 || restImages.length > 0) {
    const parts: Array<OpenAITextPart | OpenAIImagePart> = [
      ...images,
      ...restImages,
    ]
    const text = restTexts.join("\n\n")
    if (text) parts.push({ type: "text", text })
    out.push({ role: "user", content: parts })
  } else if (rest.length > 0) {
    out.push({ role: "user", content: restTexts.join("\n\n") })
  }
  return out
}

function translateAssistantMessage(message: AnthropicMessage): OpenAIMessage[] {
  if (typeof message.content === "string") {
    return [{ role: "assistant", content: message.content }]
  }
  const toolUses = message.content.filter(
    (b): b is AnthropicToolUseBlock => b.type === "tool_use",
  )
  // OpenAI has no thinking blocks; fold them into text (they are usually
  // empty here anyway because CLAUDE_CODE_DISABLE_THINKING is set).
  const text = message.content
    .filter(
      (b): b is AnthropicTextBlock | AnthropicThinkingBlock =>
        b.type === "text" || b.type === "thinking",
    )
    .map((b) => (b.type === "text" ? b.text : b.thinking))
    .join("\n\n")

  if (toolUses.length > 0) {
    return [
      {
        role: "assistant",
        content: text || null,
        tool_calls: toolUses.map((use) => ({
          id: use.id,
          type: "function" as const,
          function: {
            name: use.name,
            arguments: JSON.stringify(use.input),
          },
        })),
      },
    ]
  }
  return [{ role: "assistant", content: text }]
}

function translateSystem(
  system: AnthropicRequest["system"],
): OpenAIMessage[] {
  if (!system) return []
  const text =
    typeof system === "string"
      ? system
      : system.map((b) => b.text).join("\n\n")
  return [{ role: "system", content: text }]
}

function translateTools(
  tools: AnthropicRequest["tools"],
): OpenAIRequest["tools"] {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
}

function translateToolChoice(
  choice: AnthropicRequest["tool_choice"],
): OpenAIRequest["tool_choice"] {
  if (!choice) return undefined
  switch (choice.type) {
    case "auto":
      return "auto"
    case "any":
      return "required"
    case "none":
      return "none"
    case "tool":
      return choice.name
        ? { type: "function", function: { name: choice.name } }
        : undefined
    default:
      return undefined
  }
}

export function translateRequest(payload: AnthropicRequest): OpenAIRequest {
  return {
    model: normalizeModel(payload.model),
    messages: [
      ...translateSystem(payload.system),
      ...payload.messages.flatMap((message) =>
        message.role === "user"
          ? translateUserMessage(message)
          : translateAssistantMessage(message),
      ),
    ],
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences?.length ? payload.stop_sequences : null,
    stream: payload.stream,
    stream_options: payload.stream ? { include_usage: true } : undefined,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id ?? null,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
  }
}

// ---------------------------------------------------------------------------
// Response direction: OpenAI -> Anthropic (non-streaming)
// ---------------------------------------------------------------------------

function mapStopReason(
  finish: OpenAIChoice["finish_reason"],
): AnthropicResponse["stop_reason"] {
  if (finish === null) return null
  switch (finish) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    case "content_filter":
      return "end_turn"
  }
}

function usageFromOpenAI(usage: OpenAIUsage | undefined) {
  const cached = usage?.prompt_tokens_details?.cached_tokens
  return {
    input_tokens: Math.max(
      0,
      (usage?.prompt_tokens ?? 0) - (cached ?? 0),
    ),
    output_tokens: usage?.completion_tokens ?? 0,
    ...(cached !== undefined && { cache_read_input_tokens: cached }),
  }
}

export function translateResponse(upstream: OpenAIResponse): AnthropicResponse {
  const choice = upstream.choices?.[0]
  const content: AnthropicContentBlock[] = []

  const messageContent = choice?.message?.content
  if (typeof messageContent === "string" && messageContent.length > 0) {
    content.push({ type: "text", text: messageContent })
  } else if (Array.isArray(messageContent)) {
    for (const part of messageContent) {
      if (part.type === "text") content.push({ type: "text", text: part.text })
    }
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(call.function.arguments || "{}") as Record<
        string,
        unknown
      >
    } catch {
      // Malformed arguments: fall back to empty input rather than failing.
    }
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    })
  }
  if (content.length === 0) content.push({ type: "text", text: "" })

  let stopReason = mapStopReason(choice?.finish_reason ?? null)
  // "tool_use" with no tool_use block is not a valid Anthropic response.
  if (stopReason === "tool_use" && !content.some((b) => b.type === "tool_use")) {
    stopReason = "end_turn"
  }

  return {
    id: upstream.id,
    type: "message",
    role: "assistant",
    model: upstream.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usageFromOpenAI(upstream.usage),
  }
}

// ---------------------------------------------------------------------------
// Response direction: OpenAI SSE chunks -> Anthropic stream events
// ---------------------------------------------------------------------------

interface ToolTrack {
  anthropicIndex: number
  id: string
  name: string
  bufferedArgs: string
  started: boolean
  open: boolean
}

export class StreamTranslator {
  private messageStartSent = false
  private textOpen = false
  private textIndex = -1
  private nextIndex = 0
  private toolCalls = new Map<number, ToolTrack>()
  private anyToolStarted = false
  private latestUsage: OpenAIUsage | undefined
  private lastFinishReason: OpenAIChoice["finish_reason"] = null
  private finished = false

  constructor(private model: string) {}

  pushChunk(chunk: OpenAIResponse): StreamEventData[] {
    // Nothing may be emitted after the message closed.
    if (this.finished) return []
    const events: StreamEventData[] = []
    // Usage may arrive in a dedicated terminal chunk with empty choices
    // (stream_options include_usage convention); track it from any chunk.
    if (chunk.usage) this.latestUsage = chunk.usage
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const choice = choices[0]
    if (!choice) return events
    const delta = choice.delta

    if (!this.messageStartSent) {
      events.push(this.messageStart(chunk.model || this.model))
    }

    if (delta?.content) {
      // Tool blocks must all close before a text block starts (Anthropic
      // blocks are strictly sequential).
      this.closeOpenTools(events)
      if (!this.textOpen) {
        this.textIndex = this.nextIndex++
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: this.textIndex,
            content_block: { type: "text", text: "" },
          },
        })
        this.textOpen = true
      }
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.textIndex,
          delta: { type: "text_delta", text: delta.content },
        },
      })
    }

    if (delta?.tool_calls) {
      for (const call of delta.tool_calls) {
        let track = this.toolCalls.get(call.index)
        if (!track) {
          track = {
            anthropicIndex: -1,
            id: "",
            name: "",
            bufferedArgs: "",
            started: false,
            open: false,
          }
          this.toolCalls.set(call.index, track)
        }
        // id and name may arrive in separate fragments; only start the block
        // once both are known.
        if (call.id) track.id = call.id
        if (call.function?.name) track.name = call.function.name
        if (!track.started && track.id && track.name) {
          if (this.textOpen) {
            events.push({
              event: "content_block_stop",
              data: { type: "content_block_stop", index: this.textIndex },
            })
            this.textOpen = false
          }
          track.anthropicIndex = this.nextIndex++
          track.started = true
          track.open = true
          this.anyToolStarted = true
          events.push({
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: track.anthropicIndex,
              content_block: {
                type: "tool_use",
                id: track.id,
                name: track.name,
                input: {},
              },
            },
          })
          if (track.bufferedArgs) {
            events.push(this.jsonDelta(track.anthropicIndex, track.bufferedArgs))
            track.bufferedArgs = ""
          }
        }
        if (call.function?.arguments) {
          if (track.started && track.open) {
            events.push(this.jsonDelta(track.anthropicIndex, call.function.arguments))
          } else if (track.started) {
            debugWarn(
              `dropped ${call.function.arguments.length} chars of late tool arguments (block ${track.anthropicIndex} already closed)`,
            )
          } else {
            // Arguments before id/name: buffer until the block starts.
            track.bufferedArgs += call.function.arguments
          }
        }
      }
    }

    // Do NOT close here: with stream_options.include_usage the usage-only
    // terminal chunk arrives AFTER the finish_reason chunk, and close()
    // needs it. Store the reason and let finish() (stream end) close.
    if (choice.finish_reason) {
      this.lastFinishReason = choice.finish_reason
    }
    return events
  }

  // Upstream ended. Use the stored finish_reason; without one the generation
  // was truncated (connection death, [DONE] without a terminal chunk),
  // which Anthropic signals as max_tokens.
  finish(): StreamEventData[] {
    if (this.finished) return []
    return this.close(this.lastFinishReason ?? "length")
  }

  private jsonDelta(index: number, partialJson: string): StreamEventData {
    return {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: partialJson },
      },
    }
  }

  private messageStart(model: string): StreamEventData {
    this.messageStartSent = true
    const usage = this.latestUsage
    const cached = usage?.prompt_tokens_details?.cached_tokens
    return {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - (cached ?? 0)),
            output_tokens: 0,
            ...(cached !== undefined && { cache_read_input_tokens: cached }),
          },
        },
      },
    }
  }

  private closeOpenTools(events: StreamEventData[]): void {
    const open = [...this.toolCalls.values()]
      .filter((t) => t.open)
      .sort((a, b) => a.anthropicIndex - b.anthropicIndex)
    for (const track of open) {
      events.push({
        event: "content_block_stop",
        data: { type: "content_block_stop", index: track.anthropicIndex },
      })
      track.open = false
    }
  }

  private close(
    reason: NonNullable<OpenAIChoice["finish_reason"]>,
  ): StreamEventData[] {
    if (this.finished) return []
    this.finished = true
    const events: StreamEventData[] = []
    if (!this.messageStartSent) {
      events.push(this.messageStart(this.model))
    }
    this.closeOpenTools(events)
    if (this.textOpen) {
      events.push({
        event: "content_block_stop",
        data: { type: "content_block_stop", index: this.textIndex },
      })
      this.textOpen = false
    }
    let stopReason = mapStopReason(reason)
    if (stopReason === "tool_use" && !this.anyToolStarted) {
      stopReason = "end_turn"
    }
    events.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: this.latestUsage?.completion_tokens ?? 0 },
      },
    })
    events.push({ event: "message_stop", data: { type: "message_stop" } })
    return events
  }
}

// ---------------------------------------------------------------------------
// count_tokens approximation (Claude Code falls back to its own estimate if
// this endpoint is missing, but a local estimate keeps /context accurate)
// ---------------------------------------------------------------------------

export function estimateTokens(payload: AnthropicRequest): number {
  const size =
    JSON.stringify(payload.messages ?? "").length +
    JSON.stringify(payload.system ?? "").length +
    JSON.stringify(payload.tools ?? "").length
  return Math.ceil(size / 3.5)
}
