// scripts/reliability/checkStates.mjs
//
// ADR-0032 §8：检查结果五态闭集的一等公民模型（pass / fail / not-applicable /
// blocked / inconclusive）。纯模块：零 I/O、零环境依赖——组合层
// （certification.mjs / run-reliability.mjs）与组件层（componentDrills.mjs /
// componentLedger.mjs）共同消费，两层都不各自发明第二套状态词汇。
//
// 字段名纪律：检查级五态字段叫【state】（stateReason 承载原因）——绝不叫
// "status"："status" 是组合层保留键（componentLedger 的
// assertNoCompositionLayerLeak 对任何层级的 "status" 键零容忍，certified/
// conditional 是组合层独占词）——检查五态与组合层状态闭集是两个词汇面，
// 字段名隔离是最便宜的机械防混淆。
//
// 语义（闭集逐成员，判定面在各消费侧实现）：
//   pass           —— 判定通过（唯一置绿的态）。
//   fail           —— 判定失败（judged negative）。
//   not-applicable —— 不适用：必须带原因（stateReason 非空）；不置绿、不算失败、
//                     不贡献任何能力轴（certifyCase 的 capabilities 聚合跳过）；
//                     满足 required-category 的覆盖语义（检查跑了、如实话不适用——
//                     TD-87 Owner 裁定的症状解除由此保留，能力绿不再伪造）。
//   blocked        —— 外部阻塞（夹具/基础设施不可用）：必须带原因；不置绿、不算
//                     失败；组合层 certifyCase 映射 case blocked；不满足类目覆盖。
//   inconclusive   —— 证据不足以下结论：必须带原因；不置绿、不算失败；不满足
//                     类目覆盖（fail-closed：无法证明即不得覆盖）。
//
// 兼容形状：历史 check 只有布尔 pass（无 state）——checkStateOf 按 pass 派生
//（true→pass，false→fail）。显式 state 越闭集即抛错（fail-closed，绝不静默
// 读成两态之一）。

// 检查结果五态闭集（ADR-0032 §8）。
export const CHECK_STATES = Object.freeze([
  "pass",
  "fail",
  "not-applicable",
  "blocked",
  "inconclusive",
]);

// 必须携带 stateReason 的三态（N/A / blocked / inconclusive——ADR-0032 §8
// "N/A 必须有原因"的机器化；blocked/inconclusive 同纪律收编）。
export const REASONED_CHECK_STATES = Object.freeze([
  "not-applicable",
  "blocked",
  "inconclusive",
]);

function assertReason(reason, state) {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error(
      `checkStates: a "${state}" check requires a non-empty stateReason (ADR-0032 §8: N/A must carry a reason)`,
    );
  }
}

/**
 * 构造一个 not-applicable 检查。原因必填（空原因当场抛错）。
 * pass 派生为 false（not-applicable 绝不置绿）；capability 字段仅用于指认
 * 哪根轴不适用——聚合侧（aggregateCapabilities / componentResultFromChecks）
 * 按状态跳过，不读它置绿。
 */
export function naCheck(name, reason, category, extra = {}) {
  assertReason(reason, "not-applicable");
  return {
    name,
    pass: false,
    state: "not-applicable",
    stateReason: reason,
    category,
    detail: `not applicable: ${reason}`,
    ...extra,
  };
}

/** 构造一个 blocked 检查（外部阻塞——夹具/基础设施不可用）。原因必填。 */
export function blockedCheck(name, reason, category, extra = {}) {
  assertReason(reason, "blocked");
  return {
    name,
    pass: false,
    state: "blocked",
    stateReason: reason,
    category,
    detail: `blocked: ${reason}`,
    ...extra,
  };
}

/** 构造一个 inconclusive 检查（证据不足以下结论）。原因必填。 */
export function inconclusiveCheck(name, reason, category, extra = {}) {
  assertReason(reason, "inconclusive");
  return {
    name,
    pass: false,
    state: "inconclusive",
    stateReason: reason,
    category,
    detail: `inconclusive: ${reason}`,
    ...extra,
  };
}

/**
 * 派生检查状态：显式 state（闭集内）优先；无 state 的 legacy 形状按布尔 pass
 * 派生（true→pass，false→fail）。state 越闭集 → 抛错（fail-closed）。
 */
export function checkStateOf(check) {
  if (check?.state !== undefined) {
    if (!CHECK_STATES.includes(check.state)) {
      throw new Error(
        `checkStates: check "${String(check?.name)}" carries state ${JSON.stringify(check.state)} outside the ADR-0032 §8 closed set [${CHECK_STATES.join("|")}]`,
      );
    }
    return check.state;
  }
  return check?.pass === true ? "pass" : "fail";
}

/**
 * 磁盘/边界形状校验（fail-closed）：
 *   - 显式 state 必须 ∈ 闭集；
 *   - REASONED 三态必须带非空 stateReason；
 *   - 显式 state 与布尔 pass 必须一致（pass === (state === "pass")）——
 *     自相矛盾的检查记录直接抛错，不静默择一。
 */
export function assertCheckStateShape(check, label = "check") {
  if (check?.state === undefined) return true;
  const state = checkStateOf(check);
  if (REASONED_CHECK_STATES.includes(state)) {
    if (typeof check.stateReason !== "string" || check.stateReason.trim().length === 0) {
      throw new Error(
        `${label} "${String(check?.name)}": state "${state}" requires a non-empty stateReason (ADR-0032 §8)`,
      );
    }
  }
  if (check.pass !== (state === "pass")) {
    throw new Error(
      `${label} "${String(check?.name)}": pass=${JSON.stringify(check.pass)} contradicts state "${state}" (pass must equal (state === "pass"))`,
    );
  }
  return true;
}
