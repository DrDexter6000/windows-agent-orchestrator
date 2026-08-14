// test/m12-6-dispatchPreflight.test.js
//
// M12-6 (FR-03 + FR-04): run_dispatch preflight TDD tests.
//
// FR-03 — workspace/head expectation preflight:
//   A Lead may optionally freeze dispatch to expectedGitHead (canonical 40/64
//   lowercase hex), expectedDirty (boolean), and expectedWorkspaceRoot (absolute
//   path, bounded). On mismatch the dispatch is refused BEFORE the dispatcher is
//   invoked (zero provider process, transcript, worktree, or run) with fixed safe
//   `workspace_expectation_mismatch` semantics that echo no absolute path or
//   arbitrary input. On success a strict bounded workspaceProof (source, canonical
//   head, dirty, nullable match booleans — NO absolute path) is attached.
//   Omitted expectations preserve existing behavior and still attach the proof.
//
// FR-04 — invalid_verification_path:
//   Verification commands containing a statically identifiable absolute path
//   literal (Windows drive / UNC / POSIX, including prefixed literals after
//   assignment/redirection/separators) are rejected with deliveryCode
//   invalid_verification_path before any durable side effect. URLs, relative
//   paths, and flags are NOT flagged (no shell interpretation, no URL false
//   positives). At the MCP boundary this typed error surfaces as a FIXED
//   actionable text that names the closed-set code invalid_verification_path —
//   the offending path/command/error is never echoed, but the code is (so the
//   Lead can act on it rather than receiving an opaque "run_dispatch failed").
//
// Causality is proven with dispatcher call counts: a mismatch or an invalid path
// keeps the count at 0; a correct dispatch calls the dispatcher exactly once.
//
// Isolation note: the registry file and runDir live in a SEPARATE temp dir from
// the git workspace, so the workspace stays deterministically clean (an untracked
// agents.json would otherwise make every repo read as dirty).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { createWaoMcpServer } from "../../src/mcp/server.js";
import { checkWorkspaceExpectation } from "../../src/application/workspaceExpectation.js";
import { canonicalizeWorkspacePath } from "../../src/application/workspaceBinding.js";

// ===== Helpers =====

const IS_WIN32 = process.platform === "win32";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Create a clean git workspace + a SEPARATE aux dir holding the registry and
// runDir, so the workspace's dirty flag is deterministic.
function setup() {
  const repo = mkdtempSync(join(tmpdir(), "wao-m126-repo-"));
  makeGitRepo(repo);
  const aux = mkdtempSync(join(tmpdir(), "wao-m126-aux-"));
  const registryPath = join(aux, "agents.json");
  writeFileSync(registryPath, JSON.stringify({
    agents: { coder_low: { backend: "claude-code", cwd: repo } },
  }), "utf8");
  const runDir = join(aux, "runs");
  return { repo, aux, registryPath, runDir };
}

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m init', { cwd: dir, stdio: "pipe" });
}

function gitHead(dir) {
  return execSync("git rev-parse HEAD", {
    cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

function makeDirty(dir) {
  writeFileSync(join(dir, "untracked-m12-6.txt"), "change\n", "utf8");
}

function advanceHead(dir) {
  writeFileSync(join(dir, "next.md"), "# next\n", "utf8");
  execSync("git add next.md", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m next', { cwd: dir, stdio: "pipe" });
}

// Flip the drive-letter case of an absolute Windows path (no-op elsewhere) to
// prove case-equivalent workspace roots match on win32.
function flipDriveCase(p) {
  if (IS_WIN32 && /^[a-zA-Z]:/.test(p)) {
    const flipped = p[0] === p[0].toUpperCase() ? p[0].toLowerCase() : p[0].toUpperCase();
    return flipped + p.slice(1);
  }
  return p;
}

function readdirSafe(p) {
  try { return readdirSync(p); } catch { return []; }
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-client", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// fakeDispatch echoes the requested agentId so the success parse is reached and
// the additive workspaceProof can be inspected. Records call count + captured cwd
// (proving the SAME proven binding that satisfied the expectation drives dispatch).
function makeFakeDispatch() {
  let callCount = 0;
  let captured = null;
  const fn = async (input) => {
    callCount += 1;
    captured = input;
    // M12-25: providerSessionRouting is now a required closed-set field on every
    // run_dispatch success output (no MCP fallback), so the success-path fake
    // carries the ordinary no-reuse value.
    return { accepted: true, runId: "run_m12_6_fake", agentId: input.agentId, state: "pending", providerSessionRouting: "not_used" };
  };
  return {
    fn,
    get count() { return callCount; },
    get captured() { return captured; },
  };
}

function textOf(res) {
  return res.content?.map((b) => b.text ?? "").join(" ") ?? "";
}

function parseText(res) {
  return JSON.parse(res.content.find((b) => b.type === "text").text);
}

// ===== FR-03: workspace/head expectation preflight =====

test("M12-6-FR03-A: omitted expectations preserve behavior and attach additive proof", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch", arguments: { agentId: "coder_low", prompt: "do it" },
      });
      assert.equal(fake.count, 1, "dispatch happened exactly once (behavior preserved)");
      const parsed = parseText(res);
      assert.equal(parsed.accepted, true);
      // Additive proof; no expectations supplied → all match booleans null.
      assert.equal(parsed.workspaceProof.expectedGitHeadMatch, null);
      assert.equal(parsed.workspaceProof.expectedDirtyMatch, null);
      assert.equal(parsed.workspaceProof.expectedWorkspaceRootMatch, null);
      assert.equal(parsed.workspaceProof.source, "server_config");
      assert.equal(parsed.workspaceProof.gitHead, gitHead(repo));
      assert.equal(parsed.workspaceProof.dirty, false, "isolated workspace is clean");
      // The proof must NOT echo the absolute workspace root.
      assert.ok(!JSON.stringify(res).includes(repo.replace(/\\/g, "/")), "no absolute root in proof");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("M12-6-FR03-B: matching expectedGitHead succeeds, expectedGitHeadMatch true, count 1", async () => {
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
        arguments: { agentId: "coder_low", prompt: "do it", expectedGitHead: gitHead(repo) },
      });
      assert.equal(fake.count, 1, "dispatch once when head matches");
      const parsed = parseText(res);
      assert.equal(parsed.workspaceProof.expectedGitHeadMatch, true);
      // The cwd handed to the dispatcher is the SAME canonical root the proof was
      // derived from (single binding — no re-resolution between preflight & dispatch).
      assert.equal(fake.captured.cwd, canonicalizeWorkspacePath(repo), "dispatcher cwd is the proven root");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("M12-6-FR03-C: stale expectedGitHead (workspace moved) refused before dispatch, count 0", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const staleHead = gitHead(repo);
    // The workspace HEAD advances AFTER the Lead froze its expectation — the
    // frozen head is now stale and must be rejected before any dispatch.
    advanceHead(repo);
    assert.notEqual(gitHead(repo), staleHead, "sanity: HEAD actually moved");

    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "do it", expectedGitHead: staleHead },
      });
      assert.equal(fake.count, 0, "dispatcher never called for stale head");
      assert.equal(res.isError, true, "mismatch is a tool error");
      const text = textOf(res);
      assert.match(text, /workspace_expectation_mismatch/);
      assert.match(text, /gitHead/);
      // No head value (stale or current) is echoed.
      assert.ok(!text.includes(staleHead), "stale head not echoed");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("M12-6-FR03-D: matching expectedDirty true/false succeeds", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    // Clean repo → dirty false matches.
    const fakeClean = makeFakeDispatch();
    const serverClean = createWaoMcpServer({
      registryPath, runDir: join(aux, "runs-clean"), workspaceRoot: repo, dispatchRunFn: fakeClean.fn,
    });
    const clientClean = await buildInMemoryClient(serverClean);
    try {
      const res = await clientClean.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "do it", expectedDirty: false },
      });
      assert.equal(fakeClean.count, 1, "clean + expectedDirty:false dispatches");
      const parsed = parseText(res);
      assert.equal(parsed.workspaceProof.expectedDirtyMatch, true);
      assert.equal(parsed.workspaceProof.dirty, false);
    } finally {
      await clientClean.close();
      await serverClean.close();
    }

    // Dirty repo → dirty true matches.
    makeDirty(repo);
    const fakeDirty = makeFakeDispatch();
    const serverDirty = createWaoMcpServer({
      registryPath, runDir: join(aux, "runs-dirty"), workspaceRoot: repo, dispatchRunFn: fakeDirty.fn,
    });
    const clientDirty = await buildInMemoryClient(serverDirty);
    try {
      const res = await clientDirty.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "do it", expectedDirty: true },
      });
      assert.equal(fakeDirty.count, 1, "dirty + expectedDirty:true dispatches");
      const parsed = parseText(res);
      assert.equal(parsed.workspaceProof.expectedDirtyMatch, true);
      assert.equal(parsed.workspaceProof.dirty, true);
    } finally {
      await clientDirty.close();
      await serverDirty.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("M12-6-FR03-E: mismatching expectedDirty refused before dispatch, count 0", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      // Clean repo but the Lead expects dirty — refuse.
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "do it", expectedDirty: true },
      });
      assert.equal(fake.count, 0, "dispatcher never called for dirty mismatch");
      assert.equal(res.isError, true);
      const text = textOf(res);
      assert.match(text, /workspace_expectation_mismatch/);
      assert.match(text, /dirty/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("M12-6-FR03-F: matching expectedWorkspaceRoot succeeds (case-equivalent on win32)", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      // Supply the root with a flipped drive-letter case (win32 case-insensitive)
      // — it must still match the canonicalized proven root.
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "do it", expectedWorkspaceRoot: flipDriveCase(repo) },
      });
      assert.equal(fake.count, 1, "case-equivalent root dispatches");
      const parsed = parseText(res);
      assert.equal(parsed.workspaceProof.expectedWorkspaceRootMatch, true);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("M12-6-FR03-G: mismatching expectedWorkspaceRoot refused before dispatch, count 0", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      // An absolute path that does not exist canonicalizes to nothing → mismatch.
      const wrongRoot = join(repo, "does-not-exist-m12-6");
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "do it", expectedWorkspaceRoot: wrongRoot },
      });
      assert.equal(fake.count, 0, "dispatcher never called for root mismatch");
      assert.equal(res.isError, true);
      const text = textOf(res);
      assert.match(text, /workspace_expectation_mismatch/);
      assert.match(text, /workspaceRoot/);
      // The offending path is never echoed.
      assert.ok(!text.includes(wrongRoot), "wrong root not echoed");
      assert.ok(!JSON.stringify(res).includes(wrongRoot.replace(/\\/g, "/")), "no root leak anywhere");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("M12-6-FR03-H: all three expectations matching succeeds with all booleans true", async () => {
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
        arguments: {
          agentId: "coder_low", prompt: "do it",
          expectedGitHead: gitHead(repo),
          expectedDirty: false,
          expectedWorkspaceRoot: repo,
        },
      });
      assert.equal(fake.count, 1, "full match dispatches once");
      const parsed = parseText(res);
      assert.equal(parsed.workspaceProof.expectedGitHeadMatch, true);
      assert.equal(parsed.workspaceProof.expectedDirtyMatch, true);
      assert.equal(parsed.workspaceProof.expectedWorkspaceRootMatch, true);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("M12-6-FR03-I: 64-hex expectedGitHead accepted by schema, mismatches 40-hex binding (count 0)", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      // A canonical 64-hex literal is accepted by the input regex but cannot equal
      // the 40-hex proven head → gitHead mismatch. This proves the regex admits
      // SHA-256 heads AND the comparison is exact.
      const sha256Head = "a".repeat(64);
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: { agentId: "coder_low", prompt: "do it", expectedGitHead: sha256Head },
      });
      assert.equal(fake.count, 0, "dispatcher never called for head mismatch");
      assert.equal(res.isError, true);
      assert.match(textOf(res), /workspace_expectation_mismatch/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("M12-6-FR03-J: malicious expectedWorkspaceRoot and prompt never leak in mismatch response", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      const EVIL_ROOT = join(repo, "EVIL-Token-<script>alert(1)</script>-rm-rf");
      const EVIL_PROMPT = "secret-prompt-token-m12-6-fr03j";
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low", prompt: EVIL_PROMPT, expectedWorkspaceRoot: EVIL_ROOT,
        },
      });
      assert.equal(fake.count, 0, "dispatcher never called");
      assert.equal(res.isError, true);
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(EVIL_ROOT), "malicious root not echoed");
      assert.ok(!dumped.includes("alert(1)"), "script payload not echoed");
      assert.ok(!dumped.includes(EVIL_PROMPT), "prompt not echoed in mismatch response");
      assert.match(textOf(res), /workspace_expectation_mismatch/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

// ===== FR-03 unit: checkWorkspaceExpectation pure helper =====

test("M12-6-FR03-K: checkWorkspaceExpectation handles 64-hex head, proof shape, and null binding", () => {
  const sha256 = "f".repeat(64);
  const sha256Binding = { bound: true, source: "mcp_root", root: "/x", gitHead: sha256, dirty: false };

  // 64-hex happy path: exact match.
  const ok = checkWorkspaceExpectation({ binding: sha256Binding, expectedGitHead: sha256 });
  assert.equal(ok.matched, true);
  assert.equal(ok.proof.expectedGitHeadMatch, true);
  assert.equal(ok.proof.gitHead, sha256);
  assert.equal(ok.proof.source, "mcp_root");
  assert.equal(ok.proof.dirty, false);

  // Non-canonical head (uppercase hex) is a mismatch — never echoed.
  const upper = "A".repeat(40);
  const bad = checkWorkspaceExpectation({
    binding: { bound: true, source: "server_config", root: "/x", gitHead: "b".repeat(40), dirty: false },
    expectedGitHead: upper,
  });
  assert.equal(bad.matched, false);
  assert.equal(bad.mismatch, "gitHead");

  // Non-boolean dirty is a mismatch.
  const badDirty = checkWorkspaceExpectation({
    binding: { bound: true, source: "server_config", root: "/x", gitHead: "c".repeat(40), dirty: false },
    expectedDirty: "yes",
  });
  assert.equal(badDirty.matched, false);
  assert.equal(badDirty.mismatch, "dirty");

  // Null/missing binding → workspaceRoot mismatch (closed-set label only).
  const noBinding = checkWorkspaceExpectation({ binding: null });
  assert.equal(noBinding.matched, false);
  assert.equal(noBinding.mismatch, "workspaceRoot");
});

test("M12-6-FR03-L: checkWorkspaceExpectation proof exposes no absolute workspace path", () => {
  const ok = checkWorkspaceExpectation({
    binding: { bound: true, source: "lead_session", root: "C:/very/secret/path", gitHead: "d".repeat(40), dirty: true },
    expectedGitHead: "d".repeat(40),
    expectedDirty: true,
  });
  assert.equal(ok.matched, true);
  // The proof object exposes source/head/dirty + match booleans ONLY.
  assert.deepEqual(Object.keys(ok.proof).sort(),
    ["dirty", "expectedDirtyMatch", "expectedGitHeadMatch", "expectedWorkspaceRootMatch", "gitHead", "source"]);
  assert.equal(ok.proof.root, undefined, "proof never carries the absolute root");
});

// ===== FR-04: invalid_verification_path at the MCP boundary (redaction) =====

test("M12-6-FR04-MCP: delivery with absolute verification path → closed-set invalid_verification_path, no path leak, no transcript", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    // REAL dispatcher (no injection): the absolute-path check lives in
    // prepareDeliveryRequest inside dispatchRun, so the real service path must run.
    // It throws before the registry read / spawn / transcript.
    const server = createWaoMcpServer({ registryPath, runDir, workspaceRoot: repo });
    const client = await buildInMemoryClient(server);
    try {
      const ABS = "C:\\Users\\secret-m12-6\\app\\test.exe";
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low", prompt: "do it",
          delivery: {
            mode: "git_commit_v1",
            allowedPaths: ["src"],
            verificationCommands: [`"${ABS}"`],
          },
        },
      });
      assert.equal(res.isError, true, "absolute-path delivery is an error");
      const text = textOf(res);
      // The closed-set code IS surfaced so the Lead can act on it (P1-B truth) —
      // it is no longer collapsed to an opaque "run_dispatch failed".
      assert.match(text, /invalid_verification_path/, "closed-set code surfaced at MCP");
      assert.ok(!/run_dispatch failed/.test(text), "not collapsed to the generic dispatch text");
      // The offending literal is NEVER echoed.
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes(ABS), "absolute path not leaked");
      assert.ok(!dumped.includes("C:\\\\Users"), "no path fragment leaked");
      // No durable side effect: no transcript written.
      assert.equal(readdirSafe(runDir).length, 0, "no transcript written before the preflight rejection");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

test("M12-6-FR04-MCP: portable verification commands (URL/relative) dispatch normally", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({
      registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn,
    });
    const client = await buildInMemoryClient(server);
    try {
      // URL-containing and relative commands must NOT be flagged (no false positive).
      const res = await client.callTool({
        name: "run_dispatch",
        arguments: {
          agentId: "coder_low", prompt: "do it",
          delivery: {
            mode: "git_commit_v1",
            allowedPaths: ["src"],
            verificationCommands: ["npm test", "curl https://example.com/health", "./scripts/check.sh"],
          },
        },
      });
      // The fake dispatcher is invoked (input-schema-valid + no absolute path).
      assert.equal(fake.count, 1, "portable commands reach the dispatcher");
      assert.ok(!res.isError, "portable commands are accepted");
      assert.ok(fake.captured.delivery, "delivery forwarded to the service");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});

// ===== P1-A: the server-proven head is threaded internally as frozenGitHead =====
//
// The MCP boundary proves the workspace ONCE (binding.gitHead) and threads that
// proven head to the dispatcher as frozenGitHead — an INTERNAL value, distinct
// from the model-owned expectedGitHead (which is consumed at the boundary for the
// expectation check and never forwarded). This is the value RunManager.start
// revalidates to defeat the frozen-base TOCTOU.

test("M12-6 P1-A: run_dispatch threads the server-proven frozenGitHead to the dispatcher", async () => {
  const { repo, aux, registryPath, runDir } = setup();
  try {
    const fake = makeFakeDispatch();
    const server = createWaoMcpServer({ registryPath, runDir, workspaceRoot: repo, dispatchRunFn: fake.fn });
    const client = await buildInMemoryClient(server);
    try {
      // (1) Without an explicit freeze: the server STILL threads its proven head
      // internally (TOCTOU protection is on by default for MCP dispatch).
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "coder_low", prompt: "a" } });
      assert.equal(fake.captured.frozenGitHead, gitHead(repo), "frozenGitHead threaded even without an explicit freeze");
      assert.equal(fake.captured.expectedGitHead, undefined, "expectedGitHead is a boundary-only model input");

      // (2) With a matching explicit freeze: the threaded frozen head equals the
      // proven head, and expectedGitHead is still NOT forwarded past the boundary.
      const head = gitHead(repo);
      await client.callTool({ name: "run_dispatch", arguments: { agentId: "coder_low", prompt: "b", expectedGitHead: head } });
      assert.equal(fake.captured.frozenGitHead, head, "frozenGitHead = proven binding head");
      assert.equal(fake.captured.expectedGitHead, undefined, "expectedGitHead not forwarded past the boundary");
      assert.equal(fake.count, 2, "both dispatches reached the dispatcher");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanupDir(repo);
    cleanupDir(aux);
  }
});
