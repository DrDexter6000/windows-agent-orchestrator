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
import { readRegistry } from "../registry.js";
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
    results.push({
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
    });
  }
  return results;
}

function certificationFor(agent, record) {
  if (!record) return null;
  if (record.backend !== undefined && record.backend !== agent.backend) return null;
  const modelId = agent.model?.id ?? null;
  if (record.modelId !== undefined && record.modelId !== modelId) return null;
  return record.status;
}
