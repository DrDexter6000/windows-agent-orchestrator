// test/registry-roles/backendCapabilityValidate.test.js
//
// ADR-0025 批次 2（2026-08-19）：backend 类闭集能力声明 + `registry validate`
// 配置 × 能力交叉校验。证伪优先（falsification-first）——每个测试对应一个
// "无交叉校验时假绿"的场景：
//
//   F1（TD-87 泛化）：伪造"声明不上报 usage（reportsTokenUsage=false）但配置了
//       tokenBudget"的形状 → validate 输出 ⚠。用【非 kimi 的伪造 backend 名】
//       驱动纯函数——旧的 `backend === "kimi-code"` 名字分支对这个形状是假绿，
//       只有读类声明的路径才会红。
//   F2（TD-117）：sessionReuse 配置 × supportsSessionReuse=false → ⚠（不阻塞，
//       运行时 fail-closed 门保留）。
//   FC（fail-closed 默认钉住）：未声明新字段的 backend（ProcessBackend 基类 /
//       未 opt-in 的子类 / truthy 非 true 值）一律不得被读成"支持"。
//   MATRIX：五个工厂 backend 的能力快照与当前类声明一致（防单侧漂移，
//       backendCapabilityMatrix.test.js 同款纪律）。
//   CLI-1/2：端到端（真 CLI 子进程，text + --format json 两模式）——kimi
//       tokenBudget ⚠ 语义零回归 + sessionReuse×false 新 ⚠ + claude-code
//       （声明支持）零 ⚠ 正向对照。
//   NOSPAWN：结构钉——validate 所在命令模块不 import node:child_process
//       （加载路径不为校验 spawn 任何进程；纯静态读类声明）。
//
// 分层：单元腿静态 import src 模块（零进程）；CLI 腿 spawn `src/cli.js`
// （WAO_SKIP_VERSION_GUARD=1，cliFormatJson.test.js 同款自包含模式）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readBackendCapabilities, backendCapabilitySnapshot } from "../../src/backends/factory.js";
import { ProcessBackend } from "../../src/backends/processBackend.js";
import { capabilityCrossCheckWarnings } from "../../src/commands/registry.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// =====================================================================
// F1 / F2: 纯函数腿——伪造能力形状直接驱动交叉校验
// =====================================================================

test("ADR25-B2-F1: 伪造 reportsTokenUsage=false × tokenBudget → ⚠（非 kimi 名，名字分支对它假绿）", () => {
  // 伪造形状：一个【非 kimi-code】的 backend 声明不上报 usage 但配置了 tokenBudget。
  // 旧的硬编码 `backend === "kimi-code"` 分支对此形状不报警（假绿）——只有读
  // 类声明的交叉校验路径才会红。
  const fakeAgent = { backend: "fake-harness", cwd: "D:/x", tokenBudget: 100000 };
  const warnings = capabilityCrossCheckWarnings(fakeAgent, {
    reportsTokenUsage: false,
    supportsSessionReuse: false,
  });
  assert.equal(warnings.length, 1, "恰一条 warning（不叠加 sessionReuse 项——该 agent 未配 sessionReuse）");
  assert.match(warnings[0], /fake-harness/, "warning 指明 backend（由声明驱动，非名字白名单）");
  assert.match(warnings[0], /tokenBudget.*不生效/, "TD-87 语义：配了不生效");

  // 正向对照：同一配置 × 声明上报 usage → 零 warning（闸门有喂料，配置有效）。
  assert.deepEqual(
    capabilityCrossCheckWarnings(fakeAgent, { reportsTokenUsage: true, supportsSessionReuse: false }),
    [],
    "声明 reportsTokenUsage=true × tokenBudget → 无 warning",
  );

  // 未配 tokenBudget → 零 warning（无关配置不误报）。
  assert.deepEqual(
    capabilityCrossCheckWarnings({ backend: "fake-harness", cwd: "D:/x" }, { reportsTokenUsage: false, supportsSessionReuse: false }),
    [],
    "未配 tokenBudget → 无 warning",
  );
});

test("ADR25-B2-F2: 伪造 supportsSessionReuse=false × sessionReuse 配置 → ⚠（不叠加、不阻塞语义由 CLI 腿钉）", () => {
  const fakeAgent = { backend: "fake-harness", cwd: "D:/x", sessionReuse: "lead_workspace" };
  const warnings = capabilityCrossCheckWarnings(fakeAgent, {
    reportsTokenUsage: true,
    supportsSessionReuse: false,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fake-harness.*sessionReuse/, "warning 指明 backend 与配置字段");
  assert.match(warnings[0], /supportsSessionReuse/, "提示能力声明名（修复指向）");
  assert.match(warnings[0], /fail-closed|运行时/, "说明运行时门仍在（validate 是前置提示层）");

  // 正向对照：声明支持的 backend × sessionReuse → 零 warning（claude-code 形状）。
  assert.deepEqual(
    capabilityCrossCheckWarnings(fakeAgent, { reportsTokenUsage: true, supportsSessionReuse: true }),
    [],
    "声明 supportsSessionReuse=true × sessionReuse → 无 warning",
  );

  // 未知 backend（snapshot=null）→ 零 warning：unknown backend 是 hard issue，
  // 由 validate 主循环报告，能力面不猜。
  assert.deepEqual(capabilityCrossCheckWarnings(fakeAgent, null), [], "capabilities=null → 无能力 warning");
});

// =====================================================================
// FC: fail-closed 默认语义钉住——"未声明"绝不读成"支持"
// =====================================================================

test("ADR25-B2-FC: 未声明 reportsTokenUsage 的 backend 不得被读成支持（基类默认 + 未 opt-in 子类 + truthy 非 true）", () => {
  class StubParser {}
  const makeOpts = { parserClass: StubParser, buildArgs: () => [] };

  // ProcessBackend 基类默认 = false（fail-closed 起点）。
  const base = new ProcessBackend(makeOpts);
  assert.equal(base.reportsTokenUsage, false, "ProcessBackend 基类默认 false");

  // 未 opt-in 的子类（未声明字段）继承基类默认 → 读 false。
  class UndeclaredBackend extends ProcessBackend {}
  const undeclared = new UndeclaredBackend(makeOpts);
  assert.equal(undeclared.reportsTokenUsage, false, "未声明字段的子类读 false（未声明 ≠ 支持）");
  assert.deepEqual(
    readBackendCapabilities(undeclared),
    { reportsTokenUsage: false, supportsSessionReuse: false },
    "快照读取对未声明子类 fail-closed",
  );

  // truthy 非 true（"false" 字符串 / 1）→ 严格 === true 读为 false
  // （与 runManager 消费 supportsSessionReuse 的纪律同款）。
  assert.deepEqual(
    readBackendCapabilities({ reportsTokenUsage: 1, supportsSessionReuse: "false" }),
    { reportsTokenUsage: false, supportsSessionReuse: false },
    "truthy 非 true 一律读 false",
  );

  // 未知 backend → snapshot null（能力面不猜，不伪造"支持"也不伪造"不支持"）。
  assert.equal(backendCapabilitySnapshot({ backend: "bogus-runtime" }), null, "未知 backend → null");
});

// =====================================================================
// MATRIX: 五个工厂 backend 的能力快照 = 当前类声明（防单侧漂移）
// =====================================================================

test("ADR25-B2-MATRIX: backendCapabilitySnapshot 与五个 backend 类的当前声明一致", () => {
  const expected = {
    "claude-code": { reportsTokenUsage: true, supportsSessionReuse: true },
    "codex": { reportsTokenUsage: true, supportsSessionReuse: false },
    "kimi-code": { reportsTokenUsage: false, supportsSessionReuse: false },
    "deepseek-harness": { reportsTokenUsage: true, supportsSessionReuse: false },
    "opencode-serve": { reportsTokenUsage: true, supportsSessionReuse: false },
  };
  for (const [backend, caps] of Object.entries(expected)) {
    assert.deepEqual(
      backendCapabilitySnapshot({ backend }),
      caps,
      `${backend} 的能力快照必须与类声明一致（单侧漂移即红）`,
    );
  }
});

// =====================================================================
// CLI: 端到端（真 CLI 子进程）——零回归 + 新 warning + 正向对照
// =====================================================================

/**
 * spawn 级跑 repo 的 src/cli.js（guard 豁免注入，cliFormatJson.test.js 同款；
 * validate 无回环 server 依赖，spawnSync 足够）。
 */
function runCli(args) {
  return spawnSync(process.execPath, ["src/cli.js", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
    windowsHide: true,
  });
}

/** 三 agent 夹具：正向对照（claude-code 全配）+ 两条交叉不符（kimi/codex）。 */
function makeCrossCheckRegistry(dir) {
  return {
    researcher: { backend: "claude-code", cwd: dir, tokenBudget: 100000, sessionReuse: "lead_workspace" },
    coder_mm: { backend: "kimi-code", cwd: dir, tokenBudget: 100000 },
    tester: { backend: "codex", cwd: dir, sessionReuse: "lead_workspace" },
  };
}

test("ADR25-B2-CLI-1: text 模式——kimi×tokenBudget ⚠（TD-87 零回归）、codex×sessionReuse 新 ⚠、claude-code 零 ⚠，全部 ✔ exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b2val-text-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: makeCrossCheckRegistry(dir) }), "utf8");

    // R23-C §5 隔离：同 cliFormatJson——空 run-dir 隔离真实台账。
    const r = runCli(["registry", "validate", "--registry", registryPath, "--run-dir", join(dir, "runs-none")]);
    assert.equal(r.status, 0, "warning 不阻塞：三条目全部合法 → exit 0");
    // 三个 agent 都通过（✔）。
    assert.match(r.stdout, /✔\s*researcher/, "claude-code 通过");
    assert.match(r.stdout, /✔\s*coder_mm/, "kimi 通过（warning 不 block）");
    assert.match(r.stdout, /✔\s*tester/, "codex 通过（warning 不 block）");
    // TD-87 既有语义零回归（现有 cli.test.js 断言形状复刻）。
    assert.match(r.stdout, /⚠.*coder_mm:.*kimi-code.*tokenBudget.*不生效/, "kimi×tokenBudget ⚠ 保持");
    // TD-117 新 warning。
    assert.match(r.stdout, /⚠.*tester:.*codex.*sessionReuse.*supportsSessionReuse/, "codex×sessionReuse ⚠（TD-117 前置提示）");
    // 正向对照：claude-code 声明两个能力都支持 → 无 ⚠ 行提及 researcher。
    assert.doesNotMatch(r.stdout, /⚠.*researcher/, "claude-code（声明支持）× 两配置 → 零 ⚠");
    assert.match(r.stdout, /3 agent\(s\) checked, all valid/, "汇总行不变");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ADR25-B2-CLI-2: --format json——两条新 warning 语义进 warnings[]，ok 不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-b2val-json-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: makeCrossCheckRegistry(dir) }), "utf8");

    const r = runCli(["registry", "validate", "--registry", registryPath, "--run-dir", join(dir, "runs-none"), "--format", "json"]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.checked, 3);
    assert.equal(parsed.valid, true, "warning 不影响 valid");
    const byId = Object.fromEntries(parsed.agents.map((a) => [a.id, a]));

    assert.deepEqual(byId.researcher.warnings, [], "claude-code 正向对照：零 warning");
    assert.equal(byId.coder_mm.ok, true, "kimi 仍 ok（TD-87 warning 不阻塞）");
    assert.ok(byId.coder_mm.warnings.some((w) => /kimi-code.*tokenBudget.*不生效/.test(w)),
      "TD-87 warning 进 warnings[]");
    assert.equal(byId.tester.ok, true, "codex 仍 ok（TD-117 warning 不阻塞）");
    assert.ok(byId.tester.warnings.some((w) => /codex.*sessionReuse.*supportsSessionReuse/.test(w)),
      "TD-117 warning 进 warnings[]");
    assert.ok(byId.tester.warnings.every((w) => !/tokenBudget/.test(w)),
      "codex 未配 tokenBudget → 不误报 tokenBudget warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// =====================================================================
// NOSPAWN: 结构钉——validate 所在模块不 import node:child_process
// =====================================================================

test("ADR25-B2-NOSPAWN: registry 命令模块不 import node:child_process（validate 加载路径纯静态读类声明）", () => {
  // 结构性守卫（stateChangeReasons.test.js / R18-SM-1 源级纪律钉先例）：五个
  // backend 类的构造函数无副作用，validate 的能力读取经 backendCapabilitySnapshot
  // 构造实例完成——本断言钉住"命令层不为校验引入进程 spawn 通道"这一结构面。
  const source = readFileSync(join(ROOT, "src", "commands", "registry.js"), "utf8");
  assert.doesNotMatch(source, /from\s+"node:child_process"/,
    "src/commands/registry.js 不得 import node:child_process（validate 纯静态）");
});
