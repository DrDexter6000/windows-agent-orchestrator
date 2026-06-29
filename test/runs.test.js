import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

function makeRunDir() {
  return mkdtemp(join(tmpdir(), "wao-runs-"));
}

async function writeJsonl(dir, runId, events) {
  const lines = events.map((e) => JSON.stringify({ runId, agentId: "test", ...e }));
  await writeFile(join(dir, `${runId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

function cli(args, runDir) {
  const env = { ...process.env };
  if (runDir) args = [...args, "--run-dir", runDir];
  const result = execSync(`node src/cli.js ${args.join(" ")}`, {
    encoding: "utf8",
    cwd: resolve(import.meta.dirname, ".."),
    env,
  });
  return result.trim();
}

test("runs list prints run IDs with inferred state", async () => {
  const dir = await makeRunDir();
  try {
    // run_aaa: completed via legacy event (no state_change)
    await writeJsonl(dir, "run_aaa", [
      { type: "run.started" },
      { type: "run.completed" },
    ]);
    // run_bbb: still running (no terminal event)
    await writeJsonl(dir, "run_bbb", [
      { type: "run.started" },
    ]);
    // run_ccc: has explicit state_change
    await writeJsonl(dir, "run_ccc", [
      { type: "run.started" },
      { type: "run.state_change", from: "pending", to: "failed", reason: "test" },
    ]);

    const output = cli(["runs", "list"], dir);
    const lines = output.split(/\r?\n/);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith("run_aaa\tcompleted"));
    assert.ok(lines[1].startsWith("run_bbb\trunning"));
    assert.ok(lines[2].startsWith("run_ccc\tfailed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs list --agent 过滤：只列出该 agent 的 run", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_aaa", [{ type: "run.started" }]); // agentId=test (默认)
    // 手写带不同 agentId 的 transcript
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "run_bbb.jsonl"),
      JSON.stringify({ runId: "run_bbb", agentId: "researcher", type: "run.started" }) + "\n", "utf8");
    await writeFile(join(dir, "run_ccc.jsonl"),
      JSON.stringify({ runId: "run_ccc", agentId: "researcher", type: "run.completed" }) + "\n", "utf8");

    const output = cli(["runs", "list", "--agent", "researcher"], dir);
    const lines = output.split(/\r?\n/);
    assert.equal(lines.length, 2, "应只列出 researcher 的 2 个 run");
    assert.ok(lines.every((l) => l.startsWith("run_b") || l.startsWith("run_c")), "只含 researcher run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs list --latest N 只列出最近 N 个 run（按时间倒序）", async () => {
  const dir = await makeRunDir();
  try {
    // 按时间戳递增造 3 个 run（文件名含时间戳，runs list 应能按 ts 排序）
    const { writeFile } = await import("node:fs/promises");
    const ts = (n) => `2026-06-2${n}T00:00:00.000Z`;
    await writeFile(join(dir, "run_20260621100000_aaa.jsonl"),
      JSON.stringify({ runId: "run_aaa", agentId: "t", type: "run.started", ts: ts(1) }) + "\n", "utf8");
    await writeFile(join(dir, "run_20260622100000_bbb.jsonl"),
      JSON.stringify({ runId: "run_bbb", agentId: "t", type: "run.started", ts: ts(2) }) + "\n", "utf8");
    await writeFile(join(dir, "run_20260623100000_ccc.jsonl"),
      JSON.stringify({ runId: "run_ccc", agentId: "t", type: "run.started", ts: ts(3) }) + "\n", "utf8");

    const output = cli(["runs", "list", "--latest", "2"], dir);
    const lines = output.split(/\r?\n/);
    assert.equal(lines.length, 2, "应只列出最近 2 个 run");
    // 最近的（ccc, bbb）应在最前
    assert.ok(lines[0].startsWith("run_20260623100000_ccc"), "最近 ccc 应排第一");
    assert.ok(lines[1].startsWith("run_20260622100000_bbb"), "bbb 应排第二");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs list prints nothing for empty directory", async () => {
  const dir = await makeRunDir();
  try {
    const output = cli(["runs", "list"], dir);
    assert.equal(output, "No runs found.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs list prints nothing for missing directory", async () => {
  const output = cli(["runs", "list", "--run-dir", join(tmpdir(), "wao-nonexistent-" + Date.now())]);
  assert.equal(output, "No runs found.");
});

test("runs summary aggregates counts and latest timestamp", async () => {
  const dir = await makeRunDir();
  try {
    // run_aaa: running (no terminal event)
    await writeJsonl(dir, "run_aaa", [
      { type: "run.started", ts: "2026-06-12T10:00:00.000Z" },
    ]);
    // run_bbb: completed via state_change
    await writeJsonl(dir, "run_bbb", [
      { type: "run.started", ts: "2026-06-12T11:00:00.000Z" },
      { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-06-12T11:05:00.000Z" },
    ]);
    // run_ccc: completed via legacy event
    await writeJsonl(dir, "run_ccc", [
      { type: "run.started", ts: "2026-06-12T12:00:00.000Z" },
      { type: "run.completed", ts: "2026-06-12T12:01:00.000Z" },
    ]);

    const output = cli(["runs", "summary"], dir);
    const lines = output.split(/\r?\n/);
    assert.ok(lines[0].includes("Total runs: 3"));
    assert.ok(lines.some((l) => l === "running: 1"));
    assert.ok(lines.some((l) => l === "completed: 2"));
    assert.ok(lines.some((l) => l.startsWith("Latest:") && l.includes("2026-06-12T12:01")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs summary handles empty directory", async () => {
  const dir = await makeRunDir();
  try {
    const output = cli(["runs", "summary"], dir);
    assert.equal(output, "No runs found.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs prune removes old runs and keeps recent ones", async () => {
  const dir = await makeRunDir();
  try {
    const oldTs = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const recentTs = new Date().toISOString();
    await writeJsonl(dir, "run_old", [
      { type: "run.started", ts: oldTs },
      { type: "messages.collected", ts: oldTs },
    ]);
    await writeJsonl(dir, "run_recent", [
      { type: "run.started", ts: recentTs },
    ]);

    const output = cli(["runs", "prune", "--older-than", "7d"], dir);
    const lines = output.split(/\r?\n/);
    assert.ok(lines.some((l) => l.includes("Pruned run_old")));
    assert.ok(lines.some((l) => l.includes("Pruned 1, kept 1")));
    assert.ok(!existsSync(join(dir, "run_old.jsonl")));
    assert.ok(existsSync(join(dir, "run_recent.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs prune requires --older-than", async () => {
  const dir = await makeRunDir();
  try {
    assert.throws(
      () => cli(["runs", "prune"], dir),
      /older-than/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs prune rejects invalid duration format", async () => {
  const dir = await makeRunDir();
  try {
    assert.throws(
      () => cli(["runs", "prune", "--older-than", "abc"], dir),
      /Invalid duration/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs grep finds matching runs by pattern", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_aaa", [
      { type: "run.started", ts: "2026-06-12T10:00:00.000Z", cwd: "D:/projects/alpha" },
      { type: "messages.collected", ts: "2026-06-12T10:01:00.000Z" },
    ]);
    await writeJsonl(dir, "run_bbb", [
      { type: "run.started", ts: "2026-06-12T11:00:00.000Z", cwd: "D:/projects/beta" },
    ]);

    const output = cli(["runs", "grep", "alpha"], dir);
    const lines = output.split(/\r?\n/);
    assert.ok(lines.some((l) => l.includes("run_aaa")));
    assert.ok(!lines.some((l) => l.includes("run_bbb")));
    assert.ok(lines.some((l) => l.includes("Matched 1")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs grep requires pattern", async () => {
  assert.throws(
    () => cli(["runs", "grep"]),
    /requires/,
  );
});

test("runs metrics <runId> 显示 state/duration/tokens", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_met", [
      { type: "run.started", ts: "2026-06-15T10:00:00.000Z" },
      { type: "run.state_change", to: "completed" },
      { type: "run.metrics", tokens: { input: 100, output: 50 }, costUsd: 0.02 },
      { type: "run.completed", ts: "2026-06-15T10:00:30.000Z" },
    ]);
    const output = cli(["runs", "metrics", "run_met"], dir);
    assert.ok(output.includes("state:    completed"));
    assert.ok(output.includes("input=100"));
    assert.ok(output.includes("output=50"));
    assert.ok(output.includes("30.0s"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs metrics --summary 聚合多 run", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_a", [
      { type: "run.started", ts: "2026-06-15T10:00:00.000Z" },
      { type: "run.state_change", to: "completed" },
      { type: "run.metrics", tokens: { input: 100, output: 50 } },
      { type: "run.completed", ts: "2026-06-15T10:00:30.000Z" },
    ]);
    await writeJsonl(dir, "run_b", [
      { type: "run.started", ts: "2026-06-15T11:00:00.000Z" },
      { type: "run.state_change", to: "failed" },
      { type: "run.metrics", tokens: { input: 200, output: 0 } },
      { type: "run.completed", ts: "2026-06-15T11:00:10.000Z" },
    ]);
    const output = cli(["runs", "metrics", "--summary"], dir);
    assert.ok(output.includes("Total runs: 2"));
    assert.ok(output.includes("Success rate: 50%"));
    assert.ok(output.includes("input=300"));
    assert.ok(output.includes("output=50"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runs metrics --format json 输出 JSON", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_j", [
      { type: "run.started", ts: "2026-06-15T10:00:00.000Z" },
      { type: "run.state_change", to: "completed" },
      { type: "run.metrics", tokens: { input: 10 }, costUsd: 0.001 },
      { type: "run.completed", ts: "2026-06-15T10:00:05.000Z" },
    ]);
    const output = cli(["runs", "metrics", "run_j", "--format", "json"], dir);
    const parsed = JSON.parse(output);
    assert.equal(parsed.runId, "run_j");
    assert.equal(parsed.state, "completed");
    assert.equal(parsed.tokens.input, 10);
    assert.equal(parsed.costUsd, 0.001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- F2/C1: stop 命令对进程型 run 的支持 ---
// 原 bug：stop 只认 opencode session（找 serveUrl），进程型 run（backendSessionId=proc_<pid>）
// 报 "no OpenCode session metadata"，无法叫停失控的进程型 worker。
// 修复：stop 检测到进程型 session 时走 taskkill 路径，不报错。

test("stop on process-type run: 不报 'no OpenCode session'，走 taskkill 路径", async () => {
  const dir = await makeRunDir();
  try {
    // 进程型 run：session.created 带 backendSessionId=proc_<pid>，无 serveUrl
    await writeJsonl(dir, "run_proc_stop", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_999999" },
      { type: "prompt.sent", prompt: "test" },
      { type: "run.submitted" },
    ]);

    // 修复前：抛 "no OpenCode session metadata"。
    // 修复后：进程型走 taskkill（PID 999999 不存在，taskkill 返回非零但 stop 不抛错，
    // 写 stop_requested + state_change→aborted + 提示进程型）。
    const output = cli(["stop", "run_proc_stop"], dir);
    // 不抛错即通过；进程型 stop 应有明确提示而非 opencode session 报错
    assert.ok(!/no OpenCode session/i.test(output), "进程型 run 不应报 opencode session 错误");
    assert.match(output, /process|进程|taskkill|proc_/i, "应提示走进程型 kill 路径");
    assert.match(output, /"stopped": true/, "应标记 stopped=true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 注：opencode stop 路径（abort+verifyStopQuiet）的正确性由 test/opencodeStopVerify.test.js
// 守护（纯函数层）。这里不重复端到端——它要连真实 serve 才能完整验证，连假 serve 会因
// fetch 无超时挂 55s，拖慢 suite 且无额外价值。C1 的分流逻辑由上面的进程型测试覆盖。

// --- N4b 修复：collect 支持进程型 run（从 transcript 重建产出，不依赖 opencode session）---
// TD-77 子项 A 扩展：collect 现重建所有 run.event kind（不只 message），输出事件时间线。
test("collect on process-type run: 从 transcript 重建 message，不报 opencode session 错误", async () => {
  const dir = await makeRunDir();
  try {
    // 进程型 run 的 transcript（N4 修复后 message 落 run.event kind=message）
    await writeJsonl(dir, "run_proc_collect", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "prompt.sent", prompt: "say hi" },
      { type: "run.submitted" },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "Hello from worker" }] },
      { type: "run.event", kind: "tool_use", tool: "Read", input: { file_path: "a.txt" } },
      { type: "run.completed" },
    ]);

    // 修复前：抛 "no OpenCode session metadata"。
    // TD-77A 后：进程型 run 从 transcript 重建所有 run.event kind（事件时间线），返回。
    const output = cli(["collect", "run_proc_collect"], dir);
    assert.ok(!/no OpenCode session/i.test(output), "进程型 run 不应报 opencode session 错误");
    const parsed = JSON.parse(output);
    // 应返回重建的事件时间线（含 message 与非 message kind）
    const data = parsed.data ?? parsed;
    assert.ok(Array.isArray(data), "应返回重建数组");
    const assistant = data.find((m) => m.kind === "message" && m.role === "assistant");
    assert.ok(assistant, "应含 assistant message");
    const text = (assistant.parts ?? []).map((p) => p.text).filter(Boolean).join("");
    assert.equal(text, "Hello from worker", "应重建出 assistant 文字产出");
    // TD-77A：非 message kind 也应重建（旧实现会丢）
    assert.ok(data.find((m) => m.kind === "tool_use"), "应含 tool_use（TD-77A 重建所有 kind）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
