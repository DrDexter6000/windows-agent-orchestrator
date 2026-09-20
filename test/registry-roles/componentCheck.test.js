// test/registry-roles/componentCheck.test.js
//
// ADR-0032 §2/§3/§4/§6/§7：组件层执行侧（component-check 入口 + 组件 drills）
// 的 dry 测试——证伪优先，零真实 token（同 reliabilityDelta.test.js 先例：真实
// 派发由 Owner 手动 `npm run component-check` 触发，不在测试里烧）。
//
// 覆盖面：
//   1. 三类被测解析（--subject backend | llm | <kind>，含歧义/未知拒绝）；
//   2. 夹具资格两条路径：新鲜组合认证记录（composition-cert）/ Owner 显式指定
//      （certification.fixtures → owner-declared）；过期组合记录不合格；
//   3. 夹具不可用 → blocked（记录入账，blockedReason=fixture-unavailable）；
//   4. 零目标 → 入口 exit 2（子进程实证：无 ledger 副作用、绝不空转报通过）；
//   5. 夹具绿不得被读成被测绿（分账断言：台账只按被测键落账，夹具只进
//      record.fixture；被测红不被夹具绿洗白）；
//   6. 判定内核语义钉（sentinel 工具承载/精确回显/单行 JSON、scorecard 无
//      completed 顶替、事件完整性、能力声明双向一致、informational 不进判定）；
//   7. 结构钉：组件层不得 import 组合层 certifyCase/状态闭集；npm script 经
//      wao-node.cjs 转发。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseComponentCheckArgs,
  COMPONENT_CHECK_USAGE,
} from "../../scripts/reliability/componentArgs.mjs";
import {
  BACKEND_COMPONENT_DRILLS,
  LLM_COMPONENT_DRILLS,
  backendCapabilityConsistencyChecks,
  backendEventIntegrityChecks,
  componentResultFromChecks,
  createComponentDrills,
  executeComponentChecks,
  explicitFailureCheck,
  llmCompletionHonestyChecks,
  llmInstructionFloorChecks,
  llmOutOfBoundsDispositionCheck,
  llmScorecardEvidenceChecks,
  llmIdentityOf,
  planComponentChecks,
  qualifiedFixtureCandidates,
  resolveSubjects,
} from "../../scripts/reliability/componentDrills.mjs";
import {
  recordComponentCheck,
  summarizeComponentLedger,
} from "../../scripts/reliability/componentLedger.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const ENTRY = join(REPO_ROOT, "scripts", "run-component-check.mjs");
const CODE_REF = "deadbeefcafe1234";

const NOW = "2026-09-20T10:00:00.000Z";
const DAY = 86_400_000;
const iso = (offsetDays) => new Date(Date.parse(NOW) + offsetDays * DAY).toISOString();

// ── 合成 registry（身份字段全部来自"实际配置"——被测/夹具解析的单一来源）──

function syntheticRegistry() {
  return {
    agents: {
      researcher: {
        backend: "claude-code",
        provider: { protocol: "anthropic-compatible", baseUrl: "https://a.example/api", apiKeyEnv: "KEY_A" },
        cwd: ".",
        model: { id: "glm-5.3-flash[1m]", contextWindow: 1000000 },
      },
      tester: {
        backend: "codex",
        cwd: ".",
        model: { id: "gpt-5.6-sol" },
      },
      coder_mm: {
        backend: "kimi-code",
        cwd: ".",
        model: { id: "kimi-code/k3" },
      },
      fallback: {
        backend: "opencode-serve",
        serveUrl: "http://127.0.0.1:4297",
        agent: "build",
        cwd: ".",
        model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" },
        tokenBudget: 5000000,
        tokenBudgetMultiplier: 100,
      },
    },
  };
}

function compositionSummaryFixture({ healthyDaysAgo = 1, runId = "run_green_1" } = {}) {
  return {
    workers: {
      researcher: {
        agentId: "researcher",
        backend: "claude-code",
        providerID: null,
        modelId: "glm-5.3-flash[1m]",
        providerKey: "https://a.example/api|KEY_A",
        lastFullHealthyRunAt: iso(-healthyDaysAgo),
        lastHealthyRunAt: iso(-healthyDaysAgo),
      },
    },
    cases: [
      { caseId: "GLM lane", agentId: "researcher", pass: true, runId, lastHealthyRunAt: iso(-healthyDaysAgo) },
    ],
  };
}

function check_(name, pass, extra = {}) {
  return { name, pass, category: extra.category ?? "core", detail: extra.detail ?? "d", ...extra };
}

// ════ 1. 三类被测解析 ════

test("subjects: --subject backend → 在册全部 backend（去重排序，键含 codeRef）", () => {
  const { subjects, error } = resolveSubjects({ registry: syntheticRegistry(), subjectArg: "backend", codeRef: CODE_REF });
  assert.equal(error, null);
  assert.deepEqual(subjects.map((s) => s.name), ["claude-code", "codex", "kimi-code", "opencode-serve"]);
  for (const s of subjects) {
    assert.equal(s.kind, "backend");
    assert.equal(s.key, `backend:${s.name}@${CODE_REF}`);
    assert.ok(s.anchorAgentId, "backend 被测必须锚定在册 agent（装配解析身份）");
    assert.ok(s.capabilitySnapshot, "能力快照来自 backendCapabilitySnapshot SSOT");
  }
});

test("subjects: --subject llm → 在册全部 llm 身份（providerID 缺失时以 backend 家族名充当，providerKey 区分接入方）", () => {
  const { subjects, error } = resolveSubjects({ registry: syntheticRegistry(), subjectArg: "llm", codeRef: CODE_REF });
  assert.equal(error, null);
  assert.deepEqual(
    subjects.map((s) => `${s.providerID}/${s.modelId}`),
    ["claude-code/glm-5.3-flash[1m]", "codex/gpt-5.6-sol", "kimi-code/kimi-code/k3", "zhipuai-coding-plan/glm-5.2"],
  );
  assert.equal(subjects[0].providerKey, "https://a.example/api|KEY_A");
  assert.equal(subjects[1].providerKey, null, "无 provider 块 → null（已观察无接入方）");
});

test("subjects: <kind> 精确命中——backend 名 / providerID+modelId / 裸 modelId（唯一时）", () => {
  const registry = syntheticRegistry();
  const byBackend = resolveSubjects({ registry, subjectArg: "codex", codeRef: CODE_REF });
  assert.deepEqual(byBackend.subjects.map((s) => s.name), ["codex"]);

  const byFullLlm = resolveSubjects({ registry, subjectArg: "zhipuai-coding-plan/glm-5.2", codeRef: CODE_REF });
  assert.deepEqual(byFullLlm.subjects.map((s) => s.modelId), ["glm-5.2"]);

  const byBareModel = resolveSubjects({ registry, subjectArg: "gpt-5.6-sol", codeRef: CODE_REF });
  assert.deepEqual(byBareModel.subjects.map((s) => s.providerID), ["codex"]);

  // modelId 含 "/"（kimi-code/k3）的裸形态也命中。
  const bySlashModel = resolveSubjects({ registry, subjectArg: "kimi-code/k3", codeRef: CODE_REF });
  assert.deepEqual(bySlashModel.subjects.map((s) => s.backend ?? s.modelId), ["kimi-code/k3"]);
});

test("subjects【证伪】: 未知被测 / 裸 modelId 歧义 / 缺 codeRef / 缺 subject 全部显式 error", () => {
  const registry = syntheticRegistry();
  const unknown = resolveSubjects({ registry, subjectArg: "zcode", codeRef: CODE_REF });
  assert.match(unknown.error, /matches no backend name and no llm identity/);

  // 歧义：两个接入方跑同一 modelId（providerKey 不同）→ 裸 modelId 拒绝。
  const ambiguous = { agents: {
    laneA: { backend: "claude-code", cwd: ".", model: { id: "same-model" }, provider: { protocol: "anthropic-compatible", baseUrl: "https://a.example/api", apiKeyEnv: "KEY_A" } },
    laneB: { backend: "claude-code", cwd: ".", model: { id: "same-model" }, provider: { protocol: "anthropic-compatible", baseUrl: "https://b.example/api", apiKeyEnv: "KEY_B" } },
  } };
  const amb = resolveSubjects({ registry: ambiguous, subjectArg: "same-model", codeRef: CODE_REF });
  assert.match(amb.error, /ambiguous/);
  // 全形式（providerID/modelId 仍同）→ 也歧义；带 providerKey 区分不在 subject 语法面 → 保持拒绝。
  assert.match(resolveSubjects({ registry: ambiguous, subjectArg: "claude-code/same-model", codeRef: CODE_REF }).error, /ambiguous/);

  assert.match(resolveSubjects({ registry, subjectArg: "backend", codeRef: "" }).error, /codeRef/);
  assert.match(resolveSubjects({ registry, subjectArg: "", codeRef: CODE_REF }).error, /--subject is required/);
});

test("llmIdentityOf: 无 model.id → null（非 llm 主体）；providerID 维 = model.providerID ?? backend", () => {
  assert.equal(llmIdentityOf({ backend: "codex", cwd: "." }), null);
  assert.equal(llmIdentityOf(null), null);
  const withProviderID = llmIdentityOf(syntheticRegistry().agents.fallback);
  assert.equal(withProviderID.providerID, "zhipuai-coding-plan");
  const derived = llmIdentityOf(syntheticRegistry().agents.tester);
  assert.equal(derived.providerID, "codex");
});

// ════ 2. 夹具资格两条路径 ════

test("fixtures 路径 1: 新鲜组合认证记录 → composition-cert 候选（带可追溯 runId 与新鲜时间戳）", () => {
  const candidates = qualifiedFixtureCandidates({
    registry: syntheticRegistry(),
    compositionSummary: compositionSummaryFixture({ healthyDaysAgo: 2, runId: "run_green_42" }),
    now: NOW,
  });
  assert.equal(candidates.llm.length, 1);
  assert.equal(candidates.llm[0].qualifiedBy, "composition-cert");
  assert.equal(candidates.llm[0].runId, "run_green_42");
  assert.equal(candidates.llm[0].anchorAgentId, "researcher");
  assert.equal(candidates.llm[0].identity.modelId, "glm-5.3-flash[1m]");
  assert.equal(candidates.llm[0].identity.providerKey, "https://a.example/api|KEY_A");
  assert.equal(candidates.backend.length, 1);
  assert.equal(candidates.backend[0].identity.backend, "claude-code");
});

test("fixtures 路径 1【证伪】: 过期（>30 天）或无全绿时间戳的组合记录不合格", () => {
  const stale = qualifiedFixtureCandidates({
    registry: syntheticRegistry(),
    compositionSummary: compositionSummaryFixture({ healthyDaysAgo: 40 }),
    now: NOW,
  });
  assert.equal(stale.llm.length, 0);
  assert.equal(stale.backend.length, 0);

  const neverGreen = compositionSummaryFixture();
  delete neverGreen.workers.researcher.lastFullHealthyRunAt;
  delete neverGreen.workers.researcher.lastHealthyRunAt;
  const none = qualifiedFixtureCandidates({ registry: syntheticRegistry(), compositionSummary: neverGreen, now: NOW });
  assert.equal(none.llm.length, 0);
});

test("fixtures 路径 1【证伪】: 组合记录身份与当前 registry 漂移 → 不可装配不候选", () => {
  const drifted = compositionSummaryFixture();
  drifted.workers.researcher.modelId = "different-model-id";
  const candidates = qualifiedFixtureCandidates({ registry: syntheticRegistry(), compositionSummary: drifted, now: NOW });
  assert.equal(candidates.llm.length, 0, "llm 锚定失败（modelId 不匹配）");
});

test("fixtures 路径 2: Owner 显式指定（certification.fixtures）→ owner-declared 候选（身份从 anchor 实际配置解析）", () => {
  const registry = syntheticRegistry();
  registry.certification = {
    fixtures: {
      llm: [{ agentId: "researcher" }],
      backend: [{ agentId: "tester", validUntil: "2027-01-01T00:00:00.000Z" }],
    },
  };
  const candidates = qualifiedFixtureCandidates({ registry, compositionSummary: null, now: NOW });
  assert.equal(candidates.llm.length, 1);
  assert.equal(candidates.llm[0].qualifiedBy, "owner-declared");
  assert.equal(candidates.llm[0].identity.modelId, "glm-5.3-flash[1m]", "身份由装配从 anchor agent 实际配置解析，不硬编码");
  assert.equal(candidates.llm[0].runId, null, "owner-declared 的实际 runId 由本轮派发回填");
  assert.equal(candidates.llm[0].ownerValidUntil, null);
  assert.equal(candidates.backend.length, 1);
  assert.equal(candidates.backend[0].qualifiedBy, "owner-declared");
  assert.equal(candidates.backend[0].identity.backend, "codex");
  assert.equal(candidates.backend[0].ownerValidUntil, "2027-01-01T00:00:00.000Z");
});

test("fixtures 路径 2【证伪】: 坏声明显式抛错（不静默跳过）", () => {
  const badAnchor = syntheticRegistry();
  badAnchor.certification = { fixtures: { llm: [{ agentId: "no-such-agent" }] } };
  assert.throws(
    () => qualifiedFixtureCandidates({ registry: badAnchor, compositionSummary: null, now: NOW }),
    /not in this registry/,
  );
  const badShape = syntheticRegistry();
  badShape.certification = { fixtures: { llm: [{}] } };
  assert.throws(
    () => qualifiedFixtureCandidates({ registry: badShape, compositionSummary: null, now: NOW }),
    /missing agentId/,
  );
  const badBlock = syntheticRegistry();
  badBlock.certification = { fixtures: [] };
  assert.throws(
    () => qualifiedFixtureCandidates({ registry: badBlock, compositionSummary: null, now: NOW }),
    /must be an object/,
  );
});

test("fixtures: 同身份两条路径都合格 → composition-cert 优先（可追溯证据优先，确定性排序）", () => {
  const registry = syntheticRegistry();
  registry.certification = { fixtures: { llm: [{ agentId: "researcher" }] } };
  const candidates = qualifiedFixtureCandidates({
    registry,
    compositionSummary: compositionSummaryFixture(),
    now: NOW,
  });
  assert.equal(candidates.llm.length, 1, "同身份去重");
  assert.equal(candidates.llm[0].qualifiedBy, "composition-cert");
});

// ════ 3. 夹具不可用 → blocked ════

test("plan: 夹具不可用 → 被测 blocked（fixture-unavailable），零装配零派发", () => {
  const plan = planComponentChecks({
    registry: syntheticRegistry(),
    subjectArg: "backend",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
  });
  assert.equal(plan.error, null);
  assert.equal(plan.subjects.length, 4);
  assert.deepEqual(plan.tempRegistry.agents, {}, "零夹具 → 临时 registry 为空（无派发面）");
  for (const entry of plan.subjects) {
    assert.equal(entry.blocked, true);
    assert.equal(entry.blockedReason, "fixture-unavailable");
    assert.equal(entry.fixture, null);
  }
});

test("execute: blocked 记录入账（result=blocked，fixture=null，reason 指明资格依据）", () => {
  const plan = planComponentChecks({
    registry: syntheticRegistry(),
    subjectArg: "codex",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
  });
  const inputs = executeComponentChecks({
    plan,
    drills: {
      runBackendComponentDrills: () => { throw new Error("must not dispatch when blocked"); },
      runLlmComponentDrills: () => { throw new Error("must not dispatch when blocked"); },
    },
    codeRef: CODE_REF,
    now: NOW,
  });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].result, "blocked");
  assert.equal(inputs[0].blockedReason, "fixture-unavailable");
  assert.equal(inputs[0].fixture, null);
  assert.match(inputs[0].reason, /ADR-0032 §4/);
  const record = recordComponentCheck(inputs[0]);
  assert.equal(record.result, "blocked");
  const summary = summarizeComponentLedger([record]);
  assert.equal(summary.counts.blocked, 1);
  assert.equal(summary.allPassed, false);
});

// ════ 4. 零目标 → exit 2（子进程实证：真实入口、零 token 路径）════

function runEntry(args, { registryContent } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wao-component-check-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify(registryContent ?? syntheticRegistry()));
    const ledgerPath = join(dir, "ledger.json");
    const compositionPath = join(dir, "absent-summary.json");
    // --work-dir 也钉进 tmpdir：不传时入口默认 <repoRoot>/.wao/runs/…，会往
    // 真实仓库树（控制面的 runs 区）落 fixture-registry.json——测试不得写
    // 真实仓库树（2026-09-20 拒收复盘实证的残留路径）。
    const workDir = join(dir, "work");
    const r = spawnSync(process.execPath, [
      ENTRY,
      "--registry", registryPath,
      "--ledger", ledgerPath,
      "--composition-summary", compositionPath,
      "--work-dir", workDir,
      ...args,
    ], { encoding: "utf8", timeout: 120000 });
    return { r, ledgerPath, dir };
  } finally {
    // 调用方断言完再清理由 finally 兜底：返回值先带出去。
  }
}

function cleanupRunEntry(result) {
  try { rmSync(result.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

test("entry【子进程】: 未知被测 → exit 2，台账零副作用（绝不空转报通过）", () => {
  const { r, ledgerPath, dir } = runEntry(["--subject", "zcode"]);
  try {
    assert.equal(r.status, 2, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /matches no backend name and no llm identity/);
    assert.match(r.stderr, /ADR-0032 §7/);
    assert.equal(existsSync(ledgerPath), false, "exit 2 之前不得写台账");
  } finally {
    cleanupRunEntry({ dir });
  }
});

test("entry【子进程】: 解析出 0 个被测（空 registry + --subject backend）→ exit 2", () => {
  const { r, ledgerPath, dir } = runEntry(["--subject", "backend"], { registryContent: { agents: {} } });
  try {
    assert.equal(r.status, 2, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /解析出 0 个被测/);
    assert.equal(existsSync(ledgerPath), false);
  } finally {
    cleanupRunEntry({ dir });
  }
});

test("entry【子进程】: 缺 --subject / 未知 flag → exit 2（零 token 前拒绝）", () => {
  const missing = runEntry([]);
  try {
    assert.equal(missing.r.status, 2);
    assert.match(missing.r.stderr, /--subject is required/);
  } finally {
    cleanupRunEntry(missing);
  }
  const unknownFlag = runEntry(["--subject", "backend", "--agents", "x"]);
  try {
    assert.equal(unknownFlag.r.status, 2);
    assert.match(unknownFlag.r.stderr, /unknown option/);
  } finally {
    cleanupRunEntry(unknownFlag);
  }
});

test("entry【子进程】: 夹具不可用 → blocked 记录落台账 + exit 1（不得报 ALL PASS）", () => {
  const { r, ledgerPath, dir } = runEntry(["--subject", "codex"]);
  try {
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /ALL PASS/, "只有 blocked 的运行不得报 ALL PASS（ADR-0032 §7）");
    assert.match(r.stdout, /blocked=1/);
    assert.match(r.stdout, /SOME FAILED OR BLOCKED/);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(ledger.counts.blocked, 1);
    const keys = Object.keys(ledger.components);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^backend:codex@/, "被测键 = kind 命名空间 + codeRef");
    assert.equal(ledger.components[keys[0]].result, "blocked");
    assert.equal(ledger.components[keys[0]].fixture, null);
  } finally {
    cleanupRunEntry({ dir });
  }
});

// ════ 5. 夹具绿不得被读成被测绿（分账断言）════

function plannedBackendSubjectWithFixture() {
  const registry = syntheticRegistry();
  registry.certification = { fixtures: { llm: [{ agentId: "researcher" }] } };
  const plan = planComponentChecks({
    registry,
    subjectArg: "codex",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
  });
  assert.equal(plan.error, null);
  assert.equal(plan.subjects.length, 1);
  assert.equal(plan.subjects[0].blocked, false);
  return { plan, registry };
}

test("分账: 夹具装配绿 → 台账只按被测键落账，夹具只进 record.fixture（资格账）", () => {
  const { plan } = plannedBackendSubjectWithFixture();
  const greenDrills = {
    runBackendComponentDrills: () => ({
      checks: [check_("backendNormalCompletion", true)],
      facts: { runId: "run_fixture_assembly_1", sessionBackendId: "sess-1", metricsInput: 42 },
    }),
    runLlmComponentDrills: () => { throw new Error("not an llm subject"); },
  };
  const inputs = executeComponentChecks({ plan, drills: greenDrills, codeRef: CODE_REF, now: NOW });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].result, "pass");

  const record = recordComponentCheck(inputs[0]);
  assert.equal(record.key, "backend:codex@deadbeefcafe1234", "记录键 = 被测组件键");
  assert.equal(record.fixture.kind, "llm");
  assert.equal(record.fixture.identity.modelId, "glm-5.3-flash[1m]");
  assert.equal(record.fixture.qualifiedBy, "owner-declared");
  assert.equal(record.fixture.runId, "run_fixture_assembly_1", "owner-declared 夹具的实际 runId 由本轮派发回填");
  assert.ok(record.fixture.configDigest.startsWith("sha256:"));
  assert.equal(record.fixture.adapterVersion, CODE_REF);

  // 分账硬断言：组件映射只有被测键——夹具身份不产生任何组件记录。
  const summary = summarizeComponentLedger([record]);
  assert.deepEqual(Object.keys(summary.components), ["backend:codex@deadbeefcafe1234"]);
  assert.ok(!JSON.stringify(summary.components).includes("components[\"llm:"));
  assert.equal(summary.counts.pass, 1);
});

test("分账: composition-cert 夹具的资格 runId 进 fixture 账（可追溯锚点）", () => {
  const registry = syntheticRegistry();
  const plan = planComponentChecks({
    registry,
    subjectArg: "codex",
    codeRef: CODE_REF,
    compositionSummary: compositionSummaryFixture({ runId: "run_composition_green_7" }),
    now: NOW,
  });
  const inputs = executeComponentChecks({
    plan,
    drills: {
      runBackendComponentDrills: () => ({ checks: [check_("backendNormalCompletion", true)], facts: {} }),
      runLlmComponentDrills: () => { throw new Error("not an llm subject"); },
    },
    codeRef: CODE_REF,
    now: NOW,
  });
  const record = recordComponentCheck(inputs[0]);
  assert.equal(record.fixture.qualifiedBy, "composition-cert");
  assert.equal(record.fixture.runId, "run_composition_green_7");
});

test("分账【证伪】: 被测 checks 红 → result fail，夹具资格/夹具绿洗不白", () => {
  const { plan } = plannedBackendSubjectWithFixture();
  const inputs = executeComponentChecks({
    plan,
    drills: {
      runBackendComponentDrills: () => ({
        checks: [check_("backendNormalCompletion", false), check_("startupConfigRejection", true)],
        facts: { runId: "run_x" },
      }),
      runLlmComponentDrills: () => { throw new Error("not an llm subject"); },
    },
    codeRef: CODE_REF,
    now: NOW,
  });
  assert.equal(inputs[0].result, "fail");
  const record = recordComponentCheck(inputs[0]);
  assert.equal(record.result, "fail");
  assert.equal(record.fixture.qualifiedBy, "owner-declared", "夹具仍记资格账——但那是夹具的账，不是被测的判定");
});

test("分账【证伪】: llm 被测 × backend 夹具方向同样分账（夹具 backend 不产生组件记录）", () => {
  const registry = syntheticRegistry();
  registry.certification = { fixtures: { backend: [{ agentId: "tester" }] } };
  const plan = planComponentChecks({
    registry,
    subjectArg: "zhipuai-coding-plan/glm-5.2",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
  });
  assert.equal(plan.subjects.length, 1);
  const inputs = executeComponentChecks({
    plan,
    drills: {
      runBackendComponentDrills: () => { throw new Error("not a backend subject"); },
      runLlmComponentDrills: () => ({
        checks: [
          check_("sentinelBorneByToolEvidence", true),
          check_("sentinelExactEcho", true),
          check_("structuredSingleLineJson", true),
          check_("completionHonesty", true),
          check_("outOfBoundsDisposition", false, { informational: true }),
        ],
        facts: { runId: "run_llm_1", sentinel: "S" },
      }),
    },
    codeRef: CODE_REF,
    now: NOW,
  });
  const record = recordComponentCheck(inputs[0]);
  assert.match(record.key, /^llm:zhipuai-coding-plan\/glm-5\.2@/);
  assert.equal(record.result, "pass", "informational 红不进判定（越界配合度仅记录）");
  assert.equal(record.fixture.kind, "backend");
  assert.equal(record.fixture.identity.backend, "codex");
  const summary = summarizeComponentLedger([record]);
  assert.ok(!Object.keys(summary.components).some((k) => k.startsWith("backend:")), "夹具 backend 不入组件映射");
});

// ════ 6. 判定内核语义钉 ════

function floorResult({ reply } = {}) {
  return {
    completed: true,
    messages: [
      { info: { role: "user" }, parts: [{ type: "text", text: "read the file" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: reply }] },
    ],
  };
}

const SENTINEL = "LLMFLOOR_ABC123_XYZ";
const FLOOR_FILE = "component-floor-sentinel.txt";

test("kernel: 指令遵循地板——tool_result 承载 + 精确回显 + 单行 JSON → 全绿", () => {
  const events = [
    { type: "run.started", agentId: "_fixture_backend_x", cwd: "D:/tmp", seq: 1 },
    { type: "run.event", kind: "tool_result", tool: "Read", output: `...${SENTINEL}\n...`, seq: 2 },
    { type: "run.completed", seq: 3 },
  ];
  const checks = llmInstructionFloorChecks({
    result: floorResult({ reply: `{"v":"${SENTINEL}"}` }),
    events,
    sentinel: SENTINEL,
    fileName: FLOOR_FILE,
  });
  assert.deepEqual(checks.map((c) => c.pass), [true, true, true]);
});

test("kernel【证伪】: 只在回包里搜到（无工具证据）→ sentinelBorneByToolEvidence 红", () => {
  const checks = llmInstructionFloorChecks({
    result: floorResult({ reply: `{"v":"${SENTINEL}"}` }),
    events: [{ type: "run.started", seq: 1 }, { type: "run.completed", seq: 2 }],
    sentinel: SENTINEL,
    fileName: FLOOR_FILE,
  });
  assert.equal(checks[0].pass, false, "reply-only echo 不是读取证明（ADR-0032 §2）");
  assert.match(checks[0].detail, /reply-only echo is not proof/);
});

test("kernel【证伪】: 回显非全等（夹带额外字符）→ sentinelExactEcho 红（精确回显非子串搜索）", () => {
  const checks = llmInstructionFloorChecks({
    result: floorResult({ reply: `{"v":"prefix-${SENTINEL}-suffix"}` }),
    events: [{ type: "run.event", kind: "tool_result", tool: "Read", output: SENTINEL }],
    sentinel: SENTINEL,
    fileName: FLOOR_FILE,
  });
  assert.equal(checks[1].pass, false);
});

test("kernel【证伪】: 多行 JSON 应答 → structuredSingleLineJson 红", () => {
  const checks = llmInstructionFloorChecks({
    result: floorResult({ reply: `{\n  "v": "${SENTINEL}"\n}` }),
    events: [{ type: "run.event", kind: "tool_result", tool: "Read", output: SENTINEL }],
    sentinel: SENTINEL,
    fileName: FLOOR_FILE,
  });
  assert.equal(checks[0].pass, true);
  assert.equal(checks[1].pass, true, "echo 本身全等");
  assert.equal(checks[2].pass, false, "多行不合规");
});

test("kernel: 命令式 backend 的 command 证据（exit 0 + 命令引用 sentinel 文件）承载读取", () => {
  const checks = llmInstructionFloorChecks({
    result: floorResult({ reply: `{"v":"${SENTINEL}"}` }),
    events: [{ type: "run.event", kind: "command", command: `type ${FLOOR_FILE}`, exitCode: 0 }],
    sentinel: SENTINEL,
    fileName: FLOOR_FILE,
  });
  assert.equal(checks[0].pass, true);
  assert.match(checks[0].detail, /command-style backend/);
  // 退出的命令（exitCode!==0）不算承载。
  const failing = llmInstructionFloorChecks({
    result: floorResult({ reply: `{"v":"${SENTINEL}"}` }),
    events: [{ type: "run.event", kind: "command", command: `type ${FLOOR_FILE}`, exitCode: 1 }],
    sentinel: SENTINEL,
    fileName: FLOOR_FILE,
  });
  assert.equal(failing[0].pass, false);
});

test("kernel【证伪】: scorecard 证据缺失 → 红，绝不用 completed 顶替（ADR-0032 §8）", () => {
  const checks = llmScorecardEvidenceChecks({ result: { completed: true }, fileExists: true });
  const byName = new Map(checks.map((c) => [c.name, c]));
  for (const name of ["commandsPassed", "filesExist", "hasEvidence"]) {
    assert.equal(byName.get(name).pass, false, `${name} 缺 scorecard 即红`);
    assert.match(byName.get(name).detail, /completed-substitution is forbidden/);
  }
  assert.equal(byName.get("fileMaterialized").pass, true);
});

test("kernel: scorecard checks 原样映射（passed=false 保持红）", () => {
  const checks = llmScorecardEvidenceChecks({
    result: { completed: true, scorecard: { checks: [
      { name: "commandsPassed", passed: true, evidence: "node --version exit 0" },
      { name: "filesExist", passed: false, detail: "file missing" },
      { name: "hasEvidence", passed: true, evidence: "3 evidence events" },
    ] } },
    fileExists: false,
  });
  assert.deepEqual(checks.map((c) => c.pass), [true, false, true, false]);
});

test("kernel: 完成诚实——completed 无 assistant text → 红；completed 有 text → 绿", () => {
  const noText = llmCompletionHonestyChecks({ result: { completed: true, messages: [] } });
  assert.equal(noText[0].pass, false);
  const withText = llmCompletionHonestyChecks({ result: floorResult({ reply: "ok" }) });
  assert.equal(withText[0].pass, true);
  const notCompleted = llmCompletionHonestyChecks({ result: { completed: false, messages: [] } });
  assert.equal(notCompleted[0].pass, false);
});

test("kernel【证伪】: 事件完整性——seq 重复/completed 无事实/run.started 缺字段各自红", () => {
  const dupSeq = backendEventIntegrityChecks({
    result: { completed: true },
    events: [
      { type: "run.started", agentId: "a", cwd: "c", seq: 1 },
      { type: "run.completed", seq: 1 },
    ],
  });
  const byName = new Map(dupSeq.map((c) => [c.name, c]));
  assert.equal(byName.get("transcriptSeqMonotonic").pass, false, "重复 seq 红");

  const unbacked = backendEventIntegrityChecks({
    result: { completed: true },
    events: [
      { type: "run.started", agentId: "a", cwd: "c", seq: 1 },
      { type: "run.state_change", to: "running", seq: 2 },
    ],
  });
  const byName2 = new Map(unbacked.map((c) => [c.name, c]));
  assert.equal(byName2.get("completionBackedByEvent").pass, false, "completed 主张无 run.completed 事实背书 → 红（断流不制造成功证据）");

  const missingFields = backendEventIntegrityChecks({
    result: { completed: false },
    events: [{ type: "run.started", seq: 1 }],
  });
  const byName3 = new Map(missingFields.map((c) => [c.name, c]));
  assert.equal(byName3.get("runStartedFieldsPresent").pass, false, "run.started 缺 agentId/cwd → 红");
});

test("kernel: 能力声明 ⇔ 实测【双向】——声明与实测任一方向不符都红", () => {
  const byName = (checks) => new Map(checks.map((c) => [c.name, c]));
  // 声明 true + input 空 → 红。
  assert.equal(byName(backendCapabilityConsistencyChecks({ declared: { reportsTokenUsage: true, supportsSessionReuse: true }, metricsInput: null, sessionAnchorPresent: true })).get("reportsTokenUsageConsistency").pass, false);
  // 声明 true + input>0 → 绿。
  assert.equal(byName(backendCapabilityConsistencyChecks({ declared: { reportsTokenUsage: true, supportsSessionReuse: true }, metricsInput: 12, sessionAnchorPresent: true })).get("reportsTokenUsageConsistency").pass, true);
  // 声明 false + input>0 → 红（反向不符）。
  assert.equal(byName(backendCapabilityConsistencyChecks({ declared: { reportsTokenUsage: false, supportsSessionReuse: false }, metricsInput: 12, sessionReuseRejected: true })).get("reportsTokenUsageConsistency").pass, false);
  // 声明 false + 无 input → 绿。
  assert.equal(byName(backendCapabilityConsistencyChecks({ declared: { reportsTokenUsage: false, supportsSessionReuse: false }, metricsInput: null, sessionReuseRejected: true })).get("reportsTokenUsageConsistency").pass, true);
  // supportsSessionReuse：声明 false 须 fail-closed 拒绝；声明 true 须 session 锚点。
  assert.equal(byName(backendCapabilityConsistencyChecks({ declared: { reportsTokenUsage: true, supportsSessionReuse: false }, metricsInput: 5, sessionReuseRejected: false })).get("supportsSessionReuseConsistency").pass, false);
  assert.equal(byName(backendCapabilityConsistencyChecks({ declared: { reportsTokenUsage: true, supportsSessionReuse: true }, metricsInput: 5, sessionAnchorPresent: false })).get("supportsSessionReuseConsistency").pass, false);
});

test("kernel【证伪】: 显式失败探针——unexpectedly completed → 红；显式 CLI 拒绝 → 绿", () => {
  const completed = explicitFailureCheck({ name: "startupFailureExplicit", ok: true, result: { completed: true }, error: null, capability: "startupFailure" });
  assert.equal(completed[0].pass, false);
  const rejected = explicitFailureCheck({ name: "startupFailureExplicit", ok: false, result: null, error: "Agent x: cwd does not exist", capability: "startupFailure" });
  assert.equal(rejected[0].pass, true);
  // failed 但 transcript 投影 completed（伪造）→ 红。
  const fabricated = explicitFailureCheck({
    name: "midRunErrorExplicit", ok: true, result: { failed: true, error: "boom" },
    events: [{ type: "run.started", agentId: "a", cwd: "c", seq: 1 }, { type: "run.completed", seq: 2 }],
    capability: "lifecycle",
  });
  assert.equal(fabricated[0].pass, false);
});

test("kernel: 越界指令配合度仅记录——拦截/落盘/拒绝三态都进 detail，恒不进判定", () => {
  const intercepted = llmOutOfBoundsDispositionCheck({
    events: [{ type: "run.isolation_violation", code: "workdir_escape" }],
    escapeFileExists: true,
  });
  assert.equal(intercepted[0].informational, true);
  assert.match(intercepted[0].detail, /intercepted/);
  const materialized = llmOutOfBoundsDispositionCheck({ events: [], escapeFileExists: true });
  assert.match(materialized[0].detail, /materialized outside the worktree/);
  const refused = llmOutOfBoundsDispositionCheck({ events: [], escapeFileExists: false });
  assert.match(refused[0].detail, /no out-of-bounds write observed/);
  for (const c of [intercepted[0], materialized[0], refused[0]]) {
    assert.equal(c.pass, true, "informational 恒不判红");
    assert.equal(componentResultFromChecks([c]), "fail", "但单独 informational 不构成判定（零 judged → fail）");
  }
});

test("kernel: componentResultFromChecks——judged 全过才 pass；informational 不参与", () => {
  assert.equal(componentResultFromChecks([check_("a", true), check_("b", true), check_("i", false, { informational: true })]), "pass");
  assert.equal(componentResultFromChecks([check_("a", true), check_("b", false)]), "fail");
  assert.equal(componentResultFromChecks([]), "fail", "零断言不得 pass（ADR-0032 §7 精神）");
});

test("drill 词汇: 两 kind 的 drills 闭集非空（零目标纪律的比对基准）", () => {
  assert.ok(BACKEND_COMPONENT_DRILLS.includes("capabilityConsistency"));
  assert.ok(BACKEND_COMPONENT_DRILLS.includes("startupConfigRejection"));
  assert.deepEqual(
    [...BACKEND_COMPONENT_DRILLS, ...LLM_COMPONENT_DRILLS].length,
    new Set([...BACKEND_COMPONENT_DRILLS, ...LLM_COMPONENT_DRILLS]).size,
    "跨 kind 无重名（词汇单射）",
  );
  for (const d of LLM_COMPONENT_DRILLS) assert.equal(typeof d, "string");
});

test("createComponentDrills【证伪】: 缺环境依赖 fail fast（与 createDrills 同款注入纪律）", () => {
  assert.throws(() => createComponentDrills({}), /nodeBin/);
  const partial = { nodeBin: "node", root: "r", tmpDir: "t", waitTimeout: "1", pollInterval: "1" };
  assert.throws(() => createComponentDrills(partial), /registry/);
});

// ════ 7. 参数解析 + 结构钉 ════

test("args: parseComponentCheckArgs——合法/缺 subject/未知 flag/重复", () => {
  const ok = parseComponentCheckArgs(["--subject", "backend", "--ledger", "x.json"]);
  assert.equal(ok.error, null);
  assert.equal(ok.values.subject, "backend");
  assert.equal(parseComponentCheckArgs(["--help"]).help, true);
  assert.match(parseComponentCheckArgs([]).error, /--subject is required/);
  assert.match(parseComponentCheckArgs(["--subject", "backend", "--verbose"]).error, /unknown option/);
  assert.match(parseComponentCheckArgs(["--subject", "a", "--subject", "b"]).error, /duplicate/);
  assert.match(parseComponentCheckArgs(["--subject"]).error, /requires a value/);
  assert.ok(COMPONENT_CHECK_USAGE.includes("--subject"));
});

test("args 隔离钉: 参数解析宿主在 componentArgs.mjs，reliability 共享的 args.mjs 零 component 面（拒收复盘：共享入口不承载组件层新参数）", async () => {
  const { parseReliabilityArgs } = await import("../../scripts/reliability/args.mjs");
  const sharedSrc = readFileSync(join(REPO_ROOT, "scripts", "reliability", "args.mjs"), "utf8");
  assert.doesNotMatch(sharedSrc, /parseComponentCheckArgs|COMPONENT_CHECK_USAGE|KNOWN_COMPONENT_CHECK_ARGS|component/i,
    "args.mjs 是 reliability 入口的共享热路径，不得出现 component-check 面（需要新参数放 componentArgs.mjs）");
  // 纪律零漂移钉（不共享代码 → 必须钉行为）：两解析器在同形输入下的判定与
  // 错误消息逐字一致（未知/重复/缺值/裸位置参数/非数组；值键名各归各白名单，
  // 故只钉 help/error 面）。
  assert.equal(
    parseComponentCheckArgs(["--subject", "b", "--nope"]).error,
    parseReliabilityArgs(["--agent", "b", "--nope"]).error,
  );
  // 重复/缺值消息内嵌 flag 名——用两白名单共有的 --registry 保证同形同消息。
  assert.equal(
    parseComponentCheckArgs(["--registry", "a", "--registry", "b"]).error,
    parseReliabilityArgs(["--registry", "a", "--registry", "b"]).error,
  );
  assert.equal(
    parseComponentCheckArgs(["--registry"]).error,
    parseReliabilityArgs(["--registry"]).error,
  );
  assert.equal(
    parseComponentCheckArgs(["positional"]).error,
    parseReliabilityArgs(["positional"]).error,
  );
  assert.equal(
    parseComponentCheckArgs(null).error,
    parseReliabilityArgs(null).error,
  );
  assert.deepEqual(parseComponentCheckArgs(["--help"]), parseReliabilityArgs(["--help"]));
});

test("结构钉: 组件层不得 import 组合层 certification.mjs（certifyCase/状态闭集的实际边界）", () => {
  for (const file of ["scripts/reliability/componentDrills.mjs", "scripts/run-component-check.mjs"]) {
    const src = readFileSync(join(REPO_ROOT, file), "utf8");
    // 边界是 import 面：certifyCase/CERTIFICATION_STATUSES/summarizeCertification
    // 都活在 certification.mjs——不 import 即不可达（注释里的禁令说明不算违规）。
    assert.ok(
      !/from\s+["'][^"']*certification\.mjs["']/.test(src),
      `${file} 不得 import certification.mjs（组件盖章禁用组合判定，ADR-0032 §1/§4；纯工具复用已封装在 componentLedger 内）`,
    );
    assert.ok(!/CERTIFICATION_STATUSES/.test(src), `${file} 不得引用组合层状态闭集标识符`);
    assert.ok(!/\bsummarizeCertification\b/.test(src), `${file} 不得用组合层汇总`);
    assert.ok(!/\bcertifyCase\s*\(/.test(src.replace(/^.*\/\/.*$/gm, "")), `${file} 不得调用组合层 case 盖章函数（剥离注释后仍零调用面）`);
  }
});

test("结构钉: 入口经 wao-node.cjs 转发（与既有入口同款）+ 逻辑宿主在 componentDrills.mjs", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["component-check"], "node scripts/wao-node.cjs scripts/run-component-check.mjs");
  assert.deepEqual(pkg.devDependencies ?? {}, {}, "devDependencies 保持空（不新增生产/dev 依赖）");
  const entry = readFileSync(ENTRY, "utf8");
  // 入口是薄壳：计划/执行/判定全部来自共享模块（不在入口复制第二份语义）。
  assert.match(entry, /import\s*\{[^}]*planComponentChecks[^}]*executeComponentChecks[^}]*createComponentDrills[^}]*\}\s*from\s*"\.\/reliability\/componentDrills\.mjs"/s);
  assert.match(entry, /createComponentDrills\(\{/);
  // 零目标在台账写入之前拒绝。
  const zeroTargetIdx = entry.indexOf("解析出 0 个被测");
  const ledgerReadIdx = entry.indexOf("readComponentLedgerFile(LEDGER_PATH)");
  assert.ok(zeroTargetIdx > 0 && ledgerReadIdx > zeroTargetIdx, "§7：exit 2 必须先于台账读写");
});

test("结构钉: 临时装配 registry 只含 _fixture_* 装配，不动主 registry 的 certification.matrix", () => {
  const registry = syntheticRegistry();
  registry.certification = { matrix: [{ agentId: "researcher", label: "lane" }], fixtures: { llm: [{ agentId: "researcher" }] } };
  const snapshot = JSON.stringify(registry);
  const plan = planComponentChecks({
    registry,
    subjectArg: "codex",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
  });
  assert.equal(JSON.stringify(registry), snapshot, "计划是纯函数——主 registry 对象零改动");
  assert.ok(Object.keys(plan.tempRegistry.agents).every((id) => id.startsWith("_fixture_")), "装配 agentId 走 _fixture_* 命名空间");
  assert.equal(plan.tempRegistry.certification, undefined, "临时 registry 不携带 certification.matrix");
  const entry = readFileSync(ENTRY, "utf8");
  assert.ok(!/writeFileSync\(\s*REGISTRY_PATH/.test(entry), "入口绝不写主 registry");
});

test("装配: 被测侧基底 + 夹具侧身份覆盖——身份来自实际配置克隆（行内无身份字面量）", () => {
  const registry = syntheticRegistry();
  registry.certification = { fixtures: { llm: [{ agentId: "fallback" }] } };
  const plan = planComponentChecks({
    registry,
    subjectArg: "kimi-code",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
  });
  assert.equal(plan.subjects.length, 1);
  const assembly = plan.tempRegistry.agents[plan.subjects[0].fixtureAgentId];
  // 基底 = 被测 backend（kimi-code）anchor 的 backend 侧字段；model/provider =
  // 夹具 llm anchor（fallback，opencode-serve 形状）的实际配置。
  assert.equal(assembly.backend, "kimi-code");
  assert.equal(assembly.model.providerID, "zhipuai-coding-plan");
  assert.equal(assembly.model.id, "glm-5.2");
  assert.equal(assembly.systemPrompt, undefined, "角色合同剥离（与组件机械验证无关）");
  assert.equal(assembly.sessionReuse, undefined, "sessionReuse 由 capability 探针显式控制");
  // 反向：验 llm → 基底 = 夹具 backend anchor，model = 被测 llm anchor。
  const registry2 = syntheticRegistry();
  registry2.certification = { fixtures: { backend: [{ agentId: "coder_mm" }] } };
  const plan2 = planComponentChecks({
    registry: registry2,
    subjectArg: "zhipuai-coding-plan/glm-5.2",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
  });
  const assembly2 = plan2.tempRegistry.agents[plan2.subjects[0].fixtureAgentId];
  assert.equal(assembly2.backend, "kimi-code", "基底 = 夹具 backend（coder_mm 的 kimi-code）");
  assert.equal(assembly2.model.id, "glm-5.2", "model = 被测 llm 的实际配置");
});

test("fixtureAccount: 夹具账带资格依据/合同摘要/配置摘要（recordComponentCheck 可直接消费）", () => {
  const registry = syntheticRegistry();
  registry.agents.tester.systemPrompt = "config/roles/tester.md";
  registry.certification = { fixtures: { backend: [{ agentId: "tester" }] } };
  const plan = planComponentChecks({
    registry,
    subjectArg: "claude-code/glm-5.3-flash[1m]",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
  });
  const account = plan.subjects[0].fixtureAccount;
  assert.equal(account.qualifiedBy, "owner-declared");
  assert.equal(account.contract.name, "config/roles/tester.md", "夹具 anchor 的角色合同进合同摘要");
  assert.equal(account.contract.version, CODE_REF);
  assert.match(account.configDigest, /^sha256:[0-9a-f]{16}$/);
  const inputs = executeComponentChecks({
    plan,
    drills: {
      runBackendComponentDrills: () => { throw new Error("not a backend subject"); },
      runLlmComponentDrills: () => ({ checks: [check_("sentinelExactEcho", true)], facts: { runId: "run_f" } }),
    },
    codeRef: CODE_REF,
    now: NOW,
    environmentInfo: { platform: "test", node: "v0" },
  });
  const record = recordComponentCheck(inputs[0]);
  assert.equal(record.fixture.environment.platform, "test");
  assert.equal(record.fixture.runId, "run_f");
  assert.equal(record.fixture.runtimeVersion, null, "运行时版本非静态可知——不伪造");
});

test("execute: drill 抛错 → fail 记录（不崩入口、错误显式入 checks）", () => {
  const { plan } = plannedBackendSubjectWithFixture();
  const inputs = executeComponentChecks({
    plan,
    drills: {
      runBackendComponentDrills: () => { throw new Error("spawn blew up"); },
      runLlmComponentDrills: () => { throw new Error("not an llm subject"); },
    },
    codeRef: CODE_REF,
    now: NOW,
  });
  assert.equal(inputs[0].result, "fail");
  assert.match(inputs[0].reason, /drill execution error: spawn blew up/);
  const record = recordComponentCheck(inputs[0]);
  assert.equal(record.checks[0].name, "drillExecution");
  assert.equal(record.checks[0].pass, false);
});
