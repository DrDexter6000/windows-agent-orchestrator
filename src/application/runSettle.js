// src/application/runSettle.js
//
// `wao runs settle` 的数据逻辑：把 runner 已死的非终态运行结算成终态 failed。
//
// 两类目标运行：
//   - 后台派发的 runner 在建会话前就死了（转录只有 run.background_submitted
//     与 pending）；
//   - runner 中途死了（会话是 proc_<pid>，状态停在 running，之后再无事件）。
//
// 结算沿用 run_delivery_repackage 的 process_missing 词汇：终态 failed、理由
// STATE_CHANGE_REASON.process_missing、原子带一条 run.process_missing_confirmed。
// 本模块把同一结算推广到非交付运行与从未建会话的运行。
//
// 六道门（全部满足才可结算；只读绑定事件 e.runId === runId）：
//   1. 状态是已知的非终态；
//   2. owner 租约缺失可以；过期则 owner pid 须判 gone；新鲜或损坏都拒；
//   3. 本机没有命令行带 --run-id <runId> / --resume-run-id <runId> 或前台
//      `wao resume <runId>` 的进程（runner 已死的正面证据——心跳写入失败会被
//      runner 吞掉，单凭租约缺失加静默不能证明 runner 已死）。读不到命令行的
//      node 进程按创建时间收窄：只有创建不早于本运行那条 run.background_submitted
//      的（留 5s 时钟偏差）才计入盲区；读不到创建时间的照旧计入；前台运行没有
//      这条事实，不收窄；
//   4. 静默窗（只筛候选，不替代第 3 条）；
//   5. 会话形状：无会话须有 background_submitted；proc_/hostPid 须判 gone；
//      serveUrl 拒（该用 wao stop）；
//   6. 没有活着的 daemon（resume-on-start 会接管 orphan）。
//
// 同模块另导出只读的 proveVerifierGone：终态 completed + 验证显式 pending 的
// 运行，其后台验证者进程是否已不在。它与 settle 的门 2/3/4/6 共用同一套读器与
// 判定（_evaluateOwnerLeaseGate / _evaluateRunnerScanGate /
// _evaluateQuietWindowGate；daemon 判定按验证者的形状另写，见下）。
//
// --apply 的写入带 expectedLastSeq 守卫：证明开始时记下的最后 seq 与锁内实读
// 不一致即拒（observed_seq_changed）——防证明之后出现的新事件（例如 daemon 在
// 这期间重放了运行）。
//
// Architectural contract:
//   - No argv parsing, no console.log, no process.exit.
//   - Does not import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Depends on transcript.js, projectBuckets.js, delivery.js (isValidRunId),
//     ownerLiveness.js (lease + pid identity SSOT), processRecovery.js
//     (parseProcPid)。门 6 的 daemon 握手读器（src/daemon.js，adapters 层）由
//     CLI 命令注入——本模块不上向导入。
//   - 进程命令行原文绝不输出、绝不落盘：runner 扫描只在远端（PowerShell 内）
//     匹配，回到本进程的只有计数。

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

import {
  readTranscript,
  findState,
  findLastEventSeq,
  findLatestBound,
  validateDeliveryFacts,
  JsonlTranscript,
  RUN_STATES,
  TERMINAL_STATES,
  STATE_CHANGE_REASON,
  PROCESS_MISSING_CONFIRMED_TYPE,
} from "../transcript.js";
import { resolveTranscriptPath, listTranscriptsDeep } from "../projectBuckets.js";
import { isValidRunId } from "../delivery.js";
import { readOwnerLease, checkOwnerLiveness, identifyProcessIdentity } from "./ownerLiveness.js";
import { parseProcPid } from "./processRecovery.js";

/** 候选筛用的静默窗：最后一条绑定事件须早于该时长之前。 */
export const SETTLE_QUIET_WINDOW_MS = 15 * 60 * 1000;

/** 结算理由正文的有界长度（照 run.lineage_closed 的写法）。 */
export const SETTLE_REASON_BOUND = 500;

const RUNNER_SCAN_TIMEOUT_MS = 30000;

/** 每道门一个的闭集拒绝理由（+ 写入竞态 observed_seq_changed）。 */
export const SETTLE_REJECTION_REASONS = Object.freeze([
  "terminal", // 门 1：运行已终态
  "unknown_state", // 门 1：状态不在已知闭集
  "owner_fresh", // 门 2：owner 租约新鲜（runner 监督进程还在心跳）
  "owner_lease_corrupt", // 门 2：租约文件损坏/畸形
  "owner_alive", // 门 2：过期租约的 owner pid 仍判 same
  "runner_alive", // 门 3：本机有带 --run-id/--resume-run-id <runId> 或前台 `resume <runId>` 的进程
  "runner_scan_failed", // 门 3：进程命令行扫描失败（读不到命令行的 node 进程已按创建时间收窄：只把创建不早于本运行的计入）
  "quiet_window", // 门 4：最后一条绑定事件不够旧
  "foreground_no_session", // 门 5：无会话且无 background_submitted（前台运行）
  "session_ambiguous", // 门 5：取不出唯一的 pid 与时刻锚
  "session_has_stop_route", // 门 5：会话有 serveUrl，应走 wao stop
  "process_alive", // 门 5：会话进程判 same
  "process_identity_unknown", // 门 2/5：pid 身份无法核验（unknown）
  "daemon_owned", // 门 6：有活着的 daemon（可能已/将接管本运行）
  "observed_seq_changed", // 写入：证明之后转录长过
]);

function _gateFactsPush(facts, gate, ok, detail) {
  facts.push({ gate, ok, detail });
}

/**
 * 门 5 的 pid 与时刻锚解析——与 runStop 的停止目标解析同一取法：
 * run.rerun 晚于 session.created 时取重放记录（newSessionId/hostPid + rerun 的
 * ts），否则取 session.created（proc_<pid>/hostPid + created 的 ts）。
 * @returns {{pid:number, anchorAt:number}|null}
 */
function _resolveSessionPidAndAnchor(events, runId) {
  const created = findLatestBound(events, "session.created", runId);
  if (!created) return null;
  const rerun = findLatestBound(events, "run.rerun", runId);
  const replayed = typeof rerun?.newSessionId === "string" && rerun.newSessionId.length > 0
    && Number.isInteger(rerun.seq) && Number.isInteger(created.seq) && rerun.seq > created.seq;
  if (replayed) {
    const pid = parseProcPid(rerun.newSessionId)
      ?? (Number.isInteger(rerun.hostPid) && rerun.hostPid > 0 ? rerun.hostPid : null);
    const anchorAt = Date.parse(rerun.ts);
    if (pid !== null && Number.isFinite(anchorAt)) return { pid, anchorAt };
    return null;
  }
  const pid = parseProcPid(created.backendSessionId)
    ?? (Number.isInteger(created.hostPid) && created.hostPid > 0 ? created.hostPid : null);
  const anchorAt = Date.parse(created.ts);
  if (pid !== null && Number.isFinite(anchorAt)) return { pid, anchorAt };
  return null;
}

/**
 * 默认 runner 扫描的输出判读（纯函数，单测可达）。只认扫描脚本最后写出的
 * 哨兵行 `wao-scan-ok:<命中数>:<读不到命令行的 node 进程数>`：
 *   - 没有哨兵（脚本中途出错、输出被截断）→ failed——扫描失败绝不读成"没有 runner"；
 *   - 命中数 > 0 → alive；
 *   - 有读不到命令行的 node 进程（如提权运行的进程）→ failed：runner 是 node
 *     进程，这时证明不了它不在。
 * @param {string} stdout
 * @returns {{alive:boolean}|{failed:true}}
 */
export function parseRunnerScanOutput(stdout) {
  const m = /^wao-scan-ok:(\d+):(\d+)\s*$/m.exec(String(stdout ?? ""));
  if (!m) return { failed: true };
  const hits = Number(m[1]);
  const blind = Number(m[2]);
  if (hits > 0) return { alive: true };
  if (blind > 0) return { failed: true };
  return { alive: false };
}

/**
 * 默认 runner 扫描：PowerShell 内做子串匹配，只回传计数。
 * 排除扫描进程自身（$PID）与它的全部祖先（本 CLI/npm/cmd 链——`runs settle
 * --run-id <id>` 自己的命令行也含该旗标，不排除会把结算进程误判成活 runner）；
 * 祖先链带防环与步数上限（pid 复用可以让父链成环）。
 * 三种匹配：`--run-id <id>`、`--resume-run-id <id>`，以及前台续跑的
 * `wao resume <id> [--wait]`（其命令行不带 run-id 旗标）。
 * `notBeforeMs`（epoch ms，可选）：命令行读不到的 node 进程（如提权运行的
 * 进程）只有 `CreationDate`（转 UTC）不早于 `notBeforeMs − 5000` 的才计入
 * blind——本运行开始之前就已创建的进程，命令行不可能带本运行的 runId；读不到
 * `CreationDate` 的照旧计入。缺省不传时命令文本与不收窄的旧版逐字节相同。
 * `$ErrorActionPreference='Stop'` 把 CIM 的非终止错误升级为终止错误：否则出错
 * 后计数照样输出 0、退出码 0，扫描失败会被读成"没有 runner"。判读见
 * parseRunnerScanOutput。命令行原文不出 PowerShell 进程。runId 已过
 * isValidRunId（闭字母表，无通配/引号字符），嵌入 -like 模式安全。
 * @param {string} runId
 * @param {Function} [execFileFn]
 * @param {number|null} [notBeforeMs] — 本运行 run.background_submitted 的时刻（epoch ms）
 * @returns {Promise<{alive:boolean}|{failed:true}>}
 */
export function defaultRunnerScan(runId, execFileFn = execFile, notBeforeMs = null) {
  return new Promise((resolve) => {
    const pattern = (token) => `'*${token} ${runId}*'`;
    const narrowed = Number.isFinite(notBeforeMs);
    const cutLine = narrowed
      ? `$cut=[DateTimeOffset]::FromUnixTimeMilliseconds(${Math.trunc(notBeforeMs) - 5000}).UtcDateTime;`
      : null;
    const blindLine = narrowed
      ? "$blind=@($all | Where-Object { $_.Name -like 'node*' -and -not $_.CommandLine -and ( ($null -eq $_.CreationDate) -or ($_.CreationDate.ToUniversalTime() -ge $cut) ) }).Count;"
      : "$blind=@($all | Where-Object { $_.Name -like 'node*' -and -not $_.CommandLine }).Count;";
    const command = [
      "$ErrorActionPreference='Stop';",
      ...(cutLine ? [cutLine] : []),
      "$ex=@(); $pp=$PID; $n=0;",
      "while ($pp -and ($ex -notcontains [string]$pp) -and $n -lt 64) { $ex+=[string]$pp; $n++;",
      "  $q=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pp);",
      "  if (-not $q) { break }; $pp=$q.ParentProcessId };",
      "$all=@(Get-CimInstance Win32_Process | Where-Object { $ex -notcontains [string]$_.ProcessId });",
      `$hit=@($all | Where-Object { $_.CommandLine -like ${pattern("--run-id")} -or $_.CommandLine -like ${pattern("--resume-run-id")} -or $_.CommandLine -like ${pattern("resume")} }).Count;`,
      blindLine,
      "'wao-scan-ok:' + $hit + ':' + $blind",
    ].join(" ");
    try {
      execFileFn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { timeout: RUNNER_SCAN_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve({ failed: true });
            return;
          }
          resolve(parseRunnerScanOutput(stdout));
        },
      );
    } catch {
      resolve({ failed: true });
    }
  });
}

function _defaultDeps(deps = {}) {
  // 门 6 的 daemon 握手读器没有默认实现：src/daemon.js 属 adapters 层，本模块
  // （application）不得上向导入。CLI 命令（同层）静态导入三态读器
  // readHandshakeDetailed/isDaemonAlive 后注入；缺注入 = 接线错误，响亮失败
  // （不静默跳过该门）。读器契约见 daemon.js：{present:false}（文件不在）|
  // {present:true,unreadable:true}（文件在但读不出/非对象）| {present:true,
  // unreadable:false,handshake}。
  if (typeof deps.handshakeReader !== "function" || typeof deps.daemonAliveFn !== "function") {
    throw new Error("runSettle: daemon gate readers are required (inject handshakeReader + daemonAliveFn)");
  }
  const nowFn = typeof deps.nowFn === "function" ? deps.nowFn : Date.now;
  return {
    nowFn,
    ownerLeaseReader: deps.ownerLeaseReader ?? readOwnerLease,
    identifyFn: deps.identifyFn ?? identifyProcessIdentity,
    runnerScanFn: deps.runnerScanFn ?? ((runId, notBeforeMs) => defaultRunnerScan(runId, execFile, notBeforeMs)),
    handshakeReader: deps.handshakeReader,
    daemonAliveFn: deps.daemonAliveFn,
    readTranscriptFn: deps.readTranscriptFn ?? readTranscript,
    listFilesFn: deps.listFilesFn ?? listTranscriptsDeep,
  };
}

/**
 * 门 2（settle 与 proveVerifierGone 共用）：owner 租约缺失可以；过期则 owner
 * pid 须判 gone；新鲜、损坏、判 alive / unknown 都拒。basis 取 `lease_missing`
 * 或身份判定给出的闭集 basis。
 * @returns {Promise<{ok:true,basis:string}|{ok:false,refusal:string}>}
 */
async function _evaluateOwnerLeaseGate(now, runDir, runId, d, facts) {
  const lease = d.ownerLeaseReader(runDir, runId, now);
  if (lease.present && !lease.wellFormed) {
    _gateFactsPush(facts, "owner_lease", false, "租约文件在场但畸形/损坏");
    return { ok: false, refusal: "owner_lease_corrupt" };
  }
  if (lease.present && lease.wellFormed && lease.fresh) {
    _gateFactsPush(facts, "owner_lease", false, "owner 心跳新鲜（监督进程还在）");
    return { ok: false, refusal: "owner_fresh" };
  }
  if (lease.present && lease.wellFormed && !lease.fresh) {
    const ownerIdentity = await d.identifyFn(lease.pid, lease.heartbeatAt);
    if (ownerIdentity.verdict !== "gone") {
      const why = ownerIdentity.verdict === "same" ? "owner_alive" : "process_identity_unknown";
      _gateFactsPush(facts, "owner_lease", false,
        `租约过期但 owner pid 判 ${ownerIdentity.verdict}（${ownerIdentity.basis}）`);
      return { ok: false, refusal: why };
    }
    _gateFactsPush(facts, "owner_lease", true, `租约过期且 owner pid 判 gone（${ownerIdentity.basis}）`);
    return { ok: true, basis: ownerIdentity.basis };
  }
  _gateFactsPush(facts, "owner_lease", true, "无租约文件（runner 可能已清理退出）");
  return { ok: true, basis: "lease_missing" };
}

/**
 * 门 3 扫描按创建时间收窄的锚（epoch ms）：恰好一条绑定 run.background_submitted
 * 的时刻。后台派发先落这条事实、再 spawn runner，所以 runner（以及之后的续跑
 * 进程）都晚于它创建；早于它创建的进程，命令行不可能带本运行的 runId。前台
 * `wao run` 是先启动、后写 run.started 的，任何转录事件都不是它创建时刻的下界，
 * 所以没有这条事实（或不止一条、ts 读不出）时返回 NaN，调用方就不传（不收窄）。
 * @param {object[]} bound
 * @returns {number}
 */
function _backgroundSubmittedMs(bound) {
  const submitted = bound.filter((e) => e.type === "run.background_submitted");
  return submitted.length === 1 ? Date.parse(submitted[0].ts) : NaN;
}

/**
 * 门 3（settle 与 proveVerifierGone 共用）：本机没有可能仍在驱动本运行的
 * 进程。扫描失败绝不读成"没有 runner"。
 * @param {number|undefined} notBeforeMs — 本运行 run.background_submitted 的时刻；
 *   前台运行或读不出就不传（默认扫描不做按创建时间的收窄）。
 * @returns {Promise<{ok:true}|{ok:false,refusal:string}>}
 */
async function _evaluateRunnerScanGate(runId, d, facts, notBeforeMs) {
  const scan = await d.runnerScanFn(runId, notBeforeMs);
  if (scan.failed) {
    _gateFactsPush(facts, "runner_scan", false,
      "本机进程命令行扫描失败（读不到命令行的 node 进程已按创建时间收窄：只把创建不早于本运行的计入；仍失败即有排除不掉的候选或扫描本身出错）");
    return { ok: false, refusal: "runner_scan_failed" };
  }
  if (scan.alive) {
    _gateFactsPush(facts, "runner_scan", false, "本机仍有命令行带 --run-id/--resume-run-id 本运行或前台 `resume <runId>` 的进程");
    return { ok: false, refusal: "runner_alive" };
  }
  _gateFactsPush(facts, "runner_scan", true, "本机没有该 runId 的 runner 进程");
  return { ok: true };
}

/**
 * 门 4（settle 与 proveVerifierGone 共用）：最后一条绑定事件至少
 * SETTLE_QUIET_WINDOW_MS 之前。
 * @returns {{ok:true}|{ok:false,refusal:string}}
 */
function _evaluateQuietWindowGate(bound, now, facts) {
  const lastBound = bound[bound.length - 1];
  const lastTs = lastBound ? Date.parse(lastBound.ts) : NaN;
  const quietMs = Number.isFinite(lastTs) ? now - lastTs : NaN;
  if (!Number.isFinite(quietMs) || quietMs < SETTLE_QUIET_WINDOW_MS) {
    const described = Number.isFinite(quietMs)
      ? `最后一条绑定事件距今 ${Math.max(0, Math.round(quietMs / 1000))}s（须 ≥ ${SETTLE_QUIET_WINDOW_MS / 60000}min）`
      : "最后一条绑定事件缺时间戳";
    _gateFactsPush(facts, "quiet_window", false, described);
    return { ok: false, refusal: "quiet_window" };
  }
  _gateFactsPush(facts, "quiet_window", true, `最后一条绑定事件距今 ${Math.round(quietMs / 60000)}min`);
  return { ok: true };
}

/**
 * 门 6（settle）：没有活着的 daemon（resume-on-start 会接管 orphan）。握手
 * 文件在但读不出（空/半截 JSON/非对象）不能当成"没有 daemon"放行——文件在，
 * 就可能有 daemon 在写它。
 * @returns {{ok:true}|{ok:false,refusal:string}}
 */
function _evaluateDaemonGate(now, runDir, d, facts) {
  const read = d.handshakeReader(runDir);
  if (!read.present) {
    _gateFactsPush(facts, "daemon", true, "无 daemon 握手文件");
    return { ok: true };
  }
  if (read.unreadable) {
    _gateFactsPush(facts, "daemon", false, "daemon 握手文件在但读不出（空/半截 JSON/非对象）——按可能有活 daemon 处理");
    return { ok: false, refusal: "daemon_owned" };
  }
  if (d.daemonAliveFn(read.handshake, now)) {
    _gateFactsPush(facts, "daemon", false, "有活着的 daemon（resume-on-start 会接管 orphan，归属不可分辨）");
    return { ok: false, refusal: "daemon_owned" };
  }
  _gateFactsPush(facts, "daemon", true, "没有活着的 daemon");
  return { ok: true };
}

/**
 * 本运行最后一条绑定 `run.state_change → completed` 的时刻（epoch ms），
 * 读不出返回 NaN。只供 proveVerifierGone 的 daemon 判定取锚。
 * @returns {number}
 */
function _completedAtMs(events, runId) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === "run.state_change" && event.runId === runId && event.to === "completed") {
      return Date.parse(event.ts);
    }
  }
  return NaN;
}

/**
 * proveVerifierGone 的 daemon 判定（与 settle 门 6 不同）：daemon 跳过终态
 * 运行，所以只有在本运行到达 completed **之前**（含同一时刻——同一时刻不算
 * "之后"，仍按之前启动继续判新鲜度与身份）就已启动的 daemon 才可能在驱动
 * 它。握手里没有这个时间（或字段畸形）时按"可能在驱动"处理——拒绝。握手
 * 文件在但读不出（空/半截 JSON/非对象）同样拒绝：不能当成"没有 daemon"。
 * @param {number} completedAt — 本运行绑定 `run.state_change → completed` 的
 *   时刻（前提 1 已保证可解析）。
 * @returns {Promise<{ok:true}|{ok:false,refusal:string}>}
 */
async function _evaluateVerifierDaemonGate(completedAt, now, runDir, d, facts) {
  const read = d.handshakeReader(runDir);
  if (!read.present) {
    _gateFactsPush(facts, "daemon", true, "无 daemon 握手文件");
    return { ok: true };
  }
  if (read.unreadable) {
    _gateFactsPush(facts, "daemon", false, "daemon 握手文件在但读不出（空/半截 JSON/非对象）——按可能在驱动本运行处理");
    return { ok: false, refusal: "daemon_owned" };
  }
  const handshake = read.handshake;
  const wellFormed = typeof handshake === "object" && !Array.isArray(handshake)
    && typeof handshake.startedAt === "number" && Number.isFinite(handshake.startedAt)
    && Number.isInteger(handshake.pid) && handshake.pid > 0;
  if (!wellFormed) {
    _gateFactsPush(facts, "daemon", false,
      "daemon 握手字段畸形——按可能在驱动本运行处理");
    return { ok: false, refusal: "daemon_owned" };
  }
  if (handshake.startedAt > completedAt) {
    _gateFactsPush(facts, "daemon", true, "daemon 握手晚于本运行到达 completed——daemon 跳过终态运行");
    return { ok: true };
  }
  if (d.daemonAliveFn(handshake, now)) {
    _gateFactsPush(facts, "daemon", false, "daemon 在本运行到达 completed 的同时或之前启动且握手新鲜");
    return { ok: false, refusal: "daemon_owned" };
  }
  const identity = await d.identifyFn(handshake.pid, handshake.startedAt);
  if (identity.verdict !== "gone") {
    _gateFactsPush(facts, "daemon", false,
      `daemon 在本运行到达 completed 的同时或之前启动，握手过期但 pid 判 ${identity.verdict}（${identity.basis}）`);
    return { ok: false, refusal: "daemon_owned" };
  }
  _gateFactsPush(facts, "daemon", true, `daemon 握手过期且 pid 判 gone（${identity.basis}）`);
  return { ok: true };
}

/**
 * 依次过六道门。任一门失败即返回闭集拒绝理由与已评估门的事实（后面的门不再
 * 评估——拒绝已确定，昂贵的运行时探测不必再跑）。
 * @param {object[]} events 全量转录事件
 * @param {string} runId
 * @param {string} runDir
 * @param {object} d 已补缺的注入集
 * @returns {Promise<{ok:true,state:string,sessionShape:string,facts:object[]}|{ok:false,refusal:string,facts:object[]}>}
 */
async function _evaluateGates(events, runId, runDir, d) {
  const facts = [];
  const now = d.nowFn();
  const bound = events.filter((e) => e && e.runId === runId);

  // 门 1：已知非终态。
  const state = findState(bound);
  if (TERMINAL_STATES.includes(state)) {
    _gateFactsPush(facts, "state", false, `运行已是终态 ${state}`);
    return { ok: false, refusal: "terminal", facts };
  }
  if (!RUN_STATES.includes(state)) {
    _gateFactsPush(facts, "state", false, "状态不在 RUN_STATES 闭集内");
    return { ok: false, refusal: "unknown_state", facts };
  }
  _gateFactsPush(facts, "state", true, `非终态 ${state}`);

  // 门 2：owner 租约。
  const leaseGate = await _evaluateOwnerLeaseGate(now, runDir, runId, d, facts);
  if (!leaseGate.ok) return { ok: false, refusal: leaseGate.refusal, facts };

  // 门 3：无活 runner（正面证据）。后台派发事实的时刻给扫描按创建时间收窄
  // （前台运行没有这条事实，不收窄——读不到命令行的进程照旧判扫描失败）。
  const scanNotBefore = _backgroundSubmittedMs(bound);
  const scanGate = await _evaluateRunnerScanGate(runId, d, facts,
    Number.isFinite(scanNotBefore) ? scanNotBefore : undefined);
  if (!scanGate.ok) return { ok: false, refusal: scanGate.refusal, facts };

  // 门 4：静默窗（只筛候选）。
  const quietGate = _evaluateQuietWindowGate(bound, now, facts);
  if (!quietGate.ok) return { ok: false, refusal: quietGate.refusal, facts };

  // 门 5：会话形状。
  const created = findLatestBound(events, "session.created", runId);
  let sessionShape;
  if (!created) {
    if (!bound.some((e) => e.type === "run.background_submitted")) {
      _gateFactsPush(facts, "session", false, "前台运行（无会话且无 background_submitted）——看不出监督进程是否还活着");
      return { ok: false, refusal: "foreground_no_session", facts };
    }
    sessionShape = "no_session";
    _gateFactsPush(facts, "session", true, "无会话但有 background_submitted（runner 在建会话前死亡）");
  } else if (typeof created.serveUrl === "string" && created.serveUrl.length > 0) {
    _gateFactsPush(facts, "session", false, "会话带 serveUrl——有停止通道，应用 wao stop");
    return { ok: false, refusal: "session_has_stop_route", facts };
  } else {
    const target = _resolveSessionPidAndAnchor(events, runId);
    if (!target) {
      _gateFactsPush(facts, "session", false, "重放记录与会话记录对不上，取不出唯一的 pid 与时刻锚");
      return { ok: false, refusal: "session_ambiguous", facts };
    }
    const identity = await d.identifyFn(target.pid, target.anchorAt);
    if (identity.verdict !== "gone") {
      const why = identity.verdict === "same" ? "process_alive" : "process_identity_unknown";
      _gateFactsPush(facts, "session", false, `会话进程判 ${identity.verdict}（${identity.basis}）`);
      return { ok: false, refusal: why, facts };
    }
    sessionShape = "process_session";
    _gateFactsPush(facts, "session", true, `会话进程判 gone（${identity.basis}）`);
  }

  // 门 6：无活 daemon。
  const daemonGate = _evaluateDaemonGate(now, runDir, d, facts);
  if (!daemonGate.ok) return { ok: false, refusal: daemonGate.refusal, facts };

  return { ok: true, state, sessionShape, facts };
}

/**
 * 验证者已不在的闭集拒绝理由（proveVerifierGone 的拒绝面）。除两项前提
 * （not_pending / foreground_verifier / resumed）外，其余与 settle 的门同名同义。
 */
export const VERIFIER_GONE_REFUSALS = Object.freeze([
  "not_pending",
  "foreground_verifier",
  "resumed",
  "owner_lease_corrupt",
  "owner_fresh",
  "owner_alive",
  "process_identity_unknown",
  "quiet_window",
  "daemon_owned",
  "runner_scan_failed",
  "runner_alive",
]);

/**
 * 只读证明：一个终态 completed、交付已验证创建但仍 pending 的后台运行，其验证
 * 进程是否**已经不在**（等待器据此如实退出）。
 *
 * 前提（不满足即拒，不进入昂贵探测）：
 *   1. 绑定状态恰为 completed，且有一条**绑定的** `run.state_change → completed`
 *      （legacy 末事件推断的 completed 不算——有界 pending 拒绝要求这条事实，
 *      没有它证明成立后 nextStep 指的拒收命令也会被拒）；
 *      validateDeliveryFacts（pending 感知、runId 绑定）valid、原始验证 pending、
 *      无 reverify 事实；
 *   2. 恰好一条绑定的 run.background_submitted（前台运行在 Lead 自己的 wao run
 *      进程里跑验证，转录不记它的 pid，无从证明）；
 *   3. 没有绑定的 run.rerun（驱动进程换过，租约主人不一定是验证者）。
 *
 * 证明（依次；任一不成立即拒）：owner 租约（门 2 同一实现）→ 静默窗（门 4）
 * → 没有可能在驱动它的 daemon → 本机进程扫描（门 3）。
 *
 * 成立返回 { gone:true, basis }，basis ∈ {lease_missing, pid_exited,
 * rebooted_since_anchor, pid_reused}；不回显 pid、路径或命令行。
 *
 * @param {object} input
 * @param {object[]} input.events — 已读出的转录事件（全量）
 * @param {string} input.runId — 须过 isValidRunId
 * @param {string} input.runDir — runs/ 目录
 * @param {object} [input.deps] — 与 settleRun 相同（nowFn/ownerLeaseReader/
 *   identifyFn/runnerScanFn/handshakeReader/daemonAliveFn）
 * @returns {Promise<{gone:true,basis:string}|{gone:false,refusal:string}>}
 */
export async function proveVerifierGone({ events, runId, runDir, deps = {} } = {}) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("runSettle: runId is required");
  }
  if (!isValidRunId(runId)) {
    throw new Error(`runSettle: invalid runId: ${JSON.stringify(runId)}`);
  }
  if (typeof runDir !== "string" || runDir.length === 0) {
    throw new Error("runSettle: runDir is required");
  }
  if (!Array.isArray(events)) {
    throw new Error("runSettle: events must be an array");
  }
  const d = _defaultDeps(deps);
  const facts = [];
  const now = d.nowFn();
  const bound = events.filter((e) => e && e.runId === runId);

  // 前提 1：终态 completed + 绑定的 state_change→completed + 交付显式 pending
  // 且无结果、无 reverify。绑定的 completed 事实是有界 pending 拒绝的同一前提：
  // legacy 末事件推断的 completed 不算——证明成立后 nextStep 指的拒收命令没有
  // 这条事实会被拒。
  const completedAt = _completedAtMs(events, runId);
  const state = findState(bound);
  const deliveryFacts = validateDeliveryFacts(events, {
    expectedRunId: runId,
    allowVerificationPending: true,
  });
  if (state !== "completed"
    || !Number.isFinite(completedAt)
    || !deliveryFacts.valid
    || deliveryFacts.verificationStatus !== "pending"
    || deliveryFacts.reverifyStatus !== "none") {
    return { gone: false, refusal: "not_pending" };
  }

  // 前提 2：恰好一条绑定的后台派发（前台运行的验证进程无 pid 可证）。
  if (bound.filter((e) => e.type === "run.background_submitted").length !== 1) {
    return { gone: false, refusal: "foreground_verifier" };
  }

  // 前提 3：没有绑定的 rerun（驱动进程换过，租约主人不一定是验证者）。
  if (bound.some((e) => e.type === "run.rerun")) {
    return { gone: false, refusal: "resumed" };
  }

  // 证明 1：owner 租约。
  const leaseGate = await _evaluateOwnerLeaseGate(now, runDir, runId, d, facts);
  if (!leaseGate.ok) return { gone: false, refusal: leaseGate.refusal };

  // 证明 2：静默窗。
  const quietGate = _evaluateQuietWindowGate(bound, now, facts);
  if (!quietGate.ok) return { gone: false, refusal: quietGate.refusal };

  // 证明 3：没有可能在驱动的 daemon（completedAt 由前提 1 保证可解析）。
  const daemonGate = await _evaluateVerifierDaemonGate(completedAt, now, runDir, d, facts);
  if (!daemonGate.ok) return { gone: false, refusal: daemonGate.refusal };

  // 证明 4：本机进程扫描（最贵，放最后）。后台派发事实的时刻给扫描按创建时间
  // 收窄（前提 2 已保证恰好一条；ts 读不出就不传）。
  const scanNotBefore = _backgroundSubmittedMs(bound);
  const scanGate = await _evaluateRunnerScanGate(runId, d, facts,
    Number.isFinite(scanNotBefore) ? scanNotBefore : undefined);
  if (!scanGate.ok) return { gone: false, refusal: scanGate.refusal };

  return { gone: true, basis: leaseGate.basis };
}

/**
 * 结算一个运行。dry-run（apply=false）只读不写；--apply 在写入前重新过全部
 * 的门，写入带 expectedLastSeq 守卫。
 *
 * @param {object} input
 * @param {string} input.runId — 须过 isValidRunId
 * @param {string} input.runDir — runs/ 目录
 * @param {string} input.reasonText — Lead 结算理由（调用方已校验非空）
 * @param {boolean} [input.apply=false]
 * @param {object} [input.deps] — 测试注入（nowFn/ownerLeaseReader/identifyFn/
 *   runnerScanFn/readTranscriptFn；handshakeReader + daemonAliveFn 为必注入——
 *   daemon 握手 SSOT 在 adapters 层，由 CLI 命令提供真实实现）
 * @returns {Promise<object>} { eligible, gates, note? } | { settled, … } |
 *   { refused, gates }（refused ∈ SETTLE_REJECTION_REASONS）
 */
export async function settleRun({ runId, runDir, reasonText, apply = false, deps = {} }) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("runSettle: runId is required");
  }
  if (!isValidRunId(runId)) {
    throw new Error(`runSettle: invalid runId: ${JSON.stringify(runId)}`);
  }
  if (typeof runDir !== "string" || runDir.length === 0) {
    throw new Error("runSettle: runDir is required");
  }
  const reason = typeof reasonText === "string" ? reasonText.trim().slice(0, SETTLE_REASON_BOUND) : "";
  if (reason.length === 0) {
    throw new Error("runSettle: reasonText must be non-empty");
  }
  const d = _defaultDeps(deps);

  let filePath;
  try {
    filePath = resolveTranscriptPath(runDir, runId, { forAppend: true });
  } catch (e) {
    if (e?.code === "transcript-not-found") {
      throw new Error(`runSettle: no transcript for run ${runId} in any layer`);
    }
    throw e;
  }
  let events;
  try {
    events = await d.readTranscriptFn(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`runSettle: no transcript for run ${runId}`);
    }
    throw err;
  }
  const bound = events.filter((e) => e && e.runId === runId);
  // 腐蚀防御：确认事实只应与终态转移原子落盘；【非终态】运行带着一条是持久
  // 记录损坏（再写一条会破坏 classifyRecoveryCandidate 的"恰好一条"判定）。
  // 已终态运行带着确认事实是正常形态——交给门 1 按 terminal 拒绝。
  if (!TERMINAL_STATES.includes(findState(bound))
    && bound.some((e) => e.type === PROCESS_MISSING_CONFIRMED_TYPE)) {
    throw new Error("runSettle: run already carries a process_missing confirmation in a nonterminal state (durable record corrupt)");
  }

  // 证明开始：记下最后 seq。
  const expectedLastSeq = findLastEventSeq(events);

  const verdict = await _evaluateGates(events, runId, runDir, d);
  if (!verdict.ok) {
    return { refused: verdict.refusal, gates: verdict.facts };
  }
  if (!apply) {
    return {
      eligible: true,
      state: verdict.state,
      sessionShape: verdict.sessionShape,
      expectedLastSeq,
      gates: verdict.facts,
      note: "dry-run（只读，零写入；结算须 --apply）",
    };
  }

  const transcript = new JsonlTranscript(filePath, {
    runId,
    agentId: bound[0]?.agentId ?? "unknown",
    initialSeq: expectedLastSeq,
  });
  const termResult = await transcript.transitionState(
    verdict.state,
    "failed",
    STATE_CHANGE_REASON.process_missing,
    {
      expectedLastSeq,
      factEvents: [{
        type: PROCESS_MISSING_CONFIRMED_TYPE,
        payload: {
          settledBy: "lead_settle",
          sessionShape: verdict.sessionShape,
          reason,
          reasonSha256: createHash("sha256").update(reason, "utf8").digest("hex"),
        },
      }],
    },
  );
  if (!termResult.accepted) {
    const refusal = termResult.rejection?.reason === "observed_seq_changed"
      ? "observed_seq_changed"
      : "terminal";
    return { refused: refusal, gates: verdict.facts };
  }
  return {
    settled: true,
    runId,
    state: "failed",
    sessionShape: verdict.sessionShape,
    reasonSha256: createHash("sha256").update(reason, "utf8").digest("hex"),
    gates: verdict.facts,
  };
}

/**
 * 列出候选（只读）：逐条列出没有新鲜 owner 心跳的非终态运行，各给能否结算或
 * 闭集拒绝理由。坏转录跳过（daemon scanAllRuns 同款惯例）。
 *
 * @param {object} input
 * @param {string} input.runDir
 * @param {object} [input.deps] — 同 settleRun 的注入集，另支持 ownerHeartbeatReader
 * @returns {Promise<{runDir:string, candidates:Array<object>}>}
 */
export async function listSettleCandidates({ runDir, deps = {} }) {
  if (typeof runDir !== "string" || runDir.length === 0) {
    throw new Error("runSettle: runDir is required");
  }
  const d = _defaultDeps(deps);
  const heartbeatReader = deps.ownerHeartbeatReader ?? checkOwnerLiveness;
  const now = d.nowFn();
  const files = d.listFilesFn(runDir);
  const candidates = [];
  for (const f of files) {
    const runId = f.name.replace(/\.jsonl$/, "");
    let events;
    try {
      events = await d.readTranscriptFn(f.path);
    } catch {
      continue; // 坏转录跳过，不影响其它运行的判定
    }
    const bound = events.filter((e) => e && e.runId === runId);
    const state = findState(bound);
    if (TERMINAL_STATES.includes(state)) continue;
    if (heartbeatReader(runDir, runId, now).fresh) continue;
    const verdict = await _evaluateGates(events, runId, runDir, d);
    candidates.push({
      runId,
      state,
      eligible: verdict.ok,
      ...(verdict.ok ? { sessionShape: verdict.sessionShape } : { refusal: verdict.refusal }),
      gates: verdict.facts,
    });
  }
  return { runDir, candidates };
}
