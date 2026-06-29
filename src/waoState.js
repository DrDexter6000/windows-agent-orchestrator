/**
 * .wao/state/ 读写（S3-2，阶段 3）。
 *
 * 定位：项目"当前进度"的唯一活跃快照。断点续接只读 state/current.md。
 * 与 workflow engine 集成：每个节点完成后调 writeStateSnapshot 落盘（边走边写）。
 *
 * 格式（markdown，人机都可读）：
 *   # State: <workflowId>
 *   updated: <ISO>
 *   status: in_progress | completed | failed
 *   ## Steps（表格：node/status/runId/notes）
 *   ## Upstream refs（传引用不传内容）
 *
 * 归档：每次 writeStateSnapshot，若旧 current.md 非空，移到 history/<ts>-<slug>.md + map 加索引。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 写当前进度快照。旧 current 归档到 history。
 * @param {string} waoDir .wao/ 路径
 * @param {{workflowId, executed: string[], skipped: string[], completedResults: Map, allNodes: string[], predecessors: object}} data
 */
export async function writeStateSnapshot(waoDir, data) {
  const stateDir = join(waoDir, "state");
  const currentPath = join(stateDir, "current.md");
  const historyDir = join(stateDir, "history");
  await mkdir(historyDir, { recursive: true });

  // 归档旧 current（若非空）
  let oldCurrent = "";
  try {
    oldCurrent = await readFile(currentPath, "utf8");
  } catch { /* 首次，无旧 */ }
  const trimmed = oldCurrent.trim();
  if (trimmed.length > 0) {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const slug = extractWorkflowId(oldCurrent) ?? "snapshot";
    const archivePath = join(historyDir, `${ts}-${slug}.md`);
    await writeFile(archivePath, oldCurrent, "utf8");
    // map 加索引行
    await appendMapIndex(join(stateDir, "map.md"),
      `${ts}-${slug} | ${slug} | archived snapshot`);
  }

  // 生成新 current.md
  const { workflowId, executed, skipped, completedResults, allNodes, predecessors } = data;
  const executedSet = new Set(executed ?? []);
  const skippedSet = new Set(skipped ?? []);
  const ts = new Date().toISOString();
  const anyFailed = [...completedResults.values()].some((r) => !r.completed);
  const status = executedSet.size === (allNodes?.length ?? 0)
    ? (anyFailed ? "failed" : "completed")
    : "in_progress";

  const lines = [];
  lines.push(`# State: ${workflowId ?? "unknown"}`);
  lines.push(`updated: ${ts}`);
  lines.push(`status: ${status}`);
  lines.push("");
  lines.push("## Steps");
  lines.push("| node | status | runId | notes |");
  lines.push("|------|--------|-------|-------|");
  for (const node of (allNodes ?? [])) {
    const result = completedResults?.get(node);
    let status = "pending";
    let runId = "-";
    let notes = "";
    if (skippedSet.has(node)) {
      status = "skipped";
      notes = "upstream failed";
    } else if (executedSet.has(node) && result) {
      status = result.completed ? "completed" : "failed";
      runId = result.runId ?? "-";
    }
    lines.push(`| ${node} | ${status} | ${runId} | ${notes} |`);
  }
  lines.push("");
  lines.push("## Upstream refs (传引用不传内容)");
  for (const [nodeId, result] of (completedResults?.entries() ?? [])) {
    if (result?.transcriptPath) {
      lines.push(`- ${nodeId}: ${result.transcriptPath}`);
    }
  }
  lines.push("");

  await writeFile(currentPath, lines.join("\n"), "utf8");
}

/**
 * 读当前进度快照，解析成结构化对象。未 init / current 为空返回 null。
 */
export async function readCurrentState(waoDir) {
  const currentPath = join(waoDir, "state", "current.md");
  if (!existsSync(currentPath)) return null;
  let raw;
  try {
    raw = await readFile(currentPath, "utf8");
  } catch { return null; }
  if (!raw.trim()) return null;

  const workflowId = extractWorkflowId(raw);
  const updatedMatch = raw.match(/^updated:\s*(.+)$/m);
  const statusMatch = raw.match(/^status:\s*(\w+)/m);
  const steps = [];
  // 解析表格行 | node | status | runId | notes |
  for (const line of raw.split("\n")) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/);
    if (m && !["node", "------"].some((h) => m[1].startsWith(h))) {
      steps.push({ node: m[1].trim(), status: m[2].trim(), runId: m[3].trim(), notes: m[4].trim() });
    }
  }
  return {
    workflowId,
    updated: updatedMatch?.[1]?.trim(),
    status: statusMatch?.[1]?.trim(),
    steps,
  };
}

/** 从 current.md 内容提取 workflowId（# State: <id>） */
function extractWorkflowId(content) {
  const m = content.match(/^# State:\s*(.+)$/m);
  return m?.[1]?.trim();
}

/** 追加一行到 map.md（幂等，不查重——调用方保证不重复） */
async function appendMapIndex(mapPath, line) {
  let existing = "";
  try { existing = await readFile(mapPath, "utf8"); } catch {}
  const addition = existing.endsWith("\n") || existing.length === 0
    ? `${existing}${line}\n`
    : `${existing}\n${line}\n`;
  await writeFile(mapPath, addition, "utf8");
}
