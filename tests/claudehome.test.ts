import { describe, expect, test } from "bun:test"
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
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

  // Returning null hands the child the user's own ~/.claude, where a /model
  // pick persists - and the snapshot/restore that used to cover that is gone.
  // A missing ~/.claude is no reason to give that up; the private dir works
  // fine empty.
  test("isolates even when there is no ~/.claude to mirror", async () => {
    const home = join(tmpdir(), `clco-empty-${Date.now()}`)
    await mkdir(home, { recursive: true })
    const dir = await run(home)
    expect(dir).not.toBeNull()
    expect((await lstat(dir!)).isDirectory()).toBe(true)
    await rm(home, { recursive: true, force: true })
  })

  test("drops a link whose source is gone, and re-points a stale one", async () => {
    const home = join(tmpdir(), `clco-stale-${Date.now()}`)
    const real = join(home, ".claude")
    await mkdir(join(real, "skills"), { recursive: true })
    await writeFile(join(real, "temp.md"), "x")
    const dir = (await run(home))!
    expect(await readdir(dir)).toContain("temp.md")

    // Source removed: the link would otherwise dangle here forever.
    await rm(join(real, "temp.md"))
    await run(home)
    expect(await readdir(dir)).not.toContain("temp.md")

    // A link left pointing at a previous $HOME was trusted unconditionally.
    await rm(join(dir, "skills"))
    await symlink("/nonexistent/skills", join(dir, "skills"))
    await run(home)
    expect(await readlink(join(dir, "skills"))).toBe(join(real, "skills"))

    await rm(home, { recursive: true, force: true })
  })

  test("strips the model key from a settings.json claude tolerates but JSON.parse does not", async () => {
    const home = join(tmpdir(), `clco-jsonc-${Date.now()}`)
    const real = join(home, ".claude")
    await mkdir(real, { recursive: true })
    await writeFile(
      join(real, "settings.json"),
      '{\n  // a comment claude accepts\n  "model": "gpt-4.1",\n  "env": {}\n}',
    )
    const dir = (await run(home))!
    expect(await readFile(join(dir, "settings.json"), "utf8")).not.toContain("gpt-4.1")
    await rm(home, { recursive: true, force: true })
  })

  // With no global settings.json the private copy was never rewritten, so a
  // slug claude wrote there in an earlier session survived every launch.
  test("strips a stale model key even with no global settings.json", async () => {
    const home = join(tmpdir(), `clco-nosettings-${Date.now()}`)
    await mkdir(join(home, ".claude"), { recursive: true })
    const dir = (await run(home))!
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ model: "kimi-k3", outputStyle: "keep-me" }),
    )
    await run(home)
    const after = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))
    expect(after.model).toBeUndefined()
    expect(after.outputStyle).toBe("keep-me")
    await rm(home, { recursive: true, force: true })
  })

  test("every private entry stays a real file, never a link back", async () => {
    const home = join(tmpdir(), `clco-private-${Date.now()}`)
    const real = join(home, ".claude")
    await mkdir(join(real, "backups"), { recursive: true })
    await writeFile(join(real, "settings.json"), "{}")
    await writeFile(join(real, "settings.local.json"), "{}")
    const dir = (await run(home))!
    for (const name of ["settings.json", "settings.local.json", "backups"]) {
      const s = await lstat(join(dir, name)).catch(() => null)
      expect(s?.isSymbolicLink() ?? false).toBe(false)
    }
    await rm(home, { recursive: true, force: true })
  })
})
