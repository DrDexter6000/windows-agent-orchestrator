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

/**
 * ADR-0025 批次 2：backend 实例闭集能力声明的静态读取 SSOT（单一定义处）。
 *
 * 严格 `=== true`：未声明（undefined）与 truthy 非 true（"false"/1/{}）一律读为
 * false——fail-closed，"未声明"绝不读成"支持"（与 runManager 消费
 * supportsSessionReuse/supportsRoleContract 的 strict === true 纪律同款）。
 * registry validate 用这层读取做配置 × 能力交叉校验；不猜、不补默认 true。
 *
 * @param {object} backend — 任意 backend 实例（含测试注入的伪造形状）
 * @returns {{reportsTokenUsage: boolean, supportsSessionReuse: boolean}}
 */
export function readBackendCapabilities(backend) {
  return {
    reportsTokenUsage: backend?.reportsTokenUsage === true,
    supportsSessionReuse: backend?.supportsSessionReuse === true,
  };
}

/**
 * ADR-0025 批次 2：按 agent.backend 构造 backend 并读取其闭集能力声明。
 *
 * 纯静态：五个 backend 类的构造函数都无副作用（不 spawn 进程、不发网络
 * 请求——spawn/fetch 只在运行时方法里被调用），`registry validate` 的加载
 * 路径因此可以零副作用地读到类声明。未知 backend → null（validate 的
 * "unknown backend" hard issue 由调用方另行报告；能力面不猜）。
 *
 * @param {object} agent — 只读 agent.backend（registry 原始条目即可）
 * @param {object} [opts] — 透传 backendFor（fetchImpl / waoCliPath 注入）
 * @returns {{reportsTokenUsage: boolean, supportsSessionReuse: boolean}|null}
 */
export function backendCapabilitySnapshot(agent, opts = {}) {
  try {
    return readBackendCapabilities(backendFor(agent, opts));
  } catch {
    return null;
  }
}
