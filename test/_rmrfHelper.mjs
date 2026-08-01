// test/_rmrfHelper.mjs
//
// TD-107: the single test-only `rmrfRetry` helper. Replaces five identical
// inline copies that previously lived in:
//   - test/cli.test.js
//   - test/runCollectCompact.test.js
//   - test/runAwaitResult.test.js
//   - test/runAwaitResultCompat.test.js
//   - test/m12-6-fr08-safeFailures.test.js
//
// Why it exists: on Windows, a background/detached process can briefly hold a
// cwd/file handle, so `rmSync(dir, { recursive: true, force: true })` throws a
// transient EPERM/EBUSY/ENOTEMPTY. A bounded retry clears it once the handle
// releases. See docs/tech-debt.md TD-70.
//
// Determinism contract (TD-107): `rm` and `sleep` are injectable so the helper
// can be exercised causally — every transient code, retry exhaustion, and the
// non-transient immediate-throw path — without real I/O or any wall-clock wait.
// See test/rmrfRetry.test.js.

import { rmSync } from "node:fs";

/**
 * Synchronous sleep that does not spin the CPU. Uses Atomics.wait on a fresh
 * SharedArrayBuffer (available in Node without flags). Returns early (like
 * setTimeout(0)) when interrupted; callers treat it as best-effort pacing.
 * @param {number} ms
 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Frozen closed set of transient Windows FS error codes worth retrying. */
export const TRANSIENT_RM_ERROR_CODES = Object.freeze(["EPERM", "EBUSY", "ENOTEMPTY"]);

/**
 * True only for the transient codes a background handle can produce. Everything
 * else (ENOENT, EACCES, EINVAL, …) is non-transient and must surface immediately.
 * @param {Error & { code?: string } | null | undefined} error
 */
export function isTransientRmError(error) {
  return error != null && TRANSIENT_RM_ERROR_CODES.includes(error.code);
}

/**
 * `rm -rf` with a bounded retry for transient Windows FS errors.
 *
 * @param {string} dir — path to remove.
 * @param {object} [options]
 * @param {number} [options.retries=20] — max number of retries after the first
 *   attempt (so up to `retries + 1` rm calls total before giving up).
 * @param {number} [options.delayMs=50] — sleep between retries.
 * @param {(dir: string) => void} [options.rm] — injectable remover; defaults to
 *   `rmSync(dir, { recursive: true, force: true })`.
 * @param {(ms: number) => void} [options.sleep] — injectable sleep; defaults to
 *   {@link sleepSync}.
 * @returns {number} the number of rm attempts actually made (1 on first-shot
 *   success).
 */
export function rmrfRetry(dir, options = {}) {
  const {
    retries = 20,
    delayMs = 50,
    rm = (d) => rmSync(d, { recursive: true, force: true }),
    sleep = sleepSync,
  } = options;
  let attempt = 0;
  for (;;) {
    try {
      rm(dir);
      return attempt + 1;
    } catch (error) {
      if (!isTransientRmError(error) || attempt >= retries) throw error;
      sleep(delayMs);
      attempt += 1;
    }
  }
}
