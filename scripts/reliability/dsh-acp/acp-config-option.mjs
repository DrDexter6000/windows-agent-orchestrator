#!/usr/bin/env node
/**
 * ACP config-option 可设置性探针（session/set_config_option）。
 *
 * 目的：证明（或证伪）`dsh --profile acp`（0.1.5-rc.2）的 ACP 面**可设置**
 *       session configOptions（reasoning_effort / model），而不只是随
 *       session/new 暴露。WAO 侧此前对 reasoning.effort 硬拒的依据正是
 *       "只有暴露证据、没有设置证据"——本探针补齐设置证据。
 *
 * 纪律：零依赖（只用 node: 内置模块）、无凭据（API key 只经环境注入，本文件
 *      不含任何 secret）。**不发 session/prompt**——一个会话内只做
 *      initialize → session/new → set_config_option 序列 → session/close，
 *      不消耗模型 token。
 *
 * 步骤（单会话）：
 *   1. initialize
 *   2. session/new（带 containment patch，与 backend 生产组合同形）
 *   3. 记录 configOptions 的当前值与广告值域（reasoning_effort + model）
 *   4. set_config_option(reasoning_effort → 另一个广告值)，记录响应
 *   5. 负对照：set_config_option(reasoning_effort → 不在广告值域内的值)，
 *      记录拒绝形状
 *   6. 再 set 一次第三个广告值（状态延续性 + 二次读取）
 *   7. model 一次 set 尝试（**只取证**；选广告里不同于当前值的一个）
 *   8. session/close
 *
 * 用法（PowerShell，见 README.md）：
 *   $env:PROBE_WS = "<一次性工作区>"
 *   node scripts/reliability/dsh-acp/acp-config-option.mjs
 * 可选：PROBE_OUT=<路径> 把 evidence JSON 落盘；PROBE_PATCH 覆盖 containment
 *      patch（缺省 = 本目录 wao-contain-safe.patch.yml）；PROBE_DSH 覆盖二进制。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WS = process.env.PROBE_WS;
const DSH = process.env.PROBE_DSH ?? "dsh";
const OUT = process.env.PROBE_OUT;
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 60000);
// 缺省叠加本目录的 containment 覆盖层（与 deepseek-acp backend 生产组合同形）。
const PATCH = process.env.PROBE_PATCH
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "wao-contain-safe.patch.yml");

if (!WS) { console.error("PROBE_WS is required"); process.exit(2); }
mkdirSync(WS, { recursive: true });

// 负对照值：WAO registry 闭集成员，但 ACP 面**不**广告（evidence/phase4：
// reasoning_effort 广告 off/low/high/max）。用它同时钉"域外值被拒"与
// "WAO 六值 ≠ ACP 四值"的诚实边界。
const NEGATIVE_CONTROL_VALUE = "medium";

const updates = [];
const stderrLines = [];
let sessionId = null;

class Peer {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    createInterface({ input: child.stdout }).on("line", (line) => this._onLine(line));
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
  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { stderrLines.push("[non-JSON stdout] " + line.slice(0, 200)); return; }
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      // 服务端→客户端请求：一律空结果应答（本探针不触发权限/审批路径）
      this._send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    if (msg.method) { updates.push({ method: msg.method, params: msg.params }); return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(Object.assign(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`), { wire: msg.error }));
    else p.resolve(msg.result);
  }
}

function spawnServer() {
  const child = spawn(DSH, ["--profile", "acp", "--patch", PATCH], {
    cwd: WS,
    env: { ...process.env, DSH_HOME: process.env.DSH_HOME },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  createInterface({ input: child.stderr }).on("line", (l) => stderrLines.push(l));
  return child;
}

/** configOptions 按 id 找 option。 */
function optionById(configOptions, id) {
  return (configOptions ?? []).find((c) => c?.id === id) ?? null;
}
/** select 型 option 的广告值域（平铺 options；group 型把每组 entries 平铺）。 */
function advertisedValues(option) {
  if (!option) return [];
  const flat = [];
  for (const entry of option.options ?? []) {
    if (typeof entry?.value === "string") flat.push(entry.value);
    else if (Array.isArray(entry?.options)) {
      for (const inner of entry.options) {
        if (typeof inner?.value === "string") flat.push(inner.value);
      }
    }
  }
  return flat;
}

const evidence = {
  probe: "acp-config-option",
  purpose: "prove/disprove that ACP session configOptions (reasoning_effort, model) are SETTABLE via session/set_config_option — not merely exposed by session/new",
  dsh: DSH,
  containmentPatch: PATCH,
  workspace: WS,
  promptSent: false,
  sessionId: null,
  steps: {},
};

const child = spawnServer();
const peer = new Peer(child);

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  evidence.sessionUpdateNotifications = updates.map((u) => ({
    method: u.method,
    sessionUpdate: u.params?.update?.sessionUpdate ?? null,
    configOptionIds: (u.params?.update?.configOptions ?? []).map((c) => c?.id ?? null),
  }));
  evidence.stderrTail = stderrLines.slice(-25);
  const json = JSON.stringify(evidence, null, 2);
  if (OUT) writeFileSync(OUT, json + "\n", "utf8");
  console.log(json);
  try { child.stdin.end(); child.kill(); } catch {}
  setTimeout(() => process.exit(0), 300);
}

const guard = setTimeout(() => {
  evidence.fatal = "overall timeout";
  try { child.kill(); } catch {}
  finish();
}, TIMEOUT_MS * 4);

try {
  const init = await peer.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "wao-config-option-probe", version: "0.0.1" },
  });
  evidence.steps.initialize = { protocolVersion: init?.protocolVersion, agentInfo: init?.agentInfo ?? null };

  const created = await peer.request("session/new", { cwd: WS, mcpServers: [] });
  sessionId = created?.sessionId;
  evidence.sessionId = sessionId;
  // 原样保留 session/new 返回的 configOptions（这是"暴露面"证据）。
  evidence.steps.sessionNew = { configOptions: created?.configOptions ?? null };

  const effort = optionById(created?.configOptions, "reasoning_effort");
  const model = optionById(created?.configOptions, "model");
  const effortAdvertised = advertisedValues(effort);
  evidence.snapshot = {
    reasoning_effort: { currentValue: effort?.currentValue ?? null, advertised: effortAdvertised },
    model: { currentValue: model?.currentValue ?? null, advertised: advertisedValues(model) },
  };

  // 4) set reasoning_effort → 另一个广告值
  // PROBE_EFFORT 可指定首个目标值（须在广告值域内；缺省取第一个 != 当前值）。
  let firstTarget = effortAdvertised.find((v) => v !== effort?.currentValue) ?? null;
  if (process.env.PROBE_EFFORT) {
    firstTarget = effortAdvertised.includes(process.env.PROBE_EFFORT)
      ? process.env.PROBE_EFFORT
      : null;
    evidence.probeEffortOverride = effortAdvertised.includes(process.env.PROBE_EFFORT)
      ? process.env.PROBE_EFFORT
      : "(requested value not advertised — skipped)";
  }
  if (firstTarget === null) {
    evidence.steps.setEffort = { skipped: "no advertised value differs from current" };
  } else {
    evidence.steps.setEffort = {
      request: { method: "session/set_config_option", params: { sessionId, configId: "reasoning_effort", value: firstTarget } },
      response: await peer.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value: firstTarget }),
    };
  }

  // 5) 负对照：域外值（WAO 闭集成员 medium，ACP 不广告）
  try {
    evidence.steps.setEffortNegativeControl = {
      request: { method: "session/set_config_option", params: { sessionId, configId: "reasoning_effort", value: NEGATIVE_CONTROL_VALUE } },
      response: await peer.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value: NEGATIVE_CONTROL_VALUE }),
    };
  } catch (e) {
    evidence.steps.setEffortNegativeControl = {
      request: { method: "session/set_config_option", params: { sessionId, configId: "reasoning_effort", value: NEGATIVE_CONTROL_VALUE } },
      rejected: { code: e.wire?.code ?? null, message: e.wire?.message ?? String(e.message) },
    };
  }

  // 6) 二次 set（第三个广告值）：状态延续 + 再一次读取
  const afterFirst = optionById(evidence.steps.setEffort?.response?.configOptions, "reasoning_effort");
  const secondTarget = effortAdvertised.filter((v) => v !== firstTarget && v !== afterFirst?.currentValue).pop()
    ?? effortAdvertised.find((v) => v !== afterFirst?.currentValue) ?? null;
  if (secondTarget === null) {
    evidence.steps.setEffortAgain = { skipped: "no third advertised value available" };
  } else {
    evidence.steps.setEffortAgain = {
      request: { method: "session/set_config_option", params: { sessionId, configId: "reasoning_effort", value: secondTarget } },
      response: await peer.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value: secondTarget }),
    };
  }

  // 7) model 一次 set 尝试（只取证，不接线）：选广告里不同于当前值的一个
  const modelAdvertised = advertisedValues(model);
  const modelTarget = modelAdvertised.find((v) => v !== model?.currentValue) ?? null;
  if (modelTarget === null) {
    evidence.steps.setModel = { skipped: "no advertised model value differs from current" };
  } else {
    try {
      evidence.steps.setModel = {
        request: { method: "session/set_config_option", params: { sessionId, configId: "model", value: modelTarget } },
        response: await peer.request("session/set_config_option", { sessionId, configId: "model", value: modelTarget }),
      };
    } catch (e) {
      evidence.steps.setModel = {
        request: { method: "session/set_config_option", params: { sessionId, configId: "model", value: modelTarget } },
        rejected: { code: e.wire?.code ?? null, message: e.wire?.message ?? String(e.message) },
      };
    }
  }

  // 8) 关会话（不发 prompt）
  await peer.request("session/close", { sessionId });
  evidence.steps.closed = true;
} catch (e) {
  evidence.error = String(e.message);
  if (e.wire) evidence.errorWire = e.wire;
} finally {
  finish();
}
