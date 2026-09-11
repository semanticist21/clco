// Bridge between Copilot's model slugs and Claude Code's own model catalog.
//
// Copilot spells versions with dots ("claude-haiku-4.5"); Claude Code's
// catalog uses dashes ("claude-haiku-4-5"). When the dashed form is a real
// catalog id we advertise that instead, and the row needs no `behavesAs` —
// Claude Code then applies the model's genuine context window, effort tiers
// and prompt profile. Only slugs with no catalog twin fall back to
// `behavesAs`, which borrows another model's client-side handling.

/**
 * Model ids Claude Code 2.1.268 knows. Re-extract after a claude upgrade:
 *   strings -a -n 4 ~/.local/share/claude/versions/<v> \
 *     | grep -oE '^claude-(opus|sonnet|haiku|fable)-[0-9][0-9a-z-]*$' | sort -u
 *
 * Being stale here is safe: an id missing from the set simply routes its
 * model down the `behavesAs` path instead of being advertised directly.
 */
export const CATALOG_MODEL_IDS: ReadonlySet<string> = new Set([
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-haiku-4",
  "claude-haiku-4-5",
  "claude-opus-4",
  "claude-opus-4-0",
  "claude-opus-4-1",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-3-7",
  "claude-sonnet-4",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
])

/** Claude Code's newest id per family, used to resolve `behavesAs` targets. */
export const LATEST_PER_FAMILY: Readonly<Record<ModelFamily, string>> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5-1",
}

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable"

export function familyOf(id: string): ModelFamily {
  if (id.includes("opus")) return "opus"
  if (id.includes("haiku")) return "haiku"
  if (id.includes("fable")) return "fable"
  return "sonnet"
}

/**
 * The id to show Claude Code for an upstream slug, or null when the slug has
 * no catalog twin. Returns the slug itself when it is already a catalog id.
 */
export function advertisedId(upstreamId: string): string | null {
  if (CATALOG_MODEL_IDS.has(upstreamId)) return upstreamId
  const dashed = upstreamId.replace(/\./g, "-")
  return CATALOG_MODEL_IDS.has(dashed) ? dashed : null
}

/**
 * A catalog id whose client-side handling a non-catalog model can borrow.
 * Prefers a same-family model the upstream actually serves, so the mapping
 * ages with both sides at once. The target only has to be an id Claude Code
 * knows, not one the upstream serves, so a static per-family id backs it up —
 * without that, an upstream carrying no Claude models at all would leave every
 * row unborrowed and therefore unofferable, i.e. an empty /model.
 */
export function resolveBehavesAs(
  family: ModelFamily,
  upstreamIds: readonly string[],
): string {
  const known = upstreamIds
    .map(advertisedId)
    .filter((id): id is string => id !== null)
  return (
    known.find((id) => familyOf(id) === family) ??
    known.find((id) => familyOf(id) === "sonnet") ??
    known[0] ??
    LATEST_PER_FAMILY[family]
  )
}
