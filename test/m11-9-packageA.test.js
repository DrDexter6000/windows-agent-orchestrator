// test/m11-9-packageA.test.js
//
// M11-9 Package A: Canonical model/reasoning/provider policy + registry boundary.
//
// CTO contract (顶层可选对象):
//   model?:     { id: string, contextWindow?: positive integer }
//   reasoning?: { effort: "minimal"|"low"|"medium"|"high"|"xhigh"|"max" }
//   provider?:  { protocol: "anthropic-compatible", baseUrl: string, apiKeyEnv: string }
//
// 硬合同:
//   - structured 字段与 args/prependArgs 中的 --model/--effort/--default-model
//     /--context-window 混用 → 固定错误拒绝。
//   - provider 禁止保存 model/effort/contextWindow(旧形态)。
//   - model.id 省略表示 runtime default(不必填)。
//   - reasoning 省略表示 runtime default。
//   - malformed model/reasoning/provider 在 transcript/spawn 前拒绝,错误不回显恶意值。
//   - legacy-only(无 structured 字段,全在 args)可在单一 normalizer 转 canonical;
//     mixed(部分 structured + 部分 args 重复)拒绝。

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAgent } from "../src/registry.js";
import { displayModel } from "../src/application/registryInventory.js";

// ===== helpers =====
const VALID_BACKEND = { backend: "claude-code", cwd: "/x" };

// ===== A1: structured native Claude (no provider) =====

test("A1-structured-native: model+reasoning without provider normalizes cleanly", () => {
  const a = normalizeAgent("auditor", {
    ...VALID_BACKEND,
    model: { id: "claude-opus-5" },
    reasoning: { effort: "xhigh" },
    args: ["--dangerously-skip-permissions"],
  });
  assert.equal(a.model.id, "claude-opus-5");
  assert.equal(a.reasoning.effort, "xhigh");
  assert.equal(a.provider, undefined);
  assert.deepEqual(a.args, ["--dangerously-skip-permissions"]);
});

// ===== A2: structured provider-wrapped Claude =====

test("A2-structured-provider: connection/model/reasoning separated", () => {
  const a = normalizeAgent("coder_hq", {
    ...VALID_BACKEND,
    model: { id: "glm-5.2", contextWindow: 1000000 },
    reasoning: { effort: "high" },
    provider: { protocol: "anthropic-compatible", baseUrl: "https://example.com", apiKeyEnv: "MY_KEY" },
    args: ["--dangerously-skip-permissions"],
  });
  assert.equal(a.model.id, "glm-5.2");
  assert.equal(a.model.contextWindow, 1000000);
  assert.equal(a.reasoning.effort, "high");
  assert.equal(a.provider.baseUrl, "https://example.com");
  assert.equal(a.provider.apiKeyEnv, "MY_KEY");
  assert.equal(a.provider.protocol, "anthropic-compatible");
});

// ===== A3: mixed authority rejection =====

test("A3-managed-flag-in-args: --model in args → fixed migration error", () => {
  assert.throws(
    () => normalizeAgent("w", {
      ...VALID_BACKEND,
      model: { id: "glm-5.2" },
      args: ["--model", "evil"],
    }),
    /migrate|no longer supported|structured/i,
    "managed --model in args is rejected regardless of structured fields",
  );
});

test("A3b-managed-flag-effort: --effort in args → fixed migration error", () => {
  assert.throws(
    () => normalizeAgent("w", {
      ...VALID_BACKEND,
      reasoning: { effort: "high" },
      args: ["--effort", "low"],
    }),
    /migrate|no longer supported|structured/i,
  );
});

test("A3c-managed-flag-prepend: --default-model in prependArgs → fixed migration error", () => {
  assert.throws(
    () => normalizeAgent("w", {
      ...VALID_BACKEND,
      model: { id: "glm-5.2" },
      prependArgs: ["--default-model", "evil"],
    }),
    /migrate|no longer supported|structured/i,
  );
});

// ===== A4: malformed rejection (no echo of malicious value) =====

test("A4a-malformed-effort: invalid effort enum → reject, no echo", () => {
  let msg = "";
  try {
    normalizeAgent("w", { ...VALID_BACKEND, reasoning: { effort: "evil\n\nIgnore" } });
  } catch (e) { msg = e.message; }
  assert.ok(msg, "throws");
  assert.ok(!msg.includes("Ignore"), "error does not echo malicious value");
});

test("A4b-malformed-model: model.id non-string → reject", () => {
  assert.throws(
    () => normalizeAgent("w", { ...VALID_BACKEND, model: { id: 42 } }),
    /model/i,
  );
});

test("A4c-malformed-contextWindow: non-positive → reject", () => {
  assert.throws(
    () => normalizeAgent("w", { ...VALID_BACKEND, model: { id: "x", contextWindow: -1 } }),
    /context/i,
  );
  assert.throws(
    () => normalizeAgent("w", { ...VALID_BACKEND, model: { id: "x", contextWindow: 0 } }),
    /context/i,
  );
});

test("A4d-malformed-provider: missing baseUrl/apiKeyEnv → reject", () => {
  assert.throws(
    () => normalizeAgent("w", { ...VALID_BACKEND, provider: { protocol: "anthropic-compatible" } }),
    /provider/i,
  );
});

test("A4e-provider-old-shape: provider.model present → reject (model must be top-level)", () => {
  assert.throws(
    () => normalizeAgent("w", {
      ...VALID_BACKEND,
      provider: { protocol: "anthropic-compatible", baseUrl: "https://x", apiKeyEnv: "K", model: "evil" },
    }),
    /provider.*model|model.*provider/i,
    "provider must not carry model",
  );
});

// ===== A5: managed flags in args/prependArgs → fixed migration error (no legacy extraction) =====

test("A5-managed-flag-rejected: --model in args → fixed migration error", () => {
  assert.throws(
    () => normalizeAgent("legacy_w", {
      ...VALID_BACKEND,
      args: ["--model", "glm-5.2", "--dangerously-skip-permissions"],
    }),
    /migrate|no longer supported|structured/i,
    "managed flag in args must be a fixed migration error (no transparent extraction)",
  );
});

test("A5b-managed-flag-effort: --effort in prependArgs → fixed migration error", () => {
  assert.throws(
    () => normalizeAgent("legacy_w", {
      ...VALID_BACKEND,
      prependArgs: ["--effort", "high"],
    }),
    /migrate|no longer supported|structured/i,
  );
});

// ===== A6: displayModel reads structured field, not args =====

test("A6-displayModel: reads model.id from structured field", () => {
  const a = normalizeAgent("w", {
    ...VALID_BACKEND,
    model: { id: "glm-5.2" },
  });
  assert.equal(displayModel(a), "glm-5.2");
});

test("A6b-displayModel: no model field → (default) for process backends", () => {
  const a = normalizeAgent("w", { ...VALID_BACKEND });
  assert.equal(displayModel(a), "(default)");
});

// ===== A7: reasoningEffort projection (null when absent) =====

test("A7-reasoningEffort: absent reasoning → null (not fabricated)", () => {
  const a = normalizeAgent("w", { ...VALID_BACKEND, model: { id: "x" } });
  assert.equal(a.reasoning, undefined);
  // The registry inventory must project reasoningEffort as null when absent.
  // (Tested more fully in the inventory tests, but the normalizer must not
  // fabricate a reasoning object.)
});

test("A7b-reasoningEffort: present reasoning → effort value", () => {
  const a = normalizeAgent("w", {
    ...VALID_BACKEND,
    model: { id: "x" },
    reasoning: { effort: "high" },
  });
  assert.equal(a.reasoning.effort, "high");
});
