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

// C0 control chars except TAB (0x09), LF (0x0A), CR (0x0D); plus DEL (0x7F)
// and C1 (0x80-0x9F). These are rejected because they break downstream
// TOML/argv/JSON parsers and carry no legitimate role-contract semantics.
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

/**
 * Load and validate a role contract file.
 *
 * @param {string} rolePath — path from agent.systemPrompt (registry-owned)
 * @returns {string} the validated, non-empty role contract content (UTF-8)
 * @throws {Error} on any malformation (missing, directory, empty, >4096 bytes,
 *                 illegal UTF-8, NUL byte, unsafe control chars). Error message
 *                 is a fixed safe shape — never includes role content or the
 *                 absolute path.
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

  // Read raw bytes.
  let raw;
  try {
    raw = readFileSync(rolePath);
  } catch {
    throw new Error("role contract file is unreadable");
  }
  // CTO rework: check actual byte count, not stat.size (which may differ
  // on some filesystems). This is the authoritative cap.
  if (raw.length > ROLE_CONTRACT_MAX_BYTES) {
    throw new Error(`role contract exceeds ${ROLE_CONTRACT_MAX_BYTES} bytes`);
  }

  // Strict UTF-8 decode: TextDecoder with fatal=true rejects illegal sequences
  // instead of silently replacing them with U+FFFD.
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Error("role contract is not valid UTF-8");
  }

  // Non-empty after trim (a whitespace-only file carries no contract).
  if (text.length === 0 || text.trim().length === 0) {
    throw new Error("role contract is empty");
  }
  // Reject unsafe control characters (C0 except TAB/LF/CR, DEL, C1).
  // NUL is included in this range — defends downstream TOML/argv/JSON parsers.
  if (UNSAFE_CONTROL_RE.test(text)) {
    throw new Error("role contract contains unsafe control characters");
  }

  return text;
}
