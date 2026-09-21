// test/registry-roles/componentLedger.test.js
//
// ADR-0032 §5 组件层台账（scripts/reliability/componentLedger.mjs）的单元测试。
// 覆盖：键构造两族、消费路径六态各一例（含触发变体）、lastVerifiedAt 命名隔离、
// 防泄漏钉（产物 JSON 不含 workers/status/recommendedUse/lastFullHealthyRunAt）、
// 合并/修剪/汇总对 certification.mjs 纯函数的复用、以及台账文件独立性。
//
// 临时文件纪律（WAO 任务约束）：所有写入限本 worktree 内，落在
// <worktreeRoot>/.wao/runs/ 下的唯一临时目录（gitignored 运行时状态，
// 不触碰仓库真实 runs/——staticRunsGuard 的不变量）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPONENT_KINDS,
  COMPONENT_LEDGER_FILENAME,
  COMPONENT_LEDGER_STATES,
  COMPONENT_LEDGER_VERSION,
  COMPONENT_RESULTS,
  annotateFixtureDecay,
  annotateRuntimeDrift,
  assertNoCompositionLayerLeak,
  backendComponentKey,
  classifyComponent,
  classifyComponentFromFile,
  componentKeyFor,
  componentKeyKind,
  componentLedgerPathFor,
  fixtureIdentityKey,
  fixtureQualificationState,
  llmComponentKey,
  mergeComponentRecords,
  parseComponentLedger,
  pruneComponentRecords,
  readComponentLedgerFile,
  recordComponentCheck,
  serializeComponentLedger,
  summarizeComponentLedger,
  validateComponentRecord,
  writeComponentLedgerFile,
} from "../../scripts/reliability/componentLedger.mjs";

// ── 临时区：<worktreeRoot>/.wao/runs/componentLedger-<rand>/ ─────────────────
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..", "..");
const WAO_RUNS_TMP = join(REPO_ROOT, ".wao", "runs");
mkdirSync(WAO_RUNS_TMP, { recursive: true });
const TMP = mkdtempSync(join(WAO_RUNS_TMP, "componentLedger-"));
test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ── 共享夹具（时钟与 codeRef 全部显式注入——测试确定性） ─────────────────────
const NOW = "2026-09-20T12:00:00.000Z";
const HEAD = "1a2b3c4d".padEnd(40, "0");
const OTHER_HEAD = "9f8e7d6c".padEnd(40, "5");
const PKEY = "https://api.deepseek.com|DEEPSEEK_API_KEY";
const daysBefore = (n) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

function fixtureLlm(overrides = {}) {
  return {
    kind: "llm",
    identity: {
      backend: "deepseek-harness",
      providerID: "deepseek",
      modelId: "deepseek-v4-flash",
      providerKey: PKEY,
    },
    runtimeVersion: "node v22.x",
    adapterVersion: "dsh-acp@0.1",
    configDigest: "sha256:cafe1234",
    contract: { name: "deepseek-harness-events", version: "1.2.0" },
    environment: "win32",
    runId: "run_fixture_001",
    qualifiedBy: "composition-cert",
    qualifiedAt: NOW,
    ...overrides,
  };
}

function backendPassRecord(overrides = {}) {
  return recordComponentCheck({
    kind: "backend",
    name: "deepseek-harness",
    codeRef: HEAD,
    result: "pass",
    reason: "contract checks passed",
    lastVerifiedAt: NOW,
    checks: [{ name: "startup-config-rejection", pass: true, detail: "unsupported param rejected explicitly" }],
    fixture: fixtureLlm(),
    ...overrides,
  });
}

function llmPassRecord(overrides = {}) {
  return recordComponentCheck({
    kind: "llm",
    providerID: "deepseek",
    modelId: "deepseek-v4-flash",
    providerKey: PKEY,
    codeRef: HEAD,
    result: "pass",
    reason: "llm drills passed",
    lastVerifiedAt: NOW,
    checks: [{ name: "tool-result-read", pass: true, detail: "random value read from tool result" }],
    fixture: {
      kind: "backend",
      identity: { backend: "deepseek-harness", providerID: "deepseek", modelId: "deepseek-v4-flash", providerKey: PKEY },
      runtimeVersion: "node v22.x",
      adapterVersion: "dsh-acp@0.1",
      configDigest: "sha256:cafe1234",
      contract: { name: "deepseek-harness-events", version: "1.2.0" },
      environment: "win32",
      runId: "run_fixture_002",
      qualifiedBy: "composition-cert",
      qualifiedAt: NOW,
    },
    ...overrides,
  });
}

// 深walk 工具：产物键名 / 字符串值枚举（防泄漏钉的机械判据）。
function* iterKeys(node) {
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    yield k;
    yield* iterKeys(v);
  }
}
function* iterStringValues(node) {
  if (node === null || node === undefined) return;
  if (typeof node === "string") {
    yield node;
    return;
  }
  if (typeof node !== "object") return;
  for (const v of Object.values(node)) yield* iterStringValues(v);
}

function writeLedger(name, records, options = {}) {
  const path = join(TMP, name, COMPONENT_LEDGER_FILENAME);
  writeComponentLedgerFile(path, summarizeComponentLedger(records, options));
  return path;
}

// ── 1. 键构造两族 ────────────────────────────────────────────────────────────

test("keys: backend 族键形 backend:<name>@<codeRef>（codeRef = 验证时 git HEAD）", () => {
  const key = backendComponentKey({ name: "deepseek-harness", codeRef: HEAD });
  assert.equal(key, `backend:deepseek-harness@${HEAD}`);
  assert.match(key, /^backend:[^@]+@[^@]+$/);
  assert.equal(componentKeyKind(key), "backend");
});

test("keys: llm 族键形 llm:<providerID>/<modelId>@<providerKey>", () => {
  const key = llmComponentKey({ providerID: "deepseek", modelId: "deepseek-v4-flash", providerKey: PKEY });
  assert.equal(key, `llm:deepseek/deepseek-v4-flash@${PKEY}`);
  assert.match(key, /^llm:[^/@]+\/[^@]+@.+$/);
  assert.equal(componentKeyKind(key), "llm");
});

test("keys: providerKey = null（已观察无接入方）编码为字面 null，与真实指纹不碰撞", () => {
  const key = llmComponentKey({ providerID: "zcode", modelId: "glm-5.2", providerKey: null });
  assert.equal(key, "llm:zcode/glm-5.2@null");
  // 真实指纹恒含 "|"（<baseUrl>|<env>），字面 "null" 不可能与之相等。
  assert.notEqual(key, llmComponentKey({ providerID: "zcode", modelId: "glm-5.2", providerKey: "https://x|K" }));
});

test("keys: modelId 可含 /（如 kimi-code/k3），providerID 不得含 / —— 族内边界单射", () => {
  const key = llmComponentKey({ providerID: "kimi", modelId: "kimi-code/k3", providerKey: PKEY });
  assert.equal(key, `llm:kimi/kimi-code/k3@${PKEY}`);
  assert.equal(componentKeyKind(key), "llm");
  assert.throws(
    () => llmComponentKey({ providerID: "kimi/evil", modelId: "k3", providerKey: PKEY }),
    /must not contain "\/"/,
  );
});

test("keys: 分隔符约束 fail-closed（@ 破坏键可逆解析 / 空分量 / 未知 kind）", () => {
  assert.throws(() => backendComponentKey({ name: "a@b", codeRef: HEAD }), /must not contain "@"|must not contain /);
  assert.throws(() => backendComponentKey({ name: "x", codeRef: "h@ead" }), /must not contain "@"|must not contain /);
  assert.throws(() => backendComponentKey({ name: "", codeRef: HEAD }), /non-empty string/);
  assert.throws(() => llmComponentKey({ providerID: "d", modelId: "m@x", providerKey: PKEY }), /must not contain "@"|must not contain /);
  assert.throws(() => llmComponentKey({ providerID: "d", modelId: "m", providerKey: "k@y" }), /must not contain "@"|must not contain /);
  assert.throws(() => llmComponentKey({ providerID: "d", modelId: "m" }), /non-empty string/);
  assert.throws(() => componentKeyFor({ kind: "agent", name: "x" }), /kind must be one of/);
});

test("keys: kind 命名空间与 ADR-0026 四元组键空间（workers 映射的裸 agentId）不相交", () => {
  // 四元组活在 reliability-summary.workers（键 = agentId）；组件键恒带命名空间前缀。
  for (const agentId of ["researcher", "coder_hq", "coder_low", "auditor"]) {
    assert.equal(componentKeyKind(agentId), null, `agentId "${agentId}" 不得被误认成组件键`);
  }
  const backendKey = backendComponentKey({ name: "deepseek-harness", codeRef: HEAD });
  const llmKey = llmComponentKey({ providerID: "deepseek", modelId: "m", providerKey: PKEY });
  assert.notEqual(backendKey, llmKey, "两族键恒不相等（前缀不同）");
  assert.deepEqual(COMPONENT_KINDS, ["backend", "llm"]);
});

// ── 2. 记录构造：subject/fixture 两字段 + lastVerifiedAt 命名 + 闭集 ─────────

test("record: 显式分 subject 与 fixture（§4 夹具入账：四元组+版本+摘要+环境+runId+资格依据）", () => {
  const record = backendPassRecord();
  assert.equal(record.subject.kind, "backend");
  assert.equal(record.subject.name, "deepseek-harness");
  assert.equal(record.subject.codeRef, HEAD);
  const fixture = record.fixture;
  assert.equal(fixture.kind, "llm", "验 backend → 夹具是对侧 llm");
  assert.deepEqual(
    Object.keys(fixture.identity).sort(),
    ["backend", "modelId", "providerID", "providerKey"],
    "夹具记全身份四元组（ADR-0026）",
  );
  assert.equal(fixture.runId, "run_fixture_001");
  assert.equal(fixture.qualifiedBy, "composition-cert");
  assert.deepEqual(fixture.contract, { name: "deepseek-harness-events", version: "1.2.0" });
  assert.equal(fixture.configDigest, "sha256:cafe1234");
  assert.equal(fixture.environment, "win32");
  assert.equal(record.caseId, record.key, "mergeCaseResults 复用的合并键 = 组件键");
});

test("record: 时间字段名必须是 lastVerifiedAt（命名隔离的产出侧）", () => {
  const record = backendPassRecord();
  assert.equal(record.lastVerifiedAt, NOW);
  assert.ok(![...iterKeys(record)].includes("lastHealthyRunAt"));
  assert.ok(![...iterKeys(record)].includes("lastFullHealthyRunAt"));
});

test("record: 结果闭集 pass/fail/blocked；组合层词 certified/conditional 显式拒绝", () => {
  assert.deepEqual(COMPONENT_RESULTS, ["pass", "fail", "blocked"]);
  assert.throws(
    () => backendPassRecord({ result: "certified" }),
    /component-layer closed set/,
  );
  assert.throws(
    () => backendPassRecord({ result: "conditional" }),
    /component-layer closed set/,
  );
  // blocked 记录默认 blockedReason = fixture-unavailable（§4 coder_mm 护栏词）。
  const blocked = backendPassRecord({ result: "blocked" });
  assert.equal(blocked.result, "blocked");
  assert.equal(blocked.blockedReason, "fixture-unavailable");
});

test("record: lastVerifiedAt 不可解析 fail-closed", () => {
  assert.throws(() => backendPassRecord({ lastVerifiedAt: "not-a-date" }), /parseable ISO-8601/);
});

// ── 3. 六态分类（每种至少一例；返回显式状态而非布尔） ────────────────────────

test("six-states: normal —— 记录现行且新鲜（codeRef 匹配 + 未超期 + 夹具新鲜）", () => {
  const path = writeLedger("normal", [backendPassRecord()], { generatedAt: NOW });
  const out = classifyComponentFromFile(path, backendPassRecord().key, { now: NOW, currentCodeRef: HEAD });
  assert.equal(out.state, "normal");
  assert.equal(out.record.result, "pass");
  assert.match(out.reason, /record current/);
});

test("six-states: normal 对 fail 判定同样成立——六态描述台账可信度，判定词在 record.result", () => {
  const failed = backendPassRecord({ result: "fail", reason: "event conversion fabricated success evidence" });
  const path = writeLedger("normal-fail", [failed], { generatedAt: NOW });
  const out = classifyComponentFromFile(path, failed.key, { now: NOW, currentCodeRef: HEAD });
  assert.equal(out.state, "normal");
  assert.equal(out.record.result, "fail");
});

test("six-states: ledger-missing（文件不存在）—— 未验证，既不红也不绿", () => {
  const path = join(TMP, "does-not-exist", COMPONENT_LEDGER_FILENAME);
  const fileState = readComponentLedgerFile(path);
  assert.equal(fileState.state, "ledger-missing");
  const out = classifyComponent(fileState, backendComponentKey({ name: "x", codeRef: HEAD }));
  assert.equal(out.state, "ledger-missing");
  assert.match(out.reason, /未验证/);
  assert.equal(out.record, undefined, "无记录可带回——不是绿");
});

test("six-states: ledger-missing（键无记录）—— 台账在但该组件未验证（reason 与文件级区分）", () => {
  const path = writeLedger("no-record", [backendPassRecord()], { generatedAt: NOW });
  const absentKey = llmComponentKey({ providerID: "kimi", modelId: "kimi-code/k3", providerKey: PKEY });
  const out = classifyComponentFromFile(path, absentKey, { now: NOW });
  assert.equal(out.state, "ledger-missing");
  assert.match(out.reason, /no record for component key/);
  assert.equal(out.record, undefined);
});

test("six-states: unparseable（JSON 坏）—— 显式报错，绝不静默跳过", () => {
  const path = join(TMP, "unparseable-json", COMPONENT_LEDGER_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ this is not json");
  const out = classifyComponentFromFile(path, backendPassRecord().key, { now: NOW });
  assert.equal(out.state, "unparseable");
  assert.ok(out.error, "必须带回显式 error");
  assert.match(out.reason, /never skip silently/);
});

test("six-states: unparseable（记录缺 lastVerifiedAt）—— 磁盘形状校验 fail-closed", () => {
  const record = backendPassRecord();
  const broken = { ...summarizeComponentLedger([record], { generatedAt: NOW }) };
  delete broken.components[record.key].lastVerifiedAt;
  broken.records = broken.records.map((r) => (r.key === record.key ? broken.components[record.key] : r));
  const path = join(TMP, "unparseable-shape", COMPONENT_LEDGER_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(broken, null, 2));
  const fileState = readComponentLedgerFile(path);
  assert.equal(fileState.state, "unparseable");
  assert.match(fileState.error, /lastVerifiedAt/);
});

test("six-states: blocked —— 记录结果为 blocked（验证时夹具不可用）", () => {
  const blocked = llmPassRecord({ result: "blocked", blockedReason: "fixture-unavailable" });
  const path = writeLedger("blocked", [blocked], { generatedAt: NOW });
  const out = classifyComponentFromFile(path, blocked.key, { now: NOW });
  assert.equal(out.state, "blocked");
  assert.match(out.reason, /fixture-unavailable/);
});

test("six-states: stale（codeRef 不匹配）—— advisory（llm 键不含 codeRef，漂移在消费时判）", () => {
  const record = llmPassRecord({ codeRef: HEAD }); // 键 = llm:...（无 codeRef 维）
  const path = writeLedger("stale-coderef", [record], { generatedAt: NOW });
  const out = classifyComponentFromFile(path, record.key, { now: NOW, currentCodeRef: OTHER_HEAD });
  assert.equal(out.state, "stale");
  assert.match(out.reason, /codeRef mismatch/);
});

test("six-states: stale（超期）—— lastVerifiedAt 距今超过 maxAgeDays", () => {
  const record = backendPassRecord({ lastVerifiedAt: daysBefore(40) });
  const path = writeLedger("stale-age", [record], { generatedAt: NOW });
  const out = classifyComponentFromFile(path, record.key, { now: NOW, currentCodeRef: HEAD });
  assert.equal(out.state, "stale");
  assert.match(out.reason, /expired|days old/);
});

test("six-states: fixture-decayed（现判）—— 夹具组合认证过期，历史记录降 advisory 且不删", () => {
  const record = backendPassRecord({ fixture: fixtureLlm({ qualifiedAt: daysBefore(40) }) });
  const path = writeLedger("fixture-decayed-live", [record], { generatedAt: NOW });
  const out = classifyComponentFromFile(path, record.key, { now: NOW, currentCodeRef: HEAD });
  assert.equal(out.state, "fixture-decayed");
  assert.match(out.reason, /advisory, retained not deleted/);
  assert.equal(out.record.key, record.key, "记录原样带回（不删）");
});

test("six-states: fixture-decayed（已标注）—— annotateFixtureDecay 持久化 advisory，不删任何记录", () => {
  const backend = backendPassRecord();
  const llm = llmPassRecord();
  const annotated = annotateFixtureDecay([backend, llm], {
    runId: "run_fixture_001", // 只命中 backend 记录的夹具
    reason: "composition certification aged out",
    at: NOW,
  });
  assert.equal(annotated.length, 2, "降 advisory 绝不删记录（数组长度不变）");
  assert.equal(annotated[0].advisory.code, "fixture-decayed");
  assert.equal(annotated[1].advisory, undefined, "未命中夹具的记录不被标注");
  const path = writeLedger("fixture-decayed-annotated", annotated, { generatedAt: NOW });
  const out = classifyComponentFromFile(path, backend.key, { now: NOW, currentCodeRef: HEAD });
  assert.equal(out.state, "fixture-decayed");
  assert.match(out.reason, /composition certification aged out/);
  // identityKey 匹配器同样可用；两个匹配器都不给 → 显式拒绝。
  const byIdentity = annotateFixtureDecay([backend], { identityKey: fixtureIdentityKey(backend.fixture.identity), at: NOW });
  assert.equal(byIdentity[0].advisory.code, "fixture-decayed");
  assert.throws(() => annotateFixtureDecay([backend], { reason: "x" }), /at least one matcher/);
});

test("six-states: 闭集恰好六值，classifyComponent 拒绝非文件态输入（防布尔化/防滥用）", () => {
  assert.deepEqual(COMPONENT_LEDGER_STATES, [
    "normal", "ledger-missing", "unparseable", "stale", "blocked", "fixture-decayed",
  ]);
  assert.throws(() => classifyComponent({ state: "loaded" }, "researcher"), /namespaced component key/);
  assert.throws(() => classifyComponent(null, backendPassRecord().key), /fileState must come from readComponentLedgerFile/);
  assert.throws(() => classifyComponent({ state: "weird" }, backendPassRecord().key), /fileState must come from/);
});

test("fixtureQualificationState: absent/fresh/expired/unknown 显式四态（非布尔）", () => {
  assert.equal(fixtureQualificationState(null, { now: NOW }), "absent");
  assert.equal(fixtureQualificationState(fixtureLlm(), { now: NOW }), "fresh");
  assert.equal(fixtureQualificationState(fixtureLlm({ qualifiedAt: daysBefore(40) }), { now: NOW }), "expired");
  assert.equal(fixtureQualificationState(fixtureLlm({ qualifiedAt: daysBefore(40) }), { now: NOW, fixtureMaxAgeDays: 90 }), "fresh", "窗口可注入");
  // owner-declared：无 ownerValidUntil → unknown（诚实，不猜）；有则按有效期判。
  assert.equal(fixtureQualificationState(fixtureLlm({ qualifiedBy: "owner-declared" }), { now: NOW }), "unknown");
  assert.equal(
    fixtureQualificationState(fixtureLlm({ qualifiedBy: "owner-declared", ownerValidUntil: daysBefore(1) }), { now: NOW }),
    "expired",
  );
  assert.equal(
    fixtureQualificationState(fixtureLlm({ qualifiedBy: "owner-declared", ownerValidUntil: daysBefore(-1) }), { now: NOW }),
    "fresh",
  );
  // composition-cert 缺 qualifiedAt → unknown。
  assert.equal(fixtureQualificationState(fixtureLlm({ qualifiedAt: null }), { now: NOW }), "unknown");
});

// ── 4. 合并 / 修剪 / 汇总（复用 certification.mjs 纯函数，零复制） ────────────

test("merge: 同键刷新、未重跑保留、全新键追加（复用 mergeCaseResults 语义）", () => {
  const old = backendPassRecord({ result: "fail", reason: "529 upstream" });
  const other = llmPassRecord();
  const fresh = backendPassRecord({ result: "pass", reason: "rerun green" });
  const merged = mergeComponentRecords([old, other], [fresh]);
  assert.equal(merged.length, 2, "同键不重复");
  const byKey = new Map(merged.map((r) => [r.key, r]));
  assert.equal(byKey.get(old.key).result, "pass", "重验证刷新同键记录");
  assert.equal(byKey.get(other.key).result, "pass", "未重跑的其它组件记录保留");
  const appended = mergeComponentRecords(merged, [
    recordComponentCheck({ kind: "backend", name: "kimi-code", codeRef: HEAD, result: "fail", lastVerifiedAt: NOW }),
  ]);
  assert.equal(appended.length, 3, "全新键追加");
});

test("prune: 同 kind 键级僵尸清理；kind 未被清单覆盖的记录不动（scope 守卫）", () => {
  const backendOld = recordComponentCheck({
    kind: "backend", name: "deepseek-harness", codeRef: OTHER_HEAD, result: "pass", lastVerifiedAt: NOW,
  });
  const backendCur = backendPassRecord();
  const llm = llmPassRecord();
  // 全量清单（类比 MATRIX 全表）：旧 codeRef 的 backend 键是僵尸 → 修剪。
  const pruned = pruneComponentRecords([backendOld, backendCur, llm], [backendCur.key, llm.key]);
  assert.deepEqual(pruned.map((r) => r.key).sort(), [backendCur.key, llm.key].sort());
  // 清单只覆盖 llm 族：backend 记录不在 scope 内 → 一律不动（部分重跑不连坐）。
  const guarded = pruneComponentRecords([backendOld, backendCur, llm], [llm.key]);
  assert.equal(guarded.length, 3);
  // 清单键必须带命名空间（裸 agentId 是组合层键空间）。
  assert.throws(() => pruneComponentRecords([llm], ["researcher"]), /namespaced component key/);
});

test("summarize: counts 按组件层三值闭集、versioned、generatedAt 可注入、allPassed 语义", () => {
  const pass = backendPassRecord();
  const fail = recordComponentCheck({
    kind: "backend", name: "kimi-code", codeRef: HEAD, result: "fail", lastVerifiedAt: NOW,
  });
  const blocked = llmPassRecord({ result: "blocked" });
  const summary = summarizeComponentLedger([pass, fail, blocked], { generatedAt: NOW });
  assert.equal(summary.version, COMPONENT_LEDGER_VERSION);
  assert.equal(summary.generatedAt, NOW);
  assert.deepEqual(summary.counts, { pass: 1, fail: 1, blocked: 1 });
  assert.equal(summary.allPassed, false);
  assert.deepEqual(Object.keys(summary.components).sort(), [pass.key, fail.key, blocked.key].sort());
  assert.equal(summary.records.length, 3);
  const allGreen = summarizeComponentLedger([pass, llmPassRecord()], { generatedAt: NOW });
  assert.equal(allGreen.allPassed, true);
  assert.equal(summarizeComponentLedger([], { generatedAt: NOW }).allPassed, false, "空台账不宣称全绿");
});

test("summarize: 记录校验 fail-closed——result 越闭集 / 身份漂移显式抛错", () => {
  const good = backendPassRecord();
  const badResult = { ...good, key: `backend:other@${HEAD}`, caseId: `backend:other@${HEAD}`, result: "conditional" };
  badResult.subject = { ...good.subject, name: "other" };
  assert.throws(() => summarizeComponentLedger([badResult]), /component-layer closed set/);
  const drifted = { ...good };
  drifted.subject = { ...good.subject, name: "renamed-backend" }; // subject 不再派生出记录键
  assert.throws(() => summarizeComponentLedger([drifted]), /does not re-derive the record key/);
});

// ── 5. 台账文件独立性（分文件、共证据） ──────────────────────────────────────

test("ledger file: 文件名恒为 component-checks.json，与 reliability-summary.json 分文件", () => {
  assert.equal(COMPONENT_LEDGER_FILENAME, "component-checks.json");
  const p = componentLedgerPathFor(join(TMP, "some-run-dir"));
  assert.equal(basename(p), "component-checks.json");
  assert.notEqual(basename(p), "reliability-summary.json");
  // 模块【代码】不引用组合层台账文件名（注释里的文档性提及不算——钉的是执行面）。
  const moduleSource = readFileSync(new URL("../../scripts/reliability/componentLedger.mjs", import.meta.url), "utf8");
  const codeOnly = moduleSource.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!codeOnly.includes("reliability-summary"), "组件层模块代码不得触碰组合层台账文件");
});

test("ledger file: write → read 往返（serialize 带 trailing newline）", () => {
  const record = backendPassRecord();
  const summary = summarizeComponentLedger([record], { generatedAt: NOW });
  const text = serializeComponentLedger(summary);
  assert.ok(text.endsWith("\n"));
  const path = join(TMP, "roundtrip", "nested", COMPONENT_LEDGER_FILENAME);
  const written = writeComponentLedgerFile(path, summary);
  assert.ok(written.bytes > 0);
  const fileState = readComponentLedgerFile(path);
  assert.equal(fileState.state, "loaded");
  assert.equal(fileState.ledger.components[record.key].result, "pass");
  assert.equal(readFileSync(path, "utf8"), text);
});

// ── 6. lastVerifiedAt 命名隔离（与 runManager 新鲜度门的词汇互斥） ────────────

test("naming: 产物只写 lastVerifiedAt，绝无 lastHealthyRunAt / lastFullHealthyRunAt", () => {
  const summary = summarizeComponentLedger([backendPassRecord(), llmPassRecord()], { generatedAt: NOW });
  const keys = [...iterKeys(summary)];
  assert.ok(keys.includes("lastVerifiedAt"));
  assert.ok(!keys.includes("lastHealthyRunAt"), "legacy 回落名不得出现在组件台账");
  assert.ok(!keys.includes("lastFullHealthyRunAt"), "R23-C 全量新鲜度名不得出现在组件台账");
  const text = serializeComponentLedger(summary);
  assert.ok(text.includes("lastVerifiedAt"));
  assert.ok(!text.includes("lastHealthyRunAt"));
});

test("naming: runManager 认证门只认 lastFullHealthyRunAt/lastHealthyRunAt，从不读 lastVerifiedAt", () => {
  // 【钉】src/runManager.js 的 legacy 回落形状（ADR-0032 §5 引用的行）——门的新鲜度
  // 词汇表与组件层时间字段天然互斥，组件新鲜度对门不可见（不进门禁）。
  const gate = readFileSync(new URL("../../src/runManager.js", import.meta.url), "utf8");
  assert.match(
    gate,
    /w\.lastFullHealthyRunAt === undefined \? w\.lastHealthyRunAt : w\.lastFullHealthyRunAt/,
    "legacy 回落必须仍只认这两个名字（若此断言红，说明门的词汇表漂了，组件隔离被破坏）",
  );
  assert.ok(!gate.includes("lastVerifiedAt"), "派发门绝不能读组件层时间字段 lastVerifiedAt");
});

// ── 7. 防泄漏钉（隔离硬保证） ────────────────────────────────────────────────

test("leak-pin: 产物 JSON（全层级键名）不含 workers/status/recommendedUse/lastFullHealthyRunAt", () => {
  const records = [
    backendPassRecord(),
    llmPassRecord(),
    llmPassRecord({ result: "blocked" }),
    backendPassRecord({ fixture: fixtureLlm({ qualifiedAt: daysBefore(40) }) }),
  ];
  const annotated = annotateFixtureDecay(records, { runId: "run_fixture_001", at: NOW });
  const summary = summarizeComponentLedger(annotated, { generatedAt: NOW });
  const path = writeLedger("leak-pin", annotated, { generatedAt: NOW });
  // 落盘文本再 parse 回来钉（钉的是真实产物字节，不只是内存对象）。
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  for (const artifact of [summary, onDisk]) {
    const keys = [...iterKeys(artifact)];
    for (const banned of ["workers", "status", "recommendedUse", "lastFullHealthyRunAt", "lastHealthyRunAt"]) {
      assert.ok(!keys.includes(banned), `产物不得含组合层键 "${banned}"`);
    }
    // 值域钉：任何字符串值都不得是组合层状态词。
    for (const value of iterStringValues(artifact)) {
      assert.ok(value !== "certified" && value !== "conditional", `产物值域不得含组合层状态词，got "${value}"`);
    }
  }
});

test("leak-pin: assertNoCompositionLayerLeak 对嵌套保留键显式抛错", () => {
  assert.throws(() => assertNoCompositionLayerLeak({ workers: {} }), /reserved key "workers"/);
  assert.throws(() => assertNoCompositionLayerLeak({ a: { b: [{ status: 1 }] } }), /reserved key "status"/);
  assert.throws(() => assertNoCompositionLayerLeak({ recommendedUse: "x" }), /reserved key "recommendedUse"/);
  assert.throws(() => assertNoCompositionLayerLeak({ lastFullHealthyRunAt: "2026-01-01" }), /reserved key "lastFullHealthyRunAt"/);
  assert.doesNotThrow(() => assertNoCompositionLayerLeak({ components: {}, counts: { pass: 1 } }));
});

test("leak-pin: writeComponentLedgerFile / serializeComponentLedger 拒写含组合层键的 payload", () => {
  const summary = summarizeComponentLedger([backendPassRecord()], { generatedAt: NOW });
  const poisoned = { ...summary, workers: { researcher: { state: "certified" } } };
  assert.throws(() => serializeComponentLedger(poisoned), /reserved key "workers"/);
  assert.throws(
    () => writeComponentLedgerFile(join(TMP, "poisoned", COMPONENT_LEDGER_FILENAME), poisoned),
    /reserved key "workers"/,
  );
  // 嵌套注入同样拒绝（summary 构造后再塞字段）。
  const nestedPoison = { ...summary, records: summary.records.map((r) => ({ ...r, recommendedUse: "strict-dispatch" })) };
  assert.throws(() => serializeComponentLedger(nestedPoison), /reserved key "recommendedUse"/);
});

test("leak-pin: parseComponentLedger 把含组合层键的台账判 unparseable（显式错误）", () => {
  const summary = summarizeComponentLedger([backendPassRecord()], { generatedAt: NOW });
  const poisoned = JSON.stringify({ ...summary, workers: { researcher: {} } });
  const parsed = parseComponentLedger(poisoned);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /reserved key "workers"/);
  const fileState = (() => {
    const path = join(TMP, "poisoned-on-disk", COMPONENT_LEDGER_FILENAME);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, poisoned);
    return readComponentLedgerFile(path);
  })();
  assert.equal(fileState.state, "unparseable");
  // counts 键越闭集（组合层词混入）同样拒绝。
  const badCounts = parseComponentLedger(JSON.stringify({ ...summary, counts: { certified: 1 } }));
  assert.equal(badCounts.ok, false);
  assert.match(badCounts.error, /closed set/);
});

test("leak-pin: 模块不得 import certification.mjs 的状态闭集（certified/conditional 词汇隔离）", () => {
  const moduleSource = readFileSync(new URL("../../scripts/reliability/componentLedger.mjs", import.meta.url), "utf8");
  const importMatch = moduleSource.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/certification\.mjs["']/s);
  assert.ok(importMatch, "必须从 certification.mjs 复用纯函数（合并/修剪语义零复制）");
  const names = importMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual([...names].sort(), ["mergeCaseResults", "pruneStaleCases"], "只允许复用无状态纯工具");
  for (const banned of ["CERTIFICATION_STATUSES", "certifyCase", "summarizeCertification", "RECOMMENDED_USE"]) {
    assert.ok(!names.includes(banned), `不得 import 组合层闭集符号 ${banned}`);
  }
});

// ════ 运行时身份入账 + 检查五态（ADR-0032 §5/§8 批次，2026-09-21）════

test("keys【运行时身份】: backend 键升级 backend:<name>@<codeRef>#<fp>；指纹分隔符约束；legacy 无指纹键形兼容", () => {
  assert.equal(
    backendComponentKey({ name: "deepseek-acp", codeRef: "abc123", runtimeFingerprint: "v1-deadbeefdeadbeef" }),
    "backend:deepseek-acp@abc123#v1-deadbeefdeadbeef",
  );
  assert.equal(
    backendComponentKey({ name: "deepseek-acp", codeRef: "abc123" }),
    "backend:deepseek-acp@abc123",
    "缺省指纹 → legacy 键形（不带 #）",
  );
  assert.throws(() => backendComponentKey({ name: "x", codeRef: "y", runtimeFingerprint: "a#b" }), /must not contain "#"/);
  assert.throws(() => backendComponentKey({ name: "x", codeRef: "y", runtimeFingerprint: "a@b" }), /must not contain "@"/);
  assert.equal(componentKeyKind("backend:deepseek-acp@abc123#v1-deadbeefdeadbeef"), "backend", "带指纹键仍落 backend 命名空间");
});

test("record【运行时身份】: runtimeIdentity 入账 + subject.runtimeFingerprint 重派生维；llm 被测拒绝该字段", () => {
  const record = recordComponentCheck({
    kind: "backend",
    name: "codex",
    codeRef: "abc123",
    runtimeIdentity: { distribution: "codex", version: "0.9.2", binaryPath: "C:/x/codex.exe", fingerprint: "v1-feedfacefeedface" },
    result: "pass",
    checks: [],
    fixture: null,
  });
  assert.equal(record.key, "backend:codex@abc123#v1-feedfacefeedface");
  assert.equal(record.subject.runtimeFingerprint, "v1-feedfacefeedface");
  assert.deepEqual(record.runtimeIdentity, { distribution: "codex", version: "0.9.2", binaryPath: "C:/x/codex.exe", fingerprint: "v1-feedfacefeedface" });
  assert.equal(validateComponentRecord(record), true, "磁盘校验：subject 指纹重派生键一致");
  // honest unknown 形状：version/binaryPath 可 null，fingerprint 必填。
  const unknown = recordComponentCheck({
    kind: "backend",
    name: "opencode-serve",
    codeRef: "abc123",
    runtimeIdentity: { distribution: "opencode-serve", version: null, binaryPath: null, fingerprint: "unknown-0011223344556677" },
    result: "blocked",
    blockedReason: "fixture-unavailable",
  });
  assert.equal(unknown.runtimeIdentity.version, null);
  assert.throws(() => recordComponentCheck({
    kind: "backend", name: "x", codeRef: "y",
    runtimeIdentity: { distribution: "x", version: "1", fingerprint: "" },
    result: "pass",
  }), /fingerprint.*non-empty/, "空指纹拒绝（两个 unknown 不得合并）");
  // llm 被测没有 harness 探测面 → 显式拒绝。
  assert.throws(() => recordComponentCheck({
    kind: "llm", providerID: "p", modelId: "m", providerKey: null,
    runtimeIdentity: { distribution: "d", version: "1", fingerprint: "f" },
    result: "pass",
  }), /only valid for backend/);
});

test("record【检查五态】: status 进台账且三态必须带原因（缺原因/矛盾 pass 磁盘侧拒绝）", () => {
  const base = { kind: "backend", name: "codex", codeRef: "abc123", result: "pass", fixture: null };
  const withNa = recordComponentCheck({
    ...base,
    checks: [{ name: "commandsPassed", pass: false, state: "not-applicable", stateReason: "declared reportsCommandExitCode=false", detail: "d" }],
  });
  assert.equal(withNa.checks[0].state, "not-applicable");
  assert.equal(withNa.checks[0].stateReason, "declared reportsCommandExitCode=false");
  // 序列化 → 解析往返：五态字段不丢。
  const parsed = parseComponentLedger(serializeComponentLedger(summarizeComponentLedger([withNa])));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ledger.records[0].checks[0].state, "not-applicable");
  // 缺原因 → 拒绝。
  assert.throws(() => recordComponentCheck({
    ...base,
    checks: [{ name: "x", pass: false, state: "not-applicable", detail: "d" }],
  }), /requires a non-empty stateReason/);
  // pass 与 status 矛盾 → 拒绝。
  assert.throws(() => recordComponentCheck({
    ...base,
    checks: [{ name: "x", pass: true, state: "fail", detail: "d" }],
  }), /contradicts state/);
  // 越 closed set 的 status → 拒绝。
  assert.throws(() => recordComponentCheck({
    ...base,
    checks: [{ name: "x", pass: true, state: "certified", detail: "d" }],
  }), /outside the ADR-0032 §8 closed set/);
  // legacy 布尔形状照常落账（无 status 字段）。
  const legacy = recordComponentCheck({ ...base, checks: [{ name: "x", pass: true, detail: "d" }] });
  assert.equal(legacy.checks[0].state, undefined);
});

test("annotateRuntimeDrift: 同 (name, codeRef) 异指纹的历史记录降 runtime-drifted advisory（不删、长度不变）", () => {
  const prior = [
    recordComponentCheck({ kind: "backend", name: "codex", codeRef: "abc123", runtimeIdentity: { distribution: "codex", version: "0.9.0", fingerprint: "v1-old0" }, result: "pass", checks: [{ name: "a", pass: true, detail: "d" }], fixture: null }),
    recordComponentCheck({ kind: "backend", name: "codex", codeRef: "other", runtimeIdentity: { distribution: "codex", version: "0.9.0", fingerprint: "v1-old1" }, result: "pass", checks: [{ name: "a", pass: true, detail: "d" }], fixture: null }),
    recordComponentCheck({ kind: "backend", name: "kimi-code", codeRef: "abc123", runtimeIdentity: { distribution: "kimi", version: "1", fingerprint: "v1-old2" }, result: "pass", checks: [{ name: "a", pass: true, detail: "d" }], fixture: null }),
    recordComponentCheck({ kind: "llm", providerID: "p", modelId: "m", providerKey: null, result: "pass", checks: [{ name: "a", pass: true, detail: "d" }] }),
  ];
  const fresh = [recordComponentCheck({
    kind: "backend", name: "codex", codeRef: "abc123",
    runtimeIdentity: { distribution: "codex", version: "0.9.2", binaryPath: "C:/x/codex.exe", fingerprint: "v1-new0" },
    result: "pass", checks: [{ name: "a", pass: true, detail: "d" }], fixture: null,
  })];
  const annotated = annotateRuntimeDrift(prior, { freshBackendRecords: fresh, at: "2026-09-21T00:00:00.000Z" });
  assert.equal(annotated.length, prior.length, "不删（长度恒不变）");
  assert.equal(annotated[0].advisory?.code, "runtime-drifted", "同 name+codeRef 异指纹 → 漂移 advisory");
  assert.match(annotated[0].advisory.reason, /v1-old0/);
  assert.match(annotated[0].advisory.reason, /v1-new0/);
  assert.match(annotated[0].advisory.reason, /rerun recommended/);
  assert.equal(annotated[0].advisory.at, "2026-09-21T00:00:00.000Z");
  assert.equal(annotated[1].advisory, undefined, "同 name 异 codeRef（键滚动）不属运行时漂移");
  assert.equal(annotated[2].advisory, undefined, "异 name 不受连坐");
  assert.equal(annotated[3].advisory, undefined, "llm 记录不受 backend 漂移连坐");
  // 同指纹 → 不标（正常刷新路径）。
  const sameFp = annotateRuntimeDrift([prior[0]], {
    freshBackendRecords: [recordComponentCheck({
      kind: "backend", name: "codex", codeRef: "abc123",
      runtimeIdentity: { distribution: "codex", version: "0.9.0", fingerprint: "v1-old0" },
      result: "pass", checks: [], fixture: null,
    })],
  });
  assert.equal(sameFp[0].advisory, undefined);
  // legacy 无指纹记录 → 无法证明同运行时 → 如实标漂移。
  const legacyPrior = [recordComponentCheck({ kind: "backend", name: "codex", codeRef: "abc123", result: "pass", checks: [], fixture: null })];
  const legacyAnnotated = annotateRuntimeDrift(legacyPrior, { freshBackendRecords: fresh });
  assert.equal(legacyAnnotated[0].advisory?.code, "runtime-drifted");
  assert.match(legacyAnnotated[0].advisory.reason, /no fingerprint on record/);
});

test("six-states【运行时漂移】: runtime-drifted advisory 的记录消费为 stale（advisory 建议重跑，非红非绿）", () => {
  const drifted = annotateRuntimeDrift(
    [recordComponentCheck({ kind: "backend", name: "codex", codeRef: "abc123", runtimeIdentity: { distribution: "codex", version: "0.9.0", fingerprint: "v1-old0" }, result: "pass", checks: [{ name: "a", pass: true, detail: "d" }], fixture: null })],
    { freshBackendRecords: [recordComponentCheck({ kind: "backend", name: "codex", codeRef: "abc123", runtimeIdentity: { distribution: "codex", version: "0.9.2", fingerprint: "v1-new0" }, result: "pass", checks: [], fixture: null })] },
  )[0];
  const summary = summarizeComponentLedger([drifted]);
  const classification = classifyComponent({ state: "loaded", ledger: summary }, drifted.key, {});
  assert.equal(classification.state, "stale", "运行时漂移复用 stale 态（六态闭集不变）");
  assert.match(classification.reason, /runtime fingerprint drifted/);
  assert.match(classification.reason, /never a certification gate/);
});

test("advisory 闭集: runtime-drifted 进闭集；越闭集码仍拒绝", () => {
  const rec = recordComponentCheck({
    kind: "backend", name: "x", codeRef: "y", result: "pass", checks: [], fixture: null,
    advisory: { code: "runtime-drifted", reason: "r", at: "2026-09-21T00:00:00.000Z" },
  });
  assert.equal(rec.advisory.code, "runtime-drifted");
  assert.throws(() => recordComponentCheck({
    kind: "backend", name: "x", codeRef: "y", result: "pass", checks: [], fixture: null,
    advisory: { code: "stale-runtime", reason: "r" },
  }), /advisory.code closed set/);
});
