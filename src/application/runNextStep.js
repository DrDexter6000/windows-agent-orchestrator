// src/application/runNextStep.js
//
// 决定 0095：`nextStep`——等待族工具没等到收口时的一句固定英文模板，按面渲染
//（MCP 只写 MCP 工具名；CLI 写 CLI 命令、带 runId）。它是新字段，不复用
// run_status 的 leadAdvisory（那是"静默 30 分钟"的含义），也不进只陈述事实的
// semanticNotes。
// 第 136 批唯一的例外：MCP 面的 dispatch_accepted 与 consult_seats_running 在
// 模板末尾补一句 CLI 写法（宿主有后台命令行时一条命令等到收口）——MCP 服务
// 不知道宿主有没有命令行，所以两种写法都给，先 MCP 后 CLI；那句 CLI 命令因此
// 带本次受理的 runId / consultId，是 MCP 面唯一落 id 的地方。
//
// 措辞纪律：只说"signs of life were last observed N min ago" / "no new signs of
// life in the transcript for N min"，不断言 worker 在推进或已停；不出现宿主名；
// 不建议 accept/reject。长度上限引用 LEAD_ADVISORY_WIRE_MAX_LEN（同值 480），
// 超限抛错（测试钉住）——模板是静态的，超限只可能来自实现错误。
//
// Architectural contract: pure, no I/O, no clock (age 由调用方传入毫秒), no
// src/commands/*, src/mcp/*, MCP SDK, or zod.

import {
  VITAL_SIGN_RECENT_SECONDS,
  LEAD_ADVISORY_QUIET_SECONDS,
  LEAD_ADVISORY_WIRE_MAX_LEN,
} from "./runQuietAdvisory.js";

export const NEXT_STEP_MAX_LEN = LEAD_ADVISORY_WIRE_MAX_LEN;

export const NEXT_STEP_SURFACES = Object.freeze(["mcp", "cli"]);

// 情形闭集。等待类五支（wait_*）由 runWaitNextStep 按终态与体征年龄自动选；
// delivery_unsettled 是 run_delivery 带 waitMs 到期未收口；dispatch_accepted
// 是派发/续跑受理了后台运行；settled_line 是 CLI --until-settled 的收口终行
//（按 settlementReason 再分四支）；verifier_gone 是等待器证明终态等验证的运行
// 已无验证进程（只有 CLI 面）；runner_gone（第 83 批 B）是等待器证明非终态
// 运行已无 runner 进程——出口是 settle/stop、只在 Lead 决定时用（只有 CLI 面）；
// runner_unproven（第 107 批）是等待器证明不了 runner 已不在、以退出码 5 报警
//（静默满 30 分钟 + 未知类拒绝；只有 CLI 面）——先看状态、再干跑 settle 看
// 门事实，停/结算/重挂都归 Lead；consult_seats_running 是 consult 回执还有未
// 到终态的席位（MCP 面与 CLI 面各自渲染）；delivery_continuable（决定 0112）
// 是收口且未采纳的可续交付——MCP run_delivery 带 waitMs 因收口提前返回，与
// CLI --until-settled 的收口终行各自渲染，提示窄缺陷可用 run_continue 续修；
// delivery_superseded（第 120 批）是收口的交付已有被采纳的后代——谱系只裁决
// 最终候选，这里无需再裁决（不再提示 run_delivery review / run_continue）。
export const NEXT_STEP_SITUATIONS = Object.freeze([
  "wait_vital_recent",
  "wait_vital_ageing",
  "wait_vital_quiet",
  "wait_vital_unobservable",
  "wait_terminal",
  "delivery_unsettled",
  "dispatch_accepted",
  "settled_line",
  "verifier_gone",
  "runner_gone",
  "runner_unproven",
  "consult_seats_running",
  "delivery_continuable",
  "delivery_superseded",
]);

// 119 续修 3：等待族五支（wait_*）只有 CLI 面渲染——原 MCP run_wait 工具删除后，
// 生产代码没有任何 MCP 调用方（run_await_result 有意不带 nextStep；MCP 面从
// 终态到交付收口的一跳由 run_await_result 的 availableDrilldowns 承载，
// 见 runDrilldowns.js 的 deliveryWait 条目）。等待器证明三支照旧只有 CLI 面。
const CLI_ONLY_SITUATIONS = Object.freeze([
  "wait_vital_recent",
  "wait_vital_ageing",
  "wait_vital_quiet",
  "wait_vital_unobservable",
  "wait_terminal",
  "verifier_gone",
  "runner_gone",
  "runner_unproven",
]);

/** CLI consult 的 nextStep 在列出 runId 会超限时改用的说法。 */
const CONSULT_RUNNING_FALLBACK = Object.freeze({
  text: "(listed above)",
  json: "(see seats[].runId)",
});

function minutesFromMs(ageMs) {
  return Math.floor(ageMs / 60000);
}

/** 第 136 批：MCP 面模板末尾的 CLI 写法半句（派发/续修与会审回执共用同一句式）。 */
function backgroundShellClause(command, effect) {
  return ` If your host has a background shell, you can instead run ${command} there; one command ${effect}.`;
}

/**
 * 第 136 批续修：MCP 面带 CLI 半句的模板——CLI 半句只在**最终上线的整句**（含
 * 调用方追加在后的一切后缀）不超上限时才加，放不下就不加，MCP 写法与后缀照旧。
 * 合法的长 id 不能让已经受理的结果变成报错（派发已调用、续修已受理、会审记录
 * 已读到）；不改上限、不截断 id。后缀与半句一起在这里算，调用方不再自行拼接。
 */
function withCliClauseIfFits(base, clause, suffix) {
  const withClause = base + clause + suffix;
  return withClause.length <= NEXT_STEP_MAX_LEN ? withClause : base + suffix;
}

/**
 * 重挂/等待命令里回显调用方给的 --run-dir 值：含空白的路径加双引号（runs wait
 * 多目标的重挂行与续修受理回执的等待命令共用这一条规则）。
 * @param {string} value
 * @returns {string}
 */
export function quoteRunDirFlag(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

// 回显 --run-dir 时不接受控制字符（C0、DEL、C1）——带进回执会破坏行结构。
const RUN_DIR_CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/;

/**
 * 第 137a 批续修 1：CLI 面的等待命令带上调用方给的 --run-dir（照抄才找得到不在
 * 缺省目录里的运行）。实际值含控制字符、或带上它整句就超上限时写占位
 * `--run-dir <DIR>`——受理已经发生，不能因为一个路径太长让回执变成报错。
 * 占位那句仍超限（只剩 runId 本身长到离谱这一种可能）时由 render 末尾的上限
 * 守卫照旧抛错。
 */
function withRunDirIfFits(command, runDirFlag, suffix) {
  // 复核（sol）：--run-dir 放在 --until-settled 之前——句末的句号不粘在路径上
  // （放在最后时照抄会把 "." 收进路径）。整句长度与放在最后时相同。
  const tail = ` --until-settled.${suffix}`;
  if (runDirFlag === null) return `${command}${tail}`;
  const actual = `${command} --run-dir ${quoteRunDirFlag(runDirFlag)}${tail}`;
  if (!RUN_DIR_CONTROL_CHARS_RE.test(runDirFlag) && actual.length <= NEXT_STEP_MAX_LEN) return actual;
  return `${command} --run-dir <DIR>${tail}`;
}

/**
 * 第 137a 批：MCP 有界等待超窗（run_delivery_repackage / run_delivery_reverify
 * 的 pending 回执）末尾补的一句。那两个回执没有 nextStep 字段、原有文字也不设
 * 长度上限；这里只构造**新增的这一句**——自足的下一步：先 MCP 写法（服务进程被
 * 换掉后以相同输入再调一次），后 CLI 写法（宿主有后台命令行时改用那条 CLI 命令：
 * 不受单次调用时限，也不随 MCP 服务重启中断），与 dispatch_accepted 同一句式。
 * 整句连同 CLI 半句超过上限时只留 MCP 写法（runId 很长时就是这样）。
 *
 * @param {string} mcpTool — 再调一次的 MCP 工具名（如 run_delivery_repackage）
 * @param {string} cliCommand — 等价的 CLI 命令（带 runId 与占位参数）
 * @returns {string}
 */
export function buildInterruptedRerunNextStep(mcpTool, cliCommand) {
  return withCliClauseIfFits(
    `If this MCP server is replaced before the outcome lands, the attempt stops: call ${mcpTool} again with the same input to re-run it.`,
    backgroundShellClause(
      cliCommand,
      "re-runs it, free of the per-call timeout and of an MCP server restart",
    ),
    "",
  );
}

function render(surface, situation, runId, extras) {
  const m = minutesFromMs(extras.vitalSignAgeMs ?? 0);
  let text;
  switch (situation) {
    case "wait_vital_recent":
      text = `Signs of life were last observed ${m} min ago. Before ending the turn, attach: wao runs wait ${runId} --until-settled (in the background if your host notifies you when background commands finish, otherwise in the foreground).`;
      break;
    case "wait_vital_ageing":
      text = `Signs of life were last observed ${m} min ago. The worker may be inside a long-running command. Run: wao runs wait ${runId} --until-settled; use wao status ${runId} if you need detail.`;
      break;
    case "wait_vital_quiet":
      text = `No new signs of life in the transcript for ${m} min. Check wao status ${runId} and wao runs diagnose ${runId} first; the run has not been stopped. The exits are wao runs settle and wao stop — only on an explicit Lead decision.`;
      break;
    case "wait_vital_unobservable":
      text = `Vital-sign age is not observable on this snapshot. Re-read with wao status ${runId} before deciding anything.`;
      break;
    case "wait_terminal":
      text = `Terminal state reached. Wait to settlement with wao runs wait ${runId} --until-settled, or inspect the delivery with wao runs delivery ${runId}.`;
      break;
    case "delivery_unsettled":
      text = surface === "mcp"
        ? "Delivery is not settled yet: the run, its packaging, verification or a reverify chain still has no result. Call run_delivery again with waitMs to keep waiting. Verification passed is not acceptance."
        : `Delivery is not settled yet: the run, its packaging, verification or a reverify chain still has no result. Wait with wao runs wait ${runId} --until-settled. Verification passed is not acceptance.`;
      break;
    case "dispatch_accepted":
      // 第 136 批：MCP 面在 MCP 写法后补一句 CLI 写法（带受理的 runId）。
      // CLI 面也接调用方的后缀（续修受理时写明继承合同的那半句，决定 0130）。
      text = surface === "mcp"
        ? withCliClauseIfFits(
          "Background run accepted. Before ending the turn, keep a wait attached: call run_await_result repeatedly with its default waitMs on this run until it settles.",
          backgroundShellClause(`wao runs wait ${runId} --until-settled`, "waits until settlement"),
          extras.suffix,
        )
        : withRunDirIfFits(
          `Background run accepted. Before ending the turn, keep a wait attached: wao runs wait ${runId}`,
          // 续修 1：调用方给了 --run-dir 就带上（放不下实际值写占位）。
          extras.runDirFlag,
          extras.suffix,
        );
      break;
    case "settled_line": {
      // CLI 等待器的收口终行（按收口判定的 reason 闭集分支）。
      switch (extras.settlementReason) {
        case "delivery_settled":
          // 第 136 批：审查命令直接给能一次读完的那条（决定 0116），不再先指向
          // wao runs delivery 查询。
          text = extras.acceptanceStatus === "accepted" || extras.acceptanceStatus === "rejected"
            ? `Settled. The Lead decision is recorded: ${extras.acceptanceStatus}. Verification passed is not acceptance.`
            : `Settled. Delivery awaits the Lead's review: wao runs delivery review ${runId} --all. Verification passed is not acceptance.`;
          break;
        case "packaging_failed":
          text = `Settled: packaging failed. Diagnose with wao runs diagnose ${runId}. Verification passed is not acceptance.`;
          break;
        case "isolation_failed":
          text = `Settled: isolation failed (workdir_escape). Diagnose with wao runs diagnose ${runId}. Verification passed is not acceptance.`;
          break;
        case "no_delivery_requested":
          text = `Settled. No delivery was requested; collect the result with wao collect ${runId}. Verification passed is not acceptance.`;
          break;
        default:
          throw new Error(`buildNextStep: settled_line needs a settled settlementReason, got: ${JSON.stringify(extras.settlementReason)}`);
      }
      break;
    }
    case "delivery_continuable":
      // 决定 0112：收口且未采纳的可续交付（MCP 面；CLI --until-settled 收口终
      // 行同款）。只陈述谱系事实，不断言 run_continue 一定受理（资格检查在那
      // 边，拒绝零副作用、闭集）；不建议采纳或拒收。acceptanceStatus 只有
      // null（未决定）与 "rejected" 两支（accepted 的交付不可续，提示判定已排除）。
      // 第 137a 批：CLI 面写 CLI 命令（wao runs continue），不再点名 MCP 工具；
      // 未决定那句的 runId 触顶长度不短于改前（77 字符）。
      text = surface === "mcp"
        ? (extras.acceptanceStatus === "rejected"
          ? "Delivery settled; the Lead decision is recorded: rejected. Its lineage was dispatched continuable: for a narrow fix, run_continue can resume the same worker conversation with its context loaded; it checks eligibility before changing anything. Verification passed is not acceptance."
          : "Delivery settled. Its lineage was dispatched continuable and it is not accepted: for a narrow fix, run_continue can resume the same worker conversation with its context loaded; it checks eligibility before changing anything. An accepted delivery can no longer be continued. Verification passed is not acceptance.")
        : (extras.acceptanceStatus === "rejected"
          ? `Settled. The Lead decision is recorded: rejected. Its lineage was dispatched continuable: for a narrow fix, wao runs continue ${runId} --prompt-file <FILE> can resume the same worker conversation; it checks eligibility before changing anything. Verification passed is not acceptance.`
          // 第 136 批续修：审查命令让这一句长了 13 字符——别处改短 28 字符，runId
          // 触顶长度从 70 提到 78，同一长度的 runId 不比改动前更早触顶。
          : `Settled. Delivery awaits the Lead's review: wao runs delivery review ${runId} --all. Its lineage was dispatched continuable: for a narrow fix, wao runs continue ${runId} --prompt-file <FILE> can resume the same worker conversation; it checks eligibility first. An accepted delivery cannot be continued. Verification passed is not acceptance.`);
      break;
    case "delivery_superseded":
      // 第 120 批：收口的交付已有被采纳的后代（派生事实）。只说这一件事——
      // 不说祖先已被采纳、已合入或已回收，也不提示再审查或续修。
      text = `Settled. A descendant of this run was already accepted (${extras.supersededByRunId}); no Lead decision is needed here.`;
      break;
    case "verifier_gone":
      // 终态等验证、验证者已证明不在。出口仍是既有的：未决定时有界拒收，
      // 已拒收则没有可等的；要用内容都走采纳协议手工采纳。
      // B91：completed 形状不可重试（验证者死了就是死了）；终态 failed——只有
      // 重新打包的交付会走到这里——且未决定时按相同范围重跑验证（第 137a 批：
      // CLI 面写 CLI 命令 wao runs delivery repackage，不产生
      // 第二个提交）；已拒收后 repackage 会拒绝，两条形状同用现有 rejected 文案。
      // 续修 1（会审 kimi、sol）：带 --cwd <workspace root> 占位——Lead 从主检出
      // 照抄、交付属于另一棵工作树时，没有它会被归属门拒绝。真实 runId 只出现在
      // 拒收命令里（照抄即用），重新打包命令用 <runId> 占位：两句都带真实 id 时
      // runId 到 99 字符整句就超限抛错，收口结果丢失；现在触顶长度不短于改前
      // 的 182（实测 183）。
      text = extras.acceptanceStatus === "rejected"
        ? "Its verification will not finish and the delivery is already rejected; nothing is left to wait for. To use its content, adopt the delivery commit by hand under the adoption protocol (wao manual delivery \"验证失败采纳协议\")."
        : extras.terminalState === "failed"
          ? `Its verification is no longer running. Call wao runs delivery repackage <runId> --allowed-path <path>... --cwd <workspace root> (the same allowed paths) to re-run the verification without creating a second commit. Or reject it while it is pending: wao runs delivery ${runId} --reject --reason-file <FILE>.`
          : `Its verification will not finish. Reject it while it is pending: wao runs delivery ${runId} --reject --reason-file <FILE>. To use its content, adopt the delivery commit by hand under the adoption protocol (wao manual delivery \"验证失败采纳协议\"); wao runs delivery ${runId} shows the commit.`;
      break;
    case "runner_gone":
      // 非终态、runner 已证明不在（第 83 批 B）。等待不会改变事实；结算或停止都
      // 是 Lead 的决定（settle 记 failed / process_missing；先 dry-run 看门、
      // --apply 才写）。交付请求过的运行，工作树里未提交的改动仍在，先看再定。
      // 只陈述事实与出口，不断言内容好坏、不建议验收。
      text = `Nothing on this machine can still drive this run. The exits are wao runs settle --run-id ${runId} --reason-file <FILE> (the dry run lists the gate facts first; --apply writes them, recording failed / process_missing) or wao stop — only on an explicit Lead decision. If a delivery was requested, uncommitted changes may still be in the worktree: inspect them before deciding.`;
      break;
    case "runner_unproven":
      // 第 107 批：证明不了 runner 已不在（静默满 30 分钟 + 未知类拒绝，退出码
      // 5）。运行可能仍在变化——不说"等待不会改变事实"。先看当前状态、再干跑
      // settle 看门事实（不写任何东西）；停掉（停掉后可续谱系才能续修——续修只
      // 接终态的父运行）、结算还是重新挂等待，都归 Lead。
      // 第 137a 批：续修写 CLI 命令 wao runs continue；命令比原先的工具名长，同句
      // 别处改短——runId 触顶长度不短于改前（39 字符）。
      text = `The runner's absence cannot be proven, so the run may still change. First check wao status ${runId}, then dry-run wao runs settle --run-id ${runId} --reason-file <FILE> for the gate facts (writes nothing). The Lead decides: stop it (wao stop with the --observed-seq from status and a reason; then a continuable lineage can resume via wao runs continue <runId> --prompt-file <FILE>), settle it, or re-attach the wait.`;
      break;
    case "consult_seats_running": {
      if (surface === "mcp") {
        // 第 136 批：MCP 写法后补一句 CLI 写法（带这场会审的 consultId）。
        text = withCliClauseIfFits(
          `${extras.nonTerminalSeatCount} of ${extras.seatCount} seats are not terminal yet. Before ending the turn, keep a wait attached: call run_await_result repeatedly with its default waitMs on each such seat's runId (seats[].runId) until it is terminal, then re-read this consult with run_consult and its consultId.`,
          backgroundShellClause(`wao consult wait ${extras.consultId} --until-settled`, "waits for all seats"),
          extras.suffix,
        );
      } else {
        // CLI 面：一条 `consult wait <consultId> --until-settled` 等全部席位收口
        //（逐席 runs wait 是旧用法，命令已提供整场等待）。runId 清单仍是事实陈列
        //（哪几席还没到），等待动作本身只需 consultId。
        const tail = "Before ending the turn, attach: wao consult wait " + extras.consultId + " --until-settled "
          + "(in the background if your host notifies you when background commands finish; otherwise "
          + `in the foreground), then re-read with wao consult show ${extras.consultId}.`;
        const listed = `Seats not terminal yet: ${extras.seatRunIds.join(", ")}. ${tail}`;
        text = listed.length <= NEXT_STEP_MAX_LEN
          ? listed
          : `Seats not terminal yet ${extras.cliJson ? CONSULT_RUNNING_FALLBACK.json : CONSULT_RUNNING_FALLBACK.text}. ${tail}`;
      }
      break;
    }
    default:
      throw new Error(`buildNextStep: unknown situation: ${JSON.stringify(situation)}`);
  }
  if (text.length > NEXT_STEP_MAX_LEN) {
    throw new Error(`buildNextStep: nextStep exceeds ${NEXT_STEP_MAX_LEN} chars (${text.length}): ${situation}/${surface}`);
  }
  return text;
}

/**
 * 第 107 批：runner_unproven 出口的固定事实文本与 JSON 字段——runs wait 与
 * consult wait 共用这一份（只陈述：证明不了 runner 已不在、运行仍可能变化；
 * 重启关系成立时说明开机晚于最后活动，不排除开机后的续跑）。
 *
 * @param {object} input
 * @param {string} input.state — 重读快照的运行状态
 * @param {string} input.refusal — 本轮证明的拒绝理由（RUNNER_UNPROVEN_REFUSALS）
 * @param {number} input.quietMs — 重读快照计入静默窗的最后绑定事件距今毫秒
 * @param {{bootAt:number, lastActivityAt:number}|null} input.rebooted
 * @returns {{lines:string[], fields:{refusal:string, quietMinutes:number, rebootedSinceLastActivity:object|null}}}
 */
export function runnerUnprovenReport({ state, refusal, quietMs, rebooted }) {
  const quietMinutes = Math.max(0, Math.floor(quietMs / 60000));
  const iso = rebooted === null
    ? null
    : { bootAt: new Date(rebooted.bootAt).toISOString(), lastActivityAt: new Date(rebooted.lastActivityAt).toISOString() };
  const lines = [
    `Unproven: the owner heartbeat is missing or not fresh and the run has been silent for ${quietMinutes} min, but the runner's absence cannot be proven (${refusal}); the run is still ${state}, and waiting longer may still see it change.`,
  ];
  if (iso !== null) {
    lines.push(`Reboot: this machine booted at ${iso.bootAt}, after the run's last activity (${iso.lastActivityAt}); a runner from before the reboot cannot have survived it, but a runner started after the boot cannot be ruled out.`);
  }
  return { lines, fields: { refusal, quietMinutes, rebootedSinceLastActivity: iso } };
}

/**
 * 构造一句 nextStep。surface "cli" 必须给 runId（模板带 runId）；"mcp" 的模板
 * 除第 136 批的两处 CLI 半句外不含 runId（传了也不会渲染）——所以 MCP 面的
 * dispatch_accepted 需要 runId、consult_seats_running 需要 consultId。
 * settled_line 需要 settlementReason（收口判定的 settled 类 reason）与可选
 * acceptanceStatus；delivery_continuable 的 acceptanceStatus 只接受 null（未
 * 决定）或 "rejected"，其余抛错（调用方把服务里表示未决定的值如 "pending"
 * 转成 null 再传）；delivery_superseded（第 120 批）需要非空的
 * supersededByRunId——文案点名那个被采纳的后代，只说"无需再裁决"；
 * verifier_gone、runner_gone 与 runner_unproven 只有 CLI 面（verifier_gone 可
 * 另给 terminalState——运行终态：failed 且未决定时渲染重新打包交付的续验
 * 文案，其余值渲染 completed 形状的既有文案）；
 * consult_seats_running 在 MCP 面用 seatCount/nonTerminalSeatCount/consultId，
 * 在 CLI 面用 seatRunIds/consultId（可再给 cliJson 选不列 runId 的回退说法）。
 * 长度超上限抛错（consult_seats_running 的 CLI 面有文档化的不列 runId 回退；
 * MCP 面的 CLI 半句放不下就不加——见 withCliClauseIfFits）。
 *
 * @param {object} input
 * @param {"mcp"|"cli"} input.surface
 * @param {string} input.situation — NEXT_STEP_SITUATIONS 成员
 * @param {string} [input.runId] — CLI 面必给；MCP 面只有 dispatch_accepted 用
 *   （末尾 CLI 命令带本次受理的 runId）
 * @param {string} [input.suffix] — MCP 面 dispatch_accepted / consult_seats_running
 *   与 CLI 面 dispatch_accepted 用：调用方要追加在末尾的后缀（如合同提醒、继承
 *   合同那半句）。MCP 面它和 CLI 半句一起算长度，由这里拼好返回——调用方不要
 *   再自行追加。其余情形不用。
 * @param {string|null} [input.runDirFlag] — 只有 CLI 面 dispatch_accepted 用（第
 *   137a 批续修 1）：调用方显式给的 --run-dir 值，等待命令原样带上（含空白的
 *   加双引号）；放不下实际值或含控制字符时写占位 `--run-dir <DIR>`，不抛错。
 *   没给（null）时等待命令不带 --run-dir。别的面/情形传了即抛错（输入合同）。
 * @param {number|null} [input.vitalSignAgeMs] — 毫秒（vitalSignAgeMs 共享函数的输出）
 * @param {string|null} [input.settlementReason]
 * @param {string|null} [input.acceptanceStatus]
 * @param {string|null} [input.terminalState] — verifier_gone 用：收口事实里的
 *   运行终态（"failed" → 重新打包形状的续验文案；其余/completed → 既有文案）
 * @param {string|null} [input.supersededByRunId] — delivery_superseded 用：那个
 *   已被采纳的后代 runId（第 120 批的派生事实）
 * @param {string[]} [input.seatRunIds] — CLI consult：未终态席位的 runId 清单
 * @param {string} [input.consultId] — consult：重读或整场等待用的 consultId（MCP
 *   面与 CLI 面都要）
 * @param {boolean} [input.cliJson] — CLI consult 回退说法用 JSON 面措辞
 * @param {number} [input.seatCount] — MCP consult：席位总数
 * @param {number} [input.nonTerminalSeatCount] — MCP consult：未终态席位数
 * @returns {string}
 */
export function buildNextStep({
  surface,
  situation,
  runId = null,
  suffix = "",
  runDirFlag = null,
  vitalSignAgeMs = null,
  settlementReason = null,
  acceptanceStatus = null,
  terminalState = null,
  supersededByRunId = null,
  seatRunIds = null,
  consultId = null,
  cliJson = false,
  seatCount = null,
  nonTerminalSeatCount = null,
}) {
  if (!NEXT_STEP_SURFACES.includes(surface)) {
    throw new Error(`buildNextStep: surface must be "mcp" or "cli", got: ${JSON.stringify(surface)}`);
  }
  if (!NEXT_STEP_SITUATIONS.includes(situation)) {
    throw new Error(`buildNextStep: unknown situation: ${JSON.stringify(situation)}`);
  }
  if (CLI_ONLY_SITUATIONS.includes(situation) && surface !== "cli") {
    throw new Error(`buildNextStep: situation "${situation}" is CLI-only, got surface ${JSON.stringify(surface)}`);
  }
  // 决定 0112：可续提示的 acceptanceStatus 只接受 null（未决定）或 "rejected"；
  // 服务侧表示未决定的值（如收口事实里的 "pending"）由调用方转成 null 再传。
  if (situation === "delivery_continuable" && acceptanceStatus !== null && acceptanceStatus !== "rejected") {
    throw new Error(`buildNextStep: delivery_continuable needs acceptanceStatus null or "rejected", got: ${JSON.stringify(acceptanceStatus)}`);
  }
  // 第 120 批：被取代的文案要点名那个被采纳的后代（runId 字符串，非空）。
  if (situation === "delivery_superseded"
    && (typeof supersededByRunId !== "string" || supersededByRunId.length === 0)) {
    throw new Error(`buildNextStep: delivery_superseded needs a non-empty supersededByRunId, got: ${JSON.stringify(supersededByRunId)}`);
  }
  if (situation === "consult_seats_running") {
    if (surface === "cli") {
      if (!Array.isArray(seatRunIds) || seatRunIds.length === 0
        || seatRunIds.some((id) => typeof id !== "string" || id.length === 0)) {
        throw new Error(`buildNextStep: consult_seats_running on CLI needs a non-empty seatRunIds array, got: ${JSON.stringify(seatRunIds)}`);
      }
      if (typeof consultId !== "string" || consultId.length === 0) {
        throw new Error(`buildNextStep: consult_seats_running on CLI needs a consultId, got: ${JSON.stringify(consultId)}`);
      }
    } else if (!Number.isInteger(seatCount) || seatCount <= 0
      || !Number.isInteger(nonTerminalSeatCount) || nonTerminalSeatCount <= 0) {
      throw new Error("buildNextStep: consult_seats_running on MCP needs positive seatCount and nonTerminalSeatCount");
    } else if (typeof consultId !== "string" || consultId.length === 0) {
      // 第 136 批：MCP 面末尾的 CLI 命令带这场会审的 consultId。
      throw new Error(`buildNextStep: consult_seats_running on MCP needs a consultId, got: ${JSON.stringify(consultId)}`);
    }
  } else if (surface === "cli" && (typeof runId !== "string" || runId.length === 0)) {
    throw new Error(`buildNextStep: surface "cli" renders commands with a runId, got: ${JSON.stringify(runId)}`);
  } else if (surface === "mcp" && situation === "dispatch_accepted"
    && (typeof runId !== "string" || runId.length === 0)) {
    // 第 136 批：MCP 面末尾的 CLI 命令带本次受理的 runId。
    throw new Error(`buildNextStep: dispatch_accepted on MCP needs the accepted runId, got: ${JSON.stringify(runId)}`);
  }
  // 第 136 批续修：后缀由这里拼（与 CLI 半句一起算长度），只接受字符串。
  if (typeof suffix !== "string") {
    throw new Error(`buildNextStep: suffix must be a string, got: ${JSON.stringify(suffix)}`);
  }
  // 第 137a 批续修 1：--run-dir 回显只有 CLI 面 dispatch_accepted 渲染，且必须是非空
  // 字符串——传给别的面/情形是调用方接错线，响亮失败而不是静默忽略。
  if (runDirFlag !== null) {
    if (surface !== "cli" || situation !== "dispatch_accepted"
      || typeof runDirFlag !== "string" || runDirFlag.length === 0) {
      throw new Error(`buildNextStep: runDirFlag needs a non-empty string on CLI dispatch_accepted only, got it for ${situation}/${surface}`);
    }
  }
  if (vitalSignAgeMs !== null && !Number.isFinite(vitalSignAgeMs)) {
    vitalSignAgeMs = null;
  }
  return render(surface, situation, runId, {
    runDirFlag,
    suffix,
    vitalSignAgeMs,
    settlementReason,
    acceptanceStatus,
    terminalState,
    supersededByRunId,
    seatRunIds: Array.isArray(seatRunIds) ? seatRunIds : [],
    consultId,
    cliJson: cliJson === true,
    seatCount,
    nonTerminalSeatCount,
  });
}

/**
 * 等待族（CLI runs wait；MCP 面的等待由 run_await_result 承担，有意不带本
 * nextStep——等待族五支因此只有 CLI 渲染，见 CLI_ONLY_SITUATIONS）的
 * nextStep：按终态与体征年龄自动选支。
 * 阈值直接引用 runQuietAdvisory 的两个常量（10 分钟 / 30 分钟），毫秒直比，
 * 不预取整——恰好 10 分钟不算 recent（同 runStatus 的 < 口径），恰好 30 分钟
 * 已算 quiet（同 advisory 的 >= 口径）。
 *
 * @param {object} input
 * @param {"cli"} input.surface — 等待族只有 CLI 面（MCP 面无调用方；传 "mcp" 会被 CLI_ONLY_SITUATIONS 拒绝）
 * @param {boolean} input.terminal
 * @param {number|null} input.vitalSignAgeMs
 * @param {string} [input.runId]
 * @returns {string}
 */
export function runWaitNextStep({ surface, terminal, vitalSignAgeMs, runId }) {
  if (terminal) {
    return buildNextStep({ surface, situation: "wait_terminal", runId });
  }
  if (vitalSignAgeMs === null || !Number.isFinite(vitalSignAgeMs)) {
    return buildNextStep({ surface, situation: "wait_vital_unobservable", runId });
  }
  if (vitalSignAgeMs < VITAL_SIGN_RECENT_SECONDS * 1000) {
    return buildNextStep({ surface, situation: "wait_vital_recent", runId, vitalSignAgeMs });
  }
  if (vitalSignAgeMs < LEAD_ADVISORY_QUIET_SECONDS * 1000) {
    return buildNextStep({ surface, situation: "wait_vital_ageing", runId, vitalSignAgeMs });
  }
  return buildNextStep({ surface, situation: "wait_vital_quiet", runId, vitalSignAgeMs });
}
