import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createSecretRedactor } from "./secretRedaction.js";

const APPEND_LOCK_TIMEOUT_MS = 5000;
const APPEND_LOCK_STALE_MS = 30000;

export const RUN_STATES = [
  "pending",
  "submitted",
  "running",
  "completed",
  "failed",
  "aborted",
  "timed_out",
];

export const TERMINAL_STATES = ["completed", "failed", "aborted", "timed_out"];

export class JsonlTranscript {
  constructor(filePath, context) {
    this.filePath = filePath;
    this.context = context;
    this.seq = Number.isInteger(context?.initialSeq) ? context.initialSeq : 0;
    this.redactor = createSecretRedactor();
  }

  redact(value) {
    return this.redactor.redact(value);
  }

  async append(type, payload = {}) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      this.seq = Math.max(this.seq, await readMaxSeq(this.filePath)) + 1;
      const event = {
        ...this.redact(payload),
        ts: new Date().toISOString(),
        seq: this.seq,
        runId: this.context.runId,
        agentId: this.context.agentId,
        type,
      };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      return event;
    } finally {
      await releaseLock();
    }
  }

  /**
   * TD-99：跨进程原子终态仲裁。
   *
   * 在已有 append lock 内一次完成：读事件 → 检查既有终态 → 分配 seq → 批量 append。
   * 不在持锁期间调公开 append()（避免嵌套锁死锁）——直接在锁内 readFile/appendFile。
   *
   * 仲裁规则（first terminal wins）：
   *   - 历史已有 terminal run.state_change → 拒绝任何新转移（含 running/submitted 复活）。
   *   - 有 state_change 但均非终态 → 不把 run.error/run.completed 等前置事实当终态。
   *   - 完全无 state_change → 用 findState 的 legacy fallback 判断是否有 legacy terminal
   *     fact（旧 transcript 兼容）。
   *
   * TD-100 收尾：options.attemptEvents——意图事件（如 run.stop_requested），无论
   * accepted/rejected 都同批写入。这样 stop 命令不再 claim 前单独 append stop_requested
   * （旧实现会被同一 transcript 的 _detectExistingTerminal 读到导致自拒绝），而是通过
   * attemptEvents 把 stop_requested 作为 claim 批次的一部分提交。持锁读取的旧 events
   * 不含本次 attemptEvents，不自拒绝。
   *
   * terminal 成功时，可将 terminal fact event（如 run.aborted/run.completed）与 state_change
   * 同批写入（options.factEvents），保证终态事实与状态转移原子落盘。
   * rejected 时写 run.state_change_rejected 审计事件（不静默消失），不写 factEvents。
   *
   * @param {string} from - 期望的源状态（信息性，不做严格校验）
   * @param {string} to - 目标状态
   * @param {string} reason
   * @param {{ factEvents?: Array<{type: string, payload?: object}>,
   *           attemptEvents?: Array<{type: string, payload?: object}> }} [options]
   *   factEvents: terminal 成功时同批写入（如 [{type:"run.aborted", payload:{...}}]）。
   *   attemptEvents: 无论 accepted/rejected 都同批写入（如 stop_requested）。
   * @returns {Promise<{accepted:true, state, transition, facts, attempts}|{accepted:false, state, rejection, attempts}>}
   */
  async transitionState(from, to, reason, options = {}) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      let events = [];
      try {
        events = await readTranscript(this.filePath);
      } catch {
        events = [];
      }
      const existing = _detectExistingTerminal(events);
      const baseSeq = Math.max(this.seq, findLastEventSeq(events));
      const attemptEvents = Array.isArray(options.attemptEvents) ? options.attemptEvents : [];
      const ts = new Date().toISOString();
      const ctx = { runId: this.context.runId, agentId: this.context.agentId };
      const safeReason = this.redactor.redactString(String(reason));

      // 先分配 attemptEvents 的 seq（无论 accepted/rejected 都写）。
      let seq = baseSeq;
      const lines = [];
      const writtenAttempts = [];
      for (const ae of attemptEvents) {
        seq += 1;
        const ev = { ...this.redact(ae.payload ?? {}), ts, seq, ...ctx, type: ae.type };
        lines.push(JSON.stringify(ev));
        writtenAttempts.push(ev);
      }

      if (existing) {
        // 被拒：写审计事件（锁内，与判定原子）。rejected 不写任何 terminal fact。
        const rejectionPayload = {
          attemptedTo: to,
          attemptedReason: safeReason,
          existingTerminal: existing,
          reason: "first_terminal_wins",
        };
        seq += 1;
        const rejectionEvent = { ts, seq, ...ctx, type: "run.state_change_rejected", ...rejectionPayload };
        lines.push(JSON.stringify(rejectionEvent));
        await appendFile(this.filePath, `${lines.join("\n")}\n`, "utf8");
        this.seq = seq;
        return { accepted: false, state: existing, rejection: rejectionPayload, attempts: writtenAttempts };
      }
      // 接受：构造完整 JSONL 字符串（attemptEvents + factEvents + state_change），一次 appendFile 原子落盘。
      const factEvents = Array.isArray(options.factEvents) ? options.factEvents : [];
      const written = [];
      for (const fe of factEvents) {
        seq += 1;
        const ev = { ...this.redact(fe.payload ?? {}), ts, seq, ...ctx, type: fe.type };
        lines.push(JSON.stringify(ev));
        written.push(ev);
      }
      seq += 1;
      const stateEv = { ts, seq, ...ctx, type: "run.state_change", from, to, reason: safeReason };
      lines.push(JSON.stringify(stateEv));
      await appendFile(this.filePath, `${lines.join("\n")}\n`, "utf8");
      this.seq = seq;
      return { accepted: true, state: to, transition: stateEv, facts: written, attempts: writtenAttempts };
    } finally {
      await releaseLock();
    }
  }
}

/**
 * TD-99 内部：检测事件序列中是否已有"已 claim 的终态"。
 * - 从后向前扫所有 run.state_change，只要历史中出现过 terminal state_change → 返回
 *   最后一个 terminal（旧双终态 transcript 兼容：last-terminal-wins）。
 *   这堵住"终态后被错误地写了非终态 running"导致复活的后门。
 * - 有 state_change 但均非终态 → 返回 null（前置事实不算已 claim）。
 * - 完全无 state_change → 用 findState 的 legacy fallback（旧 transcript 兼容）。
 *
 * TD-100 收尾：SSOT 统一——legacy fallback 与 findState/inferStateFromLegacyEvent 完全一致，
 * 不再排除 run.stop_requested。stop 命令的 stop_requested 不再 claim 前单独写入，而是通过
 * transitionState 的 attemptEvents 同批提交——因此持锁读取的旧 events 中不会包含本次的
 * stop_requested，不会自拒绝。
 */
function _detectExistingTerminal(events) {
  let lastTerminal = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const ev = events[index];
    if (ev.type === "run.state_change") {
      if (TERMINAL_STATES.includes(ev.to)) {
        // 从后向前找到的第一个 terminal state_change = 最近的 terminal。
        // 对旧双终态 transcript（如 aborted 后又 failed）返回最后写入的 terminal（last-wins 兼容）。
        lastTerminal = ev.to;
        break;
      }
      // 这条非终态——继续往前找是否有更早的 terminal（防"终态后错误 running"复活）。
    }
  }
  if (lastTerminal) return lastTerminal;
  // 有 state_change 但扫完全部均非终态。
  if (events.some((e) => e.type === "run.state_change")) {
    return null;
  }
  // 完全无 state_change：legacy fallback——与 findState 同源（inferStateFromLegacyEvent）。
  const inferred = findState(events);
  return TERMINAL_STATES.includes(inferred) ? inferred : null;
}

async function acquireAppendLock(filePath) {
  const lockPath = `${filePath}.seq.lock`;
  const start = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf8");
      return async () => {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await removeStaleLock(lockPath);
      if (Date.now() - start > APPEND_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for transcript append lock: ${lockPath}`);
      }
      await sleep(5);
    }
  }
}

async function removeStaleLock(lockPath) {
  try {
    const raw = await readFile(lockPath, "utf8");
    const data = JSON.parse(raw);
    if (Date.now() - Number(data.ts) > APPEND_LOCK_STALE_MS) {
      await unlink(lockPath).catch(() => {});
    }
  } catch {
    // If the lock is unreadable, let the normal timeout path decide.
  }
}

async function readMaxSeq(filePath) {
  try {
    return findLastEventSeq(await readTranscript(filePath));
  } catch {
    return 0;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readTranscript(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function findLatest(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) {
      return events[index];
    }
  }
  return undefined;
}

/**
 * 从事件序列推算当前 RunState。
 * 优先取最后一条 run.state_change 的 to；
 * 若无 state_change（旧 transcript），用旧逻辑——最后事件 type 兜底推断，
 * 保持与重构前 runs list 行为一致。
 */
export function findState(events) {
  const stateChangeIndex = findLatestIndex(events, "run.state_change");
  const stateChange = stateChangeIndex >= 0 ? events[stateChangeIndex] : undefined;
  if (stateChange) {
    if (!TERMINAL_STATES.includes(stateChange.to)) {
      for (let index = events.length - 1; index > stateChangeIndex; index -= 1) {
        const inferred = inferStateFromLegacyEvent(events[index].type);
        if (TERMINAL_STATES.includes(inferred)) {
          return inferred;
        }
      }
    }
    return stateChange.to;
  }
  const last = events.at(-1);
  if (!last) {
    return "pending";
  }
  // TD-102: workflow.completed {completed:false} is a failed workflow, not completed.
  // 读取 workflow.completed 事件的 payload——type 映射只看类型名，不看 completed 字段。
  if (last.type === "workflow.completed" && last.completed === false) {
    return "failed";
  }
  return inferStateFromLegacyEvent(last.type);
}

function findLatestIndex(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === type) {
      return index;
    }
  }
  return -1;
}

/**
 * 旧 transcript 兜底：把最后事件的 type 映射到状态。
 * 严格复刻重构前 runs list / runs summary 的行为（用最后事件 type 作为状态）。
 */
function inferStateFromLegacyEvent(type) {
  const legacyMap = {
    "run.completed": "completed",
    "workflow.completed": "completed",
    "run.timed_out": "timed_out",
    "run.aborted": "aborted",
    "run.error": "failed",
    "run.stop_requested": "aborted",
  };
  if (legacyMap[type]) {
    return legacyMap[type];
  }
  // 非终态事件：run 已创建并在跑，归为 running（旧 transcript 无 pending/submitted 概念）
  return "running";
}

/**
 * 返回事件序列里的最大 seq。用于 resume 时定位续读点。
 * 旧 transcript 无 seq 字段时返回 0。
 */
export function findLastEventSeq(events) {
  let max = 0;
  for (const event of events) {
    if (typeof event.seq === "number" && event.seq > max) {
      max = event.seq;
    }
  }
  return max;
}
