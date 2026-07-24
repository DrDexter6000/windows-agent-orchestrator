// src/canonicalAgentId.js
//
// M11-8B final closeout: the SINGLE source of truth for what a canonical WAO
// agentId is, how it is validated, and how an untrusted value is projected to
// a safe identity. Dependency-free, root-level (importable by registry.js,
// transcript helpers, application services, and MCP — no inverted dependency).
//
// A canonical agentId is a closed-vocabulary registry identifier. It is the
// value stamped on the transcript envelope by the control plane at dispatch
// time, and the value surfaced by run_dispatch / run_status / run_wait /
// run_collect. It is NEVER:
//   - worker free-text (a worker may self-report /root, Coder-HQ, or nothing);
//   - an OS user, cwd, model name, backend output, or role title;
//   - an arbitrary string supplied by a model or attacker.
//
// Reserved sentinel (final closeout):
//   "unknown" is the FAILURE SENTINEL — it means "could not confirm a
//   trustworthy identity". It is structurally distinct from every real id:
//   it is NOT itself a valid canonical id. normalizeAgent("unknown") rejects
//   it; a dispatch result may never be "unknown". Only read tools (status/
//   wait/collect) may return the literal "unknown" when a transcript is
//   corrupt/stale — and that is the sentinel, never a real worker.
//
// Trust boundary:
//   - isValidCanonicalAgentId returns true ONLY for the exact alphabet below,
//     length 1..CANONICAL_AGENT_ID_MAX, and explicitly EXCLUDING the reserved
//     "unknown" sentinel. Closed-set structural check, not a denylist.
//   - safeProjectAgentId returns the id unchanged when valid, else the
//     UNKNOWN_AGENT_ID sentinel. Never throws.
//   - The exported pattern/max/sentinel let MCP schemas reuse the EXACT same
//     contract — no hand-maintained second regex anywhere.

/**
 * The reserved failure sentinel. Structurally distinct from any real id:
 * it is never a valid canonical id, never a registry id, never a dispatch
 * result. Read tools (status/wait/collect) return it when a transcript is
 * corrupt/stale; dispatch never may.
 */
export const UNKNOWN_AGENT_ID = "unknown";

/** Maximum length of a canonical agentId. */
export const CANONICAL_AGENT_ID_MAX = 128;

/**
 * The exact alphabet of a canonical agentId: ASCII letters, digits, dot,
 * underscore, hyphen. Exported so MCP schemas reuse the SAME source pattern
 * rather than a hand-maintained copy. Anchored + exact (no partial match).
 */
export const CANONICAL_AGENT_ID_PATTERN = "^[A-Za-z0-9._-]+$";

/**
 * Wire-visible pattern for a REAL canonical id — the alphabet above AND
 * explicitly NOT the reserved "unknown" sentinel. This is the single
 * JSON-Schema-level expression of "a real id, excluding the sentinel", so the
 * MCP dispatch outputSchema can structurally reject "unknown" WITHOUT relying
 * on zod .refine() (which JSON Schema serialization drops).
 *
 * The negative lookahead `(?!unknown$)` is standard regex and serializes into
 * the wire pattern; it rejects exactly the literal "unknown" and nothing else.
 */
export const REAL_AGENT_ID_WIRE_PATTERN = "^(?!unknown$)[A-Za-z0-9._-]+$";

const CANONICAL_AGENT_ID_RE = new RegExp(CANONICAL_AGENT_ID_PATTERN);

/**
 * Validate that a value is a canonical WAO agentId.
 *
 * Closed-set structural check: a string of length 1..CANONICAL_AGENT_ID_MAX
 * using only [A-Za-z0-9._-], AND explicitly not the reserved "unknown"
 * sentinel. Rejects everything else — whitespace, control chars, newlines,
 * spaces, quotes, slashes, CJK, emoji, instruction phrases, overlong values,
 * and the sentinel itself — with a single boolean. Never throws.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidCanonicalAgentId(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > CANONICAL_AGENT_ID_MAX) return false;
  if (value === UNKNOWN_AGENT_ID) return false; // reserved sentinel
  return CANONICAL_AGENT_ID_RE.test(value);
}

/**
 * Project an untrusted value to a safe canonical agentId.
 *
 * Returns the value unchanged when it is a valid canonical id, otherwise the
 * UNKNOWN_AGENT_ID sentinel. Never throws. The sentinel means "could not
 * confirm a trustworthy identity" — it is structurally distinct from any real
 * id and never gates or fails a read tool.
 *
 * @param {unknown} value
 * @returns {string} the validated id, or UNKNOWN_AGENT_ID
 */
export function safeProjectAgentId(value) {
  return isValidCanonicalAgentId(value) ? value : UNKNOWN_AGENT_ID;
}
