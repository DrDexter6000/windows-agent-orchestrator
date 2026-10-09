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

import { createHash, randomUUID } from "node:crypto";
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
export const SAFE_BUCKET_SLUG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
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
    rmSync: io.rmSync ?? fsDefault.rmSync,
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
  const unreadableBuckets = [];
  for (const { dir } of listBucketDirs(runDir, i)) {
    // 四轮 B：wx 创建与内容落盘之间的半写窗口（另一新 key 写者并发重建时
    // 可见空文件）≠损坏——非 ENOENT 读错误与解析失败都走**有界重读+退避**
    //（与 readProjectRecord 同纪律），重读仍失败才计不可读（三轮 sol②语义）。
    let rec = null;
    let unreadable = false;
    for (let retry = 0; retry < PROJECT_RECORD_RETRIES && rec === null && !unreadable; retry++) {
      if (retry > 0) i.sleepSync(PROJECT_RECORD_RETRY_BACKOFF_MS);
      try {
        const raw = i.readFileSync(join(dir, PROJECT_RECORD_NAME), "utf8");
        rec = JSON.parse(raw);
      } catch (e) {
        if (e?.code === "ENOENT") { rec = false; break; } // 无记录文件=保留桶，不入索引
        if (retry === PROJECT_RECORD_RETRIES - 1) unreadable = true;
      }
    }
    if (rec === false) continue;
    if (unreadable || rec === null) {
      unreadableBuckets.push(dir);
      continue;
    }
    // 验收批修复：记录给出的 slug 过安全形状（路径成分拒绝）；无效条目
    // 如实跳过（缓存重建），写侧命中路径仍会核验桶内权威。
    if (rec && typeof rec.key === "string" && isSafeBucketSlug(rec.slug)) entries[rec.key] = rec.slug;
  }
  return { entries, rebuilt: true, unreadableBuckets };
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
function confirmedBucketFor(runDir, key, slug, i, { onUnreadable = "null" } = {}) {
  if (!isSafeBucketSlug(slug)) return null; // `..`/分隔符/保留名——路径成分拒绝
  const dir = join(projectsDirFor(runDir), slug);
  if (!i.existsSync(dir)) return null;
  let rec;
  try {
    rec = readProjectRecord(dir, i);
  } catch (e) {
    // 复验 sol④：**写侧**（onUnreadable=throw）遇不可读权威记录=硬错——吞掉
    // 后落入新建分支会给同 key 建第二桶（sol 探针实证）。读侧 hint（null）维
    // 持降级（回落扫描层仍可定位转录——记录损坏不阻断读取）。
    if (onUnreadable === "throw") throw e;
    return null;
  }
  if (rec?.key !== key) return null; // 权威=.project.json
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
  // 新规则重推）。核验不过**或索引缺 key** → 权威重建一次再查（三轮 R1：索引
  // 是整读整写的缓存，并发写会丢条目——缺 key 不重建直接新建=同 key 双桶，
  // opus 探针实证；重建读全部 .project.json，代价=每新 key 首建多一遍扫描）。
  const { entries } = loadBucketIndex(runDir, { io: i });
  if (typeof entries[identity.key] === "string") {
    const hit = confirmedBucketFor(runDir, identity.key, entries[identity.key], i, { onUnreadable: "throw" });
    if (hit !== null) return { transcriptDir: hit, bucket: basename(hit), kind: "project" };
  }
  const rebuilt = loadBucketIndex(runDir, { io: i, forceRebuild: true });
  if (rebuilt.unreadableBuckets.length > 0) {
    // 三轮 sol②：写侧 fail-closed——重建遇不可读权威记录=硬错（吞掉会给同
    // key 另建桶）。读取/索引缓存不受影响（重建仅写路径触发）。
    throw new TranscriptResolutionError("transcript-resolution-conflict",
      `project record unreadable during index rebuild (write-side fail-closed): ${rebuilt.unreadableBuckets.join(" | ")}`);
  }
  if (typeof rebuilt.entries[identity.key] === "string") {
    const hit2 = confirmedBucketFor(runDir, identity.key, rebuilt.entries[identity.key], i, { onUnreadable: "throw" });
    if (hit2 !== null) {
      // 四轮 C：重建找回的条目**回写索引**——否则该 key 每次写都全量扫描
      // 且每次暴露在半写误读面下。
      saveBucketIndex(runDir, rebuilt.entries, i);
      return { transcriptDir: hit2, bucket: basename(hit2), kind: "project" };
    }
  }
  // 新桶候选链（M2）：`<displayName>-<sha256(key)[0:n]>`，n=8→10→12…64——
  // 加长的是哈希段，形状恒过 FACT_BUCKET_RE（`-[0-9a-f]{8,}$`）；displayName
  // 首段是 Windows 保留名时全链加 `0-` 前缀（破首段，同时过三校验器）。
  const root = projectsDirFor(runDir);
  const hash = createHash("sha256").update(identity.key, "utf8").digest("hex");
  const candidates = [];
  for (let n = 8; n <= hash.length; n += 2) candidates.push(`${identity.displayName}-${hash.slice(0, n)}`);
  if (candidates.some((c) => isReservedBucketSlug(c))) {
    // displayName 首段为 Windows 保留设备名（aux/con/nul/…）：加 "0-" 前缀破
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
      rebuilt.entries[identity.key] = slug; // 四轮 C：保存重建后的权威集（含找回条目）
      saveBucketIndex(runDir, rebuilt.entries, i);
      return { transcriptDir: dir, bucket: slug, kind: "project" };
    }
    // 真·碰撞（不同 key 同 slug）→ 下一候选（更长哈希；永不覆盖既有记录）。
  }
  throw new TranscriptResolutionError("transcript-resolution-conflict",
    `bucket slug collision not resolvable after ${candidates.length} hash lengths for key ${identity.key}`);
}

/** 释放 runId 仲裁标记（best-effort；验收复验 F1：claim 生命周期=仲裁成功→
 * 转录首条事实落盘/失败抛错——落盘后同 runId 写者走既有档分支，claim 即废）。
 */
export function releaseRunIdClaim(runDir, runId, { io, nonce = null } = {}) {
  const i = defaultIo(io);
  const claimPath = join(runDir, CLAIMS_DIRNAME, runId);
  // 四轮 R2/sol：读 nonce→rm 的 TOCTOU 由同一把互斥锁关闭（锁忙=stealer
  // 在临界区——跳过本次删除，TTL 自愈）。nonce 不匹配不删（慢持有者删不掉
  // 抢占者的新 claim）；nonce 入参缺省=不校验直接删（仅测试/清理路径）。
  // 五轮 opus-a：锁忙时**有界重试**（临界区毫秒级，3×20ms 足以让位）；
  // 重试仍忙=跳过本次删除（claim 由 TTL 自愈——台账 D 残余在册）。
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) i.sleepSync(PROJECT_RECORD_RETRY_BACKOFF_MS);
    const ran = withClaimLock(i, claimPath, () => {
      if (nonce !== null) {
        try {
          const parsed = JSON.parse(i.readFileSync(claimPath, "utf8"));
          if (parsed?.nonce !== nonce) return true;
        } catch {
          return true; // 不可读=不删（TTL 自愈）
        }
      }
      try {
        i.rmSync?.(claimPath, { force: true });
      } catch { /* best-effort：残留 claim 只影响该 runId 的重试提示，不影响真值 */ }
      return true;
    });
    if (ran) return;
  }
}

/**
 * 新 runId 的中心原子仲裁（并发首建竞态修复，验收会审 sol 必改①/opus TD 案）：
 * wx 独占创建 `runs/.claims/<runId>`——两写者并发首个新 runId 只有一个成功；
 * 失败方必须按"既有档"重解析（对方此刻正在写），仍找不到=如实冲突。
 * 覆盖面=新代码写者互斥；旧代码写者不受约束（切换窗纪律+孪生硬错兜底）。
 */
export function claimRunIdForWrite(runDir, runId, { io, stealAfterMs = 10 * 60_000 } = {}) {
  const i = defaultIo(io);
  if (!runDir || typeof runDir !== "string") throw new Error("claimRunIdForWrite: runDir required");
  if (!runId || typeof runId !== "string") throw new Error("claimRunIdForWrite: runId required");
  const claimsDir = join(runDir, CLAIMS_DIRNAME);
  const claimPath = join(claimsDir, runId);
  i.mkdirSync(claimsDir, { recursive: true });
  // 四轮 A/sol①：wx 只保证创建瞬间独占——stat→rm→wx 与 读nonce→rm 各自的
  // TOCTOU 交错（双胜者/删新持有者）已被两席探针实测推翻。终法=**互斥
  // steal 锁**包住整个临界区（抢占与释放共用 `.claims/<runId>.steal` 的 wx
  // 锁；锁窗口毫秒级，泄漏由 5s TTL 自清理；锁忙=对方在临界区——抢占方
  // 返回 false（fail-closed），释放方跳过本次删除（TTL 自愈））。
  let nonce = randomUUID();
  try {
    i.writeFileSync(claimPath, JSON.stringify({ pid: typeof process !== "undefined" ? process.pid : null, claimedAt: new Date().toISOString(), nonce }), { encoding: "utf8", flag: "wx" });
    return { claimed: true, nonce };
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
  }
  // EEXIST → 抢占评估（带锁）：陈旧（超 stealAfterMs 的一次性 TTL，不续期）
  // 才 unlink+wx 重试。
  if (!withClaimLock(i, claimPath, () => {
    let age;
    try {
      age = Date.now() - i.statSync(claimPath).mtimeMs;
    } catch {
      age = NaN;
    }
    if (!Number.isFinite(age) || age <= stealAfterMs) return false;
    i.rmSync?.(claimPath, { force: true });
    try {
      i.writeFileSync(claimPath, JSON.stringify({ pid: typeof process !== "undefined" ? process.pid : null, claimedAt: new Date().toISOString(), nonce }), { encoding: "utf8", flag: "wx" });
    } catch (e) {
      // 五轮 F2：rm 之后无锁快速路径可插入先成功——输家按契约返回 false，
      // 绝不把原始 EEXIST/EPERM 抛给调用方。
      if (LOCK_BUSY_CODES.has(e?.code)) return false;
      throw e;
    }
    return true;
  })) {
    return { claimed: false, nonce: null };
  }
  return { claimed: true, nonce };
}

/**
 * 互斥 claim 临界区锁（五轮终法，取代四轮版）。四轮版的三个实测缺口：
 *  ① Windows 删除挂起态下 wx 得 EPERM/EACCES（非 EEXIST）——原样上抛击穿
 *     dispatch 的"重解析→具名冲突"路径，release 抛错更会在首条事实落盘后
 *     中止派发（孤儿档风险）；
 *  ② 临界区内 rm 陈旧 claim 后，无锁快速路径可插入先 wx 成功——输家收到
 *     原始 EEXIST 而非约定的 claimed:false；
 *  ③ 陈旧锁回收 stat→rm 自身 TOCTOU（两回收者先后得锁；>TTL 卡顿持有者的
 *     finally 会删掉接管者的锁）。
 * 终法：忙=闭集 {EEXIST,EPERM,EACCES,EBUSY}（不抛）；陈旧回收用 **rename
 * 墓碑**（原子——rename 到唯一墓碑名只有一个胜者，败者 ENOENT）；锁载荷带
 * 持有者 token，finally 只删自己的锁（token 不匹配=已被回收接管，不删）。
 * 锁 TTL 30s（临界区毫秒级；卡顿持有者视为已死由回收接管）。
 */
const CLAIM_LOCK_TTL_MS = 30_000;
const LOCK_BUSY_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

function withClaimLock(i, claimPath, critical) {
  const lockPath = `${claimPath}.steal`;
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      i.writeFileSync(lockPath, JSON.stringify({ token, at: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
    } catch (e) {
      if (!LOCK_BUSY_CODES.has(e?.code)) throw e;
      // 忙 → 陈旧评估：超 TTL 用 rename 墓碑原子回收（单胜者；败者 ENOENT
      // 落入下方 stat/ENOENT 处理）。
      try {
        const age = Date.now() - i.statSync(lockPath).mtimeMs;
        if (Number.isFinite(age) && age > CLAIM_LOCK_TTL_MS) {
          i.renameSync?.(lockPath, `${lockPath}.dead-${token}`);
          continue; // 回收成功 → 重试 wx 一次
        }
      } catch { /* stat/rename 失败（含墓碑败者 ENOENT）→ 按忙 */ }
      return false; // 对方在临界区（fail-closed）
    }
    try {
      return critical();
    } finally {
      // 只删自己的锁：token 不匹配=已被陈旧回收接管（新持有者在临界区）。
      try {
        const raw = i.readFileSync(lockPath, "utf8");
        if (JSON.parse(raw)?.token === token) i.rmSync?.(lockPath, { force: true });
      } catch { /* 锁不可读/已不在：best-effort（TTL 兜底） */ }
    }
  }
  return false;
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
      // 复验 sol/S3：降级必须发信号（stderr 告警行——静默返回不算可观测）；
      // forAppend 不降级——追加者未完成孪生比较不得当作无冲突。
      if (forAppend) throw e;
      console.warn(`[transcript-resolution] scan over limit (${e.detail}); degraded to fast hit without twin check: ${fastPath}`);
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
    // 复验 F4：码元比较（localeCompare 随 locale 漂移——确定性要求）。
    const bucketOnly = all.filter((p) => p !== flat).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
  for (const { name, dir } of [...listBucketDirs(runDir, i)].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    for (const f of i.readdirSync(dir)) {
      if (f.endsWith(".jsonl")) out.push({ path: join(dir, f), name: f, bucket: name });
    }
  }
  return out;
}
