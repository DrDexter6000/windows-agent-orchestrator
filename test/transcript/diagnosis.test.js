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
