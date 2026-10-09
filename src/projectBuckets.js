// src/projectBuckets.js
//
// TD-190 D2-②b（规格 v2.2，决定 0050/0051 批）：runs/ 转录**目录分桶**的写侧
// 权威与读侧解析链。落位说明（对规格 §2 的一处有意偏离）：规格写的是
// transcript.js，但 transcript.js 是形状/常数 SSOT——分桶解析是独立权威职责，
// 归入与 transcript.js 同层（layering core 桶）的本模块，不把读写权威混进
// 形状模块。
//
// 布局：新 run 转录写 `runs/projects/<slug>/<runId>.jsonl`；保留桶
// `_sandbox|_scratch|_unattributed`；旧平铺 `runs/<runId>.jsonl` 只读兼容
//（D3 实迁另窗）。`.owner-<runId>`、daemon/复用状态等跨项目资产常驻中心根；
// `.claims/<runId>` 是新 runId 的中心原子仲裁标记（并发首建竞态修复）。
//
// 桶名权威链（§6.1/§6.11-5）：key→slug 由**中心索引**（runs/projects/
// .index.json，缓存）+ **桶内 `.project.json`**（权威、可重建索引）承载；
// 索引/记录给出的 slug 一律过安全形状校验（SAFE_BUCKET_SLUG_RE——拒绝
// 路径分隔符与 `..` 越权）。读侧 cwdHint 只准经索引找桶，**不按现行规则
// 重推桶名**；写侧才派生新桶。碰撞（不同 key 同 slug）→ 校验 full key
// 拒绝并**加长哈希**（8→10→12…hex，扩长形状恒过 FACT_BUCKET_RE 校验器）；
// 老桶永不改名（冻结意图）。
//
// 读侧解析链（§2，opus 顺序）：①cwdHint→桶（经索引）→②旧平铺→③64 桶有界
// 扫描兜底。重复检测统一规则（验收批修复）：收集全部层命中（hint 桶+平铺+
// 扫描桶），sha256 全同→单一返回（优先级 hint 桶>字典序桶>平铺）；任一哈希
// 读失败或哈希不同→具名硬错（不判同、不择一）。快命中（①②）遇扫描超限→
// 可观测降级返回快命中（孪生检测不可用，经 findTranscriptTwin 可诊断），
// 无快命中时超限仍硬错。
// 同步实现（对规格 async 的一处有意偏离）：本地 fs 全同步可用，48 个消费点
// 多在同步上下文，免控制流重写；行为边界不变。

import { createHash } from "node:crypto";
import { tmpdir as osTmpdir } from "node:os";
import * as fsDefault from "node:fs";
import { join } from "node:path";
import { transcriptPathFor } from "./transcript.js";
import {
  identifyProjectFromCwd,
  isReservedBucketSlug,
  PROJECT_IDENTITY_RULES_VERSION,
} from "./projectIdentity.js";

export const PROJECTS_DIRNAME = "projects";
export const PROJECT_INDEX_NAME = ".index.json";
export const PROJECT_RECORD_NAME = ".project.json";
export const CLAIMS_DIRNAME = ".claims";
/**
 * 索引/记录给出的桶 slug 安全形状（验收批修复）：必须以字母数字开头、只含
 * [A-Za-z0-9._-]——`..`、`../../outside`、绝对/相对路径成分一律拒绝（索引是
 * 可手改的缓存文件，不得成为路径注入面）。FACT_BUCKET_RE 兼容（事实校验器
 * 可接受本形状的子集），比 projectIdentity 的记录形状校验更严（那侧管事实，
 * 这侧管路径安全）。
 */
export const SAFE_BUCKET_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 解析链第 3 级有界扫描上限（§6.10）：runs/projects/ 一层目录项数。 */
export const TRANSCRIPT_SCAN_BUCKET_LIMIT = 64;
export const PROJECT_RECORD_RETRIES = 3;
/** 桶记录并发半写重读的同步退避间隔（ms）——紧循环重读对半写窗口无效。 */
export const PROJECT_RECORD_RETRY_BACKOFF_MS = 20;

/** 具名错误闭集（closed-set；消费者按 code 分支，不 parse 文案）。 */
export const TRANSCRIPT_RESOLUTION_ERROR_CODES = Object.freeze([
  "transcript-resolution-scan-over-limit",
  "transcript-resolution-conflict",
  "transcript-not-found",
]);

export class TranscriptResolutionError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "TranscriptResolutionError";
    this.code = code;
    this.detail = detail;
  }
}

function defaultIo(io = {}) {
  return {
    mkdirSync: io.mkdirSync ?? fsDefault.mkdirSync,
    existsSync: io.existsSync ?? fsDefault.existsSync,
    readFileSync: io.readFileSync ?? fsDefault.readFileSync,
    writeFileSync: io.writeFileSync ?? fsDefault.writeFileSync,
    readdirSync: io.readdirSync ?? fsDefault.readdirSync,
    statSync: io.statSync ?? fsDefault.statSync,
    realpath: io.realpath ?? fsDefault.realpathSync,
    tmpdir: io.tmpdir ?? osTmpdir(),
    openSync: io.openSync ?? fsDefault.openSync,
    readSync: io.readSync ?? fsDefault.readSync,
    closeSync: io.closeSync ?? fsDefault.closeSync,
    sha256: io.sha256 ?? ((p) => createHash("sha256").update(fsDefault.readFileSync(p, "utf8"), "utf8").digest("hex")),
    sleepSync: io.sleepSync ?? ((ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }),
  };
}

/** 索引/记录给出的 slug 是否安全可用（形状+非保留名；路径成分拒绝）。 */
function isSafeBucketSlug(slug) {
  return typeof slug === "string" && SAFE_BUCKET_SLUG_RE.test(slug) && !isReservedBucketSlug(slug);
}

export function projectsDirFor(runDir) {
  return join(runDir, PROJECTS_DIRNAME);
}

// ─────────────────────────────────────────────────────────────────────────────
// 中心索引（缓存；权威 = 各桶 .project.json；损坏→扫描重建，不吞成 missing）
// ─────────────────────────────────────────────────────────────────────────────

function readProjectRecord(bucketDir, io) {
  // §6.11-6：wx 创建成功 ≠ 内容完整可读（并发半写）——有界重读+同步退避
  //（紧循环对半写窗口无效）；持续失败 = 显式错误，不得认作碰撞另建桶。
  let lastErr = null;
  for (let attempt = 0; attempt < PROJECT_RECORD_RETRIES; attempt++) {
    if (attempt > 0) io.sleepSync(PROJECT_RECORD_RETRY_BACKOFF_MS);
    try {
      return JSON.parse(io.readFileSync(join(bucketDir, PROJECT_RECORD_NAME), "utf8"));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new TranscriptResolutionError(
    "transcript-resolution-conflict",
    `project record unreadable after ${PROJECT_RECORD_RETRIES} reads: ${join(bucketDir, PROJECT_RECORD_NAME)} (${lastErr?.message ?? "unknown"})`,
  );
}

function listBucketDirs(runDir, io) {
  const root = projectsDirFor(runDir);
  if (!io.existsSync(root)) return [];
  const out = [];
  for (const name of io.readdirSync(root)) {
    if (name === PROJECT_INDEX_NAME) continue;
    const p = join(root, name);
    try {
      if (io.statSync(p).isDirectory()) out.push({ name, dir: p });
    } catch { /* 竞态删除：如实跳过 */ }
  }
  return out;
}

/** key→slug 索引读取；损坏/缺失/forceRebuild → 扫描 .project.json 重建（权威重建缓存）。 */
export function loadBucketIndex(runDir, { io, forceRebuild = false } = {}) {
  const i = defaultIo(io);
  const idxPath = join(projectsDirFor(runDir), PROJECT_INDEX_NAME);
  if (!forceRebuild) {
    try {
      const parsed = JSON.parse(i.readFileSync(idxPath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        return { entries: parsed.entries, rebuilt: false };
      }
    } catch { /* 损坏 → 重建 */ }
  }
  const entries = {};
  for (const { dir } of listBucketDirs(runDir, i)) {
    try {
      const rec = JSON.parse(i.readFileSync(join(dir, PROJECT_RECORD_NAME), "utf8"));
      // 验收批修复：记录给出的 slug 过安全形状（路径成分拒绝）；无效条目
      // 如实跳过（缓存重建），写侧命中路径仍会核验桶内权威。
      if (rec && typeof rec.key === "string" && isSafeBucketSlug(rec.slug)) entries[rec.key] = rec.slug;
    } catch { /* 无记录的保留桶（_sandbox 等）不入索引 */ }
  }
  return { entries, rebuilt: true };
}

function saveBucketIndex(runDir, entries, io) {
  try {
    io.mkdirSync(projectsDirFor(runDir), { recursive: true });
    io.writeFileSync(join(projectsDirFor(runDir), PROJECT_INDEX_NAME),
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 2), "utf8");
  } catch { /* 索引写失败不阻断（缓存可重建） */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// 写侧：resolveRunDirForWrite（桶只在这里决定/创建；调用方拿到目录后显式传递）
// ─────────────────────────────────────────────────────────────────────────────

/** 缓存/重建索引给出的 slug 是否可作为既有桶使用（安全形状+目录存在+权威核验）。 */
function confirmedBucketFor(runDir, key, slug, i) {
  if (!isSafeBucketSlug(slug)) return null; // `..`/分隔符/保留名——路径成分拒绝
  const dir = join(projectsDirFor(runDir), slug);
  if (!i.existsSync(dir)) return null;
  try {
    if (readProjectRecord(dir, i)?.key !== key) return null; // 权威=.project.json
  } catch {
    return null; // 记录不可读：不据此写档（缓存条目作废；显式路径见下方新建分支）
  }
  return dir;
}

/**
 * 为一次新写入决定转录目录（写侧唯一入口）。
 *
 * @param {string} runDir 中心状态根（runs/）——.owner 心跳文件/daemon/索引所在。
 * @param {object} identity identifyProjectFromCwd 输出（kind=project 需 key+displayName）。
 * @returns {{transcriptDir: string, bucket: string, kind: string}}
 *   bucket=最终写入位置（碰撞加长哈希后的最终 slug；事实里的 bucket 必须记这个值——
 *   该形状恒过 identityOfFirstEvent 的 FACT_BUCKET_RE 校验器，验收批 M2）。
 */
export function resolveRunDirForWrite(runDir, identity, { io } = {}) {
  const i = defaultIo(io);
  if (!runDir || typeof runDir !== "string") throw new Error("resolveRunDirForWrite: runDir required");
  if (!identity || typeof identity !== "object" || typeof identity.kind !== "string") {
    throw new Error("resolveRunDirForWrite: identity object with kind required");
  }
  if (identity.kind === "sandbox" || identity.kind === "scratch" || identity.kind === "unattributed") {
    const bucket = identity.kind === "sandbox" ? "_sandbox" : identity.kind === "scratch" ? "_scratch" : "_unattributed";
    const dir = join(projectsDirFor(runDir), bucket);
    i.mkdirSync(dir, { recursive: true });
    return { transcriptDir: dir, bucket, kind: identity.kind };
  }
  if (identity.kind !== "project") throw new Error(`resolveRunDirForWrite: unknown identity kind ${JSON.stringify(identity.kind)}`);
  if (typeof identity.key !== "string" || identity.key.length === 0 || typeof identity.displayName !== "string") {
    throw new Error("resolveRunDirForWrite: project identity requires key + displayName");
  }

  // 先写者胜：缓存索引命中 → 安全形状+桶内权威核验后沿用旧桶（冻结；永不按
  // 新规则重推）。核验不过 → 权威重建一次；仍无 → 走新建。
  const { entries } = loadBucketIndex(runDir, { io: i });
  if (typeof entries[identity.key] === "string") {
    const hit = confirmedBucketFor(runDir, identity.key, entries[identity.key], i);
    if (hit !== null) return { transcriptDir: hit, bucket: basename(hit), kind: "project" };
    const rebuilt = loadBucketIndex(runDir, { io: i, forceRebuild: true });
    if (typeof rebuilt.entries[identity.key] === "string") {
      const hit2 = confirmedBucketFor(runDir, identity.key, rebuilt.entries[identity.key], i);
      if (hit2 !== null) return { transcriptDir: hit2, bucket: basename(hit2), kind: "project" };
    }
  }
  // 新桶候选链（M2）：`<displayName>-<sha256(key)[0:n]>`，n=8→10→12…64——
  // 加长的是哈希段，形状恒过 FACT_BUCKET_RE（`-[0-9a-f]{8,}$`）；displayName
  // 首段是 Windows 保留名时全链加 `_x-` 前缀（破首段，同时过两校验器）。
  const root = projectsDirFor(runDir);
  const hash = createHash("sha256").update(identity.key, "utf8").digest("hex");
  const candidates = [];
  for (let n = 8; n <= hash.length; n += 2) candidates.push(`${identity.displayName}-${hash.slice(0, n)}`);
  if (candidates.some((c) => isReservedBucketSlug(c))) {
    // displayName 首段为 Windows 保留设备名（aux/con/nul/…）：加 `0-` 前缀破
    // 首段——同时通过 SAFE_BUCKET_SLUG_RE、FACT_BUCKET_RE 与保留名三校验。
    for (let k = 0; k < candidates.length; k++) candidates[k] = `0-${candidates[k]}`;
  }
  i.mkdirSync(root, { recursive: true });
  for (let ci = 0; ci < candidates.length; ci++) {
    const slug = candidates[ci];
    const dir = join(root, slug);
    if (!i.existsSync(dir)) i.mkdirSync(dir, { recursive: true });
    const recordPath = join(dir, PROJECT_RECORD_NAME);
    if (!i.existsSync(recordPath)) {
      try {
        // wx 独占创建（§6.2）：并发新建同桶只有一个成功；失败方走读取校验。
        const record = { key: identity.key, slug, displayName: identity.displayName, rulesVersion: PROJECT_IDENTITY_RULES_VERSION, createdAt: new Date().toISOString(), aliases: [] };
        i.writeFileSync(recordPath, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
      } catch (e) {
        if (e?.code !== "EEXIST") throw e;
      }
    }
    if (readProjectRecord(dir, i)?.key === identity.key) {
      entries[identity.key] = slug;
      saveBucketIndex(runDir, entries, i);
      return { transcriptDir: dir, bucket: slug, kind: "project" };
    }
    // 真·碰撞（不同 key 同 slug）→ 下一候选（更长哈希；永不覆盖既有记录）。
  }
  throw new TranscriptResolutionError("transcript-resolution-conflict",
    `bucket slug collision not resolvable after ${candidates.length} hash lengths for key ${identity.key}`);
}

/**
 * 新 runId 的中心原子仲裁（并发首建竞态修复，验收会审 sol 必改①/opus TD 案）：
 * wx 独占创建 `runs/.claims/<runId>`——两写者并发首个新 runId 只有一个成功；
 * 失败方必须按"既有档"重解析（对方此刻正在写），仍找不到=如实冲突。
 * 覆盖面=新代码写者互斥；旧代码写者不受约束（切换窗纪律+孪生硬错兜底）。
 */
export function claimRunIdForWrite(runDir, runId, { io } = {}) {
  const i = defaultIo(io);
  if (!runDir || typeof runDir !== "string") throw new Error("claimRunIdForWrite: runDir required");
  if (!runId || typeof runId !== "string") throw new Error("claimRunIdForWrite: runId required");
  const claimsDir = join(runDir, CLAIMS_DIRNAME);
  i.mkdirSync(claimsDir, { recursive: true });
  try {
    i.writeFileSync(join(claimsDir, runId),
      JSON.stringify({ pid: typeof process !== "undefined" ? process.pid : null, claimedAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (e) {
    if (e?.code === "EEXIST") return false;
    throw e;
  }
}

/** basename 助手（避免再引 node:path 的第二个具名导入形状）。 */
function basename(p) {
  const parts = String(p).replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

// ─────────────────────────────────────────────────────────────────────────────
// 事实构造（§6.1：事实里的 bucket 记**最终写入位置**，不是派生建议值）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由写侧决定结果构造首事件归属事实（与 projectIdentity.projectFactFromCwd
 * 同形，但 project 桶名取 resolveRunDirForWrite 的最终值——碰撞扩长后不回写
 * 已落事实的顺序问题由此消除：先定目录，再落事实）。
 */
export function projectFactForWrite(identity, resolved) {
  const base = { kind: identity.kind, rulesVersion: PROJECT_IDENTITY_RULES_VERSION };
  if (identity.kind === "project") {
    return { ...base, key: identity.key, bucket: resolved.bucket };
  }
  if (identity.kind === "sandbox") {
    return { ...base, key: "_sandbox", harness: identity.harness, worktreeName: identity.worktreeName, ...(identity.repoHint !== undefined ? { repoHint: identity.repoHint } : {}) };
  }
  if (identity.kind === "scratch") return { ...base, key: "_scratch" };
  return { ...base, reason: identity.reason };
}

/** 读转录首行的归属事实（有界 8KB 头读；无/坏形状 → null，不猜）。 */
export function readFirstProjectFact(transcriptPath, { io } = {}) {
  const i = defaultIo(io);
  try {
    const fd = i.openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = i.readSync(fd, buf, 0, buf.length, 0);
      const line = buf.toString("utf8", 0, n).split("\n", 1)[0];
      if (!line) return null;
      const first = JSON.parse(line);
      return first && typeof first === "object" && first.project !== undefined ? first.project : null;
    } finally {
      i.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 读侧：resolveTranscriptPath（三级链 + fast-hit 重复检测）与深层枚举
// ─────────────────────────────────────────────────────────────────────────────

function shaOfIfExists(path, io) {
  try {
    return io.sha256(path);
  } catch {
    return null;
  }
}

function bucketCandidateFromCwdHint(runDir, cwdHint, io) {
  if (typeof cwdHint !== "string" || cwdHint.length === 0) return null;
  const identity = identifyProjectFromCwd(cwdHint, { realpath: io.realpath, tmpdir: io.tmpdir });
  if (identity.kind !== "project") {
    const bucket = identity.kind === "sandbox" ? "_sandbox" : identity.kind === "scratch" ? "_scratch" : "_unattributed";
    const dir = join(projectsDirFor(runDir), bucket);
    return io.existsSync(dir) ? dir : null;
  }
  // §6.11-5：经冻结 key→slug 索引找桶——不按现行规则重推桶名。索引条目过
  // 安全形状（路径成分拒绝——缓存文件是可手改面）；核验不过 → 权威重建一次；
  // 仍无 → 无 hint（落 ②③ 层，语义不变）。
  const { entries } = loadBucketIndex(runDir, { io });
  let dir = confirmedBucketFor(runDir, identity.key, entries[identity.key], io);
  if (dir === null) {
    const rebuilt = loadBucketIndex(runDir, { io, forceRebuild: true });
    dir = confirmedBucketFor(runDir, identity.key, rebuilt.entries[identity.key], io);
  }
  return dir;
}

/**
 * 解析链（同步；§2 opus 顺序）。返回一个**路径字符串**：
 * 命中桶/平铺 → 该路径；全未命中 → 非 forAppend 时返回旧平铺路径（调用方
 * 的 ENOENT 语义与迁移前逐字节兼容），forAppend:true 时具名硬错
 * transcript-not-found（追加者不得误建旧平铺新文件——§6.9）。
 *
 * 重复检测统一规则（验收批修复：hint 与无 hint 同一套规则）——收集全部层
 * 命中（hint 桶 + 平铺 + 扫描桶去重）：
 *   - 仅一份 → 返回它；
 *   - 多份且 sha256 全同 → 单一返回，优先级 hint 桶 > 字典序最小桶 > 平铺
 *     （桶优先于平铺=§6.5；hint 是最强定位器）；
 *   - 任一哈希**读失败** → 具名硬错（null 不得与 null 判同——哈希失败=损坏，
 *     不猜）；哈希不同 → 具名硬错（列全路径，不择一）。
 * 扫描超限：有快命中（hint 桶/平铺）→ 可观测降级返回快命中（孪生检测此轮
 * 不可用；findTranscriptTwin 仍会硬错供诊断）；无快命中 → 保持具名硬错。
 */
export function resolveTranscriptPath(runDir, runId, { cwdHint = null, forAppend = false, io } = {}) {
  const i = defaultIo(io);
  if (!runDir || typeof runDir !== "string") throw new Error("resolveTranscriptPath: runDir required");
  if (!runId || typeof runId !== "string") throw new Error("resolveTranscriptPath: runId required");
  const flat = transcriptPathFor(runDir, runId);
  const flatExists = i.existsSync(flat);

  // ① cwdHint → 桶（经冻结索引+权威核验）。
  const hintedDir = bucketCandidateFromCwdHint(runDir, cwdHint, i);
  const hintedPath = hintedDir !== null && i.existsSync(transcriptPathFor(hintedDir, runId))
    ? transcriptPathFor(hintedDir, runId)
    : null;
  const fastPath = hintedPath ?? (flatExists ? flat : null);

  // ②③ 扫描层（含平铺/hint 未命中时的兜底定位 + 全层孪生检测）。
  let bucketHits;
  try {
    bucketHits = scanBucketHits(runDir, runId, i);
  } catch (e) {
    if (e instanceof TranscriptResolutionError && e.code === "transcript-resolution-scan-over-limit" && fastPath !== null) {
      // 可观测降级：快命中在场，孪生检测本轮放弃（诊断面 findTranscriptTwin）。
      return fastPath;
    }
    throw e;
  }
  const all = [...new Set([hintedPath, ...bucketHits, flatExists ? flat : null].filter((p) => p !== null))];
  if (all.length === 1) return all[0];
  if (all.length > 1) {
    const hashes = all.map((p) => shaOfIfExists(p, i));
    const badIdx = hashes.findIndex((h) => h === null);
    if (badIdx >= 0) {
      throw new TranscriptResolutionError("transcript-resolution-conflict",
        `runId ${runId} has multiple copies and one is unreadable (hash failed): ${all[badIdx]} — refusing to pick without comparison`);
    }
    if (new Set(hashes).size > 1) {
      throw multiBucketConflict(runId, all);
    }
    // 全同：hint 桶 > 字典序最小桶 > 平铺。
    if (hintedPath !== null) return hintedPath;
    const bucketOnly = all.filter((p) => p !== flat).sort((a, b) => a.localeCompare(b));
    return bucketOnly[0] ?? flat;
  }

  if (forAppend) {
    throw new TranscriptResolutionError("transcript-not-found",
      `runId ${runId} not found in any layer (flat or ${TRANSCRIPT_SCAN_BUCKET_LIMIT}-bucket scan); appenders must not create a legacy flat file`);
  }
  return flat;
}

function multiBucketConflict(runId, paths) {
  return new TranscriptResolutionError("transcript-resolution-conflict",
    `runId ${runId} has multiple distinct copies: ${paths.join(" | ")}`);
}

function scanBucketHits(runDir, runId, io) {
  const buckets = listBucketDirs(runDir, io);
  if (buckets.length > TRANSCRIPT_SCAN_BUCKET_LIMIT) {
    throw new TranscriptResolutionError("transcript-resolution-scan-over-limit",
      `projects/ has ${buckets.length} buckets (limit ${TRANSCRIPT_SCAN_BUCKET_LIMIT}); narrow with a cwdHint/--cwd or --project selector`);
  }
  const hits = [];
  for (const { dir } of buckets) {
    const p = transcriptPathFor(dir, runId);
    if (io.existsSync(p)) hits.push(p);
  }
  return hits;
}

/** 孪生观测（诊断/测试/daemon 恢复告警用；解析链自身已内建同规则）。 */
export function findTranscriptTwin(runDir, runId, { io } = {}) {
  const i = defaultIo(io);
  const flat = transcriptPathFor(runDir, runId);
  const bucketPaths = scanBucketHits(runDir, runId, i);
  if (bucketPaths.length === 0) return null;
  const flatExists = i.existsSync(flat);
  return {
    bucketPaths,
    flatPath: flatExists ? flat : null,
    flatSha256: flatExists ? shaOfIfExists(flat, i) : null,
  };
}

/**
 * 深层枚举（listTranscriptFiles 的两层扩容）：根层 + projects/* 桶内全部
 * `.jsonl`。根层在前（readdir 原序保持），桶按字典序、桶内保持 readdir 原序；
 * 归档目录在 runs/ 树外（决定 0050），天然不在枚举面。
 */
export function listTranscriptsDeep(runDir, { io } = {}) {
  const i = defaultIo(io);
  const out = [];
  if (i.existsSync(runDir)) {
    for (const name of i.readdirSync(runDir)) {
      if (name.endsWith(".jsonl")) out.push({ path: join(runDir, name), name, bucket: null });
    }
  }
  for (const { name, dir } of [...listBucketDirs(runDir, i)].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const f of i.readdirSync(dir)) {
      if (f.endsWith(".jsonl")) out.push({ path: join(dir, f), name: f, bucket: name });
    }
  }
  return out;
}
