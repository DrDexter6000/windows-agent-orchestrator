import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readRegistry } from "../src/registry.js";

test("reads agent registry and applies cwd override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        glm_worker: {
          backend: "opencode-serve",
          serveUrl: "http://127.0.0.1:4297",
          agent: "build",
          cwd: "D:/projects/app-worktree",
          model: { providerID: "zhipuai-coding-plan", id: "glm-5.1" },
        },
      },
    }),
  );

  const registry = await readRegistry(registryPath);
  const agent = registry.getAgent("glm_worker", { cwd: "D:/projects/override" });

  assert.equal(agent.id, "glm_worker");
  assert.equal(agent.backend, "opencode-serve");
  assert.equal(agent.cwd, "D:/projects/override");
  assert.deepEqual(agent.model, { providerID: "zhipuai-coding-plan", id: "glm-5.1" });
});

test("ignores undefined override values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        glm_worker: {
          backend: "opencode-serve",
          serveUrl: "http://127.0.0.1:4297",
          agent: "build",
          cwd: "D:/projects/app-worktree",
          model: { providerID: "zhipuai-coding-plan", id: "glm-5.1" },
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

test("混合 registry: opencode-serve + claude-code + codex 共存", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        glm: {
          backend: "opencode-serve",
          serveUrl: "http://127.0.0.1:4297",
          agent: "build",
          cwd: "D:/a",
          model: { providerID: "p", id: "m" },
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
  assert.deepEqual(ids, ["claude", "codex", "glm"]);
});

// ===== P4 融合项 #3（决策B 全量迁移）：provider 一等字段 =====
// 决策 0010：model/provider/effort/apiKeyEnv 提为一等字段，消除配置藏在 args/prependArgs
// 数组里导致的漂移（opus-4.8 类 bug 的温床——同一 model 出现在 wrapper prependArgs 和
// claude CLI args 两处）。normalizeAgent 认 provider:{baseUrl,apiKeyEnv,model,effort,contextWindow}。

test("P4-T2: claude-code agent 带 provider 一等字段被正确解析", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        coder: {
          backend: "claude-code",
          cwd: "D:/proj",
          provider: {
            baseUrl: "https://open.bigmodel.cn/api/anthropic",
            apiKeyEnv: "ZHIPU_API_KEY",
            model: "glm-5.2",
            effort: "high",
            contextWindow: 1000000,
          },
        },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  const agent = registry.getAgent("coder");
  assert.equal(agent.backend, "claude-code");
  assert.deepEqual(agent.provider, {
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    apiKeyEnv: "ZHIPU_API_KEY",
    model: "glm-5.2",
    effort: "high",
    contextWindow: 1000000,
  });
});

test("P4-T2: provider 部分字段可选（只 baseUrl+apiKeyEnv+model 也能解析）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        coder: {
          backend: "claude-code",
          cwd: "D:/proj",
          provider: { baseUrl: "https://x", apiKeyEnv: "KEY", model: "m" },
        },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  const agent = registry.getAgent("coder");
  assert.equal(agent.provider.effort, undefined);
  assert.equal(agent.provider.contextWindow, undefined);
});

test("P4-T2: claude-code 无 provider 仍可解析（向后兼容旧 args/prependArgs 形态）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-registry-"));
  const registryPath = join(dir, "agents.json");
  await writeFile(
    registryPath,
    JSON.stringify({
      agents: {
        coder: {
          backend: "claude-code",
          cwd: "D:/proj",
          // 旧形态：手拼 prependArgs + args
          binary: "node",
          prependArgs: ["wrapper.mjs", "--base-url", "https://x", "--"],
          args: ["--model", "m"],
        },
      },
    }),
  );
  const registry = await readRegistry(registryPath);
  const agent = registry.getAgent("coder");
  assert.equal(agent.provider, undefined, "无 provider 字段 = 旧形态，不报错");
  assert.equal(agent.args[1], "m");
});
