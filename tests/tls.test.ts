import { describe, expect, test } from "bun:test"
import { isTlsTrustError } from "../src/tls"
import { registryStatus } from "../src/browsermcp"

// These are the literal messages and codes Bun's fetch produces, measured
// against local TLS servers built with openssl-minted certs. The predicate
// used to be a regex over the message alone, and it silently missed the third
// row - a proxy presenting a leaf without shipping its intermediate, which is
// the most ordinary corporate shape there is. That failure was reported as an
// unreachable host, so the user was sent to their firewall team instead of
// being told to set CLCO_CA_BUNDLE. Nothing tested this predicate at all,
// which is why it stayed missed.
describe("isTlsTrustError", () => {
  const trust: Array<[string, string]> = [
    ["self signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT"],
    ["self signed certificate in certificate chain", "SELF_SIGNED_CERT_IN_CHAIN"],
    ["unable to verify the first certificate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    ["unable to get local issuer certificate", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"],
  ]

  test.each(trust)("%s is a trust failure", (message, code) => {
    expect(isTlsTrustError(Object.assign(new Error(message), { code }))).toBe(true)
    // The code is the reliable signal, so it has to win on its own - a future
    // Bun could reword any of these messages.
    expect(isTlsTrustError(Object.assign(new Error("something else"), { code }))).toBe(
      true,
    )
    // And the message has to still work alone: server.ts and cli.ts stringify.
    expect(isTlsTrustError(message)).toBe(true)
  })

  // Reaching for the CA here would be wrong advice: nothing about the chain
  // failed.
  test.each([
    ["The operation timed out.", "TimeoutError"],
    ["Unable to connect. Is the computer able to access the url?", "ConnectionRefused"],
    ["Failed to lookup host", "DNS_ENOTFOUND"],
  ])("%s is not a trust failure", (message, code) => {
    expect(isTlsTrustError(Object.assign(new Error(message), { code }))).toBe(false)
  })

  // Bun nests the real cause on some fetch failures.
  test("looks through cause", () => {
    const inner = Object.assign(new Error("self signed certificate"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    })
    expect(isTlsTrustError(Object.assign(new Error("fetch failed"), { cause: inner }))).toBe(
      true,
    )
  })
})

// The mapping from a failed probe to a word the user reads was the substance
// of the change and had no test: the rendering tests were fed a status that
// had already been decided.
describe("registryStatus", () => {
  test("a refused connection is blocked, not a TLS problem", async () => {
    // Port 1 with nothing on it: refused, not re-signed.
    expect(await registryStatus(2500, "https://127.0.0.1:1/probe")).toBe("blocked")
  })

  test("a timeout is its own answer", async () => {
    // 10.255.255.1 is non-routable, so the connection hangs rather than being
    // refused - which is what a slow proxy looks like.
    expect(await registryStatus(50, "https://10.255.255.1/probe")).toBe("slow")
  })
})
