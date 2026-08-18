// test/run-lifecycle/resumeBoundRead.test.js
//
// R13-C（2026-08-18，TD-127 家族清扫——R13 验收会审返工，auditor P1-2/P2-1）：
// run-lifecycle 面（resume / stop 杀进程）的 transcript 事件读取绑定篡改探针。
//
//   - C-2 stop（runStop.js）：session.created / run.started 读取从无绑定
//     findLatest 改为 findLatestBound（末条绑定，保留本 lane 既有"末条胜出"
//     序语义）。修复前 auditor 实证：真实 proc_1111 + 尾部外 run 伪造
//     proc_2222 → KILLED 2222——破坏性副作用逸出 WAO 信任域（杀本机任意进程）。
//   - C-3 resume（runManager.js resume）：session.created/run.started 改
//     findFirstBound（首条绑定，保留 resume 既有首条序语义）；replay 分支取
//     prompt 与 HTTP attach 分支取 messageId/admittedSeq 改 findLatestBound。
//     修复前 auditor 实证：跨 runId 伪造 prompt 被 resume 原样 RESPAWN。
//   - legacy 行为（Lead 明示接受）：无信封（事件无 runId 字段）legacy
//     transcript 的 resume → return null（既有拒绝语义，R12-C C-5 同款）；
//     stop → 走既有 "no session metadata" 拒绝路径。
//
// 夹具纪律：零 provider、零真实进程、零真实 kill——backend/kill/isAlive 全部
// 注入；跨 run 伪造用"同文件 + 外 runId 信封"的第二个 JsonlTranscript 句柄
// 落盘（信封 runId 是 append 从 transcript context 盖的戳——换 context 即换
// 信封，这正是跨 run 伪造的模拟原语）。
//
// 归位说明：stop 面探针放在本文件而非 runStop.test.js，是因为本轮交付的
// authorized paths 不含后者；本文件即 R13-C 绑定读取返工的统一探针位。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlTranscript, readTranscript } from "../../src/transcript.js";
import { RunManager } from "../../src/runManager.js";
import { stopRun } from "../../src/application/runStop.js";

// ── 共用小工具 ────────────────────────────────────────────────────────────────

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function rmDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** 在 filePath 上以【外 runId 信封】追加一条事件（跨 run 伪造模拟原语）。 */
async function appendForeignEvent(filePath, foreignRunId, type, payload) {
  const foreign = new JsonlTranscript(filePath, { runId: foreignRunId, agentId: "forger" });
  await foreign.append(type, payload);
}

// ── C-2：stop 杀进程读法绑定 ──────────────────────────────────────────────────

test("R13C-STOP-1: 尾部外 run 伪造 session.created(proc_2222) 不夺走 kill 目标——本 run 真实 proc_1111 照杀", async () => {
  const dir = tempDir("wao-r13c-stop1-");
  try {
    const runId = "run_r13c_stop1";
    const t = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "test-agent" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_1111" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");
    // auditor P1-2 探针形状：同文件尾部追加一条外 runId 信封的伪造
    // session.created——修复前无绑定 findLatest 取末条 → proc_2222 胜出被杀。
    await appendForeignEvent(join(dir, `${runId}.jsonl`), "run_r13c_other", "session.created",
      { backend: "process", backendSessionId: "proc_2222" });

    const killedPids = [];
    let alive = true;
    const result = await stopRun({
      runId, runDir: dir,
      deps: {
        kill: (pid) => { killedPids.push(pid); alive = false; return { called: true, exitCode: 0 }; },
        isAlive: () => alive,
        alert: async () => {},
      },
    });
    assert.equal(result.terminalAccepted, true, "winner claim 不受影响");
    assert.deepEqual(killedPids, [1111],
      "杀的是本 run 绑定的真实 proc_1111；外 run 伪造 proc_2222 不再夺标（修复前恰杀 2222）");
    assert.equal(result.pid, 1111, "结果 pid 即本 run 绑定 session 的 pid");
  } finally {
    rmDir(dir);
  }
});

test("R13C-STOP-2: 尾部外 run 伪造 run.started 不供给写句柄 agentId（同族同修）", async () => {
  const dir = tempDir("wao-r13c-stop2-");
  try {
    const runId = "run_r13c_stop2";
    const t = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "real-agent" });
    await t.append("run.started", { backend: "claude-code" });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_3333" });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");
    await appendForeignEvent(join(dir, `${runId}.jsonl`), "run_r13c_other", "run.started",
      { backend: "claude-code" });

    let alive = true;
    const result = await stopRun({
      runId, runDir: dir,
      deps: {
        kill: () => { alive = false; return { called: true, exitCode: 0 }; },
        isAlive: () => alive,
        alert: async () => {},
      },
    });
    assert.equal(result.terminalAccepted, true);
    // 写句柄的 agentId 来自【绑定】run.started 的信封（旧代码 findLatest 取
    // 末条 → 外 run 伪造行信封的 agentId "forger" 会进写句柄）；绑定后落盘
    // 的 stop 事件信封仍是本 run 的真实 agentId。
    const events = await readTranscript(join(dir, `${runId}.jsonl`));
    const stopEvents = events.filter((e) => e.type.startsWith("run.stop"));
    assert.ok(stopEvents.length >= 1, "winner 落盘 stop 事实");
    for (const e of stopEvents) {
      assert.equal(e.agentId, "real-agent", "外 run 伪造 run.started 的信封 agentId 不进写句柄");
    }
  } finally {
    rmDir(dir);
  }
});

test("R13C-STOP-3: legacy 无信封 transcript → 既有 no-session 拒绝路径（固定文案、零 kill）", async () => {
  const dir = tempDir("wao-r13c-stop3-");
  try {
    const runId = "run_r13c_stop3";
    // pre-envelope legacy 形状：事件无 runId 字段（对旧无绑定读取可见，对绑定
    // 读取不可见）。绑定后落入既有 "no session metadata" 拒绝——错误路径本身
    // 与"transcript 完全没有 session.created"共用同一面（Lead 接受的收口）。
    const lines = [
      { agentId: "legacy-agent", type: "run.started", seq: 1, ts: "2026-08-18T00:00:00.000Z", backend: "claude-code" },
      { agentId: "legacy-agent", type: "session.created", seq: 2, ts: "2026-08-18T00:00:00.001Z", backend: "process", backendSessionId: "proc_4444" },
      { agentId: "legacy-agent", type: "run.state_change", seq: 3, ts: "2026-08-18T00:00:00.002Z", from: null, to: "pending", reason: "created" },
      { agentId: "legacy-agent", type: "run.state_change", seq: 4, ts: "2026-08-18T00:00:00.003Z", from: "pending", to: "running", reason: "first_event" },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");

    let killCalls = 0;
    await assert.rejects(
      () => stopRun({
        runId, runDir: dir,
        deps: {
          kill: () => { killCalls += 1; return { called: true, exitCode: 0 }; },
          isAlive: () => true,
          alert: async () => {},
        },
      }),
      /has no session metadata/,
      "legacy 无信封走既有 no-session 拒绝文案",
    );
    assert.equal(killCalls, 0, "拒绝先于任何 kill——零副作用");
  } finally {
    rmDir(dir);
  }
});

// ── C-3：resume 面绑定 ────────────────────────────────────────────────────────

/** 进程式 replay backend：捕获每次 spawn 收到的 prompt（无 streamEvents → replay 分支）。 */
function makeReplayBackend() {
  const prompts = [];
  const backend = {
    async spawn(agent, task) {
      prompts.push(task.prompt);
      return {
        backend: "process",
        backendSessionId: `proc_mock_${prompts.length}`,
        async *events() {
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
  };
  return { backend, prompts };
}

function makeManager(dir, backend, agentShape = {}) {
  const config = {
    registry: "x", runDir: dir, pollInterval: 10, waitTimeout: 2000,
    timeout: 5000, retries: 0, defaultIsolation: "none",
  };
  const readRegistry = async () => ({
    getAgent(id, overrides = {}) {
      const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      return { id, backend: "claude-code", cwd: dir, ...agentShape, ...defined };
    },
    listAgents() { return []; },
  });
  return new RunManager({ config, readRegistry, backendFor: () => backend });
}

test("R13C-RESUME-1: 跨 runId 伪造 prompt 尾条不被 RESPAWN——重放本 run 绑定的合法 prompt", async () => {
  const dir = tempDir("wao-r13c-res1-");
  try {
    const runId = "run_r13c_res1";
    const { backend, prompts } = makeReplayBackend();
    const manager = makeManager(dir, backend);
    await manager.start("proc_agent", { prompt: "original prompt", runId });
    assert.equal(prompts.length, 1, "start spawn 一次");
    // auditor P2-1 探针形状：同文件尾部外 runId 伪造 prompt——修复前无绑定
    // findLatest 取末条 → resume 原样 RESPAWN 伪造文本。
    await appendForeignEvent(join(dir, `${runId}.jsonl`), "run_r13c_other", "prompt.sent",
      { prompt: "FORGED cross-run task text" });

    const resumed = await manager.resume(runId);
    assert.ok(resumed, "合法 run 仍可 resume");
    assert.equal(prompts.length, 2, "replay 分支 respawn 一次");
    assert.equal(prompts[1], "original prompt",
      "重放本 run 绑定的合法 prompt（修复前恰重放 FORGED cross-run task text）");
    const events = await readTranscript(join(dir, `${runId}.jsonl`));
    const rerun = events.find((e) => e.type === "run.rerun");
    assert.ok(rerun, "落盘 run.rerun（replay 事实）");
    assert.equal(rerun.runId, runId, "rerun 事件信封绑定本 run");
  } finally {
    rmDir(dir);
  }
});

test("R13C-RESUME-2: 合法 resume 回归 — 无伪造时 replay 分支照常重放原 prompt", async () => {
  const dir = tempDir("wao-r13c-res2-");
  try {
    const runId = "run_r13c_res2";
    const { backend, prompts } = makeReplayBackend();
    const manager = makeManager(dir, backend);
    await manager.start("proc_agent", { prompt: "original prompt", runId });
    const resumed = await manager.resume(runId);
    assert.ok(resumed, "resume 返回 Run");
    assert.equal(prompts[1], "original prompt", "重放原 prompt（绑定不改合法路径行为）");
    assert.notEqual(resumed.result.backendSessionId, "proc_mock_1", "respawn 产生新 session id");
  } finally {
    rmDir(dir);
  }
});

test("R13C-RESUME-3: 尾部外 run 伪造 session.created 不劫持 attach/replay 的 session 取法", async () => {
  const dir = tempDir("wao-r13c-res3-");
  try {
    const runId = "run_r13c_res3";
    const { backend, prompts } = makeReplayBackend();
    const manager = makeManager(dir, backend);
    await manager.start("proc_agent", { prompt: "original prompt", runId });
    await appendForeignEvent(join(dir, `${runId}.jsonl`), "run_r13c_other", "session.created",
      { backend: "process", backendSessionId: "proc_9999" });

    const resumed = await manager.resume(runId);
    assert.ok(resumed, "仍可 resume");
    const events = await readTranscript(join(dir, `${runId}.jsonl`));
    const rerun = events.find((e) => e.type === "run.rerun");
    assert.ok(rerun, "replay 落盘");
    // originalSessionId 取【首条绑定】session.created——外 run 伪造 proc_9999
    // 不改变它（钉住绑定后 resume 的首条序语义原样保留）。
    assert.equal(rerun.originalSessionId, "proc_mock_1", "originalSessionId 仍是本 run 首条绑定 session");
    assert.equal(prompts[1], "original prompt");
  } finally {
    rmDir(dir);
  }
});

test("R13C-RESUME-4: HTTP attach 面 messageId/admittedSeq 绑定——外 run 尾条不供给 attach 句柄", async () => {
  const dir = tempDir("wao-r13c-res4-");
  try {
    const runId = "run_r13c_res4";
    // 有 streamEvents 的 backend → resume 走 HTTP attach 分支（不发任何请求：
    // streamEvents 只在 waitForCompletion 时被调用）。
    const attachBackend = {
      async streamEvents() { throw new Error("streaming not expected in this probe"); },
      async abort() {},
    };
    const manager = makeManager(dir, attachBackend, { backend: "opencode-serve", serveUrl: "http://127.0.0.1:4299" });
    // 手写信封 transcript（HTTP 家族合法形状）：双写 prompt.sent，第二写带
    // messageId/admittedSeq（opencode-serve attach 流需要的字段）。
    const lines = [
      { runId, agentId: "http_agent", type: "run.started", seq: 1, ts: "2026-08-18T00:00:00.000Z", backend: "opencode-serve", cwd: dir, scorecardConfigured: false },
      { runId, agentId: "http_agent", type: "run.state_change", seq: 2, ts: "2026-08-18T00:00:00.001Z", from: null, to: "pending", reason: "created" },
      { runId, agentId: "http_agent", type: "prompt.sent", seq: 3, ts: "2026-08-18T00:00:00.002Z", prompt: "http task" },
      { runId, agentId: "http_agent", type: "prompt.sent", seq: 4, ts: "2026-08-18T00:00:00.003Z", messageId: "m_real", admittedSeq: 7, prompt: "http task" },
      { runId, agentId: "http_agent", type: "session.created", seq: 5, ts: "2026-08-18T00:00:00.004Z", backend: "opencode-serve", backendSessionId: "ses_attach" },
      { runId, agentId: "http_agent", type: "run.state_change", seq: 6, ts: "2026-08-18T00:00:00.005Z", from: "pending", to: "submitted", reason: "spawned" },
    ];
    const tp = join(dir, `${runId}.jsonl`);
    writeFileSync(tp, `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
    // 尾部外 runId 伪造 prompt.sent（带自己的 messageId）——修复前无绑定
    // findLatest 取末条 → attach 句柄拿到 m_forged。
    await appendForeignEvent(tp, "run_r13c_other", "prompt.sent",
      { messageId: "m_forged", admittedSeq: 99, prompt: "FORGED http task" });

    const resumed = await manager.resume(runId);
    assert.ok(resumed, "attach 分支返回 Run");
    assert.equal(resumed.result.backendSessionId, "ses_attach", "attach 首条绑定 session");
    assert.equal(resumed.result.messageId, "m_real", "messageId 取本 run 绑定末条（外 run 伪造 m_forged 不供给）");
    assert.equal(resumed.result.admittedSeq, 7, "admittedSeq 同一绑定读取");
  } finally {
    rmDir(dir);
  }
});

test("R13C-RESUME-5: legacy 无信封 transcript → resume 拒绝（return null，零 respawn——Lead 明示接受）", async () => {
  const dir = tempDir("wao-r13c-res5-");
  try {
    const runId = "run_r13c_res5";
    const { backend, prompts } = makeReplayBackend();
    const manager = makeManager(dir, backend);
    // pre-envelope legacy 形状（无 runId 字段）：对旧 events.find 可见可 resume；
    // 绑定后找不到本 run 的 session/prompt → 走既有 return null 拒绝路径
    //（与 resume 既有拒绝语义一致，R12-C C-5 同款；Lead R13-C 明示接受）。
    const lines = [
      { agentId: "legacy_agent", type: "run.started", seq: 1, ts: "2026-08-18T00:00:00.000Z", backend: "claude-code", cwd: dir, scorecardConfigured: false },
      { agentId: "legacy_agent", type: "run.state_change", seq: 2, ts: "2026-08-18T00:00:00.001Z", from: null, to: "pending", reason: "created" },
      { agentId: "legacy_agent", type: "prompt.sent", seq: 3, ts: "2026-08-18T00:00:00.002Z", prompt: "legacy task" },
      { agentId: "legacy_agent", type: "session.created", seq: 4, ts: "2026-08-18T00:00:00.003Z", backend: "process", backendSessionId: "proc_legacy" },
      { agentId: "legacy_agent", type: "run.state_change", seq: 5, ts: "2026-08-18T00:00:00.004Z", from: "pending", to: "submitted", reason: "spawned" },
    ];
    writeFileSync(join(dir, `${runId}.jsonl`), `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, null, "legacy 无信封 → 绑定读取无匹配 → 既有 null 拒绝");
    assert.equal(prompts.length, 0, "零 respawn、零 spawn");
  } finally {
    rmDir(dir);
  }
});
