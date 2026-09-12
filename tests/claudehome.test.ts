import { describe, expect, test } from "bun:test"
import { mkdir, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { prepareClaudeHome } from "../src/claudehome"

const run = (home: string) => prepareClaudeHome(home)

describe("prepareClaudeHome", () => {
  test("shares behaviour, privatises what claude writes", async () => {
    const home = join(tmpdir(), `clco-home-${Date.now()}`)
    const real = join(home, ".claude")
    await mkdir(join(real, "skills"), { recursive: true })
    await writeFile(join(real, "CLAUDE.md"), "# shared\n")
    // A leftover Copilot slug must not be carried into the private copy.
    await writeFile(
      join(real, "settings.json"),
      JSON.stringify({ model: "gpt-4.1", env: { KEEP: "1" } }),
    )
    await writeFile(join(home, ".claude.json"), JSON.stringify({ trusted: true }))

    const dir = await run(home)
    expect(dir).not.toBeNull()

    // Behaviour-shaping entries stay live links to the real tree.
    expect((await lstat(join(dir!, "skills"))).isSymbolicLink()).toBe(true)
    expect((await lstat(join(dir!, "CLAUDE.md"))).isSymbolicLink()).toBe(true)

    // settings.json is a real file, so claude's write lands here, and the
    // stale model key is dropped rather than seeding the next session.
    const settings = JSON.parse(
      await readFile(join(dir!, "settings.json"), "utf8"),
    )
    expect((await lstat(join(dir!, "settings.json"))).isSymbolicLink()).toBe(false)
    expect(settings.model).toBeUndefined()
    expect(settings.env).toEqual({ KEEP: "1" })

    // Writing through the private dir must never reach the user's file.
    await writeFile(
      join(dir!, "settings.json"),
      JSON.stringify({ model: "kimi-k3" }),
    )
    const userSettings = JSON.parse(
      await readFile(join(real, "settings.json"), "utf8"),
    )
    expect(userSettings.model).toBe("gpt-4.1")

    // Trust and MCP state is seeded once, then owned by clco.
    expect(JSON.parse(await readFile(join(dir!, ".claude.json"), "utf8"))).toEqual({
      trusted: true,
    })
    await writeFile(join(dir!, ".claude.json"), JSON.stringify({ trusted: false }))
    await run(home)
    expect(JSON.parse(await readFile(join(dir!, ".claude.json"), "utf8"))).toEqual({
      trusted: false,
    })

    // A newly added entry shows up without any cache to clear.
    await writeFile(join(real, "later.md"), "x")
    await run(home)
    expect(await readdir(dir!)).toContain("later.md")

    await rm(home, { recursive: true, force: true })
  })

  test("returns null when there is no config dir to mirror", async () => {
    const home = join(tmpdir(), `clco-empty-${Date.now()}`)
    await mkdir(home, { recursive: true })
    expect(await run(home)).toBeNull()
    await rm(home, { recursive: true, force: true })
  })
})
