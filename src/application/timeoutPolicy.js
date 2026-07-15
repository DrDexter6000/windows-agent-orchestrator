// src/application/timeoutPolicy.js
//
// M10-pre: Unified wait timeout precedence SSOT.
//
// Precedence: explicit request > agent.waitTimeout > global config.waitTimeout > DEFAULT.
// This is the single authority for resolving effective wait timeout across
// dispatchRun, backgroundRunner, and RunManager.

const DEFAULT_WAIT_TIMEOUT = 300000;
const MIN_WAIT_TIMEOUT = 1000;
const MAX_WAIT_TIMEOUT = 600000;

/**
 * Resolve the effective wait timeout and its source.
 *
 * @param {object} input
 * @param {number|undefined} input.explicit — explicit CLI/MCP override
 * @param {number|undefined} input.agentWaitTimeout — from registry agent.waitTimeout
 * @param {number|undefined} input.globalWaitTimeout — from config/default.json
 * @returns {{ms: number, source: "explicit"|"agent"|"global"|"default"}}
 */
export function resolveWaitTimeout({ explicit, agentWaitTimeout, globalWaitTimeout } = {}) {
  if (explicit !== undefined && explicit !== null) {
    return { ms: validateTimeout(explicit), source: "explicit" };
  }
  if (agentWaitTimeout !== undefined && agentWaitTimeout !== null) {
    return { ms: validateTimeout(agentWaitTimeout), source: "agent" };
  }
  if (globalWaitTimeout !== undefined && globalWaitTimeout !== null) {
    return { ms: validateTimeout(globalWaitTimeout), source: "global" };
  }
  return { ms: DEFAULT_WAIT_TIMEOUT, source: "default" };
}

/**
 * Validate a timeout value at resolution time: must be a finite positive integer.
 * Production range enforcement (1000..600000) is done at registry validate,
 * not here — this allows test fixtures to use small values for fast timeouts.
 * @param {unknown} v
 * @returns {number}
 */
function validateTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `Invalid waitTimeout: must be a positive finite integer, got: ${JSON.stringify(v)}`,
    );
  }
  return n;
}

export { DEFAULT_WAIT_TIMEOUT, MIN_WAIT_TIMEOUT, MAX_WAIT_TIMEOUT };
