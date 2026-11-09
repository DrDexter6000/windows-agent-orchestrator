// src/application/ownerLeaseWrite.js
//
// Owner 心跳租约的写与释放（B91，TD-337/TD-345）：原是 backgroundRunner.js 的
// 两个私有函数，收口到 application 层——run_delivery_repackage 的验证期间要
// 持同一份租约，runner 与它共用一套写/释放，不再各留一份。
//
// 读法（isFreshHeartbeat / readOwnerLease / checkOwnerLiveness / 进程身份判定）
// 的 SSOT 仍在 ownerLiveness.js；本模块只管写与释放。
//
// 为什么不在 ownerLiveness.js 里：写走原子替换（同目录临时文件再改名，
// src/atomicWriteSync.js 的 atomicWriteFileSync）——写一半被杀不留损坏租约
//（损坏的租约会让缺席证明永远拒绝）。ownerLiveness.js 在 shared 层，shared
// 不得上向 import core 的 atomicWriteSync.js（分层矩阵，上向白名单为空）；
// 写侧因此落在上一层的 application（下向 import 合法，runnerStderr.js 同款，
// TD-341）。租约文件（.owner-<runId>）是短命进程注册表（同 daemon.json 性质），
// 不存 run 状态——transcript 是真相源。
//
// Architectural contract:
//   - 依赖：node:fs、../atomicWriteSync.js（core 下向）、./ownerLiveness.js
//     （shared 下向）。不 import src/commands/*、src/mcp/*、MCP SDK、zod。
//   - 写失败与释放失败都吞掉：租约是尽力而为的观察面，绝不反噬持有进程。

import { unlinkSync } from "node:fs";

import { atomicWriteFileSync } from "../atomicWriteSync.js";
import { ownerFilePath, readOwnerLease } from "./ownerLiveness.js";

/** 心跳节拍：runner 与重打包验证期间都是每 2000 ms 续写一次。 */
export const OWNER_HEARTBEAT_INTERVAL_MS = 2000;

/**
 * 写一次心跳：{ pid: process.pid, heartbeatAt } 原子替换进 .owner-<runId>。
 * 写失败（runDir 被删等）不杀持有进程。
 * @param {string} runDir
 * @param {string} runId
 */
export function writeOwnerHeartbeat(runDir, runId) {
  try {
    atomicWriteFileSync(ownerFilePath(runDir, runId), JSON.stringify({ pid: process.pid, heartbeatAt: Date.now() }));
  } catch {
    // 写失败（runDir 被删等）不杀 runner
  }
}

/**
 * 释放租约——只在文件可读、格式正确（readOwnerLease 是格式 SSOT）且
 * pid === process.pid 时删除；别的进程的租约、读不出的文件都不动。
 * @param {string} runDir
 * @param {string} runId
 */
export function clearOwner(runDir, runId) {
  const lease = readOwnerLease(runDir, runId, Date.now());
  if (!(lease.present && lease.wellFormed && lease.pid === process.pid)) return;
  try { unlinkSync(ownerFilePath(runDir, runId)); } catch { /* 已不在 */ }
}

/**
 * 验证期间的租约持有者（B91）：start 写一次租约并每 intervalMs 续写（定时器
 * unref——它自己绝不吊住进程）；stop 停拍并释放租约。未 start 就 stop 是
 * no-op（没写过租约，也无从释放）。run_delivery_repackage 缺省用它写进调用方
 * 传入的 runDir；测试可换成桩，或用本真实现指向临时目录。
 * @param {object} opts
 * @param {string} opts.runDir
 * @param {string} opts.runId
 * @param {number} [opts.intervalMs] — 缺省 OWNER_HEARTBEAT_INTERVAL_MS
 * @returns {{start(): void, stop(): void}}
 */
export function createOwnerLeaseHolder({ runDir, runId, intervalMs = OWNER_HEARTBEAT_INTERVAL_MS } = {}) {
  let timer = null;
  return {
    start() {
      if (timer) return;
      writeOwnerHeartbeat(runDir, runId);
      timer = setInterval(() => writeOwnerHeartbeat(runDir, runId), intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      clearOwner(runDir, runId);
    },
  };
}
