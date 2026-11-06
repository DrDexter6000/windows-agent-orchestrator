// test/backends/claudeSessionConfigDir.test.js
//
// 决定 0114：claude-code 复用/续修（task.sessionReuse）的稳定隔离配置目录。
//
// 覆盖：
//   - 首轮（lead_workspace）与续修轮（run_lineage）拿到同一个 CLAUDE_CONFIG_DIR；
//     目录名只放 opaque uuid 的 sha256 摘要（不放 uuid 本身）；
//   - 目录在首次 spawn 时创建，只含 owner 标记（纯净模式：不拷贝凭据、不放用户
//     settings/hooks/插件/CLAUDE.md——后两者由 CLI 自己写会话状态）；
//   - dispose() 删除普通运行的 mkdtemp 目录，但保留会话目录；
//   - 拷贝凭据模式（长期令牌缺席）+ sessionReuse → 在启动 CLI 之前具名失败，
//     不创建目录、不 spawn（不静默退回每次新建目录）；
//   - CLI 不发 result 帧、只在 stderr 写会话不存在原文后非零退出 → 同一固定句，
//     uuid 不经 stderr 尾部进事件流。
//
// 纪律：oauthCredentialsSource 注入 fixture——测试绝不复制真实
// ~/.claude/.credentials.json；process.env 的令牌在每个用例内显式控制。
// 会话目录父目录经 sessionConfigDirRoot 注入本文件临时根并整体清理，绝不在真实
// %TEMP% 留 wao-claude-session-* 目录。

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EventEmitter } from "node:events";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";

import {
  ClaudeCodeBackend,
  SESSION_CONFIG_DIR_PREFIX,
  SESSION_REUSE_REQUIRES_TOKEN_ERROR,
} from "../../src/backends/claudeCode.js";
import { PROVIDER_SESSION_NOT_FOUND_ERROR } from "../../src/backends/parsers/claudeCode.js";
import { SESSION_DIR_PREFIX, OWNER_MARKER_FILE } from "../../src/application/oauthDirSweep.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../../src/envPolicy.js";

const DUMMY_TOKEN = "b77-dummy-long-term-token-value";

// 本文件用 resolvedCredentials 显式给令牌；宿主 process.env 若有同名值不得改变
// "令牌缺席"用例的结局——测试期强制删值，跑完恢复。
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

// 捕获 spawnFn：记录 (binary, argv, opts)，返回立即 spawn→close(0) 的假子进程。
function makeCapturingSpawn() {
  const captures = [];
  const spawnFn = (binary, args, opts) => {
    captures.push({ binary, args: [...args], opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 6464 + captures.length;
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

async function spawnAndCollect(backend, agent, task) {
  const handle = await backend.spawn(agent, task);
  const events = [];
  for await (const ev of handle.events(new AbortController().signal)) events.push(ev);
  return events;
}

// 无 result 帧的 CLI 形态：只往 stderr 写 `stderr`，然后非零退出。
function makeScriptedStderrSpawn(stderr, exitCode = 1) {
  const captures = [];
  const spawnFn = (binary, args, opts) => {
    captures.push({ binary, args: [...args], opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 6565 + captures.length;
    child.exitCode = null;
    child.signalCode = null;
    setImmediate(() => {
      child.emit("spawn");
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from(stderr, "utf8"));
        child.exitCode = exitCode;
        child.emit("close", exitCode);
      });
    });
    return child;
  };
  return { spawnFn, captures };
}

function nativeAgent(extra = {}) {
  return { id: "w", backend: "claude-code", binary: "fake-claude", cwd: process.cwd(), ...extra };
}

function capturedDir(captures) {
  const dir = captures.at(-1).opts.env.CLAUDE_CONFIG_DIR;
  assert.ok(typeof dir === "string" && dir.length > 0, "env 应注入 CLAUDE_CONFIG_DIR");
  return dir;
}

function sessionDirFor(uuid, root = tmpdir()) {
  const digest = createHash("sha256").update(uuid, "utf8").digest("hex");
  return join(root, SESSION_CONFIG_DIR_PREFIX + digest);
}

function safeRm(p) {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* 交 sweep */ }
}

function makeCredentialsFixture(root) {
  const src = join(root, "fixture.credentials.json");
  writeFileSync(src, JSON.stringify({ claudeAiOauth: { accessToken: "dummy-not-a-real-token" } }), "utf8");
  return src;
}

test("0114: 首轮与续修轮拿到同一个 CLAUDE_CONFIG_DIR，目录名只含 uuid 摘要", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0114-session-dir-"));
  const uuid = randomUUID();
  const expected = sessionDirFor(uuid, root);
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn, sessionConfigDirRoot: root });
  try {
    await spawnAndCapture(backend, nativeAgent(), {
      prompt: "first turn",
      sessionReuse: { mode: "lead_workspace", turn: "first", opaqueUuid: uuid },
      resolvedCredentials: { [CLAUDE_OAUTH_TOKEN_ENV]: DUMMY_TOKEN },
    });
    const firstDir = capturedDir(captures);
    await spawnAndCapture(backend, nativeAgent(), {
      prompt: "continuation",
      sessionReuse: { mode: "run_lineage", turn: "resume", opaqueUuid: uuid, priorRunId: "run_prior" },
      resolvedCredentials: { [CLAUDE_OAUTH_TOKEN_ENV]: DUMMY_TOKEN },
    });
    const resumeDir = capturedDir(captures);

    assert.equal(SESSION_CONFIG_DIR_PREFIX, SESSION_DIR_PREFIX, "创建侧与清扫侧同一目录前缀（约定同步）");
    assert.equal(firstDir, expected, "目录名 = 前缀 + opaque uuid 的 sha256 摘要");
    assert.equal(resumeDir, firstDir, "续修轮复用首轮的同一个目录");
    assert.equal(basename(firstDir), SESSION_CONFIG_DIR_PREFIX + createHash("sha256").update(uuid).digest("hex"));
    assert.ok(!firstDir.includes(uuid), "目录名不放 uuid 本身");
    assert.ok(existsSync(firstDir), "首轮目录已建");

    // 纯净模式：WAO 只写 owner 标记，不拷贝凭据、不放用户配置面。
    assert.deepEqual(readdirSync(firstDir).sort(), [OWNER_MARKER_FILE], "首次 spawn 后目录只有 owner 标记");
    assert.ok(!existsSync(join(firstDir, ".credentials.json")), "长期令牌模式不拷贝凭据");
    const marker = JSON.parse(readFileSync(join(firstDir, OWNER_MARKER_FILE), "utf8"));
    assert.equal(marker.pid, process.pid, "标记 pid = 当前进程");
    assert.ok(!Number.isNaN(Date.parse(marker.createdAt)), "createdAt 可解析");
    assert.ok(!Number.isNaN(Date.parse(marker.usedAt)), "usedAt 可解析（清扫按它判最近使用）");

    await backend.dispose();
    assert.ok(existsSync(firstDir), "dispose() 不删会话目录（续修还要用）");
    assert.deepEqual(backend._oauthConfigDirs, [], "会话目录不进普通目录删除表");
  } finally {
    safeRm(expected);
    rmSync(root, { recursive: true, force: true });
  }
});

test("0114: dispose() 删除普通运行目录，保留会话目录", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0114-dispose-mixed-"));
  const source = makeCredentialsFixture(root);
  const uuid = randomUUID();
  const sessionDir = sessionDirFor(uuid, root);
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({
    spawnFn,
    oauthCredentialsSource: source,
    sessionConfigDirRoot: root,
  });
  let ordinaryDir = null;
  try {
    await spawnAndCapture(backend, nativeAgent(), {
      prompt: "ordinary",
      resolvedCredentials: {},
    });
    ordinaryDir = capturedDir(captures);
    assert.ok(existsSync(join(ordinaryDir, ".credentials.json")), "普通运行照旧走拷贝路径");

    await spawnAndCapture(backend, nativeAgent(), {
      prompt: "reused",
      sessionReuse: { mode: "lead_workspace", turn: "first", opaqueUuid: uuid },
      resolvedCredentials: { [CLAUDE_OAUTH_TOKEN_ENV]: DUMMY_TOKEN },
    });
    assert.equal(capturedDir(captures), sessionDir, "复用运行用稳定会话目录");

    await backend.dispose();
    assert.ok(!existsSync(ordinaryDir), "普通运行目录终态删除（TD-223 行为不变）");
    assert.ok(existsSync(sessionDir), "会话目录跨终态存活");
  } finally {
    if (ordinaryDir) safeRm(ordinaryDir);
    safeRm(sessionDir);
    rmSync(root, { recursive: true, force: true });
  }
});

test("0114: 拷贝凭据模式 + sessionReuse → 启动 CLI 前具名失败（不建目录、不 spawn）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0114-copy-mode-"));
  const uuid = randomUUID();
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn, sessionConfigDirRoot: root });
  try {
    await assert.rejects(
      () => backend.spawn(nativeAgent(), {
        prompt: "continuation without long-term token",
        sessionReuse: { mode: "lead_workspace", turn: "resume", opaqueUuid: uuid, priorRunId: "run_prior" },
        resolvedCredentials: {}, // 令牌缺席 = 拷贝凭据模式
      }),
      (error) => {
        assert.match(error.message, /session reuse requires a long-term OAuth token/i);
        assert.match(error.message, /CLAUDE_CODE_OAUTH_TOKEN/, "失败信息说明要配长期令牌");
        assert.ok(!error.message.includes(uuid), "失败信息不回显 opaque uuid");
        return true;
      },
    );
    assert.equal(captures.length, 0, "CLI 未被 spawn");
    assert.deepEqual(backend._oauthConfigDirs, [], "不创建普通目录");
    assert.ok(!existsSync(sessionDirFor(uuid, root)), "不创建会话目录（不静默退回每次新建）");
    assert.equal(SESSION_REUSE_REQUIRES_TOKEN_ERROR.includes(uuid), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0114: 空串令牌（resolvedCredentials 长度 0）同样视为缺席 → 具名失败", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0114-empty-token-"));
  const uuid = randomUUID();
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn, sessionConfigDirRoot: root });
  try {
    await assert.rejects(
      () => backend.spawn(nativeAgent(), {
        prompt: "x",
        sessionReuse: { mode: "lead_workspace", turn: "resume", opaqueUuid: uuid, priorRunId: "run_prior" },
        resolvedCredentials: { [CLAUDE_OAUTH_TOKEN_ENV]: "" },
      }),
      /session reuse requires a long-term OAuth token/i,
    );
    assert.equal(captures.length, 0);
    assert.ok(!existsSync(sessionDirFor(uuid, root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0114: CLI 无 result 帧、stderr 写会话不存在原文后非零退出 → 同一固定句，uuid 不进事件流", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0114-stderr-"));
  const source = makeCredentialsFixture(root);
  const uuid = "7f3c2b1a-9d8e-4f6a-8b5c-1d2e3f4a5b6c";
  const stderr = `No conversation found with session ID: ${uuid}\n`;
  const { spawnFn } = makeScriptedStderrSpawn(stderr, 1);
  // 普通运行路径：注入 fixture 凭据源（绝不碰真实 ~/.claude），终态 dispose 删除
  // 本次 mkdtemp 目录（含凭据副本）。
  const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: source });
  try {
    const events = await spawnAndCollect(backend, nativeAgent(), { prompt: "resume without result frame" });
    const done = events.at(-1);
    assert.equal(done.kind, "done");
    assert.equal(done.reason, "failed");
    assert.equal(done.error, PROVIDER_SESSION_NOT_FOUND_ERROR, "stderr 兜底用同一固定句");
    assert.ok(!JSON.stringify(events).includes(uuid), "uuid 不经 stderr 尾部/事件流进转录");
    assert.ok(!JSON.stringify(events).includes("No conversation found"), "provider 原文不回显");
  } finally {
    await backend.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
