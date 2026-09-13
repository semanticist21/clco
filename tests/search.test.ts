import { describe, expect, test } from "bun:test"
import { searchLoop } from "../src/search"

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
})
