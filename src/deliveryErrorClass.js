// src/deliveryErrorClass.js
//
// 交付打包失败的安全错误类别分类器。
//
// 输入是打包器（src/delivery.js 的 git() = execFileSync，stderr ignore）逃逸的
// 原始异常；输出是一个闭集环境类别，或 null（分不出）。类别只来自错误对象的
// 结构化属性（status/code/syscall/signal/cause），绝不解析、保存或回显消息
// 原文——原文可能含路径、stderr 或秘密，消息面仍由 runManager 的脱敏函数负责。
//
// 与 DeliveryError.deliveryCode 的分工：deliveryCode 描述打包合同违约（空 diff、
// 越界路径……，闭集见 src/deliveryFailureCodes.js）；errorClass 描述"打包环境出了
// 什么物理问题"（索引被占、文件锁死、磁盘满、git 起不来……）。两者正交，本模块
// 不触碰 deliveryCode。
//
// 纯函数：无状态、无副作用、全量 try 兜底——分类器自身异常一律返回 null，
// 绝不给错误路径再抛错。零相对出边（node:fs/node:path only）。

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 冻结闭集：打包失败的全部环境类别。每个成员的触发条件见
 * classifyDeliveryError 的判定顺序（顺序即优先级，先命中先出）。
 */
export const DELIVERY_ERROR_CLASSES = Object.freeze([
  // git 已跑但退出非零，且工作树 git 索引锁文件在场（探测：读关联工作树
  // .git 文件指向的 git dir，查其下 index.lock；探测失败不判此类）。
  "git_index_locked",
  // fs 错误 EBUSY/EPERM，且非 spawn 引起（Windows 上文件被占用/不可改的
  // 常见形状）。
  "file_locked",
  // fs 错误 EACCES，且非 spawn 引起。
  "permission_denied",
  // fs 错误 ENOSPC。
  "disk_full",
  // syscall 以 spawn 开头——git 起不来（如不在 PATH 上，ENOENT）。
  "git_spawn_failed",
  // ETIMEDOUT，或进程带 signal 被杀。
  "git_timeout",
  // git 以非零退出码结束（status 为非零整数）。结果另带数字字段
  // gitExitStatus。
  "git_command_failed",
]);

/** cause 链下钻上限——防御环状 cause（真实错误不会超过 1 层）。 */
const MAX_CAUSE_DEPTH = 8;

/**
 * 探测关联工作树的 git 索引锁文件是否在场。
 *
 * 关联工作树的 `.git` 是一个文件，内容 `gitdir: <主仓>/.git/worktrees/<name>`；
 * 主检出形状（`.git` 是目录）按目录内 index.lock 兜底。解析不出 git dir、
 * 读不到、路径形状不认识——一律视为探测失败（返回 false，不判
 * git_index_locked）。只做存在性探测，不读内容、不回显路径。
 * @param {string} worktreePath — 工作树绝对路径
 * @returns {boolean} 锁文件确证在场；否则 false（含探测失败）
 */
function worktreeIndexLockExists(worktreePath) {
  try {
    const dotGit = join(worktreePath, ".git");
    const st = statSync(dotGit);
    if (st.isDirectory()) return existsSync(join(dotGit, "index.lock"));
    if (!st.isFile()) return false;
    const content = readFileSync(dotGit, "utf8");
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
    if (!m || m[1].length === 0) return false;
    return existsSync(join(m[1], "index.lock"));
  } catch {
    return false;
  }
}

/**
 * 从错误对象的结构化属性得出闭集环境类别。
 *
 * 判定顺序（先命中先出；cause 链先下钻到最深处）：
 *   1. ETIMEDOUT 或带 signal → git_timeout；
 *   2. spawn 失败（syscall 以 spawn 开头）→ git_spawn_failed；
 *   3. ENOSPC → disk_full；
 *   4. EACCES → permission_denied；
 *   5. EBUSY/EPERM → file_locked；
 *   6. 非零整数 status 且工作树 index.lock 在场 → git_index_locked；
 *   7. 非零整数 status → git_command_failed（附 gitExitStatus）。
 * 超时排在 spawn 之前：execFileSync 超时时 ETIMEDOUT、spawnSync syscall 与
 * kill signal 同时在场；启动失败只有 syscall，没有 signal；非零退出两者都没有。
 * spawn 判定排在 fs 错误码之前，保证 4/5 的"非 spawn 引起"由顺序保证。
 * 哪条都够不上 → null。
 *
 * @param {unknown} err — 打包器抛出的原始异常
 * @param {{worktreePath?: string|null}} [opts] — 工作树路径（git_index_locked
 *   探测用；缺省/非法时不判该类）
 * @returns {{errorClass: string, gitExitStatus?: number}|null} errorClass 恒为
 *   DELIVERY_ERROR_CLASSES 成员；分不出时 null（不抛错）
 */
export function classifyDeliveryError(err, opts = {}) {
  try {
    let e = err;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
      if (e && typeof e === "object" && e.cause && typeof e.cause === "object") {
        e = e.cause;
      } else {
        break;
      }
    }
    if (!e || typeof e !== "object") return null;

    if (e.code === "ETIMEDOUT" || (typeof e.signal === "string" && e.signal.length > 0)) {
      return { errorClass: "git_timeout" };
    }
    if (typeof e.syscall === "string" && e.syscall.startsWith("spawn")) {
      return { errorClass: "git_spawn_failed" };
    }
    if (e.code === "ENOSPC") return { errorClass: "disk_full" };
    if (e.code === "EACCES") return { errorClass: "permission_denied" };
    if (e.code === "EBUSY" || e.code === "EPERM") return { errorClass: "file_locked" };

    const status = e.status;
    if (Number.isInteger(status) && status !== 0) {
      const worktreePath = opts.worktreePath;
      if (typeof worktreePath === "string" && worktreePath.length > 0
        && worktreeIndexLockExists(worktreePath)) {
        return { errorClass: "git_index_locked" };
      }
      return { errorClass: "git_command_failed", gitExitStatus: status };
    }
    return null;
  } catch {
    return null;
  }
}
