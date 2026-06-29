// diagnosis.js
//
// M8-3：故障诊断（🔵 工具起草域——给证据，不给处方）。
//
// 设计铁律：diagnoseFailure 只输出【事实证据】，绝不输出【建议/处方】。
// 处方权（retry/换 worker/接管/放弃）全在 Lead。这是用户理念的核心：
//   "诊断可以工具辅助，但应对策略、下一步做什么由 Lead 实机判断，保留灵活性。"
//
// 实现上，返回结构只有 { category, evidence }，没有 recommendation 字段；
// 所有 fact 字符串只陈述发生了什么，不陈述"该做什么"。
//
// 分类（按信号归类；信号不足归 unknown，不强归类）：
//   provider_auth  — 401/身份验证失败/unauthor/auth fail
//   timeout        — run.timed_out 事件
//   scorecard_fail — run.error phase:scorecard / scorecard.checked passed:false（且未 completed）
//   budget         — run.state_change reason:budget_exceeded
//   crash          — run.error phase:spawn/spawn_fail
//   provider_disconnect — worker 活跃工作后静默≥阈值 exit≠0（provider 流式中断，非真崩）
//   aborted_manual — run.aborted 事件
//   unknown        — 有失败终态但无明确信号
//   none           — 成功 run（无失败终态，无需诊断）
//
// 只读：本函数不接收也不返回可变状态，不改 transcript。

import { findState } from "./transcript.js";

// 真正的认证失败：HTTP 401 / 身份验证失败 / unauthorized / 无效 key。
// C2 收紧：去掉宽泛的 "auth.*fail"/裸 "api_key"（会把配置冲突误判为 provider_auth）。
// 真实 401 样本含 "401"/"unauthorized"/"身份验证失败"；配置冲突含 "precedence"/"connectors"。
const AUTH_SIGNAL = /401|身份验证|unauthor|invalid.{0,12}(api[_\s-]?key|key)/i;

// 配置冲突（C2 新增）：API key 与 claude.ai 登录打架等配置层问题。
// 真实例："connectors are disabled because ANTHROPIC_API_KEY...takes precedence"。
// 这不是 401 认证失败，是配置层冲突——归类不同，Lead 处置方式不同。
const CONFIG_CONFLICT_SIGNAL = /precedence|connectors.{0,30}disabled|auth source/i;

// 进程被信号杀死 / 异常退出（C1 新增）："process exited with code N"，N≠0。
// 143=SIGTERM(被杀)，137=SIGKILL(OOM/强杀)，1=通用失败，130=SIGINT。
const CRASH_EXIT_SIGNAL = /exited with code\s+(\d+)/i;
const SIGNAL_NAMES = { 143: "SIGTERM", 137: "SIGKILL", 130: "SIGINT" };

// TD-74 provider 流式中断判据（Lead 定的保守阈值）。
// 死前≥3 条 run.event（排除启动即崩）+ 末段静默≥120s（排除活动密集的真崩）。
const PROVIDER_DISCONNECT_MIN_EVENTS = 3;
const PROVIDER_DISCONNECT_SILENCE_MS = 120_000;

/**
 * 诊断一个 run transcript 的失败原因。只给证据，不给处方。
 *
 * @param {Array} events - run transcript 事件数组（按时间序）。
 * @returns {{category: string, evidence: Array<{eventType: string, fact: string}>}}
 *   category ∈ provider_auth|timeout|scorecard_fail|budget|crash|aborted_manual|unknown|none。
 *   evidence 是事实证据（eventType 指向源事件，fact 陈述具体事实）。
 */
export function diagnoseFailure(events) {
  const evs = Array.isArray(events) ? events : [];
  // 空输入：无法判断发生了什么 → unknown。
  if (evs.length === 0) return { category: "unknown", evidence: [] };
  const state = findState(evs);

  // 成功 run：无需诊断。
  if (state === "completed") return { category: "none", evidence: [] };

  const evidence = [];

  // 1) aborted_manual：显式 stop/abort 优先于后续 wait/crash 噪音。
  const stopRequested = evs.find((e) => e.type === "run.stop_requested");
  const aborted = evs.find((e) => e.type === "run.aborted");
  const abortedChange = evs.find((e) => e.type === "run.state_change" && e.to === "aborted");
  if (stopRequested || aborted || abortedChange) {
    const source = stopRequested ?? aborted ?? abortedChange;
    evidence.push({
      eventType: source.type,
      fact: `被显式中止（reason=${source.reason ?? "unknown"}）`,
    });
    return { category: "aborted_manual", evidence };
  }

  // 1) config_conflict（C2）：配置层冲突（API key 与登录打架等）。
  //    必须在 provider_auth 之前判——配置冲突的 error 也常含 "auth"/"API_KEY" 字样，
  //    但本质是配置问题不是认证失败。真实例：ANTHROPIC_API_KEY takes precedence。
  const configError = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string" && CONFIG_CONFLICT_SIGNAL.test(e.error),
  );
  if (configError) {
    evidence.push({ eventType: "run.error", fact: `配置冲突：${configError.error}` });
    return { category: "config_conflict", evidence };
  }

  // 2) provider_auth：真正的 401/身份验证/unauthorized/无效 key（最优先，常见且确定）。
  const authError = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string" && AUTH_SIGNAL.test(e.error),
  );
  if (authError) {
    evidence.push({ eventType: "run.error", fact: `认证/身份验证类错误：${authError.error}` });
    return { category: "provider_auth", evidence };
  }

  // 2) timeout：run.timed_out 事件。
  const timedOut = evs.find((e) => e.type === "run.timed_out");
  if (timedOut) {
    evidence.push({ eventType: "run.timed_out", fact: "等待超时，控制器 abort 打断事件流" });
    return { category: "timeout", evidence };
  }

  // 3) budget：超 token 预算硬闸。
  const budgetChange = evs.find(
    (e) => e.type === "run.state_change" && e.reason === "budget_exceeded",
  );
  if (budgetChange) {
    evidence.push({ eventType: "run.state_change", fact: "token 预算超限，触发硬闸转 failed" });
    return { category: "budget", evidence };
  }

  // 4) scorecard_fail：scorecard 证据门未过。
  const scError = evs.find((e) => e.type === "run.error" && e.phase === "scorecard");
  const scChecked = evs.find((e) => e.type === "scorecard.checked" && e.passed === false);
  if (scError || scChecked) {
    const failedChecks = (scChecked?.checks ?? [])
      .filter((c) => !c.passed)
      .map((c) => c.name);
    if (failedChecks.length > 0) {
      evidence.push({
        eventType: "scorecard.checked",
        fact: `scorecard 证据门未过，失败检查项：${failedChecks.join(", ")}`,
      });
    } else if (scError) {
      evidence.push({ eventType: "run.error", fact: `scorecard 门失败：${scError.detail ?? "未提供详情"}` });
    }
    return { category: "scorecard_fail", evidence };
  }

  // 5.5) provider_disconnect：worker 活跃工作后，末段静默 ≥阈值 才 exit≠0 →
  //      provider 网关流式中断（非 runtime 真崩）。判据保守（Lead 定：静默阈值
  //      120s、死前≥3 run.event、宁漏贴勿误贴）。真实样本 run_2026062818401405116u1yd
  //      （coder_hq/GLM-5.2）：死前 84 事件 + 末段静默后进程 exit 1，claude-code 从未
  //      发 result（metrics=0）→ GLM 网关流式中断，非 worker 行为问题。
  //      排在 crash 之前：否则会被 CRASH_EXIT_SIGNAL 抢归 crash。
  const exitCrashForPd = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string" && CRASH_EXIT_SIGNAL.test(e.error),
  );
  if (state === "failed" && exitCrashForPd && !evs.some((e) => e.type === "run.completed")) {
    const activityEvents = evs.filter((e) => e.type === "run.event");
    const lastActivity = activityEvents.at(-1);
    if (lastActivity && activityEvents.length >= PROVIDER_DISCONNECT_MIN_EVENTS) {
      const silenceMs = new Date(exitCrashForPd.ts).getTime() - new Date(lastActivity.ts).getTime();
      if (silenceMs >= PROVIDER_DISCONNECT_SILENCE_MS) {
        evidence.push({
          eventType: "run.event",
          fact: `死前最后活动 ${lastActivity.ts}（${activityEvents.length} 条 run.event），末段静默 ${Math.round(silenceMs / 1000)}s`,
        });
        evidence.push({
          eventType: exitCrashForPd.type,
          fact: `${silenceMs >= PROVIDER_DISCONNECT_SILENCE_MS ? "静默 ≥阈值" : ""}后进程 ${exitCrashForPd.error}（provider 流式中断特征：worker 正常产出后静默断流，非启动即崩）`,
        });
        return { category: "provider_disconnect", evidence };
      }
    }
  }

  // 6) crash：进程崩溃/被杀。
  //    两条路径：① spawn/spawn_fail 阶段错误（backend 起不来）；
  //    ② wait 阶段的 "process exited with code N"（N≠0，含 143=SIGTERM 被 kill、
  //    137=SIGKILL/OOM、130=SIGINT、1=通用失败）。后者是 C1 新增——真实 transcript
  //    里 run.error phase:wait error:"process exited with code 143" 此前漏到 unknown。
  //    排在 auth/config 之后：若 stderr 里含 401 等，前面 provider_auth 已抢先归类。
  const spawnCrash = evs.find(
    (e) => e.type === "run.error" && (e.phase === "spawn" || e.phase === "spawn_fail"),
  );
  const exitCrash = evs.find(
    (e) => e.type === "run.error" && typeof e.error === "string" && CRASH_EXIT_SIGNAL.test(e.error),
  );
  if (spawnCrash) {
    evidence.push({
      eventType: "run.error",
      fact: `启动阶段失败（phase=${spawnCrash.phase}）：${spawnCrash.error ?? "未提供详情"}`,
    });
    return { category: "crash", evidence };
  }
  if (exitCrash) {
    const m = exitCrash.error.match(CRASH_EXIT_SIGNAL);
    const code = m ? Number(m[1]) : null;
    const sigName = code !== null ? SIGNAL_NAMES[code] : null;
    const detail = sigName
      ? `进程退出码 ${code}（${sigName}，可能被外部信号杀死）`
      : `进程异常退出，退出码 ${code}`;
    evidence.push({ eventType: "run.error", fact: `${detail}：${exitCrash.error}` });
    return { category: "crash", evidence };
  }

  // 7) 有失败终态但无明确信号 → unknown（不强归类）。
  if (state === "failed" || state === "aborted" || state === "timed_out") {
    return { category: "unknown", evidence: [] };
  }

  // 空输入 / 无状态（无法判断）→ unknown。仍在运行（非终态）→ none（无失败可诊断）。
  if (!state) return { category: "unknown", evidence: [] };
  return { category: "none", evidence: [] };
}
