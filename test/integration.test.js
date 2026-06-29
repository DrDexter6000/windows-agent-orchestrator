import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeServeBackend } from "../src/backends/opencodeServe.js";
import { JsonlTranscript, readTranscript } from "../src/transcript.js";

function createMockFetch() {
  const sessions = new Map();
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      const id = `ses_mock_${Date.now()}`;
      sessions.set(id, { messages: [] });
      return {
        ok: true, status: 200,
        async json() { return { data: { id } }; },
        async text() { return JSON.stringify({ data: { id } }); },
      };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const body = JSON.parse(init.body);
      const session = sessions.get(sessionId);
      if (session) {
        session.messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
        session.messages.push({ info: { id: "msg_reply", role: "assistant" }, parts: [{ type: "text", text: "Mock response" }] });
      }
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      return {
        ok: true, status: 200,
        async json() { return session?.messages ?? []; },
        async text() { return JSON.stringify(session?.messages ?? []); },
      };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return "not found"; } };
  };
}

test("full spawn→collect→stop flow with mock backend", async () => {
  const fetchImpl = createMockFetch();
  const backend = new OpenCodeServeBackend({ fetchImpl, timeout: 5000, retries: 0 });
  const runDir = await mkdtemp(join(tmpdir(), "wao-integ-"));
  try {
    const agent = {
      id: "test_agent",
      backend: "opencode-serve",
      serveUrl: "http://127.0.0.1:4299",
      agent: "build",
      cwd: "D:/test",
      model: { providerID: "test-provider", id: "test-model" },
    };

    const runId = "run_integ_test";
    const transcript = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: agent.id });

    await transcript.append("run.started", { backend: agent.backend, cwd: agent.cwd });
    const result = await backend.spawn(agent, { prompt: "Hello mock" });
    await transcript.append("session.created", { backendSessionId: result.backendSessionId });
    await transcript.append("prompt.sent", { messageId: result.messageId, prompt: "Hello mock" });

    const messages = await backend.messages(agent.serveUrl, result.backendSessionId, { cwd: agent.cwd });
    await transcript.append("messages.collected", { count: messages.data.length });

    assert.equal(messages.data.length, 2);
    assert.equal(messages.data[1].info.role, "assistant");
    assert.equal(messages.data[1].parts[0].text, "Mock response");

    await backend.abort(agent.serveUrl, result.backendSessionId);
    await transcript.append("run.stop_requested", { backendSessionId: result.backendSessionId });

    const events = await readTranscript(transcript.filePath);
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ["run.started", "session.created", "prompt.sent", "messages.collected", "run.stop_requested"]);
    assert.equal(events[2].prompt, "Hello mock");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("process backend 完整生命周期：spawn → events → done(completed) 经 RunManager", async () => {
  const { RunManager } = await import("../src/runManager.js");
  const { ClaudeCodeBackend } = await import("../src/backends/claudeCode.js");
  const runDir = await mkdtemp(join(tmpdir(), "wao-integ-proc-"));
  try {
    // mock 子进程：输出 claude 风格 JSONL 后退出
    const claudeLines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Mock claude reply"}]}}',
      '{"type":"result","subtype":"success","is_error":false}',
    ];
    const payload = Buffer.from(claudeLines.join("\n")).toString("base64");
    const script = `process.stdout.write(Buffer.from("${payload}","base64").toString("utf8")+"\\n");`;

    // 用 node 作为 mock binary，buildArgs 注入脚本
    const backend = new ClaudeCodeBackend({
      buildArgs: () => ["-e", script],
    });
    // 覆盖 defaultBinary 用 node 而非 claude
    backend.defaultBinary = () => process.execPath;

    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        return {
          id,
          backend: "claude-code",
          cwd: runDir,
          ...overrides,
        };
      },
      listAgents() { return []; },
    });
    const config = { registry: "x", runDir, pollInterval: 10, waitTimeout: 5000, timeout: 5000, retries: 0 };
    const manager = new RunManager({
      config,
      readRegistry,
      backendFor: () => backend,
    });

    const run = await manager.start("claude_worker", { prompt: "hi" });
    const waitResult = await run.waitForCompletion({ waitTimeout: 5000 });

    assert.equal(waitResult.completed, true);
    assert.equal(run.state, "completed");
    // 验证 transcript 有完整状态链
    const events = await readTranscript(run.transcript.filePath);
    const stateChanges = events.filter((e) => e.type === "run.state_change");
    const transitions = stateChanges.map((e) => `${e.from}→${e.to}`);
    assert.deepEqual(transitions, [
      "null→pending",
      "pending→submitted",
      "submitted→running",
      "running→completed",
    ]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
