// test/application/lineageSupersession.test.js
//
// 第 120 批：由谱系派生"被取代"（application/lineageSupersession.js）。纯派生：
// 不写事件、不改 acceptance。夹具全部写在 os.tmpdir() 下的临时 run 目录
//（平铺 / 项目桶 / runs-archive），从不指向仓库 runs/。
//
// 钉住：
//   1. 链 A→B→C 采纳 C：A、B 被取代，supersededByRunId 都指向 C；
//   2. 兄弟 A→B、A→C 只采纳 C：A 被取代，B 待裁决（不传染）；
//   3. 末代 C 被拒收：祖先不推导（拒收不上传）；
//   4. X 自己有裁决事件：按自己的裁决，不出派生字段；
//   5. 谱系显式关闭：不出派生字段（优先于派生）；
//   6. 父边坏（缺失/重复/冲突/成环/根不一致/读不出）：一律不推导；
//   7. 只有 priorRunId 连着：不推导（复用槽的 priorRunId 不是交付父边）；
//   8. 被采纳的后代转录在归档里：仍推导；
//   9. 同一次请求内按根缓存（重复查询不重复读转录）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

import { createLineageSupersession, supersessionCandidateGate } from "../../src/application/lineageSupersession.js";
import { lineageMemberFiles } from "../../src/application/lineageClose.js";
import { readTranscript } from "../../src/transcript.js";

const BASE = "b".repeat(40);
const DELIVERED = "d".repeat(40);
const OLD_TS = "2026-01-01T00:00:00.000Z";

// ===== 夹具 =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "wao-lineage-supersede-"));
}

/** 已验证、可采纳的 DeliveryRef（created / outcome / decision 三处同形）。 */
function ref(runId, over = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: BASE,
    deliveryCommit: DELIVERED,
    branch: `wao/${runId}`,
    worktreePath: `D:/fake/${runId}`,
    changedFiles: ["src/a.js"],
    verification: { status: "passed", commands: [], verifiedCommit: DELIVERED, results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...over,
  };
}

/** 已打包 + 验证 passed（= 可以合法采纳的交付链）。 */
function packaged(runId) {
  const r = ref(runId);
  return [
    { type: "run.delivery_created", runId, delivery: r },
    { type: "run.delivery_verification_passed", runId, delivery: r },
  ];
}
function accepted(runId) {
  return {
    type: "run.delivery_accepted",
    runId,
    delivery: ref(runId, { acceptance: { status: "accepted", reviewerType: "lead_agent" } }),
    deliveryCommit: DELIVERED,
    reason: "ok",
  };
}
function rejected(runId) {
  return {
    type: "run.delivery_rejected",
    runId,
    delivery: ref(runId, { acceptance: { status: "rejected", reviewerType: "lead_agent" } }),
    deliveryCommit: DELIVERED,
    reason: "no",
  };
}
function completed(runId) {
  return { type: "run.state_change", runId, from: "running", to: "completed", reason: "done" };
}
function rootLineage(runId) {
  return { type: "run.session_reuse", runId, mode: "run_lineage", turn: "first", rootRunId: runId };
}
function resumeLineage(runId, rootRunId, over = {}) {
  return { type: "run.session_reuse", runId, mode: "run_lineage", turn: "resume", rootRunId, ...over };
}
function continuationFact(runId, parentRunId, rootRunId) {
  return { type: "run.background_submitted", runId, continuation: true, parentRunId, rootRunId };
}

/** 链的根：首事件 run.session_reuse（turn:first），随后是交付链。 */
function rootRun(runId, { decision = null } = {}) {
  return [
    rootLineage(runId),
    completed(runId),
    ...packaged(runId),
    ...(decision === "accepted" ? [accepted(runId)] : decision === "rejected" ? [rejected(runId)] : []),
  ];
}

/** 续修子运行：首事件必须是 runId 绑定的续修事实，随后 session_reuse(resume)。 */
function childRun(childRunId, parentRunId, rootRunId, { decision = null, packagedDelivery = true } = {}) {
  return [
    continuationFact(childRunId, parentRunId, rootRunId),
    resumeLineage(childRunId, rootRunId),
    completed(childRunId),
    ...(packagedDelivery ? packaged(childRunId) : []),
    ...(decision === "accepted" ? [accepted(childRunId)] : decision === "rejected" ? [rejected(childRunId)] : []),
  ];
}

/**
 * 种一份转录。where：缺省平铺；{ bucket } = <runDir>/projects/<bucket>/；
 * { archiveMonth } = <dirname(runDir)>/runs-archive/<month>/（归档面）。
 */
function seed(runDir, runId, events, where = {}) {
  let dir = runDir;
  if (where.bucket) dir = join(runDir, "projects", where.bucket);
  if (where.archiveMonth) dir = join(dirname(runDir), "runs-archive", where.archiveMonth);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${runId}.jsonl`),
    events.map((e, i) => JSON.stringify({ ts: OLD_TS, seq: i + 1, runId, agentId: "coder_low", ...e })).join("\n") + "\n",
    "utf8",
  );
  return dir;
}

function reader(runDir, over = {}) {
  return createLineageSupersession({ runDir, ...over });
}

function supersededOf(supersession, runId) {
  return supersession.forRunId(runId).then((r) => r.supersededByRunId);
}

// ===== 1. 链 A→B→C 采纳 C =====

test("LS-1: 链 A→B→C 采纳 C——A、B 都被取代，supersededByRunId 都指向 C", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a"));
    seed(runDir, "run_c", childRun("run_c", "run_b", "run_a", { decision: "accepted" }));
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), "run_c");
    assert.equal(await supersededOf(s, "run_b"), "run_c");
    assert.equal(await supersededOf(s, "run_c"), null, "已采纳的后代自己没有派生字段");
    const root = await s.forRoot("run_a");
    assert.equal(root.lineageClosed, false);
    assert.deepEqual([...root.byRunId.keys()].sort(), ["run_a", "run_b"]);
  } finally { cleanupDir(runDir); }
});

// ===== 2. 兄弟不传染 =====

test("LS-2: 兄弟 A→B、A→C 只采纳 C——A 被取代，B 仍待裁决", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a"));
    seed(runDir, "run_c", childRun("run_c", "run_a", "run_a", { decision: "accepted" }));
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), "run_c");
    assert.equal(await supersededOf(s, "run_b"), null, "兄弟不传染");
  } finally { cleanupDir(runDir); }
});

// ===== 3. 拒收不上传 =====

test("LS-3: 末代 C 被拒收——A、B 都不推导（保持待裁决）", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a"));
    seed(runDir, "run_c", childRun("run_c", "run_b", "run_a", { decision: "rejected" }));
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), null);
    assert.equal(await supersededOf(s, "run_b"), null);
  } finally { cleanupDir(runDir); }
});

// ===== 4. X 自己的裁决优先 =====

test("LS-4: A 自己已有裁决事件——按 A 自己的裁决，不出派生字段", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a", { decision: "rejected" }));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    let s = reader(runDir);
    const a = await s.forRunId("run_a");
    assert.equal(a.decided, true, "夹具前提：A 自己有裁决");
    assert.equal(a.supersededByRunId, null, "自身显式裁决优先于派生被取代");
    // accepted 也是一样：不派生。
    seed(runDir, "run_a", rootRun("run_a", { decision: "accepted" }));
    s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), null);
  } finally { cleanupDir(runDir); }
});

// ===== 5. 谱系显式关闭 =====

test("LS-5: 谱系显式关闭——不出派生字段（关闭优先于派生）", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", [
      ...rootRun("run_a"),
      { type: "run.lineage_closed", runId: "run_a", rootRunId: "run_a", reason: "dropped" },
    ]);
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    const s = reader(runDir);
    const a = await s.forRunId("run_a");
    assert.equal(a.lineageClosed, true);
    assert.equal(a.supersededByRunId, null);
    const root = await s.forRoot("run_a");
    assert.equal(root.byRunId.size, 0, "关闭的谱系不再派生");
  } finally { cleanupDir(runDir); }
});

// ===== 6. 父边坏 =====

test("LS-6a: 父边缺失（子运行没有续修事实）——不推导", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    // run_b 有谱系根，但没有 run.background_submitted 续修事实。
    seed(runDir, "run_b", [resumeLineage("run_b", "run_a"), completed("run_b"), ...packaged("run_b"), accepted("run_b")]);
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), null);
  } finally { cleanupDir(runDir); }
});

test("LS-6b: 父边重复（两条续修事实）——不推导", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", [
      continuationFact("run_b", "run_a", "run_a"),
      continuationFact("run_b", "run_a", "run_a"),
      resumeLineage("run_b", "run_a"),
      completed("run_b"),
      ...packaged("run_b"),
      accepted("run_b"),
    ]);
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), null);
  } finally { cleanupDir(runDir); }
});

test("LS-6c: 父边冲突（续修事实指向别的父 / 根不一致）——不推导", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    // 续修事实的根与子运行自己的谱系根不一致。
    seed(runDir, "run_b", [
      continuationFact("run_b", "run_a", "run_other"),
      resumeLineage("run_b", "run_a"),
      completed("run_b"),
      ...packaged("run_b"),
      accepted("run_b"),
    ]);
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), null);
  } finally { cleanupDir(runDir); }
});

test("LS-6d: 成环（A→B 且 B→A，环包含根）——整根不推导", async () => {
  const runDir = makeRunDir();
  try {
    // B 是 A 的续修子；A 的续修事实又指向 B（根都记为 A——两边各自"根一致"）。
    seed(runDir, "run_a", [
      continuationFact("run_a", "run_b", "run_a"),
      rootLineage("run_a"),
      completed("run_a"),
      ...packaged("run_a"),
    ]);
    seed(runDir, "run_b", [
      continuationFact("run_b", "run_a", "run_a"),
      resumeLineage("run_b", "run_a"),
      completed("run_b"),
      ...packaged("run_b"),
      accepted("run_b"),
    ]);
    const s = reader(runDir);
    const root = await s.forRoot("run_a");
    assert.equal(root.byRunId.size, 0, "成环时整条谱系不推导");
    assert.equal(await supersededOf(s, "run_a"), null);
  } finally { cleanupDir(runDir); }
});

test("LS-6e: 父转录读不出——不推导", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    // 让 A 的转录撕裂（JSON 解析失败）：线系枚举拒绝，不推导。
    writeFileSync(join(runDir, "run_a.jsonl"), "{ not jsonl\n", "utf8");
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), null);
  } finally { cleanupDir(runDir); }
});

// ===== 7. 只有 priorRunId 连着 =====

test("LS-7: 只有复用槽的 priorRunId 连着——不推导（不是交付父边）", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    // 复用槽形状：session_reuse 带 priorRunId，但没有 continuation 的
    // run.background_submitted——priorRunId 不是父边。
    seed(runDir, "run_b", [
      resumeLineage("run_b", "run_a", { priorRunId: "run_a" }),
      completed("run_b"),
      ...packaged("run_b"),
      accepted("run_b"),
    ]);
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), null);
  } finally { cleanupDir(runDir); }
});

// ===== 8. 归档面 =====

test("LS-8: 被采纳的后代转录在归档里——仍推导", async () => {
  const runDir = join(makeRunDir(), "runs");
  try {
    mkdirSync(runDir, { recursive: true });
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a"));
    // C 已按龄归档：不在 runs/ 平铺、也不在项目桶，只在 runs-archive/<yyyy-mm>/。
    seed(runDir, "run_c", childRun("run_c", "run_b", "run_a", { decision: "accepted" }), {
      archiveMonth: "2026-01",
    });
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), "run_c");
    assert.equal(await supersededOf(s, "run_b"), "run_c");
  } finally { cleanupDir(dirname(runDir)); }
});

test("LS-8b: 项目桶里的转录同样进枚举（后代采纳）", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"), { bucket: "proj-slug" });
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a"), { bucket: "proj-slug" });
    seed(runDir, "run_c", childRun("run_c", "run_b", "run_a", { decision: "accepted" }), { bucket: "proj-slug" });
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), "run_c");
  } finally { cleanupDir(runDir); }
});

// ===== 9. 按根缓存 =====

test("LS-9: 同一次请求内按根缓存——重复查询不重复读转录", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    let reads = 0;
    const s = reader(runDir, {
      readTranscriptFn: async (path) => {
        reads += 1;
        return readTranscript(path);
      },
    });
    assert.equal(await supersededOf(s, "run_a"), "run_b");
    const afterFirst = reads;
    assert.equal(await supersededOf(s, "run_a"), "run_b");
    assert.equal(await supersededOf(s, "run_b"), null);
    assert.equal(reads, afterFirst, "同一实例的重复派生不再读转录");
    // 新实例 = 新请求：重新读（不跨请求共享缓存）。
    const fresh = reader(runDir, {
      readTranscriptFn: async (path) => { reads += 1; return readTranscript(path); },
    });
    assert.equal(await supersededOf(fresh, "run_a"), "run_b");
    assert.ok(reads > afterFirst, "新实例重新读转录");
  } finally { cleanupDir(runDir); }
});

// ===== 边界：没有谱系的普通运行 =====

test("LS-10: 没有谱系事实的普通交付运行——不派生、也不枚举（零后代）", async () => {
  const runDir = makeRunDir();
  try {
    let reads = 0;
    seed(runDir, "run_solo", [...packaged("run_solo"), completed("run_solo")]);
    const s = reader(runDir, {
      readTranscriptFn: async (path) => { reads += 1; return readTranscript(path); },
    });
    const solo = await s.forRunId("run_solo");
    assert.equal(solo.supersededByRunId, null);
    assert.equal(solo.packaged, true);
    assert.equal(solo.decided, false);
    assert.equal(solo.lineageClosed, false);
    assert.equal(reads, 1, "只读本 run 自己的转录，不做全库枚举");
  } finally { cleanupDir(runDir); }
});

test("LS-11: 读不出 / 不存在的运行——transcriptReadable:false，不推导", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    const s = reader(runDir);
    const missing = await s.forRunId("run_nope");
    assert.equal(missing.transcriptReadable, false);
    assert.equal(missing.supersededByRunId, null);
    assert.equal(await supersededOf(s, "run_a"), null);
  } finally { cleanupDir(runDir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 120 批续修（sol/opus 审查）：把复现过的反例逐条固化。
// ═══════════════════════════════════════════════════════════════════════════

function startedEvent(runId, cwd) {
  return { type: "run.started", runId, backend: "test", cwd };
}

/** 只打包、验证仍 pending 的交付链（未收口）。 */
function packagedPending(runId) {
  const r = ref(runId, { verification: { status: "pending", commands: [], verifiedCommit: DELIVERED, results: [] } });
  return [{ type: "run.delivery_created", runId, delivery: r }];
}

test("LS-12 (审查 A3): 中间缺父——B 的父运行不在库里，C 合法指向 B 并已采纳 → B、根都不推导", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_r", rootRun("run_r"));
    // B 属于根 R，但它的父运行（run_missing）不存在 → B 的父边不成，B 连不回根。
    seed(runDir, "run_b", [
      continuationFact("run_b", "run_missing", "run_r"),
      resumeLineage("run_b", "run_r"),
      ...packaged("run_b"),
      completed("run_b"),
    ]);
    seed(runDir, "run_c", childRun("run_c", "run_b", "run_r", { decision: "accepted" }));
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_b"), null, "B 自身没连回根 → 不推导");
    assert.equal(await supersededOf(s, "run_r"), null, "断链不算通向后代");
    assert.equal((await s.forRoot("run_r")).byRunId.size, 0);
  } finally { cleanupDir(runDir); }
});

test("LS-13 (审查 A3): 根转录自称属于另一根 → 整根不推导", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_r", [
      resumeLineage("run_r", "run_other"),
      ...packaged("run_r"),
      completed("run_r"),
    ]);
    seed(runDir, "run_c", childRun("run_c", "run_r", "run_r", { decision: "accepted" }));
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_r"), null);
    assert.equal((await s.forRoot("run_r")).byRunId.size, 0);
  } finally { cleanupDir(runDir); }
});

test("LS-14 (审查 A3): 一个转录里多条互相矛盾的 session_reuse → 根不一致，整根不推导", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_r", rootRun("run_r"));
    // C 的首事件事实声明根 R（合法进谱系），但转录里又有一条 rootRunId=run_x 的
    // session_reuse：lineageRootFromEvents 取首条、continuableLineageFact 取末条，
    // 这个分歧必须按根不一致处理。
    seed(runDir, "run_c", [
      continuationFact("run_c", "run_r", "run_r"),
      resumeLineage("run_c", "run_r"),
      resumeLineage("run_c", "run_x"),
      ...packaged("run_c"),
      completed("run_c"),
      accepted("run_c"),
    ]);
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_r"), null);
    assert.equal((await s.forRoot("run_r")).byRunId.size, 0);
  } finally { cleanupDir(runDir); }
});

test("LS-15 (审查 A4): 旁支成员有内容不同的副本 → 整根不推导（即使合法采纳后代可读）", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_r", rootRun("run_r"));
    seed(runDir, "run_c", childRun("run_c", "run_r", "run_r", { decision: "accepted" }));
    // 旁支成员（只绑根、无父边）在桶里另有一份内容不同的副本。
    const side = [resumeLineage("run_side", "run_r"), ...packaged("run_side"), completed("run_side")];
    seed(runDir, "run_side", side);
    seed(runDir, "run_side", [...side, { type: "run.state_change", runId: "run_side", from: "running", to: "completed", reason: "done" }], { bucket: "p" });
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_r"), null, "旁支副本冲突 → 整根拒绝");
    assert.equal((await s.forRoot("run_r")).byRunId.size, 0);
  } finally { cleanupDir(runDir); }
});

test("LS-16 (审查 A4): 归档枚举 skipped（跳过路径里的副本）→ 整根不推导", async (t) => {
  const runDir = join(makeRunDir(), "runs");
  const base = dirname(runDir);
  try {
    mkdirSync(runDir, { recursive: true });
    seed(runDir, "run_r", rootRun("run_r"));
    seed(runDir, "run_c", childRun("run_c", "run_r", "run_r", { decision: "accepted" }));
    // 归档月份目录里放一个符号链接/junction（.jsonl 名）→ listArchiveTranscriptFiles
    // 报 skipped（symlink_not_followed），派生必须整根拒绝，而不是"看不见就等于没有"。
    const target = join(base, "junction-target");
    mkdirSync(target, { recursive: true });
    const month = join(base, "runs-archive", "2026-01");
    mkdirSync(month, { recursive: true });
    try {
      symlinkSync(target, join(month, "run_conflict.jsonl"), "junction");
    } catch {
      // 无权限建 junction 的环境：显式跳过（不静默 return，避免"没跑也算过"）。
      t.skip("此环境不允许创建 junction/symlink，无法构造归档枚举 skipped");
      return;
    }
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_r"), null, "归档枚举 skipped → 不推导");
    assert.equal((await s.forRoot("run_r")).byRunId.size, 0);
  } finally { cleanupDir(base); }
});

test("LS-17 (审查 A2): 调用方快照已裁决、磁盘还是旧快照 → decided:true 且不推导", async () => {
  const runDir = makeRunDir();
  try {
    // 磁盘：A 未裁决、后代已采纳（若只看磁盘会推导）。
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_c", childRun("run_c", "run_a", "run_a", { decision: "accepted" }));
    const s = reader(runDir);
    // 调用方快照：A 已拒收（更新）。
    const callerSnapshot = [...rootRun("run_a"), rejected("run_a")];
    const derived = await s.forRun({ runId: "run_a", events: callerSnapshot });
    assert.equal(derived.decided, true, "以调用方快照的裁决为准");
    assert.equal(derived.supersededByRunId, null, "自身显式裁决优先于派生被取代");
  } finally { cleanupDir(runDir); }
});

test("LS-18 (审查 A1): 自身验证未收口的祖先 → 不推导（保持待裁决）", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", [rootLineage("run_a"), completed("run_a"), ...packagedPending("run_a")]);
    seed(runDir, "run_c", childRun("run_c", "run_a", "run_a", { decision: "accepted" }));
    const s = reader(runDir);
    const a = await s.forRunId("run_a");
    assert.equal(a.settled, false, "夹具前提：验证 pending → 未收口");
    assert.equal(a.supersededByRunId, null, "未收口的祖先不推导");
  } finally { cleanupDir(runDir); }
});

test("LS-19 (审查 A5/规则): 最近后代优先；同距按 runId 字典序", async () => {
  const runDir = makeRunDir();
  try {
    // A→B（已采纳，距离 1）、A→B→C（已采纳，距离 2）：取更近的 B。
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    seed(runDir, "run_c", childRun("run_c", "run_b", "run_a", { decision: "accepted" }));
    let s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), "run_b", "取距离最近的后代");
    // 同距：A→b、A→c 都已采纳 → 字典序第一个（run_b 之前的 run_aa 之类仍按码元序）。
    cleanupDir(runDir);
    const dir2 = makeRunDir();
    try {
      seed(dir2, "run_a", rootRun("run_a"));
      seed(dir2, "run_zz", childRun("run_zz", "run_a", "run_a", { decision: "accepted" }));
      seed(dir2, "run_bb", childRun("run_bb", "run_a", "run_a", { decision: "accepted" }));
      s = reader(dir2);
      assert.equal(await supersededOf(s, "run_a"), "run_bb", "同距按 runId 码元序取第一个");
    } finally { cleanupDir(dir2); }
  } catch (error) {
    cleanupDir(runDir);
    throw error;
  }
});

test("LS-20 (审查 Q1): pending 交付上记的 accepted 不算合法采纳 → 不推导", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    // C：created ref 显式声明 verification pending、无 outcome，却记了 accepted
    //（pending 上的 accepted 是非法 durable 事实）。
    const pendingRef = ref("run_c", { verification: { status: "pending", commands: [], verifiedCommit: DELIVERED, results: [] } });
    seed(runDir, "run_c", [
      continuationFact("run_c", "run_a", "run_a"),
      resumeLineage("run_c", "run_a"),
      { type: "run.delivery_created", runId: "run_c", delivery: pendingRef },
      completed("run_c"),
      {
        type: "run.delivery_accepted",
        runId: "run_c",
        delivery: { ...pendingRef, acceptance: { status: "accepted", reviewerType: "lead_agent" } },
        deliveryCommit: DELIVERED,
        reason: "ok",
      },
    ]);
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), null, "非法采纳不算后代");
  } finally { cleanupDir(runDir); }
});

test("LS-21 (审查 B2): 字节预筛——只解析候选文件，不解析无关转录", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    for (let i = 0; i < 8; i += 1) {
      seed(runDir, `run_other_${i}`, [completed(`run_other_${i}`)]);
    }
    const parsed = [];
    const s = reader(runDir, {
      readTranscriptFn: async (path) => { parsed.push(basename(path)); return readTranscript(path); },
    });
    assert.equal(await supersededOf(s, "run_a"), "run_b");
    assert.deepEqual(parsed.sort(), ["run_a.jsonl", "run_b.jsonl"],
      "只解析含根 runId 的候选（与本 run 自己），无关转录一律不解析");
  } finally { cleanupDir(runDir); }
});

test("LS-22 (审查 A5): 后代 D 归属核验不过 → 不推导；核验通过 → 推导", async () => {
  const runDir = makeRunDir();
  const ws = makeRunDir(); // 授权根必须是可证明的 Git 顶层（proveWorkspaceRoot SSOT）
  try {
    execFileSync("git", ["init", "-q"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "T"], { cwd: ws });
    writeFileSync(join(ws, "README.md"), "# ws\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: ws });
    seed(runDir, "run_a", [rootLineage("run_a"), startedEvent("run_a", ws), completed("run_a"), ...packaged("run_a")]);
    seed(runDir, "run_b", [
      // 生产形状：续修事实本身带 cwd（runContinue 第 15 步写 authorizedWorkspaceRoot），
      // 归属判定以它为背景事实权威。
      { ...continuationFact("run_b", "run_a", "run_a"), cwd: "D:/elsewhere/other-project" },
      resumeLineage("run_b", "run_a"),
      startedEvent("run_b", "D:/elsewhere/other-project"),
      ...packaged("run_b"),
      completed("run_b"),
      accepted("run_b"),
    ]);
    let s = reader(runDir, { descendantWorkspaceRoot: ws });
    assert.equal(await supersededOf(s, "run_a"), null, "后代不属于授权根 → 不推导");
    // 同一份转录，把后代的记录 cwd 换到授权根 → 推导。
    seed(runDir, "run_b", [
      { ...continuationFact("run_b", "run_a", "run_a"), cwd: ws },
      resumeLineage("run_b", "run_a"),
      startedEvent("run_b", ws),
      ...packaged("run_b"),
      completed("run_b"),
      accepted("run_b"),
    ]);
    s = reader(runDir, { descendantWorkspaceRoot: ws });
    assert.equal(await supersededOf(s, "run_a"), "run_b", "归属核验通过 → 推导");
  } finally {
    cleanupDir(runDir);
    cleanupDir(ws);
  }
});

test("LS-23 (审查 B3): 一次 prepare 多个根共一次预筛；各自只解析自己的候选", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_r1", rootRun("run_r1"));
    seed(runDir, "run_c1", childRun("run_c1", "run_r1", "run_r1", { decision: "accepted" }));
    seed(runDir, "run_r2", rootRun("run_r2"));
    seed(runDir, "run_c2", childRun("run_c2", "run_r2", "run_r2", { decision: "accepted" }));
    for (let i = 0; i < 6; i += 1) seed(runDir, `run_un_${i}`, [completed(`run_un_${i}`)]);
    const parsed = [];
    const s = reader(runDir, {
      readTranscriptFn: async (path) => { parsed.push(basename(path)); return readTranscript(path); },
    });
    await s.prepare(["run_r1", "run_r2"]);
    assert.equal(await supersededOf(s, "run_r1"), "run_c1");
    assert.equal(await supersededOf(s, "run_r2"), "run_c2");
    assert.deepEqual(parsed.sort(), ["run_c1.jsonl", "run_c2.jsonl", "run_r1.jsonl", "run_r2.jsonl"],
      "两条谱系各自只解析两个候选成员");
  } finally { cleanupDir(runDir); }
});

test("LS-24 (审查 C3/F2): refresh() 丢弃缓存并重枚举——删前重证能看到磁盘现状", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    const acceptedPath = join(runDir, "run_b.jsonl");
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), "run_b");
    // 后代转录被删：不 refresh 时仍是缓存结果；refresh 后按磁盘现状证不出。
    rmSync(acceptedPath);
    assert.equal(await supersededOf(s, "run_a"), "run_b", "缓存（同一次请求的快照语义）");
    await s.refresh();
    assert.equal(await supersededOf(s, "run_a"), null, "refresh 后按磁盘现状重证");
  } finally { cleanupDir(runDir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 120 批续修第 2 轮（F/E 组）：旁支环、refresh 现枚举、并发 prepare、入口门。
// ═══════════════════════════════════════════════════════════════════════════

test("LS-25 (审查 F1): 旁支自己成环（与根不相连）→ 整根不推导", async () => {
  const runDir = makeRunDir();
  try {
    // 合法链 A→B（B 已采纳）+ 同根旁支 X↔Y（根都记为 R，但连不回 R）。
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    seed(runDir, "run_x", [
      continuationFact("run_x", "run_y", "run_a"),
      resumeLineage("run_x", "run_a"),
      ...packaged("run_x"),
      completed("run_x"),
    ]);
    seed(runDir, "run_y", [
      continuationFact("run_y", "run_x", "run_a"),
      resumeLineage("run_y", "run_a"),
      ...packaged("run_y"),
      completed("run_y"),
    ]);
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), null, "同根任何环 → 整根不推导（恢复 92babef3）");
    assert.equal((await s.forRoot("run_a")).byRunId.size, 0);
  } finally { cleanupDir(runDir); }
});

test("LS-26 (审查 F2): refresh 后新出现的冲突副本/新成员不被漏看", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), "run_b");
    // 执行过程中新出现一份内容不同的 B 副本（桶里）→ refresh 后必须整根拒绝。
    seed(runDir, "run_b", [continuationFact("run_b", "run_a", "run_a"), ...packaged("run_b"), completed("run_b")], { bucket: "p" });
    await s.refresh();
    assert.equal(await supersededOf(s, "run_a"), null, "新出现的冲突副本 → 不推导");
    // 再放一份"新成员"（同根、未裁决）也不会被当成不存在；删掉冲突副本后恢复。
    rmSync(join(runDir, "projects", "p", "run_b.jsonl"));
    seed(runDir, "run_new_member", [resumeLineage("run_new_member", "run_a"), ...packaged("run_new_member"), completed("run_new_member")]);
    await s.refresh();
    assert.equal(await supersededOf(s, "run_a"), "run_b", "新成员并入候选后仍能推导");
  } finally { cleanupDir(runDir); }
});

test("LS-27 (审查 F2/L2): refresh 后新出现的归档枚举 skipped → 刷新失败、不再推导", async (t) => {
  const runDir = join(makeRunDir(), "runs");
  const base = dirname(runDir);
  try {
    mkdirSync(runDir, { recursive: true });
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), "run_b");
    const target = join(base, "junction-target");
    mkdirSync(target, { recursive: true });
    const month = join(base, "runs-archive", "2026-02");
    mkdirSync(month, { recursive: true });
    try {
      symlinkSync(target, join(month, "run_x.jsonl"), "junction");
    } catch {
      t.skip("此环境不允许创建 junction/symlink，无法构造归档枚举 skipped");
      return;
    }
    // 枚举不完整不是"看不见就等于没有"：刷新必须失败（L2），此后不推导。
    await assert.rejects(() => s.refresh(), /enumeration incomplete/);
    assert.equal(await supersededOf(s, "run_a"), null, "枚举不完整 → 整根不推导");
    assert.equal((await s.forRunId("run_a")).refreshFailed, true);
  } finally { cleanupDir(base); }
});

test("LS-28 (审查 F3): 并发 prepare 与 forRoot——先等在途预筛，不缓存空结果", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    const s = reader(runDir);
    // 并发：prepare 与 forRoot 同拍出发（prepare 的字节扫描未完成时 forRoot 就要算）。
    const [, derived] = await Promise.all([
      s.prepare(["run_a"]),
      s.forRoot("run_a"),
    ]);
    assert.equal(derived.byRunId.get("run_a"), "run_b", "并发下不把未准备好的空结果缓存下来");
    // 再查一次（缓存）也一致。
    assert.equal(await supersededOf(s, "run_a"), "run_b");
  } finally { cleanupDir(runDir); }
});

test("LS-29 (审查 E1): supersessionCandidateGate——普通运行/未打包/已裁决/未收口都不是候选", () => {
  // 普通交付运行（无谱系引用）→ 不收根。
  assert.equal(supersessionCandidateGate([...packaged("run_plain"), completed("run_plain")], "run_plain").candidate, false);
  // 有谱系引用但验证未收口 → 不是候选。
  assert.equal(supersessionCandidateGate([rootLineage("run_a"), completed("run_a"), ...packagedPending("run_a")], "run_a").candidate, false);
  // 已裁决 → 不是候选（即使谱系引用/打包/收口齐备）。
  assert.equal(supersessionCandidateGate([...rootRun("run_a"), rejected("run_a")], "run_a").candidate, false);
  // 谱系引用 + 打包 + 未裁决 + 已收口 → 候选（会走到 forRoot）。
  const gate = supersessionCandidateGate(rootRun("run_a"), "run_a");
  assert.deepEqual(gate, { candidate: true, lineageRef: true, packaged: true, decided: false, settled: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 120 批续修第 3 轮（J1/J2）：已有文件内容变化、刷新失败不放行。
// ═══════════════════════════════════════════════════════════════════════════

test("LS-30 (审查 J1): refresh 看到已有文件的内容变化——后来长出根引用/矛盾声明的文件不被漏看", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    // X、Y 的文件先在清单里，但此刻还不含根 A 的字节（预筛不会把它们当候选）。
    seed(runDir, "run_x", [completed("run_x")]);
    seed(runDir, "run_y", [completed("run_y")]);
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), "run_b");
    // 执行过程中它们才长出同根声明，并互相成环（X↔Y，根都记 A）。
    seed(runDir, "run_x", [
      continuationFact("run_x", "run_y", "run_a"),
      resumeLineage("run_x", "run_a"),
      ...packaged("run_x"),
      completed("run_x"),
    ]);
    seed(runDir, "run_y", [
      continuationFact("run_y", "run_x", "run_a"),
      resumeLineage("run_y", "run_a"),
      ...packaged("run_y"),
      completed("run_y"),
    ]);
    await s.refresh();
    assert.equal(await supersededOf(s, "run_a"), null, "已有文件内容变化 → 重扫后整根拒绝");
    // 新建读器结果一致（证明是内容变化被看到，而不是缓存差异）。
    assert.equal(await supersededOf(reader(runDir), "run_a"), null);
  } finally { cleanupDir(runDir); }
});

test("LS-31 (审查 J2): 刷新枚举失败 → refresh 抛错、实例此后不推导（不放行删除）", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    let fail = false;
    const s = createLineageSupersession({
      runDir,
      enumerateFilesFn: (dir) => {
        if (fail) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return lineageMemberFiles(dir);
      },
    });
    assert.equal(await supersededOf(s, "run_a"), "run_b", "夹具前提：正常刷新前可推导");
    fail = true;
    await assert.rejects(() => s.refresh(), /refresh enumeration failed/, "刷新失败要让人知道");
    const state = await s.forRunId("run_a");
    assert.equal(state.transcriptReadable, false);
    assert.equal(state.refreshFailed, true, "实例标成不可信");
    assert.equal(state.supersededByRunId, null, "刷新失败后不再推导");
    assert.equal((await s.forRoot("run_a")).byRunId.size, 0);
  } finally { cleanupDir(runDir); }
});

test("LS-32 (审查 L1): 对某些根是候选的文件也要查变化——改成另一根的 X↔Y 后该根拒绝", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_a_c", childRun("run_a_c", "run_a", "run_a", { decision: "accepted" }));
    seed(runDir, "run_b", rootRun("run_b"));
    seed(runDir, "run_b_c", childRun("run_b_c", "run_b", "run_b", { decision: "accepted" }));
    // X、Y 先命中根 A（A 的成员），对根 B 不是候选。
    const asMemberOf = (runId, parentRunId, rootRunId) => [
      continuationFact(runId, parentRunId, rootRunId),
      resumeLineage(runId, rootRunId),
      ...packaged(runId),
      completed(runId),
    ];
    seed(runDir, "run_x", asMemberOf("run_x", "run_a", "run_a"));
    seed(runDir, "run_y", asMemberOf("run_y", "run_a_c", "run_a"));
    const s = reader(runDir);
    await s.prepare(["run_a", "run_b"]);
    assert.equal(await supersededOf(s, "run_a"), "run_a_c", "A 正常推导");
    assert.equal(await supersededOf(s, "run_b"), "run_b_c", "B 正常推导");
    // 执行中把这两份已有文件改成根 B 的 X↔Y：它们对 A 仍是候选、对 B 不是。
    // 刻意让新内容变长（多一条无害事件）——不然同尺寸改写只能靠 mtime 判断，
    // 在粗粒度时间戳上会偶发漏检（那是注释里写明的已知边界）。
    const rewritten = (runId, parentRunId) => [
      ...asMemberOf(runId, parentRunId, "run_b"),
      { type: "run.lead_note", text: "rewritten after prepare" },
    ];
    seed(runDir, "run_x", rewritten("run_x", "run_y"));
    seed(runDir, "run_y", rewritten("run_y", "run_x"));
    await s.refresh();
    assert.equal(await supersededOf(s, "run_b"), null, "对某些根是候选的文件也查变化 → B 拒绝");
    assert.equal(await supersededOf(reader(runDir), "run_b"), null, "新建读器结果一致");
  } finally { cleanupDir(runDir); }
});

test("LS-33 (审查 L2): 枚举不完整（存储根读不出）→ 不按 missing 判定", async () => {
  const missingDir = join(makeRunDir(), "runs", "does-not-exist");
  try {
    // 严格枚举：存储根不存在时抛错（非严格会当成空库 → 一切看起来都"缺失"）。
    const s = createLineageSupersession({ runDir: missingDir });
    const state = await s.forRunId("run_a");
    assert.equal(state.transcriptReadable, false);
    assert.equal(state.enumerationIncomplete, true, "枚举不完整要让人知道");
    assert.equal(state.supersededByRunId, null);
  } finally { cleanupDir(dirname(dirname(missingDir))); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 120 批续修第 5 轮（N2/O1）：未预热读器的首次刷新不吞枚举故障。
// ═══════════════════════════════════════════════════════════════════════════

test("LS-34 (N2): 未预热读器第一次 refresh 的枚举故障不吞——抛错且不重试", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    let calls = 0;
    const s = createLineageSupersession({
      runDir,
      enumerateFilesFn: (dir) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return lineageMemberFiles(dir, { strict: true });
      },
    });
    // 读器还没预热、也没有已准备的根：第一次 refresh 里的枚举失败必须上抛，
    // 不能"吞一次再重新枚举成功"然后照常放行删除。
    await assert.rejects(() => s.refresh(), /refresh enumeration failed/);
    assert.equal(calls, 1, "第一次枚举失败即抛错（不吞掉重试）");
    assert.equal((await s.forRunId("run_a")).refreshFailed, true);
    assert.equal((await s.forRunId("run_a")).supersededByRunId, null);
  } finally { cleanupDir(runDir); }
});

test("LS-35 (Q2): 不做枚举时 enumerationIncomplete 是 null（不假装 false），候选路径枚举后才填", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    seed(runDir, "run_plain", [...packaged("run_plain"), completed("run_plain")]);
    let enumerations = 0;
    const s = createLineageSupersession({
      runDir,
      enumerateFilesFn: (dir) => { enumerations += 1; return lineageMemberFiles(dir, { strict: true }); },
    });
    // 普通运行（无谱系引用）：直接给快照 → 不触发任何目录枚举，字段为 null。
    const plain = await s.forRun({ runId: "run_plain", events: [...packaged("run_plain"), completed("run_plain")] });
    assert.equal(plain.enumerationIncomplete, null, "没枚举过 → null（不假装 false）");
    assert.equal(enumerations, 0, "普通读面不做全库目录枚举");
    // 候选路径（谱系根 + 打包 + 未裁决 + 已收口）才惰性枚举，之后字段是布尔值。
    const candidate = await s.forRun({ runId: "run_a", events: rootRun("run_a") });
    assert.equal(candidate.supersededByRunId, "run_b");
    assert.equal(candidate.enumerationIncomplete, false, "枚举过且完整 → false");
    assert.equal(enumerations, 1, "候选路径枚举一次");
  } finally { cleanupDir(runDir); }
});

test("LS-36 (Q1): 冷启动 refresh 成功后 prepare 不抛错、派生照常", async () => {
  const runDir = makeRunDir();
  try {
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    const s = reader(runDir);
    // 先 refresh（冷启动、无已准备的根），再 prepare：旧实现 enumerationSkipped
    // 仍是 null，prepare 读 .length 抛错、错误被吞成"不推导"。
    await s.refresh();
    await s.prepare(["run_a"]);
    assert.equal(await supersededOf(s, "run_a"), "run_b", "冷启动刷新后派生照常");
  } finally { cleanupDir(runDir); }
});

test("LS-37 (Q1): 刷新失败（归档枚举失败）时枚举状态不能显示成 false", async (t) => {
  const runDir = join(makeRunDir(), "runs");
  const base = dirname(runDir);
  try {
    mkdirSync(runDir, { recursive: true });
    seed(runDir, "run_a", rootRun("run_a"));
    seed(runDir, "run_b", childRun("run_b", "run_a", "run_a", { decision: "accepted" }));
    const s = reader(runDir);
    assert.equal(await supersededOf(s, "run_a"), "run_b");
    // 归档面读不出：refresh 失败 → 诊断字段必须如实说"枚举不完整"。
    rmSync(join(base, "runs-archive"), { recursive: true, force: true });
    writeFileSync(join(base, "runs-archive"), "not a directory\n", "utf8");
    await assert.rejects(() => s.refresh(), /enumeration incomplete/);
    const state = await s.forRunId("run_a");
    assert.equal(state.refreshFailed, true);
    assert.notEqual(state.enumerationIncomplete, false, "刷新失败时不能显示 false");
    assert.equal(state.enumerationIncomplete, true);
    assert.equal((await s.forRun({ runId: "run_b", events: childRun("run_b", "run_a", "run_a", { decision: "accepted" }) })).enumerationIncomplete, true,
      "传快照的路径同样带出刷新失败状态");
  } finally { cleanupDir(base); }
});
