// test/run-lifecycle/lineageIdentity.test.js
//
// 决定 0114（续修接回原会话）：谱系身份只取谱系自身钉住的事实——canonical
// workspace + canonical agentId + ROOT runId + 根运行派发时定下的车道指纹与
// 角色正文 sha；不含 Lead 会话。首轮（run_dispatch continuable）与每一轮续修
// 用同一推导，所以宿主重启后续修仍接回同一 provider 会话、忙碌门按谱系判定。
//
// 覆盖面：
//   - explicit 车道+角色派发（带车道指纹与角色 sha）的首轮与续修算出同一
//     opaque uuid 与路由键；
//   - 换 Lead 会话（模拟宿主重启）身份不变；谱系有非终态续修子运行时，
//     换 Lead 会话再续修仍 busy；
//   - 原生 id 车道（kimi-code）：换 Lead 会话后仍按父转录取回 native id；
//   - explicit 父档可续：子运行 argv 带父钉住的车道/角色；角色正文漂移 →
//     role_contract_drift；
//   - 专家复用（lead_workspace）不变：同 Lead 会话 resume、换 Lead 会话 first。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { JsonlTranscript, findState, readTranscript } from "../../src/transcript.js";
import { runMain } from "../../src/backgroundRunner.js";
import { resolveTranscriptPath } from "../../src/projectBuckets.js";
import { dispatchRun } from "../../src/application/runDispatch.js";
import { continueRun } from "../../src/application/runContinue.js";
import { runConsult } from "../../src/application/consultService.js";
import { loadLanesConfig } from "../../src/dispatchResolution.js";
import {
  deriveOpaqueUuid,
  deriveLineageOpaqueUuid,
  deriveLineageReuseKeyHash,
  resolveReuseTurn,
  resolvePriorProviderSessionId,
} from "../../src/application/sessionReuse.js";
import { loadRoleContract, roleContractSha256 } from "../../src/application/roleContract.js";
import { readRegistry } from "../../src/registry.js";
import { createWaoMcpServer } from "../../src/mcp/server.js";
import { KimiCodeBackend } from "../../src/backends/kimiCode.js";

const LANE = "opus";
const ROLE = "auditor";
const ROLE_SOURCE = `config/roles/${ROLE}.md`;
const ROLE_SHA = roleContractSha256(loadRoleContract(ROLE_SOURCE));
const DELIVERY = { mode: "git_commit_v1", allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function git(args, cwd) {
  return String(execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wao-0114-li-repo-"));
  git("init -b main", repo);
  git("config user.email t@t.com", repo);
  git("config user.name T", repo);
  writeFileSync(join(repo, "README.md"), "base\n", "utf8");
  git("add -A", repo);
  git("commit -m base", repo);
  return repo;
}

function makeLaneRegistry(dir, repo) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({
    agents: {
      [LANE]: {
        backend: "claude-code",
        cwd: repo,
        model: { id: "claude-opus-5-5" },
        reasoning: { effort: "high" },
      },
    },
  }), "utf8");
  return registryPath;
}

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function buildParentWorktree(repo, runId) {
  const wt = join(repo, ".wao-worktrees", runId);
  git(`worktree add -b wao/${runId} "${wt}"`, repo);
  const base = git("rev-parse HEAD", repo);
  writeFileSync(join(wt, "keep.txt"), "keep-changed\n", "utf8");
  git("add -A", wt);
  git(`-c user.name="WAO Delivery" -c user.email="wao-delivery@local" commit -m "wao-delivery: ${runId}"`, wt);
  const deliveryCommit = git("rev-parse HEAD", wt);
  return { wt, base, deliveryCommit, branch: `wao/${runId}` };
}

function makeFakeSpawn() {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    const call = { cmd, args, opts, stdinText: null };
    calls.push(call);
    return {
      unref() {},
      stdin: { once() {}, end(text, cb) { call.stdinText = String(text ?? ""); cb?.(); } },
    };
  };
  return { fakeSpawn, calls };
}

function argVal(calls, flag) {
  const args = calls[0].args;
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// 执行 continueRun 捕获到的 runner argv（去掉 node/runner 路径后的真实参数），
// 复现 detached runner 的启动前材料复核。stdout 暂存以免污染 TAP 输出。
async function runCapturedRunner(runnerArgs, prompt, options = {}) {
  const originalWrite = process.stdout.write;
  try {
    process.stdout.write = () => true;
    await runMain(runnerArgs.slice(1), { stdin: Readable.from([prompt]), ...options });
  } finally {
    process.stdout.write = originalWrite;
  }
}

function cleanup(...dirs) {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// 首轮派发（continuable + explicit lane/role）：返回首轮路由信封与冻结的键材料。
async function dispatchExplicitRoot({ dir, repo, registryPath, runId }) {
  const { fakeSpawn, calls } = makeFakeSpawn();
  const result = await dispatchRun({
    agentId: LANE,
    prompt: "deliver the fix",
    registryPath,
    runDir: dir,
    runId,
    cwd: repo,
    delivery: DELIVERY,
    continuable: true,
    resolvedLane: LANE,
    resolvedRole: ROLE,
    resolvedRoleId: ROLE,
    backendFor: () => ({ supportsSessionReuse: true }),
    spawnFn: fakeSpawn,
    skipCredentialCheck: true,
  });
  assert.equal(result.accepted, true, "explicit lane+role continuable dispatch is accepted");
  const routing = JSON.parse(argVal(calls, "--session-reuse-json"));
  const material = JSON.parse(argVal(calls, "--reuse-material-json"));
  assert.equal(routing.mode, "run_lineage");
  assert.equal(routing.turn, "first");
  assert.match(routing.opaqueUuid, UUID_V4);
  assert.match(material.laneFingerprint, /^lane:[0-9a-f]{16}$/);
  assert.equal(material.roleSha256, ROLE_SHA, "material carries the dispatched role body sha");
  return { result, routing, material };
}

// 把 dispatch 写下的 pending 根补全成真实 run 的生命周期事实（runner 的
// RunManager.start 会写 run.started/session.created；本测试直接构造同一形状）。
async function seedRootLifecycle({
  dir, repo, runId, agentId, parent, backend, model,
  laneRole = null, rolePin = null, session = null,
}) {
  const transcriptPath = resolveTranscriptPath(dir, runId);
  const t = new JsonlTranscript(transcriptPath, { runId, agentId });
  await t.append("run.started", {
    backend,
    cwd: repo,
    ...(model ? { model } : {}),
    providerKey: null,
    worktreePath: parent.wt,
    worktreeBranch: parent.branch,
    ...(rolePin ? { rolePin } : {}),
    ...(laneRole ? {
      resolvedFrom: "explicit",
      laneId: laneRole.laneId,
      roleId: laneRole.roleId,
    } : {}),
    delivery: {
      mode: "git_commit_v1",
      baseCommit: parent.base,
      allowedPaths: DELIVERY.allowedPaths,
      verificationCommands: DELIVERY.verificationCommands,
    },
  });
  await t.append("run.session_reuse", { mode: "run_lineage", turn: "first", rootRunId: runId });
  if (session) {
    await t.append("session.created", {
      backend: session.backend,
      backendSessionId: session.backendSessionId,
      serveUrl: null,
    });
    if (session.boundProviderSessionId) {
      await t.append("run.provider_session_bound", {
        backend: session.backend,
        backendSessionId: session.backendSessionId,
        providerSessionId: session.boundProviderSessionId,
      });
    }
  }
  await t.append("run.delivery_created", {
    deliveryCommit: parent.deliveryCommit,
    delivery: {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit: parent.base, deliveryCommit: parent.deliveryCommit,
      branch: parent.branch, worktreePath: parent.wt, allowedPaths: DELIVERY.allowedPaths,
      changedFiles: ["keep.txt"], verification: { commands: DELIVERY.verificationCommands },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    },
  });
  await t.transitionState("pending", "completed", "done");
}

async function makeExplicitRoot({ runId, roleSha }) {
  const repo = makeRepo();
  const parent = buildParentWorktree(repo, runId);
  const dir = mkdtempSync(join(tmpdir(), "wao-0114-li-"));
  const registryPath = makeLaneRegistry(dir, repo);
  const first = await dispatchExplicitRoot({ dir, repo, registryPath, runId });
  const registry = await readRegistry(registryPath);
  const agent = registry.getAgent(LANE);
  await seedRootLifecycle({
    dir, repo, runId, agentId: LANE, parent,
    backend: agent.backend,
    model: agent.model,
    laneRole: { laneId: LANE, roleId: ROLE },
    rolePin: { systemPrompt: ROLE_SOURCE, sha256: roleSha ?? first.material.roleSha256 },
    session: { backend: "claude-code", backendSessionId: "provider-session-1" },
  });
  return { repo, dir, registryPath, parent, first };
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-0114-li", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function callRunContinueViaMcp({ dir, repo, registryPath, parentRunId, leadSession }) {
  const server = createWaoMcpServer({ registryPath, runDir: dir, workspaceRoot: repo, leadSession });
  const client = await buildInMemoryClient(server);
  try {
    return await client.callTool({
      name: "run_continue",
      arguments: { parentRunId, prompt: "fix the narrow defect", delivery: DELIVERY, expectedWorkspaceRoot: repo },
    });
  } finally {
    await client.close();
    await server.close();
  }
}

// =====================================================================
// LI-1：首轮与续修同一 opaque uuid / 路由键（explicit 车道+角色派发）
// =====================================================================

test("0114-LI-1: continuation re-derives the first turn's opaque uuid and routing key (explicit lane+role)", async () => {
  const RUN = "run_0114_li_root_01";
  const { repo, dir, registryPath, first } = await makeExplicitRoot({ runId: RUN });
  try {
    const expectedUuid = deriveLineageOpaqueUuid({
      workspace: repo, agentId: LANE, rootRunId: RUN, ...first.material,
    });
    assert.equal(first.routing.opaqueUuid, expectedUuid, "first turn derives from the frozen lineage material");

    const { fakeSpawn, calls } = makeFakeSpawn();
    const r = await continueRun({
      parentRunId: RUN,
      prompt: "correct the narrow defect",
      delivery: DELIVERY,
      runDir: dir,
      registryPath,
      authorizedWorkspaceRoot: repo,
      spawnFn: fakeSpawn,
      backendFor: () => ({ supportsSessionReuse: true }),
      skipCredentialCheck: true,
      // 宿主重启后新的 Lead 会话：不得影响谱系身份。
      leadSession: "restarted-host-lead",
    });
    assert.equal(r.accepted, true);
    const routing = JSON.parse(argVal(calls, "--session-reuse-json"));
    assert.equal(routing.mode, "run_lineage");
    assert.equal(routing.turn, "resume");
    assert.equal(routing.opaqueUuid, first.routing.opaqueUuid, "continuation resumes the SAME provider conversation");
    assert.equal(routing.priorRunId, RUN);
    // 子运行按根钉住的车道+角色重建（runner 用同一显式解析，不回退席位默认帽）。
    assert.equal(argVal(calls, "--lane"), LANE);
    assert.equal(argVal(calls, "--role"), ROLE);

    // 路由键也从同一材料派生：续修 claim 的就是首轮认领的槽位。
    const key = deriveLineageReuseKeyHash({ workspace: repo, agentId: LANE, rootRunId: RUN, ...first.material });
    const entry = JSON.parse(readFileSync(join(dir, ".lineage-reuse", `${key}.json`), "utf8"));
    assert.equal(entry.runId, r.runId, "continuation claims the SAME routing key (not a fresh lineage)");
  } finally {
    cleanup(dir, repo);
  }
});

// =====================================================================
// LI-2：换 Lead 会话（宿主重启）后续修——uuid 与路由键不变
// =====================================================================

test("0114-LI-2: a restarted host re-derives the same lineage uuid and routing key (Lead session is not material)", async () => {
  const RUN = "run_0114_li_root_02";
  const { repo, dir, first } = await makeExplicitRoot({ runId: RUN });
  try {
    const identity = { workspace: repo, agentId: LANE, rootRunId: RUN, ...first.material };
    const uuidA = deriveLineageOpaqueUuid({ ...identity, leadSession: "host-session-A" });
    const uuidB = deriveLineageOpaqueUuid({ ...identity, leadSession: "host-session-B" });
    assert.equal(uuidA, uuidB, "a host restart does not change the provider conversation identity");
    assert.equal(uuidA, first.routing.opaqueUuid, "restarted host still derives the root's first-turn uuid");
    assert.equal(
      deriveLineageReuseKeyHash({ ...identity, leadSession: "host-session-A" }),
      deriveLineageReuseKeyHash({ ...identity, leadSession: "host-session-B" }),
      "the routing slot (busy gate) is lineage-scoped, not Lead-session-scoped",
    );
  } finally {
    cleanup(dir, repo);
  }
});

// =====================================================================
// LI-3：宿主重启后忙碌门仍看见重启前的非终态续修子运行
// =====================================================================

test("0114-LI-3: an in-flight continuation is still busy for a restarted host (busy gate is lineage-scoped)", async () => {
  const RUN = "run_0114_li_root_03";
  const CHILD = "run_0114_li_child_inflight";
  const { repo, dir, registryPath, first } = await makeExplicitRoot({ runId: RUN });
  try {
    // 一个非终态的续修子运行占着谱系槽位（模拟重启前已 fork 的那一轮）。
    const child = new JsonlTranscript(join(dir, `${CHILD}.jsonl`), { runId: CHILD, agentId: LANE });
    await child.transitionState(null, "pending", "seed");
    const key = deriveLineageReuseKeyHash({ workspace: repo, agentId: LANE, rootRunId: RUN, ...first.material });
    mkdirSync(join(dir, ".lineage-reuse"), { recursive: true });
    writeFileSync(
      join(dir, ".lineage-reuse", `${key}.json`),
      JSON.stringify({ runId: CHILD, updatedAt: Date.now() }),
      "utf8",
    );
    const before = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();

    for (const leadSession of ["host-session-A", "host-session-B"]) {
      const r = await callRunContinueViaMcp({ dir, repo, registryPath, parentRunId: RUN, leadSession });
      assert.equal(r.isError, undefined, "busy is a structured refusal, not an MCP error");
      assert.equal(r.structuredContent.accepted, false);
      assert.equal(r.structuredContent.rejectionReason, "busy", `restarted host (${leadSession}) still sees the in-flight child`);
      assert.ok(!JSON.stringify(r).includes(CHILD), "active lineage runId never surfaces in MCP output");
    }

    const after = readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
    assert.deepEqual(after, before, "no child transcript / no fork for either busy refusal");
  } finally {
    cleanup(dir, repo);
  }
});

// =====================================================================
// LI-4：原生 id 车道——换 Lead 会话后仍按父转录取回 native id
// =====================================================================

test("0114-LI-4: native-id lane recovers the parent transcript's native id after a host restart", async () => {
  const RUN = "run_0114_li_kimi_root";
  const NATIVE = "session_014e3fb4-1dbd-435e-a883-a63245876ea0";
  const repo = makeRepo();
  const parent = buildParentWorktree(repo, RUN);
  const dir = mkdtempSync(join(tmpdir(), "wao-0114-li-kimi-"));
  const registryPath = makeRegistry(dir, { kimi_worker: { backend: "kimi-code", cwd: repo } });
  try {
    const { fakeSpawn: dispatchSpawn, calls: dispatchCalls } = makeFakeSpawn();
    const dispatched = await dispatchRun({
      agentId: "kimi_worker",
      prompt: "deliver",
      registryPath,
      runDir: dir,
      runId: RUN,
      cwd: repo,
      delivery: DELIVERY,
      continuable: true,
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: dispatchSpawn,
      skipCredentialCheck: true,
    });
    assert.equal(dispatched.accepted, true);
    const firstRouting = JSON.parse(argVal(dispatchCalls, "--session-reuse-json"));
    const material = JSON.parse(argVal(dispatchCalls, "--reuse-material-json"));
    await seedRootLifecycle({
      dir, repo, runId: RUN, agentId: "kimi_worker", parent,
      backend: "kimi-code",
      session: {
        backend: "kimi-code",
        backendSessionId: "proc_43244",
        boundProviderSessionId: NATIVE,
      },
    });
    // 父转录取回的是运行期绑定的 native id（不是 proc_ 占位）。
    assert.equal(await resolvePriorProviderSessionId({ runDir: dir, priorRunId: RUN }), NATIVE);
    const kimi = new KimiCodeBackend();
    assert.equal(kimi.canResumeWithRecoveredSessionId(NATIVE), true);
    assert.equal(kimi.canResumeWithRecoveredSessionId("proc_43244"), false);

    const { fakeSpawn, calls } = makeFakeSpawn();
    const r = await continueRun({
      parentRunId: RUN,
      prompt: "fix the narrow defect",
      delivery: DELIVERY,
      runDir: dir,
      registryPath,
      authorizedWorkspaceRoot: repo,
      spawnFn: fakeSpawn,
      backendFor: () => kimi,
      skipCredentialCheck: true,
      leadSession: "restarted-host-lead",
    });
    assert.equal(r.accepted, true);
    const routing = JSON.parse(argVal(calls, "--session-reuse-json"));
    assert.equal(routing.opaqueUuid, firstRouting.opaqueUuid, "native lane lineage identity is also root-pinned and restart-stable");
    assert.equal(routing.priorRunId, RUN, "runner reads the native id from the parent transcript via priorRunId");
    assert.ok(!JSON.stringify(routing).includes(NATIVE), "native provider id never enters the routing envelope/argv");

    const key = deriveLineageReuseKeyHash({ workspace: repo, agentId: "kimi_worker", rootRunId: RUN, ...material });
    const entry = JSON.parse(readFileSync(join(dir, ".lineage-reuse", `${key}.json`), "utf8"));
    assert.equal(entry.runId, r.runId);
  } finally {
    cleanup(dir, repo);
  }
});

// =====================================================================
// LI-5：explicit 父档角色正文漂移 → role_contract_drift
// =====================================================================

test("0114-LI-5: explicit lineage role body drift refuses with role_contract_drift (no hat switch)", async () => {
  const RUN = "run_0114_li_root_05";
  // 根钉住的是"改正文之前"的 sha（模拟派发后角色正文被改）。
  const TAMPERED_SHA = "f".repeat(64);
  const { repo, dir, registryPath, parent, first } = await makeExplicitRoot({ runId: RUN, roleSha: TAMPERED_SHA });
  try {
    assert.notEqual(TAMPERED_SHA, first.material.roleSha256);
    const headBefore = git("rev-parse HEAD", parent.wt);
    const { fakeSpawn, calls } = makeFakeSpawn();
    const r = await continueRun({
      parentRunId: RUN,
      prompt: "fix the narrow defect",
      delivery: DELIVERY,
      runDir: dir,
      registryPath,
      authorizedWorkspaceRoot: repo,
      spawnFn: fakeSpawn,
      backendFor: () => ({ supportsSessionReuse: true }),
      skipCredentialCheck: true,
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "role_contract_drift");
    assert.match(r.detail, /different role/);
    assert.equal(calls.length, 0, "no fork on role drift");
    assert.equal(git("rev-parse HEAD", parent.wt), headBefore, "read-only refusal leaves the retained worktree untouched");
  } finally {
    cleanup(dir, repo);
  }
});

// =====================================================================
// LI-6：专家复用（lead_workspace）不变——同 Lead 会话 resume、换 Lead 会话 first
// =====================================================================

test("0114-LI-6: expert reuse (lead_workspace) is still keyed by the Lead session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-0114-li-expert-"));
  const base = { runDir: dir, workspace: "D:/proj", agentId: "coder_hq" };
  try {
    assert.notEqual(
      deriveOpaqueUuid({ ...base, leadSession: "lead-A" }),
      deriveOpaqueUuid({ ...base, leadSession: "lead-B" }),
      "expert reuse keeps the Lead session in its identity (unchanged by 0114)",
    );
    await resolveReuseTurn({ ...base, runId: "run_expert_a", leadSession: "lead-A" });
    const t = new JsonlTranscript(join(dir, "run_expert_a.jsonl"), { runId: "run_expert_a", agentId: "coder_hq" });
    await t.transitionState(null, "pending", "seed");
    await t.append("session.created", { backend: "claude-code", backendSessionId: "provider-session-1", serveUrl: null });
    await t.transitionState("pending", "completed", "done");

    const sameLead = await resolveReuseTurn({ ...base, runId: "run_expert_b", leadSession: "lead-A" });
    assert.equal(sameLead.kind, "resume", "same Lead session resumes the expert conversation");
    const otherLead = await resolveReuseTurn({ ...base, runId: "run_expert_c", leadSession: "lead-B" });
    assert.equal(otherLead.kind, "first", "a different Lead session starts a fresh expert conversation");
    assert.notEqual(otherLead.routing.opaqueUuid, sameLead.routing.opaqueUuid);
  } finally {
    cleanup(dir);
  }
});

// =====================================================================
// LI-7 / LI-8：续修把根冻结材料交给 runner 复核（决定 0114 修订）
//   - runner 的复核只在 --reuse-material-json 在场时执行（backgroundRunner）；
//   - agentId 续修与 explicit lane+role 续修两种形状都要覆盖；
//   - 资格检查之后角色正文/车道接线再变 → runner 在 backend spawn 前
//     reuse_material_mismatch 失败收口。
// =====================================================================

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// 会审别名席位（review_expert → opus + researcher，researcher 政策=lead_workspace）
// 的真实派发：用真实 dispatchRun 生成 runner argv，fake spawn 只捕获不 fork。
async function captureConsultAliasDispatch({ dir, repo, registryPath }) {
  const opusLane = loadLanesConfig().lanes.find((l) => l.id === LANE);
  const lanesDoc = {
    ok: true,
    sha256: "consult-alias-fixture",
    issues: [],
    rolesHint: ["researcher"],
    lanes: [{
      id: LANE,
      backend: opusLane.backend,
      model: opusLane.model,
      reasoning: opusLane.reasoning,
      aliases: { review_expert: { role: "researcher" } },
    }],
  };
  let runnerArgs = null;
  let prompt = null;
  const dispatchFn = async (input) => {
    prompt = input.prompt;
    return dispatchRun({
      ...input,
      spawnFn: (_cmd, args) => {
        runnerArgs = args;
        return { unref() {} };
      },
    });
  };
  await runConsult({
    briefText: "## Q1 方案可行吗\n",
    seats: [{ agentId: "review_expert" }],
    registryPath,
    runDir: dir,
    consultsDir: join(dir, "consults"),
    cwd: repo,
    budgetMs: 0,
    budgetFloorMs: 0,
    pollIntervalMs: 1,
    lanesDocFn: () => lanesDoc,
    dispatchFn,
  });
  assert.ok(runnerArgs, "consult alias seat dispatched through the real dispatch service");
  return { runnerArgs, prompt };
}

function makeRunnerBackend() {
  const state = { spawns: 0 };
  const backend = {
    supportsSessionReuse: true,
    supportsRoleContract: true,
    sessionOutlivesProcess: false,
    defaultBinary() { return "node"; },
    credentialEnvNames: () => [],
    validateAgentPolicy() {},
    async spawn() {
      state.spawns += 1;
      return {
        backend: "claude-code", backendSessionId: "proc_consult_alias", messageId: "m1", admittedSeq: 5,
        async *events() { yield { kind: "done", reason: "completed" }; },
        abort: async () => {},
      };
    },
  };
  return { backend, state };
}

async function makeConsultAliasFixture() {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-0114-consult-alias-"));
  const laneSeat = loadLanesConfig().lanes.find((l) => l.id === LANE);
  const registryPath = makeRegistry(dir, {
    [LANE]: {
      backend: laneSeat.backend,
      model: laneSeat.model,
      reasoning: laneSeat.reasoning,
      cwd: repo,
    },
  });
  return { repo, dir, registryPath };
}

async function readChildOutcome(transcriptPath) {
  const events = await readTranscript(transcriptPath);
  return {
    state: findState(events),
    error: events.find((e) => e && e.type === "run.error") ?? null,
    started: events.some((e) => e && e.type === "run.started"),
    sessionCreated: events.some((e) => e && e.type === "session.created"),
  };
}

test("0114-LI-7: agentId continuation ships the root material; role body drift after acceptance fails before backend start", async () => {
  const RUN = "run_0114_li_agent_root";
  const PROMPT = "fix the narrow defect";
  const repo = makeRepo();
  const parent = buildParentWorktree(repo, RUN);
  const dir = mkdtempSync(join(tmpdir(), "wao-0114-li-material-agent-"));
  const rolePath = join(dir, "agent-root-role.md");
  const originalRole = "# Role: Temp\nROOT_ORIGINAL\n";
  writeFileSync(rolePath, originalRole, "utf8");
  const registryPath = makeRegistry(dir, {
    coder_temp: { backend: "claude-code", cwd: repo, systemPrompt: rolePath },
  });
  try {
    const { fakeSpawn: dispatchSpawn, calls: dispatchCalls } = makeFakeSpawn();
    const dispatched = await dispatchRun({
      agentId: "coder_temp",
      prompt: "deliver",
      registryPath,
      runDir: dir,
      runId: RUN,
      cwd: repo,
      delivery: DELIVERY,
      continuable: true,
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: dispatchSpawn,
      skipCredentialCheck: true,
    });
    assert.equal(dispatched.accepted, true);
    const rootMaterial = JSON.parse(argVal(dispatchCalls, "--reuse-material-json"));
    await seedRootLifecycle({
      dir, repo, runId: RUN, agentId: "coder_temp", parent,
      backend: "claude-code",
      rolePin: { systemPrompt: rolePath, sha256: roleContractSha256(loadRoleContract(rolePath)) },
      session: { backend: "claude-code", backendSessionId: "provider-session-1" },
    });

    const { fakeSpawn, calls } = makeFakeSpawn();
    const continued = await continueRun({
      parentRunId: RUN,
      prompt: PROMPT,
      delivery: DELIVERY,
      runDir: dir,
      registryPath,
      authorizedWorkspaceRoot: repo,
      spawnFn: fakeSpawn,
      backendFor: () => ({ supportsSessionReuse: true }),
      skipCredentialCheck: true,
    });
    assert.equal(continued.accepted, true);
    assert.deepEqual(JSON.parse(argVal(calls, "--reuse-material-json")), rootMaterial,
      "continuation ships the SAME frozen lineage material to the runner");

    // 资格检查之后角色正文再被改：runner 必须按冻结材料拒，未进 backend spawn。
    writeFileSync(rolePath, "# Role: Temp\nTAMPERED_AFTER_ACCEPT\n", "utf8");
    await runCapturedRunner(calls[0].args, PROMPT);
    const outcome = await readChildOutcome(continued.transcriptPath);
    assert.equal(outcome.state, "failed", "runner fails closed on post-acceptance role drift");
    assert.equal(outcome.error?.error, "reuse_material_mismatch");
    assert.equal(outcome.started, false, "no run.started / backend start");
    assert.equal(outcome.sessionCreated, false, "no backend spawn");
    assert.equal(existsSync(join(dir, `.owner-${continued.runId}`)), false,
      "spawn 前失败收口撤掉 ownership 心跳文件");
  } finally {
    cleanup(dir, repo);
  }
});

test("0114-LI-8: explicit lane+role continuation ships the root material; lane wiring drift after acceptance fails before backend start", async () => {
  const RUN = "run_0114_li_lane_root";
  const PROMPT = "fix the narrow defect";
  const { repo, dir, registryPath, first } = await makeExplicitRoot({ runId: RUN });
  try {
    const { fakeSpawn, calls } = makeFakeSpawn();
    const continued = await continueRun({
      parentRunId: RUN,
      prompt: PROMPT,
      delivery: DELIVERY,
      runDir: dir,
      registryPath,
      authorizedWorkspaceRoot: repo,
      spawnFn: fakeSpawn,
      backendFor: () => ({ supportsSessionReuse: true }),
      skipCredentialCheck: true,
    });
    assert.equal(continued.accepted, true);
    assert.deepEqual(JSON.parse(argVal(calls, "--reuse-material-json")), first.material,
      "explicit lane+role continuation ships the root's frozen lane fingerprint + role sha");

    // 资格检查之后 registry 车道接线再变：runner 重算的车道指纹与冻结值不等。
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    registry.agents[LANE].model = { id: "claude-opus-5-5-drifted" };
    writeFileSync(registryPath, JSON.stringify(registry), "utf8");

    await runCapturedRunner(calls[0].args, PROMPT);
    const outcome = await readChildOutcome(continued.transcriptPath);
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.error?.error, "reuse_material_mismatch");
    assert.equal(outcome.started, false, "no run.started / backend start");
    assert.equal(outcome.sessionCreated, false, "no backend spawn");
    assert.equal(existsSync(join(dir, `.owner-${continued.runId}`)), false,
      "spawn 前失败收口撤掉 ownership 心跳文件");
  } finally {
    cleanup(dir, repo);
  }
});

// =====================================================================
// LI-9 / LI-10：会审别名席位的角色材料同源（决定 0114 修订）
//   review_expert → opus + researcher（researcher 政策=lead_workspace）。
//   真实 consult 派发生的 runner argv 必须带 --lane/--role（与冻结材料同源）；
//   交给 runMain 后不得误判 reuse_material_mismatch，run.started 记别名角色。
// =====================================================================

test("0114-LI-9: consult alias seat hands the SAME role to runner and frozen material (no false mismatch)", async () => {
  const { repo, dir, registryPath } = await makeConsultAliasFixture();
  try {
    const { runnerArgs, prompt } = await captureConsultAliasDispatch({ dir, repo, registryPath });
    assert.equal(flagValue(runnerArgs, "--lane"), LANE, "alias executes on its lane");
    assert.equal(flagValue(runnerArgs, "--role"), "researcher", "alias role is handed to the runner");
    assert.equal(flagValue(runnerArgs, "--resolved-from"), "alias", "alias provenance is preserved");
    const childRunId = flagValue(runnerArgs, "--run-id");
    const { backend, state } = makeRunnerBackend();
    await runCapturedRunner(runnerArgs, prompt, { backendFor: () => backend });

    const events = await readTranscript(resolveTranscriptPath(dir, childRunId));
    const started = events.find((e) => e && e.type === "run.started");
    assert.ok(started, "run.started exists");
    assert.equal(started.resolvedFrom, "alias");
    assert.equal(started.laneId, LANE);
    assert.equal(started.roleId, "researcher");
    assert.equal(started.rolePin.systemPrompt, "config/roles/researcher.md");
    assert.equal(state.spawns, 1, "backend started exactly once");
    assert.equal(events.some((e) => e && e.type === "run.error" && e.error === "reuse_material_mismatch"), false,
      "same role on both sides => no false reuse_material_mismatch");
  } finally {
    cleanup(dir, repo);
  }
});

test("0114-LI-12: resolvedRoleId-only dispatch executes and freezes that same role (no separate --role needed from caller)", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-0114-roleid-only-"));
  const laneSeat = loadLanesConfig().lanes.find((l) => l.id === LANE);
  const registryPath = makeRegistry(dir, {
    [LANE]: { backend: laneSeat.backend, model: laneSeat.model, reasoning: laneSeat.reasoning, cwd: repo },
  });
  try {
    const { fakeSpawn, calls } = makeFakeSpawn();
    const dispatched = await dispatchRun({
      agentId: LANE,
      prompt: "role-id-only task",
      registryPath,
      runDir: dir,
      runId: "run_0114_roleid_only",
      cwd: repo,
      leadSession: "roleid-only-lead",
      resolvedLane: LANE,
      resolvedRoleId: "researcher", // 调用方未传 resolvedRole（旧 consult 形状）
      spawnFn: fakeSpawn,
      skipCredentialCheck: true,
    });
    assert.equal(dispatched.accepted, true);
    assert.equal(argVal(calls, "--role"), "researcher", "central rule hands the resolved role to the runner");
    assert.equal(JSON.parse(argVal(calls, "--reuse-material-json")).roleSha256,
      roleContractSha256(loadRoleContract("config/roles/researcher.md")),
      "frozen material uses the same executed role");
    const { backend, state } = makeRunnerBackend();
    await runCapturedRunner(calls[0].args, "role-id-only task", { backendFor: () => backend });
    const events = await readTranscript(resolveTranscriptPath(dir, "run_0114_roleid_only"));
    assert.equal(state.spawns, 1);
    assert.equal(events.some((e) => e && e.type === "run.error" && e.error === "reuse_material_mismatch"), false);
    const started = events.find((e) => e && e.type === "run.started");
    assert.equal(started.roleId, "researcher");
    assert.equal(started.rolePin.systemPrompt, "config/roles/researcher.md");
  } finally {
    cleanup(dir, repo);
  }
});

test("0114-LI-11: lane-only dispatch (no role) has the same no-role material on both sides", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-0114-lane-only-"));
  const laneSeat = loadLanesConfig().lanes.find((l) => l.id === LANE);
  const registryPath = makeRegistry(dir, {
    [LANE]: {
      backend: laneSeat.backend,
      model: laneSeat.model,
      reasoning: laneSeat.reasoning,
      cwd: repo,
      sessionReuse: "lead_workspace",
    },
  });
  try {
    const { fakeSpawn, calls } = makeFakeSpawn();
    const dispatched = await dispatchRun({
      agentId: LANE,
      prompt: "lane-only task",
      registryPath,
      runDir: dir,
      runId: "run_0114_lane_only",
      cwd: repo,
      leadSession: "lane-only-lead",
      spawnFn: fakeSpawn,
      skipCredentialCheck: true,
    });
    assert.equal(dispatched.accepted, true);
    assert.equal(argVal(calls, "--role"), undefined, "lane-only dispatch hands no role to the runner");
    assert.equal(JSON.parse(argVal(calls, "--reuse-material-json")).roleSha256, "none");
    const { backend, state } = makeRunnerBackend();
    await runCapturedRunner(calls[0].args, "lane-only task", { backendFor: () => backend });
    const events = await readTranscript(resolveTranscriptPath(dir, "run_0114_lane_only"));
    assert.equal(state.spawns, 1, "lane-only runner reached the backend");
    assert.equal(events.some((e) => e && e.type === "run.error" && e.error === "reuse_material_mismatch"), false,
      "lane-only no-role material is identical on both sides");
    const started = events.find((e) => e && e.type === "run.started");
    assert.ok(started);
    assert.equal(started.rolePin, undefined, "lane-only has no role pin");
  } finally {
    cleanup(dir, repo);
  }
});

test("0114-LI-10: consult alias role body change after dispatch still fails reuse_material_mismatch (no backend start)", async () => {
  const { repo, dir, registryPath } = await makeConsultAliasFixture();
  try {
    const { runnerArgs, prompt } = await captureConsultAliasDispatch({ dir, repo, registryPath });
    const childRunId = flagValue(runnerArgs, "--run-id");
    const { backend, state } = makeRunnerBackend();
    // 注入的角色正文读取缝模拟“派发后 researcher.md 被改”——不写共享角色库。
    await runCapturedRunner(runnerArgs, prompt, {
      backendFor: () => backend,
      loadRoleContractFn: () => "# Role: Researcher\nTAMPERED_AFTER_DISPATCH\n",
    });
    const outcome = await readChildOutcome(resolveTranscriptPath(dir, childRunId));
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.error?.error, "reuse_material_mismatch");
    assert.equal(outcome.started, false, "no run.started / backend start");
    assert.equal(outcome.sessionCreated, false, "no provider session");
    assert.equal(state.spawns, 0, "no backend spawn");
  } finally {
    cleanup(dir, repo);
  }
});
