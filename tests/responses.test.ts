// The Responses-API fallback: models Copilot serves only via POST /responses
// (GPT-5.x "luna" family) must work transparently, both streaming and not.

import { describe, expect, test } from "bun:test"
import { toResponsesRequest, ResponsesEventAdapter, responsesToOpenAIResponse } from "../src/responses"

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
