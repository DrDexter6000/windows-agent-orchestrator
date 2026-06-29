import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

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
  }

  async append(type, payload = {}) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const releaseLock = await acquireAppendLock(this.filePath);
    try {
      this.seq = Math.max(this.seq, await readMaxSeq(this.filePath)) + 1;
      const event = {
        ts: new Date().toISOString(),
        seq: this.seq,
        runId: this.context.runId,
        agentId: this.context.agentId,
        type,
        ...payload,
      };
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
      return event;
    } finally {
      await releaseLock();
    }
  }
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
