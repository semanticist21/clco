// Trust for TLS-inspecting corporate networks (ZTNA, MITM proxies).
//
// Every outbound HTTPS call clco makes happens in THIS process — the claude
// child only ever talks plaintext to the local adapter. So the CA has to be
// trusted here, and a failure surfaces to the user as an adapter 502 rendered
// inside claude's UI rather than as a TLS error from claude itself.
//
// We pass the bundle per request via Bun's `tls.ca` instead of using
// NODE_EXTRA_CA_CERTS, because this UNIONS with the default trust store
// rather than replacing it. NODE_EXTRA_CA_CERTS has been reported to supplant
// the system store on macOS and break trust that previously worked; and
// NODE_USE_SYSTEM_CA is a no-op on Bun, whose default set already merges the
// bundled and system roots.

import { readFileSync } from "node:fs"
import { getCACertificates } from "node:tls"

let resolved: string[] | null | undefined

/**
 * The default trust store plus any CA named by CLCO_CA_BUNDLE (one path, or
 * several separated by ":"). Undefined when no extra CA is configured, so the
 * request keeps Bun's own default handling.
 */
export function caBundle(): string[] | undefined {
  if (resolved !== undefined) return resolved ?? undefined
  const raw = process.env.CLCO_CA_BUNDLE?.trim()
  if (!raw) {
    resolved = null
    return undefined
  }
  const extra: string[] = []
  for (const path of raw.split(":").filter(Boolean)) {
    try {
      extra.push(readFileSync(path, "utf8"))
    } catch (err) {
      console.error(
        `[clco] CA 번들을 읽지 못했습니다: ${path} (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }
  if (extra.length === 0) {
    resolved = null
    return undefined
  }
  // Union, never replace.
  resolved = [...getCACertificates("default"), ...extra]
  return resolved
}

/** Test seam: forget a cached bundle so a changed env is picked up. */
export function resetCaBundle(): void {
  resolved = undefined
}

export function isTlsTrustError(message: string): boolean {
  return /self[- ]signed certificate|unable to (get|verify) local issuer|CERT_|certificate chain/i.test(
    message,
  )
}

// Ordered by what is actually verified to work on Bun. NODE_USE_SYSTEM_CA
// used to lead this list and does nothing.
export const TLS_HINT =
  "\n사내 프록시가 TLS를 다시 서명하는 환경으로 보입니다:\n" +
  "  1) 회사 CA를 파일로 받아  CLCO_CA_BUNDLE=/path/ca.pem clco ...\n" +
  "     (OS 신뢰저장소에 '추가'합니다 — 교체가 아니라 안전합니다)\n" +
  '  2) macOS 키체인에서 내보내기: security find-certificate -a -p -c "<CA 이름>" > ca.pem\n' +
  "  3) NODE_EXTRA_CA_CERTS는 macOS에서 시스템 저장소를 '대체'해 멀쩡하던 신뢰까지\n" +
  "     깨뜨린 사례가 있습니다 — 1)이 안 될 때만 쓰세요.\n" +
  "TLS 검증을 끄는 방법은 쓰지 마세요 — GitHub 토큰이 그대로 노출됩니다."
