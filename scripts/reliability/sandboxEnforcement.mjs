// scripts/reliability/sandboxEnforcement.mjs
//
// 决定 0086：sandboxEnforcement drill 的纯判定内核（OS 写沙箱的活体执行取证）。
//
// 对声明 enforcesWriteSandbox 的 backend（当前 codex），越界写拦截能力的活体
// 证据不经模型：backend 的 probeWriteSandbox 用 `codex sandbox -P :workspace
// -C <树>` 在与运行时同一套 Windows 沙箱里执行固定写命令，对工作树内与树外
// （%TEMP% 之外的外部目录）各写一次。写命令自己报告结果，backend 把它归成
// outcome："written"（写成）/ "denied"（被访问控制拒绝）/ "error"（其他错误）/
// "not_run"（没有报告——命令没在沙箱里跑起来）。本内核消费探测结果产出两条
// operational 检查；真实探测与夹具留在 scripts/reliability/drills.mjs 的 glue。
//
// 判定语义（ADR-0032 §8 五态；本 drill 不使用 N/A）：
//   - pass（sandboxInsideWriteAllowed）：outcome written、退出码 0、文件在场；
//   - pass（sandboxOutsideWriteDenied）：outcome denied、退出码非零、文件确实
//     不存在（fileExists === false）——"命令跑了、写入被访问控制拒绝、没落盘"
//     三者都有正面证据才算；
//   - fail：树外文件落盘，或树外写报告写成；树内写被访问控制拒绝；
//   - inconclusive：探测不可用；任一侧没有报告（not_run，例如子进程起不来）、
//     报告其他错误、缺退出码或缺 fileExists、报告与观察矛盾——"没测到"绝不记
//     pass；
//   - blocked：派发被外部因素阻塞——由组合入口经 classifyExternalBlocker 判定后
//     记 blockedCheck；本内核不读派发错误的分类面（分层：内核只判证据）。
//
// 纯模块：零 I/O。探测结果形状由 backend 的 probeWriteSandbox 产出
// （{ available, reason?, inside?, outside? }，inside/outside = { exitCode,
// fileExists, outcome, output }）。

import { inconclusiveCheck } from "./checkStates.mjs";

const CAPABILITY = "sandboxEnforcement";

function passCheck(name, detail) {
  return { name, pass: true, category: "operational", detail, capability: CAPABILITY };
}

function failCheck(name, detail) {
  return { name, pass: false, category: "operational", detail, capability: CAPABILITY };
}

function uncertain(name, detail) {
  return inconclusiveCheck(name, detail, "operational", { capability: CAPABILITY });
}

function describe(side) {
  return `outcome=${side?.outcome ?? "?"}, exit ${side?.exitCode ?? "?"}, fileExists=${side?.fileExists ?? "?"}${side?.output ? `: ${side.output}` : ""}`;
}

function insideCheckFor(inside) {
  const name = "sandboxInsideWriteAllowed";
  if (!inside) return uncertain(name, "inside probe produced no result");
  if (inside.outcome === "written" && inside.exitCode === 0 && inside.fileExists === true) {
    return passCheck(name, "in-bounds write executed under the sandbox and landed on target (written, exit 0, file present)");
  }
  if (inside.outcome === "denied") {
    return failCheck(name, `the sandbox denied a write inside its own root (${describe(inside)})`);
  }
  return uncertain(name, `in-bounds write not proven (${describe(inside)})`);
}

function outsideCheckFor(outside) {
  const name = "sandboxOutsideWriteDenied";
  if (!outside) return uncertain(name, "outside probe produced no result");
  if (outside.fileExists === true || outside.outcome === "written") {
    return failCheck(name, `out-of-bounds write was not stopped (${describe(outside)})`);
  }
  if (outside.outcome === "denied" && typeof outside.exitCode === "number" && outside.exitCode !== 0
    && outside.fileExists === false) {
    return passCheck(name, `out-of-bounds write ran and was denied by access control; the file does not exist (${describe(outside)})`);
  }
  return uncertain(name, `out-of-bounds denial not proven (${describe(outside)})`);
}

/**
 * sandboxEnforcement drill 判定：probeWriteSandbox 结果 → operational checks
 * （形状与 drills.mjs 的 check() 一致；inconclusive 态带 stateReason——词汇来自
 * checkStates.mjs，两层共用）。
 *
 * @param {object} [input]
 * @param {object|null} [input.probeResult] — backend.probeWriteSandbox 的返回
 * @returns {Array<{name, pass, category, detail, capability}>}
 */
export function sandboxEnforcementChecks({ probeResult = null } = {}) {
  // 探测不可用/缺结果 → 两条 inconclusive（写明原因），不红成"机制失效"，也绝不记 pass。
  if (!probeResult || probeResult.available !== true) {
    const reason = probeResult?.reason
      ? String(probeResult.reason)
      : "probe result missing — the sandbox probe did not produce a result";
    return [
      uncertain("sandboxInsideWriteAllowed", `sandbox probe unavailable: ${reason}`),
      uncertain("sandboxOutsideWriteDenied", `sandbox probe unavailable: ${reason}`),
    ];
  }
  return [insideCheckFor(probeResult.inside ?? null), outsideCheckFor(probeResult.outside ?? null)];
}
