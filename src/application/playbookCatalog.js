// src/application/playbookCatalog.js
//
// M11-2A: Lead Playbook Catalog kernel.
//
// A read-only, provider-neutral, deterministic registry of exactly four
// built-in Lead playbooks. Each playbook is a compact decision scaffold with
// evidence gates and adaptation points. The Lead chooses, keeps, skips, or
// changes defaults — the catalog does NOT dispatch, execute a workflow, or
// make semantic decisions.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, zod, or third-party libs.
//   - No environment-variable reads, argv parsing, console output, Git
//     subprocess, or transcript I/O.
//   - Reads built-in JSON at module load, validates fail-closed, caches.
//   - Returns deep clones so callers cannot mutate cached state.
//   - No external catalog path in v1.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// ── Typed errors ─────────────────────────────────────────────────────────────

export class PlaybookNotFoundError extends Error {
  constructor(id) {
    super(`Playbook not found: ${JSON.stringify(id)}`);
    this.name = "PlaybookNotFoundError";
    this.code = "PLAYBOOK_NOT_FOUND";
  }
}

export class PlaybookValidationError extends Error {
  constructor(detail) {
    super(`Playbook catalog validation error: ${detail}`);
    this.name = "PlaybookValidationError";
    this.code = "PLAYBOOK_VALIDATION_ERROR";
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const PLAYBOOK_IDS = [
  "single-coder-delivery",
  "parallel-independent-deliveries",
  "investigate-then-implement",
  "read-only-independent-review",
];

const VALID_CAPABILITIES = new Set(["coder", "researcher", "tester", "advisor", "auditor"]);
const VALID_IMPORTANCE = new Set(["core", "conditional"]);
const VALID_LANE_PATTERNS = new Set(["single", "parallel-independent", "serial-discovery", "read-only"]);

const MAX_ID_LEN = 64;
const MAX_TITLE_LEN = 80;
const MAX_STRING_LEN = 240;
const MAX_ROLES = 5;
const MAX_PHASES = 6;
const MAX_LIST_ENTRIES = 4;
const MAX_COMPLETION_EVIDENCE = 6;
const MAX_OBJECT_BYTES = 12288; // 12 KiB

// ── Structured validation (deterministic, not keyword-pattern matching) ──────

function isNonEmptyString(v, max = MAX_STRING_LEN) {
  return typeof v === "string" && v.length >= 1 && v.length <= max;
}

function isAsciiId(v) {
  return typeof v === "string" && v.length >= 1 && v.length <= MAX_ID_LEN && /^[A-Za-z0-9_-]+$/.test(v);
}

function validateBoundedStringArray(arr, fieldName, maxLen = MAX_LIST_ENTRIES) {
  if (!Array.isArray(arr) || arr.length < 1 || arr.length > maxLen) {
    throw new PlaybookValidationError(`${fieldName} must be a non-empty array of at most ${maxLen} entries`);
  }
  for (let i = 0; i < arr.length; i += 1) {
    if (!isNonEmptyString(arr[i])) {
      throw new PlaybookValidationError(`${fieldName}[${i}] must be a non-empty string of at most ${MAX_STRING_LEN} chars`);
    }
  }
}

function validateRole(role, i) {
  if (!role || typeof role !== "object") {
    throw new PlaybookValidationError(`role[${i}] must be an object`);
  }
  if (!VALID_CAPABILITIES.has(role.capability)) {
    throw new PlaybookValidationError(`role[${i}].capability must be one of ${[...VALID_CAPABILITIES].join("|")}`);
  }
  if (!VALID_IMPORTANCE.has(role.importance)) {
    throw new PlaybookValidationError(`role[${i}].importance must be core|conditional`);
  }
  if (!Number.isInteger(role.min) || role.min < 0 || role.min > 4) {
    throw new PlaybookValidationError(`role[${i}].min must be integer 0..4`);
  }
  if (!Number.isInteger(role.max) || role.max < 0 || role.max > 4) {
    throw new PlaybookValidationError(`role[${i}].max must be integer 0..4`);
  }
  if (role.min > role.max) {
    throw new PlaybookValidationError(`role[${i}].min (${role.min}) must be <= max (${role.max})`);
  }
  // Advisor/Auditor must not be core.
  if ((role.capability === "advisor" || role.capability === "auditor") && role.importance === "core") {
    throw new PlaybookValidationError(`role[${i}]: ${role.capability} must not be core`);
  }
}

function validatePhase(phase, i) {
  if (!phase || typeof phase !== "object") {
    throw new PlaybookValidationError(`phase[${i}] must be an object`);
  }
  if (!isAsciiId(phase.id)) {
    throw new PlaybookValidationError(`phase[${i}].id must be 1..64 ASCII chars`);
  }
  if (!isNonEmptyString(phase.intent)) {
    throw new PlaybookValidationError(`phase[${i}].intent must be 1..${MAX_STRING_LEN} chars`);
  }
  if (!VALID_IMPORTANCE.has(phase.importance)) {
    throw new PlaybookValidationError(`phase[${i}].importance must be core|conditional`);
  }
  validateBoundedStringArray(phase.evidence, `phase[${i}].evidence`, MAX_LIST_ENTRIES);
  validateBoundedStringArray(phase.adaptations, `phase[${i}].adaptations`, MAX_LIST_ENTRIES);
}

/**
 * Validate a complete PlaybookV1 object structurally.
 * Throws PlaybookValidationError on any violation.
 */
function validatePlaybook(pb, sourceId) {
  const label = sourceId || pb?.id || "<unknown>";

  if (!pb || typeof pb !== "object") {
    throw new PlaybookValidationError(`${label}: playbook must be an object`);
  }
  if (!isAsciiId(pb.id)) {
    throw new PlaybookValidationError(`${label}: id must be 1..64 ASCII chars`);
  }
  if (pb.version !== 1) {
    throw new PlaybookValidationError(`${label}: version must be exactly 1`);
  }
  if (!isNonEmptyString(pb.title, MAX_TITLE_LEN)) {
    throw new PlaybookValidationError(`${label}: title must be 1..${MAX_TITLE_LEN} chars`);
  }
  if (!isNonEmptyString(pb.summary)) {
    throw new PlaybookValidationError(`${label}: summary must be 1..${MAX_STRING_LEN} chars`);
  }
  if (!VALID_LANE_PATTERNS.has(pb.lanePattern)) {
    throw new PlaybookValidationError(`${label}: lanePattern must be one of ${[...VALID_LANE_PATTERNS].join("|")}`);
  }
  validateBoundedStringArray(pb.useWhen, "useWhen", MAX_LIST_ENTRIES);
  validateBoundedStringArray(pb.avoidWhen, "avoidWhen", MAX_LIST_ENTRIES);

  if (!Array.isArray(pb.roles) || pb.roles.length < 1 || pb.roles.length > MAX_ROLES) {
    throw new PlaybookValidationError(`${label}: roles must be 1..${MAX_ROLES} entries`);
  }
  pb.roles.forEach((r, i) => validateRole(r, i));

  if (!Array.isArray(pb.phases) || pb.phases.length < 1 || pb.phases.length > MAX_PHASES) {
    throw new PlaybookValidationError(`${label}: phases must be 1..${MAX_PHASES} entries`);
  }
  pb.phases.forEach((p, i) => validatePhase(p, i));

  validateBoundedStringArray(pb.completionEvidence, "completionEvidence", MAX_COMPLETION_EVIDENCE);

  if (!pb.escalation || typeof pb.escalation !== "object") {
    throw new PlaybookValidationError(`${label}: escalation must be an object`);
  }
  if (!isNonEmptyString(pb.escalation.advisor)) {
    throw new PlaybookValidationError(`${label}: escalation.advisor must be 1..${MAX_STRING_LEN} chars`);
  }
  if (!isNonEmptyString(pb.escalation.auditor)) {
    throw new PlaybookValidationError(`${label}: escalation.auditor must be 1..${MAX_STRING_LEN} chars`);
  }

  // 12 KiB bound on serialized object
  const bytes = Buffer.from(JSON.stringify(pb), "utf8").length;
  if (bytes > MAX_OBJECT_BYTES) {
    throw new PlaybookValidationError(`${label}: serialized object ${bytes} bytes exceeds ${MAX_OBJECT_BYTES} (12 KiB)`);
  }
}

// ── Catalog load (module-load, fail-closed) ──────────────────────────────────

const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// src/application/ → ../../playbooks/lead/
const CATALOG_DIR = resolve(_MODULE_DIR, "..", "..", "playbooks", "lead");

function loadAndValidateCatalog() {
  const catalog = new Map();
  for (const id of PLAYBOOK_IDS) {
    const filePath = join(CATALOG_DIR, `${id}.json`);
    let raw;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      throw new PlaybookValidationError(`built-in catalog file missing or unreadable: ${id}.json`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PlaybookValidationError(`built-in catalog file not valid JSON: ${id}.json`);
    }
    // Verify the parsed id matches the expected id (no silent substitution).
    if (parsed.id !== id) {
      throw new PlaybookValidationError(`built-in catalog id mismatch in ${id}.json: got ${parsed.id}`);
    }
    validatePlaybook(parsed, id);
    catalog.set(id, parsed);
  }
  return catalog;
}

const _catalog = loadAndValidateCatalog();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * List all built-in Lead playbooks as bounded summary objects.
 *
 * @returns {Array<{id: string, version: number, title: string, summary: string, lanePattern: string}>}
 *   Deep clones — caller mutation does not affect cached state.
 */
export function listLeadPlaybooks() {
  const summaries = [];
  for (const id of PLAYBOOK_IDS) {
    const pb = _catalog.get(id);
    summaries.push({
      id: pb.id,
      version: pb.version,
      title: pb.title,
      summary: pb.summary,
      lanePattern: pb.lanePattern,
    });
  }
  // Deep clone the array of objects.
  return JSON.parse(JSON.stringify(summaries));
}

/**
 * Get a complete, validated, deep-cloned PlaybookV1 by ID.
 *
 * @param {object} input
 * @param {string} input.id — must be one of the four approved IDs
 * @returns {object} deep-cloned PlaybookV1
 * @throws {PlaybookValidationError} if input is malformed (non-string, empty, etc.)
 * @throws {PlaybookNotFoundError} if the ID is valid-shaped but not in the catalog
 */
export function getLeadPlaybook({ id } = {}) {
  if (typeof id !== "string" || id.length === 0) {
    throw new PlaybookValidationError(`id must be a non-empty string, got: ${JSON.stringify(id)}`);
  }
  const pb = _catalog.get(id);
  if (!pb) {
    throw new PlaybookNotFoundError(id);
  }
  return JSON.parse(JSON.stringify(pb));
}
