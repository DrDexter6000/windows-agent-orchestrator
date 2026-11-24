// test/run-lifecycle/runNextStep.test.js
//
// 决定 0095（第 49 批）：nextStep 纯函数的分支、两面渲染与措辞纪律。
// 全部确定性、零 I/O。钉住：
//   - 每个情形闭集成员、两面（mcp/cli）各自渲染；
//   - MCP 面不落 id——唯一的例外是第 136 批补的 CLI 命令半句（派发/续修的
//     runId、consult 的 consultId），先 MCP 写法后 CLI 写法；CLI 面带 runId；
//   - ≤480（引用 LEAD_ADVISORY_WIRE_MAX_LEN），超限抛错（用超长 runId 触发）；
//   - 不出现宿主名；不建议 accept/reject。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildNextStep,
  buildInterruptedRerunNextStep,
  runWaitNextStep,
  NEXT_STEP_MAX_LEN,
  NEXT_STEP_SITUATIONS,
} from "../../src/application/runNextStep.js";
import { LEAD_ADVISORY_WIRE_MAX_LEN } from "../../src/application/runQuietAdvisory.js";
import { CONTINUE_INHERITED_DELIVERY_NOTE } from "../../src/application/runContinue.js";

const RUN_ID = "run_20261029210000000nextstp";

test("NEXT-00: 上限常量与 leadAdvisory 同值（480），情形闭集冻结", () => {
  assert.equal(NEXT_STEP_MAX_LEN, LEAD_ADVISORY_WIRE_MAX_LEN);
  assert.equal(NEXT_STEP_MAX_LEN, 480);
  assert.ok(NEXT_STEP_SITUATIONS.includes("settled_line"));
});

test("NEXT-01: 等待类五支——只有 CLI 渲染（MCP 面已无调用方，119 续修 3）", () => {
  const cases = [
    { vitalSignAgeMs: 120_000, cli: /Signs of life were last observed 2 min ago[\s\S]*wao runs wait run_\S+ --until-settled/ },
    { vitalSignAgeMs: 700_000, cli: /may be inside a long-running command[\s\S]*wao status run_/ },
    { vitalSignAgeMs: 31 * 60_000, cli: /No new signs of life in the transcript for 31 min[\s\S]*wao runs settle and wao stop/ },
    { vitalSignAgeMs: null, cli: /not observable[\s\S]*wao status run_/ },
  ];
  for (const c of cases) {
    const cli = runWaitNextStep({ surface: "cli", terminal: false, vitalSignAgeMs: c.vitalSignAgeMs, runId: RUN_ID });
    assert.match(cli, c.cli);
    assert.ok(cli.includes(RUN_ID), "CLI 面带 runId");
    assert.ok(cli.length <= NEXT_STEP_MAX_LEN);
  }
  // 终态支：CLI 指向 --until-settled / runs delivery。
  const cliT = runWaitNextStep({ surface: "cli", terminal: true, vitalSignAgeMs: null, runId: RUN_ID });
  assert.match(cliT, /--until-settled/);
  assert.match(cliT, /wao runs delivery/);
  // 等待族五支已 CLI-only：MCP 面请求直接抛错（原 MCP run_wait 工具删除后无调用方，
  // MCP 面从终态到交付收口的一跳由 run_await_result 的 availableDrilldowns 承载）。
  for (const args of [
    { surface: "mcp", terminal: false, vitalSignAgeMs: 120_000 },
    { surface: "mcp", terminal: true, vitalSignAgeMs: null },
  ]) {
    assert.throws(() => runWaitNextStep(args), /CLI-only/,
      "wait-family situations must refuse surface \"mcp\" (no MCP caller exists)");
  }
});

test("NEXT-02: delivery_unsettled / dispatch_accepted 两类固定模板", () => {
  const delivery = buildNextStep({ surface: "mcp", situation: "delivery_unsettled" });
  assert.match(delivery, /not settled yet/);
  assert.match(delivery, /Call run_delivery again with waitMs/);
  assert.match(delivery, /Verification passed is not acceptance/);
  const dispatch = buildNextStep({ surface: "mcp", situation: "dispatch_accepted", runId: RUN_ID });
  assert.match(dispatch, /Before ending the turn, keep a wait attached/);
  assert.match(dispatch, /call run_await_result repeatedly with its default waitMs/);
  // TD-364：引导句不再写上限数字（桌面宿主约 60s 超时，照旧文案做必超时）。
  assert.ok(!dispatch.includes("270000"), "不写 waitMs 上限数字");
  // 第 136 批：MCP 写法在前、CLI 写法在后——宿主有后台命令行时，一条命令等到
  // 收口；CLI 半句带这次受理的 runId（MCP 面唯一落 id 的地方）。
  assert.equal(dispatch,
    `Background run accepted. Before ending the turn, keep a wait attached: call run_await_result repeatedly with its default waitMs on this run until it settles. If your host has a background shell, you can instead run wao runs wait ${RUN_ID} --until-settled there; one command waits until settlement.`);
  assert.equal(dispatch.split(RUN_ID).length - 1, 1, "runId 只出现在那条 CLI 命令里");
  assert.ok(dispatch.length <= NEXT_STEP_MAX_LEN);
  const dispatchCli = buildNextStep({ surface: "cli", situation: "dispatch_accepted", runId: RUN_ID });
  assert.match(dispatchCli, /wao runs wait run_\S+ --until-settled/);
});

test("NEXT-03: 收口终行四支（CLI）——一律带 verification passed is not acceptance", () => {
  const line = (settlementReason, acceptanceStatus = null) => buildNextStep({
    surface: "cli", situation: "settled_line", runId: RUN_ID, settlementReason, acceptanceStatus,
  });
  assert.match(line("delivery_settled"), /Delivery awaits the Lead's review: wao runs delivery review run_\S+ --all\./);
  // 第 136 批：审查命令直接给能一次读完的那条，不再先指向 runs delivery 查询。
  assert.ok(!line("delivery_settled").includes(": wao runs delivery run_"), "不再先指向 runs delivery 查询");
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
  // 等待族五支（wait_*，119 续修 3 起）与等待器证明三支只有 CLI 面，
  // MCP 面必须拒绝）。
  const CLI_ONLY = new Set([
    "wait_vital_recent", "wait_vital_ageing", "wait_vital_quiet",
    "wait_vital_unobservable", "wait_terminal",
    "verifier_gone", "runner_gone", "runner_unproven",
  ]);
  for (const situation of NEXT_STEP_SITUATIONS) {
    for (const surface of ["mcp", "cli"]) {
      if (CLI_ONLY.has(situation) && surface === "mcp") {
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
        runId: RUN_ID,
        vitalSignAgeMs: 6 * 60 * 60 * 1000,
        settlementReason: "delivery_settled",
        acceptanceStatus: null,
        ...(situation === "delivery_superseded" ? { supersededByRunId: RUN_ID } : {}),
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
  // 第 136 批续修：MCP 面的 dispatch_accepted 内嵌 runId（CLI 半句）——半句放得下
  // 才加，超长 runId 不抛错（已经受理的派发不能变成报错）；MCP 写法本身恒在限内。
  // 不静默截断：返回的是完整的 MCP 写法，id 不被改写。
  const longIdDispatch = buildNextStep({ surface: "mcp", situation: "dispatch_accepted", runId: "r".repeat(400) });
  assert.equal(longIdDispatch,
    "Background run accepted. Before ending the turn, keep a wait attached: call run_await_result repeatedly with its default waitMs on this run until it settles.");
});

test("NEXT-06: 措辞纪律——无宿主名、不建议 accept/reject、不把体征说成推进/停止结论", () => {
  const hosts = ["claude-code", "claude-desktop", "codex", "zcode", "kimi-web", "kimi-code", "opencode", "dsh"];
  const samples = [
    // 119 续修 3：等待族五支只有 CLI 面（MCP 样本换成仍在 MCP 面渲染的情形）。
    runWaitNextStep({ surface: "cli", terminal: false, vitalSignAgeMs: 60_000, runId: RUN_ID }),
    runWaitNextStep({ surface: "cli", terminal: false, vitalSignAgeMs: 700_000, runId: RUN_ID }),
    runWaitNextStep({ surface: "cli", terminal: false, vitalSignAgeMs: 31 * 60_000, runId: RUN_ID }),
    runWaitNextStep({ surface: "cli", terminal: false, vitalSignAgeMs: null, runId: RUN_ID }),
    runWaitNextStep({ surface: "cli", terminal: true, vitalSignAgeMs: null, runId: RUN_ID }),
    buildNextStep({ surface: "mcp", situation: "delivery_unsettled" }),
    buildNextStep({ surface: "mcp", situation: "dispatch_accepted", runId: RUN_ID }),
    buildNextStep({
      surface: "mcp", situation: "consult_seats_running",
      seatCount: 1, nonTerminalSeatCount: 1, consultId: "consult_20261029210000000abc123",
    }),
    buildNextStep({ surface: "cli", situation: "settled_line", runId: RUN_ID, settlementReason: "delivery_settled" }),
    // 决定 0112：可续提示四句（两面 × 未决定/已拒收）。
    buildNextStep({ surface: "mcp", situation: "delivery_continuable", acceptanceStatus: null }),
    buildNextStep({ surface: "mcp", situation: "delivery_continuable", acceptanceStatus: "rejected" }),
    buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: RUN_ID, acceptanceStatus: null }),
    buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: RUN_ID, acceptanceStatus: "rejected" }),
    // 第 120 批：被取代的一面一句。
    buildNextStep({ surface: "mcp", situation: "delivery_superseded", supersededByRunId: "run_20261029210000000child01" }),
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
//（MCP 面不落席位 id，只在第 136 批补的 CLI 命令半句里带 consultId；CLI 面列
// runId，超长时改用不列 runId 的版本）。
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

test("NEXT-08: consult_seats_running——MCP 面不落席位 id、只在 CLI 命令里带 consultId；CLI 面列 runId 并带 consultId", () => {
  const consultId = "consult_20261029210000000abc123";
  const mcp = buildNextStep({
    surface: "mcp", situation: "consult_seats_running", seatCount: 5, nonTerminalSeatCount: 3, consultId,
  });
  assert.match(mcp, /^3 of 5 seats are not terminal yet\./);
  assert.match(mcp, /call run_await_result repeatedly with its default waitMs/);
  assert.ok(!mcp.includes("270000"), "TD-364：不写 waitMs 上限数字");
  assert.match(mcp, /seats\[\]\.runId/);
  assert.match(mcp, /re-read this consult with run_consult and its consultId\./);
  // 第 136 批：MCP 写法在前、CLI 写法在后——宿主有后台命令行时一条命令等全部席位。
  assert.match(mcp, new RegExp(
    ` If your host has a background shell, you can instead run wao consult wait ${consultId} --until-settled there; one command waits for all seats\\.$`));
  assert.ok(!mcp.includes(RUN_ID), "MCP 面不落席位 runId");
  assert.equal(mcp.split(consultId).length - 1, 1, "consultId 只出现在那条 CLI 命令里");
  assert.ok(mcp.length <= NEXT_STEP_MAX_LEN);

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
  // 第 136 批：MCP 面靠 consultId 渲染 CLI 命令——计数齐全但缺 consultId 抛错。
  assert.throws(
    () => buildNextStep({ surface: "mcp", situation: "consult_seats_running", seatCount: 5, nonTerminalSeatCount: 1 }),
    /consultId/,
  );
  // MCP 面的 dispatch_accepted 靠 runId 渲染 CLI 命令——缺 runId 抛错。
  assert.throws(
    () => buildNextStep({ surface: "mcp", situation: "dispatch_accepted" }),
    /runId/,
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

  // CLI 未决定：带 runId（审查命令 + 续修命令）。第 136 批续修：审查命令让模板
  // 长了 13 字符，别处改短 28 字符——同一长度的 runId 不比改动前更早触顶。
  // 第 137a 批：续修写 CLI 命令 wao runs continue（CLI 有入口了，不再点名 MCP 工具）。
  const cliUndecided = buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: RUN_ID, acceptanceStatus: null });
  assert.equal(cliUndecided,
    `Settled. Delivery awaits the Lead's review: wao runs delivery review ${RUN_ID} --all. Its lineage was dispatched continuable: for a narrow fix, wao runs continue ${RUN_ID} --prompt-file <FILE> can resume the same worker conversation; it checks eligibility first. An accepted delivery cannot be continued. Verification passed is not acceptance.`);
  // 76 字符的可续 runId（会审 sol 用 65 字符复现了触顶：改动前 469、改审查命令后
  // 482）——现在整句仍在限内；再长仍照旧抛错（不改上限、不截断 id）。
  const id76 = "run_" + "y".repeat(72);
  const fits76 = buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: id76, acceptanceStatus: null });
  assert.ok(fits76.length <= NEXT_STEP_MAX_LEN, `${fits76.length} > ${NEXT_STEP_MAX_LEN}`);
  assert.ok(fits76.includes(`wao runs delivery review ${id76} --all.`));
  // 第 137a 批：runId 触顶长度不短于改前——77 字符仍放得下，78 字符照旧抛错。
  const id77 = "run_" + "y".repeat(73);
  assert.ok(buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: id77, acceptanceStatus: null }).length <= NEXT_STEP_MAX_LEN);
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: "run_" + "y".repeat(74), acceptanceStatus: null }),
    /exceeds 480/,
  );
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: "run_" + "y".repeat(75), acceptanceStatus: null }),
    /exceeds 480/,
  );

  // CLI 已拒收（第 137a 批：续修同样写 CLI 命令）。
  const cliRejected = buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: RUN_ID, acceptanceStatus: "rejected" });
  assert.match(cliRejected, new RegExp(`^Settled\\. The Lead decision is recorded: rejected\\. Its lineage was dispatched continuable: for a narrow fix, wao runs continue ${RUN_ID} --prompt-file <FILE> can resume the same worker conversation; it checks eligibility before changing anything\\. Verification passed is not acceptance\\.$`));

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
// 走到这里）且未决定时渲染指向 `wao runs delivery repackage` 的新文案（第 137a 批
// 起 CLI 面写 CLI 命令）；completed
// 形状与已拒收文案逐字不变。仍只有 CLI 面、仍 ≤480。
// ═══════════════════════════════════════════════════════════════════════════

test("NEXT-12 (B91): verifier_gone 的 terminalState 分支——failed 未决定的新文案；completed 两支逐字不变", () => {
  // 终态 failed、未决定：新文案（再跑一次验证 + pending 拒收出口）。第 137a 批：
  // CLI 面写 CLI 命令 wao runs delivery repackage（它有了入口），不再点名 MCP 工具。
  // 续修 1（会审 kimi、sol）：带 --cwd <workspace root> 占位（照抄到另一棵工作树的
  // 交付不会被归属门拒绝）；句中只出现一次真实 runId（拒收命令里），重新打包命令用
  // <runId> 占位——runId 触顶长度回到不少于改前的 182（见 NEXT-20）。
  const failed = buildNextStep({
    surface: "cli", situation: "verifier_gone", runId: RUN_ID,
    acceptanceStatus: "pending", terminalState: "failed",
  });
  assert.match(failed, /^Its verification is no longer running\. Call wao runs delivery repackage <runId> --allowed-path <path>\.\.\. --cwd <workspace root> \(the same allowed paths\) to re-run the verification without creating a second commit\. Or reject it while it is pending: wao runs delivery run_\S+ --reject --reason-file <FILE>\.$/);
  assert.ok(failed.length <= NEXT_STEP_MAX_LEN, `${failed.length}`);

  // completed、未决定：旧文案逐字不变（terminalState 缺省即 completed 形状）。
  const completedPending = buildNextStep({
    surface: "cli", situation: "verifier_gone", runId: RUN_ID, acceptanceStatus: "pending",
  });
  assert.match(completedPending, /^Its verification will not finish\. Reject it while it is pending: wao runs delivery run_\S+ --reject --reason-file <FILE>\./);
  assert.ok(!/repackage/.test(completedPending), "completed 形状不指向 repackage");

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
  assert.ok(!/repackage/.test(rejectedFailed), "已拒收不再指向 repackage");

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
  // 第 137a 批：续修写 CLI 命令 wao runs continue；命令比工具名长，同句别处改短
  // （"to see … (it writes nothing)" → "for … (writes nothing)"、"The Lead then
  // decides" → "The Lead decides"、"attach the wait again" → "re-attach the wait"）。
  const text = buildNextStep({ surface: "cli", situation: "runner_unproven", runId: RUN_ID });
  assert.match(text, new RegExp(`^The runner's absence cannot be proven, so the run may still change\\. First check wao status ${RUN_ID}, then dry-run wao runs settle --run-id ${RUN_ID} --reason-file <FILE> for the gate facts \\(writes nothing\\)\\.`));
  assert.match(text, new RegExp(`The Lead decides: stop it \\(wao stop with the --observed-seq from status and a reason; then a continuable lineage can resume via wao runs continue <runId> --prompt-file <FILE>\\), settle it, or re-attach the wait\\.$`));
  assert.ok(text.length <= NEXT_STEP_MAX_LEN, `${text.length} > ${NEXT_STEP_MAX_LEN}`);
  // 第 137a 批：runId 触顶长度不短于改前（39 字符；runId 在句中出现两次）。
  const id39 = "run_" + "y".repeat(35);
  assert.ok(buildNextStep({ surface: "cli", situation: "runner_unproven", runId: id39 }).length <= NEXT_STEP_MAX_LEN);
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

// ═══════════════════════════════════════════════════════════════════════════
// 第 120 批：delivery_superseded——收口的交付已有被采纳的后代（派生事实）。
// 两面同一句：只说"已有被采纳的后代 <runId>、这里无需裁决"，不说祖先已被
// 采纳/已合入/已回收，也不再提示 run_delivery review 或 run_continue。
// ═══════════════════════════════════════════════════════════════════════════

test("NEXT-14: delivery_superseded——两面同一句、点名被采纳的后代、不给 review/续修提示", () => {
  assert.ok(NEXT_STEP_SITUATIONS.includes("delivery_superseded"), "新情形进闭集");
  const DESCENDANT = "run_20261029210000000child01";
  const mcp = buildNextStep({
    surface: "mcp", situation: "delivery_superseded", supersededByRunId: DESCENDANT,
  });
  const cli = buildNextStep({
    surface: "cli", situation: "delivery_superseded", runId: RUN_ID, supersededByRunId: DESCENDANT,
  });
  assert.equal(mcp, cli, "两面同一句（不渲染 CLI 命令，故无需区分）");
  assert.equal(mcp,
    `Settled. A descendant of this run was already accepted (${DESCENDANT}); no Lead decision is needed here.`);
  assert.ok(mcp.includes(DESCENDANT), "点名被采纳的后代");
  assert.ok(!mcp.includes(RUN_ID), "不说本 run 的 runId");
  assert.ok(!/awaits the Lead's review/.test(mcp), "不再说等 Lead 裁决");
  assert.ok(!/run_continue|wao runs delivery/.test(mcp), "不给续修/再审查提示");
  assert.ok(!/merged|reclaimed|landed|adopted/i.test(mcp), "不说已合入/已回收/已采纳");
  assert.ok(mcp.length <= NEXT_STEP_MAX_LEN, `${mcp.length}`);

  // 必须点名那个后代（缺/空 fail closed）。
  assert.throws(() => buildNextStep({ surface: "mcp", situation: "delivery_superseded" }), /supersededByRunId/);
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "delivery_superseded", runId: RUN_ID, supersededByRunId: "" }),
    /supersededByRunId/,
  );
  // CLI 面仍需 runId 渲染（既有合同不变）。
  assert.throws(() => buildNextStep({ surface: "cli", situation: "delivery_superseded", supersededByRunId: DESCENDANT }), /runId/);
  // 超长后代 runId 触发上限守卫（不静默截断）。
  assert.throws(
    () => buildNextStep({ surface: "mcp", situation: "delivery_superseded", supersededByRunId: "r".repeat(500) }),
    /exceeds 480/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 136 批续修：MCP 面的 CLI 半句只在**最终上线的整句**（含调用方追加的后缀）
// 不超上限时才加，放不下就不加——合法的长 id 不能让已经受理的结果变成报错
//（派发已调用、续修已受理、会审记录已读到）。MCP 写法与后缀照旧；不改上限、
// 不截断 id。
// ═══════════════════════════════════════════════════════════════════════════

const DISPATCH_BASE = "Background run accepted. Before ending the turn, keep a wait attached: call run_await_result repeatedly with its default waitMs on this run until it settles.";
const ADVISORIES_SUFFIX = " Review contractAdvisories in this receipt first; stop and re-dispatch if needed.";
const INHERITED_SUFFIX = " Delivery contract inherited from the parent run.";
const dispatchCliClause = (runId) =>
  ` If your host has a background shell, you can instead run wao runs wait ${runId} --until-settled there; one command waits until settlement.`;

const ofLength = (prefix, total, filler) => prefix + filler.repeat(total - prefix.length);
const dispatchMcp = (runId, suffix) => buildNextStep({ surface: "mcp", situation: "dispatch_accepted", runId, suffix });

test("NEXT-15: MCP 派发/续修——CLI 半句按整句（含后缀）定去留；长 runId 不抛错", () => {
  // 短 id：半句与合同提醒后缀都放得下——顺序仍是 MCP 写法、CLI 半句、后缀。
  assert.equal(dispatchMcp(RUN_ID, ADVISORIES_SUFFIX), DISPATCH_BASE + dispatchCliClause(RUN_ID) + ADVISORIES_SUFFIX);

  // 边界（合同提醒后缀 81 字符）：111 字符恰好放得下（整句 480），112 字符就放不下。
  const id111 = ofLength("run_", 111, "x");
  const fits111 = dispatchMcp(id111, ADVISORIES_SUFFIX);
  assert.equal(fits111, DISPATCH_BASE + dispatchCliClause(id111) + ADVISORIES_SUFFIX);
  assert.equal(fits111.length, NEXT_STEP_MAX_LEN);
  const id112 = ofLength("run_", 112, "x");
  assert.equal(dispatchMcp(id112, ADVISORIES_SUFFIX), DISPATCH_BASE + ADVISORIES_SUFFIX, "放不下就不加 CLI 半句");
  // 同一个 112 字符 id、没有后缀时放得下——半句的去留看的是整句，不是半句本身。
  assert.equal(dispatchMcp(id112), DISPATCH_BASE + dispatchCliClause(id112));

  // 120 字符（会审 kimi 复现的长度：旧实现先渲染半句得 408、再拼后缀成 489）：
  // 现在一起算——整句 489 放不下，不加半句，MCP 写法与后缀照旧。
  const id120 = ofLength("run_", 120, "x");
  assert.equal(dispatchMcp(id120, ADVISORIES_SUFFIX), DISPATCH_BASE + ADVISORIES_SUFFIX);

  // 150 字符 + 合同提醒后缀：同样不加；整句 ≤ 480。
  const id150 = ofLength("run_", 150, "x");
  const dropped = dispatchMcp(id150, ADVISORIES_SUFFIX);
  assert.equal(dropped, DISPATCH_BASE + ADVISORIES_SUFFIX);
  assert.ok(!dropped.includes("wao runs wait"), "放不下就不加 CLI 半句");
  assert.ok(dropped.length <= NEXT_STEP_MAX_LEN, `${dropped.length}`);
  // 150 字符 + 续修的继承后缀（51 字符）：整句 489，同样不加；141 字符恰好放得下。
  assert.equal(dispatchMcp(id150, INHERITED_SUFFIX), DISPATCH_BASE + INHERITED_SUFFIX);
  const id141 = ofLength("run_", 141, "x");
  assert.equal(dispatchMcp(id141, INHERITED_SUFFIX), DISPATCH_BASE + dispatchCliClause(id141) + INHERITED_SUFFIX);
  // 同一个 150 字符 id、没有后缀时放得下（438）。
  assert.equal(dispatchMcp(id150), DISPATCH_BASE + dispatchCliClause(id150));

  // 后缀只接受字符串（实现错误响亮失败）。
  assert.throws(() => dispatchMcp(RUN_ID, 42), /suffix/);
});

test("NEXT-16: MCP 会审——128 字符 consultId（入参 schema 上限）不抛错；CLI 半句放不下就不加", () => {
  const base = "1 of 2 seats are not terminal yet. Before ending the turn, keep a wait attached: call run_await_result repeatedly with its default waitMs on each such seat's runId (seats[].runId) until it is terminal, then re-read this consult with run_consult and its consultId.";
  const id128 = "consult_" + "c".repeat(120);
  assert.equal(id128.length, 128);
  const long = buildNextStep({
    surface: "mcp", situation: "consult_seats_running", seatCount: 2, nonTerminalSeatCount: 1, consultId: id128,
  });
  assert.equal(long, base, "放不下就不加 CLI 半句——MCP 写法照旧");
  assert.ok(long.length <= NEXT_STEP_MAX_LEN, `${long.length}`);
  // 98 字符（会审复现区间的下沿）同样放不下；31 字符的真实 id 放得下。
  const id98 = "consult_" + "c".repeat(90);
  assert.equal(buildNextStep({
    surface: "mcp", situation: "consult_seats_running", seatCount: 2, nonTerminalSeatCount: 1, consultId: id98,
  }), base);
  const real = "consult_20261030071437756abc123";
  assert.equal(buildNextStep({
    surface: "mcp", situation: "consult_seats_running", seatCount: 2, nonTerminalSeatCount: 1, consultId: real,
  }), `${base} If your host has a background shell, you can instead run wao consult wait ${real} --until-settled there; one command waits for all seats.`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 137a 批：CLI 有了 continue / delivery repackage 入口——CLI 面一律写 CLI
// 命令、不再点名 MCP 工具；MCP 面照旧写工具名。
// ═══════════════════════════════════════════════════════════════════════════

test("NEXT-17: CLI 面不点名 MCP 工具（可续收口两支、verifier_gone 的 failed 支、runner_unproven）；MCP 面照旧写工具名", () => {
  const cliTexts = [
    buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: RUN_ID, acceptanceStatus: null }),
    buildNextStep({ surface: "cli", situation: "delivery_continuable", runId: RUN_ID, acceptanceStatus: "rejected" }),
    buildNextStep({ surface: "cli", situation: "verifier_gone", runId: RUN_ID, acceptanceStatus: "pending", terminalState: "failed" }),
    buildNextStep({ surface: "cli", situation: "runner_unproven", runId: RUN_ID }),
  ];
  for (const text of cliTexts) {
    assert.ok(!/MCP tool|run_continue|run_delivery_repackage/.test(text), `CLI 面不再点名 MCP 工具：${text}`);
    assert.ok(text.includes("wao runs "), "CLI 面写 CLI 命令");
  }
  assert.ok(cliTexts[0].includes(`wao runs continue ${RUN_ID} --prompt-file <FILE>`));
  // 续修 1：重新打包命令带 --cwd 占位、用 <runId> 占位（真实 id 在拒收命令里）。
  assert.ok(cliTexts[2].includes("wao runs delivery repackage <runId> --allowed-path <path>... --cwd <workspace root>"));
  // MCP 面照旧：写工具名、不含 runId、不写续修的 CLI 命令。
  const mcpUndecided = buildNextStep({ surface: "mcp", situation: "delivery_continuable", acceptanceStatus: null });
  const mcpRejected = buildNextStep({ surface: "mcp", situation: "delivery_continuable", acceptanceStatus: "rejected" });
  for (const text of [mcpUndecided, mcpRejected]) {
    assert.ok(/run_continue can resume the same worker conversation/.test(text));
    assert.ok(!/wao runs continue/.test(text), "MCP 面不写续修的 CLI 命令");
    assert.ok(!text.includes(RUN_ID));
  }
});

test("NEXT-18: CLI 面的 dispatch_accepted 接后缀（续修受理时写明继承合同）；没有后缀时逐字不变", () => {
  const base = `Background run accepted. Before ending the turn, keep a wait attached: wao runs wait ${RUN_ID} --until-settled.`;
  assert.equal(buildNextStep({ surface: "cli", situation: "dispatch_accepted", runId: RUN_ID }), base);
  // 继承合同那半句与 MCP 面同一个常量（两处同一份文案）。
  assert.equal(INHERITED_SUFFIX, CONTINUE_INHERITED_DELIVERY_NOTE);
  assert.equal(
    buildNextStep({ surface: "cli", situation: "dispatch_accepted", runId: RUN_ID, suffix: CONTINUE_INHERITED_DELIVERY_NOTE }),
    `${base} Delivery contract inherited from the parent run.`,
  );
  // 后缀也计入长度上限（实现错误响亮失败，不静默截断）。
  assert.throws(
    () => buildNextStep({ surface: "cli", situation: "dispatch_accepted", runId: RUN_ID, suffix: "x".repeat(480) }),
    /exceeds 480/,
  );
});

test("NEXT-19: 有界等待超窗的出路一句（buildInterruptedRerunNextStep）——先 MCP 后 CLI、≤480；放不下就只留 MCP 写法", () => {
  const id = "run_202610061200000000000000";
  const text = buildInterruptedRerunNextStep("run_delivery_repackage", `wao runs delivery repackage ${id} --allowed-path <path>...`);
  assert.equal(text,
    "If this MCP server is replaced before the outcome lands, the attempt stops: call run_delivery_repackage again with the same input to re-run it."
    + ` If your host has a background shell, you can instead run wao runs delivery repackage ${id} --allowed-path <path>... there; one command re-runs it, free of the per-call timeout and of an MCP server restart.`);
  assert.ok(text.length <= NEXT_STEP_MAX_LEN, `${text.length}`);
  // 超长 runId：整句放不下就只留 MCP 写法，不抛错、不截断 id。
  const longId = "run_" + "z".repeat(300);
  const dropped = buildInterruptedRerunNextStep("run_delivery_reverify", `wao runs delivery reverify ${longId} --reason <code>`);
  assert.ok(dropped.length <= NEXT_STEP_MAX_LEN, `${dropped.length}`);
  assert.ok(!dropped.includes("wao runs delivery reverify"), "放不下就不加 CLI 半句");
  assert.ok(dropped.startsWith("If this MCP server is replaced before the outcome lands, the attempt stops: call run_delivery_reverify again"));
});

// ═══════════════════════════════════════════════════════════════════════════
// 第 137a 批续修 1（会审 kimi、sol 均 FIX_FIRST）
// ═══════════════════════════════════════════════════════════════════════════

test("NEXT-20: verifier_gone 的 failed 支——带 --cwd 占位；runId 触顶长度不短于改前的 182（99 与 182 字符都不抛错）", () => {
  const failedFor = (id) => buildNextStep({
    surface: "cli", situation: "verifier_gone", runId: id, acceptanceStatus: "pending", terminalState: "failed",
  });
  // 会审复现的 99 字符（首轮实现从 99 起抛错——收口结果丢失）与改前的触顶 182。
  for (const n of [33, 99, 182, 183]) {
    const id = ofLength("run_", n, "y");
    const text = failedFor(id);
    assert.ok(text.length <= NEXT_STEP_MAX_LEN, `${n} 字符：${text.length} > ${NEXT_STEP_MAX_LEN}`);
    assert.ok(text.includes("--cwd <workspace root>"), `${n} 字符：带 --cwd 占位`);
    assert.ok(text.endsWith(`wao runs delivery ${id} --reject --reason-file <FILE>.`), `${n} 字符：真实 runId 出现在拒收命令里`);
    assert.equal(text.split(id).length - 1, 1, `${n} 字符：真实 runId 只出现一次，重新打包命令用 <runId> 占位`);
  }
  // 触顶恰为 183（改前 182——不少于此）：184 字符照旧抛错（不改上限、不截断 id）。
  assert.throws(() => failedFor(ofLength("run_", 184, "y")), /exceeds 480/);
  // 照抄可用：重新打包命令点名"同一组 allowed paths"，且说明不会产生第二个提交。
  const text = failedFor(RUN_ID);
  assert.match(text, /Call wao runs delivery repackage <runId> --allowed-path <path>\.\.\. --cwd <workspace root> \(the same allowed paths\) to re-run the verification without creating a second commit\./);
});

test("NEXT-21: CLI 面 dispatch_accepted 回显 --run-dir——实际值放得下就用实际值（含空格加引号），放不下或含控制字符写占位 <DIR>，不抛错", () => {
  const base = (id) => `Background run accepted. Before ending the turn, keep a wait attached: wao runs wait ${id} --until-settled`;
  const dispatch = (extras) => buildNextStep({ surface: "cli", situation: "dispatch_accepted", runId: RUN_ID, ...extras });
  // 没给：逐字不变（缺省运行目录不需要带）。
  assert.equal(dispatch({}), `${base(RUN_ID)}.`);
  // 给了：等待命令带上调用方给的同一个值（照抄才找得到子运行）。
  assert.equal(dispatch({ runDirFlag: "runs2" }), `${base(RUN_ID)} --run-dir runs2.`);
  // 含空白的路径加双引号——与 runs wait 多目标重挂行同一条规则。
  assert.equal(dispatch({ runDirFlag: "C:/my runs" }), `${base(RUN_ID)} --run-dir "C:/my runs".`);
  // 与后缀一起算长度、一起渲染：继承合同那半句仍在末尾。
  assert.equal(
    dispatch({ runDirFlag: "runs2", suffix: CONTINUE_INHERITED_DELIVERY_NOTE }),
    `${base(RUN_ID)} --run-dir runs2.${CONTINUE_INHERITED_DELIVERY_NOTE}`,
  );
  // 边界：恰好放得下的最长值用实际值；再长一个字符就换占位（带后缀时边界相应前移）。
  const room = NEXT_STEP_MAX_LEN - `${base(RUN_ID)} --run-dir .`.length;
  assert.equal(dispatch({ runDirFlag: ofLength("r", room, "d") }), `${base(RUN_ID)} --run-dir ${ofLength("r", room, "d")}.`);
  assert.equal(dispatch({ runDirFlag: ofLength("r", room + 1, "d") }), `${base(RUN_ID)} --run-dir <DIR>.`);
  const roomSuffix = room - CONTINUE_INHERITED_DELIVERY_NOTE.length;
  assert.equal(
    dispatch({ runDirFlag: ofLength("r", roomSuffix, "d"), suffix: CONTINUE_INHERITED_DELIVERY_NOTE }),
    `${base(RUN_ID)} --run-dir ${ofLength("r", roomSuffix, "d")}.${CONTINUE_INHERITED_DELIVERY_NOTE}`,
  );
  assert.equal(
    dispatch({ runDirFlag: ofLength("r", roomSuffix + 1, "d"), suffix: CONTINUE_INHERITED_DELIVERY_NOTE }),
    `${base(RUN_ID)} --run-dir <DIR>.${CONTINUE_INHERITED_DELIVERY_NOTE}`,
  );
  // 任何长度的值都不让已受理的回执变成报错：很长的路径写占位。
  for (const len of [400, 5000]) {
    const text = dispatch({ runDirFlag: ofLength("d/", len, "x"), suffix: CONTINUE_INHERITED_DELIVERY_NOTE });
    assert.equal(text, `${base(RUN_ID)} --run-dir <DIR>.${CONTINUE_INHERITED_DELIVERY_NOTE}`);
    assert.ok(text.length <= NEXT_STEP_MAX_LEN);
  }
  // 含控制字符：写占位（不把控制字符带进回执）。
  assert.equal(dispatch({ runDirFlag: "runs\tx" }), `${base(RUN_ID)} --run-dir <DIR>.`);
  assert.equal(dispatch({ runDirFlag: "runs\nx" }), `${base(RUN_ID)} --run-dir <DIR>.`);
  // 输入合同：只有 CLI 面 dispatch_accepted 渲染它；空串/非字符串是调用方错误。
  assert.throws(() => buildNextStep({ surface: "mcp", situation: "dispatch_accepted", runId: RUN_ID, runDirFlag: "runs2" }), /runDirFlag/);
  assert.throws(() => buildNextStep({ surface: "cli", situation: "wait_terminal", runId: RUN_ID, runDirFlag: "runs2" }), /runDirFlag/);
  assert.throws(() => dispatch({ runDirFlag: "" }), /runDirFlag/);
  assert.throws(() => dispatch({ runDirFlag: 42 }), /runDirFlag/);
});
