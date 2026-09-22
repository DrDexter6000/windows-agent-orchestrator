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
//   - 清理（写盘后）：删除该目录下未被引用的 run_*.jsonl——保留集 = 刚写出的
//     summary 引用的 id 集。重认证覆盖同 caseId，被取代的转录随之删除，不无限
//     增长；只删匹配 runId 文件名形状的文件，目录里其它名字一律不动。
//
// 纯函数 + 可注入 fs（测试不赌真实派发——与 certification.mjs 同款纪律）。
// 子目录名 SSOT 在 src/application/registryInventory.js
// （CERT_DRILL_TRANSCRIPTS_SUBDIR）——只读详情层逐 id 回查用同一份名字，
// 本模块下向 import，无第二份定义。

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CERT_DRILL_TRANSCRIPTS_SUBDIR } from "../../src/application/registryInventory.js";

// runManager 默认 runId 文件名形状（run_ + 数字时间戳 + base36 随机）。
// 清理面只认这个形状——防误删目录里任何非 runId 命名的文件。
export const DRILL_TRANSCRIPT_FILENAME_RE = /^run_[0-9a-z]+\.jsonl$/;

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
 * 清理：删除 transcriptsDir 下未被引用的 run_*.jsonl（保留集 = 引用集）。
 * 目录不存在/不可读 → 空结果（无东西可清）。单文件删除失败（Windows 文件锁）
 * 跳过不中断——下轮运行再清。返回删除/保留计数（计数只覆盖 runId 形状文件）。
 */
export function pruneUnreferencedDrillTranscripts(transcriptsDir, referencedRunIds, { readdirFn = readdirSync, rmFn = rmSync } = {}) {
  const referenced = new Set(referencedRunIds);
  let removed = 0;
  let kept = 0;
  let entries;
  try {
    entries = readdirFn(transcriptsDir);
  } catch {
    return { removed: 0, kept: 0 };
  }
  for (const name of entries) {
    if (typeof name !== "string" || !DRILL_TRANSCRIPT_FILENAME_RE.test(name)) continue;
    const runId = name.replace(/\.jsonl$/, "");
    if (referenced.has(runId)) {
      kept += 1;
      continue;
    }
    try {
      rmFn(join(transcriptsDir, name), { force: true });
      removed += 1;
    } catch {
      // 文件锁：跳过，下轮再清。
    }
  }
  return { removed, kept };
}
