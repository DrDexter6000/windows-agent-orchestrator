// ADR 0035 S2: class-A hygiene guards in the canonical suite.
// Fixture unit tests for the classifiers + real-state assertions for this repo.
// Class-A facts (branch refs, worktree registry) live in the common git dir, so
// these checks observe identical state from the main repo and any worktree —
// unlike class-B filesystem state which stays in `npm run hygiene` (R23-D §7).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  BRANCH_CAP, REGISTRY_EXTERNAL_ROOTS,
  classifyRegistryEntries, classifyBranchCount,
  listWorktreePaths, countRunBranches, normPath,
} from "../../scripts/hygiene.mjs";

const repo = path.resolve(import.meta.dirname, "..", "..");
const never = () => false;
const always = () => true;

test("classifyRegistryEntries: main-repo and allowed external roots are ok", () => {
  const main = normPath(repo);
  const external = [...REGISTRY_EXTERNAL_ROOTS.keys()][0];
  const rows = classifyRegistryEntries(
    [repo, main + "/.wao-worktrees/run_x", external + "/some/run_y"],
    { repo, existsFn: always },
  );
  assert.deepEqual(rows.map((r) => r.status), ["ok-main", "ok-main", "ok-external"]);
});

test("classifyRegistryEntries: missing path and unknown root are red", () => {
  const rows = classifyRegistryEntries(
    ["D:/gone/checkout", "Z:/mystery/root/run_z"],
    { repo, existsFn: (p) => !p.startsWith("D:/gone") },
  );
  assert.equal(rows[0].status, "missing");
  assert.equal(rows[1].status, "unknown-root");
});

test("classifyRegistryEntries: case and separator insensitive against roots", () => {
  const [row] = classifyRegistryEntries(
    ["D:\\Projects\\.codex-worktrees\\wao\\m12-8f-final"],
    { repo, existsFn: always },
  );
  assert.equal(row.status, "ok-external");
});

test("classifyBranchCount: ratchet boundary", () => {
  assert.equal(classifyBranchCount(BRANCH_CAP).ok, true);
  assert.equal(classifyBranchCount(BRANCH_CAP + 1).ok, false);
  assert.equal(classifyBranchCount(0).ok, true);
});

test("BRANCH_CAP and external roots carry ADR 0035 values", () => {
  assert.equal(BRANCH_CAP, 175);
  for (const [root, reason] of REGISTRY_EXTERNAL_ROOTS) {
    assert.match(root, /^[a-z]:\//, "roots are stored normalized");
    assert.ok(reason.length > 5, "every allowlist entry carries a reason");
  }
});

test("real state: registry drift is green and branch count under cap", () => {
  const drift = classifyRegistryEntries(listWorktreePaths(repo), { repo });
  const bad = drift.filter((d) => d.status === "missing" || d.status === "unknown-root");
  assert.deepEqual(bad, [], `unexpected drift (fix or extend allowlist with reason + declare): ${JSON.stringify(bad, null, 2)}`);
  const bc = classifyBranchCount(countRunBranches(repo));
  assert.equal(bc.ok, true, `branch ratchet exceeded: ${bc.count} > ${bc.cap} — close out decided deliveries or raise cap via declare`);
});
