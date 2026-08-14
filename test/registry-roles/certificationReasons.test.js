// test/certificationReasons.test.js
//
// TD-111: certification advisory context — 闭集 reasonCode + 新鲜度（freshness）。
//
// 四层契约：
//   1. SSOT：src/application/certificationReasons.js 拥有冻结闭集
//      CERTIFICATION_REASON_CODES 与纯映射 reasonCodeFor()。blockerReason 原文
//      绝不进码、绝不进任何输出。
//   2. 聚合：scripts/reliability/certification.mjs 在 case 级并列嵌入 reasonCode
//      （经 SSOT 映射），并在 summarizeWorkers 聚合 per-worker reasonCode +
//      lastHealthyRunAt；scripts/run-reliability.mjs 给每个 caseResult 记
//      lastHealthyRunAt（全绿 = ISO 时间；非全绿 = null）。
//   3. 投影：registryInventory 并列透出 certificationReasonCode /
//      certificationLastHealthyAt（bounded 日期字符串或 null）；旧 summary 缺字段
//      投影为 null（不伪造）；certificationFor 返回类型不变（仍为纯字符串）。
//   4. MCP：AGENT_ENTRY / LEAD_PREFLIGHT_OUTPUT 的 reasonCode enum 从同一 SSOT
//      import 派生（READ_FAILURE_REASONS 同源接线范式），无第二份手工清单。
//
// 纯测试：只 import node 内置 + src/scripts 模块 + 内存 fixture（无网络/锁/进程/
// MCP SDK client）。SSOT 模块用动态 import，使每条 RED 在模块缺失时以"自身正确
// 原因"失败，而不是整个文件在顶层 import 即崩。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getRegistryInventory } from "../../src/application/registryInventory.js";
import { certifyCase, summarizeCertification } from "../../scripts/reliability/certification.mjs";

const loadSsot = () => import("../../src/application/certificationReasons.js");

// 四类全过（certified）的 checks fixture。
function allGreenChecks() {
  return [
    { name: "completed", pass: true, category: "core" },
    { name: "commandsPassed", pass: true, category: "strict" },
    { name: "backendStopQuietVerified", pass: true, category: "operational" },
    { name: "metricsNonZero", pass: true, category: "observability" },
  ];
}

// 内存 registry/summary fixture（M9-0-07 注入范式，无真实文件系统）。
function fakeReadRegistry(agentId, backend, modelId) {
  return async () => ({
    listAgents: () => [{ id: agentId, backend, cwd: "/repo", model: { id: modelId } }],
  });
}

async function inventoryWithSummary(agent, workers) {
  const fakeReadFile = async () => JSON.stringify({ workers });
  return getRegistryInventory({
    registryPath: "/r.json",
    runDir: "/runs",
    readRegistryFn: fakeReadRegistry(agent.id, agent.backend, agent.modelId),
    readFileFn: fakeReadFile,
  });
}

// =====================================================================
// RED①：SSOT 闭集 + 纯映射（五分支 → 闭集内且互异的码）
// =====================================================================

test("TD-111-R1a: CERTIFICATION_REASON_CODES 是冻结、去重的闭集（模块加载期自检）", async () => {
  const { CERTIFICATION_REASON_CODES } = await loadSsot();
  assert.ok(Array.isArray(CERTIFICATION_REASON_CODES), "SSOT 应导出 CERTIFICATION_REASON_CODES 数组");
  assert.ok(Object.isFrozen(CERTIFICATION_REASON_CODES), "闭集必须 Object.freeze 冻结");
  assert.equal(
    new Set(CERTIFICATION_REASON_CODES).size,
    CERTIFICATION_REASON_CODES.length,
    "闭集不得含重复码（模块加载期去重自检）",
  );
});

test("TD-111-R1b: reasonCodeFor 五类 fixture 输入 → 闭集内且互异的码；certified → null", async () => {
  const { CERTIFICATION_REASON_CODES, reasonCodeFor } = await loadSsot();
  // 五类输入对应 certification.mjs certifyCase 的五条失败分支（:38-56 顺序）。
  const fixtures = [
    {
      name: "blocked",
      input: {
        status: "blocked",
        // blockerReason 是自由文本（调用方/错误派生）——只应决定分支，绝不进码。
        blockerReason: "provider error [429]: 1310 usage upper limit exceeded",
        // blocked case 常伴随 core 失败（run 未完成）——blocked 分支必须优先。
        failedChecks: [{ name: "completed", category: "core" }],
      },
    },
    {
      name: "core",
      input: { status: "rejected", failedChecks: [{ name: "completed", category: "core" }] },
    },
    {
      name: "strict",
      input: { status: "draft-only", failedChecks: [{ name: "commandsPassed", category: "strict" }] },
    },
    {
      name: "operational",
      input: {
        status: "conditional",
        failedChecks: [
          { name: "isolation", category: "operational" },
          { name: "metricsNonZero", category: "observability" },
        ],
      },
    },
    {
      name: "missing",
      input: { status: "conditional", failedChecks: [], missingCategories: ["strict", "operational", "observability"] },
    },
  ];

  const codes = [];
  for (const f of fixtures) {
    const code = reasonCodeFor(f.input);
    assert.ok(
      CERTIFICATION_REASON_CODES.includes(code),
      `${f.name}: reasonCodeFor 输出（${String(code)}）必须在闭集内`,
    );
    codes.push(code);
  }
  assert.equal(new Set(codes).size, fixtures.length, "五类输入的码必须互异（一一对应五条分支）");

  // certified → null：advisory 上下文只解释"为什么不是 certified"。
  assert.equal(
    reasonCodeFor({ status: "certified", failedChecks: [], missingCategories: [] }),
    null,
    "certified → null（无 advisory 码）",
  );
});

test("TD-111-R1c: certifyCase 并列输出 reasonCode（case 级，经 SSOT；旧 reason 字段不动）", async () => {
  await loadSsot(); // RED 阶段：SSOT 缺失即本测试红（certification.mjs 依赖它输出 reasonCode）

  const blocked = certifyCase({
    caseId: "blocked-case",
    blockedReason: "provider error [429]: 1310 usage upper limit exceeded",
    checks: [{ name: "completed", pass: false, category: "core" }],
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reasonCode, "case_blocked", "blocked 分支优先于 core 失败");

  const core = certifyCase({
    caseId: "core-case",
    checks: [{ name: "completed", pass: false, category: "core" }],
  });
  assert.equal(core.status, "rejected");
  assert.equal(core.reasonCode, "core_checks_failed");

  const strict = certifyCase({
    caseId: "strict-case",
    checks: [
      { name: "completed", pass: true, category: "core" },
      { name: "commandsPassed", pass: false, category: "strict" },
    ],
  });
  assert.equal(strict.status, "draft-only");
  assert.equal(strict.reasonCode, "strict_evidence_failed");

  const operational = certifyCase({
    caseId: "ops-case",
    checks: [
      { name: "completed", pass: true, category: "core" },
      { name: "commandsPassed", pass: true, category: "strict" },
      { name: "backendStopQuietVerified", pass: false, category: "operational" },
    ],
  });
  assert.equal(operational.status, "conditional");
  assert.equal(operational.reasonCode, "operational_or_observability_failed");

  const missing = certifyCase({
    caseId: "missing-case",
    // 只有 core 类 check → strict/operational/observability 全缺。
    checks: [{ name: "completed", pass: true, category: "core" }],
  });
  assert.equal(missing.status, "conditional");
  assert.equal(missing.reasonCode, "missing_certification_checks");

  const certified = certifyCase({ caseId: "green-case", checks: allGreenChecks() });
  assert.equal(certified.status, "certified");
  assert.equal(certified.reasonCode, null, "certified → null");
});

test("TD-111-R1d: summarizeWorkers 聚合 per-worker reasonCode + lastHealthyRunAt", () => {
  // 同一 worker：一个全绿 case（带时间戳）+ 一个 core 失败 case。
  // 最终 status=rejected（最差），reasonCode 取"决定最差 status 的 case"的码；
  // lastHealthyRunAt 保留最近一次全绿 case 的时间（与当前 status 独立）。
  const summary = summarizeCertification([
    {
      caseId: "w-green",
      agentId: "w",
      checks: allGreenChecks(),
      lastHealthyRunAt: "2026-08-01T00:00:00.000Z",
    },
    {
      caseId: "w-red",
      agentId: "w",
      checks: [{ name: "completed", pass: false, category: "core" }],
      lastHealthyRunAt: null,
    },
  ]);
  const w = summary.workers.w;
  assert.equal(w.status, "rejected");
  assert.equal(w.reasonCode, "core_checks_failed", "worker 码 = 决定最差 status 的 case 的码");
  assert.equal(w.lastHealthyRunAt, "2026-08-01T00:00:00.000Z", "最近一次全绿 case 的时间保留");

  // 多个全绿 case → 取最近（max）。
  const multi = summarizeCertification([
    { caseId: "m1", agentId: "m", checks: allGreenChecks(), lastHealthyRunAt: "2026-08-01T00:00:00.000Z" },
    { caseId: "m2", agentId: "m", checks: allGreenChecks(), lastHealthyRunAt: "2026-08-10T00:00:00.000Z" },
  ]);
  assert.equal(multi.workers.m.lastHealthyRunAt, "2026-08-10T00:00:00.000Z", "取最近一次全绿时间");
  assert.equal(multi.workers.m.status, "certified");
  assert.equal(multi.workers.m.reasonCode, null, "certified worker → 无 advisory 码");

  // 从未全绿 → null（不伪造）。
  const never = summarizeCertification([
    { caseId: "b-red", agentId: "b", checks: [{ name: "completed", pass: false, category: "core" }], lastHealthyRunAt: null },
  ]);
  assert.equal(never.workers.b.lastHealthyRunAt, null);
  assert.equal(never.workers.b.reasonCode, "core_checks_failed");

  // 旧格式 case（磁盘 prior：certification 预置、无 reasonCode、无 lastHealthyRunAt）
  // → 经 SSOT 尽力重 derive（blocked 优先于 core）；时间戳不伪造。
  const legacy = summarizeCertification([
    {
      caseId: "old-blocked",
      agentId: "lw",
      certification: {
        status: "blocked",
        reason: "provider/credential/quota blocker",
        failedChecks: [{ name: "completed", category: "core" }],
      },
    },
  ]);
  assert.equal(legacy.workers.lw.status, "blocked");
  assert.equal(legacy.workers.lw.reasonCode, "case_blocked", "旧数据经 SSOT 重 derive（blocked 分支优先）");
  assert.equal(legacy.workers.lw.lastHealthyRunAt, null, "旧 case 无时间戳 → null");

  // 旧 identity 的全绿时间不得计入 active identity 的新鲜度（与 status/capabilities
  // 聚合同规则：只聚合 active identity 的 case）。
  const identity = summarizeCertification([
    {
      caseId: "legacy-green",
      agentId: "iw",
      backend: "claude-code",
      providerID: "anthropic",
      modelId: "sonnet-4.5",
      checks: allGreenChecks(),
      lastHealthyRunAt: "2026-07-01T00:00:00.000Z",
    },
    {
      caseId: "active-red",
      agentId: "iw",
      backend: "deepseek-harness",
      providerID: "deepseek",
      modelId: "deepseek-v4-flash",
      checks: [{ name: "completed", pass: false, category: "core" }],
      lastHealthyRunAt: null,
    },
  ]);
  assert.equal(identity.workers.iw.status, "rejected");
  assert.equal(identity.workers.iw.reasonCode, "core_checks_failed");
  assert.equal(identity.workers.iw.lastHealthyRunAt, null, "旧 identity 的全绿时间不计入 active identity");
});

// =====================================================================
// RED②：投影并列透出两新字段；旧格式 summary → null（不伪造）
// =====================================================================

const HQ = { id: "coder_hq", backend: "claude-code", modelId: "glm-5.2" };

test("TD-111-R2a: 投影并列透出 certificationReasonCode/certificationLastHealthyAt", async () => {
  const fresh = await inventoryWithSummary(HQ, {
    coder_hq: {
      status: "conditional",
      backend: "claude-code",
      modelId: "glm-5.2",
      reasonCode: "operational_or_observability_failed",
      lastHealthyRunAt: "2026-08-10T06:20:00.000Z",
    },
  });
  assert.ok(Object.hasOwn(fresh[0], "certificationReasonCode"), "inventory entry 应含 certificationReasonCode 字段");
  assert.equal(fresh[0].certificationReasonCode, "operational_or_observability_failed");
  assert.ok(Object.hasOwn(fresh[0], "certificationLastHealthyAt"), "inventory entry 应含 certificationLastHealthyAt 字段");
  assert.equal(fresh[0].certificationLastHealthyAt, "2026-08-10T06:20:00.000Z");
  // certificationFor 返回类型不变：仍是纯字符串。
  assert.equal(fresh[0].certification, "conditional");
});

test("TD-111-R2b: 旧格式 summary（缺新字段）→ 投影为 null，不伪造", async () => {
  const legacy = await inventoryWithSummary(HQ, {
    coder_hq: { status: "certified", backend: "claude-code", modelId: "glm-5.2" },
  });
  assert.ok(Object.hasOwn(legacy[0], "certificationReasonCode"), "字段必须存在（值为 null，不是 undefined）");
  assert.equal(legacy[0].certificationReasonCode, null, "旧 summary 缺 reasonCode → null");
  assert.ok(Object.hasOwn(legacy[0], "certificationLastHealthyAt"), "字段必须存在（值为 null，不是 undefined）");
  assert.equal(legacy[0].certificationLastHealthyAt, null, "旧 summary 缺 lastHealthyRunAt → null");
  assert.equal(legacy[0].certification, "certified", "旧 certification 语义不变");
});

test("TD-111-R2c: identity 不匹配 → 认证（含新字段）不可继承；不可信值 fail-closed", async () => {
  // backend 不匹配（M9-0-06b 语义）：certification null，两新字段同样 null。
  const mismatch = await inventoryWithSummary(HQ, {
    coder_hq: {
      status: "certified",
      backend: "opencode-serve",
      modelId: "glm-5.2",
      reasonCode: null,
      lastHealthyRunAt: "2026-08-10T06:20:00.000Z",
    },
  });
  assert.equal(mismatch[0].certification, null);
  assert.equal(mismatch[0].certificationReasonCode, null, "identity 不匹配 → 不继承新字段");
  assert.equal(mismatch[0].certificationLastHealthyAt, null);

  // 被注入/损坏的 summary 值：闭集外的码、非 ISO 形状的日期 → null（绝不透出，
  // 否则 MCP outputSchema 的 enum parse 会把整个 registry_list 打成 error）。
  const injected = await inventoryWithSummary(HQ, {
    coder_hq: {
      status: "conditional",
      backend: "claude-code",
      modelId: "glm-5.2",
      reasonCode: "EVIL_INJECTED_CODE",
      lastHealthyRunAt: "not a date <script> C:\\secret\\path",
    },
  });
  assert.equal(injected[0].certificationReasonCode, null, "闭集外的码绝不透出");
  assert.equal(injected[0].certificationLastHealthyAt, null, "非 bounded ISO 形状的日期绝不透出");
});

// =====================================================================
// RED③：MCP schema enum 与 SSOT 同源（import 比对，无第二份清单）
// =====================================================================

test("TD-111-R3: AGENT_ENTRY/lead_preflight 的 certificationReasonCode enum 派生自 SSOT", async () => {
  const src = readFileSync(new URL("../../src/mcp/server.js", import.meta.url), "utf8");

  // 1. server.js 从 SSOT import（同源接线，READ_FAILURE_REASONS 范式）。
  assert.match(
    src,
    /import\s*\{[^}]*\bCERTIFICATION_REASON_CODES\b[^}]*\}\s*from\s*["'][^"']*application\/certificationReasons\.js["']/,
    "server.js 必须从 src/application/certificationReasons.js import CERTIFICATION_REASON_CODES",
  );

  // 2. AGENT_ENTRY 声明 certificationReasonCode：enum 由 SSOT 常量展开派生。
  assert.match(
    src,
    /certificationReasonCode:\s*z\.enum\(\[\.\.\.CERTIFICATION_REASON_CODES\]\)\.nullable\(\)/,
    "AGENT_ENTRY 的 certificationReasonCode 必须是 z.enum([...CERTIFICATION_REASON_CODES]).nullable()",
  );

  // 3. certificationLastHealthyAt：bounded nullable 字符串。
  assert.match(
    src,
    /certificationLastHealthyAt:\s*z\.string\(\)\.nullable\(\)/,
    "AGENT_ENTRY 的 certificationLastHealthyAt 必须是 z.string().nullable()",
  );

  // 4. LEAD_PREFLIGHT_OUTPUT 的 workers 条目同样接线（两处 enum 均从 SSOT 派生）。
  assert.ok(
    (src.match(/certificationReasonCode:\s*z\.enum\(\[\.\.\.CERTIFICATION_REASON_CODES\]\)/g) ?? []).length >= 2,
    "AGENT_ENTRY 与 LEAD_PREFLIGHT_OUTPUT 两处 enum 均须从 SSOT 派生",
  );
  assert.match(src, /certificationLastHealthyAt:\s*z\.string\(\)\.nullable\(\)/);

  // 5. 无第二份手工清单：SSOT 码值不得以字符串字面量形式再出现在 server.js。
  const { CERTIFICATION_REASON_CODES } = await loadSsot();
  for (const code of CERTIFICATION_REASON_CODES) {
    assert.ok(
      !src.includes(`"${code}"`),
      `server.js 不得维护第二份手写码清单（发现字面量 "${code}"）`,
    );
  }
});

// =====================================================================
// GREEN 守卫（非 RED——长期回归守卫，GREEN 后必须持续通过）
// =====================================================================

test("TD-111-G: 新字段 payload 不含 blockerReason 原文/路径/命令/stderr（安全形状）", async () => {
  const LEAK_PATH = "C:\\secret\\runs\\wao-leak\\transcript.jsonl";
  const LEAK_CMD = "node scripts/wao-node.cjs src/cli.js run --prompt";
  const LEAK_STDERR = "stderr: ECONNREFUSED 127.0.0.1:4298 quota 1310";

  // 构造含敏感内容的 fixture 输入：blockerReason 原文带路径/命令/stderr，
  // failedChecks.detail 带 stderr 文本。
  const cert = certifyCase({
    caseId: "leak-case",
    agentId: "leaker",
    blockedReason: `${LEAK_STDERR} at ${LEAK_PATH} via ${LEAK_CMD}`,
    checks: [{ name: "completed", pass: false, category: "core", detail: LEAK_STDERR }],
  });
  assert.equal(cert.status, "blocked");
  assert.equal(cert.reasonCode, "case_blocked", "码是闭集常量，与 blockerReason 原文无关");

  // 端到端：summary（磁盘契约，自由文本 reason/detail 保留）→ 投影 entry（wire 契约）。
  // entry 不得携带任何敏感原文——新字段只有闭集码 / null / bounded 日期。
  const summary = summarizeCertification([
    {
      caseId: "leak-case",
      agentId: "leaker",
      // identity 与 registry agent 一致（真实 run-reliability case 都带 backend/modelId；
      // 不声明则 worker.backend=null，投影按 identity 不匹配规则正确拒绝继承）。
      backend: "claude-code",
      modelId: "m",
      blockedReason: `${LEAK_STDERR} at ${LEAK_PATH} via ${LEAK_CMD}`,
      checks: [{ name: "completed", pass: false, category: "core", detail: LEAK_STDERR }],
      lastHealthyRunAt: null,
    },
  ]);
  const [entry] = await inventoryWithSummary(
    { id: "leaker", backend: "claude-code", modelId: "m" },
    summary.workers,
  );

  const dumped = JSON.stringify(entry);
  for (const bait of [LEAK_PATH, LEAK_CMD, LEAK_STDERR, "ECONNREFUSED", "1310"]) {
    assert.ok(!dumped.includes(bait), `投影 entry 不得泄漏敏感原文：${bait.slice(0, 40)}`);
  }

  const { CERTIFICATION_REASON_CODES } = await loadSsot();
  assert.ok(
    entry.certificationReasonCode === null || CERTIFICATION_REASON_CODES.includes(entry.certificationReasonCode),
    "certificationReasonCode 只能是闭集码或 null",
  );
  assert.ok(
    entry.certificationLastHealthyAt === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(entry.certificationLastHealthyAt),
    "certificationLastHealthyAt 只能是 bounded ISO 日期或 null",
  );
  assert.equal(entry.certificationReasonCode, "case_blocked");
});
