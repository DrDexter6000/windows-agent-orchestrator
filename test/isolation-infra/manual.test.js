// test/isolation-infra/manual.test.js
//
// 决定 0115：`wao manual` 解析模块（src/application/manual.js）的定向测试。
// 覆盖：未知页、未知节（零命中）、多命中、完全相同优先、代码围栏里的伪标题、
// 二级节含三级节、BOM 与 CRLF、frontmatter 畸形（reason 闭集）、从任意 cwd 调用
// 都读安装根（不看 cwd）、CLI 输出字节与源文件一致。
//
// 纯测试：夹具在 os.tmpdir()（显式绝对路径），零子进程、零 git、零网络；
// 解析器的畸形输入直接喂字符串（parseManualPage 是纯函数）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FRONTMATTER_REASONS,
  ManualError,
  defaultManualRoot,
  extractManualPointers,
  findManualPage,
  parseManualPage,
  readManualIndex,
  resolveManualSection,
} from "../../src/application/manual.js";
import { manualCommand } from "../../src/commands/manual.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const ALPHA = [
  "---",
  "read_when: 何时读 alpha",
  "---",
  "# Alpha",
  "",
  "> [使用手册](../usage.md)",
  "",
  "## 第二节：独特",
  "",
  "alpha body",
  "",
  "### 嵌套小节",
  "",
  "nested body",
  "",
  "## Zebra 节",
  "",
  "zebra body",
  "",
].join("\n");

const FENCE = [
  "---",
  "read_when: 围栏页",
  "---",
  "# Fence",
  "",
  "## 真节",
  "",
  "```text",
  "## 伪标题（围栏里）",
  "### 也是伪的",
  "```",
  "",
  "~~~",
  "## 波浪围栏里的伪标题",
  "~~~",
  "",
  "## 收尾真节",
  "",
  "tail body",
  "",
].join("\n");

const EXACT = [
  "---",
  "read_when: 完全相同优先页",
  "---",
  "# Exact",
  "",
  "## 场景 X",
  "",
  "x body",
  "",
  "## 场景 X 续",
  "",
  "x2 body",
  "",
].join("\n");

// 围栏收栏：只有纯收栏行（同字符、不短于开栏、后随仅空白）才收栏——
// 带信息串的 ```js / ~~~js 行不收栏（开栏可以带信息串）。
const FENCE_INFO = [
  "---",
  "read_when: 围栏信息串页",
  "---",
  "# FenceInfo",
  "",
  "## 真节一",
  "",
  "```",
  "## 伪一（围栏内）",
  "```js",
  "## 伪二（信息串行不收栏，仍算围栏内）",
  "```",
  "",
  "## 真节二",
  "",
  "~~~",
  "## 伪三（波浪围栏内）",
  "~~~js",
  "## 伪四（信息串行不收栏）",
  "~~~",
  "",
  "## 真节三",
  "",
  "tail",
  "",
].join("\n");

// 查询照抄命中：节标题带行内 Markdown 标记（反引号/强调/链接），列节输出照抄
// 回查询必须唯一命中（查询侧做同一次去标记）。
const MARKED = [
  "---",
  "read_when: 带标记页",
  "---",
  "# Marked",
  "",
  "## MCP `run_status`（即时查询）",
  "",
  "body",
  "",
  "## 带 **强调** 与 [链接](https://example.invalid) 的标题",
  "",
  "body2",
  "",
].join("\n");

/** 建一个最小手册根（os.tmpdir() 下显式绝对路径），返回根目录。 */
function makeManualRoot() {
  const root = mkdtempSync(join(tmpdir(), "wao-manual-"));
  mkdirSync(join(root, "docs", "usage"), { recursive: true });
  writeFileSync(join(root, "docs", "usage.md"), "# 地图\n", "utf8");
  writeFileSync(join(root, "docs", "usage", "alpha.md"), ALPHA, "utf8");
  writeFileSync(join(root, "docs", "usage", "fence.md"), FENCE, "utf8");
  writeFileSync(join(root, "docs", "usage", "exact.md"), EXACT, "utf8");
  writeFileSync(join(root, "docs", "usage", "fenceinfo.md"), FENCE_INFO, "utf8");
  writeFileSync(join(root, "docs", "usage", "marked.md"), MARKED, "utf8");
  return root;
}

/** BOM + CRLF 页（字节层面手工拼，别让编辑器把 \r\n 洗掉）。 */
function writeCrlfPageBytes(root) {
  const body = [
    "---",
    "read_when: CRLF 页何时读",
    "---",
    "# CRLF 页",
    "",
    "## CRLF 节",
    "",
    "crlf body",
    "",
    "## CRLF 第二节",
    "",
    "tail",
    "",
  ].join("\r\n");
  const path = join(root, "docs", "usage", "crlf.md");
  writeFileSync(path, Buffer.concat([Buffer.from("\uFEFF", "utf8"), Buffer.from(body, "utf8")]));
  return path;
}

/** 捕获 process.stdout.write 的原始字节（console.log 也走它）。 */
async function captureStdoutBytes(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return Buffer.concat(chunks);
}

function assertManualError(fn, code) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ManualError, `应抛 ManualError（实得 ${caught?.constructor?.name}: ${caught?.message}）`);
  assert.equal(caught.code, code, `code 应为 ${code}（实得 ${caught.code}）`);
  return caught;
}

// ─── 索引与节结构 ───────────────────────────────────────────────────────────

test("索引：页按名排序，read_when/标题/节清单来自解析", () => {
  const root = makeManualRoot();
  try {
    const index = readManualIndex({ packageRoot: root });
    assert.deepEqual(index.pages.map((p) => p.name), ["alpha", "exact", "fence", "fenceinfo", "marked"]);
    const alpha = findManualPage(index, "alpha");
    assert.equal(alpha.title, "Alpha");
    assert.equal(alpha.readWhen, "何时读 alpha");
    assert.deepEqual(
      alpha.sections.map((s) => [s.level, s.key]),
      [[2, "第二节：独特"], [3, "嵌套小节"], [2, "Zebra 节"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("二级节含其下三级节：区间、字节数与文本都覆盖嵌套节", () => {
  const root = makeManualRoot();
  try {
    const alpha = findManualPage(readManualIndex({ packageRoot: root }), "alpha");
    const outer = resolveManualSection(alpha, "第二节：独特");
    const nested = resolveManualSection(alpha, "嵌套小节");
    const outerText = alpha.text.slice(outer.startOffset, outer.endOffset);
    assert.ok(outerText.includes("### 嵌套小节"), "二级节文本应包含三级节标题行");
    assert.ok(outerText.includes("nested body"), "二级节文本应包含三级节正文");
    assert.ok(outer.startOffset < nested.startOffset && nested.endOffset <= outer.endOffset,
      "三级节区间落在二级节区间内");
    assert.ok(outer.bytes > nested.bytes, "二级节字节数大于其嵌套三级节");
    assert.equal(outer.bytes, Buffer.byteLength(outerText, "utf8"), "节字节数 = 区间原始 UTF-8 字节");
    // 三级节到下一个二级标题为止（不吃进 "## Zebra 节"）。
    assert.ok(!alpha.text.slice(nested.startOffset, nested.endOffset).includes("Zebra"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("代码围栏里的伪标题不算节（``` 与 ~~~ 都收）", () => {
  const root = makeManualRoot();
  try {
    const fence = findManualPage(readManualIndex({ packageRoot: root }), "fence");
    assert.deepEqual(
      fence.sections.map((s) => s.key),
      ["真节", "收尾真节"],
      "围栏里的 ##/### 不得成为节",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("收栏只认纯收栏行：带信息串的 ```js / ~~~js 不收栏（合成页）", () => {
  const root = makeManualRoot();
  try {
    const page = findManualPage(readManualIndex({ packageRoot: root }), "fenceinfo");
    assert.deepEqual(
      page.sections.map((s) => s.key),
      ["真节一", "真节二", "真节三"],
      "信息串行不收栏：其后伪标题仍在围栏内，真收栏行后的节照常解析",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("列出的节名照抄回去要能命中（查询与标题做同一次去标记）", () => {
  const root = makeManualRoot();
  try {
    const index = readManualIndex({ packageRoot: root });
    const page = findManualPage(index, "marked");
    // 列节输出的是原始标题（带反引号/强调/链接），原样当查询：
    const headingRaw = page.sections[0].heading;
    assert.ok(headingRaw.includes("`"), "夹具自检：标题应带反引号");
    assert.equal(resolveManualSection(page, headingRaw).heading, headingRaw, "照抄带标记标题唯一命中");
    const markedRaw = page.sections[1].heading;
    assert.ok(markedRaw.includes("**") && markedRaw.includes("[链接]"), "夹具自检：标题应带强调与链接");
    assert.equal(resolveManualSection(page, markedRaw).heading, markedRaw, "照抄带强调/链接标题唯一命中");
    // 真仓同款：supervise 的 “MCP `run_status`（即时状态查询）”。
    const realIndex = readManualIndex({ packageRoot: ROOT });
    const supervise = findManualPage(realIndex, "supervise");
    const realRaw = supervise.sections.find((s) => s.heading.includes("run_status")).heading;
    assert.equal(resolveManualSection(supervise, realRaw).heading, realRaw, "真仓标题照抄回查询命中");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("指针抽取：转义形状 \"节名\" 也核到节；不存在的节名解析必红（守卫负向）", () => {
  const root = makeManualRoot();
  try {
    // JS 双引号串源码文本：节名两侧是 \" ——旧守卫正则只核到页名，这里必须核到节。
    const src = 'throw new Error("见 wao manual lanes \\"不存在之节\\"");';
    assert.deepEqual(
      extractManualPointers(src),
      [{ page: "lanes", section: "不存在之节" }],
      "转义形状的节名必须被抽取出来",
    );
    assert.deepEqual(
      extractManualPointers('x = `wao manual supervise "等待到收口"`'),
      [{ page: "supervise", section: "等待到收口" }],
      "裸引号形状（模板串/Markdown）照常抽取",
    );
    assert.deepEqual(
      extractManualPointers("authority = wao manual host"),
      [{ page: "host", section: undefined }],
      "只指页的指针 section 为 undefined",
    );
    // 负向实验：把转义形状指针的节名换成不存在的节，经同一解析器解析必须抛——
    // docs-consistency 的指针守卫用的正是这对抽取+解析，红在这里等于守卫会红。
    const index = readManualIndex({ packageRoot: root });
    const alpha = findManualPage(index, "alpha");
    assert.throws(
      () => resolveManualSection(alpha, extractManualPointers(src)[0].section),
      (err) => err instanceof ManualError && err.code === "section-not-found",
      "不存在的节名必须解析失败（守卫负向）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("显式空节名按零命中处理（非零退出）；未知旗标报错且其值不当节名", async () => {
  const root = makeManualRoot();
  try {
    // "" 显式给了节名：报错退出，绝不落回列节分支（列节分支首行是 read_when: …）。
    await assert.rejects(
      () => manualCommand(["alpha", ""], {}, { packageRoot: root }),
      (err) => /没有节匹配 ""/.test(err.message),
    );
    // 未知旗标：报错；跟在后面的值（json）不得被当成节名去解析。
    await assert.rejects(
      () => manualCommand(["lanes", "--format", "json"], {}, { packageRoot: root }),
      (err) => /不认识旗标 --format（只认 --all）/.test(err.message) && !/没有节匹配/.test(err.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 匹配语义 ───────────────────────────────────────────────────────────────

test("完全相同优先：查询等于某标题时取它，即使它也是别标题的子串", () => {
  const root = makeManualRoot();
  try {
    const exact = findManualPage(readManualIndex({ packageRoot: root }), "exact");
    const hit = resolveManualSection(exact, "场景 X");
    assert.equal(hit.heading, "场景 X", "完全相同优先于子串匹配");
    // 不带引号整词时（子串）才会歧义。
    assertManualError(() => resolveManualSection(exact, "场景"), "section-ambiguous");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未知节（零命中）报错并列出该页全部节", () => {
  const root = makeManualRoot();
  try {
    const alpha = findManualPage(readManualIndex({ packageRoot: root }), "alpha");
    const err = assertManualError(() => resolveManualSection(alpha, "不存在的节"), "section-not-found");
    assert.ok(err.message.includes("第二节：独特"), "错误里应列出可用节");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("多命中报错并点名候选（非零退出的文案面）", () => {
  const root = makeManualRoot();
  try {
    const alpha = findManualPage(readManualIndex({ packageRoot: root }), "alpha");
    const err = assertManualError(() => resolveManualSection(alpha, "节"), "section-ambiguous");
    assert.ok(err.message.includes("第二节：独特") && err.message.includes("Zebra 节"),
      "错误里应点名全部命中候选");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未知页报错并列出可用页；页名不做路径拼接", () => {
  const root = makeManualRoot();
  try {
    const index = readManualIndex({ packageRoot: root });
    const err = assertManualError(() => findManualPage(index, "../usage"), "page-not-found");
    assert.ok(err.message.includes("alpha"), "错误里应列出可用页");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── BOM 与 CRLF、字节一致 ─────────────────────────────────────────────────

test("BOM 与 CRLF 页照常解析；节输出字节与源文件逐字节一致", () => {
  const root = makeManualRoot();
  try {
    const path = writeCrlfPageBytes(root);
    const raw = readFileSync(path);
    const index = readManualIndex({ packageRoot: root });
    const page = findManualPage(index, "crlf");
    assert.equal(page.readWhen, "CRLF 页何时读", "BOM+CRLF 下 frontmatter 照常解析");
    assert.equal(page.text, raw.toString("utf8"), "解析不改动原文");
    const section = resolveManualSection(page, "CRLF 节");
    const sectionBytes = Buffer.from(page.text.slice(section.startOffset, section.endOffset), "utf8");
    // 期望值直接从源 Buffer 切：按解码前缀的 UTF-8 字节长度定位区间。
    const prefixBytes = Buffer.byteLength(page.text.slice(0, section.startOffset), "utf8");
    assert.ok(sectionBytes.equals(raw.subarray(prefixBytes, prefixBytes + sectionBytes.length)),
      "节区间再编码与源文件对应字节段逐字节相等");
    assert.ok(sectionBytes.includes(Buffer.from("crlf body\r\n", "utf8")), "CRLF 原样保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI manual <页> --all 的正文输出与源文件逐字节一致（含首行源路径）", async () => {
  const root = makeManualRoot();
  try {
    const alphaPath = join(root, "docs", "usage", "alpha.md");
    const alphaBytes = readFileSync(alphaPath);
    const out = await captureStdoutBytes(() => manualCommand(["alpha", "--all"], {}, { packageRoot: root }));
    const firstLineEnd = out.indexOf(0x0a) + 1;
    assert.ok(out.subarray(0, firstLineEnd).toString("utf8").startsWith("源: "), "第一行写源文件绝对路径");
    assert.ok(out.subarray(firstLineEnd).equals(alphaBytes), "--all 正文 = 源文件原始字节（不额外补换行）");
    // 节输出同理：首行之后是节区间的原始字节。
    const secOut = await captureStdoutBytes(() => manualCommand(["alpha", "第二节：独特"], {}, { packageRoot: root }));
    const secLineEnd = secOut.indexOf(0x0a) + 1;
    const index = readManualIndex({ packageRoot: root });
    const page = findManualPage(index, "alpha");
    const section = resolveManualSection(page, "第二节：独特");
    assert.ok(secOut.subarray(secLineEnd).equals(
      Buffer.from(page.text.slice(section.startOffset, section.endOffset), "utf8"),
    ), "节正文 = 解析器区间的原始字节");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── frontmatter 畸形（reason 闭集） ───────────────────────────────────────

test("frontmatter 畸形逐一报错，reason 全在闭集内", () => {
  const cases = [
    ["missing", "# 没有开头围栏\n\n## 节\n"],
    ["multi-key", "---\ntitle: 另一个键\n---\n# T\n"],
    ["multi-key", "---\nread_when: 值\nowner: x\n---\n# T\n"], // 第三行又是一个键 → 多键，不是"值没收栏"
    ["read-when-missing", "---\n不是键值行\n---\n# T\n"],
    ["empty-value", "---\nread_when:   \n---\n# T\n"],
    ["unterminated", "---\nread_when: 值\n值续行（多行值）\n---\n# T\n"],
  ];
  for (const [reason, raw] of cases) {
    const err = assertManualError(() => parseManualPage("x", raw), "frontmatter-invalid");
    assert.ok(err.message.includes(reason), `报错应点名 reason ${reason}（实得: ${err.message}）`);
    assert.ok(FRONTMATTER_REASONS.includes(reason), `${reason} 必须在闭集 FRONTMATTER_REASONS 里`);
  }
  // frontmatter 合格但缺 `# ` 页标题 → 另一个 code。
  assertManualError(() => parseManualPage("x", "---\nread_when: 有\n---\n\n直接进正文，没有页标题\n"), "title-missing");
});

// ─── 安装根解析（不看 cwd） ────────────────────────────────────────────────

test("从任意 cwd 调用都读安装根：默认根 = 代码所在检出，与 cwd 无关", () => {
  assert.equal(defaultManualRoot(), ROOT, "默认安装根按代码位置推导（= 本仓根）");
  const away = mkdtempSync(join(tmpdir(), "wao-manual-cwd-"));
  const prev = process.cwd();
  let defaultIndex;
  try {
    process.chdir(away); // 换到无关目录再取默认索引
    defaultIndex = readManualIndex();
  } finally {
    process.chdir(prev);
    rmSync(away, { recursive: true, force: true });
  }
  const explicit = readManualIndex({ packageRoot: ROOT });
  assert.deepEqual(defaultIndex.pages.map((p) => p.name), explicit.pages.map((p) => p.name),
    "cwd 变了，读到的还是安装根的同一份手册");
  assert.ok(explicit.pages.length >= 10, "本仓手册应有不少于 10 页");
});
