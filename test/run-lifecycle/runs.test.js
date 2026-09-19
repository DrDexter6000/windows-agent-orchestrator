import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
// TD-153 残余批：--state / --since 过滤的 service 层纯测试直接调 listRuns；
// RUN_STATES 从 transcript.js 导入做零漂移断言（闭集报错文案不得与 SSOT 漂移）。
import { listRuns } from "../../src/application/runList.js";
import { RUN_STATES } from "../../src/transcript.js";

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
    cwd: resolve(import.meta.dirname, "../.."),
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
    // R21 夹具修正：信封 runId 与文件名 stem 对齐（生产不变量：文件名即 runId；
    // stem 权威绑定下失配文件按不可归属降级——旧夹具的 run_aaa/run_bbb/run_ccc 违反该不变量）
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
      JSON.stringify({ runId: "run_20260621100000_aaa", agentId: "t", type: "run.started", ts: ts(1) }) + "\n", "utf8");
    await writeFile(join(dir, "run_20260622100000_bbb.jsonl"),
      JSON.stringify({ runId: "run_20260622100000_bbb", agentId: "t", type: "run.started", ts: ts(2) }) + "\n", "utf8");
    await writeFile(join(dir, "run_20260623100000_ccc.jsonl"),
      JSON.stringify({ runId: "run_20260623100000_ccc", agentId: "t", type: "run.started", ts: ts(3) }) + "\n", "utf8");

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

// --- R23-B1: runs prune --archive 归档模式（移动不删除） ---
// 归档根 = dirname(runDir)/runs-archive——夹具造一个临时父目录把 runs/ 与
// runs-archive/ 圈在同一棵临时树内，归档产物随 finally 一起清理（makeRunDir
// 的裸 tmpdir 直下 runDir 会把归档根甩到系统 tmpdir 根上）。
async function makeRunTree() {
  const root = await mkdtemp(join(tmpdir(), "wao-runs-archive-"));
  const runDir = join(root, "runs");
  await mkdir(runDir, { recursive: true });
  return { root, runDir, archiveRoot: join(root, "runs-archive") };
}

test("R23-B1: runs prune --archive 移动超龄 run 到 runs-archive/<yyyy-mm>/（原文件名）", async () => {
  const { root, runDir, archiveRoot } = await makeRunTree();
  try {
    await writeJsonl(runDir, "run_old", [
      { type: "run.started", ts: "2026-03-15T00:00:00.000Z" },
      { type: "run.completed", ts: "2026-03-15T00:05:00.000Z" },
    ]);
    await writeJsonl(runDir, "run_recent", [
      { type: "run.started", ts: new Date().toISOString() },
    ]);

    const output = cli(["runs", "prune", "--older-than", "90d", "--archive"], runDir);
    const lines = output.split(/\r?\n/);
    assert.ok(lines.some((l) => l === "Archived run_old.jsonl -> runs-archive/2026-03/run_old.jsonl"), "逐文件归档行");
    assert.ok(lines.some((l) => l === "Archived 1, skipped 0 (conflict), kept 1"), "汇总行");
    // 超龄文件从 runDir 消失、出现在归档目录且文件名不变
    assert.ok(!existsSync(join(runDir, "run_old.jsonl")));
    assert.ok(existsSync(join(archiveRoot, "2026-03", "run_old.jsonl")));
    // 新龄文件留在原地、不进归档
    assert.ok(existsSync(join(runDir, "run_recent.jsonl")));
    assert.ok(!existsSync(join(archiveRoot, "2026-03", "run_recent.jsonl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R23-B1: runs prune --archive 按判龄 ts 月份分层：不同月份进不同子目录", async () => {
  const { root, runDir, archiveRoot } = await makeRunTree();
  try {
    await writeJsonl(runDir, "run_march", [
      { type: "run.started", ts: "2026-03-15T00:00:00.000Z" },
    ]);
    await writeJsonl(runDir, "run_jan", [
      { type: "run.started", ts: "2026-01-10T00:00:00.000Z" },
    ]);

    const output = cli(["runs", "prune", "--older-than", "7d", "--archive"], runDir);
    assert.ok(output.includes("Archived 2, skipped 0 (conflict), kept 0"));
    assert.ok(!existsSync(join(runDir, "run_march.jsonl")));
    assert.ok(!existsSync(join(runDir, "run_jan.jsonl")));
    // 各自按判龄 ts 的月份进不同子目录，文件名不变
    assert.ok(existsSync(join(archiveRoot, "2026-03", "run_march.jsonl")));
    assert.ok(existsSync(join(archiveRoot, "2026-01", "run_jan.jsonl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R23-B1: runs prune --archive 判龄与 prune 同源：新龄 kept、超龄 archived、legacy 无信封照常参与", async () => {
  const { root, runDir, archiveRoot } = await makeRunTree();
  try {
    const oldTs = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await writeJsonl(runDir, "run_recent", [
      { type: "run.started", ts: new Date().toISOString() },
    ]);
    await writeJsonl(runDir, "run_old", [
      { type: "run.started", ts: oldTs },
    ]);
    // legacy 无信封（事件不带 runId）——boundReportScope 返回 null → 按末事件
    // ts 判龄（R20-C legacy 语义），照常参与归档
    await writeFile(join(runDir, "run_legacy.jsonl"),
      JSON.stringify({ type: "run.started", ts: oldTs }) + "\n", "utf8");

    const output = cli(["runs", "prune", "--older-than", "7d", "--archive"], runDir);
    assert.ok(output.includes("Archived 2, skipped 0 (conflict), kept 1"), "新龄 kept、两个超龄 archived");
    assert.ok(existsSync(join(runDir, "run_recent.jsonl")), "新龄文件留在 runDir");
    assert.ok(!existsSync(join(runDir, "run_old.jsonl")));
    assert.ok(!existsSync(join(runDir, "run_legacy.jsonl")));
    // 两个超龄（含 legacy）都进判龄 ts 当月的归档子目录
    const month = oldTs.slice(0, 7); // F10：直接取判龄 ts 的月份，消掉 CLI 执行时长内的月界微窗
    assert.ok(existsSync(join(archiveRoot, month, "run_old.jsonl")));
    assert.ok(existsSync(join(archiveRoot, month, "run_legacy.jsonl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R23-B1: runs prune --archive 冲突 fail-safe：目标同名文件已存在 → 不移动不覆盖，计 skipped", async () => {
  const { root, runDir, archiveRoot } = await makeRunTree();
  try {
    await writeJsonl(runDir, "run_conflict", [
      { type: "run.started", ts: "2026-03-15T00:00:00.000Z" },
    ]);
    // 预置同名目标（marker 内容，验证不被覆盖）
    await mkdir(join(archiveRoot, "2026-03"), { recursive: true });
    const marker = JSON.stringify({ type: "run.started", ts: "2025-01-01T00:00:00.000Z", marker: "pre-existing" }) + "\n";
    await writeFile(join(archiveRoot, "2026-03", "run_conflict.jsonl"), marker, "utf8");

    const output = cli(["runs", "prune", "--older-than", "7d", "--archive"], runDir);
    const lines = output.split(/\r?\n/);
    assert.ok(
      lines.some((l) => l === "Skipped run_conflict.jsonl (conflict: runs-archive/2026-03/run_conflict.jsonl already exists)"),
      "冲突报告行",
    );
    assert.ok(lines.some((l) => l === "Archived 0, skipped 1 (conflict), kept 0"), "计入 skipped");
    // 原文件留在原地；预置目标内容未被覆盖
    assert.ok(existsSync(join(runDir, "run_conflict.jsonl")));
    const target = await readFile(join(archiveRoot, "2026-03", "run_conflict.jsonl"), "utf8");
    assert.equal(target, marker, "预置目标未被覆盖");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R23-B1: runs prune --archive 不碰非 .jsonl 文件与子目录", async () => {
  const { root, runDir, archiveRoot } = await makeRunTree();
  try {
    await writeJsonl(runDir, "run_old", [
      { type: "run.started", ts: "2026-03-15T00:00:00.000Z" },
    ]);
    await writeFile(join(runDir, "notes.txt"), "not a transcript", "utf8");
    await mkdir(join(runDir, "subdir"));
    await writeJsonl(join(runDir, "subdir"), "run_nested", [
      { type: "run.started", ts: "2026-03-15T00:00:00.000Z" },
    ]);

    const output = cli(["runs", "prune", "--older-than", "7d", "--archive"], runDir);
    assert.ok(output.includes("Archived 1, skipped 0 (conflict), kept 0"), "只处置顶层超龄 jsonl");
    // 非 jsonl 与子目录原样留在 runDir
    assert.ok(existsSync(join(runDir, "notes.txt")));
    assert.ok(existsSync(join(runDir, "subdir", "run_nested.jsonl")));
    // 只有顶层超龄 jsonl 进归档
    assert.ok(existsSync(join(archiveRoot, "2026-03", "run_old.jsonl")));
    assert.ok(!existsSync(join(archiveRoot, "2026-03", "run_nested.jsonl")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R23-B1: --archive 带值形状（--archive yes）仍走归档而非静默删除（auditor F3 钉）", async () => {
  // parseOptions 对 `--archive 值` 会给 options.archive 赋字符串值——实现用
  // Boolean(options.archive) 判定（宁可归档不可误删）。本测试钉住该 truthy
  // 语义：改回 === true 会让字符串形状静默落回 unlink 永久删除路径。
  const { root, runDir, archiveRoot } = await makeRunTree();
  try {
    await writeJsonl(runDir, "run_val", [
      { type: "run.started", ts: "2026-03-15T00:00:00.000Z" },
    ]);

    const output = cli(["runs", "prune", "--older-than", "7d", "--archive", "yes"], runDir);
    assert.ok(output.includes("Archived 1,"), "字符串形状仍归档（不是 Pruned）");
    assert.ok(!output.includes("Pruned run_val"), "不得走删除路径");
    assert.ok(!existsSync(join(runDir, "run_val.jsonl")), "源文件已移走");
    assert.ok(existsSync(join(archiveRoot, "2026-03", "run_val.jsonl")), "目标在归档目录");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R23-B1: 末事件无 ts（ts=0 按最老）→ 归档月份按文件 mtime 兜底（auditor F4 钉）", async () => {
  // 可达形状：末条绑定事件缺 ts / 整份只有外 run 信封行 / 空事件——判龄 ts=0
  // 按最老处理（与删除路径同语义），月份无 ts 可用 → 文件 mtime 月。
  const { root, runDir, archiveRoot } = await makeRunTree();
  try {
    await writeJsonl(runDir, "run_nots", [
      { type: "run.started" }, // 无 ts
    ]);

    const before = new Date().toISOString().slice(0, 7);
    cli(["runs", "prune", "--older-than", "7d", "--archive"], runDir);
    const after = new Date().toISOString().slice(0, 7);
    assert.ok(!existsSync(join(runDir, "run_nots.jsonl")), "ts=0 按最老 → 已归档");
    // 归档目录下应恰有一个月份子目录；夹具刚创建，mtime 月 = 当前月
    // （若测试恰好跨月界运行，before/after 二者之一即该目录名——月界窗口
    // 属可接受环境形状，其余断言不受影响）。
    const months = (await readdir(archiveRoot)).filter((m) => m === before || m === after);
    assert.equal(months.length, 1, "恰一个 mtime 兜底月份子目录");
    assert.ok(existsSync(join(archiveRoot, months[0], "run_nots.jsonl")), "文件在 mtime 月份目录内");
  } finally {
    rmSync(root, { recursive: true, force: true });
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

// --- TD-102 Batch 1B: runs aggregation must exclude workflow transcripts ---

test("TD-102: runs list excludes wf_* transcripts", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_real", [
      { type: "run.started", ts: "2026-07-10T10:00:00.000Z" },
      { type: "run.state_change", to: "completed" },
      { type: "run.completed", ts: "2026-07-10T10:01:00.000Z" },
    ]);
    await writeJsonl(dir, "wf_test", [
      { type: "workflow.started", ts: "2026-07-10T11:00:00.000Z" },
      { type: "workflow.completed", completed: false, ts: "2026-07-10T11:01:00.000Z" },
    ]);

    const output = cli(["runs", "list"], dir);
    const lines = output.split(/\r?\n/);
    // 只含 run_real，不含 wf_test
    assert.ok(lines.some((l) => l.startsWith("run_real")), "含 run_real");
    assert.ok(!lines.some((l) => l.startsWith("wf_test")), "不含 wf_* workflow transcript");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-102: runs summary excludes wf_* transcripts", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_a", [
      { type: "run.started", ts: "2026-07-10T10:00:00.000Z" },
      { type: "run.state_change", to: "completed" },
      { type: "run.completed", ts: "2026-07-10T10:01:00.000Z" },
    ]);
    await writeJsonl(dir, "wf_fail", [
      { type: "workflow.started", ts: "2026-07-10T11:00:00.000Z" },
      { type: "workflow.completed", completed: false, ts: "2026-07-10T11:01:00.000Z" },
    ]);

    const output = cli(["runs", "summary"], dir);
    // 只算 1 个 run，不是 2 个
    assert.match(output, /Total runs:\s*1/, "summary 只计 1 个 run（排除 wf_*）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-102: runs metrics --summary excludes wf_* transcripts", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_x", [
      { type: "run.started", ts: "2026-07-10T10:00:00.000Z" },
      { type: "run.state_change", to: "completed" },
      { type: "run.metrics", tokens: { input: 100, output: 50 } },
      { type: "run.completed", ts: "2026-07-10T10:01:00.000Z" },
    ]);
    await writeJsonl(dir, "wf_metrics", [
      { type: "workflow.started", ts: "2026-07-10T11:00:00.000Z" },
      { type: "workflow.completed", completed: true, ts: "2026-07-10T11:01:00.000Z" },
    ]);

    const output = cli(["runs", "metrics", "--summary"], dir);
    assert.match(output, /Total runs:\s*1/, "metrics summary 只计 1 个 run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-102: runs dashboard --format json excludes wf_* transcripts", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_d", [
      { type: "run.started", ts: "2026-07-10T10:00:00.000Z" },
      { type: "run.state_change", to: "completed" },
      { type: "run.completed", ts: "2026-07-10T10:01:00.000Z" },
    ]);
    await writeJsonl(dir, "wf_dash", [
      { type: "workflow.started", ts: "2026-07-10T11:00:00.000Z" },
      { type: "workflow.completed", completed: false, ts: "2026-07-10T11:01:00.000Z" },
    ]);

    const output = cli(["runs", "dashboard", "--format", "json"], dir);
    const parsed = JSON.parse(output);
    assert.equal(parsed.summary.total, 1, "dashboard 只含 1 个 run");
    assert.ok(parsed.rows.every((r) => !r.runId.startsWith("wf_")), "dashboard rows 无 wf_*");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-102: direct status wf_* still works and reports failed for completed:false", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "wf_direct", [
      { type: "workflow.started", ts: "2026-07-10T11:00:00.000Z" },
      { type: "workflow.completed", completed: false, ts: "2026-07-10T11:01:00.000Z" },
    ]);

    const output = cli(["status", "wf_direct"], dir);
    // 直接 status 应仍可用，且报告 failed（不是 completed）
    assert.match(output, /failed/i, "direct status wf_* 应报 failed（completed:false）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== TD-153 残余实施批：runs list --state / --since（service 层纯测试） =====
//
// 状态枚举（WQ-02）：
//   - 正常：各闭集状态命中 / 时间窗新鲜保留、超龄排除、下界含端
//   - 缺失：runDir 不存在（校验先于扫描——非法输入照报错）、空目录（零结果）
//   - 非法输入：stateFilter 非闭集值 / sinceMs 非有限非负 / activeOnly × stateFilter
//   - 不可解析：malformed transcript 照旧静默跳过（LIST-05 同款，不因新 flag 改变）
//   - unparseable 时间：updatedAt null（绑定事件无 ts）→ --since fail-closed 排除
//   - legacy 回退：全无信封文件按末事件 ts 判窗（与 --latest 排序同语义档）
//   - 篡改探针：外 run 伪造尾条不得翻转 --state/--since 过滤结果（绑定纪律）
//   - 组合：--state × --since × --agent × --latest 任意叠加，输出形状不变
//   不适用：loading/异步态——listRuns 是单次查询，无 UI 异步状态机。

/** TD-153：固定时间基（注入 nowMs，全确定性）。 */
const TD153_NOW = Date.parse("2026-09-19T12:00:00.000Z");
const TD153_DAY = 86_400_000;
const td153Iso = (ms) => new Date(ms).toISOString();

test("TD-153: listRuns stateFilter 过滤闭集投影（failed/completed/running 各自命中；malformed 文件照旧静默跳过；unresolved 计数随过滤集）", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_fail", [
      { type: "run.started", ts: td153Iso(TD153_NOW - TD153_DAY) },
      { type: "run.state_change", from: "running", to: "failed", reason: "r", ts: td153Iso(TD153_NOW - TD153_DAY + 1000) },
    ]);
    await writeJsonl(dir, "run_done", [
      { type: "run.started", ts: td153Iso(TD153_NOW - TD153_DAY) },
      { type: "run.state_change", from: "running", to: "completed", reason: "r", ts: td153Iso(TD153_NOW - TD153_DAY + 1000) },
    ]);
    // 非终态且无 .owner 心跳（unresolved）——--state running 应保留
    await writeJsonl(dir, "run_live", [
      { type: "run.started", ts: td153Iso(TD153_NOW - TD153_DAY) },
      { type: "run.state_change", from: "pending", to: "running", reason: "r", ts: td153Iso(TD153_NOW - TD153_DAY + 1000) },
    ]);
    // malformed transcript：skip-silently 既有路径（新 flag 不改变）
    await writeFile(join(dir, "run_broken.jsonl"), "NOT VALID JSON\n", "utf8");

    const failed = await listRuns({ runDir: dir, stateFilter: "failed", knownAgentIds: [], validateAgentIds: false });
    assert.deepEqual(failed.runs.map((r) => r.runId), ["run_fail"], "--state failed 只留 failed");
    assert.equal(failed.runs[0].state, "failed");
    assert.equal(failed.matchedCount, 1);

    const done = await listRuns({ runDir: dir, stateFilter: "completed", knownAgentIds: [], validateAgentIds: false });
    assert.deepEqual(done.runs.map((r) => r.runId), ["run_done"], "--state completed 只留 completed");

    const live = await listRuns({ runDir: dir, stateFilter: "running", knownAgentIds: [], validateAgentIds: false });
    assert.deepEqual(live.runs.map((r) => r.runId), ["run_live"], "--state running 保留无心跳非终态（不是 --active 语义）");
    assert.equal(live.runs[0].activityStatus, "unresolved");
    // unresolvedCount 随过滤集（--agent 先例：被过滤掉的 run 不参与健康计数）
    assert.equal(live.unresolvedCount, 1, "入集的非终态无心跳 run 计入 unresolvedCount");
    assert.equal(failed.unresolvedCount, 0, "terminal 过滤集无 unresolved 计数");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-153: listRuns stateFilter 非法值 fail-closed 报错列出闭集（与 RUN_STATES SSOT 零漂移；校验先于扫描）", async () => {
  // runDir 不存在也要先报输入错——证明校验在任何扫描/读取之前
  const missingDir = join(tmpdir(), "wao-td153-nonexistent-" + Date.now());
  await assert.rejects(
    () => listRuns({ runDir: missingDir, stateFilter: "succeeded", knownAgentIds: [] }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("--state"), "报错点名 --state");
      for (const s of RUN_STATES) {
        assert.ok(err.message.includes(s), `闭集成员 ${s} 必须在报错文案中（SSOT 零漂移）`);
      }
      assert.ok(err.message.includes("--state failed"), "给出示例");
      return true;
    },
  );
  // 空目录 + 非法 stateFilter：输入校验仍先行报错（不静默空结果）
  const dir = await makeRunDir();
  try {
    await assert.rejects(
      () => listRuns({ runDir: dir, stateFilter: 42, knownAgentIds: [] }),
      /--state must be one of/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-153: activeOnly × stateFilter 一切组合 fail-closed 拒绝（含 running——activeOnly 是心跳活性投影，非 state 子集）", async () => {
  const dir = await makeRunDir();
  try {
    for (const v of ["running", "pending", "completed", "failed"]) {
      await assert.rejects(
        () => listRuns({ runDir: dir, activeOnly: true, stateFilter: v, knownAgentIds: [] }),
        /--state cannot be combined with --active/,
        `--active × --state ${v} 必须拒绝`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-153: listRuns sinceMs 时间窗（新鲜保留/超龄排除/下界含端；updatedAt 无法定时 fail-closed 排除；缺 ts 无过滤时照常列出）", async () => {
  const dir = await makeRunDir();
  try {
    await writeJsonl(dir, "run_recent", [
      { type: "run.started", ts: td153Iso(TD153_NOW - 3_600_000) },
    ]);
    await writeJsonl(dir, "run_old", [
      { type: "run.started", ts: td153Iso(TD153_NOW - 10 * TD153_DAY) },
    ]);
    // 恰在下界上（NOW - 7d）：含端保留（与 historyRange inclusive 语义一致）
    await writeJsonl(dir, "run_edge", [
      { type: "run.started", ts: td153Iso(TD153_NOW - 7 * TD153_DAY) },
    ]);
    // 绑定事件无 ts → updatedAt null：不能证明在窗内 → 排除
    await writeJsonl(dir, "run_nots", [
      { type: "run.started" },
    ]);

    const out = await listRuns({
      runDir: dir, sinceMs: 7 * TD153_DAY, nowMs: TD153_NOW,
      knownAgentIds: [], validateAgentIds: false,
    });
    assert.deepEqual(out.runs.map((r) => r.runId), ["run_recent", "run_edge"],
      "窗内新鲜保留（updatedAt desc），恰在含端下界也保留；超龄与无 ts 排除");
    assert.equal(out.matchedCount, 2);

    // 对照：不带 --since 时 run_nots 照常列出（新 flag 不改变无过滤行为）
    const all = await listRuns({ runDir: dir, nowMs: TD153_NOW, knownAgentIds: [], validateAgentIds: false });
    assert.equal(all.runs.length, 4);

    // 非法 sinceMs：非有限/负数 fail-closed
    await assert.rejects(
      () => listRuns({ runDir: dir, sinceMs: Number.NaN, nowMs: TD153_NOW, knownAgentIds: [] }),
      /--since must be a non-negative/,
    );
    await assert.rejects(
      () => listRuns({ runDir: dir, sinceMs: -1, nowMs: TD153_NOW, knownAgentIds: [] }),
      /--since must be a non-negative/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-153: --since 对 legacy 全无信封文件保持历史读法（末事件 ts 判窗，与 --latest 排序同语义档）", async () => {
  const dir = await makeRunDir();
  try {
    // legacy 无信封（事件不带 runId）——boundReportScope 无从绑定 → 历史读法
    await writeFile(join(dir, "run_leg_old.jsonl"),
      JSON.stringify({ type: "run.started", ts: td153Iso(TD153_NOW - 10 * TD153_DAY) }) + "\n", "utf8");
    await writeFile(join(dir, "run_leg_new.jsonl"),
      JSON.stringify({ type: "run.started", ts: td153Iso(TD153_NOW - 3_600_000) }) + "\n", "utf8");

    const out = await listRuns({
      runDir: dir, sinceMs: 7 * TD153_DAY, nowMs: TD153_NOW,
      knownAgentIds: [], validateAgentIds: false,
    });
    assert.deepEqual(out.runs.map((r) => r.runId), ["run_leg_new"],
      "legacy 按末事件 ts 判窗：新鲜保留、超龄排除（不因新 flag 改变 legacy 行为）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-153 篡改探针：外 run 伪造尾条不得翻转 --state/--since 过滤结果（R20-C C-4 绑定纪律同款）", async () => {
  const dir = await makeRunDir();
  try {
    // run_victim：本 run 绑定事件止于 10 天前的 failed 终态；尾部追加外 run
    // （run_other 信封）的新鲜 ts + run.state_change→running 伪造行。
    await writeJsonl(dir, "run_victim", [
      { type: "run.started", ts: td153Iso(TD153_NOW - 10 * TD153_DAY) },
      { type: "run.state_change", from: "running", to: "failed", reason: "real", ts: td153Iso(TD153_NOW - 10 * TD153_DAY + 1000) },
      { type: "run.state_change", from: "running", to: "running", reason: "forged", ts: td153Iso(TD153_NOW - 60_000), runId: "run_other" },
    ]);

    // (a) --state failed 仍命中：伪造 running 尾条不翻绑定 state
    const st = await listRuns({ runDir: dir, stateFilter: "failed", knownAgentIds: [], validateAgentIds: false });
    assert.deepEqual(st.runs.map((r) => r.runId), ["run_victim"]);

    // (b) --state running 不命中
    const stRun = await listRuns({ runDir: dir, stateFilter: "running", knownAgentIds: [], validateAgentIds: false });
    assert.deepEqual(stRun.runs.map((r) => r.runId), []);

    // (c) --since 1h（只覆盖伪造尾条 ts 的窗）不命中：updatedAt 仍是绑定末条 ts
    const fc = await listRuns({
      runDir: dir, sinceMs: 3_600_000, nowMs: TD153_NOW,
      knownAgentIds: [], validateAgentIds: false,
    });
    assert.deepEqual(fc.runs.map((r) => r.runId), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-153: --state × --since × --agent × --latest 任意叠加（行集叠加、输出形状不变）", async () => {
  const dir = await makeRunDir();
  try {
    // 交叉语料：agent × state × 时间窗（writeJsonl 默认 agentId "test"，可逐事件覆盖）
    await writeJsonl(dir, "run_a", [
      { type: "run.started", ts: td153Iso(TD153_NOW - 1_800_000) },
      { type: "run.state_change", from: "running", to: "failed", reason: "r", ts: td153Iso(TD153_NOW - 1_700_000) },
    ]);
    await writeJsonl(dir, "run_b", [
      { type: "run.started", ts: td153Iso(TD153_NOW - 10 * TD153_DAY) },
      { type: "run.state_change", from: "running", to: "failed", reason: "r", ts: td153Iso(TD153_NOW - 10 * TD153_DAY + 1000) },
    ]);
    await writeJsonl(dir, "run_c", [
      { type: "run.started", agentId: "researcher", ts: td153Iso(TD153_NOW - 7_200_000) },
      { type: "run.state_change", agentId: "researcher", from: "running", to: "failed", reason: "r", ts: td153Iso(TD153_NOW - 7_100_000) },
    ]);
    await writeJsonl(dir, "run_d", [
      { type: "run.started", ts: td153Iso(TD153_NOW - 3_600_000) },
      { type: "run.state_change", from: "running", to: "completed", reason: "r", ts: td153Iso(TD153_NOW - 3_500_000) },
    ]);

    const base = await listRuns({ runDir: dir, nowMs: TD153_NOW, knownAgentIds: [], validateAgentIds: false });
    assert.equal(base.runs.length, 4, "无过滤：交叉语料全列");

    const combo = await listRuns({
      runDir: dir, agentId: "test", stateFilter: "failed", sinceMs: 7 * TD153_DAY, latest: 5,
      nowMs: TD153_NOW, knownAgentIds: [], validateAgentIds: false,
    });
    assert.deepEqual(combo.runs.map((r) => r.runId), ["run_a"],
      "四过滤叠加：agent=test × failed × 7d 窗只剩 run_a");
    assert.equal(combo.matchedCount, 1);

    // --latest 在过滤后截取（matchedCount 是过滤后、截取前计数）
    const one = await listRuns({
      runDir: dir, stateFilter: "failed", sinceMs: 7 * TD153_DAY, latest: 1,
      nowMs: TD153_NOW, knownAgentIds: [], validateAgentIds: false,
    });
    assert.deepEqual(one.runs.map((r) => r.runId), ["run_a"], "failed × 7d 窗为 [run_a, run_c]，--latest 1 取最新");
    assert.equal(one.matchedCount, 2, "matchedCount 计过滤后截取前");

    // 输出形状稳定：顶层键集与行字段序与无过滤结果一致（过滤序不影响形状）
    assert.deepEqual(Object.keys(combo), Object.keys(base));
    assert.deepEqual(
      Object.keys(combo.runs[0]),
      Object.keys(base.runs.find((r) => r.runId === "run_a")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
