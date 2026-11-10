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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
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
