// src/application/ownerLiveness.js
//
// M10-pre3: Owner heartbeat liveness SSOT.
//
// Extracted from daemon.js to share between daemon, runWait, and future
// supervision code. The owner file (.owner-<runId>) is written by
// backgroundRunner every 2 seconds while the runner process is alive,
// and deleted on exit.
//
// This module owns the ONLY freshness algorithm — no third copy.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Uses only node:fs and node:path (synchronous read for liveness check).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Default owner heartbeat staleness threshold (10 seconds).
 * backgroundRunner updates every 2 seconds, so 10s = 5 missed heartbeats.
 */
export const DEFAULT_OWNER_LIVENESS_THRESHOLD_MS = 10000;

/**
 * Get the owner heartbeat file path for a run.
 * @param {string} runDir
 * @param {string} runId
 * @returns {string}
 */
export function ownerFilePath(runDir, runId) {
  return join(runDir, `.owner-${runId}`);
}

/**
 * Check owner heartbeat freshness.
 *
 * @param {string} runDir
 * @param {string} runId
 * @param {number} now — current timestamp (ms)
 * @param {number} [thresholdMs] — staleness threshold (default 10000)
 * @returns {{fresh: boolean, heartbeatAt: number|null}}
 *   fresh=true if owner file exists and heartbeat is within threshold.
 *   fresh=false if file missing, corrupt, or heartbeat stale.
 */
export function checkOwnerLiveness(runDir, runId, now, thresholdMs = DEFAULT_OWNER_LIVENESS_THRESHOLD_MS) {
  const filePath = ownerFilePath(runDir, runId);
  if (!existsSync(filePath)) return { fresh: false, heartbeatAt: null };
  try {
    const owner = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof owner.heartbeatAt !== "number") return { fresh: false, heartbeatAt: null };
    const fresh = (now - owner.heartbeatAt) <= thresholdMs;
    return { fresh, heartbeatAt: owner.heartbeatAt };
  } catch {
    return { fresh: false, heartbeatAt: null };
  }
}
