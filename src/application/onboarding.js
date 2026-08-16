// src/application/onboarding.js
//
// Third-party onboarding helper — pure deterministic service logic.
//
// Goal: a fresh third-party clone can generate ONE minimal private worker
// registry from the tracked config/agents.example.json template, without
// hand-editing the seven-worker template. The Owner explicitly chooses either
// the reliability-certification (strict) path or the existing manual-endorsement
// path. The helper also emits a host-neutral MCP stdio snippet.
//
// Architectural contract (see task brief, items 5/8/9):
//   - Pure deterministic logic only. No subprocess launching, no network,
//     no env reads, no console, no process.exit. This module must not import
//     from src/commands/*, src/mcp/*, or the MCP SDK.
//   - Filesystem effects are INJECTABLE + ATOMIC. The only files this service
//     ever reads/writes are: the tracked template (read), the gitignored
//     config/agents.json (--apply), and runs/reliability-summary.json
//     (--endorse-worker). It never touches .wao/, global Host config, runs/*.jsonl
//     transcripts, or any runtime.
//   - It REUSES the existing registry normalization/validation authority
//     (registry.js normalizeAgent) — there is no second validator. It reuses the
//     install-root path concept (installRoot.js) — there is no second resolver.
//
// Safety: it never inspects credential VALUES (only the apiKeyEnv NAME from the
// template), never fabricates certification status (certified/conditional/etc.),
// and never echoes untrusted/malicious input in fixed safe error messages.
//
// R6-C: advisory role-matrix recommendations (buildRecommendations) are derived
//   purely from the tracked template rows; environment probing is INJECTED
//   (probeEnv) so this module stays pure — it performs no env reads, no PATH
//   lookups, and no subprocess work of its own. Probing never selects or writes
//   anything: the recommendation is advisory and the user keeps the choice.

import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgent } from "../registry.js";

/**
 * Fixed safe error for the onboarding service. The `message` is always a fixed
 * safe shape (never echoes malicious input/credential values). `code` is a
 * closed-set machine string the command layer may map to exit semantics.
 */
export class OnboardingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OnboardingError";
    this.code = code;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

// Hard cap on candidate enumeration. Defends against a malformed or unexpectedly
// large tracked template (e.g. a mis-merged agents object): the candidate list /
// preview output is ALWAYS bounded, never unbounded. Exported so tests pin the
// exact bound as part of the contract.
export const MAX_CANDIDATES = 64;

/** True only for a plain object (not null, not an array). Guards against a
 *  malformed template whose `agents` is an array/string/number. */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Recursively strip every key whose name starts with "_comment" (the template's
 * annotation convention) from an arbitrary JSON value, at every depth, inside
 * arrays and objects. Returns a NEW value (never mutates input). Non-_comment
 * keys — including other underscore-prefixed keys — are preserved.
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof k === "string" && k.startsWith("_comment")) continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return value;
}

/**
 * Build the bounded candidate list (identifying info only) from a template.
 * Each entry: { id, backend, model }. No comment keys, no credential values.
 *
 * Defensive against a malformed or unexpectedly large template:
 *   - if `agents` is not a plain object (array/string/number/null), returns []
 *     instead of enumerating garbage or throwing;
 *   - enumeration is hard-capped at MAX_CANDIDATES, so a huge/mis-merged object
 *     can never produce an unbounded list/output.
 * @param {{agents?: Record<string, any>}} template
 * @returns {{id: string, backend: string, model: string|null}[]}
 */
export function buildCandidateList(template) {
  const agents = isPlainObject(template?.agents) ? template.agents : {};
  const out = [];
  for (const [id, agent] of Object.entries(agents)) {
    // Hard-bounded enumeration: a malformed/huge template cannot grow the list.
    if (out.length >= MAX_CANDIDATES) break;
    const entry = isPlainObject(agent) ? agent : {};
    out.push({
      id: String(id),
      backend: entry.backend ?? null,
      model: entry.model?.id ?? null,
    });
  }
  return out;
}

// ── Role-matrix recommendations (R6-C) ───────────────────────────────────────
//
// Advisory recommendations for a bare `wao onboarding` (no --agent): one row per
// template worker, derived PURELY from the tracked template rows (backend,
// provider.apiKeyEnv, model.id, _comment_task/_comment_auth) plus the INJECTED
// environment probe. There is no second hand-written role table and no
// auto-selection/auto-write — the choice stays with the user, matching the
// existing "mutation requires explicit selection" contract.
//
// Probe contract (injected; this module stays pure — no env reads, no PATH
// lookups, no subprocess work of its own):
//   - probeEnv.hasCli(name) → true | false | "unknown". false = checked and
//     absent; "unknown" = probe failure/timeout (reported truthfully, never
//     mislabeled as missing).
//   - probeEnv.hasKeyEnv(name) → "process_env" | "user_env" | "missing" |
//     "unknown" (null is accepted as "missing").
//   - A THROWING probe method degrades that dimension to "unknown" — the
//     engine never throws on probe failure.
//   - Probes are memoized per unique name within one build call, so an
//     onboarding invocation is bounded at ≤4 CLI probes + ≤N key probes by
//     construction.
//
// readyState domain:
//   ready         CLI present + key present (process_env or user_env)
//   missing_cli   key present + CLI absent
//   missing_key   CLI present + key absent
//   missing_both  CLI absent + key absent
//   login_based   worker declares no provider key (official OAuth / CLI login
//                 state — auditor/tester/kimi style): only the CLI is probed;
//                 the login state itself cannot be verified remotely
//   unknown       a probe failed, or the backend maps to no CLI (cannot verify)

/** backend → CLI 探测映射（与 doctor 的 scoped 探测表同源形状）。 */
export const BACKEND_CLI = {
  "claude-code": "claude",
  codex: "codex",
  "kimi-code": "kimi",
  "opencode-serve": "opencode",
};

/** 顶部 advisory 句（JSON + 人类输出共用）：矩阵按当前环境探测结果给出，最终选择权在用户。 */
export const RECOMMENDATIONS_ADVISORY =
  "推荐按你当前环境探测结果给出，最终选择权在你（不自动选择、不写配置）";

const DUTY_MAX = 60;      // _comment_task 截断上限（≈60 字符）
const AUTH_NOTE_MAX = 60; // _comment_auth 截断上限

const READY_RANK = {
  ready: 0,
  login_based: 1,
  missing_cli: 2,
  missing_key: 3,
  missing_both: 4,
  unknown: 5,
};

/** Truncate a template comment line to the given cap; non-strings/empty → null. */
function truncateNote(value, max) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Normalize a hasCli probe result to true | false | "unknown". */
function normalizeCli(v) {
  if (v === true) return true;
  if (v === false) return false;
  return "unknown";
}

/** Normalize a hasKeyEnv probe result to "process_env" | "user_env" | "missing" | "unknown". */
function normalizeKey(v) {
  if (v === "process_env" || v === "user_env") return v;
  if (v === "missing" || v === null || v === undefined) return "missing";
  return "unknown";
}

/**
 * Compute one row's readyState from the injected probes.
 * @param {object} input
 * @param {string|null} input.requiresCli
 * @param {string|null} input.requiresKeyEnv
 * @param {(name: string) => Promise<true|false|"unknown">} input.probeCli
 * @param {(name: string) => Promise<"process_env"|"user_env"|"missing"|"unknown">} input.probeKey
 * @returns {Promise<"ready"|"missing_cli"|"missing_key"|"missing_both"|"login_based"|"unknown">}
 */
async function computeReadyState({ requiresCli, requiresKeyEnv, probeCli, probeKey }) {
  if (!requiresCli) return "unknown"; // backend maps to no CLI: cannot verify
  if (!requiresKeyEnv) {
    // 无 key 依赖项（官方 OAuth / CLI 登录态类）：仅探 CLI。
    const cli = normalizeCli(await probeCli(requiresCli));
    if (cli === true) return "login_based";
    return cli === false ? "missing_cli" : "unknown";
  }
  const cli = normalizeCli(await probeCli(requiresCli));
  const key = normalizeKey(await probeKey(requiresKeyEnv));
  if (cli === "unknown" || key === "unknown") return "unknown";
  const cliOk = cli === true;
  const keyOk = key !== "missing";
  if (cliOk && keyOk) return "ready";
  if (!cliOk && keyOk) return "missing_cli";
  if (cliOk && !keyOk) return "missing_key";
  return "missing_both";
}

/**
 * Build the advisory role-matrix recommendations for the bounded candidate list.
 * Rows are sorted ready-first (login_based next; stable sort keeps the template
 * order inside each rank). Probe results are memoized per unique name within the
 * call (cost bound); probe failures degrade to "unknown" and never throw.
 *
 * @param {{id: string, backend: string|null, model: string|null}[]} candidates
 * @param {{agents?: Record<string, any>}} template — parsed config/agents.example.json
 * @param {{hasCli: (name: string) => Promise<true|false|"unknown">, hasKeyEnv: (name: string) => Promise<"process_env"|"user_env"|"missing"|"unknown">}} [probeEnv]
 *   injected environment probe. Omitted ⇒ every probe reads as "unknown" (no
 *   probing of any kind — the module stays pure).
 * @returns {Promise<{advisory: string, rows: {
 *   id: string, backend: string|null, model: string|null,
 *   requiresCli: string|null, requiresKeyEnv: string|null,
 *   duty: string|null, authNote: string|null,
 *   readyState: "ready"|"missing_cli"|"missing_key"|"missing_both"|"login_based"|"unknown"
 * }[]>}>
 */
export async function buildRecommendations(candidates, template, probeEnv) {
  const agents = isPlainObject(template?.agents) ? template.agents : {};
  const list = Array.isArray(candidates) ? candidates : [];
  // Per-call memo of probe results (one probe per unique name) — bounds the
  // onboarding invocation at ≤4 CLI probes + ≤N key probes by construction.
  const cliMemo = new Map();
  const keyMemo = new Map();
  const probeOnce = async (memo, name, call) => {
    if (!memo.has(name)) {
      let value = "unknown";
      try {
        value = probeEnv ? await call() : "unknown";
      } catch {
        value = "unknown"; // probe failure degrades to unknown; never throws
      }
      memo.set(name, value);
    }
    return memo.get(name);
  };
  const probeCli = (name) => probeOnce(cliMemo, name, () => probeEnv.hasCli(name));
  const probeKey = (name) => probeOnce(keyMemo, name, () => probeEnv.hasKeyEnv(name));

  const rows = [];
  for (const c of list.slice(0, MAX_CANDIDATES)) {
    const agent = isPlainObject(agents[c.id]) ? agents[c.id] : {};
    const requiresCli = BACKEND_CLI[c.backend] ?? null;
    const apiKeyEnv = agent.provider?.apiKeyEnv;
    const requiresKeyEnv = typeof apiKeyEnv === "string" && apiKeyEnv.length > 0 ? apiKeyEnv : null;
    rows.push({
      id: c.id,
      backend: c.backend ?? null,
      model: c.model ?? null,
      requiresCli,
      requiresKeyEnv,
      duty: truncateNote(agent._comment_task, DUTY_MAX),
      authNote: truncateNote(agent._comment_auth, AUTH_NOTE_MAX),
      readyState: await computeReadyState({ requiresCli, requiresKeyEnv, probeCli, probeKey }),
    });
  }
  // ready 在前（login_based 次之）；稳定排序保持模板顺序。
  rows.sort((a, b) => READY_RANK[a.readyState] - READY_RANK[b.readyState]);
  return { advisory: RECOMMENDATIONS_ADVISORY, rows };
}

/** Empty recommendations (template unreadable / no candidates — zero probes). */
export function emptyRecommendations() {
  return { advisory: RECOMMENDATIONS_ADVISORY, rows: [] };
}

/**
 * Build ONE minimal worker registry for the selected agent id: exactly one entry
 * under `agents` (comments stripped), plus the matching `certification.matrix`
 * entry carried over verbatim (comments stripped) so the strict path
 * (`npm run reliability -- --agent <id>`) is functional. If the selected worker
 * has no matrix entry, the certification section is omitted entirely (never
 * fabricated).
 *
 * @param {object} input
 * @param {object} input.template — parsed config/agents.example.json
 * @param {string} input.agentId — selected canonical id
 * @returns {{agents: Record<string, object>, certification?: {matrix: object[]}}}
 * @throws {OnboardingError} code "unknown_agent" if the id is not in the template
 *   (fixed safe message; never echoes the id).
 */
export function buildMinimalRegistry({ template, agentId }) {
  const agents = isPlainObject(template?.agents) ? template.agents : {};
  if (!Object.prototype.hasOwnProperty.call(agents, agentId)) {
    // Fixed safe shape: do NOT echo the (possibly malicious) supplied id.
    throw new OnboardingError(
      "unknown_agent",
      "selected agent id is not present in the tracked template (run with no --agent to list candidates)",
    );
  }
  const clean = stripComments(agents[agentId]);
  const registry = { agents: { [agentId]: clean } };

  // Carry the matching certification matrix entry (verbatim, comments stripped)
  // so `npm run reliability -- --agent <id>` certifies this worker. Omit the
  // section entirely when there is no matching entry — never fabricate one.
  const matrix = template?.certification?.matrix;
  if (Array.isArray(matrix)) {
    const matching = stripComments(matrix.filter((m) => m?.agentId === agentId));
    if (matching.length > 0) {
      registry.certification = { matrix: matching };
    }
  }
  return registry;
}

/**
 * Build a host-neutral MCP stdio JSON fragment. Generic `mcpServers.wao` shape
 * (no host-specific `type`/`enabled`) with the trusted Node-22 shim launcher and
 * absolute registry/run-dir paths anchored at the WAO installation root.
 *
 * Paths are normalized to forward slashes for host portability (works on Windows
 * Node and all known MCP hosts; avoids backslash escaping that is brittle
 * with paths containing spaces).
 *
 * @param {object} input
 * @param {string} input.installRoot — absolute WAO installation root
 * @returns {{mcpServers: {wao: {command: string, args: string[]}}}}
 */
export function buildMcpSnippet({ installRoot }) {
  const root = normalizeRoot(installRoot);
  const abs = (rel) => toForwardSlash(join(root, rel));
  return {
    mcpServers: {
      wao: {
        command: "node",
        args: [
          abs("scripts/wao-node.cjs"),
          abs("src/mcp/stdio.js"),
          "--registry", abs("config/agents.json"),
          "--run-dir", abs("runs"),
        ],
      },
    },
  };
}

/**
 * Authority note carried with every host example (R5-D). The one-liners are
 * conveniences; this sentence states where the truth lives.
 */
export const HOST_EXAMPLES_AUTHORITY =
  "示例命令的 host flag 随 host 版本演进；权威形状 = docs/usage.md §MCP stdio，上方 host-neutral 片段永远是兜底";

function quoteIfSpaced(s) {
  return /\s/.test(s) ? `"${s}"` : s;
}

/**
 * Bounded per-host one-line registration EXAMPLES (R5-D), derived purely from
 * the host-neutral mcpSnippet — one derivation, no second shape source. Pure
 * string mapping: no fs, no env, no host introspection. Codex's mcp command
 * family is [experimental]; stability travels with the example so consumers
 * can weight it honestly.
 *
 * @param {object} snippet — the buildMcpSnippet result
 * @returns {Array<{host: string, stability: string, command: string}>}
 */
export function buildHostExamples(snippet) {
  const entry = snippet?.mcpServers?.wao;
  if (!entry || typeof entry.command !== "string" || !Array.isArray(entry.args)) {
    return [];
  }
  const argv = [entry.command, ...entry.args].map(quoteIfSpaced).join(" ");
  return [
    { host: "claude-code", stability: "stable", command: `claude mcp add wao --scope user -- ${argv}` },
    { host: "codex", stability: "experimental", command: `codex mcp add wao -- ${argv}` },
  ];
}

/**
 * Build the bounded Host-neutral acceptance projection. Pure, deterministic,
 * advisory guidance shared by --json and human output. It names exactly the
 * three MCP steps, the PASS facts, and the four closed recovery branches so a
 * Fresh Lead can learn the acceptance chain without loading the full Skill.
 *
 * Truth contract (Fresh Lead-facing authority: AGENT_ONBOARDING.md §9):
 *   - chain: lead_preflight → run_dispatch (read-only, no-delivery canary)
 *     → run_await_result. run_dispatch returning a runId means accepted, not PASS.
 *   - PASS requires ALL of: clean observed terminal + terminal state completed
 *     + non-empty assistant text.
 *   - A returned runId binds all later observation (diagnosis, retry decisions).
 *   - Four closed recovery branches:
 *       host-not-invoked   — a Host cancellation proven before tool invocation is
 *                            not a WAO run (WAO never received the dispatch).
 *       transport-unknown  — a missing tool result / transport loss after
 *                            invocation is unknown, not proof that no worker
 *                            started; inspect runs_list / point-in-time facts
 *                            before any retry; NO automatic retry.
 *       workspace/preflight — a workspace binding or preflight problem prevents a
 *                             dispatch-ready chain.
 *       provider/runtime   — provider / worker-runtime failure is a POST-RUN
 *                            branch, diagnosed only after a runId-bound run exists.
 *
 * Boundary: this projection is informational + advisory only. It never names a
 * Host, never carries an absolute path / credential value / prompt body / command
 * argv / PID / session id, and never describes an automatic mutation (no
 * auto-dispatch / auto-retry / decide-continue). It adds no MCP tool, no Host
 * profile, no config mutation, no permission bypass, and no new persistent state.
 *
 * @returns {{
 *   advisory: true, hostNeutral: true,
 *   chain: {step: string, advisory: string}[],
 *   canary: {readOnly: true, noDelivery: true},
 *   pass: {facts: string[], acceptedIsNotPass: true},
 *   runIdBindsObservation: true,
 *   branches: {key: string, advisory: string}[],
 * }}
 */
export function buildAcceptance() {
  return {
    advisory: true,
    hostNeutral: true,
    chain: [
      { step: "lead_preflight", advisory: "confirm registry and environment are dispatch-ready (advisory, not a hard gate)" },
      { step: "run_dispatch", advisory: "issue a read-only, no-delivery canary; a returned runId means accepted, not passed" },
      { step: "run_await_result", advisory: "await the terminal state and the assistant text" },
    ],
    canary: { readOnly: true, noDelivery: true },
    pass: {
      facts: ["clean terminal", "completed", "non-empty assistant text"],
      acceptedIsNotPass: true,
    },
    runIdBindsObservation: true,
    branches: [
      { key: "host-not-invoked", advisory: "a Host cancellation proven before tool invocation means WAO did not receive the dispatch — this is not a WAO run" },
      { key: "transport-unknown", advisory: "a missing tool result or transport loss after invocation is unknown, not proof that no worker started — inspect runs_list / point-in-time facts before any retry; no automatic retry" },
      { key: "workspace/preflight", advisory: "a workspace binding or preflight problem prevents a dispatch-ready chain — resolve the binding before retrying the chain" },
      { key: "provider/runtime", advisory: "provider or worker-runtime failure is a post-run branch — diagnosed only after a runId-bound WAO run exists" },
    ],
  };
}

// ── Default trusted install root ─────────────────────────────────────────────
// Derived from THIS module's location (src/application/onboarding.js → repo root
// is two levels up), matching the installRoot.js philosophy: the trusted root is
// where the code lives, independent of the caller cwd. Injectable for tests.
const DEFAULT_INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function normalizeRoot(installRoot) {
  const root = installRoot ?? DEFAULT_INSTALL_ROOT;
  if (typeof root !== "string" || root.length === 0) {
    throw new OnboardingError("invalid_install_root", "install root must be a non-empty path");
  }
  return root;
}

function toForwardSlash(p) {
  return String(p).replace(/\\/g, "/");
}

// ── Certification guidance ───────────────────────────────────────────────────
function certificationGuidance(agentId, endorsed) {
  return {
    // The strict path is INSTRUCTED only (the helper never runs reliability).
    strictCommand: `npm run reliability -- --agent ${agentId}`,
    // The manual endorsement path is the existing manualOverride:"cleared" signal.
    endorseAvailable: true,
    // True only when this run actually wrote the clearance.
    endorsed: Boolean(endorsed),
  };
}

// ── Atomic JSON write ────────────────────────────────────────────────────────
// Write to a sibling temp file then rename, so a write/rename failure can never
// leave a corrupt final file at `path`. The temp file is removed on failure.
async function atomicWriteJson(path, value, fs) {
  const tmp = `${path}.wao-tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    // Create ONLY the necessary parent directory chain for the target file
    // (e.g. runs/ when --endorse-worker runs before any reliability run has
    // happened). recursive ⇒ a no-op when the parent already exists (config/),
    // and never creates siblings or unrelated directories. This is the one
    // place the helper ever creates a directory, and only for its own target.
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, path);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ── Endorsement write ────────────────────────────────────────────────────────
// Amend runs/reliability-summary.json so workers[id].manualOverride === "cleared",
// preserving every unrelated worker, the cases array, counts, generatedAt, and
// allCertified exactly. Never sets/changes `status`, `recommendedUse`, or
// `capabilities` (never fabricates certified/conditional/authenticated/entitled/
// live-checked). Creates the summary if absent, carrying ONLY the clearance.
function applyEndorsement(existingSummary, agentId) {
  const base = existingSummary && typeof existingSummary === "object" ? existingSummary : {};
  const workers = { ...(base.workers ?? {}) };
  const prior = workers[agentId] && typeof workers[agentId] === "object" ? workers[agentId] : {};
  // Preserve every prior field; set only the clearance. Do not add a status.
  workers[agentId] = { ...prior, agentId, manualOverride: "cleared" };
  return { ...base, workers };
}

// ── Main service ─────────────────────────────────────────────────────────────

/**
 * Run the onboarding action and return ONE bounded structured result (the single
 * source for both --json and human output).
 *
 * @param {object} input
 * @param {string} [input.agentId] — selected canonical id (undefined ⇒ needs-selection)
 * @param {boolean} [input.apply] — write config/agents.json
 * @param {string} [input.endorseWorker] — write manualOverride:cleared for this id
 * @param {string} [input.installRoot] — trusted WAO install root (snippet paths)
 * @param {string} input.exampleRegistryPath — tracked template path (read)
 * @param {string} input.targetRegistryPath — config/agents.json path (apply write)
 * @param {string} input.reliabilitySummaryPath — runs/reliability-summary.json path
 * @param {{hasCli: Function, hasKeyEnv: Function}} [input.probeEnv] — injected
 *   environment probe for the advisory recommendations (see buildRecommendations);
 *   omitted ⇒ every probe reads as "unknown" (no probing of any kind).
 * @param {{readFile: Function, writeFile: Function, rename: Function, existsSync: Function, unlink: Function, mkdir: Function}} input.fs
 *   injectable filesystem (default bindings are wired by the command layer).
 *   `mkdir` is recursive-parent creation used only by the atomic write.
 * @returns {Promise<object>} bounded structured result
 */
export async function runOnboarding({
  agentId,
  apply = false,
  endorseWorker,
  installRoot,
  exampleRegistryPath,
  targetRegistryPath,
  reliabilitySummaryPath,
  probeEnv,
  fs,
} = {}) {
  const _fs = fs;
  const snippet = buildMcpSnippet({ installRoot });

  // R6-C: the recommendations matrix starts EMPTY (zero probes). It is filled
  // once the template parses; every outcome from the first return on carries the
  // same object through `finalize` — including refused/error — like acceptance.
  let recommendations = emptyRecommendations();
  const finalize = (partial) => baseResult({ ...partial, recommendations });

  // Read + parse the tracked template first. The candidate list (shown even in a
  // bare preview) is derived from it, and every selection is validated against it.
  let template;
  try {
    template = JSON.parse(await _fs.readFile(exampleRegistryPath, "utf8"));
  } catch {
    return finalize({
      outcome: "error",
      selected: false,
      needsSelection: false,
      candidates: [],
      registry: null,
      mcpSnippet: snippet,
      certification: { strictCommand: null, endorseAvailable: false, endorsed: false },
      writes: { registry: false, endorsement: false },
      reason: "could not read or parse the tracked template",
    });
  }
  const candidates = buildCandidateList(template);

  // R6-C: advisory role matrix + environment fit, derived from the template rows
  // + the INJECTED probe. Bounded (≤4 CLI probes + ≤N key probes, memoized per
  // unique name); probe failures degrade to "unknown" and never throw.
  recommendations = await buildRecommendations(candidates, template, probeEnv);

  // Endorsement contract: requires an EXPLICIT, MATCHING selection. Checked before
  // the needs-selection branch so a bare --endorse-worker never reaches selection,
  // and before any write so a mismatch never mutates the summary.
  const wantEndorse = endorseWorker !== undefined;
  if (wantEndorse) {
    if (!agentId) {
      return finalize({
        outcome: "refused",
        selected: false,
        needsSelection: false,
        candidates,
        registry: null,
        mcpSnippet: snippet,
        certification: { strictCommand: null, endorseAvailable: false, endorsed: false },
        writes: { registry: false, endorsement: false },
        reason: "endorsement requires an explicit --agent selection (mutation cannot be implicit)",
      });
    }
    if (endorseWorker !== agentId) {
      return finalize({
        outcome: "refused",
        selected: false,
        needsSelection: false,
        candidates,
        registry: null,
        mcpSnippet: snippet,
        certification: certificationGuidance(agentId, false),
        writes: { registry: false, endorsement: false },
        reason: "endorse worker id must exactly match the selected agent id",
      });
    }
  }

  // No selection ⇒ bounded preview, needs-selection, zero writes (candidates shown).
  if (!agentId) {
    return finalize({
      outcome: "needs-selection",
      selected: false,
      needsSelection: true,
      candidates,
      registry: null,
      mcpSnippet: snippet,
      certification: { strictCommand: null, endorseAvailable: false, endorsed: false },
      writes: { registry: false, endorsement: false },
      reason: "no --agent <id> given: mutation requires an explicit selection (preview shows candidates)",
    });
  }

  // Build + validate the one-worker registry through the EXISTING authority.
  // An unknown id (or invalid template data) fails here, fixed safe, before writes.
  let registry;
  try {
    registry = buildMinimalRegistry({ template, agentId });
    // Re-validate the built entry through the shared normalizer (no second validator).
    normalizeAgent(agentId, registry.agents[agentId]);
  } catch (err) {
    // Fixed safe projection: OnboardingError carries a fixed safe message; any
    // other (raw parser/normalizer) exception is projected to a fixed string.
    // Never echo raw err.message — it may carry paths/internal detail.
    const reason = err instanceof OnboardingError
      ? err.message
      : "registry normalization rejected the built entry";
    return finalize({
      outcome: "refused",
      selected: false,
      needsSelection: false,
      candidates,
      registry: null,
      mcpSnippet: snippet,
      certification: certificationGuidance(agentId, false),
      writes: { registry: false, endorsement: false },
      reason,
    });
  }

  // Preview (no apply, no endorse) ⇒ zero writes.
  if (!apply && !wantEndorse) {
    return finalize({
      outcome: "previewed",
      selected: true,
      needsSelection: false,
      candidates,
      registry,
      mcpSnippet: snippet,
      certification: certificationGuidance(agentId, false),
      writes: { registry: false, endorsement: false },
      reason: null,
    });
  }

  // From here on at least one mutation is requested.
  const writes = { registry: false, endorsement: false };

  // --apply: refuse any existing final registry byte-for-byte (no overwrite).
  if (apply) {
    if (_fs.existsSync(targetRegistryPath)) {
      return finalize({
        outcome: "refused",
        selected: true,
        needsSelection: false,
        candidates,
        registry,
        mcpSnippet: snippet,
        certification: certificationGuidance(agentId, false),
        writes: { registry: false, endorsement: false },
        reason: "a private config/agents.json already exists — onboarding never overwrites an existing registry; delete the copy and re-run --apply to get the generated single-worker version",
      });
    }
    try {
      await atomicWriteJson(targetRegistryPath, registry, _fs);
      writes.registry = true;
    } catch {
      // Fixed safe projection: the raw write/rename error (paths, OS code,
      // credential-bearing paths) never crosses the boundary. atomicWriteJson
      // already removed the temp file; the final registry was never created.
      return finalize({
        outcome: "error",
        selected: true,
        needsSelection: false,
        candidates,
        registry,
        mcpSnippet: snippet,
        certification: certificationGuidance(agentId, false),
        writes: { registry: false, endorsement: false },
        reason: "could not write the private registry",
      });
    }
  }

  // --endorse-worker: amend the reliability summary, preserving everything else.
  if (wantEndorse) {
    let existingSummary = null;
    if (_fs.existsSync(reliabilitySummaryPath)) {
      // Fail closed: an EXISTING summary that cannot be read or parsed as the
      // expected JSON object is left byte-for-byte intact with ZERO writes — we
      // never overwrite or "repair" a file we cannot understand (no mkdir, no
      // temp, no rename). Only a GENUINELY ABSENT path later proceeds to create
      // a new minimal summary. Fixed safe reason; never echo read/parse detail.
      try {
        existingSummary = JSON.parse(await _fs.readFile(reliabilitySummaryPath, "utf8"));
      } catch {
        return finalize({
          outcome: "error",
          selected: true,
          needsSelection: false,
          candidates,
          registry,
          mcpSnippet: snippet,
          certification: certificationGuidance(agentId, false),
          writes, // registry may already be written; report truthfully; summary untouched
          reason: "existing reliability summary is unreadable; left unchanged",
        });
      }
      if (!isPlainObject(existingSummary)) {
        return finalize({
          outcome: "error",
          selected: true,
          needsSelection: false,
          candidates,
          registry,
          mcpSnippet: snippet,
          certification: certificationGuidance(agentId, false),
          writes,
          reason: "existing reliability summary is not a valid summary object; left unchanged",
        });
      }
    }
    const amended = applyEndorsement(existingSummary, agentId);
    try {
      await atomicWriteJson(reliabilitySummaryPath, amended, _fs);
      writes.endorsement = true;
    } catch {
      // Fixed safe projection: the raw write/rename error never crosses the
      // boundary. atomicWriteJson already removed the temp; an existing summary
      // (if any) was never touched.
      return finalize({
        outcome: "error",
        selected: true,
        needsSelection: false,
        candidates,
        registry,
        mcpSnippet: snippet,
        certification: certificationGuidance(agentId, false),
        writes, // registry may already be written; report truthfully
        reason: "could not write the reliability summary",
      });
    }
  }

  return finalize({
    outcome: "applied",
    selected: true,
    needsSelection: false,
    candidates,
    registry,
    mcpSnippet: snippet,
    certification: certificationGuidance(agentId, wantEndorse),
    writes,
    reason: null,
  });
}

// Assemble the bounded result object (single source for --json + human output).
function baseResult(partial) {
  return {
    mode: partial.outcome === "needs-selection" || partial.outcome === "previewed" ? "preview" : "apply",
    outcome: partial.outcome,
    selected: partial.selected,
    needsSelection: partial.needsSelection,
    candidates: partial.candidates,
    registry: partial.registry,
    mcpSnippet: partial.mcpSnippet,
    // R5-D: bounded per-host one-line registration EXAMPLES, derived purely
    // from mcpSnippet (single source). Examples, not authority — host flags
    // drift with host versions; the host-neutral snippet above and
    // docs/usage.md §MCP stdio remain the authority and the fallback.
    hostExamples: buildHostExamples(partial.mcpSnippet),
    // Bounded Host-neutral advisory acceptance projection (see buildAcceptance).
    // Carried by EVERY outcome — including refused/error — so a Fresh Lead always
    // sees the acceptance chain, PASS facts, and closed recovery branches.
    acceptance: buildAcceptance(),
    // R6-C: advisory role-matrix recommendations (single source shared by --json
    // and human output, like acceptance). Defaults to the empty matrix so a call
    // site can never drop the field.
    recommendations: partial.recommendations ?? emptyRecommendations(),
    certification: partial.certification,
    writes: partial.writes,
    reason: partial.reason ?? null,
  };
}
