import { describe, expect, spyOn, test } from "bun:test"
import * as dns from "node:dns/promises"
import { fetchContent, WebFetchError } from "../src/webfetch"

function mockLookup(address: string) {
  const result = { address, family: address.includes(":") ? 6 : 4 }
  return spyOn(dns, "lookup").mockImplementation((async (_hostname: string, options?: number | { all?: boolean }) =>
    typeof options === "object" && options.all ? [result] : result) as typeof dns.lookup)
}

describe("web_fetch DNS pinning", () => {
  test.each([
    ["2606:4700:4700::1111", "https://[2606:4700:4700::1111]:8443/article"],
    ["93.184.215.14", "https://93.184.215.14:8443/article"],
  ])("connects to checked address %s while preserving the original host", async (address, expectedUrl) => {
    const lookup = mockLookup(address)
    const seen: Array<{ url: string; host: string | null; serverName?: string }> = []
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
      seen.push({
        url: String(input),
        host: new Headers(init?.headers).get("host"),
        serverName: (init as RequestInit & { tls?: { serverName: string } }).tls?.serverName,
      })
      return new Response("article", { headers: { "content-type": "text/plain" } })
    }) as typeof globalThis.fetch)
    try {
      expect(await fetchContent("https://articles.example:8443/article")).toMatchObject({ text: "article" })
      expect(seen).toEqual([{ url: expectedUrl, host: "articles.example:8443", serverName: "articles.example" }])
    } finally {
      lookup.mockRestore()
      fetch.mockRestore()
    }
  })

  test("still blocks a private IPv6 result before fetching", async () => {
    const lookup = mockLookup("::1")
    const fetch = spyOn(globalThis, "fetch")
    try {
      await expect(fetchContent("https://articles.example/article")).rejects.toThrow(WebFetchError)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      lookup.mockRestore()
      fetch.mockRestore()
    }
  })
})
