// The adapter owns a tiny vocabulary; everything dashed belongs to claude and
// bare words are typos that must fail loudly rather than start a session.
import { describe, expect, test } from "bun:test"
import { parseArgs } from "../src/cli"

describe("parseArgs", () => {
  test("dashed flags pass through to claude", () => {
    expect(parseArgs(["--chrome"])).toEqual({
      command: "run",
      port: undefined,
      claudeArgs: ["--chrome"],
    })
    expect(parseArgs(["-p", "hi"]).claudeArgs).toEqual(["-p", "hi"])
    expect(parseArgs(["--dangerously-skip-permissions"]).claudeArgs).toEqual([
      "--dangerously-skip-permissions",
    ])
  })

  test("adapter commands still win", () => {
    expect(parseArgs(["serve"]).command).toBe("serve")
    expect(parseArgs(["status"]).command).toBe("status")
    expect(parseArgs(["update"]).command).toBe("update")
    expect(parseArgs(["--port", "4141", "--chrome"])).toEqual({
      command: "run",
      port: 4141,
      claudeArgs: ["--chrome"],
    })
  })

  test("bare typos fail with the command list", () => {
    expect(() => parseArgs(["updaet"])).toThrow(/알 수 없는 명령/)
    expect(() => parseArgs(["serve", "oops"])).toThrow(/알 수 없는 명령/)
  })

  test("the launcher sentinel and -- both hand everything to claude", () => {
    expect(parseArgs(["__clco_passthrough__", "-p", "hi"]).claudeArgs).toEqual([
      "-p",
      "hi",
    ])
    expect(parseArgs(["--", "--model", "luna-5.6"]).claudeArgs).toEqual([
      "--model",
      "luna-5.6",
    ])
  })
})
