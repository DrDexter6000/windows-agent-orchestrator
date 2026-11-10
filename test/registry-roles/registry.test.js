import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readRegistry, normalizeAgent, unknownBackendGuidance, KNOWN_BACKENDS } from "../../src/registry.js";

test("reads agent registry and applies cwd override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        glm_worker: {
          backend: "deepseek-acp",
          credentialEnv: "DSH_API_KEY",
          cwd: "D:/projects/app-worktree",
          model: { providerID: "deepseek", id: "glm-5.1" },
        },
      },
    }),
  );

  const registry = await readRegistry(registryPath);
  const agent = registry.getAgent("glm_worker", { cwd: "D:/projects/override" });

  assert.equal(agent.id, "glm_worker");
  assert.equal(agent.backend, "deepseek-acp");
  assert.equal(agent.cwd, "D:/projects/override");
  assert.deepEqual(agent.model, { providerID: "deepseek", id: "glm-5.1" });
});

test("ignores undefined override values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        glm_worker: {
          backend: "deepseek-acp",
          credentialEnv: "DSH_API_KEY",
          cwd: "D:/projects/app-worktree",
          model: { providerID: "deepseek", id: "glm-5.1" },
        },
      },
    }),
  );

  const registry = await readRegistry(registryPath);
  const agent = registry.getAgent("glm_worker", { cwd: undefined });

  assert.equal(agent.cwd, "D:/projects/app-worktree");
});

test("rejects unknown agents with a clear error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(registryPath, JSON.stringify({ agents: {} }));

  const registry = await readRegistry(registryPath);

  assert.throws(() => registry.getAgent("missing"), /Unknown agent: missing/);
});

test("claude-code backend 不要求 serveUrl/model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        claude_worker: { backend: "claude-code", cwd: "D:/proj" },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  const agent = registry.getAgent("claude_worker");
  assert.equal(agent.backend, "claude-code");
  assert.equal(agent.cwd, "D:/proj");
});

test("codex backend 不要求 serveUrl/model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        codex_worker: { backend: "codex", cwd: "D:/proj" },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  const agent = registry.getAgent("codex_worker");
  assert.equal(agent.backend, "codex");
});

test("未知 backend 被拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        bad: { backend: "unknown-runtime", cwd: "D:/proj" },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  assert.throws(() => registry.getAgent("bad"), /unknown backend/);
});

test("混合 registry: kimi-web + claude-code + codex 共存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        kw: {
          backend: "kimi-web",
          serveUrl: "http://127.0.0.1:4297",
          tokenEnv: "KIMI_WEB_TOKEN",
          cwd: "D:/a",
          model: { id: "m" },
        },
        claude: { backend: "claude-code", cwd: "D:/b" },
        codex: { backend: "codex", cwd: "D:/c" },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  const agents = registry.listAgents();
  assert.equal(agents.length, 3);
  const ids = agents.map((a) => a.id).sort();
  assert.deepEqual(ids, ["claude", "codex", "kw"]);
});

// ===== 决定 0106：provider 块统一拒绝 =====
// provider 通道（claude-code 驱动非 Anthropic 模型）已退役：normalizeModelPolicy
// 对任何 backend 的非 null provider 块抛固定文案。历史（P4 融合项 #3 的一等字段
// 解析、R23-C 的 anthropic-compatible 形状校验）见 archive/claude-code-provider-channel。

test("D0106: 任何 backend 的 provider 块 → 固定文案拒绝（决定 0106）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        coder: {
          backend: "claude-code",
          cwd: "D:/proj",
          model: { id: "glm-5.2" },
          reasoning: { effort: "high" },
          provider: {
            protocol: "anthropic-compatible",
            baseUrl: "https://open.bigmodel.cn/api/anthropic",
            apiKeyEnv: "ZHIPU_API_KEY",
          },
        },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  assert.throws(
    () => registry.getAgent("coder"),
    /Agent coder: provider is no longer supported \(decision 0106\) — remove the provider block/,
    "well-formed anthropic-compatible provider block is rejected with the fixed message",
  );
});

test("D0106: 半块/旧形状 provider 同样拒绝（不再做形状校验分流）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        half: {
          backend: "claude-code",
          cwd: "D:/proj",
          provider: { baseUrl: "https://x" },
        },
        old_shape: {
          backend: "codex",
          cwd: "D:/proj",
          provider: { protocol: "anthropic-compatible", baseUrl: "https://x", apiKeyEnv: "KEY", model: "m" },
        },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  assert.throws(
    () => registry.getAgent("half"),
    /provider is no longer supported \(decision 0106\)/,
    "half provider block rejected with the same fixed message",
  );
  assert.throws(
    () => registry.getAgent("old_shape"),
    /provider is no longer supported \(decision 0106\)/,
    "old-shape provider on a non-claude backend rejected identically",
  );
});

test("D0106: 每个 backend 的任何非 null provider 值 → 同一固定文案", () => {
  // 各 backend 的最小合法底稿（registry 层必填项）；新增 backend 时在这里补一条。
  const bases = {
    "claude-code": {},
    codex: {},
    "deepseek-acp": { credentialEnv: "DEEPSEEK_API_KEY" },
    "kimi-web": { model: { id: "k" }, serveUrl: "http://127.0.0.1:1", tokenEnv: "KIMI_WEB_TOKEN" },
    zcode: { model: { id: "a/b" }, binary: "D:/zcode/zcode.cjs" },
  };
  for (const backend of KNOWN_BACKENDS) {
    const base = { backend, cwd: "D:/proj", ...bases[backend] };
    assert.doesNotThrow(() => normalizeAgent("w", base), `${backend}: 底稿本身合法`);
    for (const value of [false, 0, "", [], {}, "x"]) {
      assert.throws(
        () => normalizeAgent("w", { ...base, provider: value }),
        /Agent w: provider is no longer supported \(decision 0106\) — remove the provider block/,
        `${backend}: provider=${JSON.stringify(value)}`,
      );
    }
  }
});

test("D0106: provider 为 null/undefined → 照常解析（不受影响）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        explicit_null: {
          backend: "claude-code",
          cwd: "D:/proj",
          model: { id: "m" },
          provider: null,
        },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  const agent = registry.getAgent("explicit_null");
  assert.equal(agent.model.id, "m");
  assert.equal(agent.reasoning, undefined);
  assert.equal(agent.model.contextWindow, undefined);
});

test("P4-T2: managed --model in args → fixed migration error (no legacy extraction)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        coder: {
          backend: "claude-code",
          cwd: "D:/proj",
          // M11-9 CTO closeout: managed flags in args are a fixed migration error.
          binary: "node",
          prependArgs: ["wrapper.mjs", "--base-url", "https://x", "--"],
          args: ["--model", "m"],
        },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  // listAgents triggers normalization → throws on the managed flag.
  assert.throws(
    () => registry.getAgent("coder"),
    /migrate|no longer supported|structured/i,
    "managed --model in args is rejected (no transparent extraction)",
  );
});

// TD-318: readRegistry 遇坏 JSON 抛安全错误——V8 的 JSON.parse 报错自带源文本
// 片段（Unexpected token 'u', ...<原文>... is not valid JSON），原样上抛会让
// registry 原文进 CLI/MCP 输出。新错误只有固定文案 + 行列号（src/safeText.js），
// 不携带源文本。
test("readRegistry 遇坏 JSON 抛固定文案错误（不含源文本）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(registryPath, `{"TD318_LEAK_SENTINEL": undefined}`, "utf8");
  await assert.rejects(
    () => readRegistry(registryPath),
    (e) => {
      assert.ok(!e.message.includes("TD318_LEAK_SENTINEL"), "错误 message 不得含源文本哨兵");
      assert.match(e.message, /registry 文件不是合法的 JSON/, "固定文案 + 标签");
      return true;
    },
  );
});

// TD-318（二）：unknownBackendGuidance 经 registry list/check、wao lanes、派发与
// MCP 的错误路径原样带出——回显的 backend 值必须先过控制字符转义，值里的换行
// 不能在终端伪造一行。值本身保留（可见转义写法），便于排错。
test("TD-318（二）：unknownBackendGuidance 回显的 backend 值过控制字符转义", () => {
  const g = unknownBackendGuidance("evil\n[FAIL] forged");
  assert.ok(!g.includes("\n"), "结果不含真实换行（不能伪造一行）");
  assert.ok(g.includes("evil\\n[FAIL] forged"), "值以可见转义在场（排错仍可见）");
  assert.ok(g.includes("(supported: "), "支持集指路保持");
});

// TD-318 复核：条目自带的 id 字段曾按 { id, ...rest } 展开序盖掉已过
// isValidCanonicalAgentId 校验的键名——agents.good = { id: "evil\n[FAIL]" }
// 归一化后身份被冒用，registry list/check 按"id 已是合法键名、无需转义"
// 前提直接打印的文本行随之可被伪造。归一化结果的 id 恒为键名。
test("TD-318 复核: normalizeAgent——条目自带 id 字段不生效，id 恒为键名", () => {
  const a = normalizeAgent("good_key", { backend: "claude-code", cwd: "D:/proj", id: "someone_else" });
  assert.equal(a.id, "good_key", "合法条目：id 恒为键名");
  const forged = normalizeAgent("good_key", { backend: "claude-code", cwd: "D:/proj", id: "evil\n[FAIL] forged" });
  assert.equal(forged.id, "good_key", "带载荷的条目 id 同样不生效（不能冒用身份）");
});
