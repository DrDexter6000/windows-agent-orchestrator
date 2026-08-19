import { execFileSync, spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

import {
  commandEvent,
  doneEvent,
  DONE_MARKERS,
  fileWrittenEvent,
  messageEvent,
  metricsEvent,
  runEventIsUsableEffect,
  runtimeActivityEvent,
  toolResultEvent,
  toolUseEvent,
  writeIntentEvent,
  WRITE_INTENT_CORRELATION_STATUS,
} from "../runEvent.js";
import { inheritedEnvNames } from "../envPolicy.js";
import { createSecretRedactor, isSecretEnvName } from "../secretRedaction.js";
import { buildChildEnv, compileInvocation } from "./processBackend.js";

const RUNTIME_NAME = "deepseek-harness-sdk-runtime";
const DEFAULT_PROVIDER = "deepseek-official";
const MAX_BUFFERED_NOTIFICATIONS = 2048;
const STDERR_TAIL_LIMIT = 4000;
const SHUTDOWN_TIMEOUT_MS = 1000;

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

export { EventQueue as DeepSeekHarnessEventQueue };

/**
 * DeepSeek Harness JSON-RPC backend.
 *
 * One WAO run owns one DSH process and one SDK session. DSH supplies the model
 * loop and tools; WAO remains the only owner of orchestration, transcript,
 * worktree, stop, verification, delivery, and Lead handoff.
 */
export class DeepSeekHarnessBackend {
  supportsRoleContract = true;
  supportsSessionReuse = false;
  supportsInFlightCorrection = false;
  replayByRespawn = true;

  // ADR-0025 批次 2（TD-87）：assistant/message 帧携带 usage（projectDshEvent
  // 投影为 metrics token 事实）——tokenBudget 闸门对该 backend 有效。
  reportsTokenUsage = true;

  constructor({ spawnFn = spawn } = {}) {
    this._spawnFn = spawnFn;
  }

  validateAgentPolicy(agent) {
    if (agent?.provider) {
      throw new Error("deepseek-harness cannot express provider policy; configure the DSH composition instead");
    }
    const effort = agent?.reasoning?.effort;
    if (effort !== undefined && !["high", "max"].includes(effort)) {
      throw new Error("deepseek-harness reasoning.effort must be high or max when present");
    }
  }

  async preflightInvocation(agent) {
    const configPath = agent?.dshConfigPath;
    if (typeof configPath !== "string" || configPath.trim().length === 0) {
      throw new Error("deepseek-harness requires dshConfigPath");
    }
    try {
      await access(path.resolve(configPath));
    } catch {
      throw new Error("deepseek-harness dshConfigPath is not readable");
    }
    return this._compileInvocation(agent);
  }

  async spawn(agent, task) {
    const compiled = await this.preflightInvocation(agent, task);
    const agentEnv = agent.env ?? {};
    const forbiddenAgentEnv = Object.keys(agentEnv).find(isSecretEnvName);
    if (forbiddenAgentEnv) {
      throw new Error(`secret-like agent.env key is not allowed: ${forbiddenAgentEnv}`);
    }

    const resolvedCredentials = task.resolvedCredentials ?? {};
    const inheritedNames = inheritedEnvNames(agent);
    const sessionRoot = await mkdtemp(path.join(os.tmpdir(), "wao-dsh-session-"));
    const childEnv = buildChildEnv(inheritedNames, agentEnv, {
      DSH_CORDIS_CONFIG: path.resolve(agent.dshConfigPath),
      DSH_CWD: agent.cwd,
      DSH_MODEL: agent.model?.id ?? "deepseek-v4-flash",
      ...(agent.model?.contextWindow
        ? { DSH_CONTEXT_WINDOW: String(agent.model.contextWindow) }
        : {}),
      ...(agent.reasoning?.effort
        ? { DSH_REASONING_EFFORT: agent.reasoning.effort }
        : {}),
      ...(task.roleContract ? { DSH_SYSTEM_PROMPT: task.roleContract } : {}),
      DSH_SESSION_ROOT: sessionRoot,
      WAO_TARGET_CWD: agent.cwd,
    }, resolvedCredentials);
    const redactor = createSecretRedactor(
      { ...process.env, ...resolvedCredentials },
      inheritedNames,
    );

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
    const buffered = [];
    const dshSessionId = `wao-${randomUUID()}`;
    let nextRequestId = 1;
    let messageId = null;
    let receiptSeen = false;
    let streamingSeen = false;
    let turnEndReason = null;
    let terminalQueued = false;
    let stderrTail = "";
    let cleanupStarted = false;
    const pendingWrites = new Map();

    const cleanup = async () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      await rm(sessionRoot, { recursive: true, force: true }).catch(() => {});
    };

    const request = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
      const id = nextRequestId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`deepseek-harness ${method} timed out`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
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
      void this._shutdown(child, request).finally(cleanup);
    };

    const consumeNotification = (frame) => {
      if (terminalQueued) return;
      if (frame.method === "subagent.started" || frame.method === "subagent.finished") {
        if (frame.params?.parentSessionId === dshSessionId) {
          queueTerminal(doneEvent("failed", "deepseek-harness started an unauthorized internal subagent"));
        }
        return;
      }
      if (frame.method === "session.event") {
        if (frame.params?.sessionId !== dshSessionId) return;
        const event = frame.params.event;
        if (!receiptSeen) {
          if (isPromptReceipt(event, messageId)) receiptSeen = true;
          return;
        }
        if (event?.type === "turn/end") {
          turnEndReason = event.data?.reason ?? null;
          return;
        }
        if (event?.type === "assistant/chunk") {
          if (streamingSeen) return;
          streamingSeen = true;
        }
        const projected = projectDshEvent(event, pendingWrites).map((value) => redactor.redact(value));
        if (projected.length > 0) queue.push(...projected);
        return;
      }
      if (frame.method === "session.status" && frame.params?.sessionId === dshSessionId
        && frame.params?.status === "idle" && receiptSeen) {
        if (!turnEndReason) {
          queueTerminal(doneEvent("failed", "deepseek-harness became idle before a turn result"));
          return;
        }
        if (turnEndReason.kind === "completed") {
          queueTerminal(doneEvent("completed"));
          return;
        }
        const code = typeof turnEndReason.error?.code === "string"
          ? turnEndReason.error.code
          : turnEndReason.kind;
        queueTerminal(doneEvent("failed", `deepseek-harness turn failed: ${code}`));
      }
    };

    const processFrame = (frame) => {
      if (Object.prototype.hasOwnProperty.call(frame, "id")) {
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.error) {
          waiter.reject(new Error(`deepseek-harness JSON-RPC error ${frame.error.code ?? "unknown"}`));
        } else {
          waiter.resolve(frame.result);
        }
        return;
      }
      if (typeof frame.method !== "string") return;
      if (messageId === null) {
        if (buffered.length >= MAX_BUFFERED_NOTIFICATIONS) {
          queueTerminal(doneEvent("failed", "deepseek-harness notification buffer exceeded"));
          return;
        }
        buffered.push(frame);
        return;
      }
      consumeNotification(frame);
    };

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        processFrame(JSON.parse(line));
      } catch {
        queueTerminal(doneEvent("failed", "deepseek-harness emitted malformed JSON-RPC"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = trimTail(redactor.redactString(stderrTail + chunk.toString("utf8")));
    });
    child.on("close", (code) => {
      for (const waiter of pending.values()) {
        waiter.reject(new Error("deepseek-harness transport closed"));
      }
      pending.clear();
      if (!terminalQueued) {
        const suffix = stderrTail ? `; stderr: ${stderrTail}` : `; exit code: ${code}`;
        queue.push(doneEvent("failed", `deepseek-harness transport closed before completion${suffix}`));
        terminalQueued = true;
      }
      queue.close();
      void cleanup();
    });

    try {
      await spawned;
      const initialized = await request("initialize", {
        cwd: agent.cwd,
        provider: agent.dshProvider ?? DEFAULT_PROVIDER,
        model: agent.model?.id ?? "deepseek-v4-flash",
        ...(agent.maxTokens ? { maxTokens: agent.maxTokens } : {}),
      });
      if (initialized?.serverInfo?.name !== RUNTIME_NAME) {
        throw new Error("deepseek-harness runtime identity mismatch");
      }
      queue.push(runtimeActivityEvent("initialized"));
      const prompted = await request("session/prompt", {
        sessionId: dshSessionId,
        contentBlocks: [{ type: "text", text: task.prompt }],
      });
      if (typeof prompted?.messageId !== "string" || prompted.messageId.length === 0) {
        throw new Error("deepseek-harness returned no prompt receipt");
      }
      messageId = prompted.messageId;
      for (const frame of buffered.splice(0)) consumeNotification(frame);
    } catch (error) {
      this._kill(child);
      await cleanup();
      throw error;
    }

    return {
      backend: "deepseek-harness",
      backendSessionId: `proc_${child.pid}`,
      messageId,
      redact: (value) => redactor.redact(value),
      events: (signal) => this._events(queue, child, signal),
      abort: async () => {
        await this._shutdown(child, request);
        await cleanup();
      },
      isAlive: () => child.exitCode === null && child.signalCode === null,
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

  async _compileInvocation(agent) {
    let binary = agent.binary ?? "dsh-jsonrpc-agent";
    if (!path.isAbsolute(binary) && path.dirname(binary) === "." && process.platform === "win32") {
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
      builtArgs: Array.isArray(agent.args) ? agent.args : [],
      platform: process.platform,
    });
  }

  async _shutdown(child, request) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    await Promise.race([
      request("shutdown", undefined, SHUTDOWN_TIMEOUT_MS).catch(() => null),
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

export function projectDshEvent(event, pendingWrites = new Map()) {
  if (!event || typeof event !== "object") return [];
  if (event.type === "assistant/chunk") return [runtimeActivityEvent("streaming")];
  if (event.type === "assistant/message") {
    const content = event.data?.message?.content;
    const parts = Array.isArray(content)
      ? content.filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => ({ type: "text", text: block.text }))
      : [];
    const events = parts.length > 0 ? [messageEvent("assistant", parts)] : [];
    const usage = event.data?.usage;
    if (usage && typeof usage === "object") {
      events.push(metricsEvent({
        input: numberFrom(usage.inputTokens, usage.input_tokens),
        output: numberFrom(usage.outputTokens, usage.output_tokens),
        reasoning: numberFrom(usage.reasoningTokens, usage.reasoning_tokens),
        cacheRead: numberFrom(usage.cacheReadTokens, usage.cache_read_input_tokens),
        cacheWrite: numberFrom(usage.cacheWriteTokens, usage.cache_creation_input_tokens),
      }));
    }
    return events;
  }
  if (event.type === "tool/call") {
    const callId = String(event.data?.callId ?? "unknown");
    const name = String(event.data?.name ?? "unknown");
    const input = parseArguments(event.data?.arguments);
    const key = name.toLowerCase();
    if (["pwsh", "powershell", "bash", "shell"].includes(key)
      && typeof input.command === "string") {
      return [commandEvent(input.command, undefined, { toolCallId: callId })];
    }
    if (["str_replace_editor", "write", "edit", "multiedit"].includes(key)) {
      const filePath = input.path ?? input.filePath ?? input.file_path;
      if (typeof filePath === "string" && filePath.length > 0) {
        pendingWrites.set(callId, filePath);
        return [writeIntentEvent(
          filePath,
          callId,
          WRITE_INTENT_CORRELATION_STATUS.TRACKED,
        )];
      }
    }
    return [toolUseEvent(name, input)];
  }
  if (event.type === "tool/result") {
    const callId = String(event.data?.message?.source?.callId ?? "unknown");
    const isError = !!event.data?.error;
    const output = event.data?.message?.content ?? [];
    const events = [toolResultEvent(callId, output, isError)];
    const pendingPath = pendingWrites.get(callId);
    pendingWrites.delete(callId);
    if (pendingPath && !isError) {
      events.push(fileWrittenEvent(pendingPath, { toolCallId: callId }));
    }
    return events;
  }
  return [];
}

function isPromptReceipt(event, messageId) {
  if (!messageId || event?.type !== "agent/inbox/spliced") return false;
  return Array.isArray(event.data?.inserted)
    && event.data.inserted.some((message) => message?.id === messageId);
}

function parseArguments(value) {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function numberFrom(...values) {
  return values.find((value) => typeof value === "number");
}

function trimTail(value) {
  const text = String(value);
  return text.length <= STDERR_TAIL_LIMIT ? text : text.slice(-STDERR_TAIL_LIMIT);
}
