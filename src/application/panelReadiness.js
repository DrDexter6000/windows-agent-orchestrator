// src/application/panelReadiness.js
//
// 三席会审就绪分级推导（R9 / 决策 0023；R9-C 返工 C-1 引入席位角色）——
// 单一实现（SSOT）。
//
// onboarding（模板面：入库模板 + 环境探测）与 doctor（已配置面：私人
// config/agents.json + 环境探测）各自包装输入行调用本模块；两处禁止各算
// 分级（测试钉住）。输出是纯展示建议（advisory）：不门禁任何派发/验收，
// 不自动派发副审，选位权在 Lead（席位回避规则见 0019 §3，0023 保留）。
//
// 输入行形状（两个面对齐）：{ id, backend, model, readyState }。
// readyState 六态闭集与 application/onboarding.js 的引擎值同域；本模块的
// deriveReadyState 是六态映射的单一实现（onboarding 的 computeReadyState
// 探测归一后委托到这里，doctor 用自己的探测事实构造后也委托到这里）。
//
// 席位角色（R9-C C-1，0019/0023 保留的两席分配语义；分类规则是角色惯例，
// 候选清单从输入行生——不在行里的 worker 不点名，0022 纪律）：
//   adversarial（对抗席候选）   auditor（专职）+ coder_mm（轮换替补）
//   implementation（实现席候选）coder 系通道（coder_ 前缀；coder_mm 归对抗席）
//   其余（researcher/tester 等调研/工具角色）非席位角色——不进席位计数与建议。
//
// 分级语义（0023，按可用席位候选计数）：
//   three_seat  ≥2 名可用席位候选（readyState=ready）。含对抗席时静默全清；
//               零对抗席时仍 three_seat（物理可配）但 missingAdversarial=true，
//               展示面必附"无对抗席候选——建议补配"提示行，doctor 不静默。
//   two_seat    恰 1 名可用席位候选 → 两席次之推荐
//   none        0 名可用席位候选 → 跳过提示（--panel-skip-reason 登记）
// login_based/unknown 不计入"可用"但如实展示：登录态型展示"登录态未验证"
// （文案不得把登录态当已验证讲——auditor 即此形）；serve 注入型（backend=
// opencode-serve）的 login_based 原值是基线遗留，它不是登录态型认证——展示层
// 单列 injectedAuth（注入式认证，serve 探测不覆盖）；unknown 展示"探测未知"。
// 未知族系 ≠ 同族：跨族系判断只统计已知族系（modelFamily UNKNOWN_FAMILY
// 不参与多样性判定）。

import { modelFamilyOf, UNKNOWN_FAMILY } from "./modelFamily.js";

// R9-C C-14：PANEL_STAGES 的单一 SSOT 在 waoStage.js——此处 re-export 保住
// 既有消费面引用（本模块不再持值副本）；对账测试继续双向钉住。
export { PANEL_STAGES } from "../waoStage.js";

/**
 * 席位角色分类（0019/0023 两席分配语义的单一实现，渲染层复用不另写一份）。
 * 对抗席判定先于 coder_ 前缀——coder_mm 是对抗席替补，不是实现席。
 * @param {unknown} id
 * @returns {"adversarial"|"implementation"|"non_seat"}
 */
export function seatRoleOf(id) {
  const s = String(id ?? "");
  if (s === "auditor" || s === "coder_mm") return "adversarial";
  if (/^coder_/.test(s)) return "implementation";
  return "non_seat";
}

/**
 * 六态 readyState 的单一映射实现（onboarding computeReadyState 与 doctor 共用）。
 *
 * @param {object} input
 * @param {string|null} input.requiresCli — backend 映射的 CLI 名（null = 无 CLI 可探）
 * @param {string|null} input.requiresKeyEnv — 声明的 provider key env 名（null = 登录态型）
 * @param {true|false|"unknown"|undefined} input.cli — CLI 探测结果（undefined 视为 unknown）
 * @param {"process_env"|"user_env"|"missing"|"unknown"|undefined} input.key — key 探测结果
 * @returns {"ready"|"missing_cli"|"missing_key"|"missing_both"|"login_based"|"unknown"}
 */
export function deriveReadyState({ requiresCli, requiresKeyEnv, cli, key }) {
  if (!requiresCli) return "unknown"; // backend 无 CLI 映射：无法验证
  const c = cli === true || cli === false ? cli : "unknown";
  if (!requiresKeyEnv) {
    // 登录态型（官方 OAuth / CLI 登录）：只探 CLI，登录态本身无法远程验证。
    if (c === true) return "login_based";
    return c === false ? "missing_cli" : "unknown";
  }
  const k = key === "process_env" || key === "user_env" || key === "missing" ? key : "unknown";
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
 *
 * @param {Array<{id: string, backend: string|null, model: string|null, readyState: string}>} rows
 * @returns {{
 *   tier: "three_seat"|"two_seat"|"none",
 *   available: Array<{id: string, family: string}>,
 *   loginUnverified: string[],
 *   injectedAuth: string[],
 *   probeUnknown: string[],
 *   missingAdversarial: boolean,
 *   insufficientFamilyDiversity: boolean,
 *   singleWorkerVacuous: boolean,
 *   seats: Array<{id: string, family: string}>|null,
 * }}
 *   available：可用席位候选（ready 且席位角色；researcher/tester 等非席位
 *     角色不进席位计数与建议——R9-C C-1）。
 *   loginUnverified / injectedAuth / probeUnknown：席位角色的如实展示清单
 *     （登录态型 / serve 注入型 / 探测未知；非席位角色不进本叙事）。
 *   missingAdversarial：≥2 席位候选但 0 对抗席——仍 three_seat 物理可用，
 *     但两席分配语义要求对抗视角，展示面必附补配提示（doctor 不静默）。
 *   insufficientFamilyDiversity：≥2 可用席位候选且已知族系不足两族（未知
 *     族系不参与判定 ⇒ 含"一已知 + 一未知"、"全未知"——无法确认跨族系，
 *     同样提示）。
 *   singleWorkerVacuous：仅 1 名 worker——它通常就是被审产出的作者
 *     （0019 §3 作者回避），两席建议事实空转，文案必须明说。
 *   seats：建议席位组合（对抗席优先 + 实现席，避同族优先；永不推荐非席位
 *     角色）。不足两名可用席位候选 → null。
 */
export function assessPanelReadiness(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const entries = list.map((row) => ({
    id: String(row?.id ?? "?"),
    family: modelFamilyOf({ modelId: row?.model, backend: row?.backend }),
    readyState: typeof row?.readyState === "string" ? row.readyState : "unknown",
    role: seatRoleOf(row?.id),
    serveInjected: row?.backend === "opencode-serve",
  }));
  // R9-C C-1：席位计数与建议只在席位角色上做；非席位角色不进任何席位面。
  const seatEntries = entries.filter((e) => e.role !== "non_seat");
  const readySeats = seatEntries.filter((e) => e.readyState === "ready");
  const loginUnverified = seatEntries
    .filter((e) => e.readyState === "login_based" && !e.serveInjected)
    .map((e) => e.id);
  const injectedAuth = seatEntries
    .filter((e) => e.readyState === "login_based" && e.serveInjected)
    .map((e) => e.id);
  const probeUnknown = seatEntries.filter((e) => e.readyState === "unknown").map((e) => e.id);
  const knownFamilies = readySeats.map((e) => e.family).filter((f) => f !== UNKNOWN_FAMILY);
  return {
    tier: readySeats.length >= 2 ? "three_seat" : readySeats.length === 1 ? "two_seat" : "none",
    available: readySeats.map((e) => ({ id: e.id, family: e.family })),
    loginUnverified,
    injectedAuth,
    probeUnknown,
    missingAdversarial:
      readySeats.length >= 2 && !readySeats.some((e) => e.role === "adversarial"),
    insufficientFamilyDiversity: readySeats.length >= 2 && new Set(knownFamilies).size < 2,
    singleWorkerVacuous: list.length === 1,
    seats: suggestSeatPair(readySeats),
  };
}

/**
 * 建议席位组合（纯展示建议，选位权在 Lead）：从席位候选池取——有对抗席时
 * 必含一名对抗席（0019/0023 两席分配语义），另一席优先实现席且避同族；
 * 单一类席位（全对抗/全实现）时优先跨已知族系对，找不到退化为前两名
 * （同族/含未知也如实展示，由 insufficientFamilyDiversity 提示）。
 * 永不推荐非席位角色（assessPanelReadiness 已过滤，此处按契约再守一道）。
 * @param {Array<{id: string, family: string, role: string}>} readySeats
 * @returns {Array<{id: string, family: string}>|null}
 */
function suggestSeatPair(readySeats) {
  if (readySeats.length < 2) return null;
  const adversarial = readySeats.filter((e) => e.role === "adversarial");
  const implementation = readySeats.filter((e) => e.role === "implementation");
  if (adversarial.length > 0 && implementation.length > 0) {
    const adv = adversarial[0];
    const partner = implementation.find((e) => isDiverseFamily(adv.family, e.family))
      ?? implementation[0];
    return [{ id: adv.id, family: adv.family }, { id: partner.id, family: partner.family }];
  }
  const first = readySeats[0];
  const diverse = readySeats.find((e) => e !== first && isDiverseFamily(first.family, e.family));
  const second = diverse ?? readySeats.find((e) => e !== first);
  return [{ id: first.id, family: first.family }, { id: second.id, family: second.family }];
}

/** 两族系均已知且不同（未知族系不参与多样性判定）。 */
function isDiverseFamily(a, b) {
  return a !== UNKNOWN_FAMILY && b !== UNKNOWN_FAMILY && a !== b;
}
