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
import { diagnoseFailure } from "../src/diagnosis.js";

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

test("TD-55: stop_requested + aborted state wins over later wait failure", () => {
  const events = [
    { type: "run.submitted", agentId: "coder_low", ts: "2026-06-26T10:00:00.000Z" },
    { type: "run.stop_requested", backendSessionId: "proc_123", reason: "user", ts: "2026-06-26T10:00:01.000Z" },
    { type: "run.state_change", from: "submitted", to: "aborted", reason: "stop_requested", ts: "2026-06-26T10:00:01.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 143", ts: "2026-06-26T10:00:02.000Z" },
    { type: "run.state_change", from: "aborted", to: "failed", reason: "backend_error", ts: "2026-06-26T10:00:02.000Z" },
  ];
  const d = diagnoseFailure(events);
  assert.equal(d.category, "aborted_manual");
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
  const events = [
    { type: "run.submitted", agentId: "coder_hq", ts: "2026-07-08T10:00:00.000Z" },
    { type: "run.event", kind: "tool_use", name: "Read", ts: "2026-07-08T10:00:30.000Z" },
    { type: "run.event", kind: "tool_result", isError: false, ts: "2026-07-08T10:00:31.000Z" },
    { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "reading..." }], ts: "2026-07-08T10:01:00.000Z" },
    { type: "run.error", phase: "wait", error: "process exited with code 1", ts: "2026-07-08T10:05:00.000Z" },
    { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-08T10:05:01.000Z" },
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
