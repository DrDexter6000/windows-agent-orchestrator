// src/application/upstreamSessionRelease.js
//
// TD-250（A1b，决定 0056，2026-10-10）+ TD-251（W1b，决定 0057，2026-10-11）：
// delivery 验收（run.delivery_accepted）后的线系卫生——**两件独立释放**：
//   Part A 上游会话（0056）：accepted=线系不可变（runContinue parent_accepted
//     拒项）⇒ 会话可证不可续 ⇒ best-effort :delete（能力位门控）。
//   Part B 线系 worktree（0057，会审 consult_202610110709306023ro7zi 修正案）：
//     accepted 后放树。**四道门**（双席反例全收口）：
//     ①归属/tip 门——git 当前分支 === wao/<runId> 且 HEAD === deliveryCommit
//       （父候选 undecided 被续接出子轮时树已切 wao/<childRunId> ⇒ not_tip 跳过，
//       绝不删掉子轮正使用的树——opus/sol 同款反例）；
//     ②路径证明——目标路径唯一来自本 run 绑定的 run.started.worktreePath，
//       且 lstat 非符号链接/junction（rmSync 兜底会穿透 reparse 目标——sol），
//       且父目录名 === .wao-worktrees（段级、大小写折叠）；
//     ③独立释放——Part B 不被 Part A 的任何提前返回挡住（无会话/无能力/注册表
//       故障都只影响 A；两段各自独立 try，一段失败不影响另一段——sol）；
//     ④事后验证——removeWorktree 恒 resolve 自吞错，成功判定 = existsSync 为假
//       （"不抛错≠已删除"——opus）；失败记 still_present。
//     分支保留：git worktree remove 不删 wao/<runId> 分支（accepted commit 可达
//     性靠它维持——opus）；测试钉住"删树后分支仍在"。
//
// 事件族（一果一名，两 Part 共用命名空间；信封只投影标签）：
//   会话：run.upstream_session_deleted / _already_gone / _delete_skipped{reason} /
//         _delete_failed{reason[,code]}（0056 合同不变）
//   树：  run.worktree_released / _already_gone / _release_skipped{reason:
//         not_tip|unproven_path} / _release_failed{reason: still_present}
//
// best-effort：外层吞错（decideRunDelivery 侧+本函数内），绝不逆转 accepted。
// 崩溃补偿：重复 decide 返回 already_decided 不重跑释放——accept 落盘后崩溃
// 留下的树由周期普查兜底（.dev 脚本，TD-251 附带）。
//
// 分层：application(1) → registry/transcript/delivery/isolation(core,2) 与
// backends/factory(3) 均为下向静态 import（layering.test.js 语义表）。

import { existsSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readRegistry } from "../registry.js";
import { backendFor } from "../backends/factory.js";
import { gitChildEnv } from "../delivery.js";
import { removeWorktree } from "../isolation.js";

const RELEASE_FAILED_REASONS = Object.freeze([
  "bad_request", "timeout", "http_error", "upstream_rejected",
]);

/**
 * 从转录事件里取本 run 最后一条绑定的 session.created.backendSessionId。
 * 取 LAST-bound（与续接读取器的胜出规则同向）。
 * @param {Array<object>} events
 * @returns {string|null}
 */
export function sessionIdFromEvents(events) {
  if (!Array.isArray(events)) return null;
  let found = null;
  for (const e of events) {
    if (e && e.type === "session.created"
      && typeof e.backendSessionId === "string" && e.backendSessionId.length > 0) {
      found = e.backendSessionId;
    }
  }
  return found;
}

/**
 * 从转录事件取本 run 绑定的 run.started.worktreePath / cwd（删除目标与受信
 * 仓库锚——均来自绑定事实，不接受调用方传路径）。
 * @param {Array<object>} events
 * @returns {{worktreePath:string|null, repoCwd:string|null}}
 */
export function worktreeFactsFromEvents(events) {
  if (!Array.isArray(events)) return { worktreePath: null, repoCwd: null };
  let worktreePath = null;
  let repoCwd = null;
  for (const e of events) {
    if (e && e.type === "run.started") {
      if (typeof e.worktreePath === "string" && e.worktreePath.length > 0) worktreePath = e.worktreePath;
      if (typeof e.cwd === "string" && e.cwd.length > 0) repoCwd = e.cwd;
    }
  }
  return { worktreePath, repoCwd };
}

/**
 * 把 backend.releaseSession 的闭集结果映射为事件名+载荷（A1/A1b 共同语义）。
 * @param {string} sessionId
 * @param {{outcome:string, reason?:string, code?:number}|null} res
 * @returns {{type:string, payload:object}}
 */
export function releaseOutcomeEvent(sessionId, res) {
  if (res?.outcome === "deleted") {
    return { type: "run.upstream_session_deleted", payload: { backendSessionId: sessionId } };
  }
  if (res?.outcome === "already_gone") {
    return { type: "run.upstream_session_already_gone", payload: { backendSessionId: sessionId } };
  }
  if (res?.outcome === "skipped_busy") {
    return {
      type: "run.upstream_session_delete_skipped",
      payload: { backendSessionId: sessionId, reason: "busy" },
    };
  }
  const reason = RELEASE_FAILED_REASONS.includes(res?.reason) ? res.reason : "http_error";
  const payload = { backendSessionId: sessionId, reason };
  if (Number.isInteger(res?.code)) payload.code = res.code;
  return { type: "run.upstream_session_delete_failed", payload };
}

/**
 * 树释放的 tip 门（纯函数，测试钉）：路径证明 + git 归属证明的判定核心。
 * 返回闭集："no_worktree"（无绑定事实——零事件）| "gone"（已不在盘）|
 * "unproven_path" | "not_tip" | "ready"。
 * @param {object} p
 * @param {string|null} p.worktreePath
 * @param {string} p.runId
 * @param {string|null} p.deliveryCommit - 验收 deliveryCommit（全形哈希）
 * @param {Function} [p.gitRev] - 测试注入：(path, args) => stdout（默认真实 git）
 * @param {Function} [p.lstatFn] - 测试注入
 * @param {Function} [p.existsFn] - 测试注入
 */
export function worktreeReleaseVerdict({
  worktreePath, runId, deliveryCommit,
  gitRev = (path, args) => execFileSync("git", ["-C", path, ...args], {
    env: gitChildEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10_000,
  }).toString().trim(),
  lstatFn = lstatSync,
  existsFn = existsSync,
}) {
  if (typeof worktreePath !== "string" || worktreePath.length === 0) return "no_worktree";
  if (!existsFn(worktreePath)) return "gone";
  // 路径证明①：父目录段名 = .wao-worktrees（大小写折叠、双分隔符）。
  const norm = worktreePath.replace(/\//g, "\\").replace(/\\+$/, "");
  const idx = norm.lastIndexOf("\\");
  const parent = idx > 0 ? norm.slice(0, idx) : "";
  const pidx = parent.lastIndexOf("\\");
  const parentName = pidx >= 0 ? parent.slice(pidx + 1) : parent;
  if (parentName.toLowerCase() !== ".wao-worktrees") return "unproven_path";
  // 路径证明②：非符号链接/junction（Node lstat 对 junction 报 isSymbolicLink——
  // rmSync 兜底会穿透 reparse 目标，sol 反例）。
  let st;
  try {
    st = lstatFn(worktreePath);
  } catch {
    return "unproven_path";
  }
  if (!st?.isDirectory() || st.isSymbolicLink()) return "unproven_path";
  if (typeof runId !== "string" || runId.length === 0) return "unproven_path";
  // 归属证明（tip 门）：当前分支 === wao/<runId> 且 HEAD === deliveryCommit。
  if (typeof deliveryCommit !== "string" || deliveryCommit.length < 7) return "not_tip";
  let branch;
  let head;
  try {
    branch = gitRev(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    head = gitRev(worktreePath, ["rev-parse", "HEAD"]);
  } catch {
    return "not_tip"; // git 不可读=归属不可证，绝不删除
  }
  if (branch !== `wao/${runId}`) return "not_tip";
  if (head.toLowerCase() !== deliveryCommit.toLowerCase()) return "not_tip";
  return "ready";
}

/**
 * 构造验收路径的线系释放函数（decideRunDelivery 的可选依赖；两件独立）。
 * 返回 async ({ runId, agentId, events, transcript, deliveryCommit }) =>
 *   { session: boolean, worktree: string }——session=true 写了恰一条会话事件；
 *   worktree ∈ {"none","released","already_gone","skipped_not_tip",
 *   "skipped_unproven_path","failed"}（各对应恰一条树事件；"none"=零事件）。
 *
 * @param {object} p
 * @param {string} p.registryPath
 * @param {Function} [p.readRegistryFn]
 * @param {Function} [p.backendForFn]
 * @param {Function} [p.removeWorktreeFn] - 测试注入（默认 isolation.removeWorktree）
 * @param {Function} [p.gitRev] - 透传 worktreeReleaseVerdict
 */
export function makeAcceptedSessionRelease({
  registryPath, readRegistryFn, backendForFn, removeWorktreeFn = removeWorktree, gitRev,
}) {
  const _readRegistry = readRegistryFn ?? readRegistry;
  const _backendFor = backendForFn ?? backendFor;
  return async function acceptedSessionRelease({
    runId, agentId, events, transcript, deliveryCommit,
  }) {
    const out = { session: false, worktree: "none" };

    // ===== Part A：上游会话（0056 语义，独立 try）=====
    try {
      const sessionId = sessionIdFromEvents(events);
      if (sessionId && typeof agentId === "string" && agentId.length > 0 && agentId !== "unknown") {
        let registry = null;
        try {
          registry = await _readRegistry(registryPath);
        } catch {
          registry = null;
        }
        let agent = null;
        try {
          agent = registry?.getAgent?.(agentId) ?? null;
        } catch {
          agent = null;
        }
        const backend = agent ? _backendFor(agent) : null;
        if (backend?.supportsSessionRelease === true && typeof backend?.releaseSession === "function") {
          const res = await backend.releaseSession(agent, sessionId);
          const { type, payload } = releaseOutcomeEvent(sessionId, res);
          await transcript.append(type, payload);
          out.session = true;
        }
      }
    } catch {
      // Part A 失败不阻断 Part B（sol：独立释放）。
    }

    // ===== Part B：线系 worktree（0057 语义，独立 try）=====
    try {
      const { worktreePath } = worktreeFactsFromEvents(events);
      const verdict = worktreeReleaseVerdict({ worktreePath, runId, deliveryCommit, gitRev });
      if (verdict === "no_worktree") {
        // 无绑定事实（非隔离形态/legacy）：零事件（合同）。
      } else if (verdict === "gone") {
        await transcript.append("run.worktree_already_gone", {});
        out.worktree = "already_gone";
      } else if (verdict === "unproven_path") {
        await transcript.append("run.worktree_release_skipped", { reason: "unproven_path" });
        out.worktree = "skipped_unproven_path";
      } else if (verdict === "not_tip") {
        await transcript.append("run.worktree_release_skipped", { reason: "not_tip" });
        out.worktree = "skipped_not_tip";
      } else {
        await removeWorktreeFn(worktreePath);
        if (existsSync(worktreePath)) {
          await transcript.append("run.worktree_release_failed", { reason: "still_present" });
          out.worktree = "failed";
        } else {
          await transcript.append("run.worktree_released", {});
          out.worktree = "released";
        }
      }
    } catch {
      // Part B 意外抛错路径统一 existsSync 复检收口（席位评审附评——抛错≠完好，
      // 可能已半删；按 still_present 上报，普查按可疑处理）。绝不逆转 accepted。
      try {
        const { worktreePath: p } = worktreeFactsFromEvents(events);
        if (p && existsSync(p)) {
          await transcript.append("run.worktree_release_failed", { reason: "still_present" });
          out.worktree = "failed";
        }
      } catch { /* 双重失败：吞掉 */ }
    }
    return out;
  };
}
