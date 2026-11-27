// test/application/dashboardBuild.test.js
//
// 第 145b 批（决定 0131 第 2 条）：复用时的 build 比对——三种结果。
//   same     两边都读得出、都干净、src 树哈希相同；
//   different 两边都读得出、都干净、src 树哈希不同；
//   unknown  其余一切（有一边读不出、有一边脏树、字段缺失）——既不说相同也不说不同。
// 快照来源是 serverBuildFacts（src/ 树哈希 + dirty），不另造 build 身份系统。

import { test } from "node:test";
import assert from "node:assert/strict";

import { compareDashboardBuild, buildSnapshotFromFacts } from "../../src/application/dashboardBuild.js";

const snap = (readable, srcTree, dirty) => ({ readable, srcTree, dirty });
const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);

test("compare: same tree, both sides provably clean -> same", () => {
  assert.equal(compareDashboardBuild(snap(true, TREE_A, false), snap(true, TREE_A, false)), "same");
});

test("compare: differing tree, both sides provably clean -> different", () => {
  assert.equal(compareDashboardBuild(snap(true, TREE_A, false), snap(true, TREE_B, false)), "different");
});

test("compare: anything else is unknown, never same and never different", () => {
  const unknowns = [
    [snap(true, TREE_A, true), snap(true, TREE_A, true)],   // dirty on both sides
    [snap(true, TREE_A, false), snap(true, TREE_A, true)],   // dirty now
    [snap(true, TREE_A, true), snap(true, TREE_A, false)],   // dirty at record time
    [snap(false, null, null), snap(true, TREE_A, false)],    // stored side unreadable
    [snap(true, TREE_A, false), snap(false, null, null)],    // current side unreadable
    [snap(true, null, false), snap(true, TREE_A, false)],    // stored tree hash missing
    [snap(true, TREE_A, null), snap(true, TREE_A, false)],   // dirty flag unknown
    [null, snap(true, TREE_A, false)],                        // no stored build at all
    [snap(true, TREE_A, false), null],                        // no current build at all
  ];
  for (const [stored, current] of unknowns) {
    assert.equal(compareDashboardBuild(stored, current), "unknown");
  }
});

test("snapshot from serverBuildFacts: readability is the RECORD side (start tree + start dirty)", () => {
  const base = {
    startedAt: "2026-01-01T00:00:00.000Z",
    headAtStart: TREE_A, headNow: TREE_A,
    srcTreeAtStart: TREE_A, srcTreeNow: TREE_A,
    srcDirtyAtStart: false, srcDirtyNow: false,
    readable: true, packageVersion: "1.2.3",
  };
  assert.deepEqual(buildSnapshotFromFacts(base), snap(true, TREE_A, false));
  assert.deepEqual(
    buildSnapshotFromFacts({ ...base, srcTreeAtStart: TREE_B, srcDirtyAtStart: true }),
    snap(true, TREE_B, true),
  );
  // The record side intact but the CURRENT side unreadable: the snapshot itself stays
  // readable — the comparison's "unknown" comes from the other snapshot.
  assert.deepEqual(buildSnapshotFromFacts({ ...base, srcTreeNow: null, readable: false }), snap(true, TREE_A, false));
  // A start tree that never read out: nothing to compare later.
  assert.deepEqual(buildSnapshotFromFacts({ ...base, srcTreeAtStart: null, srcDirtyAtStart: null }), snap(false, null, null));
  assert.deepEqual(buildSnapshotFromFacts(null), snap(false, null, null));
});
