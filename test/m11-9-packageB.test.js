// test/m11-9-packageB.test.js
//
// M11-9 Package B: Backend compilation — canonical policy → CLI argv translation.
//
// Each backend translates structured model/reasoning into runtime-native CLI
// flags. Shared orchestration does NOT branch on runtime name.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProviderArgs } from "../src/backends/claudeCodeProvider.js";

// ===== Claude Code backend: structured → CLI =====

test("B1-claude-provider: resolveProviderArgs derives wrapper + cli from canonical fields", () => {
  const agent = {
    provider: { protocol: "anthropic-compatible", baseUrl: "https://x", apiKeyEnv: "KEY" },
    model: { id: "glm-5.2", contextWindow: 1000000 },
    reasoning: { effort: "high" },
  };
  const r = resolveProviderArgs(agent, "/wrapper.mjs");
  assert.ok(r, "returns result when provider present");
  // wrapper prependArgs include connection + model + effort + context.
  assert.ok(r.prependArgs.includes("--default-model"), "wrapper gets --default-model");
  assert.ok(r.prependArgs.includes("glm-5.2"), "wrapper gets model id");
  assert.ok(r.prependArgs.includes("--effort"), "wrapper gets --effort");
  assert.ok(r.prependArgs.includes("high"), "wrapper gets effort value");
  assert.ok(r.prependArgs.includes("--context-window"), "wrapper gets --context-window");
  // cli flags mirror model + effort.
  assert.deepEqual(r.cliFlags, ["--model", "glm-5.2", "--effort", "high"]);
});

test("B2-claude-native: resolveProviderArgs returns null without provider", () => {
  const agent = {
    model: { id: "claude-opus-5" },
    reasoning: { effort: "xhigh" },
  };
  const r = resolveProviderArgs(agent, "/wrapper.mjs");
  assert.equal(r, null, "no provider → null (native OAuth direct-connect path)");
});

test("B3-claude-native-buildArgs: model + effort from structured fields (no provider)", async () => {
  // Verify claudeCode buildArgs generates --model/--effort when no provider.
  const { ClaudeCodeBackend } = await import("../src/backends/claudeCode.js");
  const backend = new ClaudeCodeBackend();
  // Access the buildArgs function via the internal config.
  // ClaudeCodeBackend passes buildArgs to ProcessBackend constructor.
  const agent = {
    id: "auditor",
    backend: "claude-code",
    cwd: "/x",
    model: { id: "claude-opus-5" },
    reasoning: { effort: "xhigh" },
    args: ["--dangerously-skip-permissions"],
  };
  const args = backend.buildArgs(agent, { prompt: "task" });
  assert.ok(args.includes("--model"), "native path generates --model");
  assert.ok(args.includes("claude-opus-5"), "model id present");
  assert.ok(args.includes("--effort"), "native path generates --effort");
  assert.ok(args.includes("xhigh"), "effort value present");
  assert.ok(args.includes("--dangerously-skip-permissions"), "residual args kept");
});

test("B4-claude-no-model: absent model → no --model flag", async () => {
  const { ClaudeCodeBackend } = await import("../src/backends/claudeCode.js");
  const backend = new ClaudeCodeBackend();
  const agent = { id: "w", backend: "claude-code", cwd: "/x", args: [] };
  const args = backend.buildArgs(agent, { prompt: "task" });
  assert.ok(!args.includes("--model"), "no model → no --model flag");
  assert.ok(!args.includes("--effort"), "no reasoning → no --effort flag");
});

// ===== Codex backend: structured → CLI =====

test("B5-codex-model: model.id → --model", async () => {
  const { CodexBackend } = await import("../src/backends/codex.js");
  const backend = new CodexBackend();
  const agent = { id: "tester", backend: "codex", cwd: "/x", model: { id: "codex-model-x" } };
  const args = backend.buildArgs(agent, { prompt: "task" });
  assert.ok(args.includes("--model"), "codex generates --model");
  assert.ok(args.includes("codex-model-x"), "model id present");
});

test("B6-codex-effort: reasoning.effort → -c model_reasoning_effort", async () => {
  const { CodexBackend } = await import("../src/backends/codex.js");
  const backend = new CodexBackend();
  const agent = { id: "tester", backend: "codex", cwd: "/x", reasoning: { effort: "high" } };
  const args = backend.buildArgs(agent, { prompt: "task" });
  const idx = args.indexOf("-c");
  assert.ok(idx >= 0, "codex generates -c for effort");
  assert.ok(args[idx + 1].includes("model_reasoning_effort"), "-c value is model_reasoning_effort");
  assert.ok(args[idx + 1].includes("high"), "effort value embedded");
});

test("B7-codex-no-reasoning: absent → no effort override", async () => {
  const { CodexBackend } = await import("../src/backends/codex.js");
  const backend = new CodexBackend();
  const agent = { id: "tester", backend: "codex", cwd: "/x" };
  const args = backend.buildArgs(agent, { prompt: "task" });
  assert.ok(!args.some((a) => typeof a === "string" && a.includes("model_reasoning_effort")),
    "no reasoning → no effort override");
});

// ===== Kimi backend: structured → CLI =====

test("B8-kimi-model: model.id → --model", async () => {
  const { KimiCodeBackend } = await import("../src/backends/kimiCode.js");
  const backend = new KimiCodeBackend();
  const agent = { id: "coder_mm", backend: "kimi-code", cwd: "/x", model: { id: "kimi-code/k3" } };
  const args = backend.buildArgs(agent, { prompt: "task" });
  assert.ok(args.includes("--model"), "kimi generates --model");
  assert.ok(args.includes("kimi-code/k3"), "model id present");
});

test("B9-kimi-effort-rejected: reasoning.effort → throw (no single-process channel)", async () => {
  const { KimiCodeBackend } = await import("../src/backends/kimiCode.js");
  const backend = new KimiCodeBackend();
  const agent = { id: "coder_mm", backend: "kimi-code", cwd: "/x", reasoning: { effort: "high" } };
  assert.throws(
    () => backend.buildArgs(agent, { prompt: "task" }),
    /kimi.*not.*support.*reasoning|no single-process/i,
    "kimi rejects reasoning.effort",
  );
});

test("B10-kimi-no-reasoning: absent → no error, no effort", async () => {
  const { KimiCodeBackend } = await import("../src/backends/kimiCode.js");
  const backend = new KimiCodeBackend();
  const agent = { id: "coder_mm", backend: "kimi-code", cwd: "/x", model: { id: "kimi-code/k3" } };
  const args = backend.buildArgs(agent, { prompt: "task" });
  assert.doesNotThrow(() => {}, "no reasoning → no throw");
  assert.ok(!args.some((a) => typeof a === "string" && a.includes("effort")), "no effort flag");
});
