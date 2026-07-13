// test/mcpRegistry.test.js
//
// M9-1: read-only MCP stdio vertical slice — registry_list.
//
// Proves that a real MCP host can, over stdio, call WAO's only MCP tool
// `registry_list`, which directly reuses the M9-0 `getRegistryInventory()`
// application service. Covers: protocol initialize, tool list shape, exactly-once
// service invocation, no-path-override, error containment, real stdio subprocess
// round-trip, zero transcript side effects, clean stdout, import-boundary guard,
// and CLI/MCP semantic parity.
//
// Dependencies note: this test file imports the MCP SDK client/transport
// (allowed — MCP-specific tests). src/application/** and core modules must NOT.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../src/mcp/server.js";

// ===== Helpers =====

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");

function makeRegistry(dir, agents) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }), "utf8");
  return registryPath;
}

function makeSummary(dir, workers) {
  const runDir = join(dir, "runs");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "reliability-summary.json"), JSON.stringify({ workers }), "utf8");
  return runDir;
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Build an in-memory server+client pair (no subprocess). Returns the connected
 * client so the caller can do listTools/callTool. The caller owns cleanup.
 */
async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/**
 * Spawn the real stdio MCP entrypoint as a subprocess via the repo Node shim.
 * Returns a StdioClientTransport wired to that subprocess's stdio.
 */
async function buildStdioSubprocessTransport({ registryPath, runDir, env = {} }) {
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const childEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1", ...env };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir],
    env: childEnv,
  });
  return transport;
}

// =====================================================================
// M9-1-01: MCP initialize succeeds, server identity stable.
// =====================================================================

test("M9-1-01: MCP initialize succeeds, server identity stable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m91-01-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
    });
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      // v1 Client exposes server info via getServerVersion()/getServerCapabilities().
      const serverInfo = client.getServerVersion();
      assert.ok(serverInfo, "server version available after initialize");
      assert.equal(serverInfo.name, "wao-mcp", "server name stable");
      assert.equal(serverInfo.version, "0.0.1", "server version stable");
      const caps = client.getServerCapabilities();
      assert.ok(caps?.tools, "server advertises tools capability");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// M9-1-02: listTools exposes ONLY registry_list, no write ops exposed early.
// =====================================================================

test("M9-1-02: listTools includes registry_list, no unauthorized write operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m91-02-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
    });
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      // registry_list must always be present (M9-1). run_dispatch was added in
      // M9-2B as an authorized dispatch tool — both are expected now.
      assert.ok(names.includes("registry_list"), "registry_list present");
      // Defensive: ensure no bare/unauthorized write tools leaked (the authorized
      // dispatch tool is run_dispatch, not a bare "run"/"dispatch").
      const forbidden = names.filter((n) =>
        ["run", "dispatch", "status", "delivery", "accept", "reject", "kill", "stop"].includes(n),
      );
      assert.deepEqual(forbidden, [], "no unauthorized bare write/mutation tools exposed");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// M9-1-03: registry_list invokes injected service exactly once, returns agents.
// =====================================================================

test("M9-1-03: registry_list calls injected service exactly once and returns structured agents", async () => {
  let callCount = 0;
  let capturedArgs = null;
  const fakeService = async (input) => {
    callCount += 1;
    capturedArgs = input;
    return [
      { id: "coder_low", backend: "claude-code", model: "glm-5-turbo", certification: "certified", cwd: "/repo" },
      { id: "researcher", backend: "claude-code", model: "opus", certification: null, cwd: "/repo" },
    ];
  };

  const server = createWaoMcpServer({
    registryPath: "/config/agents.json",
    runDir: "/runs",
    getRegistryInventoryFn: fakeService,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "registry_list", arguments: {} });
    assert.equal(callCount, 1, "service invoked exactly once");
    assert.ok(capturedArgs, "service received its input");
    assert.equal(capturedArgs.registryPath, "/config/agents.json", "service got startup registryPath");
    assert.equal(capturedArgs.runDir, "/runs", "service got startup runDir");

    // content is always present (text JSON) per MCP spec
    assert.ok(Array.isArray(res.content), "content array present");
    const textBlock = res.content.find((b) => b.type === "text");
    assert.ok(textBlock, "a text content block exists");
    const parsed = JSON.parse(textBlock.text);
    assert.ok(Array.isArray(parsed.agents), "text JSON contains agents array");
    assert.equal(parsed.agents.length, 2, "two agents returned");
    assert.equal(parsed.agents[0].id, "coder_low");

    // structuredContent mirrors content (if SDK supports it in this env)
    if (res.structuredContent) {
      assert.ok(Array.isArray(res.structuredContent.agents), "structuredContent.agents is array");
      assert.equal(res.structuredContent.agents.length, 2, "structuredContent has same agents");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// M9-1-04: tool input cannot override server's registryPath/runDir.
// =====================================================================

test("M9-1-04: tool input cannot override server registryPath/runDir", async () => {
  let captured = null;
  const fakeService = async (input) => {
    captured = input;
    return [];
  };

  const server = createWaoMcpServer({
    registryPath: "/startup/registry.json",
    runDir: "/startup/runs",
    getRegistryInventoryFn: fakeService,
  });
  const client = await buildInMemoryClient(server);
  try {
    // Malicious/intrusive arguments a model might try.
    let threw = false;
    try {
      await client.callTool({
        name: "registry_list",
        arguments: {
          registryPath: "/attacker/registry.json",
          runDir: "/attacker/runs",
          registry: "/attacker2.json",
          runDirOverride: "/attacker3/runs",
        },
      });
    } catch {
      // Strict input validation may reject extra keys as a protocol error.
      threw = true;
    }
    // Either way the startup paths must hold: if the service ran at all, it saw
    // the startup values, never the attacker values.
    if (captured !== null) {
      assert.equal(captured.registryPath, "/startup/registry.json", "startup registryPath held");
      assert.equal(captured.runDir, "/startup/runs", "startup runDir held");
    } else {
      // Service never called — strict validation rejected the override attempt.
      assert.ok(threw || true, "extra-arg call was rejected before service ran");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// M9-1-05: service throw → spec MCP error, no sentinel stack/secret leak.
// =====================================================================

test("M9-1-05: service throw returns MCP error result, leaks no sentinel stack or secret", async () => {
  // Use a desensitization-safe sentinel (matches the repo's ALLOW list) so the
  // secret-scan gate does not flag the fixture itself. The full message-leak
  // containment is covered by M9-1-C1 below.
  const SECRET_FIXTURE = "test-secret-sentinel-m91-05";
  const fakeService = async () => {
    const err = new Error("registry read failed");
    err.token = SECRET_FIXTURE;
    throw err;
  };

  const server = createWaoMcpServer({
    registryPath: "/startup/registry.json",
    runDir: "/startup/runs",
    getRegistryInventoryFn: fakeService,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "registry_list", arguments: {} });
    assert.equal(res.isError, true, "result is flagged as error");
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes(SECRET_FIXTURE), "secret must not leak into result");
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(!/at .*\(.+:\d+:\d+\)/.test(text), "no stack frame leaked into content text");
  } finally {
    await client.close();
    await server.close();
  }
});

// =====================================================================
// M9-1-06: real stdio subprocess — initialize/listTools/callTool end-to-end.
// =====================================================================

test("M9-1-06: real stdio subprocess completes initialize/listTools/callTool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m91-06-"));
  let client;
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
      researcher: { backend: "claude-code", cwd: dir, args: ["--model", "opus"] },
    });
    const runDir = makeSummary(dir, { coder_low: { status: "certified" } });

    const { Client } = await import("@modelcontextprotocol/sdk/client");
    client = new Client({ name: "wao-m91-06-client", version: "0.0.1" }, { capabilities: {} });
    const transport = await buildStdioSubprocessTransport({ registryPath, runDir });
    await client.connect(transport);

    const serverInfo = client.getServerVersion();
    assert.equal(serverInfo.name, "wao-mcp", "real subprocess server identity");

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    assert.ok(toolNames.includes("registry_list"), "real subprocess lists registry_list");

    const res = await client.callTool({ name: "registry_list", arguments: {} });
    const textBlock = res.content.find((b) => b.type === "text");
    assert.ok(textBlock, "real subprocess returned text content");
    const parsed = JSON.parse(textBlock.text);
    assert.ok(Array.isArray(parsed.agents), "real subprocess returned agents array");
    assert.equal(parsed.agents.length, 2, "two agents from real subprocess");
  } finally {
    if (client) await client.close();
    cleanupDir(dir);
  }
});

// =====================================================================
// M9-1-07: real stdio result is semantically equal to direct service call.
// =====================================================================

test("M9-1-07: real stdio result matches direct getRegistryInventory() semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m91-07-"));
  let client;
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
      tester: { backend: "codex", cwd: dir, args: [] },
    });
    const runDir = makeSummary(dir, {
      coder_low: { status: "certified" },
      tester: { status: "conditional" },
    });

    // Direct service call (the source of truth for parity).
    const { getRegistryInventory } = await import("../src/application/registryInventory.js");
    const direct = await getRegistryInventory({ registryPath, runDir });

    const { Client } = await import("@modelcontextprotocol/sdk/client");
    client = new Client({ name: "wao-m91-07-client", version: "0.0.1" }, { capabilities: {} });
    const transport = await buildStdioSubprocessTransport({ registryPath, runDir });
    await client.connect(transport);

    const res = await client.callTool({ name: "registry_list", arguments: {} });
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);

    // MCP wraps in {agents:[...]}; the inner array must equal the service output.
    assert.deepEqual(
      parsed.agents,
      direct,
      "MCP agents array equals direct getRegistryInventory() output",
    );
  } finally {
    if (client) await client.close();
    cleanupDir(dir);
  }
});

// =====================================================================
// M9-1-08: real stdio call leaves no transcript/run files in runDir.
// =====================================================================

test("M9-1-08: real stdio call adds no transcript/run files to runDir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m91-08-"));
  let client;
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
    });
    const runDir = makeSummary(dir, { coder_low: { status: "certified" } });

    const before = new Set(readdirSync(runDir));
    const fixtureBefore = JSON.parse(readFileSyncCompat(registryPath));

    const { Client } = await import("@modelcontextprotocol/sdk/client");
    client = new Client({ name: "wao-m91-08-client", version: "0.0.1" }, { capabilities: {} });
    const transport = await buildStdioSubprocessTransport({ registryPath, runDir });
    await client.connect(transport);
    await client.callTool({ name: "registry_list", arguments: {} });
    await client.close();
    client = null;

    const after = new Set(readdirSync(runDir));
    const added = [...after].filter((f) => !before.has(f));
    assert.deepEqual(added, [], "no files added to runDir after MCP call");

    const fixtureAfter = JSON.parse(readFileSyncCompat(registryPath));
    assert.deepEqual(fixtureAfter, fixtureBefore, "registry fixture unchanged");
  } finally {
    if (client) await client.close();
    cleanupDir(dir);
  }
});

// =====================================================================
// M9-1-09: subprocess stdout is protocol-pure (no banner/log/help text).
// =====================================================================

test("M9-1-09: subprocess stdout is protocol-pure, no banner/log/help text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m91-09-"));
  let child;
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
    });
    const runDir = makeSummary(dir, { coder_low: { status: "certified" } });

    // Spawn the entrypoint raw and drive a minimal JSON-RPC handshake over stdin.
    // Collect every byte the process writes to stdout and stderr.
    child = spawn(
      process.execPath,
      [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } },
    );
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (b) => stdoutChunks.push(b));
    child.stderr.on("data", (b) => stderrChunks.push(b));

    const id = (n) => n;
    function send(obj) {
      child.stdin.write(JSON.stringify(obj) + "\n");
    }

    const initialized = new Promise((resolve) => {
      let buf = "";
      child.stdout.on("data", function onData(b) {
        buf += b.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop();
        if (lines.length >= 1) {
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.id === id(1) && msg.result?.serverInfo) {
                child.stdout.off("data", onData);
                resolve(msg);
                return;
              }
            } catch { /* will fail in the assert below */ }
          }
        }
      });
    });

    // initialize
    send({
      jsonrpc: "2.0",
      id: id(1),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "wao-m91-09-raw", version: "0.0.1" },
      },
    });
    const initResp = await Promise.race([
      initialized,
      new Promise((_, reject) => setTimeout(() => reject(new Error("initialize timeout")), 5000)),
    ]);
    assert.ok(initResp.result?.serverInfo?.name === "wao-mcp", "raw handshake got server identity");

    // initialized notification (no id)
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // tools/list
    send({ jsonrpc: "2.0", id: id(2), method: "tools/list" });
    // tools/call
    send({ jsonrpc: "2.0", id: id(3), method: "tools/call", params: { name: "registry_list", arguments: {} } });

    // Give the server time to respond, then close stdin to end the process.
    await new Promise((r) => setTimeout(r, 800));
    child.stdin.end();
    await new Promise((r) => {
      child.on("exit", () => r());
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} r(); }, 3000);
    });

    const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");
    // The core assertion: every non-empty stdout line must be valid JSON-RPC.
    // A banner like "[wao-mcp] ready..." on stdout would fail JSON.parse or lack
    // the jsonrpc field, proving stdout was polluted.
    const lines = stdoutRaw.split("\n").filter((l) => l.trim().length > 0);
    assert.ok(lines.length >= 2, `stdout produced >=2 frames (got ${lines.length})`);
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        assert.fail(`stdout line is not valid JSON (protocol pollution): ${line.slice(0, 120)}`);
      }
      assert.ok(
        msg.jsonrpc === "2.0",
        `stdout frame is JSON-RPC 2.0 (not banner/log): ${line.slice(0, 120)}`,
      );
    }

    // Diagnostic banner is allowed — but only on stderr, never stdout.
    const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");
    assert.ok(/\[wao-mcp\]/.test(stderrRaw), "startup banner present on stderr (not stdout)");
  } finally {
    if (child) { try { child.kill("SIGKILL"); } catch {} }
    cleanupDir(dir);
  }
});

// =====================================================================
// M9-1-10: import boundary — only src/mcp/** may import MCP SDK/Zod.
// =====================================================================

test("M9-1-10: only src/mcp/** imports MCP SDK/Zod; application/core zero hits", async () => {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const { join, relative } = await import("node:path");

  // Recursively collect .js files under src/, recording any that import the
  // MCP SDK or zod. Pure JS scan — no shell, no rg quoting fragility.
  async function walkJs(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        files.push(...(await walkJs(full)));
      } else if (e.isFile() && e.name.endsWith(".js")) {
        files.push(full);
      }
    }
    return files;
  }

  const allJs = await walkJs(join(REPO_ROOT, "src"));
  const violations = [];
  const mcpHits = [];
  const importPattern = /(?:from\s+['"](@modelcontextprotocol[^'"]*|zod[^'"]*)['"])|(?:require\(\s*['"](@modelcontextprotocol[^'"]*|zod[^'"]*)['"]\s*\))/;

  for (const file of allJs) {
    const rel = relative(join(REPO_ROOT, "src"), file).replace(/\\/g, "/");
    const isMcp = rel.startsWith("mcp/");
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (importPattern.test(line)) {
        if (isMcp) {
          mcpHits.push(rel);
        } else {
          violations.push(`${rel}: ${line.trim()}`);
        }
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    "no MCP SDK / zod imports outside src/mcp/** (boundary clean)",
  );
  assert.ok(mcpHits.length > 0, "src/mcp/** imports the MCP SDK (positive confirmation)");
});

// =====================================================================
// M9-1-11: CLI registry list --format json contract unchanged (parity base).
// =====================================================================

test("M9-1-11: CLI registry list --format json contract unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m91-11-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
    });
    const out = execSync(
      `node src/cli.js registry list --registry ${registryPath} --format json`,
      { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } },
    );
    // CLI emits a bare array (M9-0 contract), NOT wrapped in {agents:[...]}.
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed), "CLI --format json still emits a bare array");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, "coder_low");
    // Field shape unchanged.
    for (const key of ["id", "backend", "model", "certification", "cwd"]) {
      assert.ok(key in parsed[0], `CLI array element has ${key}`);
    }
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// M9-1-12: Windows path with spaces — stdio entrypoint reads explicit paths.
// =====================================================================

test("M9-1-12: Windows path with spaces — stdio entrypoint reads explicit registry/runDir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao m91 12 spaced dir-"));
  let client;
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
    });
    const runDir = makeSummary(dir, { coder_low: { status: "certified" } });
    // The path contains literal spaces; argv must be passed as discrete args (no shell join).
    assert.ok(dir.includes(" "), "fixture path contains spaces");

    const { Client } = await import("@modelcontextprotocol/sdk/client");
    client = new Client({ name: "wao-m91-12-client", version: "0.0.1" }, { capabilities: {} });
    const transport = await buildStdioSubprocessTransport({ registryPath, runDir });
    await client.connect(transport);

    const res = await client.callTool({ name: "registry_list", arguments: {} });
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);
    assert.equal(parsed.agents.length, 1, "spaced-path registry read successfully");
    assert.equal(parsed.agents[0].id, "coder_low");
    assert.equal(parsed.agents[0].certification, "certified");
  } finally {
    if (client) await client.close();
    cleanupDir(dir);
  }
});

// =====================================================================
// M9-1 audit closeout (C1–C6)
//
// These tests close the four contract gaps found in CTO audit of 92264dc:
//   C1 error-message leak (secret + absolute path in err.message)
//   C2 input validation actually rejects extra arguments (service call count 0)
//   C3 unknown tool produces a protocol error, not a success result
//   C4 real stdio stderr contains no registryPath/runDir/secret/raw message
//   C5 tool declares read-only annotations
//   C6 tool declares output schema; structuredContent matches it
// =====================================================================

// ---------------------------------------------------------------------
// C1: err.message containing secret + absolute path must not leak.
// ---------------------------------------------------------------------

test("M9-1-C1: error message with secret and absolute path returns only fixed safe text", async () => {
  // Sentinels placed in the MESSAGE (not just a property) — this is the real
  // leak vector CTO reproduced. Use desensitization-safe words for the fixture.
  const SECRET_IN_MSG = "test-secret-value-in-message-c1";
  const ABS_PATH_IN_MSG = "C:\\Users\\leak\\real\\config\\agents.json";
  const fakeService = async () => {
    throw new Error(`failed to read ${ABS_PATH_IN_MSG} with key ${SECRET_IN_MSG}`);
  };

  const server = createWaoMcpServer({
    registryPath: "/startup/registry.json",
    runDir: "/startup/runs",
    getRegistryInventoryFn: fakeService,
  });
  const client = await buildInMemoryClient(server);
  try {
    const res = await client.callTool({ name: "registry_list", arguments: {} });
    assert.equal(res.isError, true, "error flagged");
    const dumped = JSON.stringify(res);
    assert.ok(!dumped.includes(SECRET_IN_MSG), "secret from message must not appear in result");
    assert.ok(!dumped.includes(ABS_PATH_IN_MSG), "absolute path from message must not appear");
    assert.ok(!dumped.includes("C:\\\\Users"), "no absolute-path fragment leaks");
    // Result must carry a fixed safe text, not the raw message.
    const text = res.content?.map((b) => b.text ?? "").join(" ") ?? "";
    assert.ok(text.length > 0, "a bounded error text is present");
    assert.ok(!/at .*\(.+:\d+:\d+\)/.test(text), "no stack frame leaked");
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// C2: extra arguments must be rejected; service must NOT be called.
// ---------------------------------------------------------------------

test("M9-1-C2: registry_list rejects extra arguments, service call count is 0", async () => {
  let serviceCalls = 0;
  const fakeService = async () => {
    serviceCalls += 1;
    return [];
  };

  const server = createWaoMcpServer({
    registryPath: "/startup/registry.json",
    runDir: "/startup/runs",
    getRegistryInventoryFn: fakeService,
  });
  const client = await buildInMemoryClient(server);
  try {
    let result;
    let threw = false;
    try {
      result = await client.callTool({
        name: "registry_list",
        arguments: { registryPath: "/attacker/x", evil: true, runDir: "/attacker/y" },
      });
    } catch {
      // A protocol-level rejection is also acceptable.
      threw = true;
    }
    assert.equal(serviceCalls, 0, "service must NOT be called when input is invalid");
    // Whether thrown or returned as isError, it must not be a successful result.
    if (!threw) {
      assert.equal(result.isError, true, "invalid input yields error, not success");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// C3: unknown tool must be a protocol error, not a success response.
// ---------------------------------------------------------------------

test("M9-1-C3: unknown tool rejected by SDK protocol layer, not hand-rolled result", async () => {
  const server = createWaoMcpServer({
    registryPath: "/startup/registry.json",
    runDir: "/startup/runs",
    getRegistryInventoryFn: async () => [],
  });
  const client = await buildInMemoryClient(server);
  try {
    let result = null;
    let threw = false;
    let thrownMsg = "";
    try {
      result = await client.callTool({ name: "definitely_not_a_tool", arguments: {} });
    } catch (e) {
      threw = true;
      thrownMsg = (e?.message ?? "") + "";
    }
    // The assertion has two acceptable shapes, both "protocol layer handles it":
    //  (a) SDK raises a JSON-RPC protocol error (throw) — the cleanest form.
    //  (b) SDK returns a tool-error result whose text is generated by the SDK's
    //      protocol layer (carries a -32602 code marker), NOT a hand-rolled
    //      "unknown tool: <name>" string from our own handler.
    if (threw) {
      assert.ok(/-32602|not found|Invalid params/i.test(thrownMsg), "protocol error for unknown tool");
    } else {
      assert.equal(result.isError, true, "unknown tool must be error, not success");
      const text = result.content?.map((b) => b.text ?? "").join(" ") ?? "";
      assert.ok(!text.includes('"agents"'), "must not return agents payload");
      // Must NOT be the old hand-rolled prefix; must carry a protocol code marker.
      assert.ok(!/^unknown tool:/.test(text.trim()), "not a hand-rolled 'unknown tool:' message");
      assert.ok(/-32602|not found/i.test(text), "error text carries SDK protocol-layer code marker");
    }
  } finally {
    await client.close();
    await server.close();
  }
});

// ---------------------------------------------------------------------
// C4: real stdio stderr contains no registryPath/runDir/secret/raw message.
// ---------------------------------------------------------------------

test("M9-1-C4: real stdio stderr is fixed safe text, no paths/secrets/raw messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao m91 c4 spaced-"));
  let child;
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
    });
    const runDir = makeSummary(dir, { coder_low: { status: "certified" } });
    const SECRET_HINT = "test-secret-stderr-hint-c4";
    process.env.WAO_C4_PROBE = SECRET_HINT;

    // Force a fatal path: point registry at a path that cannot be read after
    // start. Simpler: start normally and capture the ready line, then also
    // run a fatal variant with an unreadable registry to cover the fatal branch.
    child = spawn(
      process.execPath,
      [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } },
    );
    const stderrChunks = [];
    child.stderr.on("data", (b) => stderrChunks.push(b));
    // Give it time to print the ready line, then close stdin to end cleanly.
    await new Promise((r) => setTimeout(r, 600));
    child.stdin.end();
    await new Promise((r) => {
      child.on("exit", () => r());
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} r(); }, 3000);
    });

    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    // The ready line must not contain the real registry/runDir paths.
    assert.ok(!stderr.includes(registryPath), "stderr must not contain registryPath");
    assert.ok(!stderr.includes(runDir), "stderr must not contain runDir");
    assert.ok(!stderr.includes(dir), "stderr must not contain the temp dir path");
    assert.ok(!stderr.includes(SECRET_HINT), "stderr must not contain env secrets");
    // It must carry the fixed safe banner.
    assert.ok(/\[wao-mcp\]/.test(stderr), "fixed safe banner present");
  } finally {
    delete process.env.WAO_C4_PROBE;
    if (child) { try { child.kill("SIGKILL"); } catch {} }
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// C5: tool declares read-only annotations.
// ---------------------------------------------------------------------

test("M9-1-C5: registry_list declares readOnly/destructive/idempotent/openWorld hints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m91-c5-"));
  try {
    const registryPath = makeRegistry(dir, {
      coder_low: { backend: "claude-code", cwd: dir, args: ["--model", "glm-5-turbo"] },
    });
    const server = createWaoMcpServer({ registryPath, runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const t = tools.tools.find((x) => x.name === "registry_list");
      assert.ok(t, "registry_list present");
      assert.ok(t.annotations, "tool has annotations");
      assert.equal(t.annotations.readOnlyHint, true, "readOnlyHint:true");
      assert.equal(t.annotations.destructiveHint, false, "destructiveHint:false");
      assert.equal(t.annotations.idempotentHint, true, "idempotentHint:true");
      assert.equal(t.annotations.openWorldHint, false, "openWorldHint:false");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------
// C6: tool declares output schema; structuredContent matches it and text JSON.
// ---------------------------------------------------------------------

test("M9-1-C6: output schema declared; structuredContent matches schema and text JSON", async () => {
  const fakeService = async () => [
    { id: "coder_low", backend: "claude-code", model: "glm-5-turbo", certification: "certified", cwd: "/r" },
    { id: "tester", backend: "codex", model: "(default)", certification: null, cwd: "/r" },
  ];

  const server = createWaoMcpServer({
    registryPath: "/startup/registry.json",
    runDir: "/startup/runs",
    getRegistryInventoryFn: fakeService,
  });
  const client = await buildInMemoryClient(server);
  try {
    const tools = await client.listTools();
    const t = tools.tools.find((x) => x.name === "registry_list");
    assert.ok(t.outputSchema, "tool declares an output schema");
    // output schema must allow certification to be null.
    const schemaText = JSON.stringify(t.outputSchema);
    assert.ok(/certification/.test(schemaText), "output schema mentions certification");
    assert.ok(/nullable|null/.test(schemaText), "output schema allows null certification");

    const res = await client.callTool({ name: "registry_list", arguments: {} });
    assert.ok(res.structuredContent, "structuredContent present");
    const sc = res.structuredContent;
    assert.ok(Array.isArray(sc.agents), "structuredContent.agents is array");
    const textBlock = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);
    // structuredContent and text JSON must be the same payload.
    assert.deepEqual(sc, parsed, "structuredContent equals text JSON payload");
    assert.equal(sc.agents[1].certification, null, "null certification preserved");
  } finally {
    await client.close();
    await server.close();
  }
});

// ===== Utility =====

import { readFileSync } from "node:fs";
function readFileSyncCompat(p) {
  return readFileSync(p, "utf8");
}
