// src/application/ownerArtifact.js
//
// 第 141a 批（决定 0131 §3）：Owner 看板只读 Git 对象的两个入口——交付提交的逐文件增删
// 行（git diff --numstat），以及交付提交里一个文件的图片字节（git cat-file）。
//
// 边界：
//   - 只读 Git 对象库：不读工作树文件，不接受任何路径参数——调用方给的是转录里已绑定的
//     交付提交与 changedFiles 里的一项，这里再验一遍形状（规范提交号、仓库相对路径）。
//   - 仓库取自项目记录绑定的仓库根（调用方传入）。只问这个目录自己的仓库：环境用
//     gitProbeEnv()（建在 gitChildEnv 之上、去掉 git 的定位变量），GIT_CEILING_DIRECTORIES 设成
//     它的父目录，git 不再向上发现祖先仓库。
//   - 结构化 argv，不经 shell；全局选项 --no-optional-locks；有界等待（超时）与输出上限。
//   - 类型按文件头魔数判，不看扩展名：只许 png、jpeg、webp，其余（含 SVG、伪装成 png 的
//     文本）一律拒绝；大小上限是具名常量，超过就拒绝。
//   - 失败只给闭集原因，不带 git 的报错文本或任何路径。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";

import { gitProbeEnv, isCanonicalCommitId, isValidRepoRelativePath } from "../delivery.js";

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
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * 文件头魔数 → 放行的内容类型；不认识 → null。png：8 字节签名；jpeg：FF D8 FF；webp：
 * `RIFF` + 4 字节长度 + `WEBP`。
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {string|null}
 */
export function sniffImageContentType(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.length >= PNG_MAGIC.length && head.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return "image/png";
  if (head.length >= JPEG_MAGIC.length && head.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return "image/jpeg";
  if (head.length >= 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
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
