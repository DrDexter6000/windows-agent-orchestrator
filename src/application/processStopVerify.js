// src/application/processStopVerify.js
//
// M10-pre Batch B: bounded process-exit verification after timeout/abort.
//
// After a process worker is killed (taskkill /T /F), poll isAlive() for a
// bounded window to confirm the process actually died. Write durable evidence
// (stop_verified or stop_unverified) to the transcript. Never records raw
// command, absolute path, PID command line, stderr, or credentials.

const DEFAULT_ROUNDS = 3;
const DEFAULT_INTERVAL_MS = 1000;

/**
 * Verify that a process-backed worker has exited after kill/abort.
 * Uses injectable isAlive + sleep for deterministic testing.
 *
 * @param {object} input
 * @param {Function} input.isAlive — () => boolean, true if process still running
 * @param {Function} [input.sleep] — (ms) => Promise, defaults to setTimeout
 * @param {number} [input.rounds] — number of poll rounds
 * @param {number} [input.intervalMs] — ms between rounds
 * @returns {Promise<{quiet: boolean, roundsUsed: number}>}
 */
export async function verifyProcessExit({
  isAlive,
  sleep,
  rounds = DEFAULT_ROUNDS,
  intervalMs = DEFAULT_INTERVAL_MS,
}) {
  if (typeof isAlive !== "function") {
    throw new Error("verifyProcessExit: isAlive function is required");
  }
  const _sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  for (let i = 0; i < rounds; i++) {
    if (!isAlive()) {
      return { quiet: true, roundsUsed: i + 1 };
    }
    if (i < rounds - 1) {
      await _sleep(intervalMs);
    }
  }
  return { quiet: false, roundsUsed: rounds };
}
