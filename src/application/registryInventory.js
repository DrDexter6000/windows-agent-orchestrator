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

// ===== Private helpers (owned by this module) =====

/**
 * Extract a --flag <value> from an args array.
 * @param {string[]} args
 * @param {string} flag
 * @returns {string|undefined}
 */
function extractFlag(args, flag) {
  if (!Array.isArray(args)) return undefined;
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * Resolve the model display label for an agent.
 * This is the SSOT — shared.js re-exports it.
 * @param {object} agent — normalized agent from registry
 * @returns {string}
 */
export function displayModel(agent) {
  if (typeof agent.model === "string") return agent.model;
  return agent.model?.id
    ?? agent.provider?.model
    ?? extractFlag(agent.args, "--model")
    ?? extractFlag(agent.args, "--default-model")
    ?? extractFlag(agent.prependArgs, "--model")
    ?? extractFlag(agent.prependArgs, "--default-model")
    ?? (["claude-code", "codex", "kimi-code"].includes(agent.backend) ? "(default)" : "-");
}

// ===== Service implementation =====

/**
 * Read reliability-summary.json and build a certification map.
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
      certMap[id] = w.status ?? "-";
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
 * @returns {Promise<Array<{id, backend, model, certification, cwd, credentialAvailability, missingCredentialEnvNames}>>}
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
      certification: certMap[agent.id] ?? null,
      cwd: agent.cwd,
      credentialAvailability: readiness.credentialAvailability,
      missingCredentialEnvNames: readiness.missingCredentialEnvNames,
    });
  }
  return results;
}
