// test/run-lifecycle/consultRerenderProperty.test.js
//
// TD-207 属性钉（2026-10-09 排序批收口）：consult show 的重渲染路径必须
// 经共享投影（observeSeatRun → extractFinalAssistantText）重读席位转录，
// 席位末条 assistant 消息里"末锚点之后"的尾部内容必须出现在 finalText——
// 不依赖组记录里存过任何渲染快照。2026-10-02 的原始缺陷（show 丢尾内容）
// 已随 M13-r2 的统一读取消失（当日 consult_20261008164029600fyqngp 双席
// "执行顺序最终建议"尾段实测完整渲染）；本钉防回归。
import { test } from "node:test";
import assert from "node:assert/strict";
import { rerenderConsultFromRecord } from "../../src/application/consultService.js";

const RUN_ID = "run_20261009prop0001aaaaa";

function syntheticEvents() {
  return [
    { type: "run.started", runId: RUN_ID, agentId: "astra", ts: "2026-10-09T00:00:00.000Z" },
    { type: "run.state_change", runId: RUN_ID, from: "running", to: "completed", ts: "2026-10-09T00:01:00.000Z" },
    {
      type: "run.event", runId: RUN_ID, kind: "message", role: "assistant", ts: "2026-10-09T00:01:10.000Z",
      parts: [{ type: "text", text: "报告中段：正文与锚点……" }],
    },
    {
      type: "run.event", runId: RUN_ID, kind: "message", role: "assistant", ts: "2026-10-09T00:01:20.000Z",
      parts: [{ type: "text", text: "正文收尾。\n【末锚点之后】TD-207 尾部内容标记 prop-tail-9f3a。" }],
    },
  ];
}

test("TD-207: show 重渲染取席位末条 assistant 消息全文——末锚点之后内容在场", async () => {
  const record = {
    consultId: "consult_20261009000000000prop01",
    // 组记录不含任何渲染快照字段（finalText/渲染文本）——重渲染必须自转录取真值。
    seats: [{ agentId: "astra", runId: RUN_ID, backend: "codex", runState: "completed" }],
    questions: [],
    declaredFields: {},
    brief: "prop-test",
    budgetMs: 1000,
  };
  const result = await rerenderConsultFromRecord({
    record,
    runDir: "C:/unused-run-dir",
    consultsDir: "C:/unused-consults-dir",
    readTranscriptFn: async () => syntheticEvents(),
    env: {},
  });
  const seat = result.seats.find((s) => s.agentId === "astra");
  assert.ok(seat, "席位结果在场");
  assert.equal(seat.runState, "completed", "终态自转录事实读取");
  assert.ok(seat.finalText.includes("TD-207 尾部内容标记 prop-tail-9f3a"),
    `finalText 含末锚点之后内容，实测：${JSON.stringify(seat.finalText)}`);
  assert.ok(!seat.finalText.includes("报告中段"), "finalText=末条 assistant 消息，非历史消息拼接");
});
