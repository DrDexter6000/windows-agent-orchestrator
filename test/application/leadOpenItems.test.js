// test/application/leadOpenItems.test.js
//
// 决定 0113（第 75 批，会审 sol 修订后；第 76 批修订归属口径）：lead_preflight
// 待 Lead 收口事项收集器的分支覆盖。git（分支枚举/运行树列表）与转录读取全部
// 注入；真 git 子进程只出现在临时仓夹具（ROOT 主检出、链接工作树）与旧运行按
// cwd 推导的真实 R8 判定上——全部在 os.tmpdir() 下，不碰真实 runs/ 与真实收件箱。
//
// 钉的语义：
//   - 候选集只认 wao/run_ 前缀且 runId 合法的分支；>50 条只查**最新** 50 条
//     （假 git 按排序参数返回不同顺序，变异 --sort=committerdate 必红）且行内
//     写明已查看部分与总条数；
//   - 归属=记录的项目身份（identityOfFirstEvent，0113 修订）：首事件在档
//     project 事实的 key 与绑定工作区相同才算本项目——开发树删了也认得出
//     （cwd 是不存在的目录照常计入）；别的 key 跳过、在档事实损坏进"找不到
//     或冲突"行；没有记录的旧运行按 cwd 推导（链接工作树经 R8 归主工作树）；
//   - 分类：等裁定（含可续计数正/负例）、终态未收口（验证 pending）、
//     undeterminable 单独一行（与"还没结果"分开，指向 runs diagnose）、留待
//     回收（已采纳/已拒收/无交付）、未终态不报、转录缺失只计数；
//   - 枚举失败省略整段 A；运行树数全仓口径（.wao-worktrees/<合法 runId> 结尾）；
//   - 收件箱仅同项目出行（可读收件箱在场时读函数 0 次调用）、只 readdir
//     open/ 的合法文件名（closed/、ids/ 不碰，不调 listFeedback——结构上无该
//     依赖，注入读函数钉"只碰 open/"）；
//   - 每行 `open item: ` 开头且 ≤512 字符；任何读失败不抛。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";

import {
  collectLeadOpenItems,
  OPEN_ITEM_PREFIX,
  OPEN_ITEM_MAX_CHARS,
  OPEN_ITEM_BRANCH_CAP,
} from "../../src/application/leadOpenItems.js";
import { RECENT_BOUND_EVENT_MS } from "../../src/application/worktreeReclaim.js";
import { determineRunSettlement } from "../../src/application/runSettlement.js";
import { JsonlTranscript, readTranscript } from "../../src/transcript.js";
import {
  deriveProjectBucketSlug,
  identifyProjectFromCwd,
  productionProjectIo,
} from "../../src/projectIdentity.js";

// ===== 夹具基建 =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// 测试用 projectIdentity io：realpath 与 R8 的读文件用生产实现，但**不启用**
// scratch 判定（tmpdir 置空）——夹具仓库就建在 os.tmpdir() 下，生产口径会把
// 它们判成 scratch、盖掉项目归属语义（scratch 判定本身由 projectIdentity
// 自己的测试钉）。同时验证 projectIo 注入缝生效。
const TEST_PROJECT_IO = (() => {
  const io = productionProjectIo();
  return { platform: process.platform, realpath: io.realpath, tmpdir: "", readGitFile: io.readGitFile };
})();

function makeGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

// 在 ROOT 里登记一棵链接工作树（真实 `git worktree add`——没有在档事实的旧
// 运行按 cwd 推导时，identifyProjectFromCwd 的 R8 判定要读它的 .git 文件/
// gitdir/commondir）。
function makeLinkedWorktree(root, dir) {
  execFileSync("git", ["worktree", "add", dir, "-b", "wt-fixture"], { cwd: root, stdio: "pipe" });
  return dir;
}

const BASE = "b".repeat(40);
const DELIVERED = "d".repeat(40);
const CROSS_TREE_HINT = "some runs were dispatched from another worktree: workspace_select it (or run the CLI there) first";
// b78：留待回收行的固定尾巴——"能否回收以回收计划为准 + 空计划可能正常"；分钟数
// 从 worktreeReclaim 的 RECENT_BOUND_EVENT_MS 派生（改常量时文案跟着变，不抄数字）。
const RECLAIM_TAIL = " left for reclaim (`wao worktree reclaim --out <plan.json>` plans it; read-only; "
  + `the plan decides what is reclaimable — an empty plan can be normal, `
  + `runs with an event in the last ${Math.round(RECENT_BOUND_EVENT_MS / 60_000)} minutes are kept)`;
const MISSING_LINE = (n) => `open item: ${n} wao/run_* branch(es) without a usable transcript fact `
  + "(not found, unreadable, conflicting copies, or a broken recorded project fact; "
  + "read-only `wao worktree reclaim --out <plan.json>` plan lists the branches)";

// 在档 project 事实（形状与写侧 projectFactFromCwd 一致；bucket 经桶 slug
// 派生，恒过 identityOfFirstEvent 的校验闭集）。
function projectFact(key) {
  return {
    kind: "project",
    rulesVersion: "td190-r3",
    key,
    bucket: deriveProjectBucketSlug({ kind: "project", key, displayName: "wao" }),
  };
}
// 把事实记进首事件（写侧随 run.started 落档的形状）。
function withRecordedFact(events, fact) {
  return events.map((e, i) => (i === 0 ? { ...e, project: fact } : e));
}

function started(runId, cwd, over = {}) {
  return { type: "run.started", runId, agentId: "coder_low", backend: "claude-code", cwd, ...over };
}
function startedWithDelivery(runId, cwd) {
  return started(runId, cwd, {
    delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
  });
}
function makeRef(runId, verification) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: BASE,
    deliveryCommit: DELIVERED,
    branch: `wao/${runId}`,
    worktreePath: "D:/fake/wt",
    changedFiles: ["src/a.js"],
    verification: verification ?? { status: "pending", commands: [], verifiedCommit: DELIVERED, results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
  };
}
function created(runId, verification) {
  return { type: "run.delivery_created", runId, agentId: "coder_low", delivery: makeRef(runId, verification) };
}
// 已验证 ref：created/outcome/decided 三个事件必须携带同一份验证事实
// （SETTLE-11 的形状——不一致会被 validateDeliveryFacts 判 malformed）。
function makeVerifiedRef(runId) {
  return makeRef(runId, { status: "passed", commands: [], verifiedCommit: DELIVERED, results: [] });
}
function accepted(runId) {
  return {
    type: "run.delivery_accepted", runId, agentId: "coder_low",
    delivery: { ...makeVerifiedRef(runId), acceptance: { status: "accepted", reviewerType: "lead_agent" } },
    deliveryCommit: DELIVERED, reason: "ok",
  };
}
function rejected(runId) {
  return {
    type: "run.delivery_rejected", runId, agentId: "coder_low",
    delivery: { ...makeVerifiedRef(runId), acceptance: { status: "rejected", reviewerType: "lead_agent" } },
    deliveryCommit: DELIVERED, reason: "no",
  };
}
function running(runId) {
  return { type: "run.state_change", runId, agentId: "coder_low", from: "pending", to: "running", reason: "first_event" };
}
function terminal(runId, state = "completed") {
  return { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: state, reason: "done" };
}
function deliveryFailed(runId, code = "backend_error") {
  return { type: "run.delivery_failed", runId, agentId: "coder_low", deliveryCode: code };
}

// 场景夹具（形状与 test/run-lifecycle/runSettlement.test.js 同源）。
function settledUndecided(runId, cwd) {
  const verified = makeVerifiedRef(runId);
  return [
    startedWithDelivery(runId, cwd),
    running(runId),
    terminal(runId),
    { type: "run.delivery_created", runId, agentId: "coder_low", delivery: verified },
    { type: "run.delivery_verification_passed", runId, agentId: "coder_low", delivery: verified },
  ];
}
function terminalVerificationPending(runId, cwd) {
  return [startedWithDelivery(runId, cwd), running(runId), terminal(runId), created(runId)];
}
// 第 87 批续修：终态 failed + 重打包 + 验证 pending 的形状——事件全部经生产 CAS
// 写出（tryAppendRepackageCreated / tryAppendDecision，与 transcript.test.js
// TD-179-W4 同一构造路径），不手写事件形状。decided 时追加一条 pending 拒收。
async function failedRepackagedPending(runId, cwd, { decided = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wao-oi-repkg-"));
  try {
    const filePath = join(dir, `${runId}.jsonl`);
    const t = new JsonlTranscript(filePath, { runId, agentId: "coder_low" });
    await t.append("run.started", {
      backend: "claude-code",
      cwd,
      delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] },
    });
    await t.append("run.state_change", { from: "pending", to: "running", reason: "first_event" });
    await t.append("run.delivery_failed", { deliveryCode: "disallowed_path" });
    await t.append("run.state_change", { from: "running", to: "failed", reason: "delivery_failed" });
    const repackaged = await t.tryAppendRepackageCreated({
      delivery: makeRef(runId),
      approvedAllowedPaths: ["src"],
      source: "recovered",
    });
    assert.equal(repackaged.created, true);
    if (decided) {
      const decision = await t.tryAppendDecision({ decision: "rejected", reason: "superseded" });
      assert.equal(decision.accepted, true);
    }
    return await readTranscript(filePath);
  } finally { cleanupDir(dir); }
}
// undeterminable：终态 + 恰好两条绑定 delivery_failed → packaging_conflict
//（SETTLE-05 同款形状——"判不出收口"，不是"还没结果"）。
function terminalUndeterminable(runId, cwd) {
  return [
    startedWithDelivery(runId, cwd), running(runId), terminal(runId, "failed"),
    deliveryFailed(runId), deliveryFailed(runId, "command_failed"),
  ];
}
function noDeliveryTerminal(runId, cwd) {
  return [started(runId, cwd), running(runId), terminal(runId)];
}
function runningOnly(runId, cwd) {
  return [startedWithDelivery(runId, cwd), running(runId)];
}

// 注入 git：for-each-ref 按排序参数返回（refs 一律按**新到旧**传入；
// sortByFlag=true 时收到 `--sort=committerdate`（旧到新）就倒序返回——变异
// 排序方向必红）；worktree list 返回脚本化 porcelain。
function fakeGit({ refs = [], worktrees = [], sortByFlag = false } = {}) {
  const calls = [];
  return {
    calls,
    fn(args) {
      calls.push(args);
      if (args[0] === "for-each-ref") {
        const oldestFirst = sortByFlag && args.includes("--sort=committerdate")
          && !args.includes("--sort=-committerdate");
        const ordered = oldestFirst ? [...refs].reverse() : refs;
        return `${ordered.join("\n")}\n`;
      }
      if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
        return worktrees.map((p) => `worktree ${p}\nHEAD ${"h".repeat(40)}\n`).join("\n");
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  };
}

// 组装一次调用：eventsByRun 决定每个 runId 的转录（读不到 = 转录缺失）。
async function runCollect(ROOT, { refs, worktrees, eventsByRun, over = {}, sortByFlag } = {}) {
  const git = fakeGit({ refs, worktrees, sortByFlag });
  const readCalls = [];
  const resolveTranscriptFn = (runDir, runId) => join(runDir, `${runId}.jsonl`);
  const readTranscriptFn = async (path) => {
    readCalls.push(path);
    const runId = basename(String(path)).replace(/\.jsonl$/, "");
    if (eventsByRun && !Object.prototype.hasOwnProperty.call(eventsByRun, runId)) {
      throw Object.assign(new Error("read failed"), { code: "EIO" });
    }
    return eventsByRun?.[runId];
  };
  const lines = await collectLeadOpenItems({
    authorizedWorkspaceRoot: ROOT,
    runDir: join(ROOT, "runs-unused"),
    execGitFn: git.fn,
    resolveTranscriptFn,
    readTranscriptFn,
    projectIo: TEST_PROJECT_IO,
    // 收件箱：默认"别的项目"（identifyProjectFn 两键不同）→ B 不出行，A 独测。
    identifyProjectFn: (r) => ({ kind: "project", key: r === ROOT ? "proj-a" : "proj-b" }),
    codeCheckoutRoot: join(ROOT, "code-checkout"),
    ...over,
  });
  return { lines, git, readCalls };
}

function assertLineShape(lines) {
  for (const line of lines) {
    assert.ok(line.startsWith(OPEN_ITEM_PREFIX), `行必须以 ${OPEN_ITEM_PREFIX} 开头: ${line}`);
    assert.ok(line.length <= OPEN_ITEM_MAX_CHARS, `行 ≤${OPEN_ITEM_MAX_CHARS} 字符: ${line.length}`);
  }
}

// ===== A. 分类 =====

test("OI-A1: 等裁定 / 终态未收口 / 留待回收（已采纳+已拒收+无交付）各一行，未终态不报；全部派发自绑定根 → 无跨工作树提示", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a1-"));
  try {
    makeGitRepo(root);
    const settled = settledUndecided("run_a1", root);
    assert.equal(determineRunSettlement(settled, "run_a1").reason, "delivery_settled", "夹具前提：收口未裁定");
    const pending = terminalVerificationPending("run_a2", root);
    assert.equal(determineRunSettlement(pending, "run_a2").reason, "verification_pending", "夹具前提：验证 pending");
    const { lines } = await runCollect(root, {
      refs: ["wao/run_a1", "wao/run_a2", "wao/run_a3", "wao/run_a4", "wao/run_a5", "wao/run_a6", "not-wao", "wao/foo"],
      worktrees: [],
      eventsByRun: {
        run_a1: settled,
        run_a2: pending,
        run_a3: [...settledUndecided("run_a3", root), accepted("run_a3")],
        run_a4: [...settledUndecided("run_a4", root), rejected("run_a4")],
        run_a5: noDeliveryTerminal("run_a5", root),
        run_a6: runningOnly("run_a6", root),
      },
    });
    assertLineShape(lines);
    assert.equal(lines.length, 3, `恰好三行（未终态与杂 ref 不出行）: ${JSON.stringify(lines)}`);
    assert.equal(lines[0],
      "open item: 1 settled delivery run(s) await a Lead decision (run_delivery_review_bundle): run_a1");
    assert.equal(lines[1],
      "open item: 1 terminal run(s) not settled (verification/reverify without a result; "
      + "run_delivery or `wao runs wait <runId> --until-settled`): run_a2");
    assert.equal(lines[2],
      "open item: 3 decided/no-delivery wao/run_* branch(es)" + RECLAIM_TAIL);
    for (const line of lines) {
      assert.ok(!line.includes(CROSS_TREE_HINT), `同根派发不出跨工作树提示: ${line}`);
    }
  } finally { cleanupDir(root); }
});

test("OI-A1b: undeterminable 单独一行（判不出收口 ≠ 还没结果）；跨工作树提示按行条件化", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a1b-"));
  const wt = mkdtempSync(join(tmpdir(), "wao-oi-a1b-wt-"));
  try {
    makeGitRepo(root);
    makeLinkedWorktree(root, wt);
    // run_u1 派发自链接工作树（undeterminable 行要带提示）；run_a2 派发自根
    //（pending 行不带）——同一条规则按行生效。
    const und = terminalUndeterminable("run_u1", wt);
    assert.equal(determineRunSettlement(und, "run_u1").status, "undeterminable", "夹具前提：判不出收口");
    const { lines } = await runCollect(root, {
      refs: ["wao/run_u1", "wao/run_a2"],
      worktrees: [],
      eventsByRun: {
        run_u1: und,
        run_a2: terminalVerificationPending("run_a2", root),
      },
    });
    assert.equal(lines.length, 2);
    assert.equal(lines[0],
      "open item: 1 terminal run(s) not settled (verification/reverify without a result; "
      + "run_delivery or `wao runs wait <runId> --until-settled`): run_a2");
    assert.ok(!lines[0].includes(CROSS_TREE_HINT), "pending 行列出的运行都派发自绑定根 → 无提示");
    assert.equal(lines[1],
      "open item: 1 run(s) with undeterminable settlement facts (wao runs diagnose <runId>): run_u1; "
      + `${CROSS_TREE_HINT}`);
    assert.ok(!lines[1].includes("without a result"), "判不出收口不说成还没结果");
    assert.ok(!lines[0].includes("diagnose"), "pending 行不指诊断");
  } finally { cleanupDir(wt); cleanupDir(root); }
});

test("OI-A1c: 旧运行（无在档事实）按 cwd 推导——链接工作树里派发的算本项目（等裁步行点名并带提示），无关目录跳过", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a1c-"));
  const wt = mkdtempSync(join(tmpdir(), "wao-oi-a1c-wt-"));
  const foreign = mkdtempSync(join(tmpdir(), "wao-oi-a1c-other-"));
  try {
    makeGitRepo(root);
    makeLinkedWorktree(root, wt);
    const { lines } = await runCollect(root, {
      refs: ["wao/run_l1", "wao/run_f1"],
      worktrees: [],
      eventsByRun: {
        // 首事件没有 project 字段 → identityOfFirstEvent 退回按 cwd 推导：
        // ROOT 的链接工作树经 R8 归主工作树 → 与绑定根同 key → 算本项目。
        run_l1: settledUndecided("run_l1", wt),
        // 真正的别的目录 → 推导出的 key 不同 → 跳过不计。
        run_f1: settledUndecided("run_f1", foreign),
      },
    });
    assert.equal(lines.length, 1, `链接工作树的运行计入，外来目录跳过: ${JSON.stringify(lines)}`);
    assert.ok(lines[0].startsWith("open item: 1 settled delivery run(s) await a Lead decision "), "run_l1 进入等裁定行");
    assert.ok(lines[0].includes("): run_l1"), `runId 点名: ${lines[0]}`);
    assert.ok(lines[0].includes(CROSS_TREE_HINT), "该行列出的运行派发自另一棵工作树 → 带可执行提示");
    assert.ok(!/[A-Za-z]:[\\/]/.test(lines[0]), "行内无绝对路径");
  } finally { cleanupDir(wt); cleanupDir(foreign); cleanupDir(root); }
});

test("OI-A1d: 终态 failed + 重打包 + 验证 pending——已拒收的不进终态未收口、计入留待回收；同形状未裁定仍进终态未收口", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a1d-"));
  try {
    makeGitRepo(root);
    const undecided = await failedRepackagedPending("run_d1", root);
    assert.equal(determineRunSettlement(undecided, "run_d1").reason, "verification_pending",
      "夹具前提：验证 pending 未收口");
    const decided = await failedRepackagedPending("run_d2", root, { decided: true });
    const settlement = determineRunSettlement(decided, "run_d2");
    assert.equal(settlement.reason, "verification_pending", "收口语义不变（0095）：拒收后仍 unsettled");
    assert.equal(settlement.facts.acceptanceStatus, "rejected", "夹具前提：已拒收");

    const { lines } = await runCollect(root, {
      refs: ["wao/run_d1", "wao/run_d2"],
      worktrees: [],
      eventsByRun: { run_d1: undecided, run_d2: decided },
    });
    assertLineShape(lines);
    assert.equal(lines.length, 2, `恰好两行: ${JSON.stringify(lines)}`);
    assert.equal(lines[0],
      "open item: 1 terminal run(s) not settled (verification/reverify without a result; "
      + "run_delivery or `wao runs wait <runId> --until-settled`): run_d1",
      "未裁定的仍在终态未收口行；已拒收的不在（run_d2 未被点名）");
    assert.equal(lines[1],
      "open item: 1 decided/no-delivery wao/run_* branch(es)" + RECLAIM_TAIL,
      "已拒收的计入留待回收");
  } finally { cleanupDir(root); }
});

test("OI-A2: 可续计数正例（谱系在、未采纳、未闭合）在等裁步行内另计", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a2-"));
  try {
    makeGitRepo(root);
    const continuableRun = [
      ...settledUndecided("run_c1", root),
      { type: "run.session_reuse", runId: "run_c1", mode: "run_lineage", turn: "first", rootRunId: "run_c1" },
    ];
    const { lines } = await runCollect(root, {
      refs: ["wao/run_c1", "wao/run_c2"],
      worktrees: [],
      eventsByRun: {
        run_c1: continuableRun,
        run_c2: settledUndecided("run_c2", root), // 无谱系 → 非可续
      },
    });
    assert.equal(lines[0],
      "open item: 2 settled delivery run(s) await a Lead decision (run_delivery_review_bundle): "
      + "run_c1, run_c2; 1 continuable (run_continue hint)");
  } finally { cleanupDir(root); }
});

test("OI-A3: 可续计数负例——线系已闭合时不计", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a3-"));
  try {
    makeGitRepo(root);
    const closedLineage = [
      ...settledUndecided("run_c3", root),
      { type: "run.session_reuse", runId: "run_c3", mode: "run_lineage", turn: "first", rootRunId: "run_c3" },
      { type: "run.lineage_closed", runId: "run_c3", rootRunId: "run_c3", reason: "dropped" },
    ];
    const { lines } = await runCollect(root, {
      refs: ["wao/run_c3"],
      worktrees: [],
      eventsByRun: { run_c3: closedLineage },
    });
    assert.ok(lines[0].endsWith("): run_c3"), `线系已闭合 → 无可续计数: ${lines[0]}`);
    assert.ok(!lines[0].includes("continuable"), "无 continuable 计数");
  } finally { cleanupDir(root); }
});

test("OI-A4: 不属于本工作区的运行跳过不计；转录缺失只计数并写明去哪看", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a4-"));
  const other = mkdtempSync(join(tmpdir(), "wao-oi-a4-other-"));
  try {
    makeGitRepo(root);
    const { lines } = await runCollect(root, {
      refs: ["wao/run_o1", "wao/run_o2", "wao/run_m1"],
      worktrees: [],
      eventsByRun: {
        // cwd 是与绑定仓无关的目录 → 推导出的项目 key 不同 → 跳过（任何类都不进）。
        run_o1: settledUndecided("run_o1", other),
        // run_o2 / run_m1 不在 eventsByRun → 读失败 → 只计数。
      },
    });
    assertLineShape(lines);
    assert.equal(lines.length, 1, `外来目录不进任何类，缺失单独一行: ${JSON.stringify(lines)}`);
    assert.equal(lines[0], MISSING_LINE(2));
  } finally { cleanupDir(other); cleanupDir(root); }
});

test("OI-A5: 单条读失败只计数（其余照常分类）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a5-"));
  try {
    makeGitRepo(root);
    const { lines } = await runCollect(root, {
      refs: ["wao/run_s1", "wao/run_m2"],
      worktrees: [],
      eventsByRun: {
        run_s1: settledUndecided("run_s1", root),
        // run_m2 缺席 → 读失败
      },
    });
    assert.equal(lines.length, 2);
    assert.equal(lines[1], MISSING_LINE(1), "单条读失败计入同一行");
  } finally { cleanupDir(root); }
});

// ===== A. 归属=记录的项目身份（0113 修订） =====

test("OI-A12: 派发自已删除工作树的运行——首事件记着与绑定工作区相同的项目 key、cwd 是不存在的目录 → 计入（等裁定行与回收行各一例）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a12-"));
  try {
    makeGitRepo(root);
    const boundKey = identifyProjectFromCwd(root, TEST_PROJECT_IO).key;
    // 开发树（.dev/wt/<批>）合入后已删：run.started 的 cwd 指向一个不存在的
    // 目录——在档事实优先，推导（realpath）根本不参与，照常计入。
    const goneTree = join(root, ".dev", "wt", "b09", ".wao-worktrees", "run_gone");
    const { lines } = await runCollect(root, {
      refs: ["wao/run_g1", "wao/run_g2"],
      worktrees: [],
      eventsByRun: {
        run_g1: withRecordedFact(settledUndecided("run_g1", goneTree), projectFact(boundKey)),
        run_g2: withRecordedFact(
          [...settledUndecided("run_g2", goneTree), accepted("run_g2")],
          projectFact(boundKey),
        ),
      },
    });
    assert.equal(lines.length, 2, `两例都计入: ${JSON.stringify(lines)}`);
    assert.ok(lines[0].startsWith("open item: 1 settled delivery run(s) await a Lead decision "),
      `等裁定行计入已删树的运行: ${lines[0]}`);
    assert.ok(lines[0].includes("): run_g1"), "runId 点名");
    assert.ok(lines[0].includes(CROSS_TREE_HINT),
      "cwd 指向另一棵（已删的）工作树 → 提示按 cwd 与绑定根比较、照常给出");
    assert.ok(lines[1].startsWith("open item: 1 decided/no-delivery"), `回收行计入: ${lines[1]}`);
    assertLineShape(lines);
  } finally { cleanupDir(root); }
});

test("OI-A13: 首事件记着别的项目 key → 跳过不计（变异：key 比较改恒真时此测试必红）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a13-"));
  try {
    makeGitRepo(root);
    const other = projectFact("d:/somewhere/else/project");
    assert.notEqual(other.key, identifyProjectFromCwd(root, TEST_PROJECT_IO).key, "夹具前提：key 不同");
    const { lines } = await runCollect(root, {
      refs: ["wao/run_g3"],
      worktrees: [],
      eventsByRun: { run_g3: withRecordedFact(settledUndecided("run_g3", root), other) },
    });
    assert.deepEqual(lines, [], "别的项目 key → 不进任何行");
  } finally { cleanupDir(root); }
});

test("OI-A14: 首事件 project 坏形状（在档事实损坏）→ 不分类、不静默回退 cwd 推导，计入找不到或冲突行", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a14-"));
  try {
    makeGitRepo(root);
    const { lines } = await runCollect(root, {
      refs: ["wao/run_g4", "wao/run_g5"],
      worktrees: [],
      eventsByRun: {
        // project 在场即事实主张：非 kinded 对象 / 缺 bucket 都是损坏事实
        // （identityOfFirstEvent 的 factError）——不回退推导、不按事件分类。
        run_g4: withRecordedFact(settledUndecided("run_g4", root), "junk"),
        run_g5: withRecordedFact(settledUndecided("run_g5", root), { kind: "project", key: "x" }),
      },
    });
    assert.equal(lines.length, 1, `只出缺失/损坏一行，不出等裁定行: ${JSON.stringify(lines)}`);
    assert.equal(lines[0], MISSING_LINE(2));
  } finally { cleanupDir(root); }
});

// ===== A. 查看帽与枚举失败 =====

test("OI-A6: 超过 50 条只查看最新 50 条（排序参数敏感：旧到新的 5 条等裁定不进清单），行内写明", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a6-"));
  try {
    makeGitRepo(root);
    const total = OPEN_ITEM_BRANCH_CAP + 5;
    const refs = []; // 新到旧
    const eventsByRun = {};
    for (let i = total - 1; i >= 0; i -= 1) {
      const runId = `run_b${String(i).padStart(2, "0")}`;
      refs.push(`wao/${runId}`);
      // 最旧 5 条（b00–b04）等裁定；最新 50 条（b05–b54）无交付。
      eventsByRun[runId] = i < 5 ? settledUndecided(runId, root) : noDeliveryTerminal(runId, root);
    }
    const { lines, git, readCalls } = await runCollect(root, { refs, worktrees: [], eventsByRun, sortByFlag: true });
    assert.ok(git.calls.some((a) => a.includes("--sort=-committerdate")),
      "枚举请求新到旧排序（变异为旧到新时假 git 返回不同顺序）");
    assert.equal(readCalls.length, OPEN_ITEM_BRANCH_CAP, `只读 ${OPEN_ITEM_BRANCH_CAP} 份转录`);
    assert.equal(lines.length, 1, `最新 50 条全落留待回收 → 一行: ${JSON.stringify(lines)}`);
    assert.ok(lines[0].startsWith(`open item: ${OPEN_ITEM_BRANCH_CAP} decided/no-delivery wao/run_* branch(es) `),
      `计数是已查看的（最新）部分: ${lines[0]}`);
    assert.ok(!lines.some((l) => l.includes("await a Lead decision")),
      "最旧 5 条等裁定不在已查看的 50 条里（--sort=committerdate 变异时会进 → 此断言红）");
    assert.ok(lines[0].endsWith(`; counts cover the ${OPEN_ITEM_BRANCH_CAP} newest of ${total} wao/run_* branch(es)`),
      `行内写明总条数: ${lines[0]}`);
    assertLineShape(lines);
  } finally { cleanupDir(root); }
});

test("OI-A7: 枚举失败 → 整段 A 省略（连 worktree list 也不跑）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a7-"));
  try {
    makeGitRepo(root);
    const calls = [];
    const lines = await collectLeadOpenItems({
      authorizedWorkspaceRoot: root,
      runDir: join(root, "runs"),
      execGitFn: (args) => {
        calls.push(args);
        throw new Error("git gone");
      },
      resolveTranscriptFn: () => { throw new Error("must not resolve"); },
      readTranscriptFn: async () => { throw new Error("must not read"); },
      identifyProjectFn: (r) => ({ kind: "project", key: String(r) }),
      codeCheckoutRoot: "nowhere",
    });
    assert.deepEqual(lines, [], "枚举失败 → 零行");
    assert.equal(calls.length, 1, "只有一次枚举调用（worktree list 不再跑）");
  } finally { cleanupDir(root); }
});

// ===== A. 运行树 =====

test("OI-A8: 运行树按全仓口径数——路径以 .wao-worktrees/<合法 runId> 结尾即算，不限于绑定根下", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a8-"));
  try {
    makeGitRepo(root);
    const { lines } = await runCollect(root, {
      refs: ["wao/run_w1"],
      worktrees: [
        root,                                                       // 主检出本身 → 不数
        join(root, ".wao-worktrees", "run_x"),                      // 绑定根下 → 数
        join(root, ".dev", "wt", "b09", ".wao-worktrees", "run_y"), // 仓内别处的链接工作树 → 数（开发 Lead 形态）
        join(root, ".wao-worktrees", "run_z", "sub"),               // 深一层 → 结尾不是 runId → 不数
        join(root, ".wao-worktrees", "deploy.tmp"),                 // 结尾不是合法 runId → 不数
        join(root, ".wao-worktrees").toUpperCase(),                 // 裸 .wao-worktrees 目录 → 不数
      ],
      eventsByRun: { run_w1: [...settledUndecided("run_w1", root), accepted("run_w1")] },
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0],
      "open item: 1 decided/no-delivery wao/run_* branch(es) + 2 run worktree(s) under .wao-worktrees/" + RECLAIM_TAIL);
  } finally { cleanupDir(root); }
});

test("OI-A9: 0 分支但残留运行树 → 仍出留待回收行；worktree list 读不出则省该数", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a9-"));
  try {
    makeGitRepo(root);
    const withTrees = await runCollect(root, {
      refs: [],
      worktrees: [join(root, ".wao-worktrees", "run_z")],
      eventsByRun: {},
    });
    assert.equal(withTrees.lines.length, 1, "0 分支 + 1 棵运行树 → 仍一行");
    assert.equal(withTrees.lines[0],
      "open item: 0 decided/no-delivery wao/run_* branch(es) + 1 run worktree(s) under .wao-worktrees/" + RECLAIM_TAIL);
    // worktree list 失败 → 只有分支数，无运行树数。
    const git = fakeGit({ refs: ["wao/run_w2"] });
    const baseFn = git.fn;
    git.fn = (args) => {
      if (args[0] === "worktree") throw new Error("worktree list gone");
      return baseFn(args);
    };
    const lines = await collectLeadOpenItems({
      authorizedWorkspaceRoot: root,
      runDir: join(root, "runs"),
      execGitFn: git.fn,
      resolveTranscriptFn: (runDir, runId) => join(runDir, `${runId}.jsonl`),
      readTranscriptFn: async () => [...settledUndecided("run_w2", root), accepted("run_w2")],
      projectIo: TEST_PROJECT_IO,
      identifyProjectFn: (r) => ({ kind: "project", key: String(r) }),
      codeCheckoutRoot: "elsewhere",
    });
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("worktree(s)"), `运行树数读不出 → 省略该数: ${lines[0]}`);
  } finally { cleanupDir(root); }
});

test("OI-A10: 等裁定超过 5 个 runId → 行内至多 5 个，其余折成 (+N more)", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a10-"));
  try {
    makeGitRepo(root);
    const refs = [];
    const eventsByRun = {};
    for (let i = 0; i < 7; i += 1) {
      const runId = `run_d${i}`;
      refs.push(`wao/${runId}`);
      eventsByRun[runId] = settledUndecided(runId, root);
    }
    const { lines } = await runCollect(root, { refs, worktrees: [], eventsByRun });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("7 settled delivery run(s)"), `总数 7: ${lines[0]}`);
    assert.ok(/\(\+2 more\)$/.test(lines[0]), `截断计数在场: ${lines[0]}`);
    assert.ok(!lines[0].includes("run_d5") && !lines[0].includes("run_d6"), "只点名前 5 个");
    assertLineShape(lines);
  } finally { cleanupDir(root); }
});

// ===== A. 统一入口（不注入解析函数） =====

test("OI-A11: 缺省解析走 resolveTranscriptPathDetailed——桶内正常份被分类（runId 进等裁定行）；桶+平铺内容不同的副本计冲突不分类", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-a11-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-oi-a11-runs-"));
  try {
    makeGitRepo(root);
    // 用写侧 SSOT 建本项目桶（temp run dir 下的合成状态，不碰真实 runs/）。
    const { resolveRunDirForWrite } = await import("../../src/projectBuckets.js");
    const { identifyProjectFromCwd, productionProjectIo } = await import("../../src/projectIdentity.js");
    const { transcriptPathFor } = await import("../../src/transcript.js");
    const identity = identifyProjectFromCwd(root, productionProjectIo());
    const { transcriptDir } = resolveRunDirForWrite(runDir, identity);
    const toJsonl = (events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    // run_k1：仅桶内一份，已收口、未裁定的交付 → 应进等裁定行（runId 被点名）。
    writeFileSync(join(transcriptDir, "run_k1.jsonl"), toJsonl(settledUndecided("run_k1", root)), "utf8");
    // run_k2：桶内与平铺各一份且内容不同（平铺份多一条重复终态事件——字节不同、
    // 语义同为已收口未裁定）→ 统一入口判 conflict，不分类；两份都做成等裁定
    // 形状是刻意的——若默认入口被改成手工平铺拼路径，平铺份会被读走并混进
    // 等裁定行（run_k2 出现在该行 → 断言红）。
    writeFileSync(join(transcriptDir, "run_k2.jsonl"), toJsonl(settledUndecided("run_k2", root)), "utf8");
    writeFileSync(
      transcriptPathFor(runDir, "run_k2"),
      toJsonl([...settledUndecided("run_k2", root), terminal("run_k2", "completed")]),
      "utf8",
    );
    // run_k3：两处都没有 → 未找到，与冲突同一行。
    const git = fakeGit({ refs: ["wao/run_k1", "wao/run_k2", "wao/run_k3"], worktrees: [] });
    const lines = await collectLeadOpenItems({
      authorizedWorkspaceRoot: root,
      runDir,
      execGitFn: git.fn,
      projectIo: TEST_PROJECT_IO,
      identifyProjectFn: (r) => ({ kind: "project", key: r === root ? "proj-a" : "proj-b" }),
      codeCheckoutRoot: join(root, "code-checkout"),
    });
    assert.equal(lines.length, 2, `等裁定一行 + 冲突/缺失一行: ${JSON.stringify(lines)}`);
    assert.equal(lines[0],
      "open item: 1 settled delivery run(s) await a Lead decision (run_delivery_review_bundle): run_k1",
      "恰好 run_k1 被分类并点名（k2 冲突不静默择一——变异后平铺份混入即红）");
    assert.ok(!lines[0].includes("run_k2"), "冲突副本的 runId 不进等裁定行");
    assert.equal(lines[1], MISSING_LINE(2), "1 份冲突副本 + 1 份未找到同行计数");
  } finally { cleanupDir(runDir); cleanupDir(root); }
});

// ===== B. 收件箱 =====

// 只碰 open/ 的读函数：任何别的目录（closed/、ids/、收件箱根）被读即断言失败。
function openOnlyReadDir(names) {
  return (dir) => {
    assert.ok(String(dir).replaceAll("\\", "/").endsWith("/open"),
      `只允许读收件箱 open/ 子目录，读到: ${dir}`);
    return names;
  };
}

async function runInbox(ROOT, { readDirFn } = {}) {
  return collectLeadOpenItems({
    authorizedWorkspaceRoot: ROOT,
    runDir: join(ROOT, "runs"),
    execGitFn: fakeGit({ refs: [], worktrees: [] }).fn, // A 空转（枚举成功、零分支）
    resolveTranscriptFn: () => { throw new Error("no transcripts expected"); },
    readTranscriptFn: async () => { throw new Error("no transcripts expected"); },
    identifyProjectFn: (r) => ({ kind: "project", key: r === ROOT ? "wao-proj" : "other-proj" }),
    codeCheckoutRoot: join(ROOT, "code"), // ≠ ROOT → 不同项目
    inboxDirFn: () => join(ROOT, "inbox-root"),
    readDirFn,
  });
}

test("OI-B1: 同项目 + open/ 有合法条目 → 一行（只数合法文件名，不读内容）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-b1-"));
  try {
    makeGitRepo(root);
    const lines = await collectLeadOpenItems({
      authorizedWorkspaceRoot: root,
      runDir: join(root, "runs"),
      execGitFn: fakeGit({ refs: [], worktrees: [] }).fn,
      resolveTranscriptFn: () => { throw new Error("no transcripts expected"); },
      readTranscriptFn: async () => { throw new Error("no transcripts expected"); },
      identifyProjectFn: (r) => {
        // 同一项目：两个根都归 wao-proj（链接工作树归主工作树的场景由该判定承担，
        // 这里注入同一键模拟——真实 R8 判定在 projectIdentity 自己的测试里钉）。
        if (r === root || r === join(root, "code")) return { kind: "project", key: "wao-proj" };
        return { kind: "project", key: "other" };
      },
      codeCheckoutRoot: join(root, "code"),
      inboxDirFn: () => join(root, "inbox-root"),
      readDirFn: openOnlyReadDir([
        "fb_20261104T120000Z_abc123.json", // 合法
        "fb_20261104T120000Z_abc123.json.tmp", // 尾巴杂物
        "notes.txt",
        "fb_short.json",
      ]),
    });
    assert.deepEqual(lines,
      ["open item: 1 unprocessed feedback entry in the WAO inbox (`wao feedback list`)"]);
  } finally { cleanupDir(root); }
});

test("OI-B2: 别的项目不出行——可读收件箱在场，读函数 0 次调用（删掉同项目限制即红）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-b2-"));
  try {
    makeGitRepo(root);
    let reads = 0;
    const lines = await runInbox(root, {
      // 收件箱真实可读且有合法条目：若同项目限制被删，这里会被调用 → 行出现。
      readDirFn: (dir) => {
        reads += 1;
        assert.ok(String(dir).replaceAll("\\", "/").endsWith("/open"), `只可能读 open/: ${dir}`);
        return ["fb_20261104T120000Z_abc123.json"];
      },
    });
    assert.equal(reads, 0, "不同项目 → 收件箱读函数 0 次调用");
    assert.deepEqual(lines, [], "不同项目 → 无收件箱行（A 空转也无行）");
  } finally { cleanupDir(root); }
});

test("OI-B3: open/ 不存在（ENOENT 当 0）与目录读不出（省略）都不出行、不抛", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-b3-"));
  try {
    makeGitRepo(root);
    const sameProjectIdentify = (r) => (r === root || r === join(root, "code"))
      ? { kind: "project", key: "wao-proj" }
      : { kind: "project", key: "other" };
    const base = {
      authorizedWorkspaceRoot: root,
      runDir: join(root, "runs"),
      execGitFn: fakeGit({ refs: [], worktrees: [] }).fn,
      resolveTranscriptFn: () => { throw new Error("no transcripts expected"); },
      readTranscriptFn: async () => { throw new Error("no transcripts expected"); },
      identifyProjectFn: sameProjectIdentify,
      codeCheckoutRoot: join(root, "code"),
      inboxDirFn: () => join(root, "inbox-root"),
    };
    const missing = await collectLeadOpenItems({
      ...base,
      readDirFn: openOnlyReadDir([]),
    });
    assert.deepEqual(missing, [], "open/ 不存在当 0 → 不出行");
    const unreadable = await collectLeadOpenItems({
      ...base,
      readDirFn: (dir) => {
        assert.ok(String(dir).replaceAll("\\", "/").endsWith("/open"));
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    });
    assert.deepEqual(unreadable, [], "目录读不出 → 省略该行");
    const emptyValid = await collectLeadOpenItems({
      ...base,
      readDirFn: openOnlyReadDir(["garbage.txt", "fb_wrong.json"]),
    });
    assert.deepEqual(emptyValid, [], "无合法文件名条目 → 不出行");
  } finally { cleanupDir(root); }
});

test("OI-B4: 复数条目用 entries；A 的行在前、收件箱行在后", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-b4-"));
  try {
    makeGitRepo(root);
    const lines = await collectLeadOpenItems({
      authorizedWorkspaceRoot: root,
      runDir: join(root, "runs"),
      execGitFn: fakeGit({ refs: ["wao/run_e1"], worktrees: [] }).fn,
      resolveTranscriptFn: (runDir, runId) => join(runDir, `${runId}.jsonl`),
      readTranscriptFn: async () => noDeliveryTerminal("run_e1", root),
      projectIo: TEST_PROJECT_IO,
      identifyProjectFn: (r) => (r === root || r === join(root, "code"))
        ? { kind: "project", key: "wao-proj" }
        : { kind: "project", key: "other" },
      codeCheckoutRoot: join(root, "code"),
      inboxDirFn: () => join(root, "inbox-root"),
      readDirFn: openOnlyReadDir([
        "fb_20261104T120000Z_aaa111.json",
        "fb_20261104T120001Z_bbb222.json",
      ]),
    });
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("open item: 1 decided/no-delivery"), "A 行在前");
    assert.equal(lines[1], "open item: 2 unprocessed feedback entries in the WAO inbox (`wao feedback list`)");
    assertLineShape(lines);
  } finally { cleanupDir(root); }
});

// ===== 兜底 =====

test("OI-Z1: 非法 authorizedWorkspaceRoot → 零行不抛；空 refs → 零行", async () => {
  assert.deepEqual(await collectLeadOpenItems({}), []);
  assert.deepEqual(await collectLeadOpenItems({ authorizedWorkspaceRoot: "", runDir: "/r" }), []);
  const root = mkdtempSync(join(tmpdir(), "wao-oi-z1-"));
  try {
    makeGitRepo(root);
    const { lines } = await runCollect(root, { refs: [], worktrees: [], eventsByRun: {} });
    assert.deepEqual(lines, [], "零分支零树零条目 → 无任何行");
  } finally { cleanupDir(root); }
});

test("OI-Z2: 读侧意外抛错全部沉降（子收集器内或顶层兜底），不向上抛", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-oi-z2-"));
  try {
    makeGitRepo(root);
    // 枚举输出毒对象（String() 抛）→ A 判枚举失败省略；identify 抛 → B 省略。
    const hostile = await collectLeadOpenItems({
      authorizedWorkspaceRoot: root,
      runDir: join(root, "runs"),
      execGitFn: () => ({ toString: () => { throw new Error("hostile output"); } }),
      resolveTranscriptFn: () => "/x",
      readTranscriptFn: async () => [],
      identifyProjectFn: () => { throw new Error("identify broken"); },
      codeCheckoutRoot: join(root, "code"),
      readDirFn: () => [],
    });
    assert.deepEqual(hostile, []);
    // runDir 非字符串 → resolve 抛 → 顶层兜底 → A 省略（无论 resolve 是否抛，
    // 枚举缝也抛，两条路都收敛为零行）。
    const badRunDir = await collectLeadOpenItems({
      authorizedWorkspaceRoot: root,
      runDir: null,
      execGitFn: () => { throw new Error("git unreachable"); },
      identifyProjectFn: (r) => ({ kind: "project", key: String(r) }),
      codeCheckoutRoot: "elsewhere",
    });
    assert.deepEqual(badRunDir, []);
  } finally { cleanupDir(root); }
});
