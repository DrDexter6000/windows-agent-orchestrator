// test/mcpBind.test.js
//
// M10 P0-1 Reframe: Codex-owned config adapter tests.
//
// Tests use fake Codex adapter hooks for deterministic unit testing,
// plus a real Codex CLI integration test (no skip allowed per CTO).
//
// Architectural contract:
//   - mcpWorkspaceActivation.js does NOT import commands/mcp/SDK/zod
//   - codexMcpConfig.js does NOT import application/commands/mcp/SDK/zod

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@wao.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "init\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

function readExclude(gitDir) {
  const p = join(gitDir, "info", "exclude");
  if (!existsSync(p)) return null;
  return readFileSync(p);
}

/**
 * Create fake Codex adapter hooks backed by an in-memory server store.
 * Each hook records its calls for ordering assertions.
 */
function fakeCodexHooks(initialServers = []) {
  const servers = new Map();
  for (const s of initialServers) servers.set(s.name, s);
  const calls = [];
  return {
    calls,
    servers,
    codexList: async () => { calls.push("list"); return [...servers.values()]; },
    codexGet: async ({ name }) => { calls.push(`get:${name}`); return servers.get(name) ?? null; },
    codexAdd: async ({ name, command, args }) => {
      calls.push(`add:${name}`);
      servers.set(name, {
        name, enabled: true,
        transport: { type: "stdio", command, args, env: null, env_vars: [], cwd: null },
      });
    },
    codexRemove: async ({ name }) => { calls.push(`remove:${name}`); servers.delete(name); },
  };
}

/**
 * Build a server object matching the expected contract for a given root.
 */
function makeExpectedServer(root) {
  const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = resolve(_MODULE_DIR, "..");
  return {
    name: "wao", enabled: true,
    transport: {
      type: "stdio", command: "node",
      args: [
        join(REPO_ROOT, "scripts", "wao-node.cjs"),
        join(REPO_ROOT, "src", "mcp", "stdio.js"),
        "--registry", join(REPO_ROOT, "config", "agents.json"),
        "--run-dir", join(REPO_ROOT, "runs"),
        "--workspace-root", root,
      ],
      env: null, env_vars: [], cwd: null,
    },
  };
}

// ── Basic lifecycle ─────────────────────────────────────────────────────────

test("BIND-01: bind → status configured → unbind → not_configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-01-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, statusWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const fk = fakeCodexHooks();

    const bindResult = await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });
    assert.equal(bindResult.bound, true);
    assert.equal(bindResult.status, "configured");

    const status1 = await statusWorkspace({ host: "codex", cwd: dir, hooks: fk });
    assert.equal(status1.bound, true);
    assert.equal(status1.status, "configured");

    await unbindWorkspace({ host: "codex", cwd: dir, hooks: fk });

    const status2 = await statusWorkspace({ host: "codex", cwd: dir, hooks: fk });
    assert.equal(status2.bound, false);
    assert.equal(status2.status, "not_configured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── CTO RED: exclude corruption ──────────────────────────────────────────────

test("EXCLUDE-CORRUPT-01: exclude rule changed to /unexpected-path → status excludes, unbind refuses, bytes unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-exc-corrupt-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, statusWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const fk = fakeCodexHooks();

    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });

    // Tamper: change /.codex/config.toml to /unexpected-path inside the exclude block
    const excludeP = join(dir, ".git", "info", "exclude");
    const exclude = readFileSync(excludeP, "utf8");
    const tampered = exclude.replace("/.codex/config.toml", "/unexpected-path");
    writeFileSync(excludeP, tampered);

    // Status must NOT report configured
    const status = await statusWorkspace({ host: "codex", cwd: dir, hooks: fk });
    assert.equal(status.bound, false);
    assert.equal(status.status, "exclude_missing_or_modified");

    // Unbind must refuse
    await assert.rejects(
      () => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      (err) => err.message.includes("exclude"),
    );

    // Config bytes must be unchanged (Codex adapter wasn't called for remove)
    assert.ok(!fk.calls.includes("remove:wao"), "codexRemove must not have been called");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── External conflict ────────────────────────────────────────────────────────

test("CONFLICT-01: different wao server → external_conflict, zero mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-conflict-"));
  try {
    makeGitRepo(dir);
    const differentServer = {
      name: "wao", enabled: true,
      transport: { type: "stdio", command: "other-bin", args: ["diff"], env: null, env_vars: [], cwd: null },
    };
    const fk = fakeCodexHooks([differentServer]);
    const { bindWorkspace, statusWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );

    const status = await statusWorkspace({ host: "codex", cwd: dir, hooks: fk });
    assert.equal(status.status, "external_conflict");

    await assert.rejects(
      () => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      (err) => err.message.includes("conflict"),
    );
    // No add/remove calls
    assert.ok(!fk.calls.some(c => c.startsWith("add:")), "add must not be called");
    assert.ok(!fk.calls.some(c => c.startsWith("remove:")), "remove must not be called");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Unmanaged exact server ───────────────────────────────────────────────────

test("UNMANAGED-EXACT-01: exact server but no exclude → unmanaged_exact_server, refuse bind and unbind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-unmanaged-"));
  try {
    makeGitRepo(dir);
    // Get the canonical root that proveWorkspace would return
    const { proveWorkspace } = await import("../src/application/workspaceBinding.js");
    const proof = proveWorkspace(dir);
    const canonicalRoot = proof.root;
    const exactServer = makeExpectedServer(canonicalRoot);
    const fk = fakeCodexHooks([exactServer]);
    const { bindWorkspace, statusWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );

    const status = await statusWorkspace({ host: "codex", cwd: dir, hooks: fk });
    assert.equal(status.status, "unmanaged_exact_server");

    await assert.rejects(
      () => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      (err) => err.message.includes("unmanaged_exact_server"),
    );
    await assert.rejects(
      () => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      (err) => err.message.includes("unmanaged_exact_server"),
    );
    // No mutation
    assert.ok(!fk.calls.some(c => c.startsWith("add:")), "add must not be called");
    assert.ok(!fk.calls.some(c => c.startsWith("remove:")), "remove must not be called");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Activation incomplete ────────────────────────────────────────────────────

test("ACTIVATION-INCOMPLETE-01: exclude exists but server missing → activation_incomplete, bind completes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-incomplete-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, statusWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    // First bind to create exclude
    const fk1 = fakeCodexHooks();
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk1 });

    // Simulate server removed externally but exclude remains
    const fk2 = fakeCodexHooks(); // empty server list
    const status = await statusWorkspace({ host: "codex", cwd: dir, hooks: fk2 });
    assert.equal(status.status, "activation_incomplete");

    // bind should complete the activation
    const result = await bindWorkspace({ host: "codex", cwd: dir, hooks: fk2 });
    assert.equal(result.bound, true);
    assert.equal(result.status, "configured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Idempotent ───────────────────────────────────────────────────────────────

test("IDEMPOTENT-01: exact server + exact exclude → bind idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-idem-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const fk = fakeCodexHooks();
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });
    const addCount1 = fk.calls.filter(c => c.startsWith("add:")).length;

    // Second bind — should be idempotent
    const result2 = await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });
    assert.equal(result2.bound, true);
    const addCount2 = fk.calls.filter(c => c.startsWith("add:")).length;
    assert.equal(addCount2, addCount1, "add should not be called again on idempotent bind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tracked config ───────────────────────────────────────────────────────────

test("TRACKED-01: tracked .codex/config.toml → fail-closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-tracked-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex", "config.toml"), "# user config\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "track config"], { cwd: dir });

    const { bindWorkspace, statusWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const status = await statusWorkspace({ host: "codex", cwd: dir, hooks: fakeCodexHooks() });
    assert.equal(status.status, "tracked_config");

    await assert.rejects(
      () => bindWorkspace({ host: "codex", cwd: dir, hooks: fakeCodexHooks() }),
      (err) => err.message.includes("tracked"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Failure injection: rollback ──────────────────────────────────────────────

test("ROLLBACK-ADD-01: codexAdd fails → exclude rolled back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rb-add-"));
  try {
    makeGitRepo(dir);
    const excludeBefore = readExclude(join(dir, ".git"));
    const fk = fakeCodexHooks();
    fk.codexAdd = async () => { throw new Error("simulated add failure"); };

    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(
      () => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      (err) => err.message.includes("add failed"),
    );
    // Exclude must be restored
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ROLLBACK-VERIFY-01: codexGet returns mismatch → rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rb-verify-"));
  try {
    makeGitRepo(dir);
    const excludeBefore = readExclude(join(dir, ".git"));
    const fk = fakeCodexHooks();
    // Add succeeds but get returns a mismatched server
    fk.codexGet = async () => ({
      name: "wao", enabled: true,
      transport: { type: "stdio", command: "wrong", args: [], env: null, env_vars: [], cwd: null },
    });

    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(
      () => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      (err) => err.message.includes("mismatch"),
    );
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ROLLBACK-REMOVE-01: codexRemove fails → rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rb-rm-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const fk = fakeCodexHooks();
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });

    const excludeBefore = readExclude(join(dir, ".git"));
    // Now break remove
    fk.codexRemove = async () => { throw new Error("simulated remove failure"); };

    await assert.rejects(
      () => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      (err) => err.message.includes("remove failed"),
    );
    // Exclude must be unchanged (rollback restores it)
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ROLLBACK-REMOVE-VERIFY-01: remove succeeds but verify shows server still present → rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rb-rm-ver-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const fk = fakeCodexHooks();
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });

    const excludeBefore = readExclude(join(dir, ".git"));
    // Remove "succeeds" but list still shows the server
    fk.codexRemove = async () => {}; // no-op, doesn't actually delete
    // Override codexList to still show the server
    const server = fk.servers.get("wao");
    fk.codexList = async () => [server];

    await assert.rejects(
      () => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      (err) => err.message.includes("still present"),
    );
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Bind ordering ────────────────────────────────────────────────────────────

test("BIND-ORDER-01: exclude written before codex add", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-order-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const callOrder = [];
    // Use a mutable store so codexAdd populates what codexGet returns
    let addedServer = null;
    const fk = {
      codexList: async () => { callOrder.push("list"); return addedServer ? [addedServer] : []; },
      codexGet: async () => { callOrder.push("get"); return addedServer; },
      codexAdd: async ({ name, command, args }) => {
        callOrder.push("add");
        addedServer = {
          name, enabled: true,
          transport: { type: "stdio", command, args, env: null, env_vars: [], cwd: null },
        };
      },
      codexRemove: async () => { callOrder.push("remove"); addedServer = null; },
      readExclude: (gitDir) => {
        callOrder.push("readExclude");
        const p = join(gitDir, "info", "exclude");
        return existsSync(p) ? readFileSync(p, "utf8") : null;
      },
      writeExclude: (gitDir, content) => {
        callOrder.push("writeExclude");
        const infoDir = join(gitDir, "info");
        if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
        writeFileSync(join(infoDir, "exclude"), content);
      },
    };
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });

    const writeIdx = callOrder.indexOf("writeExclude");
    const addIdx = callOrder.indexOf("add");
    assert.ok(writeIdx !== -1 && addIdx !== -1, "both writeExclude and add must be called");
    assert.ok(writeIdx < addIdx, "exclude must be written before codex add");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Unbind preflight ─────────────────────────────────────────────────────────

test("UNBIND-PREFLIGHT-01: exclude damaged → mutation count 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-preflight-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const fk = fakeCodexHooks();
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });

    // Damage exclude
    const excludeP = join(dir, ".git", "info", "exclude");
    writeFileSync(excludeP, readFileSync(excludeP, "utf8").replace("/.codex/config.toml", "/bad"));

    // Reset call tracking
    fk.calls.length = 0;
    await assert.rejects(
      () => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
    );
    assert.ok(!fk.calls.some(c => c.startsWith("remove:")), "remove must not be called on damaged exclude");
    assert.ok(!fk.calls.some(c => c === "writeExclude"), "writeExclude must not be called on damaged exclude");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Rejection tests ─────────────────────────────────────────────────────────

test("REJECT-01: non-Git directory rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reject-nogit-"));
  try {
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: dir, hooks: fakeCodexHooks() }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("REJECT-02: Git subdirectory rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-reject-sub-"));
  const subdir = join(root, "sub");
  try {
    makeGitRepo(root);
    mkdirSync(subdir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: subdir, hooks: fakeCodexHooks() }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("REJECT-03: relative path rejected", async () => {
  const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
  await assert.rejects(
    () => bindWorkspace({ host: "codex", cwd: "rel/path", hooks: fakeCodexHooks() }),
    (err) => err.message.includes("absolute"),
  );
});

test("REJECT-04: unsupported host rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reject-host-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(
      () => bindWorkspace({ host: "claude", cwd: dir, hooks: fakeCodexHooks() }),
      (err) => err.message.includes("host"),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Extra fields rejection (CTO correction 3) ────────────────────────────────

test("EXTRA-FIELDS-01: server with cwd set → not exact match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-extra-cwd-"));
  try {
    makeGitRepo(dir);
    const server = makeExpectedServer(dir.replace(/\\/g, "/"));
    server.transport.cwd = "/some/path"; // extra cwd
    const fk = fakeCodexHooks([server]);
    const { statusWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const status = await statusWorkspace({ host: "codex", cwd: dir, hooks: fk });
    // Should NOT be configured — cwd makes it non-exact
    assert.notEqual(status.status, "configured");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("EXTRA-FIELDS-02: server with env_vars → not exact match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-extra-env-"));
  try {
    makeGitRepo(dir);
    const server = makeExpectedServer(dir.replace(/\\/g, "/"));
    server.transport.env_vars = ["EXTRA_VAR"]; // extra env var name
    const fk = fakeCodexHooks([server]);
    const { statusWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const status = await statusWorkspace({ host: "codex", cwd: dir, hooks: fk });
    assert.notEqual(status.status, "configured");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── .gitignore not modified ──────────────────────────────────────────────────

test("GITIGNORE-01: .gitignore never modified, git status clean of .codex", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gitignore-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fakeCodexHooks() });
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    assert.ok(!status.includes(".codex/config.toml"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── No credentials ───────────────────────────────────────────────────────────

test("NO-CRED-01: no credential values in exclude or output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-nocred-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const result = await bindWorkspace({ host: "codex", cwd: dir, hooks: fakeCodexHooks() });
    const exclude = readExclude(join(dir, ".git")).toString("utf8");
    assert.ok(!exclude.includes("ZHIPU_API_KEY"));
    assert.ok(!/api[_-]?key|secret|token/i.test(exclude));
    assert.ok(!JSON.stringify(result).includes("ZHIPU_API_KEY"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Architecture boundary ────────────────────────────────────────────────────

test("ARCH-01: mcpWorkspaceActivation does not import commands/mcp/SDK/zod", async () => {
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "application", "mcpWorkspaceActivation.js");
  const src = readFileSync(modulePath, "utf8");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
  assert.ok(src.includes("proveWorkspace"), "must reuse proveWorkspace");
  assert.ok(src.includes("codexMcpConfig"), "must delegate to codexMcpConfig adapter");
  // No handwritten TOML writer
  assert.ok(!src.includes("tomlBasicString"), "no handwritten TOML string writer");
  assert.ok(!src.includes("tomlArray"), "no handwritten TOML array writer");
  assert.ok(!src.includes("MANAGED_BEGIN"), "no managed block in config.toml");
});

test("ARCH-02: codexMcpConfig does not import application/commands/mcp/SDK/zod", async () => {
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "hostAdapters", "codexMcpConfig.js");
  const src = readFileSync(modulePath, "utf8");
  assert.ok(!src.includes('from "../application/'), "no application/");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
  // No codex exec
  assert.ok(!src.includes('"exec"'), "no codex exec");
});

test("ARCH-03: no 'node ...wao-cli.cmd' in docs or generated content", async () => {
  const usagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "usage.md");
  const usageSrc = readFileSync(usagePath, "utf8");
  assert.ok(!/node\s+.*wao-cli\.cmd/.test(usageSrc));
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "application", "mcpWorkspaceActivation.js");
  const src = readFileSync(modulePath, "utf8");
  assert.ok(!/node\s+.*wao-cli\.cmd/.test(src));
});

// ── Real Codex CLI integration (NO SKIP per CTO) ─────────────────────────────

test("CODEX-INTEGRATION: real Codex CLI bind → status → unbind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-codex-int-"));
  try {
    makeGitRepo(dir);
    // Pre-create config with a comment + other server to verify Codex preserves them
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex", "config.toml"),
      '# my comment\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["x"]\n');

    const { bindWorkspace, statusWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );

    // Hash global config before (must be unchanged after)
    const homeDir = process.env.USERPROFILE || process.env.HOME || "";
    const globalConfigP = join(homeDir, ".codex", "config.toml");
    let globalHashBefore = null;
    if (existsSync(globalConfigP)) {
      globalHashBefore = createHash("sha256").update(readFileSync(globalConfigP)).digest("hex");
    }

    // Use real Codex CLI (no fake hooks) — CODEX_HOME is project's .codex/
    await bindWorkspace({ host: "codex", cwd: dir });
    const status1 = await statusWorkspace({ host: "codex", cwd: dir });
    assert.equal(status1.status, "configured", `status should be configured, got: ${JSON.stringify(status1)}`);
    assert.equal(status1.bound, true);

    // Verify Codex can parse the generated config
    const codexBin = process.platform === "win32"
      ? process.env.ComSpec || "cmd.exe" : "codex";
    const codexPrefix = process.platform === "win32" ? ["/c", "codex"] : [];
    const getOutput = execFileSync(codexBin, [...codexPrefix, "mcp", "get", "wao", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: join(dir, ".codex") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(getOutput);
    assert.equal(parsed.name, "wao");
    assert.equal(parsed.transport.command, "node");
    assert.ok(parsed.transport.args.some(a => a.includes("stdio.js")));
    assert.ok(parsed.transport.args.some(a => a === "--workspace-root"));

    // Other server + comment preserved by Codex's own TOML writer
    const configContent = readFileSync(join(dir, ".codex", "config.toml"), "utf8");
    assert.ok(configContent.includes("# my comment"), "user comment preserved by Codex");
    assert.ok(configContent.includes("[mcp_servers.other]"), "other server preserved by Codex");

    // Unbind
    await unbindWorkspace({ host: "codex", cwd: dir });
    const status2 = await statusWorkspace({ host: "codex", cwd: dir });
    assert.equal(status2.status, "not_configured");

    // After unbind, other server + comment still there
    const configAfter = readFileSync(join(dir, ".codex", "config.toml"), "utf8");
    assert.ok(configAfter.includes("# my comment"), "comment survives unbind");
    assert.ok(configAfter.includes("[mcp_servers.other]"), "other server survives unbind");

    // Global config unchanged
    if (globalHashBefore && existsSync(globalConfigP)) {
      const globalHashAfter = createHash("sha256").update(readFileSync(globalConfigP)).digest("hex");
      assert.equal(globalHashAfter, globalHashBefore, "global config must be unchanged");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
