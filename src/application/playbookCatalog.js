// src/application/playbookCatalog.js
//
// M11-2A (closeout): Lead Playbook Catalog kernel.
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
//
// Fail-closed guarantees (M11-2A closeout):
//   - The catalog directory must contain EXACTLY the four approved JSON files.
//   - Each parsed id must match its filename stem.
//   - Every object (root, role, phase, escalation) must pass a strict key
//     allowlist — unknown fields are rejected, not ignored.
//   - IDs (playbook + phase) must be lowercase kebab-case.
//   - getLeadPlaybook input is validated for shape; NotFound uses a fixed
//     message that does not echo caller input.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// ── Typed errors ─────────────────────────────────────────────────────────────

export class PlaybookNotFoundError extends Error {
  constructor() {
    super("Playbook not found");
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

// Strict key allowlists for each object type.
const ROOT_KEYS = new Set([
  "id", "version", "title", "summary", "useWhen", "avoidWhen",
  "lanePattern", "roles", "phases", "completionEvidence", "escalation",
]);
const ROLE_KEYS = new Set(["capability", "importance", "min", "max"]);
const PHASE_KEYS = new Set(["id", "intent", "importance", "evidence", "adaptations"]);
const ESCALATION_KEYS = new Set(["advisor", "auditor"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Lowercase kebab-case: lowercase alphanumeric segments joined by hyphens. */
function isKebabId(v) {
  return typeof v === "string"
    && v.length >= 1
    && v.length <= MAX_ID_LEN
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
}

function isNonEmptyString(v, max = MAX_STRING_LEN) {
  return typeof v === "string" && v.length >= 1 && v.length <= max;
}

function checkNoUnknownKeys(obj, allowed, label) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw new PlaybookValidationError(`${label}: unknown key '${k}'`);
    }
  }
}

function validateBoundedStringArray(arr, fieldName, label, maxLen = MAX_LIST_ENTRIES) {
  if (!Array.isArray(arr) || arr.length < 1 || arr.length > maxLen) {
    throw new PlaybookValidationError(`${label}: ${fieldName} must be a non-empty array of at most ${maxLen} entries`);
  }
  for (let i = 0; i < arr.length; i += 1) {
    if (!isNonEmptyString(arr[i])) {
      throw new PlaybookValidationError(`${label}: ${fieldName}[${i}] must be a non-empty string of at most ${MAX_STRING_LEN} chars`);
    }
  }
}

function validateRole(role, i, label) {
  if (!role || typeof role !== "object") {
    throw new PlaybookValidationError(`${label}: role[${i}] must be an object`);
  }
  checkNoUnknownKeys(role, ROLE_KEYS, `${label}: role[${i}]`);
  if (!VALID_CAPABILITIES.has(role.capability)) {
    throw new PlaybookValidationError(`${label}: role[${i}].capability must be one of ${[...VALID_CAPABILITIES].join("|")}`);
  }
  if (!VALID_IMPORTANCE.has(role.importance)) {
    throw new PlaybookValidationError(`${label}: role[${i}].importance must be core|conditional`);
  }
  if (!Number.isInteger(role.min) || role.min < 0 || role.min > 4) {
    throw new PlaybookValidationError(`${label}: role[${i}].min must be integer 0..4`);
  }
  if (!Number.isInteger(role.max) || role.max < 0 || role.max > 4) {
    throw new PlaybookValidationError(`${label}: role[${i}].max must be integer 0..4`);
  }
  if (role.min > role.max) {
    throw new PlaybookValidationError(`${label}: role[${i}].min (${role.min}) must be <= max (${role.max})`);
  }
  if ((role.capability === "advisor" || role.capability === "auditor") && role.importance === "core") {
    throw new PlaybookValidationError(`${label}: role[${i}]: ${role.capability} must not be core`);
  }
}

function validatePhase(phase, i, label) {
  if (!phase || typeof phase !== "object") {
    throw new PlaybookValidationError(`${label}: phase[${i}] must be an object`);
  }
  checkNoUnknownKeys(phase, PHASE_KEYS, `${label}: phase[${i}]`);
  if (!isKebabId(phase.id)) {
    throw new PlaybookValidationError(`${label}: phase[${i}].id must be lowercase kebab-case (1..64 chars)`);
  }
  if (!isNonEmptyString(phase.intent)) {
    throw new PlaybookValidationError(`${label}: phase[${i}].intent must be 1..${MAX_STRING_LEN} chars`);
  }
  if (!VALID_IMPORTANCE.has(phase.importance)) {
    throw new PlaybookValidationError(`${label}: phase[${i}].importance must be core|conditional`);
  }
  validateBoundedStringArray(phase.evidence, "evidence", `${label}: phase[${i}]`, MAX_LIST_ENTRIES);
  validateBoundedStringArray(phase.adaptations, "adaptations", `${label}: phase[${i}]`, MAX_LIST_ENTRIES);
}

/**
 * Validate a complete PlaybookV1 object structurally with strict key allowlists.
 * Throws PlaybookValidationError on any violation.
 */
function validatePlaybook(pb, sourceId) {
  const label = sourceId || pb?.id || "<unknown>";

  if (!pb || typeof pb !== "object" || Array.isArray(pb)) {
    throw new PlaybookValidationError(`${label}: playbook must be a plain object`);
  }
  checkNoUnknownKeys(pb, ROOT_KEYS, label);

  if (!isKebabId(pb.id)) {
    throw new PlaybookValidationError(`${label}: id must be lowercase kebab-case (1..64 chars)`);
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
  validateBoundedStringArray(pb.useWhen, "useWhen", label, MAX_LIST_ENTRIES);
  validateBoundedStringArray(pb.avoidWhen, "avoidWhen", label, MAX_LIST_ENTRIES);

  if (!Array.isArray(pb.roles) || pb.roles.length < 1 || pb.roles.length > MAX_ROLES) {
    throw new PlaybookValidationError(`${label}: roles must be 1..${MAX_ROLES} entries`);
  }
  pb.roles.forEach((r, i) => validateRole(r, i, label));

  if (!Array.isArray(pb.phases) || pb.phases.length < 1 || pb.phases.length > MAX_PHASES) {
    throw new PlaybookValidationError(`${label}: phases must be 1..${MAX_PHASES} entries`);
  }
  pb.phases.forEach((p, i) => validatePhase(p, i, label));

  validateBoundedStringArray(pb.completionEvidence, "completionEvidence", label, MAX_COMPLETION_EVIDENCE);

  if (!pb.escalation || typeof pb.escalation !== "object" || Array.isArray(pb.escalation)) {
    throw new PlaybookValidationError(`${label}: escalation must be a plain object`);
  }
  checkNoUnknownKeys(pb.escalation, ESCALATION_KEYS, `${label}: escalation`);
  if (!isNonEmptyString(pb.escalation.advisor)) {
    throw new PlaybookValidationError(`${label}: escalation.advisor must be 1..${MAX_STRING_LEN} chars`);
  }
  if (!isNonEmptyString(pb.escalation.auditor)) {
    throw new PlaybookValidationError(`${label}: escalation.auditor must be 1..${MAX_STRING_LEN} chars`);
  }

  const bytes = Buffer.from(JSON.stringify(pb), "utf8").length;
  if (bytes > MAX_OBJECT_BYTES) {
    throw new PlaybookValidationError(`${label}: serialized object ${bytes} bytes exceeds ${MAX_OBJECT_BYTES} (12 KiB)`);
  }
}

// ── Catalog load (module-load, fail-closed) ──────────────────────────────────

const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = resolve(_MODULE_DIR, "..", "..", "playbooks", "lead");

/**
 * Load and validate the built-in catalog. The catalog directory must contain
 * EXACTLY the four approved JSON files (no extra, no missing). Each file's
 * parsed id must match its filename stem. Duplicates or substitutions are
 * rejected.
 */
function loadAndValidateCatalog() {
  // Enumerate directory: require exactly the four approved files.
  let files;
  try {
    files = readdirSync(CATALOG_DIR).filter((f) => f.endsWith(".json")).sort();
  } catch {
    throw new PlaybookValidationError("built-in catalog directory unreadable or missing");
  }
  const expectedFiles = PLAYBOOK_IDS.map((id) => `${id}.json`).sort();
  // Exact set match (no extra, no missing).
  if (files.length !== expectedFiles.length || !files.every((f, i) => f === expectedFiles[i])) {
    throw new PlaybookValidationError(
      `built-in catalog file set mismatch: expected ${expectedFiles.join(", ")}, got ${files.join(", ")}`,
    );
  }

  const catalog = new Map();
  for (const id of PLAYBOOK_IDS) {
    const fileName = `${id}.json`;
    const filePath = join(CATALOG_DIR, fileName);
    let raw;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      throw new PlaybookValidationError(`built-in catalog file unreadable: ${fileName}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new PlaybookValidationError(`built-in catalog file not valid JSON: ${fileName}`);
    }
    // The parsed id must match the filename stem exactly (no substitution).
    if (parsed.id !== id) {
      throw new PlaybookValidationError(`built-in catalog id mismatch in ${fileName}: expected ${id}, got ${parsed.id}`);
    }
    // The id must not already exist in the map (no duplicate across files).
    if (catalog.has(parsed.id)) {
      throw new PlaybookValidationError(`built-in catalog duplicate id: ${parsed.id}`);
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
  return JSON.parse(JSON.stringify(summaries));
}

/**
 * Get a complete, validated, deep-cloned PlaybookV1 by ID.
 *
 * @param {object} input
 * @param {string} input.id — must be a valid lowercase-kebab ID
 * @returns {object} deep-cloned PlaybookV1
 * @throws {PlaybookValidationError} if input is malformed (non-string, wrong shape, etc.)
 * @throws {PlaybookNotFoundError} if the ID is valid-shaped but not in the catalog
 */
export function getLeadPlaybook({ id } = {}) {
  // Validate input shape: must be a non-empty lowercase-kebab string.
  if (!isKebabId(id)) {
    throw new PlaybookValidationError("id must be a non-empty lowercase-kebab string (1..64 chars)");
  }
  const pb = _catalog.get(id);
  if (!pb) {
    // Fixed safe message — does NOT echo the caller's input.
    throw new PlaybookNotFoundError();
  }
  return JSON.parse(JSON.stringify(pb));
}
