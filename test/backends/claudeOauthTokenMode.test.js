// test/backends/claudeOauthTokenMode.test.js
//
// TD-229（2026-10-07）：claude-code native OAuth 通道长期令牌模式测试。
//
// 覆盖：令牌可解析（task.resolvedCredentials 优先 / process.env 兜底）→ 隔离目录
// 保持空（标记在场、无凭据副本——即使凭据源存在），令牌值穿入子进程 env；令牌
// 缺席/空串 → 回退旧拷贝路径（与 TD-223 行为字节不变）；envPolicy 派生（native
// 通道才继承令牌名，provider 通道不继承）；令牌值经 inheritedNames 进脱敏器。
//
// 凭据纪律：oauthCredentialsSource 注入 fixture——测试绝不复制真实
// ~/.claude/.credentials.json；CLAUDE_CODE_OAUTH_TOKEN 在每个用例内显式控制
// （宿主机器迁移后 setx 该变量，本文件不得假红——缺席用例先删 process.env 值）。

import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { ClaudeCodeBackend } from "../../src/backends/claudeCode.js";
import { OWNER_MARKER_FILE } from "../../src/application/oauthDirSweep.js";
import { inheritedEnvNames, CLAUDE_OAUTH_TOKEN_ENV } from "../../src/envPolicy.js";
import { createSecretRedactor } from "../../src/secretRedaction.js";

// 与 claudeOauthDispose.test.js 同款捕获 spawn（假子进程立即 close(0)）。
function makeCapturingSpawn() {
  const captures = [];
  const spawnFn = (binary, args, opts) => {
    captures.push({ binary, args: [...args], opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 6290 + captures.length;
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

function providerAgent() {
  return {
    id: "w",
    backend: "claude-code",
    cwd: process.cwd(),
    model: { id: "glm-5.2" },
    provider: {
      protocol: "anthropic-compatible",
      baseUrl: "https://provider.example/api/anthropic",
      apiKeyEnv: "TD229_PROVIDER_KEY",
    },
  };
}

function makeCredentialsFixture(root) {
  const src = join(root, "fixture.credentials.json");
  writeFileSync(src, JSON.stringify({ claudeAiOauth: { accessToken: "dummy-not-a-real-token" } }), "utf8");
  return src;
}

function capturedOauthDir(captures) {
  const dir = captures.at(-1).opts.env.CLAUDE_CONFIG_DIR;
  assert.ok(typeof dir === "string" && dir.length > 0, "env 应注入隔离目录路径");
  return dir;
}

// 本文件自己的 env 控制：save/delete/restore 一处实现，缺席用例强制删值。
function withoutProcessToken() {
  const prev = Object.getOwnPropertyDescriptor(process.env, CLAUDE_OAUTH_TOKEN_ENV);
  delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
  return () => {
    if (prev === undefined) delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
    else process.env[CLAUDE_OAUTH_TOKEN_ENV] = prev.value;
  };
}

const DUMMY_TOKEN = "td229-dummy-long-term-token-value";

test("TD-229 token 模式（resolvedCredentials）：目录空+标记在，凭据源存在也不拷贝；令牌值穿入子进程 env", async () => {
  const restore = withoutProcessToken();
  const root = mkdtempSync(join(tmpdir(), "wao-td229-token-"));
  let trackedDir = null;
  try {
    const source = makeCredentialsFixture(root); // 凭据源在场——拷贝路径可用
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: source });
    await spawnAndCapture(backend, nativeAgent(), {
      prompt: "do",
      resolvedCredentials: { [CLAUDE_OAUTH_TOKEN_ENV]: DUMMY_TOKEN },
    });
    const dir = capturedOauthDir(captures);
    trackedDir = dir;

    assert.ok(existsSync(join(dir, OWNER_MARKER_FILE)), "owner 标记仍写入（sweep 判定不因模式变化）");
    assert.ok(!existsSync(join(dir, ".credentials.json")), "token 模式不拷贝凭据（拷贝与续期轮换互斥，TD-229）");
    assert.equal(captures[0].opts.env[CLAUDE_OAUTH_TOKEN_ENV], DUMMY_TOKEN, "令牌值经 inheritedNames 穿入子进程 env");

    await backend.dispose();
    assert.ok(!existsSync(dir), "token 模式目录同样被 dispose 回收");
  } finally {
    restore();
    if (trackedDir) { try { rmSync(trackedDir, { recursive: true, force: true }); } catch { /* 交 sweep */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-229 token 模式（process.env 兜底）：直接 spawn 路径同判定——目录空、子进程 env 带值", async () => {
  const prev = process.env[CLAUDE_OAUTH_TOKEN_ENV];
  process.env[CLAUDE_OAUTH_TOKEN_ENV] = DUMMY_TOKEN;
  const root = mkdtempSync(join(tmpdir(), "wao-td229-procenv-"));
  let trackedDir = null;
  try {
    const source = makeCredentialsFixture(root);
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: source });
    // 直接 spawn 形态：无 resolvedCredentials（buildChildEnv 的 inherited 段与
    // prepare 判定同读 process.env——两者必须一致，见 activeOauthTokenValue）。
    await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
    const dir = capturedOauthDir(captures);
    trackedDir = dir;

    assert.ok(!existsSync(join(dir, ".credentials.json")), "process.env 令牌同样触发空目录模式");
    assert.equal(captures[0].opts.env[CLAUDE_OAUTH_TOKEN_ENV], DUMMY_TOKEN, "inherited 段带上令牌值");
    await backend.dispose();
  } finally {
    if (prev === undefined) delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
    else process.env[CLAUDE_OAUTH_TOKEN_ENV] = prev;
    if (trackedDir) { try { rmSync(trackedDir, { recursive: true, force: true }); } catch { /* 交 sweep */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-229 令牌缺席：回退拷贝路径，与 TD-223 行为字节不变（宿主已迁移也不假红）", async () => {
  const restore = withoutProcessToken();
  const root = mkdtempSync(join(tmpdir(), "wao-td229-copy-"));
  let trackedDir = null;
  try {
    const source = makeCredentialsFixture(root);
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: source });
    await spawnAndCapture(backend, nativeAgent(), { prompt: "do", resolvedCredentials: {} });
    const dir = capturedOauthDir(captures);
    trackedDir = dir;

    assert.ok(existsSync(join(dir, ".credentials.json")), "缺席 → 照常拷贝");
    assert.equal(
      readFileSync(join(dir, ".credentials.json"), "utf8"),
      readFileSync(source, "utf8"),
      "副本内容与注入源一致（TD-223 原行为）",
    );
    assert.ok(captures[0].opts.env[CLAUDE_OAUTH_TOKEN_ENV] === undefined, "子进程 env 不带令牌");
    await backend.dispose();
  } finally {
    restore();
    if (trackedDir) { try { rmSync(trackedDir, { recursive: true, force: true }); } catch { /* 交 sweep */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-229 空字符串令牌（resolvedCredentials 里长度 0）视为缺席：走拷贝路径", async () => {
  const restore = withoutProcessToken();
  const root = mkdtempSync(join(tmpdir(), "wao-td229-empty-"));
  let trackedDir = null;
  try {
    const source = makeCredentialsFixture(root);
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: source });
    await spawnAndCapture(backend, nativeAgent(), {
      prompt: "do",
      resolvedCredentials: { [CLAUDE_OAUTH_TOKEN_ENV]: "" },
    });
    const dir = capturedOauthDir(captures);
    trackedDir = dir;
    assert.ok(existsSync(join(dir, ".credentials.json")), "空串 ≠ 可解析令牌 → 拷贝路径");
    await backend.dispose();
  } finally {
    restore();
    if (trackedDir) { try { rmSync(trackedDir, { recursive: true, force: true }); } catch { /* 交 sweep */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

// sol 验收 P2-2（2026-10-07）的两个构造性反例——判定必须镜像 buildChildEnv 的
// 合并语义：resolvedCredentials 出现该名字（任意大小写、string 值含空串）即压过
// process.env 同名值（credEnv 段后铺）。
test("TD-229 镜像钉①：resolvedCredentials 空串【覆盖】process.env 非空值 → 判定拷贝（子进程同样只拿到空串）", async () => {
  const prev = process.env[CLAUDE_OAUTH_TOKEN_ENV];
  process.env[CLAUDE_OAUTH_TOKEN_ENV] = DUMMY_TOKEN; // 进程值非空——若不镜像会被误判 token 模式
  const root = mkdtempSync(join(tmpdir(), "wao-td229-mirror1-"));
  let trackedDir = null;
  try {
    const source = makeCredentialsFixture(root);
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: source });
    await spawnAndCapture(backend, nativeAgent(), {
      prompt: "do",
      resolvedCredentials: { [CLAUDE_OAUTH_TOKEN_ENV]: "" }, // credEnv 压过 inherited
    });
    const dir = capturedOauthDir(captures);
    trackedDir = dir;
    assert.ok(existsSync(join(dir, ".credentials.json")), "空串覆盖 → 判定拷贝模式（与子进程实收一致）");
    assert.equal(captures[0].opts.env[CLAUDE_OAUTH_TOKEN_ENV], "", "子进程实收为空串（credEnv 后铺压过进程值）");
    await backend.dispose();
  } finally {
    if (prev === undefined) delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
    else process.env[CLAUDE_OAUTH_TOKEN_ENV] = prev;
    if (trackedDir) { try { rmSync(trackedDir, { recursive: true, force: true }); } catch { /* 交 sweep */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-229 镜像钉②：resolvedCredentials 小写键非空 → 判定 token 模式（子进程按大小写不敏感放行同收该值）", async () => {
  const restore = withoutProcessToken();
  const root = mkdtempSync(join(tmpdir(), "wao-td229-mirror2-"));
  let trackedDir = null;
  try {
    const source = makeCredentialsFixture(root);
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn, oauthCredentialsSource: source });
    await spawnAndCapture(backend, nativeAgent(), {
      prompt: "do",
      resolvedCredentials: { claude_code_oauth_token: DUMMY_TOKEN }, // 小写变体
    });
    const dir = capturedOauthDir(captures);
    trackedDir = dir;
    assert.ok(!existsSync(join(dir, ".credentials.json")), "小写键非空 → 判定 token 模式（不拷贝，与子进程实收一致）");
    const childValue = Object.entries(captures[0].opts.env)
      .filter(([n]) => n.toUpperCase() === CLAUDE_OAUTH_TOKEN_ENV)
      .map(([, v]) => v);
    assert.deepEqual(childValue, [DUMMY_TOKEN], "子进程按大小写不敏感放行收到该值");
    await backend.dispose();
  } finally {
    restore();
    if (trackedDir) { try { rmSync(trackedDir, { recursive: true, force: true }); } catch { /* 交 sweep */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-229 envPolicy 派生：native 通道继承令牌名；provider 通道不继承（防认证优先级被抢）", () => {
  const native = inheritedEnvNames(nativeAgent());
  assert.ok(native.includes(CLAUDE_OAUTH_TOKEN_ENV), `native 通道应含 ${CLAUDE_OAUTH_TOKEN_ENV}`);
  assert.ok(!native.includes("TD229_PROVIDER_KEY"), "native 通道不带 provider 凭据名");

  const prev = process.env.TD229_PROVIDER_KEY;
  process.env.TD229_PROVIDER_KEY = "td229-dummy";
  try {
    const provider = inheritedEnvNames(providerAgent());
    assert.ok(provider.includes("TD229_PROVIDER_KEY"), "provider 通道保留自身凭据名");
    assert.ok(!provider.includes(CLAUDE_OAUTH_TOKEN_ENV), "provider 通道不得继承长期令牌名（wrapper 自带凭据，混入会抢认证优先级）");
  } finally {
    if (prev === undefined) delete process.env.TD229_PROVIDER_KEY;
    else process.env.TD229_PROVIDER_KEY = prev;
  }
});

test("TD-229 脱敏：令牌值经 inheritedNames 进脱敏器，明文永不留在 redact 输出", () => {
  const names = inheritedEnvNames(nativeAgent());
  const redactor = createSecretRedactor({ [CLAUDE_OAUTH_TOKEN_ENV]: DUMMY_TOKEN }, names);
  const out = redactor.redactString(`prefix ${DUMMY_TOKEN} suffix`);
  assert.ok(!out.includes(DUMMY_TOKEN), "明文令牌不得出现在 redact 输出");
  assert.ok(out.includes(`[REDACTED:${CLAUDE_OAUTH_TOKEN_ENV}]`), "替换标记指向令牌名");
});
