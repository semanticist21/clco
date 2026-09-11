// Integration test: the adapter server against a mock Copilot upstream,
// injected explicitly (no process.env mutation). Covers routing, auth,
// non-streaming, streaming SSE (including in-band errors and usage-only
// terminal chunks), count_tokens, and error mapping — no GitHub auth.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  sanitizeBeta,
  startServer,
  type ServerHandle,
} from "../src/server"
import { discoverModels } from "../src/token"

let upstream: ReturnType<typeof Bun.serve>
let adapter: ServerHandle
const nativeCalls: Array<{
  body: string
  beta: string | null
  version: string | null
}> = []

const AUTH = { authorization: "Bearer clco-local" }

const chunkLine = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "1",
    model: "mock-sonnet",
    choices: [{ index: 0, finish_reason: finish, delta }],
  })}`

const parseEvents = (text: string) =>
  text
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((block) => {
      const [event = "", data = ""] = block.split("\ndata: ")
      return {
        name: event.replace("event: ", ""),
        data: data ? (JSON.parse(data) as Record<string, unknown>) : {},
      }
    })

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/responses") {
        const body = (await req.json()) as {
          stream?: boolean
          model: string
          instructions?: string
          input?: unknown[]
        }
        if (!req.headers.get("copilot-integration-id")) {
          return new Response("missing header", { status: 400 })
        }
        if (body.stream) {
          const lines = [
            'data: {"type":"response.output_text.delta","delta":"Luna"}',
            "",
            'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"c1","id":"fc_1","name":"Read"}}',
            "",
            'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"f\\":1}"}',
            "",
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":6,"output_tokens":3}}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n")
          return new Response(lines, {
            headers: { "content-type": "text/event-stream" },
          })
        }
        return Response.json({
          id: "resp1",
          model: body.model,
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Luna non-stream" }],
            },
          ],
          usage: { input_tokens: 6, output_tokens: 2 },
        })
      }
      if (url.pathname === "/v1/messages") {
        nativeCalls.push({
          body: await req.text(),
          beta: req.headers.get("anthropic-beta"),
          version: req.headers.get("anthropic-version"),
        })
        const model = JSON.parse(nativeCalls[nativeCalls.length - 1]!.body).model
        if (model === "mock-native-reject") {
          return Response.json(
            { type: "error", error: { message: "unsupported" } },
            { status: 400 },
          )
        }
        if (JSON.parse(nativeCalls[nativeCalls.length - 1]!.body).stream) {
          return new Response(
            [
              'event: message_start',
              'data: {"type":"message_start","message":{"id":"msg_n","type":"message","role":"assistant","content":[],"model":"mock-native","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
              "",
              "event: content_block_start",
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
              "",
              "event: content_block_delta",
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"native hi"}}',
              "",
              "event: message_stop",
              'data: {"type":"message_stop"}',
              "",
            ].join("\n"),
            { headers: { "content-type": "text/event-stream" } },
          )
        }
        return Response.json({
          id: "msg_n",
          type: "message",
          role: "assistant",
          model: "mock-native",
          content: [{ type: "text", text: "native non-stream" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        })
      }
      if (url.pathname === "/models") {
        return Response.json({
          data: [
            { id: "mock-sonnet", name: "Mock Sonnet" },
            { id: "mock-opus", name: "Mock Opus" },
            { id: "mock-luna" },
            {
              id: "mock-native",
              name: "Mock Native",
              supported_endpoints: ["/v1/messages", "/chat/completions"],
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                limits: { max_prompt_tokens: 200000, max_context_window_tokens: 264000 },
                supports: { reasoning_effort: ["low", "medium", "high"] },
              },
            },
            {
              id: "mock-native-reject",
              supported_endpoints: ["/v1/messages", "/chat/completions"],
            },
          ],
        })
      }
      if (url.pathname !== "/chat/completions") {
        return new Response("not found", { status: 404 })
      }
      if (!req.headers.get("copilot-integration-id")) {
        return new Response("missing header", { status: 400 })
      }
      const body = (await req.json()) as {
        stream?: boolean
        model: string
        messages: Array<{ role: string; content: unknown }>
      }
      if (body.model === "mock-luna") {
        return Response.json(
          {
            error: {
              message:
                'model "mock-luna" is not accessible via the /chat/completions endpoint',
            },
          },
          { status: 400 },
        )
      }
      if (body.model === "trigger-400") {
        return Response.json(
          { error: { message: "bad schema" } },
          { status: 400 },
        )
      }
      if (body.model === "trigger-402") {
        return Response.json(
          {
            error: {
              message: "You have exceeded your monthly quota",
              code: "quota_exceeded",
            },
          },
          { status: 402 },
        )
      }
      if (body.model === "trigger-html") {
        return new Response("<html>gateway error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      }
      const lastUser = [...body.messages].reverse().find((m) => m.role === "user")
      const wantsError =
        typeof lastUser?.content === "string" &&
        (lastUser.content as string).includes("ERROR")

      if (body.stream) {
        const lines = wantsError
          ? [
              chunkLine({ role: "assistant", content: "let me" }),
              "",
              `data: ${JSON.stringify({ error: { message: "quota exhausted" } })}`,
              "",
              "data: [DONE]",
              "",
            ]
          : [
              chunkLine({ role: "assistant", content: "Hello" }),
              "",
              chunkLine({ content: " world" }),
              "",
              // Real include_usage order: finish_reason chunk, THEN the
              // usage-only terminal chunk (choices: []).
              chunkLine({}, "stop"),
              "",
              `data: ${JSON.stringify({
                id: "1",
                model: "mock-sonnet",
                choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 4 },
              })}`,
              "",
              "data: [DONE]",
              "",
            ]
        return new Response(lines.join("\n"), {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return Response.json({
        id: "1",
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Hi there" },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      })
    },
  })
  adapter = await startServer({ upstream: upstream.url.href.replace(/\/$/, "") })
  // Populate the startup model cache the same way cli.ts does (env-scoped to
  // the mock; the server itself uses the explicit upstream injection).
  process.env.CLCO_UPSTREAM = upstream.url.href.replace(/\/$/, "")
  await discoverModels()
})

afterAll(() => {
  adapter.stop()
  upstream.stop(true)
  delete process.env.CLCO_UPSTREAM
})

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${adapter.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, ...headers },
    body: JSON.stringify(body),
  })

describe("adapter server", () => {
  test("requires the injected bearer token (no port-scan oracle)", async () => {
    const hello = await fetch(`${adapter.url}/api/hello`)
    expect(hello.status).toBe(401)
    const noAuth = await fetch(`${adapter.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(noAuth.status).toBe(401)
    const body = (await noAuth.json()) as { error: { type: string } }
    expect(body.error.type).toBe("authentication_error")
  })

  test("rejects non-JSON content types", async () => {
    const res = await fetch(`${adapter.url}/v1/messages`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "text/plain" },
      body: JSON.stringify({ model: "m", messages: [] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("invalid_request_error")
  })

  test("returns Anthropic-shaped 404 for unknown paths", async () => {
    const res = await post("/nope", {})
    expect(res.status).toBe(404)
    const body = (await res.json()) as { type: string; error: { type: string } }
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("not_found_error")
  })

  test("non-streaming /v1/messages translates OpenAI -> Anthropic", async () => {
    const res = await post("/v1/messages?beta=true", {
      model: "mock-sonnet",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      type: string
      role: string
      content: Array<{ type: string; text?: string }>
      stop_reason: string
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.content[0]).toEqual({ type: "text", text: "Hi there" })
    expect(body.stop_reason).toBe("end_turn")
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 2 })
  })

  test("streaming /v1/messages emits spec-shaped Anthropic SSE events", async () => {
    const res = await post("/v1/messages", {
      model: "mock-sonnet",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const events = parseEvents(await res.text())
    const names = events.map((e) => e.name)

    expect(names[0]).toBe("ping")
    expect(names).toContain("message_start")
    expect(names).toContain("content_block_start")
    expect(names).toContain("content_block_delta")
    expect(names).toContain("content_block_stop")
    expect(names).toContain("message_delta")
    expect(names[names.length - 1]).toBe("message_stop")

    // Exact shapes (pinned against the Anthropic streaming spec).
    const start = events.find((e) => e.name === "message_start")!
    expect(start.data).toMatchObject({
      type: "message_start",
      message: {
        type: "message",
        role: "assistant",
        content: [],
        model: "mock-sonnet",
        stop_reason: null,
        stop_sequence: null,
      },
    })
    const blockStart = events.find((e) => e.name === "content_block_start")!
    expect(blockStart.data).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })

    // Concatenated text deltas reconstruct the upstream text.
    const joined = events
      .filter(
        (e) =>
          e.name === "content_block_delta" &&
          (e.data.delta as Record<string, unknown>).type === "text_delta",
      )
      .map((e) => (e.data.delta as Record<string, unknown>).text)
      .join("")
    expect(joined).toBe("Hello world")

    // Usage arrived via the usage-only terminal chunk (choices: []).
    const delta = events.find((e) => e.name === "message_delta")!
    expect(delta.data).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    })
  })

  test("in-band upstream error chunk becomes a terminal SSE error event", async () => {
    const res = await post("/v1/messages", {
      model: "mock-sonnet",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "ERROR please" }],
    })
    expect(res.status).toBe(200)
    const events = parseEvents(await res.text())
    const errorIdx = events.findIndex((e) => e.name === "error")
    expect(errorIdx).toBeGreaterThan(-1)
    // quota_exceeded gets the actionable guidance message.
    const err = events[errorIdx]!.data.error as Record<string, unknown>
    expect(err.type).toBe("invalid_request_error")
    expect(err.message).toContain("Copilot 월간 premium quota")
    // Error is terminal: no fake message_stop after it.
    expect(events.slice(errorIdx).map((e) => e.name)).not.toContain("message_stop")
  })

  test("HTTP 402 quota_exceeded maps to a terminal error with guidance", async () => {
    const res = await post("/v1/messages", {
      model: "trigger-402",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("Copilot 월간 premium quota")
  })

  test("spoofed Host header is rejected (403)", async () => {
    const res = await fetch(`${adapter.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...AUTH,
        host: "evil.example.com:9",
      },
      body: "{}",
    })
    expect(res.status).toBe(403)
  })

  test("non-stream 200 with non-JSON body maps to terminal 502", async () => {
    const res = await post("/v1/messages", {
      model: "trigger-html",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("api_error")
  })

  test("upstream 400 maps to terminal invalid_request_error", async () => {
    const res = await post("/v1/messages", {
      model: "trigger-400",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("invalid_request_error")
  })

  test("count_tokens returns an estimate", async () => {
    const res = await post("/v1/messages/count_tokens", {
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "x".repeat(350) }],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { input_tokens: number }
    expect(body.input_tokens).toBeGreaterThan(50)
  })

  test("copilotBaseUrl follows the endpoints.api from the token exchange", async () => {
    const { copilotBaseUrl, setCopilotBase } = await import("../src/api")
    expect(copilotBaseUrl()).toBe(process.env.CLCO_UPSTREAM!.replace(/\/$/, ""))
    setCopilotBase("https://api.business.githubcopilot.com")
    expect(copilotBaseUrl()).toBe(
      process.env.CLCO_UPSTREAM!.replace(/\/$/, ""),
    ) // mock mode keeps precedence
    setCopilotBase(null)
    delete process.env.CLCO_UPSTREAM
    expect(copilotBaseUrl()).toBe("https://api.githubcopilot.com")
    setCopilotBase("https://api.business.githubcopilot.com")
    expect(copilotBaseUrl()).toBe("https://api.business.githubcopilot.com")
    setCopilotBase(null)
  })

  test("GET /v1/models proxies the upstream list for model discovery", async () => {
    const res = await fetch(`${adapter.url}/v1/models?limit=1000`, {
      headers: AUTH,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ type: string; id: string; display_name: string }>
      has_more: boolean
    }
    expect(body.has_more).toBe(false)
    expect(body.data.slice(0, 3)).toEqual([
      { type: "model", id: "mock-sonnet", display_name: "Mock Sonnet" },
      { type: "model", id: "mock-opus", display_name: "Mock Opus" },
      { type: "model", id: "mock-luna", display_name: "mock-luna" },
    ])
    expect(body.data.map((m) => m.id)).toContain("mock-native")
    // Discovery requires the bearer token like every other endpoint.
    const noAuth = await fetch(`${adapter.url}/v1/models`)
    expect(noAuth.status).toBe(401)
  })

  test("Responses-only models fall back transparently (streaming)", async () => {
    const res = await post("/v1/messages", {
      model: "mock-luna",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const events = parseEvents(await res.text())
    const joined = events
      .filter(
        (e) =>
          e.name === "content_block_delta" &&
          (e.data.delta as Record<string, unknown>).type === "text_delta",
      )
      .map((e) => (e.data.delta as Record<string, unknown>).text)
      .join("")
    expect(joined).toBe("Luna")
    const toolStart = events.find(
      (e) =>
        e.name === "content_block_start" &&
        ((e.data as Record<string, unknown>).content_block as Record<
          string,
          unknown
        >).type === "tool_use",
    )
    expect(toolStart).toBeDefined()
    const delta = events.find((e) => e.name === "message_delta")!
    expect(
      ((delta.data as Record<string, unknown>).delta as Record<string, unknown>)
        .stop_reason,
    ).toBe("tool_use")
    expect((delta.data as Record<string, unknown>).usage).toEqual({
      output_tokens: 3,
    })
  })

  test("Responses-only models fall back transparently (non-streaming)", async () => {
    const res = await post("/v1/messages", {
      model: "mock-luna",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      content: Array<{ type: string; text?: string }>
      stop_reason: string
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(body.content[0]).toEqual({ type: "text", text: "Luna non-stream" })
    expect(body.stop_reason).toBe("end_turn")
    expect(body.usage).toEqual({ input_tokens: 6, output_tokens: 2 })
  })

  test("native models stream straight through, untranslated", async () => {
    nativeCalls.length = 0
    const res = await fetch(`${adapter.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...AUTH,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "some-beta,another-beta",
      },
      body: JSON.stringify({
        model: "mock-native",
        max_tokens: 32,
        stream: true,
        // Fields the translation path would drop must survive verbatim.
        thinking: { type: "enabled", budget_tokens: 1024 },
        output_config: { effort: "high" },
        system: [
          { type: "text", text: "be brief", cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // Relayed as-is: Anthropic SSE the adapter never re-encoded.
    expect(text).toContain('"type":"message_start"')
    expect(text).toContain("native hi")

    expect(nativeCalls).toHaveLength(1)
    const call = nativeCalls[0]!
    expect(call.version).toBe("2023-06-01")
    expect(call.beta).toBe("some-beta,another-beta")
    const sent = JSON.parse(call.body)
    expect(sent.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
    expect(sent.output_config).toEqual({ effort: "high" })
    expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" })
  })

  test("native models also relay non-streaming responses verbatim", async () => {
    nativeCalls.length = 0
    const res = await post("/v1/messages", {
      model: "mock-native",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      type: string
      content: Array<{ type: string; text: string }>
      usage: { input_tokens: number; output_tokens: number }
    }
    expect(body.type).toBe("message")
    expect(body.content[0]).toEqual({ type: "text", text: "native non-stream" })
    expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 2 })
  })

  test("a rejected native attempt falls back to the translation path", async () => {
    nativeCalls.length = 0
    const res = await post("/v1/messages", {
      model: "mock-native-reject",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    // Native was tried once, then the chat dialect answered.
    expect(nativeCalls).toHaveLength(1)
    const body = (await res.json()) as { content: Array<{ text: string }> }
    expect(body.content[0]!.text).toBe("Hi there")

    // The rejection is remembered: no second native attempt.
    nativeCalls.length = 0
    const again = await post("/v1/messages", {
      model: "mock-native-reject",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(again.status).toBe(200)
    expect(nativeCalls).toHaveLength(0)
  })

  test("upstream connection failures map to Anthropic error bodies", async () => {
    const dead = await startServer({ upstream: "http://127.0.0.1:1" })
    const res = await fetch(`${dead.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({
        model: "m",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    dead.stop()
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe("api_error")
  })
})

describe("sanitizeBeta", () => {
  test("drops the 1M-context beta for a model that lacks the window", () => {
    // [1m] on a picker row makes claude ask for this beta; forwarding it to a
    // model without the window makes Copilot reject the whole request.
    expect(sanitizeBeta("context-1m-2025-08-07", "mock-chat")).toBeUndefined()
    expect(
      sanitizeBeta("other-beta,context-1m-2025-08-07", "mock-chat"),
    ).toBe("other-beta")
  })

  test("leaves unrelated betas and absent headers alone", () => {
    expect(sanitizeBeta("some-beta", "mock-chat")).toBe("some-beta")
    expect(sanitizeBeta(undefined, "mock-chat")).toBeUndefined()
  })
})
