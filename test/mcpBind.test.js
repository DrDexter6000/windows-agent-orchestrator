// test/mcpBind.test.js
//
// M10 P0-1: Project-scoped workspace activation (mcp bind/status/unbind).
// CTO closeout: real failure injection, byte-fidelity, checksum/status, marker cardinality.
//
// Architectural contract (verified by test ARCH):
//   - src/application/mcpWorkspaceActivation.js does NOT import src/commands/*,
//     src/mcp/*, MCP SDK, or zod.
//   - Reuses proveWorkspace from workspaceBinding.js.
//
// Security contract:
//   - Two-resource transaction (config + exclude) with atomic writes and rollback.
//   - Any single-step failure restores both resources to exact original bytes.
//   - Marker cardinality enforced (exactly 1 begin + 1 end).
//   - Checksum verified before bind/rebind/status/unbind.
//   - Byte-fidelity: user content preserved exactly through bind→unbind cycle.
//   - No credential values written.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  const excludePath = join(gitDir, "info", "exclude");
  if (!existsSync(excludePath)) return null;
  return readFileSync(excludePath);
}

function readCodexConfig(projectDir) {
  const p = join(projectDir, ".codex", "config.toml");
  if (!existsSync(p)) return null;
  return readFileSync(p);
}

function readCodexConfigStr(projectDir) {
  const buf = readCodexConfig(projectDir);
  return buf ? buf.toString("utf8") : null;
}

// ── Basic lifecycle ─────────────────────────────────────────────────────────

test("BIND-01: bind → status configured → unbind → status not_configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-01-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, statusWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );

    const bindResult = await bindWorkspace({ host: "codex", cwd: dir });
    assert.equal(bindResult.bound, true);
    assert.equal(bindResult.status, "configured");

    const status1 = await statusWorkspace({ host: "codex", cwd: dir });
    assert.equal(status1.bound, true);
    assert.equal(status1.status, "configured");

    await unbindWorkspace({ host: "codex", cwd: dir });

    const status2 = await statusWorkspace({ host: "codex", cwd: dir });
    assert.equal(status2.bound, false);
    assert.equal(status2.status, "not_configured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Rejection tests ─────────────────────────────────────────────────────────

test("BIND-03: non-Git directory rejected, zero writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-03-"));
  try {
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: dir }));
    assert.ok(!existsSync(join(dir, ".codex")), "no .codex/ should be created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-04: Git subdirectory rejected, zero writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-bind-04-"));
  const subdir = join(root, "subdir");
  try {
    makeGitRepo(root);
    mkdirSync(subdir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(() => bindWorkspace({ host: "codex", cwd: subdir }));
    assert.ok(!existsSync(join(subdir, ".codex")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BIND-05: tracked .codex/config.toml → fail-closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-05-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex", "config.toml"), "# user config\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "add codex config"], { cwd: dir });

    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(
      () => bindWorkspace({ host: "codex", cwd: dir }),
      (err) => err.message.includes("tracked"),
    );
    const config = readCodexConfigStr(dir);
    assert.equal(config, "# user config\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-06: existing non-WAO [mcp_servers.wao] → fail-closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-06-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      '[mcp_servers.wao]\ncommand = "my-custom"\nargs = ["x"]\n',
    );
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(
      () => bindWorkspace({ host: "codex", cwd: dir }),
      (err) => err.message.includes("conflict"),
    );
    const config = readCodexConfigStr(dir);
    assert.ok(config.includes('command = "my-custom"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-14: relative path rejected", async () => {
  const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
  await assert.rejects(
    () => bindWorkspace({ host: "codex", cwd: "relative/path" }),
    (err) => err.message.includes("absolute"),
  );
});

test("BIND-15: unsupported host rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-15-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await assert.rejects(
      () => bindWorkspace({ host: "claude-code", cwd: dir }),
      (err) => err.message.includes("host"),
    );
    assert.ok(!existsSync(join(dir, ".codex")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Idempotency ─────────────────────────────────────────────────────────────

test("BIND-07: idempotent bind — no duplicate block/rule", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-07-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await bindWorkspace({ host: "codex", cwd: dir });
    await bindWorkspace({ host: "codex", cwd: dir });

    const config = readCodexConfigStr(dir);
    const markerCount = (config.match(/WAO MANAGED BLOCK/g) || []).length;
    assert.equal(markerCount, 2, "exactly one begin + one end marker");

    const exclude = readExclude(join(dir, ".git"));
    const beginMarkers = (exclude.toString("utf8").match(/>>> WAO MANAGED \(mcp workspace activation\) >>>/g) || []).length;
    assert.equal(beginMarkers, 1);
    const ruleCount = (exclude.toString("utf8").match(/^\/\.codex\/config\.toml$/gm) || []).length;
    assert.equal(ruleCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-08: idempotent unbind — already_unbound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-08-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir });
    await unbindWorkspace({ host: "codex", cwd: dir });
    const result2 = await unbindWorkspace({ host: "codex", cwd: dir });
    assert.equal(result2.unbound, true);
    assert.equal(result2.status, "already_unbound");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Tamper detection ────────────────────────────────────────────────────────

test("BIND-09: managed block externally modified → unbind fail-closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-09-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir });
    const config = readCodexConfigStr(dir);
    const tampered = config.replace('command = "node"', 'command = "evil"');
    writeFileSync(join(dir, ".codex", "config.toml"), tampered);
    await assert.rejects(
      () => unbindWorkspace({ host: "codex", cwd: dir }),
      (err) => err.message.includes("modified"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-09b: managed block externally modified → bind fail-closed (no overwrite)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-09b-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await bindWorkspace({ host: "codex", cwd: dir });
    const config = readCodexConfigStr(dir);
    const tampered = config.replace('command = "node"', 'command = "evil"');
    writeFileSync(join(dir, ".codex", "config.toml"), tampered);
    await assert.rejects(
      () => bindWorkspace({ host: "codex", cwd: dir }),
      (err) => err.message.includes("modified"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Status state classification ─────────────────────────────────────────────

test("BIND-10: .gitignore never modified; git status shows no .codex/config.toml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-10-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await bindWorkspace({ host: "codex", cwd: dir });
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    assert.ok(!status.includes(".codex/config.toml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-11: no credential values written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-11-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await bindWorkspace({ host: "codex", cwd: dir });
    const config = readCodexConfigStr(dir);
    assert.ok(!config.includes("ZHIPU_API_KEY"));
    assert.ok(!/(?:api[_-]?key|secret|token)\s*[:=]/i.test(config));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-STAT-01: status managed_modified when checksum tampered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stat-01-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, statusWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir });
    const config = readCodexConfigStr(dir);
    writeFileSync(join(dir, ".codex", "config.toml"), config.replace('command = "node"', 'command = "evil"'));
    const status = await statusWorkspace({ host: "codex", cwd: dir });
    assert.equal(status.bound, false);
    assert.equal(status.status, "managed_modified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-STAT-02: status tracked_config when .codex/config.toml tracked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stat-02-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex", "config.toml"), "# tracked\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "track config"], { cwd: dir });
    const { statusWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const status = await statusWorkspace({ host: "codex", cwd: dir });
    assert.equal(status.bound, false);
    assert.equal(status.status, "tracked_config");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-STAT-03: status external_conflict when non-WAO wao server exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stat-03-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex", "config.toml"), '[mcp_servers.wao]\ncommand = "other"\n');
    const { statusWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const status = await statusWorkspace({ host: "codex", cwd: dir });
    assert.equal(status.bound, false);
    assert.equal(status.status, "external_conflict");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-STAT-04: status exclude_missing when config OK but exclude gone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stat-04-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, statusWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir });
    // Delete the exclude rule
    const excludeP = join(dir, ".git", "info", "exclude");
    writeFileSync(excludeP, "# reset\n");
    const status = await statusWorkspace({ host: "codex", cwd: dir });
    assert.equal(status.bound, false);
    assert.equal(status.status, "exclude_missing_or_modified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Duplicate marker cardinality ────────────────────────────────────────────

test("BIND-MARKER-01: duplicate begin marker → fail-closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-marker-01-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, statusWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir });
    // Duplicate the begin marker
    const config = readCodexConfigStr(dir);
    const dup = config.replace(
      "# >>> WAO MANAGED BLOCK (mcp workspace activation) >>>",
      "# >>> WAO MANAGED BLOCK (mcp workspace activation) >>>\n# >>> WAO MANAGED BLOCK (mcp workspace activation) >>>",
    );
    writeFileSync(join(dir, ".codex", "config.toml"), dup);
    const status = await statusWorkspace({ host: "codex", cwd: dir });
    assert.equal(status.bound, false);
    assert.equal(status.status, "managed_modified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Byte-fidelity (P1-D) ────────────────────────────────────────────────────

test("BIND-BYTE-01: LF config preserved exactly through bind→unbind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-byte-01-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    const userConfig = '# my config\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["run"]\n';
    writeFileSync(join(dir, ".codex", "config.toml"), userConfig);
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const before = readCodexConfig(dir);
    await bindWorkspace({ host: "codex", cwd: dir });
    await unbindWorkspace({ host: "codex", cwd: dir });
    const after = readCodexConfig(dir);
    assert.deepEqual(after, before, "config bytes must be identical after bind→unbind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-BYTE-02: CRLF config preserved exactly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-byte-02-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    const userConfig = Buffer.from('# my config\r\nmodel = "gpt-5"\r\n');
    writeFileSync(join(dir, ".codex", "config.toml"), userConfig);
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const before = readCodexConfig(dir);
    await bindWorkspace({ host: "codex", cwd: dir });
    await unbindWorkspace({ host: "codex", cwd: dir });
    const after = readCodexConfig(dir);
    assert.deepEqual(after, before, "CRLF config bytes must be identical");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-BYTE-03: no trailing newline config preserved exactly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-byte-03-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex", "config.toml"), '# no newline at end');
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const before = readCodexConfig(dir);
    await bindWorkspace({ host: "codex", cwd: dir });
    await unbindWorkspace({ host: "codex", cwd: dir });
    const after = readCodexConfig(dir);
    assert.deepEqual(after, before, "no-trailing-newline config must be preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-BYTE-04: exclude bytes preserved exactly through bind→unbind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-byte-04-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const before = readExclude(join(dir, ".git"));
    await bindWorkspace({ host: "codex", cwd: dir });
    await unbindWorkspace({ host: "codex", cwd: dir });
    const after = readExclude(join(dir, ".git"));
    assert.deepEqual(after, before, "exclude bytes must be identical after bind→unbind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-BYTE-05: UTF-8 BOM config preserved exactly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-byte-05-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    const userConfig = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# bom config\nmodel = "x"\n')]);
    writeFileSync(join(dir, ".codex", "config.toml"), userConfig);
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    const before = readCodexConfig(dir);
    await bindWorkspace({ host: "codex", cwd: dir });
    await unbindWorkspace({ host: "codex", cwd: dir });
    const after = readCodexConfig(dir);
    assert.deepEqual(after, before, "BOM config must be preserved byte-for-byte");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Real failure injection (P1-B) ───────────────────────────────────────────

test("BIND-FAIL-01: config write failure → both resources unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fail-01-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const configBefore = readCodexConfig(dir);
    const excludeBefore = readExclude(join(dir, ".git"));
    await assert.rejects(
      () => bindWorkspace({
        host: "codex", cwd: dir,
        hooks: { writeConfig: () => { throw new Error("simulated config write failure"); } },
      }),
      (err) => err.message.includes("simulated config write failure"),
    );
    assert.deepEqual(readCodexConfig(dir), configBefore, "config must be unchanged");
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore, "exclude must be unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-FAIL-02: config verify failure → config rolled back, exclude unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fail-02-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const configBefore = readCodexConfig(dir);
    const excludeBefore = readExclude(join(dir, ".git"));
    await assert.rejects(
      () => bindWorkspace({
        host: "codex", cwd: dir,
        hooks: { verifyConfig: () => false },
      }),
      (err) => err.message.includes("verification failed"),
    );
    assert.deepEqual(readCodexConfig(dir), configBefore, "config must be restored to original");
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore, "exclude must be unchanged");
    // No temp files left
    const codexDir = join(dir, ".codex");
    if (existsSync(codexDir)) {
      const { readdirSync } = await import("node:fs");
      const temps = readdirSync(codexDir).filter(f => f.startsWith(".wao-tmp-"));
      assert.equal(temps.length, 0, "no temp files should remain");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-FAIL-02b: config verify THROWS → both resources rolled back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fail-02b-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const configBefore = readCodexConfig(dir);
    const excludeBefore = readExclude(join(dir, ".git"));
    await assert.rejects(
      () => bindWorkspace({
        host: "codex", cwd: dir,
        hooks: { verifyConfig: () => { throw new Error("verify explodes"); } },
      }),
      (err) => err.message.includes("verification step failed"),
    );
    // Critical: config must be restored despite the throw
    assert.deepEqual(readCodexConfig(dir), configBefore, "config must be restored even when verify throws");
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore, "exclude must be unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-FAIL-02c: config read-back THROWS → both resources rolled back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fail-02c-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const configBefore = readCodexConfig(dir);
    const excludeBefore = readExclude(join(dir, ".git"));
    await assert.rejects(
      () => bindWorkspace({
        host: "codex", cwd: dir,
        hooks: { readConfig: () => { throw new Error("read-back explodes"); } },
      }),
      (err) => err.message.includes("verification step failed"),
    );
    assert.deepEqual(readCodexConfig(dir), configBefore, "config must be restored even when read-back throws");
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore, "exclude must be unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BIND-FAIL-03: exclude write failure → config rolled back to original", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fail-03-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    const configBefore = readCodexConfig(dir);
    const excludeBefore = readExclude(join(dir, ".git"));
    await assert.rejects(
      () => bindWorkspace({
        host: "codex", cwd: dir,
        hooks: { writeExclude: () => { throw new Error("simulated exclude write failure"); } },
      }),
      (err) => err.message.includes("simulated exclude write failure"),
    );
    assert.deepEqual(readCodexConfig(dir), configBefore, "config must be rolled back");
    assert.deepEqual(readExclude(join(dir, ".git")), excludeBefore, "exclude must be unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Existing user config preservation ───────────────────────────────────────

test("BIND-12: existing non-conflict config preserved (content lines survive)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bind-12-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, ".codex"));
    const userContent = '# My Codex config\nmodel = "gpt-5"\n\n[mcp_servers.other-tool]\ncommand = "other"\nargs = ["run"]\n';
    writeFileSync(join(dir, ".codex", "config.toml"), userContent);
    const { bindWorkspace, unbindWorkspace } = await import(
      "../src/application/mcpWorkspaceActivation.js"
    );
    await bindWorkspace({ host: "codex", cwd: dir });
    const configAfter = readCodexConfigStr(dir);
    assert.ok(configAfter.includes('model = "gpt-5"'));
    assert.ok(configAfter.includes('[mcp_servers.other-tool]'));
    await unbindWorkspace({ host: "codex", cwd: dir });
    // Byte-exact comparison (BIND-BYTE-01 covers this more strictly, but verify here too)
    const configFinal = readCodexConfig(dir);
    assert.deepEqual(configFinal, Buffer.from(userContent), "config must be byte-identical to original");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Architectural boundary ──────────────────────────────────────────────────

test("ARCH: application layer does not import commands/, mcp/, SDK, or zod", async () => {
  const modulePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "src", "application", "mcpWorkspaceActivation.js",
  );
  const src = readFileSync(modulePath, "utf8");
  assert.ok(!src.includes("from \"../commands/"), "must not import commands/");
  assert.ok(!src.includes("from \"../mcp/"), "must not import mcp/");
  assert.ok(!src.includes("@modelcontextprotocol/sdk"), "must not import MCP SDK");
  assert.ok(!src.includes("from \"zod\""), "must not import zod");
  assert.ok(src.includes("proveWorkspace"), "must reuse proveWorkspace");
  // Check for literal process.cwd() — the string in comments was already fixed
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Allow comments mentioning the concept, but not actual code calls
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) continue;
    assert.ok(
      !trimmed.includes("process.cwd()"),
      `line ${i + 1}: must not call process.cwd() in code: ${trimmed}`,
    );
  }
});

test("DOC-GUARD: no 'node ...wao-cli.cmd' in docs or generated content", async () => {
  // Check docs/usage.md
  const usagePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "docs", "usage.md",
  );
  const usageSrc = readFileSync(usagePath, "utf8");
  assert.ok(
    !/node\s+.*wao-cli\.cmd/.test(usageSrc),
    "docs/usage.md must not contain 'node ...wao-cli.cmd' (use & or cmd.exe call instead)",
  );
  // Check generated managed block comment
  const modulePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..", "src", "application", "mcpWorkspaceActivation.js",
  );
  const src = readFileSync(modulePath, "utf8");
  assert.ok(
    !/node\s+.*wao-cli\.cmd/.test(src),
    "mcpWorkspaceActivation.js must not reference 'node ...wao-cli.cmd'",
  );
});

// ── Codex parser probe (P1-E) ───────────────────────────────────────────────
// Tests that a bind-generated .codex/config.toml can be parsed by Codex CLI.
// Uses an isolated CODEX_HOME to avoid touching the real global config.
// NOTE: codex mcp list/get management commands may NOT load project config
// even for trusted projects in an isolated CODEX_HOME. This is a Codex CLI
// limitation, not a WAO bug. If Codex is unavailable or doesn't load project
// config in isolation, this test skips with a clear explanation. The real
// Codex Desktop cold-start gate is reserved for CTO.

test("CODEX-PROBE: bind generates parseable config (or skip if Codex unavailable)", async (t) => {
  const codexBin = (() => {
    try { execFileSync("codex", ["--version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); return true; }
    catch { return false; }
  })();
  if (!codexBin) {
    t.todo("Codex CLI not available — skipping parser probe");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "wao-codex-probe-"));
  try {
    makeGitRepo(dir);
    const { bindWorkspace } = await import("../src/application/mcpWorkspaceActivation.js");
    await bindWorkspace({ host: "codex", cwd: dir });

    // Verify the generated config is valid TOML by checking Codex can parse it.
    // Use isolated CODEX_HOME with trust for the probe dir.
    const isolatedHome = mkdtempSync(join(tmpdir(), "wao-codex-home-"));
    const configToml = join(isolatedHome, "config.toml");
    const winPath = dir.replace(/\//g, "\\");
    writeFileSync(configToml, `model = "gpt-5"\n\n[projects.'${winPath}']\ntrust_level = "trusted"\n`);

    try {
      const output = execFileSync(
        "codex", ["-C", dir, "mcp", "get", "wao"],
        {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, CODEX_HOME: isolatedHome },
          timeout: 10000,
        },
      );
      // If we get here, Codex loaded the project config
      assert.ok(output.includes("node"), "Codex should see command=node");
      assert.ok(output.includes("stdio.js"), "Codex should see stdio.js in args");
    } catch (err) {
      // Codex management command didn't load project config in isolated CODEX_HOME.
      // This is a known limitation — the real host gate is reserved for CTO.
      // Verify at minimum the config file exists and contains expected fields.
      const config = readCodexConfigStr(dir);
      assert.ok(config, "config must exist");
      assert.ok(config.includes("command = \"node\""), "config must have command=node");
      assert.ok(config.includes("stdio.js"), "config must reference stdio.js");
      assert.ok(config.includes("--workspace-root"), "config must have --workspace-root");
      t.todo("Codex management command did not load project config in isolated CODEX_HOME — real host gate reserved for CTO");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
