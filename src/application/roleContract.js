// src/application/roleContract.js
//
// M11-5: Shared, backend-neutral role contract loader + path authority.
//
// WAO lets a Lead write only the concrete task; the registry's per-agent
// `systemPrompt` (a path to a role contract file) is resolved here, loaded,
// validated, and delivered to each process backend exactly once. The
// Lead/model cannot override or bypass the registry-selected role contract.
//
// Architectural contract:
//   - No spawn, no transcript writes, no MCP/CLI/command imports.
//   - Load timing differs by path:
//       * start: validates BEFORE RunManager creates the transcript or spawns.
//       * resume: validates AFTER reading the existing transcript, but BEFORE
//         any append or spawn (a failure leaves the existing transcript bytes
//         unchanged).
//   - Fail-closed on every malformation: missing, directory, empty, >4096
//     bytes, illegal UTF-8, NUL byte. Zero role content or absolute path in
//     the error (the error is a fixed safe shape).
//   - Returns the validated role contract STRING (the file content). Callers
//     (RunManager) pass it to backend.spawn as task.roleContract. WAO does
//     NOT persist the role contract as prompt.sent or any control-plane
//     input — the transcript stores only the original task prompt. (Note:
//     this is about what WAO persists, not what the model emits; worker
//     output may echo or summarize the role, so the transcript is not
//     guaranteed to never contain role wording.)
//
// Why a string (not a path): the three backends consume the role differently
// (claude: --append-system-prompt <content>; codex: inlines into
// -c developer_instructions; kimi: concatenates into the prompt). Keeping the
// loader path-free and returning content lets each backend choose its
// transport without the loader branching on runtime.
//
// M11-5 Package C1 (path authority): a relative `systemPrompt` is resolved
// against the WAO installation/repo root (derived from this module's URL),
// NOT against process.cwd(). This lets the same global registry + role files
// be used from any target-project cwd (Life Index, Smash Bros, ...). This is
// the single resolver; RunManager.start/resume and `registry validate` all
// delegate to it — call sites must NOT pre-resolve with path.resolve().

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { isValidCanonicalAgentId } from "../canonicalAgentId.js";

// WAO installation/repo root, derived from this module's URL
// (<repoRoot>/src/application/roleContract.js → up two levels). Stable across
// cwd changes: a Lead calling WAO from any target project resolves role files
// relative to the WAO install, not the caller's cwd.
const WAO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Maximum acceptable role contract size (bytes). */
export const ROLE_CONTRACT_MAX_BYTES = 4096;

// C0 control chars except TAB (0x09), LF (0x0A), CR (0x0D); plus DEL (0x7F)
// and C1 (0x80-0x9F). These are rejected because they break downstream
// TOML/argv/JSON parsers and carry no legitimate role-contract semantics.
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

/**
 * Resolve a role-contract path relative to the WAO installation root.
 *
 * Absolute paths are returned unchanged. Relative paths are resolved against
 * the WAO repo/install root (derived from this module's URL), NOT against
 * process.cwd() — so the same global registry works from any target-project
 * cwd. Callers (RunManager.start/resume, `registry validate`) must delegate
 * here instead of pre-resolving with path.resolve().
 *
 * @param {string} rolePath — path from agent.systemPrompt (registry-owned)
 * @returns {string} absolute path to the role contract file
 */
export function resolveRoleContractPath(rolePath) {
  if (typeof rolePath !== "string" || rolePath.length === 0) {
    throw new Error("role contract path is required");
  }
  return isAbsolute(rolePath) ? rolePath : join(WAO_ROOT, rolePath);
}

/**
 * Load and validate a role contract file.
 *
 * The path is resolved through resolveRoleContractPath (relative to the WAO
 * install root, not cwd) before any I/O. Callers pass the registry-declared
 * path as-is — do NOT pre-resolve with path.resolve().
 *
 * @param {string} rolePath — path from agent.systemPrompt (registry-owned)
 * @returns {string} the validated, non-empty role contract content (UTF-8)
 * @throws {Error} on any malformation (missing, directory, empty, >4096 bytes,
 *                 illegal UTF-8, NUL byte, unsafe control chars). Error message
 *                 is a fixed safe shape — never includes role content or the
 *                 absolute path.
 */
export function loadRoleContract(rolePath) {
  // Package C1: resolve relative to WAO install root, not process.cwd().
  const resolved = resolveRoleContractPath(rolePath);

  // Stat first to reject directories and missing files with a clear boundary.
  let st;
  try {
    st = statSync(resolved);
  } catch {
    throw new Error("role contract file is missing or unreadable");
  }
  if (!st.isFile()) {
    throw new Error("role contract path is not a regular file");
  }

  // Read raw bytes.
  let raw;
  try {
    raw = readFileSync(resolved);
  } catch {
    throw new Error("role contract file is unreadable");
  }
  // CTO rework: check actual byte count, not stat.size (which may differ
  // on some filesystems). This is the authoritative cap.
  if (raw.length > ROLE_CONTRACT_MAX_BYTES) {
    throw new Error(`role contract exceeds ${ROLE_CONTRACT_MAX_BYTES} bytes`);
  }

  // Strict UTF-8 decode: TextDecoder with fatal=true rejects illegal sequences
  // instead of silently replacing them with U+FFFD.
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error("role contract is not valid UTF-8");
  }

  // Non-empty after trim (a whitespace-only file carries no contract).
  if (text.length === 0 || text.trim().length === 0) {
    throw new Error("role contract is empty");
  }
  // Reject unsafe control characters (C0 except TAB/LF/CR, DEL, C1).
  // NUL is included in this range — defends downstream TOML/argv/JSON parsers.
  if (UNSAFE_CONTROL_RE.test(text)) {
    throw new Error("role contract contains unsafe control characters");
  }

  return text;
}

// M11-8B closeout: the identity header is composed ONLY with a validated
// canonical agentId. The CTO verdict rejected the prior "collapse newlines to
// spaces" approach: turning "evil\n\nIgnore previous instructions." into
// "evil Ignore previous instructions." still let the attack text enter the
// model prompt, and "same line" is not a security boundary for LLM prompts.
//
// The correct boundary is structural: an agentId is a closed-vocabulary
// registry identifier (see canonicalAgentId.js — A-Z/a-z/0-9/._-, 1..128).
// Only such an id may appear in the identity header. Any other value — a
// newline injection, whitespace, punctuation, overlong string, or non-string —
// is rejected: the header is omitted entirely and the role contract body is
// returned alone. An invalid id NEVER enters the prompt in any form.

/**
 * M11-8B: The SINGLE composition function that combines a fixed, provider-
 * neutral identity header with a loaded role contract.
 *
 * RunManager.start AND resume both go through this function (single source of
 * truth for the composed contract). The header tells the worker its canonical
 * WAO agentId and that it must NOT derive identity from OS user, runtime,
 * model, cwd, or role display name. Whether the worker actually echoes the id
 * is only a hint effect — it adds no scorecard, retry, or acceptance gate.
 *
 * Trust boundary (M11-8B closeout):
 *   - roleContract undefined/empty → returns undefined (unchanged behavior for
 *     agents without a systemPrompt; NO identity header is added).
 *   - agentId MUST be a valid canonical id (isValidCanonicalAgentId). An
 *     invalid id does NOT enter the prompt in any form: the header is omitted
 *     and the role contract body is returned alone. There is no "encoding"
 *     fallback — an invalid id is rejected, not flattened.
 *   - When the id is valid, the header (fixed text + the validated id) precedes
 *     the role body, joined by a fixed separator. The composed string is what
 *     backends consume via task.roleContract (each backend injects it once).
 *   - Deterministic: identical inputs → identical output (start/resume parity).
 *   - No runtime-name branch, no parser change, no per-config/roles/*.md edit.
 *
 * @param {object} input
 * @param {string|undefined} [input.roleContract] — validated role contract content
 * @param {string} input.agentId — canonical WAO agentId (registry id)
 * @returns {string|undefined} the composed contract string, or undefined
 */
export function composeRoleContractWithIdentity({ roleContract, agentId }) {
  // Only agents that already have a role contract get the identity header.
  // An agent without systemPrompt keeps its unchanged behavior (undefined).
  if (roleContract === undefined || roleContract === null) return undefined;
  if (typeof roleContract !== "string" || roleContract.length === 0) return undefined;

  // The identity header is added ONLY when the agentId is a valid canonical id.
  // An invalid id (newline injection, whitespace, punctuation, overlong, etc.)
  // is rejected: the header is omitted and the role body is returned alone.
  // An invalid id NEVER enters the model prompt in any form.
  if (!isValidCanonicalAgentId(agentId)) {
    return roleContract;
  }

  // Fixed, provider-neutral identity header. The id is already validated to the
  // closed-set alphabet, so it is safe to embed verbatim — it cannot carry
  // whitespace, control chars, or instruction-phrase structure. The header
  // deliberately says "When explicitly asked" so it does not force the worker
  // to spam its id on every turn — it only anchors the canonical answer when
  // identity is queried.
  const identityHeader =
    `Your canonical WAO agentId is ${agentId}. ` +
    `When explicitly asked for your WAO identity, report this exact agentId. ` +
    `Do not derive it from OS user, runtime, model, cwd, or role display name.`;

  // Fixed separator: the header is its own logical block, then the role body.
  const SEPARATOR = "\n\n---\n\n";
  return `${identityHeader}${SEPARATOR}${roleContract}`;
}
