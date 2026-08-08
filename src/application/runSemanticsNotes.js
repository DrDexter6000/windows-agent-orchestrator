// src/application/runSemanticsNotes.js
//
// M12-12: Self-Describing Results — the SINGLE pure, provider-neutral
// application SSOT for the bounded `semanticNotes` carried by EXACTLY four
// standalone MCP success results: run_wait, run_await_result, run_delivery,
// run_diagnose.
//
// Every successful result from those four tools carries 1..4 plain-English notes
// that self-explain the CURRENT facts: each note is { id, meaning, doesNotMean }
// where `id` is a frozen namespaced closed-set value, `meaning` is one
// deterministic factual sentence, and `doesNotMean` is 0..2 deterministic factual
// non-implications. There is NO `scope` field and NO per-entry `semanticsRef`;
// the detail URI for any note is mechanical: wao://semantics/{id}.
//
// Contract:
//   - Every returned entry has the EXACT three-key shape
//     { id, meaning, doesNotMean }.
//   - Every field is a small static string chosen by WAO code — NEVER
//     transcript, provider, path, prompt, command, or session text. No runtime
//     or backend-name branching; no dynamic model text. A note is byte-equal to
//     its frozen catalog entry.
//   - `doesNotMean` is an array of 0..2 non-empty strings (each a factual
//     NON-implication). No note ever recommends accept / reject / repackage /
//     stop / retry / dispatch — meanings state facts only.
//   - At most SEMANTIC_NOTE_MAX_ENTRIES per result; the single hard
//     serialized-size cap (SEMANTIC_NOTE_SERIALIZED_MAX_BYTES, measured in
//     UTF-8 bytes via the Node built-in Buffer.byteLength) is enforced HERE, in
//     the application helper — the MCP schema exposes the same caps for parity,
//     and the helper is the enforcement point that throws on any violation.
//   - Selection is a pure function of already-available machine facts (the
//     M12-11 observation outcome / termination source, the diagnosis category,
//     the delivery readiness / verification status). Selector priority is
//     deterministic. No extra reads, no semantic judgment.
//   - Minimum semantics: observation.window_expired means the window ended and
//     WAO did NOT stop/retry/mutate the run and does NOT prove the worker
//     stopped/failed; observation.read_failure means the current observation is
//     unavailable and NO termination note may be emitted on it;
//     observation.point_in_time and observation.terminal are distinct;
//     termination notes distinguish completion / execution_deadline / manual /
//     provider / backend / control_plane / unknown (execution_deadline reflects
//     ONLY the already-projected durable deadline fact); delivery notes explain
//     the current readiness/verification/candidate facts and explicitly state
//     verification passed is NOT Lead acceptance; diagnosis notes explain each
//     current closed-set category as facts, never prescriptions.
//   - Fail closed: an unknown source tool throws; unknown/future fact values
//     degrade deterministically to an explicit safe closed-set fallback note
//     (termination.unknown / diagnosis.unknown), never a dynamic echo.
//
// Import discipline: this module imports NOTHING (pure constants + functions).
// It must not import src/commands/*, src/mcp/*, the MCP SDK, or zod.

// ===== Shared caps (exported for MCP schema parity) =====

export const SEMANTIC_NOTE_MAX_ENTRIES = 4;
export const SEMANTIC_NOTE_SERIALIZED_MAX_BYTES = 2048;
export const SEMANTIC_NOTE_FIELD_MAX_LEN = 180;
export const SEMANTIC_NOTE_MAX_DOES_NOT_MEAN = 2;

export const SEMANTIC_DETAIL_URI_PREFIX = "wao://semantics/";

// ===== Closed set: the four source tools that carry semanticNotes =====

export const SEMANTIC_SOURCE_TOOLS = Object.freeze([
  "run_wait",
  "run_await_result",
  "run_delivery",
  "run_diagnose",
]);

// ===== Static catalog (the only source of note text) =====
//
// The catalog is an object keyed by the frozen namespaced id; every entry stores
// its own id (identical to the key by construction) so { ...entry } yields a
// valid three-key note. SEMANTIC_NOTE_IDS is derived from the catalog keys in
// insertion order — there is no second list. Order groups the four namespaces
// (observation / termination / delivery / diagnosis) for a stable summary.

const CATALOG = Object.freeze({
  // --- observation (mirrors OBSERVATION_OUTCOMES) ---
  "observation.point_in_time": Object.freeze({
    id: "observation.point_in_time",
    meaning: "This is a single point-in-time snapshot of the run; no wait window elapsed.",
    doesNotMean: [
      "It does not mean the worker finished or stopped.",
      "It does not prove the worker is still active right now.",
    ],
  }),
  "observation.window_expired": Object.freeze({
    id: "observation.window_expired",
    meaning: "The requested observation wait window elapsed without a terminal state being observed.",
    doesNotMean: [
      "It does not mean WAO stopped, retried, or mutated the run.",
      "It does not prove the worker stopped, failed, or is idle.",
    ],
  }),
  "observation.terminal": Object.freeze({
    id: "observation.terminal",
    meaning: "A terminal state was cleanly observed within the window.",
    doesNotMean: [
      "It does not by itself identify who or what caused the terminal outcome; see the termination note.",
    ],
  }),
  "observation.read_failure": Object.freeze({
    id: "observation.read_failure",
    meaning: "The current snapshot could not be read or trusted, so no current observation is available.",
    doesNotMean: [
      "It does not mean the worker stopped or failed.",
      "No termination note is emitted on a read failure.",
    ],
  }),
  "observation.unknown": Object.freeze({
    id: "observation.unknown",
    meaning: "The current observation outcome could not be classified into a known state.",
    doesNotMean: [
      "It does not mean no wait window elapsed.",
      "It does not prove a terminal state was or was not reached.",
    ],
  }),

  // --- termination (mirrors TERMINATION_SOURCES) ---
  "termination.completion": Object.freeze({
    id: "termination.completion",
    meaning: "The terminal outcome is a normal completion signal from the backend.",
    doesNotMean: [
      "It does not mean the deliverable passed verification or was accepted by the Lead.",
    ],
  }),
  "termination.execution_deadline": Object.freeze({
    id: "termination.execution_deadline",
    meaning: "WAO's wall-clock execution-deadline timer fired for this run.",
    doesNotMean: [
      "It reflects only the already-projected durable deadline fact, not a provider stall or a retry.",
    ],
  }),
  "termination.manual": Object.freeze({
    id: "termination.manual",
    meaning: "An owner or operator explicitly stopped the run.",
    doesNotMean: [
      "It does not indicate a worker, provider, or backend failure.",
    ],
  }),
  "termination.provider": Object.freeze({
    id: "termination.provider",
    meaning: "The terminal outcome is attributed to the provider side (access denial or stream disconnect).",
    doesNotMean: [
      "It does not prove a backend crash or a WAO control-plane gate.",
    ],
  }),
  "termination.backend": Object.freeze({
    id: "termination.backend",
    meaning: "The terminal outcome is attributed to the backend (crash, stream ended, or evidence-passed-but-backend-failed).",
    doesNotMean: [
      "It does not prove a provider access problem or a WAO control-plane gate.",
    ],
  }),
  "termination.control_plane": Object.freeze({
    id: "termination.control_plane",
    meaning: "The terminal outcome is attributed to a WAO control-plane gate (budget, scorecard, isolation, delivery, or config).",
    doesNotMean: [
      "It does not prove a provider or backend failure.",
    ],
  }),
  "termination.unknown": Object.freeze({
    id: "termination.unknown",
    meaning: "No trustworthy signal identifies who or what caused the terminal outcome.",
    doesNotMean: [
      "It does not assert any specific cause; never infer one.",
    ],
  }),

  // --- delivery (readiness / verification / candidate facts) ---
  "delivery.reviewable": Object.freeze({
    id: "delivery.reviewable",
    meaning: "A delivery is packaged and settled with exactly one final verification outcome, ready for Lead review.",
    doesNotMean: [
      "verificationStatus=passed is exact-artifact verification, NOT Lead acceptance.",
      "It does not recommend accepting or rejecting the delivery.",
    ],
  }),
  "delivery.verification_passed": Object.freeze({
    id: "delivery.verification_passed",
    meaning: "Exact-artifact verification of the packaged delivery passed.",
    doesNotMean: [
      "Verification passed is NOT Lead acceptance of the delivery.",
      "It does not recommend accepting or rejecting.",
    ],
  }),
  "delivery.verification_failed": Object.freeze({
    id: "delivery.verification_failed",
    meaning: "Exact-artifact verification of the packaged delivery failed.",
    doesNotMean: [
      "It does not recommend rejecting or re-running the delivery.",
    ],
  }),
  "delivery.verification_unavailable": Object.freeze({
    id: "delivery.verification_unavailable",
    meaning: "No verification outcome is available for the packaged delivery.",
    doesNotMean: [
      "It does not mean verification passed or failed.",
    ],
  }),
  "delivery.packaging_failed": Object.freeze({
    id: "delivery.packaging_failed",
    meaning: "Packaging the delivery failed.",
    doesNotMean: [
      "It does not recommend re-packaging or any specific recovery.",
    ],
  }),
  "delivery.isolation_failed": Object.freeze({
    id: "delivery.isolation_failed",
    meaning: "The delivery failed on a working-directory isolation escape (workdir_escape) and was never packaged.",
    doesNotMean: [
      "It is NOT a packaging failure and does not expose a candidate inventory or diff.",
      "It does not recommend re-packaging, salvage, retry, stop, or a decision.",
    ],
  }),
  "delivery.waiting": Object.freeze({
    id: "delivery.waiting",
    meaning: "The delivery is waiting for packaging or verification to settle.",
    doesNotMean: [
      "It does not mean the delivery passed or failed verification.",
    ],
  }),
  "delivery.not_requested": Object.freeze({
    id: "delivery.not_requested",
    meaning: "No delivery was requested for this run.",
    doesNotMean: [
      "It does not indicate a packaging or verification failure.",
    ],
  }),
  "delivery.ambiguous": Object.freeze({
    id: "delivery.ambiguous",
    meaning: "The delivery state could not be projected to a single readiness label.",
    doesNotMean: [
      "It does not recommend any specific action.",
    ],
  }),

  // --- diagnosis (one per DIAGNOSIS_CATEGORIES, in SSOT order) ---
  "diagnosis.provider_auth": Object.freeze({
    id: "diagnosis.provider_auth",
    meaning: "The failure category is provider access denial (authentication or authorization).",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.config_conflict": Object.freeze({
    id: "diagnosis.config_conflict",
    meaning: "The failure category is a configuration conflict.",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.timeout": Object.freeze({
    id: "diagnosis.timeout",
    meaning: "The failure category is a timeout.",
    doesNotMean: ["It does not by itself assert that a WAO execution deadline fired."],
  }),
  "diagnosis.budget": Object.freeze({
    id: "diagnosis.budget",
    meaning: "The failure category is a budget exhaustion.",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.scorecard_fail": Object.freeze({
    id: "diagnosis.scorecard_fail",
    meaning: "The failure category is a scorecard failure.",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.evidence_passed_backend_failed": Object.freeze({
    id: "diagnosis.evidence_passed_backend_failed",
    meaning: "The failure category is evidence passed but the backend failed.",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.provider_disconnect": Object.freeze({
    id: "diagnosis.provider_disconnect",
    meaning: "The failure category is a provider stream disconnect.",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.no_effect": Object.freeze({
    id: "diagnosis.no_effect",
    meaning: "The failure category is no observable effect from the worker.",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.crash": Object.freeze({
    id: "diagnosis.crash",
    meaning: "The failure category is a backend crash.",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.aborted_manual": Object.freeze({
    id: "diagnosis.aborted_manual",
    meaning: "The failure category is a manual abort.",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.workdir_escape": Object.freeze({
    id: "diagnosis.workdir_escape",
    meaning: "The failure category is a working-directory isolation escape.",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.delivery_packaging_failed": Object.freeze({
    id: "diagnosis.delivery_packaging_failed",
    meaning: "The failure category is a delivery packaging failure.",
    doesNotMean: ["It is a factual category, not a prescription or a fix."],
  }),
  "diagnosis.unknown": Object.freeze({
    id: "diagnosis.unknown",
    meaning: "The failure category is unknown (no closed-set category applied).",
    doesNotMean: ["It does not assert any specific cause."],
  }),
  "diagnosis.none": Object.freeze({
    id: "diagnosis.none",
    meaning: "No failure was diagnosed for this run.",
    doesNotMean: ["It does not by itself mean verification passed or that the Lead should accept."],
  }),
});

export const SEMANTIC_NOTE_IDS = Object.freeze(Object.keys(CATALOG));

const ID_SET = new Set(SEMANTIC_NOTE_IDS);

// ===== Bounded id SHAPE (derived from the catalog) =====
//
// The MCP output schema serializes a BOUNDED id shape (frozen namespaces + a max
// length + the namespace pattern), NOT the full catalog enum: serializing a 33+-
// element enum once per output schema dominated the tools/list wire. The shape is
// a coarse guard only — this SSOT (validateSemanticNote → ID_SET) remains the
// EXACT catalog-membership authority, and every selector only ever emits catalog
// ids. These constants are derived from the catalog so the schema cannot drift
// from the real namespaces/lengths.
export const SEMANTIC_NOTE_ID_NAMESPACES = Object.freeze(
  [...new Set(SEMANTIC_NOTE_IDS.map((id) => id.split(".")[0]))],
);
export const SEMANTIC_NOTE_ID_MAX_LEN = SEMANTIC_NOTE_IDS.reduce((m, id) => Math.max(m, id.length), 0);
export const SEMANTIC_NOTE_ID_PATTERN = new RegExp(
  `^(${SEMANTIC_NOTE_ID_NAMESPACES.join("|")})\\.[a-z0-9_]+$`,
);

// ===== Selection helpers (pure, facts-driven, deterministic) =====
//
// These resolve to catalog ids. termination/diagnosis ids are resolved from a
// source/category value with an explicit safe closed-set fallback; observation
// and delivery ids come straight from closed-set branches. An unknown value
// never echoes — it collapses to the safe fallback note.

function terminationId(source) {
  const id = `termination.${source}`;
  return ID_SET.has(id) ? id : "termination.unknown";
}

function diagnosisId(category) {
  const id = `diagnosis.${category}`;
  return ID_SET.has(id) ? id : "diagnosis.unknown";
}

// One delivery note key from the readiness/verification facts. Readiness (the
// wait-handshake label) takes priority when present; otherwise the point-in-time
// verification status drives it. Returns a catalog id or null (no delivery fact).
function deliveryKey(f) {
  // readiness is the wait-handshake label on run_delivery's payload; the same
  // closed set arrives as deliveryReadiness from run_await_result's outcome.
  // verificationStatus is the run_delivery payload field; the same closed set
  // arrives as deliveryVerificationStatus from run_await_result's outcome.
  const r = f.readiness ?? f.deliveryReadiness;
  if (r === "reviewable") return "delivery.reviewable";
  if (r === "packaging_failed") return "delivery.packaging_failed";
  if (r === "isolation_failed") return "delivery.isolation_failed";
  if (r === "not_requested") return "delivery.not_requested";
  if (r === "ambiguous") return "delivery.ambiguous";
  if (r === "waiting_for_packaging" || r === "waiting_for_verification") return "delivery.waiting";
  const v = f.verificationStatus ?? f.deliveryVerificationStatus;
  if (v === "passed") return "delivery.verification_passed";
  if (v === "failed") return "delivery.verification_failed";
  if (v === "unavailable") return "delivery.verification_unavailable";
  if (v === "pending") return "delivery.waiting";
  if (f.deliveryFailureCode != null) return "delivery.packaging_failed";
  if (f.deliveryRequested === false) return "delivery.not_requested";
  // Requested but not yet settled (point-in-time: deliveryAvailable:false, no
  // verification outcome, no failure) → delivery.waiting. This is the genuine
  // packaging/verification-in-flight state; it must NOT project as not_requested.
  if (f.deliveryRequested === true) return "delivery.waiting";
  if (f.deliveryAvailable === true) return "delivery.waiting";
  return null;
}

// ===== Per-tool selectors (return catalog ids in deterministic priority) =====

function selectForRunWait(f) {
  const o = f.outcome;
  if (o === "read_failure") return ["observation.read_failure"];
  if (o === "terminal") {
    return ["observation.terminal", terminationId(f.terminationSource)];
  }
  if (o === "window_expired") return ["observation.window_expired"];
  if (o === "point_in_time") return ["observation.point_in_time"];
  // Unknown/future/missing outcome: fail closed to the safe observation.unknown note.
  // NEVER observation.point_in_time (which would falsely claim no window elapsed),
  // and never echo the unknown value.
  return ["observation.unknown"];
}

function selectForRunAwaitResult(f) {
  const o = f.outcome;
  if (o === "read_failure") return ["observation.read_failure"];
  const out = [];
  const isTerminal = o === "terminal" || f.terminal === true;
  if (isTerminal) {
    out.push("observation.terminal", terminationId(f.terminationSource));
  } else if (o === "window_expired") {
    out.push("observation.window_expired");
  } else if (o === "point_in_time") {
    out.push("observation.point_in_time");
  } else {
    // Unknown/future/missing outcome → safe observation.unknown (never point_in_time).
    out.push("observation.unknown");
  }
  // Diagnosis note only on a terminal run with a real failure category (not none).
  if (isTerminal && f.diagnosisCategory && f.diagnosisCategory !== "none") {
    out.push(diagnosisId(f.diagnosisCategory));
  }
  // Delivery note only when a delivery was requested (a current delivery fact).
  if (f.deliveryRequested === true) {
    const k = deliveryKey(f);
    if (k) out.push(k);
  }
  return out;
}

function selectForRunDelivery(f) {
  const k = deliveryKey(f);
  return k ? [k] : ["delivery.not_requested"];
}

function selectForRunDiagnose(f) {
  return [diagnosisId(f.category)];
}

const SOURCE_SELECTORS = Object.freeze({
  run_wait: selectForRunWait,
  run_await_result: selectForRunAwaitResult,
  run_delivery: selectForRunDelivery,
  run_diagnose: selectForRunDiagnose,
});

// ===== Public API =====

/**
 * Select the bounded semantic notes for one source tool from its
 * already-available machine facts.
 *
 * @param {string} toolName — one of the four source tools
 * @param {object} [facts] — flat machine facts (see the per-tool selectors)
 * @returns {Array<object>} 1..SEMANTIC_NOTE_MAX_ENTRIES validated three-key notes
 * @throws {Error} /unknown tool/ for any non-source tool name
 */
export function selectSemanticNotes(toolName, facts) {
  const selector = SOURCE_SELECTORS[toolName];
  if (!selector) {
    throw new Error(`unknown tool: ${toolName}`);
  }
  const f = facts ?? {};
  const ids = selector(f);
  const entries = [];
  const seen = new Set();
  for (const id of ids) {
    const entry = CATALOG[id];
    if (!entry) continue; // defensive: a catalog id must always exist
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ ...entry });
  }
  enforceSemanticNoteBounds(entries);
  return entries;
}

/**
 * Validate one semantic note against the EXACT contract: three keys, closed-set
 * id, bounded non-empty meaning, doesNotMean an array of 0..2 bounded non-empty
 * non-implications. Returns true on success; throws on any violation (fail
 * closed).
 *
 * @param {object} entry
 * @returns {true}
 */
export function validateSemanticNote(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("semantic note must be an object");
  }
  const keys = Object.keys(entry).sort();
  const expected = ["doesNotMean", "id", "meaning"];
  if (keys.length !== 3 || keys.some((k, i) => k !== expected[i])) {
    throw new Error(`semantic note must have exactly the three keys, got: ${keys.join(",")}`);
  }
  if (!ID_SET.has(entry.id)) {
    throw new Error(`semantic id outside closed set: ${entry.id}`);
  }
  if (typeof entry.meaning !== "string" || entry.meaning.length === 0
    || entry.meaning.length > SEMANTIC_NOTE_FIELD_MAX_LEN) {
    throw new Error(`semantic meaning must be a non-empty string <= ${SEMANTIC_NOTE_FIELD_MAX_LEN} chars`);
  }
  if (!Array.isArray(entry.doesNotMean) || entry.doesNotMean.length > SEMANTIC_NOTE_MAX_DOES_NOT_MEAN) {
    throw new Error(`semantic doesNotMean must be an array of <= ${SEMANTIC_NOTE_MAX_DOES_NOT_MEAN} items`);
  }
  for (const d of entry.doesNotMean) {
    if (typeof d !== "string" || d.length === 0 || d.length > SEMANTIC_NOTE_FIELD_MAX_LEN) {
      throw new Error(`semantic doesNotMean item must be a non-empty string <= ${SEMANTIC_NOTE_FIELD_MAX_LEN} chars`);
    }
  }
  return true;
}

/**
 * Enforce the hard bounds: at most SEMANTIC_NOTE_MAX_ENTRIES entries, EVERY entry
 * individually validated (shape / closed-set id / bounds), unique ids, and one
 * serialized-size cap (SEMANTIC_NOTE_SERIALIZED_MAX_BYTES) measured in UTF-8
 * BYTES. This is the single enforcement point; it throws on any violation.
 *
 * @param {Array<object>} entries
 * @returns {Array<object>} the same array
 */
export function enforceSemanticNoteBounds(entries) {
  if (!Array.isArray(entries)) throw new Error("semantic notes must be an array");
  // The contract is 1..4: zero entries is a violation. Every selector yields at
  // least one note, so an empty list is never a legitimate result — fail closed.
  if (entries.length < 1) {
    throw new Error("semantic notes must have at least one entry");
  }
  if (entries.length > SEMANTIC_NOTE_MAX_ENTRIES) {
    throw new Error(`semantic notes exceed cap: ${entries.length} > ${SEMANTIC_NOTE_MAX_ENTRIES}`);
  }
  for (const entry of entries) validateSemanticNote(entry);
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`duplicate semantic id: ${entry.id}`);
    ids.add(entry.id);
  }
  const bytes = Buffer.byteLength(JSON.stringify(entries), "utf8");
  if (bytes > SEMANTIC_NOTE_SERIALIZED_MAX_BYTES) {
    throw new Error(`semantic notes serialized size exceeds cap: ${bytes} > ${SEMANTIC_NOTE_SERIALIZED_MAX_BYTES} bytes`);
  }
  return entries;
}

/**
 * The compact summary list for the wao://semantics resource: every catalog id
 * with its meaning, in SSOT order. Two-key entries { id, meaning } (the detail
 * resource adds doesNotMean).
 *
 * @returns {Array<{id: string, meaning: string}>}
 */
export function getSemanticSummary() {
  return SEMANTIC_NOTE_IDS.map((id) => ({ id, meaning: CATALOG[id].meaning }));
}

/**
 * The full three-key note for one id, or null if the id is unknown/malformed.
 * The caller (the MCP resource handler) collapses null to the fixed safe text.
 *
 * @param {string} id
 * @returns {{id: string, meaning: string, doesNotMean: string[]}|null}
 */
export function getSemanticNoteById(id) {
  if (typeof id !== "string") return null;
  const entry = CATALOG[id];
  return entry ? { ...entry } : null;
}

/**
 * The mechanical detail URI for one note id.
 * @param {string} id
 * @returns {string} `${SEMANTIC_DETAIL_URI_PREFIX}${id}`
 */
export function detailUriForId(id) {
  return `${SEMANTIC_DETAIL_URI_PREFIX}${id}`;
}
