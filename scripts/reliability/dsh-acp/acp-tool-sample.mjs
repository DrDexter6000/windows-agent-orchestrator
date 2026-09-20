#!/usr/bin/env node
/** Q4 前置采样：抓 ACP wire 上 tool_call 的真实字段形状与工具名。 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const WS = process.env.PROBE_WS;
const DSH = process.env.PROBE_DSH ?? "dsh";
const extra = process.env.PROBE_PATCH ? ["--patch", process.env.PROBE_PATCH] : [];
const stderr = [];
const raw = [];
const child = spawn(DSH, ["--profile", "acp", ...extra], { cwd: WS, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
createInterface({ input: child.stderr }).on("line", (l) => stderr.push(l));
let id = 1; const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "session/update") { raw.push(m.params?.update); return; }
  if (m.method) {
    if (m.id != null) {
      let result = {};
      if (m.method === "session/request_permission") {
        const o = (m.params?.options ?? []).find((x) => String(x.kind || "").startsWith("allow")) ?? m.params?.options?.[0];
        result = { outcome: { outcome: "selected", optionId: o?.optionId } };
      }
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
    }
    return;
  }
  const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
  m.error ? p.reject(new Error(m.error.code + ": " + m.error.message)) : p.resolve(m.result);
});
const req = (method, params) => new Promise((res, rej) => {
  const i = id++; const t = setTimeout(() => rej(new Error(method + " timeout")), 420000);
  pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
});

const TASK = [
  "请依次执行，不要跳过：",
  "1) 创建文件 tool_probe.txt，内容一行：TOOL_PROBE",
  "2) 用 shell 命令读取它",
  "3) 如果你手上有派生子代理(subagent/teammate)的工具，请实际调用一次，让它只回复 ok；如果你没有这个工具，就直接说明你没有",
  "4) 最后列出你这一轮实际调用过的每个工具的名称",
].join("\n");

try {
  await req("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "wao-tool-sample", version: "1" } });
  const s = await req("session/new", { cwd: WS, mcpServers: [] });
  const r = await req("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: TASK }] });
  const toolUpdates = raw.filter((u) => /^tool_call/.test(String(u?.sessionUpdate)));
  console.log(JSON.stringify({
    stopReason: r?.stopReason,
    toolUpdateCount: toolUpdates.length,
    fullFirstToolCall: toolUpdates.find((u) => u.sessionUpdate === "tool_call") ?? null,
    allToolCalls: toolUpdates.filter((u) => u.sessionUpdate === "tool_call").map((u) => ({ title: u.title, kind: u.kind, toolCallId: u.toolCallId, rawInputKeys: u.rawInput ? Object.keys(u.rawInput) : null, contentTypes: (u.content ?? []).map((c) => c.type) })),
    updateKeysSeen: [...new Set(raw.map((u) => u?.sessionUpdate))],
  }, null, 2));
} catch (e) { console.log(JSON.stringify({ error: String(e.message), stderrTail: stderr.slice(-5) })); }
try { child.stdin.end(); child.kill(); } catch {}
setTimeout(() => process.exit(0), 300);
