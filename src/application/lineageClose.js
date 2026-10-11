// src/application/lineageClose.js
//
// TD-254（决定 0058，2026-10-11）：交付线系闭合出口——Lead 显式放弃一条线系，
// 释放其保留 worktree（分支永不删）与（可释的）上游会话。会审
// consult_20261011085852683tcae2e（opus+sol）修正案全量落地：
//   - 成员枚举 = bound（e.runId===文件 runId，TD-128 族）的 run.session_reuse
//     {rootRunId} ∪ run.background_submitted {rootRunId}（续接 claim→转录窗口，
//     opus 漏形态①）∪ 根自身；孪生转录按 runId 去重、状态不一致拒绝；不可读
//     转录拒绝（不静默跳过——sol）。根转录缺席/不可解析 → root_missing 拒绝
//     （不往读不回来的地方写事实——opus Q3）。
//   - 并发封口：close 全程持按根 wx 文件锁；占用门 = 线系成员名下的复用/线系
//     槽条目 updatedAt 新鲜（RECENT_MS 内）→ lineage_busy 拒绝（覆盖 claim→转录
//     窗口；陈旧条目不堵）。continueRun 侧在变异相前读根转录闭态 → 拒绝
//     lineage_closed（闭集新拒因）。残余（check→claim 微窗）显式记录。
//   - tip 门（sol 漂移反例+opus 快照纪律）：成员集在 live git 读**之前**快照、
//     绝不按分支名反查扩充；live 分支 wao/<m> 必须 m∈快照；HEAD 必须等于该成员
//     的持久事实（已打包=deliveryCommit；未打包=run.started.delivery.baseCommit）
//     ——漂移提交（人在分支上推进过）→ head_drift 留树。dirty 工作树不阻塞但
//     记审计（放弃=丢弃未提交字节，强放弃合同显式化——sol）。
//   - closed≠released（两席）：已闭合重入 = 跳过写事实、**补偿重试释放**并返回
//     资源结果（W1b already_decided 的崩溃补偿缺口不复制）。
//   - 事实写根转录（Invariant 1 单一权威；0034 只禁重写冻结档不禁热转录追加）：
//     run.lineage_closed {rootRunId, reason(有界), reasonSha256}——理由正文进
//     持久事实（sol），路径不替代内容。
//   - 分支保留（与 0035 S5 原案"删树删分支"的偏离显式记录于 0058：缩小爆炸
//     半径；S5 由本出口的线系形态落地）。dry-run 默认，--apply 才动（opus）。

import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { listTranscriptsDeep } from "../projectBuckets.js";
import { readTranscript, TERMINAL_STATES } from "../transcript.js";
import { gitChildEnv } from "../delivery.js";
import { removeWorktree } from "../isolation.js";

const LOCK_STALE_MS = 600_000;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 100;
const SLOT_RECENT_MS = 300_000; // claim→转录窗口的占用门新鲜阈
const REASON_BOUND = 500;

async function readEventsSafe(path) {
  try { return { ok: true, events: await readTranscript(path) }; } catch (error) { return { ok: false, error }; }
}

function lastState(events, fileRunId) {
  let state = null;
  for (const e of events) {
    if (e && e.type === "run.state_change" && e.runId === fileRunId && typeof e.to === "string") state = e.to;
  }
  return state;
}

/** 线系根解析：bound session_reuse / background_submitted 的 rootRunId。 */
export function lineageRootFromEvents(events, fileRunId) {
  for (const e of events) {
    if (!e || e.runId !== fileRunId) continue;
    const srRoot = e.type === "run.session_reuse" && typeof e.rootRunId === "string" ? e.rootRunId : null;
    const bsRoot = e.type === "run.background_submitted" && typeof e.rootRunId === "string" ? e.rootRunId : null;
    if (srRoot || bsRoot) return srRoot ?? bsRoot;
  }
  return null;
}

/**
 * 枚举线系成员（全部项目桶，bound 读）。孪生转录状态不一致 → refuse。
 * @returns {{members:Array<{runId,state,worktreePath,deliveryCommit,baseCommit,sessionId,backend}>, refuse?:string}}
 */
export async function enumerateLineageMembers(rootRunId, files) {
  const byRun = new Map();
  for (const f of files) {
    const fileRunId = f.name.replace(/\.jsonl$/, "");
    const r = await readEventsSafe(f.path);
    if (!r.ok) return { members: [], refuse: `transcript_unreadable:${fileRunId}` };
    let inLineage = fileRunId === rootRunId;
    if (!inLineage) {
      for (const e of r.events) {
        if (!e || e.runId !== fileRunId) continue;
        if ((e.type === "run.session_reuse" || e.type === "run.background_submitted")
          && e.rootRunId === rootRunId) { inLineage = true; break; }
      }
    }
    if (!inLineage) continue;
    const state = lastState(r.events, fileRunId);
    const prev = byRun.get(fileRunId);
    if (prev && prev.state !== state) return { members: [], refuse: `twin_state_mismatch:${fileRunId}` };
    if (prev) continue;
    const started = r.events.find((e) => e && e.type === "run.started" && e.runId === fileRunId);
    const claim = r.events.find((e) => e && e.type === "session.created" && e.runId === fileRunId);
    // dogfood 修正：deliveryCommit 在 delivery 族事件里是**嵌套**载荷
    // （e.delivery.deliveryCommit——顶层字段缺席），两处都读，嵌套优先。
    let deliveryCommit = null;
    for (const e of r.events) {
      if (!e || e.runId !== fileRunId) continue;
      if (e.type !== "run.delivery_created" && e.type !== "run.delivery_accepted") continue;
      const nested = e.delivery && typeof e.delivery.deliveryCommit === "string" ? e.delivery.deliveryCommit : null;
      if (nested) deliveryCommit = nested;
      else if (typeof e.deliveryCommit === "string") deliveryCommit = e.deliveryCommit;
    }
    byRun.set(fileRunId, {
      runId: fileRunId,
      state,
      worktreePath: typeof started?.worktreePath === "string" ? started.worktreePath : null,
      baseCommit: typeof started?.delivery?.baseCommit === "string" ? started.delivery.baseCommit : null,
      deliveryCommit,
      sessionId: typeof claim?.backendSessionId === "string" ? claim.backendSessionId : null,
      serveUrl: typeof claim?.serveUrl === "string" ? claim.serveUrl : null,
      backend: typeof started?.backend === "string" ? started.backend : null,
      agentId: typeof r.events[0]?.agentId === "string" ? r.events[0].agentId : null,
    });
  }
  return { members: [...byRun.values()] };
}

/** 按根 wx 文件锁（与 close 侧同一 key；stale 600s 回收）。 */
export async function withLineageRootLock(runDir, rootRunId, fn) {
  const lockDir = join(runDir, "..", ".wao", "runs", "serve-maintenance", "lineage-locks");
  await mkdirSync(lockDir, { recursive: true });
  const key = createHash("sha256").update(`root=${rootRunId}`).digest("hex");
  const lockPath = join(lockDir, `${key}.lock`);
  const start = Date.now();
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf8");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const data = JSON.parse(await readFile(lockPath, "utf8"));
        if (Date.now() - Number(data.ts) > LOCK_STALE_MS) await unlink(lockPath).catch(() => {});
      } catch { /* 不可读让超时路径裁决 */ }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`lineageClose: root lock timeout (${rootRunId})`);
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }
  try { return await fn(); } finally { await handle.close().catch(() => {}); await unlink(lockPath).catch(() => {}); }
}

/** 线系闭态检查（continueRun 复用）：根转录 bound run.lineage_closed 在场即 true。 */
export function lineageClosedIn(events, fileRunId) {
  return events.some((e) => e && e.type === "run.lineage_closed" && e.runId === fileRunId);
}

const gitRevDefault = (path, args) => execFileSync("git", ["-C", path, ...args], {
  env: gitChildEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10_000,
}).toString().trim();

/**
 * 主入口。返回结构化结果（refuse 闭集 / 成员 / 释放结果）。apply=false=dry-run。
 */
export async function closeRunLineage({
  runId, runDir, reasonText, apply = false,
  readTranscriptFn = readTranscript, resolveTranscriptPathFn = null,
  gitRev = gitRevDefault, removeWorktreeFn = removeWorktree, existsFn = existsSync,
  nowMs = Date.now,
}) {
  if (typeof runId !== "string" || runId.length === 0) return { refuse: "malformed_input" };
  const reason = typeof reasonText === "string" ? reasonText.trim().slice(0, REASON_BOUND) : "";
  if (reason.length === 0) return { refuse: "reason_required" };
  const resolve = resolveTranscriptPathFn ?? (await import("../projectBuckets.js")).resolveTranscriptPath;
  const rootPath = resolve(runDir, runId);
  if (!existsFn(rootPath)) return { refuse: "root_missing" };
  const rootEvents = await readEventsSafe(rootPath);
  if (!rootEvents.ok) return { refuse: "root_missing" };
  const rootRunId = lineageRootFromEvents(rootEvents.events, runId) ?? runId;
  const files = listTranscriptsDeep(runDir);
  const enum1 = await enumerateLineageMembers(rootRunId, files);
  if (enum1.refuse) return { refuse: enum1.refuse };
  const members = enum1.members;
  if (!members.some((m) => m.runId === rootRunId)) return { refuse: "root_missing" };
  const nonTerminal = members.filter((m) => !TERMINAL_STATES.includes(m.state ?? ""));
  if (nonTerminal.length > 0) return { refuse: "member_not_terminal", members: nonTerminal.map((m) => ({ runId: m.runId, state: m.state })) };

  // 占用门：线系成员名下的槽条目新鲜 → busy（覆盖 continue claim→转录窗口）。
  const slotDir = join(runDir, ".wao", "session-reuse");
  const memberIds = new Set(members.map((m) => m.runId));
  if (existsFn(slotDir)) {
    for (const name of readdirSync(slotDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(await readFile(join(slotDir, name), "utf8"));
        if (memberIds.has(entry?.runId) && nowMs() - Number(entry?.updatedAt ?? 0) < SLOT_RECENT_MS) {
          return { refuse: "lineage_busy", busyRunId: entry.runId };
        }
      } catch { /* 单条不可读跳过（观察门，非权威） */ }
    }
  }

  // 快照纪律（opus）：成员集在 live git 读之前冻结；此后绝不按分支名反查扩充。
  const snapshot = new Set(members.map((m) => m.runId));
  const paths = [...new Set(members.map((m) => m.worktreePath).filter((p) => typeof p === "string" && p.length > 0))];
  const worktreePlans = paths.map((p) => {
    const norm = p.replace(/\//g, "\\").replace(/\\+$/, "");
    const idx = norm.lastIndexOf("\\");
    const parent = idx > 0 ? norm.slice(0, idx) : "";
    const pidx = parent.lastIndexOf("\\");
    const parentName = pidx >= 0 ? parent.slice(pidx + 1) : parent;
    if (parentName.toLowerCase() !== ".wao-worktrees") return { path: p, outcome: "skipped_unproven_path" };
    return { path: p, outcome: "planned" };
  });

  const dryRun = {
    rootRunId,
    members: members.map((m) => ({ runId: m.runId, state: m.state })),
    alreadyClosed: lineageClosedIn(rootEvents.events, rootRunId),
    worktrees: worktreePlans,
    note: "dry-run（--apply 执行：写闭合事实+按门释放树/会话）",
  };
  if (!apply) return dryRun;

  return withLineageRootLock(runDir, rootRunId, async () => {
    // 锁内重读根（close-vs-close）。
    const rootRe = await readEventsSafe(rootPath);
    if (!rootRe.ok) return { refuse: "root_missing" };
    const alreadyClosed = lineageClosedIn(rootRe.events, rootRunId);
    let closedNow = false;
    if (!alreadyClosed) {
      const { JsonlTranscript } = await import("../transcript.js");
      const seqBase = rootRe.events.length;
      const transcript = new JsonlTranscript(rootPath, {
        runId: rootRunId,
        agentId: rootRe.events[0]?.agentId ?? "unknown",
        initialSeq: rootRe.events[rootRe.events.length - 1]?.seq ?? seqBase,
      });
      await transcript.append("run.lineage_closed", {
        rootRunId,
        reason,
        reasonSha256: createHash("sha256").update(reason, "utf8").digest("hex"),
      });
      closedNow = true;
    }

    const results = [];
    const branchesKept = [];
    for (const plan of worktreePlans) {
      if (plan.outcome !== "planned") { results.push(plan); continue; }
      const p = plan.path;
      try {
        if (!existsFn(p)) { results.push({ path: p, outcome: "already_gone" }); continue; }
        const st = lstatSync(p);
        if (!st?.isDirectory() || st.isSymbolicLink()) { results.push({ path: p, outcome: "skipped_unproven_path" }); continue; }
        const branch = gitRev(p, ["rev-parse", "--abbrev-ref", "HEAD"]);
        const head = gitRev(p, ["rev-parse", "HEAD"]);
        let dirtyFiles = 0;
        try { dirtyFiles = gitRev(p, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean).length; } catch { dirtyFiles = -1; }
        const m = branch.startsWith("wao/") ? branch.slice(4) : null;
        if (!m || !snapshot.has(m)) { results.push({ path: p, outcome: "skipped_not_tip", branch }); continue; }
        const member = members.find((x) => x.runId === m);
        const expected = member?.deliveryCommit ?? member?.baseCommit ?? null;
        if (!expected || head.toLowerCase() !== expected.toLowerCase()) {
          results.push({ path: p, outcome: "skipped_head_drift", branch, head, expected });
          branchesKept.push(branch);
          continue;
        }
        await removeWorktreeFn(p);
        const outcome = existsFn(p) ? "failed_still_present" : "released";
        results.push({ path: p, outcome, branch, dirtyFiles });
        branchesKept.push(branch);
      } catch {
        results.push({ path: p, outcome: existsFn(p) ? "failed_still_present" : "released" });
      }
    }
    return {
      rootRunId,
      alreadyClosed,
      closedNow,
      members: members.map((m) => ({ runId: m.runId, state: m.state })),
      worktrees: results,
      branchesKept: [...new Set(branchesKept)],
      note: alreadyClosed ? "已闭合——补偿重试释放（closed≠released）" : undefined,
    };
  });
}
