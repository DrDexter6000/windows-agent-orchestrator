import { test } from "node:test";
import assert from "node:assert/strict";

import { backendFor } from "../../src/backends/factory.js";
import { CodexStreamParser } from "../../src/backends/parsers/codex.js";
import { KimiStreamParser } from "../../src/backends/parsers/kimiCode.js";

// provider 会话复用接线（2026-09-21，ADR-0031 §3.6 形状的运行期自产 id 变体）。
// 上游事实（直跑实测）：`codex exec resume <thread_id>` 与 `kimi -r <session_id>`
// 都能跨 run 携带上下文，错 id 一律 fail-closed。本文件钉 WAO 侧接线：resume 轮
// 编译出正确的续接参数、id 缺失在派发前拒绝（双重拒绝点）、parser 只捕获不 emit。

const CODEX_THREAD = "01a0c56d-981d-7ad3-9613-0050e1546f8d";
const KIMI_SESSION = "session_014e3fb4-1dbd-435e-a883-a63245876ea0";
const RESUME_ROUTING = { mode: "lead_workspace", opaqueUuid: "00000000-0000-4000-8000-000000000000", turn: "resume", priorRunId: "run_20260921000000000aaaaa" };

test("codex: resume 轮编译 exec resume <thread_id>，id 缺失派发前拒绝", () => {
  const backend = backendFor({ backend: "codex" });
  const resumed = backend.buildArgs({}, { prompt: "ping", sessionReuse: RESUME_ROUTING, priorProviderSessionId: CODEX_THREAD });
  assert.deepEqual(resumed.slice(0, 3), ["exec", "resume", CODEX_THREAD], "resume 轮以 exec resume <thread_id> 续接前任会话");
  assert.ok(resumed.includes("--json"), "续接仍走 --json 事件流");
  assert.equal(resumed[resumed.length - 1], "ping", "prompt 仍在末尾");
  assert.throws(
    () => backend.buildArgs({}, { prompt: "ping", sessionReuse: RESUME_ROUTING }),
    /prior provider thread id/,
    "resume 轮缺 priorProviderSessionId 必须派发前拒绝（绝不静默开新对话）",
  );
  const fresh = backend.buildArgs({}, { prompt: "ping" });
  assert.deepEqual(fresh.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"], "非复用派发参数逐字节不变");
});

test("kimi-code: resume 轮追加 -r <session_id>，id 缺失派发前拒绝", () => {
  const backend = backendFor({ backend: "kimi-code" });
  const resumed = backend.buildArgs({}, { prompt: "ping", sessionReuse: RESUME_ROUTING, priorProviderSessionId: KIMI_SESSION });
  assert.equal(resumed[resumed.indexOf("-r") + 1], KIMI_SESSION, "resume 轮以 -r <session_id> 续接前任会话");
  assert.ok(resumed.includes("-p"), "仍走 -p 一次性 prompt 通道");
  assert.throws(
    () => backend.buildArgs({}, { prompt: "ping", sessionReuse: RESUME_ROUTING }),
    /prior provider session id/,
    "resume 轮缺 priorProviderSessionId 必须派发前拒绝",
  );
  assert.ok(!backend.buildArgs({}, { prompt: "ping" }).includes("-r"), "非复用派发不带 -r");
});

test("parser 只捕获运行时广告的会话 id（不 emit、不猜）", () => {
  const codex = new CodexStreamParser();
  assert.equal(codex.sessionId(), null, "未广告时为 null");
  const codexEvents = codex.feed('{"type":"thread.started","thread_id":"' + CODEX_THREAD + '"}\n');
  assert.equal(codex.sessionId(), CODEX_THREAD, "codex thread.started.thread_id 被捕获");
  assert.deepEqual(codexEvents, [], "捕获不产生额外事件（事件流逐字节不变）");
  const kimi = new KimiStreamParser();
  const kimiEvents = kimi.feed('{"role":"meta","type":"session.resume_hint","session_id":"' + KIMI_SESSION + '"}\n');
  assert.equal(kimi.sessionId(), KIMI_SESSION, "kimi session.resume_hint.session_id 被捕获");
  assert.deepEqual(kimiEvents, [], "捕获不产生额外事件");
  const junk = new CodexStreamParser();
  junk.feed('{"type":"thread.started","thread_id":""}\n');
  assert.equal(junk.sessionId(), null, "空串不算可归因会话 id（fail-closed）");
});

// ===== TD188（2026-09-27）：proc_<pid> 占位身份不得交给 provider =====
//
// 生产事故（run_20260926235905551efnojy，TD-188）：Kimi 交付续接把
// session.created.backendSessionId=proc_43244（ProcessBackend spawn 时刻的本地
// 进程标识）当作 provider 会话标识传给 `-r`，上游报 Session not found、零工具
// 执行。本节钉 backend 侧防线：compile 守卫拒绝占位 id，backend-owned 纯验证
// 钩子（canResumeWithRecoveredSessionId）给出"该 backend 能否用这个转录取回 id
// 续接"的判定；claude-code 覆写为恒 true（续接编译 routing.opaqueUuid，从不
// 消费该 id——合法 opaque 路径不得被全局 proc 前缀规则误伤）。

test("TD188: kimi/codex resume 轮 buildArgs 拒绝 proc_<pid> 占位 priorProviderSessionId（派发前 fail-closed）", async () => {
  const { isProcessPlaceholderSessionId } = await import("../../src/backends/processBackend.js");
  assert.equal(isProcessPlaceholderSessionId("proc_43244"), true, "proc_<pid> 是本类 spawn 时刻写出的占位形状");
  assert.equal(isProcessPlaceholderSessionId(KIMI_SESSION), false, "runtime 自产 native id 不是占位");
  assert.equal(isProcessPlaceholderSessionId("proc_notanumber"), false, "非数字后缀不是本类写出的形状");
  assert.equal(isProcessPlaceholderSessionId(12345), false, "非字符串恒不是占位（调用方判型）");

  const codex = backendFor({ backend: "codex" });
  assert.throws(
    () => codex.buildArgs({}, { prompt: "ping", sessionReuse: RESUME_ROUTING, priorProviderSessionId: "proc_43244" }),
    /prior provider thread id.*refusing instead of silently starting a fresh codex conversation/s,
    "codex resume 轮收到占位进程号必须在派发前拒绝（绝不把 proc_PID 当 thread id）",
  );
  const kimi = backendFor({ backend: "kimi-code" });
  assert.throws(
    () => kimi.buildArgs({}, { prompt: "ping", sessionReuse: RESUME_ROUTING, priorProviderSessionId: "proc_43244" }),
    /prior provider session id.*refusing instead of silently starting a fresh kimi conversation/s,
    "kimi resume 轮收到占位进程号必须在派发前拒绝（绝不把 proc_PID 当 session id）",
  );
  // 真实 native id 仍编译出续接参数（既有行为不回退）。
  const resumedArgs = kimi.buildArgs({}, { prompt: "ping", sessionReuse: RESUME_ROUTING, priorProviderSessionId: KIMI_SESSION });
  assert.equal(resumedArgs[resumedArgs.indexOf("-r") + 1], KIMI_SESSION);
});

test("TD188: canResumeWithRecoveredSessionId —— kimi/codex 拒占位、放 native；claude 恒 true（opaque 路径）", async () => {
  const { KimiCodeBackend } = await import("../../src/backends/kimiCode.js");
  const { CodexBackend } = await import("../../src/backends/codex.js");
  const { ClaudeCodeBackend } = await import("../../src/backends/claudeCode.js");

  const kimi = new KimiCodeBackend();
  assert.equal(kimi.canResumeWithRecoveredSessionId("proc_43244"), false, "kimi：proc-only 缺真实 id 必须 fail-closed");
  assert.equal(kimi.canResumeWithRecoveredSessionId(KIMI_SESSION), true, "kimi：wire 广告的 native id 可续接");
  assert.equal(kimi.canResumeWithRecoveredSessionId(""), false, "空串不可续接");

  const codex = new CodexBackend();
  assert.equal(codex.canResumeWithRecoveredSessionId("proc_43244"), false, "codex：proc-only 缺真实 id 必须 fail-closed");
  assert.equal(codex.canResumeWithRecoveredSessionId(CODEX_THREAD), true, "codex：thread.started 广告的 thread id 可续接");

  const claude = new ClaudeCodeBackend();
  assert.equal(claude.canResumeWithRecoveredSessionId("proc_1234"), true,
    "claude：续接编译 routing.opaqueUuid（--resume <uuid>），从不消费取回 id——proc 身份不是阻断（合法 opaque 路径保留）");
  assert.equal(claude.canResumeWithRecoveredSessionId(KIMI_SESSION), true, "claude：任何取回值都不阻断（该 lane 不消费它）");
});
