// test/runCollectStdioSmoke.test.js
//
// M11-4 no-model stdio acceptance smoke.
//
// Proves the run_collect continuation contract end-to-end against a REAL
// stdio MCP server (not InMemoryTransport), including:
//   - multi-page assistant text (≥3 pages) with Unicode, cross-page secret,
//     multiple messages, and tool-only evidence;
//   - Host/MCP restart between page 1 and page 2 (kill client + server, start
//     fresh, resume with the opaque cursor — proving the cursor is pure data,
//     not in-process session state);
//   - exact reconstruction: no loss, no duplication, Unicode byte-exact,
//     secret zero-leak across pages;
//   - audit contract: exactly one messages.collected per successful page,
//     monotonic seq; invalid cursor appends zero;
//   - CLI continuation reads the same fixture and produces deep-equal
//     semantic output to MCP structuredContent;
//   - fixture transcript bytes unchanged except for the expected append-only
//     audit events.
//
// No real worker/model is spawned. The transcript is a hand-crafted JSONL
// fixture under os.tmpdir() (never the repo runs/).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SHIM = join(REPO_ROOT, "scripts", "wao-node.cjs");
const STDIO_ENTRY = join(REPO_ROOT, "src", "mcp", "stdio.js");
const CLI_SHIM_ARGS = [SHIM, join(REPO_ROOT, "src", "cli.js")];

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function buildStdioClient({ registryPath, runDir, secretEnv }) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  // secretEnv is the configured secret value to register as WAO_M114_TEST_SECRET
  // so the redactor (matching /SECRET/i) redacts it in assistant text.
  const childEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1" };
  if (secretEnv) childEnv.WAO_M114_TEST_SECRET = secretEnv;
  const args = [SHIM, STDIO_ENTRY, "--registry", registryPath, "--run-dir", runDir];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: childEnv,
  });
  const client = new Client({ name: "wao-smoke-m114", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

// Build a multi-page fixture: many assistant messages + a long single message
// that forces intra-message pagination, plus a Unicode payload, a configured
// secret that repeats across what would be page boundaries, and a tool-only
// event that must NOT consume text quota.
function buildFixture(runDir, runId, secret) {
  mkdirSync(runDir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "run.submitted", agentId: "w", ts: "2026-07-22T00:00:00.000Z" }),
    JSON.stringify({ type: "session.created", backend: "process", backendSessionId: "proc_smoke_m114", runId, agentId: "w" }),
    JSON.stringify({ type: "run.started", backend: "claude-code", ts: "2026-07-22T00:00:01.000Z", runId, agentId: "w" }),
    // Tool-only evidence: must be counted but not consume text quota.
    JSON.stringify({ type: "run.event", kind: "tool_use", tool: "Read", input: { file_path: "src/app.js" }, ts: "2026-07-22T00:00:05.000Z", runId, agentId: "w" }),
  ];
  // 12 short assistant messages → page 1 (8) + page 2 (4).
  for (let i = 0; i < 12; i += 1) {
    lines.push(JSON.stringify({
      type: "run.event", kind: "message", role: "assistant",
      parts: [{ type: "text", text: `short-msg-${i}` }],
      ts: `2026-07-22T00:00:${10 + i}.000Z`, runId, agentId: "w",
    }));
  }
  // One long single message that repeats a configured secret many times —
  // forces intra-message pagination AND cross-page secret redaction.
  const longBody = (`prefix-${secret}-mid-` + "X".repeat(4000) + `-${secret}-suffix-`).repeat(8);
  lines.push(JSON.stringify({
    type: "run.event", kind: "message", role: "assistant",
    parts: [{ type: "text", text: longBody }],
    ts: "2026-07-22T00:01:00.000Z", runId, agentId: "w",
  }));
  // A Unicode payload (CJK + astral emoji + surrogate math symbol) to prove
  // no code-point splitting across pages.
  const unit = "中文🎉𝕏";
  const unicodeBody = unit.repeat(2000); // multi-page on its own
  lines.push(JSON.stringify({
    type: "run.event", kind: "message", role: "assistant",
    parts: [{ type: "text", text: unicodeBody }],
    ts: "2026-07-22T00:02:00.000Z", runId, agentId: "w",
  }));
  lines.push(JSON.stringify({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId, agentId: "w" }));
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  writeFileSync(transcriptPath, lines.map((l) => l + "\n").join(""), "utf8");
  return { transcriptPath, longBody, unicodeBody };
}

test("M11-4-STDIO-SMOKE: multi-page continuation over real stdio with restart, redaction, Unicode, audit, CLI parity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-stdio-"));
  const secret = "test-secret-m114-stdio-abcdef0123456789";
  try {
    const runDir = join(dir, "runs");
    const runId = "run_stdio_m114";
    const { transcriptPath, longBody, unicodeBody } = buildFixture(runDir, runId, secret);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: dir } } }), "utf8");

    // Snapshot the original fixture bytes (before any collect appends audit).
    const originalFixture = readFileSync(transcriptPath, "utf8");

    // ===== Phase 1: MCP stdio page 1 =====
    const expectedShorts = Array.from({ length: 12 }, (_, i) => `short-msg-${i}`);
    const collected = { shorts: [], long: "", unicode: "" };
    let cursor = null;
    let pagePhase = "shorts"; // shorts → long → unicode
    let totalPages = 0;

    // First client/server for page 1.
    let handle = await buildStdioClient({ registryPath, runDir, secretEnv: secret });
    try {
      const res = await handle.client.callTool({ name: "run_collect", arguments: { runId } });
      assert.equal(res.isError, undefined, "page 1 not error");
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.ok(parsed.nextCursor, "page 1 has next cursor");
      cursor = parsed.nextCursor;
      totalPages += 1;
      // Page 1 should be the first 8 short messages (8-message cap).
      assert.equal(parsed.messages.length, 8, "page 1 caps at 8");
      collected.shorts.push(...parsed.messages.map((m) => m.text));
    } finally {
      await handle.client.close();
      await handle.transport.close();
    }

    // ===== Phase 2: Host/MCP RESTART — fresh client/server, same cursor =====
    // This is the key acceptance: the cursor must be pure data, decodable on
    // a brand-new process with no shared memory.
    while (cursor) {
      handle = await buildStdioClient({ registryPath, runDir, secretEnv: secret });
      try {
        const res = await handle.client.callTool({ name: "run_collect", arguments: { runId, cursor } });
        assert.equal(res.isError, undefined, `page ${totalPages + 1} not error`);
        const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
        totalPages += 1;
        // Route the message texts to the right reconstruction bucket.
        for (const m of parsed.messages) {
          if (m.text.startsWith("short-msg-")) collected.shorts.push(m.text);
          else if (m.text.includes("prefix-") || m.text.includes("X".repeat(20)) || m.text.includes("[REDACTED")) collected.long += m.text;
          else collected.unicode += m.text;
        }
        cursor = parsed.nextCursor;
      } finally {
        await handle.client.close();
        await handle.transport.close();
      }
      if (totalPages > 30) throw new Error("runaway pagination");
    }

    // ===== Reconstruction assertions =====
    // 12 short messages all present exactly once in order.
    assert.equal(collected.shorts.length, 12, "all 12 short messages collected");
    assert.deepEqual(collected.shorts, expectedShorts, "shorts in order, exact-once");

    // Long message: secret zero-leak, redaction markers present.
    assert.ok(!collected.long.includes(secret), "LONG secret zero-leak across pages");
    assert.ok(collected.long.includes("[REDACTED"), "LONG redaction marker present");

    // Unicode message: byte-exact reconstruction, no lone surrogates.
    assert.equal(collected.unicode.length, unicodeBody.length, "unicode length matches");
    assert.equal(collected.unicode, unicodeBody, "unicode byte-exact reconstruction");
    for (let i = 0; i < collected.unicode.length; i += 1) {
      const cc = collected.unicode.charCodeAt(i);
      if (cc >= 0xD800 && cc <= 0xDBFF) {
        const next = collected.unicode.charCodeAt(i + 1);
        assert.ok(next >= 0xDC00 && next <= 0xDFFF, `no lone surrogate at ${i}`);
      }
    }

    // ===== Audit contract: exactly one messages.collected per successful page =====
    const eventsAfter = readFileSync(transcriptPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const audits = eventsAfter.filter((e) => e.type === "messages.collected");
    assert.equal(audits.length, totalPages, `exactly ${totalPages} audits for ${totalPages} successful pages`);
    // seq monotonic
    const seqs = audits.map((a) => a.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      assert.ok(seqs[i] > seqs[i - 1], "audit seq monotonic");
    }
    // Audit must not carry cursor token or message text.
    for (const a of audits) {
      const dumped = JSON.stringify(a);
      assert.ok(!/nextCursor/i.test(dumped), "audit has no cursor");
      assert.ok(!/"text"\s*:/.test(dumped), "audit has no message text");
    }

    // ===== Invalid cursor over MCP: zero audit append =====
    const auditsBeforeInvalid = readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
    let invalidHandle = await buildStdioClient({ registryPath, runDir, secretEnv: secret });
    try {
      const res = await invalidHandle.client.callTool({ name: "run_collect", arguments: { runId, cursor: "not!base64url" } });
      assert.equal(res.isError, true, "invalid cursor rejected");
      assert.ok(/run_collect failed/.test(res.content.find((b) => b.type === "text").text));
    } finally {
      await invalidHandle.client.close();
      await invalidHandle.transport.close();
    }
    const auditsAfterInvalid = readFileSync(transcriptPath, "utf8").trim().split("\n")
      .filter((l) => l.includes('"messages.collected"')).length;
    assert.equal(auditsAfterInvalid, auditsBeforeInvalid, "invalid cursor → zero audit append");

    // ===== Fixture integrity: original bytes unchanged except audit appends =====
    const finalContent = readFileSync(transcriptPath, "utf8");
    assert.ok(finalContent.startsWith(originalFixture), "original fixture bytes unchanged at head");
    // Only audit events were appended.
    const originalLineCount = originalFixture.trim().split("\n").length;
    const finalLineCount = finalContent.trim().split("\n").length;
    assert.equal(finalLineCount - originalLineCount, totalPages, "only audit events appended");

    // ===== CLI parity: read same fixture via CLI continuation, deep-equal to MCP =====
    // Use a SEPARATE run dir + identical fixture so CLI audit appends do not
    // pollute the MCP transcript audit count above.
    const cliDir = mkdtempSync(join(tmpdir(), "wao-m114-cli-parity-"));
    try {
      const cliRunDir = join(cliDir, "runs");
      const cliRegistry = join(cliDir, "agents.json");
      writeFileSync(cliRegistry, JSON.stringify({ agents: { w: { backend: "claude-code", cwd: cliDir } } }), "utf8");
      // Reproduce the same fixture (without audit pollution).
      buildFixture(cliRunDir, runId, secret);

      // CLI page 1 (projection mode via --format json). Register the secret
      // under WAO_M114_TEST_SECRET so the redactor (matching /SECRET/i) picks
      // it up in the CLI subprocess.
      const cliEnv = { ...process.env, WAO_SKIP_VERSION_GUARD: "1", WAO_M114_TEST_SECRET: secret };
      const cliOut1 = spawnSync(process.execPath,
        [...CLI_SHIM_ARGS, "collect", runId, "--run-dir", cliRunDir, "--format", "json"],
        { encoding: "utf8", env: cliEnv });
      assert.equal(cliOut1.status, 0, "CLI page 1 exit 0");
      const cliPage1 = JSON.parse(cliOut1.stdout);
      assert.ok(cliPage1.messages, "CLI projection mode yields messages");
      assert.ok(cliPage1.nextCursor, "CLI page 1 has next cursor");
      assert.equal(cliPage1.messages.length, 8, "CLI page 1 caps at 8");
      assert.deepEqual(cliPage1.messages.map((m) => m.text), expectedShorts.slice(0, 8),
        "CLI page 1 first 8 shorts");

      // MCP InMemory page 1 over the SAME fixture (separate copy, no audit
      // cross-pollution) — deep-equal proves CLI and MCP delegate to the same
      // projection.
      const parityDir = mkdtempSync(join(tmpdir(), "wao-m114-parity-mcp-"));
      try {
        const parityRunDir = join(parityDir, "runs");
        buildFixture(parityRunDir, runId, secret);
        const { createWaoMcpServer } = await import("../src/mcp/server.js");
        const { Client } = await import("@modelcontextprotocol/sdk/client");
        const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
        const prevSecret = process.env.WAO_M114_TEST_SECRET;
        process.env.WAO_M114_TEST_SECRET = secret;
        try {
          const mcpServer = createWaoMcpServer({ registryPath: cliRegistry, runDir: parityRunDir });
          const mcpClient = new Client({ name: "wao-parity", version: "0.0.1" }, { capabilities: {} });
          const [c, s] = InMemoryTransport.createLinkedPair();
          await Promise.all([mcpServer.connect(s), mcpClient.connect(c)]);
          try {
            const res = await mcpClient.callTool({ name: "run_collect", arguments: { runId } });
            const mcpPage1 = res.structuredContent;
            // Deep semantic equality on every field except nextCursor literal
            // (different snapshot reads produce different digest bytes, but
            // both must be non-null base64url ≤192).
            assert.deepEqual(cliPage1.messages, mcpPage1.messages, "CLI/MCP page 1 messages deepEqual");
            assert.deepEqual(cliPage1.evidenceCounts, mcpPage1.evidenceCounts, "evidenceCounts deepEqual");
            assert.equal(cliPage1.itemCount, mcpPage1.itemCount);
            assert.equal(cliPage1.backend, mcpPage1.backend);
            assert.equal(cliPage1.reconstructed, mcpPage1.reconstructed);
            assert.equal(cliPage1.truncated, mcpPage1.truncated);
            assert.ok(cliPage1.nextCursor && mcpPage1.nextCursor);
            assert.match(cliPage1.nextCursor, /^[A-Za-z0-9_-]+$/);
          } finally {
            await mcpClient.close();
            await mcpServer.close();
          }
        } finally {
          if (prevSecret === undefined) delete process.env.WAO_M114_TEST_SECRET;
          else process.env.WAO_M114_TEST_SECRET = prevSecret;
        }
      } finally {
        cleanupDir(parityDir);
      }

      // CLI continuation: page 2 via --cursor. Just verify it succeeds,
      // returns a page, and eventually terminates with nextCursor=null when
      // fully consumed. (Full byte-equal parity across all pages is already
      // proven by the B3/B4 focused tests with simpler fixtures.)
      let cliCursor = cliPage1.nextCursor;
      let cliPageCount = 1;
      let cliSafety = 0;
      while (cliCursor) {
        const out = spawnSync(process.execPath,
          [...CLI_SHIM_ARGS, "collect", runId, "--cursor", cliCursor, "--run-dir", cliRunDir, "--format", "json"],
          { encoding: "utf8", env: cliEnv });
        assert.equal(out.status, 0, `CLI page ${cliPageCount + 1} exit 0`);
        const page = JSON.parse(out.stdout);
        cliCursor = page.nextCursor;
        cliPageCount += 1;
        cliSafety += 1;
        if (cliSafety > 30) throw new Error("CLI runaway pagination");
      }
      assert.ok(cliPageCount >= 3, `CLI multi-page (≥3): ${cliPageCount}`);

      // CLI default mode stays byte-compatible (raw data, no projection fields).
      const cliDefaultDir = mkdtempSync(join(tmpdir(), "wao-m114-cli-default-"));
      try {
        const cliDefaultRunDir = join(cliDefaultDir, "runs");
        buildFixture(cliDefaultRunDir, runId, secret);
        const cliDefaultOut = spawnSync(process.execPath,
          [...CLI_SHIM_ARGS, "collect", runId, "--run-dir", cliDefaultRunDir],
          { encoding: "utf8", env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" } });
        assert.equal(cliDefaultOut.status, 0, "CLI default exit 0");
        const cliDefaultParsed = JSON.parse(cliDefaultOut.stdout);
        assert.ok(Array.isArray(cliDefaultParsed.data), "CLI default yields raw data array");
        assert.equal(cliDefaultParsed.reconstructed, true);
        assert.equal(cliDefaultParsed.nextCursor, undefined, "CLI default has no nextCursor");
      } finally {
        cleanupDir(cliDefaultDir);
      }
    } finally {
      cleanupDir(cliDir);
    }

    // ===== At least 3 pages total (multi-page contract) =====
    assert.ok(totalPages >= 3, `multi-page contract: ≥3 pages (got ${totalPages})`);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// M11-4 CTO rework: serve-path no-model continuation over a REAL HTTP
// boundary. A local HTTP server simulates the OpenCode serve
// /session/:id/message?limit=N endpoint. The real OpenCodeServeBackend
// (which uses fetch) calls it through the real stdio MCP server. Proves:
//   - service passes SERVE_PROJECTION_LIMIT (>50) to the serve fetch
//   - the full >50 message list is retrieved in one HTTP call
//   - continuation reads all messages via the same safe projection
// No real worker/model is spawned; the HTTP server is a deterministic fixture.
// =====================================================================
test("M11-4-STDIO-SERVE: serve continuation over real HTTP boundary retrieves >50 messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-m114-stdio-serve-"));
  try {
    const runDir = join(dir, "runs");
    const runId = "run_stdio_serve";
    mkdirSync(runDir, { recursive: true });
    // Serve-backed transcript: session.created carries serveUrl + backendSessionId.
    writeFileSync(join(runDir, `${runId}.jsonl`), [
      JSON.stringify({ type: "run.submitted", agentId: "w", ts: "2026-07-22T00:00:00.000Z" }),
      JSON.stringify({ type: "session.created", backend: "opencode-serve", backendSessionId: "srv_stdio", serveUrl: "http://127.0.0.1:0", runId, agentId: "w" }),
      JSON.stringify({ type: "run.started", backend: "opencode-serve", ts: "2026-07-22T00:00:01.000Z", runId, agentId: "w" }),
      JSON.stringify({ type: "run.state_change", to: "completed", reason: "ok", ts: "2026-07-22T00:10:00.000Z", runId, agentId: "w" }),
    ].map((l) => l + "\n").join(""), "utf8");

    // Start a local HTTP server that simulates OpenCode serve /message.
    const TOTAL_MESSAGES = 60;
    const { createServer } = await import("node:http");
    const httpServer = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      // Serve returns the LAST `limit` messages (real OpenCode semantics).
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const all = [];
      for (let i = 0; i < TOTAL_MESSAGES; i += 1) {
        all.push({ info: { role: "assistant" }, parts: [{ type: "text", text: `srv-m${i}` }] });
      }
      const data = all.slice(-limit);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    });
    await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
    const httpPort = httpServer.address().port;
    const realServeUrl = `http://127.0.0.1:${httpPort}`;

    try {
      // Patch the transcript's serveUrl to the actual local port.
      const tpath = join(runDir, `${runId}.jsonl`);
      const lines = readFileSync(tpath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      for (const l of lines) {
        if (l.type === "session.created") l.serveUrl = realServeUrl;
      }
      writeFileSync(tpath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

      // The stdio subprocess uses the default collectRunMessages which calls
      // OpenCodeServeBackend.messages() for serve-backed runs. The HTTP
      // boundary is exercised for real (no fake fetch).
      const collected = [];
      let cursor = null;
      let pages = 0;
      while (true) {
        // Real stdio MCP server subprocess. The subprocess inherits none of
        // our in-memory state; it reads the transcript, sees serveUrl, and
        // fetches the local HTTP server via the REAL OpenCodeServeBackend.
        // This exercises the true serve HTTP boundary end-to-end.
        const handle = await buildStdioClient({ registryPath: join(dir, "agents.json"), runDir });
        try {
          const args = cursor ? { runId, cursor } : { runId };
          const res = await handle.client.callTool({ name: "run_collect", arguments: args });
          assert.equal(res.isError, undefined, `serve page ${pages + 1} not error`);
          const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
          collected.push(...parsed.messages.map((m) => m.text));
          cursor = parsed.nextCursor;
          pages += 1;
        } finally {
          await handle.client.close();
          await handle.transport.close();
        }
        if (!cursor) break;
        if (pages > 20) throw new Error("runaway");
      }
      assert.equal(collected.length, TOTAL_MESSAGES, `all ${TOTAL_MESSAGES} serve messages retrieved`);
      for (let i = 0; i < TOTAL_MESSAGES; i += 1) {
        assert.equal(collected[i], `srv-m${i}`, `serve msg ${i} in order`);
      }
      assert.ok(pages >= 2, `serve multi-page (${pages})`);
    } finally {
      await new Promise((r) => httpServer.close(r));
    }
  } finally {
    cleanupDir(dir);
  }
});
