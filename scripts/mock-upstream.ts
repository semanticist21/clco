// Minimal mock Copilot upstream for end-to-end testing without GitHub auth.
// Usage: bun run scripts/mock-upstream.ts [port]   then
//        CLCO_UPSTREAM=http://127.0.0.1:<port> clco ...

const port = Number(process.argv[2] ?? 9099)

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: async (req) => {
    const url = new URL(req.url)
    if (url.pathname === "/models") {
      return Response.json({
        data: [
          { id: "mock-opus" },
          { id: "mock-sonnet" },
          { id: "mock-haiku" },
        ],
      })
    }
    if (url.pathname !== "/chat/completions") {
      return new Response("not found", { status: 404 })
    }
    const body = (await req.json()) as { stream?: boolean; model: string }
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: "mock-1",
        model: body.model,
        choices: [{ index: 0, finish_reason: finish, delta }],
      })}\n\n`

    if (body.stream) {
      return new Response(
        [
          chunk({ role: "assistant", content: "Mock upstream 응답: 정상 동작" }),
          chunk({}, "stop"),
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    return Response.json({
      id: "mock-1",
      model: body.model,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Mock upstream 응답: 정상 동작" },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    })
  },
})

console.log(`mock upstream on http://127.0.0.1:${port}`)
