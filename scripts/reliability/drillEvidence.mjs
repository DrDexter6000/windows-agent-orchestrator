// scripts/reliability/drillEvidence.mjs
//
// TD-186 复核 FAIL-B（2026-09-22 第二包）收口：drillRunIds 取证闭环（写入侧）。
//
// 复核实证：sentinel/scorecard drill 的 run 转录原本落在 TMP_DIR/runs/
// （runCli 子进程 cwd=tmpDir，CLI 的 runDir 默认 "runs" 随 cwd 相对解析），而
// run-reliability.mjs 结尾 rmSync(TMP_DIR) 把它们连同目录一并删除——summary 里
// 记录的 drillRunIds 指向已删除的证据。硬禁令：记录一个指向随后被删除的证据的 id。
//
// 方案（任务书三选一中的方案 1：转录保留在可解析位置）：
//   - sentinel/scorecard 派发显式 --run-dir 到 <runs>/reliability/，转录落
//     runs/reliability/<runId>.jsonl——runs/ 已 gitignore；runs 归档清扫只处理
//     runDir 顶层 *.jsonl，子目录语料不在清扫面内（smoke/、verify/ 同款先例）；
//     drillRunIds 的 id 按该固定约定可独立回查。选 1 而非 2/3 的理由：case 级
//     检查摘要（checks）本就内嵌在 summary.cases（"最小证据"已在场），runId 的
//     独有价值是通往原始 drill 转录（messages/tool 事件）的争议复核通道——置 null
//     （方案 3）会把争议复核永久降级为"信任摘要"。
//   - 守卫（写盘前）：本次运行的每个 id 必须有转录在场；任一缺失 = 接线断裂，
//     拒绝写新 summary 并非零退出（宁可丢本次运行结果，不记录悬空 id）。
//   - 清理（显式维护步骤）：发布路径【零删除】——生成/发布 summary 的路径只写
//     不删。删除唯一入口是 sweepStaleDrillTranscripts（经
//     scripts/reliability/prune-drill-transcripts.mjs 显式触发），它在删除前
//     【重新读取磁盘上的当前 summary】（绝不信调用方进程内快照），只删
//     「未被任何条目引用 且 超过年龄阈值」的 run_*.jsonl。
//
//     为什么发布路径不得删（2026-09-22 审计反例，交错发布误删证据）：旧版在写盘
//     后按【进程内】summary 的引用集清理，与其他发布者不协调——A 写 summary
//     （引用 run_a）→ B 写 summary（引用 run_b）并清理 run_a → A 恢复清理删
//     run_b ⇒ 磁盘上最终 summary 引用的 run_b 不存在；B 写完 summary 后中断、
//     A 再恢复清理亦复现。进程内快照在删除时刻必然是陈旧主张：竞态按构造消失的
//     唯一路径是发布者根本不删。维护步骤自身的 TOCTOU 窗口（读 summary 与
//     unlink 之间恰有并发发布者落盘新引用）由年龄阈值兜底：并发发布者刚产生的
//     转录必然年轻（单 worker wait-timeout 量级），远小于默认 7 天阈值；运行
//     纪律同 runs prune 清扫 runbook（维护时无进行中的 reliability 运行）。
//
// 纯函数 + 可注入 fs（测试不赌真实派发——与 certification.mjs 同款纪律）。
// 子目录名 SSOT 在 src/application/registryInventory.js
// （CERT_DRILL_TRANSCRIPTS_SUBDIR）——只读详情层逐 id 回查用同一份名字，
// 本模块下向 import，无第二份定义。

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CERT_DRILL_TRANSCRIPTS_SUBDIR } from "../../src/application/registryInventory.js";

// runManager 默认 runId 文件名形状（run_ + 数字时间戳 + base36 随机）。
// 清理面只认这个形状——防误删目录里任何非 runId 命名的文件。
export const DRILL_TRANSCRIPT_FILENAME_RE = /^run_[0-9a-z]+\.jsonl$/;

// 未引用转录的默认年龄阈值（7 天，与 `runs prune --older-than 7d` 清扫先例同款
// 量级）。作用：① 慢一拍的消费/取证窗口（刚被取代的转录不至于立刻消失）；
// ② 维护步骤 TOCTOU 窗口的兜底——并发发布者刚写出的转录必然年轻（单 worker
// wait-timeout 量级），远小于该阈值，即使维护步骤与其交错也不会删到将要被
// 引用的转录。超过它的删除决策才成立；增长有界的条件表述见 docs/usage.md。
export const DEFAULT_STALE_DRILL_TRANSCRIPT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function drillTranscriptsDir(runsDir) {
  return join(runsDir, CERT_DRILL_TRANSCRIPTS_SUBDIR);
}

export function drillTranscriptPath(transcriptsDir, runId) {
  return join(transcriptsDir, `${runId}.jsonl`);
}

/**
 * 收集 summary（或任意 case 数组包装）引用的全部 drillRunIds：非空字符串值，
 * 去重、保序。null（如实未记录）与形状外的值不收集——它们不是可回查主张。
 */
export function collectReferencedDrillRunIds(summary) {
  const ids = [];
  const seen = new Set();
  for (const c of Array.isArray(summary?.cases) ? summary.cases : []) {
    const map = c?.executionProfile?.drillRunIds;
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const runId of Object.values(map)) {
      if (typeof runId !== "string" || runId.length === 0) continue;
      if (!seen.has(runId)) {
        seen.add(runId);
        ids.push(runId);
      }
    }
  }
  return ids;
}

/**
 * 守卫：哪些 id 的转录不在场（fail-closed 检测；可注入 existsFn 供测试）。
 */
export function missingDrillTranscripts(runIds, transcriptsDir, existsFn = existsSync) {
  return runIds.filter((id) => !existsFn(drillTranscriptPath(transcriptsDir, id)));
}

/**
 * 写盘前的悬空 prior id 清理：返回【新】case 数组（原数组不动）——prior case 里
 * 转录不可回查的 drillRunIds 如实置 null（方案 3 语义：不可回查就不记 id），
 * 只动指针字段，checks/status 等判定字段一字不改。旧版取证（转录当时写在已被
 * 清理的临时目录）遗留的死指针由此从新写出的 summary 里消失；每条置 null 都
 * 被报告（调用方逐条告警），不是静默改史。
 */
export function nullUnresolvableDrillRunIds(cases, { transcriptsDir, existsFn = existsSync } = {}) {
  const nulled = [];
  const out = (Array.isArray(cases) ? cases : []).map((c) => {
    const map = c?.executionProfile?.drillRunIds;
    if (!map || typeof map !== "object" || Array.isArray(map)) return c;
    let changed = false;
    const next = {};
    for (const [drill, runId] of Object.entries(map)) {
      const resolvable = typeof runId === "string" && runId.length > 0
        && existsFn(drillTranscriptPath(transcriptsDir, runId));
      if (!resolvable && runId !== null && runId !== undefined) {
        next[drill] = null;
        changed = true;
        nulled.push({ caseId: c.caseId ?? "(unknown case)", drill, runId });
      } else {
        next[drill] = runId;
      }
    }
    return changed
      ? { ...c, executionProfile: { ...c.executionProfile, drillRunIds: next } }
      : c;
  });
  return { cases: out, nulled };
}

/**
 * 维护步骤（显式触发；发布路径零删除）：删除 transcriptsDir 下「未被【磁盘上
 * 当前 summary】引用 且 超过年龄阈值」的 run_*.jsonl。
 *
 * 硬约束（审计反例的根修面）：
 *   - 删除决策的唯一引用集来源 = 删除时刻从 summaryPath 重新读取的磁盘 summary
 *     （readFileFn 默认 readFileSync）——绝不用调用方进程内的 summary 快照。
 *     旧版 pruneUnreferencedDrillTranscripts 收 caller 传入的引用集，发布路径
 *     传进程内快照，交错发布时互删对方刚发布的证据（见文件头审计反例）；该
 *     函数已删除，本函数是唯一的删除入口。
 *   - summary 读不到 / 不可解析 → 一个都不删（fail-closed：没有协调依据就没有
 *     删除授权），status 如实报告原因。
 *   - 被引用的绝不删（无论多老）；未引用但未超龄的不删（年龄阈值是维护步骤
 *     自身 TOCTOU 窗口的兜底：并发发布者刚写出的转录必然年轻）。
 *   - 只删匹配 runId 文件名形状的文件，目录里其它名字一律不动。
 *
 * dryRun:true 只判定不删除（wouldRemove 列出将被清理的 runId）。
 * 单文件 stat/删除失败（Windows 文件锁）跳过不中断——下轮维护再清。
 * 目录不存在/不可读 → 空结果（无东西可清）。
 */
export function sweepStaleDrillTranscripts(transcriptsDir, summaryPath, {
  maxAgeMs = DEFAULT_STALE_DRILL_TRANSCRIPT_AGE_MS,
  now = Date.now(),
  dryRun = false,
  readdirFn = readdirSync,
  statFn = statSync,
  rmFn = rmSync,
  readFileFn = readFileSync,
} = {}) {
  const empty = { removed: 0, keptReferenced: 0, keptYoung: 0, skipped: 0, wouldRemove: [] };
  // ① 删除前重新读取磁盘上的当前 summary（唯一引用集来源）。
  const summaryRead = readSummaryFromDisk(summaryPath, readFileFn);
  if (!summaryRead.ok) {
    return { ...empty, status: `summary-${summaryRead.reason}` };
  }
  const referenced = new Set(collectReferencedDrillRunIds(summaryRead.summary));
  let entries;
  try {
    entries = readdirFn(transcriptsDir);
  } catch {
    return { ...empty, status: "transcripts-dir-unreadable" };
  }
  let removed = 0;
  let keptReferenced = 0;
  let keptYoung = 0;
  let skipped = 0;
  const wouldRemove = [];
  for (const name of entries) {
    if (typeof name !== "string" || !DRILL_TRANSCRIPT_FILENAME_RE.test(name)) continue;
    const runId = name.replace(/\.jsonl$/, "");
    if (referenced.has(runId)) {
      keptReferenced += 1;
      continue;
    }
    let mtimeMs;
    try {
      mtimeMs = statFn(join(transcriptsDir, name)).mtimeMs;
    } catch {
      skipped += 1; // stat 不可得（正被写/锁）→ 不删，下轮再看。
      continue;
    }
    if (!(now - mtimeMs > maxAgeMs)) {
      keptYoung += 1;
      continue;
    }
    if (dryRun) {
      wouldRemove.push(runId);
      continue;
    }
    try {
      rmFn(join(transcriptsDir, name), { force: true });
      removed += 1;
    } catch {
      skipped += 1; // 文件锁：跳过，下轮再清。
    }
  }
  return { status: "pruned", removed, keptReferenced, keptYoung, skipped, wouldRemove };
}

/**
 * 读磁盘 summary（可注入 readFileFn）。缺失（ENOENT）/不可解析/读取错误分别
 * 可辨——维护步骤对三者一律 fail-closed（不删任何东西），但报告的原因不同。
 */
function readSummaryFromDisk(summaryPath, readFileFn) {
  let raw;
  try {
    raw = readFileFn(summaryPath, "utf8");
  } catch (err) {
    return { ok: false, reason: err && err.code === "ENOENT" ? "missing" : "read-error" };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.cases)) {
      return { ok: false, reason: "unparseable" };
    }
    return { ok: true, summary: parsed };
  } catch {
    return { ok: false, reason: "unparseable" };
  }
}
