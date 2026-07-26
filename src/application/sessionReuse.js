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
// branching lives here. It is consumed by:
//   - registry.js            (closed-set validation of `sessionReuse` policy)
//   - runDispatch.js         (resolve a reuse turn, thread routing to argv,
//                             busy-check before transcript/fork)
//   - backgroundRunner.js    (parse the threaded routing)
//   - runManager.js          (capability gate + pass routing to backend.spawn)
//   - claudeCode.js          (translate routing to --session-id / --resume)
//
// Architectural contract:
//   - Does not import src/commands/*, src/mcp/*, the MCP SDK, or zod.
//   - Depends on node:crypto, node:fs/promises, node:path, ../transcript.js
//     (readTranscript/findState/findLatest — the transcript SSOT), and
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
//     audit event stores only {mode, turn}.

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { TERMINAL_STATES, readTranscript, findState, findLatest } from "../transcript.js";
import { isValidCanonicalAgentId } from "../canonicalAgentId.js";

/**
 * Closed set of supported reuse modes. Today: a single policy that reuses the
 * provider-native conversation scoped to (Lead session, bound workspace, agent).
 * Adding a mode is a deliberate contract change — values outside this set are
 * rejected by the registry normalizer.
 */
export const SESSION_REUSE_MODES = Object.freeze(["lead_workspace"]);
export const SESSION_REUSE_TURNS = Object.freeze(["first", "resume"]);

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
 * @param {unknown} value
 * @returns {{mode:"lead_workspace", turn:"first"|"resume", opaqueUuid:string}}
 */
export function validateSessionReuseRouting(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const valid = keys.length === 3
    && keys[0] === "mode"
    && keys[1] === "opaqueUuid"
    && keys[2] === "turn"
    && value.mode === "lead_workspace"
    && SESSION_REUSE_TURNS.includes(value.turn)
    && typeof value.opaqueUuid === "string"
    && OPAQUE_SESSION_UUID.test(value.opaqueUuid);
  if (!valid) {
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
      try {
        const raw = await readFile(join(dir, `${keyHash}.json`), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.runId === "string") return parsed;
        return null;
      } catch {
        return null;
      }
    },
    async writeEntry(keyHash, entry) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${keyHash}.json`), JSON.stringify(entry), "utf8");
    },
  };
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
 *   - prior run non-terminal (in-flight)                        ⇒ busy
 *   - prior run terminal + has session.created                  ⇒ resume
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
 * @returns {Promise<{kind:"first"|"resume", routing:{mode, opaqueUuid, turn}} | {kind:"busy", activeRunId:string}>}
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
        const state = findState(events);
        if (state && !TERMINAL_STATES.includes(state)) {
          // Contract 6: never concurrently drive the same provider session.
          return { kind: "busy", activeRunId: entry.runId };
        }
        // Terminal. Resumable only after a valid session.created (contract 6).
        if (findLatest(events, "session.created")) {
          await store.writeEntry(keyHash, { runId, updatedAt: clock });
          return { kind: "resume", routing: { ...routing, turn: "resume" } };
        }
        // Terminal without session.created — crashed before the backend
        // conversation started. No provider session exists to resume → fall
        // through to claim the slot as a fresh first turn.
      } else {
        // Transcript missing. Recent entry → assume in-flight (busy); stale →
        // assume crashed (first), reusing the slot.
        const age = clock - (Number(entry.updatedAt) || 0);
        if (Number.isFinite(age) && age >= 0 && age < STALE_MS) {
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
