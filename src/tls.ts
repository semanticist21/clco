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
        `[clco] could not read CA bundle: ${path} (${err instanceof Error ? err.message : String(err)})`,
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
  "\nThis looks like a corporate proxy re-signing TLS. To fix it:\n" +
  "  1) Get your company CA as a file, then:\n" +
  "       CLCO_CA_BUNDLE=/path/ca.pem clco ...\n" +
  "     It is ADDED to the OS trust store, never replaces it.\n" +
  '  2) Export it from the macOS keychain:\n' +
  '       security find-certificate -a -p -c "<CA name>" > ca.pem\n' +
  "  3) NODE_EXTRA_CA_CERTS has been reported to REPLACE the system store on\n" +
  "     macOS and break trust that already worked - use it only if 1) fails.\n" +
  "Never disable TLS verification: your GitHub token goes over that connection."
