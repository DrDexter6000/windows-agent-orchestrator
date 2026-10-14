// test/isolation-infra/atomicWriteSync.test.js
//
// src/atomicWriteSync.js: replace (temp + rename) and remove, with a bounded retry for the Windows
// sharing violations EPERM / EBUSY only (the TD-71 rule). The rename, sleep and
// clock are injected, so every case is deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync, removeFileSync, ATOMIC_WRITE_RETRY_BUDGET_MS } from "../../src/atomicWriteSync.js";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "wao-atomic-write-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function codeError(code) {
  return Object.assign(new Error(`${code}: simulated rename failure`), { code });
}

// A rename that fails with the given codes first, then renames for real.
function flakyRename(codes) {
  const queue = [...codes];
  const calls = [];
  const fn = (from, to) => {
    calls.push([from, to]);
    if (queue.length > 0) throw codeError(queue.shift());
    renameSync(from, to);
  };
  return { fn, calls };
}

test("atomicWriteFileSync: replaces the file and leaves no temp file (string and Buffer)", () => {
  withDir((dir) => {
    const target = join(dir, "config.toml");
    writeFileSync(target, "old\n");
    atomicWriteFileSync(target, "new text\n");
    assert.equal(readFileSync(target, "utf8"), "new text\n");
    atomicWriteFileSync(target, Buffer.from([0x23, 0x20, 0x6f]));
    assert.deepEqual(readFileSync(target), Buffer.from([0x23, 0x20, 0x6f]));
    assert.deepEqual(readdirSync(dir), ["config.toml"]);
  });
});

test("atomicWriteFileSync: EPERM and EBUSY are retried until the rename succeeds", () => {
  withDir((dir) => {
    const target = join(dir, "exclude");
    writeFileSync(target, "before\n");
    const rename = flakyRename(["EPERM", "EBUSY", "EPERM"]);
    const sleeps = [];
    atomicWriteFileSync(target, "after\n", { renameFn: rename.fn, sleepFn: (ms) => sleeps.push(ms) });
    assert.equal(readFileSync(target, "utf8"), "after\n");
    assert.equal(rename.calls.length, 4, "three refusals, then the real rename");
    assert.equal(sleeps.length, 3, "one pause after each refusal");
    assert.deepEqual(readdirSync(dir), ["exclude"]);
  });
});

test("atomicWriteFileSync: any other code throws at once, the target is untouched and the temp removed", () => {
  withDir((dir) => {
    const target = join(dir, "config.toml");
    writeFileSync(target, "keep\n");
    const rename = flakyRename(["EACCES"]);
    const sleeps = [];
    assert.throws(
      () => atomicWriteFileSync(target, "lost\n", { renameFn: rename.fn, sleepFn: (ms) => sleeps.push(ms) }),
      (err) => err.code === "EACCES",
    );
    assert.equal(rename.calls.length, 1);
    assert.equal(sleeps.length, 0, "no retry for a non-transient code");
    assert.equal(readFileSync(target, "utf8"), "keep\n");
    assert.deepEqual(readdirSync(dir), ["config.toml"]);
  });
});

test("atomicWriteFileSync: a refusal that outlasts the budget throws the last EPERM and removes the temp", () => {
  withDir((dir) => {
    const target = join(dir, "config.toml");
    writeFileSync(target, "keep\n");
    let now = 0;
    const rename = { calls: 0, fn: () => { rename.calls += 1; throw codeError("EPERM"); } };
    assert.throws(
      () => atomicWriteFileSync(target, "lost\n", {
        renameFn: rename.fn,
        sleepFn: (ms) => { now += ms; },
        nowFn: () => now,
      }),
      (err) => err.code === "EPERM",
    );
    assert.ok(rename.calls > 1, "retried before giving up");
    assert.ok(now >= ATOMIC_WRITE_RETRY_BUDGET_MS, "gave up only after the budget");
    assert.equal(readFileSync(target, "utf8"), "keep\n");
    assert.deepEqual(readdirSync(dir), ["config.toml"]);
  });
});

test("removeFileSync: removes the file; a file already gone counts as removed", () => {
  withDir((dir) => {
    const target = join(dir, "config.toml");
    writeFileSync(target, "x\n");
    removeFileSync(target);
    assert.deepEqual(readdirSync(dir), []);
    removeFileSync(target);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("removeFileSync: EPERM and EBUSY are retried; any other code throws at once", () => {
  withDir((dir) => {
    const target = join(dir, "exclude");
    writeFileSync(target, "x\n");
    const queue = ["EBUSY", "EPERM"];
    const sleeps = [];
    removeFileSync(target, {
      unlinkFn: (p) => { if (queue.length > 0) throw codeError(queue.shift()); unlinkSync(p); },
      sleepFn: (ms) => sleeps.push(ms),
    });
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(sleeps.length, 2);

    writeFileSync(target, "y\n");
    assert.throws(
      () => removeFileSync(target, { unlinkFn: () => { throw codeError("EACCES"); }, sleepFn: () => assert.fail("no retry") }),
      (err) => err.code === "EACCES",
    );
    assert.deepEqual(readdirSync(dir), ["exclude"]);
  });
});
