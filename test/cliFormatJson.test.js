// cliFormatJson.test.js
//
// TD-86（D2 A1）：剩余 7 个子命令的 `--format json` 机器可读输出。
//
// 背景：registry validate/check、runs list/summary/grep、wao decision list、
// wao handoff read 里 6 个此前接受 `--format json` 但静默输出纯文本（flag 被吞）；
// `wao handoff read` 未找到时已输出 JSON `{found:false}`，但找到时输出裸 markdown。
// 本文件用 spawn 级 CLI 测试锁定 JSON 契约（JSON.parse(stdout) 必须成功 + 代表字段），
// 并为 `wao decision list` / `wao handoff read` 补 CLI 级 text 路径守卫（其余 5 个
// 命令已有 CLI 级 text 测试：test/runs.test.js 与 test/cli.test.js）。
//
// 子进程注入 WAO_SKIP_VERSION_GUARD=1（与 cli.test.js 的 runCliOnPathNode 同一
// 自包含模式），验证的是 CLI 渲染行为本身，不是 version guard。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * spawn 级跑 repo 的 src/cli.js（guard 豁免注入），返回 {status, stdout, stderr}。
 * 用异步 spawn（不是 spawnSync）：spawnSync 会阻塞本进程事件循环，本文件
 * registry check 测试的回环 HTTP server 就无法应答子进程（实测 ok 路径被饿到 5s abort）。
 */
async function runCli(args, { timeout = 60_000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], {
      cwd: ROOT,
      env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error(`runCli timeout after ${timeout}ms: ${args.join(" ")}`));
    }, timeout);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => { clearTimeout(timer); rejectRun(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ status: code, stdout, stderr });
    });
  });
}

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** 写一个 run transcript（与 runs.test.js 的 writeJsonl 同构）。 */
function writeRunTranscript(dir, runId, events) {
  const lines = events.map((e) => JSON.stringify({ runId, agentId: "test", ...e }));
  writeFileSync(join(dir, `${runId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

// =====================================================================
// TD-86 A1-1/A1-2: registry validate / registry check
// =====================================================================

test("TD-86: registry validate --format json 输出 {checked,valid,agents}，维持 invalid → exit 1 契约", async () => {
  const dir = makeTempDir("wao-fmt-validate-");
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_low: { backend: "claude-code", cwd: dir, model: { id: "deepseek-v4-flash" } },
        coder_mm: { backend: "kimi-code", cwd: dir, tokenBudget: 100000 },
        bad_worker: { backend: "claude-code", model: { id: "x" } }, // 缺 cwd → issue
      },
    }), "utf8");

    const r = await runCli(["registry", "validate", "--registry", registryPath, "--format", "json"]);
    assert.equal(r.status, 1, "JSON 模式维持 exit code 契约（invalid → exit 1）");
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.checked, 3, "checked = 处理的 agent 数");
    assert.equal(parsed.valid, false, "含错误条目 → valid:false");
    assert.ok(Array.isArray(parsed.agents), "agents 是数组");

    const low = parsed.agents.find((a) => a.id === "coder_low");
    assert.equal(low.ok, true, "合法 claude-code agent → ok:true");
    assert.deepEqual(low.issues, [], "无 issue");
    assert.deepEqual(low.warnings, [], "无 warning");

    // TD-87 的 kimi tokenBudget 静默无效陷阱 → warnings 字段承载（非阻塞）
    const mm = parsed.agents.find((a) => a.id === "coder_mm");
    assert.equal(mm.ok, true, "kimi 配 tokenBudget 仍 ok（warning 不阻塞）");
    assert.ok(mm.warnings.some((w) => /kimi-code.*tokenBudget/.test(w)),
      "kimi tokenBudget warning 进 warnings 数组");

    const bad = parsed.agents.find((a) => a.id === "bad_worker");
    assert.equal(bad.ok, false, "缺 cwd → ok:false");
    assert.ok(bad.issues.some((i) => /missing cwd/i.test(i)), "issues 含 missing cwd");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-86: registry check --format json 输出 {allOk,agents:[{id,status}]}（ok/fail/skip，不依赖真实网络）", async () => {
  const dir = makeTempDir("wao-fmt-check-");
  // 只监听 127.0.0.1 的回环 HTTP 服务（"ok" 分支），不触真实网络。
  const server = createServer((req, res) => { res.writeHead(200); res.end("{}"); });
  try {
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const port = server.address().port;
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        ok_worker: {
          backend: "opencode-serve",
          serveUrl: `http://127.0.0.1:${port}`,
          agent: "build",
          cwd: dir,
          model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" },
        },
        down_worker: {
          backend: "opencode-serve",
          serveUrl: "http://127.0.0.1:1", // 回环不可达端口 → 连接拒绝（快，≤5s timeout）
          agent: "build",
          cwd: dir,
          model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" },
        },
        proc_worker: { backend: "claude-code", cwd: dir, model: { id: "x" } }, // 非 opencode → SKIP 分支
      },
    }), "utf8");

    const r = await runCli(["registry", "check", "--registry", registryPath, "--format", "json"]);
    assert.equal(r.status, 1, "含 fail 条目 → exit 1（既有契约）");
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.allOk, false, "down_worker FAIL → allOk:false");

    const byId = Object.fromEntries(parsed.agents.map((a) => [a.id, a]));
    assert.equal(byId.ok_worker.status, "ok", "回环 200 → status:ok");
    assert.equal(byId.ok_worker.serveUrl, `http://127.0.0.1:${port}`, "ok 条目带 serveUrl");
    assert.equal(byId.down_worker.status, "fail", "连接拒绝 → status:fail");
    assert.ok(typeof byId.down_worker.error === "string" && byId.down_worker.error.length > 0,
      "fail 条目带 error");
    assert.equal(byId.proc_worker.status, "skip", "进程式 backend → SKIP 分支");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    cleanupDir(dir);
  }
});

// =====================================================================
// TD-86 A1-3/A1-4/A1-5: runs list / summary / grep
// =====================================================================

test("TD-86: runs list --format json 直接序列化 listRuns 结果", async () => {
  const dir = makeTempDir("wao-fmt-runslist-");
  try {
    writeRunTranscript(dir, "run_aaa", [
      { type: "run.started" },
      { type: "run.completed" },
    ]);
    writeRunTranscript(dir, "run_bbb", [
      { type: "run.started" },
    ]);

    const r = await runCli(["runs", "list", "--run-dir", dir, "--format", "json"]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.runs), "runs 数组（listRuns 结果原样）");
    assert.equal(parsed.runs.length, 2);
    assert.equal(parsed.runs[0].runId, "run_aaa", "CLI 既有文件名升序保持");
    assert.equal(parsed.runs[0].state, "completed", "代表字段 state");
    assert.equal(parsed.matchedCount, 2, "matchedCount 透传");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-86: runs summary --format json 输出 {total,byState,latest}", async () => {
  const dir = makeTempDir("wao-fmt-runssum-");
  try {
    writeRunTranscript(dir, "run_aaa", [
      { type: "run.started", ts: "2026-06-12T10:00:00.000Z" },
    ]);
    writeRunTranscript(dir, "run_bbb", [
      { type: "run.started", ts: "2026-06-12T11:00:00.000Z" },
      { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-06-12T11:05:00.000Z" },
    ]);

    const r = await runCli(["runs", "summary", "--run-dir", dir, "--format", "json"]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.total, 2);
    assert.deepEqual(parsed.byState, { completed: 1, running: 1 });
    assert.equal(parsed.latest, "2026-06-12T11:05:00.000Z", "latest = 最新事件 ts");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-86: runs grep --format json 输出 {pattern,matched,matches}（每 run 首个命中）", async () => {
  const dir = makeTempDir("wao-fmt-runsgrep-");
  try {
    writeRunTranscript(dir, "run_aaa", [
      { type: "run.started", ts: "2026-06-12T10:00:00.000Z", cwd: "D:/projects/alpha" },
      { type: "messages.collected", ts: "2026-06-12T10:01:00.000Z", cwd: "D:/projects/alpha" },
    ]);
    writeRunTranscript(dir, "run_bbb", [
      { type: "run.started", ts: "2026-06-12T11:00:00.000Z", cwd: "D:/projects/beta" },
    ]);

    const r = await runCli(["runs", "grep", "alpha", "--run-dir", dir, "--format", "json"]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.pattern, "alpha");
    assert.equal(parsed.matched, 1);
    assert.equal(parsed.matches.length, 1, "每 run 只记首个命中（text 路径 break 语义）");
    assert.equal(parsed.matches[0].runId, "run_aaa");
    assert.equal(parsed.matches[0].type, "run.started", "首个命中事件类型");
    assert.equal(parsed.matches[0].ts, "2026-06-12T10:00:00.000Z");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// TD-86 A1-6/A1-7: wao decision list / wao handoff read
// =====================================================================

/** 直接写 .wao/decisions/map.md 索引（listDecisions 只读 map，不扫正文）。 */
function writeDecisionMap(dir, entries) {
  const decisionsDir = join(dir, ".wao", "decisions");
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(join(decisionsDir, "map.md"), entries.join("\n") + "\n", "utf8");
}

test("TD-86: wao decision list --format json 输出 {decisions:string[]}（行数组原样包装）", async () => {
  const dir = makeTempDir("wao-fmt-dec-");
  try {
    writeDecisionMap(dir, ["0001 | 状态读丰富查询", "0002 | handoff 自动化"]);

    const r = await runCli(["wao", "decision", "list", "--cwd", dir, "--format", "json"]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.decisions), "decisions 是 string[]");
    assert.equal(parsed.decisions.length, 2);
    assert.match(parsed.decisions[0], /^0001 \| /, "索引行原样，不发明 id/title 解析");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-86 守卫: wao decision list 默认 text 输出逐行索引（CLI 级守卫，防未来漂移）", async () => {
  const dir = makeTempDir("wao-fmt-dectext-");
  try {
    writeDecisionMap(dir, ["0001 | 状态读丰富查询"]);
    const r = await runCli(["wao", "decision", "list", "--cwd", dir]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "0001 | 状态读丰富查询", "无 --format 时逐行打印，字节不变");
  } finally {
    cleanupDir(dir);
  }
});

/** 直接写一张发给 role 的交接卡（heading 需含 `# Handoff: <from> → <to> (<ts>)`）。 */
function writeHandoffCard(dir, fileName, body) {
  const handoffDir = join(dir, ".wao", "handoff");
  mkdirSync(handoffDir, { recursive: true });
  writeFileSync(join(handoffDir, fileName), body, "utf8");
}

const HANDOFF_BODY = "# Handoff: researcher → lead (20260814T120000)\n\n## Summary\n调研结论：collect --final 可行。\n\n";

test("TD-86: wao handoff read --format json（存在 handoff）输出 {found:true,role,body}", async () => {
  const dir = makeTempDir("wao-fmt-handoff-");
  try {
    writeHandoffCard(dir, "researcher-20260814T120000.md", HANDOFF_BODY);

    const r = await runCli(["wao", "handoff", "read", "lead", "--cwd", dir, "--format", "json"]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.found, true);
    assert.equal(parsed.role, "lead");
    assert.equal(parsed.body, HANDOFF_BODY, "body 为交接卡正文原文");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-86 守卫: wao handoff read 默认 text 输出裸 markdown 正文（CLI 级守卫，防未来漂移）", async () => {
  const dir = makeTempDir("wao-fmt-handofftext-");
  try {
    writeHandoffCard(dir, "researcher-20260814T120000.md", HANDOFF_BODY);
    const r = await runCli(["wao", "handoff", "read", "lead", "--cwd", dir]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, HANDOFF_BODY + "\n", "无 --format 时打印裸正文（console.log 语义）");
  } finally {
    cleanupDir(dir);
  }
});
