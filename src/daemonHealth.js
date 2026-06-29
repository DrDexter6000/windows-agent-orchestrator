// src/daemonHealth.js
//
// P5 / TD-46：daemon 长跑可观测性——健康评估。
//
// TD-46：长跑（数小时/天）暴露的句柄/内存/进程组累积，单元测试覆盖不到（需真实长跑）。
// 故本模块只做"可观测+告警"（眼睛），不做"自动修根因"（根因靠 T3 长跑暴露后针对性修）。
//
// 纯函数 assessDaemonHealth(sample, thresholds)：按阈值判定健康状态，超阈→warn + 列 issues。
// daemon 侧（startDaemon）周期采样 process.memoryUsage + 在飞 run 数 + worktree 残留，
// 调本函数；warn 则记 daemon.health_warn 事件 + 可选告警。
//
// 默认阈值（保守，长跑经验值）：
//   rssWarnBytes 512MB（Node daemon 长跑常见基线 ~100-200MB，超 512MB 疑似泄漏）
//   heapWarnBytes 384MB
//   worktreeWarnCount 10（worktree 不清理会累积文件 + 句柄）
//   activeRunsWarnCount 20（卡住的 run 累积信号）

const DEFAULT_THRESHOLDS = {
  rssWarnBytes: 512 * 1024 * 1024,
  heapWarnBytes: 384 * 1024 * 1024,
  worktreeWarnCount: 10,
  activeRunsWarnCount: 20,
};

/**
 * 评估 daemon 健康状态（纯函数，可单测）。
 * @param {object} sample - 单次采样 {rssBytes, heapUsedBytes, activeRuns, worktreeCount, uptimeMs}
 * @param {object} [thresholds] - 覆盖默认阈值
 * @returns {{level:"ok"|"warn", issues:Array<{metric:string, value:number, threshold:number, message:string}>}}
 *   - level: 任一维度超阈 → "warn"，否则 "ok"
 *   - issues: 超阈维度清单（metric + 当前值 + 阈值 + 人读 message）
 *   - 缺字段跳过该判定（不崩）；空/坏输入 → ok（保守，不误报）
 */
export function assessDaemonHealth(sample, thresholds = {}) {
  if (!sample || typeof sample !== "object") return { level: "ok", issues: [] };
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const issues = [];

  if (typeof sample.rssBytes === "number" && sample.rssBytes > t.rssWarnBytes) {
    issues.push({
      metric: "rss", value: sample.rssBytes, threshold: t.rssWarnBytes,
      message: `RSS ${mb(sample.rssBytes)} > 阈值 ${mb(t.rssWarnBytes)}（内存累积，疑似泄漏）`,
    });
  }
  if (typeof sample.heapUsedBytes === "number" && sample.heapUsedBytes > t.heapWarnBytes) {
    issues.push({
      metric: "heap", value: sample.heapUsedBytes, threshold: t.heapWarnBytes,
      message: `heapUsed ${mb(sample.heapUsedBytes)} > 阈值 ${mb(t.heapWarnBytes)}（堆累积）`,
    });
  }
  if (typeof sample.worktreeCount === "number" && sample.worktreeCount > t.worktreeWarnCount) {
    issues.push({
      metric: "worktree", value: sample.worktreeCount, threshold: t.worktreeWarnCount,
      message: `worktree 残留 ${sample.worktreeCount} > 阈值 ${t.worktreeWarnCount}（进程组/文件累积，需清理）`,
    });
  }
  if (typeof sample.activeRuns === "number" && sample.activeRuns > t.activeRunsWarnCount) {
    issues.push({
      metric: "activeRuns", value: sample.activeRuns, threshold: t.activeRunsWarnCount,
      message: `在飞 run ${sample.activeRuns} > 阈值 ${t.activeRunsWarnCount}（卡住的 run 累积信号）`,
    });
  }

  return { level: issues.length > 0 ? "warn" : "ok", issues };
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}

export { DEFAULT_THRESHOLDS };
