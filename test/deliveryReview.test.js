// test/deliveryReview.test.js
//
// M11-1A: safe delivery changed-path projection.
//
// projectDeliveryChangedPaths() is a pure application helper that projects a
// durable DeliveryRef's changedFiles into a bounded, repo-relative, safe list
// for MCP run_delivery. It must:
//   - reuse src/delivery.js path-validation SSOT (no second path algorithm)
//   - not import commands/mcp/SDK/zod
//   - cap at 64 (server-owned constant), deterministic order
//   - fail-closed on every malformed path vector
//   - never mutate input

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectDeliveryChangedPaths, CHANGED_PATHS_LIMIT } from "../src/application/deliveryReview.js";

// ===== normal projection =====

test("DR-01: normal 2-path projection — exact paths, count=2, truncated=false, input unchanged", () => {
  const input = ["src/a.js", "test/a.test.js"];
  const snapshot = [...input];
  const result = projectDeliveryChangedPaths({ changedFiles: input });
  assert.deepEqual(result.changedPaths, ["src/a.js", "test/a.test.js"]);
  assert.equal(result.changedFileCount, 2);
  assert.equal(result.changedPathsTruncated, false);
  // input not mutated
  assert.deepEqual(input, snapshot);
});

test("DR-02: exactly 64 paths — all returned, truncated=false", () => {
  const input = Array.from({ length: 64 }, (_, i) => `src/f${i}.js`);
  // must be sorted unique for a valid canonical input
  input.sort();
  const result = projectDeliveryChangedPaths({ changedFiles: input });
  assert.equal(result.changedPaths.length, 64);
  assert.equal(result.changedFileCount, 64);
  assert.equal(result.changedPathsTruncated, false);
  assert.deepEqual(result.changedPaths, input);
});

test("DR-03: 65 paths — only first 64 returned, count=65, truncated=true", () => {
  const input = Array.from({ length: 65 }, (_, i) => `src/f${String(i).padStart(3, "0")}.js`);
  input.sort();
  const result = projectDeliveryChangedPaths({ changedFiles: input });
  assert.equal(result.changedPaths.length, 64);
  assert.equal(result.changedFileCount, 65);
  assert.equal(result.changedPathsTruncated, true);
  // deterministically the first 64 after sort
  assert.deepEqual(result.changedPaths, input.slice(0, 64));
});

test("DR-04: cap is the server-owned constant 64", () => {
  assert.equal(CHANGED_PATHS_LIMIT, 64);
});

test("DR-04b: 64-cap is a hard ceiling — limit=65/1000/Infinity cannot bypass it", () => {
  // RED on prior head: projectDeliveryChangedPaths accepted an arbitrary limit
  // and could return >64. GREEN: output length never exceeds CHANGED_PATHS_LIMIT
  // regardless of caller-supplied limit; changedFileCount still reflects reality.
  const input = Array.from({ length: 65 }, (_, i) => `src/f${String(i).padStart(3, "0")}.js`);
  input.sort();
  for (const badLimit of [65, 1000, Infinity]) {
    const result = projectDeliveryChangedPaths({ changedFiles: input, limit: badLimit });
    assert.ok(result.changedPaths.length <= CHANGED_PATHS_LIMIT,
      `limit=${badLimit}: changedPaths must be <= ${CHANGED_PATHS_LIMIT}; got ${result.changedPaths.length}`);
    assert.equal(result.changedPaths.length, CHANGED_PATHS_LIMIT,
      `limit=${badLimit}: must cap at exactly ${CHANGED_PATHS_LIMIT}`);
    assert.equal(result.changedFileCount, 65, `limit=${badLimit}: real total preserved`);
    assert.equal(result.changedPathsTruncated, true, `limit=${badLimit}: truncated=true`);
  }
});

// ===== fail-closed on malformed path vectors =====

function expectThrow(changedFiles, label) {
  assert.throws(
    () => projectDeliveryChangedPaths({ changedFiles }),
    /invalid|malformed|path|canonical|sort|duplicate/i,
    `[${label}] must throw`,
  );
}

test("DR-05: Windows absolute path rejected", () => {
  expectThrow(["C:\\Users\\owner\\secret.js"], "Windows absolute");
});

test("DR-06: POSIX absolute path rejected", () => {
  expectThrow(["/etc/passwd"], "POSIX absolute");
});

test("DR-07: UNC path rejected", () => {
  expectThrow(["\\\\server\\share\\secret.js"], "UNC");
});

test("DR-08: traversal ../secret and src/../secret rejected", () => {
  expectThrow(["../secret"], "leading ../");
  expectThrow(["src/../secret"], "mid ../");
});

test("DR-09: leading/trailing/double separator rejected", () => {
  expectThrow(["/src/a.js"], "leading slash");
  expectThrow(["src/a.js/"], "trailing slash");
  expectThrow(["src//a.js"], "double slash");
});

test("DR-10: NUL/tab/newline/control character rejected", () => {
  expectThrow(["src/a\0.js"], "NUL");
  expectThrow(["src/a\t.js"], "tab");
  expectThrow(["src/a\n.js"], "newline");
  expectThrow(["src/a\x01.js"], "control char");
});

test("DR-11: empty/non-string/>512 chars rejected", () => {
  expectThrow([""], "empty string");
  expectThrow([123], "non-string number");
  expectThrow([null], "non-string null");
  expectThrow(["x".repeat(513) + ".js"], ">512 chars");
});

test("DR-12: duplicate path rejected", () => {
  expectThrow(["src/a.js", "src/a.js"], "duplicate");
});

test("DR-13: non-canonical backslash or unsorted array rejected", () => {
  // Backslash form is non-canonical (Git uses forward slash); rejected.
  expectThrow(["src\\a.js"], "backslash");
  // Unsorted array rejected (canonical input must be sorted).
  expectThrow(["src/b.js", "src/a.js"], "unsorted");
});

test("DR-14: changedFiles not an array rejected", () => {
  assert.throws(
    () => projectDeliveryChangedPaths({ changedFiles: "src/a.js" }),
    /array|invalid/i,
    "non-array changedFiles must throw",
  );
  assert.throws(
    () => projectDeliveryChangedPaths({ changedFiles: null }),
    /array|invalid/i,
    "null changedFiles must throw",
  );
});

test("DR-15: empty array is valid (zero changed files)", () => {
  const result = projectDeliveryChangedPaths({ changedFiles: [] });
  assert.equal(result.changedFileCount, 0);
  assert.deepEqual(result.changedPaths, []);
  assert.equal(result.changedPathsTruncated, false);
});

// ===== input immutability under failure =====

test("DR-16: malformed input not mutated even when throwing", () => {
  const input = ["C:\\abs\\path.js", "src/ok.js"];
  const snapshot = [...input];
  assert.throws(() => projectDeliveryChangedPaths({ changedFiles: input }));
  assert.deepEqual(input, snapshot);
});
