// Semi-native web search: Copilot's dedicated search-agent model plans the
// queries (copilot-search-a; GitHub's own web-search planner, callable with
// the same OAuth token), execution is ours - DuckDuckGo HTML for results and
// the local fetcher for pages - and the planner synthesizes the final answer.
// Verified live 2026-09-13: the planner emits real read_article URLs only
// after live results are fed back, so information genuinely flows web ->
// model. Rounds are capped; any failure surfaces as WebFetchError.
import { getCopilotToken } from "./token"
import { copilotBaseUrl, copilotFetch, copilotRequestHeaders } from "./api"
import { fetchContent, WebFetchError } from "./webfetch"
import { parseHTML } from "linkedom"

export const SEARCH_AGENT = process.env.CLCO_SEARCH_AGENT ?? "copilot-search-a"
const MAX_ROUNDS = 4
const MAX_CALLS_PER_ROUND = 3
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"

type ToolCall = { id: string; function: { name: string; arguments: string } }
type Msg = Record<string, unknown>

async function chat(token: string, messages: Msg[], withTools = true): Promise<{ content: string; calls: ToolCall[] }> {
  const res = await copilotFetch(`${copilotBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: copilotRequestHeaders(token, { accept: "application/json" }),
    body: JSON.stringify({
      model: SEARCH_AGENT,
      messages,
      ...(withTools
        ? {
            tools: [
              { type: "web_search" },
              { type: "function", function: { name: "read_article", description: "Read a web page by URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
            ],
          }
        : {}),
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new WebFetchError(`search agent failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }> }
  const message = json.choices?.[0]?.message ?? {}
  return { content: message.content ?? "", calls: message.tool_calls ?? [] }
}

async function ddg(query: string): Promise<string> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok || res.status === 202) throw new WebFetchError(`web_search DuckDuckGo failed: HTTP ${res.status}`)
  const { document } = parseHTML(await res.text())
  if (document.querySelector('#anomaly-form, #challenge-form, .anomaly-modal, form[action*="anomaly.js"]')) {
    throw new WebFetchError("web_search DuckDuckGo returned a bot challenge; try again later")
  }
  const results: string[] = []
  for (const anchor of document.querySelectorAll(".result__a")) {
    const rawHref = anchor.getAttribute("href")
    if (!rawHref) continue
    let url: URL
    try {
      const href = new URL(rawHref, "https://html.duckduckgo.com")
      const destination = /(^|\.)duckduckgo\.com$/.test(href.hostname) && href.pathname === "/l/"
        ? href.searchParams.get("uddg")
        : href.href
      if (!destination) continue
      url = new URL(destination)
    } catch { continue }
    if (!["http:", "https:"].includes(url.protocol)) continue
    const title = anchor.textContent?.replace(/\s+/g, " ").trim() ?? ""
    if (!title) continue
    const snippet = anchor.closest(".result")?.querySelector(".result__snippet")?.textContent?.replace(/\s+/g, " ").trim() ?? ""
    results.push(`${results.length + 1}. ${title}\n${url.href}\n${snippet.slice(0, 250)}`)
    if (results.length === 5) break
  }
  if (results.length > 0) return results.join("\n")
  if (document.querySelector(".no-results, .result--no-result")) return "(no results)"
  throw new WebFetchError("web_search could not parse DuckDuckGo results")
}

async function readUrl(url: string): Promise<string> {
  const { text } = await fetchContent(url, 4_000)
  return text
}

type LoopDeps = {
  /** One planner turn: returns its text plus any tool calls it wants. */
  ask: (messages: Msg[]) => Promise<{ content: string; calls: ToolCall[] }>
  /** Execute a search query. */
  search: (query: string) => Promise<string>
  /** Read a page by URL. */
  read: (url: string) => Promise<string>
  /** Final answer from gathered material; must not plan more tool calls. */
  synthesize: (messages: Msg[]) => Promise<string>
}

/** The planner/executor loop, injectable for tests. */
export async function searchLoop(query: string, deps: LoopDeps): Promise<string> {
  const messages: Msg[] = [
    {
      role: "system",
      content:
        "You are a web research assistant. Always call web_search FIRST to find live results; never guess or construct URLs yourself - only read_article URLs that appeared in web_search results. Finish with a concise answer and list the sources you used.",
    },
    { role: "user", content: query },
  ]
  const done = new Map<string, string>()
  let material = ""
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { content, calls } = await deps.ask(messages)
    if (!calls.length) return content.trim() || material || "(no results)"
    messages.push({ role: "assistant", content: content || null, tool_calls: calls })
    for (const [index, call] of calls.entries()) {
      if (index >= MAX_CALLS_PER_ROUND) {
        messages.push({ role: "tool", tool_call_id: call.id, content: `(skipped: limit of ${MAX_CALLS_PER_ROUND} tool calls per round)` })
        continue
      }
      let args: { query?: string; url?: string } = {}
      try { args = JSON.parse(call.function.arguments || "{}") } catch { /* empty args stay empty */ }
      // Re-running a failed or finished call only burns rounds; replay it.
      const key = `${call.function.name}:${args.query ?? args.url ?? ""}`
      let output = done.get(key)
      if (output === undefined) {
        if (call.function.name === "read_article" && args.url) {
          output = await deps.read(args.url).catch((error) => `(fetch failed: ${(error as Error).message}. Use web_search to find a working source.)`)
          material += `\n(source) ${args.url}\n${output.slice(0, 300)}`
        } else {
          output = await deps.search(args.query ?? query)
          material += `\n${output}`
        }
        done.set(key, output)
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: output })
    }
  }
  // The planner always wants one more round, so conclude without tools:
  // answer the original question from the gathered material only.
  return (
    await deps.synthesize([
      ...messages,
      { role: "user", content: "Stop searching. Answer the original question using only the results gathered above. Be concise and list the sources you used." },
    ])
  ).trim() || material.trim()
}

/** One search: plan with the agent, execute, feed back, return the answer. */
export async function runSearch(query: string): Promise<string> {
  const token = await getCopilotToken()
  return searchLoop(query, {
    ask: (messages) => chat(token, messages),
    search: ddg,
    read: readUrl,
    synthesize: async (messages) => (await chat(token, messages, false)).content,
  })
}
