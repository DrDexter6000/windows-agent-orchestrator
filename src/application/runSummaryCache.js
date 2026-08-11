// src/application/runSummaryCache.js
//
// M12-18: bounded in-memory run-transcript cache for the long-lived MCP query
// handlers (lead_preflight + runs_list).
//
// Design contract:
//   - runs/<runId>.jsonl remains the SOLE truth. This cache is a process-memory
//     read cache shared only by the MCP query handlers; there is no disk
//     sidecar, no schema, no new dependency, and the transcript writers never
//     change.
//   - The cache stores the SMALLEST exact static run facts listRuns needs
//     (extractRunFacts from runList.js — the derivation SSOT): raw agentId,
//     state, terminal, updatedAt, and the exact run.background_submitted /
//     run.started ownership events the workspace verifier consumes. Full
//     parsed event arrays are never retained, so a realistic ~1800-transcript
//     inventory costs a few MB, not hundreds.
//   - Key/validation: the file's pre/post stat metadata (size, mtimeMs, ino)
//     must AGREE around the read, which detects an append during the read. An
//     entry is stored ONLY when both snapshots agree; a torn read (including a
//     delete between read and post-stat) is never cached but the facts are
//     still returned, so behavior is identical to an uncached read.
//   - A throwing read (missing file, corrupt JSON) propagates to the caller —
//     listRuns skips the run exactly as it would without a cache — and is
//     NEVER cached.
//   - The cache stores per-file facts ONLY. Every query re-applies workspace
//     authorization against the current binding, knownAgentIds validation,
//     owner heartbeat, active/unresolved, activeOnly, sorting and limit, so
//     the cache can never freeze a query result.
//   - Deterministic bounded eviction: LRU via insertion-ordered Map (delete +
//     re-set on hit, evict the head when over the cap). No wall clock, no
//     randomness — the same call sequence evicts the same entries. The default
//     cap (4096) deliberately covers realistic inventories (≈1800 transcripts)
//     with headroom because per-entry facts are ~200 B: on a cap-sized LRU a
//     full sequential rescan over a larger inventory would evict every
//     retained tail entry before it is reached and re-parse everything.

import { resolve } from "node:path";
import { stat } from "node:fs/promises";

import { readTranscript } from "../transcript.js";
import { extractRunFacts } from "./runList.js";

const DEFAULT_MAX_ENTRIES = 4096;

/**
 * Snapshot key derived from one stat result. size + mtimeMs + ino together are
 * sufficient to detect an append during the read: an appended line changes the
 * size; a rewritten file changes size and/or mtimeMs and/or ino. Any non-finite
 * component means "cannot prove stability" → the file is never cached and never
 * served from cache (we must not guess).
 */
function snapshotKey(statResult) {
  const { size, mtimeMs, ino } = statResult;
  if (!Number.isFinite(size) || !Number.isFinite(mtimeMs) || !Number.isFinite(ino)) {
    return null;
  }
  return `${size}:${mtimeMs}:${ino}`;
}

/**
 * Bounded in-memory read cache for run transcripts (facts projection).
 *
 * @param {Object} [input]
 * @param {number} [input.maxEntries=4096] — LRU capacity; eviction is
 *   deterministic (insertion-ordered Map head = least recently used). The
 *   default covers realistic inventories (~1800 transcripts) with headroom
 *   because each entry holds only the ~200-byte facts projection.
 * @param {Function} [input.readTranscriptFn=readTranscript] — underlying
 *   transcript reader; injectable for tests.
 * @param {Function} [input.statFn=stat] — file metadata reader; injectable for
 *   tests (default is node:fs/promises stat).
 * @param {Function} [input.extractFactsFn=extractRunFacts] — facts derivation
 *   (runList.js SSOT); injectable for tests.
 * @returns {{
 *   read(filePath): Promise<object|null>,
 *   size: number,
 *   stats: { hits: number, misses: number, tornReads: number, evictions: number },
 *   clear(): void
 * }}
 */
export function createRunSummaryCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
  readTranscriptFn = readTranscript,
  statFn = stat,
  extractFactsFn = extractRunFacts,
} = {}) {
  const cap = Math.max(1, Math.floor(maxEntries));
  const entries = new Map(); // key (resolved path) → { meta, facts }
  const stats = { hits: 0, misses: 0, tornReads: 0, evictions: 0 };

  function evictHead() {
    if (entries.size === 0) return;
    const headKey = entries.keys().next().value;
    entries.delete(headKey);
    stats.evictions += 1;
  }

  async function read(filePath) {
    const key = resolve(filePath);

    // Pre-read metadata snapshot. A throw (missing file) propagates to the
    // caller — listRuns skips the run exactly as it would without a cache.
    const pre = await statFn(key);
    const preKey = snapshotKey(pre);
    if (preKey !== null && entries.has(key)) {
      const entry = entries.get(key);
      if (entry.meta === preKey) {
        // Valid entry: touch LRU order (delete + re-set = deterministic move
        // to most-recently-used), serve the exact facts.
        entries.delete(key);
        entries.set(key, entry);
        stats.hits += 1;
        return entry.facts;
      }
      // Metadata moved since the entry was stored — the file changed; fall
      // through and re-read (the stale entry is replaced below).
    }
    stats.misses += 1;

    // Read the raw transcript. A throw (corrupt JSON, vanished file)
    // propagates and is NEVER cached.
    const events = await readTranscriptFn(key);

    // Post-read metadata snapshot. Cache ONLY when both snapshots agree
    // (nothing appended during the read). A post-stat throw is a
    // delete/post-stat race: the facts are still usable for THIS query
    // (identical to an uncached read) but must never be cached.
    let postKey = null;
    try {
      postKey = snapshotKey(await statFn(key));
    } catch {
      postKey = null;
    }
    const facts = extractFactsFn(events);
    if (preKey !== null && postKey === preKey) {
      entries.set(key, { meta: preKey, facts });
      if (entries.size > cap) evictHead();
    } else {
      stats.tornReads += 1;
    }
    return facts;
  }

  return {
    read,
    get size() {
      return entries.size;
    },
    get stats() {
      return stats;
    },
    clear() {
      entries.clear();
      stats.hits = 0;
      stats.misses = 0;
      stats.tornReads = 0;
      stats.evictions = 0;
    },
  };
}
