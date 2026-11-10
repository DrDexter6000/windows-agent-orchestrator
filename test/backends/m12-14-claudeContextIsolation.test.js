// test/m12-14-claudeContextIsolation.test.js
//
// M12-14 Package 2：worker 上下文隔离 —— claude-code 子进程强制关闭 provider
// auto-memory。
//
// 生产事故（RED）：一个 claude-code supervised worker 获得了 provider auto-memory
// 能力，在 WAO 检测到 workdir_escape 之前成功编辑了 WAO worktree 之外的全局 memory
// 文件。修复：ClaudeCodeBackend 把 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 注入【每一个】
// supervised 子进程 env（OAuth 直连 / start / resume 会话复用），
// 且 backend 安全值覆盖任何 agent.env 反设企图（Windows env 大小写不敏感，大小写
// 变体也算）。不动 RunManager、不加 runtime-name 分支、不加能力布尔。
//
// 捕获手段：ProcessBackend 的 spawnFn 注入缝（M11-7），直接读 spawn 收到的真实
// child env / argv，不起真实进程、不调模型。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ClaudeCodeBackend } from "../../src/backends/claudeCode.js";
import { CodexBackend } from "../../src/backends/codex.js";
import { ZcodeBackend } from "../../src/backends/zcode.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../../src/envPolicy.js";

// TD-229（2026-10-07，sol 验收 P2-1）：本文件钉 native 通道【拷贝路径】的隔离目录
// 机制。宿主迁移长期令牌后 process.env 若带 CLAUDE_CODE_OAUTH_TOKEN，spawn 切
// token 模式（不拷贝），下方"凭据在场性=源在场性"断言假红——测试期强制删值，
// 跑完恢复（与 claudeOauthDispose.test.js 同款纪律）。
// 决定 0114：会话目录父目录注入本文件临时根并整体清理——测试不得在真实 %TEMP%
// 留 wao-claude-session-* 目录。凭据源同样注入 fixture：普通运行路径只从这里
// 拷贝假凭据，绝不复制真实 ~/.claude/.credentials.json。
let sessionDirRoot = null;
let credentialsSource = null;
const backends = [];
let restoreProcessToken = () => {};
before(() => {
  const prev = Object.getOwnPropertyDescriptor(process.env, CLAUDE_OAUTH_TOKEN_ENV);
  delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
  restoreProcessToken = () => {
    if (prev === undefined) delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
    else process.env[CLAUDE_OAUTH_TOKEN_ENV] = prev.value;
  };
  sessionDirRoot = mkdtempSync(join(tmpdir(), "wao-m1214-session-root-"));
  credentialsSource = join(sessionDirRoot, "fixture.credentials.json");
  writeFileSync(credentialsSource, JSON.stringify({ claudeAiOauth: { accessToken: "dummy-not-a-real-token" } }), "utf8");
});
after(async () => {
  for (const backend of backends) await backend.dispose();
  restoreProcessToken();
  if (sessionDirRoot) rmSync(sessionDirRoot, { recursive: true, force: true });
});

function makeClaudeBackend(options = {}) {
  const backend = new ClaudeCodeBackend({
    sessionConfigDirRoot: sessionDirRoot,
    oauthCredentialsSource: credentialsSource,
    ...options,
  });
  backends.push(backend);
  return backend;
}

const MANAGED = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
// 决定 0114：sessionReuse 的稳定配置目录只在长期令牌模式下建立；本文件钉的是
// auto-memory/env 隔离，给 sessionReuse 用例一个显式假令牌（不触真实凭据）。
const SESSION_REUSE_TOKEN = "m1214-session-dummy-token";

// 捕获 spawnFn：记录 (binary, argv, opts)，返回一个立即 'spawn' → 'close'(0) 的
// 假子进程，让 backend 完整跑完 env 组装与 argv 编译，无需真实子进程或模型。
function makeCapturingSpawn() {
  const captures = [];
  const spawnFn = (binary, args, opts) => {
    captures.push({ binary, args: [...args], opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // stdio 协议族（zcode/claude-code）会向 stdin 写行/收尾——假写入立即成功，
    // 行不被消费；end/destroy 无操作（close 事件另行触发）。
    child.stdin = new EventEmitter();
    child.stdin.write = (_data, cb) => (typeof cb === "function" ? cb() : undefined);
    child.stdin.end = (cb) => (typeof cb === "function" ? cb() : undefined);
    child.stdin.destroy = () => {};
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

// env 对象里按 Windows 语义（大小写不敏感）找指定名字的条目。
function envEntriesCaseInsensitive(env, name) {
  const upper = name.toUpperCase();
  return Object.entries(env ?? {}).filter(([k]) => k.toUpperCase() === upper);
}

// ── 1. 每一条 spawn 路径都强制注入 ─────────────────────────────────────

test("M12-14: native OAuth 路径（无 provider）子进程 env 含 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
  assert.equal(captures.length, 1, "恰好一次 spawn");
  assert.equal(captures[0].opts.env[MANAGED], "1", "native 直连子进程必须关闭 auto-memory");
});

test("M12-14: 会话复用 first turn（--session-id）子进程 env 含 flag，argv 复用语义不变", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  const uuid = "11111111-2222-4333-8444-555555555555";
  await spawnAndCapture(backend, nativeAgent(), {
    prompt: "do",
    sessionReuse: { turn: "first", opaqueUuid: uuid },
    resolvedCredentials: { [CLAUDE_OAUTH_TOKEN_ENV]: SESSION_REUSE_TOKEN },
  });
  const cap = captures[0];
  assert.equal(cap.opts.env[MANAGED], "1", "first turn 子进程必须关闭 auto-memory");
  const idx = cap.args.indexOf("--session-id");
  assert.ok(idx >= 0, "first turn 仍带 --session-id");
  assert.equal(cap.args[idx + 1], uuid, "--session-id 值不变");
  assert.ok(!cap.args.includes("--resume"), "first turn 不带 --resume");
  assert.ok(!cap.args.includes("--no-session-persistence"), "first turn 不带 --no-session-persistence");
});

test("M12-14: 会话复用 resume turn（--resume）子进程 env 含 flag，argv 复用语义不变", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  const uuid = "11111111-2222-4333-8444-555555555555";
  await spawnAndCapture(backend, nativeAgent(), {
    prompt: "do",
    sessionReuse: { turn: "resume", opaqueUuid: uuid },
    resolvedCredentials: { [CLAUDE_OAUTH_TOKEN_ENV]: SESSION_REUSE_TOKEN },
  });
  const cap = captures[0];
  assert.equal(cap.opts.env[MANAGED], "1", "resume turn 子进程必须关闭 auto-memory");
  const idx = cap.args.indexOf("--resume");
  assert.ok(idx >= 0, "resume turn 仍带 --resume");
  assert.equal(cap.args[idx + 1], uuid, "--resume 值不变");
  assert.ok(!cap.args.includes("--session-id"), "resume turn 不带 --session-id");
});

test("M12-14: 无会话复用（--no-session-persistence）子进程 env 含 flag", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
  const cap = captures[0];
  assert.equal(cap.opts.env[MANAGED], "1");
  assert.ok(cap.args.includes("--no-session-persistence"), "默认路径 argv 不变");
});

// ── 2. 覆盖抵抗：agent.env 无法重新打开 auto-memory ─────────────────────

test("M12-14: agent.env 精确名反设 '0' 被 backend 安全值覆盖", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent({ env: { [MANAGED]: "0" } }), { prompt: "do" });
  assert.equal(captures[0].opts.env[MANAGED], "1", "backend runtimeEnv 必须压过 agent.env");
});

test("M12-14: agent.env 大小写变体反设被剥离（Windows env 大小写不敏感）", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  await spawnAndCapture(
    backend,
    nativeAgent({ env: { claude_code_disable_auto_memory: "0", Claude_Code_Disable_Auto_Memory: "0" } }),
    { prompt: "do" },
  );
  const entries = envEntriesCaseInsensitive(captures[0].opts.env, MANAGED);
  assert.equal(entries.length, 1, "子进程 env 里该名字（任意大小写）恰好一条，无重复歧义");
  assert.deepEqual(entries[0], [MANAGED, "1"], "唯一条目是 backend 权威值");
});

// ── 3. 既有行为不回归：角色合同 / deliveryMode / argv / 值不泄漏 ────────

test("M12-14: role contract 注入保持（--append-system-prompt 恰好一次）且 env 含 flag", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do", roleContract: "ROLE_BODY" });
  const cap = captures[0];
  assert.equal(cap.opts.env[MANAGED], "1");
  const occurrences = cap.args.filter((a) => a === "--append-system-prompt").length;
  assert.equal(occurrences, 1, "--append-system-prompt 恰好一次");
  assert.equal(cap.args[cap.args.indexOf("--append-system-prompt") + 1], "ROLE_BODY", "注入内容不变成路径");
});

test("M12-14: deliveryMode 下既有 runtimeEnv 条目不被新 flag 挤掉", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do", deliveryMode: true });
  const env = captures[0].opts.env;
  assert.equal(env[MANAGED], "1", "新隔离 flag 在");
  assert.equal(env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, "1", "既有 builtin-agents 条目保留");
  assert.equal(env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS, "1", "deliveryMode 条目保留");
});

test("M12-14: env 变更不进 argv —— native 路径 argv 逐字节符合既有形态（2026-09-19 Owner 裁定后追加纯净模式双旗标）", async () => {
  // M12-14 原不变式"隔离纯 env 注入、argv 零变化"被 2026-09-19 Owner 裁定演进的
  // 纯净模式取代：--bare + --strict-mcp-config 进 argv（claude-code 无对应 env 开关），
  // env 侧隔离（auto-memory/git-instructions）保留不变。本钉更新为裁定后的精确形状。
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
  assert.deepEqual(captures[0].args, [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--exclude-dynamic-system-prompt-sections",
    "--no-session-persistence",
    "--strict-mcp-config",
  ], "native 路径 argv（2026-10-05 修订）：bare 与 OAuth 互斥（CLI 官方语义〔OAuth and keychain are never read〕），纯净改由 CLAUDE_CONFIG_DIR 隔离目录承载（env 钉见下），strict-mcp 保留");
});

test("M12-14: 不泄漏敏感值 —— flag 是常量 '1'，凭据值只出现在其声明 env 名下", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  // claude-code 继承的凭据名只有长期令牌名（envPolicy）——别的名字进不了子进程 env。
  await spawnAndCapture(backend, nativeAgent(), {
    prompt: "do",
    resolvedCredentials: { CLAUDE_CODE_OAUTH_TOKEN: "m1214-dummy-value" },
  });
  const env = captures[0].opts.env;
  assert.equal(env[MANAGED], "1", "flag 值是常量，不派生自任何凭据");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "m1214-dummy-value", "凭据值在其声明 env 名下");
  const leaked = Object.entries(env).filter(([name, value]) => name !== "CLAUDE_CODE_OAUTH_TOKEN" && value === "m1214-dummy-value");
  assert.deepEqual(leaked, [], "凭据值不复制到任何其他 env 名");
});

// ── 4. Claude-only：其它 runtime 不接收该变量 ──────────────────────────

test("M12-14: codex 子进程 env 不含 CLAUDE_CODE_DISABLE_AUTO_MEMORY", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new CodexBackend({ spawnFn });
  await spawnAndCapture(backend, { id: "c", backend: "codex", binary: "fake-codex", cwd: process.cwd() }, { prompt: "do" });
  assert.equal(envEntriesCaseInsensitive(captures[0].opts.env, MANAGED).length, 0, "codex 不接收 claude-only 变量");
});

test("M12-14: zcode 子进程 env 不含 CLAUDE_CODE_DISABLE_AUTO_MEMORY", async () => {
  // spawnFn 在握手前被调用——env 组装事实此刻已定格；假子进程随即 close，
  // 握手按 transport-closed 拒绝（预期拒绝，不影响已捕获的 env 断言）。
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ZcodeBackend({ spawnFn });
  const agent = {
    id: "z",
    backend: "zcode",
    binary: "C:/fake/zcode.cjs",
    cwd: process.cwd(),
    model: { id: "bigmodel-api/GLM-5.3" },
  };
  await assert.rejects(() => backend.spawn(agent, { prompt: "do" }));
  assert.equal(captures.length, 1, "恰好一次 spawn");
  assert.equal(envEntriesCaseInsensitive(captures[0].opts.env, MANAGED).length, 0, "zcode 不接收 claude-only 变量");
});

// ── 2026-10-05（auditor_claude 席位批）：native OAuth 通道的隔离目录机制钉 ────
test("2026-10-05: native 通道 spawn → env 带 CLAUDE_CONFIG_DIR 指向仅含凭据拷贝的隔离目录；argv 无 bare", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
  const [capture] = captures;
  assert.ok(!capture.args.includes("--bare"), "native 通道不再带 bare（OAuth 互斥）");
  assert.ok(capture.args.includes("--strict-mcp-config"), "strict-mcp 保留");
  const dir = capture.opts.env.CLAUDE_CONFIG_DIR;
  assert.ok(typeof dir === "string" && dir.length > 0, "env 注入隔离目录路径");
  const { existsSync, readFileSync } = await import("node:fs");
  assert.ok(existsSync(join(dir, ".credentials.json")), "凭据从注入 fixture 拷贝（不触真实 HOME）");
  const src = JSON.parse(readFileSync(credentialsSource, "utf8"));
  const copy = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
  assert.deepEqual(copy, src, "副本内容与注入 fixture 一致（不触真实 HOME）");
});

test("2026-10-05: agent.env 反设 CLAUDE_CONFIG_DIR 被剥离（任意大小写），backend 预备值是唯一权威", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = makeClaudeBackend({ spawnFn });
  const agent = { ...nativeAgent(), env: { "claude_config_dir": "C:/evil/override" } };
  await spawnAndCapture(backend, agent, { prompt: "do" });
  const env = captures[0].opts.env;
  assert.notEqual(env["claude_config_dir"], "C:/evil/override", "小写反设被剥");
  assert.ok(env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== "C:/evil/override", "权威值来自 backend 预备");
});
