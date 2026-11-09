import test, { before, after } from "node:test";
import { resolveTranscriptPath } from "../../src/projectBuckets.js";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { writeFileSync as _writeFileSync, existsSync } from "node:fs";
import path, { join as _join } from "node:path";
import { execSync } from "node:child_process";
import { runBackground, parseSimpleFlags } from "../../src/backgroundRunner.js";
import { cleanupRunnerStderrOnExit, armRunnerStderrCleanup } from "../../src/backgroundRunner.js";
import { readTranscript, findState } from "../../src/transcript.js";
import { rmrfRetry } from "../_rmrfHelper.mjs";
import {
  runServer,
  envelope,
  detailEnvelope,
  transcriptEnvelope,
  turnItem,
  stepItem,
  KIMI_TEST_SERVE_URL,
  KIMI_TEST_TOKEN_ENV,
  KIMI_TEST_TOKEN_VALUE,
} from "../fixtures/kimiWebServe.js";

// kimi-web 假服务器（现行唯一 serve 家族后端）+ 假 bearer，绝不发真实请求。
before(() => {
  process.env[KIMI_TEST_TOKEN_ENV] = KIMI_TEST_TOKEN_VALUE;
});
after(() => {
  delete process.env[KIMI_TEST_TOKEN_ENV];
});

// --- P2 后台生命周期接管（watchdog / detached runner）---
// 06-18 事故架构洞：fire-and-forget spawn 的孤儿会话脱离任何 WAO 进程，所有防线
// （token 闸门/事件轮询/兜底 abort）全活在 waitForCompletion 内部，孤儿会话无人消费→失控。
// P2 解法：detached runner 进程拥有 worker handle，驱动 waitForCompletion（含闸门+abort），
// 写共享 transcript。CLI fork runner 后拿 runId 返回，runner 独立活到 run 结束。
// 本测试验证进程内核心函数 runBackground：驱动完一个 run + 状态机推进 + transcript 完整。

function makeMockFetch({ assistantDelayMs = 0 } = {}) {
  // kimi-web 假服务器（提交后 assistantDelayMs 毫秒
  // "bg done" 才出现在 transcript 轮里——延迟挂轮询，不挂提交）。
  return runServer(KIMI_TEST_SERVE_URL, { delayMs: assistantDelayMs, replies: ["bg done"] }).fetchImpl;
}

test("P2 runBackground: 驱动 run 到 completed，状态机推进，transcript 完整", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-"));
  try {
    const result = await runBackground({
      agentId: "bg_agent",
      prompt: "do it",
      registry: { agents: { bg_agent: { backend: "kimi-web", serveUrl: KIMI_TEST_SERVE_URL, cwd: dir, model: { id: "kimi-code/k3" }, tokenEnv: KIMI_TEST_TOKEN_ENV } } },
      runDir: dir,
      fetchImpl: makeMockFetch(),
      waitTimeout: 3000,
      pollInterval: 10,
    });
    assert.ok(result.runId, "应返回 runId");
    assert.equal(result.completed, true, "应驱动到 completed");

    // transcript 完整：状态机推进到 completed
    const events = await readTranscript(path.join(dir, `${result.runId}.jsonl`));
    const state = findState(events);
    assert.equal(state, "completed", "transcript 最终状态应为 completed");
    const transitions = events.filter((e) => e.type === "run.state_change").map((e) => `${e.from}→${e.to}`);
    assert.ok(transitions.includes("submitted→running"), "应推进到 running（说明有人消费事件流）");
    assert.ok(transitions.some((t) => t.endsWith("→completed")), "应推进到 completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// TD-151（ADR-0030）迁移：原断言"worker 永久静默 → 超时兜底 → 终态 failed/timed_out"。
// 到期不再终止——"永久静默 + 无 silentTimeout"在新语义下是受监督的长跑（终止只剩
// Lead stop / 硬安全线），永静默形状不再有终态可等。改为钉新语义（也是 TD-148 主害
// 的 in-process 版）：等待窗先到、慢回复后到 → runner 活过 deadline 监督到自然终态。
test("P2 runBackground（TD-151 迁移）: 小 waitTimeout + 慢 worker → 到期只记事实，监督到自然终态", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-slow-"));
  try {
    // 慢回复：assistant 在 deadline（waitTimeout 300）之后 500ms 才出现。
    const result = await runBackground({
      agentId: "bg_slow",
      prompt: "x",
      registry: { agents: { bg_slow: { backend: "kimi-web", serveUrl: KIMI_TEST_SERVE_URL, cwd: dir, model: { id: "kimi-code/k3" }, tokenEnv: KIMI_TEST_TOKEN_ENV } } },
      runDir: dir,
      fetchImpl: makeMockFetch({ assistantDelayMs: 500 }),
      waitTimeout: 300,
      pollInterval: 20,
    });
    assert.ok(result.runId);
    // 到期不杀：慢 worker 跨过 deadline 自然完成，终态不是 timed_out。
    assert.equal(result.completed, true, `慢 worker 应自然 completed，实际 ${JSON.stringify(result)}`);
    assert.equal(result.timedOut, false);
    assert.equal(result.observationDeadlineReached, true, "到期事实应在结果可见");
    const events = await readTranscript(path.join(dir, `${result.runId}.jsonl`));
    const state = findState(events);
    assert.equal(state, "completed", "runner 监督到自然终态（不卡 submitted、不伪造 timed_out）");
    const deadlineFacts = events.filter((e) => e.type === "run.observation_deadline_reached");
    assert.equal(deadlineFacts.length, 1, "到期事实恰一条");
    assert.equal(deadlineFacts[0].waitTimeoutMs, 300);
    assert.equal(events.some((e) => e.type === "run.timed_out"), false, "到期不得写 run.timed_out");
    assert.equal(events.some((e) => e.type === "run.aborted"), false, "到期不得产生 abort 终态");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- P2 CLI --background：detached runner 接管生命周期（不再卡 submitted，不再孤儿）---
// 验证：run --background 立即返回 background JSON（runId + background:true），
// 且 detached runner 进程把状态机推进到终态（写 transcript），证明它 owns 生命周期。
test("P2 CLI --background: 立即返回 + detached runner 推进状态机到终态", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-cli-"));
  try {
    const registryPath = path.join(dir, "agents.json");
    await writeFile(registryPath, JSON.stringify({
      // binary 不存在 → runner 会 spawn_error → 快速 failed（证明 runner 接管并推进状态）
      agents: { bgw: { backend: "claude-code", binary: "nonexistent-binary-xyz", cwd: dir, args: ["--dangerously-skip-permissions"] } },
    }));
    const runDir = path.join(dir, "runs");

    // CLI --background：应立即返回 background JSON（多行 pretty-printed）
    // 用仓库选定的 Node v22 执行边界（scripts/wao-node.cjs shim）启动 CLI，而非
    // 环境 PATH 的 node（本机为 v24，会被 product versionGuard 拒绝）。shim 透传 argv
    // 到 v22 node，guard 自然通过——不设全局 bypass、不削弱 guard。
    const out = execSync(
      `node scripts/wao-node.cjs src/cli.js run bgw --prompt "x" --background --run-dir ${runDir} --registry ${registryPath} --wait-timeout 2000 --format json`,
      { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 10000 },
    );
    // 整块是 pretty JSON，从第一个 { 到最后一个 } 解析
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    const parsed = JSON.parse(out.slice(start, end + 1));
    assert.equal(parsed.background, true, "应标记 background:true");
    assert.ok(parsed.runId, "应返回 runId");
    assert.match(parsed.note ?? "", /detached runner owns lifecycle/i, "应说明 runner 接管生命周期");

    // 等 detached runner 进程推进状态机（binary 不存在会快速 failed）
    const transcriptPath = resolveTranscriptPath(runDir, parsed.runId);
    let state = null;
    for (let i = 0; i < 40; i += 1) {
      if (existsSync(transcriptPath)) {
        const events = await readTranscript(transcriptPath);
        state = findState(events);
        if (state && state !== "pending" && state !== "submitted") break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(state, "detached runner 应写 transcript");
    assert.ok(["failed", "completed", "timed_out"].includes(state),
      `runner 应推进到终态（非卡 submitted），实际 ${state}`);

    // 终态出现后 runner 还在追加转录，写完才删 .owner-<runId>。等它删掉再清目录，
    // 否则 rm 会与最后几次追加竞态（ENOTEMPTY，10-29 全量里出现过）。
    const ownerPath = path.join(runDir, `.owner-${parsed.runId}`);
    for (let i = 0; i < 100 && existsSync(ownerPath); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(existsSync(ownerPath), false, "runner 写完转录后应删 owner 文件");
  } finally {
    rmrfRetry(dir);
  }
});

// --- D-F3 修复：P2 runner 写 ownership 心跳文件 ---
// daemon --resume-on-start 用 owner 心跳判活，避免劫持 P2 runner 还在驱动的 run。
// runner 启动写 .owner-<runId>，存活期间更新心跳，退出删。本测试验证写（运行中）+ 删（完成后）。

test("D-F3: runBackground 运行中写 ownership 文件，完成后删", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-owner-"));
  try {
    // slow mock：transcript 轮先空跑几拍（turn 在 running，让 run 卡 running），
    // 第 4 拍起 completed 带 assistant 文本（让 run 完成）——这样能在 run 进行中
    // 观测到 ownership 文件。
    // 停止验证三面必须可观察且稳定（sessionStatus/detail 投影 idle + 稳定 messages）：
    // 缺席（40401/抛错）时 verifyStopQuiet 判 unavailable → 写 run.stop_unverified，
    // 且 raiseAlert 是 fire-and-forget，会在 runBackground 返回后异步写 ALERTS.log，
    // 与 finally 的 rm(dir) 竞态。补齐三面让 stop 验证走真实 quiet 判定 → stop_verified。
    // （本测试的会话在终态后仍可探测——与共享 runServer 的"终态即删"形状不同，
    // 这里钉的就是可观察 quiet。）
    const sessionSlow = `${KIMI_TEST_SERVE_URL}/api/v1/sessions/session_slow`;
    let polls = 0;
    let submitted = false;
    const slowFetch = async (url, init = {}) => {
      const urlStr = String(url);
      const method = init.method ?? "GET";
      if (method === "POST" && urlStr === `${KIMI_TEST_SERVE_URL}/api/v1/sessions`) {
        return envelope({ id: "session_slow" });
      }
      if (method === "GET" && urlStr === sessionSlow) {
        return detailEnvelope("session_slow", false, false, null);
      }
      if (method === "GET" && urlStr === `${sessionSlow}/messages`) {
        return envelope({ items: [] });
      }
      if (method === "GET" && urlStr === `${sessionSlow}/transcript?agent_id=main`) {
        if (!submitted) return transcriptEnvelope([]);
        polls += 1;
        const done = polls > 3;
        return transcriptEnvelope([turnItem({
          turnId: "t0",
          triggerPromptId: "msg_slow",
          state: done ? "completed" : "running",
          steps: done ? [stepItem({ frames: [{ kind: "text", text: "done", role: "assistant" }] })] : [],
        })]);
      }
      if (method === "POST" && urlStr.endsWith(`${sessionSlow}/prompts`)) {
        submitted = true;
        return envelope({ prompt_id: "msg_slow", status: "running" });
      }
      if (method === "GET" && urlStr === `${sessionSlow}/prompts`) {
        return envelope({ active: polls > 3 ? null : { prompt_id: "msg_slow" }, queued: [] });
      }
      if (method === "POST" && urlStr === `${sessionSlow}/prompts/msg_slow:abort`) {
        return envelope({ aborted: true });
      }
      throw new Error(`unexpected request ${urlStr}`);
    };

    let runIdObserved = null;
    let ownerSeenDuringRun = false;
    const runPromise = runBackground({
      agentId: "owner_agent",
      prompt: "do it",
      registry: { agents: { owner_agent: { backend: "kimi-web", serveUrl: KIMI_TEST_SERVE_URL, cwd: dir, model: { id: "kimi-code/k3" }, tokenEnv: KIMI_TEST_TOKEN_ENV } } },
      runDir: dir,
      fetchImpl: slowFetch,
      waitTimeout: 5000,
      pollInterval: 20,
    });

    // runId 在 runBackground 返回时才知道，但 transcript 文件名能反推。轮询看 ownership 文件出现。
    for (let i = 0; i < 100; i += 1) {
      const files = await import("node:fs/promises").then((m) => m.readdir(dir));
      const ownerFile = files.find((f) => f.startsWith(".owner-"));
      if (ownerFile) { ownerSeenDuringRun = true; runIdObserved = ownerFile.replace(/^\.owner-/, ""); break; }
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(ownerSeenDuringRun, "runBackground 运行中应写 ownership 文件（.owner-<runId>）");

    const result = await runPromise;
    // run 自然完成（慢消息推进后 completed）——补齐 fixture 后停验证才有意义。
    assert.equal(result.completed, true, `run 应自然 completed，实际 ${JSON.stringify(result)}`);

    // 实际 stop_verified 证据：三面 fixture 必须真的让停验证观察到 quiet。
    // 若意外回到 unavailable（如误 404），run 会静默落 stop_unverified + 异步告警，
    // 此处必须失败而不是靠 rm 竞态碰运气。
    const events = await readTranscript(path.join(dir, `${result.runId}.jsonl`));
    const stopVerified = events.find((e) => e.type === "run.stop_verified");
    assert.ok(stopVerified, "transcript 应有 run.stop_verified（停验证观察到 quiet）");
    assert.equal(stopVerified.backendSessionId, "session_slow", "stop_verified 绑定本 run 的 session");
    assert.equal(events.some((e) => e.type === "run.stop_unverified"), false,
      "不得回到 stop_unverified（unavailable 告警路径）");
    assert.equal(existsSync(path.join(dir, "ALERTS.log")), false,
      "stop 验证通过时不应写 ALERTS.log");

    // 完成后 ownership 文件应删（runner finally 清理）
    const ownerPath = path.join(dir, `.owner-${result.runId}`);
    assert.equal(existsSync(ownerPath), false, "runBackground 完成后应删 ownership 文件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-54: runBackground 启动失败也写 failed transcript（不产生 ghost run）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-startfail-"));
  const runId = "run_startfail_known";
  try {
    const result = await runBackground({
      agentId: "missing_agent",
      prompt: "x",
      registry: { agents: {} },
      runDir: dir,
      runId,
      waitTimeout: 1000,
      pollInterval: 10,
    });
    assert.equal(result.runId, runId);
    assert.equal(result.failed, true, "启动失败应返回 failed:true");
    assert.match(result.error ?? "", /Unknown agent|missing_agent/, "错误应说明 agent 不存在");

    const transcriptPath = resolveTranscriptPath(dir, runId);
    assert.ok(existsSync(transcriptPath), "启动失败也必须留下 transcript，不能 ghost");
    const events = await readTranscript(transcriptPath);
    assert.equal(findState(events), "failed", "启动失败 transcript 最终态应为 failed");
    assert.ok(events.some((e) => e.type === "run.error" && /Unknown agent|missing_agent/.test(e.error ?? e.detail ?? "")),
      "transcript 应记录启动失败原因");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// M12-6 (P1-A): the detached runner threads the server-proven frozenGitHead to
// RunManager.start. A HEAD that moved between the dispatch proof and run start
// must fail the run CLOSED (no worker session), proving the full
// argv → backgroundRunner → RunManager.start chain carries the frozen head.
test("M12-6 P1-A: runBackground threads frozenGitHead; stale HEAD fails the run before worker spawn", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "wao-bg-p1a-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-p1a-runs-"));
  try {
    execSync("git init -b main", { cwd: repo, stdio: "ignore" });
    execSync('git config user.email "t@t"', { cwd: repo, stdio: "ignore" });
    execSync('git config user.name "t"', { cwd: repo, stdio: "ignore" });
    await writeFile(path.join(repo, "README.md"), "# t\n");
    execSync("git add .", { cwd: repo, stdio: "ignore" });
    execSync('git commit -m init', { cwd: repo, stdio: "ignore" });
    const frozen = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    // Mutate HEAD after the (simulated) dispatch proof froze it.
    await writeFile(path.join(repo, "next.md"), "# n\n");
    execSync("git add .", { cwd: repo, stdio: "ignore" });
    execSync('git commit -m next', { cwd: repo, stdio: "ignore" });

    let sessionCreations = 0;
    const baseFetch = makeMockFetch();
    const countingFetch = async (url, init = {}) => {
      if (init.method === "POST" && String(url).endsWith("/api/v1/sessions")) sessionCreations += 1;
      return baseFetch(url, init);
    };

    const result = await runBackground({
      agentId: "bg_p1a",
      prompt: "x",
      cwd: repo,
      frozenGitHead: frozen,
      registry: { agents: { bg_p1a: { backend: "kimi-web", serveUrl: KIMI_TEST_SERVE_URL, cwd: repo, model: { id: "kimi-code/k3" }, tokenEnv: KIMI_TEST_TOKEN_ENV } } },
      runDir,
      fetchImpl: countingFetch,
      waitTimeout: 1000,
      pollInterval: 10,
    });
    assert.equal(result.failed, true, "stale frozen head fails the run");
    assert.match(result.error ?? "", /frozen_base_mismatch/, "failure reason is the frozen-base mismatch");
    assert.equal(sessionCreations, 0, "no worker session created (no provider spawn)");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

// Round 4 Bundle B: the detached runner threads --read-only →
// RunManager.start({readOnly:true}) — the declaration's single write point for
// the background path. End-to-end over a REAL git worktree with an injected
// backend whose worker writes files anyway: this pins BOTH the evidence
// channel (confirmed file_written facts DO enter a non-delivery isolated
// run's transcript — a fact previously only read from the code) and the
// Owner's no-hard-gate constraint (observed writes never stop/fail the run;
// it reaches its natural completed state, and the observation stays advisory).
test("R4: runBackground readOnly → isolated run + exactly-one declaration; writes reach the transcript and the run still completes naturally", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "wao-bg-ro-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-ro-runs-"));
  try {
    execSync("git init -b main", { cwd: repo, stdio: "ignore" });
    execSync('git config user.email "t@t"', { cwd: repo, stdio: "ignore" });
    execSync('git config user.name "t"', { cwd: repo, stdio: "ignore" });
    await writeFile(path.join(repo, "README.md"), "# t\n");
    execSync("git add .", { cwd: repo, stdio: "ignore" });
    execSync("git commit -m init", { cwd: repo, stdio: "ignore" });

    let spawnedCwd = null;
    const fakeBackend = {
      // 只读运行要注入控制面只读执行合同，后端须声明 supportsRoleContract。
      supportsRoleContract: true,
      async spawn(agent) {
        spawnedCwd = agent.cwd;
        return {
          backend: "claude-code",
          backendSessionId: "s_ro",
          messageId: "m_ro",
          admittedSeq: 1,
          async *events() {
            // The worker writes INSIDE the isolated worktree, then completes.
            yield { kind: "file_written", path: `${agent.cwd}/src/a.js`, tool: "Write", toolCallId: "tc1" };
            yield { kind: "done", reason: "completed" };
          },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };

    const result = await runBackground({
      agentId: "bg_ro",
      prompt: "survey only",
      registry: { agents: { bg_ro: { backend: "claude-code", cwd: repo } } },
      runDir,
      readOnly: true,
      backendFor: () => fakeBackend,
      waitTimeout: 3000,
      pollInterval: 10,
    });

    assert.equal(result.completed, true, "run completes naturally despite the observed write (no hard gate)");
    assert.equal(result.failed, false);

    const events = await readTranscript(path.join(runDir, `${result.runId}.jsonl`));
    const started = events.find((e) => e.type === "run.started");
    assert.ok(started?.worktreePath, "readOnly run started inside a real isolated worktree");
    assert.equal(spawnedCwd, started.worktreePath, "worker cwd is the worktree");
    const declarations = events.filter((e) => e.type === "run.read_only_declared");
    assert.equal(declarations.length, 1, "exactly one declaration fact via the runner path");
    // The evidence channel is ALIVE for non-delivery isolated runs: the
    // confirmed file_written fact is durable transcript evidence.
    const writes = events.filter((e) => e.type === "run.event" && e.kind === "file_written");
    assert.equal(writes.length, 1, "file_written entered the transcript");
    assert.equal(writes[0].path, `${started.worktreePath}/src/a.js`);
    assert.equal(findState(events), "completed", "natural terminal state preserved");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});
// test/backgroundRunner.test.js
// P2′（2026-10-04 双席会审 coder_mm，consult_20261004204955653fko0i0）：心跳前置
// 到进程入口。旧实现等 manager.start() 返回才起拍——spawn 前阶段挂死零观察面
//（llqx3k 实证：无 .owner、run.error 缺席、+3600s 外部收尸无痕）。本钉：backend
// spawn 永挂时，.owner-<runId> 必须在 start 返回前就可见（入口起拍的观察语义）。
test("P2′ runBackground: spawn 永挂 → .owner 心跳先于 start 返回可见（入口起拍钉）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-hb-"));
  const runId = "run_hbentry00000000000x";
  let failSpawn;
  const never = runBackground({
    agentId: "hb_hang",
    prompt: "hang",
    registry: { agents: { hb_hang: { backend: "kimi-web", serveUrl: KIMI_TEST_SERVE_URL, cwd: dir, model: { id: "kimi-code/k3" }, tokenEnv: KIMI_TEST_TOKEN_ENV } } },
    runDir: dir,
    runId,
    fetchImpl: makeMockFetch(),
    // backendFor 注入：spawn 返回永挂 promise（复刻 llqx3k 的 spawn 前挂死形态）。
    backendFor: () => ({
      spawn: () => new Promise((_, reject) => { failSpawn = reject; }),
      validateAgentPolicy() {},
    }),
    pollInterval: 10,
  });
  try {
    // 不 await never——断言窗口内（入口起拍 = 毫秒级）文件必须在场。轮询上界 2s。
    let seen = false;
    // 同时等 failSpawn 赋值（spawn 被调用）：入口心跳先于 spawn 调用出现，两条件都备齐再断言。
    for (let i = 0; i < 200 && !(seen && failSpawn); i += 1) {
      seen = existsSync(path.join(dir, `.owner-${runId}`));
      if (!(seen && failSpawn)) await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(seen, "spawn 挂死期间 .owner 心跳可见（入口起拍）——llqx3k 形态从无痕变可观察");
    // 观察完成：主动拒绝 fake spawn → runBackground 走启动失败早退路径（清心跳/owner）→ 目录可清。
    failSpawn(new Error("test: observed"));
    await never;
  } finally {
    // Windows 竞态：spawn 失败经 RunManager 内部 catch 收口后事件流/转录仍可能异步收尾，
    // 与 rm 递归删除赛跑（ENOTEMPTY）——本钉的目的是观察入口起拍语义，清场尽力而为+重试。
    for (let i = 0; i < 5; i += 1) {
      try { await rm(dir, { recursive: true, force: true }); break; }
      catch (e) { if (e.code !== "ENOTEMPTY" && e.code !== "EBUSY") throw e; await new Promise((r) => setTimeout(r, 50)); }
    }
  }
});

// ===== 后台派发遵守 --isolate / --no-isolate / --tag（runner 侧）=====
//
// dispatchRun 把前台语义的隔离三态与标签穿进 runner argv；本组钉 runner 侧：
// parseSimpleFlags 收齐多值 --tag；runBackground 把三态/标签原样传 RunManager.start
//（隔离从 worker 实际 cwd 可观察，标签从 run.started 可观察）。

test("parseSimpleFlags: 重复 --tag 按序收齐为数组，单条保持字符串，缺席为 undefined", () => {
  const multi = parseSimpleFlags(["--prompt", "x", "--tag", "team=alpha", "--tag", "work=fix"]);
  assert.equal(multi.prompt, "x", "普通单值 flag 语义不变");
  assert.deepEqual(multi.tag, ["team=alpha", "work=fix"], "多条 --tag 全部收齐且保持顺序");
  const single = parseSimpleFlags(["--tag", "solo=1"]);
  assert.equal(single.tag, "solo=1", "单条 --tag 保持字符串（与前台单值形状一致）");
  const absent = parseSimpleFlags(["--prompt", "x"]);
  assert.equal(absent.tag, undefined, "无 --tag 时键缺席");
});

test("runBackground 隔离三态: true/false 覆盖 agent isolation 配置，缺席沿用配置", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "wao-bg-iso3-repo-"));
  const runDir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-iso3-runs-"));
  try {
    execSync("git init -b main", { cwd: repo, stdio: "ignore" });
    execSync('git config user.email "t@t"', { cwd: repo, stdio: "ignore" });
    execSync('git config user.name "t"', { cwd: repo, stdio: "ignore" });
    await writeFile(path.join(repo, "README.md"), "# t\n");
    execSync("git add .", { cwd: repo, stdio: "ignore" });
    execSync("git commit -m init", { cwd: repo, stdio: "ignore" });

    // agent 配置默认隔离（worktree）——三态的缺席分支因此可判别：
    // 缺席 → worktree（配置生效）；false → 源仓（旗标压制配置）；true → worktree。
    const spawnedCwds = [];
    const fakeBackend = {
      async spawn(agent) {
        spawnedCwds.push(agent.cwd);
        return {
          backend: "claude-code",
          backendSessionId: "s_iso",
          messageId: "m_iso",
          admittedSeq: 1,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const runIso = (isolate) => runBackground({
      agentId: "bg_iso",
      prompt: "x",
      registry: { agents: { bg_iso: { backend: "claude-code", cwd: repo, isolation: "worktree" } } },
      runDir,
      ...(isolate === undefined ? {} : { isolate }),
      backendFor: () => fakeBackend,
      waitTimeout: 3000,
      pollInterval: 10,
    });

    const explicitTrue = await runIso(true);
    assert.equal(explicitTrue.completed, true, "--isolate 路径自然完成");
    assert.notEqual(spawnedCwds[0], repo, "--isolate: worker cwd 是 worktree 而非源仓");

    const explicitFalse = await runIso(false);
    assert.equal(explicitFalse.completed, true, "--no-isolate 路径自然完成");
    assert.equal(spawnedCwds[1], repo, "--no-isolate: worker cwd 是源仓本身（false 传到了 RunManager.start 并压制 agent isolation 配置）");

    const absent = await runIso(undefined);
    assert.equal(absent.completed, true, "不给旗标路径自然完成");
    assert.notEqual(spawnedCwds[2], repo, "不给旗标: agent isolation 配置照常生效（worktree）——缺席不是 false");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  }
});

test("runBackground 标签: 数组与字符串形状都进 run.started.tags（与前台同形）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-tags-"));
  try {
    const fakeBackend = {
      async spawn() {
        return {
          backend: "claude-code",
          backendSessionId: "s_tag",
          messageId: "m_tag",
          admittedSeq: 1,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
          isAlive: () => false,
        };
      },
    };
    const registry = { agents: { bg_tag: { backend: "claude-code", cwd: dir } } };

    const multi = await runBackground({
      agentId: "bg_tag", prompt: "x", registry, runDir: dir,
      tags: ["team=alpha", "work=fix"],
      backendFor: () => fakeBackend,
      waitTimeout: 3000, pollInterval: 10,
    });
    assert.equal(multi.completed, true);
    let events = await readTranscript(path.join(dir, `${multi.runId}.jsonl`));
    let started = events.find((e) => e.type === "run.started");
    assert.deepEqual(started?.tags, { team: "alpha", work: "fix" }, "多条标签全部进转录，形状=解析后的键值对象（与前台 run.started 同形）");

    const single = await runBackground({
      agentId: "bg_tag", prompt: "x", registry, runDir: dir,
      tags: "solo=1",
      backendFor: () => fakeBackend,
      waitTimeout: 3000, pollInterval: 10,
    });
    assert.equal(single.completed, true);
    events = await readTranscript(path.join(dir, `${single.runId}.jsonl`));
    started = events.find((e) => e.type === "run.started");
    assert.deepEqual(started?.tags, { solo: "1" }, "单条字符串形状同样落地");

    const none = await runBackground({
      agentId: "bg_tag", prompt: "x", registry, runDir: dir,
      backendFor: () => fakeBackend,
      waitTimeout: 3000, pollInterval: 10,
    });
    assert.equal(none.completed, true);
    events = await readTranscript(path.join(dir, `${none.runId}.jsonl`));
    started = events.find((e) => e.type === "run.started");
    assert.equal(started?.tags, undefined, "不给标签 → run.started 无 tags 键");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TD-341（第 89 批 A；二轮续修 1 收紧）：runner stderr 证据文件的进程级退出钩子
// ——退出码 0 **且文件为空**才删（干净退出且无任何诊断内容）；非 0 留、码 0 但
// 非空也留（V8 崩溃证据、resume 接管 append 进来的旧证据、写不进转录时的报错、
// Node 警告都算）。注册器按 (runDir, runId) 去重。V8 abort/被强杀不走退出钩子，
// 无法在进程内单测，属设计行为（文件自然留下）。
// ═══════════════════════════════════════════════════════════════════════════

test("TD-341-二轮1: 退出码 0 且文件为空才删；码 0 但非空留；非 0 留", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-td341r2-exit-"));
  try {
    const runId = "run_td341_exit";
    const file = _join(dir, `.runner-${runId}.stderr`);
    // 非 0：非空证据照留。
    _writeFileSync(file, "#< Fatal JavaScript invalid... heap OOM>", "utf8");
    cleanupRunnerStderrOnExit(1, dir, runId);
    assert.ok(existsSync(file), "非 0 退出码不删——诊断证据留下");
    // 码 0 但非空：留——resume 接管的 runner 干净跑完也不能抹掉之前的崩溃证据
    //（append 打开同一文件），本进程写进 stderr 的报错、Node 警告同理。
    cleanupRunnerStderrOnExit(0, dir, runId);
    assert.ok(existsSync(file), "码 0 但非空不删——append 累积的证据在");
    // 码 0 且为空：删。
    _writeFileSync(file, "", "utf8");
    cleanupRunnerStderrOnExit(0, dir, runId);
    assert.ok(!existsSync(file), "码 0 且空 → 同步删除");
    // 文件本就不在时是 no-op（stat 不到不动）。
    cleanupRunnerStderrOnExit(0, dir, runId);
    cleanupRunnerStderrOnExit(0, dir, "run_td341_never");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-341-A: armRunnerStderrCleanup 在目标进程上注册 exit 钩子（同键去重）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-td341a-arm-"));
  try {
    const runId = "run_td341_arm";
    const file = _join(dir, `.runner-${runId}.stderr`);
    _writeFileSync(file, "boom", "utf8");
    const registered = [];
    const fakeProcess = { on: (event, handler) => registered.push({ event, handler }) };
    armRunnerStderrCleanup(fakeProcess, dir, runId);
    armRunnerStderrCleanup(fakeProcess, dir, runId); // 同键第二次 → 去重
    assert.equal(registered.length, 1, "同一 (runDir, runId) 只注册一次");
    assert.equal(registered[0].event, "exit");
    registered[0].handler(0);
    assert.ok(existsSync(file), "码 0 但非空 → 钩子不动文件（二轮续修 1）");
    _writeFileSync(file, "", "utf8");
    registered[0].handler(0);
    assert.ok(!existsSync(file), "码 0 且空 → 钩子删除文件");
    _writeFileSync(file, "boom", "utf8");
    registered[0].handler(3);
    assert.ok(existsSync(file), "钩子对非 0 退出码不动文件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
