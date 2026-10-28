// test/isolation-infra/gitOptionalLocksGuard.test.js
//
// 只读 git status 的 --no-optional-locks 守卫（扫 src/ 与 scripts/ 的源码）。
//
// 为什么：2026-10-28 三次交付打包以 git_index_locked 失败（run_20261028112943973l4wmbz、
// run_20261028125026092rfbqg5、run_20261028133047450o40gy5），都是 worker 在 run
// 工作树里跑测试期间留下了 0 字节 .git/index.lock。锁文件不留创建者；已确认能写
// 索引的只读调用有两类：不带该参数的 `git status`（顺手刷新索引并写回，写回要拿
// index.lock）与工作树 `git diff`（经 diff.autoRefreshIndex，该参数拦不住，由
// src/gitPrivateIndex.js 的私有索引副本处理，不归本守卫）。
//
// 规则：凡是含 "status" 元素的参数数组字面量，都要在 "status" 之前有一个顶层元素
// 恰好是 "--no-optional-locks"（git 的全局选项只能写在子命令前）。旗写在调用处的
// 数组里才算：封装里前置的不算，守卫不按名字解析封装（会审实证过，按名字、按位置
// 认封装都会认错）。NON_GIT_STATUS_ARRAYS 列出的命令名、键名清单除外。元素须是裸
// 字符串字面量："status" 加括号、拼接出来的不认。
//
// 扫描面：src/ 与 scripts/ 的 .js/.mjs/.cjs（src/owner-dashboard/ 的浏览器资产除外）。
// 整条字符串形式的命令、模板字符串拼出的命令、在变量里拼好再传的参数数组、测试
// 自身的 git 调用、.ps1/.cmd 都不在扫描面内。
//
// 词法基座（剥注释，给字符串、模板、正则打掩码）是有限状态机，不是解析器：`/` 是
// 正则还是除号按前一个记号猜（运算符、}、return/continue 等关键字与 continue/break
// 的标签、if/while/for/with 与 for await 的条件括号之后算正则；其余标识符（按 Unicode
// 认）、点号后的关键字属性名、数字、)、]、后缀 ++/-- 与引号之后算除号）。猜错时两道
// 兜底：文件读完不在代码态、${} 或括号没配平 → 红；基座没当代码的 "status" 数组元素，
// 从它所在那一行的行首按代码读起却落在代码里（不在本行的注释、引号或模板文字里；
// 本行代码里出现单个 / 就不替它开脱）→ 红。后一道每行从头判断、不带任何猜测，与
// 基座互不牵连，跨行或同行的误读都骗不到两层；代价是多行模板、多行注释（含 JSDoc
// 续行）、正则里，以及同行有 / 的字符串里写 "status" 数组元素会被它误报（守卫分不
// 出），换个写法即可。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

// 浏览器静态资产（layering.test.js 同款剪枝）：不进 Node git 调用面。
const SKIP_PREFIXES = ["src/owner-dashboard/"];

const SCAN_ROOTS = ["src", "scripts"];

function walkJs(rootDir, out = []) {
  for (const name of readdirSync(rootDir)) {
    const p = join(rootDir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkJs(p, out);
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

// ===== 词法基座 =====

// 这些关键字之后的 `/` 开正则（return /x/、export default /x/、continue 后另起一行的 /x/ …）。
const REGEX_PREFIX_WORDS =
  /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|default|do|else|yield|await|continue|break|debugger)$/;
// 这些关键字的条件括号收尾之后的 `/` 开正则（if (x) /`/.test(s)）。
const CONTROL_PAREN_WORDS = /^(?:if|while|for|with)$/;

// 标识符字符按 Unicode 认（stats.已处理 也是标识符）。
const IDENT_CHAR = /[\p{ID_Continue}$]/u;

/** i 之前最后一个有效字符、以它收尾的标识符（不是标识符时为空串）及该标识符的起点。 */
function tokenBefore(chars, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(chars[k])) k -= 1;
  let s = k;
  while (s >= 0 && IDENT_CHAR.test(chars[s])) s -= 1;
  return { prev: k >= 0 ? chars[k] : "", word: chars.slice(s + 1, k + 1).join(""), start: s + 1 };
}

/** 位置 i 的 ( 是否是 if/while/for/with（含 for await）的条件括号。 */
function opensControlParen(chars, i) {
  const t = tokenBefore(chars, i);
  if (CONTROL_PAREN_WORDS.test(t.word)) return true;
  return t.word === "await" && tokenBefore(chars, t.start).word === "for";
}

function regexMayStart(chars, i, afterControlParen) {
  const { prev, word, start } = tokenBefore(chars, i);
  if (prev === "") return true;
  if (word !== "") {
    const before = tokenBefore(chars, start);
    // 点号后的关键字是属性名（stats.in、opts.default），之后是除号。
    if (before.prev === ".") return false;
    if (REGEX_PREFIX_WORDS.test(word)) return true;
    // continue/break 后的标签：语句已完，下一行另起的 / 是正则（continue outer⏎/x/.test(s)）。
    return /^(?:continue|break)$/.test(before.word);
  }
  if (prev === ")") return afterControlParen;
  // 后缀 ++/-- 之后是除号（stats.done++ / total）。
  if ((prev === "+" || prev === "-") && chars[start - 2] === prev) return false;
  // } 之后算正则：块收尾后另起一句的正则是合法写法；对象字面量后接除号几乎没人写。
  return !/[\]'"`]/.test(prev);
}

/**
 * 剥离注释（换成等长空白，行号与偏移不变），并标出每个字符是否在字符串、模板或
 * 正则字面量内部（不含定界符）。单双引号与正则不跨行，未闭合即以行为界止损；模板
 * 可跨行，${} 里按代码分析（可再嵌模板）。
 * @returns {{code: string, inString: boolean[], balanced: boolean}}
 *   balanced = 读完在代码态（或末行注释里），${}、花括号与圆括号都配平。
 */
function analyze(text) {
  const chars = text.split("");
  const inString = new Array(text.length).fill(false);
  const mask = (j) => {
    if (j < text.length) inString[j] = true;
  };
  let state = "code"; // code | line | block | squote | dquote | template | regex
  let inClass = false; // 正则字符类 [...] 内（其中的 / 不收尾）
  let depth = 0; // 代码态花括号深度
  const exprDepths = []; // 每层未收尾的模板 ${ 进入时的花括号深度
  const parens = []; // 每层未收尾的 ( 是否是条件括号
  let afterControlParen = false; // 最近收尾的 ) 是否是条件括号
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = i + 1 < text.length ? text[i + 1] : "";
    if (state === "code") {
      if (c === "/" && n === "/") { chars[i] = " "; chars[i + 1] = " "; i++; state = "line"; }
      else if (c === "/" && n === "*") { chars[i] = " "; chars[i + 1] = " "; i++; state = "block"; }
      else if (c === "/" && regexMayStart(chars, i, afterControlParen)) { state = "regex"; inClass = false; }
      else if (c === "'") state = "squote";
      else if (c === "\"") state = "dquote";
      else if (c === "`") state = "template";
      else if (c === "(") parens.push(opensControlParen(chars, i));
      else if (c === ")") afterControlParen = parens.pop() ?? false;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        if (exprDepths.length > 0 && exprDepths[exprDepths.length - 1] === depth) {
          exprDepths.pop();
          state = "template";
        } else depth -= 1;
      }
    } else if (state === "line") {
      if (c === "\n") state = "code"; else chars[i] = " ";
    } else if (state === "block") {
      if (c === "*" && n === "/") { chars[i] = " "; chars[i + 1] = " "; i++; state = "code"; }
      else if (c !== "\n") chars[i] = " ";
    } else if (state === "squote" || state === "dquote") {
      if (c === "\\") { mask(i); mask(i + 1); i++; }
      else if (c === (state === "squote" ? "'" : "\"") || c === "\n") state = "code";
      else mask(i);
    } else if (state === "template") {
      if (c === "\\") { mask(i); mask(i + 1); i++; }
      else if (c === "`") state = "code";
      else if (c === "$" && n === "{") { exprDepths.push(depth); i++; state = "code"; }
      else mask(i);
    } else if (state === "regex") {
      if (c === "\\") { mask(i); mask(i + 1); i++; }
      else if (c === "\n") state = "code";
      else if (inClass) { mask(i); if (c === "]") inClass = false; }
      else if (c === "[") { mask(i); inClass = true; }
      else if (c === "/") state = "code";
      else mask(i);
    }
  }
  const balanced = (state === "code" || state === "line")
    && exprDepths.length === 0 && depth === 0 && parens.length === 0;
  return { code: chars.join(""), inString, balanced };
}

// ===== 站点识别 =====

// 字符串字面量 "status"（单双引号皆可）。
const STATUS_ELEMENT = /(["'])status\1/g;

/** 位置 index 起、长 length 的命中前后（跳过空白）紧邻的字符。 */
function neighbors(text, index, length) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  let j = index + length;
  while (j < text.length && /\s/.test(text[j])) j += 1;
  return { before: i >= 0 ? text[i] : "", after: j < text.length ? text[j] : "" };
}

// 从元素起点向两侧括号配对求该数组字面量的边界（跳过字符串内部）。
function arraySpan(code, inString, elemStart) {
  let depth = 0;
  let open = -1;
  for (let i = elemStart - 1; i >= 0; i -= 1) {
    if (inString[i]) continue;
    const c = code[i];
    if (c === "]") depth += 1;
    else if (c === "[") {
      if (depth > 0) depth -= 1;
      else { open = i; break; }
    }
  }
  if (open < 0) return null;
  depth = 0;
  for (let j = open + 1; j < code.length; j += 1) {
    if (inString[j]) continue;
    const c = code[j];
    if (c === "[") depth += 1;
    else if (c === "]") {
      if (depth > 0) depth -= 1;
      else return { open, close: j };
    }
  }
  return null;
}

/** 数组字面量 [open … close] 的顶层元素文本（去首尾空白；字符串内部的符号不算分隔）。 */
function topLevelElements(code, inString, open, close) {
  const out = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    if (inString[i]) continue;
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) { out.push(code.slice(start, i).trim()); start = i + 1; }
  }
  out.push(code.slice(start, close).trim());
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

// ===== 兜底：只看本行 =====

/** 原文里的命中像数组元素：左邻（跳过空白）是 [ 或 ,，或右邻（跳过空白与 /* … *\/）是 , 或 ]。 */
function rawElementShaped(src, index, length) {
  const { before } = neighbors(src, index, length);
  if (before === "[" || before === ",") return true;
  let j = index + length;
  for (;;) {
    while (j < src.length && /\s/.test(src[j])) j += 1;
    if (!src.startsWith("/*", j)) break;
    const end = src.indexOf("*/", j + 2);
    if (end < 0) return false;
    j = end + 2;
  }
  return src[j] === "," || src[j] === "]";
}

/**
 * 只看本行：从行首读到位置 p，p 是否落在注释、引号串或模板文字里（模板的 ${} 里是
 * 代码）。每行从代码态重新开始，不带进任何猜测，跨行的误读骗不到它（以 * 开头的行
 * 也按代码读：它可能是 JSDoc 续行，也可能是行首乘号，本行分不出）。刻意不猜正则：
 * 本行代码里一出现单个 /，正则还是除号说不准（正则里的引号会让后文看似在字符串
 * 里），就不替它开脱，直接算说不通——与基座共用猜法，两层会一起猜错、一起放过
 * （复核实证过）。代价是同行有 / 时字符串或正则里、以及多行注释里写 "status" 数组
 * 元素会被误报。
 */
function explainedOnLine(src, p) {
  const text = src.slice(src.lastIndexOf("\n", p - 1) + 1, p);
  let state = "code"; // code | block | 引号字符本身
  let depth = 0; // 本行代码里的花括号深度
  const exprDepths = []; // 本行模板里未收尾的 ${ 各自进入时的花括号深度
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = i + 1 < text.length ? text[i + 1] : "";
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; i += 1; }
    } else if (state === "code") {
      if (c === "/" && n === "/") return true;
      if (c === "/" && n === "*") { state = "block"; i += 1; }
      else if (c === "/") return false;
      else if (c === "'" || c === "\"" || c === "`") state = c;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        if (exprDepths.length > 0 && exprDepths[exprDepths.length - 1] === depth) {
          exprDepths.pop();
          state = "`";
        } else depth -= 1;
      }
    } else if (c === "\\") i += 1;
    else if (state === "`" && c === "$" && n === "{") { exprDepths.push(depth); state = "code"; i += 1; }
    else if (c === state) state = "code";
  }
  return state !== "code";
}

// ===== 非 git 名单（按文件 + 数组前的锚定位；锚外的新 status 数组不豁免）=====

const NON_GIT_STATUS_ARRAYS = Object.freeze([
  {
    file: "src/cliHelp.js",
    anchor: /COMMAND_NAMES\s*=\s*Object\.freeze\(\s*$/,
    why: "wao 顶层 CLI 命令名清单（did-you-mean 提示闭集）：\"status\" 是用户可键入的 wao 子命令名，不是 git 参数",
  },
  {
    file: "src/application/runDrilldowns.js",
    anchor: /\breturn\s+$/,
    why: "run_* 工具的安全下钻建议名单：\"status\" 是 run_status 只读查询的 drilldown 名，不是 git 参数（各名单都是 return [...] 形态）",
  },
  {
    file: "scripts/reliability/componentLedger.mjs",
    anchor: /COMPOSITION_RESERVED_KEYS\s*=\s*$/,
    why: "组件台账组合层保留键名清单：\"status\" 是被禁用的 JSON 键名，不是 git 参数",
  },
]);

function nonGitListMatch(rel, code, open) {
  const before = code.slice(Math.max(0, open - 120), open);
  return NON_GIT_STATUS_ARRAYS.some((e) => e.file === rel && e.anchor.test(before));
}

// ===== 扫描与判定 =====

/**
 * 扫一段源码：status 参数数组站点（合规与否都在内），以及基座没当代码、单看本行
 * 却像代码的 "status" 元素（基座可能读错的位置）。
 */
function scanSource(src, file) {
  const { code, inString, balanced } = analyze(src);
  const sites = [];
  const blind = [];
  STATUS_ELEMENT.lastIndex = 0;
  for (let m = STATUS_ELEMENT.exec(src); m; m = STATUS_ELEMENT.exec(src)) {
    const p = m.index;
    const len = m[0].length;
    if (inString[p] || code[p] !== src[p]) {
      // 基座把它算进了字符串、模板、正则，或当注释剥掉了。
      if (rawElementShaped(src, p, len) && !explainedOnLine(src, p)) blind.push(lineOf(src, p));
      continue;
    }
    const { before, after } = neighbors(code, p, len);
    if (!(before === "[" || before === ",") || !(after === "," || after === "]")) continue;
    const span = arraySpan(code, inString, p);
    if (!span) continue;
    const elems = topLevelElements(code, inString, span.open, span.close);
    const statusAt = elems.findIndex((e) => /^(["'])status\1$/.test(e));
    const flagAt = elems.findIndex((e) => /^(["'])--no-optional-locks\1$/.test(e));
    sites.push({
      line: lineOf(src, p),
      flagged: flagAt >= 0 && flagAt < statusAt,
      nonGit: nonGitListMatch(file, code, span.open),
    });
  }
  return { balanced, sites, blind };
}

/**
 * 扫一段源码，返回全部违例：没在 "status" 前写旗的 git status 参数数组，以及
 * 基座没当代码、单看本行却像代码的 "status" 元素。
 * @returns {{file: string, line: number, message: string}[]}
 */
export function findViolations(src, file) {
  const { sites, blind } = scanSource(src, file);
  const unflagged = sites.filter((s) => !s.nonGit && !s.flagged).map((s) => ({
    file,
    line: s.line,
    message: `${file}:${s.line}: git status 参数数组没有在 "status" 之前写 "--no-optional-locks"——裸 git status 会刷新索引=写盘（拿 .git/index.lock），进程中断留残锁，交付打包 git add/commit 以 git_index_locked 失败。把它作为数组元素写在 "status" 前面（封装里前置的不算）。`,
  }));
  const misread = blind.map((line) => ({
    file,
    line,
    message: `${file}:${line}: 这个 "status" 数组元素，词法基座没把它当代码（算进了字符串、模板、正则或注释），单看这一行它却像代码。若它确在多行模板或多行注释里，换个写法避开（守卫分不出）；否则是基座在这之前读错了，先扩展 analyze 再信守卫。`,
  }));
  return [...unflagged, ...misread].sort((a, b) => a.line - b.line);
}

function scanTree() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walkJs(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
      files.push({ abs, rel });
    }
  }
  return files.map(({ abs, rel }) => {
    const src = readFileSync(abs, "utf8");
    const { balanced, sites } = scanSource(src, rel);
    return { rel, balanced, sites, violations: findViolations(src, rel) };
  });
}

// ===== 守卫 =====

test("守卫：src/ 与 scripts/ 的 git status 参数数组都在 status 前写了 --no-optional-locks（防残锁/git_index_locked）", () => {
  const perFile = scanTree();

  // 词法基座在每个文件都收得了尾，否则字符串掩码可能把真实站点当成字符串略过。
  assert.deepEqual(
    perFile.filter((f) => !f.balanced).map((f) => f.rel),
    [],
    "词法基座在这些文件里收不了尾（读完不在代码态，或 ${} / 括号没配平）：先扩展 analyze 再信守卫",
  );

  assert.deepEqual(
    perFile.flatMap((f) => f.violations.map((v) => v.message)),
    [],
    "发现没带 --no-optional-locks 的 git status",
  );

  // 扫描器活性下限：防全树静默失明（当前树 11 个站点；不钉精确数，正常增删站点不误红）。
  const sites = perFile.flatMap((f) => f.sites.filter((s) => !s.nonGit));
  assert.ok(sites.length >= 8, `git status 站点数下限 8，实测 ${sites.length}——扫描器疑似失明`);
});

// ===== 负证（全部必须判红）=====

test("负证：去掉真实源码调用处的旗必判红，封装里前置的不算", () => {
  const del = readFileSync(join(REPO_ROOT, "src/delivery.js"), "utf8");
  const delMut = del.replace('["--no-optional-locks", "status"', '["status"');
  assert.notEqual(delMut, del, "变异锚点须命中真实调用");
  assert.equal(findViolations(delMut, "src/delivery.js").length, 1, "去掉打包读取的旗必须判红");

  // isolation.js 的缺省 git（defaultTerminalGit）自己也前置旗，但守卫只认调用处。
  const iso = readFileSync(join(REPO_ROOT, "src/isolation.js"), "utf8");
  const isoMut = iso.replace('"--no-optional-locks", "status", "--porcelain=v1"', '"status", "--porcelain=v1"');
  assert.notEqual(isoMut, iso, "变异锚点须命中真实调用");
  assert.equal(findViolations(isoMut, "src/isolation.js").length, 1, "只靠封装前置旗必须判红");
});

test("负证：裸数组、短旗、旗藏注释、旗在 status 之后、在嵌套表达式或展开里、在字符串里 → 全红", () => {
  const bad = [
    ["裸 [\"status\"]", 'spawnSync("git", ["status"], { cwd });'],
    ["[\"status\", \"-s\"]", 'spawnSync("git", ["status", "-s"], { cwd });'],
    ["旗藏在注释里", 'spawnSync("git", ["status", "--porcelain" /* "--no-optional-locks" */], { cwd });'],
    ["旗在 status 之后", 'spawnSync("git", ["status", "--no-optional-locks"], { cwd });'],
    ["旗在嵌套表达式里", 'spawnSync("git", ["status", pick("--no-optional-locks")], { cwd });'],
    ["旗在展开里", 'spawnSync("git", [...LOCK_FLAGS, "status"], { cwd });'],
    ["旗在字符串里", "spawnSync(\"git\", ['\"--no-optional-locks\"', \"status\"], { cwd });"],
    [
      "后缀 ++ 之后的除号里",
      'function progress(stats, cwd) {\n  return stats.checked++ / execFileSync("git", ["status", "--porcelain"], { cwd }).length;\n}\n',
    ],
    [
      "模板 ${} 里关键字属性名之后的除号里",
      'const summary = `Ratio ${stats.in / execFileSync("git", ["status", "--porcelain"], { cwd }).length / total}`;\n',
    ],
    [
      "同行正则里有引号、其后关键字属性名之后的除号里",
      'const ratio = /"/.test(label) ? stats.in / execFileSync("git", ["status", "--porcelain"], { cwd }).length : 0;\n',
    ],
    [
      "行首乘号、中文属性名之后的除号里",
      'const percentage = 100\n  * stats.已处理 / execFileSync("git", ["status", "--porcelain"], {\n    cwd, encoding: "utf8"\n  }).trim().split("\\n").length;\n',
    ],
  ];
  for (const [label, src] of bad) {
    const v = findViolations(src, "src/madeup.js");
    assert.equal(v.length, 1, `${label} 必须判红`);
    assert.match(v[0].message, /--no-optional-locks/);
    assert.match(v[0].message, /git_index_locked/);
  }
});

test("负证：正则里的反引号或 /*、${} 里嵌模板、条件括号与块收尾与 continue 之后的正则，夹在中间的裸 status 照样判红", () => {
  // 这些形态都曾让基座把此后的代码当成模板或注释（scripts/gen-surface.mjs 有嵌模板；
  // 后几种是复核给的反例）。站点前带一行注释：数组里写说明是常见写法。
  const statusBlock = ['execFileSync("git", [', "  // 读取工作树状态", '  "status", "--porcelain"', "]);"].join("\n");
  const cases = [
    ["正则里的反引号", "const r = /`/g;", "const r2 = /`/g;"],
    ["模板 ${} 里嵌模板", "const note = `x ${list.map((e) => `\\`${e}\\``).join(\", \")} y`;", "const tail = `z`;"],
    ["if (…) 之后的正则", "if (true) /`/.test(\"x\");", "if (true) /`/.test(\"y\");"],
    ["块收尾之后的正则里的反引号", "function f() {}\n/`/.test(\"x\");", "/`/.test(\"y\");"],
    ["块收尾之后的正则字符类里的 /*", "function f() {}\n/[/*]/.test(\"x\");", "/[*/]/.test(\"y\");"],
    [
      "for await (…) 之后的正则",
      "async function g(s) {\n  for await (const line of s)\n    /[/*]/.test(line) && mark(line);",
      "  /[*/]/.test(tail) && mark(tail);\n}",
    ],
    [
      "continue 之后另起一行的正则",
      "for (const line of lines) {\n  if (!line) continue\n  /[/*]/.test(line);\n}",
      "/[*/]/.test(tail);",
    ],
    [
      "带标签的 continue 之后另起一行的正则",
      "repos: for (const repo of repositories) {\n  for (const path of repo.paths) {\n    if (!path) continue repos\n    /`/.test(path) && warnings.push(path);",
      "    rows.push(\"`\");\n  }\n}",
    ],
  ];
  for (const [label, before, after] of cases) {
    const src = [before, statusBlock, after].join("\n");
    assert.equal(analyze(src).balanced, true, `${label}：基座应收得了尾`);
    const v = findViolations(src, "src/madeup.js");
    assert.equal(v.length, 1, `${label}：夹在中间的裸 status 必须判红`);
    assert.equal(v[0].line, before.split("\n").length + 3);
    assert.doesNotMatch(v[0].message, /读错/, `${label}：应当认作真实站点`);
  }
});

test("负证：基座没当代码、单看本行却像代码的 status 元素 → 红；文件收不了尾 → 红", () => {
  // 不论是真的多行模板、多行注释，还是基座读错开出来的，守卫都分不出，一律判红。
  const samples = [
    ["模板里、前面夹注释", ["const s = 1 / `;", 'execFileSync("git", [', "  // 读取工作树状态", '  "status", "--porcelain"', "]);", "const t = `;"], 4],
    ["模板里、后面跟尾注释", ["const s = 1 / `;", 'execFileSync("git", [', '  "status" /* 子命令 */, "--porcelain"', "]);", "const t = `;"], 3],
    ["模板里、行首是已闭合的块注释", ["const s = 1 / `;", 'execFileSync("git", [', '  /* subcommand */ "status", "--porcelain"', "]);", "const t = `;"], 3],
    ["不带 * 前缀的块注释里", ["const s = 1 / /*", 'execFileSync("git", ["status", "--porcelain"]);', "*/ 2;"], 2],
    // 基座在同一行里把除号猜成正则（对象字面量的 } 之后）：按行复核不猜正则，不跟着错。
    ["对象字面量之后的除号", ['const ratio = {} / execFileSync("git", ["status", "--porcelain"]).length;', "const done = true;"], 1],
    ["行首乘号、对象字面量之后的除号", ["const ratio = 100", '  * {} / execFileSync("git", ["status", "--porcelain"]).length;', "const done = true;"], 2],
  ];
  for (const [label, lines, line] of samples) {
    const src = lines.join("\n");
    assert.equal(analyze(src).balanced, true, `${label}：基座应收得了尾`);
    const v = findViolations(src, "src/madeup.js");
    assert.equal(v.length, 1, `${label} 必须判红`);
    assert.equal(v[0].line, line);
    assert.match(v[0].message, /读错/);
  }
  assert.equal(analyze("const a = `x;\nconst b = 1;\n").balanced, false, "未闭合的模板字面量");
  assert.equal(analyze("function f() {\n").balanced, false, "花括号没配平");
  assert.equal(analyze("f((1);\n").balanced, false, "圆括号没配平");
});

// ===== 正证 =====

test("正证：调用处写了旗合规；注释行、本行引号与模板里的 status 形态不判红", () => {
  const good = [
    'const a = spawnSync("git", ["--no-optional-locks", "status", "--porcelain"], { cwd });',
    'const b = spawnSync("git", ["-C", dir, "--no-optional-locks", "status"], { cwd });',
    '// const bad = spawnSync("git", ["status", "--porcelain"], { cwd });',
    "/* [\"status\"] */",
    "const data = '[\"status\", \"--porcelain\"]';",
    "const payload = `{\"kind\": \"status\", \"ok\": true}`;",
    "const help = `Run git with \"status\", then inspect output.`;",
  ].join("\n");
  assert.equal(analyze(good).balanced, true);
  assert.deepEqual(findViolations(good, "sample-ok.js"), []);
});

test("正证：非 git 名单（CLI 命令名/drilldown 名单/台账键名）不判红；名单锚外的新数组不豁免", () => {
  for (const entry of NON_GIT_STATUS_ARRAYS) {
    const src = readFileSync(join(REPO_ROOT, entry.file), "utf8");
    assert.deepEqual(findViolations(src, entry.file), [], `${entry.file} 的名单不应判红`);
  }
  assert.equal(
    findViolations('const out = g(["status"]);', "src/application/runDrilldowns.js").length,
    1,
    "return 形态之外的 status 数组不享受 drilldown 名单豁免",
  );
});
