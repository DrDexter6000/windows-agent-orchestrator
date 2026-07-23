// src/application/credentialReadiness.js
//
// M11-7: Worker runtime readiness + credential env resolution.
//
// A worker's `certification` (from reliability-summary.json) records a HISTORICAL
// reliability result — it does NOT mean the worker can start right now. A worker
// is only runtime-ready when the credentials its backend needs are actually
// available in the launching environment. This module resolves registry-declared
// credential env names and checks their availability, so registry_list can show
// `runtimeAvailability` and run_dispatch can fail BEFORE transcript/fork when a
// worker would crash on startup for lack of a credential.
//
// Credential resolution precedence:
//   1. process.env (the WAO process environment — what the MCP server / daemon
//      inherited).
//   2. Windows Current-User environment (the HKCU\Environment scope) — a
//      fallback so a worker still starts when the Owner configured the key at
//      the User scope but the launching process did not inherit it.
//   3. missing.
//
// Security contract:
//   - Only the EXACT registry-declared env NAMES are read from the user scope.
//     There is NO bulk import of the user environment.
//   - No credential VALUE ever enters argv, logs, errors, transcript, or MCP
//     output. Values are resolved into the worker child env (ProcessBackend)
//     and into the secret redactor only.
//   - The Windows user-env reader uses structured argv (no shell string
//     concatenation). It is injectable for testing.
//
// Architectural contract:
//   - Does NOT import src/mcp/*, src/commands/*, MCP SDK, or zod.
//   - Read-only (env probes); never writes/rotates credentials, never installs
//     or fixes external runtimes, never modifies Host/global config.

import { execFile } from "node:child_process";

// Per-backend credential env-name resolution. This mirrors the per-backend
// credentialEnvNames() functions in src/backends/* (claude-code derives from
// provider.apiKeyEnv / legacy --api-key-env; codex/kimi are static). Kept here
// as the application-layer SSOT for readiness so registry_list and run_dispatch
// agree without importing the backend classes.
const STATIC_CREDENTIAL_NAMES = {
  codex: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
  "kimi-code": ["KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_MODEL_NAME"],
};

/**
 * Resolve the registry-declared credential env names a worker needs.
 * @param {object} agent — normalized agent from registry
 * @returns {string[]} env var names (deduped, may be empty)
 */
export function resolveWorkerCredentialNames(agent) {
  if (!agent || typeof agent !== "object") return [];
  const backend = agent.backend;
  // claude-code: provider.apiKeyEnv (first-class) or legacy --api-key-env.
  if (backend === "claude-code") {
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
  if (Array.isArray(STATIC_CREDENTIAL_NAMES[backend])) return [...STATIC_CREDENTIAL_NAMES[backend]];
  // opencode-serve and unknown backends: no process credential names.
  return [];
}

/**
 * Default Windows user-env reader. Reads ONE exact name from the Current-User
 * scope via PowerShell `[System.Environment]::GetEnvironmentVariable`. Uses
 * structured argv (no shell string). On non-Windows or any failure → undefined.
 *
 * Per-process memoized: each requested name is read at most ONCE per process
 * (the user environment does not change during a process's lifetime). This
 * bounds PowerShell spawns to the number of distinct credential names, not the
 * number of inventory/dispatch calls — keeping registry_list cheap.
 * @param {string} name
 * @returns {Promise<string|undefined>}
 */
const _userEnvCache = new Map();
export function readWindowsUserEnv(name) {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  if (typeof name !== "string" || name.length === 0) return Promise.resolve(undefined);
  if (_userEnvCache.has(name)) return Promise.resolve(_userEnvCache.get(name));
  return new Promise((resolve) => {
    // Structured argv: powershell -NoProfile -Command <script>. The name is
    // passed as a base64-encoded command argument to avoid any shell injection
    // through the variable name; the script reads exactly that one name.
    const script = `[System.Environment]::GetEnvironmentVariable('${name.replace(/'/g, "''")}', 'User')`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) {
          _userEnvCache.set(name, undefined);
          return resolve(undefined);
        }
        const value = (stdout ?? "").replace(/\r?\n$/, "");
        const resolved = value.length > 0 ? value : undefined;
        _userEnvCache.set(name, resolved);
        resolve(resolved);
      },
    );
  });
}

/**
 * Resolve a single credential env var: process.env first, then Windows user env.
 * @param {string} name
 * @param {{ userEnvReader?: (name: string) => Promise<string|undefined> }} [opts]
 * @returns {Promise<{ name: string, source: "process_env"|"user_env"|"missing", value: string|undefined }>}
 */
export async function resolveCredentialEnv(name, opts = {}) {
  const procValue = process.env[name];
  if (typeof procValue === "string" && procValue.length > 0) {
    return { name, source: "process_env", value: procValue };
  }
  const reader = opts.userEnvReader ?? readWindowsUserEnv;
  try {
    const userValue = await reader(name);
    if (typeof userValue === "string" && userValue.length > 0) {
      return { name, source: "user_env", value: userValue };
    }
  } catch {
    // reader failure → treat as missing (never surface the value or error).
  }
  return { name, source: "missing", value: undefined };
}

/**
 * A sentinel value used in tests to prove a credential value never appears in
 * any projection. Not a real credential.
 */
export const CREDENTIAL_SENTINEL = "M117_CREDENTIAL_SENTINEL_VALUE";

/**
 * Assess a single worker's runtime readiness.
 * @param {{ agent: object, userEnvReader?: (name: string) => Promise<string|undefined> }} input
 * @returns {Promise<{ runtimeAvailability: "ready"|"credential_missing", missingCredentialEnvNames: string[], resolvedEnv: Record<string,string> }>}
 *   resolvedEnv carries the resolved credential VALUES for the ProcessBackend
 *   to inject into the child env + redactor. It MUST NOT be logged/serialized.
 */
export async function assessWorkerReadiness({ agent, userEnvReader }) {
  const names = resolveWorkerCredentialNames(agent);
  const missing = [];
  const resolvedEnv = {};
  for (const name of names) {
    const r = await resolveCredentialEnv(name, { userEnvReader });
    if (r.source === "missing") {
      missing.push(name);
    } else if (typeof r.value === "string") {
      resolvedEnv[name] = r.value;
    }
  }
  return {
    runtimeAvailability: missing.length > 0 ? "credential_missing" : "ready",
    missingCredentialEnvNames: missing,
    resolvedEnv,
  };
}
