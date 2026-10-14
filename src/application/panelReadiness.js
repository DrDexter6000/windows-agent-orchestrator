// src/application/panelReadiness.js
//
// 三席会审就绪分级推导（R9 / 决策 0023）——单一实现（SSOT）。
//
// 0065（2026-10-12，0045 §1.2 终局执行）：席位角色维整体退役——对抗性改为
// 派生事实（application/panelDerivation.js，审者×作者车道指纹比对），本模块
// 的分级改**车道多样性**口径：候选=全部行（0045"角色是帽子"——每条车道都
// 可能当副审，没有 non_seat 属性）；有意义的多样性维度=模型族系（W4d 后每键
// =唯一车道，跨车道恒真）。missingAdversarial 语义（≥2 候选但 0 对抗席）随
// seatRole 退役废止，族系多样性（insufficientFamilyDiversity）升为主提示；
// tier 语义收窄为**探测候选数量**（不声称已配齐可派发副审——sol P1）。
//
// onboarding（模板面：入库模板 + 环境探测）与 doctor（已配置面：私人
// config/agents.json + 环境探测）各自包装输入行调用本模块；两处禁止各算
// 分级（测试钉住）。输出是纯展示建议（advisory）：不门禁任何派发/验收，
// 不自动派发副审，选位权在 Lead（席位回避规则见 0019 §3，0023 保留）。
//
// 输入行形状（两个面对齐）：{ id, backend, model, readyState }。
// readyState 八态闭集与 application/onboarding.js 的引擎值同域；本模块的
// deriveReadyState 是映射的单一实现（onboarding 的 computeReadyState
// 探测归一后委托到这里，doctor 用自己的探测事实构造后也委托到这里）。
// login_based/unknown 不计入"可用"但如实展示：登录态型展示"登录态未验证"
// （文案不得把登录态当已验证讲）；serve 注入型（backend=opencode-serve）的
// login_based 原值是基线遗留——展示层单列 injectedAuth（注入式认证，serve
// 探测不覆盖）；unknown 展示"探测未知"。
// 未知族系 ≠ 同族：跨族系判断只统计已知族系（modelFamily UNKNOWN_FAMILY
// 不参与多样性判定）。

import { modelFamilyOf, UNKNOWN_FAMILY } from "./modelFamily.js";

// R9-C C-14：PANEL_STAGES 的单一 SSOT 在 waoStage.js——此处 re-export 保住
// 既有消费面引用（本模块不再持值副本）；对账测试继续双向钉住。
export { PANEL_STAGES } from "../waoStage.js";

/**
 * 八态 readyState 的单一映射实现（onboarding computeReadyState 与 doctor 共用）。
 * TD-258（2026-10-11 双席会审综合）：无 CLI 探测面但声明了凭据名的车道（kimi-web
 * 的 tokenEnv）新增 key_only_* 两态——语义收窄为"声明的凭据变量可解析且非空"，
 * **未验证令牌有效性、serve 可达性或运行时可用性**，命名不带 ready 防夸大；
 * 无凭据声明的无 CLI 车道（zcode：承重 env 桥不是凭据）保持 unknown。
 * 决定 0074：key 轴增加 "token_file" 输入值——声明 kimiHome 的 kimi-web 车道，
 * 凭据是 <kimiHome>/server.token 文件（tokenEnv 不探）；文件在且非空与
 * process_env/user_env 同为"已解析"（同样只是文件可读非空，不是就绪声称）。
 * 输出闭集不变（不新增状态）。
 *
 * @param {object} input
 * @param {string|null} input.requiresCli — backend 映射的 CLI 名（null = 无 CLI 可探）
 * @param {string|null} input.requiresKeyEnv — 声明的 provider key env 名（null = 登录态型；
 *   kimiHome 车道传 token 文件路径——映射只看非空性，不消费其值）
 * @param {true|false|"unknown"|undefined} input.cli — CLI 探测结果（undefined 视为 unknown）
 * @param {"process_env"|"user_env"|"token_file"|"missing"|"unknown"|undefined} input.key — key 探测结果
 * @returns {"ready"|"missing_cli"|"missing_key"|"missing_both"|"login_based"|"key_only_present"|"key_only_missing"|"unknown"}
 */
export function deriveReadyState({ requiresCli, requiresKeyEnv, cli, key }) {
  if (!requiresCli) {
    // 无 CLI 探测面：有凭据声明时只探 key 名可解析性（不是就绪声称）。
    if (!requiresKeyEnv) return "unknown"; // backend 无 CLI 映射且无凭据声明：无法验证
    const k0 = key === "process_env" || key === "user_env" || key === "token_file" || key === "missing" ? key : "unknown";
    if (k0 === "unknown") return "unknown";
    return k0 === "missing" ? "key_only_missing" : "key_only_present";
  }
  const c = cli === true || cli === false ? cli : "unknown";
  if (!requiresKeyEnv) {
    // 登录态型（官方 OAuth / CLI 登录）：只探 CLI，登录态本身无法远程验证。
    if (c === true) return "login_based";
    return c === false ? "missing_cli" : "unknown";
  }
  const k = key === "process_env" || key === "user_env" || key === "token_file" || key === "missing" ? key : "unknown";
  if (c === "unknown" || k === "unknown") return "unknown";
  const cliOk = c === true;
  const keyOk = k !== "missing";
  if (cliOk && keyOk) return "ready";
  if (!cliOk && keyOk) return "missing_cli";
  if (cliOk && !keyOk) return "missing_key";
  return "missing_both";
}

/**
 * 三席会审就绪分级（单一推导；两个展示面共用的唯一实现）。
 * 0065：多样性口径——候选=全部行（角色维退役）；tier=探测候选数量。
 *
 * @param {Array<{id: string, backend: string|null, model: string|null, readyState: string}>} rows
 * @returns {{
 *   tier: "three_seat"|"two_seat"|"none",
 *   available: Array<{id: string, family: string}>,
 *   loginUnverified: string[],
 *   injectedAuth: string[],
 *   probeUnknown: string[],
 *   insufficientFamilyDiversity: boolean,
 *   duplicateModelKeys: Array<{backend: string|null, modelId: string|null, ids: string[]}>,
 *   singleWorkerVacuous: boolean,
 *   seats: Array<{id: string, family: string}>|null,
 * }}
 *   available：可用（探测 ready）候选——探测口径数量，不声称已配齐可派发副审。
 *   loginUnverified / injectedAuth / probeUnknown：如实展示清单（登录态型 /
 *     serve 注入型 / 探测未知）。
 *   insufficientFamilyDiversity：≥2 可用候选且已知族系不足两族（未知族系不
 *     参与判定 ⇒ 含"一已知+一未知"、"全未知"——无法确认跨族系，同样提示）。
 *     0065 起为主提示（原 missingAdversarial 随 seatRole 退役废止）。
 *   duplicateModelKeys：同 backend+modelId 多键配置（车道指纹不含 effort——
 *     同四元组改 effort 可注册双键；tier 按行计数会虚高，如实点名——opus P2 轻量版）。
 *   singleWorkerVacuous：仅 1 名候选——它通常就是被审产出的作者（0019 §3
 *     作者回避），两席建议事实空转，文案必须明说。
 *   seats：建议配对（纯族系最大化：全候选中找已知跨族对——sol P1 修复
 *     "首席未知吞掉后续跨族对"反例；找不到跨族对退化为前两名如实展示，
 *     由 insufficientFamilyDiversity 提示）。永不排序推荐非候选（Lead 拥有选位权）。
 */
export function assessPanelReadiness(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const entries = list.map((row) => ({
    id: String(row?.id ?? "?"),
    family: modelFamilyOf({ modelId: row?.model, backend: row?.backend }),
    backend: typeof row?.backend === "string" ? row.backend : null,
    modelId: typeof row?.model === "string" ? row.model : null,
    readyState: typeof row?.readyState === "string" ? row.readyState : "unknown",
    serveInjected: row?.backend === "opencode-serve",
  }));
  const readySeats = entries.filter((e) => e.readyState === "ready");
  const loginUnverified = entries
    .filter((e) => e.readyState === "login_based" && !e.serveInjected)
    .map((e) => e.id);
  const injectedAuth = entries
    .filter((e) => e.readyState === "login_based" && e.serveInjected)
    .map((e) => e.id);
  const probeUnknown = entries.filter((e) => e.readyState === "unknown").map((e) => e.id);
  const knownFamilies = readySeats.map((e) => e.family).filter((f) => f !== UNKNOWN_FAMILY);
  // 同 backend+modelId 多键（近似指纹去重——指纹需 provider 块，行形状不携带；
  // 展示事实用，不作硬判定）。
  const byAxes = new Map();
  for (const e of readySeats) {
    const key = `${e.backend ?? "?"}|${e.modelId ?? "?"}`;
    if (!byAxes.has(key)) byAxes.set(key, { backend: e.backend, modelId: e.modelId, ids: [] });
    byAxes.get(key).ids.push(e.id);
  }
  const duplicateModelKeys = [...byAxes.values()].filter((g) => g.ids.length > 1);
  return {
    tier: readySeats.length >= 2 ? "three_seat" : readySeats.length === 1 ? "two_seat" : "none",
    available: readySeats.map((e) => ({ id: e.id, family: e.family })),
    loginUnverified,
    injectedAuth,
    probeUnknown,
    // TD-258：key_only_* 不计入可用、不抬 tier，但绝不从叙事里无声消失。
    keyOnly: entries
      .filter((e) => e.readyState === "key_only_present" || e.readyState === "key_only_missing")
      .map((e) => e.id),
    insufficientFamilyDiversity: readySeats.length >= 2 && new Set(knownFamilies).size < 2,
    duplicateModelKeys,
    singleWorkerVacuous: list.length === 1,
    seats: suggestSeatPair(readySeats),
  };
}

/**
 * 建议配对（纯展示建议，选位权在 Lead）。0065：全候选中找**已知跨族对**
 * （sol P1：旧算法首席未知时会吞掉后续存在的跨族对——反例实测废除）；
 * 找不到已知跨族对才退化为前两名（同族/含未知如实展示，由
 * insufficientFamilyDiversity 提示兜底）。确定性：候选序扫描，首个跨族对胜。
 */
function suggestSeatPair(readySeats) {
  if (readySeats.length < 2) return null;
  for (let i = 0; i < readySeats.length; i++) {
    for (let j = i + 1; j < readySeats.length; j++) {
      if (isDiverseFamily(readySeats[i].family, readySeats[j].family)) {
        return [
          { id: readySeats[i].id, family: readySeats[i].family },
          { id: readySeats[j].id, family: readySeats[j].family },
        ];
      }
    }
  }
  const first = readySeats[0];
  const second = readySeats.find((e) => e !== first);
  return [
    { id: first.id, family: first.family },
    { id: second.id, family: second.family },
  ];
}

/** 两族系均已知且不同（未知族系不参与多样性判定）。 */
function isDiverseFamily(a, b) {
  return a !== UNKNOWN_FAMILY && b !== UNKNOWN_FAMILY && a !== b;
}
