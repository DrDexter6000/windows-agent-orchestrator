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
//   3. 本机没有命令行带 --run-id <runId> / --resume-run-id <runId> 的进程
//      （runner 已死的正面证据——心跳写入失败会被 runner 吞掉，单凭租约缺失
//      加静默不能证明 runner 已死）；
//   4. 静默窗（只筛候选，不替代第 3 条）；
//   5. 会话形状：无会话须有 background_submitted；proc_/hostPid 须判 gone；
//      serveUrl 拒（该用 wao stop）；
//   6. 没有活着的 daemon（resume-on-start 会接管 orphan）。
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
  "runner_alive", // 门 3：本机有带 --run-id/--resume-run-id <runId> 的进程
  "runner_scan_failed", // 门 3：进程命令行扫描失败
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
 * `$ErrorActionPreference='Stop'` 把 CIM 的非终止错误升级为终止错误：否则出错
 * 后计数照样输出 0、退出码 0，扫描失败会被读成"没有 runner"。判读见
 * parseRunnerScanOutput。命令行原文不出 PowerShell 进程。runId 已过
 * isValidRunId（闭字母表，无通配/引号字符），嵌入 -like 模式安全。
 * @param {string} runId
 * @param {Function} [execFileFn]
 * @returns {Promise<{alive:boolean}|{failed:true}>}
 */
export function defaultRunnerScan(runId, execFileFn = execFile) {
  return new Promise((resolve) => {
    const pattern = (flag) => `'*${flag} ${runId}*'`;
    const command = [
      "$ErrorActionPreference='Stop';",
      "$ex=@(); $pp=$PID; $n=0;",
      "while ($pp -and ($ex -notcontains [string]$pp) -and $n -lt 64) { $ex+=[string]$pp; $n++;",
      "  $q=Get-CimInstance Win32_Process -Filter ('ProcessId='+$pp);",
      "  if (-not $q) { break }; $pp=$q.ParentProcessId };",
      "$all=@(Get-CimInstance Win32_Process | Where-Object { $ex -notcontains [string]$_.ProcessId });",
      `$hit=@($all | Where-Object { $_.CommandLine -like ${pattern("--run-id")} -or $_.CommandLine -like ${pattern("--resume-run-id")} }).Count;`,
      "$blind=@($all | Where-Object { $_.Name -like 'node*' -and -not $_.CommandLine }).Count;",
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
  // （application）不得上向导入。CLI 命令（同层）静态导入 readHandshake/
  // isDaemonAlive 后注入；缺注入 = 接线错误，响亮失败（不静默跳过该门）。
  if (typeof deps.handshakeReader !== "function" || typeof deps.daemonAliveFn !== "function") {
    throw new Error("runSettle: daemon gate readers are required (inject handshakeReader + daemonAliveFn)");
  }
  const nowFn = typeof deps.nowFn === "function" ? deps.nowFn : Date.now;
  return {
    nowFn,
    ownerLeaseReader: deps.ownerLeaseReader ?? readOwnerLease,
    identifyFn: deps.identifyFn ?? identifyProcessIdentity,
    runnerScanFn: deps.runnerScanFn ?? ((runId) => defaultRunnerScan(runId)),
    handshakeReader: deps.handshakeReader,
    daemonAliveFn: deps.daemonAliveFn,
    readTranscriptFn: deps.readTranscriptFn ?? readTranscript,
    listFilesFn: deps.listFilesFn ?? listTranscriptsDeep,
  };
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
  const lease = d.ownerLeaseReader(runDir, runId, now);
  if (lease.present && !lease.wellFormed) {
    _gateFactsPush(facts, "owner_lease", false, "租约文件在场但畸形/损坏");
    return { ok: false, refusal: "owner_lease_corrupt", facts };
  }
  if (lease.present && lease.wellFormed && lease.fresh) {
    _gateFactsPush(facts, "owner_lease", false, "owner 心跳新鲜（监督进程还在）");
    return { ok: false, refusal: "owner_fresh", facts };
  }
  if (lease.present && lease.wellFormed && !lease.fresh) {
    const ownerIdentity = await d.identifyFn(lease.pid, lease.heartbeatAt);
    if (ownerIdentity.verdict !== "gone") {
      const why = ownerIdentity.verdict === "same" ? "owner_alive" : "process_identity_unknown";
      _gateFactsPush(facts, "owner_lease", false,
        `租约过期但 owner pid 判 ${ownerIdentity.verdict}（${ownerIdentity.basis}）`);
      return { ok: false, refusal: why, facts };
    }
    _gateFactsPush(facts, "owner_lease", true, `租约过期且 owner pid 判 gone（${ownerIdentity.basis}）`);
  } else {
    _gateFactsPush(facts, "owner_lease", true, "无租约文件（runner 可能已清理退出）");
  }

  // 门 3：无活 runner（正面证据）。
  const scan = await d.runnerScanFn(runId);
  if (scan.failed) {
    _gateFactsPush(facts, "runner_scan", false, "本机进程命令行扫描失败");
    return { ok: false, refusal: "runner_scan_failed", facts };
  }
  if (scan.alive) {
    _gateFactsPush(facts, "runner_scan", false, "本机仍有命令行带 --run-id/--resume-run-id 本运行的进程");
    return { ok: false, refusal: "runner_alive", facts };
  }
  _gateFactsPush(facts, "runner_scan", true, "本机没有该 runId 的 runner 进程");

  // 门 4：静默窗（只筛候选）。
  const lastBound = bound[bound.length - 1];
  const lastTs = lastBound ? Date.parse(lastBound.ts) : NaN;
  const quietMs = Number.isFinite(lastTs) ? now - lastTs : NaN;
  if (!Number.isFinite(quietMs) || quietMs < SETTLE_QUIET_WINDOW_MS) {
    const described = Number.isFinite(quietMs)
      ? `最后一条绑定事件距今 ${Math.max(0, Math.round(quietMs / 1000))}s（须 ≥ ${SETTLE_QUIET_WINDOW_MS / 60000}min）`
      : "最后一条绑定事件缺时间戳";
    _gateFactsPush(facts, "quiet_window", false, described);
    return { ok: false, refusal: "quiet_window", facts };
  }
  _gateFactsPush(facts, "quiet_window", true, `最后一条绑定事件距今 ${Math.round(quietMs / 60000)}min`);

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
  const handshake = d.handshakeReader(runDir);
  if (d.daemonAliveFn(handshake, now)) {
    _gateFactsPush(facts, "daemon", false, "有活着的 daemon（resume-on-start 会接管 orphan，归属不可分辨）");
    return { ok: false, refusal: "daemon_owned", facts };
  }
  _gateFactsPush(facts, "daemon", true, "没有活着的 daemon");

  return { ok: true, state, sessionShape, facts };
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
