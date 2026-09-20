#!/usr/bin/env node
/** ACP containment smoke: initialize -> session/new -> session/close（不调用模型）。 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const WS = process.env.PROBE_WS;
const DSH = process.env.PROBE_DSH ?? "dsh";
const extra = process.env.PROBE_PATCH ? ["--patch", process.env.PROBE_PATCH] : [];
const stderr = [];
const child = spawn(DSH, ["--profile", "acp", ...extra], { cwd: WS, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
createInterface({ input: child.stderr }).on("line", (l) => stderr.push(l));
let id = 1;
const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method) { if (m.id != null) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\n"); return; }
  const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
  m.error ? p.reject(new Error(`${m.error.code}: ${m.error.message}`)) : p.resolve(m.result);
});
const req = (method, params) => new Promise((res, rej) => {
  const i = id++; const t = setTimeout(() => rej(new Error(method + " timeout")), 90000);
  pending.set(i, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
});
const out = { patch: process.env.PROBE_PATCH ?? "(none)", ok: false };
try {
  await req("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "wao-smoke", version: "1" } });
  const s = await req("session/new", { cwd: WS, mcpServers: [] });
  out.sessionId = s?.sessionId;
  out.configOptions = (s?.configOptions ?? []).map((c) => ({ id: c.id, current: c.currentValue }));
  await req("session/close", { sessionId: s.sessionId });
  out.ok = true;
} catch (e) { out.error = String(e.message); }
out.stderrTail = stderr.slice(-12);
console.log(JSON.stringify(out));
try { child.stdin.end(); child.kill(); } catch {}
setTimeout(() => process.exit(0), 200);
