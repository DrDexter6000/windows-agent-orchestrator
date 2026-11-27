// src/application/dashboardFiles.js
//
// 第 145b 批（决定 0131 第 2 条）：状态目录里的实例记录、启动锁与实例日志。
//
//   - instance.json：{ protocol, runDir, pid, processCreatedAt, port, nonce, generation,
//     build }，先写临时文件再原子改名发布；读取按闭集形状校验，坏形状读作 null
//     （不猜）。candidate-<g>.json / result-<g>.json / stop-<g>.request 同一纪律。
//   - launch.lock：wx 独占创建（内容先写临时文件再 linkSync 发布，读者永远看不到半写的锁），
//     内容 { generation, deadline }；过期接管 = 按内容核对的原子移除（removeFileWhen：
//     先读一次，对不上就不碰文件；对得上才改名到唯一 staging、读回再核对、对不上还原），
//     双过期接管只有一个赢家；任何不符合闭集形状的内容都是坏锁、都可接管；启动器发布成功、
//     失败或放弃之后按自己的代际删掉自己的锁（removeLaunchLockIfGeneration）。
//   - 残余文件：启动器拿到锁之后清理认得出名字形状的残余（sweepStateDirLeftovers，有条数
//     上限、不递归、不碰 instance.log 与 codes\）。
//   - instance.log：每代重写（构造即截断），上限 DASHBOARD_INSTANCE_LOG_MAX_BYTES，
//     到顶写一行固定“日志已截断”后停止追加。绝不记录 URL、请求头、启动码、会话
//     令牌——调用方（dashboardServe）只喂固定的事件词与数字。
//
// 已知局限（一句话一条）：145b 之前的前台实例没有这些文件，新代码发现不了它。
//
// 架构契约：node:fs 只在此层出现；不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, unlinkSync, linkSync, existsSync, readdirSync, lstatSync } from "node:fs";

import {
  DASHBOARD_INSTANCE_LOG_MAX_BYTES,
  DASHBOARD_LAUNCH_DEADLINE_MS,
  DASHBOARD_STATE_SWEEP_MAX,
} from "./dashboardPaths.js";

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
    return { ok: false, lock: lockShapeOf(readJsonSync(file)) };
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
  return lockShapeOf(readJsonSync(join(stateDir, LOCK_FILE)));
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
  // 1. 先读一次：内容对不上就根本不碰文件——活的记录/锁不能为了"看一眼"被挪走，
  //    否则读者会在挪走与还原之间读到"不存在"（实例据此自杀、第三个启动器趁机建锁）。
  let peeked;
  try {
    peeked = readFileSync(file, "utf8");
  } catch {
    return false; // 不在，或读不出：不动
  }
  if (!matches(parseJsonOrNull(peeked))) return false;
  // 2. 对得上才改名拿走；
  const staging = `${file}.rm-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(file, staging);
  } catch {
    return false; // 不在（或拿不走）
  }
  // 3. 读回再核对一次：读与改名之间被换成别人的新文件才会对不上。
  let back;
  try {
    back = readFileSync(staging, "utf8");
  } catch {
    back = null; // 读不回来：当成对不上，还原
  }
  if (back !== null && matches(parseJsonOrNull(back))) {
    try { unlinkSync(staging); } catch { /* 删不掉：唯一名残迹，无害 */ }
    return true;
  }
  // 4. 别人的新文件：还原它（目标已被占住就放弃——那份内容作废）。
  try {
    linkSync(staging, file);
  } catch {
    // 已有新写者：不还原
  }
  try { unlinkSync(staging); } catch { /* 还原成功时它是硬链接的另一个名字 */ }
  return false;
}

const parseJsonOrNull = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * 闭集锁形状（readLaunchLock / createLaunchLock / 接管谓词共用的唯一判定）：恰好
 * { generation: 16 位十六进制, deadline: 有限数 }；其余一律返回 null。
 */
function lockShapeOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 2) return null;
  if (typeof value.generation !== "string" || !HEX16_RE.test(value.generation)) return null;
  if (typeof value.deadline !== "number" || !Number.isFinite(value.deadline)) return null;
  return { generation: value.generation, deadline: value.deadline };
}

/**
 * 过期接管（内容核对版）：锁不符合闭集形状（坏锁，任何内容——`{}`、`[1]`、多一个键、
 * 代际不是 16 位十六进制……）、或锁里仍是预期那一代，才算接管成功。形状合法而代际不同
 * 的锁一个字节都不动（expectedGeneration 传 null 表示"只接管坏锁"）。
 *
 * @param {string} stateDir
 * @param {string|null} expectedGeneration — 观察到的旧锁代际；null = 只接管坏锁
 * @returns {Promise<boolean>}
 */
export async function takeOverStaleLock(stateDir, expectedGeneration) {
  return removeFileWhen(lockFileName(stateDir), (value) => {
    const lock = lockShapeOf(value);
    return lock === null || lock.generation === expectedGeneration;
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

/**
 * 实例目录本身是否存在。status / stop 用它区分“从未建立过状态目录”（如实说没有实例）
 * 与“目录在、要核对”（ACL 核对不过就拒绝）；只做存在性判断，不读目录内容。
 */
export function stateDirPresent(stateDir) {
  return existsSync(stateDir);
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

/** 启动器发布成功后，把自己消费掉的 candidate-<g>.json 删掉（只动这一代的精确名字）。 */
export async function removeCandidateRecord(stateDir, generation) {
  if (!HEX16_RE.test(generation)) return;
  try {
    unlinkSync(join(stateDir, `candidate-${generation}.json`));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/**
 * 启动器用完（成功、失败或放弃）后按自己的代际删掉自己的锁：内容核对的移除——
 * 锁已被换成别的代际就一个字节都不动。
 */
export async function removeLaunchLockIfGeneration(stateDir, generation) {
  return removeFileWhen(lockFileName(stateDir), (value) =>
    value !== null && typeof value === "object" && value.generation === generation);
}

const TRANSIENT_SUFFIX = String.raw`\d+-[0-9a-f]{12}`;
/** 状态目录里认得出名字形状的残余文件。第 1 组是代际（没有代际的形状为空）；transient 为瞬态名。 */
const LEFTOVER_SHAPES = Object.freeze([
  { re: /^result-([0-9a-f]{16})\.json$/, transient: false },
  { re: /^candidate-([0-9a-f]{16})\.json$/, transient: false },
  { re: /^stop-([0-9a-f]{16})\.request$/, transient: false },
  { re: new RegExp(`^(?:instance\\.json|(?:result|candidate)-([0-9a-f]{16})\\.json|stop-([0-9a-f]{16})\\.request)\\.tmp-${TRANSIENT_SUFFIX}$`), transient: true },
  { re: new RegExp(`^(?:instance\\.json|launch\\.lock)\\.rm-${TRANSIENT_SUFFIX}$`), transient: true },
  { re: new RegExp(`^launch\\.lock\\.new-${TRANSIENT_SUFFIX}$`), transient: true },
]);

/**
 * 启动器拿到锁之后清理状态目录里的残余文件（启动器已离开时失败路径留下的
 * result-<g>.json，以及原子写失败留下的 *.tmp-*、*.rm-*、launch.lock.new-*）：
 *   - 只删认得出名字形状的普通文件；不递归、不碰目录，也不碰 instance.json、
 *     launch.lock、instance.log 与 codes\；
 *   - 带代际的名字，代际在 keepGenerations（当前实例、自己这一代）里的不删；
 *   - 瞬态名字（*.tmp-*、*.rm-*、launch.lock.new-*）要比 minAgeMs 老才删——很新的那个
 *     可能是别的启动器正在原子建锁/写文件、或别的进程正处在"改名→读回"之间的中间态；年龄按
 *     max(mtime, ctime) 算（改名不改 mtime、会刷新 ctime）；
 *   - 一次至多删 max 个。
 *
 * @param {string} stateDir
 * @param {object} [opts] — { keepGenerations, max, minAgeMs, now }
 * @returns {Promise<number>} 删除的个数
 */
export async function sweepStateDirLeftovers(stateDir, {
  keepGenerations = [], max = DASHBOARD_STATE_SWEEP_MAX, minAgeMs = DASHBOARD_LAUNCH_DEADLINE_MS, now = Date.now,
} = {}) {
  let names;
  try {
    names = readdirSync(stateDir);
  } catch {
    return 0;
  }
  const keep = new Set(keepGenerations.filter((g) => typeof g === "string"));
  let removed = 0;
  for (const name of names) {
    if (removed >= max) break;
    const shape = LEFTOVER_SHAPES.find((candidate) => candidate.re.test(name));
    if (shape === undefined) continue;
    const generation = shape.re.exec(name).slice(1).find((g) => typeof g === "string");
    if (generation !== undefined && keep.has(generation)) continue;
    const file = join(stateDir, name);
    try {
      const info = lstatSync(file);
      if (!info.isFile()) continue; // 目录、联接、符号链接：一律不碰
      // 年龄按 max(mtime, ctime) 算：NTFS 上改名不改 mtime（别的进程的 removeFileWhen 刚把文件改名
      // 成 *.rm-* 的 staging，mtime 仍是它原来的老时间），但改名会刷新 ctime。
      if (shape.transient && now() - Math.max(info.mtimeMs, info.ctimeMs) < minAgeMs) continue;
      unlinkSync(file);
      removed += 1;
    } catch {
      // 读不到或删不掉（并发被别人拿走）：下一轮再说
    }
  }
  return removed;
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
