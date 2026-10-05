// test/m12-14-claudeContextIsolation.test.js
//
// M12-14 Package 2：worker 上下文隔离 —— claude-code 子进程强制关闭 provider
// auto-memory。
//
// 生产事故（RED）：一个 claude-code supervised worker 获得了 provider auto-memory
// 能力，在 WAO 检测到 workdir_escape 之前成功编辑了 WAO worktree 之外的全局 memory
// 文件。修复：ClaudeCodeBackend 把 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 注入【每一个】
// supervised 子进程 env（native OAuth / provider wrapper / start / resume 会话复用），
// 且 backend 安全值覆盖任何 agent.env 反设企图（Windows env 大小写不敏感，大小写
// 变体也算）。不动 RunManager、不加 runtime-name 分支、不加能力布尔。
//
// 捕获手段：ProcessBackend 的 spawnFn 注入缝（M11-7），直接读 spawn 收到的真实
// child env / argv，不起真实进程、不调模型。

import { join } from "node:path";
import { homedir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ClaudeCodeBackend } from "../../src/backends/claudeCode.js";
import { CodexBackend } from "../../src/backends/codex.js";
import { KimiCodeBackend } from "../../src/backends/kimiCode.js";

const MANAGED = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

// 捕获 spawnFn：记录 (binary, argv, opts)，返回一个立即 'spawn' → 'close'(0) 的
// 假子进程，让 backend 完整跑完 env 组装与 argv 编译，无需真实子进程或模型。
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
  // 故意不设 binary：真实 provider agent 也不设——ClaudeCodeBackend.resolveBinary
  // 检测到 provider 后直接返回 { binary: node, prependArgs: wrapper }，确定性、
  // 不探测真实 PATH。设了 binary 会短路 provider 推导，测不到 wrapper 路径。
  return {
    id: "w",
    backend: "claude-code",
    cwd: process.cwd(),
    model: { id: "glm-5.2" },
    provider: {
      protocol: "anthropic-compatible",
      baseUrl: "https://provider.example/api/anthropic",
      apiKeyEnv: "M1214_PROVIDER_KEY",
    },
    ...extra,
  };
}

// env 对象里按 Windows 语义（大小写不敏感）找指定名字的条目。
function envEntriesCaseInsensitive(env, name) {
  const upper = name.toUpperCase();
  return Object.entries(env ?? {}).filter(([k]) => k.toUpperCase() === upper);
}

// ── 1. 每一条 spawn 路径都强制注入 ─────────────────────────────────────

test("M12-14: native OAuth 路径（无 provider）子进程 env 含 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
  assert.equal(captures.length, 1, "恰好一次 spawn");
  assert.equal(captures[0].opts.env[MANAGED], "1", "native 直连子进程必须关闭 auto-memory");
});

test("M12-14: provider wrapper 路径子进程 env 含 flag，且 wrapper argv/凭据通道不变", async () => {
  const prev = process.env.M1214_PROVIDER_KEY;
  process.env.M1214_PROVIDER_KEY = "m1214-dummy-credential";
  try {
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn });
    await spawnAndCapture(backend, providerAgent(), { prompt: "do" });
    const cap = captures[0];
    assert.equal(cap.opts.env[MANAGED], "1", "provider wrapper 子进程必须关闭 auto-memory");
    // provider 路径证据：binary = node，argv 以 wrapper 脚本开头
    assert.equal(cap.binary, process.execPath, "provider 路径走 node 调 wrapper");
    assert.ok(cap.args.some((a) => a.includes("claude-code-provider-wrapper")), "argv 含 wrapper 脚本");
    assert.ok(cap.args.includes("--base-url"), "wrapper 参数不变（--base-url）");
    // 凭据通道保留：声明的 apiKeyEnv 注入子进程（值不泄漏进本 flag）
    assert.equal(cap.opts.env.M1214_PROVIDER_KEY, "m1214-dummy-credential", "provider 凭据 env 仍然注入");
  } finally {
    if (prev === undefined) delete process.env.M1214_PROVIDER_KEY;
    else process.env.M1214_PROVIDER_KEY = prev;
  }
});

test("M12-14: 会话复用 first turn（--session-id）子进程 env 含 flag，argv 复用语义不变", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn });
  const uuid = "11111111-2222-4333-8444-555555555555";
  await spawnAndCapture(backend, nativeAgent(), {
    prompt: "do",
    sessionReuse: { turn: "first", opaqueUuid: uuid },
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
  const backend = new ClaudeCodeBackend({ spawnFn });
  const uuid = "11111111-2222-4333-8444-555555555555";
  await spawnAndCapture(backend, nativeAgent(), {
    prompt: "do",
    sessionReuse: { turn: "resume", opaqueUuid: uuid },
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
  const backend = new ClaudeCodeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
  const cap = captures[0];
  assert.equal(cap.opts.env[MANAGED], "1");
  assert.ok(cap.args.includes("--no-session-persistence"), "默认路径 argv 不变");
});

// ── 2. 覆盖抵抗：agent.env 无法重新打开 auto-memory ─────────────────────

test("M12-14: agent.env 精确名反设 '0' 被 backend 安全值覆盖", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent({ env: { [MANAGED]: "0" } }), { prompt: "do" });
  assert.equal(captures[0].opts.env[MANAGED], "1", "backend runtimeEnv 必须压过 agent.env");
});

test("M12-14: agent.env 大小写变体反设被剥离（Windows env 大小写不敏感）", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn });
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
  const backend = new ClaudeCodeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do", roleContract: "ROLE_BODY" });
  const cap = captures[0];
  assert.equal(cap.opts.env[MANAGED], "1");
  const occurrences = cap.args.filter((a) => a === "--append-system-prompt").length;
  assert.equal(occurrences, 1, "--append-system-prompt 恰好一次");
  assert.equal(cap.args[cap.args.indexOf("--append-system-prompt") + 1], "ROLE_BODY", "注入内容不变成路径");
});

test("M12-14: deliveryMode 下既有 runtimeEnv 条目不被新 flag 挤掉", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn });
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
  const backend = new ClaudeCodeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
  assert.deepEqual(captures[0].args, [
    "-p", "do",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--exclude-dynamic-system-prompt-sections",
    "--no-session-persistence",
    "--strict-mcp-config",
  ], "native 路径 argv（2026-10-05 修订）：bare 与 OAuth 互斥（CLI 官方语义〔OAuth and keychain are never read〕），纯净改由 CLAUDE_CONFIG_DIR 隔离目录承载（env 钉见下），strict-mcp 保留");
});

test("M12-14: 不泄漏敏感值 —— flag 是常量 '1'，凭据值只出现在其声明 env 名下", async () => {
  const prev = process.env.M1214_PROVIDER_KEY;
  process.env.M1214_PROVIDER_KEY = "m1214-sensitive-value";
  try {
    const { spawnFn, captures } = makeCapturingSpawn();
    const backend = new ClaudeCodeBackend({ spawnFn });
    await spawnAndCapture(backend, providerAgent(), { prompt: "do" });
    const env = captures[0].opts.env;
    assert.equal(env[MANAGED], "1", "flag 值是常量，不派生自任何凭据");
    const leaked = Object.entries(env).filter(([name, value]) => name !== "M1214_PROVIDER_KEY" && value === "m1214-sensitive-value");
    assert.deepEqual(leaked, [], "凭据值不复制到任何其他 env 名");
  } finally {
    if (prev === undefined) delete process.env.M1214_PROVIDER_KEY;
    else process.env.M1214_PROVIDER_KEY = prev;
  }
});

// ── 4. Claude-only：其它 runtime 不接收该变量 ──────────────────────────

test("M12-14: codex 子进程 env 不含 CLAUDE_CODE_DISABLE_AUTO_MEMORY", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new CodexBackend({ spawnFn });
  await spawnAndCapture(backend, { id: "c", backend: "codex", binary: "fake-codex", cwd: process.cwd() }, { prompt: "do" });
  assert.equal(envEntriesCaseInsensitive(captures[0].opts.env, MANAGED).length, 0, "codex 不接收 claude-only 变量");
});

test("M12-14: kimi-code 子进程 env 不含 CLAUDE_CODE_DISABLE_AUTO_MEMORY", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new KimiCodeBackend({ spawnFn });
  await spawnAndCapture(backend, { id: "k", backend: "kimi-code", binary: "fake-kimi", cwd: process.cwd() }, { prompt: "do" });
  assert.equal(envEntriesCaseInsensitive(captures[0].opts.env, MANAGED).length, 0, "kimi 不接收 claude-only 变量");
});

// ── 2026-10-05（auditor_claude 席位批）：native OAuth 通道的隔离目录机制钉 ────
test("2026-10-05: native 通道 spawn → env 带 CLAUDE_CONFIG_DIR 指向仅含凭据拷贝的隔离目录；argv 无 bare", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn });
  await spawnAndCapture(backend, nativeAgent(), { prompt: "do" });
  const [capture] = captures;
  assert.ok(!capture.args.includes("--bare"), "native 通道不再带 bare（OAuth 互斥）");
  assert.ok(capture.args.includes("--strict-mcp-config"), "strict-mcp 保留");
  const dir = capture.opts.env.CLAUDE_CONFIG_DIR;
  assert.ok(typeof dir === "string" && dir.length > 0, "env 注入隔离目录路径");
  const { existsSync, readFileSync } = await import("node:fs");
  assert.ok(existsSync(join(dir, ".credentials.json")) === existsSync(join(homedir(), ".claude", ".credentials.json")),
    "凭据文件在场性与源一致（源在场=拷贝在场；源缺席=空目录留给 CLI 如实报未登录）");
  if (existsSync(join(dir, ".credentials.json"))) {
    const src = JSON.parse(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"));
    const copy = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
    assert.deepEqual(Object.keys(copy), Object.keys(src), "拷贝结构同源（值不比对不展示）");
  }
});

test("2026-10-05: agent.env 反设 CLAUDE_CONFIG_DIR 被剥离（任意大小写），backend 预备值是唯一权威", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn });
  const agent = { ...nativeAgent(), env: { "claude_config_dir": "C:/evil/override" } };
  await spawnAndCapture(backend, agent, { prompt: "do" });
  const env = captures[0].opts.env;
  assert.notEqual(env["claude_config_dir"], "C:/evil/override", "小写反设被剥");
  assert.ok(env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== "C:/evil/override", "权威值来自 backend 预备");
});

test("2026-10-05: provider wrapper 通道字节不变 —— bare 恰好一次、无 CLAUDE_CONFIG_DIR 注入", async () => {
  const { spawnFn, captures } = makeCapturingSpawn();
  const backend = new ClaudeCodeBackend({ spawnFn });
  await spawnAndCapture(backend, providerAgent(), { prompt: "do" });
  assert.equal(captures[0].args.filter((a) => a === "--bare").length, 1, "wrapper 通道维持 bare（2026-09-19 原形态）");
  assert.ok(!captures[0].opts.env.CLAUDE_CONFIG_DIR, "wrapper 通道不注入隔离目录（凭据走 wrapper env）");
});
