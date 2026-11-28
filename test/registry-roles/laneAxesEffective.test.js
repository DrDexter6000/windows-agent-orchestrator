// test/registry-roles/laneAxesEffective.test.js
//
// 第 158a 批：车道四轴唯一出处（config/lanes.json）——合并机制的单元与兼容性
// 机器钉。覆盖任务书第 1/2/6 条：
//   - mergeLaneAxes 按轴覆盖：null/缺席轴不留键、兄弟字段（contextWindow）保留、
//     键序稳定（同一输入逐字节相同）；
//   - "旧实现生效条目 vs 新实现生效条目"的 JSON 兼容：私有四轴与车道表一致的
//     前提下，合并结果与私有原文 JSON 相同（四轴仍在 / 已去四轴 / kimi effort
//     null / contextWindow / deepseek 双字段各一例）；
//   - effectiveRegistryView 的启用契约：null=停用原样返回；启用而表不可用
//     （结构/不可读/四轴不合法）抛 lanes_merge_unavailable；rawEntries 恒原始；
//   - 配对判定（b158a 修复一单一出处）：sameRegistryFile / lanesMergeDocFor /
//     pairedDefaultRegistryPath（win32 大小写不敏感；代码根 config/default.json）；
//   - modelPolicyEqual（键序无关、null≡缺席）——续修比较的 SSOT；
//   - 身份面兼容：车道指纹 / matchedCertRecord 在新旧两侧同值（私有=车道表时）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeLaneAxes,
  effectiveRegistryView,
  validateLaneAxesIssues,
  sameRegistryFile,
  lanesMergeDocFor,
  pairedDefaultRegistryPath,
  mergeRawRegistryDoc,
  effectiveEntriesOf,
  modelPolicyEqual,
  normalizeAgent,
  readRegistry,
} from "../../src/registry.js";
import { matchedCertRecord } from "../../src/runManager.js";
import { validateLanesStructure } from "../../src/dispatchResolution.js";
import { laneFingerprint as laneFingerprintOf } from "../../src/application/identityProjection.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

// ── 夹具：一份结构合法、四轴齐备的车道表（loadLanesConfig 产物同形状） ──────
function lanesDocOf(lanes) {
  return {
    ok: true,
    path: "<fixture>",
    sha256: "f".repeat(64),
    lanes,
    issues: [],
    rolesHint: [],
  };
}
const ZCODE_LANE = {
  id: "glm-pro", backend: "zcode",
  model: { id: "bigmodel-api/GLM-5.3" },
  reasoning: { effort: "max" },
  aliases: {},
};
const KIMI_LANE = {
  id: "kimi", backend: "kimi-web",
  model: { id: "kimi-code/k3.1-pro" },
  reasoning: { effort: null },
  aliases: {},
};
const DSH_LANE = {
  id: "deepseek-pro", backend: "deepseek-acp",
  model: { id: "deepseek-v4-pro", providerID: "deepseek-official" },
  reasoning: { effort: "max" },
  aliases: {},
};

// ── 兼容性：私有四轴与车道表一致 → 合并结果与私有原文 JSON 相同 ──────────────

test("b158a 兼容：私有条目自带四轴（与车道表一致）→ 合并结果 JSON 逐字节相同（含键序）", () => {
  const priv = {
    backend: "zcode", cwd: "D:/w",
    model: { id: "bigmodel-api/GLM-5.3" },
    reasoning: { effort: "max" },
    binary: "D:/z/zcode.cjs",
  };
  const merged = mergeLaneAxes(priv, ZCODE_LANE);
  assert.equal(JSON.stringify(merged), JSON.stringify(priv));
  // 归一化产物（getAgent 的最终形状）也相同
  assert.equal(JSON.stringify(normalizeAgent("glm-pro", merged)), JSON.stringify(normalizeAgent("glm-pro", priv)));
  // 纯函数：不改输入
  assert.equal(JSON.stringify(priv), JSON.stringify({
    backend: "zcode", cwd: "D:/w", model: { id: "bigmodel-api/GLM-5.3" },
    reasoning: { effort: "max" }, binary: "D:/z/zcode.cjs",
  }));
});

test("b158a 兼容：私有条目已去四轴 → 合并结果等于带四轴的完整形状（值级一致）", () => {
  const privStripped = { cwd: "D:/w", binary: "D:/z/zcode.cjs" };
  const full = {
    backend: "zcode", cwd: "D:/w",
    model: { id: "bigmodel-api/GLM-5.3" },
    reasoning: { effort: "max" },
    binary: "D:/z/zcode.cjs",
  };
  const merged = mergeLaneAxes(privStripped, ZCODE_LANE);
  assert.deepEqual(merged, full);
  // "旧实现生效条目"（迁移前私有自带四轴）与"新实现生效条目"（去四轴私有 +
  // 车道表合并）值级一致；下游比较面（谱系指纹/认证身份/续修 modelPolicyEqual）
  // 全部按字段取值，不受轴键追加序影响。
  assert.equal(modelPolicyEqual(merged.model, full.model), true);
  assert.equal(merged.backend, full.backend);
  assert.equal(merged.reasoning.effort, full.reasoning.effort);
  assert.doesNotThrow(() => normalizeAgent("glm-pro", merged));
});

test("b158a 兼容：kimi 车道 effort=null → 合并结果不带 reasoning 键", () => {
  // 旧实现里 kimi 私有条目不可能带 reasoning（effort:null 过不了旧校验），
  // 去四轴后的合并结果同样不带——两侧生效条目值级相同。
  const privOld = {
    backend: "kimi-web", cwd: "D:/w", serveUrl: "http://127.0.0.1:58630",
    tokenEnv: "KIMI_TOKEN", model: { id: "kimi-code/k3.1-pro" },
  };
  const privStripped = { cwd: "D:/w", serveUrl: "http://127.0.0.1:58630", tokenEnv: "KIMI_TOKEN" };
  const merged = mergeLaneAxes(privStripped, KIMI_LANE);
  assert.equal(!("reasoning" in merged), true, "effort=null 不留键");
  assert.deepEqual(merged, privOld);
  // 私有残留 effort 也会被车道表清掉（车道表赢）
  const privStale = { ...privStripped, reasoning: { effort: "high" } };
  const mergedStale = mergeLaneAxes(privStale, KIMI_LANE);
  assert.equal(!("reasoning" in mergedStale), true);
});

test("b158a 兼容：model.contextWindow 等兄弟字段原样保留", () => {
  const priv = {
    backend: "zcode", cwd: "D:/w",
    model: { contextWindow: 128000, id: "bigmodel-api/GLM-5.3" },
    reasoning: { effort: "max" },
  };
  const merged = mergeLaneAxes(priv, ZCODE_LANE);
  assert.equal(merged.model.contextWindow, 128000);
  assert.equal(JSON.stringify(merged), JSON.stringify(priv), "兄弟字段在场时合并仍逐字节相同");
  // 去四轴私有 + contextWindow 保留
  const merged2 = mergeLaneAxes({ cwd: "D:/w", model: { contextWindow: 128000 } }, ZCODE_LANE);
  assert.deepEqual(merged2, {
    cwd: "D:/w", backend: "zcode",
    model: { contextWindow: 128000, id: "bigmodel-api/GLM-5.3" },
    reasoning: { effort: "max" },
  });
});

test("b158a 兼容：deepseek 双字段 model（id + providerID）逐字节相同；providerID 缺席侧补齐", () => {
  const priv = {
    backend: "deepseek-acp", cwd: "D:/w", credentialEnv: "DEEPSEEK_API_KEY",
    model: { id: "deepseek-v4-pro", providerID: "deepseek-official" },
    reasoning: { effort: "max" },
  };
  assert.equal(JSON.stringify(mergeLaneAxes(priv, DSH_LANE)), JSON.stringify(priv));
  const merged = mergeLaneAxes(
    { cwd: "D:/w", credentialEnv: "DEEPSEEK_API_KEY" },
    DSH_LANE,
  );
  assert.deepEqual(merged, priv);
});

test("b158a 键序稳定：同一输入合并两次逐字节相同；私有键序保留（轴赋值不移动既有键位）", () => {
  const priv = { cwd: "D:/w", env: { A: "1" }, binary: "D:/z/zcode.cjs" };
  const a = mergeLaneAxes(priv, ZCODE_LANE);
  const b = mergeLaneAxes(priv, ZCODE_LANE);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(Object.keys(a), ["cwd", "env", "binary", "backend", "model", "reasoning"],
    "新键按固定序（backend → model → reasoning）追加在私有键之后");
});

test("b158a 占位 null：私有 providerID:null + 车道表缺席 → 键删除（与 align 写侧的无占位 null 纪律一致）", () => {
  const merged = mergeLaneAxes({ backend: "zcode", cwd: "D:/w", model: { id: "bigmodel-api/GLM-5.3", providerID: null } }, ZCODE_LANE);
  assert.equal(!("providerID" in merged.model), true);
  // null≡缺席：续修比较不受这一差异影响（见 modelPolicyEqual 用例）
  assert.equal(modelPolicyEqual({ id: "x", providerID: null }, { id: "x" }), true);
});

// ── effectiveRegistryView：启用契约与具名拒绝 ────────────────────────────────

function objectRegistry(agents) {
  return {
    listAgents() {
      return Object.entries(agents).map(([id, a]) => normalizeAgent(id, a));
    },
    getAgent(id, overrides = {}) {
      if (!agents[id]) throw new Error(`Unknown agent: ${id}`);
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      return normalizeAgent(id, { ...agents[id], ...defined });
    },
    rawEntries() {
      return Object.entries(agents);
    },
  };
}

test("b158a 视图：lanesDoc=null 原样返回（停用）；rawEntries 恒原始视图", () => {
  const priv = { backend: "zcode", cwd: "D:/w", binary: "D:/z/zcode.cjs", reasoning: { effort: "low" } };
  const reg = objectRegistry({ "glm-pro": priv });
  const view = effectiveRegistryView(reg, null);
  assert.equal(view, reg, "停用时零包装");
  const wrapped = effectiveRegistryView(reg, lanesDocOf([ZCODE_LANE]));
  // 生效：车道表 effort=max 覆盖私有 low
  assert.equal(wrapped.getAgent("glm-pro").reasoning.effort, "max");
  // 原始：诊断面看到私有残留 low
  assert.equal(wrapped.rawEntries()[0][1].reasoning.effort, "low");
  // mergedRawEntries：自行逐条 normalize 的面用
  assert.equal(wrapped.mergedRawEntries()[0][1].reasoning.effort, "max");
});

test("b158a 拒绝：表结构不合法（ok:false）→ lanes_merge_unavailable，指向 config/lanes.json", () => {
  const bad = { ...lanesDocOf([]), ok: false, issues: ["schema 必须为 2"] };
  assert.throws(
    () => effectiveRegistryView(objectRegistry({}), bad),
    (e) => String(e.message).startsWith("lanes_merge_unavailable") && String(e.message).includes("config/lanes.json"),
  );
});

test("b158a 拒绝：表文件缺失/不可读（sha256:null）→ lanes_merge_unavailable（不回退私有旧四轴）", () => {
  const missing = { ...lanesDocOf([]), sha256: null };
  assert.throws(
    () => effectiveRegistryView(objectRegistry({ "glm-pro": { backend: "zcode", cwd: "D:/w" } }), missing),
    (e) => String(e.message).includes("不能回退私有注册表"),
  );
});

test("b158a 拒绝：四轴本身不合法（backend 闭集外 / model.id 空 / effort 闭集外）→ lanes_merge_unavailable", () => {
  const badBackend = lanesDocOf([{ ...ZCODE_LANE, backend: "no-such-backend" }]);
  assert.ok(validateLaneAxesIssues(badBackend).length === 1);
  assert.throws(() => effectiveRegistryView(objectRegistry({}), badBackend), /lanes_merge_unavailable/);

  const badModelId = lanesDocOf([{ ...ZCODE_LANE, model: { id: "" } }]);
  assert.ok(validateLaneAxesIssues(badModelId).length === 1);
  assert.throws(() => effectiveRegistryView(objectRegistry({}), badModelId), /lanes_merge_unavailable/);

  const noModel = lanesDocOf([{ ...ZCODE_LANE, model: undefined }]);
  assert.ok(validateLaneAxesIssues(noModel).length === 1, "model.id 必填");

  const badEffort = lanesDocOf([{ ...ZCODE_LANE, reasoning: { effort: "extreme" } }]);
  assert.ok(validateLaneAxesIssues(badEffort).length === 1);
  assert.throws(() => effectiveRegistryView(objectRegistry({}), badEffort), /lanes_merge_unavailable/);

  assert.deepEqual(validateLaneAxesIssues(lanesDocOf([ZCODE_LANE, KIMI_LANE, DSH_LANE])), []);
});

test("b158a 视图：getAgent 的 Unknown agent 语义与覆盖序（overrides 在合并之后生效）", () => {
  const priv = { cwd: "D:/w", binary: "D:/z/zcode.cjs" };
  const reg = objectRegistry({ "glm-pro": priv, custom: { backend: "codex", cwd: "D:/c", model: { id: "gpt" } } });
  const view = effectiveRegistryView(reg, lanesDocOf([ZCODE_LANE]));
  assert.throws(() => view.getAgent("nope"), /Unknown agent: nope/);
  // 单次 --model 覆盖在合并之后
  assert.equal(view.getAgent("glm-pro", { model: { id: "bigmodel-api/OTHER" } }).model.id, "bigmodel-api/OTHER");
  // 非车道键条目照旧自包含
  assert.equal(view.getAgent("custom").model.id, "gpt");
  // listAgents 走生效条目（去四轴私有可用）
  const ids = view.listAgents().map((a) => a.id).sort();
  assert.deepEqual(ids, ["custom", "glm-pro"]);
});

test("b158a 修复一 配对：sameRegistryFile（同一文件=启用；外来=停用；win32 大小写不敏感）", () => {
  assert.equal(sameRegistryFile("D:/w/config/agents.json", "D:/w/config/agents.json"), true);
  assert.equal(sameRegistryFile("D:/w2/config/agents.json", "D:/w/config/agents.json"), false, "真正的外部文件停用");
  // 同一文件只差大小写（Windows 文件系统大小写不敏感；resolve 保留原拼写，
  // 字符串直比会判错）——两种拼写都判"同一文件"。
  assert.equal(sameRegistryFile("d:/w/CONFIG/Agents.json", "D:/w/config/agents.json"), true,
    process.platform === "win32" ? "win32 大小写异拼写=同一文件" : "非 win32 仍按字面（本仓在 win32 跑）");
  assert.equal(sameRegistryFile("D:/w/config/../config/agents.json", "D:/w/config/agents.json"), true, "解析规范化后相等");
});

test("b158a 修复一 配对：lanesMergeDocFor（同一文件→读表；外来→null；不依赖 cwd）", () => {
  const doc = { ok: true, sha256: "a".repeat(64), lanes: [], issues: [], rolesHint: [] };
  const loadFn = () => doc;
  assert.equal(lanesMergeDocFor("D:/w/config/agents.json", "D:/w/config/agents.json", loadFn), doc);
  assert.equal(lanesMergeDocFor("D:/w2/agents.json", "D:/w/config/agents.json", loadFn), null);
  // 大小写异拼写也启用
  assert.equal(lanesMergeDocFor("d:/w/config/agents.json".toUpperCase() === "D:/W/CONFIG/AGENTS.JSON" ? "D:/W/CONFIG/AGENTS.JSON" : "D:/W/config/agents.json", "D:/w/config/agents.json", loadFn), doc);
});

test("b158a 修复一：pairedDefaultRegistryPath 读代码根 config/default.json 的 registry（相对按代码根），缺省回落", () => {
  const mk = (dir, files) => {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
  };
  const rootA = mkdtempSync(join(tmpdir(), "wao-pd-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "wao-pd-b-"));
  try {
    mk(join(rootA, "config"), { "default.json": JSON.stringify({ registry: "custom/agents.custom.json" }) });
    assert.equal(pairedDefaultRegistryPath(rootA), join(rootA, "custom/agents.custom.json"), "相对键按代码根解析");
    // 绝对键原样
    mk(join(rootB, "config"), { "default.json": JSON.stringify({ registry: join(rootB, "abs/agents.json") }) });
    assert.equal(pairedDefaultRegistryPath(rootB), join(rootB, "abs/agents.json"));
    // 无配置文件 → 回落 config/agents.json
    const rootC = mkdtempSync(join(tmpdir(), "wao-pd-c-"));
    try {
      assert.equal(pairedDefaultRegistryPath(rootC), join(rootC, "config", "agents.json"));
    } finally { rmSync(rootC, { recursive: true, force: true }); }
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

// ── 身份面兼容：谱系指纹 / 认证身份在合并前后同值（私有=车道表前提） ─────────

test("b158a 身份兼容：车道指纹与 matchedCertRecord 新旧两侧同值（run.started 接线/认证身份不变）", () => {
  const privFull = {
    backend: "deepseek-acp", cwd: "D:/w", credentialEnv: "DEEPSEEK_API_KEY",
    model: { id: "deepseek-v4-pro", providerID: "deepseek-official" },
    reasoning: { effort: "max" },
  };
  const merged = mergeLaneAxes(
    { cwd: "D:/w", credentialEnv: "DEEPSEEK_API_KEY" },
    DSH_LANE,
  );
  const identity = (a) => ({
    backend: a.backend, modelId: a.model?.id ?? null,
    providerID: a.model?.providerID ?? null, providerKey: null,
  });
  assert.equal(laneFingerprintOf(identity(merged)), laneFingerprintOf(identity(privFull)));
  const record = {
    backend: "deepseek-acp", modelId: "deepseek-v4-pro",
    providerID: "deepseek-official", status: "certified",
  };
  assert.equal(matchedCertRecord(normalizeAgent("deepseek-pro", merged), record), record);
  assert.equal(matchedCertRecord(normalizeAgent("deepseek-pro", privFull), record), record);
});

// ── modelPolicyEqual：续修的按字段比较 SSOT ────────────────────────────────

test("b158a modelPolicyEqual：键序无关；缺键≡null；逐字段比值；null/非对象归一", () => {
  assert.equal(modelPolicyEqual({ id: "m", contextWindow: 128000 }, { contextWindow: 128000, id: "m" }), true, "键序无关（旧 JSON.stringify 比较在此误判）");
  assert.equal(modelPolicyEqual({ id: "m" }, { id: "m", providerID: null }), true, "null≡缺席");
  assert.equal(modelPolicyEqual({ id: "m" }, { id: "m", providerID: "p" }), false);
  assert.equal(modelPolicyEqual({ id: "m", contextWindow: 1 }, { id: "m", contextWindow: 2 }), false);
  assert.equal(modelPolicyEqual(undefined, null), true);
  assert.equal(modelPolicyEqual(undefined, { id: "m" }), false);
  assert.equal(modelPolicyEqual({ id: "m" }, null), false);
});

// ── b158a 修复一：validateLaneAxesIssues 补三项 + 缺 lanes + 句柄契约 ────────

test("b158a 修复一：providerID 非法形状（数字/空串）与 reasoning 标量都算四轴不合法", () => {
  const badProvider = lanesDocOf([{ ...ZCODE_LANE, model: { id: "bigmodel-api/GLM-5.3", providerID: 123 } }]);
  assert.ok(validateLaneAxesIssues(badProvider).length === 1, "数字 providerID 拒");
  const emptyProvider = lanesDocOf([{ ...ZCODE_LANE, model: { id: "bigmodel-api/GLM-5.3", providerID: "" } }]);
  assert.ok(validateLaneAxesIssues(emptyProvider).length === 1, "空串 providerID 拒");
  assert.throws(() => effectiveRegistryView(objectRegistry({}), badProvider), /lanes_merge_unavailable/);
  const scalarReasoning = lanesDocOf([{ ...ZCODE_LANE, reasoning: "max" }]);
  assert.ok(validateLaneAxesIssues(scalarReasoning).length === 1, "reasoning 标量拒（不静默丢 effort）");
  assert.throws(() => effectiveRegistryView(objectRegistry({}), scalarReasoning), /lanes_merge_unavailable/);
  // 合法形状：providerID 字符串/null、reasoning 对象/缺席
  assert.deepEqual(validateLaneAxesIssues(lanesDocOf([
    { ...ZCODE_LANE, model: { id: "x", providerID: "p" } },
    { ...ZCODE_LANE, reasoning: undefined },
  ])), []);
});

test("b158a 修复二：reasoning: null 判不合法（只允许对象或缺席）", () => {
  const doc = lanesDocOf([{ ...ZCODE_LANE, reasoning: null }]);
  assert.equal(validateLaneAxesIssues(doc).length, 1, "显式 null 与任务书『对象或缺席』不符");
  assert.throws(() => effectiveRegistryView(objectRegistry({}), doc), /lanes_merge_unavailable/);
  // 缺席仍合法。
  assert.deepEqual(validateLaneAxesIssues(lanesDocOf([{ ...ZCODE_LANE, reasoning: undefined }])), []);
});

test("b158a 修复一：缺 lanes 数组（如只有 {\"schema\":2}）= 不合法；显式 lanes: [] 合法", () => {
  assert.ok(validateLanesStructure({ schema: 2 }).length > 0, "缺 lanes 数组=结构 issue");
  assert.deepEqual(validateLanesStructure({ schema: 2, lanes: [] }), [], "显式 lanes: [] 合法");
  // 经 loadLanesConfig 形状走 effectiveRegistryView：缺 lanes 文档 → lanes_merge_unavailable
  assert.throws(
    () => effectiveRegistryView(objectRegistry({}), { ok: false, sha256: "a".repeat(64), lanes: [], issues: validateLanesStructure({ schema: 2 }), rolesHint: [] }),
    /lanes 数组缺席/,
  );
});

// ── b158a 修复一：句柄契约（先表后句柄） ────────────────────────────────────

test("b158a 修复一：启用合并而句柄无 rawEntries() → 内部契约报错（不静默返回）", () => {
  const noRaw = { listAgents: () => [], getAgent: () => { throw new Error("x"); } };
  assert.throws(
    () => effectiveRegistryView(noRaw, lanesDocOf([ZCODE_LANE])),
    /lacks rawEntries/,
  );
  // 表本身不合法时，表错误优先于句柄错误（先表后句柄）
  assert.throws(
    () => effectiveRegistryView(noRaw, { ...lanesDocOf([]), ok: false, issues: ["schema 必须为 2"] }),
    /lanes_merge_unavailable/,
  );
});

// ── b158a 修复一：modelPolicyEqual 递归 ─────────────────────────────────────

test("b158a 修复一：modelPolicyEqual 递归——嵌套键序无关、每层 null≡缺键、数组保序", () => {
  assert.equal(modelPolicyEqual({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }), true, "嵌套键序无关（旧实现 JSON.stringify 在此误判）");
  assert.equal(modelPolicyEqual({ a: { x: null } }, { a: {} }), true, "每层 null≡缺键");
  assert.equal(modelPolicyEqual({ a: [1, 2] }, { a: [2, 1] }), false, "数组保持顺序");
  assert.equal(modelPolicyEqual({ a: [1, { b: 1, c: 2 }] }, { a: [1, { c: 2, b: 1 }] }), true);
  assert.equal(modelPolicyEqual({ a: 1 }, { a: "1" }), false, "标量类型敏感");
});

// ── b158a 修复一：收拢函数 mergeRawRegistryDoc / effectiveEntriesOf ──────────

test("b158a 修复一：mergeRawRegistryDoc（agents 合并、其余键原样）+ effectiveEntriesOf", () => {
  const rawDoc = {
    agents: { "glm-pro": { cwd: "D:/w" }, custom: { backend: "codex", cwd: "D:/c" } },
    certification: { matrix: [{ agentId: "glm-pro" }] },
  };
  const merged = mergeRawRegistryDoc(rawDoc, lanesDocOf([ZCODE_LANE]));
  assert.equal(merged.agents["glm-pro"].backend, "zcode", "车道键合并");
  assert.equal(merged.agents.custom.backend, "codex", "非车道键原样");
  assert.deepEqual(merged.certification, rawDoc.certification, "其余键原样");
  assert.equal(mergeRawRegistryDoc(rawDoc, null), rawDoc, "停用原样");
  // effectiveEntriesOf：有 mergedRawEntries 用它，否则 rawEntries
  const view = effectiveRegistryView(objectRegistry(rawDoc.agents), lanesDocOf([ZCODE_LANE]));
  const entries = effectiveEntriesOf(view);
  assert.equal(Object.fromEntries(entries)["glm-pro"].backend, "zcode");
  assert.equal(effectiveEntriesOf(objectRegistry(rawDoc.agents))[0][0], "glm-pro", "未包装句柄回退 rawEntries");
});

// ── 真实文件面：readRegistry（未包装）与生效视图组合 ─────────────────────────

test("b158a 文件面：临时注册表 + 生效视图（外部注册表遇同名车道 → 停用时不合并）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b158a-"));
  try {
    const registryPath = join(dir, "agents.json");
    // 同名车道 glm-pro，但这是外部注册表（调用方传 lanesDoc=null 停用合并）——
    // 条目必须自带四轴，行为与旧实现一致。
    writeFileSync(registryPath, JSON.stringify({
      agents: { "glm-pro": { backend: "zcode", cwd: dir, binary: "D:/z/zcode.cjs", model: { id: "bigmodel-api/GLM-5.3" } } },
    }, null, 2));
    const raw = await readRegistry(registryPath);
    const disabled = effectiveRegistryView(raw, null);
    assert.equal(disabled, raw);
    assert.equal(disabled.getAgent("glm-pro").model.id, "bigmodel-api/GLM-5.3");
    // 启用合并（同一注册表路径、同名车道）：车道表赢（换 effort）
    const enabled = effectiveRegistryView(raw, lanesDocOf([{ ...ZCODE_LANE, reasoning: { effort: "low" } }]));
    assert.equal(enabled.getAgent("glm-pro").reasoning.effort, "low");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
