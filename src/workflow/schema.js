/**
 * Workflow 数据模型 + 校验 + 拓扑排序（M5-1）。
 *
 * defineWorkflow(def)：identity 函数，做校验 + 默认值填充。
 * validateWorkflow(def)：静态校验（重复 id、悬空 edge、自环、循环）。
 * topoSort(def)：Kahn 算法分层，同层可并行。
 *
 * 不执行节点（那是 engine 的事）。不加载文件（那是 loader 的事）。
 */

/**
 * @typedef {Object} NodeDef
 * @property {string} id
 * @property {"agent"|"gate"|"router"|"custom"} type
 * @property {string} [agentId]
 * @property {string} [prompt]
 * @property {function} [promptBuilder]
 * @property {string[]} [requiredClaims]
 * @property {function} [routes]
 *
 * @typedef {Object} EdgeDef
 * @property {string} from
 * @property {string} to
 * @property {boolean} [dataEdge]
 * @property {boolean} [onFail]
 *
 * @typedef {Object} WorkflowDef
 * @property {string} id
 * @property {NodeDef[]} nodes
 * @property {EdgeDef[]} edges
 */

/** identity + 校验。让用户写时有明确的结构。 */
export function defineWorkflow(def) {
  if (!def || typeof def !== "object") {
    throw new Error("defineWorkflow: expected an object");
  }
  if (!def.id) throw new Error("defineWorkflow: missing id");
  if (!Array.isArray(def.nodes)) throw new Error("defineWorkflow: missing nodes array");
  if (!Array.isArray(def.edges)) throw new Error("defineWorkflow: missing edges array");

  // 填充 edge 默认值
  const normalizedEdges = def.edges.map((e) => ({
    from: e.from,
    to: e.to,
    dataEdge: e.dataEdge === true,
    onFail: e.onFail === true,
  }));

  const normalized = { ...def, edges: normalizedEdges };
  validateWorkflow(normalized);
  return normalized;
}

/** 静态校验：重复 id、悬空 edge、自环、循环、agent 必须有 agentId */
export function validateWorkflow(def) {
  const nodeIds = new Set();

  // 1. node 校验
  for (const node of def.nodes) {
    if (!node.id) throw new Error(`validateWorkflow: node missing id`);
    if (nodeIds.has(node.id)) {
      throw new Error(`validateWorkflow: duplicate node id "${node.id}"`);
    }
    nodeIds.add(node.id);
    if (node.type === "agent" && !node.agentId) {
      throw new Error(`validateWorkflow: agent node "${node.id}" missing agentId`);
    }
  }

  // 2. edge 校验
  for (const edge of def.edges) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(`validateWorkflow: edge from "${edge.from}" references unknown node`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`validateWorkflow: edge to "${edge.to}" references unknown node`);
    }
    if (edge.from === edge.to) {
      throw new Error(`validateWorkflow: self-loop on node "${edge.from}"`);
    }
  }

  // 3. 循环检测（Kahn 算法：如果能完成分层则无环）
  detectCycle(def);
}

/**
 * Kahn 算法拓扑排序，返回分层数组。
 * 同层节点无依赖关系，可并行执行。
 * dataEdge 不影响分层（只影响数据传递时机，不影响执行顺序）。
 *
 * @param {WorkflowDef} def
 * @returns {string[][]} 分层 node id 数组
 */
export function topoSort(def) {
  const nodes = def.nodes;
  const edges = def.edges;

  // 计算入度（只算执行依赖，dataEdge 不算）
  const inDegree = {};
  const adj = {};
  for (const node of nodes) {
    inDegree[node.id] = 0;
    adj[node.id] = [];
  }
  for (const edge of edges) {
    if (!edge.dataEdge) {
      inDegree[edge.to] += 1;
      adj[edge.from].push(edge.to);
    }
  }

  const layers = [];
  const visited = new Set();

  while (visited.size < nodes.length) {
    // 找当前入度为 0 且未访问的节点
    const layer = [];
    for (const node of nodes) {
      if (!visited.has(node.id) && inDegree[node.id] === 0) {
        layer.push(node.id);
      }
    }
    if (layer.length === 0) {
      // 还有未访问节点但无入度 0 的 → 有环
      throw new Error(`topoSort: cycle detected (cannot resolve nodes: ${nodes.filter((n) => !visited.has(n.id)).map((n) => n.id).join(", ")})`);
    }
    layers.push(layer);
    for (const id of layer) {
      visited.add(id);
      for (const next of adj[id]) {
        inDegree[next] -= 1;
      }
    }
  }

  return layers;
}

/** 循环检测：topoSort 如果不能完成则抛错 */
function detectCycle(def) {
  topoSort(def); // 如果有环，topoSort 会抛错
}
