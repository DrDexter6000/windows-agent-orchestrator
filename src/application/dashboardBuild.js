// src/application/dashboardBuild.js
//
// 第 145b 批（决定 0131 第 2 条）：复用/状态里的 build 比对——三种结果。
//
// 不另造 build 哈希系统：快照来自 serverBuildFacts（src/ 树哈希 + dirty 状态）。
// 比对规则（与会审一致）：
//   same      两边都读得出（readable）、都干净（dirty === false）、src 树哈希相同；
//   different 两边都读得出、都干净、src 树哈希不同；
//   unknown   其余一切（有一边读不出、有一边脏、字段缺失、没有记录）——
//             既不说相同也不说不同，界面只提示“无法确认实例版本，建议 restart”。
//
// 架构契约：纯函数；不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

/**
 * serverBuildFacts 的完整事实 → 常驻实例记录里的 build 快照
 * { readable, srcTree, dirty }。srcTree 取启动时的树（HEAD:src，进程从它引导）；
// dirty 取启动时的 src/ 脏标记；readable 与 serverBuildFacts 同义（两侧树哈希都读出）。
 *
 * @param {object} facts — readServerBuildFacts() 的输出
 * @returns {{readable: boolean, srcTree: string|null, dirty: boolean|null}}
 */
export function buildSnapshotFromFacts(facts) {
  if (facts === null || typeof facts !== "object") return { readable: false, srcTree: null, dirty: null };
  const treeShape = (v) => (typeof v === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(v) ? v : null);
  const srcTree = treeShape(facts.srcTreeAtStart);
  const dirty = typeof facts.srcDirtyAtStart === "boolean" ? facts.srcDirtyAtStart : null;
  // 记录侧的可读性：启动时的树哈希与 dirty 都读出了，快照才可比较；当下侧的
  // 可读性由比对时的另一个快照自己负责。
  const readable = srcTree !== null && dirty !== null;
  return { readable, srcTree, dirty };
}

/**
 * 两个快照的三态比对。
 *
 * @param {{readable: boolean, srcTree: string|null, dirty: boolean|null}|null} stored
 * @param {{readable: boolean, srcTree: string|null, dirty: boolean|null}|null} current
 * @returns {"same"|"different"|"unknown"}
 */
export function compareDashboardBuild(stored, current) {
  const ok = (snap) => snap !== null && typeof snap === "object"
    && snap.readable === true
    && typeof snap.srcTree === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(snap.srcTree)
    && snap.dirty === false;
  if (!ok(stored) || !ok(current)) return "unknown";
  return stored.srcTree === current.srcTree ? "same" : "different";
}
