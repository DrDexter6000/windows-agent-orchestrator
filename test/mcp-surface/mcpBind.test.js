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
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readUsageDocs } from "../_usageDocs.mjs";

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
  const REPO_ROOT = resolve(_MODULE_DIR, "..", "..");
  return {
    name: "wao", enabled: true,
    transport: {
      type: "stdio", command: process.execPath,
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
      "../../src/application/mcpWorkspaceActivation.js"
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
      "../../src/application/mcpWorkspaceActivation.js"
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
      "../../src/application/mcpWorkspaceActivation.js"
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
    const { proveWorkspace } = await import("../../src/application/workspaceBinding.js");
    const proof = proveWorkspace(dir);
    const canonicalRoot = proof.root;
    const exactServer = makeExpectedServer(canonicalRoot);
    const fk = fakeCodexHooks([exactServer]);
    const { bindWorkspace, statusWorkspace, unbindWorkspace } = await import(
      "../../src/application/mcpWorkspaceActivation.js"
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
      "../../src/application/mcpWorkspaceActivation.js"
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
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
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
      "../../src/application/mcpWorkspaceActivation.js"
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

test("TRACKED-UNBIND-01: unbind refuses a tracked project config before server mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-tracked-unbind-"));
  try {
    makeGitRepo(dir);
    const fk = fakeCodexHooks();
    const { bindWorkspace, unbindWorkspace } = await import(
      "../../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "config.toml"), "# tracked owner config\n");
    execFileSync("git", ["add", "-f", ".codex/config.toml"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "track project config"], { cwd: dir });
    fk.calls.length = 0;

    await assert.rejects(() => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /tracked/);
    assert.ok(!fk.calls.some((call) => call.startsWith("remove:")));
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

    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
    // Exact simulated-add error: a restore fault would surface as
    // "cleanup_failed: codex mcp add failed: … — restoration incomplete: …".
    // The old .includes("add failed") predicate accepted that wrapper too,
    // discarding the original OS error before the exclude assertion failed.
    // Exact equality makes cleanup_failed fail HERE with its real message.
    await assert.rejects(
      () => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      (err) => err.message === "codex mcp add failed: simulated add failure",
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

    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
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
      "../../src/application/mcpWorkspaceActivation.js"
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
      "../../src/application/mcpWorkspaceActivation.js"
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
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
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
      "../../src/application/mcpWorkspaceActivation.js"
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
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: dir, hooks: fakeCodexHooks() }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("REJECT-02: Git subdirectory rejected", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-reject-sub-"));
  const subdir = join(root, "sub");
  try {
    makeGitRepo(root);
    mkdirSync(subdir);
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: subdir, hooks: fakeCodexHooks() }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("REJECT-03: relative path rejected", async () => {
  const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
  await assert.rejects(
    () => bindWorkspace({ host: "codex", cwd: "rel/path", hooks: fakeCodexHooks() }),
    (err) => err.message.includes("absolute"),
  );
});

test("REJECT-04: unsupported host is never bound — generic snippet, zero writes (decision 0066)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reject-host-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
    const fk = fakeCodexHooks();
    const result = await bindWorkspace({ host: "claude", cwd: dir, hooks: fk });
    assert.equal(result.bound, false, "表外宿主绝不绑定");
    assert.equal(result.mode, "generic-snippet");
    assert.deepEqual(fk.calls, [], "不触达任何宿主适配器");
    assert.equal(existsSync(join(dir, ".codex")), false, "零写入");
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
    const { statusWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
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
    const { statusWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
    const status = await statusWorkspace({ host: "codex", cwd: dir, hooks: fk });
    assert.notEqual(status.status, "configured");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── .gitignore not modified ──────────────────────────────────────────────────

test("GITIGNORE-01: .gitignore never modified, git status clean of .codex", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gitignore-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
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
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
    const result = await bindWorkspace({ host: "codex", cwd: dir, hooks: fakeCodexHooks() });
    const exclude = readExclude(join(dir, ".git")).toString("utf8");
    assert.ok(!exclude.includes("ZHIPU_API_KEY"));
    assert.ok(!/api[_-]?key|secret|token/i.test(exclude));
    assert.ok(!JSON.stringify(result).includes("ZHIPU_API_KEY"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Architecture boundary ────────────────────────────────────────────────────

test("ARCH-01: mcpWorkspaceActivation does not import commands/mcp/SDK/zod", async () => {
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "../..", "src", "application", "mcpWorkspaceActivation.js");
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
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "../..", "src", "hostAdapters", "codexMcpConfig.js");
  const src = readFileSync(modulePath, "utf8");
  assert.ok(!src.includes('from "../application/'), "no application/");
  assert.ok(!src.includes('from "../commands/'), "no commands/");
  assert.ok(!src.includes('from "../mcp/'), "no mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "no SDK");
  assert.ok(!src.includes('from "zod"'), "no zod");
  // No codex exec
  assert.ok(!src.includes('"exec"'), "no codex exec");
  if (process.platform === "win32") {
    assert.ok(!src.includes("cmd.exe"), "Windows adapter must not invoke cmd.exe");
    assert.ok(!src.includes("ComSpec"), "Windows adapter must not invoke ComSpec");
  }
});

test("P0-1R-DIGEST-01: exclude digest covers the full normalized server contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-digest-"));
  try {
    makeGitRepo(dir);
    const { proveWorkspace } = await import("../../src/application/workspaceBinding.js");
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
    const canonicalRoot = proveWorkspace(dir).root;
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fakeCodexHooks() });

    const server = makeExpectedServer(canonicalRoot);
    const normalizedContract = {
      version: 1,
      name: server.name,
      enabled: server.enabled,
      transport: {
        type: server.transport.type,
        command: server.transport.command,
        args: server.transport.args,
        cwd: server.transport.cwd,
        env: server.transport.env,
        env_vars: server.transport.env_vars,
      },
      workspaceRoot: canonicalRoot,
    };
    const expectedDigest = createHash("sha256")
      .update(JSON.stringify(normalizedContract), "utf8")
      .digest("hex")
      .substring(0, 16);
    const exclude = readExclude(join(dir, ".git")).toString("utf8");
    assert.match(exclude, new RegExp(`# digest: ${expectedDigest}\\b`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-01: bind verification failure restores config and exclude bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-txn-"));
  try {
    makeGitRepo(dir);
    const codexDir = join(dir, ".codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir);
    const configBefore = Buffer.from('# owner config\r\nmodel = "gpt-5"\r\n');
    writeFileSync(configPath, configBefore);
    const excludeBefore = readExclude(join(dir, ".git"));
    const fk = fakeCodexHooks();
    fk.codexAdd = async () => {
      writeFileSync(configPath, "[mcp_servers.wao]\ncommand = \"mutated\"\n");
    };
    fk.codexGet = async () => ({
      name: "wao",
      enabled: true,
      transport: {
        type: "stdio", command: "wrong", args: [], env: null, env_vars: [], cwd: null,
      },
    });

    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(
      () => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      /mismatch/,
    );
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-02: unbind verification failure restores config and exclude bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-unbind-txn-"));
  try {
    makeGitRepo(dir);
    const codexDir = join(dir, ".codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir);
    const configBefore = Buffer.from('[mcp_servers.wao]\r\ncommand = "node"\r\n');
    writeFileSync(configPath, configBefore);
    const fk = fakeCodexHooks();
    const { bindWorkspace, unbindWorkspace } = await import(
      "../../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });
    const excludeBefore = readExclude(join(dir, ".git"));
    const server = fk.servers.get("wao");
    fk.codexRemove = async () => {
      rmSync(configPath, { force: true });
    };
    fk.codexList = async () => [server];

    await assert.rejects(
      () => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }),
      /still present/,
    );
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-03: add that mutates config then throws restores both resources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-add-throw-txn-"));
  try {
    makeGitRepo(dir);
    const codexDir = join(dir, ".codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir);
    const configBefore = Buffer.from("# owner-before-add\n");
    writeFileSync(configPath, configBefore);
    const excludeBefore = readExclude(join(dir, ".git"));
    const fk = fakeCodexHooks();
    fk.codexAdd = async () => {
      writeFileSync(configPath, "# partially-mutated\n");
      throw new Error("simulated add failure after write");
    };

    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /add failed/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-04: get that throws after add restores both resources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-get-throw-txn-"));
  try {
    makeGitRepo(dir);
    const codexDir = join(dir, ".codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir);
    const configBefore = Buffer.from("# owner-before-get\r\n");
    writeFileSync(configPath, configBefore);
    const excludeBefore = readExclude(join(dir, ".git"));
    const fk = fakeCodexHooks();
    fk.codexAdd = async () => writeFileSync(configPath, "# added\n");
    fk.codexGet = async () => { throw new Error("simulated get failure"); };

    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /verify failed/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-05: remove that mutates config then throws restores both resources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-remove-throw-txn-"));
  try {
    makeGitRepo(dir);
    const codexDir = join(dir, ".codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir);
    const configBefore = Buffer.from("# owner-before-remove\n");
    writeFileSync(configPath, configBefore);
    const fk = fakeCodexHooks();
    const { bindWorkspace, unbindWorkspace } = await import(
      "../../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });
    const excludeBefore = readExclude(join(dir, ".git"));
    fk.codexRemove = async () => {
      rmSync(configPath, { force: true });
      throw new Error("simulated remove failure after write");
    };

    await assert.rejects(() => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /remove failed/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-06: post-remove list failure restores both resources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-list-throw-txn-"));
  try {
    makeGitRepo(dir);
    const codexDir = join(dir, ".codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir);
    const configBefore = Buffer.from("# owner-before-list\n");
    writeFileSync(configPath, configBefore);
    const fk = fakeCodexHooks();
    const { bindWorkspace, unbindWorkspace } = await import(
      "../../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });
    const excludeBefore = readExclude(join(dir, ".git"));
    const server = fk.servers.get("wao");
    let listCount = 0;
    fk.codexList = async () => {
      listCount++;
      if (listCount === 1) return [server];
      throw new Error("simulated post-remove list failure");
    };
    fk.codexRemove = async () => rmSync(configPath, { force: true });

    await assert.rejects(() => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /verify failed/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-07: bind refuses a silent exclude write and does not add server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-exclude-noop-"));
  try {
    makeGitRepo(dir);
    const excludeBefore = readExclude(join(dir, ".git"));
    const fk = fakeCodexHooks();
    fk.writeExclude = () => {};
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");

    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /exclude verify/);
    assert.ok(!fk.calls.some((call) => call.startsWith("add:")));
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-08: unbind refuses a silent exclude removal and restores config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-unbind-exclude-noop-"));
  try {
    makeGitRepo(dir);
    const codexDir = join(dir, ".codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir);
    const configBefore = Buffer.from("# owner-before-exclude-remove\n");
    writeFileSync(configPath, configBefore);
    const fk = fakeCodexHooks();
    const { bindWorkspace, unbindWorkspace } = await import(
      "../../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });
    const excludeBefore = readExclude(join(dir, ".git"));
    fk.codexRemove = async ({ name }) => {
      fk.servers.delete(name);
      rmSync(configPath, { force: true });
    };
    fk.writeExclude = () => {};

    await assert.rejects(() => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /exclude verify/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-09: bind rechecks both resources before reporting success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-final-check-"));
  try {
    makeGitRepo(dir);
    const fk = fakeCodexHooks();
    const originalGet = fk.codexGet;
    fk.codexGet = async (opts) => {
      const server = await originalGet(opts);
      const excludePath = join(dir, ".git", "info", "exclude");
      writeFileSync(excludePath, readFileSync(excludePath, "utf8").replace("/.codex/config.toml", "/bad"));
      return server;
    };
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");

    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /final state/);
    assert.equal(fk.servers.has("wao"), true, "fake server store models an external side effect");
    assert.ok(!readFileSync(join(dir, ".git", "info", "exclude"), "utf8").includes("/bad"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-10: unbind rechecks both resources before reporting success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-unbind-final-check-"));
  try {
    makeGitRepo(dir);
    const fk = fakeCodexHooks();
    const { bindWorkspace, unbindWorkspace } = await import(
      "../../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });
    const configPath = join(dir, ".codex", "config.toml");
    mkdirSync(join(dir, ".codex"), { recursive: true });
    const configBefore = Buffer.from("# before-final-unbind-check\n");
    writeFileSync(configPath, configBefore);
    const excludeBefore = readExclude(join(dir, ".git"));
    const originalWriteExclude = (gitDir, content) => writeFileSync(join(gitDir, "info", "exclude"), content);
    fk.writeExclude = (gitDir, content) => {
      originalWriteExclude(gitDir, content);
      fk.servers.set("wao", makeExpectedServer(dir.replace(/\\/g, "/")));
    };

    await assert.rejects(() => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /final state/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-11: bind final-state read failure rolls back both resources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-final-read-"));
  try {
    makeGitRepo(dir);
    const codexDir = join(dir, ".codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir);
    const configBefore = Buffer.from("# before-bind-final-read\n");
    writeFileSync(configPath, configBefore);
    const excludeBefore = readExclude(join(dir, ".git"));
    const fk = fakeCodexHooks();
    const originalAdd = fk.codexAdd;
    fk.codexAdd = async (opts) => {
      await originalAdd(opts);
      writeFileSync(configPath, "# added-before-final-read\n");
    };
    let readCount = 0;
    fk.readExclude = (gitDir) => {
      readCount++;
      if (readCount === 3) throw new Error("simulated final exclude read failure");
      const path = join(gitDir, "info", "exclude");
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    };
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");

    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /final state/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-TXN-12: unbind final-state read failure rolls back both resources", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-unbind-final-read-"));
  try {
    makeGitRepo(dir);
    const codexDir = join(dir, ".codex");
    const configPath = join(codexDir, "config.toml");
    mkdirSync(codexDir);
    const configBefore = Buffer.from("# before-unbind-final-read\n");
    writeFileSync(configPath, configBefore);
    const fk = fakeCodexHooks();
    const { bindWorkspace, unbindWorkspace } = await import(
      "../../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir, hooks: fk });
    const excludeBefore = readExclude(join(dir, ".git"));
    const originalRemove = fk.codexRemove;
    fk.codexRemove = async (opts) => {
      await originalRemove(opts);
      rmSync(configPath, { force: true });
    };
    let readCount = 0;
    fk.readExclude = (gitDir) => {
      readCount++;
      if (readCount === 3) throw new Error("simulated final exclude read failure");
      const path = join(gitDir, "info", "exclude");
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    };

    await assert.rejects(() => unbindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /final state/);
    assert.deepEqual(readFileSync(configPath), configBefore);
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0-1R-SCOPE-01: .codex junction cannot redirect activation outside workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-codex-link-"));
  const external = mkdtempSync(join(tmpdir(), "wao-codex-external-"));
  try {
    makeGitRepo(dir);
    const externalConfig = join(external, "config.toml");
    const sentinel = Buffer.from("# external-owner-config\n");
    writeFileSync(externalConfig, sentinel);
    symlinkSync(external, join(dir, ".codex"), process.platform === "win32" ? "junction" : "dir");
    const fk = fakeCodexHooks();
    fk.codexAdd = async ({ codexHome }) => writeFileSync(join(codexHome, "config.toml"), "mutated\n");
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");

    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /codex home/i);
    assert.deepEqual(readFileSync(externalConfig), sentinel);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("P0-1R-SCOPE-02: config symlink cannot redirect activation outside workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-config-link-"));
  const external = mkdtempSync(join(tmpdir(), "wao-config-external-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    const externalConfig = join(external, "owner.toml");
    const sentinel = Buffer.from("# external-config-file\n");
    writeFileSync(externalConfig, sentinel);
    symlinkSync(externalConfig, join(dir, ".codex", "config.toml"), "file");
    const fk = fakeCodexHooks();
    const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");

    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: dir, hooks: fk }), /config.*link/i);
    assert.deepEqual(readFileSync(externalConfig), sentinel);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("ARCH-03: no 'node ...wao-cli.cmd' in docs or generated content", async () => {
  const usageSrc = readUsageDocs(join(dirname(fileURLToPath(import.meta.url)), "../.."));
  assert.ok(!/node\s+.*wao-cli\.cmd/.test(usageSrc));
  // 2026-09-26 认证正文迁移：smoke/reliability/prune 命令正文迁至认证 runbook，
  // 错误 Node 命令形式检查同时覆盖迁出的命令正文所在文件。
  const runbookPath = join(dirname(fileURLToPath(import.meta.url)), "../..", "docs", "certification-runbook.md");
  const runbookSrc = readFileSync(runbookPath, "utf8");
  assert.ok(!/node\s+.*wao-cli\.cmd/.test(runbookSrc));
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "../..", "src", "application", "mcpWorkspaceActivation.js");
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
      "../../src/application/mcpWorkspaceActivation.js"
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

    // Verify Codex can parse the generated config through the same shell-free adapter.
    const { codexMcpGet } = await import("../../src/hostAdapters/codexMcpConfig.js");
    const parsed = await codexMcpGet({ codexHome: join(dir, ".codex"), name: "wao" });
    assert.equal(parsed.name, "wao");
    assert.equal(parsed.transport.command, process.execPath);
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

test("P0-1R-INTEGRATION: fresh project with spaces and ampersand binds without a shell", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao fresh & safe "));
  try {
    makeGitRepo(dir);
    assert.equal(existsSync(join(dir, ".codex")), false, "fixture must start without .codex");
    const { bindWorkspace, statusWorkspace, unbindWorkspace } = await import(
      "../../src/application/mcpWorkspaceActivation.js"
    );

    const bound = await bindWorkspace({ host: "codex", cwd: dir });
    assert.equal(bound.status, "configured");
    assert.equal((await statusWorkspace({ host: "codex", cwd: dir })).status, "configured");
    await unbindWorkspace({ host: "codex", cwd: dir });
    assert.equal((await statusWorkspace({ host: "codex", cwd: dir })).status, "not_configured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TD-191① / 决定 0043：宿主描述符表与 snippet-only emit ──────────────────────

test("TD-191①: HOST_DESCRIPTORS 闭集形状——三能力布尔、示例构造器、无未知字段", async () => {
  const { HOST_DESCRIPTORS, HOST_DESCRIPTOR_IDS, findHostDescriptor } = await import("../../src/hostAdapters/hostDescriptors.js");
  assert.ok(HOST_DESCRIPTORS.length >= 2, "表至少含 codex 与 claude-code");
  const seen = new Set();
  for (const d of HOST_DESCRIPTORS) {
    assert.match(d.id, /^[a-z][a-z0-9-]*$/, "id 形状");
    assert.ok(!seen.has(d.id), `id 重复：${d.id}`);
    seen.add(d.id);
    for (const cap of ["snippet", "autoBind", "hostVerified"]) {
      assert.equal(typeof d[cap], "boolean", `${d.id}.${cap} 必须是显式布尔（三能力矩阵不许缺省）`);
    }
    assert.equal(typeof d.example, "function", `${d.id}.example 必须是构造器`);
    assert.ok(["stable", "experimental", "unverified-host-load"].includes(d.stability), `${d.id}.stability 闭集（zcode 格式级入表用 unverified-host-load）`);
    // autoBind 宿主当前只有 codex（真写配置的适配器仅此一个）
    if (d.autoBind) assert.equal(d.id, "codex", "autoBind 闭集当前 = {codex}（新增须扩 hostAdapters 适配器）");
  }
  assert.deepEqual(HOST_DESCRIPTOR_IDS, [...seen], "id 派生数组与表一致");
  assert.equal(findHostDescriptor("definitely-not-a-host"), null, "未知宿主返回 null（fail-closed 数据源）");
});

test("TD-191①: bind claude-code = snippet emit，零写入、明说 NOT BOUND", async () => {
  const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-snippet-bind-"));
  makeGitRepo(dir);
  try {
    const before = readFileSync(join(dir, "README.md"), "utf8");
    const result = await bindWorkspace({ host: "claude-code", cwd: dir });
    assert.equal(result.bound, false, "snippet 模式 bound=false");
    assert.equal(result.mode, "snippet");
    assert.match(result.note, /NOT BOUND/i, "必须明说未绑定");
    assert.ok(result.snippet?.mcpServers?.wao?.args?.length >= 4, "片段含 stdio argv");
    assert.match(result.example.command, /^claude mcp add wao --scope user -- /, "示例行来自描述符表");
    assert.equal(result.hostVerified, true, "claude-code hostVerified（M9-7B dogfood 证据）");
    // 零写入：仓库内容与目录清单不变（没有 .codex/ 被创建）
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), before, "仓库内容不变");
    assert.equal(existsSync(join(dir, ".codex")), false, "不得创建 .codex/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-191① + 决定 0066: snippet-only 宿主 status=只读探测注册状态（不再 not_applicable）；unbind 仍 nothing_to_unbind", async () => {
  const { statusWorkspace, unbindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-snippet-status-"));
  const home = mkdtempSync(join(tmpdir(), "wao-snippet-home-"));
  makeGitRepo(dir);
  try {
    // 探测面注入临时 home（绝不读开发者真实的 ~/.claude.json）
    const st = await statusWorkspace({ host: "claude-code", cwd: dir, probe: { home, env: {} } });
    assert.equal(st.mode, "snippet-only");
    assert.equal(st.status, "not_registered", "空 home：宿主配置里没有 wao 条目");
    assert.equal(st.registered, false);
    assert.equal(st.bound, false, "bound 仍只表示 WAO 自己写的绑定——snippet-only 恒 false");
    assert.match(st.note, /mcp bind --host claude-code/, "未注册时给出注册指路");
    const ub = await unbindWorkspace({ host: "claude-code", cwd: dir });
    assert.equal(ub.mode, "snippet-only");
    assert.equal(ub.status, "nothing_to_unbind");
    assert.equal(ub.bound, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("决定 0066: 表外宿主 bind=通用 stdio 片段（零写入、明说未核实）；unbind 仍拒绝并给 known hosts", async () => {
  const { bindWorkspace, unbindWorkspace, statusWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
  const { HOST_DESCRIPTOR_IDS } = await import("../../src/hostAdapters/hostDescriptors.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-unknown-host-"));
  makeGitRepo(dir);
  try {
    const generic = await bindWorkspace({ host: "not-a-host", cwd: dir });
    assert.equal(generic.bound, false);
    assert.equal(generic.mode, "generic-snippet");
    assert.equal(generic.hostKnown, false);
    assert.equal(generic.hostVerified, false);
    assert.match(generic.note, /NOT BOUND, FORMAT NOT VERIFIED FOR not-a-host/, "必须明说未绑定且格式未核实");
    assert.deepEqual(generic.knownHosts, HOST_DESCRIPTOR_IDS);
    assert.equal(generic.stdio.command, "node");
    assert.ok(generic.stdio.args.some((a) => a.endsWith("src/mcp/stdio.js")), "通用片段携带 stdio 入口");
    assert.deepEqual(generic.snippet.mcpServers.wao, generic.stdio, "mcpServers 形态与裸 stdio 同源");
    assert.equal(existsSync(join(dir, ".codex")), false, "零写入");
    await assert.rejects(() => bindWorkspace({ host: "", cwd: dir }), /unsupported host/);
    const st = await statusWorkspace({ host: "not-a-host", cwd: dir });
    assert.equal(st.status, "unsupported_host");
    assert.match(st.note, /no probe/, "表外宿主 status 如实说查不了");
    await assert.rejects(() => unbindWorkspace({ host: "not-a-host", cwd: dir }),
      (err) => err.message.includes(`known hosts: ${HOST_DESCRIPTOR_IDS.join(", ")})`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-191①: onboarding buildHostExamples 从描述符表派生（单一宿主清单）", async () => {
  const { buildHostExamples } = await import("../../src/application/onboarding.js");
  const { HOST_DESCRIPTORS } = await import("../../src/hostAdapters/hostDescriptors.js");
  const snippet = { mcpServers: { wao: { command: "node", args: ["a.cjs", "b.js", "--registry", "r.json", "--run-dir", "rd"] } } };
  const examples = buildHostExamples(snippet);
  assert.deepEqual(examples.map((e) => e.host), HOST_DESCRIPTORS.filter((d) => d.snippet).map((d) => d.id),
    "示例 host 清集与顺序 = 描述符表（第二份手写清单已消灭）");
  for (const e of examples) {
    const d = HOST_DESCRIPTORS.find((x) => x.id === e.host);
    assert.equal(e.stability, d.stability);
    assert.ok(e.command.startsWith(d.example("")), `示例命令来自描述符构造器（${e.host}）`);
  }
});

// ── TD-191②/决定 0043：zcode 格式级入表（hostVerified=false）+ 插件包片段渲染 ──────

test("TD-191②: zcode 描述符=格式级入表（hostVerified=false 如实）+ 插件包形态片段", async () => {
  const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-zcode-emit-"));
  try {
    const result = await bindWorkspace({ host: "zcode", cwd: dir });
    assert.equal(result.mode, "snippet");
    assert.equal(result.bound, false);
    assert.equal(result.hostVerified, true, "zcode 已真机验证（2026-10-03 官方插件通路，23 工具实测加载）");
    assert.equal(result.snippet.configShape, "zcode-local-plugin", "zcode 片段=插件包形态（非 mcpServers）");
    const pluginJson = result.snippet.files[".claude-plugin/plugin.json"];
    const mcpJson = result.snippet.files[".mcp.json"];
    assert.ok(pluginJson && pluginJson.name === "wao", "插件清单在场");
    assert.ok(mcpJson && mcpJson.wao && mcpJson.wao.command === "node" && Array.isArray(mcpJson.wao.args),
      ".mcp.json 是扁平 server 映射 {wao:{command,args}}（实机勘察格式）");
    assert.equal(mcpJson.wao.timeoutMs, 660_000,
      ".mcp.json 携带 timeoutMs=660000：zcode 宿主默认 30000ms 会把 >30s 的等待族调用掐成假失败；600s 最大阻塞预算 + 60s 余量（改动须同步 hostDescriptors 常量与本钉）");
    const cc = await bindWorkspace({ host: "claude-code", cwd: dir });
    assert.equal(cc.snippet.mcpServers.wao.timeoutMs, undefined,
      "claude-code/codex 片段不带 timeoutMs（其配置是否支持该字段未核实——不猜测格式，fail-closed）");
    assert.match(result.note, /NOT BOUND/i);
    assert.equal(existsSync(join(dir, ".zcode")), false, "零写入");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 决定 0066：宿主注册只读探测 / 全宿主一览 / 派发 advisory ─────────────────────
// 一律注入临时 home/env——探测面绝不读开发者真实的宿主配置。

function stdioOfThisRepo() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(resolve(moduleDir, "..", ".."), "src", "mcp", "stdio.js");
}

function waoEntry(stdio) {
  return { command: "node", args: ["x/wao-node.cjs", stdio, "--registry", "r.json", "--run-dir", "rd"] };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

test("决定 0066: 表内每个 snippet-only 宿主都有文件式探测（表内宿主不许查不了）", async () => {
  const { HOST_DESCRIPTORS } = await import("../../src/hostAdapters/hostDescriptors.js");
  const { FILE_PROBED_HOST_IDS, REGISTRATION_STATES, probeHostRegistration } = await import("../../src/hostAdapters/hostRegistrationProbe.js");
  for (const d of HOST_DESCRIPTORS.filter((x) => !x.autoBind)) {
    assert.ok(FILE_PROBED_HOST_IDS.includes(d.id), `${d.id} 缺探测——新宿主入表须同批提供注册状态探测`);
  }
  assert.deepEqual(REGISTRATION_STATES, ["registered", "registered_other_target", "not_registered", "unknown"]);
  assert.equal(probeHostRegistration("not-a-host", { expectedStdio: "x" }), null, "表外宿主无探测");
});

test("决定 0066: claude-code 探测——三层来源与四态（读不了=unknown，绝不折算成未注册）", async () => {
  const { probeHostRegistration } = await import("../../src/hostAdapters/hostRegistrationProbe.js");
  const home = mkdtempSync(join(tmpdir(), "wao-probe-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "wao-probe-cwd-"));
  const expectedStdio = stdioOfThisRepo();
  const probe = (extra = {}) => probeHostRegistration("claude-code", { expectedStdio, cwd, home, env: {}, ...extra });
  const scope = (r, name) => r.sources.find((s) => s.scope === name).state;
  try {
    assert.equal(probe().state, "not_registered", "无配置文件=未注册");

    writeJson(join(home, ".claude.json"), { mcpServers: { wao: waoEntry("Z:/elsewhere/src/mcp/stdio.js") } });
    assert.equal(probe().state, "registered_other_target", "有 wao 条目但指向另一份安装");

    // local 级：键是正斜杠绝对路径；值里的 stdio 用正斜杠——与本机反斜杠路径等价比对
    writeJson(join(home, ".claude.json"), {
      mcpServers: {},
      projects: { [cwd.replace(/\\/g, "/")]: { mcpServers: { wao: waoEntry(expectedStdio.replace(/\\/g, "/")) } } },
    });
    let r = probe();
    assert.equal(r.state, "registered");
    assert.equal(scope(r, "user"), "not_registered");
    assert.equal(scope(r, "local"), "registered");
    assert.deepEqual(r.sources.map((s) => s.scope), ["local", "project", "user"], "来源按 Claude Code 的优先级从高到低");
    assert.deepEqual(r.sources.map((s) => s.effective), [true, false, false], "local 级条目是生效来源");
    assert.equal(probe({ cwd: undefined }).state, "not_registered", "不给 cwd 只看用户级——local 级注册对别的目录不生效");

    writeJson(join(home, ".claude.json"), { mcpServers: {} });
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { wao: waoEntry(expectedStdio) } });
    assert.equal(scope(probe(), "project"), "registered", "项目级 .mcp.json");
    // 覆盖关系（会审 sol 必改 3）：用户级指向本安装、项目级覆盖成另一份 → 生效的是项目级
    writeJson(join(home, ".claude.json"), { mcpServers: { wao: waoEntry(expectedStdio) } });
    writeJson(join(cwd, ".mcp.json"), { mcpServers: { wao: waoEntry("Z:/elsewhere/src/mcp/stdio.js") } });
    r = probe();
    assert.equal(r.state, "registered_other_target", "高优先级来源覆盖低优先级——不做'任一命中即 registered'的合并");
    assert.equal(r.sources.find((s) => s.effective).scope, "project");
    // 高优先级来源读不了 → unknown（无从知道它是否覆盖了用户级）
    writeJson(join(cwd, ".mcp.json"), "{ not json");
    assert.equal(probe().state, "unknown");
    rmSync(join(cwd, ".mcp.json"));
    // 词法等价路径（. / ..）算同一安装
    writeJson(join(home, ".claude.json"), { mcpServers: { wao: waoEntry(join(expectedStdio, "..", ".", "stdio.js")) } });
    assert.equal(probe().state, "registered");

    writeJson(join(home, ".claude.json"), "{ not json");
    r = probe();
    assert.equal(r.state, "unknown", "解析不了=unknown");
    assert.equal(scope(r, "user"), "unknown");

    // 读取失败 ≠ 文件不存在（会审 sol 必改 1）：只有 ENOENT/ENOTDIR 算缺失
    const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    assert.equal(probe({ io: { readFileSync: () => { throw eacces; } } }).state, "unknown", "权限错误=unknown，绝不折算成未注册");
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    assert.equal(probe({ io: { readFileSync: () => { throw enoent; } } }).state, "not_registered");

    // CLAUDE_CONFIG_DIR 覆盖全局配置位置
    const altDir = join(home, "alt");
    writeJson(join(altDir, ".claude.json"), { mcpServers: { wao: waoEntry(expectedStdio) } });
    assert.equal(probe({ env: { CLAUDE_CONFIG_DIR: altDir } }).state, "registered");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("决定 0066: kimi-code / opencode(JSONC) / zcode 插件 / claude-desktop 的探测形状", async () => {
  const { probeHostRegistration } = await import("../../src/hostAdapters/hostRegistrationProbe.js");
  const home = mkdtempSync(join(tmpdir(), "wao-probe-hosts-"));
  const expectedStdio = stdioOfThisRepo();
  const state = (host, extra = {}) => probeHostRegistration(host, { expectedStdio, home, env: {}, ...extra }).state;
  try {
    assert.equal(state("kimi-code"), "not_registered");
    writeJson(join(home, ".kimi-code", "mcp.json"), { mcpServers: { wao: waoEntry(expectedStdio) } });
    assert.equal(state("kimi-code"), "registered");

    // opencode：JSONC（注释 + 尾逗号）、command 是 argv 数组
    writeJson(join(home, ".config", "opencode", "opencode.jsonc"),
      `{\n  // comment with "quotes" and // slashes\n  "mcp": { /* block */ "wao": { "type": "local", "command": ["node", "x.cjs", ${JSON.stringify(expectedStdio)}], "enabled": true, }, },\n}\n`);
    assert.equal(state("opencode"), "registered");
    // JSONC 回退不得改写字符串、不得放过损坏输入（会审 sol 必改 2）
    const ocPath = join(home, ".config", "opencode", "opencode.jsonc");
    const trickyStdio = "D:/wao/a,}.js";
    writeJson(ocPath, `{ /* c */ "mcp": { "wao": { "type": "local", "command": ["node", "${trickyStdio}"], }, }, }`);
    assert.equal(probeHostRegistration("opencode", { expectedStdio: trickyStdio, home, env: {} }).state, "registered", "字符串里的 ',}' 原样保留");
    writeJson(ocPath, `{ "mcp": { "wao": { "command": ["node", ${JSON.stringify(expectedStdio)}] } } /* never closed`);
    assert.equal(state("opencode"), "unknown", "未闭合块注释=解析失败=unknown");
    // 覆盖关系与额外来源（会审 sol 必改 3/4）：全局 < OPENCODE_CONFIG < 项目 < OPENCODE_CONFIG_CONTENT
    writeJson(ocPath, { mcp: {} });
    const custom = join(home, "custom-opencode.json");
    writeJson(custom, { mcp: { wao: { type: "local", command: ["node", expectedStdio] } } });
    assert.equal(state("opencode"), "not_registered", "默认文件里没有");
    assert.equal(state("opencode", { env: { OPENCODE_CONFIG: custom } }), "registered", "OPENCODE_CONFIG 指定的文件里有");
    const inline = JSON.stringify({ mcp: { wao: { type: "local", command: ["node", "Z:/other/src/mcp/stdio.js"] } } });
    assert.equal(state("opencode", { env: { OPENCODE_CONFIG: custom, OPENCODE_CONFIG_CONTENT: inline } }), "registered_other_target", "内联配置优先级最高");
    assert.equal(state("opencode", { env: { OPENCODE_CONFIG_CONTENT: "{ broken" } }), "unknown");
    // 复审 sol 席：opencode 是按键合并，不是整条替换——高优先级只写 enabled 时命令仍来自低优先级
    const partialOn = JSON.stringify({ mcp: { wao: { enabled: true } } });
    const partialOff = JSON.stringify({ mcp: { wao: { enabled: false } } });
    assert.equal(state("opencode", { env: { OPENCODE_CONFIG: custom, OPENCODE_CONFIG_CONTENT: partialOn } }), "registered", "部分覆盖与低优先级的完整条目合并");
    assert.equal(state("opencode", { env: { OPENCODE_CONFIG: custom, OPENCODE_CONFIG_CONTENT: partialOff } }), "not_registered", "高优先级只关掉 enabled");
    const eaccesOc = Object.assign(new Error("EACCES"), { code: "EACCES" });
    assert.equal(
      probeHostRegistration("opencode", { expectedStdio, home, env: { OPENCODE_CONFIG_CONTENT: partialOn }, io: { readFileSync: () => { throw eaccesOc; } } }).state,
      "unknown", "部分覆盖 + 低优先级来源读不了：合并结果不可知");
    // 复审 sol 席：去掉注释不得把两侧拼成合法 token
    writeJson(ocPath, `{ "mcp": { "wao": { "type": "local", "command": ["node", ${JSON.stringify(expectedStdio)}], "enabled": tr/*x*/ue } } }`);
    assert.equal(state("opencode"), "unknown", "tr/*x*/ue 不是 true");
    writeJson(ocPath, { mcp: {} });
    const ocProject = mkdtempSync(join(tmpdir(), "wao-probe-oc-project-"));
    writeJson(join(ocProject, "opencode.json"), { mcp: { wao: { type: "local", command: ["node", expectedStdio], enabled: false } } });
    const disabled = probeHostRegistration("opencode", { expectedStdio, home, cwd: ocProject, env: { OPENCODE_CONFIG: custom } });
    assert.equal(disabled.state, "not_registered", "项目级把 wao 禁用了：高优先级的禁用条目定论");
    assert.match(disabled.sources.find((s) => s.effective).detail, /disabled/);
    rmSync(ocProject, { recursive: true, force: true });

    // zcode：启用标记在 cli/config.json，目标比对读已安装副本
    assert.equal(state("zcode"), "not_registered");
    writeJson(join(home, ".zcode", "cli", "config.json"), { plugins: { enabledPlugins: { "wao@wao-local": true } } });
    assert.equal(state("zcode"), "unknown", "已启用但读不到已安装副本——目标不可证");
    writeJson(join(home, ".zcode", "cli", "plugins", "cache", "wao-local", "wao", "0.3.1", ".mcp.json"), { wao: waoEntry(expectedStdio) });
    assert.equal(state("zcode"), "registered");
    // 多个缓存版本指向不一致：无从得知宿主选用哪个 → unknown，并列出读到的副本
    writeJson(join(home, ".zcode", "cli", "plugins", "cache", "wao-local", "wao", "0.0.0", ".mcp.json"), { wao: waoEntry("Z:/old/src/mcp/stdio.js") });
    const mixed = probeHostRegistration("zcode", { expectedStdio, home, env: {} });
    assert.equal(mixed.state, "unknown");
    assert.match(mixed.sources[0].detail, /0\.0\.0=registered_other_target, 0\.3\.1=registered/);
    rmSync(join(home, ".zcode", "cli", "plugins", "cache", "wao-local", "wao", "0.0.0"), { recursive: true, force: true });
    writeJson(join(home, ".zcode", "cli", "config.json"), { plugins: { enabledPlugins: { "wao@wao-local": false } } });
    assert.equal(state("zcode"), "not_registered", "插件装了但没启用=未注册");

    // claude-desktop：仅 win32 位置核实过
    const appData = join(home, "AppData", "Roaming");
    writeJson(join(appData, "Claude", "claude_desktop_config.json"), { mcpServers: { wao: waoEntry(expectedStdio) } });
    assert.equal(state("claude-desktop", { platform: "win32", env: { APPDATA: appData } }), "registered");
    assert.equal(state("claude-desktop", { platform: "linux", env: {} }), "unknown", "未核实平台不猜");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("决定 0066: statusAllHosts 一览——codex 用户级注册并入 registered（项目未绑定也算有工具）", async () => {
  const { statusAllHosts } = await import("../../src/application/mcpWorkspaceActivation.js");
  const { HOST_DESCRIPTOR_IDS } = await import("../../src/hostAdapters/hostDescriptors.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-status-all-"));
  const home = mkdtempSync(join(tmpdir(), "wao-status-all-home-"));
  makeGitRepo(dir);
  try {
    const userServer = { name: "wao", enabled: true, transport: { type: "stdio", ...waoEntry(stdioOfThisRepo()) } };
    const hooks = { ...fakeCodexHooks(), codexUserList: async () => [userServer] };
    const all = await statusAllHosts({ cwd: dir, hooks, probe: { home, env: {} }, env: {} });
    assert.deepEqual(all.hosts.map((h) => h.host), HOST_DESCRIPTOR_IDS, "一览顺序=描述符表");
    assert.equal(all.detectedHost, null);
    const row = (id) => all.hosts.find((h) => h.host === id);
    assert.equal(row("codex").status, "not_configured", "项目级未绑定");
    assert.equal(row("codex").userRegistration, "registered");
    assert.equal(row("codex").registered, true, "用户级已注册 → Lead 在 codex 里有工具");
    assert.equal(row("claude-code").registered, false);
    assert.equal(row("kimi-code").status, "not_registered");
    const none = await statusAllHosts({ cwd: dir, hooks: { ...fakeCodexHooks(), codexUserList: async () => [] }, probe: { home, env: {} }, env: {} });
    assert.equal(none.hosts.find((h) => h.host === "codex").registered, false);
    const down = await statusAllHosts({ cwd: dir, hooks: { ...fakeCodexHooks(), codexUserList: async () => { throw new Error("boom"); } }, probe: { home, env: {} }, env: {} });
    assert.equal(down.hosts.find((h) => h.host === "codex").registered, null, "codex CLI 不可用=unknown，不折算成未注册");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("决定 0066: 派发 advisory——识别到宿主且未注册才出行；已注册/识别不出/读不了一律静默", async () => {
  const { renderMcpHostAdvisory, detectHostFromEnv } = await import("../../src/application/mcpWorkspaceActivation.js");
  const home = mkdtempSync(join(tmpdir(), "wao-advisory-home-"));
  try {
    assert.equal(detectHostFromEnv({}), null);
    assert.equal(detectHostFromEnv({ CLAUDECODE: "1" }), "claude-code");
    assert.equal(detectHostFromEnv({ CODEX_THREAD_ID: "t" }), "codex");
    assert.equal(detectHostFromEnv({ OPENCODE: "1" }), "opencode");

    // 状态目录一律注入临时目录（绝不写开发者真实的 %LOCALAPPDATA%\wao）
    let n = 0;
    const freshState = () => join(home, `state-${n += 1}`);
    const session = (id) => ({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: id });
    const projA = join(home, "proj-a");
    const projB = join(home, "proj-b");
    const stateDir = freshState();
    const call = (env, cwd, extra = {}) => renderMcpHostAdvisory({ env, cwd, probe: { home }, stateDir, ...extra });
    const line = call(session("s1"), projA);
    assert.match(line, /^\[wao\] advisory: this is a claude-code session and WAO's MCP is not registered for it/);
    assert.match(line, /wao mcp bind --host claude-code/);
    assert.match(line, /the CLI works/, "命令行是合法通道——措辞不是违规告警");
    // 警报疲劳纪律：同一宿主会话、同一项目只判一次
    assert.equal(call(session("s1"), projA), null, "同会话同项目第二次派发静默");
    // 复审 sol 席：多会话交替派发互不覆盖（A、B、A、B 各只出一次）
    assert.match(call(session("s2"), projA), /not registered/, "另一个会话各自告知一次");
    assert.equal(call(session("s1"), projA), null, "A 不因 B 判过而重新出行");
    assert.equal(call(session("s2"), projA), null);
    // 换项目目录重新判定（注册状态可能因 local/项目级配置而不同）
    assert.match(call(session("s1"), projB), /not registered/, "同会话换项目再判一次");
    assert.equal(call(session("s1"), projB), null);
    const markers = readdirSync(join(stateDir, "mcp-host-advisory"));
    assert.equal(markers.length, 3, "每个（会话, 项目）一个标记");
    assert.ok(markers.every((m) => /^[0-9a-f]{24}\.seen$/.test(m)), "标记文件名是哈希，不含会话 id");
    // 并发：标记用独占创建——已被别的进程抢先落盘（EEXIST）时本进程静默
    const raceDir = freshState();
    let rival = null;
    const raced = renderMcpHostAdvisory({ env: session("race"), cwd: projA, stateDir: raceDir,
      probe: { home, io: { readFileSync: (...a) => {
        // 本进程探测进行中，另一个并发派发先判完并落了标记（只模拟一次）
        if (rival === null) rival = renderMcpHostAdvisory({ env: session("race"), cwd: projA, stateDir: raceDir, probe: { home } });
        return readFileSync(...a);
      } } } });
    assert.match(rival, /not registered/, "抢到标记的那个进程出行");
    assert.equal(raced, null, "没抢到标记的并发派发静默——同一键恰好出一行");
    // 无会话变量 → 按 UTC 日去重
    const day1 = () => new Date("2026-10-12T10:00:00Z");
    const day2 = () => new Date("2026-10-13T10:00:00Z");
    const dayDir = freshState();
    const noSession = (now) => renderMcpHostAdvisory({ env: { CLAUDECODE: "1" }, cwd: projA, probe: { home }, stateDir: dayDir, now });
    assert.match(noSession(day1), /not registered/);
    assert.equal(noSession(day1), null);
    assert.match(noSession(day2), /not registered/);
    assert.equal(renderMcpHostAdvisory({ env: {}, cwd: projA, probe: { home }, stateDir: freshState() }), null, "识别不出宿主=静默");

    writeJson(join(home, ".claude.json"), "{ not json");
    const unknownDir = freshState();
    assert.equal(renderMcpHostAdvisory({ env: session("s3"), cwd: projA, probe: { home }, stateDir: unknownDir }), null, "读不了=unknown=静默（不误报未注册）");
    assert.equal(existsSync(join(unknownDir, "mcp-host-advisory")), false, "判不了不落标记——下次再判");
    writeJson(join(home, ".claude.json"), { mcpServers: { wao: waoEntry(stdioOfThisRepo()) } });
    assert.equal(renderMcpHostAdvisory({ env: session("s4"), cwd: projA, probe: { home }, stateDir: freshState() }), null, "已注册=静默");
    writeJson(join(home, ".claude.json"), { mcpServers: { wao: waoEntry("Z:/other/src/mcp/stdio.js") } });
    assert.equal(renderMcpHostAdvisory({ env: session("s5"), cwd: projA, probe: { home }, stateDir: freshState() }), null, "注册到另一份安装也算有工具=静默");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("决定 0066: opencode 片段形态 + 文件式宿主带 configFile；帮助文本列全表内宿主", async () => {
  const { bindWorkspace } = await import("../../src/application/mcpWorkspaceActivation.js");
  const { HOST_DESCRIPTOR_IDS } = await import("../../src/hostAdapters/hostDescriptors.js");
  const { HELP_TEXT } = await import("../../src/cliHelp.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-0066-emit-"));
  try {
    const oc = await bindWorkspace({ host: "opencode", cwd: dir });
    assert.equal(oc.mode, "snippet");
    assert.equal(oc.snippet.configShape, "opencode-mcp");
    assert.equal(oc.snippet.mcp.wao.type, "local");
    assert.equal(oc.snippet.mcp.wao.command[0], "node");
    assert.ok(oc.snippet.mcp.wao.command.some((a) => a.endsWith("src/mcp/stdio.js")), "opencode 的 command 是整条 argv 数组");
    assert.equal(oc.configFile, "~/.config/opencode/opencode.json");
    const kimi = await bindWorkspace({ host: "kimi-code", cwd: dir });
    assert.equal(kimi.snippet.configShape, "mcpServers");
    assert.equal(kimi.configFile, "~/.kimi-code/mcp.json");
    assert.match(kimi.note, /mcp status --host kimi-code/);
    const cc = await bindWorkspace({ host: "claude-code", cwd: dir });
    assert.equal(cc.configFile, undefined, "有注册子命令的宿主不带 configFile");
    for (const id of HOST_DESCRIPTOR_IDS) {
      assert.ok(HELP_TEXT.includes(id), `--help 的 MCP host registration 节必须列出 ${id}（2026-10-12 反馈：只列 codex 让 Lead 以为别的宿主不支持）`);
    }
    assert.match(HELP_TEXT, /mcp status \[--host <host>\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
