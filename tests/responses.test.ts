// The Responses-API fallback: models Copilot serves only via POST /responses
// (GPT-5.x "luna" family) must work transparently, both streaming and not.

import { describe, expect, test } from "bun:test"
import {
  toResponsesRequest,
  ResponsesEventAdapter,
  responsesToOpenAIResponse,
} from "../src/responses"

describe("toResponsesRequest", () => {
  test("system -> instructions; tool rounds -> function_call / function_call_output", () => {
    const out = toResponsesRequest({
      model: "gpt-5.6-luna",
      max_tokens: 64,
      system: [{ type: "text", text: "be brief" }],
      tools: [
        { name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
      ],
      tool_choice: { type: "any" },
      messages: [
        { role: "user", content: "read /x" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" },
            { type: "text", text: "go on" },
          ],
        },
      ],
    })
    expect(out.instructions).toBe("be brief")
    expect(out.model).toBe("gpt-5.6-luna")
    expect(out.tools).toEqual([
      { type: "function", name: "Read", description: "read", parameters: { type: "object", properties: {} } },
    ])
    expect(out.tool_choice).toBe("required")
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "read /x" }] },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "checking" }],
      },
      { type: "function_call", call_id: "t1", name: "Read", arguments: '{"file_path":"/x"}' },
      { type: "function_call_output", call_id: "t1", output: "[error] boom" },
      { role: "user", content: [{ type: "input_text", text: "go on" }] },
    ])
  })
})

describe("ResponsesEventAdapter", () => {
  test("maps text deltas, tool calls, usage, and failures to OpenAI chunks", () => {
    const adapter = new ResponsesEventAdapter()
    expect(adapter.pushEvent({ type: "response.created" })).toBeNull()

    const text = adapter.pushEvent({ type: "response.output_text.delta", delta: "He" })!
    expect(text!.choices?.[0]?.delta).toEqual({ content: "He" })

    const call = adapter.pushEvent({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "c1", id: "fc_1", name: "Read" },
    })!
    expect(call!.choices?.[0]?.delta?.tool_calls?.[0]).toMatchObject({
      index: 0,
      id: "c1",
      function: { name: "Read" },
    })

    const args = adapter.pushEvent({
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      delta: '{"a":1}',
    })
    expect(args!.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toBe('{"a":1}')

    const done = adapter.pushEvent({
      type: "response.completed",
      response: { usage: { input_tokens: 7, output_tokens: 3 } },
    })
    expect(done!.choices?.[0]?.finish_reason).toBe("tool_calls")
    expect(done?.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3 })

    const failed = adapter.pushEvent({
      type: "response.failed",
      response: { error: { message: "quota exhausted" } },
    })
    expect(failed?.error?.message).toBe("quota exhausted")
  })

  test("reasoning.effort is clamped to the model's declared values", () => {
    const base = {
      model: "gpt-5.6-luna",
      max_tokens: 8,
      messages: [{ role: "user" as const, content: "hi" }],
      output_config: { effort: "max" },
    }
    expect(toResponsesRequest(base, ["low", "medium", "high", "max"]).reasoning).toEqual({
      effort: "max",
    })
    expect(toResponsesRequest(base, ["low", "medium", "high"]).reasoning).toBeUndefined()
    expect(toResponsesRequest(base).reasoning).toBeUndefined()
  })

  test("images in tool_result become a placeholder + adjacent input_image user item", () => {
    const out = toResponsesRequest({
      model: "gpt-5.6-luna",
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "shot:" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              ],
            },
            { type: "text", text: "what is it?" },
          ],
        },
      ],
    })
    // function_call_output keeps string text with a placeholder,
    // images ride on the adjacent user item as input_image parts.
    expect(out.input[0]).toEqual({
      type: "function_call_output",
      call_id: "t1",
      output: "shot:\n\n[이미지 1개 — 다음 사용자 메시지에 첨부됨]",
    })
    expect(out.input[1]).toEqual({
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        { type: "input_text", text: "what is it?" },
      ],
    })
  })

  test(".done events rescue streams whose deltas were lost", () => {
    const adapter = new ResponsesEventAdapter()
    // Tool args: header arrives, delta is lost, .done carries the full JSON.
    adapter.pushEvent({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "c1", id: "fc_1", name: "Read" },
    })
    const done = adapter.pushEvent({
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      arguments: '{"file_path":"/x"}',
    })!
    expect(done.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments).toBe(
      '{"file_path":"/x"}',
    )
    // When deltas DID arrive, .done emits nothing (no duplication).
    const adapter2 = new ResponsesEventAdapter()
    adapter2.pushEvent({
      type: "response.output_item.added",
      item: { type: "function_call", call_id: "c2", id: "fc_2", name: "Read" },
    })
    adapter2.pushEvent({
      type: "response.function_call_arguments.delta",
      item_id: "fc_2",
      delta: '{"file"',
    })
    expect(
      adapter2.pushEvent({
        type: "response.function_call_arguments.done",
        item_id: "fc_2",
        arguments: '{"file_path":"/x"}',
      }),
    ).toBeNull()
    // Text .done fallback when the delta never arrived.
    const adapter3 = new ResponsesEventAdapter()
    const textDone = adapter3.pushEvent({
      type: "response.output_text.done",
      item_id: "msg_1",
      text: "lost-and-found",
    })!
    expect(textDone.choices?.[0]?.delta?.content).toBe("lost-and-found")
  })

  test("completed usage maps cached_tokens into prompt_tokens_details", () => {
    const adapter = new ResponsesEventAdapter()
    const done = adapter.pushEvent({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 4 },
        },
      },
    })!
    expect(done.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 4 },
    })
  })

  test("responsesToOpenAIResponse flattens message and function_call output items", () => {
    const out = responsesToOpenAIResponse({
      id: "resp1",
      model: "gpt-5.6-luna",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hi " }, { type: "output_text", text: "there" }] },
        { type: "function_call", call_id: "c9", name: "Bash", arguments: '{"cmd":"ls"}' },
      ],
      usage: { input_tokens: 4, output_tokens: 5 },
    })
    expect(out.choices?.[0]?.finish_reason).toBe("tool_calls")
    expect(out.choices?.[0]?.message?.content).toBe("hi there")
    expect(out.choices?.[0]?.message?.tool_calls).toEqual([
      { id: "c9", type: "function", function: { name: "Bash", arguments: '{"cmd":"ls"}' } },
    ])
    expect(out.usage).toEqual({ prompt_tokens: 4, completion_tokens: 5 })
  })
})
