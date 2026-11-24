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
// 第 118 批 B 加多目标（M-*）：先到先返回、停表后即时判定、Still waiting/
// Re-arm 两行、{multi,results,remaining,rearmCommand}、退出码聚合 4>5>3>0、
// 去重（含 a a 仍走单目标面）、17 个拒绝、与 --wait-ms/无旗标拒绝、SIGINT 130。
// 续修（会审 consult_20261119105652657wri9nw）：停表唤醒睡眠、停表后不再开始
// 新证明、证明串行错峰、收尾期 SIGINT（只列未出结局目标）、重挂照抄 --run-dir/
// --format json、确认阶段冲突当仍在等、退出码补组合、16 目标接受、M-10 改屏障
// 确定性。
// 退出码经 process.exitCode 断言（测试内保存/恢复）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runsCommand } from "../../src/commands/runs.js";
import { judgeRunSettlementOnce } from "../../src/application/runSettlementWait.js";
import { readTranscript } from "../../src/transcript.js";

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
    return { path, found: exists, conflict: false };
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
// U-04b: 多副本里一份哈希读失败 → 不可信轮（不是冲突）；4 次退出 3。
// =====================================================================

test("U-04b: an unreadable copy (hash failed) is an untrusted round, not a conflict (4× → exit 3)", async () => {
  const dir = makeRunDir();
  try {
    const r = await runWaitSettled({
      dir, runId: "run_u04b",
      deps: {
        resolveDetailedFn: () => ({ path: null, found: false, conflict: false, unreadable: true }),
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
          return { path: null, found: false, conflict: true };
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
      deps: {
        readTranscriptFn,
        nowFn: () => lastEventMs + 31 * 60_000,
        // 第 107 批补注：本用例测进度行形状，不测证明——缺省证明会真跑 PowerShell
        // 扫描，且本机扫描失败（runner_scan_failed）自第 107 批起会触发报警出口
        // 的重读、吃掉一次夹具读。注入非闭集拒绝桩：不发报警、不重读，也免去
        // 真实扫描（时序与本用例原断言一致）。
        runnerGoneFn: async () => ({ gone: false, refusal: "foreground_no_session" }),
      },
    });
    assert.equal(r.exitCode, undefined);
    const progressLines = r.outLines.filter((l) => l.startsWith("[runs wait]"));
    assert.equal(progressLines.length, 2, `实际: ${JSON.stringify(progressLines)}`);
    assert.match(progressLines[0], /No new signs of life in the transcript for 31 min/);
    assert.match(progressLines[0], /wao runs settle and wao stop/);
    assert.match(progressLines[1],
      /state=completed not settled \(verification_pending\); delivery state: wao runs delivery run_u11; verifier proof: not_pending$/,
      "终态轮不报体征；无后台派发的形状证明以 not_pending 拒绝，理由进进度行");
    assert.ok(!/vital sign|signs of life/.test(progressLines[1]), "终态轮不报体征");
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 决定 0096：等待器证明验证者已不在（节流 5 分钟；证明成立后重读再判一次）。
// ═══════════════════════════════════════════════════════════════════════════

const PROOF_TS = "2026-09-01T00:00:00.000Z";

// 与 settle 同一套注入：证明里的所有探测都是桩，零真实进程/PowerShell。
// handshakeReader 是三态读器契约（{present:false} = 无握手文件）。
const verifierProofDeps = {
  verifierProofDeps: {
    ownerLeaseReader: () => ({ present: false }),
    identifyFn: async () => ({ verdict: "gone", basis: "pid_exited" }),
    runnerScanFn: async () => ({ alive: false }),
    handshakeReader: () => ({ present: false }),
    daemonAliveFn: () => false,
  },
};

function verifierEvents(runId, { decideRejected = false } = {}) {
  const ref = makeRef(runId);
  const events = [
    { ...started(runId), ts: PROOF_TS },
    { type: "run.background_submitted", runId, agentId: "coder_low", background: true, ts: PROOF_TS },
    { ...created(runId, ref), ts: PROOF_TS },
    { ...stateChange(runId, "completed"), ts: PROOF_TS },
  ];
  if (decideRejected) {
    events.push({
      type: "run.delivery_rejected",
      runId,
      agentId: "coder_low",
      ts: PROOF_TS,
      delivery: {
        ...ref,
        verification: { ...ref.verification, status: "pending" },
        acceptance: { status: "rejected", reviewerType: "lead_agent" },
      },
      deliveryCommit: ref.deliveryCommit,
      reviewerType: "lead_agent",
      reason: "验证不会完成，先行有界拒收",
    });
  }
  return { ref, events };
}

test("W-01: 证明成立且重读仍 pending → 退出 3（文本终行 + verifier_gone 的 nextStep）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg01";
    const { events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    const r = await runWaitSettled({ dir, runId, deps: verifierProofDeps });
    assert.equal(r.exitCode, 3);
    assert.equal(r.outLines.length, 3, `只输出三行终行，实际: ${JSON.stringify(r.outLines)}`);
    assert.equal(r.outLines[0], `Run: ${runId} (completed)`);
    assert.equal(
      r.outLines[1],
      `Stuck: the verification of ${runId} has no outcome and no WAO process that could finish it remains (lease_missing); waiting will not change this.`,
    );
    assert.match(r.outLines[2], /^Next step: Its verification will not finish\. Reject it while it is pending: wao runs delivery run_wg01 --reject --reason-file <FILE>\./);
    assert.ok(!r.outLines.some((l) => l.startsWith("[runs wait]")), "证明成立即退：不打印未收口进度行");
  } finally {
    cleanupDir(dir);
  }
});

test("W-01b: JSON 模式——{settled:false,runId,state,reason,basis,nextStep}，进度不上 stdout", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg01b";
    const { events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    const r = await runWaitSettled({ dir, runId, asJson: true, deps: verifierProofDeps });
    assert.equal(r.exitCode, 3);
    assert.equal(r.outLines.length, 1, "stdout 只留最终 JSON");
    const parsed = JSON.parse(r.out);
    assert.deepEqual(Object.keys(parsed).sort(), ["basis", "nextStep", "reason", "runId", "settled", "state"]);
    assert.equal(parsed.settled, false);
    assert.equal(parsed.runId, runId);
    assert.equal(parsed.state, "completed");
    assert.equal(parsed.reason, "verifier_gone");
    assert.equal(parsed.basis, "lease_missing");
    assert.equal(typeof parsed.nextStep, "string");
  } finally {
    cleanupDir(dir);
  }
});

test("W-01c: 已拒收之后的 verifier_gone → nextStep 指'没有可等的了'（第二支）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg01c";
    const { events } = verifierEvents(runId, { decideRejected: true });
    writeLines(dir, runId, events);
    const r = await runWaitSettled({ dir, runId, asJson: true, deps: verifierProofDeps });
    assert.equal(r.exitCode, 3);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.reason, "verifier_gone");
    assert.match(parsed.nextStep, /already rejected; nothing is left to wait for/);
    assert.ok(!parsed.nextStep.includes("--reject"), "已拒收不再建议拒收");
  } finally {
    cleanupDir(dir);
  }
});

test("W-02: 证明成立但重读时结果已落盘 → 照常退出 0，不报 verifier_gone", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg02";
    const { ref, events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      if (reads === 1) return events;
      return [...events, outcome(runId, "passed", ref)];
    };
    const r = await runWaitSettled({ dir, runId, deps: { ...verifierProofDeps, readTranscriptFn } });
    assert.equal(r.exitCode, undefined, "重读已收口 → 退出 0");
    assert.equal(reads, 2, "一轮正常读 + 证明后一次重读");
    assert.match(r.out, /Settlement: settled \(delivery_settled/);
    assert.ok(!/verifier_gone|Stuck:/.test(r.out), "不出现 verifier_gone 输出");
  } finally {
    cleanupDir(dir);
  }
});

test("W-03: 证明成立后重读解析不可读（哈希失败轮）→ 不可信轮，不当 pending、不退出 3(verifier_gone)", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg03";
    const { ref, events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    let resolves = 0;
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      return reads === 1 ? events : [...events, outcome(runId, "passed", ref)];
    };
    const real = realResolver(dir);
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        ...verifierProofDeps,
        readTranscriptFn,
        resolveDetailedFn: (rd, rid) => {
          resolves += 1;
          if (resolves === 2) return { path: null, found: false, conflict: false, unreadable: true };
          return real(rd, rid);
        },
      },
    });
    assert.equal(r.exitCode, undefined, "解析不可读只算不可信轮；随后收口退出 0");
    assert.ok(r.outLines.some((l) => l.includes("copy unreadable")), "重读的解析不可读按既有规则报");
    assert.ok(!/verifier_gone|Stuck:/.test(r.out));
  } finally {
    cleanupDir(dir);
  }
});

test("W-03b: 证明成立后重读失败 → 不可信轮，不当 pending、不退出 3(verifier_gone)", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg03b";
    const { ref, events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      if (reads === 2) throw new Error("EBUSY");
      if (reads === 1) return events;
      return [...events, outcome(runId, "passed", ref)];
    };
    const r = await runWaitSettled({ dir, runId, deps: { ...verifierProofDeps, readTranscriptFn } });
    assert.equal(r.exitCode, undefined);
    assert.ok(r.outLines.some((l) => l.includes("snapshot read failed")), "重读失败按快照读取失败记账");
    assert.ok(!/verifier_gone|Stuck:/.test(r.out));
  } finally {
    cleanupDir(dir);
  }
});

test("W-04: 证明不成立（租约新鲜）→ 照常等待，不输出新内容", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg04";
    const { ref, events } = verifierEvents(runId);
    // 夹具用验证者形状（一条 background_submitted + 各事件带 ts）：证明的前提
    // 成立，才真走到租约门那一支（缺 background_submitted 或缺可解析 ts 会在
    // 前提就以 foreground_verifier/not_pending 拒绝，测不到"证明不成立 → 继续
    // 等"）。
    writeLines(dir, runId, events);
    let appended = false;
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        verifierProofDeps: {
          ownerLeaseReader: () => ({ present: true, wellFormed: true, fresh: true, heartbeatAt: Date.now(), pid: 100 }),
          identifyFn: async () => ({ verdict: "same", basis: "identity_confirmed" }),
          runnerScanFn: async () => ({ alive: false }),
          handshakeReader: () => ({ present: false }),
          daemonAliveFn: () => false,
        },
        sleepFn: async () => {
          if (!appended) {
            appended = true;
            appendLines(dir, runId, [outcome(runId, "passed", ref)]);
          }
        },
      },
    });
    assert.equal(r.exitCode, undefined, "证明不成立 → 继续等，结果落地后退出 0");
    assert.ok(r.outLines.some((l) => l.includes("not settled (verification_pending)")), "照常打未收口进度");
    assert.ok(r.outLines.some((l) => l.includes("verifier proof: owner_fresh")), "证明被拒的理由进进度行明细");
    assert.ok(!/verifier_gone|Stuck:/.test(r.out), "不输出 verifier_gone");
  } finally {
    cleanupDir(dir);
  }
});

test("W-05: 节流——同一等待器两次证明至少间隔 5 分钟（时钟注入）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg05";
    const ref = makeRef(runId);
    const { events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    const clockBase = Date.parse("2026-10-15T12:00:00.000Z");
    let clock = clockBase;
    let proofCalls = 0;
    let reads = 0;
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        nowFn: () => clock,
        sleepFn: async () => { clock += 15000; },
        readTranscriptFn: async () => {
          reads += 1;
          return reads < 26 ? events : [...events, outcome(runId, "passed", ref)];
        },
        verifierGoneFn: async () => {
          proofCalls += 1;
          return { gone: false, refusal: "owner_fresh" };
        },
      },
    });
    assert.equal(r.exitCode, undefined, "第 26 轮结果落地后收口");
    assert.equal(reads, 26);
    assert.equal(proofCalls, 2, "首轮一次 + 满 5 分钟（第 21 轮）一次；5 分钟内不重复");
  } finally {
    cleanupDir(dir);
  }
});

// ── 第 51 批修正轮：证明后的重读分支与单一出口 ──────────────────────────────

test("W-06: 证明成立、重读得到 reverify_pending → 继续等，不退出 3；结果落地收口 0", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg06";
    const { ref, events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    const failedRef = makeRef(runId, {
      verification: { status: "failed", failureCode: "command_failed", commands: [], verifiedCommit: DELIVERED, results: [] },
    });
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      if (reads === 1) return events;
      const failed = [...events, outcome(runId, "failed", failedRef), reverifyRequested(runId, failedRef)];
      if (reads === 2) return failed;
      return [...failed, reverifyOutcome(runId, failedRef, "passed")];
    };
    const r = await runWaitSettled({
      dir, runId,
      deps: { ...verifierProofDeps, readTranscriptFn },
    });
    assert.equal(r.exitCode, undefined, "reverify 落结果后收口退出 0");
    assert.ok(r.outLines.some((l) => l.includes("not settled (reverify_pending)")),
      `重读后的可信未收口形态照常打印: ${JSON.stringify(r.outLines)}`);
    assert.ok(!/verifier_gone|Stuck:/.test(r.out));
  } finally {
    cleanupDir(dir);
  }
});

test("W-07: 证明成立、重读无法判定（pending 验证 + reverify 事实）→ 不可信轮继续，不退出 3", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg07";
    const { ref, events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    const failedRef = makeRef(runId, {
      verification: { status: "failed", failureCode: "command_failed", commands: [], verifiedCommit: DELIVERED, results: [] },
    });
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      if (reads === 1) return events;
      // 重读：原始验证仍 pending 却已有 reverify 事实 → 无法判定（断链）。
      if (reads === 2) return [...events, reverifyRequested(runId, failedRef)];
      // 落盘：原始验证 failed + reverify 链走完 → 收口。
      return [
        ...events,
        outcome(runId, "failed", failedRef),
        reverifyRequested(runId, failedRef),
        reverifyOutcome(runId, failedRef, "passed"),
      ];
    };
    const r = await runWaitSettled({ dir, runId, deps: { ...verifierProofDeps, readTranscriptFn } });
    assert.equal(r.exitCode, undefined, "只有一轮不可信，随后收口退出 0");
    assert.ok(r.outLines.some((l) => l.includes("settlement undeterminable (delivery_facts_malformed)")),
      `重读的无法判定按既有规则记账: ${JSON.stringify(r.outLines)}`);
    assert.ok(!/verifier_gone|Stuck:/.test(r.out));
  } finally {
    cleanupDir(dir);
  }
});

test("W-08: 证明抛错 → 不构成死亡证明，继续等；结果落地收口 0", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg08";
    const { ref, events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    let reads = 0;
    let proofCalls = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      return reads === 1 ? events : [...events, outcome(runId, "passed", ref)];
    };
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        ...verifierProofDeps,
        readTranscriptFn,
        verifierGoneFn: async () => {
          proofCalls += 1;
          throw new Error("probe exploded");
        },
      },
    });
    assert.equal(r.exitCode, undefined, "证明抛错继续等，结果落地后收口");
    assert.equal(reads, 2);
    assert.equal(proofCalls, 1);
    assert.ok(r.outLines.some((l) => l.includes("not settled (verification_pending)")), "照常打未收口进度");
    assert.ok(!r.outLines.some((l) => l.includes("verifier proof:")), "抛错的证明不带拒收理由注脚");
  } finally {
    cleanupDir(dir);
  }
});

test("W-09: 证明期间 SIGINT → 单一出口 130，只输出一份中断结果", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg09";
    const { events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    const base = process.listenerCount("SIGINT");
    const r = await runWaitSettled({
      dir, runId, asJson: true,
      deps: {
        ...verifierProofDeps,
        verifierGoneFn: async () => {
          process.emit("SIGINT");
          return { gone: true, basis: "lease_missing" };
        },
      },
    });
    assert.equal(r.exitCode, 130, "证明期间置位的中断以 130 退出");
    assert.equal(r.outLines.length, 1, `只输出一份最终结果，实际: ${JSON.stringify(r.outLines)}`);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.interrupted, true);
    assert.equal(parsed.settled, false);
    assert.ok(!/verifier_gone|Stuck:/.test(r.out), "中断路径不出 verifier_gone 终行");
    assert.equal(process.listenerCount("SIGINT"), base, "SIGINT handler 注销（无泄漏）");
  } finally {
    cleanupDir(dir);
  }
});

test("W-10: 重读仍 pending、确认解析冲突 → 立即退出 4", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg10";
    const { events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    let calls = 0;
    const real = realResolver(dir);
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        ...verifierProofDeps,
        resolveDetailedFn: (rd, rid) => {
          calls += 1;
          if (calls === 3) return { path: null, found: false, conflict: true };
          return real(rd, rid);
        },
      },
    });
    assert.equal(r.exitCode, 4, "退出 3 前的确认解析冲突按冲突出口");
    assert.equal(calls, 3, "解析三次：首轮、重读前、退出前确认");
    assert.match(r.out, /multiple distinct transcript copies/);
  } finally {
    cleanupDir(dir);
  }
});

test("W-11: 重读仍 pending、确认时路径变了 → 不可信轮、不退出 3；随后收口 0", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg11";
    const { ref, events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    let reads = 0;
    let calls = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      // 读 1（首轮）与读 2（证明后的重读）都还是 verification_pending；读 3 起
      // 结果才落盘。
      return reads <= 2 ? events : [...events, outcome(runId, "passed", ref)];
    };
    const real = realResolver(dir);
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        ...verifierProofDeps,
        readTranscriptFn,
        resolveDetailedFn: (rd, rid) => {
          calls += 1;
          const res = real(rd, rid);
          if (calls === 3) return { ...res, path: `${res.path}.moved` };
          return res;
        },
      },
    });
    assert.equal(r.exitCode, undefined, "确认失败的轮算不可信轮，随后收口退出 0");
    assert.ok(r.outLines.some((l) => l.includes("verifier proven gone but transcript resolution changed")),
      `确认解析变化的进度行在场: ${JSON.stringify(r.outLines)}`);
    assert.ok(!/Stuck:/.test(r.out), "不退出 3");
  } finally {
    cleanupDir(dir);
  }
});

test("W-12: 重读仍 pending、确认时未找到 → 不可信轮、不退出 3；随后收口 0", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg12";
    const { ref, events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    let reads = 0;
    let calls = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      return reads <= 2 ? events : [...events, outcome(runId, "passed", ref)];
    };
    const real = realResolver(dir);
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        ...verifierProofDeps,
        readTranscriptFn,
        resolveDetailedFn: (rd, rid) => {
          calls += 1;
          if (calls === 3) return { path: null, found: false, conflict: false };
          return real(rd, rid);
        },
      },
    });
    assert.equal(r.exitCode, undefined);
    // 确认解析失败（未找到）与路径变化同一记账文本（镜像既有 settled 确认一支
    // 的统一说法），照不可信轮打印、不退出 3。
    assert.ok(r.outLines.some((l) => l.includes("verifier proven gone but transcript resolution changed; continuing (untrusted 1/4)")),
      `确认未找到按不可信轮记账: ${JSON.stringify(r.outLines)}`);
    assert.ok(!/Stuck:/.test(r.out));
  } finally {
    cleanupDir(dir);
  }
});

test("W-13: 重读后运行复活（非终态）→ 进度行的体征年龄用新快照", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg13";
    const { ref, events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    const freshTs = "2026-10-15T11:59:30.000Z";
    const revived = [
      ...events,
      { type: "run.state_change", runId, agentId: "coder_low", from: "completed", to: "running", reason: "evil_revival", ts: freshTs },
      { type: "run.event", runId, agentId: "coder_low", ts: freshTs, event: { type: "tool_use" } },
    ];
    const settledAgain = [
      ...revived,
      { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "completed", reason: "done", ts: freshTs },
      outcome(runId, "passed", ref),
    ];
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      if (reads === 1) return events;
      if (reads === 2) return revived;
      return settledAgain;
    };
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        ...verifierProofDeps,
        readTranscriptFn,
        nowFn: () => Date.parse("2026-10-15T12:00:00.000Z"),
      },
    });
    assert.equal(r.exitCode, undefined, "复活形态按新快照继续等、再收口退出 0");
    const progressLines = r.outLines.filter((l) => l.startsWith("[runs wait]"));
    assert.ok(progressLines.some((l) => l.includes("state=running not settled (not_terminal); last vital sign 0 min ago")),
      `体征取自重读的新快照（30s 前的 run.event），实际: ${JSON.stringify(progressLines)}`);
    assert.ok(!progressLines.some((l) => l.includes("vital sign age unknown")),
      "不能用首次快照算体征（首次快照无 run.event）");
  } finally {
    cleanupDir(dir);
  }
});

test("W-14: 证明被拒理由参与节流键——理由变了打印一行，不变按 5 分钟节流", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg14";
    const { ref, events } = verifierEvents(runId);
    writeLines(dir, runId, events);
    const clockBase = Date.parse("2026-10-15T12:00:00.000Z");
    let clock = clockBase;
    let proofCalls = 0;
    let reads = 0;
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        nowFn: () => clock,
        sleepFn: async () => { clock += 15000; },
        readTranscriptFn: async () => {
          reads += 1;
          return reads < 42 ? events : [...events, outcome(runId, "passed", ref)];
        },
        verifierGoneFn: async () => {
          proofCalls += 1;
          // 轮 1/21 同理由 owner_fresh；轮 41 换成 runner_scan_failed。
          return { gone: false, refusal: proofCalls <= 2 ? "owner_fresh" : "runner_scan_failed" };
        },
      },
    });
    assert.equal(r.exitCode, undefined, "第 42 轮结果落地后收口");
    const proofLines = r.outLines.filter((l) => l.includes("verifier proof:"));
    assert.equal(proofLines.length, 3, `轮 1（首打）、轮 21（5 分钟节流到期）、轮 41（理由变化），实际: ${JSON.stringify(r.outLines)}`);
    assert.match(proofLines[0], /verifier proof: owner_fresh/);
    assert.match(proofLines[1], /verifier proof: owner_fresh/);
    assert.match(proofLines[2], /verifier proof: runner_scan_failed/);
    assert.equal(proofCalls, 3, "证明仍按 5 分钟节流：轮 1/21/41");
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 83 批 B：等待器证明 runner 已不在（非终态轮；前置筛 = 最后一条绑定事件早于
// 15 分钟静默窗；节流 5 分钟；证明 = settleRun 只读干跑，六道门不复制）。
// ═══════════════════════════════════════════════════════════════════════════

// 非终态安静运行：pending + background_submitted（runner 在建会话前死亡的 settle
// 形状），事件 ts 固定在 PROOF_TS（距真实 now 天然超过 15 分钟静默窗）。
function runnerGoneEvents(runId) {
  return [
    { ...started(runId, { delivery: false }), ts: PROOF_TS },
    { type: "run.background_submitted", runId, agentId: "coder_low", background: true, ts: PROOF_TS },
  ];
}

// runner 证明的注入集：与 settle 同一套读器全桩（零真实进程/PowerShell；缺省
// 全"不在"→ settleRun 干跑 eligible）。settleRun 自己解析并读取转录（真文件）。
const runnerProofDeps = {
  runnerProofDeps: {
    ownerLeaseReader: () => ({ present: false }),
    identifyFn: async () => ({ verdict: "gone", basis: "pid_exited" }),
    runnerScanFn: async () => ({ alive: false }),
    handshakeReader: () => ({ present: false }),
    daemonAliveFn: () => false,
  },
};

test("R-01: 静默不足 15 分钟不证明——proof 零调用，照常等到收口", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_rg01";
    // 事件 ts 距注入 now 只有 5 分钟：前置筛（照 settle 门 4 的口径）不过。
    const base = Date.parse("2026-10-20T12:00:00.000Z");
    writeLines(dir, runId, [
      { ...started(runId, { delivery: false }), ts: new Date(base).toISOString() },
      { type: "run.background_submitted", runId, agentId: "coder_low", background: true, ts: new Date(base).toISOString() },
    ]);
    let appended = false;
    let proofCalls = 0;
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        nowFn: () => base + 5 * 60_000,
        runnerGoneFn: async () => { proofCalls += 1; return { gone: true }; },
        sleepFn: async () => {
          if (!appended) {
            appended = true;
            appendLines(dir, runId, [stateChange(runId, "completed")]);
          }
        },
      },
    });
    assert.equal(r.exitCode, undefined, "结果落地后照常收口退出 0");
    assert.equal(proofCalls, 0, "静默不足 15 分钟：一次证明都不发起");
  } finally {
    cleanupDir(dir);
  }
});

// B92 续修 5：等待器 quietDue 与门 4 同一取法（lastQuietWindowBoundMs）——最后
// 一条绑定事件是被拒的重打包审计（不算活动）、更早一条已满静默窗时，照样发起
// runner 缺席证明（证明用桩，不跑真实扫描）。
test("R-01b: 最后一条是被拒的重打包审计 → 照样发起 runner 缺席证明", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_rg01b";
    const base = Date.parse("2026-10-20T12:00:00.000Z");
    // 计入静默窗的最后一条是 base 的派发事实（距 now 20 分钟，已满窗）；其后
    // 1 分钟前追加被拒的重打包审计。
    writeLines(dir, runId, [
      { ...started(runId, { delivery: false }), ts: new Date(base).toISOString() },
      { type: "run.background_submitted", runId, agentId: "coder_low", background: true, ts: new Date(base).toISOString() },
      {
        type: "run.delivery_repackage_rejected", runId, agentId: "coder_low",
        rejectionReason: "lease_held", ts: new Date(base + 19 * 60_000).toISOString(),
      },
    ]);
    let proofCalls = 0;
    let appended = false;
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        nowFn: () => base + 20 * 60_000,
        runnerGoneFn: async () => { proofCalls += 1; return { gone: true }; },
        sleepFn: async () => {
          // 防挂兜底：若 quietDue 误读被拒审计为活动（证明没发起），下一轮补终态退出。
          if (!appended) {
            appended = true;
            appendLines(dir, runId, [stateChange(runId, "completed")]);
          }
        },
      },
    });
    assert.equal(r.exitCode, 3, "证明照常发起并成立 → runner_gone 退出 3");
    assert.equal(proofCalls, 1, "被拒审计不重置等待器的 15 分钟静默窗");
  } finally {
    cleanupDir(dir);
  }
});

test("R-02: 证明成立且重读仍非终态 → 退出 3（Run/Stuck/Runner stderr tail/Next step 四行终行）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_rg02";
    writeLines(dir, runId, runnerGoneEvents(runId));
    const r = await runWaitSettled({ dir, runId, deps: runnerProofDeps });
    assert.equal(r.exitCode, 3);
    // TD-341（第 89 批 C3）：Runner stderr tail 行插在 Stuck 与 Next step 之间。
    assert.equal(r.outLines.length, 4, `只输出四行终行，实际: ${JSON.stringify(r.outLines)}`);
    assert.equal(r.outLines[0], `Run: ${runId} (running)`);
    assert.equal(
      r.outLines[1],
      `Stuck: the runner of ${runId} is gone (no live owner heartbeat, no process that could still drive it); waiting will not change this.`,
    );
    assert.equal(r.outLines[2], "Runner stderr tail: 无 runner stderr 记录", "无文件时写明无记录");
    assert.match(r.outLines[3], new RegExp(`^Next step: Nothing on this machine can still drive this run\\. The exits are wao runs settle --run-id ${runId} --reason-file <FILE>`));
    assert.match(r.outLines[3], /or wao stop — only on an explicit Lead decision\./);
    assert.match(r.outLines[3], /uncommitted changes may still be in the worktree: inspect them before deciding\.$/);
    assert.ok(!r.outLines.some((l) => l.startsWith("[runs wait]")), "证明成立即退：不打印未收口进度行");
  } finally {
    cleanupDir(dir);
  }
});

test("R-02b: JSON 模式——{settled,runId,state,reason,nextStep}，进度不上 stdout", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_rg02b";
    writeLines(dir, runId, runnerGoneEvents(runId));
    const r = await runWaitSettled({ dir, runId, asJson: true, deps: runnerProofDeps });
    assert.equal(r.exitCode, 3);
    assert.equal(r.outLines.length, 1, "stdout 只留最终 JSON");
    const parsed = JSON.parse(r.out);
    // TD-341（第 89 批 C3）：+ runnerStderrTail（展示处理后的尾部；无文件时为"无 runner stderr 记录"）。
    assert.deepEqual(Object.keys(parsed).sort(), ["nextStep", "reason", "runId", "runnerStderrTail", "settled", "state"]);
    assert.equal(parsed.settled, false);
    assert.equal(parsed.runId, runId);
    assert.equal(parsed.state, "running");
    assert.equal(parsed.reason, "runner_gone");
    assert.equal(parsed.runnerStderrTail, "无 runner stderr 记录", "无文件时写明无记录");
    assert.equal(typeof parsed.nextStep, "string");
  } finally {
    cleanupDir(dir);
  }
});

test("R-03: 证明成立但重读时已收口 → 照常退出 0，不报 runner_gone", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_rg03";
    writeLines(dir, runId, runnerGoneEvents(runId));
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      if (reads === 1) return runnerGoneEvents(runId);
      return [...runnerGoneEvents(runId), stateChange(runId, "completed")];
    };
    const r = await runWaitSettled({ dir, runId, deps: { ...runnerProofDeps, readTranscriptFn } });
    assert.equal(r.exitCode, undefined, "重读已收口 → 退出 0");
    assert.equal(reads, 2, "一轮正常读 + 证明后一次重读");
    assert.match(r.out, /Settlement: settled \(no_delivery_requested\)/);
    assert.ok(!/runner_gone|Stuck: the runner/.test(r.out), "不出现 runner_gone 输出");
  } finally {
    cleanupDir(dir);
  }
});

test("R-04: 心跳新鲜挡下证明 → 照常等待，owner_fresh 理由进进度行（前置筛路径）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_rg04";
    writeLines(dir, runId, runnerGoneEvents(runId));
    // 二轮续修 4：心跳新鲜由**前置筛选**读真实 .owner 文件挡下（ownerLiveness 现有
    // 读法）——本该发证明的那轮不发证明、不扫进程，但拒绝理由按 settle 门 2 的
    // 闭集标签 owner_fresh 进进度行注脚（相对 061d565d 的可见行为保住）。
    writeFileSync(join(dir, `.owner-${runId}`), JSON.stringify({ pid: process.pid, heartbeatAt: Date.now() }), "utf8");
    let proofCalls = 0;
    let appended = false;
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        runnerGoneFn: async () => { proofCalls += 1; return { gone: true }; },
        sleepFn: async () => {
          if (!appended) {
            appended = true;
            appendLines(dir, runId, [stateChange(runId, "completed")]);
          }
        },
      },
    });
    assert.equal(r.exitCode, undefined, "证明不发起 → 继续等，结果落地后退出 0");
    assert.equal(proofCalls, 0, "证明桩一次都没被调（前置筛挡下，不扫进程）");
    assert.ok(r.outLines.some((l) => l.includes("not settled (not_terminal)")), "照常打未收口进度");
    assert.ok(r.outLines.some((l) => l.includes("runner proof: owner_fresh")), "owner_fresh 理由进进度行明细");
    assert.ok(!/runner_gone|Stuck: the runner/.test(r.out), "不输出 runner_gone");
  } finally {
    cleanupDir(dir);
  }
});

test("R-05: 节流——同一等待器两次 runner 证明至少间隔 5 分钟（时钟注入）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_rg05";
    const clockBase = Date.parse("2026-10-15T12:00:00.000Z");
    // 事件 ts 早于注入钟 20 分钟：从第 1 轮起前置筛就过。
    const events = runnerGoneEvents(runId).map((e) => ({ ...e, ts: new Date(clockBase - 20 * 60_000).toISOString() }));
    writeLines(dir, runId, events);
    let clock = clockBase;
    let proofCalls = 0;
    let reads = 0;
    const r = await runWaitSettled({
      dir, runId,
      deps: {
        nowFn: () => clock,
        sleepFn: async () => { clock += 15000; },
        readTranscriptFn: async () => {
          reads += 1;
          return reads < 26 ? events : [...events, stateChange(runId, "completed")];
        },
        runnerGoneFn: async () => {
          proofCalls += 1;
          return { gone: false, refusal: "runner_alive" };
        },
      },
    });
    assert.equal(r.exitCode, undefined, "第 26 轮结果落地后收口");
    assert.equal(reads, 26);
    assert.equal(proofCalls, 2, "首轮一次 + 满 5 分钟（第 21 轮）一次；5 分钟内不重复");
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 决定 0112：收口终行的可续提示——delivery_settled、未采纳、且同一份快照判定为
// continuable 谱系成员时，终行/JSON 的 nextStep 用 delivery_continuable（CLI 面，
// 写 `wao runs continue`）；否则照旧 settled_line。
// ═══════════════════════════════════════════════════════════════════════════

function lineageFirst(runId) {
  return { type: "run.session_reuse", runId, agentId: "coder_low", mode: "run_lineage", turn: "first", rootRunId: runId };
}

function lineageResume(runId, rootRunId) {
  return { type: "run.session_reuse", runId, agentId: "coder_low", mode: "run_lineage", turn: "resume", rootRunId };
}

// 续跑谱系的根转录（闭态检查与 --since-parent 同款的父边读取都读它）：根自己
// 带 turn:first 的谱系事实（与真实的首轮可续派发同形）；closed 时带 bound
// run.lineage_closed。
function seedRootLines(dir, rootRunId, { closed = false } = {}) {
  writeLines(dir, rootRunId, [
    { type: "run.started", runId: rootRunId, agentId: "coder_low", backend: "claude-code", cwd: "D:/fake/ws" },
    lineageFirst(rootRunId),
    ...(closed ? [{ type: "run.lineage_closed", runId: rootRunId, agentId: "coder_low", rootRunId, reason: "lead closed", reasonSha256: "0".repeat(64) }] : []),
  ]);
}

test("U-12: 可续未决定交付收口 → 终行与 JSON 的 nextStep 用 delivery_continuable", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u12";
    const ref = makeRef(runId);
    writeLines(dir, runId, [
      started(runId),
      lineageFirst(runId),
      created(runId, ref),
      stateChange(runId, "completed"),
      outcome(runId, "passed", ref),
    ]);
    const r = await runWaitSettled({ dir, runId });
    assert.equal(r.exitCode, undefined, "收口退出 0");
    assert.equal(r.outLines.length, 4, `终行四行，实际: ${JSON.stringify(r.outLines)}`);
    assert.equal(r.outLines[0], `Run: ${runId} (completed)`);
    assert.equal(r.outLines[1], "Settlement: settled (delivery_settled; verification passed)");
    // 第 136 批：交付要点一行（谱系根是自己，不是续修——没有 Land 句）。
    assert.equal(r.outLines[2], `Delivery: ${"d".repeat(12)} on ${"b".repeat(12)}, 1 file(s): src/a.js`);
    assert.equal(
      r.outLines[3],
      // 第 137a 批：CLI 面的续修提示写 CLI 命令 wao runs continue（不再点名 MCP 工具）。
      `Next step: Settled. Delivery awaits the Lead's review: wao runs delivery review ${runId} --all. Its lineage was dispatched continuable: for a narrow fix, wao runs continue ${runId} --prompt-file <FILE> can resume the same worker conversation; it checks eligibility first. An accepted delivery cannot be continued. Verification passed is not acceptance.`,
    );
    // JSON 面：键序 {settled,runId,state,settlement,delivery,nextStep}，nextStep 同款。
    const j = await runWaitSettled({ dir, runId, asJson: true });
    assert.equal(j.exitCode, undefined);
    const parsed = JSON.parse(j.out);
    assert.deepEqual(Object.keys(parsed), ["settled", "runId", "state", "settlement", "delivery", "nextStep"]);
    assert.deepEqual(parsed.delivery, {
      deliveryCommit: DELIVERED, baseCommit: BASE, changedFileCount: 1, changedPaths: ["src/a.js"],
    });
    assert.equal(parsed.settlement.reason, "delivery_settled");
    assert.match(parsed.nextStep, new RegExp(`wao runs continue ${runId} --prompt-file <FILE> can resume the same worker conversation`));
    assert.match(parsed.nextStep, /An accepted delivery cannot be continued\. Verification passed is not acceptance\.$/);
  } finally {
    cleanupDir(dir);
  }
});

function continuationFact(runId, parentRunId, rootRunId) {
  return {
    type: "run.background_submitted", runId, agentId: "coder_low",
    background: true, continuation: true, parentRunId, rootRunId,
  };
}

function acceptedDecision(runId, ref) {
  return {
    type: "run.delivery_accepted", runId, agentId: "coder_low",
    delivery: {
      ...ref,
      verification: { status: "passed", commands: [], verifiedCommit: ref.deliveryCommit, results: [] },
      acceptance: { status: "accepted", reviewerType: "lead_agent" },
    },
    deliveryCommit: ref.deliveryCommit,
    reason: "ok",
  };
}

test("U-15: 收口交付已有被采纳的后代（第 120 批派生被取代）→ 终行说无需裁决，不给续修提示", async () => {
  const dir = makeRunDir();
  const ROOT = "run_u15_root";
  const CHILD = "run_u15_child";
  try {
    const refRoot = makeRef(ROOT);
    writeLines(dir, ROOT, [
      started(ROOT),
      lineageFirst(ROOT),
      created(ROOT, refRoot),
      stateChange(ROOT, "completed"),
      outcome(ROOT, "passed", refRoot),
    ]);
    const refChild = makeRef(CHILD);
    writeLines(dir, CHILD, [
      { ...continuationFact(CHILD, ROOT, ROOT) },
      lineageResume(CHILD, ROOT),
      started(CHILD),
      created(CHILD, refChild),
      stateChange(CHILD, "completed"),
      outcome(CHILD, "passed", refChild),
      acceptedDecision(CHILD, refChild),
    ]);
    const r = await runWaitSettled({ dir, runId: ROOT });
    assert.equal(r.exitCode, undefined, "收口退出 0");
    assert.equal(r.outLines.length, 4, `终行四行，实际: ${JSON.stringify(r.outLines)}`);
    assert.equal(r.outLines[1], "Settlement: settled (delivery_settled; verification passed)");
    // 第 136 批：被取代的交付照旧给交付要点（事实仍在），只是不给续修提示。
    assert.equal(r.outLines[2], `Delivery: ${"d".repeat(12)} on ${"b".repeat(12)}, 1 file(s): src/a.js`);
    assert.equal(
      r.outLines[3],
      `Next step: Settled. A descendant of this run was already accepted (${CHILD}); no Lead decision is needed here.`,
    );
    assert.ok(!r.outLines[3].includes("awaits the Lead's review"), "不再说等 Lead 裁决");
    // 续修 1：CLI 面的续修提示写的是 `wao runs continue`——只查旧工具名会让这条
    // 断言空转（提示给了也红不了），两种写法都不得出现。
    assert.ok(!/run_continue|wao runs continue/.test(r.outLines[3]), "不给续修提示");
    // JSON 面：nextStep 同款，delivery 对象照给。
    const j = await runWaitSettled({ dir, runId: ROOT, asJson: true });
    assert.equal(j.exitCode, undefined);
    const parsed = JSON.parse(j.out);
    assert.deepEqual(Object.keys(parsed).sort(), ["delivery", "nextStep", "runId", "settled", "settlement", "state"]);
    assert.equal(parsed.nextStep,
      `Settled. A descendant of this run was already accepted (${CHILD}); no Lead decision is needed here.`);
  } finally {
    cleanupDir(dir);
  }
});

test("U-13: 无谱系事件的普通交付收口 → 照旧 settled_line（负例）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u13";
    const ref = makeRef(runId);
    writeLines(dir, runId, [
      started(runId),
      created(runId, ref),
      stateChange(runId, "completed"),
      outcome(runId, "passed", ref),
    ]);
    const r = await runWaitSettled({ dir, runId });
    assert.equal(r.exitCode, undefined);
    assert.equal(r.outLines.length, 4, `终行四行，实际: ${JSON.stringify(r.outLines)}`);
    assert.equal(r.outLines[2], `Delivery: ${"d".repeat(12)} on ${"b".repeat(12)}, 1 file(s): src/a.js`);
    assert.equal(
      r.outLines[3],
      `Next step: Settled. Delivery awaits the Lead's review: wao runs delivery review ${runId} --all. Verification passed is not acceptance.`,
      "无可续谱系事实 → settled_line 模板（审查命令一次读完）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("U-14: 续跑子运行（turn:resume，根是另一运行）——根转录开着 → 可续终行", async () => {
  const dir = makeRunDir();
  try {
    const ROOT = "run_u14_root";
    const runId = "run_u14_child";
    const ref = makeRef(runId);
    seedRootLines(dir, ROOT, { closed: false });
    // 真实的续修子运行：首条事件是续修事实（runContinue 在 spawn 之前写它）。
    writeLines(dir, runId, [
      continuationFact(runId, ROOT, ROOT),
      lineageResume(runId, ROOT),
      started(runId),
      created(runId, ref),
      stateChange(runId, "completed"),
      outcome(runId, "passed", ref),
    ]);
    const r = await runWaitSettled({ dir, runId });
    assert.equal(r.exitCode, undefined, "收口退出 0");
    assert.equal(r.outLines.length, 5, `终行五行，实际: ${JSON.stringify(r.outLines)}`);
    assert.equal(r.outLines[2], `Delivery: ${"d".repeat(12)} on ${"b".repeat(12)}, 1 file(s): src/a.js`);
    // 第 136 批：续修子交付的提交建在谱系基线上、带累积树——写明落地方式。
    assert.equal(
      r.outLines[3],
      `Land: cumulative tree on the lineage base ${"b".repeat(12)}; fast-forward or merge from the base, not from the parent delivery.`,
    );
    assert.match(
      r.outLines[4],
      new RegExp(`^Next step: Settled\\. Delivery awaits the Lead's review: wao runs delivery review ${runId} --all\\. Its lineage was dispatched continuable: for a narrow fix, wao runs continue ${runId} --prompt-file <FILE> can resume the same worker conversation`),
      "子运行经根转录判未闭合 → 给可续提示（谱系措辞）",
    );
  } finally {
    cleanupDir(dir);
  }
});

test("U-15: 续跑子运行——根转录已闭合 → 照旧 settled_line（负例）", async () => {
  const dir = makeRunDir();
  try {
    const ROOT = "run_u15_root";
    const runId = "run_u15_child";
    const ref = makeRef(runId);
    seedRootLines(dir, ROOT, { closed: true });
    writeLines(dir, runId, [
      continuationFact(runId, ROOT, ROOT),
      lineageResume(runId, ROOT),
      started(runId),
      created(runId, ref),
      stateChange(runId, "completed"),
      outcome(runId, "passed", ref),
    ]);
    const r = await runWaitSettled({ dir, runId });
    assert.equal(r.exitCode, undefined);
    assert.equal(r.outLines.length, 5, `终行五行，实际: ${JSON.stringify(r.outLines)}`);
    // 根已闭合：不给续修提示；但仍是续修子交付——落地方式照给。
    assert.equal(
      r.outLines[3],
      `Land: cumulative tree on the lineage base ${"b".repeat(12)}; fast-forward or merge from the base, not from the parent delivery.`,
    );
    assert.equal(
      r.outLines[4],
      `Next step: Settled. Delivery awaits the Lead's review: wao runs delivery review ${runId} --all. Verification passed is not acceptance.`,
      "根已闭合 → settled_line 模板（审查命令一次读完）",
    );
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 136 批：收口终行带交付要点。delivery_settled 时只从等待器已读到的同一份
// 快照投影——不另读；文本多一行 Delivery（提交号与基线各前 12 位、文件总数、
// 前 3 个路径，超出写"…"），JSON 多一个 delivery 对象。路径经与 MCP run_delivery
// 同一个有界安全投影与同一个环境密钥值脱敏；投影不成立只是不带这一行，收口
// 判定与退出码不受影响。
// ═══════════════════════════════════════════════════════════════════════════

const U16_BASE = "0123456789abcdef0123456789abcdef01234567";
const U16_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const U16_FILES = [
  "SKILL.md",
  "docs/usage/supervise.md",
  "src/application/runNextStep.js",
  "src/commands/runs.js",
  "test/run-lifecycle/runsWaitUntilSettled.test.js",
];

function settledDeliveryEvents(runId, ref) {
  return [started(runId), created(runId, ref), stateChange(runId, "completed"), outcome(runId, "passed", ref)];
}

// 换提交号的夹具：created 载荷里的 verifiedCommit 必须与交付提交号一致，否则交付
// 事实校验判 malformed（与真实的打包事实同形）。
function makeRefAt(runId, commit, over = {}) {
  const ref = makeRef(runId, { baseCommit: U16_BASE, deliveryCommit: commit, ...over });
  return { ...ref, verification: { ...ref.verification, verifiedCommit: commit } };
}

test("U-16: 普通交付（5 个文件）收口 → Delivery 行列前 3 个路径加省略号与总数；JSON delivery 只带前 3 个；快照只读一次", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u16";
    const ref = makeRefAt(runId, U16_COMMIT, { changedFiles: U16_FILES });
    writeLines(dir, runId, settledDeliveryEvents(runId, ref));
    let reads = 0;
    const readTranscriptFn = async (path) => {
      reads += 1;
      return readTranscript(path);
    };
    const r = await runWaitSettled({ dir, runId, deps: { readTranscriptFn } });
    assert.equal(r.exitCode, undefined, "收口退出 0");
    assert.deepEqual(r.outLines, [
      `Run: ${runId} (completed)`,
      "Settlement: settled (delivery_settled; verification passed)",
      `Delivery: ${U16_COMMIT.slice(0, 12)} on ${U16_BASE.slice(0, 12)}, 5 file(s): ${U16_FILES.slice(0, 3).join(", ")}…`,
      `Next step: Settled. Delivery awaits the Lead's review: wao runs delivery review ${runId} --all. Verification passed is not acceptance.`,
    ]);
    assert.equal(reads, 1, "交付要点取自等待器已读到的同一份快照，不另读");
    const j = await runWaitSettled({ dir, runId, asJson: true });
    const parsed = JSON.parse(j.out);
    assert.deepEqual(Object.keys(parsed), ["settled", "runId", "state", "settlement", "delivery", "nextStep"]);
    assert.deepEqual(parsed.delivery, {
      deliveryCommit: U16_COMMIT, baseCommit: U16_BASE, changedFileCount: 5, changedPaths: U16_FILES.slice(0, 3),
    });
    assert.ok(!("land" in parsed), "普通运行（谱系根是自己）不带 land");
  } finally {
    cleanupDir(dir);
  }
});

test("U-17: 文件数不超过 3 → 路径全列、不加省略号", async () => {
  const dir = makeRunDir();
  try {
    const one = "run_u17one";
    const refOne = makeRefAt(one, U16_COMMIT, { changedFiles: ["docs/a.md"] });
    writeLines(dir, one, settledDeliveryEvents(one, refOne));
    const r1 = await runWaitSettled({ dir, runId: one });
    assert.equal(r1.outLines[2], `Delivery: ${U16_COMMIT.slice(0, 12)} on ${U16_BASE.slice(0, 12)}, 1 file(s): docs/a.md`);
    const three = "run_u17three";
    const files = ["docs/b.md", "docs/c.md", "src/d.js"];
    const refThree = makeRefAt(three, U16_COMMIT, { changedFiles: files });
    writeLines(dir, three, settledDeliveryEvents(three, refThree));
    const r3 = await runWaitSettled({ dir, runId: three });
    assert.equal(r3.outLines[2], `Delivery: ${U16_COMMIT.slice(0, 12)} on ${U16_BASE.slice(0, 12)}, 3 file(s): ${files.join(", ")}`);
  } finally {
    cleanupDir(dir);
  }
});

test("U-18: 路径命中环境密钥值 → 整条路径折成 [REDACTED]（与 MCP run_delivery 同一脱敏）", async () => {
  const dir = makeRunDir();
  const secretPath = "src/qa1w2e3r4t5y6u7i8.js";
  const envName = "U18_API_TOKEN";
  const prev = process.env[envName];
  process.env[envName] = secretPath;
  try {
    const runId = "run_u18";
    const ref = makeRef(runId, { changedFiles: ["docs/a.md", secretPath] });
    writeLines(dir, runId, settledDeliveryEvents(runId, ref));
    const r = await runWaitSettled({ dir, runId });
    assert.equal(r.outLines[2], `Delivery: ${"d".repeat(12)} on ${"b".repeat(12)}, 2 file(s): docs/a.md, [REDACTED]`);
    const j = await runWaitSettled({ dir, runId, asJson: true });
    assert.deepEqual(JSON.parse(j.out).delivery.changedPaths, ["docs/a.md", "[REDACTED]"]);
  } finally {
    if (prev === undefined) delete process.env[envName];
    else process.env[envName] = prev;
    cleanupDir(dir);
  }
});

test("U-19: 交付载荷的路径不合规（越界路径 / 未排序）→ 不带 Delivery 行与 delivery 键；收口与退出码不变", async () => {
  for (const [label, changedFiles] of [["traversal", ["../escape.js"]], ["unsorted", ["src/b.js", "src/a.js"]]]) {
    const dir = makeRunDir();
    try {
      const runId = `run_u19_${label}`;
      const ref = makeRef(runId, { changedFiles });
      writeLines(dir, runId, settledDeliveryEvents(runId, ref));
      const r = await runWaitSettled({ dir, runId });
      assert.equal(r.exitCode, undefined, `${label}：收口判定不受投影影响`);
      assert.deepEqual(r.outLines, [
        `Run: ${runId} (completed)`,
        "Settlement: settled (delivery_settled; verification passed)",
        `Next step: Settled. Delivery awaits the Lead's review: wao runs delivery review ${runId} --all. Verification passed is not acceptance.`,
      ]);
      const j = await runWaitSettled({ dir, runId, asJson: true });
      const parsed = JSON.parse(j.out);
      assert.ok(!("delivery" in parsed) && !("land" in parsed), `${label}：不带 delivery/land 键`);
    } finally {
      cleanupDir(dir);
    }
  }
});

test("U-20: 没有交付的收口（打包失败）→ 不带 Delivery 行与 delivery 键", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_u20";
    writeLines(dir, runId, [
      started(runId),
      { type: "run.delivery_failed", runId, agentId: "coder_low", deliveryCode: "disallowed_path", message: "changes outside allowedPaths" },
      stateChange(runId, "failed"),
    ]);
    const r = await runWaitSettled({ dir, runId });
    assert.equal(r.exitCode, undefined);
    assert.equal(r.outLines.length, 3);
    assert.equal(r.outLines[1], "Settlement: settled (packaging_failed)");
    const j = await runWaitSettled({ dir, runId, asJson: true });
    const parsed = JSON.parse(j.out);
    assert.deepEqual(Object.keys(parsed), ["settled", "runId", "state", "settlement", "nextStep"]);
  } finally {
    cleanupDir(dir);
  }
});

function rejectedDecision(runId, ref) {
  return {
    type: "run.delivery_rejected", runId, agentId: "coder_low",
    delivery: {
      ...ref,
      verification: { status: "passed", commands: [], verifiedCommit: ref.deliveryCommit, results: [] },
      acceptance: { status: "rejected", reviewerType: "lead_agent" },
    },
    deliveryCommit: ref.deliveryCommit,
    reason: "not good enough",
  };
}

// 一条谱系的根：continuable、交付未裁决。
function seedContinuableRoot(dir, rootRunId) {
  const ref = makeRef(rootRunId);
  writeLines(dir, rootRunId, [
    started(rootRunId),
    lineageFirst(rootRunId),
    created(rootRunId, ref),
    stateChange(rootRunId, "completed"),
    outcome(rootRunId, "passed", ref),
  ]);
}

test("U-21: 续修子交付的 Land 句只在交付还能落地时给——未裁决/已采纳照给；已拒收、已有被采纳的后代不给", async () => {
  const dir = makeRunDir();
  const landLine = `Land: cumulative tree on the lineage base ${"b".repeat(12)}; fast-forward or merge from the base, not from the parent delivery.`;
  try {
    // 未裁决的子交付：已在 U-14 钉住（Land 在 Delivery 之后、Next step 之前）。
    // 已采纳的子交付：照给——Lead 接下来就要落地它。
    {
      const ROOT = "run_u21_roota";
      const CHILD = "run_u21_acc";
      const ref = makeRef(CHILD);
      seedContinuableRoot(dir, ROOT);
      writeLines(dir, CHILD, [
        continuationFact(CHILD, ROOT, ROOT),
        lineageResume(CHILD, ROOT),
        started(CHILD),
        created(CHILD, ref),
        stateChange(CHILD, "completed"),
        outcome(CHILD, "passed", ref),
        acceptedDecision(CHILD, ref),
      ]);
      const r = await runWaitSettled({ dir, runId: CHILD });
      assert.equal(r.exitCode, undefined);
      assert.deepEqual(r.outLines.slice(2), [
        `Delivery: ${"d".repeat(12)} on ${"b".repeat(12)}, 1 file(s): src/a.js`,
        landLine,
        "Next step: Settled. The Lead decision is recorded: accepted. Verification passed is not acceptance.",
      ]);
      const j = await runWaitSettled({ dir, runId: CHILD, asJson: true });
      const parsed = JSON.parse(j.out);
      assert.deepEqual(Object.keys(parsed), ["settled", "runId", "state", "settlement", "delivery", "land", "nextStep"]);
      assert.equal(parsed.land, landLine.slice("Land: ".length));
    }
    // 已拒收的子交付：不会落地，不给。
    {
      const ROOT = "run_u21_rootb";
      const CHILD = "run_u21_rej";
      const ref = makeRef(CHILD);
      seedContinuableRoot(dir, ROOT);
      writeLines(dir, CHILD, [
        continuationFact(CHILD, ROOT, ROOT),
        lineageResume(CHILD, ROOT),
        started(CHILD),
        created(CHILD, ref),
        stateChange(CHILD, "completed"),
        outcome(CHILD, "passed", ref),
        rejectedDecision(CHILD, ref),
      ]);
      const r = await runWaitSettled({ dir, runId: CHILD });
      assert.equal(r.exitCode, undefined);
      assert.equal(r.outLines.length, 4, `已拒收：没有 Land 行，实际: ${JSON.stringify(r.outLines)}`);
      assert.match(r.outLines[3], /^Next step: Settled\. The Lead decision is recorded: rejected\./);
      const j = await runWaitSettled({ dir, runId: CHILD, asJson: true });
      assert.ok(!("land" in JSON.parse(j.out)), "已拒收：JSON 不带 land");
    }
    // 已有被采纳后代的子交付：谱系只落地最终候选，不给。
    {
      const ROOT = "run_u21_rootc";
      const MID = "run_u21_mid";
      const GRAND = "run_u21_grand";
      const refMid = makeRef(MID);
      const refGrand = makeRef(GRAND);
      seedContinuableRoot(dir, ROOT);
      writeLines(dir, MID, [
        continuationFact(MID, ROOT, ROOT),
        lineageResume(MID, ROOT),
        started(MID),
        created(MID, refMid),
        stateChange(MID, "completed"),
        outcome(MID, "passed", refMid),
      ]);
      writeLines(dir, GRAND, [
        continuationFact(GRAND, MID, ROOT),
        lineageResume(GRAND, ROOT),
        started(GRAND),
        created(GRAND, refGrand),
        stateChange(GRAND, "completed"),
        outcome(GRAND, "passed", refGrand),
        acceptedDecision(GRAND, refGrand),
      ]);
      const r = await runWaitSettled({ dir, runId: MID });
      assert.equal(r.exitCode, undefined);
      assert.equal(r.outLines.length, 4, `被取代：没有 Land 行，实际: ${JSON.stringify(r.outLines)}`);
      assert.equal(r.outLines[3], `Next step: Settled. A descendant of this run was already accepted (${GRAND}); no Lead decision is needed here.`);
      const j = await runWaitSettled({ dir, runId: MID, asJson: true });
      assert.ok(!("land" in JSON.parse(j.out)), "被取代：JSON 不带 land");
    }
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 136 批续修（会审 sol 的复现）：Land 的谱系判断与 --since-parent（决定 0116）
// 同一份读取——只认转录第一条续修事实，尾补的声明不算；Land 只依赖谱系事实与
// 交付基线，路径投影不成立时照样给。路径里的 Unicode 行分隔符按控制字符同样
// 拒绝。收口 JSON 的路径键与 MCP run_delivery 同名（changedPaths）。
// ═══════════════════════════════════════════════════════════════════════════

const LAND_LINE = `Land: cumulative tree on the lineage base ${"b".repeat(12)}; fast-forward or merge from the base, not from the parent delivery.`;

// 真实的续修子交付：首条事件是续修事实（runContinue 在 spawn 之前写它）、谱系
// 事实与它一致、根转录可读——--since-parent 的父边读取在这份转录上成立。
function continuationChildLines(runId, rootRunId, ref) {
  return [
    continuationFact(runId, rootRunId, rootRunId),
    lineageResume(runId, rootRunId),
    started(runId),
    created(runId, ref),
    stateChange(runId, "completed"),
    outcome(runId, "passed", ref),
  ];
}

test("U-22: Land 的谱系判断与 --since-parent 同一口径——尾补的续修声明、没有首条续修事实的续跑，都不出 Land", async () => {
  const dir = makeRunDir();
  try {
    // (a) 根运行：快照尾部追加一条绑定同一 run、声明另一个谱系根的续修事实。
    //     --since-parent 拒绝这种尾补事实（续修事实必须是转录第一条事件）。
    const ROOT = "run_u22_root";
    const OTHER = "run_u22_other";
    const refRoot = makeRef(ROOT);
    writeLines(dir, ROOT, [
      started(ROOT),
      lineageFirst(ROOT),
      created(ROOT, refRoot),
      stateChange(ROOT, "completed"),
      outcome(ROOT, "passed", refRoot),
      { type: "run.background_submitted", runId: ROOT, agentId: "coder_low", background: true, continuation: true, parentRunId: OTHER, rootRunId: OTHER },
    ]);
    const a = await runWaitSettled({ dir, runId: ROOT });
    assert.equal(a.exitCode, undefined, "收口退出 0");
    assert.equal(a.outLines.length, 4, `不出 Land 行，实际: ${JSON.stringify(a.outLines)}`);
    assert.equal(a.outLines[2], `Delivery: ${"d".repeat(12)} on ${"b".repeat(12)}, 1 file(s): src/a.js`, "交付要点照给");
    assert.match(a.outLines[3], /^Next step: /);
    const ap = JSON.parse((await runWaitSettled({ dir, runId: ROOT, asJson: true })).out);
    assert.ok(!("land" in ap), "尾补谱系声明 → JSON 不带 land");
    assert.deepEqual(ap.delivery, { deliveryCommit: DELIVERED, baseCommit: BASE, changedFileCount: 1, changedPaths: ["src/a.js"] });

    // (b) 只有 turn:resume 的谱系事实、没有首条续修事实（--since-parent 判"没有父运行"）。
    const ROOT2 = "run_u22_root2";
    const CHILD = "run_u22_child";
    const refChild = makeRef(CHILD);
    seedRootLines(dir, ROOT2, { closed: false });
    writeLines(dir, CHILD, [
      started(CHILD),
      lineageResume(CHILD, ROOT2),
      created(CHILD, refChild),
      stateChange(CHILD, "completed"),
      outcome(CHILD, "passed", refChild),
    ]);
    const b = await runWaitSettled({ dir, runId: CHILD });
    assert.equal(b.exitCode, undefined);
    assert.ok(!b.outLines.some((l) => l.startsWith("Land:")), `没有首条续修事实 → 不出 Land，实际: ${JSON.stringify(b.outLines)}`);
  } finally {
    cleanupDir(dir);
  }
});

test("U-23: 真正的续修子交付带一个坏路径 → 路径投影不成立：不出 Delivery 行，Land 照样给", async () => {
  const dir = makeRunDir();
  try {
    const ROOT = "run_u23_root";
    const CHILD = "run_u23_child";
    const ref = makeRef(CHILD, { changedFiles: ["../escape.js", "src/b.js"] });
    seedRootLines(dir, ROOT, { closed: false });
    writeLines(dir, CHILD, continuationChildLines(CHILD, ROOT, ref));
    const r = await runWaitSettled({ dir, runId: CHILD });
    assert.equal(r.exitCode, undefined, "收口退出 0");
    assert.deepEqual(r.outLines, [
      `Run: ${CHILD} (completed)`,
      "Settlement: settled (delivery_settled; verification passed)",
      LAND_LINE,
      `Next step: Settled. Delivery awaits the Lead's review: wao runs delivery review ${CHILD} --all. Its lineage was dispatched continuable: for a narrow fix, wao runs continue ${CHILD} --prompt-file <FILE> can resume the same worker conversation; it checks eligibility first. An accepted delivery cannot be continued. Verification passed is not acceptance.`,
    ]);
    const parsed = JSON.parse((await runWaitSettled({ dir, runId: CHILD, asJson: true })).out);
    assert.deepEqual(Object.keys(parsed), ["settled", "runId", "state", "settlement", "land", "nextStep"], "没有 delivery 键，land 照给");
    assert.equal(parsed.land, LAND_LINE.slice("Land: ".length));
  } finally {
    cleanupDir(dir);
  }
});

test("U-24: 76 字符的可续 runId → CLI 收口行不触顶（改动前触顶于 70，改审查命令后一度降到 64）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_" + "y".repeat(72);
    assert.equal(runId.length, 76);
    const ref = makeRef(runId);
    writeLines(dir, runId, [started(runId), lineageFirst(runId), created(runId, ref), stateChange(runId, "completed"), outcome(runId, "passed", ref)]);
    const r = await runWaitSettled({ dir, runId });
    assert.equal(r.exitCode, undefined, "交付已收口——收口行不能抛错");
    assert.equal(r.outLines.length, 4, `实际: ${JSON.stringify(r.outLines)}`);
    const nextLine = r.outLines[3];
    assert.ok(nextLine.startsWith("Next step: "));
    assert.ok(nextLine.length - "Next step: ".length <= 480, `整句 ${nextLine.length - "Next step: ".length} ≤ 480`);
    assert.match(nextLine, new RegExp(`wao runs delivery review ${runId} --all\\.`));
  } finally {
    cleanupDir(dir);
  }
});

test("U-25: 路径含 Unicode 行分隔符 → 文本行可见转义、不断行，JSON 保留原路径；C1 的 U+0085 照旧不出 Delivery 行", async () => {
  for (const [label, sep, escaped] of [["U2028", "\u2028", "\\u2028"], ["U2029", "\u2029", "\\u2029"]]) {
    const dir = makeRunDir();
    try {
      const runId = `run_u25_${label}`;
      const ref = makeRef(runId, { changedFiles: [`src/a${sep}b.js`] });
      writeLines(dir, runId, settledDeliveryEvents(runId, ref));
      const r = await runWaitSettled({ dir, runId });
      assert.equal(r.exitCode, undefined, `${label}：收口判定不受影响`);
      assert.equal(r.outLines[2], `Delivery: ${"d".repeat(12)} on ${"b".repeat(12)}, 1 file(s): src/a${escaped}b.js`, `${label}：文本行转义`);
      assert.equal(r.outLines.length, 4, `${label}：不多出行`);
      assert.ok(!r.out.includes(sep), `${label}：文本输出不带原字符`);
      const j = JSON.parse((await runWaitSettled({ dir, runId, asJson: true })).out);
      assert.deepEqual(j.delivery.changedPaths, [`src/a${sep}b.js`], `${label}：JSON 保留原路径`);
    } finally {
      cleanupDir(dir);
    }
  }
  const dir = makeRunDir();
  try {
    const runId = "run_u25_U0085";
    const ref = makeRef(runId, { changedFiles: ["src/a\u0085b.js"] });
    writeLines(dir, runId, settledDeliveryEvents(runId, ref));
    const r = await runWaitSettled({ dir, runId });
    assert.equal(r.exitCode, undefined);
    assert.deepEqual(r.outLines, [
      `Run: ${runId} (completed)`,
      "Settlement: settled (delivery_settled; verification passed)",
      `Next step: Settled. Delivery awaits the Lead's review: wao runs delivery review ${runId} --all. Verification passed is not acceptance.`,
    ], "C1 控制字符照共用路径规则：不出 Delivery 行");
    assert.ok(!r.out.includes("\u0085"));
    assert.ok(!("delivery" in JSON.parse((await runWaitSettled({ dir, runId, asJson: true })).out)));
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TD-341（第 89 批 C3）：runner_gone 出口附 runner stderr 尾部（展示处理后）。
// ═══════════════════════════════════════════════════════════════════════════

test("R-02c: 有 .runner-<runId>.stderr 文件 → 文本与 JSON 都附展示处理后的尾部", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_rg02c";
    writeLines(dir, runId, runnerGoneEvents(runId));
    // 形状秘密 + 控制字符：展示出口必须脱敏清洗（原始落盘不脱敏，展示才处理）。
    writeFileSync(
      join(dir, `.runner-${runId}.stderr`),
      "FATAL: heap OOM\nAuthorization: Bearer abcdef1234567890abcdef1234567890\r\nlast line\b\x00",
      "utf8",
    );
    const r = await runWaitSettled({ dir, runId, deps: runnerProofDeps });
    assert.equal(r.exitCode, 3);
    assert.equal(r.outLines.length, 4);
    assert.ok(r.outLines[2].startsWith("Runner stderr tail: FATAL: heap OOM"), "尾部正文出现");
    assert.ok(!r.outLines[2].includes("abcdef1234567890"), "Bearer 令牌值被脱敏");
    assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(r.outLines[2]), "控制字符被清洗");
    const j = await runWaitSettled({ dir, runId, asJson: true, deps: runnerProofDeps });
    const parsed = JSON.parse(j.out);
    assert.ok(parsed.runnerStderrTail.includes("FATAL: heap OOM"));
    assert.ok(!parsed.runnerStderrTail.includes("abcdef1234567890"), "JSON 面同样脱敏");
    assert.ok(parsed.runnerStderrTail.includes("Bearer [REDACTED]"), "形状脱敏标签保留");
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// B91（TD-345）：重新打包的形状（终态 failed、交付来自重新打包、验证显式
// pending、无结果、无 reverify）。等待器用真实 proveVerifierGone + 全桩探测
//（不跑真实进程扫描）：证明成立 → 退出 3、reason verifier_gone、nextStep 是
// 指向 `wao runs delivery repackage` 的新文案；证明后重读已有结果仍收口退出 0。
// ═══════════════════════════════════════════════════════════════════════════

// 重新打包形状的转录：disallowed_scope 恢复候选 + created（显式 pending）+
// 有效 provenance。没有 run.background_submitted（前提 2 对该形状豁免）。
function repackagePendingEvents(runId) {
  const ref = makeRef(runId);
  const events = [
    { ...started(runId), ts: PROOF_TS },
    { type: "run.delivery_failed", runId, agentId: "coder_low", deliveryCode: "disallowed_path", message: "changes outside allowedPaths", ts: PROOF_TS },
    { type: "run.state_change", runId, agentId: "coder_low", from: "running", to: "failed", reason: "delivery_failed", ts: PROOF_TS },
    { ...created(runId, ref), ts: PROOF_TS },
    { type: "run.delivery_repackaged", runId, agentId: "coder_low", delivery: ref, approvedAllowedPaths: ["src"], source: "packaged", recoveryKind: "disallowed_scope", ts: PROOF_TS },
  ];
  return { ref, events };
}

test("W-07 (B91): 重新打包形状证明成立 → 退出 3，nextStep 指向 wao runs delivery repackage（新文案）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg07";
    const { events } = repackagePendingEvents(runId);
    writeLines(dir, runId, events);
    const r = await runWaitSettled({ dir, runId, deps: verifierProofDeps });
    assert.equal(r.exitCode, 3);
    assert.equal(r.outLines.length, 3, `只输出三行终行，实际: ${JSON.stringify(r.outLines)}`);
    assert.equal(r.outLines[0], `Run: ${runId} (failed)`);
    assert.equal(
      r.outLines[1],
      `Stuck: the verification of ${runId} has no outcome and no WAO process that could finish it remains (lease_missing); waiting will not change this.`,
    );
    // 第 137a 批：CLI 面写 CLI 命令 wao runs delivery repackage（不再点名 MCP 工具）。
    // 续修 1：带 --cwd <workspace root> 占位；句中只有拒收命令带真实 runId（重新打包
    // 命令用 <runId> 占位）——runId 触顶长度不短于改前的 182。
    assert.equal(
      r.outLines[2],
      `Next step: Its verification is no longer running. Call wao runs delivery repackage <runId> --allowed-path <path>... --cwd <workspace root> (the same allowed paths) to re-run the verification without creating a second commit. Or reject it while it is pending: wao runs delivery ${runId} --reject --reason-file <FILE>.`,
    );
    assert.ok(!r.outLines.some((l) => l.startsWith("[runs wait]")), "证明成立即退：不打印未收口进度行");
  } finally {
    cleanupDir(dir);
  }
});

test("U-16（第 120 批续修 E2/E4）：多目标——普通目标不触发派生预筛；有被取代目标时才预筛一次", async () => {
  const dir = makeRunDir();
  try {
    // 两个普通交付目标（无谱系引用）都收口未决定 → 会渲然 settled_line，但不推导。
    const ids = ["run_u16a", "run_u16b"];
    for (const id of ids) {
      const ref = makeRef(id);
      writeLines(dir, id, [
        started(id),
        created(id, ref),
        stateChange(id, "completed"),
        outcome(id, "passed", ref),
      ]);
    }
    let byteReads = 0;
    const readBytes = async (path) => {
      byteReads += 1;
      return readFileSync(path);
    };
    const plain = await runWaitSettledMulti({
      dir, runIds: ids, deps: { supersessionReadBytesFn: readBytes },
    });
    assert.equal(byteReads, 0, "普通目标不该触发全库字节预筛");
    assert.ok(!plain.outLines.some((l) => l.includes("Superseded:")), plain.outLines.join("\n"));

    // 正例：一条谱系根（收口未决定）+ 已采纳后代 → 预筛发生，终行写被取代。
    const ROOT = "run_u16root";
    const CHILD = "run_u16child";
    const rootRef = makeRef(ROOT);
    writeLines(dir, ROOT, [
      started(ROOT),
      lineageFirst(ROOT),
      created(ROOT, rootRef),
      stateChange(ROOT, "completed"),
      outcome(ROOT, "passed", rootRef),
    ]);
    const childRef = makeRef(CHILD);
    writeLines(dir, CHILD, [
      continuationFact(CHILD, ROOT, ROOT),
      lineageResume(CHILD, ROOT),
      started(CHILD),
      created(CHILD, childRef),
      stateChange(CHILD, "completed"),
      outcome(CHILD, "passed", childRef),
      acceptedDecision(CHILD, childRef),
    ]);
    byteReads = 0;
    const withLineage = await runWaitSettledMulti({
      dir, runIds: [...ids, ROOT], deps: { supersessionReadBytesFn: readBytes },
    });
    assert.equal(byteReads, 4, "预筛只扫一遍库：读次数 == 文件数（2 普通 + 根 + 后代）");
    const expected = `Next step: Settled. A descendant of this run was already accepted (${CHILD}); no Lead decision is needed here.`;
    assert.ok(withLineage.outLines.includes(expected), withLineage.outLines.join("\n"));

    // 停表后才收口：等待器看到的是**旧快照**（非终态），磁盘上已经是收口事实；
    // 表被第一个目标停掉后，即时判定（judgeOnceFn）按磁盘现状把它并入
    // outcomeByRun。收根与渲染用同一集合——两个目标各贡献一个根，仍只扫一遍库。
    const A = "run_u16late_a";
    const LATE = "run_u16late_root";
    const LATE_CHILD = "run_u16late_child";
    const lateRef = makeRef(LATE);
    const aRef = makeRef(A);
    writeLines(dir, A, [
      started(A), lineageFirst(A), created(A, aRef), stateChange(A, "completed"), outcome(A, "passed", aRef),
    ]);
    // 磁盘上的 LATE 一开始就是收口事实；等待器的解析缝指向另一份**旧快照**。
    writeLines(dir, LATE, [
      started(LATE), lineageFirst(LATE), created(LATE, lateRef),
      stateChange(LATE, "completed"), outcome(LATE, "passed", lateRef),
    ]);
    const lateChildRef = makeRef(LATE_CHILD);
    writeLines(dir, LATE_CHILD, [
      continuationFact(LATE_CHILD, LATE, LATE),
      lineageResume(LATE_CHILD, LATE),
      started(LATE_CHILD),
      created(LATE_CHILD, lateChildRef),
      stateChange(LATE_CHILD, "completed"),
      outcome(LATE_CHILD, "passed", lateChildRef),
      acceptedDecision(LATE_CHILD, lateChildRef),
    ]);
    const staleDir = mkdtempSync(join(tmpdir(), "wao-u16-stale-"));
    writeLines(staleDir, LATE, [started(LATE), lineageFirst(LATE)]); // 非终态旧快照
    const filesNow = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).length;
    assert.equal(filesNow, 7, `夹具前提：库里有 7 份转录，实际 ${filesNow}`);
    const baseResolver = realResolver(dir);
    let judgeCalls = 0;
    byteReads = 0;
    try {
      const late = await runWaitSettledMulti({
        dir, runIds: [A, LATE], asJson: true,
        deps: {
          supersessionReadBytesFn: readBytes,
          // 等待器只看到旧快照（LATE 始终"在跑"）→ 只能等停表后的即时判定。
          resolveDetailedFn: (rd, rid) => (rid === LATE ? realResolver(staleDir)(rd, rid) : baseResolver(rd, rid)),
          judgeOnceFn: async (input) => {
            judgeCalls += 1;
            // 即时判定按磁盘现状（不被等待器的旧快照解析缝影响）。
            return judgeRunSettlementOnce({
              ...input,
              deps: { ...input.deps, resolveDetailedFn: baseResolver },
            });
          },
        },
      });
      assert.equal(late.exitCode, undefined, "正常停表（无 SIGINT）");
      assert.equal(judgeCalls, 1, "确实走了一次即时判定（不是等待器直接收口）");
      const parsed = JSON.parse(late.out);
      const lateResult = parsed.results.find((x) => x.runId === LATE);
      assert.equal(lateResult.settled, true, "即时判定按磁盘现状判为收口");
      assert.ok(JSON.stringify(lateResult).includes(LATE_CHILD), "停表后收口的目标也带出后代");
      assert.equal(byteReads, filesNow, "两个目标共一次预筛（读次数 == 文件数）");
    } finally {
      cleanupDir(staleDir);
    }
  } finally {
    cleanupDir(dir);
  }
});

test("W-07b (B91): 重新打包形状 JSON——{settled:false,state:failed,reason:verifier_gone,basis,nextStep}", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg07b";
    const { events } = repackagePendingEvents(runId);
    writeLines(dir, runId, events);
    const r = await runWaitSettled({ dir, runId, asJson: true, deps: verifierProofDeps });
    assert.equal(r.exitCode, 3);
    const parsed = JSON.parse(r.out);
    assert.deepEqual(Object.keys(parsed).sort(), ["basis", "nextStep", "reason", "runId", "settled", "state"]);
    assert.equal(parsed.settled, false);
    assert.equal(parsed.state, "failed");
    assert.equal(parsed.reason, "verifier_gone");
    assert.equal(parsed.basis, "lease_missing");
    // 第 137a 批：CLI 面写 CLI 命令 wao runs delivery repackage（不再点名 MCP 工具）；
    // 续修 1：带 --cwd <workspace root> 占位。
    assert.match(parsed.nextStep, /^Its verification is no longer running\. Call wao runs delivery repackage <runId> --allowed-path <path>\.\.\. --cwd <workspace root> \(the same allowed paths\) to re-run the verification without creating a second commit\./);
    assert.ok(parsed.nextStep.includes("without creating a second commit"), "续修 1：措辞改为 without creating a second commit（原 will not create）");
    assert.ok(parsed.nextStep.includes("--reject --reason-file <FILE>"), "pending 拒收出口仍在");
  } finally {
    cleanupDir(dir);
  }
});

test("W-07c (B91): 重新打包形状证明成立但重读已有结果 → 照常收口退出 0", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_wg07c";
    const { ref, events } = repackagePendingEvents(runId);
    writeLines(dir, runId, events);
    let reads = 0;
    const readTranscriptFn = async () => {
      reads += 1;
      if (reads === 1) return events;
      return [...events, outcome(runId, "passed", ref)];
    };
    const r = await runWaitSettled({ dir, runId, deps: { ...verifierProofDeps, readTranscriptFn } });
    assert.equal(r.exitCode, undefined, "重读已有结果 → 收口退出 0");
    assert.equal(reads, 2, "一轮正常读 + 证明后一次重读");
    assert.match(r.out, /Settlement: settled \(delivery_settled/);
    assert.ok(!/verifier_gone|Stuck:/.test(r.out), "不报 verifier_gone");
    // 第 136 批续修（建议）：重新打包恢复后的收口同样投影交付要点——交付提交、
    // 基线与路径取自重新打包后的事实。走同一条恢复路径（先 pending、证明后重读
    // 已有结果）。
    let jsonReads = 0;
    const j = await runWaitSettled({
      dir, runId, asJson: true,
      deps: {
        ...verifierProofDeps,
        readTranscriptFn: async () => {
          jsonReads += 1;
          return jsonReads === 1 ? events : [...events, outcome(runId, "passed", ref)];
        },
      },
    });
    assert.equal(j.exitCode, undefined, "JSON 面同样收口退出 0");
    assert.equal(jsonReads, 2, "同一条恢复路径");
    assert.deepEqual(JSON.parse(j.out).delivery, {
      deliveryCommit: DELIVERED, baseCommit: BASE, changedFileCount: 1, changedPaths: ["src/a.js"],
    });
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 107 批：runner_unproven——静默满 30 分钟、owner 心跳不新鲜、本轮 runner
// 缺席证明被"未知类"闭集理由拒绝（RUNNER_UNPROVEN_REFUSALS）时以退出码 5 报警。
// 证明/时钟/开机时刻全注入，零真实进程扫描；只在"本轮确实发了证明"时判定，
// 不用跨轮累计器。证明成立仍是 runner_gone（3）；不在闭集的拒绝不退出。
// ═══════════════════════════════════════════════════════════════════════════

// 非终态安静运行（同 runnerGoneEvents 形状），ts 固定；注入钟 base+31min 让静默
// 满 30 分钟（证明前置筛的 15 分钟随之满足）。bootAt 缺省早于最后活动 → 不成立。
const UP_TS = Date.parse("2026-11-01T00:00:00.000Z");
function unprovenEvents(runId) {
  const iso = new Date(UP_TS).toISOString();
  return [
    { ...started(runId, { delivery: false }), ts: iso },
    { type: "run.background_submitted", runId, agentId: "coder_low", background: true, ts: iso },
  ];
}
// 本节通用 deps：钟停在 base+31min；证明桩由用例给；开机时刻一律注入钉住
//（缺省会真读 machineBootTimeMs——真机 boot 与 base 的先后不可控）。
function unprovenDeps({ refusal, bootTimeFn = () => UP_TS - 60 * 60_000, runnerGoneFn, nowMs = UP_TS + 31 * 60_000, ...rest } = {}) {
  return {
    nowFn: () => nowMs,
    bootTimeFn,
    ...(runnerGoneFn ? { runnerGoneFn } : refusal
      ? { runnerGoneFn: async () => ({ gone: false, refusal }) }
      : {}),
    ...rest,
  };
}

test("UP-01: 静默满 30 分钟且本轮拒于 runner_scan_failed → 退出 5（文本终行与措辞纪律）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_up01";
    writeLines(dir, runId, unprovenEvents(runId));
    const r = await runWaitSettled({ dir, runId, deps: unprovenDeps({ refusal: "runner_scan_failed" }) });
    assert.equal(r.exitCode, 5);
    assert.equal(r.outLines.length, 3, `三行终行（无重启行），实际: ${JSON.stringify(r.outLines)}`);
    assert.equal(r.outLines[0], `Run: ${runId} (running)`);
    assert.equal(
      r.outLines[1],
      `Unproven: the owner heartbeat is missing or not fresh and the run has been silent for 31 min, but the runner's absence cannot be proven (runner_scan_failed); the run is still running, and waiting longer may still see it change.`,
    );
    // 第 137a 批：续修写 CLI 命令 wao runs continue；同句别处相应改短。
    assert.match(r.outLines[2], new RegExp(`^Next step: The runner's absence cannot be proven, so the run may still change\\. First check wao status ${runId}, then dry-run wao runs settle --run-id ${runId} --reason-file <FILE> for the gate facts \\(writes nothing\\)\\.`));
    assert.match(r.outLines[2], new RegExp(`The Lead decides: stop it \\(wao stop with the --observed-seq from status and a reason; then a continuable lineage can resume via wao runs continue <runId> --prompt-file <FILE>\\), settle it, or re-attach the wait\\.$`));
    // 措辞纪律：不说"等待不会改变事实"，不断言 runner 已死。
    assert.ok(!r.out.includes("waiting will not change this"), "不得写 waiting will not change this");
    assert.ok(!r.outLines.some((l) => l.startsWith("[runs wait]")), "报警即退：不打印未收口进度行");
  } finally {
    cleanupDir(dir);
  }
});

test("UP-01b: JSON 面——键集 {settled,runId,state,reason,refusal,quietMinutes,rebootedSinceLastActivity,nextStep}；rebooted 不成立 → null", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_up01b";
    writeLines(dir, runId, unprovenEvents(runId));
    const r = await runWaitSettled({
      dir, runId, asJson: true,
      deps: unprovenDeps({ refusal: "process_identity_unknown" }),
    });
    assert.equal(r.exitCode, 5);
    assert.equal(r.outLines.length, 1, "stdout 只留最终 JSON");
    const parsed = JSON.parse(r.out);
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["nextStep", "quietMinutes", "reason", "rebootedSinceLastActivity", "refusal", "runId", "settled", "state"],
    );
    assert.equal(parsed.settled, false);
    assert.equal(parsed.runId, runId);
    assert.equal(parsed.state, "running");
    assert.equal(parsed.reason, "runner_unproven");
    assert.equal(parsed.refusal, "process_identity_unknown");
    assert.equal(parsed.quietMinutes, 31);
    assert.equal(parsed.rebootedSinceLastActivity, null, "开机早于最后活动 → null");
    assert.equal(typeof parsed.nextStep, "string");
    assert.ok(!r.out.includes("waiting will not change this"));
  } finally {
    cleanupDir(dir);
  }
});

test("UP-01c: rebooted 成立 → 文本加 Reboot 行、JSON 带两个 ISO 时刻；等待前后转录字节不变", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_up01c";
    writeLines(dir, runId, unprovenEvents(runId));
    const before = readFileSync(join(dir, `${runId}.jsonl`));
    // 开机晚于最后活动 5 分钟；注入钟 base+31min。
    const bootAt = UP_TS + 5 * 60_000;
    const r = await runWaitSettled({
      dir, runId,
      deps: unprovenDeps({
        refusal: "session_ambiguous",
        bootTimeFn: () => bootAt,
      }),
    });
    assert.equal(r.exitCode, 5);
    assert.equal(r.outLines.length, 4, "多一行 Reboot");
    assert.equal(
      r.outLines[2],
      `Reboot: this machine booted at ${new Date(bootAt).toISOString()}, after the run's last activity (${new Date(UP_TS).toISOString()}); a runner from before the reboot cannot have survived it, but a runner started after the boot cannot be ruled out.`,
    );
    const j = await runWaitSettled({
      dir, runId, asJson: true,
      deps: unprovenDeps({ refusal: "session_ambiguous", bootTimeFn: () => bootAt }),
    });
    const parsed = JSON.parse(j.out);
    assert.deepEqual(parsed.rebootedSinceLastActivity, {
      bootAt: new Date(bootAt).toISOString(),
      lastActivityAt: new Date(UP_TS).toISOString(),
    }, "时刻用 ISO 字符串");
    // 只读不变量：等待不写转录一字节。
    const after = readFileSync(join(dir, `${runId}.jsonl`));
    assert.ok(after.equals(before), "转录字节不变");
  } finally {
    cleanupDir(dir);
  }
});

test("UP-02: 静默 29 分 59 秒时本轮拒于 runner_scan_failed 不退出；随后收口 0（阈值证伪）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_up02";
    const events = unprovenEvents(runId);
    writeLines(dir, runId, events);
    let reads = 0;
    let proofCalls = 0;
    const r = await runWaitSettled({
      dir, runId,
      deps: unprovenDeps({
        nowMs: UP_TS + (30 * 60_000 - 1000), // 29:59 < 30 分钟：不触发
        runnerGoneFn: async () => { proofCalls += 1; return { gone: false, refusal: "runner_scan_failed" }; },
        readTranscriptFn: async () => {
          reads += 1;
          // 第 2 轮读返回终态（钟不走，节流挡住第二次证明）→ 收口退出 0。
          return reads === 1 ? events : [...events, stateChange(runId, "completed")];
        },
      }),
    });
    assert.equal(r.exitCode, undefined, "未满 30 分钟不退出 5；随后收口退出 0");
    assert.equal(proofCalls, 1, "本轮确实发了证明（前置筛 15 分钟已过）");
    assert.ok(r.outLines.some((l) => l.includes("runner proof: runner_scan_failed")), "拒绝理由照旧进进度行注脚");
    assert.ok(!/runner_unproven|Unproven:/.test(r.out), "不出现 runner_unproven 输出");
  } finally {
    cleanupDir(dir);
  }
});

// 闭集每个理由各一例（含证明抛错 → probe_failed）。全部静默满 30 分钟、本轮证明。
test("UP-03: 闭集每个理由各一例（含抛错 → probe_failed）→ 退出 5、refusal 正确", async () => {
  const cases = [
    ["runner_scan_failed", { refusal: "runner_scan_failed" }],
    ["process_identity_unknown", { refusal: "process_identity_unknown" }],
    ["owner_lease_corrupt", { refusal: "owner_lease_corrupt" }],
    ["session_ambiguous", { refusal: "session_ambiguous" }],
    ["probe_failed", { runnerGoneFn: async () => { throw new Error("probe exploded"); } }],
  ];
  for (const [label, depOverrides] of cases) {
    const dir = makeRunDir();
    try {
      const runId = `run_up03_${label}`;
      writeLines(dir, runId, unprovenEvents(runId));
      const r = await runWaitSettled({
        dir, runId, asJson: true,
        deps: unprovenDeps(depOverrides),
      });
      assert.equal(r.exitCode, 5, `${label} → 退出 5`);
      const parsed = JSON.parse(r.out);
      assert.equal(parsed.reason, "runner_unproven", `${label}`);
      assert.equal(parsed.refusal, label, `${label} 的 refusal 原样上报`);
    } finally {
      cleanupDir(dir);
    }
  }
});

test("UP-04: 不在闭集的拒绝满 30 分钟也不退出——owner_fresh（前置筛）/runner_alive/process_alive/daemon_owned", async () => {
  // owner_fresh：真实 .owner 文件的心跳写在注入钟上 → 前置筛挡下，证明零调用。
  const freshDir = makeRunDir();
  try {
    const runId = "run_up04a";
    writeLines(freshDir, runId, unprovenEvents(runId));
    writeFileSync(join(freshDir, `.owner-${runId}`), JSON.stringify({ pid: process.pid, heartbeatAt: UP_TS + 31 * 60_000 }), "utf8");
    let proofCalls = 0;
    let appended = false;
    const r = await runWaitSettled({
      dir: freshDir, runId,
      deps: unprovenDeps({
        runnerGoneFn: async () => { proofCalls += 1; return { gone: true }; },
        sleepFn: async () => {
          if (!appended) {
            appended = true;
            appendLines(freshDir, runId, [stateChange(runId, "completed")]);
          }
        },
      }),
    });
    assert.equal(r.exitCode, undefined, "owner_fresh 不触发退出 5");
    assert.equal(proofCalls, 0, "前置筛挡下：不发证明");
    assert.ok(r.outLines.some((l) => l.includes("runner proof: owner_fresh")), "理由照旧进注脚");
  } finally {
    cleanupDir(freshDir);
  }
  // runner_alive / process_alive / daemon_owned：本轮证明被拒但非闭集 → 不退出 5。
  for (const refusal of ["runner_alive", "process_alive", "daemon_owned"]) {
    const dir = makeRunDir();
    try {
      const runId = `run_up04_${refusal}`;
      const events = unprovenEvents(runId);
      writeLines(dir, runId, events);
      let reads = 0;
      const r = await runWaitSettled({
        dir, runId,
        deps: unprovenDeps({
          refusal,
          readTranscriptFn: async () => {
            reads += 1;
            // 会审续修：前两次读都保持非终态——若闭集误收了这个理由，第二次读（报警前的
            // 重读）仍非终态，错误的退出 5 就能被看见；第三次读才收口。
            return reads <= 2 ? events : [...events, stateChange(runId, "completed")];
          },
        }),
      });
      assert.equal(r.exitCode, undefined, `${refusal} 满静默 30 分钟也不退出 5`);
      assert.ok(!/runner_unproven|Unproven:/.test(r.out), `${refusal} 不出现 runner_unproven 输出`);
    } finally {
      cleanupDir(dir);
    }
  }
});

test("UP-05: 同样静默满 30 分钟，证明成立仍走 runner_gone（退出 3），不是 5", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_up05";
    writeLines(dir, runId, unprovenEvents(runId));
    const r = await runWaitSettled({
      dir, runId,
      deps: unprovenDeps({ runnerGoneFn: async () => ({ gone: true }) }),
    });
    assert.equal(r.exitCode, 3, "证明成立 → runner_gone 退出 3");
    assert.match(r.out, /Stuck: the runner of run_up05 is gone/);
  } finally {
    cleanupDir(dir);
  }
});

test("UP-06: 触发条件成立、重读时已收口 → 照常退出 0，不报 runner_unproven", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_up06";
    const events = unprovenEvents(runId);
    writeLines(dir, runId, events);
    let reads = 0;
    const r = await runWaitSettled({
      dir, runId,
      deps: unprovenDeps({
        refusal: "runner_scan_failed",
        readTranscriptFn: async () => {
          reads += 1;
          return reads === 1 ? events : [...events, stateChange(runId, "completed")];
        },
      }),
    });
    assert.equal(r.exitCode, undefined, "重读已收口 → 退出 0");
    assert.equal(reads, 2, "一轮正常读 + 报警出口的重读");
    assert.match(r.out, /Settlement: settled \(no_delivery_requested\)/);
    assert.ok(!/runner_unproven|Unproven:/.test(r.out));
  } finally {
    cleanupDir(dir);
  }
});

test("UP-06b: 首读静默满 30 分钟、证明期间长出新事件 → 重读快照复检不报警，照常等到收口", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_up06b";
    const events = unprovenEvents(runId);
    writeLines(dir, runId, events);
    // 证明期间写下的新事件：距注入钟 1 分钟（开机后续跑写下第一条事件的形状）。
    const fresh = { type: "run.event", runId, agentId: "coder_low", ts: new Date(UP_TS + 30 * 60_000).toISOString() };
    let reads = 0;
    const r = await runWaitSettled({
      dir, runId,
      deps: unprovenDeps({
        refusal: "runner_scan_failed",
        readTranscriptFn: async () => {
          reads += 1;
          if (reads === 1) return events;
          if (reads === 2) return [...events, fresh];
          return [...events, fresh, stateChange(runId, "completed")];
        },
      }),
    });
    assert.equal(r.exitCode, undefined, "重读快照只静默 1 分钟 → 不退出 5，后来收口 → 0");
    assert.equal(reads, 3, "首读 + 报警前的重读 + 下一轮读到收口");
    assert.ok(!/runner_unproven|Unproven:/.test(r.out), "不出现 runner_unproven 输出");
    assert.match(r.out, /last vital sign 1 min ago/, "进度行按重读快照（新事件 1 分钟前）打印，不沿用首读的 31 分钟");
  } finally {
    cleanupDir(dir);
  }
});

test("UP-07: 触发条件成立、重读后确认解析冲突 → 仍按冲突退出 4", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_up07";
    writeLines(dir, runId, unprovenEvents(runId));
    let calls = 0;
    const real = realResolver(dir);
    const r = await runWaitSettled({
      dir, runId,
      deps: unprovenDeps({
        refusal: "runner_scan_failed",
        resolveDetailedFn: (rd, rid) => {
          calls += 1;
          if (calls === 3) return { path: null, found: false, conflict: true };
          return real(rd, rid);
        },
      }),
    });
    assert.equal(r.exitCode, 4, "退出前的确认解析冲突按冲突出口");
    assert.equal(calls, 3, "解析三次：首轮、重读前、退出前确认");
    assert.match(r.out, /multiple distinct transcript copies/);
  } finally {
    cleanupDir(dir);
  }
});

test("UP-08: 证明期间 SIGINT → 单一出口 130，只输出一份中断结果（压过报警出口）", async () => {
  const dir = makeRunDir();
  try {
    const runId = "run_up08";
    writeLines(dir, runId, unprovenEvents(runId));
    const base = process.listenerCount("SIGINT");
    const r = await runWaitSettled({
      dir, runId, asJson: true,
      deps: unprovenDeps({
        runnerGoneFn: async () => {
          process.emit("SIGINT");
          return { gone: false, refusal: "runner_scan_failed" };
        },
      }),
    });
    assert.equal(r.exitCode, 130, "中断以 130 退出");
    assert.equal(r.outLines.length, 1, `只输出一份最终结果，实际: ${JSON.stringify(r.outLines)}`);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.interrupted, true);
    assert.equal(parsed.settled, false);
    assert.ok(!/runner_unproven|Unproven:/.test(r.out), "中断路径不出报警终行");
    assert.equal(process.listenerCount("SIGINT"), base, "SIGINT handler 注销（无泄漏）");
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 118 批 B：多目标 `runs wait <runId> [<runId>...] --until-settled`——
// 每目标并发跑同一收口等待器，先到先返回；停表后对其余目标做一次即时判定
//（judgeRunSettlementOnce，无轮询无证明）；一份最终输出（逐目标单目标同款终行
// + Still waiting/Re-arm 两行或 {multi,results,remaining,rearmCommand}）；退出码
// 聚合 4 > 5 > 3 > 0；SIGINT 130 全量中断快照。去重后 1 个目标仍走单目标面。
// ═══════════════════════════════════════════════════════════════════════════

async function runWaitSettledMulti({ dir, runIds, asJson = false, deps = {} }) {
  const prev = process.exitCode;
  let result;
  try {
    process.exitCode = undefined;
    result = await captureBoth(() => runsCommand(
      ["wait", ...runIds, "--until-settled", ...(asJson ? ["--format", "json"] : []), "--run-dir", dir],
      { runDir: dir },
      { pollIntervalMs: 0, resolveDetailedFn: realResolver(dir), ...deps },
    ));
    return { ...result, exitCode: process.exitCode };
  } finally {
    process.exitCode = prev;
  }
}

test("M-01: 两个目标、一个先收口 → 终行 + Still waiting + Re-arm，退出码 0", async () => {
  const dir = makeRunDir();
  try {
    const settled = "run_m01a";
    const pending = "run_m01b";
    writeLines(dir, settled, [started(settled, { delivery: false }), stateChange(settled, "completed")]);
    writeLines(dir, pending, [started(pending, { delivery: false })]);
    const r = await runWaitSettledMulti({ dir, runIds: [settled, pending] });
    assert.equal(r.exitCode, undefined, "本轮唯一结局是收口 → 不设退出码（0）");
    assert.ok(r.outLines.includes(`Run: ${settled} (completed)`), JSON.stringify(r.outLines));
    assert.ok(r.outLines.some((l) => /^Settlement: settled \(no_delivery_requested\)$/.test(l)));
    assert.ok(r.outLines.some((l) => l.startsWith("Next step: ")));
    assert.ok(r.outLines.includes(`Still waiting: ${pending}`), JSON.stringify(r.outLines));
    assert.ok(r.outLines.includes(`Re-arm: wao runs wait ${pending} --until-settled --run-dir ${dir}`), JSON.stringify(r.outLines));
    // 仍在等的目标不出终行；重挂行收尾。
    assert.ok(!r.outLines.some((l) => l.startsWith(`Run: ${pending}`)), "未收口目标无终行");
    assert.equal(r.outLines.at(-1), `Re-arm: wao runs wait ${pending} --until-settled --run-dir ${dir}`);
  } finally {
    cleanupDir(dir);
  }
});

test("M-02: 一个 runner_unproven（5）、另一个同轮收口 → 两个结局都打印，退出码 5", async () => {
  const dir = makeRunDir();
  try {
    const unprovenId = "run_m02a";
    const settledId = "run_m02b";
    writeLines(dir, unprovenId, unprovenEvents(unprovenId));
    writeLines(dir, settledId, [started(settledId, { delivery: false }), stateChange(settledId, "completed")]);
    let unprovenProofStarted = false;
    const r = await runWaitSettledMulti({
      dir, runIds: [unprovenId, settledId],
      deps: {
        ...unprovenDeps({ refusal: "runner_scan_failed" }),
        runnerGoneFn: async () => {
          unprovenProofStarted = true;
          return { gone: false, refusal: "runner_scan_failed" };
        },
        // 续修 1 下停表会拦下尚未开始的证明，5 必须先落地：收口目标的读被屏障
        // 挡到证明开始之后（证明已开始就照常跑完出结局），0 随后同轮落地。
        readTranscriptFn: async (p) => {
          if (String(p).includes(settledId)) {
            while (!unprovenProofStarted) await new Promise((res) => setImmediate(res));
          }
          const { readTranscript } = await import("../../src/transcript.js");
          return readTranscript(p);
        },
        sleepFn: () => new Promise(() => {}),
      },
    });
    assert.equal(r.exitCode, 5, "5 压过 0");
    assert.ok(r.outLines.some((l) => l.startsWith(`Run: ${unprovenId} (running)`)), JSON.stringify(r.outLines));
    assert.ok(r.outLines.some((l) => l.startsWith("Unproven: ")), "报警终行在场");
    assert.ok(r.outLines.includes(`Run: ${settledId} (completed)`), "同轮收口的结局一并打印");
    assert.ok(r.outLines.some((l) => /^Settlement: settled \(no_delivery_requested\)$/.test(l)));
    assert.ok(!r.outLines.some((l) => l.startsWith("Still waiting")), "全部有结局：不打 Still waiting");
    assert.ok(!r.outLines.some((l) => l.startsWith("Re-arm:")), "全部有结局：不打 Re-arm");
  } finally {
    cleanupDir(dir);
  }
});

test("M-03: 同轮 4（冲突）与 5（runner_unproven）→ 退出码 4（优先级 4 > 5 > 3 > 0）", async () => {
  const dir = makeRunDir();
  try {
    const conflictId = "run_m03a";
    const unprovenId = "run_m03b";
    // 续修 1 之后停表会拦下尚未开始的证明，所以 5 必须先落地：冲突目标的等待
    // 器首轮只看到"未找到"（不可信一轮后睡到被停，不先出结局）；A 的证明照常
    // 跑完出 5 → 停表 → 冲突目标交即时判定，首解即冲突 → 4。两个结局同轮，4 压 5。
    writeLines(dir, unprovenId, unprovenEvents(unprovenId));
    let conflictResolves = 0;
    const real = realResolver(dir);
    const r = await runWaitSettledMulti({
      dir, runIds: [unprovenId, conflictId],
      deps: {
        ...unprovenDeps({ refusal: "runner_scan_failed" }),
        resolveDetailedFn: (rd, rid) => {
          if (rid === conflictId) {
            conflictResolves += 1;
            return conflictResolves >= 2
              ? { path: null, found: false, conflict: true }
              : { path: null, found: false, conflict: false };
          }
          return real(rd, rid);
        },
        sleepFn: () => new Promise(() => {}),
      },
    });
    assert.equal(r.exitCode, 4, "4 压过 5");
    assert.ok(r.outLines.some((l) => l.startsWith("Unproven: ")), "5 的结局同样打印");
    assert.ok(r.outLines.some((l) => l.startsWith(`Conflict: ${conflictId} has multiple distinct transcript copies`)), JSON.stringify(r.outLines));
    assert.ok(!r.outLines.some((l) => l.startsWith("Still waiting")));
  } finally {
    cleanupDir(dir);
  }
});

test("M-04: 全部同轮有结局 → 不打 Still waiting/Re-arm；JSON remaining 空、rearmCommand null", async () => {
  const dir = makeRunDir();
  try {
    const a = "run_m04a";
    const b = "run_m04b";
    writeLines(dir, a, [started(a, { delivery: false }), stateChange(a, "completed")]);
    writeLines(dir, b, [started(b, { delivery: false }), stateChange(b, "completed")]);
    const r = await runWaitSettledMulti({ dir, runIds: [a, b] });
    assert.equal(r.exitCode, undefined, "两个收口 → 0");
    assert.ok(r.outLines.includes(`Run: ${a} (completed)`));
    assert.ok(r.outLines.includes(`Run: ${b} (completed)`));
    assert.ok(!r.outLines.some((l) => l.startsWith("Still waiting")));
    assert.ok(!r.outLines.some((l) => l.startsWith("Re-arm:")));
    const j = await runWaitSettledMulti({ dir, runIds: [a, b], asJson: true });
    const parsed = JSON.parse(j.out);
    assert.equal(j.outLines.length, 1, "stdout 只留最终 JSON");
    assert.equal(parsed.multi, true);
    assert.deepEqual(parsed.remaining, []);
    assert.equal(parsed.rearmCommand, null);
    assert.equal(parsed.results.length, 2);
  } finally {
    cleanupDir(dir);
  }
});

test("M-05: JSON 形状 {multi,results,remaining,rearmCommand}；进度带 runId 走 stderr", async () => {
  const dir = makeRunDir();
  try {
    const settled = "run_m05a";
    const pending = "run_m05b";
    // 收口目标首轮也未收口（终态在 sleep 间隙由外部世界追加）：第 1 轮不可能有
    // 停表，两个目标的进度行都确定先落 stderr，再由第 2 轮的收口停表。
    writeLines(dir, settled, [started(settled, { delivery: false })]);
    writeLines(dir, pending, [started(pending, { delivery: false })]);
    let appended = false;
    const r = await runWaitSettledMulti({
      dir, runIds: [settled, pending], asJson: true,
      deps: {
        sleepFn: async () => {
          if (!appended) {
            appended = true;
            appendLines(dir, settled, [stateChange(settled, "completed")]);
          }
        },
      },
    });
    assert.equal(r.exitCode, undefined);
    assert.equal(r.outLines.length, 1, "stdout 只留最终 JSON");
    const parsed = JSON.parse(r.out);
    assert.deepEqual(Object.keys(parsed), ["multi", "results", "remaining", "rearmCommand"]);
    assert.equal(parsed.multi, true);
    assert.equal(parsed.results.length, 1);
    assert.deepEqual(Object.keys(parsed.results[0]).sort(), ["nextStep", "runId", "settled", "settlement", "state"], "results 每项与单目标 JSON 同形");
    assert.equal(parsed.results[0].runId, settled);
    assert.deepEqual(parsed.remaining, [pending]);
    assert.equal(parsed.rearmCommand, `wao runs wait ${pending} --until-settled --run-dir ${dir} --format json`);
    assert.ok(r.errLines.some((l) => l.startsWith("[runs wait]") && l.includes(pending)), "进度行带 runId 在 stderr");
    assert.ok(r.errLines.some((l) => l.startsWith("[runs wait]") && l.includes(settled)), "先收口目标的进度同样在 stderr");
  } finally {
    cleanupDir(dir);
  }
});

test("M-06: 重复 id 去重——a b a 按 a b 走；a a 去重后仍走单目标面", async () => {
  const dir = makeRunDir();
  try {
    const a = "run_m06a";
    const b = "run_m06b";
    writeLines(dir, a, [started(a, { delivery: false }), stateChange(a, "completed")]);
    writeLines(dir, b, [started(b, { delivery: false })]);
    const r = await runWaitSettledMulti({ dir, runIds: [a, b, a], asJson: true });
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.multi, true, "a b a → 两目标多面");
    assert.deepEqual(parsed.remaining, [b], "a 只算一次");
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.results[0].runId, a);
    // a a → 去重后 1 个 → 单目标面：JSON 无 multi 键，与单目标同形。
    const s = await runWaitSettledMulti({ dir, runIds: [a, a], asJson: true });
    const single = JSON.parse(s.out);
    assert.equal(single.multi, undefined, "a a 是单目标面，无 multi 键");
    assert.deepEqual(Object.keys(single).sort(), ["nextStep", "runId", "settled", "settlement", "state"]);
    assert.equal(single.settled, true);
  } finally {
    cleanupDir(dir);
  }
});

test("M-07: 去重后 17 个目标拒绝（最多 16）", async () => {
  const dir = makeRunDir();
  try {
    const ids = Array.from({ length: 17 }, (_, i) => `run_m07_${String(i).padStart(2, "0")}`);
    await assert.rejects(
      () => runsCommand(["wait", ...ids, "--until-settled", "--run-dir", dir], { runDir: dir }),
      /at most 16 runIds \(got 17 after dedup\)/,
    );
    // 17 个里有重复、去重后 16 个：放行（走多目标面，转录缺失 → 即时判不出结局，
    // 但第一个目标的等待器要 4 轮不可信才出结局——用假钟与 0 间隔跑完）。
  } finally {
    cleanupDir(dir);
  }
});

test("M-08: 多目标与 --wait-ms 同用拒绝；只给多个 id 不给旗标拒绝", async () => {
  const dir = makeRunDir();
  try {
    await assert.rejects(
      () => runsCommand(["wait", "run_x", "run_y", "--until-settled", "--wait-ms", "30000"], { runDir: dir }),
      /mutually exclusive/,
    );
    await assert.rejects(
      () => runsCommand(["wait", "run_x", "run_y", "--wait-ms", "30000"], { runDir: dir }),
      /multiple runIds require --until-settled/,
    );
    await assert.rejects(
      () => runsCommand(["wait", "run_x", "run_y"], { runDir: dir }),
      /multiple runIds require --until-settled/,
    );
  } finally {
    cleanupDir(dir);
  }
});

test("M-09: SIGINT → 每目标中断快照 + 全量重挂行，退出码 130，只有一份输出", async () => {
  const dir = makeRunDir();
  try {
    const a = "run_m09a";
    const b = "run_m09b";
    writeLines(dir, a, [started(a, { delivery: false }), stateChange(a, "running")]);
    writeLines(dir, b, [started(b, { delivery: false }), stateChange(b, "running")]);
    const base = process.listenerCount("SIGINT");
    let emitted = false;
    const r = await runWaitSettledMulti({
      dir, runIds: [a, b], asJson: true,
      deps: {
        sleepFn: async () => {
          if (!emitted) {
            emitted = true;
            process.emit("SIGINT");
          }
        },
      },
    });
    assert.equal(r.exitCode, 130, "SIGINT 退出码 130");
    assert.equal(r.outLines.length, 1, `stdout 只留最终 JSON，实际: ${JSON.stringify(r.outLines)}`);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.multi, true);
    assert.equal(parsed.results.length, 2, "每个目标一份中断快照");
    for (const res of parsed.results) {
      assert.equal(res.interrupted, true);
      assert.equal(res.settled, false);
      assert.equal(typeof res.snapshotReadAt, "string", "标注快照读取时间");
    }
    assert.deepEqual(parsed.remaining, [a, b], "中断轮没有目标得到结局：全部仍在等");
    assert.equal(parsed.rearmCommand, `wao runs wait ${a} ${b} --until-settled --run-dir ${dir} --format json`);
    assert.equal(process.listenerCount("SIGINT"), base, "SIGINT handler 注销（无泄漏）");
  } finally {
    cleanupDir(dir);
  }
});

test("M-10: 停表后即时判定发现第二个目标已收口 → 一并算进本轮（确定性钉住即时判定路径）", async () => {
  const dir = makeRunDir();
  try {
    const a = "run_m10a";
    const b = "run_m10b";
    // A 预置已收口（首轮即结局，不睡）；B 的文件已是收口形状，但等待器首轮读到
    // 的是未收口快照，随后入睡。注入的 sleepFn 永不自行了结——唯一出口是被停
    // 表唤醒，所以 B 的等待器必然恰好读一次，第二次读只能来自即时判定。
    writeLines(dir, a, [started(a, { delivery: false }), stateChange(a, "completed")]);
    writeLines(dir, b, [started(b, { delivery: false }), stateChange(b, "completed")]);
    const bPending = [JSON.parse(line(started(b, { delivery: false })))];
    const bSettled = [JSON.parse(line(started(b, { delivery: false }))), JSON.parse(line(stateChange(b, "completed")))];
    let bReads = 0;
    const r = await runWaitSettledMulti({
      dir, runIds: [a, b],
      deps: {
        readTranscriptFn: async (p) => {
          if (String(p).includes(b)) {
            bReads += 1;
            return bReads === 1 ? bPending : bSettled;
          }
          const { readTranscript } = await import("../../src/transcript.js");
          return readTranscript(p);
        },
        // 永不自行了结的睡眠：若停表不能唤醒睡眠，本用例会一直挂到超时。
        sleepFn: () => new Promise(() => {}),
      },
    });
    assert.equal(r.exitCode, undefined, "两个收口 → 0");
    assert.equal(bReads, 2, "B 恰好两次读：等待器首轮一次 + 即时判定一次");
    assert.ok(r.outLines.includes(`Run: ${a} (completed)`), JSON.stringify(r.outLines));
    assert.ok(r.outLines.includes(`Run: ${b} (completed)`), "即时判定的收口一并打印");
    assert.ok(!r.outLines.some((l) => l.startsWith("Still waiting")), "无仍在等的目标");
    assert.ok(!r.outLines.some((l) => l.startsWith("Re-arm:")));
  } finally {
    cleanupDir(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 续修（会审 consult_20261119105652657wri9nw 必改项）：停表即停（唤醒睡眠、
// 不再开始新证明）、证明跨目标串行错峰、收尾期 SIGINT、重挂行照抄旗标、
// 即时判定确认阶段冲突当仍在等、退出码补组合、16 目标接受。
// ═══════════════════════════════════════════════════════════════════════════

test("M-11: 停表唤醒在睡的等待器——首个结局后不等满轮询间隔就输出", async () => {
  const dir = makeRunDir();
  try {
    const a = "run_m11a";
    const b = "run_m11b";
    writeLines(dir, a, [started(a, { delivery: false }), stateChange(a, "completed")]);
    writeLines(dir, b, [started(b, { delivery: false })]);
    const t0 = Date.now();
    const r = await runWaitSettledMulti({
      dir, runIds: [a, b],
      // B 的睡眠要 4 秒才自行了结——唯一能提前结束它的是停表唤醒。
      deps: { sleepFn: () => new Promise((res) => setTimeout(res, 4000)) },
    });
    const elapsed = Date.now() - t0;
    assert.equal(r.exitCode, undefined, "A 收口 → 0");
    assert.ok(r.outLines.includes(`Still waiting: ${b}`));
    assert.ok(elapsed < 2000, `停表要立刻唤醒在睡的等待器（实测 ${elapsed}ms，应远小于 4000ms 间隔）`);
  } finally {
    cleanupDir(dir);
  }
});

test("M-12: 停表后不再开始新的缺席证明（屏障同步 A 的收口读）", async () => {
  const dir = makeRunDir();
  try {
    const a = "run_m12a";
    const b = "run_m12b";
    writeLines(dir, a, [started(a, { delivery: false }), stateChange(a, "completed")]);
    writeLines(dir, b, unprovenEvents(b)); // 静默满 30 分钟的形状：若无停表必发证明
    let aReadDone = false;
    let proofCalls = 0;
    const r = await runWaitSettledMulti({
      dir, runIds: [a, b],
      deps: {
        ...unprovenDeps({ refusal: "runner_scan_failed" }),
        readTranscriptFn: async (p) => {
          if (String(p).includes(a)) {
            const { readTranscript } = await import("../../src/transcript.js");
            const events = await readTranscript(p);
            aReadDone = true; // 读完成才放行屏障：其后的判定/确认/停表全在微任务链上
            return events;
          }
          // B 的读显式等 A 的读完成 + 一拍 macrotask：A 的停表必然已置位
          //（屏障 + 事件循环次序，非次数计数）。
          while (!aReadDone) await new Promise((res) => setImmediate(res));
          await new Promise((res) => setImmediate(res));
          const { readTranscript } = await import("../../src/transcript.js");
          return readTranscript(p);
        },
        runnerGoneFn: async () => {
          proofCalls += 1;
          return { gone: false, refusal: "runner_scan_failed" };
        },
        sleepFn: () => new Promise(() => {}),
      },
    });
    assert.equal(proofCalls, 0, "停表已置位：B 的 runner 缺席证明一次都不开始");
    assert.equal(r.exitCode, undefined, "A 收口 → 0");
    assert.ok(r.outLines.includes(`Still waiting: ${b}`), "B 仍在等（即时判定也判不出结局）");
    assert.ok(!/Unproven:/.test(r.out), "不误报 runner_unproven");
  } finally {
    cleanupDir(dir);
  }
});

test("M-13: 多目标下缺席证明串行——同一时刻至多 1 个在跑", async () => {
  const dir = makeRunDir();
  try {
    const a = "run_m13a";
    const b = "run_m13b";
    writeLines(dir, a, unprovenEvents(a));
    writeLines(dir, b, unprovenEvents(b));
    let active = 0;
    let maxActive = 0;
    let proofCalls = 0;
    let emitted = false;
    const r = await runWaitSettledMulti({
      dir, runIds: [a, b],
      deps: {
        ...unprovenDeps({ refusal: "runner_alive" }), // 非闭集拒绝：不触发 5
        runnerGoneFn: async () => {
          proofCalls += 1;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((res) => setTimeout(res, 25));
          active -= 1;
          return { gone: false, refusal: "runner_alive" };
        },
        sleepFn: async () => {
          // 两个证明都完成后收尾（SIGINT）——sleep 即回，等待器快速空转直至停表。
          if (!emitted && proofCalls >= 2) {
            emitted = true;
            process.emit("SIGINT");
          }
        },
      },
    });
    assert.equal(proofCalls, 2, "两个目标各证明一次");
    assert.equal(maxActive, 1, `同一时刻至多一个证明在跑，实测峰值 ${maxActive}`);
    assert.equal(r.exitCode, 130, "SIGINT 收尾（证明都完成后）");
    assert.ok(!/Unproven:/.test(r.out), "串行错峰下不出现 runner_unproven 误报");
  } finally {
    cleanupDir(dir);
  }
});

test("M-14: SIGINT 发生在即时判定期间 → 仍一份输出、130；有结局目标打印结局行且不在 remaining", async () => {
  const dir = makeRunDir();
  try {
    const a = "run_m14a";
    const b = "run_m14b";
    writeLines(dir, a, [started(a, { delivery: false }), stateChange(a, "completed")]);
    writeLines(dir, b, [started(b, { delivery: false })]);
    const base = process.listenerCount("SIGINT");
    const r = await runWaitSettledMulti({
      dir, runIds: [a, b], asJson: true,
      deps: {
        sleepFn: () => new Promise(() => {}), // B 睡到被停表唤醒
        judgeOnceFn: async (input) => {
          process.emit("SIGINT"); // 即时判定进行中按 Ctrl+C——判定照常完成
          return judgeRunSettlementOnce(input);
        },
      },
    });
    assert.equal(r.exitCode, 130, "中断以 130 退出（压过聚合）");
    assert.equal(r.outLines.length, 1, `stdout 只留最终 JSON，实际: ${JSON.stringify(r.outLines)}`);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.multi, true);
    assert.equal(parsed.results.length, 2, "A 的结局行 + B 的中断快照各一份");
    const aRes = parsed.results.find((x) => x.runId === a);
    const bRes = parsed.results.find((x) => x.runId === b);
    assert.equal(aRes.settled, true, "A 照常打印收口结局");
    assert.equal(bRes.interrupted, true, "B 打印单目标同款中断快照");
    assert.deepEqual(parsed.remaining, [b], "remaining 只列没出结局的目标");
    assert.equal(parsed.rearmCommand, `wao runs wait ${b} --until-settled --run-dir ${dir} --format json`);
    assert.equal(process.listenerCount("SIGINT"), base, "SIGINT handler 注销（无泄漏）");
  } finally {
    cleanupDir(dir);
  }
});

test("M-15: 重挂行照抄 --run-dir（含空格加引号）；JSON 再带 --format json", async () => {
  const outer = makeRunDir();
  try {
    const dir = join(outer, "runs with space");
    mkdirSync(dir);
    const a = "run_m15a";
    const b = "run_m15b";
    writeLines(dir, a, [started(a, { delivery: false }), stateChange(a, "completed")]);
    writeLines(dir, b, [started(b, { delivery: false })]);
    const r = await runWaitSettledMulti({ dir, runIds: [a, b] });
    assert.ok(
      r.outLines.includes(`Re-arm: wao runs wait ${b} --until-settled --run-dir "${dir}"`),
      `含空格路径加双引号，实际: ${JSON.stringify(r.outLines)}`,
    );
    const j = await runWaitSettledMulti({ dir, runIds: [a, b], asJson: true });
    assert.equal(JSON.parse(j.out).rearmCommand, `wao runs wait ${b} --until-settled --run-dir "${dir}" --format json`);
  } finally {
    cleanupDir(outer);
  }
});

test("M-16: 即时判定的确认阶段才见冲突 → 按等待器纪律当仍在等，不报 4", async () => {
  const dir = makeRunDir();
  try {
    const a = "run_m16a";
    const b = "run_m16b";
    writeLines(dir, a, [started(a, { delivery: false }), stateChange(a, "completed")]);
    writeLines(dir, b, [started(b, { delivery: false }), stateChange(b, "completed")]);
    const bPending = [JSON.parse(line(started(b, { delivery: false })))];
    const bSettled = [JSON.parse(line(started(b, { delivery: false }))), JSON.parse(line(stateChange(b, "completed")))];
    let bReads = 0;
    let bResolves = 0;
    const real = realResolver(dir);
    const r = await runWaitSettledMulti({
      dir, runIds: [a, b],
      deps: {
        readTranscriptFn: async (p) => {
          if (String(p).includes(b)) {
            bReads += 1;
            return bReads === 1 ? bPending : bSettled;
          }
          const { readTranscript } = await import("../../src/transcript.js");
          return readTranscript(p);
        },
        // B 的解析计数：1 = 等待器首轮；2 = 即时判定首解；3 = 收口确认——确认
        // 阶段才见冲突（首解不是冲突）→ 按仍在等交回，不当 4。
        resolveDetailedFn: (rd, rid) => {
          if (rid === b) {
            bResolves += 1;
            if (bResolves === 3) return { path: null, found: false, conflict: true };
          }
          return real(rd, rid);
        },
        sleepFn: () => new Promise(() => {}),
      },
    });
    assert.equal(r.exitCode, undefined, "A 收口 → 0（B 的确认冲突不当 4）");
    assert.ok(r.outLines.includes(`Still waiting: ${b}`), JSON.stringify(r.outLines));
    assert.ok(!r.outLines.some((l) => l.startsWith("Conflict:")), "确认阶段的冲突不报 4");
    assert.equal(bResolves, 3, "等待器一解 + 即时判定两解（首解与确认）");
  } finally {
    cleanupDir(dir);
  }
});

test("M-17: 退出码聚合补组合——4 压 3（conflict + runner_gone）、3 压 0（verifier_gone + settled）", async () => {
  {
    const dir = makeRunDir();
    try {
      const conflictId = "run_m17a";
      const goneId = "run_m17b";
      // 同 M-03 的次序：证明已开始就照常跑完 → 3 先落地停表；冲突目标的等待器
      // 首轮只看到"未找到"（睡到被停），被停后交即时判定，首解即冲突 → 4 压 3。
      writeLines(dir, goneId, runnerGoneEvents(goneId));
      let conflictResolves = 0;
      const real = realResolver(dir);
      const r = await runWaitSettledMulti({
        dir, runIds: [goneId, conflictId],
        deps: {
          ...runnerProofDeps,
          resolveDetailedFn: (rd, rid) => {
            if (rid === conflictId) {
              conflictResolves += 1;
              return conflictResolves >= 2
                ? { path: null, found: false, conflict: true }
                : { path: null, found: false, conflict: false };
            }
            return real(rd, rid);
          },
          sleepFn: () => new Promise(() => {}),
        },
      });
      assert.equal(r.exitCode, 4, "4 压 3");
      assert.ok(r.outLines.some((l) => l.startsWith(`Stuck: the runner of ${goneId}`)), "3 的结局也打印");
      assert.ok(r.outLines.some((l) => l.startsWith(`Conflict: ${conflictId}`)), JSON.stringify(r.outLines));
    } finally {
      cleanupDir(dir);
    }
  }
  {
    const dir = makeRunDir();
    try {
      const vg = "run_m17c";
      const st = "run_m17d";
      const { events } = verifierEvents(vg);
      writeLines(dir, vg, events);
      writeLines(dir, st, [started(st, { delivery: false }), stateChange(st, "completed")]);
      let vgProofStarted = false;
      const r = await runWaitSettledMulti({
        dir, runIds: [vg, st],
        deps: {
          ...verifierProofDeps,
          verifierGoneFn: async () => {
            vgProofStarted = true;
            return { gone: true, basis: "lease_missing" };
          },
          // 同 M-02 的屏障：verifier 证明先开始（已开始就照常跑完出 3），收口
          // 目标的 0 随后同轮落地 → 3 压 0。
          readTranscriptFn: async (p) => {
            if (String(p).includes(st)) {
              while (!vgProofStarted) await new Promise((res) => setImmediate(res));
            }
            const { readTranscript } = await import("../../src/transcript.js");
            return readTranscript(p);
          },
          sleepFn: () => new Promise(() => {}),
        },
      });
      assert.equal(r.exitCode, 3, "3 压 0");
      assert.ok(r.outLines.some((l) => l.startsWith(`Stuck: the verification of ${vg}`)));
      assert.ok(r.outLines.includes(`Run: ${st} (completed)`));
    } finally {
      cleanupDir(dir);
    }
  }
});

test("M-18: 去重后 16 个目标被接受（17 个 argv、1 个重复）", async () => {
  const dir = makeRunDir();
  try {
    const ids = Array.from({ length: 16 }, (_, i) => `run_m18_${String(i).padStart(2, "0")}`);
    for (const id of ids) {
      writeLines(dir, id, id === ids[0]
        ? [started(id, { delivery: false }), stateChange(id, "completed")]
        : [started(id, { delivery: false })]);
    }
    const r = await runWaitSettledMulti({
      dir, runIds: [...ids, ids[0]], // 17 个 argv、去重后 16：不再报 at most 16
      deps: { sleepFn: () => new Promise(() => {}) },
    });
    assert.equal(r.exitCode, undefined, "1 个收口 → 0");
    const j = await runWaitSettledMulti({ dir, runIds: ids, asJson: true, deps: { sleepFn: () => new Promise(() => {}) } });
    const parsed = JSON.parse(j.out);
    assert.equal(parsed.multi, true);
    assert.equal(parsed.results.length, 1);
    assert.equal(parsed.remaining.length, 15, "15 个仍在等");
  } finally {
    cleanupDir(dir);
  }
});

// 第 136 批：多目标等待与单目标共用同一个终行渲染器——有交付的收口目标同样带
// 交付要点（文本 Delivery 行 / JSON delivery 对象）。
test("M-19: 多目标里有交付的收口目标 → 终行带 Delivery、results 项带 delivery（同一渲染器）", async () => {
  const dir = makeRunDir();
  try {
    const delivered = "run_m19a";
    const pending = "run_m19b";
    const ref = makeRefAt(delivered, U16_COMMIT, { changedFiles: U16_FILES });
    writeLines(dir, delivered, settledDeliveryEvents(delivered, ref));
    writeLines(dir, pending, [started(pending, { delivery: false })]);
    const r = await runWaitSettledMulti({ dir, runIds: [delivered, pending] });
    assert.equal(r.exitCode, undefined);
    const from = r.outLines.indexOf(`Run: ${delivered} (completed)`);
    assert.ok(from !== -1, JSON.stringify(r.outLines));
    assert.deepEqual(r.outLines.slice(from), [
      `Run: ${delivered} (completed)`,
      "Settlement: settled (delivery_settled; verification passed)",
      `Delivery: ${U16_COMMIT.slice(0, 12)} on ${U16_BASE.slice(0, 12)}, 5 file(s): ${U16_FILES.slice(0, 3).join(", ")}…`,
      `Next step: Settled. Delivery awaits the Lead's review: wao runs delivery review ${delivered} --all. Verification passed is not acceptance.`,
      `Still waiting: ${pending}`,
      `Re-arm: wao runs wait ${pending} --until-settled --run-dir ${dir}`,
    ]);
    const j = await runWaitSettledMulti({ dir, runIds: [delivered, pending], asJson: true });
    const parsed = JSON.parse(j.out);
    assert.deepEqual(parsed.remaining, [pending]);
    assert.deepEqual(Object.keys(parsed.results[0]), ["settled", "runId", "state", "settlement", "delivery", "nextStep"]);
    assert.deepEqual(parsed.results[0].delivery, {
      deliveryCommit: U16_COMMIT, baseCommit: U16_BASE, changedFileCount: 5, changedPaths: U16_FILES.slice(0, 3),
    });
  } finally {
    cleanupDir(dir);
  }
});
