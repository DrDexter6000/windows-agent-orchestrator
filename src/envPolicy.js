// src/envPolicy.js
//
// M11-7 (CTO closeout): Runtime-neutral worker env-name policy SSOT.
//
// Two distinct notions of "env name" — kept strictly separate so optional
// config is never mistaken for a required credential:
//
//   1. inheritedEnvNames(agent) — env names a backend MAY inherit into the
//      worker child process (e.g. OPENAI_BASE_URL, CODEX_HOME, KIMI_MODEL_NAME).
//      OPTIONAL; absence never blocks dispatch. Feeds ProcessBackend child-env
//      inheritance + the secret redactor.
//
//   2. requiredCredentialNames(agent) — env names the REGISTRY explicitly
//      declares as REQUIRED (provider.apiKeyEnv / legacy --api-key-env). Only
//      these participate in the credential-missing gate.
//
// This is the single source: backend inheritance (src/backends/*) and
// readiness assessment (src/application/credentialReadiness.js) both delegate
// here. There is no second mirrored algorithm. Lives at src root (like
// secretRedaction.js) so both the backend layer and the application layer may
// import it without an inverted dependency.
//
// Rule: a static backend-wide key list is NEVER assumed required. Codex may use
// logged-in auth; a backend's API key may be optional. Required = only what the
// registry explicitly declares.

// Per-backend OPTIONAL inherited env names (the full set a backend MAY inherit).
// claude-code derives its names per-agent from provider/legacy args, so it has
// no static list here (null). opencode-serve is HTTP-backed (no process creds).
const INHERITED_ENV_NAMES = {
  "claude-code": null,
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
  "kimi-code": ["KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_MODEL_NAME"],
  "opencode-serve": [],
};

/**
 * Explicitly-declared REQUIRED credential env names for an agent.
 * Only provider.apiKeyEnv and legacy --api-key-env count. A static backend-wide
 * list is NEVER assumed required.
 * @param {object} agent — normalized agent from registry
 * @returns {string[]} required credential env names (deduped, may be empty)
 */
export function requiredCredentialNames(agent) {
  if (!agent || typeof agent !== "object") return [];
  // Only claude-code declares required creds via the registry today.
  if (agent.backend !== "claude-code") return [];
  const names = [];
  const configured = agent.provider?.apiKeyEnv;
  if (typeof configured === "string" && configured.length > 0) names.push(configured);
  const prependArgs = Array.isArray(agent.prependArgs) ? agent.prependArgs : [];
  const idx = prependArgs.indexOf("--api-key-env");
  if (idx >= 0 && idx + 1 < prependArgs.length && prependArgs[idx + 1]) {
    names.push(prependArgs[idx + 1]);
  }
  return [...new Set(names)];
}

/**
 * All env names a backend MAY inherit into the worker child process: required
 * credential names plus optional backend-wide names. Used by ProcessBackend for
 * child-env inheritance + the secret redactor. Missing optional names never
 * block dispatch.
 * @param {object} agent — normalized agent from registry
 * @returns {string[]} inherited env names (deduped, may be empty)
 */
export function inheritedEnvNames(agent) {
  if (!agent || typeof agent !== "object") return [];
  const backend = agent.backend;
  const names = new Set(requiredCredentialNames(agent));
  const staticNames = INHERITED_ENV_NAMES[backend];
  if (Array.isArray(staticNames)) {
    for (const n of staticNames) if (typeof n === "string" && n.length > 0) names.add(n);
  }
  return [...names];
}
