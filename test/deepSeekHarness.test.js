import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  DeepSeekHarnessBackend,
  DeepSeekHarnessEventQueue,
} from "../src/backends/deepSeekHarness.js";
import { normalizeAgent } from "../src/registry.js";
import { inheritedEnvNames, requiredCredentialNames } from "../src/envPolicy.js";
import { backendFor } from "../src/commands/shared.js";

const FAKE_RUNTIME = fileURLToPath(new URL("./fixtures/fakeDshJsonRpcRuntime.mjs", import.meta.url));
const FAKE_CONFIG = fileURLToPath(new URL("../package.json", import.meta.url));

function agent(overrides = {}) {
  return {
    id: "coder_low",
    backend: "deepseek-harness",
    cwd: process.cwd(),
    binary: process.execPath,
    args: [FAKE_RUNTIME],
    dshConfigPath: FAKE_CONFIG,
    credentialEnv: "DEEPSEEK_API_KEY",
    model: { id: "deepseek-v4-flash", contextWindow: 1_000_000 },
    reasoning: { effort: "max" },
    ...overrides,
  };
}

async function collect(handle) {
  const events = [];
  for await (const event of handle.events(new AbortController().signal)) events.push(event);
  return events;
}

test("DSH policy accepts flash/max/1m and rejects unsupported provider policy", () => {
  const backend = new DeepSeekHarnessBackend();
  assert.doesNotThrow(() => backend.validateAgentPolicy(agent()));
  assert.throws(
    () => backend.validateAgentPolicy(agent({
      provider: {
        protocol: "anthropic-compatible",
        baseUrl: "https://example.invalid",
        apiKeyEnv: "OTHER_KEY",
      },
    })),
    /cannot express provider/,
  );
  assert.throws(
    () => backend.validateAgentPolicy(agent({ reasoning: { effort: "xhigh" } })),
    /reasoning\.effort/,
  );
});

test("DSH JSON-RPC buffers pre-response notifications and completes after bound receipt + idle", async () => {
  const backend = new DeepSeekHarnessBackend();
  const handle = await backend.spawn(agent({ env: { FAKE_DSH_MODE: "foreign-first" } }), {
    prompt: "reply",
    roleContract: "bounded role",
    resolvedCredentials: { DEEPSEEK_API_KEY: "secret-value-123" },
  });
  const events = await collect(handle);

  assert.equal(handle.backend, "deepseek-harness");
  assert.ok(events.some((event) => event.kind === "runtime_activity" && event.status === "initialized"));
  assert.ok(events.some((event) => event.kind === "message"
    && event.parts.some((part) => part.text === "DSH_OK deepseek-v4-flash")));
  assert.ok(!events.some((event) => JSON.stringify(event).includes("FOREIGN_OUTPUT")));
  assert.ok(events.some((event) => event.kind === "metrics" && event.tokens.input === 12));
  assert.deepEqual(events.at(-1), { kind: "done", reason: "completed" });
});

test("DSH projects shell and write evidence with confirmed file writes", async () => {
  const backend = new DeepSeekHarnessBackend();
  const handle = await backend.spawn(agent({ env: { FAKE_DSH_MODE: "evidence" } }), {
    prompt: "edit",
    roleContract: "bounded role",
  });
  const events = await collect(handle);

  assert.ok(events.some((event) => event.kind === "command"
    && event.command === "Get-Content README.md" && event.toolCallId === "call-shell"));
  assert.ok(events.some((event) => event.kind === "write_intent"
    && event.path === "src/example.js" && event.toolCallId === "call-edit"));
  assert.ok(events.some((event) => event.kind === "file_written"
    && event.path === "src/example.js" && event.toolCallId === "call-edit"));
  assert.ok(events.some((event) => event.kind === "tool_result" && event.tool === "call-edit"));
});

test("DSH fails closed on internal subagents and transport close before completion", async () => {
  for (const mode of ["subagent", "transport-close"]) {
    const backend = new DeepSeekHarnessBackend();
    const handle = await backend.spawn(agent({ env: { FAKE_DSH_MODE: mode } }), {
      prompt: "probe",
      roleContract: "bounded role",
    });
    const events = await collect(handle);
    assert.equal(events.at(-1)?.kind, "done");
    assert.equal(events.at(-1)?.reason, "failed");
  }
});

test("DSH drains a terminal fact queued while the event iterator is paused", async () => {
  const backend = new DeepSeekHarnessBackend();
  const queue = new DeepSeekHarnessEventQueue();
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

test("DSH coalesces streaming chunks into one bounded runtime activity fact", async () => {
  const backend = new DeepSeekHarnessBackend();
  const handle = await backend.spawn(agent({ env: { FAKE_DSH_MODE: "streaming" } }), {
    prompt: "reply",
    roleContract: "bounded role",
  });
  const events = await collect(handle);

  assert.equal(
    events.filter((event) => event.kind === "runtime_activity" && event.status === "streaming").length,
    1,
  );
  assert.deepEqual(events.at(-1), { kind: "done", reason: "completed" });
});

test("DSH validates runtime identity before returning a handle", async () => {
  const backend = new DeepSeekHarnessBackend();
  await assert.rejects(
    backend.spawn(agent({ env: { FAKE_DSH_MODE: "bad-identity" } }), {
      prompt: "probe",
      roleContract: "bounded role",
    }),
    /runtime identity/,
  );
});

test("DSH registry, credential policy, and production backend factory share the new backend", () => {
  const normalized = normalizeAgent("coder_low", agent());
  assert.equal(normalized.backend, "deepseek-harness");
  assert.deepEqual(requiredCredentialNames(normalized), ["DEEPSEEK_API_KEY"]);
  assert.ok(inheritedEnvNames(normalized).includes("DEEPSEEK_API_KEY"));
  assert.ok(backendFor(normalized) instanceof DeepSeekHarnessBackend);

  assert.throws(
    () => normalizeAgent("bad", { ...agent(), dshConfigPath: "" }),
    /dshConfigPath/,
  );
  assert.throws(
    () => normalizeAgent("bad", { ...agent(), credentialEnv: undefined }),
    /credentialEnv/,
  );
  assert.throws(
    () => normalizeAgent("bad", { ...agent(), credentialEnv: "" }),
    /credentialEnv/,
  );
});
