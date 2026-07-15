// src/application/timeoutPolicy.js
//
// M10-pre: Unified wait timeout precedence SSOT.
//
// Precedence: explicit request > agent.waitTimeout > global config.waitTimeout > DEFAULT.
// This is the single authority for resolving effective wait timeout across
// dispatchRun, backgroundRunner, and RunManager.
//
// Validation discipline (M10-pre closeout):
//   - validateExplicitTimeout enforces production range [1000, 600000] and is called
//     at the EXTERNAL BOUNDARY: dispatchRun (before transcript/fork) and the CLI
//     foreground path (before waitForCompletion). It is never called inside
//     resolveWaitTimeout — the resolver is a pure precedence function.
//   - The AGENT value is validated at registry load time (normalizeAgent: 1000..600000).
//   - The GLOBAL config value comes from config/default.json — trusted internal config.
//   - The DEFAULT is a constant (300000).
//   - Tests that exercise RunManager.waitForCompletion with small timeouts test the
//     timer/abort mechanics, not the boundary contract. They bypass the CLI parser
//     and therefore bypass validateExplicitTimeout — no production contract is weakened.
//     ("不得为了测试方便放宽生产契约；测试通过依赖注入/fake timer解决")

const DEFAULT_WAIT_TIMEOUT = 300000;
const MIN_WAIT_TIMEOUT = 1000;
const MAX_WAIT_TIMEOUT = 600000;

/**
 * Resolve the effective wait timeout and its source.
 *
 * Pure precedence function — does NOT range-validate. Range validation for
 * externally-controlled values happens at the boundary via validateExplicitTimeout.
 *
 * @param {object} input
 * @param {number|undefined} input.explicit — explicit CLI/MCP override (boundary-validated by caller)
 * @param {number|undefined} input.agentWaitTimeout — from registry agent.waitTimeout (validated at load)
 * @param {number|undefined} input.globalWaitTimeout — from config/default.json (trusted)
 * @returns {{ms: number, source: "explicit"|"agent"|"global"|"default"}}
 */
export function resolveWaitTimeout({ explicit, agentWaitTimeout, globalWaitTimeout } = {}) {
  if (explicit !== undefined && explicit !== null) {
    return { ms: validatePositiveInteger(explicit), source: "explicit" };
  }
  if (agentWaitTimeout !== undefined && agentWaitTimeout !== null) {
    return { ms: validatePositiveInteger(agentWaitTimeout), source: "agent" };
  }
  if (globalWaitTimeout !== undefined && globalWaitTimeout !== null) {
    return { ms: validatePositiveInteger(globalWaitTimeout), source: "global" };
  }
  return { ms: DEFAULT_WAIT_TIMEOUT, source: "default" };
}

/**
 * Validate an externally-provided explicit timeout. This is the production range
 * gate: must be a finite integer in [1000, 600000]. Called for CLI --wait-timeout
 * and MCP tool inputs before any transcript write or process fork.
 *
 * This is a BOUNDARY check, not a resolver check. resolveWaitTimeout stays pure.
 *
 * @param {unknown} v
 * @returns {number}
 */
export function validateExplicitTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_WAIT_TIMEOUT || n > MAX_WAIT_TIMEOUT) {
    throw new Error(
      `Invalid waitTimeout: must be an integer in [${MIN_WAIT_TIMEOUT}, ${MAX_WAIT_TIMEOUT}], got: ${JSON.stringify(v)}`,
    );
  }
  return n;
}

/**
 * Type-check only: must be a finite positive integer. Does NOT enforce range.
 * Used internally by resolveWaitTimeout for all tiers (explicit/agent/global).
 * Range enforcement for the explicit tier is at the boundary (validateExplicitTimeout).
 * @param {unknown} v
 * @returns {number}
 */
function validatePositiveInteger(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `Invalid waitTimeout: must be a positive finite integer, got: ${JSON.stringify(v)}`,
    );
  }
  return n;
}

export { DEFAULT_WAIT_TIMEOUT, MIN_WAIT_TIMEOUT, MAX_WAIT_TIMEOUT };
