// test/mcpRunDeliveryReviewBundle.test.js
//
// M12-3B: one-call mechanical delivery readiness + one Lead-selected review
// page. The composite is advisory and read-only. It never traverses files or
// cursors, never decides, and leaves every atomic tool available.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWaoMcpServer } from "../src/mcp/server.js";

async function buildClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test-m123b", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function makeGitDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.invalid"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "WAO Test"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "fixture\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "fixture"', { cwd: dir, stdio: "ignore" });
  return dir;
}

function successfulDelivery(runId, overrides = {}) {
  return {
    runId,
    terminalState: "completed",
    deliveryAvailable: true,
    deliveryRef: {
      deliveryCommit: "d".repeat(40),
      baseCommit: "b".repeat(40),
      changedFiles: ["src/a.js", "src/b.js"],
      verification: {
        status: "passed",
        commands: ["npm test"],
        results: [{ ok: true }],
        failureCode: null,
      },
      acceptance: { status: "pending", reviewerType: "lead_agent" },
      integration: { status: "pending", targetCommit: null },
    },
    verification: { status: "passed" },
    acceptance: { status: "pending" },
    readiness: "reviewable",
    waitReturnedEarly: true,
    ...overrides,
  };
}

function reviewPage(runId, overrides = {}) {
  const fragment = "+const answer = 42;\n";
  return {
    runId,
    deliveryCommit: "d".repeat(40),
    fileIndex: 1,
    changedFileCount: 2,
    changedPath: "src/b.js",
    contentFormat: "unified_diff_v1",
    artifactTextTrust: "untrusted_repository_text",
    available: true,
    unavailableReason: null,
    fragment,
    fragmentBytes: Buffer.byteLength(fragment, "utf8"),
    nextCursor: null,
    truncated: false,
    ...overrides,
  };
}

test("M12-3B-RED-01: bundle tool is discoverable; current count is 22 after run_continue", async () => {
  const dir = makeGitDir("m123b-discovery-");
  try {
    const server = createWaoMcpServer({ registryPath: "/registry.json", runDir: dir, workspaceRoot: dir });
    const client = await buildClient(server);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === "run_delivery_review_bundle");
      assert.ok(tool, "run_delivery_review_bundle must be registered");
      assert.equal(tools.length, 22, "exactly 22 tools (M12-10 moved playbook catalog to resources; M12-16 added run_correct)");
      assert.deepEqual(
        Object.keys(tool.inputSchema.properties).sort(),
        ["cursor", "fileIndex", "runId", "waitMs"],
      );
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.annotations.idempotentHint, true);
      assert.equal(tool.annotations.openWorldHint, false);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-RED-02: one call waits once and returns one requested review page", async () => {
  const dir = makeGitDir("m123b-success-");
  try {
    const readinessCalls = [];
    const reviewCalls = [];
    let decideCalls = 0;
    let stopCalls = 0;
    let repackageCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir: dir,
      workspaceRoot: dir,
      getRunDeliveryReadinessFn: async (input) => {
        readinessCalls.push(input);
        return successfulDelivery(input.runId);
      },
      getRunDeliveryReviewFn: async (input) => {
        reviewCalls.push(input);
        return reviewPage(input.runId);
      },
      decideRunDeliveryFn: async () => { decideCalls += 1; },
      stopRunFn: async () => { stopCalls += 1; },
      getRunDeliveryRepackageFn: async () => { repackageCalls += 1; },
    });
    const client = await buildClient(server);
    try {
      const result = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_bundle", fileIndex: 1, waitMs: 120000 },
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.runId, "run_bundle");
      assert.equal(result.structuredContent.delivery.readiness, "reviewable");
      assert.equal(result.structuredContent.delivery.waitReturnedEarly, true);
      assert.equal(result.structuredContent.review.fileIndex, 1);
      assert.equal(result.structuredContent.review.changedPath, "src/b.js");
      // M12-8B correction: the bundle keeps its established nested delivery
      // contract — it never acquires the progressive-disclosure field, neither
      // at the top level nor inside the nested delivery sub-object.
      assert.equal("availableDrilldowns" in result.structuredContent, false,
        "bundle top level must NOT carry availableDrilldowns");
      assert.equal("availableDrilldowns" in result.structuredContent.delivery, false,
        "bundle nested delivery must NOT carry availableDrilldowns");
      assert.equal(readinessCalls.length, 1, "exactly one readiness call");
      assert.equal(readinessCalls[0].waitMs, 120000);
      assert.equal(reviewCalls.length, 1, "exactly one review page");
      assert.equal(reviewCalls[0].fileIndex, 1);
      assert.equal(decideCalls, 0, "never decides");
      assert.equal(stopCalls, 0, "never stops");
      assert.equal(repackageCalls, 0, "never repackages");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-RED-03: omitted waitMs uses one 270-second readiness budget", async () => {
  const dir = makeGitDir("m123b-default-");
  try {
    let observedWaitMs = null;
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir: dir,
      workspaceRoot: dir,
      getRunDeliveryReadinessFn: async (input) => {
        observedWaitMs = input.waitMs;
        return successfulDelivery(input.runId);
      },
      getRunDeliveryReviewFn: async (input) => reviewPage(input.runId, { fileIndex: 0, changedPath: "src/a.js" }),
    });
    const client = await buildClient(server);
    try {
      const result = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_default", fileIndex: 0 },
      });
      assert.equal(result.isError, undefined);
      assert.equal(observedWaitMs, 270000);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-RED-04: pending readiness is truthful and performs zero review reads", async () => {
  const dir = makeGitDir("m123b-pending-");
  try {
    let reviewCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir: dir,
      workspaceRoot: dir,
      getRunDeliveryReadinessFn: async (input) => successfulDelivery(input.runId, {
        verification: { status: "pending" },
        deliveryRef: {
          ...successfulDelivery(input.runId).deliveryRef,
          verification: { status: "pending", commands: [], results: [], failureCode: null },
        },
        readiness: "waiting_for_verification",
        waitReturnedEarly: false,
      }),
      getRunDeliveryReviewFn: async () => {
        reviewCalls += 1;
        return {};
      },
    });
    const client = await buildClient(server);
    try {
      const result = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_pending", fileIndex: 0, waitMs: 1000 },
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.delivery.readiness, "waiting_for_verification");
      assert.equal(result.structuredContent.review, null);
      assert.equal(reviewCalls, 0, "no Git/review call before exact verification settles");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-RED-05: packaging failure remains actionable and performs zero review reads", async () => {
  const dir = makeGitDir("m123b-failure-");
  try {
    let reviewCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir: dir,
      workspaceRoot: dir,
      getRunDeliveryReadinessFn: async ({ runId }) => ({
        runId,
        terminalState: "failed",
        deliveryAvailable: false,
        deliveryRequested: true,
        deliveryFailure: { code: "base_commit_mismatch" },
        candidateInventory: null,
        candidateKind: null,
        readiness: "packaging_failed",
        waitReturnedEarly: true,
      }),
      getRunDeliveryReviewFn: async () => {
        reviewCalls += 1;
        return {};
      },
    });
    const client = await buildClient(server);
    try {
      const result = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_failed", fileIndex: 0, waitMs: 1000 },
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.delivery.deliveryAvailable, false);
      assert.equal(result.structuredContent.delivery.deliveryFailure.code, "base_commit_mismatch");
      assert.equal(result.structuredContent.delivery.readiness, "packaging_failed");
      assert.equal(result.structuredContent.review, null);
      assert.equal(reviewCalls, 0);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-RED-06: cursor is forwarded once; binary remains metadata-only", async () => {
  const dir = makeGitDir("m123b-cursor-");
  try {
    const reviewCalls = [];
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir: dir,
      workspaceRoot: dir,
      getRunDeliveryReadinessFn: async ({ runId }) => successfulDelivery(runId),
      getRunDeliveryReviewFn: async (input) => {
        reviewCalls.push(input);
        return reviewPage(input.runId, {
          fileIndex: 0,
          changedPath: "src/a.js",
          available: false,
          unavailableReason: "binary",
          fragment: "",
          fragmentBytes: 0,
          nextCursor: null,
          truncated: false,
        });
      },
    });
    const client = await buildClient(server);
    try {
      const result = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_cursor", fileIndex: 0, cursor: "abc_DEF-123", waitMs: 1000 },
      });
      assert.equal(result.isError, undefined);
      assert.equal(reviewCalls.length, 1);
      assert.equal(reviewCalls[0].cursor, "abc_DEF-123");
      assert.equal(result.structuredContent.review.available, false);
      assert.equal(result.structuredContent.review.unavailableReason, "binary");
      assert.equal(result.structuredContent.review.fragment, "");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-RED-07: invalid input and missing workspace call no services", async () => {
  const dir = mkdtempSync(join(tmpdir(), "m123b-invalid-"));
  try {
    let readinessCalls = 0;
    let reviewCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir: dir,
      getRunDeliveryReadinessFn: async () => { readinessCalls += 1; return {}; },
      getRunDeliveryReviewFn: async () => { reviewCalls += 1; return {}; },
    });
    const client = await buildClient(server);
    try {
      const invalid = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "not a run id", fileIndex: 0, waitMs: 1000 },
      }).catch(() => ({ isError: true }));
      assert.equal(invalid.isError, true);

      const unbound = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_unbound", fileIndex: 0, waitMs: 1000 },
      });
      assert.equal(unbound.isError, true);
      assert.equal(readinessCalls, 0);
      assert.equal(reviewCalls, 0);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-RED-08: malformed review output collapses to one fixed safe error", async () => {
  const dir = makeGitDir("m123b-malformed-");
  try {
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir: dir,
      workspaceRoot: dir,
      getRunDeliveryReadinessFn: async ({ runId }) => successfulDelivery(runId),
      getRunDeliveryReviewFn: async ({ runId }) => ({
        ...reviewPage(runId),
        secret: "should-not-cross",
        changedPath: "C:\\private\\secret.txt",
      }),
    });
    const client = await buildClient(server);
    try {
      const result = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_malformed", fileIndex: 1, waitMs: 1000 },
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(result.content?.[0]?.text, "run_delivery_review_bundle failed");
      assert.ok(!JSON.stringify(result).includes("should-not-cross"));
      assert.ok(!JSON.stringify(result).includes("private"));
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-09: cross-artifact review and non-reviewable cursor fail closed", async () => {
  const dir = makeGitDir("m123b-binding-");
  try {
    let mode = "mismatch";
    let reviewCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir: dir,
      workspaceRoot: dir,
      getRunDeliveryReadinessFn: async ({ runId }) => {
        if (mode === "pending") {
          return successfulDelivery(runId, {
            verification: { status: "pending" },
            deliveryRef: {
              ...successfulDelivery(runId).deliveryRef,
              verification: { status: "pending", commands: [], results: [], failureCode: null },
            },
            readiness: "waiting_for_verification",
            waitReturnedEarly: false,
          });
        }
        return successfulDelivery(runId);
      },
      getRunDeliveryReviewFn: async ({ runId }) => {
        reviewCalls += 1;
        return reviewPage(runId, { deliveryCommit: "e".repeat(40) });
      },
    });
    const client = await buildClient(server);
    try {
      const mismatch = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_binding", fileIndex: 1, waitMs: 1000 },
      });
      assert.equal(mismatch.isError, true);
      assert.equal(mismatch.structuredContent, undefined);
      assert.equal(reviewCalls, 1);

      mode = "pending";
      const staleCursor = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_binding", fileIndex: 1, cursor: "stale_cursor", waitMs: 1000 },
      });
      assert.equal(staleCursor.isError, true);
      assert.equal(staleCursor.structuredContent, undefined);
      assert.equal(reviewCalls, 1, "pending state must not read review content");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-10: review exceptions preserve fixed safe bundle error", async () => {
  const dir = makeGitDir("m123b-throw-");
  try {
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir: dir,
      workspaceRoot: dir,
      getRunDeliveryReadinessFn: async ({ runId }) => successfulDelivery(runId),
      getRunDeliveryReviewFn: async () => {
        throw new Error("C:\\private\\secret.txt API_KEY=do-not-leak");
      },
    });
    const client = await buildClient(server);
    try {
      const result = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_throw", fileIndex: 1, waitMs: 1000 },
      });
      assert.equal(result.isError, true);
      assert.equal(result.content?.[0]?.text, "run_delivery_review_bundle failed");
      assert.equal(result.structuredContent, undefined);
      assert.ok(!JSON.stringify(result).includes("private"));
      assert.ok(!JSON.stringify(result).includes("API_KEY"));
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-11: contradictory reviewable-without-delivery fails before Git review", async () => {
  const dir = makeGitDir("m123b-contradiction-");
  try {
    let reviewCalls = 0;
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir: dir,
      workspaceRoot: dir,
      getRunDeliveryReadinessFn: async ({ runId }) => successfulDelivery(runId, {
        deliveryAvailable: false,
        deliveryRequested: true,
        deliveryFailure: null,
        readiness: "reviewable",
      }),
      getRunDeliveryReviewFn: async () => {
        reviewCalls += 1;
        return {};
      },
    });
    const client = await buildClient(server);
    try {
      const result = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId: "run_contradiction", fileIndex: 0, waitMs: 1000 },
      });
      assert.equal(result.isError, true);
      assert.equal(result.content?.[0]?.text, "run_delivery_review_bundle failed");
      assert.equal(result.structuredContent, undefined);
      assert.equal(reviewCalls, 0, "contradictory readiness must not read Git review content");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12-3B-SMOKE: default services read one real verified delivery page without mutation", async () => {
  const { packageDelivery } = await import("../src/delivery.js");
  const repo = mkdtempSync(join(tmpdir(), "m123b-smoke-repo-"));
  const runDir = mkdtempSync(join(tmpdir(), "m123b-smoke-runs-"));
  const runId = "run_bundle_smoke";
  const transcriptPath = join(runDir, `${runId}.jsonl`);
  let worktreePath = null;
  try {
    execSync("git init -b main", { cwd: repo, stdio: "ignore" });
    execSync('git config user.email "test@example.invalid"', { cwd: repo, stdio: "ignore" });
    execSync('git config user.name "WAO Test"', { cwd: repo, stdio: "ignore" });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "answer.js"), "export const answer = 1;\n", "utf8");
    execSync("git add . && git commit -m init", { cwd: repo, stdio: "ignore" });
    const baseCommit = execSync("git rev-parse HEAD", {
      cwd: repo,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    worktreePath = join(repo, ".wao-worktrees", runId);
    execSync(`git worktree add "${worktreePath}" -b "wao/${runId}"`, {
      cwd: repo,
      stdio: "ignore",
    });
    writeFileSync(
      join(worktreePath, "src", "answer.js"),
      "export const answer = 42;\n",
      "utf8",
    );
    const deliveryRef = packageDelivery({
      runId,
      worktreePath,
      baseCommit,
      allowedPaths: ["src"],
      isolation: { type: "worktree", strategy: "persistent" },
      verificationCommands: ["npm test"],
    });
    const events = [
      { type: "run.started", runId, ts: "2026-01-01T00:00:00Z", seq: 1 },
      {
        type: "run.background_submitted",
        runId,
        ts: "2026-01-01T00:00:00Z",
        seq: 2,
        cwd: repo,
        background: true,
      },
      {
        type: "run.delivery_created",
        runId,
        ts: "2026-01-01T00:00:01Z",
        seq: 3,
        delivery: deliveryRef,
      },
      {
        type: "run.delivery_verification_passed",
        runId,
        ts: "2026-01-01T00:00:02Z",
        seq: 4,
        delivery: deliveryRef,
      },
      {
        type: "run.state_change",
        runId,
        ts: "2026-01-01T00:00:03Z",
        seq: 5,
        from: "running",
        to: "completed",
      },
      { type: "run.completed", runId, ts: "2026-01-01T00:00:04Z", seq: 6 },
    ];
    writeFileSync(
      transcriptPath,
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const transcriptBytesBefore = statSync(transcriptPath).size;
    const sourceHeadBefore = execSync("git rev-parse HEAD", {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const worktreesBefore = execSync("git worktree list --porcelain", {
      cwd: repo,
      encoding: "utf8",
    });
    const server = createWaoMcpServer({
      registryPath: "/registry.json",
      runDir,
      workspaceRoot: repo,
    });
    const client = await buildClient(server);
    try {
      const result = await client.callTool({
        name: "run_delivery_review_bundle",
        arguments: { runId, fileIndex: 0, waitMs: 1000 },
      });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.runId, runId);
      assert.equal(result.structuredContent.delivery.readiness, "reviewable");
      assert.equal(result.structuredContent.delivery.waitReturnedEarly, true);
      assert.equal(
        result.structuredContent.delivery.deliveryCommit,
        deliveryRef.deliveryCommit,
      );
      assert.equal(result.structuredContent.review.deliveryCommit, deliveryRef.deliveryCommit);
      assert.equal(result.structuredContent.review.changedPath, "src/answer.js");
      assert.equal(result.structuredContent.review.fileIndex, 0);
      assert.equal(result.structuredContent.review.changedFileCount, 1);
      assert.match(result.structuredContent.review.fragment, /answer = 42/);
      assert.equal(result.structuredContent.review.artifactTextTrust, "untrusted_repository_text");
    } finally {
      await client.close();
      await server.close();
    }

    assert.equal(statSync(transcriptPath).size, transcriptBytesBefore, "transcript bytes unchanged");
    assert.equal(
      execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim(),
      sourceHeadBefore,
      "source HEAD unchanged",
    );
    assert.equal(
      execSync("git worktree list --porcelain", { cwd: repo, encoding: "utf8" }),
      worktreesBefore,
      "worktree inventory unchanged",
    );
  } finally {
    if (worktreePath) {
      try {
        execSync(`git worktree remove --force "${worktreePath}"`, {
          cwd: repo,
          stdio: "ignore",
        });
      } catch {}
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
