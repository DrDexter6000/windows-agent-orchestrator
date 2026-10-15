// diagnosis.test.js
//
// M8-3：故障诊断（🔵 工具起草域——给证据，不给处方）。
//
// 设计契约（铁律）：diagnoseFailure 只输出【事实证据】，绝不输出【建议/处方】。
// 处方权（retry/换 worker/接管/放弃）全在 Lead。诊断函数的"不输出建议"由测试硬约束：
//   - 返回结构无 recommendation 字段
//   - 任何字符串字段不得含 建议/应该/建议重试/换worker 等措辞
//
// 分类（只给证据，按信号归类；不强归类则归 unknown）：
//   provider_auth  — 401/身份验证失败/unauthor/auth fail
//   timeout        — run.timed_out 事件 / 等待超时
//   scorecard_fail — run.error phase:scorecard / scorecard.checked passed:false
//   budget         — run.state_change reason:budget_exceeded
//   crash          — run.error phase:spawn/spawn_fail / backend error 无 done
//   aborted_manual — run.aborted 事件（reason:user/SIGINT）
//   unknown        — 信号不足以归类

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseFailure,
  DIAGNOSIS_CATEGORIES,
  DIAGNOSIS_CODES,
  isValidDiagnosisCode,
  PROVIDER_DIAGNOSIS_CODES,
  PROVIDER_CAPACITY_DIAGNOSIS_CODES,
  NO_EFFECT_DIAGNOSIS_CODES,
} from "../../src/diagnosis.js";

// ---------------------------------------------------------------------------
// 分类准确性（给证据）
// ---------------------------------------------------------------------------

test("M8-3: 401 transcript → 诊断为 provider_auth + 引用具体事件", () => {
  const events = [
    { type: "run.submitted", agentId: "coder_hq", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.error", phase: "wait", error: "provider error [401]: 身份验证失败", ts: "2026-06-26T10:00:05.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-06-26T10:00:05.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "provider_auth");
  assert.ok(Array.isArray(d.evidence), "必须有 evidence 数组");
  assert.ok(d.evidence.length > 0, "至少一条证据");
  // 证据引用具体事件（含事件类型 + 事实描述）
  const ev0 = d.evidence[0];
  assert.ok(ev0.eventType, "证据应含 eventType 指向源事件");
  assert.ok(ev0.fact, "证据应含 fact 描述具体事实");
});

test("M8-3: 超时 transcript → timeout + 引用 timed_out 事件", () => {
  const events = [
    { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.timed_out", backendSessionId: "ses1", ts: "2026-06-26T10:02:00.000Z" },
    { type: "run.state_change", from: "running", to: "timed_out", reason: "timeout", ts: "2026-06-26T10:02:00.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "timeout");
  assert.ok(d.evidence.some((e) => e.eventType === "run.timed_out"), "应引用 run.timed_out 事件");
});

test("M8-3: scorecard_fail → 列出失败的 check name", () => {
  const events = [
    { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
    { type: "scorecard.checked", passed: false, checks: [
      { name: "hasDoneEvent", passed: true },
      { name: "hasEvidence", passed: false, detail: "no evidence" },
      { name: "commandsPassed", passed: false, detail: "npm test not run" },
    ], ts: "2026-06-26T10:01:00.000Z" },
    { type: "run.error", phase: "scorecard", detail: "hasEvidence: no evidence; commandsPassed: npm test not run", ts: "2026-06-26T10:01:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "scorecard_failed", ts: "2026-06-26T10:01:00.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "scorecard_fail");
  // 证据应列出失败的 check name
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /hasEvidence/, "应指出 hasEvidence 失败");
  assert.match(joined, /commandsPassed/, "应指出 commandsPassed 失败");
});

test("M8-3: budget_exceeded → budget 类别", () => {
  const events = [
    { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "budget_exceeded", ts: "2026-06-26T10:01:00.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "budget");
});

test("M8-3: aborted (user/SIGINT) → aborted_manual", () => {
  const events = [
    { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.aborted", reason: "user", ts: "2026-06-26T10:00:30.000Z" },
    { type: "run.state_change", to: "aborted", reason: "user", ts: "2026-06-26T10:00:30.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "aborted_manual");
});

test("TD-55 legacy: aborted state_change 后又出现 failed state_change（旧双终态 transcript）→ 仍识别 aborted_manual", () => {
  // 旧 transcript 兼容：历史 race 留下的双终态（aborted 先 claim 成功，failed 后被 race 写入）。
  // 这种 transcript 只会从 TD-99 之前的历史 race 产生（新写入受 first-terminal-wins 约束，
  // 不会产生双终态）。
  // 窄兼容规则：有 stop_requested/aborted 证据 + >=2 条 terminal state_change + 第一条是 aborted
  // + 无 state_change_rejected → 按 legacy aborted_manual 解释（aborted 是真正意图）。
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.stop_requested", backendSessionId: "proc_123", reason: "user", ts: "2026-06-26T10:00:01.000Z" },
    { type: "run.state_change", from: "submitted", to: "aborted", reason: "stop_requested", ts: "2026-06-26T10:00:01.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 143", ts: "2026-06-26T10:00:02.000Z" },
    { type: "run.state_change", from: "aborted", to: "failed", reason: "backend_error", ts: "2026-06-26T10:00:02.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "aborted_manual", "旧双终态（aborted 先赢被 race 覆盖）legacy 兼容归 aborted_manual");
});

test("TD-99 新世界: failed 先赢，随后 stop_requested + aborted rejected → 不归 aborted_manual", () => {
  // failed 先 claim 成功，stop 的 aborted 被 transitionState 拒绝。
  // findState=failed（aborted 的 state_change 没写成），迟到的 stop_requested 不抢分类。
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 143", ts: "2026-06-26T10:00:02.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-06-26T10:00:02.000Z" },
    { type: "run.stop_requested", backendSessionId: "proc_123", reason: "user", ts: "2026-06-26T10:00:03.000Z" },
    { type: "run.state_change_rejected", attemptedTo: "aborted", attemptedReason: "stop_requested", existingTerminal: "failed", reason: "first_terminal_wins", ts: "2026-06-26T10:00:03.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "crash", "failed 已赢，迟到的 stop_requested 不抢分类（exit 143 → crash）");
});

test("TD-99 新世界: aborted 先赢，随后 failed rejected → aborted_manual", () => {
  // aborted 先 claim 成功，waitForCompletion 的 failed 被 rejected。
  // findState=aborted，归 aborted_manual。
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.stop_requested", backendSessionId: "proc_123", reason: "user", ts: "2026-06-26T10:00:01.000Z" },
    { type: "run.state_change", from: "submitted", to: "aborted", reason: "stop_requested", ts: "2026-06-26T10:00:01.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 143", ts: "2026-06-26T10:00:02.000Z" },
    { type: "run.state_change_rejected", attemptedTo: "failed", attemptedReason: "backend_error", existingTerminal: "aborted", reason: "first_terminal_wins", ts: "2026-06-26T10:00:02.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "aborted_manual", "aborted 先赢，归 aborted_manual");
  assert.ok(d.evidence.some((e) => e.eventType === "run.stop_requested" || e.eventType === "run.state_change"));
});

test("M8-3: spawn 阶段崩溃 → crash", () => {
  const events = [
    { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.error", phase: "spawn", error: "ENOENT: claude not found", ts: "2026-06-26T10:00:01.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "crash");
});

// ---------------------------------------------------------------------------
// C（按 B 冒烟发现扩充）：真实 transcript 暴露的两个诊断盲区
//
// 1) 进程被信号杀死（exit code 143 = SIGTERM 等）→ 此前漏到 unknown。
//    真实例：run.error phase:wait error:"process exited with code 143"。
// 2) 配置冲突（API key 与 claude.ai 登录打架）→ 此前被宽泛 AUTH_SIGNAL 误判为
//    provider_auth。真实例："connectors are disabled because ANTHROPIC_API_KEY...
//    takes precedence"。这不是 401 认证失败，是配置层冲突。
// ---------------------------------------------------------------------------

test("C1: 进程被信号杀死（exit code 143 = SIGTERM）→ crash（非 unknown）", () => {
  // B 冒烟真实样本：run_20260626105147208ba1qxf
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-06-26T10:51:47.213Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 143", ts: "2026-06-26T10:51:48.375Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-26T10:51:48.376Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "crash", "进程被信号杀死（非 0 退出码）应归 crash，非 unknown");
  assert.ok(d.evidence.length > 0, "应有证据");
  assert.match(d.evidence[0].fact, /143|exit|signal|SIGTERM/i, "证据应陈述退出码/信号事实");
});

test("TD-180: 进程退出前零 worker 事件 → crash 另列一条观察事实（只陈述事实，不给处方）", () => {
  // 真实样本形状：run_20261012123408529e9ri5d（会话建立 13.7s 后退出码 1，零 run.event）
  const events = [
    { type: "session.created", backend: "process", backendSessionId: "proc_36288", ts: "2026-10-12T12:34:18.034Z" },
    { type: "run.submitted", ts: "2026-10-12T12:34:18.038Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1; stderr: Reading additional input from stdin...", ts: "2026-10-12T12:34:31.743Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-10-12T12:34:31.746Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "crash");
  assert.equal(d.evidence.length, 2);
  assert.match(d.evidence[1].fact, /^进程退出前未观察到任何 worker 事件（会话建立后 14s 退出）；未观察到事件不等于没有副作用/);
  assert.doesNotMatch(JSON.stringify(d), /建议|应该|重试|重派|安全/, "只陈述观察到的事实");

  // 已有 worker 事件的退出不附这条（那不是"还没开始"）
  const withActivity = [
    ...events.slice(0, 2),
    { type: "run.event", kind: "thinking", ts: "2026-10-12T12:34:20.000Z" },
    ...events.slice(2),
  ];
  assert.equal(diagnoseFailure(withActivity).evidence.length, 1);
  // 退出之后才落盘的 worker 事件不抹掉这条事实（判据只看退出事件之前）
  const lateEvent = [...events, { type: "run.event", kind: "thinking", ts: "2026-10-12T12:34:40.000Z" }];
  assert.equal(diagnoseFailure(lateEvent).evidence.length, 2);
  // 时间戳缺席时不编造存活时长
  const noTs = events.map(({ ts, ...rest }) => rest);
  assert.match(diagnoseFailure(noTs).evidence[1].fact, /^进程退出前未观察到任何 worker 事件；/);
});

test("C1: 进程 exit code 1（通用非 0）→ 仍 crash（不归 unknown）", () => {
  // 非 0 退出码都算 crash 候选（OOM/被杀/异常退出），但纯 401 仍优先 provider_auth
  const events = [
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-06-26T10:00:01.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-26T10:00:01.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "crash");
});

// ---------------------------------------------------------------------------
// TD-74：provider 流式中断（provider_disconnect）诊断类
//
// 真实样本 run_2026062818401405116u1yd（coder_hq/GLM-5.2）：worker 正常思考 23s
// 静默后进程 exit 1，claude-code 从未发 result（metrics=0）。属 provider 网关流式
// 中断，非 runtime 真崩。判据（保守，全部满足才贴，否则落回 crash）：
//   ① state=failed；② exitCrash/backend_error 终态；③ 死前 last run.event 距 run.error
//   ≥120s 静默；④ 死前 ≥3 条 run.event；⑤ 无 run.completed。
// Lead 定的参数：静默阈值 120s、≥3 正常事件、保守（宁漏贴勿误贴）。
// ---------------------------------------------------------------------------

test("TD-74: worker 活跃后静默≥120s 退出 → provider_disconnect（非 crash）", () => {
  // 模拟真实样本：死前多条 run.event（正常干活）+ 末段静默 121s + exit 1
  const events = [
    { type: "run.submitted", agentId: "coder_hq", ts: "2026-06-28T18:40:00.000Z" },
    { type: "run.state_change", to: "running", ts: "2026-06-28T18:40:01.000Z" },
    { type: "run.event", kind: "message", role: "assistant", parts: [], ts: "2026-06-28T18:41:00.000Z" },
    { type: "run.event", kind: "command", command: "ls", ts: "2026-06-28T18:42:00.000Z" },
    { type: "run.event", kind: "command", command: "grep x", ts: "2026-06-28T18:42:30.000Z" },
    { type: "run.event", kind: "message", role: "assistant", parts: [], ts: "2026-06-28T18:42:31.000Z" }, // 末次心跳
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-06-28T18:44:32.000Z" }, // 121s 后
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-28T18:44:32.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "provider_disconnect", "静默≥120s + 死前≥3 事件 → provider 流式中断，非 crash");
  assert.ok(d.evidence.length >= 2, "应给足证据（lastActivityTs/静默秒数/事件数/error）");
  assert.ok(!JSON.stringify(d.evidence).match(/重派|retry|建议/), "证据不得含处方（守 diagnosis 铁律）");
});

test("TD-74 回归: 死前活动密集（静默<120s）→ 仍 crash（不误判 provider_disconnect）", () => {
  // exit 1 但死前 10s 还在跳 → 真崩，不是流式中断
  const events = [
    { type: "run.state_change", to: "running", ts: "2026-06-28T18:40:00.000Z" },
    { type: "run.event", kind: "command", command: "ls", ts: "2026-06-28T18:40:01.000Z" },
    { type: "run.event", kind: "command", command: "ls", ts: "2026-06-28T18:40:02.000Z" },
    { type: "run.event", kind: "command", command: "ls", ts: "2026-06-28T18:44:00.000Z" }, // 末次心跳
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-06-28T18:44:10.000Z" }, // 仅 10s 静默
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-28T18:44:10.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "crash", "静默<120s → 仍 crash（保守，宁漏贴勿误贴）");
});

test("TD-74 回归: 死前<3 事件（启动即崩）→ 仍 crash（排除'刚开始就崩'）", () => {
  // 死前只有 2 条 run.event → 不够 N=3 → 即使静默够长也归 crash
  const events = [
    { type: "run.state_change", to: "running", ts: "2026-06-28T18:40:00.000Z" },
    { type: "run.event", kind: "command", command: "ls", ts: "2026-06-28T18:40:01.000Z" },
    { type: "run.event", kind: "command", command: "ls", ts: "2026-06-28T18:40:02.000Z" }, // 仅 2 条
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-06-28T18:43:00.000Z" }, // 178s 静默
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-28T18:43:00.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "crash", "死前<3 事件 → 仍 crash（启动即崩不判 provider_disconnect）");
});

// ---------------------------------------------------------------------------
// 2026-10-14：zcode 静默收口 → provider_disconnect（+\b401\b 边界）
//
// zcode 车道上游额度窗口用尽时模型流停下来，转录里没有上游的错误或额度信号；
// backend（src/backends/zcode.js）在无生命体征的静默后有界收口，done(failed) 的
// 文案经 run.error(phase:wait) 落转录，以三道门之一开头。此前这类 run 落
// no_effect/crash，且文案里的毫秒读数（401872ms / 14010ms）把 AUTH_SIGNAL 的
// 裸 401 误触发成 provider_auth。契约：
//   - 三种收口文案 → provider_disconnect，证据写明哪一道门 + 上游没发错误或
//     额度信号 + 额度用尽/限流/网络中断在转录内无法区分（只给事实不给处方）；
//   - 真 401（"401 Invalid authentication credentials"）仍 provider_auth；
//   - 带额度错误文本的仍 provider_capacity（新规则排在 auth/config/capacity 后）。
// ---------------------------------------------------------------------------

test("zcode 静默收口: silent_timeout 门文案 → provider_disconnect（非 no_effect）", () => {
  const runId = "run_zcode_closeout_st";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-14T09:00:01.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "initialized", runId, ts: "2026-10-14T09:00:05.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", runId, ts: "2026-10-14T09:00:30.000Z" },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-14T09:15:05.000Z",
      error: "silent timeout: no turn parts observed within 900000ms (provider may have silently rejected) — no vital signs: no model stream chunk observed this turn; no process activity in the last 30s (cpu +1ms/s, io +0B across 3 descendant process(es))",
    },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-14T09:15:05.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "provider_disconnect", "silent_timeout 收口 → 上游流中断");
  assert.equal(d.code, null, "provider_disconnect 不带 code");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /silent_timeout 门/, "证据说明是哪一道门收口");
  assert.match(joined, /无法区分/, "证据如实写额度用尽/限流/网络中断不可区分");
  assert.ok(!JSON.stringify(d.evidence).match(/建议|应该|retry|重派|换\s*worker/), "证据不得含处方");
});

test("zcode 静默收口: zero_part 门（thinking budget）文案 → provider_disconnect", () => {
  const runId = "run_zcode_closeout_zp";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-14T09:00:01.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", runId, ts: "2026-10-14T09:00:30.000Z" },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-14T09:06:00.000Z",
      error: "zcode thinking budget exceeded (no turn parts observed for 120 consecutive polls, silentTimeout absent — bounded exit) — no vital signs: no model stream chunk observed this turn; no file change in the working tree",
    },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-14T09:06:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "provider_disconnect", "zero_part 收口 → 上游流中断（非 budget：那是 token 预算硬闸）");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /zero_part 门/, "证据说明是哪一道门收口");
});

test("zcode 静默收口: stalled 门文案含 401872ms/14010ms 读数 → provider_disconnect，不再误判 provider_auth", () => {
  // 真实形状：文案里的毫秒读数含 "401" 子串——旧裸 /401/ 判成 provider_auth。
  const runId = "run_zcode_closeout_stalled";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-14T09:00:01.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", runId, ts: "2026-10-14T09:01:00.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", runId, ts: "2026-10-14T09:05:00.000Z" },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-14T09:12:00.000Z",
      error: "zcode turn stalled (37 model stream chunk(s) seen this turn, none in the last 60s; no process activity in the last 30s (cpu +0ms/s, io +0B across 2 descendant process(es)); silent stretch 401872ms exceeded adaptive budget 300000ms floor / ×3 / 600000ms ceiling; max recovered gap this turn 14010ms — no vital signs, bounded exit)",
    },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-14T09:12:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "provider_disconnect", "stalled 收口 → 上游流中断");
  assert.notEqual(d.category, "provider_auth", "毫秒读数里的 401 子串不得判成认证失败");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /stalled 门/, "证据说明是哪一道门收口");
  assert.ok(!JSON.stringify(d.evidence).match(/建议|应该|retry|重派|换\s*worker/), "证据不得含处方");
});

test("zcode 静默收口排序: 上游真给了 401 文本 → 仍 provider_auth（新规则不抢）", () => {
  const runId = "run_zcode_closeout_auth";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-14T09:00:01.000Z" },
    { type: "run.error", phase: "wait", error: "401 Invalid authentication credentials", runId, ts: "2026-10-14T09:00:10.000Z" },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-14T09:15:05.000Z",
      error: "silent timeout: no turn parts observed within 900000ms (provider may have silently rejected)",
    },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-14T09:15:05.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "provider_auth", "上游真发了认证错误文本 → provider_auth 先判");
});

test("zcode 静默收口排序: 终态错误带额度文本 → 仍 provider_capacity（额度文本在终态位）", () => {
  // 容量规则按契约要 expectedRunId 绑定（findTerminalProviderError）——与
  // m12-24-providerCapacityTruth.test.js 同形 fixture。
  const runId = "run_zcode_closeout_quota";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-14T09:00:01.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", runId, ts: "2026-10-14T09:00:30.000Z" },
    { type: "run.error", phase: "wait", error: "usage limit reached (5-hour window, resets at 2026-10-14T13:00Z)", runId, ts: "2026-10-14T09:05:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-14T09:05:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "provider_capacity", "上游真发了额度错误文本 → provider_capacity 先判");
  assert.equal(d.code, "quota_exhausted");
});

test("zcode 静默收口排序: 早前瞬时 429 + 终态收口文案 → provider_disconnect（capacity 只读终态位）", () => {
  // 容量规则按契约只消费 failed 终态前最后一条 run.error（需 expectedRunId 绑定）；
  // 早前瞬时 429 不得把静默收口抢成 provider_capacity（capacity 判据的既有
  // terminal-only 设计）。
  const runId = "run_zcode_closeout_429";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-14T09:00:01.000Z" },
    { type: "run.error", phase: "wait", error: "HTTP 429: too many requests (transient, retried)", runId, ts: "2026-10-14T09:00:10.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", runId, ts: "2026-10-14T09:01:00.000Z" },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-14T09:15:05.000Z",
      error: "silent timeout: no turn parts observed within 900000ms (provider may have silently rejected)",
    },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-14T09:15:05.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "provider_disconnect", "终态位是收口文案 → 静默收口判据接管");
});

// ---------------------------------------------------------------------------
// 2026-10-15：zcode 收口文案的上游主轮请求摘要（backend 自本轮起追加）
//
// backend 消费 `v4/telemetry/event` 的 model.request.status（仅本会话、本轮
// turnId、querySource=main_turn），链尾已知时在收口文案末尾追加
// `; upstream: last main-turn request <status> (statusCode N, attempt A/M)`
// （只含闭集 status 与整数，绝不带 reason）。诊断契约：
//   - 摘要只绑定本运行**最后一条** run.error（必须是带摘要的 zcode 收口/失败
//     文案）——较早的带摘要收口不抢其后真终局错误（认证/额度文本）的分类；
//   - 链尾 model_request_failed + statusCode 429 → provider_capacity/rate_limited
//     （单凭 429 不断言额度耗尽）；+ 401/403 → provider_auth/unauthorized。
//     升级排在通用 auth/config/capacity 文本规则与 timeout/budget/scorecard 之后、
//     evidence_passed_backend_failed 之前（真错误文本与既有终局原因先判）；
//     升级时转录里有通过的证据审计 → 补「有产出（证据审计通过），需人工确认」；
//   - 不升级的收口带摘要 → 4.6 槽 provider_disconnect 的「带摘要事实」变体
//     （事实带链尾状态与次数；有产出的运行仍先归 evidence_passed_backend_failed）；
//   - step-finish error 带摘要：链尾 failed/stream_stalled/retry_scheduled →
//     provider_disconnect；链尾 started/completed → 照原路径走、只附中性摘要
//     事实（不断言流中断）；
//   - 通用文本规则对剥掉摘要后的文本匹配——摘要里的 "statusCode 401" 不会被
//     AUTH_SIGNAL 抢走，不靠排序防误抢；
//   - 无摘要的历史文案结论不变（上面的既有用例组即回归钉）。
// ---------------------------------------------------------------------------
function zcodeCloseoutFixture(runId, error) {
  return [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-15T09:00:01.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", runId, ts: "2026-10-15T09:01:00.000Z" },
    { type: "run.error", phase: "wait", error, runId, ts: "2026-10-15T09:12:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-15T09:12:00.000Z" },
  ];
}

// 有产出（file_written + 通过的证据审计）的 zcode 收口运行——升级与 4.6 都不得
// 越过 evidence_passed_backend_failed。
function zcodeEvidenceCloseoutFixture(runId, error) {
  return [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-15T09:00:01.000Z" },
    { type: "run.event", kind: "file_written", runId, ts: "2026-10-15T09:01:00.000Z" },
    { type: "run.evidence_audit", passed: true, runId, ts: "2026-10-15T09:12:00.000Z" },
    { type: "run.error", phase: "wait", error, runId, ts: "2026-10-15T09:12:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-15T09:12:00.000Z" },
  ];
}

test("zcode 上游摘要: 链尾 model_request_failed + statusCode 429 → provider_capacity/rate_limited", () => {
  const runId = "run_zcode_upstream_429";
  const d = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget 300000ms floor / ×3 / 600000ms ceiling — no vital signs, bounded exit); upstream: last main-turn request model_request_failed (statusCode 429, attempt 11/11)",
  ), runId);
  assert.equal(d.category, "provider_capacity", "链尾 failed + 429 → 限流类");
  assert.equal(d.code, "rate_limited", "单凭 429 不断言额度耗尽");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /model_request_failed/);
  assert.match(joined, /statusCode 429/);
  assert.match(joined, /attempt 11\/11/);
  assert.match(joined, /不能断言额度耗尽/);
  assert.ok(!JSON.stringify(d.evidence).match(/建议|应该|重派|换\s*worker/), "证据不得含处方");
});

test("zcode 上游摘要: 链尾 model_request_failed + statusCode 401 → provider_auth/unauthorized", () => {
  const runId = "run_zcode_upstream_401";
  const d = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "silent timeout: no turn parts observed within 900000ms (provider may have silently rejected); upstream: last main-turn request model_request_failed (statusCode 401, attempt 2/11)",
  ), runId);
  assert.equal(d.category, "provider_auth", "链尾 failed + 401 → 认证类");
  assert.equal(d.code, "unauthorized", "闭集兜底码——摘要里没有更具体的拒绝形状，不猜密钥/订阅/组织策略");
  assert.ok(!JSON.stringify(d.evidence).includes("api_key"), "不一概说成密钥错误");
});

test("zcode 上游摘要: 链尾 retry_scheduled → provider_disconnect，事实带最后状态与次数", () => {
  const runId = "run_zcode_upstream_retry";
  const d = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget 300000ms floor / ×3 / 600000ms ceiling — no vital signs, bounded exit); upstream: last main-turn request model_retry_scheduled (statusCode 429, attempt 6/11)",
  ), runId);
  assert.equal(d.category, "provider_disconnect", "重试安排不是终局失败——仍归流中断");
  assert.equal(d.code, null);
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /最后状态 model_retry_scheduled/, "事实带链尾状态");
  assert.match(joined, /attempt 6\/11/);
  assert.match(joined, /stalled 门/, "门事实保留");
  assert.notEqual(d.category, "provider_capacity", "退避中的 429 不是终局限流");
});

test("zcode 上游摘要: 已恢复链（链尾 completed）→ provider_disconnect，失败不当根因", () => {
  const runId = "run_zcode_upstream_recovered";
  const d = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget 300000ms floor / ×3 / 600000ms ceiling — no vital signs, bounded exit); upstream: last main-turn request model_request_completed (attempt 2/11)",
  ), runId);
  assert.equal(d.category, "provider_disconnect", "失败后重试成功再静默——照旧归流中断");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /最后状态 model_request_completed/);
  assert.match(joined, /已恢复/, "事实写明失败已恢复、不当根因");
});

test("zcode 上游摘要: zcode 以失败结束本轮的文案带摘要 → 同款归类（step-finish error 路径）", () => {
  const runId = "run_zcode_upstream_turnfailed";
  const d = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "zcode turn failed (step-finish reason error; no verified error detail on this part — refusing to invent one); upstream: last main-turn request model_request_failed (statusCode 429, attempt 11/11)",
  ), runId);
  assert.equal(d.category, "provider_capacity", "失败结束本轮的路径同样按摘要升级");
  assert.equal(d.code, "rate_limited");
});

test("zcode 上游摘要排序: 链尾非 failed 但摘要含 statusCode 401 → 不误判 provider_auth（剥离匹配）", () => {
  // 摘要里 "statusCode 401" 的裸 401 会被 AUTH_SIGNAL 抢走；通用文本规则对剥掉
  // 摘要后的文本匹配，按链尾（retry_scheduled，非终局）归 provider_disconnect。
  const runId = "run_zcode_upstream_401_notfailed";
  const d = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget 300000ms floor / ×3 / 600000ms ceiling — no vital signs, bounded exit); upstream: last main-turn request model_retry_scheduled (statusCode 401, attempt 4/11)",
  ), runId);
  assert.equal(d.category, "provider_disconnect", "链尾非 failed：statusCode 401 不构成认证根因");
  assert.notEqual(d.category, "provider_auth");
});

test("zcode 上游摘要排序: 转录里另有真 401 文本 → 仍 provider_auth（新规则不抢真错误文本）", () => {
  const runId = "run_zcode_upstream_real401";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-15T09:00:01.000Z" },
    { type: "run.error", phase: "wait", error: "401 Invalid authentication credentials", runId, ts: "2026-10-15T09:00:10.000Z" },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-15T09:15:05.000Z",
      error: "silent timeout: no turn parts observed within 900000ms (provider may have silently rejected); upstream: last main-turn request model_retry_scheduled (statusCode 429, attempt 4/11)",
    },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-15T09:15:05.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "provider_auth", "上游真发了认证错误文本 → 真文本规则先判");
});

test("zcode 上游摘要边界: 毫秒读数 401872ms + 摘要 statusCode 503 → provider_disconnect（读数与状态码互不误触发）", () => {
  const runId = "run_zcode_upstream_503";
  const d = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "zcode turn stalled (12 model stream chunk(s) seen this turn, none in the last 60s; process activity unavailable; silent stretch 401872ms exceeded adaptive budget 300000ms floor / ×3 / 600000ms ceiling; max recovered gap this turn 14010ms — no vital signs, bounded exit); upstream: last main-turn request model_request_failed (statusCode 503, attempt 5/11)",
  ), runId);
  assert.equal(d.category, "provider_disconnect", "503 不在认证/限流闭集 → 仍归流中断；401872ms 不触发认证");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /statusCode 503/, "事实如实带状态码");
});

test("zcode 上游摘要边界: 解析不出的伪摘要（闭集外 status / 越界状态码）当作没有摘要", () => {
  const runId = "run_zcode_upstream_garbage";
  const bad1 = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget — no vital signs, bounded exit); upstream: last main-turn request model_request_exploded (statusCode 429, attempt 1/11)",
  ), runId);
  assert.equal(bad1.category, "provider_disconnect", "闭集外 status → 无摘要路径");
  assert.ok(!bad1.evidence.some((e) => e.fact.includes("model_request_exploded")), "闭集外值不进事实");

  const bad2 = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget — no vital signs, bounded exit); upstream: last main-turn request model_request_failed (statusCode 99999, attempt 1/11)",
  ), runId);
  assert.equal(bad2.category, "provider_disconnect", "越界 statusCode → 无摘要路径");
});

// ---------------------------------------------------------------------------
// 会审修正（consult_202610151937394754iihpu sol/opus）：不升级的摘要分支回到
// 4.6 槽——有产出的运行不再被带 completed / failed-500 摘要的收口抢成
// provider_disconnect；摘要只绑定最后一条 run.error；升级时补「有产出」事实。
// ---------------------------------------------------------------------------
test("zcode 上游摘要×证据: evidence_audit passed + completed 摘要 → 仍归 evidence_passed_backend_failed（非 provider_disconnect）", () => {
  const runId = "run_zcode_upstream_ev_completed";
  const d = diagnoseFailure(zcodeEvidenceCloseoutFixture(
    runId,
    "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget 300000ms floor / ×3 / 600000ms ceiling — no vital signs, bounded exit); upstream: last main-turn request model_request_completed (attempt 2/11)",
  ), runId);
  assert.equal(d.category, "evidence_passed_backend_failed", "有产出的运行：摘要（链尾 completed，不升级）不得越过证据审计槽");
  assert.notEqual(d.category, "provider_disconnect");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /最后状态 model_request_completed/, "中性摘要事实附在结论里（只陈述链尾，不断言流中断）");
});

test("zcode 上游摘要×证据: evidence_audit passed + failed 500 摘要 → 仍归 evidence_passed_backend_failed", () => {
  const runId = "run_zcode_upstream_ev_500";
  const d = diagnoseFailure(zcodeEvidenceCloseoutFixture(
    runId,
    "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget 300000ms floor / ×3 / 600000ms ceiling — no vital signs, bounded exit); upstream: last main-turn request model_request_failed (statusCode 500, attempt 3/11)",
  ), runId);
  assert.equal(d.category, "evidence_passed_backend_failed", "500 不在升级闭集——有产出的运行仍归证据审计槽");
  assert.notEqual(d.category, "provider_disconnect");
});

test("zcode 上游摘要×证据: failed 429 摘要升级 provider_capacity，且证据里有「有产出」静态事实", () => {
  const runId = "run_zcode_upstream_ev_429";
  const d = diagnoseFailure(zcodeEvidenceCloseoutFixture(
    runId,
    "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget 300000ms floor / ×3 / 600000ms ceiling — no vital signs, bounded exit); upstream: last main-turn request model_request_failed (statusCode 429, attempt 11/11)",
  ), runId);
  assert.equal(d.category, "provider_capacity", "链尾 failed + 429 升级先于证据审计槽");
  assert.equal(d.code, "rate_limited");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /有产出（证据审计通过），需人工确认/, "升级不吞掉产出事实");
});

test("zcode 上游摘要×step-finish: 链尾 completed（请求已完成、轮次却失败）→ 不归 provider_disconnect，照原路径走", () => {
  const runId = "run_zcode_upstream_tf_completed";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-15T09:00:01.000Z" },
    { type: "run.event", kind: "tool_use", runId, ts: "2026-10-15T09:01:00.000Z" },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-15T09:12:00.000Z",
      error: "zcode turn failed (step-finish reason error; no verified error detail on this part — refusing to invent one); upstream: last main-turn request model_request_completed (attempt 2/11)",
    },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-15T09:12:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.notEqual(d.category, "provider_disconnect", "请求已成功完成、轮次却失败——不虚构流中断");
  assert.equal(d.category, "no_effect", "照原路径走（有 tool_use 活动、无产出）");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /最后状态 model_request_completed/, "只附中性摘要事实");
});

test("zcode 上游摘要×step-finish: 链尾 stream_stalled → 仍归 provider_disconnect（轮次失败且请求未成功完成）", () => {
  const runId = "run_zcode_upstream_tf_stalled";
  const d = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "zcode turn failed (step-finish reason error; no verified error detail on this part — refusing to invent one); upstream: last main-turn request model_stream_stalled (attempt 3/11)",
  ), runId);
  assert.equal(d.category, "provider_disconnect", "流停滞 + 轮次失败——流中断归因成立");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /zcode 以失败结束本轮/, "事实写明 step-finish error 路径");
  assert.match(joined, /最后状态 model_stream_stalled/, "事实带链尾状态");
});

test("zcode 上游摘要×绑定: 较早的带 completed 摘要收口 + 终局 provider quota exhausted → provider_capacity", () => {
  const runId = "run_zcode_upstream_lastbind";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-15T09:00:01.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", runId, ts: "2026-10-15T09:01:00.000Z" },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-15T09:05:00.000Z",
      error: "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget — no vital signs, bounded exit); upstream: last main-turn request model_request_completed (attempt 2/11)",
    },
    { type: "run.error", phase: "wait", error: "provider quota exhausted", runId, ts: "2026-10-15T09:12:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-15T09:12:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "provider_capacity", "摘要只绑定最后一条 run.error——终局额度文本先判");
  assert.equal(d.code, "quota_exhausted");
});

test("zcode 上游摘要×绑定: 较早的带 completed 摘要收口 + 终局进程退出 → 与只有终局错误时同归 crash", () => {
  const runId = "run_zcode_upstream_lastbind_exit";
  const head = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-15T09:00:01.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", runId, ts: "2026-10-15T09:01:00.000Z" },
  ];
  const earlierCloseout = {
    type: "run.error", phase: "wait", runId, ts: "2026-10-15T09:05:00.000Z",
    error: "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget — no vital signs, bounded exit); upstream: last main-turn request model_request_completed (attempt 2/11)",
  };
  const tail = [
    { type: "run.error", phase: "wait", error: "process exited with code 1", runId, ts: "2026-10-15T09:12:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-15T09:12:00.000Z" },
  ];
  assert.equal(diagnoseFailure([...head, ...tail], runId).category, "crash", "只有终局错误时归 crash");
  const d = diagnoseFailure([...head, earlierCloseout, ...tail], runId);
  assert.equal(d.category, "crash", "较早的收口不抢终局进程退出的分类");
  assert.ok(!d.evidence.some((e) => /上游主轮请求摘要/.test(e.fact)), "较早收口的摘要不进证据");
});

test("zcode 上游摘要×绑定: 较早的收口 + 终局 step-finish error（链尾 completed）→ 不虚构流中断，照原路径走", () => {
  const runId = "run_zcode_upstream_lastbind_tf";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-15T09:00:01.000Z" },
    { type: "run.event", kind: "tool_use", runId, ts: "2026-10-15T09:01:00.000Z" },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-15T09:05:00.000Z",
      error: "zcode turn stalled (no model stream chunk observed this turn; process activity unavailable; silent stretch 480000ms exceeded adaptive budget — no vital signs, bounded exit); upstream: last main-turn request model_request_failed (statusCode 500, attempt 3/11)",
    },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-15T09:12:00.000Z",
      error: "zcode turn failed (step-finish reason error; no verified error detail on this part — refusing to invent one); upstream: last main-turn request model_request_completed (attempt 4/11)",
    },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-15T09:12:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.notEqual(d.category, "provider_disconnect", "终局是请求已完成、轮次却失败——不因较早的收口虚构流中断");
  assert.equal(d.category, "no_effect", "照原路径走（有 tool_use 活动、无产出）");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /最后状态 model_request_completed（attempt 4\/11）/, "只附终局错误的中性摘要事实");
  assert.doesNotMatch(joined, /statusCode 500/, "较早收口的摘要不进证据");
});

test("kimi-web 收口×绑定: 较早的收口 + 终局进程退出 → 与只有终局错误时同归 crash", () => {
  const runId = "run_kimi_closeout_lastbind_exit";
  const head = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-15T09:00:01.000Z" },
  ];
  const earlierCloseout = {
    type: "run.error", phase: "wait", runId, ts: "2026-10-15T09:05:00.000Z",
    error: "silent timeout: turn for this prompt not observed within 120000ms",
  };
  const tail = [
    { type: "run.error", phase: "wait", error: "process exited with code 1", runId, ts: "2026-10-15T09:12:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-15T09:12:00.000Z" },
  ];
  assert.equal(diagnoseFailure([...head, ...tail], runId).category, "crash", "只有终局错误时归 crash");
  assert.equal(diagnoseFailure([...head, earlierCloseout, ...tail], runId).category, "crash", "较早的收口不抢终局进程退出的分类");
  assert.equal(diagnoseFailure([...head, earlierCloseout, tail[1]], runId).category, "provider_disconnect", "收口是最后一条 run.error 时照旧按门表归类");
});

test("zcode 上游摘要×剥离: 标记子串之后不是合法摘要时原文不动——真实认证信号照常归 provider_auth", () => {
  const runId = "run_zcode_upstream_strip_invalid";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-15T09:00:01.000Z" },
    { type: "run.error", phase: "wait", error: "provider error; upstream: last main-turn request invalid response; HTTP 401 unauthorized", runId, ts: "2026-10-15T09:12:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-15T09:12:00.000Z" },
  ];
  assert.equal(diagnoseFailure(events, runId).category, "provider_auth", "不是合法摘要——401 unauthorized 仍是上游错误文本");
});

test("zcode 上游摘要×剥离: 链尾 completed 且摘要含 statusCode 401 → AUTH_SIGNAL 不抢分类", () => {
  const runId = "run_zcode_upstream_401_completed";
  const d = diagnoseFailure(zcodeCloseoutFixture(
    runId,
    "silent timeout: no turn parts observed within 900000ms (provider may have silently rejected); upstream: last main-turn request model_request_completed (statusCode 401, attempt 2/11)",
  ), runId);
  assert.notEqual(d.category, "provider_auth", "摘要里的 401 是控制面投影，不是上游认证错误文本");
  assert.equal(d.category, "provider_disconnect", "剥离后按门表归流中断");
});

test("401 边界: 读数里的 401 子串（非独立 401）不触发 provider_auth", () => {
  const events = [
    { type: "run.state_change", to: "running", ts: "2026-10-14T09:00:00.000Z" },
    { type: "run.error", phase: "wait", error: "stream stalled after 401872ms of silence, kimi serve envelope code 40401", ts: "2026-10-14T09:07:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-10-14T09:07:00.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.notEqual(d.category, "provider_auth", "401872ms / 40401 里的 401 子串不是独立 401");
});

test("401 边界: 真实样本 401 Invalid authentication credentials 仍判 provider_auth", () => {
  const events = [
    { type: "run.state_change", to: "running", ts: "2026-10-14T09:00:00.000Z" },
    { type: "run.error", phase: "wait", error: "401 Invalid authentication credentials", ts: "2026-10-14T09:00:05.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-10-14T09:00:05.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "provider_auth", "独立的 401 + 认证凭据文本 → provider_auth");
});

test("C2: 配置冲突（API key 与 claude.ai 登录打架）→ config_conflict（非 provider_auth）", () => {
  // B 冒烟真实样本：run_20260625083928248mlo78b
  // 关键：含 "auth"/"API_KEY" 但不是 401 认证失败，是配置层冲突
  const events = [
    { type: "run.error", phase: "wait", error: "process exited with code 1; stderr: ⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login · Unset it to load your organization's connectors", ts: "2026-06-26T10:00:05.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-26T10:00:05.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "config_conflict", "配置冲突（precedence/connectors/auth source）应归 config_conflict，非 provider_auth");
  assert.ok(d.evidence.length > 0);
});

test("C2 回归: 真正的 401 仍归 provider_auth（AUTH_SIGNAL 收紧后不漏）", () => {
  // 收紧 AUTH_SIGNAL 后，真 401/身份验证失败/unauthor/invalid key 仍须命中 provider_auth
  const cases = [
    "Error: 401 Unauthorized",
    "[401] 身份验证失败",
    "unauthorized: invalid api key",
    "invalid API key",
  ];
  for (const err of cases) {
    const events = [
      { type: "run.error", phase: "wait", error: err, ts: "2026-06-26T10:00:05.000Z" },
      { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-26T10:00:05.000Z" },
    ];
    const d = diagnoseFailure(events);
    assert.equal(d.category, "provider_auth", `真 auth 失败 "${err}" 收紧后仍应归 provider_auth`);
  }
});

test("C2 回归: 配置冲突措辞不误判为 provider_auth（AUTH_SIGNAL 不含 precedence/connectors）", () => {
  // 宽泛的 "auth source"/"precedence"/"connectors" 不该触发 provider_auth
  const events = [
    { type: "run.error", phase: "wait", error: "another auth source takes precedence", ts: "2026-06-26T10:00:05.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-26T10:00:05.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.notEqual(d.category, "provider_auth", "宽泛 auth 措辞不该误判 provider_auth");
});

test("M8-3: 信号不足 → unknown（不强归类）", () => {
  const events = [
    { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-26T10:01:00.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "unknown", "无明确信号 → unknown，不强归类");
});

// ---------------------------------------------------------------------------
// 🔵 铁律：绝不输出建议/处方（处方权留 Lead）
// ---------------------------------------------------------------------------

test("M8-3 铁律: 返回结构无 recommendation 字段（处方权留 Lead）", () => {
  const events = [
    { type: "run.error", phase: "wait", error: "[401] 身份验证失败", ts: "2026-06-26T10:00:05.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-26T10:00:05.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.recommendation, undefined, "诊断结构不得有 recommendation 字段");
  assert.equal(d.suggestedAction, undefined, "不得有 suggestedAction 字段");
  assert.equal(d.advice, undefined, "不得有 advice 字段");
});

test("M8-3 铁律: 任何字符串字段不含 建议/应该/重试/换worker 措辞", () => {
  // 覆盖各类别的样本，全部扫描字符串字段
  const samples = [
    [{ type: "run.error", phase: "wait", error: "[401] 身份验证失败" }, { type: "run.state_change", to: "failed", reason: "backend_error" }],
    [{ type: "run.timed_out" }, { type: "run.state_change", to: "timed_out", reason: "timeout" }],
    [{ type: "scorecard.checked", passed: false, checks: [{ name: "hasEvidence", passed: false }] }, { type: "run.error", phase: "scorecard", detail: "x" }],
    [{ type: "run.error", phase: "spawn", error: "crash" }],
    [{ type: "run.error", phase: "wait", error: "process exited with code 143" }, { type: "run.state_change", to: "failed", reason: "backend_error" }], // C1 crash
    [{ type: "run.error", phase: "wait", error: "ANTHROPIC_API_KEY takes precedence" }, { type: "run.state_change", to: "failed", reason: "backend_error" }], // C2 config_conflict
  ];
  for (const events of samples) {
    const d = diagnoseFailure(events);
    const allText = JSON.stringify(d);
    assert.doesNotMatch(allText, /建议/, `类别 ${d.category} 输出含"建议"`);
    assert.doesNotMatch(allText, /应该/, `类别 ${d.category} 输出含"应该"`);
    assert.doesNotMatch(allText, /重试/, `类别 ${d.category} 输出含"重试"`);
    assert.doesNotMatch(allText, /换\s*worker|换人/, `类别 ${d.category} 输出含"换worker/换人"`);
  }
});

// ---------------------------------------------------------------------------
// 空输入 / 成功 run（非失败 run）
// ---------------------------------------------------------------------------

test("M8-3: 空 events → category=unknown 不崩", () => {
  const d = diagnoseFailure([]);
  assert.equal(d.category, "unknown");
  assert.ok(Array.isArray(d.evidence));
});

test("M8-3: 成功 run（无失败信号）→ category=none（诊断目标不存在）", () => {
  const events = [
    { type: "run.submitted", agentId: "a", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.state_change", to: "completed", reason: "done", ts: "2026-06-26T10:01:00.000Z" },
    { type: "scorecard.checked", passed: true, checks: [], ts: "2026-06-26T10:01:00.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "none", "成功 run 无需诊断 → category=none");
});

// ---------------------------------------------------------------------------
// TD-95 #4/#5 新增分类（复盘真实任务）
// ---------------------------------------------------------------------------

test("TD-95 #5: failed run + evidence_audit passed → category=evidence_passed_backend_failed", () => {
  // 复盘 #5：worker 写了文件 + 跑了测试，但 backend 进程崩了。
  // B2 已在 runManager 写 run.evidence_audit {passed:true}。diagnosis 应识别此信号。
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-07-08T10:00:00.000Z" },
    { type: "run.event", kind: "file_written", path: "src/foo.js", ts: "2026-07-08T10:01:00.000Z" },
    { type: "run.event", kind: "command", command: "node test.js", exitCode: 0, ts: "2026-07-08T10:01:05.000Z" },
    { type: "run.evidence_audit", passed: true, note: "backend failed but evidence passed", ts: "2026-07-08T10:01:10.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-08T10:01:10.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-08T10:01:11.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "evidence_passed_backend_failed",
    "failed run 但证据通过应识别为 evidence_passed_backend_failed（让 Lead 知道任务可能做对了）");
  assert.ok(d.evidence.length > 0, "应附证据");
});

test("TD-95 #4: failed run + 无 file_written + 无 command exit0 → category=no_effect", () => {
  // 复盘 #4：coder_hq 读了上下文但没写任何文件，backend 崩了 → "读完没产出"。
  // 审计修正：transcript 实际把 message 落为 run.event kind=message（不是 run.message）。
  // M9-5P：timestamp 间隔 <120s 静默，避免满足 provider_disconnect 严格签名。
  const events = [
    { type: "run.submitted", agentId: "coder_hq", ts: "2026-07-08T10:00:00.000Z" },
    { type: "run.event", kind: "tool_use", name: "Read", ts: "2026-07-08T10:00:30.000Z" },
    { type: "run.event", kind: "tool_result", isError: false, ts: "2026-07-08T10:00:31.000Z" },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "reading..." }], ts: "2026-07-08T10:01:00.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-08T10:02:30.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-08T10:02:31.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "no_effect",
    "failed run 无产出证据应识别为 no_effect（读完没写文件/没跑成功命令）");
  assert.ok(d.evidence.length > 0, "应附证据");
});

test("审计 P2: failed run 只有 assistant text（无 tool_use）→ 仍应识别 no_effect", () => {
  // 审计发现：diagnosis 原查 run.message（不存在的事件类型），实际是 run.event kind=message。
  // 只有 assistant text 没有 tool_use 的 failed run 应仍判 no_effect（有活动但无产出）。
  const events = [
    { type: "run.submitted", agentId: "coder_hq", ts: "2026-07-08T10:00:00.000Z" },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "let me read the files first" }], ts: "2026-07-08T10:00:30.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-08T10:05:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-08T10:05:01.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "no_effect",
    "有 assistant text 活动但无产出的 failed run 应判 no_effect（不是 crash）");
});

// ---------------------------------------------------------------------------
// M9-5P：provider_disconnect 优先级修复。
//
// 真实样本 run_202607082124125368q0r9t（脱敏提取）：worker 有 14 条活动事件
// （tool_use/tool_result/message/command），无 file_written、无 command exit0，
// 末段静默 266s 后 exit 1。当前被 no_effect 抢先误判（no_effect 在 provider_disconnect
// 之前 return）。修复后严格 provider_disconnect 签名应优先。
//
// 回归矩阵：
//   1. 本 fixture（266s 静默 + 有活动无产出）：no_effect → provider_disconnect
//   2. 22s 静默样本（run_2026062818401405116u1yd 外形）：仍为 no_effect（不满足 120s）
//   3. 现有普通 no_effect fixture：仍为 no_effect
//   4. evidence_passed_backend_failed 同时满足断流外形时仍由更高优先级赢
// ---------------------------------------------------------------------------

test("M9-5P: provider_disconnect 优先于 no_effect（真实脱敏 fixture，266s 静默）", () => {
  // 从 run_202607082124125368q0r9t 脱敏提取：保留事件类型、顺序、timestamp 间隔、
  // 活动数量、退出码。去掉 prompt、路径、命令正文、tool input/output、凭据。
  const events = [
    { type: "run.started", ts: "2026-07-08T21:24:12.538Z", runId: "run_m95p", agentId: "w" },
    { type: "run.state_change", to: "pending", ts: "2026-07-08T21:24:12.539Z", runId: "run_m95p", agentId: "w" },
    { type: "session.created", backend: "claude-code", backendSessionId: "proc_redacted", ts: "2026-07-08T21:24:12.665Z", runId: "run_m95p", agentId: "w" },
    { type: "run.state_change", to: "running", ts: "2026-07-08T21:24:20.700Z", runId: "run_m95p", agentId: "w" },
    // 14 run.event（tool_use/tool_result/message/command）— 有活动但无 file_written/exit0
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "redacted" }], ts: "2026-07-08T21:24:20.703Z", runId: "run_m95p", agentId: "w" },
    { type: "run.event", kind: "tool_use", tool: "Read", input: {}, ts: "2026-07-08T21:24:20.708Z", runId: "run_m95p", agentId: "w" },
    { type: "run.event", kind: "tool_result", tool: "Read", output: "redacted", ts: "2026-07-08T21:24:20.716Z", runId: "run_m95p", agentId: "w" },
    { type: "run.event", kind: "tool_use", tool: "Read", input: {}, ts: "2026-07-08T21:24:20.917Z", runId: "run_m95p", agentId: "w" },
    { type: "run.event", kind: "tool_result", tool: "Read", output: "redacted", ts: "2026-07-08T21:24:20.921Z", runId: "run_m95p", agentId: "w" },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "redacted" }], ts: "2026-07-08T21:24:31.098Z", runId: "run_m95p", agentId: "w" },
    { type: "run.event", kind: "tool_use", tool: "Edit", input: {}, ts: "2026-07-08T21:24:31.105Z", runId: "run_m95p", agentId: "w" },
    { type: "run.event", kind: "tool_result", tool: "Edit", output: "redacted", ts: "2026-07-08T21:24:31.106Z", runId: "run_m95p", agentId: "w" },
    { type: "run.event", kind: "command", command: "redacted", ts: "2026-07-08T21:24:31.671Z", runId: "run_m95p", agentId: "w" },
    { type: "run.event", kind: "tool_result", tool: "Bash", output: "redacted", ts: "2026-07-08T21:24:47.155Z", runId: "run_m95p", agentId: "w" },
    // 末段静默 266s 后 exit 1
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-08T21:29:13.184Z", runId: "run_m95p", agentId: "w" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-07-08T21:29:13.186Z", runId: "run_m95p", agentId: "w" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "provider_disconnect",
    "严格 provider_disconnect 签名（≥3 events + ≥120s 静默 + exit crash）优先于 no_effect");
  assert.ok(d.evidence.length >= 2, "provider_disconnect 证据完整");
  // evidence event types 与现有严格规则一致
  const types = d.evidence.map((e) => e.eventType);
  assert.ok(types.includes("run.event"), "evidence 含 run.event（lastActivity）");
  assert.ok(types.includes("run.error"), "evidence 含 run.error（exit crash）");
});

test("M9-5P 回归: 22s 静默 + 有活动无产出 → 仍 no_effect（不满足 120s 阈值）", () => {
  // run_2026062818401405116u1yd 外形：有活动无产出，但静默只有 22s < 120s。
  // provider_disconnect 严格签名不满足 → 仍应走 no_effect。
  const events = [
    { type: "run.state_change", to: "running", ts: "2026-06-28T18:40:00.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "tool_use", tool: "Read", input: {}, ts: "2026-06-28T18:44:50.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "tool_result", tool: "Read", output: "x", ts: "2026-06-28T18:44:51.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "tool_use", tool: "Read", input: {}, ts: "2026-06-28T18:44:52.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "tool_result", tool: "Read", output: "x", ts: "2026-06-28T18:44:53.000Z", runId: "r", agentId: "w" },
    // 22s 静默后 exit 1
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-06-28T18:45:15.000Z", runId: "r", agentId: "w" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-06-28T18:45:15.000Z", runId: "r", agentId: "w" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "no_effect",
    "22s 静默 < 120s 阈值 → provider_disconnect 签名不满足 → 仍 no_effect");
});

test("M9-5P 回归: evidence_passed_backend_failed 同时满足断流外形 → 仍 evidence_passed_backend_failed", () => {
  // 有 evidence_audit passed + ≥3 events + ≥120s 静默 + exit crash。
  // evidence_passed_backend_failed 优先级必须高于 provider_disconnect 和 no_effect。
  const events = [
    { type: "run.state_change", to: "running", ts: "2026-07-14T00:00:00.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "tool_use", tool: "X", input: {}, ts: "2026-07-14T00:01:00.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "tool_result", tool: "X", output: "y", ts: "2026-07-14T00:01:01.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "tool_use", tool: "Y", input: {}, ts: "2026-07-14T00:01:02.000Z", runId: "r", agentId: "w" },
    { type: "run.evidence_audit", passed: true, ts: "2026-07-14T00:02:00.000Z", runId: "r", agentId: "w" },
    // ≥120s 静默后 exit crash
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-14T00:05:00.000Z", runId: "r", agentId: "w" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-07-14T00:05:00.000Z", runId: "r", agentId: "w" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "evidence_passed_backend_failed",
    "evidence_passed_backend_failed 优先于 provider_disconnect 和 no_effect");
});

test("审计 P2 fixture: 真实脱敏 transcript → evidence_passed_backend_failed（现场回放验证）", async () => {
  // 审计要求：涉及外部系统的功能不能只靠 mock，需真实 fixture 回放。
  // 本 fixture 从真实任务 run_20260708212945430tnnchx（coder_low，复盘 #5 状态悖论案例）
  // 脱敏提取：worker 写了文件 + 测试输出 OK，但 backend 进程 exit 1 → WAO 终态 failed。
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "transcript-evidence-passed-backend-failed.jsonl");
  const raw = readFileSync(fixturePath, "utf8");
  const events = raw.trim().split("\n").map((l) => JSON.parse(l));
  const d = diagnoseFailure(events);
  assert.equal(d.category, "evidence_passed_backend_failed",
    "真实脱敏 transcript 应诊断为 evidence_passed_backend_failed（不是 crash/provider_disconnect）");
  assert.ok(d.evidence.length > 0, "应附证据");
  assert.ok(d.evidence.some((e) => e.fact.includes("证据通过")),
    "证据应说明'证据通过'——让 Lead 知道任务可能做对了");
});

// ---------------------------------------------------------------------------
// TD-80：legacy transcript（无 run.evidence_audit）证据提升。
//
// 背景：TD-95 之后 runManager 才在 failed 路径写 run.evidence_audit。此前的历史
// transcript（如 run_20260702142549160dfqmrt：worker 命令轮询有产出，backend 却
// 非零退出）没有 audit 事件——原诊断把这类 run 归 crash，Lead 无法把结果当
// clean pass/fail。修复：无 audit 时复用 assessRunEvidence（同一 SSOT）重建证据，
// 仅当 hasFileWritten || hasCommandExit0 才提升为 evidence_passed_backend_failed。
//
// 铁律（fail-closed）：
//   1. 只要存在任意 run.evidence_audit 事件，audit 就是唯一权威——显式
//      passed:false（或畸形值）绝不被重建的原始证据推翻。
//   2. 仅 assistant text / tool_use 活动不构成"证据通过"，不得提升。
//   3. 优先级不变：provider_auth/config/timeout/budget/scorecard 仍先于提升判；
//      提升仍先于 provider_disconnect/no_effect/crash。
//   4. 终态 truthfulness 不变：state=failed 就是 failed，不加新 category。
// ---------------------------------------------------------------------------

test("TD-80: legacy failed run（无 audit）+ file_written → evidence_passed_backend_failed（不是 crash）", () => {
  // 历史 transcript 形状：有 file_written，无 run.evidence_audit，backend exit 1。
  // 旧行为：no_effect 不适用（有 file_written）→ 被 crash 抢归。
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-07-02T10:00:00.000Z" },
    { type: "run.event", kind: "file_written", path: "src/foo.js", ts: "2026-07-02T10:01:00.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-02T10:02:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-02T10:02:01.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "evidence_passed_backend_failed",
    "legacy failed run 含成功文件证据应提升为 evidence_passed_backend_failed（不是 crash）");
  assert.ok(d.evidence.some((e) => e.fact.includes("证据通过")), "证据应说明'证据通过'");
  assert.ok(d.evidence.some((e) => e.fact.includes("1 个文件写入")), "事实应含 SSOT 文件写入计数");
  // 不暴露原始路径/命令。
  assert.ok(!JSON.stringify(d.evidence).includes("src/foo.js"), "证据不得回显原始 path");
});

test("TD-80: legacy failed run（无 audit）+ command exit0 → evidence_passed_backend_failed（不是 crash）", () => {
  // run_20260702142549160dfqmrt 形状：命令轮询正常产出（exitCode 0），backend 非零退出。
  // 只有 command exit0 证据（无 file_written）也应提升。
  const events = [
    { type: "run.submitted", agentId: "tester", ts: "2026-07-02T14:25:49.000Z" },
    { type: "run.event", kind: "command", command: "gh run view --redacted", exitCode: 0, ts: "2026-07-02T14:25:52.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-02T14:26:40.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-02T14:26:40.100Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "evidence_passed_backend_failed",
    "legacy failed run 含成功命令证据应提升为 evidence_passed_backend_failed（不是 crash）");
  assert.ok(d.evidence.some((e) => e.fact.includes("1 个命令 exit0")), "事实应含 SSOT 命令 exit0 计数");
  // 不暴露原始命令/路径/transcript 文本。
  const blob = JSON.stringify(d.evidence);
  assert.ok(!blob.includes("gh run view"), "证据不得回显原始 command");
});

test("TD-80 guard: legacy failed run 只有 assistant text（无 file/command）→ 仍 no_effect，不提升", () => {
  // 只有 assistant text 是"活动"不是"证据通过"——不得提升为 evidence_passed_backend_failed。
  const events = [
    { type: "run.submitted", agentId: "coder_hq", ts: "2026-07-02T10:00:00.000Z" },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "let me read the files first" }], ts: "2026-07-02T10:00:30.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-02T10:05:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-02T10:05:01.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "no_effect", "assistant text 单独不构成证据通过 → 仍 no_effect");
  assert.notEqual(d.category, "evidence_passed_backend_failed", "不得仅凭 assistant text 提升");
});

test("TD-80 guard: legacy failed run 只有 tool_use 活动（无 file/command exit0）→ 仍 no_effect，不提升", () => {
  // tool_use/tool_result 是活动证据，不是"通过"证据（无 file_written + 无 command exit0）。
  const events = [
    { type: "run.submitted", agentId: "coder_hq", ts: "2026-07-02T10:00:00.000Z" },
    { type: "run.event", kind: "tool_use", name: "Read", ts: "2026-07-02T10:00:30.000Z" },
    { type: "run.event", kind: "tool_result", isError: false, ts: "2026-07-02T10:00:31.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-02T10:02:30.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-02T10:02:31.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "no_effect", "tool_use 活动单独不构成证据通过 → 仍 no_effect");
  assert.notEqual(d.category, "evidence_passed_backend_failed", "不得仅凭 tool_use 提升");
});

test("TD-80 guard: 显式 audit passed:false + 原始 file 证据 → audit 权威，不被重建证据推翻（仍 crash）", () => {
  // 只要存在 run.evidence_audit，audit 就是唯一权威。显式 passed:false 绝不能被
  // 重建的 file_written 证据覆盖——即使原始证据看起来"通过了"。
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-07-08T10:00:00.000Z" },
    { type: "run.event", kind: "file_written", path: "src/foo.js", ts: "2026-07-08T10:01:00.000Z" },
    { type: "run.evidence_audit", passed: false, note: "evidence audit rejected", ts: "2026-07-08T10:01:10.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-08T10:02:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-08T10:02:01.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "crash",
    "显式 audit passed:false 是权威——原始 file 证据不得把 crash 提升为 evidence_passed_backend_failed");
});

test("TD-80 guard: 畸形 audit（passed 非布尔）+ 原始 file 证据 → audit 权威，不回退重建 → 仍 crash", () => {
  // "ANY audit exists" 即权威：畸形 audit 也不得触发重建提升（fail-closed）。
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-07-08T10:00:00.000Z" },
    { type: "run.event", kind: "file_written", path: "src/foo.js", ts: "2026-07-08T10:01:00.000Z" },
    { type: "run.evidence_audit", passed: "yes", ts: "2026-07-08T10:01:10.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-08T10:02:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-08T10:02:01.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "crash", "畸形 audit 存在 → 不回退到重建提升 → 仍 crash");
});

test("TD-80 priority: legacy 证据 run 同时满足断流签名 → 仍 evidence_passed_backend_failed（优先级不变）", () => {
  // 与 M9-5P audit 版回归同形：≥3 events + ≥120s 静默 + exit crash + file 证据、无 audit。
  // evidence_passed_backend_failed 的优先级槽位不变——仍高于 provider_disconnect。
  const events = [
    { type: "run.state_change", to: "running", ts: "2026-07-02T00:00:00.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "tool_use", tool: "X", input: {}, ts: "2026-07-02T00:01:00.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "tool_result", tool: "X", output: "y", ts: "2026-07-02T00:01:01.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "file_written", path: "src/foo.js", ts: "2026-07-02T00:01:02.000Z", runId: "r", agentId: "w" },
    { type: "run.event", kind: "tool_use", tool: "Y", input: {}, ts: "2026-07-02T00:01:03.000Z", runId: "r", agentId: "w" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-02T00:05:00.000Z", runId: "r", agentId: "w" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-07-02T00:05:00.000Z", runId: "r", agentId: "w" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "evidence_passed_backend_failed",
    "legacy 证据通过仍优先于 provider_disconnect 和 no_effect（优先级槽位不变）");
});

test("TD-80 priority: legacy 证据 run 含 auth 信号 → 仍 provider_auth（更高优先级不被证据提升抢走）", () => {
  // 提升只发生在 4.5 槽位——provider_auth 等更高优先级分类先判，不得被重建证据覆盖。
  const events = [
    { type: "run.submitted", agentId: "coder_hq", ts: "2026-07-02T10:00:00.000Z" },
    { type: "run.event", kind: "file_written", path: "src/foo.js", ts: "2026-07-02T10:01:00.000Z" },
    { type: "run.error", phase: "wait", error: "provider error [401]: 身份验证失败", ts: "2026-07-02T10:02:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-02T10:02:01.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "provider_auth", "auth 信号仍先于证据提升判（优先级不变）");
});

test("TD-80 fixture: 真实脱敏 legacy transcript（run_20260702142549160dfqmrt 形状）→ evidence_passed_backend_failed", async () => {
  // 从历史 run_20260702142549160dfqmrt（Codex tester，CI 监控只读任务）脱敏提取：
  // 命令轮询有产出（command exitCode 0 ×2），无 run.evidence_audit（TD-95 之前的 legacy），
  // backend 非零退出 → 旧行为 crash。修复后应提升为 evidence_passed_backend_failed。
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "transcript-legacy-evidence-backend-failed.jsonl");
  const raw = readFileSync(fixturePath, "utf8");
  const events = raw.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(!events.some((e) => e.type === "run.evidence_audit"), "fixture 必须是无 audit 的 legacy transcript");
  const d = diagnoseFailure(events);
  assert.equal(d.category, "evidence_passed_backend_failed",
    "真实脱敏 legacy transcript 应诊断为 evidence_passed_backend_failed（不是 crash）");
  assert.ok(d.evidence.some((e) => e.fact.includes("证据通过")),
    "证据应说明'证据通过'——让 Lead 知道任务可能做对了");
  assert.ok(d.evidence.some((e) => e.fact.includes("2 个命令 exit0")), "事实应含 SSOT 命令 exit0 计数");
  const blob = JSON.stringify(d);
  assert.ok(!/redacted|gh run|proc_redacted/.test(blob), "不得回显脱敏占位文本（fixture 内容不泄漏）");
});

// ---------------------------------------------------------------------------
// M12-21: completed-empty truth (provider-neutral).
//
// Mainline: a Lead must NEVER mistake a worker runtime that exits successfully
// without doing any model work for a valid completed review or delivery.
//
// Contract:
//   - A backend COMPLETION (state=completed) with NO usable effect AND
//     transport activity (runtime initialized/streamed / metrics) must NOT
//     become an ordinary completed run. It is diagnosed:
//       category = "no_effect", code = "completed_empty"
//   - Usable effect (→ stays category "none"): non-empty assistant text,
//     command activity (exit 0), file-written evidence, tool use/result.
//   - Runtime init/thinking/zero-usage metrics are transport activity, NOT
//     usable effect.
//   - A minimal completed stub with NO transport activity stays "none"
//     (the m12-9 completed-non-delivery contract).
//   - The completed_empty code names the completed-empty machine truth; it is
//     Lead-visible on the wire (category=no_effect, code=completed_empty) via
//     the unified DIAGNOSIS_CODES SSOT + category-code pair check. No provider
//     text/raw argv/path/prompt/secret is ever exposed.
// ---------------------------------------------------------------------------

test("M12-21: completed + transport activity + zero usable effect → no_effect / completed_empty", () => {
  // Production completed-empty signature: the runtime initialized, streamed,
  // and reported token usage, but produced NO assistant text, NO command,
  // NO file write, NO tool use. A process-exit-0 / parser-done(completed) that
  // did no model work.
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "initialized", ts: "2026-08-12T10:00:01.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", ts: "2026-08-12T10:00:02.000Z" },
    { type: "run.event", kind: "metrics", tokens: { input: 0, output: 0 }, ts: "2026-08-12T10:00:03.000Z" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:04.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "no_effect", "completed + transport activity + zero usable effect → no_effect");
  assert.equal(d.code, "completed_empty", "kernel code labels the completed-empty truth");
  assert.ok(DIAGNOSIS_CATEGORIES.includes(d.category), "category ∈ closed set");
  assert.ok(d.evidence.length > 0, "must carry fact evidence");
  // No raw provider text / payload leaks into evidence.
  const blob = JSON.stringify(d);
  assert.ok(!/input_tokens|output_tokens|prompt|secret|argv/i.test(blob), "no provider payload echo");
});

test("M12-21: completed + metrics-only (no runtime_activity) is still transport → completed_empty", () => {
  // A result-success path that emitted zero-usage metrics but no assistant text
  // and no tools. Metrics alone is transport activity → completed_empty.
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.event", kind: "metrics", tokens: { input: 0, output: 0 }, ts: "2026-08-12T10:00:01.000Z" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:02.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "no_effect");
  assert.equal(d.code, "completed_empty");
});

test("M12-21 guard: completed + non-empty assistant text → none (valid completion)", () => {
  // Usable effect = non-empty assistant text → NOT completed-empty.
  const events = [
    { type: "run.submitted", agentId: "reviewer", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "initialized", ts: "2026-08-12T10:00:01.000Z" },
    { type: "run.event", kind: "metrics", tokens: { input: 12, output: 8 }, ts: "2026-08-12T10:00:02.000Z" },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "review looks good" }], ts: "2026-08-12T10:00:03.000Z" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:04.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "none", "assistant text is a usable effect → valid completion");
  assert.equal(d.code, null);
});

test("M12-21 guard: completed + command exit 0 → none (valid command-only run)", () => {
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "initialized", ts: "2026-08-12T10:00:01.000Z" },
    { type: "run.event", kind: "command", command: "npm test", exitCode: 0, ts: "2026-08-12T10:00:02.000Z" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:03.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "none", "command exit 0 is a usable effect → valid completion");
  assert.equal(d.code, null);
});

test("M12-21 guard: completed + file_written → none (valid file-only run)", () => {
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "initialized", ts: "2026-08-12T10:00:01.000Z" },
    { type: "run.event", kind: "file_written", path: "src/a.js", ts: "2026-08-12T10:00:02.000Z" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:03.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "none", "file_written is a usable effect → valid completion");
  assert.equal(d.code, null);
});

test("M12-21 guard: completed + tool_use/tool_result → none (valid pure-tool run)", () => {
  const events = [
    { type: "run.submitted", agentId: "researcher", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "initialized", ts: "2026-08-12T10:00:01.000Z" },
    { type: "run.event", kind: "tool_use", tool: "Grep", input: {}, ts: "2026-08-12T10:00:02.000Z" },
    { type: "run.event", kind: "tool_result", tool: "Grep", isError: false, ts: "2026-08-12T10:00:03.000Z" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:04.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "none", "tool activity is a usable effect → valid completion");
  assert.equal(d.code, null);
});

test("M12-21 guard: completed minimal stub with NO transport activity → none (m12-9 contract)", () => {
  // A synthetic completed stub that lacks runtime_activity/metrics/thinking
  // must NOT be misread as completed-empty. This is the m12-9 completed
  // non-delivery contract: no transport activity → no completed-empty gate.
  const events = [
    { type: "run.submitted", agentId: "researcher", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:01.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "none", "no transport activity → stays none");
  assert.equal(d.code, null);
});

test("M12-21: failed run no_effect keeps null code (completed_empty is completion-only)", () => {
  // The existing failed no_effect path must NOT adopt completed_empty — that
  // code labels a successful-completion-with-no-effect, not a failed run.
  const events = [
    { type: "run.submitted", agentId: "coder_hq", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "reading..." }], ts: "2026-08-12T10:00:30.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-08-12T10:05:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-08-12T10:05:01.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "no_effect");
  assert.equal(d.code, null, "failed no_effect is NOT completed_empty");
});

// ---------------------------------------------------------------------------
// M12-21B gap #2 (historical retrofit, trim): whitespace-only assistant text
// is NOT a usable effect. assessRunEvidence._hasNonEmptyTextPart trims, so the
// historical evidence retrofit treats whitespace-only output as no effect — the
// read-only counterpart to the live ProcessBackend marker test. Live and
// historical decisions cannot diverge on blank output.
// ---------------------------------------------------------------------------
test("M12-21B: completed + transport activity + WHITESPACE-ONLY assistant text → completed_empty (retrofit trims)", () => {
  // A historical transcript (no durable marker) whose only assistant output is
  // whitespace. The retrofit must trim and project completed_empty.
  const events = [
    { type: "run.submitted", agentId: "reviewer", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "initialized", ts: "2026-08-12T10:00:01.000Z" },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "   \n\t  " }], ts: "2026-08-12T10:00:02.000Z" },
    { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:03.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "no_effect", "whitespace-only text is no usable effect");
  assert.equal(d.code, "completed_empty", "retrofit projects completed_empty for blank output");
});

// ---------------------------------------------------------------------------
// M12-21B gap #1 / M12-21C trust boundary (durable marker): RunManager persists
// completionMarker on the accepted run.completed fact. It is a control-plane
// fact, so diagnoseFailure consumes it ONLY under a fail-closed run binding:
// a valid expectedRunId AND run.completed.runId === expectedRunId (same shape
// as run.delivery_failed / run.isolation_violation). No expectedRunId, a
// cross-run marker, a missing runId, or an unknown marker value must NOT drive
// no_effect/completed_empty. The evidence retrofit above is unchanged and does
// not consult completionMarker, so historical transcripts without a bound
// marker are still covered exactly as before.
// ---------------------------------------------------------------------------

const MARKER_RUN = "run_marker_a";

function markerBaseEvents(runId, completionMarker) {
  // A no-transport completion (no runtime_activity/metrics) so the ONLY thing
  // that can project completed_empty here is the durable marker — the retrofit
  // cannot fire without transport activity. runId is bound on every fact.
  const completed = { type: "run.completed", runId, backendSessionId: "bs-1", messageCount: 0, ts: "2026-08-12T10:00:01.000Z" };
  if (completionMarker !== undefined) completed.completionMarker = completionMarker;
  return [
    { type: "run.submitted", runId, agentId: "coder_low", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.state_change", runId, from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:01.000Z" },
    completed,
  ];
}

test("M12-21C: same-run bound marker → completed_empty (valid expectedRunId + runId match)", () => {
  const events = markerBaseEvents(MARKER_RUN, "completed_empty");
  const d = diagnoseFailure(events, MARKER_RUN);
  assert.equal(d.category, "no_effect", "bound same-run marker → no_effect even with no transport activity");
  assert.equal(d.code, "completed_empty");
  assert.ok(d.evidence.some((e) => /completionMarker=completed_empty/.test(e.fact)), "evidence cites the durable marker");
});

test("M12-21C: cross-run marker is ignored (runId !== expectedRunId) → none", () => {
  // A concatenated/corrupt transcript: the requested run (MARKER_RUN) completed
  // with no marker of its own, but a DIFFERENT run's run.completed carries the
  // marker. The cross-run marker must NOT pollute the requested run.
  const events = [
    ...markerBaseEvents(MARKER_RUN, undefined),
    { type: "run.completed", runId: "run_marker_other", backendSessionId: "bs-2", messageCount: 0, completionMarker: "completed_empty", ts: "2026-08-12T10:00:02.000Z" },
  ];
  const d = diagnoseFailure(events, MARKER_RUN);
  assert.equal(d.category, "none", "cross-run marker must not drive completed_empty");
  assert.equal(d.code, null);
});

test("M12-21C: unbound caller (no expectedRunId) → marker NOT consumed → none", () => {
  // No expectedRunId: an unbound caller must never attribute completed-empty.
  const events = markerBaseEvents(MARKER_RUN, "completed_empty");
  const d = diagnoseFailure(events);
  assert.equal(d.category, "none", "unbound caller ignores the durable marker");
  assert.equal(d.code, null);
});

test("M12-21C: run.completed missing runId is NOT consumed (fail-closed binding) → none", () => {
  // A run.completed with a marker but no runId envelope cannot be bound to the
  // requested run → ignored (defends against malformed/hand-crafted facts).
  const events = [
    { type: "run.submitted", runId: MARKER_RUN, agentId: "coder_low", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.state_change", runId: MARKER_RUN, from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:01.000Z" },
    { type: "run.completed", backendSessionId: "bs-1", messageCount: 0, completionMarker: "completed_empty", ts: "2026-08-12T10:00:01.000Z" },
  ];
  const d = diagnoseFailure(events, MARKER_RUN);
  assert.equal(d.category, "none", "missing runId → marker not bound → none");
  assert.equal(d.code, null);
});

test("M12-21C: unknown marker value is NOT consumed (closed-set only, even when bound) → none", () => {
  // Bound to the right run, but the marker is not the closed-set member.
  // RunManager never persists raw values, so this could only appear in a
  // hand-crafted/legacy transcript; it is not trusted.
  const events = markerBaseEvents(MARKER_RUN, "totally_raw_value");
  const d = diagnoseFailure(events, MARKER_RUN);
  assert.equal(d.category, "none", "unknown marker value ignored even when bound");
  assert.equal(d.code, null);
});

test("M12-21C: valid completion (assistant text) bound → none, no marker projected", () => {
  // Real assistant output is a usable effect; run.completed carries no marker.
  const events = [
    { type: "run.submitted", runId: MARKER_RUN, agentId: "reviewer", ts: "2026-08-12T10:00:00.000Z" },
    { type: "run.event", runId: MARKER_RUN, kind: "runtime_activity", status: "initialized", ts: "2026-08-12T10:00:01.000Z" },
    { type: "run.event", runId: MARKER_RUN, kind: "message", role: "assistant", parts: [{ type: "text", text: "review looks good" }], ts: "2026-08-12T10:00:02.000Z" },
    { type: "run.state_change", runId: MARKER_RUN, from: "running", to: "completed", reason: "done", ts: "2026-08-12T10:00:03.000Z" },
    { type: "run.completed", runId: MARKER_RUN, backendSessionId: "bs-1", messageCount: 1, ts: "2026-08-12T10:00:03.000Z" },
  ];
  const d = diagnoseFailure(events, MARKER_RUN);
  assert.equal(d.category, "none", "valid completion is not diagnosed as no-effect");
  assert.equal(d.code, null);
});

// ---------------------------------------------------------------------------
// M12-21 Lead correction: the single general diagnosis-code SSOT + the
// category-code pair check that BOTH the kernel (diagnoseFailure) and the wire
// (run_diagnose / run_await_result) project through. No second hand-maintained
// enum; completed_empty is NOT folded into PROVIDER_DIAGNOSIS_CODES.
// ---------------------------------------------------------------------------

test("M12-24: DIAGNOSIS_CODES is the single general SSOT (auth ∪ capacity ∪ no-effect)", () => {
  assert.deepEqual(
    [...DIAGNOSIS_CODES],
    [...PROVIDER_DIAGNOSIS_CODES, ...PROVIDER_CAPACITY_DIAGNOSIS_CODES, ...NO_EFFECT_DIAGNOSIS_CODES],
  );
  // completed_empty is present and is the only no-effect code.
  assert.ok(DIAGNOSIS_CODES.includes("completed_empty"));
  assert.deepEqual([...NO_EFFECT_DIAGNOSIS_CODES], ["completed_empty"]);
  // Contract #2: completed_empty is NOT folded into PROVIDER_DIAGNOSIS_CODES.
  assert.equal(PROVIDER_DIAGNOSIS_CODES.includes("completed_empty"), false);
  // Every provider code is a member of the general SSOT (no drift).
  for (const c of PROVIDER_DIAGNOSIS_CODES) assert.ok(DIAGNOSIS_CODES.includes(c));
  for (const c of PROVIDER_CAPACITY_DIAGNOSIS_CODES) assert.ok(DIAGNOSIS_CODES.includes(c));
});

test("M12-21: isValidDiagnosisCode enforces exact category-code pairs (fail closed)", () => {
  // Valid pairs.
  for (const c of PROVIDER_DIAGNOSIS_CODES) {
    assert.equal(isValidDiagnosisCode("provider_auth", c), true, `provider_auth × ${c} is valid`);
  }
  for (const c of PROVIDER_CAPACITY_DIAGNOSIS_CODES) {
    assert.equal(isValidDiagnosisCode("provider_capacity", c), true, `provider_capacity × ${c} is valid`);
  }
  assert.equal(isValidDiagnosisCode("no_effect", "completed_empty"), true, "no_effect × completed_empty is valid");
  // Invalid pairings: a provider code under no_effect, or completed_empty under provider_auth.
  assert.equal(isValidDiagnosisCode("no_effect", "unauthorized"), false, "provider code under no_effect is invalid");
  assert.equal(isValidDiagnosisCode("provider_auth", "completed_empty"), false, "completed_empty under provider_auth is invalid");
  // Every other category never carries a code.
  for (const category of DIAGNOSIS_CATEGORIES) {
    if (category === "provider_auth" || category === "provider_capacity" || category === "no_effect") continue;
    assert.equal(isValidDiagnosisCode(category, "completed_empty"), false, `${category} never carries a code`);
    assert.equal(isValidDiagnosisCode(category, "unauthorized"), false, `${category} never carries a code`);
  }
  // Non-arguments fail closed.
  assert.equal(isValidDiagnosisCode("provider_auth", null), false);
  assert.equal(isValidDiagnosisCode("provider_auth", undefined), false);
  assert.equal(isValidDiagnosisCode(null, "unauthorized"), false);
  assert.equal(isValidDiagnosisCode("not_a_category", "unauthorized"), false);
});

test("0070（会审 sol）: 控制面自己观察到的体征事实不当作 provider 曾在出流的证据，也不算 worker 事件", () => {
  const base = [
    { type: "session.created", backend: "process", backendSessionId: "proc_4321", ts: "2026-10-13T06:00:00.000Z" },
    { type: "run.submitted", ts: "2026-10-13T06:00:00.100Z" },
  ];
  const observed = (status, ts) => ({ type: "run.event", kind: "runtime_activity", status, ts });
  const exit = [
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-10-13T06:30:00.000Z" },
    { type: "run.state_change", to: "failed", reason: "backend_error", ts: "2026-10-13T06:30:00.010Z" },
  ];
  // 只有三条取样事实，之后静默超过 120s 退出码 1：此前会被读成 provider_disconnect（"≥3 条 run.event + 静默 + 崩溃"）。
  const onlyObserved = [
    ...base,
    observed("process_active", "2026-10-13T06:05:30.000Z"),
    observed("files_changed", "2026-10-13T06:11:00.000Z"),
    observed("process_active", "2026-10-13T06:16:30.000Z"),
    ...exit,
  ];
  const d = diagnoseFailure(onlyObserved);
  assert.equal(d.category, "crash", "本机活动不能证明 provider 曾正常出流");
  assert.ok(d.evidence.some((e) => /^进程退出前未观察到任何 worker 事件/.test(e.fact)), "零 worker 事件的事实照旧附上");
  // provider 流里出来的事件照旧算：三条 streaming + 静默 + 崩溃 → provider_disconnect。
  const streamed = [
    ...base,
    observed("streaming", "2026-10-13T06:05:30.000Z"),
    observed("streaming", "2026-10-13T06:06:30.000Z"),
    observed("streaming", "2026-10-13T06:07:30.000Z"),
    ...exit,
  ];
  assert.equal(diagnoseFailure(streamed).category, "provider_disconnect");
});

test("zcode 静默收口证据: 只写原文能证的事——无取样结论不写「无生命体征」，也不断言转录里没有上游信号（会审 sol / deepseek-flash Q5）", () => {
  const runId = "run_zcode_closeout_facts";
  const events = [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-14T09:00:01.000Z" },
    { type: "run.error", phase: "wait", error: "HTTP 429: too many requests (transient, retried)", runId, ts: "2026-10-14T09:00:10.000Z" },
    { type: "run.event", kind: "runtime_activity", status: "streaming", runId, ts: "2026-10-14T09:01:00.000Z" },
    {
      type: "run.error", phase: "wait", runId, ts: "2026-10-14T09:06:00.000Z",
      // 进程活动取样不可用时，零 part 门的文案不带取样结论。
      error: "zcode thinking budget exceeded (no turn parts observed for 120 consecutive polls, silentTimeout absent — bounded exit)",
    },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-14T09:06:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "provider_disconnect");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.ok(!/无生命体征/.test(joined), "文案没有取样结论时不写无生命体征");
  assert.match(joined, /静默到点后/);
  assert.ok(!/没有上游|未发出/.test(joined), "转录里有过上游 429，证据不得断言没有上游信号");
  assert.match(joined, /收口本身不带上游原因/);
});

// ---------------------------------------------------------------------------
// 2026-10-15：kimi-web 静默收口 → 逐门判定（与 zcode 门表同槽位 4.6）。
//
// kimi-web 车道（src/backends/kimiWeb.js）的 turn 迟迟没有进展时有界收口，
// run.error(phase:wait) 的文案由控制面自己写、以门表前缀开头。收口本身不带上游原因；
// 收口时 serve 有没有被问到、当时怎么答决定类别与事实：
//   - turn 一直没出现（silentTimeout 到点 / silentTimeout 缺席时的拍数兜底）→
//     provider_disconnect，证据写明收口没有向 serve 取证、三种上游原因不可区分；
//   - 停滞到点 + serve 作证本轮不活跃 → provider_disconnect；
//   - 停滞到点 + serve 不应答 → unknown（serve 状态未知，不冒充已知的 provider 中断）；
//   - serve 一直作证在跑、输出不增长到封顶 → provider_disconnect；
//   - 两道历史门（8 拍无增长 / 不带证词子句的自适应停滞）→ provider_disconnect，
//     证据写明收口时没有向 serve 取证。
// 锚定前缀只匹配这些收口文案的开头（恰好引用它们的其它错误不命中）；门表排在
// auth/config/capacity 之后、no_effect/crash 之前；空答复收口不在门表内。
// ---------------------------------------------------------------------------

const KIMI_CLOSEOUT_RUN = "run_kimi_closeout";

function kimiCloseoutEvents(runId, error, extra = []) {
  return [
    { type: "run.state_change", to: "running", reason: "start", runId, ts: "2026-10-15T09:00:01.000Z" },
    ...extra,
    { type: "run.error", phase: "wait", runId, ts: "2026-10-15T09:15:05.000Z", error },
    { type: "run.state_change", to: "failed", reason: "backend_error", runId, ts: "2026-10-15T09:15:05.000Z" },
  ];
}

function kimiCloseoutDiagnosis(error, extra) {
  return diagnoseFailure(kimiCloseoutEvents(KIMI_CLOSEOUT_RUN, error, extra), KIMI_CLOSEOUT_RUN);
}

test("kimi-web 静默收口: silent_timeout 门（turn 一直未出现）→ provider_disconnect + 三种原因不可区分", () => {
  const d = kimiCloseoutDiagnosis(
    "silent timeout: turn for this prompt not observed within 900000ms (provider may have silently rejected)",
  );
  assert.equal(d.category, "provider_disconnect", "turn 一直没出现的有界收口 → provider 流中断");
  assert.equal(d.code, null, "provider_disconnect 不带 code");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /silent_timeout 门/, "证据说明是哪一道门收口");
  assert.match(joined, /上游拒绝、serve 未受理与网络中断在本转录内无法区分/, "turn 未出现的门：收口不带原因，三种原因不可区分");
  assert.match(joined, /收口本身不带上游原因/);
  assert.ok(!JSON.stringify(d.evidence).match(/建议|应该|retry|重派|换\s*worker/), "证据不得含处方");
});

test("kimi-web 静默收口: silentTimeout 缺席时的拍数兜底门 → provider_disconnect", () => {
  const d = kimiCloseoutDiagnosis(
    "turn stalled (no progress): turn not observed for 8 consecutive polls (bounded exit, silentTimeout absent)",
  );
  assert.equal(d.category, "provider_disconnect");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /turn_absent 门/, "证据说明是哪一道门收口");
  assert.match(joined, /上游拒绝、serve 未受理与网络中断在本转录内无法区分/);
  assert.match(joined, /收口本身不带上游原因/);
});

test("kimi-web 静默收口: 停滞到点 + serve 作证本轮不活跃 → provider_disconnect（14010ms 读数不误判 auth）", () => {
  const d = kimiCloseoutDiagnosis(
    "turn stalled (no progress): silent stretch 300544ms exceeded adaptive budget 60000ms floor / ×3 / 240000ms ceiling; max recovered gap this turn 14010ms (bounded exit); attestation: inactive — the serve reports the turn NOT active (likely a true stall; probe the session before re-dispatching)",
  );
  assert.equal(d.category, "provider_disconnect", "serve 明确作证本轮不活跃 → 已知的停滞");
  assert.notEqual(d.category, "provider_auth", "毫秒读数里的 401 数字串不得判成认证失败");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /stalled_attestation_inactive 门/, "证据说明是哪一道门收口");
  assert.match(joined, /serve 作证本轮已不活跃/);
  assert.match(joined, /收口本身不带上游原因/);
});

test("kimi-web 静默收口: 停滞到点 + serve 不应答 → unknown（serve 状态未知），证词计数不混淆两态", () => {
  const d = kimiCloseoutDiagnosis(
    "turn stalled (no progress): silent stretch 300544ms exceeded adaptive budget 60000ms floor / ×3 / 240000ms ceiling; max recovered gap this turn 14010ms (bounded exit; 3 prior liveness attestation(s) since the last output growth); attestation: unavailable — the attestation probe failed (unknown liveness; do NOT assume the serve is dead — probe the session, then diagnose)",
  );
  assert.equal(d.category, "unknown", "serve 不应答 = 状态未知，不冒充已知的 provider 侧中断");
  assert.equal(d.code, null);
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /stalled_attestation_unavailable 门/, "先前的证词计数不得把 unavailable 读成 inactive");
  assert.match(joined, /serve 不应答，serve 的状态未知/);
  assert.match(joined, /收口本身不带上游原因/);
});

test("kimi-web 静默收口: serve 一直作证在跑、输出不增长到封顶 → provider_disconnect", () => {
  const d = kimiCloseoutDiagnosis(
    "turn stalled: serve-attested silence since the last output growth exceeded the 30min cap (1900000ms across 7 attestation(s); adaptive budget diagnostics: floor 60000ms / ×3 / ceiling 240000ms) — bounded exit despite liveness (the serve keeps attesting an active turn that never lands output)",
  );
  assert.equal(d.category, "provider_disconnect", "证词封顶门 → provider 流中断");
  assert.notEqual(d.category, "provider_auth");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /serve_attested_cap 门/, "证据说明是哪一道门收口");
  assert.match(joined, /serve 一直作证本轮在跑，但输出一直不增长/);
  assert.match(joined, /收口本身不带上游原因/);
});

test("kimi-web 静默收口（历史门）: 8 拍无增长 → provider_disconnect + 收口时没有向 serve 取证", () => {
  const d = kimiCloseoutDiagnosis(
    "turn stalled (no progress): turn state unchanged and no steps/frames growth for 8 consecutive polls (bounded exit)",
  );
  assert.equal(d.category, "provider_disconnect");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /legacy_poll_no_growth 门/, "证据说明是哪一种历史门");
  assert.match(joined, /收口时没有向 serve 取证/);
  assert.match(joined, /收口本身不带上游原因/);
});

test("kimi-web 静默收口（历史门）: 不带证词子句的自适应停滞 → provider_disconnect + 收口时没有向 serve 取证", () => {
  const d = kimiCloseoutDiagnosis(
    "turn stalled (no progress): silent stretch 300544ms exceeded adaptive budget 60000ms floor / ×3 / 240000ms ceiling; max recovered gap this turn 14010ms (bounded exit)",
  );
  assert.equal(d.category, "provider_disconnect");
  const joined = d.evidence.map((e) => e.fact).join(" ");
  assert.match(joined, /legacy_adaptive_budget 门/, "没有 attestation 子句的文案落到历史门");
  assert.match(joined, /收口时没有向 serve 取证/);
  assert.match(joined, /收口本身不带上游原因/);
  assert.ok(!/stalled_attestation_/.test(joined), "历史门不得被读成带证词的现行门");
});

test("kimi-web 静默收口: 轮内有活动但无产出 → 门表先于 no_effect 判 provider_disconnect", () => {
  // 收口 run 的轮内通常已有 tool_use / assistant text（读上下文），而无 file_written /
  // command exit0——旧读法落到 no_effect，读不出"这是收口门杀的"。
  const d = kimiCloseoutDiagnosis(
    "turn stalled (no progress): silent stretch 300544ms exceeded adaptive budget 60000ms floor / ×3 / 240000ms ceiling; max recovered gap this turn 14010ms (bounded exit); attestation: inactive — the serve reports the turn NOT active (likely a true stall; probe the session before re-dispatching)",
    [
      { type: "run.event", kind: "tool_use", tool: "Read", input: {}, runId: KIMI_CLOSEOUT_RUN, ts: "2026-10-15T09:05:00.000Z" },
      { type: "run.event", kind: "tool_result", tool: "Read", output: "redacted", runId: KIMI_CLOSEOUT_RUN, ts: "2026-10-15T09:05:01.000Z" },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "reading…" }], runId: KIMI_CLOSEOUT_RUN, ts: "2026-10-15T09:06:00.000Z" },
    ],
  );
  assert.equal(d.category, "provider_disconnect", "有活动无产出的收口 run：门表在 no_effect 之前");
  assert.ok(!d.evidence.some((e) => /无 file_written/.test(e.fact)), "不得落 no_effect 的事实");
});

test("kimi-web 静默收口: 七种文案的门 → 类别映射（每条都带「哪道门 + 收口不带上游原因」两条事实）", () => {
  const cases = [
    { gate: "silent_timeout", category: "provider_disconnect", error: "silent timeout: turn for this prompt not observed within 60000ms (provider may have silently rejected)" },
    { gate: "turn_absent", category: "provider_disconnect", error: "turn stalled (no progress): turn not observed for 8 consecutive polls (bounded exit, silentTimeout absent)" },
    { gate: "stalled_attestation_inactive", category: "provider_disconnect", error: "turn stalled (no progress): silent stretch 300544ms exceeded adaptive budget 60000ms floor / ×3 / 240000ms ceiling; max recovered gap this turn 14010ms (bounded exit); attestation: inactive — the serve reports the turn NOT active (likely a true stall; probe the session before re-dispatching)" },
    { gate: "stalled_attestation_unavailable", category: "unknown", error: "turn stalled (no progress): silent stretch 300544ms exceeded adaptive budget 60000ms floor / ×3 / 240000ms ceiling; max recovered gap this turn 14010ms (bounded exit); attestation: unavailable — the attestation probe failed (unknown liveness; do NOT assume the serve is dead — probe the session, then diagnose)" },
    { gate: "serve_attested_cap", category: "provider_disconnect", error: "turn stalled: serve-attested silence since the last output growth exceeded the 30min cap (1900000ms across 7 attestation(s); adaptive budget diagnostics: floor 60000ms / ×3 / ceiling 240000ms) — bounded exit despite liveness (the serve keeps attesting an active turn that never lands output)" },
    { gate: "legacy_poll_no_growth", category: "provider_disconnect", error: "turn stalled (no progress): turn state unchanged and no steps/frames growth for 8 consecutive polls (bounded exit)" },
    { gate: "legacy_adaptive_budget", category: "provider_disconnect", error: "turn stalled (no progress): silent stretch 300544ms exceeded adaptive budget 60000ms floor / ×3 / 240000ms ceiling; max recovered gap this turn 14010ms (bounded exit)" },
  ];
  for (const c of cases) {
    const d = kimiCloseoutDiagnosis(c.error);
    assert.equal(d.category, c.category, `${c.gate} 门的类别`);
    assert.equal(d.evidence.length, 2, `${c.gate} 门两条事实（哪道门 + 收口本身不带上游原因）`);
    assert.ok(d.evidence.every((e) => e.eventType === "run.error"), `${c.gate} 门证据指向 run.error`);
    const joined = d.evidence.map((e) => e.fact).join(" ");
    assert.match(joined, new RegExp(`${c.gate} 门`), `${c.gate} 门：证据说明是哪道门`);
    assert.match(joined, /收口本身不带上游原因/, `${c.gate} 门：证据写明收口不带上游原因`);
  }
});

test("kimi-web 静默收口: 毫秒读数含 401/429 数字串 → 仍按门表归类（不误判 auth/capacity）", () => {
  // 真实形状：读数只有独立数字边界（401872ms / 429140ms / 14010ms），没有独立 401/429。
  const legs = [
    {
      gate: /stalled_attestation_inactive 门/,
      error: "turn stalled (no progress): silent stretch 401872ms exceeded adaptive budget 60000ms floor / ×3 / 240000ms ceiling; max recovered gap this turn 14010ms (bounded exit); attestation: inactive — the serve reports the turn NOT active (likely a true stall; probe the session before re-dispatching)",
    },
    {
      gate: /legacy_adaptive_budget 门/,
      error: "turn stalled (no progress): silent stretch 429140ms exceeded adaptive budget 60000ms floor / ×3 / 240000ms ceiling; max recovered gap this turn 14010ms (bounded exit)",
    },
    {
      gate: /silent_timeout 门/,
      error: "silent timeout: turn for this prompt not observed within 429401ms (provider may have silently rejected)",
    },
  ];
  for (const leg of legs) {
    const d = kimiCloseoutDiagnosis(leg.error);
    assert.equal(d.category, "provider_disconnect", `读数里的 401/429 数字串不得改类别：${leg.error.slice(0, 40)}…`);
    assert.match(d.evidence.map((e) => e.fact).join(" "), leg.gate);
  }
});

test("kimi-web 静默收口: 只是引用收口文案的其它错误不命中门表", () => {
  const quoted = [
    'relayed upstream note: "silent timeout: turn for this prompt not observed within 60000ms (provider may have silently rejected)"',
    "backend error before closeout: turn stalled (no progress): silent stretch 300544ms exceeded adaptive budget 60000ms floor / ×3 / 240000ms ceiling; max recovered gap this turn 14010ms (bounded exit)",
  ];
  for (const error of quoted) {
    const d = kimiCloseoutDiagnosis(error);
    assert.equal(d.category, "unknown", "引用不是收口本体：没有别的信号时落兜底 unknown");
    assert.ok(!d.evidence.some((e) => /有界收口/.test(e.fact)), "不得带门表事实");
  }
});

test("kimi-web 空答复收口: 不在门表内——照既有优先级走（命令证据 / 有活动无产出 / 兜底）", () => {
  const closeout = "kimi turn completed without assistant text (state=completed, no text frames — refusing to fabricate completion)";
  // ① 有通过的命令证据 → 既有 4.5 槽位先判 evidence_passed_backend_failed。
  const withCommand = kimiCloseoutDiagnosis(closeout, [
    { type: "run.event", kind: "command", command: "npm test", exitCode: 0, runId: KIMI_CLOSEOUT_RUN, ts: "2026-10-15T09:10:00.000Z" },
  ]);
  assert.equal(withCommand.category, "evidence_passed_backend_failed", "命令证据 → 既有提升规则不变");
  // ② 有活动无产出 → no_effect。
  const withActivity = kimiCloseoutDiagnosis(closeout, [
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "reading…" }], runId: KIMI_CLOSEOUT_RUN, ts: "2026-10-15T09:10:00.000Z" },
  ]);
  assert.equal(withActivity.category, "no_effect", "有活动无产出 → no_effect 不变");
  // ③ 其余 → 兜底 unknown。
  const bare = kimiCloseoutDiagnosis(closeout);
  assert.equal(bare.category, "unknown", "无信号 → 终态兜底不搬新类别");
  for (const d of [withCommand, withActivity, bare]) {
    assert.ok(!d.evidence.some((e) => /kimi-web 有界收口/.test(e.fact)), "空答复收口不得带门表事实");
  }
});

test("kimi-web 收口排序: 带上游错误正文的 kimi turn failed (… 429 …) → 仍 provider_capacity（门表不抢）", () => {
  const d = kimiCloseoutDiagnosis("kimi turn failed (turn state=failed, error: 429 Too Many Requests)");
  assert.equal(d.category, "provider_capacity", "上游真发了额度错误文本 → provider_capacity 先判");
  assert.equal(d.code, "rate_limited");
});

// ---------------------------------------------------------------------------
// runs settle 结算的 process_missing 运行（终态 failed + 理由 process_missing
// + 确认事实）：归 unknown，证据只给两条事实——结算的由来与原因不在转录内。
// ---------------------------------------------------------------------------

test("SETTLE-DX-1: 结算运行 → unknown + 两条事实（结算由来/原因不在转录内）", () => {
  const runId = "run_settle_dx1";
  const events = [
    { type: "run.started", backend: "claude-code", runId, ts: "2026-09-01T00:00:00.000Z" },
    { type: "run.background_submitted", background: true, runId, ts: "2026-09-01T00:00:01.000Z" },
    { type: "run.state_change", from: null, to: "running", reason: "first_event", runId, ts: "2026-09-01T00:00:02.000Z" },
    { type: "run.process_missing_confirmed", settledBy: "lead_settle", sessionShape: "process_session", runId, ts: "2026-10-15T00:00:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "process_missing", runId, ts: "2026-10-15T00:00:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "unknown");
  assert.equal(d.code, null);
  assert.equal(d.evidence.length, 2);
  assert.equal(d.evidence[0].eventType, "run.process_missing_confirmed");
  assert.match(d.evidence[0].fact, /runner 与会话进程都已不在/);
  assert.match(d.evidence[0].fact, /Lead 事后结算/);
  assert.match(d.evidence[1].fact, /原因不在转录内/);
});

test("SETTLE-DX-2: 只有终态理由、无确认事实 → 不触发新规则（防御：不完整 durable 记录不强归类）", () => {
  const runId = "run_settle_dx2";
  const events = [
    { type: "run.state_change", from: null, to: "running", reason: "first_event", runId, ts: "2026-09-01T00:00:02.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "process_missing", runId, ts: "2026-10-15T00:00:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "unknown");
  assert.deepEqual(d.evidence, [], "无确认事实 → 走终态兜底，不写结算事实");
});

test("SETTLE-DX-3 回归钉: M12-19 交付恢复运行带通过的证据审计 → 仍归 evidence_passed_backend_failed（新规则在后）", () => {
  const runId = "run_settle_dx3";
  const events = [
    { type: "run.started", backend: "claude-code", runId, ts: "2026-09-01T00:00:00.000Z" },
    { type: "run.background_submitted", background: true, runId, ts: "2026-09-01T00:00:01.000Z" },
    { type: "run.state_change", from: null, to: "running", reason: "first_event", runId, ts: "2026-09-01T00:00:02.000Z" },
    { type: "run.evidence_audit", passed: true, runId, ts: "2026-09-01T00:10:00.000Z" },
    { type: "run.process_missing_confirmed", settledBy: "lead_settle", runId, ts: "2026-10-15T00:00:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "process_missing", runId, ts: "2026-10-15T00:00:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "evidence_passed_backend_failed", "带通过审计的结算运行结论不变（不翻成 unknown）");
});

test("SETTLE-DX-4 回归钉: 已被重新打包恢复的运行（legacy 证据重建通过）结论不变", () => {
  const runId = "run_settle_dx4";
  const events = [
    { type: "run.started", backend: "claude-code", runId, ts: "2026-09-01T00:00:00.000Z" },
    { type: "run.state_change", from: null, to: "running", reason: "first_event", runId, ts: "2026-09-01T00:00:02.000Z" },
    { type: "run.event", kind: "tool_result", runId, ts: "2026-09-01T00:05:00.000Z" },
    { type: "run.event", kind: "file_written", path: "src/a.js", runId, ts: "2026-09-01T00:06:00.000Z" },
    { type: "run.process_missing_confirmed", settledBy: "lead_settle", runId, ts: "2026-10-15T00:00:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "process_missing", runId, ts: "2026-10-15T00:00:00.000Z" },
    // 已恢复：交付已重封装 + 验证通过。
    { type: "run.delivery_repackaged", runId, ts: "2026-10-15T01:00:00.000Z" },
    { type: "run.delivery_created", runId, ts: "2026-10-15T01:00:00.000Z" },
    { type: "run.delivery_verification_passed", runId, ts: "2026-10-15T01:05:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "evidence_passed_backend_failed", "文件写入证据在场 → 结论不变（新规则排在 4.5 之后）");
});

test("SETTLE-DX-5 回归钉: 已恢复但无证据的运行 → 结论仍是 unknown（类别不变；新规则只补充事实）", () => {
  const runId = "run_settle_dx5";
  const events = [
    { type: "run.state_change", from: null, to: "running", reason: "first_event", runId, ts: "2026-09-01T00:00:02.000Z" },
    { type: "run.process_missing_confirmed", settledBy: "lead_settle", runId, ts: "2026-10-15T00:00:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "process_missing", runId, ts: "2026-10-15T00:00:00.000Z" },
    { type: "run.delivery_created", runId, ts: "2026-10-15T01:00:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "unknown", "无证据的已恢复运行此前归 unknown，现在仍归 unknown");
});

test("SETTLE-DX-6: 结算运行转录里有 run.error → 不走结算规则，按 run.error 归类（原因在转录里）", () => {
  const runId = "run_settle_dx6";
  const events = [
    { type: "run.started", backend: "claude-code", runId, ts: "2026-09-01T00:00:00.000Z" },
    { type: "run.background_submitted", background: true, runId, ts: "2026-09-01T00:00:01.000Z" },
    { type: "run.error", phase: "spawn", error: "spawn ENOENT", runId, ts: "2026-09-01T00:00:02.000Z" },
    { type: "run.process_missing_confirmed", settledBy: "lead_settle", sessionShape: "no_session", runId, ts: "2026-10-15T00:00:00.000Z" },
    { type: "run.state_change", from: "pending", to: "failed", reason: "process_missing", runId, ts: "2026-10-15T00:00:00.000Z" },
  ];
  const d = diagnoseFailure(events, runId);
  assert.equal(d.category, "crash");
  assert.ok(!d.evidence.some((e) => /原因不在转录内/.test(e.fact)), "有 run.error 时不得声称原因不在转录内");
});
