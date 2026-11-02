// test/commands/registryAlign.test.js
//
// 决定 0108：registry align——私有注册表跟随车道表的行为钉（诊断模块 + CLI 适配
// + doctor lane_wiring 检查项 + lead_preflight 一行事实）。
//
// 契约（决定 0108 + 本批任务边界）：
//   - 预览零写入：打印三类事实 + 私有文件 SHA-256；带 --lane 显示将改成什么。
//   - --apply 拒绝条件（全部在任何写盘之前，整次拒绝什么都不写）：缺 --lane；
//     缺 --expect-sha256；哈希与当前文件不符；所选车道不在车道表 / 不在私有
//     注册表；车道表与模板在该车道接线轴不一致（仓库自身冲突）；改后过不了
//     现有校验；JSON 语法坏；车道表结构校验未过。
//   - 只改四轴（backend/model.id/model.providerID/reasoning.effort——车道表侧
//     null 的轴键删除）与同名矩阵行 modelId；label/profile/drills、_comment*、
//     本地字段（env/cwd/binary/credentialEnv/…）逐键原样。
//   - 备份：原文件逐字节到同目录 agents.json.bak-<UTC时间戳>；同名已存在换名
//    （-1、-2…），绝不覆盖。
//   - 认证影响两类：backend/model.id/providerID 变=换身份（档位按 runbook：同 backend 换 model 走 delta）；只差
//     effort=身份不变（runbook「lane 变更同步面」④ delta 重取证）。
//   - doctor：接线不一致 WARN + align 预览命令；只有合法差异 INFO；非默认
//     --registry（车道表停用）不产该检查项。
//   - lead_preflight：接线不一致时 observations 加一行事实（≤512）；worker
//     上下文不投影；无不一致不加行。
//
// 隔离：注册表、车道表、模板全用临时目录夹具（经 config.lanesDocFn /
// config.alignTemplatePath / config.alignNowFn 测试缝注入），绝不读仓库真实
// config/lanes.json，也不读写私有 config/agents.json（只有一个测试确认入库模板文件在场）；
// doctor 测试照 skillLink.test.js 的 captureDoctorChecks 惯例把
// homeDir 注入临时目录。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registryCommand } from "../../src/commands/registry.js";
import { waoDoctorCommand } from "../../src/commands/doctor.js";
import { aggregateLeadPreflight } from "../../src/application/leadPreflight.js";
import {
  diagnoseRegistryAlignment,
  applyRegistryAlignment,
  laneWiringMismatchFactLine,
  applyAxesToEntry,
  rewritesLosslessly,
  DEFAULT_TEMPLATE_PATH,
} from "../../src/application/registryAlign.js";
import { resolveDispatchTarget } from "../../src/dispatchResolution.js";

// ── 夹具 ────────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-11-02T10:00:00Z");
const BACKUP_STAMP = "20261102T100000Z";

// 夹具车道表：flash=换型号（身份变）、sole=只差 effort、dsh-lane=providerID+effort
// 删除语义、ill=接线合法但注册表条目带已退役 provider 块、mate=轴已一致仅矩阵行
// 滞后、fresh=表有私无。
function fixtureLanesDoc(path) {
  return {
    ok: true,
    path,
    sha256: "b".repeat(64),
    issues: [],
    lanes: [
      { id: "flash", backend: "zcode", model: { id: "bigmodel-api/GLM-F-NEW" }, reasoning: { effort: "max" }, aliases: {} },
      { id: "sole", backend: "codex", model: { id: "gpt-s" }, reasoning: { effort: "high" }, aliases: {} },
      { id: "dsh-lane", backend: "deepseek-acp", model: { id: "dsh-m", providerID: "dsh-official" }, reasoning: { effort: null }, aliases: {} },
      { id: "ill", backend: "deepseek-acp", model: { id: "dsh-m", providerID: "dsh-official" }, reasoning: { effort: "max" }, aliases: {} },
      { id: "mate", backend: "claude-code", model: { id: "m-mate" }, reasoning: { effort: "high" }, aliases: {} },
      { id: "fresh", backend: "claude-code", model: { id: "m-new" }, reasoning: { effort: "high" }, aliases: {} },
    ],
  };
}

// 模板（apply 的第二见证）：接线轴与车道表一致（本地字段随意——只比轴）。
function fixtureTemplate() {
  return {
    agents: {
      flash: { backend: "zcode", cwd: ".", binary: "C:/bin/zcode.cjs", model: { id: "bigmodel-api/GLM-F-NEW" }, reasoning: { effort: "max" } },
      sole: { backend: "codex", cwd: ".", model: { id: "gpt-s" }, reasoning: { effort: "high" } },
      "dsh-lane": { backend: "deepseek-acp", cwd: ".", credentialEnv: "DSH_KEY", model: { id: "dsh-m", providerID: "dsh-official" } },
      ill: { backend: "deepseek-acp", cwd: ".", credentialEnv: "DSH_KEY", model: { id: "dsh-m", providerID: "dsh-official" }, reasoning: { effort: "max" } },
      mate: { backend: "claude-code", cwd: ".", model: { id: "m-mate" }, reasoning: { effort: "high" } },
    },
  };
}

function fixtureRegistry(dir) {
  return {
    agents: {
      flash: {
        "_comment": "保留我（_comment* 不进要改清单）",
        backend: "zcode",
        cwd: dir,
        binary: join(dir, "zcode.cjs"),
        model: { id: "bigmodel-api/GLM-F-OLD" },
        reasoning: { effort: "max" },
        sessionReuse: "lead_workspace",
        env: { ZCODE_FIXTURE_VAR: "本地字段值-绝不回显也不改" },
      },
      sole: { backend: "codex", cwd: dir, model: { id: "gpt-s" }, reasoning: { effort: "low" } },
      "dsh-lane": { backend: "deepseek-acp", cwd: dir, credentialEnv: "DSH_KEY", model: { id: "dsh-m", providerID: "old-provider" }, reasoning: { effort: "low" } },
      ill: { backend: "deepseek-acp", cwd: dir, credentialEnv: "DSH_KEY", provider: { id: "legacy-channel" } },
      mate: { backend: "claude-code", cwd: dir, model: { id: "m-mate" }, reasoning: { effort: "high" } },
      retired: { backend: "codex", cwd: dir, model: { id: "m-old" }, reasoning: { effort: "high" } },
      broken: { backend: "claude-code", cwd: dir, provider: { id: "legacy" } },
    },
    certification: {
      matrix: [
        { agentId: "flash", label: "旧标签（保留）", profile: "delta", modelId: "bigmodel-api/GLM-F-OLD", drills: ["sentinel", "scorecard"] },
        { agentId: "mate", label: "mate 旧行", profile: "delta", modelId: "m-old-mate", drills: ["sentinel"] },
      ],
    },
  };
}

function makeEnv({ registry = fixtureRegistry, template = fixtureTemplate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wao-align-"));
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, `${JSON.stringify(registry(dir), null, 2)}\n`, "utf8");
  const templatePath = join(dir, "agents.example.json");
  writeFileSync(templatePath, JSON.stringify(template(), null, 2), "utf8");
  const config = {
    registry: registryPath,
    lanesDocFn: () => fixtureLanesDoc(join(dir, "lanes.json")),
    alignTemplatePath: templatePath,
    alignNowFn: () => FIXED_NOW,
  };
  return { dir, registryPath, templatePath, config };
}

function shaOfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function bytesOf(path) {
  return readFileSync(path);
}

async function runAlign(args, config) {
  const lines = [];
  const original = console.log;
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    await registryCommand(["align", ...args], config);
  } finally {
    console.log = original;
  }
  const exitCode = process.exitCode === undefined ? 0 : process.exitCode;
  process.exitCode = savedExitCode;
  return { lines, exitCode };
}

// 全一致夹具：车道表只有 flash，注册表四轴与矩阵行都与它一致。
function cleanLanesDoc(path) {
  return {
    ok: true,
    path,
    sha256: "c".repeat(64),
    issues: [],
    lanes: [
      { id: "flash", backend: "zcode", model: { id: "bigmodel-api/GLM-F-NEW" }, reasoning: { effort: "max" }, aliases: {} },
    ],
  };
}

function cleanRegistry(dir) {
  return {
    agents: {
      flash: { backend: "zcode", cwd: dir, binary: join(dir, "zcode.cjs"), model: { id: "bigmodel-api/GLM-F-NEW" }, reasoning: { effort: "max" } },
    },
    certification: { matrix: [{ agentId: "flash", modelId: "bigmodel-api/GLM-F-NEW" }] },
  };
}

/** 从车道表派生一份模板（apply 的第二见证：只带接线轴）。 */
function writeTemplateFor(dir, lanesDoc) {
  const templatePath = join(dir, "agents.example.json");
  const agents = {};
  for (const lane of lanesDoc.lanes) {
    agents[lane.id] = {
      backend: lane.backend,
      ...(lane.model ? { model: JSON.parse(JSON.stringify(lane.model)) } : {}),
      ...(lane.reasoning && lane.reasoning.effort != null ? { reasoning: { effort: lane.reasoning.effort } } : {}),
    };
  }
  writeFileSync(templatePath, JSON.stringify({ agents }, null, 2), "utf8");
  return templatePath;
}

function backupFiles(dir) {
  return readdirSync(dir).filter((f) => f.startsWith("agents.json.bak-")).sort();
}

function cleanup(env) {
  rmSync(env.dir, { recursive: true, force: true });
}

// ── 预览 ────────────────────────────────────────────────────────────────────

test("0108 预览：零写入、给出 SHA-256、三类事实各就各位", async () => {
  const env = makeEnv();
  try {
    const before = bytesOf(env.registryPath);
    const { lines, exitCode } = await runAlign(["--registry", env.registryPath], env.config);
    assert.equal(exitCode, 0, `预览退出码 0（诊断不是失败）：${lines.join("\n")}`);
    const out = lines.join("\n");
    assert.equal(bytesOf(env.registryPath).toString(), before.toString(), "预览零写入（文件字节不变）");
    assert.deepEqual(backupFiles(env.dir), [], "预览不产生备份");
    assert.ok(out.includes(`SHA-256: ${shaOfFile(env.registryPath)}`), "输出当前文件 SHA-256");
    // 类 2：接线不一致（含逐轴差值与两类认证影响）
    assert.ok(out.includes("[接线不一致"), "接线不一致块在场");
    assert.ok(out.includes("lane flash"), "flash 在场");
    assert.ok(out.includes("model.id=bigmodel-api/GLM-F-NEW"), "车道表目标型号在场");
    assert.ok(out.includes("model.id=bigmodel-api/GLM-F-OLD"), "注册表旧型号在场");
    assert.ok(out.includes("认证影响: 换了身份（backend/model.id/providerID 有变，四元组指纹变）——旧认证不再适用；重取证档位按 docs/certification-runbook.md（同 backend 换 model 走 delta，换 backend 全量）"), "身份变影响文案");
    assert.ok(out.includes("身份不变，只差 effort——按 docs/certification-runbook.md「lane 变更同步面」④ delta 重取证"), "effort-only 影响文案");
    assert.ok(out.includes("矩阵行 modelId=bigmodel-api/GLM-F-OLD ≠ 车道表 model.id=bigmodel-api/GLM-F-NEW"), "同名矩阵行 modelId 滞后列出");
    // 类 3：合法差异（表有私无 / 私有有表无）
    assert.ok(out.includes("[与车道表不同但合法]"), "合法差异块在场");
    assert.ok(out.includes("lane fresh: 车道表有、私有注册表没有——用 --lane 派它会被拒；align 不自动添加"), "表有私无只报告");
    assert.ok(out.includes("lane retired: 私有注册表有、车道表没有——车道表已不再提供该车道；默认保留"), "私有有表无只报告");
    // 类 1：配置不合法（含已退役 provider 块）
    assert.ok(out.includes("[配置不合法]"), "配置不合法块在场");
    assert.ok(out.includes("provider is no longer supported (decision 0106)"), "provider 退役文案在场（normalizeAgent 同源）");
    assert.ok(out.includes("broken"), "非法条目 id 在场");
    // 矩阵行滞后（轴已一致）单列
    assert.ok(out.includes("[矩阵行滞后"), "mate 矩阵行滞后块在场");
    // env 的值绝不回显（夹具 env 值不在输出的任何一行）
    assert.ok(!out.includes("本地字段值-绝不回显也不改"), "env 值不回显（决定 0108 写侧纪律）");
  } finally {
    cleanup(env);
  }
});

test("0108 预览：--lane 显示将改成什么；全一致时如实说一致", async () => {
  const env = makeEnv();
  try {
    const { lines } = await runAlign(["--registry", env.registryPath, "--lane", "flash", "--lane", "dsh-lane"], env.config);
    const out = lines.join("\n");
    assert.ok(out.includes("将改为: backend=zcode model.id=bigmodel-api/GLM-F-NEW providerID=- effort=max"), "flash 目标轴（providerID 缺席显示 -）");
    assert.ok(out.includes("将改为: backend=deepseek-acp model.id=dsh-m providerID=dsh-official effort=-"), "dsh-lane 目标轴（effort null 显示 -）");
    assert.ok(out.includes("--apply 用法: npm run cli -- registry align --lane flash --lane dsh-lane --apply --expect-sha256"), "点名车道的用法行");
  } finally {
    cleanup(env);
  }
  // 全一致夹具：车道表只有 flash，注册表四轴与车道表逐条一致（含模板见证）。
  const dir = mkdtempSync(join(tmpdir(), "wao-align-clean-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { flash: cleanRegistry(dir).agents.flash } }), "utf8");
    const lanesDoc = cleanLanesDoc(join(dir, "lanes.json"));
    const config = {
      registry: registryPath,
      lanesDocFn: () => lanesDoc,
      alignTemplatePath: writeTemplateFor(dir, lanesDoc),
    };
    const { lines, exitCode } = await runAlign([], config);
    assert.equal(exitCode, 0);
    assert.ok(lines.join("\n").includes("私有注册表与车道表一致"), "全一致如实展示");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("0108 预览：JSON 语法坏与文件读不到——如实报告、退出码 1、零写入", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-align-broken-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, "{ broken", "utf8");
    const config = { registry: registryPath, lanesDocFn: () => fixtureLanesDoc(join(dir, "lanes.json")) };
    const { lines, exitCode } = await runAlign([], config);
    assert.equal(exitCode, 1, "预览退出码 1");
    const out = lines.join("\n");
    assert.ok(out.includes("JSON 解析失败"), "语法坏如实报告");
    assert.ok(out.includes("不往下做"), "声明不往下做");
    assert.ok(out.includes(`SHA-256: ${shaOfFile(registryPath)}`), "坏文件也给哈希");
    assert.equal(bytesOf(registryPath).toString(), "{ broken", "零写入");
    // apply 同样拒绝（哈希过了但解析失败）
    const sha = shaOfFile(registryPath);
    const applied = await runAlign(["--apply", "--lane", "flash", "--expect-sha256", sha], config);
    assert.equal(applied.exitCode, 1);
    assert.ok(applied.lines.join("\n").includes("JSON 解析失败"), "apply 拒绝语法坏");
    assert.deepEqual(backupFiles(dir), [], "拒绝不产生备份");
    // 文件不存在
    const missing = await runAlign(["--registry", join(dir, "nope.json")], config);
    assert.equal(missing.exitCode, 1);
    assert.ok(missing.lines.join("\n").includes("私有注册表读不到"), "读不到如实报告");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── --apply 拒绝条件 ────────────────────────────────────────────────────────

test("0108 apply 拒绝：缺 --lane、缺哈希、哈希不符——整次拒绝什么都不写", async () => {
  const env = makeEnv();
  try {
    const before = bytesOf(env.registryPath);
    const sha = shaOfFile(env.registryPath);
    const cases = [
      { args: ["--apply"], why: "缺 --lane" },
      { args: ["--apply", "--lane", "flash"], why: "缺 --expect-sha256" },
      { args: ["--apply", "--lane", "flash", "--expect-sha256", "f".repeat(64)], why: "哈希不符" },
      { args: ["--apply", "--lane", "ghost", "--expect-sha256", sha], why: "不在车道表" },
      { args: ["--apply", "--lane", "fresh", "--expect-sha256", sha], why: "在车道表但不在私有注册表" },
    ];
    for (const c of cases) {
      const { lines, exitCode } = await runAlign(c.args, env.config);
      assert.equal(exitCode, 1, `${c.why}：退出码 1`);
      assert.ok(lines[0].startsWith("✖"), `${c.why}：固定文案拒绝（${lines[0]}）`);
      assert.equal(bytesOf(env.registryPath).toString(), before.toString(), `${c.why}：零写入`);
      assert.deepEqual(backupFiles(env.dir), [], `${c.why}：不产生备份`);
    }
    const all = (await runAlign(["--apply"], env.config)).lines.join("\n");
    assert.ok(all.includes("没有一键全修"), "缺 --lane 文案点名无一键全修");
    const hashWrong = (await runAlign(["--apply", "--lane", "flash", "--expect-sha256", "f".repeat(64)], env.config)).lines.join("\n");
    assert.ok(hashWrong.includes("重跑预览拿最新 SHA-256"), "哈希不符文案指回预览");
    const ghost = (await runAlign(["--apply", "--lane", "ghost", "--expect-sha256", sha], env.config)).lines.join("\n");
    assert.ok(ghost.includes("不在车道表"), "不在车道表文案");
    const fresh = (await runAlign(["--apply", "--lane", "fresh", "--expect-sha256", sha], env.config)).lines.join("\n");
    assert.ok(fresh.includes("不在私有注册表"), "不在私有注册表文案（不自动添加）");
  } finally {
    cleanup(env);
  }
});

test("0108 apply 拒绝：车道表与模板冲突（轴不一致 / 模板缺条目）——仓库自身冲突不猜", async () => {
  const conflictTemplate = () => {
    const t = fixtureTemplate();
    t.agents.flash = { ...t.agents.flash, model: { id: "bigmodel-api/模板里的另一个型号" } };
    return t;
  };
  const env = makeEnv({ template: conflictTemplate });
  try {
    const before = bytesOf(env.registryPath);
    const sha = shaOfFile(env.registryPath);
    const { lines, exitCode } = await runAlign(["--apply", "--lane", "flash", "--expect-sha256", sha], env.config);
    assert.equal(exitCode, 1);
    const out = lines.join("\n");
    assert.ok(out.includes("车道表与模板"), "冲突文案点名两侧");
    assert.ok(out.includes("仓库自身冲突"), "文案写明冲突性质");
    assert.equal(bytesOf(env.registryPath).toString(), before.toString(), "零写入");
    assert.deepEqual(backupFiles(env.dir), [], "不产生备份");
  } finally {
    cleanup(env);
  }
  const missingTemplate = () => {
    const t = fixtureTemplate();
    delete t.agents.sole;
    return t;
  };
  const env2 = makeEnv({ template: missingTemplate });
  try {
    const sha = shaOfFile(env2.registryPath);
    const { lines, exitCode } = await runAlign(["--apply", "--lane", "sole", "--expect-sha256", sha], env2.config);
    assert.equal(exitCode, 1);
    assert.ok(lines.join("\n").includes(`模板没有车道 "sole" 的接线条目`), "模板缺条目=不一致");
  } finally {
    cleanup(env2);
  }
});

test("0108 apply 拒绝：改后过不了现有校验（provider 块 align 修不掉）——不写盘", async () => {
  const env = makeEnv();
  try {
    const before = bytesOf(env.registryPath);
    const sha = shaOfFile(env.registryPath);
    const { lines, exitCode } = await runAlign(["--apply", "--lane", "ill", "--expect-sha256", sha], env.config);
    assert.equal(exitCode, 1);
    const out = lines.join("\n");
    assert.ok(out.includes(`车道 "ill" 对齐后过不了现有校验`), "改后校验拒绝文案");
    assert.ok(out.includes("provider is no longer supported"), "原因=normalizeAgent 同源文案");
    assert.ok(out.includes("什么都不写"), "明确声明零写入");
    assert.equal(bytesOf(env.registryPath).toString(), before.toString(), "零写入");
    assert.deepEqual(backupFiles(env.dir), [], "不产生备份");
  } finally {
    cleanup(env);
  }
});

// ── --apply 写侧：只改四轴与矩阵 modelId ─────────────────────────────────────

test("0108 apply：只改四轴与矩阵 modelId——本地字段与 _comment* 逐键原样，其余条目不动", async () => {
  const env = makeEnv();
  try {
    const beforeDoc = JSON.parse(bytesOf(env.registryPath).toString());
    const sha = shaOfFile(env.registryPath);
    const { lines, exitCode } = await runAlign(["--apply", "--lane", "flash", "--expect-sha256", sha], env.config);
    assert.equal(exitCode, 0, `apply 成功：${lines.join("\n")}`);
    const out = lines.join("\n");
    assert.ok(out.includes("✔ flash: 四轴已采用车道表接线；认证矩阵行 modelId 已同步"), "成功行同时报两处改动");
    assert.ok(backupFiles(env.dir).length === 1, "备份恰一个");
    assert.ok(/agents\.json\.bak-\d{8}T\d{6}Z$/.test(backupFiles(env.dir)[0]), "备份名=agents.json.bak-<UTC时间戳>");
    // 备份=原文件逐字节
    assert.equal(bytesOf(join(env.dir, backupFiles(env.dir)[0])).toString(), JSON.stringify(beforeDoc, null, 2) + "\n", "备份逐字节等于原文件");
    // 新文件
    const after = JSON.parse(readFileSync(env.registryPath, "utf8"));
    assert.deepEqual(Object.keys(after.agents), Object.keys(beforeDoc.agents), "条目键序不变（不增不删不重排）");
    assert.ok(!("fresh" in after.agents), "表有私无：不自动添加");
    assert.ok(after.agents.retired, "私有有表无：默认保留");
    assert.ok(after.agents.broken, "非法条目：不碰");
    // flash：四轴改了，其余逐键原样
    const bf = beforeDoc.agents.flash;
    const af = after.agents.flash;
    assert.equal(af.model.id, "bigmodel-api/GLM-F-NEW", "model.id 已采用");
    assert.equal(af.backend, "zcode", "backend 不变（车道表同值）");
    assert.equal(af.effort, undefined, "键面无 effort 泄漏");
    assert.equal(af.reasoning.effort, "max", "effort 保持车道表值");
    assert.equal(af.cwd, bf.cwd, "cwd（本地字段）逐字节原样");
    assert.equal(af.binary, bf.binary, "binary（本地字段）逐字节原样");
    assert.equal(af.sessionReuse, bf.sessionReuse, "sessionReuse（本地字段）逐字节原样");
    assert.deepEqual(af.env, bf.env, "env 块逐键原样（值不回显也不改）");
    assert.equal(af["_comment"], bf["_comment"], "_comment 逐键原样");
    assert.deepEqual(Object.keys(af), Object.keys(bf), "flash 键序不变");
    // 矩阵行：只改 modelId
    const brow = beforeDoc.certification.matrix[0];
    const arow = after.certification.matrix[0];
    assert.equal(arow.modelId, "bigmodel-api/GLM-F-NEW", "矩阵行 modelId 已同步");
    assert.equal(arow.label, brow.label, "label 原样");
    assert.equal(arow.profile, brow.profile, "profile 原样");
    assert.deepEqual(arow.drills, brow.drills, "drills 原样");
    assert.deepEqual(Object.keys(arow), Object.keys(brow), "矩阵行键序不变");
    // 其余条目逐键原样
    assert.deepEqual(after.agents.sole, beforeDoc.agents.sole, "sole 未选不动");
    assert.deepEqual(after.agents.retired, beforeDoc.agents.retired, "retired 不动");
    // 成功行给新 SHA
    assert.ok(out.includes(`新 SHA-256: ${shaOfFile(env.registryPath)}`), "输出新哈希");
  } finally {
    cleanup(env);
  }
});

test("0108 apply：轴删除语义——车道表 null 的 providerID/effort 从文件删除，不留占位 null", async () => {
  const env = makeEnv();
  try {
    const sha = shaOfFile(env.registryPath);
    const { exitCode } = await runAlign(["--apply", "--lane", "dsh-lane", "--expect-sha256", sha], env.config);
    assert.equal(exitCode, 0);
    const entry = JSON.parse(readFileSync(env.registryPath, "utf8")).agents["dsh-lane"];
    assert.equal(entry.model.id, "dsh-m");
    assert.equal(entry.model.providerID, "dsh-official", "providerID 采用车道表值");
    assert.equal(entry.reasoning, undefined, "effort 删除后空 reasoning 块整个删除（不留 {} 或 null）");
    assert.deepEqual(Object.keys(entry).sort(), ["backend", "credentialEnv", "cwd", "model"], "只余四轴对应键与本地字段");
  } finally {
    cleanup(env);
  }
});

test("0108 apply：轴已一致只改矩阵行 modelId（mate）——四轴键不重写", async () => {
  const env = makeEnv();
  try {
    const before = JSON.parse(bytesOf(env.registryPath).toString());
    const sha = shaOfFile(env.registryPath);
    const { lines, exitCode } = await runAlign(["--apply", "--lane", "mate", "--expect-sha256", sha], env.config);
    assert.equal(exitCode, 0);
    assert.ok(lines.join("\n").includes("✔ mate: 认证矩阵行 modelId 已同步"), "只报矩阵行改动");
    const after = JSON.parse(readFileSync(env.registryPath, "utf8"));
    assert.deepEqual(after.agents.mate, before.agents.mate, "条目逐键原样（轴已一致）");
    assert.equal(after.certification.matrix[1].modelId, "m-mate", "矩阵行 modelId 采用车道表值");
  } finally {
    cleanup(env);
  }
});

test("0108 apply：所选车道已全一致——未写盘、不产生备份", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-align-noop-"));
  try {
    const registryPath = join(dir, "agents.json");
    const doc = { agents: { flash: cleanRegistry(dir).agents.flash } };
    writeFileSync(registryPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    const lanesDoc = cleanLanesDoc(join(dir, "lanes.json"));
    const config = {
      registry: registryPath,
      lanesDocFn: () => lanesDoc,
      alignTemplatePath: writeTemplateFor(dir, lanesDoc),
      alignNowFn: () => FIXED_NOW,
    };
    const sha = shaOfFile(registryPath);
    const { lines, exitCode } = await runAlign(["--apply", "--lane", "flash", "--expect-sha256", sha], config);
    assert.equal(exitCode, 0);
    const out = lines.join("\n");
    assert.ok(out.includes("已与车道表一致"), "如实报告无改动");
    assert.ok(out.includes("未写盘"), "声明未写盘");
    assert.deepEqual(backupFiles(dir), [], "无改动不产生备份");
    assert.equal(bytesOf(registryPath).toString(), `${JSON.stringify(doc, null, 2)}\n`, "文件字节不变");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("0108 apply：备份同名已存在换名（-1），绝不覆盖旧备份", async () => {
  const env = makeEnv();
  try {
    const firstBytes = bytesOf(env.registryPath);
    const sha1 = shaOfFile(env.registryPath);
    await runAlign(["--apply", "--lane", "flash", "--expect-sha256", sha1], env.config);
    const firstBackup = join(env.dir, `agents.json.bak-${BACKUP_STAMP}`);
    assert.ok(existsSync(firstBackup), "第一次备份在场");
    assert.equal(bytesOf(firstBackup).toString(), firstBytes.toString(), "第一次备份=原文件");
    // 第二次 apply（sole 仍不一致）同时间戳 → 撞名 → 换名 -1，旧备份不被覆盖
    const soleBytes = bytesOf(env.registryPath);
    const sha2 = shaOfFile(env.registryPath);
    const { exitCode } = await runAlign(["--apply", "--lane", "sole", "--expect-sha256", sha2], env.config);
    assert.equal(exitCode, 0);
    const files = backupFiles(env.dir).sort();
    assert.deepEqual(files, [`agents.json.bak-${BACKUP_STAMP}`, `agents.json.bak-${BACKUP_STAMP}-1`], "撞名换 -1，两份备份并存");
    assert.equal(bytesOf(join(env.dir, files[0])).toString(), firstBytes.toString(), "旧备份逐字节不被覆盖");
    assert.equal(bytesOf(join(env.dir, files[1])).toString(), soleBytes.toString(), "新备份=第二次写前的文件");
  } finally {
    cleanup(env);
  }
});

// ── 诊断模块单元面（三类事实判据直测） ────────────────────────────────────────

test("0108 诊断：三类事实判据（wiring-mismatch/invalid/onlyIn）与 apply 结果对象", () => {
  const env = makeEnv();
  try {
    const diag = diagnoseRegistryAlignment({ registryPath: env.registryPath, lanesDoc: fixtureLanesDoc("fixture") });
    assert.ok(diag.ok);
    assert.equal(diag.sha256, shaOfFile(env.registryPath), "sha256=文件字节哈希");
    const flash = diag.entries.find((e) => e.id === "flash");
    assert.equal(flash.state, "wiring-mismatch");
    assert.equal(flash.certImpact, "identity", "model.id 变=换身份");
    assert.deepEqual(flash.diffs.map((d) => d.axis), ["modelId"], "逐轴 diff 只含差异轴");
    const sole = diag.entries.find((e) => e.id === "sole");
    assert.equal(sole.certImpact, "effort-only", "只差 effort=身份不变");
    assert.deepEqual(sole.diffs.map((d) => d.axis), ["effort"]);
    const dsh = diag.entries.find((e) => e.id === "dsh-lane");
    assert.equal(dsh.certImpact, "identity", "providerID 变=换身份");
    assert.equal(dsh.state, "wiring-mismatch");
    const ill = diag.entries.find((e) => e.id === "ill");
    assert.equal(ill.state, "invalid", "过不了现有校验=invalid");
    assert.match(ill.invalidReason, /provider is no longer supported/);
    assert.deepEqual(diag.onlyInTable, ["fresh"], "表有私无闭集");
    assert.deepEqual(diag.onlyInRegistry, ["retired"], "私有有表无闭集（broken 是非法条目不是合法差异）");
    const mate = diag.entries.find((e) => e.id === "mate");
    assert.equal(mate.state, "aligned");
    assert.deepEqual(mate.matrixMismatch, { rowModelId: "m-old-mate", laneModelId: "m-mate" }, "轴一致矩阵行滞后单独成事实");
    assert.equal(diag.entries.find((e) => e.id === "broken").state, "invalid");
  } finally {
    cleanup(env);
  }
});

test("0108 apply（模块面）：车道表结构未过 → 拒绝；非法哈希形状 → 拒绝", () => {
  const env = makeEnv();
  try {
    const badTable = { ...fixtureLanesDoc("fixture"), ok: false, issues: ['lane "x" 未知键 "evil"'] };
    const r = applyRegistryAlignment({
      registryPath: env.registryPath,
      lanesDoc: badTable,
      templatePath: env.templatePath,
      selectedLaneIds: ["flash"],
      expectSha256: shaOfFile(env.registryPath),
    });
    assert.equal(r.ok, false);
    assert.match(r.refusal, /车道表 config\/lanes\.json 结构校验未过/);
    const r2 = applyRegistryAlignment({
      registryPath: env.registryPath,
      lanesDoc: fixtureLanesDoc("fixture"),
      templatePath: env.templatePath,
      selectedLaneIds: ["flash"],
      expectSha256: "不是哈希",
    });
    assert.equal(r2.ok, false);
    assert.match(r2.refusal, /必须带 --expect-sha256/);
  } finally {
    cleanup(env);
  }
});

test("0108 默认模板路径指向仓库模板（仓库自身冲突检查的活体见证在场）", () => {
  assert.ok(DEFAULT_TEMPLATE_PATH.endsWith(join("config", "agents.example.json")));
  assert.ok(existsSync(DEFAULT_TEMPLATE_PATH), "仓库模板在场（活体 apply 依赖它做第二见证）");
});

// ── doctor lane_wiring 检查项 ───────────────────────────────────────────────

// doctor 惯例照 doctorPanelHold：不带 --registry 参数（走 config.registry 默认，
// 车道表启用——lane_wiring 门就是靠"非默认 --registry 停用"关的）；照
// skillLink.test.js 的 captureDoctorChecks 把 homeDir/runDir 注入临时目录。
async function captureDoctorChecks(config) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  const savedExitCode = process.exitCode;
  return waoDoctorCommand(["--format", "json", "--cwd", config.cwd], {
    stateDir: join(config.cwd, "wao"),
    runDir: join(config.cwd, "runs"), // 绝对路径：相对 "runs" 在 npm test 下会落到仓库根
    homeDir: config.cwd, // 主目录也给临时目录：doctor 不读真实用户主目录
    userEnvReader: async () => undefined,
    scopedEnvReader: async () => ({ status: "absent" }),
    skillSlotInventory: () => [],
    ...config,
  }).finally(() => {
    console.log = original;
    process.exitCode = savedExitCode;
  }).then(() => {
    const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
    assert.ok(jsonLine, "doctor json 输出在场");
    return JSON.parse(jsonLine);
  });
}

function makeDoctorRoot(registryDoc) {
  const cwd = mkdtempSync(join(tmpdir(), "wao-align-doctor-"));
  mkdirSync(join(cwd, ".wao"), { recursive: true });
  writeFileSync(join(cwd, ".wao", "project.md"), "", "utf8");
  for (const slot of ["decisions", "pipeline", "handoff", "runs", "migration"]) {
    mkdirSync(join(cwd, ".wao", slot), { recursive: true });
  }
  writeFileSync(join(cwd, "agents.json"), JSON.stringify(registryDoc, null, 2), "utf8");
  return cwd;
}

test("0108 doctor：接线不一致 → WARN + registry align 预览命令；合法差异 → INFO", async () => {
  const env = makeEnv();
  try {
    const cwd = makeDoctorRoot(JSON.parse(bytesOf(env.registryPath).toString()));
    try {
      const parsed = await captureDoctorChecks({
        cwd,
        registry: join(cwd, "agents.json"),
        loadLanesConfigFn: env.config.lanesDocFn,
        alignTemplatePath: env.templatePath,
      });
      const check = parsed.checks.find((c) => c.name === "lane_wiring");
      assert.ok(check, "lane_wiring 检查项在场");
      assert.equal(check.level, "warn", "接线不一致=WARN");
      assert.equal(check.pass, true, "WARN 不改 pass（advisory）");
      assert.ok(check.detail.includes(`车道 flash、sole、dsh-lane 的接线与私有注册表不一致`), "WARN detail 列出车道");
      assert.ok(check.detail.includes("--lane 派发会以 lane_wiring_mismatch 拒绝"), "WARN detail 写明派发后果");
      assert.ok(check.detail.includes("registry align --lane flash"), "WARN detail 给预览命令");
      assert.ok((check.fix ?? "").includes("--expect-sha256 <预览输出的 SHA-256>"), "fix 带 apply 用法");
      assert.ok((check.fix ?? "").includes("没有一键全修"), "fix 写明无一键全修");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  } finally {
    cleanup(env);
  }
  // 只有合法差异（轴全一致 + 一条表有私无）→ INFO
  const dir = mkdtempSync(join(tmpdir(), "wao-align-doctor-legal-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { flash: { backend: "zcode", cwd: dir, binary: join(dir, "zcode.cjs"), model: { id: "bigmodel-api/GLM-F-NEW" }, reasoning: { effort: "max" } } },
    }), "utf8");
    const cwd = makeDoctorRoot(JSON.parse(readFileSync(registryPath, "utf8")));
    try {
      const parsed = await captureDoctorChecks({
        cwd,
        registry: join(cwd, "agents.json"),
        loadLanesConfigFn: () => fixtureLanesDoc(join(dir, "lanes.json")),
        alignTemplatePath: join(dir, "template.json"),
      });
      const check = parsed.checks.find((c) => c.name === "lane_wiring");
      assert.ok(check, "合法差异也出检查项");
      assert.equal(check.level, "info", "只有合法差异=INFO");
      assert.ok(check.detail.includes("接线轴全部一致"), "INFO 写明接线轴全部一致");
      assert.ok(check.detail.includes("这些车道用 --lane 派发会被拒"), "INFO 写明表有私无的车道用 --lane 会被拒");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 全一致（单车道表 + 轴一致 + 矩阵行一致）→ 不产生条目（零 OK 噪音）
  const dir2 = mkdtempSync(join(tmpdir(), "wao-align-doctor-clean-"));
  try {
    const registryPath = join(dir2, "agents.json");
    writeFileSync(registryPath, JSON.stringify(cleanRegistry(dir2), null, 2), "utf8");
    const cwd = makeDoctorRoot(cleanRegistry(dir2));
    try {
      const parsed = await captureDoctorChecks({
        cwd,
        registry: join(cwd, "agents.json"),
        loadLanesConfigFn: () => cleanLanesDoc(join(dir2, "lanes.json")),
        alignTemplatePath: writeTemplateFor(dir2, cleanLanesDoc(join(dir2, "lanes.json"))),
      });
      assert.equal(parsed.checks.find((c) => c.name === "lane_wiring"), undefined, "全一致不产生 lane_wiring 条目");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("0108 doctor：非默认 --registry（车道表停用）不产 lane_wiring 检查项", async () => {
  const env = makeEnv();
  try {
    const cwd = makeDoctorRoot({ agents: {} });
    const other = join(cwd, "other-agents.json");
    writeFileSync(other, JSON.stringify({ agents: {} }), "utf8");
    try {
      const original = console.log;
      const lines = [];
      console.log = (...args) => { lines.push(args.map(String).join(" ")); };
      const savedExitCode = process.exitCode;
      try {
        await waoDoctorCommand(["--format", "json", "--cwd", cwd, "--registry", other], {
          registry: env.registryPath, // 默认注册表在别处 → 本次调用给了非默认 --registry
          stateDir: join(cwd, "wao"),
          runDir: join(cwd, "runs"),
          homeDir: cwd,
          userEnvReader: async () => undefined,
          scopedEnvReader: async () => ({ status: "absent" }),
          skillSlotInventory: () => [],
          loadLanesConfigFn: env.config.lanesDocFn,
        });
      } finally {
        console.log = original;
        process.exitCode = savedExitCode;
      }
      const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
      const parsed = JSON.parse(jsonLine);
      assert.equal(parsed.checks.find((c) => c.name === "lane_wiring"), undefined, "非默认 --registry：车道表停用，检查项缺席");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  } finally {
    cleanup(env);
  }
});

// ── lead_preflight 一行事实 ─────────────────────────────────────────────────

const EMPTY_BINDING = {
  bound: true,
  source: "lead_session",
  root: "D:/fixture-root",
  gitHead: null,
  dirty: false,
};

// preflight 的读盘缝全部注入（同 leadPreflightObservability 的 baseInput）：不建
// %LOCALAPPDATA%\wao、不读真实验证租约、不数本机运行桶、不读仓库车道表与画像。
function preflightInput(env, overrides) {
  return {
    workspaceBinding: EMPTY_BINDING,
    registryPath: env.registryPath,
    runDir: join(env.dir, "runs"),
    getRegistryInventoryFn: async () => ({ agents: [], issues: [], issuesTruncated: false }),
    listRunsFn: async () => ({ runs: [], matchedCount: 0 }),
    countProjectBucketsFn: () => 0,
    gateStatusFn: async () => ({ free: true }),
    laneProfilesFn: async () => null,
    ...overrides,
  };
}

test("0108 preflight：接线不一致 → observations 恰加一行事实（≤512）；worker 上下文不投影", async () => {
  const env = makeEnv();
  try {
    const line = "lane wiring: 车道 flash 的接线与私有注册表不一致——--lane 派发会拒（夹具注入）";
    const result = await aggregateLeadPreflight(preflightInput(env, {
      laneWiringFactFn: async () => line,
      workerContextFn: () => null,
    }));
    assert.ok(result.observations.some((o) => o === line), "注入的事实行原样进 observations");
    // worker 上下文：不投影
    const suppressed = await aggregateLeadPreflight(preflightInput(env, {
      laneWiringFactFn: async () => line,
      workerContextFn: () => ({ worker: true }),
    }));
    assert.ok(!suppressed.observations.some((o) => o.includes("lane wiring")), "worker 上下文省略整行");
    // 注入缝抛错 → 省略整行，preflight 不失败
    const resilient = await aggregateLeadPreflight(preflightInput(env, {
      laneWiringFactFn: async () => { throw new Error("boom"); },
      workerContextFn: () => null,
    }));
    assert.ok(!resilient.observations.some((o) => o.includes("lane wiring")), "fact 抛错省略整行");
    assert.equal(resilient.checkStatus.workers, "observed", "抛错不影响其余部分");
  } finally {
    cleanup(env);
  }
});

test("0108 preflight：默认事实函数——不一致时一行（≤512）、无不一致时 null", async () => {
  const env = makeEnv();
  try {
    const line = laneWiringMismatchFactLine({ registryPath: env.registryPath, lanesDoc: fixtureLanesDoc("fixture") });
    assert.ok(typeof line === "string" && line.length > 0, "有不一致 → 一行");
    assert.ok(line.length <= 512, `行长在 MCP observations 上限内（${line.length}）`);
    assert.ok(line.includes("flash、sole、dsh-lane"), "列出差异车道（前 3 条）");
    assert.ok(line.includes("lane_wiring_mismatch"), "点名拒绝码");
    assert.ok(line.includes("registry align --lane <id>"), "给预览命令");
    // 无不一致 → null
    const clean = mkdtempSync(join(tmpdir(), "wao-align-pf-clean-"));
    try {
      const cleanPath = join(clean, "agents.json");
      writeFileSync(cleanPath, JSON.stringify({ agents: { "pf-worker": { backend: "codex", cwd: clean, model: { id: "m" } } } }), "utf8");
      assert.equal(laneWiringMismatchFactLine({ registryPath: cleanPath, lanesDoc: fixtureLanesDoc("fixture") }), null, "无不一致 → null（不加行）");
      assert.equal(laneWiringMismatchFactLine({ registryPath: join(clean, "missing.json"), lanesDoc: fixtureLanesDoc("fixture") }), null, "读不到 → null（不加行）");
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  } finally {
    cleanup(env);
  }
});

// ── 第一轮会审修正（deepseek-flash，consult_20261102104640356nml3vf）─────────────

test("0108 applyAxesToEntry：车道表没有 model.id 时只删轴键，model 块其它键保留", () => {
  const entry = { backend: "kimi-web", model: { id: "old", providerID: "p", contextWindow: 123 }, reasoning: { effort: "high" } };
  applyAxesToEntry(entry, { backend: "kimi-web", modelId: null, providerID: null, effort: null });
  assert.deepEqual(entry.model, { contextWindow: 123 }, "非轴键 contextWindow 保留");
  assert.equal(entry.reasoning, undefined, "effort 删掉后空的 reasoning 块去掉");
  const bare = { backend: "kimi-web", model: { id: "old" } };
  applyAxesToEntry(bare, { backend: "kimi-web", modelId: null, providerID: null, effort: null });
  assert.equal(bare.model, undefined, "删空了才去掉整个 model 块");
});

test("0108 模板冲突的拒绝文案转义车道表轴值（换行不能伪造输出行）", () => {
  const env = makeEnv();
  try {
    const lanesDoc = fixtureLanesDoc(join(env.dir, "lanes.json"));
    lanesDoc.lanes[0].model.id = "evil\nforged line";
    const r = applyRegistryAlignment({
      registryPath: env.registryPath,
      lanesDoc,
      templatePath: env.templatePath,
      selectedLaneIds: ["flash"],
      expectSha256: shaOfFile(env.registryPath),
      nowFn: () => FIXED_NOW,
    });
    assert.equal(r.ok, false);
    assert.match(r.refusal, /车道表与模板在车道 "flash" 的接线轴不一致/);
    assert.ok(!/[\r\n]/.test(r.refusal), "拒绝文案不含原始换行");
  } finally {
    cleanup(env);
  }
});

test("0108 车道表有、私有注册表没有：--lane 派发确实被拒，doctor 与预览都如实说", async () => {
  const env = makeEnv();
  try {
    const lanesDoc = fixtureLanesDoc(join(env.dir, "lanes.json"));
    const registryAgents = fixtureRegistry(env.dir).agents;
    const r = resolveDispatchTarget({ lane: "fresh", role: "coder", lanesDoc, registryAgents, roleLibrary: ["coder"] });
    assert.equal(r.kind, "error");
    assert.equal(r.code, "lane_wiring_mismatch");
    assert.match(r.message, /照 config\/agents\.example\.json 的同名条目把它加进私有注册表/);
    const { lines } = await runAlign([], env.config);
    assert.ok(lines.some((l) => /lane fresh: .*用 --lane 派它会被拒/.test(l)), "预览写明表有私无的车道用 --lane 会被拒");
  } finally {
    cleanup(env);
  }
});

test("0108 车道表结构未过：诊断带 lanesTableOk=false，预览不说一致", async () => {
  const env = makeEnv({ registry: cleanRegistry });
  try {
    const bad = { ...cleanLanesDoc(join(env.dir, "lanes.json")), ok: false, issues: ["lanes[0]: 缺 id"] };
    const diag = diagnoseRegistryAlignment({ registryPath: env.registryPath, lanesDoc: bad });
    assert.equal(diag.ok, true);
    assert.equal(diag.lanesTableOk, false);
    const { lines } = await runAlign([], { ...env.config, lanesDocFn: () => bad });
    assert.ok(!lines.some((l) => /私有注册表与车道表一致/.test(l)), "车道表结构未过时不说一致");
  } finally {
    cleanup(env);
  }
});

// ── 第二轮会审注记（deepseek-flash，consult_20261102110553348n0qq9k）────────────

test("0108 车道表结构未过：doctor 报 WARN、preflight 事实行点名 lanes_config_invalid、预览不给 --apply 用法", async () => {
  const env = makeEnv({ registry: cleanRegistry });
  try {
    const bad = { ...cleanLanesDoc(join(env.dir, "lanes.json")), ok: false, issues: ["lanes[0]: 缺 id"] };
    const cwd = makeDoctorRoot(cleanRegistry(env.dir));
    try {
      const parsed = await captureDoctorChecks({
        cwd,
        registry: join(cwd, "agents.json"),
        loadLanesConfigFn: () => bad,
        alignTemplatePath: env.templatePath,
      });
      const check = parsed.checks.find((c) => c.name === "lane_wiring");
      assert.ok(check, "车道表结构未过也出检查项");
      assert.equal(check.level, "warn", "车道表结构未过=WARN");
      assert.ok(check.detail.includes("lanes_config_invalid"), "WARN 点名派发实际的拒绝码");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    const line = laneWiringMismatchFactLine({ registryPath: env.registryPath, lanesDoc: bad });
    assert.ok(typeof line === "string" && line.includes("lanes_config_invalid"), "事实行点名 lanes_config_invalid");
    assert.ok(!line.includes("lane_wiring_mismatch"), "不报派发不会给的拒绝码");
    assert.ok(line.length <= 512, `行长在上限内（${line.length}）`);
    const { lines } = await runAlign([], { ...env.config, lanesDocFn: () => bad });
    assert.ok(!lines.some((l) => l.startsWith("--apply 用法")), "不给一条会被拒的用法");
    assert.ok(lines.some((l) => l.includes("--apply 现在会被拒")), "写明 --apply 会被拒");
  } finally {
    cleanup(env);
  }
});

test("0108 apply 端到端：车道表没有 model.id、条目 model 块带 contextWindow——校验拒绝，什么都不写", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-align-noid-"));
  try {
    const lanesDoc = {
      ok: true,
      path: join(dir, "lanes.json"),
      sha256: "d".repeat(64),
      issues: [],
      lanes: [{ id: "h", backend: "codex", reasoning: { effort: null }, aliases: {} }],
    };
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, `${JSON.stringify({ agents: { h: { backend: "codex", cwd: dir, model: { id: "m-old", contextWindow: 1000 } } } }, null, 2)}\n`, "utf8");
    const templatePath = writeTemplateFor(dir, lanesDoc);
    const before = bytesOf(registryPath);
    const { lines, exitCode } = await runAlign(["--apply", "--lane", "h", "--expect-sha256", shaOfFile(registryPath)], {
      registry: registryPath,
      lanesDocFn: () => lanesDoc,
      alignTemplatePath: templatePath,
      alignNowFn: () => FIXED_NOW,
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.join("\n").includes(`车道 "h" 对齐后过不了现有校验`), "留下的 model 块没有 id，校验拒绝");
    assert.equal(bytesOf(registryPath).toString(), before.toString(), "零写入");
    assert.deepEqual(backupFiles(dir), [], "不产生备份");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── sol 会审修正（consult_20261102121904105805xmd）────────────────────────────

test("0108 apply 拒绝：整份重写会改变未点名条目的写法（1e400、1.0、重复键）——什么都不写", async () => {
  for (const [label, untouched] of [
    ["超范围数字", '"limit": 1e400'],
    ["数字写法 1.0", '"limit": 1.0'],
    ["重复键", '"limit": 1, "limit": 2'],
  ]) {
    const env = makeEnv();
    try {
      const doc = JSON.parse(bytesOf(env.registryPath).toString());
      const text = JSON.stringify(doc, null, 2).replace('"retired": {', `"retired": {\n      ${untouched},`);
      writeFileSync(env.registryPath, `${text}\n`, "utf8");
      const before = bytesOf(env.registryPath);
      const { lines, exitCode } = await runAlign(["--apply", "--lane", "sole", "--expect-sha256", shaOfFile(env.registryPath)], env.config);
      assert.equal(exitCode, 1, `${label}：拒绝`);
      assert.ok(lines.join("\n").includes("整份重写会改变写法"), `${label}：拒绝文案说明原因`);
      assert.equal(bytesOf(env.registryPath).toString(), before.toString(), `${label}：零写入`);
      assert.deepEqual(backupFiles(env.dir), [], `${label}：不产生备份`);
    } finally {
      cleanup(env);
    }
  }
});

test("0108 rewritesLosslessly：只差空白（制表符缩进、CRLF）算无损，字符串里的空白照算", () => {
  const doc = { agents: { a: { cwd: "C:/x y", args: ["--a", "b"] } } };
  const tabbed = JSON.stringify(doc, null, "\t").replace(/\n/g, "\r\n");
  assert.equal(rewritesLosslessly(tabbed, doc), true, "缩进与换行不同仍算无损");
  assert.equal(rewritesLosslessly('{"agents":{"a":{"cwd":"C:/x y","args":["--a","b"]}}}', doc), true);
  assert.equal(rewritesLosslessly('{"agents":{"a":{"cwd":"C:/x\\u0020y","args":["--a","b"]}}}', doc), false, "转义写法不同不算无损");
});

test("0108 apply 拒绝：改后校验的原因含行分隔符也转义（不伪造输出行）", async () => {
  const env = makeEnv();
  try {
    const doc = JSON.parse(bytesOf(env.registryPath).toString());
    doc.agents.sole.waitTimeout = "x\u2028forged";
    writeFileSync(env.registryPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    const { lines, exitCode } = await runAlign(["--apply", "--lane", "sole", "--expect-sha256", shaOfFile(env.registryPath)], env.config);
    assert.equal(exitCode, 1);
    const out = lines.join("\n");
    assert.ok(out.includes("对齐后过不了现有校验"), "走改后校验拒绝");
    assert.ok(!/[\u2028\u2029\r]/.test(out), "输出不含原始行分隔符");
  } finally {
    cleanup(env);
  }
});

test("0108 预览与读失败：路径里的行分隔符也转义（不伪造输出行）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-align-path-"));
  try {
    const registryPath = join(dir, "agents\u2028x.json");
    writeFileSync(registryPath, `${JSON.stringify(cleanRegistry(dir), null, 2)}\n`, "utf8");
    const config = { registry: registryPath, lanesDocFn: () => cleanLanesDoc(join(dir, "lanes\u2028y.json")) };
    const preview = await runAlign([], config);
    assert.ok(!/[\u2028\u2029]/.test(preview.lines.join("\n")), "预览输出不含原始行分隔符");
    const missing = await runAlign([], { ...config, registry: join(dir, "missing\u2028z.json") });
    assert.equal(missing.exitCode, 1);
    assert.ok(!/[\u2028\u2029]/.test(missing.lines.join("\n")), "读失败输出不含原始行分隔符");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
