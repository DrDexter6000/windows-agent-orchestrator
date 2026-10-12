// test/application/panelDerivation.test.js
//
// 0065（0045 §1.2 终局）：对抗性派生编排层钉（方案会审 consult_20261012122731994yv6bty
// 双席 P1 的可证伪面）：
//   - 比对依据=车道指纹（laneFingerprint 四元组），不是 agentId 字符串——
//     旧席位名（gpt-astra 等 legacy 名）同指纹必须判 same_lane（不漏报回避）；
//     agentId 字符串不同但指纹相同=同车道。
//   - 作者侧只认被审 run 的 run.started 钉住事实；缺事实/不可读=author_unknown
//     三态（绝折叠成 different_lane）。
//   - 多作者 fail-closed：任一作者同车道=same_lane；任一比对缺事实=unknown。
//   - 来源声明（basis）必带；席位侧=registry 登记时配置事实。
//   - 复用权威：车道关系经 deriveIndependenceRelations（不造第二套判定）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePanelFacts, seatFactsFromRegistry } from "../../src/application/panelDerivation.js";
import { readTranscript } from "../../src/transcript.js";
import { resolveTranscriptPath } from "../../src/projectBuckets.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const ev = (o) => JSON.stringify(o) + "\n";
const startedOf = (agentId, axes) => ev({
  type: "run.started", backend: axes.backend, model: { id: axes.modelId }, reasoning: { effort: "max" },
  providerKey: null, runId: axes.runId, agentId, seq: 1, ts: "2026-10-12T00:00:00.000Z", cwd: "D:/x",
});

// 真实转录读取器（与生产同链路：resolveTranscriptPath + readTranscript）。
function makeRunDir() {
  const dir = mkdtempSync(join(tmpdir(), "wao-pd-"));
  mkdirSync(join(dir, "runs"), { recursive: true });
  return dir;
}
const writeRun = (runDir, runId, agentId, axes) =>
  writeFileSync(join(runDir, "runs", `${runId}.jsonl`), startedOf(agentId, { ...axes, runId }), "utf8");

const GLM_AXES = { backend: "zcode", modelId: "bigmodel-api/GLM-5.3" };
const DS_AXES = { backend: "deepseek-acp", modelId: "deepseek-v4-pro" };
const agentsById = new Map([
  ["glm-pro", { id: "glm-pro", backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" } }],
  ["deepseek-pro", { id: "deepseek-pro", backend: "deepseek-acp", model: { id: "deepseek-v4-pro" } }],
  ["new-name-same-glm", { id: "new-name-same-glm", backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" } }],
]);

async function run({ seatIds, runs, reviewedRunIds }) {
  const runDir = makeRunDir();
  try {
    for (const r of runs ?? []) writeRun(runDir, r.runId, r.agentId, r.axes);
    return await derivePanelFacts({
      seatFacts: seatFactsFromRegistry(seatIds, agentsById),
      reviewedRunIds,
      runDir: join(runDir, "runs"),
      readEventsFn: readTranscript,
      resolvePathFn: resolveTranscriptPath,
    });
  } finally { cleanupDir(runDir); }
}

test("指纹比对（非 agentId 字符串）：旧席位名同指纹=同车道——回避不漏报", async () => {
  // 作者 run 的 agentId 是重键前旧名（legacy 名），席位是新名但同四元组——
  // 字符串比对会判"不同"，指纹比对必须判 same_lane。
  const f = await run({
    seatIds: ["glm-pro"],
    runs: [{ runId: "run_author", agentId: "gpt-glm-legacy-name", axes: GLM_AXES }],
    reviewedRunIds: ["run_author"],
  });
  assert.equal(f.authorContext, "derived");
  assert.equal(f.seats[0].authorRelation, "same_lane", "同指纹=同车道（名字不同不算跨车道）");
  assert.deepEqual(f.authorAvoidanceViolations, ["glm-pro"], "回避违反点名");
  assert.equal(f.seats[0].familyVsAuthors, "same", "同模型必同族");
});

test("跨车道判 different_lane + 跨族附注；席位缺席 registry=unknown", async () => {
  const f = await run({
    seatIds: ["glm-pro", "deepseek-pro", "ghost-seat"],
    runs: [{ runId: "run_author", agentId: "author-ds", axes: DS_AXES }],
    reviewedRunIds: ["run_author"],
  });
  const byId = new Map(f.seats.map((s) => [s.agentId, s]));
  assert.equal(byId.get("glm-pro").authorRelation, "different_lane");
  assert.equal(byId.get("glm-pro").familyVsAuthors, "cross", "GLM vs DeepSeek=跨族（更强推荐）");
  assert.equal(byId.get("deepseek-pro").authorRelation, "same_lane");
  assert.equal(byId.get("deepseek-pro").familyVsAuthors, "same");
  assert.equal(byId.get("ghost-seat").authorRelation, "unknown", "席位不在 registry=无指纹=unknown（不猜）");
  assert.equal(byId.get("ghost-seat").registryResolution, "unknown-agent");
  assert.ok(f.basis.includes("registry 当前配置事实") && f.basis.includes("run.started"), "来源声明在场（sol 条款）");
});

test("作者 unknown 三态：不可读/缺 run.started/未提供——绝不折叠成 different_lane", async () => {
  const runDir = makeRunDir();
  try {
    // run 缺 run.started（只有别的事件）。
    writeFileSync(join(runDir, "runs", "run_no_started.jsonl"),
      ev({ type: "prompt.sent", prompt: "x", runId: "run_no_started", agentId: "a", seq: 1 }), "utf8");
    const f1 = await derivePanelFacts({
      seatFacts: seatFactsFromRegistry(["glm-pro"], agentsById),
      reviewedRunIds: ["run_missing entirely"],
      runDir: join(runDir, "runs"),
      readEventsFn: readTranscript, resolvePathFn: resolveTranscriptPath,
    });
    assert.equal(f1.authorContext, "unreadable_or_missing");
    assert.equal(f1.seats[0].authorRelation, "unknown", "转录不可读=unknown");

    const f2 = await derivePanelFacts({
      seatFacts: seatFactsFromRegistry(["glm-pro"], agentsById),
      reviewedRunIds: ["run_no_started"],
      runDir: join(runDir, "runs"),
      readEventsFn: readTranscript, resolvePathFn: resolveTranscriptPath,
    });
    assert.equal(f2.authors[0].observation, "missing_started", "转录可读但无 run.started=missing_started");
    assert.equal(f2.seats[0].authorRelation, "unknown");

    const f3 = await derivePanelFacts({
      seatFacts: seatFactsFromRegistry(["glm-pro", "deepseek-pro"], agentsById),
      reviewedRunIds: [],
      runDir: join(runDir, "runs"),
      readEventsFn: readTranscript, resolvePathFn: resolveTranscriptPath,
    });
    assert.equal(f3.authorContext, "not_provided", "未给旗标=not_provided（不静默当无违反）");
    assert.equal(f3.seats[0].authorRelation, "unknown");
    assert.ok(f3.pairwise.length > 0, "无作者上下文时席位间两两族系事实仍输出（stage 2 面——sol P1）");
  } finally { cleanupDir(runDir); }
});

test("多作者 fail-closed：任一同车道=same_lane；任一缺事实=unknown；全可比全不同=different_lane", async () => {
  const f = await run({
    seatIds: ["glm-pro"],
    runs: [
      { runId: "run_a", agentId: "author-ds", axes: DS_AXES },
      { runId: "run_b", agentId: "author-glm-old", axes: GLM_AXES },
    ],
    reviewedRunIds: ["run_a", "run_b"],
  });
  assert.equal(f.authorContext, "derived");
  assert.equal(f.seats[0].authorRelation, "same_lane", "共同作者之一同车道=违反（0019 §3 作者或共同作者）");

  const f2 = await run({
    seatIds: ["deepseek-pro"],
    runs: [
      { runId: "run_c", agentId: "author-glm", axes: GLM_AXES },
      { runId: "run_nostart" },
    ],
    reviewedRunIds: ["run_c", "run_nostart"],
  });
  // run_nostart 未写转录（不可读）——fail-closed：不能声称 different_lane。
  assert.equal(f2.authorContext, "partial");
  assert.equal(f2.seats[0].authorRelation, "unknown", "任一作者缺事实=unknown（不得声称全部回避）");

  const f3 = await run({
    seatIds: ["deepseek-pro"],
    runs: [{ runId: "run_d", agentId: "author-glm", axes: GLM_AXES }],
    reviewedRunIds: ["run_d"],
  });
  assert.equal(f3.seats[0].authorRelation, "different_lane", "单作者全可比且不同=对抗前提成立");
  assert.equal(f3.seats[0].familyVsAuthors, "cross");
});

test("pairwise 席位间族系闭集：cross/same/unknown 三值", async () => {
  const f = await run({ seatIds: ["glm-pro", "deepseek-pro", "ghost-seat"], reviewedRunIds: [] });
  const rel = (a, b) => f.pairwise.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  assert.equal(rel("glm-pro", "deepseek-pro").familyRelation, "cross");
  assert.equal(rel("glm-pro", "ghost-seat").familyRelation, "unknown", "幽灵席位族系未知");
  assert.equal(f.pairwise.length, 3, "三席位恰三对");
});
