// test/isolation-infra/ownerDashboardV2StreamHelpers.js
//
// 第 144 批（决定 0131 §4）：GET /api/worker/stream 的测试辅助。不是测试文件（manifest 只登记
// *.test.js），由 ownerDashboardV2Stream.test.js 导入；回放那一段导出成可以直接调的函数，Lead 在真实
// 转录上用同一个办法再跑一遍：
//
//   import { replayTranscript } from "./test/isolation-infra/ownerDashboardV2StreamHelpers.js";
//   const result = await replayTranscript("D:/runs/projects/<slug>/run_x.jsonl", { seed: 7 });
//   result.ok 逐一时为 true；否则 result.difference 指出第一处不同（下标与两边的那一行）。
//
// 这里只有"怎么起、怎么读、怎么拼、怎么比"，不含任何断言：
//   openStreamWorld     os.tmpdir() 下一个运行目录（平铺布局）+ 一个真实的看板服务（真实读模型）
//   openStream          对它开一条真实的事件流，返回可以等帧的 tap
//   httpJson            一次 GET，原样给出状态、响应头与正文
//   chunkPlan           把一份文件切成随机长度的追加块（固定随机种子，可复现）
//   replayTranscript    回放：首行先落盘 → 开流 → 其余字节按随机块"追加"进临时文件，帧实时喂给
//                       真实的页面合并逻辑（createActivityFeed）→ 与"对整份文件直接调用
//                       projectWorkerActivity 往回翻页"的结果逐一行比对
//
// 两侧用的是同一套页面合并代码（同一套 key、折叠相邻合并、updates 替换），所以比的是 Owner 最终
// 看到的那张表：流交付的一侧 vs 翻页交付的一侧。帧用页面自己的解析器解析（api.js 的
// createSseParser），字节经 TextDecoder 逐块送进去——真实连接怎么切块，它就怎么读。
//
// 什么都不写进仓库：运行目录在 os.tmpdir() 下，用完删掉。

import http from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rmrfRetry } from "../_rmrfHelper.mjs";
import { createOwnerDashboardServer } from "../../src/ownerDashboardServer.js";
import { projectWorkerActivity } from "../../src/application/ownerWorkerActivity.js";
import { activityPath, createSseParser, streamPath } from "../../src/owner-dashboard/v2/api.js";
import { createActivityFeed } from "../../src/owner-dashboard/v2/activity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库里现成的两份转录夹具（test/fixtures/ 下仅有的两份 .jsonl 转录）。 */
export const TRANSCRIPT_FIXTURES = Object.freeze([
  join(HERE, "..", "fixtures", "transcript-evidence-passed-backend-failed.jsonl"),
  join(HERE, "..", "fixtures", "transcript-legacy-evidence-backend-failed.jsonl"),
]);

/** 让已经排队的微任务跑完。 */
export const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 转录内容 → 字节：Buffer / 字符串原样，事件数组写成 LF 结尾的整行。 */
export const toBytes = (content) => (Buffer.isBuffer(content) ? content
  : typeof content === "string" ? Buffer.from(content, "utf8")
    : Buffer.from(`${content.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8"));
export const eventsOfBytes = (bytes) => bytes.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** 一条事件（信封字段权威）。 */
export function eventOf(runId, seq, type, payload = {}, { tsMs, agentId = "glm-pro" } = {}) {
  return { ...payload, type, runId, agentId, seq, ts: new Date(tsMs).toISOString() };
}

/**
 * os.tmpdir() 下的一个世界：平铺布局的运行目录（runs/<runId>.jsonl）+ 一个真实的看板服务。
 * start() 之前读模型什么都没读（与生产一致：listen 之后才开始）。`config` 是给
 * createOwnerDashboardServer 的额外注入项（测试接缝）。
 */
export function openStreamWorld({ prefix = "wao-owner-stream-", nowMs, config = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const repo = join(base, "repo");
  const runDir = join(base, "runs");
  mkdirSync(runDir, { recursive: true });
  const server = createOwnerDashboardServer({
    runDir, workspaceRoot: repo, knownAgentIds: [], env: {},
    ...(nowMs === undefined ? {} : { nowFn: () => nowMs }),
    ...config,
  });
  let address = null;
  const fileOf = (runId) => join(runDir, `${runId}.jsonl`);
  return {
    base, repo, runDir, server, token: server.token, fileOf,
    write: (runId, content) => writeFileSync(fileOf(runId), toBytes(content)),
    append: (runId, content) => appendFileSync(fileOf(runId), toBytes(content)),
    sizeOf: (runId) => statSync(fileOf(runId)).size,
    /** 真起服务（127.0.0.1 临时端口）并等首轮发布。 */
    async start() {
      address = await server.listen();
      await server.refreshNow();
      return address;
    },
    get port() { return address === null ? null : address.port; },
    /** 关服务（先断流、再关 watcher 与定时器、最后关 server）并删掉临时目录。 */
    async close() {
      try {
        await server.close();
      } finally {
        rmrfRetry(base);
      }
    },
  };
}

/** 一次 GET：状态、响应头与正文（文本；能解析成 JSON 就一并给出）。token 为 null 时不带 Authorization。 */
export function httpJson(world, path, { token = world.token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: world.port, path, method: "GET",
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(text); } catch { body = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function decode(frame) {
  try { return { id: frame.id, event: frame.event, data: JSON.parse(frame.data) }; } catch { return { ...frame }; }
}

/**
 * 对世界里的服务开一条真实的事件流。响应头到达时 resolve；之后帧陆续进 tap.frames。
 *   tap.path                  这条流请求的路径（runId / afterSeq / cursor / filter 都在上面）
 *   tap.frames                 已收到的帧 [{ id, event, data }]（data 是解析后的 JSON，解析不了就是原文）
 *   tap.onFrame                每来一帧回调一次（在它接上之前到的帧不会补发，先读 tap.frames）
 *   tap.waitFor(pred, ms)      等到 pred(frames) 为真，返回当时的帧数；超时返回 null
 *   tap.next(event, n, ms)     再等到 n 个该类型的帧（调用之后新到的）
 *   tap.first(event, ms)       至少到过一帧该类型的帧就为 true（包括调用之前已经到的）；超时 false
 *   tap.ended                  连接是否已经结束（对端关、出错或自己 close()）
 *   tap.close()                自己断开
 */
export function openStream(world, { runId, afterSeq = null, cursor = null, filter = null, token = world.token } = {}) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const waiters = [];
    const parser = createSseParser();
    const decoder = new TextDecoder();
    const path = streamPath({ runId, afterSeq, cursor, filter });
    const tap = {
      frames, path, status: null, headers: null, raw: "", ended: false, error: null, onFrame: null, onEnd: null,
      waitFor(predicate, ms = 1500) {
        if (predicate(frames)) return Promise.resolve(frames.length);
        return new Promise((done) => {
          const waiter = { predicate, done, timer: null };
          waiter.timer = setTimeout(() => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            done(null);
          }, ms);
          waiters.push(waiter);
        });
      },
      next(event, n = 1, ms = 1500) {
        const count = (list) => list.filter((frame) => frame.event === event).length;
        const had = count(frames);
        return this.waitFor((list) => count(list) >= had + n, ms);
      },
      /** At least one frame of this kind has arrived — including one that arrived before this call. */
      async first(event, ms = 4000) {
        if (frames.some((frame) => frame.event === event)) return true;
        return (await this.waitFor((list) => list.some((frame) => frame.event === event), ms)) !== null;
      },
      close() { req.destroy(); },
      get events() { return frames.map((frame) => frame.event); },
    };
    const wake = () => {
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(frames)) continue;
        const at = waiters.indexOf(waiter);
        if (at >= 0) waiters.splice(at, 1);
        clearTimeout(waiter.timer);
        waiter.done(frames.length);
      }
    };
    const finish = (error = null) => {
      if (tap.ended) return;
      tap.ended = true;
      tap.error = error;
      wake();
      if (tap.onEnd !== null) tap.onEnd();
    };
    const req = http.request({
      host: "127.0.0.1", port: world.port, method: "GET",
      path,
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), accept: "text/event-stream" },
    }, (res) => {
      tap.status = res.statusCode;
      tap.headers = res.headers;
      res.on("data", (chunk) => {
        const text = decoder.decode(chunk, { stream: true });
        tap.raw += text;
        for (const frame of parser.push(text)) {
          const decoded = decode(frame);
          frames.push(decoded);
          if (tap.onFrame !== null) tap.onFrame(decoded);
        }
        wake();
      });
      res.on("end", () => finish(null));
      res.on("error", (error) => finish(error));
      res.on("aborted", () => finish(new Error("aborted")));
      resolve(tap);
    });
    req.on("error", (error) => {
      finish(error);
      reject(error);
    });
    req.end();
  });
}

/** mulberry32：一个小而确定的伪随机数发生器。 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 把 `size` 个字节切成追加块：每块长度在 [min, max] 内（最后一块取剩下的），总和恰为 size。
 * 同一个种子给同一份切法。
 */
export function chunkPlan(size, { seed = 144, min = 1, max = 400 } = {}) {
  if (!Number.isInteger(size) || size < 0) throw new RangeError("chunkPlan: size must be a non-negative integer");
  if (!(Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min)) throw new RangeError("chunkPlan: need 1 <= min <= max");
  const random = seededRandom(seed);
  const plan = [];
  let left = size;
  while (left > 0) {
    const length = Math.min(left, min + Math.floor(random() * (max - min + 1)));
    plan.push(length);
    left -= length;
  }
  return plan;
}

/** 第一处不同：下标与两边的值；完全相同时为 null。 */
export function firstDifference(left, right) {
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    if (JSON.stringify(left[i]) !== JSON.stringify(right[i])) return { at: i, left: left[i], right: right[i] };
  }
  return null;
}

/** 一行的人读摘要（只给差异报告用）。 */
export function describeRow(row) {
  if (row === undefined) return "<none>";
  const range = row.row === "event" ? `${row.code ?? ""} #${row.seq ?? "?"}` : `${row.code ?? row.row} ${row.fromSeq ?? "?"}–${row.toSeq ?? "?"}`;
  return `${range} ×${row.count ?? 1} ${row.summary ?? row.status ?? ""}`.trim();
}

/**
 * 回放一份转录并比对（见文件头）。
 *
 * @param {string|Buffer} source — 一份完整的 JSONL 转录
 * @param {object} [options]
 * @param {number} [options.seed=144] — 追加块的随机种子
 * @param {number} [options.minChunk=1] — 追加块最短多少字节
 * @param {number} [options.maxChunk=400] — 追加块最长多少字节
 * @param {number} [options.pauseMs=4] — 两块之间停多久（0 = 一口气写完，制造"一次醒来新增很多"）
 * @param {"all"|"messages"|"commands"|"errors"} [options.filter="all"]
 * @param {number} [options.quietMs=1500] — 转录不以终态结尾时，最后一次追加之后多久没有新帧算写完
 * @param {object} [options.world] — 复用外面起好并已 start() 的世界（不给就自己起、用完删）
 * @returns {Promise<{ok: boolean, source: string, runId: string, bytes: number, chunks: number,
 *   frames: {rows: number, update: number, reset: number, end: number},
 *   streamRows: number, referenceRows: number, difference: {at: number, stream: string, reference: string}|null}>}
 */
export async function replayTranscript(source, {
  seed = 144, minChunk = 1, maxChunk = 400, pauseMs = 4, filter = "all", quietMs = 1500, world = null,
} = {}) {
  const bytes = Buffer.isBuffer(source) ? source : readFileSync(source);
  const sourceName = Buffer.isBuffer(source) ? "<bytes>" : source;
  const events = eventsOfBytes(bytes);
  const runId = events[0].runId;
  const endsTerminal = projectWorkerActivity({ runId, events, env: {}, filter }).terminal;
  const owned = world === null;
  const w = world ?? openStreamWorld();
  try {
    // 首行先落盘（读模型要求至少一行完整的事件），其余的稍后按块追加。
    const firstEnd = bytes.indexOf(0x0a) + 1;
    w.write(runId, bytes.subarray(0, firstEnd));
    if (owned) await w.start();
    else await w.server.refreshNow();

    // 流这一侧：第一页走真实接口，帧从真实连接上实时喂给真实的页面合并逻辑。
    const page = async (query) => {
      const got = await httpJson(w, activityPath(query));
      return got.status === 200 && got.body !== null && Array.isArray(got.body.rows)
        ? { ok: true, body: got.body }
        : { ok: false, reason: "server" };
    };
    const stream = { tap: null, ended: false };
    const opened = new Promise((resolve, reject) => {
      stream.resolveOpen = resolve;
      // 流一直接不上时不要吊死：5 秒（真实时间）后如实报错。
      const timer = setTimeout(() => reject(new Error("replay: the stream did not open within 15 s")), 15000);
      if (typeof timer.unref === "function") timer.unref();
    });
    const feed = createActivityFeed({
      fetchPage: page,
      fetchFull: async () => ({ ok: false, reason: "notFound" }),
      fetchStream: (query) => new Promise((resolve) => {
        const abort = () => stream.tap?.close();
        if (query.signal?.aborted) {
          resolve({ ok: false, reason: "aborted" });
          return;
        }
        query.signal?.addEventListener("abort", abort, { once: true });
        openStream(w, { runId: query.runId, afterSeq: query.afterSeq ?? null, cursor: query.cursor ?? null, filter: query.filter })
          .then((tap) => {
            stream.tap = tap;
            stream.resolveOpen(tap);
            if (query.signal?.aborted) tap.close();
            for (const frame of tap.frames) query.onFrame(frame);
            tap.onFrame = query.onFrame;
            tap.onEnd = () => {
              query.signal?.removeEventListener("abort", abort);
              resolve({ ok: true, done: true });
            };
          })
          .catch((error) => {
            stream.resolveOpen(Promise.reject(error));
            resolve({ ok: false, reason: "network" });
          });
      }),
    });
    feed.open(runId);
    // 筛选要真的落到流这一侧：feed 的缺省筛选是 all，不调 setFilter 的话回放的永远是 all。
    if (filter !== "all") feed.setFilter(filter);
    await settle();
    await feed.poll(); // 与页面一致：第一页到手后开始接流
    const tap = await opened; // 响应头到了才算接上
    const streamFilter = new URLSearchParams(tap.path.split("?")[1] ?? "").get("filter");
    if (streamFilter !== filter) throw new Error(`replay: the stream was opened with filter ${streamFilter}, not ${filter}`);

    // 其余字节按随机块追加。
    const plan = chunkPlan(bytes.length - firstEnd, { seed, min: minChunk, max: maxChunk });
    let at = firstEnd;
    for (const length of plan) {
      w.append(runId, bytes.subarray(at, at + length));
      at += length;
      if (pauseMs > 0) await sleep(pauseMs);
    }
    // 写完的信号：以终态结尾的转录等 end 帧；否则等一段安静期（要比服务端 1 秒兜底轮询长）。
    if (endsTerminal) {
      const done = await tap.waitFor((list) => list.some((frame) => frame.event === "end" || frame.event === "reset"), 15000);
      if (done === null) throw new Error("replay: no end frame within 15 s after the last append");
    } else {
      for (;;) {
        const before = tap.frames.length;
        if (await tap.waitFor((list) => list.length > before, quietMs) === null) break;
      }
    }
    await settle();
    tap.close();
    await settle();

    // 对照这一侧：对完整文件直接调用 projectWorkerActivity，从最新一页往回翻到头，走同一个页面合并逻辑。
    const reference = createActivityFeed({
      fetchPage: (query) => Promise.resolve({ ok: true, body: projectWorkerActivity({ runId, events, env: {}, ...query }) }),
      fetchFull: async () => ({ ok: false, reason: "notFound" }),
    });
    reference.open(runId);
    if (filter !== "all") reference.setFilter(filter);
    await settle();
    for (let guard = 0; reference.canLoadOlder() && guard < 10_000; guard += 1) {
      reference.loadOlder();
      await settle();
    }
    const shown = feed.get();
    const expected = reference.get();
    const difference = firstDifference(shown.rows, expected.rows);
    const counts = { rows: 0, update: 0, reset: 0, end: 0 };
    for (const frame of tap.frames) if (Object.hasOwn(counts, frame.event)) counts[frame.event] += 1;
    return {
      ok: difference === null && shown.total === expected.total && shown.terminal === expected.terminal,
      source: sourceName, runId, bytes: bytes.length, chunks: plan.length, filter,
      frames: counts,
      streamRows: shown.rows.length, referenceRows: expected.rows.length,
      streamTotal: shown.total, referenceTotal: expected.total, terminal: shown.terminal,
      difference: difference === null ? null : {
        at: difference.at, stream: describeRow(difference.left), reference: describeRow(difference.right),
        // 原始的两行也带上：光看摘要看不出是哪个字段不同。
        streamRow: difference.left ?? null, referenceRow: difference.right ?? null,
      },
    };
  } finally {
    if (owned) await w.close();
  }
}
