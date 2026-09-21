// src/application/sessionReuse.js
//
// M11-11C: provider-neutral expert session reuse SSOT.
//
// When the same MCP Lead session asks the same configured reusable expert
// another non-delivery question in the same bound Git workspace, WAO reuses
// the provider-native conversation (e.g. a Claude Code session) for context/
// cache, while creating a NEW WAO run/transcript for independent supervision.
//
// This module owns the provider-NEUTRAL reuse contract — no runtime-name
// branching lives here. Layering bucket: this module is core(2) via the
// CORE_MEMBERS member exception in test/isolation-infra/layering.test.js
// (TD-122) — it consumes ../transcript.js (core) and is a service, not a
// leaf. Its 5 static consumers are all legal edges (zero upward violations):
//   - registry.js            (closed-set validation of `sessionReuse` policy)
//   - runManager.js          (capability gate + pass routing to backend.spawn)
//   - runContinue.js         (lineage turn resolution + rollback claim release)
//   - runDispatch.js         (resolve a reuse turn, thread routing to argv,
//                             busy-check before transcript/fork)
//   - backgroundRunner.js    (parse the threaded routing)
// claudeCode.js consumes the routing envelope indirectly via backend.spawn
// args (translate to --session-id / --resume) — not an import edge.
//
// Architectural contract:
//   - Does not import src/commands/*, src/mcp/*, the MCP SDK, or zod.
//   - Depends on node:crypto, node:fs/promises, node:path, ../transcript.js
//     (readTranscript/findState/findLatestBound — the transcript SSOT; R14 the
//     session.created read is runId-BOUND to the prior run, R15 likewise the
//     three findState prior-state projections), and
//     ../canonicalAgentId.js. The transcript is the source of truth for the
//     authoritative state of a prior matching run.
//
// Security contract (contracts 2, 5, 8):
//   - The reuse identity is (Lead session id + canonical bound workspace +
//     canonical agentId). The Lead id is SERVER-OWNED — generated/injected by
//     the MCP server, never supplied by the model, never returned via MCP.
//   - deriveOpaqueUuid turns that triple into a stable, OPAQUE UUID v4 that is
//     the only value handed to a provider (e.g. claude --session-id/--resume).
//     The raw Lead id, workspace path, and agentId never appear in the opaque
//     uuid, in MCP output, or in the bounded routing audit event.
//   - Only bounded routing facts are persisted: the routing index stores
//     {runId, updatedAt} keyed by a sha256 of the opaque uuid; the transcript
//     audit event stores only {mode, turn}. The RESUME routing envelope adds
//     the prior WAO runId (internal identifier, never a credential) so the
//     provider session id can be recovered from the transcript SSOT at runner
//     time (resolvePriorProviderSessionId) — the provider session id itself
//     never enters argv.

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { TERMINAL_STATES, readTranscript, findState, findLatestBound } from "../transcript.js";
import { isValidCanonicalAgentId } from "../canonicalAgentId.js";

/**
 * Closed set of AGENT-DECLARED reuse policies. Today: a single policy that
 * reuses the provider-native conversation scoped to (Lead session, bound
 * workspace, agent). Adding a policy is a deliberate contract change — values
 * outside this set are rejected by the registry normalizer.
 *
 * NOTE: run_lineage is NOT an agent-declared policy. It is a routing-only mode
 * derived from an explicit Lead `continuable` delivery (M12-7); agents never
 * declare it. It therefore lives in SESSION_ROUTING_MODES (the envelope set),
 * not here.
 */
export const SESSION_REUSE_MODES = Object.freeze(["lead_workspace"]);
export const SESSION_REUSE_TURNS = Object.freeze(["first", "resume"]);

/**
 * Closed set of modes permitted in the internal routing envelope
 * {mode, opaqueUuid, turn[, priorRunId]} that reaches a backend. This is the
 * union of the agent-declared policy (lead_workspace) and the lineage routing
 * mode (run_lineage) introduced by M12-7. Both compile to the same provider
 * flags (--session-id / --resume) via the capability gate; the mode only
 * selects the opaque-uuid keyspace.
 */
export const SESSION_ROUTING_MODES = Object.freeze(["lead_workspace", "run_lineage"]);

// Conservative runId component validator (mirrors delivery.isValidRunId without
// importing delivery.js — keeps this module's dependency contract intact).
// Rejects path separators, shell metacharacters, leading dot/dash.
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

const OPAQUE_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidSessionReuseMode(value) {
  return typeof value === "string" && SESSION_REUSE_MODES.includes(value);
}

/**
 * Validate the internal routing envelope before it can reach a backend.
 * Requested reuse must never silently degrade into a fresh conversation.
 *
 * The envelope is a closed, turn-conditional shape (ADR-0031 §3.6 association
 * contract, R2):
 *   - turn "first"  : exactly {mode, opaqueUuid, turn} — no prior exists.
 *   - turn "resume" : exactly {mode, opaqueUuid, turn, priorRunId} — the PRIOR
 *     WAO runId (internal identifier, not a credential; RUN_ID_RE-constrained)
 *     whose transcript holds the provider session to resume. The provider
 *     session id itself NEVER travels in the envelope/argv; it is recovered at
 *     runner time from the transcript SSOT via resolvePriorProviderSessionId.
 * mode must be a member of SESSION_ROUTING_MODES (lead_workspace policy OR
 * run_lineage continuation routing). Any extra/missing key, unknown mode, bad
 * turn, non-uuid, or a resume without a valid priorRunId throws the fixed-shape
 * error.
 *
 * @param {unknown} value
 * @returns {{mode:string, turn:"first"|"resume", opaqueUuid:string, priorRunId?:string}}
 */
export function validateSessionReuseRouting(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const baseValid = keys.length >= 3
    && keys[0] === "mode"
    && keys[1] === "opaqueUuid"
    && SESSION_ROUTING_MODES.includes(value?.mode)
    && SESSION_REUSE_TURNS.includes(value?.turn)
    && typeof value?.opaqueUuid === "string"
    && OPAQUE_SESSION_UUID.test(value.opaqueUuid);
  // §3.6: resume carries the prior WAO runId (the association handle); first
  // forbids it. The shape stays closed per turn — never "any extra key".
  const priorValid = value?.turn === "resume"
    ? keys.length === 4
      && keys[2] === "priorRunId"
      && keys[3] === "turn"
      && typeof value.priorRunId === "string"
      && RUN_ID_RE.test(value.priorRunId)
      && !/^[.-]/.test(value.priorRunId)
    : keys.length === 3
      && keys[2] === "turn";
  if (!baseValid || !priorValid) {
    throw new Error("sessionReuse: invalid internal routing envelope");
  }
  return value;
}

// A routing entry is considered "stale" (assumed crashed) if it has not
// heartbeaten for this long. Bounds the BUSY window when a prior runner died
// without ever reaching a terminal state (e.g. host killed mid-run): the slot
// self-heals and the next turn starts a fresh provider conversation.
const STALE_MS = 5 * 60 * 1000;

// Cross-process mutual-exclusion timeout for the per-key routing lock.
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;
const LOCK_POLL_MS = 5;

/**
 * Canonicalize a workspace path to a stable string for reuse-identity hashing.
 *
 * This is a PURE transformation (no filesystem access): normalize separators,
 * collapse repeats, trim trailing slash, and fold the Windows drive-letter to
 * a single case (matching proveWorkspace's platform identity semantics). The
 * bound workspace reaching dispatchRun is already canonicalized by the host
 * authority (proveWorkspace); canonicalizing again here guarantees that two
 * turns describing the same physical workspace identically hash to the same
 * opaque uuid, and that distinct workspaces hash distinctly.
 *
 * @param {string} p
 * @returns {string}
 */
function canonicalizeWorkspacePath(p) {
  if (typeof p !== "string" || p.length === 0) return p;
  let n = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (n.length > 1 && n.endsWith("/")) n = n.slice(0, -1);
  // Windows drive letter (2nd char === ':') → uppercase for a stable canonical form.
  if (n.length >= 2 && n[1] === ":") {
    n = n[0].toUpperCase() + n.slice(1);
  }
  return n;
}

/**
 * Validate + canonicalize the reuse identity inputs.
 * @returns {{leadSession:string, workspace:string, agentId:string}}
 * @throws {Error} if any input is missing/invalid (fixed safe shape — never
 *   echoes the raw Lead id or workspace path in a way that could leak).
 */
function canonicalReuseInput({ leadSession, workspace, agentId }) {
  if (typeof leadSession !== "string" || leadSession.length === 0) {
    throw new Error("sessionReuse: leadSession is required (server-owned Lead session identity)");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("sessionReuse: workspace (canonical bound workspace) is required");
  }
  if (!isValidCanonicalAgentId(agentId)) {
    throw new Error("sessionReuse: agentId must be a valid canonical id");
  }
  return {
    leadSession,
    workspace: canonicalizeWorkspacePath(workspace),
    agentId,
  };
}

/**
 * Derive a deterministic, OPAQUE UUID v4 from the reuse identity.
 *
 * This is the value handed to the provider as `--session-id <uuid>` (first
 * turn) / `--resume <same uuid>` (later turns). It is stable across turns for
 * the same (Lead session, workspace, agent) triple and isolated across
 * triples. It does NOT reveal the raw Lead id, workspace path, or agentId.
 *
 * @param {{leadSession:string, workspace:string, agentId:string}} input
 * @returns {string} a well-formed RFC 4122 v4 UUID
 */
export function deriveOpaqueUuid({ leadSession, workspace, agentId }) {
  const c = canonicalReuseInput({ leadSession, workspace, agentId });
  // Delimiter-tagged material prevents cross-field collision ambiguity.
  const material = `lead=${c.leadSession}\nworkspace=${c.workspace}\nagent=${c.agentId}`;
  const digest = createHash("sha256").update(material, "utf8").digest();
  // Format the first 16 bytes as an RFC 4122 v4 UUID (set version + variant).
  digest[6] = (digest[6] & 0x0f) | 0x40; // version 4
  digest[8] = (digest[8] & 0x3f) | 0x80; // variant 10
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Derive the routing-index key — sha256 of the opaque uuid. Used as the
 * routing-store filename so the provider session id never appears in a
 * discoverable filesystem path.
 *
 * @param {{leadSession:string, workspace:string, agentId:string}} input
 * @returns {string} 64-char hex
 */
export function deriveReuseKeyHash(input) {
  const opaque = deriveOpaqueUuid(input);
  return createHash("sha256").update(opaque, "utf8").digest("hex");
}

/**
 * ADR-0031 §3.6 (fail-closed association): a routing entry that EXISTS but
 * cannot be parsed into the bounded {runId, updatedAt} shape is DAMAGED, not
 * absent. Reading it as absent would silently route a fresh first turn — the
 * exact silent-new-session behavior §3.6 forbids. Distinguish ENOENT (no entry
 * ever written — the sanctioned "no prior routing entry ⇒ first" bootstrap of
 * the M11-11C contract) from any other read/parse/shape failure (refuse).
 */
const ROUTING_ENTRY_DAMAGED_TEXT = "sessionReuse: routing entry for this reuse identity is damaged (present but unparseable or malformed) — refusing instead of silently starting a fresh provider conversation";

// §3.6/R3: the prior run's transcript records that a provider session EXISTS
// (a bound session.created), but the recorded id is not addressable. Refuse —
// never a silent fresh conversation, never a resume against an unusable id.
const PRIOR_SESSION_UNADDRESSABLE_TEXT = "sessionReuse: prior run has a bound session.created but no addressable provider session id (backendSessionId missing/empty/non-string) — refusing resume instead of silently starting a fresh provider conversation";

async function readRoutingEntryFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(ROUTING_ENTRY_DAMAGED_TEXT);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(ROUTING_ENTRY_DAMAGED_TEXT);
  }
  // §3.6 item 5 (audit finding A3 [高], 2026-09-21): a PRESENT-but-malformed
  // entry is damage, never "a crashed prior run". The pre-audit reader accepted
  // any non-empty runId string, and resolveReuseTurn coerced a bad updatedAt to
  // 0 — so {"runId":"bad/id"} and {"runId":"run_missing","updatedAt":"broken"}
  // both fell through to turn:first and silently started a FRESH provider
  // conversation, contradicting the §3.6 refusal contract. Both shapes are now
  // refused here (single SSOT; the injected test stores are unaffected).
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || typeof parsed.runId !== "string" || parsed.runId.length === 0
    || !RUN_ID_RE.test(parsed.runId) || /^[.-]/.test(parsed.runId)) {
    throw new Error(ROUTING_ENTRY_DAMAGED_TEXT);
  }
  // updatedAt is part of the bounded routing fact ({runId, updatedAt}); every
  // writer in this module writes a finite NON-NEGATIVE epoch-ms number, so
  // anything else is damage rather than an implied "very old" (re-check
  // finding R1 [高], 2026-09-21: a negative value used to read as long-stale).
  if (!Number.isFinite(parsed.updatedAt) || parsed.updatedAt < 0) {
    throw new Error(ROUTING_ENTRY_DAMAGED_TEXT);
  }
  return parsed;
}

/**
 * Default filesystem routing store: one JSON file per reuse key under
 * `<runDir>/.session-reuse/`. Each entry is a bounded routing fact:
 * `{ runId, updatedAt }`. The opaque uuid / Lead id / workspace are never
 * persisted here — they are recomputed deterministically each turn.
 *
 * @param {string} runDir
 * @returns {{dir:string, lockDir:string, readEntry:Function, writeEntry:Function}}
 */
function defaultReuseStore(runDir) {
  const dir = join(runDir, ".session-reuse");
  const lockDir = join(dir, ".locks");
  return {
    dir,
    lockDir,
    async readEntry(keyHash) {
      return readRoutingEntryFile(join(dir, `${keyHash}.json`));
    },
    async writeEntry(keyHash, entry) {
      await mkdir(dir, { recursive: true });
      await writeAtomicEntry(join(dir, `${keyHash}.json`), entry);
    },
  };
}

/**
 * §3.6 item 2 — atomic routing-entry write (audit finding A3 [中], 2026-09-21).
 * A plain whole-file writeFile is NOT atomic: an interrupted write could leave a
 * truncated entry where a good one used to be. Write a sibling temp file and
 * rename() over the target instead — rename replaces atomically on the same
 * volume (Windows: MoveFileEx + MOVEFILE_REPLACE_EXISTING), so the target always
 * holds either the previous complete entry or the new complete entry.
 */
async function writeAtomicEntry(target, entry) {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(entry), "utf8");
  await rename(tmp, target);
}

/**
 * Acquire a cross-process, per-key file lock. Mirrors the transcript append
 * lock pattern (open wx, retry on EEXIST, stale removal). The lock spans the
 * read-decide-write of resolveReuseTurn so two concurrent dispatches for the
 * same reuse identity cannot both decide "first" and fork concurrently.
 */
async function withKeyLock(store, keyHash, fn) {
  await mkdir(store.lockDir, { recursive: true });
  const lockPath = join(store.lockDir, `${keyHash}.lock`);
  const start = Date.now();
  let handle;
  while (true) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf8");
      break;
    } catch (error) {
      // Any non-EEXIST error is a real failure (permissions, disk, etc.).
      if (error?.code !== "EEXIST") throw error;
      // Best-effort stale removal.
      try {
        const raw = await readFile(lockPath, "utf8");
        const data = JSON.parse(raw);
        if (Date.now() - Number(data.ts) > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {});
        }
      } catch {
        // If unreadable, let the timeout path decide.
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`sessionReuse: timed out waiting for routing lock (key ${keyHash.slice(0, 8)})`);
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * Decide a reuse turn for (Lead session, workspace, agent): first / resume /
 * busy. Provider-neutral; reads only the transcript SSOT for prior state.
 *
 * Decision matrix (transcript is the source of truth):
 *   - no prior routing entry                                    ⇒ first
 *   - routing entry PRESENT but damaged (unparseable/malformed) ⇒ REFUSE (§3.6)
 *   - prior run non-terminal (in-flight)                        ⇒ busy
 *   - prior run terminal + bound session.created with a
 *     non-empty string backendSessionId                         ⇒ resume
 *     (envelope carries priorRunId; the provider session id is
 *     re-read from the prior transcript at runner time)
 *   - prior run terminal + bound session.created whose
 *     backendSessionId is missing/empty/non-string             ⇒ REFUSE (§3.6)
 *   - prior run terminal but NO session.created (crashed pre-   ⇒ first
 *     conversation; no provider session to resume)
 *   - prior transcript missing + entry recent                   ⇒ busy (in-flight)
 *   - prior transcript missing + entry stale                    ⇒ first (crashed)
 *
 * On first/resume, the routing slot is CLAIMED under the lock for the new
 * `runId` (updatedAt = now), so a concurrent dispatch for the same identity
 * observes the new run as in-flight and returns busy instead of forking a
 * second provider turn concurrently.
 *
 * @param {object} input
 * @param {string} input.runDir
 * @param {string} input.runId — the prospective NEW runId for this turn
 * @param {string} input.leadSession
 * @param {string} input.workspace
 * @param {string} input.agentId
 * @param {object} [input.reuseStore] — injectable for tests
 * @param {number} [input.now=Date.now()] — injectable clock for tests
 * @returns {Promise<{kind:"first", routing:{mode, opaqueUuid, turn:"first"}} | {kind:"resume", routing:{mode, opaqueUuid, turn:"resume", priorRunId:string}} | {kind:"busy", activeRunId:string}>}
 */
export async function resolveReuseTurn({ runDir, runId, leadSession, workspace, agentId, reuseStore, now }) {
  const store = reuseStore ?? defaultReuseStore(runDir);
  const clock = typeof now === "number" ? now : Date.now();
  const keyHash = deriveReuseKeyHash({ leadSession, workspace, agentId });
  const opaqueUuid = deriveOpaqueUuid({ leadSession, workspace, agentId });
  const routing = { mode: "lead_workspace", opaqueUuid };

  return withKeyLock(store, keyHash, async () => {
    const entry = await store.readEntry(keyHash);

    // A prior/other run claims this slot.
    if (entry && entry.runId && entry.runId !== runId) {
      const priorPath = join(runDir, `${entry.runId}.jsonl`);
      let events = [];
      let exists = true;
      try {
        events = await readTranscript(priorPath);
      } catch {
        exists = false;
        events = [];
      }

      if (exists && events.length > 0) {
        // R15 (TD-128 findState family): the prior-state projection is BOUND to
        // the prior run — the same filter discipline as runDelivery.js's
        // findState(events.filter(...)). findState is last-wins over the raw
        // array, so an append-only foreign/envelope-less tail line used to WIN
        // this gate (coder_mm adversarial probe): an in-flight prior (bound
        // session.created + running) plus a foreign run.state_change{to:
        // "completed"} tail flipped busy → resume — the same provider session
        // driven concurrently, a live Contract 6 violation; a forged running
        // tail over a terminal prior blocked dispatch instead. The state is now
        // computed ONLY from the prior run's own events; foreign lines are
        // invisible, not fatal — the gate degrades instead of failing the
        // routing closed. A FULLY pre-envelope prior transcript (zero bound
        // events) now projects "pending" → busy here: a prior whose state
        // cannot be attributed is treated as in-flight and never concurrently
        // driven (envelope-era transcripts always carry bound state_changes;
        // pre-envelope priors measure ≈0 on this install, TD-129b).
        const state = findState(events.filter((e) => e && e.runId === entry.runId));
        if (state && !TERMINAL_STATES.includes(state)) {
          // Contract 6: never concurrently drive the same provider session.
          return { kind: "busy", activeRunId: entry.runId };
        }
        // Terminal. Resumable only after a valid session.created BOUND to this
        // prior run (contract 6). R14 (TD-128a): the read goes through the
        // shared findLatestBound reader — the unbound findLatest let a
        // tail-appended foreign/envelope-less session.created flip the routing
        // decision (a crashed-pre-conversation prior run read as resumable).
        // This function has NO upstream identity gate (no
        // extractCanonicalAgentId here — findState + this read are all that
        // run), so unlike the runCorrection/runContinue lanes the binding is a
        // LIVE behavior change, not just discipline consistency.
        //
        // §3.6 association (ADR-0031, R3): the bound session.created must carry
        // an ADDRESSABLE provider session — a non-empty string backendSessionId.
        // Present-but-unusable (missing/empty/non-string) means the association
        // surface is damaged while a provider session was recorded to exist:
        // fail-closed REFUSAL, never a silent fresh conversation and never a
        // resume against an unattributable id.
        //
        // Legacy choice (explicit, R14; scope narrowed by R15): a prior whose
        // bound events project terminal but that has NO bound session.created
        // AT ALL — crashed pre-conversation, or a session.created line that is
        // itself foreign/envelope-less (R14-SR-1/SR-3 probes) — DEGRADES to the
        // existing "terminal without session.created" branch: the slot is
        // claimed as a fresh FIRST turn, never a refusal. (A FULLY pre-envelope
        // prior transcript also landed here as first before R15; R15's bound
        // state gate above now stops it earlier as busy — see the R15 note.)
        // Rationale: the safety-critical direction is never RESUMING a session
        // that cannot be attributed to the prior run; a fresh first turn
        // resumes nothing untrusted (the opaque uuid is derived from the
        // identity triple, not from the transcript). Pre-envelope prior
        // transcripts measure ≈0 on this install (TD-129b), so the practical
        // cost of the lost resume is nil. This is a degrade, not fail-closed,
        // because the dispatch decision it feeds is turn selection — blocking
        // the Lead's dispatch over unattributable history would be
        // disproportionate. (An EXISTING-but-unusable session.created does NOT
        // land here — that is the §3.6 refusal above, not this degrade.)
        const priorSession = findLatestBound(events, "session.created", entry.runId);
        if (priorSession) {
          const priorBackendSessionId = priorSession.backendSessionId;
          if (typeof priorBackendSessionId !== "string" || priorBackendSessionId.length === 0) {
            throw new Error(PRIOR_SESSION_UNADDRESSABLE_TEXT);
          }
          await store.writeEntry(keyHash, { runId, updatedAt: clock });
          // §3.6/R2: the resume envelope carries the PRIOR WAO runId — the
          // association handle. The provider session id itself is recovered at
          // runner time from the prior transcript (resolvePriorProviderSessionId),
          // never from the envelope/argv.
          return {
            kind: "resume",
            routing: { ...routing, turn: "resume", priorRunId: entry.runId },
          };
        }
        // Terminal without session.created — crashed before the backend
        // conversation started. No provider session exists to resume → fall
        // through to claim the slot as a fresh first turn.
      } else {
        // Transcript missing. Recent entry → assume in-flight (busy); stale →
        // assume crashed (first), reusing the slot.
        //
        // Re-check finding R1 [高] (2026-09-21): a NEGATIVE age (the entry's
        // updatedAt is in the future) is not "an old crashed entry" — it is a
        // nonsensical/clock-skewed/tampered timestamp. Falling through to
        // turn:first there silently abandoned a possibly-live association, the
        // same class of defect as the shapes fixed in TD-175. It is damage.
        const age = clock - entry.updatedAt;
        if (!Number.isFinite(age) || age < 0) {
          throw new Error(ROUTING_ENTRY_DAMAGED_TEXT);
        }
        if (age < STALE_MS) {
          return { kind: "busy", activeRunId: entry.runId };
        }
        // stale + missing → first (fall through).
      }
    }

    // Claim the slot for this new first turn.
    await store.writeEntry(keyHash, { runId, updatedAt: clock });
    return { kind: "first", routing: { ...routing, turn: "first" } };
  });
}

/**
 * Recover the PRIOR run's provider session id from the transcript SSOT at
 * runner time (ADR-0031 §3.6 association, R2). The resume envelope carries only
 * the prior WAO runId; this bound reader turns that handle back into the
 * addressable provider session id (session.created.backendSessionId, LAST-bound
 * to the prior run — the same lane discipline resolveReuseTurn's decision read
 * uses). Called by the spawn authority (RunManager.start) BEFORE transcript/
 * worktree/spawn, and the resolved id crosses to the backend in the in-process
 * task object — it never travels in argv.
 *
 * Fail-closed on EVERY failure mode (§3.6 item 5): prior transcript missing or
 * unparseable, no session.created bound to the prior run, or a
 * backendSessionId that is missing/empty/non-string — each refuses with a
 * fixed text; none silently starts a fresh conversation. (Whether an upstream
 * `session/resume` then rejects the recovered id is the backend's fail-closed
 * lane — never fall back to session/new.)
 *
 * @param {object} input
 * @param {string} input.runDir — transcript directory (spawn authority's runDir)
 * @param {string} input.priorRunId — the resume envelope's prior WAO runId
 * @returns {Promise<string>} the addressable provider session id
 */
export async function resolvePriorProviderSessionId({ runDir, priorRunId }) {
  if (typeof runDir !== "string" || runDir.length === 0
    || typeof priorRunId !== "string"
    || !RUN_ID_RE.test(priorRunId) || /^[.-]/.test(priorRunId)) {
    throw new Error(PRIOR_SESSION_UNADDRESSABLE_TEXT);
  }
  let events;
  try {
    events = await readTranscript(join(runDir, `${priorRunId}.jsonl`));
  } catch {
    throw new Error("sessionReuse: prior transcript for resume is missing or unparseable — refusing instead of silently starting a fresh provider conversation");
  }
  const created = findLatestBound(events, "session.created", priorRunId);
  const sessionId = created?.backendSessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(PRIOR_SESSION_UNADDRESSABLE_TEXT);
  }
  return sessionId;
}

// ===== M12-7: lineage-scoped provider session reuse =====
//
// A Lead-authorized correction continuation reuses the provider-native
// conversation scoped to ONE explicit run lineage (root runId), never to all
// coder work in a project. The opaque provider UUID is derived from
// (Lead session + canonical workspace + canonical agentId + rootRunId). It is
// stable across the whole lineage (first turn + every continuation) and
// isolated across lineages. The same per-key lock/busy discipline as
// lead_workspace is reused, keyed by a sha256 of the lineage opaque uuid.

/**
 * Validate + canonicalize the lineage reuse identity inputs.
 * @returns {{leadSession:string, workspace:string, agentId:string, rootRunId:string}}
 * @throws {Error} on any missing/invalid input (fixed safe shape).
 */
function canonicalLineageReuseInput({ leadSession, workspace, agentId, rootRunId }) {
  const c = canonicalReuseInput({ leadSession, workspace, agentId });
  if (typeof rootRunId !== "string" || !RUN_ID_RE.test(rootRunId) || /^[.-]/.test(rootRunId)) {
    throw new Error("sessionReuse: rootRunId must be a valid run id component");
  }
  return { ...c, rootRunId };
}

/**
 * Derive a deterministic, OPAQUE UUID v4 for a run lineage.
 *
 * Same inputs across the lineage → same uuid → the provider conversation is
 * resumed (`--resume <uuid>`). Distinct root runId → distinct uuid → isolated
 * conversation. The `mode=run_lineage` tag guarantees the keyspace never
 * collides with a lead_workspace uuid derived from the same triple.
 *
 * @param {{leadSession:string, workspace:string, agentId:string, rootRunId:string}} input
 * @returns {string} a well-formed RFC 4122 v4 UUID
 */
export function deriveLineageOpaqueUuid(input) {
  const c = canonicalLineageReuseInput(input);
  const material = `mode=run_lineage\nlead=${c.leadSession}\nworkspace=${c.workspace}\nagent=${c.agentId}\nroot=${c.rootRunId}`;
  const digest = createHash("sha256").update(material, "utf8").digest();
  digest[6] = (digest[6] & 0x0f) | 0x40; // version 4
  digest[8] = (digest[8] & 0x3f) | 0x80; // variant 10
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Derive the lineage routing-index key — sha256 of the lineage opaque uuid.
 * Used as the lineage-store filename so the provider session id never appears
 * in a discoverable filesystem path.
 * @returns {string} 64-char hex
 */
export function deriveLineageReuseKeyHash(input) {
  const opaque = deriveLineageOpaqueUuid(input);
  return createHash("sha256").update(opaque, "utf8").digest("hex");
}

/**
 * Default filesystem lineage routing store: one JSON file per lineage key under
 * `<runDir>/.lineage-reuse/`. Each entry is a bounded routing fact
 * `{ runId, updatedAt }`. The opaque uuid / Lead id / workspace / rootRunId are
 * never persisted here — they are recomputed deterministically each turn.
 * Same §3.6 damage discipline as defaultReuseStore (ENOENT = absent; anything
 * else = damaged = refuse).
 */
function defaultLineageStore(runDir) {
  const dir = join(runDir, ".lineage-reuse");
  const lockDir = join(dir, ".locks");
  return {
    dir,
    lockDir,
    async readEntry(keyHash) {
      return readRoutingEntryFile(join(dir, `${keyHash}.json`));
    },
    async writeEntry(keyHash, entry) {
      await mkdir(dir, { recursive: true });
      await writeAtomicEntry(join(dir, `${keyHash}.json`), entry);
    },
    async deleteEntry(keyHash) {
      await unlink(join(dir, `${keyHash}.json`)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    },
  };
}

/**
 * Decide the lineage turn for an INITIAL continuable delivery: always claims
 * the lineage slot as turn:first under the per-key lock. The root runId is the
 * new run's own id. A non-terminal prior owner (impossible for a fresh root,
 * possible under adversarial reuse) is reported busy.
 *
 * @param {object} input
 * @param {string} input.runDir
 * @param {string} input.runId — the new root runId (=== rootRunId for the first turn)
 * @param {string} input.leadSession
 * @param {string} input.workspace
 * @param {string} input.agentId
 * @param {string} input.rootRunId
 * @param {object} [input.reuseStore]
 * @param {number} [input.now]
 * @returns {Promise<{kind:"first", routing:{mode:"run_lineage", opaqueUuid:string, turn:"first"}} | {kind:"busy", activeRunId:string}>}
 */
export async function resolveLineageFirstTurn({ runDir, runId, leadSession, workspace, agentId, rootRunId, reuseStore, now }) {
  const store = reuseStore ?? defaultLineageStore(runDir);
  const clock = typeof now === "number" ? now : Date.now();
  const keyHash = deriveLineageReuseKeyHash({ leadSession, workspace, agentId, rootRunId });
  const opaqueUuid = deriveLineageOpaqueUuid({ leadSession, workspace, agentId, rootRunId });
  const routing = { mode: "run_lineage", opaqueUuid };

  return withKeyLock(store, keyHash, async () => {
    const entry = await store.readEntry(keyHash);
    if (entry && entry.runId && entry.runId !== runId) {
      // A prior owner exists for this lineage key. If non-terminal, refuse.
      const priorPath = join(runDir, `${entry.runId}.jsonl`);
      let events = [];
      let exists = true;
      try { events = await readTranscript(priorPath); } catch { exists = false; events = []; }
      if (exists && events.length > 0) {
        // R15 (TD-128 findState family): BOUND to the prior slot owner
        // (entry.runId — the transcript read is that run's file), the same
        // filter discipline as resolveReuseTurn above. findState is last-wins
        // over the raw array, so a foreign run.state_change tail used to flip
        // this first-claim gate (coder_mm probe P6b): a non-terminal prior
        // owner plus a foreign completed tail read terminal → the lineage slot
        // was claimed first while the real owner was still in flight (two
        // drivers on one provider session, Contract 6); a forged running tail
        // over a terminal owner blocked the claim instead. State now comes
        // ONLY from the prior owner's own events; a fully pre-envelope owner
        // transcript projects "pending" → busy (unattributable = in-flight).
        const state = findState(events.filter((e) => e && e.runId === entry.runId));
        if (state && !TERMINAL_STATES.includes(state)) {
          return { kind: "busy", activeRunId: entry.runId };
        }
      } else {
        const age = clock - (Number(entry.updatedAt) || 0);
        if (Number.isFinite(age) && age >= 0 && age < STALE_MS) {
          return { kind: "busy", activeRunId: entry.runId };
        }
      }
    }
    await store.writeEntry(keyHash, { runId, updatedAt: clock });
    return { kind: "first", routing: { ...routing, turn: "first" } };
  });
}

/**
 * Decide the lineage turn for a CORRECTION CONTINUATION of a terminal parent.
 *
 * The parent (or a prior continuation in the same lineage) must not be
 * non-terminal: a lineage/provider session cannot be driven concurrently. When
 * the slot is free (prior owner terminal or absent), it is claimed for the new
 * child runId and turn:resume is returned with the SAME opaque uuid as the
 * first turn — so the provider conversation resumes, not restarts.
 *
 * This is the per-key concurrency gate for run_continue: two concurrent
 * continuations of the same parent serialize here; the loser observes the
 * winner's non-terminal child and is refused busy before any worktree/spawn.
 *
 * @param {object} input
 * @param {string} input.runDir
 * @param {string} input.runId — the prospective NEW child runId
 * @param {string} input.parentRunId — the direct parent (terminal)
 * @param {string} input.rootRunId — the lineage root (stable across turns)
 * @param {string} input.leadSession
 * @param {string} input.workspace
 * @param {string} input.agentId
 * @param {object} [input.reuseStore]
 * @param {number} [input.now]
 * @returns {Promise<{kind:"resume", routing:{mode:"run_lineage", opaqueUuid:string, turn:"resume"}} | {kind:"busy", activeRunId:string}>}
 */
export async function resolveLineageContinuationTurn({ runDir, runId, parentRunId, rootRunId, leadSession, workspace, agentId, reuseStore, now }) {
  const store = reuseStore ?? defaultLineageStore(runDir);
  const clock = typeof now === "number" ? now : Date.now();
  const keyHash = deriveLineageReuseKeyHash({ leadSession, workspace, agentId, rootRunId });
  const opaqueUuid = deriveLineageOpaqueUuid({ leadSession, workspace, agentId, rootRunId });
  const routing = { mode: "run_lineage", opaqueUuid };

  return withKeyLock(store, keyHash, async () => {
    const entry = await store.readEntry(keyHash);
    if (entry && entry.runId && entry.runId !== runId) {
      const priorPath = join(runDir, `${entry.runId}.jsonl`);
      let events = [];
      let exists = true;
      try { events = await readTranscript(priorPath); } catch { exists = false; events = []; }
      if (exists && events.length > 0) {
        // R15 (TD-128 findState family): BOUND to the prior slot owner
        // (entry.runId — the parent or a prior continuation that claimed the
        // lineage key), the same filter discipline as resolveReuseTurn above.
        // findState is last-wins over the raw array, so a foreign
        // run.state_change tail used to flip this continuation busy gate
        // (coder_mm probe P6): an in-flight prior owner plus a foreign
        // completed tail read terminal → the lineage provider session was
        // reclaimed and resumed while the owner was still running (Contract
        // 6); a forged running tail over a terminal owner refused the
        // continuation instead. State now comes ONLY from the prior owner's
        // own events; a fully pre-envelope owner transcript projects "pending"
        // → busy (unattributable = in-flight).
        const state = findState(events.filter((e) => e && e.runId === entry.runId));
        if (state && !TERMINAL_STATES.includes(state)) {
          // Non-terminal owner: a concurrent continuation or an in-flight
          // sibling. Refuse before any worktree mutation or spawn.
          return { kind: "busy", activeRunId: entry.runId };
        }
        // Terminal owner (the parent reached terminal). Reclaim for the child.
      } else {
        const age = clock - (Number(entry.updatedAt) || 0);
        if (Number.isFinite(age) && age >= 0 && age < STALE_MS) {
          return { kind: "busy", activeRunId: entry.runId };
        }
      }
    }
    await store.writeEntry(keyHash, { runId, updatedAt: clock });
    return {
      kind: "resume",
      // §3.6/R2: resume envelopes carry the prior WAO runId (the lineage slot's
      // previous owner — the run whose transcript holds the provider session;
      // parentRunId when the slot had no prior entry). claude-code compiles the
      // opaque uuid only; a transcript-bound backend recovers the provider
      // session id from this handle at runner time.
      routing: {
        ...routing,
        turn: "resume",
        priorRunId: (entry && typeof entry.runId === "string" && entry.runId.length > 0)
          ? entry.runId
          : parentRunId,
      },
      // Internal rollback token. It never crosses the application/MCP boundary.
      claim: { keyHash, runId, parentRunId, previousEntry: entry ?? null },
    };
  });
}

/**
 * Release a continuation claim after a pre-spawn failure. The compare-and-
 * restore happens under the same per-lineage lock, so this cleanup can never
 * overwrite a newer continuation owner. When no prior entry existed, restore a
 * terminal parent marker (injectable stores need not implement deleteEntry).
 *
 * @param {object} input
 * @param {string} input.runDir
 * @param {{keyHash:string,runId:string,parentRunId:string,previousEntry:object|null}} input.claim
 * @param {object} [input.reuseStore]
 * @returns {Promise<boolean>} true when this claim was still current and released
 */
export async function releaseLineageContinuationTurn({ runDir, claim, reuseStore }) {
  if (!claim || typeof claim !== "object"
    || typeof claim.keyHash !== "string"
    || typeof claim.runId !== "string"
    || typeof claim.parentRunId !== "string") {
    throw new Error("sessionReuse: invalid continuation claim token");
  }
  const store = reuseStore ?? defaultLineageStore(runDir);
  return withKeyLock(store, claim.keyHash, async () => {
    const current = await store.readEntry(claim.keyHash);
    if (!current || current.runId !== claim.runId) return false;
    if (claim.previousEntry && typeof claim.previousEntry.runId === "string") {
      await store.writeEntry(claim.keyHash, claim.previousEntry);
    } else if (typeof store.deleteEntry === "function") {
      await store.deleteEntry(claim.keyHash);
    } else {
      await store.writeEntry(claim.keyHash, { runId: claim.parentRunId, updatedAt: 0 });
    }
    return true;
  });
}
