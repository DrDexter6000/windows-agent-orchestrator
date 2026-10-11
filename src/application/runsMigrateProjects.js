// src/application/runsMigrateProjects.js
//
// TD-190 D3（2026-10-09 批，Owner 批准的分桶路线；kimi+opus 裁定会审
// consult_20261009081329035swaqvc）：存量转录按项目分桶的**迁移计划器
//（dry-run 唯一形态）**。职责：
//   1. 对 runs/ 根层每个 *.jsonl 用首事件 cwd 经 projectIdentity（D1）归桶；
//   2. 跳过保留目录（reliability/ 等——跨项目集中台账不分桶）与非终态 run
//      （追加中搬家会撕裂转录——opus 迁移风险面）；
//   3. 输出每桶文件数+字节数+跳过清单，作为 Owner 实迁点名前的完整预览
//      （kimi 加固项）与 R1-R6 规则对真实存量的冒烟（AGENTS 铁律：分类类
//      改动必须对真实转录冒烟）。
//
// TD-256 批（2026-10-11，Owner goal 点名实迁；opus+sol 会审 consult_20261011142751539zdf6mb
// 修正案全采纳）：补 applyProjectsMigration/verifyProjectsMigration。
//   - 归宿判定复用写侧权威 resolveRunDirForWrite（decide-once/冻结桶/.project.json/
//     索引全复用；计划器仍是纯预览面，不信其直推 slug）。
//   - 在档事实缺 displayName 时补 basename(key)（与计划器 bucketSlugOf 回退同源
//     语义；不改写侧合同）；事实桶与权威桶不一致 → 该项拒绝上报。
//   - 移动原语 = 同卷 linkSync（EEXIST 原子拒——Windows rename 走
//     REPLACE_EXISTING 会静默覆盖目标，opus 会审）→ dst sha256 核对 → unlink src。
//     中间态=同 hash 孪生（解析链容忍）；EPERM/EBUSY 按单项失败记录不中止整批。
//   - manifest = .wao/migration/td190-d3/（0045-ledger 同款合法槽）下
//     apply-<ts>.jsonl：intent 行先写（src/dst/sha/slug/kind/rulesVersion）再动
//     文件、result 行后写——"link 成功、result 未写就崩溃"可由 intent+盘面续跑。
//   - 幂等四态：双在同 hash=删平铺侧；双在异 hash=twin_conflict 拒；仅 dst=
//     由既往 manifest 证明（sha 仍等=already_migrated；sha 变=dst_modified）；
//     双缺=anomaly 告警。非终态一律不动（fail-closed：不可证的绝不迁）。
//   - 归类原语与计划器同 SSOT（identityOfFirstEvent + TERMINAL_STATES +
//     FIRST_EVENT_TYPES）；循环壳各自独立（计划器零改动）。
//
// 架构契约：core 纯读服务（计划器）+ apply 受控写入（仅 manifest 台账与
// link/unlink 移动）；IO 全注入（测试可控）；不 import commands/mcp。

import { readdirSync as fsReaddirSync, statSync as fsStatSync, readFileSync as fsReadFileSync, mkdirSync as fsMkdirSync, appendFileSync as fsAppendFileSync, existsSync as fsExistsSync, linkSync as fsLinkSync, unlinkSync as fsUnlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { identityOfFirstEvent, deriveProjectBucketSlug, RUNS_RESERVED_DIRNAMES, PROJECT_IDENTITY_RULES_VERSION } from "../projectIdentity.js";
import { TERMINAL_STATES, transcriptPathFor } from "../transcript.js";
import { resolveRunDirForWrite } from "../projectBuckets.js";

// 首事件类型闭集（实测：run.started / run.background_submitted，两者都带 cwd）。
const FIRST_EVENT_TYPES = new Set(["run.started", "run.background_submitted"]);

/**
 * 对 runDir 根层存量做分桶迁移计划（纯读，零写入）。
 *
 * @param {{runDir: string, io?: {readdirSync?: Function, statSync?: Function, readFileSync?: Function, realpath?: Function, platform?: NodeJS.Platform, tmpdir?: string}}} input
 * @returns {{rulesVersion: string, buckets: Array<{slug: string, displayName: string, projectKey: string, fileCount: number, bytes: number, skippedNonTerminal: string[]}>, scratchFileCount: number, scratchBytes: number, unattributed: Array<{file: string, reason: string}>, reservedDirsSkipped: string[], scanned: number, parseFailures: Array<{file: string, reason: string}>}}
 */
export function planProjectsMigration({ runDir, io = {} }) {
  const readdirSync = io.readdirSync ?? fsReaddirSync;
  const statSync = io.statSync ?? fsStatSync;
  const readFileSync = io.readFileSync ?? fsReadFileSync;
  const realpath = io.realpath ?? ((p) => p);

  const rulesVersion = PROJECT_IDENTITY_RULES_VERSION; // 与 projectIdentity SSOT 同源（td190-r2：R1-R7+slug v1）——
  // 计划与未来写入侧的桶归属事实都携带该版本（opus 补强 1 的读侧对应物）。

  const out = {
    rulesVersion,
    slugConflicts: [],
    buckets: [],
    scratchFileCount: 0,
    scratchBytes: 0,
    sandboxFileCount: 0,
    sandboxBytes: 0,
    sandboxHarnesses: [],
    unattributed: [],
    reservedDirsSkipped: [],
    scanned: 0,
    parseFailures: [],
  };
  const bucketByKey = new Map();

  let entries = [];
  try {
    entries = readdirSync(runDir);
  } catch {
    return out; // runDir 不存在——空计划（首次安装形态）
  }
  for (const name of entries) {
    const isJsonl = name.endsWith(".jsonl");
    let isDir = false;
    try {
      isDir = statSync(`${runDir}/${name}`.replace(/\/$/, "")).isDirectory?.() ?? false;
    } catch { /* stat 失败按文件处理，读取阶段如实报错 */ }
    // 保留目录（reliability/verify/smoke/…）与 .session-reuse 等状态目录：跨项目
    // 集中资产，不分桶、不迁移（记录在案供报告呈现）。
    if (isDir) {
      if (RUNS_RESERVED_DIRNAMES.includes(name)) out.reservedDirsSkipped.push(name);
      continue;
    }
    if (!isJsonl) continue;
    out.scanned += 1;
    const file = name;

    let first;
    try {
      first = JSON.parse(readFileSync(joinPath(runDir, file), "utf8").trim().split("\n")[0]);
    } catch (error) {
      out.parseFailures.push({ file, reason: `first line unreadable/unparseable: ${error?.message ?? error}` });
      continue;
    }
    if (!FIRST_EVENT_TYPES.has(first?.type)) {
      out.parseFailures.push({ file, reason: `first event type ${JSON.stringify(first?.type)} not in ${[...FIRST_EVENT_TYPES].join("/")}` });
      continue;
    }

    // 终态检测：最后一条 run.state_change 的 to 在终态闭集才算可迁（非终态=
    // 可能在追加，搬家撕裂转录——跳过并点名）。读失败按非终态处理
    // （fail-closed：不可证的绝不迁）。
    let state = null;
    try {
      const lines = readFileSync(joinPath(runDir, file), "utf8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        let ev;
        try { ev = JSON.parse(lines[i]); } catch { continue; }
        if (ev?.type === "run.state_change" && typeof ev.to === "string") { state = ev.to; break; }
      }
    } catch { /* 读取失败按非终态处理（fail-closed：不可证的绝不迁） */ }

    // 终审 M2/F3：经共享校验入口 identityOfFirstEvent——在档事实优先（校验闭集
    // 后采用；坏事实入 parseFailures 不静默掩盖），legacy 回退推导。list --project
    // 同一入口，两侧语义不分叉。
    const { identity, factError } = identityOfFirstEvent(first, {
      platform: io.platform ?? process.platform,
      realpath,
      tmpdir: io.tmpdir,
    });
    if (factError !== null) {
      out.parseFailures.push({ file, reason: `recorded project fact rejected: ${factError}` });
      continue;
    }
    const bucketSlugOf = (id) => (id.kind === "project"
      ? (id.bucket ?? deriveProjectBucketSlug({ kind: "project", key: id.key, displayName: id.displayName ?? basenameOf(id.key) }))
      : null);
    // 终审 F2：同 key 不同在档 bucket（或事实与推导桶名分叉）不得静默合并——
    // slugConflicts 如实上报（slug 冻结意图的边界：记录归属冻结，但冲突必须可见）。
    const slugForThisFile = bucketSlugOf(identity);

    if (identity.kind === "unattributed") {
      out.unattributed.push({ file, reason: identity.reason ?? "unattributed (recorded fact)" });
      continue;
    }
    if (identity.kind === "scratch") {
      if (!TERMINAL_STATES.includes(state)) continue; // 非终态一律跳过（各桶同规则）
      out.scratchFileCount += 1;
      out.scratchBytes += fileSizeOf(statSync, runDir, file);
      continue;
    }
    if (identity.kind === "sandbox") {
      // R7：真活不是探针——独立 _sandbox 桶（与 scratch 分开），非终态同规则跳过。
      if (!TERMINAL_STATES.includes(state)) continue;
      out.sandboxFileCount += 1;
      out.sandboxBytes += fileSizeOf(statSync, runDir, file);
      const tag = `${identity.harness}:${identity.worktreeName}${identity.repoHint ? `→${identity.repoHint}` : ""}`;
      if (!out.sandboxHarnesses.includes(tag)) out.sandboxHarnesses.push(tag);
      continue;
    }
    // kind === "project"
    let bucket = bucketByKey.get(identity.key);
    if (!bucket) {
      bucket = {
        slug: slugForThisFile,
        displayName: identity.displayName ?? basenameOf(identity.key),
        projectKey: identity.key,
        fileCount: 0,
        bytes: 0,
        skippedNonTerminal: [],
      };
      bucketByKey.set(identity.key, bucket);
      out.buckets.push(bucket);
    } else if (bucket.slug !== slugForThisFile) {
      out.slugConflicts.push({ key: identity.key, bucketSlug: bucket.slug, conflictingSlug: slugForThisFile, file });
    }
    if (!TERMINAL_STATES.includes(state)) {
      bucket.skippedNonTerminal.push(file);
      continue;
    }
    bucket.fileCount += 1;
    bucket.bytes += fileSizeOf(statSync, runDir, file);
  }
  out.buckets.sort((a, b) => b.fileCount - a.fileCount);
  return out;
}


function basenameOf(key) {
  const parts = String(key).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "project";
}

function joinPath(dir, file) {
  return `${dir.replace(/[/\\]+$/, "")}/${file}`;
}

function fileSizeOf(statSync, runDir, file) {
  try {
    return statSync(joinPath(runDir, file)).size ?? 0;
  } catch {
    return 0;
  }
}

// ═══ TD-256 批：apply / verify（设计见模块头注）═══

function defaultIoApply(io) {
  return {
    readdirSync: io.readdirSync ?? fsReaddirSync,
    statSync: io.statSync ?? fsStatSync,
    readFileSync: io.readFileSync ?? fsReadFileSync,
    mkdirSync: io.mkdirSync ?? fsMkdirSync,
    appendFileSync: io.appendFileSync ?? fsAppendFileSync,
    existsSync: io.existsSync ?? fsExistsSync,
    linkSync: io.linkSync ?? fsLinkSync,
    unlinkSync: io.unlinkSync ?? fsUnlinkSync,
    realpath: io.realpath ?? ((p) => p),
    platform: io.platform ?? process.platform,
    tmpdir: io.tmpdir,
  };
}

function sha256OfFile(readFileSync, p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** 在档事实缺 displayName 时的迁移侧适配（不改写侧合同；与计划器回退同源语义）。 */
function identityForResolver(identity) {
  if (identity?.kind !== "project") return identity;
  if (typeof identity.displayName === "string" && identity.displayName.length > 0) return identity;
  return { ...identity, displayName: basenameOf(identity.key) };
}

/** 读既往 manifest 构建 runId → 已知迁移事实（intent/result 各行，last-wins）。 */
function loadPriorManifests(readdirSync, readFileSync, manifestDir) {
  const prior = new Map();
  let names = [];
  try { names = readdirSync(manifestDir); } catch { return prior; }
  for (const name of names.filter((n) => n.startsWith("apply-") && n.endsWith(".jsonl")).sort()) {
    let text = "";
    try { text = readFileSync(join(manifestDir, name), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e?.runId && (e.phase === "intent" || e.phase === "result") && typeof e.sha256 === "string") {
          const prev = prior.get(e.runId);
          if (!prev || (e.phase === "result") || prev.phase !== "result") prior.set(e.runId, e);
        }
      } catch { /* 单行坏 JSON 跳过（少证明不少伤害） */ }
    }
  }
  return prior;
}

/**
 * TD-190 D3 实迁（TD-256 批）。对 runDir 根层全部可迁转录执行 link→sha 核对→
 * unlink 移动；manifest 台账 intent/result 双行；幂等可续跑。环境门（active run、
 * daemon、路径合法性）由 CLI 层持有，本函数只做文件系统事实。
 *
 * @returns {{manifestPath: string, totals: Object, items: Array<Object>}}
 */
export function applyProjectsMigration({ runDir, manifestDir, io = {}, stamp = null }) {
  const i = defaultIoApply(io);
  const readFileSync = i.readFileSync;
  i.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, `apply-${stamp ?? Date.now()}.jsonl`);
  const appendManifest = (obj) => i.appendFileSync(manifestPath, `${JSON.stringify(obj)}\n`, "utf8");
  const prior = loadPriorManifests(i.readdirSync, readFileSync, manifestDir);

  const totals = {
    scanned: 0, migrated: 0, alreadyMigrated: 0, droppedFlatTwin: 0,
    keptNonTerminal: 0, twinConflicts: 0, factBucketMismatches: 0,
    failures: 0, anomalies: 0,
  };
  const items = [];

  let entries = [];
  try { entries = i.readdirSync(runDir); } catch { return { manifestPath, totals, items }; }
  for (const name of entries) {
    let isDir = false;
    try { isDir = i.statSync(joinPath(runDir, name)).isDirectory?.() ?? false; } catch { /* 按文件处理 */ }
    if (isDir) continue;
    if (!name.endsWith(".jsonl")) continue;
    totals.scanned += 1;
    const runId = name.replace(/\.jsonl$/, "");
    const src = joinPath(runDir, name);

    // 归类（与计划器同 SSOT 原语；fail-closed：不可证终态=不动）。
    let first;
    try { first = JSON.parse(readFileSync(src, "utf8").trim().split("\n")[0]); } catch (error) {
      totals.failures += 1; items.push({ runId, status: "failed:unparseable_first", detail: String(error?.message ?? error) }); continue;
    }
    if (!FIRST_EVENT_TYPES.has(first?.type)) {
      totals.failures += 1; items.push({ runId, status: "failed:not_first_event", detail: String(first?.type) }); continue;
    }
    let state = null;
    try {
      const lines = readFileSync(src, "utf8").trim().split("\n");
      for (let k = lines.length - 1; k >= 0; k -= 1) {
        let ev; try { ev = JSON.parse(lines[k]); } catch { continue; }
        if (ev?.type === "run.state_change" && typeof ev.to === "string") { state = ev.to; break; }
      }
    } catch { /* 读取失败按非终态处理 */ }
    if (!TERMINAL_STATES.includes(state)) {
      totals.keptNonTerminal += 1; items.push({ runId, status: "kept_non_terminal", state: state ?? "unreadable" }); continue;
    }
    const { identity, factError } = identityOfFirstEvent(first, { platform: i.platform, realpath: i.realpath, tmpdir: i.tmpdir });
    if (factError !== null) {
      totals.failures += 1; items.push({ runId, status: "failed:fact_rejected", detail: factError }); continue;
    }

    // 归宿：写侧权威（含 unattributed/scratch/sandbox 桶与冻结桶复用）。
    let resolved;
    try { resolved = resolveRunDirForWrite(runDir, identityForResolver(identity), { io: i }); }
    catch (error) {
      totals.failures += 1; items.push({ runId, status: "failed:resolver", detail: String(error?.message ?? error) }); continue;
    }
    if (identity.kind === "project" && typeof identity.bucket === "string" && identity.bucket !== resolved.bucket) {
      totals.factBucketMismatches += 1;
      items.push({ runId, status: "refused:fact_bucket_mismatch", detail: `fact=${identity.bucket} authority=${resolved.bucket}` });
      continue;
    }
    const dst = transcriptPathFor(resolved.transcriptDir, runId);
    const srcExists = i.existsSync(src);
    const dstExists = i.existsSync(dst);

    if (!srcExists && !dstExists) {
      totals.anomalies += 1; items.push({ runId, status: "anomaly:both_missing" }); continue;
    }
    if (!srcExists && dstExists) {
      const known = prior.get(runId);
      if (!known || known.dst !== dst) {
        totals.anomalies += 1; items.push({ runId, status: "anomaly:dst_only_unproven", dst }); continue;
      }
      const shaNow = sha256OfFile(readFileSync, dst);
      if (shaNow === known.sha256) {
        totals.alreadyMigrated += 1; items.push({ runId, status: "already_migrated", dst });
      } else {
        totals.anomalies += 1; items.push({ runId, status: "anomaly:dst_modified_after_migration", dst });
      }
      continue;
    }
    const srcSha = sha256OfFile(readFileSync, src);
    const reason = identity.kind === "unattributed" ? (identity.reason ?? "unattributed") : undefined;
    const base = {
      runId, src, dst, sha256: srcSha, kind: identity.kind, slug: resolved.bucket,
      rulesVersion: PROJECT_IDENTITY_RULES_VERSION, ...(reason ? { reason } : {}),
    };
    if (dstExists) {
      const dstSha = sha256OfFile(readFileSync, dst);
      if (dstSha === srcSha) {
        // 双在同 hash：删平铺侧（否则根层永远清不到零——opus 会审）。
        appendManifest({ ts: new Date().toISOString(), phase: "intent", op: "drop_flat_twin", ...base });
        try { i.unlinkSync(src); } catch (error) {
          totals.failures += 1; items.push({ runId, status: "failed:unlink_twin", detail: String(error?.code ?? error) }); continue;
        }
        appendManifest({ ts: new Date().toISOString(), phase: "result", op: "drop_flat_twin", ...base });
        totals.droppedFlatTwin += 1; items.push({ runId, status: "dropped_flat_twin", dst });
      } else {
        totals.twinConflicts += 1; items.push({ runId, status: "refused:twin_conflict", dst });
      }
      continue;
    }
    // src 在、dst 不在：intent → link（EEXIST 原子拒）→ dst sha 核对 → unlink src。
    appendManifest({ ts: new Date().toISOString(), phase: "intent", op: "migrate", ...base });
    try { i.linkSync(src, dst); } catch (error) {
      totals.failures += 1;
      items.push({ runId, status: `failed:link_${error?.code ?? "unknown"}`, detail: String(error?.message ?? error) });
      continue;
    }
    let dstSha = null;
    try { dstSha = sha256OfFile(readFileSync, dst); } catch { /* 下面核对会拒 */ }
    if (dstSha !== srcSha) {
      totals.failures += 1; items.push({ runId, status: "failed:sha_mismatch_after_link", dst });
      continue;
    }
    try { i.unlinkSync(src); } catch (error) {
      totals.failures += 1; items.push({ runId, status: "failed:unlink_src", detail: String(error?.code ?? error) });
      appendManifest({ ts: new Date().toISOString(), phase: "result", op: "migrate", incomplete: "src_unlink_failed", ...base });
      continue;
    }
    appendManifest({ ts: new Date().toISOString(), phase: "result", op: "migrate", ...base });
    totals.migrated += 1; items.push({ runId, status: "migrated", dst, slug: resolved.bucket });
  }
  return { manifestPath, totals, items };
}

/**
 * TD-190 D3 迁移后核对（只读）：既往 manifest 的每个已完成项 dst 在场且 sha 仍等
 * （sha 不等=迁移后有合法追加或损坏，仅报告）；根层剩余 .jsonl 清点（应只剩
 * 非终态/冲突/失败项）；"根层再现"（并发追加复活平铺文件——opus 会审）单独点名。
 */
export function verifyProjectsMigration({ runDir, manifestDir, io = {} }) {
  const i = defaultIoApply(io);
  const readFileSync = i.readFileSync;
  const prior = loadPriorManifests(i.readdirSync, readFileSync, manifestDir);
  const checked = { dstTotal: prior.size, dstMissing: [], shaMismatch: [], rootRemainder: [], reappeared: [] };
  for (const [runId, e] of prior) {
    if (!i.existsSync(e.dst)) { checked.dstMissing.push({ runId, dst: e.dst }); continue; }
    try {
      if (sha256OfFile(readFileSync, e.dst) !== e.sha256) checked.shaMismatch.push({ runId, dst: e.dst });
    } catch { checked.shaMismatch.push({ runId, dst: e.dst, reason: "unreadable" }); }
    if (i.existsSync(joinPath(runDir, `${runId}.jsonl`))) checked.reappeared.push({ runId });
  }
  let entries = [];
  try { entries = i.readdirSync(runDir); } catch { return checked; }
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    let isDir = false;
    try { isDir = i.statSync(joinPath(runDir, name)).isDirectory?.() ?? false; } catch { /* 按文件 */ }
    if (!isDir) checked.rootRemainder.push(name);
  }
  return checked;
}
