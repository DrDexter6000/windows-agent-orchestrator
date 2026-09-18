// test/backgroundRunner.test.js
//
// TD-151（ADR-0030 落地）后台路径验收钉：TD-148 主害——后台 run 用小 waitTimeout +
// 慢 worker 时，到期曾通过控制器 abort 杀 worker。ADR-0030 后：backgroundRunner 的
// 到期同样只记事实（run.observation_deadline_reached），runner 继续监督到自然终态。
//
// 钉：
//   1. 后台不杀钉（主害）：小 waitTimeout + 慢 worker → 活过 deadline、自然 completed、
//      无 abort/timed_out 事件（worker 的回复在 deadline 之后到达 = 活过的构造性证明）。
//   2. resume 托管钉（TD-148 姊妹脸 (a) 根修）：runResumeBackground 驱动续跑到自然终态，
//      心跳写/清配套；terminal run 拒绝（resumed:false）。
//
// 前台通知行钉在 test/cli.test.js；根语义钉在 test/runManager.test.js。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBackground, runResumeBackground } from "../../src/backgroundRunner.js";
import { JsonlTranscript, readTranscript, findState } from "../../src/transcript.js";

function makeMockFetch({ assistantDelayMs = 0 } = {}) {
  const sessions = new Map();
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      const id = `ses_td151_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(id, { messages: [], promptedAt: 0 });
      return { ok: true, status: 200, async json() { return { data: { id } }; }, async text() { return JSON.stringify({ data: { id } }); } };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const body = JSON.parse(init.body);
      const session = sessions.get(sessionId);
      if (session) {
        session.promptedAt = Date.now();
        session.messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
      }
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      // TD-151：慢 worker——assistant 回复在 prompt 之后 assistantDelayMs 才出现在
      // 消息流里（> 等待窗 deadline，即"活过 deadline"的构造性证明）。延迟挂在
      // /message 轮询上而不是 prompt_async（后者阻塞在 start 里，等不到 wait 窗）。
      if (session && assistantDelayMs > 0 && (Date.now() - session.promptedAt) < assistantDelayMs) {
        return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } };
      }
      if (session && assistantDelayMs > 0 && !session.assistantDelivered) {
        session.assistantDelivered = true;
        session.messages.push({
          info: { id: "msg_reply", role: "assistant" },
          parts: [{ type: "text", text: "slow worker survived the deadline" }],
        });
      }
      return { ok: true, status: 200, async json() { return session?.messages ?? []; }, async text() { return JSON.stringify(session?.messages ?? []); } };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return "not found"; } };
  };
}

// ── 钉 1：后台不杀（TD-148 主害）─────────────────────────────────────────────
test("TD-148 主害钉: 后台 run 小 waitTimeout + 慢 worker → 活过 deadline、自然 completed、无 abort 事件", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-td151-bg-"));
  try {
    // assistantDelay 800ms > waitTimeout 300ms：deadline 先到，worker 后完成。
    const result = await runBackground({
      agentId: "bg_slow",
      prompt: "slow task",
      registry: {
        agents: {
          bg_slow: {
            backend: "opencode-serve",
            serveUrl: "http://127.0.0.1:4299",
            agent: "build",
            cwd: dir,
            model: { providerID: "p", id: "m" },
            completionMode: "first-stable",
          },
        },
      },
      runDir: dir,
      fetchImpl: makeMockFetch({ assistantDelayMs: 800 }),
      waitTimeout: 300,
      pollInterval: 20,
    });

    // 自然终态：completed（不是 timed_out，不是 failed）。
    assert.equal(result.completed, true, `慢 worker 应自然 completed，实际 ${JSON.stringify(result)}`);
    assert.equal(result.timedOut, false, "到期不得产生 timed_out");
    assert.equal(result.failed, false);
    assert.equal(result.observationDeadlineReached, true,
      "到期事实应在 runner 结果上可见（observationDeadlineReached:true）");

    const events = await readTranscript(path.join(dir, `${result.runId}.jsonl`));
    const state = findState(events);
    assert.equal(state, "completed", "transcript 终态应为自然 completed");

    // 通知事实钉：恰一条、载荷有界。
    const facts = events.filter((e) => e.type === "run.observation_deadline_reached");
    assert.equal(facts.length, 1, "run.observation_deadline_reached 恰一条");
    assert.equal(facts[0].waitTimeoutMs, 300);
    assert.equal(facts[0].source, "explicit");

    // 无终止性事件：到期没有杀 worker。
    assert.equal(events.some((e) => e.type === "run.timed_out"), false,
      "到期不得写 run.timed_out（后台不杀钉）");
    assert.equal(events.some((e) => e.type === "run.state_change" && e.to === "timed_out"), false);
    assert.equal(events.some((e) => e.type === "run.aborted"), false,
      "到期不得产生 abort 终态");
    // 活过 deadline 的时序证明：到期事实的 ts 早于终态转移的 ts。
    const terminalChange = events.find((e) => e.type === "run.state_change" && e.to === "completed");
    assert.ok(facts[0].seq < terminalChange.seq,
      "到期事实必须先于自然终态落盘（worker 在 deadline 之后仍在干活）");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 钉 2：resume 托管（TD-148 姊妹脸 (a)）────────────────────────────────────
test("TD-151 resume 托管钉: runResumeBackground 驱动续跑到自然终态 + 心跳配套", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-td151-res-"));
  try {
    // 手工构造一个可续接（非终态）的 transcript：与 manager.resume 的绑定读取纪律
    // 对齐（run.started / session.created / prompt.sent 各就位，状态 submitted）。
    const runId = "run_td151_resumable";
    const transcript = new JsonlTranscript(path.join(dir, `${runId}.jsonl`), {
      runId, agentId: "res_worker",
    });
    await transcript.append("run.started", { backend: "claude-code", cwd: dir });
    await transcript.append("session.created", { backendSessionId: "proc_td151_resume_old" });
    await transcript.append("prompt.sent", { prompt: "resume me" });
    await transcript.append("run.submitted", {});
    await transcript.append("run.state_change", { from: "pending", to: "submitted", reason: "spawned" });

    // replayByRespawn 假 backend：重放 prompt 后快速自然完成（跨过一个小 deadline）。
    const replayBackend = {
      replayByRespawn: true,
      async spawn() {
        return {
          backend: "process",
          backendSessionId: "proc_td151_resume_new",
          async *events() {
            yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "resumed and done" }] };
            await new Promise((r) => setTimeout(r, 120)); // > waitTimeout 40
            yield { kind: "done", reason: "completed" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };

    const result = await runResumeBackground({
      runId,
      registry: { agents: { res_worker: { backend: "claude-code", cwd: dir } } },
      runDir: dir,
      waitTimeout: 40,
      pollInterval: 10,
      backendFor: () => replayBackend,
    });

    assert.equal(result.resumed, true, `应成功接管续跑，实际 ${JSON.stringify(result)}`);
    assert.equal(result.completed, true, "续跑应驱动到自然 completed");
    assert.equal(result.timedOut, false);
    assert.equal(result.observationDeadlineReached, true,
      "resume 续跑里的到期同样只是通知（事实可见）");

    const events = await readTranscript(path.join(dir, `${runId}.jsonl`));
    assert.equal(findState(events), "completed");
    assert.ok(events.some((e) => e.type === "run.rerun"), "重放分支应写 run.rerun");
    assert.ok(events.some((e) => e.type === "run.observation_deadline_reached"),
      "续跑中的等待窗到期事实应落盘");
    assert.equal(events.some((e) => e.type === "run.timed_out"), false);
    // 心跳清理：runner 退出后 .owner-<runId> 必须已删（daemon 判活不劫持死 runner）。
    assert.equal(existsSync(path.join(dir, `.owner-${runId}`)), false,
      "runner 退出后 ownership 心跳文件必须清理");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-151 resume 托管钉: 终态 run → resumed:false（拒绝形状，零续跑）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-td151-resterm-"));
  try {
    const runId = "run_td151_terminal";
    const transcript = new JsonlTranscript(path.join(dir, `${runId}.jsonl`), {
      runId, agentId: "res_worker",
    });
    await transcript.append("run.started", { backend: "claude-code", cwd: dir });
    await transcript.append("session.created", { backendSessionId: "proc_td151_term" });
    await transcript.append("prompt.sent", { prompt: "done long ago" });
    await transcript.append("run.completed", {});
    await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });

    const result = await runResumeBackground({
      runId,
      registry: { agents: { res_worker: { backend: "claude-code", cwd: dir } } },
      runDir: dir,
      backendFor: () => { throw new Error("must not spawn for a terminal run"); },
    });
    assert.equal(result.resumed, false);
    assert.equal(result.reason, "terminal or not found");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 终审回归钉：resume 失败事实必须落"本 run 转录"（绑定字段在场），不写工作目录裸文件
test("终审钉: resume 拒绝的持久失败事实落本 run 转录且带绑定上下文（不写裸文件）", async () => {
  const { runResumeBackground } = await import("../../src/backgroundRunner.js");
  const { readTranscript } = await import("../../src/transcript.js");
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = process.cwd();
  const runDir = mkdtempSync(join(tmpdir(), "wao-fin-"));
  try {
    // 转录有终态事实（bound）→ 权威 resume 拒绝 → 持久失败事实应落转录
    const runId = "run_fin_probe";
    const { JsonlTranscript } = await import("../../src/transcript.js");
    const tr = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId: "x" });
    await tr.append("run.state_change", { from: null, to: "completed", reason: "done" });
    const r = await runResumeBackground({ runId, runDir, registry: { agents: {} } });
    assert.equal(r.resumed, false);
    const events = await readTranscript(join(runDir, `${runId}.jsonl`));
    const err = events.find((e) => e.type === "run.error" && e.phase === "resume");
    assert.ok(err, "持久失败事实必须落本 run 转录");
    assert.equal(err.runId, runId, "绑定字段在场（写入经 JsonlTranscript 信封）");
    assert.equal(existsSync(join(cwd, runId)), false, "不写工作目录裸文件（终审抓到的构造参数误用回归）");
  } finally {
    rmSync(join(cwd, "run_fin_probe"), { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
