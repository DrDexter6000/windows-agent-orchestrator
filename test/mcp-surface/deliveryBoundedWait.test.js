// test/mcp-surface/deliveryBoundedWait.test.js
//
// TD-215 钉：repackage/reverify 有界等待——服务超窗=text-only pending 回执（B91
// 起：验证继续于**本 MCP 服务进程**，进程被换掉验证即停）；窗内完成=既有契约
// 原样。冻结 output schema 零触碰。B91：缺省窗降到 45s（宿主单次调用上限约
// 60s 之内）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createWaoMcpServer, DELIVERY_BOUNDED_WAIT_DEFAULT_MS } from "../../src/mcp/server.js";

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md && git commit -m init", { cwd: dir, stdio: "pipe" });
}

async function buildClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "bw-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test("TD-215 ①: 服务超窗 → status:pending 回执（isError 未设、structuredContent 极简、指向 run_delivery）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bw-1-"));
  try {
    makeGitRepo(dir);
    // 注入永不 resolve 的 repackage 服务 + 极短等待窗。
    const prev = process.env.WAO_DELIVERY_WAIT_MS;
    process.env.WAO_DELIVERY_WAIT_MS = "50";
    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: join(dir, "runs"),
      workspaceRoot: dir,
      getRunDeliveryRepackageFn: () => new Promise(() => {}), // 永不完成（模拟长验证）
    });
    try {
      const client = await buildClient(server);
      const res = await client.callTool({
        name: "run_delivery_repackage",
        arguments: { runId: "run_202610061200000000000000", allowedPaths: ["src"], expectedWorkspaceRoot: dir },
      });
      const text = res.content?.find((b) => b.type === "text")?.text ?? "";
      assert.notEqual(res.isError, true, "pending 不是错误");
      // TD-215 定稿：schema 增 status 枚举（会审批准的契约最小扩展）——pending 带
      // structuredContent={status:"pending", runId}；ok 字段缺席（.optional 化）。
      // TD-226（2026-10-08）：rejectionReason 为 required-nullable，pending 恒
      // null（无拒绝在案）。
      // TD-241 C2b（2026-10-09，Owner 批准小幅重冻）：闭集指引 guidance 数组进
      // structuredContent——探针实测 claude 模型在成功面只见 structuredContent，
      // 指引只放 text 对 claude 失明。键集含四键。
      assert.deepEqual(
        Object.keys(res.structuredContent ?? {}).sort(),
        ["guidance", "rejectionReason", "runId", "status"],
      );
      assert.equal(res.structuredContent?.status, "pending");
      assert.equal(res.structuredContent?.rejectionReason, null, "pending 无拒绝在案");
      assert.ok(Array.isArray(res.structuredContent?.guidance)
        && res.structuredContent.guidance.length >= 1
        && res.structuredContent.guidance.includes("do_not_reenter_reentry_reexecutes_verification")
        && res.structuredContent.guidance.includes("poll_run_delivery_with_waitMs_for_settled_outcome"),
      "pending 指引必须进 structuredContent（claude 失明修复）");
      assert.match(text, /run_delivery_repackage pending/);
      // B91：pending 文案如实——超窗时可能还在打包或验证；验证在本 MCP 服务
      // 进程里，进程被换掉验证即停；runs wait 要证明成立（静默满 15 分钟）才以
      // verifier_gone 退出；同样输入再调 repackage 重跑验证、不产生第二个提交。
      // 盲目重试警告保留。
      assert.match(text, /still packaging or verifying after the bounded wait/);
      assert.match(text, /The verification runs in this MCP server process/);
      assert.match(text, /if that process is replaced, the verification stops/);
      assert.match(text, /wao runs wait run_\S+ --until-settled can then exit with reason verifier_gone once it proves the verifier gone \(the transcript must have been quiet for 15 minutes\)/);
      assert.match(text, /calling run_delivery_repackage again with the same input then runs the verification again without creating a second commit/);
      assert.match(text, /Do NOT blind-retry/);
      assert.match(text, /[Pp]oll run_delivery/);
      // 第 137a 批：原有文字之后补一句出路——先 MCP 写法，后 CLI 写法（CLI 进程不受
      // 单次调用时限、不随 MCP 服务重启中断）。原文字一字不动、structuredContent
      // 形状不变（输出 schema 未动）。续修 1：CLI 写法带 --cwd <expectedWorkspaceRoot>
      // 占位（照抄到另一棵工作树的交付不会被归属门拒绝），不回显绝对路径。
      assert.match(text, /side effects\. If this MCP server is replaced before the outcome lands, the attempt stops: call run_delivery_repackage again with the same input to re-run it\./);
      assert.match(text, new RegExp(
        ` If your host has a background shell, you can instead run wao runs delivery repackage run_202610061200000000000000 --allowed-path <path>\\.\\.\\. --cwd <expectedWorkspaceRoot> there; one command re-runs it, free of the per-call timeout and of an MCP server restart\\.$`,
      ));
      assert.ok(!text.includes(dir), "不回显工作区绝对路径（--cwd 只给占位）");
      assert.ok(text.includes("run_delivery_repackage pending: still packaging or verifying after the bounded wait"), "原有开头照旧");
    } finally {
      if (prev === undefined) delete process.env.WAO_DELIVERY_WAIT_MS;
      else process.env.WAO_DELIVERY_WAIT_MS = prev;
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("TD-215 ②: 窗内完成 → 既有契约原样（payload 字段齐全）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bw-2-"));
  try {
    makeGitRepo(dir);
    mkdirSync(join(dir, "runs"), { recursive: true });
    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: join(dir, "runs"),
      workspaceRoot: dir,
      getRunDeliveryRepackageFn: async () => ({
        runId: "run_202610061200000000000000",
        deliveryCommit: "a".repeat(40),
        verificationStatus: "passed",
        source: "packaged",
        recoveryKind: "backend_failed",
        created: true,
      }),
    });
    try {
      const client = await buildClient(server);
      const res = await client.callTool({
        name: "run_delivery_repackage",
        arguments: { runId: "run_202610061200000000000000", allowedPaths: ["src"], expectedWorkspaceRoot: dir },
      });
      assert.notEqual(res.isError, true);
      const sc = res.structuredContent ?? {};
      assert.equal(sc.status, "ok", "窗内=既有契约同步返回（status:ok）");
      assert.equal(sc.verificationStatus, "passed");
      assert.equal(sc.deliveryCommit, "a".repeat(40));
    } finally { await server.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// B91：缺省窗 45s——落在宿主单次工具调用上限（约 60s）之内，宿主不再先报超时。
// 缺省路径没法在测试里真等 45s，钉的是导出的缺省常量（server.js 的 IIFE 引用
// 同一常量，env 覆写路径由上面 TD-215 ① 的 WAO_DELIVERY_WAIT_MS=50 覆盖）。
test("B91-DEFAULT-WINDOW: 有界等待缺省 45000 ms（宿主上限之内）", () => {
  assert.equal(DELIVERY_BOUNDED_WAIT_DEFAULT_MS, 45000);
});

// B91：reverify 的 pending 文案同样如实——验证在本 MCP 服务进程里继续，进程被
// 换掉验证即停。structuredContent 形状不变（status:pending + 闭集 guidance）。
test("B91-REVERIFY-PENDING-TEXT: reverify 超窗回执如实说明验证所在进程", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bw-rv-"));
  try {
    makeGitRepo(dir);
    const prev = process.env.WAO_DELIVERY_WAIT_MS;
    process.env.WAO_DELIVERY_WAIT_MS = "50";
    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: join(dir, "runs"),
      workspaceRoot: dir,
      runDeliveryReverifyFn: () => new Promise(() => {}), // 永不完成（模拟长验证）
    });
    try {
      const client = await buildClient(server);
      const res = await client.callTool({
        name: "run_delivery_reverify",
        arguments: { runId: "run_202611090900000000000000", reason: "tooling_invalid", expectedWorkspaceRoot: dir },
      });
      const text = res.content?.find((b) => b.type === "text")?.text ?? "";
      assert.notEqual(res.isError, true, "pending 不是错误");
      assert.equal(res.structuredContent?.status, "pending");
      assert.deepEqual(
        Object.keys(res.structuredContent ?? {}).sort(),
        ["guidance", "runId", "status"],
      );
      assert.match(text, /run_delivery_reverify pending/);
      assert.match(text, /The re-verification continues in this MCP server process/);
      assert.match(text, /if that process is replaced, it stops/);
      assert.match(text, /[Pp]oll run_delivery/);
      assert.match(text, /Avoid concurrent re-calls/);
      // 第 137a 批：出路一句——先 MCP 写法，后 CLI 写法（已有的 wao runs delivery reverify）。
      // 续修 1：CLI 写法按本次调用的实际输入补齐（见下一个用例）；这里只给了 reason。
      assert.match(text, /reentry re-executes verification\. If this MCP server is replaced before the outcome lands, the attempt stops: call run_delivery_reverify again with the same input to re-run it\./);
      assert.match(text, new RegExp(
        ` If your host has a background shell, you can instead run wao runs delivery reverify run_202611090900000000000000 --reason tooling_invalid --cwd <expectedWorkspaceRoot> there; one command re-runs it, free of the per-call timeout and of an MCP server restart\\.$`,
      ));
      assert.ok(!text.includes(dir), "不回显工作区绝对路径（--cwd 只给占位）");
    } finally {
      if (prev === undefined) delete process.env.WAO_DELIVERY_WAIT_MS;
      else process.env.WAO_DELIVERY_WAIT_MS = prev;
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 第 137a 批：出路那一句自带上限（480）——runId 很长、整句放不下时只留 MCP 写法：
// 不抛错、不截断 id，原有 pending 回执照常返回。
test("137a-PENDING-LONG-ID: 超长 runId → 出路一句只留 MCP 写法，pending 回执照常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bw-137a-"));
  try {
    makeGitRepo(dir);
    const prev = process.env.WAO_DELIVERY_WAIT_MS;
    process.env.WAO_DELIVERY_WAIT_MS = "50";
    const longId = "run_" + "z".repeat(300);
    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: join(dir, "runs"),
      workspaceRoot: dir,
      getRunDeliveryRepackageFn: () => new Promise(() => {}),
      runDeliveryReverifyFn: () => new Promise(() => {}),
    });
    try {
      const client = await buildClient(server);
      for (const [name, args, mcpTool] of [
        ["run_delivery_repackage", { allowedPaths: ["src"] }, "run_delivery_repackage"],
        ["run_delivery_reverify", { reason: "tooling_invalid" }, "run_delivery_reverify"],
      ]) {
        const res = await client.callTool({ name, arguments: { runId: longId, expectedWorkspaceRoot: dir, ...args } });
        const text = res.content?.find((b) => b.type === "text")?.text ?? "";
        assert.notEqual(res.isError, true, `${name}: pending 不是错误`);
        assert.equal(res.structuredContent?.status, "pending");
        assert.equal(res.structuredContent?.runId, longId, "structuredContent 里的 runId 不截断");
        assert.match(text, new RegExp(`the attempt stops: call ${mcpTool} again with the same input to re-run it\\.$`), `${name}: 只留 MCP 写法`);
        assert.ok(!/you can instead run wao runs delivery/.test(text), `${name}: 放不下就不加 CLI 半句`);
      }
    } finally {
      if (prev === undefined) delete process.env.WAO_DELIVERY_WAIT_MS;
      else process.env.WAO_DELIVERY_WAIT_MS = prev;
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 第 137a 批续修 1（会审 kimi、sol）：reverify 的 CLI 写法要能重跑**同一次尝试**。
// 首轮只给 `--reason <code>`：原调用是 attempt: 2 时照抄会按缺省 attempt 1 读回
// 第一条链的旧结果，第二条链仍 pending。现在按本次调用的实际输入补齐——attempt
// 为 2 带 --attempt 2；显式给了 timeoutMs 带 --timeout-ms；非空 setupCommands 带
// --setup-commands-file <FILE> 占位；并带 --cwd <expectedWorkspaceRoot> 占位。
test("137a-REVERIFY-SAME-ATTEMPT: CLI 写法按本次调用的实际输入补齐（attempt 2 / timeoutMs / setupCommands / --cwd 占位）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bw-137a-rv-"));
  try {
    makeGitRepo(dir);
    const prev = process.env.WAO_DELIVERY_WAIT_MS;
    process.env.WAO_DELIVERY_WAIT_MS = "50";
    const RUN = "run_202611090900000000000000";
    const server = createWaoMcpServer({
      registryPath: join(dir, "agents.json"),
      runDir: join(dir, "runs"),
      workspaceRoot: dir,
      runDeliveryReverifyFn: () => new Promise(() => {}), // 永不完成（模拟长验证）
    });
    const cliCommandOf = (text) => text.match(/you can instead run (.+?) there;/)?.[1] ?? null;
    try {
      const client = await buildClient(server);
      const cases = [
        // 四样都给：全部带齐。
        [{ reason: "tooling_invalid", attempt: 2, timeoutMs: 5000, setupCommands: ["npm ci"] },
          `wao runs delivery reverify ${RUN} --reason tooling_invalid --attempt 2 --setup-commands-file <FILE> --timeout-ms 5000 --cwd <expectedWorkspaceRoot>`],
        // 只给 reason：不带 attempt / timeout / setup。
        [{ reason: "environment_contaminated" },
          `wao runs delivery reverify ${RUN} --reason environment_contaminated --cwd <expectedWorkspaceRoot>`],
        // attempt 1 是缺省、空 setup 等于没给：都不带（照抄与原调用同义）。
        [{ reason: "dependency_setup_missing", attempt: 1, setupCommands: [] },
          `wao runs delivery reverify ${RUN} --reason dependency_setup_missing --cwd <expectedWorkspaceRoot>`],
        // 只给 setup：带文件占位；不带 attempt / timeout。
        [{ reason: "tooling_invalid", setupCommands: ["npm ci", "node build.js"] },
          `wao runs delivery reverify ${RUN} --reason tooling_invalid --setup-commands-file <FILE> --cwd <expectedWorkspaceRoot>`],
        // 只给 attempt 2。
        [{ reason: "tooling_invalid", attempt: 2 },
          `wao runs delivery reverify ${RUN} --reason tooling_invalid --attempt 2 --cwd <expectedWorkspaceRoot>`],
        // 只给 timeoutMs（真实值的位数照写）。
        [{ reason: "tooling_invalid", timeoutMs: 7200000 },
          `wao runs delivery reverify ${RUN} --reason tooling_invalid --timeout-ms 7200000 --cwd <expectedWorkspaceRoot>`],
      ];
      for (const [args, expectedCommand] of cases) {
        const res = await client.callTool({ name: "run_delivery_reverify", arguments: { runId: RUN, expectedWorkspaceRoot: dir, ...args } });
        const text = res.content?.find((b) => b.type === "text")?.text ?? "";
        assert.notEqual(res.isError, true, `${JSON.stringify(args)}: pending 不是错误`);
        assert.equal(res.structuredContent?.status, "pending");
        assert.equal(cliCommandOf(text), expectedCommand, `${JSON.stringify(args)} 的 CLI 写法；实测：${cliCommandOf(text)}`);
        assert.ok(!text.includes(dir), "不回显工作区绝对路径（--cwd 只给占位）");
      }
      // 全部旗标都带上、runId 长到整句放不下：CLI 写法整句不加——不留一条缺旗标、
      // 会重跑错尝试的半截命令；MCP 写法照旧，回执照常返回。
      const longId = "run_" + "y".repeat(80);
      const longRes = await client.callTool({
        name: "run_delivery_reverify",
        arguments: { runId: longId, expectedWorkspaceRoot: dir, reason: "tooling_invalid", attempt: 2, timeoutMs: 5000, setupCommands: ["npm ci"] },
      });
      const longText = longRes.content?.find((b) => b.type === "text")?.text ?? "";
      assert.notEqual(longRes.isError, true);
      assert.equal(longRes.structuredContent?.status, "pending");
      assert.equal(cliCommandOf(longText), null, "放不下就不加 CLI 半句");
      assert.match(longText, /the attempt stops: call run_delivery_reverify again with the same input to re-run it\.$/);
    } finally {
      if (prev === undefined) delete process.env.WAO_DELIVERY_WAIT_MS;
      else process.env.WAO_DELIVERY_WAIT_MS = prev;
      await server.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
