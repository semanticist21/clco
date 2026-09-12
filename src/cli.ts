#!/usr/bin/env bun
// clco — run the stock Claude Code CLI backed by a GitHub Copilot
// subscription: device-flow OAuth, a local Anthropic-compatible adapter, and
// claude launched with injected settings.

import * as p from "@clack/prompts"
import { existsSync, mkdirSync } from "node:fs"
import { appendFile, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { clearAuth, loadPrefs, savePrefs, saveAuth } from "./config"
import { ensureGithubToken, runDeviceFlow } from "./auth"
import {
  GITHUB_API_BASE_URL,
  copilotFetch,
  githubRequestHeaders,
  isMockMode,
} from "./api"
import {
  copilotTokenFacts,
  discoverModels,
  takeDiscoverySoftFailure,
  upstreamModels,
} from "./token"
import { setAdapterLogSink, startServer } from "./server"
import { buildModelPickerFrom, resolveClaude, runClaude } from "./spawn"
import { TLS_HINT, isTlsTrustError } from "./tls"
import { normalizeModel } from "./translate"

const HELP = `clco — GitHub Copilot 구독으로 Claude Code 실행

사용법:
  clco [--port N] [claude 인자...]
      GitHub 인증(최초 1회) → 모델 선택 → 로컬 어댑터 기동 → claude 실행.
      clco가 모르는 대시 인자는 claude로 그대로 전달됩니다:
        clco --chrome / clco --dangerously-skip-permissions / clco -p "질문"
      모델 선택 프롬프트는 -p(무인 실행)와 비대화 환경에서만 생략됩니다.
  clco serve [--port N]
      어댑터 서버만 기동 (claude는 직접 연결해서 사용)
  clco status
      계정·플랜·모델별 경로/권한/컨텍스트 확인
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
  CLCO_NO_PASSTHROUGH=1   네이티브 /v1/messages 경로 비활성화 (항상 번역)
  CLCO_EDITOR_VERSION / CLCO_CHAT_VERSION  클라이언트 식별 버전 오버라이드
`

interface Args {
  command: "run" | "serve" | "auth" | "login" | "logout" | "update" | "status"
  port?: number
  claudeArgs: string[]
}

// Our own vocabulary is tiny (serve/auth/login/logout/update/--port/help).
// Anything else before `--` is a typo — fail loudly with the command list
// instead of silently launching a conversation. claude args go after `--`.
const COMMAND_LIST = `명령어:
  clco                 대화 실행 (모델 선택 프롬프트)
  clco serve           어댑터 서버만 기동
  clco login|auth      GitHub (재)인증
  clco logout          저장된 토큰 삭제
  clco update          최신 버전으로 갱신
  clco status          계정·모델 권한·엔드포인트 확인
  clco --port N        어댑터 포트 고정
  clco help            도움말

claude 인자는 그대로 전달됩니다:  clco -p "질문"  /  clco --chrome  /  clco --dangerously-skip-permissions`

export function parseArgs(rawArgv: string[]): Args {
  // The launcher replaces a leading "--" with this sentinel because bun
  // strips the bare separator before scripts ever see it; it is consumed in
  // the scan below.
  const argv = rawArgv
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
        arg === "logout" || arg === "update" || arg === "status") &&
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
        throw new Error(`--port 에는 1 이상의 정수가 필요합니다\n\n${COMMAND_LIST}`)
      }
      port = n
      i += 2
      continue
    }
    if (arg === "__clco_passthrough__") {
      return { command, port, claudeArgs: [...leading.slice(i + 1), ...trailing] }
    }
    // A dashed flag we don't own is claude's (--chrome, -p,
    // --dangerously-skip-permissions, ...). A bare word is almost always a
    // mistyped subcommand, so that still fails loudly.
    if (arg !== undefined && arg.startsWith("-")) {
      return { command, port, claudeArgs: [...leading.slice(i), ...trailing] }
    }
    throw new Error(
      `알 수 없는 명령: "${arg}"\n(claude 인자라면 -- 뒤에 넣으세요: clco -- ${leading.slice(i).join(" ")})\n\n${COMMAND_LIST}`,
    )
  }
  return { command, port, claudeArgs: trailing }
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
  // Pre-rename clones carry a stale origin — retarget before pulling.
  const CANONICAL = "https://github.com/semanticist21/clco.git"
  const remote = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const url = remote.stdout.toString().trim()
  if (remote.exitCode === 0 && url && !url.endsWith("semanticist21/clco.git")) {
    console.error(`… origin 재지정: ${url} → ${CANONICAL}`)
    Bun.spawnSync(["git", "-C", dir, "remote", "set-url", "origin", CANONICAL])
  }
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
  // Refresh the launcher too. It used to be baked once by install.sh, so an
  // existing install never picked up launcher changes no matter how often it
  // updated.
  const binDir = join(homedir(), ".local", "bin")
  const launcher = Bun.spawnSync(
    ["bash", join(dir, "scripts", "write-launcher.sh"), dir, binDir],
    { stdout: "pipe", stderr: "pipe" },
  )
  if (launcher.exitCode === 0) {
    console.error(`… 런처 갱신: ${join(binDir, "clco")}`)
  } else {
    console.error(
      `⚠ 런처 갱신 실패 — install.sh를 다시 실행하세요 (${launcher.stderr.toString().trim()})`,
    )
  }
  const head = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--short", "HEAD"], {
    stdout: "pipe",
  })
  console.error(`✓ 업데이트 완료 (${head.stdout.toString().trim()}) — 다음 실행부터 적용`)
}

// Show what this account can actually reach: which models are enabled, which
// dialect each one routes through, and their declared effort/context limits.
async function runStatus(): Promise<void> {
  const identity = await ensureGithubToken()
  // The stored token may predate login capture. Ask GitHub once, remember the
  // answer, and say plainly why it is missing when the lookup is refused —
  // corporate policy blocks personal-account API calls on some networks.
  let login = identity.login
  let lookupNote = ""
  if (!login && !isMockMode()) {
    try {
      const res = await copilotFetch(`${GITHUB_API_BASE_URL}/user`, {
        headers: githubRequestHeaders(identity.token),
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) {
        login = ((await res.json()) as { login?: string }).login
        if (login) {
          // Cache it so the next run needs no network at all.
          await saveAuth({ github_token: identity.token, login }).catch(() => {})
        }
      } else {
        lookupNote = `조회 거부됨 (HTTP ${res.status})`
      }
    } catch (err) {
      lookupNote = `조회 실패 (${err instanceof Error ? err.message : String(err)})`
    }
  }
  console.log(
    `계정: ${login ? `@${login}` : `(로그인됨${lookupNote ? ` — 계정명 ${lookupNote}` : ""})`}`,
  )

  const facts = await copilotTokenFacts().catch(() => ({}) as { sku?: string })
  if (facts.sku) console.log(`플랜: ${facts.sku}`)
  await discoverModels()
  // Populates the model catalog from the installed binary so the /model
  // preview below matches what a real session would offer. Diagnostics must
  // still work without claude present, so a failure is not fatal here.
  await resolveClaude().catch(() => undefined)
  const discoveryNote = takeDiscoverySoftFailure()
  if (discoveryNote) console.error(discoveryNote)
  const models = upstreamModels()
  if (models.length === 0) {
    console.log("모델 목록을 가져오지 못했습니다 (네트워크 또는 구독 확인)")
    return
  }
  const route = (m: (typeof models)[number]) =>
    m.endpoints.includes("/v1/messages")
      ? "native"
      : m.endpoints.includes("/responses")
        ? "responses"
        : "chat"
  // `model_picker_enabled` is not filtered here: GitHub returns false for
  // every model, so honouring it emptied this table (and /model) entirely.
  const picker = buildModelPickerFrom(models)
  const offered = new Map(
    (picker?.options ?? []).map((o) => [normalizeModel(o.model), o] as const),
  )
  console.log(
    `\n${"모델".padEnd(26)} ${"/model 표기".padEnd(38)} ${"경로".padEnd(10)} ` +
      `${"정책".padEnd(10)} ${"컨텍스트".padEnd(10)} effort`,
  )
  for (const m of models) {
    const row = offered.get(m.id)
    const shown = row
      ? row.model + (row.behavesAs ? ` (→${row.behavesAs})` : "")
      : "-"
    const ctx = m.maxPromptTokens ?? m.maxContextTokens
    console.log(
      `${m.id.padEnd(26)} ${shown.padEnd(38)} ${route(m).padEnd(10)} ` +
        `${(m.policyState ?? "?").padEnd(10)} ` +
        `${String(ctx ?? "?").padEnd(10)} ${m.efforts ? m.efforts.join(",") : "-"}`,
    )
  }
  console.log(
    `\n/model 행 ${picker?.options.length ?? 0}개 / 업스트림 ${models.length}개`,
  )
  await reportClaudeInstallNotes()
  console.log(
    "\nquota는 실제 요청 시점에만 확인됩니다 (Copilot에 사전 조회 API가 없음).\n" +
      "소진 시 402와 함께 안내가 표시됩니다.",
  )
}

// Things in the user's own claude install that change what clco's lineup
// does, plus leftovers older clco versions wrote there.
/** Matches LAUNCHER_VERSION in scripts/write-launcher.sh. */
const LAUNCHER_VERSION = 2

function reportStaleLauncher(): void {
  const running = Number(process.env.CLCO_LAUNCHER_VERSION ?? "0")
  if (running >= LAUNCHER_VERSION) return
  console.log(
    `\n참고: ~/.local/bin/clco 런처가 낡았습니다 (v${running || "?"} < v${LAUNCHER_VERSION}).` +
      " `clco update` 또는 install.sh 재실행으로 갱신하세요.",
  )
}

async function reportClaudeInstallNotes(): Promise<void> {
  reportStaleLauncher()
  const home = homedir()
  const stale = join(home, ".claude", "cache", "gateway-models.json")
  if (await Bun.file(stale).exists()) {
    console.log(
      `\n참고: ${stale} 는 이전 버전 clco가 남긴 것입니다 — 지워도 됩니다.`,
    )
  }
  try {
    const raw = await readFile(join(home, ".claude", "settings.json"), "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Both outrank or filter what --settings injects.
    if (parsed.availableModels) {
      console.log(
        "경고: ~/.claude/settings.json의 availableModels가 clco의 /model 행을 걸러냅니다.",
      )
    }
    if (parsed.modelPicker) {
      console.log(
        "참고: ~/.claude/settings.json에 modelPicker가 있습니다 — clco의 --settings가 우선하며 병합되지 않습니다.",
      )
    }
  } catch {
    // no settings file, or not strict JSON — nothing to warn about
  }
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

  if (args.command === "status") {
    await runStatus()
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
  // Printed here, not inside discoverModels: step() runs a spinner that would
  // paint over anything written while it is active.
  const discoveryNote = takeDiscoverySoftFailure()
  if (discoveryNote) console.error(discoveryNote)
  const list = upstreamModels()

  let defaultModel: string | undefined
  // Ask whenever a human is actually there. Print mode (-p) and non-TTY runs
  // must stay unattended, but ordinary flags like --dangerously-skip-permissions
  // or --chrome should not cost you the model choice.
  const printMode = args.claudeArgs.some(
    (a) => a === "-p" || a === "--print" || a.startsWith("--print="),
  )
  if (
    args.command === "run" &&
    !printMode &&
    interactive &&
    !process.env.CLCO_NO_SELECT &&
    list.length > 0
  ) {
    const prefs = await loadPrefs()
    // Offer exactly what /model will: the raw upstream list also carries
    // embeddings and Copilot's internal plumbing, which cannot hold a
    // conversation at all, and repeats display names across several slugs.
    const picker = buildModelPickerFrom(list)
    const rows = picker?.options ?? []
    // A remembered model the current account no longer offers would preselect
    // a row that is not there.
    const last = rows.some((o) => normalizeModel(o.model) === prefs.last_model)
      ? prefs.last_model
      : undefined
    const selected = await p.autocomplete({
      message: "모델 선택 — 타이핑해서 검색",
      placeholder: "모델명 검색…",
      initialValue: last,
      maxItems: 12,
      options: rows.map((o) => {
        const id = normalizeModel(o.model)
        return {
          value: id,
          label: o.label ?? id,
          hint: id === last ? `${o.description} · 마지막 사용` : o.description,
        }
      }),
    })
    if (p.isCancel(selected)) {
      p.cancel("취소됨")
      process.exit(0)
    }
    defaultModel = selected as string
    try {
      await savePrefs({ last_model: defaultModel })
    } catch {
      console.error("[clco] ⚠ 모델 선택 저장 실패 (설정 디렉토리 권한 확인)")
    }
  }

  const server = await startServer({ port: args.port })
  if (args.command === "run") {
    // claude's TUI owns the terminal; adapter request logs must not paint
    // over it. Debug mode appends them to a file instead.
    if (process.env.CLCO_DEBUG) {
      const logDir = join(homedir(), ".config", "clco")
      mkdirSync(logDir, { recursive: true })
      const logPath = join(logDir, "adapter.log")
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

// Only run when invoked as the CLI — tests import parseArgs from here.
if (import.meta.main) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(
      `오류: ${message}${isTlsTrustError(message) ? TLS_HINT : ""}`,
    )
    process.exit(1)
  })
}
