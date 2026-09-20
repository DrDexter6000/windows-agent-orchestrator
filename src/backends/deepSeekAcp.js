// src/backends/deepSeekAcp.js
//
// ADR-0031（B-2）：DSH ACP 集成面 backend。
//
// 与旧线 deepSeekHarness.js（WAO 自建 JSON-RPC composition）同一 DSH runtime 家族，
// 但走的是上游 shipped 的 `--profile acp`（ACP = Agent Client Protocol，JSON-RPC 2.0
// 经 stdio、换行分隔）。本文件纪律与旧线同源：
//   - WAO 只 detect / invoke / report：不改 DSH 安装、不生成/升级 containment 资产；
//     操作员安装的 `~/.wao/runtimes/dsh-acp/wao-contain.patch.yml` 缺失或与声明
//     不匹配 → 派发前拒绝（fail-closed，不静默降级）。
//   - 角色合同经 per-dispatch 临时目录里的 `--patch` 覆盖 `system-prompt.personaPrefix`
//     （结构化序列化，禁止字符串拼接）；backend 实例 finally/stop 路径负责清理，
//     启动时 best-effort 清扫孤儿目录（只删本 backend 专属前缀的目录）。
//   - 事件投影 fail-closed：未绑定 sessionId 的 session/update 丢弃（绝不投影）；
//     未知 sessionUpdate 类型 / 未知 tool_call_update status → 终态 failed，
//     不投影、不吞掉；`pending`/`in_progress` 绝不当作工具成功。
//   - 同一 toolCallId 的重复/乱序终态以首个为准，后续忽略并留痕（handle.anomalies）。
//   - toolCallId 缺失/空 → 关联不可靠（docs/02-architecture.md §2.2 不可靠关联态）：
//     绝不发 write_intent / file_written，anomalies 留痕；重复 toolCallId 的
//     tool_call → 拒绝覆盖待确认路径（pendingWrites/pendingCommands 保持首个），留痕。
//   - `usage_update` 是上下文占用观察，绝不折算成 metrics 的 input；终局用量唯一
//     来源是 `session/prompt` 响应的 usage。
//   - 二次校验 = 越界 tripwire（检测，非阻止）：wire 上 `tool_call.title` 即工具真名
//     （ADR-0031 F8），出现 subagent / subagent_fork / spawn_teammate 即终态 failed。
//   - `session/request_permission`（服务端→客户端请求）必须应答且受会话与终态约束：
//     非本次绑定 sessionId、或终态已排队 → 绝不 allow，按 cancelled 应答并留痕；
//     其余按 allow_once/allow_always → 选中；仅 reject 类/未知 kind → 选中 reject
//     （找不到 reject 选项时 cancelled，绝不授予）；无可选项 → cancelled。应答以
//     system message 事件进 transcript（system 消息不是 usable effect，不污染证据链）。
//
// 能力声明（ADR-0031 §3.3；supportsSessionReuse 按 Lead 2026-09-20 临时裁定改 false）：
//   supportsRoleContract      = true   personaPrefix 注入已实测
//   supportsSessionReuse      = false  opaqueUuid→ACP sessionId 关联面（持久化/原子/
//                                      互斥/身份绑定）未落地；落地后改回 true；
//                                      Owner 裁定见 ADR-0031 §3.6。resume 轮一律
//                                      refuse（preflight fail-closed）——当前不具备
//                                      跨 run 复用能力，声明 true 属"声明强于实现"
//   supportsInFlightCorrection= false  ACP 无在途消息改写（F7）——如实声明，不静默
//   replayByRespawn           = false  跨 run 上下文续接依赖 §3.6 关联面（未落地），
//                                      本层不承担重放
//   reportsTokenUsage         = true   usage_update + PromptResponse.usage
//
// 零新增生产依赖：只用 node: 内置模块（探针 scripts/reliability/dsh-acp 已证可行）。

import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  commandEvent,
  doneEvent,
  DONE_MARKERS,
  fileWrittenEvent,
  messageEvent,
  metricsEvent,
  runEventIsUsableEffect,
  runtimeActivityEvent,
  thinkingEvent,
  toolResultEvent,
  toolUseEvent,
  writeIntentEvent,
  WRITE_INTENT_CORRELATION_STATUS,
} from "../runEvent.js";
import { inheritedEnvNames } from "../envPolicy.js";
import { createSecretRedactor, isSecretEnvName } from "../secretRedaction.js";
import { buildChildEnv, compileInvocation } from "./processBackend.js";

const BACKEND_NAME = "deepseek-acp";

// initialize 响应里的 agentInfo.name（scripts/reliability/dsh-acp/evidence/*.json）。
// 身份不符 → fail-closed（同旧线 RUNTIME_NAME 纪律）。
const ACP_RUNTIME_NAME = "deepseek-harness-acp";
const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_BINARY = "dsh";

// ACP 面 reasoning_effort wire 事实（F5：evidence/phase4-contained-safe.json 的
// configOptions 暴露 off/low/high/max 四档）——但那只是"随会话暴露"，**不是**可设置
// 通道的证据：argv/env/session 请求均无 effort 下发面，也无 set_config_option 类
// wire 方法入证据（scripts/reliability/dsh-acp/evidence/）。校验放行却静默不下发
// = 配置假绿，故 validateAgentPolicy 对任何非空 reasoning.effort 硬拒（与
// provider/model 块同源处置）。

// 越界 tripwire deny-list（ADR-0031 §3.5）：检测，不是阻止——副作用可能已发生。
// wire 上 title 即工具真名（F8），故直接按名字断言。
export const DENIED_ORCHESTRATION_TOOLS = Object.freeze(["subagent", "subagent_fork", "spawn_teammate"]);

// shell 类工具（与旧线 projectDshEvent 同集）：投影为 command 证据而非 tool_use。
const SHELL_TOOL_NAMES = Object.freeze(["pwsh", "powershell", "bash", "shell"]);
// 文件写类工具（与旧线同集）：tool_use + write_intent（关联成功才 file_written）。
const WRITE_TOOL_NAMES = Object.freeze(["str_replace_editor", "write", "edit", "multiedit"]);

// containment 覆盖层声明（内容与版本依据 = 仓库内
// scripts/reliability/dsh-acp/wao-contain-safe.patch.yml；操作员安装到
// ~/.wao/runtimes/dsh-acp/wao-contain.patch.yml，WAO 只校验不生成）。
// 预期形状：恰好这些 id 全部 disabled: true。
export const EXPECTED_CONTAINMENT_OVERLAY = Object.freeze(new Map([
  ["tool-subagent", true],
  ["tool-subagent-fork", true],
  ["tool-subagent-control", true],
  ["tool-workflow", true],
  ["tool-ralph", true],
  ["tool-goal", true],
  ["tool-todo", true],
  ["plan-mode", true],
  ["tool-jobs", true],
  ["jobs", true],
  ["tool-skill", true],
  ["skill", true],
  ["skill-filesystem", true],
  ["tool-web", true],
]));

// 机器本地 containment 资产落位（ADR-0031 §3.2）。
const CONTAINMENT_HOME_RELATIVE = path.join(".wao", "runtimes", "dsh-acp", "wao-contain.patch.yml");
// per-dispatch 角色合同 patch：OS temp 下本 backend 专属前缀的独占目录
// （mkdtemp 追加 6 个随机字符）。孤儿清扫只认这个前缀。
const PATCH_DIR_PREFIX = "wao-dsh-acp-";
const ROLE_PATCH_FILE = "role.patch.yml";
// 孤儿目录清扫的陈旧阈值：只清创建超过 1 小时的残留，绝不碰并发中的新派发。
const PATCH_SWEEP_STALE_MS = 60 * 60 * 1000;

const SHUTDOWN_TIMEOUT_MS = 1000;
const HANDSHAKE_TIMEOUT_MS = 15000;
const STDERR_TAIL_LIMIT = 4000;
const ANOMALY_LIMIT = 64;
const BOUNDED_TEXT_LIMIT = 120;

class EventQueue {
  constructor() {
    this.items = [];
    this.closed = false;
    this.resolveWait = null;
  }

  push(...events) {
    this.items.push(...events);
    this._wake();
  }

  close() {
    this.closed = true;
    this._wake();
  }

  drain() {
    return this.items.splice(0);
  }

  hasItems() {
    return this.items.length > 0;
  }

  _wake() {
    if (!this.resolveWait) return;
    const resolve = this.resolveWait;
    this.resolveWait = null;
    resolve();
  }
}

export { EventQueue as DeepSeekAcpEventQueue };

/**
 * 解析 containment 覆盖层文本（受控 YAML 子集：`- id: <x>` + `disabled: true` 列表）。
 * 任何超出该形状的行 → null（不可解析 → 上层拒绝派发，fail-closed）。
 * @param {string} text
 * @returns {Map<string, boolean>|null}
 */
export function parseContainmentOverlay(text) {
  const entries = new Map();
  let currentId = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    // 仅剥「行首注释」与「空白后 # 注释」；id 词内 # 不受影响（id 不匹配预期即拒绝）。
    const line = rawLine.replace(/^\s*#.*$/, "").replace(/\s#.*$/, "");
    if (!line.trim()) continue;
    const item = line.match(/^-\s*id:\s*(\S+)\s*$/);
    if (item) {
      if (currentId !== null) return null;
      currentId = item[1];
      continue;
    }
    const flag = line.match(/^\s+disabled:\s*(\S+)\s*$/);
    if (flag && currentId !== null) {
      if (flag[1] !== "true") return null;
      entries.set(currentId, true);
      currentId = null;
      continue;
    }
    return null;
  }
  if (currentId !== null) return null;
  return entries;
}

/**
 * 角色合同 patch 的结构化序列化（受控两行 YAML；标量一律经 JSON.stringify 转义，
 * 禁止把合同文本拼进结构）。JSON 双引号标量是合法 YAML。
 * @param {string} roleContract
 * @returns {string}
 */
export function serializeRoleContractPatch(roleContract) {
  return "system-prompt:\n  personaPrefix: " + JSON.stringify(String(roleContract)) + "\n";
}

/** 从 shell 工具结果文本提取退出码；无法提取时不伪造（返回 undefined）。 */
function extractExitCode(content) {
  const text = contentText(content);
  if (!text) return undefined;
  let found;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:exit(?:\s+code)?|exitcode)\s*[:=]?\s*(-?\d+)\s*$/i);
    if (match) found = Number(match[1]);
  }
  return found;
}

function contentText(content) {
  if (!Array.isArray(content)) return null;
  const joined = content
    .filter((block) => block && typeof block === "object" && block.type === "text"
      && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return joined.length > 0 ? joined : null;
}

function parseRawInput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function numberFrom(...values) {
  return values.find((value) => typeof value === "number");
}

function bounded(value) {
  return String(value ?? "missing").slice(0, BOUNDED_TEXT_LIMIT);
}

function trimTail(value) {
  const text = String(value);
  return text.length <= STDERR_TAIL_LIMIT ? text : text.slice(-STDERR_TAIL_LIMIT);
}

/**
 * DeepSeek ACP backend（`dsh --profile acp --patch <containment> --patch <role-contract>`）。
 *
 * 一个 WAO run 拥有一个 DSH 进程与一个 ACP session。DSH 拥单次模型/tool loop；
 * WAO 继续独占编排、transcript、worktree、stop、verification 与 delivery。
 * `session/prompt` 的响应只在整轮结束时到达——spawn 在握手（initialize →
 * session/new → 写出 prompt 请求）后即返回 handle，过程中事实经
 * `session/update` 通知流式投影。
 */
export class DeepSeekAcpBackend {
  supportsRoleContract = true;
  // Lead 2026-09-20 临时裁定（Owner 未决）：false。opaqueUuid→ACP sessionId 关联面
  // （持久化/原子/互斥/身份绑定）未落地；落地后改回 true；Owner 裁定见 ADR-0031 §3.6。
  // resume 轮一律 refuse（preflightInvocation fail-closed），关联面零改动——
  // 当前不具备跨 run 复用能力。配了 sessionReuse 的 lane 会在 registry validate
  // 得 ⚠ 且派发前被 runManager 的能力门 fail-closed 拒绝——这是期望行为。
  supportsSessionReuse = false;
  supportsInFlightCorrection = false;
  replayByRespawn = false;
  // ADR-0031 §3.3：usage_update + PromptResponse.usage → tokenBudget 闸门有效。
  // 注意终局 usage 缺失（evidence 里为 null）时本轮无 metrics 事实——如实缺省。
  reportsTokenUsage = true;

  constructor({ spawnFn = spawn, containmentPatchPath, platform } = {}) {
    this._spawnFn = spawnFn;
    this._containmentPatchPathOverride = containmentPatchPath;
    // platform 注入缝（测试用）：缺省 process.platform。compileInvocation 的
    // win32 .cmd/.bat 包裹行为因此可在任意宿主上被确定性钉住。
    this._platform = platform ?? process.platform;
  }

  _containmentPatchPath() {
    return this._containmentPatchPathOverride
      ?? path.join(os.homedir(), CONTAINMENT_HOME_RELATIVE);
  }

  validateAgentPolicy(agent) {
    if (agent?.provider) {
      throw new Error("deepseek-acp cannot express provider policy; the composition is fixed via --profile acp and operator-installed patches");
    }
    // model 块（id / contextWindow）在本集成面无可验证的设置通道（F5 只证明
    // configOptions 随会话**暴露**；模型取 shipped acp profile 的缺省）——
    // fail-closed 拒绝，不静默忽略（repo 纪律：配了不能表达的值必须硬拒）。
    if (agent?.model) {
      throw new Error("deepseek-acp cannot express a model block; the model comes from the shipped acp profile session configOptions");
    }
    // reasoning.effort 同源处置（Lead 2026-09-20 裁定选项 a）：ACP wire 上没有
    // 可验证的下发通道——argv/env/session 请求均不携带 effort，evidence 里也无
    // set_config_option 类方法。校验放行但静默不下发 = 用户配置假绿，硬拒。
    const effort = agent?.reasoning?.effort;
    if (effort !== undefined && effort !== null) {
      throw new Error("deepseek-acp cannot express reasoning.effort: no verified wire channel delivers it (argv/env/session requests carry no effort; configOptions are exposed, not settable from here) — refusing instead of silently ignoring");
    }
  }

  /**
   * 派发前校验（containment 资产 detect + resume fail-closed + argv 预算）。
   * runManager 在 transcript/worktree/spawn 之前调用；spawn 内部再跑一遍做权威防线。
   */
  async preflightInvocation(agent, task = {}) {
    const containmentPath = this._containmentPatchPath();
    let text;
    try {
      text = await readFile(containmentPath, "utf8");
    } catch {
      throw new Error(
        "deepseek-acp containment overlay is not readable: " + containmentPath
        + " — install it per docs/usage.md (operator-installed; WAO detects but never generates or upgrades it)",
      );
    }
    const parsed = parseContainmentOverlay(text);
    const matches = parsed !== null
      && parsed.size === EXPECTED_CONTAINMENT_OVERLAY.size
      && [...EXPECTED_CONTAINMENT_OVERLAY.keys()].every((id) => parsed.get(id) === true);
    if (!matches) {
      throw new Error(
        "deepseek-acp containment overlay at " + containmentPath
        + " does not match the declared overlay (expected " + EXPECTED_CONTAINMENT_OVERLAY.size
        + " disabled plugin ids per scripts/reliability/dsh-acp/wao-contain-safe.patch.yml)",
      );
    }
    // resume 轮 fail-closed：opaqueUuid→ACP sessionId 关联面（ADR-0031 §3.6）未补齐，
    // 拒绝恢复而不是静默开新会话（否则静默丢上下文）。
    if (task?.sessionReuse?.turn === "resume") {
      throw new Error(
        "deepseek-acp cannot resume a provider session yet: the opaqueUuid→ACP sessionId association contract (ADR-0031 §3.6) is not plumbed; refusing instead of silently starting a fresh session",
      );
    }
    return this._compileInvocation(agent, this._representativeRolePatchPath(Boolean(task.roleContract)));
  }

  async spawn(agent, task) {
    // preflight：containment detect + resume fail-closed + argv 预算预检
    // （representative role patch 路径，transcript/worktree 之前）。
    await this.preflightInvocation(agent, task);
    const agentEnv = agent.env ?? {};
    const forbiddenAgentEnv = Object.keys(agentEnv).find(isSecretEnvName);
    if (forbiddenAgentEnv) {
      throw new Error("secret-like agent.env key is not allowed: " + forbiddenAgentEnv);
    }

    const resolvedCredentials = task.resolvedCredentials ?? {};
    const inheritedNames = inheritedEnvNames(agent);
    const childEnv = buildChildEnv(inheritedNames, agentEnv, {
      WAO_TARGET_CWD: agent.cwd,
    }, resolvedCredentials);
    const redactor = createSecretRedactor(
      { ...process.env, ...resolvedCredentials },
      inheritedNames,
    );

    // per-dispatch 角色合同 patch：OS temp 下独占目录；启动时 best-effort 清扫孤儿。
    await this._sweepOrphanPatchDirs();
    const anomalies = [];
    const recordAnomaly = (note) => {
      if (anomalies.length >= ANOMALY_LIMIT) return;
      anomalies.push({ note });
    };
    let patchDir = null;
    let rolePatchPath = null;
    if (typeof task.roleContract === "string" && task.roleContract.length > 0) {
      patchDir = await mkdtemp(path.join(os.tmpdir(), PATCH_DIR_PREFIX));
      rolePatchPath = path.join(patchDir, ROLE_PATCH_FILE);
      await writeFile(rolePatchPath, serializeRoleContractPatch(task.roleContract), "utf8");
    }

    // 附加参数（--profile acp / --patch …）必须在 compile 之前进入 builtArgs，
    // spawn 使用 compileInvocation 的**产物**（compiled.args）——win32 + .cmd/.bat
    // 时产物是 `ComSpec /d /s /c <cmdLine>`（verbatim）。绕过产物直接喂 builtArgs
    // 会得到 `cmd.exe --profile acp …` 死链（审计阻塞项 1，上一轮假绿根因）；
    // 对照旧线 deepSeekHarness.js 同款 `compiled.args` 纪律。
    const compiled = await this._compileInvocation(agent, rolePatchPath);
    const child = this._spawnFn(compiled.binary, compiled.args, {
      cwd: agent.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: compiled.windowsVerbatimArguments,
    });
    const spawned = new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const queue = new EventQueue();
    const pending = new Map();
    const toolCalls = new Map();
    const pendingWrites = new Map();
    const pendingCommands = new Map();
    const terminalToolCalls = new Set();
    let acpSessionId = null;
    let nextRequestId = 1;
    let terminalQueued = false;
    let stderrTail = "";
    let cleanupStarted = false;

    const cleanup = async () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      if (patchDir) await rm(patchDir, { recursive: true, force: true }).catch(() => {});
    };

    const request = (method, params, timeoutMs = HANDSHAKE_TIMEOUT_MS) => new Promise((resolve, reject) => {
      const id = nextRequestId++;
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("deepseek-acp " + method + " timed out"));
        }, timeoutMs);
      }
      pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
        if (!error) return;
        const waiter = pending.get(id);
        pending.delete(id);
        waiter?.reject(error);
      });
    });

    const queueTerminal = (event) => {
      if (terminalQueued) return;
      terminalQueued = true;
      queue.push(event);
      void this._shutdown(child, request, acpSessionId).finally(cleanup);
    };

    const doneFromStopReason = (stopReason) => {
      if (stopReason === "end_turn") return doneEvent("completed");
      if (stopReason === "cancelled") {
        return doneEvent("failed", "deepseek-acp turn was cancelled before completion");
      }
      if (stopReason === "refusal" || stopReason === "max_tokens" || stopReason === "max_turn_requests") {
        return doneEvent("failed", "deepseek-acp turn failed: " + stopReason);
      }
      return doneEvent("failed", "deepseek-acp returned an unrecognized stopReason: " + bounded(stopReason));
    };

    const handleSessionUpdate = (update) => {
      if (terminalQueued) return;
      const type = update?.sessionUpdate;
      if (type === "user_message_chunk") return; // 我方 prompt 回显：已知，不投影
      if (type === "agent_message_chunk") {
        const text = update?.content?.text;
        if (typeof text === "string" && text.length > 0) {
          queue.push(redactor.redact(messageEvent("assistant", [{ type: "text", text }])));
        }
        return;
      }
      if (type === "agent_thought_chunk") {
        queue.push(thinkingEvent());
        return;
      }
      if (type === "tool_call") {
        handleToolCall(update);
        return;
      }
      if (type === "tool_call_update") {
        handleToolCallUpdate(update);
        return;
      }
      if (type === "usage_update") {
        // 上下文占用量（used/size）观察：绝不折算成 metrics 的 input（§3.4 去重规则）。
        return;
      }
      // 未知 sessionUpdate 类型 → fail-closed：不投影、不吞掉。
      queueTerminal(doneEvent("failed", "deepseek-acp emitted an unknown session update type: " + bounded(type)));
    };

    const handleToolCall = (update) => {
      if (terminalQueued) return;
      const toolCallId = typeof update.toolCallId === "string" && update.toolCallId.length > 0
        ? update.toolCallId
        : null;
      const tool = typeof update.title === "string" && update.title.length > 0
        ? update.title
        : "unknown";
      // 越界 tripwire（检测，非阻止）：deny-list 工具名即终态失败。
      if (DENIED_ORCHESTRATION_TOOLS.includes(tool)) {
        queueTerminal(doneEvent("failed", "deepseek-acp attempted a denied orchestration tool: " + bounded(tool)));
        return;
      }
      const input = parseRawInput(update.rawInput);
      // 缺失/空 toolCallId → 关联不可靠（docs/02-architecture.md §2.2 不可靠关联态）：
      // 绝不 write_intent / file_written（旧实现降级为字面量 "unknown" 再以 TRACKED
      // 关联，是可伪造 file_written 的面——审计阻塞项 2）；证据降级为 tool_use，
      // anomalies 留痕。不注册任何 pending 关联表。
      if (toolCallId === null) {
        recordAnomaly("tool_call without toolCallId; write correlation unreliable — no write_intent/file_written, tool_use evidence only (tool=" + bounded(tool) + ")");
        queue.push(redactor.redact(toolUseEvent(tool, input)));
        return;
      }
      // 重复 toolCallId → 拒绝覆盖待确认路径（toolCalls/pendingCommands/pendingWrites
      // 均保持首个，绝不静默改写关联面——否则后到的 file_path 可借同一 id 伪造
      // file_written）；留痕；证据仍投影 tool_use（wire 事实）。
      if (toolCalls.has(toolCallId)) {
        recordAnomaly("duplicate tool_call toolCallId refused overwrite; first correlation kept (toolCallId=" + toolCallId + ", tool=" + bounded(tool) + ")");
        queue.push(redactor.redact(toolUseEvent(tool, input)));
        return;
      }
      toolCalls.set(toolCallId, { tool });
      const key = tool.toLowerCase();
      if (SHELL_TOOL_NAMES.includes(key) && typeof input.command === "string" && input.command.length > 0) {
        // shell 类 → command 证据；退出码在终态更新到达时提取（无法提取则不伪造）。
        pendingCommands.set(toolCallId, input.command);
        return;
      }
      const events = [toolUseEvent(tool, input)];
      if (WRITE_TOOL_NAMES.includes(key)) {
        const filePath = input.file_path ?? input.path ?? input.filePath;
        if (typeof filePath === "string" && filePath.length > 0) {
          pendingWrites.set(toolCallId, filePath);
          events.push(writeIntentEvent(filePath, toolCallId, WRITE_INTENT_CORRELATION_STATUS.TRACKED));
        }
      }
      queue.push(...events.map((event) => redactor.redact(event)));
    };

    const handleToolCallUpdate = (update) => {
      if (terminalQueued) return;
      const toolCallId = typeof update.toolCallId === "string" && update.toolCallId.length > 0
        ? update.toolCallId
        : null;
      const status = update?.status;
      if (status === "pending" || status === "in_progress") return; // 绝不当作成功
      if (status !== "completed" && status !== "failed") {
        queueTerminal(doneEvent("failed", "deepseek-acp tool_call_update carried an unknown status: " + bounded(status)));
        return;
      }
      // 缺失/空 toolCallId：无法关联到任何 tool_call —— 绝不投影 tool_result /
      // file_written（不可靠关联态，审计阻塞项 2），留痕。
      if (toolCallId === null) {
        recordAnomaly("terminal tool_call_update without toolCallId ignored; no tool_result/file_written projected (status=" + status + ")");
        return;
      }
      // 重复/乱序终态：首个到达的终态为准，后续同 toolCallId 终态忽略并留痕。
      if (terminalToolCalls.has(toolCallId)) {
        recordAnomaly("duplicate terminal tool_call_update ignored (toolCallId=" + toolCallId + ", status=" + status + ")");
        return;
      }
      terminalToolCalls.add(toolCallId);
      const known = toolCalls.get(toolCallId);
      if (!known) {
        recordAnomaly("terminal tool_call_update without a prior tool_call (toolCallId=" + toolCallId + ")");
      }
      const tool = known?.tool ?? toolCallId;
      const isError = status === "failed";
      const output = Array.isArray(update.content) ? update.content : update.content ?? null;
      const events = [];
      const command = pendingCommands.get(toolCallId);
      if (command !== undefined) {
        pendingCommands.delete(toolCallId);
        events.push(commandEvent(command, extractExitCode(output), { toolCallId }));
      }
      events.push(toolResultEvent(tool, output, isError));
      const pendingPath = pendingWrites.get(toolCallId);
      if (pendingPath !== undefined) {
        pendingWrites.delete(toolCallId);
        // 关联成功才发 file_written；failed 绝不发。
        if (!isError) events.push(fileWrittenEvent(pendingPath, { toolCallId }));
      }
      queue.push(...events.map((event) => redactor.redact(event)));
    };

    // session/request_permission 应答（ADR-0031 §3.5 + 审计阻塞项 3）：
    // 必须应答且留审计痕，且受**会话与终态**约束——非本次绑定 sessionId、或终态
    // 已排队 → 绝不 allow，按 cancelled 应答（拒绝处理）并留痕。
    const answerPermissionRequest = (params) => {
      const options = Array.isArray(params?.options) ? params.options : [];
      const allow = options.find((option) => option?.kind === "allow_once" || option?.kind === "allow_always");
      if (allow && typeof allow.optionId === "string") {
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      }
      // 仅 reject 类 / 未知 kind：选中 reject；无可选项或无 reject 可选 → cancelled。
      // 绝不授予。
      const reject = options.find((option) =>
        typeof option?.kind === "string" && option.kind.startsWith("reject")
        && typeof option.optionId === "string");
      if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
      return { outcome: { outcome: "cancelled" } };
    };

    const auditPermissionAnswer = (params, decision, refusal) => {
      const options = Array.isArray(params?.options) ? params.options : [];
      const summary = {
        request: "session/request_permission",
        optionKinds: options.map((option) => (typeof option?.kind === "string" ? option.kind : null)),
        answered: decision.outcome.outcome === "selected"
          ? decision.outcome.optionId
          : decision.outcome.outcome,
      };
      if (refusal) summary.refused = refusal;
      const text = ("deepseek-acp permission answered: " + JSON.stringify(summary)).slice(0, 500);
      // system 消息进 transcript 供审计，但不是 usable effect（runEventIsUsableEffect
      // 只认 assistant 文本），不污染证据链。
      queue.push(redactor.redact(messageEvent("system", [{ type: "text", text }])));
    };

    const handleServerRequest = (frame) => {
      if (frame.method === "session/request_permission") {
        const params = frame.params ?? {};
        // 会话绑定 + 终态约束：未绑定（含 session/new 前到达）或终态已排队 →
        // cancelled，绝不 allow（阻塞项 3：否则异 session / 死会话可借权限面越权）。
        const sessionBound = acpSessionId !== null && params.sessionId === acpSessionId;
        const refusal = !sessionBound
          ? "session_not_bound"
          : (terminalQueued ? "terminal_queued" : null);
        const decision = refusal
          ? { outcome: { outcome: "cancelled" } }
          : answerPermissionRequest(params);
        if (refusal) {
          recordAnomaly("session/request_permission refused (" + refusal + "); answered cancelled, never allow");
        }
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: decision }) + "\n", (error) => {
          if (!error) return;
          recordAnomaly("session/request_permission response write failed: " + bounded(error?.message));
        });
        auditPermissionAnswer(params, decision, refusal);
        return;
      }
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: -32601, message: "deepseek-acp client does not support " + bounded(frame.method) },
      }) + "\n", () => {});
    };

    const processFrame = (frame) => {
      if (frame && typeof frame === "object" && Object.prototype.hasOwnProperty.call(frame, "id")) {
        if (typeof frame.method === "string") {
          handleServerRequest(frame); // 服务端→客户端请求（method + id）
          return;
        }
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.error) {
          waiter.reject(new Error("deepseek-acp JSON-RPC error " + (frame.error.code ?? "unknown")));
        } else {
          waiter.resolve(frame.result);
        }
        return;
      }
      if (frame && typeof frame === "object" && typeof frame.method === "string") {
        if (frame.method !== "session/update") return; // 其余通知：不涉及本轮事实
        // 未绑定 sessionId（不匹配本轮 session）→ 丢弃，绝不投影为本 run 事实。
        if (acpSessionId === null || frame.params?.sessionId !== acpSessionId) return;
        handleSessionUpdate(frame.params?.update);
        return;
      }
      // 合法 JSON 但非帧形状：忽略（malformed JSON 在行解析处 fail-closed）。
    };

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        processFrame(JSON.parse(line));
      } catch {
        queueTerminal(doneEvent("failed", "deepseek-acp emitted malformed JSON-RPC"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = trimTail(redactor.redactString(stderrTail + chunk.toString("utf8")));
    });
    child.on("close", (code) => {
      for (const waiter of pending.values()) {
        waiter.reject(new Error("deepseek-acp transport closed"));
      }
      pending.clear();
      if (!terminalQueued) {
        const suffix = stderrTail ? "; stderr: " + stderrTail : "; exit code: " + code;
        queue.push(doneEvent("failed", "deepseek-acp transport closed before completion" + suffix));
        terminalQueued = true;
      }
      queue.close();
      void cleanup();
    });

    try {
      await spawned;
      const initialized = await request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "wao-backend", version: "1" },
      });
      const agentName = initialized?.agentInfo?.name
        ?? initialized?.agentCapabilities?.agentInfo?.name;
      if (agentName !== ACP_RUNTIME_NAME) {
        throw new Error("deepseek-acp runtime identity mismatch");
      }
      queue.push(runtimeActivityEvent("initialized"));
      const created = await request("session/new", {
        cwd: agent.cwd,
        mcpServers: [],
      });
      if (typeof created?.sessionId !== "string" || created.sessionId.length === 0) {
        throw new Error("deepseek-acp returned no sessionId");
      }
      acpSessionId = created.sessionId;
      // prompt 响应只在整轮结束到达：不等待响应即返回 handle（timeoutMs=0——
      // 生命周期由 WAO waitTimeout/abort 治理，不在传输层伪造死线）。
      const promptPromise = request("session/prompt", {
        sessionId: acpSessionId,
        prompt: [{ type: "text", text: task.prompt }],
      }, 0);
      promptPromise.then((result) => {
        if (terminalQueued) return;
        // 终局用量唯一来源：PromptResponse.usage（usage_update 绝不计入）。
        const usage = result?.usage;
        if (usage && typeof usage === "object") {
          queue.push(redactor.redact(metricsEvent({
            input: numberFrom(usage.inputTokens, usage.input_tokens, usage.input),
            output: numberFrom(usage.outputTokens, usage.output_tokens, usage.output),
            reasoning: numberFrom(usage.reasoningTokens, usage.reasoning_tokens),
            cacheRead: numberFrom(usage.cacheReadTokens, usage.cache_read_input_tokens, usage.cacheRead),
            cacheWrite: numberFrom(usage.cacheWriteTokens, usage.cache_creation_input_tokens, usage.cacheWrite),
          })));
        }
        queueTerminal(doneFromStopReason(result?.stopReason));
      }).catch((error) => {
        if (terminalQueued) return;
        queueTerminal(doneEvent("failed", "deepseek-acp session/prompt failed: " + bounded(error?.message)));
      });
    } catch (error) {
      this._kill(child);
      await cleanup();
      throw error;
    }

    return {
      backend: BACKEND_NAME,
      backendSessionId: acpSessionId,
      redact: (value) => redactor.redact(value),
      events: (signal) => this._events(queue, child, signal),
      abort: async () => {
        // F7：session/cancel 是真取消。先 best-effort 取消，再 close + kill。
        if (acpSessionId && child.exitCode === null && !child.signalCode) {
          await Promise.race([
            request("session/cancel", { sessionId: acpSessionId }, SHUTDOWN_TIMEOUT_MS).catch(() => null),
            new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
          ]);
        }
        await this._shutdown(child, request, acpSessionId);
        await cleanup();
      },
      isAlive: () => child.exitCode === null && child.signalCode === null,
      // 有界留痕（重复终态/未知关联等），诊断用；不进 transcript。
      anomalies,
    };
  }

  async *_events(queue, child, signal) {
    let hasUsableEffect = false;
    const onAbort = () => this._kill(child);
    signal?.addEventListener("abort", onAbort);
    try {
      while (true) {
        for (const event of queue.drain()) {
          if (event.kind === "done" && event.reason === "completed" && !hasUsableEffect) {
            event.marker = DONE_MARKERS[0];
          } else if (runEventIsUsableEffect(event)) {
            hasUsableEffect = true;
          }
          yield event;
        }
        if (queue.closed && queue.hasItems()) continue;
        if (queue.closed) return;
        await new Promise((resolve) => {
          queue.resolveWait = resolve;
        });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  _buildArgs(agent, rolePatchPath) {
    // WAO 固定旗标排在 agent.args 之后：compose 层后写胜出，操作者 args 不能
    // 重排/覆盖 containment 与 profile。
    const args = [...(Array.isArray(agent.args) ? agent.args : [])];
    args.push("--profile", "acp", "--patch", this._containmentPatchPath());
    if (rolePatchPath) args.push("--patch", rolePatchPath);
    return args;
  }

  _representativeRolePatchPath(hasRoleContract) {
    if (!hasRoleContract) return null;
    // mkdtemp 追加恰好 6 个随机字符；预算预检用等长代表路径（spawn 内的
    // compileInvocation 才是权威防线）。
    return path.join(os.tmpdir(), PATCH_DIR_PREFIX + "000000", ROLE_PATCH_FILE);
  }

  async _sweepOrphanPatchDirs() {
    // best-effort：只清本 backend 专属前缀且已陈旧的目录；任何失败静默放行
    // （绝不触碰 ~/.wao/runtimes、绝不删除会话存储）。
    try {
      const entries = await readdir(os.tmpdir());
      const cutoff = Date.now() - PATCH_SWEEP_STALE_MS;
      await Promise.all(entries
        .filter((name) => name.startsWith(PATCH_DIR_PREFIX))
        .map(async (name) => {
          const full = path.join(os.tmpdir(), name);
          try {
            const info = await stat(full);
            if (!info.isDirectory() || info.mtimeMs >= cutoff) return;
            await rm(full, { recursive: true, force: true });
          } catch { /* best effort */ }
        }));
    } catch { /* best effort */ }
  }

  async _compileInvocation(agent, rolePatchPath) {
    let binary = agent.binary ?? DEFAULT_BINARY;
    if (!path.isAbsolute(binary) && path.dirname(binary) === "." && this._platform === "win32") {
      try {
        const output = execFileSync("where.exe", [binary], { encoding: "utf8", windowsHide: true });
        const paths = output.split(/\r?\n/).filter(Boolean);
        binary = paths.find((value) => value.toLowerCase().endsWith(".exe"))
          ?? paths.find((value) => value.toLowerCase().endsWith(".cmd"))
          ?? paths[0]
          ?? binary;
      } catch {
        // Spawn remains authoritative and reports ENOENT without mutating config.
      }
    }
    return compileInvocation({
      binary,
      builtArgs: this._buildArgs(agent, rolePatchPath),
      platform: this._platform,
    });
  }

  async _shutdown(child, request, sessionId) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    await Promise.race([
      request("session/close", sessionId ? { sessionId } : {}, SHUTDOWN_TIMEOUT_MS).catch(() => null),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
    if (child.exitCode === null && !child.signalCode) this._kill(child);
  }

  _kill(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  }
}
