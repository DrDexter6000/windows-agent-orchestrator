// cli-registry.test.js
//
// cli.test.js 拆分（TD-138 全量提速批，2026-11-01）——本文件承载 registry 与
// wao 子命令面：registry validate·list、worktree list·remove、declare·stage
// （含 R9 panel 字段）、顶层 wao 命名空间守卫、TD-319 CLI 报错转义。共用辅助
// 见 _cliTestHelpers.mjs；用例原样搬运自 cli.test.js（数量与断言不变）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRegistry as readRegistryFile } from "../../src/registry.js";
import { rmrfRetry } from "../_rmrfHelper.mjs";
import { COMMAND_NAMES } from "../../src/cliHelp.js";
import { captureLog, runCliOnPathNode, makeDoctorPanelFixture, doctorPanelRun } from "./_cliTestHelpers.mjs";

test("registry validate: prependArgs 必须是数组", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-registry-validate-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bad_claude: {
          backend: "claude-code",
          cwd: "D:/projects/app",
          prependArgs: "--bad",
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      // R23-D 隔离（存量裸调清扫）：advisory 读 reliability-summary.json，
      // 裸调会回落到仓库相对 runs/ 默认值 → 主仓真实台账；--run-dir 必须与
      // "validate" 同行（staticRunsGuard validate-no-run-dir 单行约定）。
      "registry", "validate", "--run-dir", join(dir, "runs-none"),
      "--registry", registryPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /prependArgs must be an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 0065（0045 §1.2 终局）：seatRole 弃用 advisory + 对抗性派生 ────────────────

test("0065: registry validate 对在场 seatRole 出弃用 advisory——不拒载、不回显值", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-registry-seatrole-dep-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        legacy_seat: { backend: "claude-code", cwd: ".", seatRole: "adversarial" },
        legacy_bad_value: { backend: "claude-code", cwd: ".", seatRole: 42 },
        clean_seat: { backend: "claude-code", cwd: "." },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [
      "src/cli.js", "registry", "validate", "--run-dir", join(dir, "runs-none"),
      "--registry", registryPath,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, "字段在场不拒载（迁移期兼容——validate 仍 valid）");
    assert.match(result.stdout, /legacy_seat: seatRole 已废弃（0045 §1\.2 终局：对抗性按审者×作者车道派生；读取面忽略）/,
      "弃用 advisory 固定文案");
    assert.match(result.stdout, /legacy_bad_value: seatRole 已废弃/, "坏值同样 advisory（闭集校验已删除）");
    assert.ok(!result.stdout.includes("legacy_seat: seatRole 已废弃（0045 §1.2 终局：对抗性按审者×作者车道派生；读取面忽略）——adversarial"),
      "不回显字段值（固定安全形状）");
    assert.ok(!/clean_seat[^\n]*seatRole/.test(result.stdout), "无字段的席位无 advisory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("0065: wao stage --reviewed-run 对抗性派生——同车道回避违反大声提示（advisory 不阻断）+ 跨车道通过", () => {
  const { dir, registry } = makePanelFixture("wao-stage-derived-");
  // 派生用 registry：coder_hq 与被审作者同车道（claude-code + glm-5.3 同轴）；
  // auditor=跨车道（claude-code + claude-opus-5）。
  writeFileSync(registry, JSON.stringify({
    agents: {
      coder_hq: { backend: "claude-code", cwd: ".", model: { id: "glm-5.3" } },
      auditor: { backend: "claude-code", model: { id: "claude-opus-5" }, cwd: "." },
    },
  }), "utf8");
  // 被审 run 转录：作者=coder_hq 的车道（claude-code + glm-5.3 模型轴；providerKey
  // =决定 0106 起的现行恒值 null——夹具用同值保证与席位侧 registry 四元组可比）。
  const runDir = join(dir, "runs");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run_author1.jsonl"), JSON.stringify({
    type: "run.started", backend: "claude-code", model: { id: "glm-5.3" },
    reasoning: { effort: "high" }, providerKey: null,
    runId: "run_author1", agentId: "coder_hq", seq: 1, ts: "2026-10-12T00:00:00.000Z", cwd: dir,
  }) + "\n", "utf8");
  try {
    // (1) 席位与作者同车道（作者自审反例）——指纹比对（非 agentId 字符串）。
    const viol = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "4",
      "--task", "交付验收（作者自审反例）",
      "--panel-seats", "coder_hq",
      "--reviewed-run", "run_author1",
      "--registry", registry, "--cwd", dir, "--run-dir", runDir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
    assert.equal(viol.status, 0, "回避违反是 advisory——登记成功（不阻断）");
    const outV = JSON.parse(viol.stdout);
    assert.equal(outV.panel.derived.authorContext, "derived");
    assert.equal(outV.panel.derived.seats[0].authorRelation, "same_lane", "同 registry 轴=同车道（指纹比对）");
    assert.deepEqual(outV.panel.derived.authorAvoidanceViolations, ["coder_hq"]);
    assert.match(viol.stderr, /⚠ 回避违反（0019 §3）：席位 coder_hq 与被审产出作者同车道/, "大声提示");
    assert.match(outV.panel.derived.basis, /registry 当前配置事实/, "来源声明（sol 条款）");
    // (2) 跨车道席位（auditor 模型轴 claude-opus-5 ≠ 作者 glm-5.3）。
    const ok = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "4",
      "--task", "交付验收（跨车道正例）",
      "--panel-seats", "auditor",
      "--reviewed-run", "run_author1",
      "--registry", registry, "--cwd", dir, "--run-dir", runDir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
    assert.equal(ok.status, 0);
    const outO = JSON.parse(ok.stdout);
    assert.equal(outO.panel.derived.seats[0].authorRelation, "different_lane", "模型轴不同=不同车道指纹");
    assert.equal(outO.panel.derived.seats[0].familyVsAuthors, "cross", "GLM×Claude 跨族附注");
    assert.deepEqual(outO.panel.derived.authorAvoidanceViolations, []);
    assert.ok(!/回避违反/.test(ok.stderr), "无违反不提示");
    // (3) 门：--reviewed-run 必须与 --panel-seats 同给。
    const bare = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "4",
      "--task", "x", "--reviewed-run", "run_author1",
      "--registry", registry, "--cwd", dir, "--run-dir", runDir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /--reviewed-run 只与 --panel-seats 同给/);
    // (4) 作者不可读 → not_provided 三态如实。
    const ghost = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "4",
      "--task", "y", "--panel-seats", "auditor",
      "--reviewed-run", "run_nonexistent",
      "--registry", registry, "--cwd", dir, "--run-dir", runDir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
    assert.equal(ghost.status, 0);
    assert.equal(JSON.parse(ghost.stdout).panel.derived.authorContext, "unreadable_or_missing");
    // 正文/frontmatter 留痕：派生事实段落写进 stage 文件。
    const stageFiles = readdirSync(join(dir, ".wao", "pipeline"));
    const withDerived = stageFiles.filter((f) => f.endsWith(".md")).find((f) =>
      readFileSync(join(dir, ".wao", "pipeline", f), "utf8").includes("panel_derived_json"));
    assert.ok(withDerived, "frontmatter 含 panel_derived_json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TD-79（Python 环境隔离：registry env 字段校验）─────────────────────────
test("TD-79: registry validate 拒绝非对象的 env 字段", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-registry-env-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bad_researcher: {
          backend: "claude-code",
          cwd: "D:/projects/app",
          env: "should-be-object", // 非 object → 应被拒
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      // R23-D 隔离（存量裸调清扫）：advisory 读 reliability-summary.json，
      // 裸调会回落到仓库相对 runs/ 默认值 → 主仓真实台账；--run-dir 必须与
      // "validate" 同行（staticRunsGuard validate-no-run-dir 单行约定）。
      "registry", "validate", "--run-dir", join(dir, "runs-none"),
      "--registry", registryPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /env must be an object/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-79: registry validate 拒绝 env 值非字符串的 env 字段", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-registry-env-val-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bad_researcher: {
          backend: "claude-code",
          cwd: "D:/projects/app",
          env: { PIP_REQUIRE_VIRTUALENV: 123 }, // 值非 string → 应被拒
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      // R23-D 隔离（存量裸调清扫）：advisory 读 reliability-summary.json，
      // 裸调会回落到仓库相对 runs/ 默认值 → 主仓真实台账；--run-dir 必须与
      // "validate" 同行（staticRunsGuard validate-no-run-dir 单行约定）。
      "registry", "validate", "--run-dir", join(dir, "runs-none"),
      "--registry", registryPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /env\.\w+ value must be a string/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-104: registry validate rejects secret-like agent.env keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-registry-secret-env-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        bad_worker: {
          backend: "claude-code",
          cwd: "D:/projects/app",
          env: { SESSION_TOKEN: "test-secret-registry-value" },
        },
      },
    }), "utf8");

    const result = spawnSync(process.execPath, [
      "src/cli.js",
      // R23-D 隔离（存量裸调清扫）：advisory 读 reliability-summary.json，
      // 裸调会回落到仓库相对 runs/ 默认值 → 主仓真实台账；--run-dir 必须与
      // "validate" 同行（staticRunsGuard validate-no-run-dir 单行约定）。
      "registry", "validate", "--run-dir", join(dir, "runs-none"),
      "--registry", registryPath,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /secret-like.*inherited provider credential channel/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-22: worktree list 列出所有 worktree（含主仓 + 新增）", () => {
  // 真实 git 仓 + worktree，验证 CLI `worktree list` 输出。
  const dir = mkdtempSync(join(tmpdir(), "wao-wt-list-"));
  try {
    // 建一个 git 仓
    execSync("git init -q", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "a.txt"), "a");
    execSync("git add -A && git commit -q -m init", { cwd: dir, stdio: "pipe" });
    // 建一个 worktree
    execSync("git worktree add -q ../wt-extra", { cwd: dir, stdio: "pipe" });

    const result = spawnSync(process.execPath, [
      "src/cli.js", "worktree", "list", "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 0, `worktree list 应成功: ${(result.stderr||"").slice(0,200)}`);
    const out = result.stdout;
    // 至少列出主仓 + 新增 worktree（JSON 数组或每行一个）
    assert.ok(/wt-extra/.test(out), "worktree list 应包含新增的 wt-extra");
  } finally {
    // 清理 worktree 引用（删 dir 前先 detach）
    try { execSync("git worktree remove --force ../wt-extra", { cwd: dir, stdio: "ignore" }); } catch {}
    rmSync(dir, { recursive: true, force: true });
    try { rmSync(join(dir, "..", "wt-extra"), { recursive: true, force: true }); } catch {}
  }
});

test("TD-22: worktree remove <path> 删除指定 worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wt-rm-"));
  const wtPath = join(dir, "..", "wt-to-remove");
  try {
    execSync("git init -q", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "a.txt"), "a");
    execSync("git add -A && git commit -q -m init", { cwd: dir, stdio: "pipe" });
    execSync("git worktree add -q ../wt-to-remove", { cwd: dir, stdio: "pipe" });

    const result = spawnSync(process.execPath, [
      "src/cli.js", "worktree", "remove", wtPath, "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8" });

    assert.equal(result.status, 0, `worktree remove 应成功: ${(result.stderr||"").slice(0,200)}`);
    // worktree 目录应已删除
    assert.ok(!existsSync(wtPath), "worktree 目录应已被删除");
  } finally {
    try { execSync("git worktree remove --force ../wt-to-remove", { cwd: dir, stdio: "ignore" }); } catch {}
    rmSync(dir, { recursive: true, force: true });
    try { rmSync(wtPath, { recursive: true, force: true }); } catch {}
  }
});

// --- N1 修复：registry list 合并认证状态列 ---
test("registry list 合并认证状态列（summary 存在时显示 cert 状态）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reglist-cert-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_hq:   { backend: "claude-code", binary: "/x", cwd: dir, model: { id: "glm-5.2" } },
        researcher: { backend: "claude-code", binary: "/x", cwd: dir, model: { id: "deepseek-v4-flash" } },
      },
    }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true, force: true });
    writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({
      workers: {
        coder_hq:   { status: "certified" },
        researcher: { status: "conditional" },
      },
    }));

    const out = runCliOnPathNode(`registry list --registry ${registryPath} --run-dir ${runDir}`);
    const lines = out.trim().split(/\r?\n/);
    assert.equal(lines.length, 3, "应输出表头 + 2 个 agent 行");
    assert.equal(lines[0], "id\tbackend\tmodel\tcertification\tcwd", "首行应为表头（tab 分隔）");
    const hqLine = lines.find((l) => l.startsWith("coder_hq"));
    assert.ok(hqLine, "应有 coder_hq 行");
    assert.match(hqLine, /certified/, "coder_hq 应显示 certified");
    const resLine = lines.find((l) => l.startsWith("researcher"));
    assert.match(resLine, /conditional/, "researcher 应显示 conditional");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry list 无 summary 时不报错（cert 列显示 -）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reglist-nosum-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_hq: { backend: "claude-code", binary: "/x", cwd: dir, model: { id: "glm-5.2" } } },
    }), "utf8");

    const out = runCliOnPathNode(`registry list --registry ${registryPath} --run-dir ${join(dir, "runs-none")}`);
    // R23-D Lead 补全（auditor F6）：隔离 run-dir 使标题为真（此前在主仓读到真实
    // 台账，cert 列实为 certified，靠 .*- 匹配 temp 目录连字符假绿）；断言收紧为精确列。
    assert.match(out.trim(), /^coder_hq\tclaude-code\tglm-5\.2\t-\t/m, "无 summary 时 cert 列恰为 -（隔离 run-dir 下标题为真）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WF-8: registry list 对 kimi/codex 默认模型显示非 '-'", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reglist-default-model-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_mm: { backend: "kimi-code", cwd: dir },
        tester: { backend: "codex", cwd: dir, args: [] },
      },
    }), "utf8");

    const out = runCliOnPathNode(`registry list --registry ${registryPath} --run-dir ${join(dir, "runs-none")}`);
    const lines = out.trim().split(/\r?\n/);
    for (const id of ["coder_mm", "tester"]) {
      const line = lines.find((l) => l.startsWith(`${id}\t`));
      assert.ok(line, `${id} 应列出`);
      const fields = line.split("\t");
      assert.notEqual(fields[2], "-", `${id} 的 model 列不得再显示 '-'`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F17: registry list --format json 输出可解析 JSON（dogfood round 4 实证 bug）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-reglist-json-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_hq: { backend: "claude-code", binary: "/x", cwd: dir, model: { id: "glm-5.2" } },
        researcher: { backend: "claude-code", binary: "/x", cwd: dir, model: { id: "deepseek-v4-flash" } },
      },
    }), "utf8");

    const out = runCliOnPathNode(`registry list --registry ${registryPath} --run-dir ${dir} --format json`);
    // 必须是合法 JSON 数组（原 bug：接受 --format json 但仍输出 tab 表格，JSON.parse 会抛）
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed), "输出应是 JSON 数组");
    assert.equal(parsed.length, 2, "含 2 个 agent");
    const hq = parsed.find((a) => a.id === "coder_hq");
    assert.ok(hq, "含 coder_hq");
    assert.equal(hq.backend, "claude-code", "backend 字段正确");
    assert.equal(hq.model, "glm-5.2", "model 字段正确");
    assert.equal(hq.certification, null, "无 summary（--run-dir 指向空目录）时 certification 为 null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-87: registry validate 对 kimi-code 配 tokenBudget 给 ⚠ warning（静默无效陷阱）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-regval-kimi-budget-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        coder_mm: { backend: "kimi-code", cwd: dir, tokenBudget: 100000 },
      },
    }), "utf8");

    const out = runCliOnPathNode(`registry validate --registry ${registryPath} --run-dir ${join(dir, "runs-none")}`);
    // validate 通过（✔），但有 ⚠ warning 提示 tokenBudget 对 kimi 无效
    assert.match(out, /✔\s*coder_mm/, "kimi worker validate 通过");
    assert.match(out, /⚠.*kimi-code.*tokenBudget.*不生效/, "配了 tokenBudget 的 kimi worker 应有 ⚠ warning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-89 (M11-5 resolved): registry validate accepts systemPrompt for all backends, fail-closed on bad role file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-regval-sysprompt-"));
  try {
    // M11-5 后：所有三个 process backend 都消费 systemPrompt。旧的"kimi/codex 不消费
    // systemPrompt"warning 已删除。registry validate 用共享加载器对所有配 systemPrompt
    // 的 backend 统一 fail-closed 验证（缺失/目录/空/超限/非法 UTF-8/NUL）。
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        // kimi-code + valid systemPrompt → 应 pass（不再 warn）
        // TD-242（2026-10-09）：coder_mm.md 已随 0046 席位矩阵重构除名，夹具
        // 改指向现行角色文件 coder.md（陈旧引用是本测试慢性红的真凶——非 PATH）。
        coder_mm: { backend: "kimi-code", cwd: dir, systemPrompt: "config/roles/coder.md" },
        // codex + valid systemPrompt → 应 pass（不再 warn）
        tester: { backend: "codex", cwd: dir, systemPrompt: "config/roles/tester.md" },
        // claude-code + valid systemPrompt → 应 pass
        researcher: { backend: "claude-code", cwd: dir, systemPrompt: "config/roles/researcher.md" },
      },
    }), "utf8");

    const out = runCliOnPathNode(`registry validate --registry ${registryPath} --run-dir ${join(dir, "runs-none")}`);
    // 三个都 pass（无 ✖，无旧 ⚠ "不消费 systemPrompt" warning）
    assert.match(out, /✔\s*coder_mm/, "kimi-code + systemPrompt passes");
    assert.match(out, /✔\s*tester/, "codex + systemPrompt passes");
    assert.match(out, /✔\s*researcher/, "claude-code + systemPrompt passes");
    // 不再有"不消费 systemPrompt"warning
    assert.doesNotMatch(out, /不消费 systemPrompt/, "old TD-89 warning removed");
    assert.match(out, /all valid/, "registry fully valid");

    // fail-closed: 非法角色文件（缺失）→ ✖ + exit 1
    const badRegistryPath = join(dir, "agents-bad.json");
    writeFileSync(badRegistryPath, JSON.stringify({
      agents: {
        bad_worker: { backend: "codex", cwd: dir, systemPrompt: join(dir, "nonexistent-role.md") },
      },
    }), "utf8");
    // registry validate exits 1 when there are errors — use spawnSync to capture non-zero exit.
    // R23-D 隔离：--run-dir 指向空目录（同上，裸调会读主仓真实台账）。
    const badResult = spawnSync(process.execPath,
      ["src/cli.js", "registry", "validate", "--run-dir", join(dir, "runs-none"), "--registry", badRegistryPath],
      { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(badResult.status, 0, "registry validate exits non-zero on bad role");
    assert.match(badResult.stdout, /✖\s*bad_worker.*角色合同无效/, "missing role file → fail-closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-90: getWaoCliPath 在 win32 返回 .cmd shim（worker 不踩 v24 guard）", async () => {
  // dogfood round 7 实证：worker 收到的 $WAO_CLI 原指向裸 src/cli.js，worker shell
  // 默认 node v24，直接 `node $WAO_CLI` 触发 nodeVersionGuard 被拒。TD-90 修复让
  // Windows 上 getWaoCliPath 返回 scripts/wao-cli.cmd（内部用 v22 node 绝对路径）。
  const { getWaoCliPath } = await import("../../src/waoCliPath.js");
  const p = getWaoCliPath();
  if (process.platform === "win32") {
    // Windows：必须是 .cmd shim，且该文件真实存在
    assert.ok(p.endsWith("wao-cli.cmd"), `win32 上 WAO_CLI 应指向 .cmd shim，实际：${p}`);
    assert.ok(existsSync(p), `wao-cli.cmd 文件必须存在：${p}`);
  } else {
    // 非 Windows：回退裸 cli.js（无 v24 guard 问题）
    assert.ok(p.endsWith("cli.js"), `非 win32 应回退 cli.js，实际：${p}`);
  }
});

// TD-52 守卫：help 必须列出 main() 真实路由的全部命令族。
// canonical runner（scripts/canonical-test.mjs）在子进程 env 注入 WAO_SKIP_VERSION_GUARD=1；
// 且 help 本身豁免 version guard——故 help 在测试里可跑。
// 防止 printHelp 与代码漂移（首装 e2e 摩擦日志 F1：曾漏列 dashboard/diagnose/wao 族/daemon supervise）。
test("help: 列出所有 main() 真实路由的命令族（防 help 与代码漂移，TD-52）", () => {
  const out = execSync("node src/cli.js help", { cwd: process.cwd(), encoding: "utf8" });
  assert.match(out, /run <agentId> .*--prompt-file FILE/, "help 必须列出 run --prompt-file FILE");
  assert.match(out, /--scorecard-rules-file FILE/, "help 必须列出 --scorecard-rules-file FILE");
  // 第 67a 批：TD-65 的 status --format json 幻影曾整批删除；第 78 批 --format
  // 成为真实实现（line 单行出口；json 依 results.md 契约与缺省逐字节相同），
  // 语法段必须钉住两个合法值（值层由 cli-runs.test.js 的 b78 系列钉）。
  assert.match(out, /^  status <runId> \[--format json\|line\] \[--run-dir DIR\]/m, "help 必须列出 status 与其 --format json|line 旗标");
  // runs 族（M8-2/3 新增，曾漏）
  assert.match(out, /runs dashboard/, "help 必须列出 runs dashboard（main() 路由）");
  assert.match(out, /runs diagnose/, "help 必须列出 runs diagnose（main() 路由）");
  assert.match(out, /runs wait/, "help 必须列出 runs wait（TD-109 runs wait 命令）");
  assert.doesNotMatch(out, /runs forecast/, "已移除的 forecast 不得继续出现在 help");
  // wao 族（整族曾缺席）
  assert.match(out, /wao init/, "help 必须列出 wao init");
  assert.match(out, /wao decision/, "help 必须列出 wao decision");
  assert.match(out, /wao declare/, "help 必须列出 wao declare（TD-82 自做声明）");
  assert.match(out, /wao stage/, "help 必须列出 wao stage（TD-83 阶段声明）");
  assert.match(out, /wao ask/, "help 必须列出 wao ask（TD-88 快捷派工）");
  assert.match(out, /wao handoff/, "help 必须列出 wao handoff");
  assert.match(out, /wao doctor/, "help 必须列出 wao doctor");
  // daemon 补充族（P5/TD-45/46，曾漏）
  assert.match(out, /daemon supervise/, "help 必须列出 daemon supervise");
  assert.match(out, /daemon supervisor/, "help 必须列出 daemon supervisor");
  assert.match(out, /daemon health/, "help 必须列出 daemon health");
  // mcp 族（M10 P0-1 workspace activation）
  assert.match(out, /mcp bind/, "help 必须列出 mcp bind（M10 P0-1 workspace activation）");
  assert.match(out, /mcp status/, "help 必须列出 mcp status");
  assert.match(out, /mcp unbind/, "help 必须列出 mcp unbind");
  // TD-86（D2 A1）：六命令 --format json 能力入 help（新增断言，防 help 与实现漂移）。
  assert.match(out, /registry validate [^\n]*--format json/, "help 必须标注 registry validate --format json（TD-86）");
  assert.match(out, /runs list [^\n]*--format json/, "help 必须标注 runs list --format json（TD-86）");
  assert.match(out, /runs summary [^\n]*--format json/, "help 必须标注 runs summary --format json（TD-86）");
  assert.match(out, /runs grep <pattern> [^\n]*--format json/, "help 必须标注 runs grep --format json（TD-86）");
  assert.match(out, /wao decision list \[--format json\]/, "help 必须标注 wao decision list --format json（TD-86）");
  assert.match(out, /wao handoff read <role> \[--format json\]/, "help 必须标注 wao handoff read --format json（TD-86）");
  // TD-112（D2 A4）：collect --final（最终 assistant 文本一屏出口）入 help。
  assert.match(out, /collect <runId> [^\n]*--final/, "help 必须列出 collect --final（TD-112）");
});

test("TD-82: wao declare 写入声明 + wao declare（裸）列出汇总（端到端）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-declare-e2e-"));
  try {
    // 先 init .wao/（declare 依赖 decisions/ 槽位）
    spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    // 写一条声明
    const r = spawnSync(process.execPath, [
      "src/cli.js", "wao", "declare",
      "--task", "改了 help 文本",
      "--reason", "too-small",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, `declare 应成功，stderr=${r.stderr}`);
    assert.match(r.stdout, /"declared": true/, "输出 declared:true");
    assert.match(r.stdout, /"reason": "too-small"/, "输出 reason");
    // 裸 wao declare 列出汇总
    const r2 = spawnSync(process.execPath, ["src/cli.js", "wao", "declare", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.match(r2.stdout, /"count": 1/, "汇总 count:1");
    assert.match(r2.stdout, /"too-small": 1/, "byReason 含 too-small:1");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-82: wao declare 非法 reason fail-fast（枚举约束）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-declare-bad-"));
  try {
    spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    const r = spawnSync(process.execPath, [
      "src/cli.js", "wao", "declare",
      "--task", "x", "--reason", "因为我想",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.notEqual(r.status, 0, "非法 reason 必须 fail-fast");
    assert.match(r.stderr, /reason 必须是枚举值/, "stderr 解释合法枚举值");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-83: wao stage 写入声明 + wao stage（裸）列出 pipeline 缺口（端到端）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stage-e2e-"));
  try {
    spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    // 走阶段 1（spec）+ 阶段 3（派发）——典型"敷衍"模式：跳了 2/4/5/6
    const r = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "1",
      "--task", "起草 auth 契约",
      "--artifacts", "docs/01-prd.md",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, `stage 1 应成功，stderr=${r.stderr}`);
    assert.match(r.stdout, /"staged": true/, "输出 staged:true");
    assert.match(r.stdout, /"stage": 1/, "输出 stage:1");

    const r2 = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "3",
      "--task", "派发实现",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r2.status, 0, `stage 3 应成功`);

    // 裸 wao stage 列出 pipeline 进度 + 缺口
    const r3 = spawnSync(process.execPath, ["src/cli.js", "wao", "stage", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.match(r3.stdout, /"count": 2/, "声明 2 个阶段");
    assert.match(r3.stdout, /"progress": "\[1\]✓ \[2\]— \[3\]✓ \[4\]— \[5\]— \[6\]—"/,
      "progress 行显示阶段 1/3 已声明、2/4/5/6 缺口");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-83: wao stage 非法 stage 号 fail-fast（枚举约束，防跳号）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stage-bad-"));
  try {
    spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    const r = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "7",
      "--task", "x",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.notEqual(r.status, 0, "非法 stage 号（7）必须 fail-fast");
    assert.match(r.stderr, /stage 必须是/, "stderr 解释合法枚举值");
  } finally {
    rmrfRetry(dir);
  }
});

test("TD-95 #7: stage artifact 含 run 路径时存为绝对路径（跨项目可解析）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-stage-artifact-"));
  try {
    spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    // 模拟跨项目派工：artifact 是 runs/run_xxx.jsonl（相对 WAO repo，不是 --cwd 目标）
    const r = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "3",
      "--task", "派发实现",
      "--artifacts", "runs/run_test123.jsonl",
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, `stage 3 应成功，stderr=${r.stderr}`);
    // 读 stage 正文，确认 artifact 是绝对路径（跨项目时可解析）
    const stageFiles = readdirSync(join(dir, ".wao", "pipeline")).filter((f) => f.startsWith("STAGE-3"));
    assert.ok(stageFiles.length === 1, "应有 1 个 STAGE-3 文件");
    const body = readFileSync(join(dir, ".wao", "pipeline", stageFiles[0]), "utf8");
    // artifact 应是绝对路径（含盘符 + run_test123.jsonl），不是裸 runs/run_test123.jsonl
    assert.ok(body.includes("run_test123.jsonl"), "artifact 应含 run_test123.jsonl");
    assert.ok(/[A-Za-z]:[\\/].*run_test123/.test(body),
      "artifact 应是绝对路径（含盘符），实际：" + body.slice(0, 200));
  } finally {
    rmrfRetry(dir);
  }
});

// ── R9（决策 0023）：wao stage panel 字段（三席会审产品化，advisory 非门禁）──
//
// 需求 3（2/4 接受、1/3/5/6 拒绝、同 stage 多条记录）与需求 4（无 panel →
// panelAdvisory + stdout 纯 JSON + exit 0；非法 skip 码/互斥 fail-fast）的
// 端到端行为断言。registry 用临时目录 fixture（绝无真实派发）。

/** R9 fixture：临时项目目录 + .wao/ init + 双 worker registry（coder_hq/auditor）。 */
function makePanelFixture(name) {
  const dir = mkdtempSync(join(tmpdir(), name));
  spawnSync(process.execPath, ["src/cli.js", "wao", "init", "--cwd", dir],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  const registry = join(dir, "agents.json");
  writeFileSync(registry, JSON.stringify({
    agents: {
      coder_hq: { backend: "claude-code", cwd: "." },
      auditor: { backend: "claude-code", cwd: "." },
    },
  }), "utf8");
  return { dir, registry };
}

test("R9 需求 3: stage 2/4 接受 --panel-seats（registry 校验 + 自报标注 + map/自省留痕），1/3/5/6 拒绝", () => {
  const { dir, registry } = makePanelFixture("wao-stage-panel-acc-");
  try {
    // stage 2 接受 seats：输出纯 JSON，panel.seats 在场且标注自报未验证。
    const r2 = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "2",
      "--task", "方案定稿",
      "--panel-seats", "coder_hq,auditor",
      "--registry", registry,
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r2.status, 0, `stage 2 带 panel-seats 应成功，stderr=${r2.stderr}`);
    const out2 = JSON.parse(r2.stdout);
    assert.deepEqual(out2.panel.seats, ["coder_hq", "auditor"]);
    assert.match(out2.panel.note, /自报、未验证/);
    assert.match(out2.panel.note, /--artifacts/);
    // stage 4 接受 skip：skipReason 在场 + 红线句复述。
    const r4 = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "4",
      "--task", "交付验收",
      "--panel-skip-reason", "low_risk_small_task",
      "--registry", registry,
      "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r4.status, 0, `stage 4 带 skip 应成功，stderr=${r4.stderr}`);
    const out4 = JSON.parse(r4.stdout);
    assert.equal(out4.panel.skipReason, "low_risk_small_task");
    assert.match(out4.acceptanceRedLine, /评审意见是证据不是验收；run_delivery_decide 只由 Lead 调用/);
    // 1/3/5/6 带 panel 参数 → fail-fast，文案必须是两节点限定句。
    for (const n of [1, 3, 5, 6]) {
      const bad = spawnSync(process.execPath, [
        "src/cli.js", "wao", "stage", String(n),
        "--task", "x",
        "--panel-seats", "coder_hq",
        "--registry", registry,
        "--cwd", dir,
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
      assert.notEqual(bad.status, 0, `stage ${n} 带 panel 参数必须 fail-fast`);
      assert.match(bad.stderr, /panel 字段只在方案（2）\/交付物验收（4）登记/,
        `stage ${n} 拒绝文案必须是两节点限定句（不是"会审仅发生在两节点"）`);
    }
    // map 索引行第 5 列 panel 摘要 + 裸 wao stage 可检索。
    const map = readFileSync(join(dir, ".wao", "pipeline", "map.md"), "utf8");
    assert.match(map, /STAGE \| 2 \| [^|]+\| [^|]+\| panel=seats:coder_hq\+auditor/);
    assert.match(map, /panel=skip:low_risk_small_task/);
    const bare = spawnSync(process.execPath, ["src/cli.js", "wao", "stage", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(bare.status, 0);
    const summary = JSON.parse(bare.stdout);
    assert.equal(summary.panel.records, 2);
    assert.equal(summary.panel.seatsRecords, 1);
    assert.deepEqual(summary.panel.bySkipReason, { low_risk_small_task: 1 });
  } finally {
    rmrfRetry(dir);
  }
});

test("R9 需求 4: 无 panel 的 stage 2/4 → panelAdvisory + stdout 仍可 JSON.parse + exit 0（非门禁钉死）", () => {
  const { dir } = makePanelFixture("wao-stage-panel-nudge-");
  try {
    for (const n of [2, 4]) {
      const r = spawnSync(process.execPath, [
        "src/cli.js", "wao", "stage", String(n),
        "--task", `t${n}`,
        "--cwd", dir,
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
      assert.equal(r.status, 0, `stage ${n} 无 panel 必须照常成功（advisory 非门禁），stderr=${r.stderr}`);
      const out = JSON.parse(r.stdout); // stdout 是纯 JSON——任何提示只能走加性字段
      assert.match(out.panelAdvisory, /未记录会审——三席会审是推荐标准（决策 0023）/);
      assert.match(out.panelAdvisory, /--panel-skip-reason/);
      assert.ok(!("panel" in out), "无 panel 字段时输出 panel 对象不在场");
    }
    // stage 1/3/5/6 无 panel：不给 nudge（两节点限定）。
    const r3 = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "3", "--task", "t3", "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(r3.status, 0);
    assert.ok(!JSON.parse(r3.stdout).panelAdvisory, "stage 3 无 panel 不给 nudge");
  } finally {
    rmrfRetry(dir);
  }
});

test("R9 需求 3/4: 非法 skip 码、seats/skip 互斥、registry 外 seats 都 fail-fast；同 stage 两条记录都留痕", () => {
  const { dir, registry } = makePanelFixture("wao-stage-panel-reject-");
  const run = (args) => spawnSync(process.execPath,
    ["src/cli.js", "wao", "stage", ...args, "--registry", registry, "--cwd", dir],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  try {
    // 非法 skip 码（闭集外）→ fail-fast，stderr 列出合法闭集。
    const badSkip = run(["2", "--task", "x", "--panel-skip-reason", "因为我想"]);
    assert.notEqual(badSkip.status, 0, "非法 skip 码必须 fail-fast");
    assert.match(badSkip.stderr, /--panel-skip-reason 必须是闭集值之一/);
    assert.match(badSkip.stderr, /no_reviewer_available/);
    // seats 与 skip 同给 → 互斥 fail-fast。
    const both = run(["2", "--task", "x", "--panel-seats", "coder_hq", "--panel-skip-reason", "time_critical"]);
    assert.notEqual(both.status, 0, "seats/skip 互斥必须 fail-fast");
    assert.match(both.stderr, /互斥/);
    // registry 里不存在的 worker → fail-fast（自报也要是已配置 worker）。
    const ghost = run(["2", "--task", "x", "--panel-seats", "ghost_worker"]);
    assert.notEqual(ghost.status, 0, "registry 外 seats 必须 fail-fast");
    assert.match(ghost.stderr, /registry 里不存在的 worker: ghost_worker/);
    // 同一 stage 两条 panel 记录（返工/窄复核的真实形状）都留痕且可检索。
    assert.equal(run(["2", "--task", "首轮方案", "--panel-seats", "coder_hq,auditor"]).status, 0);
    assert.equal(run(["2", "--task", "返工窄复核", "--panel-skip-reason", "owner_direct"]).status, 0);
    const bare = spawnSync(process.execPath, ["src/cli.js", "wao", "stage", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    const summary = JSON.parse(bare.stdout);
    const stage2Panels = summary.stages.filter((s) => s.stage === 2).map((s) => s.panel);
    assert.equal(stage2Panels.length, 2, "同 stage 两条 panel 记录都在（无唯一性校验）");
    assert.ok(stage2Panels.some((p) => p?.seats && p.seats.join(",") === "coder_hq,auditor"));
    assert.ok(stage2Panels.some((p) => p?.skipReason === "owner_direct"));
  } finally {
    rmrfRetry(dir);
  }
});

test("R9 兼容: 无 panel 第 5 列的旧 STAGE 索引行照常解析（July pilot 形状）", () => {
  const { dir } = makePanelFixture("wao-stage-panel-compat-");
  try {
    // 手工构造新旧两种行并存（主仓 .wao/pipeline/map.md 的 July pilot 旧行在
    // worktree 内不存在——这里用临时目录构造等价形状）。
    const mapPath = join(dir, ".wao", "pipeline", "map.md");
    writeFileSync(mapPath, [
      "# Pipeline Map",
      "",
      "STAGE | 1 | 旧形状四列：无 panel | docs/01-prd.md",
      `STAGE | 2 | 新形状：有 panel | docs/plan.md | panel=seats:coder_hq+auditor`,
      "",
    ].join("\n"), "utf8");
    const bare = spawnSync(process.execPath, ["src/cli.js", "wao", "stage", "--cwd", dir],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(bare.status, 0, `旧行混合必须照常解析，stderr=${bare.stderr}`);
    const summary = JSON.parse(bare.stdout);
    assert.equal(summary.count, 2);
    const old = summary.stages.find((s) => s.stage === 1);
    assert.equal(old.panel, null, "旧行（无第 5 列）panel 解析为 null");
    assert.equal(old.artifact, "docs/01-prd.md", "旧行既有列不受影响");
    const neu = summary.stages.find((s) => s.stage === 2);
    assert.deepEqual(neu.panel.seats, ["coder_hq", "auditor"], "新行第 5 列照常解析");
    assert.equal(summary.panel.records, 1, "旧行不计入 panel 记录");
  } finally {
    rmrfRetry(dir);
  }
});

test("R9-C C-8: stage 4 STAGE 正文固定写入红线句（panel 与无 panel 两种；stdout 之外的持久化）", () => {
  const { dir, registry } = makePanelFixture("wao-stage-redline-");
  try {
    const RED_LINE = "评审意见是证据不是验收；run_delivery_decide 只由 Lead 调用";
    // 带 panel（skip 形态）的 stage 4：正文必须含红线句。
    const withPanel = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "4",
      "--task", "交付验收",
      "--panel-skip-reason", "low_risk_small_task",
      "--registry", registry, "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(withPanel.status, 0, `stage 4 skip 应成功，stderr=${withPanel.stderr}`);
    const body1 = readFileSync(JSON.parse(withPanel.stdout).path, "utf8");
    assert.ok(body1.includes(RED_LINE), "带 panel 的 stage 4 正文必须落盘红线句");
    // 无 panel 的 stage 4：正文同样必须含（panelAdvisory 路径）。
    const noPanel = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "4", "--task", "交付验收补登", "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(noPanel.status, 0, `无 panel stage 4 应成功，stderr=${noPanel.stderr}`);
    const body2 = readFileSync(JSON.parse(noPanel.stdout).path, "utf8");
    assert.ok(body2.includes(RED_LINE), "无 panel 的 stage 4 正文必须落盘红线句");
    // 反向钉：stage 2（方案节点）正文不写验收红线句——红线只在验收节点落盘。
    const plan = spawnSync(process.execPath, [
      "src/cli.js", "wao", "stage", "2", "--task", "方案定稿", "--cwd", dir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    assert.equal(plan.status, 0);
    const body3 = readFileSync(JSON.parse(plan.stdout).path, "utf8");
    assert.ok(!body3.includes(RED_LINE), "stage 2 正文不含验收红线句（两节点限定）");
  } finally {
    rmrfRetry(dir);
  }
});

test("R9-C C-13: --panel-seats 的 registry 存在性校验四路径 fail-fast（读失败/解析失败/缺 agents 表/未知 id）", () => {
  const { dir } = makePanelFixture("wao-stage-seats-validate-");
  const run = (registryPath) => spawnSync(process.execPath,
    ["src/cli.js", "wao", "stage", "2", "--task", "x", "--panel-seats", "coder_hq",
      "--registry", registryPath, "--cwd", dir],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  try {
    // 路径 1：registry 文件不存在（读取失败）。
    const readFail = run(join(dir, "nope", "agents.json"));
    assert.notEqual(readFail.status, 0, "registry 读失败必须 fail-fast");
    assert.match(readFail.stderr, /读取失败/, "读失败文案指明先跑 onboarding 或 --registry 指向有效 registry");
    // 路径 2：文件在但 JSON 解析失败。
    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{ not json", "utf8");
    const parseFail = run(badJson);
    assert.notEqual(parseFail.status, 0, "解析失败必须 fail-fast");
    assert.match(parseFail.stderr, /解析失败/, "解析失败文案指向 registry validate");
    // 路径 3：JSON 合法但缺可用 agents 表。
    const noAgents = join(dir, "no-agents.json");
    writeFileSync(noAgents, JSON.stringify({ foo: 1 }), "utf8");
    const agentsFail = run(noAgents);
    assert.notEqual(agentsFail.status, 0, "缺 agents 表必须 fail-fast");
    assert.match(agentsFail.stderr, /缺少可用 agents 表/);
    // 路径 4：agents 表在场但 seats 引用未知 id（此前唯一有覆盖的路径——回归钉）。
    const unknown = join(dir, "unknown.json");
    writeFileSync(unknown, JSON.stringify({
      agents: { coder_low: { backend: "claude-code", cwd: "." } },
    }), "utf8");
    const ghost = run(unknown);
    assert.notEqual(ghost.status, 0, "未知 id 必须 fail-fast");
    assert.match(ghost.stderr, /registry 里不存在的 worker: coder_hq/);
  } finally {
    rmrfRetry(dir);
  }
});

test("R9 回归: wao onboarding refused/error 分支 exitCode 行为不受分级块影响（拒绝仍 exit 1，preview 仍 exit 0）", () => {
  // 拒绝路径：--agent ghost（模板里不存在的 id）→ outcome refused → exit 1。
  // 零写（refused 在任何写之前返回）；读真实入库模板（只读）。
  const refused = spawnSync(process.execPath,
    ["src/cli.js", "wao", "onboarding", "--agent", "ghost_worker"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 60000 });
  assert.equal(refused.status, 1, "refused outcome 必须 exit 1（脚本/CI 门控语义不变）");
  // preview 路径：模板真实存在的席位（零写）→ exit 0，且 selected 分支打印分级块。
  // TD-242（2026-10-09）：tester 已随 0046 席位矩阵重构从入库模板除名（现行
  // 候选=车道键 glm-pro/glm-flash/kimi/sol/astra/opus/fable/deepseek-pro/deepseek-flash），
  // 改用现行席位 sol——"tester 不在模板"导致的 REFUSED exit 1 是本测试慢性红
  // 的真凶（非 PATH、非解释器版本）。
  const preview = spawnSync(process.execPath,
    ["src/cli.js", "wao", "onboarding", "--agent", "sol"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 60000 });
  assert.equal(preview.status, 0, `preview outcome 必须 exit 0，stderr=${preview.stderr}`);
  // R10 集成修正：分级块的数据面（模板面/已配置面）取决于本机是否存在私有
  // config/agents.json——fresh worktree/CI 无（模板面）、已配置机器有（已配置
  // 面）。本测试只断言跨机稳定事实（selected 分支打印分级块本身），不钉面
  // （R7-C C-6 的机器状态解耦纪律同款）。
  assert.match(preview.stdout, /会审就绪（(模板面|已配置面)/, "selected/preview 分支打印分级块（R9 需求 1）");
});

test("TD-88: wao ask 缺 agentId 或任务时 fail-fast（快捷派工参数校验）", () => {
  // 缺 agentId
  const r1 = spawnSync(process.execPath, ["src/cli.js", "wao", "ask"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.notEqual(r1.status, 0, "缺 agentId 必须 fail-fast");
  assert.match(r1.stderr, /requires <agentId>/, "stderr 提示需要 agentId");

  // 有 agentId 缺任务
  const r2 = spawnSync(process.execPath, ["src/cli.js", "wao", "ask", "researcher"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.notEqual(r2.status, 0, "缺任务必须 fail-fast");
  assert.match(r2.stderr, /requires 一句话任务/, "stderr 提示需要一句话任务");
});

test("R7-AB 层一：run --background 缺 cwd 拒绝（fixture 必缺 cwd，派发服务层 typed 拒绝）", () => {
  // R7-C（C-6）与机器状态解耦：fixture registry——形状来源 config/agents.example.json
  // 的 researcher 条目（claude-code 进程式 backend），cwd 指向本测试 tmpdir 下的
  // 随机必缺路径，任何机器上确定性不存在。
  const dir = mkdtempSync(join(tmpdir(), "wao-td88-wf-"));
  try {
    const bgRunDir = join(dir, "bg-runs");
    const badCwd = join(dir, `no-such-project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const fixtureRegistry = join(dir, "agents.td88-fixture.json");
    writeFileSync(fixtureRegistry, JSON.stringify({
      agents: {
        researcher: { backend: "claude-code", cwd: badCwd },
      },
    }), "utf8");

    // fixture 的必缺 cwd 在派发服务层被 typed 拒绝。这里用【后台派发通道】端到端
    // 钉死该契约：exit 非零 + stderr 含 dispatch_cwd_not_found 与解析后的必缺路径 +
    // run-dir 零 run transcript（早于任何 transcript 写入、零 fork）。
    const bg = spawnSync(process.execPath, [
      "src/cli.js", "run", "researcher",
      "--prompt", "x",
      "--background",
      "--registry", fixtureRegistry,
      "--run-dir", bgRunDir,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 15000 });
    assert.notEqual(bg.status, 0, "必缺 cwd 的后台派发必须 exit 非零");
    assert.match(bg.stderr, /dispatch_cwd_not_found/, "stderr 含闭集 reason code");
    assert.match(bg.stderr, /dispatch working directory does not exist/, "stderr 含 typed 拒绝文案");
    assert.ok(bg.stderr.includes(resolve(badCwd)),
      `stderr 含解析后的必缺路径，实际：${bg.stderr}`);
    assert.doesNotMatch(bg.stderr, /node\.exe ENOENT/, "不再出现归咎可执行文件的误导性 spawn ENOENT");
    const leaked = existsSync(bgRunDir)
      ? readdirSync(bgRunDir).filter((f) => f.endsWith(".jsonl"))
      : [];
    assert.equal(leaked.length, 0, "被拒派发零 transcript（run-dir 甚至未创建）");
  } finally {
    rmrfRetry(dir);
  }
});

test("run --background: malformed --scorecard-rules fail-fast，不返回 ghost runId", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bg-bad-scorecard-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { coder_low: { backend: "claude-code", binary: "/nope", cwd: dir } },
    }), "utf8");
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      "src/cli.js", "run", "coder_low",
      "--prompt", "x",
      "--background",
      "--registry", registryPath,
      "--run-dir", runDir,
      "--scorecard-rules", "{bad json",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });

    assert.notEqual(result.status, 0, "malformed scorecard rules must fail in the visible CLI process");
    assert.doesNotMatch(result.stdout, /"runId"/, "CLI must not print a runId for an invocation it refused");
    assert.match(result.stderr, /scorecard-rules|JSON/i, "stderr should explain scorecard JSON parsing failure");
  } finally {
    rmrfRetry(dir);
  }
});

// ===== 顶层裸写的 wao 命名空间子命令直接执行 =====
// 裸 `doctor` / `onboarding` 等按 `wao <sub>` 执行；`wao wao <sub>` 与
// `npm run cli -- wao <sub>` 两种完整调用形照旧可用。

function runCliExpectFail(cmd) {
  try {
    execSync(`node src/cli.js ${cmd}`, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    return { status: e.status, stderr: (e.stderr ?? "").toString() };
  }
  return { status: 0, stderr: "" };
}

function runCliCapture(cmd) {
  try {
    const stdout = execSync(`node src/cli.js ${cmd}`, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? -1, stdout: (e.stdout ?? "").toString(), stderr: (e.stderr ?? "").toString() };
  }
}

test("bare wao-namespace subcommand at top level executes as `wao <sub>` (exit 0)", () => {
  // 裸 declare 指向一个空的临时目录：没有 .wao/pipeline 时固定输出零声明，
  // 只读、无副作用，结果不随运行它的检出变化。
  const dir = mkdtempSync(join(tmpdir(), "wao-bare-sub-"));
  try {
    const cwdArg = `--cwd "${dir}"`;
    const bare = runCliCapture(`declare ${cwdArg}`);
    assert.equal(bare.status, 0, `裸顶层子命令必须执行成功而非报 Unknown（stderr: ${bare.stderr}）`);
    const namespaced = runCliCapture(`wao declare ${cwdArg}`);
    assert.equal(namespaced.status, 0, `wao <sub> 两段式照旧可用（stderr: ${namespaced.stderr}）`);
    assert.equal(JSON.parse(bare.stdout).count, 0, "空目录没有声明");
    assert.deepEqual(JSON.parse(bare.stdout), JSON.parse(namespaced.stdout), "两种写法输出相同");
  } finally {
    rmrfRetry(dir);
  }
});

test("WAO_SUBCOMMANDS 与顶层 COMMAND_NAMES 不相交（撞名时子命令会被顶层命令遮住）", async () => {
  const { WAO_SUBCOMMANDS } = await import("../../src/commands/wao.js");
  const overlap = WAO_SUBCOMMANDS.filter((sub) => COMMAND_NAMES.includes(sub));
  assert.deepEqual(overlap, [],
    `两侧撞名会让顶层分派先命中自身、命名空间兜底永远接不到：${overlap.join(", ")}`);
});

test("TD-191④: non-namespace unknown command keeps exit 1 + gains a generic pointer", () => {
  const { status, stderr } = runCliExpectFail("definitely-not-a-command");
  assert.notEqual(status, 0);
  assert.match(stderr, /Unknown command: definitely-not-a-command/);
  assert.match(stderr, /wao <sub>/, "通用指路必须提到 wao 命名空间两段式形态");
});

// 决定 0094：workflow 与 wao state 已退役，三种旧调用都必须报未知命令（路由被恢复即变红）。
test("0094: workflow、wao state 与裸 state 已退役，调用即报未知命令", () => {
  for (const [cmd, pattern] of [
    ["workflow list", /Unknown command: workflow/],
    ["state read", /Unknown command: state/],
    ["wao state read", /Unknown wao subcommand: state/],
  ]) {
    const { status, stderr } = runCliExpectFail(cmd);
    assert.notEqual(status, 0, `${cmd} 应以非零退出`);
    assert.match(stderr, pattern, `${cmd} 应报未知命令`);
  }
});

// TD-260（0062 B9 乙′）→0065 supersede：seatRole 漂移指针行已随席位声明退役删除；
// registry_loads 恒回基线计数形态（模板声明比对不复存在）。
test("0065: doctor registry_loads 基线形态——seatRole 漂移指针行已删除", () => {
  const { dir, registryPath } = makeDoctorPanelFixture("wao-doctor-seatdrift-", {
    kimi: { backend: "kimi-web", serveUrl: "http://127.0.0.1:58628", model: { id: "kimi-code/k3-256k" }, cwd: "." },
  });
  try {
    const r = doctorPanelRun(dir, registryPath);
    const parsed = JSON.parse(r.stdout);
    const loads = parsed.checks.find((c) => c.name === "registry_loads");
    assert.ok(loads, "registry_loads 恒在场（P2-1）");
    assert.match(loads.detail, /^1 agents$/, "0065：基线计数形态（无 seatRole 漂移指针段）");
    assert.ok(!loads.detail.includes("seatRole"), "seatRole 指针行已删除（0065 supersede）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// TD-260（0062 B8）：反向指路——`npm run cli -- wao serve status` 这类"顶层
// 命令误入 wao 命名空间"给出两种完整调用形（与 TD-191④ 正向指路对称）。
// 会审否决 serve 别名案（opus：只治一族留五族不对称+入口闭集膨胀）。
test("TD-260 B8: top-level command under wao namespace gets reverse invocation forms", () => {
  for (const cmd of ["serve", "runs", "registry"]) {
    const { status, stderr } = runCliExpectFail(`wao ${cmd}`);
    assert.notEqual(status, 0, `${cmd} 必须仍以非零退出（不加别名、语义不变）`);
    assert.match(stderr, new RegExp(`Unknown wao subcommand: ${cmd}`), `${cmd} 保留 Unknown wao subcommand 事实前缀`);
    assert.match(stderr, /it is a top-level command/, `${cmd} 指明这是顶层命令`);
    assert.match(stderr, new RegExp(`npm run cli -- ${cmd} `), `${cmd} 必须给出 npm 完整调用形`);
    assert.match(stderr, new RegExp(`wao ${cmd} `), `${cmd} 必须给出全局 shim 完整调用形`);
  }
});

test("TD-191④: WAO_SUBCOMMANDS 与 waoCommand dispatch 保持同步", async () => {
  const src = readFileSync(join(process.cwd(), "src", "commands", "wao.js"), "utf8");
  const { WAO_SUBCOMMANDS } = await import("../../src/commands/wao.js");
  assert.ok(Array.isArray(WAO_SUBCOMMANDS) && WAO_SUBCOMMANDS.length >= 9, "闭集必须非空且覆盖现存 9 子命令");
  for (const sub of WAO_SUBCOMMANDS) {
    assert.ok(src.includes(`sub === "${sub}"`), `WAO_SUBCOMMANDS 成员 ${sub} 在 waoCommand dispatch 中不存在（闭集与分派漂移）`);
  }
});

// F-④（2026-10-10 摩擦处置批）：CLI 报错附正确用法行——`runs wait --run-id X`
// 连续两报错且都不含用法（runId 是位置参数、无 --run-id 旗标）；`daemon status`
// 是按 runId 查单个 run，与"守护进程自身状态"直觉相反（那是 ping/list）。
test("F-④: runs wait 参数错误附正确用法行（报错即教学）", async () => {
  const { runsCommand } = await import("../../src/commands/runs.js");
  await assert.rejects(
    () => runsCommand(["wait", "--run-id", "run_x"], {}, { runWaitFn: async () => ({}) }),
    (err) => {
      assert.match(err.message, /unknown flag for runs wait: --run-id/);
      assert.match(err.message, /用法：wao runs wait <runId>/, "必须给出正确命令形态");
      assert.match(err.message, /位置参数/, "必须点破 runId 是位置参数");
      return true;
    },
  );
  await assert.rejects(
    () => runsCommand(["wait"], {}, { runWaitFn: async () => ({}) }),
    (err) => {
      assert.match(err.message, /requires exactly one <runId>/);
      assert.match(err.message, /用法：wao runs wait/);
      return true;
    },
  );
});

test("F-④: daemon status 缺 runId 时讲清与 ping/list 的分工", async () => {
  const { daemonCommand } = await import("../../src/commands/daemon.js");
  // daemonStatusCommand 失败路径设 process.exitCode=1——这是 CLI 契约，但会渗进
  // 本测试进程造成文件级假红（子测全绿仍 exit 1）。保存/恢复隔离之。
  const prevExitCode = process.exitCode;
  const out = await captureLog(() => daemonCommand(["status"], { runDir: "runs-none" }));
  process.exitCode = prevExitCode;
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "status requires --run-id <id>");
  assert.match(parsed.hint, /daemon ping/, "指路守护进程自身健康检查");
  assert.match(parsed.hint, /daemon list/, "指路守护进程清单");
});

// ── TD-319：CLI 报错输出口统一转义（配置值带控制字符不能在报错里伪造一行）──────

test("TD-319: 配置值带换行——CLI 报错单行收口，转义写法在场（serve --url 拒绝清单）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td319-serve-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: {
        kimi_seat: {
          backend: "kimi-web",
          cwd: ".",
          model: { id: "kimi-k2" },
          tokenEnv: "WAO_TEST_KIMI_TOKEN_NAME",
          // 配置来源值（serveUrl）里藏一个换行：改前会被原样拼进报错，
          // 在 stderr 伪造一行 "[FAIL] forged-line-from-registry"。
          serveUrl: "http://127.0.0.1:58628\n[FAIL] forged-line-from-registry",
        },
      },
    }), "utf8");
    const result = spawnSync(process.execPath, [
      "src/cli.js", "serve", "status",
      "--url", "http://127.0.0.1:9",
      "--registry", registryPath,
    ], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } });
    assert.notEqual(result.status, 0, "不匹配的 --url 被拒绝");
    assert.ok(result.stderr.includes("matches no kimi-web agent"), "拒绝文案在场");
    assert.ok(
      result.stderr.includes("http://127.0.0.1:58628\\n[FAIL] forged-line-from-registry"),
      `换行以可见写法在场: ${JSON.stringify(result.stderr)}`,
    );
    // 无伪造行：整条报错单行，[FAIL] 载荷不作为独立行出现。
    const stderrLines = result.stderr.replace(/\r\n/g, "\n").trim().split("\n");
    assert.equal(stderrLines.length, 1, `报错应为单行: ${JSON.stringify(stderrLines)}`);
    assert.ok(!stderrLines.some((l) => l.startsWith("[FAIL]")), "不得出现伪造行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-319: 派发选择器拒绝仍是多行输出——行数与改前一致，各行结构不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td319-selector-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({
      agents: { probe_seat: { backend: "claude-code", cwd: "." } },
    }), "utf8");
    const result = spawnSync(process.execPath, [
      "src/cli.js", "run", "no_such_agent_probe", "--prompt", "t",
      "--registry", registryPath, "--run-dir", join(dir, "runs-none"),
    ], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } });
    assert.notEqual(result.status, 0, "未知 agentId 被拒");
    const lines = result.stderr.replace(/\r\n/g, "\n").trim().split("\n");
    // 改前（join("\n") 时代）同一夹具的行数：报错 message + 合法 alias + 合法 role +
    // 修正示例（非默认 --registry → 车道表停用：aliases 是空数组但仍真值，照推一行
    // 空清单；无合法 lane 行；unknown_agent 无 forms 行）。
    assert.equal(lines.length, 4, `行数与改前一致: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /unknown_agent/);
    assert.match(lines[1], /^合法 alias: $/, "空 alias 清单行（改前同样在场）");
    assert.match(lines[2], /^合法 role: /);
    assert.match(lines[3], /^修正示例: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-319: collect 取回失败——原报错 + 指路行恰两行（raw 与投影模式同形）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td319-collect-"));
  try {
    const emptyRunDir = join(dir, "runs-empty");
    mkdirSync(emptyRunDir, { recursive: true });
    for (const extraArgs of [[], ["--format", "json"]]) {
      const result = spawnSync(process.execPath, [
        "src/cli.js", "collect", "run_td319_probe", "--run-dir", emptyRunDir, ...extraArgs,
      ], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } });
      assert.notEqual(result.status, 0, `取回失败退出非零 (${extraArgs.join(" ")})`);
      const lines = result.stderr.replace(/\r\n/g, "\n").trim().split("\n");
      assert.equal(lines.length, 2, `原报错 + 指路行恰两行 (${extraArgs.join(" ")}): ${JSON.stringify(lines)}`);
      assert.match(lines[1], /^  — 查看已记录的运行状态与失败证据/, "第二行是指路行");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-319: dashboard 的非 Git 目录拒绝仍是两行，不折成带字面 \\n 的一行", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td319-dash-"));
  try {
    const result = spawnSync(process.execPath, [
      "src/cli.js", "dashboard", "--cwd", dir, "--no-open",
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 60000, env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } });
    assert.notEqual(result.status, 0, "非 Git 目录被拒绝");
    const lines = result.stderr.replace(/\r\n/g, "\n").trim().split("\n");
    assert.equal(lines.length, 2, `两行报错: ${JSON.stringify(lines)}`);
    assert.ok(lines[0].includes("需要 Git 仓库"), "第一行是拒绝原因");
    assert.ok(lines[1].includes("--cwd"), "第二行是指路");
    assert.ok(!result.stderr.includes("\\n"), "分行不是字面的 \\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-319: run 把顶层命令名当 agentId 时的 did-you-mean 提示仍是两行", () => {
  const result = spawnSync(process.execPath, ["src/cli.js", "run", "status"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 60000, env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
  });
  assert.notEqual(result.status, 0);
  const lines = result.stderr.replace(/\r\n/g, "\n").trim().split("\n");
  assert.equal(lines.length, 2, `两行提示: ${JSON.stringify(lines)}`);
  assert.equal(lines[0], "Provide --prompt or --prompt-file");
  assert.ok(lines[1].includes("\"status\" is a top-level WAO command"), "第二行是 did-you-mean 提示");
});

test("TD-319: worktree reclaim 自己打的拒绝明细里，计划带进来的换行显示为转义写法", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-td319-reclaim-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execSync("git init -q", { cwd: repo });
    const realRepo = realpathSync(repo);
    // 计划里的 runDir 藏一个换行：apply 以 run_dir_mismatch 拒绝时会把它拼进明细。
    const plan = {
      version: 1,
      items: [],
      repo: { gitCommonDir: join(realRepo, ".git"), mainWorktreePath: realRepo },
      runDir: `${join(dir, "runs")}\n[FORGED] reclaim-line`,
    };
    const bytes = JSON.stringify(plan);
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, bytes, "utf8");
    const sha = createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex");
    const result = spawnSync(process.execPath, [
      "src/cli.js", "worktree", "reclaim", "--apply", planPath, "--expect-sha256", sha,
      "--run-dir", join(dir, "other-runs"),
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 60000, env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } });
    assert.notEqual(result.status, 0, "运行目录不一致被拒绝");
    const lines = result.stderr.replace(/\r\n/g, "\n").trim().split("\n");
    assert.equal(lines.length, 1, `拒绝应为单行: ${JSON.stringify(lines)}`);
    assert.ok(lines[0].includes("run_dir_mismatch"), "拒绝码在场");
    assert.ok(lines[0].includes("\\n[FORGED] reclaim-line"), "换行以可见写法在场");
    assert.ok(!lines.some((l) => l.startsWith("[FORGED]")), "不得出现伪造行");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
