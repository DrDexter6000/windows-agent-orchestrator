// test/run-lifecycle/runsWaitUntilSettled.test.js
//
// 决定 0095（第 49 批）：CLI `runs wait <runId> --until-settled` 的收口等待器。
// 进程内驱动 runsCommand，注入 resolveDetailedFn / readTranscriptFn / nowFn /
// sleepFn / pollIntervalMs（零真实等待）。覆盖：
//   - 收口即退；终态→交付验证 pending→结果；reverify pending→结果；
//   - 不可信轮计数与清零；降级解析；未找到；冲突立即退出（4）；
//   - 收口后再解析发现变化 → 不可信轮继续；
//   - 与 --wait-ms 互斥；JSON 模式进度在 stderr、stdout 只留最终 JSON；
//   - SIGINT：置位后单一出口，只输出一份最终结果（标注快照读取时间），130。
// 退出码经 process.exitCode 断言（测试内保存/恢复）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runsCommand } from "../../src/commands/runs.js";

const BASE = "b".repeat(40);
const DELIVERED = "d".repeat(40);

function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "wao-runs-wait-settled-"));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function makeRef(runId, over = {}) {
  return {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: BASE,
    deliveryCommit: DELIVERED,
    branch: `wao/${runId}`,
    worktreePath: "D:/fake/wt",
    changedFiles: ["src/a.js"],
    verification: { status: "pending", commands: [], verifiedCommit: DELIVERED, results: [] },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
    ...over,
  };
}

function line(obj) {
  return JSON.stringify(obj);
}

function writeLines(dir, runId, objs) {
  writeFileSync(join(dir, `${runId}.jsonl`), objs.map(line).join("\n") + "\n", "utf8");
}

function appendLines(dir, runId, objs) {
  appendFileSync(join(dir, `${runId}.jsonl`), objs.map(line).join("\n") + "\n", "utf8");
}

function started(runId, { delivery = true } = {}) {
  return {
    type: "run.started", runId, agentId: "coder_low", backend: "claude-code", cwd: "D:/fake/ws",
    ...(delivery ? { delivery: { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["npm test"] } } : {}),
  };
}

function stateChange(runId, to) {
  return { type: "run.state_change", runId, agentId: "coder_low", from: "running", to, reason: "done" };
}

function created(runId, ref = makeRef(runId)) {
  return { type: "run.delivery_created", runId, agentId: "coder_low", delivery: ref };
}

function outcome(runId, status, ref) {
  const verification = status === "failed"
    ? { status, failureCode: "command_failed", commands: [], verifiedCommit: ref.deliveryCommit, results: [] }
    : { status, commands: [], verifiedCommit: ref.deliveryCommit, results: [] };
  return { type: `run.delivery_verification_${status}`, runId, agentId: "coder_low", delivery: { ...ref, verification } };
}

function reverifyRequested(runId, ref) {
  return {
    type: "run.delivery_reverification_requested", runId, agentId: "coder_low",
    delivery: ref, deliveryCommit: ref.deliveryCommit, reason: "tooling_invalid",
  };
}

function reverifyOutcome(runId, ref, status) {
  const verification = { status, commands: [], verifiedCommit: ref.deliveryCommit, results: [] };
  return {
    type: `run.delivery_reverification_${status}`, runId, agentId: "coder_low",
    delivery: { ...ref, verification }, deliveryCommit: ref.deliveryCommit,
  };
}

// 默认详细解析：真实 FS（平铺转录 = found:true、不降级、无冲突）。生产签名
// 是 (runDir, runId) 两参——等待器按该签名调用。
function realResolver(runDir) {
  return (rd, rid) => {
    const path = join(runDir, `${rid}.jsonl`);
    let exists = false;
    try { readFileSync(path); exists = true; } catch { exists = false; }
    return { path, found: exists, degraded: false, conflict: false };
  };
}

// 捕获 console.log（stdout 语义）与 console.error（stderr 语义），逐条记录。
async function captureBoth(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => { out.push(a.map(String).join(" ")); };
  console.error = (...a) => { err.push(a.map(String).join(" ")); };
  try { await fn(); } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out: out.join("\n"), err: err.join("\n"), outLines: out, errLines: err };
}

async function runWaitSettled({ dir, runId, asJson = false, deps = {} }) {
  const prev = process.exitCode;
  let result;
  try {
    process.exitCode = undefined;
    result = await captureBoth(() => runsCommand(
      ["wait", runId, "--until-settled", ...(asJson ? ["--format", "json"] : []), "--run-dir", dir],
      { runDir: dir },
      { pollIntervalMs: 0, resolveDetailedFn: realResolver(dir), ...deps },
    ));
    return { ...result, exitCode: process.exitCode };
  } finally {
    process.exitCode = prev;
  }
}

// =====================================================================
// U-01: 收口即退——终态、无交付 → 第一轮即退出 0，输出终行与 nextStep。
// =====================================================================

test("U-01: settled on first round (terminal, no delivery) → exit 0 + final line + nextStep", async () => {
  const dir = makeRunDir();
  try {
    writeLines(dir, "run_u01", [started("run_u01", { delivery: false }), stateChange("run_u01", "completed")]);
    const r = await runWaitSettled({ dir, runId: "run_u01" });
    assert.equal(r.exitCode, undefined, "收口退出 0（不设置退出码）");
    assert.equal(r.outLines.length, 3, `终行三行，实际: ${JSON.stringify(r.outLines)}`);
    assert.match(r.outLines[0], /^Run: run_u01 \(completed\)$/);
    assert.match(r.outLines[1], /^Settlement: settled \(no_delivery_requested\)$/);
    assert.match(r.outLines[2], /^Next step: .*Verification passed is not acceptance\.$/);
    assert.equal(r.err, "", "文本模式进度写 stdout，stderr 为空");
  } finally {
    cleanupDir(dir);
  }
});

test("U-01b: JSON 模式 → stdout 只留最终 JSON（{settled,runId,state,settlement,nextStep}），进度在 stderr", async () => {
  const dir = makeRunDir();
  try {
    writeLines(dir, "run_u01b", [started("run_u01b", { delivery: false }), stateChange("run_u01b", "completed")]);
    const r = await runWaitSettled({ dir, runId: "run_u01b", asJson: true });
    assert.equal(r.exitCode, undefined);
    const parsed = JSON.parse(r.out);
    assert.deepEqual(Object.keys(parsed).sort(), ["nextStep", "runId", "settled", "settlement", "state"]);
    assert.equal(parsed.settled, true);
    assert.equal(parsed.state, "completed");
    assert.equal(parsed.settlement.status, "settled");
    assert.equal(parsed.settlement.reason, "no_delivery_requested");
    assert.equal(typeof parsed.nextStep, "string");
    assert.equal(r.err, "", "第一轮即收口：无进度行");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// U-02: 终态 + 交付验证 pending → 等到结果（第一轮 unsettled，sleep 间隙
// 追加验证结果，第二轮 settled）。
// =====================================================================

test("U-02: terminal + verification pending → waits, then outcome lands → settled", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u02";
    const ref = makeRef(runId);
    writeLines(dir, runId, [started(runId), created(runId, ref), stateChange(runId, "completed")]);
    let appended = false;
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        // 第一轮读到的快照验证 pending → 进度行 + sleep；sleep 间隙落结果。
        sleepFn: async () => {
          if (!appended) {
            appended = true;
            appendLines(dir, runId, [outcome(runId, "passed", ref)]);
          }
        },
      },
    });
    assert.equal(r.exitCode, undefined, "验证落结果后收口退出 0");
    assert.match(r.outLines.at(-1), /^Next step: /);
    // 第一轮的进度行在 stdout（文本模式），且说未收口。
    assert.ok(r.outLines.some((l) => l.includes("not settled (verification_pending)")),
      `进度行必须出现，实际: ${JSON.stringify(r.outLines)}`);
  } finally {
    cleanupDir(dir);
  }
});

test("U-02b: reverify pending → waits for the reverify outcome → settled", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u02b";
    const failedRef = makeRef(runId, {
      verification: { status: "failed", failureCode: "command_failed", commands: [], verifiedCommit: DELIVERED, results: [] },
    });
    writeLines(dir, runId, [
      started(runId),
      created(runId, failedRef),
      outcome(runId, "failed", failedRef),
      stateChange(runId, "completed"),
      reverifyRequested(runId, failedRef),
    ]);
    let appended = false;
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        sleepFn: async () => {
          if (!appended) {
            appended = true;
            appendLines(dir, runId, [reverifyOutcome(runId, failedRef, "passed")]);
          }
        },
      },
    });
    assert.equal(r.exitCode, undefined, "reverify 落结果后收口退出 0");
    assert.ok(r.outLines.some((l) => l.includes("not settled (reverify_pending)")));
    assert.ok(r.outLines.includes("Settlement: settled (delivery_settled; verification failed; reverify passed)"),
      `终行同时给原始验证与 reverify 结果，实际: ${JSON.stringify(r.outLines)}`);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// U-03: 不可信轮——未找到连续 4 次 → 退出 3 + 诊断入口；计数只在可信轮清零。
// =====================================================================

test("U-03: transcript not found ×4 → exit 3 + diagnostics entry", async () => {
  const dir = makeRunDir();
  try {
    const r = await runWaitSettled({ dir, runId: "run_missing_u03" });
    assert.equal(r.exitCode, 3);
    assert.match(r.out, /Untrusted: 4 consecutive rounds/);
    assert.match(r.out, /Diagnostics: wao runs diagnose run_missing_u03/);
    assert.equal(r.outLines.filter((l) => l.includes("not found")).length, 4, "四轮未找到进度行");
  } finally {
    cleanupDir(dir);
  }
});

test("U-03b: untrusted rounds are RESET by a trusted round (needs 4 CONSECUTIVE)", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u03b";
    const ref = makeRef(runId);
    writeLines(dir, runId, [started(runId), created(runId, ref), stateChange(runId, "completed")]);
    let reads = 0;
    // 读 1-3 失败 → 读 4 可信未收口（验证 pending，清零）→ 读 5-7 失败 → 读 8 收口。
    // 不清零的话读 5 就是第 4 次不可信、退出 3；退出 0 只能来自清零。
    const pending = [
      JSON.parse(line(started(runId))),
      JSON.parse(line(created(runId, ref))),
      JSON.parse(line(stateChange(runId, "completed"))),
    ];
    const readTranscriptFn = async () => {
      reads += 1;
      if (reads === 4) return pending;
      if (reads < 8) throw new Error("gone");
      return [...pending, JSON.parse(line(outcome(runId, "passed", ref)))];
    };
    const r = await runWaitSettled({ dir, runId, deps: { readTranscriptFn } });
    assert.equal(r.exitCode, undefined, "可信轮把计数清零：两段各 3 次不可信 → 收口退出 0");
    assert.equal(reads, 8);
    assert.match(r.outLines.at(-1), /^Next step: /);
  } finally {
    cleanupDir(dir);
  }
});

test("U-03c: 4× undeterminable (failed before packaging) → exit 3, says Undeterminable with the run state", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u03c";
    writeLines(dir, runId, [started(runId), stateChange(runId, "failed")]);
    const r = await runWaitSettled({ dir, runId });
    assert.equal(r.exitCode, 3);
    assert.ok(r.outLines.includes(`Run: ${runId} (failed)`), JSON.stringify(r.outLines));
    assert.match(r.out, /Undeterminable: the delivery facts cannot settle \(terminal_delivery_ambiguous\); waiting will not change them\./);
    assert.match(r.out, new RegExp(`Diagnostics: wao runs diagnose ${runId}; delivery facts: wao runs delivery ${runId}`));
    assert.ok(!/Untrusted:/.test(r.out), "读得到快照时不说不可信");
    const j = await runWaitSettled({ dir, runId, asJson: true });
    assert.equal(j.exitCode, 3);
    const parsed = JSON.parse(j.out);
    assert.equal(parsed.state, "failed");
    assert.equal(parsed.reason, "undeterminable:terminal_delivery_ambiguous");
  } finally {
    cleanupDir(dir);
  }
});

test("U-03d: 4× snapshot read failure → exit 3, Untrusted (no state line)", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u03d";
    writeLines(dir, runId, [started(runId)]);
    const r = await runWaitSettled({
      dir, runId,
      deps: { readTranscriptFn: async () => { throw new Error("EBUSY"); } },
    });
    assert.equal(r.exitCode, 3);
    assert.match(r.out, /Untrusted: 4 consecutive rounds could not be trusted \(last: snapshot_read_failed\)\./);
    assert.equal(r.outLines.filter((l) => l.includes("snapshot read failed")).length, 4);
    assert.ok(!r.outLines.some((l) => l.startsWith("Run: ")));
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// U-04: 解析降级（扫描超限、孪生核验跳过）→ 不可信轮；4 次退出 3。
// =====================================================================

test("U-04: degraded resolution counts as untrusted (4× → exit 3)", async () => {
  const dir = makeRunDir();
  try {
    writeLines(dir, "run_u04", [started("run_u04", { delivery: false }), stateChange("run_u04", "completed")]);
    const r = await runWaitSettled({
      dir, runId: "run_u04",
      deps: {
        resolveDetailedFn: () => ({
          path: join(dir, "run_u04.jsonl"), found: true, degraded: true, conflict: false,
        }),
      },
    });
    assert.equal(r.exitCode, 3);
    assert.match(r.out, /resolution degraded/);
    assert.match(r.out, /Diagnostics: wao runs diagnose run_u04/);
  } finally {
    cleanupDir(dir);
  }
});

test("U-04b: an unreadable copy (hash failed) is an untrusted round, not a conflict (4× → exit 3)", async () => {
  const dir = makeRunDir();
  try {
    const r = await runWaitSettled({
      dir, runId: "run_u04b",
      deps: {
        resolveDetailedFn: () => ({ path: null, found: false, degraded: false, conflict: false, unreadable: true }),
      },
    });
    assert.equal(r.exitCode, 3, "不是 4：没有内容不同的证据");
    assert.equal(r.outLines.filter((l) => l.includes("copy unreadable")).length, 4);
    assert.match(r.out, /last: copy_unreadable/);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// U-05: 持久冲突（多副本内容不同）→ 立即退出 4。
// =====================================================================

test("U-05: persistent conflict → immediate exit 4", async () => {
  const dir = makeRunDir();
  try {
    writeLines(dir, "run_u05", [started("run_u05", { delivery: false }), stateChange("run_u05", "completed")]);
    let calls = 0;
    const r = await runWaitSettled({
      dir, runId: "run_u05",
      deps: {
        resolveDetailedFn: () => {
          calls += 1;
          return { path: null, found: false, degraded: false, conflict: true };
        },
      },
    });
    assert.equal(r.exitCode, 4);
    assert.equal(calls, 1, "冲突立即退出：只解析一次");
    assert.match(r.out, /multiple distinct transcript copies/);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// U-06: 判定收口后再解析发现路径变化 → 不可信轮继续；随后稳定 → 退出 0。
// =====================================================================

test("U-06: resolution changed after settled → untrusted round, keeps waiting; stable later → 0", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u06";
    writeLines(dir, runId, [started(runId, { delivery: false }), stateChange(runId, "completed")]);
    // 解析计数：1（首轮）→ 2（收口确认，返回不同路径）→ 3（次轮）→ 4（确认，稳定）。
    let calls = 0;
    const real = realResolver(dir);
    const resolveDetailedFn = (rd, rid) => {
      calls += 1;
      const r = real(rd, rid);
      if (calls === 2) return { ...r, path: `${r.path}.moved` };
      return r;
    };
    const r = await runWaitSettled({ dir, runId, deps: { resolveDetailedFn } });
    assert.equal(r.exitCode, undefined, "路径稳定后收口退出 0");
    assert.ok(r.outLines.some((l) => l.includes("resolution changed")),
      `收口后路径变化的进度行必须在场: ${JSON.stringify(r.outLines)}`);
    assert.equal(calls, 4, "两次判定各带一次确认解析");
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// U-07: --until-settled 与 --wait-ms 互斥；未知 flag 仍拒绝。
// =====================================================================

test("U-07: --until-settled and --wait-ms are mutually exclusive", async () => {
  const dir = makeRunDir();
  try {
    await assert.rejects(
      () => runsCommand(["wait", "run_x", "--until-settled", "--wait-ms", "30000"], { runDir: dir }),
      /mutually exclusive/,
    );
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// U-08: SIGINT——与正常完成的竞争只有一份输出，退出码非 0（130）。
// =====================================================================

test("U-08: SIGINT during the wait → exactly ONE final output (interrupted, snapshot-annotated), exit 130", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u08";
    writeLines(dir, runId, [started(runId), stateChange(runId, "running")]);
    const base = process.listenerCount("SIGINT");
    let emitted = false;
    const r = await runWaitSettled({
      dir, runId, asJson: true,
      deps: {
        // sleep 期间发 SIGINT：置位 → 当前轮完成后不再输出进度，循环顶部退出。
        // JSON 模式下此前的进度行在 stderr——stdout 只可能剩最终结果本身。
        sleepFn: async () => {
          if (!emitted) {
            emitted = true;
            process.emit("SIGINT");
          }
        },
      },
    });
    assert.equal(r.exitCode, 130, "SIGINT 退出码 130");
    // 唯一一份最终结果：stdout 恰好一条 JSON（置位后进度全部走 stderr）。
    assert.equal(r.outLines.length, 1, `只输出一份最终结果，实际: ${JSON.stringify(r.outLines)}`);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.interrupted, true);
    assert.equal(parsed.settled, false);
    assert.equal(typeof parsed.snapshotReadAt, "string", "标注快照读取时间");
    assert.equal(process.listenerCount("SIGINT"), base, "SIGINT handler 注销（无泄漏）");
  } finally {
    cleanupDir(dir);
  }
});

test("U-08b: SIGINT races normal completion — settled round + interrupt flag → still ONE output, exit 130", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u08b";
    writeLines(dir, runId, [started(runId, { delivery: false }), stateChange(runId, "completed")]);
    const r = await runWaitSettled({
      dir, runId, asJson: true,
      deps: {
        // 快照读取（已可收口）过程中发 SIGINT：单一出口仍只出一份（中断结果）。
        readTranscriptFn: async (p) => {
          process.emit("SIGINT");
          const { readTranscript } = await import("../../src/transcript.js");
          return readTranscript(p);
        },
      },
    });
    assert.equal(r.exitCode, 130, "竞争以中断为准，退出码非 0");
    assert.equal(r.outLines.length, 1, `竞争时只有一份输出，实际: ${JSON.stringify(r.outLines)}`);
    assert.equal(JSON.parse(r.out).interrupted, true);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// U-09: 只读不变量——等待不改变转录字节；JSON 进度走 stderr。
// =====================================================================

test("U-09: read-only（多轮等待转录字节不变）+ JSON 模式进度在 stderr", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u09";
    const ref = makeRef(runId);
    writeLines(dir, runId, [started(runId), created(runId, ref), stateChange(runId, "completed")]);
    const before = readFileSync(join(dir, `${runId}.jsonl`));
    let appended = false;
    const r = await runWaitSettled({
      dir, runId, asJson: true,
      deps: {
        sleepFn: async () => {
          if (!appended) {
            appended = true;
            appendLines(dir, runId, [outcome(runId, "unavailable", ref)]);
          }
        },
      },
    });
    // sleep 间隙的结果是"外部世界"写入的；等待器自身在判定轮之前不加一字节。
    // 断言：等待器退出后文件 = 初始 + 那一条外部追加（无等待器自己的写入）。
    const after = readFileSync(join(dir, `${runId}.jsonl`));
    assert.equal(after.length - before.length, line(outcome(runId, "unavailable", ref)).length + 1,
      "唯一字节变化是外部追加的验证结果");
    assert.ok(after.subarray(0, before.length).equals(before), "原有字节没有被等长改写");
    // JSON 模式：进度行写 stderr，stdout 只留最终 JSON。
    assert.ok(r.errLines.some((l) => l.includes("[runs wait]") && l.includes("not settled")),
      `进度在 stderr，实际: ${JSON.stringify(r.errLines)}`);
    assert.equal(r.outLines.length, 1, "stdout 只留最终 JSON");
    assert.equal(JSON.parse(r.out).settled, true);
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// U-10: 可信未收口轮的进度节流——同状态同原因不重复打印，原因变化或满
// 5 分钟才再打一行；不可信轮之后的下一可信轮无条件打印。
// =====================================================================

test("U-10: trusted unsettled progress is throttled (change / untrusted / every 5 min)", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u10";
    const ref = makeRef(runId);
    writeLines(dir, runId, [started(runId), created(runId, ref), stateChange(runId, "completed")]);
    const base = [
      JSON.parse(line(started(runId))),
      JSON.parse(line(created(runId, ref))),
      JSON.parse(line(stateChange(runId, "completed"))),
    ];
    const failedRef = makeRef(runId, {
      verification: { status: "failed", failureCode: "command_failed", commands: [], verifiedCommit: DELIVERED, results: [] },
    });
    let clock = 0;
    let reads = 0;
    // 读 1-3 验证 pending（同原因）；读 4 读失败（不可信）；读 5 仍 pending；
    // 读 6 跨过 5 分钟仍 pending；读 7 reverify pending（原因变化）；读 8 收口。
    const readTranscriptFn = async () => {
      reads += 1;
      if (reads === 4) throw new Error("transient");
      if (reads <= 6) return base;
      const failed = [...base, JSON.parse(line(outcome(runId, "failed", failedRef)))];
      if (reads === 7) return [...failed, JSON.parse(line(reverifyRequested(runId, failedRef)))];
      return [
        ...failed,
        JSON.parse(line(reverifyRequested(runId, failedRef))),
        JSON.parse(line(reverifyOutcome(runId, failedRef, "passed"))),
      ];
    };
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        readTranscriptFn,
        nowFn: () => clock,
        sleepFn: async () => { clock += reads === 5 ? 5 * 60 * 1000 : 15000; },
      },
    });
    assert.equal(r.exitCode, undefined, "reverify 落结果后收口退出 0");
    const progressLines = r.outLines.filter((l) => l.startsWith("[runs wait]"));
    assert.deepEqual(
      progressLines.map((l) => /round (\d+):/.exec(l)[1]),
      ["1", "4", "5", "6", "7"],
      `轮 1 打印；轮 2-3 同原因不打；轮 4 不可信；轮 5 紧随不可信；轮 6 满 5 分钟；轮 7 原因变化；实际: ${JSON.stringify(progressLines)}`,
    );
  } finally {
    cleanupDir(dir);
  }
});

// =====================================================================
// U-11: 非终态且转录满 30 分钟未见新体征 → 进度行给安静提示与两个出口
// （runs settle / stop，只在 Lead 决定时用）；终态等验证的轮不报体征。
// =====================================================================

test("U-11: quiet non-terminal round names the exits; terminal rounds carry no vital-sign text", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u11";
    const ref = makeRef(runId);
    const lastEventMs = Date.parse("2026-10-29T20:00:00.000Z");
    const runEvent = { type: "run.event", runId, ts: new Date(lastEventMs).toISOString(), event: { type: "tool_use" } };
    writeLines(dir, runId, [started(runId), runEvent]);
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      const base = [JSON.parse(line(started(runId))), runEvent];
      if (reads === 1) return base;
      const done = [...base, JSON.parse(line(created(runId, ref))), JSON.parse(line(stateChange(runId, "completed")))];
      if (reads === 2) return done;
      return [...done, JSON.parse(line(outcome(runId, "passed", ref)))];
    };
    const r = await runWaitSettled({
      dir, runId,
      deps: { readTranscriptFn, nowFn: () => lastEventMs + 31 * 60_000 },
    });
    assert.equal(r.exitCode, undefined);
    const progressLines = r.outLines.filter((l) => l.startsWith("[runs wait]"));
    assert.equal(progressLines.length, 2, `实际: ${JSON.stringify(progressLines)}`);
    assert.match(progressLines[0], /No new signs of life in the transcript for 31 min/);
    assert.match(progressLines[0], /wao runs settle and wao stop/);
    assert.match(progressLines[1],
      /state=completed not settled \(verification_pending\); delivery state: wao runs delivery run_u11$/);
    assert.ok(!/vital sign|signs of life/.test(progressLines[1]), "终态轮不报体征");
  } finally {
    cleanupDir(dir);
  }
});
