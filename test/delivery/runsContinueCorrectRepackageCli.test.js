// test/delivery/runsContinueCorrectRepackageCli.test.js
//
// 第 137a 批：CLI 补齐只在 MCP 有的三个操作——`runs continue`、`runs correct`、
// `runs delivery repackage`。三条命令都是薄适配层：委托 MCP 同一个应用服务
// （continueRun / correctRun / runDeliveryRepackage），本文件钉的是适配层自己的
// 声称，每条声称都有一个能证伪它的用例：
//   - 委托同一服务、传参与 MCP 处理函数一致（授权根先证明、再传规范根）；
//   - --format json 与 MCP 输出同名同义（续修面就是同一个投影函数的产物）；
//   - 拒绝是闭集码 + 非零退出，受理是 0；畸形服务结果 fail closed、零输出；
//   - 不回显 prompt、会话 id、绝对路径、命令行；
//   - 边界常量与 MCP schema 同源（repackage 的条数与长度）；
//   - 严格 argv 解析；0047 嵌套派发门在 CLI 续修入口同样生效（先于一切副作用）。
//
// 工作区根证明走真实 git（每例复制一份临时母仓）；不读仓库的 runs/、不派发真实
// worker（服务全部注入）。

// 0047 L1 门按 process.cwd() 判 worker 上下文：本文件在 .wao-worktrees 里跑时
// 命中。这里只注入假服务、不真派发，与既有派发类测试同款显式豁免；门本身的
// 用例（137a-C16）临时撤掉豁免、改用 env 标记臂，不依赖 cwd。
process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { baseRepoFixture, copyGitRepo, git } from "../_gitRepoFixture.mjs";
import {
  runsCommand,
  runsDeliveryCommand,
  RUNS_SUBCOMMANDS,
  RUNS_CONTINUE_FLAGS,
  RUNS_CORRECT_FLAGS,
  RUNS_DELIVERY_REPACKAGE_FLAGS,
} from "../../src/commands/runs.js";
import {
  CONTINUE_REJECTION_REASONS,
  CONTINUE_INHERITED_DELIVERY_NOTE,
  CONTINUE_INHERITED_DELIVERY_GUIDANCE,
  projectContinueOutcome,
} from "../../src/application/runContinue.js";
import { CORRECTION_ID_MAX_LEN, CORRECTION_PROMPT_MAX_LEN } from "../../src/application/runCorrection.js";
import {
  REPACKAGE_ALLOWED_PATHS_LIMIT,
  REPACKAGE_ALLOWED_PATH_MAX_LEN,
  REPACKAGE_REJECTION_CODES,
  RepackageRejectionError,
} from "../../src/application/runDeliveryRepackage.js";
import { proveWorkspaceRoot } from "../../src/application/workspaceBinding.js";
import { HELP_TEXT } from "../../src/cliHelp.js";

// ===== 夹具与工具 =====

const base = await baseRepoFixture("b137a-cli-ops", async (dir) => {
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
});
const repos = [];
/** 每例一份私有母仓副本（有初始提交——工作区根证明要能解析 HEAD）。 */
function makeRepo(prefix = "wao-137a-") {
  const dir = copyGitRepo(base.dir, prefix);
  repos.push(dir);
  return dir;
}
test.after(() => { for (const dir of repos) rmSync(dir, { recursive: true, force: true }); });

const PARENT = "run_202611231000000000parent";
const ROOT = "run_202611230900000000root00";
const CHILD = "run_202611231200000000child1";
const RUN = "run_202611231300000000repack";
const PROMPT_TEXT = "fix the missed boundary condition; SECRET-PROMPT-MARKER must never print";

function makeConfig(repo, extra = {}) {
  const runDir = join(repo, "runs");
  mkdirSync(runDir, { recursive: true });
  return { runDir, registry: join(repo, "agents.json"), waitTimeout: 600000, ...extra };
}

function writePromptFile(repo, text = PROMPT_TEXT) {
  const file = join(repo, "prompt.txt");
  writeFileSync(file, text, "utf8");
  return file;
}

/** 注入用服务：记下每次入参，返回固定结果（或经函数算出）。 */
function stub(result) {
  const calls = [];
  const fn = async (input) => { calls.push(input); return typeof result === "function" ? result(input) : result; };
  fn.calls = calls;
  return fn;
}

/**
 * 跑一次命令：收 stdout/stderr、退出码或抛出的错误；结束即恢复 exitCode
 * （node:test 同进程串行，命令设置的 process.exitCode 不能漏到别的用例）。
 */
async function runCli(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origError = console.error;
  const prevExit = process.exitCode;
  console.log = (...a) => { out.push(a.map(String).join("\t")); };
  console.error = (...a) => { err.push(a.map(String).join("\t")); };
  let error = null;
  try {
    await fn();
  } catch (e) {
    error = e;
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  const exitCode = error ? null : (process.exitCode ?? 0);
  process.exitCode = prevExit;
  return { out: out.join("\n"), err: err.join("\n"), exitCode, error };
}

function accepted(overrides = {}) {
  return {
    accepted: true,
    runId: CHILD,
    agentId: "coder_hq",
    parentRunId: PARENT,
    continuation: true,
    rootRunId: ROOT,
    state: "pending",
    transcriptPath: "D:/abs/runs/projects/x/child.jsonl",
    ...overrides,
  };
}

function refused(rejectionReason, extra = {}) {
  return { accepted: false, parentRunId: PARENT, continuation: true, rejectionReason, ...extra };
}

const SCOPE = {
  inheritedChangedPaths: ["src/a.js", "src/b.js"],
  inheritedChangedCount: 2,
  inheritedChangedTruncated: false,
  uncoveredInheritedPaths: ["src/b.js"],
  uncoveredInheritedCount: 1,
  uncoveredInheritedTruncated: false,
};

/** 续修命令的最小入参（提示词文件 + 仓库根 + 运行目录）。 */
function continueArgs(promptFile, repo, extra = []) {
  return [PARENT, "--prompt-file", promptFile, "--cwd", repo, ...extra];
}

// =====================================================================
// runs continue——受理
// =====================================================================

test("137a-C01: runs continue 受理 → exit 0；JSON 与 MCP 输出同名同义（同一投影函数）；nextStep 是 CLI 面的等待命令", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const svc = stub(accepted());
  const config = makeConfig(repo);
  const r = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], config, { continueRunFn: svc },
  ));
  assert.equal(r.error, null);
  assert.equal(r.exitCode, 0, "受理退出码 0");
  assert.equal(r.err, "", "受理不写 stderr");
  assert.equal(svc.calls.length, 1, "服务恰好调用一次");
  const wire = JSON.parse(r.out);
  // 与 MCP run_continue 的 structuredContent 同键同义：除 nextStep（按面渲染）外，
  // 整个对象就是两面共用的投影函数的产物。省略交付规格 → nextStep 末尾带继承
  // 合同那半句（与 MCP 同一句，见 137a-C04）。
  const baseStep = `Background run accepted. Before ending the turn, keep a wait attached: wao runs wait ${CHILD} --until-settled.`;
  assert.deepEqual(wire, {
    ...projectContinueOutcome(accepted(), undefined),
    nextStep: baseStep + CONTINUE_INHERITED_DELIVERY_NOTE,
  });
  assert.deepEqual(Object.keys(wire).sort(), [
    "accepted", "agentId", "continuation", "nextStep", "parentRunId",
    "rejectionReason", "rootRunId", "runId", "state",
  ]);
  assert.equal(wire.accepted, true);
  assert.equal(wire.runId, CHILD);
  assert.equal(wire.rootRunId, ROOT);
  assert.equal(wire.state, "pending");
  assert.equal(wire.rejectionReason, null);
  // 不回显：prompt、转录路径、绝对路径都不在输出里。
  assert.ok(!r.out.includes("SECRET-PROMPT-MARKER"), "不回显 prompt");
  assert.ok(!r.out.includes("D:/abs"), "不回显绝对路径（转录路径）");
  assert.ok(!r.out.includes(repo), "不回显工作区绝对路径");
});

test("137a-C02: runs continue 传参与 MCP 处理函数一致（服务一次；授权根 = 证明后的规范根；requireCertified false；带全局等待窗与后端选择器）", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const svc = stub(accepted());
  const config = makeConfig(repo);
  await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], config, { continueRunFn: svc },
  ));
  assert.equal(svc.calls.length, 1);
  const arg = svc.calls[0];
  assert.equal(arg.parentRunId, PARENT);
  assert.equal(arg.prompt, PROMPT_TEXT, "--prompt-file 的全文原样交给服务");
  assert.equal(arg.delivery, undefined, "省略 --delivery-spec-file → 服务收到 undefined（继承父合同，决定 0130）");
  assert.equal(arg.runDir, config.runDir);
  assert.equal(arg.registryPath, config.registry);
  assert.equal(arg.authorizedWorkspaceRoot, proveWorkspaceRoot(repo).root, "授权根是 proveWorkspaceRoot 证明后的规范根");
  assert.equal(arg.requireCertified, false, "与 MCP 处理函数一致：服务级认证要求为 false");
  assert.equal(arg.globalWaitTimeout, 600000, "全局等待窗来自 config.waitTimeout（与 CLI 后台派发同源）");
  assert.equal(typeof arg.backendFor, "function", "后端选择器交给服务（supportsSessionReuse 门要用）");
  assert.equal(arg.backendFor({ backend: "no-such-backend" }), null, "未知 backend 折成 null（fail-closed，与 MCP resolveBackendFor 同约定）");
  // 既有旗标：--run-dir / --registry 覆盖缺省。
  const svc2 = stub(accepted());
  await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, [
      "--format", "json", "--run-dir", join(repo, "runs2"), "--registry", join(repo, "other.json"),
    ])], makeConfig(repo), { continueRunFn: svc2 },
  ));
  assert.equal(svc2.calls[0].runDir, join(repo, "runs2"));
  assert.equal(svc2.calls[0].registryPath, join(repo, "other.json"));
});

test("137a-C03: runs continue 文本输出：子运行、父、根、状态与 CLI 等待命令；不回显 prompt", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const r = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo)], makeConfig(repo), { continueRunFn: stub(accepted()) },
  ));
  assert.equal(r.error, null);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.out.split("\n"), [
    `Run: ${CHILD}`,
    `Parent: ${PARENT}`,
    `Root: ${ROOT}`,
    "Agent: coder_hq",
    "State: pending",
    `Next step: Background run accepted. Before ending the turn, keep a wait attached: wao runs wait ${CHILD} --until-settled.${CONTINUE_INHERITED_DELIVERY_NOTE}`,
  ]);
  assert.ok(!r.out.includes("SECRET-PROMPT-MARKER"));
});

test("137a-C04: 省略 --delivery-spec-file → nextStep 末尾写明继承父合同（与 MCP 同一句）；显式给合同时不带这句", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const inherited = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], makeConfig(repo), { continueRunFn: stub(accepted()) },
  ));
  const inheritedStep = JSON.parse(inherited.out).nextStep;
  assert.ok(inheritedStep.endsWith(CONTINUE_INHERITED_DELIVERY_NOTE),
    `继承合同那半句在末尾（实测：${inheritedStep}）`);
  assert.equal(inheritedStep, `Background run accepted. Before ending the turn, keep a wait attached: wao runs wait ${CHILD} --until-settled.${CONTINUE_INHERITED_DELIVERY_NOTE}`);

  const spec = join(repo, "delivery.json");
  writeFileSync(spec, JSON.stringify({ allowedPaths: ["src"], verificationCommands: ["npm test"] }), "utf8");
  const explicit = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json", "--delivery-spec-file", spec])],
    makeConfig(repo), { continueRunFn: stub(accepted()) },
  ));
  assert.ok(!JSON.parse(explicit.out).nextStep.includes("inherited"), "显式合同不带继承那半句");
  // 文本面同样带上这半句。
  const text = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo)], makeConfig(repo), { continueRunFn: stub(accepted()) },
  ));
  assert.ok(text.out.split("\n").at(-1).endsWith(CONTINUE_INHERITED_DELIVERY_NOTE), "文本面的 Next step 行同样写明");
});

test("137a-C05: --delivery-spec-file 与 wao run 同一个解析器与文件格式（mode 可省；校验后的合同交给服务；外层包装给 INNER 提示）", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const spec = join(repo, "delivery.json");
  writeFileSync(spec, JSON.stringify({
    allowedPaths: ["src", "test"],
    verificationCommands: ["npm run test:one -- test/x.test.js"],
    verificationSetupCommands: ["npm ci"],
    verificationTimeoutMs: 7200000,
  }), "utf8");
  const svc = stub(accepted());
  const ok = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json", "--delivery-spec-file", spec])],
    makeConfig(repo), { continueRunFn: svc },
  ));
  assert.equal(ok.error, null);
  assert.deepEqual(svc.calls[0].delivery, {
    mode: "git_commit_v1",
    allowedPaths: ["src", "test"],
    verificationCommands: ["npm run test:one -- test/x.test.js"],
    verificationSetupCommands: ["npm ci"],
    verificationTimeoutMs: 7200000,
  });
  // 外层 {"delivery": …} 包装：与 wao run 同一句 INNER 提示（两行）。
  const wrapped = join(repo, "wrapped.json");
  writeFileSync(wrapped, JSON.stringify({ delivery: { allowedPaths: ["src"], verificationCommands: ["npm test"] } }), "utf8");
  const svc2 = stub(accepted());
  const bad = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--delivery-spec-file", wrapped])], makeConfig(repo), { continueRunFn: svc2 },
  ));
  assert.ok(bad.error, "外层包装被拒");
  assert.match(bad.error.message, /--delivery-spec-file expects the INNER delivery object/);
  assert.equal(svc2.calls.length, 0, "服务从未被调用");
});

test("137a-C06: 显式合同没写验证 → 由两面共用的校验（prepareDeliveryRequest）在调用服务前拒绝，零服务调用", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const spec = join(repo, "no-verification.json");
  writeFileSync(spec, JSON.stringify({ mode: "git_commit_v1", allowedPaths: ["src"] }), "utf8");
  const svc = stub(accepted());
  const r = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--delivery-spec-file", spec])], makeConfig(repo), { continueRunFn: svc },
  ));
  assert.ok(r.error, "没写验证的显式合同被拒");
  assert.match(r.error.message, /must provide either non-empty verificationCommands or verificationUnavailableReason/);
  assert.equal(svc.calls.length, 0, "服务从未被调用");
  assert.equal(r.out, "", "零输出");
  assert.notEqual(r.exitCode, 0);
});

// =====================================================================
// runs continue——拒绝
// =====================================================================

test("137a-C07: 拒绝 → 闭集 rejectionReason、成功字段为 null、不带 nextStep；退出码 1", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const svc = stub(refused("parent_not_terminal", { parentState: "running" }));
  const r = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], makeConfig(repo), { continueRunFn: svc },
  ));
  assert.equal(r.error, null, "拒绝是正常结构化结果，不抛错");
  assert.equal(r.exitCode, 1, "拒绝非零退出");
  assert.equal(r.out, r.out.trim());
  const wire = JSON.parse(r.out);
  assert.deepEqual(wire, {
    accepted: false, parentRunId: PARENT, continuation: true,
    runId: null, agentId: null, rootRunId: null, state: null,
    rejectionReason: "parent_not_terminal",
  });
  assert.equal(Object.keys(wire).includes("nextStep"), false, "拒绝不给 nextStep");
  assert.ok(!("parentState" in wire), "服务附带的事实字段不出输出");
  for (const reason of CONTINUE_REJECTION_REASONS) {
    const one = await runCli(() => runsCommand(
      ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], makeConfig(repo), { continueRunFn: stub(refused(reason)) },
    ));
    assert.equal(JSON.parse(one.out).rejectionReason, reason, `闭集成员 ${reason} 原样透出`);
    assert.equal(one.exitCode, 1);
  }
  // 文本面。
  const text = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo)], makeConfig(repo), { continueRunFn: stub(refused("parent_accepted")) },
  ));
  assert.equal(text.exitCode, 1);
  assert.deepEqual(text.out.split("\n"), [`Run: ${PARENT}`, "Continuation refused: parent_accepted"]);
  assert.ok(!text.out.includes("SECRET-PROMPT-MARKER"));
});

test("137a-C08: continuation_scope_incomplete → 带有界路径事实，且与 MCP 走同一个安全投影（合法路径透出；不安全路径整体省略）", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const clean = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])],
    makeConfig(repo), { continueRunFn: stub(refused("continuation_scope_incomplete", SCOPE)) },
  ));
  const wire = JSON.parse(clean.out);
  assert.deepEqual(wire, projectContinueOutcome(refused("continuation_scope_incomplete", SCOPE), undefined));
  assert.deepEqual(
    { p: wire.inheritedChangedPaths, c: wire.inheritedChangedCount, t: wire.inheritedChangedTruncated,
      u: wire.uncoveredInheritedPaths, n: wire.uncoveredInheritedCount, ut: wire.uncoveredInheritedTruncated },
    { p: ["src/a.js", "src/b.js"], c: 2, t: false, u: ["src/b.js"], n: 1, ut: false },
  );
  assert.equal(clean.exitCode, 1);
  // 不安全路径（穿越）：整份事实 fail closed 省略，闭集原因仍在。
  const unsafe = { ...SCOPE, uncoveredInheritedPaths: ["../outside/secret.js"], uncoveredInheritedCount: 1 };
  const dropped = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])],
    makeConfig(repo), { continueRunFn: stub(refused("continuation_scope_incomplete", unsafe)) },
  ));
  const wire2 = JSON.parse(dropped.out);
  assert.equal(wire2.rejectionReason, "continuation_scope_incomplete");
  assert.equal(Object.keys(wire2).includes("uncoveredInheritedPaths"), false, "不安全路径不出输出，也不出部分事实");
  assert.deepEqual(wire2, projectContinueOutcome(refused("continuation_scope_incomplete", unsafe), undefined));
  assert.ok(!dropped.out.includes("outside"), "不回显被拒路径");
  // 文本面列出路径与计数。
  const text = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo)],
    makeConfig(repo), { continueRunFn: stub(refused("continuation_scope_incomplete", SCOPE)) },
  ));
  assert.deepEqual(text.out.split("\n"), [
    `Run: ${PARENT}`,
    "Continuation refused: continuation_scope_incomplete",
    "Inherited changed paths: 2",
    "  - src/a.js",
    "  - src/b.js",
    "Uncovered inherited paths: 1",
    "  - src/b.js",
  ]);
});

test("137a-C09: 继承合同复验失败（invalid_delivery 且合同省略）→ 带与 MCP 同一句 guidance；显式合同的 invalid_delivery 不带", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const inherited = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])],
    makeConfig(repo), { continueRunFn: stub(refused("invalid_delivery")) },
  ));
  const wire = JSON.parse(inherited.out);
  assert.equal(wire.guidance, CONTINUE_INHERITED_DELIVERY_GUIDANCE);
  assert.equal(inherited.exitCode, 1);
  // 文本面照写这句指路。
  const text = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo)],
    makeConfig(repo), { continueRunFn: stub(refused("invalid_delivery")) },
  ));
  assert.deepEqual(text.out.split("\n"), [
    `Run: ${PARENT}`,
    "Continuation refused: invalid_delivery",
    `Note: ${CONTINUE_INHERITED_DELIVERY_GUIDANCE}`,
  ]);

  const spec = join(repo, "delivery.json");
  writeFileSync(spec, JSON.stringify({ allowedPaths: ["src"], verificationCommands: ["npm test"] }), "utf8");
  const explicit = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json", "--delivery-spec-file", spec])],
    makeConfig(repo), { continueRunFn: stub(refused("invalid_delivery")) },
  ));
  assert.equal(Object.keys(JSON.parse(explicit.out)).includes("guidance"), false, "显式合同的 invalid_delivery 不带 guidance");
  // 别的拒绝码即使是合同省略也不带 guidance。
  const other = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])],
    makeConfig(repo), { continueRunFn: stub(refused("busy", { activeRunId: "run_active_secret" })) },
  ));
  const otherWire = JSON.parse(other.out);
  assert.equal(Object.keys(otherWire).includes("guidance"), false);
  assert.ok(!other.out.includes("run_active_secret"), "busy 的活动 runId 永不出输出（与 MCP 脱敏合同一致）");
});

test("137a-C10: 畸形服务结果 fail closed——零输出、非零；闭集外的原因码与坏身份都过不了", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const cases = [
    ["闭集外的原因码", refused("made_up_reason")],
    ["受理但缺 runId", accepted({ runId: undefined })],
    ["受理但缺 agentId", accepted({ agentId: undefined })],
    ["受理但身份不合法", accepted({ agentId: "unknown" })],
    ["受理但缺 rootRunId", accepted({ rootRunId: null })],
    ["受理但缺 state", accepted({ state: undefined })],
    ["缺父 runId", { accepted: false, continuation: true, rejectionReason: "busy" }],
  ];
  for (const [label, result] of cases) {
    const r = await runCli(() => runsCommand(
      ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], makeConfig(repo), { continueRunFn: stub(result) },
    ));
    assert.ok(r.error, `${label}：必须报错`);
    assert.equal(r.out, "", `${label}：零输出`);
  }
});

test("137a-C11: 服务结果里的多余字段（转录路径、活动 runId、prompt、命令行）永不出输出", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const junk = accepted({
    transcriptPath: "C:/Users/<you>/secrets/runs/child.jsonl",
    activeRunId: "run_active_xyz",
    prompt: PROMPT_TEXT,
    runnerArgs: ["node", "backgroundRunner.js", "--prompt-secret"],
    argv: "node x.js --token abc",
    sessionUuid: "11111111-2222-3333-4444-555555555555",
    providerSessionId: "sess-xyz",
  });
  for (const extra of [[], ["--format", "json"]]) {
    const r = await runCli(() => runsCommand(
      ["continue", ...continueArgs(promptFile, repo, extra)], makeConfig(repo), { continueRunFn: stub(junk) },
    ));
    assert.equal(r.error, null);
    for (const needle of ["C:/Users", "run_active_xyz", "SECRET-PROMPT-MARKER", "backgroundRunner", "abc", "11111111", "sess-xyz"]) {
      assert.ok(!r.out.includes(needle), `不回显 ${needle}`);
    }
  }
});

test("137a-C12: 服务抛出环境错误 → 原样上抛、非零、零输出（凭据缺失只带变量名，不带值）", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const { CredentialMissingError } = await import("../../src/application/runDispatch.js");
  const missing = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])],
    makeConfig(repo), { continueRunFn: async () => { throw new CredentialMissingError(["WAO_TEST_TOKEN_X"]); } },
  ));
  assert.ok(missing.error);
  assert.match(missing.error.message, /credential missing: WAO_TEST_TOKEN_X/);
  assert.equal(missing.out, "", "失败零输出");
  const boom = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])],
    makeConfig(repo), { continueRunFn: async () => { throw new Error("continuation cumulative-scope facts could not be derived"); } },
  ));
  assert.match(boom.error.message, /could not be derived/);
  assert.equal(boom.out, "");
});

// =====================================================================
// runs continue——授权根、0047 门、严格解析
// =====================================================================

test("137a-C13: 授权工作区——--cwd 必须是 Git 顶层：显式给出即用它；子目录/非 Git 目录在调用服务前原样报根证明失败；缺省回落 WAO_TARGET_CWD", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const sub = join(repo, "nested");
  mkdirSync(sub);
  const svc = stub(accepted());
  const subRun = await runCli(() => runsCommand(
    ["continue", PARENT, "--prompt-file", promptFile, "--cwd", sub, "--format", "json"],
    makeConfig(repo), { continueRunFn: svc },
  ));
  assert.ok(subRun.error, "子目录被拒");
  assert.match(subRun.error.message, /Git worktree top-level, not a subdirectory/);
  assert.equal(svc.calls.length, 0, "根证明失败在服务调用之前");

  // 缺省链：没给 --cwd → WAO_TARGET_CWD。
  const prev = process.env.WAO_TARGET_CWD;
  process.env.WAO_TARGET_CWD = repo;
  try {
    const svc2 = stub(accepted());
    await runCli(() => runsCommand(
      ["continue", PARENT, "--prompt-file", promptFile, "--format", "json"], makeConfig(repo), { continueRunFn: svc2 },
    ));
    assert.equal(svc2.calls.length, 1);
    assert.equal(svc2.calls[0].authorizedWorkspaceRoot, proveWorkspaceRoot(repo).root, "缺省用 WAO_TARGET_CWD 证明后的根");
  } finally {
    if (prev === undefined) delete process.env.WAO_TARGET_CWD;
    else process.env.WAO_TARGET_CWD = prev;
  }
});

test("137a-C14: 0047 嵌套派发门在 CLI 续修入口生效——worker 上下文先于一切副作用被拒，服务从未被调用", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const svc = stub(accepted());
  const prevBypass = process.env.WAO_ALLOW_NESTED_DISPATCH;
  const prevMarker = process.env.WAO_IN_WORKER;
  delete process.env.WAO_ALLOW_NESTED_DISPATCH;
  process.env.WAO_IN_WORKER = "1";
  try {
    const r = await runCli(() => runsCommand(
      ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], makeConfig(repo), { continueRunFn: svc },
    ));
    assert.ok(r.error, "worker 上下文被拒");
    assert.match(r.error.message, /^nested dispatch refused \(decision 0047\)/);
    assert.equal(svc.calls.length, 0, "服务从未被调用");
    assert.equal(r.out, "");
  } finally {
    process.env.WAO_ALLOW_NESTED_DISPATCH = prevBypass;
    if (prevMarker === undefined) delete process.env.WAO_IN_WORKER;
    else process.env.WAO_IN_WORKER = prevMarker;
  }
});

test("137a-C15: 严格解析——缺提示词文件、重复旗标、未知旗标、非 json 格式、多余位置参数都在服务调用前被拒", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const svc = stub(accepted());
  const bad = [
    [[PARENT, "--format", "json"], /--prompt-file/],
    [[PARENT, "--prompt-file", promptFile, "--prompt-file", promptFile, "--cwd", repo], /specified multiple times/],
    [[PARENT, "--prompt-file", promptFile, "--cwd", repo, "--wat"], /unknown flag for runs continue: --wat/],
    [[PARENT, "--prompt-file", promptFile, "--cwd", repo, "--format", "xml"], /--format only supports 'json'/],
    [[PARENT, CHILD, "--prompt-file", promptFile, "--cwd", repo], /exactly one <parentRunId>/],
    [["../etc/passwd", "--prompt-file", promptFile, "--cwd", repo], /valid <parentRunId>/],
    [[PARENT, "--prompt-file", promptFile, "--cwd", repo, "--authorized-workspace-root", "D:/other"], /unknown flag/],
    [[PARENT, "--prompt-file", promptFile, "--cwd", repo, "--prompt", "inline"], /unknown flag/],
    [[PARENT, "--prompt-file", "--cwd", repo], /--prompt-file requires a value/],
    [[PARENT, "--prompt-file", promptFile, "--cwd", repo, "--execution-profile-id", "x"], /unknown flag/],
  ];
  for (const [tail, pattern] of bad) {
    const r = await runCli(() => runsCommand(["continue", ...tail], makeConfig(repo), { continueRunFn: svc }));
    assert.ok(r.error, `${JSON.stringify(tail)} 必须被拒`);
    assert.match(r.error.message, pattern, `${JSON.stringify(tail)}：${r.error.message}`);
    assert.equal(r.out, "", `${JSON.stringify(tail)}：零输出`);
  }
  assert.equal(svc.calls.length, 0, "服务从未被调用");
});

// =====================================================================
// runs correct
// =====================================================================

const CORRECTION_ARGS = (promptFile, repo, extra = []) => [
  RUN, "--correction-id", "fix-1", "--prompt-file", promptFile, "--cwd", repo, ...extra,
];

test("137a-K01: runs correct queued → exit 0；JSON 恰为 MCP 的四个字段；委托同一服务", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo, "stop and re-read the contract");
  const svc = stub({ runId: RUN, correctionId: "fix-1", outcome: "queued", reason: null });
  const config = makeConfig(repo);
  const r = await runCli(() => runsCommand(
    ["correct", ...CORRECTION_ARGS(promptFile, repo, ["--format", "json"])], config, { correctRunFn: svc },
  ));
  assert.equal(r.error, null);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(JSON.parse(r.out), { runId: RUN, correctionId: "fix-1", outcome: "queued", reason: null });
  assert.equal(svc.calls.length, 1);
  assert.deepEqual(Object.keys(svc.calls[0]).sort(), ["authorizedWorkspaceRoot", "correctionId", "prompt", "runDir", "runId"]);
  assert.equal(svc.calls[0].runId, RUN);
  assert.equal(svc.calls[0].correctionId, "fix-1");
  assert.equal(svc.calls[0].prompt, "stop and re-read the contract");
  assert.equal(svc.calls[0].runDir, config.runDir);
  assert.equal(svc.calls[0].authorizedWorkspaceRoot, proveWorkspaceRoot(repo).root);
  assert.ok(!r.out.includes("re-read the contract"), "不回显 prompt");
});

test("137a-K02: runs correct 拒绝 → outcome rejected + 闭集 reason；退出码 1；pending/delivered 原样透出", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const rejected = await runCli(() => runsCommand(
    ["correct", ...CORRECTION_ARGS(promptFile, repo, ["--format", "json"])],
    makeConfig(repo), { correctRunFn: stub({ runId: RUN, correctionId: "fix-1", outcome: "rejected", reason: "terminal_run" }) },
  ));
  assert.equal(rejected.error, null);
  assert.equal(rejected.exitCode, 1);
  assert.deepEqual(JSON.parse(rejected.out), { runId: RUN, correctionId: "fix-1", outcome: "rejected", reason: "terminal_run" });
  for (const outcome of ["pending", "delivered"]) {
    const one = await runCli(() => runsCommand(
      ["correct", ...CORRECTION_ARGS(promptFile, repo, ["--format", "json"])],
      makeConfig(repo), { correctRunFn: stub({ runId: RUN, correctionId: "fix-1", outcome, reason: null }) },
    ));
    assert.equal(one.exitCode, 0);
    assert.deepEqual(JSON.parse(one.out), { runId: RUN, correctionId: "fix-1", outcome, reason: null });
  }
  const text = await runCli(() => runsCommand(
    ["correct", ...CORRECTION_ARGS(promptFile, repo)],
    makeConfig(repo), { correctRunFn: stub({ runId: RUN, correctionId: "fix-1", outcome: "rejected", reason: "not_correctable" }) },
  ));
  assert.equal(text.exitCode, 1);
  assert.deepEqual(text.out.split("\n"), [`Run: ${RUN}`, "Correction: fix-1", "Outcome: rejected (not_correctable)"]);
});

test("137a-K03: 纠正 id 与提示词长度按 MCP schema 的同一组常量在服务调用前校验", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const svc = stub({ runId: RUN, correctionId: "x", outcome: "queued", reason: null });
  const cases = [
    [["--correction-id", "has space"]],
    [["--correction-id", "a".repeat(CORRECTION_ID_MAX_LEN + 1)]],
    [["--correction-id", ""]],
  ];
  for (const [[flag, value]] of cases) {
    const r = await runCli(() => runsCommand(
      ["correct", RUN, flag, value, "--prompt-file", promptFile, "--cwd", repo], makeConfig(repo), { correctRunFn: svc },
    ));
    assert.ok(r.error, `${flag}=${JSON.stringify(value)} 必须被拒`);
    assert.match(r.error.message, /--correction-id/, `${flag}=${JSON.stringify(value)}：${r.error.message}`);
  }
  // 长度上限本身：恰好 64 字符合法，提示词恰好 15000 字符合法（都到达服务）。
  const okId = "i".repeat(CORRECTION_ID_MAX_LEN);
  const longPrompt = join(repo, "long.txt");
  writeFileSync(longPrompt, "p".repeat(CORRECTION_PROMPT_MAX_LEN), "utf8");
  const svcOk = stub({ runId: RUN, correctionId: okId, outcome: "queued", reason: null });
  const ok = await runCli(() => runsCommand(
    ["correct", RUN, "--correction-id", okId, "--prompt-file", longPrompt, "--cwd", repo, "--format", "json"],
    makeConfig(repo), { correctRunFn: svcOk },
  ));
  assert.equal(ok.error, null, `上限值合法（实测：${ok.error?.message}）`);
  assert.equal(svcOk.calls.length, 1);
  const over = join(repo, "over.txt");
  writeFileSync(over, "p".repeat(CORRECTION_PROMPT_MAX_LEN + 1), "utf8");
  const svcOver = stub({});
  const tooLong = await runCli(() => runsCommand(
    ["correct", RUN, "--correction-id", okId, "--prompt-file", over, "--cwd", repo], makeConfig(repo), { correctRunFn: svcOver },
  ));
  assert.ok(tooLong.error);
  assert.match(tooLong.error.message, /--prompt-file/);
  assert.equal(svcOver.calls.length, 0, "超长提示词在服务调用前被拒");
  assert.equal(svc.calls.length, 0, "坏 id 都没到服务");
});

test("137a-K04: 畸形服务结果 fail closed（闭集外 outcome / reason；非拒绝却带 reason）；多余字段不出输出", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const bad = [
    { runId: RUN, correctionId: "fix-1", outcome: "executed", reason: null },
    { runId: RUN, correctionId: "fix-1", outcome: "rejected", reason: "made_up" },
    { runId: RUN, correctionId: "fix-1", outcome: "queued", reason: "duplicate" },
    { runId: "run_other", correctionId: "fix-1", outcome: "queued", reason: null },
    { runId: RUN, correctionId: "other-1", outcome: "queued", reason: null },
  ];
  for (const result of bad) {
    const r = await runCli(() => runsCommand(
      ["correct", ...CORRECTION_ARGS(promptFile, repo, ["--format", "json"])], makeConfig(repo), { correctRunFn: stub(result) },
    ));
    assert.ok(r.error, `${JSON.stringify(result)} 必须报错`);
    assert.equal(r.out, "", "零输出");
  }
  const junk = await runCli(() => runsCommand(
    ["correct", ...CORRECTION_ARGS(promptFile, repo, ["--format", "json"])],
    makeConfig(repo), {
      correctRunFn: stub({
        runId: RUN, correctionId: "fix-1", outcome: "queued", reason: null,
        prompt: PROMPT_TEXT, sessionId: "sess-xyz", transcriptPath: "D:/abs/x.jsonl",
      }),
    },
  ));
  assert.equal(junk.error, null);
  assert.deepEqual(JSON.parse(junk.out), { runId: RUN, correctionId: "fix-1", outcome: "queued", reason: null });
  assert.ok(!junk.out.includes("SECRET-PROMPT-MARKER") && !junk.out.includes("sess-xyz") && !junk.out.includes("D:/abs"));
});

test("137a-K05: runs correct 严格解析（缺 --correction-id / 重复 / 未知旗标 / 多余位置参数）", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const svc = stub({});
  const bad = [
    [[RUN, "--prompt-file", promptFile, "--cwd", repo], /--correction-id/],
    [[RUN, "--correction-id", "a", "--prompt-file", promptFile, "--cwd", repo, "--cwd", repo], /specified multiple times/],
    [[RUN, "--correction-id", "a", "--prompt-file", promptFile, "--cwd", repo, "--delivery-spec-file", "x"], /unknown flag/],
    [[RUN, RUN, "--correction-id", "a", "--prompt-file", promptFile, "--cwd", repo], /exactly one <runId>/],
    [[RUN, "--correction-id", "a", "--cwd", repo], /--prompt-file/],
  ];
  for (const [tail, pattern] of bad) {
    const r = await runCli(() => runsCommand(["correct", ...tail], makeConfig(repo), { correctRunFn: svc }));
    assert.ok(r.error, `${JSON.stringify(tail)} 必须被拒`);
    assert.match(r.error.message, pattern, `${JSON.stringify(tail)}：${r.error.message}`);
  }
  assert.equal(svc.calls.length, 0);
});

// =====================================================================
// runs delivery repackage
// =====================================================================

const REPACKAGE_ARGS = (repo, extra = []) => ["--allowed-path", "src", "--allowed-path", "test", "--cwd", repo, ...extra];

test("137a-R01: runs delivery repackage 成功 → exit 0；JSON 是 MCP 同一份闭集字段；本进程等到验证结束，不返回 pending", async () => {
  const repo = makeRepo();
  const done = {
    runId: RUN, deliveryCommit: "a".repeat(40), verificationStatus: "passed",
    source: "recovered", recoveryKind: "backend_failed", created: true,
    outcome: "run.delivery_verification_passed", verificationRecorded: true,
    worktreePath: "D:/abs/wt", commands: ["npm test"], stderr: "secret stderr",
  };
  // 服务 80ms 后才完成——比 MCP 的有界等待窗（这里把窗压到 1ms）长得多：
  // CLI 必须照常等到结果，而不是像 MCP 那样回 pending。
  const svc = stub(() => new Promise((resolve) => setTimeout(() => resolve(done), 80)));
  const config = makeConfig(repo);
  const prevWindow = process.env.WAO_DELIVERY_WAIT_MS;
  process.env.WAO_DELIVERY_WAIT_MS = "1";
  try {
    const r = await runCli(() => runsDeliveryCommand(
      ["repackage", RUN, ...REPACKAGE_ARGS(repo, ["--format", "json"])], config, { getRunDeliveryRepackageFn: svc },
    ));
    assert.equal(r.error, null);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(JSON.parse(r.out), {
      status: "ok", runId: RUN, deliveryCommit: "a".repeat(40), verificationStatus: "passed",
      source: "recovered", recoveryKind: "backend_failed", created: true, rejectionReason: null,
    });
    for (const needle of ["pending", "D:/abs", "npm test", "secret stderr"]) {
      assert.ok(!r.out.includes(needle), `不回显 ${needle}`);
    }
    assert.equal(svc.calls.length, 1);
    assert.deepEqual(Object.keys(svc.calls[0]).sort(), ["allowedPaths", "authorizedWorkspaceRoot", "runDir", "runId"]);
    assert.deepEqual(svc.calls[0].allowedPaths, ["src", "test"], "--allowed-path 按给出顺序交给服务（规范化归服务）");
    assert.equal(svc.calls[0].runDir, config.runDir);
    assert.equal(svc.calls[0].authorizedWorkspaceRoot, proveWorkspaceRoot(repo).root);
  } finally {
    if (prevWindow === undefined) delete process.env.WAO_DELIVERY_WAIT_MS;
    else process.env.WAO_DELIVERY_WAIT_MS = prevWindow;
  }
  const text = await runCli(() => runsDeliveryCommand(
    ["repackage", RUN, ...REPACKAGE_ARGS(repo)], makeConfig(repo), { getRunDeliveryRepackageFn: stub(done) },
  ));
  assert.equal(text.exitCode, 0);
  assert.deepEqual(text.out.split("\n"), [
    `Run: ${RUN}`,
    `Delivery: ${"a".repeat(40)}`,
    "Verification: passed",
    "Source: recovered",
    "Recovery kind: backend_failed",
    "Created: true",
  ]);
});

test("137a-R02: 期望内的政策拒绝 → 结构化结果（status ok + 闭集 rejectionReason、交付字段缺席）、退出码 1", async () => {
  const repo = makeRepo();
  for (const code of REPACKAGE_REJECTION_CODES) {
    const svc = async () => { throw new RepackageRejectionError(code, "human diagnostics only PATH D:/secret"); };
    const r = await runCli(() => runsDeliveryCommand(
      ["repackage", RUN, ...REPACKAGE_ARGS(repo, ["--format", "json"])], makeConfig(repo), { getRunDeliveryRepackageFn: svc },
    ));
    assert.equal(r.error, null, `${code}：政策拒绝是正常结构化结果`);
    assert.equal(r.exitCode, 1, `${code}：非零退出`);
    assert.deepEqual(JSON.parse(r.out), { status: "ok", runId: RUN, rejectionReason: code });
    assert.ok(!r.out.includes("D:/secret"), "不回显诊断文本里的路径");
  }
  const text = await runCli(() => runsDeliveryCommand(
    ["repackage", RUN, ...REPACKAGE_ARGS(repo)], makeConfig(repo),
    { getRunDeliveryRepackageFn: async () => { throw new RepackageRejectionError("scope_violation", "x"); } },
  ));
  assert.equal(text.exitCode, 1);
  assert.deepEqual(text.out.split("\n"), [`Run: ${RUN}`, "Repackage rejected: scope_violation"]);
});

test("137a-R03: 意外错误（非类型化拒绝）原样上抛、零输出", async () => {
  const repo = makeRepo();
  const r = await runCli(() => runsDeliveryCommand(
    ["repackage", RUN, ...REPACKAGE_ARGS(repo, ["--format", "json"])], makeConfig(repo),
    { getRunDeliveryRepackageFn: async () => { throw new Error("git pack-objects exploded"); } },
  ));
  assert.ok(r.error);
  assert.match(r.error.message, /git pack-objects exploded/);
  assert.equal(r.out, "");
});

test("137a-R04: --allowed-path 的条数与长度上限跟 MCP schema 同一组常量（期望值从权威源派生，不另抄）", async () => {
  const repo = makeRepo();
  // MCP schema 一侧：tools/list 里 run_delivery_repackage 的 allowedPaths。
  const { createWaoMcpServer } = await import("../../src/mcp/server.js");
  const server = createWaoMcpServer({ registryPath: join(repo, "agents.json"), runDir: join(repo, "runs"), workspaceRoot: repo });
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "t", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  let schema;
  try {
    const { tools } = await client.listTools();
    schema = tools.find((t) => t.name === "run_delivery_repackage").inputSchema.properties.allowedPaths;
  } finally { await client.close(); await server.close(); }
  assert.equal(schema.maxItems, REPACKAGE_ALLOWED_PATHS_LIMIT, "MCP schema 的条数上限就是应用层导出的常量");
  assert.equal(schema.items.maxLength, REPACKAGE_ALLOWED_PATH_MAX_LEN, "MCP schema 的单条长度上限就是应用层导出的常量");
  assert.equal(schema.minItems, 1);
  // 上限还要等于服务实际执行的界：服务经 validateProjectedPath（MAX_PATH_LENGTH）
  // 拒绝超长路径。两面各自改了常量而服务没跟上，这里红。
  const { MAX_PATH_LENGTH, validateProjectedPath } = await import("../../src/application/deliveryReview.js");
  assert.equal(REPACKAGE_ALLOWED_PATH_MAX_LEN, MAX_PATH_LENGTH);
  const maxLenPath = "x".repeat(REPACKAGE_ALLOWED_PATH_MAX_LEN);
  assert.equal(validateProjectedPath(maxLenPath), maxLenPath, "恰好上限长度的路径服务放行");
  assert.throws(() => validateProjectedPath(`${maxLenPath}x`), /length/, "上限 +1 服务拒绝");

  // CLI 一侧：同一组常量，在服务调用前拒绝。
  const svc = stub({});
  const tooMany = Array.from({ length: REPACKAGE_ALLOWED_PATHS_LIMIT + 1 }, (_, i) => `p${i}`);
  const many = await runCli(() => runsDeliveryCommand(
    ["repackage", RUN, ...tooMany.flatMap((p) => ["--allowed-path", p]), "--cwd", repo], makeConfig(repo), { getRunDeliveryRepackageFn: svc },
  ));
  assert.ok(many.error);
  assert.match(many.error.message, new RegExp(`exceeds ${REPACKAGE_ALLOWED_PATHS_LIMIT}`));
  const longPath = `${"d/".repeat(Math.ceil(REPACKAGE_ALLOWED_PATH_MAX_LEN / 2))}x`;
  assert.ok(longPath.length > REPACKAGE_ALLOWED_PATH_MAX_LEN);
  const long = await runCli(() => runsDeliveryCommand(
    ["repackage", RUN, "--allowed-path", longPath, "--cwd", repo], makeConfig(repo), { getRunDeliveryRepackageFn: svc },
  ));
  assert.ok(long.error);
  assert.match(long.error.message, new RegExp(String(REPACKAGE_ALLOWED_PATH_MAX_LEN)));
  assert.equal(svc.calls.length, 0, "两条都没到服务");
  // 恰好上限条数合法（到达服务）。
  const atLimit = tooMany.slice(0, REPACKAGE_ALLOWED_PATHS_LIMIT);
  const svcOk = stub({ runId: RUN, deliveryCommit: "b".repeat(40), verificationStatus: "unavailable", source: "packaged", recoveryKind: "disallowed_scope", created: false });
  const ok = await runCli(() => runsDeliveryCommand(
    ["repackage", RUN, ...atLimit.flatMap((p) => ["--allowed-path", p]), "--cwd", repo, "--format", "json"],
    makeConfig(repo), { getRunDeliveryRepackageFn: svcOk },
  ));
  assert.equal(ok.error, null, `上限条数合法（实测：${ok.error?.message}）`);
  assert.equal(svcOk.calls.length, 1);
});

test("137a-R05: 畸形服务结果 fail closed（坏提交号、闭集外状态）；严格解析（缺 --allowed-path、重复旗标、未知旗标）", async () => {
  const repo = makeRepo();
  const good = { runId: RUN, deliveryCommit: "a".repeat(40), verificationStatus: "passed", source: "packaged", recoveryKind: "disallowed_scope", created: true };
  const bad = [
    { ...good, deliveryCommit: "abc123" },
    { ...good, verificationStatus: "pending" },
    { ...good, source: "salvaged" },
    { ...good, recoveryKind: "made_up" },
    { ...good, created: "yes" },
    { ...good, runId: "run_other" },
  ];
  for (const result of bad) {
    const r = await runCli(() => runsDeliveryCommand(
      ["repackage", RUN, ...REPACKAGE_ARGS(repo, ["--format", "json"])], makeConfig(repo), { getRunDeliveryRepackageFn: stub(result) },
    ));
    assert.ok(r.error, `${JSON.stringify(result)} 必须报错`);
    assert.equal(r.out, "", "零输出");
  }
  const svc = stub(good);
  const parse = [
    [[RUN, "--cwd", repo], /--allowed-path/],
    [[RUN, ...REPACKAGE_ARGS(repo), "--cwd", repo], /specified multiple times/],
    [[RUN, ...REPACKAGE_ARGS(repo), "--allowed-paths", "src,test"], /unknown flag for delivery repackage/],
    [[RUN, ...REPACKAGE_ARGS(repo), "--verification-commands-file", "x"], /unknown flag/],
    [[RUN, RUN, ...REPACKAGE_ARGS(repo)], /exactly one <runId>/],
    [[RUN, ...REPACKAGE_ARGS(repo), "--allowed-path", "  "], /non-empty/],
  ];
  for (const [tail, pattern] of parse) {
    const r = await runCli(() => runsDeliveryCommand(["repackage", ...tail], makeConfig(repo), { getRunDeliveryRepackageFn: svc }));
    assert.ok(r.error, `${JSON.stringify(tail)} 必须被拒`);
    assert.match(r.error.message, pattern, `${JSON.stringify(tail)}：${r.error.message}`);
  }
  assert.equal(svc.calls.length, 0, "服务从未被调用");
});

test("137a-C08b: 累计范围表很长时文本面只列前 10 条并如实写计数与截断（完整清单在 JSON）", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const twelve = Array.from({ length: 12 }, (_, i) => `p/${String(i).padStart(2, "0")}.js`);
  const scope = {
    inheritedChangedPaths: twelve, inheritedChangedCount: 300, inheritedChangedTruncated: true,
    uncoveredInheritedPaths: [twelve[11]], uncoveredInheritedCount: 1, uncoveredInheritedTruncated: false,
  };
  const text = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo)], makeConfig(repo), { continueRunFn: stub(refused("continuation_scope_incomplete", scope)) },
  ));
  assert.deepEqual(text.out.split("\n"), [
    `Run: ${PARENT}`,
    "Continuation refused: continuation_scope_incomplete",
    "Inherited changed paths: 300 (truncated)",
    ...twelve.slice(0, 10).map((p) => `  - ${p}`),
    "  ... 2 more; --format json lists all",
    "Uncovered inherited paths: 1",
    `  - ${twelve[11]}`,
  ]);
  assert.equal(text.exitCode, 1);
  const json = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])],
    makeConfig(repo), { continueRunFn: stub(refused("continuation_scope_incomplete", scope)) },
  ));
  assert.deepEqual(JSON.parse(json.out).inheritedChangedPaths, twelve, "JSON 给完整的有界清单");
});

test("137a-C10b: 受理结果的子 runId 形状不合法（它要被写进等待命令）→ fail closed、零输出", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  for (const bad of ["run child; rm -rf x", "../escape", "run\tid"]) {
    const r = await runCli(() => runsCommand(
      ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], makeConfig(repo),
      { continueRunFn: stub(accepted({ runId: bad })) },
    ));
    assert.ok(r.error, `${JSON.stringify(bad)} 必须报错`);
    assert.equal(r.out, "", "零输出——坏 id 不进任何命令行或输出");
  }
});

test("137a-K06/R06: correct 与 repackage 的授权根同样先证明——子目录在调用服务前原样报根证明失败", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const sub = join(repo, "nested");
  mkdirSync(sub);
  const correctSvc = stub({});
  const k = await runCli(() => runsCommand(
    ["correct", RUN, "--correction-id", "fix-1", "--prompt-file", promptFile, "--cwd", sub], makeConfig(repo), { correctRunFn: correctSvc },
  ));
  assert.ok(k.error);
  assert.match(k.error.message, /Git worktree top-level, not a subdirectory/);
  assert.equal(correctSvc.calls.length, 0);
  const repackageSvc = stub({});
  const p = await runCli(() => runsDeliveryCommand(
    ["repackage", RUN, "--allowed-path", "src", "--cwd", sub], makeConfig(repo), { getRunDeliveryRepackageFn: repackageSvc },
  ));
  assert.ok(p.error);
  assert.match(p.error.message, /Git worktree top-level, not a subdirectory/);
  assert.equal(repackageSvc.calls.length, 0);
  assert.equal(k.out + p.out, "");
});

// =====================================================================
// 分发、子命令闭集、帮助 ↔ 解析器旗标
// =====================================================================

test("137a-D01: 三条命令经分发器可达；continue/correct 进 runs 子命令闭集；repackage 不再被当成 runId 落到普通查询", async () => {
  assert.ok(RUNS_SUBCOMMANDS.includes("continue") && RUNS_SUBCOMMANDS.includes("correct"));
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const config = makeConfig(repo);
  // 经真实分发器：continue / correct 走 runsCommand，repackage 走 runsDeliveryCommand。
  const c = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], config, { continueRunFn: stub(accepted()) },
  ));
  assert.equal(JSON.parse(c.out).runId, CHILD);
  const k = await runCli(() => runsCommand(
    ["correct", ...CORRECTION_ARGS(promptFile, repo, ["--format", "json"])], config, { correctRunFn: stub({ runId: RUN, correctionId: "fix-1", outcome: "queued", reason: null }) },
  ));
  assert.equal(JSON.parse(k.out).outcome, "queued");
  const p = await runCli(() => runsDeliveryCommand(
    ["repackage", RUN, ...REPACKAGE_ARGS(repo, ["--format", "json"])], config,
    { getRunDeliveryRepackageFn: stub({ runId: RUN, deliveryCommit: "c".repeat(40), verificationStatus: "failed", source: "packaged", recoveryKind: "disallowed_scope", created: true }) },
  ));
  assert.equal(JSON.parse(p.out).status, "ok", "repackage 是子命令，不是 runId");
  // 普通 runs delivery 查询与既有子命令不受影响。
  // 普通查询照旧按 runId 读转录（这个 run 不存在 → 报错，而不是落到别的分支）。
  await assert.rejects(() => runsDeliveryCommand(["run_missing", "--format", "json"], config));
  await assert.rejects(() => runsCommand(["continuex", PARENT], config), /unknown runs subcommand: continuex/);
});

function syntaxFlags(line) {
  const flags = new Set();
  for (const m of line.split(" # ")[0].matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) flags.add(m[1]);
  return flags;
}

test("137a-D02: 帮助行的旗标集 = 各命令严格解析器认的旗标集（两面无漂移；帮助行写明 repackage 验证可能很久）", () => {
  const lines = HELP_TEXT.split("\n");
  const line = (head) => {
    const found = lines.filter((l) => l === `  ${head}` || l.startsWith(`  ${head} `));
    assert.equal(found.length, 1, `HELP_TEXT 恰有一行以 "${head}" 开头`);
    return found[0];
  };
  assert.deepEqual([...syntaxFlags(line("runs continue"))].sort(), [...RUNS_CONTINUE_FLAGS].sort());
  assert.deepEqual([...syntaxFlags(line("runs correct"))].sort(), [...RUNS_CORRECT_FLAGS].sort());
  assert.deepEqual([...syntaxFlags(line("runs delivery repackage"))].sort(), [...RUNS_DELIVERY_REPACKAGE_FLAGS].sort());
  const repackageLine = line("runs delivery repackage");
  assert.match(repackageLine, /后台/, "帮助写明：验证可能很久，宿主有后台命令行时放后台跑");
  assert.match(repackageLine, /--allowed-path P/, "帮助写出可重复的 --allowed-path");
  assert.match(line("runs continue"), /--prompt-file FILE/);
  assert.match(line("runs continue"), /--delivery-spec-file FILE/);
  assert.match(line("runs correct"), /--correction-id ID/);
});

// =====================================================================
// 第 137a 批续修 1（会审 kimi、sol 均 FIX_FIRST，Lead 逐条核过）
// =====================================================================

test("续修1-R1: deliveryCommit 先查类型——数组 [\"<合法 SHA>\"] 不被正则强转放行；runs delivery reverify 的 CLI 是同一道检查", async () => {
  const repo = makeRepo();
  const sha = "a".repeat(40);
  const good = { runId: RUN, deliveryCommit: sha, verificationStatus: "passed", source: "packaged", recoveryKind: "disallowed_scope", created: true };
  // repackage：改前正则把 ["<SHA>"] 强转成字符串放行，输出里落出一条数组。
  const r = await runCli(() => runsDeliveryCommand(
    ["repackage", RUN, ...REPACKAGE_ARGS(repo, ["--format", "json"])], makeConfig(repo),
    { getRunDeliveryRepackageFn: stub({ ...good, deliveryCommit: [sha] }) },
  ));
  assert.ok(r.error, "数组形态的 deliveryCommit 必须报错");
  assert.match(r.error.message, /deliveryCommit/);
  assert.equal(r.out, "", "零输出");
  // 同类路径：runs delivery reverify 的 CLI 原是同一行写法。
  const v = await runCli(() => runsDeliveryCommand(
    ["reverify", "run_reverify1", "--reason", "tooling_invalid", "--format", "json"], makeConfig(repo),
    {
      runDeliveryReverifyFn: stub({
        runId: "run_reverify1", deliveryCommit: [sha], attempt: 1, state: "created", reason: "tooling_invalid",
        verificationStatus: "passed", requested: true, outcomeRecorded: true,
      }),
    },
  ));
  assert.ok(v.error, "reverify：数组形态的 deliveryCommit 必须报错");
  assert.match(v.error.message, /deliveryCommit/);
  assert.equal(v.out, "", "零输出");
  // 字符串照常放行。
  const ok = await runCli(() => runsDeliveryCommand(
    ["repackage", RUN, ...REPACKAGE_ARGS(repo, ["--format", "json"])], makeConfig(repo), { getRunDeliveryRepackageFn: stub(good) },
  ));
  assert.equal(ok.error, null);
  assert.equal(JSON.parse(ok.out).deliveryCommit, sha);
});

test("续修1-C1: 全局等待预算——config.waitTimeout 给了就按 wao run 同一道门校验，先于一切副作用", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const svc = stub(accepted());
  for (const bad of [42, 600001, 1.5, "abc", Number.NaN, Infinity]) {
    const r = await runCli(() => runsCommand(
      ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], makeConfig(repo, { waitTimeout: bad }), { continueRunFn: svc },
    ));
    assert.ok(r.error, `waitTimeout=${String(bad)} 必须报错`);
    assert.match(r.error.message, /^Invalid waitTimeout: must be an integer in \[1000, 600000\]/, `waitTimeout=${String(bad)}：${r.error.message}`);
    assert.equal(r.out, "", "零输出");
  }
  assert.equal(svc.calls.length, 0, "服务从未被调用");
  // 先于一切副作用：提示词文件不存在时，也先报等待预算而不是读文件失败。
  const early = await runCli(() => runsCommand(
    ["continue", PARENT, "--prompt-file", join(repo, "no-such-file.txt"), "--cwd", repo], makeConfig(repo, { waitTimeout: 42 }), { continueRunFn: stub(accepted()) },
  ));
  assert.match(early.error.message, /^Invalid waitTimeout:/);
  // 缺省（undefined / null）与合法边界值：照常受理，值原样交给服务。
  for (const fine of [undefined, null, 1000, 600000]) {
    const s = stub(accepted());
    const r = await runCli(() => runsCommand(
      ["continue", ...continueArgs(promptFile, repo, ["--format", "json"])], makeConfig(repo, { waitTimeout: fine }), { continueRunFn: s },
    ));
    assert.equal(r.error, null, `waitTimeout=${String(fine)}：${r.error?.message}`);
    assert.equal(s.calls[0].globalWaitTimeout, fine);
    assert.equal(r.exitCode, 0);
  }
});

test("续修1-C2: 受理回执的等待命令带上调用方给的 --run-dir（含空格加引号）；放不下实际值写占位 <DIR>，任何长度都不抛错", async () => {
  const repo = makeRepo();
  const promptFile = writePromptFile(repo);
  const waitPre = `Background run accepted. Before ending the turn, keep a wait attached: wao runs wait ${CHILD}`;
  const wait = `${waitPre} --until-settled`;
  const nextStepOf = async (runDirFlag) => {
    const r = await runCli(() => runsCommand(
      ["continue", ...continueArgs(promptFile, repo, ["--format", "json"]), ...(runDirFlag === null ? [] : ["--run-dir", runDirFlag])],
      makeConfig(repo), { continueRunFn: stub(accepted()) },
    ));
    assert.equal(r.error, null, `--run-dir 长度 ${runDirFlag?.length}：${r.error?.message}`);
    assert.equal(r.exitCode, 0, "受理照常退出 0");
    assert.equal(JSON.parse(r.out).runId, CHILD, "runId 照给");
    assert.equal(JSON.parse(r.out).accepted, true);
    return JSON.parse(r.out).nextStep;
  };
  // 没给 --run-dir：等待命令不带（照抄落回缺省目录就对）。
  assert.equal(await nextStepOf(null), `${wait}.${CONTINUE_INHERITED_DELIVERY_NOTE}`);
  // 给了：等待命令带同一个值（照抄才找得到子运行）。
  assert.equal(await nextStepOf("runs2"), `${waitPre} --run-dir runs2 --until-settled.${CONTINUE_INHERITED_DELIVERY_NOTE}`);
  // 含空白的路径加双引号（与 runs wait 多目标重挂行同一规则）。
  assert.equal(await nextStepOf("C:/my runs"), `${waitPre} --run-dir "C:/my runs" --until-settled.${CONTINUE_INHERITED_DELIVERY_NOTE}`);
  // 边界：恰好放得下的最长值用实际值，再长一个字符换占位。
  const room = 480 - `${wait} --run-dir .${CONTINUE_INHERITED_DELIVERY_NOTE}`.length;
  const fits = "r".repeat(room);
  assert.equal(await nextStepOf(fits), `${waitPre} --run-dir ${fits} --until-settled.${CONTINUE_INHERITED_DELIVERY_NOTE}`);
  assert.equal(await nextStepOf(`${fits}r`), `${waitPre} --run-dir <DIR> --until-settled.${CONTINUE_INHERITED_DELIVERY_NOTE}`);
  // 任何长度都不让已受理的回执变成报错：很长的路径写占位。
  for (const len of [400, 5000]) {
    assert.equal(await nextStepOf("d/".repeat(len)), `${waitPre} --run-dir <DIR> --until-settled.${CONTINUE_INHERITED_DELIVERY_NOTE}`);
  }
  // 显式给了合同（无继承后缀）时同样带上 --run-dir。
  const spec = join(repo, "delivery.json");
  writeFileSync(spec, JSON.stringify({ allowedPaths: ["src"], verificationCommands: ["npm test"] }), "utf8");
  const explicit = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--format", "json", "--run-dir", "runs2", "--delivery-spec-file", spec])],
    makeConfig(repo), { continueRunFn: stub(accepted()) },
  ));
  assert.equal(JSON.parse(explicit.out).nextStep, `${waitPre} --run-dir runs2 --until-settled.`);
  // 文本面同款。
  const text = await runCli(() => runsCommand(
    ["continue", ...continueArgs(promptFile, repo, ["--run-dir", "runs2"])], makeConfig(repo), { continueRunFn: stub(accepted()) },
  ));
  assert.equal(text.exitCode, 0);
  assert.equal(text.out.split("\n").at(-1), `Next step: ${waitPre} --run-dir runs2 --until-settled.${CONTINUE_INHERITED_DELIVERY_NOTE}`);
});

const CLI_PATH = join(import.meta.dirname, "..", "..", "src", "cli.js");

/** 真实子进程跑一次 CLI（入口同 `node src/cli.js …`）：退出码与两路输出。 */
function runCliProcess(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("续修1-SUBPROC: 真实子进程——三条命令指向不存在的运行：闭集拒绝、退出码 1、stdout 是拒绝输出（真实服务，不注入）", async () => {
  const repo = makeRepo();
  const runDir = join(repo, "runs-subproc"); // 空的临时运行目录
  mkdirSync(runDir, { recursive: true });
  const promptFile = writePromptFile(repo);
  // runs continue：不存在的父运行 → parent_not_found。
  const c = runCliProcess(["runs", "continue", PARENT, "--prompt-file", promptFile, "--cwd", repo, "--run-dir", runDir], repo);
  assert.equal(c.status, 1, `runs continue 退出码 1（stderr：${c.stderr}）`);
  assert.equal(c.stdout, `Run: ${PARENT}\nContinuation refused: parent_not_found\n`);
  assert.equal(c.stderr, "", "闭集拒绝不写 stderr");
  // runs correct：不存在的运行 → unknown_run。
  const k = runCliProcess(["runs", "correct", RUN, "--correction-id", "fix-1", "--prompt-file", promptFile, "--cwd", repo, "--run-dir", runDir], repo);
  assert.equal(k.status, 1, `runs correct 退出码 1（stdout：${k.stdout}；stderr：${k.stderr}）`);
  assert.equal(k.stdout, `Run: ${RUN}\nCorrection: fix-1\nOutcome: rejected (unknown_run)\n`);
  assert.equal(k.stderr, "");
  // runs delivery repackage：不存在的运行 → run_not_found（JSON 面）。
  const p = runCliProcess(["runs", "delivery", "repackage", RUN, "--allowed-path", "src", "--cwd", repo, "--run-dir", runDir, "--format", "json"], repo);
  assert.equal(p.status, 1, `repackage 退出码 1（stdout：${p.stdout}；stderr：${p.stderr}）`);
  assert.deepEqual(JSON.parse(p.stdout), { status: "ok", runId: RUN, rejectionReason: "run_not_found" });
  assert.equal(p.stderr, "");
  // 拒绝零副作用：临时运行目录里没有落下任何文件。
  assert.deepEqual(readdirSync(runDir), []);
});
