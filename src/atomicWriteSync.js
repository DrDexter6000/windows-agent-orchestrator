// src/atomicWriteSync.js
//
// Replace or remove a small WAO-owned file (a host config, .git/info/exclude).
// A replace writes a temp file in the same directory, then renames it over the
// target.
//
// On Windows a rename or delete fails with EPERM or EBUSY while another process
// (antivirus, the search indexer, an editor) briefly holds the target. Those two
// codes are retried within a bounded budget, the same rule as the transcript
// append lock (TD-71); every other code throws at once. When the budget runs out
// the last error is thrown unchanged, so a real permission problem still
// surfaces with its own code. A failed replace removes its temp file.

import { randomBytes } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ATOMIC_WRITE_RETRY_BUDGET_MS = 2000;
const ATOMIC_WRITE_RETRY_POLL_MS = 10;
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Run op until it succeeds, retrying only the transient codes within the budget.
function withTransientRetry(op, deps) {
  const sleepFn = deps.sleepFn ?? sleepSync;
  const nowFn = deps.nowFn ?? Date.now;
  const deadline = nowFn() + (deps.budgetMs ?? ATOMIC_WRITE_RETRY_BUDGET_MS);
  for (;;) {
    try {
      return op();
    } catch (err) {
      if (!TRANSIENT_CODES.has(err?.code) || nowFn() >= deadline) throw err;
      sleepFn(ATOMIC_WRITE_RETRY_POLL_MS);
    }
  }
}

/**
 * Atomically replace filePath with content (strings are written as UTF-8).
 *
 * @param {string} filePath
 * @param {string|Buffer} content
 * @param {{renameFn?: Function, sleepFn?: Function, nowFn?: Function, budgetMs?: number}} [deps] — test seams
 */
export function atomicWriteFileSync(filePath, content, deps = {}) {
  const renameFn = deps.renameFn ?? renameSync;
  const tmp = join(dirname(filePath), `.wao-tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, content);
    withTransientRetry(() => renameFn(tmp, filePath), deps);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the temp may not exist */ }
    throw err;
  }
}

/**
 * Remove filePath; a file that is already gone counts as removed.
 *
 * @param {string} filePath
 * @param {{unlinkFn?: Function, sleepFn?: Function, nowFn?: Function, budgetMs?: number}} [deps] — test seams
 */
export function removeFileSync(filePath, deps = {}) {
  const unlinkFn = deps.unlinkFn ?? unlinkSync;
  try {
    withTransientRetry(() => unlinkFn(filePath), deps);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}
