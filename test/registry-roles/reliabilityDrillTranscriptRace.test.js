// test/registry-roles/reliabilityDrillTranscriptRace.test.js
//
// 2026-09-22 审计收口回归钉：交错发布误删证据（drill 转录清理）。
//
// 审计重放的漏洞（已实证，不再论证）：旧版发布路径在写盘后按【进程内】summary
// 的引用集清理 runs/reliability/，与其他发布者不协调——
//   A 写 summary（引用 run_a）→ B 写 summary（引用 run_b）并清理 run_a
//   → A 恢复清理删除 run_b ⇒ 磁盘上最终 summary 引用的 run_b 不存在。
//   B 写完 summary 后中断、A 再恢复清理亦复现。
// 根修：发布路径零删除（run-reliability.mjs 只写不删，结构钉在
// reliabilityCertification.test.js）；删除唯一入口 = sweepStaleDrillTranscripts
// （显式维护步骤），删除前重新读取磁盘上的当前 summary，只删「未被任何条目
// 引用 且 超过年龄阈值」的转录。
//
// 本文件三条行为钉（必须能红——变异验证记录见交付汇报）：
//   ① 审计反例重放（交错发布）：A 写→B 写→B 清→A 恢复清；
//   ② 审计反例重放（中断变体）：B 写完 summary 即中断，A 再收尾；
//   ③ 防退化：零删除不得退化成"永不清理"——超龄未引用会被维护步骤删除，
//      被引用的绝不删。
//
// 纪律：真实临时文件系统重放（mkdtemp + 真写盘），publish 复刻 run-reliability
// 的写盘序列（守卫 fresh → prior 悬空置 null → merge → summarize → write），
// 全部经 scripts/reliability 真实函数，不 mock 判定内核。

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drillTranscriptsDir,
  collectReferencedDrillRunIds,
  missingDrillTranscripts,
  nullUnresolvableDrillRunIds,
  sweepStaleDrillTranscripts,
  DEFAULT_STALE_DRILL_TRANSCRIPT_AGE_MS,
} from "../../scripts/reliability/drillEvidence.mjs";
import { summarizeCertification, mergeCaseResults } from "../../scripts/reliability/certification.mjs";

// —— 夹具 ——

// 认证 case（判定字段与本钉无关——只消费 executionProfile.drillRunIds）。
// 同一 caseId 模拟"并发重认证同一 lane"：后写者在 merge 中覆盖前者。
function certCase(caseId, runId) {
  return {
    caseId,
    agentId: "auditor",
    backend: "deepseek-harness",
    providerID: "deepseek",
    modelId: "deepseek-v3.2",
    providerKey: null,
    completionMode: "snapshot-stable",
    requiredCategories: ["core"],
    drills: ["sentinel"],
    profile: "full",
    checks: [],
    lastHealthyRunAt: null,
    executionProfile: {
      modelId: "deepseek-v3.2",
      providerID: "deepseek",
      providerKey: null,
      effort: "high",
      runtime: { node: "v22.23.1", verified: true },
      codeRef: "0123456789abcdef",
      capturedAt: "2026-09-22T00:00:00.000Z",
      drillRunIds: { sentinel: runId, scorecard: null },
    },
  };
}

// 复刻 run-reliability.mjs 的发布序列（守卫 fresh → prior 悬空置 null → merge →
// summarize → write）。返回进程内 summary 副本——【旧版清理的依据，审计反例中的
// "旧快照"】；新版发布路径到此为止，零删除。
function publishCase({ transcriptsDir, summaryPath, priorCases, freshCases }) {
  const freshRunIds = collectReferencedDrillRunIds({ cases: freshCases });
  const missing = missingDrillTranscripts(freshRunIds, transcriptsDir);
  if (missing.length > 0) {
    throw new Error(`publish guard rejected (dangling fresh ids): ${missing.join(", ")}`);
  }
  const merged = mergeCaseResults(priorCases, freshCases);
  const { cases } = nullUnresolvableDrillRunIds(merged, { transcriptsDir });
  const summary = summarizeCertification(cases);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  return summary;
}

// 硬禁令断言：磁盘上【最终】summary 引用的每个转录都必须存在。
function assertDiskSummaryRefsResolvable(summaryPath, transcriptsDir, label) {
  const disk = JSON.parse(readFileSync(summaryPath, "utf8"));
  const refs = collectReferencedDrillRunIds(disk);
  assert.ok(refs.length > 0, `${label}: 前置自检——磁盘 summary 确实引用了转录（否则本钉空转）`);
  assert.deepEqual(
    missingDrillTranscripts(refs, transcriptsDir),
    [],
    `${label}: 磁盘最终 summary 引用的每个转录都必须存在（审计硬禁令：summary 引用已删除的证据）`,
  );
  return disk;
}

function setupStage() {
  const dir = mkdtempSync(join(tmpdir(), "wao-td186-race-"));
  const runsRoot = join(dir, "runs");
  const transcriptsDir = drillTranscriptsDir(runsRoot);
  mkdirSync(transcriptsDir, { recursive: true });
  const summaryPath = join(runsRoot, "reliability-summary.json");
  const now = Date.now();
  // 把转录 mtime 拨到【阈值之外 1 天】：年龄闸救不了任何文件，"是否被磁盘 summary
  // 引用"是唯一防线——变异（删除不重读磁盘 summary）必须直接红，不被年龄闸掩盖。
  const beyondAge = new Date(now - DEFAULT_STALE_DRILL_TRANSCRIPT_AGE_MS - 24 * 60 * 60 * 1000);
  return { dir, runsRoot, transcriptsDir, summaryPath, now, beyondAge };
}

function writeTranscript(transcriptsDir, runId, mtime) {
  const p = join(transcriptsDir, `${runId}.jsonl`);
  writeFileSync(p, `{"runId":"${runId}"}\n`, "utf8");
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}

// —— 钉①：审计反例重放（交错发布）——

test("审计反例钉①（交错发布）: A 写→B 写→B 清→A 恢复清——最终 summary 引用的转录全部在场", () => {
  const { dir, transcriptsDir, summaryPath, now, beyondAge } = setupStage();
  try {
    writeTranscript(transcriptsDir, "run_a", beyondAge);
    writeTranscript(transcriptsDir, "run_b", beyondAge);

    // A、B 并发起跑：各自启动时读到的磁盘 prior 相同（空）——A 先收尾写盘。
    const priorAtStart = [];
    // A 收尾：写 summary_A（引用 run_a）。发布路径零删除——A 不清理。
    const summaryA = publishCase({
      transcriptsDir, summaryPath,
      priorCases: priorAtStart,
      freshCases: [certCase("auditor+effort-high", "run_a")],
    });
    // B 收尾：写 summary_B（引用 run_b；同 caseId 重认证，覆盖 A 的 case——
    // 此刻磁盘 summary 只引用 run_b）。
    publishCase({
      transcriptsDir, summaryPath,
      priorCases: priorAtStart,
      freshCases: [certCase("auditor+effort-high", "run_b")],
    });

    // 反例活性自检（非被测行为）：A 的进程内旧快照不含 run_b——旧版算法
    // （按进程内快照清理）在本夹具上必删 run_b，证明本钉针对的反例是活的。
    assert.equal(
      collectReferencedDrillRunIds(summaryA).includes("run_b"), false,
      "夹具活性：A 的旧快照不含 run_b（旧版 A 恢复清理必删它——反例在场）",
    );

    // B 的清理步骤 + A 恢复执行的清理步骤：新版里两者都是同一个显式维护 sweep，
    // 删除决策只看【删除时刻磁盘上的 summary】（此刻 = summary_B，引用 run_b）。
    sweepStaleDrillTranscripts(transcriptsDir, summaryPath, { now });
    sweepStaleDrillTranscripts(transcriptsDir, summaryPath, { now });

    const disk = assertDiskSummaryRefsResolvable(summaryPath, transcriptsDir, "交错发布");
    assert.deepEqual(collectReferencedDrillRunIds(disk), ["run_b"],
      "磁盘最终 summary 引用 run_b（B 后写覆盖同 caseId）");
    assert.equal(existsSync(join(transcriptsDir, "run_b.jsonl")), true,
      "run_b 在场（旧版：A 恢复清理按旧快照删掉它 ⇒ summary 引用已删除证据）");
    assert.equal(existsSync(join(transcriptsDir, "run_a.jsonl")), false,
      "run_a 未被引用且超龄——维护步骤确实清理（零删除不等于永不清理）");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// —— 钉②：审计反例重放（中断变体）——

test("审计反例钉②（中断变体）: B 写完 summary 即中断，A 再收尾——最终 summary 引用的转录全部在场", () => {
  const { dir, transcriptsDir, summaryPath, now, beyondAge } = setupStage();
  try {
    writeTranscript(transcriptsDir, "run_a", beyondAge);
    writeTranscript(transcriptsDir, "run_b", beyondAge);

    const priorAtStart = [];
    // A 收尾：写 summary_A（引用 run_a）。
    const summaryA = publishCase({
      transcriptsDir, summaryPath,
      priorCases: priorAtStart,
      freshCases: [certCase("auditor+effort-high", "run_a")],
    });
    // B 收尾：写 summary_B（引用 run_b）——随后【中断】：不再执行任何步骤
    // （旧版的 B 进程内清理没有发生）。
    publishCase({
      transcriptsDir, summaryPath,
      priorCases: priorAtStart,
      freshCases: [certCase("auditor+effort-high", "run_b")],
    });

    assert.equal(
      collectReferencedDrillRunIds(summaryA).includes("run_b"), false,
      "夹具活性：A 的旧快照不含 run_b（旧版 A 恢复清理必删它——中断变体反例在场）",
    );

    // A 恢复收尾。发布路径零删除——A 手里没有任何删除步骤；它仅能做的清理 =
    // 显式维护 sweep（删除前重读磁盘 summary = summary_B，引用 run_b）。
    const sweep = sweepStaleDrillTranscripts(transcriptsDir, summaryPath, { now });
    assert.equal(sweep.keptReferenced, 1, "run_b 作为被磁盘 summary 引用的转录保留");

    assertDiskSummaryRefsResolvable(summaryPath, transcriptsDir, "中断变体");
    assert.equal(existsSync(join(transcriptsDir, "run_b.jsonl")), true,
      "run_b 在场（旧版：A 按进程内旧快照清理 ⇒ 删 run_b，磁盘 summary 引用已删除证据）");
    assert.equal(sweep.removed, 1, "run_a（超龄未引用）仍被清理——A 的收尾推进了维护，没有借零删除逃避");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// —— 钉③：防退化（零删除 ≠ 永不清理）——

test("维护钉③（防零删除退化）: 超龄未引用转录被维护步骤删除；被引用的绝不删（无论多老）；未超龄不删", () => {
  const { dir, transcriptsDir, summaryPath, now, beyondAge } = setupStage();
  try {
    writeTranscript(transcriptsDir, "run_ref", beyondAge);   // 超龄 + 被引用
    writeTranscript(transcriptsDir, "run_stale1", beyondAge); // 超龄 + 未引用
    writeTranscript(transcriptsDir, "run_fresh1");      // 新鲜 + 未引用（不传 mtime）
    writeFileSync(summaryPath, JSON.stringify({
      version: 1,
      cases: [certCase("auditor+effort-high", "run_ref")],
    }), "utf8");

    const sweep = sweepStaleDrillTranscripts(transcriptsDir, summaryPath, { now });
    assert.equal(sweep.status, "pruned");
    assert.equal(sweep.removed, 1, "超龄未引用转录被删除——显式维护步骤仍有效");
    assert.equal(sweep.keptReferenced, 1, "被引用的保留");
    assert.equal(sweep.keptYoung, 1, "未超龄的保留（年龄阈值兜底并发发布窗口）");
    assert.equal(existsSync(join(transcriptsDir, "run_ref.jsonl")), true,
      "被引用的绝不删——即使已超龄（引用判定优先于年龄）");
    assert.equal(existsSync(join(transcriptsDir, "run_stale1.jsonl")), false,
      "超龄未引用的被删（否则目录无限增长）");
    assert.equal(existsSync(join(transcriptsDir, "run_fresh1.jsonl")), true,
      "未超龄未引用的不删（并发发布者可能正要引用它）");

    // 维护后再跑一次发布（重认证引用 run_fresh1——模拟慢一拍的发布者）：
    // 该转录当时未删，发布守卫通过，新 summary 引用可解析。
    publishCase({
      transcriptsDir, summaryPath,
      priorCases: [],
      freshCases: [certCase("auditor+effort-high", "run_fresh1")],
    });
    assertDiskSummaryRefsResolvable(summaryPath, transcriptsDir, "慢一拍发布者");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
