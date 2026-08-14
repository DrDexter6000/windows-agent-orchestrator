import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { stopRun } from "../../src/application/runStop.js";
import { OpenCodeServeBackend } from "../../src/backends/opencodeServe.js";
import {
  executeStopWithVerification,
  verifyStopQuiet,
} from "../../src/backends/opencodeStopVerify.js";
import { JsonlTranscript } from "../../src/transcript.js";
import { readRegistry } from "../../src/registry.js";
import { RunManager } from "../../src/runManager.js";

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

function noContentResponse() {
  return {
    ok: true,
    status: 204,
    async json() {
      throw new SyntaxError("Unexpected end of JSON input");
    },
    async text() {
      return "";
    },
  };
}

const agent = {
  id: "opencode_worker",
  serveUrl: "http://127.0.0.1:4297",
  agent: "build",
  cwd: "D:/projects/worktree",
  model: { providerID: "test-provider", id: "test-model" },
};

test("OpenCode requalification: native system channel receives the role contract exactly once", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/session")) {
      return jsonResponse({ data: { id: "ses_role" } });
    }
    if (String(url).includes("/prompt_async")) return noContentResponse();
    throw new Error(`unexpected URL ${url}`);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl });

  await backend.spawn(agent, {
    prompt: "TASK_MARKER",
    roleContract: "ROLE_MARKER",
  });

  assert.equal(backend.supportsRoleContract, true);
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.system, "ROLE_MARKER");
  assert.equal(body.parts[0].text, "TASK_MARKER");
  assert.equal(JSON.stringify(body).match(/ROLE_MARKER/g)?.length, 1);
  assert.equal(JSON.stringify(body).match(/TASK_MARKER/g)?.length, 1);
});

test("OpenCode requalification: an idle async session without assistant output fails promptly", async () => {
  let statusPolls = 0;
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("/session/status")) {
      statusPolls += 1;
      return jsonResponse({ ses_idle: { type: statusPolls === 1 ? "busy" : "idle" } });
    }
    if (value.includes("/message")) return jsonResponse([]);
    throw new Error(`unexpected URL ${url}`);
  };
  const backend = new OpenCodeServeBackend({ fetchImpl });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  const events = [];
  for await (const event of backend.streamEvents(agent.serveUrl, "ses_idle", {
    cwd: agent.cwd,
    signal: controller.signal,
    interval: 1,
    silentTimeout: 10_000,
  })) {
    events.push(event);
  }
  clearTimeout(timer);

  const done = events.find((event) => event.kind === "done");
  assert.equal(done?.reason, "failed");
  assert.match(done?.error ?? "", /session ended without assistant output/);
});

test("OpenCode requalification: delayed admission is not rejected by a fixed idle grace", async () => {
  let messagePolls = 0;
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("/session/status")) return jsonResponse({});
    if (value.includes("/message")) {
      messagePolls += 1;
      return jsonResponse(messagePolls < 4 ? [] : [{
        info: { id: "msg_delayed", role: "assistant", finish: "stop", tokens: { input: 4, output: 2 } },
        parts: [{ type: "text", text: "ADMITTED" }],
      }]);
    }
    if (value.endsWith("/abort") && init.method === "POST") return jsonResponse(true);
    if (value.includes("/session/ses_delayed")) {
      return jsonResponse({ tokens: { input: 4, output: 2, reasoning: 0 } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const backend = new OpenCodeServeBackend({
    fetchImpl,
    statusAdmissionGraceMs: 0,
    metricsSettleAttempts: 2,
    metricsSettleIntervalMs: 1,
  });
  const events = [];
  for await (const event of backend.streamEvents(agent.serveUrl, "ses_delayed", {
    cwd: agent.cwd,
    interval: 1,
    silentTimeout: 100,
  })) {
    events.push(event);
  }

  assert.ok(messagePolls >= 4, "the backend waited through the delayed admission");
  assert.equal(events.find((event) => event.kind === "done")?.reason, "completed");
});

test("OpenCode requalification: unknown session status does not become a false idle failure", async () => {
  let messagePolls = 0;
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("/session/status")) return jsonResponse({ ses_unknown_shape: { type: "future-state" } });
    if (value.includes("/message")) {
      messagePolls += 1;
      return jsonResponse(messagePolls < 2 ? [] : [{
        info: { id: "msg_a", role: "assistant", finish: "stop", tokens: { input: 1, output: 1 } },
        parts: [{ type: "text", text: "READY" }],
      }]);
    }
    if (value.includes("/session/ses_unknown_shape") && value.endsWith("/abort")) return jsonResponse(true);
    if (value.includes("/session/ses_unknown_shape")) {
      return jsonResponse({ tokens: { input: 1, output: 1, reasoning: 0 } });
    }
    throw new Error(`unexpected URL: ${value}`);
  };
  const backend = new OpenCodeServeBackend({
    fetchImpl,
    statusAdmissionGraceMs: 0,
    metricsSettleAttempts: 1,
  });
  const events = [];
  for await (const event of backend.streamEvents(
    "http://opencode.test",
    "ses_unknown_shape",
    { cwd: "C:/repo", interval: 1 },
  )) {
    events.push(event);
  }

  assert.equal(events.find((event) => event.kind === "done")?.reason, "completed");
});

test("OpenCode requalification: completion aborts first and waits for settled nonzero metrics", async () => {
  const stableMessages = [
    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
    { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "done" }] },
  ];
  const order = [];
  let sessionReads = 0;
  const sessionValues = [
    { tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0 },
    { tokens: { input: 120, output: 9, reasoning: 3 }, cost: 0.001 },
    { tokens: { input: 120, output: 9, reasoning: 3 }, cost: 0.001 },
  ];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes("/message")) return jsonResponse(stableMessages);
    if (value.endsWith("/abort") && init.method === "POST") {
      order.push("abort");
      return jsonResponse(true);
    }
    if (new URL(value).pathname.endsWith("/session/ses_metrics") && init.method === "GET") {
      const current = sessionValues[Math.min(sessionReads, sessionValues.length - 1)];
      sessionReads += 1;
      order.push(`metrics:${current.tokens.input}`);
      return jsonResponse(current);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const backend = new OpenCodeServeBackend({
    fetchImpl,
    metricsSettleAttempts: 4,
    metricsSettleIntervalMs: 1,
  });
  const events = [];
  for await (const event of backend.streamEvents(agent.serveUrl, "ses_metrics", {
    cwd: agent.cwd,
    interval: 1,
  })) {
    events.push(event);
  }

  const metrics = events.filter((event) => event.kind === "metrics");
  assert.equal(order[0], "abort");
  assert.deepEqual(metrics.at(-1)?.tokens, { input: 120, output: 9, reasoning: 3 });
  assert.equal(events.at(-1)?.kind, "done");
  assert.equal(events.at(-1)?.reason, "completed");
});

test("OpenCode requalification: changing metrics never masquerade as a settled snapshot", async () => {
  let reads = 0;
  const backend = new OpenCodeServeBackend({
    fetchImpl: async () => {
      reads += 1;
      return jsonResponse({ tokens: { input: reads, output: 1, reasoning: 0 } });
    },
    metricsSettleAttempts: 3,
    metricsSettleIntervalMs: 1,
  });

  const settled = await backend.settleSessionMetrics(agent.serveUrl, "ses_moving", agent.cwd);

  assert.equal(reads, 3);
  assert.equal(settled, null);
});

test("OpenCode requalification: native system transport requires a supported runtime version", async () => {
  const calls = [];
  const backend = new OpenCodeServeBackend({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return jsonResponse({ healthy: true, version: "1.17.9" });
    },
  });

  await assert.rejects(
    backend.validateRoleContractTransport(agent, { roleContract: "ROLE" }),
    /role contract transport is unavailable/,
  );
  assert.deepEqual(calls, [`${agent.serveUrl}/global/health`]);
});

test("OpenCode requalification: dynamic role transport refusal happens before transcript and spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-opencode-role-cap-"));
  try {
    const runDir = join(dir, "runs");
    const rolePath = join(dir, "role.md");
    const registryPath = join(dir, "agents.json");
    await writeFile(rolePath, "ROLE", "utf8");
    await writeFile(registryPath, JSON.stringify({
      agents: {
        worker: {
          backend: "claude-code",
          cwd: dir,
          systemPrompt: rolePath,
        },
      },
    }), "utf8");
    let validationCalls = 0;
    let spawnCalls = 0;
    const backend = {
      supportsRoleContract: true,
      async validateRoleContractTransport() {
        validationCalls += 1;
        throw new Error("role contract transport is unavailable");
      },
      async spawn() {
        spawnCalls += 1;
        return { backend: "fake", backendSessionId: "ses_unexpected" };
      },
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir },
      readRegistry,
      backendFor: () => backend,
    });

    await assert.rejects(
      manager.start("worker", { prompt: "task", runDir, registry: registryPath }),
      /role contract transport is unavailable/,
    );
    assert.equal(validationCalls, 1);
    assert.equal(spawnCalls, 0);
    assert.deepEqual(await readdir(runDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpenCode requalification: current safety references do not restore obsolete taskkill claims", async () => {
  const safety = await readFile(new URL("../../references/safety-incidents.md", import.meta.url), "utf8");
  const debt = await readFile(new URL("../../docs/tech-debt.md", import.meta.url), "utf8");

  assert.doesNotMatch(safety, /未停则强制 taskkill \+ 告警/);
  assert.doesNotMatch(safety, /_runCleanup[^\n]*静默验证未做/);
  assert.doesNotMatch(debt, /TD-37[^\n]*quiet=false 强制 taskkill/);
});

function stopBackend({ status = null, unavailable = false } = {}) {
  let abortCalls = 0;
  return {
    get abortCalls() {
      return abortCalls;
    },
    async abort() {
      abortCalls += 1;
    },
    async sessionStatus() {
      if (unavailable) throw new Error("status unavailable");
      return status;
    },
    async session() {
      if (unavailable) throw new Error("session unavailable");
      return { tokens: { input: 10, output: 2, reasoning: 0 } };
    },
    async messages() {
      if (unavailable) throw new Error("messages unavailable");
      return { data: [{ info: { role: "assistant" }, parts: [] }] };
    },
  };
}

test("OpenCode requalification: unavailable stop observations never become verified quiet", async () => {
  const backend = stopBackend({ unavailable: true });
  let taskkillCalls = 0;
  const result = await executeStopWithVerification(backend, "http://x", "ses_unknown", {
    rounds: 2,
    intervalMs: 1,
    taskkill: async () => {
      taskkillCalls += 1;
    },
  });

  assert.equal(result.abortCalled, true);
  assert.equal(result.verified, false);
  assert.equal(result.verifyResult?.quiet, null);
  assert.equal(result.verifyResult?.observation, "unavailable");
  assert.equal(taskkillCalls, 0, "unknown observation must not kill unrelated OpenCode sessions");
});

test("OpenCode requalification: unknown stop status is unavailable, not verified quiet", async () => {
  const backend = stopBackend({ status: { type: "future-state" } });
  const result = await verifyStopQuiet(backend, "http://x", "ses_future", {
    rounds: 2,
    intervalMs: 1,
  });

  assert.equal(result.quiet, null);
  assert.equal(result.observation, "unavailable");
});

test("OpenCode requalification: busy session status overrides stable counters", async () => {
  const backend = stopBackend({ status: { type: "busy" } });
  const result = await verifyStopQuiet(backend, "http://x", "ses_busy", {
    rounds: 2,
    intervalMs: 1,
  });

  assert.equal(result.quiet, false);
  assert.equal(result.metric, "session_status");
});

test("OpenCode requalification: production stop path calls the real backend abort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-opencode-stop-"));
  try {
    const runId = "run_opencode_real_stop";
    const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), {
      runId,
      agentId: "opencode_worker",
    });
    await transcript.append("run.started", { backend: "opencode-serve" });
    await transcript.append("session.created", {
      backend: "opencode-serve",
      backendSessionId: "ses_real_stop",
      serveUrl: "http://127.0.0.1:4297",
      cwd: agent.cwd,
    });
    await transcript.transitionState(null, "pending", "created");
    await transcript.transitionState("pending", "submitted", "spawned");
    await transcript.transitionState("submitted", "running", "first_event");

    let abortCalls = 0;
    const fetchImpl = async (url, init = {}) => {
      const value = String(url);
      if (value.endsWith("/abort") && init.method === "POST") {
        abortCalls += 1;
        return jsonResponse(true);
      }
      if (value.includes("/session/status")) return jsonResponse({});
      if (value.includes("/message")) return jsonResponse([]);
      if (value.includes("/session/ses_real_stop")) {
        return jsonResponse({ tokens: { input: 1, output: 1, reasoning: 0 } });
      }
      throw new Error(`unexpected URL ${url}`);
    };

    const result = await stopRun({
      runId,
      runDir: dir,
      deps: {
        fetchImpl,
        alert: async () => {},
        stopVerify: { rounds: 2, intervalMs: 1 },
      },
    });

    assert.equal(abortCalls, 1);
    assert.equal(result.sideEffectAttempted, true);
    assert.equal(result.stopVerified, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
