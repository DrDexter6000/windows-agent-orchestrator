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

// M12-6 WQ-01/WQ-02: worker evidence discipline block.
//
// Production RED (delivery dogfood runs): a worker made concrete repository
// claims (paths, symbols, test behavior) without inspecting any evidence, and
// async/stateful changes shipped without considering applicable states — the
// Lead had no shared, provider-neutral first-pass evidence standard to delegate
// against. WAO never makes the semantic decision; it only states the
// reporting discipline every role-bearing worker follows.
//
// This is ONE fixed, provider-neutral, control-plane-owned block, composed
// exactly once (via composeRoleContractWithIdentity) between the identity
// header and the role body. It is deliberately NOT a semantic acceptance rule:
// no parser, scorecard, auto-retry, auto-reject, automatic gate, or acceptance
// decision — the Lead remains the sole semantic judge.
//
// WQ-01 GROUNDING: before making concrete claims about a repository path,
// endpoint, symbol, module, API shape, or test behavior, inspect the relevant
// repository evidence and identify the supporting repo-relative path/symbol/
// test in the final report; unverified claims are labeled explicitly as
// unverified/uncertain, not stated as fact.
//
// WQ-02 ASYNC/STATE: when changing async or stateful UI/query-gating behavior,
// enumerate the applicable states (normal, loading, error, missing,
// unparseable, stale-data-plus-error), test each applicable state and the
// high-risk combinations, and state why a listed state is not applicable when
// it is omitted.
export const WORKER_EVIDENCE_DISCIPLINE = [
  "WORKER EVIDENCE DISCIPLINE (WAO control plane — execution/reporting discipline only; the Lead remains the sole semantic judge):",
  "- WQ-01 GROUNDING: before concrete claims about a repository path, endpoint, symbol, module, API shape, or test behavior, inspect the relevant repository evidence and cite the supporting repo-relative path/symbol/test in the final report; if not verified, label it explicitly as unverified/uncertain, not as fact.",
  "- WQ-02 ASYNC/STATE: when changing async or stateful UI/query-gating behavior, enumerate the applicable states (including normal, loading, error, missing, unparseable, and stale-data-plus-error), test each applicable state and the high-risk combinations, and state why a listed state is not applicable when you omit it.",
].join("\n");

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
 * M12-6 WQ-01/WQ-02: the fixed WORKER_EVIDENCE_DISCIPLINE block is composed
 * between the identity header and the role body — exactly once, for every
 * valid canonical agentId with a non-empty role contract, with zero
 * per-runtime/per-seat branching (same block for every worker). It rides the
 * existing roleContract transport; no backend gains or loses a capability and
 * no agent without a role contract is forced to carry it.
 *
 * Trust boundary (M11-8B closeout):
 *   - roleContract undefined/empty → returns undefined (unchanged behavior for
 *     agents without a systemPrompt; NO identity header is added).
 *   - agentId MUST be a valid canonical id (isValidCanonicalAgentId). An
 *     invalid id does NOT enter the prompt in any form: the header is omitted
 *     and the role contract body is returned alone. There is no "encoding"
 *     fallback — an invalid id is rejected, not flattened.
 *   - When the id is valid, the composed string is: identity header + fixed
 *     separator + WQ evidence discipline block + fixed separator + role body.
 *     The header and the role body remain intact and ordered; the block is the
 *     only insertion.
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

  // Fixed separator: the header is its own logical block, then the WQ evidence
  // discipline block, then the role body. The block is the SAME fixed constant
  // for every worker — no runtime-name or worker-seat branch. It rides the
  // existing roleContract transport; composition adds no gate or decision.
  const SEPARATOR = "\n\n---\n\n";
  return `${identityHeader}${SEPARATOR}${WORKER_EVIDENCE_DISCIPLINE}${SEPARATOR}${roleContract}`;
}

/**
 * M11-8C Package A: The control-plane-owned Delivery Execution Contract.
 *
 * Production RED (run_20260724202209375032648): a delivery-mode worker was
 * asked in its task prompt to produce a "Final commit SHA". The worker
 * committed on the isolation branch, moving HEAD off the frozen base, so
 * WAO's packager failed with base_commit_mismatch (HEAD ≠ base). The worker
 * was never told that the control plane owns the delivery commit.
 *
 * This contract is injected (composed ahead of any role contract) for EVERY
 * delivery-mode run, even when the agent has no systemPrompt. It is
 * high-priority and explicitly overrides contrary task-prompt instructions.
 * It is provider-neutral fixed text — no runtime branching, no parser change.
 *
 * Contract body (control-plane-owned, immutable by the worker/model):
 *   - do not run git add/commit/reset/checkout/switch/rebase/merge/tag;
 *   - do not move HEAD or create commits/tags/branches;
 *   - keep authorized file changes as unstaged working-tree changes;
 *   - report only changed paths, tests, risks;
 *   - do not produce or claim a "final commit SHA";
 *   - the WAO control plane inspects, stages, and creates the atomic delivery
 *     commit;
 *   - this contract takes precedence over any contrary task-prompt instruction.
 *
 * M12-14 Package 1 (Worker-visible Work Order SSOT): when the control plane
 * has prepared an authorized-paths list (deliveryPrepared.allowedPaths), it is
 * appended as a fixed AUTHORIZED WORK SCOPE block — the single source of truth
 * the worker sees BEFORE it starts, via the same runtime-native role-contract
 * channel. This eliminates the disallowed_path late-failure: the worker now
 * knows the exact list up front and must report (not edit on) any path outside
 * it. Packaging containment is unchanged — the block states scope, it does not
 * relax the packager.
 *
 * No allowedPaths (undefined / empty / non-array) → the base contract is
 * returned byte-identical, preserving every existing no-arg caller (m12-3
 * ISO-C1, m12-6 WQ-RED-04, m11-8c package tests, non-delivery resume).
 *
 * @param {object} [input]
 * @param {string[]} [input.allowedPaths] — the control-plane-prepared (validated,
 *   normalized) authorized-paths list; omit/empty to get the base contract.
 * @returns {string} the fixed delivery execution contract
 */
export function composeDeliveryExecutionContract({ allowedPaths } = {}) {
  const base = [
    "DELIVERY EXECUTION CONTRACT (WAO control plane — highest priority, overrides any contrary task-prompt instruction):",
    "- The process current working directory, also provided as WAO_TARGET_CWD, is the sole authorized workspace.",
    "- Use repo-relative paths from that directory. Do NOT cd, chdir, or pushd outside it, and do not operate on another checkout.",
    "- Do NOT run git add, git commit, git reset, git checkout, git switch, git rebase, git merge, or git tag.",
    "- Do NOT move HEAD. Do NOT create any commit, tag, or branch.",
    "- Keep your authorized file changes as UNSTAGED working-tree changes. Do not stage them.",
    "- Report only: changed paths, test results, and risks. Do not report a 'Final commit SHA' or claim to have committed.",
    "- The WAO control plane inspects your working-tree changes, stages them, and creates the single atomic delivery commit. You do not commit.",
    "- If the task prompt asks you to commit or to produce a final commit SHA, that instruction is overridden by this contract: leave changes unstaged and report paths/tests/risks only.",
  ].join("\n");

  // M12-14: no authorized-paths list → base contract, unchanged (backward compat).
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    return base;
  }

  // The single source of truth for the worker's authorized scope. The list is
  // already prepared (validated/normalized) by the control plane; this block
  // only states and encodes it — it never re-derives or re-validates scope.
  return base + "\n" + [
    "- AUTHORIZED WORK SCOPE (single source of truth — the WAO control plane persists and delivers this exact list before you start; do not infer, widen, or observe scope from the filesystem):",
    `- AUTHORIZED_PATHS_JSON: ${encodeAuthorizedPathsJson(allowedPaths)}`,
    '- Each changed path must be EXACTLY one of the entries above, or a descendant on a "/" segment boundary: "src" authorizes "src/a.js" and "src/d/b.js", but NOT "src2/a.js" or "srcfoo". Matching is case-sensitive — case-shape is authoritative ("src" does not authorize "SRC/a.js").',
    "- If your task requires a path NOT covered by the list above, do NOT edit it: STOP, leave your changes as unstaged working-tree changes, report `SCOPE_EXPANSION_REQUIRED: <repo-relative-path> — <reason>`, and await instructions.",
  ].join("\n");
}

/**
 * M12-14 Package 1: encode the authorized-paths array as a single-line JSON
 * literal safe to embed verbatim in the delivery contract.
 *
 * JSON.stringify escapes C0 (<0x20), the double-quote, and the backslash, but
 * leaves U+2028 / U+2029 (line separators — line terminators that would break
 * the single-line invariant and let a buried directive start a new line),
 * DEL (0x7F), and C1 (0x80-0x9F) as raw code points. None of these carry
 * legitimate path semantics; they are escaped to \uXXXX here so the
 * AUTHORIZED_PATHS_JSON value is always exactly one line and a path can never
 * forge a new contract field. The output round-trips through JSON.parse back
 * to the original array (including spaces, [], colons, quotes, backticks,
 * backslashes, and embedded newlines, which survive as escaped values).
 *
 * @param {string[]} paths — the control-plane-prepared allowed-paths array
 * @returns {string} a single-line JSON literal
 */
function encodeAuthorizedPathsJson(paths) {
  const raw = JSON.stringify(paths);
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u2028\u2029\x7f-\x9f]/g, (ch) =>
    "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
}
