import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCommittedDeliveryRef, DeliveryError } from "./delivery.js";
// R23-F/B Round B（TD-130）：同机验证串行化闸的 env 标记名 SSOT。verifyDelivery
// 自身不进闸——只提供 opts.gate 缝与 HELD 注入；是否创建闸由调用方裁决
// （createCallerGate）。
import { VERIFICATION_GATE_HELD_ENV, createVerificationGate, gateEngaged } from "./verificationGate.js";

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

// TD-130 (R17) W1: per-side diagnostic tail cap, in BYTES of raw subprocess
// output. Bounded memory (the accumulators never hold more than this) AND a
// bounded persisted footprint — a delivery_verification_* event carries at
// most one non-empty tail pair (verification is fail-fast: every command
// before the failing one exited 0, and green output is byte-counted only).
// The truncation marker (`…[truncated N bytes]`, N = dropped byte count) sits
// ON TOP of this cap, not inside it.
const TAIL_MAX_BYTES = 8192;

// ===== Public API: runVerificationCommand =====

/**
 * Run a single verification command asynchronously.
 *
 * Uses `spawn(command, {shell:true})` — the one intentional shell boundary.
 * stdout/stderr are piped and drained; byte counts are always kept, and on a
 * NON-SUCCESS outcome (non-zero exit, timeout, or launch error) a bounded
 * tail of each stream is retained for failure diagnosis (TD-130: five
 * harness-side `npm test` exit-1 events left only a stderr byte count — the
 * content needed to diagnose them was dropped). Green output stays
 * byte-counted only: passing commands contribute no output body to any
 * persisted result, keeping delivery events small and the long-standing
 * "success results carry no output body" contract (3B-07/3B-25) intact.
 *
 * Content class & bound of the tails: subprocess test output (repo-generated
 * content), capped at TAIL_MAX_BYTES per side plus a short truncation marker.
 * They ride the existing credential discipline for free — every transcript
 * persistence path (append / tryAppendReverifyOutcome /
 * tryAppendRepackageVerification) runs the whole delivery payload through the
 * exact-secret redactor (secretRedaction.js), which rewrites any literal
 * secret value inside the tails. No keyword filtering is applied (it would
 * mangle TAP output); the MCP run_delivery boundary stays content-free.
 *
 * The subprocess runs with `opts.env` (a full environment) so the caller can
 * inject a unique per-attempt TMP/TEMP/TMPDIR. When omitted, process.env is
 * used (zero drift for existing callers).
 *
 * @param {string} command — shell command string (Lead-authored)
 * @param {string} cwd — worktree path (exact delivery commit worktree)
 * @param {{timeoutMs?: number, env?: object}|number} [opts] — options, or a
 *   legacy positive-integer timeout (back-compat for direct numeric callers)
 * @returns {Promise<{command, exitCode, signal, timedOut, durationMs, stdoutBytes, stderrBytes, stdoutTail, stderrTail, launchError?}>}
 */
export async function runVerificationCommand(command, cwd, opts = DEFAULT_TIMEOUT_MS) {
  // Back-compat: a bare number is the legacy timeout form.
  const timeoutMs = typeof opts === "number" ? opts : (opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const env = (opts && typeof opts === "object" && !Array.isArray(opts)) ? (opts.env ?? process.env) : process.env;
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    // TD-130 (R17): rolling last-TAIL_MAX_BYTES-bytes window per stream.
    // Memory is bounded regardless of output volume; the exact dropped count
    // is derivable at the end (total bytes minus retained bytes).
    let stdoutTailBuf = Buffer.alloc(0);
    let stderrTailBuf = Buffer.alloc(0);
    let timedOut = false;
    let resolved = false;

    const child = spawn(command, {
      cwd,
      env,
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
      stdoutTailBuf = _appendTail(stdoutTailBuf, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderrTailBuf = _appendTail(stderrTailBuf, chunk);
    });

    child.on("close", (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // Tails are a FAILURE-diagnostic: only a non-success outcome carries
      // output content. Success keeps the byte-count-only contract.
      const failed = timedOut || code !== 0;
      resolve({
        command,
        exitCode: timedOut ? null : code,
        signal: timedOut ? null : signal,
        timedOut,
        durationMs: Date.now() - startTime,
        stdoutBytes,
        stderrBytes,
        stdoutTail: failed ? _tailString(stdoutTailBuf, stdoutBytes) : "",
        stderrTail: failed ? _tailString(stderrTailBuf, stderrBytes) : "",
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
        stdoutTail: _tailString(stdoutTailBuf, stdoutBytes),
        stderrTail: _tailString(stderrTailBuf, stderrBytes),
        launchError: true,
      });
    });
  });
}

// ===== TD-130 (R17) W1: bounded output-tail helpers =====

/**
 * Append a chunk to the rolling tail window, keeping at most TAIL_MAX_BYTES.
 * Pure buffer arithmetic — no decoding until the final _tailString call.
 */
function _appendTail(tail, chunk) {
  if (!chunk || chunk.length === 0) return tail;
  const merged = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
  if (merged.length <= TAIL_MAX_BYTES) return merged;
  return merged.subarray(merged.length - TAIL_MAX_BYTES);
}

/**
 * Render the retained window as a diagnostic string. When output was dropped,
 * prefix an explicit marker with the exact dropped byte count so the reader
 * can see the truncation and its size. The cap slices at a byte boundary, so
 * a multi-byte UTF-8 sequence split at the head edge may decode to a
 * replacement character — acceptable for a diagnostic tail (the marker makes
 * the head edge visible).
 */
function _tailString(tail, totalBytes) {
  if (tail.length === 0) return "";
  const dropped = Math.max(0, totalBytes - tail.length);
  const body = tail.toString("utf8");
  return dropped > 0 ? `…[truncated ${dropped} bytes]\n${body}` : body;
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

// ===== M12-6 (FR-05/FR-06): per-attempt temp isolation =====

/**
 * Build a unique per-attempt temp dir under the OS temp root and a full
 * subprocess environment pointing TMP/TEMP (Windows) and TMPDIR (POSIX) at it.
 * Each verification command (setup OR assertion) is its own attempt — two
 * attempts never share a temp dir, and none reuses a worker temp.
 *
 * On mkdtemp failure (rare OS/tooling error) the environment degrades honestly:
 * the OS temp root is still injected so subprocesses resolve a TMP/TEMP, but
 * `isolated` is false so the persisted environment fact records the degradation
 * rather than lying. This never aborts a run on a transient temp-dir failure.
 *
 * @param {boolean} [gateHeld=false] — 本进程持闸时，每个 attempt env 追加
 *     WAO_VERIFICATION_GATE_HELD=1（env 第一跳：验证子进程见即跳过再认领）。
 * @returns {Promise<{env: object, tempDir: string|null, isolated: boolean}>}
 */
async function _prepareAttemptEnv(gateHeld = false) {
  // 防自锁标记只在本进程真正持闸时注入；无闸/fail-open 绝不谎报。
  const held = gateHeld ? { [VERIFICATION_GATE_HELD_ENV]: "1" } : {};
  try {
    const dir = await mkdtemp(join(tmpdir(), "wao-verify-"));
    return { env: { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir, ...held }, tempDir: dir, isolated: true };
  } catch {
    const fallback = tmpdir();
    return {
      env: { ...process.env, TMP: fallback, TEMP: fallback, TMPDIR: fallback, ...held },
      tempDir: null,
      isolated: false,
    };
  }
}

/** Best-effort cleanup of a per-attempt temp dir. Never throws. */
async function _cleanupAttemptEnv(attempt) {
  if (!attempt || !attempt.tempDir) return;
  try {
    await rm(attempt.tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort — the OS temp dir is reaped independently.
  }
}

/**
 * Record a single command outcome. Carries the Lead-authored command string
 * itself, safe byte-counted facts, and — TD-130 (R17) — additive bounded
 * `stdoutTail`/`stderrTail` strings for FAILURE diagnosis only. Content class:
 * subprocess test output (repo-generated), ≤ TAIL_MAX_BYTES per side plus a
 * short truncation marker, riding the existing repo-wide no-credential
 * discipline (every transcript persistence path exact-secret-redacts the whole
 * delivery payload). The recorder ENFORCES the green-no-tail contract
 * structurally: a success-shaped result (exit 0, no timeout, no launch error)
 * records empty tails even if a custom runner reported content, and a runner
 * that returns no tail fields at all (legacy injected fakes) normalizes to ""
 * so every recorded result has the same shape.
 */
function _recordResult(index, command, result) {
  const green = result.exitCode === 0 && !result.timedOut && !result.launchError;
  return {
    index,
    command,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTail: green || typeof result.stdoutTail !== "string" ? "" : result.stdoutTail,
    stderrTail: green || typeof result.stderrTail !== "string" ? "" : result.stderrTail,
  };
}

/**
 * Safe environment facts persisted on the DeliveryRef. Boolean scalars only —
 * the per-attempt temp dir PATH is never persisted (no absolute path leakage).
 */
function _envFacts(isolationFullyHeld) {
  return { tempPerAttempt: Boolean(isolationFullyHeld) };
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
 * @param {{ timeoutMs?: number, runCommand?: Function,
 *           gate?: {acquire: Function}|null }} [opts] — gate 是 R23-F/B 的同机
 *     串行化闸缝（默认关）：传入时 acquire 先于首条命令、finally 恰好释放一次、
 *     持闸期间 attempt env 注入 WAO_VERIFICATION_GATE_HELD=1；fail-open 不改语义。
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

  // Determine verification commands from the deliveryRef. assertion commands
  // (`commands`) remain the verification authority; `setupCommands` are the
  // optional Lead-authored environment preparation that runs BEFORE assertions.
  const commands = deliveryRef?.verification?.commands ?? [];
  const setupCommands = deliveryRef?.verification?.setupCommands ?? [];
  const unavailableReason = deliveryRef?.verification?.unavailableReason;

  // No assertion commands → unavailable / fail-closed. Setup does NOT run when
  // there are no assertions to prepare for (contract #3: setup precedes
  // assertions; M12-6 #19 — declared setup with no assertions is a no-op).
  // CTO RED #1 fix: must prove exact committed DeliveryRef BEFORE returning
  // unavailable.
  if (commands.length === 0) {
    if (typeof unavailableReason === "string" && unavailableReason.trim().length > 0) {
      // Exact proof before declaring unavailable — a forged/dirty ref must fail here.
      assertCommittedDeliveryRef(deliveryRef);
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

  /**
   * The whole command sequence (setup + assertion), parameterized by whether
   * this process holds the machine lease. Extracted verbatim so the gate seam
   * below can wrap it in acquire/try-finally-release WITHOUT touching the
   * phase logic — every return path inside is covered by exactly one release.
   *
   * @param {boolean} gateHeld
   */
  const runPhases = async (gateHeld) => {
    // Per-attempt temp isolation is tracked across all commands (setup + assertion).
    const isolation = { fullyHeld: true };

    // ===== SETUP PHASE (contract #3): sequential, before assertions =====
    // Setup failure is a closed, actionable, safe set (setup_failed /
    // setup_timeout / setup_environment_error) — NEVER disguised as assertion
    // command_failed. Each setup step is followed by an exact delivery-commit /
    // tracked-artifact proof; tracked-artifact or lockfile drift is
    // artifact_mutated and assertions do NOT run.
    const setupResults = [];
    for (let i = 0; i < setupCommands.length; i++) {
      const r = await _runOneCommand(
        runCommand, setupCommands[i], deliveryRef.worktreePath, timeoutMs, deliveryRef, isolation, SETUP_CODES, gateHeld,
      );
      setupResults.push(_recordResult(i, setupCommands[i], r.result));

      if (r.outcome === "mutated") {
        return _failDelivery(deliveryRef, {
          setupCommands, commands, setupResults, results: [],
          failureCode: "artifact_mutated", failedPhase: "setup", failedCommandIndex: i,
          verifiedCommit: deliveryRef.deliveryCommit, timeoutMs, isolation,
        });
      }
      if (r.outcome === "failed") {
        return _failDelivery(deliveryRef, {
          setupCommands, commands, setupResults, results: [],
          failureCode: r.failureCode, failedPhase: "setup", failedCommandIndex: i,
          verifiedCommit: deliveryRef.deliveryCommit, timeoutMs, isolation,
        });
      }
    }

    // ===== ASSERTION PHASE (existing authority; zero drift on codes) =====
    const results = [];
    for (let i = 0; i < commands.length; i++) {
      const r = await _runOneCommand(
        runCommand, commands[i], deliveryRef.worktreePath, timeoutMs, deliveryRef, isolation, ASSERT_CODES, gateHeld,
      );
      results.push(_recordResult(i, commands[i], r.result));

      if (r.outcome === "mutated") {
        return _failDelivery(deliveryRef, {
          setupCommands, commands, setupResults, results,
          failureCode: "artifact_mutated", failedPhase: "assertion", failedCommandIndex: i,
          verifiedCommit: deliveryRef.deliveryCommit, timeoutMs, isolation,
        });
      }
      if (r.outcome === "failed") {
        return _failDelivery(deliveryRef, {
          setupCommands, commands, setupResults, results,
          failureCode: r.failureCode, failedPhase: "assertion", failedCommandIndex: i,
          verifiedCommit: deliveryRef.deliveryCommit, timeoutMs, isolation,
        });
      }
    }

    // All commands passed + final proof still holds (checked after last command)
    return {
      delivery: _buildUpdatedRef(deliveryRef, {
        status: "passed",
        commands,
        // setup contract is an append-only extension: persist ONLY when declared,
        // so deliveries without setup stay byte-identical (zero drift).
        ...(setupCommands.length > 0 ? { setupCommands, setupResults } : {}),
        verifiedCommit: deliveryRef.deliveryCommit,
        timeoutMs,
        results,
        environment: _envFacts(isolation.fullyHeld),
      }),
      outcome: "passed",
    };
  };

  // ===== R23-F/B Round B (TD-130): machine-level serialization gate seam =====
  //
  // 默认关：opts.gate 缺席 ⇒ 行为与历史版本逐字节一致（33 处注入式测试与单文件
  // 跑零漂移）。开启时（三条生产路径经 createCallerGate 显式传入）：
  //   · acquire 先于第一条命令——排队等待发生在任何 spawn 之前，而 per-command
  //     计时器在 spawn 时才武装，因此排队绝不消耗 verificationTimeoutMs；
  //   · 持闸期间每个 attempt env 注入 WAO_VERIFICATION_GATE_HELD=1（子进程见即
  //     跳过再认领——防自锁）；
  //   · fail-open：acquire ⇒ null（基础设施故障，闸已向 sink 打 WARNING）时无闸
  //     继续跑、不注入 HELD、不调用 release；
  //   · try/finally：passed / failed / 抛错都恰好释放一次；闸的争用与降级永不
  //     改变任何失败码语义（红线）。
  const gate = opts.gate && typeof opts.gate.acquire === "function" ? opts.gate : null;
  if (!gate) return runPhases(false);

  const handle = await gate.acquire();
  if (!handle) return runPhases(false); // fail-open（WARNING 已由闸写入 sink）
  try {
    return await runPhases(true);
  } finally {
    await handle.release();
  }
}

/**
 * R23-F/B Round B (TD-130)：生产路径入闸判定的单一工厂。
 *
 * 只有同时满足两个条件才创建闸对象：
 *   1. 调用方依赖默认验证器（usesDefaultVerifier）——注入了自定义
 *      verifyDeliveryFn 的调用方（全部既有测试、内部复用）一律不入闸，
 *      否则 npm test 的并发验证会真实争抢机器租约；
 *   2. gateEngaged(env)：kill switch 未关 且 本进程未持闸（防自锁）。
 *
 * 返回的闸对象交给 verifyDelivery 的 opts.gate 缝；acquire/release 生命周期
 * 由缝负责，调用方无需管理。
 *
 * @param {{usesDefaultVerifier: boolean, identity?: object, env?: NodeJS.ProcessEnv}} args
 * @returns {object|null} createVerificationGate 实例，或 null（不入闸）
 */
export function createCallerGate({ usesDefaultVerifier, identity = {}, env = process.env }) {
  if (!usesDefaultVerifier) return null;
  if (!gateEngaged(env)) return null;
  return createVerificationGate({ identity });
}

// ===== M12-6 (FR-05/FR-06): per-command runner + phase failure codes =====

// Closed-set failure code per phase. artifact_mutated is phase-agnostic (it
// takes priority over any command code) and is tagged with failedPhase by the
// caller. These are the ONLY setup-vs-assertion-distinct codes; setup failures
// never surface as assertion command_failed (contract #3).
const SETUP_CODES = { launch: "setup_environment_error", timeout: "setup_timeout", nonzero: "setup_failed" };
const ASSERT_CODES = { launch: "execution_error", timeout: "command_timeout", nonzero: "command_failed" };

/**
 * Run one verification command (setup or assertion) with per-attempt temp
 * isolation, then re-prove the exact delivery commit / tracked artifacts.
 *
 * @param {Function} runCommand — command runner (real or fake)
 * @param {string} command — Lead-authored command string
 * @param {string} cwd — exact delivery commit worktree
 * @param {number} timeoutMs
 * @param {object} deliveryRef — for the post-command exact proof
 * @param {{fullyHeld: boolean}} isolation — shared flag flipped false on degradation
 * @param {{launch:string,timeout:string,nonzero:string}} codes — phase failure codes
 * @param {boolean} [gateHeld=false] — 持闸标记，透传给 attempt env 注入（env 第一跳）
 * @returns {Promise<{outcome:"ok"|"mutated"|"failed", failureCode?:string, result:object}>}
 */
async function _runOneCommand(runCommand, command, cwd, timeoutMs, deliveryRef, isolation, codes, gateHeld = false) {
  const attempt = await _prepareAttemptEnv(gateHeld);
  if (!attempt.isolated) isolation.fullyHeld = false;
  let result;
  try {
    result = await runCommand(command, cwd, { timeoutMs, env: attempt.env });
  } finally {
    await _cleanupAttemptEnv(attempt);
  }

  // CTO RED #2 fix: re-run exact proof after EVERY command outcome (exit 0,
  // non-zero, timeout, launch-error). If the proof fails, the artifact was
  // mutated — artifact_mutated takes priority over the command's own code.
  let mutated = false;
  try {
    assertCommittedDeliveryRef(deliveryRef);
  } catch {
    mutated = true;
  }
  if (mutated) return { outcome: "mutated", result };

  // Artifact intact — classify the command's own outcome into the phase codes.
  if (result.launchError) return { outcome: "failed", failureCode: codes.launch, result };
  if (result.timedOut) return { outcome: "failed", failureCode: codes.timeout, result };
  if (result.exitCode !== 0) return { outcome: "failed", failureCode: codes.nonzero, result };
  return { outcome: "ok", result };
}

/**
 * Build a failed-verification result. Persists the setup/assertion command
 * contract, the phase that failed, and safe environment facts — all bound to
 * the exact deliveryCommit. Never mutates the input ref.
 */
function _failDelivery(originalRef, f) {
  const hasSetup = Array.isArray(f.setupCommands) && f.setupCommands.length > 0;
  const delivery = _buildUpdatedRef(originalRef, {
    status: "failed",
    commands: f.commands,
    // setup contract persisted ONLY when declared (zero drift for no-setup runs).
    ...(hasSetup ? { setupCommands: f.setupCommands, setupResults: f.setupResults } : {}),
    results: f.results,
    verifiedCommit: f.verifiedCommit,
    timeoutMs: f.timeoutMs,
    failureCode: f.failureCode,
    failedPhase: f.failedPhase,
    failedCommandIndex: f.failedCommandIndex,
    environment: _envFacts(f.isolation.fullyHeld),
  });
  return { delivery, outcome: "failed", failureCode: f.failureCode };
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
