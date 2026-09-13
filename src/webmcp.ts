// Session-scoped MCP server exposing one tool: web_search. The heavy lifting
// lives in search.ts (planner + execution loop); this file is the stdio
// JSON-RPC wrapper Claude Code talks to.
import { runSearch, SEARCH_AGENT } from "./search"
import { WebFetchError } from "./webfetch"
import { loadAuth } from "./config"

type Rpc = { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown> }
function reply(id: Rpc["id"], result: unknown): void { if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n") }
function failure(message: string): { content: [{ type: "text"; text: string }]; isError: true } { return { content: [{ type: "text", text: message }], isError: true } }

const tools = [
  { name: "web_search", description: `Search the web: queries are planned by ${SEARCH_AGENT} and executed live.`, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
]

async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    if (name === "web_search") {
      if (!(await loadAuth())?.github_token && !process.env.CLCO_UPSTREAM) return failure("GitHub authentication is required; run `clco login` before using web search")
      return { content: [{ type: "text", text: await runSearch(String(args.query ?? "")) }] }
    }
    return failure(`unknown web tool: ${name}`)
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error))
  }
}

process.stdin.setEncoding("utf8")
let input = ""
let queue = Promise.resolve()
process.stdin.on("data", (chunk: string) => {
  input += chunk
  for (const line of input.split("\n").slice(0, -1)) queue = queue.then(() => handle(line))
  input = input.split("\n").pop() ?? ""
})
async function handle(line: string): Promise<void> {
  if (!line.trim()) return
  let message: Rpc
  try { message = JSON.parse(line) as Rpc } catch { return }
  if (message.method === "initialize") return reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "clco-web", version: "0.1.0" } })
  if (message.method === "ping") return reply(message.id, {})
  if (message.method === "tools/list") return reply(message.id, { tools })
  if (message.method === "tools/call") { const params = message.params ?? {}; return reply(message.id, await call(String(params.name), (params.arguments ?? {}) as Record<string, unknown>)) }
  if (message.id !== undefined) reply(message.id, { error: { code: -32601, message: `Method not found: ${message.method}` } })
}
