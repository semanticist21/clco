import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const canonical = "https://github.com/semanticist21/clco.git"
const script = join(import.meta.dir, "..", "uninstall.sh")

async function install(dir: string, name = "@semanticist14/clco", origin = canonical) {
  await mkdir(dir, { recursive: true })
  for (const args of [["init", "-q", dir], ["-C", dir, "remote", "add", "origin", origin]]) {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  await writeFile(join(dir, "package.json"), JSON.stringify({ name }, null, 2) + "\n")
  await writeFile(join(dir, "unique.txt"), "disposable project content\n")
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clco-uninstall-"))
  const app = join(root, "app")
  const bin = join(root, "bin")
  await mkdir(bin)
  const launcher = Bun.spawnSync(["bash", join(import.meta.dir, "..", "scripts", "write-launcher.sh"), app, bin, process.execPath], { stdout: "pipe", stderr: "pipe" })
  if (launcher.exitCode !== 0) throw new Error(launcher.stderr.toString())
  return { root, app, bin }
}

function uninstall(app: string, bin: string) {
  return Bun.spawnSync(["bash", script], {
    env: { ...process.env, CLCO_DIR: app, BIN_DIR: bin },
    stdout: "pipe", stderr: "pipe",
  })
}

describe("uninstall target validation", () => {
  test("refuses an unrelated package before deleting its source or launcher", async () => {
    const f = await fixture()
    try {
      await install(f.app, "unrelated-project")
      expect(uninstall(f.app, f.bin).exitCode).not.toBe(0)
      expect(existsSync(join(f.app, "unique.txt"))).toBe(true)
      expect(existsSync(join(f.bin, "clco"))).toBe(true)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test("refuses a noncanonical repository with the clco package name", async () => {
    const f = await fixture()
    try {
      await install(f.app, "@semanticist14/clco", "https://example.com/another.git")
      expect(uninstall(f.app, f.bin).exitCode).not.toBe(0)
      expect(existsSync(join(f.app, "unique.txt"))).toBe(true)
      expect(existsSync(join(f.bin, "clco"))).toBe(true)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test("validates the rollback target before removing a valid active install", async () => {
    const f = await fixture()
    try {
      await install(f.app)
      await install(f.app + ".previous", "unrelated-project")
      expect(uninstall(f.app, f.bin).exitCode).not.toBe(0)
      expect(existsSync(join(f.app, "unique.txt"))).toBe(true)
      expect(existsSync(join(f.app + ".previous", "unique.txt"))).toBe(true)
      expect(existsSync(join(f.bin, "clco"))).toBe(true)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test("preserves an unrelated launcher even when both install targets are absent", async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.bin, "clco"), "#!/bin/sh\necho unrelated executable\n")
      expect(uninstall(f.app, f.bin).exitCode).not.toBe(0)
      expect(existsSync(join(f.bin, "clco"))).toBe(true)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test("preserves a launcher for another installation", async () => {
    const f = await fixture()
    try {
      await install(f.app)
      const result = Bun.spawnSync(["bash", join(import.meta.dir, "..", "scripts", "write-launcher.sh"), f.app + "-other", f.bin, process.execPath])
      expect(result.exitCode).toBe(0)
      expect(uninstall(f.app, f.bin).exitCode).not.toBe(0)
      expect(existsSync(join(f.app, "unique.txt"))).toBe(true)
      expect(existsSync(join(f.bin, "clco"))).toBe(true)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test("removes a verified stale launcher after its install is gone", async () => {
    const f = await fixture()
    try {
      expect(uninstall(f.app, f.bin).exitCode).toBe(0)
      expect(existsSync(join(f.bin, "clco"))).toBe(false)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test("still removes legacy quoted-path launchers", async () => {
    const f = await fixture()
    try {
      await writeFile(join(f.bin, "clco"), '#!/bin/sh\n# clco launcher (installed by install.sh)\nCLCO_APP_DIR="' + f.app + '"\n')
      expect(uninstall(f.app, f.bin).exitCode).toBe(0)
      expect(existsSync(join(f.bin, "clco"))).toBe(false)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  test("removes validated active and legacy rollback installs", async () => {
    const f = await fixture()
    try {
      await install(f.app)
      await install(f.app + ".previous", "clco", "git@github.com:semanticist21/clco.git")
      expect(uninstall(f.app, f.bin).exitCode).toBe(0)
      expect(existsSync(f.app)).toBe(false)
      expect(existsSync(f.app + ".previous")).toBe(false)
      expect(existsSync(join(f.bin, "clco"))).toBe(false)
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })
})
