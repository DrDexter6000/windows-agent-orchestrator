// test/mcpRunDispatch.test.js
//
// M9-2B: MCP run_dispatch tool — TDD tests.
//
// Proves that an MCP host can dispatch a supervised background run via the
// run_dispatch tool, which calls the M9-2A dispatchRun() application service.
// Covers: tool list shape, exactly-once service invocation, server-owned paths,
// advisory requireCertified:false (certification is recorded reliability
// evidence, never a permission gate — the Lead may dispatch any configured
// worker), safe output (no paths/PID/prompt/argv), strict input rejection (a
// client cannot inject or override the server-owned flag), error redaction,
// real stdio no-model integration, detached runner terminal state after MCP
// host closes, CLI/MCP parity, and the summary-less Fresh clone regression
// (no reliability-summary.json → dispatch reaches the detached path, never a
// certification-gate refusal).

import { test } from "node:test";
import { resolveTranscriptPath } from "../../src/projectBuckets.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { dispatchRun as realDispatchRun } from "../../src/application/runDispatch.js";
import { readTranscript, findState, findLatest } from "../../src/transcript.js";
// 第 147 批：分支帽提示的 SSOT 与采样/记账拆分（MCP 回执用例注入同一对函数）。
import {
  sampleDispatchResourceAdvisory,
  commitDispatchResourceAdvisory,
  BRANCH_CAP,
} from "../../src/dispatchResourceAdvisory.js";
// 2026-10-04 drift pin: 后端闭集 SSOT（resolver parity 遍历源）。
import { KNOWN_BACKENDS } from "../../src/registry.js";
// TD-168: run_dispatch 输入键集合 SSOT（安全字段边界合同——缺键/多键都该红）。
import { RUN_DISPATCH_INPUT_KEYS } from "../fixtures/mcpWireKeySets.js";
// 第 156 批修正一：laneRules 出口预校验的固定降级原因（不在测试里抄第二份）。
import { RULES_UNAVAILABLE_REASON } from "../../src/application/laneRules.js";
import { deriveOwnerTitle } from "../../src/application/ownerReadModel.js";
import { createSecretRedactor } from "../../src/secretRedaction.js";

// ===== Helpers =====

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeSummary(runDir, workers) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({ workers }), "utf8");
  return runDir;
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeGitRepo(dir) {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@test.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: dir, stdio: 'pipe' });
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function buildStdioSubprocessTransport({ registryPath, runDir, workspaceRoot, env = {} }) {
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  // 第 147 批修正一：stdio 入口会接真实的分支帽采样/记账——子进程状态目录指到
  // os.tmpdir()（测试套件已把 TEMP 隔离成一次性目录），不碰用户真实 %LOCALAPPDATA%。
  // LOCALAPPDATA 被改写后版本守卫找不到用户级 Node 22 安装，故同时钉 WAO_NODE
  // 到本测试进程的 v22 可执行文件（守卫的既有逃生口）。
  const childEnv = {
    ...process.env,
    WAO_SKIP_VERSION_GUARD: "1",
    WAO_NODE: process.execPath,
    LOCALAPPDATA: join(tmpdir(), "wao-mcp-advisory-state"),
    ...env,
  };
  const args = [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir];
  if (workspaceRoot) args.push("--workspace-root", workspaceRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: childEnv,
  });
  return transport;
}

// ===== Tests =====

// ---------------------------------------------------------------------
// M9-2B-01: tools/list has run_dispatch with the strict schema and annotations
//           (0129: registry_list is folded into lead_preflight.workers).
// ---------------------------------------------------------------------

test("M9-2B-01: tools/list has run_dispatch with strict schema and annotations (0129: registry_list folded into lead_preflight)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-01-"));
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.ok(names.includes("run_dispatch"), "run_dispatch present");
      assert.ok(names.includes("lead_preflight"), "lead_preflight present (registry_list's survivor, decision 0129)");
      assert.equal(names.includes("registry_list"), false, "registry_list folded away (decision 0129)");

      const rd = tools.tools.find((t) => t.name === "run_dispatch");
      assert.ok(rd, "run_dispatch present");
      // Strict input: agentId + prompt required, delivery + the M12-6 (FR-03)
      // optional workspace/head freeze inputs + the M12-7 optional continuable
      // lineage opt-in + the M12-9 optional executionProfileId + the M12-16
      // optional correctable in-flight-correction opt-in.
      const inputKeys = Object.keys(rd.inputSchema.properties ?? {}).sort();
      // TD-168: 键集合改读共享 SSOT（原手抄数组逐键相同，断言语义不变）。
      assert.deepEqual(inputKeys,
        RUN_DISPATCH_INPUT_KEYS,
        "input schema has agentId + prompt + optional delivery + optional expectations + optional continuable + optional correctable + optional executionProfileId + optional readOnly (Round 4 advisory declaration) + optional model/reasoning per-dispatch overrides (R10-A/R11-1)",
      );
      assert.equal(rd.inputSchema.additionalProperties, false, "input is strict");
      // Annotations: not read-only, destructive (worker may modify files/run commands),
      // not idempotent, open-world (dispatches real work).
      assert.equal(rd.annotations.readOnlyHint, false, "readOnlyHint:false");
      assert.equal(rd.annotations.destructiveHint, true, "destructiveHint:true (worker can mutate files/execute commands)");
      assert.equal(rd.annotations.idempotentHint, false, "idempotentHint:false");
      assert.equal(rd.annotations.openWorldHint, true, "openWorldHint:true");
      // Output schema declared.
      assert.ok(rd.outputSchema, "output schema declared");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-02: injected dispatcher called exactly once, receives server-owned paths
//           and advisory requireCertified:false; model cannot override paths or
//           the certification flag.
// ---------------------------------------------------------------------

test("M9-2B-02: run_dispatch calls dispatcher once with server paths and advisory requireCertified:false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-02-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let callCount = 0;
    let captured = null;
    const fakeDispatch = async (input) => {
      callCount += 1;
      captured = input;
      return { accepted: true, runId: "run_fake_m92b02", state: "pending", transcriptPath: "/x.jsonl" };
    };

    const server = createWaoMcpServer({
      registryPath,
      runDir: "/server/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "coder_low", prompt: "do it", expectedWorkspaceRoot: dir } });
      assert.equal(callCount, 1, "dispatcher called exactly once");
      assert.ok(captured.registryPath, "server-owned registryPath passed through");
      assert.equal(captured.runDir, "/server/runs", "server-owned runDir");
      assert.equal(captured.requireCertified, false, "certification is advisory: requireCertified fixed false (not a permission gate)");
      assert.equal(captured.agentId, "coder_low");
      assert.equal(captured.prompt, "do it");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-03: success output contains only runId/accepted/state — no paths/PID/prompt/argv.
// ---------------------------------------------------------------------

test("M9-2B-03: run_dispatch success output has only runId/agentId/accepted/state, no leaks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-03-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const fakeDispatch = async () => ({
      accepted: true,
      runId: "run_ok_m92b03",
      agentId: "x",
      state: "pending",
      // M12-25: providerSessionRouting is required truth (no MCP fallback), so a
      // fake dispatcher must return it explicitly like the real dispatchRun does.
      providerSessionRouting: "not_used",
      transcriptPath: "/secret/runs/run_ok_m92b03.jsonl",
    });

    const server = createWaoMcpServer({
      registryPath,
      runDir: "/server/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "secret-prompt-value", expectedWorkspaceRoot: dir } });
      const textBlock = res.content.find((b) => b.type === "text");
      const parsed = JSON.parse(textBlock.text);

      // M11-8B added agentId; M12-6 (FR-03) adds the additive bounded workspaceProof;
      // M12-25 adds additive providerSessionRouting (routing REQUEST truth).
      assert.deepEqual(Object.keys(parsed).sort(),
        ["accepted", "agentId", "continuable", "label", "laneRules", "nextStep", "providerSessionRouting", "runId", "state", "workspaceProof"],
        "only runId/agentId/accepted/state + additive workspaceProof + additive providerSessionRouting");
      assert.equal(parsed.accepted, true);
      assert.equal(parsed.runId, "run_ok_m92b03");
      assert.equal(parsed.agentId, "x");
      assert.equal(parsed.state, "pending");
      // M12-6 (FR-03): the proof is bounded — source/head/dirty + nullable match
      // booleans, NEVER the absolute workspace path.
      assert.deepEqual(Object.keys(parsed.workspaceProof).sort(),
        ["dirty", "expectedDirtyMatch", "expectedGitHeadMatch", "expectedWorkspaceRootMatch", "gitHead", "source"],
        "workspaceProof has source/head/dirty + 3 nullable match booleans");
      assert.ok(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(parsed.workspaceProof.gitHead), "proof gitHead is canonical hex");
      assert.equal(typeof parsed.workspaceProof.dirty, "boolean", "proof dirty is boolean");
      // No head/dirty expectations were supplied → those booleans are null. The
      // root expectation is structurally satisfied (the target IS the requested
      // root) and the proof reports the per-call target source.
      assert.equal(parsed.workspaceProof.expectedGitHeadMatch, null);
      assert.equal(parsed.workspaceProof.expectedDirtyMatch, null);
      assert.equal(parsed.workspaceProof.expectedWorkspaceRootMatch, true);
      assert.equal(parsed.workspaceProof.source, "call_target");

      // No leaks.
      // 第 156 批（TD-384）：label 有意携带任务书标题的有界安全投影（≤80、脱敏、
      // 清控制字符——与 Owner 看板同一取法；prompt 是调用方本call刚提交的，无信息
      // 不对称），是唯一允许 prompt 派生文本的字段；防泄漏断言剥掉 label 后仍成立。
      assert.equal(parsed.label, "[x] secret-prompt-value", "label=标题的有界投影（唯一 prompt 派生字段）");
      const dumped = JSON.stringify(res)
        .split(JSON.stringify(parsed.label)).join("")
        .split(parsed.label).join("");
      assert.ok(!dumped.includes("/secret/runs"), "no transcriptPath leak");
      assert.ok(!dumped.includes("secret-prompt-value"), "no prompt leak（label 之外零回显）");
      assert.ok(!dumped.includes("argv"), "no argv leak");
      // M12-6 (FR-03): the workspace proof must NOT echo the absolute workspace
      // root (forward-slash canonicalized form included for cross-platform safety).
      assert.ok(!dumped.includes(dir.replace(/\\/g, "/")), "no absolute workspace root leak in proof");
      // structuredContent mirrors content.
      if (res.structuredContent) {
        assert.deepEqual(res.structuredContent, parsed, "structuredContent matches text JSON");
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
// M9-2B-04: extra/control-plane args rejected by strict schema; dispatcher count 0.
// ---------------------------------------------------------------------

test("M9-2B-04: control-plane args rejected, dispatcher not called", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };

  const server = createWaoMcpServer({
    registryPath: "/server/registry.json",
    runDir: "/server/runs",
    dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    const badArgsList = [
      { agentId: "x", prompt: "y", registryPath: "/attacker/r.json" },
      { agentId: "x", prompt: "y", runDir: "/attacker/runs" },
      // requireCertified is server-owned: a client can neither disable the gate
      // (false) nor force it (true) via tool arguments — both are rejected by
      // the strict schema before the service is ever called.
      { agentId: "x", prompt: "y", requireCertified: false },
      { agentId: "x", prompt: "y", requireCertified: true },
      { agentId: "x", prompt: "y", runId: "run_evil" },
      { agentId: "x", prompt: "y", cwd: "/evil" },
      { agentId: "x", prompt: "y", evil: true },
      // M10-pre closeout-2: MCP tool input must NOT control timeout values.
      // waitTimeout and globalWaitTimeout are server-owned; the model cannot set them.
      { agentId: "x", prompt: "y", waitTimeout: 999 },
      { agentId: "x", prompt: "y", waitTimeout: 600000 },
      { agentId: "x", prompt: "y", globalWaitTimeout: 300000 },
      { agentId: "x", prompt: "y", globalWaitTimeout: 999999 },
    ];
    for (const bad of badArgsList) {
      let rejected = false;
      let result = null;
      try {
        result = await client.callTool({ name: "run_dispatch", arguments: bad });
      } catch {
        // A protocol-level rejection (throw) is a valid rejection.
        rejected = true;
      }
      if (!rejected) {
        // If it returned a result, it must be an explicit tool error — never success.
        assert.equal(result.isError, true,
          `control-plane arg ${JSON.stringify(Object.keys(bad))} must be rejected, got success`);
        rejected = true;
      }
      assert.ok(rejected, `every control-plane arg must be rejected: ${JSON.stringify(Object.keys(bad))}`);
    }
    assert.equal(callCount, 0, "dispatcher never called for any control-plane arg");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// M9-2B-05: dispatcher throw with secret + absolute path → fixed "run_dispatch failed".
// ---------------------------------------------------------------------

test("M9-2B-05: dispatcher error returns fixed safe text, no secret/path leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-05-"));
  try {
    makeGitRepo(dir);
    const SECRET = "test-secret-dispatch-leak-m92b05";
    const ABS_PATH = "C:\\Users\\leak\\runs\\secret.jsonl";
    const fakeDispatch = async () => {
      throw new Error(`dispatch crashed at ${ABS_PATH} key=${SECRET}`);
    };

    const server = createWaoMcpServer({
      registryPath: "/server/registry.json",
      runDir: "/server/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y", expectedWorkspaceRoot: dir } });
      assert.equal(res.isError, true, "error flagged");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(SECRET), "no secret leak");
      assert.ok(!dumped.includes(ABS_PATH), "no absolute path leak");
      assert.ok(!dumped.includes("C:\\\\Users"), "no path fragment leak");
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.ok(/run_dispatch failed/.test(text), "fixed safe text present");
      assert.ok(!/at .*\(.+:\d+:\d+\)/.test(text), "no stack frame");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-06: real stdio no-model integration — temp registry, fresh summary,
//           nonexistent backend binary. Transcript reaches pending then failed.
// ---------------------------------------------------------------------

test("M9-2B-06: real stdio run_dispatch reaches pending, runner drives to failed terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-06-"));
  let client;
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, {
      failing_worker: {
        backend: "claude-code",
        binary: "definitely-nonexistent-m92b-06",
        cwd: dir,
      },
    });
    const runDir = makeSummary(dir, { failing_worker: { status: "certified" } });

    const { Client } = await import("@modelcontextprotocol/sdk/client");
    client = new Client({ name: "wao-m92b-06", version: "0.0.1" }, { capabilities: {} });
    const transport = await buildStdioSubprocessTransport({ registryPath, runDir, workspaceRoot: dir });
    await client.connect(transport);

    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "failing_worker", prompt: "bounded task", expectedWorkspaceRoot: dir },
    });
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);
    assert.equal(parsed.accepted, true, "dispatch accepted");
    assert.equal(parsed.state, "pending", "initial state pending");
    const runId = parsed.runId;
    assert.ok(runId, "runId returned");

    // Transcript must already be readable and pending at return time.
    const transcriptPath = resolveTranscriptPath(runDir, runId);
    assert.ok(existsSync(transcriptPath), "transcript exists at MCP return");
    const earlyEvents = await readTranscript(transcriptPath);
    assert.equal(findState(earlyEvents), "pending", "transcript pending at return");

    // Close MCP host — detached runner must continue independently to failed terminal.
    await client.close();
    client = null;

    let events = earlyEvents;
    for (let i = 0; i < 80; i += 1) {
      events = await readTranscript(transcriptPath);
      if (["failed", "completed", "aborted", "timed_out"].includes(findState(events))) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(findState(events), "failed", "runner drove nonexistent binary to failed");

    // Ownership heartbeat file cleared after runner exit.
    const ownerFile = join(runDir, `.owner-${runId}`);
    for (let i = 0; i < 40; i += 1) {
      if (!existsSync(ownerFile)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(!existsSync(ownerFile), "ownership heartbeat cleared after runner exit");
  } finally {
    if (client) await client.close();
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-08 (Fresh Host onboarding regression): a configured worker with NO
// reliability-summary.json must dispatch through the real MCP boundary + real
// application service + detached runner. Certification is advisory evidence,
// never a permission gate — the run must NOT die at the certification gate
// before the provider spawns. Fixture is fully synthetic: nonexistent binary,
// no credentials, no model call.
// ---------------------------------------------------------------------

test("M9-2B-08: summary-less Fresh clone dispatches via real MCP + detached runner, no certification-gate refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-08-"));
  let client;
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, {
      fresh_worker: {
        backend: "claude-code",
        binary: "definitely-nonexistent-m92b-08",
        cwd: dir,
      },
    });
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    // Causal precondition: this Fresh clone (wao onboarding --apply) has NO
    // reliability-summary.json. Under a hardcoded certification gate the first
    // MCP run would be refused here before the provider ever spawns.
    assert.ok(!existsSync(join(runDir, "reliability-summary.json")),
      "fixture has no reliability-summary.json");

    const { Client } = await import("@modelcontextprotocol/sdk/client");
    client = new Client({ name: "wao-m92b-08", version: "0.0.1" }, { capabilities: {} });
    const transport = await buildStdioSubprocessTransport({ registryPath, runDir, workspaceRoot: dir });
    await client.connect(transport);

    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "fresh_worker", prompt: "bounded task", expectedWorkspaceRoot: dir },
    });
    // The certification gate must NOT fire anywhere in the path. Note the gate
    // (when enabled) fires INSIDE the detached runner — RunManager.start appends
    // a certification-gate run.error and refuses before the provider spawns —
    // so the MCP boundary still returns an acceptance; the causal proof lives
    // in the transcript below (no certification-gate event, worker reaches the
    // real detached path).
    assert.equal(res.isError, undefined, "tool returns a normal (non-error) result");
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);
    assert.equal(parsed.accepted, true, "dispatch accepted");
    assert.equal(parsed.state, "pending", "initial state pending");
    const runId = parsed.runId;
    assert.ok(runId, "runId returned");

    // The application/detached path ran: a transcript exists at MCP return and
    // the detached runner drove the nonexistent binary to a terminal failure.
    const transcriptPath = resolveTranscriptPath(runDir, runId);
    assert.ok(existsSync(transcriptPath), "transcript exists at MCP return (application path ran)");
    const earlyEvents = await readTranscript(transcriptPath);
    assert.equal(findState(earlyEvents), "pending", "transcript pending at return");

    // Close MCP host — detached runner must continue independently.
    await client.close();
    client = null;

    let events = earlyEvents;
    for (let i = 0; i < 80; i += 1) {
      events = await readTranscript(transcriptPath);
      if (["failed", "completed", "aborted", "timed_out"].includes(findState(events))) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // Terminal "failed" from the nonexistent binary — under the old hardcoded
    // gate this terminal would be reached via a certification-gate refusal
    // (run.error phase=certification-gate appended, provider never spawned).
    assert.equal(findState(events), "failed", "runner drove nonexistent binary to failed terminal");
    assert.ok(!events.some((e) => e.type === "run.error" && e.phase === "certification-gate"),
      "no certification-gate error event in transcript (gate never fired)");
  } finally {
    if (client) await client.close();
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// M9-2B-07: CLI and MCP dispatch the same agent produce the same initial durable
//           facts (background_submitted + pending) and the same outcome type.
// ---------------------------------------------------------------------

test("M9-2B-07: CLI and MCP dispatch produce same initial durable facts and outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m92b-07-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, {
      parity_worker: {
        backend: "claude-code",
        binary: "nonexistent-parity-m92b-07",
        cwd: dir,
      },
    });
    const runDir = makeSummary(dir, { parity_worker: { status: "certified" } });

    // MCP dispatch via in-memory server + real dispatchRun.
    const mcpServer = createWaoMcpServer({ registryPath, runDir, workspaceRoot: dir });
    const mcpClient = await buildInMemoryClient(mcpServer);
    let mcpRunId;
    try {
      const res = await mcpClient.callTool({
        name: "run_dispatch",
        arguments: { agentId: "parity_worker", prompt: "parity task", expectedWorkspaceRoot: dir },
      });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      mcpRunId = parsed.runId;
      await mcpClient.close();
    } finally {
      await mcpServer.close();
    }

    // CLI dispatch (subprocess) with the same registry/runDir.
    const cliRunDir = join(dir, "cli-runs");
    mkdirSync(cliRunDir, { recursive: true });
    // Re-create summary in cli runDir.
    writeFileSync(join(cliRunDir, "reliability-summary.json"), JSON.stringify({ workers: { parity_worker: { status: "certified" } } }), "utf8");
    const cliOut = execSync(
      `node src/cli.js run parity_worker --prompt "parity task" --background --registry ${registryPath} --run-dir ${cliRunDir} --format json`,
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" }, timeout: 10000 },
    );
    const cliParsed = JSON.parse(cliOut.slice(cliOut.indexOf("{"), cliOut.lastIndexOf("}") + 1));
    const cliRunId = cliParsed.runId;

    // Wait for both to reach terminal.
    async function waitForTerminal(rd, rid) {
      // D2-②b：经解析链定位（分桶转录）。
      const tp = resolveTranscriptPath(rd, rid);
      let evs = [];
      for (let i = 0; i < 80; i += 1) {
        if (existsSync(tp)) {
          evs = await readTranscript(tp);
          if (["failed", "completed", "aborted", "timed_out"].includes(findState(evs))) break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return evs;
    }
    const [mcpEvents, cliEvents] = await Promise.all([
      waitForTerminal(runDir, mcpRunId),
      waitForTerminal(cliRunDir, cliRunId),
    ]);

    // Same initial durable facts.
    assert.ok(findLatest(mcpEvents, "run.background_submitted"), "MCP wrote background_submitted");
    assert.ok(findLatest(cliEvents, "run.background_submitted"), "CLI wrote background_submitted");
    assert.ok(mcpEvents.some((e) => e.type === "run.state_change" && e.to === "pending"), "MCP pending");
    assert.ok(cliEvents.some((e) => e.type === "run.state_change" && e.to === "pending"), "CLI pending");
    // Same outcome type (both failed — nonexistent binary).
    assert.equal(findState(mcpEvents), "failed", "MCP failed terminal");
    assert.equal(findState(cliEvents), "failed", "CLI failed terminal");
  } finally {
    cleanupDir(dir);
  }
});

// ===== M9-7A: delivery-capable dispatch tests =====

test("M9-7A-04: MCP run_dispatch with delivery passes delivery to service", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m97a-04-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let callCount = 0;
    let captured = null;
    const fakeDispatch = async (input) => {
      callCount += 1;
      captured = input;
      return { accepted: true, runId: "run_delivery_m97a", agentId: "coder_low", state: "pending", providerSessionRouting: "not_used", transcriptPath: "/x.jsonl" };
    };
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs",
      workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
    });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: {
        agentId: "coder_low", prompt: "do it", expectedWorkspaceRoot: dir,
        delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
      },
    });
    assert.equal(callCount, 1);
    assert.ok(captured.delivery, "service received delivery");
    assert.equal(captured.delivery.mode, "git_commit_v1");
    assert.equal(captured.requireCertified, false, "certification advisory on delivery runs too (never forced)");
    const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
    assert.deepEqual(Object.keys(parsed).sort(),
      ["accepted", "agentId", "continuable", "label", "laneRules", "nextStep", "providerSessionRouting", "runId", "state", "workspaceProof"],
      "output has agentId (M11-8B) + additive workspaceProof (M12-6) + additive providerSessionRouting (M12-25)");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M9-7A-05: MCP delivery with both commands+reason rejected, service count 0", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs", dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    let rejected = false;
    let result = null;
    try {
      result = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "x", prompt: "y",
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"], verificationUnavailableReason: "no" },
        },
      });
    } catch { rejected = true; }
    if (!rejected) { assert.equal(result.isError, true, "both commands+reason rejected"); rejected = true; }
    assert.ok(rejected);
    assert.equal(callCount, 0, "service never called");
  } finally {
    await client.close();
    await server.close();
  }
});

test("M9-7A-06: MCP delivery with no verification rejected, service count 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m97a-06-"));
  try {
    makeGitRepo(dir);
    let callCount = 0;
    const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: join(dir, "runs"), dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      let rejected = false;
      let result = null;
      try {
        result = await client.callTool({
          name: "run_dispatch",
          arguments: {
            agentId: "x", prompt: "y", expectedWorkspaceRoot: dir,
            delivery: { mode: "git_commit_v1", allowedPaths: ["src"] },
          },
        });
      } catch { rejected = true; }
      if (!rejected) { assert.equal(result.isError, true); rejected = true; }
      assert.ok(rejected);
      assert.equal(callCount, 0);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M9-7A-07: non-delivery dispatch still works identically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m97a-07-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    let callCount = 0;
    let captured = null;
    const fakeDispatch = async (input) => {
      callCount += 1;
      captured = input;
      return { accepted: true, runId: "r", state: "pending" };
    };
    const server = createWaoMcpServer({
      registryPath, runDir: "/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y", expectedWorkspaceRoot: dir } });
      assert.equal(callCount, 1);
      assert.ok(!captured.delivery, "no delivery forwarded for non-delivery dispatch");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M9-7A-08: empty/whitespace verification values rejected at adapter, service count 0", async () => {
  let callCount = 0;
  const fakeDispatch = async () => { callCount += 1; return { accepted: true, runId: "x", state: "pending" }; };
  const server = createWaoMcpServer({
    registryPath: "/r.json", runDir: "/runs", dispatchRunFn: fakeDispatch,
  });
  const client = await buildInMemoryClient(server);
  try {
    const badInputs = [
      { agentId: "x", prompt: "y", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: [] } },
      { agentId: "x", prompt: "y", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["   "] } },
      { agentId: "x", prompt: "y", delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationUnavailableReason: "   " } },
    ];
    for (const bad of badInputs) {
      let rejected = false;
      let result = null;
      try { result = await client.callTool({ name: "run_dispatch", arguments: bad }); }
      catch { rejected = true; }
      if (!rejected) { assert.equal(result.isError, true, `rejected: ${JSON.stringify(Object.keys(bad.delivery || {}))}`); rejected = true; }
      assert.ok(rejected);
    }
    assert.equal(callCount, 0, "service never called for empty/whitespace delivery");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// M12-25 (Outcome 2): run_dispatch providerSessionRouting — schema + leak guard.
//
// providerSessionRouting ∈ {not_used, first_turn_requested, resume_requested}
// describes the ROUTING REQUEST dispatchRun selected, never provider success. The
// MCP schema declares the enum; the handler cherry-picks ONLY the allowed fields,
// so a malicious/injected dispatcher cannot leak opaque session ids / Lead ids /
// workspace / argv, and cannot claim a resumed session with an out-of-set value.
// =====================================================================

test("M12-25-MCP-ROUT-1: run_dispatch outputSchema declares the providerSessionRouting closed-set enum", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-mcpr1-"));
  try {
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const rd = tools.tools.find((t) => t.name === "run_dispatch");
      const schemaText = JSON.stringify(rd.outputSchema);
      assert.ok(/providerSessionRouting/.test(schemaText), "outputSchema declares providerSessionRouting");
      assert.ok(/not_used/.test(schemaText), "enum has not_used");
      assert.ok(/first_turn_requested/.test(schemaText), "enum has first_turn_requested");
      assert.ok(/resume_requested/.test(schemaText), "enum has resume_requested");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-MCP-ROUT-2: malicious injected dispatcher (bad routing + leak fields) → isError, nothing leaks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-mcpr2-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const OPAQUE = "opaque-session-uuid-LEAK";
    const LEAD = "lead-identity-LEAK";
    const WS = "C:\\Users\\secret\\workspace-LEAK";
    const fakeDispatch = async () => ({
      accepted: true,
      runId: "run_evil",
      agentId: "x",
      state: "pending",
      // Out-of-set value: a dispatcher must NEVER be able to claim a provider
      // session resumed when only routing was requested.
      providerSessionRouting: "session_resumed",
      // Leak attempts — must never reach the model.
      opaqueSessionId: OPAQUE,
      leadSession: LEAD,
      workspace: WS,
    });
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y", expectedWorkspaceRoot: dir } });
      assert.equal(res.isError, true, "out-of-set providerSessionRouting is rejected (cannot claim a resumed session)");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(OPAQUE), "no opaque session id leak");
      assert.ok(!dumped.includes(LEAD), "no Lead id leak");
      assert.ok(!dumped.includes(WS), "no workspace path leak");
      assert.ok(!dumped.includes("session_resumed"), "the malicious routing value is not echoed");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-MCP-ROUT-3: injected dispatcher returning valid routing + leak fields → fields dropped, no leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-mcpr3-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const OPAQUE = "opaque-uuid-LEAK-mcpr3";
    const fakeDispatch = async () => ({
      accepted: true,
      runId: "run_ok_mcpr3",
      agentId: "x",
      state: "pending",
      providerSessionRouting: "not_used",
      opaqueSessionId: OPAQUE,
      leadSession: "lead-LEAK-mcpr3",
    });
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y", expectedWorkspaceRoot: dir } });
      assert.equal(res.isError, undefined, "valid routing value accepted");
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.providerSessionRouting, "not_used", "valid routing threaded through");
      // Only the allowed keys are present — leak fields stripped by the handler + strict parse.
      assert.deepEqual(Object.keys(parsed).sort(),
        ["accepted", "agentId", "continuable", "label", "laneRules", "nextStep", "providerSessionRouting", "runId", "state", "workspaceProof"]);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(OPAQUE), "opaque session id never leaks");
      assert.ok(!dumped.includes("lead-LEAK-mcpr3"), "Lead id never leaks");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("M12-25-MCP-ROUT-4: injected first_turn_requested threads through verbatim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-mcpr4-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const fakeDispatch = async () => ({
      accepted: true, runId: "run_first_mcpr4", agentId: "x", state: "pending",
      providerSessionRouting: "first_turn_requested",
    });
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y", expectedWorkspaceRoot: dir } });
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.providerSessionRouting, "first_turn_requested", "first_turn_requested accepted + threaded");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// M12-25-MCP-ROUT-5: providerSessionRouting is REQUIRED truth, not a compatibility
// default. A malformed/injected dispatcher that returns a valid success shape BUT
// omits providerSessionRouting must make output validation fail to the fixed safe
// run_dispatch error — the handler NEVER fabricates not_used, and nothing leaks.
test("M12-25-MCP-ROUT-5: dispatcher omits providerSessionRouting → fixed safe error (no fabricated not_used, no leak)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m1225-mcpr5-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const OPAQUE = "opaque-session-LEAK-mcpr5";
    // Valid success shape EXCEPT providerSessionRouting is missing. (Bait fields
    // prove the failure path still does not forward anything internal.)
    const fakeDispatch = async () => ({
      accepted: true, runId: "run_omit_mcpr5", agentId: "x", state: "pending",
      opaqueSessionId: OPAQUE,
    });
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "y", expectedWorkspaceRoot: dir } });
      assert.equal(res.isError, true, "missing required providerSessionRouting → output validation fails");
      assert.equal(res.structuredContent, undefined, "no structuredContent on the fixed safe error");
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("not_used"), "the handler never fabricates a not_used default");
      assert.ok(!dumped.includes(OPAQUE), "no opaque session id leak on the failure path");
      assert.ok(!dumped.includes("run_omit_mcpr5"), "no runId leak on the failure path");
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.ok(/run_dispatch failed/.test(text), "fixed safe text present");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// 2026-10-04 drift pin (consult_20261004192559512mefa3k): the SERVER-threaded
// backend capability resolver must cover every KNOWN_BACKENDS backend. A
// hand-mirrored five-backend list in server.js refused continuable/correctable
// on kimi-web / zcode / deepseek-acp although those backends declare the
// capabilities (supportsSessionReuse=true at class level). This pin captures
// the ACTUAL resolver the server threads (dispatchRunFn seam — no public
// export added) and walks the full closed set + the unknown-value
// fail-closed contract (null, not the factory's throw).
// ---------------------------------------------------------------------

test("resolver parity: server-threaded backendFor covers every KNOWN_BACKENDS; unknown stays null (2026-10-04 drift pin)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-resolver-parity-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { mm: { backend: "kimi-web", cwd: dir } });
    let captured = null;
    const fakeDispatch = async (input) => {
      captured = input;
      return {
        accepted: true, runId: "run_resolver_pin", agentId: "mm", state: "pending",
        providerSessionRouting: "not_used", transcriptPath: "/x.jsonl",
      };
    };
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatch,
    });
    const client = await buildInMemoryClient(server);
    try {
      await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "mm", prompt: "pin", expectedWorkspaceRoot: dir,
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
          continuable: true,
        },
      });
      assert.equal(typeof captured.backendFor, "function",
        "continuable threads the capability resolver to the dispatcher");
      const resolver = captured.backendFor;
      for (const id of KNOWN_BACKENDS) {
        const b = resolver({ backend: id });
        assert.ok(b, `resolver must construct the "${id}" backend — factory parity (mirror drift was the 2026-10-04 bug)`);
      }
      // Capability truth over the closed set (class-level declarations): 在用
      // backend 全部声明 supportsSessionReuse=true。"未声明复用"的拒收形状由
      // resolveBackendFor 的 fail-closed null（下一断言）与 dispatch 侧注入形状
      // 测试承载（m12-7-runDispatchContinuable）——闭集里不再有非 true 成员。
      for (const id of KNOWN_BACKENDS) {
        assert.equal(resolver({ backend: id }).supportsSessionReuse, true,
          `${id} declares provider session reuse — continuable must pass its gate`);
      }
      // Unknown backend: fail-closed null at the wrapper boundary (the factory
      // itself throws for unknown ids — the wrapper owns the closed-set contract).
      assert.equal(resolver({ backend: "not-a-backend" }), null,
        "unknown backend → null (fail-closed), never a factory throw crossing the seam");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// 2026-10-04: fixed reason-code texts for the continuable/correctable
// eligibility refusals (family discipline of R10-A-MCP-4 above — typed error
// from the service collapses to a fixed text with a literal reason code,
// semantic why, actionable guidance, and NO collapse to the opaque generic).
// ---------------------------------------------------------------------

test("2026-10-04: ContinuableDeliveryOnlyError collapses to the fixed continuable_delivery_only text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cont-delonly-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const fakeDispatcher = async () => {
      const err = new Error("dispatchRun: continuable is delivery-only (a continuation lineage is rooted in a delivery run)");
      err.name = "ContinuableDeliveryOnlyError";
      err.reasonCode = "continuable_delivery_only";
      throw err;
    };
    const server = createWaoMcpServer({ registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatcher });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "y", continuable: true, expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, true);
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.match(text, /continuable_delivery_only/, "closed-set reason code surfaced");
      assert.match(text, /anchored in a delivery run/, "states the semantic why");
      assert.match(text, /add a delivery block or drop continuable/, "fixed actionable guidance");
      assert.doesNotMatch(text, /run_dispatch failed/, "NOT the opaque generic dispatch text");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("2026-10-04: ContinuableBackendUnsupportedError collapses to the fixed continuable_backend_unsupported text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cont-unsup-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const fakeDispatcher = async () => {
      const err = new Error("dispatchRun: continuable delivery requires a backend that supports provider session reuse");
      err.name = "ContinuableBackendUnsupportedError";
      err.reasonCode = "continuable_backend_unsupported";
      throw err;
    };
    const server = createWaoMcpServer({ registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatcher });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low", prompt: "y", continuable: true, expectedWorkspaceRoot: dir,
          delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] },
        },
      });
      assert.equal(res.isError, true);
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.match(text, /continuable_backend_unsupported/, "closed-set reason code surfaced");
      assert.match(text, /does not declare provider session reuse/, "states the semantic why");
      assert.match(text, /docs\/surface\/certification\.md/, "points at the generated capability projection");
      assert.match(text, /registry sessionReuse is configuration, not capability/, "prevents the config-as-capability misread");
      assert.match(text, /drop continuable/, "fixed actionable guidance");
      assert.doesNotMatch(text, /run_dispatch failed/, "NOT the opaque generic dispatch text");
      assert.doesNotMatch(text, /kimi-web|zcode|deepseek/, "no backend enumeration in the fixed text (lists drift)");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("2026-10-04: CorrectableBackendUnsupportedError collapses to the fixed correctable_backend_unsupported text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-corr-unsup-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const fakeDispatcher = async () => {
      const err = new Error("dispatchRun: correctable requires a backend that declares supportsInFlightCorrection");
      err.name = "CorrectableBackendUnsupportedError";
      err.reasonCode = "correctable_backend_unsupported";
      throw err;
    };
    const server = createWaoMcpServer({ registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatcher });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "y", correctable: true, expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, true);
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.match(text, /correctable_backend_unsupported/, "closed-set reason code surfaced");
      assert.match(text, /does not declare in-flight correction/, "states the semantic why");
      assert.match(text, /drop correctable/, "fixed actionable guidance");
      assert.doesNotMatch(text, /run_dispatch failed/, "NOT the opaque generic dispatch text");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

// ── TD-319：MCP 错误文本输出口统一转义（register 包装层） ──────────────────────

test("TD-319: dispatchSelectorErrorText 返回行数组——join 结果与改前逐字一致", async () => {
  const { dispatchSelectorErrorText } = await import("../../src/mcp/server.js");
  const resolution = {
    kind: "error", code: "unknown_lane",
    message: 'unknown_lane: 收到 lane="no_such"；该车道未注册。',
    received: { lane: "no_such", role: "auditor" },
    choices: {
      forms: ["agentId", "lane+role"],
      lanes: ["claude-opus", "glm-pro"],
      roles: ["auditor", "coder"],
      aliases: ["opus"],
    },
  };
  const parts = dispatchSelectorErrorText(resolution);
  assert.ok(Array.isArray(parts), "返回行数组（不再 join）");
  assert.ok(parts.every((l) => typeof l === "string" && !l.includes("\n")), "每行都是真单行");
  // join 结果逐字复现改前 wire 文本（干净值下包装层逐行转义是恒等变换）。
  assert.deepEqual(parts, [
    'dispatch refused: unknown_lane. unknown_lane: 收到 lane="no_such"；该车道未注册。',
    "known lanes (2): claude-opus, glm-pro",
    "known roles (2): auditor, coder",
    "known aliases (1): opus",
    "accepted forms: agentId | lane+role",
    'fix: run_dispatch({ "lane": "claude-opus", "role": "auditor", "prompt": "任务文本" }) 或 run_dispatch({ "agentId": "<别名>", "prompt": "任务文本" })',
  ]);
  // >32 项截断指向 lead_preflight workers（0129 前指向 registry_list）的行也保持单行结构。
  const many = Array.from({ length: 40 }, (_, i) => `lane_${i}`);
  const capped = dispatchSelectorErrorText({ ...resolution, choices: { lanes: many, roles: ["coder"] } });
  const cappedLaneLine = capped.find((l) => l.startsWith("known lanes"));
  assert.match(cappedLaneLine, /lane_31 …（截断，全 wao lanes 详见 lead_preflight workers）/);
  assert.ok(!cappedLaneLine.includes("\n"));
});

test("TD-319: withToolErrorTextEscape——isError 文本转义（字符串与行数组），非错误结果原样", async () => {
  const { withToolErrorTextEscape } = await import("../../src/mcp/server.js");
  // 返回的 isError：字符串 text 的换行变成可见写法，不再多出行。
  const stringCase = await withToolErrorTextEscape(async () => ({
    isError: true,
    content: [
      { type: "text", text: "refused: evil\n[FORGED] forged line" },
      { type: "text", text: ["dispatch refused: line one", "line two\ninner"] },
      { type: "resource", resource: { uri: "wao://x" } },
    ],
  }), {}, {});
  assert.equal(stringCase.isError, true);
  assert.equal(stringCase.content[0].text, "refused: evil\\n[FORGED] forged line", "字符串 text：注入换行转义");
  assert.equal(stringCase.content[1].text, "dispatch refused: line one\nline two\\ninner", "行数组 text：行间换行保留、行内转义");
  assert.deepEqual(stringCase.content[2], { type: "resource", resource: { uri: "wao://x" } }, "非 text 项原样不动");
  // 非错误结果：同一对象原样返回（成功输出不加这一层）。
  const ok = { content: [{ type: "text", text: JSON.stringify({ fine: true }) }], structuredContent: { fine: true } };
  const passthrough = await withToolErrorTextEscape(async () => ok, {}, {});
  assert.strictEqual(passthrough, ok, "成功结果对象同一引用（字节不变）");
  // isError 缺 content / 非 isError 不带 content：不裹不改。
  // isError 但缺 content（不具形）：不裹不改，原样返回。
  const odd = await withToolErrorTextEscape(async () => ({ isError: true }), {}, {});
  assert.deepEqual(odd, { isError: true }, "不具形的结果原样返回");
});

test("TD-319: withToolErrorTextEscape——抛错收敛为 SDK 同形 isError，文本转义；UrlElicitationRequired 原样上抛", async () => {
  const { withToolErrorTextEscape } = await import("../../src/mcp/server.js");
  const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
  // 抛错分支：与 SDK createToolError 同形，message 里的换行可见化。
  const thrown = await withToolErrorTextEscape(async () => {
    throw new Error("service blew up\n[FORGED] forged line");
  }, {}, {});
  assert.deepEqual(
    thrown,
    { content: [{ type: "text", text: "service blew up\\n[FORGED] forged line" }], isError: true },
  );
  // 带 lines 的错误：逐行转义后换行（行数保持）。
  const multi = await withToolErrorTextEscape(async () => {
    const err = new Error("a\nb");
    err.lines = ["first\ninjected", "second"];
    throw err;
  }, {}, {});
  assert.equal(multi.content[0].text, "first\\ninjected\nsecond");
  assert.equal(multi.isError, true);
  // 唯一例外照 SDK：McpError 且 code === UrlElicitationRequired 原样上抛。
  const elicitation = new McpError(ErrorCode.UrlElicitationRequired, "elicitation required");
  await assert.rejects(
    withToolErrorTextEscape(async () => { throw elicitation; }, {}, {}),
    (e) => e === elicitation,
  );
  // 其它 McpError 照常收敛（不享受例外；message 带 "MCP error <code>:" 前缀）。
  const otherMcp = await withToolErrorTextEscape(async () => {
    throw new McpError(ErrorCode.InvalidParams, "bad params\n[FORGED]");
  }, {}, {});
  assert.equal(otherMcp.isError, true);
  assert.equal(otherMcp.content[0].text, "MCP error -32602: bad params\\n[FORGED]");
});

test("TD-319: run_dispatch 选择器拒绝经包装层上 wire——多行文本、行内控制字符不再伪造一行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mcp-td319-"));
  try {
    // 第 135 批：expectedWorkspaceRoot 是 schema 必填（wire 先拒缺参）。选择器
    // 拒绝在处理器内先于 workspace 证明——给一个可证明的 Git 顶层，让断言落在
    // 选择器错误而不是缺参校验错误上。
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync('git -C "' + dir + '" config user.email t@t.com && git -C "' + dir + '" config user.name t && git -C "' + dir + '" commit --allow-empty -m init', { stdio: "ignore" });
    const registryPath = makeRegistry(dir, {});
    const server = createWaoMcpServer({ registryPath, runDir: join(dir, "runs") });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { lane: "no_such_lane_td319", role: "auditor", prompt: "t", expectedWorkspaceRoot: dir } });
      assert.equal(res.isError, true, "未知 lane 被拒");
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const rows = text.split("\n");
      assert.ok(rows.length >= 3, `选择器拒绝是多行（行数组语义保留）: ${JSON.stringify(rows)}`);
      assert.match(rows[0], /^dispatch refused: unknown_lane\./);
      assert.ok(rows.some((l) => l.startsWith("known lanes")), "合法 lane 行在场");
      assert.ok(rows.some((l) => l.startsWith("fix: run_dispatch(")), "修正例行在场");
      assert.ok(rows.every((l) => !l.includes("\n")), "每行单行");
      // 非错误结果字节不变：lead_preflight 在未绑定工作区时也是结构化成功输出
      //（workspace 节如实报 bound:false），其 JSON 文本不经转义层
      //（withToolErrorTextEscape 对非 isError 原样返回）。批 119：绑定状态查询
      // 工具已真删除，本断言改经 lead_preflight。
      const status = await client.callTool({ name: "lead_preflight", arguments: {} });
      assert.notEqual(status.isError, true);
      assert.doesNotThrow(() => JSON.parse(status.content.find((b) => b.type === "text").text), "成功 JSON 文本仍可解析（未过转义层）");
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

// ---------------------------------------------------------------------
// 第 156 批：laneRules（Owner 规则原文 + 此刻高峰快照）与 label 的降级/序列化钉。
// 夹具纪律：注入 laneRulesFn 夹具——不读真实画像、不钉仓库 6 条规则原文。
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// 0097 §4: accepted dispatch carries the additive optional laneFacts field
// (the selected lane's one-line facts, verbatim from laneFactsLine — facts
// only, never a recommendation). Not accepted → absent. run_continue does
// NOT carry it: RUN_CONTINUE_OUTPUT in src/mcp/server.js is strict and has no
// laneFacts key, so its output validation would reject one. Here we pin the
// run_dispatch side only.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// 第 156 批：laneRules（Owner 规则原文 + 此刻高峰快照）与 label 的降级/序列化钉。
// 夹具纪律：注入 laneRulesFn 夹具——不读真实画像、不钉仓库 6 条规则原文。
// ---------------------------------------------------------------------

test("156: laneRules 只序列化（注入夹具原样上 wire）；构造抛错 → 受理照常、只该字段降级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-156-rules-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const FAKE_RULES = {
      rules: ["夹具规则一", "夹具规则二"],
      now: { beijing: "周四 15:00", holidaysRecognized: false, peaks: [] },
    };
    const fakeDispatch = async () => ({
      accepted: true, runId: "run_156_rules", agentId: "x", state: "pending",
      providerSessionRouting: "not_used",
    });
    // 1) 构造产物原样上 wire（出口只做序列化，不拼装）。
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
      laneRulesFn: () => FAKE_RULES,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "t", expectedWorkspaceRoot: dir } });
      assert.equal(res.isError, undefined, "受理成功");
      assert.deepEqual(res.structuredContent.laneRules, FAKE_RULES, "夹具 laneRules 原样上 wire");
    } finally { await client.close(); await server.close(); }

    // 2) 构造抛错 → 绝不把受理折成错误回执；字段降级为 rules:null + 固定原因。
    const serverBoom = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
      laneRulesFn: () => { throw new Error("laneRules boom"); },
    });
    const clientBoom = await buildInMemoryClient(serverBoom);
    try {
      const res = await clientBoom.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "t", expectedWorkspaceRoot: dir } });
      assert.equal(res.isError, undefined, "构造抛错 → 受理照常（不是 run_dispatch failed）");
      assert.equal(res.structuredContent.laneRules.rules, null, "rules:null");
      assert.equal(res.structuredContent.laneRules.rulesReason, "ownerRules 缺失、不合法、为空或读取失败", "固定原因串");
      assert.equal(res.structuredContent.laneRules.now, null, "now:null");
    } finally { await clientBoom.close(); await serverBoom.close(); }
  } finally { cleanupDir(dir); }
});

test("156 修正一: laneRules 注入越界值（车道 id 超长/规则条数超限/peakNow:null）→ 受理照常，只该字段降级", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-156-rules-over-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const fakeDispatch = async () => ({
      accepted: true, runId: "run_156_rules_over", agentId: "x", state: "pending",
      providerSessionRouting: "not_used",
    });
    const NOW = { beijing: "周四 15:00", holidaysRecognized: false };
    const PEAK = { state: "off_peak", until: "2026-11-26T18:00:00+08:00", untilLocal: "18:00" };
    const OVER_BOUND = [
      ["车道 id 65 字", {
        rules: ["规则一"], now: { ...NOW, peaks: [{ lane: "x".repeat(65), peakNow: PEAK }] },
      }],
      ["规则 9 条", {
        rules: Array.from({ length: 9 }, (_, i) => `规则${i}`), now: { ...NOW, peaks: [] },
      }],
      ["peakNow: null", {
        rules: ["规则一"], now: { ...NOW, peaks: [{ lane: "x", peakNow: null }] },
      }],
    ];
    for (const [label, laneRules] of OVER_BOUND) {
      const server = createWaoMcpServer({
        registryPath, runDir: "/server/runs", workspaceRoot: dir,
        dispatchRunFn: fakeDispatch,
        laneRulesFn: () => laneRules,
      });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "t", expectedWorkspaceRoot: dir } });
        assert.equal(res.isError, undefined, `${label}: 受理照常（不是 run_dispatch failed）`);
        assert.equal(res.structuredContent.runId, "run_156_rules_over", `${label}: runId 在结构化回执里`);
        assert.deepEqual(res.structuredContent.laneRules,
          { rules: null, rulesReason: RULES_UNAVAILABLE_REASON, now: null },
          `${label}: 只有 laneRules 换成共享降级形`);
        assert.equal(res.structuredContent.label, "[x] t", `${label}: label 不受连累`);
      } finally { await client.close(); await server.close(); }
    }
  } finally { cleanupDir(dir); }
});

test("156 修正一: label 与 Owner 看板同一条脱敏链（无令牌形状的环境秘密原值也遮住）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-156-mcp-redact-"));
  const prev = process.env.WAO_TEST_API_KEY;
  const secret = "plain-secret-15";
  process.env.WAO_TEST_API_KEY = secret;
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: async () => ({
        accepted: true, runId: "run_156_mcp_redact", agentId: "x", state: "pending",
        providerSessionRouting: "not_used",
      }),
      laneRulesFn: () => ({ rules: ["规则一"], now: { beijing: "周四 15:00", holidaysRecognized: false, peaks: [] } }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const prompt = `# 修 ${secret} 的部署\n正文`;
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt, expectedWorkspaceRoot: dir } });
      assert.equal(res.isError, undefined);
      const expectedTitle = deriveOwnerTitle(prompt, createSecretRedactor(process.env).redactString);
      assert.equal(res.structuredContent.label, `[x] ${expectedTitle}`, "与看板对同一输入逐字相同");
      assert.ok(!res.structuredContent.label.includes(secret), "秘密原值不进 label");
      assert.ok(res.structuredContent.label.includes("[REDACTED:WAO_TEST_API_KEY]"), "精确脱敏标记");
    } finally { await client.close(); await server.close(); }
  } finally {
    if (prev === undefined) delete process.env.WAO_TEST_API_KEY;
    else process.env.WAO_TEST_API_KEY = prev;
    cleanupDir(dir);
  }
});

test("156: label 取法与 Owner 看板同源（标题去 # 记号）；无标题退回 runId；未受理不带", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-156-label-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const fakeDispatch = async () => ({
      accepted: true, runId: "run_156_label", agentId: "x", state: "pending",
      providerSessionRouting: "not_used",
    });
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
      laneRulesFn: () => ({ rules: null, rulesReason: "ownerRules 缺失、不合法、为空或读取失败", now: null }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const titled = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "x", prompt: "# 修登录超时\n\n正文", expectedWorkspaceRoot: dir },
      });
      assert.equal(titled.structuredContent.label, "[x] 修登录超时", "标题去 # 记号（与看板同源）");
      const bare = await client.callTool({
        name: "run_dispatch",
        // 只有分隔线——第一行不可取（INPUT schema 要求 prompt 非空）。
        arguments: { agentId: "x", prompt: "---", expectedWorkspaceRoot: dir },
      });
      assert.equal(bare.structuredContent.label, "[x] run_156_label", "无标题退回 runId");
      // 未受理（accepted:false）→ 不带 label/laneRules/nextStep。
      const serverRefused = createWaoMcpServer({
        registryPath, runDir: "/server/runs", workspaceRoot: dir,
        dispatchRunFn: async () => ({ accepted: false, runId: "run_156_no", agentId: "x", state: "refused", providerSessionRouting: "not_used" }),
      });
      const clientRefused = await buildInMemoryClient(serverRefused);
      try {
        const refused = await clientRefused.callTool({
          name: "run_dispatch",
          arguments: { agentId: "x", prompt: "t", expectedWorkspaceRoot: dir },
        });
        const parsedRefused = JSON.parse(refused.content.find((b) => b.type === "text").text);
        assert.equal(parsedRefused.accepted, false);
        for (const key of ["label", "laneRules", "nextStep"]) {
          assert.equal(key in parsedRefused, false, `未受理不带 ${key}`);
        }
      } finally { await clientRefused.close(); await serverRefused.close(); }
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});


test("0097: accepted run_dispatch carries laneFacts (no [wao] prefix); null → key absent; not accepted → absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0097-facts-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { x: { backend: "claude-code", cwd: dir } });
    const FACTS = "所选车道事实（只陈列，不是推荐）：x · 成本档 1（Owner 相对档 0.5–5，非价格倍数）· 评分当前；Owner 规则见 lead_preflight 的 lanes.ownerRules";
    const fakeDispatch = async () => ({
      accepted: true, runId: "run_0097_facts", agentId: "x", state: "pending",
      providerSessionRouting: "not_used",
    });
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: fakeDispatch,
      laneFactsLineFn: (laneId) => (laneId === "x" ? FACTS : null),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "t", expectedWorkspaceRoot: dir } });
      assert.equal(res.isError, undefined, "受理成功");
      const parsed = res.structuredContent;
      assert.equal(parsed.laneFacts, FACTS, "受理回执带同一行文字");
      assert.ok(!parsed.laneFacts.startsWith("[wao] "), "不带 [wao] 前缀（那是 CLI stderr 的形制）");
      assert.deepEqual(Object.keys(parsed).sort(),
        ["accepted", "agentId", "continuable", "label", "laneFacts", "laneRules", "nextStep", "providerSessionRouting", "runId", "state", "workspaceProof"],
        "键集钉：laneFacts/label/laneRules 是第 156 批前后的全部新增键");

      // 回显失败（fail-open null）→ 键缺省，受理不受影响。
      const serverNull = createWaoMcpServer({
        registryPath, runDir: "/server/runs", workspaceRoot: dir,
        dispatchRunFn: fakeDispatch,
        laneFactsLineFn: () => null,
      });
      const clientNull = await buildInMemoryClient(serverNull);
      try {
        const resNull = await clientNull.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "t", expectedWorkspaceRoot: dir } });
        assert.equal(resNull.isError, undefined);
        assert.equal("laneFacts" in resNull.structuredContent, false, "null → 键缺省");
      } finally { await clientNull.close(); await serverNull.close(); }

      // 未受理（accepted:false）→ 不带 laneFacts/nextStep。
      const serverRefused = createWaoMcpServer({
        registryPath, runDir: "/server/runs", workspaceRoot: dir,
        dispatchRunFn: async () => ({
          accepted: false, runId: "run_0097_no", agentId: "x", state: "refused",
          providerSessionRouting: "not_used",
        }),
        laneFactsLineFn: () => FACTS,
      });
      const clientRefused = await buildInMemoryClient(serverRefused);
      try {
        const resRefused = await clientRefused.callTool({ name: "run_dispatch", arguments: { agentId: "x", prompt: "t", expectedWorkspaceRoot: dir } });
        const parsedRefused = JSON.parse(resRefused.content.find((b) => b.type === "text").text);
        assert.equal(parsedRefused.accepted, false);
        assert.equal("laneFacts" in parsedRefused, false, "未受理不带 laneFacts");
        assert.equal("nextStep" in parsedRefused, false, "未受理不带 nextStep");
      } finally { await clientRefused.close(); await serverRefused.close(); }
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

test("b158a 修复二 run_dispatch 回执：laneFacts/laneRules 与派发共用本次请求的车道表（恰读一次）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-fix2-facts-rules-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { lane1: { cwd: dir } });
    const lanesDoc = {
      ok: true, path: "<fixture>", sha256: "b".repeat(64), issues: [], rolesHint: [],
      lanes: [{ id: "lane1", backend: "claude-code", model: { id: "m1" }, reasoning: { effort: "high" }, aliases: {} }],
    };
    const captured = { facts: null, rules: null, dispatch: null, lanesLoads: 0 };
    const server = createWaoMcpServer({
      registryPath, runDir: join(dir, "runs"), workspaceRoot: dir,
      // 临时注册表当默认注册表 → 合并启用。
      pairedDefaultRegistryPathFn: () => registryPath,
      loadLanesConfigFn: () => { captured.lanesLoads += 1; return lanesDoc; },
      dispatchRunFn: async (input) => {
        captured.dispatch = input;
        return {
          accepted: true, runId: "run_fix2_fr", agentId: "lane1", state: "pending",
          providerSessionRouting: "not_used",
        };
      },
      laneFactsLineFn: (laneId, opts) => { captured.facts = { laneId, opts }; return "FACTS-FROM-REQUEST-DOC"; },
      laneRulesFn: (opts) => {
        captured.rules = opts;
        return { rules: ["规则一"], now: { beijing: "周四 15:00", holidaysRecognized: false, peaks: [] } };
      },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { lane: "lane1", role: "coder", prompt: "t", expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined, "受理成功");
      assert.equal(captured.lanesLoads, 1, "一次请求恰读一次车道表");
      assert.equal(captured.dispatch.lanesMerge, lanesDoc, "派发用本次请求的表");
      assert.equal(captured.facts?.opts?.lanesDoc, lanesDoc, "laneFacts 用同一份对象");
      assert.equal(captured.rules?.lanesDoc, lanesDoc, "laneRules 用同一份对象");
      assert.equal(res.structuredContent.laneFacts, "FACTS-FROM-REQUEST-DOC");
      assert.deepEqual(res.structuredContent.laneRules.rules, ["规则一"]);
    } finally { await client.close(); await server.close(); }
  } finally { cleanupDir(dir); }
});

// =====================================================================
// 决定 0129：原 run_dispatch_contract_check 的就地承接——run_dispatch 在派发前
// 跑同一份预检服务；合同级问题照旧在任何副作用之前拒绝（既有固定文案），
// advisory 码随受理回执的 contractAdvisories 给出（闭集码 + 固定说明，
// 零提醒不带该键；nextStep 届时提醒先看它）。
// =====================================================================

test("0129-P1: dispatch receipt carries contractAdvisories (dir-form lint + path-probe miss); advisory never blocks; nextStep mentions it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0129-p1-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let dispatchCalls = 0;
    const fakeDispatcher = async () => {
      dispatchCalls += 1;
      return {
        accepted: true, runId: "run_0129_p1", agentId: "coder_low", state: "pending",
        transcriptPath: "/x.jsonl", providerSessionRouting: "not_used",
      };
    };
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatcher,
    });
    const client = await buildInMemoryClient(server);
    try {
      // verification 用目录形式的 --test 实参（verification_dir_test_form）+
      // 引用不存在的相对路径（referenced_path_probe_miss 按调用目标根探测）。
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low",
          prompt: "do it",
          expectedWorkspaceRoot: dir,
          delivery: {
            mode: "git_commit_v1",
            allowedPaths: ["src"],
            verificationCommands: ["node --test test/definitely-missing-dir/"],
          },
        },
      });
      assert.equal(dispatchCalls, 1, "advisories never block — dispatcher reached exactly once");
      assert.equal(res.isError, undefined, "accepted");
      const sc = res.structuredContent;
      assert.ok(Array.isArray(sc.contractAdvisories), "receipt carries contractAdvisories");
      const codes = sc.contractAdvisories.map((a) => a.code);
      assert.ok(codes.includes("verification_dir_test_form"), "dir-form advisory present");
      assert.ok(codes.includes("referenced_path_probe_miss"), "path-probe advisory present (call-target root)");
      for (const adv of sc.contractAdvisories) {
        assert.ok(typeof adv.note === "string" && adv.note.length > 0, "each advisory carries its fixed note");
      }
      assert.match(sc.nextStep, /contractAdvisories/, "nextStep points at the advisories first");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("0129-P2: contract-level issue refuses before the dispatcher with the existing fixed text (invalid_verification_path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0129-p2-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let dispatchCalls = 0;
    const fakeDispatcher = async () => {
      dispatchCalls += 1;
      return { accepted: true, runId: "x", agentId: "coder_low", state: "pending" };
    };
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatcher,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low",
          prompt: "x",
          expectedWorkspaceRoot: dir,
          delivery: {
            mode: "git_commit_v1",
            allowedPaths: ["src"],
            // 绝对路径字面量 → 合同级 invalid_verification_path（既有专属文案）。
            verificationCommands: [`node ${join(dir, "definitely", "absolute.js")}`],
          },
        },
      });
      assert.equal(dispatchCalls, 0, "refused BEFORE any side effect (dispatcher count 0)");
      assert.equal(res.isError, true, "refused");
      const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.match(text, /run_dispatch refused: invalid_verification_path/, "existing closed-set text");
      assert.ok(!res.structuredContent, "no receipt payload on refusal");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("0129-P3: clean contract → receipt has NO contractAdvisories key and the plain nextStep", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0129-p3-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const fakeDispatcher = async () => ({
      accepted: true, runId: "run_0129_p3", agentId: "coder_low", state: "pending",
      transcriptPath: "/x.jsonl", providerSessionRouting: "not_used",
    });
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatcher,
    });
    const client = await buildInMemoryClient(server);
    try {
      // 无 delivery 的普通派发：预检零 advisory → 回执不带该键。
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined, "accepted");
      assert.equal("contractAdvisories" in res.structuredContent, false, "zero advisories → key absent");
      assert.doesNotMatch(res.structuredContent.nextStep, /contractAdvisories/, "plain nextStep template");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 第 136 批续修（会审 kimi 复现）：合法的长 runId 不能让已经受理的派发变成
// `run_dispatch failed`——CLI 半句只在最终上线的整句（含合同提醒后缀）不超
// NEXT_STEP_MAX_LEN（480）时才加，放不下就不加；MCP 写法与后缀照旧。
// =====================================================================

async function dispatchWithAdvisories(runId) {
  const dir = mkdtempSync(join(tmpdir(), "wao-136-longid-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let dispatchCalls = 0;
    const fakeDispatcher = async () => {
      dispatchCalls += 1;
      return {
        accepted: true, runId, agentId: "coder_low", state: "pending",
        transcriptPath: "/x.jsonl", providerSessionRouting: "not_used",
      };
    };
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir, dispatchRunFn: fakeDispatcher,
    });
    const client = await buildInMemoryClient(server);
    try {
      // 与 0129-P1 同款：目录形式的 --test 实参 + 引用不存在的相对路径 → 两条 advisory。
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low",
          prompt: "do it",
          expectedWorkspaceRoot: dir,
          delivery: {
            mode: "git_commit_v1",
            allowedPaths: ["src"],
            verificationCommands: ["node --test test/definitely-missing-dir/"],
          },
        },
      });
      return { dispatchCalls, res };
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
}

test("136-L1: 150 字符 runId + contractAdvisories → dispatcher 恰好一次、受理成功；nextStep ≤ 480，MCP 写法与提醒在、CLI 半句不加", async () => {
  const longId = "run_" + "x".repeat(146);
  assert.equal(longId.length, 150);
  const { dispatchCalls, res } = await dispatchWithAdvisories(longId);
  assert.equal(dispatchCalls, 1, "派发已经发生");
  assert.equal(res.isError, undefined, `受理不能变成报错（实测：${res.content?.[0]?.text ?? ""}）`);
  const sc = res.structuredContent;
  assert.equal(sc.accepted, true);
  assert.equal(sc.runId, longId);
  assert.ok(Array.isArray(sc.contractAdvisories) && sc.contractAdvisories.length > 0, "回执带 contractAdvisories");
  assert.ok(sc.nextStep.length <= 480, `整句 ${sc.nextStep.length} ≤ 480`);
  assert.match(sc.nextStep, /^Background run accepted\. Before ending the turn, keep a wait attached: call run_await_result repeatedly with its default waitMs on this run until it settles\./);
  // 第 156 批：提醒之后是命名短提示（后台任务可命名 <label>）——150 字符 runId
  // 下整句仍 ≤480，提示放得下。
  assert.ok(sc.nextStep.endsWith(
    "Review contractAdvisories in this receipt first; stop and re-dispatch if needed."
    + ` （后台任务可命名 ${sc.label}）`), `提醒在、其后是命名短提示：${sc.nextStep}`);
  assert.ok(!sc.nextStep.includes("wao runs wait"), "整句放不下——不加 CLI 半句");
});

test("136-L2: 120 字符 runId（kimi 复现的长度）+ contractAdvisories → 不再是 run_dispatch failed；整句 489 放不下，CLI 半句不加", async () => {
  const longId = "run_" + "x".repeat(116);
  assert.equal(longId.length, 120);
  const { dispatchCalls, res } = await dispatchWithAdvisories(longId);
  assert.equal(dispatchCalls, 1, "派发已经发生");
  assert.equal(res.isError, undefined, `受理不能变成报错（实测：${res.content?.[0]?.text ?? ""}）`);
  const sc = res.structuredContent;
  assert.equal(sc.accepted, true);
  assert.ok(Array.isArray(sc.contractAdvisories) && sc.contractAdvisories.length > 0, "回执带 contractAdvisories");
  // 第 156 批：nextStep 末尾再挂命名短提示（后台任务可命名 <label>；label 同时
  // 在回执字段里）——放不下只丢提示，这里 150 字符 runId 放得下。
  assert.equal(sc.nextStep,
    "Background run accepted. Before ending the turn, keep a wait attached: call run_await_result repeatedly with its default waitMs on this run until it settles. Review contractAdvisories in this receipt first; stop and re-dispatch if needed."
    + ` （后台任务可命名 ${sc.label}）`);
  assert.ok(sc.nextStep.length <= 480, `整句 ${sc.nextStep.length} ≤ 480`);
});

test("136-L2b: 110 字符 runId + contractAdvisories → 整句 479 放得下：CLI 半句与提醒后缀都在、半句在前", async () => {
  const longId = "run_" + "x".repeat(106);
  assert.equal(longId.length, 110);
  const { res } = await dispatchWithAdvisories(longId);
  assert.equal(res.isError, undefined, `受理不能变成报错（实测：${res.content?.[0]?.text ?? ""}）`);
  const next = res.structuredContent.nextStep;
  assert.ok(next.length <= 480, `整句 ${next.length} ≤ 480`);
  assert.match(next, new RegExp(
    `wao runs wait ${longId} --until-settled there; one command waits until settlement\\. Review contractAdvisories in this receipt first; stop and re-dispatch if needed\\.$`));
});

// =====================================================================
// 第 147 批（修正一）：分支帽提示进 MCP 受理回执——与 CLI 同一采样/静默规则；
// 只挂既有 nextStep（不改 output schema、不加字段）；采样只读、提示真正带出才记账。
// 工厂默认不采样（部署入口接真实函数），所以这些用例显式注入采样/记账对。
// =====================================================================

const DISPATCH_ACCEPTED_BASE =
  "Background run accepted. Before ending the turn, keep a wait attached: "
  + "call run_await_result repeatedly with its default waitMs on this run until it settles.";

/** dispatchResourceAdvisory 的 fake 执行器：脚本化两个计数 + repo 根。 */
function fakeAdvisoryExec({ worktrees = 1, branches = 1, root = "D:/fake/advisory-repo" } = {}) {
  return (command) => {
    if (command === "git worktree list --porcelain") {
      return Array.from({ length: worktrees }, (_, i) =>
        `worktree D:/fake/wt${i}\nHEAD ${"a".repeat(40)}\n`).join("\n");
    }
    if (command === 'git branch --list "wao/run_*"') {
      return Array.from({ length: branches }, (_, i) => `  wao/run_adv${i}`).join("\n");
    }
    if (command === "git rev-parse --show-toplevel") return `${root}\n`;
    throw new Error(`unexpected advisory command: ${command}`);
  };
}

function fakeAcceptedDispatch(runId) {
  return async () => ({
    accepted: true, runId, agentId: "coder_low", state: "pending",
    providerSessionRouting: "not_used", transcriptPath: "/x.jsonl",
  });
}

const ADVISORY_LINE = (worktrees, branches) =>
  `[wao] advisory: worktrees=${worktrees} waoRunBranches=${branches} `
  + "(reclaim: wao worktree reclaim, SOP wao manual maintenance \"批量清退\")";

test("147-MCP-0: 直接构造的工厂缺省不采样分支帽提示（测试/嵌入方不碰真实状态目录；部署入口 stdio 才接线）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-147-mcp0-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: fakeAcceptedDispatch("run_147_mcp0"),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined, "受理成功");
      assert.doesNotMatch(res.structuredContent.nextStep, /\[wao\] advisory/,
        "缺省采样器为 null → 回执不带提示（不向真实 %LOCALAPPDATA% 写状态）");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("147-MCP-1: 超帽 → 受理回执的既有 nextStep 带与 CLI 同一采样结果（不新增字段/schema 不变），并记账", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-147-mcp1-"));
  const stateDir = mkdtempSync(join(tmpdir(), "wao-147-mcp1-state-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let advisoryCalls = 0;
    let advisoryCwd = null;
    let dispatchCwd = null;
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: async (input) => {
        dispatchCwd = input.cwd;
        return {
          accepted: true, runId: "run_147_mcp1", agentId: "coder_low", state: "pending",
          providerSessionRouting: "not_used", transcriptPath: "/x.jsonl",
        };
      },
      dispatchResourceAdvisorySampleFn: (cwd) => {
        advisoryCalls += 1;
        advisoryCwd = cwd;
        return sampleDispatchResourceAdvisory(cwd, {
          exec: fakeAdvisoryExec({ worktrees: 2, branches: BRANCH_CAP + 1 }),
          stateDir,
        });
      },
      dispatchResourceAdvisoryCommitFn: commitDispatchResourceAdvisory,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined, "受理成功");
      assert.equal(advisoryCalls, 1, "受理回执采样一次资源提示");
      assert.ok(
        advisoryCwd != null && advisoryCwd === dispatchCwd,
        "采样目录 = 本次派发证明的工作区根（与 CLI 的 --cwd 口径对应）",
      );
      const sc = res.structuredContent;
      const advisory = ADVISORY_LINE(2, BRANCH_CAP + 1);
      // 第 156 批：资源提示之后是命名短提示（后台任务可命名 <label>，最末）。
      assert.ok(sc.nextStep.includes(` ${advisory}`), `既有 nextStep 承载同一行: ${sc.nextStep}`);
      assert.ok(sc.nextStep.endsWith(` （后台任务可命名 ${sc.label}）`), `命名短提示在最末: ${sc.nextStep}`);
      assert.ok(sc.nextStep.startsWith(DISPATCH_ACCEPTED_BASE), "MCP 等待模板不变，提示追加在后");
      assert.ok(sc.nextStep.length <= 480, `整句 ${sc.nextStep.length} ≤ 480`);
      assert.ok(!sc.nextStep.includes("npm run hygiene"), "文案不再指向只在 WAO 仓存在的命令");
      assert.deepEqual(Object.keys(sc).sort(),
        ["accepted", "agentId", "continuable", "label", "laneRules", "nextStep", "providerSessionRouting", "runId", "state", "workspaceProof"],
        "回执键集不变（没加字段、没改 schema）");
      assert.equal(readdirSync(stateDir).length, 1, "提示带出后写入采样状态");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(stateDir);
    cleanupDir(dir);
  }
});

test("147-MCP-2: 帽内且与上次一致 → 采样返回 null，第二次受理回执不带提示（记账发生在第一次带出之后）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-147-mcp2-"));
  const stateDir = mkdtempSync(join(tmpdir(), "wao-147-mcp2-state-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let n = 0;
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: async () => {
        n += 1;
        return {
          accepted: true, runId: `run_147_mcp2_${n}`, agentId: "coder_low", state: "pending",
          providerSessionRouting: "not_used", transcriptPath: "/x.jsonl",
        };
      },
      dispatchResourceAdvisorySampleFn: (cwd) => sampleDispatchResourceAdvisory(cwd, {
        exec: fakeAdvisoryExec({ worktrees: 1, branches: 3 }),
        stateDir,
      }),
      dispatchResourceAdvisoryCommitFn: commitDispatchResourceAdvisory,
    });
    const client = await buildInMemoryClient(server);
    try {
      const first = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(first.isError, undefined, "第一次受理成功");
      assert.match(first.structuredContent.nextStep,
        /\[wao\] advisory: worktrees=1 waoRunBranches=3 \(/,
        "首次观测（计数有变化）→ 带提示");
      const second = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(second.isError, undefined, "第二次受理成功");
      // 第 156 批：资源提示静默，命名短提示（后台任务可命名 <label>）仍是最末一段。
      assert.equal(second.structuredContent.nextStep, DISPATCH_ACCEPTED_BASE
        + " If your host has a background shell, you can instead run wao runs wait run_147_mcp2_2 --until-settled "
        + "there; one command waits until settlement."
        + ` （后台任务可命名 ${second.structuredContent.label}）`,
      "帽内且计数与上次一致 → 静默（与 CLI 同一规则，handler 不另写一份）");
      assert.doesNotMatch(second.structuredContent.nextStep, /\[wao\] advisory/, "第二次不带提示");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(stateDir);
    cleanupDir(dir);
  }
});

test("147-MCP-3: 提示采样抛错 → 只省略提示，派发照常受理（fail-open）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-147-mcp3-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let dispatchCalls = 0;
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: async () => {
        dispatchCalls += 1;
        return {
          accepted: true, runId: "run_147_mcp3", agentId: "coder_low", state: "pending",
          providerSessionRouting: "not_used", transcriptPath: "/x.jsonl",
        };
      },
      dispatchResourceAdvisorySampleFn: () => { throw new Error("advisory counting blew up"); },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined, "提示失败不影响派发");
      assert.equal(dispatchCalls, 1, "派发恰好受理一次");
      const sc = res.structuredContent;
      assert.equal(sc.accepted, true);
      assert.equal(sc.nextStep, DISPATCH_ACCEPTED_BASE
        + " If your host has a background shell, you can instead run wao runs wait run_147_mcp3 --until-settled "
        + "there; one command waits until settlement."
        + ` （后台任务可命名 ${sc.label}）`);
      assert.ok(!JSON.stringify(res).includes("blew up"), "不回显提示计算的错误原文");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("147-MCP-4: 提示放不下 480 上限 → 只丢提示、受理不变成 run_dispatch failed，且不记账", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-147-mcp4-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const longId = "run_" + "y".repeat(96); // 100 字符 runId + 长提示 → 整句必超 480
    let commitCalls = 0;
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: fakeAcceptedDispatch(longId),
      dispatchResourceAdvisorySampleFn: () => ({ line: `[wao] advisory: ${"z".repeat(400)}`, state: null }),
      dispatchResourceAdvisoryCommitFn: () => { commitCalls += 1; },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(res.isError, undefined, `受理不能变成报错（实测：${res.content?.[0]?.text ?? ""}）`);
      const sc = res.structuredContent;
      assert.equal(sc.accepted, true);
      assert.ok(!sc.nextStep.includes("[wao] advisory"), `放不下的提示被省略: ${sc.nextStep}`);
      assert.ok(sc.nextStep.length <= 480, `整句 ${sc.nextStep.length} ≤ 480`);
      assert.equal(commitCalls, 0, "提示没带出 → 不记账（下次仍会弹）");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("147-MCP-5: 派发被拒没带出提示 → 不吞采样（下一次相同计数仍弹）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-147-mcp5-"));
  const stateDir = mkdtempSync(join(tmpdir(), "wao-147-mcp5-state-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    let calls = 0;
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: async () => {
        calls += 1;
        if (calls === 1) {
          // 结构化的不受理回执（accepted:false）：没有 nextStep，提示带不出去。
          return {
            accepted: false, runId: "run_147_mcp5_refused", agentId: "coder_low", state: "failed",
            providerSessionRouting: "not_used", transcriptPath: "/x.jsonl",
          };
        }
        return {
          accepted: true, runId: "run_147_mcp5_ok", agentId: "coder_low", state: "pending",
          providerSessionRouting: "not_used", transcriptPath: "/x.jsonl",
        };
      },
      dispatchResourceAdvisorySampleFn: (cwd) => sampleDispatchResourceAdvisory(cwd, {
        exec: fakeAdvisoryExec({ worktrees: 1, branches: 2 }),
        stateDir,
      }),
      dispatchResourceAdvisoryCommitFn: commitDispatchResourceAdvisory,
    });
    const client = await buildInMemoryClient(server);
    try {
      const refused = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(refused.isError, undefined);
      assert.equal(refused.structuredContent.accepted, false);
      assert.equal("nextStep" in refused.structuredContent, false, "不受理回执没有 nextStep");
      assert.equal(readdirSync(stateDir).length, 0, "被拒派发不写采样状态（不吞提示）");

      const accepted = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir },
      });
      assert.equal(accepted.isError, undefined, "第二次受理成功");
      assert.match(accepted.structuredContent.nextStep, /\[wao\] advisory: worktrees=1 waoRunBranches=2 \(/,
        "相同计数仍弹（被拒那次的提示没有被当成已展示）");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(stateDir);
    cleanupDir(dir);
  }
});

test("147-MCP-6: 合同提醒 + 超帽提示 → CLI 等待半句不被挤掉（提示放不下只丢提示、不记账）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-147-mcp6-"));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const runId = "run_" + "a".repeat(23); // 27 字符（opus 实测长度）
    assert.equal(runId.length, 27);
    let commitCalls = 0;
    const server = createWaoMcpServer({
      registryPath, runDir: "/server/runs", workspaceRoot: dir,
      dispatchRunFn: fakeAcceptedDispatch(runId),
      dispatchResourceAdvisorySampleFn: () => ({
        line: ADVISORY_LINE(1, BRANCH_CAP + 1),
        state: { stateDir: "/unused", root: "/unused", counts: { worktrees: 1, waoRunBranches: BRANCH_CAP + 1 } },
      }),
      dispatchResourceAdvisoryCommitFn: () => { commitCalls += 1; },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low", prompt: "do it", expectedWorkspaceRoot: dir,
          delivery: {
            mode: "git_commit_v1",
            allowedPaths: ["src"],
            verificationCommands: ["node --test test/definitely-missing-dir/"],
          },
        },
      });
      assert.equal(res.isError, undefined, "受理成功");
      const sc = res.structuredContent;
      assert.ok(Array.isArray(sc.contractAdvisories) && sc.contractAdvisories.length > 0, "带合同提醒");
      assert.match(sc.nextStep, /Review contractAdvisories in this receipt first; stop and re-dispatch if needed\./,
        "合同提醒在场");
      assert.match(sc.nextStep, new RegExp(`wao runs wait ${runId} --until-settled`),
        `CLI 等待半句不被提示挤掉: ${sc.nextStep}`);
      assert.ok(!sc.nextStep.includes("[wao] advisory"), `放不下的资源提示被省略: ${sc.nextStep}`);
      assert.ok(sc.nextStep.length <= 480, `整句 ${sc.nextStep.length} ≤ 480`);
      assert.equal(commitCalls, 0, "提示没带出 → 不记账");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// 第 141b 批（决定 0131 §5）：run_dispatch 可选输入 taskType——只有 "image"，
// 只加在派发 schema 上（预检工具的输入面不扩大）；经 dispatchRun 变成 runner 的
// --task-type，由 RunManager.start 固化进 run.started.taskType（第 140a 批已接）。
// 这些用例让真实 dispatchRun 跑在 MCP 处理器后面，只把 spawn 换成记录 argv 的假实现。
// =====================================================================

function makeRunnerSpawnRecorder() {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    return { unref() {}, stdin: { once() {}, end(_text, cb) { cb?.(); } } };
  };
  return { calls, spawnFn };
}

async function withTaskTypeServer(body) {
  const dir = mkdtempSync(join(tmpdir(), "wao-141b-tt-"));
  const runDir = join(dir, "runs");
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir, { coder_low: { backend: "claude-code", cwd: dir } });
    const recorder = makeRunnerSpawnRecorder();
    const dispatched = [];
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: dir,
      dispatchRunFn: (input) => {
        dispatched.push(input);
        return realDispatchRun({ ...input, spawnFn: recorder.spawnFn });
      },
    });
    const client = await buildInMemoryClient(server);
    try {
      await body({ dir, client, recorder, dispatched });
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
}

function flagValues(args, flag) {
  const out = [];
  args.forEach((a, i) => { if (a === flag) out.push(args[i + 1]); });
  return out;
}

test("141b-TT-1: taskType:\"image\" 受理，runner 参数里恰有一对 --task-type image", async () => {
  await withTaskTypeServer(async ({ dir, client, recorder, dispatched }) => {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "coder_low", prompt: "画一张图", expectedWorkspaceRoot: dir, taskType: "image" },
    });
    assert.equal(res.isError, undefined, `受理（实测：${res.content?.[0]?.text ?? ""}）`);
    assert.equal(res.structuredContent.accepted, true);
    assert.equal(dispatched.length, 1, "派发服务恰好一次");
    assert.equal(dispatched[0].taskType, "image", "taskType 原样交给 dispatchRun");
    assert.equal(recorder.calls.length, 1, "runner 恰好启动一次");
    assert.deepEqual(flagValues(recorder.calls[0].args, "--task-type"), ["image"], "runner argv 恰有一对 --task-type image");
  });
});

test("141b-TT-2: 不带 taskType → dispatchRun 入参没有这个键、runner argv 没有 --task-type（行为不变）", async () => {
  await withTaskTypeServer(async ({ dir, client, recorder, dispatched }) => {
    const res = await client.callTool({
      name: "run_dispatch",
      arguments: { agentId: "coder_low", prompt: "do it", expectedWorkspaceRoot: dir },
    });
    assert.equal(res.isError, undefined, `受理（实测：${res.content?.[0]?.text ?? ""}）`);
    assert.equal(dispatched.length, 1);
    assert.equal(Object.hasOwn(dispatched[0], "taskType"), false, "没给就不往派发入参里放键");
    assert.equal(recorder.calls.length, 1);
    assert.equal(recorder.calls[0].args.includes("--task-type"), false, "argv 没有 --task-type");
  });
});

test("141b-TT-3: taskType 别的值或错误类型在 schema 层被拒（派发服务与 runner 零调用）", async () => {
  await withTaskTypeServer(async ({ dir, client, recorder, dispatched }) => {
    // 其余入参全部合法——被拒的唯一原因只能是 taskType。
    const base = { agentId: "coder_low", prompt: "do it", expectedWorkspaceRoot: dir };
    const ok = await client.callTool({ name: "run_dispatch", arguments: { ...base, taskType: "image" } });
    assert.equal(ok.isError, undefined, "对照：同一组入参带合法 taskType 能受理");
    const dispatchedBefore = dispatched.length;
    const spawnedBefore = recorder.calls.length;
    const badValues = [
      "code", "research", "test", "plan_review", "delivery_review", "untyped", // 别的闭集成员也不开放
      "IMAGE", "Image", " image", "image ", "banana", "", // 大小写、空白、集外、空串
      42, true, null, {}, ["image"], // 错误类型
    ];
    for (const taskType of badValues) {
      let result = null;
      let threw = false;
      try {
        result = await client.callTool({ name: "run_dispatch", arguments: { ...base, taskType } });
      } catch {
        threw = true; // 协议层拒绝也算拒绝
      }
      if (!threw) {
        assert.equal(result.isError, true, `taskType=${JSON.stringify(taskType)} 必须被拒，不能受理`);
        assert.equal(result.structuredContent, undefined, "被拒没有结构化回执");
      }
    }
    assert.equal(dispatched.length, dispatchedBefore, "被拒的调用没有触达派发服务");
    assert.equal(recorder.calls.length, spawnedBefore, "被拒的调用没有启动 runner");
  });
});

test("141b-TT-4: tools/list——run_dispatch 的 taskType 是可选闭集 [\"image\"]，预检工具的输入 schema 不含 taskType", async () => {
  await withTaskTypeServer(async ({ client }) => {
    const { tools } = await client.listTools();
    const rd = tools.find((t) => t.name === "run_dispatch");
    const cc = tools.find((t) => t.name === "run_dispatch_contract_check");
    assert.deepEqual(rd.inputSchema.properties.taskType.enum, ["image"], "闭集只有 image");
    assert.equal((rd.inputSchema.required ?? []).includes("taskType"), false, "可选，不是必填");
    assert.equal(rd.inputSchema.additionalProperties, false, "run_dispatch 仍是 strict");
    assert.equal(Object.hasOwn(cc.inputSchema.properties, "taskType"), false, "预检的输入面不扩大");
    assert.equal(cc.inputSchema.additionalProperties, false, "预检仍是 strict");
    assert.match(rd.description, /taskType/, "描述里有 taskType 一句");
    assert.match(rd.description, /image/, "说明 image 用于生图任务");
    assert.doesNotMatch(cc.description, /taskType/, "预检描述不提 taskType");
  });
});

test("141b-TT-5: 预检工具收到 taskType 被 strict schema 拒（输入面没有扩大）", async () => {
  await withTaskTypeServer(async ({ dir, client, dispatched }) => {
    let result = null;
    let threw = false;
    try {
      result = await client.callTool({
        name: "run_dispatch_contract_check",
        arguments: { agentId: "coder_low", prompt: "x", expectedWorkspaceRoot: dir, taskType: "image" },
      });
    } catch {
      threw = true;
    }
    if (!threw) assert.equal(result.isError, true, "预检不认 taskType，必须被拒");
    assert.equal(dispatched.length, 0, "预检从不派发");
  });
});
