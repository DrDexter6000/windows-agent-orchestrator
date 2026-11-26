// src/application/ownerArtifact.js
//
// 第 141a 批（决定 0131 §3）：Owner 看板只读 Git 对象的入口——交付对象的证明（提交类型、
// 父提交 = 基线、实际变更清单 = 转录声明的 changedFiles）与逐文件增删行（git diff
// --numstat），以及交付提交里一个文件的图片字节（git cat-file）。
//
// 边界：
//   - 只读 Git 对象库：不读工作树文件，不接受任何路径参数——调用方给的是转录里已绑定的
//     交付提交与 changedFiles 里的一项，这里再验一遍形状（规范提交号、仓库相对路径）。
//   - 仓库取自项目记录绑定的仓库根（调用方传入）。只问这个目录自己的仓库：环境用
//     gitProbeEnv()（建在 gitChildEnv 之上、去掉 git 的定位变量），GIT_CEILING_DIRECTORIES 设成
//     它的父目录，git 不再向上发现祖先仓库。
//   - 结构化 argv，不经 shell；全局选项 --no-optional-locks；有界等待（超时）与输出上限。
//   - 类型按文件结构判，不看扩展名、也不只看前缀：只许 png（签名后紧跟长度 13 的 IHDR）、
//     jpeg（FF D8 之后是合法标记段）、webp（RIFF 长度 = 文件长度 − 8，首块 VP8 / VP8L /
//     VP8X），其余（含 SVG、只有签名前缀的伪装文本）一律拒绝；大小上限是具名常量，超过就拒绝。
//   - 失败只给闭集原因，不带 git 的报错文本或任何路径。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";

import {
  commitMetaMatchesDelivery,
  commitMetaShowArgs,
  deliveryCommitMessage,
  gitProbeEnv,
  isCanonicalCommitId,
  isValidRepoRelativePath,
  isValidRunId,
} from "../delivery.js";

// 本模块要用的两个形状判定也从这里转出：服务层只 import 应用层模块。
export { isCanonicalCommitId, isValidRepoRelativePath };

/** 一次 Git 调用的等待上限（ms）。 */
export const OWNER_GIT_TIMEOUT_MS = 10_000;
/** git diff --numstat 输出的字节上限（超过就按读不到处理）。 */
export const OWNER_NUMSTAT_MAX_BYTES = 4 * 1024 * 1024;
/** 产物接口能给的单个图片文件的字节上限（超过就拒绝）。 */
export const OWNER_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
/** 同一份交付（仓库 + 基线 + 提交）的 numstat 结果至多缓存多少份（提交对象不可变）。 */
export const OWNER_NUMSTAT_CACHE_MAX = 64;
/** 产物接口放行的类型（魔数判定的结果）；其余一律拒绝。 */
export const OWNER_ARTIFACT_CONTENT_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** PNG 最短形状：签名 8 + IHDR 块（长度 4 + 类型 4 + 数据 13 + CRC 4）。 */
const PNG_MIN_BYTES = PNG_MAGIC.length + 4 + 4 + 13 + 4;
const PNG_IHDR_DATA_BYTES = 13;
const WEBP_FIRST_CHUNKS = Object.freeze(["VP8 ", "VP8L", "VP8X"]);

// PNG：签名之后必须紧跟长度为 13 的 IHDR 块。
function isPng(buf) {
  return buf.length >= PNG_MIN_BYTES
    && buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
    && buf.readUInt32BE(8) === PNG_IHDR_DATA_BYTES
    && buf.toString("latin1", 12, 16) === "IHDR";
}

// JPEG：FF D8 之后必须是合法的标记段——FF + 带段的标记码（C0–FE，去掉 C8 与无段的 RSTn / SOI /
// EOI）+ 不越过文件末尾的段长（段长含它自己的 2 字节）。
function isJpeg(buf) {
  if (buf.length < 6 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return false;
  const marker = buf[3];
  if (marker < 0xc0 || marker > 0xfe || marker === 0xc8 || (marker >= 0xd0 && marker <= 0xd9)) return false;
  const length = buf.readUInt16BE(4);
  return length >= 2 && 4 + length <= buf.length;
}

// WebP：RIFF 声明的长度 = 文件长度 − 8；偏移 12 处的首块是 VP8 / VP8L / VP8X 且块长不越界。
function isWebp(buf) {
  if (buf.length < 20 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return false;
  if (buf.readUInt32LE(4) !== buf.length - 8) return false;
  return WEBP_FIRST_CHUNKS.includes(buf.toString("latin1", 12, 16)) && 20 + buf.readUInt32LE(16) <= buf.length;
}

/**
 * 文件结构 → 放行的内容类型；不认识 → null。只看前缀不够（签名后面可以接任意文本），所以
 * 三种格式各验最小结构：png 的 IHDR 块、jpeg 的第一个标记段、webp 的 RIFF 长度与首个图像块
 * （见各自的判定函数）。不解码像素——这是"字节确实长得像这种图片"的门，不是图片校验器。
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {string|null}
 */
export function sniffImageContentType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(buf)) return "image/png";
  if (isJpeg(buf)) return "image/jpeg";
  if (isWebp(buf)) return "image/webp";
  return null;
}

/**
 * 缺省的只读 git 执行器：(args, repoRoot, { maxBuffer, timeoutMs }) → Promise<Buffer>。
 * 失败（非仓库、超时、输出超限、非零退出）一律以拒绝给出；调用方只关心成不成功。
 */
export function runGitReadOnly(args, repoRoot, { maxBuffer, timeoutMs }) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      {
        cwd: repoRoot,
        encoding: "buffer",
        // 在 gitProbeEnv() 之后追加 GIT_CEILING_DIRECTORIES：git 不再向上发现祖先仓库。
        env: { ...gitProbeEnv(), GIT_CEILING_DIRECTORIES: dirname(resolve(repoRoot)) },
        windowsHide: true,
        maxBuffer,
        timeout: timeoutMs,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

const NUMSTAT_RECORD_RE = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/;

/**
 * 交付提交相对基线的逐文件增删行：`git diff --numstat -z --no-renames <base> <commit>`。
 * 二进制文件的两个计数是 `-`，这里给 binary: true 与 null 计数。
 *
 * @param {object} input
 * @param {string} input.repoRoot — 项目仓库根
 * @param {string} input.baseCommit — 规范提交号
 * @param {string} input.commit — 规范提交号
 * @param {Function} [input.runGitFn=runGitReadOnly] — 注入缝（测试用）
 * @param {number} [input.timeoutMs]
 * @returns {Promise<Map<string, {added: number|null, deleted: number|null, binary: boolean}>>}
 * @throws 提交号形状不对、git 失败、超时、输出超限或解析不了
 */
export async function readDeliveryNumstat({
  repoRoot, baseCommit, commit, runGitFn = runGitReadOnly, timeoutMs = OWNER_GIT_TIMEOUT_MS,
}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) throw new Error("ownerArtifact: repoRoot required");
  if (!isCanonicalCommitId(baseCommit) || !isCanonicalCommitId(commit)) throw new Error("ownerArtifact: commit shape");
  const out = await runGitFn(
    ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", baseCommit, commit, "--"],
    repoRoot,
    { maxBuffer: OWNER_NUMSTAT_MAX_BYTES, timeoutMs },
  );
  const stats = new Map();
  for (const record of out.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const match = NUMSTAT_RECORD_RE.exec(record);
    if (match === null) throw new Error("ownerArtifact: numstat record shape");
    const binary = match[1] === "-" || match[2] === "-";
    stats.set(match[3], {
      added: binary ? null : Number(match[1]),
      deleted: binary ? null : Number(match[2]),
      binary,
    });
  }
  return stats;
}

/**
 * numstat 读取器：同一份交付（仓库 + 基线 + 提交）读一次就缓存——提交对象不可变，所以
 * 结果永不过期；只缓存成功的读取（失败下次重试），至多 OWNER_NUMSTAT_CACHE_MAX 份，
 * 满了丢最早的。
 *
 * @param {{runGitFn?: Function, timeoutMs?: number, maxEntries?: number}} [options]
 * @returns {(input: {repoRoot: string, baseCommit: string, commit: string}) => Promise<Map>}
 */
export function createNumstatReader({ runGitFn, timeoutMs, maxEntries = OWNER_NUMSTAT_CACHE_MAX } = {}) {
  const cache = new Map();
  return async function readNumstat({ repoRoot, baseCommit, commit }) {
    const key = `${repoRoot}\u0000${baseCommit}\u0000${commit}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const stats = await readDeliveryNumstat({
      repoRoot, baseCommit, commit, ...(runGitFn ? { runGitFn } : {}), ...(timeoutMs ? { timeoutMs } : {}),
    });
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(key, stats);
    return stats;
  };
}

/** 证明失败的两种闭集原因：对象读不到 / 读到了但与转录里声明的事实对不上。 */
export const OWNER_PROOF_FAILURE_REASONS = Object.freeze(["unreadable", "mismatch"]);
const UNREADABLE = Object.freeze({ ok: false, reason: "unreadable" });
const MISMATCH = Object.freeze({ ok: false, reason: "mismatch" });

/**
 * 交付对象的证明器：转录只是**声明**了交付（提交、基线、changedFiles），按声明去 Git 读
 * 之前先对仓库证明它。规则就是 src/delivery.js 的 assertDeliveryCommitInRepository：提交类型、
 * 父提交 = 基线且只有一个父、实际变更清单 = changedFiles、提交说明恰好是 `wao-delivery: <runId>`、
 * 作者与提交者是 WAO 固定打包身份。这里是它的**有界异步**版：内核是同步、没有超时的
 * execFileSync，不能放进 HTTP 服务的请求路径；这里每次 git 调用都经 runGitFn（只读结构化参数、
 * 超时、输出上限）。提交说明与身份的常量、argv、解析与比较直接用 delivery.js 导出的那一份
 * （deliveryCommitMessage / commitMetaShowArgs / commitMetaMatchesDelivery），不另写第二份。
 *
 * 证明本身每次请求都重做（对象可能被清掉，缓存的"还在"会骗人）；只有逐文件增删行按
 * (仓库, 基线, 提交) 缓存——提交对象不可变，所以增删行永不过期。证明过程中顺带拿到这份
 * 增删行，实际变更清单就取自它的键（同一次 `git diff`，不再多读一遍）。
 *
 * 结果：{ ok: true, stats } | { ok: false, reason: "unreadable" | "mismatch" }。
 *   unreadable = 形状不对、仓库或对象读不到、超时、输出超限；
 *   mismatch   = 读到了，但不是提交对象 / 父提交不是基线 / 清单对不上。
 *
 * @param {{runGitFn?: Function, timeoutMs?: number, readNumstat?: Function}} [options]
 * @returns {(input: {runId: string, repoRoot: string, baseCommit: string, commit: string, changedFiles: unknown}) =>
 *   Promise<{ok: true, stats: Map}|{ok: false, reason: string}>}
 */
export function createDeliveryProver({ runGitFn = runGitReadOnly, timeoutMs = OWNER_GIT_TIMEOUT_MS, readNumstat } = {}) {
  const numstat = readNumstat ?? createNumstatReader({ runGitFn, timeoutMs });
  return async function proveDelivery({ runId, repoRoot, baseCommit, commit, changedFiles }) {
    if (!isValidRunId(runId) || typeof repoRoot !== "string" || repoRoot.length === 0
      || !isCanonicalCommitId(baseCommit) || !isCanonicalCommitId(commit)) {
      return UNREADABLE;
    }
    const git = async (args, maxBuffer) => (await runGitFn(args, repoRoot, { maxBuffer, timeoutMs })).toString("utf8").trim();
    try {
      // 提交类型：它必须就是一个提交对象（--end-of-options + ^{commit}，同 delivery.js）。
      const resolved = await git(["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`], 256);
      if (resolved !== commit) return MISMATCH;
      // 父提交：恰好一个，且就是基线（合并提交伪造交付的防线）。
      const parents = (await git(["rev-list", "--parents", "-n", "1", commit], 512)).split(/\s+/);
      if (parents.length !== 2 || parents[0] !== commit || parents[1] !== baseCommit) return MISMATCH;
      // 归属：提交说明恰好是 `wao-delivery: <runId>`，作者与提交者是 WAO 固定打包身份——普通作者
      // 写的普通提交，父提交与清单再对也不是这个运行的交付。
      const meta = (await runGitFn(commitMetaShowArgs(commit), repoRoot, { maxBuffer: 64 * 1024, timeoutMs })).toString("utf8");
      if (!commitMetaMatchesDelivery(meta, deliveryCommitMessage(runId))) return MISMATCH;
      // 实际变更清单：必须逐项等于 changedFiles（顺序无关；空清单与重复项都不行）。
      const stats = await numstat({ repoRoot, baseCommit, commit });
      const actual = [...stats.keys()].sort();
      const claimed = Array.isArray(changedFiles) ? [...changedFiles].sort() : null;
      if (actual.length === 0 || claimed === null || actual.length !== claimed.length || actual.some((path, i) => path !== claimed[i])) {
        return MISMATCH;
      }
      return { ok: true, stats };
    } catch {
      return UNREADABLE;
    }
  };
}

/**
 * 交付提交里一个文件的图片字节：先 `git cat-file -s` 量大小（超限直接拒绝，不读内容），
 * 再 `git cat-file blob <commit>:<path>` 读字节，按文件头魔数判类型。
 *
 * @param {object} input
 * @param {string} input.repoRoot — 项目仓库根
 * @param {string} input.commit — 规范提交号
 * @param {string} input.path — 仓库相对路径（形状在这里再验一遍）
 * @param {Function} [input.runGitFn=runGitReadOnly] — 注入缝（测试用）
 * @param {number} [input.maxBytes=OWNER_ARTIFACT_MAX_BYTES]
 * @param {number} [input.timeoutMs]
 * @returns {Promise<{ok: true, contentType: string, bytes: Buffer}
 *   |{ok: false, reason: "unreadable"|"too_large"|"not_image"}>}
 */
export async function readCommitImage({
  repoRoot, commit, path, runGitFn = runGitReadOnly, maxBytes = OWNER_ARTIFACT_MAX_BYTES, timeoutMs = OWNER_GIT_TIMEOUT_MS,
}) {
  if (typeof repoRoot !== "string" || repoRoot.length === 0 || !isCanonicalCommitId(commit)
    || !isValidRepoRelativePath(path)) {
    return { ok: false, reason: "unreadable" };
  }
  // <commit>:<path> 以十六进制开头，不会被当成选项；路径里的 ":" 属于右半边。
  const spec = `${commit}:${path}`;
  try {
    const sizeText = (await runGitFn(["cat-file", "-s", spec], repoRoot, { maxBuffer: 64, timeoutMs })).toString("utf8").trim();
    if (!/^\d+$/.test(sizeText)) return { ok: false, reason: "unreadable" };
    if (Number(sizeText) > maxBytes) return { ok: false, reason: "too_large" };
    // 缓冲上限再留一手：量到的大小与读到的字节对不上时，超限读取直接失败。
    const bytes = await runGitFn(["cat-file", "blob", spec], repoRoot, { maxBuffer: maxBytes, timeoutMs });
    const contentType = sniffImageContentType(bytes);
    return contentType === null ? { ok: false, reason: "not_image" } : { ok: true, contentType, bytes };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
