// test/roleContract.test.js
//
// M11-5: Worker Role Contract Parity — TDD tests.
//
// Proves that a configured `agent.systemPrompt` (role contract) is loaded by
// a shared, backend-neutral loader, validated before transcript/spawn, and
// delivered exactly once to each process backend (claude-code / codex /
// the process backends) without leaking into the transcript or letting the Lead/model
// override it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadRoleContract } from "../../src/application/roleContract.js";
import { ClaudeCodeBackend } from "../../src/backends/claudeCode.js";
import { CodexBackend } from "../../src/backends/codex.js";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function writeRole(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

// Access the buildArgs of a backend via the stored instance property.
function getBuildArgs(backend) {
  return backend.buildArgs.bind(backend);
}

// ===== A. Shared loader =====

// ---------------------------------------------------------------------
// A1: valid role contract loads (regular file, strict UTF-8, non-empty,
//     no NUL, ≤4096 bytes).
// ---------------------------------------------------------------------
test("M11-5-A1: loadRoleContract returns content for a valid role file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a1-"));
  try {
    const p = writeRole(dir, "role.md", "You are a tester. 只验证不修 bug.\n");
    const rc = loadRoleContract(p);
    assert.equal(rc, "You are a tester. 只验证不修 bug.\n");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A2: fail closed — missing file.
// ---------------------------------------------------------------------
test("M11-5-A2: loadRoleContract throws on missing file (no spawn, no transcript)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a2-"));
  try {
    const missing = join(dir, "does-not-exist.md");
    assert.throws(() => loadRoleContract(missing), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A3: fail closed — directory (not a regular file).
// ---------------------------------------------------------------------
test("M11-5-A3: loadRoleContract throws on directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a3-"));
  try {
    assert.throws(() => loadRoleContract(dir), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A4: fail closed — empty file.
// ---------------------------------------------------------------------
test("M11-5-A4: loadRoleContract throws on empty file", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a4-"));
  try {
    const p = writeRole(dir, "empty.md", "");
    assert.throws(() => loadRoleContract(p), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A5: fail closed — exceeds 4096 bytes.
// ---------------------------------------------------------------------
test("M11-5-A5: loadRoleContract throws on file > 4096 bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a5-"));
  try {
    const p = writeRole(dir, "big.md", "x".repeat(4097));
    assert.throws(() => loadRoleContract(p), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A6: fail closed — illegal UTF-8.
// ---------------------------------------------------------------------
test("M11-5-A6: loadRoleContract throws on illegal UTF-8", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a6-"));
  try {
    const p = join(dir, "bad-utf8.md");
    // 0xFF is not valid UTF-8.
    writeFileSync(p, Buffer.from([0xFF, 0xFE, 0x41]));
    assert.throws(() => loadRoleContract(p), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A7: fail closed — contains NUL byte.
// ---------------------------------------------------------------------
test("M11-5-A7: loadRoleContract throws on NUL byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a7-"));
  try {
    const p = writeRole(dir, "nul.md", "before\x00after");
    assert.throws(() => loadRoleContract(p), /role contract/i);
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// A8: 4096-byte boundary — exactly 4096 bytes is OK.
// ---------------------------------------------------------------------
test("M11-5-A8: loadRoleContract accepts exactly 4096 bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-a8-"));
  try {
    const p = writeRole(dir, "max.md", "x".repeat(4096));
    const rc = loadRoleContract(p);
    assert.equal(rc.length, 4096);
  } finally {
    cleanupDir(dir);
  }
});

// ===== B. Backend transport =====

// ---------------------------------------------------------------------
// B1: claude-code uses --append-system-prompt-file exactly once when role is
//     present; task prompt is NOT concatenated with role.
// ---------------------------------------------------------------------
test("M11-5-B1: claude-code buildArgs uses --append-system-prompt <content> once, task not concatenated", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-b1-"));
  try {
    const backend = new ClaudeCodeBackend();
    const buildArgs = getBuildArgs(backend);
    const agent = {};
    // M11-5 CTO rework: claude uses roleContract (content, not path) to
    // eliminate TOCTOU. --append-system-prompt <content> exactly once.
    const task = { prompt: "TASK_MARKER", roleContract: "ROLE_MARKER_CLAUDE" };
    const args = buildArgs(agent, task);
    const flagIdx = args.indexOf("--append-system-prompt");
    assert.ok(flagIdx >= 0, "has --append-system-prompt");
    assert.equal(args.filter((a) => a === "--append-system-prompt").length, 1, "flag exactly once");
    // content follows the flag
    assert.ok(args[flagIdx + 1]?.includes("ROLE_MARKER_CLAUDE"), "role content follows the flag");
    // task prompt is not concatenated with role; it goes over stdin, not argv
    assert.ok(!args[flagIdx + 1].includes("TASK_MARKER"), "task prompt not concatenated with role");
    assert.ok(!args.includes("TASK_MARKER"), "task prompt goes over stdin, not argv");
    // no path-based flag (TOCTOU elimination)
    assert.ok(!args.includes("--append-system-prompt-file"), "no path-based file flag (TOCTOU eliminated)");
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// B2: codex uses -c developer_instructions=<role> exactly once; task is a
//     separate positional arg; never uses model_instructions_file.
// ---------------------------------------------------------------------
test("M11-5-B2: codex buildArgs uses -c developer_instructions once, task separate, no model_instructions_file", () => {
  const backend = new CodexBackend();
  const buildArgs = getBuildArgs(backend);
  const agent = {};
  const task = { prompt: "TASK_MARKER", roleContract: "ROLE_MARKER_CODEX" };
  const args = buildArgs(agent, task);
  // -c developer_instructions=<role> present (-c and its value are separate args)
  assert.ok(args.includes("-c"), "has -c flag");
  const devInstr = args.find((a) => typeof a === "string" && a.includes("developer_instructions"));
  assert.ok(devInstr, "has developer_instructions value");
  // contains the role content
  assert.ok(devInstr.includes("ROLE_MARKER_CODEX"), "developer_instructions carries role content");
  // exactly once
  assert.equal(args.filter((a) => typeof a === "string" && a.includes("developer_instructions")).length, 1,
    "developer_instructions exactly once");
  // task prompt NOT concatenated into developer_instructions; it goes over stdin ("-" placeholder)
  assert.ok(!devInstr.includes("TASK_MARKER"), "task prompt not concatenated into developer_instructions");
  assert.equal(args[args.length - 1], "-", "prompt slot is the stdin placeholder");
  // never model_instructions_file
  assert.ok(!args.some((a) => typeof a === "string" && a.includes("model_instructions_file")),
    "never uses model_instructions_file");
});

// ---------------------------------------------------------------------
// B2b: codex multi-line role contract — TOML escaping covers newline/CR/tab
//      (reviewer round 1 found single-line-only test missed multi-line bug).
// ---------------------------------------------------------------------
test("M11-5-B2b: codex multi-line role contract — newline/CR/tab escaped for valid TOML", () => {
  const backend = new CodexBackend();
  const buildArgs = getBuildArgs(backend);
  // Realistic multi-line role (Markdown, like config/roles/*.md).
  const role = "You are a tester.\nOnly verify, never fix bugs.\r\nTab:\there\nMARKER_MULTI_LINE";
  const args = buildArgs({}, { prompt: "do task", roleContract: role });
  const devInstr = args.find((a) => typeof a === "string" && a.includes("developer_instructions"));
  assert.ok(devInstr, "has developer_instructions");
  // The value must be a valid TOML basic string: no raw newlines/CR/tab inside quotes.
  // Extract the quoted value.
  const match = devInstr.match(/developer_instructions="(.*)"$/);
  assert.ok(match, "developer_instructions value is quoted");
  const value = match[1];
  // No raw newline/CR inside the TOML string (they must be escaped as \n / \r).
  assert.ok(!value.includes("\n"), "no raw newline in TOML value (escaped)");
  assert.ok(!value.includes("\r"), "no raw CR in TOML value (escaped)");
  assert.ok(!value.includes("\t"), "no raw tab in TOML value (escaped)");
  // The escaped forms ARE present.
  assert.ok(value.includes("\\n"), "newline escaped to \\n");
  assert.ok(value.includes("\\r"), "CR escaped to \\r");
  assert.ok(value.includes("\\t"), "tab escaped to \\t");
  // The marker survived the round-trip.
  assert.ok(value.includes("MARKER_MULTI_LINE"), "role marker survived escaping");
});

// ---------------------------------------------------------------------
// B4: no roleContract → both process backends behave identically to legacy
//     (argv unchanged, no role-related flags).
// ---------------------------------------------------------------------
test("M11-5-B4: no roleContract → both process backends legacy-compatible argv", () => {
  for (const BackendClass of [ClaudeCodeBackend, CodexBackend]) {
    const backend = new BackendClass();
    const buildArgs = getBuildArgs(backend);
    const agent = {};
    const task = { prompt: "JUST_TASK" };
    const args = buildArgs(agent, task);
    // no role-related flags
    assert.ok(!args.some((a) => typeof a === "string" && a.includes("append-system-prompt")),
      `${BackendClass.name}: no --append-system-prompt when no role`);
    assert.ok(!args.some((a) => typeof a === "string" && a.includes("developer_instructions")),
      `${BackendClass.name}: no developer_instructions when no role`);
    // task prompt still delivered: on argv, or over stdin for backends that declare it
    const onArgv = args.some((a) => a === "JUST_TASK" || (typeof a === "string" && a.includes("JUST_TASK")));
    assert.equal(onArgv, backend.promptViaStdin !== true,
      `${BackendClass.name}: task prompt on argv unless it goes over stdin`);
  }
});

// ---------------------------------------------------------------------
// B5: claude-code no longer silently ignores a missing role file when
//     systemPrompt is configured — it must fail (the loader validates
//     earlier, so buildArgs receives a guaranteed-valid roleContract, but
//     the old existsSync-skip logic must be gone).
// ---------------------------------------------------------------------
test("M11-5-B5: claude-code buildArgs has no existsSync-skip branch for systemPrompt", () => {
  // Read the source and confirm the silent-skip pattern is removed.
  const src = readFileSync(resolve(process.cwd(), "src/backends/claudeCode.js"), "utf8");
  // The old pattern: if (existsSync(p)) { push file flag }
  // New pattern must NOT silently skip — roleContract comes from the loader.
  assert.ok(!/if\s*\(\s*existsSync\s*\(\s*p\s*\)\s*\)/.test(src),
    "claudeCode.js no longer has 'if (existsSync(p))' silent-skip branch");
});

// ===== C. Security: no override, no leak, resume parity =====

// ---------------------------------------------------------------------
// C1: MCP run_dispatch input schema is strict and does NOT accept any role
//     override (systemPrompt / roleContract / rolePath). The Lead/model
//     cannot override the registry-selected role.
// ---------------------------------------------------------------------
test("M11-5-C1: MCP run_dispatch schema rejects role override keys", async () => {
  const { createWaoMcpServer } = await import("../../src/mcp/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-m115-c1-"));
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      // Attempt to override role via extra keys — schema is strict, must reject.
      for (const bad of [
        { agentId: "w", prompt: "x", systemPrompt: "evil" },
        { agentId: "w", prompt: "x", roleContract: "evil" },
        { agentId: "w", prompt: "x", rolePath: "evil" },
      ]) {
        const res = await client.callTool({ name: "run_dispatch", arguments: bad });
        // Strict schema rejects → isError (SDK validation error collapsed to safe text).
        assert.ok(res.isError, `rejected role override attempt: ${JSON.stringify(Object.keys(bad))}`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// C2: role content never enters the transcript. RunManager persists only
//     the original task prompt in prompt.sent; roleContract is passed to
//     the backend out-of-band. Verified by source inspection (the contract
//     is structural, not a one-off runtime check).
// ---------------------------------------------------------------------
test("M11-5-C2: RunManager source never persists roleContract to transcript", () => {
  const src = readFileSync(resolve(process.cwd(), "src/runManager.js"), "utf8");
  // transcript.append calls must not carry roleContract/roleContractPath.
  // Find every transcript.append call and assert none mention roleContract.
  const appendCalls = src.match(/transcript\.append\([^)]+\)/g) || [];
  assert.ok(appendCalls.length > 0, "found transcript.append calls to inspect");
  for (const call of appendCalls) {
    assert.ok(!/roleContract/i.test(call),
      `transcript.append must not carry roleContract: ${call.slice(0, 80)}`);
  }
});

// ---------------------------------------------------------------------
// C3: resume path also loads roleContract (source guard). The resume spawn
//     call must pass roleContract/roleContractPath, not just prompt.
// ---------------------------------------------------------------------
test("M11-5-C3: resume spawn call passes roleContract (no bypass)", () => {
  const src = readFileSync(resolve(process.cwd(), "src/runManager.js"), "utf8");
  // M11-8B: resume composes the role contract with the identity header through
  // composeRoleContractWithIdentity, but still loads via loadRoleContract and
  // passes the result to backend.spawn. 0045 P1/W2 结构更新（先定源、单点组装，
  // WQ-GRN-07）：两个加载分支（钉优先 + legacy 注册表）都经 loadRoleContract，
  // 组装恰一处，结果到 spawn——结构钉按此翻新，意图不变。
  assert.ok(/loadRoleContract\(resumeRolePin\.systemPrompt\)/.test(src),
    "resume 钉优先分支经 loadRoleContract 加载钉住角色（0045 §1.3）");
  assert.ok(/loadRoleContract\(agent\.systemPrompt\)/.test(src),
    "resume legacy 分支经 loadRoleContract 从注册表加载（行为保留）");
  assert.ok(/resumeRoleContract\s*=\s*resumeRoleSource === undefined\s*\?\s*undefined\s*:?\s*composeRoleContractWithIdentity\(/.test(src),
    "resume 单点组装（WQ-GRN-07：composeRoleContractWithIdentity 全仓恰 start+resume 两处）");
  // The resume backend.spawn call must include roleContract.
  assert.ok(/backend\.spawn\([^)]*roleContract:\s*resumeRoleContract/s.test(src),
    "resume backend.spawn passes roleContract");
});

// ── 2026-10-12：越界停手上报语的识别（控制面与合同指令同一字面量）──────────────

test("declaredScopeExpansion: 合同指令携带同一标记；只认最终 assistant 回复里行首的上报语", async () => {
  const { composeDeliveryExecutionContract, declaredScopeExpansion, SCOPE_EXPANSION_MARKER } =
    await import("../../src/application/roleContract.js");
  assert.ok(
    composeDeliveryExecutionContract({ allowedPaths: ["src"] }).includes(`${SCOPE_EXPANSION_MARKER}: <repo-relative-path>`),
    "合同指令与识别用同一个标记字面量",
  );
  const text = (t) => [{ type: "text", text: t }];
  const asst = (t) => ({ role: "assistant", parts: text(t) });
  assert.equal(declaredScopeExpansion([asst("SCOPE_EXPANSION_REQUIRED: Temp — reason")]), true);
  assert.equal(declaredScopeExpansion([asst("`SCOPE_EXPANSION_REQUIRED: Temp — reason`\n- files: none")]), true, "反引号包裹");
  assert.equal(declaredScopeExpansion([asst("Summary:\n- SCOPE_EXPANSION_REQUIRED: docs/x.md — reason")]), true, "列表项行首");
  // RunManager 收集形状：role 在 info.role
  assert.equal(declaredScopeExpansion([{ info: { role: "assistant" }, parts: text("SCOPE_EXPANSION_REQUIRED: a — b") }]), true);
  // 只看最后一条 assistant：前面的复述不算
  assert.equal(declaredScopeExpansion([asst("SCOPE_EXPANSION_REQUIRED: a — b"), asst("Done. Changed files: src/a.js")]), false);
  // 句中提及不算上报
  assert.equal(declaredScopeExpansion([asst("I would report SCOPE_EXPANSION_REQUIRED: only if needed.")]), false);
  assert.equal(declaredScopeExpansion([{ role: "user", parts: text("SCOPE_EXPANSION_REQUIRED: a — b") }]), false, "user 消息不算");
  // 会审 sol 必改 5：空声明、合同模板原文、围栏代码块里的复述都不算上报
  assert.equal(declaredScopeExpansion([asst("SCOPE_EXPANSION_REQUIRED:")]), false, "只有标记没有路径与理由");
  assert.equal(declaredScopeExpansion([asst("SCOPE_EXPANSION_REQUIRED: docs/x.md —")]), false, "缺理由");
  assert.equal(declaredScopeExpansion([asst("SCOPE_EXPANSION_REQUIRED: <repo-relative-path> — <reason>")]), false, "合同模板占位符原文");
  assert.equal(declaredScopeExpansion([asst("Done.\n```\nSCOPE_EXPANSION_REQUIRED: docs/x.md — need it\n```")]), false, "围栏代码块内不算");
  assert.equal(declaredScopeExpansion([asst("SCOPE_EXPANSION_REQUIRED: docs/x.md - need to edit docs")]), true, "连字符分隔也接受");
  // 复审 sol 席残留反例：~~~ 围栏、反引号包裹的模板占位符
  assert.equal(declaredScopeExpansion([asst("Done.\n~~~text\nSCOPE_EXPANSION_REQUIRED: docs/x.md — need it\n~~~")]), false, "~~~ 围栏内不算");
  assert.equal(declaredScopeExpansion([asst("SCOPE_EXPANSION_REQUIRED: `<repo-relative-path>` — <reason>")]), false, "反引号包裹的模板占位符");
  assert.equal(declaredScopeExpansion([asst("SCOPE_EXPANSION_REQUIRED: `docs/x.md` — need to edit docs")]), true, "反引号包裹的真实路径照常算");
  assert.equal(declaredScopeExpansion([]), false);
  assert.equal(declaredScopeExpansion(undefined), false);
});

// ── 控制面执行合同：共用条款 + 只读执行合同 + 交付合同补齐 ───────────────────
// 会审定稿条款：两条共用条款模块内只定义一次，只读合同与交付合同引用同一份；
// 条款文字不得改写（改动须走会审定稿）。

const SHARED_CLAUSE_SECRETS_PREFIX = "- Do not read credential or secret stores";
const SHARED_CLAUSE_FINISH_PREFIX = "- Do not end your turn while a command you started is still running";

test("只读执行合同：三条只读条款 + 两条共用条款在场，交付合同不带只读头", async () => {
  const { composeReadOnlyExecutionContract, composeDeliveryExecutionContract } =
    await import("../../src/application/roleContract.js");
  const ro = composeReadOnlyExecutionContract();
  assert.ok(ro.startsWith("READ-ONLY EXECUTION CONTRACT (WAO control plane"), "只读合同头在场");
  assert.match(ro, /may narrow these permissions further, never widen them/, "只读合同头声明收窄合法");
  assert.match(ro, /Do not edit, create or delete project files in your working directory/, "只读条款①：工作目录内不做项目文件写");
  assert.match(ro, /Running the project's existing test or build commands that the task asks for is allowed/, "只读条款①：任务要求的测试/构建命令放行");
  assert.match(ro, /run no git command that changes the index, HEAD, refs, configuration, worktrees or remotes/, "只读条款②：改写性 git 命令禁令");
  assert.match(ro, /Read-only forms \(log, show, diff, grep, status, branch --list, worktree list, config --get\) are fine/, "只读条款②：只读形式放行");
  assert.match(ro, /create a new directory under the system temporary directory and write only there/, "只读条款③：实验写系统临时目录");
  assert.match(ro, /Never write to, or run a writing git command against, your working directory, the source repository or any other existing checkout/, "只读条款③：绝不写既有检出");
  // 两条共用条款逐字在场
  const roLines = ro.split("\n");
  assert.ok(roLines.some((l) => l.startsWith(SHARED_CLAUSE_SECRETS_PREFIX)), "共用条款（凭据/环境变量）在场");
  assert.ok(roLines.some((l) => l.startsWith(SHARED_CLAUSE_FINISH_PREFIX)), "共用条款（命令收尾）在场");
  // 交付合同不带只读头；只读合同不带交付头
  const delivery = composeDeliveryExecutionContract();
  assert.ok(!ro.includes("DELIVERY EXECUTION CONTRACT"), "只读合同不夹带交付合同正文");
  assert.ok(!delivery.includes("READ-ONLY EXECUTION CONTRACT"), "交付合同不夹带只读合同正文");
});

test("两条共用条款在只读合同与交付合同里逐字同一份（各出现恰一次）", async () => {
  const { composeReadOnlyExecutionContract, composeDeliveryExecutionContract } =
    await import("../../src/application/roleContract.js");
  const ro = composeReadOnlyExecutionContract();
  const delivery = composeDeliveryExecutionContract();
  const scoped = composeDeliveryExecutionContract({ allowedPaths: ["src"] });
  for (const prefix of [SHARED_CLAUSE_SECRETS_PREFIX, SHARED_CLAUSE_FINISH_PREFIX]) {
    const clause = ro.split("\n").find((l) => l.startsWith(prefix));
    assert.ok(clause, `只读合同携带共用条款：${prefix}`);
    assert.ok(delivery.includes(clause), "交付合同逐字包含同一份条款");
    assert.ok(scoped.includes(clause), "带 allowedPaths 的交付合同同样携带");
    assert.equal(delivery.split(clause).length - 1, 1, "交付合同内恰一次");
    assert.equal(ro.split(clause).length - 1, 1, "只读合同内恰一次");
  }
  // 共用条款是整行（不是拼进别的条款）
  assert.ok(delivery.split("\n").some((l) => l === ro.split("\n").find((l2) => l2.startsWith(SHARED_CLAUSE_SECRETS_PREFIX))),
    "同一份 = 整行逐字相等，不是重写");
});

// 第 149 批：worker 曾按命令行匹配（含本运行 run id）停 node 进程，把 WAO 自己的 runner
// 一并停掉，运行无终态事件。命令收尾共用条款补一句：只经启动它的工具或确切 pid 停进程，
// 不按名称/命令行/路径匹配。只读合同与交付合同引用同一份常量，两份都得有。
test("第 149 批: 命令收尾条款禁止按名称/命令行/路径匹配停进程——只读、交付、带授权清单的交付合同各一次", async () => {
  const { composeReadOnlyExecutionContract, composeDeliveryExecutionContract } =
    await import("../../src/application/roleContract.js");
  const previousSentence = "Stop any server or process you started before you answer; leave nothing running.";
  const stopRule = "Stop only processes your own commands started, by the exact process id you got when starting them or via the tool that started them; never match by name, command line or path: this run's WAO supervisor carries the run id on its command line, and stopping it ends your run.";
  // 命令行预算：句子（含前导空格）≤280 字符。修正一的 323 字符句让 codex .cmd 带 15 条
  // 授权路径的样本被预检拒绝（首轮 312 字符时还剩余量）——长度上限钉在这里。
  assert.ok(stopRule.length + 1 <= 280, `停进程句 ${stopRule.length + 1} 字符 ≤ 280`);
  for (const [label, contract] of [
    ["只读合同", composeReadOnlyExecutionContract()],
    ["交付合同", composeDeliveryExecutionContract()],
    ["带授权清单的交付合同", composeDeliveryExecutionContract({ allowedPaths: ["src"] })],
  ]) {
    const clause = contract.split("\n").find((l) => l.startsWith(SHARED_CLAUSE_FINISH_PREFIX));
    assert.ok(clause, `${label}携带命令收尾条款`);
    assert.ok(clause.endsWith(`${previousSentence} ${stopRule}`), `${label}：原句保留，停进程边界句紧随其后`);
    assert.equal(contract.split(stopRule).length - 1, 1, `${label}：边界句恰一次`);
    // 事实核对：runner 命令行只带 run id / run dir / registry / 可选 cwd，没有工作树路径；
    // 也不留"先扫描、记下 pid、再按 pid 停"的读法。
    assert.ok(!clause.includes("worktree path"), `${label}：不再声称命令行带工作树路径`);
    assert.ok(!clause.includes("noted down") && !clause.includes("your own command reported"), `${label}：pid 只来自自己启动时取得`);
  }
});

// 第 149 批修正一：预算守卫用真实组装——RunManager.start 的拼法（交付/只读合同 + "\n\n---\n\n"
// + composeRoleContractWithIdentity 的身份头与 WQ 纪律 + 角色正文），再走 claude-code 与
// codex 各自真实的 buildArgs，最后按 compileInvocation 的现有口径断言 .cmd 与 .exe 预算。
test("第 149 批: 真实组装的交付/只读合同（身份头 + WQ 纪律 + 最长角色）经两个后端的真实 argv 仍在 .cmd 与 .exe 预算内", async () => {
  const { composeDeliveryExecutionContract, composeReadOnlyExecutionContract, composeRoleContractWithIdentity, loadRoleContract } =
    await import("../../src/application/roleContract.js");
  const { compileInvocation } = await import("../../src/backends/processBackend.js");
  const rolesDir = resolve(import.meta.dirname, "../../config/roles");
  const roles = readdirSync(rolesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ id: f.slice(0, -3), body: loadRoleContract(`config/roles/${f}`) }))
    .sort((a, b) => b.body.length - a.body.length);
  assert.ok(roles.length > 0, "有真实角色文件");
  const claude = new ClaudeCodeBackend();
  const codex = new CodexBackend();
  const agent = { model: { id: "claude-opus-5-5" }, reasoning: { effort: "xhigh" } };
  const paths = ["src", "test", "docs", "scripts", "config"];
  // 最长角色 + 两种身份头（agentId 头与 lane/role 头，取更长者都覆盖）。
  const longest = roles[0];
  const bodies = [
    composeRoleContractWithIdentity({ roleContract: longest.body, agentId: "coder_hq" }),
    composeRoleContractWithIdentity({ roleContract: longest.body, agentId: "coder_hq", identity: { laneId: "coder_hq", roleId: longest.id } }),
  ];
  for (const role of bodies) {
    assert.ok(role.includes("WORKER EVIDENCE DISCIPLINE"), "真实正文带 WQ 纪律");
    for (const [backendLabel, backend] of [["claude-code", claude], ["codex", codex]]) {
      const shapes = [
        ["交付", `${composeDeliveryExecutionContract({ allowedPaths: paths, backendSupplement: backend.deliveryContractSupplement })}\n\n---\n\n${role}`],
        ["只读", `${composeReadOnlyExecutionContract()}\n\n---\n\n${role}`],
      ];
      for (const [shape, roleContract] of shapes) {
        const builtArgs = getBuildArgs(backend)(agent, { prompt: "p", roleContract });
        for (const binary of ["C:\\bin\\t.cmd", "C:\\bin\\t.exe"]) {
          assert.doesNotThrow(
            () => compileInvocation({ binary, builtArgs, platform: "win32" }),
            `${backendLabel} ${shape} ${binary} 在预算内`,
          );
        }
      }
    }
  }
});

// 第 149 批修正二：紧样本——codex 的 .cmd 兜底路径（TOML 转义 + cmd.exe 引号，最贵的一条）、
// 最长角色 + 结构化身份头、codex 补充条款、15 条各 ~80 字符的授权路径。首轮（312 字符的停进程句）
// 在这个样本上还剩约 10 字符，修正一的 323 字符句让它被预检拒绝；缩短后要回约 40 字符。
// .cmd 预算含 ComSpec 的保守引号上界，样本里钉死 ComSpec，结果不随机器环境变。
test("第 149 批: codex .cmd 带 15 条授权路径的紧样本在预算内", async () => {
  const { composeDeliveryExecutionContract, composeRoleContractWithIdentity, loadRoleContract } =
    await import("../../src/application/roleContract.js");
  const { compileInvocation } = await import("../../src/backends/processBackend.js");
  const rolesDir = resolve(import.meta.dirname, "../../config/roles");
  const longest = readdirSync(rolesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ id: f.slice(0, -3), body: loadRoleContract(`config/roles/${f}`) }))
    .sort((a, b) => b.body.length - a.body.length)[0];
  const codex = new CodexBackend();
  const agent = { model: { id: "gpt-5.5" }, reasoning: { effort: "xhigh" } };
  const paths = Array.from({ length: 15 }, (_, i) => `src/${"d".repeat(71)}/f${String(i).padStart(2, "0")}.js`);
  const savedComSpec = process.env.ComSpec;
  process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
  try {
    for (const identity of [undefined, { laneId: "coder_hq", roleId: longest.id }]) {
      const role = composeRoleContractWithIdentity({ roleContract: longest.body, agentId: "coder_hq", ...(identity ? { identity } : {}) });
      const roleContract = `${composeDeliveryExecutionContract({ allowedPaths: paths, backendSupplement: codex.deliveryContractSupplement })}\n\n---\n\n${role}`;
      const builtArgs = getBuildArgs(codex)(agent, { prompt: "p", roleContract });
      assert.doesNotThrow(
        () => compileInvocation({ binary: "C:\\bin\\t.cmd", builtArgs, platform: "win32" }),
        `codex .cmd 15 条授权路径（${identity ? "lane/role" : "agentId"} 身份头）在预算内`,
      );
    }
  } finally {
    if (savedComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = savedComSpec;
  }
});

test("交付合同补齐：新写入边界行与 git 行扩展在场，共用条款在 allowedPaths 段之前", async () => {
  const { composeDeliveryExecutionContract, composeReadOnlyExecutionContract } =
    await import("../../src/application/roleContract.js");
  const base = composeDeliveryExecutionContract();
  const lines = base.split("\n");
  // 新增行（逐字在场）
  assert.ok(lines.some((l) => l === "- Every file you create or modify with your tools, including temporary files, probes and scratch, must be inside it; put scratch under .wao/runs/. A tool write or write intent outside it ends the run as failed (workdir_escape). This check is not an OS sandbox: do not write outside this directory by any other means either, except throwaway repositories and files your test commands create under the system temporary directory."),
    "写入边界新行逐字在场");
  // git 行扩展（逐字在场）
  assert.ok(lines.some((l) => l === "- Do NOT run git add, git commit, git reset, git checkout, git switch, git rebase, git merge, or git tag. This applies to this workspace and every other existing checkout, not to throwaway repositories your test commands create under the system temporary directory."),
    "git 禁令行的跨检出/一次性仓库扩展逐字在场");
  // 既有行字节不变（改动前九行原文逐字保留）
  const previousLines = [
    "DELIVERY EXECUTION CONTRACT (WAO control plane — highest priority, overrides any contrary task-prompt instruction):",
    "- The process current working directory, also provided as WAO_TARGET_CWD, is the sole authorized workspace.",
    "- Use repo-relative paths from that directory. Do NOT cd, chdir, or pushd outside it, and do not operate on another checkout.",
    "- Do NOT move HEAD. Do NOT create any commit, tag, or branch.",
    "- Keep your authorized file changes as UNSTAGED working-tree changes. Do not stage them.",
    "- Report only: changed paths, test results, and risks. Do not report a 'Final commit SHA' or claim to have committed.",
    "- The WAO control plane inspects your working-tree changes, stages them, and creates the single atomic delivery commit. You do not commit.",
    "- If the task prompt asks you to commit or to produce a final commit SHA, that instruction is overridden by this contract: leave changes unstaged and report paths/tests/risks only.",
  ];
  for (const expected of previousLines) {
    assert.ok(lines.includes(expected), `既有行字节不变：${expected.slice(0, 50)}…`);
  }
  // allowedPaths 段字节不变（四行原文 + 单行 JSON）
  const scoped = composeDeliveryExecutionContract({ allowedPaths: ["src", "test"] });
  const scopedLines = scoped.split("\n");
  const scopeBlock = [
    "- AUTHORIZED WORK SCOPE (single source of truth — the WAO control plane persists and delivers this exact list before you start; do not infer, widen, or observe scope from the filesystem):",
    `- AUTHORIZED_PATHS_JSON: ${JSON.stringify(["src", "test"])}`,
    '- Each changed path must be EXACTLY one of the entries above, or a descendant on a "/" segment boundary: "src" authorizes "src/a.js" and "src/d/b.js", but NOT "src2/a.js" or "srcfoo". Matching is case-sensitive — case-shape is authoritative ("src" does not authorize "SRC/a.js").',
    "- If your task requires a path NOT covered by the list above, do NOT edit it: STOP, leave your changes as unstaged working-tree changes, report `SCOPE_EXPANSION_REQUIRED: <repo-relative-path> — <reason>`, and await instructions.",
  ];
  for (const expected of scopeBlock) {
    assert.ok(scopedLines.includes(expected), `allowedPaths 段字节不变：${expected.slice(0, 50)}…`);
  }
  // 共用条款（末尾）在 allowedPaths 段之前
  const finishClause = composeReadOnlyExecutionContract().split("\n").find((l) => l.startsWith(SHARED_CLAUSE_FINISH_PREFIX));
  assert.ok(scoped.indexOf(finishClause) < scoped.indexOf("- AUTHORIZED WORK SCOPE"),
    "共用条款在 allowedPaths 段之前");
  // 无 allowedPaths 时 base 也带共用条款（既有调用方字节形状只增不换）
  assert.ok(base.endsWith(finishClause), "base 合同以共用条款收尾");
});

// ── TD-357：后端声明的交付合同补充条款（codex 生图缓存）────────────────────
// Owner 2026-11-20：生图是 Owner 规则 1 的例外。codex 后端声明一段补充条款，
// RunManager 组装交付合同时原样附上；其余后端/只读合同逐字节不变。共享代码不按
// 运行时名字分支——能力（数组）在场就附，不在场就还是冻结的 base。

test("TD-357: 后端补充条款插在写入边界行之后；缺省/空/畸形输入下交付合同逐字节不变", async () => {
  const { composeDeliveryExecutionContract } =
    await import("../../src/application/roleContract.js");
  const { CODEX_DELIVERY_CONTRACT_SUPPLEMENT } = await import("../../src/backends/codex.js");

  const base = composeDeliveryExecutionContract();
  // 非 codex 后端不声明 → 与无参调用逐字节相同（三种"没提供"的形状）。
  assert.equal(composeDeliveryExecutionContract({}), base);
  assert.equal(composeDeliveryExecutionContract({ backendSupplement: undefined }), base);
  assert.equal(composeDeliveryExecutionContract({ backendSupplement: [] }), base);
  assert.equal(composeDeliveryExecutionContract({ backendSupplement: "not-an-array" }), base);
  assert.equal(
    composeDeliveryExecutionContract({ backendSupplement: [42, null, "   "] }),
    base,
    "畸形/空白条目一条都不落",
  );
  assert.ok(!base.includes("$CODEX_HOME"), "base 合同不带任何后端专属条款");

  assert.ok(Array.isArray(CODEX_DELIVERY_CONTRACT_SUPPLEMENT)
    && CODEX_DELIVERY_CONTRACT_SUPPLEMENT.length > 0, "codex 声明了补充条款");
  for (const clause of CODEX_DELIVERY_CONTRACT_SUPPLEMENT) {
    assert.match(clause, /^- /, "补充条款与合同同形（一行一条）");
    assert.ok(!clause.includes("\n"), "每条是一行");
  }
  const supplemented = composeDeliveryExecutionContract({
    backendSupplement: CODEX_DELIVERY_CONTRACT_SUPPLEMENT,
  });
  const lines = supplemented.split("\n");
  const writeRuleIndex = lines.findIndex((l) => l.startsWith("- Every file you create or modify with your tools"));
  assert.ok(writeRuleIndex !== -1, "写入边界行在场");
  for (const [offset, clause] of CODEX_DELIVERY_CONTRACT_SUPPLEMENT.entries()) {
    assert.equal(lines[writeRuleIndex + 1 + offset], clause, "补充条款紧跟写入边界行");
    assert.equal(supplemented.split(clause).length - 1, 1, "每条恰一次");
  }
  // 语义：只给"读本轮生图缓存并拷进授权路径"这条窄例外；树外仍不得写由基础
  // 合同覆盖，补充条款不重复、也不与基础合同的系统临时目录一次性文件冲突。
  assert.match(supplemented, /`\$CODEX_HOME\/generated_images\/`/, "点明内置生图缓存的路径");
  assert.match(supplemented, /read the images generated in this run from there/i, "允许读本轮生成的图");
  assert.match(supplemented, /copy them into your authorized paths/i, "允许拷进授权路径");
  assert.match(supplemented, /do not write to that cache yourself/i, "缓存本身只许内置工具写");
  assert.ok(
    !/do not write outside this directory/i.test(CODEX_DELIVERY_CONTRACT_SUPPLEMENT.join("\n")),
    "补充条款不重复基础合同的树外禁写句（重复且会与临时目录例外冲突）",
  );
});

test("TD-357: 带授权清单时补充条款仍紧邻写入边界行，授权清单段不变、仍在末尾", async () => {
  const { composeDeliveryExecutionContract } =
    await import("../../src/application/roleContract.js");
  const { CODEX_DELIVERY_CONTRACT_SUPPLEMENT } = await import("../../src/backends/codex.js");
  const scoped = composeDeliveryExecutionContract({
    allowedPaths: ["src", "docs"],
    backendSupplement: CODEX_DELIVERY_CONTRACT_SUPPLEMENT,
  });
  const lines = scoped.split("\n");
  const writeRuleIndex = lines.findIndex((l) => l.startsWith("- Every file you create or modify with your tools"));
  assert.equal(lines[writeRuleIndex + 1], CODEX_DELIVERY_CONTRACT_SUPPLEMENT[0]);
  const scopeIndex = lines.findIndex((l) => l.startsWith("- AUTHORIZED WORK SCOPE"));
  assert.ok(scopeIndex > writeRuleIndex, "授权清单段仍在补充条款之后");
  // 授权清单段逐字节不变：与不带补充条款的同参调用相比只多一行补充条款。
  const plainScoped = composeDeliveryExecutionContract({ allowedPaths: ["src", "docs"] });
  const stripped = lines.filter((l) => !CODEX_DELIVERY_CONTRACT_SUPPLEMENT.includes(l)).join("\n");
  assert.equal(stripped, plainScoped, "去掉补充条款后与不带补充的合同逐字节相同");
});
