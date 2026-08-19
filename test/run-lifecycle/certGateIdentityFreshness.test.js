// test/run-lifecycle/certGateIdentityFreshness.test.js
//
// TD-131 / TD-132（2026-08-19，lane 架构前置批次 0，登记+收口同轮）：
// P1-1 认证门（CLI 显式 --require-certified → RunManager.start
// requireCertified:true）的两个存量洞的证伪测试：
//
//   T1 身份：门必须比对 summary 记录身份与当前 registry 配置
//      （matchedCertRecord SSOT——backend/modelId 记录侧声明即比对，
//      providerID 双侧声明时同比对）。不匹配 → 按未认证拒绝，reason 是
//      新固定文案（不回显 summary/registry 的值）。旧代码不比对身份，
//      本组测试在旧代码上假绿（refuse 断言红）。
//   T2 反洗白：新鲜度按 per-worker lastHealthyRunAt 判。全局 generatedAt
//      新鲜（任一 worker 刚重考）不得洗白其他 worker 的陈旧/缺失认证。
//      旧代码读全局 generatedAt，本组在旧代码上假绿。
//   T3 兼容与旁路：身份匹配 + lastHealthyRunAt 新鲜 → 过；
//      manualOverride:"cleared" 照常放行（Owner 背书先于身份/status/
//      新鲜度——行为不变）。
//   T4 providerID 维度：显示层投影（getRegistryInventory）与门共用同一
//      matchedCertRecord SSOT——record.providerID ≠ agent.model.providerID
//      → 投影 null；agent 侧缺该字段（claude-code 形状）→ 此维度跳过，
//      仍由 backend+modelId 把关。
//
// 夹具纪律：进程内 RunManager + 假 backend（门在 backend.spawn 之前拒绝/
// 放行，不依赖真实 provider）；registry 走真实 readRegistry（normalizeAgent
// 形状与生产一致）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunManager, matchedCertRecord } from "../../src/runManager.js";
import { readRegistry } from "../../src/registry.js";
import { getRegistryInventory } from "../../src/application/registryInventory.js";

// ===== Helpers =====

const NOW_ISO = () => new Date().toISOString();
const DAYS_AGO_ISO = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

function makeDir() {
  return mkdtempSync(join(tmpdir(), "wao-certgate-"));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeSummary(runDir, workers, generatedAt = NOW_ISO()) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
    version: 1,
    generatedAt,
    counts: {},
    allCertified: false,
    workers,
  }), "utf8");
  return runDir;
}

// 假 backend：这些测试只关心 spawn 之前的认证门。agent 带 model 时 start
// 要求 backend 实现 validateAgentPolicy（M11-9 fail-closed），故提供空实现。
function makeFakeBackend() {
  return {
    sessionOutlivesProcess: false,
    validateAgentPolicy() {},
    async spawn(agent) {
      return {
        backend: agent.backend,
        backendSessionId: "sess-fake",
        async *events() { yield { kind: "done", reason: "completed" }; },
        abort: async () => {},
      };
    },
    defaultBinary() { return "fake-binary"; },
    credentialEnvNames: () => [],
  };
}

function makeGateManager({ registryPath, runDir }) {
  return new RunManager({
    config: { registry: registryPath, runDir, defaultIsolation: "none" },
    readRegistry: async () => readRegistry(registryPath),
    transcriptDir: runDir,
    backendFor: () => makeFakeBackend(),
    userEnvReader: async () => ({}),
  });
}

// ===== T1 身份比对 =====

test("T1a 身份：summary 记录 backend ≠ registry 配置 → 拒绝（固定文案，不回显配置值）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      gate_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      // 认证时是 opencode-serve；registry 已改成 claude-code，未重跑 reliability。
      gate_w: { agentId: "gate_w", backend: "opencode-serve", modelId: "glm-5.2", status: "certified", lastHealthyRunAt: NOW_ISO() },
    });
    const manager = makeGateManager({ registryPath, runDir });
    await assert.rejects(
      manager.start("gate_w", { prompt: "x", requireCertified: true }),
      (err) => {
        assert.match(err.message, /Refused dispatch/, "认证门拒绝");
        assert.match(err.message, /认证身份不匹配/, "reason 是新的固定文案");
        // fixed-safe：不回显 summary/registry 的身份值（磁盘数据可能被改）
        assert.ok(!err.message.includes("opencode-serve"), "不得回显记录的 backend 值");
        assert.ok(!err.message.includes("claude-code"), "不得回显 registry 的 backend 值");
        return true;
      },
      "旧组合的认证不得放行（TD-131）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("T1b 身份：summary 记录 modelId ≠ registry model.id → 同样拒绝（固定文案）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      gate_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      gate_w: { agentId: "gate_w", backend: "claude-code", modelId: "glm-5.3[1m]", status: "certified", lastHealthyRunAt: NOW_ISO() },
    });
    const manager = makeGateManager({ registryPath, runDir });
    await assert.rejects(
      manager.start("gate_w", { prompt: "x", requireCertified: true }),
      (err) => {
        assert.match(err.message, /认证身份不匹配/, "modelId 不匹配走同一固定文案");
        assert.ok(!err.message.includes("glm-5.2") && !err.message.includes("glm-5.3"), "不得回显 modelId 值");
        return true;
      },
      "换 model 未重认证不得放行（TD-131）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("T1c 身份：记录缺 backend/modelId（legacy summary）→ 维度跳过，不误拒", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      legacy_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
    });
    // 旧格式 summary：只有 status + lastHealthyRunAt，无身份字段。
    const runDir = makeSummary(join(dir, "runs"), {
      legacy_w: { agentId: "legacy_w", status: "certified", lastHealthyRunAt: NOW_ISO() },
    });
    const manager = makeGateManager({ registryPath, runDir });
    const run = await manager.start("legacy_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "legacy 记录（缺身份字段）由 backend+modelId 缺省容忍，照常放行");
  } finally {
    cleanupDir(dir);
  }
});

// ===== T2 反洗白（per-worker 新鲜度）=====

test("T2 反洗白：全局 generatedAt 新鲜不洗白其他 worker 的陈旧/缺失认证", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      fresh_w: { backend: "claude-code", cwd: dir },
      missing_w: { backend: "claude-code", cwd: dir },
      stale_w: { backend: "claude-code", cwd: dir },
    });
    // generatedAt 全局新鲜 = 刚重考过 fresh_w（merge 保留其余 worker 旧条目）。
    const runDir = makeSummary(join(dir, "runs"), {
      fresh_w: { agentId: "fresh_w", status: "certified", lastHealthyRunAt: NOW_ISO() },
      missing_w: { agentId: "missing_w", status: "certified", lastHealthyRunAt: null },
      stale_w: { agentId: "stale_w", status: "certified", lastHealthyRunAt: DAYS_AGO_ISO(40) },
    }, NOW_ISO());
    const manager = makeGateManager({ registryPath, runDir });

    // A（fresh_w）：lastHealthyRunAt 新 → 过。
    const run = await manager.start("fresh_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "fresh_w 应放行");

    // B1（missing_w）：lastHealthyRunAt 缺失（null）→ fail-closed 拒。
    await assert.rejects(
      manager.start("missing_w", { prompt: "x", requireCertified: true }),
      /无新鲜认证/,
      "null lastHealthyRunAt 不得被全局 generatedAt 洗白（TD-132）",
    );

    // B2（stale_w）：lastHealthyRunAt 陈旧（40d > 默认 30d）→ 拒。
    await assert.rejects(
      manager.start("stale_w", { prompt: "x", requireCertified: true }),
      /认证已过期/,
      "陈旧 lastHealthyRunAt 不得被全局 generatedAt 洗白（TD-132）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("T2b 反洗白：lastHealthyRunAt 非字符串/不可解析 → fail-closed 拒（固定 reason）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      garbage_w: { backend: "claude-code", cwd: dir },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      // 不可解析的时间戳 + 注入载荷形状——不得回显、不得放行。
      garbage_w: { agentId: "garbage_w", status: "certified", lastHealthyRunAt: "not a date <script>alert(1)</script>" },
    }, NOW_ISO());
    const manager = makeGateManager({ registryPath, runDir });
    await assert.rejects(
      manager.start("garbage_w", { prompt: "x", requireCertified: true }),
      (err) => {
        assert.match(err.message, /无新鲜认证/, "不可解析按未认证处理");
        assert.ok(!err.message.includes("<script>"), "不得回显磁盘上的原始值");
        return true;
      },
      "不可解析的 lastHealthyRunAt fail-closed（TD-132）",
    );
  } finally {
    cleanupDir(dir);
  }
});

// ===== T3 兼容与旁路 =====

test("T3a 兼容：身份匹配 + lastHealthyRunAt 新鲜 → 放行", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      ok_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      ok_w: { agentId: "ok_w", backend: "claude-code", modelId: "glm-5.2", status: "certified", lastHealthyRunAt: NOW_ISO() },
    });
    const manager = makeGateManager({ registryPath, runDir });
    const run = await manager.start("ok_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "身份匹配 + 新鲜认证放行");
  } finally {
    cleanupDir(dir);
  }
});

test("T3b 旁路：manualOverride=cleared + 身份不匹配 + 无新鲜度 → 照常放行（语义不变）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      cleared_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      // 最恶劣组合：身份不匹配 + lastHealthyRunAt 缺失，但 owner 手动背书。
      cleared_w: { agentId: "cleared_w", backend: "opencode-serve", modelId: "other-model", status: "rejected", manualOverride: "cleared" },
    });
    const manager = makeGateManager({ registryPath, runDir });
    const run = await manager.start("cleared_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "cleared 背书先于身份/status/新鲜度——行为不变");
  } finally {
    cleanupDir(dir);
  }
});

// ===== T4 providerID 维度（显示层投影 + 门共用同一 SSOT）=====

test("T4a 投影：record.providerID ≠ agent.model.providerID → certification 投影 null", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      t4_w: { backend: "claude-code", cwd: dir, model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" } },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      // backend/modelId 都匹配，唯独 providerID 是另一个 provider 的。
      t4_w: { agentId: "t4_w", backend: "claude-code", modelId: "glm-5.2", providerID: "deepseek", status: "certified", lastHealthyRunAt: NOW_ISO() },
    });
    const inventory = await getRegistryInventory({ registryPath, runDir });
    assert.equal(inventory.length, 1);
    assert.equal(inventory[0].certification, null, "providerID 不匹配 → 认证不可继承（投影 null）");
  } finally {
    cleanupDir(dir);
  }
});

test("T4b 投影：agent 侧缺 model.providerID（claude-code 形状）→ 维度跳过，backend+modelId 把关", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      nopid_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      // 记录侧有 providerID、agent 侧没有 → 该维度不比对，backend+modelId 匹配即继承。
      nopid_w: { agentId: "nopid_w", backend: "claude-code", modelId: "glm-5.2", providerID: "deepseek", status: "certified", lastHealthyRunAt: NOW_ISO() },
    });
    const inventory = await getRegistryInventory({ registryPath, runDir });
    assert.equal(inventory[0].certification, "certified", "agent 侧缺字段时 providerID 维度跳过");
  } finally {
    cleanupDir(dir);
  }
});

test("T4c 门：providerID 不匹配同样拒绝派发（门与投影共用 matchedCertRecord SSOT）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      t4c_w: { backend: "claude-code", cwd: dir, model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" } },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      t4c_w: { agentId: "t4c_w", backend: "claude-code", modelId: "glm-5.2", providerID: "deepseek", status: "certified", lastHealthyRunAt: NOW_ISO() },
    });
    const manager = makeGateManager({ registryPath, runDir });
    await assert.rejects(
      manager.start("t4c_w", { prompt: "x", requireCertified: true }),
      /认证身份不匹配/,
      "门的身份比对含 providerID 维度（同一 SSOT，非显示层专属）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("T4d SSOT 纯函数：双侧声明才比 providerID；agent 侧 model 缺省 null 归一", () => {
  const record = { backend: "b", modelId: "m", providerID: "p" };
  // agent 侧无 providerID → 维度跳过，匹配（返回原记录引用）。
  assert.equal(matchedCertRecord({ backend: "b", model: { id: "m" } }, record), record,
    "agent 侧缺 providerID → 跳过该维度");
  // 双侧声明且不一致 → null。
  assert.equal(matchedCertRecord({ backend: "b", model: { id: "m", providerID: "q" } }, record), null,
    "双侧声明且不一致 → 不匹配");
  // 记录侧 providerID 缺省（旧 summary）→ 跳过该维度。
  const legacyRecord = { backend: "b", modelId: "m" };
  assert.equal(matchedCertRecord({ backend: "b", model: { id: "m", providerID: "p" } }, legacyRecord), legacyRecord,
    "记录侧缺 providerID → 跳过该维度");
  const nullModelRecord = { backend: "b", modelId: null };
  assert.equal(matchedCertRecord({ backend: "b" }, nullModelRecord), nullModelRecord,
    "agent 无 model（null）与记录 modelId:null 归一相等，不误拒");
  assert.equal(matchedCertRecord({ backend: "b" }, { backend: "b", modelId: "m" }), null,
    "agent 无 model 但记录声明 modelId → 不匹配");
});
