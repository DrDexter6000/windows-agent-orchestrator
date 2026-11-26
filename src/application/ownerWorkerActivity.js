// src/application/ownerWorkerActivity.js
//
// 第 141c 批（决定 0131 §3，实现计划 A3）：Owner 看板 worker 侧栏 Activity 页签的两个只读投影——
//   - projectWorkerActivity：GET /api/worker/activity。最近 limit 条时间线事件，或某个 seq 之前的
//     一页（向上翻页）；
//   - projectWorkerEvent：GET /api/worker/event。按 runId#seq 取某条事件某个部分的全文，有界分页
//     （"Open full"）。
// 只读：不追加转录、不写盘、不改状态，也不做语义判断。
//
// 与 Lead 侧 run_activity 分开：Lead 侧的游标、路径、输出契约（runActivityProjection.js 的七类
// 活动条目、冻结前缀游标、尾部摘录）一概不动；这里是 Owner 专用的另起一份投影，只复用底层的
// 安全工具函数，不复用它的条目与游标。
//
// 文本处理（唯一出口链，与第 141 批 ownerWorkerDetail 同一条）：精确值 + 形状脱敏 → 绝对路径折成
// `…/末段`（foldAbsolutePaths；同时把 CRLF / CR 归一成 LF，否则 Windows 输出的每行都带一个替换符，
// 总行数也不对）→ 清控制字符（LF/TAB 保留）→ 限长。脱敏与折路径都作用在完整文本上、先于任何截取：
// 头尾行、摘要、全文分页都从这份已处理的文本里取，所以跨在行、页边界上的秘密也先被替换。
// 结构化的错误详情（run.error.detail 是对象）先逐个字符串（键也算）脱敏、再序列化——序列化会把
// 值里的引号与反斜杠转义，精确匹配随之失效，所以不能反过来。遍历有上界（深度、节点数、每层条目数、
// 总字数），任何一处裁剪都标在列表行的 truncated 上，全文末尾加固定的一句 OWNER_DETAIL_TRUNCATED_NOTE。
// 路径字段（写文件）另走 displayPath：先按工作树权威转成相对路径，工作树外或判不清给
// [path_withheld]，判定用 runScopeObservation.js 的 deriveRelativePath（段边界、Windows 大小写折叠）；
// Windows 盘符相对路径（`C:foo`）的基准目录从转录里证明不了，这里先判掉；超过路径长度上限的给
// [path_withheld]，不静默截成指向别处的路径。隔离违规事件照 diagnosis.js 的共用投影
// （isolationViolationDetail），不另写口径。
//
// 单请求工作量有界：列表行只需要头尾各 20 行与总行数。原文不超过 OWNER_ACTIVITY_FULL_ALWAYS_MAX_CHARS
// 或在本次请求的原文预算（OWNER_ACTIVITY_REQUEST_RAW_BUDGET_CHARS）内、且不超过
// OWNER_ACTIVITY_RAW_MAX_CHARS 时整段处理；否则只处理开头与结尾两段窗口：每段取
// OWNER_ACTIVITY_WINDOW_CHARS + OWNER_ACTIVITY_WINDOW_MARGIN_CHARS，脱敏、折路径、清洗之后再截回
// OWNER_ACTIVITY_WINDOW_CHARS（离原文截点最远的那一端保留，截点这一端靠近原文边缘的一小段连同可能
// 被切半的秘密一起丢掉）。总行数直接在原文上数换行；这一行标 truncated。头尾两个窗口取到的原文范围
// 重叠（或有一端已取到整段）时按整段处理一次再取头尾，不重复显示同一行；窗口范围不重叠时，窗口处理前后
// 行终止符个数一致才算得准"省略了多少行"，否则（脱敏把跨行的秘密收成一行）omittedLines 给 null。
// /api/worker/event 取全文，处理过的全文放进有界缓存（createFullTextCache：每条记录另计固定开销，
// 总成本与条目数任一超出就按最近最少使用淘汰；键里带转录身份，转录变了就失效），同一事件翻页不重算。
//
// 事件的类型码（闭集 OWNER_ACTIVITY_CODES）与折叠：
//   MSG 助手消息 · CMD 命令 · OUT 命令输出 / 工具结果 · TOOL 工具调用 · WRITE 写文件 ·
//   STATE 状态变化 · RT 运行时活动 · ERR 错误（run.error 与隔离违规）。
// 不在这个集合里的转录事件（控制面记账、thinking、纠正、信封类事实、没有文字的消息……）不进时间线，
// 但它们占着 seq，所以不会被当成缺失。连续的 RT（中间只隔着时间线之外的事件）折成一行，带原始
// seq 区间、条数与最后一种运行时状态；事件号冲突的 RT 不折（各自一行），没有事件号的 RT 只和同样没有
// 事件号的折（区间为 null），缺口行打断折叠——fromSeq / toSeq / count 与实际吸收的事件一致。
//
// 三种"看不到"：被 filter 筛掉的（hidden.filtered）、被折叠的（fold 行；hidden.folded）、真的缺失
// 的（gap 行）。时间线之外的事件另记 hidden.unlisted。缺口按"有事件占用的号"判：转录里出现过的
// 全部合法事件号（不论状态）排序去重，相邻两个号之间空着的区间就是缺口（`1,3,3,5,5` 报 #2、#4）；
// 冲突不挡缺口，冲突状态另行保留在事件行上。缺口行排在上界号第一次出现的那条事件之前。
//
// seq 的真实性：seq 是转录里写的真实事件号，合法范围 1 … OWNER_SEQ_MAX（与路由的九位十进制同一个界），
// 范围外的按没有处理。seqState = ok（唯一、按数组顺序递增）/ missing（旧档没有事件号，seq 为 null）/
// conflict（重复或倒退，seq 照写入值给）。只有 ok 的事件能被 afterSeq、beforeSeq 与 /api/worker/event 寻址。
//
// 翻页按数组顺序切：beforeSeq 取"第一个 seq ≥ beforeSeq 的 ok 事件"之前的事件；afterSeq 是下界
// （只取 seq 大于它的 ok 事件），可与 beforeSeq 同用，取 (afterSeq, beforeSeq) 内最新的一页。页与页
// 首尾相接，不重不漏；range 覆盖页内所有带号事件（包括被筛选 / 未上时间线的），客户端用它判断游标
// 是否接上。limit 数的是"单位"：要显示的时间线事件与缺口行各算一个（折叠成一行的运行时活动按吞下的
// 事件数算）。页的起点必须落在 ok 事件上（翻页游标才有号可用）：窗口起点不是 ok 事件时先往前（更早）
// 找最近的 ok 事件当起点；含 gap 的页不得多出 limit（多出的单位留给上一页），只有整段无号、
// 没有 gap 的页可以扩到 OWNER_ACTIVITY_PAGE_MAX；往前
// 找不到或太远就往后找最近的 ok 事件（页比 limit 小）；两头都没有 ok 事件时：窗口之前全是没有
// 事件号的事件，页一直取到最早（older.available=false，older.reason="unnumbered"）；这一段本身超过
// OWNER_ACTIVITY_PAGE_MAX 时只给最新的 PAGE_MAX 个单位并标 older.reason="capped"（被跳过的事件在
// 页外，older.beforeSeq 只在更早处还有 ok 事件时给，指向它）。
//
// 缺口/预算：gap 行也是一个单位，计入 limit。页首（afterSeq 之后、lower 之前）的缺口在本页预算还
// 容得下时放在页首，否则留给上一页（older 指向 lower 的 ok 事件，下一请求返回这条 gap）。range
// 覆盖本页返回的每一行：缺口、冲突号行、折叠区间和隐藏事件都算。双游标区间只有缺口时返回 gap 页，
// 不返回空页；已作为冲突行返回的 seq 不会再被 gap 覆盖。
//
// 交叉事件更新：命令行本身在页的 seq 之前，但它的退出码来自页里的 tool_result；updates 只带这种
// 已经显示过的行的新版本，不进入 rows/range，也不影响条数与覆盖范围。
//
// 增删行：file_written 事件本身不带行数，目前没有任何后端给出绑定的增删行观测，所以 WRITE 行的
// added / deleted 一律 null（未知）。交付层面的 numstat 在 /api/worker 的交付物里（系统观测）。
//
// 架构契约：不 import src/commands/*、src/mcp/*、MCP SDK 或 zod；只读。

import { createSecretRedactor, redactSecretShapes } from "../secretRedaction.js";
import { boundReportScope } from "../metrics.js";
import { RUN_STATES, STATE_CHANGE_REASONS, TERMINAL_STATES, findLatestBound, findState } from "../transcript.js";
import { EXIT_CODE_INFERENCE_PROVEN_BACKENDS, withInferredCommandExitCode } from "../scorecard.js";
import { RUNTIME_ACTIVITY_STATUSES } from "../runEvent.js";
import { isolationViolationDetail } from "../diagnosis.js";
import { foldAbsolutePaths } from "./ownerReadModel.js";
import { OWNER_PATH_MAX_CHARS, OWNER_PATH_WITHHELD, displayPath, isolationBlock, safeBody } from "./ownerWorkerDetail.js";
import { TOOL_DETAIL_KEYS, outputText, safeSliceUtf16 } from "./runActivityProjection.js";
import { boundWorktreePath, deriveRelativePath } from "./runScopeObservation.js";

/** 类型码（闭集）。 */
export const OWNER_ACTIVITY_CODES = Object.freeze(["MSG", "CMD", "OUT", "TOOL", "WRITE", "STATE", "RT", "ERR"]);
/** filter 取值（闭集）。 */
export const OWNER_ACTIVITY_FILTERS = Object.freeze(["all", "messages", "commands", "errors"]);
/** 事件号状态（闭集）。 */
export const OWNER_SEQ_STATES = Object.freeze(["ok", "missing", "conflict"]);
/** older.reason（闭集；没有特殊情况时为 null）。 */
export const OWNER_OLDER_REASONS = Object.freeze(["unnumbered", "capped"]);
/** /api/worker/event 能取的部分（闭集）；每类事件只有一个：MSG→message、CMD→command、OUT→output、ERR→error。 */
export const OWNER_EVENT_PARTS = Object.freeze(["command", "output", "message", "error"]);

/** 合法事件号的上界（九位十进制，与路由 /api/worker/activity 的 afterSeq、beforeSeq、/api/worker/event 的 seq 同一个界）。 */
export const OWNER_SEQ_MAX = 999_999_999;
/** 一页至多返回多少个单位（时间线事件与缺口行）——缺省与上限相同。 */
export const OWNER_ACTIVITY_LIMIT_DEFAULT = 200;
export const OWNER_ACTIVITY_LIMIT_MAX = 200;
/** 为了让页起点落在 ok 事件上，一页最多可以扩到多少个单位。 */
export const OWNER_ACTIVITY_PAGE_MAX = 1000;
/** 一页最多带出多少条“更早命令行被补上退出码”的 updates（同时受 limit 与本页 rows 预算约束）。 */
export const OWNER_ACTIVITY_UPDATES_MAX = 200;
/** 助手消息给前几行。 */
export const OWNER_MESSAGE_HEAD_LINES = 6;
/** 命令输出 / 工具结果给头几行、尾几行。 */
export const OWNER_OUTPUT_HEAD_LINES = 20;
export const OWNER_OUTPUT_TAIL_LINES = 20;
/** 单行（含摘要）的字符上限；超出的行在末尾写 …，行标 truncated。 */
export const OWNER_ACTIVITY_LINE_MAX_CHARS = 400;
/** 角色、工具名、阶段、时间戳这类短标签的字符上限。 */
export const OWNER_ACTIVITY_LABEL_MAX_CHARS = 64;
/** 错误全文在列表行里的字符上限（更长的取 /api/worker/event?part=error）。 */
export const OWNER_ERROR_MAX_CHARS = 4000;
/** /api/worker/event 每页的字节上限（UTF-8，已脱敏清洗后的文本；页边界不劈开多字节字符）。 */
export const OWNER_EVENT_PAGE_MAX_BYTES = 32 * 1024;

/** 列表行整段处理的单条原文上限（字符）；更长的只处理头尾窗口。 */
export const OWNER_ACTIVITY_RAW_MAX_CHARS = 1024 * 1024;
/** 一次请求里整段处理的原文总预算（字符）；用完以后更长的原文也只处理窗口。 */
export const OWNER_ACTIVITY_REQUEST_RAW_BUDGET_CHARS = 8 * 1024 * 1024;
/**
 * 窗口留给列表行的字符数（脱敏清洗之后）。头 20 行 × 每行至多 400 字 = 8000，取 8 KiB。
 * 窗口多取的余量：跨在窗口截点上的秘密落在余量里，整段被替换之后才截回上限。
 */
export const OWNER_ACTIVITY_WINDOW_CHARS = 8 * 1024;
export const OWNER_ACTIVITY_WINDOW_MARGIN_CHARS = 8 * 1024;
/**
 * /api/worker/event 处理过的全文缓存的上限：总字节与条目数，任一超出就按最近最少使用淘汰。每条记录除了正文
 * 字节另计一个固定开销（键、缓冲区对象、页边界数组……），所以零字节正文的条目也占名额，不会无限累积。
 */
export const OWNER_EVENT_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const OWNER_EVENT_CACHE_MAX_ENTRIES = 512;
export const OWNER_EVENT_CACHE_ENTRY_OVERHEAD_BYTES = 256;
/** 结构化错误详情被裁剪（字段 / 元素 / 层数 / 字数超出遍历上界）时，全文末尾加的固定一句。 */
export const OWNER_DETAIL_TRUNCATED_NOTE = "[detail truncated: some fields or nesting levels were omitted]";

const WINDOW_SPAN = OWNER_ACTIVITY_WINDOW_CHARS + OWNER_ACTIVITY_WINDOW_MARGIN_CHARS;
/** 处理后离原文截边这么近的一段不可信（可能是被切半的秘密），窗口处理完要丢掉。 */
const WINDOW_GUARD_CHARS = OWNER_ACTIVITY_WINDOW_MARGIN_CHARS / 2;
/** 不超过这个长度的原文一律整段处理（也保证头尾两个窗口不重叠）。 */
export const OWNER_ACTIVITY_FULL_ALWAYS_MAX_CHARS = 2 * WINDOW_SPAN;

/** 结构化错误详情序列化前的遍历上界。 */
const DETAIL_MAX_DEPTH = 6;
const DETAIL_MAX_NODES = 500;
const DETAIL_MAX_ENTRIES = 200;

const PART_OF_CODE = Object.freeze({ MSG: "message", CMD: "command", OUT: "output", ERR: "error" });
const ROLE_MAX_CHARS = 32;
/** Windows 盘符相对路径（`C:foo`、`C:`）：盘符后面不是分隔符。 */
const DRIVE_RELATIVE_RE = /^[A-Za-z]:(?![\\/])/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const memberOf = (set, value) => (typeof value === "string" && set.includes(value) ? value : null);
const validSeq = (value) => Number.isSafeInteger(value) && value >= 1 && value <= OWNER_SEQ_MAX;

// ===== 文本 =====

/** 脱敏与折路径之后、清控制字符之前的显示归一：CRLF / CR → LF。 */
const foldForDisplay = (text) => foldAbsolutePaths(text).replace(/\r\n?/g, "\n");

/** 单行限长：超出就在末尾写 …（不劈开代理对），总长不超过 max。 */
function clip(text, max) {
  return text.length <= max ? text : `${safeSliceUtf16(text, 0, max - 1)}…`;
}

function linesOf(safe) {
  if (safe.length === 0) return [];
  const lines = safe.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // 末尾换行不算多一行
  return lines;
}

/** 行终止符个数：LF、CRLF、单独的 CR 各算一个。不做任何文本处理。 */
function terminatorsIn(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      count += 1;
    } else if (c === 13) {
      count += 1;
      if (text.charCodeAt(i + 1) === 10) i += 1;
    }
  }
  return count;
}

/** 原文的行数（末尾没有终止符时最后一行也算）。 */
function countLines(raw) {
  const n = raw.length;
  if (n === 0) return 0;
  const last = raw.charCodeAt(n - 1);
  return terminatorsIn(raw) + (last === 10 || last === 13 ? 0 : 1);
}

/** 一组行限长；任何一行被限长就标 clipped。 */
function fitLines(lines) {
  let clipped = false;
  const fitted = lines.map((line) => {
    if (line.length > OWNER_ACTIVITY_LINE_MAX_CHARS) clipped = true;
    return clip(line, OWNER_ACTIVITY_LINE_MAX_CHARS);
  });
  return { fitted, clipped };
}

/**
 * 头尾摘录的结果形状：body = 头 / 尾行 + 总行数 + 省略行数；first = 第一个非空行（未限长）；
 * summary = first 限长；truncated = 有行没给全（或省略多少算不准）或有行被限长；lineClipped = 摘要行本身被限长。
 * omittedLines 缺省按 总行数 − 头尾显示的行数 算；调用方算不准时传 null（窗口里的脱敏改变了行数，
 * 显示的行和原文的行对不上），不给一个错的数。
 */
function blockOf({ head, tail, totalLines, forceTruncated, omittedLines }) {
  const shownHead = fitLines(head);
  const shownTail = fitLines(tail);
  const first = head.find((line) => line.trim() !== "") ?? "";
  const omitted = omittedLines === undefined ? Math.max(0, totalLines - head.length - tail.length) : omittedLines;
  return {
    body: { head: shownHead.fitted, tail: shownTail.fitted, totalLines, omittedLines: omitted },
    first,
    summary: clip(first, OWNER_ACTIVITY_LINE_MAX_CHARS),
    lineClipped: first.length > OWNER_ACTIVITY_LINE_MAX_CHARS,
    truncated: forceTruncated || omitted === null || omitted > 0 || shownHead.clipped || shownTail.clipped,
  };
}

/**
 * 一份已处理的完整文本的头尾摘录：头 headN 行 + 尾 tailN 行 + 总行数。总行数是全文的行数；
 * 尾部不与头重叠（不足 headN + tailN 行时尾部是头之后剩下的全部行，没有空洞）。
 */
function textBlock(safe, headN, tailN) {
  const all = linesOf(safe);
  const total = all.length;
  return blockOf({
    head: all.slice(0, headN),
    tail: tailN > 0 && total > headN ? all.slice(Math.max(headN, total - tailN)) : [],
    totalLines: total,
    forceTruncated: false,
  });
}

/** 这条原文这次请求里整段处理吗（整段处理会从请求预算里扣）。 */
function processInFull(raw, view) {
  if (raw.length <= OWNER_ACTIVITY_FULL_ALWAYS_MAX_CHARS) return true;
  if (raw.length <= OWNER_ACTIVITY_RAW_MAX_CHARS && raw.length <= view.budget.left) {
    view.budget.left -= raw.length;
    return true;
  }
  return false;
}

/**
 * 超长原文的一端窗口：取这一端的 WINDOW_SPAN 个字符，脱敏 → 折路径 → 清洗，再截回 WINDOW_CHARS
 * （head 保留开头，tail 保留结尾——离原文截边最远的一端）。处理后文本太短（折路径把它压缩了）、
 * 截边附近那一小段（WINDOW_GUARD_CHARS）扣掉以后不够 WINDOW_CHARS 时，把窗口放大四倍重来，
 * 直到够用、取到整段原文或到整段处理的上限；每次尝试都从请求预算里扣，预算用完不再重来。
 * 返回 { text 截回后的窗口文本, span 这一端最终取的原文字符数, whole 取到了整段原文, processed 这一次
 * 处理出来的文本（whole 时就是整段）, stable 原文窗口与处理后文本的行终止符个数相同 }——stable 才说明处理
 * 没有改变行数，窗口里显示的行和原文的行一一对得上。
 */
function windowText(raw, side, view) {
  let span = WINDOW_SPAN;
  for (;;) {
    const whole = span >= raw.length;
    const slice = whole ? raw : (side === "head" ? raw.slice(0, span) : raw.slice(raw.length - span));
    view.budget.left -= slice.length;
    const processed = view.process(slice);
    const usable = whole ? processed.length : processed.length - WINDOW_GUARD_CHARS;
    if (usable >= OWNER_ACTIVITY_WINDOW_CHARS || whole || span >= OWNER_ACTIVITY_RAW_MAX_CHARS || view.budget.left <= 0) {
      const keep = Math.max(0, Math.min(OWNER_ACTIVITY_WINDOW_CHARS, usable));
      let text;
      if (side === "head") {
        text = safeSliceUtf16(processed, 0, keep);
      } else {
        let from = processed.length - keep;
        const first = processed.charCodeAt(from);
        if (first >= 0xdc00 && first <= 0xdfff) from += 1; // 不从代理对的后半个开始
        text = processed.slice(from);
      }
      return { text, span, whole, processed, stable: terminatorsIn(slice) === terminatorsIn(processed) };
    }
    span = Math.min(span * 4, raw.length, OWNER_ACTIVITY_RAW_MAX_CHARS);
  }
}

/**
 * 超长原文的头尾摘录：只处理两端窗口，总行数在原文上数。标 truncated。
 * 两端取到的原文范围重叠（或其中一端已经取到整段原文）时，头尾窗口里会有同一行——按整段处理一次再取头尾，
 * 行不重复、省略行数精确。窗口范围不重叠时，头尾显示的是原文里不同的行（头窗口最后一行可能是被截的半行，
 * 尾窗口的第一行是半行、丢掉），省略行数 = 总行数 − 显示的行数；窗口处理改变了行数（脱敏把跨行的秘密收成
 * 一行）时显示的行和原文的行对不上，省略多少算不准，给 null。
 */
function windowBlock(raw, headN, tailN, view) {
  const head = windowText(raw, "head", view);
  const tail = tailN > 0 ? windowText(raw, "tail", view) : null;
  if (head.whole || (tail !== null && (tail.whole || head.span + tail.span >= raw.length))) {
    let processed = head.whole ? head.processed : tail?.whole ? tail.processed : null;
    if (processed === null) {
      view.budget.left -= raw.length;
      processed = view.process(raw);
    }
    return textBlock(processed, headN, tailN);
  }
  const headLines = linesOf(head.text).slice(0, headN);
  let tailLines = [];
  if (tail !== null) {
    const lines = linesOf(tail.text);
    lines.shift(); // 窗口从原文中间起，第一行可能是半行
    tailLines = lines.length > tailN ? lines.slice(lines.length - tailN) : lines;
  }
  const total = countLines(raw);
  const stable = head.stable && (tail === null || tail.stable);
  return blockOf({
    head: headLines,
    tail: tailLines,
    totalLines: total,
    forceTruncated: true,
    omittedLines: stable ? Math.max(0, total - headLines.length - tailLines.length) : null,
  });
}

/** 列表行的文本摘录（整段或窗口，见文件头）。raw 不是字符串当空。 */
function excerptOf(raw, headN, tailN, view) {
  if (typeof raw !== "string" || raw.length === 0) return textBlock("", headN, tailN);
  return processInFull(raw, view)
    ? textBlock(view.process(raw), headN, tailN)
    : windowBlock(raw, headN, tailN, view);
}

/**
 * 有字符上限的文本（错误行）：整段处理时给前 max 个字符与全文字符数；窗口模式只给开头的 max 个字符，
 * totalChars 为 null（没有整段处理，不知道），标 truncated。first = 第一个非空行（未限长）。
 */
function boundedOf(raw, max, view) {
  if (raw.length === 0) return { text: "", totalChars: 0, truncated: false, first: "" };
  const full = processInFull(raw, view);
  const safe = full ? view.process(raw) : windowText(raw, "head", view).text;
  const first = linesOf(safe).find((line) => line.trim() !== "") ?? "";
  return {
    text: safeSliceUtf16(safe, 0, max),
    totalChars: full ? safe.length : null,
    truncated: !full || safe.length > max,
    first,
  };
}

/** 消息正文：文本块按序拼接（没有文字的消息给空串）。 */
function messageText(event) {
  const parts = Array.isArray(event.parts) ? event.parts : [];
  return parts
    .filter((part) => isObject(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0)
    .map((part) => part.text)
    .join("\n");
}

/**
 * 结构化错误详情的序列化：先把对象里每个字符串（键也算）逐个脱敏（精确值 + 形状），再 JSON.stringify。
 * 顺序不能反：序列化会把值里的引号与反斜杠转义，转义以后环境里的精确秘密值匹配不上。遍历有深度、
 * 节点数、每层条目数与总字符数的上界，超出的部分被裁掉或写成 […]——任何一处裁剪都记在 truncated 上，
 * 调用方据此标行、在全文末尾加固定的省略说明，不能静默丢。
 */
function redactedDetailJson(detail, view) {
  const state = { nodes: 0, chars: 0, truncated: false };
  const clean = (text) => {
    if (state.chars > OWNER_ACTIVITY_RAW_MAX_CHARS) {
      state.truncated = true;
      return "[…]";
    }
    state.chars += text.length;
    return redactSecretShapes(view.redactor.redactString(text));
  };
  const capped = (list) => {
    if (list.length > DETAIL_MAX_ENTRIES) state.truncated = true;
    return list.slice(0, DETAIL_MAX_ENTRIES);
  };
  const walk = (value, depth) => {
    if (typeof value === "string") return clean(value);
    if (value === null || typeof value !== "object") return value;
    state.nodes += 1;
    if (depth >= DETAIL_MAX_DEPTH || state.nodes > DETAIL_MAX_NODES) {
      state.truncated = true;
      return "[…]";
    }
    if (Array.isArray(value)) return capped(value).map((item) => walk(item, depth + 1));
    const out = {};
    for (const [key, item] of capped(Object.entries(value))) out[clean(key)] = walk(item, depth + 1);
    return out;
  };
  try {
    const json = JSON.stringify(walk(detail, 0));
    return { json, truncated: state.truncated };
  } catch {
    return { json: "", truncated: false };
  }
}

/**
 * run.error 的原文：优先 error / message / detail / reason 里第一个非空字符串；对象形的 detail 先脱敏再取 JSON
 * （被裁剪时末尾另起一行加 OWNER_DETAIL_TRUNCATED_NOTE）；再退到闭集码。truncated = 详情被裁剪过。
 */
function errorTextOf(event, view) {
  for (const key of ["error", "message", "detail", "reason"]) {
    if (typeof event[key] === "string" && event[key].length > 0) return { raw: event[key], truncated: false };
  }
  if (isObject(event.detail) || Array.isArray(event.detail)) {
    const { json, truncated } = redactedDetailJson(event.detail, view);
    return { raw: truncated ? `${json}\n${OWNER_DETAIL_TRUNCATED_NOTE}` : json, truncated };
  }
  const code = [event.code, event.deliveryCode, event.errorClass].find((value) => typeof value === "string" && value.length > 0);
  return { raw: code ?? "", truncated: false };
}

// ===== 事件号与分类 =====

/**
 * 逐条标事件号状态。ok = 合法事件号（1 … OWNER_SEQ_MAX）、全转录唯一、比之前见过的最大号还大；
 * 重复与倒退标 conflict；没有（或不合法）标 missing。values = 转录里出现过的全部合法事件号（不论
 * 状态，升序去重），firstAt = 每个号第一次出现的数组位置——缺口按它们算。
 */
function numberEvents(scope) {
  const counts = new Map();
  const firstAt = new Map();
  scope.forEach((event, index) => {
    if (!validSeq(event.seq)) return;
    counts.set(event.seq, (counts.get(event.seq) ?? 0) + 1);
    if (!firstAt.has(event.seq)) firstAt.set(event.seq, index);
  });
  let max = 0;
  const numbered = scope.map((event) => {
    if (!validSeq(event.seq)) return { event, seq: null, seqState: "missing" };
    const conflict = counts.get(event.seq) > 1 || event.seq <= max;
    if (event.seq > max) max = event.seq;
    return { event, seq: event.seq, seqState: conflict ? "conflict" : "ok" };
  });
  return { numbered, values: [...counts.keys()].sort((a, b) => a - b), firstAt };
}

/**
 * 缺口：相邻两个出现过的事件号之间空着的区间。位置 = 上界号第一次出现的数组位置（缺口行排在那条
 * 事件之前）；位置 0 之前没有地方放，不报。
 */
function gapsOf(values, firstAt) {
  const gapAt = new Map();
  for (let k = 1; k < values.length; k += 1) {
    const lower = values[k - 1];
    const upper = values[k];
    const at = firstAt.get(upper);
    if (upper - lower > 1 && at > 0) gapAt.set(at, { fromSeq: lower + 1, toSeq: upper - 1 });
  }
  return gapAt;
}

/** 一条事件进时间线时的类型；不进时间线给 null。 */
function classify(event, commandIds) {
  if (event.type === "run.event") {
    switch (event.kind) {
      case "message": return messageText(event).trim().length === 0 ? null : { code: "MSG" };
      case "command": return { code: "CMD" };
      case "tool_use": return { code: "TOOL" };
      case "tool_result": return { code: "OUT", outputOf: commandIds.has(event.tool) ? "command" : "tool", isError: event.isError === true };
      case "file_written": return { code: "WRITE" };
      case "runtime_activity": return { code: "RT" };
      default: return null;
    }
  }
  if (event.type === "run.state_change") return RUN_STATES.includes(event.to) ? { code: "STATE" } : null;
  if (event.type === "run.error" || event.type === "run.isolation_violation") return { code: "ERR" };
  return null;
}

/** filter 的口径：messages = MSG；commands = CMD 与命令的输出；errors = ERR 与出错的输出。 */
function accepts(filter, cls) {
  switch (filter) {
    case "messages": return cls.code === "MSG";
    case "commands": return cls.code === "CMD" || (cls.code === "OUT" && cls.outputOf === "command");
    case "errors": return cls.code === "ERR" || (cls.code === "OUT" && cls.isError);
    default: return true;
  }
}

/**
 * 这条运行的事件视图：绑定本 runId 的事件（boundReportScope，与读模型同口径；旧档没有信封时退回
 * 全部对象事件）、事件号状态、缺口、分类、以及投影要用的转录事实（状态、工作树权威、命令结果、后端）。
 * onProcessText 是测试接缝：每次把多长的原文交给脱敏管道就回调一次（字符数）。
 */
function prepare({ runId, events, env, onProcessText }) {
  const list = Array.isArray(events) ? events : [];
  const scope = boundReportScope(list, runId) ?? list.filter(isObject);
  const { numbered, values, firstAt } = numberEvents(scope);
  const commandIds = new Set();
  const resultByTool = new Map();
  for (const event of scope) {
    if (event.type !== "run.event") continue;
    if (event.kind === "command" && typeof event.toolCallId === "string") commandIds.add(event.toolCallId);
    else if (event.kind === "tool_result" && typeof event.tool === "string" && !resultByTool.has(event.tool)) resultByTool.set(event.tool, event);
  }
  const redactor = createSecretRedactor(env ?? process.env);
  const items = numbered.map((entry) => ({ ...entry, cls: classify(entry.event, commandIds) }));
  const commandByTool = new Map();
  for (const item of items) {
    if (item.event.type === "run.event" && item.event.kind === "command" && typeof item.event.toolCallId === "string") {
      commandByTool.set(item.event.toolCallId, item);
    }
  }
  const view = {
    runId,
    env: env ?? process.env,
    items,
    gapAt: gapsOf(values, firstAt),
    state: findState(scope),
    resultByTool,
    commandByTool,
    worktree: boundWorktreePath(scope, runId),
    inferExit: EXIT_CODE_INFERENCE_PROVEN_BACKENDS.has(String(findLatestBound(scope, "session.created", runId)?.backend ?? "")),
    redactor,
    budget: { left: OWNER_ACTIVITY_REQUEST_RAW_BUDGET_CHARS },
    /** 把一段原文交给安全链（脱敏 → 折路径 / 归一换行 → 清控制字符；不限长）。 */
    process(raw) {
      if (typeof onProcessText === "function") onProcessText(raw.length);
      return safeBody(raw, redactor, Number.MAX_SAFE_INTEGER, foldForDisplay).text;
    },
    /** 完整的安全文本（不限长，不做窗口——取全文接口用）。 */
    full: (raw) => (typeof raw === "string" && raw.length > 0 ? view.process(raw) : ""),
    excerpt: (raw, headN, tailN) => excerptOf(raw, headN, tailN, view),
    /** 短标签：安全文本的第一个非空行，限长。 */
    label: (raw, max = OWNER_ACTIVITY_LABEL_MAX_CHARS) => clip(excerptOf(raw, 1, 0, view).first, max),
  };
  return view;
}

// ===== 行 =====

function exitOf(event, view) {
  const wire = Number.isInteger(event.exitCode);
  let command = event;
  if (!wire && view.inferExit) {
    const result = view.resultByTool.get(event.toolCallId);
    command = withInferredCommandExitCode(event, result === undefined ? [] : [result]);
  }
  if (!Number.isInteger(command.exitCode)) return { exitCode: null, exitSource: null };
  return { exitCode: command.exitCode, exitSource: wire ? "wire" : "inferred" };
}

/** 错误行的原文与隔离违规块。隔离违规走共用投影，不另写口径。 */
function errorParts(event, view) {
  if (event.type === "run.isolation_violation") {
    const detail = isolationViolationDetail([event], view.runId, { env: view.env });
    return {
      raw: detail?.reason ? `isolation violation: ${detail.reason}` : "isolation violation",
      isolation: detail === null ? null : isolationBlock(detail),
      detailTruncated: false,
    };
  }
  const { raw, truncated } = errorTextOf(event, view);
  return { raw, isolation: null, detailTruncated: truncated };
}

/** 工具调用输入里最能说明"在对什么动手"的那个字段（与 Lead 侧同一份键表）；没有给 null。 */
function toolDetailValue(input) {
  if (!isObject(input)) return null;
  for (const key of TOOL_DETAIL_KEYS) {
    if (typeof input[key] === "string" && input[key].length > 0) return input[key];
  }
  return null;
}

function writePath(event, view) {
  const raw = event.path;
  // Windows 盘符相对路径（`C:foo`、`C:outside/../src/a.txt`）：基准目录是该盘符的"当前目录"，转录里证明不了。
  if (typeof raw !== "string" || DRIVE_RELATIVE_RE.test(raw)) return OWNER_PATH_WITHHELD;
  const relative = view.worktree === null ? null : deriveRelativePath(raw, view.worktree);
  if (relative === null) return OWNER_PATH_WITHHELD;
  const shown = displayPath(relative, view.redactor);
  if (shown === OWNER_PATH_WITHHELD) return shown;
  // displayPath 超长会静默截断——截出来的路径指向别处；超过上限的整条不给。
  return safeBody(relative, view.redactor, OWNER_PATH_MAX_CHARS).truncated ? OWNER_PATH_WITHHELD : shown;
}

function eventRow(item, view) {
  const { event, seq, seqState, cls } = item;
  const base = {
    row: "event",
    code: cls.code,
    seq,
    seqState,
    ts: typeof event.ts === "string" ? view.label(event.ts) : null,
  };
  // 取全文要靠唯一的事件号寻址：号不唯一 / 没有的事件给 null（前端不画 Open full）。
  const part = seqState === "ok" ? (PART_OF_CODE[cls.code] ?? null) : null;
  switch (cls.code) {
    case "MSG": {
      const block = view.excerpt(messageText(event), OWNER_MESSAGE_HEAD_LINES, 0);
      return { ...base, summary: block.summary, truncated: block.truncated, part, role: view.label(event.role, ROLE_MAX_CHARS), body: block.body };
    }
    case "CMD": {
      const block = view.excerpt(event.command, 1, 0);
      return { ...base, summary: block.summary, truncated: block.truncated, part, commandLines: block.body.totalLines, ...exitOf(event, view) };
    }
    case "OUT": {
      const block = view.excerpt(outputText(event.output), OWNER_OUTPUT_HEAD_LINES, OWNER_OUTPUT_TAIL_LINES);
      return { ...base, summary: block.summary, truncated: block.truncated, part, outputOf: cls.outputOf, isError: cls.isError, body: block.body };
    }
    case "TOOL": {
      // 旧档的 tool_use 用 name 而不是 tool，也常没有输入：摘要至少要有工具名。
      const name = [event.tool, event.name].find((value) => typeof value === "string" && value.length > 0) ?? "unknown";
      const nameLine = view.excerpt(name, 1, 0).first;
      const tool = clip(nameLine, OWNER_ACTIVITY_LABEL_MAX_CHARS);
      const detailValue = toolDetailValue(event.input);
      const detail = detailValue === null ? "" : view.excerpt(detailValue, 1, 0).first;
      const line = detail === "" ? tool : `${tool} ${detail}`;
      return {
        ...base,
        summary: clip(line, OWNER_ACTIVITY_LINE_MAX_CHARS),
        // 按截断前的长度判：工具名被限长、输入摘要或拼出来的整行超过行上限都算。
        truncated: nameLine.length > OWNER_ACTIVITY_LABEL_MAX_CHARS || detail.length > OWNER_ACTIVITY_LINE_MAX_CHARS || line.length > OWNER_ACTIVITY_LINE_MAX_CHARS,
        part,
        tool,
      };
    }
    case "WRITE": {
      const path = writePath(event, view);
      // 没有后端给出绑定的增删行观测：未知（null），不拿 Git 数字顶替。
      return { ...base, summary: path, truncated: false, part, path, added: null, deleted: null };
    }
    case "STATE":
      return {
        ...base, summary: event.to, truncated: false, part,
        from: memberOf(RUN_STATES, event.from), to: event.to, reason: memberOf(STATE_CHANGE_REASONS, event.reason),
      };
    default: { // ERR
      const { raw, isolation, detailTruncated } = errorParts(event, view);
      const phase = view.label(event.phase);
      const bounded = boundedOf(raw, OWNER_ERROR_MAX_CHARS, view);
      return {
        ...base, summary: clip(bounded.first || phase, OWNER_ACTIVITY_LINE_MAX_CHARS), truncated: bounded.truncated || detailTruncated, part,
        phase, text: bounded.text, totalChars: bounded.totalChars, isolation,
      };
    }
  }
}

const rtStatus = (event) => memberOf(RUNTIME_ACTIVITY_STATUSES, event.status) ?? "unknown";

/** 一行折叠：只吞同一种 seqState（ok 与 ok、missing 与 missing）；冲突号的事件各自一行（它们的号不可靠，不能拿来画区间）。 */
function newFold(item, view) {
  const numbered = item.seqState !== "missing";
  const ts = typeof item.event.ts === "string" ? view.label(item.event.ts) : null;
  return {
    row: "fold", code: "RT", seqState: item.seqState,
    fromSeq: numbered ? item.seq : null, toSeq: numbered ? item.seq : null,
    count: 1, status: rtStatus(item.event), fromTs: ts, toTs: ts,
  };
}

const canExtendFold = (fold, item) => fold.seqState === item.seqState && item.seqState !== "conflict";

function extendFold(fold, item, view) {
  fold.count += 1;
  fold.status = rtStatus(item.event);
  if (item.seqState === "ok") fold.toSeq = item.seq;
  // 收尾时刻跟着最后吸收的那条事件走（没有时间戳的事件不改动它）：折叠行的区间两端才是同一批事件的两端。
  if (typeof item.event.ts === "string") fold.toTs = view.label(item.event.ts);
}

// ===== 页的起点 =====

/**
 * 窗口 = 本页区间 [lower, cut) 里最近 limit 个单位（单位 = 要显示的时间线事件，或一个缺口；key 是它在
 * 数组里的位置，缺口排在上界事件之前半格）。页的起点必须落在 ok 事件上，且不能低于下界 lower：
 *   1. 窗口起点往前（更早）找最近的 ok 事件，只要不比 PAGE_MAX 个单位更远；
 *   2. 否则往后找最近的 ok 事件（页比 limit 小，被让出的事件在下一页）；
 *   3. 两头都没有：本区间里没有被号事件可当游标，页从 lower（或页上限）开始，不能再往前翻。
 * 窗口最老的单位是缺口时，这个缺口让给更早的一页（它排在那一页的末尾）——除非它正好是本区间最后
 * 一个单位（limit=1 的翻页），那就把页起点再往前挪一格，把它放进来。
 */
function chooseStart({ units, items, cut, limit, lower }) {
  const none = { available: false, beforeSeq: null, reason: null };
  if (units.length <= limit) return { start: lower, older: none };
  const oldest = units[units.length - limit];
  const s0 = oldest.gap && oldest.at >= cut ? oldest.at - 1 : oldest.at;
  const hardAt = units.length > OWNER_ACTIVITY_PAGE_MAX ? units[units.length - OWNER_ACTIVITY_PAGE_MAX].at : lower;
  const numbered = (start) => {
    const available = start > lower;
    return { start, older: { available, beforeSeq: available ? items[start].seq : null, reason: null } };
  };

  let back = s0;
  while (back >= lower && items[back].seqState !== "ok") back -= 1;
  if (back >= lower && back >= hardAt) return numbered(back);

  let forward = s0 + 1;
  while (forward < cut && items[forward].seqState !== "ok") forward += 1;
  if (forward < cut) return numbered(forward);

  const start = Math.max(lower, hardAt);
  if (back >= lower) {
    // There is a numbered event before the window, but more than PAGE_MAX unnumbered units between it
    // and the page: cap the page and point older at that event (the legacy "capped" jump).
    return { start, older: { available: true, beforeSeq: items[back].seq, reason: "capped" } };
  }
  return { start, older: { available: false, beforeSeq: null, reason: hardAt === 0 ? "unnumbered" : "capped" } };
}

// ===== 活动页 =====

/**
 * 一页时间线。
 *
 * @param {object} input
 * @param {string} input.runId — 已验过形状的 runId
 * @param {object[]} input.events — 这一刻读到的该运行的转录事件
 * @param {number} [input.afterSeq] — 只取 seq 大于 afterSeq 的 ok 事件（下界，含隐藏事件覆盖范围）
 * @param {number} [input.beforeSeq] — 只取第一个 seq ≥ beforeSeq 的 ok 事件之前的事件（向上翻页）
 * @param {number} [input.limit] — 至多多少个单位（缺省 / 上限 200；见文件头"limit 数的是单位"）
 * @param {"all"|"messages"|"commands"|"errors"} [input.filter]
 * @param {object} [input.env] — 脱敏用的环境（缺省 process.env）
 * @param {(chars: number) => void} [input.onProcessText] — 测试接缝：每次把多长的原文交给脱敏管道
 * @returns {object} { runId, state, terminal, filter, limit, total, range, older{available,beforeSeq,reason}, hidden, rows, updates }
 */
export function projectWorkerActivity({
  runId, events, afterSeq, beforeSeq, limit = OWNER_ACTIVITY_LIMIT_DEFAULT, filter = "all", env, onProcessText,
}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > OWNER_ACTIVITY_LIMIT_MAX) throw new RangeError("invalid limit");
  if (!OWNER_ACTIVITY_FILTERS.includes(filter)) throw new RangeError("invalid filter");
  if (afterSeq !== undefined && !(Number.isInteger(afterSeq) && afterSeq >= 0 && afterSeq <= OWNER_SEQ_MAX)) {
    throw new RangeError("invalid afterSeq");
  }
  if (beforeSeq !== undefined && !(Number.isInteger(beforeSeq) && beforeSeq >= 0 && beforeSeq <= OWNER_SEQ_MAX)) {
    throw new RangeError("invalid beforeSeq");
  }

  const view = prepare({ runId, events, env, onProcessText });
  const { items, gapAt } = view;
  const included = items.map((item) => item.cls !== null && accepts(filter, item.cls));

  // 下界：第一个 seq > afterSeq 的带号事件。afterSeq 只是对外的 seq 游标，没有号的旧档不走这条路径。
  let lower = 0;
  if (afterSeq !== undefined) {
    const at = items.findIndex((item) => item.seqState === "ok" && item.seq > afterSeq);
    lower = at < 0 ? items.length : at;
  }

  // 页的终点：第一个 seq ≥ beforeSeq 的 ok 事件的位置（没有就是转录末尾）；下界之后的区间为空时
  // 终点抬到下界，页为空、range 仍是这段空区间的覆盖范围。
  let cut = items.length;
  if (beforeSeq !== undefined) {
    const at = items.findIndex((item) => item.seqState === "ok" && item.seq >= beforeSeq);
    if (at >= 0) cut = at;
  }
  if (cut < lower) cut = lower;
  // 终点之前的单位（缺口排在上界事件之前；上界就是终点处事件的缺口，是上一页的末尾）。
  const units = [];
  for (let i = lower; i <= cut; i += 1) {
    if (gapAt.has(i) && i > lower) units.push({ key: i - 0.5, at: i, gap: true });
    if (i < cut && included[i]) units.push({ key: i, at: i, gap: false });
  }
  const chosen = chooseStart({ units, items, cut, limit, lower });
  let start = chosen.start;
  // 游标区间的第一个缺口：它排在 lower 事件之前，不在 units 里；只在本页预算还容得下时放到页首，
  // 否则留给上一页（older 指向 lower 事件，下一请求会返回这条 gap）。
  let startGap = null;
  if (afterSeq !== undefined && Number.isInteger(lower) && lower <= cut) {
    const gap = gapAt.get(lower);
    if (gap !== undefined) {
      const from = Math.max(gap.fromSeq, afterSeq + 1);
      if (from <= gap.toSeq) startGap = { row: "gap", fromSeq: from, toSeq: gap.toSeq, count: gap.toSeq - from + 1 };
    }
  }
  // A page that contains a gap must also stay within limit. chooseStart may step back to an ok event to
  // make beforeSeq addressable; when that would overfill a gap page, step forward instead and leave the
  // leading units to the older page.
  const pageUnits = (s, includeStart) => (includeStart ? 1 : 0)
    + units.reduce((sum, unit) => sum + (unit.at > s || (unit.at === s && unit.gap === false) ? 1 : 0), 0);
  if (startGap !== null || units.some((unit) => unit.gap)) {
    let include = start === lower && units.length < limit;
    if (pageUnits(start, include) > limit) {
      const windowAt = (units[Math.max(0, units.length - limit)] ?? { at: lower }).at;
      let candidate = Math.max(start, windowAt);
      while (candidate < cut && items[candidate].seqState !== "ok") candidate += 1;
      if (candidate < cut) start = candidate;
    }
  }
  const includeStartGap = startGap !== null && start === lower && units.length < limit;
  let older = chosen.older;
  if (start !== chosen.start) {
    older = start > lower && items[start].seqState === "ok" && Number.isInteger(items[start].seq)
      ? { available: true, beforeSeq: items[start].seq, reason: null }
      : { available: false, beforeSeq: null, reason: "capped" };
  }
  if (includeStartGap) older = { available: false, beforeSeq: null, reason: null };
  else if (startGap !== null && start === lower) older = { available: true, beforeSeq: items[lower].seq, reason: null };
  if (!older.available && start > lower && items[start].seqState === "ok" && Number.isInteger(items[start].seq)) {
    older = { available: true, beforeSeq: items[start].seq, reason: null };
  }

  const rows = [];
  const hidden = { filtered: 0, folded: 0, unlisted: 0 };
  let fromSeq = null;
  let toSeq = null;
  if (includeStartGap) rows.push(startGap);
  for (let i = start; i <= cut; i += 1) {
    const gap = gapAt.get(i);
    // 起点之前的缺口归更早的一页（排在它的末尾）；终点处的缺口归本页（i === cut）。
    if (gap !== undefined && i > start) rows.push({ row: "gap", fromSeq: gap.fromSeq, toSeq: gap.toSeq, count: gap.toSeq - gap.fromSeq + 1 });
    if (i === cut) break;
    const item = items[i];
    if (item.seqState === "ok") {
      fromSeq ??= item.seq;
      toSeq = item.seq;
    }
    if (item.cls === null) {
      hidden.unlisted += 1;
    } else if (!included[i]) {
      hidden.filtered += 1;
    } else if (item.cls.code === "RT") {
      hidden.folded += 1;
      const last = rows[rows.length - 1];
      if (last !== undefined && last.row === "fold" && canExtendFold(last, item)) extendFold(last, item, view);
      else rows.push(newFold(item, view));
    } else {
      rows.push(eventRow(item, view));
    }
  }
  // range 必须包住本页返回的每一行：缺口行、冲突号行、折叠区间都算；同时保留事件循环对隐藏
  // 事件的覆盖（fromSeq/toSeq 在筛选之前就更新了）。
  for (const row of rows) {
    let from = null;
    let to = null;
    if (row.row === "event") {
      if (Number.isInteger(row.seq)) from = row.seq;
      to = from;
    } else {
      if (Number.isInteger(row.fromSeq)) from = row.fromSeq;
      if (Number.isInteger(row.toSeq)) to = row.toSeq;
    }
    if (from !== null) fromSeq = fromSeq === null ? from : Math.min(fromSeq, from);
    if (to !== null) toSeq = toSeq === null ? to : Math.max(toSeq, to);
  }
  if (fromSeq === null && toSeq === null && afterSeq !== undefined) {
    // 空区间：保留 {afterSeq+1, afterSeq} 的约定（游标不前进）。
    fromSeq = afterSeq + 1;
    toSeq = afterSeq;
  }

  // A command's exit code is inferred from a LATER tool_result, so its row changes even though its own
  // seq is before the page. The updates array carries those changed rows without putting them in the
  // page's range: counts and coverage stay based on the interval only. Only a command that had NO exit
  // code before, whose first result is the one in this page, and that is at/before the cursor qualifies;
  // rows and updates share the page's unit budget.
  const updates = [];
  const updatedSeqs = new Set();
  const usedUnits = pageUnits(start, includeStartGap);
  const updateBudget = Math.max(0, Math.min(limit, OWNER_ACTIVITY_UPDATES_MAX) - usedUnits);
  if (afterSeq !== undefined) {
    for (let i = start; i < cut; i += 1) {
      if (updates.length >= updateBudget) break;
      const item = items[i];
      if (item.cls === null || item.cls.code !== "OUT" || item.cls.outputOf !== "command") continue;
      if (typeof item.event.tool !== "string") continue;
      const command = view.commandByTool.get(item.event.tool);
      if (command === undefined || !Number.isInteger(command.seq) || updatedSeqs.has(command.seq)) continue;
      if (command.seq > afterSeq) continue; // the cursor's command is still part of the new page
      if (Number.isInteger(command.event.exitCode)) continue; // it already had a wire exit code
      if (view.resultByTool.get(item.event.tool) !== item.event) continue; // not the result used for inference
      if (!accepts(filter, command.cls)) continue; // an update must never leak a row this filter hides
      if (rows.some((row) => row.row === "event" && row.seq === command.seq)) continue;
      const exit = exitOf(command.event, view);
      if (exit.exitCode === null) continue;
      updatedSeqs.add(command.seq);
      updates.push(eventRow(command, view));
    }
  }

  return {
    runId,
    state: memberOf(RUN_STATES, view.state) ?? "unknown",
    terminal: TERMINAL_STATES.includes(view.state),
    filter,
    limit,
    total: items.length,
    range: { fromSeq, toSeq },
    older,
    hidden,
    rows,
    updates,
  };
}

// ===== 全文分页与缓存 =====

/** 处理过的全文按 UTF-8 字节切页：每页 ≤ OWNER_EVENT_PAGE_MAX_BYTES，页边界落在字符起点上。 */
function pagedBytes(text) {
  const bytes = Buffer.from(text, "utf8");
  const bounds = [0];
  let at = 0;
  while (at < bytes.length) {
    let end = Math.min(at + OWNER_EVENT_PAGE_MAX_BYTES, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1; // 后一页不能从多字节字符的中间开始
    bounds.push(end);
    at = end;
  }
  return { bytes, bounds, totalPages: Math.max(1, bounds.length - 1), totalBytes: bytes.length };
}

/**
 * 处理过的全文的有界缓存（/api/worker/event 用）：每条记录的成本 = 正文字节 + 固定开销
 * （OWNER_EVENT_CACHE_ENTRY_OVERHEAD_BYTES），总成本超过 maxBytes 或条目数超过 maxEntries 就按最近最少使用
 * 淘汰——零字节正文的条目也占名额，不会无限累积；单条成本比 maxBytes 还大的不缓存。键由调用方给（带转录
 * 身份，转录变了键就变，旧条目自然失效并被淘汰）。stats 是测试与诊断用的计数（命中 / 未命中 / 淘汰），
 * getOrCompute 的 compute 返回 null（取不到）不缓存。bytes 是当前驻留的总成本。
 *
 * @param {{maxBytes?: number, maxEntries?: number}} [options]
 */
export function createFullTextCache({
  maxBytes = OWNER_EVENT_CACHE_MAX_BYTES,
  maxEntries = OWNER_EVENT_CACHE_MAX_ENTRIES,
} = {}) {
  const entries = new Map(); // 插入顺序 = 最近使用顺序（最老的在最前）
  const stats = { hits: 0, misses: 0, evictions: 0 };
  let total = 0;
  return {
    stats,
    get bytes() { return total; },
    get size() { return entries.size; },
    getOrCompute(key, compute) {
      const hit = entries.get(key);
      if (hit !== undefined) {
        entries.delete(key);
        entries.set(key, hit);
        stats.hits += 1;
        return hit.value;
      }
      stats.misses += 1;
      const value = compute();
      if (value === null) return null;
      const cost = value.totalBytes + OWNER_EVENT_CACHE_ENTRY_OVERHEAD_BYTES;
      if (cost <= maxBytes) {
        entries.set(key, { value, cost });
        total += cost;
        while (total > maxBytes || entries.size > maxEntries) {
          const [oldestKey, oldest] = entries.entries().next().value;
          entries.delete(oldestKey);
          total -= oldest.cost;
          stats.evictions += 1;
        }
      }
      return value;
    },
  };
}

function fullTextOf(item, view) {
  const { event, cls } = item;
  switch (cls.code) {
    case "MSG": return view.full(messageText(event));
    case "CMD": return view.full(event.command);
    case "OUT": return view.full(outputText(event.output));
    default: return view.full(errorParts(event, view).raw);
  }
}

/**
 * 某条事件某个部分的全文的一页（"Open full"）。seq 不存在 / 号不唯一 / 不在时间线上、part 不适用于
 * 这类事件、页号越界，都给 null（路由统一答固定 404）。传了 cache 与 identity（转录身份）时，处理过的
 * 全文按 (identity, runId, seq, part) 缓存，同一事件翻页不重算。
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {object[]} input.events
 * @param {number} input.seq — 唯一的真实事件号（1 … OWNER_SEQ_MAX）
 * @param {string} input.part — OWNER_EVENT_PARTS 之一
 * @param {number} [input.page=1] — 页号，从 1 起
 * @param {object} [input.env]
 * @param {ReturnType<typeof createFullTextCache>|null} [input.cache]
 * @param {string|null} [input.identity] — 转录身份（读模型的 readRunTranscript 给）；缺省不缓存
 * @param {(chars: number) => void} [input.onProcessText] — 测试接缝
 * @returns {{runId: string, seq: number, code: string, part: string, page: number, totalPages: number, totalBytes: number, text: string}|null}
 */
export function projectWorkerEvent({
  runId, events, seq, part, page = 1, env, cache = null, identity = null, onProcessText,
}) {
  if (!validSeq(seq) || !OWNER_EVENT_PARTS.includes(part) || !Number.isInteger(page) || page < 1) return null;
  const compute = () => {
    const view = prepare({ runId, events, env, onProcessText });
    const item = view.items.find((entry) => entry.seqState === "ok" && entry.seq === seq);
    if (item === undefined || item.cls === null || PART_OF_CODE[item.cls.code] !== part) return null;
    return { code: item.cls.code, ...pagedBytes(fullTextOf(item, view)) };
  };
  const entry = cache !== null && typeof identity === "string" && identity.length > 0
    ? cache.getOrCompute(`${identity}\u0000${runId}\u0000${seq}\u0000${part}`, compute)
    : compute();
  if (entry === null || page > entry.totalPages) return null;
  return {
    runId,
    seq,
    code: entry.code,
    part,
    page,
    totalPages: entry.totalPages,
    totalBytes: entry.totalBytes,
    text: entry.bytes.subarray(entry.bounds[page - 1], entry.bounds[page] ?? entry.bytes.length).toString("utf8"),
  };
}
