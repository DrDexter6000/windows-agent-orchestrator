// src/application/ownerWorkerStream.js
//
// 第 144 批（决定 0131 §4）：Owner 看板 worker 侧栏 Activity 页签的事件流 GET /api/worker/stream。
// 只读：不追加转录、不写盘、不改状态，也不做语义判断。鉴权、参数闭集、固定错误体与响应头在
// ownerDashboardServer.js；这里只有流本身。
//
// 帧的内容只来自 projectWorkerActivity：每一帧 rows 就是 projectWorkerActivity({ afterSeq }) 的那一页
// （updates 摘出来单独成帧），所以流与 5 秒轮询给出的是同一份行，只是送达方式不同。一轮里新增的多过
// 一页时，从最新一页往回翻到游标（与页面 collectAfter 同一条规则），再按时间顺序分帧送完，每帧不超过
// limit 个单位；一轮最多翻 OWNER_STREAM_PAGES_MAX 页，再多就回 reset（页面重取一份快照），不让一次
// 长时间的积压把服务占住。
//
// 四种帧（闭集 OWNER_STREAM_EVENTS；event: + data: 单行 JSON，帧与帧之间一个空行）：
//   rows    游标之后的新行：那一页去掉 updates。开流时先给一帧（没有新行也是一帧）：页面据此知道接上了。
//           带 terminal: true 只表示运行已到终态——流还欠一个 end；end 之前流断了，页面要自己再取一次
//           游标之后的行
//   update  同一 seq 上的就地更新（命令行补上了退出码），来自那一页的 updates。同一页里它先于 rows
//           发出，带这一页推进之前的游标：只收到 update 就断线，从它的游标续传，整页（含这条 update）
//           会重发——页面换入 update 是幂等的；收到了 rows，update 一定在它之前到过
//   reset   游标续不上了，页面重取一份快照；发完即关。reason 是闭集 OWNER_STREAM_RESET_REASONS：
//           cursor（重连时带来的游标对不上：别的服务实例、别的文件、被截断、之前的内容变了）、
//           changed（流开着的时候文件被截断 / 替换，已发出的部分不再是它的前缀）、unreadable（整行坏了）、
//           overflow（一轮翻不完）、undeliverable（追来的事件按事件号寻不到）、unreachable（转录找不回来
//           超过了宽限期）、revoked（开流之后的授权复核没过：运行不在已发布快照里、不是 ok，或副本复核
//           不过）
//   end     运行到终态：先把剩下的行发完，等一个兜底周期（紧跟终态的记账事件也在这一会儿里照常送
//           出去），再整读对账一次，最后发 end 并关流
//   每 OWNER_STREAM_HEARTBEAT_MS 发一行注释心跳（": hb"）。
//
// 传输游标与事件 seq 分开。seq 只用于显示和取页；游标 = 流代际（服务实例的 nonce）+ 转录文件身份
// （设备号 + 文件号，折成标签，文件号本身不出服务端）+ 已读到的字节偏移 + 已发出的事件位置 + 已发出
// 内容的哈希链。带着游标重连时整读一遍：代际、文件身份、偏移落在整行边界上、偏移之前的内容与哈希链
// 一致，四样都对上才从这个位置接着读；任何一样对不上都回 reset，不猜续传位置。
//
// 读转录：fs.watch 只负责唤醒，另有 1 秒兜底轮询。每一轮先看文件身份与长度：身份变了或比已读的短
// （被移动、截断、移桶、换了文件），或者 watcher 报错失效过 → 重新定位（仍走读模型的授权与副本复核）、
// 完整解析、与已发出的游标对账——已发出的部分仍是这份转录的前缀就接着往下，否则 reset。身份没变且
// 变长了 → 只读新增的那一段，与上次留下的半行拼起来，只解析到最后一个换行为止的整行，末尾的半行
// 留到下一轮（下一次从上次读到的地方接着读，半行不重复读）。不长期持有文件句柄：读完即关，不挡别人
// 移动或删除转录。增量读、整读对账、终态收尾共用一个 busy：同一时刻只有一轮在动连接的状态。
//
// 授权跟着读模型走：开流时路由与读模型各核对一次；开着的时候每 OWNER_STREAM_AUTH_MS 再核对一次
// （authorize：运行仍在已发布快照里且是 ok；locateRunTranscript：副本复核，与一次 /api/worker/activity
// 的读同一份代价，不解析也不投影）。不过就发 reset（revoked）并关流，那一轮的新行不再送。送行的每一条路
// （增量读、终态收尾的整读）读转录之前都问同一个 authorizedNow：收尾接手时复核已经到期，也先复核。
//
// 背压：每条连接只看客户端有没有在读。write() 答 false（缓冲没排空）就记下起点，客户端读走了
// （'drain'）起点作废；起点超过 OWNER_STREAM_STALL_MS 的下一轮检查才断开这条连接——页面带着最后一帧的
// id 重连，或退回轮询。写帧本身从不断开连接，所以一轮里同步写出再多的帧（最多 8 页加 update）也
// 不会误断一个正常读的客户端。写入失败或客户端断开时立即关 watcher 与定时器。只剩心跳时（15 秒
// 一行、6 字节）内核缓冲先吸收，等不到"缓冲没排空"：真断掉的对端靠 socket 报错 / 关闭发现，不靠这一条。
// 最后一帧（end / reset，包括游标被拒时回的那一帧、第一轮翻不完就发的 reset）写出去之后，响应可能还有一部分
// 留在缓冲里（客户端不读）：在它真正结束（'finish'）或断开（'close'）之前，这条连接仍归服务管——占着连接名额，
// 停滞超时照样销毁它，closeAll() 也销毁它；不再看文件，也不再写任何东西。
// 单个服务的流连接总数不超过 OWNER_STREAM_CONNECTIONS_MAX，超出由路由回 503。
//
// 已知不防（一句话一条）：
//   - 文件身份没变、长度不缩的原地改写（把前面的事件改掉）在流开着的时候认不出来——追加才是转录的
//     写法；带着游标重连、终态对账与 watcher 失效后的整读对账时会发现它。
//   - 伪造或过期的游标在判废前要整读一遍转录（受连接总数上限约束）。
//   - 服务端只发 LF；页面的解析器在纯 CR 流的最后一个 CR 上会等下一块（那个 CR 可能是 CRLF 的前半）。
//   - 一个开流请求正在读转录时，close() 要等这次读完。
//   - 每次有新增都对整份事件重新投影，每条连接留一份解析后的事件（至多 32 条连接）。
//   - 运行已到终态之后才写进转录的记账事件（例如几分钟后的交付采纳）不再进流，也不计入"已结束，
//     共 N 条"——与轮询在这一处的口径相同。
// 按事件号寻不到的追加（没有号、号重复或倒退）不进时间线的增量，回 reset 让页面重取快照，与轮询
// 在这一处的口径相同。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod；只读。

import { createHash, randomBytes } from "node:crypto";
import { watch as fsWatch } from "node:fs"; // the callback-API watcher (node:fs/promises has an async-iterator one)
import { open as fsOpen, stat as fsStat } from "node:fs/promises";
import { OWNER_ACTIVITY_LIMIT_DEFAULT, OWNER_SEQ_MAX, projectWorkerActivity } from "./ownerWorkerActivity.js";
import { eventsOfCompleteLines } from "./ownerReadModel.js";

/** 帧的事件名（闭集）。 */
export const OWNER_STREAM_EVENTS = Object.freeze(["rows", "update", "reset", "end"]);
/** reset 帧的 reason（闭集）。 */
export const OWNER_STREAM_RESET_REASONS = Object.freeze(["cursor", "changed", "unreadable", "overflow", "undeliverable", "unreachable", "revoked"]);
/** 一帧至多多少个单位：与 /api/worker/activity 的缺省页上限相同，一帧就是一页。 */
export const OWNER_STREAM_LIMIT = OWNER_ACTIVITY_LIMIT_DEFAULT;
/**
 * 一轮最多翻多少页。与页面的追平上限（ACTIVITY_CATCHUP_PAGE_MAX）相同：再多页面本来也只会给出一条
 * "未加载"的线，不如让它重取一份快照；这也是一轮工作量的上界（页数 × 每页单位）。
 */
export const OWNER_STREAM_PAGES_MAX = 8;
/** 一个服务同时最多开多少条流。一个页面的 Activity 页签一条；每条留一份解析后的事件、一个 watcher、两个定时器。 */
export const OWNER_STREAM_CONNECTIONS_MAX = 32;
/**
 * 客户端不读多久就断开它：从 write() 第一次答 false（缓冲没排空）起算，'drain'（读走了）作废。
 * 正常读的客户端（回环、浏览器）在几毫秒内排空缓冲，一轮最多 8 页加 update 的突发也一样，所以这个值
 * 与帧数、字节数都无关，只回答"它是不是真的不读了"。取读模型一轮刷新的间隔（5 秒，也是五个兜底轮询
 * 周期）：浏览器后台标签或调试暂停的短暂停顿不误断；真不读的连接至多多占 5 秒加一个轮询周期，缓冲里
 * 至多多出这几秒的产出；断开后页面带着最后一帧的 id 重连，或退回轮询，不丢数据。
 */
export const OWNER_STREAM_STALL_MS = 5000;
/**
 * 开流之后多久重新核对一次授权。取读模型一轮刷新的间隔：读模型多久发布一次新的快照，这里就多久
 * 看一眼运行还在不在、副本还对不对（每次的代价与一次 /api/worker/activity 的读相当，不更高）。
 */
export const OWNER_STREAM_AUTH_MS = 5000;
/** 兜底轮询的周期：watcher 不报或报错时，追加的事件最迟这么久被读到。 */
export const OWNER_STREAM_POLL_MS = 1000;
/** 心跳周期：让中间设备与浏览器知道这条连接还活着。 */
export const OWNER_STREAM_HEARTBEAT_MS = 15_000;
/** 转录找不到（移走后读模型的索引还没跟上、读失败）时的宽限：读模型一轮刷新的间隔。 */
export const OWNER_STREAM_LOST_GRACE_MS = 5000;
/**
 * 看到终态之后、对账收尾之前等一小会儿。紧跟终态的记账事件（状态变化那一行、裁决……）在真实转录里
 * 与终态事件同一批写入，但一批落盘没有原子保证：读到的正好是中间那一瞬时，立刻收尾会把它们漏在
 * 流外。等一个兜底周期，这期间追加的照常送出去，然后才整读对账、发 end。
 */
export const OWNER_STREAM_END_SETTLE_MS = OWNER_STREAM_POLL_MS;

/** 传输游标的形状：1.<代际 16 位十六进制>.<文件标签 16 位十六进制>.<字节偏移 36 进制>.<事件位置 36 进制>.<哈希链 16 位十六进制>。 */
export const OWNER_STREAM_CURSOR_RE = /^1\.[0-9a-f]{16}\.[0-9a-f]{16}\.[0-9a-z]{1,11}\.[0-9a-z]{1,6}\.[0-9a-f]{16}$/;
/** 传输游标的长度上限：各段都取最长时恰为这个数（2 + 16 + 1 + 16 + 1 + 11 + 1 + 6 + 1 + 16）。 */
export const OWNER_STREAM_CURSOR_MAX_CHARS = 71;

const HEX16_RE = /^[0-9a-f]{16}$/;
const EMPTY_CHAIN = "0".repeat(16);
const LF = 0x0a;

// ===== 帧 =====

/**
 * 一帧的线上文本。`id` 是传输游标（null = 不带 id 行）。
 *
 * @param {"rows"|"update"|"reset"|"end"} event
 * @param {object} data
 * @param {string|null} id
 */
export function encodeStreamFrame(event, data, id) {
  if (!OWNER_STREAM_EVENTS.includes(event)) throw new RangeError("ownerWorkerStream: unknown frame event");
  if (id !== null && (typeof id !== "string" || !OWNER_STREAM_CURSOR_RE.test(id))) throw new RangeError("ownerWorkerStream: invalid frame id");
  return `${id === null ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 一行注释心跳。 */
export const heartbeatFrame = () => ": hb\n\n";

// ===== 传输游标 =====

/**
 * 传输游标 → 不透明字符串。offset 是字节偏移（不超过 2^53-1），seq 是事件位置（不超过 OWNER_SEQ_MAX）。
 *
 * @param {{generation: string, file: string, offset: number, seq: number, chain: string}} position
 */
export function encodeStreamCursor({ generation, file, offset, seq, chain }) {
  if (typeof generation !== "string" || !HEX16_RE.test(generation)) throw new RangeError("ownerWorkerStream: invalid cursor generation");
  if (typeof file !== "string" || !HEX16_RE.test(file)) throw new RangeError("ownerWorkerStream: invalid cursor file");
  if (typeof chain !== "string" || !HEX16_RE.test(chain)) throw new RangeError("ownerWorkerStream: invalid cursor chain");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("ownerWorkerStream: invalid cursor offset");
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > OWNER_SEQ_MAX) throw new RangeError("ownerWorkerStream: invalid cursor seq");
  return `1.${generation}.${file}.${BigInt(offset).toString(36)}.${BigInt(seq).toString(36)}.${chain}`;
}

/** 不透明字符串 → 传输游标；形状不对给 null。 */
export function decodeStreamCursor(raw) {
  if (typeof raw !== "string" || !OWNER_STREAM_CURSOR_RE.test(raw)) return null;
  const [, generation, file, offset, seq, chain] = raw.split(".");
  return { generation, file, offset: Number.parseInt(offset, 36), seq: Number.parseInt(seq, 36), chain };
}

// ===== 读转录 =====

/** buffer 里到最后一个 LF 为止的整行 → 事件，以及这些行占的字节数；其后没有换行的半行不算。坏行抛出。 */
function completeTail(buffer) {
  const end = buffer.lastIndexOf(LF);
  if (end < 0) return { events: [], consumed: 0 };
  return { events: eventsOfCompleteLines(buffer.subarray(0, end + 1).toString("utf8")), consumed: end + 1 };
}

/** 已发出内容的哈希链：每条事件推进一步（同一份转录的同一份事件，链值相同）。 */
function chainFrom(events, from, to, chain) {
  let digest = chain;
  for (let i = from; i < to; i += 1) {
    digest = createHash("sha256").update(digest).update("\n").update(JSON.stringify(events[i])).digest("hex").slice(0, 16);
  }
  return digest;
}

/** 追来的事件按事件号寻得到吗：每一条都得是合法的号，并且比之前出现过的号都大（重复或倒退的号寻不到）。 */
function addressable(events, maxSeq) {
  let seen = maxSeq;
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 1 || event.seq > OWNER_SEQ_MAX || event.seq <= seen) return false;
    seen = event.seq;
  }
  return true;
}

/** 出现过的最大的合法事件号。 */
const maxSeqOf = (events) => events.reduce((max, event) => (Number.isSafeInteger(event.seq) && event.seq > max ? event.seq : max), 0);

/** 文件身份：设备号 + 文件号。 */
const sameFile = (a, b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
/** 文件身份折成给页面看的标签（带流代际；文件号本身不出服务端）。 */
const fileTagOf = (generation, fileId) => createHash("sha256").update(`${generation}|${fileId.dev}|${fileId.ino}`).digest("hex").slice(0, 16);
/** 一段字节单独留一份（不用 subarray：那会把整份转录的字节一直留在内存里）。 */
const copyFrom = (bytes, start) => (start >= bytes.length ? Buffer.alloc(0) : Buffer.copyBytesFrom(bytes, start));

const DEFAULT_IO = Object.freeze({
  /** 时钟（毫秒）：停滞、授权复核与宽限期都从它算；测试注入假钟。 */
  now: () => Date.now(),
  /** 看住一个文件：有变化回调一次；看不住（报错）回调 onError。返回关掉它的函数。 */
  watch: (path, onEvent, onError) => {
    const watcher = fsWatch(path, { persistent: false }, () => onEvent());
    watcher.on("error", onError);
    return () => watcher.close();
  },
  stat: (path) => fsStat(path, { bigint: true }),
  /** 从 position 起读 length 个字节；读完即关句柄。 */
  read: async (path, position, length) => {
    const handle = await fsOpen(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return buffer.subarray(0, done);
    } finally {
      await handle.close();
    }
  },
});

/**
 * 一个服务的事件流：连接总数上限、开流、全断开。
 *
 * @param {object} input
 * @param {object} input.readModel — Owner 读模型（locateRunTranscript：授权 + 请求当刻的副本复核）
 * @param {Function} [input.authorize] — `(runId, token?) => boolean`：运行此刻在服务已发布的快照里且是 ok
 *   （服务给；缺省不查这一层，只剩 locateRunTranscript 的复核）。145b 起第二参是这条流开流时的
 *   bearer 值（服务端用来复核会话令牌是否仍有效）。开流后每 OWNER_STREAM_AUTH_MS 问一次
 * @param {object} [input.env] — 脱敏用的环境（缺省 process.env）
 * @param {string} [input.generation] — 流代际（服务实例的 nonce，16 位十六进制）；缺省随机
 * @param {object} [input.io] — 注入缝（测试用）：`now()`、`watch(path, onEvent, onError)`、`stat(path)` → bigint stat、
 *   `read(path, position, length)` → 字节
 * @param {object} [input.limits] — 注入缝（测试用）：`limit`、`pagesMax`、`connectionsMax`、`stallMs`、`authMs`、`pollMs`、`endSettleMs`、`lostGraceMs`
 * @returns {{generation: string, size: Function, full: Function, open: Function, closeAll: Function}}
 *   open({ runId, afterSeq, cursor, filter, res, headers, token }) → { ok: true, connection } |
 *   { ok: false, reason: "not_found" | "full" | "closed" | "gone" }。ok 为 true 时 200 的响应头已经写出
 *   （游标对不上时：200 + 一帧 reset，已结束）；connection 是给路由与测试的把手：close()、check()（立刻查一轮）。
 */
export function createWorkerStreams({
  readModel, env, authorize, generation = randomBytes(8).toString("hex"), io = {}, limits = {},
} = {}) {
  if (typeof generation !== "string" || !HEX16_RE.test(generation)) throw new TypeError("createWorkerStreams: invalid generation");
  if (authorize !== undefined && typeof authorize !== "function") throw new TypeError("createWorkerStreams: authorize must be a function when given");
  const limit = limits.limit ?? OWNER_STREAM_LIMIT;
  const pagesMax = limits.pagesMax ?? OWNER_STREAM_PAGES_MAX;
  const connectionsMax = limits.connectionsMax ?? OWNER_STREAM_CONNECTIONS_MAX;
  const stallMs = limits.stallMs ?? OWNER_STREAM_STALL_MS;
  const authMs = limits.authMs ?? OWNER_STREAM_AUTH_MS;
  const pollMs = limits.pollMs ?? OWNER_STREAM_POLL_MS;
  const endSettleMs = limits.endSettleMs ?? OWNER_STREAM_END_SETTLE_MS;
  const lostGraceMs = limits.lostGraceMs ?? OWNER_STREAM_LOST_GRACE_MS;
  for (const [name, value] of Object.entries({ endSettleMs, lostGraceMs })) {
    if (!(Number.isInteger(value) && value >= 0)) throw new TypeError(`createWorkerStreams: ${name} must be a non-negative integer`);
  }
  for (const [name, value] of Object.entries({ limit, pagesMax, connectionsMax, stallMs, authMs, pollMs })) {
    if (!(Number.isInteger(value) && value >= 1)) throw new TypeError(`createWorkerStreams: ${name} must be a positive integer`);
  }
  if (limit > OWNER_ACTIVITY_LIMIT_DEFAULT) throw new TypeError(`createWorkerStreams: limit must not exceed ${OWNER_ACTIVITY_LIMIT_DEFAULT}`);
  const fs = { ...DEFAULT_IO, ...io };
  const now = () => fs.now();
  const connections = new Set();
  let pending = 0; // 正在读转录、还没登记进 connections 的开流：它们也占名额
  let closed = false;

  /** 这一轮这一页之后的行都发出去了：传输游标。 */
  const cursorOf = (conn) => encodeStreamCursor({
    generation, file: fileTagOf(generation, conn.fileId), offset: conn.offset, seq: conn.seqAt, chain: conn.chain,
  });
  const projectionEnv = env === undefined ? {} : { env };

  /** 定位并授权读一份转录（读不到一律 null，不回显原因）。 */
  async function locate(runId) {
    if (typeof readModel?.locateRunTranscript !== "function") return null;
    try {
      return await readModel.locateRunTranscript(runId);
    } catch {
      return null;
    }
  }

  // ===== watcher 与定时器 =====

  function unwatch(conn) {
    const stop = conn.unwatch;
    conn.unwatch = null;
    if (stop === null) return;
    try {
      stop();
    } catch {
      // 已经关了
    }
  }

  function watch(conn) {
    if (conn.unwatch !== null || conn.closed) return;
    try {
      // watcher 报错失效：关掉它，只剩兜底轮询；它失效的这段时间里漏掉了什么不知道，下一轮要整读对账一次。
      conn.unwatch = fs.watch(conn.path, () => { check(conn); }, () => { unwatch(conn); conn.reconcile = true; });
    } catch (error) {
      // 只吞文件系统的错（文件此刻看不住：刚被移走、没有权限……），那时只剩兜底轮询。
      if (typeof error?.code !== "string") throw error; // 不是文件系统的错就是代码的错：让它暴露，不悄悄退化成轮询
      conn.unwatch = null;
    }
  }

  /** 兜底轮询与心跳。最后一帧已经写出（done）的连接只需要轮询——它只剩看管缓冲交完，不再发心跳。 */
  function arm(conn) {
    conn.pollTimer = setInterval(() => { check(conn); }, pollMs);
    if (!conn.done) conn.heartbeatTimer = setInterval(() => write(conn, heartbeatFrame()), OWNER_STREAM_HEARTBEAT_MS);
    // 监听中的 HTTP 服务撑着进程；这两个定时器不该单独把进程留住。
    if (typeof conn.pollTimer.unref === "function") conn.pollTimer.unref();
    if (conn.heartbeatTimer !== null && typeof conn.heartbeatTimer.unref === "function") conn.heartbeatTimer.unref();
  }

  // ===== 写 =====

  /**
   * 写一帧。write() 答 false = 缓冲没排空（客户端还没读走）：记下从什么时候起，'drain' 才作废它。这里从不
   * 断开连接——一轮里同步写出的帧再多，缓冲也只是暂时满着；断不断由下一轮检查按停滞时间定（check）。
   */
  function write(conn, text) {
    if (conn.closed || conn.done) return; // 最后一帧已经写出：之后不再往这条响应里写任何东西
    let drained;
    try {
      drained = conn.res.write(text);
    } catch {
      closeConn(conn);
      return;
    }
    if (drained === false) conn.stalledSince ??= now();
  }

  /** 响应已经把该写的都交给了对端（或已经没了）：没有什么还要看管的。没有这个属性的假响应按已交完算。 */
  const flushed = (res) => res.writableFinished !== false || res.destroyed === true;

  /**
   * 放掉这条连接。默认让已经 end() 的响应自己把缓冲交完（它交完或对端走了，会再来一次）；destroy 是
   * 硬断开——停滞超时、close()、closeAll() 用它，缓冲里还有没交完的也一样丢掉。
   */
  function closeConn(conn, { destroy = false } = {}) {
    if (conn.closed) return;
    conn.closed = true;
    connections.delete(conn);
    // 先断开这条连接，再关 watcher 与定时器。
    if ((destroy || conn.res.writableEnded !== true) && typeof conn.res.destroy === "function") conn.res.destroy();
    if (conn.pollTimer !== null) clearInterval(conn.pollTimer);
    if (conn.heartbeatTimer !== null) clearInterval(conn.heartbeatTimer);
    if (conn.endTimer !== null) clearTimeout(conn.endTimer);
    unwatch(conn);
  }

  /**
   * 最后一帧：写出去，结束响应。不再读转录、不再发心跳；但最后一帧可能还在缓冲里（客户端不读）——在响应真正
   * 结束（'finish'）或断开（'close'）之前，这条连接仍归服务管：占着连接名额，停滞超时照样断开它（check），
   * closeAll() 也销毁它。
   */
  function finish(conn, event, data) {
    if (conn.done || conn.closed) return;
    conn.done = true;
    try {
      conn.res.end(encodeStreamFrame(event, data, event === "reset" ? null : cursorOf(conn)));
    } catch {
      // 已经断了：下面照样清掉
    }
    if (conn.heartbeatTimer !== null) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;
    }
    if (conn.endTimer !== null) {
      clearTimeout(conn.endTimer);
      conn.endTimer = null;
    }
    unwatch(conn);
    if (flushed(conn.res)) closeConn(conn);
    else conn.stalledSince ??= now(); // 缓冲里还有没交完的：从现在起算停滞
  }

  const reset = (conn, reason) => finish(conn, "reset", { runId: conn.runId, reason });

  /** 转录找不回来了：超过宽限期才放弃。 */
  function giveUpIfLost(conn) {
    if (conn.closed || conn.done) return;
    conn.lostSince ??= now();
    if (now() - conn.lostSince >= lostGraceMs) reset(conn, "unreachable");
  }

  // ===== 发帧 =====

  /**
   * 一轮：从游标往后翻页（最新一页，再往回翻到接上下游标），按时间顺序分帧送完。
   * 返回这一轮之后运行是否终态。
   */
  function emitBatch(conn) {
    const project = (extra) => projectWorkerActivity({
      runId: conn.runId, events: conn.events, limit, ...projectionEnv, ...(conn.filter === undefined ? {} : { filter: conn.filter }), ...extra,
    });
    const connected = (fromSeq) => Number.isInteger(fromSeq) && fromSeq <= conn.seqAt + 1;
    const latest = project({ afterSeq: conn.seqAt });
    const pages = [latest];
    let earliest = latest.range.fromSeq;
    while (!connected(earliest) && pages.length < pagesMax) {
      const older = project({ afterSeq: conn.seqAt, beforeSeq: earliest });
      if (older.rows.length === 0 || !Number.isInteger(older.range.fromSeq)) break;
      pages.unshift(older);
      earliest = older.range.fromSeq;
    }
    conn.lastState = latest.state;
    conn.lastTotal = latest.total;
    if (!connected(earliest)) {
      reset(conn, Number.isInteger(earliest) ? "overflow" : "undeliverable");
      return false;
    }
    for (const page of pages) {
      // 同一页里 update 先于 rows，带这一页推进之前的游标；rows 才把游标推进到这一页末尾。只收到 update
      // 就断线：从它的游标续传，整页连同这条 update 会重发（页面换入 update 是幂等的）；收到了 rows，
      // 它前面的 update 一定先到过——退出码不会被游标越过。
      if (page.updates.length > 0) write(conn, encodeStreamFrame("update", { runId: conn.runId, updates: page.updates }, cursorOf(conn)));
      if (page.range.toSeq > conn.seqAt) conn.seqAt = page.range.toSeq;
      write(conn, encodeStreamFrame("rows", { ...page, updates: [] }, cursorOf(conn)));
      if (conn.closed) return false;
    }
    return latest.terminal;
  }

  /** 接纳重新定位到的那一份（调用方已经对过账）。 */
  function adopt(conn, located, fileId, tail, bytes) {
    if (conn.path !== located.path) {
      conn.path = located.path;
      unwatch(conn);
      watch(conn);
    }
    conn.fileId = fileId;
    conn.events = tail.events;
    conn.offset = tail.consumed;
    conn.readOffset = bytes.length;
    conn.remainder = copyFrom(bytes, tail.consumed);
  }

  /**
   * 重新定位、完整解析、与已发出的游标对账。已发出的部分仍是这份转录的前缀就接纳新的一份（包括多出来
   * 的事件，那是正常情况，不算 changed），返回 { grew: 有没有新事件, moved: 文件身份换了没有 }；对不上
   * 时发 reset，定位不到或读不出时返回 false（由调用方决定等多久）。
   */
  async function reload(conn) {
    const located = await locate(conn.runId);
    if (located === null) return false;
    let tail;
    try {
      tail = completeTail(located.bytes);
    } catch {
      reset(conn, "unreadable");
      return false;
    }
    let fileId;
    try {
      fileId = await fs.stat(located.path);
    } catch {
      return false;
    }
    if (conn.closed) return false;
    if (tail.events.length < conn.events.length || chainFrom(tail.events, 0, conn.events.length, EMPTY_CHAIN) !== conn.chain) {
      reset(conn, "changed");
      return false;
    }
    const added = tail.events.slice(conn.events.length);
    if (!addressable(added, conn.maxSeq)) {
      reset(conn, "undeliverable");
      return false;
    }
    conn.maxSeq = Math.max(conn.maxSeq, maxSeqOf(added));
    conn.chain = chainFrom(added, 0, added.length, conn.chain);
    const moved = !sameFile(conn.fileId, { dev: fileId.dev, ino: fileId.ino });
    adopt(conn, located, { dev: fileId.dev, ino: fileId.ino }, tail, located.bytes);
    return { grew: added.length > 0, moved };
  }

  /** 终态看到了，剩下的行已经发完：等一个兜底周期（这期间追加的照常送），再整读对账、发 end。 */
  function settle(conn) {
    if (conn.closed || conn.done || conn.endTimer !== null) return;
    conn.endTimer = setTimeout(() => {
      conn.endTimer = null;
      startSettleEnd(conn);
    }, endSettleMs);
    // 监听中的 HTTP 服务撑着进程；这个定时器不该单独把进程留住。
    if (typeof conn.endTimer.unref === "function") conn.endTimer.unref();
  }

  /**
   * 收尾与增量读共用一个 busy：同一时刻只有一轮在动这条连接的读位置与事件。增量读还在走（停在读盘上）时
   * 只记下"到点了"，那一轮走完（check 的 finally）再收尾——两边各读各的会把同一批事件追加两遍（发出
   * reset），或者拿一份旧快照去对账一份已经长了的状态（误判 changed）。
   */
  function startSettleEnd(conn) {
    if (conn.closed || conn.done) return;
    if (conn.busy) {
      conn.settleDue = true;
      return;
    }
    conn.busy = true;
    settleEnd(conn).catch(() => closeConn(conn)).finally(() => { conn.busy = false; });
  }

  /** 终态对账：多出来的行先送（至多三轮），最后发 end 并关流。 */
  async function settleEnd(conn) {
    if (conn.closed || conn.done) return;
    for (let round = 0; round < 3 && !conn.closed; round += 1) {
      // 收尾接手时授权复核可能已经到期（增量读占着 busy 的时候到的点）：先复核，不过就 reset，不送新增的行与 end。
      if (!(await authorizedNow(conn))) {
        reset(conn, "revoked");
        return;
      }
      const before = conn.events.length;
      // 此刻定位不到或读不出：已发出的行以已经看到的终态为准。文件变长了是正常情况：多出来的行照常送。
      if (!(await reload(conn)) || conn.events.length === before) break;
      if (!emitBatch(conn)) return;
    }
    finish(conn, "end", { runId: conn.runId, state: conn.lastState, terminal: true, total: conn.lastTotal });
  }

  /** 开流之后的授权复核：运行还在已发布的快照里且是 ok，副本复核（读模型的定位）也过得去。读不出也算不过。
   * 145b：开流时的 bearer 一并复核（authorize 的第二参）——会话令牌过期就不过。 */
  async function reauthorize(conn) {
    conn.authAt = now();
    try {
      if (authorize !== undefined && authorize(conn.runId, conn.token) !== true) return false;
    } catch {
      return false;
    }
    return (await locate(conn.runId)) !== null;
  }

  /**
   * 授权此刻过得去吗：没到复核时间就是过得去，到了就复核一次。送行的每一条路（增量读、终态收尾的整读）
   * 在读转录之前都问这一个，所以收尾接手时复核已经到期，也不会绕过去。
   */
  const authorizedNow = async (conn) => now() - conn.authAt < authMs || reauthorize(conn);

  /**
   * 一轮：先看客户端还在不在读、授权还在不在，再看身份与长度，读新增的字节，发帧。watcher 与兜底轮询都走
   * 这里；同一时刻只有一轮（终态收尾也占这个 busy）。
   */
  async function check(conn) {
    if (conn.closed || conn.busy) return;
    if (conn.done) {
      // 最后一帧已经写出：只剩看管缓冲交完。交完了放手；一直交不完（客户端不读），停滞超时就销毁它。
      if (flushed(conn.res)) closeConn(conn);
      else {
        conn.stalledSince ??= now();
        if (now() - conn.stalledSince >= stallMs) closeConn(conn, { destroy: true });
      }
      return;
    }
    conn.busy = true;
    try {
      // 客户端一直没读走（write() 答过 false，'drain' 一直没来）：停滞超过时限就断开它。
      if (conn.stalledSince !== null && now() - conn.stalledSince >= stallMs) {
        closeConn(conn, { destroy: true });
        return;
      }
      // 授权跟着读模型走：到点复核一次；不过就收回这条流，这一轮的新行不再送。
      if (!(await authorizedNow(conn))) {
        reset(conn, "revoked");
        return;
      }
      const st = await fs.stat(conn.path).catch(() => null);
      if (conn.closed || conn.done) return;
      if (st === null || !sameFile(st, conn.fileId) || st.size < BigInt(conn.offset) || conn.reconcile) {
        // 被移动、截断、移桶、换了文件，或 watcher 失效过（它失效的这段时间里漏掉了什么不知道）：重新定位，
        // 完整解析，对账。
        const got = await reload(conn);
        if (got === false || conn.closed) {
          giveUpIfLost(conn);
          return;
        }
        conn.reconcile = false;
        conn.lostSince = null;
        // 对账什么新东西都没带来、文件身份也没换（watcher 失效后的例行整读）：不多发一帧。
        if ((got.grew || got.moved) && emitBatch(conn)) settle(conn);
      } else {
        // 留着半行、文件反而短了（有人把没写完的尾巴抹掉，前面的整行还在）：那份半行作废，从整行边界重读。
        if (st.size < BigInt(conn.readOffset)) {
          conn.readOffset = conn.offset;
          conn.remainder = Buffer.alloc(0);
        }
        if (st.size > BigInt(conn.readOffset)) {
          // 身份没变、变长了：从上次读到的地方接着读，上次留下的半行拼在最前面，只解析到最后一个换行为止的整行。
          const chunk = await fs.read(conn.path, conn.readOffset, Number(st.size) - conn.readOffset);
          conn.readOffset += chunk.length;
          if (conn.closed || conn.done) return;
          const buffer = Buffer.concat([conn.remainder, chunk]);
          let tail;
          try {
            tail = completeTail(buffer);
          } catch {
            reset(conn, "unreadable"); // 整行坏了：读不到，与别的接口同一个口径
            return;
          }
          // 读到了哪里（含半行）与整行到了哪里（游标用）是两个位置：半行只在余量里，不重复读。
          conn.offset += tail.consumed;
          conn.remainder = copyFrom(buffer, tail.consumed);
          if (tail.events.length === 0) return; // 只多出半行：留到下一轮，不发空帧
          if (!addressable(tail.events, conn.maxSeq)) {
            reset(conn, "undeliverable");
            return;
          }
          conn.events.push(...tail.events);
          conn.chain = chainFrom(tail.events, 0, tail.events.length, conn.chain);
          conn.maxSeq = Math.max(conn.maxSeq, maxSeqOf(tail.events));
          conn.lostSince = null;
          if (emitBatch(conn)) settle(conn);
        }
      }
    } catch (error) {
      // 文件系统的错（权限、占用、刚被移走……）与找不到一样，超过宽限期才放弃。别的错是代码的错：
      // 不反反复复地试它，断开这条连接——页面会重连或退回轮询，一条流上的问题不拖住别的。
      if (typeof error?.code === "string") giveUpIfLost(conn);
      else closeConn(conn);
    } finally {
      conn.busy = false;
      // 收尾的定时器在这一轮还没走完时到点：现在走完了，收尾紧接着上。
      if (conn.settleDue) {
        conn.settleDue = false;
        if (conn.endTimer !== null) {
          clearTimeout(conn.endTimer);
          conn.endTimer = null;
        }
        startSettleEnd(conn);
      }
    }
  }

  // ===== 开流 =====

  /**
   * 带着游标开流：核对代际、文件身份、偏移与偏移之前的内容。返回 null 表示对上了，conn 已就位；
   * 否则是 reset 的 reason。
   */
  function placeCursor(conn, cursor, located, whole, fileId, afterSeq) {
    if (cursor.generation !== generation || fileTagOf(generation, fileId) !== cursor.file) return "cursor";
    const { bytes } = located;
    // 偏移必须落在整行边界上，并且不越过已经读出来的整行。
    if (cursor.offset > whole.consumed || (cursor.offset > 0 && bytes[cursor.offset - 1] !== LF)) return "cursor";
    const prefix = completeTail(bytes.subarray(0, cursor.offset));
    if (prefix.consumed !== cursor.offset || chainFrom(prefix.events, 0, prefix.events.length, EMPTY_CHAIN) !== cursor.chain) return "cursor";
    const rest = completeTail(bytes.subarray(cursor.offset));
    conn.events = [...prefix.events, ...rest.events];
    conn.offset = cursor.offset + rest.consumed;
    conn.readOffset = bytes.length;
    conn.remainder = copyFrom(bytes, conn.offset);
    conn.chain = chainFrom(rest.events, 0, rest.events.length, cursor.chain);
    conn.maxSeq = maxSeqOf(conn.events);
    conn.seqAt = Math.max(cursor.seq, afterSeq ?? 0);
    return null;
  }

  async function open(query) {
    if (closed) return { ok: false, reason: "closed" };
    // 名额在读转录的那一会儿也要占着：两个同时到来的开流不能都挤过同一个名额。
    if (connections.size + pending >= connectionsMax) return { ok: false, reason: "full" };
    pending += 1;
    try {
      return await admit(query);
    } finally {
      pending -= 1;
    }
  }

  async function admit({ runId, afterSeq, cursor, filter, res, headers, token }) {
    const located = await locate(runId);
    if (located === null) return { ok: false, reason: "not_found" };
    let whole;
    let fileId;
    try {
      whole = completeTail(located.bytes);
      fileId = await fs.stat(located.path);
    } catch {
      return { ok: false, reason: "not_found" }; // 读不出：与别的接口同一个答案
    }
    if (whole.events.length === 0) return { ok: false, reason: "not_found" };
    if (closed) return { ok: false, reason: "closed" };
    if (res.destroyed === true || res.writableEnded === true) return { ok: false, reason: "gone" };
    const conn = {
      runId, filter, res, token,
      path: located.path, fileId: { dev: fileId.dev, ino: fileId.ino },
      // offset = 整行到了哪里（游标用它）；readOffset = 字节读到了哪里（末尾的半行留在 remainder 里）。
      offset: whole.consumed, readOffset: located.bytes.length, remainder: copyFrom(located.bytes, whole.consumed), events: whole.events,
      chain: chainFrom(whole.events, 0, whole.events.length, EMPTY_CHAIN), maxSeq: maxSeqOf(whole.events),
      seqAt: afterSeq ?? 0,
      busy: false, closed: false, done: false, lostSince: null,
      stalledSince: null, authAt: now(), reconcile: false, settleDue: false,
      pollTimer: null, heartbeatTimer: null, endTimer: null, unwatch: null,
      lastState: "unknown", lastTotal: 0,
    };
    // 游标对不上（形状不对的游标也一样）：200 + 一帧 reset，这条流随即结束。
    const parsed = cursor === undefined ? null : decodeStreamCursor(cursor);
    const refused = parsed === null ? (cursor === undefined ? null : "cursor") : placeCursor(conn, parsed, located, whole, fileId, afterSeq);
    if (closed) return { ok: false, reason: "closed" };
    // 这条响应从这里起归服务管，被拒的那一条也一样：最后一帧交完（'finish'）或断开（'close'）之前占着连接名额，
    // 停滞超时与 closeAll() 都能销毁它（与常规收尾同一套看管，见 finish）。
    connections.add(conn);
    res.writeHead(200, headers);
    if (typeof res.on === "function") {
      res.on("close", () => closeConn(conn));
      res.on("error", () => closeConn(conn));
      res.on("drain", () => { conn.stalledSince = null; }); // 客户端把缓冲读走了：停滞的起点作废
      res.on("finish", () => { if (conn.done) closeConn(conn); }); // 最后一帧交完了：放手
    }
    try {
      if (refused !== null) finish(conn, "reset", { runId, reason: refused });
      // 开流先给当前位置之后的那一页（没有新行也是一帧）：页面据此知道接上了。
      else if (emitBatch(conn)) settle(conn);
      if (!conn.closed) {
        // 第一页就已经以 reset 收尾（被拒的游标、第一轮翻不完）：不再看文件，只看管缓冲交完。
        if (!conn.done) watch(conn);
        arm(conn);
      }
    } catch {
      closeConn(conn, { destroy: true }); // 响应头已经发出去了：断开这条连接，页面会重连或退回轮询
    }
    return { ok: true, connection: { close: () => closeConn(conn, { destroy: true }), check: () => check(conn) } };
  }

  return {
    generation,
    size: () => connections.size,
    full: () => connections.size + pending >= connectionsMax,
    open,
    /** 关掉全部流连接（先断开，再各自关 watcher 与定时器）；之后不再接新流。 */
    closeAll() {
      closed = true;
      for (const conn of [...connections]) closeConn(conn, { destroy: true });
    },
  };
}
