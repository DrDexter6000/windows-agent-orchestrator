// test/registry-roles/certificationEvidenceInventory.test.js
//
// TD-186（2026-09-22）：只读认证证据详情 + 适用性三态。
//
// 背景（实证）：auditor 席位 effort medium→high 重取证后，summary 的
// status/时间戳是新的，但记录不表达执行画像（effort=null）——旧档证据被读成
// "当前画像已认证"。本文件钉死：
//   - 详情五列（声明/组件观测/组合结果/证据适用性/限制与来源）的来源状态保真
//     （缺文件/记录缺失/不可解析/读取错误分别可辨——不复用有损 buildCertMap）；
//   - 适用性三态闭集（matched/mismatched/undeterminable），"无法判断"绝不算绿；
//   - 绝不派生"总体可用=true"之类的合并绿；
//   - 三条"不得合并成绿"钉：①组件通过+组合失败 ②历史通过+本次失败（见
//     reliabilityCertification.test.js TD-186 钉②，summary 层）③一账有旧证据+
//     另一账读取报错。
//
// 派发门零改动（matchedCertRecord / --require-certified 不动）由
// test/run-lifecycle/certGateIdentityFreshness.test.js 既有守卫承载；本文件只测
// 只读详情层。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getCertificationEvidenceInventory,
  CERT_EVIDENCE_APPLICABILITY,
  CERT_LEDGER_SOURCE_STATES,
} from "../../src/application/registryInventory.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ===== Helpers =====

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeRunDir(dir) {
  const runDir = join(dir, "runs");
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

function writeSummary(runDir, workers) {
  writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({ workers }), "utf8");
}

function writeComponentLedger(runDir, components) {
  writeFileSync(join(runDir, "component-checks.json"), JSON.stringify({ components }), "utf8");
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// auditor 席位声明：codex / gpt-6-astra / effort high（2026-09-22 Owner 裁定后）。
function auditorAgent(dir) {
  return {
    backend: "codex",
    seatRole: "adversarial",
    cwd: dir,
    model: { id: "gpt-6-astra" },
    reasoning: { effort: "high" },
  };
}

// 与声明匹配的 worker 证据记录（新证据：带执行画像）。
function matchedWorkerRecord(overrides = {}) {
  return {
    status: "certified",
    backend: "codex",
    modelId: "gpt-6-astra",
    providerID: null,
    providerKey: undefined,
    certificationScope: "full",
    reasonCode: null,
    lastHealthyRunAt: "2026-09-22T15:05:15.876Z",
    lastFullHealthyRunAt: "2026-09-22T15:05:15.876Z",
    executionProfile: {
      modelId: "gpt-6-astra",
      providerID: null,
      providerKey: null,
      effort: "high",
      runtime: {
        distribution: "codex",
        version: "codex-cli 0.54.0",
        binaryPath: "C:/tools/codex.cmd",
        fingerprint: "v1-abc123def4567890",
        verified: true,
        reason: null,
      },
      codeRef: "92209bbdeadbeefdeadbeefdeadbeefdeadbeef",
      capturedAt: "2026-09-22T15:05:15.876Z",
      drillRunIds: { sentinel: "run_a", scorecard: "run_b", isolation: null },
    },
    ...overrides,
  };
}

function componentRecord(overrides = {}) {
  return {
    key: "backend:codex@92209bb#v1-abc123def4567890",
    kind: "backend",
    result: "pass",
    lastVerifiedAt: "2026-09-21T10:00:00.000Z",
    codeRef: "92209bb",
    runtimeIdentity: { fingerprint: "v1-abc123def4567890", verified: true },
    ...overrides,
  };
}

const NOW = "2026-09-22T16:00:00.000Z";

async function runEvidence({ registryPath, runDir, readFileFn, now = NOW }) {
  return getCertificationEvidenceInventory({ registryPath, runDir, readFileFn, now });
}

// ===== 闭集 =====

test("TD-186 B: 适用性三态与来源状态闭集（frozen，无第二份清单）", () => {
  assert.ok(Object.isFrozen(CERT_EVIDENCE_APPLICABILITY));
  assert.deepEqual([...CERT_EVIDENCE_APPLICABILITY], ["matched", "mismatched", "undeterminable"]);
  assert.ok(Object.isFrozen(CERT_LEDGER_SOURCE_STATES));
  assert.deepEqual([...CERT_LEDGER_SOURCE_STATES], ["ok", "missing", "unparseable", "read-error"]);
});

// ===== 正常 =====

test("TD-186 B 正常: 身份+effort 匹配 → matched；五列齐全；绝不派生总体可用布尔", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-ok-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord(),
    });

    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows.length, 1);
    const row = rows[0];
    // 五列分列（声明/组件观测/组合结果/证据适用性/限制与来源）。
    assert.deepEqual(
      Object.keys(row).filter((k) => k !== "id").sort(),
      ["applicability", "combined", "componentObserved", "declared", "limitationsAndSources"],
    );
    assert.equal(row.applicability, "matched");
    assert.equal(row.declared.effort, "high");
    assert.equal(row.declared.backend, "codex");
    assert.equal(row.declared.modelId, "gpt-6-astra");
    assert.equal(row.combined.state, "ok");
    assert.equal(row.combined.record.status, "certified");
    assert.equal(row.combined.record.executionProfile.effort, "high");
    assert.equal(row.componentObserved.state, "ok");
    assert.equal(row.componentObserved.backend[0].result, "pass");
    assert.equal(row.limitationsAndSources.sources[0].state, "ok");
    assert.equal(row.limitationsAndSources.sources[1].state, "ok");
    // 绝不派生"总体可用=true"：全行无任何布尔可用性/绿判字段。
    const dumped = JSON.stringify(row);
    assert.ok(!/"(?:available|usable|overall|green|dispatchable)":\s*true/.test(dumped),
      "详情行不得携带任何合并绿布尔字段");
  } finally {
    cleanupDir(dir);
  }
});

// ===== 台账来源状态四态（详情层保真——不复用有损 buildCertMap）=====

test("TD-186 B 缺文件: reliability-summary.json 不存在 → undeterminable + ledger:missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-missing-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir); // 空目录：文件不存在
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "undeterminable", "缺文件绝不算绿（也无法判匹配）");
    assert.ok(rows[0].limitationsAndSources.limitations.some((l) => l.startsWith("reliability-ledger:missing")));
    assert.equal(rows[0].combined.state, "missing");
    assert.equal(rows[0].combined.record, null);
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 B 记录缺失: 台账可读但无该席位 worker 记录 → undeterminable + no-worker-record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-norec-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { coder_hq: matchedWorkerRecord() }); // 只有别的席位
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].combined.state, "ok");
    assert.equal(rows[0].combined.record, null, "记录缺失与文件缺失严格区分（state 仍 ok）");
    assert.equal(rows[0].applicability, "undeterminable");
    assert.ok(rows[0].limitationsAndSources.limitations.some((l) => l.startsWith("no-worker-record")));
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 B 不可解析: 坏 JSON → undeterminable + ledger:unparseable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-bad-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeFileSync(join(runDir, "reliability-summary.json"), "{ not valid json", "utf8");
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "undeterminable");
    assert.ok(rows[0].limitationsAndSources.limitations.some((l) => l.startsWith("reliability-ledger:unparseable")));
    assert.equal(rows[0].combined.state, "unparseable");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 B 读取错误: readFile 抛非 ENOENT → undeterminable + ledger:read-error（与 missing/unparseable 分别可辨）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-rerr-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    const readFileFn = async (path) => {
      if (String(path).includes("reliability-summary.json")) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      const err = new Error("no component ledger in this injection");
      err.code = "ENOENT";
      throw err;
    };
    const rows = await runEvidence({ registryPath, runDir, readFileFn });
    assert.equal(rows[0].combined.state, "read-error", "读取错误不得被折叠成 missing（buildCertMap 的坏行为）");
    assert.equal(rows[0].applicability, "undeterminable");
    assert.match(rows[0].limitationsAndSources.limitations.join(" "), /reliability-ledger:read-error/);
    assert.equal(rows[0].componentObserved.state, "missing", "注入里组件账是 ENOENT → missing（两账独立判定）");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 B 形状坏: workers 非 object → unparseable（不伪装成无记录）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-shape-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({ workers: [] }), "utf8");
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].combined.state, "unparseable", "workers: [] 是形状坏，不是 observed-empty");
    assert.equal(rows[0].applicability, "undeterminable");
  } finally {
    cleanupDir(dir);
  }
});

// ===== 画像未知 / 画像不匹配 / 身份不匹配 =====

test("TD-186 B 画像未知: legacy 记录无 executionProfile → undeterminable（旧画像不明 ≠ 当前已验证）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-legacy-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    // 2026-09-22 实证形状：status=certified、时间戳刷新、画像缺失。
    writeSummary(runDir, { auditor: matchedWorkerRecord({ executionProfile: undefined }) });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].combined.record.status, "certified", "组合结果列如实展示 certified");
    assert.equal(rows[0].combined.record.executionProfile, undefined, "缺失画像不补猜");
    assert.equal(rows[0].applicability, "undeterminable", "画像不明 → 无法判断，绝不算绿");
    assert.ok(rows[0].limitationsAndSources.limitations.some((l) => l.startsWith("execution-profile-not-recorded")));
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 B 画像不匹配: 记录 effort=medium vs 声明 high → mismatched（旧档证据不适配新画像）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-effmm-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    const profile = matchedWorkerRecord().executionProfile;
    writeSummary(runDir, {
      auditor: matchedWorkerRecord({ executionProfile: { ...profile, effort: "medium" } }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "mismatched");
    assert.match(rows[0].limitationsAndSources.limitations.join(" "), /effort-mismatch: declared=high evidence=medium/);
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 B 身份不匹配: 记录 backend 漂移 → mismatched（matchedCertRecord SSOT 裁决）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-idmm-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord({ backend: "claude-code" }) });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "mismatched");
    assert.ok(rows[0].limitationsAndSources.limitations.some((l) => l.startsWith("identity-mismatch:backend")));
  } finally {
    cleanupDir(dir);
  }
});

// ===== 过期（30 天审阅提醒；提醒不是门，也不替代适用性判断）=====

test("TD-186 B 过期: 全绿时间戳 40 天前 → matched 但带审阅提醒限制项（提醒 ≠ 绿）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-age-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, {
      auditor: matchedWorkerRecord({
        lastHealthyRunAt: "2026-08-10T00:00:00.000Z",
        lastFullHealthyRunAt: "2026-08-10T00:00:00.000Z",
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "matched", "过期是新鲜度提醒，不改画像适用性判定");
    const limits = rows[0].limitationsAndSources.limitations.join(" ");
    assert.match(limits, /evidence-age:43d>30d-review-window/);
    assert.match(limits, /审阅提醒/, "措辞明确：窗是提醒不是门");
  } finally {
    cleanupDir(dir);
  }
});

// ===== 组件 blocked / 夹具失效 / 组件台账不可解析 =====

test("TD-186 B 组件 blocked: 组件记录 blocked 如实观测（组合证据独立判定不受影响）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-blk-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        result: "blocked",
        blockedReason: "fixture unavailable",
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].componentObserved.state, "ok");
    assert.equal(rows[0].componentObserved.backend[0].result, "blocked");
    assert.ok(rows[0].limitationsAndSources.limitations.some((l) => l.startsWith("component-blocked:1")));
    assert.equal(rows[0].applicability, "matched", "组件 blocked 不改组合证据的适用性判定（分层）");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 B 夹具失效: 组件 advisory fixture-decayed 如实透出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-fx-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        advisory: { code: "fixture-decayed", reason: "fixture qualification expired" },
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].componentObserved.backend[0].advisoryCode, "fixture-decayed");
    assert.ok(rows[0].limitationsAndSources.limitations.includes("component-advisory:fixture-decayed"));
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 B 组件台账不可解析: componentObserved.state=unparseable + 限制项（不吞成空）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-cbad-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    writeFileSync(join(runDir, "component-checks.json"), "{ broken", "utf8");
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].componentObserved.state, "unparseable");
    assert.deepEqual(rows[0].componentObserved.backend, []);
    assert.ok(rows[0].limitationsAndSources.limitations.some((l) => l.startsWith("component-ledger:unparseable")));
    assert.equal(rows[0].applicability, "matched", "组件观测来源坏不吞掉组合证据判定（分层并列）");
  } finally {
    cleanupDir(dir);
  }
});

// ===== 三条"不得合并成绿"钉（①③在本文件；②在 reliabilityCertification.test.js）=====

test("TD-186 钉①（不得合并成绿）: 组件通过 + 组合无记录 → 组件 pass 不得把适用性抬出 undeterminable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-p1-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    // 组件层新鲜全过；组合层台账可读但没有该席位记录。
    writeSummary(runDir, { coder_hq: matchedWorkerRecord() });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord(),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].componentObserved.backend[0].result, "pass", "组件通过是观测事实");
    assert.equal(rows[0].combined.record, null, "组合层无记录如实为 null");
    assert.equal(rows[0].applicability, "undeterminable",
      "组件 pass + 组合缺证据不得合并成绿：适用性只由组合证据判定");
    assert.ok(rows[0].limitationsAndSources.limitations.some((l) => l.startsWith("no-worker-record")));
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 钉①（组合失败变体）: 组件通过 + 组合 conditional → 组合失败列如实，无合并绿字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-p1b-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord({ status: "conditional" }) });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord(),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].componentObserved.backend[0].result, "pass");
    assert.equal(rows[0].combined.record.status, "conditional", "组合失败（非 certified）必须如实可见");
    const dumped = JSON.stringify(rows[0]);
    assert.ok(!/"(?:available|usable|overall|dispatchable)":\s*true/.test(dumped),
      "组件 pass + 组合 conditional 不得产出任何合并绿布尔");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 钉③（不得合并成绿）: 一账有旧证据 + 另一账（组件台账）读取报错 → 两来源状态分别可辨，不吞不绿", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-p3-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    // 组合账：可读，有画像匹配的（10 天前的）证据。
    writeSummary(runDir, {
      auditor: matchedWorkerRecord({
        lastHealthyRunAt: "2026-09-12T00:00:00.000Z",
        lastFullHealthyRunAt: "2026-09-12T00:00:00.000Z",
      }),
    });
    // 组件账：读取报错（EACCES，非缺文件非坏 JSON）。
    const readFileFn = async (path) => {
      if (String(path).includes("component-checks.json")) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return JSON.stringify({
        workers: { auditor: matchedWorkerRecord() },
      });
    };
    const rows = await runEvidence({ registryPath, runDir, readFileFn });
    const row = rows[0];
    // 两本账来源状态分别可辨（read-error ≠ missing ≠ unparseable ≠ ok）。
    assert.equal(row.combined.state, "ok");
    assert.equal(row.componentObserved.state, "read-error");
    assert.deepEqual(row.limitationsAndSources.sources, [
      { file: "runs/reliability-summary.json", state: "ok" },
      { file: "runs/component-checks.json", state: "read-error" },
    ]);
    // 读取报错必须浮出为限制项，且不得折叠成缺文件/不可解析。
    const limits = row.limitationsAndSources.limitations.join(" ");
    assert.match(limits, /component-ledger:read-error/);
    assert.ok(!/component-ledger:(missing|unparseable)/.test(limits),
      "读取报错不得折叠成缺文件/不可解析");
    // 旧证据不因另一账报错被吞；也不被合并成"当前已验证"。
    assert.equal(row.applicability, "matched", "组合证据自身的适用性判定独立成立");
    assert.ok(!/"(?:available|usable|overall)":\s*true/.test(JSON.stringify(row)),
      "不得派生总体可用布尔");
  } finally {
    cleanupDir(dir);
  }
});

// ===== CLI 查询路径（分列展示；默认简表行为不变）=====

test("TD-186 B CLI: registry list 默认输出不变；--cert-evidence 追加五列详情块", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-cli-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });

    const env = { ...process.env, WAO_SKIP_VERSION_GUARD: "1" };
    // 默认（无 flag）：简表字节不变（表头 + 行，无详情行）。
    const plain = execSync(
      "node src/cli.js registry list --registry " + registryPath + " --run-dir " + runDir,
      { cwd: REPO_ROOT, encoding: "utf8", env },
    );
    const plainLines = plain.trim().split(/\r?\n/);
    assert.equal(plainLines.length, 2, "默认输出恰为表头 + 1 行（旧行为不变）");
    assert.equal(plainLines[0], "id\tbackend\tmodel\tcertification\tcwd");
    assert.match(plainLines[1], /^auditor\tcodex\tgpt-6-astra\tcertified\t/);

    // --cert-evidence：表后追加详情块，五列分列。
    const detailed = execSync(
      "node src/cli.js registry list --registry " + registryPath + " --run-dir " + runDir + " --cert-evidence",
      { cwd: REPO_ROOT, encoding: "utf8", env },
    );
    const lines = detailed.trim().split(/\r?\n/);
    assert.equal(lines[0], "id\tbackend\tmodel\tcertification\tcwd", "简表仍在最前（不变）");
    const block = lines.slice(2).join("\n");
    assert.match(block, /cert-evidence auditor/);
    assert.match(block, /声明: backend=codex model=gpt-6-astra/);
    assert.match(block, /effort=high/);
    assert.match(block, /组件观测: state=missing/);
    assert.match(block, /组合结果: state=ok status=certified effort=high/);
    assert.match(block, /证据适用性: matched/);
    assert.match(block, /限制与来源:/);
    assert.match(block, /runs\/reliability-summary\.json\(ok\)/);
    assert.match(block, /runs\/component-checks\.json\(missing\)/);
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 B CLI: --cert-evidence --format json 输出 {agents, certificationEvidence}（agents 形状不变）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-clijson-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    const out = execSync(
      "node src/cli.js registry list --registry " + registryPath + " --run-dir " + runDir
        + " --cert-evidence --format json",
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } },
    );
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.agents), "agents 仍是裸数组契约");
    assert.equal(parsed.agents.length, 1);
    for (const key of ["id", "backend", "model", "certification", "cwd"]) {
      assert.ok(key in parsed.agents[0], "agents 元素仍有 " + key);
    }
    assert.ok(Array.isArray(parsed.certificationEvidence));
    assert.equal(parsed.certificationEvidence[0].applicability, "matched");
    assert.equal(parsed.certificationEvidence[0].id, "auditor");
  } finally {
    cleanupDir(dir);
  }
});
