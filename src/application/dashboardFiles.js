// src/application/dashboardFiles.js
//
// 第 145b 批（决定 0131 第 2 条）：状态目录里的实例记录、启动锁与实例日志。
//
//   - instance.json：{ protocol, runDir, pid, processCreatedAt, port, nonce, generation,
//     build }，先写临时文件再原子改名发布；读取按闭集形状校验，坏形状读作 null
//     （不猜）。candidate-<g>.json / result-<g>.json / stop-<g>.request 同一纪律。
//   - launch.lock：wx 独占创建，内容 { generation, deadline }；过期接管 = 原子改名到
//     launch.lock.stale-<旧代际>，改名成功的那一个接管（双过期接管只有一个赢家）；
//     锁不主动删除，到期自然失效。
//   - instance.log：每代重写（构造即截断），上限 DASHBOARD_INSTANCE_LOG_MAX_BYTES，
//     到顶写一行固定“日志已截断”后停止追加。绝不记录 URL、请求头、启动码、会话
//     令牌——调用方（dashboardServe）只喂固定的事件词与数字。
//
// 已知局限（一句话一条）：145b 之前的前台实例没有这些文件，新代码发现不了它。
//
// 架构契约：node:fs 只在此层出现；不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, unlinkSync, linkSync, existsSync } from "node:fs";

import { DASHBOARD_INSTANCE_LOG_MAX_BYTES } from "./dashboardPaths.js";

export const INSTANCE_FILE = "instance.json";
export const LOCK_FILE = "launch.lock";
export const INSTANCE_LOG_FILE = "instance.log";
export const CODES_DIR = "codes";

/** 子进程起不来时的闭集原因。 */
export const DASHBOARD_RESULT_REASONS = Object.freeze([
  "port_in_use",        // 固定端口被占（不把占用者当看板，也不杀它）
  "assets_missing",     // 固定静态资源读不出（服务构造失败）
  "state_dir_rejected", // 状态目录 ACL/重解析点核对不过
  "listen_failed",      // 监听失败（非端口占用）
  "serve_error",        // 其余启动期失败（如读不出自己的进程创建时间）
]);

const HEX16_RE = /^[0-9a-f]{16}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const TREE_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;
const isBuild = (v) => v !== null && typeof v === "object"
  && typeof v.readable === "boolean"
  && (v.srcTree === null || typeof v.srcTree === "string")
  && (v.dirty === null || typeof v.dirty === "boolean")
  && !(v.readable === true && typeof v.srcTree !== "string");

/** instance.json 的闭集形状（多余键拒绝）。 */
function validInstance(value) {
  if (value === null || typeof value !== "object") return false;
  const keys = Object.keys(value);
  if (keys.length !== 8) return false;
  for (const k of ["protocol", "runDir", "pid", "processCreatedAt", "port", "nonce", "generation", "build"]) {
    if (!Object.hasOwn(value, k)) return false;
  }
  if (!Number.isInteger(value.protocol) || value.protocol < 1) return false;
  if (typeof value.runDir !== "string" || value.runDir.length === 0) return false;
  if (!Number.isInteger(value.pid) || value.pid <= 0) return false;
  if (typeof value.processCreatedAt !== "number" || !Number.isFinite(value.processCreatedAt)) return false;
  if (!isPort(value.port)) return false;
  if (typeof value.nonce !== "string" || !NONCE_RE.test(value.nonce)) return false;
  if (typeof value.generation !== "string" || !HEX16_RE.test(value.generation)) return false;
  return isBuild(value.build);
}

/** candidate-<g>.json 的闭集形状（145b 修正一：候选自带实际服务的 build）。 */
function validCandidate(value) {
  if (value === null || typeof value !== "object") return false;
  const keys = Object.keys(value);
  if (keys.length !== 5) return false;
  for (const k of ["port", "pid", "nonce", "processCreatedAt", "build"]) {
    if (!Object.hasOwn(value, k)) return false;
  }
  return isPort(value.port)
    && Number.isInteger(value.pid) && value.pid > 0
    && typeof value.nonce === "string" && NONCE_RE.test(value.nonce)
    && typeof value.processCreatedAt === "number" && Number.isFinite(value.processCreatedAt)
    && isBuild(value.build);
}

/** 写 JSON 文件：先写临时文件再原子改名（半写窗口外不可见）。 */
function writeJsonAtomicSync(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(value), { flag: "wx" });
  renameSync(tmp, file);
}

/** 读 JSON；缺失/损坏返回 null。 */
function readJsonSync(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// —— 同步实现 + async 皮：控制面与 serve 都在启动/轮询路径上用，错误处理简单 ——
// （测试注入不需要 fs 缝：这些函数的契约就是真实文件行为。）

/**
 * 读 instance.json 的三态（145b 修正一：不存在 / 读不出 / 在，是三件事）：
 *   absent  —— 文件不存在（可以拉起）；
 *   error   —— 文件在但读不出（I/O 错误；调用方按"实例无响应"，不拉起）；
 *   present —— 读出了字节：raw 是解析后的 JSON（坏 JSON 为 null，仍保留部分事实给调用方
 *              先取 pid/创建时间判活性），record 是过闭集校验的完整记录（不合形状为 null）。
 *
 * @param {string} stateDir
 * @returns {Promise<{status:"absent"}|{status:"error"}|{status:"present", raw: object|null, record: object|null}>}
 */
export async function readInstanceRecordEx(stateDir) {
  const file = join(stateDir, INSTANCE_FILE);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return error?.code === "ENOENT" ? { status: "absent" } : { status: "error" };
  }
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  return { status: "present", raw, record: validInstance(raw) ? raw : null };
}

/** 便捷读取：完整记录或 null（三态折拢；需要区分三态的调用方用 readInstanceRecordEx）。 */
export async function readInstanceRecord(stateDir) {
  const read = await readInstanceRecordEx(stateDir);
  return read.status === "present" ? read.record : null;
}

/**
 * 原子发布 instance.json（先临时文件再改名）。
 *
 * @param {string} stateDir
 * @param {object} record — 满足闭集形状的记录（调用方组装；发布前不再校验，坏形状是编程错误）
 */
export async function publishInstanceRecord(stateDir, record) {
  writeJsonAtomicSync(join(stateDir, INSTANCE_FILE), record);
}

/**
 * 读 candidate-<generation>.json（子进程监听成功后写）；缺失/坏形状 null。
 *
 * @param {string} stateDir
 * @param {string} generation — 16 位小写十六进制
 */
export async function readCandidateRecord(stateDir, generation) {
  if (!HEX16_RE.test(generation)) return null;
  const value = readJsonSync(join(stateDir, `candidate-${generation}.json`));
  return validCandidate(value) ? value : null;
}

/**
 * 写 candidate-<generation>.json（serve 子进程监听成功后写；原子：先临时文件再改名）。
 *
 * @param {string} stateDir
 * @param {string} generation
 * @param {{port: number, pid: number, nonce: string, processCreatedAt: number}} value
 */
export async function writeCandidateRecord(stateDir, generation, value) {
  writeJsonAtomicSync(join(stateDir, `candidate-${generation}.json`), value);
}

/**
 * 读 result-<generation>.json（子进程起不来时写的闭集原因）；缺失/坏形状 null。
 *
 * @param {string} stateDir
 * @param {string} generation
 * @returns {Promise<{reason: string}|null>}
 */
export async function readResultRecord(stateDir, generation) {
  if (!HEX16_RE.test(generation)) return null;
  const value = readJsonSync(join(stateDir, `result-${generation}.json`));
  if (value === null || typeof value !== "object" || typeof value.reason !== "string"
    || !DASHBOARD_RESULT_REASONS.includes(value.reason) || Object.keys(value).length !== 1) {
    return null;
  }
  return value;
}

/**
 * 写 result-<generation>.json（闭集原因；先临时文件再改名）。
 *
 * @param {string} stateDir
 * @param {string} generation
 * @param {string} reason — 必须在 DASHBOARD_RESULT_REASONS 里
 */
export async function writeResultRecord(stateDir, generation, reason) {
  if (!DASHBOARD_RESULT_REASONS.includes(reason)) {
    throw new Error(`dashboardFiles: unknown result reason ${JSON.stringify(reason)}`);
  }
  writeJsonAtomicSync(join(stateDir, `result-${generation}.json`), { reason });
}

/**
 * 写 stop-<generation>.request（内容为记录里的 nonce；先临时文件再改名——实例只在
 * 整行 JSON 与 nonce 都对上时才停，半写的请求自然读不出）。
 *
 * @param {string} stateDir
 * @param {string} generation
 * @param {string} nonce
 */
export async function writeStopRequest(stateDir, generation, nonce) {
  writeJsonAtomicSync(join(stateDir, `stop-${generation}.request`), { nonce });
}

/**
 * 读 stop-<generation>.request 的 nonce；缺失/坏形状 null。
 *
 * @param {string} stateDir
 * @param {string} generation
 * @returns {Promise<string|null>}
 */
export async function readStopRequest(stateDir, generation) {
  if (!HEX16_RE.test(generation)) return null;
  const value = readJsonSync(join(stateDir, `stop-${generation}.request`));
  if (value === null || typeof value !== "object" || typeof value.nonce !== "string"
    || !NONCE_RE.test(value.nonce) || Object.keys(value).length !== 1) {
    return null;
  }
  return value.nonce;
}

/**
 * 原子创建 launch.lock（145b 修正一）：内容先写进唯一的临时文件，再 linkSync 硬链接
 * 到 launch.lock 发布——读者要么看不到锁，要么看到完整内容，永远没有半写窗口。
 * 别人已创建时（link 报 EEXIST）读回其完整内容（坏形状读作 null——调用方可按坏锁接管）。
 * 临时文件无论成败都用后即删。
 *
 * @param {string} stateDir
 * @param {string} generation — 本方的代际
 * @param {number} deadline — 截止时间（epoch ms）
 * @returns {Promise<{ok: true}|{ok: false, lock: {generation: string, deadline: number}|null}>}
 */
export async function createLaunchLock(stateDir, generation, deadline) {
  const file = join(stateDir, LOCK_FILE);
  const tmp = join(stateDir, `launch.lock.new-${process.pid}-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify({ generation, deadline }), { flag: "wx" });
  try {
    linkSync(tmp, file); // 目标已存在 → EEXIST；发布即完整
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 已不在 */ }
    if (error?.code !== "EEXIST") throw error;
    const value = readJsonSync(file);
    const lock = value !== null && typeof value === "object"
      && typeof value.generation === "string" && HEX16_RE.test(value.generation)
      && typeof value.deadline === "number" && Number.isFinite(value.deadline)
      && Object.keys(value).length === 2
      ? { generation: value.generation, deadline: value.deadline }
      : null;
    return { ok: false, lock };
  }
  try { unlinkSync(tmp); } catch { /* link 成功后 tmp 是同一 inode 的另一个名字 */ }
  return { ok: true };
}

/**
 * 读 launch.lock（缺失/坏形状 null）。
 *
 * @param {string} stateDir
 * @returns {Promise<{generation: string, deadline: number}|null>}
 */
export async function readLaunchLock(stateDir) {
  const value = readJsonSync(join(stateDir, LOCK_FILE));
  if (value === null || typeof value !== "object"
    || typeof value.generation !== "string" || !HEX16_RE.test(value.generation)
    || typeof value.deadline !== "number" || !Number.isFinite(value.deadline)
    || Object.keys(value).length !== 2) {
    return null;
  }
  return { generation: value.generation, deadline: value.deadline };
}

/**
 * 按"内容核对"的移除原语（145b 修正一）：launch 锁的过期接管与旧代删 instance.json 共用。
 *   1. 原子改名到一个唯一 staging 名（拿走的那一刻起别人看不到它）；
 *   2. 读回内容；
 *   3. matches(解析后的 JSON) 为真（坏锁的情形：读出来仍是坏形状）→ 删掉 staging，成功；
 *   4. 不真（拿到的是别人的新文件）→ linkSync 还原（目标已被新写者占住就放弃还原、
 *      丢弃这份旧内容），失败。
 * staging 名用后即删，不再留 launch.lock.stale-* 一类的残迹。
 *
 * @param {string} file — 目标文件绝对路径
 * @param {(value: object|null) => boolean} matches — 内容谓词
 * @returns {Promise<boolean>}
 */
export async function removeFileWhen(file, matches) {
  const staging = `${file}.rm-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(file, staging);
  } catch {
    return false; // 不在（或拿不走）
  }
  let value = null;
  try {
    value = JSON.parse(readFileSync(staging, "utf8"));
  } catch {
    value = null;
  }
  if (matches(value)) {
    try { unlinkSync(staging); } catch { /* 删不掉：唯一名残迹，无害 */ }
    return true;
  }
  // 别人的新文件：还原它（目标已被占住就放弃——那份内容作废）。
  try {
    linkSync(staging, file);
  } catch {
    // 已有新写者：不还原
  }
  try { unlinkSync(staging); } catch { /* 还原成功时它是硬链接的另一个名字 */ }
  return false;
}

/**
 * 过期接管（内容核对版）：锁里仍是预期那一代（或读出来仍是坏形状）才算接管成功。
 *
 * @param {string} stateDir
 * @param {string} expectedGeneration — 观察到的旧锁代际
 * @returns {Promise<boolean>}
 */
export async function takeOverStaleLock(stateDir, expectedGeneration) {
  return removeFileWhen(lockFileName(stateDir), (value) => {
    if (value === null || typeof value !== "object") return true; // 坏形状的锁：可以接管
    return typeof value.generation === "string" && HEX16_RE.test(value.generation)
      && typeof value.deadline === "number" && Number.isFinite(value.deadline)
      && value.generation === expectedGeneration;
  });
}

/**
 * 旧代收尾删自己的记录（内容核对版）：记录仍是自己这一代才删；发布竞争中被换成
 * 新代际的记录原样保留。
 *
 * @param {string} stateDir
 * @param {string} generation — 自己的代际
 * @returns {Promise<boolean>}
 */
export async function removeInstanceRecordIfGeneration(stateDir, generation) {
  return removeFileWhen(instanceFileName(stateDir), (value) =>
    value !== null && typeof value === "object" && value.generation === generation);
}

/** 日志已截断的固定一行（到顶后唯一再写的内容）。 */
export const LOG_TRUNCATED_LINE = "[truncated] 日志已截断";

/**
 * 实例日志：构造即截断（每代重写）；行带 ISO 时间前缀；字节到顶后写一行固定
 * “日志已截断”（放得下才写）并永久停止追加。绝不写 URL、请求头、启动码、令牌。
 *
 * @param {string} file — instance.log 的绝对路径
 * @param {object} [opts] — { maxBytes, now }（测试注入）
 * @returns {{line: (text: string) => void, bytes: () => number}}
 */
export function createInstanceLogger(file, { maxBytes = DASHBOARD_INSTANCE_LOG_MAX_BYTES, now = Date.now } = {}) {
  writeFileSync(file, "", { flag: "w" });
  const marker = Buffer.from(`${LOG_TRUNCATED_LINE}\n`, "utf8");
  // 为截断标记预留空间：正文最多写到 maxBytes - marker.length，标记永远放得下，
  // 文件也永远不超过 maxBytes。
  const lineBudget = Math.max(0, maxBytes - marker.length);
  let bytes = 0;
  let truncated = false;
  const append = (chunk) => {
    writeFileSync(file, chunk, { flag: "a" });
    bytes += chunk.length;
  };
  return {
    line(text) {
      if (truncated) return;
      const stamp = new Date(now());
      const iso = Number.isFinite(stamp.valueOf()) ? stamp.toISOString() : "unknown";
      const chunk = Buffer.from(`[${iso}] ${String(text).replace(/[\r\n]+/g, " ")}\n`, "utf8");
      if (bytes + chunk.length <= lineBudget) {
        append(chunk);
        return;
      }
      truncated = true;
      append(marker);
    },
    bytes: () => bytes,
  };
}

// —— 供控制面/serve 用的便捷定位（测试也用） ——

export const instanceFileName = (stateDir) => join(stateDir, INSTANCE_FILE);
export const lockFileName = (stateDir) => join(stateDir, LOCK_FILE);
export const codesDirOf = (stateDir) => join(stateDir, CODES_DIR);
export const instanceLogFileOf = (stateDir) => join(stateDir, INSTANCE_LOG_FILE);

/** 删除 instance.json（幂等；用于实例确认自己仍是当前代际后的收尾）。 */
export async function removeInstanceRecord(stateDir) {
  try {
    unlinkSync(join(stateDir, INSTANCE_FILE));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** instance.json 此刻存在吗（stop 轮询用）。 */
export function instanceRecordExists(stateDir) {
  return existsSync(join(stateDir, INSTANCE_FILE));
}

/**
 * 启动器读到 result-<g>.json 并据此报错之后，把它删掉（读后即清；文件名含代际，
 * 只动自己这一代的）。
 */
export async function removeResultRecord(stateDir, generation) {
  try {
    unlinkSync(join(stateDir, `result-${generation}.json`));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/**
 * 实例进程退出时清理自己这一代的 candidate-<g>.json 与 stop-<g>.request
 * （文件名即代际，只动这两个精确名字）。
 */
export async function removeOwnGenerationFiles(stateDir, generation) {
  for (const name of [`candidate-${generation}.json`, `stop-${generation}.request`]) {
    try {
      unlinkSync(join(stateDir, name));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
