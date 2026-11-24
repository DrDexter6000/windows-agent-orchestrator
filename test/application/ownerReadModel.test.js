// test/application/ownerReadModel.test.js
//
// 第 140a 批（决定 0131）：Owner 看板的共享读模型 + 标题/任务类型派生 + 派发端
// 类型固化。
//
// 夹具纪律：运行目录、转录、租约文件全部建在 os.tmpdir() 下，绝不读仓库的
// runs/；读模型的真实落盘面一律显式 runDir 注入。续修夹具在 tmpdir 里建一次性
// Git 仓库与链接工作树（与 test/run-lifecycle/runContinueInheritedDelivery.test.js
// 同形）。派发类用例全部是假 backend（零真实 worker、零 token）。
//
// 进程内跑 runner 入口时 stdin / stdout 都走注入缝：node --test 的子进程是拿标准
// 输出给父进程报测试结果的（二进制通道），既不能往真 stdout 写，也不能把它换成
// 空函数——后者会把恰好在这段时间上报的用例整条丢掉（既不算过也不算红）。
//
// 覆盖面（每条声称对应一个能证伪它的用例）：
//   - 冷普查：项目桶 + 旧平铺 + 特殊桶；项目名来自 .project.json
//   - 同 runId 两处：字节相同去重、不同为 conflict、有一份读不到整份不可用
//   - 增量：只重读文件身份（大小、mtime、ctime、ino）有变化的文件；同长改写并恢复
//     mtime 也认得出；新增、删除、移桶；批间让出事件循环
//   - 读不到（完整行里的坏 JSON、空文件、读失败、stat 失败）如实 unknown；未写完的
//     半行尾不算损坏；枚举用严格模式，失败时上一份索引原样保留
//   - terminalAt 与 state 取同一条终态事件；活性四值 + unknown 与两个常量边界；
//     progress 只认实质动作；坏租约不拖垮快照
//   - stage：starting（accepted/spawned）、active、terminal、stage_unknown
//   - 标题：第一个非空行（跳过围栏与分隔线）、取最后一条绑定 prompt.sent、
//     先脱敏后截断、80 字帽、会审拼接后的 prompt 取任务书首行
//   - 类型：判定顺序、非法标签值、auditor、续修与 retry 的传播（含只有标签的旧
//     生图运行）、retryOf、会审席、runner 启动失败
//   - laneId / roleId 必须符合身份字母表；快照对象里没有任何路径

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { rmrfRetry } from "../_rmrfHelper.mjs";
import {
  OWNER_LIVENESS_VALUES,
  OWNER_PROCESS_WINDOW_SECONDS,
  OWNER_PROGRESS_WINDOW_SECONDS,
  OWNER_STAGE_VALUES,
  OWNER_TITLE_MAX_CHARS,
  createOwnerReadModel,
  deriveOwnerTaskType,
  deriveOwnerTitle,
  deriveOwnerTitleFacts,
} from "../../src/application/ownerReadModel.js";
import {
  findState,
  findStateEvidence,
  inheritableOwnerTaskType,
  OWNER_TASK_TYPES,
  parseTags,
  persistedOwnerTaskType,
  readTranscript,
} from "../../src/transcript.js";
import { secondsSinceLastEffect } from "../../src/application/runQuietAdvisory.js";
import { redactSecretShapes } from "../../src/secretRedaction.js";
import { listProjectRecords, listTranscriptsDeep, resolveTranscriptPath } from "../../src/projectBuckets.js";
import { RunManager } from "../../src/runManager.js";
import { runBackground, runMain } from "../../src/backgroundRunner.js";
import { dispatchRun } from "../../src/application/runDispatch.js";
import { continueRun } from "../../src/application/runContinue.js";
import { runConsult } from "../../src/application/consultService.js";
import { retryCommand } from "../../src/commands/lifecycle.js";

// ===== 夹具 =====

const T0 = Date.parse("2026-11-24T10:00:00.000Z");
const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const jsonl = (events) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;

const ALPHA = { slug: "alpha-11111111", name: "alpha", key: "D:\\repos\\alpha" };
const BETA = { slug: "beta-22222222", name: "beta project", key: "D:\\repos\\beta" };
const CWD = "D:\\repos\\alpha";
/** 派发事实里的绝对路径全集——任何一个出现在快照字符串里都算泄漏。 */
const PRIVATE_PATHS = [ALPHA.key, BETA.key, CWD];

const projectFact = (p) => ({ kind: "project", rulesVersion: "td190-r3", key: p.key, bucket: p.slug });
const SCRATCH_FACT = { kind: "scratch", rulesVersion: "td190-r3", key: "_scratch" };
const SANDBOX_FACT = {
  kind: "sandbox", rulesVersion: "td190-r3", key: "_sandbox", harness: "codex", worktreeName: "wt", repoHint: "repo",
};

function makeStore() {
  const base = mkdtempSync(join(tmpdir(), "wao-owner-read-model-"));
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
    lease(runId, body) {
      writeFileSync(join(runDir, `.owner-${runId}`), typeof body === "string" ? body : JSON.stringify(body), "utf8");
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

/** 派发头：background_submitted → pending → run.started → prompt.sent（都从 at 起算）。 */
function head(b, o = {}) {
  const at = o.at ?? T0;
  const prompt = o.prompt ?? "# 标准运行\n正文";
  const role = o.role === undefined ? "coder" : o.role;
  b.clock(at).add("run.background_submitted", {
    background: true,
    cwd: o.cwd ?? CWD,
    deliveryRequested: o.deliveryRequested ?? false,
    ...(o.project === null ? {} : { project: o.project ?? projectFact(ALPHA) }),
    ...(o.parentRunId ? { continuation: true, parentRunId: o.parentRunId, rootRunId: o.parentRunId } : {}),
  });
  b.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
  if (o.noStarted) return b;
  b.clock(at + 1000).add("run.started", {
    backend: "claude-code",
    cwd: o.cwd ?? CWD,
    model: { id: "glm-5.3" },
    providerKey: null,
    ...(o.worktreePath ? { worktreePath: o.worktreePath, worktreeBranch: `wao/${b.runId}` } : {}),
    ...(role ? {
      laneId: o.laneId ?? "glm-pro", roleId: role, resolvedFrom: "explicit",
      rolePin: { systemPrompt: `config/roles/${role}.md`, sha256: "a".repeat(64) },
    } : {}),
    ...(o.tags ? { tags: o.tags } : {}),
    ...(o.taskType !== undefined ? { taskType: o.taskType } : {}),
    ...(o.retryOf !== undefined ? { retryOf: o.retryOf } : {}),
  });
  if (o.noPrompt) return b;
  b.clock(at + 2000).add("prompt.sent", { prompt });
  return b;
}

/** worker 起跑：session.created → run.submitted → submitted → running（都不是实质动作）。 */
function working(b, { at }) {
  b.clock(at).add("session.created", { backend: "claude-code", backendSessionId: "proc_4242", serveUrl: null });
  b.add("run.submitted", {});
  b.add("run.state_change", { from: "pending", to: "submitted", reason: "spawned" });
  b.clock(at + 10).add("run.state_change", { from: "submitted", to: "running", reason: "first_event" });
}

function effect(b, { at }) {
  b.clock(at).add("run.event", { kind: "message", role: "assistant", parts: [{ type: "text", text: "done work" }] });
}

function runtimeActivity(b, { at, status = "process_active" }) {
  b.clock(at).add("run.event", { kind: "runtime_activity", status });
}

function terminal(b, { at, state = "completed" }) {
  const fact = { completed: "run.completed", failed: "run.error", aborted: "run.aborted" }[state];
  b.clock(at).add(fact, state === "failed" ? { phase: "wait", error: "boom" } : {});
  b.add("run.state_change", { from: "running", to: state, reason: state });
}

/** 一个 completed 的后台派发运行（项目桶内）。 */
function completedEvents(runId, o = {}) {
  const at = o.at ?? T0;
  const b = builder(runId);
  head(b, { at, ...o });
  working(b, { at: at + 3000 });
  effect(b, { at: at + 4000 });
  terminal(b, { at: at + 5000 });
  return b.events;
}

/** 一个在跑的运行：实质动作与 runtime_activity 的时刻由用例指定。 */
function runningEvents(runId, { submittedAt = NOW - 10 * 60_000, effectAt, activityAt, activityStatus } = {}) {
  const b = builder(runId);
  head(b, { at: submittedAt, prompt: "# 在跑" });
  working(b, { at: submittedAt + 1000 });
  if (effectAt !== undefined) effect(b, { at: effectAt });
  if (activityAt !== undefined) runtimeActivity(b, { at: activityAt, status: activityStatus });
  return b.events;
}

const runOf = (snapshot, runId) => {
  const run = snapshot.runs.find((r) => r.runId === runId);
  assert.ok(run, `快照里应有 ${runId}`);
  return run;
};

/** 计数的读模型 IO：readFile 逐路径记账，返回原始字节（与生产读法同形）。 */
function countingIo(extra = {}) {
  const reads = [];
  const io = {
    readFile: async (p) => {
      reads.push(p);
      return readFile(p);
    },
    ...extra,
  };
  return { io, reads };
}

// ===== 1. 冷普查与项目列表 =====

test("listProjectRecords：每个桶一条 { slug, displayName, reserved }，不带 key；特殊桶 reserved；记录损坏不抛", () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    mkdirSync(s.bucket("_sandbox"), { recursive: true });
    mkdirSync(s.bucket("broken-00000000"), { recursive: true });
    writeFileSync(join(s.bucket("broken-00000000"), ".project.json"), "{not json", "utf8");
    const records = listProjectRecords(s.runDir);
    assert.deepEqual(records, [
      { slug: "_sandbox", displayName: null, reserved: true },
      { slug: ALPHA.slug, displayName: ALPHA.name, reserved: false },
      { slug: "broken-00000000", displayName: null, reserved: false },
    ]);
    assert.ok(!JSON.stringify(records).includes("repos"), "项目记录里的 key 是绝对路径，不得外泄");
    // 空存储：没有桶就没有记录。
    assert.deepEqual(listProjectRecords(join(s.base, "nope")), []);
  } finally {
    s.cleanup();
  }
});

test("冷普查：项目桶、旧平铺、特殊桶全部入册；项目名来自 .project.json；快照只给 slug 与 name", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.writeProject(BETA);
    s.write(s.bucket(ALPHA.slug), "run_a1", completedEvents("run_a1"));
    s.write(s.bucket(BETA.slug), "run_b1", completedEvents("run_b1", { project: BETA }));
    s.write(s.bucket("_scratch"), "run_s1", completedEvents("run_s1", { project: SCRATCH_FACT }));
    s.write(s.bucket("_sandbox"), "run_x1", completedEvents("run_x1", { project: SANDBOX_FACT }));
    // 旧平铺：位置没有桶，归属只看运行自己的第一个项目事实。
    s.write(s.runDir, "run_flat1", completedEvents("run_flat1"));

    const model = createOwnerReadModel({ runDir: s.runDir });
    assert.deepEqual(model.snapshot({ now: NOW }), { generatedAt: iso(NOW), projects: [], runs: [], consults: [] }, "未 refresh 前是空快照");
    assert.equal(model.resolveRun("run_a1"), null, "首次 refresh 完成前一律 null（服务端要先等冷普查）");
    const result = await model.refresh();
    assert.deepEqual(result, { scanned: 5, reread: 5, added: 5, removed: 0, moved: 0, unreadable: 0 });
    const snap = model.snapshot({ now: NOW });
    assert.equal(snap.generatedAt, iso(NOW));
    assert.deepEqual(snap.consults, [], "没有会审组记录就没有会审");
    // 第 140b 批：项目多两键——仓库是否可观测、分支观测时刻。这些项目没有请求交付的运行，
    // 不枚举分支，所以是 unknown / 未观测。
    assert.deepEqual(snap.projects, [
      { slug: "_sandbox", name: null, repo: "unknown", branchesObservedAt: null },
      { slug: "_scratch", name: null, repo: "unknown", branchesObservedAt: null },
      { slug: ALPHA.slug, name: ALPHA.name, repo: "unknown", branchesObservedAt: null },
      { slug: BETA.slug, name: BETA.name, repo: "unknown", branchesObservedAt: null },
    ]);
    assert.deepEqual(snap.runs.map((r) => r.runId), ["run_a1", "run_b1", "run_flat1", "run_s1", "run_x1"], "按 runId 稳定排序");
    assert.deepEqual(runOf(snap, "run_a1").project, { slug: ALPHA.slug, name: ALPHA.name });
    assert.deepEqual(runOf(snap, "run_flat1").project, { slug: ALPHA.slug, name: ALPHA.name }, "平铺运行的项目来自事实里的 bucket");
    assert.deepEqual(runOf(snap, "run_b1").project, { slug: BETA.slug, name: BETA.name });
    assert.deepEqual(runOf(snap, "run_s1").project, { slug: "_scratch", name: null });
    assert.deepEqual(runOf(snap, "run_x1").project, { slug: "_sandbox", name: null });

    const a1 = runOf(snap, "run_a1");
    assert.equal(a1.availability, "ok");
    assert.equal(a1.agentId, "coder_hq");
    assert.equal(a1.laneId, "glm-pro");
    assert.equal(a1.roleId, "coder");
    assert.equal(a1.readOnly, false);
    assert.equal(a1.deliveryRequested, false);
    assert.equal(a1.state, "completed");
    assert.equal(a1.terminal, true);
    assert.equal(a1.startedAt, iso(T0 + 1000), "startedAt 取 run.started 自己的时间");
    assert.equal(a1.terminalAt, iso(T0 + 5000));
    assert.equal(a1.title, "标准运行");
    assert.equal(a1.titleBasis, "heading");
    assert.equal(a1.taskType, "code");
    assert.equal(a1.typeBasis, "role");
    assert.equal(a1.liveness, "terminal");
    assert.equal(a1.stage, "terminal");
    assert.equal(a1.lastEffectAt, iso(T0 + 4000));
    assert.equal(a1.quietSince, iso(T0 + 4000), "有过实质动作：静默起点就是最后一次动作");
    assert.equal(a1.retryOf, null);
    assert.equal(a1.parentRunId, null);

    // resolveRun：内部定位只给服务端，并带上 availability；特殊桶与平铺都定位得到。
    assert.deepEqual(model.resolveRun("run_a1"), {
      runId: "run_a1", availability: "ok", transcriptPath: join(s.bucket(ALPHA.slug), "run_a1.jsonl"), bucket: ALPHA.slug,
    });
    assert.deepEqual(model.resolveRun("run_flat1"), {
      runId: "run_flat1", availability: "ok", transcriptPath: join(s.runDir, "run_flat1.jsonl"), bucket: null,
    });
    assert.equal(model.resolveRun("run_nope"), null, "不在这个运行目录的枚举结果里 → null");
    assert.equal(model.resolveRun("../escape"), null, "非法 runId → null");
    assert.equal(model.resolveRun(42), null);
  } finally {
    s.cleanup();
  }
});

test("项目事实与位置不一致时以运行自己的事实为准；名字查不到就是 null，不编造", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    // 文件躺在 beta 目录，但事实说它属于 alpha；beta 桶没有 .project.json。
    mkdirSync(s.bucket(BETA.slug), { recursive: true });
    s.write(s.bucket(BETA.slug), "run_fact", completedEvents("run_fact"));
    // 平铺且第一个事件没有项目事实（更老的转录）。
    const b = builder("run_nofact");
    head(b, { project: null });
    terminal(b, { at: T0 + 3000 });
    s.write(s.runDir, "run_nofact", b.events);
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    assert.deepEqual(runOf(snap, "run_fact").project, { slug: ALPHA.slug, name: ALPHA.name });
    assert.deepEqual(runOf(snap, "run_nofact").project, null, "没有任何归属事实 → 不猜");
  } finally {
    s.cleanup();
  }
});

test("项目名进快照前过同一条安全链：脱敏、清控制字符、换行与制表符折成一个空格、限 80 字（.project.json 可手改）", async () => {
  const s = makeStore();
  try {
    const DIRTY = { slug: "dirty-66666666", name: "proj\u0007 ghp_abcdefghijklmnopqrstuvwxyz \u007f", key: "D:\\repos\\dirty" };
    const LONG = { slug: "long-77777777", name: "名".repeat(100), key: "D:\\repos\\long" };
    const FOLDED = { slug: "fold-99999999", name: "  my\t\tproject\n\n name \t", key: "D:\\repos\\fold" };
    // 两段"换行/制表符"被空格隔开：整个空白段只折成一个空格，不是两个。
    const SEGMENTS = { slug: "seg-aaaaaaaaaa", name: "alpha\r\n \t\r\nbeta", key: "D:\\repos\\seg" };
    s.writeProject(DIRTY);
    s.writeProject(LONG);
    s.writeProject(FOLDED);
    s.writeProject(SEGMENTS);
    s.write(s.bucket(DIRTY.slug), "run_d1", completedEvents("run_d1", { project: DIRTY }));
    s.write(s.bucket(LONG.slug), "run_l1", completedEvents("run_l1", { project: LONG }));
    s.write(s.bucket(FOLDED.slug), "run_f1", completedEvents("run_f1", { project: FOLDED }));
    s.write(s.bucket(SEGMENTS.slug), "run_seg", completedEvents("run_seg", { project: SEGMENTS }));
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    const names = Object.fromEntries(snap.projects.map((p) => [p.slug, p.name]));
    assert.equal(names[DIRTY.slug], "proj\uFFFD [REDACTED] \uFFFD", "秘密形状整段替换、控制字符替换");
    assert.equal(names[LONG.slug], `${"名".repeat(79)}…`);
    assert.equal(names[FOLDED.slug], "my project name", "换行、制表符连同两侧空白折成一个空格");
    assert.equal(runOf(snap, "run_d1").project.name, "proj\uFFFD [REDACTED] \uFFFD", "运行条目里的项目名同样加工过");
    assert.equal(runOf(snap, "run_f1").project.name, "my project name");
    assert.equal(names[SEGMENTS.slug], "alpha beta", "alpha\\r\\n \\t\\r\\nbeta：整个空白段折成一个空格");
    assert.equal(runOf(snap, "run_seg").project.name, "alpha beta");
    // 记录里没有名字 → null（listProjectRecords 原样给记录值；加工与"不编造"在读模型这层）。
    mkdirSync(s.bucket("noname-88888888"), { recursive: true });
    writeFileSync(join(s.bucket("noname-88888888"), ".project.json"), JSON.stringify({ key: "D:\\repos\\x", slug: "noname-88888888" }), "utf8");
    const again = createOwnerReadModel({ runDir: s.runDir });
    await again.refresh();
    assert.equal(again.snapshot({ now: NOW }).projects.find((p) => p.slug === "noname-88888888").name, null);
  } finally {
    s.cleanup();
  }
});

// ===== 2. 同一 runId 出现在两处 =====

test("同一 runId 两处且内容相同：去重为一个运行，定位取桶优先、字典序最小；不计 added 两次", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.writeProject(BETA);
    const events = completedEvents("run_dup");
    s.write(s.bucket(BETA.slug), "run_dup", events);
    s.write(s.bucket(ALPHA.slug), "run_dup", events);
    s.write(s.runDir, "run_dup", events);
    const model = createOwnerReadModel({ runDir: s.runDir });
    const result = await model.refresh();
    assert.equal(result.added, 1, "一个运行，不是三个");
    assert.equal(result.scanned, 3);
    assert.equal(result.reread, 3);
    const snap = model.snapshot({ now: NOW });
    assert.equal(snap.runs.length, 1);
    assert.equal(runOf(snap, "run_dup").availability, "ok");
    assert.deepEqual(model.resolveRun("run_dup"), {
      runId: "run_dup", availability: "ok",
      transcriptPath: join(s.bucket(ALPHA.slug), "run_dup.jsonl"), bucket: ALPHA.slug,
    }, "桶优先于平铺，桶之间取字典序最小");
  } finally {
    s.cleanup();
  }
});

test("同一 runId 两处且内容不同：conflict——快照里不可用、不选其一；conflict 消失后恢复", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.writeProject(BETA);
    s.write(s.bucket(ALPHA.slug), "run_tw", completedEvents("run_tw"));
    s.write(s.bucket(BETA.slug), "run_tw", completedEvents("run_tw", { project: BETA, prompt: "# 另一份内容" }));
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    let snap = model.snapshot({ now: NOW });
    const tw = runOf(snap, "run_tw");
    assert.equal(tw.availability, "conflict");
    assert.equal(tw.project, null, "两处可能属于不同项目 → 不选");
    assert.equal(tw.liveness, "unknown");
    assert.equal(tw.stage, "stage_unknown");
    assert.equal(tw.title, null);
    assert.equal(tw.state, null);
    assert.equal(model.resolveRun("run_tw"), null, "conflict 不给定位");

    // 两份改回相同 → 恢复可用（只重读改过的那一份）。
    const { io, reads } = countingIo();
    const model2 = createOwnerReadModel({ runDir: s.runDir, io });
    await model2.refresh();
    reads.length = 0;
    s.write(s.bucket(BETA.slug), "run_tw", completedEvents("run_tw"));
    await model2.refresh();
    assert.equal(reads.length, 1, "只有被改写的那一份重读");
    snap = model2.snapshot({ now: NOW });
    assert.equal(runOf(snap, "run_tw").availability, "ok");
    assert.deepEqual(model2.resolveRun("run_tw"), {
      runId: "run_tw", availability: "ok",
      transcriptPath: join(s.bucket(ALPHA.slug), "run_tw.jsonl"), bucket: ALPHA.slug,
    });

    // 删掉主位置那一份（alpha）：只剩 beta 那份——它上一轮刚被读过、内容与 alpha 相同，
    // 事实已经在索引里，所以这一轮不读任何文件也仍然可用。
    rmSync(join(s.bucket(ALPHA.slug), "run_tw.jsonl"));
    reads.length = 0;
    const again = await model2.refresh();
    assert.deepEqual(
      { added: again.added, removed: again.removed, moved: again.moved },
      { added: 0, removed: 0, moved: 0 },
      "少了一个孪生副本不算运行被删或被移",
    );
    assert.equal(reads.length, 0, "剩下的那份没变：不重读");
    snap = model2.snapshot({ now: NOW });
    assert.equal(runOf(snap, "run_tw").availability, "ok");
    assert.equal(model2.resolveRun("run_tw").bucket, BETA.slug);
  } finally {
    s.cleanup();
  }
});

test("同一 runId 两处、其中一份读不出：整份按读不到处理（不比内容就不择一），也不算 conflict；resolveRun 不给定位", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.writeProject(BETA);
    s.write(s.bucket(ALPHA.slug), "run_tu", completedEvents("run_tu"));
    mkdirSync(s.bucket(BETA.slug), { recursive: true });
    writeFileSync(join(s.bucket(BETA.slug), "run_tu.jsonl"), "{\"seq\":1,\"type\":\n", "utf8");
    const model = createOwnerReadModel({ runDir: s.runDir });
    const result = await model.refresh();
    assert.equal(result.unreadable, 1);
    const tu = runOf(model.snapshot({ now: NOW }), "run_tu");
    assert.equal(tu.availability, "unreadable");
    assert.equal(tu.liveness, "unknown");
    // 多个位置里有一份读不到：不给定位——服务端若只读那可读的一份，等于替它选了一边。
    assert.equal(model.resolveRun("run_tu"), null, "多副本里有一份读不到 → null");
  } finally {
    s.cleanup();
  }
});

test("按原始字节比内容：两份只在非法 UTF-8 字节上不同的副本是 conflict，不是同一份", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    mkdirSync(s.bucket(BETA.slug), { recursive: true });
    // 把标题里那个 "@" 换成一个非法的 UTF-8 字节：解码后都是 U+FFFD，字节不同。
    const text = jsonl(completedEvents("run_b1", { prompt: "# 标@题\n正文" }));
    const at = text.indexOf("@");
    assert.equal(at, text.lastIndexOf("@"), "夹具前提：@ 只出现一次");
    assert.ok(at > 0, "夹具前提：标题里确实有这个占位字符");
    const withByte = (byte) => Buffer.concat([
      Buffer.from(text.slice(0, at), "utf8"),
      Buffer.from([byte]),
      Buffer.from(text.slice(at + 1), "utf8"),
    ]);
    const a = join(s.bucket(ALPHA.slug), "run_b1.jsonl");
    const b = join(s.bucket(BETA.slug), "run_b1.jsonl");
    writeFileSync(a, withByte(0xff));
    writeFileSync(b, withByte(0xfe));
    assert.equal(withByte(0xff).length, withByte(0xfe).length, "夹具前提：两份字节数相同");
    assert.equal(withByte(0xff).toString("utf8"), withByte(0xfe).toString("utf8"), "夹具前提：解码成文本后逐字相同");

    const model = createOwnerReadModel({ runDir: s.runDir });
    const result = await model.refresh();
    assert.equal(result.unreadable, 0, "两份各自都读得出（只是内容不同）");
    const run = runOf(model.snapshot({ now: NOW }), "run_b1");
    assert.equal(run.availability, "conflict", "字节不同就是不同的两份");
    assert.equal(run.title, null);

    // 非法字节相同的两份 → 同一份（去重）。
    writeFileSync(b, withByte(0xff));
    await model.refresh();
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_b1").availability, "ok");
  } finally {
    s.cleanup();
  }
});

// ===== 3. 增量 =====

test("增量：只重读文件身份（大小、mtime、ctime、ino）有变化的文件；新增与删除各自计数", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const f1 = s.write(s.bucket(ALPHA.slug), "run_i1", completedEvents("run_i1"));
    const f2 = s.write(s.bucket(ALPHA.slug), "run_i2", completedEvents("run_i2"));
    const f3 = s.write(s.bucket(ALPHA.slug), "run_i3", completedEvents("run_i3"));
    const { io, reads } = countingIo();
    const model = createOwnerReadModel({ runDir: s.runDir, io });
    await model.refresh();
    assert.equal(reads.length, 3, "冷普查全读");

    // 什么都没变：一个都不重读。
    reads.length = 0;
    assert.deepEqual(await model.refresh(), { scanned: 3, reread: 0, added: 0, removed: 0, moved: 0, unreadable: 0 });
    assert.equal(reads.length, 0);

    // 追加一行（大小变）：只重读它，事实随之更新。
    await appendFile(f1, `${JSON.stringify({ seq: 99, ts: iso(T0 + 9000), type: "run.cleanup_done", runId: "run_i1", agentId: "coder_hq" })}\n`, "utf8");
    reads.length = 0;
    let result = await model.refresh();
    assert.equal(result.reread, 1);
    assert.deepEqual(reads, [f1]);
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_i1").terminalAt, iso(T0 + 5000), "终态之后追加的事件不改 terminalAt");

    // 同长度改写（大小不变，只动 mtime）：仍要重读，标题跟着变。
    const before = readFileSync(f2, "utf8");
    const after = before.replace("标准运行", "标准运走");
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before), "夹具前提：改写前后字节数相同");
    assert.notEqual(after, before);
    writeFileSync(f2, after, "utf8");
    utimesSync(f2, new Date(T0), new Date(NOW + 3_600_000));
    reads.length = 0;
    result = await model.refresh();
    assert.equal(result.reread, 1, "大小相同但 mtime 变了 → 重读");
    assert.deepEqual(reads, [f2]);
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_i2").title, "标准运走");

    // 新增一个运行。
    const f4 = s.write(s.bucket(ALPHA.slug), "run_i4", completedEvents("run_i4"));
    reads.length = 0;
    result = await model.refresh();
    assert.equal(result.added, 1);
    assert.equal(result.reread, 1);
    assert.deepEqual(reads, [f4]);
    assert.equal(model.snapshot({ now: NOW }).runs.length, 4);

    // 删除一个运行。
    rmSync(f3);
    result = await model.refresh();
    assert.equal(result.removed, 1);
    assert.equal(result.scanned, 3);
    assert.equal(model.snapshot({ now: NOW }).runs.length, 3);
    assert.equal(model.resolveRun("run_i3"), null);
  } finally {
    s.cleanup();
  }
});

test("增量：同长度改写后把 mtime 恢复成原值 → 下一轮仍然重读（文件身份含 ctime）", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const f1 = s.write(s.bucket(ALPHA.slug), "run_m1", completedEvents("run_m1"));
    // 先把 mtime 定成一个整数秒，后面才能逐纳秒恢复原值。
    const FIXED_SEC = Math.floor(T0 / 1000);
    utimesSync(f1, FIXED_SEC, FIXED_SEC);
    const fixed = statSync(f1, { bigint: true });
    assert.equal(fixed.mtimeNs, BigInt(FIXED_SEC) * 1_000_000_000n, "夹具前提：mtime 是整数秒");
    const { io, reads } = countingIo();
    const model = createOwnerReadModel({ runDir: s.runDir, io });
    await model.refresh();
    assert.equal(reads.length, 1);

    const before = readFileSync(f1, "utf8");
    const after = before.replace("标准运行", "标准运走");
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before), "夹具前提：改写前后字节数相同");
    writeFileSync(f1, after, "utf8");
    utimesSync(f1, FIXED_SEC, FIXED_SEC); // 把 mtime 恢复成原值
    const restored = statSync(f1, { bigint: true });
    assert.equal(restored.size, fixed.size, "夹具前提：大小没变");
    assert.equal(restored.mtimeNs, fixed.mtimeNs, "夹具前提：mtime 已逐纳秒恢复");
    assert.equal(restored.ino, fixed.ino, "夹具前提：还是同一个文件（ino 没变）");
    assert.notEqual(restored.ctimeNs, fixed.ctimeNs, "夹具前提：NTFS 的变更时间记下了这次改写");

    reads.length = 0;
    const result = await model.refresh();
    assert.equal(result.reread, 1, "大小、mtime、ino 都没变，靠 ctime 认出这次改写");
    assert.deepEqual(reads, [f1]);
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_m1").title, "标准运走", "事实跟着更新");
  } finally {
    s.cleanup();
  }
});

test("增量：移桶——同一 runId 换了位置算 moved，不算一删一增，项目与定位跟着变", async () => {
  const s = makeStore();
  try {
    s.writeProject(BETA);
    const b = builder("run_mv");
    head(b, { project: { ...projectFact(BETA), bucket: ALPHA.slug } });
    terminal(b, { at: T0 + 3000 });
    const flat = s.write(s.runDir, "run_mv", b.events);
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    assert.equal(model.resolveRun("run_mv").bucket, null);

    const moved = join(s.bucket(BETA.slug), "run_mv.jsonl");
    renameSync(flat, moved);
    const result = await model.refresh();
    assert.deepEqual(result, { scanned: 1, reread: 1, added: 0, removed: 0, moved: 1, unreadable: 0 });
    const snap = model.snapshot({ now: NOW });
    assert.equal(snap.runs.length, 1);
    assert.equal(runOf(snap, "run_mv").availability, "ok");
    assert.deepEqual(model.resolveRun("run_mv"), { runId: "run_mv", availability: "ok", transcriptPath: moved, bucket: BETA.slug });
  } finally {
    s.cleanup();
  }
});

test("增量：按批读取，批与批之间让出事件循环", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    for (let i = 1; i <= 5; i += 1) s.write(s.bucket(ALPHA.slug), `run_y${i}`, completedEvents(`run_y${i}`));
    // 全部同步兑现的 IO：没有显式让出，宏任务一次都轮不到。stat 桩与生产同形（bigint）。
    const io = { readFile: async (p) => readFileSync(p), stat: async (p) => statSync(p, { bigint: true }) };
    const model = createOwnerReadModel({ runDir: s.runDir, batchSize: 2, io });
    // 探针：每次事件循环转到 check 阶段记一次；refresh 结束后停，免得它自己把进程吊住。
    let turns = 0;
    let probing = true;
    const probe = () => {
      if (!probing) return;
      turns += 1;
      setImmediate(probe);
    };
    setImmediate(probe);
    assert.equal(turns, 0);
    try {
      await model.refresh();
    } finally {
      probing = false;
    }
    // 5 个文件、每批 2 个：stat 与读取各 3 批，共 6 次让出。
    assert.ok(turns >= 6, `批间应让出事件循环（观察到 ${turns} 次）`);
  } finally {
    s.cleanup();
  }
});

test("并发 refresh 共用同一次普查：每个文件只读一次，两个调用方拿到同一份结果", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.write(s.bucket(ALPHA.slug), "run_c1", completedEvents("run_c1"));
    s.write(s.bucket(ALPHA.slug), "run_c2", completedEvents("run_c2"));
    const { io, reads } = countingIo();
    const model = createOwnerReadModel({ runDir: s.runDir, io });
    const [first, second] = await Promise.all([model.refresh(), model.refresh()]);
    assert.equal(first, second);
    assert.equal(reads.length, 2, "重叠的 refresh 不重复读文件");
    assert.equal(first.added, 2);
  } finally {
    s.cleanup();
  }
});

// ===== 4. 读不到 =====

test("读不到如实 unknown：完整行里的坏 JSON、空文件、非对象行、读失败各算一个 unreadable；修好后自愈", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const fBad = s.write(s.bucket(ALPHA.slug), "run_bad", completedEvents("run_bad"));
    writeFileSync(fBad, `${readFileSync(fBad, "utf8")}{"seq":99,"type":\n`, "utf8");
    const fEmpty = s.write(s.bucket(ALPHA.slug), "run_empty", []);
    const fNull = s.write(s.bucket(ALPHA.slug), "run_null", [null]);
    const fBusy = s.write(s.bucket(ALPHA.slug), "run_busy", completedEvents("run_busy"));
    s.write(s.bucket(ALPHA.slug), "run_ok", completedEvents("run_ok"));
    let failBusy = true;
    const { io } = countingIo({
      readFile: async (p) => {
        if (p === fBusy && failBusy) throw Object.assign(new Error("EBUSY stub"), { code: "EBUSY" });
        return readFile(p);
      },
    });
    const model = createOwnerReadModel({ runDir: s.runDir, io });
    let result = await model.refresh();
    assert.equal(result.unreadable, 4);
    assert.equal(result.added, 5, "读不到的运行同样入册（它在枚举结果里）");
    let snap = model.snapshot({ now: NOW });
    for (const [runId, file] of [["run_bad", fBad], ["run_empty", fEmpty], ["run_null", fNull], ["run_busy", fBusy]]) {
      const run = runOf(snap, runId);
      assert.equal(run.availability, "unreadable", runId);
      assert.equal(run.liveness, "unknown", runId);
      assert.equal(run.stage, "stage_unknown", runId);
      assert.equal(run.stageSince, null, runId);
      assert.equal(run.state, null, runId);
      assert.equal(run.terminal, null, runId);
      assert.equal(run.title, null, runId);
      assert.equal(run.titleBasis, null, runId);
      assert.equal(run.taskType, null, runId);
      assert.equal(run.typeBasis, null, runId);
      assert.equal(run.quietSince, null, runId);
      assert.deepEqual(run.project, { slug: ALPHA.slug, name: ALPHA.name }, `${runId}：位置事实仍可用`);
      // 只有一个位置、读不到：定位照给并标明 availability（不是 conflict，服务端读它时自行得到读失败）。
      assert.deepEqual(model.resolveRun(runId), { runId, availability: "unreadable", transcriptPath: file, bucket: ALPHA.slug }, runId);
    }
    assert.equal(runOf(snap, "run_ok").availability, "ok");

    // 共享读失败过去后（stat 没变也要重试）：只重读它，恢复可用。
    failBusy = false;
    result = await model.refresh();
    assert.equal(result.unreadable, 3);
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_busy").availability, "ok");
  } finally {
    s.cleanup();
  }
});

test("未写完的尾行不算损坏：只解析到最后一个换行；写完后下一轮重读；完整行里的坏 JSON 仍按读不到", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const complete = jsonl(runningEvents("run_h1", { effectAt: NOW - 1000 }));
    const tail = JSON.stringify({
      seq: 99, ts: iso(NOW - 500), type: "run.event", runId: "run_h1", agentId: "coder_hq",
      kind: "message", role: "assistant", parts: [{ type: "text", text: "second effect" }],
    });
    const half = tail.slice(0, Math.floor(tail.length / 2));
    const f1 = join(s.bucket(ALPHA.slug), "run_h1.jsonl");
    mkdirSync(s.bucket(ALPHA.slug), { recursive: true });
    writeFileSync(f1, `${complete}${half}`, "utf8"); // 追加到一半就被读到：末尾是没有换行的半行
    // 对照：坏 JSON 在一个完整行里（有换行结尾）。
    const f2 = join(s.bucket(ALPHA.slug), "run_h2.jsonl");
    writeFileSync(f2, `${complete.replace(/run_h1/g, "run_h2")}{"seq":99,"type":\n`, "utf8");
    // 对照：整个文件只有半行、一个换行都没有。
    const f3 = join(s.bucket(ALPHA.slug), "run_h3.jsonl");
    writeFileSync(f3, tail.slice(0, 20), "utf8");

    const model = createOwnerReadModel({ runDir: s.runDir });
    let result = await model.refresh();
    assert.equal(result.unreadable, 2, "只有两条对照读不到；半行尾的那份可用");
    const h1 = runOf(model.snapshot({ now: NOW }), "run_h1");
    assert.equal(h1.availability, "ok");
    assert.equal(h1.lastEffectAt, iso(NOW - 1000), "事实只到完整行为止");
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_h2").availability, "unreadable");
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_h3").availability, "unreadable");

    // 那一行写完（文件身份随之变化）→ 重读，新事件生效。
    await appendFile(f1, `${tail.slice(Math.floor(tail.length / 2))}\n`, "utf8");
    result = await model.refresh();
    assert.equal(result.unreadable, 2, "两条对照仍然读不到");
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_h1").lastEffectAt, iso(NOW - 500));
  } finally {
    s.cleanup();
  }
});

test("CRLF 转录：截到最后一个换行（含）再解析，完整前缀不因孤立的 \\r 被判读不到", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const events = completedEvents("run_cr");
    // CRLF 行尾，末尾再跟一个空行，然后是追加到一半的半行。
    const complete = `${events.map((e) => JSON.stringify(e)).join("\r\n")}\r\n\r\n`;
    const half = JSON.stringify({
      seq: 99, ts: iso(T0 + 9000), type: "run.cleanup_done", runId: "run_cr", agentId: "coder_hq",
    }).slice(0, 12);
    writeFileSync(join(s.bucket(ALPHA.slug), "run_cr.jsonl"), `${complete}${half}`, "utf8");
    // 对照：同一组事件用 LF 落盘（只有 runId 不同）。
    s.write(s.bucket(ALPHA.slug), "run_cr_lf", events.map((e) => ({ ...e, runId: "run_cr_lf" })));
    // 夹具前提：readTranscript 读同一份完整前缀，每条都是事件，没有多出来的孤立行。
    const prefixFile = join(s.base, "prefix.jsonl");
    writeFileSync(prefixFile, complete, "utf8");
    assert.equal((await readTranscript(prefixFile)).length, events.length);

    const model = createOwnerReadModel({ runDir: s.runDir });
    const result = await model.refresh();
    assert.equal(result.unreadable, 0);
    const snap = model.snapshot({ now: NOW });
    const strip = (runId) => {
      // lineageRootRunId 是"自己的 runId"（普通运行自成一根），随 runId 走，一并剔掉。
      const { runId: omitted, lineageRootRunId: omittedRoot, ...rest } = runOf(snap, runId);
      assert.equal(omittedRoot, runId, `${runId}：普通运行的谱系根就是自己`);
      return rest;
    };
    assert.equal(runOf(snap, "run_cr").availability, "ok");
    assert.deepEqual(strip("run_cr"), strip("run_cr_lf"), "CRLF + 半行尾 与 同一组事件的 LF 版本得到同样的事实");
  } finally {
    s.cleanup();
  }
});

test("stat 失败（非 ENOENT）：计入 unreadable 且不去读内容；同一运行的另一份不会被当成唯一可用档", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.writeProject(BETA);
    const events = completedEvents("run_s1");
    const f1 = s.write(s.bucket(ALPHA.slug), "run_s1", events);
    const f2 = s.write(s.bucket(BETA.slug), "run_s1", events);
    const denied = new Set();
    const { io, reads } = countingIo({
      stat: async (p) => {
        if (denied.has(p)) throw Object.assign(new Error("EACCES stub"), { code: "EACCES" });
        return statSync(p, { bigint: true });
      },
    });
    const model = createOwnerReadModel({ runDir: s.runDir, io });
    denied.add(f1);
    let result = await model.refresh();
    assert.equal(result.unreadable, 1);
    assert.deepEqual(reads, [f2], "只读了 stat 成功的那一份；stat 失败的文件不去读内容");
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_s1").availability, "unreadable", "两处里有一处 stat 失败 → 不择一");
    assert.equal(model.resolveRun("run_s1"), null, "多副本里有一份读不到 → null");

    denied.clear();
    reads.length = 0;
    result = await model.refresh();
    assert.equal(result.unreadable, 0);
    assert.deepEqual(reads, [f1], "stat 恢复后只补读它");
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_s1").availability, "ok");
  } finally {
    s.cleanup();
  }
});

test("枚举失败：refresh 拒绝，上一份索引与快照原样保留，下一次 refresh 照常", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.write(s.bucket(ALPHA.slug), "run_keep", completedEvents("run_keep"));
    let broken = false;
    let sawStrict;
    const model = createOwnerReadModel({
      runDir: s.runDir,
      io: {
        listFiles: (dir, options) => {
          sawStrict = options?.strict;
          if (broken) throw Object.assign(new Error("EACCES stub"), { code: "EACCES" });
          return listTranscriptsDeep(dir, options);
        },
      },
    });
    await model.refresh();
    assert.equal(sawStrict, true, "读模型必须以严格模式枚举");
    const before = model.snapshot({ now: NOW });
    broken = true;
    await assert.rejects(() => model.refresh(), /EACCES stub/);
    // 第 140b 批唯一的例外：刷新失败后文件索引可能已经看不全，谱系两项按"无法判定"给出
    // （lineageUndeterminable 翻成 true）；其余事实原样保留。
    const during = model.snapshot({ now: NOW });
    assert.deepEqual(
      { ...during, runs: during.runs.map(({ lineageUndeterminable, ...rest }) => rest) },
      { ...before, runs: before.runs.map(({ lineageUndeterminable, ...rest }) => rest) },
      "失败的刷新不改已有快照",
    );
    assert.equal(runOf(during, "run_keep").lineageUndeterminable, true, "刷新失败 → 谱系按无法判定给");
    assert.equal(runOf(during, "run_keep").supersededByRunId, null);
    assert.deepEqual(model.resolveRun("run_keep").bucket, ALPHA.slug);
    broken = false;
    const result = await model.refresh();
    assert.deepEqual(result, { scanned: 1, reread: 0, added: 0, removed: 0, moved: 0, unreadable: 0 });
    assert.deepEqual(model.snapshot({ now: NOW }), before, "下一次刷新成功后快照完全恢复");
  } finally {
    s.cleanup();
  }
});

test("枚举用严格模式：一个桶 stat 失败时 refresh 拒绝、已有索引保留（宽举会漏掉这个桶，把剩下的副本当成唯一可用档）", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.writeProject(BETA);
    const events = completedEvents("run_st");
    const alphaCopy = s.write(s.bucket(ALPHA.slug), "run_st", events);
    s.write(s.bucket(BETA.slug), "run_st", events);
    // 让 BETA 桶的 stat 报权限错误——走 listTranscriptsDeep 自己的严格路径，不是桩出来的一次抛错。
    let denyBeta = false;
    const io = {
      listFiles: (dir, options) => listTranscriptsDeep(dir, {
        ...options,
        io: {
          statSync: (p, ...rest) => {
            if (denyBeta && p === s.bucket(BETA.slug)) throw Object.assign(new Error("EACCES stub"), { code: "EACCES" });
            return statSync(p, ...rest);
          },
        },
      }),
    };
    const model = createOwnerReadModel({ runDir: s.runDir, io });
    const first = await model.refresh();
    assert.equal(first.scanned, 2, "两处都枚举到");
    const before = model.snapshot({ now: NOW });
    assert.equal(runOf(before, "run_st").availability, "ok");
    assert.deepEqual(model.resolveRun("run_st"), { runId: "run_st", availability: "ok", transcriptPath: alphaCopy, bucket: ALPHA.slug });

    // BETA 那份被改得与 ALPHA 不同，同时 BETA 桶读不了。宽举会只看见 ALPHA（没变）→ 维持 ok；
    // 严格模式：枚举失败就拒绝，不拿看不全的结果下结论。
    s.write(s.bucket(BETA.slug), "run_st", completedEvents("run_st", { prompt: "# 被改过的副本" }));
    denyBeta = true;
    await assert.rejects(() => model.refresh(), /EACCES stub/);
    const during = model.snapshot({ now: NOW });
    // 谱系按无法判定给（第 140b 批）之外，失败的刷新不改已有快照。
    assert.deepEqual(
      { ...during, runs: during.runs.map(({ lineageUndeterminable, ...rest }) => rest) },
      { ...before, runs: before.runs.map(({ lineageUndeterminable, ...rest }) => rest) },
      "失败的刷新不改已有快照",
    );
    assert.equal(runOf(during, "run_st").lineageUndeterminable, true);

    denyBeta = false;
    const after = await model.refresh();
    assert.equal(after.reread, 1, "只重读被改过的那一份");
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_st").availability, "conflict");
    assert.equal(model.resolveRun("run_st"), null);
  } finally {
    s.cleanup();
  }
});

test("严格枚举不漏根层平铺档：根层读不出时 refresh 拒绝、旧索引保留（否则只剩桶里那份，conflict 会被看成 ok）", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    // 平铺档与桶档内容冲突：两处都看得见时是 conflict。
    s.write(s.runDir, "run_rf", completedEvents("run_rf"));
    s.write(s.bucket(ALPHA.slug), "run_rf", completedEvents("run_rf", { prompt: "# 桶里那份" }));
    // 复核席的探针形状：existsSync 对存储根返回 false（它对任何错误都如此），其余路径照常；
    // 根层 readdirSync 报权限错误。
    const deniedRootIo = () => ({
      existsSync: (p) => p !== s.runDir && existsSync(p),
      readdirSync: (p, ...rest) => {
        if (p === s.runDir) throw Object.assign(new Error("EACCES stub"), { code: "EACCES" });
        return readdirSync(p, ...rest);
      },
    });
    let rootDenied = false;
    const model = createOwnerReadModel({
      runDir: s.runDir,
      io: {
        listFiles: (dir, options) => listTranscriptsDeep(dir, { ...options, io: rootDenied ? deniedRootIo() : {} }),
      },
    });
    const first = await model.refresh();
    assert.equal(first.scanned, 2, "夹具前提：健康时平铺档与桶档都枚举到");
    const before = model.snapshot({ now: NOW });
    assert.equal(runOf(before, "run_rf").availability, "conflict", "夹具前提：内容冲突是 conflict");
    assert.equal(model.resolveRun("run_rf"), null);

    rootDenied = true;
    await assert.rejects(() => model.refresh(), /EACCES stub/);
    assert.deepEqual(model.snapshot({ now: NOW }), before, "失败的刷新不改已有快照：仍是 conflict");
    assert.equal(model.resolveRun("run_rf"), null, "没有把桶里那份当成唯一可用档");

    // 对照：同一个故障下，吞掉根层错误的枚举只看得到桶里那份（而且它没变）——
    // 读模型若照此下结论，就会从 conflict 变成 ok 并给出定位。所以严格模式必须拒绝。
    const swallowed = listTranscriptsDeep(s.runDir, { io: deniedRootIo() });
    assert.deepEqual(swallowed.map((e) => e.name), ["run_rf.jsonl"]);
  } finally {
    s.cleanup();
  }
});

test("运行目录不存在：按空存储处理（零个运行）；只枚举 run_ 转录", async () => {
  const s = makeStore();
  try {
    const model = createOwnerReadModel({ runDir: s.runDir });
    assert.deepEqual(await model.refresh(), { scanned: 0, reread: 0, added: 0, removed: 0, moved: 0, unreadable: 0 });
    assert.deepEqual(model.snapshot({ now: NOW }), { generatedAt: iso(NOW), projects: [], runs: [], consults: [] });
    // 非 run_ 前缀（legacy wf_* 工作流转录）与非法形状的文件名都不是运行。
    mkdirSync(s.runDir, { recursive: true });
    writeFileSync(join(s.runDir, "wf_legacy.jsonl"), "{}\n", "utf8");
    writeFileSync(join(s.runDir, "run_bad name.jsonl"), "{}\n", "utf8");
    writeFileSync(join(s.runDir, "notes.txt"), "x", "utf8");
    assert.deepEqual(await model.refresh(), { scanned: 0, reread: 0, added: 0, removed: 0, moved: 0, unreadable: 0 });
  } finally {
    s.cleanup();
  }
});

test("构造参数：缺 runDir 拒绝；snapshot 的 now 不是可表示的时刻抛 TypeError", async () => {
  assert.throws(() => createOwnerReadModel({}), /runDir/);
  assert.throws(() => createOwnerReadModel({ runDir: 42 }), /runDir/);
  const s = makeStore();
  try {
    const model = createOwnerReadModel({ runDir: s.runDir, nowFn: () => NOW });
    assert.equal(model.snapshot().generatedAt, iso(NOW), "不给 now 用注入的 nowFn");
    // now 不是可表示的时刻（非有限、超出 Date 范围、不是数）→ 调用方的错误，抛 TypeError。
    for (const bad of [NaN, Infinity, -Infinity, 1e20, -1e20, "2026-11-24", null]) {
      assert.throws(() => model.snapshot({ now: bad }), TypeError, `now=${String(bad)}`);
    }
    const brokenClock = createOwnerReadModel({ runDir: s.runDir, nowFn: () => 1e20 });
    assert.throws(() => brokenClock.snapshot(), TypeError, "注入的时钟返回表示不了的时刻同样拒绝");
    // 合法的 now：generatedAt 恒是字符串（包括 Date 范围的两端）。
    assert.equal(model.snapshot({ now: 0 }).generatedAt, "1970-01-01T00:00:00.000Z");
    assert.equal(typeof model.snapshot({ now: -8.64e15 }).generatedAt, "string");
    assert.equal(typeof model.snapshot({ now: 8.64e15 }).generatedAt, "string");
    assert.equal(typeof model.snapshot().generatedAt, "string");
  } finally {
    s.cleanup();
  }
});

// ===== 5. terminalAt =====

test("terminalAt 取终态事件自己的时间：终态之后再追加事件也不变；未终态为 null", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const b = builder("run_t1");
    head(b);
    working(b, { at: T0 + 3000 });
    effect(b, { at: T0 + 4000 });
    terminal(b, { at: T0 + 5000 });
    b.clock(T0 + 60_000).add("run.cleanup_done", {});
    b.clock(T0 + 120_000).add("acceptance.recorded", { decision: "accepted", reason: "ok", recordedBy: "lead", recordedAt: iso(T0 + 120_000), source: "lead" });
    s.write(s.bucket(ALPHA.slug), "run_t1", b.events);
    s.write(s.bucket(ALPHA.slug), "run_t2", runningEvents("run_t2", { effectAt: T0 + 4000 }));
    // 旧无信封转录：没有 state_change，状态由末事件推断。
    const legacy = builder("run_t3", { agentId: "coder_hq" });
    legacy.events.push(
      { seq: 1, ts: iso(T0), type: "run.started", agentId: "coder_hq", backend: "claude-code", cwd: CWD },
      { seq: 2, ts: iso(T0 + 4000), type: "run.completed", agentId: "coder_hq" },
    );
    s.write(s.runDir, "run_t3", legacy.events);
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    assert.equal(runOf(snap, "run_t1").terminalAt, iso(T0 + 5000), "不是最后一条事件的时间");
    assert.equal(runOf(snap, "run_t1").state, "completed");
    assert.equal(runOf(snap, "run_t2").terminalAt, null);
    assert.equal(runOf(snap, "run_t2").terminal, false);
    assert.equal(runOf(snap, "run_t3").state, "completed");
    assert.equal(runOf(snap, "run_t3").terminalAt, iso(T0 + 4000));
    assert.equal(runOf(snap, "run_t3").startedAt, iso(T0));
  } finally {
    s.cleanup();
  }
});

test("terminalAt 与 state 取同一条终态事件；终态之后出现的 run.state_change_rejected 不改 terminalAt", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const put = (runId, build) => {
      const b = builder(runId);
      build(b);
      return s.write(s.bucket(ALPHA.slug), runId, b.events);
    };
    // A：… → run.error@t1 → state_change(completed)@t2 → state_change_rejected@t3（前面还有 head()
    //    写下的受理与起跑事实，含一条 pending 转移）。state 是 completed，依据事件是 t2 那条
    //    转移，不是更早的 run.error。
    const fA = put("run_ta", (b) => {
      head(b);
      b.clock(T0 + 1000).add("run.error", { phase: "wait", error: "boom" });
      b.clock(T0 + 2000).add("run.state_change", { from: "running", to: "completed", reason: "completed" });
      b.clock(T0 + 3000).add("run.state_change_rejected", { attemptedTo: "failed", attemptedReason: "failed", existingTerminal: "completed" });
    });
    // B（旧档）：run.started → prompt.sent → run.error@t1 → run.completed@t2，全程没有任何
    // run.state_change（不经 head()——它会插进一条 pending 转移，测不到这个分支）。状态由
    // 末事件推断，依据事件就是末尾的 run.completed。
    const fB = put("run_tb", (b) => {
      b.add("run.started", { backend: "claude-code", cwd: CWD });
      b.add("prompt.sent", { prompt: "# 旧档" });
      b.clock(T0 + 1000).add("run.error", { phase: "wait", error: "boom" });
      b.clock(T0 + 2000).add("run.completed", {});
    });
    assert.equal(
      (await readTranscript(fB)).some((e) => e.type === "run.state_change"),
      false,
      "夹具前提：这条序列里没有任何状态转移",
    );
    // C：completed 之后又 failed（终态自相矛盾）。state 取最后一条转移（failed），时间也取它。
    put("run_tc", (b) => {
      head(b);
      terminal(b, { at: T0 + 3000 });
      b.clock(T0 + 4000).add("run.error", { phase: "wait", error: "boom" });
      b.add("run.state_change", { from: "running", to: "failed", reason: "failed" });
    });
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const pick = (snap, runId) => {
      const r = runOf(snap, runId);
      return { state: r.state, terminal: r.terminal, terminalAt: r.terminalAt };
    };
    let snap = model.snapshot({ now: NOW });
    assert.deepEqual(pick(snap, "run_ta"), { state: "completed", terminal: true, terminalAt: iso(T0 + 2000) });
    assert.deepEqual(pick(snap, "run_tb"), { state: "completed", terminal: true, terminalAt: iso(T0 + 2000) }, "没有状态转移的旧档：state 与 terminalAt 都取末尾的 run.completed");
    assert.deepEqual(pick(snap, "run_tc"), { state: "failed", terminal: true, terminalAt: iso(T0 + 4000) });

    // 终态之后再被拒绝的迟到转移：terminalAt 不变。
    await appendFile(fA, `${JSON.stringify({
      seq: 99, ts: iso(T0 + 9000), type: "run.state_change_rejected", runId: "run_ta", agentId: "coder_hq",
      attemptedTo: "aborted", attemptedReason: "user", existingTerminal: "completed",
    })}\n`, "utf8");
    await model.refresh();
    snap = model.snapshot({ now: NOW });
    assert.deepEqual(pick(snap, "run_ta"), { state: "completed", terminal: true, terminalAt: iso(T0 + 2000) });
  } finally {
    s.cleanup();
  }
});

test("findStateEvidence：状态与它依据的那条事件（findState 的判定正文，同源）", () => {
  const sc = (to) => ({ type: "run.state_change", to });
  const withTs = [sc("pending"), sc("completed")];
  const laterFact = [sc("pending"), sc("running"), { type: "run.stop_requested" }, { type: "run.completed" }];
  const noTransition = [{ type: "run.started" }, { type: "run.aborted" }];
  assert.deepEqual(findStateEvidence([]), { state: "pending", index: -1 }, "空序列：pending，没有依据事件");
  assert.deepEqual(findStateEvidence(withTs), { state: "completed", index: 1 }, "终态转移自己是依据");
  assert.deepEqual(findStateEvidence([sc("running")]), { state: "running", index: 0 });
  assert.deepEqual(findStateEvidence(laterFact), { state: "completed", index: 3 }, "非终态转移之后的终态事实是依据；stop_requested 只是意图，跳过");
  assert.deepEqual(findStateEvidence(noTransition), { state: "aborted", index: 1 }, "没有 state_change → 末事件");
  assert.deepEqual(findStateEvidence([{ type: "workflow.completed", completed: false }]), { state: "failed", index: 0 });
  for (const events of [withTs, laterFact, noTransition, []]) {
    assert.equal(findState(events), findStateEvidence(events).state, "findState 与 findStateEvidence 同源");
  }
});

// ===== 6. 活性 =====

test("活性常量导出且值固定；闭集导出", () => {
  assert.equal(OWNER_PROGRESS_WINDOW_SECONDS, 300);
  assert.equal(OWNER_PROCESS_WINDOW_SECONDS, 120);
  assert.equal(OWNER_TITLE_MAX_CHARS, 80);
  assert.deepEqual(OWNER_LIVENESS_VALUES, ["terminal", "progress", "process_only", "silent", "unknown"]);
  assert.deepEqual(OWNER_STAGE_VALUES, ["starting", "active", "terminal", "stage_unknown"]);
  assert.deepEqual(OWNER_TASK_TYPES, ["research", "code", "test", "plan_review", "delivery_review", "image", "untyped"]);
});

test("活性：terminal / progress / process_only / silent 四值与两个窗口的边界（同一个注入 now）", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const P = OWNER_PROGRESS_WINDOW_SECONDS * 1000;
    const Q = OWNER_PROCESS_WINDOW_SECONDS * 1000;
    const seed = (runId, opts) => s.write(s.bucket(ALPHA.slug), runId, runningEvents(runId, opts));
    seed("run_fresh", { effectAt: NOW - P });
    seed("run_edge", { effectAt: NOW - P - 1 });
    seed("run_proc", { effectAt: NOW - 400_000, activityAt: NOW - Q });
    seed("run_proc_edge", { effectAt: NOW - 400_000, activityAt: NOW - Q - 1 });
    seed("run_quiet", { effectAt: NOW - 400_000 });
    // 实质动作在窗口内时，进程体征无关紧要：progress 优先。
    seed("run_both", { effectAt: NOW - 1000, activityAt: NOW - 1000 });
    const done = builder("run_done");
    head(done);
    working(done, { at: T0 + 1000 });
    effect(done, { at: T0 + 2000 });
    terminal(done, { at: T0 + 3000 });
    s.write(s.bucket(ALPHA.slug), "run_done", done.events);

    const model = createOwnerReadModel({ runDir: s.runDir, nowFn: () => NOW });
    await model.refresh();
    const snap = model.snapshot();
    const liveness = Object.fromEntries(snap.runs.map((r) => [r.runId, r.liveness]));
    assert.deepEqual(liveness, {
      run_done: "terminal",
      run_fresh: "progress",
      run_edge: "silent",
      run_proc: "process_only",
      run_proc_edge: "silent",
      run_quiet: "silent",
      run_both: "progress",
    });
    assert.equal(runOf(snap, "run_fresh").lastEffectAt, iso(NOW - P));
    assert.equal(runOf(snap, "run_proc").lastEffectAt, iso(NOW - 400_000));
    assert.equal(runOf(snap, "run_proc").lastProcessActiveAt, iso(NOW - Q));
    assert.equal(runOf(snap, "run_quiet").lastProcessActiveAt, null, "没有 runtime_activity 就是 null");

    // 换一个 now 重算：时效结论不进缓存。
    const later = model.snapshot({ now: NOW + P + 1 });
    assert.equal(runOf(later, "run_fresh").liveness, "silent");
    assert.equal(later.generatedAt, iso(NOW + P + 1));
    // 时钟回拨（事件时间在未来）钳成 0，不因此判静默。
    const earlier = model.snapshot({ now: NOW - P - 60_000 });
    assert.equal(runOf(earlier, "run_edge").liveness, "progress");
  } finally {
    s.cleanup();
  }
});

test("活性：心跳租约恰好 120 秒仍算 process_only、120 秒加 1 毫秒不算；坏租约、没有租约都不算", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const Q = OWNER_PROCESS_WINDOW_SECONDS * 1000;
    const seed = (runId, opts) => s.write(s.bucket(ALPHA.slug), runId, runningEvents(runId, opts));
    seed("run_lease", { effectAt: NOW - 400_000 });
    seed("run_lease_120s", { effectAt: NOW - 400_000 });
    seed("run_lease_over", { effectAt: NOW - 400_000 });
    seed("run_lease_bad", { effectAt: NOW - 400_000 });
    seed("run_no_lease", { effectAt: NOW - 400_000 });
    const lease = (runId, heartbeatAt) => s.lease(runId, { pid: 4242, heartbeatAt, claimedAt: iso(NOW), nonce: "n" });
    lease("run_lease", NOW - 60_000);
    lease("run_lease_120s", NOW - Q);
    lease("run_lease_over", NOW - Q - 1);
    s.lease("run_lease_bad", "{not json");
    // 终态运行即使留着新鲜租约也是 terminal。
    lease("run_done", NOW);
    s.write(s.bucket(ALPHA.slug), "run_done", completedEvents("run_done", { at: T0 }));

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    const liveness = Object.fromEntries(snap.runs.map((r) => [r.runId, r.liveness]));
    assert.deepEqual(liveness, {
      run_lease: "process_only",
      run_lease_120s: "process_only",
      run_lease_over: "silent",
      run_lease_bad: "silent",
      run_no_lease: "silent",
      run_done: "terminal",
    });
    assert.equal(runOf(snap, "run_lease").lastVitalAt, iso(NOW - 60_000), "lastVitalAt 取事件与心跳里较晚的");
    assert.equal(runOf(snap, "run_lease_over").lastVitalAt, iso(NOW - Q - 1), "过期心跳仍是最后一次体征，照实给");
    assert.equal(runOf(snap, "run_lease_bad").lastVitalAt, iso(NOW - 400_000), "坏租约不提供体征，只剩事件");

    // 租约是活的：不 refresh、只换 now 也按当下读数算。
    lease("run_lease", NOW + 500_000);
    const again = model.snapshot({ now: NOW + 500_001 });
    assert.equal(runOf(again, "run_lease").liveness, "process_only");
    assert.equal(runOf(again, "run_lease").lastVitalAt, iso(NOW + 500_000));
  } finally {
    s.cleanup();
  }
});

test("坏租约不能让整个快照抛错：超出可表示范围的心跳按“没有这项体征”处理", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const seed = (runId) => s.write(s.bucket(ALPHA.slug), runId, runningEvents(runId, { effectAt: NOW - 400_000 }));
    seed("run_huge");
    seed("run_huge_neg");
    seed("run_inf");
    seed("run_ok_lease");
    s.lease("run_huge", { pid: 4242, heartbeatAt: 1e20, claimedAt: iso(NOW), nonce: "n" });
    s.lease("run_huge_neg", { pid: 4242, heartbeatAt: -1e20, claimedAt: iso(NOW), nonce: "n" });
    // JSON 文本里的 1e400 解析成 Infinity：readOwnerLease 判它不是合法租约。
    s.lease("run_inf", `{"pid":4242,"heartbeatAt":1e400,"claimedAt":"${iso(NOW)}","nonce":"n"}`);
    s.lease("run_ok_lease", { pid: 4242, heartbeatAt: NOW - 1000, claimedAt: iso(NOW), nonce: "n" });

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW }); // 旧实现在这里抛 RangeError
    for (const runId of ["run_huge", "run_huge_neg", "run_inf"]) {
      const run = runOf(snap, runId);
      assert.equal(run.liveness, "silent", `${runId}：表示不了的心跳不算体征`);
      assert.equal(run.lastVitalAt, iso(NOW - 400_000), `${runId}：只剩事件里的体征`);
    }
    assert.equal(runOf(snap, "run_ok_lease").liveness, "process_only", "同一份快照里合法心跳照常生效");
    assert.equal(runOf(snap, "run_ok_lease").lastVitalAt, iso(NOW - 1000));
  } finally {
    s.cleanup();
  }
});

test("活性口径：progress 只认实质动作——从未有动作时 lastEffectAt 为 null、quietSince 从 run.submitted 起算；thinking 只算体征", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const fresh = runningEvents("run_new", { submittedAt: NOW - 10_000 });
    s.write(s.bucket(ALPHA.slug), "run_new", fresh);
    const b = builder("run_think");
    head(b, { at: NOW - 700_000, prompt: "# 思考" });
    working(b, { at: NOW - 700_000 + 1000 });
    effect(b, { at: NOW - 600_000 });
    b.clock(NOW - 30_000).add("run.event", { kind: "thinking" });
    s.write(s.bucket(ALPHA.slug), "run_think", b.events);
    // 连 run.submitted 都没有（卡在 pending、从未派出去）：从第一条带 ts 的事件起算。
    const pending = builder("run_pending");
    head(pending, { at: NOW - 5000 });
    s.write(s.bucket(ALPHA.slug), "run_pending", pending.events);

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    let snap = model.snapshot({ now: NOW });
    const freshRun = runOf(snap, "run_new");
    assert.equal(freshRun.liveness, "silent", "刚派出去 10 秒、什么都没做、又没有进程体征或租约：不算有进展");
    assert.equal(freshRun.lastEffectAt, null, "没有实质动作就是 null，不拿 run.submitted 冒充");
    assert.equal(freshRun.quietSince, iso(NOW - 10_000 + 1000), "静默起点 = run.submitted 的时刻");
    const pendingRun = runOf(snap, "run_pending");
    assert.equal(pendingRun.lastEffectAt, null);
    assert.equal(pendingRun.quietSince, iso(NOW - 5000), "没有 run.submitted → 第一条带 ts 的事件");
    const think = runOf(snap, "run_think");
    assert.equal(think.liveness, "silent", "thinking 不是实质动作，也不是进程在动的观测，又没有租约");
    assert.equal(think.lastEffectAt, iso(NOW - 600_000));
    assert.equal(think.quietSince, iso(NOW - 600_000), "有过实质动作：静默起点就是它");
    assert.equal(think.lastVitalAt, iso(NOW - 30_000), "任何一条 run.event 都算体征");
    assert.equal(think.lastProcessActiveAt, null);

    // 没有实质动作但有新鲜租约 → process_only（"其余判定不变"）；一旦有了动作 → progress。
    s.lease("run_new", { pid: 4242, heartbeatAt: NOW - 1000, claimedAt: iso(NOW), nonce: "n" });
    assert.equal(runOf(model.snapshot({ now: NOW }), "run_new").liveness, "process_only");
    await appendFile(join(s.bucket(ALPHA.slug), "run_new.jsonl"), `${JSON.stringify({
      seq: 99, ts: iso(NOW - 500), type: "run.event", runId: "run_new", agentId: "coder_hq", kind: "command", command: "npm test", exitCode: 0,
    })}\n`, "utf8");
    await model.refresh();
    snap = model.snapshot({ now: NOW });
    assert.equal(runOf(snap, "run_new").liveness, "progress");
    assert.equal(runOf(snap, "run_new").lastEffectAt, iso(NOW - 500));
  } finally {
    s.cleanup();
  }
});

test("secondsSinceLastEffect 的回退口径：末条实质动作的 ts 为 null / 缺席 → 回退到 run.submitted（或首个字符串时间戳）；不可解析的非空值 → null", () => {
  const now = T0 + 100_000;
  const submittedAt = iso(T0 + 1000);
  const effectWith = (extra) => [
    { type: "run.submitted", ts: submittedAt },
    { type: "run.event", kind: "command", ...extra },
  ];
  // ts: null 与缺席：和"没有动作"一样，从 run.submitted 起算 → (100000 - 1000) / 1000 = 99 秒。
  assert.equal(secondsSinceLastEffect(effectWith({ ts: null }), now), 99, "ts: null → 回退到 run.submitted");
  assert.equal(secondsSinceLastEffect(effectWith({}), now), 99, "ts 缺席 → 回退到 run.submitted");
  // 不可解析的非空值：不回退，无法观测 → null。
  assert.equal(secondsSinceLastEffect(effectWith({ ts: "not-a-date" }), now), null, "不可解析 → null");
  // 连 run.submitted 都没有：从首条带字符串 ts 的事件起算 → (100000 - 2000) / 1000 = 98 秒。
  assert.equal(secondsSinceLastEffect([
    { type: "run.started", ts: iso(T0 + 2000) },
    { type: "run.event", kind: "message", ts: null },
  ], now), 98, "没有 run.submitted → 首个字符串时间戳");
  // 对照：正常的动作时间戳直接用它 → (100000 - 60000) / 1000 = 40 秒。
  assert.equal(secondsSinceLastEffect(effectWith({ ts: iso(T0 + 60_000) }), now), 40);
});

// ===== 7. 阶段 =====

test("stage：accepted 与 spawned 显示 starting；active、terminal 照实；没有绑定的阶段依据时 stage_unknown 且不给起点", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const accepted = builder("run_acc");
    head(accepted, { at: NOW - 5000, noStarted: true, noPrompt: true });
    s.write(s.bucket(ALPHA.slug), "run_acc", accepted.events);
    const spawned = builder("run_spw");
    head(spawned, { at: NOW - 5000 });
    s.write(s.bucket(ALPHA.slug), "run_spw", spawned.events);
    const active = builder("run_act");
    head(active, { at: NOW - 5000 });
    working(active, { at: NOW - 4000 });
    runtimeActivity(active, { at: NOW - 3000, status: "streaming" });
    s.write(s.bucket(ALPHA.slug), "run_act", active.events);
    s.write(s.bucket(ALPHA.slug), "run_fin", completedEvents("run_fin"));
    // pending 且没有任何绑定的阶段依据：文件里的阶段事实全属于别的 run。
    const foreign = builder("run_nb1");
    head(foreign);
    for (const event of foreign.events) event.runId = "run_other";
    s.write(s.bucket(ALPHA.slug), "run_nb1", foreign.events);
    // pending 且只有状态转移与 prompt（没有受理/起跑事实）。
    const bare = builder("run_nb2");
    bare.add("run.state_change", { from: null, to: "pending", reason: "created" });
    bare.add("prompt.sent", { prompt: "# 没有阶段依据" });
    s.write(s.bucket(ALPHA.slug), "run_nb2", bare.events);
    // 终态自相矛盾（completed 之后又 failed）：阶段不选边。
    const clash = builder("run_nb3");
    head(clash);
    terminal(clash, { at: T0 + 3000 });
    clash.clock(T0 + 4000).add("run.error", { phase: "wait", error: "boom" });
    clash.add("run.state_change", { from: "running", to: "failed", reason: "failed" });
    s.write(s.bucket(ALPHA.slug), "run_nb3", clash.events);

    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    const pick = (runId) => {
      const r = runOf(snap, runId);
      return { state: r.state, stage: r.stage, stageSince: r.stageSince };
    };
    assert.deepEqual(pick("run_acc"), { state: "pending", stage: "starting", stageSince: iso(NOW - 5000) });
    assert.deepEqual(pick("run_spw"), { state: "pending", stage: "starting", stageSince: iso(NOW - 5000 + 1000) });
    assert.deepEqual(pick("run_act"), { state: "running", stage: "active", stageSince: iso(NOW - 3000) });
    assert.deepEqual(pick("run_fin"), { state: "completed", stage: "terminal", stageSince: iso(T0 + 5000) });
    assert.deepEqual(pick("run_nb1"), { state: "pending", stage: "stage_unknown", stageSince: null });
    assert.deepEqual(pick("run_nb2"), { state: "pending", stage: "stage_unknown", stageSince: null });
    assert.deepEqual(pick("run_nb3"), { state: "failed", stage: "stage_unknown", stageSince: null });
    // 阶段不选边，但 state 与 terminalAt 照 findState 的口径如实给（最后一条转移）。
    assert.equal(runOf(snap, "run_nb3").terminalAt, iso(T0 + 4000));
    assert.equal(runOf(snap, "run_nb1").title, null, "别的事件同样不采信");
  } finally {
    s.cleanup();
  }
});

// ===== 8. 标题 =====

test("标题：取第一个非空行（跳过代码围栏与分隔线）；这一行是 ATX 标题就去掉 # 记号，否则原样；都没有为 null", () => {
  const facts = deriveOwnerTitleFacts;
  assert.deepEqual(facts("# 修登录崩溃\n\n正文"), { title: "修登录崩溃", titleBasis: "heading" });
  assert.deepEqual(facts("## 二级标题 ##"), { title: "二级标题", titleBasis: "heading" });
  assert.deepEqual(facts("   ### 前面有三个空格   \n正文"), { title: "前面有三个空格", titleBasis: "heading" });
  // 第一个非空行不是标题：就取它；后面的标题不抢。
  assert.deepEqual(facts("交付合同第一行\n\n# 才是标题\n\n## 后面的标题"), { title: "交付合同第一行", titleBasis: "first_line" });
  assert.deepEqual(facts("修登录崩溃\n\n## 背景\n\n### 细节"), { title: "修登录崩溃", titleBasis: "first_line" });
  // 跳过：空行、代码围栏（``` / ~~~，带不带信息串）、分隔线（--- *** ___，含中间带空格的写法）。
  for (const structural of ["```", "````", "~~~", "```js", "---", "***", "___", "- - -", "*  *  *", "   ---   "]) {
    assert.deepEqual(facts(`\n${structural}\n\n真正的第一行\n`), { title: "真正的第一行", titleBasis: "first_line" }, JSON.stringify(structural));
  }
  assert.deepEqual(facts("---\n\n# 分隔线之后的标题\n"), { title: "分隔线之后的标题", titleBasis: "heading" });
  // 不是标题的 # 行：井号后没有空白、七个井号、缩进四格（代码块）。
  for (const text of ["####没有空格", "#5 螺栓松了", "####### 七个井号", "    # 缩进代码块"]) {
    assert.deepEqual(facts(`${text}\n正文`), { title: text.trim(), titleBasis: "first_line" }, text);
  }
  // 只有 # 记号的空标题不出标题，继续往下取。
  assert.deepEqual(facts("##\n正文第一行\n"), { title: "正文第一行", titleBasis: "first_line" });
  // 单独的 \r 也是行界（与 \r\n、\n 一视同仁）。
  assert.deepEqual(facts("Run 1\rRun 2"), { title: "Run 1", titleBasis: "first_line" });
  assert.deepEqual(facts("Run 1\r\rRun 2"), { title: "Run 1", titleBasis: "first_line" }, "连续的 \r 之间是空行");
  assert.deepEqual(facts("\r\rRun 1\r\nRun 2"), { title: "Run 1", titleBasis: "first_line" }, "开头是空的 \r 行");
  assert.deepEqual(facts("# 标题\r正文"), { title: "标题", titleBasis: "heading" });
  assert.deepEqual(facts("---\r```js\r真实第一行"), { title: "真实第一行", titleBasis: "first_line" });
  // 围栏按 CommonMark：反引号围栏的信息串里不能再有反引号——下面这一行是正文（行内代码），
  // 不是围栏，它就是标题。
  assert.deepEqual(
    facts("```git status``` is the first step\n\nmore"),
    { title: "```git status``` is the first step", titleBasis: "first_line" },
  );
  assert.deepEqual(
    facts("```js const x = `1`\nmore"),
    { title: "```js const x = `1`", titleBasis: "first_line" },
    "信息串里出现了反引号 → 不是围栏",
  );
  // 信息串里没有反引号的仍是围栏：跳过。
  assert.deepEqual(facts("``` git status\nmore"), { title: "more", titleBasis: "first_line" }, "围栏后有空格再跟信息串");
  assert.deepEqual(facts("````js\nmore"), { title: "more", titleBasis: "first_line" }, "四个反引号起头也是围栏");
  // 波浪号围栏的信息串不受这个限制（可以带反引号或波浪号）。
  assert.deepEqual(facts("~~~git status~~~ is fine\nmore"), { title: "more", titleBasis: "first_line" });
  assert.deepEqual(facts("~~~ `code` ~~~\nmore"), { title: "more", titleBasis: "first_line" });
  assert.deepEqual(facts("\n\n   \n第一行\t\n第二行\n"), { title: "第一行", titleBasis: "first_line" }, "跳过空行、去掉首尾空白");
  assert.deepEqual(facts("只有一行"), { title: "只有一行", titleBasis: "first_line" });
  // 只有结构行或空白 → none。
  for (const none of ["---\n\n```\n", "```\n", "~~~\n---\n", "   \n\t\n"]) {
    assert.deepEqual(facts(none), { title: null, titleBasis: "none" }, JSON.stringify(none));
  }
  for (const empty of [null, undefined, "", 42, { prompt: "x" }, ["# 数组"]]) {
    assert.equal(deriveOwnerTitle(empty), null, `非字符串或空白：${JSON.stringify(empty) ?? String(empty)}`);
    assert.deepEqual(facts(empty), { title: null, titleBasis: "none" });
  }
  assert.equal(deriveOwnerTitle("# 纯函数入口"), "纯函数入口");
});

test("标题：会审席实际派发的 prompt（任务书 + 视角片段 + --- + 固定合同）→ 取任务书首行，不被视角里的标题或合同抢走", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-owner-rm-consult-title-"));
  try {
    const { calls, wrapped } = captureCall();
    const brief = "审查第 140a 批读模型的增量刷新，重点看文件身份。\n\n## Q1 是否只重读变化的文件？";
    await runConsult({
      briefText: brief,
      seats: [
        { agentId: "seat_a", perspectiveText: "## 视角：我认为应当拒收\n\n理由……" },
        { agentId: "seat_b" },
      ],
      registryPath: join(dir, "agents.json"),
      runDir: join(dir, "runs"),
      consultsDir: join(dir, "consults"),
      budgetFloorMs: 0,
      budgetMs: 0,
      env: {},
      nowFn: () => NOW,
      sleepFn: async () => {},
      idFn: () => "consult_20261124120000000ownrm0",
      dispatchFn: wrapped,
      registryReadFn: async () => ({ getAgent: () => { throw new Error("nope"); }, listAgents: () => [] }),
      readTranscriptFn: async () => { throw new Error("ENOENT stub"); },
      writeFileFn: async () => {},
      mkdirFn: async () => {},
      renameFn: async () => {},
      rmFn: async () => {},
    });
    const seatPrompt = calls.find((c) => c.agentId === "seat_a").prompt;
    assert.ok(seatPrompt.includes("\n\n---\n【会审席边界（固定合同，席位级）】"), "夹具前提：席位 prompt 是任务书 + 视角 + 分隔线 + 固定合同");
    assert.ok(seatPrompt.includes("## 视角：我认为应当拒收"), "夹具前提：视角片段确实拼在里面");
    // 任务书没有标题、视角里有标题：取任务书首行。
    const expected = { title: "审查第 140a 批读模型的增量刷新，重点看文件身份。", titleBasis: "first_line" };
    assert.deepEqual(deriveOwnerTitleFacts(seatPrompt), expected);
    // 没有视角片段的席位：同样取任务书首行，不落到任务书里的小节名或固定合同上。
    assert.deepEqual(deriveOwnerTitleFacts(calls.find((c) => c.agentId === "seat_b").prompt), expected);
    // 任务书首行本身是标题：取它（heading），而不是视角或后面的小节。
    assert.deepEqual(
      deriveOwnerTitleFacts("## Q1 读模型的增量刷新是否只重读变化的文件？\n\n背景……\n\n## 视角\n……\n\n---\n【会审席边界（固定合同，席位级）】你只负责逐问给出意见。"),
      { title: "Q1 读模型的增量刷新是否只重读变化的文件？", titleBasis: "heading" },
    );
    // 任务书以分隔线开头：跳过它，取第一行正文。
    assert.deepEqual(
      deriveOwnerTitleFacts("---\n审查读模型。\n\n---\n【会审席边界（固定合同，席位级）】你只负责逐问给出意见。"),
      { title: "审查读模型。", titleBasis: "first_line" },
    );
  } finally {
    rmrfRetry(dir);
  }
});

test("标题：先脱敏、再清控制字符、最后限 80 字——跨在截断点上的秘密形状不漏半截", () => {
  // 假令牌带 placeholder 字样（脱敏守卫认可的合法夹具写法）；sk- 后 20 位，够
  // redactSecretShapes 的 16 位下限。秘密形状前面要有词边界（紧贴字母的话规则不认）：
  // 69 个 x + 空格，秘密从第 70 字开始、到第 93 字结束。
  const secret = "sk-placeholder0123456789";
  const straddling = `# ${"x".repeat(69)} ${secret}`;
  const out = deriveOwnerTitle(straddling);
  assert.equal(out, `${"x".repeat(69)} [REDACTED]`, "先脱敏后截断：整段换成 [REDACTED]，总长恰 80");
  assert.ok(!out.includes("sk-"), "没有半截秘密");
  // 反面对照：同一段文本若先截到 80 字再脱敏，秘密只剩开头几位、不足规则的 16 位下限，
  // 规则不命中，半截会原样漏出来——所以上面那条断言确实能证伪"顺序写反"。
  const leaked = secret.slice(0, OWNER_TITLE_MAX_CHARS - ("x".repeat(69) + " ").length);
  assert.ok(leaked.length > 0 && leaked.length < 16, `夹具前提：截断后剩 ${JSON.stringify(leaked)}，不足 16 位`);
  const wrongOrder = redactSecretShapes(straddling.slice(2).slice(0, OWNER_TITLE_MAX_CHARS));
  assert.ok(wrongOrder.endsWith(leaked), "先截断再脱敏 → 半截秘密漏出");
  // 另几种形状。
  assert.equal(deriveOwnerTitle("# 用 ghp_abcdefghijklmnopqrstuvwxyz 部署"), "用 [REDACTED] 部署");
  assert.equal(deriveOwnerTitle("# curl -u admin:hunter22 https://x"), "curl -u admin:[REDACTED] https://x");
  assert.equal(deriveOwnerTitle("Authorization: Bearer q9w8e7r6t5y4u3i2o1p0"), "Authorization: Bearer [REDACTED]");
});

test("标题：控制字符清掉、制表符折成一个空格；限 80 字且超长加 …，不切开代理对", () => {
  const dirty = "# 标题\u0000带\u001b[31m颜色\u0007与\u007f制表\t符";
  const cleaned = deriveOwnerTitle(dirty);
  assert.equal(cleaned, "标题\uFFFD带\uFFFD[31m颜色\uFFFD与\uFFFD制表 符", "控制字符替换成 U+FFFD，TAB 折成一个空格");
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(cleaned), "不再有任何控制字符（TAB 也已折成空格）");
  assert.equal(deriveOwnerTitle("# 制表\t\t符 与   多   空格"), "制表 符 与   多   空格", "只折换行与制表符，普通空格原样");
  // 空格、制表符连成的一整段只折成一个空格（不是每个制表符各折一个）。
  assert.equal(deriveOwnerTitle("# a \t\t b"), "a b");
  assert.equal(deriveOwnerTitle("a\t \t b\tc"), "a b c");
  assert.equal(OWNER_TITLE_MAX_CHARS, 80);
  assert.equal(deriveOwnerTitle(`# ${"a".repeat(80)}`).length, 80, "恰 80 字原样");
  assert.ok(!deriveOwnerTitle(`# ${"a".repeat(80)}`).endsWith("…"));
  const long = deriveOwnerTitle(`# ${"a".repeat(81)}`);
  assert.equal(long, `${"a".repeat(79)}…`, "81 字 → 79 字加省略号，帽含省略号");
  assert.equal(deriveOwnerTitle(`# ${"中".repeat(100)}`), `${"中".repeat(79)}…`);
  const astral = deriveOwnerTitle(`# ${"a".repeat(78)}😀b`);
  assert.equal(astral, `${"a".repeat(78)}…`, "截断点落在代理对中间时整体让一格");
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(astral), "不留半个代理对");
});

test("标题：取最后一条绑定的 prompt.sent；外 run 的、非字符串的、没落盘的都不算", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const twice = builder("run_p2");
    head(twice, { prompt: "# 第一次投递" });
    twice.clock(T0 + 2500).add("prompt.sent", { messageId: "m1", admittedSeq: 3, prompt: "# 第二次投递" });
    twice.add("prompt.sent", { prompt: "# 外 run 追加" }, { runId: "run_other" });
    terminal(twice, { at: T0 + 3000 });
    s.write(s.bucket(ALPHA.slug), "run_p2", twice.events);
    const none = builder("run_p0");
    head(none, { noPrompt: true });
    terminal(none, { at: T0 + 3000 });
    s.write(s.bucket(ALPHA.slug), "run_p0", none.events);
    const bad = builder("run_p1");
    bad.add("run.started", { backend: "claude-code", cwd: CWD });
    bad.add("prompt.sent", { prompt: { not: "a string" } });
    terminal(bad, { at: T0 + 3000 });
    s.write(s.bucket(ALPHA.slug), "run_p1", bad.events);
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    assert.deepEqual([runOf(snap, "run_p2").title, runOf(snap, "run_p2").titleBasis], ["第二次投递", "heading"]);
    assert.deepEqual([runOf(snap, "run_p0").title, runOf(snap, "run_p0").titleBasis], [null, "none"]);
    assert.deepEqual([runOf(snap, "run_p1").title, runOf(snap, "run_p1").titleBasis], [null, "none"]);
  } finally {
    s.cleanup();
  }
});

// ===== 9. 任务类型：读侧判定 =====

test("类型判定顺序：固化值 > 显式标签 > 绑定角色；非法值降级；auditor 为 untyped", () => {
  const decide = (started) => deriveOwnerTaskType(started);
  assert.deepEqual(decide({ taskType: "test", tags: { type: "image" }, roleId: "coder" }), { taskType: "test", typeBasis: "persisted" });
  assert.deepEqual(decide({ tags: { type: "image" }, roleId: "coder" }), { taskType: "image", typeBasis: "tag" });
  assert.deepEqual(decide({ tags: { type: "banana" }, roleId: "coder" }), { taskType: "code", typeBasis: "role" }, "非法标签值不采纳");
  for (const [roleId, taskType] of [["researcher", "research"], ["coder", "code"], ["tester", "test"]]) {
    assert.deepEqual(decide({ roleId }), { taskType, typeBasis: "role" }, roleId);
  }
  for (const roleId of ["auditor", "reviewer", "", "CODER", "coder "]) {
    assert.deepEqual(decide({ roleId }), { taskType: "untyped", typeBasis: "none" }, `role=${JSON.stringify(roleId)}`);
  }
  // roleId 缺失时回退 rolePin（角色库路径）。
  assert.deepEqual(decide({ rolePin: { systemPrompt: "config/roles/tester.md", sha256: "a" } }), { taskType: "test", typeBasis: "role" });
  assert.deepEqual(decide({ rolePin: { systemPrompt: "config/roles/auditor.md", sha256: "a" } }), { taskType: "untyped", typeBasis: "none" });
  // roleId 在场但不合字母表：不回退 rolePin（回退只给"缺失"）。
  assert.deepEqual(decide({ roleId: "not valid!", rolePin: { systemPrompt: "config/roles/tester.md", sha256: "a" } }), { taskType: "untyped", typeBasis: "none" });
  // 空字符串也是在场的坏值（写侧用 null 表示未指定角色）：同样不回退。
  assert.deepEqual(decide({ roleId: "", rolePin: { systemPrompt: "config/roles/coder.md", sha256: "a" } }), { taskType: "untyped", typeBasis: "none" });
  // 只有 null 才回退。
  assert.deepEqual(decide({ roleId: null, rolePin: { systemPrompt: "config/roles/coder.md", sha256: "a" } }), { taskType: "code", typeBasis: "role" });
  // 固化值非法（含读侧结论 untyped）→ 当没有，继续往下判。
  assert.deepEqual(decide({ taskType: "banana", roleId: "coder" }), { taskType: "code", typeBasis: "role" });
  assert.deepEqual(decide({ taskType: "untyped", roleId: "coder" }), { taskType: "code", typeBasis: "role" });
  assert.deepEqual(decide({ taskType: 42, tags: { type: "image" } }), { taskType: "image", typeBasis: "tag" });
  // 什么都没有。
  assert.deepEqual(decide(undefined), { taskType: "untyped", typeBasis: "none" });
  assert.deepEqual(decide({}), { taskType: "untyped", typeBasis: "none" });
  assert.deepEqual(decide({ tags: "image", laneId: "glm-pro" }), { taskType: "untyped", typeBasis: "none" }, "标签不是对象、只有车道没有角色");
});

test("读侧：类型、retryOf 与续修父 runId 只取绑定的事实", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const put = (runId, build) => {
      const b = builder(runId);
      build(b);
      terminal(b, { at: T0 + 3000 });
      s.write(s.bucket(ALPHA.slug), runId, b.events);
    };
    put("run_retry", (b) => head(b, { role: "tester", taskType: "test", retryOf: "run_origin" }));
    put("run_plain", (b) => head(b, { role: "auditor" }));
    put("run_child", (b) => head(b, { parentRunId: "run_parent", role: null, taskType: "code" }));
    // 尾部追加的外 run run.started 带类型：不采信。
    put("run_forged", (b) => {
      head(b, { role: "researcher" });
      b.add("run.started", { backend: "claude-code", cwd: CWD, taskType: "image", retryOf: "run_x" }, { runId: "run_other" });
    });
    // 只认 run.background_submitted 的 parentRunId：session_reuse 的 rootRunId 不是父边。
    put("run_root_only", (b) => {
      head(b);
      b.add("run.session_reuse", { mode: "run_lineage", turn: "resume", rootRunId: "run_root" });
    });
    put("run_bad_retry", (b) => head(b, { retryOf: "../escape" }));
    put("run_self_retry", (b) => head(b, { retryOf: "run_self_retry" }));
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    const pick = (runId) => {
      const r = runOf(snap, runId);
      return { taskType: r.taskType, typeBasis: r.typeBasis, retryOf: r.retryOf, parentRunId: r.parentRunId, roleId: r.roleId };
    };
    assert.deepEqual(pick("run_retry"), { taskType: "test", typeBasis: "persisted", retryOf: "run_origin", parentRunId: null, roleId: "tester" });
    assert.deepEqual(pick("run_plain"), { taskType: "untyped", typeBasis: "none", retryOf: null, parentRunId: null, roleId: "auditor" });
    assert.deepEqual(pick("run_child"), { taskType: "code", typeBasis: "persisted", retryOf: null, parentRunId: "run_parent", roleId: null });
    assert.deepEqual(pick("run_forged"), { taskType: "research", typeBasis: "role", retryOf: null, parentRunId: null, roleId: "researcher" });
    assert.deepEqual(pick("run_root_only"), { taskType: "code", typeBasis: "role", retryOf: null, parentRunId: null, roleId: "coder" });
    assert.deepEqual(pick("run_bad_retry"), { taskType: "code", typeBasis: "role", retryOf: null, parentRunId: null, roleId: "coder" });
    assert.deepEqual(pick("run_self_retry"), { taskType: "code", typeBasis: "role", retryOf: null, parentRunId: null, roleId: "coder" });
  } finally {
    s.cleanup();
  }
});

test("laneId 与 roleId 必须符合身份字母表 ID_RE，不符合为 null；不因此编造类型", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    const put = (runId, build) => {
      const b = builder(runId);
      build(b);
      terminal(b, { at: T0 + 3000 });
      s.write(s.bucket(ALPHA.slug), runId, b.events);
    };
    put("run_lane_upper", (b) => head(b, { laneId: "GLM-PRO" }));
    put("run_lane_space", (b) => head(b, { laneId: "glm pro" }));
    put("run_lane_long", (b) => head(b, { laneId: "l".repeat(33) }));
    put("run_lane_ok", (b) => head(b, { laneId: "kimi_k3.x" }));
    put("run_role_escape", (b) => head(b, { role: "../escape" }));
    put("run_role_tagged", (b) => head(b, { role: "coder\"><script>" }));
    // 坏 roleId 配上合法的 rolePin：上面两条夹具连 pin 也是坏的，区分不了"有没有回退"。
    const withGoodPin = (runId, roleId) => put(runId, (b) => {
      b.add("run.background_submitted", { background: true, cwd: CWD, project: projectFact(ALPHA) });
      b.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
      b.clock(T0 + 1000).add("run.started", {
        backend: "claude-code", cwd: CWD, laneId: "glm-pro", roleId,
        rolePin: { systemPrompt: "config/roles/coder.md", sha256: "a".repeat(64) },
      });
    });
    withGoodPin("run_role_bad_pin_ok", "not valid!");
    withGoodPin("run_role_empty_pin_ok", "");
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });
    const pick = (runId) => {
      const r = runOf(snap, runId);
      return { laneId: r.laneId, roleId: r.roleId, taskType: r.taskType };
    };
    assert.deepEqual(pick("run_lane_upper"), { laneId: null, roleId: "coder", taskType: "code" }, "大写车道名 → null；角色不受影响");
    assert.deepEqual(pick("run_lane_space"), { laneId: null, roleId: "coder", taskType: "code" });
    assert.deepEqual(pick("run_lane_long"), { laneId: null, roleId: "coder", taskType: "code" }, "超过 32 字符 → null");
    assert.deepEqual(pick("run_lane_ok"), { laneId: "kimi_k3.x", roleId: "coder", taskType: "code" }, "字母表内的照给");
    assert.deepEqual(pick("run_role_escape"), { laneId: "glm-pro", roleId: null, taskType: "untyped" }, "带斜杠的角色名 → null，类型不按它推");
    assert.deepEqual(pick("run_role_tagged"), { laneId: "glm-pro", roleId: null, taskType: "untyped" });
    assert.deepEqual(pick("run_role_bad_pin_ok"), { laneId: "glm-pro", roleId: null, taskType: "untyped" }, "坏 roleId + 合法 pin：不回退到 pin");
    assert.deepEqual(pick("run_role_empty_pin_ok"), { laneId: "glm-pro", roleId: null, taskType: "untyped" }, "空 roleId + 合法 pin：空串算在场的坏值，不回退");
  } finally {
    s.cleanup();
  }
});

// ===== 10. 派发端固化 =====

function makeFakeBackend() {
  return {
    validateAgentPolicy() {},
    async spawn() {
      return {
        backend: "claude-code",
        backendSessionId: "proc_1",
        async *events() {
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
}

function makeRegistryFile(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

/** 假 spawn：记下 runner 实际收到的 argv（不真的起进程）。 */
function makeFakeSpawn() {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const call = { cmd, args, opts, stdinText: null };
    calls.push(call);
    return {
      unref() {},
      stdin: { once() {}, end(text, cb) { call.stdinText = String(text ?? ""); cb?.(); } },
    };
  };
  return { spawnFn, calls };
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** 会审席派发桩：记下每次派发收到的入参。 */
function captureCall() {
  const calls = [];
  const wrapped = async (input) => {
    calls.push(input);
    return { accepted: true, runId: `run_seat_${calls.length}`, state: "pending" };
  };
  return { calls, wrapped };
}

/** 进程内跑 runner 入口（stdin / stdout 走注入缝，见文件头）。 */
async function runCapturedRunner(runnerArgs, options) {
  const lines = [];
  await runMain(runnerArgs, {
    stdin: Readable.from([]),
    stdout: { write: (chunk) => { lines.push(String(chunk)); return true; } },
    ...options,
  });
  return lines.join("");
}

async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

const firstEventOf = async (file, type) => (await readTranscript(file)).find((e) => e.type === type);

test("RunManager.start：taskType 选项与 retryOf 固化进 run.started；显式标签 type=image 优先", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-owner-rm-start-"));
  try {
    const config = { registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000, timeout: 5000, retries: 0 };
    const readRegistry = async () => ({
      getAgent: (id) => ({ id, backend: "claude-code", cwd: dir, model: { id: "glm-5.3" } }),
      listAgents: () => [],
    });
    const manager = new RunManager({ config, readRegistry, transcriptDir: dir, backendFor: () => makeFakeBackend() });
    const run = await manager.start("coder_hq", { prompt: "p", taskType: "test", retryOf: "run_origin" });
    await run.waitForCompletion({});
    const started = await firstEventOf(run.transcript.filePath, "run.started");
    assert.equal(started.taskType, "test");
    assert.equal(started.retryOf, "run_origin");

    // 不给就没有这两个键（载荷字节兼容）。
    const plain = await manager.start("coder_hq", { prompt: "p" });
    await plain.waitForCompletion({});
    const plainStarted = await firstEventOf(plain.transcript.filePath, "run.started");
    assert.equal("taskType" in plainStarted, false);
    assert.equal("retryOf" in plainStarted, false);

    // 显式标签 type=image 是操作者对这一次运行的声明：优先于传进来的 taskType
    //（续修 / retry 的继承值）。只带标签、不带 taskType 时同样固化成 image。
    const tagged = await manager.start("coder_hq", { prompt: "p", tags: "type=image", taskType: "code" });
    await tagged.waitForCompletion({});
    const taggedStarted = await firstEventOf(tagged.transcript.filePath, "run.started");
    assert.equal(taggedStarted.taskType, "image", "标签赢过继承值");
    assert.deepEqual(taggedStarted.tags, { type: "image" });
    const taggedOnly = await manager.start("coder_hq", { prompt: "p", tags: ["team=alpha", "type=image"] });
    await taggedOnly.waitForCompletion({});
    assert.equal((await firstEventOf(taggedOnly.transcript.filePath, "run.started")).taskType, "image");
    // 别的标签值不产生类型。
    const otherTag = await manager.start("coder_hq", { prompt: "p", tags: "type=banana" });
    await otherTag.waitForCompletion({});
    assert.equal("taskType" in (await firstEventOf(otherTag.transcript.filePath, "run.started")), false);
  } finally {
    rmrfRetry(dir);
  }
});

test("RunManager.start：非法 taskType / retryOf 在写转录、spawn、建 worktree 之前拒绝——用开启隔离的派发验证", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-owner-rm-start-iso-"));
  try {
    const spawned = [];
    const backend = {
      validateAgentPolicy() {},
      async spawn() {
        spawned.push(Date.now());
        return {
          backend: "claude-code",
          backendSessionId: "proc_1",
          async *events() {
            yield { kind: "done", reason: "completed" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const worktrees = [];
    const config = { registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000, timeout: 5000, retries: 0 };
    const readRegistry = async () => ({
      getAgent: (id) => ({ id, backend: "claude-code", cwd: dir, model: { id: "glm-5.3" } }),
      listAgents: () => [],
    });
    const manager = new RunManager({
      config,
      readRegistry,
      transcriptDir: dir,
      backendFor: () => backend,
      // 假的建树缝：只记账并返回 worktree 信息（与 runManager.test.js 同款），不真的建树。
      createWorktreeFn: async (source, runId) => {
        worktrees.push(runId);
        return { path: join(dir, `wt_${runId}`), branch: `wao/${runId}` };
      },
    });
    // 不隔离的派发本来就不建 worktree，"零 worktree"数什么都是零——所以这里一律开启隔离。
    const startIsolated = (options) => manager.start("coder_hq", { prompt: "p", isolate: true, ...options });

    // 夹具前提：同一夹具下合法派发确实建了 worktree——证明下面的"零"是数出来的，不是数不到。
    const legal = await startIsolated({ taskType: "test" });
    await legal.waitForCompletion({});
    const legalStarted = await firstEventOf(legal.transcript.filePath, "run.started");
    assert.deepEqual(worktrees, [legal.runId], "合法值 + 隔离 → 恰好建了一棵 worktree");
    assert.equal(legalStarted.worktreePath, join(dir, `wt_${legal.runId}`), "worktree 事实落进了 run.started");
    assert.equal(legalStarted.worktreeStrategy, "persistent");
    assert.equal(legalStarted.taskType, "test");
    assert.equal(spawned.length, 1);

    const transcriptsBefore = listTranscriptsDeep(dir).length;
    // "untyped" 是闭集里的读侧结论，固定文案本身会点名它，所以只对其余值查"不回显"。
    for (const [field, value] of [["taskType", "untyped"], ["taskType", "banana"], ["taskType", 42], ["retryOf", "../escape"], ["retryOf", ""]]) {
      await assert.rejects(
        () => startIsolated({ [field]: value }),
        (e) => {
          assert.match(e.message, new RegExp(`^RunManager\\.start: ${field}`), "固定文案点名是哪个选项");
          if (!["", "untyped"].includes(String(value))) {
            assert.ok(!e.message.includes(String(value)), "不回显收到的值");
          }
          return true;
        },
        `非法 ${field}=${JSON.stringify(value)}`,
      );
    }
    assert.equal(listTranscriptsDeep(dir).length, transcriptsBefore, "零新转录");
    assert.equal(spawned.length, 1, "零 spawn");
    assert.deepEqual(worktrees, [legal.runId], "零 worktree");
  } finally {
    rmrfRetry(dir);
  }
});

test("runner：--tag type=image 与 --task-type 都固化成 run.started.taskType（经真实 argv 解析）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-owner-rm-runner-"));
  try {
    const registryPath = makeRegistryFile(dir, { bg_worker: { backend: "claude-code", cwd: dir } });
    // runner 入口自己就是 argv[0] 之后的那串参数：位置参数是 agentId，其余是旗标。
    const base = ["--run-dir", dir, "--registry", registryPath, "--poll-interval", "10"];
    const run = async (runId, extra) => {
      await runCapturedRunner(
        ["bg_worker", "--prompt", "x", "--run-id", runId, ...base, ...extra],
        { backendFor: () => makeFakeBackend() },
      );
      return firstEventOf(resolveTranscriptPath(dir, runId), "run.started");
    };
    const tagged = await run("run_bg_tag", ["--tag", "type=image"]);
    assert.equal(tagged.taskType, "image");
    assert.deepEqual(tagged.tags, { type: "image" });
    const threaded = await run("run_bg_type", ["--task-type", "delivery_review"]);
    assert.equal(threaded.taskType, "delivery_review");
    assert.equal("tags" in threaded, false, "--task-type 不是标签");
    const plain = await run("run_bg_plain", []);
    assert.equal("taskType" in plain, false, "都不给就没有这个键");
  } finally {
    rmrfRetry(dir);
  }
});

test("runner 启动失败时合成的 run.started 写入的类型与 RunManager.start 会固化的一致：标签 type=image 优先，否则合法的 --task-type，否则不写", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-owner-rm-startup-"));
  try {
    let n = 0;
    const failStart = async ({ taskType, tags } = {}) => {
      n += 1;
      const runId = `run_sf_${n}`;
      // 注册表里没有这个 agent：RunManager.start 在 spawn 之前抛错，runner 走启动失败收口。
      const result = await runBackground({
        agentId: "ghost_agent",
        prompt: "x",
        registry: { agents: {} },
        runDir: dir,
        runId,
        ...(taskType !== undefined ? { taskType } : {}),
        ...(tags !== undefined ? { tags } : {}),
        backendFor: () => makeFakeBackend(),
        waitTimeout: 3000,
        pollInterval: 10,
      });
      assert.equal(result.failed, true, `启动失败应收口为 failed（${JSON.stringify(result)}）`);
      return firstEventOf(resolveTranscriptPath(dir, runId), "run.started");
    };
    const typed = await failStart({ taskType: "delivery_review" });
    assert.equal(typed.backend, "backgroundRunner", "夹具前提：这是 runner 合成的那条 run.started");
    assert.equal(typed.taskType, "delivery_review", "合法的 --task-type 一并写进去");
    assert.equal("taskType" in await failStart({ taskType: "banana" }), false, "闭集外的不写");
    assert.equal("taskType" in await failStart({}), false, "都没给就不写");
    // 只靠 --tag type=image 的运行（本批以前的生图运行）：启动失败也要固化 image，否则这类
    // 运行的类型恰好在失败时丢失。
    assert.equal((await failStart({ tags: "type=image" })).taskType, "image", "只带 --tag type=image → image");
    assert.equal((await failStart({ tags: ["team=alpha", "type=image"] })).taskType, "image", "多个标签里有一个 type=image 也算");
    assert.equal(
      (await failStart({ tags: "type=image", taskType: "code" })).taskType,
      "image",
      "标签与 --task-type 都给时标签优先（与 RunManager.start 一致）",
    );
    assert.equal("taskType" in await failStart({ tags: "type=banana" }), false, "别的标签值不产生类型");
    assert.equal(
      (await failStart({ tags: "type=banana", taskType: "test" })).taskType,
      "test",
      "标签不是 image 时用合法的 --task-type",
    );
  } finally {
    rmrfRetry(dir);
  }
});

test("dispatchRun：taskType 以 --task-type 交给 runner；不给则 argv 没有这个旗标；非法值零转录零 fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-owner-rm-dispatch-"));
  try {
    const runDir = join(dir, "runs");
    const registryPath = makeRegistryFile(dir, { coder_hq: { backend: "claude-code", cwd: dir } });
    const base = { agentId: "coder_hq", prompt: "p", registryPath, runDir, readOnly: true };

    const typed = makeFakeSpawn();
    const result = await dispatchRun({ ...base, taskType: "plan_review", spawnFn: typed.spawnFn });
    assert.equal(result.accepted, true, `accepted（${JSON.stringify(result)}）`);
    assert.equal(typed.calls.length, 1);
    assert.equal(argValue(typed.calls[0].args, "--task-type"), "plan_review");
    assert.equal(typed.calls[0].args.filter((a) => a === "--task-type").length, 1, "恰好一条");

    const plain = makeFakeSpawn();
    await dispatchRun({ ...base, spawnFn: plain.spawnFn });
    assert.equal(plain.calls[0].args.includes("--task-type"), false, "不给 taskType → argv 逐字节不变");

    const refused = makeFakeSpawn();
    const acceptedBefore = listTranscriptsDeep(runDir).length;
    assert.equal(acceptedBefore, 2, "夹具前提：此前两次正常派发各写了一份转录");
    for (const bad of ["untyped", "banana", "CODE", "", 42, {}]) {
      await assert.rejects(
        () => dispatchRun({ ...base, taskType: bad, spawnFn: refused.spawnFn }),
        (e) => {
          assert.match(e.message, /^dispatchRun: taskType/);
          if (!["", "untyped"].includes(String(bad))) {
            assert.ok(!e.message.includes(String(bad)), "不回显收到的值（\"untyped\" 是固定文案点名的保留值）");
          }
          return true;
        },
        `非法 taskType=${JSON.stringify(bad)}`,
      );
    }
    assert.equal(refused.calls.length, 0, "零 fork");
    assert.equal(listTranscriptsDeep(runDir).length, acceptedBefore, "零转录：被拒的派发不留孤儿 pending 转录");
    // undefined 与 null 都是“不给”。
    const absent = makeFakeSpawn();
    await dispatchRun({ ...base, taskType: undefined, spawnFn: absent.spawnFn });
    await dispatchRun({ ...base, taskType: null, spawnFn: absent.spawnFn });
    assert.equal(absent.calls.every((c) => !c.args.includes("--task-type")), true);
  } finally {
    rmrfRetry(dir);
  }
});

test("会审席位：按有无 reviewedRunId 把 plan_review / delivery_review 交给派发", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-owner-rm-consult-"));
  try {
    const invoke = async (extra) => {
      const { calls, wrapped } = captureCall();
      await runConsult({
        briefText: "## Q1 方案可行吗\n",
        seats: [{ agentId: "seat_a" }, { agentId: "seat_b" }],
        registryPath: join(dir, "agents.json"),
        runDir: join(dir, "runs"),
        consultsDir: join(dir, "consults"),
        budgetFloorMs: 0,
        budgetMs: 0,
        env: {},
        nowFn: () => NOW,
        sleepFn: async () => {},
        idFn: () => "consult_20261124120000000ownrm0",
        dispatchFn: wrapped,
        registryReadFn: async () => ({ getAgent: () => { throw new Error("nope"); }, listAgents: () => [] }),
        readTranscriptFn: async () => { throw new Error("ENOENT stub"); },
        writeFileFn: async () => {},
        mkdirFn: async () => {},
        renameFn: async () => {},
        rmFn: async () => {},
        ...extra,
      });
      return calls.map((c) => ({ agentId: c.agentId, taskType: c.taskType, readOnly: c.readOnly }));
    };
    assert.deepEqual(await invoke({}), [
      { agentId: "seat_a", taskType: "plan_review", readOnly: true },
      { agentId: "seat_b", taskType: "plan_review", readOnly: true },
    ]);
    assert.deepEqual(await invoke({ reviewedRunId: "run_under_review" }), [
      { agentId: "seat_a", taskType: "delivery_review", readOnly: true },
      { agentId: "seat_b", taskType: "delivery_review", readOnly: true },
    ], "被审 run 在场 → 交付会审");
    assert.deepEqual(await invoke({ reviewedRunId: "" }), [
      { agentId: "seat_a", taskType: "plan_review", readOnly: true },
      { agentId: "seat_b", taskType: "plan_review", readOnly: true },
    ], "空串等于没有");
  } finally {
    rmrfRetry(dir);
  }
});

test("persistedOwnerTaskType / parseTags：RunManager.start 与 runner 的启动失败收口共用同一处判定", () => {
  assert.deepEqual(parseTags("type=image"), { type: "image" });
  assert.deepEqual(parseTags(["team=alpha", "note=a=b=c"]), { team: "alpha", note: "a=b=c" }, "值里的 = 原样保留");
  assert.deepEqual(parseTags([]), {});
  // 显式标签 type=image 优先于传入的 taskType（续修 / retry 的继承值）。
  assert.equal(persistedOwnerTaskType(parseTags("type=image"), "code"), "image", "标签赢过继承值");
  assert.equal(persistedOwnerTaskType(parseTags("type=image"), "banana"), "image");
  assert.equal(persistedOwnerTaskType(parseTags("type=image"), undefined), "image", "只带标签");
  // 标签不是 image：用合法的 taskType，否则不写。
  assert.equal(persistedOwnerTaskType(parseTags("type=banana"), "code"), "code");
  assert.equal(persistedOwnerTaskType(parseTags("team=alpha"), "test"), "test");
  assert.equal(persistedOwnerTaskType(undefined, "code"), "code");
  for (const [tags, taskType] of [[undefined, "banana"], [undefined, "untyped"], [undefined, undefined], [null, null], [parseTags("type=banana"), "untyped"]]) {
    assert.equal(persistedOwnerTaskType(tags, taskType), null, `tags=${JSON.stringify(tags)} taskType=${String(taskType)}`);
  }
});

test("inheritableOwnerTaskType：固化值合法用固化值；否则 tags.type=image 给 image（本批以前的生图运行）；其余 null", () => {
  assert.equal(inheritableOwnerTaskType({ taskType: "code" }), "code");
  assert.equal(inheritableOwnerTaskType({ taskType: "image", tags: { type: "banana" } }), "image", "固化值赢过标签");
  assert.equal(inheritableOwnerTaskType({ tags: { type: "image" } }), "image", "只有标签的旧生图运行");
  assert.equal(inheritableOwnerTaskType({ taskType: "banana", tags: { type: "image" } }), "image", "固化值非法 → 退到标签");
  assert.equal(inheritableOwnerTaskType({ taskType: "untyped", tags: { type: "image" } }), "image");
  assert.equal(inheritableOwnerTaskType({ tags: { type: "banana" } }), null);
  assert.equal(inheritableOwnerTaskType({ tags: "image" }), null, "标签不是对象");
  assert.equal(inheritableOwnerTaskType({ taskType: "untyped" }), null, "读侧结论不继承");
  assert.equal(inheritableOwnerTaskType({}), null);
  assert.equal(inheritableOwnerTaskType(undefined), null);
});

test("CLI retry：新运行继承原运行的 taskType（含只有标签的旧生图运行）并写 retryOf；原运行没有就不写类型", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-owner-rm-retry-"));
  try {
    const writeSource = (runId, startedFields) => {
      const b = builder(runId, { agentId: "coder_hq" });
      b.add("run.started", { backend: "claude-code", cwd: dir, model: { id: "glm-5.3" }, ...startedFields });
      b.add("prompt.sent", { prompt: "# 原任务" });
      terminal(b, { at: T0 + 1000 });
      return sWrite(dir, runId, b.events);
    };
    writeSource("run_origin", { taskType: "code" });
    writeSource("run_untyped_src", {});
    writeSource("run_tagged_src", { tags: { type: "image" } });
    writeSource("run_other_tag_src", { tags: { type: "banana" } });
    const forgedFile = writeSource("run_forged_src", { taskType: "image" });
    // 尾部追加一条同 runId 的 run.started（伪造，声称另一个类型）：retry 只认首条。
    await appendFile(forgedFile, `${JSON.stringify({
      seq: 99, ts: iso(T0 + 2000), type: "run.started", runId: "run_forged_src", agentId: "coder_hq",
      backend: "claude-code", cwd: dir, taskType: "plan_review",
    })}\n`, "utf8");
    writeSource("run_bad_src", { taskType: "banana" });
    const config = {
      registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 5000, timeout: 5000, retries: 0,
      backendFor: () => makeFakeBackend(),
      readRegistry: async () => ({
        getAgent: (id) => ({ id, backend: "claude-code", cwd: dir, model: { id: "glm-5.3" } }),
        listAgents: () => [],
      }),
    };
    const retry = async (runId) => {
      const out = await captureLog(() => retryCommand([runId, "--run-dir", dir], config));
      const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
      const started = await firstEventOf(parsed.transcript, "run.started");
      return { parsed, started };
    };
    const inherited = await retry("run_origin");
    assert.equal(inherited.started.taskType, "code");
    assert.equal(inherited.started.retryOf, "run_origin");
    assert.equal(inherited.parsed.originalRunId, "run_origin");
    const bare = await retry("run_untyped_src");
    assert.equal("taskType" in bare.started, false);
    assert.equal(bare.started.retryOf, "run_untyped_src");
    // 本批以前的生图运行只有标签：新运行把它固化成 taskType。
    const tagged = await retry("run_tagged_src");
    assert.equal(tagged.started.taskType, "image", "只有标签的原运行 → 新运行固化 image");
    assert.equal("tags" in tagged.started, false, "retry 没带 --tag，标签不继承（类型继承来自固化值）");
    assert.equal(tagged.started.retryOf, "run_tagged_src");
    const otherTag = await retry("run_other_tag_src");
    assert.equal("taskType" in otherTag.started, false, "别的标签值不产生类型");
    const forged = await retry("run_forged_src");
    assert.equal(forged.started.taskType, "image", "取首条绑定的 run.started，尾部伪造不采信");
    assert.equal(forged.started.retryOf, "run_forged_src");
    const corrupt = await retry("run_bad_src");
    assert.equal("taskType" in corrupt.started, false, "原值非法 → 不继承，retry 照常");
    assert.equal(corrupt.started.retryOf, "run_bad_src");
    // 让新运行的后台事件循环写完终态再清理目录。
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    rmrfRetry(dir);
  }
});

/** 把事件数组落成一个 JSONL 转录（返回路径）。 */
function sWrite(dir, runId, events) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.jsonl`);
  writeFileSync(file, jsonl(events), "utf8");
  return file;
}

// ===== 11. 续修传播（一次性 Git 仓库 + 链接工作树）=====

function git(args, cwd) {
  return String(execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).trim();
}

function makeRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  git("init -b main", repo);
  git("config user.email t@t.com", repo);
  git("config user.name T", repo);
  writeFileSync(join(repo, "README.md"), "base\n", "utf8");
  git("add -A", repo);
  git("commit -m base", repo);
  return repo;
}

function buildCommittedParent(repo, runId) {
  const wt = join(repo, ".wao-worktrees", runId);
  git(`worktree add -b wao/${runId} "${wt}"`, repo);
  const base = git("rev-parse HEAD", repo);
  writeFileSync(join(wt, "keep.txt"), "changed\n", "utf8");
  git("add -A", wt);
  git(`-c user.name="WAO Delivery" -c user.email="wao-delivery@local" commit -m "wao-delivery: ${runId}"`, wt);
  return { wt, base, deliveryCommit: git("rev-parse HEAD", wt), branch: `wao/${runId}` };
}

test("续修：子运行的 runner argv 带父运行可继承的任务类型（固化值，或只有标签的旧生图运行）；没有或值非法就不传", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-owner-rm-continue-"));
  const repos = [];
  try {
    const continueOnce = async (parentStartedFields) => {
      const repo = makeRepo("wao-owner-rm-repo-");
      repos.push(repo);
      const runId = `run_parent_${repos.length}`;
      const parent = buildCommittedParent(repo, runId);
      const b = builder(runId, { agentId: "coder_hq" });
      b.add("run.background_submitted", { background: true, cwd: repo, deliveryRequested: true });
      b.add("run.state_change", { from: null, to: "pending", reason: "background_spawned" });
      b.add("run.started", {
        backend: "claude-code", cwd: repo, worktreePath: parent.wt, worktreeBranch: parent.branch,
        delivery: { mode: "git_commit_v1", baseCommit: parent.base, allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
        ...parentStartedFields,
      });
      b.add("run.session_reuse", { mode: "run_lineage", turn: "first", rootRunId: runId });
      b.add("session.created", { backend: "claude-code", backendSessionId: "provider-session-1", serveUrl: null });
      b.add("run.delivery_created", {
        deliveryCommit: parent.deliveryCommit,
        delivery: {
          schemaVersion: 1, kind: "git_commit", runId,
          baseCommit: parent.base, deliveryCommit: parent.deliveryCommit, branch: parent.branch, worktreePath: parent.wt,
          allowedPaths: ["keep.txt"], changedFiles: ["keep.txt"], verification: { commands: ["node --test"] },
          acceptance: { status: "pending", reviewerType: "lead_agent" }, integration: { status: "pending", targetCommit: null },
        },
      });
      b.add("run.state_change", { from: "pending", to: "completed", reason: "done" });
      sWrite(dir, runId, b.events);
      const registryPath = makeRegistryFile(dir, { coder_hq: { backend: "claude-code", cwd: repo } });
      const { spawnFn, calls } = makeFakeSpawn();
      const result = await continueRun({
        parentRunId: runId, prompt: "correct it",
        delivery: { mode: "git_commit_v1", allowedPaths: ["keep.txt"], verificationCommands: ["node --test"] },
        runDir: dir, authorizedWorkspaceRoot: repo, registryPath, spawnFn, backendFor: () => ({ supportsSessionReuse: true }),
      });
      return { result, args: calls[0]?.args, parentRunId: runId };
    };
    const typed = await continueOnce({ taskType: "code" });
    assert.equal(typed.result.accepted, true, `accepted（${typed.result.rejectionReason}）`);
    assert.equal(argValue(typed.args, "--task-type"), "code");
    // 子转录的父边是派发器写的持久事实。
    const childSubmitted = await firstEventOf(typed.result.transcriptPath, "run.background_submitted");
    assert.equal(childSubmitted.continuation, true);
    assert.equal(childSubmitted.parentRunId, typed.parentRunId);

    // 本批以前的生图运行只有标签：子运行继承 image。
    const tagged = await continueOnce({ tags: { type: "image" } });
    assert.equal(tagged.result.accepted, true, `accepted（${tagged.result.rejectionReason}）`);
    assert.equal(argValue(tagged.args, "--task-type"), "image", "只有标签的父运行 → 子运行继承 image");

    const plain = await continueOnce({});
    assert.equal(plain.result.accepted, true, `accepted（${plain.result.rejectionReason}）`);
    assert.equal(argValue(plain.args, "--task-type"), undefined, "父运行没有可继承的类型 → 不传");

    const corrupt = await continueOnce({ taskType: "banana" });
    assert.equal(corrupt.result.accepted, true, "类型只是分类标签，父值非法不拦续修");
    assert.equal(argValue(corrupt.args, "--task-type"), undefined, "但不继承非法值");
  } finally {
    rmrfRetry(dir);
    for (const repo of repos) rmrfRetry(repo);
  }
});

// ===== 12. 快照里没有路径 =====

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

test("快照里没有任何路径：键集是白名单，任何字符串都不含运行目录、桶目录、cwd、工作树、转录或租约路径", async () => {
  const s = makeStore();
  try {
    s.writeProject(ALPHA);
    s.writeProject(BETA);
    const b = builder("run_leak");
    // 事实说它属于 beta、文件却放在 alpha 桶里：两个桶的 slug 与名字都要过一遍路径检查。
    head(b, {
      project: projectFact(BETA),
      worktreePath: `${CWD}\\.wao-worktrees\\run_leak`,
      prompt: "# 含路径的任务\n",
      deliveryRequested: true,
    });
    working(b, { at: T0 + 3000 });
    terminal(b, { at: T0 + 5000 });
    s.write(s.bucket(ALPHA.slug), "run_leak", b.events);
    s.write(s.bucket(BETA.slug), "run_unc", [null]);
    s.lease("run_leak", { pid: 4242, heartbeatAt: NOW, claimedAt: iso(NOW), nonce: "n" });
    const model = createOwnerReadModel({ runDir: s.runDir });
    await model.refresh();
    const snap = model.snapshot({ now: NOW });

    assert.deepEqual(Object.keys(snap).sort(), ["consults", "generatedAt", "projects", "runs"]);
    for (const p of snap.projects) assert.deepEqual(Object.keys(p).sort(), ["branchesObservedAt", "name", "repo", "slug"]);
    const RUN_KEYS = [
      "agentId", "availability", "deliveryRequested", "lastEffectAt", "lastProcessActiveAt", "lastVitalAt", "laneId",
      "liveness", "parentRunId", "project", "quietSince", "readOnly", "retryOf", "roleId", "runId", "stage", "stageSince",
      "startedAt", "state", "taskType", "terminal", "terminalAt", "title", "titleBasis", "typeBasis",
      // 第 140b 批：交付、失败、额度、谱系。
      "capacity", "delivery", "failure", "legalDecision", "lineageRootConflict", "lineageRootRunId",
      "lineageUndeterminable", "supersededByRunId",
    ].sort();
    assert.equal(snap.runs.length, 2, "夹具前提：一个可读运行 + 一个读不出的运行");
    for (const run of snap.runs) {
      assert.deepEqual(Object.keys(run).sort(), RUN_KEYS, `${run.runId} 的键集（DTO 白名单；加键必须过这里）`);
      if (run.project !== null) assert.deepEqual(Object.keys(run.project).sort(), ["name", "slug"], "project 恰两键");
      // 交付对象也是白名单：deliveryRef 的其余字段（worktreePath 等）不整包透传。
      if (run.delivery !== null) {
        assert.deepEqual(Object.keys(run.delivery).sort(), [
          "acceptance", "ambiguous", "branchPresent", "commit", "isolationFailure", "packagingFailure", "settledAt",
          "settlement", "verification",
        ], `${run.runId} 的 delivery 键集`);
        assert.deepEqual(Object.keys(run.delivery.settlement).sort(), ["reason", "status"]);
        assert.deepEqual(Object.keys(run.delivery.acceptance).sort(), ["decidedAt", "status"]);
      }
    }
    // 这个夹具里的运行请求了交付、终态却既没打包也没隔离证据：如实是判不出的收口，不是"没有"。
    assert.deepEqual(runOf(snap, "run_leak").delivery, {
      settlement: { status: "undeterminable", reason: "terminal_delivery_ambiguous" },
      commit: null,
      verification: null,
      acceptance: { status: null, decidedAt: null },
      settledAt: null,
      ambiguous: false,
      packagingFailure: null,
      isolationFailure: null,
      branchPresent: null, // 项目仓库不存在 → 没有分支观测
    });
    assert.equal(runOf(snap, "run_leak").failure, null, "没失败就没有失败事实");
    assert.equal(runOf(snap, "run_leak").capacity, null);
    assert.deepEqual(runOf(snap, "run_leak").project, { slug: BETA.slug, name: BETA.name });
    const { keys, strings } = collect(snap);
    for (const key of keys) {
      assert.ok(!/path|cwd|dir|file|worktree|tree|pid|session|registry|key\b/i.test(key), `快照里不得出现路径类键名：${key}`);
    }
    const variants = (p) => [p, p.replace(/\\/g, "/")];
    const needles = [
      ...variants(s.base), ...variants(s.runDir), ...variants(s.bucket(ALPHA.slug)), ...variants(s.bucket(BETA.slug)),
      ...PRIVATE_PATHS.flatMap(variants),
      ".jsonl", ".owner-", "proc_4242",
    ];
    assert.ok(strings.length > 20, "夹具前提：快照里有足够多的字符串可供检查");
    for (const str of strings) {
      for (const needle of needles) {
        assert.ok(!str.includes(needle), `快照字符串泄漏了路径/标识：${JSON.stringify(str)} 含 ${JSON.stringify(needle)}`);
      }
    }
    assert.ok(!JSON.stringify(snap).includes("repos"), "连转义后的形式也不得出现");
  } finally {
    s.cleanup();
  }
});
