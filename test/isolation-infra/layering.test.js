// test/isolation-infra/layering.test.js
//
// 全 src 依赖方向矩阵机器守卫（五桶分类学 + 方向规则）。
//
// SSOT：docs/02-architecture.md「L4 依赖方向」节（五桶分类学 + 方向规则 + 白名单）。
// 本文件把该契约冻结为机器守卫：递归扫描 src/** 的全部静态相对 import/export-from
// 边与字符串字面量相对动态 import() 边，要求每条边 depth(目标) >= depth(源)；
// 同层与任意下向（含跳层）合法，上向即违例（白名单披露的恰 2 条除外）。
//
// 范式：扩展 test/mcp-surface/mcpRegistry.test.js M9-1-10 的既有成熟范式——
// walkJs 递归收集、非锚定 `from\s+['"]` 正则、`.replace(/\\/g, "/")` Windows 路径
// 归一——不另起炉灶。相对 M9-1-10 的增强：多行 import 必须命中（真实锚点
// src/ownerDashboardServer.js:38-46 的 from 子句独占收尾行，行首 `^import` 锚定
// 会漏掉该类边——这正是本守卫要关闭的既有盲区类）、JSDoc 注释过滤、
// 动态 import() 披露清单、src 顶层新文件 fail-closed。
//
// 已知盲区（明示，不宣称完备）：
//   1. 变量驱动的动态 import 静态不可见——真实例：src/workflow/loader.js:19
//      `const mod = await import(url);`（url 由 pathToFileURL 运行时拼出）。
//   2. 无 from 子句的副作用式 import（`import "./x.js";`）不在静态匹配范围
//      （当前 src 树无此形态）。
//   3. 模板字面量内容理论上可伪造 import 语句外观；模板字符串形式的
//      import(`./x.js`) 也不会进入字面量动态披露清单。
//   4. 注释剥离是有限状态机而非完整 parser：正则字面量内含引号等极端形态
//      可能扰动状态（当前 src 树无 `= /...含引号.../ ` 形态；本守卫的真实树
//      deepEqual 断言会对该类扰动自诊断——任何幻影边都会撞上冻结精确集合）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname, posix } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

// ===== 冻结分类学（docs/02-architecture.md「L4 依赖方向」五桶 SSOT）=====
//
// | 层（深度）        | 文件                                                |
// |------------------|-----------------------------------------------------|
// | asset（排除扫描） | src/owner-dashboard/**（浏览器静态资产，不在 Node import 图）|
// | adapters(0)      | src/mcp/**、src/commands/** + ADAPTER_TOP            |
// | application(1)   | src/application/** 中不在 SHARED_MEMBERS 内者        |
// | core(2)          | src/** 其余（含 src/workflow/**），顶层见 CORE_TOP   |
// | backends(3)      | src/backends/**                                     |
// | shared(4)        | SHARED_MEMBERS 精确集合                              |
//
// src 顶层文件没有目录前缀可依，因此三张顶层清单（adapters/shared/core）都是
// 显式冻结集合：新顶层文件不出现在任何清单 → classifyPath 返回 null →
// fail-closed 红（见突变测试 f）。目录桶（mcp/commands/backends/application/
// workflow/未来新目录）按前缀自动归桶。

const DEPTH = Object.freeze({ adapters: 0, application: 1, core: 2, backends: 3, shared: 4 });

// asset 桶：整体排除扫描（walkJs 剪枝），src Node 代码 import 它也 fail-closed。
const ASSET_PREFIX = "src/owner-dashboard/";

// shared(4)：共享内核成员精确集合（application 内 5 个 + src 顶层 5 个）。
const SHARED_MEMBERS = Object.freeze(new Set([
  "src/application/roleContract.js",
  "src/application/credentialReadiness.js",
  "src/application/ownerLiveness.js",
  "src/application/timeoutPolicy.js",
  "src/application/processStopVerify.js",
  "src/envPolicy.js",
  "src/runEvent.js",
  "src/secretRedaction.js",
  "src/canonicalAgentId.js",
  "src/waoCliPath.js",
]));

// adapters(0) 的 src 顶层成员。
const ADAPTER_TOP = Object.freeze(new Set([
  "src/cli.js",
  "src/ownerDashboardServer.js",
  "src/daemon.js",
  "src/daemonSupervisor.js",
  "src/backgroundRunner.js",
]));

// core(2) 的 src 顶层成员（src/** 其余的顶层显式清单；新顶层文件不在任何
// 清单 = fail-closed 红，强迫清单的有意识维护）。
const CORE_TOP = Object.freeze(new Set([
  "src/alerts.js",
  "src/cliRunSummary.js",
  "src/daemonHealth.js",
  "src/delivery.js",
  "src/deliveryFailureCodes.js",
  "src/deliveryVerification.js",
  "src/diagnosis.js",
  "src/frictionLog.js",
  "src/gitLocalExclude.js",
  "src/installRoot.js",
  "src/isolation.js",
  "src/metrics.js",
  "src/nodeVersionGuard.js",
  "src/portAllocator.js",
  "src/registry.js",
  "src/runEvidenceAssessment.js",
  "src/runManager.js",
  "src/scorecard.js",
  "src/smoke.js",
  "src/transcript.js",
  "src/waoDecisions.js",
  "src/waoDeclare.js",
  "src/waoDir.js",
  "src/waoHandoff.js",
  "src/waoStage.js",
  "src/waoState.js",
]));

const ADAPTER_DIRS = Object.freeze(["src/mcp/", "src/commands/"]);

// 上向边白名单（恰 2 条——冻结精确集合）。改动本清单必须先改 docs SSOT。
// 两条都是 core 顶层消费 application/sessionReuse.js：sessionReuse 消费
// ../transcript.js（core），是服务而非叶子；其文件头注释明载 core 消费者
// 合同（registry.js 闭集校验 / runManager.js 能力门与路由穿线）。
const WHITELIST = Object.freeze([
  {
    from: "src/registry.js",
    to: "src/application/sessionReuse.js",
    reason: "registry.js 用 sessionReuse 的闭集校验（isValidSessionReuseMode）；sessionReuse 是消费 transcript.js 的服务而非叶子，其头注释明载 core 消费者合同。",
  },
  {
    from: "src/runManager.js",
    to: "src/application/sessionReuse.js",
    reason: "runManager.js 经 validateSessionReuseRouting 做 capability gate 并把路由穿线给 backend.spawn；同一 sessionReuse core 消费者合同。",
  },
]);

const WHITELIST_HARD_CAP = 12;

// 字符串字面量相对动态 import() 的冻结披露清单（`${from} -> ${to}`）。
// 集合变大或变小都会红（deepEqual 双向相等）；新增合法动态依赖 = 显式扩单。
const DYNAMIC_DISCLOSED = Object.freeze([
  // src/application/runCollect.js:294 —— runCollect 拉取 opencode 消息页（application→backends 下向）
  "src/application/runCollect.js -> src/backends/opencodeServe.js",
  // src/commands/run.js:282/378/379 —— timeoutPolicy（shared）+ diagnosis/transcript（core）
  "src/commands/run.js -> src/application/timeoutPolicy.js",
  "src/commands/run.js -> src/diagnosis.js",
  "src/commands/run.js -> src/transcript.js",
  // src/commands/runs.js:361/983 —— runList / deliveryReviewProjection（application）
  "src/commands/runs.js -> src/application/deliveryReviewProjection.js",
  "src/commands/runs.js -> src/application/runList.js",
  // src/commands/stop.js:43 —— runStop（application）
  "src/commands/stop.js -> src/application/runStop.js",
  // src/frictionLog.js:52 —— diagnosis（core 同层）
  "src/frictionLog.js -> src/diagnosis.js",
  // src/runManager.js:1260/2082/2162 —— timeoutPolicy/processStopVerify（shared）+ opencodeStopVerify（backends）
  "src/runManager.js -> src/application/processStopVerify.js",
  "src/runManager.js -> src/application/timeoutPolicy.js",
  "src/runManager.js -> src/backends/opencodeStopVerify.js",
]);

// ===== 纯函数扫描器 =====

/**
 * 剥离行注释与块注释（含 JSDoc），保留字符串/模板字面量内容。
 * 长度与换行逐字节保持不变——匹配 offset 与原文行号严格一致。
 * 有限状态机（code/单引号/双引号/模板/行注释/块注释），非完整 parser
 * （见文件头盲区 4）。
 */
function stripComments(text) {
  const out = text.split("");
  let state = "code"; // code | line | block | squote | dquote | template
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = i + 1 < text.length ? text[i + 1] : "";
    if (state === "code") {
      if (c === "/" && n === "/") { out[i] = " "; out[i + 1] = " "; i++; state = "line"; }
      else if (c === "/" && n === "*") { out[i] = " "; out[i + 1] = " "; i++; state = "block"; }
      else if (c === "'") state = "squote";
      else if (c === "\"") state = "dquote";
      else if (c === "`") state = "template";
    } else if (state === "line") {
      if (c === "\n") state = "code"; else out[i] = " ";
    } else if (state === "block") {
      if (c === "*" && n === "/") { out[i] = " "; out[i + 1] = " "; i++; state = "code"; }
      else if (c !== "\n") out[i] = " ";
    } else if (state === "squote" || state === "dquote") {
      if (c === "\\") i++;
      else if ((state === "squote" && c === "'") || (state === "dquote" && c === "\"")) state = "code";
    } else if (state === "template") {
      if (c === "\\") i++;
      else if (c === "`") state = "code";
    }
  }
  return out.join("");
}

/**
 * 静态 import/export-from 边（非锚定全文匹配，多行 import 必须命中）：
 * - 语句位置门槛 `(^|[;{}\n])[ \t]*`：import/export 关键字须在行首/缩进
 *   （或紧跟 ; { } 之后）——杀死字符串字面量内 "import ... from '...'" 伪装
 *   （关键词前是引号/字母，不满足分隔符+纯空白前置）。
 * - 子句空隙 `[^;`()]*?` 允许换行/花括号/逗号（多行 import 的换行在此通过），
 *   排除 ; ( ) ` 阻断跨语句与动态调用形态。
 * - `(?!\.)` 排除 import.meta。
 * 动态边（DYNAMIC_RE）：仅字符串字面量 specifier 的 import()；变量驱动的
 * import(url) 静态不可见（文件头盲区 1）。
 */
const STATIC_RE = /(^|[;{}\n])[ \t]*(?:import|export)\b(?!\.)[^;`()]*?\bfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

/** 相对 specifier 解析为仓库相对目标路径（posix 归一；反斜杠已在上游归一为 /）。 */
function resolveRelative(relPath, spec) {
  return posix.normalize(posix.join(posix.dirname(relPath), spec));
}

/** 提取单文件全部静态/动态边。relPath 为仓库相对路径（正斜杠）。 */
function extractEdges(text, relPath) {
  const code = stripComments(text);
  const toEdge = (spec, index) => {
    const isRelative = spec.startsWith("./") || spec.startsWith("../");
    return {
      spec,
      line: lineOf(code, index),
      relative: isRelative,
      to: isRelative ? resolveRelative(relPath, spec) : null,
    };
  };
  const staticEdges = [...code.matchAll(STATIC_RE)].map((m) => toEdge(m[2], m.index));
  const dynamicEdges = [...code.matchAll(DYNAMIC_RE)].map((m) => toEdge(m[1], m.index));
  return { staticEdges, dynamicEdges };
}

/**
 * 五桶分类。返回桶名或 null（= 不在任何清单 → fail-closed）。
 * 优先级：asset → shared（精确集合，先于 application 前缀）→ backends →
 * adapters（前缀+顶层集合）→ application → core（顶层集合+其余子目录）→ null。
 */
function classifyPath(rel) {
  if (!rel.startsWith("src/")) return null;
  if (rel.startsWith(ASSET_PREFIX)) return "asset";
  if (SHARED_MEMBERS.has(rel)) return "shared";
  if (rel.startsWith("src/backends/")) return "backends";
  if (ADAPTER_DIRS.some((p) => rel.startsWith(p))) return "adapters";
  if (ADAPTER_TOP.has(rel)) return "adapters";
  if (rel.startsWith("src/application/")) return "application";
  if (CORE_TOP.has(rel)) return "core";
  if (rel.split("/").length > 2) return "core"; // workflow/、hostAdapters/ 及未来 src 子目录
  return null; // src 顶层文件不在任何冻结清单 → fail-closed
}

function byFromTo(a, b) {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  return 0;
}

/**
 * 方向规则检查。violations：{code, from, to}，code ∈
 * upward | unclassified-source | unclassified-target | asset-edge。
 * 白名单过滤不在本纯函数内（守卫测试先取全部 upward 再对冻结白名单 deepEqual）。
 */
function checkEdges(edges) {
  const violations = [];
  for (const e of edges) {
    const src = classifyPath(e.from);
    const tgt = classifyPath(e.to);
    if (src === null) { violations.push({ code: "unclassified-source", from: e.from, to: e.to }); continue; }
    if (src === "asset" || tgt === "asset") { violations.push({ code: "asset-edge", from: e.from, to: e.to }); continue; }
    if (tgt === null) { violations.push({ code: "unclassified-target", from: e.from, to: e.to }); continue; }
    if (DEPTH[tgt] < DEPTH[src]) violations.push({ code: "upward", from: e.from, to: e.to });
  }
  return violations.sort((a, b) => {
    const k = byFromTo(a, b);
    return k !== 0 ? k : (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  });
}

/** 实际集合 vs 冻结集合的双向差（deepEqual 之外给出可读的 extra/missing）。 */
function diffKeySets(actual, frozen) {
  const a = [...new Set(actual)].sort();
  const f = [...new Set(frozen)].sort();
  return {
    actualSorted: a,
    frozenSorted: f,
    extra: a.filter((x) => !f.includes(x)),
    missing: f.filter((x) => !a.includes(x)),
  };
}

// ===== 真实树 / 合成树扫描（同一扫描管线）=====

// M9-1-10 walkJs 范式扩展：剪枝 asset 桶目录；rel 反斜杠一律归一为 /。
async function walkJs(absDir, rootDir) {
  const out = [];
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(absDir, e.name);
    const rel = relative(rootDir, abs).replace(/\\/g, "/");
    if (e.isDirectory()) {
      if (rel === "src/owner-dashboard") continue; // asset 桶：浏览器静态资产，不入 Node import 图
      out.push(...(await walkJs(abs, rootDir)));
    } else if (e.isFile() && e.name.endsWith(".js")) {
      out.push(abs);
    }
  }
  return out;
}

async function scanTree(root) {
  const filesAbs = await walkJs(join(root, "src"), root);
  const files = [];
  const edges = [];
  const dynamicEdges = [];
  const sharedSpecs = [];
  const seenStatic = new Set();
  const seenDynamic = new Set();
  for (const abs of filesAbs) {
    const rel = relative(root, abs).replace(/\\/g, "/");
    files.push(rel);
    const { staticEdges, dynamicEdges: dyn } = extractEdges(await readFile(abs, "utf8"), rel);
    for (const e of staticEdges) {
      if (!e.relative) continue;
      const key = `${rel} -> ${e.to}`;
      if (seenStatic.has(key)) continue;
      seenStatic.add(key);
      edges.push({ from: rel, to: e.to, spec: e.spec, line: e.line });
    }
    for (const e of dyn) {
      if (!e.relative) continue;
      const key = `${rel} -> ${e.to}`;
      if (seenDynamic.has(key)) continue;
      seenDynamic.add(key);
      dynamicEdges.push({ from: rel, to: e.to, spec: e.spec, line: e.line });
    }
    if (classifyPath(rel) === "shared") {
      for (const e of [...staticEdges, ...dyn]) sharedSpecs.push({ from: rel, spec: e.spec });
    }
  }
  files.sort();
  edges.sort(byFromTo);
  dynamicEdges.sort(byFromTo);
  return { files, edges, dynamicEdges, sharedSpecs };
}

/**
 * os.tmpdir() 合成树构建器（Windows 环境禁止 POSIX /tmp；显式绝对路径）。
 * files：{ 相对路径: 文件内容 }。返回 root，调用方 try/finally rmSync 清理。
 */
function buildTree(caseName, files) {
  const root = mkdtempSync(join(tmpdir(), `wao-layering-${caseName}-`));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

function cleanupTree(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

// 真实树只扫一次，全部真实树断言共用同一快照。
const REAL = await scanTree(REPO_ROOT);

// ===== 冻结清单自检 =====

test("冻结白名单形状：恰 2 条、reason 非空、上限 12", () => {
  assert.equal(WHITELIST.length, 2, "白名单是恰 2 条的冻结精确集合（docs SSOT）");
  assert.ok(WHITELIST.length <= WHITELIST_HARD_CAP, `白名单硬上限 ${WHITELIST_HARD_CAP}`);
  for (const w of WHITELIST) {
    assert.equal(typeof w.reason, "string");
    assert.ok(w.reason.trim().length > 0, `每条白名单必须携带非空 reason：${w.from} -> ${w.to}`);
    assert.equal(typeof w.from, "string");
    assert.equal(typeof w.to, "string");
  }
});

test("冻结清单互斥：三张顶层清单两两不相交，shared 成员不与顶层清单重叠", () => {
  for (const set of [ADAPTER_TOP, CORE_TOP, SHARED_MEMBERS]) {
    for (const rel of set) assert.ok(classifyPath(rel) !== null, `清单成员可分类：${rel}`);
  }
  const overlap = (a, b) => [...a].filter((x) => b.has(x));
  assert.deepEqual(overlap(ADAPTER_TOP, CORE_TOP), [], "adapters 顶层 ∩ core 顶层 = ∅");
  assert.deepEqual(overlap(ADAPTER_TOP, SHARED_MEMBERS), [], "adapters 顶层 ∩ shared = ∅");
  assert.deepEqual(overlap(CORE_TOP, SHARED_MEMBERS), [], "core 顶层 ∩ shared = ∅");
  // shared 中 application 内的成员必须先于 application 前缀命中（分类优先级生效）。
  for (const rel of SHARED_MEMBERS) {
    if (rel.startsWith("src/application/")) {
      assert.equal(classifyPath(rel), "shared", `application 内 shared 成员归 shared 桶：${rel}`);
    }
  }
});

// ===== 突变/阴性测试（合成树 + 纯函数，不碰真实树）=====

test("突变 a：合成 core 文件新增单行上向 import → 违例", async () => {
  const root = buildTree("mut-a", {
    "src/workflow/thing.js": `import { serve } from "../application/service.js";\nexport { serve };\n`,
  });
  try {
    const scan = await scanTree(root);
    assert.equal(scan.edges.length, 1, "合成上向边被提取");
    const v = checkEdges(scan.edges);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, "upward", "core(2) -> application(1) 是上向违例");
    assert.equal(v[0].from, "src/workflow/thing.js");
    assert.equal(v[0].to, "src/application/service.js");
  } finally {
    cleanupTree(root);
  }
});

test("突变 b：合成多行上向 import（from 子句独占收尾行）→ 违例", async () => {
  // 真实锚点形态：src/ownerDashboardServer.js:38-46 —— 行首 ^import 锚定会漏。
  const root = buildTree("mut-b", {
    "src/workflow/thing.js": [
      "import {",
      "  serve,",
      "  listen,",
      "} from \"../application/service.js\";",
      "export { serve, listen };",
      "",
    ].join("\n"),
  });
  try {
    const scan = await scanTree(root);
    assert.equal(scan.edges.length, 1, "多行 import 的 from 收尾行形态必须命中（既有盲区类）");
    const v = checkEdges(scan.edges);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, "upward");
    assert.equal(v[0].to, "src/application/service.js");
  } finally {
    cleanupTree(root);
  }
});

test("突变 c：export ... from 上向 re-export → 违例", async () => {
  const root = buildTree("mut-c", {
    "src/workflow/thing.js": `export { serve } from "../application/service.js";\n`,
  });
  try {
    const scan = await scanTree(root);
    assert.equal(scan.edges.length, 1, "export-from 边被提取");
    const v = checkEdges(scan.edges);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, "upward");
  } finally {
    cleanupTree(root);
  }
});

test("突变 d：JSDoc 类型引用 import(\"../x.js\") 不进入任何列表", () => {
  const jsdoc = [
    "/**",
    " * @returns {import(\"../application/service.js\")} typed view",
    " */",
    "export function f() { return null; }",
    "",
  ].join("\n");
  const { staticEdges, dynamicEdges } = extractEdges(jsdoc, "src/workflow/thing.js");
  assert.deepEqual(staticEdges, [], "JSDoc 不产静态边");
  assert.deepEqual(dynamicEdges, [], "JSDoc 不产动态边（注释剥离生效）");
  // 代码体保留（剥离只清注释，不动代码）。
  assert.ok(stripComments(jsdoc).includes("export function f()"));
  // 真实树佐证：src/mcp/server.js:2576 的 JSDoc import(...) 不在披露清单
  // （由真实树动态 deepEqual 全等一并锁定）。
});

test("突变 e：普通字符串字面量含 from './x' 字样 → 不误报", () => {
  const text = [
    "const note = \"copy from './x.js' verbatim\";",
    "const s2 = 'see import from \"./y.js\" docs';",
    "const code = `docs say: import z from \"../application/service.js\";`;",
    "",
  ].join("\n");
  const { staticEdges, dynamicEdges } = extractEdges(text, "src/workflow/thing.js");
  assert.deepEqual(staticEdges, [], "字符串内容不产边（语句位置门槛杀死关键词伪装）");
  assert.deepEqual(dynamicEdges, []);
});

test("突变 f：合成 src 顶层不在任何清单的文件 → fail-closed 红", async () => {
  // import 本身方向合法（core→core 下向），但源文件不在任何冻结清单 → 红。
  const root = buildTree("mut-f", {
    "src/unlistedNewModule.js": `import { readTranscript } from "./transcript.js";\nexport { readTranscript };\n`,
  });
  try {
    const scan = await scanTree(root);
    assert.equal(scan.files.length, 1);
    assert.equal(classifyPath("src/unlistedNewModule.js"), null, "未登记顶层文件分类为 null");
    const v = checkEdges(scan.edges);
    assert.equal(v.length, 1);
    assert.equal(v[0].code, "unclassified-source", "fail-closed：方向合法也不能放过未登记桶");
    assert.equal(v[0].from, "src/unlistedNewModule.js");
  } finally {
    cleanupTree(root);
  }
});

test("突变 g：合成新增相对字面量动态 import → 不在 DYNAMIC_DISCLOSED，红", async () => {
  // 方向本身合法（core→backends 下向）——红只能来自披露清单精确集合。
  const root = buildTree("mut-g", {
    "src/workflow/dyn.js": [
      "export async function go() {",
      "  return import(\"../backends/thing.js\");",
      "}",
      "",
    ].join("\n"),
  });
  try {
    const scan = await scanTree(root);
    assert.deepEqual(checkEdges(scan.dynamicEdges), [], "方向规则对动态边同样生效且此处合法");
    const actual = scan.dynamicEdges.map((e) => `${e.from} -> ${e.to}`);
    const diff = diffKeySets(actual, DYNAMIC_DISCLOSED);
    // 合成树上冻结清单自然不满足（missing 非空）；本突变只证明 extra 判红路径。
    assert.deepEqual(diff.extra, ["src/workflow/dyn.js -> src/backends/thing.js"], "新增未披露动态边 = extra");
  } finally {
    cleanupTree(root);
  }
});

test("突变 g2：上向动态 import 同样吃方向规则（纯函数）", () => {
  const text = `export async function f() { return import("../application/service.js"); }\n`;
  const { dynamicEdges } = extractEdges(text, "src/backends/factory.js");
  assert.equal(dynamicEdges.length, 1, "字面量动态边被提取");
  const v = checkEdges(dynamicEdges.map((e) => ({ from: "src/backends/factory.js", to: e.to })));
  assert.equal(v.length, 1);
  assert.equal(v[0].code, "upward", "backends(3) -> application(1) 动态上向违例");
});

test("突变 i（纯函数）：注释内的 from 伪装边不进入列表", () => {
  // 真实锚点形态：src/cli.js:49 与 src/commands/shared.js:10 的注释里都有
  // `from "../src/cli.js"` 字样——注释过滤在真实树上是承重构件，不是理论。
  const text = [
    "// cli.js re-export 以保持 test/cli.test.js 的 `from \"../src/cli.js\"` 导入行不变。",
    "import { readFile } from \"node:fs/promises\";",
    "",
  ].join("\n");
  const { staticEdges } = extractEdges(text, "src/commands/shared.js");
  assert.equal(staticEdges.length, 1, "只有真实 import 命中");
  assert.equal(staticEdges[0].spec, "node:fs/promises");
  assert.equal(staticEdges[0].relative, false, "node: 前缀不入相对边集");
});

// ===== 真实树守卫 =====

test("真实树：上向边集与 2 条冻结白名单排序后 deepEqual 全等", () => {
  const all = checkEdges(REAL.edges);
  const upward = all.filter((v) => v.code === "upward").map((v) => ({ from: v.from, to: v.to })).sort(byFromTo);
  const frozen = WHITELIST.map((w) => ({ from: w.from, to: w.to })).sort(byFromTo);
  assert.deepEqual(upward, frozen, "上向边集与白名单双向全等（变少也红）");
  assert.equal(upward.length, WHITELIST.length);
  assert.equal(upward.length, 2, "真实树当前恰 2 条上向边（= 白名单冻结精确集合）");
});

test("真实树：fail-closed 生效——每个扫描文件都归桶，无 unclassified/asset 违例", () => {
  // 任何被扫描文件不在五桶 → 红（含新顶层文件）；目标逃出 src/ 或指向 asset 也红。
  const unclassified = REAL.files.filter((rel) => {
    const b = classifyPath(rel);
    return b === null || b === "asset";
  });
  assert.deepEqual(unclassified, [], "src 下每个 .js 文件（除 asset 桶）都必须落入五桶之一");
  const structural = checkEdges(REAL.edges).filter((v) => v.code !== "upward");
  assert.deepEqual(
    structural.map((v) => v.code),
    [],
    "无 unclassified-source / unclassified-target / asset-edge 违例",
  );
});

test("真实树：字面量相对动态 import 与冻结披露清单双向 deepEqual，且全部方向合法", () => {
  const actual = REAL.dynamicEdges.map((e) => `${e.from} -> ${e.to}`);
  const diff = diffKeySets(actual, DYNAMIC_DISCLOSED);
  assert.deepEqual(diff.actualSorted, diff.frozenSorted, "动态披露清单双向全等（变大变小都红）");
  assert.deepEqual(diff.extra, []);
  assert.deepEqual(diff.missing, []);
  // 方向规则对动态边同样生效（任务 spec #4）。
  assert.deepEqual(checkEdges(REAL.dynamicEdges), [], "全部披露动态边方向合法");
});

test("真实树：shared 成员全部出边只指向 node: 或 shared（零上向、零横跨）", () => {
  const bad = [];
  for (const { from, spec } of REAL.sharedSpecs) {
    if (spec.startsWith("node:")) continue;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const to = resolveRelative(from, spec);
      if (classifyPath(to) !== "shared") bad.push({ from, spec, resolved: to });
    } else {
      bad.push({ from, spec, reason: "bare-specifier" }); // 裸包名出边（shared 应零依赖）
    }
  }
  assert.deepEqual(bad, [], "shared 是最深桶：任何相对非 shared 目标或裸包名都红");
});

test("真实树：asset 排除生效——owner-dashboard 磁盘存在但不入扫描集", () => {
  assert.ok(existsSync(join(REPO_ROOT, "src", "owner-dashboard", "app.js")), "asset 文件真实存在");
  assert.ok(!REAL.files.includes("src/owner-dashboard/app.js"), "asset 桶不进扫描集");
  assert.ok(REAL.files.every((rel) => !rel.startsWith(ASSET_PREFIX)), "扫描集无任何 owner-dashboard 路径");
});
