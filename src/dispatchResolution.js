// src/dispatchResolution.js
//
// 0045 §1.4 派发目标解析（写侧第一增量，R3 会审 consult_20261005185623675eln792
// 裁定版）：车道注册表（config/lanes.json）+ lane/role 显式派发 + 老席位名别名注解。
//
// 分层契约（auditor R3 裁定）：本模块在**核心层**——workflow/handlers 直接调
// RunManager.start，若解析器放 application/ 会让 workflow 向上引用（layering
// 冻结，test/isolation-infra/layering.test.js）；核心承载、应用服务与
// RunManager 向下调用（R7-AB 先例，同 matchedCertRecord 的 hosting 注释）。
//
// 语义合同（两席收敛裁定）：
//   - 合法输入二选一：{agentId} 或 {lane, role}；混用/缺半/全空 = dispatch_selector_invalid
//     （空串与 null 不许靠 truthy 冒充"未提供"）。
//   - 别名路径 = **注解不执行**（H1）：agentId 命中 aliases 时仍由调用方走
//     registry 原条目（行为零变化），解析器只返回身份注记 {laneId, roleId,
//     resolvedFrom:"alias"}；别名侧车道轴与注册表不一致 → 降级 legacy-agent
//     注解缺席（H2，零破坏；validate 出 WARN 不拒派发）。
//   - explicit 路径：lane+role 均必须在册在库；车道公开轴（backend/model.id/
//     model.providerID/reasoning.effort，null 归一）与 wiringAgent 注册表值
//     严格比对——**注册表赢，不一致即拒**（车道字段只断言不生效，G4）。
//   - 错误形状三原则（auditor R3 文案基准）：闭集码 unknown_lane / unknown_role /
//     dispatch_selector_invalid / unknown_agent；received 只回显过 canonical
//     字母表的值；choices 给完整合法全集（不截断冒充全集）。
//   - wiringAgent 过渡退役：0045 §6 第 3 步收口退出；版本绊线（0.3.0 发布时
//     lanes.json schema 仍含 wiringAgent → 下方守卫红）。
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

const WAO_ROOT = resolveRoot();
function resolveRoot() {
  // <repoRoot>/src/dispatchResolution.js → 上两级；与 roleContract.js 同法。
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

// ID_RE 自 canonicalAgentId.js（shared 身份字母表 SSOT）re-export——消费面
// （roleContract 等 application 层）经原路径 import 不变。
import { ID_RE as _ID_RE } from "./canonicalAgentId.js";
export const ID_RE = _ID_RE;

/**
 * 角色库清单（config/roles/*.md 文件名 stem 排序闭集）——解析器的 roleLibrary
 * 输入源，路径权威与 loadLanesConfig 同根（WAO 安装根）。角色文件本体的加载/
 * 校验仍归 application/roleContract.js（单一权威）；此处只枚举成员。
 */
export function listRoleLibrary() {
  try {
    return readdirSync(join(WAO_ROOT, "config", "roles"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((id) => ID_RE.test(id))
      .sort();
  } catch {
    return [];
  }
}

/** 解析来源闭集（§1.4）。 */
export const RESOLVED_FROM = Object.freeze(["alias", "explicit", "legacy-agent"]);

/** 错误码闭集（R3 两席词表收敛：auditor 词表为准；R4 增 lanes_config_invalid）。 */
export const DISPATCH_ERROR_CODES = Object.freeze([
  "unknown_lane", "unknown_role", "dispatch_selector_invalid", "unknown_agent",
  "lane_wiring_mismatch", "lanes_config_invalid",
]);

/** lanes.json 键白名单（G1：未知键整文件拒——防 schema 蔓延与 smuggle）。 */
const LANE_KEYS = new Set(["id", "backend", "model", "reasoning", "aliases"]);
const ALIAS_KEYS = new Set(["role"]);
const TOP_KEYS = new Set(["schema", "lanes", "_comment"]);

function isBlank(v) { return v === undefined || v === null || (typeof v === "string" && v.trim() === ""); }

function laneAxes(lane) {
  return {
    backend: lane.backend ?? null,
    modelId: lane.model?.id ?? null,
    providerID: lane.model?.providerID ?? null,
    effort: lane.reasoning?.effort ?? null,
  };
}
function agentAxes(agent) {
  return {
    backend: agent?.backend ?? null,
    modelId: agent?.model?.id ?? null,
    providerID: agent?.model?.providerID ?? null,
    effort: agent?.reasoning?.effort ?? null,
  };
}
function axesEqual(a, b) {
  return a.backend === b.backend && a.modelId === b.modelId
    && a.providerID === b.providerID && a.effort === b.effort;
}

/**
 * 0045 R4/W4b："终局复用策略归角色"落地——config/roles.json（git 跟踪、键白名单、
 * 闭集校验）加载。文件缺失=空政策（所有角色不复用；席位兼容来源按 effectiveSessionReuse）。
 * 结构 issue 与 lanes.json 同纪律（调用方决定消费语义）。
 */
const ROLE_POLICY_TOP_KEYS = new Set(["schema", "roles", "_comment"]);
const ROLE_POLICY_KEYS = new Set(["sessionReuse"]);
export const SESSION_REUSE_POLICIES = Object.freeze(["lead_workspace"]);

export function loadRolePolicies() {
  let raw;
  const path = join(WAO_ROOT, "config", "roles.json");
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: true, path, roles: {}, issues: [] };
  }
  let doc;
  const issues = [];
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { ok: false, path, roles: {}, issues: [`roles.json 不可解析：${e.message}`] };
  }
  if (doc.schema !== 1) issues.push("roles.json schema 必须为 1");
  for (const k of Object.keys(doc)) {
    if (!ROLE_POLICY_TOP_KEYS.has(k)) issues.push(`未知顶层键 "${k}"`);
  }
  const roles = {};
  for (const [roleId, policy] of Object.entries(doc.roles ?? {})) {
    if (!ID_RE.test(roleId)) { issues.push(`角色政策键 "${roleId}" 不合字母表`); continue; }
    if (!policy || typeof policy !== "object") { issues.push(`角色 "${roleId}" 政策必须是对象`); continue; }
    for (const k of Object.keys(policy)) {
      if (!ROLE_POLICY_KEYS.has(k)) issues.push(`角色 "${roleId}" 未知政策键 "${k}"`);
    }
    if (policy.sessionReuse !== undefined && !SESSION_REUSE_POLICIES.includes(policy.sessionReuse)) {
      issues.push(`角色 "${roleId}" sessionReuse 不在闭集 ${SESSION_REUSE_POLICIES.join("/")}`);
    }
    roles[roleId] = { sessionReuse: policy.sessionReuse ?? null };
  }
  return { ok: issues.length === 0, path, roles, issues };
}

/**
 * 生效复用策略（R4 裁定：归角色；席位字段降级为兼容来源）：
 *   ① roles.json[roleId].sessionReuse（角色政策，终局权威）；
 *   ② 缺席时：席位条目自带 sessionReuse 且派发角色=该席位原生角色
 *      （systemPrompt stem===roleId）→ 兼容生效（过渡期，席位政策随 W4d 重键消失）；
 *   ③ 其余（跨帽/显式组合/无政策）→ null（绝不把接线席位的策略继承成角色策略）。
 * @returns {"lead_workspace"|null}
 */
export function effectiveSessionReuse({ roleId, agent, rolePolicies }) {
  const policies = rolePolicies ?? loadRolePolicies().roles;
  const rolePolicy = roleId !== undefined && roleId !== null ? policies[roleId] : undefined;
  if (rolePolicy !== undefined) return rolePolicy.sessionReuse ?? null;
  if (agent && typeof agent.systemPrompt === "string" && agent.systemPrompt.endsWith(".md")) {
    const stem = agent.systemPrompt.split("/").pop().slice(0, -3);
    if (roleId === stem && agent.sessionReuse !== undefined) return agent.sessionReuse ?? null;
  }
  return null;
}

/**
 * 结构校验（纯函数，G1/G2）：未知键整文件拒、lane id/别名跨车道/wiringAgent/
 * 公开轴三元组全局唯一、别名值只允许 {role}、id 受字母表限制。
 * @param {object} doc 已解析的 lanes.json 文档对象
 * @returns {string[]} issues（空=结构合法）
 */
export function validateLanesStructure(doc) {
  const issues = [];
  if (!doc || typeof doc !== "object") return ["lanes.json 顶层必须是对象"];
  if (doc.schema !== 2) issues.push("schema 必须为 2（W4d：接线归注册表车道键，本表无 wiringAgent）");
  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.has(k)) issues.push(`未知顶层键 "${k}"（白名单 ${[...TOP_KEYS].join("/")}）`);
  }
  const lanes = Array.isArray(doc.lanes) ? doc.lanes : [];
  const seenLaneIds = new Set();
  const seenAliases = new Map();
  const seenAxes = new Set();
  const rolesHint = new Set();
  for (const lane of lanes) {
    if (!lane || typeof lane !== "object") { issues.push("lane 条目必须是对象"); continue; }
    for (const k of Object.keys(lane)) {
      if (!LANE_KEYS.has(k)) issues.push(`lane "${lane.id ?? "?"}" 未知键 "${k}"`);
    }
    if (typeof lane.id !== "string" || !ID_RE.test(lane.id)) issues.push(`lane id "${String(lane.id)}" 不合字母表`);
    else if (seenLaneIds.has(lane.id)) issues.push(`lane id "${lane.id}" 重复`);
    else seenLaneIds.add(lane.id);
    if (lane.wiringAgent !== undefined) {
      issues.push(`lane "${lane.id}" 含 wiringAgent——W4d 终局本表禁用该过渡字段（接线=注册表车道键）`);
    }
    const axesKey = JSON.stringify(laneAxes(lane));
    const prior = seenAxes.has(axesKey);
    if (prior) issues.push(`lane "${lane.id}" 公开轴与既有车道重复（G2）`);
    else seenAxes.add(axesKey);
    if (lane.aliases && typeof lane.aliases === "object") {
      for (const [alias, spec] of Object.entries(lane.aliases ?? {})) {
        if (!ID_RE.test(alias)) { issues.push(`别名 "${alias}" 不合字母表`); continue; }
        if (seenAliases.has(alias)) issues.push(`别名 "${alias}" 被 ${seenAliases.get(alias)} 与 ${lane.id} 双挂（G2 别名劫持面）`);
        else seenAliases.set(alias, lane.id);
        if (!spec || typeof spec !== "object" || Object.keys(spec).some((k) => !ALIAS_KEYS.has(k))) {
          issues.push(`别名 "${alias}" 值只允许 {role}（G3）`);
        } else if (typeof spec.role !== "string" || !ID_RE.test(spec.role)) {
          issues.push(`别名 "${alias}" role 不合字母表`);
        } else rolesHint.add(spec.role);
      }
    }
  }
  return issues;
}

/**
 * 加载并结构校验 config/lanes.json（G1/G2）。结构性错误整文件拒（返回 issues，
 * 调用方决定降级语义——alias 侧 WARN、explicit 侧拒）。文件缺失 = {lanes: []}
 * （未启用车道表，别名全走 legacy-agent——H2 换机零破坏路径）。
 * @param {string} [explicitPath] 显式路径（--registry 非默认时车道表停用，防跨绑）
 */
export function loadLanesConfig(explicitPath) {
  const path = typeof explicitPath === "string"
    ? (isAbsolute(explicitPath) ? explicitPath : join(WAO_ROOT, explicitPath))
    : join(WAO_ROOT, "config", "lanes.json");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: true, path, sha256: null, lanes: [], issues: [], rolesHint: [] };
  }
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return { ok: false, path, sha256, lanes: [], issues: [`lanes.json 不可解析：${e.message}`], rolesHint: [] };
  }
  const issues = validateLanesStructure(doc);
  const rolesHint = [];
  for (const lane of doc.lanes ?? []) {
    for (const spec of Object.values(lane.aliases ?? {})) {
      if (spec && typeof spec.role === "string") rolesHint.push(spec.role);
    }
  }
  return { ok: issues.length === 0, path, sha256, lanes: Array.isArray(doc.lanes) ? doc.lanes : [], issues, rolesHint: [...new Set(rolesHint)].sort() };
}

/**
 * 结构校验 + 跨文件绑定校验（registry validate / doctor 消费；alias 侧 WARN、
 * 结构错误硬 issue）。wiringAgent 必须在注册表；公开轴严格比对（null 归一）。
 * @returns {{issues:string[], warns:string[]}}
 */
export function validateLanesAgainstRegistry(lanesDoc, registryAgents) {
  const issues = [...(lanesDoc.issues ?? [])];
  const warns = [];
  const agents = registryAgents && typeof registryAgents === "object" ? registryAgents : {};
  // W4d 终局：接线=注册表车道键条目。校验=每车道有接线条目 + 公开轴一致（断言，
  // 注册表赢）；别名不再对注册表（角色一致性由别名表结构自证——role 键白名单）。
  for (const lane of lanesDoc.lanes ?? []) {
    const wiring = agents[lane.id];
    if (!wiring) {
      issues.push(`lane "${lane.id}" 的接线条目（注册表车道键）不在注册表`);
      continue;
    }
    const la = laneAxes(lane);
    const aa = agentAxes(wiring);
    if (!axesEqual(la, aa)) {
      warns.push(
        `lane "${lane.id}" 公开轴(${la.backend}/${la.modelId}/${la.effort}) 与注册表接线条目(${aa.backend}/${aa.modelId}/${aa.effort}) 不一致——explicit 派发将拒绝，请对齐`,
      );
    }
  }
  return { issues, warns };
}

/**
 * 派发目标解析（纯函数；两席裁定语义）。registryAgents 为 {id: agentEntry} 映射，
 * roleLibrary 为合法 roleId 闭集（由调用方从 config/roles/ 枚举传入——本模块不
 * 读角色目录，保持单一职责）。
 * @returns {{kind:"resolved", source:"alias"|"explicit"|"legacy-agent", agentId,
 *            laneId?:(string|null), roleId?:(string|null), wiringAgent?:(string|null),
 *            lanesSha256?:(string|null)}}
 *          |{kind:"error", code, message, received, choices}
 */
export function resolveDispatchTarget({ agentId, lane, role, lanesDoc, registryAgents, roleLibrary }) {
  const hasAgent = !isBlank(agentId);
  const hasLane = !isBlank(lane);
  const hasRole = !isBlank(role);
  const lanes = lanesDoc?.lanes ?? [];
  const laneIds = lanes.map((l) => l.id).sort();
  const roles = [...roleLibrary].sort();
  const aliasMap = new Map();
  for (const l of lanes) for (const a of Object.keys(l.aliases ?? {})) aliasMap.set(a, l);
  // R4（auditor_claude 红队）守卫落地：结构 issues 在派发路径上必须被消费——
  // explicit 侧整表即拒（lanes_config_invalid 新闭集码）；alias 侧降级 legacy-agent
  // （零破坏）。此前"整文件拒"只活在注释里。
  const lanesStructurallyInvalid = Array.isArray(lanesDoc?.issues) && lanesDoc.issues.length > 0;

  const safe = (v) => (typeof v === "string" && ID_RE.test(v) ? v : "<未回显：非规范字符>");

  // 输入形态闭集：{agentId} 或 {lane, role}，二选一（auditor R3）。
  if (hasAgent && (hasLane || hasRole)) {
    return {
      kind: "error", code: "dispatch_selector_invalid",
      received: { agentId: safe(agentId), lane: safe(lane), role: safe(role) },
      choices: { forms: ["agentId", "lane+role"], lanes: laneIds, roles },
      message: "dispatch_selector_invalid: 收到 agentId 与 lane/role 混用。只允许：agentId；或 lane + role。",
    };
  }
  if (hasLane !== hasRole) {
    return {
      kind: "error", code: "dispatch_selector_invalid",
      received: { lane: safe(lane), role: safe(role) },
      choices: { forms: ["agentId", "lane+role"], lanes: laneIds, roles },
      message: `dispatch_selector_invalid: lane 与 role 必须成对提供（收到 ${hasLane ? "仅 lane" : "仅 role"}）。`,
    };
  }
  if (lanesStructurallyInvalid && hasLane && hasRole) {
    return {
      kind: "error", code: "lanes_config_invalid",
      received: { lane: safe(lane), role: safe(role) },
      choices: { forms: ["agentId", "lane+role"] },
      message: `lanes_config_invalid: config/lanes.json 结构校验未过（${lanesDoc.issues.length} 项 issue）——explicit 派发整表拒绝；修复 lanes.json 或按 agentId 派发。明细：${lanesDoc.issues.slice(0, 3).join("；")}`,
    };
  }

  if (hasAgent) {
    const name = String(agentId).trim();
    const aliasLane = aliasMap.get(name);
    if (aliasLane && !lanesStructurallyInvalid) {
      // W4d（R5 裁定：别名=执行）：别名→车道→注册表车道键直取接线，角色=别名表
      // 声明的角色。注册表轴与车道轴断言不一致（H2）→ 降级 legacy-agent。
      const wiring = registryAgents?.[aliasLane.id];
      const declaredRole = aliasLane.aliases[name]?.role;
      if (wiring && axesEqual(agentAxes(wiring), laneAxes(aliasLane)) && declaredRole !== undefined) {
        return {
          kind: "resolved", source: "alias", agentId: aliasLane.id,
          laneId: aliasLane.id, roleId: declaredRole,
          lanesSha256: lanesDoc?.sha256 ?? null,
        };
      }
    }
    if (registryAgents?.[name]) {
      return {
        kind: "resolved", source: "legacy-agent", agentId: name,
        laneId: null, roleId: null, wiringAgent: null, lanesSha256: null,
      };
    }
    return {
      kind: "error", code: "unknown_agent",
      received: { agentId: safe(agentId) },
      choices: { aliases: [...aliasMap.keys()].sort(), lanes: laneIds, roles },
      message: `unknown_agent: 收到 agentId="${safe(agentId)}"；不在注册表、也不在车道别名表。`,
    };
  }

  if (hasLane && hasRole) {
    const laneName = String(lane).trim();
    const roleName = String(role).trim();
    const targetLane = lanes.find((l) => l.id === laneName);
    if (!targetLane) {
      return {
        kind: "error", code: "unknown_lane",
        received: { lane: safe(lane), role: safe(role) },
        choices: { lanes: laneIds, roles },
        message: `unknown_lane: 收到 lane="${safe(laneName)}"；该车道未注册。`,
      };
    }
    if (!roles.includes(roleName)) {
      return {
        kind: "error", code: "unknown_role",
        received: { lane: safe(laneName), role: safe(role) },
        choices: { lanes: laneIds, roles },
        message: `unknown_role: 收到 role="${safe(roleName)}"；该角色不在角色库。`,
      };
    }
    // W4d：接线=注册表车道键条目直取（无 wiringAgent 过渡字段）。
    const wiring = registryAgents?.[targetLane.id];
    if (!wiring) {
      return {
        kind: "error", code: "lane_wiring_mismatch",
        received: { lane: safe(laneName), role: safe(roleName) },
        choices: { lanes: laneIds, roles },
        message: `lane_wiring_mismatch: lane "${laneName}" 的接线条目（注册表车道键 ${targetLane.id}）不在注册表。`,
      };
    }
    if (!axesEqual(laneAxes(targetLane), agentAxes(wiring))) {
      // G4：注册表赢——车道字段只断言不生效，不一致即拒（防"改 lanes.json 换模型"）。
      const la = laneAxes(targetLane); const aa = agentAxes(wiring);
      return {
        kind: "error", code: "lane_wiring_mismatch",
        received: { lane: safe(laneName), role: safe(roleName) },
        choices: { lanes: laneIds, roles },
        message: `lane_wiring_mismatch: lane "${laneName}" 声明 (${la.backend}/${la.modelId}/${la.effort}) 与注册表 ${targetLane.id} (${aa.backend}/${aa.modelId}/${aa.effort}) 不一致——注册表为准，请对齐 lanes.json。`,
      };
    }
    return {
      kind: "resolved", source: "explicit", agentId: targetLane.id,
      laneId: targetLane.id, roleId: roleName,
      lanesSha256: lanesDoc?.sha256 ?? null,
    };
  }

  return {
    kind: "error", code: "dispatch_selector_invalid",
    received: {},
    choices: { forms: ["agentId", "lane+role"], lanes: laneIds, roles },
    message: "dispatch_selector_invalid: 未提供派发目标。只允许：agentId；或 lane + role。",
  };
}
