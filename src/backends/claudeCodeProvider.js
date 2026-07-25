// src/backends/claudeCodeProvider.js
//
// M11-9: claude-code provider wrapper argument derivation.
//
// Reads the CANONICAL top-level fields (M11-9 contract):
//   agent.provider  → wrapper connection flags (--base-url/--api-key-env)
//   agent.model     → wrapper --default-model + claude CLI --model
//   agent.reasoning → wrapper --effort + claude CLI --effort
//
// provider no longer carries model/effort/contextWindow (that old shape is
// rejected by the registry normalizer). This function derives BOTH the wrapper
// prependArgs AND the claude CLI flags from the same structured fields, so the
// two cannot drift (the opus-4.8 bug's root cause).
//
// Returns null when agent has no provider (native OAuth direct-connect path —
// no wrapper). model/reasoning are still translated by the Claude backend's
// buildArgs in that case.

/**
 * Derive claude-code wrapper prependArgs from the canonical provider field.
 * Called only when agent.provider exists (wrapper path is active).
 *
 * @param {object} agent - normalized agent (canonical model/reasoning/provider)
 * @param {string} wrapperPath - absolute path to the wrapper .mjs
 * @returns {{prependArgs: string[], cliFlags: string[]}}
 */
export function resolveProviderArgs(agent, wrapperPath) {
  const provider = agent?.provider;
  if (!provider) return null;
  if (!wrapperPath) throw new Error("resolveProviderArgs: wrapperPath required (when provider present)");

  const model = agent.model;
  const reasoning = agent.reasoning;

  const prependArgs = [wrapperPath];
  if (provider.baseUrl) prependArgs.push("--base-url", provider.baseUrl);
  if (provider.apiKeyEnv) prependArgs.push("--api-key-env", provider.apiKeyEnv);
  if (model?.id) prependArgs.push("--default-model", model.id);
  if (reasoning?.effort) prependArgs.push("--effort", reasoning.effort);
  if (model?.contextWindow) prependArgs.push("--context-window", String(model.contextWindow));
  prependArgs.push("--");

  const cliFlags = [];
  if (model?.id) cliFlags.push("--model", model.id);
  if (reasoning?.effort) cliFlags.push("--effort", reasoning.effort);

  return { prependArgs, cliFlags };
}
