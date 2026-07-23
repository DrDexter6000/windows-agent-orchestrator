// src/application/credentialReadiness.js
//
// M11-7 (CTO closeout): Worker credential availability + Windows user-env bridge.
//
// Assesses whether a worker's REQUIRED credentials (registry-declared via
// provider.apiKeyEnv / legacy --api-key-env) are available in the launching
// environment, and bridges values from the Windows Current-User scope into the
// worker child process when they are absent from process.env.
//
// Env-name policy (which names are required vs optional-inherited) is the
// runtime-neutral SSOT in src/envPolicy.js — this module delegates to it. There
// is no mirrored algorithm here or in src/backends/*.
//
// Credential resolution precedence:
//   1. process.env (the WAO process environment).
//   2. Windows Current-User environment (HKCU\Environment).
//   3. missing.
//
// No permanent cache: each operation de-duplicates by name within itself, but
// the NEXT registry_list/dispatch re-observes current state — so setting or
// rotating a credential takes effect without restarting the Host.
//
// Security contract:
//   - Only the EXACT declared names are read from the user scope. No bulk
//     import of the user environment.
//   - No credential VALUE enters argv, logs, errors, transcript, or MCP output.
//     Values flow only into the worker child env + the secret redactor.
//   - Structured argv (base64-encoded PowerShell command); injectable reader.
//
// Honesty: this module only proves a CREDENTIAL blocker, not that the runtime
// is executable/logged-in/provider-healthy. The field is named
// credentialAvailability, not "runtime readiness".
//
// Architectural contract: no src/mcp/*, src/commands/*, MCP SDK, or zod imports.

import { execFile } from "node:child_process";
import { requiredCredentialNames, inheritedEnvNames } from "../envPolicy.js";

/**
 * Re-export the env-name policy SSOT for convenience/compat.
 * requiredCredentialNames: registry-declared REQUIRED names (gate participants).
 * inheritedEnvNames: all names a backend MAY inherit (required + optional).
 */
export { requiredCredentialNames, inheritedEnvNames };

/**
 * Default Windows user-env reader. Reads ONE exact name from the Current-User
 * scope via PowerShell `[System.Environment]::GetEnvironmentVariable`. Structured
 * argv (no shell string). On non-Windows or any failure → undefined.
 *
 * NOT permanently cached: a fresh value is read on every call so credential
 * rotation / addition takes effect without a Host restart. Callers de-duplicate
 * within a single operation (assessWorkerReadiness) to avoid re-reading the same
 * name twice in one assessment.
 * @param {string} name
 * @returns {Promise<string|undefined>}
 */
export function readWindowsUserEnv(name) {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  if (typeof name !== "string" || name.length === 0) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const script = `[System.Environment]::GetEnvironmentVariable('${name.replace(/'/g, "''")}', 'User')`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(undefined);
        const value = (stdout ?? "").replace(/\r?\n$/, "");
        resolve(value.length > 0 ? value : undefined);
      },
    );
  });
}

/**
 * Resolve a single env var: process.env first, then Windows user env.
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
 * Assess a single worker's CREDENTIAL availability (not full runtime health).
 * - "available": all REQUIRED declared credentials resolve (process.env or user env).
 * - "missing":  at least one REQUIRED credential is absent.
 * - "not_required": the worker declares no required credential (no gate applies).
 *
 * resolvedEnv carries ALL inherited names that resolved (required + optional)
 * for the ProcessBackend to inject into the child env + redactor. It MUST NOT
 * be logged/serialized.
 *
 * Within one call, each name is read at most once (operation-scoped de-dupe);
 * the NEXT call re-observes current state (no permanent cache). readerCallCount
 * is returned so tests can assert no duplicate reads.
 * @param {{ agent: object, userEnvReader?: (name: string) => Promise<string|undefined> }} input
 * @returns {Promise<{ credentialAvailability: "available"|"missing"|"not_required", missingCredentialEnvNames: string[], resolvedEnv: Record<string,string>, readerCallCount: number }>}
 */
export async function assessWorkerReadiness({ agent, userEnvReader }) {
  const required = requiredCredentialNames(agent);
  const inherited = inheritedEnvNames(agent);
  const resolvedEnv = {};
  const missing = [];
  const seen = new Set(); // operation-scoped de-dupe
  let readerCallCount = 0;
  const reader = userEnvReader ?? readWindowsUserEnv;
  const wrappedReader = async (name) => {
    readerCallCount += 1;
    return reader(name);
  };
  for (const name of inherited) {
    if (seen.has(name)) continue;
    seen.add(name);
    const r = await resolveCredentialEnv(name, { userEnvReader: wrappedReader });
    if (typeof r.value === "string") resolvedEnv[name] = r.value;
    // Only REQUIRED names participate in the missing gate.
    if (required.includes(name) && r.source === "missing") missing.push(name);
  }
  const credentialAvailability = required.length === 0
    ? "not_required"
    : (missing.length > 0 ? "missing" : "available");
  return { credentialAvailability, missingCredentialEnvNames: missing, resolvedEnv, readerCallCount };
}
