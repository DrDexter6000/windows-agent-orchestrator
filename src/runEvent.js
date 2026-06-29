/**
 * RunEvent 类型定义与构造器（spec §2.2）。
 *
 * 所有 backend（opencode-serve / 进程式 claude-code / codex）的输出统一翻译成 RunEvent 序列。
 * 编排层（RunManager / DAG 引擎）只面对这个统一形状，永远不碰传输细节。
 *
 * 契约边界（M4 更新）：
 *   message + done + metrics 三类事件。
 *   metrics 是成本可观测的一部分（M4），从各 backend 已有的 usage 字段提取。
 *   证据链事件（command/file_written/tool_use/tool_result）spec §2.2 有定义，
 *   但实现延后到 M6 scorecard——证据审计是 scorecard 的职责，不是 backend 的。
 */

export const RUN_EVENT_KINDS = [
  "message",
  "done",
  "metrics",
  "command",
  "file_written",
  "tool_use",
  "tool_result",
];

/** assistant/user/system 消息产出 */
export function messageEvent(role, parts) {
  return { kind: "message", role, parts };
}

/** run 完成 / 失败。reason 决定 RunManager 怎么转状态。 */
export function doneEvent(reason, error) {
  if (reason !== "completed" && reason !== "failed") {
    throw new Error(`doneEvent reason must be completed|failed, got: ${reason}`);
  }
  const event = { kind: "done", reason };
  if (error) event.error = error;
  return event;
}

/**
 * metrics 事件（M4）：token 用量 + 成本。
 * 从各 backend 的 usage 字段提取。字段缺失时省略（不强制所有 backend 都有）。
 */
export function metricsEvent({ input, output, reasoning, costUsd } = {}) {
  const tokens = {};
  if (typeof input === "number") tokens.input = input;
  if (typeof output === "number") tokens.output = output;
  if (typeof reasoning === "number") tokens.reasoning = reasoning;
  const event = { kind: "metrics", tokens };
  if (typeof costUsd === "number") event.costUsd = costUsd;
  return event;
}

// ===== 证据链事件（M6-1，TD-9）=====
// 这几类是 scorecard 证据链的来源（spec §2.2）。
// Backend 从 runtime 原始输出里提取这些结构化证据，落盘到 transcript，
// scorecard 读 transcript 核验——程序判定，不靠 LLM。

/**
 * agent 执行的 shell 命令（证据链用）。
 * @param {string} command 命令文本
 * @param {number} [exitCode] 退出码；运行中或未知时省略
 * @param {{toolCallId?: string}} [meta] runtime 工具调用 id，用于和 tool_result 关联
 */
export function commandEvent(command, exitCode, meta = {}) {
  const event = { kind: "command", command };
  if (typeof exitCode === "number") event.exitCode = exitCode;
  if (typeof meta.toolCallId === "string") event.toolCallId = meta.toolCallId;
  return event;
}

/**
 * agent 写入文件（证据链用）。
 * @param {string} path 文件路径
 */
export function fileWrittenEvent(path) {
  return { kind: "file_written", path };
}

/**
 * agent 正在思考（TD-76 thinking 信号——方案 A：只记存在不存内容）。
 * 用途：让 worker 思考期间心跳持续（`lastActivityKind="在思考"`），消除"思考假死"→
 * provider_disconnect 误判。**不存 thinking 内容**（token/隐私成本；Lead 只需知道"在思考"
 * 不需知道"想什么"）。claude-code 实测 schema：content 数组里 {type:"thinking",thinking,signature}。
 */
export function thinkingEvent() {
  return { kind: "thinking" };
}

/**
 * agent 调用工具（证据链用，未被 command/file_written 覆盖的通用工具）。
 * @param {string} tool 工具名
 * @param {unknown} input 工具输入
 */
export function toolUseEvent(tool, input) {
  return { kind: "tool_use", tool, input };
}

/**
 * 工具执行结果（证据链用）。isError 强制必填——证据判定靠它区分成败。
 * @param {string} tool 工具名
 * @param {unknown} output 工具输出
 * @param {boolean} isError 是否出错
 */
export function toolResultEvent(tool, output, isError) {
  if (typeof isError !== "boolean") {
    throw new Error("toolResultEvent isError must be a boolean");
  }
  return { kind: "tool_result", tool, output, isError };
}
