// src/application/roleContract.js
//
// M11-5: Shared, backend-neutral role contract loader.
//
// WAO lets a Lead write only the concrete task; the registry's per-agent
// `systemPrompt` (a path to a role contract file) is loaded here, validated,
// and delivered to each process backend exactly once. The Lead/model cannot
// override or bypass the registry-selected role contract.
//
// Architectural contract:
//   - No spawn, no transcript writes, no MCP/CLI/command imports.
//   - Validates BEFORE RunManager creates the transcript or spawns the backend.
//   - Fail-closed on every malformation: missing, directory, empty, >4096
//     bytes, illegal UTF-8, NUL byte. Zero role content or absolute path in
//     the error (the error is a fixed safe shape).
//   - Returns the validated role contract STRING (the file content). Callers
//     (RunManager) pass it to backend.spawn as task.roleContract; the
//     transcript persists only the original task prompt, never the role
//     content or the combined prompt.
//
// Why a string (not a path): the three backends consume the role differently
// (claude: writes a temp file + --append-system-prompt-file; codex: inlines
// into -c developer_instructions; kimi: concatenates into the prompt). Keeping
// the loader path-free and returning content lets each backend choose its
// transport without the loader branching on runtime.

import { readFileSync, statSync } from "node:fs";

/** Maximum acceptable role contract size (bytes). */
export const ROLE_CONTRACT_MAX_BYTES = 4096;

/**
 * Load and validate a role contract file.
 *
 * @param {string} rolePath — path from agent.systemPrompt (registry-owned)
 * @returns {string} the validated, non-empty role contract content (UTF-8)
 * @throws {Error} on any malformation (missing, directory, empty, >4096 bytes,
 *                 illegal UTF-8, NUL byte). Error message is a fixed safe
 *                 shape — never includes role content or the absolute path.
 */
export function loadRoleContract(rolePath) {
  if (typeof rolePath !== "string" || rolePath.length === 0) {
    throw new Error("role contract path is required");
  }

  // Stat first to reject directories and missing files with a clear boundary.
  let st;
  try {
    st = statSync(rolePath);
  } catch {
    throw new Error("role contract file is missing or unreadable");
  }
  if (!st.isFile()) {
    throw new Error("role contract path is not a regular file");
  }
  if (st.size > ROLE_CONTRACT_MAX_BYTES) {
    throw new Error(`role contract exceeds ${ROLE_CONTRACT_MAX_BYTES} bytes`);
  }

  // Read raw bytes, then strict UTF-8 decode. Buffer.toString("utf8") silently
  // replaces illegal sequences with U+FFFD — we must reject, not mask.
  let raw;
  try {
    raw = readFileSync(rolePath);
  } catch {
    throw new Error("role contract file is unreadable");
  }
  // Strict UTF-8 validation: decode + re-encode + compare byte length.
  const text = raw.toString("utf8");
  if (Buffer.from(text, "utf8").length !== raw.length) {
    throw new Error("role contract is not valid UTF-8");
  }

  // Non-empty after trim (a whitespace-only file carries no contract).
  if (text.length === 0 || text.trim().length === 0) {
    throw new Error("role contract is empty");
  }
  // NUL byte rejects (defends downstream TOML/argv/JSON parsers).
  if (text.includes("\0")) {
    throw new Error("role contract contains a NUL byte");
  }

  return text;
}
