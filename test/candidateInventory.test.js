// test/candidateInventory.test.js
//
// M12-1S1: read-only candidate inventory projection for run_delivery.
//
// When the durable bound packaging failure is exactly `disallowed_path`, the
// run_delivery failure projection gains a nullable `candidateInventory`:
// the candidate's ACTUAL changed paths (tracked diff vs the persisted original
// base + non-ignored untracked files) and the subset that exceeded the original
// allowedPaths contract. The inventory is advisory only — it never expands
// scope, repackages, stops/retries, or decides. null means the Lead verifies
// manually; it is never an automatic stop.
//
// Safety contract proven here:
//   - Both required Git reads must succeed; any read/proof failure → null
//     (never partial truth).
//   - Every emitted path passes the strict projection SSOT (validateProjectedPath);
//     any unsafe path nulls the WHOLE inventory.
//   - Ownership (verifyRunWorkspaceOwnership) is proven BEFORE any worktree/Git
//     read; a direct caller without authority gets null, never an unbound read.
//   - Read-only: transcript bytes, branch/HEAD, index and worktree contents are
//     unchanged by the query.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { computeCandidateInventory, INVENTORY_PATHS_LIMIT } from "../src/application/candidateInventory.js";
import { getRunDelivery, getRunDeliveryReadiness } from "../src/application/runDelivery.js";
import { createWaoMcpServer } from "../src/mcp/server.js";

// ===== Helpers =====

const RUN_ID = "run_m12s1_test";
const BASE = "a".repeat(40);

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
  }).trim();
}

async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(dir, { recursive: true, force: true }); return; } catch {
      if (attempt === 4) return;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/** Create a real temp git repo with src/a.js committed. Returns { repo, baseCommit }. */
async function makeRepo(prefix = "m12s1-repo-") {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@test"], repo);
  git(["config", "user.name", "test"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "a.js"), "const a = 1;\n");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n.wao-worktrees/\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  const baseCommit = git(["rev-parse", "HEAD"], repo);
  return { repo, baseCommit };
}

/** Create a real persistent linked worktree on branch wao/<runId> at HEAD. */
function makeLinkedWorktree(repo, runId) {
  const worktreePath = join(repo, ".wao-worktrees", runId);
  git(["worktree", "add", worktreePath, "-b", `wao/${runId}`], repo);
  return worktreePath;
}

/** Write a raw JSONL transcript (test-owned envelope fields). */
function seedTranscript(runDir, runId, events) {
  const filePath = join(runDir, `${runId}.jsonl`);
  const lines = events.map((e, i) => JSON.stringify({
    ts: "2026-07-01T00:00:00.000Z", seq: i + 1, runId, agentId: "coder_mm", ...e,
  }));
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

/** Durable facts for a failed delivery run whose packaging failed as disallowed_path. */
function disallowedPathEvents({ repo, worktreePath, baseCommit, allowedPaths = ["src"], deliveryCode = "disallowed_path" }) {
  return [
    { type: "run.background_submitted", cwd: repo, deliveryRequested: true },
    {
      type: "run.started", backend: "test", cwd: repo, worktreePath,
      delivery: { mode: "git_commit_v1", baseCommit, allowedPaths },
    },
    { type: "run.state_change", from: null, to: "pending", reason: "created" },
    { type: "run.state_change", from: "pending", to: "running", reason: "spawned" },
    { type: "run.delivery_failed", deliveryCode, message: "changes outside allowedPaths detected" },
    { type: "run.state_change", from: "running", to: "failed", reason: "delivery_failed" },
  ];
}

async function buildInMemoryClient(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const client = new Client({ name: "wao-test", version: "0.0.1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

// ===== INV: computeCandidateInventory unit contract =====

test("M12-1S1-INV-01: shared cap is 256; positive projection with dedup/sort/boundary", () => {
  assert.equal(INVENTORY_PATHS_LIMIT, 256, "one clearly shared exported cap");
  const inv = computeCandidateInventory("C:/wt", BASE, ["src"], () => [
    "src/b.js", "src/a.js", "README.md", "src2/c.js", "src/a.js",
  ]);
  assert.ok(inv, "inventory present");
  // Sorted + deduplicated; "src" allows descendants on a segment boundary but
  // NOT "src2/..." (reuses the isPathAllowed SSOT).
  assert.deepEqual(inv.actualChangedPaths, ["README.md", "src/a.js", "src/b.js", "src2/c.js"]);
  assert.equal(inv.actualChangedCount, 4);
  assert.equal(inv.actualChangedTruncated, false);
  assert.deepEqual(inv.disallowedPaths, ["README.md", "src2/c.js"]);
  assert.equal(inv.disallowedCount, 2);
  assert.equal(inv.disallowedTruncated, false);
});

test("M12-1S1-INV-02: a failed required Git read (null listing) => null, never partial", () => {
  const inv = computeCandidateInventory("C:/wt", BASE, ["src"], () => null);
  assert.equal(inv, null);
});

test("M12-1S1-INV-03: malformed inputs fail closed to null", () => {
  const goodList = () => ["src/a.js"];
  assert.equal(computeCandidateInventory("", BASE, ["src"], goodList), null, "empty worktreePath");
  assert.equal(computeCandidateInventory(null, BASE, ["src"], goodList), null, "null worktreePath");
  assert.equal(computeCandidateInventory("C:/wt", "HEAD", ["src"], goodList), null, "non-canonical base");
  assert.equal(computeCandidateInventory("C:/wt", BASE, [], goodList), null, "empty allowedPaths");
  assert.equal(computeCandidateInventory("C:/wt", BASE, "src", goodList), null, "non-array allowedPaths");
  assert.equal(computeCandidateInventory("C:/wt", BASE, ["../x"], goodList), null, "traversal allowedPath");
});

test("M12-1S1-INV-04: any unsafe emitted path nulls the WHOLE inventory (no partial truth)", () => {
  const attacks = [
    ["src/evil\n.sh"], // C0 control char (terminal escape smuggling)
    ["src/evil\u0085.sh"], // C1 control char (NEL)
    ["../escape.js"], // traversal
    ["C:/abs/win.js"], // absolute drive path
    ["a\\b.js"], // backslash non-canonical
    ["src/"], // trailing separator
    ["/rooted.js"], // rooted POSIX
  ];
  for (const paths of attacks) {
    const inv = computeCandidateInventory("C:/wt", BASE, ["src"], () => paths);
    assert.equal(inv, null, `attack ${JSON.stringify(paths)} must null the whole inventory`);
  }
});

test("M12-1S1-INV-05: counts report full cardinality; paths capped at 256 with exact truncation", () => {
  const allowed = Array.from({ length: 20 }, (_, i) => `dir/p${String(i).padStart(3, "0")}`);
  const outside = Array.from({ length: 280 }, (_, i) => `out/p${String(i).padStart(3, "0")}`);
  const all = [...outside, ...allowed]; // unsorted on purpose
  const inv = computeCandidateInventory("C:/wt", BASE, ["dir"], () => all);
  assert.ok(inv);
  assert.equal(inv.actualChangedCount, 300, "full cardinality, not capped length");
  assert.equal(inv.actualChangedPaths.length, 256, "capped at 256");
  assert.equal(inv.actualChangedTruncated, true);
  assert.deepEqual(inv.actualChangedPaths, [...all].sort().slice(0, 256), "first 256 of the sorted full set");
  assert.equal(inv.disallowedCount, 280);
  assert.equal(inv.disallowedPaths.length, 256);
  assert.equal(inv.disallowedTruncated, true);
  assert.deepEqual(inv.disallowedPaths, outside.slice(0, 256));
});

test("M12-1S1-INV-06: empty diff is a truthful zero-count inventory, not null", () => {
  const inv = computeCandidateInventory("C:/wt", BASE, ["src"], () => []);
  assert.ok(inv);
  assert.equal(inv.actualChangedCount, 0);
  assert.deepEqual(inv.actualChangedPaths, []);
  assert.equal(inv.actualChangedTruncated, false);
  assert.equal(inv.disallowedCount, 0);
  assert.deepEqual(inv.disallowedPaths, []);
  assert.equal(inv.disallowedTruncated, false);
});

// ===== REAL: real temp repo + real linked worktree =====

test("M12-1S1-REAL-01: real repo — tracked vs base + non-ignored untracked, ignored excluded", async () => {
  const { repo, baseCommit } = await makeRepo();
  try {
    const wt = makeLinkedWorktree(repo, RUN_ID);
    await writeFile(join(wt, "src", "a.js"), "const a = 2;\n"); // tracked modification
    await writeFile(join(wt, "new.txt"), "new\n"); // non-ignored untracked
    await mkdir(join(wt, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(wt, "node_modules", "pkg", "index.js"), "ignored\n"); // ignored untracked

    const inv = computeCandidateInventory(wt, baseCommit, ["src"]);
    assert.ok(inv, "inventory computed from the real worktree");
    assert.deepEqual(inv.actualChangedPaths, ["new.txt", "src/a.js"], "tracked + non-ignored untracked only");
    assert.equal(inv.actualChangedCount, 2);
    assert.deepEqual(inv.disallowedPaths, ["new.txt"], "only paths outside the original contract");
    assert.equal(inv.disallowedCount, 1);
  } finally {
    await cleanupDir(repo);
  }
});

test("M12-1S1-REAL-02: one required Git read fails (unresolvable base) => null", async () => {
  const { repo, baseCommit } = await makeRepo();
  try {
    const wt = makeLinkedWorktree(repo, RUN_ID);
    // Canonical-format but nonexistent commit: `git diff <base> --` fails while
    // `git ls-files` would succeed — a single failed read must null everything.
    const missing = "f".repeat(40);
    assert.equal(computeCandidateInventory(wt, missing, ["src"]), null, "failed diff read => null");
    assert.equal(computeCandidateInventory(join(repo, "no-such-dir"), baseCommit, ["src"]), null, "non-repo cwd => null");
  } finally {
    await cleanupDir(repo);
  }
});

// ===== SVC: getRunDelivery / getRunDeliveryReadiness service wiring =====

test("M12-1S1-SVC-01: disallowed_path failure projects inventory; transcript/Git byte-identical", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "m12s1-runs-"));
  try {
    const wt = makeLinkedWorktree(repo, RUN_ID);
    await writeFile(join(wt, "src", "a.js"), "const a = 2;\n");
    await writeFile(join(wt, "new.txt"), "new\n");
    const filePath = seedTranscript(runDir, RUN_ID, disallowedPathEvents({ repo, worktreePath: wt, baseCommit }));

    // Snapshot the read-only invariants BEFORE the query.
    const transcriptBefore = readFileSync(filePath, "utf8");
    const headBefore = git(["rev-parse", "HEAD"], wt);
    const statusBefore = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], wt);
    const repoHeadBefore = git(["rev-parse", "HEAD"], repo);

    const view = await getRunDelivery({
      runId: RUN_ID, runDir,
      authorizedWorkspaceRoot: repo,
      computeInventoryFn: computeCandidateInventory,
    });

    assert.equal(view.deliveryAvailable, false);
    assert.equal(view.deliveryFailure.code, "disallowed_path");
    assert.ok(view.candidateInventory, "inventory present for disallowed_path");
    assert.deepEqual(view.candidateInventory.actualChangedPaths, ["new.txt", "src/a.js"]);
    assert.equal(view.candidateInventory.actualChangedCount, 2);
    assert.equal(view.candidateInventory.actualChangedTruncated, false);
    assert.deepEqual(view.candidateInventory.disallowedPaths, ["new.txt"]);
    assert.equal(view.candidateInventory.disallowedCount, 1);
    assert.equal(view.candidateInventory.disallowedTruncated, false);

    // Read-only proof: transcript bytes, worktree HEAD/status, repo HEAD unchanged.
    assert.equal(readFileSync(filePath, "utf8"), transcriptBefore, "transcript bytes unchanged");
    assert.equal(git(["rev-parse", "HEAD"], wt), headBefore, "worktree HEAD unchanged");
    assert.equal(git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], wt), statusBefore, "index/worktree unchanged");
    assert.equal(git(["rev-parse", "HEAD"], repo), repoHeadBefore, "repo HEAD unchanged");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S1-SVC-02: cross-workspace authority fails BEFORE any worktree/Git read (0 inventory reads)", async () => {
  const { repo, baseCommit } = await makeRepo();
  const { repo: otherRepo } = await makeRepo("m12s1-other-");
  const runDir = await mkdtemp(join(tmpdir(), "m12s1-runs-"));
  try {
    const wt = makeLinkedWorktree(repo, RUN_ID);
    seedTranscript(runDir, RUN_ID, disallowedPathEvents({ repo, worktreePath: wt, baseCommit }));

    let inventoryReads = 0;
    const countingFn = () => { inventoryReads += 1; return null; };
    const view = await getRunDelivery({
      runId: RUN_ID, runDir,
      authorizedWorkspaceRoot: otherRepo, // run belongs to `repo`, authority is `otherRepo`
      computeInventoryFn: countingFn,
    });
    // The base delivery view is still returned (existing semantics), but the
    // inventory is null and the inventory reader was NEVER invoked.
    assert.equal(view.deliveryFailure.code, "disallowed_path");
    assert.equal(view.candidateInventory, null, "no inventory across workspace authority");
    assert.equal(inventoryReads, 0, "ownership proof fails before any inventory Git read");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(otherRepo);
    await cleanupDir(runDir);
  }
});

test("M12-1S1-SVC-03: direct caller without authority => null inventory, never an unbound read", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "m12s1-runs-"));
  try {
    const wt = makeLinkedWorktree(repo, RUN_ID);
    seedTranscript(runDir, RUN_ID, disallowedPathEvents({ repo, worktreePath: wt, baseCommit }));

    let inventoryReads = 0;
    const countingFn = () => { inventoryReads += 1; return null; };
    const view = await getRunDelivery({ runId: RUN_ID, runDir, computeInventoryFn: countingFn });
    assert.equal(view.deliveryFailure.code, "disallowed_path");
    assert.equal(view.candidateInventory, null, "no authority => null inventory");
    assert.equal(inventoryReads, 0, "no unbound worktree/Git read");

    // Also: no inventory reader at all => null (service never defaults the kernel).
    const view2 = await getRunDelivery({ runId: RUN_ID, runDir, authorizedWorkspaceRoot: repo });
    assert.equal(view2.candidateInventory, null);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S1-SVC-04: other packaging failure codes do NOT gain the field", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "m12s1-runs-"));
  try {
    const wt = makeLinkedWorktree(repo, RUN_ID);
    seedTranscript(runDir, RUN_ID, disallowedPathEvents({
      repo, worktreePath: wt, baseCommit, deliveryCode: "empty_diff",
    }));
    let inventoryReads = 0;
    const view = await getRunDelivery({
      runId: RUN_ID, runDir,
      authorizedWorkspaceRoot: repo,
      computeInventoryFn: () => { inventoryReads += 1; return null; },
    });
    assert.equal(view.deliveryFailure.code, "empty_diff");
    assert.equal("candidateInventory" in view, false, "field exists only for disallowed_path");
    assert.equal(inventoryReads, 0);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S1-SVC-05: ambiguous bound run.started facts => null before any inventory read", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "m12s1-runs-"));
  try {
    const wt = makeLinkedWorktree(repo, RUN_ID);
    const events = disallowedPathEvents({ repo, worktreePath: wt, baseCommit });
    // Inject a second bound run.started — no single unambiguous delivery context.
    events.splice(1, 0, events[1]);
    seedTranscript(runDir, RUN_ID, events);

    let inventoryReads = 0;
    const view = await getRunDelivery({
      runId: RUN_ID, runDir,
      authorizedWorkspaceRoot: repo,
      computeInventoryFn: () => { inventoryReads += 1; return null; },
    });
    assert.equal(view.deliveryFailure.code, "disallowed_path");
    assert.equal(view.candidateInventory, null);
    assert.equal(inventoryReads, 0);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S1-SVC-06: worktree HEAD drift (proof failure) => null before any inventory read", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "m12s1-runs-"));
  try {
    const wt = makeLinkedWorktree(repo, RUN_ID);
    seedTranscript(runDir, RUN_ID, disallowedPathEvents({ repo, worktreePath: wt, baseCommit }));
    // Move the worktree HEAD off the persisted original base.
    await writeFile(join(wt, "drift.js"), "drift\n");
    git(["add", "."], wt);
    git(["commit", "-m", "drift"], wt);

    let inventoryReads = 0;
    const view = await getRunDelivery({
      runId: RUN_ID, runDir,
      authorizedWorkspaceRoot: repo,
      computeInventoryFn: () => { inventoryReads += 1; return null; },
    });
    assert.equal(view.deliveryFailure.code, "disallowed_path");
    assert.equal(view.candidateInventory, null, "broken linked-worktree proof => null");
    assert.equal(inventoryReads, 0, "proof fails before the inventory read");
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S1-SVC-07: settled packaging_failed readiness carries the same additive field", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "m12s1-runs-"));
  try {
    const wt = makeLinkedWorktree(repo, RUN_ID);
    seedTranscript(runDir, RUN_ID, disallowedPathEvents({ repo, worktreePath: wt, baseCommit }));
    const fakeInventory = {
      actualChangedPaths: ["src/a.js"], actualChangedCount: 1, actualChangedTruncated: false,
      disallowedPaths: [], disallowedCount: 0, disallowedTruncated: false,
    };
    let inventoryReads = 0;
    const result = await getRunDeliveryReadiness({
      runId: RUN_ID, runDir, waitMs: 1000,
      authorizedWorkspaceRoot: repo,
      computeInventoryFn: () => { inventoryReads += 1; return fakeInventory; },
    });
    assert.equal(result.readiness, "packaging_failed", "readiness semantics unchanged");
    assert.equal(result.waitReturnedEarly, true, "settled readiness returns immediately");
    assert.deepEqual(result.candidateInventory, fakeInventory);
    assert.equal(inventoryReads, 1);
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

// ===== MCP: real server behavior + wire schema bounds =====

test("M12-1S1-MCP-01: real MCP run_delivery returns schema-parsed inventory without path leaks", async () => {
  const { repo, baseCommit } = await makeRepo();
  const runDir = await mkdtemp(join(tmpdir(), "m12s1-runs-"));
  try {
    const wt = makeLinkedWorktree(repo, RUN_ID);
    await writeFile(join(wt, "src", "a.js"), "const a = 2;\n");
    await writeFile(join(wt, "new.txt"), "new\n");
    seedTranscript(runDir, RUN_ID, disallowedPathEvents({ repo, worktreePath: wt, baseCommit }));

    const server = createWaoMcpServer({ registryPath: "/r.json", runDir, workspaceRoot: repo });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId: RUN_ID } });
      assert.equal(res.isError, undefined, "inventory projection is not an error");
      const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
      assert.equal(parsed.deliveryAvailable, false);
      assert.equal(parsed.deliveryFailure.code, "disallowed_path");
      assert.ok(parsed.candidateInventory, "candidateInventory present");
      assert.deepEqual(parsed.candidateInventory, {
        actualChangedPaths: ["new.txt", "src/a.js"],
        actualChangedCount: 2,
        actualChangedTruncated: false,
        disallowedPaths: ["new.txt"],
        disallowedCount: 1,
        disallowedTruncated: false,
      });
      if (res.structuredContent) assert.deepEqual(res.structuredContent, parsed);

      // No absolute paths, worktree path, or Git internals cross the wire.
      const dumped = JSON.stringify(res);
      assert.ok(!dumped.includes("worktreePath"), "no worktreePath field");
      assert.ok(!dumped.includes(".wao-worktrees"), "no worktree location");
      assert.ok(!dumped.includes(repo), "no absolute repo path (native form)");
      assert.ok(!dumped.includes(repo.replace(/\\/g, "/")), "no absolute repo path (fwd form)");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await cleanupDir(repo);
    await cleanupDir(runDir);
  }
});

test("M12-1S1-MCP-02: malformed/unsafe service inventory collapses to null (never an error)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12s1-mcp02-"));
  try {
    const failureView = (candidateInventory) => ({
      runId: RUN_ID, terminalState: "failed", deliveryAvailable: false,
      deliveryRequested: true, deliveryFailure: { code: "disallowed_path" },
      candidateInventory,
    });
    const badInventories = [
      { actualChangedPaths: ["src/evil\n.sh"], actualChangedCount: 1, actualChangedTruncated: false, disallowedPaths: [], disallowedCount: 0, disallowedTruncated: false },
      { actualChangedPaths: ["../escape.js"], actualChangedCount: 1, actualChangedTruncated: false, disallowedPaths: [], disallowedCount: 0, disallowedTruncated: false },
      { actualChangedPaths: ["src/a.js"], actualChangedCount: 5, actualChangedTruncated: false, disallowedPaths: [], disallowedCount: 0, disallowedTruncated: false }, // count/paths mismatch
      { actualChangedPaths: ["src/a.js"], actualChangedCount: 1, actualChangedTruncated: true, disallowedPaths: [], disallowedCount: 0, disallowedTruncated: false }, // flag mismatch
      "not-an-object",
    ];
    for (const bad of badInventories) {
      const server = createWaoMcpServer({
        registryPath: "/r.json", runDir: dir,
        getRunDeliveryFn: async () => failureView(bad),
      });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery", arguments: { runId: RUN_ID } });
        assert.equal(res.isError, undefined, "malformed inventory must not error the whole query");
        const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
        assert.equal(parsed.deliveryFailure.code, "disallowed_path");
        assert.equal(parsed.candidateInventory, null, `malformed inventory collapses to null: ${JSON.stringify(bad)}`);
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    await cleanupDir(dir);
  }
});

test("M12-1S1-MCP-03: candidateInventory is null on success and on other failure codes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12s1-mcp03-"));
  try {
    const inventory = {
      actualChangedPaths: ["src/a.js"], actualChangedCount: 1, actualChangedTruncated: false,
      disallowedPaths: [], disallowedCount: 0, disallowedTruncated: false,
    };
    const views = [
      { // success variant
        runId: RUN_ID, terminalState: "completed", deliveryAvailable: true,
        deliveryRef: {
          deliveryCommit: "d".repeat(40), baseCommit: "b".repeat(40),
          changedFiles: ["src/a.js"],
          verification: { status: "passed", commands: [], results: [] },
          acceptance: { status: "pending", reviewerType: "lead_agent" },
          integration: { status: "pending", targetCommit: null },
        },
        verification: { status: "passed" }, acceptance: { status: "pending" },
        candidateInventory: inventory, // must be ignored on success
      },
      { // other packaging failure — inventory must NOT be projected
        runId: RUN_ID, terminalState: "failed", deliveryAvailable: false,
        deliveryRequested: true, deliveryFailure: { code: "empty_diff" },
        candidateInventory: inventory,
      },
      { // no-failure view
        runId: RUN_ID, terminalState: "running", deliveryAvailable: false,
        deliveryRequested: true, deliveryFailure: null,
      },
    ];
    for (const view of views) {
      const server = createWaoMcpServer({
        registryPath: "/r.json", runDir: dir,
        getRunDeliveryFn: async () => view,
      });
      const client = await buildInMemoryClient(server);
      try {
        const res = await client.callTool({ name: "run_delivery", arguments: { runId: RUN_ID } });
        const parsed = JSON.parse(res.content.find((b) => b.type === "text").text);
        assert.equal(parsed.candidateInventory, null, `candidateInventory null for ${view.deliveryFailure?.code ?? "success"}`);
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally {
    await cleanupDir(dir);
  }
});

test("M12-1S1-MCP-04: wire schema exposes candidateInventory with maxItems/maxLength bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "m12s1-mcp04-"));
  try {
    const server = createWaoMcpServer({ registryPath: "/r.json", runDir: dir });
    const client = await buildInMemoryClient(server);
    try {
      const tools = await client.listTools();
      const rd = tools.tools.find((t) => t.name === "run_delivery");
      assert.ok(rd.outputSchema, "run_delivery has an output schema");
      const schemaDump = JSON.stringify(rd.outputSchema);
      assert.ok(schemaDump.includes("candidateInventory"), "candidateInventory is wire-visible");
      assert.ok(schemaDump.includes('"maxItems":256'), "arrays bounded at 256 on the wire");
      assert.ok(schemaDump.includes('"maxLength":512'), "path strings bounded at 512 on the wire");
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await cleanupDir(dir);
  }
});

test("M12-1S1-MCP-05: wait path projects the same additive field", async () => {
  // The M11-10 wait path is workspace-bound, so the server needs a REAL Git
  // workspace root for the binding proof (a plain temp dir would correctly
  // fail closed to the fixed not-bound error before the service is called).
  const { repo } = await makeRepo("m12s1-mcp05-");
  const dir = await mkdtemp(join(tmpdir(), "m12s1-mcp05-runs-"));
  try {
    const inventory = {
      actualChangedPaths: ["new.txt", "src/a.js"], actualChangedCount: 2, actualChangedTruncated: false,
      disallowedPaths: ["new.txt"], disallowedCount: 1, disallowedTruncated: false,
    };
    const server = createWaoMcpServer({
      registryPath: "/r.json", runDir: dir, workspaceRoot: repo,
      getRunDeliveryReadinessFn: async (i) => ({
        runId: i.runId, readiness: "packaging_failed", waitReturnedEarly: true,
        terminalState: "failed", deliveryAvailable: false, deliveryRequested: true,
        deliveryRef: null, deliveryFailure: { code: "disallowed_path" },
        verification: null, acceptance: null, candidateInventory: inventory,
      }),
    });
    const client = await buildInMemoryClient(server);
    try {
      const res = await client.callTool({ name: "run_delivery", arguments: { runId: RUN_ID, waitMs: 2000 } });
      assert.equal(res.isError, undefined);
      const parsed = res.structuredContent;
      assert.equal(parsed.readiness, "packaging_failed");
      assert.deepEqual(parsed.candidateInventory, inventory);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await cleanupDir(repo);
    await cleanupDir(dir);
  }
});
