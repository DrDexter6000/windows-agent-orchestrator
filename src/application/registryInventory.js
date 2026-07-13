// src/application/registryInventory.js
//
// M9-0: Shared application service for registry inventory.
//
// This module is the single owner of the registry list data logic:
// reading agents.json, joining reliability-summary.json certification
// status, and resolving model display labels.
//
// Constraints (enforced by design, not discipline):
// - No console.log, no process.exit, no argv parsing.
// - No import from command modules (src/commands/registry.js etc.).
//   shared.js is allowed — it is a shared utility module, not a command.
// - No MCP dependency.
// - No shell commands, no file writes, no credential reads.
// - Pure data transformation — returns structured arrays.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRegistry } from "../registry.js";
import { displayModel } from "../commands/shared.js";

/**
 * Resolve the model display label for an agent.
 * Delegates to the shared displayModel SSOT.
 * @param {object} agent — normalized agent from registry
 * @returns {string}
 */
function resolveAgentModelLabel(agent) {
  return displayModel(agent);
}

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
 * @returns {Promise<Array<{id, backend, model, certification, cwd}>>}
 */
export async function getRegistryInventory({
  registryPath,
  runDir,
  readRegistryFn,
  readFileFn,
}) {
  const _readRegistry = readRegistryFn ?? readRegistry;
  const registry = await _readRegistry(registryPath);
  const certMap = await buildCertMap(runDir, readFileFn);

  return registry.listAgents().map((agent) => ({
    id: agent.id,
    backend: agent.backend,
    model: resolveAgentModelLabel(agent),
    certification: certMap[agent.id] ?? null,
    cwd: agent.cwd,
  }));
}
