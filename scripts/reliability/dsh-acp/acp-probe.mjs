#!/usr/bin/env node
/**
 * B-2 技术验证探针（WAO 侧客户端视角）
 *
 * 目的：证明最新版 dsh（0.1.5-rc.2）可通过 **ACP 集成面** 驱动 DeepSeek，
 *       并具备 **跨进程 session/resume** 能力 —— 即 WAO TD-117 卡点的正解。
 *
 * 约束：零依赖（只用 node: 内置模块），与 WAO「不新增生产依赖」的不变量一致。
 *      本探针只做验证，不改动 WAO 的 provider/model 配置。
 *
 * 用法：
 *   node acp-probe.mjs new                 # 阶段 1：新建会话 + 真实工具调用
 *   node acp-probe.mjs list                # 阶段 2a：列出可恢复会话
 *   node acp-probe.mjs resume <sessionId>  # 阶段 2b：**另一个进程**恢复会话并追问
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const MODE = process.argv[2] ?? "new";
const SESSION_ID = process.argv[3];
const WS = process.env.PROBE_WS;
const DSH = process.env.PROBE_DSH ?? "dsh";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 420000);

if (!WS) { console.error("PROBE_WS is required"); process.exit(2); }
mkdirSync(WS, { recursive: true });

const TASK_NEW =
  "请完成两件事：\n" +
  "1) 在当前工作目录创建文件 proof.txt，内容恰好一行：WAO_DSH_ACP_OK\n" +
  "2) 用 shell 命令读取该文件内容\n" +
  "最后在回复的最后单独一行输出：PHASE1_DONE";

const TASK_RESUME =
  "不要使用任何工具。仅凭你对本会话之前的记忆回答：" +
  "上一轮你写入 proof.txt 的文件内容是什么？请逐字包含那一行。";

const updates = [];
const stderrLines = [];
let sessionId = null;

class Peer {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this._onLine(line));
  }
  _send(obj) { this.child.stdin.write(JSON.stringify(obj) + "\n"); }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { stderrLines.push("[non-JSON stdout] " + line.slice(0, 200)); return; }

    // 服务器 -> 客户端 请求
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      let result;
      try { result = await onServerRequest(msg.method, msg.params); }
      catch (e) { this._send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: String(e.message) } }); return; }
      this._send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    // 通知：session/update 等
    if (msg.method) { updates.push({ method: msg.method, params: msg.params }); return; }
    // 我方请求的响应
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }
}

async function onServerRequest(method, params) {
  if (method === "session/request_permission") {
    const opts = params?.options ?? [];
    const allow = opts.find((o) => String(o.kind || "").startsWith("allow")) ?? opts[0];
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }
  throw new Error("unsupported server request: " + method);
}

function spawnServer() {
  const extra = process.env.PROBE_PATCH ? ["--patch", process.env.PROBE_PATCH] : [];
  const child = spawn(DSH, ["--profile", "acp", ...extra], {
    cwd: WS,
    env: { ...process.env, DSH_HOME: process.env.DSH_HOME },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  createInterface({ input: child.stderr }).on("line", (l) => stderrLines.push(l));
  return child;
}

function summarize(peer) {
  const text = updates
    .filter((u) => u.method === "session/update" && u.params?.update?.sessionUpdate === "agent_message_chunk")
    .map((u) => u.params.update.content?.text ?? "").join("");
  const thoughts = updates
    .filter((u) => u.method === "session/update" && u.params?.update?.sessionUpdate === "agent_thought_chunk")
    .map((u) => u.params.update.content?.text ?? "").join("");
  const tools = updates
    .filter((u) => u.method === "session/update" && /^tool_call/.test(String(u.params?.update?.sessionUpdate)))
    .map((u) => ({
      kind: u.params.update.sessionUpdate,
      toolCallId: u.params.update.toolCallId,
      title: u.params.update.title,
      status: u.params.update.status,
      toolKind: u.params.update.kind,
      rawInput: u.params.update.rawInput ? JSON.stringify(u.params.update.rawInput).slice(0, 300) : undefined,
    }));
  const config = updates
    .filter((u) => u.method === "session/update" && String(u.params?.update?.sessionUpdate).includes("config"))
    .map((u) => u.params.update);
  const usage = updates
    .filter((u) => u.method === "session/update" && String(u.params?.update?.sessionUpdate).includes("usage"))
    .map((u) => u.params.update);
  return { text, thoughts: thoughts.slice(0, 1200), tools, config, usage };
}

function emit(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

const child = spawnServer();
const peer = new Peer(child);
const evidence = { mode: MODE, dsh: DSH, workspace: WS, sessionId: null, steps: {} };

const guard = setTimeout(() => {
  emit({ ...evidence, fatal: "overall timeout" });
  try { child.kill(); } catch {}
  process.exit(3);
}, TIMEOUT_MS + 30000);

try {
  const init = await peer.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "wao-b2-probe", version: "0.0.1" },
  });
  evidence.steps.initialize = {
    protocolVersion: init?.protocolVersion,
    agentInfo: init?.agentInfo ?? init?.agentCapabilities?.agentInfo ?? null,
    sessionCapabilities: init?.agentCapabilities?.sessionCapabilities ?? null,
    promptCapabilities: init?.agentCapabilities?.promptCapabilities ?? null,
    authMethods: (init?.authMethods ?? []).map((a) => a.id),
  };

  if (MODE === "list") {
    const listed = await peer.request("session/list", { cwd: WS });
    evidence.steps.sessionList = {
      count: listed?.sessions?.length ?? 0,
      sessions: (listed?.sessions ?? []).slice(0, 5).map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt })),
      nextCursor: listed?.nextCursor ?? null,
    };
  } else if (MODE === "resume") {
    if (!SESSION_ID) throw new Error("resume needs a sessionId");
    sessionId = SESSION_ID;
    evidence.sessionId = sessionId;
    const resumed = await peer.request("session/resume", { sessionId, cwd: WS, mcpServers: [] });
    evidence.steps.resume = {
      configOptions: (resumed?.configOptions ?? []).map((c) => ({ id: c.id, category: c.category, currentValue: c.currentValue, optionCount: (c.options ?? []).length })),
    };
    updates.length = 0;
    const answered = await peer.request("session/prompt", {
      sessionId, prompt: [{ type: "text", text: TASK_RESUME }],
    });
    evidence.steps.prompt = { stopReason: answered?.stopReason, usage: answered?.usage ?? null };
    evidence.result = summarize(peer);
    evidence.resumeRecalledSentinel = /WAO_DSH_ACP_OK/.test(evidence.result.text);
  } else {
    const created = await peer.request("session/new", { cwd: WS, mcpServers: [] });
    sessionId = created?.sessionId;
    evidence.sessionId = sessionId;
    evidence.steps.sessionNew = {
      configOptions: (created?.configOptions ?? []).map((c) => ({
        id: c.id, name: c.name, category: c.category, currentValue: c.currentValue,
        options: (c.options ?? []).map((o) => o.value ?? o.group ?? JSON.stringify(o)).slice(0, 12),
      })),
    };
    updates.length = 0;
    const answered = await peer.request("session/prompt", {
      sessionId, prompt: [{ type: "text", text: TASK_NEW }],
    });
    evidence.steps.prompt = { stopReason: answered?.stopReason, usage: answered?.usage ?? null };
    evidence.result = summarize(peer);
    evidence.proofFileOnDisk = null;
    try { evidence.proofFileOnDisk = (await import("node:fs")).readFileSync(path.join(WS, "proof.txt"), "utf8"); } catch { evidence.proofFileOnDisk = "<missing>"; }
    await peer.request("session/close", { sessionId });
    evidence.steps.closed = true;
  }
} catch (e) {
  evidence.error = String(e.message);
} finally {
  clearTimeout(guard);
  evidence.stderrTail = stderrLines.slice(-25);
  emit(evidence);
  try { child.stdin.end(); child.kill(); } catch {}
  setTimeout(() => process.exit(0), 300);
}
