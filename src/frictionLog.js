/**
 * TD-92 Debug mode：run 失败终态自动捕获"客观摩擦"写入 .dev/friction-log/。
 *
 * 定位：🟢 工具域——机器可捕获的客观信号（命令失败/超时/budget/scorecard fail/crash）。
 * 互补 Lead 手动记的主观摩擦（🟡 域，"为什么别扭/怎么绕路"），后者机器分不清。
 *
 * 设计：
 *   - 复用 diagnosis.js 的 diagnoseFailure() 做分类（SSOT——不另造分类逻辑）
 *   - 镜像 alerts.js 的 raiseAlert 纪律：失败降级 stderr 不抛，friction 捕获绝不阻塞 run 终态
 *   - 默认关（debugMode config 或 WAO_DEBUG=1 env 开），避免成功 run 噪声 + 文件膨胀
 *   - category=none（成功）或 unknown（信号不足）不写——写这些是噪声
 *
 * 产物：.dev/friction-log/auto-<ts>-<category>-<runId尾>.md
 *   auto- 前缀区分手动 friction log（dogfood-* / 日期-*）
 *   结构兼容手动 log（场景/影响/建议），但主观字段留空给 Lead 补
 */
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

/**
 * debug mode 是否开启。优先级：opts.debugMode（显式）→ WAO_DEBUG env → false（默认关）。
 * @param {{debugMode?: boolean}} [opts]
 */
export function isDebugMode(opts = {}) {
  if (typeof opts.debugMode === "boolean") return opts.debugMode;
  return process.env.WAO_DEBUG === "1";
}

/**
 * 从 runDir（绝对或相对）推导 .dev/friction-log/ 路径。
 * runDir 通常是 <projectRoot>/runs，friction-log 在 <projectRoot>/.dev/friction-log。
 */
export function frictionLogDirFromRunDir(runDir) {
  return join(resolve(runDir), "..", ".dev", "friction-log");
}

/**
 * run 失败终态时调：读 transcript 分类，category≠none/unknown 则写 auto-*.md。
 *
 * @param {string} runId
 * @param {string} agentId
 * @param {object[]} events — transcript 事件数组（调用方 readTranscript 后传入）
 * @param {object} opts
 *   - {string} frictionLogDir — 写入目录（调用方用 frictionLogDirFromRunDir 推导）
 *   - {boolean} [debugMode] — 开关（不传则读 WAO_DEBUG env）
 *   - {object} [metrics] — {costUsd?, tokens?, durationMs?} 影响字段（可选，从 run.metrics 提取）
 * @returns {Promise<string|null>} 写入的文件路径，或 null（未写：debug 关 / category=none|unknown）
 */
export async function writeFrictionLog(runId, agentId, events, opts) {
  if (!isDebugMode(opts)) return null;

  const { diagnoseFailure } = await import("./diagnosis.js");
  const result = diagnoseFailure(events);
  // none=成功 run；unknown=信号不足。两者不写（噪声）。
  if (result.category === "none" || result.category === "unknown") return null;

  const dir = opts.frictionLogDir ?? frictionLogDirFromRunDir("runs");
  const ts = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15); // YYYYMMDDTHHMM
  const runTail = runId.slice(-8);
  const fileName = `auto-${ts}-${result.category}-${runTail}.md`;
  const filePath = join(dir, fileName);

  const m = opts.metrics ?? {};
  const evidenceRows = result.evidence.length > 0
    ? result.evidence.map((e) => `- **${e.eventType}**: ${e.fact}`).join("\n")
    : "_（无具体证据事件——分类基于终态信号推断）_";

  const content = [
    `# Auto friction — ${result.category} (run ${runId})`,
    ``,
    `> 🟢 机器自动捕获的客观摩擦（debug mode, TD-92）。主观判断（"为什么别扭/怎么绕路"）`,
    `> 机器分不清，留给你在下方 §Subjective 补充。`,
    ``,
    `Generated: ${new Date().toISOString()}  Run: \`${runId}\`  Agent: \`${agentId}\``,
    m.costUsd != null || m.tokens != null || m.durationMs != null
      ? `Cost: $${m.costUsd ?? "-"}  Tokens: ${m.tokens ?? "-"}  Duration: ${m.durationMs != null ? Math.round(m.durationMs / 1000) + "s" : "-"}`
      : "",
    ``,
    `## Evidence（auto-captured from transcript）`,
    evidenceRows,
    ``,
    `## Impact（auto）`,
    m.costUsd != null ? `- Cost: $${m.costUsd}` : "",
    m.tokens != null ? `- Tokens: ${m.tokens}` : "",
    m.durationMs != null ? `- Duration: ${Math.round(m.durationMs / 1000)}s` : "",
    ``,
    `## Subjective（TODO by Lead — 🟡 主观判断）`,
    `- 为什么别扭：`,
    `- 怎么处理的：`,
    `- 是否已有 TD/SKILL 覆盖：`,
    ``,
  ].filter((l) => l !== "").join("\n");

  // 铁律（同 raiseAlert）：friction 捕获失败绝不阻塞 run 终态。降级 stderr，不抛。
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, content, "utf8");
  } catch (e) {
    console.error(`[frictionLog] failed to write ${filePath}: ${e.message}`);
    return null;
  }
  return filePath;
}
