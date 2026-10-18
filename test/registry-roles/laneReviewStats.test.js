// test/registry-roles/laneReviewStats.test.js
//
// 0089：会审席位统计（画像复核的输入）的可证伪面：
//   - 计数：每车道席位数、作答数、各结论次数；取不到 Q1 的席位算未作答；
//   - 合入会审（Q1 声明含 FIX_FIRST）里两两比较更严/更松/相同；其余会审不比较；
//   - 收集：按 consultId 去重、createdAt 落在 [since, until) 才计、坏记录跳过；
//   - 默认读法与 `wao consult show` 同源：从席位转录的最终答复取 Q1。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aggregateSeatVerdicts,
  collectConsults,
  defaultConsultDirs,
  renderLaneReviewStats,
} from "../../scripts/reliability/laneReviewStats.mjs";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const MERGE_Q1 = ["PASS", "PASS_WITH_NOTES", "FIX_FIRST"];

function record(consultId, createdAt, seats, q1 = MERGE_Q1) {
  return { consultId, createdAt, declaredFields: { Q1: q1 }, seats };
}

test("aggregateSeatVerdicts：计数、未作答、合入会审两两比较", () => {
  const lanes = aggregateSeatVerdicts([
    { mergeReview: true, seats: [{ lane: "sol", q1: "FIX_FIRST" }, { lane: "kimi", q1: "PASS_WITH_NOTES" }, { lane: "opus", q1: null }] },
    { mergeReview: true, seats: [{ lane: "sol", q1: "PASS" }, { lane: "kimi", q1: "PASS" }] },
    { mergeReview: false, seats: [{ lane: "sol", q1: "OK" }, { lane: "kimi", q1: "FOUND" }] },
  ]);
  assert.equal(lanes.sol.seats, 3);
  assert.equal(lanes.sol.answered, 3);
  assert.deepEqual(lanes.sol.verdicts, { FIX_FIRST: 1, PASS: 1, OK: 1 });
  assert.deepEqual(lanes.sol.stricterThan, { kimi: 1 });
  assert.deepEqual(lanes.sol.sameAs, { kimi: 1 });
  assert.deepEqual(lanes.kimi.lenientThan, { sol: 1 });
  assert.equal(lanes.opus.seats, 1);
  assert.equal(lanes.opus.answered, 0, "取不到 Q1 算未作答");
  assert.deepEqual(lanes.opus.stricterThan, {}, "未作答的席位不参与比较");
  assert.deepEqual(lanes.sol.lenientThan, {}, "非合入会审（OK/FOUND）不比较");
});

test("collectConsults：去重、时间窗、坏记录跳过、读不到转录算未作答", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-"));
  try {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    const seats = [{ agentId: "sol", runId: "run_s1" }, { agentId: "kimi", runId: "run_k1" }, { agentId: "opus", runId: "run_gone" }];
    writeFileSync(join(a, "consult_1.json"), JSON.stringify(record("consult_1", "2026-10-10T08:00:00.000Z", seats)));
    writeFileSync(join(b, "consult_1.json"), JSON.stringify(record("consult_1", "2026-10-10T08:00:00.000Z", seats)));
    writeFileSync(join(a, "consult_old.json"), JSON.stringify(record("consult_old", "2026-10-01T08:00:00.000Z", seats)));
    writeFileSync(join(a, "consult_late.json"), JSON.stringify(record("consult_late", "2026-10-20T08:00:00.000Z", seats)));
    writeFileSync(join(a, "consult_bad.json"), "{not json");
    writeFileSync(join(a, "notes.txt"), "ignored");
    const replies = { run_s1: "Q1: FIX_FIRST\n理由", run_k1: "Q1: PASS_WITH_NOTES\n理由" };
    const observeFn = async ({ runId }) => {
      if (!(runId in replies)) throw new Error("transcript unreadable");
      return { finalText: replies[runId] };
    };
    const consults = await collectConsults({ dirs: [a, b], runDir: join(dir, "runs"), since: "2026-10-06", until: "2026-10-18", observeFn });
    assert.deepEqual(consults.map((c) => c.consultId), ["consult_1"], "按 consultId 去重；窗外与坏记录不计");
    assert.equal(consults[0].mergeReview, true);
    assert.deepEqual(consults[0].seats, [
      { lane: "sol", q1: "FIX_FIRST" },
      { lane: "kimi", q1: "PASS_WITH_NOTES" },
      { lane: "opus", q1: null },
    ]);
    const report = renderLaneReviewStats({ consults, lanes: aggregateSeatVerdicts(consults) });
    assert.match(report, /^consults 1, merge reviews 1/);
    assert.match(report, /sol: seats 1, answered 1 \(FIX_FIRST 1\)/);
  } finally { cleanupDir(dir); }
});

test("collectConsults：默认读法从席位转录的最终答复取 Q1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-real-"));
  try {
    const consults = join(dir, "consults");
    const runDir = join(dir, "runs");
    mkdirSync(consults);
    mkdirSync(runDir);
    const event = (text) => JSON.stringify({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text }], runId: "run_real1", ts: "2026-10-10T08:01:00.000Z" });
    writeFileSync(join(runDir, "run_real1.jsonl"), [event("先看一下文件。"), event("Q1: PASS_WITH_NOTES\n\n理由与证据。")].join("\n") + "\n");
    writeFileSync(join(consults, "consult_r.json"), JSON.stringify(record("consult_r", "2026-10-10T08:00:00.000Z", [{ agentId: "kimi", runId: "run_real1" }])));
    const out = await collectConsults({ dirs: [consults], runDir });
    assert.deepEqual(out[0].seats, [{ lane: "kimi", q1: "PASS_WITH_NOTES" }], "只看最后一条答复");
  } finally { cleanupDir(dir); }
});

test("defaultConsultDirs：本检出、各开发工作树与归档目录，只列存在的", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lrs-dirs-"));
  try {
    mkdirSync(join(dir, ".wao", "runs", "consults"), { recursive: true });
    mkdirSync(join(dir, ".dev", "wt", "batch1", ".wao", "runs", "consults"), { recursive: true });
    mkdirSync(join(dir, ".dev", "wt", "batch2"), { recursive: true });
    mkdirSync(join(dir, "runs-archive", "2026-10", "consult-records-dev-worktrees", "batch0"), { recursive: true });
    assert.deepEqual(defaultConsultDirs(dir), [
      join(dir, ".wao", "runs", "consults"),
      join(dir, ".dev", "wt", "batch1", ".wao", "runs", "consults"),
      join(dir, "runs-archive", "2026-10", "consult-records-dev-worktrees", "batch0"),
    ]);
  } finally { cleanupDir(dir); }
});
