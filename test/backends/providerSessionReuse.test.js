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
