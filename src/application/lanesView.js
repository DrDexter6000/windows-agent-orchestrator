// src/application/lanesView.js
//
// 车道画像读取面（wao lanes，决定 0064、0087）的纯投影层。画像的加载、校验与
// 待复核判定归 src/application/laneProfile.js；本模块只做视图投影，行携带画像
// 与 ratingsState/reviewReasons。
//
// 契约（会审 consult_202610121021490657ur8lp 双席 P1 全采纳；0087 增补）：
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
//     画像加载器经 laneProfile.js 取得并 re-export（命令层单入口——laneProfile
//     只准被本模块与 leadPreflight 引用，隔离守卫钉住）。

// axesEqual/laneAxes/agentAxes（explicit 派发 G4 同一判定，0064 起导出）。
// validDispatchHold（TD-283）：dispatchHold 的形状校验与车道表同一纪律。
import { axesEqual, laneAxes, agentAxes, validDispatchHold } from "../dispatchResolution.js";
import {
  readLaneTraits,
  ratingsState,
  buildScaleLine,
  laneFamilyLabel,
  DIMENSION_LABELS,
} from "./laneProfile.js";

// 命令层（src/commands/lanes.js）经本模块取画像加载器——它不准直接引用
// laneProfile.js（0087 §5 守卫边）。
export { readLaneTraits };

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
    // absent（无键）/ invalid（该车道形状错误）/ present。present 时附评分
    // 状态与待复核原因（0087：与车道表身份比对 + reviewPending，全文不截断）。
    let traitsState = "absent";
    let traits = null;
    let profileRating = null;
    if (traitsResult.state === "unreadable") traitsState = "unreadable";
    else if (traitsResult.state === "invalid") traitsState = "invalid";
    else if (Object.prototype.hasOwnProperty.call(traitsResult.traits, id)) {
      traitsState = "present";
      traits = traitsResult.traits[id];
      profileRating = ratingsState(traits, lane);
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
      // 0090：推断族系（会审选不同族系的副审时参考；展示专用非契约）。
      family: laneFamilyLabel(lane),
      wiring,
      ...(wiringDetail ? { wiringDetail } : {}),
      traitsState,
      ...(traits ? {
        traits,
        ratingsState: profileRating.state,
        reviewReasons: profileRating.reasons,
      } : {}),
      // 认证轴：inventory 简表口径原样透传（null=未取得匹配认证，原因未区分）
      certification: wiredForAxes ? (inv?.certification ?? null) : null,
      certificationLastHealthyAt: wiredForAxes ? (inv?.certificationLastHealthyAt ?? null) : null,
      certificationNote: wiredForAxes && (inv?.certification ?? null) === null
        ? "unmatched_reason_unspecified" : null,
      // 就绪轴：探测权威只吃 registry 有效条目（未接线/无效=无探测行）
      readyState: wiredForAxes ? (readyMap.get(id)?.readyState ?? null) : null,
      // 决定 0074：kimiHome 车道就绪按 token 文件推导——就绪输入事实点名路径
      //（人读面与 --json 同源；未接线/无效/非 kimiHome 车道=null）。
      readyTokenFile: wiredForAxes ? (readyMap.get(id)?.requiresTokenFile ?? null) : null,
      // TD-283：车道表自带的 Owner 暂停派发说明（车道表事实，与接线状态无关；
      // 无该字段/形状不合法=null）。只告知不拦截。
      dispatchHold: validDispatchHold(lane.dispatchHold),
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
    // 0087：表头刻度行（一次）与七个维度的中文名（视图层从 laneProfile 取，
    // 中文名只有一个归宿）。
    traitsScale: traitsResult?.state === "ok" ? buildScaleLine(traitsResult.scale) : null,
    dimensionLabels: { ...DIMENSION_LABELS },
    // 头部事实来源（人读面与 --json 同源；渲染层只投影不加工）
    sourceNotes: {
      order: "行序=lanes.json 声明序；事实陈列，非推荐",
      profile: "画像=分项星级与依据（实测 measured 由 Lead 维护，owner 由 Owner 维护）；与车道表身份不一致或写了 reviewPending 即待复核",
      certification: "认证=reliability 台账简表口径（不比较 effort，非当前执行画像适用性结论）",
      readyState: "就绪=环境探测（口径同 wao onboarding；未接线/条目无效=跳过探测）",
      dispatchHold: "暂停说明=车道表 dispatchHold（Owner 原话；只告知不拦截，派发决定权在 Lead）",
      panel: "会审对抗性=派生事实（0045 §1.2/0065：wao stage 2/4 --panel-seats --reviewed-run 按审者×作者车道指纹派生——本面不预判）",
    },
  };
}
