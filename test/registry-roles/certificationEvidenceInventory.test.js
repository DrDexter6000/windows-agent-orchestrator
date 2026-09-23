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
//   - 三条"不得合并成绿"钉：①组件通过+组合失败 ②历史通过+本次失败（summary 层
//     见 reliabilityCertification.test.js TD-186 钉②；B2 补详情层钉——组合列如实
//     展示本次失败，历史全绿时间只作历史事实保留）③一账有旧证据+另一账读取报错。
//   - audit11（2026-09-23）两缺口回归：①组件记录自身时间/夹具资格自然过期（未预
//     标注）进限制项（component-expired / component-fixture-decayed，两路不得淡化
//     成"无"）+ SSOT（classifyComponent）等值钉；②lastFullHealthyRunAt 缺席渲染
//     lastFullHealthy=?（缺席显示 ?、不整项省略）。
//   - audit12（2026-09-23 第二轮）两中级缺口回归：①非 matched 路径（mismatched/
//     undeterminable）不得漏掉组件限制汇总（三组反例逐条钉，CLI 与 MCP 两路——
//     MCP 侧见 test/mcp-surface/mcpRegistryCertEvidence.test.js ADR32-MCP-10）；
//     ②owner 期限等号边界（now === ownerValidUntil 仍有效）纳入等值钉——改任一
//     侧等号语义（> → >=）该钉必红（变异验证过）。
//
// 派发门零改动（matchedCertRecord / --require-certified 不动）由
// test/run-lifecycle/certGateIdentityFreshness.test.js 既有守卫承载；本文件只测
// 只读详情层。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getCertificationEvidenceInventory,
  CERT_EVIDENCE_APPLICABILITY,
  CERT_LEDGER_SOURCE_STATES,
  COMPONENT_RECORD_MAX_AGE_DAYS,
  COMPONENT_FIXTURE_MAX_AGE_DAYS,
  componentNaturalExpiry,
} from "../../src/application/registryInventory.js";
// 等值钉（audit11 缺口 1）允许测试同时 import 两侧：src 镜像 vs scripts SSOT。
// layering 冻结的是 src/** 不得 import scripts/**；测试侧无此约束。
import {
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_FIXTURE_MAX_AGE_DAYS,
  classifyComponent,
} from "../../scripts/reliability/componentLedger.mjs";

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

test("TD-186 B 身份不匹配: 记录 backend 漂移 → mismatched（fail-closed 比对裁决；门禁 matchedCertRecord 不入此路径）", async () => {
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

// ===== TD-186 复核 FAIL-A 回归钉（2026-09-22 第二包：画像判定 fail-closed）=====
//
// 独立复核的两条反例 + provider null 语义钉。判据（四态判据的行为面）：
//   - 身份四元组不完整（缺/非字符串/空；provider 两字段合法 null）⇒ undeterminable；
//   - 顶层与画像侧内部矛盾 / 四元组与声明不一致 ⇒ mismatched。

test("TD-186 复核反例①（FAIL-A）: {status:certified, executionProfile:{effort:high}} 身份全缺 → undeterminable（绝不能 matched）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-rev1-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    // 复核原文形状：顶层身份全缺，画像里只有 effort——旧判定经 matchedCertRecord
    // 的缺字段容忍直通，effort 相等即 matched（假绿）。
    writeSummary(runDir, {
      auditor: { status: "certified", executionProfile: { effort: "high" } },
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].combined.record.status, "certified", "组合结果列如实展示 certified");
    assert.equal(rows[0].applicability, "undeterminable",
      "身份全缺 = 无法证明证据属于当前画像——绝不能 matched");
    assert.ok(rows[0].limitationsAndSources.limitations.some((l) => l.startsWith("execution-profile-incomplete:")),
      "限制项须点名画像身份不完整");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 复核反例①变体: 画像字段非字符串/空串同样 undeterminable（不只要缺字段）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-rev1b-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    const profile = matchedWorkerRecord().executionProfile;
    writeSummary(runDir, {
      auditor: matchedWorkerRecord({ executionProfile: { ...profile, modelId: "", providerID: 7 } }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "undeterminable", "空串 modelId / 非字符串 providerID ⇒ 不完整");
    const limits = rows[0].limitationsAndSources.limitations.join(" ");
    assert.match(limits, /execution-profile-incomplete:modelId\+providerID/, "逐字段点名");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 复核反例②（FAIL-A）: 顶层身份正确但 executionProfile.modelId 为另一模型 → mismatched 且 limitations 非空（内部矛盾不得判 matched）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-rev2-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    // 顶层身份与声明完全一致（旧判定的顶层比对全通过），但画像侧 modelId 是另一
    // 模型——旧判定无人再看画像侧身份，直接 matched（假绿）。
    const profile = matchedWorkerRecord().executionProfile;
    writeSummary(runDir, {
      auditor: matchedWorkerRecord({ executionProfile: { ...profile, modelId: "gpt-6-b-sidian" } }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "mismatched");
    const limits = rows[0].limitationsAndSources.limitations;
    assert.ok(limits.length > 0, "limitations 非空");
    assert.ok(limits.some((l) => l.startsWith("identity-contradiction:modelId")),
      "须点名顶层与画像的内部矛盾");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-186 复核 FAIL-A: provider 一侧 null 一侧非 null ⇒ mismatched；双侧 null（无接入方）⇒ 逐字段相等可 matched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-revpn-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    // 声明侧：无 provider 块（providerKeyFor 派生 null、providerID null）。
    // 记录侧画像：providerID 声明了字符串——一侧 null 一侧非 null。
    const profile = matchedWorkerRecord().executionProfile;
    writeSummary(runDir, {
      auditor: matchedWorkerRecord({ executionProfile: { ...profile, providerID: "zhipuai-coding-plan" } }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "mismatched", "一侧 null 一侧非 null ⇒ mismatched");
    const limits = rows[0].limitationsAndSources.limitations.join(" ");
    assert.match(limits, /identity-contradiction:providerID/, "同时是顶层(null)与画像(字符串)的内部矛盾");
    // 双侧 null 的对照在「正常」用例（matchedWorkerRecord 画像 providerID/providerKey
    // 均 null，声明侧同 null）已钉 matched——此处不再重复。
  } finally {
    cleanupDir(dir);
  }
});

// ===== TD-186 复核 FAIL-B 回归钉（C.3：方案 1——id 可解析）=====

test("TD-186 复核 FAIL-B（方案 1）: 转录在场 → id 可解析、无悬空限制项；转录被删 → 浮出 drill-evidence-unresolvable（不改三态）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-revb-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, {
      auditor: matchedWorkerRecord({
        executionProfile: {
          ...matchedWorkerRecord().executionProfile,
          drillRunIds: { sentinel: "run_t1", scorecard: "run_t2", isolation: null },
        },
      }),
    });
    // 写入侧约定位置：<runDir>/reliability/<runId>.jsonl（run-reliability.mjs 的
    // sentinel/scorecard 派发 --run-dir 落账处）。isolation 如实 null——无 id 即
    // 无可回查主张，不该有任何限制项。
    const transcriptsDir = join(runDir, "reliability");
    mkdirSync(transcriptsDir, { recursive: true });
    writeFileSync(join(transcriptsDir, "run_t1.jsonl"), '{"type":"run.started"}\n', "utf8");
    writeFileSync(join(transcriptsDir, "run_t2.jsonl"), '{"type":"run.started"}\n', "utf8");

    const resolvable = await runEvidence({ registryPath, runDir });
    assert.equal(resolvable[0].applicability, "matched");
    assert.ok(
      !resolvable[0].limitationsAndSources.limitations.some((l) => l.startsWith("drill-evidence-unresolvable")),
      "id 各自可解析（isolation=null 不主张可回查）→ 无悬空限制项",
    );

    // 转录随后被删（复现实证形态：临时目录被清）——只读层必须把断裂浮出为限制项，
    // 且不改适用性三态（回查性是并列事实，不是画像判定输入）。
    rmSync(join(transcriptsDir, "run_t2.jsonl"), { force: true });
    const broken = await runEvidence({ registryPath, runDir });
    assert.equal(broken[0].applicability, "matched", "回查性限制项不改三态");
    const limits = broken[0].limitationsAndSources.limitations.join(" ");
    assert.match(limits, /drill-evidence-unresolvable:scorecard/, "被删转录的 drill 被点名");
    assert.ok(!/drill-evidence-unresolvable:[^ ]*sentinel/.test(limits), "仍在场的 run_t1 不误报");
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

// ===== audit11 缺口 1（2026-09-23）：自然过期进查询限制项 + SSOT 等值钉 =====
//
// 复核实证：组件记录自身时间已过期 45 天，详情仍显示"限制：无"；夹具资格自然
// 过期但未预标注 advisory.code 时两路均无提醒。修复 = observeComponentLedgerForSeat
// 现算时效（componentNaturalExpiry——classifyComponent 时间维的 src 侧镜像）。
// 等值钉（下方第一条测试）同时 import src 镜像与 scripts SSOT：常量或边界语义
// 漂移即红。全部只是 advisory 限制项：不改三态、不进门禁。

test("audit11 等值钉: src 自然时效镜像与 SSOT classifyComponent 同值同界（常量/边界漂移即红）", () => {
  assert.equal(COMPONENT_RECORD_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS,
    "组件记录新鲜期常量必须与 SSOT DEFAULT_MAX_AGE_DAYS 等值");
  assert.equal(COMPONENT_FIXTURE_MAX_AGE_DAYS, DEFAULT_FIXTURE_MAX_AGE_DAYS,
    "夹具新鲜期常量必须与 SSOT DEFAULT_FIXTURE_MAX_AGE_DAYS 等值");

  const now = "2026-09-23T00:00:00.000Z";
  const KEY = "backend:codex@92209bb";
  const classify = (record) => classifyComponent(
    { state: "loaded", ledger: { components: { [KEY]: record } } },
    KEY,
    { now },
  ).state;
  const at = (days) => new Date(Date.parse(now) - days * 86_400_000).toISOString();

  // 记录自身时间维（SSOT stale 维 2/3）：恰 30 天（严格大于才过期）双侧都新鲜；
  // 31 天双侧都过期；缺失/不可解析双侧都 fail-closed 过期。
  assert.equal(classify({ result: "pass", lastVerifiedAt: at(30) }), "normal");
  assert.equal(componentNaturalExpiry({ result: "pass", lastVerifiedAt: at(30) }, now), null);
  assert.equal(classify({ result: "pass", lastVerifiedAt: at(31) }), "stale");
  assert.equal(componentNaturalExpiry({ result: "pass", lastVerifiedAt: at(31) }, now), "stale");
  assert.equal(classify({ result: "pass" }), "stale");
  assert.equal(componentNaturalExpiry({ result: "pass" }, now), "stale");
  assert.equal(componentNaturalExpiry({ result: "pass", lastVerifiedAt: "not-a-date" }, now), "stale");

  // 夹具自然过期维（SSOT fixture-decayed，优先于 stale）：qualifiedAt 31 天前
  //（记录自身新鲜）双侧 fixture-decayed；恰 30 天双侧新鲜；owner-declared 超
  // ownerValidUntil 双侧 fixture-decayed。
  const fixtureExpired = {
    result: "pass",
    lastVerifiedAt: at(1),
    fixture: { qualifiedBy: "composition-cert", qualifiedAt: at(31) },
  };
  assert.equal(classify(fixtureExpired), "fixture-decayed");
  assert.equal(componentNaturalExpiry(fixtureExpired, now), "fixture-decayed");
  const fixtureFresh = {
    result: "pass",
    lastVerifiedAt: at(1),
    fixture: { qualifiedBy: "composition-cert", qualifiedAt: at(30) },
  };
  assert.equal(classify(fixtureFresh), "normal");
  assert.equal(componentNaturalExpiry(fixtureFresh, now), null);
  const ownerExpired = {
    result: "pass",
    lastVerifiedAt: at(1),
    fixture: { qualifiedBy: "owner-declared", ownerValidUntil: at(1) },
  };
  assert.equal(classify(ownerExpired), "fixture-decayed");
  assert.equal(componentNaturalExpiry(ownerExpired, now), "fixture-decayed");

  // 优先级镜像：blocked / 预标注 advisory 由磁盘事实优先（SSOT 同款），镜像不重复计。
  assert.equal(classify({ result: "blocked", lastVerifiedAt: at(31) }), "blocked");
  assert.equal(componentNaturalExpiry({ result: "blocked", lastVerifiedAt: at(31) }, now), null);
  assert.equal(
    componentNaturalExpiry(
      { result: "pass", lastVerifiedAt: at(31), advisory: { code: "fixture-decayed" } },
      now,
    ),
    null,
    "预标注 fixture-decayed 走既有 component-advisory 限制项，镜像不重复计",
  );
});

test("audit11 缺口1①: 组件记录自身时间自然过期（45 天，未预标注）→ matched 不变 + 限制项点名（不得淡化成无）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-a11-exp-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        lastVerifiedAt: "2026-08-08T00:00:00.000Z", // NOW 前 45+ 天，无 advisory 预标注
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "matched", "自然过期是 advisory 提醒，不改三态");
    assert.equal(rows[0].componentObserved.backend[0].naturalExpiry, "stale");
    const limits = rows[0].limitationsAndSources.limitations.join(" ");
    assert.match(limits, /component-expired:1/, "限制项点名记录自身自然过期");
    assert.match(limits, /componentLedger\.mjs stale/, "措辞指明 SSOT 出处");
    assert.ok(!limits.includes("component-fixture-decayed"), "无夹具账不误报夹具过期");
  } finally {
    cleanupDir(dir);
  }
});

test("audit11 缺口1②: 夹具资格自然过期（qualifiedAt 45 天前，未预标注 advisory.code）→ 限制项点名 fixture-decayed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-a11-fx-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        // 记录自身时间新鲜（2026-09-21 vs NOW 2026-09-22）——只有夹具资格过期。
        fixture: { qualifiedBy: "composition-cert", qualifiedAt: "2026-08-08T00:00:00.000Z" },
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "matched", "夹具自然过期是 advisory 提醒，不改三态");
    assert.equal(rows[0].componentObserved.backend[0].naturalExpiry, "fixture-decayed");
    const limits = rows[0].limitationsAndSources.limitations.join(" ");
    assert.match(limits, /component-fixture-decayed:1/, "限制项点名夹具资格自然过期");
    assert.ok(!/component-expired:/.test(limits), "记录自身新鲜不误报 component-expired");
    assert.ok(!limits.includes("component-advisory:fixture-decayed"),
      "未预标注：不走磁盘 advisory 透出路径，走自然过期路径");
  } finally {
    cleanupDir(dir);
  }
});

test("audit11 缺口1 对照: 记录与夹具均新鲜 → 无自然过期限制项（不误报、既有行为不变）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-a11-fresh-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        fixture: { qualifiedBy: "composition-cert", qualifiedAt: "2026-09-21T10:00:00.000Z" },
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].componentObserved.backend[0].naturalExpiry, null);
    assert.ok(
      !rows[0].limitationsAndSources.limitations.some(
        (l) => l.startsWith("component-expired") || l.startsWith("component-fixture-decayed"),
      ),
      "新鲜记录不得产生自然过期限制项",
    );
  } finally {
    cleanupDir(dir);
  }
});

// ===== audit12 F1（2026-09-23 第二轮）：非 matched 路径不得漏掉组件限制汇总 =====
//
// 复核实证：observeComponentLedgerForSeat 已算出 naturalExpiry（组件观测列可见），
// 但 assessCertEvidenceApplicability 的早返回让组件限制汇总只在 matched 尾部执行
// ——下述三组反例各自只剩单条限制（过期限制被吞）。修复 = 汇总抽成
// componentObservationLimitations 纯函数，在所有返回路径（matched / mismatched /
// undeterminable）追加。CLI/MCP 两路：本文件下方 audit12 F1 CLI 用例 +
// test/mcp-surface/mcpRegistryCertEvidence.test.js ADR32-MCP-10。

test("audit12 F1 反例1: 组件过期 + effort 不匹配 → mismatched 且限制项同时含 effort-mismatch 与 component-expired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-a12-f1a-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    const profile = matchedWorkerRecord().executionProfile;
    writeSummary(runDir, {
      auditor: matchedWorkerRecord({ executionProfile: { ...profile, effort: "medium" } }),
    });
    // 组件记录自身时间自然过期（NOW 2026-09-22 前 45+ 天，未预标注）。
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        lastVerifiedAt: "2026-08-08T00:00:00.000Z",
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "mismatched");
    assert.equal(rows[0].componentObserved.backend[0].naturalExpiry, "stale", "服务已算出自然过期");
    const limits = rows[0].limitationsAndSources.limitations.join(" ");
    assert.match(limits, /effort-mismatch: declared=high evidence=medium/);
    assert.match(limits, /component-expired:1/, "过期限制不得被 mismatched 早返回吞掉");
  } finally {
    cleanupDir(dir);
  }
});

test("audit12 F1 反例2: 夹具过期 + legacy 无画像 → undeterminable 且限制项同时含画像未记录与 component-fixture-decayed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-a12-f1b-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord({ executionProfile: undefined }) });
    // 记录自身时间新鲜（2026-09-21），夹具资格自然过期（qualifiedAt 45+ 天前，
    // 未预标注 advisory.code）。
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        fixture: { qualifiedBy: "composition-cert", qualifiedAt: "2026-08-08T00:00:00.000Z" },
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "undeterminable");
    assert.equal(rows[0].componentObserved.backend[0].naturalExpiry, "fixture-decayed", "服务已算出夹具过期");
    const limits = rows[0].limitationsAndSources.limitations.join(" ");
    assert.match(limits, /execution-profile-not-recorded/);
    assert.match(limits, /component-fixture-decayed:1/, "夹具过期限制不得被 undeterminable 早返回吞掉");
  } finally {
    cleanupDir(dir);
  }
});

test("audit12 F1 反例3: 组件过期 + 组合无记录/读取错误 → undeterminable 且限制项同时含组合来源问题与 component-expired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-a12-f1c-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const expiredLedger = {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        lastVerifiedAt: "2026-08-08T00:00:00.000Z",
      }),
    };
    // (a) 组合账可读但无该席位记录（缺证据 ≠ 匹配）。
    {
      const runDir = makeRunDir(dir, "-a");
      writeSummary(runDir, { coder_hq: matchedWorkerRecord() }); // 只有别的席位
      writeComponentLedger(runDir, expiredLedger);
      const rows = await runEvidence({ registryPath, runDir });
      assert.equal(rows[0].applicability, "undeterminable");
      const limits = rows[0].limitationsAndSources.limitations.join(" ");
      assert.match(limits, /no-worker-record/);
      assert.match(limits, /component-expired:1/, "无记录路径同样带上组件过期限制");
    }
    // (b) 组合账读取错误（EACCES，非缺文件非坏 JSON）——组件账照常从磁盘读取。
    {
      const runDir = makeRunDir(dir, "-b");
      writeComponentLedger(runDir, expiredLedger);
      const readFileFn = async (path, ...rest) => {
        if (String(path).includes("reliability-summary.json")) {
          const err = new Error("EACCES: permission denied");
          err.code = "EACCES";
          throw err;
        }
        return readFile(path, ...rest);
      };
      const rows = await runEvidence({ registryPath, runDir, readFileFn });
      assert.equal(rows[0].combined.state, "read-error");
      assert.equal(rows[0].applicability, "undeterminable");
      const limits = rows[0].limitationsAndSources.limitations.join(" ");
      assert.match(limits, /reliability-ledger:read-error/);
      assert.match(limits, /component-expired:1/, "读取错误路径同样带上组件过期限制");
    }
  } finally {
    cleanupDir(dir);
  }
});

// 剩余三条返回分支（画像不完整 / 内部矛盾 / 身份不匹配）与组件过期组合——
// WQ-02：改动的行为是"所有限制汇总在所有返回路径执行"，逐返回语句覆盖。
test("audit12 F1 分支补全: 画像不完整 / 内部矛盾 / 身份不匹配三条返回路径同样带组件过期限制", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-a12-f1e-"));
  try {
    const registryPath = makeRegistry(dir, {
      seat_incomplete: auditorAgent(dir),
      seat_contradiction: auditorAgent(dir),
      seat_idmm: auditorAgent(dir),
    });
    const runDir = makeRunDir(dir);
    const profile = matchedWorkerRecord().executionProfile;
    writeSummary(runDir, {
      // 返回分支：execution-profile-incomplete（四元组不完整 → undeterminable）。
      seat_incomplete: { status: "certified", executionProfile: { effort: "high" } },
      // 返回分支：identity-contradiction（顶层与画像矛盾 → mismatched）。
      seat_contradiction: matchedWorkerRecord({ executionProfile: { ...profile, modelId: "gpt-6-b-sidian" } }),
      // 返回分支：identity-mismatch（顶层 backend 漂移 → mismatched）。
      seat_idmm: matchedWorkerRecord({ backend: "claude-code" }),
    });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        lastVerifiedAt: "2026-08-08T00:00:00.000Z",
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const cases = [
      ["seat_incomplete", "undeterminable", /execution-profile-incomplete:/],
      ["seat_contradiction", "mismatched", /identity-contradiction:modelId/],
      ["seat_idmm", "mismatched", /identity-mismatch:backend/],
    ];
    for (const [id, applicability, primary] of cases) {
      const row = byId.get(id);
      assert.equal(row.applicability, applicability, id);
      const limits = row.limitationsAndSources.limitations.join(" ");
      assert.match(limits, primary, id + " 主限制项在场");
      assert.match(limits, /component-expired:1/, id + " 返回路径同样带上组件过期限制");
    }
  } finally {
    cleanupDir(dir);
  }
});

test("audit12 F1 对照: 非 matched 路径 + 组件与夹具均新鲜 → 不新增自然过期限制项（不误报）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-a12-f1d-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    const profile = matchedWorkerRecord().executionProfile;
    writeSummary(runDir, {
      auditor: matchedWorkerRecord({ executionProfile: { ...profile, effort: "medium" } }),
    });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        fixture: { qualifiedBy: "composition-cert", qualifiedAt: "2026-09-21T10:00:00.000Z" },
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    assert.equal(rows[0].applicability, "mismatched");
    const limits = rows[0].limitationsAndSources.limitations.join(" ");
    assert.match(limits, /effort-mismatch/);
    assert.ok(
      !/component-expired:|component-fixture-decayed:/.test(limits),
      "新鲜组件在非 matched 路径同样不得误报自然过期",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("audit12 F1 CLI: 三组反例经 --cert-evidence 限制列都不得漏自然过期（两路之一）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-a12-f1cli-"));
  const env = { ...process.env, WAO_SKIP_VERSION_GUARD: "1" };
  const certEvidence = (registryPath, runDir) => execSync(
    "node src/cli.js registry list --registry " + registryPath + " --run-dir " + runDir + " --cert-evidence",
    { cwd: REPO_ROOT, encoding: "utf8", env },
  );
  try {
    // 主 runDir：反例1（effort 不匹配 + 组件过期）/ 反例2（legacy 无画像 + 夹具过期）/
    // 反例3a（组合无记录 + 组件过期）三个席位同账。
    const registryPath = makeRegistry(dir, {
      seat_effmm: auditorAgent(dir),
      seat_legacy: auditorAgent(dir),
      seat_norec: auditorAgent(dir),
    });
    const runDir = makeRunDir(dir);
    const profile = matchedWorkerRecord().executionProfile;
    writeSummary(runDir, {
      seat_effmm: matchedWorkerRecord({ executionProfile: { ...profile, effort: "medium" } }),
      seat_legacy: matchedWorkerRecord({ executionProfile: undefined }),
      // seat_norec: 无记录
    });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#expired": componentRecord({
        key: "backend:codex@92209bb#expired",
        lastVerifiedAt: "2026-08-08T00:00:00.000Z",
      }),
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        fixture: { qualifiedBy: "composition-cert", qualifiedAt: "2026-08-08T00:00:00.000Z" },
      }),
    });
    const out = certEvidence(registryPath, runDir);
    // 按席位切块（每块以 "cert-evidence <id>" 起），逐席断言两条限制同时在场。
    const blocks = new Map(
      out.split(/^cert-evidence /m).slice(1).map((b) => [b.slice(0, b.indexOf("\n")).trim(), b]),
    );
    assert.equal(blocks.size, 3);
    const effmm = blocks.get("seat_effmm");
    assert.match(effmm, /effort-mismatch: declared=high evidence=medium/);
    assert.match(effmm, /component-expired:1/, "CLI 反例1：过期限制与 effort-mismatch 并列");
    const legacy = blocks.get("seat_legacy");
    assert.match(legacy, /execution-profile-not-recorded/);
    assert.match(legacy, /component-fixture-decayed:1/, "CLI 反例2：夹具过期与画像未记录并列");
    const norec = blocks.get("seat_norec");
    assert.match(norec, /no-worker-record/);
    assert.match(norec, /component-expired:1/, "CLI 反例3a：过期限制与无记录并列");

    // 反例3b（组合账读取错误 + 组件过期）：目录占位 reliability-summary.json
    //（EISDIR/EPERM，跨平台非 ENOENT——与 MCP 测试 4(d) 同款真实读取路径）。
    const runDirErr = join(dir, "runs-err");
    mkdirSync(runDirErr, { recursive: true });
    mkdirSync(join(runDirErr, "reliability-summary.json"));
    writeComponentLedger(runDirErr, {
      "backend:codex@92209bb#expired": componentRecord({
        key: "backend:codex@92209bb#expired",
        lastVerifiedAt: "2026-08-08T00:00:00.000Z",
      }),
    });
    const outErr = certEvidence(registryPath, runDirErr);
    assert.match(outErr, /证据适用性: undeterminable/);
    assert.match(outErr, /reliability-ledger:read-error/);
    assert.match(outErr, /component-expired:1/, "CLI 反例3b：读取错误路径同样带上过期限制");
  } finally {
    cleanupDir(dir);
  }
});

// ===== audit12 F2（2026-09-23 第二轮）：owner 期限等号边界纳入等值钉 =====
//
// 复核实证：把 src 与 SSOT 两侧 owner 边界同时 > → >=，上方 audit11 等值钉仍绿
//（它只测了 strictly-past 的 ownerExpired），但 now === ownerValidUntil 时两侧会
// 分歧（一侧 normal、一侧 fixture-decayed）。本钉把等号边界钉成绝对语义：
// ownerValidUntil 含该时刻（有效至并含）——now === ownerValidUntil 双侧都仍
// normal/null；恰过界（strictly past）双侧都过期。改任一侧（或两侧同时）的等号
// 语义（> → >=）此钉必红（变异验证记录见交付报告）。

test("audit12 F2 边界等值钉: owner 期限等号边界（now === ownerValidUntil 仍有效）双侧同判", () => {
  const now = "2026-09-23T00:00:00.000Z";
  const KEY = "backend:codex@92209bb";
  const classify = (record) => classifyComponent(
    { state: "loaded", ledger: { components: { [KEY]: record } } },
    KEY,
    { now },
  ).state;
  const at = (days) => new Date(Date.parse(now) - days * 86_400_000).toISOString();

  const ownerBoundary = {
    result: "pass",
    lastVerifiedAt: at(1),
    fixture: { qualifiedBy: "owner-declared", ownerValidUntil: at(0) }, // at(0) === now
  };
  assert.equal(Date.parse(ownerBoundary.fixture.ownerValidUntil), Date.parse(now),
    "前置自检：ownerValidUntil 与 now 同毫秒（等号边界本身）");
  assert.equal(classify(ownerBoundary), "normal",
    "SSOT：now === ownerValidUntil 仍 normal（严格大于才过期）——SSOT 侧 > 改 >= 此钉必红");
  assert.equal(componentNaturalExpiry(ownerBoundary, now), null,
    "src 镜像：now === ownerValidUntil 不判 fixture-decayed——src 侧 > 改 >= 此钉必红");

  // 边界另一侧对照：恰过界 1 天双侧都过期（语义连续：等号内有效、过界即过期）。
  const ownerJustPast = {
    ...ownerBoundary,
    fixture: { qualifiedBy: "owner-declared", ownerValidUntil: at(1) },
  };
  assert.equal(classify(ownerJustPast), "fixture-decayed");
  assert.equal(componentNaturalExpiry(ownerJustPast, now), "fixture-decayed");
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

test("TD-186 钉②（不得合并成绿，详情层）: 历史通过 + 本次失败——组合列如实 draft-only，历史全绿时间只作历史事实保留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-p2-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    // summary 层钉（reliabilityCertification.test.js TD-186 钉②）已证 summarize 时
    // status=draft-only 且 lastHealthyRunAt 保留历史时间；本钉证【详情查询面】读
    // 到该形状时不得把历史全绿读成"当前绿"。
    writeSummary(runDir, {
      auditor: matchedWorkerRecord({
        status: "draft-only",
        lastHealthyRunAt: "2026-08-10T00:00:00.000Z",
        lastFullHealthyRunAt: "2026-08-10T00:00:00.000Z",
      }),
    });
    const rows = await runEvidence({ registryPath, runDir });
    const row = rows[0];
    assert.equal(row.combined.record.status, "draft-only", "本次失败必须如实可见（不被历史全绿覆盖）");
    assert.equal(row.combined.record.lastFullHealthyRunAt, "2026-08-10T00:00:00.000Z",
      "历史全绿时间保留为历史事实（取证时间不抹除）");
    // 身份/画像仍匹配 → applicability=matched；但 matched 只陈述"证据适用"，
    // 不与 status 合并成任何可用性绿（质量列与适用性列并列）。
    assert.equal(row.applicability, "matched");
    const dumped = JSON.stringify(row);
    assert.ok(!/"(?:available|usable|overall|green|dispatchable)":\s*true/.test(dumped),
      "历史通过 + 本次失败不得产出任何合并绿布尔");
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

test("TD-186 B CLI（B2 取证时间）: 组件观测行渲染 lastVerifiedAt；组合列渲染 capturedAt/lastFullHealthy——取证时间不得在渲染层丢弃", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-cli2-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    writeSummary(runDir, { auditor: matchedWorkerRecord() });
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord(),
    });
    const rows = await runEvidence({ registryPath, runDir });
    // 服务行本就携带（JSON 路径无损）；
    assert.equal(rows[0].componentObserved.backend[0].lastVerifiedAt, "2026-09-21T10:00:00.000Z");
    const out = execSync(
      "node src/cli.js registry list --registry " + registryPath + " --run-dir " + runDir + " --cert-evidence",
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } },
    );
    // 文本渲染（B2 前丢弃）三处取证时间都必须在场：
    assert.match(out, /组件观测: state=ok .*backend=\[pass@92209bb@2026-09-21T10:00:00\.000Z#/,
      "组件观测行携带 lastVerifiedAt（result@codeRef@lastVerifiedAt#fingerprint）");
    assert.match(out, /capturedAt=2026-09-22T15:05:15\.876Z/, "组合列携带画像 capturedAt");
    assert.match(out, /lastFullHealthy=2026-09-22T15:05:15\.876Z/, "组合列携带全绿时间戳");
  } finally {
    cleanupDir(dir);
  }
});

test("audit11 B2 CLI: 两类自然过期都进限制列（限制与来源不得显示 无）+ lastFullHealthy 缺席渲染 ?", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-a11-cli-"));
  try {
    const registryPath = makeRegistry(dir, { auditor: auditorAgent(dir) });
    const runDir = makeRunDir(dir);
    // 组合记录有 status 但缺全绿时间戳（legacy 半迁移形状）→ lastFullHealthy=?。
    writeSummary(runDir, { auditor: matchedWorkerRecord({ lastFullHealthyRunAt: undefined }) });
    // 组件账两条记录：①自身时间 45 天前自然过期（无预标注）②夹具资格自然过期。
    writeComponentLedger(runDir, {
      "backend:codex@92209bb#v1-abc123def4567890": componentRecord({
        lastVerifiedAt: "2026-08-08T00:00:00.000Z",
      }),
      "backend:codex@92209bb": componentRecord({
        key: "backend:codex@92209bb",
        fixture: { qualifiedBy: "composition-cert", qualifiedAt: "2026-08-08T00:00:00.000Z" },
      }),
    });
    const out = execSync(
      "node src/cli.js registry list --registry " + registryPath + " --run-dir " + runDir + " --cert-evidence",
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } },
    );
    assert.match(out, /component-expired:1/, "CLI 限制列点名记录自身自然过期");
    assert.match(out, /component-fixture-decayed:1/, "CLI 限制列点名夹具资格自然过期");
    assert.ok(!out.includes("限制与来源: 无"), "存在限制项时不得显示 无（措辞不得淡化）");
    assert.match(out, /lastFullHealthy=\?/, "全绿时间戳缺席渲染 ?（不整项省略）");
    // 对照：有值时保留——既有 B2 CLI 测试已钉 lastFullHealthy=2026-09-22T15:05:15.876Z。
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
