// src/application/manual.js
//
// 使用手册（docs/usage.md 地图 + docs/usage/*.md 各页）的解析与按节读取（决定 0115）。
// `wao manual` 命令、gen-surface 的地图页表生成与 docs-consistency 的指针守卫共用
// 这一个模块，别处不写第二份解析。
//
// 页首 frontmatter 只认一种形状（三行）：
//   ---
//   read_when: <非空单行>
//   ---
// 多键、多行、空值、缺失一律 ManualError("frontmatter-invalid")，reason 取闭集
// FRONTMATTER_REASONS。容忍 UTF-8 BOM 与 CRLF。
//
// 节 = 二、三级 `#` 标题：二级节含其下三级节，到下一个二级或更高标题为止；三级节
// 到下一个三级或更高标题为止。代码围栏（``` 或 ~~~ 开栏，只有同一字符、长度不短于
// 开栏的那一行才收栏）里的行不算标题。节名匹配按去掉 Markdown 行内标记（反引号、
// 强调、链接）后的标题：查询完全相同者优先，否则按子串（不区分大小写），唯一命中
// 才算数；多命中列出候选、零命中报错（闭集 code）。字节数一律按原始 UTF-8 字节。
//
// 手册根不看 cwd、也不依赖 WAO_INSTALL_ROOT：由本模块自身的 import.meta.url 推出
// 安装根（同 feedbackInbox.js 的 defaultPackageRoot——scripts/wao-cli.cmd 不注入
// WAO_INSTALL_ROOT，而全局 `wao`（bin/wao.js）本来就是从代码位置派生它，两侧一致）。
//
// 架构契约：application 层服务，文件系统可注入（deps.fs / deps.packageRoot）；
// 不 import src/commands/**、src/mcp/**、SDK、zod，不联网、不写文件。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 手册页目录（安装根相对）。 */
export const MANUAL_PAGES_DIR = "docs/usage";

/** frontmatter 不合格的原因闭集（守卫与命令按 reason 分支，不 parse 文案）。 */
export const FRONTMATTER_REASONS = Object.freeze([
  "missing", // 文件开头不是 ---
  "multi-key", // read_when 之外还有别的键（第二行或第三行）
  "read-when-missing", // 第二行不是 read_when: 形状
  "empty-value", // read_when 值为空
  "unterminated", // 第三行不是 ---（多行值等，且不是 key: value 形状）
]);

/** 具名错误：code 是闭集（消费者按 code 分支，不 parse 文案）。 */
export class ManualError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ManualError";
    this.code = code;
  }
}

/** WAO 代码所在检出的根（模块自身位置推出——不看 cwd，不看 WAO_INSTALL_ROOT）。 */
export function defaultManualRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function defaultFs(io = {}) {
  return {
    existsSync: io.existsSync ?? existsSync,
    readdirSync: io.readdirSync ?? readdirSync,
    readFileSync: io.readFileSync ?? readFileSync,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯解析
// ─────────────────────────────────────────────────────────────────────────────

/** 一行 = { start, end }（end 不含换行符）＋去 BOM/CRLF 后的内容 text。 */
function splitLines(text) {
  const lines = [];
  let start = 0;
  while (start <= text.length) {
    if (start === text.length) {
      lines.push({ start, end: start, text: "" });
      break;
    }
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      lines.push({ start, end: text.length, text: text.slice(start) });
      break;
    }
    let end = nl;
    if (end > start && text[end - 1] === "\r") end -= 1;
    lines.push({ start, end, text: text.slice(start, end) });
    start = nl + 1;
  }
  return lines;
}

/**
 * 标题去掉 Markdown 行内标记（反引号、强调、链接）后用于节名匹配。
 * 下划线/星号只按成对强调剥离，且两侧不是字母数字——isolation_failed、run_wait
 * 这类标识符里的下划线不是强调，不能剥。
 * 查询侧做同一次去标记（决定 0115 续修）：`wao manual <页>` 列出的节标题带反引号，
 * 照抄回查询必须能命中。
 */
function stripInlineMarkdown(text) {
  return String(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接 → 链接文字
    .replace(/`+/g, "") // 反引号（代码围栏标记不进节名）
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<![A-Za-z0-9\\])\*([^*\s][^*]*?)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<![A-Za-z0-9\\])_([^_\s][^_]*?)_(?![A-Za-z0-9])/g, "$1")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 代码围栏判定（单一实现，节解析与 docs-consistency 的链接检查共用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一行的围栏标记（开栏/收栏共用的形状识别）：行首（允许缩进）的 ``` 或 ~~~ 串。
 * 无标记 → null；有则 { chars, info }——info 是围栏串后的余文（开栏时的语言
 * 信息串）。收栏必须是纯收栏行（见 isPureFenceCloser）：带信息串的行（如
 * ```js）只会开栏，不会收栏。
 */
export function fenceMarkerOf(lineText) {
  const m = String(lineText).match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  return { chars: m[1], info: m[2].trim() };
}

/**
 * marker 是否是把 chars 为 openChars 的围栏**收掉**的纯收栏行：同字符、不短于
 * 开栏、且围栏串之后只剩空白（info 为空）。带信息串的行（```js）不收栏。
 */
export function isPureFenceCloser(marker, openChars) {
  return marker !== null
    && marker.info === ""
    && marker.chars[0] === openChars[0]
    && marker.chars.length >= openChars.length;
}

/** 行是不是标题；是则给 { level, text }（一至六级，# 后必须有空白）。 */
function headingOf(line) {
  const m = line.text.match(/^(#{1,6})[ \t]+(\S.*?)[ \t]*$/);
  if (!m) return null;
  return { level: m[1].length, text: m[2] };
}

/**
 * 解析一个手册页（纯函数）。返回：
 *   { name, text, title, readWhen, titleStart, sections }（titleStart = 页标题行起点），
 * sections[i] = { level, heading, key, startOffset, endOffset, bytes }——
 * startOffset/endOffset 是 text 里的字符区间（含标题行、到下一标题行之前，含尾随
 * 空行）；bytes 是该区间的原始 UTF-8 字节数。frontmatter 不合格或第一行非空内容
 * 不是 `# ` 标题 → ManualError（code: frontmatter-invalid / title-missing）。
 */
export function parseManualPage(name, text) {
  const lines = splitLines(text);
  // BOM 只影响第一行内容判等，不移动偏移；输出按原文切片，BOM 字节照保留。
  const line0 = lines[0].text.startsWith("\uFEFF") ? lines[0].text.slice(1) : lines[0].text;
  const frontmatterFail = (reason, hint) => new ManualError("frontmatter-invalid",
    `docs/usage/${name}.md 页首 frontmatter 不合格（${reason}）：只认 --- / read_when: <非空单行> / --- 这一种形状${hint ? `；${hint}` : ""}`);

  if (line0 !== "---") throw frontmatterFail("missing", "文件开头必须是 ---");
  const keyLine = lines[1]?.text ?? "";
  const kv = keyLine.match(/^(read_when):[ \t]*(.*)$/);
  if (!kv) {
    if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(keyLine)) throw frontmatterFail("multi-key", "只认 read_when 一个键");
    throw frontmatterFail("read-when-missing", "第二行必须是 read_when: <值>");
  }
  const readWhen = kv[2].trim();
  if (readWhen.length === 0) throw frontmatterFail("empty-value", "read_when 的值不能为空");
  if ((lines[2]?.text ?? "") !== "---") {
    // 第三行又是一个 key: value → 是第二个键（multi-key），不是值写漏了收栏。
    if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(lines[2]?.text ?? "")) {
      throw frontmatterFail("multi-key", "只认 read_when 一个键（第三行必须是 ---）");
    }
    throw frontmatterFail("unterminated", "第三行必须是 ---（值只能占一行）");
  }

  // 第一行非空内容必须是 `# ` 页标题。
  let titleLine = -1;
  for (let i = 3; i < lines.length; i += 1) {
    if (lines[i].text.trim().length === 0) continue;
    const h = headingOf(lines[i]);
    if (h && h.level === 1) titleLine = i;
    break;
  }
  if (titleLine === -1) {
    throw new ManualError("title-missing",
      `docs/usage/${name}.md frontmatter 之后的第一行非空内容必须是 "# " 页标题`);
  }
  const title = headingOf(lines[titleLine]).text;

  const sections = [];
  let fence = null; // 开栏标记串（``` 或 ~~~+）；null = 不在围栏里
  for (let i = titleLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = fenceMarkerOf(line.text);
    if (fence === null) {
      if (marker) fence = marker.chars; // 开栏（可带语言信息串）
      if (marker) continue;
    } else {
      // 围栏内：只有纯收栏行（同字符、不短于开栏、后随仅空白）才收栏——
      // 带信息串的行（```js）不收栏。
      if (marker && isPureFenceCloser(marker, fence)) fence = null;
      continue; // 围栏里的行（含收栏行）不判标题
    }
    const h = headingOf(line);
    if (!h || h.level > 3) continue; // 只收二、三级；四至六级不切节
    // 新标题收掉一切同层或更高层的未收节（区间终点 = 新标题行的起点）；已收的
    // 不改写——从表尾向前走到第一个层级更低的祖先为止。
    for (let k = sections.length - 1; k >= 0 && h.level <= sections[k].level; k -= 1) {
      if (sections[k].endOffset === undefined) sections[k].endOffset = line.start;
    }
    sections.push({
      level: h.level,
      heading: h.text,
      key: stripInlineMarkdown(h.text),
      startOffset: line.start,
      endOffset: undefined,
      bytes: undefined,
    });
  }
  for (const s of sections) {
    if (s.endOffset === undefined) s.endOffset = text.length;
    s.bytes = Buffer.byteLength(text.slice(s.startOffset, s.endOffset), "utf8");
  }
  return {
    name,
    text,
    title,
    readWhen,
    bytes: Buffer.byteLength(text, "utf8"),
    titleStart: lines[titleLine].start,
    sections,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 索引读取与解析（fs 可注入）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读整本手册索引：docs/usage/ 下每个 .md 页 → 完整解析结果（含 sections），
 * 按页名排序。任何一页 frontmatter/标题不合格 → ManualError（fail-loud，不降级）。
 *
 * @param {{packageRoot?: string, fs?: object}} [deps]
 * @returns {{ root: string, pages: Array<object> }}
 */
export function readManualIndex(deps = {}) {
  const fs = defaultFs(deps.fs);
  const root = typeof deps.packageRoot === "string" && deps.packageRoot.length > 0
    ? deps.packageRoot
    : defaultManualRoot();
  const dir = join(root, MANUAL_PAGES_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    throw new ManualError("manual-unreadable",
      `使用手册页目录读不出: ${dir}（安装根 ${root}；manual 从安装根读手册，不看当前目录）`);
  }
  const pages = [];
  for (const fileName of names.filter((n) => n.endsWith(".md")).sort()) {
    const path = join(dir, fileName);
    const text = fs.readFileSync(path, "utf8");
    pages.push({ ...parseManualPage(fileName.replace(/\.md$/, ""), text), path });
  }
  if (pages.length === 0) {
    throw new ManualError("manual-unreadable", `使用手册一页都没有: ${dir}`);
  }
  return { root, pages };
}

/** 按页名（= 文件名去 .md）取页；页名只能来自实际页清单，不拼接用户给的路径。 */
export function findManualPage(index, name) {
  const page = index.pages.find((p) => p.name === name);
  if (page) return page;
  throw new ManualError("page-not-found",
    `没有这一页手册页: ${name}（可用页: ${index.pages.map((p) => p.name).join(", ")}）`);
}

/** 候选清单（守卫与命令的错误信息共用一个渲染）。 */
function listSections(sections) {
  return sections.map((s) => `${"#".repeat(s.level)} ${s.key}`).join(" / ");
}

/**
 * 节名匹配：查询与标题都做同一次去 Markdown 行内标记后比较——`wao manual <页>`
 * 列出的节标题带反引号，照抄回去必须能命中。完全相同 → 取它；否则按子串（不
 * 区分大小写）唯一命中才取。零命中（含显式空串：按零命中报错，非零退出）→
 * section-not-found（列出该页全部节）；多命中（含多个完全相同）→
 * section-ambiguous（只列出命中的候选）。
 */
export function resolveManualSection(page, query) {
  const q = stripInlineMarkdown(String(query));
  if (q.length === 0) {
    // 显式空查询先于一切匹配按零命中处理：若某节标题去标记后为空，"" 不得被
    // 当成完全匹配而成功，也绝不能走子串分支（空串 includes 命中一切）。
    throw new ManualError("section-not-found",
      `${page.name} 没有节匹配 ""；该页的节: ${listSections(page.sections)}`);
  }
  const exact = page.sections.filter((s) => s.key === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new ManualError("section-ambiguous",
      `"${q}" 与 ${page.name} 的多个节完全同名，无法区分: ${listSections(exact)}`);
  }
  const lower = q.toLowerCase();
  const hits = page.sections.filter((s) => s.key.toLowerCase().includes(lower));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new ManualError("section-ambiguous",
      `"${q}" 命中 ${page.name} 的多个节（加长查询到唯一）: ${listSections(hits)}`);
  }
  throw new ManualError("section-not-found",
    `${page.name} 没有节匹配 "${q}"；该页的节: ${listSections(page.sections)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 手册指针抽取（守卫用；与节名匹配共用同一个解析器）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从任意文本（源码、注释、Markdown）里抽出 `wao manual <页> [<节>]` 指针。
 * 节名两种形状都认：裸引号 `"节名"`（模板串/单引号串/Markdown）与转义引号
 * `\"节名\"`（JS 双引号字符串源码文本）——守卫只核到页名、漏核节名多半就是
 * 转义形状没认出来。返回 [{ page, section }]，section 为 undefined = 只指页。
 */
export function extractManualPointers(text) {
  const out = [];
  for (const m of String(text).matchAll(/wao manual ([a-z0-9][a-z0-9-]*)(?:[ \t]+(?:"([^"\\]+)"|\\"([^"\\]+)\\"))?/g)) {
    out.push({ page: m[1], section: m[2] ?? m[3] });
  }
  return out;
}

/**
 * 指针覆盖互检（docs-consistency 守卫调用）：语法上带节名的 `wao manual` 指针
 * （页名后跟裸引号或转义引号 \"——后者是 JS 双引号串源码文本）出现次数，必须等于
 * extractManualPointers 实际核到节的指针数。数目不一致（如转义/未闭合引号形状没被
 * 抽取器认出）返回 matches:false——这钉住"只核到页名"的漏认形状（转义引号曾漏认
 * 8 处）；删掉互检会让守卫失明，单元测试同时变红。
 */
export function manualPointerCoverageMatches(text) {
  const source = String(text);
  const found = extractManualPointers(source);
  const syntactic = [...source.matchAll(/wao manual [a-z0-9][a-z0-9-]*[ \t]+(?:"|\\")/g)].length;
  const checked = found.filter((p) => p.section !== undefined).length;
  return { matches: checked === syntactic, syntactic, checked };
}
