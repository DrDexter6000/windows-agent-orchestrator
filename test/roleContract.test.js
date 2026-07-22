// test/roleContract.test.js
//
// M11-5: Worker Role Contract Parity — TDD tests.
//
// Proves that a configured `agent.systemPrompt` (role contract) is loaded by
// a shared, backend-neutral loader, validated before transcript/spawn, and
// delivered exactly once to each process backend (claude-code / codex /
// kimi-code) without leaking into the transcript or letting the Lead/model
// override it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadRoleContract } from "../src/application/roleContract.js";
import { ClaudeCodeBackend } from "../src/backends/claudeCode.js";
import { CodexBackend } from "../src/backends/codex.js";
import { KimiCodeBackend } from "../src/backends/kimiCode.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function writeRole(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

// Access the buildArgs of a backend via the stored instance property.
function getBuildArgs(backend) {
  return backend.buildArgs.bind(backend);
}

// ===== A. Shared loader =====

// ---------------------------------------------------------------------
// A1: valid role contract loads (regular file, strict UTF-8, non-empty,
//     no NUL, ≤4096 bytes).
// ---------------------------------------------------------------------
test("M11-5-A1: loadRoleContract returns content for a valid role file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a1-"));
  try {
    const p = writeRole(dir, "role.md", "You are a tester. 只验证不修 bug.\n");
    const rc = loadRoleContract(p);
    assert.equal(rc, "You are a tester. 只验证不修 bug.\n");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A2: fail closed — missing file.
// ---------------------------------------------------------------------
test("M11-5-A2: loadRoleContract throws on missing file (no spawn, no transcript)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a2-"));
  try {
    const missing = join(dir, "does-not-exist.md");
    assert.throws(() => loadRoleContract(missing), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A3: fail closed — directory (not a regular file).
// ---------------------------------------------------------------------
test("M11-5-A3: loadRoleContract throws on directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a3-"));
  try {
    assert.throws(() => loadRoleContract(dir), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A4: fail closed — empty file.
// ---------------------------------------------------------------------
test("M11-5-A4: loadRoleContract throws on empty file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a4-"));
  try {
    const p = writeRole(dir, "empty.md", "");
    assert.throws(() => loadRoleContract(p), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A5: fail closed — exceeds 4096 bytes.
// ---------------------------------------------------------------------
test("M11-5-A5: loadRoleContract throws on file > 4096 bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a5-"));
  try {
    const p = writeRole(dir, "big.md", "x".repeat(4097));
    assert.throws(() => loadRoleContract(p), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A6: fail closed — illegal UTF-8.
// ---------------------------------------------------------------------
test("M11-5-A6: loadRoleContract throws on illegal UTF-8", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a6-"));
  try {
    const p = join(dir, "bad-utf8.md");
    // 0xFF is not valid UTF-8.
    writeFileSync(p, Buffer.from([0xFF, 0xFE, 0x41]));
    assert.throws(() => loadRoleContract(p), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A7: fail closed — contains NUL byte.
// ---------------------------------------------------------------------
test("M11-5-A7: loadRoleContract throws on NUL byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a7-"));
  try {
    const p = writeRole(dir, "nul.md", "before\x00after");
    assert.throws(() => loadRoleContract(p), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A8: 4096-byte boundary — exactly 4096 bytes is OK.
// ---------------------------------------------------------------------
test("M11-5-A8: loadRoleContract accepts exactly 4096 bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a8-"));
  try {
    const p = writeRole(dir, "max.md", "x".repeat(4096));
    const rc = loadRoleContract(p);
    assert.equal(rc.length, 4096);
  } finally {
    cleanupDir(dir);
  }
});

// ===== B. Backend transport =====

// ---------------------------------------------------------------------
// B1: claude-code uses --append-system-prompt-file exactly once when role is
//     present; task prompt is NOT concatenated with role.
// ---------------------------------------------------------------------
test("M11-5-B1: claude-code buildArgs uses --append-system-prompt-file once, task not concatenated", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-b1-"));
  try {
    const rolePath = writeRole(dir, "role.md", "ROLE_MARKER_CLAUDE");
    const backend = new ClaudeCodeBackend();
    const buildArgs = getBuildArgs(backend);
    const agent = {};
    // claude uses roleContractPath (loader-validated path), not content.
    const task = { prompt: "TASK_MARKER", roleContractPath: rolePath };
    const args = buildArgs(agent, task);
    const flagIdx = args.indexOf("--append-system-prompt-file");
    assert.ok(flagIdx >= 0, "has --append-system-prompt-file");
    // exactly once
    assert.equal(args.filter((a) => a === "--append-system-prompt-file").length, 1, "flag exactly once");
    // the path follows the flag
    assert.equal(args[flagIdx + 1], rolePath, "role path follows the flag");
    // task prompt present as its own arg, not concatenated with role
    assert.ok(args.includes("TASK_MARKER"), "task prompt is its own arg");
    // no arg contains the role content inline (it goes via the file flag)
    assert.ok(!args.some((a) => typeof a === "string" && a.includes("ROLE_MARKER_CLAUDE")),
      "role content not inlined into args (delivered via file)");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// B2: codex uses -c developer_instructions=<role> exactly once; task is a
//     separate positional arg; never uses model_instructions_file.
// ---------------------------------------------------------------------
test("M11-5-B2: codex buildArgs uses -c developer_instructions once, task separate, no model_instructions_file", () => {
  const backend = new CodexBackend();
  const buildArgs = getBuildArgs(backend);
  const agent = {};
  const task = { prompt: "TASK_MARKER", roleContract: "ROLE_MARKER_CODEX" };
  const args = buildArgs(agent, task);
  // -c developer_instructions=<role> present (-c and its value are separate args)
  assert.ok(args.includes("-c"), "has -c flag");
  const devInstr = args.find((a) => typeof a === "string" && a.includes("developer_instructions"));
  assert.ok(devInstr, "has developer_instructions value");
  // contains the role content
  assert.ok(devInstr.includes("ROLE_MARKER_CODEX"), "developer_instructions carries role content");
  // exactly once
  assert.equal(args.filter((a) => typeof a === "string" && a.includes("developer_instructions")).length, 1,
    "developer_instructions exactly once");
  // task prompt present as its own positional arg, NOT concatenated into developer_instructions
  assert.ok(args.includes("TASK_MARKER"), "task prompt is a separate positional arg");
  // never model_instructions_file
  assert.ok(!args.some((a) => typeof a === "string" && a.includes("model_instructions_file")),
    "never uses model_instructions_file");
});

// ---------------------------------------------------------------------
// B2b: codex multi-line role contract — TOML escaping covers newline/CR/tab
//      (reviewer round 1 found single-line-only test missed multi-line bug).
// ---------------------------------------------------------------------
test("M11-5-B2b: codex multi-line role contract — newline/CR/tab escaped for valid TOML", () => {
  const backend = new CodexBackend();
  const buildArgs = getBuildArgs(backend);
  // Realistic multi-line role (Markdown, like config/roles/*.md).
  const role = "You are a tester.\nOnly verify, never fix bugs.\r\nTab:\there\nMARKER_MULTI_LINE";
  const args = buildArgs({}, { prompt: "do task", roleContract: role });
  const devInstr = args.find((a) => typeof a === "string" && a.includes("developer_instructions"));
  assert.ok(devInstr, "has developer_instructions");
  // The value must be a valid TOML basic string: no raw newlines/CR/tab inside quotes.
  // Extract the quoted value.
  const match = devInstr.match(/developer_instructions="(.*)"$/);
  assert.ok(match, "developer_instructions value is quoted");
  const value = match[1];
  // No raw newline/CR inside the TOML string (they must be escaped as \n / \r).
  assert.ok(!value.includes("\n"), "no raw newline in TOML value (escaped)");
  assert.ok(!value.includes("\r"), "no raw CR in TOML value (escaped)");
  assert.ok(!value.includes("\t"), "no raw tab in TOML value (escaped)");
  // The escaped forms ARE present.
  assert.ok(value.includes("\\n"), "newline escaped to \\n");
  assert.ok(value.includes("\\r"), "CR escaped to \\r");
  assert.ok(value.includes("\\t"), "tab escaped to \\t");
  // The marker survived the round-trip.
  assert.ok(value.includes("MARKER_MULTI_LINE"), "role marker survived escaping");
});

// ---------------------------------------------------------------------
// B3: kimi-code combines role + task with fixed delimiter; role first,
//     task second, each exactly once.
// ---------------------------------------------------------------------
test("M11-5-B3: kimi-code buildArgs combines role+task, role first, task second, each once", () => {
  const backend = new KimiCodeBackend();
  const buildArgs = getBuildArgs(backend);
  const agent = {};
  const task = { prompt: "TASK_MARKER", roleContract: "ROLE_MARKER_KIMI" };
  const args = buildArgs(agent, task);
  // find the combined prompt arg (the one containing both)
  const combined = args.find((a) => typeof a === "string" && a.includes("ROLE_MARKER_KIMI") && a.includes("TASK_MARKER"));
  assert.ok(combined, "role and task combined into one prompt arg");
  // role before task
  assert.ok(combined.indexOf("ROLE_MARKER_KIMI") < combined.indexOf("TASK_MARKER"),
    "role appears before task");
  // each exactly once
  assert.equal(combined.split("ROLE_MARKER_KIMI").length - 1, 1, "role exactly once");
  assert.equal(combined.split("TASK_MARKER").length - 1, 1, "task exactly once");
});

// ---------------------------------------------------------------------
// B4: no roleContract → all three backends behave identically to legacy
//     (argv unchanged, no role-related flags).
// ---------------------------------------------------------------------
test("M11-5-B4: no roleContract → all three backends legacy-compatible argv", () => {
  for (const BackendClass of [ClaudeCodeBackend, CodexBackend, KimiCodeBackend]) {
    const backend = new BackendClass();
    const buildArgs = getBuildArgs(backend);
    const agent = {};
    const task = { prompt: "JUST_TASK" };
    const args = buildArgs(agent, task);
    // no role-related flags
    assert.ok(!args.some((a) => typeof a === "string" && a.includes("append-system-prompt")),
      `${BackendClass.name}: no --append-system-prompt when no role`);
    assert.ok(!args.some((a) => typeof a === "string" && a.includes("developer_instructions")),
      `${BackendClass.name}: no developer_instructions when no role`);
    // task prompt still present
    assert.ok(args.some((a) => a === "JUST_TASK" || (typeof a === "string" && a.includes("JUST_TASK"))),
      `${BackendClass.name}: task prompt present`);
  }
});

// ---------------------------------------------------------------------
// B5: claude-code no longer silently ignores a missing role file when
//     systemPrompt is configured — it must fail (the loader validates
//     earlier, so buildArgs receives a guaranteed-valid roleContract, but
//     the old existsSync-skip logic must be gone).
// ---------------------------------------------------------------------
test("M11-5-B5: claude-code buildArgs has no existsSync-skip branch for systemPrompt", () => {
  // Read the source and confirm the silent-skip pattern is removed.
  const src = readFileSync(resolve(process.cwd(), "src/backends/claudeCode.js"), "utf8");
  // The old pattern: if (existsSync(p)) { push file flag }
  // New pattern must NOT silently skip — roleContract comes from the loader.
  assert.ok(!/if\s*\(\s*existsSync\s*\(\s*p\s*\)\s*\)/.test(src),
    "claudeCode.js no longer has 'if (existsSync(p))' silent-skip branch");
});

// ===== C. Security: no override, no leak, resume parity =====

// ---------------------------------------------------------------------
// C1: MCP run_dispatch input schema is strict and does NOT accept any role
//     override (systemPrompt / roleContract / rolePath). The Lead/model
//     cannot override the registry-selected role.
// ---------------------------------------------------------------------
test("M11-5-C1: MCP run_dispatch schema rejects role override keys", async () => {
  const { createWaoMcpServer } = await import("../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-c1-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      // Attempt to override role via extra keys — schema is strict, must reject.
      for (const bad of [
        { agentId: "w", prompt: "x", systemPrompt: "evil" },
        { agentId: "w", prompt: "x", roleContract: "evil" },
        { agentId: "w", prompt: "x", rolePath: "evil" },
      ]) {
        const res = await client.callTool({ name: "run_dispatch", arguments: bad });
        // Strict schema rejects → isError (SDK validation error collapsed to safe text).
        assert.ok(res.isError, `rejected role override attempt: ${JSON.stringify(Object.keys(bad))}`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// C2: role content never enters the transcript. RunManager persists only
//     the original task prompt in prompt.sent; roleContract is passed to
//     the backend out-of-band. Verified by source inspection (the contract
//     is structural, not a one-off runtime check).
// ---------------------------------------------------------------------
test("M11-5-C2: RunManager source never persists roleContract to transcript", () => {
  const src = readFileSync(resolve(process.cwd(), "src/runManager.js"), "utf8");
  // transcript.append calls must not carry roleContract/roleContractPath.
  // Find every transcript.append call and assert none mention roleContract.
  const appendCalls = src.match(/transcript\.append\([^)]+\)/g) || [];
  assert.ok(appendCalls.length > 0, "found transcript.append calls to inspect");
  for (const call of appendCalls) {
    assert.ok(!/roleContract/i.test(call),
      `transcript.append must not carry roleContract: ${call.slice(0, 80)}`);
  }
});

// ---------------------------------------------------------------------
// C3: resume path also loads roleContract (source guard). The resume spawn
//     call must pass roleContract/roleContractPath, not just prompt.
// ---------------------------------------------------------------------
test("M11-5-C3: resume spawn call passes roleContract (no bypass)", () => {
  const src = readFileSync(resolve(process.cwd(), "src/runManager.js"), "utf8");
  // The resume spawn block must reference loadRoleContract and pass it.
  assert.ok(/resumeRoleContract\s*=\s*loadRoleContract/.test(src),
    "resume path calls loadRoleContract");
  // The resume backend.spawn call must include roleContract.
  assert.ok(/backend\.spawn\([^)]*roleContract:\s*resumeRoleContract/s.test(src),
    "resume backend.spawn passes roleContract");
});
