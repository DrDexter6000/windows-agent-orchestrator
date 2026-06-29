// scripts/long-run-probe.mjs
//
// P5/T3 长跑+自动捕获探测（方案 A+C）。
//
// 目的：把"盯 bug"自动化成"跑完看报告"。起 daemon（+supervisor 自愈）→ 循环派发真实 worker
// （coder_low 主 + 每 N 插 1 researcher）→ 每 30s 巡检 health + 失败 run → 跑完生成异常清单报告。
// token 受每 run 预算硬闸约束（S1-1，单 run 不失控），连续失败超限提前停（防 daemon 反复崩烧 token）。
//
// 用法：node scripts/long-run-probe.mjs [--duration 45m] [--token-budget 100000] [--max-consecutive-fails 3]
// 必须在 v22 跑（WAO 版本守卫拒 v24；本脚本经 daemon 派发真实 worker 烧 token）。
// 报告输出到 .dev/long-run-report.md。

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { connectDaemon, readHandshake, isDaemonAlive, DEFAULT_LIVENESS_THRESHOLD_MS } from "../src/daemon.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const runDir = join(ROOT, ".dev", "long-run-runs");
const reportPath = join(ROOT, ".dev", "long-run-report.md");
const cliPath = join(ROOT, "src", "cli.js");

// ---- 参数 ----
function parseArgs(argv) {
  const o = { durationMs: 45 * 60 * 1000, tokenBudget: 100000, maxConsecutiveFails: 3, researcherEvery: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--duration") { o.durationMs = parseDur(argv[++i]); }
    else if (a === "--token-budget") { o.tokenBudget = Number(argv[++i]); }
    else if (a === "--max-consecutive-fails") { o.maxConsecutiveFails = Number(argv[++i]); }
    else if (a === "--researcher-every") { o.researcherEvery = Number(argv[++i]); }
  }
  return o;
}
function parseDur(s) {
  const m = /^(\d+)(m|s|h)$/.exec(String(s));
  if (!m) return Number(s);
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3600000 : m[2] === "m" ? n * 60000 : n * 1000;
}

const OPTS = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[long-run ${new Date().toISOString().slice(11, 19)}]`, ...a);
const logErr = (...a) => console.error(`[long-run ${new Date().toISOString().slice(11, 19)}]`, ...a);

if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });

// ---- 状态 ----
const report = {
  startedAt: Date.now(),
  endedAt: null,
  durationMs: OPTS.durationMs,
  config: OPTS,
  dispatched: 0,
  completed: 0,
  failed: 0,
  consecutiveFails: 0,          // 连续 run 失败（长跑 bug 信号）
  consecutiveDispatchFails: 0,  // 连续派发解析失败（脚本/CLI bug 信号，与 run 失败分开计）
  healthAnomalies: [],   // [{at, sample}]
  failedRuns: [],        // [{runId, agentId, state, error}]
  timeline: [],          // [{at, event}]
};
const seenRunIds = new Set();

function cli(args, opts = {}) {
  return execFileSync(process.execPath, [cliPath, ...args], { cwd: ROOT, encoding: "utf8", ...opts, env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } });
}
// daemon run 输出是单个 JSON 对象（多行美化）。直接整段 parse；失败则找 {"ok" 行兜底。
function parseCliJson(out) {
  const trimmed = (out || "").trim();
  try { return JSON.parse(trimmed); } catch { /* 不是单段 JSON，尝试从首个 { 到末尾 */ }
  const start = trimmed.indexOf("{");
  if (start >= 0) { try { return JSON.parse(trimmed.slice(start)); } catch {} }
  return null;
}

// 派发一个 run（经 daemon），返回 {runId} 或 null
async function dispatchOne(idx) {
  const isResearcher = idx > 0 && idx % OPTS.researcherEvery === 0;
  const agentId = isResearcher ? "researcher" : "coder_low";
  const prompt = `Read the file package.json (relative to cwd). Reply with ONLY the "name" field's value from it, nothing else.`;
  try {
    const out = cli(["daemon", "run", agentId, "--prompt", prompt, "--run-dir", runDir, "--token-budget", String(OPTS.tokenBudget)], { stdio: ["ignore", "pipe", "pipe"] });
    const j = parseCliJson(out);
    if (j && j.runId) { report.dispatched++; seenRunIds.add(j.runId); log(`派发 #${idx + 1} ${agentId} → runId=${j.runId}`); return j.runId; }
    logErr(`派发 ${agentId} 无 runId: ${(out || "").slice(0, 200)}`); return null;
  } catch (e) {
    logErr(`派发 ${agentId} 异常: ${e.message.slice(0, 200)}`); return null;
  }
}

// 扫 runDir，统计各 run 终态 + 收集非 completed 的失败 run
function scanRuns() {
  const failed = [];
  let counts = { completed: 0, failed: 0, timed_out: 0, aborted: 0, running: 0, other: 0 };
  if (!existsSync(runDir)) return { failed, counts };
  for (const f of readdirSync(runDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const runId = f.replace(/\.jsonl$/, "");
    try {
      const evs = readFileSync(join(runDir, f), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      const state = findStateLocal(evs);
      if (["completed", "failed", "timed_out", "aborted"].includes(state)) counts[state]++;
      else if (state === "running") counts.running++;
      else counts.other++;
      if (seenRunIds.has(runId) && ["failed", "timed_out", "aborted"].includes(state)) {
        const err = evs.filter((e) => e.type === "run.error").at(-1);
        failed.push({ runId, state, error: err?.detail || err?.error || "(no error event)" });
      }
    } catch { /* 坏文件跳过 */ }
  }
  return { failed, counts };
}
function findStateLocal(events) {
  const sc = events.filter((e) => e.type === "run.state_change").at(-1);
  return sc?.to || "submitted";
}

// 巡检 health
function checkHealth() {
  try {
    const h = JSON.parse(readFileSync(join(runDir, "daemon-health.json"), "utf8"));
    if (h.level === "warn") report.healthAnomalies.push({ at: Date.now(), sample: h });
  } catch { /* health 文件未就绪 */ }
}

async function main() {
  log(`启动长跑探测：duration=${OPTS.durationMs / 60000}min tokenBudget=${OPTS.tokenBudget} researcherEvery=${OPTS.researcherEvery}`);

  // 1) 起 daemon（resume-on-start）+ supervisor
  try { cli(["daemon", "stop", "--run-dir", runDir], { stdio: "ignore" }); } catch {}
  await sleep(500);
  cli(["daemon", "start", "--run-dir", runDir, "--resume-on-start"], { stdio: "ignore" });
  await sleep(2000);
  let hs = readHandshake(runDir);
  if (!isDaemonAlive(hs, Date.now(), DEFAULT_LIVENESS_THRESHOLD_MS)) { logErr("daemon 起不来，中止"); report.endedAt = Date.now(); writeReport(); process.exit(1); }
  log(`daemon 起 pid=${hs.pid}`);
  cli(["daemon", "supervise", "--run-dir", runDir], { stdio: "ignore" });
  log("supervisor 起（自愈保护就位）");

  // 2) 主循环：派发 + 巡检，到时长或连续失败超限停
  const deadline = Date.now() + OPTS.durationMs;
  let idx = 0;
  let lastDispatchAt = Date.now();
  while (Date.now() < deadline) {
    // 派发一个（若上一个已终态或这是首个）
    const { counts: c0 } = scanRuns();
    const inFlight = (c0.running || 0) + (c0.other || 0);
    if (inFlight < 2) { // 控制并发 ≤2
      const rid = await dispatchOne(idx);
      idx++; lastDispatchAt = Date.now();
      // 派发解析失败单独记，不混入 run 失败的连续计数（那是不同性质的护栏）
      if (rid === null) { report.consecutiveDispatchFails++; if (report.consecutiveDispatchFails >= OPTS.maxConsecutiveFails) { logErr(`连续 ${report.consecutiveDispatchFails} 次派发解析失败，提前停（疑似脚本/CLI bug，非长跑 bug）`); report.timeline.push({ at: Date.now(), event: "early-stop:consecutive-dispatch-parse-fails" }); break; } }
      else { report.consecutiveDispatchFails = 0; }
    }
    // 巡检
    checkHealth();
    // 收集失败 run
    const { failed, counts } = scanRuns();
    for (const f of failed) {
      if (!report.failedRuns.find((x) => x.runId === f.runId)) {
        report.failedRuns.push(f); report.failed++;
        report.consecutiveFails++;
        logErr(`run 失败: ${f.runId} state=${f.state} error=${f.error.slice(0, 120)}`);
        if (report.consecutiveFails >= OPTS.maxConsecutiveFails) { logErr(`连续 ${report.consecutiveFails} 个 run 失败，提前停（疑似长跑 bug）`); report.timeline.push({ at: Date.now(), event: "early-stop:consecutive-run-fails" }); break; }
      }
    }
    if (report.consecutiveFails >= OPTS.maxConsecutiveFails) break;
    // 成功归零连续失败计数（有新 completed）
    const newlyCompleted = (counts.completed || 0);
    if (newlyCompleted > report.completed) { report.consecutiveFails = 0; report.consecutiveDispatchFails = 0; }
    report.completed = newlyCompleted;
    await sleep(5000); // 5s 轮询节奏
  }

  // 3) 收尾：等在飞 run 收敛（最多 2min），停 daemon/supervisor，写报告
  log("时长到/提前停，等在飞 run 收敛（最多 2min）...");
  const settleDeadline = Date.now() + 120000;
  while (Date.now() < settleDeadline) {
    const { counts } = scanRuns();
    if ((counts.running || 0) + (counts.other || 0) === 0) break;
    await sleep(10000);
  }
  try { cli(["daemon", "supervisor", "stop", "--run-dir", runDir], { stdio: "ignore" }); } catch {}
  try { cli(["daemon", "stop", "--run-dir", runDir], { stdio: "ignore" }); } catch {}
  report.endedAt = Date.now();
  const { counts: finalCounts } = scanRuns();
  report.finalCounts = finalCounts;
  writeReport();
  log(`完成。报告：${reportPath}`);
}

function writeReport() {
  const dur = Math.round((report.endedAt - report.startedAt) / 1000);
  const lines = [];
  lines.push("# P5/T3 长跑探测报告\n");
  lines.push(`- 起止：${new Date(report.startedAt).toISOString()} → ${new Date(report.endedAt).toISOString()}（${dur}s）`);
  lines.push(`- 配置：duration=${OPTS.durationMs / 60000}min tokenBudget=${OPTS.tokenBudget} researcherEvery=${OPTS.researcherEvery} maxConsecutiveFails=${OPTS.maxConsecutiveFails}`);
  lines.push(`- 派发：${report.dispatched} | 终态计数：${JSON.stringify(report.finalCounts || {})}`);
  lines.push(`- 健康异常（health warn）次数：${report.healthAnomalies.length}`);
  lines.push(`- 失败 run 数：${report.failedRuns.length}`);
  lines.push("");
  if (report.timeline.length) { lines.push("## 关键事件时间线"); for (const t of report.timeline) lines.push(`- ${new Date(t.at).toISOString()}: ${t.event}`); lines.push(""); }
  if (report.healthAnomalies.length) {
    lines.push("## 健康异常（每次 warn 采样）");
    for (const h of report.healthAnomalies) {
      lines.push(`- ${new Date(h.at).toISOString()}: rss=${(h.sample.rssBytes / 1048576).toFixed(0)}MB heap=${(h.sample.heapUsedBytes / 1048576).toFixed(0)}MB activeRuns=${h.sample.activeRuns} worktrees=${h.sample.worktreeCount} issues=${JSON.stringify(h.sample.issues.map((i) => i.metric))}`);
    }
    lines.push("");
  }
  if (report.failedRuns.length) {
    lines.push("## 失败 run 摘要");
    for (const f of report.failedRuns) lines.push(`- ${f.runId} [${f.state}]: ${f.error.slice(0, 200)}`);
    lines.push("");
  }
  lines.push("## 结论建议");
  if (report.healthAnomalies.length === 0 && report.failedRuns.length === 0) {
    lines.push("- ✅ 长跑稳定：无 health warn、无失败 run。daemon/supervisor/进程隔离在长跑下表现正常。");
    lines.push("- TD-46 的泄漏根因本轮未触发（可能需更长时长或更高负载；或阈值保守）。");
  } else {
    lines.push("- ⚠️ 发现异常，详见上节。每个失败 run / health warn 对应一个待开 TD，逐个红绿 TDD 修。");
  }
  writeFileSync(reportPath, lines.join("\n"), "utf8");
}

main().catch((e) => { logErr("探测异常:", e.message); report.endedAt = Date.now(); report.timeline.push({ at: Date.now(), event: `crash: ${e.message}` }); writeReport(); process.exit(1); });
