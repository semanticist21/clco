# clco

GitHub Copilot 구독을 백엔드로 Claude Code를 구동하는 래퍼. **claude 바이너리와 기존 `~/.claude` 설정은 전혀 건드리지 않고**, 로컬 어댑터 하나만 띄워 Anthropic ↔ Copilot 변환을 담당합니다.

```
clco
✓ GitHub 토큰 확인 (0.0s)
✓ Copilot 토큰·모델 목록 조회 (0.4s)
┌  모델 선택 — 타이핑해서 검색
│  ● Claude Sonnet 5        claude-sonnet-5
│  ○ Luna 5.6               luna-5.6
│  ...
```

## 요구사항

- [claude CLI](https://claude.com/claude-code) (PATH에 있어야 함)
- GitHub Copilot 구독이 활성화된 GitHub 계정
- Bun — 없으면 설치 스크립트가 자동으로 설치합니다

## 설치

```sh
curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/install.sh | bash
```

기본 위치 `~/.local/share/clco`에 설치되고 `~/.local/bin/clco` 런처를 만듭니다.
다른 위치 선호 시: `CLCO_DIR=~/somewhere curl -fsSL ... | bash`

## 사용

```sh
clco                      # 최초 1회 GitHub 로그인(device flow) → 모델 선택 → claude 실행
clco -- -p "질문"         # `--` 뒤 인자는 claude에 그대로 전달 (선택 프롬프트 생략)
clco serve                # 어댑터 서버만 기동
clco login                # GitHub (재)인증 — 계정 전환도 이걸로
clco logout               # 저장된 토큰 삭제 (마지막 모델 선택은 유지)
clco update               # 최신 버전으로 갱신 (git pull + 의존성)
clco auth                 # clco login의 별칭
clco help
```

- **모델**: 시작할 때 Copilot이 제공하는 전체 모델에서 검색해서 고릅니다. 마지막 선택은 기본값으로 기억됩니다.
  세션 중 전환은 claude 안에서 `/model`. 고정하려면 `clco -- --model luna-5.6` 또는 `CLCO_SONNET=luna-5.6 clco`
  (슬롯 오버라이드: `CLCO_OPUS` / `CLCO_SONNET` / `CLCO_HAIKU` / `CLCO_FABLE`)
- **로그인**: 토큰은 `~/.config/clco/auth.json`(600)에 1회 저장. 만료되면 안내에 따라 `clco auth`
- **debug**: `CLCO_DEBUG=1 clco` — 어댑터 요청 로그가 `~/.config/clco/adapter.log`에 쌓임

## 제거

```sh
# 앱과 런처만 제거 (GitHub 토큰은 유지)
curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/uninstall.sh | bash

# 토큰 등 설정(~/.config/clco)까지 완전 삭제
curl -fsSL https://raw.githubusercontent.com/semanticist21/clco/main/uninstall.sh | bash -s -- --full
```

## 동작 원리

1. GitHub OAuth device flow로 1회 로그인 → 장기 토큰 저장
2. 그 토큰으로 30분짜리 Copilot 토큰을 자동 갱신하며 로컬 어댑터(127.0.0.1)를 띄움
3. claude에 `--settings`로 어댑터 주소를 주입(`~/.claude` 무손상) — 어댑터가 Anthropic Messages ↔ Copilot(chat/completions + Responses API)을 번역. SSE 스트리밍, 도구 호출, 이미지, 병렬 도구 호출 지원

## 개발

```sh
bun install
bun test          # 단위 + 목업 upstream 통합 테스트
bun run check     # tsc --noEmit
CLCO_UPSTREAM=http://127.0.0.1:9099 bun run scripts/mock-upstream.ts  # 목업 upstream
```

## 주의

- Copilot을 공식 클라이언트 외 경로로 쓰는 것은 GitHub 약관 회색지대입니다. 남용 시 계정 플래그 위험이 있고, Claude 모델 사용은 premium request quota를 소모합니다. 개인 사용 권장.
- thinking(확장 사고)은 미지원입니다. Responses API 전용 모델(luna 등 GPT-5.x)에서는 `stop_sequences`가 적용되지 않습니다.
- 라이선스: [MIT](LICENSE)
