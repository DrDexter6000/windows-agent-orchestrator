// test/application/claudeSessionNotFoundDiagnosis.test.js
//
// 决定 0114：claude-code 续修目标会话不存在时，运行失败原因与 `runs diagnose`
// 给出具名原因（provider 会话不存在），而不是 category: unknown；证据文本绝不
// 回显 opaque uuid 或 provider 原文。
//
// parser 侧已把 result errors 原文收口成固定句（见 test/parsers/claudeCode.test.js）；
// 本文件钉诊断映射：固定句 → category crash（既有闭集，不新增工具体面）+ 具名事实；
// 同时钉 run_diagnosis 服务（CLI `runs diagnose` 的共享应用服务）走同一映射。

import test from "node:test";
import assert from "node:assert/strict";

import { diagnoseFailure } from "../../src/diagnosis.js";
import { getRunDiagnosis } from "../../src/application/runDiagnosis.js";
import { PROVIDER_SESSION_NOT_FOUND_ERROR } from "../../src/backends/parsers/claudeCode.js";

const RUN_ID = "run_20261106120000000b77aa";
const UUID = "7f3c2b1a-9d8e-4f6a-8b5c-1d2e3f4a5b6c";

function failedEvents() {
  return [
    { runId: RUN_ID, type: "run.state_change", from: "pending", to: "running" },
    { runId: RUN_ID, type: "run.error", phase: "wait", error: PROVIDER_SESSION_NOT_FOUND_ERROR },
    { runId: RUN_ID, type: "run.state_change", from: "running", to: "failed" },
  ];
}

test("0114: 续修会话不存在的 run.error → category crash + 具名事实（不再 unknown）", () => {
  const diagnosis = diagnoseFailure(failedEvents(), RUN_ID);
  assert.equal(diagnosis.category, "crash", "有具名失败事实，不能被归成 unknown");
  assert.equal(diagnosis.code, null, "不新增 category/code（MCP 工具体面字节兼容）");
  const facts = diagnosis.evidence.map((e) => e.fact).join("\n");
  assert.match(facts, /provider 会话不存在/);
  assert.match(facts, /No conversation found with session ID/);
  assert.ok(!JSON.stringify(diagnosis).includes(UUID), "opaque uuid 不进诊断输出");
});

test("0114: runs diagnose 的共享服务（getRunDiagnosis）给同一具名原因", async () => {
  const diagnosis = await getRunDiagnosis({
    runId: RUN_ID,
    runDir: "unused-in-this-test",
    readTranscriptFn: async () => failedEvents(),
  });
  assert.equal(diagnosis.state, "failed");
  assert.equal(diagnosis.terminal, true);
  assert.equal(diagnosis.category, "crash");
  assert.ok(
    diagnosis.evidence.some((e) => e.eventType === "run.error" && /provider 会话不存在/.test(e.fact)),
    "诊断证据含具名原因",
  );
  assert.ok(!JSON.stringify(diagnosis).includes(UUID), "opaque uuid 不进 runs diagnose 输出");
});

test("0114: evidence 事实只用固定句，不搬运 run.error 之外的 provider 原文", () => {
  const events = failedEvents();
  // 即使 run.error 被错误地塞入 uuid（历史/损坏转录），诊断事实也不回显它。
  events[1] = {
    runId: RUN_ID,
    type: "run.error",
    phase: "wait",
    error: `${PROVIDER_SESSION_NOT_FOUND_ERROR} (raw: No conversation found with session ID: ${UUID})`,
  };
  const diagnosis = diagnoseFailure(events, RUN_ID);
  assert.equal(diagnosis.category, "crash");
  assert.ok(!JSON.stringify(diagnosis).includes(UUID), "诊断事实不搬运原文");
});
