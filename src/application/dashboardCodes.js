// src/application/dashboardCodes.js
//
// 第 145b 批（决定 0131 第 2 条）：一次性启动码。
//
// 签发：32 字节随机码（64 位小写十六进制），把 sha256(码) 作文件名写进 codes\，
// 文件内容为空——签发时间就是文件的 mtime。兑换：GET /api/session 把码放在
// Authorization 头里（那一段在 ownerDashboardServer.js），这里只管文件事实：
//   - 形状不对的码在碰文件系统之前就拒绝（redeemStartCode 的第一道门）；
//   - 一次兑换只查一个文件 codes\<sha256(码)>：存在、未过期（mtime 距今不超过
//     DASHBOARD_CODE_TTL_MS）并且删除成功，才算兑换成功——并发兑换只有一个赢家
//     （unlink 的原子性就是那把锁）；
//   - 过期的码文件不在兑换请求里遍历删除，留给实例的低频清理（启动时与每分钟
//     一次，有条数上限）。
//
// 已知局限（一句话一条）：一次性启动码会短暂出现在浏览器打开器的命令行与浏览器的
// 这一条历史里（60 秒、只能用一次；威胁模型已接受）。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod。

import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { stat, unlink, readdir, open } from "node:fs/promises";

import { DASHBOARD_CODE_SWEEP_MAX, DASHBOARD_CODE_TTL_MS } from "./dashboardPaths.js";

/** 启动码（与会话令牌同形）：64 位小写十六进制。 */
export const CODE_HEX_RE = /^[0-9a-f]{64}$/;

const DEFAULT_IO = Object.freeze({ stat, unlink, readdir, open });

/** 换代时一次清空 codes 的条数上限：清不完就失败（异常灌文件的信号）。 */
export const DASHBOARD_CODE_PURGE_MAX = 4096;

const digestOf = (code) => createHash("sha256").update(code).digest("hex");

/**
 * 签发一个启动码：写 codes\<sha256(码)> 空文件（wx 独占；摘要碰撞即重抽），
 * mtime 即签发时刻（按注入的时钟 utimes 定格）。
 *
 * @param {string} codesDir — 状态目录下的 codes 子目录
 * @param {object} [opts] — { now, randomBytesFn, io }（测试注入；io 是同步缝）
 * @returns {{code: string, file: string}}
 */
export function issueStartCode(codesDir, { now = Date.now, randomBytesFn = randomBytes, io = {} } = {}) {
  const i = { mkdirSync, writeFileSync, utimesSync, ...io };
  i.mkdirSync(codesDir, { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    const code = randomBytesFn(32).toString("hex");
    if (!CODE_HEX_RE.test(code)) {
      if (attempt >= 16) throw new Error("dashboardCodes: invalid random source");
      continue;
    }
    const file = join(codesDir, digestOf(code));
    try {
      i.writeFileSync(file, "", { flag: "wx" }); // 内容为空：码本身绝不落盘
    } catch (error) {
      if (error?.code === "EEXIST" && attempt < 16) continue; // 摘要碰撞：重抽
      throw error;
    }
    // 145b 修正一：mtime 用毫秒精度（Date 保留毫秒）。取整到秒会让实际窗口比 60s
    // 提前最多 999ms 过期。
    const at = new Date(now());
    i.utimesSync(file, at, at); // mtime = 签发时刻（注入时钟可定格，毫秒精度）
    return { code, file };
  }
}

/**
 * 兑换一个启动码。真值 = 声明抢到（wx 独占创建）且码文件存在、未过期、随后被删掉。
 * 形状不对的码零文件系统调用。并发兑换只有一个赢家。
 *
 * 实测注记：本机文件系统上并发的 unlink / rename 都可能让多个调用者同时“成功”
 * （8 路并发 3–4 路赢）；wx 独占创建（CreateFileW(CREATE_NEW)）是唯一稳定单赢家的
 * 原语，所以兑换先抢 <sha256(码)>.claim，赢家才去看码文件本身。崩溃留下的 claim
 * 残留由低频清理按 TTL 收走（至多让这个码多等一轮，不影响别的码）。
 *
 * @param {string} codesDir
 * @param {string} code
 * @param {object} [opts] — { now, ttlMs, io }
 * @returns {Promise<boolean>}
 */
export async function redeemStartCode(codesDir, code, { now = Date.now, ttlMs = DASHBOARD_CODE_TTL_MS, io = {} } = {}) {
  if (typeof code !== "string" || !CODE_HEX_RE.test(code)) return false;
  const i = { ...DEFAULT_IO, ...io };
  const digest = digestOf(code);
  const file = join(codesDir, digest);
  const claim = join(codesDir, `${digest}.claim`);
  // 145b 修正一的顺序：
  //   1) 先看码文件在不在——不存在直接 false，零写入（未知码不能往受保护目录里灌 claim）；
  //   2) 在，才 wx 抢 claim 定唯一赢家；
  //   3) 赢家复核码文件仍在、未过期，然后删码文件；
  //   4) 删不掉就 false 并【保留 claim】：这个码就此作废（第二次兑换也抢不到赢家），
  //      等低频清理收走；成功路径删 claim 后才返回 true。
  try {
    await i.stat(file);
  } catch {
    return false; // 码文件不存在：不写任何文件
  }
  let handle;
  try {
    handle = await i.open(claim, "wx"); // 抢兑：只有一个调用者能创建
  } catch {
    return false; // 别人正持有（或作废残留未清）：出局
  }
  try {
    await handle.close();
  } catch {
    // 关不掉不影响判定（声明已在）
  }
  let mtimeMs;
  try {
    mtimeMs = (await i.stat(file)).mtimeMs;
  } catch {
    await i.unlink(claim).catch(() => {});
    return false; // 码文件在抢兑间隙消失了：撤声明
  }
  if (now() - mtimeMs >= ttlMs) {
    await i.unlink(claim).catch(() => {}); // 过期：撤声明，码文件留给低频清理
    return false;
  }
  try {
    await i.unlink(file); // 消费
  } catch {
    return false; // 删不掉：保留 claim，这个码作废，低频清理收走
  }
  await i.unlink(claim).catch(() => {}); // 成功后才收走声明
  return true;
}

/**
 * 低频清理：删除过期的码文件（mtime 距今超过 ttl），一次至多 maxCount 个。
 * 返回删除的个数；目录不存在按 0 处理。
 *
 * @param {string} codesDir
 * @param {object} [opts] — { now, ttlMs, maxCount, io }
 * @returns {Promise<number>}
 */
export async function sweepExpiredStartCodes(codesDir, { now = Date.now, ttlMs = DASHBOARD_CODE_TTL_MS, maxCount = DASHBOARD_CODE_SWEEP_MAX, io = {} } = {}) {
  const i = { ...DEFAULT_IO, ...io };
  let names;
  try {
    names = await i.readdir(codesDir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (removed >= maxCount) break;
    // 码文件与崩溃残留的声明文件（.claim）都按过期清理；别的名字不碰。
    if (!/^[0-9a-f]{64}(?:\.claim)?$/.test(name)) continue;
    const file = join(codesDir, name);
    let mtimeMs;
    try {
      mtimeMs = (await i.stat(file)).mtimeMs;
    } catch {
      continue;
    }
    if (now() - mtimeMs < ttlMs) continue;
    try {
      await i.unlink(file);
      removed += 1;
    } catch {
      // 删不掉（并发兑换刚拿走）：下一轮再说
    }
  }
  return removed;
}

/**
 * 换代清空（145b 修正一）：新一代实例启动时、写候选之前，把 codes 里的全部旧码与
 * claim 清掉——上一代没用掉的码，换代后一律不能兑换。一次至多 maxCount 个；超过上限
 * 如实失败（{ok:false, remaining}，调用方按 serve_error 收口），不清的部分原样保留。
 *
 * @param {string} codesDir
 * @param {object} [opts] — { maxCount }
 * @returns {Promise<{ok: boolean, purged: number, remaining: number}>}
 */
export async function purgeAllStartCodes(codesDir, { maxCount = DASHBOARD_CODE_PURGE_MAX, io = {} } = {}) {
  const i = { ...DEFAULT_IO, ...io };
  let names;
  try {
    names = await i.readdir(codesDir);
  } catch {
    return { ok: true, purged: 0, remaining: 0 }; // 目录不存在：等价于空
  }
  let purged = 0;
  for (const name of names) {
    if (purged >= maxCount) break;
    try {
      await i.unlink(join(codesDir, name));
      purged += 1;
    } catch {
      // 删不掉的留下，计入 remaining（下一轮再说；换代失败由调用方收口）
    }
  }
  let remaining = 0;
  try {
    remaining = (await i.readdir(codesDir)).length;
  } catch {
    remaining = 0;
  }
  return { ok: remaining === 0, purged, remaining };
}
