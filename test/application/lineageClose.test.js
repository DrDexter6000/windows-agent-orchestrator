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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
