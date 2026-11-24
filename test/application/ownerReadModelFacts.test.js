// test/application/ownerReadModelFacts.test.js
//
// 第 140b 批（决定 0131）：Owner 读模型补的事实——交付、失败、额度、谱系、分支、会审
// 结论，以及诊断模块为此导出的"依据事件"。
//
// 夹具纪律：运行目录、转录、会审组记录、一次性 Git 仓库全部建在 os.tmpdir() 下，绝不读
// 仓库的 runs/；读模型的落盘面一律显式 runDir 注入。Git 只在分支用例里用，且只在临时
// 仓库里建分支（不提交、不建工作树）。
//
// 覆盖面（每条声称对应一个能证伪它的用例）：
//   - 诊断依据事件：diagnoseFailureWithBasis 与 diagnoseFailure 同一次判定，额度结论的
//     依据事件由判定自己记下（两条来路各一例）；diagnoseFailure 的输出不带它
//   - 交付：未请求交付为 null；打包失败、隔离失败、事实矛盾各给闭集码；验证四态；复验
//     通过覆盖原始失败；采纳 / 拒收带裁决时间；settledAt 取终态与结果事件里较晚者
//   - 失败与额度：只给闭集 category / code，证据文本（含秘密形状）不进快照；额度码的
//     observedAt 是依据事件的时间；非失败运行没有这两项
//   - 谱系：父运行被子运行取代；已裁决的不算取代；成员没变不重读、不第二次枚举；刷新
//     失败、成员读不到、从没读得出过时不推导；声明根矛盾如实标明
//   - 分支：共用的枚举函数只认 wao/run_ + 合法 runId、不截断；真实临时仓库里分支在 /
//     不在；仓库不存在、git 失败如实 unknown；30 秒节流
//   - 会审：Q1 一致、分裂、一席缺结论、一席转录读不到；未声明 Q1 不算；坏记录计入
//     unreadable；记录与席位转录不变时不重读，变了重算
//   - 快照无路径：遍历覆盖全部新增字段（项目 key、工作树、会审记录与任务书路径）；
//     嵌套键集是白名单

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rmrfRetry } from "../_rmrfHelper.mjs";
import {
  OWNER_BRANCH_REFRESH_MS,
  OWNER_CONSULT_Q1_VALUES,
  createOwnerReadModel,
} from "../../src/application/ownerReadModel.js";
import { diagnoseFailure, diagnoseFailureWithBasis } from "../../src/diagnosis.js";
import { execGitReadOnly, listRunBranchRunIds, RUN_BRANCH_GIT_TIMEOUT_MS } from "../../src/application/runBranches.js";
import { listTranscriptsDeep } from "../../src/projectBuckets.js";

// ===== 夹具 =====

const T0 = Date.parse("2026-11-24T10:00:00.000Z");
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (events) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
const BASE = "b".repeat(40);
const DELIVERED = "d".repeat(40);

/** 派发事实里的私有路径（磁盘上不存在）：任何一个出现在快照里都算泄漏。 */
const PRIVATE_ROOT = "D:\\private\\repos\\alpha";
const PRIVATE_PATHS = [PRIVATE_ROOT, "D:\\private\\briefs\\plan.md"];
/** 假令牌带 placeholder 字样（脱敏守卫认可的合法夹具写法；sk- 后 20 位够规则的 16 位下限）。 */
const SECRET = "sk-placeholder0123456789";

const ALPHA = { slug: "alpha-11111111", name: "alpha", key: PRIVATE_ROOT };
const BETA = { slug: "beta-22222222", name: "beta project", key: "D:\\private\\repos\\beta" };
const projectFact = (p) => ({ kind: "project", rulesVersion: "td190-r3", key: p.key, bucket: p.slug });

function makeStore(prefix = "wao-owner-read-model-facts-") {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const runDir = join(base, "runs");
  return {
    base,
    runDir,
    bucket: (slug) => join(runDir, "projects", slug),
    writeProject(p) {
      mkdirSync(join(runDir, "projects", p.slug), { recursive: true });
      writeFileSync(
        join(runDir, "projects", p.slug, ".project.json"),
        JSON.stringify({ key: p.key, slug: p.slug, displayName: p.name, rulesVersion: "td190-r3", createdAt: iso(T0), aliases: [] }),
        "utf8",
      );
    },
    write(dir, runId, events) {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${runId}.jsonl`);
      writeFileSync(file, jsonl(events), "utf8");
      return file;
    },
    cleanup() {
      rmrfRetry(base);
    },
  };
}

/** 事件构造器：信封字段（seq/ts/type/runId/agentId）权威，载荷不能覆盖。 */
function builder(runId, { agentId = "coder_hq", at = T0 } = {}) {
  const events = [];
  let seq = 0;
  let clock = at;
  const b = {
    events,
    runId,
    /** 设置后续事件的绝对时刻（epoch ms）。 */
    clock(ms) {
      clock = ms;
      return b;
    },
    add(type, payload = {}, envelope = {}) {
      seq += 1;
      events.push({ ...payload, seq, ts: iso(clock), type, runId, agentId, ...envelope });
      return b;
    },
  };
  return b;
}

/** 派发头：background_submitted → pending → run.started → prompt.sent。 */
function head(b, {
  at = T0, deliveryRequested = false, project = ALPHA, prompt = "# 标准运行\n正文", continuation = null,
} = {}) {
  b.clock(at).add("run.background_submitted", {
    background: true,
    cwd: PRIVATE_ROOT,
    deliveryRequested,
    ...(project === null ? {} : { project: projectFact(project) }),
    ...(continuation ? { continuation: true, parentRunId: continuation.parentRunId, rootRunId: continuation.rootRunId } : {}),
  });
  b.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
  b.clock(at + 1000).add("run.started", {
    backend: "claude-code",
    cwd: PRIVATE_ROOT,
    // 工作树路径是绝对路径：不得进快照。
    worktreePath: `${PRIVATE_ROOT}\\.wao-worktrees\\${b.runId}`,
    worktreeBranch: `wao/${b.runId}`,
    model: { id: "glm-5.3" },
    providerKey: null,
    laneId: "glm-pro",
    roleId: "coder",
    resolvedFrom: "explicit",
  });
  b.clock(at + 2000).add("prompt.sent", { prompt });
}

/** worker 起跑：session.created → run.submitted → submitted → running。 */
function working(b, { at }) {
  b.clock(at).add("session.created", { backend: "claude-code", backendSessionId: "proc_4242", serveUrl: null });
  b.add("run.submitted", {});
  b.add("run.state_change", { from: "pending", to: "submitted", reason: "spawned" });
  b.clock(at + 10).add("run.state_change", { from: "submitted", to: "running", reason: "first_event" });
}

function effect(b, { at, text = "done work" }) {
  b.clock(at).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text }] });
}

/** 终态转移（run.state_change → 终态）。 */
function transition(b, { at, state }) {
  b.clock(at).add("run.state_change", { from: "running", to: state, reason: state });
}

/** 终态事实 + 终态转移（同一时刻）。failed 时事实是 run.error。 */
function terminal(b, { at, state = "completed", error = "boom", phase = "wait" }) {
  const fact = { completed: "run.completed", failed: "run.error", aborted: "run.aborted" }[state];
  b.clock(at).add(fact, state === "failed" ? { phase, error } : {});
  transition(b, { at, state });
}

/** 一个 completed 的普通运行（项目桶内）。 */
function completedEvents(runId, o = {}) {
  const at = o.at ?? T0;
  const b = builder(runId);
  head(b, { at, ...o });
  working(b, { at: at + 3000 });
  effect(b, { at: at + 4000 });
  terminal(b, { at: at + 5000 });
  return b.events;
}

const runOf = (snapshot, runId) => {
  const run = snapshot.runs.find((r) => r.runId === runId);
  assert.ok(run, `快照里应有 ${runId}`);
  return run;
};
const consultOf = (snapshot, consultId) => {
  const consult = snapshot.consults.find((c) => c.consultId === consultId);
  assert.ok(consult, `快照里应有 ${consultId}`);
  return consult;
};
const projectOf = (snapshot, slug) => snapshot.projects.find((p) => p.slug === slug);

/** 计数的读模型 IO：每个缝逐调用记账，其余走真实实现。 */
function countingIo(extra = {}) {
  const reads = [];
  const lists = [];
  const dirs = [];
  const gits = [];
  const io = {
    readFile: async (p) => {
      reads.push(p);
      return readFile(p);
    },
    listFiles: (dir, options) => {
      lists.push(dir);
      return listTranscriptsDeep(dir, options);
    },
    listDir: async (dir) => {
      dirs.push(dir);
      return readdir(dir);
    },
    ...extra,
  };
  if (extra.execGit === undefined) {
    io.execGit = (args, cwd) => {
      gits.push({ args, cwd });
      return execGitReadOnly(args, cwd);
    };
  }
  return { io, reads, lists, dirs, gits };
}

// ===== 交付引用（形状取自 test/run-lifecycle/runSettlement.test.js 的 makeRef 家族） =====

function ref(runId, over = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: BASE,
    deliveryCommit: DELIVERED,
    branch: `wao/${runId}`,
    worktreePath: `${PRIVATE_ROOT}\\.wao-worktrees\\${runId}`,
    changedFiles: ["src/a.js"],
    verification: { status: "pending", commands: [], verifiedCommit: DELIVERED, results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...over,
  };
}

function verifiedRef(runId, status, over = {}) {
  const verification = status === "failed"
    ? { status, failureCode: "command_failed", commands: [], verifiedCommit: DELIVERED, results: [] }
    : status === "unavailable"
      ? { status, unavailableReason: "env gone", commands: [], verifiedCommit: DELIVERED, results: [] }
      : { status, commands: [], verifiedCommit: DELIVERED, results: [] };
  return ref(runId, { verification, ...over });
}

const created = (b, at, runId, over = {}) => b.clock(at).add("run.delivery_created", { delivery: ref(runId, over) });
const outcome = (b, at, runId, status, over = {}) => {
  b.clock(at).add(`run.delivery_verification_${status}`, { delivery: verifiedRef(runId, status, over) });
};

function decide(b, at, runId, kind, status) {
  b.clock(at).add(`run.delivery_${kind}`, {
    delivery: verifiedRef(runId, status, { acceptance: { status: kind, reviewerType: "lead_agent" } }),
    deliveryCommit: DELIVERED,
    reason: "lead decision",
  });
}

function reverify(b, requestedAt, outcomeAt, runId, outcomeStatus = "passed", reason = "tooling_invalid") {
  b.clock(requestedAt).add("run.delivery_reverification_requested", {
    delivery: ref(runId), deliveryCommit: DELIVERED, reason,
  });
  b.clock(outcomeAt).add(`run.delivery_reverification_${outcomeStatus}`, {
    delivery: {
      ...ref(runId),
      verification: { status: outcomeStatus, commands: [], verifiedCommit: DELIVERED, results: [] },
    },
    deliveryCommit: DELIVERED,
  });
}

/** 已请求交付的运行：派发头 → 起跑 → 终态；交付事件由调用方追加。 */
function deliveryRun(runId, { at = T0, state = "completed", error = "boom", terminalAt = at + 5000 } = {}) {
  const b = builder(runId);
  head(b, { at, deliveryRequested: true });
  working(b, { at: at + 3000 });
  terminal(b, { at: terminalAt, state, error });
  return b;
}

// ===== 1. 诊断依据事件 =====

const ZCODE_429 = "zcode turn failed (upstream main-turn request failed and will not be retried)"
  + "; upstream: last main-turn request model_request_failed (statusCode 429, attempt 1/11)";

/**
 * 以 failed 终态收口的运行：errors 依次是终态之前的 run.error（最后一条紧挨着 failed 转移
 * ——生产里终局错误就是这样落的）。
 */
function failedRun(runId, errors, { at = T0, terminalAt = at + 5000 } = {}) {
  const b = builder(runId);
  head(b, { at });
  working(b, { at: at + 3000 });
  for (const { at: errorAt, phase = "wait", error } of errors) {
    b.clock(errorAt).add("run.error", { phase, error });
  }
  transition(b, { at: terminalAt, state: "failed" });
  return b;
}

test("diagnoseFailureWithBasis：与 diagnoseFailure 同一次判定；依据事件只在额度结论时有，是判定所依据的那条 run.error；diagnoseFailure 的输出不带它", () => {
  const runId = "run_basis";
  // 来路一：终局 provider 错误（终态 failed 转移之前最近的一条 run.error）。
  const b1 = failedRun(runId, [
    { at: T0 + 1000, error: "429 too many requests (transient)" },
    { at: T0 + 4000, error: "HTTP 429 Too Many Requests" },
  ]);
  const terminalError = b1.events.at(-2);
  assert.equal(terminalError.type, "run.error", "夹具前提：终态转移之前是一条 run.error");
  // 来路二：zcode 上游摘要升级，依据是本运行最后一条 run.error。这里让它的 phase 不是 wait：
  // 只认"终局 provider 错误"的读法会取不到依据，取依据必须是判定自己说了算。
  const b2 = failedRun(runId, [{ at: T0 + 4000, phase: "stream", error: ZCODE_429 }]);
  const zcodeError = b2.events.at(-2);
  // 不是额度结论。
  const b3 = failedRun(runId, [{ at: T0 + 4000, error: "401 unauthorized" }]);
  const authError = b3.events.at(-2);

  for (const [events, expectedBasis, category, code] of [
    [b1.events, terminalError, "provider_capacity", "rate_limited"],
    [b2.events, zcodeError, "provider_capacity", "rate_limited"],
    [b3.events, null, "provider_auth", "unauthorized"],
  ]) {
    const plain = diagnoseFailure(events, runId);
    const { basisEvent, ...detailed } = diagnoseFailureWithBasis(events, runId);
    assert.deepEqual(plain, { category, code, evidence: plain.evidence }, "夹具前提：诊断结论如预期");
    assert.equal(plain.category, category);
    assert.equal(plain.code, code);
    assert.deepEqual(detailed, { category: plain.category, code: plain.code }, "同一次判定：类别与码一致，不带 evidence");
    assert.equal("basisEvent" in plain, false, "diagnoseFailure 的输出形状不变");
    assert.equal("evidence" in detailed, false, "依据事件的读法不带证据文本");
    assert.equal(basisEvent, expectedBasis, "依据事件就是判定所依据的那条 run.error（同一个对象）");
  }
  // 非数组输入：与 diagnoseFailure 一样降级为 unknown，不抛。diagnoseFailure 的输出形状
  // 与改动前相同（始终带 code 键）。
  assert.deepEqual(diagnoseFailureWithBasis(null, runId), { category: "unknown", code: null, basisEvent: null });
  assert.deepEqual(diagnoseFailure(null, runId), { category: "unknown", evidence: [], code: null });
});

// ===== 2. 交付事实 =====

test("交付事实：未请求交付为 null；打包失败、隔离失败、事实矛盾各自如实给闭集码", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.write(s.bucket(ALPHA.slug), "run_none", completedEvents("run_none"));

    // 打包失败：恰好一条绑定的 run.delivery_failed。
    const pack = deliveryRun("run_pack", { state: "failed", terminalAt: T0 + 5000 });
    pack.clock(T0 + 6000).add("run.delivery_failed", { deliveryCode: "empty_diff" });
    s.write(s.bucket(ALPHA.slug), "run_pack", pack.events);

    // 隔离失败：终态、请求了交付、一条安全的 workdir_escape 违例。
    const escaped = deliveryRun("run_iso", { state: "failed" });
    escaped.clock(T0 + 6000).add("run.isolation_violation", {
      code: "workdir_escape", reason: "write_intent_lexical_outside", path: `${PRIVATE_ROOT}\\..\\outside.txt`,
    });
    s.write(s.bucket(ALPHA.slug), "run_iso", escaped.events);

    // 事实矛盾：两条 delivery_created——"是哪个提交"没有唯一答案。
    const amb = deliveryRun("run_amb");
    created(amb, T0 + 6000, "run_amb");
    created(amb, T0 + 6500, "run_amb");
    s.write(s.bucket(ALPHA.slug), "run_amb", amb.events);

    // 隔离证据自相矛盾（两条违例）：视图 ambiguous，收口也判不出。
    const ambIso = deliveryRun("run_ambiso", { state: "failed" });
    ambIso.clock(T0 + 6000).add("run.isolation_violation", { code: "workdir_escape" });
    ambIso.clock(T0 + 6100).add("run.isolation_violation", { code: "workdir_escape" });
    s.write(s.bucket(ALPHA.slug), "run_ambiso", ambIso.events);

    // 事实矛盾的另一种：验证结果引用的提交与交付提交对不上。视图认得创建时那个提交，
    // 但"是哪个提交"已经没有唯一答案。
    const ambCommit = deliveryRun("run_ambc");
    created(ambCommit, T0 + 6000, "run_ambc");
    ambCommit.clock(T0 + 7000).add("run.delivery_verification_passed", {
      delivery: verifiedRef("run_ambc", "passed", { deliveryCommit: "e".repeat(40) }),
    });
    s.write(s.bucket(ALPHA.slug), "run_ambc", ambCommit.events);

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });

    assert.equal(runOf(snap, "run_none").delivery, null, "没请求交付就没有交付事实");
    assert.equal(runOf(snap, "run_none").deliveryRequested, false);
    assert.deepEqual(runOf(snap, "run_pack").delivery, {
      settlement: { status: "settled", reason: "packaging_failed" },
      commit: null,
      verification: null,
      acceptance: { status: null, decidedAt: null },
      settledAt: null,
      ambiguous: false,
      packagingFailure: "empty_diff",
      isolationFailure: null,
      branchPresent: null,
    });
    assert.deepEqual(runOf(snap, "run_iso").delivery, {
      settlement: { status: "settled", reason: "isolation_failed" },
      commit: null,
      verification: null,
      acceptance: { status: null, decidedAt: null },
      settledAt: null,
      ambiguous: false,
      packagingFailure: null,
      isolationFailure: { code: "workdir_escape", reason: "write_intent_lexical_outside" },
      branchPresent: null,
    });
    assert.deepEqual(runOf(snap, "run_amb").delivery, {
      settlement: { status: "undeterminable", reason: "delivery_facts_malformed" },
      commit: null,
      verification: null,
      acceptance: { status: null, decidedAt: null },
      settledAt: null,
      ambiguous: true,
      packagingFailure: null,
      isolationFailure: null,
      branchPresent: null,
    });
    const ambIsoRun = runOf(snap, "run_ambiso").delivery;
    assert.equal(ambIsoRun.ambiguous, true, "隔离证据自相矛盾 → 视图 ambiguous");
    assert.equal(ambIsoRun.isolationFailure, null, "ambiguous 时不给隔离失败的码");
    assert.equal(ambIsoRun.settlement.status, "undeterminable");
    const ambCommitRun = runOf(snap, "run_ambc").delivery;
    assert.equal(ambCommitRun.ambiguous, true, "验证结果引用的提交对不上 → 视图 ambiguous");
    assert.equal(ambCommitRun.commit, null, "视图认得创建时的提交，但事实矛盾：不给提交号");
    assert.equal(ambCommitRun.verification, null);
    assert.equal(ambCommitRun.settlement.status, "undeterminable");
    assert.equal(ambCommitRun.settlement.reason, "delivery_facts_malformed");
  } finally {
    s.cleanup();
  }
});

test("交付事实：验证 passed / failed / pending / unavailable；复验通过覆盖原始失败；复验还没结果时有效状态仍是原始结果", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const put = (runId, build) => {
      const b = deliveryRun(runId);
      build(b);
      s.write(s.bucket(ALPHA.slug), runId, b.events);
    };
    put("run_pass", (b) => {
      created(b, T0 + 6000, "run_pass");
      outcome(b, T0 + 7000, "run_pass", "passed");
    });
    put("run_fail", (b) => {
      created(b, T0 + 6000, "run_fail");
      outcome(b, T0 + 7000, "run_fail", "failed");
    });
    put("run_unav", (b) => {
      created(b, T0 + 6000, "run_unav");
      outcome(b, T0 + 7000, "run_unav", "unavailable");
    });
    put("run_pend", (b) => created(b, T0 + 6000, "run_pend"));
    put("run_rever", (b) => {
      created(b, T0 + 6000, "run_rever");
      outcome(b, T0 + 7000, "run_rever", "failed");
      reverify(b, T0 + 8000, T0 + 9000, "run_rever");
    });
    put("run_revpend", (b) => {
      created(b, T0 + 6000, "run_revpend");
      outcome(b, T0 + 7000, "run_revpend", "failed");
      b.clock(T0 + 8000).add("run.delivery_reverification_requested", {
        delivery: ref("run_revpend"), deliveryCommit: DELIVERED, reason: "tooling_invalid",
      });
    });

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    const pick = (runId) => {
      const d = runOf(snap, runId).delivery;
      return { status: d.verification.status, reverify: d.verification.reverify, settlement: d.settlement, commit: d.commit };
    };

    assert.deepEqual(pick("run_pass"), {
      status: "passed",
      reverify: { status: "none", reason: null },
      settlement: { status: "settled", reason: "delivery_settled" },
      commit: DELIVERED,
    });
    assert.equal(pick("run_fail").status, "failed");
    assert.equal(pick("run_unav").status, "unavailable");
    assert.deepEqual(pick("run_pend"), {
      status: "pending",
      reverify: { status: "none", reason: null },
      settlement: { status: "unsettled", reason: "verification_pending" },
      commit: DELIVERED,
    }, "验证还没结果：提交号已知，收口是 unsettled");
    assert.deepEqual(pick("run_rever"), {
      status: "passed",
      reverify: { status: "complete", reason: "tooling_invalid" },
      settlement: { status: "settled", reason: "delivery_settled" },
      commit: DELIVERED,
    }, "复验通过 → 有效验证状态是 passed（覆盖原始的 failed）");
    assert.deepEqual(pick("run_revpend"), {
      status: "failed",
      reverify: { status: "pending", reason: "tooling_invalid" },
      settlement: { status: "unsettled", reason: "reverify_pending" },
      commit: DELIVERED,
    }, "复验还没结果：有效状态仍是原始的 failed");
    assert.deepEqual(runOf(snap, "run_pass").delivery.acceptance, { status: "pending", decidedAt: null });
  } finally {
    s.cleanup();
  }
});

test("交付事实：已采纳 / 已拒收带裁决事件自己的时间；验证未出就拒收、结果后到时裁决不变；裁决不改 settledAt", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const put = (runId, build) => {
      const b = deliveryRun(runId);
      build(b);
      s.write(s.bucket(ALPHA.slug), runId, b.events);
    };
    put("run_acc", (b) => {
      created(b, T0 + 6000, "run_acc");
      outcome(b, T0 + 7000, "run_acc", "passed");
      decide(b, T0 + 8000, "run_acc", "accepted", "passed");
    });
    put("run_rej", (b) => {
      created(b, T0 + 6000, "run_rej");
      outcome(b, T0 + 7000, "run_rej", "passed");
      decide(b, T0 + 8000, "run_rej", "rejected", "passed");
    });
    // 验证未出就拒收（第 87 批的 pending 拒收），随后验证结果后到。
    put("run_prej", (b) => {
      created(b, T0 + 6000, "run_prej");
      b.clock(T0 + 7000).add("run.delivery_rejected", {
        delivery: ref("run_prej", { acceptance: { status: "rejected", reviewerType: "lead_agent" } }),
        deliveryCommit: DELIVERED,
        reason: "settling without an outcome",
      });
      outcome(b, T0 + 8000, "run_prej", "failed");
    });

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    const pick = (runId) => {
      const r = runOf(snap, runId);
      return {
        acceptance: r.delivery.acceptance,
        verification: r.delivery.verification.status,
        settledAt: r.delivery.settledAt,
        settlement: r.delivery.settlement,
        legalDecision: r.legalDecision,
        supersededByRunId: r.supersededByRunId,
      };
    };
    assert.deepEqual(pick("run_acc"), {
      acceptance: { status: "accepted", decidedAt: iso(T0 + 8000) },
      verification: "passed",
      settledAt: iso(T0 + 7000),
      settlement: { status: "settled", reason: "delivery_settled" },
      legalDecision: "accepted",
      supersededByRunId: null,
    }, "裁决时间取裁决事件自己的 ts；settledAt 不因裁决推后");
    assert.deepEqual(pick("run_rej"), {
      acceptance: { status: "rejected", decidedAt: iso(T0 + 8000) },
      verification: "passed",
      settledAt: iso(T0 + 7000),
      settlement: { status: "settled", reason: "delivery_settled" },
      legalDecision: "rejected",
      supersededByRunId: null,
    });
    assert.deepEqual(pick("run_prej"), {
      acceptance: { status: "rejected", decidedAt: iso(T0 + 7000) },
      verification: "failed",
      settledAt: iso(T0 + 8000),
      settlement: { status: "settled", reason: "delivery_settled" },
      legalDecision: "rejected",
      supersededByRunId: null,
    }, "先拒收、结果后到：裁决不被迟到的结果改写；收口时刻取较晚的结果事件");
  } finally {
    s.cleanup();
  }
});

test("交付事实：settledAt 取终态事件与该轮有效验证（或复验）结果事件里较晚的时间；没收口的交付为 null", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const put = (runId, build) => {
      const b = builder(runId);
      head(b, { deliveryRequested: true });
      working(b, { at: T0 + 3000 });
      build(b);
      s.write(s.bucket(ALPHA.slug), runId, b.events);
    };
    // 结果事件晚于终态。
    put("run_d1", (b) => {
      terminal(b, { at: T0 + 5000 });
      created(b, T0 + 6000, "run_d1");
      outcome(b, T0 + 9000, "run_d1", "passed");
    });
    // 终态晚于结果事件。
    put("run_d2", (b) => {
      created(b, T0 + 3000, "run_d2");
      outcome(b, T0 + 3500, "run_d2", "passed");
      terminal(b, { at: T0 + 9000 });
    });
    // 复验结果才是这一轮的有效结果。
    put("run_d3", (b) => {
      terminal(b, { at: T0 + 5000 });
      created(b, T0 + 6000, "run_d3");
      outcome(b, T0 + 7000, "run_d3", "failed");
      reverify(b, T0 + 8000, T0 + 9500, "run_d3");
    });
    // 复验还没结果：没收口。
    put("run_d4", (b) => {
      terminal(b, { at: T0 + 5000 });
      created(b, T0 + 6000, "run_d4");
      outcome(b, T0 + 7000, "run_d4", "failed");
      b.clock(T0 + 8000).add("run.delivery_reverification_requested", {
        delivery: ref("run_d4"), deliveryCommit: DELIVERED, reason: "tooling_invalid",
      });
    });
    // 还没终态。
    put("run_d5", (b) => {
      created(b, T0 + 4000, "run_d5");
      outcome(b, T0 + 4500, "run_d5", "passed");
    });

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    assert.equal(runOf(snap, "run_d1").delivery.settledAt, iso(T0 + 9000), "结果事件晚 → 取结果事件");
    assert.equal(runOf(snap, "run_d2").delivery.settledAt, iso(T0 + 9000), "终态晚 → 取终态事件");
    assert.equal(runOf(snap, "run_d3").delivery.settledAt, iso(T0 + 9500), "复验通过 → 取复验结果事件，不是原始失败事件");
    assert.equal(runOf(snap, "run_d4").delivery.settledAt, null, "复验没结果：没收口，没有收口时刻");
    assert.equal(runOf(snap, "run_d5").delivery.settledAt, null, "还没终态：没有收口时刻");
    assert.equal(runOf(snap, "run_d5").delivery.commit, DELIVERED, "但提交号与验证状态照实给");
    assert.equal(runOf(snap, "run_d5").delivery.verification.status, "passed");
  } finally {
    s.cleanup();
  }
});

// ===== 3. 失败与额度 =====

test("失败与额度：只给闭集 category / code，与 diagnoseFailure 同源；证据文本（含秘密形状与私有路径）不进快照；非失败运行没有这两项", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const dirty = `request rejected for token ${SECRET} from ${PRIVATE_ROOT}\\bin`;
    /** 一个以 failed 收口的运行；withEffect=false 时 worker 什么都没做就崩了。 */
    const failed = (runId, error, { phase = "wait", withEffect = true } = {}) => {
      const b = builder(runId);
      head(b);
      working(b, { at: T0 + 3000 });
      if (withEffect) effect(b, { at: T0 + 4000 });
      terminal(b, { at: T0 + 5000, state: "failed", error, phase });
      s.write(s.bucket(ALPHA.slug), runId, b.events);
      return b.events;
    };
    const samples = {
      run_f_rate: failed("run_f_rate", `HTTP 429 Too Many Requests — ${dirty}`),
      run_f_auth: failed("run_f_auth", `401 unauthorized: ${dirty}`),
      run_f_crash: failed("run_f_crash", `process exited with code 1 — ${dirty}`, { phase: "spawn", withEffect: false }),
      run_f_unknown: failed("run_f_unknown", `something odd happened — ${dirty}`),
    };
    // 非失败：completed / aborted / 还在跑 / 还没派出去。
    s.write(s.bucket(ALPHA.slug), "run_f_done", completedEvents("run_f_done"));
    const aborted = builder("run_f_abort");
    head(aborted);
    working(aborted, { at: T0 + 3000 });
    terminal(aborted, { at: T0 + 5000, state: "aborted" });
    s.write(s.bucket(ALPHA.slug), "run_f_abort", aborted.events);
    const running = builder("run_f_run");
    head(running, { at: NOW - 10_000 });
    working(running, { at: NOW - 9000 });
    s.write(s.bucket(ALPHA.slug), "run_f_run", running.events);
    const pending = builder("run_f_pend");
    head(pending, { at: NOW - 5000 });
    s.write(s.bucket(ALPHA.slug), "run_f_pend", pending.events);

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });

    for (const [runId, events] of Object.entries(samples)) {
      const d = diagnoseFailure(events, runId);
      const run = runOf(snap, runId);
      assert.equal(run.state, "failed", `${runId}：夹具前提`);
      assert.deepEqual(run.failure, { category: d.category, code: d.code }, `${runId}：与 diagnoseFailure 同源`);
      assert.ok(d.evidence.length > 0, `${runId}：夹具前提——诊断确实产出了证据文本`);
      for (const { fact } of d.evidence) {
        assert.ok(!JSON.stringify(snap).includes(JSON.stringify(fact).slice(1, -1)), `${runId}：证据文本不进快照`);
      }
      if (d.category !== "provider_capacity") assert.equal(run.capacity, null, `${runId}：不是额度结论就没有额度证据`);
    }
    assert.deepEqual(runOf(snap, "run_f_rate").failure, { category: "provider_capacity", code: "rate_limited" });
    assert.deepEqual(runOf(snap, "run_f_auth").failure, { category: "provider_auth", code: "unauthorized" });
    assert.deepEqual(runOf(snap, "run_f_crash").failure, { category: "crash", code: null }, "没有码的类别 code 为 null");
    assert.equal(Object.keys(runOf(snap, "run_f_rate").failure).join(), "category,code", "失败事实只有这两键");
    for (const runId of ["run_f_done", "run_f_abort", "run_f_run", "run_f_pend"]) {
      assert.equal(runOf(snap, runId).failure, null, `${runId}：非失败运行没有失败事实`);
      assert.equal(runOf(snap, runId).capacity, null, `${runId}：非失败运行没有额度证据`);
    }
    assert.equal(runOf(snap, "run_f_run").state, "running");
    const text = JSON.stringify(snap);
    assert.ok(!text.includes(SECRET), "带秘密形状的错误文本不进快照");
    assert.ok(!text.includes("private"), "错误文本里的私有路径不进快照");
  } finally {
    s.cleanup();
  }
});

test("额度证据：code 是闭集额度码；observedAt 是判定所依据的那条 run.error 的时间，不是更早的瞬时错误", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    // 先有一条瞬时 429、继续干活、再以 429 终态失败：依据是终态之前的那一条。
    const transient = builder("run_c_tr");
    head(transient);
    working(transient, { at: T0 + 3000 });
    transient.clock(T0 + 4000).add("run.error", { phase: "wait", error: "429 too many requests (transient)" });
    effect(transient, { at: T0 + 4500 });
    terminal(transient, { at: T0 + 5000, state: "failed", error: "HTTP 429 Too Many Requests" });
    s.write(s.bucket(ALPHA.slug), "run_c_tr", transient.events);

    const quota = builder("run_c_q");
    head(quota);
    working(quota, { at: T0 + 3000 });
    terminal(quota, { at: T0 + 7000, state: "failed", error: "quota exceeded for this key" });
    s.write(s.bucket(ALPHA.slug), "run_c_q", quota.events);

    const full = builder("run_c_o");
    head(full);
    working(full, { at: T0 + 3000 });
    terminal(full, { at: T0 + 8000, state: "failed", error: "Selected model is at capacity." });
    s.write(s.bucket(ALPHA.slug), "run_c_o", full.events);

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    assert.deepEqual(runOf(snap, "run_c_tr").capacity, { code: "rate_limited", observedAt: iso(T0 + 5000) });
    assert.deepEqual(runOf(snap, "run_c_q").capacity, { code: "quota_exhausted", observedAt: iso(T0 + 7000) });
    assert.deepEqual(runOf(snap, "run_c_o").capacity, { code: "overloaded", observedAt: iso(T0 + 8000) });
    assert.deepEqual(runOf(snap, "run_c_tr").failure, { category: "provider_capacity", code: "rate_limited" });
  } finally {
    s.cleanup();
  }
});

test("额度证据：zcode 上游摘要升级那一路，observedAt 是带摘要的那条 run.error 的时间", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const b = failedRun("run_c_z", [{ at: T0 + 6000, error: ZCODE_429 }], { terminalAt: T0 + 6050 });
    assert.equal(b.events.at(-2).ts, iso(T0 + 6000), "夹具前提：带摘要的 run.error 在 T0+6000，终态转移在其后");
    s.write(s.bucket(ALPHA.slug), "run_c_z", b.events);
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    assert.deepEqual(runOf(snap, "run_c_z").failure, { category: "provider_capacity", code: "rate_limited" });
    assert.deepEqual(runOf(snap, "run_c_z").capacity, { code: "rate_limited", observedAt: iso(T0 + 6000) });
  } finally {
    s.cleanup();
  }
});

// ===== 4. 谱系 =====

/**
 * 谱系成员：root 省略时是根运行（session_reuse turn:first），否则是续修子运行——首事件
 * 必须是续修事实（runContinue 第 15 步在 spawn 之前写它），随后 session_reuse(turn:resume)。
 * 事件顺序与 test/application/lineageSupersession.test.js 的 rootRun / childRun 同义。
 */
function lineageRun(runId, { root = null, parent = null, decision = null, at = T0 } = {}) {
  const b = builder(runId);
  if (root === null) {
    b.clock(at).add("run.background_submitted", {
      background: true, cwd: PRIVATE_ROOT, deliveryRequested: true, project: projectFact(ALPHA),
    });
    b.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
    b.clock(at + 1000).add("run.started", {
      backend: "claude-code", cwd: PRIVATE_ROOT, worktreePath: `${PRIVATE_ROOT}\\.wao-worktrees\\${runId}`,
      worktreeBranch: `wao/${runId}`, model: { id: "glm-5.3" }, providerKey: null, laneId: "glm-pro", roleId: "coder",
    });
    b.clock(at + 1500).add("run.session_reuse", { mode: "run_lineage", turn: "first", rootRunId: runId });
  } else {
    b.clock(at).add("run.background_submitted", {
      background: true, cwd: PRIVATE_ROOT, deliveryRequested: true, project: projectFact(ALPHA),
      continuation: true, parentRunId: parent, rootRunId: root,
    });
    b.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
    b.clock(at + 1000).add("run.started", {
      backend: "claude-code", cwd: PRIVATE_ROOT, worktreePath: `${PRIVATE_ROOT}\\.wao-worktrees\\${runId}`,
      worktreeBranch: `wao/${runId}`, model: { id: "glm-5.3" }, providerKey: null, laneId: "glm-pro", roleId: "coder",
    });
    b.clock(at + 1500).add("run.session_reuse", { mode: "run_lineage", turn: "resume", rootRunId: root });
  }
  working(b, { at: at + 3000 });
  effect(b, { at: at + 4000 });
  terminal(b, { at: at + 5000 });
  created(b, at + 6000, runId);
  outcome(b, at + 7000, runId, "passed");
  if (decision !== null) decide(b, at + 8000, runId, decision, "passed");
  return b.events;
}

test("谱系：续修链里父运行被子运行取代；已裁决的不再算取代；兄弟不传染；末代被拒收时祖先不推导", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const put = (runId, o) => s.write(s.bucket(ALPHA.slug), runId, lineageRun(runId, o));
    // L1：a1 → b1（采纳）。
    put("run_a1");
    put("run_b1", { root: "run_a1", parent: "run_a1", decision: "accepted" });
    // L2：a2 自己已拒收 → b2（采纳）。
    put("run_a2", { decision: "rejected" });
    put("run_b2", { root: "run_a2", parent: "run_a2", decision: "accepted" });
    // L3：a3 → b3（待裁决）、a3 → c3（采纳）。
    put("run_a3");
    put("run_b3", { root: "run_a3", parent: "run_a3" });
    put("run_c3", { root: "run_a3", parent: "run_a3", decision: "accepted" });
    // L4：a4 → b4（拒收）：拒收不上传。
    put("run_a4");
    put("run_b4", { root: "run_a4", parent: "run_a4", decision: "rejected" });
    // L5：a5 → b5（采纳）→ c5（采纳）：取最近的后代。
    put("run_a5");
    put("run_b5", { root: "run_a5", parent: "run_a5", decision: "accepted" });
    put("run_c5", { root: "run_a5", parent: "run_b5", decision: "accepted" });
    // 普通运行：自成一根。
    s.write(s.bucket(ALPHA.slug), "run_plain", completedEvents("run_plain"));

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    const pick = (runId) => {
      const r = runOf(snap, runId);
      return {
        root: r.lineageRootRunId, conflict: r.lineageRootConflict, undeterminable: r.lineageUndeterminable,
        legal: r.legalDecision, superseded: r.supersededByRunId,
      };
    };
    assert.deepEqual(pick("run_a1"), { root: "run_a1", conflict: false, undeterminable: false, legal: null, superseded: "run_b1" }, "父运行被子运行取代");
    assert.deepEqual(pick("run_b1"), { root: "run_a1", conflict: false, undeterminable: false, legal: "accepted", superseded: null }, "子运行的谱系根是声明的根");
    assert.deepEqual(pick("run_a2"), { root: "run_a2", conflict: false, undeterminable: false, legal: "rejected", superseded: null }, "自身已裁决：按自己的裁决，不再算取代");
    assert.deepEqual(pick("run_a3"), { root: "run_a3", conflict: false, undeterminable: false, legal: null, superseded: "run_c3" });
    assert.deepEqual(pick("run_b3"), { root: "run_a3", conflict: false, undeterminable: false, legal: null, superseded: null }, "兄弟不传染：只采纳了 c3，b3 仍待裁决");
    assert.deepEqual(pick("run_a4"), { root: "run_a4", conflict: false, undeterminable: false, legal: null, superseded: null }, "末代被拒收：祖先不推导");
    assert.deepEqual(pick("run_a5"), { root: "run_a5", conflict: false, undeterminable: false, legal: null, superseded: "run_b5" }, "多个合格后代取最近的");
    assert.deepEqual(pick("run_b5"), { root: "run_a5", conflict: false, undeterminable: false, legal: "accepted", superseded: null });
    assert.deepEqual(pick("run_plain"), { root: "run_plain", conflict: false, undeterminable: false, legal: null, superseded: null }, "普通运行自成一根");
  } finally {
    s.cleanup();
  }
});

test("谱系：成员没变不重读、不第二次枚举；成员变了只重读该谱系的成员", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const a = s.write(s.bucket(ALPHA.slug), "run_l_a", lineageRun("run_l_a"));
    const b = s.write(s.bucket(ALPHA.slug), "run_l_b", lineageRun("run_l_b", { root: "run_l_a", parent: "run_l_a", decision: "accepted" }));
    const other = s.write(s.bucket(ALPHA.slug), "run_l_x", lineageRun("run_l_x"));
    s.write(s.bucket(ALPHA.slug), "run_l_y", lineageRun("run_l_y", { root: "run_l_x", parent: "run_l_x", decision: "accepted" }));
    const plain = s.write(s.bucket(ALPHA.slug), "run_l_p", completedEvents("run_l_p"));

    const { io, reads, lists } = countingIo();
    const model = createOwnerReadModel({ runDir: s.runDir, io });
    await model.refresh();
    assert.equal(lists.length, 1, "冷普查只枚举一次（谱系派生用读模型自己的文件索引）");
    assert.equal(new Set(reads).size, 5, "冷普查读了全部 5 份转录");
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_l_a").supersededByRunId, "run_l_b", "夹具前提：派生出了被取代");

    // 什么都没变：不读任何文件，只枚举一次；派生结果沿用。
    reads.length = 0;
    lists.length = 0;
    await model.refresh();
    assert.equal(lists.length, 1);
    assert.equal(reads.length, 0, "谱系成员没变：不重读");
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_l_a").supersededByRunId, "run_l_b", "派生结果沿用");

    // 谱系 L 的成员 b 变了：只有 a、b 被读（b 一遍普查 + 派生重读，a 只在派生里读）。
    await appendFile(b, `${JSON.stringify({ seq: 99, ts: iso(T0 + 9000), type: "run.cleanup_done", runId: "run_l_b", agentId: "coder_hq" })}\n`, "utf8");
    reads.length = 0;
    lists.length = 0;
    await model.refresh();
    assert.equal(lists.length, 1, "成员变了也没有第二次全量枚举");
    assert.deepEqual([...new Set(reads)].sort(), [a, b].sort(), "只读这条谱系的成员");
    assert.ok(!reads.includes(other) && !reads.includes(plain), "别的谱系与普通运行不读");
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_l_a").supersededByRunId, "run_l_b");
  } finally {
    s.cleanup();
  }
});

test("谱系：刷新失败时不推导——谱系两项按无法判定给，声明根照旧；下一轮成功后恢复", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.write(s.bucket(ALPHA.slug), "run_s_a", lineageRun("run_s_a"));
    s.write(s.bucket(ALPHA.slug), "run_s_b", lineageRun("run_s_b", { root: "run_s_a", parent: "run_s_a", decision: "accepted" }));
    let broken = false;
    const model = createOwnerReadModel({
      runDir: s.runDir,
      io: {
        listFiles: (dir, options) => {
          if (broken) throw Object.assign(new Error("EACCES stub"), { code: "EACCES" });
          return listTranscriptsDeep(dir, options);
        },
      },
    });
    await model.refresh();
    const before = model.snapshot({ now: NOW });
    assert.equal(runOf(before, "run_s_a").supersededByRunId, "run_s_b", "夹具前提");

    broken = true;
    await assert.rejects(() => model.refresh(), /EACCES stub/);
    const during = model.snapshot({ now: NOW });
    assert.equal(runOf(during, "run_s_a").supersededByRunId, null, "刷新失败：不再给出被取代");
    assert.equal(runOf(during, "run_s_a").legalDecision, null);
    assert.equal(runOf(during, "run_s_a").lineageUndeterminable, true, "并标明是无法判定");
    assert.equal(runOf(during, "run_s_a").lineageRootRunId, "run_s_a", "声明根是本转录自己的事实，照给");
    assert.equal(runOf(during, "run_s_b").lineageUndeterminable, true);
    assert.equal(runOf(during, "run_s_b").legalDecision, null, "已采纳的子运行在同一轮里同样按无法判定给");

    broken = false;
    await model.refresh();
    assert.deepEqual(model.snapshot({ now: NOW }), before, "下一轮刷新成功后完全恢复");
  } finally {
    s.cleanup();
  }
});

test("谱系：成员读不到 → 该谱系不推导并标明，别的谱系不受影响；从没读得出过的转录 → 全部不推导", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const put = (runId, o) => s.write(s.bucket(ALPHA.slug), runId, lineageRun(runId, o));
    put("run_m_a");
    put("run_m_b", { root: "run_m_a", parent: "run_m_a", decision: "accepted" });
    const c = put("run_m_c", { root: "run_m_a", parent: "run_m_b" });
    put("run_m_x");
    put("run_m_y", { root: "run_m_x", parent: "run_m_x", decision: "accepted" });

    // 新实例：c 从一开始就读不出（坏 JSON）——不知道它属于哪条谱系，全部不推导。
    writeFileSync(c, "{\"seq\":1,\"type\":\n", "utf8");
    const blindModel = createOwnerReadModel({ runDir: s.runDir });
    const blindResult = await blindModel.refresh();
    assert.equal(blindResult.unreadable, 1);
    const blind = blindModel.snapshot({ now: NOW });
    for (const run of blind.runs) {
      assert.equal(run.lineageUndeterminable, run.availability === "ok" ? true : null, `${run.runId}：从没读得出过的转录在场 → 全部标明无法判定`);
      assert.equal(run.supersededByRunId, null, `${run.runId}：不推导`);
    }
    assert.equal(runOf(blind, "run_m_a").lineageRootRunId, "run_m_a", "声明根照给");

    // 那份转录后来读得出（它不属于 x 这条谱系）→ 压住的事实恢复。恢复出来的必须是按
    // 成员算出的结果，不能是看不全那一轮留下的空结果。
    writeFileSync(c, jsonl(lineageRun("run_m_c", { root: "run_m_a", parent: "run_m_b" })), "utf8");
    await blindModel.refresh();
    const unblinded = blindModel.snapshot({ now: NOW });
    assert.equal(runOf(unblinded, "run_m_x").supersededByRunId, "run_m_y", "与它无关的谱系：恢复为被取代");
    assert.equal(runOf(unblinded, "run_m_x").lineageUndeterminable, false);
    assert.equal(runOf(unblinded, "run_m_a").supersededByRunId, "run_m_b", "它所属的谱系：成员齐了，同样派生出来");

    // 另一个实例：先读得出（a 已被 b 取代），后来 c 变得读不到 → 只影响 a 这条谱系。
    const good = lineageRun("run_m_c", { root: "run_m_a", parent: "run_m_b" });
    const model = createOwnerReadModel({ runDir: s.runDir });
    writeFileSync(c, jsonl(good), "utf8");
    await model.refresh();
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_m_a").supersededByRunId, "run_m_b", "夹具前提：c 可读时派生出了被取代");

    writeFileSync(c, "{\"seq\":1,\"type\":\n", "utf8");
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    for (const runId of ["run_m_a", "run_m_b"]) {
      assert.equal(runOf(snap, runId).lineageUndeterminable, true, `${runId}：谱系里有读不出的成员 → 标明无法判定`);
      assert.equal(runOf(snap, runId).supersededByRunId, null, `${runId}：不推导`);
      assert.equal(runOf(snap, runId).legalDecision, null);
    }
    assert.deepEqual(
      { sup: runOf(snap, "run_m_x").supersededByRunId, und: runOf(snap, "run_m_x").lineageUndeterminable },
      { sup: "run_m_y", und: false },
      "别的谱系不受影响",
    );

    // c 修好 → 恢复。
    writeFileSync(c, jsonl(good), "utf8");
    await model.refresh();
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_m_a").supersededByRunId, "run_m_b");
  } finally {
    s.cleanup();
  }
});

test("谱系：同一转录里声明了互相矛盾的谱系根 → 根为 null 并标明，不推导；读不到的运行谱系各项为 null", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const clash = builder("run_k_a");
    clash.clock(T0).add("run.background_submitted", {
      background: true, cwd: PRIVATE_ROOT, deliveryRequested: true, project: projectFact(ALPHA),
      continuation: true, parentRunId: "run_k_root", rootRunId: "run_k_root",
    });
    clash.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
    clash.clock(T0 + 1500).add("run.session_reuse", { mode: "run_lineage", turn: "resume", rootRunId: "run_k_other" });
    working(clash, { at: T0 + 3000 });
    terminal(clash, { at: T0 + 5000 });
    created(clash, T0 + 6000, "run_k_a");
    outcome(clash, T0 + 7000, "run_k_a", "passed");
    s.write(s.bucket(ALPHA.slug), "run_k_a", clash.events);
    // 一个先读得出、后来读不出的普通运行（从没读得出过的转录会让全部谱系不推导，那是另一条用例）。
    const gone = s.write(s.bucket(ALPHA.slug), "run_k_gone", completedEvents("run_k_gone"));
    s.write(s.bucket(ALPHA.slug), "run_k_decided", lineageRun("run_k_decided", { decision: "accepted" }));

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    writeFileSync(gone, "{\"seq\":1,\"type\":\n", "utf8");
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    const clashRun = runOf(snap, "run_k_a");
    assert.equal(clashRun.lineageRootRunId, null, "声明根矛盾：不选其中一个");
    assert.equal(clashRun.lineageRootConflict, true, "并标明是矛盾");
    assert.equal(clashRun.supersededByRunId, null);
    assert.equal(clashRun.lineageUndeterminable, false, "矛盾是本转录自己的确定事实，不是无法判定");
    assert.equal(clashRun.legalDecision, null);
    assert.equal(runOf(snap, "run_k_decided").legalDecision, "accepted", "别的运行的谱系事实不受影响");

    const bad = runOf(snap, "run_k_gone");
    assert.equal(bad.availability, "unreadable");
    for (const key of [
      "delivery", "failure", "capacity", "lineageRootRunId", "lineageRootConflict", "lineageUndeterminable", "legalDecision",
      "supersededByRunId",
    ]) {
      assert.equal(bad[key], null, `读不到的运行：${key} 为 null（不当作"没有"）`);
    }
  } finally {
    s.cleanup();
  }
});

// ===== 5. 分支 =====

function git(args, cwd) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true })).trim();
}

/** 一次性 Git 仓库（os.tmpdir() 下）：一个提交，调用方按需建分支。 */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wao-owner-read-model-facts-repo-"));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@t.com"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "README.md"), "base\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-m", "base"], repo);
  return repo;
}

test("listRunBranchRunIds：只认 wao/run_ 前缀 + 合法 runId；保持新到旧、不截断；git 失败原样抛出", () => {
  const canned = [
    "wao/run_b",
    "wao/run_a",
    "wao/feature", // 不是运行分支
    "wao/run_bad name", // runId 不合法
    "main",
    "wao/run_c",
    "",
  ].join("\r\n");
  const seen = [];
  const runIds = listRunBranchRunIds((args, cwd) => {
    seen.push({ args, cwd });
    return canned;
  }, "D:/fake/repo");
  assert.deepEqual(runIds, ["run_b", "run_a", "run_c"], "按输出顺序（新到旧），不认别的分支");
  assert.deepEqual(seen, [{
    args: ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/wao/"],
    cwd: "D:/fake/repo",
  }], "枚举命令与工作目录原样交给执行缝");
  // 60 条分支全给（leadOpenItems 的查看帽是它自己的事）。
  const many = Array.from({ length: 60 }, (_, i) => `wao/run_${i}`).join("\n");
  assert.equal(listRunBranchRunIds(() => many, "D:/fake/repo").length, 60, "不截断");
  assert.throws(() => listRunBranchRunIds(() => { throw new Error("git failed"); }, "D:/fake/repo"), /git failed/, "失败原样抛出，由调用方处置");
});

test("execGitReadOnly：真实 git 上只读枚举 wao/ 下的分支；等待上限是有界的正整数", () => {
  const repo = makeRepo();
  try {
    git(["branch", "wao/run_a"], repo);
    git(["branch", "wao/feature"], repo);
    const out = execGitReadOnly(["for-each-ref", "--format=%(refname:short)", "refs/heads/wao/"], repo);
    assert.deepEqual(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort(), ["wao/feature", "wao/run_a"]);
    assert.ok(!out.includes("main"), "只枚举 refs/heads/wao/");
    assert.ok(Number.isInteger(RUN_BRANCH_GIT_TIMEOUT_MS) && RUN_BRANCH_GIT_TIMEOUT_MS > 0);
    assert.equal(RUN_BRANCH_GIT_TIMEOUT_MS, 10_000);
    assert.equal(OWNER_BRANCH_REFRESH_MS, 30_000, "分支节流窗口导出且值固定");
  } finally {
    rmrfRetry(repo);
  }
});

test("分支：真实临时仓库里 wao/run_* 分支还在 → branchPresent true；已清理 → false；只枚举有交付运行的项目", async () => {
  const s = makeStore();
  const repo = makeRepo();
  try {
    const alpha = { ...ALPHA, key: repo };
    s.writeProject(alpha);
    s.writeProject(BETA);
    const put = (runId, events) => s.write(s.bucket(alpha.slug), runId, events);
    const delivered = (runId) => {
      const b = deliveryRun(runId);
      created(b, T0 + 6000, runId);
      outcome(b, T0 + 7000, runId, "passed");
      return b.events;
    };
    put("run_br_keep", delivered("run_br_keep"));
    put("run_br_gone", delivered("run_br_gone"));
    put("run_br_nodelivery", completedEvents("run_br_nodelivery", { project: alpha }));
    // beta 也有请求了交付的运行，但它的仓库根不存在：不会去枚举。
    s.write(s.bucket(BETA.slug), "run_br_beta", delivered("run_br_beta").map((e) => ({
      ...e, project: e.type === "run.background_submitted" ? projectFact(BETA) : undefined,
    })));
    git(["branch", "wao/run_br_keep"], repo);
    git(["branch", "wao/feature"], repo);

    const { io, gits } = countingIo();
    const model = createOwnerReadModel({ runDir: s.runDir, io, nowFn: () => NOW });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    assert.equal(runOf(snap, "run_br_keep").delivery.branchPresent, true);
    assert.equal(runOf(snap, "run_br_gone").delivery.branchPresent, false, "分支已清理 → false");
    assert.equal(runOf(snap, "run_br_nodelivery").delivery, null, "没请求交付的运行没有交付对象");
    assert.equal(runOf(snap, "run_br_beta").delivery.branchPresent, null, "仓库不存在 → null（不当作不在）");
    assert.deepEqual(projectOf(snap, alpha.slug), {
      slug: alpha.slug, name: alpha.name, repo: "available", branchesObservedAt: iso(NOW),
    }, "快照里的项目条目不带 key");
    assert.deepEqual(projectOf(snap, BETA.slug), {
      slug: BETA.slug, name: BETA.name, repo: "unknown", branchesObservedAt: null,
    });
    assert.equal(gits.length, 1, "只枚举了 alpha 一个项目");
    assert.equal(gits[0].cwd, repo);
    assert.ok(!JSON.stringify(snap).includes(repo), "仓库根不进快照");
  } finally {
    s.cleanup();
    rmrfRetry(repo);
  }
});

test("分支：项目仓库根不存在 → unknown / 未观测，branchPresent 为 null（不当作不在），也不调 git", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA); // key 是磁盘上不存在的路径
    const b = deliveryRun("run_br_miss");
    created(b, T0 + 6000, "run_br_miss");
    outcome(b, T0 + 7000, "run_br_miss", "passed");
    s.write(s.bucket(ALPHA.slug), "run_br_miss", b.events);
    const { io, gits } = countingIo();
    const model = createOwnerReadModel({ runDir: s.runDir, io });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    assert.equal(runOf(snap, "run_br_miss").delivery.branchPresent, null);
    assert.equal(projectOf(snap, ALPHA.slug).repo, "unknown");
    assert.equal(projectOf(snap, ALPHA.slug).branchesObservedAt, null, "没有可观测的仓库：不记观测时刻");
    assert.equal(gits.length, 0);
  } finally {
    s.cleanup();
  }
});

test("分支：仓库目录在但 git 失败 → 记 unknown、branchPresent 为 null，不拿上次的结果冒充这一轮", async () => {
  const s = makeStore();
  const repo = makeRepo();
  try {
    const alpha = { ...ALPHA, key: repo };
    s.writeProject(alpha);
    const b = deliveryRun("run_br_fail");
    created(b, T0 + 6000, "run_br_fail");
    outcome(b, T0 + 7000, "run_br_fail", "passed");
    s.write(s.bucket(alpha.slug), "run_br_fail", b.events);
    git(["branch", "wao/run_br_fail"], repo);

    let fail = false;
    const { io, gits } = countingIo({
      execGit: (args, cwd) => {
        gits.push({ args, cwd });
        if (fail) throw new Error("fatal: not a git repository (stub)");
        return execGitReadOnly(args, cwd);
      },
    });
    let clock = NOW;
    const model = createOwnerReadModel({ runDir: s.runDir, io, nowFn: () => clock });
    await model.refresh();
    assert.equal(runOf(model.snapshot({ now: clock }), "run_br_fail").delivery.branchPresent, true, "夹具前提：先有一次成功的观测");

    // 窗口之内不重新观测：沿用窗口内的结果。
    fail = true;
    clock = NOW + 10_000;
    await model.refresh();
    assert.equal(gits.length, 1, "30 秒内不再调 git");
    assert.equal(runOf(model.snapshot({ now: clock }), "run_br_fail").delivery.branchPresent, true);

    // 窗口到了：重新观测失败 → 如实 unknown，不沿用上次成功的集合。
    clock = NOW + OWNER_BRANCH_REFRESH_MS;
    await model.refresh();
    assert.equal(gits.length, 2);
    const snap = model.snapshot({ now: clock });
    assert.equal(runOf(snap, "run_br_fail").delivery.branchPresent, null, "git 失败 → unknown（不是 true，也不是 false）");
    assert.deepEqual(projectOf(snap, alpha.slug), {
      slug: alpha.slug, name: alpha.name, repo: "unknown", branchesObservedAt: iso(NOW + OWNER_BRANCH_REFRESH_MS),
    }, "记下这次观测的时刻");

    // 仓库目录整个没了：窗口到了之后重新观测——没有可观测的仓库，不记观测时刻，也不调 git。
    clock = NOW + 2 * OWNER_BRANCH_REFRESH_MS;
    rmrfRetry(repo);
    await model.refresh();
    assert.deepEqual(projectOf(model.snapshot({ now: clock }), alpha.slug), {
      slug: alpha.slug, name: alpha.name, repo: "unknown", branchesObservedAt: null,
    });
    assert.equal(gits.length, 2);
  } finally {
    s.cleanup();
    rmrfRetry(repo);
  }
});

test("分支：每个项目至多每 30 秒重新观测一次（注入时钟）；窗口内的结果沿用", async () => {
  const s = makeStore();
  const repo = makeRepo();
  try {
    const alpha = { ...ALPHA, key: repo };
    s.writeProject(alpha);
    const b = deliveryRun("run_br_th");
    created(b, T0 + 6000, "run_br_th");
    outcome(b, T0 + 7000, "run_br_th", "passed");
    s.write(s.bucket(alpha.slug), "run_br_th", b.events);
    git(["branch", "wao/run_br_th"], repo);

    const { io, gits } = countingIo();
    let clock = NOW;
    const model = createOwnerReadModel({ runDir: s.runDir, io, nowFn: () => clock });
    const observe = async (at) => {
      clock = at;
      await model.refresh();
      return model.snapshot({ now: clock });
    };
    let snap = await observe(NOW);
    assert.equal(gits.length, 1);
    assert.equal(projectOf(snap, alpha.slug).branchesObservedAt, iso(NOW));
    assert.equal(runOf(snap, "run_br_th").delivery.branchPresent, true);

    // 分支在仓库里被清掉了，但还在窗口内：不重新观测，沿用窗口内的结果。
    git(["branch", "-D", "wao/run_br_th"], repo);
    snap = await observe(NOW + OWNER_BRANCH_REFRESH_MS - 1);
    assert.equal(gits.length, 1, "差 1ms 到窗口：不调 git");
    assert.equal(runOf(snap, "run_br_th").delivery.branchPresent, true, "窗口内沿用上次的观测");
    assert.equal(projectOf(snap, alpha.slug).branchesObservedAt, iso(NOW), "观测时刻没变");

    // 恰好到窗口：重新观测，结果随之更新。
    snap = await observe(NOW + OWNER_BRANCH_REFRESH_MS);
    assert.equal(gits.length, 2);
    assert.equal(runOf(snap, "run_br_th").delivery.branchPresent, false);
    assert.equal(projectOf(snap, alpha.slug).branchesObservedAt, iso(NOW + OWNER_BRANCH_REFRESH_MS));
  } finally {
    s.cleanup();
    rmrfRetry(repo);
  }
});

// ===== 6. 会审 =====

test("常量导出：会审结论闭集与分支节流窗口的值固定", () => {
  assert.deepEqual([...OWNER_CONSULT_Q1_VALUES], ["PASS", "PASS_WITH_NOTES", "FIX_FIRST"]);
  assert.equal(OWNER_BRANCH_REFRESH_MS, 30_000);
});

const consultsDirOf = (key) => join(key, ".wao", "runs", "consults");

function writeConsult(dir, consultId, over = {}) {
  mkdirSync(dir, { recursive: true });
  const record = {
    consultId,
    createdAt: iso(T0),
    // 任务书路径与视角片段是磁盘上的私有内容：不得进快照。
    brief: { path: "D:\\private\\briefs\\plan.md", sha256: "a".repeat(64) },
    budgetMs: 0,
    elapsedMs: 5,
    questions: [{ q: 1, heading: "## Q1 是否可行" }],
    declaredFields: { Q1: [...OWNER_CONSULT_Q1_VALUES] },
    seats: [],
    fieldDiff: [],
    ...over,
  };
  writeFileSync(join(dir, `${consultId}.json`), JSON.stringify(record, null, 2), "utf8");
  return record;
}

/** 席位记录（组记录里的形状）。 */
const seat = (agentId, runId, runState = "completed") => ({ agentId, runId, runState, formatState: "structured" });

/** 席位运行：最后一条 assistant 消息就是回答。 */
function seatRun(runId, reply, { at = T0, state = "completed" } = {}) {
  const b = builder(runId, { agentId: runId });
  head(b, { at, prompt: "# 会审任务书\n## Q1 是否可行", project: ALPHA });
  working(b, { at: at + 3000 });
  b.clock(at + 4000).add("run.event", {
    kind: "message", role: "assistant", parts: [{ type: "text", text: `先看了一遍代码（cwd ${PRIVATE_ROOT}）。` }],
  });
  if (reply !== null) {
    b.clock(at + 4500).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: reply }] });
  }
  if (state !== "running") terminal(b, { at: at + 5000, state });
  return b.events;
}

/** 建一个带真实项目目录（key）的存储，会审组记录写在 <key>/.wao/runs/consults/。 */
function makeConsultStore() {
  const s = makeStore("wao-owner-read-model-consult-");
  const key = join(s.base, "alpha-repo");
  mkdirSync(key, { recursive: true });
  s.alpha = { ...ALPHA, key };
  s.writeProject(s.alpha);
  s.consultsDir = consultsDirOf(key);
  return s;
}

test("会审：Q1 两席一致、分裂、一席缺结论、一席转录读不到；按 createdAt 排序；记录里的路径不进快照", async () => {
  const s = makeConsultStore();
  try {
    const dir = s.consultsDir;
    const put = (runId, reply, o) => s.write(s.bucket(s.alpha.slug), runId, seatRun(runId, reply, o));

    // 两席一致。
    writeConsult(dir, "consult_20261124120000001aaaaaa", {
      createdAt: iso(NOW - 3000),
      seats: [seat("seat_a1", "run_seat_a1"), seat("seat_b1", "run_seat_b1"), {
        agentId: "seat_c1", runId: "run_seat_c1", runState: "completed", perspectiveSnippet: "视角：D:\\private\\notes.md",
      }],
    });
    put("run_seat_a1", "## Q1: PASS\n\n理由一。");
    put("run_seat_b1", "Q1：PASS\n\n理由二。");
    put("run_seat_c1", "**Q1**：PASS\n\n理由三。");
    // 分裂。
    writeConsult(dir, "consult_20261124120000002bbbbbb", {
      createdAt: iso(NOW - 2000),
      seats: [seat("seat_a2", "run_seat_a2"), seat("seat_b2", "run_seat_b2")],
    });
    put("run_seat_a2", "## Q1: PASS");
    put("run_seat_b2", "## Q1: FIX_FIRST\n\n要改。");
    // 一席缺结论：有文本但没有锚点；另一席的值不紧跟锚点（决定 0128）。
    writeConsult(dir, "consult_20261124120000003cccccc", {
      createdAt: iso(NOW - 1000),
      seats: [seat("seat_a3", "run_seat_a3"), seat("seat_b3", "run_seat_b3"), seat("seat_c3", "run_seat_c3")],
    });
    put("run_seat_a3", "我看下来方案可行，但要注意边界。");
    put("run_seat_b3", "Q1: 不是 PASS，应为 FIX_FIRST");
    put("run_seat_c3", "## Q1: PASS_WITH_NOTES\n\n小问题两处。");
    // 一席转录读不到（坏 JSON），一席运行在本运行目录里找不到，一席还在跑。
    writeConsult(dir, "consult_20261124120000004dddddd", {
      createdAt: iso(NOW - 500),
      reviewedRunId: "run_under_review",
      seats: [seat("seat_a4", "run_seat_a4"), seat("seat_b4", "run_seat_b4"), seat("seat_c4", "run_seat_c9"), seat("seat_d4", "run_seat_d4")],
    });
    put("run_seat_a4", "## Q1: PASS");
    s.write(s.bucket(s.alpha.slug), "run_seat_b4", [null]);
    put("run_seat_d4", "## Q1: FIX_FIRST", { state: "running" });
    // 没有可用的时间 → 排最后。
    writeConsult(dir, "consult_20261124120000000eeeeee", { createdAt: "not a date", seats: [] });

    const model = createOwnerReadModel({ runDir: s.runDir });
    const result = await model.refresh();
    assert.equal(result.unreadable, 1, "只有那份坏席位转录读不出");
    const snap = model.snapshot({ now: NOW });
    assert.deepEqual(snap.consults.map((c) => c.consultId), [
      "consult_20261124120000001aaaaaa",
      "consult_20261124120000002bbbbbb",
      "consult_20261124120000003cccccc",
      "consult_20261124120000004dddddd",
      "consult_20261124120000000eeeeee",
    ], "按 createdAt 升序，没有可用时间的排最后");

    const agree = consultOf(snap, "consult_20261124120000001aaaaaa");
    assert.deepEqual(agree, {
      consultId: "consult_20261124120000001aaaaaa",
      projectSlug: s.alpha.slug,
      createdAt: iso(NOW - 3000),
      reviewedRunId: null,
      q1Declared: true,
      seats: [
        { agentId: "seat_a1", runId: "run_seat_a1", runState: "completed", q1: "PASS" },
        { agentId: "seat_b1", runId: "run_seat_b1", runState: "completed", q1: "PASS" },
        { agentId: "seat_c1", runId: "run_seat_c1", runState: "completed", q1: "PASS" },
      ],
    }, "标题形、裸编号形、加粗形三种写法都取到；只给结论值，不给一致 / 分歧这类结论词");
    assert.deepEqual(consultOf(snap, "consult_20261124120000002bbbbbb").seats.map((x) => x.q1), ["PASS", "FIX_FIRST"], "分裂：各给各的值");
    assert.deepEqual(consultOf(snap, "consult_20261124120000003cccccc").seats.map((x) => x.q1), [null, null, "PASS_WITH_NOTES"], "没锚点、值不紧跟锚点 → 未填");
    const broken = consultOf(snap, "consult_20261124120000004dddddd");
    assert.equal(broken.reviewedRunId, "run_under_review");
    assert.deepEqual(broken.seats, [
      { agentId: "seat_a4", runId: "run_seat_a4", runState: "completed", q1: "PASS" },
      { agentId: "seat_b4", runId: "run_seat_b4", runState: "missing", q1: null }, // 转录读不出
      { agentId: "seat_c4", runId: "run_seat_c9", runState: "missing", q1: null }, // 本运行目录里没有
      { agentId: "seat_d4", runId: "run_seat_d4", runState: "running", q1: "FIX_FIRST" }, // 还在跑：给当下的观察
    ]);
    assert.deepEqual(consultOf(snap, "consult_20261124120000000eeeeee"), {
      consultId: "consult_20261124120000000eeeeee", projectSlug: s.alpha.slug, createdAt: null, reviewedRunId: null,
      q1Declared: true, seats: [],
    }, "时间读不出如实为 null");

    const text = JSON.stringify(snap);
    for (const needle of ["private", "briefs", "notes.md", s.consultsDir, s.alpha.key, "先看了一遍代码"]) {
      assert.ok(!text.includes(needle), `会审事实泄漏了 ${needle}`);
    }
    assert.ok(!text.includes("fieldDiff"), "不给一致 / 分歧结论");
  } finally {
    s.cleanup();
  }
});

test("会审：记录没声明 Q1 → 不算；Q1 声明的是别的候选值 → 不是结论题；派发未成立的席位如实给", async () => {
  const s = makeConsultStore();
  try {
    const dir = s.consultsDir;
    const put = (runId, reply) => s.write(s.bucket(s.alpha.slug), runId, seatRun(runId, reply));
    writeConsult(dir, "consult_20261124130000001aaaaaa", { declaredFields: undefined, seats: [seat("seat_a1", "run_seat_a1")] });
    put("run_seat_a1", "## Q1: PASS");
    writeConsult(dir, "consult_20261124130000002bbbbbb", { declaredFields: { Q2: ["YES", "NO"] }, seats: [seat("seat_a2", "run_seat_a2")] });
    put("run_seat_a2", "## Q1: PASS\n\n## Q2: YES");
    // 头脑风暴：Q1 的候选值是方案字母——取到了也不是审查结论。
    writeConsult(dir, "consult_20261124130000003cccccc", { declaredFields: { Q1: ["A", "B", "C"] }, seats: [seat("seat_a3", "run_seat_a3")] });
    put("run_seat_a3", "## Q1: C");
    writeConsult(dir, "consult_20261124130000004dddddd", {
      seats: [seat("seat_a4", null, "dispatch_failed"), { agentId: "bad agent!", runId: "run_seat_x", runState: "completed" }],
    });
    put("run_seat_x", "## Q1: PASS");

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    const pick = (consultId) => {
      const c = consultOf(snap, consultId);
      return { q1Declared: c.q1Declared, seats: c.seats };
    };
    assert.deepEqual(pick("consult_20261124130000001aaaaaa"), {
      q1Declared: false,
      seats: [{ agentId: "seat_a1", runId: "run_seat_a1", runState: "completed", q1: null }],
    }, "没声明 Q1：回复里写了 PASS 也不算");
    assert.deepEqual(pick("consult_20261124130000002bbbbbb"), {
      q1Declared: false,
      seats: [{ agentId: "seat_a2", runId: "run_seat_a2", runState: "completed", q1: null }],
    }, "只声明了 Q2");
    assert.deepEqual(pick("consult_20261124130000003cccccc"), {
      q1Declared: false,
      seats: [{ agentId: "seat_a3", runId: "run_seat_a3", runState: "completed", q1: null }],
    }, "Q1 声明的是方案字母：取到了也不进快照");
    assert.deepEqual(pick("consult_20261124130000004dddddd"), {
      q1Declared: true,
      seats: [
        { agentId: "seat_a4", runId: null, runState: "dispatch_failed", q1: null },
        { agentId: null, runId: "run_seat_x", runState: "completed", q1: null }, // agentId 不合形状：不算这一席
      ],
    });
  } finally {
    s.cleanup();
  }
});

test("会审：坏记录（不是 JSON / consultId 与文件名不一致）计入 unreadable，不中断刷新；修好后自愈；别的文件名不理", async () => {
  const s = makeConsultStore();
  try {
    const dir = s.consultsDir;
    mkdirSync(dir, { recursive: true });
    const good = writeConsult(dir, "consult_20261124140000001aaaaaa", { seats: [] });
    assert.equal(good.consultId, "consult_20261124140000001aaaaaa");
    const badJson = join(dir, "consult_20261124140000002bbbbbb.json");
    writeFileSync(badJson, "{not json", "utf8");
    // 记录里的 consultId 与文件名不一致。
    writeFileSync(join(dir, "consult_20261124140000003cccccc.json"), JSON.stringify({ ...good }), "utf8");
    // 不是会审记录的文件：写盘时的临时文件、别的名字、文件名不合形状。
    writeFileSync(join(dir, "consult_20261124140000001aaaaaa.json.abc.tmp"), "{", "utf8");
    writeFileSync(join(dir, "notes.json"), "{not json", "utf8");
    writeFileSync(join(dir, "consult_bad..id.json"), "{not json", "utf8");

    const model = createOwnerReadModel({ runDir: s.runDir });
    let result = await model.refresh();
    assert.equal(result.unreadable, 2, "坏 JSON 与 consultId 不一致各算一个；别的文件名不计");
    assert.deepEqual(model.snapshot({ now: NOW }).consults.map((c) => c.consultId), ["consult_20261124140000001aaaaaa"], "好记录照常给");

    // 修好其中一份；另一份每轮都重试、都计数。
    writeConsult(dir, "consult_20261124140000002bbbbbb", { seats: [] });
    result = await model.refresh();
    assert.equal(result.unreadable, 1);
    assert.deepEqual(
      model.snapshot({ now: NOW }).consults.map((c) => c.consultId).sort(),
      ["consult_20261124140000001aaaaaa", "consult_20261124140000002bbbbbb"],
    );
  } finally {
    s.cleanup();
  }
});

test("会审：记录与席位转录都没变 → 不重读（只列目录）；席位转录变了 → 重算该席；记录变了 → 重算但不重读没变的席位", async () => {
  const s = makeConsultStore();
  try {
    const dir = s.consultsDir;
    writeConsult(dir, "consult_20261124150000001aaaaaa", {
      createdAt: iso(NOW - 1000),
      seats: [seat("seat_a", "run_seat_a"), seat("seat_b", "run_seat_b")],
    });
    const a = s.write(s.bucket(s.alpha.slug), "run_seat_a", seatRun("run_seat_a", "## Q1: PASS"));
    const b = s.write(s.bucket(s.alpha.slug), "run_seat_b", seatRun("run_seat_b", "## Q1: PASS"));
    const other = s.write(s.bucket(s.alpha.slug), "run_other", completedEvents("run_other", { project: s.alpha }));

    const { io, reads, dirs } = countingIo();
    const model = createOwnerReadModel({ runDir: s.runDir, io });
    const recordPath = join(dir, "consult_20261124150000001aaaaaa.json");
    const transcriptReads = () => reads.filter((p) => p !== recordPath);
    const result = await model.refresh();
    // 冷普查：三份转录各读一遍；两份席位转录为取结论再各读一遍（事件不留在内存里）；
    // 组记录读一遍。
    assert.equal(transcriptReads().length, 5);
    assert.equal(new Set(transcriptReads()).size, 3);
    assert.deepEqual(reads.filter((p) => p === recordPath), [recordPath]);
    assert.equal(result.reread, 3, "reread 按转录文件计：同一份转录一轮里读两次只计一次；组记录不计");
    assert.deepEqual(dirs, [dir], "只列了会审记录目录");
    assert.deepEqual(consultOf(model.snapshot({ now: NOW }), "consult_20261124150000001aaaaaa").seats.map((x) => x.q1), ["PASS", "PASS"]);

    // 都没变：一个文件都不读，只列目录；结果沿用。
    reads.length = 0;
    dirs.length = 0;
    await model.refresh();
    assert.equal(reads.length, 0, "记录与席位转录都没变：不重读");
    assert.deepEqual(dirs, [dir]);
    assert.deepEqual(consultOf(model.snapshot({ now: NOW }), "consult_20261124150000001aaaaaa").seats.map((x) => x.q1), ["PASS", "PASS"]);

    // 席位 b 的转录变了（追加了一条最终回答）：只重读 b；a 的最终回答文本按文件身份缓存着。
    await appendFile(b, `${JSON.stringify({
      seq: 99, ts: iso(T0 + 6000), type: "run.event", runId: "run_seat_b", agentId: "run_seat_b",
      kind: "message", role: "assistant", parts: [{ type: "text", text: "## Q1: FIX_FIRST\n\n改主意了，要改。" }],
    })}\n`, "utf8");
    reads.length = 0;
    await model.refresh();
    assert.deepEqual([...new Set(transcriptReads())], [b], "只重读了变化的那一席（b：普查一遍 + 取结论一遍）");
    assert.equal(transcriptReads().length, 2);
    assert.ok(!reads.includes(other) && !reads.includes(a), "没变的席位与别的运行都不读");
    assert.deepEqual(consultOf(model.snapshot({ now: NOW }), "consult_20261124150000001aaaaaa").seats.map((x) => x.q1), ["PASS", "FIX_FIRST"], "席位转录变化后重算");

    // 记录变了（撤掉 Q1 声明）：只重读组记录，重算，不重读任何席位转录。
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    delete record.declaredFields;
    writeFileSync(recordPath, JSON.stringify(record, null, 2), "utf8");
    reads.length = 0;
    await model.refresh();
    assert.deepEqual(reads, [recordPath], "记录变了：只重读组记录");
    const after = consultOf(model.snapshot({ now: NOW }), "consult_20261124150000001aaaaaa");
    assert.equal(after.q1Declared, false);
    assert.deepEqual(after.seats.map((x) => x.q1), [null, null], "记录变化后重算");
  } finally {
    s.cleanup();
  }
});

// ===== 7. 快照无路径 =====

/** 递归收集快照里的全部键与字符串值。 */
function collect(snapshot) {
  const keys = new Set();
  const strings = [];
  const walk = (value) => {
    if (value === null) return;
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        keys.add(k);
        walk(v);
      }
    }
  };
  walk(snapshot);
  return { keys: [...keys], strings };
}

test("快照无路径：遍历覆盖全部新增字段——项目 key、工作树、会审记录与任务书路径、诊断证据原文都不出现；嵌套键集是白名单", async () => {
  const s = makeStore("wao-owner-read-model-leak-");
  const repo = makeRepo();
  try {
    // 两个项目：alpha 的仓库是真实临时 Git 仓库（有分支、有会审记录）；beta 的 key 不存在。
    const alpha = { ...ALPHA, slug: "alpha-11111111", name: "alpha", key: repo };
    s.writeProject(alpha);
    s.writeProject(BETA);
    const put = (runId, events, project = alpha) => s.write(s.bucket(project.slug), runId, events);

    // 已采纳的交付（分支还在）。
    const acc = deliveryRun("run_leak_acc");
    created(acc, T0 + 6000, "run_leak_acc");
    outcome(acc, T0 + 7000, "run_leak_acc", "failed");
    reverify(acc, T0 + 8000, T0 + 8500, "run_leak_acc");
    decide(acc, T0 + 9000, "run_leak_acc", "accepted", "passed");
    put("run_leak_acc", acc.events);
    git(["branch", "wao/run_leak_acc"], repo);
    // 额度失败：诊断依据的 run.error 里有秘密形状与私有路径。
    const cap = builder("run_leak_cap");
    head(cap, { deliveryRequested: true });
    working(cap, { at: T0 + 3000 });
    terminal(cap, { at: T0 + 5000, state: "failed", error: `HTTP 429 Too Many Requests token ${SECRET} at ${PRIVATE_ROOT}\\x` });
    put("run_leak_cap", cap.events);
    // 打包失败。
    const pack = deliveryRun("run_leak_pack", { state: "failed", error: "exit code 1" });
    pack.clock(T0 + 6000).add("run.delivery_failed", { deliveryCode: "disallowed_path", errorClass: "git_command_failed" });
    put("run_leak_pack", pack.events);
    // 隔离失败。
    const isoRun = deliveryRun("run_leak_iso", { state: "failed" });
    isoRun.clock(T0 + 6000).add("run.isolation_violation", {
      code: "workdir_escape", reason: "file_written_physical_outside", path: `${PRIVATE_ROOT}\\..\\outside.txt`,
    });
    put("run_leak_iso", isoRun.events);
    // 谱系：父被子取代。
    put("run_leak_a", lineageRun("run_leak_a"));
    put("run_leak_b", lineageRun("run_leak_b", { root: "run_leak_a", parent: "run_leak_a", decision: "accepted" }));
    // 读不出的运行（先读得出、后来读不出）、没请求交付的运行。
    const bad = put("run_leak_bad", completedEvents("run_leak_bad"));
    put("run_leak_plain", completedEvents("run_leak_plain"));
    // beta 的一个已采纳交付：仓库不存在。
    const betaRun = deliveryRun("run_leak_beta");
    created(betaRun, T0 + 6000, "run_leak_beta");
    outcome(betaRun, T0 + 7000, "run_leak_beta", "passed");
    decide(betaRun, T0 + 8000, "run_leak_beta", "rejected", "passed");
    put("run_leak_beta", betaRun.events.map((e) => ({
      ...e, project: e.type === "run.background_submitted" ? projectFact(BETA) : undefined,
    })), BETA);
    // 会审：记录里有任务书路径、视角片段；席位转录里有 cwd。
    const dir = consultsDirOf(repo);
    writeConsult(dir, "consult_20261124160000001aaaaaa", {
      seats: [
        seat("seat_a", "run_seat_a"),
        { ...seat("seat_b", "run_seat_b"), perspectiveSnippet: `视角：见 ${PRIVATE_ROOT}\\notes.md` },
      ],
    });
    put("run_seat_a", seatRun("run_seat_a", "## Q1: PASS"));
    put("run_seat_b", seatRun("run_seat_b", "Q1: FIX_FIRST"));

    const model = createOwnerReadModel({ runDir: s.runDir, nowFn: () => NOW });
    await model.refresh();
    writeFileSync(bad, "{\"seq\":1,\"type\":\n", "utf8");
    await model.refresh();
    const snap = model.snapshot({ now: NOW });

    // 夹具前提：新增字段确实都有内容（不是靠 null 蒙混过关）。
    const accRun = runOf(snap, "run_leak_acc");
    assert.equal(accRun.delivery.branchPresent, true);
    assert.equal(accRun.legalDecision, "accepted");
    assert.equal(runOf(snap, "run_leak_a").supersededByRunId, "run_leak_b");
    assert.deepEqual(runOf(snap, "run_leak_cap").failure, { category: "provider_capacity", code: "rate_limited" });
    assert.deepEqual(runOf(snap, "run_leak_cap").capacity, { code: "rate_limited", observedAt: iso(T0 + 5000) });
    assert.equal(runOf(snap, "run_leak_pack").failure.category, "delivery_packaging_failed");
    assert.equal(runOf(snap, "run_leak_pack").delivery.packagingFailure, "disallowed_path");
    assert.equal(runOf(snap, "run_leak_iso").delivery.isolationFailure.code, "workdir_escape");
    assert.equal(runOf(snap, "run_leak_beta").delivery.branchPresent, null);
    assert.equal(snap.consults.length, 1);
    assert.equal(snap.consults[0].seats.length, 2);
    assert.deepEqual(snap.consults[0].seats.map((x) => x.q1), ["PASS", "FIX_FIRST"]);

    // 键集白名单（DTO 不整包透传：加键必须过这里）。
    assert.deepEqual(Object.keys(snap).sort(), ["consults", "generatedAt", "projects", "runs"]);
    for (const p of snap.projects) {
      assert.deepEqual(Object.keys(p).sort(), ["branchesObservedAt", "name", "repo", "slug"], "项目条目恰四键，不带 key");
    }
    assert.deepEqual(projectOf(snap, alpha.slug), { slug: alpha.slug, name: alpha.name, repo: "available", branchesObservedAt: iso(NOW) });
    assert.deepEqual(projectOf(snap, BETA.slug), { slug: BETA.slug, name: BETA.name, repo: "unknown", branchesObservedAt: null });
    const RUN_KEYS = [
      "agentId", "availability", "capacity", "delivery", "deliveryRequested", "failure", "lastEffectAt", "lastProcessActiveAt",
      "lastVitalAt", "laneId", "legalDecision", "lineageRootConflict", "lineageRootRunId", "lineageUndeterminable", "liveness",
      "parentRunId", "project", "quietSince", "readOnly", "retryOf", "roleId", "runId", "stage", "stageSince", "startedAt",
      "state", "supersededByRunId", "taskType", "terminal", "terminalAt", "title", "titleBasis", "typeBasis",
    ].sort();
    for (const run of snap.runs) {
      assert.deepEqual(Object.keys(run).sort(), RUN_KEYS, `${run.runId} 的运行行键集`);
      if (run.delivery !== null) {
        assert.deepEqual(Object.keys(run.delivery).sort(), [
          "acceptance", "ambiguous", "branchPresent", "commit", "isolationFailure", "packagingFailure", "settledAt",
          "settlement", "verification",
        ], `${run.runId} 的 delivery 键集`);
        assert.deepEqual(Object.keys(run.delivery.settlement).sort(), ["reason", "status"]);
        assert.deepEqual(Object.keys(run.delivery.acceptance).sort(), ["decidedAt", "status"]);
        if (run.delivery.verification !== null) {
          assert.deepEqual(Object.keys(run.delivery.verification).sort(), ["reverify", "status"]);
          assert.deepEqual(Object.keys(run.delivery.verification.reverify).sort(), ["reason", "status"]);
        }
        if (run.delivery.isolationFailure !== null) {
          assert.deepEqual(Object.keys(run.delivery.isolationFailure).sort(), ["code", "reason"]);
        }
      }
      if (run.failure !== null) assert.deepEqual(Object.keys(run.failure).sort(), ["category", "code"]);
      if (run.capacity !== null) assert.deepEqual(Object.keys(run.capacity).sort(), ["code", "observedAt"]);
    }
    for (const consult of snap.consults) {
      assert.deepEqual(Object.keys(consult).sort(), ["consultId", "createdAt", "projectSlug", "q1Declared", "reviewedRunId", "seats"]);
      for (const row of consult.seats) assert.deepEqual(Object.keys(row).sort(), ["agentId", "q1", "runId", "runState"]);
    }

    const { keys, strings } = collect(snap);
    for (const key of keys) {
      assert.ok(!/path|cwd|dir|file|worktree|tree|pid|session|registry|key\b/i.test(key), `快照里不得出现路径类键名：${key}`);
    }
    const variants = (p) => [p, p.replace(/\\/g, "/")];
    const needles = [
      ...variants(s.base), ...variants(s.runDir), ...variants(s.bucket(alpha.slug)), ...variants(s.bucket(BETA.slug)),
      ...variants(repo), ...variants(dir), ...variants(join(dir, "consult_20261124160000001aaaaaa.json")),
      ...PRIVATE_PATHS.flatMap(variants),
      ".jsonl", "proc_4242", "outside.txt", "notes.md", "briefs", "wao-worktrees", SECRET, "placeholder",
    ];
    assert.ok(strings.length > 40, `夹具前提：快照里有足够多的字符串可供检查（${strings.length}）`);
    for (const str of strings) {
      for (const needle of needles) {
        assert.ok(!str.includes(needle), `快照字符串泄漏了路径/标识：${JSON.stringify(str)} 含 ${JSON.stringify(needle)}`);
      }
    }
    assert.ok(!JSON.stringify(snap).includes("private"), "连转义后的形式也不得出现");
  } finally {
    s.cleanup();
    rmrfRetry(repo);
  }
});
