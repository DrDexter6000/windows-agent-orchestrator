// test/mcp-surface/f5-cursorRejectedText.test.js
//
// F5 (2026-10-08 friction batch): 坏 cursor 的专属拒绝文案。
//
// 现状（修复前）：run_collect / run_delivery_review 对坏 cursor 抛裸
// Error("invalid cursor: ...")，MCP handler 折叠成塌缩文案，消费者无从修法。
// 修复后：解码/校验路径抛 CursorRejectedError（run_activity M12-19 的同一类，
// instanceof 分类），三个携带 cursor 的入口（collect / review / bundle）折叠为
// isError + 固定专属文案 + 静态恢复指引——不透子类型（过期/跨 run/被改不分）。
//
// 契约：
//   A — run_collect：坏 cursor（语法坏 + 跨 run 重放）→ 专属文案；被拒 cursor
//       零审计追加（messages.collected 不写入，字节数不变）。
//   B — run_delivery_review：真实服务 waiting_for_verification + cursor →
//       专属文案；transcript 零追加。
//   C — run_delivery_review_bundle：同款折叠（组合工具携带 cursor 分支）；
//       transcript 零追加。
//   D — 分类纪律：instanceof 才折叠——服务抛普通 Error 仍走通用塌缩文案；
//       SDK/本地语法前置拒绝不进 handler 分类（保持原样）。
//   E — encode 侧 "cursor token too large / cursor too long" 是编码器自身
//       错误，保持原 Error 形状（防误伤钉——绝不被折叠成 cursor 拒绝）。
//   F — CLI 适配层同文案（observe.js collect、runs.js delivery review）。
//
// 纯本地确定性测试（无 API token）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { CursorRejectedError } from "../../src/application/runActivityProjection.js";
import { encodeCollectCursor } from "../../src/application/runCollectProjection.js";
import { collectCommand } from "../../src/commands/observe.js";
import { runsDeliveryCommand } from "../../src/commands/runs.js";

// ===== 固定文案（与实现逐字一致——文案即契约） =====

const COLLECT_REJECTED_MCP =
  "run_collect failed — cursor is invalid or expired — re-fetch from page 1 (call again without a cursor); "
  + "never hand-modify a cursor token";
const REVIEW_REJECTED_MCP =
  "run_delivery_review failed — cursor is invalid or expired — re-fetch from page 1 (call again without a cursor); "
  + "never hand-modify a cursor token";
const BUNDLE_REJECTED_MCP =
  "run_delivery_review_bundle failed — cursor is invalid or expired — re-fetch from page 1 (call again without a cursor); "
  + "never hand-modify a cursor token";
const COLLECT_REJECTED_CLI =
  "collect cursor rejected: the cursor is invalid or expired — re-run from page 1 "
  + "(omit --cursor); a cursor token is opaque and must never be hand-modified";
const REVIEW_REJECTED_CLI =
  "runs delivery review cursor rejected: the cursor is invalid or expired — re-run "
  + "without --cursor to restart from page 1; a cursor token is opaque and must never be hand-modified";

// ===== Helpers =====

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
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

// A process transcript with N assistant messages（同 mcpRunCollect 现形）。
function writeCollectTranscript(runDir, runId, messageBodies) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session.created", backend: "process", backendSessionId: "proc_f5", runId, agentId: "w" }),
    JSON.stringify({ type: "run.started", backend: "claude-code", ts: "2026-10-08T00:00:00.000Z", runId, agentId: "w" }),
  ];
  messageBodies.forEach((body, i) => {
    lines.push(JSON.stringify({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text: body }],
      ts: `2026-10-08T00:00:${10 + i}.000Z`, runId, agentId: "w",
    }));
  });
  lines.push(JSON.stringify({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-10-08T00:10:00.000Z", runId, agentId: "w" }));
  writeFileSync(join(runDir, `${runId}.jsonl`), lines.map((l) => l + "\n").join(""), "utf8");
}

// A plain git repo（review/bundle 真实服务的 workspace 绑定与 ownership 用）。
function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name t", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
}

// 最小 waiting_for_verification transcript：canonical 形状的 delivery_created、
// 无 verification 终局 → readiness=waiting_for_verification → 带 cursor 的
// review/bundle 调用在任何 Git 内容读取前抛 CursorRejectedError。
function writeWaitingTranscript(runDir, runId, repo) {
  mkdirSync(runDir, { recursive: true });
  const events = [
    { type: "run.started", runId, ts: "2026-10-08T00:00:00Z", seq: 1 },
    { type: "run.background_submitted", runId, ts: "2026-10-08T00:00:00Z", seq: 2, cwd: repo, background: true, deliveryRequested: true },
    {
      type: "run.delivery_created", runId, ts: "2026-10-08T00:00:01Z", seq: 3,
      delivery: {
        runId,
        baseCommit: "b".repeat(40),
        deliveryCommit: "c".repeat(40),
        changedFiles: ["src/a.js"],
      },
    },
  ];
  writeFileSync(join(runDir, `${runId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

// ===== A — run_collect =====

test("F5-A1: run_collect malformed cursor → dedicated text, zero audit append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f5-a1-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_f5_a1";
    writeCollectTranscript(runDir, runId, ["x"]);
    const path = join(runDir, `${runId}.jsonl`);
    const bytesBefore = statSync(path).size;
    const server = createWaoMcpServer({ registryPath: "/server/r.json", runDir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_collect", arguments: { runId, cursor: "not!base64url" } });
      assert.equal(res.isError, true, "isError flagged");
      assert.equal(textOf(res), COLLECT_REJECTED_MCP, "dedicated cursor-rejected copy (exact)");
      assert.ok(!res.structuredContent, "no structuredContent on cursor rejection");
      // 零审计次序：被拒 cursor 绝不追加 messages.collected。
      assert.equal(statSync(path).size, bytesBefore, "transcript byte-identical (no audit append)");
      assert.ok(!readFileSync(path, "utf8").includes("messages.collected"), "no messages.collected event");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

test("F5-A2: run_collect cross-run cursor replay → dedicated text, zero audit append on the target run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f5-a2-"));
  try {
    const runDir = join(dir, "runs");
    writeCollectTranscript(runDir, "runA", Array.from({ length: 10 }, (_, i) => `A-${i}`));
    writeCollectTranscript(runDir, "runB", ["B-0"]);
    const pathB = join(runDir, "runB.jsonl");
    const bytesBefore = statSync(pathB).size;
    const server = createWaoMcpServer({ registryPath: "/server/r.json", runDir });
    const client = await buildInMemoryClient(server);
    try {
      const resA = await client.callTool({ name: "run_collect", arguments: { runId: "runA" } });
      const parsedA = JSON.parse(resA.content.find((b) => b.type === "text").text);
      assert.ok(parsedA.nextCursor, "runA has a next cursor");
      const resB = await client.callTool({ name: "run_collect", arguments: { runId: "runB", cursor: parsedA.nextCursor } });
      assert.equal(resB.isError, true, "cross-run replay fails closed");
      assert.equal(textOf(resB), COLLECT_REJECTED_MCP, "dedicated cursor-rejected copy (exact)");
      assert.equal(statSync(pathB).size, bytesBefore, "runB transcript byte-identical (no audit append)");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== B — run_delivery_review =====

test("F5-B1: run_delivery_review cursor on a not-yet-paginated artifact → dedicated text (real service), zero transcript append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f5-b1-"));
  try {
    makeGitRepo(dir);
    const runDir = join(dir, "runs");
    const runId = "run_f5_b1";
    writeWaitingTranscript(runDir, runId, dir);
    const path = join(runDir, `${runId}.jsonl`);
    const bytesBefore = statSync(path).size;
    const server = createWaoMcpServer({ registryPath: "/x", runDir, workspaceRoot: dir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery_review", arguments: { runId, fileIndex: 0, cursor: "abc" } });
      assert.equal(res.isError, true, "isError flagged");
      assert.equal(textOf(res), REVIEW_REJECTED_MCP, "dedicated cursor-rejected copy (exact)");
      assert.ok(!res.structuredContent, "no structuredContent on cursor rejection");
      assert.equal(statSync(path).size, bytesBefore, "transcript byte-identical (review is read-only)");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== C — run_delivery_review_bundle =====

test("F5-C1: run_delivery_review_bundle cursor without reviewable artifact → dedicated text (real services), zero transcript append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f5-c1-"));
  try {
    makeGitRepo(dir);
    const runDir = join(dir, "runs");
    const runId = "run_f5_c1";
    writeWaitingTranscript(runDir, runId, dir);
    const path = join(runDir, `${runId}.jsonl`);
    const bytesBefore = statSync(path).size;
    const server = createWaoMcpServer({ registryPath: "/x", runDir, workspaceRoot: dir });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId, fileIndex: 0, cursor: "abc", waitMs: 1000 },
      });
      assert.equal(res.isError, true, "isError flagged");
      assert.equal(textOf(res), BUNDLE_REJECTED_MCP, "dedicated cursor-rejected copy (exact)");
      assert.ok(!res.structuredContent, "no structuredContent on cursor rejection");
      assert.equal(statSync(path).size, bytesBefore, "transcript byte-identical (bundle is read-only)");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== D — 分类纪律（instanceof 才折叠） =====

test("F5-D1: a NON-cursor service failure keeps the fixed generic text (instanceof-only folding)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f5-d1-"));
  try {
    makeGitRepo(dir); // workspace 绑定先行——服务注入前必须 bound
    const server = createWaoMcpServer({
      registryPath: "/x", runDir: dir, workspaceRoot: dir,
      // 注入服务抛普通 Error——不是 CursorRejectedError，绝不能吃到专属文案。
      getRunDeliveryReviewFn: () => { throw new Error("internal: ordinary failure"); },
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery_review", arguments: { runId: "run_x", fileIndex: 0 } });
      assert.equal(res.isError, true, "error flagged");
      assert.equal(textOf(res), "run_delivery_review failed", "generic collapse preserved for non-cursor failures");
      assert.ok(!textOf(res).includes("re-fetch from page 1"), "no cursor remedy on a non-cursor failure");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ===== E — encode 侧防误伤钉 =====

test("F5-E1: encode-side 'cursor too long' stays a plain Error (encoder invariant, never folded)", async () => {
  // 构造一个超过 192 字符预算的合法形状 payload：r/s 是编码器仅做 typeof 检查的
  // 字符串——超长即触发 "cursor too long"。
  await assert.rejects(
    () => Promise.resolve().then(() => encodeCollectCursor({
      v: 1, r: "x".repeat(300), s: "y".repeat(300), n: 0, m: 0, o: 0,
    })),
    (err) => err instanceof Error
      && !(err instanceof CursorRejectedError)
      && err.message === "cursor too long",
    "encode-side overflow keeps the original plain-Error shape",
  );
});

// ===== F — CLI 适配层同文案 =====

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join("\t")); };
  try { await fn(); }
  finally { console.log = orig; }
  return lines.join("\n");
}

test("F5-F1: CLI collect cross-run cursor → dedicated CLI text, zero audit append on the target run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f5-f1-"));
  try {
    const runDir = join(dir, "runs");
    writeCollectTranscript(runDir, "runA", Array.from({ length: 10 }, (_, i) => `A-${i}`));
    writeCollectTranscript(runDir, "runB", ["B-0"]);
    const pathB = join(runDir, "runB.jsonl");
    const bytesBefore = statSync(pathB).size;
    const config = { runDir };

    // 第 1 页 runA（成功，追加 1 条审计）——取 nextCursor。
    const page1 = JSON.parse(await captureLog(
      () => collectCommand(["runA", "--format", "json"], config),
    ));
    assert.ok(page1.nextCursor, "runA page 1 carries nextCursor");

    // 跨 run 重放到 runB → 投影抛 CursorRejectedError → CLI 专属文案。
    await assert.rejects(
      () => collectCommand(["runB", "--format", "json", "--cursor", page1.nextCursor], config),
      (err) => err instanceof Error && err.message === COLLECT_REJECTED_CLI,
      "CLI folds the projection's CursorRejectedError into the dedicated copy",
    );
    assert.equal(statSync(pathB).size, bytesBefore, "runB transcript byte-identical (no audit append)");
  } finally {
    cleanupDir(dir);
  }
});

test("F5-F2: CLI collect malformed cursor (local syntax gate) → same dedicated CLI text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f5-f2-"));
  try {
    const runDir = join(dir, "runs");
    writeCollectTranscript(runDir, "runA", ["x"]);
    await assert.rejects(
      () => collectCommand(["runA", "--format", "json", "--cursor", "not!base64url"], { runDir }),
      (err) => err instanceof Error && err.message === COLLECT_REJECTED_CLI,
      "local syntax rejection carries the same recovery copy",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("F5-F3: CLI runs delivery review — service CursorRejectedError → dedicated CLI text; plain Error passes through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-f5-f3-"));
  try {
    // 语法门：非 base64url cursor。
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", "0", "--cursor", "bad!token"], { runDir: dir }),
      (err) => err instanceof Error && err.message === REVIEW_REJECTED_CLI,
      "local syntax rejection carries the dedicated copy",
    );
    // 服务层类型化拒绝 → 折叠为专属文案。
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", "0", "--cursor", "abc"], { runDir: dir }, {
        getRunDeliveryReviewFn: () => { throw new CursorRejectedError("invalid cursor: decode"); },
      }),
      (err) => err instanceof Error && err.message === REVIEW_REJECTED_CLI,
      "service-typed rejection folds into the dedicated copy",
    );
    // 非类型化错误原样上抛（不吞不改）。
    await assert.rejects(
      () => runsDeliveryCommand(["review", "run_x", "--file-index", "0"], { runDir: dir }, {
        getRunDeliveryReviewFn: () => { throw new Error("internal: ordinary failure"); },
      }),
      (err) => err instanceof Error && err.message === "internal: ordinary failure",
      "ordinary service errors pass through unchanged",
    );
  } finally {
    cleanupDir(dir);
  }
});
