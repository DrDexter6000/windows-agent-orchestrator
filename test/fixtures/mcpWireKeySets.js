// test/fixtures/mcpWireKeySets.js
//
// TD-168: the MCP wire-shape boundary tests' shared expected key sets.
//
// These are SECURITY-BOUNDARY contracts, not just shape snapshots: each set pins
// the exact top-level keys a tool may put on the wire (safe-field projection —
// a missing OR an extra key must fail the test). They used to be hand-copied in
// every test file; this fixture is the single source of truth. Values were
// extracted verbatim from the tests' existing hand-copied literals — no
// "drive-by" corrections. Key ORDER carries no semantics: the consumers
// deepEqual a sorted Object.keys(...) or a new Set(...) against these arrays.
//
// Not a *.test.js file — no test/manifest.json registration (fixtures hold
// data, not suites; see canonical-test.mjs discovery).

// run_status output: 8 top-level keys (M9-3B-03 / TD150B-M3 / MD-02).
// M11-8B added agentId; M12-8B added availableDrilldowns; M12-17 added
// executionStage.
export const RUN_STATUS_OUTPUT_KEYS = Object.freeze([
  "agentId", "availableDrilldowns", "executionStage", "lastActivity", "lastEvent",
  "runId", "state", "terminal",
]);

// run_dispatch input schema properties: 12 keys (M9-2B-01 / R10-A-MCP-1 /
// R11-1-MCP-1 / B1). agentId + prompt required; the rest optional additive
// members (delivery, M12-6 expectations, M12-9 executionProfileId, M12-7
// continuable, M12-16 correctable, Round-4 readOnly, R10-A model, R11-1
// reasoning). run_dispatch_contract_check SHARES this schema (M12-9 SSOT).
export const RUN_DISPATCH_INPUT_KEYS = Object.freeze([
  "agentId", "continuable", "correctable", "delivery", "executionProfileId", "expectedDirty",
  "expectedGitHead", "expectedWorkspaceRoot", "model", "prompt", "readOnly", "reasoning",
]);

// run_delivery (point-in-time) output: 23 top-level keys (M11-1A-01 /
// M11-10-MCP-02). Consumers compare as a Set. M11-8C added
// deliveryAvailable/deliveryFailure; M11-12B verificationFailureSummary;
// M12-1S1/M12-4A candidateInventory + candidateKind; M12-6 3B2a the reverify
// chain trio; M12-8B availableDrilldowns; M12-12 semanticNotes; M12-13
// isolationFailure.
export const RUN_DELIVERY_OUTPUT_KEYS = Object.freeze([
  "runId", "deliveryAvailable", "deliveryRequested", "terminalState", "baseCommit", "deliveryCommit",
  "changedFileCount", "changedPaths", "changedPathsTruncated",
  "verificationStatus", "originalVerificationStatus", "effectiveVerificationStatus", "reverify",
  "verificationFailureCode", "verificationFailureSummary",
  "acceptanceStatus", "decisionType", "deliveryFailure", "candidateInventory", "candidateKind",
  "availableDrilldowns", "semanticNotes", "isolationFailure",
]);
