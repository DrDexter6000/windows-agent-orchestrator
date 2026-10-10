// src/application/nestedDispatchGuard.js
//
// 0047 L1：防向下派发——确定性控制面门（决定 0047，Owner 2026-10-06 指令
// "必须阻止 worker agent 向下再次使用 wao 派发任务"）。
//
// 动机（当日实证）：kimi 会审席在任务内加载了用户级 wao-orchestrator skill 并
// 经 wao CLI 自组了一场内层三席会审——worker 向下派发真实发生且未被阻止。
// 危害：无界递归派发/token 失控/编排权旁落（不变量 4：语义分解与派发归 Lead）。
//
// 双层机制：
//   L1 本门（确定性，真牙齿）：派发入口检测 worker 上下文并拒绝——
//     a) 环境标记 WAO_IN_WORKER=1：WAO 派生的 backend 子进程 env 注入
//        （processBackend/deepSeekAcp spawn env），worker 的 shell/子进程/
//        其会话拉起的 MCP 服务实例全链继承；
//     b) cwd 落在 .wao-worktrees 目录内：覆盖 HTTP-attach 型 backend
//        （kimi-web：worker 工具执行在 serve 侧，env 标记不可达，但其
//        工作目录绑定在本 run 的 worktree 路径上）。
//     逃生口：WAO_ALLOW_NESTED_DISPATCH=1（Lead 显式豁免，如 worktree 内
//     合法测试场景；文档在案）。
//   L2 合同提示（软层）：角色合同合成面统一附加 WQ-03 禁令条款（见
//     src/application/roleContract.js）——提示模型不要尝试；L1 保证即使
//     尝试也确定性失败。
//
// 门的三处消费点（同一判定，零分叉）：
//   RunManager.start（一切派发的单一咽喉：CLI run/spawn、MCP run_dispatch、
//   consult 扇出、resume）；MCP run_dispatch/run_consult/run_continue 处理器头
//   （worker 会话拉起的 MCP 服务实例在 side effect 之前被拒）。
//   TD-240 追加第四处：runs verify-commit 服务头（src/application/
//   runVerifyCommit.js）——env 准备之前先过本门，防本 CLI 成为 worker 获取
//   净化环境/嵌套豁免的入口（Lead 主检出语境正常放行）。
import { resolve as resolvePath } from "node:path";
// P4 分层修（2026-10-10 摩擦处置批）：豁免变量名常量的 SSOT 迁 envPolicy.js
// （shared 内核——backends 层消费该名字做注入拒收时不再产生 core 上向边；
// 本守卫 re-export，既有消费方零改动）。判定语义零变更。
import { NESTED_DISPATCH_BYPASS_ENV } from "./envPolicy.js";

export const NESTED_DISPATCH_ENV_MARKER = "WAO_IN_WORKER";
export { NESTED_DISPATCH_BYPASS_ENV };
export const WORKTREE_ROOT_DIR_NAME = ".wao-worktrees";

/**
 * 判定给定 (env, cwd) 是否处于 worker 上下文（应拒绝向下派发）。
 * 纯函数（env/cwd 注入，测试友好）。
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {null | {reason: "env-marker" | "worktree-cwd", detail: string}}
 *   null = 非_worker 上下文（放行到后续正常校验）；非 null = 应拒绝。
 */
export function nestedDispatchContext(env = process.env, cwd = process.cwd()) {
  if (env?.[NESTED_DISPATCH_BYPASS_ENV] === "1") return null; // Lead 显式豁免
  if (env?.[NESTED_DISPATCH_ENV_MARKER] === "1") {
    return { reason: "env-marker", detail: `${NESTED_DISPATCH_ENV_MARKER}=1 in process env (WAO-spawned worker lineage)` };
  }
  const normalized = String(cwd ?? "").replace(/\\/g, "/");
  if (normalized.split("/").includes(WORKTREE_ROOT_DIR_NAME)) {
    return { reason: "worktree-cwd", detail: `cwd is inside a ${WORKTREE_ROOT_DIR_NAME}/ worker worktree` };
  }
  return null;
}

/** 固定拒绝文案（typed、可被测试钉；不回显任何调用方可控内容）。 */
export function nestedDispatchRefusalText(ctx) {
  return "nested dispatch refused (decision 0047): a WAO worker must not dispatch work downward "
    + "through WAO (orchestration belongs to the Lead — invariant 4). "
    + `Detected worker context: ${ctx?.reason ?? "unknown"} (${ctx?.detail ?? "no detail"}). `
    + "Complete the bounded task you were given instead. "
    + "(Lead-sanctioned exceptions exist; ask the Lead — the mechanism is deliberately not named here.)";
}

/** 便捷断言：worker 上下文即抛（供入口消费）。 */
export function assertNotNestedDispatchContext(env = process.env, cwd = process.cwd()) {
  const ctx = nestedDispatchContext(env, cwd);
  if (ctx !== null) throw new Error(nestedDispatchRefusalText(ctx));
  return null;
}

// 保留路径解析 import 供未来按绝对路径前缀精确化（当前按路径组件判定，
// 任何位置的 .wao-worktrees 组件都命中——宁拒勿漏是本门取向）。
void resolvePath;
