// src/application/runDrilldowns.js
//
// M12-8B: bounded Lead progressive-disclosure metadata.
//
// This is the SINGLE shared application module that tells the Lead which safe
// read-only MCP tool can reveal more about an already-returned result — WITHOUT
// auto-calling it, without any semantic inference, prescription, file choice,
// or cursor traversal, and without ever advertising a destructive or mutating
// tool. It exists to cut the Lead's token/attention cost while preserving Lead
// authority: the drilldown list is static, bounded, and deterministic; the Lead
// (or the host UI) decides whether to follow up.
//
// Contract:
//   - Every returned entry has the EXACT seven-key shape
//     { tool, view, detail, purpose, reveals, cost, readOnly }.
//   - Every field is a small closed/static string chosen by WAO code — never
//     transcript, provider, or repository text.
//   - At most DRILLDOWN_MAX_ENTRIES per result; the single hard serialized-size
//     cap (DRILLDOWN_SERIALIZED_MAX_BYTES, measured in UTF-8 bytes via the Node
//     built-in Buffer.byteLength) is enforced HERE, in the application helper —
//     the MCP schema exposes the same caps for parity, and the helper is the
//     enforcement point that throws on any violation.
//   - Selection is a pure function of already-available machine facts
//     (state / terminal / failure category / readiness / cursors / result
//     status) — no extra transcript reads, no semantic judgment.
//   - readOnly is the truthful boolean per advertised tool: true iff the tool
//     never mutates run/worker/delivery/session state AND appends nothing to
//     the transcript. run_collect appends one messages.collected audit per
//     successful call (its MCP annotations are readOnlyHint:false /
//     idempotentHint:false), so its three entries report readOnly:false; the
//     other five observation tools append nothing and report readOnly:true.
//     No entry ever advertises a destructive/control tool.
//   - Fail closed: an unknown source tool throws; unknown fact values degrade
//     deterministically to the same safe fallback list.
//
// The advertised tool set is the closed observation set (never control or
// destructive tools): run_status, run_activity, run_collect, run_delivery,
// run_delivery_review, run_diagnose.
//
// Import discipline: this module imports NOTHING (pure constants + functions).
// It must not import src/commands/*, src/mcp/*, the MCP SDK, or zod.

// ===== Shared caps (exported for MCP schema parity) =====

export const DRILLDOWN_MAX_ENTRIES = 4;
export const DRILLDOWN_SERIALIZED_MAX_BYTES = 2048;
export const DRILLDOWN_FIELD_MAX_LEN = 160;

// ===== Closed sets (exported for MCP schema parity) =====

export const DRILLDOWN_VIEWS = Object.freeze(["compact", "timeline", "evidence", "delivery", "diagnosis"]);
export const DRILLDOWN_COSTS = Object.freeze(["low", "medium", "high"]);
export const DRILLDOWN_TOOLS = Object.freeze([
  "run_status",
  "run_activity",
  "run_collect",
  "run_delivery",
  "run_delivery_review",
  "run_diagnose",
]);

const VIEWS = new Set(DRILLDOWN_VIEWS);
const COSTS = new Set(DRILLDOWN_COSTS);
const TOOLS = new Set(DRILLDOWN_TOOLS);

// ===== Static catalog (the only source of drilldown text) =====

const CATALOG = Object.freeze({
  status: Object.freeze({
    tool: "run_status",
    view: "timeline",
    detail: "point-in-time run status",
    purpose: "check the current state and last worker activity without waiting",
    reveals: "current state, terminal flag, last event type, and last activity kind with age",
    cost: "low",
    readOnly: true,
  }),
  activity: Object.freeze({
    tool: "run_activity",
    view: "timeline",
    detail: "activity timeline page",
    purpose: "browse the run's activity timeline",
    reveals: "one page of activity events with categories, counts, and text excerpts",
    cost: "medium",
    readOnly: true,
  }),
  activityContinue: Object.freeze({
    tool: "run_activity",
    view: "timeline",
    detail: "continue activity pages",
    purpose: "read the next page of the activity timeline",
    reveals: "the next page of activity entries after this cursor",
    cost: "medium",
    readOnly: true,
  }),
  collectCompact: Object.freeze({
    tool: "run_collect",
    view: "compact",
    detail: "last assistant text (compact)",
    purpose: "read the final assistant text without the full output",
    reveals: "the last assistant text verbatim (up to 4000 chars) and full evidence counts",
    cost: "low",
    // run_collect appends one messages.collected audit per successful call →
    // its entries are not read-only (readOnlyHint:false / idempotentHint:false).
    readOnly: false,
  }),
  collectFull: Object.freeze({
    tool: "run_collect",
    view: "evidence",
    detail: "bounded worker output page",
    purpose: "read one bounded page of collected worker output",
    reveals: "one bounded page of assistant output with evidence counts and continuation state",
    cost: "medium",
    readOnly: false,
  }),
  collectContinue: Object.freeze({
    tool: "run_collect",
    view: "evidence",
    detail: "continue output pages",
    purpose: "read the next page of collected output",
    reveals: "the next page of collected output after this cursor",
    cost: "medium",
    readOnly: false,
  }),
  delivery: Object.freeze({
    tool: "run_delivery",
    view: "delivery",
    detail: "delivery facts",
    purpose: "check the delivery state and verification outcome",
    reveals: "terminal state, delivery and base commit hashes, changed paths, verification and acceptance status",
    cost: "low",
    readOnly: true,
  }),
  deliveryReview: Object.freeze({
    tool: "run_delivery_review",
    view: "delivery",
    detail: "delivery diff review",
    purpose: "inspect the delivery diff and review details before deciding",
    // One selected bounded fragment + proof-backed metadata; the tool does not
    // itself return the verification result (that is run_delivery's fact).
    reveals: "one selected bounded diff fragment plus proof-backed file metadata and pagination",
    cost: "high",
    readOnly: true,
  }),
  diagnose: Object.freeze({
    tool: "run_diagnose",
    view: "diagnosis",
    detail: "failure diagnosis",
    purpose: "identify the failure category and signal event types",
    reveals: "failure category, signal event types, and signal counts",
    cost: "low",
    readOnly: true,
  }),
});

// ===== Selection rules (pure, facts-driven, deterministic) =====
//
// Each rule returns catalog KEYS in a fixed order. Facts come only from the
// handler's already-projected payload — never from transcript text, provider
// text, or repository content. Unknown/missing fact values fall through to the
// same deterministic safe list; selection never throws on fact values.

function selectForRunStatus(f) {
  if (f.state === "failed" || f.state === "aborted" || f.state === "timed_out") {
    return ["diagnose", "activity"];
  }
  if (f.state === "completed") {
    return ["activity", "collectCompact"];
  }
  // Any other terminal state (stopped, unknown-terminal) or non-terminal →
  // activity stays the safe observation choice.
  return ["activity"];
}

function selectForRunAwaitResult(f) {
  if (f.observationOutcome === "read_failure") {
    return ["status", "activity"];
  }
  if (f.terminal !== true) {
    return ["status", "activity"];
  }
  if (f.resultStatus === "available") {
    return ["activity", "collectFull"];
  }
  if (f.resultStatus === "too_large") {
    return ["collectFull", "activity"];
  }
  if (f.resultStatus === "empty") {
    return ["activity"];
  }
  return ["status", "activity"];
}

function selectForRunDiagnose(f) {
  if (f.category === "delivery_packaging_failed") {
    return ["delivery", "activity"];
  }
  return ["activity", "collectCompact"];
}

function selectForRunCollect(f) {
  if (f.view === "compact") {
    if (f.compactStatus === "available") {
      return ["collectFull", "activity"];
    }
    if (f.compactStatus === "too_large") {
      return ["collectFull"];
    }
    return ["activity"];
  }
  // Full view (default).
  if (f.nextCursor != null) {
    return ["collectContinue", "activity"];
  }
  return ["activity"];
}

function selectForRunDelivery(f) {
  if (f.readiness === "reviewable") {
    return ["deliveryReview", "activity"];
  }
  if (f.readiness === "packaging_failed") {
    return ["activity", "diagnose"];
  }
  if (f.readiness != null) {
    // Any other settled/waiting readiness → point-in-time status + activity.
    return ["activity", "status"];
  }
  if (f.deliveryAvailable === true) {
    if (f.acceptanceStatus === "accepted" || f.acceptanceStatus === "rejected") {
      return ["activity"];
    }
    return ["deliveryReview", "activity"];
  }
  if (f.deliveryFailureCode != null) {
    return ["activity", "diagnose"];
  }
  return ["activity", "status"];
}

function selectForRunActivity(f) {
  if (f.nextCursor != null) {
    return ["activityContinue"];
  }
  if (f.terminal === true) {
    return ["collectCompact"];
  }
  return ["status"];
}

const SOURCE_SELECTORS = Object.freeze({
  run_status: selectForRunStatus,
  run_await_result: selectForRunAwaitResult,
  run_diagnose: selectForRunDiagnose,
  run_collect: selectForRunCollect,
  run_delivery: selectForRunDelivery,
  run_activity: selectForRunActivity,
});

// ===== Public API =====

/**
 * Select the bounded drilldown metadata for one source tool from its
 * already-available machine facts.
 *
 * @param {string} toolName — one of the six source tools
 * @param {object} [facts] — flat machine facts (see the per-tool selectors)
 * @returns {Array<object>} 1..DRILLDOWN_MAX_ENTRIES validated seven-key entries
 * @throws {Error} /unknown tool/ for any non-source tool name
 */
export function selectDrilldowns(toolName, facts) {
  const selector = SOURCE_SELECTORS[toolName];
  if (!selector) {
    throw new Error(`unknown tool: ${toolName}`);
  }
  const f = facts ?? {};
  const keys = selector(f);
  const entries = [];
  const seen = new Set();
  for (const key of keys) {
    const entry = CATALOG[key];
    if (!entry) continue; // defensive: a catalog key must always exist
    const id = `${entry.tool}|${entry.view}|${entry.detail}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ ...entry });
  }
  enforceDrilldownBounds(entries);
  return entries;
}

/**
 * Validate one drilldown entry against the EXACT contract: seven keys,
 * closed sets, boolean readOnly that is TRUTHFUL per advertised tool
 * (run_collect => false, every other allowed tool => true), bounded
 * non-empty strings. Returns true on success; throws on any violation (fail
 * closed).
 *
 * @param {object} entry
 * @returns {true}
 */
export function validateDrilldownEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("drilldown entry must be an object");
  }
  const keys = Object.keys(entry).sort();
  const expected = ["cost", "detail", "purpose", "readOnly", "reveals", "tool", "view"];
  if (keys.length !== 7 || keys.some((k, i) => k !== expected[i])) {
    throw new Error(`drilldown entry must have exactly the seven keys, got: ${keys.join(",")}`);
  }
  if (!TOOLS.has(entry.tool)) throw new Error(`drilldown tool outside closed set: ${entry.tool}`);
  if (!VIEWS.has(entry.view)) throw new Error(`drilldown view outside closed set: ${entry.view}`);
  if (!COSTS.has(entry.cost)) throw new Error(`drilldown cost outside closed set: ${entry.cost}`);
  if (typeof entry.readOnly !== "boolean") throw new Error("drilldown readOnly must be a boolean");
  // Truthful per-tool invariant: run_collect appends one messages.collected
  // audit per call → readOnly:false; every other advertised observation tool
  // appends nothing → readOnly:true. The untruthful pairs fail closed.
  const expectedReadOnly = entry.tool === "run_collect" ? false : true;
  if (entry.readOnly !== expectedReadOnly) {
    throw new Error(`drilldown readOnly must be ${expectedReadOnly} for tool ${entry.tool}`);
  }
  for (const k of ["detail", "purpose", "reveals"]) {
    if (typeof entry[k] !== "string" || entry[k].length === 0 || entry[k].length > DRILLDOWN_FIELD_MAX_LEN) {
      throw new Error(`drilldown ${k} must be a non-empty string <= ${DRILLDOWN_FIELD_MAX_LEN} chars`);
    }
  }
  return true;
}

/**
 * Enforce the hard bounds: at most DRILLDOWN_MAX_ENTRIES entries, EVERY entry
 * individually validated (shape / closed sets / truthful readOnly), and one
 * serialized-size cap (DRILLDOWN_SERIALIZED_MAX_BYTES) measured in UTF-8
 * BYTES. This is the single enforcement point; it throws on any violation.
 *
 * @param {Array<object>} entries
 * @returns {Array<object>} the same array
 */
export function enforceDrilldownBounds(entries) {
  if (!Array.isArray(entries)) throw new Error("drilldowns must be an array");
  if (entries.length > DRILLDOWN_MAX_ENTRIES) {
    throw new Error(`drilldown entries exceed cap: ${entries.length} > ${DRILLDOWN_MAX_ENTRIES}`);
  }
  // Validate EVERY entry before accepting the array (fail closed on any
  // violation — an invalid entry never slips through because the count or
  // byte cap happens to be in bounds).
  for (const entry of entries) validateDrilldownEntry(entry);
  // UTF-8 byte length (Node built-in), not JS string length: a non-ASCII
  // entry can exceed the cap while its code-unit length stays under it.
  const bytes = Buffer.byteLength(JSON.stringify(entries), "utf8");
  if (bytes > DRILLDOWN_SERIALIZED_MAX_BYTES) {
    throw new Error(`drilldown serialized size exceeds cap: ${bytes} > ${DRILLDOWN_SERIALIZED_MAX_BYTES} bytes`);
  }
  return entries;
}
