// scripts/reliability/laneReviewStats.mjs
//
// Per-lane review-seat facts for the lane-profile review at the close of the
// harness inspection (docs/certification-runbook.md; decision 0089). Pure
// aggregation plus read-only collectors; the CLI entry is
// scripts/lane-review-stats-cli.mjs.
//
// A seat's verdict is the declared Q1 value that WAO's consult field parser
// (attributeReply + compareFields, decision 0128 adjacency rule) finds in the
// seat's final reply (source "declared"). When the consult declared no Q1 field
// (fieldsDeclared marks the Q1 declaration only), inferVerdict reads the verdict
// word from the head of the final reply (source "inferred"); a declared-but-
// unread Q1 is NEVER re-inferred (decision 0128 续修: the tightened rule may
// only turn an ambiguous read into unfilled — inference must not flip it back,
// e.g. "Q1: FAIL 只是反例，最终结论是 PASS" stays unfilled). A seat with no
// verdict counts as not answered — split per decision 0128 into undeclared (no
// declared Q1, or a standalone review) and declaredUnfilled (Q1 declared but the
// seat filled none); only the latter is a lane signal. Pairwise stricter/
// lenient/same comparisons cover every consult with 2+ seats whose verdicts are
// in VERDICT_RANK, declared or inferred; standalone review runs have no co-seat
// and never compare.
//
// Sources (all read-only): this checkout's consult record directories
// (defaultConsultDirs), other projects' consult directories discovered from
// transcript project facts (discoverProjectConsultDirs), and standalone
// review runs — roleId auditor/reviewer with a runId-bound read-only
// declaration in project buckets (collectStandaloneReviews).

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { attributeReply, compareFields, observeSeatRun } from "../../src/application/consultService.js";
import { PROJECT_RECORD_NAME } from "../../src/projectBuckets.js";

export const VERDICT_RANK = Object.freeze({ FIX_FIRST: 2, PASS_WITH_NOTES: 1, PASS: 0 });

// ── inferVerdict：从最终答复的开头行读结论词（纯函数） ──
//
// 结论词必须落在"结论位置"：行首，或行首结论标签（可选分隔符、可选修饰词、
// 可选否定词）之后。句中、测试计数（184 passed）、fail() 之类的词不算。
// PASS 类词前紧挨否定（中间只许空格和 **）改判 FIX_FIRST。

const VERDICT_WORDS = [
  ["FIX_FIRST", ["FIX_FIRST", "FIX-FIRST", "FAIL", "FAILED", "REJECT", "REJECTED", "NO-GO", "NO GO", "NO_GO", "BLOCK", "BLOCKING", "BLOCKED", "CHANGES_REQUESTED", "CHANGES REQUESTED", "GO-WITH-CHANGES", "ADJUST", "不通过", "不能合并", "先修"]],
  ["PASS_WITH_NOTES", ["PASS_WITH_NOTES", "PASS-WITH-NOTES", "APPROVE_WITH_NOTES", "APPROVE-WITH-NOTES", "有条件通过", "带建议通过"]],
  ["PASS", ["PASS", "PASSED", "GO", "APPROVE", "APPROVED", "LGTM", "MERGE", "CLOSED", "通过", "可以合并"]],
];
// 英文词（可打印 ASCII，含连字符/空格/下划线）大小写不敏感整词匹配；中文词按
// 子串匹配。同位置取最长词（PASS_WITH_NOTES 胜过 PASS，NO GO 胜过 GO）。
const ASCII_WORD = /^[\x21-\x7e]+$/;
const VERDICT_TOKENS = VERDICT_WORDS
  .flatMap(([verdict, words]) => words.map((word) => ({ word, lower: word.toLowerCase(), verdict, ascii: ASCII_WORD.test(word) })))
  .sort((a, b) => b.word.length - a.word.length);

// 行首结论标签（英文大小写不敏感）。Q1 后必须是分隔符才算标签（Q1PASS 不剥）。
const VERDICT_LABELS = [
  { text: "Decision" },
  { text: "Verdict" },
  { text: "Overall" },
  { text: "总体结论" },
  { text: "本席结论" },
  { text: "本席意见" },
  { text: "会审意见" },
  { text: "总判定" },
  { text: "结论" },
  { text: "判定" },
  { text: "意见" },
  { text: "Q1", q1: true },
].map((label) => ({ ...label, lower: label.text.toLowerCase(), ascii: /^[\x21-\x7e]+$/.test(label.text) }));
const MODIFIERS = ["整体", "总体", "最终", "本席"];
// 否定词（PASS 类前紧挨时改判 FIX_FIRST）；英文要是独立的词。
const NEGATIONS = ["暂不", "没有", "无法", "不能", "尚未", "不", "未", "don't", "not", "no"]
  .map((text) => ({ text, lower: text.toLowerCase(), ascii: ASCII_WORD.test(text) }))
  .sort((a, b) => b.text.length - a.text.length);

const WORD_CHAR = /[A-Za-z0-9_]/;
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LEADING_MARKDOWN_RE = /^(?:[#>*-])[ \t]*/;
const LABEL_SEP_RE = /^[.*：:—\-\s]+/; // 标签后：. : ： — - 空格和 **
const SPACE_RUN_RE = /^[\s*]+/; // 否定词与结论词之间只许空格和 **

/** 反复去行首 Markdown 标记（#、>、-、* 及其后空格；## 与 ** 逐个剥掉）。 */
function stripLeadingMarkers(line) {
  let s = line;
  for (let next = s.replace(LEADING_MARKDOWN_RE, ""); next !== s; next = s.replace(LEADING_MARKDOWN_RE, "")) {
    s = next;
  }
  return s;
}

function matchLabel(lower, line) {
  for (const label of VERDICT_LABELS) {
    if (!lower.startsWith(label.lower)) continue;
    const after = line[label.text.length] ?? "";
    if (label.q1) {
      // Q1 粘连检查：后面必须是分隔符（. : ： 空格 **）或行尾才算标签。
      if (after !== "" && !/^[.:：*\s]$/.test(after)) continue;
    } else if (label.ascii && WORD_CHAR.test(after)) {
      continue; // Overall2 这类粘连不算标签
    }
    return label.text.length;
  }
  return 0;
}

/**
 * 在 pos 处匹配结论词：取本位置能匹配的最长词；它的后边界失败则本位置作废，
 * **不退回同位置更短的词**（GO-WITH-CHANGES需要补证 不是 GO）。判断后邻前先
 * 视 ** 已剥离（**通过**率 的后邻是 率）；结论词后紧跟 "(" 是函数调用（fail()），
 * 不算结论。
 */
function matchTokenAt(lower, line, pos) {
  let best = null;
  for (const t of VERDICT_TOKENS) {
    if (t.ascii ? lower.startsWith(t.lower, pos) : line.startsWith(t.word, pos)) {
      best = t; // VERDICT_TOKENS 按词长降序：首个匹配即最长
      break;
    }
  }
  if (best === null) return null;
  let after = pos + best.word.length;
  while (line[after] === "*") after += 1;
  const ch = line[after] ?? "";
  if (ch === "(") return null;
  if (ch !== "" && (CJK_CHAR.test(ch) || (best.ascii && WORD_CHAR.test(ch)))) return null;
  return { verdict: best.verdict, token: best.word };
}

/**
 * 否定词 + 空格/** + 结论词：PASS / PASS_WITH_NOTES 类改判 FIX_FIRST（暂不
 * MERGE、NOT PASS_WITH_NOTES）；被否定的 FIX_FIRST 类不是真实结论——返回 null
 * （NO CHANGES REQUESTED、不需要先修 记未识别）。
 */
function matchNegatedTokenAt(lower, line, pos) {
  for (const neg of NEGATIONS) {
    const matched = neg.ascii ? lower.startsWith(neg.lower, pos) : line.startsWith(neg.text, pos);
    if (!matched) continue;
    const afterNeg = line[pos + neg.text.length] ?? "";
    if (neg.ascii && WORD_CHAR.test(afterNeg)) continue; // nothing/nope 不是否定
    const rest = pos + neg.text.length + (SPACE_RUN_RE.exec(line.slice(pos + neg.text.length))?.[0].length ?? 0);
    const hit = matchTokenAt(lower, line, rest);
    if (hit === null) continue;
    if (hit.verdict === "FIX_FIRST") return null;
    return { verdict: "FIX_FIRST", token: hit.token };
  }
  return null;
}

/** 一行（已去行首标记）是否命中结论：行首或"标签(+修饰词)"后跟结论词，否定改判。 */
function verdictOnLine(line) {
  const lower = line.toLowerCase();
  let pos = matchLabel(lower, line);
  pos += LABEL_SEP_RE.exec(line.slice(pos))?.[0].length ?? 0;
  for (const modifier of MODIFIERS) {
    if (line.startsWith(modifier, pos)) {
      pos += modifier.length + (LABEL_SEP_RE.exec(line.slice(pos + modifier.length))?.[0].length ?? 0);
      break;
    }
  }
  return matchTokenAt(lower, line, pos) ?? matchNegatedTokenAt(lower, line, pos);
}

/**
 * 从席位最终答复推断结论（纯函数）。只看前 3 个非空行：去掉行首 Markdown 标记
 * 后，结论词须在行首或行首结论标签（Q1/Verdict/Overall/Decision/结论/判定/
 * 意见……）之后（标签后可跟分隔符、修饰词、否定词），否则不算——句中词、测试
 * 计数（184 passed）、fail() 都不认；结论词后紧邻汉字（通过率）也不认。PASS
 * 类词前紧挨否定（不/暂不/未/没有/无法/不能/尚未/not/no/don't）改判 FIX_FIRST。
 * @param {string} finalText
 * @returns {{verdict: string, token: string, line: string}|null} line 是命中的原始行（截到 120 字符）。
 */
export function inferVerdict(finalText) {
  const lines = String(finalText ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 3);
  for (const raw of lines) {
    const hit = verdictOnLine(stripLeadingMarkers(raw));
    if (hit !== null) return { verdict: hit.verdict, token: hit.token, line: raw.slice(0, 120) };
  }
  return null;
}

// ── 聚合（纯函数；计数用 Map 防 constructor 这类键名踩原型） ──

function tally(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function countAnswered(L, seat) {
  L.seats += 1;
  if (typeof seat.q1 !== "string") {
    // 决定 0128：认不出拆两类——声明了字段但未填（车道信号）与没声明字段
    //（会审或独立会审）也推断不到。
    if (seat.fieldsDeclared) L.declaredUnfilled += 1; else L.undeclared += 1;
    return;
  }
  L.answered += 1;
  if (seat.source === "inferred") L.inferred += 1; else L.declared += 1;
  tally(L.verdicts, seat.q1);
}

/** 会审里结论属于 VERDICT_RANK 的席位数（比较资格的口径，不论声明还是推断）。 */
export function ratedSeatCount(consult) {
  return (consult?.seats ?? []).filter((s) => typeof s?.q1 === "string" && Object.hasOwn(VERDICT_RANK, s.q1)).length;
}

/**
 * Per-lane counts (pure). Seats: {lane, q1, source?, fieldsDeclared?}（source
 * 缺省按 declared 计；fieldsDeclared 标记席位所在会审声明了 Q1 闭集——专指
 * Q1，决定 0128 认不出拆类的依据，独立会审运行恒不带）。
 * @param {Array<{seats: Array<{lane: string, q1: string|null, source?: string, fieldsDeclared?: boolean}>}>} consults
 * @param {Array<{lane: string, q1: string|null, source?: string}>} [standaloneReviews]
 *   独立会审运行（每条一次 review）；只计数，不参与比较。
 * @returns {Record<string, {seats: number, answered: number, declared: number, inferred: number,
 *   undeclared: number, declaredUnfilled: number,
 *   verdicts: Record<string, number>, stricterThan: Record<string, number>,
 *   lenientThan: Record<string, number>, sameAs: Record<string, number>}>}
 */
export function aggregateSeatVerdicts(consults, standaloneReviews = []) {
  // 车道键用 Map：constructor/__proto__ 这类名字不能踩对象原型（??= 会读到
  // Object.prototype.constructor 而丢车道）。
  const per = new Map();
  const lane = (id) => {
    let L = per.get(id);
    if (L === undefined) {
      L = {
        seats: 0, answered: 0, declared: 0, inferred: 0, undeclared: 0, declaredUnfilled: 0,
        verdicts: new Map(), stricterThan: new Map(), lenientThan: new Map(), sameAs: new Map(),
      };
      per.set(id, L);
    }
    return L;
  };
  for (const c of consults) {
    for (const s of c.seats ?? []) countAnswered(lane(s.lane), s);
    const rated = (c.seats ?? []).filter((s) => typeof s.q1 === "string" && Object.hasOwn(VERDICT_RANK, s.q1));
    if (rated.length < 2) continue;
    for (const a of rated) {
      for (const b of rated) {
        if (a === b || a.lane === b.lane) continue; // 同车道配对不自比
        const diff = VERDICT_RANK[a.q1] - VERDICT_RANK[b.q1];
        const L = lane(a.lane);
        tally(diff > 0 ? L.stricterThan : diff < 0 ? L.lenientThan : L.sameAs, b.lane);
      }
    }
  }
  for (const r of standaloneReviews) countAnswered(lane(r.lane), r);
  // Object.fromEntries 用 defineProperty 落键，__proto__/constructor 也是安全自有键。
  return Object.fromEntries([...per].map(([id, L]) => [id, {
    seats: L.seats,
    answered: L.answered,
    declared: L.declared,
    inferred: L.inferred,
    undeclared: L.undeclared,
    declaredUnfilled: L.declaredUnfilled,
    verdicts: Object.fromEntries(L.verdicts),
    stricterThan: Object.fromEntries(L.stricterThan),
    lenientThan: Object.fromEntries(L.lenientThan),
    sameAs: Object.fromEntries(L.sameAs),
  }]));
}

// ── 收集（只读） ──

/** Consult record directories of a WAO checkout: its own, each dev worktree's, and the archive. */
export function defaultConsultDirs(root) {
  const dirs = [join(root, ".wao", "runs", "consults")];
  const worktrees = join(root, ".dev", "wt");
  if (existsSync(worktrees)) {
    for (const name of readdirSync(worktrees)) dirs.push(join(worktrees, name, ".wao", "runs", "consults"));
  }
  const archive = join(root, "runs-archive");
  if (existsSync(archive)) {
    for (const month of readdirSync(archive)) {
      const base = join(archive, month, "consult-records-dev-worktrees");
      if (existsSync(base)) for (const batch of readdirSync(base)) dirs.push(join(base, batch));
    }
  }
  return dirs.filter((d) => existsSync(d));
}

/** 规范化路径键（正斜杠 + 去尾斜杠 + 小写；Windows 不区分大小写）。 */
function dirKey(path) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 目录列表按规范化路径去重（保序，首个胜出）。 */
export function dedupeDirs(dirs) {
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    const key = dirKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/**
 * 全部会审记录（不限时间窗）的席位 runId 集——独立会审的排除面。窗外会审的
 * 席位也不得被当成独立会审。只读，坏记录跳过。
 */
export function consultSeatRunIds({ dirs }) {
  const ids = new Set();
  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir).filter((n) => /^consult_.*\.json$/.test(n)); } catch { continue; }
    for (const name of names.sort()) {
      let rec;
      try { rec = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
      for (const s of Array.isArray(rec?.seats) ? rec.seats : []) {
        // 坏席位（null/非对象/缺 agentId 或 runId）跳过不计：无法回链到运行的
        // 席位不是可统计证据（与 collectConsults 同一取舍）。
        if (s === null || typeof s !== "object") continue;
        if (typeof s.agentId !== "string" || s.agentId.length === 0 || typeof s.runId !== "string") continue;
        ids.add(s.runId);
      }
    }
  }
  return ids;
}

// 转录扫描：先读有界头部（project 事实与 run.started/只读声明都在最前几行），
// 判定事实超出头窗才回退整读。坏行跳过。读头用循环 readSync 到读满或真 EOF。
const HEAD_SCAN_BYTES = 64 * 1024;

// 测试缝：注入头窗读取的 readSync（短读重试用）；生产为 null。
export const headReadSync = { fn: null };

function readHeadSlice(path) {
  const rd = headReadSync.fn ?? readSync;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_SCAN_BYTES);
    let total = 0;
    for (;;) {
      const n = rd(fd, buf, total, buf.length - total, total);
      if (n === 0) break; // 真到 EOF
      total += n;
      if (total === buf.length) break;
    }
    return buf.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

function parseEventLine(line) {
  if (line.trim().length === 0) return null;
  try { return JSON.parse(line); } catch { return null; }
}

function* transcriptEvents(path) {
  const head = readHeadSlice(path);
  const text = head.toString("utf8");
  const eof = head.length < HEAD_SCAN_BYTES;
  const lines = text.split(/\r?\n/);
  const complete = eof ? lines : lines.slice(0, -1); // 头窗截断时丢掉不完整的尾行
  let nonEmpty = 0;
  for (const line of complete) {
    const ev = parseEventLine(line);
    if (line.trim().length > 0) nonEmpty += 1;
    if (ev !== null) yield ev;
  }
  if (eof) return;
  let full;
  try { full = readFileSync(path, "utf8"); } catch { return; }
  let skipped = 0;
  for (const line of full.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    skipped += 1;
    if (skipped <= nonEmpty) continue; // 头窗已交付的行不重复
    const ev = parseEventLine(line);
    if (ev !== null) yield ev;
  }
}

/** project.key 是否为带盘符的绝对路径（Windows）；非 Windows 用 isAbsolute。 */
function isProjectKeyAbsolute(key) {
  return process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(key) : isAbsolute(key);
}

/** 转录里第一个 project 归属事实的 key（绝对路径；kind 非 project 或没有则 null）。 */
function firstProjectKey(path) {
  try {
    for (const ev of transcriptEvents(path)) {
      const project = ev?.project;
      if (project?.kind === "project" && typeof project.key === "string" && isProjectKeyAbsolute(project.key)) {
        return project.key;
      }
    }
  } catch { return null; }
  return null;
}

/**
 * 从 runDir 的项目桶转录的 project 事实发现各项目的会审记录目录
 * （<key>/.wao/runs/consults，必须是目录）。每个桶读到一个 key 就够（桶内运行
 * 共享归属）；按规范化路径去重。只读；坏桶/坏转录/坏路径逐个跳过。
 */
export function discoverProjectConsultDirs(runDir) {
  const out = [];
  const seen = new Set();
  let buckets;
  try { buckets = readdirSync(join(runDir, "projects")); } catch { return out; }
  for (const bucket of [...buckets].sort()) {
    const bucketDir = join(runDir, "projects", bucket);
    let names;
    try { names = readdirSync(bucketDir).filter((n) => n.endsWith(".jsonl")).sort(); } catch { continue; }
    for (const name of names) {
      const key = firstProjectKey(join(bucketDir, name));
      if (key === null) continue; // 该转录无归属事实，看桶内下一个
      const dir = join(key, ".wao", "runs", "consults");
      try {
        if (statSync(dir).isDirectory() && !seen.has(dirKey(dir))) {
          seen.add(dirKey(dir));
          out.push(dir);
        }
      } catch { /* 不存在/不可 stat：本桶结束 */ }
      break; // 每个桶读到一个 key 就够
    }
  }
  return out;
}

/**
 * 独立会审运行（只读收集）：runDir 项目桶（有 .project.json 的桶——决定 0050：
 * 保留桶无记录）里 roleId 为 auditor/reviewer、带 runId 绑定的
 * run.read_only_declared、且 runId 不是已收集会审席位的运行。started 与只读声明
 * 都按事件 runId === 文件名 runId 绑定（照 src/application/runReadOnlyObservation.js）；
 * 跨桶按 runId 去重。时间按 run.started 的 ts 落在 [since, until)；车道取 laneId
 * （缺省用 agentId）。最终答复经 observeSeatRun 取 finalText 后用 inferVerdict 推断。
 * @returns {Promise<Array<{runId: string, lane: string, ts: string, q1: string|null, source?: "inferred"}>>}
 */
export async function collectStandaloneReviews({ runDir, since = null, until = null, excludeRunIds = new Set(), observeFn = observeSeatRun }) {
  const out = [];
  const seenRunIds = new Set();
  let buckets;
  try { buckets = readdirSync(join(runDir, "projects")); } catch { return out; }
  for (const bucket of [...buckets].sort()) {
    const bucketDir = join(runDir, "projects", bucket);
    if (!existsSync(join(bucketDir, PROJECT_RECORD_NAME))) continue; // 只扫项目桶
    let names;
    try { names = readdirSync(bucketDir).filter((n) => n.endsWith(".jsonl")).sort(); } catch { continue; }
    for (const name of names) {
      const facts = standaloneRunFacts(join(bucketDir, name), name.slice(0, -".jsonl".length));
      if (facts === null) continue;
      if (seenRunIds.has(facts.runId) || excludeRunIds.has(facts.runId)) continue;
      seenRunIds.add(facts.runId);
      if ((since && facts.ts < since) || (until && facts.ts >= until)) continue;
      let q1 = null;
      try {
        const observed = await observeFn({ runId: facts.runId, runDir });
        const hit = inferVerdict(observed?.finalText ?? "");
        if (hit !== null) q1 = hit.verdict;
      } catch {
        q1 = null;
      }
      out.push({ runId: facts.runId, lane: facts.lane, ts: facts.ts, q1, ...(q1 === null ? {} : { source: "inferred" }) });
    }
  }
  return out;
}

/** 转录是否为独立会审运行；是则返回 {runId, lane, ts}，否则 null。 */
function standaloneRunFacts(path, fileRunId) {
  let started = null;
  let readOnly = false;
  try {
    for (const ev of transcriptEvents(path)) {
      const kind = ev?.project?.kind;
      if (typeof kind === "string" && kind !== "project") return null; // 非项目归属（探针桶）不算
      if (started === null && ev?.type === "run.started" && ev.runId === fileRunId) started = ev;
      if (ev?.type === "run.read_only_declared" && ev.runId === fileRunId) readOnly = true;
      if (started !== null && started.roleId !== "auditor" && started.roleId !== "reviewer") return null;
      if (started === null || !readOnly) continue;
      const lane = typeof started.laneId === "string" && started.laneId.length > 0 ? started.laneId : started.agentId;
      if (typeof lane !== "string" || lane.length === 0 || typeof started.ts !== "string") return null;
      return { runId: started.runId, lane, ts: started.ts };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Read consult records (deduplicated by consultId, createdAt in [since, until)) and each seat's
 * verdict from its run transcript. Read-only; an unreadable record or directory is skipped, an
 * unreadable seat run counts as not answered. A seat's verdict: when the consult declared Q1, the value the
 * consult field parser reads (source "declared"; declared but unfilled stays unfilled, never inferred);
 * only when Q1 was not declared, inferVerdict on the final reply (source "inferred").
 */
export async function collectConsults({ dirs, runDir, since = null, until = null, observeFn = observeSeatRun }) {
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir).filter((n) => /^consult_.*\.json$/.test(n)).sort(); } catch { continue; }
    for (const name of names) {
      let rec;
      try { rec = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
      const createdAt = typeof rec?.createdAt === "string" ? rec.createdAt : "";
      if (typeof rec?.consultId !== "string" || seen.has(rec.consultId)) continue;
      if ((since && createdAt < since) || (until && createdAt >= until)) continue;
      seen.add(rec.consultId);
      const q1Values = Array.isArray(rec.declaredFields?.Q1) ? rec.declaredFields.Q1 : [];
      const seats = [];
      // 坏席位（null/非对象/缺 agentId 或 runId）跳过不计：无法回链到运行的席位
      // 不是可统计证据；seats 非数组按零席位处理（会审本身仍计入）。
      for (const s of Array.isArray(rec.seats) ? rec.seats : []) {
        if (s === null || typeof s !== "object") continue;
        if (typeof s.agentId !== "string" || s.agentId.length === 0 || typeof s.runId !== "string") continue;
        let q1 = null;
        let source = null;
        let finalText = null;
        try {
          const observed = await observeFn({ runId: s.runId, runDir });
          finalText = observed?.finalText ?? "";
          const { fieldValues } = compareFields({ [s.agentId]: attributeReply(finalText) }, { Q1: q1Values });
          q1 = fieldValues.Q1?.[s.agentId] ?? null;
        } catch {
          q1 = null;
          finalText = null;
        }
        if (q1 !== null) {
          source = "declared";
        } else if (q1Values.length === 0 && finalText !== null) {
          // 决定 0128 续修：声明了 Q1 的会审，声明提取是唯一来源——取不到就算
          // declaredUnfilled，不回退推断（推断会把收紧后如实记未填的含糊值再
          // 翻成结论，甚至翻成相反的结论）。
          const hit = inferVerdict(finalText);
          if (hit !== null) {
            q1 = hit.verdict;
            source = "inferred";
          }
        }
        // fieldsDeclared（决定 0128）：本会审声明了 Q1 闭集（专指 Q1）——席位
        // 认不出时 aggregateSeatVerdicts 据此拆 declaredUnfilled 与 undeclared。
        seats.push({
          lane: s.agentId, runId: typeof s.runId === "string" ? s.runId : null, q1,
          ...(q1Values.length > 0 ? { fieldsDeclared: true } : {}),
          ...(q1 === null ? {} : { source }),
        });
      }
      out.push({ consultId: rec.consultId, createdAt, seats });
    }
  }
  return out;
}

/** Plain-text report: one header line, then two lines per lane (pure). */
export function renderLaneReviewStats({ consults, standaloneReviews = [], lanes }) {
  const list = (counts) => {
    const parts = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k} ${v}`);
    return parts.length > 0 ? parts.join(", ") : "-";
  };
  const withRated = consults.filter((c) => ratedSeatCount(c) >= 2).length;
  const lines = [`consults ${consults.length} (with 2+ rated seats ${withRated}), standalone reviews ${standaloneReviews.length}`];
  for (const [id, L] of Object.entries(lanes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // 决定 0128：认不出拆两类并显示两个数——declaredUnfilled 才是车道信号。
    lines.push(`${id}: reviews ${L.seats}, answered ${L.answered} (declared ${L.declared}, inferred ${L.inferred}), unrecognized ${L.seats - L.answered} (undeclared ${L.undeclared ?? 0}, declaredUnfilled ${L.declaredUnfilled ?? 0}) — ${list(L.verdicts)}`);
    lines.push(`  in consults with 2+ rated seats: stricter than ${list(L.stricterThan)}; more lenient than ${list(L.lenientThan)}; same as ${list(L.sameAs)}`);
  }
  return lines.join("\n");
}
