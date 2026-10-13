// src/application/lanesView.js
//
// 0064（2026-10-12，Owner 批 A0+A1）：车道画像读取面（wao lanes）的纯投影层。
//
// 定位：lane-traits.json（Owner 手拟画像矩阵）自此起有一个**展示层**消费者——
// 这是 0046 §1.5 隔离铁律的预告放宽（test/registry-roles/laneTraits.test.js
// 原注释："读取面落地时本钉须同步放宽为白名单"）。画像仍然不进派发解析面、
// 不进门禁、不进 MCP wire（隔离守卫已同步改为"白名单 + 导入边"双钉）。
//
// 契约（会审 consult_202610121021490657ur8lp 双席 P1 全采纳）：
//   - 事实陈列，零排序零推荐：行序恒=lanes.json 声明序（不按 readyState 重排）。
//   - 0065（0045 §1.2 终局）：seatRole 声明列删除（席位角色维退役——对抗性改
//     派生事实，wao stage --reviewed-run；registry 归一化已 strip 该字段）。
//   - certification=null 不等于"无记录"——无记录/身份不匹配/台账缺失或不可读
//     三种原因未区分，展示层如实标注（sol P1-3）；状态值原样透传（不止
//     certified/conditional 两态）。
//   - 接线轴复用 dispatchResolution 的 axesEqual 判定（同 explicit 派发的
//     G4 语义：漂移=explicit 派发将拒绝）；"键不存在"（unwired）与"键存在但
//     条目无效"（invalid）严格分开（sol P1-1）。
//   - 画像降级三态分开：absent（无该车道键）/ invalid（形状错误）/ unreadable
//     （整文件不可读）——不用默认值冒充观察事实（sol P1-4）。
//   - 本模块纯函数：所有 IO（读文件/探测/registry）由调用方注入；零 env 读取。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// axesEqual/laneAxes/agentAxes（explicit 派发 G4 同一判定，0064 起导出）。
import { axesEqual, laneAxes, agentAxes } from "../dispatchResolution.js";

const WAO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** traits 单车道形状校验（与 test/registry-roles/laneTraits.test.js 的结构钉
 *  同一形状——profile/suggestedUses/contextWindow/multimodal 必填，effortNote /
 *  concurrencyNote
 *  可选；来源标注必为字符串）。不合规=整车道降级 invalid（不造默认值）。
 *  纯函数：返回 {ok:true, entry} 或 {ok:false, fields:[...]}。 */
export function validateTraitEntry(id, entry) {
  const bad = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, fields: ["(非对象)"] };
  }
  if (typeof entry.profile !== "string") bad.push("profile");
  if (!Array.isArray(entry.suggestedUses)
    || entry.suggestedUses.length === 0
    || entry.suggestedUses.some((u) => typeof u !== "string")) bad.push("suggestedUses");
  const cw = entry.contextWindow;
  if (!cw || typeof cw !== "object" || !Number.isInteger(cw.tokens) || cw.tokens <= 0
    || typeof cw.source !== "string") bad.push("contextWindow");
  const mm = entry.multimodal;
  if (!mm || typeof mm !== "object" || typeof mm.image !== "boolean"
    || typeof mm.video !== "boolean" || typeof mm.source !== "string") bad.push("multimodal");
  if (entry.effortNote !== undefined && typeof entry.effortNote !== "string") bad.push("effortNote");
  // 决定 0074：同车道并发的实测记录（可选；自由文本，写明并发数、日期与取样条件）。
  if (entry.concurrencyNote !== undefined && typeof entry.concurrencyNote !== "string") bad.push("concurrencyNote");
  if (bad.length > 0) return { ok: false, fields: bad };
  return {
    ok: true,
    entry: {
      profile: entry.profile,
      suggestedUses: [...entry.suggestedUses],
      contextWindow: { tokens: cw.tokens, source: cw.source, ...(typeof cw.shape === "string" ? { shape: cw.shape } : {}) },
      multimodal: { image: mm.image, video: mm.video, source: mm.source },
      ...(entry.effortNote !== undefined ? { effortNote: entry.effortNote } : {}),
      ...(entry.concurrencyNote !== undefined ? { concurrencyNote: entry.concurrencyNote } : {}),
    },
  };
}

/**
 * 加载并形状校验 config/lane-traits.json（读取根=WAO 安装根，与 loadLanesConfig
 * 同纪律；readFileFn 可注入）。三态：ok（可读且顶层形状合法——单车道形状错误
 * 降级为该车道 invalid + issue）/ unreadable（文件缺失或 JSON 不可解析——所有
 * 车道标 unreadable）/ invalid（可解析但顶层形状坏——所有车道标 invalid）。
 * 只读展示面：任何失败都不抛（命令层如实报告，不中断其他轴）。
 */
export function readLaneTraits(explicitPath, readFileFn = null) {
  const path = typeof explicitPath === "string"
    ? (isAbsolute(explicitPath) ? explicitPath : join(WAO_ROOT, explicitPath))
    : join(WAO_ROOT, "config", "lane-traits.json");
  const read = readFileFn ?? ((p) => readFileSync(p, "utf8"));
  let raw;
  try {
    raw = read(path);
  } catch {
    return { state: "unreadable", path, sha256: null, traits: {}, issues: [`画像文件不可读：${path}`] };
  }
  const text = typeof raw === "string" ? raw : String(raw);
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { state: "unreadable", path, sha256, traits: {}, issues: [`画像文件不可解析：${e.message}`] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || typeof doc.traits !== "object"
    || doc.traits === null || Array.isArray(doc.traits)) {
    return { state: "invalid", path, sha256, traits: {}, issues: ["画像文件顶层形状错误（应含 traits 对象）"] };
  }
  const traits = {};
  const issues = [];
  for (const [id, entry] of Object.entries(doc.traits)) {
    const v = validateTraitEntry(id, entry);
    if (v.ok) traits[id] = v.entry;
    else issues.push(`车道 ${id} 画像形状错误（${v.fields.join("/")}）`);
  }
  return { state: "ok", path, sha256, traits, issues };
}

/** 画布常量：derived issues 上限（诚实截断标志，防 registry 异常膨胀刷屏）。 */
const DERIVED_ISSUE_CAP = 16;

/**
 * 纯投影：把四路输入合成为一屏车道视图。所有输入由命令层单次读取后注入
 * （registry 只读一次——会审 P1：inventory/探测输入/接线轴同源，防两次读取
 * 拼出前后不一致的状态）。
 *
 * @param {object} input
 * @param {object} input.lanesDoc       loadLanesConfig() 结果（车道声明序权威）
 * @param {object} input.traitsResult   readLaneTraits() 结果
 * @param {object} input.inventory      getRegistryInventoryWithIssues() 结果
 * @param {Object<string, object>} input.registryAgents 同一次 readRegistry 的
 *   listAgents() 归一映射（接线轴来源——0065 起归一化不含 seatRole）
 * @param {object[]} input.readyRows    buildRecommendations(...).rows（就绪轴；
 *   未接线/无效车道无行=readyState null）
 * @returns {object} 视图对象（--json 白名单投影的同源单对象）
 */
export function buildLanesView({ lanesDoc, traitsResult, inventory, registryAgents, readyRows }) {
  const issues = [];
  const pushIssue = (detail) => {
    if (issues.length < DERIVED_ISSUE_CAP) issues.push(detail);
    else if (issues.length === DERIVED_ISSUE_CAP) issues.push(`（其余 issue 截断——共超 ${DERIVED_ISSUE_CAP} 条）`);
  };

  // 车道表权威失败 ≠ 成功的空面（sol P1-2）：ok:false（结构坏）或
  // ok:true && sha256===null（文件缺失）都不产出正常车道面；合法空表（有 sha、
  // 零车道）产出空面 + 注记。
  const lanesUnavailable = !lanesDoc?.ok;
  const lanesUnreadable = lanesDoc?.ok === true && lanesDoc.sha256 === null;
  const laneList = Array.isArray(lanesDoc?.lanes) ? lanesDoc.lanes : [];
  if (lanesUnavailable) {
    for (const i of (lanesDoc?.issues ?? []).slice(0, 3)) pushIssue(`lanes.json 结构非法：${i}`);
    if ((lanesDoc?.issues ?? []).length > 3) pushIssue(`lanes.json 另有 ${lanesDoc.issues.length - 3} 项结构 issue`);
  }
  if (lanesUnreadable) pushIssue("lanes.json 不可读（车道表停用）");

  const laneIds = new Set(laneList.map((l) => l?.id).filter((id) => typeof id === "string"));
  // registry 侧无效条目（normalizeAgent 抛出 → inventory issue）≠ 未接线：
  // agentId 命中车道键的标 invalid，其余原样上报。
  const invalidIds = new Set(
    (inventory?.issues ?? [])
      .filter((i) => i?.code === "invalid_configuration" && typeof i.agentId === "string")
      .map((i) => i.agentId),
  );
  const invAgents = new Map((inventory?.agents ?? []).map((a) => [a.id, a]));
  const readyMap = new Map((readyRows ?? []).map((r) => [r.id, r]));

  const rows = [];
  for (const lane of laneList) {
    const id = lane?.id;
    if (typeof id !== "string") continue; // 结构守卫已在 loadLanesConfig 报过
    const declared = laneAxes(lane);
    const agent = registryAgents?.[id] ?? null;

    // 接线轴（sol P1-1）：unwired（键不存在）/ invalid（键在、条目无法解析）/
    // wired（axesEqual 一致）/ drift（explicit 派发将拒绝——同 G4 判定）。
    let wiring = "unwired";
    let wiringDetail = null;
    if (invalidIds.has(id)) wiring = "invalid";
    else if (agent) {
      const regAxes = agentAxes(agent);
      if (axesEqual(declared, regAxes)) wiring = "wired";
      else {
        wiring = "drift";
        wiringDetail = { declared, registry: regAxes };
      }
    }

    // 画像轴三态（sol P1-4）：整文件 unreadable/invalid 传染所有车道；否则
    // absent（无键）/ invalid（该车道形状错误）/ present。
    let traitsState = "absent";
    let traits = null;
    if (traitsResult.state === "unreadable") traitsState = "unreadable";
    else if (traitsResult.state === "invalid") traitsState = "invalid";
    else if (Object.prototype.hasOwnProperty.call(traitsResult.traits, id)) {
      traitsState = "present";
      traits = traitsResult.traits[id];
    } else {
      const bad = (traitsResult.issues ?? []).some((s) => s.startsWith(`车道 ${id} 画像形状错误`));
      if (bad) traitsState = "invalid";
    }

    const inv = invAgents.get(id) ?? null;
    const wiredForAxes = wiring === "wired" || wiring === "drift";
    rows.push({
      id,
      // lanes.json 声明轴（接线漂移时与 registry 轴并排可见）
      backend: declared.backend,
      modelId: declared.modelId,
      providerID: declared.providerID,
      effort: declared.effort,
      wiring,
      ...(wiringDetail ? { wiringDetail } : {}),
      traitsState,
      ...(traits ? { traits } : {}),
      // 认证轴：inventory 简表口径原样透传（null=未取得匹配认证，原因未区分）
      certification: wiredForAxes ? (inv?.certification ?? null) : null,
      certificationLastHealthyAt: wiredForAxes ? (inv?.certificationLastHealthyAt ?? null) : null,
      certificationNote: wiredForAxes && (inv?.certification ?? null) === null
        ? "unmatched_reason_unspecified" : null,
      // 就绪轴：探测权威只吃 registry 有效条目（未接线/无效=无探测行）
      readyState: wiredForAxes ? (readyMap.get(id)?.readyState ?? null) : null,
    });
  }

  // 交叉报告（不静默丢弃）：孤儿画像键（traits 有、lanes 无）与 registry 额外键
  // （registry 有、lanes 无——非车道，不进行面）。
  if (traitsResult.state === "ok") {
    for (const key of Object.keys(traitsResult.traits)) {
      if (!laneIds.has(key)) pushIssue(`画像孤儿键：${key}（不在 lanes.json 车道表）`);
    }
  }
  for (const key of Object.keys(registryAgents ?? {})) {
    if (!laneIds.has(key)) pushIssue(`registry 额外键：${key}（不在 lanes.json 车道表，不进行面）`);
  }
  // inventory 侧与车道无关的 issue 原样上报（invalid_id 等）。
  for (const i of (inventory?.issues ?? [])) {
    if (i?.code === "invalid_id") pushIssue(`registry 条目 id 非法（不可回显）`);
  }

  return {
    state: lanesUnavailable ? "lanes_invalid"
      : lanesUnreadable ? "lanes_unreadable"
        : "ok",
    ...(laneList.length === 0 && !lanesUnavailable && !lanesUnreadable
      ? { lanesStateNote: "车道表为空（lanes.json 合法但零车道）" } : {}),
    lanes: rows,
    issues,
    lanesSha256: lanesDoc?.sha256 ?? null,
    traitsSha256: traitsResult?.sha256 ?? null,
    traitsPath: traitsResult?.path ?? null,
    // 头部事实来源（人读面与 --json 同源；渲染层只投影不加工）
    sourceNotes: {
      order: "行序=lanes.json 声明序；事实陈列，非推荐",
      profile: "画像=Owner 手拟矩阵（config 内画像文件；初次落库 2026-10-06，其后有 Owner 修订；无新鲜度机制——模型升级以重认证为准）",
      certification: "认证=reliability 台账简表口径（不比较 effort，非当前执行画像适用性结论）",
      readyState: "就绪=环境探测（口径同 wao onboarding；未接线/条目无效=跳过探测）",
      panel: "会审对抗性=派生事实（0045 §1.2/0065：wao stage 2/4 --panel-seats --reviewed-run 按审者×作者车道指纹派生——本面不预判）",
    },
  };
}
