// test/run-lifecycle/f3-shortHeadExpectation.test.js
//
// F3 (2026-10-08 friction batch): expectedGitHead 接受短哈希。
//
// 修复前：run_dispatch 的 expectedGitHead 只接受 40/64 全形 hex，Lead 从
// `git log --oneline` 等短形输出复制即被 wire 正则拒绝。
// 修复后：
//   - wire 正则放宽为 /^[0-9a-f]{7,64}$/（EXPECTED_GIT_HEAD_RE SSOT，
//     run_dispatch 与 run_dispatch_contract_check 共享入参，两个 inputSchema
//     各自序列化该 pattern）；
//   - workspaceExpectation 匹配从精确等值改为前缀匹配——短形（7..39 hex）
//     是弱化断言（provenHead.startsWith(expected)），全形（40/64）仍精确等值
//     （同长前缀即等值，语义不变）；
//   - isCanonicalCommitId（交付路径）语义不动。
//
// 契约：
//   A — 单元：checkWorkspaceExpectation 前缀匹配矩阵（7/8/12/40/64 接受；
//       前缀不匹配/非 hex/6 位/65 位/大写拒绝）。
//   B — E2E：真实 repo + 假 dispatcher——短形期望（7/8/12/40 位切片）派发成功
//       （count 1 + workspaceProof.expectedGitHeadMatch=true）。
//   C — E2E：wire 形状门——6 位 hex / 非 hex 7 位 / 65 位 hex 在 schema 层拒绝
//       （dispatcher count 0）；64 位 hex 过 schema（现有 FR03-I 已钉，不重复）。
//   D — E2E：前缀不匹配拒绝（count 0 + workspace_expectation_mismatch (gitHead)
//       + 短形弱化断言修法提示）。
//   E — expectedDirty 现义回归：未跟踪文件计入 dirty（expectedDirty:false →
//       mismatch），提示句含 git status --porcelain 复核；干净 repo 匹配。
//
// 纯本地确定性测试（无 API token）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { checkWorkspaceExpectation, EXPECTED_GIT_HEAD_RE } from "../../src/application/workspaceExpectation.js";

// 本测试可能运行在 WAO worker 进程内：nested-dispatch 守卫（0047）按
// WAO_IN_WORKER 血统标记与 .wao-worktrees 路径组件拒绝向下派发，使期望前置
// 检查根本不执行。测试进程删除血统标记并启用守卫自带的 Lead 豁免
// （WAO_ALLOW_NESTED_DISPATCH=1，src/nestedDispatchGuard.js 的显式机制），
// 模拟普通 Lead/Host 侧调用环境——豁免只影响本测试进程。
delete process.env.WAO_IN_WORKER;
process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name t", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

function gitHead(dir) {
  return execSync("git rev-parse HEAD", {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(res) {
  return res.content?.map((b) => b.text ?? "").join(" ") ?? "";
}

// 同 m12-6 惯例：registry 与 runDir 放独立 aux 目录，repo 保持确定性干净。
function setup() {
  const repo = mkdtempSync(join(tmpdir(), "wao-f3-repo-"));
  makeGitRepo(repo);
  const aux = mkdtempSync(join(tmpdir(), "wao-f3-aux-"));
  const registryPath = join(aux, "agents.json");
  writeFileSync(registryPath, JSON.stringify({
    agents: { coder_low: { backend: "claude-code", cwd: repo } },
  }), "utf8");
  const runDir = join(aux, "runs");
  return { repo, aux, registryPath, runDir };
}

function makeFakeDispatch() {
  let callCount = 0;
  const fn = async (input) => {
    callCount += 1;
    return {
      accepted: true, runId: "run_f3_fake", agentId: input.agentId, state: "pending",
      providerSessionRouting: "not_used",
    };
  };
  return { fn, get count() { return callCount; } };
}

// 把一个 hex 字符换成另一个 hex 字符（保持形状，改变值）。
function flipHexChar(s, i) {
  const HEX = "0123456789abcdef";
  const c = s[i];
  const repl = HEX[(HEX.indexOf(c) + 1) % 16];
  return s.slice(0, i) + repl + s.slice(i + 1);
}

// ===== A — checkWorkspaceExpectation 前缀匹配矩阵（单元） =====

test("F3-A1: short-form expectedGitHead (7/8/12) prefix-matches the proven head (weakened assertion)", () => {
  const HEAD40 = "0f1e".repeat(10); // 40 lowercase hex
  assert.equal(HEAD40.length, 40);
  const binding = { bound: true, source: "server_config", gitHead: HEAD40, dirty: false };
  for (const len of [7, 8, 12]) {
    const ok = checkWorkspaceExpectation({ binding, expectedGitHead: HEAD40.slice(0, len) });
    assert.deepEqual(ok, {
      matched: true,
      proof: {
        source: "server_config",
        gitHead: HEAD40,
        dirty: false,
        expectedGitHeadMatch: true,
        expectedDirtyMatch: null,
        expectedWorkspaceRootMatch: null,
      },
    }, `${len}-hex short form matches by prefix`);
  }
});

test("F3-A2: full-form 40/64 stays an exact match; a 64-form never prefix-matches a 40-hex binding", () => {
  const HEAD40 = "0f1e2d3c4b5a6978869706152433425160798a";
  const HEAD64 = "a".repeat(64);
  // 40 全形 = 精确等值（同长前缀即等值）。
  assert.equal(checkWorkspaceExpectation({ binding: { gitHead: HEAD40 }, expectedGitHead: HEAD40 }).matched, true);
  // 64 全形对 64 绑定：精确等值。
  assert.equal(checkWorkspaceExpectation({ binding: { gitHead: HEAD64 }, expectedGitHead: HEAD64 }).matched, true);
  // 64 期望对 40 绑定：前缀不可能成立 → mismatch。
  assert.deepEqual(
    checkWorkspaceExpectation({ binding: { gitHead: HEAD40 }, expectedGitHead: HEAD64 }),
    { matched: false, mismatch: "gitHead" },
  );
});

test("F3-A3: prefix mismatch / non-hex / 6-hex / 65-hex / uppercase are all gitHead mismatches", () => {
  const HEAD40 = "0f1e2d3c4b5a6978869706152433425160798a";
  const binding = { bound: true, gitHead: HEAD40, dirty: false };
  const cases = [
    ["flipped 7-hex prefix", flipHexChar(HEAD40.slice(0, 7), 6)],
    ["non-hex 7 chars", "zzzzzzz"],
    ["6-hex (too short)", HEAD40.slice(0, 6)],
    ["65-hex (too long)", HEAD40 + "a"],
    ["uppercase 7-hex", HEAD40.slice(0, 7).toUpperCase()],
    ["uppercase full 40", HEAD40.toUpperCase()],
  ];
  for (const [label, expected] of cases) {
    assert.deepEqual(
      checkWorkspaceExpectation({ binding, expectedGitHead: expected }),
      { matched: false, mismatch: "gitHead" },
      `${label} is rejected`,
    );
  }
});

test("F3-A4: EXPECTED_GIT_HEAD_RE shape SSOT accepts 7..64 lowercase hex, nothing else", () => {
  for (const ok of ["abcdef0", "0123456789abcde", "a".repeat(12), "a".repeat(40), "a".repeat(64)]) {
    assert.ok(EXPECTED_GIT_HEAD_RE.test(ok), `${ok.length}-hex accepted`);
  }
  for (const bad of ["abcdef", "a".repeat(65), "zzzzzzz", "ABCDEF0", "abc def0", "", "abcdefg!"]) {
    assert.equal(EXPECTED_GIT_HEAD_RE.test(bad), false, `${JSON.stringify(bad)} rejected`);
  }
});

// ===== B — E2E 短形接受矩阵（真实 repo + 假 dispatcher） =====

test("F3-B1: run_dispatch accepts 7/8/12/40-hex expectedGitHead slices of the real head", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const head = gitHead(repo);
    assert.equal(head.length, 40, "sha1 repo head");
    for (const len of [7, 8, 12, 40]) {
      const fake = makeFakeDispatch();
      const server = createWaoMcpServer({
        registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
      });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({
          name: "run_dispatch",
          arguments: { agentId: "coder_low", prompt: "do it", expectedGitHead: head.slice(0, len) },
        });
        assert.equal(fake.count, 1, `${len}-hex expectation: dispatch happens exactly once`);
        const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
        assert.equal(parsed.workspaceProof.expectedGitHeadMatch, true, `${len}-hex expectation matched`);
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

// ===== C — wire 形状门（schema 层拒绝，dispatcher count 0） =====

test("F3-C1: 6-hex / non-hex / 65-hex expectedGitHead rejected at the wire (count 0)", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const head = gitHead(repo);
    const bad = [
      head.slice(0, 6),
      "zzzzzzz",
      head + "a",
    ];
    for (const expected of bad) {
      const fake = makeFakeDispatch();
      const server = createWaoMcpServer({
        registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
      });
      const client = await buildInMemoryClient(server);
      try {
        // SDK 输入校验在 handler 之前拒绝——协议层抛出或 isError 结果都算拒
        // （M9-2B-04 同款容忍断言）；dispatcher 保持 count 0。
        let rejected = false;
        let result = null;
        try {
          result = await client.callTool({
            name: "run_dispatch",
            arguments: { agentId: "coder_low", prompt: "do it", expectedGitHead: expected },
          });
        } catch {
          rejected = true;
        }
        if (!rejected) {
          assert.equal(result.isError, true,
            `${JSON.stringify(expected)} must be rejected before the handler`);
        }
        assert.equal(fake.count, 0, `${JSON.stringify(expected)}: dispatcher never called`);
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

// ===== D — 前缀不匹配拒绝 + 修法提示 =====

test("F3-D1: prefix mismatch refuses dispatch (count 0) with the gitHead fix hint", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const head = gitHead(repo);
    const wrongPrefix = flipHexChar(head.slice(0, 7), 6);
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "do it", expectedGitHead: wrongPrefix },
      });
      assert.equal(res.isError, true, "mismatch refuses dispatch");
      assert.equal(fake.count, 0, "dispatcher never called");
      const text = textOf(res);
      assert.ok(text.includes("workspace_expectation_mismatch (gitHead)"), "closed-set category label");
      assert.ok(/matches by prefix/.test(text), "short-form weakened-assertion fix hint present");
      assert.ok(!text.includes(wrongPrefix), "the offending value is never echoed");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

// ===== E — expectedDirty 现义回归（语义不动 + 修法提示） =====

test("F3-E1: untracked file still counts as dirty → expectedDirty:false mismatch, with the porcelain hint", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    writeFileSync(join(repo, "untracked-f3.txt"), "change\n", "utf8");
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "do it", expectedDirty: false },
      });
      assert.equal(res.isError, true, "untracked file keeps the binding dirty → mismatch");
      assert.equal(fake.count, 0, "dispatcher never called");
      const text = textOf(res);
      assert.ok(text.includes("workspace_expectation_mismatch (dirty)"), "closed-set category label");
      assert.ok(/git status --porcelain/.test(text), "dirty fix hint present");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("F3-E2: clean repo with expectedDirty:false still dispatches (regression control)", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "do it", expectedDirty: false },
      });
      assert.equal(fake.count, 1, "clean binding matches expectedDirty:false");
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.workspaceProof.expectedDirtyMatch, true);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});
