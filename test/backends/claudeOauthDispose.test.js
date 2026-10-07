// test/backends/claudeOauthDispose.test.js
//
// TD-223（2026-10-07）：ClaudeCodeBackend 的 OAuth 隔离目录生命周期测试。
//
// 覆盖：spawn 创建目录 + owner 标记（pid/createdAt）+ 凭据从注入源拷贝；
// 多 spawn 累积登记；dispose 全删 + 幂等 + 单目录失败继续；provider 通道不建目录；
// 目录名前缀/标记文件名与 sweep 模块（application/oauthDirSweep.js）的约定同步。
//
// 凭据纪律：构造参数 oauthCredentialsSource 注入 fixture 副本源——测试绝不
// 复制真实 ~/.claude/.credentials.json，绝不触碰真实 HOME。

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { ClaudeCodeBackend } from "../../src/backends/claudeCode.js";
import { OAUTH_DIR_PREFIX, OWNER_MARKER_FILE } from "../../src/application/oauthDirSweep.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../../src/envPolicy.js";

// TD-229（2026-10-07）：本文件钉【拷贝路径】生命周期。宿主迁移长期令牌后
// process.env 若带 CLAUDE_CODE_OAUTH_TOKEN，spawn 会切 token 模式（不拷贝），
// 本文件全部用例假红——测试期强制删值，跑完恢复（与 claudeOauthTokenMode.test.js
// 同款纪律：宿主 env 状态不得改变测试结局）。
let restoreProcessToken = () => {};
before(() => {
  const prev = Object.getOwnPropertyDescriptor(process.env, CLAUDE_OAUTH_TOKEN_ENV);
  delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
  restoreProcessToken = () => {
    if (prev === undefined) delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
    else process.env[CLAUDE_OAUTH_TOKEN_ENV] = prev.value;
  };
});
after(() => restoreProcessToken());

// 捕获 spawnFn（m12-14 同款）：记录 (binary, argv, opts)，返回立即 spawn→close(0)
// 的假子进程——backend 完整跑完目录预备/env 组装，无真实进程、无模型。
function makeCapturingSpawn() {
  const captures = [];
  const spawnFn = (binary, args, opts) => {
    captures.push({ binary, args: [...args], opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 6262 + captures.length;
    child.exitCode = null;
    child.signalCode = null;
    setImmediate(() => {
      child.emit("spawn");
      setImmediate(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
    });
    return child;
  };
  return { spawnFn, captures };
}

async function spawnAndCapture(backend, agent, task) {
  const handle = await backend.spawn(agent, task);
  for await (const _ev of handle.events(new AbortController().signal)) { /* drain */ }
}

function nativeAgent(extra = {}) {
  return { id: "w", backend: "claude-code", binary: "fake-claude", cwd: process.cwd(), ...extra };
}

function providerAgent(extra = {}) {
  return {
    id: "w",
    backend: "claude-code",
    cwd: process.cwd(),
    model: { id: "glm-5.2" },
    provider: {
      protocol: "anthropic-compatible",
      baseUrl: "https://provider.example/api/anthropic",
      apiKeyEnv: "TD223_PROVIDER_KEY",
    },
    ...extra,
  };
}

// fixture 凭据源：假 JSON（形状同真实 .credentials.json 的顶层键，值全 dummy）。
function makeCredentialsFixture(root) {
  const src = join(root, "fixture.credentials.json");
  writeFileSync(src, JSON.stringify({ claudeAiOauth: { accessToken: "dummy-not-a-real-token" } }), "utf8");
  return src;
}

// spawn 后从 env 捕获里取本次创建的隔离目录路径。
function capturedOauthDir(captures) {
  const dir = captures.at(-1).opts.env.CLAUDE_CONFIG_DIR;
  assert.ok(typeof dir === "string" && dir.length > 0, "env 应注入隔离目录路径");
  return dir;
}

// 防御性清理：断言失败路径下真实 tmpdir() 里的 fixture 目录不留残（force 容忍缺席）。
function safeRm(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* 已删/被占，交 sweep */ }
}

test("TD-223 dispose: native spawn 创建目录（标记 pid/createdAt + 凭据自注入源拷贝），dispose 删除", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td223-prepare-"));
  let trackedDir = null;
  try {
    const source = makeCredentialsFixture(root);
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: source });
    await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
    const dir = capturedOauthDir(captures);
    trackedDir = dir;

    // 前缀/标记名与 sweep 模块约定同步（两模块共用同一字符串的钉）。
    assert.ok(dir.startsWith(join(tmpdir(), OAUTH_DIR_PREFIX)), `目录名带 sweep 前缀：${dir}`);
    assert.ok(existsSync(join(dir, OWNER_MARKER_FILE)), "owner 标记文件在场");

    const marker = JSON.parse(readFileSync(join(dir, OWNER_MARKER_FILE), "utf8"));
    assert.equal(marker.pid, process.pid, "标记 pid = 创建进程");
    assert.ok(!Number.isNaN(Date.parse(marker.createdAt)), "标记 createdAt 是可解析 ISO 时间");

    assert.ok(existsSync(join(dir, ".credentials.json")), "凭据从注入源拷贝");
    assert.equal(
      readFileSync(join(dir, ".credentials.json"), "utf8"),
      readFileSync(source, "utf8"),
      "副本内容与注入源一致（不触真实 HOME）",
    );

    await backend.dispose();
    assert.ok(!existsSync(dir), "dispose 后目录删除");
    assert.deepEqual(backend._oauthConfigDirs, [], "登记表清空");
  } finally {
    if (trackedDir) safeRm(trackedDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 dispose: 凭据源缺席 → 空目录 + 标记仍在；dispose 照删", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td223-nocred-"));
  let trackedDir = null;
  try {
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({
      spawnFn,
      oauthCredentialsSource: join(root, "no-such-credentials.json"),
    });
    await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
    const dir = capturedOauthDir(captures);
    trackedDir = dir;
    assert.ok(!existsSync(join(dir, ".credentials.json")), "源缺席 → 无凭据副本");
    assert.ok(existsSync(join(dir, OWNER_MARKER_FILE)), "标记仍写入（先于凭据拷贝）");
    await backend.dispose();
    assert.ok(!existsSync(dir), "空目录同样回收");
  } finally {
    if (trackedDir) safeRm(trackedDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 dispose: 多次 spawn 累积多个目录（session 复用形态），dispose 一次清空 + 幂等", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td223-multi-"));
  const dirs = [];
  try {
    const source = makeCredentialsFixture(root);
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: source });
    await spawnAndCapture(backend, nativeAgent(), { prompt: "turn 1" });
    await spawnAndCapture(backend, nativeAgent(), { prompt: "turn 2" });
    await spawnAndCapture(backend, nativeAgent(), { prompt: "turn 3" });
    for (const c of captures) dirs.push(c.opts.env.CLAUDE_CONFIG_DIR);
    assert.equal(new Set(dirs).size, 3, "三次 spawn 三个不同目录");
    assert.deepEqual([...backend._oauthConfigDirs], dirs, "全部登记");

    await backend.dispose();
    for (const d of dirs) assert.ok(!existsSync(d), `目录已删：${d}`);

    await backend.dispose(); // 幂等：重复调用无害
    await backend.dispose();
    assert.deepEqual(backend._oauthConfigDirs, []);
  } finally {
    for (const d of dirs) safeRm(d);
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 dispose: provider wrapper 通道不建目录不登记；dispose 无害 no-op", async () => {
  const prev = process.env.TD223_PROVIDER_KEY;
  process.env.TD223_PROVIDER_KEY = "td223-dummy";
  try {
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn });
    await spawnAndCapture(backend, providerAgent(), { prompt: "do" });
    assert.ok(!captures[0].opts.env.CLAUDE_CONFIG_DIR, "provider 通道不注入隔离目录");
    assert.deepEqual(backend._oauthConfigDirs, [], "provider 通道零登记");
    await backend.dispose();
  } finally {
    if (prev === undefined) delete process.env.TD223_PROVIDER_KEY;
    else process.env.TD223_PROVIDER_KEY = prev;
  }
});

test("TD-223 dispose: 单目录删除失败（被占为子进程 CWD）继续其余目录，dispose 不抛", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td223-resilience-"));
  // Windows 实测（2026-10-07）：open 句柄/只读属性都会被 rmSync force 绕过，
  // 唯"目录作为子进程 CWD"确定性 EPERM——用它钉"单目录失败继续其余"。
  let child;
  let held = null;
  let free = null;
  try {
    const source = makeCredentialsFixture(root);
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: source });
    await spawnAndCapture(backend, nativeAgent(), { prompt: "held" });
    held = capturedOauthDir(captures);
    await spawnAndCapture(backend, nativeAgent(), { prompt: "free" });
    free = capturedOauthDir(captures);

    child = spawn(
      process.execPath,
      ["--eval", "process.chdir(process.argv[1]); process.stdout.write('READY'); setInterval(()=>{},1000);", held],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (c) => { buf += c; if (buf.includes("READY")) resolve(); });
      child.once("error", reject);
      setTimeout(resolve, 10_000);
    });

    await backend.dispose(); // 不得抛
    assert.ok(existsSync(held), "被占目录保留（占用释放后交 sweep 清扫）");
    assert.ok(!existsSync(free), "其余目录照常删除");
  } finally {
    if (child) { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }
    await new Promise((r) => setTimeout(r, 200)); // Windows 释放 CWD 占用
    if (held) safeRm(held); // held 在真实 tmpdir() 下，防御性回收
    if (free) safeRm(free);
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 验收修: 凭据拷贝中途抛错也回收——登记先于一切可抛步骤", async () => {
  // sol 会审 Q1：登记若晚于 prepare 返回，标记写入/拷贝抛错会漏回收。修后
  // onDirCreated 在 mkdtemp 后立即登记——本测试用「凭据源是目录」让 copyFileSync
  // 中途抛 EISDIR，断言 spawn 拒绝但目录已登记、dispose 能删。
  const root = mkdtempSync(join(tmpdir(), "wao-td223-throwreg-"));
  let trackedDir = null;
  try {
    const dirAsSource = join(root, "credentials-as-dir");
    mkdirSync(dirAsSource); // existsSync=true 但 copyFileSync 读它必抛
    const { spawnFn } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: dirAsSource });
    await assert.rejects(
      () => spawnAndCapture(backend, nativeAgent(), { prompt: "do" }),
      (e) => { trackedDir = backend._oauthConfigDirs[0] ?? null; return true; },
      "凭据源不可读时 spawn 必须抛错（照常由 CLI 认证路径如实报失败）",
    );
    assert.equal(backend._oauthConfigDirs.length, 1, "抛错路径目录仍已登记");
    assert.ok(trackedDir && existsSync(trackedDir), "抛错时目录已落盘（待 dispose 回收）");
    await backend.dispose();
    assert.ok(!existsSync(trackedDir), "抛错路径目录被 dispose 回收");
    assert.deepEqual(backend._oauthConfigDirs, []);
  } finally {
    if (trackedDir) safeRm(trackedDir);
    rmSync(root, { recursive: true, force: true });
  }
});
