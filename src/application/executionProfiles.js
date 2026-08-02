// src/application/executionProfiles.js
//
// M12-9 Package B: the WAO application-owned, tracked, FROZEN trusted catalog
// of mechanical execution profiles + the shared delivery-verification resolver.
//
// A "profile" is a Lead-selected, named, IMMUTABLE bundle of verification
// commands (setup + assertion) that a delivery dispatch may reference by id
// instead of typing the inline verification block. Profiles exist ONLY here, in
// the WAO control plane — they NEVER read the target project's config and they
// NEVER enter the agent registry.
//
// Hard contract (B2):
//   - A profile supplies ONLY { verificationSetupCommands, verificationCommands }.
//     It must NEVER select a worker, change the prompt, infer/expand allowedPaths,
//     set continuable, set expected workspace/head/dirty, or relax any contract.
//   - The catalog is frozen (Object.freeze). Adding a profile is a tracked
//     source change to this one module — there is no runtime registration.
//
// Shared resolver (B3): resolveDeliveryVerification is the SINGLE authority used
// by BOTH run_dispatch and run_dispatch_contract_check. It enforces:
//   - profile vs inline verification (verificationSetupCommands /
//     verificationCommands / verificationUnavailableReason) are MUTUALLY
//     EXCLUSIVE — never two authorities;
//   - a profile is legal ONLY for a delivery dispatch (delivery present);
//   - unknown id / conflict / non-delivery are STABLY rejected as { ok:false, code }.
// The resolver never throws; it returns a stable result shape. It never echoes
// command text in its codes (counts only).
//
// Architectural contract:
//   - Pure module: imports NOTHING. No src/commands/*, src/mcp/*, MCP SDK, zod,
//     transcript, registry, or filesystem reads.
//   - Deterministic: same inputs → same outputs (no Date/random).

// ===== Frozen trusted catalog (the only source of profile definitions) =====
//
// Each profile: { id, summary, verificationSetupCommands, verificationCommands }.
// summary is a short FIXED human label (<=160 chars) — never dynamic, never a
// command. It is the only text surfaced in the bounded precheck output.

export const EXECUTION_PROFILES = Object.freeze({
  // summary is a short FIXED human label that NEVER echoes the command text
  // (the bounded precheck output exposes id + counts + summary only).
  "node-npm-test-v1": Object.freeze({
    id: "node-npm-test-v1",
    summary: "Node project — default test runner",
    verificationSetupCommands: Object.freeze([]),
    verificationCommands: Object.freeze(["npm test"]),
  }),
  "node-npm-ci-test-v1": Object.freeze({
    id: "node-npm-ci-test-v1",
    summary: "Node project — clean install then default test runner",
    verificationSetupCommands: Object.freeze(["npm ci"]),
    verificationCommands: Object.freeze(["npm test"]),
  }),
  "python-pytest-v1": Object.freeze({
    id: "python-pytest-v1",
    summary: "Python project — default test runner via module entrypoint",
    verificationSetupCommands: Object.freeze([]),
    verificationCommands: Object.freeze(["python -m pytest"]),
  }),
});

// The frozen closed set of profile ids. Consumers (resolver, MCP schema parity,
// tests) must treat this as exhaustive; any other id is unknown.
export const EXECUTION_PROFILE_IDS = Object.freeze(Object.keys(EXECUTION_PROFILES));

// The closed set of resolver rejection codes. The MCP precheck output schema is
// built from this single set so the service and the schema cannot drift.
export const EXECUTION_PROFILE_REJECTION_CODES = Object.freeze([
  "profile_unknown", // the id is not in the frozen catalog
  "profile_requires_delivery", // a profile was selected without a delivery block
  "profile_inline_conflict", // a profile AND inline verification were both supplied
]);

const REJECTION_CODES = new Set(EXECUTION_PROFILE_REJECTION_CODES);

/**
 * Look up a profile by id. Returns the profile object (frozen) or undefined.
 * No inference, no fuzzy match, no fallback — an exact id match or nothing.
 *
 * @param {string} id
 * @returns {object|undefined}
 */
export function getExecutionProfile(id) {
  if (typeof id !== "string") return undefined;
  return EXECUTION_PROFILES[id];
}

/**
 * The bounded catalog summary for the advisory precheck output. Exposes ONLY
 * { id, setupCommandCount, assertionCommandCount, summary } per profile — NEVER
 * the command text. Stable order (catalog order).
 *
 * @returns {Array<{id:string, setupCommandCount:number, assertionCommandCount:number, summary:string}>}
 */
export function listExecutionProfileSummaries() {
  return EXECUTION_PROFILE_IDS.map((id) => {
    const p = EXECUTION_PROFILES[id];
    return {
      id,
      setupCommandCount: p.verificationSetupCommands.length,
      assertionCommandCount: p.verificationCommands.length,
      summary: p.summary,
    };
  });
}

// True iff the delivery block carries ANY inline verification authority.
function deliveryHasInlineVerification(delivery) {
  if (!delivery || typeof delivery !== "object") return false;
  return !!(
    (Array.isArray(delivery.verificationCommands) && delivery.verificationCommands.length > 0)
    || (Array.isArray(delivery.verificationSetupCommands) && delivery.verificationSetupCommands.length > 0)
    || (typeof delivery.verificationUnavailableReason === "string"
      && delivery.verificationUnavailableReason.trim().length > 0)
  );
}

/**
 * Resolve the effective delivery verification from EITHER a selected profile OR
 * the inline delivery block — never both. This is the SINGLE authority shared by
 * run_dispatch and run_dispatch_contract_check.
 *
 * Outcomes:
 *   - { ok:true, source:"profile", profileId, verification } — profile supplies
 *     the verification (delivery must be present with NO inline verification).
 *   - { ok:true, source:"inline", profileId:null, verification } — no profile;
 *     the inline delivery verification is passed through (possibly empty when
 *     there is no delivery — structural validation happens downstream in
 *     prepareDeliveryRequest, the shared SSOT).
 *   - { ok:true, source:"none", profileId:null, verification:{commands:[],setupCommands:[],unavailableReason:null} }
 *     — no profile and no delivery (an ordinary non-delivery dispatch).
 *   - { ok:false, code } — code ∈ EXECUTION_PROFILE_REJECTION_CODES.
 *
 * `verification` (on success) is ALWAYS a fresh, mutable copy:
 *   { commands:string[], setupCommands:string[], unavailableReason:string|null }.
 * Mutating it never touches the frozen catalog.
 *
 * The resolver never throws and never echoes command text in a code.
 *
 * @param {object} input
 * @param {object} [input.delivery] — { mode, allowedPaths, verification*? }
 * @param {string} [input.executionProfileId]
 * @returns {object}
 */
export function resolveDeliveryVerification({ delivery, executionProfileId } = {}) {
  const profileRequested = executionProfileId !== undefined && executionProfileId !== null;

  if (profileRequested) {
    const profile = getExecutionProfile(executionProfileId);
    // Unknown id — stable rejection. A non-string / unmatched id is unknown.
    if (!profile) {
      return { ok: false, code: "profile_unknown" };
    }
    // A profile is legal ONLY for a delivery dispatch.
    if (!delivery || typeof delivery !== "object") {
      return { ok: false, code: "profile_requires_delivery" };
    }
    // Mutual exclusivity: a profile AND inline verification are two authorities —
    // never both. Reject before the profile can shadow or be shadowed.
    if (deliveryHasInlineVerification(delivery)) {
      return { ok: false, code: "profile_inline_conflict" };
    }
    return {
      ok: true,
      source: "profile",
      profileId: profile.id,
      // Fresh copies — the caller may mutate; the frozen catalog is never touched.
      verification: {
        commands: [...profile.verificationCommands],
        setupCommands: [...profile.verificationSetupCommands],
        unavailableReason: null,
      },
    };
  }

  // No profile requested. Inline pass-through (structural validation is the
  // downstream SSOT's job — prepareDeliveryRequest).
  const commands = Array.isArray(delivery?.verificationCommands)
    ? [...delivery.verificationCommands]
    : [];
  const setupCommands = Array.isArray(delivery?.verificationSetupCommands)
    ? [...delivery.verificationSetupCommands]
    : [];
  const unavailableReason = typeof delivery?.verificationUnavailableReason === "string"
    && delivery.verificationUnavailableReason.trim().length > 0
    ? delivery.verificationUnavailableReason
    : null;

  if (!delivery) {
    return {
      ok: true,
      source: "none",
      profileId: null,
      verification: { commands: [], setupCommands: [], unavailableReason: null },
    };
  }
  return {
    ok: true,
    source: "inline",
    profileId: null,
    verification: { commands, setupCommands, unavailableReason },
  };
}

// Exported for tests / defensive assertions: is a string a known rejection code?
export function isExecutionProfileRejectionCode(code) {
  return REJECTION_CODES.has(code);
}
