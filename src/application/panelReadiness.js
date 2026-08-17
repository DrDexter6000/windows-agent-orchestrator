// src/application/panelReadiness.js
//
// 三席会审就绪分级推导（R9 / 决策 0023）——单一实现（SSOT）。
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
// 分级语义（0023）：
//   three_seat  ≥2 名"可用"副审（readyState=ready）→ 三席（Lead 主审 + 两副审）
//   two_seat    恰 1 名可用副审 → 两席次之推荐
//   none        0 名可用副审 → 跳过提示（--panel-skip-reason 登记）
// login_based/unknown 不计入"可用"但如实展示"登录态未验证/探测未知"——
// 文案不得把登录态当已验证讲（auditor 即 login_based）。
// 未知族系 ≠ 同族：跨族系判断只统计已知族系（modelFamily UNKNOWN_FAMILY
// 不参与多样性判定）。

import { modelFamilyOf, UNKNOWN_FAMILY } from "./modelFamily.js";

/** 三席会审可登记 panel 字段的阶段闭集（与 waoStage.js 的 stage 门控一致，纯展示引用）。 */
export const PANEL_STAGES = Object.freeze([2, 4]);

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
 *   probeUnknown: string[],
 *   sameFamily: boolean,
 *   singleWorkerVacuous: boolean,
 *   seats: Array<{id: string, family: string}>|null,
 * }}
 *   sameFamily：≥2 可用副审且已知族系不足两族（未知族系不参与判定 ⇒ 含
 *     "一已知 + 一未知"、"全未知"——无法确认跨族系，同样提示）。
 *   singleWorkerVacuous：仅 1 名 worker——它通常就是被审产出的作者
 *     （0019 §3 作者回避），两席建议事实空转，文案必须明说。
 */
export function assessPanelReadiness(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const entries = list.map((row) => ({
    id: String(row?.id ?? "?"),
    family: modelFamilyOf({ modelId: row?.model, backend: row?.backend }),
    readyState: typeof row?.readyState === "string" ? row.readyState : "unknown",
  }));
  const available = entries.filter((e) => e.readyState === "ready");
  const loginUnverified = entries.filter((e) => e.readyState === "login_based").map((e) => e.id);
  const probeUnknown = entries.filter((e) => e.readyState === "unknown").map((e) => e.id);
  const knownFamilies = available.map((e) => e.family).filter((f) => f !== UNKNOWN_FAMILY);
  return {
    tier: available.length >= 2 ? "three_seat" : available.length === 1 ? "two_seat" : "none",
    available,
    loginUnverified,
    probeUnknown,
    sameFamily: available.length >= 2 && new Set(knownFamilies).size < 2,
    singleWorkerVacuous: list.length === 1,
    seats: suggestSeatPair(available),
  };
}

/**
 * 建议席位组合（纯展示建议，选位权在 Lead）：优先跨已知族系的一对；
 * 找不到跨族系对时退化为前两名（同族/含未知也如实展示，由 sameFamily 提示）。
 * @returns {Array<{id, family}>|null}
 */
function suggestSeatPair(available) {
  if (available.length < 2) return null;
  const first = available[0];
  const diverse = available.find((e) =>
    e !== first && isDiverseFamily(first.family, e.family));
  if (diverse) return [first, diverse];
  return [first, available.find((e) => e !== first)];
}

/** 两族系均已知且不同（未知族系不参与多样性判定）。 */
function isDiverseFamily(a, b) {
  return a !== UNKNOWN_FAMILY && b !== UNKNOWN_FAMILY && a !== b;
}
