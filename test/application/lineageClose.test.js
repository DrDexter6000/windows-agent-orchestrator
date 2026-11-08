// test/application/lineageClose.test.js——TD-254（决定 0058）线系闭合出口。
// 真 git 树全链：dry-run→apply（释放+分支保留+dirty 审计）→补偿重试（closed≠released）。
//
// 形状纪律（TD-255 修复）：断言必须住在 test() 块内。零 test() 的顶层脚本文件在
// `node --test` 下 exit 0（单跑判 pass），但 reporter 只为"子测试事件"建 suite——
// 波内永远 missing（canonical-test.mjs mapReportToFiles）。夹具构建一并住进
// test()（会审补充：顶层构建抛错时 finally 不罩、临时仓泄漏）。构建用的
// execSync 本身隐含"命令必须成功"的断言（失败即抛），但它不构成对 WAO 行为
// 的主张——行为主张全部由显式断言承担。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { closeRunLineage } from "../../src/application/lineageClose.js";

test("TD-254 冒烟：合成线系 dry-run→apply→补偿重试全链（真 git 树）", async () => {
  const repo = mkdtempSync(join(tmpdir(), "lc-smoke-"));
  try {
    const runDir = join(repo, "runs");
    mkdirSync(runDir, { recursive: true });
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "a.txt"), "a\n");
    execSync("git add . && git commit -qm init", { cwd: repo, stdio: "ignore" });
    const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    // 根线系树：wao/run_root 分支 @ base（未打包成员 HEAD 证明=baseCommit）
    const wt = join(repo, ".wao-worktrees", "run_root1");
    execSync(`git worktree add -b wao/run_root1 "${wt}" ${base}`, { cwd: repo, stdio: "ignore" });
    // 根转录
    const rootJsonl = [
      { type: "run.started", runId: "run_root1", agentId: "sol", backend: "codex", worktreePath: wt, cwd: repo, delivery: { baseCommit: base }, seq: 1 },
      { type: "run.session_reuse", runId: "run_root1", rootRunId: "run_root1", mode: "run_lineage", turn: "first", seq: 2 },
      { type: "run.state_change", runId: "run_root1", to: "completed", seq: 3 },
      { type: "run.cleanup_done", runId: "run_root1", seq: 4 },
    ];
    writeFileSync(join(runDir, "run_root1.jsonl"), rootJsonl.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const dry = await closeRunLineage({ runId: "run_root1", runDir, reasonText: "smoke 放弃", apply: false });
    assert.equal(dry.rootRunId, "run_root1");
    assert.deepEqual(dry.worktrees.map((w) => w.outcome), ["planned"]);
    const app = await closeRunLineage({ runId: "run_root1", runDir, reasonText: "smoke 放弃：验证线系闭合出口全链", apply: true });
    assert.equal(app.closedNow, true);
    assert.deepEqual(app.worktrees.map((w) => w.outcome), ["released"]);
    assert.deepEqual(app.branchesKept, ["wao/run_root1"], "分支保留（0035 S5 偏离在案）");
    // 补偿重试（closed≠released）
    const retry = await closeRunLineage({ runId: "run_root1", runDir, reasonText: "retry", apply: true });
    assert.equal(retry.alreadyClosed, true, "closed≠released：重入=补偿重试");
    assert.deepEqual(retry.worktrees.map((w) => w.outcome), ["already_gone"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// continueRun 的 lineage_closed 拒绝由真业务 dogfood 验证（合成夹具过不了 claim 信封）。

// TD-256 修复钉（opus/sol 会审双实锤）：占用门旧查 join(runDir,".wao","session-reuse")
// ——不存在的目录，门从未触发。真槽位是 runDir/.session-reuse 与 runDir/.lineage-reuse。
test("TD-256: 占用门真路径——新鲜槽条目（.session-reuse/.lineage-reuse）拒 lineage_busy；陈旧不堵", async () => {
  const repo = mkdtempSync(join(tmpdir(), "lc-slot-"));
  try {
    const runDir = join(repo, "runs");
    mkdirSync(runDir, { recursive: true });
    const events = [
      { type: "run.started", runId: "run_slot1", agentId: "sol", backend: "codex", worktreePath: join(repo, "wt"), cwd: repo, seq: 1 },
      { type: "run.state_change", runId: "run_slot1", to: "completed", seq: 2 },
      { type: "run.cleanup_done", runId: "run_slot1", seq: 3 },
    ];
    writeFileSync(join(runDir, "run_slot1.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const writeSlot = (dir, entry) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "abc123.json"), JSON.stringify(entry), "utf8");
    };
    // 新鲜 .session-reuse 槽 → 拒
    writeSlot(join(runDir, ".session-reuse"), { runId: "run_slot1", updatedAt: Date.now() });
    let r = await closeRunLineage({ runId: "run_slot1", runDir, reasonText: "占用门钉", apply: false });
    assert.equal(r.refuse, "lineage_busy");
    assert.equal(r.busyRunId, "run_slot1");
    assert.ok(String(r.slotDir).endsWith(".session-reuse"), `slotDir 如实上报：${r.slotDir}`);
    // 换 .lineage-reuse 新鲜槽 → 同样拒
    rmSync(join(runDir, ".session-reuse"), { recursive: true, force: true });
    writeSlot(join(runDir, ".lineage-reuse"), { runId: "run_slot1", updatedAt: Date.now() });
    r = await closeRunLineage({ runId: "run_slot1", runDir, reasonText: "占用门钉", apply: false });
    assert.equal(r.refuse, "lineage_busy", ".lineage-reuse 同款占用");
    // 陈旧槽（>SLOT_RECENT_MS=300s）→ 不堵（观察门只罩新鲜窗口）
    writeSlot(join(runDir, ".lineage-reuse"), { runId: "run_slot1", updatedAt: Date.now() - 400_000 });
    r = await closeRunLineage({ runId: "run_slot1", runDir, reasonText: "占用门钉", apply: false });
    assert.equal(r.refuse, undefined, `陈旧槽不堵（got ${JSON.stringify(r).slice(0, 120)}）`);
    assert.equal(r.rootRunId, "run_slot1");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── worktree reclaim 批扩展：成员枚举并进归档面 + 槽目录判定导出共用 ──

test("成员枚举含归档面：runs-archive/<yyyy-mm>/ 里的线系成员被算进来（释放面覆盖它）", async () => {
  const repo = mkdtempSync(join(tmpdir(), "lc-arch-"));
  try {
    const runDir = join(repo, "runs");
    mkdirSync(runDir, { recursive: true });
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "a.txt"), "a\n");
    execSync("git add . && git commit -qm init", { cwd: repo, stdio: "ignore" });
    const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    const wt = join(repo, ".wao-worktrees", "run_root9");
    execSync(`git worktree add -b wao/run_root9 "${wt}" ${base}`, { cwd: repo, stdio: "ignore" });
    // 根转录在 runs/；成员转录只在归档里（按龄归档、线系未闭合的形态）。
    writeFileSync(join(runDir, "run_root9.jsonl"), [
      { type: "run.started", runId: "run_root9", agentId: "sol", backend: "codex", worktreePath: wt, cwd: repo, delivery: { baseCommit: base }, seq: 1 },
      { type: "run.state_change", runId: "run_root9", to: "completed", seq: 2 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const archiveDir = join(repo, "runs-archive", "2026-09");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(join(archiveDir, "run_mem9.jsonl"), [
      { type: "run.session_reuse", runId: "run_mem9", rootRunId: "run_root9", mode: "run_lineage", turn: "resume", seq: 1 },
      { type: "run.state_change", runId: "run_mem9", to: "completed", seq: 2 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const dry = await closeRunLineage({ runId: "run_root9", runDir, reasonText: "归档成员钉", apply: false });
    assert.deepEqual(
      dry.members.map((m) => m.runId).sort(),
      ["run_mem9", "run_root9"],
      "归档转录里的成员必须被枚举（否则闭合面漏掉它）",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("lineageSlotClaimBusy 导出：成员新鲜认领 busy、非成员/陈旧不堵", async () => {
  const repo = mkdtempSync(join(tmpdir(), "lc-slotx-"));
  try {
    const runDir = join(repo, "runs");
    mkdirSync(runDir, { recursive: true });
    const slotDir = join(runDir, ".lineage-reuse");
    mkdirSync(slotDir, { recursive: true });
    const now = 1_000_000;
    writeFileSync(join(slotDir, "k.json"), JSON.stringify({ runId: "run_m", updatedAt: now - 1000 }), "utf8");
    const { lineageSlotClaimBusy } = await import("../../src/application/lineageClose.js");
    const busy = await lineageSlotClaimBusy(runDir, new Set(["run_m"]), { nowMs: () => now });
    assert.equal(busy.busy, true);
    assert.equal(busy.busyRunId, "run_m");
    const otherMember = await lineageSlotClaimBusy(runDir, new Set(["run_z"]), { nowMs: () => now });
    assert.equal(otherMember.busy, false, "非成员认领不堵");
    const stale = await lineageSlotClaimBusy(runDir, new Set(["run_m"]), { nowMs: () => now + 400_000 });
    assert.equal(stale.busy, false, "陈旧认领不堵");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── TD-338 修复钉：传入子运行 id 时，闭合事实必须读写根运行自己的转录 ──
// 旧缺陷：rootRunId 推导正确，但 rootPath 没跟着换——run.lineage_closed 追加进
// 子运行转录，而续修门（runContinue 读根转录）与回收计划（worktreeReclaim 读根
// 转录）都看不到，线系实际没关。续修资格断言用 runContinue 的
// deliveryContinuableHint（同一闭态判定 SSOT：根是别的 run 时读根转录）。
test("TD-338: 子运行 id close——run.lineage_closed 落根转录、子转录不增行，续修资格读到已关闭", async () => {
  const repo = mkdtempSync(join(tmpdir(), "lc-child-"));
  try {
    const runDir = join(repo, "runs");
    mkdirSync(runDir, { recursive: true });
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "a.txt"), "a\n");
    execSync("git add . && git commit -qm init", { cwd: repo, stdio: "ignore" });
    const base = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    const wt = join(repo, ".wao-worktrees", "run_root2");
    execSync(`git worktree add -b wao/run_root2 "${wt}" ${base}`, { cwd: repo, stdio: "ignore" });
    const rootFile = join(runDir, "run_root2.jsonl");
    writeFileSync(rootFile, [
      { type: "run.started", runId: "run_root2", agentId: "sol", backend: "codex", worktreePath: wt, cwd: repo, delivery: { baseCommit: base }, seq: 1 },
      { type: "run.session_reuse", runId: "run_root2", rootRunId: "run_root2", mode: "run_lineage", turn: "first", seq: 2 },
      { type: "run.state_change", runId: "run_root2", to: "completed", seq: 3 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const childFile = join(runDir, "run_child2.jsonl");
    writeFileSync(childFile, [
      { type: "run.started", runId: "run_child2", agentId: "sol", backend: "codex", worktreePath: null, cwd: repo, seq: 1 },
      { type: "run.session_reuse", runId: "run_child2", rootRunId: "run_root2", mode: "run_lineage", turn: "resume", seq: 2 },
      { type: "run.state_change", runId: "run_child2", to: "failed", seq: 3 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const childBefore = readFileSync(childFile, "utf8");

    // 续修资格（根是别的 run → 读根转录判闭态）：闭合前可续。
    const { deliveryContinuableHint } = await import("../../src/application/runContinue.js");
    const { readTranscript } = await import("../../src/transcript.js");
    assert.equal(
      await deliveryContinuableHint({ events: await readTranscript(childFile), runId: "run_child2", runDir }),
      true,
      "闭合前：根转录无 run.lineage_closed，线系未关",
    );

    const dry = await closeRunLineage({ runId: "run_child2", runDir, reasonText: "TD-338 子 id 闭合", apply: false });
    assert.equal(dry.rootRunId, "run_root2", "从子转录推导出根 id");
    assert.equal(dry.requestedRunId, "run_child2", "干跑报出实际请求的是子 id");
    assert.equal(dry.alreadyClosed, false, "闭态读的是根转录");
    assert.deepEqual(dry.worktrees.map((w) => w.outcome), ["planned"]);

    const app = await closeRunLineage({ runId: "run_child2", runDir, reasonText: "TD-338 子 id 闭合：事实必须落根转录", apply: true });
    assert.equal(app.closedNow, true);
    assert.equal(app.rootRunId, "run_root2");
    assert.equal(app.requestedRunId, "run_child2");
    assert.deepEqual(app.worktrees.map((w) => w.outcome), ["released"]);

    // 闭合事实在根转录里（信封绑定 rootRunId）……
    const rootAfter = await readTranscript(rootFile);
    const closedFacts = rootAfter.filter((e) => e && e.type === "run.lineage_closed");
    assert.equal(closedFacts.length, 1, "run.lineage_closed 恰一条");
    assert.equal(closedFacts[0].runId, "run_root2", "事实信封绑定根 run");
    // ……子运行转录逐字节不变（不增行）。
    assert.equal(readFileSync(childFile, "utf8"), childBefore, "子转录不被追加");

    // 续修资格读到已关闭（读根转录）。
    assert.equal(
      await deliveryContinuableHint({ events: await readTranscript(childFile), runId: "run_child2", runDir }),
      false,
      "闭合后：根转录 bound run.lineage_closed 在场，线系已关",
    );

    // 传根 id：结果不带 requestedRunId（行为逐字节不变钉），且能看到已闭合。
    const dryRoot = await closeRunLineage({ runId: "run_root2", runDir, reasonText: "根 id 重入干跑", apply: false });
    assert.equal(dryRoot.requestedRunId, undefined, "根 id 干跑不出现 requestedRunId");
    assert.equal(dryRoot.alreadyClosed, true, "根转录里的闭态被看到");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("TD-338: 子运行 id close——根转录缺失 → root_missing 拒绝（不往读不回来的地方写事实）", async () => {
  const repo = mkdtempSync(join(tmpdir(), "lc-childmiss-"));
  try {
    const runDir = join(repo, "runs");
    mkdirSync(runDir, { recursive: true });
    // 只有子转录指向一个不存在的根；成员枚举也找不到根。
    writeFileSync(join(runDir, "run_orphan3.jsonl"), [
      { type: "run.started", runId: "run_orphan3", agentId: "sol", backend: "codex", seq: 1 },
      { type: "run.session_reuse", runId: "run_orphan3", rootRunId: "run_ghost3", mode: "run_lineage", turn: "resume", seq: 2 },
      { type: "run.state_change", runId: "run_orphan3", to: "completed", seq: 3 },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const r = await closeRunLineage({ runId: "run_orphan3", runDir, reasonText: "根缺失钉", apply: false });
    assert.equal(r.refuse, "root_missing");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
