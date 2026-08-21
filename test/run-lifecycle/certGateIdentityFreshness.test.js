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
// R23-C（2026-08-21，ADR-0026 v2 方向）追加组：
//   T5 providerKey 归一化契约：src/providerFingerprint.js 单一实现的规则
//      （scheme/host 小写、去默认端口、路径保留大小写去尾斜杠、丢弃
//      userinfo/query/fragment、非 http(s)/缺字段/含 "|" → null）。
//   T6 跨调用点逐字节一致：matrix.normalizeCase（buildCertificationMatrix）
//      与直连 providerKeyFor 对同一 provider 块产出逐字节相同；monolith
//      scripts/run-reliability.mjs 以源级钉断言接线（同 SSOT import +
//      agentInfo/caseResult 两处派生）。
//   T7 门矩阵·providerKey 维：matchedCertRecord 三态（undefined=legacy 跳过、
//      null=已观察无接入方、字符串逐字节）+ 端到端换接入方拒绝。
//   T8 门矩阵·lastFullHealthyRunAt 新鲜度：legacy 缺字段回落 lastHealthyRunAt；
//      显式 null/陈旧/不可解析 fail-closed（delta 全绿不洗白全量口径）；
//      §3 scope 派生收窄（profile:"delta" 不再短路）+ summarizeWorkers 只让
//      full 全绿刷新该字段。
//   T9 certMigrationAdvisories（§5）：legacy 记录出 advisory，三态不误报。
//
// R23-C 集成吸收轮（2026-08-21，双席会审裁定 Ox 基线 + 吸收 coder_hq 上一轮
// 交付）追加组——U 前缀避让基线 T5–T9 标签：
//   U6d 门·端到端：同接入方不同写法（大小写/默认端口/尾斜杠）的记录指纹
//      归一化等价 → 放行（不误拒）。
//   U7 门新鲜度六态 e2e：全量新鲜/只有 delta 绿（null）/legacy 回退/回退源
//      亦缺/过期/manualOverride cleared 例外。
//   U9 certifyCase 证伪：delta 行显式 drills 超子集 + 全绿 → certified
//      （不再被 delta 标签误降档；恰为子集仍 conditional）。
//   U11 §4 续跑漂移 e2e（continueRun 真 worktree）：父 run.started.providerKey
//      ≠ 当前 registry 指纹 → worker_configuration_changed；同指纹/legacy 父
//      放行；父显式 null（原生直连）+ registry 现配 provider 块 → 必拒
//      （auditor F2 正反钉：无条件键不让"原生直连→新接入方"最高危迁移漏网）。
//
// 夹具纪律：进程内 RunManager + 假 backend（门在 backend.spawn 之前拒绝/
// 放行，不依赖真实 provider）；registry 走真实 readRegistry（normalizeAgent
// 形状与生产一致）。带 provider 块的 agent 需在 userEnvReader 注入 apiKeyEnv
// 对应变量（M11-7 凭据预检在认证门之前，缺 env 会被先拒）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunManager, matchedCertRecord } from "../../src/runManager.js";
import { readRegistry, certMigrationAdvisories } from "../../src/registry.js";
import { getRegistryInventory } from "../../src/application/registryInventory.js";
import { providerKeyFor } from "../../src/providerFingerprint.js";
import { buildCertificationMatrix } from "../../scripts/reliability/matrix.mjs";
import { certificationScopeForCase, summarizeCertification, certifyCase } from "../../scripts/reliability/certification.mjs";
import { continueRun } from "../../src/application/runContinue.js";
import { JsonlTranscript } from "../../src/transcript.js";

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

function makeGateManager({ registryPath, runDir, env = {} }) {
  return new RunManager({
    config: { registry: registryPath, runDir, defaultIsolation: "none" },
    readRegistry: async () => readRegistry(registryPath),
    transcriptDir: runDir,
    backendFor: () => makeFakeBackend(),
    // userEnvReader 契约是按名查询：(name) => Promise<string|undefined>。
    userEnvReader: async (name) => env[name],
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

// ===== R23-C（2026-08-21）：以下为 lane 认证身份维度补全新增组 =====

// ===== T5 providerKey 归一化契约（单一实现 src/providerFingerprint.js）=====

test("T5a 归一化规则：scheme/host 小写、去默认端口、路径保大小写去尾斜杠", () => {
  assert.equal(
    providerKeyFor({ protocol: "anthropic-compatible", baseUrl: "HTTPS://Api.Example.COM:443/v1/", apiKeyEnv: "K" }),
    "https://api.example.com/v1|K",
    "scheme/host 小写 + 去 :443 + 尾斜杠剥离",
  );
  assert.equal(
    providerKeyFor({ baseUrl: "http://localhost:80/api/", apiKeyEnv: "K" }),
    "http://localhost/api|K",
    "http 默认端口 :80 同样剥离",
  );
  assert.equal(
    providerKeyFor({ baseUrl: "https://api.example.com:8443/v1", apiKeyEnv: "K" }),
    "https://api.example.com:8443/v1|K",
    "非默认端口原样保留",
  );
  assert.equal(
    providerKeyFor({ baseUrl: "https://api.example.com/V1/Endpoint", apiKeyEnv: "K" }),
    "https://api.example.com/V1/Endpoint|K",
    "路径大小写保留（仅尾斜杠归一）",
  );
});

test("T5b 凭据卫生：userinfo/query/fragment 一律丢弃；apiKeyEnv 只取变量名", () => {
  assert.equal(
    providerKeyFor({ baseUrl: "https://user:pass@api.example.com/v1", apiKeyEnv: "K" }),
    "https://api.example.com/v1|K",
    "userinfo（含内嵌凭据）绝不落盘",
  );
  assert.equal(
    providerKeyFor({ baseUrl: "https://api.example.com/v1?token=secret#frag", apiKeyEnv: "K" }),
    "https://api.example.com/v1|K",
    "query/fragment 绝不落盘",
  );
});

test("T5c null 判定与单射防御：无块/缺字段/空白/非 http(s)/解析失败/含分隔符 → null", () => {
  assert.equal(providerKeyFor(undefined), null, "无 provider 块 → null（已观察无接入方）");
  assert.equal(providerKeyFor(null), null);
  assert.equal(providerKeyFor({}), null);
  assert.equal(providerKeyFor({ baseUrl: "", apiKeyEnv: "K" }), null, "空 baseUrl → null");
  assert.equal(providerKeyFor({ baseUrl: "   ", apiKeyEnv: "K" }), null, "空白 baseUrl → null");
  assert.equal(providerKeyFor({ baseUrl: "https://api.example.com", apiKeyEnv: "" }), null, "空 apiKeyEnv → null");
  assert.equal(
    providerKeyFor({ baseUrl: "  https://api.example.com  ", apiKeyEnv: "K" }),
    "https://api.example.com|K",
    "baseUrl 首尾空白 trim 后可派生",
  );
  assert.equal(providerKeyFor({ baseUrl: "ftp://api.example.com", apiKeyEnv: "K" }), null, "非 http(s) scheme → null");
  assert.equal(providerKeyFor({ baseUrl: "not a url", apiKeyEnv: "K" }), null, "解析失败 → null");
  assert.equal(providerKeyFor({ baseUrl: "https://api.example.com/v1|x", apiKeyEnv: "K" }), null,
    "baseUrl 含 \"|\" → null（分隔符注入防御，保证编码单射）");
  assert.equal(providerKeyFor({ baseUrl: "https://api.example.com/v1", apiKeyEnv: "K|EVIL" }), null,
    "apiKeyEnv 含 \"|\" → null");
});

// ===== T6 跨调用点逐字节一致（写入侧两处 + 比对侧同源）=====

test("T6 契约：matrix.normalizeCase ≡ 直连 providerKeyFor；monolith run-reliability.mjs 源级钉接线", () => {
  const PROVIDER_BLOCK = {
    protocol: "anthropic-compatible",
    baseUrl: "HTTPS://Synthetic.Example.COM:443/v1/",
    apiKeyEnv: "SYNTHETIC_API_KEY",
  };
  const registryFixture = {
    agents: {
      fp_w: { backend: "claude-code", cwd: ".", model: { id: "glm-5.2" }, provider: PROVIDER_BLOCK },
      bare_w: { backend: "claude-code", cwd: "." },
    },
    certification: {
      matrix: [{ agentId: "fp_w", label: "fp" }, { agentId: "bare_w", label: "bare" }],
    },
  };
  const rows = buildCertificationMatrix({ registry: registryFixture });
  assert.equal(rows.length, 2);
  // 同一 provider 块经 matrix 行派生与直连单一实现产出逐字节相同（契约钉死）。
  assert.equal(rows[0].providerKey, providerKeyFor(PROVIDER_BLOCK), "两调用点零漂移");
  assert.equal(rows[0].providerKey, "https://synthetic.example.com/v1|SYNTHETIC_API_KEY",
    "归一化在行派生路径同样生效");
  // 无 provider 块的行 → 显式 null（已观察确认无接入方），不是 undefined。
  assert.equal(rows[1].providerKey, null);
  assert.ok("providerKey" in rows[1], "无条件写：键必须存在（undefined 仅留给 legacy 记录）");

  // scripts/run-reliability.mjs 是带副作用的 monolith 入口，测试进程不整体
  // import——以源级钉断言同一 SSOT 接线（import 来源 + 两处派生点）。
  const src = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "run-reliability.mjs"), "utf8");
  assert.match(src, /import \{ providerKeyFor \} from "\.\.\/src\/providerFingerprint\.js";/,
    "run-reliability.mjs 必须从 src 单一实现下向 import");
  assert.match(src, /providerKey: providerKeyFor\(agent\.provider\)/,
    "agentInfo() 从 registry agent.provider 派生（绝不读行值）");
  assert.match(src, /providerKey: tc\.providerKey \?\? info\.providerKey/,
    "caseResult 组装接线（matrix 行值优先，agentInfo 兜底）");
});

// ===== T7 门矩阵·providerKey 维（matchedCertRecord 三态）=====

test("T7a SSOT 纯函数：matchedCertRecord providerKey 三态比对", () => {
  const block = { protocol: "anthropic-compatible", baseUrl: "https://api.example.com/v1", apiKeyEnv: "K" };
  const agentWithProvider = { backend: "b", model: { id: "m" }, provider: block };
  const agentBare = { backend: "b", model: { id: "m" } };

  // undefined = legacy 记录 → 该维跳过（即使 agent 侧有 provider）。
  const legacy = { backend: "b", modelId: "m", providerKey: undefined };
  assert.equal(matchedCertRecord(agentWithProvider, legacy), legacy, "记录侧缺 providerKey → legacy 跳过该维");

  // 显式 null = 已观察无接入方：与 agent 侧不可派生（null）匹配。
  const observedNone = { backend: "b", modelId: "m", providerKey: null };
  assert.equal(matchedCertRecord(agentBare, observedNone), observedNone, "null ↔ 无 provider 块 → 匹配");
  assert.equal(matchedCertRecord(agentWithProvider, observedNone), null, "null ≠ 可派生指纹 → 不匹配");

  // 双侧非 null：逐字节比对。
  const recorded = { backend: "b", modelId: "m", providerKey: providerKeyFor(block) };
  assert.equal(matchedCertRecord(agentWithProvider, recorded), recorded, "同指纹 → 匹配");
  assert.equal(
    matchedCertRecord(agentWithProvider, { ...recorded, providerKey: "https://other.example.com|K" }),
    null,
    "异指纹（换了接入方）→ 不匹配",
  );
});

test("T7b 门·端到端：registry 换接入方（baseUrl 变）未重认证 → 认证身份不匹配拒绝", async () => {
  const dir = makeDir();
  try {
    const OLD_PROVIDER = { protocol: "anthropic-compatible", baseUrl: "https://old.example.com/v1", apiKeyEnv: "GATE_KEY" };
    const NEW_PROVIDER = { protocol: "anthropic-compatible", baseUrl: "https://new.example.com/v1", apiKeyEnv: "GATE_KEY" };
    const registryPath = makeRegistry(dir, {
      pk_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" }, provider: NEW_PROVIDER },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      // 认证时接的是 old.example.com；registry 已换接入方、未重跑 reliability。
      pk_w: {
        agentId: "pk_w", backend: "claude-code", modelId: "glm-5.2", status: "certified",
        providerKey: providerKeyFor(OLD_PROVIDER), lastHealthyRunAt: NOW_ISO(),
      },
    });
    const manager = makeGateManager({ registryPath, runDir, env: { GATE_KEY: "x" } });
    await assert.rejects(
      manager.start("pk_w", { prompt: "x", requireCertified: true }),
      (err) => {
        assert.match(err.message, /认证身份不匹配/, "providerKey 维度进门身份比对（四元组）");
        assert.ok(!err.message.includes("old.example.com") && !err.message.includes("new.example.com"),
          "固定文案不回显指纹/baseUrl 值（磁盘数据可能被改）");
        return true;
      },
      "换接入方后旧组合认证不放行（R23-C §1）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("T7c 门·端到端：providerKey 匹配（同指纹；显式 null ↔ 无 provider 块）→ 放行", async () => {
  const dir = makeDir();
  try {
    // A：双侧同指纹 + 全量口径新鲜 → 放行。
    const PROVIDER = { protocol: "anthropic-compatible", baseUrl: "https://same.example.com/v1", apiKeyEnv: "GATE_KEY" };
    let registryPath = makeRegistry(dir, {
      pk_ok_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" }, provider: PROVIDER },
    });
    let runDir = makeSummary(join(dir, "runs-a"), {
      pk_ok_w: {
        agentId: "pk_ok_w", backend: "claude-code", modelId: "glm-5.2", status: "certified",
        providerKey: providerKeyFor(PROVIDER), lastFullHealthyRunAt: NOW_ISO(), lastHealthyRunAt: NOW_ISO(),
      },
    });
    let manager = makeGateManager({ registryPath, runDir, env: { GATE_KEY: "x" } });
    let run = await manager.start("pk_ok_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "四元组全匹配 + 全量新鲜 → 放行");

    // B：记录侧显式 null（认证时已观察无接入方）↔ 当前 registry 也无 provider 块。
    registryPath = makeRegistry(dir, {
      pk_none_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" } },
    });
    runDir = makeSummary(join(dir, "runs-b"), {
      pk_none_w: {
        agentId: "pk_none_w", backend: "claude-code", modelId: "glm-5.2", status: "certified",
        providerKey: null, lastFullHealthyRunAt: NOW_ISO(), lastHealthyRunAt: NOW_ISO(),
      },
    });
    manager = makeGateManager({ registryPath, runDir });
    run = await manager.start("pk_none_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "null ↔ 无 provider 块 → 匹配放行（三态语义）");
  } finally {
    cleanupDir(dir);
  }
});

// ===== T8 门矩阵·lastFullHealthyRunAt 新鲜度 + §3 scope 派生收窄 =====

test("T8a 半迁移回落：legacy 记录缺 lastFullHealthyRunAt → 回落 lastHealthyRunAt（TD-132 行为不变）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      half_mig_w: { backend: "claude-code", cwd: dir },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      // 旧格式记录：只有 lastHealthyRunAt，无 R23-C 字段。
      half_mig_w: { agentId: "half_mig_w", status: "certified", lastHealthyRunAt: NOW_ISO() },
    });
    const manager = makeGateManager({ registryPath, runDir });
    const run = await manager.start("half_mig_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "半迁移：门回落旧判据，存量记录不被新字段误杀");
  } finally {
    cleanupDir(dir);
  }
});

test("T8b 反洗白：lastFullHealthyRunAt:null（从未全量绿）+ lastHealthyRunAt 新鲜 → fail-closed 拒绝", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      never_full_w: { backend: "claude-code", cwd: dir },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      // delta-only 全绿史：lastHealthyRunAt 新鲜，但从未有 full 全绿（显式 null）。
      never_full_w: { agentId: "never_full_w", status: "certified", providerKey: null, lastFullHealthyRunAt: null, lastHealthyRunAt: NOW_ISO() },
    });
    const manager = makeGateManager({ registryPath, runDir });
    await assert.rejects(
      manager.start("never_full_w", { prompt: "x", requireCertified: true }),
      (err) => {
        assert.match(err.message, /无新鲜认证/, "显式 null 按 fail-closed 处理");
        assert.match(err.message, /lastFullHealthyRunAt/, "文案如实标注实际读取的字段");
        assert.ok(!err.message.includes("lastHealthyRunAt "), "不得静默回落旧判据（显式 null ≠ legacy 缺失）");
        return true;
      },
      "delta 全绿不得洗白全量口径的派发新鲜度（R23-C §2）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("T8c 反洗白：lastFullHealthyRunAt 陈旧 + lastHealthyRunAt 新鲜（刚重考 delta）→ 认证已过期", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      stale_full_w: { backend: "claude-code", cwd: dir },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      // 40 天前最后一次全量绿；今天刚重考了 delta 子集（lastHealthyRunAt 新鲜）。
      stale_full_w: {
        agentId: "stale_full_w", status: "certified",
        lastFullHealthyRunAt: DAYS_AGO_ISO(40), lastHealthyRunAt: NOW_ISO(),
      },
    });
    const manager = makeGateManager({ registryPath, runDir });
    await assert.rejects(
      manager.start("stale_full_w", { prompt: "x", requireCertified: true }),
      (err) => {
        assert.match(err.message, /认证已过期/, "全量口径陈旧 → 过期拒绝");
        assert.match(err.message, /lastFullHealthyRunAt/, "过期 reason 标注实际字段");
        assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(err.message), "不回显磁盘时间戳原文（只展示天数）");
        return true;
      },
      "delta 重考不得刷新全量口径新鲜度（R23-C §2）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("T8d 全量口径新鲜即放行：lastFullHealthyRunAt 新鲜 + lastHealthyRunAt 陈旧 → 过（门只读全量字段）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      fresh_full_w: { backend: "claude-code", cwd: dir },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      fresh_full_w: {
        agentId: "fresh_full_w", status: "certified",
        lastFullHealthyRunAt: NOW_ISO(), lastHealthyRunAt: DAYS_AGO_ISO(40),
      },
    });
    const manager = makeGateManager({ registryPath, runDir });
    const run = await manager.start("fresh_full_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "存在该字段时门只读 lastFullHealthyRunAt，不做二次 max 合成");
  } finally {
    cleanupDir(dir);
  }
});

test("T8e lastFullHealthyRunAt 不可解析 → fail-closed（固定文案，不回显原文）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      garbage_full_w: { backend: "claude-code", cwd: dir },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      garbage_full_w: { agentId: "garbage_full_w", status: "certified", lastFullHealthyRunAt: "not a date <script>alert(1)</script>" },
    });
    const manager = makeGateManager({ registryPath, runDir });
    await assert.rejects(
      manager.start("garbage_full_w", { prompt: "x", requireCertified: true }),
      (err) => {
        assert.match(err.message, /无新鲜认证/, "不可解析按未认证处理");
        assert.match(err.message, /lastFullHealthyRunAt/, "标注实际读取的字段");
        assert.ok(!err.message.includes("<script>"), "不回显磁盘原始值");
        return true;
      },
      "不可解析的全量口径时间戳 fail-closed",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("T8f §3 scope 派生收窄：profile:'delta' 不再短路——显式 drills 超出子集按 full 记", () => {
  // 恰为子集 → delta。
  assert.equal(
    certificationScopeForCase({ profile: "delta", drills: ["sentinel", "scorecard", "adversarialEscape"] }),
    "delta",
  );
  // legacy 形状（profile:"delta" 无 drills）→ vacuous truth 视为未超出，保持旧行为。
  assert.equal(certificationScopeForCase({ profile: "delta" }), "delta", "无 drills 的 legacy 形状不误伤");
  assert.equal(certificationScopeForCase({ profile: "delta", drills: [] }), "delta");
  // 显式 drills 超出子集 → full（TD-133(c)：scope 反映实际覆盖，不反射标签）。
  assert.equal(
    certificationScopeForCase({ profile: "delta", drills: ["sentinel", "workflowRunDir"] }),
    "full",
    "超出子集（workflowRunDir 明确不在 delta）→ full",
  );
  assert.equal(
    certificationScopeForCase({ profile: "delta", drills: ["sentinel", "scorecard", "adversarialEscape", "stop"] }),
    "full",
    "子集 + 一个超集 drill → full（⊆ 不是 ∩）",
  );
  // 无 profile 的手写 case：子集内且含越界写对抗仍按 delta（既有行为保留）。
  assert.equal(certificationScopeForCase({ drills: ["sentinel", "scorecard", "adversarialEscape"] }), "delta");
  assert.equal(certificationScopeForCase({}), "full", "空 case 默认 full");
});

test("T8g 写入侧聚合：仅 full 全绿刷新 lastFullHealthyRunAt；delta 全绿不洗白；providerKey 无条件写", () => {
  const GREEN_CHECKS = [
    { name: "completion", pass: true, category: "core" },
    { name: "answer", pass: true, category: "core" },
    { name: "scorecard", pass: true, category: "strict" },
    { name: "isolation", pass: true, category: "operational" },
    { name: "metrics", pass: true, category: "observability" },
  ];
  const FULL_OLD_AT = DAYS_AGO_ISO(30);
  const DELTA_NEW_AT = NOW_ISO();
  const summary = summarizeCertification([
    { // 全量绿（30 天前）——lastFullHealthyRunAt 的唯一合法刷新来源。
      caseId: "c-full", agentId: "agg_w", backend: "claude-code", modelId: "m1", providerKey: null,
      drills: ["sentinel"], lastHealthyRunAt: FULL_OLD_AT, checks: GREEN_CHECKS,
    },
    { // delta 绿（刚刚）——通过也只到 conditional，不得刷新全量口径新鲜度。
      caseId: "c-delta", agentId: "agg_w", backend: "claude-code", modelId: "m1", providerKey: null,
      profile: "delta", drills: ["sentinel", "scorecard", "adversarialEscape"],
      lastHealthyRunAt: DELTA_NEW_AT, checks: GREEN_CHECKS,
    },
  ]);
  const w = summary.workers.agg_w;
  assert.equal(w.status, "conditional", "delta 全绿是 conditional（混合取最差）");
  assert.equal(w.certificationScope, "delta", "worker scope 混合取保守值");
  assert.equal(w.lastHealthyRunAt, DELTA_NEW_AT, "任意口径全绿都刷新旧判据字段");
  assert.equal(w.lastFullHealthyRunAt, FULL_OLD_AT, "lastFullHealthyRunAt 只由 full 全绿刷新——未被今天的 delta 绿拉动");
  assert.equal(w.providerKey, null, "providerKey 无条件写：active identity 已观察无接入方 → 显式 null");
});

// ===== T9 §5 certMigrationAdvisories（registry validate 提示的纯函数宿主）=====

test("T9 三态不误报：legacy 缺字段才出 advisory；显式 null = 已观察事实；无记录不报", () => {
  // legacy 记录：两个字段都缺 → 恰两条（各指一字段）。
  const legacy = certMigrationAdvisories({ status: "certified", lastHealthyRunAt: NOW_ISO() });
  assert.equal(legacy.length, 2);
  assert.match(legacy[0], /providerKey/);
  assert.match(legacy[1], /lastFullHealthyRunAt/);

  // 显式 null = 已观察事实（无接入方 / 从未全量绿）——是迁移后的形状，不是 legacy。
  assert.deepEqual(
    certMigrationAdvisories({ status: "certified", providerKey: null, lastFullHealthyRunAt: null }),
    [],
    "null ≠ 缺失：不误报",
  );

  // 完整迁移记录 → 无 advisory。
  assert.deepEqual(
    certMigrationAdvisories({ status: "certified", providerKey: "https://x.example.com|K", lastFullHealthyRunAt: NOW_ISO(), lastHealthyRunAt: NOW_ISO() }),
    [],
  );

  // 部分迁移：只缺一个字段 → 恰一条。
  assert.equal(certMigrationAdvisories({ status: "certified", providerKey: null }).length, 1);
  assert.equal(certMigrationAdvisories({ status: "certified", lastFullHealthyRunAt: NOW_ISO() }).length, 1);

  // 从未认证（无 worker 记录）→ 无 ledger 可迁移，不报。
  assert.deepEqual(certMigrationAdvisories(undefined), []);
  assert.deepEqual(certMigrationAdvisories(null), []);
});

// =====================================================================
// R23-C 集成吸收轮（2026-08-21）：coder_hq 上一轮交付（b3d6b3ca）的测试
// 组移植 + auditor 补钉。U 前缀避让基线 T5–T9 标签；断言语义与原版一致，
// 归一化期望从 JSON 元组改写为基线的 "<baseUrl>|<env>" 指纹形状。
// =====================================================================

// ===== U6d 门·端到端：归一化等价放行（同接入方不同写法同指纹）=====

const U6D_PROVIDER = {
  protocol: "anthropic-compatible",
  baseUrl: "https://api.example.com/anthropic",
  apiKeyEnv: "U6D_GATE_KEY",
};

test("U6d 门：同接入方不同写法的记录指纹（归一化等价）→ 放行", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, {
      u6d_w: { backend: "claude-code", cwd: dir, model: { id: "glm-5.2" }, provider: U6D_PROVIDER },
    });
    const runDir = makeSummary(join(dir, "runs"), {
      u6d_w: {
        agentId: "u6d_w", backend: "claude-code", modelId: "glm-5.2",
        // 认证时 baseUrl 写法不同（大小写 + 默认端口 + 尾斜杠）——归一化后同一接入方。
        providerKey: providerKeyFor({ baseUrl: "HTTPS://API.Example.COM:443/anthropic/", apiKeyEnv: "U6D_GATE_KEY" }),
        status: "certified", lastHealthyRunAt: NOW_ISO(),
      },
    });
    const manager = makeGateManager({ registryPath, runDir, env: { U6D_GATE_KEY: "synthetic-not-a-secret" } });
    const run = await manager.start("u6d_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "归一化等价的写法差异不得误拒（同接入方 = 同指纹）");
  } finally {
    cleanupDir(dir);
  }
});

// ===== U7 门新鲜度六态 e2e（lastFullHealthyRunAt 状态矩阵）=====

test("U7a 门：lastFullHealthyRunAt 新鲜（lastHealthyRunAt 缺失/陈旧）→ 放行", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, { u7_w: { backend: "claude-code", cwd: dir } });
    const runDir = makeSummary(join(dir, "runs"), {
      // 全量绿新鲜；lastHealthyRunAt 陈旧（含 delta 全绿史）不参与门判定。
      u7_w: { agentId: "u7_w", status: "certified", lastFullHealthyRunAt: NOW_ISO(), lastHealthyRunAt: DAYS_AGO_ISO(40) },
    });
    const manager = makeGateManager({ registryPath, runDir });
    const run = await manager.start("u7_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "门只读 lastFullHealthyRunAt，不被陈旧旧判据拖回");
  } finally {
    cleanupDir(dir);
  }
});

test("U7b【证伪】门：lastFullHealthyRunAt=null（只有 delta 全绿）+ lastHealthyRunAt 新鲜 → 拒绝", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, { u7b_w: { backend: "claude-code", cwd: dir } });
    const runDir = makeSummary(join(dir, "runs"), {
      // delta 全绿刷新了 lastHealthyRunAt，但从未有全量绿——不得养门。
      u7b_w: { agentId: "u7b_w", status: "conditional", lastFullHealthyRunAt: null, lastHealthyRunAt: NOW_ISO() },
    });
    const manager = makeGateManager({ registryPath, runDir });
    await assert.rejects(
      manager.start("u7b_w", { prompt: "x", requireCertified: true }),
      (err) => {
        assert.match(err.message, /无新鲜认证/, "delta 全绿不是全量新鲜度的事实来源");
        assert.match(err.message, /lastFullHealthyRunAt/, "reason 点名实际读取的字段");
        return true;
      },
      "delta 全绿不得刷新派发新鲜度（R23-C §2）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("U7c 门：legacy summary 无 lastFullHealthyRunAt → 回退读 lastHealthyRunAt（新鲜 → 放行）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, { u7c_w: { backend: "claude-code", cwd: dir } });
    const runDir = makeSummary(join(dir, "runs"), {
      u7c_w: { agentId: "u7c_w", status: "certified", lastHealthyRunAt: NOW_ISO() },
    });
    const manager = makeGateManager({ registryPath, runDir });
    const run = await manager.start("u7c_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "半迁移期：字段缺失回退既有 lastHealthyRunAt，存量记录不被新字段误杀");
  } finally {
    cleanupDir(dir);
  }
});

test("U7d 门：legacy 回退源亦缺（lastHealthyRunAt=null）→ fail-closed 拒绝", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, { u7d_w: { backend: "claude-code", cwd: dir } });
    const runDir = makeSummary(join(dir, "runs"), {
      // 旧格式记录：无 lastFullHealthyRunAt，且 lastHealthyRunAt 显式 null。
      u7d_w: { agentId: "u7d_w", status: "certified", lastHealthyRunAt: null },
    });
    const manager = makeGateManager({ registryPath, runDir });
    await assert.rejects(
      manager.start("u7d_w", { prompt: "x", requireCertified: true }),
      /无新鲜认证/,
      "回退后仍无新鲜度事实 → 拒（fail-closed，不静默放行）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("U7e 门：lastFullHealthyRunAt 过期 → 拒绝（回显天数，不回显磁盘时间戳原文）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, { u7e_w: { backend: "claude-code", cwd: dir } });
    const stale = DAYS_AGO_ISO(40);
    const runDir = makeSummary(join(dir, "runs"), {
      u7e_w: { agentId: "u7e_w", status: "certified", lastFullHealthyRunAt: stale, lastHealthyRunAt: NOW_ISO() },
    });
    const manager = makeGateManager({ registryPath, runDir });
    await assert.rejects(
      manager.start("u7e_w", { prompt: "x", requireCertified: true }),
      (err) => {
        assert.match(err.message, /认证已过期/, "全量绿陈旧 → 过期拒绝");
        assert.match(err.message, /lastFullHealthyRunAt 距今 40天/, "回显天数与字段名");
        assert.ok(!err.message.includes(stale), "不得回显磁盘时间戳原文（既有纪律）");
        return true;
      },
      "delta 新鲜（lastHealthyRunAt=now）不得洗白全量绿的陈旧",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("U7f 门：manualOverride=cleared + lastFullHealthyRunAt=null → 照常放行（例外先于新鲜度）", async () => {
  const dir = makeDir();
  try {
    const registryPath = makeRegistry(dir, { u7f_w: { backend: "claude-code", cwd: dir } });
    const runDir = makeSummary(join(dir, "runs"), {
      u7f_w: { agentId: "u7f_w", status: "rejected", manualOverride: "cleared", lastFullHealthyRunAt: null, lastHealthyRunAt: null },
    });
    const manager = makeGateManager({ registryPath, runDir });
    const run = await manager.start("u7f_w", { prompt: "x", requireCertified: true });
    assert.equal(run.state, "submitted", "Owner 背书旁路语义不变（先于身份/status/新鲜度）");
  } finally {
    cleanupDir(dir);
  }
});

// ===== U9 certifyCase 证伪：delta 标签不再误降档（TD-133(c)）=====

function u9GreenChecks() {
  return [
    { name: "completed", pass: true, category: "core" },
    { name: "commandsPassed", pass: true, category: "strict" },
    { name: "isolation", pass: true, category: "operational" },
    { name: "metricsNonZero", pass: true, category: "observability" },
  ];
}

test("U9【证伪】certifyCase：delta 行显式 drills 超子集 + 全绿 → certified（不再误降档）", () => {
  const result = certifyCase({
    caseId: "delta-row-full-coverage",
    profile: "delta",
    drills: ["sentinel", "scorecard", "adversarialEscape", "stop"],
    checks: u9GreenChecks(),
  });
  assert.equal(result.status, "certified", "实际覆盖是全量规程 → 不得按 delta 标签降档（TD-133(c) 误标根修）");
  // 对照：恰为子集的 delta 行仍降档 conditional（既有 Owner 方案 A 不变）。
  const subset = certifyCase({
    caseId: "delta-row-subset",
    profile: "delta",
    drills: ["sentinel", "scorecard", "adversarialEscape"],
    checks: u9GreenChecks(),
  });
  assert.equal(subset.status, "conditional", "真 delta 子集全过仍是 conditional（升级需全量重跑）");
});

// ===== U11 §4 续跑漂移 e2e（continueRun + 真 worktree）=====

function t11Git(args, cwd) {
  return String(execSync("git " + args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).trim();
}

function t11MakeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wao-t11-repo-"));
  t11Git("init -b main", repo);
  t11Git("config user.email t@t.com", repo);
  t11Git("config user.name T", repo);
  writeFileSync(join(repo, "README.md"), "# base\n", "utf8");
  t11Git("add -A", repo);
  t11Git("commit -m base", repo);
  return repo;
}

function t11BuildCommittedParent(repo, runId) {
  const wt = join(repo, ".wao-worktrees", runId);
  t11Git(`worktree add -b wao/${runId} "${wt}"`, repo);
  const base = t11Git("rev-parse HEAD", repo);
  writeFileSync(join(wt, "keep.txt"), "keep-changed\n", "utf8");
  t11Git("add -A", wt);
  t11Git('-c user.name="WAO Delivery" -c user.email="wao-delivery@local" commit -m "wao-delivery: ' + runId + '"', wt);
  const deliveryCommit = t11Git("rev-parse HEAD", wt);
  return { wt, base, deliveryCommit, branch: `wao/${runId}` };
}

async function t11SeedParent({ runDir, runId, repo, parent, providerKey }) {
  const agentId = "t11_w";
  mkdirSync(runDir, { recursive: true });
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.background_submitted", { background: true, cwd: repo, deliveryRequested: true });
  await t.transitionState(null, "pending", "background_spawned");
  await t.append("run.started", {
    backend: "claude-code",
    cwd: repo,
    worktreePath: parent.wt,
    worktreeBranch: parent.branch,
    // R23-C §4 父侧 durable 事实：undefined = legacy 父（字段被 JSON 丢弃），
    // null = 已观察无接入方，字符串 = 指纹。
    providerKey,
    delivery: {
      mode: "git_commit_v1",
      baseCommit: parent.base,
      allowedPaths: ["src", "keep.txt"],
      verificationCommands: ["node --test"],
    },
  });
  await t.append("run.session_reuse", { mode: "run_lineage", turn: "first", rootRunId: runId });
  await t.append("session.created", { backend: "claude-code", backendSessionId: "provider-session-1", serveUrl: null });
  await t.append("run.delivery_created", {
    deliveryCommit: parent.deliveryCommit,
    delivery: {
      schemaVersion: 1, kind: "git_commit", runId,
      baseCommit: parent.base, deliveryCommit: parent.deliveryCommit,
      branch: parent.branch, worktreePath: parent.wt, allowedPaths: ["src", "keep.txt"],
      changedFiles: ["keep.txt"], verification: { commands: ["node --test"] },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    },
  });
  await t.transitionState("pending", "completed", "done");
  return agentId;
}

test("U11a【证伪】续跑漂移：run.started.providerKey ≠ 当前 registry provider 指纹 → worker_configuration_changed", async () => {
  const repo = t11MakeRepo();
  const runDir = mkdtempSync(join(tmpdir(), "wao-t11-drift-"));
  try {
    const parent = t11BuildCommittedParent(repo, "run_t11_drift");
    await t11SeedParent({
      runDir, runId: "run_t11_drift", repo, parent,
      // 父 run 跑在 A 接入方上。
      providerKey: providerKeyFor({ baseUrl: "https://lane-a.example.com/v1", apiKeyEnv: "T11_A_KEY" }),
    });
    // registry 现在指向 B 接入方——provider 会话不可继承。
    const registryPath = makeRegistry(runDir, {
      t11_w: {
        backend: "claude-code", cwd: repo,
        provider: { protocol: "anthropic-compatible", baseUrl: "https://lane-b.example.com/v1", apiKeyEnv: "T11_B_KEY" },
      },
    });
    const r = await continueRun({
      parentRunId: "run_t11_drift", prompt: "fix",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] },
      runDir, registryPath, authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "worker_configuration_changed",
      "换接入方（baseUrl/env 名）的续跑必须拒绝（provider 指纹纳入漂移比对）");
    assert.equal(t11Git("symbolic-ref --short HEAD", parent.wt), parent.branch, "read-only 拒绝不动 worktree");
  } finally {
    try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("U11b 续跑：providerKey 匹配当前 registry → 放行；legacy 父 run（无字段）→ 维度跳过放行", async () => {
  const repo = t11MakeRepo();
  const runDir = mkdtempSync(join(tmpdir(), "wao-t11-ok-"));
  const provider = { protocol: "anthropic-compatible", baseUrl: "https://lane-a.example.com/v1", apiKeyEnv: "T11_A_KEY" };
  try {
    const spawnCalls = [];
    const fakeSpawn = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { unref() {} };
    };
    const parent = t11BuildCommittedParent(repo, "run_t11_ok");
    await t11SeedParent({ runDir, runId: "run_t11_ok", repo, parent, providerKey: providerKeyFor(provider) });
    const registryPath = makeRegistry(runDir, { t11_w: { backend: "claude-code", cwd: repo, provider } });
    const ok = await continueRun({
      parentRunId: "run_t11_ok", prompt: "fix",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] },
      runDir, registryPath, authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: fakeSpawn, skipCredentialCheck: true,
    });
    assert.equal(ok.accepted, true, "同接入方续跑照常放行");
    assert.equal(spawnCalls.length, 1);

    // legacy 父 run：run.started 无 providerKey 字段（R23-C 之前的存量）。
    const legacyParent = t11BuildCommittedParent(repo, "run_t11_legacy");
    await t11SeedParent({ runDir, runId: "run_t11_legacy", repo, parent: legacyParent, providerKey: undefined });
    const legacy = await continueRun({
      parentRunId: "run_t11_legacy", prompt: "fix",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] },
      runDir, registryPath, authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: fakeSpawn, skipCredentialCheck: true,
    });
    assert.equal(legacy.accepted, true, "legacy 父 run 无 providerKey 事实 → 维度跳过（半迁移容忍）");
  } finally {
    try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("U11c【正反钉】续跑：父 providerKey=null（原生直连）+ registry 现配 provider 块 → 必拒（F2）", async () => {
  const repo = t11MakeRepo();
  const runDir = mkdtempSync(join(tmpdir(), "wao-t11-null-"));
  try {
    const parent = t11BuildCommittedParent(repo, "run_t11_null");
    // 父跑时是原生直连（无 provider 块）——run.started.providerKey 是显式 null。
    await t11SeedParent({ runDir, runId: "run_t11_null", repo, parent, providerKey: null });
    // registry 现在给这条 lane 配了 provider 块——最高危迁移不得静默继承旧会话。
    const registryPath = makeRegistry(runDir, {
      t11_w: {
        backend: "claude-code", cwd: repo,
        provider: { protocol: "anthropic-compatible", baseUrl: "https://lane-a.example.com/v1", apiKeyEnv: "T11_A_KEY" },
      },
    });
    const r = await continueRun({
      parentRunId: "run_t11_null", prompt: "fix",
      delivery: { mode: "git_commit_v1", allowedPaths: ["src", "keep.txt"], verificationCommands: ["node --test"] },
      runDir, registryPath, authorizedWorkspaceRoot: repo, leadSession: "lead-session-1",
      backendFor: () => ({ supportsSessionReuse: true }),
    });
    assert.equal(r.accepted, false);
    assert.equal(r.rejectionReason, "worker_configuration_changed",
      "父显式 null（已观察无接入方）≠ 当前可派生指纹——无条件键封住 F2 的 fail-open 洞");
    assert.equal(t11Git("symbolic-ref --short HEAD", parent.wt), parent.branch, "read-only 拒绝不动 worktree");
  } finally {
    try { rmSync(runDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
