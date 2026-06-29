import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { runBackground } from "../src/backgroundRunner.js";
import { readTranscript, findState } from "../src/transcript.js";

// --- P2 后台生命周期接管（watchdog / detached runner）---
// 06-18 事故架构洞：fire-and-forget spawn 的孤儿会话脱离任何 WAO 进程，所有防线
// （token 闸门/事件轮询/兜底 abort）全活在 waitForCompletion 内部，孤儿会话无人消费→失控。
// P2 解法：detached runner 进程拥有 worker handle，驱动 waitForCompletion（含闸门+abort），
// 写共享 transcript。CLI fork runner 后拿 runId 返回，runner 独立活到 run 结束。
// 本测试验证进程内核心函数 runBackground：驱动完一个 run + 状态机推进 + transcript 完整。

function makeMockFetch() {
  const sessions = new Map();
  return async (url, init = {}) => {
    const urlStr = String(url);
    if (init.method === "POST" && urlStr.endsWith("/api/session")) {
      const id = `ses_bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      sessions.set(id, { messages: [] });
      return { ok: true, status: 200, async json() { return { data: { id } }; }, async text() { return JSON.stringify({ data: { id } }); } };
    }
    if (init.method === "POST" && urlStr.includes("/prompt_async")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const body = JSON.parse(init.body);
      const session = sessions.get(sessionId);
      if (session) {
        session.messages.push({ info: { id: body.messageID, role: "user" }, parts: body.parts });
        session.messages.push({ info: { id: "msg_reply", role: "assistant" }, parts: [{ type: "text", text: "bg done" }] });
      }
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    if (init.method === "GET" && urlStr.includes("/message")) {
      const sessionId = new URL(urlStr).pathname.split("/")[2];
      const session = sessions.get(sessionId);
      return { ok: true, status: 200, async json() { return session?.messages ?? []; }, async text() { return JSON.stringify(session?.messages ?? []); } };
    }
    if (init.method === "POST" && urlStr.includes("/abort")) {
      return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
    }
    return { ok: false, status: 404, async text() { return "not found"; } };
  };
}

test("P2 runBackground: 驱动 run 到 completed，状态机推进，transcript 完整", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-"));
  try {
    const result = await runBackground({
      agentId: "bg_agent",
      prompt: "do it",
      registry: { agents: { bg_agent: { backend: "opencode-serve", serveUrl: "http://127.0.0.1:4299", agent: "build", cwd: dir, model: { providerID: "p", id: "m" }, completionMode: "first-stable" } } },
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

test("P2 runBackground: worker 静默不响应时推进到终态（超时兜底），不卡 submitted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-bg-fail-"));
  try {
    // mock fetch：session 创建成功，但 /message 永远空（模拟 provider 静默）→ 走超时
    const silentFetch = async (url, init = {}) => {
      const urlStr = String(url);
      if (init.method === "POST" && urlStr.endsWith("/api/session")) {
        return { ok: true, status: 200, async json() { return { data: { id: "ses_silent" } }; }, async text() { return JSON.stringify({ data: { id: "ses_silent" } }); } };
      }
      if (init.method === "POST" && urlStr.includes("/prompt_async")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      if (init.method === "GET" && urlStr.includes("/message")) {
        return { ok: true, status: 200, async json() { return []; }, async text() { return "[]"; } }; // 永远空
      }
      if (init.method === "POST" && urlStr.includes("/abort")) {
        return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      }
      return { ok: false, status: 404, async text() { return "x"; } };
    };
    const result = await runBackground({
      agentId: "bg_fail",
      prompt: "x",
      registry: { agents: { bg_fail: { backend: "opencode-serve", serveUrl: "http://127.0.0.1:4299", agent: "build", cwd: dir, model: { providerID: "p", id: "m" } } } },
      runDir: dir,
      fetchImpl: silentFetch,
      waitTimeout: 1500,
      pollInterval: 20,
    });
    assert.ok(result.runId);
    // 不应卡 submitted；静默 → 超时 → 终态
    const events = await readTranscript(path.join(dir, `${result.runId}.jsonl`));
    const state = findState(events);
    assert.ok(["failed", "timed_out"].includes(state), `静默应进终态 failed/timed_out，实际 ${state}（不能卡 submitted）`);
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
    const out = execSync(
      `node src/cli.js run bgw --prompt "x" --background --run-dir ${runDir} --registry ${registryPath} --wait-timeout 2000 --format json`,
      { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 10000 },
    );
    // 整块是 pretty JSON，从第一个 { 到最后一个 } 解析
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    const parsed = JSON.parse(out.slice(start, end + 1));
    assert.equal(parsed.background, true, "应标记 background:true");
    assert.ok(parsed.runId, "应返回 runId");
    assert.match(parsed.note ?? "", /detached runner owns lifecycle/i, "应说明 runner 接管生命周期");

    // 等 detached runner 进程推进状态机（binary 不存在会快速 failed）
    const transcriptPath = path.join(runDir, `${parsed.runId}.jsonl`);
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- D-F3 修复：P2 runner 写 ownership 心跳文件 ---
// daemon --resume-on-start 用 owner 心跳判活，避免劫持 P2 runner 还在驱动的 run。
// runner 启动写 .owner-<runId>，存活期间更新心跳，退出删。本测试验证写（运行中）+ 删（完成后）。

test("D-F3: runBackground 运行中写 ownership 文件，完成后删", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wao-owner-"));
  try {
    // slow mock：/message 先空几轮（让 run 卡 running），再返回 assistant（让 run 完成）。
    // 这样能在 run 进行中观测到 ownership 文件。
    let polls = 0;
    const slowFetch = async (url, init = {}) => {
      const u = String(url);
      if (init.method === "POST" && u.endsWith("/api/session")) return { ok: true, status: 200, async json() { return { data: { id: "ses_slow" } }; }, async text() { return JSON.stringify({ data: { id: "ses_slow" } }); } };
      if (init.method === "POST" && u.includes("/prompt_async")) return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      if (init.method === "GET" && u.includes("/message")) {
        polls += 1;
        const msgs = polls > 3 ? [{ info: { id: "m", role: "assistant" }, parts: [{ type: "text", text: "done" }] }] : [];
        return { ok: true, status: 200, async json() { return msgs; }, async text() { return JSON.stringify(msgs); } };
      }
      if (init.method === "POST" && u.includes("/abort")) return { ok: true, status: 204, async json() { return null; }, async text() { return ""; } };
      return { ok: false, status: 404, async text() { return "x"; } };
    };

    let runIdObserved = null;
    let ownerSeenDuringRun = false;
    const runPromise = runBackground({
      agentId: "owner_agent",
      prompt: "do it",
      registry: { agents: { owner_agent: { backend: "opencode-serve", serveUrl: "http://127.0.0.1:4299", agent: "build", cwd: dir, model: { providerID: "p", id: "m" }, completionMode: "first-stable" } } },
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

    const transcriptPath = path.join(dir, `${runId}.jsonl`);
    assert.ok(existsSync(transcriptPath), "启动失败也必须留下 transcript，不能 ghost");
    const events = await readTranscript(transcriptPath);
    assert.equal(findState(events), "failed", "启动失败 transcript 最终态应为 failed");
    assert.ok(events.some((e) => e.type === "run.error" && /Unknown agent|missing_agent/.test(e.error ?? e.detail ?? "")),
      "transcript 应记录启动失败原因");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
