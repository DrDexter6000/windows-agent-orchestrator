// test/mcp-surface/mcpConsultRound.test.js
//
// 第 155 批（台账 TD-385）：run_consult 的会审轮次——MCP 面。
//   · 第 3 轮起回执带 round 与提醒原文；第 1、2 轮回执不带这两个键（text 通道与改前同形）
//   · 新增可选输入 follows（这是哪一场的下一轮）：串联 1→2→3；指向读不出的会审 → 具名拒绝、零派发
//   · 读取模式（consultId）按记录里的 round（旧记录现算）带同一句
//   · 提醒不改席位派发
// 真实服务 + 假派发（dispatchRunFn）；一切文件在 mkdtempSync(tmpdir) 下。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Owner 给定的提醒原文（一字不改）。
const ADVISORY = "本次会审已超过2轮，请注意掌握节奏、请独立思考、客观判断：继续会审的必要性和ROI。";
const BRIEF = "会审任务书\n\n## Q1 方案可行吗\n";

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name t", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

function makeRegistry(dir) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({
    agents: {
      seat_a: { backend: "deepseek-acp", cwd: dir, credentialEnv: "STUB_KEY", model: { id: "model-seat_a", providerID: "deepseek-official" } },
      seat_b: { backend: "codex", cwd: dir, model: { id: "model-seat_b" } },
    },
  }), "utf8");
  return registryPath;
}

function writeTranscript(runDir, runId, events) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, `${runId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/** 交付运行转录：root===runId 是谱系根，否则是 root 的续修后代。 */
function writeRun(runDir, runId, rootRunId = runId) {
  const events = [{ type: "run.started", runId, seq: 1 }];
  if (rootRunId !== runId) {
    events.push({ type: "run.background_submitted", runId, rootRunId, continuation: true, parentRunId: rootRunId, seq: 2 });
  }
  events.push({ type: "run.session_reuse", runId, rootRunId, mode: "run_lineage", turn: rootRunId === runId ? "first" : "resume", seq: 3 });
  writeTranscript(runDir, runId, events);
}

function writeSeatRun(runDir, runId) {
  writeTranscript(runDir, runId, [
    { type: "run.started", worktreePath: "C:\\fake\\wt", runId, seq: 1 },
    { type: "run.read_only_declared", runId, seq: 2 },
    { type: "run.state_change", to: "completed", reason: "stub", runId, seq: 3 },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "Q1: 可行\n" }], runId, seq: 4 },
  ]);
}

async function buildClient({ dir, registryPath, runDir, consultsDir }) {
  const { createWaoMcpServer } = await import("../../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const dispatchCalls = [];
  const server = createWaoMcpServer({
    registryPath,
    runDir,
    workspaceRoot: dir,
    consultsDir,
    dispatchRunFn: async (input) => {
      dispatchCalls.push(input);
      return { accepted: true, runId: `run_consult_stub_${input.agentId}`, state: "pending" };
    },
  });
  const client = new Client({ name: "wao-consult-round-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { server, client, dispatchCalls };
}

// separateState：状态目录与决定 0111 的旧落点（<根>/.wao/runs/consults）分开，模拟链接工作树迁移后的形状。
async function withWorld(prefix, fn, { separateState = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    makeGitRepo(dir);
    const registryPath = makeRegistry(dir);
    const runDir = join(dir, "runs");
    const legacyDir = join(dir, ".wao", "runs", "consults");
    const consultsDir = separateState ? join(dir, "state-consults") : legacyDir;
    mkdirSync(consultsDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    const built = await buildClient({ dir, registryPath, runDir, consultsDir });
    try {
      await fn({ dir, runDir, consultsDir, legacyDir, ...built });
    } finally {
      await built.client.close();
      await built.server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const create = (client, dir, extra = {}) => client.callTool({
  name: "run_consult",
  arguments: { brief: BRIEF, seats: ["seat_a", "seat_b"], expectedWorkspaceRoot: dir, waitMs: 0, ...extra },
});

const errText = (res) => (res?.content ?? []).map((c) => c.text || "").join(" ");

test("MCR155-1: 交付会审——第 3 轮起回执带 round + 提醒原文；第 1、2 轮两个键都没有（text 通道也没有）", async () => {
  await withWorld("wao-mcr155-1-", async ({ dir, runDir, client, dispatchCalls }) => {
    writeRun(runDir, "run_root_m");
    writeRun(runDir, "run_cont_m1", "run_root_m");
    writeRun(runDir, "run_cont_m2", "run_root_m");
    writeRun(runDir, "run_other_m");
    const first = await create(client, dir, { reviewedRunId: "run_root_m" });
    const second = await create(client, dir, { reviewedRunId: "run_cont_m1" });
    for (const [label, res] of [["第 1 轮", first], ["第 2 轮", second]]) {
      assert.notEqual(res.isError, true, `${label}：${errText(res)}`);
      assert.ok(!("round" in res.structuredContent) && !("roundAdvisory" in res.structuredContent), `${label}：回执没有 round/roundAdvisory`);
      assert.ok(!res.content[0].text.includes("本次会审已超过2轮"), `${label}：text 通道没有提醒`);
    }
    const third = await create(client, dir, { reviewedRunId: "run_cont_m2" });
    assert.notEqual(third.isError, true, errText(third));
    assert.equal(third.structuredContent.round, 3);
    assert.equal(third.structuredContent.roundAdvisory, ADVISORY);
    assert.equal(JSON.parse(third.content[0].text).roundAdvisory, ADVISORY, "text 通道同一句");
    // 提醒不改席位派发：每场会审仍是两席、都只读；第 3 轮照常扇出。
    assert.equal(dispatchCalls.length, 6);
    assert.ok(dispatchCalls.every((c) => c.readOnly === true));
    // 另一条谱系不串号：自己从第 1 轮数起。
    const other = await create(client, dir, { reviewedRunId: "run_other_m" });
    assert.ok(!("round" in other.structuredContent));
    // 记录里写 round。
    assert.equal(JSON.parse(readFileSync(third.structuredContent.recordPath, "utf8")).round, 3);
  });
});

test("MCR155-2: follows 串联 1→2→3；记录写 follows；follows 指向读不出的会审 → 具名拒绝、零派发", async () => {
  await withWorld("wao-mcr155-2-", async ({ dir, consultsDir, client, dispatchCalls }) => {
    const p1 = await create(client, dir);
    assert.notEqual(p1.isError, true, errText(p1));
    assert.ok(!("round" in p1.structuredContent));
    const p2 = await create(client, dir, { follows: p1.structuredContent.consultId });
    assert.ok(!("round" in p2.structuredContent), "第 2 轮不带提醒");
    const p3 = await create(client, dir, { follows: p2.structuredContent.consultId });
    assert.equal(p3.structuredContent.round, 3);
    assert.equal(p3.structuredContent.roundAdvisory, ADVISORY);
    const record = JSON.parse(readFileSync(p3.structuredContent.recordPath, "utf8"));
    assert.equal(record.round, 3);
    assert.equal(record.follows, p2.structuredContent.consultId);

    const dispatchedBefore = dispatchCalls.length;
    const filesBefore = readdirSync(consultsDir).sort();
    const missing = await create(client, dir, { follows: "consult_20990101000000000nope00" });
    assert.equal(missing.isError, true);
    assert.ok(errText(missing).includes("consult_20990101000000000nope00"), "具名拒绝点名这个 id");
    assert.ok(errText(missing).includes("nothing was dispatched"));
    assert.equal(dispatchCalls.length, dispatchedBefore, "零派发");
    assert.deepEqual(readdirSync(consultsDir).sort(), filesBefore, "零新记录");

    // follows 只属于创建模式：与 consultId 同给 = 模式互斥拒绝。
    const mixed = await client.callTool({
      name: "run_consult",
      arguments: { consultId: p1.structuredContent.consultId, follows: p1.structuredContent.consultId, expectedWorkspaceRoot: dir },
    });
    assert.equal(mixed.isError, true);
    assert.ok(errText(mixed).includes("exactly one mode"));
    // 形状不对的 follows 在入参校验层就被拒（调用不会走到派发）。
    // （SDK 的入参校验拒绝可能 throw，也可能回 isError 结果——两种都算拒绝。）
    const malformed = await create(client, dir, { follows: "not-a-consult-id" }).catch(() => ({ isError: true }));
    assert.equal(malformed.isError, true);
    assert.equal(dispatchCalls.length, dispatchedBefore);
  });
});

test("MCR155-3: 读取模式——记录里 round≥3 的回执带同一句，round≤2 的不带；旧记录按谱系现算", async () => {
  await withWorld("wao-mcr155-3-", async ({ dir, runDir, consultsDir, client }) => {
    writeSeatRun(runDir, "run_consult_stub_seat_a");
    const seat = { agentId: "seat_a", runId: "run_consult_stub_seat_a", runState: "completed", formatState: "structured", backend: null, provider: null };
    const base = {
      createdAt: "2026-11-27T00:00:00.000Z", brief: { path: null, sha256: "ab".repeat(32) }, budgetMs: 180000, elapsedMs: 5,
      questions: [{ q: 1, heading: "Q1 方案可行吗" }], seats: [seat], fieldDiff: [],
    };
    const write = (consultId, extra) => writeFileSync(join(consultsDir, `${consultId}.json`), JSON.stringify({ consultId, ...base, ...extra }), "utf8");
    write("consult_20261127000000000round3", { round: 3 });
    write("consult_20261127000000000round2", { round: 2 });
    // 旧记录（没有 round）：三场同谱系的交付会审，最后一场现算为第 3 轮。
    writeRun(runDir, "run_root_o");
    writeRun(runDir, "run_cont_o1", "run_root_o");
    writeRun(runDir, "run_cont_o2", "run_root_o");
    write("consult_20261001000000000legacy1", { createdAt: "2026-10-01T00:00:00.000Z", reviewedRunId: "run_root_o" });
    write("consult_20261002000000000legacy2", { createdAt: "2026-10-02T00:00:00.000Z", reviewedRunId: "run_cont_o1" });
    write("consult_20261003000000000legacy3", { createdAt: "2026-10-03T00:00:00.000Z", reviewedRunId: "run_cont_o2" });
    const read = (consultId) => client.callTool({ name: "run_consult", arguments: { consultId, expectedWorkspaceRoot: dir } });

    const r3 = await read("consult_20261127000000000round3");
    assert.notEqual(r3.isError, true, errText(r3));
    assert.equal(r3.structuredContent.round, 3);
    assert.equal(r3.structuredContent.roundAdvisory, ADVISORY);
    const r2 = await read("consult_20261127000000000round2");
    assert.ok(!("round" in r2.structuredContent) && !("roundAdvisory" in r2.structuredContent));
    assert.ok(!r2.content[0].text.includes("本次会审已超过2轮"));
    assert.ok(!("round" in (await read("consult_20261002000000000legacy2")).structuredContent));
    const legacy3 = await read("consult_20261003000000000legacy3");
    assert.equal(legacy3.structuredContent.round, 3);
    assert.equal(legacy3.structuredContent.roundAdvisory, ADVISORY);
  });
});

test("MCR155-4: 旧落点（<根>/.wao/runs/consults）里的同谱系记录也算——创建与读取都合并两个目录", async () => {
  await withWorld("wao-mcr155-4-", async ({ dir, runDir, consultsDir, legacyDir, client }) => {
    writeRun(runDir, "run_root_n");
    writeRun(runDir, "run_cont_n1", "run_root_n");
    writeRun(runDir, "run_cont_n2", "run_root_n");
    writeSeatRun(runDir, "run_consult_stub_seat_a");
    const seat = { agentId: "seat_a", runId: "run_consult_stub_seat_a", runState: "completed", formatState: "structured", backend: null, provider: null };
    const record = (consultId, createdAt, reviewedRunId, extra = {}) => ({
      consultId, createdAt, brief: { path: null, sha256: "ab".repeat(32) }, budgetMs: 180000, elapsedMs: 5,
      questions: [{ q: 1, heading: "Q1 方案可行吗" }], seats: [seat], fieldDiff: [], reviewedRunId, ...extra,
    });
    // 两份同谱系记录只在旧落点（状态目录里什么都没有）。
    writeFileSync(join(legacyDir, "consult_20261001000000000mold01.json"), JSON.stringify(record("consult_20261001000000000mold01", "2026-10-01T00:00:00.000Z", "run_root_n", { round: 1 })), "utf8");
    writeFileSync(join(legacyDir, "consult_20261002000000000mold02.json"), JSON.stringify(record("consult_20261002000000000mold02", "2026-10-02T00:00:00.000Z", "run_cont_n1", { round: 2 })), "utf8");
    const created = await create(client, dir, { reviewedRunId: "run_cont_n2" });
    assert.notEqual(created.isError, true, errText(created));
    assert.equal(created.structuredContent.round, 3, "旧落点的两份 + 本次 = 第 3 轮");
    assert.equal(created.structuredContent.roundAdvisory, ADVISORY);
    assert.ok(readdirSync(consultsDir).some((f) => f.startsWith(created.structuredContent.consultId)), "新记录写在状态目录");
    // 读取：状态目录里一份没有 round 的旧记录，前两场在旧落点——现算为第 3 轮。
    writeFileSync(join(consultsDir, "consult_20261003000000000mold03.json"), JSON.stringify(record("consult_20261003000000000mold03", "2026-10-03T00:00:00.000Z", "run_cont_n2")), "utf8");
    const read = await client.callTool({ name: "run_consult", arguments: { consultId: "consult_20261003000000000mold03", expectedWorkspaceRoot: dir } });
    assert.notEqual(read.isError, true, errText(read));
    assert.equal(read.structuredContent.round, 3);
    assert.equal(read.structuredContent.roundAdvisory, ADVISORY);
  }, { separateState: true });
});