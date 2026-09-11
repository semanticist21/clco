#!/usr/bin/env bun
// clco — run the stock Claude Code CLI backed by a GitHub Copilot
// subscription: device-flow OAuth, a local Anthropic-compatible adapter, and
// claude launched with injected settings.

import * as p from "@clack/prompts"
import { existsSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { clearAuth, loadPrefs, savePrefs } from "./config"
import { ensureGithubToken, runDeviceFlow } from "./auth"
import { isMockMode } from "./api"
import { discoverModels, upstreamModels } from "./token"
import { setAdapterLogSink, startServer } from "./server"
import { resolveClaude, runClaude } from "./spawn"

const HELP = `clco — GitHub Copilot 구독으로 Claude Code 실행

사용법:
  clco [--port N] [-- <claude 인자>]
      GitHub 인증(최초 1회) → 모델 선택 → 로컬 어댑터 기동 → claude 실행.
      어댑터 어휘(serve/auth/--port/help) 밖의 첫 인자부터는 전부 claude에 전달됨.
      인자를 주면(clco -- -p 등) 모델 선택 프롬프트는 건너뜀.
  clco serve [--port N]
      어댑터 서버만 기동 (claude는 직접 연결해서 사용)
  clco login
      GitHub device flow (재)인증 — 계정 전환도 이걸로
  clco logout
      저장된 GitHub 토큰 삭제
  clco update
      설치된 clco를 저장소 최신 버전으로 갱신 (git pull + 의존성)
  clco help

환경변수:
  CLCO_UPSTREAM           업스트림 베이스 URL 오버라이드 (목업 테스트용, 인증 생략)
  CLCO_OPUS/SONNET/HAIKU  모델 슬러그 오버라이드
  CLCO_NO_SELECT=1        모델 선택 프롬프트 생략
  CLCO_EDITOR_VERSION / CLCO_CHAT_VERSION  클라이언트 식별 버전 오버라이드
`

interface Args {
  command: "run" | "serve" | "auth" | "login" | "logout" | "update"
  port?: number
  claudeArgs: string[]
}

// Our own vocabulary is tiny (serve/auth/--port); the first argument outside
// it starts claude's args, wherever it appears. An explicit `--` also works
// (`bun run` may swallow it, so it is optional).
function parseArgs(argv: string[]): Args {
  const sep = argv.indexOf("--")
  const leading = sep === -1 ? argv : argv.slice(0, sep)
  const trailing = sep === -1 ? [] : argv.slice(sep + 1)

  let command: Args["command"] = "run"
  let port: number | undefined
  let i = 0
  while (i < leading.length) {
    const arg = leading[i]
    if (
      (arg === "serve" || arg === "auth" || arg === "login" ||
        arg === "logout" || arg === "update") &&
      command === "run"
    ) {
      command = arg
      i++
      continue
    }
    if (arg === "--port") {
      const raw = leading[i + 1]
      const n = Number(raw)
      if (raw === undefined || !Number.isInteger(n) || n <= 0) {
        throw new Error("--port 에는 1 이상의 정수가 필요합니다")
      }
      port = n
      i += 2
      continue
    }
    break
  }
  // Anything we didn't consume — before or after `--` — belongs to claude.
  return { command, port, claudeArgs: [...leading.slice(i), ...trailing] }
}

const interactive = process.stdout.isTTY === true

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now()
  if (interactive) {
    const spinner = p.spinner()
    spinner.start(name)
    try {
      const value = await fn()
      spinner.stop(`${name} ✓ ${seconds(Date.now() - t0)}`)
      return value
    } catch (err) {
      spinner.stop(`${name} 실패 (${seconds(Date.now() - t0)})`)
      throw err
    }
  } else {
    console.error(`… ${name}`)
    const value = await fn()
    console.error(`✓ ${name} (${seconds(Date.now() - t0)})`)
    return value
  }
}

// Where the running installation lives: explicit env from the installed
// launcher, then the standard install location, then a dev checkout.
function appDir(): string | null {
  if (process.env.CLCO_APP_DIR) return process.env.CLCO_APP_DIR
  const installed = join(homedir(), ".local", "share", "clco")
  if (existsSync(join(installed, ".git"))) return installed
  const devRoot = join(import.meta.dir, "..")
  if (existsSync(join(devRoot, ".git"))) return devRoot
  return null
}

async function runUpdate(): Promise<void> {
  const dir = appDir()
  if (!dir) {
    throw new Error(
      "업데이트할 설치를 찾지 못했습니다 (설치 디렉토리 또는 git 저장소 필요)",
    )
  }
  console.error(`… 업데이트: ${dir}`)
  const pull = Bun.spawnSync(["git", "-C", dir, "pull", "--ff-only"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (pull.exitCode !== 0) {
    throw new Error(
      `git pull 실패: ${pull.stderr.toString().trim() || pull.stdout.toString().trim()}`,
    )
  }
  const inst = Bun.spawnSync(["bun", "install"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (inst.exitCode !== 0) throw new Error("bun install 실패")
  const head = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--short", "HEAD"], {
    stdout: "pipe",
  })
  console.error(`✓ 업데이트 완료 (${head.stdout.toString().trim()}) — 다음 실행부터 적용`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (["help", "--help", "-h"].includes(argv[0] ?? "")) {
    console.log(HELP)
    return
  }
  const args = parseArgs(argv)

  if (args.command === "update") {
    await runUpdate()
    return
  }

  if (args.command === "logout") {
    await clearAuth()
    console.log("✓ 로그아웃 — ~/.config/clco/auth.json 삭제. 다시 로그인: clco login")
    return
  }

  if (args.command === "auth" || args.command === "login") {
    if (args.port !== undefined) {
      console.error(`[clco] ${args.command} 모드에서는 --port가 무시됩니다`)
    }
    if (isMockMode()) {
      console.log("목업 모드 (CLCO_UPSTREAM) — 인증 생략")
      return
    }
    const { token, login } = await runDeviceFlow()
    console.log(
      `✓ GitHub 인증 완료${login ? ` (@${login})` : ""} — ~/.config/clco/auth.json 저장`,
    )
    if (process.env.CLCO_DEBUG) {
      console.error(`[clco:debug] token prefix: ${token.slice(0, 4)}…`)
    }
    return
  }

  if (
    args.claudeArgs.some(
      (a) => a === "--settings" || a.startsWith("--settings="),
    )
  ) {
    throw new Error(
      "--settings는 clco이 주입합니다 — 직접 지정하면 어댑터 우회 설정을 덮어쓰게 됩니다",
    )
  }
  if (args.command === "serve" && args.claudeArgs.length > 0) {
    throw new Error(
      `serve 모드에서는 claude 인자를 줄 수 없습니다: ${args.claudeArgs.join(" ")}`,
    )
  }

  // Fail fast, before binding the adapter port. `serve` is adapter-only and
  // never spawns claude, so it must not require the binary.
  if (args.command !== "serve") {
    await resolveClaude()
  }

  if (isMockMode()) {
    console.error(
      `⚠ 목업 모드: CLCO_UPSTREAM=${process.env.CLCO_UPSTREAM}\n` +
        `  모든 요청이 이 주소로 전송되며 GitHub 인증을 건너뜁니다. 실제 사용 시 이 환경변수를 해제하세요.`,
    )
  }

  await step("GitHub 토큰 확인", async () => {
    const identity = await ensureGithubToken()
    if (identity.fresh && !isMockMode()) {
      console.error(
        `  └ 신규 인증: @${identity.login ?? "unknown"} — ~/.config/clco/auth.json 저장`,
      )
    }
  })

  const models = await step("Copilot 토큰·모델 목록 조회", () =>
    discoverModels(),
  )
  const list = upstreamModels()

  let defaultModel: string | undefined
  // Bare interactive launch only — args (e.g. -p) or non-TTY skip the picker.
  if (
    args.command === "run" &&
    args.claudeArgs.length === 0 &&
    interactive &&
    !process.env.CLCO_NO_SELECT &&
    list.length > 0
  ) {
    const prefs = await loadPrefs()
    const last = prefs.last_model
    const selected = await p.autocomplete({
      message: "모델 선택 — 타이핑해서 검색",
      placeholder: "모델명 검색…",
      initialValue: last,
      maxItems: 12,
      options: list.slice(0, 100).map((m) => ({
        value: m.id,
        label: m.name !== m.id ? m.name : m.id,
        hint: m.id === last ? `${m.id} · 마지막 사용` : m.id,
      })),
    })
    if (p.isCancel(selected)) {
      p.cancel("취소됨")
      process.exit(0)
    }
    defaultModel = selected as string
    await savePrefs({ last_model: defaultModel })
  }

  const server = await startServer({ port: args.port })
  if (args.command === "run") {
    // claude's TUI owns the terminal; adapter request logs must not paint
    // over it. Debug mode appends them to a file instead.
    if (process.env.CLCO_DEBUG) {
      const logPath = `${homedir()}/.config/clco/adapter.log`
      setAdapterLogSink((line) => {
        void appendFile(logPath, `${line}\n`).catch(() => {})
      })
      console.error(`✓ 어댑터 로그: ${logPath}`)
    } else {
      setAdapterLogSink(null)
    }
  }
  console.error(`✓ 어댑터: ${server.url}`)
  console.error(
    `✓ 모델: ${defaultModel ?? models.sonnet} (sonnet=${models.sonnet} opus=${models.opus} haiku=${models.haiku})`,
  )

  if (args.command === "serve") {
    console.error("서버 대기 중... (Ctrl+C로 종료)")
    await new Promise<never>(() => {})
  }

  const code = await runClaude({
    baseUrl: server.url,
    models,
    defaultModel,
    claudeArgs: args.claudeArgs,
  })
  server.stop()
  process.exit(code)
}

main().catch((err) => {
  console.error(`오류: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
