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
      deps: { readTranscriptFn, nowFn: () => lastEventMs + 31 * 60_000 },
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
