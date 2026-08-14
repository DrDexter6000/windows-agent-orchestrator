// src/backends/factory.js
//
// SSOT：按 agent.backend 构造 backend 实例的唯一共享工厂。
//
// 历史：同款构造曾散在 cli.js / shared.js / backgroundRunner.js / daemon.js 多处，
// 分支语义一致但各自漂移风险高。收敛后全部构造点（daemon.js、backgroundRunner.js、
// commands/shared.js）共用本模块。
//
// 注入点：
//   - fetchImpl：仅 opencode-serve 使用（测试注入；不注入走默认 fetch）。
//   - waoCliPath：三个进程式 backend（claude-code / codex / kimi-code）使用。
//     显式注入优先；未注入时内部调 getWaoCliPath() 解析。
//     daemon.js / backgroundRunner.js 在启动时算好传入（每次进程一次）；
//     commands/shared.js 走薄委托不传参，每次调用由工厂内部解析——两种现状行为均不变。
//
// 刻意不在本工厂的构造点（禁止并入）：
//   - src/mcp/server.js 的 resolveBackendFor：未知 backend return null 而非抛错，
//     这是 M12-7 续跑资格检查的刻意 fail-soft 语义。
//   - src/smoke.js：4 分支（无 kimi-code）、不传 waoCliPath，是刻意的最小探测面。

import { OpenCodeServeBackend } from "./opencodeServe.js";
import { ClaudeCodeBackend } from "./claudeCode.js";
import { CodexBackend } from "./codex.js";
import { KimiCodeBackend } from "./kimiCode.js";
import { DeepSeekHarnessBackend } from "./deepSeekHarness.js";
import { getWaoCliPath } from "../waoCliPath.js";

/**
 * 按 agent.backend 选对应后端实例。
 *
 * @param {object} agent - 规范化后的 agent（含 backend 字段）
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - opencode-serve fetch 注入（测试）
 * @param {string} [opts.waoCliPath] - worker 注入用的 WAO CLI 入口路径；
 *   未注入时内部调 getWaoCliPath() 解析（TD-90）。
 */
export function backendFor(agent, { fetchImpl, waoCliPath } = {}) {
  if (agent.backend === "opencode-serve") {
    return new OpenCodeServeBackend(fetchImpl ? { fetchImpl } : {});
  }
  const cliPath = waoCliPath ?? getWaoCliPath();
  if (agent.backend === "claude-code") return new ClaudeCodeBackend({ waoCliPath: cliPath });
  if (agent.backend === "codex") return new CodexBackend({ waoCliPath: cliPath });
  if (agent.backend === "kimi-code") return new KimiCodeBackend({ waoCliPath: cliPath });
  if (agent.backend === "deepseek-harness") return new DeepSeekHarnessBackend();
  throw new Error(`Unsupported backend: ${agent.backend}`);
}
