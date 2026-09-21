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
  SESSION_REUSE_EVIDENCE_SOURCES,
  backendCapabilityConsistencyChecks,
  backendEventIntegrityChecks,
  backendStartupConfigChecks,
  backendStopChecks,
  backendStopFormOf,
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
  sessionReuseEvidenceFromPhase6File,
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

test("execute: backend drills 收到 configuredModelId=装配实际 model（被测自己的支持范围），绝无夹具身份", () => {
  const { plan } = plannedBackendSubjectWithFixture();
  // plannedBackendSubjectWithFixture：被测 = codex（anchor tester 的 gpt-5.6-sol），
  // 夹具 llm = researcher 的 glm-5.3-flash[1m]。注入面必须传装配实际携带的
  // model（被测自己的），不是夹具身份。
  let captured = null;
  const inputs = executeComponentChecks({
    plan,
    drills: {
      runBackendComponentDrills: (args) => {
        captured = args;
        return { checks: [check_("backendNormalCompletion", true)], facts: {} };
      },
      runLlmComponentDrills: () => { throw new Error("not an llm subject"); },
    },
    codeRef: CODE_REF,
    now: NOW,
  });
  assert.equal(inputs[0].result, "pass");
  assert.equal(captured.agentId, plan.subjects[0].fixtureAgentId);
  assert.equal(captured.configuredModelId, "gpt-5.6-sol", "判定基准 = 装配实际 model（被测 anchor 的）");
  assert.ok(!("fixtureModelId" in captured), "夹具身份键不得出现在 drills 注入面");

  // 被测 anchor 无 model 块（deepseek-acp 形状）→ configuredModelId=null（支持
  // 范围不含模型选择——drills 走"注入须明确拒绝"分支，见 kernel 测试）。
  const registry = syntheticRegistry();
  registry.agents.coder_low_dsh = { backend: "deepseek-acp", cwd: ".", credentialEnv: "DEEPSEEK_API_KEY" };
  registry.certification = { fixtures: { llm: [{ agentId: "researcher" }] } };
  const plan2 = planComponentChecks({
    registry,
    subjectArg: "deepseek-acp",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
  });
  let captured2 = null;
  executeComponentChecks({
    plan: plan2,
    drills: {
      runBackendComponentDrills: (args) => {
        captured2 = args;
        return { checks: [check_("backendNormalCompletion", true)], facts: {} };
      },
      runLlmComponentDrills: () => { throw new Error("not an llm subject"); },
    },
    codeRef: CODE_REF,
    now: NOW,
  });
  assert.equal(captured2.configuredModelId, null, "无 model 装配 → null（支持范围分支的判别信号）");
  assert.equal(captured2.capabilitySnapshot.reportsTokenUsage, false, "deepseek-acp 能力快照照常注入（声明已于 2026-09-20 按实测裁定为 false）");
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
  const checks = llmScorecardEvidenceChecks({ result: { completed: true }, fileExists: true, fileContentMatches: true });
  const byName = new Map(checks.map((c) => [c.name, c]));
  for (const name of ["commandsPassed", "filesExist", "hasEvidence"]) {
    assert.equal(byName.get(name).pass, false, `${name} 缺 scorecard 即红`);
    assert.match(byName.get(name).detail, /completed-substitution is forbidden/);
  }
  assert.equal(byName.get("fileMaterialized").pass, true);
  // 内容证据收紧（2026-09-21）：文件存在但内容未承载 sentinel → 红（存在≠证据）。
  const noContent = llmScorecardEvidenceChecks({ result: { completed: true }, fileExists: true, fileContentMatches: false });
  const noContentByName = new Map(noContent.map((c) => [c.name, c]));
  assert.equal(noContentByName.get("fileMaterialized").pass, false, "文件存在但内容缺 sentinel → 红");
  assert.match(noContentByName.get("fileMaterialized").detail, /existence without the sentinel content/);
  const contentUnobserved = llmScorecardEvidenceChecks({ result: { completed: true }, fileExists: true, fileContentMatches: null });
  assert.equal(new Map(contentUnobserved.map((c) => [c.name, c])).get("fileMaterialized").pass, false, "内容未观察（null）不放宽 → 红");
});

test("kernel: commandsPassed 按 reportsCommandExitCode 声明条件化——declared=false 记 N/A（带原因，不置绿不算失败）", () => {
  const checks = llmScorecardEvidenceChecks({
    result: { completed: true, scorecard: { checks: [
      { name: "commandsPassed", passed: false, detail: "failed (exitCode!=0): node --version (exitCode=undefined)" },
      { name: "filesExist", passed: true, evidence: "1 file_written event(s) recorded" },
      { name: "hasEvidence", passed: true, evidence: "7 evidence event(s) found" },
    ] } },
    fileExists: true,
    fileContentMatches: true,
    declared: { reportsCommandExitCode: false },
  });
  const byName = new Map(checks.map((c) => [c.name, c]));
  const commands = byName.get("commandsPassed");
  assert.equal(commands.state, "not-applicable");
  assert.equal(commands.pass, false, "N/A 绝不置绿");
  assert.match(commands.stateReason, /reportsCommandExitCode=false/);
  assert.match(commands.stateReason, /phase7-exit-code-wire\.json/);
  // 其余检查照常判定（声明只条件化 commandsPassed 一族）。
  assert.equal(byName.get("filesExist").pass, true);
  assert.equal(byName.get("hasEvidence").pass, true);
  assert.equal(byName.get("fileMaterialized").pass, true);
  // declared=true/unknown：照常判定（无 N/A 通道——退路即伪造）。
  const judged = llmScorecardEvidenceChecks({
    result: { completed: true, scorecard: { checks: [
      { name: "commandsPassed", passed: false, detail: "exitCode=undefined" },
    ] } },
    fileExists: true,
    fileContentMatches: true,
    declared: { reportsCommandExitCode: true },
  });
  const judgedCommands = new Map(judged.map((c) => [c.name, c])).get("commandsPassed");
  assert.equal(judgedCommands.pass, false, "declared=true 时 commandsPassed 照常判红");
  assert.equal(judgedCommands.state, undefined);
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
  // supportsSessionReuse：声明 false 须 fail-closed 拒绝；声明 true 须真恢复证据。
  assert.equal(byName(backendCapabilityConsistencyChecks({ declared: { reportsTokenUsage: true, supportsSessionReuse: false }, metricsInput: 5, sessionReuseRejected: false })).get("supportsSessionReuseConsistency").pass, false);
  assert.equal(byName(backendCapabilityConsistencyChecks({ declared: { reportsTokenUsage: true, supportsSessionReuse: true }, metricsInput: 5, sessionAnchorPresent: false })).get("supportsSessionReuseConsistency").pass, false);
});

test("kernel【判据升级 2026-09-21】: supportsSessionReuse=true 只认真实跨 run 恢复证据——session 锚点不再顶替", () => {
  const byName = (checks) => new Map(checks.map((c) => [c.name, c]));
  const declared = { reportsTokenUsage: true, supportsSessionReuse: true, reportsCommandExitCode: true, supportsRoleContract: true };
  // 旧判据形状（sessionAnchorPresent=true 但无真恢复证据）→ 红：只证明会话建立
  // 不证明能恢复（ADR-0032 §2 判据升级）。
  const anchorOnly = backendCapabilityConsistencyChecks({ declared, metricsInput: 5, sessionAnchorPresent: true });
  assert.equal(byName(anchorOnly).get("supportsSessionReuseConsistency").pass, false, "session 锚点不再构成 declared=true 的判据");
  assert.match(byName(anchorOnly).get("supportsSessionReuseConsistency").detail, /never a bare session id/);
  // 真恢复证据（Phase 6 形状被接受）→ 绿。
  const accepted = backendCapabilityConsistencyChecks({
    declared, metricsInput: 5,
    resumeEvidence: { accepted: true, detail: "real cross-run resume evidence accepted: run1 → run2 same session" },
    roleContractEchoed: true,
    commandExitCodeEvidence: { passed: true },
  });
  for (const name of ["supportsSessionReuseConsistency", "supportsRoleContractConsistency", "reportsCommandExitCodeConsistency", "reportsTokenUsageConsistency"]) {
    assert.equal(byName(accepted).get(name).pass, true, `${name} 全证据 → 绿`);
  }
  // 证据被拒（accepted=false）→ 红，detail 带拒绝原因。
  const rejected = backendCapabilityConsistencyChecks({
    declared, metricsInput: 5,
    resumeEvidence: { accepted: false, detail: "session-reuse evidence rejected: backendSessionId not identical across runs" },
    roleContractEchoed: true,
    commandExitCodeEvidence: { passed: true },
  });
  assert.equal(byName(rejected).get("supportsSessionReuseConsistency").pass, false);
  assert.match(byName(rejected).get("supportsSessionReuseConsistency").detail, /rejected: backendSessionId not identical/);
});

test("kernel: 声明闭集全量轴——roleContract/exitCode 各双向 + 无探针面轴记 N/A（带原因）", () => {
  const byName = (checks) => new Map(checks.map((c) => [c.name, c]));
  const names = backendCapabilityConsistencyChecks({ declared: {} }).map((c) => c.name);
  assert.deepEqual([...names].sort(), [
    "replayByRespawnConsistency",
    "reportsCommandExitCodeConsistency",
    "reportsTokenUsageConsistency",
    "supportsInFlightCorrectionConsistency",
    "supportsRoleContractConsistency",
    "supportsSessionReuseConsistency",
  ], "六轴闭集（snapshot 全量成员各一检查）");

  // supportsRoleContract：true 无回显 → 红；false 未拒绝 → 红；false 明确拒绝 → 绿。
  const echo = byName(backendCapabilityConsistencyChecks({ declared: { supportsRoleContract: true }, roleContractEchoed: false }));
  assert.equal(echo.get("supportsRoleContractConsistency").pass, false);
  const silentDrop = byName(backendCapabilityConsistencyChecks({ declared: { supportsRoleContract: false }, systemPromptRejected: false }));
  assert.equal(silentDrop.get("supportsRoleContractConsistency").pass, false, "声明不支持而 systemPrompt 配置被静默接受 → 红");
  const rejected = byName(backendCapabilityConsistencyChecks({ declared: { supportsRoleContract: false }, systemPromptRejected: true }));
  assert.equal(rejected.get("supportsRoleContractConsistency").pass, true, "明确拒绝 = 正确结果");
  // 探针未观察（null）→ 红，不得当绿。
  assert.equal(byName(backendCapabilityConsistencyChecks({ declared: { supportsRoleContract: true } })).get("supportsRoleContractConsistency").pass, false);

  // reportsCommandExitCode：true 需 commandsPassed 正向证据；false 记 N/A（带原因，不置绿不算失败）。
  const exitGreen = byName(backendCapabilityConsistencyChecks({ declared: { reportsCommandExitCode: true }, commandExitCodeEvidence: { passed: true } }));
  assert.equal(exitGreen.get("reportsCommandExitCodeConsistency").pass, true);
  const exitRed = byName(backendCapabilityConsistencyChecks({ declared: { reportsCommandExitCode: true }, commandExitCodeEvidence: { passed: false } }));
  assert.equal(exitRed.get("reportsCommandExitCodeConsistency").pass, false);
  const exitNa = byName(backendCapabilityConsistencyChecks({ declared: { reportsCommandExitCode: false } }));
  const naCheck = exitNa.get("reportsCommandExitCodeConsistency");
  assert.equal(naCheck.state, "not-applicable");
  assert.equal(naCheck.pass, false, "N/A 绝不置绿");
  assert.match(naCheck.stateReason, /reportsCommandExitCode=false/);

  // supportsInFlightCorrection / replayByRespawn：无组件层机械探针面 → N/A + 原因
  //（声明值不改变该判定——该两轴在本层无面可探，如实记录）。
  for (const name of ["supportsInFlightCorrectionConsistency", "replayByRespawnConsistency"]) {
    for (const declaredValue of [true, false]) {
      const c = byName(backendCapabilityConsistencyChecks({ declared: { [name.replace("Consistency", "")]: declaredValue } })).get(name);
      assert.equal(c.state, "not-applicable", `${name}（declared=${declaredValue}）无探针面 → N/A`);
      assert.ok(c.stateReason.length > 20, `${name} 的 N/A 必须带原因`);
      assert.equal(c.pass, false);
    }
  }
});

test("kernel: sessionReuseEvidenceFromPhase6File——真证据文件被接受，篡改/缺负对照被拒", () => {
  // 仓库内真实证据文件（Phase 6 产物）必须被接受。
  const real = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "reliability", "dsh-acp", "evidence", "phase6-session-reuse.json"), "utf8"));
  const accepted = sessionReuseEvidenceFromPhase6File(real);
  assert.equal(accepted.accepted, true, "仓库内 Phase 6 真证据被接受");
  assert.match(accepted.detail, /same provider session 811d622a/);
  assert.match(accepted.detail, /3\/3 fail-closed negatives refused/);
  // 篡改 1：两次 run 的 backendSessionId 不同 → 拒。
  const sidDrift = structuredClone(real);
  sidDrift.steps.run2.backendSessionId = "00000000-1111-4222-8333-444444444444";
  assert.equal(sessionReuseEvidenceFromPhase6File(sidDrift).accepted, false);
  assert.match(sessionReuseEvidenceFromPhase6File(sidDrift).detail, /not identical across runs/);
  // 篡改 2：run2 未走 resume 路由 → 拒（两次全新会话不是恢复）。
  const freshTurn = structuredClone(real);
  freshTurn.steps.run2.runSessionReuseTurn = "first";
  assert.match(sessionReuseEvidenceFromPhase6File(freshTurn).detail, /not routed as a resume turn/);
  // 篡改 3：负对照缺失 → 拒（无 fail-closed 证明的"恢复"不可信）。
  const noNegatives = structuredClone(real);
  delete noNegatives.negativeB;
  assert.match(sessionReuseEvidenceFromPhase6File(noNegatives).detail, /fail-closed negatives incomplete/);
  // 形状坏 → 拒。
  assert.match(sessionReuseEvidenceFromPhase6File(null).detail, /not an object/);
  assert.match(sessionReuseEvidenceFromPhase6File({ steps: {} }).detail, /missing run1\/run2 runIds/);
});

test("kernel: SESSION_REUSE_EVIDENCE_SOURCES 只登记真实派发证据路径（deepseek-acp → phase6）", () => {
  assert.deepEqual(Object.keys(SESSION_REUSE_EVIDENCE_SOURCES), ["deepseek-acp"]);
  const source = SESSION_REUSE_EVIDENCE_SOURCES["deepseek-acp"];
  assert.equal(source.path, "scripts/reliability/dsh-acp/evidence/phase6-session-reuse.json");
  assert.ok(existsSync(join(REPO_ROOT, source.path)), "登记的证据路径必须真实存在");
  assert.ok(existsSync(join(REPO_ROOT, source.drill)), "登记的 drill 路径必须真实存在");
});

test("kernel: 配置传递按支持范围——装配带 model → 值必须送达；装配无 model → 注入必须明确拒绝（ADR-0032 §2）", () => {
  const byName = (checks) => new Map(checks.map((c) => [c.name, c]));
  // 支持范围含模型选择（装配携带 model 块）：送达 → 绿；未送达/静默丢弃 → 红。
  assert.equal(byName(backendStartupConfigChecks({
    configuredModelId: "glm-5.3[1m]", startedModelId: "glm-5.3[1m]",
  })).get("backendStartupConfigPassed").pass, true);
  const dropped = backendStartupConfigChecks({ configuredModelId: "glm-5.3[1m]", startedModelId: null });
  assert.equal(dropped[0].pass, false, "下发的 model 块静默丢弃 → 红");
  assert.match(dropped[0].detail, /must actually reach the backend/);

  // 支持范围不含模型选择（装配无 model 块，如 deepseek-acp）：注入被明确拒绝
  // → 绿（拒绝即正确结果，证据入账）；未拒绝/静默接受 → 红。
  const rejected = backendStartupConfigChecks({
    configuredModelId: null,
    modelBlockRejected: true,
    rejectionEvidence: "deepseek-acp cannot express a model block; the model comes from the shipped acp profile session configOptions",
  });
  assert.equal(rejected[0].pass, true, "明确拒绝 = 正确结果（不得要求值必须送达）");
  assert.match(rejected[0].detail, /explicitly rejected/);
  assert.match(rejected[0].detail, /cannot express a model block/);
  const silent = backendStartupConfigChecks({ configuredModelId: null, modelBlockRejected: false });
  assert.equal(silent[0].pass, false, "静默接受/忽略越界参数 → 红");
  assert.match(silent[0].detail, /silently accepting\/ignoring an out-of-scope parameter is forbidden/);
  const unknown = backendStartupConfigChecks({ configuredModelId: null });
  assert.equal(unknown[0].pass, false, "探针未观察（null）→ 红，不得当绿");
});

test("kernel: stop 执行形态判定——装配携带 serveUrl → serve；无 serveUrl → process（缺 serveUrl 是进程形常态，绝非判负理由）", () => {
  assert.equal(backendStopFormOf({ serveUrl: "http://127.0.0.1:4297", backend: "opencode-serve" }), "serve");
  // 进程式 backend（claude-code/codex/kimi-code/deepseek-acp）装配无 serveUrl。
  assert.equal(backendStopFormOf({ backend: "deepseek-acp", cwd: "." }), "process");
  assert.equal(backendStopFormOf({ backend: "claude-code", model: { id: "glm-5.3[1m]" } }), "process");
  // 空串/空白 serveUrl 不算 serve 证据；装配不可读（null）→ fail-closed 落 process
  // （该车道必须真实停掉 run，绝不因证据缺失静默换道）。
  assert.equal(backendStopFormOf({ serveUrl: "   " }), "process");
  assert.equal(backendStopFormOf(null), "process");
});

test("kernel: stop serve 形——既有语义保持（`wao stop` serve abort 车道 stopped===true + aborted + seq 单调）", () => {
  const byName = (checks) => new Map(checks.map((c) => [c.name, c]));
  const events = [
    { type: "run.started", agentId: "a", cwd: "c", seq: 1 },
    { type: "session.created", backendSessionId: "ses_1", serveUrl: "http://s", seq: 2 },
    { type: "run.aborted", seq: 3 },
    { type: "run.state_change", to: "aborted", seq: 4 },
  ];
  const green = byName(backendStopChecks({ form: "serve", stopAccepted: true, events }));
  assert.equal(green.get("stopAcknowledged").pass, true);
  assert.equal(green.get("stopStateAborted").pass, true);
  assert.equal(green.get("stopSeqMonotonic").pass, true);
  // serve 车道报错（如 serve 不可达）→ 红且 detail 带错误事实。
  const red = byName(backendStopChecks({ form: "serve", stopAccepted: false, events: [], errorDetail: "stopError=\"serve unreachable\"" }));
  assert.equal(red.get("stopAcknowledged").pass, false);
  assert.match(red.get("stopAcknowledged").detail, /stopped=false, stopError/);
});

test("kernel: stop process 形——owning-supervisor 车道全绿路径（车辆确认 + 途中 aborted fact + 宿主退出 + seq 单调）", () => {
  const events = [
    { type: "run.started", agentId: "a", cwd: "c", seq: 1 },
    { type: "session.created", backend: "deepseek-acp", backendSessionId: "75c13e12-ce24-4409-b88e-59669cc70712", seq: 2 },
    { type: "run.state_change", to: "running", seq: 3 },
    { type: "run.aborted", seq: 4 },
    { type: "run.state_change", to: "aborted", seq: 5 },
  ];
  const checks = backendStopChecks({ form: "process", stopAccepted: true, events, supervisorExited: true });
  const byName = new Map(checks.map((c) => [c.name, c]));
  assert.equal(byName.get("stopAcknowledged").pass, true);
  assert.equal(byName.get("stopStateAborted").pass, true);
  assert.equal(byName.get("stopSeqMonotonic").pass, true);
  // 无跳过/不适用通道：三条全是 judged checks，全过即构成组件判定的绿。
  for (const c of checks) assert.notEqual(c.informational, true, "stop 断言不得 informational 化（ADR-0032 §8）");
  assert.equal(componentResultFromChecks(checks), "pass");
});

test("kernel【证伪】: stop process 形——自然完成/车辆未确认/宿主残留/seq 回退各自红（模型自己跑完 ≠ stop 生效）", () => {
  const byName = (checks) => new Map(checks.map((c) => [c.name, c]));
  const base = [
    { type: "session.created", backend: "deepseek-acp", backendSessionId: "acp-sess", seq: 1 },
    { type: "run.state_change", to: "running", seq: 2 },
  ];
  // (a) run 自然完成先到（run.completed 在、无 run.aborted）：first-terminal-wins 下
  //     stop 输给自然终态不留 aborted fact——把 completed 读成 stop 生效是假绿。
  const natural = byName(backendStopChecks({
    form: "process",
    stopAccepted: true,
    events: [...base, { type: "run.completed", seq: 3 }, { type: "run.state_change", to: "completed", seq: 4 }],
    supervisorExited: true,
  }));
  assert.equal(natural.get("stopAcknowledged").pass, false, "自然完成不得读成 stop 生效");
  assert.match(natural.get("stopAcknowledged").detail, /natural completion is not a stop/);
  assert.equal(natural.get("stopStateAborted").pass, false, "终态 completed ≠ aborted");
  // (b) 停止车辆未确认（daemon 停机失败）→ 红，detail 带事实。
  const vehicle = byName(backendStopChecks({
    form: "process", stopAccepted: false, events: [...base, { type: "run.aborted", seq: 3 }, { type: "run.state_change", to: "aborted", seq: 4 }], supervisorExited: true,
  }));
  assert.equal(vehicle.get("stopAcknowledged").pass, false);
  assert.match(vehicle.get("stopAcknowledged").detail, /stopVehicleAcknowledged=false/);
  // (c) 宿主 supervisor 未退出（handshake 残留 = 进程终止所有者证据缺失）→ 红。
  const linger = byName(backendStopChecks({
    form: "process", stopAccepted: true, events: [...base, { type: "run.aborted", seq: 3 }, { type: "run.state_change", to: "aborted", seq: 4 }], supervisorExited: false,
  }));
  assert.equal(linger.get("stopAcknowledged").pass, false);
  assert.match(linger.get("stopAcknowledged").detail, /supervisorExited=false/);
  // (d) seq 回退 → stopSeqMonotonic 红（其余绿不掩盖）。
  const regressed = byName(backendStopChecks({
    form: "process",
    stopAccepted: true,
    events: [...base, { type: "run.aborted", seq: 5 }, { type: "run.state_change", to: "aborted", seq: 4 }],
    supervisorExited: true,
  }));
  assert.equal(regressed.get("stopSeqMonotonic").pass, false);
  assert.equal(regressed.get("stopAcknowledged").pass, true);
  // (e) 派发即失败（零事件）：三条全红，detail 指明车道失败事实。
  const dispatchFail = byName(backendStopChecks({
    form: "process", stopAccepted: false, events: [], supervisorExited: null, errorDetail: "daemon lane dispatch failed (daemonAlive=false)",
  }));
  for (const name of ["stopAcknowledged", "stopStateAborted", "stopSeqMonotonic"]) {
    assert.equal(dispatchFail.get(name).pass, false, `${name} 零事实不得绿`);
  }
});

test("kernel【证伪】: stop 判定不受缺 serveUrl 干扰——进程形断言集不含任何 serveUrl 依赖（缺陷 4 钉）", () => {
  // 2026-09-20 缺陷 4 实证形态：`wao stop` 对 ACP sessionId 报
  // "session has no serveUrl (opencode path needs one)"。进程形判定内核的
  // 输入面（form/stopAccepted/events/supervisorExited）不消费 serveUrl，
  // 判定不得因缺 serveUrl 翻红——红的唯一来源是真实停止事实缺失。
  const src = readFileSync(join(REPO_ROOT, "scripts", "reliability", "componentDrills.mjs"), "utf8");
  const kernelSrc = src.slice(src.indexOf("export function backendStopChecks"), src.indexOf("export function explicitFailureCheck"));
  assert.doesNotMatch(kernelSrc, /serveUrl/, "backendStopChecks 判定内核不得消费 serveUrl（缺 serveUrl 非判负理由）");
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

test("kernel【五态 2026-09-21】: N/A 不算失败也不置绿——judged pass + N/A → pass；全 N/A → fail；fail/blocked/inconclusive → fail", () => {
  const na = { name: "commandsPassed", pass: false, state: "not-applicable", stateReason: "declared reportsCommandExitCode=false", category: "strict", detail: "d" };
  // pass + N/A → pass（N/A 不拖垮正向证据）。
  assert.equal(componentResultFromChecks([check_("a", true), na]), "pass");
  // 全 N/A（零正向证据）→ fail：N/A 不贡献绿（ADR-0032 §8）。
  assert.equal(componentResultFromChecks([na, { ...na, name: "na2" }]), "fail");
  // fail / blocked / inconclusive 任一在场 → fail（真失败/真阻塞/证据不足都不是绿）。
  for (const status of ["fail", "blocked", "inconclusive"]) {
    const reasoned = { name: `x-${status}`, pass: false, status, stateReason: "r", category: "core", detail: "d" };
    assert.equal(componentResultFromChecks([check_("a", true), reasoned]), "fail", `${status} 检查不得给组件盖 pass`);
  }
  // informational 的 N/A 不参与判定（同既有 informational 纪律）。
  assert.equal(componentResultFromChecks([check_("a", true), { ...na, informational: true }]), "pass");
});

test("plan/execute【运行时身份 2026-09-21】: 指纹进组件键（backend:<name>@<codeRef>#<fp>），runtimeIdentity 入账，llm 侧无探测面", () => {
  const registry = syntheticRegistry();
  registry.certification = { fixtures: { llm: [{ agentId: "researcher" }] } };
  const fp = "v1-abcdef0123456789";
  const plan = planComponentChecks({
    registry,
    subjectArg: "codex",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
    runtimeFingerprints: { codex: fp },
  });
  assert.equal(plan.error, null);
  assert.equal(plan.subjects[0].subject.key, `backend:codex@${CODE_REF}#${fp}`, "组件键升级为 #<runtimeFingerprint> 后缀");
  const runtimeIdentity = { distribution: "codex", version: "0.5.0", binaryPath: "C:/x/codex.exe", fingerprint: fp };
  const inputs = executeComponentChecks({
    plan,
    drills: {
      runBackendComponentDrills: () => ({ checks: [check_("backendNormalCompletion", true)], facts: {} }),
      runLlmComponentDrills: () => { throw new Error("not an llm subject"); },
    },
    codeRef: CODE_REF,
    now: NOW,
    runtimeIdentities: { codex: runtimeIdentity },
  });
  assert.equal(inputs[0].runtimeIdentity, runtimeIdentity, "运行时身份随被测入账");
  const record = recordComponentCheck(inputs[0]);
  assert.equal(record.key, `backend:codex@${CODE_REF}#${fp}`);
  assert.equal(record.subject.runtimeFingerprint, fp, "subject 携带指纹（键重派生维）");
  assert.equal(record.runtimeIdentity.version, "0.5.0");
  assert.equal(record.runtimeIdentity.binaryPath, "C:/x/codex.exe");
  // 无指纹（legacy/测试缺省）→ 键不带 # 后缀（向后兼容形状）。
  const legacyPlan = planComponentChecks({ registry, subjectArg: "codex", codeRef: CODE_REF, compositionSummary: null, now: NOW });
  assert.equal(legacyPlan.subjects[0].subject.key, `backend:codex@${CODE_REF}`, "缺省指纹 → legacy 键形（不带 #）");
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

// ── stop 分车道 glue 集成 dry（stub CLI：零 token 跑完整 runBackendComponentDrills，
//    只断言 stop 探针的车道选择与判定；其余探针对 stub 输出自然红，不在断言面）──

const STUB_CLI_SOURCE = [
  "import { appendFileSync, readFileSync, rmSync, writeFileSync } from \"node:fs\";",
  "import { join } from \"node:path\";",
  "const args = process.argv.slice(2);",
  "const say = (o) => process.stdout.write(JSON.stringify(o) + \"\\n\");",
  "const opts = {};",
  "for (let i = 0; i < args.length; i += 1) {",
  "  if (args[i].startsWith(\"--\")) {",
  "    const k = args[i].slice(2);",
  "    const v = args[i + 1];",
  "    if (v && !v.startsWith(\"--\")) { opts[k] = v; i += 1; }",
  "  }",
  "}",
  "const runDir = opts[\"run-dir\"];",
  "appendFileSync(process.env.STUB_LOG, args.join(\" \") + \"\\n\", \"utf8\");",
  "const appendEvents = (runId, events) => {",
  "  const file = join(runDir, runId + \".jsonl\");",
  "  let seq = 0;",
  "  try { for (const l of readFileSync(file, \"utf8\").trim().split(/\\r?\\n/).filter(Boolean)) { const e = JSON.parse(l); if (typeof e.seq === \"number\") seq = Math.max(seq, e.seq); } } catch {}",
  "  appendFileSync(file, events.map((e) => JSON.stringify({ ...e, seq: (seq += 1), runId, ts: new Date().toISOString() })).join(\"\\n\") + \"\\n\", \"utf8\");",
  "};",
  "const cmd = args[0];",
  "if (cmd === \"spawn\") {",
  "  const runId = \"run_stub_serve\";",
  "  writeFileSync(join(runDir, runId + \".jsonl\"), \"\", \"utf8\");",
  "  appendEvents(runId, [",
  "    { type: \"run.started\", agentId: \"a1\", cwd: runDir },",
  "    { type: \"session.created\", backend: \"opencode-serve\", backendSessionId: \"ses_1\", serveUrl: \"http://127.0.0.1:4297\" },",
  "    { type: \"run.state_change\", from: \"pending\", to: \"running\" },",
  "  ]);",
  "  say({ runId, background: true });",
  "} else if (cmd === \"stop\") {",
  "  appendEvents(args[1], [",
  "    { type: \"run.aborted\" },",
  "    { type: \"run.state_change\", from: \"running\", to: \"aborted\" },",
  "  ]);",
  "  say({ stopped: true });",
  "} else if (cmd === \"daemon\" && args[1] === \"start\") {",
  "  writeFileSync(join(runDir, \"daemon.json\"), JSON.stringify({ pid: 1, pipe: opts.pipe, heartbeatAt: Date.now() }), \"utf8\");",
  "  say({ ok: true, started: true });",
  "} else if (cmd === \"daemon\" && args[1] === \"run\") {",
  "  const runId = \"run_stub_proc\";",
  "  appendEvents(runId, [",
  "    { type: \"run.started\", agentId: \"a1\", cwd: runDir },",
  "    { type: \"session.created\", backend: \"deepseek-acp\", backendSessionId: \"acp-sess-1\" },",
  "    { type: \"run.state_change\", from: \"pending\", to: \"running\" },",
  "  ]);",
  "  say({ ok: true, runId });",
  "} else if (cmd === \"daemon\" && args[1] === \"stop\") {",
  "  appendEvents(\"run_stub_proc\", [",
  "    { type: \"run.aborted\" },",
  "    { type: \"run.state_change\", from: \"running\", to: \"aborted\" },",
  "  ]);",
  "  if (!process.env.STUB_LINGER) rmSync(join(runDir, \"daemon.json\"), { force: true });",
  "  say({ ok: true, stopped: true, pid: 1 });",
  "} else {",
  "  say({});",
  "}",
].join("\n");

test("glue【集成 dry】: stop 按执行形态分车道——serve 走 spawn+`wao stop`，进程式走 daemon 车道（stub CLI，零 token）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wao-cc-stoplane-"));
  const fakeRoot = join(tmp, "root");
  mkdirSync(join(fakeRoot, "src"), { recursive: true });
  writeFileSync(join(fakeRoot, "src", "cli.js"), STUB_CLI_SOURCE);
  const argvLog = join(tmp, "argv.log");
  const prevLog = process.env.STUB_LOG;
  const prevLinger = process.env.STUB_LINGER;
  process.env.STUB_LOG = argvLog;
  delete process.env.STUB_LINGER;
  try {
    const runLane = (assembly) => {
      rmSync(argvLog, { force: true });
      const registryPath = join(tmp, `registry-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(registryPath, JSON.stringify({ agents: { a1: assembly } }));
      const drills = createComponentDrills({
        nodeBin: "node", root: fakeRoot, tmpDir: tmp, waitTimeout: "1000", pollInterval: "50", registry: registryPath,
      });
      const out = drills.runBackendComponentDrills({
        agentId: "a1",
        configuredModelId: null,
        // supportsSessionReuse=true 跳过需要 git 夹具的 fail-closed 探针（该探针
        // 与 stop 车道无关，dry 集成不做真实 git init）。
        capabilitySnapshot: { supportsSessionReuse: true, reportsTokenUsage: false },
      });
      return { checks: out.checks, argv: readFileSync(argvLog, "utf8") };
    };

    // serve 形（opencode-serve 装配）：spawn 托管 + `wao stop` serve abort 车道——
    // 既有语义保持，三断言全绿，绝不触碰 daemon。
    const serve = runLane({ backend: "opencode-serve", serveUrl: "http://127.0.0.1:4297", cwd: "." });
    const serveBy = new Map(serve.checks.map((c) => [c.name, c]));
    assert.match(serve.argv, /spawn a1 /, "serve 形经 spawn 托管派发");
    assert.match(serve.argv, /stop run_stub_serve /, "serve 形经 `wao stop` serve abort 车道");
    assert.doesNotMatch(serve.argv, /daemon/, "serve 形不进 daemon 车道");
    assert.equal(serveBy.get("stopAcknowledged").pass, true);
    assert.equal(serveBy.get("stopStateAborted").pass, true);
    assert.equal(serveBy.get("stopSeqMonotonic").pass, true);

    // 进程形（deepseek-acp 装配形态，无 serveUrl）：daemon 车道（start/run/stop，
    // --pipe 每轮唯一），不再进 `wao stop` 的 "no serveUrl" 车道；三断言全绿。
    const proc = runLane({ backend: "deepseek-acp", cwd: "." });
    const procBy = new Map(proc.checks.map((c) => [c.name, c]));
    assert.match(proc.argv, /daemon start /, "进程形起 owning-supervisor daemon");
    assert.match(proc.argv, /--pipe \\\\\.\\pipe\\wao-cc-stop-/, "daemon 管道每轮唯一命名");
    assert.match(proc.argv, /daemon run a1 /, "进程形 run 由 daemon 持有");
    assert.match(proc.argv, /daemon stop /, "进程形经 daemon 优雅停机驱动 stop");
    assert.doesNotMatch(proc.argv, / stop run_/, "进程形不再走 `wao stop`（缺 serveUrl 非判负理由）");
    assert.equal(procBy.get("stopAcknowledged").pass, true);
    assert.equal(procBy.get("stopStateAborted").pass, true);
    assert.equal(procBy.get("stopSeqMonotonic").pass, true);
    assert.match(procBy.get("stopAcknowledged").detail, /abortedFact=true/, "判定消费进程形事实（途中 aborted fact）");
    // daemon 车道 registry 变体绝对化 cwd（daemon start IPC 无 --cwd 透传面）。
    const variant = JSON.parse(readFileSync(join(tmp, "component-registry-stop-process.json"), "utf8"));
    assert.equal(variant.agents.a1.cwd, tmp, "进程形 daemon 派发的 cwd 必须绝对化到探针 tmpDir");

    // 宿主残留证伪：daemon 停机后 handshake 仍在（supervisor 未退出 = 进程终止
    // 所有者证据缺失）→ stopAcknowledged 红，红点明确指向 supervisorExited。
    process.env.STUB_LINGER = "1";
    const linger = runLane({ backend: "deepseek-acp", cwd: "." });
    const lingerBy = new Map(linger.checks.map((c) => [c.name, c]));
    assert.equal(lingerBy.get("stopAcknowledged").pass, false, "宿主 supervisor 残留 → 红");
    assert.match(lingerBy.get("stopAcknowledged").detail, /supervisorExited=false/);
    assert.equal(lingerBy.get("stopStateAborted").pass, true, "aborted 事实本身在——红点只在宿主证据");
  } finally {
    if (prevLog === undefined) delete process.env.STUB_LOG; else process.env.STUB_LOG = prevLog;
    if (prevLinger === undefined) delete process.env.STUB_LINGER; else process.env.STUB_LINGER = prevLinger;
    rmSync(tmp, { recursive: true, force: true });
  }
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

test("装配: backend 被测 = anchor 净化克隆——夹具 llm 身份绝不下发为被测配置", () => {
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
  // 基底 = 被测 backend（kimi-code）anchor 的净化克隆；model/provider 保持被测
  // 自己的实际配置（那就是它的支持范围）——夹具 llm（fallback 的
  // zhipuai/glm-5.2）不得以任何形态进入装配。
  assert.equal(assembly.backend, "kimi-code");
  assert.equal(assembly.model.id, "kimi-code/k3", "model = 被测 anchor 自己的配置");
  assert.equal(assembly.provider, undefined, "夹具 llm 的 provider 不得注入被测装配");
  assert.ok(!JSON.stringify(assembly).includes("glm-5.2"), "夹具 modelId 不得出现在被测装配");
  assert.ok(!JSON.stringify(assembly).includes("zhipuai-coding-plan"), "夹具 providerID 不得出现在被测装配");
  assert.equal(assembly.systemPrompt, undefined, "角色合同剥离（与组件机械验证无关）");
  assert.equal(assembly.sessionReuse, undefined, "sessionReuse 由 capability 探针显式控制");
  // 夹具身份仍完整进台账资格账（record.fixture）——记账归记账，下发归下发。
  assert.equal(plan.subjects[0].fixtureAccount.identity.modelId, "glm-5.2");

  // 反向：验 llm → 基底 = 夹具 backend anchor，model = 被测 llm anchor（被测
  // 身份正是要验证的下发对象——这与"夹具身份不下发"不冲突）。
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

test("装配【证伪·回归钉】: 被测 anchor 无 model/provider（deepseek-acp 形状）→ 装配零夹具身份注入（2026-09-20 首跑 7 连红根因）", () => {
  const registry = syntheticRegistry();
  // deepseek-acp 形状：anchor 无 model/provider（model 来自 runtime 自带
  // profile；validateAgentPolicy 对任何 model/provider 块 fail-closed 硬拒）。
  registry.agents.coder_low_dsh = {
    backend: "deepseek-acp",
    cwd: ".",
    credentialEnv: "DEEPSEEK_API_KEY",
  };
  registry.certification = { fixtures: { llm: [{ agentId: "fallback" }] } };
  const plan = planComponentChecks({
    registry,
    subjectArg: "deepseek-acp",
    codeRef: CODE_REF,
    compositionSummary: null,
    now: NOW,
  });
  assert.equal(plan.error, null);
  assert.equal(plan.subjects.length, 1);
  const assembly = plan.tempRegistry.agents[plan.subjects[0].fixtureAgentId];
  assert.equal(assembly.backend, "deepseek-acp");
  assert.equal(assembly.model, undefined, "装配绝不能携带 model 块（被测会 fail-closed 自拒——首跑根因）");
  assert.equal(assembly.provider, undefined, "装配绝不能携带 provider 块");
  assert.ok(!JSON.stringify(assembly).includes("glm-5.2"), "夹具 modelId 不得出现（含嵌套）");
  assert.ok(!JSON.stringify(plan.tempRegistry).includes("gpt-5.6-sol"), "任何夹具身份不得进入临时 registry");
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
