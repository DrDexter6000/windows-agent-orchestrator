# opencode-serve smoke 实测 + 杂草记录

> 状态：✅ 议题 4 关闭。
> 日期：2026-06-16
> 背景：验证 opencode-serve + GLM-5.2 的工具调用链路，为 worker 全栈 opencode 架构决策提供工程证据。

## 实测结论

### GLM-5.2 工具调用完全可靠

从真实 session（`ses_13484eed0`）实测，GLM-5.2 一次性调用了 9 种工具：
`read, bash, grep, glob, write, todowrite, task, background_output, edit`

这不是简单的文件读写，是完整的工程级工具集——包括多步编排（task）、后台任务（background_output）、待办管理（todowrite）。

**对 PoC 的意义**：coder 角色用 opencode + GLM-5.2 完全可行，无需退回 claude-code。

### opencode tool part schema（TD-33 勘测完毕）

opencode 的 message.parts 里，工具调用是自包含的 `type: "tool"` part：

```jsonc
{
  "type": "tool",
  "tool": "write",           // 工具名：write/edit/bash/grep/glob/read/task/...
  "callID": "call_00_...",
  "state": {
    "status": "completed",   // 成功/失败状态
    "input": {
      "filePath": "...",     // write/edit 的文件路径
      "content": "...",
      // bash 的 input 含 command（需进一步确认字段名）
    },
    "output": "..."          // 工具输出
  }
}
```

**比 claude-code/codex 表达力更强**：
- claude-code：tool_use 和 tool_result 分散在 assistant/user 两条消息，需跨消息关联
- codex：只有 command_execution，无结构化 file_written
- **opencode：一个 tool part 自包含 input + output + status**，提取逻辑最简单

### TD-33 实现草案

| opencode tool | 提取为 | 提取字段 |
|---------------|--------|---------|
| `bash` | `commandEvent` | `input.command` + status→exitCode |
| `write` / `edit` | `fileWrittenEvent` | `input.filePath` |
| 其它（grep/glob/read/task） | `toolUseEvent` | `tool` + `input` |
| 所有 tool part | `toolResultEvent` | `tool` + `output` + status→isError |

**待确认**：bash 工具 input 里的命令字段名（是 `command` 还是 `cmd`？）；status 的非 completed 取值（`failed`? `error`?）。

## 杂草记录：Maestro System Context 注入

### 来源

用户实际使用 opencode 时，**oh-my-openagent 插件**（集成在 opencode 中的多 LLM 调度插件）在 session 创建时注入编排上下文。

### 表现

session 列表的 `title` 字段开头为 `"# Maestro System Context\r\n\r\nYou are **码农A_GLM**, powered by **opencode**, operating..."`。title 本应是 session 摘要，被挪用来存编排指令。

### 为什么是杂草

1. **混滝元数据与指令**：title 字段被当 prompt 载体
2. **违反原则 #1**：编排逻辑（"你是码农A，任务是..."）在 opencode session 层注入 = 往 agent system prompt 灌编排
3. **三源冲突风险**：oh-my-openagent 的编排 vs 主控编排 vs 项目纪律，正是 RunMaestro 崩溃模式

### 本 PoC 的防御

PoC 的 `promptAsync`（opencodeServe.js）发送的 parts 只有纯 text，不注入 Maestro context。只要主控派任务时 prompt 是干净的任务描述，就不会产生杂草。

### 清理归属

oh-my-openagent 属于 talking-cli 项目域，不在本仓库处理。本 PoC 替代的就是这种"往 session 层灌编排"的模式。
