// src/application/registryInventory.js
//
// M9-0: Shared application service for registry inventory.
//
// This module is the single owner of the registry list data logic:
// reading agents.json, joining reliability-summary.json certification
// status, and resolving model display labels.
//
// It also owns the displayModel SSOT — the model label resolution logic
// lives here, and src/commands/shared.js re-exports it to preserve the
// existing public contract.
//
// This service performs read-only file I/O (registry + reliability summary).
// It does not import from src/commands/*, does not parse CLI args,
// does not write to console, does not set process.exit, does not depend
// on MCP, does not modify files. (M11-7: it probes whether registry-declared
// credential env NAMES are present — names only; it never surfaces values.)

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRegistry, normalizeAgent } from "../registry.js";
import { isValidCanonicalAgentId } from "../canonicalAgentId.js";
import { assessWorkerReadiness, createEnvResolver } from "./credentialReadiness.js";

// ===== M12-6 FR-02: provider readiness truth SSOT =====
//
// Strict truth projection: these fields state ONLY what THIS inventory call
// actually observed — the registry entry was configured, and authentication /
// entitlement / live status were NOT probed (this package never makes provider
// network requests and never reads credential values). The MCP wire schemas
// derive their enums from these frozen arrays (z.enum(CONFIGURATION_STATUSES)
// etc.), so it is structurally impossible for any worker to be projected as
// authenticated/entitled/checked from this inventory path.
//
// The single-element arrays are deliberate: the closed set for each field is
// exactly one value today. Adding a second value requires changing this SSOT —
// there is no second hand-maintained enum to drift.

export const CONFIGURATION_STATUSES = Object.freeze(["configured"]);
export const AUTHENTICATION_STATUSES = Object.freeze(["unknown"]);
export const ENTITLEMENT_STATUSES = Object.freeze(["unknown"]);
export const LIVE_CHECK_STATUSES = Object.freeze(["not_checked"]);

// ===== M12-25 (Outcome 1): bounded safe registry-issue projection =====
//
// When the registry source is readable but one entry cannot be
// normalized/projected, the partial inventory path returns the VALID agents
// PLUS a bounded per-entry issue list instead of aborting the whole list. The
// issue shape is deliberately closed and safe:
//   - code: a CLOSED set. "invalid_id" = the agent id is not canonical; the raw
//     id is NEVER echoed (it could be sensitive or an injection payload).
//     "invalid_configuration" = canonical id but backend/cwd/model/provider/
//     sessionReuse/waitTimeout/systemPrompt validation failed.
//   - agentId: projected ONLY when the id is canonical; otherwise null.
//   - No raw error text, config, path, or credential value is ever carried.
// The MCP wire schemas derive their enums from this frozen array (single SSOT),
// so a malformed/injected issue code can never reach the model.
export const REGISTRY_ISSUE_CODES = Object.freeze(["invalid_id", "invalid_configuration"]);
// Cap on per-entry issues returned (defensive against a pathological registry).
// The true malformed count is unbounded; issuesTruncated reports when the cap
// was hit. Exported so the MCP output schema can enforce the SAME bound.
export const REGISTRY_ISSUES_CAP = 32;

/**
 * Build the strict providerReadiness object for one worker.
 * credentialAvailability (existing closed set) is embedded so the Lead sees
 * registry-config truth and credential-presence truth together.
 * @param {"available"|"missing"|"not_required"} credentialAvailability
 * @returns {{configurationStatus: string, authenticationStatus: string, entitlementStatus: string, liveCheckStatus: string, credentialAvailability: string}}
 */
export function buildProviderReadiness(credentialAvailability) {
  return {
    configurationStatus: "configured",
    authenticationStatus: "unknown",
    entitlementStatus: "unknown",
    liveCheckStatus: "not_checked",
    credentialAvailability,
  };
}

// ===== Private helpers (owned by this module) =====

/**
 * Resolve the model display label for an agent.
 * M11-9: reads the structured `model.id` field (the canonical source after
 * normalization). The legacy args/prependArgs fallbacks are removed — the
 * normalizer already extracted them to structured fields, so there is no
 * second authority to search. provider.model is gone (forbidden by contract).
 * @param {object} agent — normalized agent from registry
 * @returns {string}
 */
export function displayModel(agent) {
  if (typeof agent.model === "string") return agent.model;
  return agent.model?.id
    ?? (["claude-code", "codex", "kimi-code", "deepseek-harness"].includes(agent.backend) ? "(default)" : "-");
}

// ===== Service implementation =====

/**
 * Read reliability-summary.json and build a certification record map.
 * Returns {} on missing file or corrupted JSON (no throw).
 * @param {string} runDir
 * @param {Function} [customReadFile] — injectable for testing
 * @returns {Promise<Record<string, string>>}
 */
async function buildCertMap(runDir, customReadFile) {
  if (!runDir) return {};
  const _readFile = customReadFile ?? readFile;
  try {
    const raw = await _readFile(join(runDir, "reliability-summary.json"), "utf8");
    const summary = JSON.parse(raw);
    const certMap = {};
    for (const [id, w] of Object.entries(summary?.workers ?? {})) {
      certMap[id] = {
        status: w.status ?? "-",
        backend: w.backend,
        modelId: w.modelId,
      };
    }
    return certMap;
  } catch {
    return {};
  }
}

/**
 * Get registry inventory — the structured data behind `registry list`.
 *
 * @param {object} input
 * @param {string} input.registryPath — path to agents.json
 * @param {string} [input.runDir] — path to runs/ dir (for reliability-summary.json)
 * @param {Function} [input.readRegistryFn] — injectable readRegistry for testing
 * @param {Function} [input.readFileFn] — injectable readFile for testing
 * @param {Function} [input.userEnvReader] — injectable Windows user-env reader (M11-7)
 * @returns {Promise<Array<{id, backend, model, certification, cwd, credentialAvailability, missingCredentialEnvNames, providerReadiness}>>}
 *   providerReadiness — M12-6 FR-02 strict truth object (configurationStatus
 *   "configured"; authenticationStatus/entitlementStatus "unknown";
 *   liveCheckStatus "not_checked"). Never filled with probed values: this
 *   service performs no provider network request and never reads credential
 *   values, so it can never claim authenticated/entitled/checked.
 */
export async function getRegistryInventory({
  registryPath,
  runDir,
  readRegistryFn,
  readFileFn,
  userEnvReader,
}) {
  const _readRegistry = readRegistryFn ?? readRegistry;
  const registry = await _readRegistry(registryPath);
  const certMap = await buildCertMap(runDir, readFileFn);

  // M11-7 (operation closeout): ONE operation-scoped resolver shared across all
  // workers, and resolve ONLY the required credential names (registry_list shows
  // credentialAvailability, which depends solely on required names). Optional
  // inherited env (OPENAI_BASE_URL, CODEX_HOME, KIMI_MODEL_NAME, ...) is NOT read
  // here — it is irrelevant to the availability status and would add unnecessary
  // cold-start cost. Two workers sharing a required name read it at most ONCE.
  const resolver = createEnvResolver(userEnvReader);
  const results = [];
  for (const agent of registry.listAgents()) {
    const readiness = await assessWorkerReadiness({ agent, resolver });
    results.push(projectInventoryEntry(agent, certMap, readiness));
  }
  return results;
}

/**
 * M12-25: the SINGLE deterministic safe projection for registry issues at every
 * public adapter boundary — used by getRegistryInventoryWithIssues (the partial
 * projector), aggregateLeadPreflight, and the MCP registry_list handler — so the
 * closed-set / canonical-id / cap / truncation rules live in ONE place, not three.
 *
 * Bounds the result to REGISTRY_ISSUES_CAP and derives issuesTruncated = the
 * source's own truncation flag OR the supplied array exceeding the cap (a
 * malicious/injected resolver that passes >cap issues with
 * issuesTruncated:false still reports truncation). Each issue is reduced to the
 * safe {code, agentId} shape: code must be in the frozen closed set (else
 * collapses to "invalid_configuration"); agentId is projected ONLY when
 * canonical, else null. Never carries raw error text, config, path, credential,
 * or any other injected field. Every supplied array element is projected
 * (M12-25C): a malformed/non-object element becomes {invalid_configuration,
 * null} rather than being filtered away, so a bad element can never vanish into
 * a clean result — and it still counts toward the cap/truncation.
 *
 * @param {Array<{code?:string, agentId?:string}>|null|undefined} rawIssues
 * @param {boolean} [sourceTruncated] — truncation flag from the upstream source.
 * @returns {{issues: Array<{code:string, agentId:string|null}>, issuesTruncated: boolean}}
 */
export function projectRegistryIssues(rawIssues, sourceTruncated = false) {
  // M12-25C: project EVERY supplied array element into the safe closed shape —
  // a malformed element (null / primitive / object without a valid code) must
  // NOT disappear into a clean result; it becomes {invalid_configuration, null}.
  // Cap, truncation, closed-set code, canonical-id-or-null, and no-leak still
  // hold; truncation now counts every projected element (malformed included).
  const cleaned = (Array.isArray(rawIssues) ? rawIssues : []).map((i) => {
    const isObj = i && typeof i === "object";
    return {
      code: isObj && REGISTRY_ISSUE_CODES.includes(i.code) ? i.code : "invalid_configuration",
      agentId: isObj && typeof i.agentId === "string" && isValidCanonicalAgentId(i.agentId)
        ? i.agentId
        : null,
    };
  });
  return {
    issues: cleaned.slice(0, REGISTRY_ISSUES_CAP),
    issuesTruncated: Boolean(sourceTruncated) || cleaned.length > REGISTRY_ISSUES_CAP,
  };
}

/**
 * M12-25B: the SINGLE shared normalization of an inventory result at every
 * public adapter boundary — the lead_preflight aggregator, MCP registry_list,
 * the MCP lead_preflight snapshot, and MCP runs_list all consume the default
 * service (getRegistryInventoryWithIssues) or an injected resolver through THIS
 * one function. Accepts exactly the two VALID shapes and THROWS on anything
 * else, so every caller in a try/catch FAILS CLOSED to unknown/error: a
 * null/malformed injected resolver can never masquerade a read failure as an
 * observed-empty (zero-worker) registry. "Could not read" must stay distinct
 * from "read, and there are zero agents".
 *
 * Valid shapes:
 *   - legacy bare array (strict getRegistryInventory / documented direct-
 *     application input) → {agents: <array>, issues: [], issuesTruncated: false}
 *   - partial projection {agents: Array, issues?: Array, issuesTruncated?: boolean}
 *
 * Invalid (throws): null, undefined, a primitive, an object whose `agents`
 * is not an array, OR a present-but-wrong-typed facet (a non-array `issues` or
 * a non-boolean `issuesTruncated`; null counts as present-but-wrong). Only an
 * absent (undefined) optional facet defaults. A genuinely empty-but-readable
 * registry is a VALID empty array (or {agents: []}) — it normalizes to
 * agents:[] (observed-empty), NOT unknown; only a null/malformed result throws.
 * The issues facet is carried through ONLY as-is; callers apply
 * projectRegistryIssues to bound/sanitize it.
 *
 * Idempotent: a normalized {agents, issues, issuesTruncated} re-normalizes to
 * itself, so a caller may normalize eagerly (e.g. for knownAgentIds) and replay
 * the normalized snapshot to an aggregator that normalizes again.
 *
 * @param {*} result
 * @returns {{agents: Array, issues: Array, issuesTruncated: boolean}}
 */
export function normalizeInventoryResult(result) {
  if (Array.isArray(result)) {
    return { agents: result, issues: [], issuesTruncated: false };
  }
  if (result && typeof result === "object" && Array.isArray(result.agents)) {
    // M12-25C narrow truth boundary: a PRESENT-but-wrong-typed facet is
    // malformed (an injected resolver must not smuggle issues:"bad" /
    // issuesTruncated:"false" through as an apparently clean inventory). Only
    // an ABSENT (undefined) optional facet defaults; null counts as
    // present-but-wrong. A valid empty issues array ([]) stays observed-clean.
    if (result.issues !== undefined && !Array.isArray(result.issues)) {
      throw new Error("malformed inventory result");
    }
    if (result.issuesTruncated !== undefined && typeof result.issuesTruncated !== "boolean") {
      throw new Error("malformed inventory result");
    }
    return {
      agents: result.agents,
      issues: Array.isArray(result.issues) ? result.issues : [],
      issuesTruncated: typeof result.issuesTruncated === "boolean" ? result.issuesTruncated : false,
    };
  }
  throw new Error("malformed inventory result");
}

/**
 * M12-25: Partial registry inventory — the structured data behind MCP
 * `registry_list` / `lead_preflight` when the registry source is READABLE but
 * contains one or more malformed/unsupported entries.
 *
 * Distinct from the strict getRegistryInventory (CLI `registry list`/`validate`
 * stay strict — they throw on the first bad entry). This SEPARATE projection
 * reads/normalizes each entry individually: a valid entry is projected exactly
 * as getRegistryInventory would (parity via the shared projectInventoryEntry);
 * an entry that fails normalization produces ONE bounded safe issue instead of
 * aborting the list. A whole-file unreadable/invalid-JSON source is a DISTINCT
 * failure — it throws here (readRegistry reads+JSON.parses once), never faked as
 * a partial result. Zero valid entries WITH issues is NOT an observed-clean
 * empty registry (the issues array is non-empty).
 *
 * @param {object} input — same shape as getRegistryInventory
 * @returns {Promise<{agents: Array, issues: Array<{code:string, agentId:string|null}>, issuesTruncated: boolean}>}
 */
export async function getRegistryInventoryWithIssues({
  registryPath,
  runDir,
  readRegistryFn,
  readFileFn,
  userEnvReader,
}) {
  const _readRegistry = readRegistryFn ?? readRegistry;
  // Read/parse the registry source ONCE. readRegistry throws on a missing file
  // or invalid JSON — that is a whole-source failure, NOT a per-entry issue, so
  // it propagates (the caller surfaces a hard error; never a faked partial list).
  const registry = await _readRegistry(registryPath);
  const certMap = await buildCertMap(runDir, readFileFn);
  const resolver = createEnvResolver(userEnvReader);

  const agents = [];
  const rawIssues = [];
  for (const [id, raw] of registry.rawEntries()) {
    try {
      const agent = normalizeAgent(id, raw);
      const readiness = await assessWorkerReadiness({ agent, resolver });
      agents.push(projectInventoryEntry(agent, certMap, readiness));
    } catch {
      // One malformed/unsupported entry must NOT abort the list. Record a raw
      // safe issue; the shared projector (single SSOT) bounds + truncates +
      // sanitizes it — never the raw error text / config / path / credential.
      const canonical = isValidCanonicalAgentId(id);
      rawIssues.push({
        code: canonical ? "invalid_configuration" : "invalid_id",
        agentId: canonical ? id : null,
      });
    }
  }
  return { agents, ...projectRegistryIssues(rawIssues, false) };
}

/**
 * Project ONE normalized agent into the inventory entry shape. Shared by the
 * strict getRegistryInventory and the partial getRegistryInventoryWithIssues so
 * a valid entry is projected identically in both paths (M9-1-07 CLI/MCP parity
 * is preserved — the MCP agents array deep-equals the strict service output for
 * an all-valid registry).
 */
function projectInventoryEntry(agent, certMap, readiness) {
  return {
    id: agent.id,
    backend: agent.backend,
    model: displayModel(agent),
    // M11-9: reasoningEffort from structured field. null when absent (runtime
    // default) — never fabricated, never reverse-parsed from args.
    reasoningEffort: agent.reasoning?.effort ?? null,
    certification: certificationFor(agent, certMap[agent.id]),
    cwd: agent.cwd,
    // M11-11C: project the configured reuse mode so the Lead sees which
    // experts retain a provider-native conversation across turns. Nullable —
    // most agents do not configure sessionReuse.
    sessionReuse: agent.sessionReuse ?? null,
    credentialAvailability: readiness.credentialAvailability,
    missingCredentialEnvNames: readiness.missingCredentialEnvNames,
    // M12-6 FR-02: strict truth — never claims authenticated/entitled/live.
    providerReadiness: buildProviderReadiness(readiness.credentialAvailability),
  };
}

function certificationFor(agent, record) {
  if (!record) return null;
  if (record.backend !== undefined && record.backend !== agent.backend) return null;
  const modelId = agent.model?.id ?? null;
  if (record.modelId !== undefined && record.modelId !== modelId) return null;
  return record.status;
}
