// test/backends/deepSeekAcp.test.js
//
// ADR-0031（B-2）：deepseek-acp backend 确定性单测。
//
// 照 deepSeekHarness.test.js 的注入式 fake spawn/transport 纪律：零真实 dsh、
// 零模型调用、零网络。child 是 PassThrough 流拼的 fake（stdin 可读出 backend 发出的
// JSON-RPC 帧、stdout 由测试喂帧），wire 事实形状取自
// scripts/reliability/dsh-acp/evidence/*.json（F2–F8）。
//
// 覆盖：§3.4 投影表各行、终态映射、权限应答三分支、tripwire 命中、未绑定
// sessionId、未知 update 类型、断链、usage 去重、containment 拒绝、
// sessionReuse resume fail-closed、argv 组装与临时 patch 清理、孤儿清扫。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import {
  DENIED_ORCHESTRATION_TOOLS,
  DeepSeekAcpBackend,
  DeepSeekAcpEventQueue,
  EXPECTED_CONTAINMENT_OVERLAY,
  parseContainmentOverlay,
  serializeRoleContractPatch,
} from "../../src/backends/deepSeekAcp.js";
import { compileInvocation } from "../../src/backends/processBackend.js";
import { backendCapabilitySnapshot, backendFor } from "../../src/backends/factory.js";
import { normalizeAgent } from "../../src/registry.js";
import { inheritedEnvNames, requiredCredentialNames } from "../../src/envPolicy.js";

const REFERENCE_CONTAINMENT = readFileSync(
  new URL("../../scripts/reliability/dsh-acp/wao-contain-safe.patch.yml", import.meta.url),
  "utf8",
);

function agent(overrides = {}) {
  return {
    id: "coder_low_dsh",
    backend: "deepseek-acp",
    cwd: process.cwd(),
    // 绝对路径跳过 where.exe 探测；spawn 本身被 stub。
    binary: "D:/wao-test/dsh-acp-stub.exe",
    credentialEnv: "DEEPSEEK_API_KEY",
    ...overrides,
  };
}

/** fake 子进程：PassThrough 三流 + spawn 即成功 + kill/end 即 close。 */
function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 424242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const originalOnce = child.once.bind(child);
  child.once = (event, listener) => {
    originalOnce(event, listener);
    if (event === "spawn") queueMicrotask(() => listener());
    return child;
  };
  child.end = (code = 0) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.emit("close", code, null);
  };
  child.kill = () => {
    child.end(1);
    return true;
  };
  return child;
}

/** fake ACP 对端：自动应答握手（initialize/session/new/close/cancel），记录全部帧。 */
function fakeAcpPeer(child, { sessionId = "sess-acp-1", agentName = "deepseek-harness-acp" } = {}) {
  const clientRequests = [];
  const serverRequestResponses = [];
  const send = (obj) => child.stdout.write(JSON.stringify(obj) + "\n");
  const lines = readline.createInterface({ input: child.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.method) {
      clientRequests.push(message);
      if (message.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              agentInfo: { name: agentName, version: "0.0.1" },
              sessionCapabilities: { close: {}, list: {}, resume: {} },
            },
          },
        });
      } else if (message.method === "session/new") {
        send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
      } else if (message.method === "session/close") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
        child.end(0);
      } else if (message.method === "session/cancel") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
      }
      return;
    }
    serverRequestResponses.push(message);
  });
  return {
    clientRequests,
    serverRequestResponses,
    sessionId,
    respond(id, result) { send({ jsonrpc: "2.0", id, result }); },
    notify(update, sid = sessionId) {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update } });
    },
    serverRequest(id, method, params) {
      send({ jsonrpc: "2.0", id, method, params });
    },
    closeTransport(code = 0) { child.stdout.end(); child.end(code); },
  };
}

async function collect(handle) {
  const events = [];
  for await (const event of handle.events(new AbortController().signal)) events.push(event);
  return events;
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(10);
  }
  return Boolean(predicate());
}

/**
 * 跑一个完整场景：建 containment 夹具 → 注入 fake spawn → 握手 → drive 驱动
 * wire 帧 → 收全事件。drive 结束后若 transport 仍开着且 prompt 已应答，
 * 终态路径会自行 session/close → child.end → 队列关闭。
 */
async function runAcpScenario({ drive, task, agentOverrides = {}, containmentText = REFERENCE_CONTAINMENT, peerOptions = {}, platform }) {
  const dir = mkdtempSync(join(tmpdir(), "wao-acp-test-"));
  const containmentPath = join(dir, "wao-contain.patch.yml");
  writeFileSync(containmentPath, containmentText, "utf8");
  const child = makeFakeChild();
  const spawnCalls = [];
  const backend = new DeepSeekAcpBackend({
    containmentPatchPath: containmentPath,
    platform,
    spawnFn: (binary, args, opts) => {
      spawnCalls.push({ binary, args, opts });
      return child;
    },
  });
  const peer = fakeAcpPeer(child, peerOptions);
  const handle = await backend.spawn(agent(agentOverrides), task ?? { prompt: "do the task" });
  const promptRequest = () => peer.clientRequests.find((m) => m.method === "session/prompt");
  await drive?.({ peer, child, handle, promptRequest, spawnCalls, containmentPath, dir });
  const events = await collect(handle);
  rmSync(dir, { recursive: true, force: true });
  return { events, peer, child, handle, spawnCalls, backend, containmentPath };
}

// ===== policy / containment / 资产钉 =====

test("ACP policy: effort 硬拒（无可验证下发通道，绝不静默无效）；provider/model 被拒", () => {
  const backend = new DeepSeekAcpBackend();
  // 审计阻塞项 5（Lead 裁定选项 a）：校验通过但静默不下发 = 配置假绿。
  // ACP wire 无 effort 下发通道（argv/env/session 请求均不携带；evidence 无
  // set_config_option 类方法）→ 任何非空 effort 一律硬拒，含 ACP 原生四档。
  for (const effort of ["off", "low", "high", "max", "minimal", "medium", "xhigh"]) {
    assert.throws(
      () => backend.validateAgentPolicy(agent({ reasoning: { effort } })),
      /cannot express reasoning\.effort/,
      effort,
    );
  }
  // 空值（null/undefined）视同未配置——不拒。
  assert.doesNotThrow(() => backend.validateAgentPolicy(agent({ reasoning: { effort: null } })));
  assert.throws(
    () => backend.validateAgentPolicy(agent({
      provider: { protocol: "anthropic-compatible", baseUrl: "https://example.invalid", apiKeyEnv: "OTHER_KEY" },
    })),
    /cannot express provider/,
  );
  // model 块（id/contextWindow）无可验证设置通道 → fail-closed 拒绝，不静默忽略
  assert.throws(
    () => backend.validateAgentPolicy(agent({ model: { id: "deepseek-v4-flash" } })),
    /cannot express a model block/,
  );
  assert.throws(
    () => backend.validateAgentPolicy(agent({ model: { id: "deepseek-v4-flash", contextWindow: 1000000 } })),
    /cannot express a model block/,
  );
  assert.doesNotThrow(() => backend.validateAgentPolicy(agent()));
});

test("ACP containment: 声明集与仓库内参考覆盖层逐 id 一致（防单边漂移）", () => {
  const parsed = parseContainmentOverlay(REFERENCE_CONTAINMENT);
  assert.ok(parsed, "参考覆盖层必须可被受控解析器解析");
  assert.deepEqual(
    [...parsed.keys()].sort(),
    [...EXPECTED_CONTAINMENT_OVERLAY.keys()].sort(),
  );
  for (const [id, disabled] of parsed) assert.equal(disabled, true, id);
});

test("ACP containment: 缺失或与声明不匹配 → 拒绝派发（fail-closed）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-acp-test-"));
  try {
    const missing = join(dir, "missing.yml");
    const backend = new DeepSeekAcpBackend({ containmentPatchPath: missing });
    await assert.rejects(
      backend.spawn(agent(), { prompt: "x" }),
      /containment overlay is not readable/,
    );
    const mismatchPath = join(dir, "mismatch.yml");
    writeFileSync(mismatchPath, REFERENCE_CONTAINMENT.replace("- id: tool-web\n  disabled: true\n", ""), "utf8");
    const mismatchBackend = new DeepSeekAcpBackend({ containmentPatchPath: mismatchPath });
    await assert.rejects(
      mismatchBackend.spawn(agent(), { prompt: "x" }),
      /does not match the declared overlay/,
    );
    const garbagePath = join(dir, "garbage.yml");
    writeFileSync(garbagePath, "not: [a, valid, overlay]\n", "utf8");
    const garbageBackend = new DeepSeekAcpBackend({ containmentPatchPath: garbagePath });
    await assert.rejects(
      garbageBackend.spawn(agent(), { prompt: "x" }),
      /does not match the declared overlay/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP registry/env 集成：闭集成员、credentialEnv 必填、凭据继承、工厂构造", () => {
  const normalized = normalizeAgent("coder_low_dsh", agent());
  assert.equal(normalized.backend, "deepseek-acp");
  assert.deepEqual(requiredCredentialNames(normalized), ["DEEPSEEK_API_KEY"]);
  assert.ok(inheritedEnvNames(normalized).includes("DEEPSEEK_API_KEY"));
  const built = backendFor(normalized);
  assert.ok(built instanceof DeepSeekAcpBackend);
  // Lead 2026-09-20 临时裁定（Owner 未决）：supportsSessionReuse=false——关联面
  // （持久化/原子/互斥/身份绑定）未落地前声明 true 属"声明强于实现"。
  assert.deepEqual(backendCapabilitySnapshot(normalized), {
    reportsTokenUsage: true,
    supportsSessionReuse: false,
  });
  assert.equal(built.supportsInFlightCorrection, false, "在途纠偏如实声明不支持");
  assert.equal(built.supportsRoleContract, true);

  assert.throws(
    () => normalizeAgent("bad", agent({ credentialEnv: undefined })),
    /credentialEnv/,
  );
  // registry 层六值 effort 闭集：off 在 registry 不可表达（既有边界）。
  assert.throws(
    () => normalizeAgent("bad", agent({ reasoning: { effort: "off" } })),
    /reasoning\.effort/,
  );
  // registry 可表达的档位也会被 backend validateAgentPolicy 硬拒（阻塞项 5）。
  assert.throws(
    () => built.validateAgentPolicy(agent({ reasoning: { effort: "high" } })),
    /cannot express reasoning\.effort/,
  );
});

// ===== §3.4 投影表 =====

test("ACP 投影表：message/thinking/write_intent/file_written/tool_result/command 各行", async () => {
  const { events } = await runAcpScenario({
    drive: ({ peer, promptRequest }) => {
      peer.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } });
      peer.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } });
      peer.notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pondering" } });
      peer.notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "task echo" } });
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_w1", title: "write", kind: "other", status: "in_progress", rawInput: { file_path: "proof.txt", content: "WAO_DSH_ACP_OK" } });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_w1", status: "in_progress" });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_w1", status: "completed", content: [{ type: "text", text: "written" }] });
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_r1", title: "read", kind: "other", rawInput: { file_path: "proof.txt" } });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_r1", status: "completed" });
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_w2", title: "write", kind: "other", rawInput: { file_path: "bad.txt" } });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_w2", status: "failed", content: [{ type: "text", text: "denied" }] });
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_s1", title: "pwsh", kind: "other", rawInput: { command: "Get-Content -LiteralPath ./proof.txt -Raw", description: "read proof" } });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_s1", status: "completed", content: [{ type: "text", text: "WAO_DSH_ACP_OK\nexit code: 0" }] });
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_s2", title: "pwsh", kind: "other", rawInput: { command: "Write-Output hi" } });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_s2", status: "completed", content: [{ type: "text", text: "hi" }] });
      peer.notify({ sessionUpdate: "usage_update", used: 4210, size: 1000000 });
      peer.notify({ sessionUpdate: "usage_update", used: 4608, size: 1000000 });
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: { input_tokens: 12, output_tokens: 5 } });
    },
  });

  assert.ok(events.some((e) => e.kind === "runtime_activity" && e.status === "initialized"));
  const messages = events.filter((e) => e.kind === "message" && e.role === "assistant");
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].parts, [{ type: "text", text: "hello " }]);
  assert.ok(events.some((e) => e.kind === "thinking"));
  // user_message_chunk 回显不投影
  assert.ok(!events.some((e) => JSON.stringify(e).includes("task echo")));
  // write：tool_use + write_intent（tracked）；关联成功 → tool_result + file_written
  assert.ok(events.some((e) => e.kind === "tool_use" && e.tool === "write" && e.input?.file_path === "proof.txt"));
  assert.ok(events.some((e) => e.kind === "write_intent" && e.path === "proof.txt" && e.toolCallId === "call_w1" && e.correlationStatus === "tracked"));
  assert.ok(events.some((e) => e.kind === "tool_result" && e.tool === "write" && e.isError === false));
  assert.ok(events.some((e) => e.kind === "file_written" && e.path === "proof.txt" && e.toolCallId === "call_w1"));
  // failed write：tool_result isError，绝不发 file_written
  assert.ok(events.some((e) => e.kind === "tool_result" && e.tool === "write" && e.isError === true));
  assert.ok(!events.some((e) => e.kind === "file_written" && e.path === "bad.txt"));
  // shell：command 事件带 toolCallId；退出码可提取才带上，否则不伪造
  assert.ok(events.some((e) => e.kind === "command" && e.command === "Get-Content -LiteralPath ./proof.txt -Raw" && e.toolCallId === "call_s1" && e.exitCode === 0));
  const noCode = events.find((e) => e.kind === "command" && e.command === "Write-Output hi");
  assert.ok(noCode, "shell 命令证据必须在场");
  assert.equal(noCode.exitCode, undefined, "无法提取退出码时不伪造");
  // usage 去重：usage_update（上下文占用）绝不进 metrics；终局 usage 唯一来源
  const metrics = events.filter((e) => e.kind === "metrics");
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].tokens.input, 12);
  assert.equal(metrics[0].tokens.output, 5);
  assert.ok(!JSON.stringify(metrics).includes("4210"));
  assert.ok(!JSON.stringify(metrics).includes("4608"));
  assert.deepEqual(events.at(-1), { kind: "done", reason: "completed" });
});

test("ACP 投影边界：pending/in_progress 绝不算成功；重复终态取首个并留痕", async () => {
  const { events, handle } = await runAcpScenario({
    drive: ({ peer, promptRequest }) => {
      // 只有 in_progress，从未到终态：write_intent 在场，绝不 file_written/tool_result
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_p1", title: "write", rawInput: { file_path: "pending.txt" } });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_p1", status: "in_progress" });
      // 重复/乱序终态：首个 completed 胜出，后续 failed 忽略并留痕
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_d1", title: "write", rawInput: { file_path: "dup.txt" } });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_d1", status: "completed", content: [{ type: "text", text: "ok" }] });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_d1", status: "failed", content: [{ type: "text", text: "late failure" }] });
      // 未知关联的终态：以 toolCallId 为 tool 名投影 + 留痕
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_orphan", status: "completed" });
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });

  assert.ok(events.some((e) => e.kind === "write_intent" && e.path === "pending.txt"));
  assert.ok(!events.some((e) => e.kind === "file_written" && e.path === "pending.txt"));
  // call_p1 从未到终态：没有它的 tool_result（唯一的 write tool_result 来自 call_d1）
  const writeResults = events.filter((e) => e.kind === "tool_result" && e.tool === "write");
  assert.equal(writeResults.length, 1);
  assert.equal(writeResults[0].isError, false);
  // 全部 tool_result 恰两条：call_d1（write，首个终态 completed）与 call_orphan
  const allResults = events.filter((e) => e.kind === "tool_result");
  assert.equal(allResults.length, 2, "call_d1 与 call_orphan 各一条");
  assert.ok(events.some((e) => e.kind === "file_written" && e.path === "dup.txt" && e.toolCallId === "call_d1"));
  assert.ok(events.some((e) => e.kind === "tool_result" && e.tool === "call_orphan" && e.isError === false));
  const anomalyNotes = handle.anomalies.map((a) => a.note).join("\n");
  assert.match(anomalyNotes, /duplicate terminal tool_call_update ignored \(toolCallId=call_d1, status=failed\)/);
  assert.match(anomalyNotes, /without a prior tool_call \(toolCallId=call_orphan\)/);
  // usage 为 null：无 metrics 事件（evidence phase4 里 PromptResponse.usage 实测可为 null）
  assert.equal(events.filter((e) => e.kind === "metrics").length, 0);
  assert.equal(events.at(-1).reason, "completed");
});

test("ACP 缺失/空 toolCallId：不发 write_intent、completed 绝不发 file_written（不可靠关联态）+ 留痕", async () => {
  const { events, handle } = await runAcpScenario({
    drive: ({ peer, promptRequest }) => {
      // 旧缺陷形态：缺失/空 id 曾降级为字面量 "unknown" 并以 TRACKED 记录——
      // 任意缺 id 的 completed 都能凭空领走 file_written（可伪造面，阻塞项 2）。
      peer.notify({ sessionUpdate: "tool_call", title: "write", kind: "other", status: "in_progress", rawInput: { file_path: "forged.txt", content: "x" } });
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "", title: "write", kind: "other", rawInput: { file_path: "empty-id.txt" } });
      peer.notify({ sessionUpdate: "tool_call_update", status: "completed", content: [{ type: "text", text: "written" }] });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "", status: "completed" });
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  // 阻塞项 2 钉：缺失/空 id 的 completed 绝不产出 file_written / write_intent
  assert.ok(!events.some((e) => e.kind === "file_written"), "缺失/空 toolCallId 绝不发 file_written");
  assert.ok(!events.some((e) => e.kind === "write_intent"), "缺失/空 toolCallId 绝不发 write_intent");
  assert.ok(!events.some((e) => e.toolCallId === "unknown"), "绝不再出现字面量 unknown 关联键");
  // 证据降级而非丢失：tool_use（无关联面）仍在；终态 update 无 id 不投影 tool_result
  assert.equal(events.filter((e) => e.kind === "tool_use" && e.tool === "write").length, 2);
  assert.equal(events.filter((e) => e.kind === "tool_result").length, 0);
  const notes = handle.anomalies.map((a) => a.note).join("\n");
  assert.match(notes, /tool_call without toolCallId; write correlation unreliable/);
  assert.match(notes, /terminal tool_call_update without toolCallId ignored/);
  assert.equal(events.at(-1).reason, "completed");
});

test("ACP 重复 toolCallId 的 tool_call：拒绝覆盖待确认路径（首个关联保持，绝不让后到路径领走 file_written）+ 留痕", async () => {
  const { events, handle } = await runAcpScenario({
    drive: ({ peer, promptRequest }) => {
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_dup", title: "write", kind: "other", rawInput: { file_path: "first.txt" } });
      // 同 id 第二个 tool_call 携带不同路径：不得静默覆盖 first.txt 的待确认路径
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_dup", title: "write", kind: "other", rawInput: { file_path: "second.txt" } });
      peer.notify({ sessionUpdate: "tool_call_update", toolCallId: "call_dup", status: "completed", content: [{ type: "text", text: "ok" }] });
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  assert.ok(events.some((e) => e.kind === "write_intent" && e.path === "first.txt" && e.toolCallId === "call_dup" && e.correlationStatus === "tracked"));
  assert.ok(!events.some((e) => e.kind === "write_intent" && e.path === "second.txt"), "重复 id 不得再立第二条 write_intent");
  // 关联成功的是首个路径——second.txt 绝不 file_written（伪造面闭合）
  assert.ok(events.some((e) => e.kind === "file_written" && e.path === "first.txt" && e.toolCallId === "call_dup"));
  assert.ok(!events.some((e) => e.kind === "file_written" && e.path === "second.txt"));
  const notes = handle.anomalies.map((a) => a.note).join("\n");
  assert.match(notes, /duplicate tool_call toolCallId refused overwrite; first correlation kept \(toolCallId=call_dup/);
  // 重复的 tool_call 仍投影 tool_use（wire 事实不丢）
  assert.equal(events.filter((e) => e.kind === "tool_use" && e.tool === "write").length, 2);
});

test("ACP 未绑定 sessionId 的 session/update 一律丢弃（绝不投影为本 run 事实）", async () => {
  const { events } = await runAcpScenario({
    drive: ({ peer, promptRequest }) => {
      peer.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "foreign" } }, "sess-other");
      peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_f1", title: "write", rawInput: { file_path: "foreign.txt" } }, "sess-other");
      peer.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mine" } });
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  assert.ok(!events.some((e) => JSON.stringify(e).includes("foreign")));
  assert.ok(events.some((e) => e.kind === "message" && e.parts.some((p) => p.text === "mine")));
});

test("ACP 未知 sessionUpdate 类型 / 未知 tool_call_update status → fail-closed", async () => {
  for (const scenario of [
    { update: { sessionUpdate: "plan" }, pattern: /unknown session update type: plan/ },
    { update: { sessionUpdate: "current_mode_update" }, pattern: /unknown session update type/ },
    { update: { sessionUpdate: "tool_call_update", toolCallId: "call_x", status: "expired" }, pattern: /unknown status: expired/ },
  ]) {
    const { events } = await runAcpScenario({
      drive: ({ peer }) => {
        peer.notify(scenario.update);
      },
    });
    const done = events.at(-1);
    assert.equal(done.kind, "done");
    assert.equal(done.reason, "failed", JSON.stringify(scenario));
    assert.match(done.error, scenario.pattern);
  }
});

// ===== §3.4 终态映射 =====

test("ACP 终态映射：end_turn/cancelled/refusal/max_tokens/max_turn_requests/未知", async () => {
  const cases = [
    { stopReason: "cancelled", pattern: /cancelled/ },
    { stopReason: "refusal", pattern: /turn failed: refusal/ },
    { stopReason: "max_tokens", pattern: /turn failed: max_tokens/ },
    { stopReason: "max_turn_requests", pattern: /turn failed: max_turn_requests/ },
    { stopReason: "mystery_stop", pattern: /unrecognized stopReason: mystery_stop/ },
    { stopReason: null, pattern: /unrecognized stopReason: missing/ },
  ];
  for (const c of cases) {
    const { events } = await runAcpScenario({
      drive: ({ peer, promptRequest }) => {
        peer.respond(promptRequest().id, c.stopReason === null ? {} : { stopReason: c.stopReason });
      },
    });
    const done = events.at(-1);
    assert.equal(done.kind, "done", c.stopReason);
    assert.equal(done.reason, "failed", c.stopReason ?? "null");
    assert.match(done.error, c.pattern);
  }
});

test("ACP 终态映射：end_turn 无可用效应 → completed_empty 标记；有效应则无标记", async () => {
  const empty = await runAcpScenario({
    drive: ({ peer, promptRequest }) => {
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  assert.deepEqual(empty.events.at(-1), { kind: "done", reason: "completed", marker: "completed_empty" });

  const withEffect = await runAcpScenario({
    drive: ({ peer, promptRequest }) => {
      peer.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "result" } });
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  assert.deepEqual(withEffect.events.at(-1), { kind: "done", reason: "completed" });
});

// ===== §3.5 权限应答三分支 + tripwire + 断链 =====

test("ACP 权限应答三分支：allow 优先 / 仅 reject 或未知 kind → reject（否则 cancelled）/ 空选项 → cancelled", async () => {
  const branches = [
    {
      options: [
        { kind: "allow_once", optionId: "a1" },
        { kind: "reject_always", optionId: "r1" },
      ],
      expected: { outcome: { outcome: "selected", optionId: "a1" } },
    },
    {
      options: [{ kind: "reject_once", optionId: "r1" }],
      expected: { outcome: { outcome: "selected", optionId: "r1" } },
    },
    {
      // 仅未知 kind：无 allow、无 reject 可选 → cancelled（绝不授予）
      options: [{ kind: "mystery_kind", optionId: "m1" }],
      expected: { outcome: { outcome: "cancelled" } },
    },
    {
      options: [],
      expected: { outcome: { outcome: "cancelled" } },
    },
  ];
  for (const branch of branches) {
    const { events, peer } = await runAcpScenario({
      drive: async ({ peer: p, promptRequest }) => {
        p.serverRequest(9001, "session/request_permission", { sessionId: p.sessionId, options: branch.options });
        await waitUntil(() => p.serverRequestResponses.some((m) => m.id === 9001));
        p.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
      },
    });
    const answer = peer.serverRequestResponses.find((m) => m.id === 9001);
    assert.ok(answer, "权限请求必须被应答，不得静默丢弃");
    assert.deepEqual(answer.result, branch.expected);
    // 应答进 transcript 审计：system message（非 usable effect）
    const audit = events.find((e) => e.kind === "message" && e.role === "system");
    assert.ok(audit, "权限应答必须有 system 审计消息");
    assert.match(audit.parts[0].text, /deepseek-acp permission answered/);
    assert.equal(events.at(-1).reason, "completed");
  }
});

test("ACP 权限约束（阻塞项 3）：非本次绑定 sessionId / 终态已排队 → 绝不 allow，cancelled + 留痕", async () => {
  // 分支 1：非本次绑定的 sessionId——哪怕选项全是 allow，也绝不授予。
  const foreign = await runAcpScenario({
    drive: async ({ peer: p, promptRequest }) => {
      p.serverRequest(9101, "session/request_permission", {
        sessionId: "sess-not-mine",
        options: [{ kind: "allow_once", optionId: "a1" }],
      });
      await waitUntil(() => p.serverRequestResponses.some((m) => m.id === 9101));
      p.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  const foreignAnswer = foreign.peer.serverRequestResponses.find((m) => m.id === 9101);
  assert.ok(foreignAnswer, "必须应答（不静默丢弃）");
  assert.deepEqual(foreignAnswer.result, { outcome: { outcome: "cancelled" } }, "非绑定 sessionId 绝不 allow");
  const foreignAudit = foreign.events.find((e) => e.kind === "message" && e.role === "system");
  assert.ok(foreignAudit, "拒绝性应答也进 transcript 审计");
  assert.match(foreignAudit.parts[0].text, /"refused":"session_not_bound"/);
  assert.match(
    foreign.handle.anomalies.map((a) => a.note).join("\n"),
    /session\/request_permission refused \(session_not_bound\); answered cancelled, never allow/,
  );
  assert.equal(foreign.events.at(-1).reason, "completed");

  // 分支 2：终态已排队（tripwire 命中后）——正确 sessionId 也绝不 allow。
  const queued = await runAcpScenario({
    drive: async ({ peer: p }) => {
      p.notify({ sessionUpdate: "tool_call", toolCallId: "call_t9", title: "subagent", kind: "other", rawInput: { prompt: "x" } });
      // session/close 只在 queueTerminal 的 shutdown 路径发出——见到它即终态已排队。
      await waitUntil(() => p.clientRequests.some((m) => m.method === "session/close"));
      p.serverRequest(9102, "session/request_permission", {
        sessionId: p.sessionId,
        options: [{ kind: "allow_always", optionId: "a2" }],
      });
      await waitUntil(() => p.serverRequestResponses.some((m) => m.id === 9102));
    },
  });
  const queuedAnswer = queued.peer.serverRequestResponses.find((m) => m.id === 9102);
  assert.ok(queuedAnswer, "必须应答（不静默丢弃）");
  assert.deepEqual(queuedAnswer.result, { outcome: { outcome: "cancelled" } }, "terminalQueued 后绝不 allow");
  assert.match(
    queued.handle.anomalies.map((a) => a.note).join("\n"),
    /session\/request_permission refused \(terminal_queued\); answered cancelled, never allow/,
  );
  const queuedDone = queued.events.find((e) => e.kind === "done");
  assert.equal(queuedDone.reason, "failed", "tripwire 终态不受权限应答影响");
});

test("ACP 权限：未知服务端请求方法 → -32601 错误应答（不吞掉）", async () => {
  const { peer } = await runAcpScenario({
    drive: async ({ peer: p, promptRequest }) => {
      p.serverRequest(9002, "session/status", {});
      await waitUntil(() => p.serverRequestResponses.some((m) => m.id === 9002));
      p.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  const answer = peer.serverRequestResponses.find((m) => m.id === 9002);
  assert.ok(answer);
  assert.equal(answer.error?.code, -32601);
});

test("ACP tripwire：subagent / subagent_fork / spawn_teammate 工具调用 → 终态 failed", async () => {
  for (const tool of DENIED_ORCHESTRATION_TOOLS) {
    const { events } = await runAcpScenario({
      drive: ({ peer }) => {
        peer.notify({ sessionUpdate: "tool_call", toolCallId: "call_t1", title: tool, kind: "other", rawInput: { prompt: "x" } });
      },
    });
    const done = events.at(-1);
    assert.equal(done.kind, "done");
    assert.equal(done.reason, "failed", tool);
    assert.match(done.error, /denied orchestration tool/);
  }
});

test("ACP 断链：transport 先于终态关闭 → done failed（不投影为 completed）", async () => {
  const { events } = await runAcpScenario({
    drive: async ({ peer, child }) => {
      peer.notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
      await delay(20);
      peer.closeTransport(1);
    },
  });
  const done = events.at(-1);
  assert.equal(done.kind, "done");
  assert.equal(done.reason, "failed");
  assert.match(done.error, /transport closed before completion/);
  assert.ok(events.some((e) => e.kind === "message" && e.parts.some((p) => p.text === "partial")));
});

// ===== §3.3/§3.6 能力面 =====

test("ACP runtime identity 不符 → spawn 拒绝（fail-closed）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-acp-test-"));
  try {
    const containmentPath = join(dir, "wao-contain.patch.yml");
    writeFileSync(containmentPath, REFERENCE_CONTAINMENT, "utf8");
    const child = makeFakeChild();
    const backend = new DeepSeekAcpBackend({
      containmentPatchPath: containmentPath,
      spawnFn: () => child,
    });
    fakeAcpPeer(child, { agentName: "some-other-runtime" });
    await assert.rejects(
      backend.spawn(agent(), { prompt: "x" }),
      /runtime identity mismatch/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ACP sessionReuse：resume 轮 fail-closed 拒绝；first 轮照常新会话", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-acp-test-"));
  try {
    const containmentPath = join(dir, "wao-contain.patch.yml");
    writeFileSync(containmentPath, REFERENCE_CONTAINMENT, "utf8");
    const backend = new DeepSeekAcpBackend({ containmentPatchPath: containmentPath });
    await assert.rejects(
      backend.preflightInvocation(agent(), {
        prompt: "x",
        sessionReuse: { mode: "lead_workspace", turn: "resume", opaqueUuid: "0f1e2d3c-4b5a-6978-8976-a5b4c3d2e1f0" },
      }),
      /cannot resume a provider session/,
    );

    const child = makeFakeChild();
    const spawnBackend = new DeepSeekAcpBackend({
      containmentPatchPath: containmentPath,
      spawnFn: () => child,
    });
    const peer = fakeAcpPeer(child);
    const handle = await spawnBackend.spawn(agent(), {
      prompt: "x",
      sessionReuse: { mode: "lead_workspace", turn: "first", opaqueUuid: "0f1e2d3c-4b5a-6978-8976-a5b4c3d2e1f0" },
    });
    assert.ok(peer.clientRequests.some((m) => m.method === "session/new"));
    assert.equal(handle.backendSessionId, peer.sessionId);
    peer.respond(peer.clientRequests.find((m) => m.method === "session/prompt").id, { stopReason: "end_turn" });
    const events = [];
    for await (const event of handle.events(new AbortController().signal)) events.push(event);
    assert.equal(events.at(-1).reason, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== argv 组装 / 角色合同 patch / 清理责任 =====

test("ACP argv：--profile acp + containment --patch + 角色合同 --patch；合同结构化序列化；用后清理", async () => {
  const roleContract = "bounded role\nline2 with \"quotes\" and \\backslashes";
  let patchDirOnSpawn = null;
  const { events, spawnCalls } = await runAcpScenario({
    task: { prompt: "do", roleContract },
    drive: async ({ peer, promptRequest, spawnCalls: calls }) => {
      const args = calls[0].args;
      assert.ok(args.includes("--profile") && args[args.indexOf("--profile") + 1] === "acp");
      const patchFlags = args.map((a, i) => (a === "--patch" ? i : -1)).filter((i) => i >= 0);
      assert.equal(patchFlags.length, 2, "containment + 角色合同两条 --patch");
      const containmentValue = args[patchFlags[0] + 1];
      const rolePatchValue = args[patchFlags[1] + 1];
      assert.ok(containmentValue.endsWith("wao-contain.patch.yml"), "第一条 --patch 是 containment");
      assert.ok(rolePatchValue.includes("wao-dsh-acp-") && rolePatchValue.endsWith("role.patch.yml"));
      assert.ok(existsSync(rolePatchValue), "角色合同 patch 在 spawn 时已落盘");
      const content = readFileSync(rolePatchValue, "utf8");
      // 形状断言，**不再自证循环**：dsh 的 patch-list 合同要求顶层 YAML 数组
      // （dsh-app-boot parsePatchList："must be a top-level YAML array of loader patch entries"）。
      // 旧断言比较"文件内容 == 同一个序列化函数的输出"，只证明"按自己的格式写了"，
      // 不证明"dsh 接受"——一个被 dsh 拒绝的顶层映射因此一路绿到真实派发才暴露
      // （run_202609201027165640owp8p：phase=spawn transport closed）。
      const firstMeaningful = content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
      assert.ok(
        firstMeaningful.startsWith("- "),
        `顶层必须是 YAML 数组项；实际首行 ${JSON.stringify(firstMeaningful)}`,
      );
      assert.equal(firstMeaningful.trim(), "- id: system-prompt");
      assert.ok(
        /\n {2}config:\n {4}personaPrefix: /.test(content),
        "必须是 id-targeted entry 的 config.personaPrefix 形状",
      );
      assert.ok(!/^system-prompt:/m.test(content), "不得再输出顶层映射（dsh 会拒绝）");
      assert.ok(content.includes(JSON.stringify(roleContract)), "标量经 JSON.stringify 结构化转义");
      patchDirOnSpawn = rolePatchValue;
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  assert.equal(events.at(-1).reason, "completed");
  // 清理责任：终态后 per-dispatch 临时目录必须被移除
  await waitUntil(() => !existsSync(patchDirOnSpawn), 2000);
  assert.ok(!existsSync(patchDirOnSpawn), "角色合同 patch 目录用后清理");

  // 无角色合同：只有 containment 一条 --patch，不建临时目录
  const bare = await runAcpScenario({
    task: { prompt: "do" },
    drive: ({ peer, promptRequest }) => {
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  const bareArgs = bare.spawnCalls[0].args;
  assert.equal(bareArgs.filter((a) => a === "--patch").length, 1);
});

// ===== 角色合同 patch 的 dsh patch-list 形状（真实派发失败根因回归钉）=====
// run_202609201027165640owp8p：phase=spawn transport closed——dsh 拒绝非顶层数组的 patch 文件。
test("serializeRoleContractPatch 输出 dsh patch-list 要求的顶层 YAML 数组", () => {
  const out = serializeRoleContractPatch('role\nline2 with "quotes" and \\backslashes');
  const firstMeaningful = out.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  assert.ok(firstMeaningful.startsWith("- "), "顶层必须是数组项，而非映射");
  assert.equal(firstMeaningful.trim(), "- id: system-prompt");
  assert.ok(/\n {2}config:\n {4}personaPrefix: /.test(out), "id-targeted entry 的 config.personaPrefix 形状");
  assert.ok(!/^system-prompt:/m.test(out), "顶层映射会被 dsh parsePatchList 拒绝");
});

// ===== Windows 启动链（阻塞项 1——上一轮"假绿"根因）=====
//
// 旧缺陷：spawn 喂的是 `compiled.binary`（win32+.cmd 时 = ComSpec）**拼原始
// dsh builtArgs**——实际执行 `cmd.exe --profile acp …`，永远起不来 dsh.cmd。
// 只测假 .exe 探不到该路径（.exe 时 compile 产物恰好透传 builtArgs）。
// 修正形态：附加参数在 compile **之前**进 builtArgs，spawn 用 compileInvocation
// 产物（compiled.args，含 /d /s /c 包裹），与旧线 deepSeekHarness.js 同款。

test("ACP Windows 启动链：win32 + .cmd → spawn 恰为 compileInvocation 产物（ComSpec /d /s /c <cmdLine>，verbatim）", async () => {
  const scenario = await runAcpScenario({
    agentOverrides: { binary: "D:/wao-test/dsh.cmd" },
    platform: "win32",
    drive: ({ peer, promptRequest }) => {
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  const { spawnCalls, containmentPath } = scenario;
  assert.equal(spawnCalls.length, 1);
  // 附加参数在 compile 之前进入 builtArgs；期望值由 compileInvocation 独立重放——
  // spawn 的 (binary, args) 必须与产物逐元素相等（阻塞项 1 的机器钉）。
  const expected = compileInvocation({
    binary: "D:/wao-test/dsh.cmd",
    builtArgs: ["--profile", "acp", "--patch", containmentPath],
    platform: "win32",
  });
  assert.equal(spawnCalls[0].binary, expected.binary);
  assert.deepEqual(spawnCalls[0].args, expected.args);
  assert.equal(spawnCalls[0].opts.windowsVerbatimArguments, expected.windowsVerbatimArguments);
  // 结构钉：ComSpec + /d /s /c + verbatim cmdLine（含全部 dsh argv）
  assert.equal(spawnCalls[0].binary, process.env.ComSpec || "cmd.exe");
  assert.deepEqual(spawnCalls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
  const cmdLine = spawnCalls[0].args[3];
  assert.equal(typeof cmdLine, "string");
  assert.ok(cmdLine.startsWith("call "), "cmdLine 以 call <binary> 开头");
  assert.ok(cmdLine.includes("dsh.cmd"), "cmdLine 包裹的是 dsh.cmd 本体");
  assert.ok(cmdLine.includes("--profile") && cmdLine.includes("acp"));
  assert.ok(cmdLine.includes("--patch") && cmdLine.includes("wao-contain.patch.yml"));
  assert.equal(spawnCalls[0].opts.windowsVerbatimArguments, true);
  // 死链形态回归钉：原始 dsh builtArgs 不得直接成为 spawn 的 args
  assert.ok(!spawnCalls[0].args.includes("--profile"), "不得把 builtArgs 原样喂给 cmd.exe");
  assert.equal(spawnCalls[0].args.length, 4, "spawn args 恰为 [/d,/s,/c,cmdLine]");
  assert.equal(scenario.events.at(-1).reason, "completed");
});

test("ACP Windows 启动链（带角色合同）：真实 role patch 路径在 compile 之前进 builtArgs，产物逐元素相等", async () => {
  const scenario = await runAcpScenario({
    agentOverrides: { binary: "D:/wao-test/dsh.cmd" },
    platform: "win32",
    task: { prompt: "do", roleContract: "bounded role" },
    drive: ({ peer, promptRequest, spawnCalls: calls, containmentPath }) => {
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
      // 从 verbatim cmdLine 里取回真实 role patch 路径（quoteCmdArg 恒包裹双引号，
      // mkdtemp 路径不含引号），再用 compileInvocation 独立重放整条产物比对。
      const rolePatch = calls[0].args[3].match(/"([^"]*role\.patch\.yml)"/)?.[1];
      assert.ok(rolePatch, "cmdLine 必须包含角色合同 patch 路径");
      assert.ok(existsSync(rolePatch), "角色合同 patch 在 spawn 时已落盘");
      const expected = compileInvocation({
        binary: "D:/wao-test/dsh.cmd",
        builtArgs: ["--profile", "acp", "--patch", containmentPath, "--patch", rolePatch],
        platform: "win32",
      });
      assert.equal(calls[0].binary, expected.binary);
      assert.deepEqual(calls[0].args, expected.args);
      assert.equal(calls[0].opts.windowsVerbatimArguments, expected.windowsVerbatimArguments);
      assert.equal((calls[0].args[3].match(/--patch/g) ?? []).length, 2, "containment + 角色合同两条 --patch 都进了 cmdLine");
      peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
    },
  });
  assert.equal(scenario.events.at(-1).reason, "completed");
});

test("ACP 孤儿清扫：陈旧的 wao-dsh-acp-* 目录被清；新鲜目录保留", async () => {
  const staleDir = join(tmpdir(), "wao-dsh-acp-stalefixture");
  const freshDir = join(tmpdir(), "wao-dsh-acp-freshfixture");
  rmSync(staleDir, { recursive: true, force: true });
  rmSync(freshDir, { recursive: true, force: true });
  mkdirSync(staleDir);
  mkdirSync(freshDir);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(staleDir, twoHoursAgo, twoHoursAgo);
  try {
    await runAcpScenario({
      drive: ({ peer, promptRequest }) => {
        peer.respond(promptRequest().id, { stopReason: "end_turn", usage: null });
      },
    });
    await waitUntil(() => !existsSync(staleDir), 2000);
    assert.ok(!existsSync(staleDir), "陈旧孤儿目录被 best-effort 清扫");
    assert.ok(existsSync(freshDir), "新鲜目录（可能是并发派发）绝不被清扫");
  } finally {
    rmSync(freshDir, { recursive: true, force: true });
    rmSync(staleDir, { recursive: true, force: true });
  }
});

test("ACP EventQueue：迭代器暂停期间到达的终态事实不被跳过", async () => {
  const backend = new DeepSeekAcpBackend();
  const queue = new DeepSeekAcpEventQueue();
  const iterator = backend._events(queue, { exitCode: null, signalCode: null });
  queue.push({ kind: "runtime_activity", status: "streaming" });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "runtime_activity", status: "streaming" },
  });
  queue.push({ kind: "done", reason: "failed", error: "transport closed" });
  queue.close();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { kind: "done", reason: "failed", error: "transport closed" },
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("ACP abort：先 session/cancel（真取消）再 session/close，流以 failed done 收口", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-acp-test-"));
  try {
    const containmentPath = join(dir, "wao-contain.patch.yml");
    writeFileSync(containmentPath, REFERENCE_CONTAINMENT, "utf8");
    const child = makeFakeChild();
    const backend = new DeepSeekAcpBackend({
      containmentPatchPath: containmentPath,
      spawnFn: () => child,
    });
    const peer = fakeAcpPeer(child);
    const handle = await backend.spawn(agent(), { prompt: "long task", roleContract: "bounded role" });
    await handle.abort();
    assert.ok(peer.clientRequests.some((m) => m.method === "session/cancel"), "abort 必须发 session/cancel");
    assert.ok(peer.clientRequests.some((m) => m.method === "session/close"), "abort 收口必须发 session/close");
    const events = [];
    for await (const event of handle.events(new AbortController().signal)) events.push(event);
    assert.equal(events.at(-1).kind, "done");
    assert.equal(events.at(-1).reason, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
