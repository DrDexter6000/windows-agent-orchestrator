// TD-92 debug mode：friction 自动捕获测试。
//
// 设计契约：
//   - 复用 diagnoseFailure 分类（不另测分类逻辑——那是 diagnosis.test.js 的职责）
//   - 镜像 raiseAlert 纪律：写失败降级不抛
//   - debug mode 默认关；category=none/unknown 不写（噪声）
//
// 本测试只验证 writeFrictionLog 的写入行为（开关/路径/不抛），不重测分类准确性。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFrictionLog, isDebugMode, frictionLogDirFromRunDir } from "../src/frictionLog.js";

// 一个 provider_auth 失败 transcript（会让 diagnoseFailure 返回 provider_auth）
const FAILED_EVENTS = [
  { type: "run.started", ts: "2026-07-08T10:00:00.000Z" },
  { type: "run.error", phase: "wait", error: "provider error [401]: 身份验证失败", ts: "2026-07-08T10:00:05.000Z" },
  { type: "run.state_change", from: "running", to: "failed", reason: "backend_error", ts: "2026-07-08T10:00:06.000Z" },
];

// 一个成功 transcript（diagnoseFailure 返回 none）
const COMPLETED_EVENTS = [
  { type: "run.started", ts: "2026-07-08T10:00:00.000Z" },
  { type: "run.completed", ts: "2026-07-08T10:00:10.000Z" },
  { type: "run.state_change", from: "running", to: "completed", reason: "done", ts: "2026-07-08T10:00:10.000Z" },
];

test("TD-92: failed run + debug 开 → 写 auto-*.md 含 category + evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-friction-"));
  try {
    const frictionDir = join(dir, ".dev", "friction-log");
    const path = await writeFrictionLog("run_test12345678", "researcher", FAILED_EVENTS, {
      frictionLogDir: frictionDir,
      debugMode: true,
    });
    assert.ok(path, "应返回写入路径");
    assert.ok(path.includes("auto-"), "文件名应有 auto- 前缀");
    assert.ok(path.includes("provider_auth"), "文件名应含 category");
    const files = await readdir(frictionDir);
    assert.equal(files.length, 1, "friction-log 目录应有 1 个文件");
    const content = await readFile(path, "utf8");
    assert.match(content, /provider_auth/, "正文应含 category");
    assert.match(content, /身份验证失败/, "正文应含 evidence fact");
    assert.match(content, /Subjective.*TODO.*Lead/s, "正文应留主观 TODO 给 Lead");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-92: completed run（category=none）→ 不写文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-friction-"));
  try {
    const frictionDir = join(dir, ".dev", "friction-log");
    const path = await writeFrictionLog("run_ok12345678ab", "coder_hq", COMPLETED_EVENTS, {
      frictionLogDir: frictionDir,
      debugMode: true,
    });
    assert.equal(path, null, "成功 run 不应写 friction log");
    const files = await readdir(frictionDir).catch(() => []);
    assert.equal(files.length, 0, "friction-log 目录应空");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-92: debug 关（默认）→ 不写文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-friction-"));
  try {
    const frictionDir = join(dir, ".dev", "friction-log");
    const path = await writeFrictionLog("run_test12345678", "researcher", FAILED_EVENTS, {
      frictionLogDir: frictionDir,
      debugMode: false,
    });
    assert.equal(path, null, "debug 关时不应写");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TD-92: 写失败（目录不可写）→ 不抛（降级 stderr，镜像 raiseAlert 纪律）", async () => {
  // 用一个不可能的路径触发写失败（不抛——friction 捕获绝不阻塞 run 终态）
  const path = await writeFrictionLog("run_test12345678", "researcher", FAILED_EVENTS, {
    frictionLogDir: "Z:\\impossible\\nonexistent\\drive\\friction-log-td92",
    debugMode: true,
  });
  // 不抛即通过；返回 null（写失败降级）
  assert.equal(path, null, "写失败应返回 null 不抛");
});

test("TD-92: isDebugMode 优先级——opts.debugMode > WAO_DEBUG env > false", () => {
  // opts 显式 true
  assert.equal(isDebugMode({ debugMode: true }), true);
  // opts 显式 false（即使 env 开）
  const oldEnv = process.env.WAO_DEBUG;
  process.env.WAO_DEBUG = "1";
  try {
    assert.equal(isDebugMode({ debugMode: false }), false, "opts.debugMode=false 应压过 env");
    assert.equal(isDebugMode({}), true, "opts 不传时读 env");
  } finally {
    if (oldEnv === undefined) delete process.env.WAO_DEBUG;
    else process.env.WAO_DEBUG = oldEnv;
  }
  // 默认关
  assert.equal(isDebugMode({}), false, "无 opts 无 env → 默认关");
});

test("TD-92: frictionLogDirFromRunDir 从 runDir 推导 .dev/friction-log/", () => {
  const dir = frictionLogDirFromRunDir(join("tmp", "runs"));
  assert.ok(dir.includes(".dev"), "应含 .dev");
  assert.ok(dir.includes("friction-log"), "应含 friction-log");
});
