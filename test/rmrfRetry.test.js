// test/rmrfRetry.test.js
//
// TD-107: deterministic, zero-I/O coverage of the shared test-only rmrfRetry
// helper (test/_rmrfHelper.mjs). The five duplicated inline copies across the
// suite are collapsed into that one helper; this file pins its contract:
//   - every transient Windows FS code (EPERM/EBUSY/ENOTEMPTY) is retried,
//   - retry exhaustion rethrows the last transient error,
//   - a non-transient error rethrows immediately (no retry, no sleep),
//   - rm + sleep are injectable so coverage is causal, not wall-clock or FS.
//
// The Windows cwd-lock regression probe lives in cli.test.js (it needs a real
// child process) and is diagnostic-only (not_reproduced) when the OS does not
// reproduce the lock — see TD-107.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rmrfRetry, isTransientRmError, TRANSIENT_RM_ERROR_CODES } from "./_rmrfHelper.mjs";

function transientError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

test("rmrfRetry helper: EPERM transient then success retries and clears", () => {
  const rms = [];
  const sleeps = [];
  const rm = (dir) => {
    rms.push(dir);
    if (rms.length < 3) throw transientError("EPERM");
    // 3rd attempt: success (handle released)
  };
  const attempts = rmrfRetry("d", { retries: 20, delayMs: 7, rm, sleep: (ms) => sleeps.push(ms) });
  assert.equal(rms.length, 3, "three rm attempts (two transient, one success)");
  assert.deepEqual(sleeps, [7, 7], "one sleep between each retry");
  assert.equal(attempts, 3, "reports attempt count");
});

test("rmrfRetry helper: EBUSY transient then success", () => {
  let n = 0;
  const rm = () => { n += 1; if (n < 2) throw transientError("EBUSY"); };
  const attempts = rmrfRetry("d", { retries: 5, delayMs: 1, rm, sleep: () => {} });
  assert.equal(n, 2);
  assert.equal(attempts, 2);
});

test("rmrfRetry helper: ENOTEMPTY transient then success", () => {
  let n = 0;
  const rm = () => { n += 1; if (n < 4) throw transientError("ENOTEMPTY"); };
  rmrfRetry("d", { retries: 20, delayMs: 1, rm, sleep: () => {} });
  assert.equal(n, 4, "ENOTEMPTY is transient and retried until the dir drains");
});

test("rmrfRetry helper: exhaustion rethrows the last transient error after `retries` retries", () => {
  const rm = () => { throw transientError("EPERM"); };
  const sleeps = [];
  assert.throws(
    () => rmrfRetry("d", { retries: 3, delayMs: 1, rm, sleep: (ms) => sleeps.push(ms) }),
    (error) => error?.code === "EPERM",
    "exhaustion rethrows the transient error",
  );
  // retries=3 ⇒ rm at attempt 0,1,2,3 (4 calls), sleeps at 0,1,2 (3 sleeps).
  assert.equal(sleeps.length, 3, "exactly `retries` sleeps before giving up");
});

test("rmrfRetry helper: non-transient error (ENOENT) rethrows immediately, no retry, no sleep", () => {
  const rms = [];
  const sleeps = [];
  const rm = (dir) => { rms.push(dir); throw transientError("ENOENT"); };
  assert.throws(
    () => rmrfRetry("d", { retries: 20, delayMs: 1, rm, sleep: (ms) => sleeps.push(ms) }),
    (error) => error?.code === "ENOENT",
  );
  assert.equal(rms.length, 1, "a non-transient error is not retried");
  assert.deepEqual(sleeps, [], "no sleep on a non-transient error");
});

test("rmrfRetry helper: isTransientRmError + closed-set codes", () => {
  assert.deepEqual([...TRANSIENT_RM_ERROR_CODES].sort(), ["EBUSY", "ENOTEMPTY", "EPERM"]);
  for (const code of TRANSIENT_RM_ERROR_CODES) assert.equal(isTransientRmError(transientError(code)), true);
  assert.equal(isTransientRmError(transientError("ENOENT")), false);
  assert.equal(isTransientRmError(null), false);
  assert.equal(isTransientRmError(undefined), false);
});

test("rmrfRetry helper: default rm/sleep clears a real temp dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rmrfhelper-"));
  const attempts = rmrfRetry(dir); // default rm=rmSync, sleep=sleepSync
  assert.equal(attempts, 1, "clean dir removes on the first attempt");
});
