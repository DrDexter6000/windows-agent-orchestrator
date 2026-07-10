import { topoSort } from "./schema.js";
import { getHandler } from "./handlers.js";
import { buildUpstreamContext } from "./handoff.js";
import { getWaoDir, validateWaoDir } from "../waoDir.js";
import { writeStateSnapshot } from "../waoState.js";

/**
 * Workflow 核心调度引擎（M5-4）。
 *
 * 职责：
 *   - 解析 DAG 拓扑（topoSort 分层）
 *   - 按层执行（同层并行，层间串行）
 *   - 收集 NodeResult，构造 upstream 上下文（传引用不传内容）
 *   - 失败传播（节点 failed → 下游不执行）
 *   - router 条件边（选择下游路径）
 *
 * 不碰 backend/状态机（通过 RunManager）。
 * 不做 worktree 管理（RunManager 管）。
 */

export class WorkflowEngine {
  constructor({ runManager, transcript = null }) {
    this.runManager = runManager;
    this.transcript = transcript; // 可选：workflow 级 transcript
  }

  /**
   * 执行 workflow。
   * @param {object} workflowDef defineWorkflow 的输出
   * @param {object} [options] { input, isolate, ... }
   * @returns {Promise<{completed: boolean, nodeResults: Object}>}
   */
  async execute(workflowDef, options = {}) {
    const layers = topoSort(workflowDef);
    const nodeMap = new Map(workflowDef.nodes.map((n) => [n.id, n]));
    const edgeMap = buildEdgeMap(workflowDef);

    const completedResults = new Map(); // nodeId → NodeResult
    const executed = new Set();          // 已执行的 nodeId
    const skipped = new Set();           // 被跳过的 nodeId（失败传播 / router 未选）

    // S3-2 集成：解析 .wao/（若已 init，节点完成时落盘状态快照——边走边写，断点续接）
    // 未 init → waoDir=null，跳过快照（不报错、不阻断，决策1=C 的兜底逻辑）
    const waoOverride = options.stateDir;
    const cwd = options.cwd ?? process.cwd();
    const waoCheck = validateWaoDir(cwd, waoOverride);
    const waoDir = waoCheck.ok ? getWaoDir(cwd, waoOverride) : null;
    const allNodeIds = workflowDef.nodes.map((n) => n.id);

    await this._log("workflow.started", {
      workflowId: workflowDef.id,
      nodeCount: workflowDef.nodes.length,
      layers,
    });

    let overallCompleted = true;

    // TD-30：workflow 级整体超时。每层开始前检查 deadline，超时则截断剩余层。
    // 不打断正在执行的层（in-flight 节点靠自身 waitTimeout 兜底），只阻止进入新层。
    // 未传 workflowTimeout → deadline 为 Infinity，行为与原有一致（向后兼容）。
    const wfDeadline = Number.isFinite(options.workflowTimeout)
      ? Date.now() + options.workflowTimeout
      : Infinity;
    let timedOut = false;

    let pendingRoutes = null; // 上一层 router 激活的后继（影响当前层）

    for (const layer of layers) {
      // deadline 检查：超时则停止进入新层
      if (Date.now() >= wfDeadline) {
        timedOut = true;
        overallCompleted = false;
        break;
      }
      // 过滤掉被跳过的节点
      const runnable = layer.filter((id) => !skipped.has(id) && !executed.has(id));

      // router 路由过滤：若上层有 router 激活了路由，只执行被选中的
      const effectiveRunnable = pendingRoutes
        ? runnable.filter((id) => {
            if (pendingRoutes.has(id)) return true;
            skipped.add(id);
            return false;
          })
        : runnable;
      pendingRoutes = null; // 消费后清除

      // 并行执行同层节点
      const results = await Promise.all(
        effectiveRunnable.map(async (nodeId) => {
          const node = nodeMap.get(nodeId);

          // 构造 upstream（所有前驱的数据，传引用）
          const predecessors = getPredecessors(edgeMap, nodeId);
          const upstream = buildUpstreamContext(completedResults, predecessors);

          const ctx = {
            runManager: this.runManager,
            upstream,
            input: options.input,
            options: {
              isolate: options.isolate,
              ...(options.registry ? { registry: options.registry } : {}),
              ...(options.runDir ? { runDir: options.runDir } : {}),
              ...(options.waitTimeout ? { waitTimeout: options.waitTimeout } : {}),
            },
          };

          await this._log("workflow.node.started", { nodeId, type: node.type, agentId: node.agentId });

          const handler = getHandler(node.type);
          // TD-27：per-node catch。handler 抛异常（非 backend 错误，如 promptBuilder bug、
          // 内部断言失败）不得废掉整层——原 Promise.all 无 catch 会 reject 整层、丢失兄弟节点结果。
          // 现在抛错节点记为 completed:false（带 error），失败传播照常走，兄弟节点不受影响。
          let result;
          try {
            result = await handler.execute(node, ctx);
          } catch (error) {
            result = { completed: false, error: error.message };
          }

          await this._log("workflow.node.completed", {
            nodeId,
            runId: result.runId,
            completed: result.completed,
            ...(result.routes ? { routes: result.routes } : {}),
          });

          return { nodeId, result };
        }),
      );

      // 处理结果
      for (const { nodeId, result } of results) {
        executed.add(nodeId);
        completedResults.set(nodeId, result);

        if (!result.completed) {
          overallCompleted = false;
          // 失败传播：标记所有下游为 skipped
          propagateFailure(edgeMap, nodeId, executed, skipped);
        }

        // router 节点：为下一层设置激活路由
        if (result.routes) {
          pendingRoutes = new Set(result.routes);
        }
      }

      // S3-2 集成：本层处理完，落盘状态快照（若 .wao/ 已 init）。
      // 失败降级 + stderr，绝不阻断 workflow（和 alerts 一致：状态外化是旁路，不是主路径）。
      if (waoDir) {
        try {
          await writeStateSnapshot(waoDir, {
            workflowId: workflowDef.id,
            executed: [...executed],
            skipped: [...skipped],
            completedResults,
            allNodes: allNodeIds,
            predecessors: Object.fromEntries(
              [...edgeMap.entries()].map(([id, e]) => [id, e.predecessors]),
            ),
          });
        } catch (error) {
          console.error(`[wao] state snapshot failed: ${error.message}`);
        }
      }
    }

    await this._log("workflow.completed", {
      workflowId: workflowDef.id,
      completed: overallCompleted,
      executed: [...executed],
      skipped: [...skipped],
    });

    return {
      completed: overallCompleted,
      timedOut,
      nodeResults: Object.fromEntries(completedResults),
      // TD-102: 被跳过的节点 IDs（失败传播 + router 未选）。CLI 用此渲染完整 node 列表。
      skipped: [...skipped],
    };
  }

  async _log(type, payload) {
    if (this.transcript) {
      // 防止 payload 里的字段覆盖 transcript context（runId/agentId/ts/seq/type）
      // 把冲突字段重命名
      const safe = {};
      for (const [key, value] of Object.entries(payload)) {
        if (key === "runId") safe.nodeRunId = value;
        else if (key === "type") safe.nodeType = value;
        else if (key === "agentId") safe.nodeAgentId = value;
        else safe[key] = value;
      }
      await this.transcript.append(type, safe);
    }
  }
}

// ===== 辅助函数 =====

/** 构造 edge 映射：nodeId → 其前驱列表 */
function buildEdgeMap(def) {
  const map = new Map();
  for (const node of def.nodes) {
    map.set(node.id, { predecessors: [], successors: [] });
  }
  for (const edge of def.edges) {
    map.get(edge.from).successors.push(edge.to);
    map.get(edge.to).predecessors.push(edge.from);
  }
  return map;
}

/** 获取节点的所有前驱 id */
function getPredecessors(edgeMap, nodeId) {
  return edgeMap.get(nodeId)?.predecessors ?? [];
}

/** 失败传播：递归标记所有下游为 skipped */
function propagateFailure(edgeMap, failedNodeId, executed, skipped) {
  const successors = edgeMap.get(failedNodeId)?.successors ?? [];
  for (const succ of successors) {
    if (!executed.has(succ) && !skipped.has(succ)) {
      skipped.add(succ);
      propagateFailure(edgeMap, succ, executed, skipped);
    }
  }
}
