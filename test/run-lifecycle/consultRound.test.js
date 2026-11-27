// test/run-lifecycle/consultRound.test.js
//
// 第 155 批（台账 TD-385）：会审以全局为重 + 超过 2 轮时提醒 Lead（只提醒，不阻止）。
//
//   A 固定合同：新审查口径句在每席 prompt 末尾；历史 prompt（旧固定句）与当前 prompt
//     都能被 stripConsultSeatContract 剥掉；两个角色文件带同义一句。
//   B 轮次：交付会审同一谱系第 1、2、3 轮；跨谱系不串；follows 串联 1→2→3；follows 指向
//     不存在的会审 → 具名拒绝（零派发）；两种算法取较大值；旧记录（没有 round）现算且不回写。
//   C 提醒（CLI）：第 3 轮起 run 开始时 stderr 一行 + 结果/show/wait 输出里一行原文；
//     第 1、2 轮输出不变；提醒不改退出码、结论与席位派发；--seat 原文输出不混入提醒。
//
// MCP 面的同类断言在 test/mcp-surface/mcpConsultRound.test.js。
// 全部假派发；真实文件面一律 mkdtempSync(tmpdir)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runConsult,
  rerenderConsultFromRecord,
  buildConsultSeatPrompt,
  stripConsultSeatContract,
  CONSULT_SEAT_CONTRACT_MARKER,
  CONSULT_SEAT_CONTRACT_TEXT,
  CONSULT_ROUND_ADVISORY,
  ConsultFollowsRefusalError,
} from "../../src/application/consultService.js";
import { resolveNewConsultRound } from "../../src/application/consultRound.js";
import { readTranscript } from "../../src/transcript.js";
import { consultCommand, renderCouncilDiffText, CONSULT_USAGE } from "../../src/commands/consult.js";

// Owner 给定的提醒原文（一字不改）——测试里独立钉一份，不引用源码常量。
const ADVISORY = "本次会审已超过2轮，请注意掌握节奏、请独立思考、客观判断：继续会审的必要性和ROI。";
const REVIEW_TONE = "以全局为重：先报影响正确性、数据安全、可用性和既定约定的问题；边缘或概率极小的情形可以提，但须在该条开头标注【边缘】，并写明触发条件与可能性。";
// 第 155 批之前的固定句（历史会审 prompt 落盘的就是它）。
const OLD_CONTRACT_TEXT = "你只负责逐问给出意见。禁止实现方案、派发或召集其他 agent。任务书中的后续阶段是评审对象，不是执行授权。不得代 Lead 作验收、排期或开阶段决定；缺证据时报告缺口。";

// ===== helpers =====

function makeWorld(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const runDir = join(dir, "runs");
  const consultsDir = join(dir, ".wao", "runs", "consults");
  // 决定 0111 保留的旧落点（链接工作树迁移前的会审记录目录）。
  const legacyDir = join(dir, "legacy-consults");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(consultsDir, { recursive: true });
  mkdirSync(legacyDir, { recursive: true });
  const briefFile = join(dir, "brief.md");
  writeFileSync(briefFile, "任务书\n\n## Q1 可行吗\n", "utf8");
  return { dir, runDir, consultsDir, legacyDir, briefFile };
}

function cleanup(world) {
  rmSync(world.dir, { recursive: true, force: true });
}

function writeTranscript(runDir, runId, events) {
  writeFileSync(join(runDir, `${runId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/** 一个交付运行的转录：root===runId 是谱系根，否则是 root 的续修后代（与真实续接同形的谱系事实）。 */
function writeRun(world, runId, rootRunId = runId) {
  const events = [{ type: "run.started", runId, seq: 1 }];
  if (rootRunId !== runId) {
    events.push({ type: "run.background_submitted", runId, rootRunId, continuation: true, parentRunId: rootRunId, seq: 2 });
  }
  events.push({
    type: "run.session_reuse", runId, rootRunId, mode: "run_lineage", turn: rootRunId === runId ? "first" : "resume", seq: 3,
  });
  writeTranscript(world.runDir, runId, events);
}

/** 席位已终态的转录（show/wait 读它）。 */
function writeSeatRun(world, runId, finalText = "Q1: 可行\n") {
  writeTranscript(world.runDir, runId, [
    { type: "run.started", worktreePath: "C:\\fake\\wt", runId, seq: 1 },
    { type: "run.read_only_declared", runId, seq: 2 },
    { type: "run.state_change", to: "completed", reason: "stub", runId, seq: 3 },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: finalText }], runId, seq: 4 },
  ]);
}

function writeRecord(world, record, dir = world.consultsDir) {
  writeFileSync(join(dir, `${record.consultId}.json`), JSON.stringify(record), "utf8");
}

function legacyRecord(consultId, createdAt, reviewedRunId, extra = {}) {
  return {
    consultId,
    createdAt,
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 1,
    questions: [{ q: 1, heading: "Q1 可行吗" }],
    seats: [],
    fieldDiff: [],
    ...(reviewedRunId ? { reviewedRunId } : {}),
    ...extra,
  };
}

let idCounter = 0;
const nextId = () => `consult_20261127${String(++idCounter).padStart(8, "0")}r155`;

const RULES_BLOCK = ["以下为 Owner 原文（车道规则，按声明顺序）：", "1. 夹具规则"];

function makeServiceInput(world, calls) {
  return {
    briefText: "任务书\n\n## Q1 可行吗\n",
    seats: [{ agentId: "seat_a" }, { agentId: "seat_b" }],
    registryPath: join(world.dir, "agents.json"),
    runDir: world.runDir,
    consultsDir: world.consultsDir,
    budgetMs: 0,
    budgetFloorMs: 0,
    env: {},
    registryReadFn: async () => ({ getAgent: () => ({ backend: "codex", cwd: "." }), listAgents: () => [] }),
    lanesDocFn: () => null,
    // 第 156 批：规则块与每席车道事实行注入夹具（不读真实画像；车道事实行恒缺省）。
    laneRulesFn: () => ({ rules: ["夹具规则"], now: null }),
    laneFactsLineFn: () => null,
    idFn: nextId,
    dispatchFn: async (input) => {
      calls.push(input);
      return { accepted: true, runId: `run_seat_${input.agentId}_${calls.length}`, state: "pending" };
    },
  };
}

/** 跑一场会审（假派发、零等待）；返回结果、派发调用、advisory 行。 */
async function consult(world, extra = {}) {
  const calls = [];
  const advisories = [];
  const result = await runConsult({
    ...makeServiceInput(world, calls),
    advisorySink: (line) => advisories.push(line),
    ...extra,
  });
  return { result, calls, advisories };
}

function recordOnDisk(world, consultId) {
  return JSON.parse(readFileSync(join(world.consultsDir, `${consultId}.json`), "utf8"));
}

async function capture(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out: out.join("\n"), err: err.join("\n"), outLines: out, errLines: err };
}

// ===== A. 固定合同 =====

test("R155-A1: 审查口径句在每席 prompt 末尾（有无声明字段都在固定合同里）", async () => {
  const world = makeWorld("wao-r155-a1-");
  try {
    assert.ok(CONSULT_SEAT_CONTRACT_TEXT.endsWith(REVIEW_TONE), "固定合同正文以审查口径句收尾");
    assert.ok(CONSULT_SEAT_CONTRACT_TEXT.startsWith(OLD_CONTRACT_TEXT), "原有禁令句一字不动");
    const bare = await consult(world);
    assert.equal(bare.calls.length, 2);
    for (const c of bare.calls) {
      assert.ok(c.prompt.endsWith(`${CONSULT_SEAT_CONTRACT_MARKER}${OLD_CONTRACT_TEXT}${REVIEW_TONE}`), "无声明：审查口径句在 prompt 末尾");
    }
    const declared = await consult(world, { declaredFields: { Q1: ["PASS", "FIX_FIRST"] } });
    for (const c of declared.calls) {
      assert.ok(c.prompt.includes(`${OLD_CONTRACT_TEXT}${REVIEW_TONE}\n\n【结论字段格式（声明即合同）】`), "有声明：口径句在固定合同里、格式段之前");
    }
  } finally {
    cleanup(world);
  }
});

test("R155-A2: stripConsultSeatContract 同时剥得掉历史 prompt（旧固定句）与当前 prompt", () => {
  const body = "# 任务书\n\n## Q1 结论\n";
  const declared = { Q1: ["PASS", "FIX_FIRST"] };
  const declaredSection = "\n\n【结论字段格式（声明即合同）】\n- Q1 单独起一行写成「Q1: <值>」，值只能是 PASS、FIX_FIRST 之一，这一行不写别的";
  for (const [label, fields, section] of [["无声明", undefined, ""], ["有声明", declared, declaredSection]]) {
    const current = buildConsultSeatPrompt(body, fields);
    assert.equal(stripConsultSeatContract(current, fields), body, `${label}：当前 prompt 剥掉后只剩任务书`);
    const history = `${body}${CONSULT_SEAT_CONTRACT_MARKER}${OLD_CONTRACT_TEXT}${section}`;
    assert.equal(stripConsultSeatContract(history, fields), body, `${label}：历史 prompt（旧固定句）剥掉后只剩任务书`);
  }
  // 不对的后缀照旧原样保留（不截断）。
  const mismatched = `${body}${CONSULT_SEAT_CONTRACT_MARKER}别的合同句`;
  assert.equal(stripConsultSeatContract(mismatched, undefined), mismatched);
});

// auditor.md 是最长的角色文件，受 codex .cmd 命令行预算限制（roleContract.test.js 第 149 批紧样本），
// 所以只带压缩版；researcher.md 带完整版。会审席位按 agentId 派发时收到的是固定合同里的完整版（A1）。
test("R155-A3: auditor 与 researcher 角色文件各带同义的审查口径句（auditor 压缩版）", () => {
  const read = (name) => readFileSync(join(import.meta.dirname, "../../config/roles", name), "utf8");
  // 第 155 批修正二：压缩版并进"上下文与风险相称"一条（auditor.md 总字节不超过改动前的 2894）。
  const auditor = read("auditor.md");
  assert.ok(auditor.includes("以全局为重") && auditor.includes("边缘或极小概率的问题可提，但须在条首标【边缘】。"), "auditor.md 带压缩版");
  assert.ok(read("researcher.md").includes(REVIEW_TONE), "researcher.md 带完整版");
});

// ===== B. 轮次 =====

test("R155-B1: 交付会审——同一谱系第 1、2、3 轮；跨谱系不串", async () => {
  const world = makeWorld("wao-r155-b1-");
  try {
    writeRun(world, "run_root_a");
    writeRun(world, "run_cont_a1", "run_root_a");
    writeRun(world, "run_cont_a2", "run_root_a");
    writeRun(world, "run_other_x");
    const r1 = await consult(world, { reviewedRunId: "run_root_a" });
    const r2 = await consult(world, { reviewedRunId: "run_cont_a1" });
    const r3 = await consult(world, { reviewedRunId: "run_cont_a2" });
    assert.equal(recordOnDisk(world, r1.result.consultId).round, 1);
    assert.equal(recordOnDisk(world, r2.result.consultId).round, 2);
    assert.equal(recordOnDisk(world, r3.result.consultId).round, 3);
    assert.equal(r1.result.record.round, 1);
    // 同一条谱系再审根本身：第 4 轮。
    const r4 = await consult(world, { reviewedRunId: "run_root_a" });
    assert.equal(r4.result.round, 4);
    // 另一条谱系：自己从第 1 轮数起，不被 A 谱系的会审串号；再审同一运行才累加。
    const x1 = await consult(world, { reviewedRunId: "run_other_x" });
    assert.equal(recordOnDisk(world, x1.result.consultId).round, 1);
    // 第 156 批：advisory 通道恒有规则块两行（夹具）；跨谱系第 1 轮无轮次提醒。
    assert.ok(!("round" in x1.result));
    assert.deepEqual(x1.advisories, RULES_BLOCK);
    const x2 = await consult(world, { reviewedRunId: "run_other_x" });
    assert.equal(recordOnDisk(world, x2.result.consultId).round, 2);
    // 被审运行转录读不出：按自己是根，只会少算（不报错、不影响会审）。
    const ghost = await consult(world, { reviewedRunId: "run_missing_transcript" });
    assert.equal(recordOnDisk(world, ghost.result.consultId).round, 1);
    // 第 155 批修正二：核实不到谱系根就不写 lineageRoot，改标"轮次可能偏低"；核实到的不带该标。
    const ghostRecord = recordOnDisk(world, ghost.result.consultId);
    assert.ok(!("lineageRoot" in ghostRecord));
    assert.equal(ghostRecord.roundMayBeLow, true);
    assert.equal(recordOnDisk(world, r1.result.consultId).lineageRoot, "run_root_a");
    assert.ok(!("roundMayBeLow" in recordOnDisk(world, r1.result.consultId)));
  } finally {
    cleanup(world);
  }
});

test("R155-B2: follows 串联 1→2→3；记录里写 follows 与 round", async () => {
  const world = makeWorld("wao-r155-b2-");
  try {
    const p1 = await consult(world);
    const p2 = await consult(world, { follows: p1.result.consultId });
    const p3 = await consult(world, { follows: p2.result.consultId });
    assert.equal(recordOnDisk(world, p1.result.consultId).round, 1);
    assert.ok(!("follows" in recordOnDisk(world, p1.result.consultId)), "没有 follows 就不写");
    assert.equal(recordOnDisk(world, p2.result.consultId).round, 2);
    assert.equal(recordOnDisk(world, p2.result.consultId).follows, p1.result.consultId);
    assert.equal(recordOnDisk(world, p3.result.consultId).round, 3);
    assert.equal(recordOnDisk(world, p3.result.consultId).follows, p2.result.consultId);
    assert.equal(p3.result.round, 3);
    // 接续的是旧记录（没有 round）：先现算它的轮次再 +1。
    writeRecord(world, legacyRecord("consult_20260101000000000legacy1", "2026-01-01T00:00:00.000Z"));
    const fromLegacy = await consult(world, { follows: "consult_20260101000000000legacy1" });
    assert.equal(fromLegacy.result.record.round, 2, "无 round 且无谱系的旧记录按第 1 轮算");
  } finally {
    cleanup(world);
  }
});

test("R155-B3: follows 指向不存在/读不出的会审 → 具名拒绝，零派发、零新记录", async () => {
  const world = makeWorld("wao-r155-b3-");
  try {
    writeFileSync(join(world.consultsDir, "consult_20260101000000000broken1.json"), "{ not json", "utf8");
    const before = readdirSync(world.consultsDir).sort();
    for (const follows of ["consult_20990101000000000nope00", "consult_20260101000000000broken1", "../escape", "not-a-consult-id"]) {
      const calls = [];
      await assert.rejects(
        () => runConsult({ ...makeServiceInput(world, calls), follows }),
        (error) => {
          assert.ok(error instanceof ConsultFollowsRefusalError, `${follows} 抛具名拒绝类`);
          assert.ok(error.message.includes(JSON.stringify(follows)), "文案点名这个 id");
          assert.ok(error.message.includes("nothing was dispatched"));
          return true;
        },
      );
      assert.equal(calls.length, 0, `${follows}：零派发`);
    }
    assert.deepEqual(readdirSync(world.consultsDir).sort(), before, "没有写出任何新记录");
  } finally {
    cleanup(world);
  }
});

test("R155-B4: reviewedRunId 与 follows 同时给——取两种算法的较大值", async () => {
  const world = makeWorld("wao-r155-b4-");
  try {
    writeRun(world, "run_root_m");
    writeRun(world, "run_cont_m1", "run_root_m");
    // 谱系算法大：谱系上已有 2 场（本次第 3 轮），follows 的那场是第 1 轮（+1=2）→ 3。
    const l1 = await consult(world, { reviewedRunId: "run_root_m" });
    await consult(world, { reviewedRunId: "run_cont_m1" });
    const plain = await consult(world);
    assert.equal(l1.result.record.round, 1);
    assert.equal(plain.result.record.round, 1);
    const lineageWins = await consult(world, { reviewedRunId: "run_cont_m1", follows: plain.result.consultId });
    assert.equal(lineageWins.result.round, 3, "谱系已有 2 场 → 第 3 轮；follows 只给 2");
    // follows 算法大：新谱系上没有会审（本次第 1 轮），follows 的那场是第 3 轮（+1=4）→ 4。
    writeRun(world, "run_fresh_m");
    const followsWins = await consult(world, { reviewedRunId: "run_fresh_m", follows: lineageWins.result.consultId });
    assert.equal(followsWins.result.record.round, 4);
    assert.equal(followsWins.result.round, 4);
  } finally {
    cleanup(world);
  }
});

test("R155-B5: 旧记录（没有 round/follows）按谱系事实现算，不回写旧记录", async () => {
  const world = makeWorld("wao-r155-b5-");
  try {
    writeRun(world, "run_root_l");
    writeRun(world, "run_cont_l1", "run_root_l");
    writeRun(world, "run_cont_l2", "run_root_l");
    writeRun(world, "run_other_l");
    const ids = ["consult_20261001000000000lega1", "consult_20261002000000000lega2", "consult_20261003000000000lega3"];
    writeRecord(world, legacyRecord(ids[0], "2026-10-01T00:00:00.000Z", "run_root_l"));
    writeRecord(world, legacyRecord("consult_20260930000000000other1", "2026-09-30T00:00:00.000Z", "run_other_l"));
    writeRecord(world, legacyRecord(ids[1], "2026-10-02T00:00:00.000Z", "run_cont_l1"));
    writeRecord(world, legacyRecord(ids[2], "2026-10-03T00:00:00.000Z", "run_cont_l2"));
    const filesBefore = ids.map((id) => readFileSync(join(world.consultsDir, `${id}.json`), "utf8"));
    const rerender = (id) => rerenderConsultFromRecord({
      record: recordOnDisk(world, id), runDir: world.runDir, consultsDir: world.consultsDir, env: {},
    });
    const [a, b, c] = [await rerender(ids[0]), await rerender(ids[1]), await rerender(ids[2])];
    assert.ok(!("round" in a) && !("roundAdvisory" in a), "第 1 轮不带");
    assert.ok(!("round" in b) && !("roundAdvisory" in b), "第 2 轮不带");
    assert.equal(c.round, 3, "第 3 轮（只数当时已有的同谱系会审，别的谱系不算）");
    assert.equal(c.roundAdvisory, ADVISORY);
    assert.deepEqual(ids.map((id) => readFileSync(join(world.consultsDir, `${id}.json`), "utf8")), filesBefore, "旧记录文件一字未动");
    assert.ok(!("round" in c.record), "返回的记录对象也没被补字段");
    // 新建一场同谱系会审：数上这 3 场旧记录 → 第 4 轮。
    const created = await consult(world, { reviewedRunId: "run_cont_l2" });
    assert.equal(created.result.round, 4);
  } finally {
    cleanup(world);
  }
});

test("R155-B6: 记录里写了合法 round 就用它；不合法的 round 当旧记录现算", async () => {
  const world = makeWorld("wao-r155-b6-");
  try {
    const rerender = (record) => rerenderConsultFromRecord({ record, runDir: world.runDir, consultsDir: world.consultsDir, env: {} });
    const five = await rerender(legacyRecord("consult_20261101000000000r5000", "2026-11-01T00:00:00.000Z", null, { round: 5 }));
    assert.equal(five.round, 5);
    assert.equal(five.roundAdvisory, ADVISORY);
    const two = await rerender(legacyRecord("consult_20261101000000000r2000", "2026-11-01T00:00:00.000Z", null, { round: 2 }));
    assert.ok(!("round" in two) && !("roundAdvisory" in two));
    const bogus = await rerender(legacyRecord("consult_20261101000000000rbad0", "2026-11-01T00:00:00.000Z", null, { round: "3" }));
    assert.ok(!("round" in bogus), "字符串 round 不当真，按旧记录现算（无谱系 = 第 1 轮）");
  } finally {
    cleanup(world);
  }
});

// ===== C. 提醒（CLI）=====

function cliDeps(world, calls) {
  return {
    runConsult: (input) => runConsult({
      ...input,
      ...makeServiceInput(world, calls),
      // CLI 传来的字段里保留：brief 路径、席位、reviewedRunId/follows、advisory 通道。
      briefText: undefined,
      briefPath: input.briefPath,
      seats: input.seats,
      reviewedRunId: input.reviewedRunId,
      follows: input.follows,
      fallbackConsultsDir: input.fallbackConsultsDir,
      advisorySink: input.advisorySink,
    }),
  };
}

function runArgs(world, extra = []) {
  return ["run", world.briefFile, "--seats", "seat_a,seat_b", "--cwd", world.dir, "--run-dir", world.runDir, ...extra];
}

test("R155-C1: consult run——第 3 轮起 stderr 开头一行 + 结果里一行原文；第 1、2 轮什么都不加", async () => {
  const world = makeWorld("wao-r155-c1-");
  try {
    writeRun(world, "run_root_c");
    writeRun(world, "run_cont_c1", "run_root_c");
    writeRun(world, "run_cont_c2", "run_root_c");
    const calls = [];
    const run = (reviewed, extra = []) => capture(() => consultCommand(runArgs(world, ["--reviewed-run", reviewed, ...extra]), {}, cliDeps(world, calls)));
    const first = await run("run_root_c");
    const second = await run("run_cont_c1");
    for (const [label, got] of [["第 1 轮", first], ["第 2 轮", second]]) {
      assert.ok(!got.err.includes("本次会审已超过2轮"), `${label}：stderr 没有提醒`);
      assert.ok(!got.out.includes("本次会审已超过2轮"), `${label}：stdout 没有提醒`);
    }
    const third = await run("run_cont_c2");
    assert.equal(third.errLines[0], ADVISORY, "第 3 轮：开始时（扇出前）stderr 第一行就是原文");
    assert.equal(third.errLines.filter((l) => l === ADVISORY).length, 1, "stderr 恰一行");
    assert.ok(third.errLines.some((l) => l.startsWith("[consult] consult_") && l.includes("started")), "之后才是扇出提示");
    assert.equal(third.out.split("\n").filter((l) => l === ADVISORY).length, 1, "结果里恰一行原文");
    // 第 156 批：文本面首行是 label 行——提醒在 label 与渲染头部两行之后（第 4 行）。
    assert.equal(third.out.split("\n")[3], ADVISORY, "紧跟 label 行与头部两行");
  } finally {
    cleanup(world);
  }
});

test("R155-C1b: consult run --format json——第 2 轮没有 round/roundAdvisory 键，第 3 轮有", async () => {
  const world = makeWorld("wao-r155-c1b-");
  try {
    writeRun(world, "run_root_j");
    writeRun(world, "run_cont_j1", "run_root_j");
    writeRun(world, "run_cont_j2", "run_root_j");
    const calls = [];
    const run = (reviewed) => capture(() => consultCommand(runArgs(world, ["--reviewed-run", reviewed, "--format", "json"]), {}, cliDeps(world, calls)));
    await run("run_root_j");
    const second = JSON.parse((await run("run_cont_j1")).out);
    assert.ok(!("round" in second) && !("roundAdvisory" in second));
    assert.equal(second.record.round, 2, "记录本身写 round（持久事实）");
    const third = JSON.parse((await run("run_cont_j2")).out);
    assert.equal(third.round, 3);
    assert.equal(third.roundAdvisory, ADVISORY);
  } finally {
    cleanup(world);
  }
});

test("R155-C2: 渲染——第 3 轮只多一行原文（头部两行之后），其余逐字节相同", () => {
  const base = {
    consultId: "consult_20261127000000000render",
    recordPath: "p",
    questions: [{ q: 1, heading: "Q1 可行吗" }],
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 10,
    seats: [{
      agentId: "seat_a", runId: "run_a", runState: "completed", formatState: "structured", backend: "codex", provider: null,
      attribution: { ordered: [{ q: 1, text: "Q1: A\n" }], unclassified: "", preamble: "" },
    }],
    fieldDiff: [],
    fieldValues: {},
    bricks: {},
  };
  const plain = renderCouncilDiffText(base).split("\n");
  const warned = renderCouncilDiffText({ ...base, round: 3, roundAdvisory: ADVISORY }).split("\n");
  assert.deepEqual(warned, [...plain.slice(0, 2), ADVISORY, ...plain.slice(2)]);
});

test("R155-C3: consult show / wait——第 3 轮记录各打一行原文，第 2 轮不打；--seat 原文输出不混入", async () => {
  const world = makeWorld("wao-r155-c3-");
  try {
    writeSeatRun(world, "run_seat_done_a", "Q1: 可行\n");
    const seats = [{ agentId: "seat_a", runId: "run_seat_done_a", runState: "completed", formatState: "structured", backend: null, provider: null }];
    writeRecord(world, legacyRecord("consult_20261127000000000round3", "2026-11-27T00:00:00.000Z", null, { round: 3, seats }));
    writeRecord(world, legacyRecord("consult_20261127000000000round2", "2026-11-27T00:00:00.000Z", null, { round: 2, seats }));
    const where = ["--cwd", world.dir, "--run-dir", world.runDir];
    const show3 = await capture(() => consultCommand(["show", "consult_20261127000000000round3", ...where], {}));
    assert.equal(show3.outLines.join("\n").split("\n").filter((l) => l === ADVISORY).length, 1);
    const show2 = await capture(() => consultCommand(["show", "consult_20261127000000000round2", ...where], {}));
    assert.ok(!show2.out.includes("本次会审已超过2轮"));
    const wait3 = await capture(() => consultCommand(["wait", "consult_20261127000000000round3", "--wait-ms", "180000", ...where], {}));
    assert.equal(wait3.out.split("\n").filter((l) => l === ADVISORY).length, 1);
    const wait2 = await capture(() => consultCommand(["wait", "consult_20261127000000000round2", "--wait-ms", "180000", ...where], {}));
    assert.ok(!wait2.out.includes("本次会审已超过2轮"));
    const showJson = JSON.parse((await capture(() => consultCommand(["show", "consult_20261127000000000round3", "--format", "json", ...where], {}))).out);
    assert.equal(showJson.round, 3);
    assert.equal(showJson.roundAdvisory, ADVISORY);
    // 取一席原文：stdout 就是那一席的终稿，不混入提醒。
    const seatOnly = await capture(() => consultCommand(["show", "consult_20261127000000000round3", "--seat", "seat_a", ...where], {}));
    assert.equal(seatOnly.out, "Q1: 可行\n");
  } finally {
    cleanup(world);
  }
});

test("R155-C4: 提醒不改退出码、结论与席位派发（同一输入第 2 轮与第 3 轮对比）", async () => {
  const world = makeWorld("wao-r155-c4-");
  try {
    const fields = { Q1: ["PASS", "FIX_FIRST"] };
    const exitBefore = process.exitCode;
    const second = await consult(world, { declaredFields: fields, follows: (await consult(world)).result.consultId });
    const third = await consult(world, { declaredFields: fields, follows: second.result.consultId });
    assert.deepEqual(second.advisories, RULES_BLOCK, "第 2 轮：只有规则块（156 批）");
    assert.deepEqual(third.advisories, [ADVISORY, ...RULES_BLOCK], "第 3 轮：轮次提醒在前、规则块在后");
    assert.equal(process.exitCode, exitBefore, "退出码不变");
    assert.equal(third.calls.length, second.calls.length, "席位派发数相同");
    assert.deepEqual(third.calls.map((c) => c.agentId), second.calls.map((c) => c.agentId));
    assert.deepEqual(third.calls.map((c) => c.prompt), second.calls.map((c) => c.prompt), "席位 prompt 不受轮次影响");
    const strip = (r) => ({ seats: r.seats.map((s) => [s.agentId, s.runState, s.formatState]), fieldDiff: r.fieldDiff, fieldValues: r.fieldValues });
    assert.deepEqual(strip(third.result), strip(second.result), "结论/席位状态不变");
    const extra = Object.keys(third.result).filter((k) => !(k in second.result));
    assert.deepEqual(extra.sort(), ["round", "roundAdvisory"]);
  } finally {
    cleanup(world);
  }
});

test("R155-C5: CLI 的 --follows——缺值或指向读不出的会审都具名拒绝，零派发；用法页写了 --follows", async () => {
  const world = makeWorld("wao-r155-c5-");
  try {
    const calls = [];
    await assert.rejects(
      () => consultCommand(runArgs(world, ["--follows"]), {}, cliDeps(world, calls)),
      /--follows expects <consultId>/,
    );
    await assert.rejects(
      () => consultCommand(runArgs(world, ["--follows", "consult_20990101000000000nope00"]), {}, cliDeps(world, calls)),
      (error) => error instanceof ConsultFollowsRefusalError && error.message.includes("consult_20990101000000000nope00"),
    );
    assert.equal(calls.length, 0);
    assert.ok(CONSULT_USAGE.includes("[--follows <consultId>]"));
    // 正常串联：--follows 接上一场 → 记录写 follows、轮次 +1。
    const first = await capture(() => consultCommand(runArgs(world, ["--format", "json"]), {}, cliDeps(world, calls)));
    const firstId = JSON.parse(first.out).consultId;
    const next = await capture(() => consultCommand(runArgs(world, ["--follows", firstId, "--format", "json"]), {}, cliDeps(world, calls)));
    const nextRecord = JSON.parse(next.out).record;
    assert.equal(nextRecord.round, 2);
    assert.equal(nextRecord.follows, firstId);
  } finally {
    cleanup(world);
  }
});

test("R155-C6: 源码里的提醒常量与 Owner 原文一致", () => {
  assert.equal(CONSULT_ROUND_ADVISORY, ADVISORY);
});

// ===== D. 第 155 批修正二（会审第一轮的必改项）=====

// D1：旧落点（决定 0111）里的同谱系记录也数，与状态目录合并、按 consultId 去重。
test("R155-D1: 旧目录里的同谱系会审记录也算进轮次（两个目录合并、按 consultId 去重）", async () => {
  const world = makeWorld("wao-r155-d1-");
  try {
    writeRun(world, "run_root_f");
    writeRun(world, "run_cont_f1", "run_root_f");
    writeRun(world, "run_cont_f2", "run_root_f");
    writeRecord(world, legacyRecord("consult_20261001000000000olda1", "2026-10-01T00:00:00.000Z", "run_root_f", { round: 1 }), world.legacyDir);
    writeRecord(world, legacyRecord("consult_20261002000000000olda2", "2026-10-02T00:00:00.000Z", "run_cont_f1", { round: 2 }), world.legacyDir);
    // 不给旧目录：只数状态目录，两份旧记录看不见（第 1 轮）。
    const blind = await consult(world, { reviewedRunId: "run_cont_f2" });
    assert.equal(blind.result.record.round, 1);
    // 给旧目录：两份旧记录合并进来，第 3 轮并提醒。
    const merged = await consult(world, { reviewedRunId: "run_cont_f2", fallbackConsultsDir: world.legacyDir });
    // （上一条 blind 自己也是同谱系的一场，已落在状态目录：两份旧记录 + blind = 3，本次第 4 轮。）
    assert.equal(merged.result.round, 4);
    assert.deepEqual(merged.advisories, [ADVISORY, ...RULES_BLOCK]);
    // 同一份记录两个目录里都有：只数一次。
    writeRecord(world, legacyRecord("consult_20261001000000000olda1", "2026-10-01T00:00:00.000Z", "run_root_f", { round: 1 }));
    const deduped = await consult(world, { reviewedRunId: "run_root_f", fallbackConsultsDir: world.legacyDir });
    assert.equal(deduped.result.round, 5, "olda1 在两个目录里只数一次：olda1、olda2、blind、merged + 本次 = 5");
  } finally {
    cleanup(world);
  }
});

test("R155-D1b: 旧记录（没有 round）现算轮次时也合并两个目录（rerender 的 lineageDirs）", async () => {
  const world = makeWorld("wao-r155-d1b-");
  try {
    writeRun(world, "run_root_g");
    writeRun(world, "run_cont_g1", "run_root_g");
    writeRun(world, "run_cont_g2", "run_root_g");
    writeRecord(world, legacyRecord("consult_20261001000000000oldg1", "2026-10-01T00:00:00.000Z", "run_root_g"), world.legacyDir);
    writeRecord(world, legacyRecord("consult_20261002000000000oldg2", "2026-10-02T00:00:00.000Z", "run_cont_g1"), world.legacyDir);
    const third = legacyRecord("consult_20261003000000000oldg3", "2026-10-03T00:00:00.000Z", "run_cont_g2");
    writeRecord(world, third);
    const rerender = (extra) => rerenderConsultFromRecord({
      record: third, runDir: world.runDir, consultsDir: world.consultsDir, env: {}, ...extra,
    });
    assert.ok(!("round" in await rerender({})), "只看状态目录：前两场看不见，第 1 轮");
    const merged = await rerender({ lineageDirs: [world.consultsDir, world.legacyDir] });
    assert.equal(merged.round, 3);
    assert.equal(merged.roundAdvisory, ADVISORY);
  } finally {
    cleanup(world);
  }
});

// D2：轮次查询在席位等待计时开始之前，查询再慢也不吃席位的等待预算。
test("R155-D2: 轮次查询慢（超过等待预算）不改变席位结果", async () => {
  const world = makeWorld("wao-r155-d2-");
  try {
    writeRun(world, "run_root_h");
    const runWithQueryCost = async (queryCostMs) => {
      let now = 0;
      let settled = false; // 席位在第一次等待之后才到终态——预算被查询吃掉的话就读不到
      const seatEvents = (runId) => [
        { type: "run.started", worktreePath: "C:\\fake\\wt", runId, seq: 1 },
        { type: "run.read_only_declared", runId, seq: 2 },
        { type: "run.state_change", to: settled ? "completed" : "running", reason: "stub", runId, seq: 3 },
        ...(settled ? [{ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "Q1: 可行\n" }], runId, seq: 4 }] : []),
      ];
      const readTranscriptFn = async (path) => (/run_seat_/.test(path)
        ? seatEvents(/(run_seat_[A-Za-z0-9_]+)\.jsonl$/.exec(path)[1])
        : readTranscript(path));
      const { readdir } = await import("node:fs/promises");
      const { result } = await consult(world, {
        reviewedRunId: "run_root_h",
        budgetMs: 100,
        pollIntervalMs: 1000,
        nowFn: () => now,
        sleepFn: async (ms) => { now += ms; settled = true; },
        readdirFn: async (dir) => { now += queryCostMs; return readdir(dir); },
        readTranscriptFn,
      });
      return result.seats.map((s) => [s.agentId, s.runState, s.budgetExpired]);
    };
    const fast = await runWithQueryCost(0);
    const slow = await runWithQueryCost(101);
    assert.deepEqual(fast.map((s) => s.slice(1)), [["completed", false], ["completed", false]], "基线：查询瞬时，席位在预算内到终态");
    assert.deepEqual(slow, fast, "查询耗时 101ms（超过 100ms 预算）席位结果与快查询相同");
  } finally {
    cleanup(world);
  }
});

// D3：新记录写谱系根，计数只读记录；旧记录（没有这个字段）照旧回读转录。
test("R155-D3: 新记录写 lineageRoot——被审转录之后被删，同谱系计数仍正确", async () => {
  const world = makeWorld("wao-r155-d3-");
  try {
    writeRun(world, "run_root_i");
    writeRun(world, "run_cont_i1", "run_root_i");
    writeRun(world, "run_cont_i2", "run_root_i");
    const c1 = await consult(world, { reviewedRunId: "run_root_i" });
    const c2 = await consult(world, { reviewedRunId: "run_cont_i1" });
    assert.equal(recordOnDisk(world, c1.result.consultId).lineageRoot, "run_root_i");
    assert.equal(recordOnDisk(world, c2.result.consultId).lineageRoot, "run_root_i", "续修后代的记录写的是谱系根，不是自己");
    // 前两场被审运行的转录没了（清理/归档）：计数只靠记录里的根。
    rmSync(join(world.runDir, "run_root_i.jsonl"));
    rmSync(join(world.runDir, "run_cont_i1.jsonl"));
    const c3 = await consult(world, { reviewedRunId: "run_cont_i2" });
    assert.equal(c3.result.round, 3);
    assert.deepEqual(c3.advisories, [ADVISORY, ...RULES_BLOCK]);
    assert.ok(!("roundMayBeLow" in c3.result.record));
  } finally {
    cleanup(world);
  }
});

test("R155-D3b: 没有 lineageRoot 的旧记录照旧回读转录现算；与新记录混在一起也对", async () => {
  const world = makeWorld("wao-r155-d3b-");
  try {
    writeRun(world, "run_root_j");
    writeRun(world, "run_cont_j1", "run_root_j");
    writeRun(world, "run_cont_j2", "run_root_j");
    // 旧记录：只有被审运行，没有 round/lineageRoot——续修后代那场必须读它的转录才知道同谱系。
    writeRecord(world, legacyRecord("consult_20261001000000000oldj1", "2026-10-01T00:00:00.000Z", "run_cont_j1"));
    const fresh = await consult(world, { reviewedRunId: "run_root_j" });
    assert.equal(fresh.result.record.round, 2, "旧记录（续修后代）靠回读转录并入同一谱系");
    assert.equal(recordOnDisk(world, fresh.result.consultId).lineageRoot, "run_root_j");
    // 旧记录文件一字未动（不回写）。
    assert.ok(!("lineageRoot" in recordOnDisk(world, "consult_20261001000000000oldj1")));
    const third = await consult(world, { reviewedRunId: "run_cont_j2" });
    assert.equal(third.result.round, 3);
  } finally {
    cleanup(world);
  }
});

test("R155-D3c: 1000 份新记录（带谱系根）——计数不读任何别的转录", async () => {
  const world = makeWorld("wao-r155-d3c-");
  try {
    writeRun(world, "run_root_k");
    writeRun(world, "run_cont_k", "run_root_k");
    const N = 1000;
    for (let i = 0; i < N; i += 1) {
      const inLineage = i % 5 !== 0; // 800 份同谱系，200 份别的谱系
      writeRecord(world, legacyRecord(
        `consult_20260901${String(i).padStart(9, "0")}k`, "2026-09-01T00:00:00.000Z", `run_reviewed_${i}`,
        { round: 1, lineageRoot: inLineage ? "run_root_k" : `run_root_other_${i}` },
      ));
    }
    const reads = [];
    const readTranscriptFn = async (path) => { reads.push(path); return readTranscript(path); };
    const resolved = await resolveNewConsultRound(
      { reviewedRunId: "run_cont_k", loadFollowed: async () => { throw new Error("unused"); } },
      { consultsDir: world.consultsDir, runDir: world.runDir, readTranscriptFn },
    );
    assert.equal(resolved.round, 801, "800 份同谱系记录 + 本次");
    assert.equal(resolved.lineageRoot, "run_root_k");
    assert.equal(resolved.roundMayBeLow, false);
    assert.equal(reads.length, 1, "只读被审运行自己的转录（核实它的根）一次");
    assert.ok(reads[0].endsWith("run_cont_k.jsonl"));
  } finally {
    cleanup(world);
  }
});

test("R155-D3d: 被审转录读不出——不写 lineageRoot，写 roundMayBeLow:true；没有被审运行的会审两者都不带", async () => {
  const world = makeWorld("wao-r155-d3d-");
  try {
    const unreadable = await consult(world, { reviewedRunId: "run_nowhere" });
    const record = recordOnDisk(world, unreadable.result.consultId);
    assert.ok(!("lineageRoot" in record));
    assert.equal(record.roundMayBeLow, true);
    const plan = await consult(world);
    const planRecord = recordOnDisk(world, plan.result.consultId);
    assert.ok(!("lineageRoot" in planRecord) && !("roundMayBeLow" in planRecord));
    // 根声明自相矛盾（转录里两个不同的 rootRunId）也算未核实。
    writeTranscript(world.runDir, "run_conflict", [
      { type: "run.started", runId: "run_conflict", seq: 1 },
      { type: "run.session_reuse", runId: "run_conflict", rootRunId: "run_a_root", mode: "run_lineage", turn: "resume", seq: 2 },
      { type: "run.background_submitted", runId: "run_conflict", rootRunId: "run_b_root", continuation: true, parentRunId: "run_b_root", seq: 3 },
    ]);
    const conflict = await consult(world, { reviewedRunId: "run_conflict" });
    assert.equal(recordOnDisk(world, conflict.result.consultId).roundMayBeLow, true);
  } finally {
    cleanup(world);
  }
});
