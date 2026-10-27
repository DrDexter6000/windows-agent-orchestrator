// test/daemonHealth.test.js
//
// P5 / TD-46：daemon 长跑可观测性——健康评估纯函数。
//
// TD-46：长跑（数小时/天）暴露的句柄/内存/进程组累积，单元测试覆盖不到（需真实长跑）。
// 故 T2 只做"可观测+告警"（眼睛），不做"自动修根因"（根因靠 T3 长跑暴露后针对性修）。
// daemon 周期采样 process.memoryUsage + 在飞 run 数 + worktree 残留，写 daemon-health.json；
// assessDaemonHealth 纯函数按阈值判定健康状态，超阈→warn（可单测）。
//
// 纯函数 assessDaemonHealth(sample, thresholds) → {level:"ok"|"warn", issues:[]}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessDaemonHealth } from "../../src/daemonHealth.js";
import { daemonCommand } from "../../src/commands/daemon.js";

const OK_SAMPLE = {
  rssBytes: 80 * 1024 * 1024,   // 80MB
  heapUsedBytes: 30 * 1024 * 1024, // 30MB
  activeRuns: 2,
  worktreeCount: 1,
  uptimeMs: 3600000, // 1h
};

// ===== 全在阈值内 → ok =====
test("全维度在阈值内 → ok，无 issues", () => {
  const r = assessDaemonHealth(OK_SAMPLE);
  assert.equal(r.level, "ok");
  assert.deepEqual(r.issues, []);
});

// ===== RSS 超阈 → warn（内存累积是长跑泄漏主信号）=====
test("RSS 超阈 → warn + 含 memory issue", () => {
  const r = assessDaemonHealth({ ...OK_SAMPLE, rssBytes: 600 * 1024 * 1024 }, { rssWarnBytes: 500 * 1024 * 1024 });
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /rss|内存|memory/i.test(i.metric)), "应含 rss/memory issue");
});

// ===== heap used 超阈 → warn =====
test("heap used 超阈 → warn", () => {
  const r = assessDaemonHealth({ ...OK_SAMPLE, heapUsedBytes: 400 * 1024 * 1024 }, { heapWarnBytes: 300 * 1024 * 1024 });
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /heap/i.test(i.metric)));
});

// ===== worktree 残留超阈 → warn（进程组/文件累积信号）=====
test("worktree 残留超阈 → warn", () => {
  const r = assessDaemonHealth({ ...OK_SAMPLE, worktreeCount: 15 }, { worktreeWarnCount: 10 });
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /worktree/i.test(i.metric)));
});

// ===== 在飞 run 异常多 → warn（可能是 stuck run 累积）=====
test("在飞 run 超阈 → warn", () => {
  const r = assessDaemonHealth({ ...OK_SAMPLE, activeRuns: 25 }, { activeRunsWarnCount: 20 });
  assert.equal(r.level, "warn");
  assert.ok(r.issues.some((i) => /run/i.test(i.metric)));
});

// ===== 多维度同时超 → 全部列出 =====
test("多维度同时超 → issues 全列（不只第一个）", () => {
  const r = assessDaemonHealth({
    rssBytes: 600 * 1024 * 1024, heapUsedBytes: 400 * 1024 * 1024,
    activeRuns: 2, worktreeCount: 1, uptimeMs: 1000,
  }, { rssWarnBytes: 500 * 1024 * 1024, heapWarnBytes: 300 * 1024 * 1024 });
  assert.equal(r.level, "warn");
  assert.ok(r.issues.length >= 2, "应列多个 issue");
});

// ===== 缺字段不崩（某采样维度缺失 → 跳过该判定）=====
test("采样缺字段（如无 worktreeCount）→ 跳过该判定不崩", () => {
  const r = assessDaemonHealth({ rssBytes: 80 * 1024 * 1024, heapUsedBytes: 30 * 1024 * 1024, activeRuns: 1 });
  assert.equal(r.level, "ok", "缺的维度跳过，其余 ok 则 ok");
  assert.deepEqual(r.issues, []);
});

// ===== 坏/空输入 =====
test("空/坏输入 → ok（保守，不误报）", () => {
  assert.equal(assessDaemonHealth(null).level, "ok");
  assert.equal(assessDaemonHealth({}).level, "ok");
  assert.equal(assessDaemonHealth(undefined).level, "ok");
});

// ===== 阈值默认值合理（不传 thresholds 用默认）=====
test("不传 thresholds 用默认值，正常 sample → ok", () => {
  const r = assessDaemonHealth(OK_SAMPLE); // 不传第二参
  assert.equal(r.level, "ok");
});

// ===== `daemon health` 读侧新鲜度（stale 改判）=====
//
// 宿主实机踩坑：daemon 停掉 11 天后，health 仍原样打印旧的 worktree 残留告警，
// 读者据此去清不存在的残留。读侧（src/commands/daemon.js daemonHealthCommand）现在
// 用 sampledAt + daemon 判活盖戳：daemon 不在跑或采样超 10 分钟 → level=stale，
// 原结论降级进 lastSample；新鲜时在原内容上追加 fresh/daemonRunning 等字段。
// 纯阈值判定（上方 assessDaemonHealth 用例）不动。

// 与 daemon 真实写盘形状一致（src/daemon.js healthTimer：采样字段 + level + issues）。
const HEALTH_SAMPLE = (sampledAt) => ({
  rssBytes: 80 * 1024 * 1024,
  heapUsedBytes: 30 * 1024 * 1024,
  activeRuns: 2,
  worktreeCount: 129,
  uptimeMs: 3600000,
  sampledAt,
  level: "warn",
  issues: [{
    metric: "worktree", value: 129, threshold: 10,
    message: "worktree 残留 129 > 阈值 10（进程组/文件累积，需清理）",
  }],
});

// 在跑 daemon 的 handshake（readHandshake 读的就是 runDir/daemon.json）。
// startedAt 默认 1 分钟前：health 的 fresh 门要求采样不早于 daemon 启动
// （sampledAt >= startedAt），默认取过去侧，让"daemon 在跑 + 刚写的采样"直接判新鲜。
const LIVE_HANDSHAKE = (heartbeatAt = Date.now(), startedAt = Date.now() - 60 * 1000) => ({
  pid: process.pid, pipe: "x", startedAt, heartbeatAt,
});

/** 捕获 console.log 输出（daemon 命令族用 console.log 渲染 JSON）。用完恢复。 */
async function captureConsoleLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

/** 走真实 CLI 入口跑 `daemon health`，解析 JSON 输出。临时目录用完即删。 */
async function runHealthCheck(setup, t) {
  const dir = mkdtempSync(join(tmpdir(), "wao-daemon-health-"));
  try {
    setup(dir);
    const out = await captureConsoleLog(
      () => daemonCommand(["health", "--run-dir", dir], { runDir: dir }),
    );
    return JSON.parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("health：新鲜采样 + daemon 在跑 → 原字段全在，追加 fresh/daemonRunning", async () => {
  const parsed = await runHealthCheck((dir) => {
    writeFileSync(join(dir, "daemon-health.json"), JSON.stringify(HEALTH_SAMPLE(Date.now())));
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(LIVE_HANDSHAKE()));
  });
  assert.equal(parsed.fresh, true);
  assert.equal(parsed.daemonRunning, true);
  assert.equal(parsed.level, "warn", "level 保持原值，不改判");
  assert.equal(parsed.sampledAtSource, "sample");
  assert.equal(typeof parsed.ageMs, "number");
  assert.ok(parsed.ageMs >= 0 && parsed.ageMs < 60000, "新鲜采样 ageMs 应在分钟内");
  // 原内容一个不少：采样字段 + level + issues 都还在顶层。
  assert.equal(parsed.rssBytes, 80 * 1024 * 1024);
  assert.equal(parsed.heapUsedBytes, 30 * 1024 * 1024);
  assert.equal(parsed.activeRuns, 2);
  assert.equal(parsed.worktreeCount, 129);
  assert.equal(parsed.uptimeMs, 3600000);
  assert.deepEqual(parsed.issues, HEALTH_SAMPLE(0).issues);
});

test("health：11 天前的采样 + daemon 不在跑 → level=stale，原结论只在 lastSample", async () => {
  const elevenDaysMs = 11 * 24 * 60 * 60 * 1000;
  const parsed = await runHealthCheck((dir) => {
    writeFileSync(
      join(dir, "daemon-health.json"),
      JSON.stringify(HEALTH_SAMPLE(Date.now() - elevenDaysMs)),
    );
    // 不写 daemon.json = daemon 不在跑
  });
  assert.equal(parsed.level, "stale");
  assert.equal(parsed.fresh, false);
  assert.equal(parsed.daemonRunning, false);
  assert.ok(!("issues" in parsed), "顶层不得再出现 issues（否则读者仍会当成当前结论）");
  assert.equal(parsed.lastSample.level, "warn");
  assert.deepEqual(parsed.lastSample.issues, HEALTH_SAMPLE(0).issues);
  assert.equal(typeof parsed.note, "string");
  assert.match(parsed.note, /daemon 未运行/);
  assert.ok(parsed.ageMs >= elevenDaysMs - 60000, "ageMs 应约等于 11 天");
});

test("health：采样很新但 daemon 心跳已死 → 仍 stale（daemonRunning=false）", async () => {
  const parsed = await runHealthCheck((dir) => {
    writeFileSync(join(dir, "daemon-health.json"), JSON.stringify(HEALTH_SAMPLE(Date.now())));
    // handshake 存在但 heartbeatAt 是 1 小时前（判活阈值 10s，必死）。
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(LIVE_HANDSHAKE(Date.now() - 60 * 60 * 1000)));
  });
  assert.equal(parsed.level, "stale");
  assert.equal(parsed.fresh, false);
  assert.equal(parsed.daemonRunning, false);
  assert.match(parsed.note, /daemon 未运行/);
});

test("health：采样缺 sampledAt → 用文件 mtime（sampledAtSource=mtime）", async () => {
  const parsed = await runHealthCheck((dir) => {
    const { sampledAt, ...noTs } = HEALTH_SAMPLE(Date.now());
    writeFileSync(join(dir, "daemon-health.json"), JSON.stringify(noTs));
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(LIVE_HANDSHAKE()));
  });
  assert.equal(parsed.sampledAtSource, "mtime");
  assert.equal(parsed.fresh, true, "mtime 刚写、daemon 在跑 → 新鲜");
  assert.equal(parsed.level, "warn", "level 保持原值");
});

// ===== 边界补齐（会审 2026-10-28）：坏时间戳不崩、未来/上一轮采样不判新鲜 =====

test("health：daemon 在跑但采样 11 分钟前 → stale（sample_too_old）", async () => {
  const parsed = await runHealthCheck((dir) => {
    writeFileSync(join(dir, "daemon-health.json"), JSON.stringify(HEALTH_SAMPLE(Date.now() - 11 * 60 * 1000)));
    // daemon 启动于 12 分钟前（早于采样）：排除 sample_from_previous_daemon，钉住纯年龄阈值。
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(LIVE_HANDSHAKE(Date.now(), Date.now() - 12 * 60 * 1000)));
  });
  assert.equal(parsed.level, "stale");
  assert.equal(parsed.fresh, false);
  assert.equal(parsed.daemonRunning, true);
  assert.equal(parsed.staleReason, "sample_too_old");
});

test("health：daemon 在跑且采样 9 分钟前 → fresh（10 分钟阈值内）", async () => {
  const parsed = await runHealthCheck((dir) => {
    writeFileSync(join(dir, "daemon-health.json"), JSON.stringify(HEALTH_SAMPLE(Date.now() - 9 * 60 * 1000)));
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(LIVE_HANDSHAKE(Date.now(), Date.now() - 10 * 60 * 1000)));
  });
  assert.equal(parsed.fresh, true);
  assert.equal(parsed.daemonRunning, true);
});

test("health：sampledAt 超出 Date 范围（1e20）→ 不抛，退回 mtime", async () => {
  const parsed = await runHealthCheck((dir) => {
    // 旧实现：new Date(1e20).toISOString() 抛 RangeError，命令直接崩。
    writeFileSync(join(dir, "daemon-health.json"), JSON.stringify(HEALTH_SAMPLE(1e20)));
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(LIVE_HANDSHAKE()));
  });
  assert.equal(parsed.sampledAtSource, "mtime");
  assert.equal(parsed.fresh, true, "mtime 刚写、daemon 在跑 → 新鲜");
});

test("health：采样时间戳在未来（+1 天）→ stale（sample_in_future），note 无负号分钟数", async () => {
  const parsed = await runHealthCheck((dir) => {
    writeFileSync(join(dir, "daemon-health.json"), JSON.stringify(HEALTH_SAMPLE(Date.now() + 24 * 60 * 60 * 1000)));
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(LIVE_HANDSHAKE()));
  });
  assert.equal(parsed.level, "stale");
  assert.equal(parsed.fresh, false);
  assert.equal(parsed.daemonRunning, true);
  assert.equal(parsed.staleReason, "sample_in_future");
  assert.ok(!/-\d/.test(parsed.note), "note 不得出现负号分钟数（如'约 -1440 分钟前'）");
});

test("health：采样略在未来（+30s，容差带内）→ fresh", async () => {
  const parsed = await runHealthCheck((dir) => {
    writeFileSync(join(dir, "daemon-health.json"), JSON.stringify(HEALTH_SAMPLE(Date.now() + 30 * 1000)));
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(LIVE_HANDSHAKE()));
  });
  assert.equal(parsed.fresh, true, "时钟偏差容差（60s）内不判未来");
});

test("health：daemon 不在跑且采样在未来 → staleReason 取 daemon_not_running（优先级）", async () => {
  const parsed = await runHealthCheck((dir) => {
    writeFileSync(join(dir, "daemon-health.json"), JSON.stringify(HEALTH_SAMPLE(Date.now() + 24 * 60 * 60 * 1000)));
    // 不写 daemon.json = daemon 不在跑
  });
  assert.equal(parsed.level, "stale");
  assert.equal(parsed.daemonRunning, false);
  assert.equal(parsed.staleReason, "daemon_not_running", "两个原因同时成立时按优先级取第一个");
});

test("health：采样早于当前 daemon 启动（上一轮残留）→ stale（sample_from_previous_daemon）", async () => {
  const parsed = await runHealthCheck((dir) => {
    // 采样 5 分钟前，daemon 4 分钟前才启动（重启窗口）：采样内容属于上一轮 daemon。
    writeFileSync(join(dir, "daemon-health.json"), JSON.stringify(HEALTH_SAMPLE(Date.now() - 5 * 60 * 1000)));
    writeFileSync(join(dir, "daemon.json"), JSON.stringify(LIVE_HANDSHAKE(Date.now(), Date.now() - 4 * 60 * 1000)));
  });
  assert.equal(parsed.level, "stale");
  assert.equal(parsed.fresh, false);
  assert.equal(parsed.daemonRunning, true);
  assert.equal(parsed.staleReason, "sample_from_previous_daemon");
});

test("health：合法 JSON 但不是对象（null/42/[]）→ ok:false，无 fresh 键", async () => {
  for (const raw of ["null", "42", "[]"]) {
    const parsed = await runHealthCheck((dir) => {
      writeFileSync(join(dir, "daemon-health.json"), raw);
      writeFileSync(join(dir, "daemon.json"), JSON.stringify(LIVE_HANDSHAKE()));
    });
    assert.equal(parsed.ok, false, `${raw} 应输出 ok:false`);
    assert.ok(!("fresh" in parsed), `${raw} 输出不得带 fresh 键（daemon 在跑也不给健康结论）`);
    assert.match(parsed.note, /存在但不是有效的采样对象/);
  }
});

test("health：坏 JSON → ok:false，提示'存在但无效'而非'缺失'", async () => {
  const parsed = await runHealthCheck((dir) => {
    writeFileSync(join(dir, "daemon-health.json"), "{not json");
  });
  assert.equal(parsed.ok, false);
  assert.ok(!("fresh" in parsed));
  assert.match(parsed.note, /存在但不是有效的采样对象/);
  assert.ok(!/no daemon-health\.json/.test(parsed.note), "坏文件不得报成文件缺失");
});

test("health：daemon-health.json 缺失 → 原缺失提示", async () => {
  const parsed = await runHealthCheck(() => { /* 不写文件 */ });
  assert.equal(parsed.ok, false);
  assert.match(parsed.note, /no daemon-health\.json/);
});
