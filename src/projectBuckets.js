// src/projectBuckets.js
//
// TD-190 D2-②b（规格 v2.2，决定 0050/0051 批）：runs/ 转录**目录分桶**的写侧
// 权威与读侧解析链。落位说明（对规格 §2 的一处有意偏离）：规格写的是
// transcript.js，但 transcript.js 是纯形状/常数 SSOT（零 IO）——本模块为根级
// 新模块（import projectIdentity.js，方向与既有根模块一致），transcript.js
// 不引入 IO。
//
// 布局：新 run 转录写 `runs/projects/<slug>/<runId>.jsonl`；保留桶
// `_sandbox|_scratch|_unattributed`；旧平铺 `runs/<runId>.jsonl` 只读兼容
//（D3 实迁另窗）。`.owner-<runId>`、daemon/复用状态等跨项目资产常驻中心根。
//
// 桶名权威链（§6.1/§6.11-5）：key→slug 由**中心索引**（runs/projects/
// .index.json，缓存）+ **桶内 `.project.json`**（权威、可重建索引）承载；
// 读侧 cwdHint 只准经索引找桶，**不按现行规则重推桶名**；写侧才派生新桶。
// 碰撞（不同 key 同 slug）→ 校验 full key 拒绝并扩长后缀（astra 裁定）；
// 老桶永不改名（冻结意图）。
//
// 读侧解析链（§2，opus 顺序）：①cwdHint→桶（经索引）→②旧平铺→③64 桶有界
// 扫描兜底。fast-hit（①②）仍履行重复检测：桶+平铺同 runId 并存时，sha256
// 相同→桶内优先（可检测：findTranscriptTwin），sha256 不同→具名硬错（不择一）。
// 同步实现（对规格 async 的一处有意偏离）：本地 fs 全同步可用，48 个消费点
// 多在同步上下文，免控制流重写；行为边界不变。

import { createHash } from "node:crypto";
import { tmpdir as osTmpdir } from "node:os";
import * as fsDefault from "node:fs";
import { join } from "node:path";
import { transcriptPathFor } from "./transcript.js";
import {
  identifyProjectFromCwd,
  deriveProjectBucketSlug,
  isReservedBucketSlug,
  PROJECT_IDENTITY_RULES_VERSION,
} from "./projectIdentity.js";

export const PROJECTS_DIRNAME = "projects";export const PROJECT_INDEX_NAME = ".index.json";
export const PROJECT_RECORD_NAME = ".project.json";
/** 解析链第 3 级有界扫描上限（§6.10）：runs/projects/ 一层目录项数。 */
export const TRANSCRIPT_SCAN_BUCKET_LIMIT = 64;
export const PROJECT_RECORD_RETRIES = 3;

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
  };
}

export function projectsDirFor(runDir) {
  return join(runDir, PROJECTS_DIRNAME);
}

// ─────────────────────────────────────────────────────────────────────────────
// 中心索引（缓存；权威 = 各桶 .project.json；损坏→扫描重建，不吞成 missing）
// ─────────────────────────────────────────────────────────────────────────────

function readProjectRecord(bucketDir, io) {
  // §6.11-6：wx 创建成功 ≠ 内容完整可读（并发半写）——有界重读；持续失败 =
  // 显式错误，不得认作碰撞另建桶。
  let lastErr = null;
  for (let i = 0; i < PROJECT_RECORD_RETRIES; i++) {
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
      if (rec && typeof rec.key === "string" && typeof rec.slug === "string") entries[rec.key] = rec.slug;
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

/**
 * 为一次新写入决定转录目录（写侧唯一入口）。
 *
 * @param {string} runDir 中心状态根（runs/）——.owner 心跳文件/daemon/索引所在。
 * @param {object} identity identifyProjectFromCwd 输出（kind=project 需 key+displayName）。
 * @returns {{transcriptDir: string, bucket: string, kind: string}}
 *   bucket=最终写入位置（碰撞扩长后的最终 slug；事实里的 bucket 必须记这个值）。
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

  const { entries } = loadBucketIndex(runDir, { io: i });
  // 先写者胜：已有 key → 沿用旧桶（冻结；永不按新规则重推）。索引是缓存——
  // 命中后仍校验桶内记录的 key（陈旧/手改索引不据此写档）。
  let slug = typeof entries[identity.key] === "string" ? entries[identity.key] : null;
  if (slug !== null && i.existsSync(join(projectsDirFor(runDir), slug))) {
    let recordOk = false;
    try {
      recordOk = readProjectRecord(join(projectsDirFor(runDir), slug), i)?.key === identity.key;
    } catch {
      recordOk = false;
    }
    if (recordOk) {
      return { transcriptDir: join(projectsDirFor(runDir), slug), bucket: slug, kind: "project" };
    }
    // 索引指向的桶记录不匹配：如实重建（权威=.project.json），不走陈旧条目。
    const rebuilt = loadBucketIndex(runDir, { io: i, forceRebuild: true });
    const reslug = rebuilt.entries[identity.key];
    if (typeof reslug === "string" && i.existsSync(join(projectsDirFor(runDir), reslug))) {
      return { transcriptDir: join(projectsDirFor(runDir), reslug), bucket: reslug, kind: "project" };
    }
    slug = null;
  }
  // 新桶：按当前规则派生（必要时扩长——扩长只发生在创建时）。
  slug = deriveProjectBucketSlug(identity);
  if (isReservedBucketSlug(slug)) slug = `${slug}-x`;
  const root = projectsDirFor(runDir);
  i.mkdirSync(root, { recursive: true });
  let attempt = 0;
  for (;;) {
    const dir = join(root, slug);
    const record = { key: identity.key, slug, displayName: identity.displayName ?? null, rulesVersion: PROJECT_IDENTITY_RULES_VERSION, createdAt: new Date().toISOString(), aliases: [] };
    if (!i.existsSync(dir)) {
      i.mkdirSync(dir, { recursive: true });
    }
    const recordPath = join(dir, PROJECT_RECORD_NAME);
    if (!i.existsSync(recordPath)) {
      try {
        // wx 独占创建（§6.2）：并发新建同桶只有一个成功；失败方走 EEXIST 校验。
        i.writeFileSync(recordPath, JSON.stringify(record, null, 2), { encoding: "utf8", flag: "wx" });
      } catch (e) {
        if (e?.code !== "EEXIST") throw e;
      }
    }
    const existing = readProjectRecord(dir, i);
    if (existing && existing.key === identity.key) {
      entries[identity.key] = slug;
      saveBucketIndex(runDir, entries, i);
      return { transcriptDir: dir, bucket: slug, kind: "project" };
    }
    // 真·碰撞（不同 key 同 slug）/记录异 key：扩长重试（永不覆盖既有记录）。
    attempt += 1;
    if (attempt > 32) {
      throw new TranscriptResolutionError("transcript-resolution-conflict",
        `bucket slug collision not resolvable after 32 extensions for key ${identity.key}`);
    }
    slug = `${slug}-${attempt + 1}`;
  }
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
  // §6.11-5：经冻结 key→slug 索引找桶——不按现行规则重推桶名。
  const { entries } = loadBucketIndex(runDir, { io });
  const slug = entries[identity.key];
  if (typeof slug !== "string") return null;
  const dir = join(projectsDirFor(runDir), slug);
  return io.existsSync(dir) ? dir : null;
}

/**
 * 解析链（同步；§2 opus 顺序）。返回一个**路径字符串**：
 * 命中桶/平铺 → 该路径；全未命中 → 非 forAppend 时返回旧平铺路径（调用方
 * 的 ENOENT 语义与迁移前逐字节兼容），forAppend:true 时具名硬错
 * transcript-not-found（追加者不得误建旧平铺新文件——§6.9）。
 *
 * 重复检测（§6.5 统一规则，fast-hit 也履行）：桶+平铺同 runId 并存 →
 * sha256 相同=返回桶内路径（可经 findTranscriptTwin 观测，不静默吞孪生事实）；
 * sha256 不同=具名硬错 transcript-resolution-conflict（列出两路径，不择一）。
 * 扫描层多命中：哈希全同=字典序最小桶（同层固定次序）+可观测；哈希异=硬错。
 */
export function resolveTranscriptPath(runDir, runId, { cwdHint = null, forAppend = false, io } = {}) {
  const i = defaultIo(io);
  if (!runDir || typeof runDir !== "string") throw new Error("resolveTranscriptPath: runDir required");
  if (!runId || typeof runId !== "string") throw new Error("resolveTranscriptPath: runId required");
  const flat = transcriptPathFor(runDir, runId);
  const flatExists = i.existsSync(flat);

  // ① cwdHint → 桶（经索引）。
  const hinted = bucketCandidateFromCwdHint(runDir, cwdHint, i);
  if (hinted !== null) {
    const p = transcriptPathFor(hinted, runId);
    if (i.existsSync(p)) {
      if (flatExists) {
        const a = shaOfIfExists(p, i);
        const b = shaOfIfExists(flat, i);
        if (a !== b) {
          throw new TranscriptResolutionError("transcript-resolution-conflict",
            `runId ${runId} exists in bucket AND flat with different content: ${p} vs ${flat}`);
        }
      }
      return p;
    }
  }

  // ② 旧平铺（fast-hit 重复检测：反查 projects 层孪生）。
  if (flatExists) {
    const twins = scanBucketHits(runDir, runId, i);
    if (twins.length === 1) {
      const a = shaOfIfExists(twins[0], i);
      const b = shaOfIfExists(flat, i);
      if (a !== b) {
        throw new TranscriptResolutionError("transcript-resolution-conflict",
          `runId ${runId} exists flat AND in bucket with different content: ${flat} vs ${twins[0]}`);
      }
      return twins[0]; // 哈希同 → 桶内优先（§6.5 统一规则）
    }
    if (twins.length > 1) {
      throw multiBucketConflict(runId, twins);
    }
    return flat;
  }

  // ③ 64 桶有界扫描兜底。
  const hits = scanBucketHits(runDir, runId, i);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // 同层固定次序 + 哈希统一规则：全同 → 字典序最小；异 → 硬错。
    const hashes = hits.map((h) => shaOfIfExists(h, i));
    if (hashes.some((h) => h === null) || new Set(hashes).size > 1) {
      throw multiBucketConflict(runId, hits);
    }
    return [...hits].sort((a, b) => a.localeCompare(b))[0];
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
