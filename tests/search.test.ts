import { describe, expect, spyOn, test } from "bun:test"
import { runSearch, searchLoop } from "../src/search"
import { WebFetchError } from "../src/webfetch"

const call = (name: string, args: Record<string, unknown>, id = "c1") => ({
  id,
  function: { name, arguments: JSON.stringify(args) },
})

describe("searchLoop", () => {
  test("returns the planner text when it makes no tool calls", async () => {
    const asks: number[] = []
    const out = await searchLoop("q", {
      ask: async (messages) => { asks.push(messages.length); return { content: "final answer", calls: [] } },
      search: async () => { throw new Error("should not search") },
      read: async () => { throw new Error("should not read") },
      synthesize: async () => "synthesized",
    })
    expect(out).toBe("final answer")
    expect(asks).toEqual([2]) // system + user
  })

  test("executes a planned search, feeds it back, and returns the conclusion", async () => {
    let round = 0
    const seen: string[] = []
    const out = await searchLoop("latest node lts", {
      ask: async (messages) => {
        round++
        if (round === 1) return { content: "", calls: [call("web_search", { query: "node lts" }, "t1")] }
        seen.push(JSON.stringify(messages))
        return { content: "Node 24 is LTS", calls: [] }
      },
      search: async (q) => { seen.push(`search:${q}`); return "1. nodejs.org: LTS schedule" },
      read: async () => { throw new Error("should not read") },
      synthesize: async () => "synthesized",
    })
    expect(out).toBe("Node 24 is LTS")
    expect(seen.some((m) => m.includes("search:node lts"))).toBe(true)
    // the tool output must reach the planner on the next turn
    expect(seen.some((m) => m.includes("LTS schedule"))).toBe(true)
  })

  test("read_article failures do not break the loop", async () => {
    let round = 0
    const out = await searchLoop("news", {
      ask: async (messages) => {
        round++
        if (round === 1) return { content: "", calls: [call("read_article", { url: "https://example.com/a" }, "r1")] }
        if (round === 2) return { content: "", calls: [call("web_search", { query: "news" }, "r2")] }
        return { content: "done", calls: [] }
      },
      search: async () => "1. result",
      read: async () => { throw new Error("boom") },
      synthesize: async () => "synthesized",
    })
    expect(out).toBe("done")
  })

  test("hits the round cap and falls back to collected material", async () => {
    const out = await searchLoop("q", {
      ask: async () => ({ content: "", calls: [call("web_search", { query: "q" }, `t${Math.random()}`)] }),
      search: async () => "1. something useful",
      read: async () => "page",
      synthesize: async (messages) => {
        // the synthesis turn must carry the gathered material and forbid tools
        const last = messages[messages.length - 1] as { content?: string }
        return last.content?.includes("Stop searching") ? `synthesized: ${JSON.stringify(messages).includes("something useful")}` : "kept searching"
      },
    })
    expect(out).toBe("synthesized: true")
  })

  test("answers every tool call while executing only three per round", async () => {
    const executed: string[] = []
    let round = 0
    const out = await searchLoop("q", {
      ask: async (messages) => {
        if (round++ === 0) return {
          content: "",
          calls: [1, 2, 3, 4].map((n) => call("web_search", { query: `q${n}` }, `c${n}`)),
        }
        const results = messages.filter((message) => message.role === "tool")
        expect(results.map((message) => message.tool_call_id)).toEqual(["c1", "c2", "c3", "c4"])
        expect(results[3]!.content).toContain("skipped")
        return { content: "done", calls: [] }
      },
      search: async (query) => { executed.push(query); return `result for ${query}` },
      read: async () => { throw new Error("should not read") },
      synthesize: async () => "synthesized",
    })
    expect(executed).toEqual(["q1", "q2", "q3"])
    expect(out).toBe("done")
  })
})

async function searchHtml(html: string, status = 200): Promise<string> {
  const previous = process.env.CLCO_UPSTREAM
  process.env.CLCO_UPSTREAM = "https://planner.example"
  let round = 0
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === "html.duckduckgo.com") {
      return new Response(html, { status, headers: { "content-type": "text/html" } })
    }
    if (url.hostname !== "planner.example") throw new Error(`unexpected fetch: ${url}`)
    if (round++ === 0) return Response.json({ choices: [{ message: {
      tool_calls: [call("web_search", { query: "q" })],
    } }] })
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }
    return Response.json({ choices: [{ message: {
      content: body.messages.find((message) => message.role === "tool")?.content,
    } }] })
  }) as typeof globalThis.fetch)
  try {
    return await runSearch("q")
  } finally {
    fetch.mockRestore()
    if (previous === undefined) delete process.env.CLCO_UPSTREAM
    else process.env.CLCO_UPSTREAM = previous
  }
}

describe("DuckDuckGo search results", () => {
  test("retains decoded redirect and direct URLs with readable titles and snippets", async () => {
    const out = await searchHtml(`
      <a class="result__a">Missing destination</a>
      <a class="result__a" href="javascript:alert(1)">Invalid destination</a>
      <a class="result__a" href="//duckduckgo.com/l/">Missing redirect target</a>
      <div class="result">
        <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle%3Fq%3Drust%26lang%3Den&amp;rut=x" class="result__a">A <b>&amp; B</b></a>
        <a class="result__snippet">Read &quot;more&quot;</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.org/docs">Docs</a>
        <div class="result__snippet">Direct <b>source</b></div>
      </div>
    `)
    expect(out).toContain("A & B")
    expect(out).toContain("https://example.com/article?q=rust&lang=en")
    expect(out).toContain('Read "more"')
    expect(out).toContain("https://example.org/docs")
    expect(out).toContain("Direct source")
    expect(out).not.toContain("duckduckgo.com/l/")
    expect(out).not.toContain("Missing")
    expect(out).not.toContain("Invalid")
  })

  test("recognizes an ordinary empty result page", async () => {
    expect(await searchHtml('<div class="no-results">No results found</div>')).toBe("(no results)")
  })

  test.each([202, 403, 500])("reports provider HTTP %d as an error", async (status) => {
    await expect(searchHtml("challenge or error", status)).rejects.toThrow(WebFetchError)
    await expect(searchHtml("challenge or error", status)).rejects.toThrow(`HTTP ${status}`)
  })

  test("reports a successful HTTP bot challenge as an error", async () => {
    await expect(searchHtml('<form id="challenge-form" action="/anomaly.js">Verify you are human</form>')).rejects.toThrow(WebFetchError)
  })

  test("does not label an unrecognized error page as no results", async () => {
    await expect(searchHtml("<h1>Something went wrong</h1>")).rejects.toThrow(WebFetchError)
  })
})
