// test/migration-0045/dispatchResolution.test.js
//
// 0045 写侧第一增量 W1 单元测试：lanes.json 结构守卫（G1/G2）+ 跨文件绑定校验 +
// 派发目标解析（二选一闭集/别名注解/严格轴比对/错误形状三原则）+ wiringAgent
// 过渡绊线。R3 会审（consult_20261005185623675eln792）裁定语义的机器钉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ID_RE, RESOLVED_FROM, DISPATCH_ERROR_CODES,
  loadLanesConfig, validateLanesStructure, validateLanesAgainstRegistry, resolveDispatchTarget,
} from "../../src/dispatchResolution.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const LIVE = loadLanesConfig();
const ROLES = readdirSync(join(REPO_ROOT, "config", "roles"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.slice(0, -3));
// 注册表结构投影：干净检出无私有 config/agents.json（gitignored，R4 auditor_claude
// 实证旧写法在隔离 worktree ENOENT 全红）——入库 fixture 为默认，私有件在场时
// 活体跨文件校验另测（skip-if-absent 显式标注）。
function readRegistryProjection() {
  try {
    const doc = JSON.parse(readFileSync(join(REPO_ROOT, "config", "agents.json"), "utf8"));
    return { source: "live", agents: doc.agents };
  } catch {
    const doc = JSON.parse(readFileSync(join(REPO_ROOT, "test", "fixtures", "lanes-agents.fixture.json"), "utf8"));
    return { source: "fixture", agents: doc.agents };
  }
}
const REGISTRY_PROJECTION = readRegistryProjection();
const REG = Object.fromEntries(Object.entries(REGISTRY_PROJECTION.agents).map(([id, a]) => [id, {
  backend: a.backend, model: a.model, reasoning: a.reasoning, systemPrompt: a.systemPrompt,
}]));

// ── 活体基线钉（G7 冻结快照：改 lanes.json 必须同 diff 看到这里） ────────────

test("W1 活体：config/lanes.json 8 车道/9 别名/6 角色，结构零 issue", () => {
  assert.ok(LIVE.ok, `结构 issues 必须为空，实际：${JSON.stringify(LIVE.issues)}`);
  assert.equal(LIVE.lanes.length, 8);
  const aliases = LIVE.lanes.flatMap((l) => Object.keys(l.aliases ?? {}));
  assert.equal(aliases.length, 9);
  assert.equal(new Set(aliases).size, 9, "别名全局唯一（G2）");
  assert.deepEqual(LIVE.rolesHint.sort(), ["auditor", "coder_hq", "coder_low", "coder_mm", "researcher", "tester"]);
});

test("W1 活体：与真实注册表跨文件校验零 issue（alias 轴不一致只 WARN）", () => {
  const { issues, warns } = validateLanesAgainstRegistry(LIVE, REG);
  assert.deepEqual(issues, [], `硬 issue 必须为空：${JSON.stringify(issues)}`);
  // 本机 9 席全在册且轴一致 → warns 也应为空；换机/模板机才会出现 WARN（H2）
  assert.deepEqual(warns, []);
});

test("W1 闭集钉：RESOLVED_FROM / DISPATCH_ERROR_CODES / ID_RE", () => {
  assert.deepEqual([...RESOLVED_FROM], ["alias", "explicit", "legacy-agent"]);
  assert.deepEqual([...DISPATCH_ERROR_CODES], [
    "unknown_lane", "unknown_role", "dispatch_selector_invalid", "unknown_agent",
    "lane_wiring_mismatch", "lanes_config_invalid",
  ]);
  assert.ok(ID_RE.test("glm-flash"));
  assert.ok(!ID_RE.test("GLM_Flash"), "大写/下划线不进字母表");
  assert.ok(!ID_RE.test("../etc/passwd"), "路径穿越形不进字母表（received 回显白名单同此）");
});

// ── R4 守卫加固 ────────────────────────────────────────────────────────────

test("W3a 映射冻结（R4 红队'标签互换'防御）：laneId→轴/wiringAgent/别名→role 全结构快照", () => {
  // 任何改绑（含内容对调保 id 原位的标签互换攻击）都会改变此快照——改绑必须
  // 同 diff 更新本钉，评审可见。
  const snapshot = LIVE.lanes.map((l) => ({
    id: l.id, backend: l.backend, modelId: l.model?.id ?? null,
    effort: l.reasoning?.effort ?? null, wiringAgent: l.wiringAgent,
    aliases: Object.fromEntries(Object.entries(l.aliases ?? {}).map(([a, s]) => [a, s.role])),
  })).sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(snapshot, [
    { id: "claude-opus", backend: "claude-code", modelId: "claude-opus-5-5", effort: "xhigh", wiringAgent: "auditor_claude", aliases: { auditor_claude: "auditor" } },
    { id: "ds-acp", backend: "deepseek-acp", modelId: null, effort: null, wiringAgent: "coder_low_dsh", aliases: { coder_low_dsh: "coder_low" } },
    { id: "glm-flash", backend: "zcode", modelId: "bigmodel-api/GLM-5.3-Flash", effort: "high", wiringAgent: "coder_low", aliases: { coder_low: "coder_low", researcher: "researcher" } },
    { id: "glm-pro", backend: "zcode", modelId: "bigmodel-api/GLM-5.3", effort: "high", wiringAgent: "coder_hq", aliases: { coder_hq: "coder_hq" } },
    { id: "gpt-astra", backend: "codex", modelId: "gpt-6-astra", effort: "xhigh", wiringAgent: "auditor", aliases: { auditor: "auditor" } },
    { id: "gpt-sol-56", backend: "codex", modelId: "gpt-5.6-sol", effort: "xhigh", wiringAgent: "tester", aliases: { tester: "tester" } },
    { id: "gpt-sol-61", backend: "codex", modelId: "gpt-6.1-sol", effort: "xhigh", wiringAgent: "coder_temp", aliases: { coder_temp: "coder_low" } },
    { id: "kimi-k3", backend: "kimi-web", modelId: "kimi-code/k3-256k", effort: null, wiringAgent: "coder_mm", aliases: { coder_mm: "coder_mm" } },
  ]);
});

test("W3a 守卫消费（R4）：结构 issues——explicit 整表拒 lanes_config_invalid；alias 降级", () => {
  const badDoc = { ...LIVE, issues: ["lane id \"x\" 重复"] };
  const explicit = R({ lanesDoc: badDoc, lane: "glm-flash", role: "researcher" });
  assert.equal(explicit.kind, "error");
  assert.equal(explicit.code, "lanes_config_invalid");
  assert.match(explicit.message, /整表拒绝/);
  const alias = R({ lanesDoc: badDoc, agentId: "researcher" });
  assert.equal(alias.kind, "resolved");
  assert.equal(alias.source, "legacy-agent", "alias 侧结构坏表降级零破坏");
});

test("W3a 别名角色一致性（R4）：注记 role 与注册表 systemPrompt stem 不符 → 降级", () => {
  // 构造注记撒谎形：researcher 别名注记 tester，实际 systemPrompt=researcher.md
  const doctored = JSON.parse(readFileSync(join(REPO_ROOT, "config", "lanes.json"), "utf8"));
  doctored.lanes.find((l) => l.id === "glm-flash").aliases.researcher = { role: "tester" };
  const doc = { ...LIVE, lanes: doctored.lanes };
  const r = R({ lanesDoc: doc, agentId: "researcher" });
  assert.equal(r.source, "legacy-agent", "注记 roleId 与实际角色不符 → 降级（防 roleId/rolePin 自相矛盾）");
});

test("W3a 跨文件活体校验（私有注册表在场时；干净检出显式 skip）", { skip: REGISTRY_PROJECTION.source !== "live" }, () => {
  const { issues, warns } = validateLanesAgainstRegistry(LIVE, REG);
  assert.deepEqual(issues, []);
  assert.deepEqual(warns, []);
});

// ── 解析：二选一闭集（八种参数组合） ────────────────────────────────────────

const R = (over = {}) => resolveDispatchTarget({
  lanesDoc: LIVE, registryAgents: REG, roleLibrary: ROLES, ...over,
});

test("W1 解析：alias 命中——researcher → {laneId glm-flash, roleId researcher, 注解不执行}", () => {
  const r = R({ agentId: "researcher" });
  assert.equal(r.kind, "resolved");
  assert.equal(r.source, "alias");
  assert.equal(r.agentId, "researcher", "执行席位仍是 registry 原条目（H1 注解不执行）");
  assert.equal(r.laneId, "glm-flash");
  assert.equal(r.roleId, "researcher");
  assert.equal(r.wiringAgent, "coder_low");
  assert.equal(r.lanesSha256, LIVE.sha256);
});

test("W1 解析：legacy-agent——在册但不在车道表（或缺席轴一致）→ 注解缺席零破坏", () => {
  const r = R({ agentId: "researcher", lanesDoc: { lanes: [], sha256: "x" } });
  assert.equal(r.source, "legacy-agent");
  assert.equal(r.laneId, null);
});

test("W1 解析：explicit lane+role → wiringAgent 执行 + 身份注记", () => {
  const r = R({ lane: "claude-opus", role: "tester" });
  assert.equal(r.kind, "resolved");
  assert.equal(r.source, "explicit");
  assert.equal(r.agentId, "auditor_claude", "接线席位（过渡）");
  assert.equal(r.laneId, "claude-opus");
  assert.equal(r.roleId, "tester");
});

test("W1 解析：八种输入组合的闭集判定（混用/缺半/全空/空串冒充）", () => {
  assert.equal(R({ agentId: "researcher", lane: "glm-flash", role: "researcher" }).code, "dispatch_selector_invalid");
  assert.equal(R({ agentId: "researcher", role: "researcher" }).code, "dispatch_selector_invalid");
  assert.equal(R({ lane: "glm-flash" }).code, "dispatch_selector_invalid");
  assert.equal(R({ role: "researcher" }).code, "dispatch_selector_invalid");
  assert.equal(R({}).code, "dispatch_selector_invalid");
  assert.equal(R({ lane: "", role: "" }).code, "dispatch_selector_invalid", "空串不许 truthy 冒充未提供");
  assert.equal(R({ agentId: "" }).code, "dispatch_selector_invalid");
  assert.equal(R({ agentId: null, lane: null, role: null }).code, "dispatch_selector_invalid");
});

// ── 错误形状三原则 ──────────────────────────────────────────────────────────

test("W1 错误：unknown_lane/unknown_role/unknown_agent——码+received 回显白名单+完整 choices", () => {
  const lane = R({ lane: "glm-flsh", role: "researcher" });
  assert.equal(lane.code, "unknown_lane");
  assert.equal(lane.received.lane, "glm-flsh");
  assert.deepEqual(lane.choices.lanes, LIVE.lanes.map((l) => l.id).sort(), "合法 lane 全集（不截断冒充全集）");
  const role = R({ lane: "glm-flash", role: "reviewer" });
  assert.equal(role.code, "unknown_role");
  assert.deepEqual(role.choices.roles, ["auditor", "coder_hq", "coder_low", "coder_mm", "researcher", "tester"]);
  const agent = R({ agentId: "ghost" });
  assert.equal(agent.code, "unknown_agent");
  assert.ok(Array.isArray(agent.choices.aliases) && agent.choices.aliases.includes("researcher"));
  // 非规范字符：received 换固定标记不透传（安全形状纪律）
  const evil = R({ lane: "../etc/passwd", role: "researcher" });
  assert.equal(evil.code, "unknown_lane");
  assert.equal(evil.received.lane, "<未回显：非规范字符>");
});

test("W1 错误：lane_wiring_mismatch——改 lanes.json 模型/力度（G4 注册表赢即拒）", () => {
  const doctored = JSON.parse(readFileSync(join(REPO_ROOT, "config", "lanes.json"), "utf8"));
  doctored.lanes.find((l) => l.id === "glm-flash").model = { id: "bigmodel-api/GLM-5.3" }; // 降智攻击形
  const doc = { ...LIVE, lanes: doctored.lanes };
  const r = R({ lanesDoc: doc, lane: "glm-flash", role: "researcher" });
  assert.equal(r.kind, "error");
  assert.equal(r.code, "lane_wiring_mismatch");
  assert.match(r.message, /注册表为准/);
  // effort 维同拒（auditor R3：不许展示一值执行另一值）
  const doctored2 = JSON.parse(readFileSync(join(REPO_ROOT, "config", "lanes.json"), "utf8"));
  doctored2.lanes.find((l) => l.id === "glm-flash").reasoning = { effort: "xhigh" };
  const r2 = R({ lanesDoc: { ...LIVE, lanes: doctored2.lanes }, lane: "glm-flash", role: "researcher" });
  assert.equal(r2.code, "lane_wiring_mismatch");
});

// ── 结构守卫（G1/G2 负例，直接打真校验器 validateLanesStructure） ────────────

test("W1 守卫：未知键/重复 lane id/别名双挂/wiringAgent 双引用/同轴重复/非法别名值 → 整文件拒", () => {
  const v = (doc) => validateLanesStructure(doc);
  const base = { id: "t1", backend: "zcode", model: { id: "m" }, reasoning: { effort: "high" }, wiringAgent: "coder_low", aliases: { coder_low: { role: "coder_low" } } };
  assert.ok(v({ schema: 1, lanes: [{ ...base, evilKey: 1 }] }).length > 0, "未知键拒（G1）");
  assert.ok(v({ schema: 1, lanes: [base, { ...base }] }).length > 0, "重复 lane id 拒");
  assert.ok(v({ schema: 1, lanes: [base, { ...base, id: "t2", wiringAgent: "researcher" }] }).length > 0, "别名跨车道双挂拒（G2 劫持面）");
  assert.ok(v({ schema: 1, lanes: [base, { ...base, id: "t2", aliases: {} }] }).length > 0, "公开轴三元组重复拒（G2）");
  assert.ok(v({ schema: 1, lanes: [base, { ...base, id: "t2", aliases: {}, backend: "codex" }] }).length > 0, "wiringAgent 双引用拒");
  assert.ok(v({ schema: 1, lanes: [{ ...base, aliases: { x: { role: "r", extra: 1 } } }] }).length > 0, "别名值只允许 {role}（G3）");
  assert.ok(v({ schema: 2, lanes: [] }).length > 0, "schema 版本拒");
  assert.deepEqual(v({ schema: 1, lanes: [base] }), [], "合法形状零 issue");
});

test("W1 绊线：wiringAgent 是过渡字段——package.json 升 0.3.0 后 lanes.json 仍含它即红（G8）", async () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const version = pkg.version;
  const hasWiring = LIVE.lanes.some((l) => typeof l.wiringAgent === "string");
  if (version.startsWith("0.3")) {
    assert.ok(!hasWiring, "0.3.0 发布时 wiringAgent 必须已退役（0045 §6 第 3 步收口；auditor_claude G8 绊线）");
  } else {
    assert.ok(hasWiring, "过渡期（<0.3.0）wiringAgent 应在（此钉在版本翻 0.3.0 时自动翻转为退役强制）");
  }
});

test("W1 census：wiringAgent 字面量只许出现在解析器/配置/测试（防扩散钉）", () => {
  const allowed = new Set([
    "src/dispatchResolution.js", "config/lanes.json",
    "test/migration-0045/dispatchResolution.test.js",
    "src/runManager.js", "src/application/runDispatch.js", "src/commands/run.js", // W2 穿线点
  ]);
  const hits = [];
  for (const dir of ["src", "scripts"]) {
    for (const f of readdirSync(join(REPO_ROOT, dir), { recursive: true })) {
      const p = String(f).replace(/\\/g, "/");
      if (!p.endsWith(".js") && !p.endsWith(".mjs")) continue;
      const content = readFileSync(join(REPO_ROOT, dir, p), "utf8");
      if (content.includes("wiringAgent")) hits.push(`${dir}/${p}`);
    }
  }
  for (const h of hits) assert.ok(allowed.has(h), `wiringAgent 字面量越界：${h}（census 钉，新增消费点须扩 allowlist 并注明角色）`);
});
