// src/verificationGate.js
//
// R23-F/B Round B (TD-130 止血)：同机全量验证串行化闸。
//
// 主症状：同一台机器上并发发起的"全量交付验证"互相踩踏——多个 verifyDelivery
// 命令序列同时在跑，彼此拖慢到 command_timeout，取证信号被稀释。本轮用一把
// 机器级租约锁把"任何经三条生产路径发起的交付验证"与"直连 canonical 全量"
// 串行化（粒度 = 整个 verifyDelivery 命令序列 / 一次 canonical main()）。
//
// 设计红线（不可让步）：
//   · 存活判定只用 heartbeatAt 年龄（陈旧 ~90s 回收），绝不做 PID 探活——
//     PID 在 Windows 上可被复用，探活结论不可信；
//   · "活着但挂死"是本轮主症状：startedAt 超过硬上限 45min 时，即使心跳仍
//     新鲜也判定弃置、允许接管；
//   · 释放只认 token 匹配（gitLocalExclude 先例）：绝不删除新主人的锁；
//   · 回收一律走"内容未变才删"的 CAS（reclaimIfSame）——并发认领竞态中胜出
//     的新主人租约绝不会被落败者误删；
//   · 损坏租约有宽限窗（首见后 ~15s），过后按损坏回收；
//   · 等待绝不抛错、绝不超时放弃（闸的等待不消耗任何验证预算）；等待者每
//     ~30s 向 sink 打一条含持有者身份的日志（排队可见性）；
//   · 基础设施故障（路径不可写等）一律 fail-open：WARNING 进 sink、acquire
//     返回 null、调用方无闸继续——闸的争用/等待/降级永不产生新失败码、永不
//     改变验证结果语义；
//   · kill switch WAO_VERIFICATION_GATE=off 仅由调用方经 gateDisabled() 判定
//     （本模块不读它——闸对象本身没有开关语义）。
//
// 同机语义：租约落在 waoMachineStateDir()（%LOCALAPPDATA%\wao，见
// machineGatePaths.js），只对本机进程有意义；跨机器各持各的闸。
//
// 已知残余边界（有意接受）：心跳续期与持有者复核之间存在跨进程窗口（另一进
// 程可能恰在该窗口内接管后被本进程覆写回）。窗口为微秒级同步段，且最迟在
// STALE_MS 内被下一次复核自愈；gitLocalExclude 的锁完全没有续期机制，本设计
// 严格强于既有先例。fail-open 方向保证该边界不可能放大为验证错误。

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { waoMachineStateDir, verificationLeasePath } from "./machineGatePaths.js";

/**
 * 注入到验证子进程 env 的标记：子进程看到它就知道本进程已持闸，跳过再次认领
 * （防自锁）。由 deliveryVerification._prepareAttemptEnv 写入。
 */
export const VERIFICATION_GATE_HELD_ENV = "WAO_VERIFICATION_GATE_HELD";

/** kill switch 变量名。值（trim 后小写）恰为 "off" 时调用方完全绕过闸。 */
export const VERIFICATION_GATE_OFF_ENV = "WAO_VERIFICATION_GATE";

/** 心跳续期间隔（规格定稿 ~30s）。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** 心跳年龄超过此值视为持有者死亡，允许陈旧回收（规格定稿 ~90s）。 */
export const STALE_MS = 90_000;

/** 损坏租约宽限窗：自等待者首次目击损坏起算，超过才允许回收。 */
export const CORRUPT_GRACE_MS = 15_000;

/** 单次持闸硬上限：startedAt 超过它即判弃置（即使心跳仍新鲜）。 */
// [审计 F4] 上限必须 ≥ 合法预算天花板 VERIFICATION_TIMEOUT_MS_MAX（120min/单命令，
// 整序列最坏 = (N+M)×timeoutMs 可更大）——45min 会健康抢锁合法长验证。取 130min
// （= 120min 天花板 + 10min 余量）；挂死持有者最多多占 40min 后被接管。
export const MAX_HOLD_MS = 130 * 60_000;

/** 等待者向 sink 重发等待日志的节律（含持有者身份）。 */
export const WAIT_LOG_INTERVAL_MS = 30_000;

/** 等待轮询间隔（内部实现细节，非契约）。 */
const POLL_INTERVAL_MS = 1_000;

/** 连续硬读失败达到该次数即认定基础设施故障，fail-open。 */
const MAX_CONSECUTIVE_READ_FAILURES = 5;

const LOG_FILENAME = "gate.log";

/** 闸日志路径：机器状态目录下的 gate.log（默认 sink 的追加目标）。 */
export function gateLogPath() {
  return join(waoMachineStateDir(), LOG_FILENAME);
}

/**
 * kill switch 判定：env[WAO_VERIFICATION_GATE] trim+小写后恰为 "off" 才算关。
 * 其余一切值（含未设置）都保持开闸。由调用方（三条生产路径 / canonical main）
 * 在创建闸之前调用。
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function gateDisabled(env = process.env) {
  return String(env[VERIFICATION_GATE_OFF_ENV] ?? "").trim().toLowerCase() === "off";
}

/**
 * 调用方入闸判定的单一谓词："本进程现在该不该去认领机器租约？"
 *
 *   engaged = kill switch 未关 且 本进程未持闸（HELD 为空）。
 *
 * 三条生产路径与 canonical main 在创建闸之前统一问它，避免各调用点长出第二份
 * 判定逻辑；防自锁的第二道防线（第一道是注入方根本不创建闸）。
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {boolean}
 */
export function gateEngaged(env = process.env) {
  return !gateDisabled(env)
    && String(env[VERIFICATION_GATE_HELD_ENV] ?? "").trim().length === 0;
}

function describeErr(err) {
  if (err && typeof err === "object" && err.code) return `${err.code}: ${err.message}`;
  return String((err && err.message) || err);
}

/**
 * 租约记录解析：schemaVersion 必须是 1、token 必须非空字符串、startedAt/
 * heartbeatAt 必须有限数字；其余字段（owner/runId/sessionId/agentId/pid）可选。
 * 不满足即视为"损坏现场"（走宽限窗），绝不猜测性修复。
 */
function parseLeaseRecord(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.schemaVersion !== 1) return null;
  if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
  if (!Number.isFinite(parsed.startedAt) || !Number.isFinite(parsed.heartbeatAt)) return null;
  return parsed;
}

function renderHolderJson(record) {
  if (!record) return "(unreadable)";
  const who = {};
  for (const key of ["owner", "runId", "sessionId", "agentId"]) {
    if (typeof record[key] === "string" && record[key].length > 0) who[key] = record[key];
  }
  return JSON.stringify(who);
}

/**
 * 真实租约文件操作集（可经 opts.fsOps 整体替换以便测试注入竞态夹层）。
 * 所有方法以闭包绑定真实实现——外部展开覆盖单个方法不会污染其余方法的语义
 * （CAS 复核必须始终读到磁盘真身，而不是测试夹层）。
 *
 * @param {string} leasePath 租约文件绝对路径
 */
export function defaultLeaseFs(leasePath) {
  const parentDir = dirname(leasePath);
  const readRawImpl = () => {
    try {
      return readFileSync(leasePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return null;
      throw err;
    }
  };
  return {
    /** 尽力而为地确保父目录存在（machineGatePaths 的降级纪律）。 */
    ensureParentDir() {
      try {
        mkdirSync(parentDir, { recursive: true });
      } catch {
        // 由 claim 的失败路径统一走 fail-open。
      }
    },
    /** 文件不存在返回 null；其余读取错误向上抛（由调用方计数/降级）。 */
    readRaw: readRawImpl,
    /** O_EXCL 原子认领；已存在时抛 code==="EEXIST"。 */
    claim(text) {
      const fd = openSync(leasePath, "wx");
      try {
        writeSync(fd, text, 0, "utf8");
      } finally {
        closeSync(fd);
      }
    },
    /** 心跳续期覆写（持有者已确证所有权之后调用）。 */
    overwrite(text) {
      writeFileSync(leasePath, text, "utf8");
    },
    /**
     * CAS 回收：当前磁盘内容与决策时所见的 expectedRaw 逐字节一致才删除。
     * 这是"绝不误删竞态胜出者"的唯一保障点。
     */
    reclaimIfSame(expectedRaw) {
      let current;
      try {
        current = readRawImpl();
      } catch {
        return false;
      }
      if (current !== expectedRaw) return false;
      try {
        unlinkSync(leasePath);
        return true;
      } catch {
        return false;
      }
    },
    /** 无条件强删（仅人工 break-lock 使用）。 */
    forceUnlink() {
      try {
        unlinkSync(leasePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// 心跳用 unref：持有者主流程结束后不该被 ≤30s 的续约定时器钉住（R23-E 孤儿教训
// 的反面——到点叫不醒就算了，下一拍再续）。
const defaultHeartbeatSleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
// R23-F/B 审计 F1：等待侧的 poll sleep **必须 ref**——直连通道（canonical main /
// 短命 CLI）在争用等待期没有任何其他 referenced handle，unref 定时器会让事件环
// 排空、进程以 exit 0 静默退出 → `npm test` 假绿（零测试执行），比 command_timeout
// 假红严重一个量级。等待者本来就是想被钉住的进程。
const defaultWaitSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultSink(logPath) {
  return (line) => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, "utf8");
    } catch {
      // 日志不可写绝不能放大为闸故障（fail-open 纪律同样约束 sink）。
    }
  };
}

/**
 * 创建同机验证串行化闸。
 *
 * @param {object} [options]
 * @param {string} [options.leasePath=verificationLeasePath()] 租约文件路径
 * @param {string} [options.logPath=gateLogPath()] 默认 sink 的追加目标
 * @param {(line: string) => void} [options.sink] 日志出口（默认追加 gate.log）
 * @param {() => number} [options.now] 时钟注入
 * @param {(ms: number) => Promise<void>} [options.sleep] 睡眠注入
 * @param {{owner?: string, runId?: string, sessionId?: string, agentId?: string}} [options.identity]
 *     写入租约的持有者身份（等待/回收日志的取证线索）
 * @param {number} [options.pid=process.pid] 仅信息性记录，绝不参与存活判定
 * @param {object} [options.fsOps] 整体替换的租约文件操作集（测试注入用）
 * @returns {{acquire: () => Promise<{token: string, release: () => Promise<boolean>, lost: () => boolean}|null>,
 *            status: () => Promise<object>, breakLock: () => Promise<{hadLock: boolean, released: boolean}>}}
 */
export function createVerificationGate({
  leasePath = verificationLeasePath(),
  logPath,
  sink,
  now = () => Date.now(),
  // [R23-F/B 审计 F1] 等待与心跳的睡眠分离：等待侧必须 ref（见 defaultWaitSleep 注释），
  // 心跳侧保持 unref。`sleep` 仍可整体注入（测试假钟），注入时两处同用。
  sleep,
  waitSleep = sleep ?? defaultWaitSleep,
  heartbeatSleep = sleep ?? defaultHeartbeatSleep,
  identity = {},
  pid = process.pid,
  fsOps,
} = {}) {
  const emitRaw = sink ?? defaultSink(logPath ?? gateLogPath());
  const safeEmit = (line) => {
    try {
      emitRaw(line);
    } catch {
      // sink 故障不得放大为闸故障。
    }
  };
  const fs = fsOps ?? defaultLeaseFs(leasePath);

  const renderRecord = (token, timestamp, base = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      token,
      owner: base.owner ?? identity.owner ?? null,
      runId: base.runId ?? identity.runId ?? null,
      sessionId: base.sessionId ?? identity.sessionId ?? null,
      agentId: base.agentId ?? identity.agentId ?? null,
      pid: base.pid ?? pid,
      startedAt: base.startedAt ?? timestamp,
      heartbeatAt: timestamp,
    });

  // ── 持有侧状态（每个闸实例同时至多持有一把锁）
  let heartbeatRunning = false;
  let leaseLost = false;

  function startHeartbeat(token) {
    heartbeatRunning = true;
    void (async () => {
      while (heartbeatRunning) {
        await heartbeatSleep(HEARTBEAT_INTERVAL_MS);
        if (!heartbeatRunning) return;
        try {
          const raw = fs.readRaw();
          const record = raw === null ? null : parseLeaseRecord(raw);
          if (!record || record.token !== token) {
            // 被接管/被清除：如实上报，停止续约，绝不删别人的锁，绝不抛错。
            leaseLost = true;
            heartbeatRunning = false;
            safeEmit("[verification-gate] lease lost: our verification lease was taken over or removed; stopping renewal and NOT touching the new holder's lock");
            return;
          }
          fs.overwrite(renderRecord(token, now(), record));
        } catch {
          // 瞬态读写失败：跳过这一拍，下一拍继续（STALE_MS 容忍多次失拍）。
        }
      }
    })();
  }

  function makeHandle(token, startedAt) {
    return {
      token,
      lost: () => leaseLost,
      /**
       * 释放只认 token 匹配：租约已易主/已消失时是 no-op（返回 false），
       * 绝不删除新主人的锁（gitLocalExclude 先例）。
       */
      async release() {
        heartbeatRunning = false;
        if (leaseLost) return false;
        let raw;
        try {
          raw = fs.readRaw();
        } catch {
          return false;
        }
        if (raw === null) return false;
        const record = parseLeaseRecord(raw);
        if (!record || record.token !== token) return false;
        const removed = fs.reclaimIfSame(raw);
        if (removed) {
          safeEmit(`[verification-gate] released verification lease (held ${now() - startedAt}ms)`);
        }
        return removed;
      },
    };
  }

  /**
   * 认领闸。永 reject：
   *   · 成功 ⇒ handle（心跳循环已启动）；
   *   · 基础设施故障 ⇒ null（fail-open：WARNING 已入 sink，调用方无闸继续）；
   *   · 他方持有 ⇒ 无限等待（每 POLL 一拍；等待期绝不计入任何验证预算）。
   */
  async function acquire() {
    try {
      fs.ensureParentDir();
      // tok- 前缀让日志/gate.log 里的所有权线索一眼可辨。
      const myToken = `tok-${randomBytes(16).toString("hex")}`;
      let corruptSeenAt = null;
        let consecutiveReclaimFailures = 0; // [审计 F3] 回收失败连续计数（fail-open 上界）
      let consecutiveReadFailures = 0;
      let lastWaitLogAt = null;
      for (;;) {
        // ── 先原子认领（O_EXCL）：空闲基线零额外开销。
        try {
          const startedAt = now();
          fs.claim(renderRecord(myToken, startedAt));
          startHeartbeat(myToken);
          return makeHandle(myToken, startedAt);
        } catch (err) {
          if (!err || err.code !== "EEXIST") {
            safeEmit(`[verification-gate] WARNING fail-open: cannot create verification lease (${describeErr(err)}); continuing WITHOUT serialization`);
            return null;
          }
        }

        // ── EEXIST：重读 + 确认（原子认领循环的后半段）。
        let raw;
        try {
          raw = fs.readRaw();
          consecutiveReadFailures = 0;
        } catch (err) {
          consecutiveReadFailures += 1;
          if (consecutiveReadFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
            safeEmit(`[verification-gate] WARNING fail-open: verification lease persistently unreadable (${describeErr(err)}); continuing WITHOUT serialization`);
            return null;
          }
          raw = undefined; // 瞬态：下一拍重试
        }

        if (raw !== undefined && raw !== null) {
          const record = parseLeaseRecord(raw);
          if (record) corruptSeenAt = null; // 目击完好租约即复位损坏跟踪
          const heartbeatAgeMs = record ? now() - record.heartbeatAt : NaN;
          if (!record) {
            // 损坏宽限窗：自首次目击起算（时钟注入 ⇒ 测试确定性），超窗回收。
            if (corruptSeenAt === null) {
              corruptSeenAt = now();
              safeEmit("[verification-gate] corrupt verification lease observed; starting grace window");
            } else if (now() - corruptSeenAt >= CORRUPT_GRACE_MS) {
              safeEmit(`[verification-gate] corrupt verification lease past grace window (${now() - corruptSeenAt}ms); reclaiming`);
              if (fs.reclaimIfSame(raw)) { consecutiveReclaimFailures = 0; corruptSeenAt = null; continue; }
              // [审计 N2] 同一 fail-open 上界覆盖三处回收分支。
              consecutiveReclaimFailures += 1;
              if (consecutiveReclaimFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
                safeEmit(`[verification-gate] WARNING fail-open: reclaim failed ${consecutiveReclaimFailures}× consecutively (corrupt); continuing WITHOUT serialization`);
                return null;
              }
            }
          } else if (heartbeatAgeMs >= STALE_MS) {
            safeEmit(`[verification-gate] holder lease stale (holder=${renderHolderJson(record)}, heartbeatAgeMs=${heartbeatAgeMs} >= ${STALE_MS}); reclaiming`);
            if (fs.reclaimIfSame(raw)) {
              consecutiveReclaimFailures = 0; // 成功回收复位（N1：复位必须在成功侧，否则上界不可达）
              continue;
            }
            // [R23-F/B 审计 F3] 回收失败（句柄占用/ACL 拒删——Windows 现实面）
            // 与读失败同权：连续超限即 fail-open（WARNING + 无闸继续），不允许
            // 1s 节律的永久 reclaim 循环刷屏 gate.log。
            consecutiveReclaimFailures += 1;
            if (consecutiveReclaimFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
              safeEmit(`[verification-gate] WARNING fail-open: reclaim failed ${consecutiveReclaimFailures}× consecutively; continuing WITHOUT serialization`);
              return null;
            }
          } else if (now() - record.startedAt >= MAX_HOLD_MS) {
            // "活着但挂死"：心跳新鲜也弃置（本轮主症状的对症裁决）。
            safeEmit(`[verification-gate] holder exceeded max-hold cap (holder=${renderHolderJson(record)}, heldForMs=${now() - record.startedAt} >= ${MAX_HOLD_MS}) despite fresh heartbeat; treating as abandoned and taking over`);
            if (fs.reclaimIfSame(raw)) { consecutiveReclaimFailures = 0; continue; }
            consecutiveReclaimFailures += 1;
            if (consecutiveReclaimFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
              safeEmit(`[verification-gate] WARNING fail-open: reclaim failed ${consecutiveReclaimFailures}× consecutively (max-hold); continuing WITHOUT serialization`);
              return null;
            }
          } else {
            // 排队可见性：首见立即打，此后每 WAIT_LOG_INTERVAL_MS 一条。
            const t = now();
            if (lastWaitLogAt === null || t - lastWaitLogAt >= WAIT_LOG_INTERVAL_MS) {
              lastWaitLogAt = t;
              safeEmit(`[verification-gate] waiting for verification lease: holder=${renderHolderJson(record)} startedAt=${record.startedAt} heartbeatAgeMs=${t - record.heartbeatAt}`);
            }
          }
        } else if (raw === null) {
          corruptSeenAt = null;
          consecutiveReclaimFailures = 0; // [审计 N1] 租约消失 ⇒ 计数复位（成功侧/离开侧）
        }

        await waitSleep(POLL_INTERVAL_MS);
      }
    } catch (err) {
      // 绝对 fail-open 兜底：闸内部的任何意外都不许变成调用方的失败。
      safeEmit(`[verification-gate] WARNING fail-open: unexpected gate error (${describeErr(err)}); continuing WITHOUT serialization`);
      return null;
    }
  }

  /** 只读查询：free / held（holder 字段齐备）/ corrupt 三态。 */
  async function status() {
    let raw;
    try {
      raw = fs.readRaw();
    } catch {
      return { free: false, corrupt: true, holder: null };
    }
    if (raw === null) return { free: true };
    const record = parseLeaseRecord(raw);
    if (!record) return { free: false, corrupt: true, holder: null };
    return {
      free: false,
      holder: {
        owner: record.owner ?? null,
        runId: record.runId ?? null,
        sessionId: record.sessionId ?? null,
        agentId: record.agentId ?? null,
        pid: Number.isFinite(record.pid) ? record.pid : null,
        startedAt: record.startedAt,
        heartbeatAt: record.heartbeatAt,
        ageMs: Math.max(0, now() - record.heartbeatAt),
      },
    };
  }

  /** 人工玻璃破断（runs gate --release）：无视 token 强制移除现存租约。 */
  async function breakLock() {
    let raw;
    try {
      raw = fs.readRaw();
    } catch {
      const removed = fs.forceUnlink();
      safeEmit(`[verification-gate] manual break-lock on unreadable lease: removed=${removed}`);
      return { hadLock: true, released: removed };
    }
    if (raw === null) return { hadLock: false, released: false };
    const record = parseLeaseRecord(raw);
    const removed = fs.forceUnlink();
    safeEmit(`[verification-gate] manual break-lock: forced removal ${removed ? "succeeded" : "failed"} (${record ? `holder=${renderHolderJson(record)}` : "corrupt lease"})`);
    return { hadLock: true, released: removed };
  }

  return { acquire, status, breakLock };
}
