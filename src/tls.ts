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
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { getCACertificates } from "node:tls"

/**
 * The paths CLCO_CA_BUNDLE names, absolute.
 *
 * The single parser, because there used to be two: this one trimmed the raw
 * value before splitting and the one handing a path to the MCP child did not,
 * so " /a/ca.pem " worked in-process and reached the child as a cwd-joined
 * nonsense path - clco's own probe passing while the child could not fetch,
 * which is the asymmetry that whole code path exists to remove. Absolute
 * because the child resolves relative paths against its own cwd, and `~` is
 * expanded because the README documents that spelling and only an unquoted
 * shell was expanding it.
 */
export function caPaths(raw = process.env.CLCO_CA_BUNDLE): string[] {
  return (raw ?? "")
    .split(":")
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) =>
      path === "~" || path.startsWith("~/")
        ? join(homedir(), path.slice(1))
        : resolve(path),
    )
}

let resolved: string[] | null | undefined

/**
 * The default trust store plus any CA named by CLCO_CA_BUNDLE (one path, or
 * several separated by ":"). Undefined when no extra CA is configured, so the
 * request keeps Bun's own default handling.
 */
export function caBundle(): string[] | undefined {
  if (resolved !== undefined) return resolved ?? undefined
  const paths = caPaths()
  if (paths.length === 0) {
    resolved = null
    return undefined
  }
  const extra: string[] = []
  for (const path of paths) {
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
  try {
    // Union, never replace.
    resolved = [...getCACertificates("default"), ...extra]
  } catch {
    // An older Bun without the default store: still better to trust the extra
    // CA than to let the throw turn every upstream request into a 502.
    resolved = extra
  }
  return resolved
}

/** Test seam: forget a cached bundle so a changed env is picked up. */
export function resetCaBundle(): void {
  resolved = undefined
}

/**
 * OpenSSL verify codes that mean "I do not trust this chain" - which is what a
 * TLS-inspecting proxy produces, and what CLCO_CA_BUNDLE fixes. Bun populates
 * `code` on the thrown error, so this is the reliable discriminator; the
 * message text is not. Matching on text alone missed
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, whose message is "unable to verify the
 * first certificate" - a proxy presenting a leaf without shipping its
 * intermediate, i.e. the most ordinary corporate shape there is. It was
 * reported as an unreachable host, sending the user to their firewall team
 * instead of to their CA.
 */
const TRUST_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  // Deliberately NOT ERR_TLS_CERT_ALTNAME_INVALID: that chain verified and
  // only the name did not match, so no CA bundle can fix it. Including it made
  // clco tell a user whose bundle worked perfectly that their bundle did not
  // cover the chain, and print the whole CA hint besides.
])

/**
 * Whether a failure is a broken trust chain rather than an unreachable host.
 *
 * Accepts the thrown error (preferred - it carries `code`) or just a message,
 * since some call sites only have the string.
 */
export function isTlsTrustError(err: unknown, depth = 0): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code
    if (typeof code === "string" && TRUST_CODES.has(code)) return true
    // Bounded: a cyclic `cause` chain used to overflow the stack, and since
    // every caller is an error handler the RangeError escaped the catch that
    // was about to render a 502 or print the user's real error.
    if (depth < 4) {
      const cause = (err as { cause?: unknown }).cause
      if (cause !== undefined && cause !== err && isTlsTrustError(cause, depth + 1)) {
        return true
      }
      // undici reports a multi-address failure as an AggregateError, so the
      // real trust error is in `errors`, not in `cause`.
      const nested = (err as { errors?: unknown }).errors
      if (Array.isArray(nested)) {
        for (const one of nested) {
          if (one !== err && isTlsTrustError(one, depth + 1)) return true
        }
      }
    }
  }
  const message = typeof err === "string" ? err : String((err as Error)?.message ?? err)
  // Fallback for a stringified error, or a Bun/Node build that omits the code.
  // Anchored to the codes and the exact OpenSSL phrasings: a bare /CERT_/ or
  // /certificate chain/ matched ordinary prose, so an upstream error body
  // echoed into the adapter's 502 ("rotating certificate chain nightly") drew
  // the whole CA hint onto a failure that had nothing to do with trust.
  return (
    /self[- ]signed certificate( in certificate chain)?|unable to (get local issuer certificate|get issuer certificate|verify the first certificate)/i.test(
      message,
    ) ||
    /\b(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_UNTRUSTED)\b/.test(
      message,
    )
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
