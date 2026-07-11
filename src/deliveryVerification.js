import { spawn, execFileSync } from "node:child_process";
import { assertCommittedDeliveryRef, DeliveryError } from "./delivery.js";

/**
 * Delivery Verification Kernel (Phase 3B).
 *
 * Executes Lead-authored verification commands against an exact delivery commit
 * in its persistent linked worktree. Does NOT use agent backends. This is a
 * tool-domain local command runner.
 *
 * Lifecycle:
 *   worker/backend + scorecard + package
 *     -> run.delivery_created (verification.status: "pending")
 *     -> run.completed
 *     -> run.state_change completed
 *     -> delivery verification runs
 *     -> run.delivery_verification_passed | failed | unavailable
 *     -> Lead acceptance remains pending
 *
 * Run terminal and delivery verification are separate state dimensions.
 * A failed verification produces completed:true + verification.status:"failed".
 *
 * Trust boundary: the one intentional shell boundary is `spawn(command, {shell:true})`.
 * This is isolated in this module. Command strings come from the Lead-authored
 * delivery request persisted before worker spawn — never from worker output.
 */

// ===== Constants =====

const DEFAULT_TIMEOUT_MS = 300_000;

// ===== Public API: runVerificationCommand =====

/**
 * Run a single verification command asynchronously.
 *
 * Uses `spawn(command, {shell:true})` — the one intentional shell boundary.
 * stdout/stderr are piped and drained (byte-counted only, not stored).
 *
 * @param {string} command — shell command string (Lead-authored)
 * @param {string} cwd — worktree path (exact delivery commit worktree)
 * @param {number} timeoutMs — positive integer timeout
 * @returns {Promise<{command, exitCode, signal, timedOut, durationMs, stdoutBytes, stderrBytes}>}
 */
export async function runVerificationCommand(command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let resolved = false;

    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      _killProcessTree(child.pid);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdoutBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
    });

    child.on("close", (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode: timedOut ? null : code,
        signal: timedOut ? null : signal,
        timedOut,
        durationMs: Date.now() - startTime,
        stdoutBytes,
        stderrBytes,
      });
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startTime,
        stdoutBytes,
        stderrBytes,
        launchError: true,
      });
    });
  });
}

// ===== Process tree kill (Windows) =====

function _killProcessTree(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Best-effort — process may have already exited
  }
}

// ===== Timeout validation =====

function _validateTimeout(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new DeliveryError("execution_error", "timeoutMs must be a positive finite number");
  }
}

// ===== Public API: verifyDelivery =====

/**
 * Verify a delivery commit by running Lead-authored commands against it.
 *
 * Steps:
 * 1. Validate input and timeout.
 * 2. If no commands and unavailableReason present → return unavailable.
 * 3. If no commands and no unavailableReason → fail closed (execution_error).
 * 4. Prove exact committed DeliveryRef (assertCommittedDeliveryRef).
 * 5. Execute commands sequentially, re-checking artifact integrity after each.
 * 6. Return updated DeliveryRef with verification status + results.
 *
 * @param {object} deliveryRef — committed DeliveryRef v1 (verification.status: "pending")
 * @param {{ timeoutMs?: number, runCommand?: Function }} [opts]
 * @returns {Promise<{ delivery: object, outcome: string, failureCode?: string }>}
 */
export async function verifyDelivery(deliveryRef, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runCommand = opts.runCommand ?? runVerificationCommand;

  // Pre-check: deliveryRef must be an object with schema
  if (!deliveryRef || typeof deliveryRef !== "object") {
    throw new DeliveryError("artifact_mismatch", "deliveryRef must be an object");
  }
  if (deliveryRef.schemaVersion !== 1 || deliveryRef.kind !== "git_commit") {
    throw new DeliveryError("artifact_mismatch", "deliveryRef must be schemaVersion 1, kind git_commit");
  }

  // Validate timeout before any command execution
  _validateTimeout(timeoutMs);

  // Determine verification commands from the deliveryRef
  const commands = deliveryRef?.verification?.commands ?? [];
  const unavailableReason = deliveryRef?.verification?.unavailableReason;

  // Unavailable: no commands, reason present
  if (commands.length === 0) {
    if (typeof unavailableReason === "string" && unavailableReason.trim().length > 0) {
      return {
        delivery: _buildUpdatedRef(deliveryRef, {
          status: "unavailable",
          commands: [],
          unavailableReason,
          verifiedCommit: deliveryRef.deliveryCommit,
          results: [],
        }),
        outcome: "unavailable",
      };
    }
    // No commands and no reason → fail closed
    throw new DeliveryError("execution_error", "deliveryRef has no verification commands and no unavailableReason");
  }

  // Pre-execution exact proof
  assertCommittedDeliveryRef(deliveryRef);

  const results = [];
  for (let i = 0; i < commands.length; i++) {
    const result = await runCommand(commands[i], deliveryRef.worktreePath, timeoutMs);
    results.push({
      index: i,
      command: commands[i],
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
    });

    // Launch error → execution_error
    if (result.launchError) {
      return {
        delivery: _buildUpdatedRef(deliveryRef, {
          status: "failed",
          commands,
          verifiedCommit: deliveryRef.deliveryCommit,
          timeoutMs,
          results,
          failureCode: "execution_error",
          failedCommandIndex: i,
        }),
        outcome: "failed",
        failureCode: "execution_error",
      };
    }

    // Timeout → command_timeout
    if (result.timedOut) {
      return {
        delivery: _buildUpdatedRef(deliveryRef, {
          status: "failed",
          commands,
          verifiedCommit: deliveryRef.deliveryCommit,
          timeoutMs,
          results,
          failureCode: "command_timeout",
          failedCommandIndex: i,
        }),
        outcome: "failed",
        failureCode: "command_timeout",
      };
    }

    // Non-zero exit → command_failed
    if (result.exitCode !== 0) {
      return {
        delivery: _buildUpdatedRef(deliveryRef, {
          status: "failed",
          commands,
          verifiedCommit: deliveryRef.deliveryCommit,
          timeoutMs,
          results,
          failureCode: "command_failed",
          failedCommandIndex: i,
        }),
        outcome: "failed",
        failureCode: "command_failed",
      };
    }

    // Exit 0 — re-check artifact integrity
    try {
      assertCommittedDeliveryRef(deliveryRef);
    } catch (err) {
      // Artifact mutated by the command
      return {
        delivery: _buildUpdatedRef(deliveryRef, {
          status: "failed",
          commands,
          verifiedCommit: deliveryRef.deliveryCommit,
          timeoutMs,
          results,
          failureCode: "artifact_mutated",
          failedCommandIndex: i,
        }),
        outcome: "failed",
        failureCode: "artifact_mutated",
      };
    }
  }

  // All commands passed
  return {
    delivery: _buildUpdatedRef(deliveryRef, {
      status: "passed",
      commands,
      verifiedCommit: deliveryRef.deliveryCommit,
      timeoutMs,
      results,
    }),
    outcome: "passed",
  };
}

// ===== Helper: build updated DeliveryRef =====

/**
 * Build a new DeliveryRef with updated verification object.
 * Never mutates the input ref. Preserves all other fields byte-for-byte.
 */
function _buildUpdatedRef(originalRef, verificationFields) {
  return {
    ...originalRef,
    verification: {
      ...verificationFields,
    },
    // Preserve acceptance and integration unchanged
    acceptance: { ...originalRef.acceptance },
    integration: { ...originalRef.integration },
  };
}
