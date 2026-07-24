// src/canonicalAgentId.js
//
// M11-8B closeout: the SINGLE source of truth for what a canonical WAO agentId
// is, how it is validated, and how an untrusted value is projected to a safe
// identity. Dependency-free, root-level (importable by registry.js, transcript
// helpers, application services, and MCP — no inverted dependency).
//
// A canonical agentId is a closed-vocabulary registry identifier. It is the
// value stamped on the transcript envelope by the control plane at dispatch
// time, and the value surfaced by run_dispatch / run_status / run_wait /
// run_collect. It is NEVER:
//   - worker free-text (a worker may self-report /root, Coder-HQ, or nothing);
//   - an OS user, cwd, model name, backend output, or role title;
//   - an arbitrary string supplied by a model or attacker.
//
// Trust boundary:
//   - validateCanonicalAgentId returns true ONLY for the exact alphabet below
//     and length 1..128. It is a closed-set structural check, not a denylist.
//   - safeProjectAgentId returns the id unchanged when valid, else "unknown".
//     "unknown" is never a throw and never a gate — tools stay usable and the
//     Lead keeps human judgment.
//   - No caller may place an unvalidated id into a model prompt. The identity
//     header composition (roleContract.js) accepts ONLY a validated id; an
//     invalid id must not enter the prompt in any form.

/**
 * The exact alphabet of a canonical agentId: ASCII letters, digits, dot,
 * underscore, hyphen. No whitespace, no control chars, no punctuation that
 * could carry prompt-injection structure, no path/shell metacharacters.
 */
const CANONICAL_AGENT_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Maximum length of a canonical agentId. */
export const CANONICAL_AGENT_ID_MAX = 128;

/**
 * Validate that a value is a canonical WAO agentId.
 *
 * Closed-set structural check: a string of length 1..CANONICAL_AGENT_ID_MAX
 * using only [A-Za-z0-9._-]. Rejects everything else — whitespace, control
 * chars, newlines, spaces, quotes, slashes, CJK, emoji, instruction phrases,
 * overlong values — with a single boolean. Never throws.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidCanonicalAgentId(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > CANONICAL_AGENT_ID_MAX) return false;
  return CANONICAL_AGENT_ID_RE.test(value);
}

/**
 * Project an untrusted value to a safe canonical agentId.
 *
 * Returns the value unchanged when it is a valid canonical id, otherwise
 * "unknown". Never throws. "unknown" means "could not confirm a trustworthy
 * identity" — it is structurally distinct from any real id and never gates or
 * fails a tool.
 *
 * @param {unknown} value
 * @returns {string} the validated id, or "unknown"
 */
export function safeProjectAgentId(value) {
  return isValidCanonicalAgentId(value) ? value : "unknown";
}
