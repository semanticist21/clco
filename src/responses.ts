// GitHub Copilot serves newer models (GPT-5.x "luna" family, codex) through
// the OpenAI Responses API (POST /responses) instead of /chat/completions.
// This module translates Anthropic requests into Responses requests, and
// Responses SSE events into OpenAI-style chunks so the existing
// StreamTranslator can render Anthropic events unchanged.

import { effortFor, type AnthropicRequest, type OpenAIResponse } from "./translate"

// ---------------------------------------------------------------------------
// Request direction: Anthropic -> Responses
// ---------------------------------------------------------------------------

interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
}

interface ResponsesRequest {
  model: string
  instructions?: string
  input: Array<Record<string, unknown>>
  stream?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  tools?: ResponsesTool[]
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string }
  reasoning?: { effort: string }
}

export function toResponsesRequest(
  payload: AnthropicRequest,
  allowedEfforts?: string[] | null,
): ResponsesRequest {
  const input: Array<Record<string, unknown>> = []

  for (const message of payload.messages) {
    if (typeof message.content === "string") {
      input.push({
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: message.content,
          },
        ],
      })
      continue
    }

    // Tool results must land in the same order as the conversation.
    const rest: Array<Record<string, unknown>> = []
    const pendingImages: Array<Record<string, unknown>> = []
    const flushImages = () => {
      if (pendingImages.length > 0) {
        input.push({ role: "user", content: [...pendingImages] })
        pendingImages.length = 0
      }
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        // Flush pending user content before the tool output to preserve
        // ordering (results come first in Anthropic user messages anyway).
        if (rest.length > 0) {
          input.push({ role: "user", content: [...rest] })
          rest.length = 0
        }
        let text: string
        const images: Array<Record<string, unknown>> = []
        if (typeof block.content === "string") {
          text = block.content
        } else if (Array.isArray(block.content)) {
          const texts: string[] = []
          for (const b of block.content) {
            if (b.type === "text") texts.push(b.text)
            else if (b.type === "thinking") texts.push(b.thinking)
            else if (b.type === "image")
              images.push({
                type: "input_image",
                image_url: `data:${b.source.media_type};base64,${b.source.data}`,
              })
          }
          text = texts.join("\n\n")
        } else {
          text = ""
        }
        if (block.is_error) text = `[error] ${text}`
        if (images.length > 0) {
          text =
            (text ? `${text}\n\n` : "") +
            `[이미지 ${images.length}개 — 다음 사용자 메시지에 첨부됨]`
          pendingImages.push(...images)
        }
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: text,
        })
        continue
      }
      if (block.type === "text") {
        rest.push({
          type: message.role === "assistant" ? "output_text" : "input_text",
          text: block.text,
        })
      } else if (block.type === "thinking") {
        rest.push({ type: "output_text", text: block.thinking })
      } else if (block.type === "image") {
        rest.push({
          type: "input_image",
          image_url: `data:${block.source.media_type};base64,${block.source.data}`,
        })
      } else if (block.type === "tool_use") {
        if (rest.length > 0) {
          input.push({ role: message.role, content: [...rest] })
          rest.length = 0
        }
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        })
      }
    }
    if (pendingImages.length > 0 || rest.length > 0) {
      // Merge pending tool-result images with trailing text into ONE user
      // message (mirrors the chat dialect's adjacent-user-message layout).
      input.push({
        role: message.role,
        content: [...pendingImages, ...rest],
      })
      pendingImages.length = 0
    }
  }

  const instructions = Array.isArray(payload.system)
    ? payload.system.map((b) => b.text).join("\n\n")
    : payload.system

  const effort = effortFor(payload, allowedEfforts)

  return {
    model: payload.model,
    ...(instructions && { instructions }),
    ...(effort && { reasoning: { effort } }),
    input,
    stream: payload.stream,
    max_output_tokens: payload.max_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    tools: payload.tools?.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    tool_choice:
      payload.tool_choice?.type === "auto"
        ? "auto"
        : payload.tool_choice?.type === "none"
          ? "none"
          : payload.tool_choice?.type === "any"
            ? "required"
            : payload.tool_choice?.name
              ? { type: "function", name: payload.tool_choice.name }
              : undefined,
  }
}

// ---------------------------------------------------------------------------
// Event direction: Responses SSE -> OpenAI-style chunks (for StreamTranslator)
// ---------------------------------------------------------------------------

export class ResponsesEventAdapter {
  private toolIndexes = new Map<string, number>()
  private argsAccum = new Map<string, string>()
  private textAccum = new Map<string, string>()
  private nextIndex = 0
  private sawToolCall = false

  /** Convert one Responses stream event into OpenAI-chunk shape (or null). */
  pushEvent(event: Record<string, unknown>): OpenAIResponse | null {
    const type = event.type as string | undefined
    if (!type) return null

    if (type === "response.output_text.delta") {
      const delta = event.delta as string | undefined
      if (!delta) return null
      const key = String(event.item_id ?? "r")
      this.textAccum.set(key, (this.textAccum.get(key) ?? "") + delta)
      return {
        id: key,
        model: "",
        choices: [{ index: 0, finish_reason: null, delta: { content: delta } }],
      }
    }

    if (type === "response.output_text.done") {
      // Authoritative fallback: if no delta arrived for this item, emit the
      // full text so a lost stream cannot silently become an empty message.
      const key = String(event.item_id ?? "r")
      const full = (event.text as string | undefined) ?? ""
      if (full && !(this.textAccum.get(key) ?? "")) {
        return {
          id: key,
          model: "",
          choices: [{ index: 0, finish_reason: null, delta: { content: full } }],
        }
      }
      return null
    }

    if (type === "response.output_item.added") {
      const item = event.item as
        | { type?: string; call_id?: string; id?: string; name?: string }
        | undefined
      if (item?.type !== "function_call") return null
      this.sawToolCall = true
      const index = this.nextIndex++
      const key = String(item.call_id ?? item.id ?? index)
      this.toolIndexes.set(key, index)
      // Arguments deltas are keyed by item_id; remember that too.
      if (item.id) this.toolIndexes.set(String(item.id), index)
      return {
        id: String(item.call_id ?? item.id ?? "r"),
        model: "",
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              tool_calls: [
                {
                  index,
                  id: item.call_id ?? item.id,
                  function: { name: item.name ?? "", arguments: "" },
                },
              ],
            },
          },
        ],
      }
    }

    if (type === "response.function_call_arguments.delta") {
      const delta = event.delta as string | undefined
      if (!delta) return null
      const key = String(event.item_id ?? "")
      const index = this.toolIndexes.get(key)
      if (index === undefined) return null
      this.argsAccum.set(key, (this.argsAccum.get(key) ?? "") + delta)
      return {
        id: key,
        model: "",
        choices: [
          {
            index: 0,
            finish_reason: null,
            delta: {
              tool_calls: [{ index, function: { arguments: delta } }],
            },
          },
        ],
      }
    }

    if (type === "response.function_call_arguments.done") {
      const key = String(event.item_id ?? "")
      const index = this.toolIndexes.get(key)
      if (index === undefined) return null
      const full = (event.arguments as string | undefined) ?? ""
      if (full && !(this.argsAccum.get(key) ?? "")) {
        return {
          id: key,
          model: "",
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                tool_calls: [{ index, function: { arguments: full } }],
              },
            },
          ],
        }
      }
      return null
    }

    if (type === "response.completed" || type === "response.incomplete") {
      const response = event.response as
        | {
            usage?: {
              input_tokens?: number
              output_tokens?: number
              input_tokens_details?: { cached_tokens?: number }
            }
          }
        | undefined
      const usage = response?.usage
      const cached = usage?.input_tokens_details?.cached_tokens
      return {
        id: "r",
        model: "",
        choices: [
          {
            index: 0,
            finish_reason: this.sawToolCall ? "tool_calls" : "stop",
            delta: {},
          },
        ],
        usage: usage
          ? {
              prompt_tokens: usage.input_tokens,
              completion_tokens: usage.output_tokens,
              ...(cached !== undefined && {
                prompt_tokens_details: { cached_tokens: cached },
              }),
            }
          : undefined,
      }
    }

    if (type === "response.failed") {
      const response = event.response as
        | { error?: { message?: string; code?: string } }
        | undefined
      return {
        id: "r",
        model: "",
        error: {
          message: response?.error?.message ?? "upstream response failed",
          code: response?.error?.code,
        },
      } as OpenAIResponse
    }

    if (type === "error") {
      return {
        id: "r",
        model: "",
        error: {
          message: (event.message as string | undefined) ?? "upstream stream error",
        },
      } as OpenAIResponse
    }

    return null
  }
}

// ---------------------------------------------------------------------------
// Non-streaming: Responses response JSON -> OpenAI response shape
// ---------------------------------------------------------------------------

export function responsesToOpenAIResponse(
  body: Record<string, unknown>,
): OpenAIResponse {
  const output = (body.output as Array<Record<string, unknown>> | undefined) ?? []
  let text = ""
  const toolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []
  for (const item of output) {
    if (item.type === "message") {
      const content = (item.content as Array<{ type?: string; text?: string }> | undefined) ?? []
      for (const part of content) {
        if (part.type === "output_text") text += part.text ?? ""
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: String(item.call_id ?? item.id ?? ""),
        type: "function",
        function: {
          name: String(item.name ?? ""),
          arguments: String(item.arguments ?? "{}"),
        },
      })
    }
  }
  const usage = body.usage as
    | {
        input_tokens?: number
        output_tokens?: number
        input_tokens_details?: { cached_tokens?: number }
      }
    | undefined
  return {
    id: String(body.id ?? "r"),
    model: String(body.model ?? ""),
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.input_tokens,
          completion_tokens: usage.output_tokens,
          ...(usage.input_tokens_details?.cached_tokens !== undefined && {
            prompt_tokens_details: {
              cached_tokens: usage.input_tokens_details.cached_tokens,
            },
          }),
        }
      : undefined,
  }
}
