// test/run-lifecycle/runNextStep.test.js
//
// 决定 0095（第 49 批）：nextStep 纯函数的分支、两面渲染与措辞纪律。
// 全部确定性、零 I/O。钉住：
//   - 每个情形闭集成员、两面（mcp/cli）各自渲染；
//   - MCP 面不含 runId；CLI 面带 runId；
//   - ≤480（引用 LEAD_ADVISORY_WIRE_MAX_LEN），超限抛错（用超长 runId 触发）；
//   - 不出现宿主名；不建议 accept/reject。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildNextStep,
  runWaitNextStep,
  NEXT_STEP_MAX_LEN,
  NEXT_STEP_SITUATIONS,
} from "../../src/application/runNextStep.js";
import { LEAD_ADVISORY_WIRE_MAX_LEN } from "../../src/application/runQuietAdvisory.js";

const RUN_ID = "run_20261029210000000nextstp";

test("NEXT-00: 上限常量与 leadAdvisory 同值（480），情形闭集冻结", () => {
  assert.equal(NEXT_STEP_MAX_LEN, LEAD_ADVISORY_WIRE_MAX_LEN);
  assert.equal(NEXT_STEP_MAX_LEN, 480);
  assert.ok(NEXT_STEP_SITUATIONS.includes("settled_line"));
});

test("NEXT-01: 等待类五支——两面渲染 + MCP 不含 runId + CLI 带 runId", () => {
  const cases = [
    { vitalSignAgeMs: 120_000, mcp: /Call run_wait again/, cli: /wao runs wait run_\S+ --until-settled/ },
    { vitalSignAgeMs: 700_000, mcp: /may be inside a long-running command[\s\S]*run_activity/, cli: /may be inside a long-running command[\s\S]*wao status run_/ },
    { vitalSignAgeMs: 31 * 60_000, mcp: /No new signs of life in the transcript for 31 min[\s\S]*run_stop is only for an explicit Lead decision/, cli: /No new signs of life in the transcript for 31 min[\s\S]*wao runs settle and wao stop/ },
    { vitalSignAgeMs: null, mcp: /not observable[\s\S]*run_status/, cli: /not observable[\s\S]*wao status run_/ },
  ];
  for (const c of cases) {
    const mcp = runWaitNextStep({ surface: "mcp", terminal: false, vitalSignAgeMs: c.vitalSignAgeMs });
    const cli = runWaitNextStep({ surface: "cli", terminal: false, vitalSignAgeMs: c.vitalSignAgeMs, runId: RUN_ID });
    assert.match(mcp, c.mcp);
    assert.match(cli, c.cli);
    assert.ok(!mcp.includes(RUN_ID), "MCP 面不含 runId");
    assert.ok(cli.includes(RUN_ID), "CLI 面带 runId");
    assert.ok(mcp.length <= NEXT_STEP_MAX_LEN && cli.length <= NEXT_STEP_MAX_LEN);
  }
  // 终态支：MCP 指向 run_delivery + 显式 waitMs；CLI 指向 --until-settled / runs delivery。
  const mcpT = runWaitNextStep({ surface: "mcp", terminal: true, vitalSignAgeMs: null });
  const cliT = runWaitNextStep({ surface: "cli", terminal: true, vitalSignAgeMs: null, runId: RUN_ID });
  assert.match(mcpT, /run_delivery with an explicit waitMs/);
  assert.match(cliT, /--until-settled/);
  assert.ok(!mcpT.includes(RUN_ID), "终态支 MCP 面也不含 runId");
});

test("NEXT-02: delivery_unsettled / dispatch_accepted 两类固定模板", () => {
  const delivery = buildNextStep({ surface: "mcp", situation: "delivery_unsettled" });
  assert.match(delivery, /not settled yet/);
  assert.match(delivery, /Call run_delivery again with waitMs/);
  assert.match(delivery, /Verification passed is not acceptance/);
  const dispatch = buildNextStep({ surface: "mcp", situation: "dispatch_accepted" });
  assert.match(dispatch, /Before ending the turn, keep a wait attached/);
  assert.match(dispatch, /call run_wait repeatedly/);
  const dispatchCli = buildNextStep({ surface: "cli", situation: "dispatch_accepted", runId: RUN_ID });
  assert.match(dispatchCli, /wao runs wait run_\S+ --until-settled/);
});

test("NEXT-03: 收口终行四支（CLI）——一律带 verification passed is not acceptance", () => {
  const line = (settlementReason, acceptanceStatus = null) => buildNextStep({
    surface: "cli", situation: "settled_line", runId: RUN_ID, settlementReason, acceptanceStatus,
  });
  assert.match(line("delivery_settled"), /Delivery awaits the Lead's review: wao runs delivery run_\S+/);
  assert.match(line("delivery_settled", "accepted"), /decision is recorded: accepted/);
  assert.match(line("delivery_settled", "rejected"), /decision is recorded: rejected/);
  assert.match(line("packaging_failed"), /packaging failed[\s\S]*wao runs diagnose run_\S+/);
  assert.match(line("isolation_failed"), /isolation failed \(workdir_escape\)[\s\S]*wao runs diagnose run_\S+/);
  assert.match(line("no_delivery_requested"), /No delivery was requested[\s\S]*wao collect run_\S+/);
  for (const r of ["delivery_settled", "packaging_failed", "isolation_failed", "no_delivery_requested"]) {
    assert.match(line(r), /Verification passed is not acceptance/, `${r} 终行必须带该句`);
  }
  // 未收口的 reason 不是 settled_line 的合法输入 → 抛错（fail closed）。
  assert.throws(() => line("verification_pending"), /settled settlementReason/);
});

test("NEXT-04: 输入校验——未知 surface/situation 抛错；CLI 面缺 runId 抛错", () => {
  assert.throws(() => buildNextStep({ surface: "web", situation: "wait_terminal" }), /surface/);
  assert.throws(() => buildNextStep({ surface: "mcp", situation: "nope" }), /situation/);
  assert.throws(() => buildNextStep({ surface: "cli", situation: "wait_terminal", runId: "" }), /runId/);
  assert.throws(() => buildNextStep({ surface: "cli", situation: "wait_terminal" }), /runId/);
});

test("NEXT-05: 480 上限——正常输入全部在限内；超限抛错（超长 runId 触发守卫）", () => {
  // 所有情形 × 两面 × 大龄数字均在限内（新情形按各自需要的入参渲染；
  // verifier_gone、runner_gone 与 runner_unproven 只有 CLI 面，MCP 面必须拒绝）。
  for (const situation of NEXT_STEP_SITUATIONS) {
    for (const surface of ["mcp", "cli"]) {
      if ((situation === "verifier_gone" || situation === "runner_gone" || situation === "runner_unproven") && surface === "mcp") {
        assert.throws(
          () => buildNextStep({ surface, situation }),
          /CLI-only/,
          `${situation} 在 MCP 面拒绝`,
        );
        continue;
      }
      const text = buildNextStep({
        surface,
        situation,
        ...(surface === "cli" ? { runId: RUN_ID } : {}),
        vitalSignAgeMs: 6 * 60 * 60 * 1000,
        settlementReason: "delivery_settled",
        acceptanceStatus: null,
        ...(situation === "consult_seats_running"
          ? { seatRunIds: [RUN_ID], consultId: "consult_20261029210000000abc123", seatCount: 1, nonTerminalSeatCount: 1 }
          : {}),
      });
      assert.ok(text.length <= NEXT_STEP_MAX_LEN, `${situation}/${surface}: ${text.length} > ${NEXT_STEP_MAX_LEN}`);
    }
  }
  // 守卫：CLI 模板内嵌 runId——超长 runId 使模板超限 → 抛错（不静默截断）。
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "wait_vital_recent", runId: "r".repeat(400), vitalSignAgeMs: 60_000 }),
    /exceeds 480/,
  );
});

test("NEXT-06: 措辞纪律——无宿主名、不建议 accept/reject、不把体征说成推进/停止结论", () => {
  const hosts = ["claude-code", "claude-desktop", "codex", "zcode", "kimi-web", "kimi-code", "opencode", "dsh"];
  const samples = [
    runWaitNextStep({ surface: "mcp", terminal: false, vitalSignAgeMs: 60_000 }),
    runWaitNextStep({ surface: "mcp", terminal: false, vitalSignAgeMs: 700_000 }),
    runWaitNextStep({ surface: "mcp", terminal: false, vitalSignAgeMs: 31 * 60_000 }),
    runWaitNextStep({ surface: "mcp", terminal: false, vitalSignAgeMs: null }),
    runWaitNextStep({ surface: "mcp", terminal: true, vitalSignAgeMs: null }),
    buildNextStep({ surface: "mcp", situation: "delivery_unsettled" }),
    buildNextStep({ surface: "mcp", situation: "dispatch_accepted" }),
    buildNextStep({ surface: "cli", situation: "settled_line", runId: RUN_ID, settlementReason: "delivery_settled" }),
    // 决定 0112：可续提示四句（两面 × 未决定/已拒收）。
    buildNextStep({ surface: "mcp", situation: "delivery_continuable", acceptanceStatus: null }),
    buildNextStep({ surface: "mcp", situation: "delivery_continuable", acceptanceStatus: "rejected" }),
    buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: RUN_ID, acceptanceStatus: null }),
    buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: RUN_ID, acceptanceStatus: "rejected" }),
  ];
  for (const text of samples) {
    for (const host of hosts) {
      assert.ok(!text.includes(host), `nextStep 不得出现宿主名 ${host}: ${text}`);
    }
    assert.ok(!/run_delivery_decide|\b(accept|accepts|reject|rejects)\b/i.test(text),
      `nextStep 不建议 accept/reject: ${text}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 决定 0096：两个新情形——verifier_gone（CLI 面）与 consult_seats_running
//（MCP 面不带任何具体 id；CLI 面列 runId，超长时改用不列 runId 的版本）。
// ═══════════════════════════════════════════════════════════════════════════

test("NEXT-07: verifier_gone——只有 CLI 面；按 acceptanceStatus 两支，均 ≤480", () => {
  const pending = buildNextStep({
    surface: "cli", situation: "verifier_gone", runId: RUN_ID, acceptanceStatus: "pending",
  });
  assert.match(pending, /Its verification will not finish\. Reject it while it is pending: wao runs delivery run_\S+ --reject --reason-file <FILE>\./);
  assert.match(pending, /adopt the delivery commit by hand under the adoption protocol \(wao manual delivery "验证失败采纳协议"\); wao runs delivery run_\S+ shows the commit\./);
  assert.ok(pending.length <= NEXT_STEP_MAX_LEN, `${pending.length}`);

  const rejected = buildNextStep({
    surface: "cli", situation: "verifier_gone", runId: RUN_ID, acceptanceStatus: "rejected",
  });
  assert.match(rejected, /already rejected; nothing is left to wait for/);
  assert.match(rejected, /adopt the delivery commit by hand under the adoption protocol/);
  assert.ok(!rejected.includes("--reject"), "已拒收不再建议拒收");
  assert.ok(rejected.length <= NEXT_STEP_MAX_LEN, `${rejected.length}`);

  assert.throws(
    () => buildNextStep({ surface: "mcp", situation: "verifier_gone" }),
    /CLI-only/,
    "MCP 面没有这项证明，也就没有这条 nextStep",
  );
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "verifier_gone" }),
    /runId/,
    "CLI 面仍需 runId 渲染命令",
  );
});

test("NEXT-08: consult_seats_running——MCP 面不落任何具体 id；CLI 面列 runId 并带 consultId", () => {
  const mcp = buildNextStep({
    surface: "mcp", situation: "consult_seats_running", seatCount: 5, nonTerminalSeatCount: 3,
  });
  assert.match(mcp, /^3 of 5 seats are not terminal yet\./);
  assert.match(mcp, /call run_wait repeatedly/);
  assert.match(mcp, /seats\[\]\.runId/);
  assert.match(mcp, /re-read this consult with run_consult and its consultId/);
  assert.ok(!mcp.includes(RUN_ID) && !/consult_\d/.test(mcp), "MCP 面不含 runId/consultId 字面");
  assert.ok(mcp.length <= NEXT_STEP_MAX_LEN);

  const consultId = "consult_20261029210000000abc123";
  const cli = buildNextStep({
    surface: "cli", situation: "consult_seats_running", seatRunIds: [RUN_ID], consultId,
  });
  assert.match(cli, new RegExp(`Seats not terminal yet: ${RUN_ID}\\.`));
  assert.match(cli, new RegExp(`wao consult wait ${consultId} --until-settled`), "CLI 面指向整场收口等待（consult wait --until-settled）");
  assert.ok(!cli.includes("wao runs wait"), "CLI 面不再让 Lead 逐席 runs wait");
  assert.match(cli, /in the background if your host notifies you when background commands finish; otherwise in the foreground/);
  assert.match(cli, new RegExp(`re-read with wao consult show ${consultId}\\.$`));
  assert.ok(cli.includes(RUN_ID) && cli.includes(consultId), "CLI 面列 runId 与 consultId");
  assert.ok(cli.length <= NEXT_STEP_MAX_LEN);
});

test("NEXT-09: consult_seats_running CLI 超长回退——8 席不列 runId（文本/JSON 两种说法），仍 ≤480", () => {
  const consultId = "consult_20261029210000000abc123";
  const runIds = Array.from({ length: 8 }, (_, i) => `run_2026102921000000${i}nextstp`);
  const listed = buildNextStep({
    surface: "cli", situation: "consult_seats_running", seatRunIds: runIds, consultId,
  });
  assert.ok(listed.length <= NEXT_STEP_MAX_LEN, `列 runId 的版本也必须在限内或回退：${listed.length}`);

  const text = buildNextStep({
    surface: "cli", situation: "consult_seats_running", seatRunIds: runIds, consultId, cliJson: false,
  });
  assert.match(text, /^Seats not terminal yet \(listed above\)\./);
  for (const runId of runIds) assert.ok(!text.includes(runId), `文本回退不列 runId: ${runId}`);
  assert.ok(text.includes(consultId), "仍指出重读命令");
  assert.ok(text.length <= NEXT_STEP_MAX_LEN, `${text.length}`);

  const json = buildNextStep({
    surface: "cli", situation: "consult_seats_running", seatRunIds: runIds, consultId, cliJson: true,
  });
  assert.match(json, /^Seats not terminal yet \(see seats\[\]\.runId\)\./);
  for (const runId of runIds) assert.ok(!json.includes(runId), `JSON 回退不列 runId: ${runId}`);
  assert.ok(json.length <= NEXT_STEP_MAX_LEN, `${json.length}`);

  // 入参校验：CLI 面必须给非空 seatRunIds 与 consultId；MCP 面必须给计数。
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "consult_seats_running", consultId }),
    /seatRunIds/,
  );
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "consult_seats_running", seatRunIds: [RUN_ID] }),
    /consultId/,
  );
  assert.throws(
    () => buildNextStep({ surface: "mcp", situation: "consult_seats_running", seatCount: 5 }),
    /seatCount and nonTerminalSeatCount/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 决定 0112：delivery_continuable——收口且未采纳的可续交付提示（MCP 面与 CLI
// --until-settled 收口终行各自渲染；acceptanceStatus 只有 null 与 "rejected"）。
// ═══════════════════════════════════════════════════════════════════════════

test("NEXT-10: delivery_continuable——两面 × 未决定/已拒收四句；acceptanceStatus 闭集；长度", () => {
  assert.ok(NEXT_STEP_SITUATIONS.includes("delivery_continuable"), "新情形进闭集");

  // MCP 未决定：不含 runId，说"未采纳 + 已采纳不可续"（谱系措辞：子运行自己
  // 不是带 continuable 派发的，它所在的谱系才是）。
  const mcpUndecided = buildNextStep({ surface: "mcp", situation: "delivery_continuable", acceptanceStatus: null });
  assert.match(mcpUndecided, /^Delivery settled\. Its lineage was dispatched continuable and it is not accepted: for a narrow fix, run_continue can resume the same worker conversation with its context loaded; it checks eligibility before changing anything\. An accepted delivery can no longer be continued\. Verification passed is not acceptance\.$/);
  assert.ok(!mcpUndecided.includes(RUN_ID), "MCP 面不含 runId");

  // MCP 已拒收：拒收版，不再说"未采纳"。
  const mcpRejected = buildNextStep({ surface: "mcp", situation: "delivery_continuable", acceptanceStatus: "rejected" });
  assert.match(mcpRejected, /^Delivery settled; the Lead decision is recorded: rejected\. Its lineage was dispatched continuable: for a narrow fix, run_continue can resume the same worker conversation with its context loaded; it checks eligibility before changing anything\. Verification passed is not acceptance\.$/);

  // CLI 未决定：带 runId（review 指向 + parentRunId）。
  const cliUndecided = buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: RUN_ID, acceptanceStatus: null });
  assert.match(cliUndecided, new RegExp(`^Settled\\. Delivery awaits the Lead's review: wao runs delivery ${RUN_ID}\\. Its lineage was dispatched continuable: for a narrow fix, the MCP tool run_continue \\(parentRunId ${RUN_ID}\\) can resume the same worker conversation; it checks eligibility before changing anything\\. An accepted delivery can no longer be continued\\. Verification passed is not acceptance\\.$`));

  // CLI 已拒收。
  const cliRejected = buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: RUN_ID, acceptanceStatus: "rejected" });
  assert.match(cliRejected, new RegExp(`^Settled\\. The Lead decision is recorded: rejected\\. Its lineage was dispatched continuable: for a narrow fix, the MCP tool run_continue \\(parentRunId ${RUN_ID}\\) can resume the same worker conversation; it checks eligibility before changing anything\\. Verification passed is not acceptance\\.$`));

  for (const text of [mcpUndecided, mcpRejected, cliUndecided, cliRejected]) {
    assert.ok(text.length <= NEXT_STEP_MAX_LEN, `${text.length} > ${NEXT_STEP_MAX_LEN}`);
  }

  // acceptanceStatus 闭集：只接受 null / "rejected"；服务侧的 "pending"（未决定）
  // 与 "accepted" 都必须由调用方转换/排除——这里直接抛错。
  assert.throws(
    () => buildNextStep({ surface: "mcp", situation: "delivery_continuable", acceptanceStatus: "pending" }),
    /null or "rejected"/,
  );
  assert.throws(
    () => buildNextStep({ surface: "mcp", situation: "delivery_continuable", acceptanceStatus: "accepted" }),
    /null or "rejected"/,
  );
  // CLI 面仍需 runId 渲染命令。
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "delivery_continuable", acceptanceStatus: null }),
    /runId/,
  );
});

// 第 83 批 B：runner_gone——非终态运行已无 runner 进程（CLI 面）。出口是
// settle（先 dry-run 看门、--apply 才写，记 failed / process_missing）或 stop，
// 只在 Lead 决定时用；交付请求过的运行，工作树里未提交的改动仍在，先看再定。
test("NEXT-11: runner_gone——只有 CLI 面；含 settle/stop 出口与 worktree 提醒，≤480", () => {
  const text = buildNextStep({ surface: "cli", situation: "runner_gone", runId: RUN_ID });
  assert.match(text, new RegExp(`^Nothing on this machine can still drive this run\\. The exits are wao runs settle --run-id ${RUN_ID} --reason-file <FILE> \\(the dry run lists the gate facts first; --apply writes them, recording failed / process_missing\\) or wao stop — only on an explicit Lead decision\\.`));
  assert.match(text, /If a delivery was requested, uncommitted changes may still be in the worktree: inspect them before deciding\.$/);
  assert.ok(text.length <= NEXT_STEP_MAX_LEN, `${text.length} > ${NEXT_STEP_MAX_LEN}`);
  // 措辞纪律：不建议 accept/reject，不出现宿主名。
  assert.ok(!/accept|reject/i.test(text), "不建议采纳/拒收");
  // MCP 面拒绝（CLI-only 情形——证明只在 CLI 等待器里做）。
  assert.throws(
    () => buildNextStep({ surface: "mcp", situation: "runner_gone" }),
    /CLI-only/,
  );
  // CLI 面仍需 runId 渲染命令。
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "runner_gone" }),
    /runId/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// B91：verifier_gone 按 terminalState 分支——终态 failed（只有重新打包的交付
// 走到这里）且未决定时渲染指向再调 run_delivery_repackage 的新文案；completed
// 形状与已拒收文案逐字不变。仍只有 CLI 面、仍 ≤480。
// ═══════════════════════════════════════════════════════════════════════════

test("NEXT-12 (B91): verifier_gone 的 terminalState 分支——failed 未决定的新文案；completed 两支逐字不变", () => {
  // 终态 failed、未决定：新文案（再调 run_delivery_repackage 重跑验证 + pending 拒收出口）。
  const failed = buildNextStep({
    surface: "cli", situation: "verifier_gone", runId: RUN_ID,
    acceptanceStatus: "pending", terminalState: "failed",
  });
  assert.match(failed, /^Its verification is no longer running\. Call the MCP tool run_delivery_repackage again with the same runId, allowedPaths and expectedWorkspaceRoot: it runs the verification again and will not create a second commit\. Or reject it while it is pending: wao runs delivery run_\S+ --reject --reason-file <FILE>\.$/);
  assert.ok(failed.length <= NEXT_STEP_MAX_LEN, `${failed.length}`);

  // completed、未决定：旧文案逐字不变（terminalState 缺省即 completed 形状）。
  const completedPending = buildNextStep({
    surface: "cli", situation: "verifier_gone", runId: RUN_ID, acceptanceStatus: "pending",
  });
  assert.match(completedPending, /^Its verification will not finish\. Reject it while it is pending: wao runs delivery run_\S+ --reject --reason-file <FILE>\./);
  assert.ok(!completedPending.includes("run_delivery_repackage"), "completed 形状不指向 repackage");

  // 已拒收：failed 与 completed 同用现有 rejected 文案（已有决定后 repackage 会拒绝）。
  const rejectedFailed = buildNextStep({
    surface: "cli", situation: "verifier_gone", runId: RUN_ID,
    acceptanceStatus: "rejected", terminalState: "failed",
  });
  const rejectedCompleted = buildNextStep({
    surface: "cli", situation: "verifier_gone", runId: RUN_ID,
    acceptanceStatus: "rejected",
  });
  assert.match(rejectedFailed, /already rejected; nothing is left to wait for/);
  assert.equal(rejectedFailed, rejectedCompleted, "已拒收两条形状同文案");
  assert.ok(!rejectedFailed.includes("run_delivery_repackage"), "已拒收不再指向 repackage");

  // 仍只有 CLI 面。
  assert.throws(() => buildNextStep({ surface: "mcp", situation: "verifier_gone", terminalState: "failed" }), /CLI-only/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 107 批：runner_unproven——证明不了 runner 已不在（静默满 30 分钟 + 未知类
// 拒绝，退出码 5）。先看状态、再干跑 settle 看门事实（不写任何东西）；停/结算/
// 重挂都归 Lead。只有 CLI 面。
// ═══════════════════════════════════════════════════════════════════════════

test("NEXT-13: runner_unproven——只有 CLI 面；先 status 再干跑 settle，出口归 Lead，≤480", () => {
  assert.ok(NEXT_STEP_SITUATIONS.includes("runner_unproven"), "新情形进闭集");
  const text = buildNextStep({ surface: "cli", situation: "runner_unproven", runId: RUN_ID });
  assert.match(text, new RegExp(`^The runner's absence cannot be proven, so the run may still change\\. First check wao status ${RUN_ID}, then dry-run wao runs settle --run-id ${RUN_ID} --reason-file <FILE> to see the gate facts \\(it writes nothing\\)\\.`));
  assert.match(text, new RegExp(`The Lead then decides: stop it \\(wao stop with the --observed-seq from status and a reason; once stopped, a continuable lineage can go on via the MCP tool run_continue\\), settle it, or attach the wait again\\.$`));
  assert.ok(text.length <= NEXT_STEP_MAX_LEN, `${text.length} > ${NEXT_STEP_MAX_LEN}`);
  // 措辞纪律：不断言 runner 已死、不说等待不会改变事实；不建议 accept/reject。
  assert.ok(!/gone|dead|will not change/i.test(text), "不断言已死/等待无效");
  assert.ok(!/run_delivery_decide|\b(accept|accepts|reject|rejects)\b/i.test(text), "不建议 accept/reject");
  // MCP 面拒绝（CLI-only 情形——报警等待器只在 CLI 面）。
  assert.throws(
    () => buildNextStep({ surface: "mcp", situation: "runner_unproven" }),
    /CLI-only/,
  );
  // CLI 面仍需 runId 渲染命令。
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "runner_unproven" }),
    /runId/,
  );
  // 超长 runId 触发上限守卫（模板内嵌两次 runId）。
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "runner_unproven", runId: "r".repeat(240) }),
    /exceeds 480/,
  );
});
