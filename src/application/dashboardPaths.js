// src/application/dashboardPaths.js
//
// 第 145b 批（决定 0131 第 2 条）：常驻看板的运行目录身份与状态目录定位。
//
// 所有命令（dashboard / dashboard serve / status / stop / restart）先用同一个
// normalizeRunDir 把运行目录折成身份串——绝对路径、realpath 解开 junction、
// 分隔符统一为 /、去尾分隔符、Windows 上统一小写——再拿它算状态目录哈希与
// instance.json 的 runDir 比较。同一目录的别名写法（大小写、尾斜杠、junction）
// 必须折到同一把锁上；不存在的目录固定报错，不猜也不创建。
//
// 状态目录：%LOCALAPPDATA%\wao\dashboard\<sha256(身份串) 前 16 位>\；测试与内部
// 调用可用 --state-root <绝对路径> 换根（dashboardAcl.js 负责目录的建立与核对）。
//
// 已知局限（一句话一条）：
//   - 145b 之前的前台实例没有 instance.json，新代码发现不了也停不了它，要手动关闭。
//   - 同一账户的其他登录会话、管理员与 SYSTEM 不防（威胁模型只防别的 Windows 账户）。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod；本模块纯路径算术，
// 只有 normalizeRunDir 的 realpath 触文件系统（存在性即校验）。

import { realpathSync, statSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";

/** 启动与认证协议的版本号；instance.json 的 protocol 与复用检查都以它为准。 */
export const DASHBOARD_PROTOCOL_VERSION = 1;

/** 一次性启动码的有效期（毫秒）。 */
export const DASHBOARD_CODE_TTL_MS = 60_000;
/** 会话令牌的绝对有效期：24 小时（实例重启即全部失效是另一层）。 */
export const DASHBOARD_SESSION_TTL_MS = 24 * 60 * 60_000;
/** 服务端内存里最多同时有效的会话数，超出按签发先后淘汰。 */
export const DASHBOARD_SESSION_MAX = 32;
/** 拉起一个实例的总期限（父进程等 candidate/result、子进程等发布）。 */
export const DASHBOARD_LAUNCH_DEADLINE_MS = 20_000;
/** 实例优雅停机的整体预算（server.close + closeAllConnections + 在途刷新）。 */
export const DASHBOARD_STOP_BUDGET_MS = 5_000;
/** `wao dashboard stop` 等实例自己退出的时间，超时如实报告、不强杀、不删记录。 */
export const DASHBOARD_STOP_WAIT_MS = 10_000;
/** instance.log 的字节上限；到顶写一行固定“日志已截断”后停止追加。 */
export const DASHBOARD_INSTANCE_LOG_MAX_BYTES = 256 * 1024;
/** 实例低频清理过期启动码的周期。 */
export const DASHBOARD_CODE_SWEEP_INTERVAL_MS = 60_000;
/** 一次清理至多删除的启动码文件数（有界）。 */
export const DASHBOARD_CODE_SWEEP_MAX = 64;
/** 等启动锁时的轮询周期。 */
export const DASHBOARD_LOCK_POLL_MS = 250;
/** 拉起后等 candidate/result 文件的轮询周期。 */
export const DASHBOARD_CHILD_POLL_MS = 200;
/** 实例进程轮询 instance.json 代际与停机请求的周期。 */
export const DASHBOARD_INSTANCE_POLL_MS = 1000;
/** 健康探测的超时。 */
export const DASHBOARD_HEALTH_TIMEOUT_MS = 4_000;
/**
 * 启动器发布 instance.json 前，离这一代截止时间至少还要剩多少：子进程一个轮询周期 + 1 秒。
 * 余量不够就不发布——子进程在截止时看不到发布就会退出，不能把一个正在退出的实例发布出去。
 */
export const DASHBOARD_PUBLISH_MARGIN_MS = DASHBOARD_INSTANCE_POLL_MS + 1_000;
/** 启动器拿到锁之后，一次清理状态目录残余文件的条数上限。 */
export const DASHBOARD_STATE_SWEEP_MAX = 64;
/**
 * 判"远期锁"时留的容差：锁的期限晚于 now + 一代拉起期限 + 这个容差才按已过期处理。
 * 时钟往回跳不到这么多，别人刚建的锁（期限 = 它的 now + 一代拉起期限）仍是活锁。
 */
export const DASHBOARD_LOCK_FUTURE_TOLERANCE_MS = 1_000;

/**
 * 运行目录 → 身份串。抛固定文案的错误当目录不存在或读不出（realpath 失败），
 * 绝不返回一个猜测。
 *
 * @param {string} raw — 任意写法的运行目录
 * @param {{platform?: string}} [opts]
 * @returns {string} 身份串（/ 分隔、无尾分隔符、win32 上小写）
 */
export function normalizeRunDir(raw, { platform = process.platform } = {}) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("运行目录不存在或不可读：wao dashboard 需要一个已存在的运行目录。");
  }
  const abs = resolve(raw);
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    throw new Error(`运行目录不存在或不可读：${abs}`);
  }
  // 145b 修正一：realpath 对普通文件也成功——再判一次是目录，不是就报同一句固定错误。
  let isDir;
  try {
    isDir = statSync(real).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new Error(`运行目录不存在或不可读：${abs}`);
  }
  let id = real.replace(/\\/g, "/");
  // 去尾分隔符（保留纯盘符根 “d:/” 形状）。
  if (!/^[A-Za-z]:\/$/.test(id)) id = id.replace(/\/+$/, "");
  if (platform === "win32") id = id.toLowerCase();
  return id;
}

/**
 * 身份串 → 实例状态目录（不创建）。目录名 = sha256(身份串) 前 16 位十六进制。
 *
 * @param {string} normalizedRunDir — normalizeRunDir 的输出
 * @param {string} stateRoot — 状态根目录（绝对路径）
 */
export function stateDirFor(normalizedRunDir, stateRoot) {
  const digest = createHash("sha256").update(String(normalizedRunDir)).digest("hex").slice(0, 16);
  return `${String(stateRoot).replace(/\/+$/, "")}/${digest}`;
}

/**
 * 生产状态根：%LOCALAPPDATA%\wao\dashboard。LOCALAPPDATA 缺失或非绝对路径时
 * 固定报错（fail-closed）——绝不落到 cwd 或临时目录上。
 *
 * @param {Record<string,string|undefined>} [env]
 */
export function defaultDashboardStateRoot(env = process.env) {
  const raw = env.LOCALAPPDATA;
  if (typeof raw !== "string" || raw.length === 0 || !isAbsolute(raw)) {
    throw new Error("无法定位看板状态目录：环境里没有可用的 LOCALAPPDATA；测试与内部调用可用 --state-root 显式指定。");
  }
  return join(raw, "wao", "dashboard");
}
