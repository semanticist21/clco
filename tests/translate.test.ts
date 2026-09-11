import { describe, expect, test } from "bun:test"
import {
  StreamTranslator,
  estimateTokens,
  normalizeModel,
  translateRequest,
  translateResponse,
  type OpenAIResponse,
} from "../src/translate"

describe("translateRequest", () => {
  test("merges system blocks into a single system message", () => {
    const out = translateRequest({
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      system: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.messages).toEqual([
      { role: "system", content: "a\n\nb" },
      { role: "user", content: "hi" },
    ])
    expect(out.max_tokens).toBe(100)
  })

  test("emits tool results before user text", () => {
    const out = translateRequest({
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { file_path: "/x" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "file body" }],
            },
            { type: "text", text: "and also" },
          ],
        },
      ],
    })
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: "let me check",
        tool_calls: [
          {
            id: "t1",
            type: "function",
            function: { name: "Read", arguments: '{"file_path":"/x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "t1", content: "file body" },
      { role: "user", content: "and also" },
    ])
  })

  test("folds assistant thinking into text and drops request thinking", () => {
    const out = translateRequest({
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "go on" },
      ],
    })
    expect("thinking" in out).toBe(false)
    expect(out.messages[0]).toEqual({ role: "assistant", content: "hmm\n\nanswer" })
  })

  test("maps tools and tool_choice", () => {
    const out = translateRequest({
      model: "claude-sonnet-4.5",
      max_tokens: 100,
      tool_choice: { type: "any" },
      tools: [
        {
          name: "Read",
          description: "read a file",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "Read",
          description: "read a file",
          parameters: { type: "object", properties: {} },
        },
      },
    ])
    expect(out.tool_choice).toBe("required")
  })

  test("tool_result is_error gets an [error] prefix", () => {
    const out = translateRequest({
      model: "m",
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: "boom",
            },
          ],
        },
      ],
    })
    expect(out.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "t1",
      content: "[error] boom",
    })
  })

  test("images in tool_result move to the adjacent user message (tool stays string)", () => {
    const out = translateRequest({
      model: "m",
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "screenshot:" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              ],
            },
          ],
        },
      ],
    })
    const tool = out.messages[0] as { role: string; content: unknown }
    expect(tool.role).toBe("tool")
    expect(typeof tool.content).toBe("string")
    expect(tool.content).toContain("[이미지 1개")
    const user = out.messages[1] as unknown as {
      role: string
      content: Array<Record<string, unknown>>
    }
    expect(user.role).toBe("user")
    expect(user.content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    })
  })

  test("empty stop_sequences coerce to null; streaming sets stream_options", () => {
    const out = translateRequest({
      model: "m",
      max_tokens: 1,
      stop_sequences: [],
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.stop).toBeNull()
    expect(out.stream_options).toEqual({ include_usage: true })
    const nonStream = translateRequest({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(nonStream.stream_options).toBeUndefined()
  })

  test("normalizeModel strips date/bracket suffixes and dot-ifies known slugs", () => {
    expect(normalizeModel("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
    expect(normalizeModel("claude-sonnet-4-5-20250929")).toBe(
      "claude-sonnet-4.5",
    )
    expect(normalizeModel("claude-opus-4-1-20250805")).toBe("claude-opus-4.1")
    expect(normalizeModel("claude-sonnet-4-5[1m]")).toBe("claude-sonnet-4.5")
    expect(normalizeModel("claude-3-5-sonnet-20241022")).toBe(
      "claude-3.5-sonnet",
    )
    expect(normalizeModel("claude-3-7-sonnet")).toBe("claude-3.7-sonnet")
    expect(normalizeModel("gpt-5")).toBe("gpt-5")
  })
})

describe("translateResponse", () => {
  test("maps text, tool calls, stop reason, and usage cache", () => {
    const out = translateResponse({
      id: "r1",
      model: "claude-sonnet-4.5",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "reading",
            tool_calls: [
              {
                id: "call1",
                type: "function",
                function: { name: "Read", arguments: '{"file_path":"/x"}' },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    })
    expect(out.stop_reason).toBe("tool_use")
    expect(out.content).toEqual([
      { type: "text", text: "reading" },
      {
        type: "tool_use",
        id: "call1",
        name: "Read",
        input: { file_path: "/x" },
      },
    ])
    expect(out.usage).toEqual({
      input_tokens: 60,
      output_tokens: 20,
      cache_read_input_tokens: 40,
    })
  })

  test("maps finish reasons", () => {
    const mk = (finish: "stop" | "length" | "tool_calls" | "content_filter" | null) =>
      translateResponse({
        id: "r",
        model: "m",
        choices: [
          {
            index: 0,
            finish_reason: finish,
            message: { role: "assistant", content: "x" },
          },
        ],
      }).stop_reason
    expect(mk("stop")).toBe("end_turn")
    expect(mk("length")).toBe("max_tokens")
    expect(mk("content_filter")).toBe("end_turn")
    // tool_calls without any tool_use block downgrades to end_turn (covered
    // explicitly in the next test); with tool calls it stays tool_use.
    expect(mk(null)).toBeNull()
  })

  test("downgrades tool_use stop reason when no tool block was emitted", () => {
    const out = translateResponse({
      id: "r",
      model: "m",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: { role: "assistant", content: "x" },
        },
      ],
    })
    expect(out.stop_reason).toBe("end_turn")
  })

  test("never returns an empty content array", () => {
    const out = translateResponse({
      id: "r",
      model: "m",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: null },
        },
      ],
    })
    expect(out.content).toEqual([{ type: "text", text: "" }])
  })
})

describe("StreamTranslator", () => {
  const chunk = (
    delta: Record<string, unknown>,
    finish_reason: string | null = null,
    usage?: OpenAIResponse["usage"],
  ): OpenAIResponse =>
    ({
      id: "1",
      model: "m",
      usage,
      choices: [
        {
          index: 0,
          finish_reason: finish_reason as "stop",
          delta,
        },
      ],
    }) as unknown as OpenAIResponse

  const rawChunk = (body: Record<string, unknown>): OpenAIResponse =>
    body as unknown as OpenAIResponse

  test("streams text deltas into one block, then tool_use with json deltas", () => {
    const t = new StreamTranslator("m")
    const events = [
      ...t.pushChunk(chunk({ role: "assistant", content: "Hel" })),
      ...t.pushChunk(chunk({ content: "lo" })), // must NOT close/reopen block
      ...t.pushChunk(
        chunk({
          tool_calls: [
            { index: 0, id: "call1", function: { name: "Read", arguments: "" } },
          ],
        }),
      ),
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }),
      ),
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }),
      ),
      ...t.pushChunk(chunk({}, "tool_calls")),
      ...t.finish(),
    ]

    const types = events.map((e) => e.event)
    expect(types[0]).toBe("message_start")
    expect(types[types.length - 1]).toBe("message_stop")

    // text block opened once, appended twice
    const textStarts = events.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data as Record<string, unknown>).content_block !== undefined &&
        ((e.data as Record<string, unknown>).content_block as Record<string, unknown>)
          .type === "text",
    )
    expect(textStarts).toHaveLength(1)
    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data as Record<string, unknown>).delta !== undefined &&
        ((e.data as Record<string, unknown>).delta as Record<string, unknown>)
          .type === "text_delta",
    )
    expect(textDeltas).toHaveLength(2)

    // tool_use block: start at index 1, json deltas, then stop
    const toolStart = events.find(
      (e) =>
        e.event === "content_block_start" &&
        ((e.data as Record<string, unknown>).content_block as Record<
          string,
          unknown
        >).type === "tool_use",
    )
    expect(toolStart).toBeDefined()
    const toolStartIdx = (toolStart!.data as Record<string, unknown>).index
    expect(toolStartIdx).toBe(1)
    const jsonDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data as Record<string, unknown>).delta !== undefined &&
        ((e.data as Record<string, unknown>).delta as Record<string, unknown>)
          .type === "input_json_delta",
    )
    const joined = jsonDeltas
      .map(
        (e) =>
          (((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .partial_json as string),
      )
      .join("")
    expect(joined).toBe('{"a":1}')

    const messageDelta = events.find((e) => e.event === "message_delta")
    expect((messageDelta!.data as Record<string, unknown>).delta).toEqual({
      stop_reason: "tool_use",
      stop_sequence: null,
    })
  })

  test("parallel tool calls: every delta lands between its own start/stop", () => {
    const t = new StreamTranslator("m")
    const events = [
      // Both call headers arrive in ONE chunk.
      ...t.pushChunk(
        chunk({
          tool_calls: [
            { index: 0, id: "call_a", function: { name: "Read", arguments: "" } },
            { index: 1, id: "call_b", function: { name: "Bash", arguments: "" } },
          ],
        }),
      ),
      // Interleaved argument fragments.
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }),
      ),
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 1, function: { arguments: '{"b":2}' } }] }),
      ),
      ...t.pushChunk(chunk({}, "tool_calls")),
      ...t.finish(),
    ]

    // For every content_block_index, no input_json_delta may appear after its
    // content_block_stop (order-aware walk).
    const closed = new Set<number>()
    for (const e of events) {
      const index = (e.data as Record<string, unknown>).index as number
      if (e.event === "content_block_stop") {
        closed.add(index)
        continue
      }
      if (e.event !== "content_block_delta") continue
      const delta = (e.data as Record<string, unknown>).delta as Record<
        string,
        unknown
      >
      if (delta.type === "input_json_delta") {
        expect(closed.has(index)).toBe(false)
      }
    }

    const toolStarts = events.filter(
      (e) =>
        e.event === "content_block_start" &&
        ((e.data as Record<string, unknown>).content_block as Record<
          string,
          unknown
        >).type === "tool_use",
    )
    expect(toolStarts).toHaveLength(2)
    // No text block preceded: tool blocks take indices 0 and 1.
    expect((toolStarts[0]!.data as Record<string, unknown>).index).toBe(0)
    expect((toolStarts[1]!.data as Record<string, unknown>).index).toBe(1)

    const allJson = events
      .filter(
        (e) =>
          e.event === "content_block_delta" &&
          ((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .type === "input_json_delta",
      )
      .map(
        (e) =>
          (((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .partial_json as string),
      )
      .join("")
    expect(allJson).toBe('{"a":1}{"b":2}')
  })

  test("tool-call fragment with id only is not dropped; buffered args flush on start", () => {
    const t = new StreamTranslator("m")
    const events = [
      // id and arguments arrive BEFORE the function name.
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, id: "call_x", function: { arguments: '{"pre"' } }] }),
      ),
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, function: { name: "Read" } }] }),
      ),
      ...t.pushChunk(
        chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
      ),
      ...t.pushChunk(chunk({}, "tool_calls")),
      ...t.finish(),
    ]
    const toolStart = events.find(
      (e) =>
        e.event === "content_block_start" &&
        ((e.data as Record<string, unknown>).content_block as Record<
          string,
          unknown
        >).type === "tool_use",
    )
    expect(toolStart).toBeDefined()
    expect(
      ((toolStart!.data as Record<string, unknown>).content_block as Record<
        string,
        unknown
      >).id,
    ).toBe("call_x")
    const allJson = events
      .filter(
        (e) =>
          e.event === "content_block_delta" &&
          ((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .type === "input_json_delta",
      )
      .map(
        (e) =>
          (((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .partial_json as string),
      )
      .join("")
    expect(allJson).toBe('{"pre":1}')
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect(
      ((messageDelta!.data as Record<string, unknown>).delta as Record<
        string,
        unknown
      >).stop_reason,
    ).toBe("tool_use")
  })

  test("text after tool calls closes tool blocks first with sequential indices", () => {
    const t = new StreamTranslator("m")
    const events = [
      ...t.pushChunk(
        chunk({
          tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "{}" } }],
        }),
      ),
      ...t.pushChunk(chunk({ content: "done" })),
    ]
    const stops = events
      .filter((e) => e.event === "content_block_stop")
      .map((e) => (e.data as Record<string, unknown>).index)
    expect(stops).toEqual([0]) // tool block (index 0) closed when text started
    const textDeltaIdx = (
      events.find(
        (e) =>
          e.event === "content_block_delta" &&
          ((e.data as Record<string, unknown>).delta as Record<string, unknown>)
            .type === "text_delta",
      )!.data as Record<string, unknown>
    ).index
    expect(textDeltaIdx).toBe(1)
  })

  test("usage-only terminal chunk AFTER finish_reason feeds message_delta (real order)", () => {
    const t = new StreamTranslator("m")
    const events = [
      ...t.pushChunk(chunk({ content: "hi" })),
      // Real include_usage order: finish_reason FIRST, usage-only chunk LAST.
      ...t.pushChunk(chunk({}, "stop")),
      ...t.pushChunk(
        rawChunk({ id: "1", model: "m", choices: [], usage: { prompt_tokens: 9, completion_tokens: 7 } }),
      ),
      ...t.finish(),
    ]
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect((messageDelta!.data as Record<string, unknown>).usage).toEqual({
      output_tokens: 7,
    })
    expect(
      ((messageDelta!.data as Record<string, unknown>).delta as Record<string, unknown>)
        .stop_reason,
    ).toBe("end_turn")
  })

  test("message_start is emitted exactly once regardless of chunk count", () => {
    const t = new StreamTranslator("m")
    const events = [
      ...t.pushChunk(chunk({ content: "a" })),
      ...t.pushChunk(chunk({ content: "b" })),
      ...t.pushChunk(chunk({ content: "c" })),
      ...t.pushChunk(chunk({}, "stop")),
      ...t.finish(),
    ]
    expect(events.filter((e) => e.event === "message_start")).toHaveLength(1)
  })

  test("chunks after the stream closed are ignored", () => {
    const t = new StreamTranslator("m")
    t.pushChunk(chunk({ content: "x" }))
    t.finish()
    expect(t.pushChunk(chunk({ content: "late" }))).toEqual([])
  })

  test("error-key chunk (no choices) is skipped without throwing", () => {
    const t = new StreamTranslator("m")
    expect(() =>
      t.pushChunk(rawChunk({ error: { message: "quota exhausted" } })),
    ).not.toThrow()
  })

  test("finish() closes an unterminated stream as max_tokens (truncation)", () => {
    const t = new StreamTranslator("m")
    const events = [...t.pushChunk(chunk({ content: "par" })), ...t.finish()]
    const types = events.map((e) => e.event)
    expect(types[0]).toBe("message_start")
    expect(types[types.length - 1]).toBe("message_stop")
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect(
      ((messageDelta!.data as Record<string, unknown>).delta as Record<
        string,
        unknown
      >).stop_reason,
    ).toBe("max_tokens")
  })

  test("finish() with no chunks still emits a complete empty message", () => {
    const t = new StreamTranslator("m")
    const events = t.finish()
    const types = events.map((e) => e.event)
    expect(types).toEqual(["message_start", "message_delta", "message_stop"])
    // Exact Anthropic shapes (pinned, not just event names).
    const start = events[0]!.data as Record<string, unknown>
    expect(start.type).toBe("message_start")
    const message = start.message as Record<string, unknown>
    expect(message).toMatchObject({
      type: "message",
      role: "assistant",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    const delta = events[1]!.data as Record<string, unknown>
    expect(delta).toEqual({
      type: "message_delta",
      delta: { stop_reason: "max_tokens", stop_sequence: null },
      usage: { output_tokens: 0 },
    })
  })
})

describe("estimateTokens", () => {
  test("scales with content size", () => {
    const small = estimateTokens({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    const large = estimateTokens({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "x".repeat(3500) }],
    })
    expect(small).toBeGreaterThan(0)
    expect(large).toBeGreaterThan(small * 10)
  })
})
