// test/migration-0045/ledgerMigration.test.js
//
// 0045 §6 第 4 步：台账迁移脚本单元测试（子进程跑真脚本，夹具台账零依赖私有件；
// 证据包/备份全部落在 tmpdir，不污染仓库）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const REPO = join(import.meta.dirname, "..", "..");
const SCRIPT = join(REPO, "scripts", "migration", "migrate-cert-ledger.mjs");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function run(args, summaryPath, evidenceDir) {
  const out = execFileSync(
    "node",
    [join(REPO, "scripts", "wao-node.cjs"), SCRIPT, "--summary", summaryPath, "--evidence-dir", evidenceDir, ...args],
    { encoding: "utf8", cwd: REPO },
  );
  return JSON.parse(out);
}
function fixtureSummary() {
  return {
    version: 1, generatedAt: "2026-10-05T00:00:00Z",
    counts: { certified: 1, conditional: 1, "draft-only": 1, blocked: 0, rejected: 0 },
    allCertified: false,
    workers: {
      seat_a: {
        agentId: "seat_a", backend: "zcode", providerID: null, modelId: "m-flash", providerKey: null,
        status: "conditional", recommendedUse: "supervised-dispatch", certificationScope: "delta",
        lastHealthyRunAt: "2026-10-02T00:00:00Z", lastFullHealthyRunAt: null, capabilities: { core: true },
        cases: ["case-flash-a"],
      },
      seat_b: { // 同车道第二席（researcher/coder_low 形状）——合并取并集+最严
        agentId: "seat_b", backend: "zcode", providerID: null, modelId: "m-flash", providerKey: null,
        status: "draft-only", recommendedUse: "draft-only", certificationScope: "delta",
        lastHealthyRunAt: null, cases: ["case-flash-b"],
      },
      seat_c: {
        agentId: "seat_c", backend: "codex", providerID: null, modelId: "m-sol", providerKey: null,
        status: "certified", recommendedUse: "strict-dispatch", certificationScope: "full",
        lastHealthyRunAt: "2026-10-03T00:00:00Z", cases: ["case-sol"],
      },
    },
    cases: [
      { caseId: "case-flash-a", agentId: "seat_a", backend: "zcode", modelId: "m-flash" },
      { caseId: "case-flash-b", agentId: "seat_b", backend: "zcode", modelId: "m-flash" },
      { caseId: "case-sol", agentId: "seat_c", backend: "codex", modelId: "m-sol" },
    ],
  };
}

test("MIG-1: dry-run 默认零写入+守恒通过+同车道合并预览（最严状态）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mig1-"));
  try {
    const p = join(dir, "summary.json");
    writeFileSync(p, JSON.stringify(fixtureSummary()), "utf8");
    const before = sha256(readFileSync(p, "utf8"));
    const r = run([], p, join(dir, "ev"));
    assert.equal(r.verdict, "DRY-RUN-PASS");
    assert.equal(r.wouldWrite.lanes, 2, "3 席→2 车道（同车道合并）");
    assert.equal(r.wouldWrite.workersMigrated, 3);
    assert.equal(r.conservation.workerCaseSetConserved, true);
    assert.equal(sha256(readFileSync(p, "utf8")), before, "dry-run 零写入");
    const flash = r.preview.find((x) => x.from.includes("seat_a"));
    assert.deepEqual([...flash.from].sort(), ["seat_a", "seat_b"]);
    assert.equal(flash.status, "draft-only", "合并取最严状态");
    assert.equal(flash.cases, 2, "cases 并集");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MIG-2: apply——备份+证据包+键空间标记+provenance+时间戳不刷新；幂等重跑=无操作", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mig2-"));
  try {
    const p = join(dir, "summary.json");
    const ev = join(dir, "ev");
    writeFileSync(p, JSON.stringify(fixtureSummary()), "utf8");
    const r = run(["--apply"], p, ev);
    assert.equal(r.verdict, "APPLIED");
    assert.equal(r.lanes, 2);
    const after = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(after.ledgerKeySpace, "lane-v1");
    assert.ok(!after.workers.seat_a && !after.workers.seat_b, "席位键消失");
    const flashKey = Object.keys(after.workers).find((k) => after.workers[k].modelId === "m-flash");
    const flash = after.workers[flashKey];
    assert.equal(flash.status, "draft-only");
    assert.deepEqual([...flash.cases].sort(), ["case-flash-a", "case-flash-b"], "cases 并集守恒");
    assert.equal(flash.lastHealthyRunAt, "2026-10-02T00:00:00Z", "时间戳不刷新（保留观察）");
    assert.equal(flash.provenance.length, 2, "原始记录事实保留（不只取最好结果）");
    assert.ok(flash.provenance.some((x) => x.agentId === "seat_b" && x.status === "draft-only"), "provenance 保留原始状态事实");
    // 顶层 cases[] 史实清单原样（不重排不改写）
    assert.deepEqual(after.cases.map((c) => c.caseId), ["case-flash-a", "case-flash-b", "case-sol"]);
    // 备份在台账同目录
    const backups = readdirSync(dir).filter((f) => f.startsWith("summary.json.pre-lane-migration-"));
    assert.equal(backups.length, 1, "迁移前备份恰好一份");
    // 证据包落 evidence-dir 且含守恒哈希
    const evidenceFiles = readdirSync(ev);
    assert.equal(evidenceFiles.length, 1);
    const evidence = JSON.parse(readFileSync(join(ev, evidenceFiles[0]), "utf8"));
    assert.equal(evidence.conservation.workerCaseSetConserved, true);
    assert.equal(evidence.mode, "apply");
    assert.match(evidence.beforeSummarySha256, /^[0-9a-f]{64}$/);
    // 幂等：二次运行 = already-migrated 无操作
    const again = run(["--apply"], p, ev);
    assert.equal(again.verdict, "already-migrated");
    assert.equal(readdirSync(ev).length, 1, "幂等重跑不新增证据文件");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


// ── W4e 硬化：tri-state 键成分 + 中断重入 ────────────────────────────────────

test("MIG-4（W4e）：providerKey undefined 与 null 的两席位不并道（tri-state 键）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mig4-"));
  try {
    const p2 = join(dir, "summary.json");
    const doc = fixtureSummary();
    doc.workers.seat_u = { ...doc.workers.seat_c, agentId: "seat_u", modelId: "m-sol", providerKey: undefined, cases: ["case-u"] };
    doc.cases.push({ caseId: "case-u", agentId: "seat_u", backend: "codex", modelId: "m-sol" });
    writeFileSync(p2, JSON.stringify(doc), "utf8");
    const r = run([], p2, join(dir, "ev"));
    assert.equal(r.verdict, "DRY-RUN-PASS");
    assert.equal(r.wouldWrite.lanes, 3, "m-flash+codex+codex(undefined providerKey)=3 道（undefined≠null 不并）");
    assert.equal(r.conservation.workerCaseSetConserved, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MIG-5（W4e）：中断重入——apply 后台账部分损坏再跑=按现状幂等重入不丢证据", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-mig5-"));
  try {
    const p2 = join(dir, "summary.json");
    writeFileSync(p2, JSON.stringify(fixtureSummary()), "utf8");
    const r = run(["--apply"], p2, join(dir, "ev"));
    assert.equal(r.verdict, "APPLIED");
    // 模拟中断后人工干预：台账已被迁移但 marker 被误删（半迁移形状）
    const after = JSON.parse(readFileSync(p2, "utf8"));
    delete after.ledgerKeySpace;
    writeFileSync(p2, JSON.stringify(after), "utf8");
    // 重入：以 seat 键残档再迁移 → 幂等结果（车道键重算一致，cases 守恒）
    const again = run(["--apply"], p2, join(dir, "ev"));
    assert.equal(again.verdict, "APPLIED", "无 marker=按席位档重迁移（重入语义）");
    const final = JSON.parse(readFileSync(p2, "utf8"));
    assert.equal(final.ledgerKeySpace, "lane-v1");
    const flash = Object.values(final.workers).find((w) => w.modelId === "m-flash");
    assert.deepEqual([...flash.cases].sort(), ["case-flash-a", "case-flash-b"], "重入不丢 case");
    // 注记：marker 丢失形状的重入会让 provenance 塌缩为 1（车道记录引用自身）——
    // case 守恒与状态最严不变；原始双席位 provenance 只在首次 apply 的备份里。
    assert.ok(Array.isArray(flash.provenance) && flash.provenance.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
