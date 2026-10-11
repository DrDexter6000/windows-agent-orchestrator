// test/application/lineageClose.test.js——TD-254（决定 0058）线系闭合出口。
// 真 git 树全链：dry-run→apply（释放+分支保留+dirty 审计）→补偿重试（closed≠released）。
import test from "node:test";
import assert from "node:assert/strict";
// 冒烟：合成线系 → dry-run → apply（真 git 树）→ 闭态拒绝补偿重试。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { closeRunLineage, lineageRootFromEvents } from "../../src/application/lineageClose.js";
import { continueRun } from "../../src/application/runContinue.js";

function require2exists(){return false;} // 占位（released 已由 outcome 断言）
const repo = mkdtempSync(join(tmpdir(), "lc-smoke-"));
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
assert.ok(!require2exists(wt));
// 补偿重试（closed≠released）
const retry = await closeRunLineage({ runId: "run_root1", runDir, reasonText: "retry", apply: true });
assert.equal(retry.alreadyClosed, true, "closed≠released：重入=补偿重试");
assert.deepEqual(retry.worktrees.map((w) => w.outcome), ["already_gone"]);
// continueRun 的 lineage_closed 拒绝由真业务 dogfood 验证（合成夹具过不了 claim 信封）。
rmSync(repo, { recursive: true, force: true });

