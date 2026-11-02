// scripts/map-lib.mjs
//
// 原则 4（docs/ssot.md §2 第 4 条"不留孤儿"）共用的引用图扫描器：纯库，导入零
// 副作用，不碰 fs 与 git——跟踪文件清单与读文件函数由调用方注入（npm run map
// 用真实仓库，workflowReachability.test.js 用注入的小文件集做逐类边检查）。
// 边规则移植自 Lead 2026-10-31 的只读扫描器 ref-graph-reference.mjs（runs-archive
// 2026-11 dev-worktree-batch67b）；报告用不到的部分（git 提交活跃度、文件字节数、
// 入链明细与上限）没有移植。与参考实现的有意差异只有一处：isCodeLike 的点号转义了
// （参考实现漏转义，会把无扩展名的 xjson 之类当代码）。边按路径排序：排序不改变边集
// 与档位，只让报告里的"上一跳"可能与参考实现不同。
//
// 边（每对文件只记最强的一类；rank：import > 其余强边 > 中边 > 弱边）：
//   path     强：正文含完整仓库相对路径（正斜杠或反斜杠形态）。
//   link     强：markdown 链接或引号形态的相对路径（(rel)、(rel#、./rel 等）。
//   import   强：js/mjs/cjs 里 from/import()/require() 的相对说明符（解析后可补 .js）。
//   decision 强：决定编号（决定/决策/decision(s)/ADR + 四位数，支持顿号/逗号列表；
//               map.md 另认行首 "NNNN |" 行）。
//   manifest 强：test/manifest.json 里带引号的 test/ 相对 *.js 路径。
//   codedir  中：代码在字符串字面量里按目录加载（引号全路径、join 段、相对目录串）。
//   name     中：长度 ≥10 且全仓唯一的裸文件名被正文提及（新增同名文件会让这条边
//            失效：唯一性是为了不把引用算到错的文件上）。
//   docdir   弱：非代码文件提到目录名——文档提及不等于加载，只算弱边。
//
// 档位（从入口做 BFS；守卫判红 weak-only 与 unreachable，medium-only 只进 npm run map
// 报告）：
//   strong（强边可达）> medium-only（强+中边才可达）> weak-only（只有弱边可达）
//   > unreachable；convention 文件豁免，不参与档位判定。

import { basename, posix } from "node:path";

// 入口：人与工具打开仓库的起点——双语 README、贡献者上手、宿主技能入口、llms.txt
// 索引、仓库契约与包清单，workflow 地图从它们出发。
export const ENTRY_FILES = [
  "README.md", "README.zh-CN.md", "AGENT_ONBOARDING.md", "SKILL.md", "llms.txt", "AGENTS.md", "package.json",
];

// 约定文件：git/npm/Node 工具链按惯例名字加载，不靠仓库内引用接进 workflow，守卫豁免。
export const CONVENTION_FILES = ["LICENSE", ".gitignore", ".gitattributes", ".nvmrc", "package-lock.json"];

const CONVENTION = new Set(CONVENTION_FILES);
const STRONG = new Set(["path", "link", "import", "decision", "manifest"]);
const MEDIUM = new Set(["codedir", "name"]);
const rank = (type) => (type === "import" ? 3 : STRONG.has(type) ? 2 : MEDIUM.has(type) ? 1 : 0);

// 与参考实现同一张文本扩展名表：无扩展名与点开头的文件（LICENSE、.gitignore）也算文本。
export const isTextFile = (f) =>
  /\.(md|js|mjs|cjs|json|jsonl|txt|yml|yaml|ps1|cmd|sh|toml)$/i.test(f) || !basename(f).includes(".") || basename(f).startsWith(".");

export function buildWorkflowGraph({ files: inputFiles, readFile }) {
  const files = [...inputFiles].sort();
  const fileSet = new Set(files);
  const text = new Map();
  for (const f of files) {
    const content = readFile(f);
    if (typeof content === "string") text.set(f, content);
  }

  const decisionByNumber = new Map();
  for (const f of files) {
    const m = /^\.wao\/decisions\/(\d{4})-/.exec(f);
    if (m) decisionByNumber.set(m[1], f);
  }
  // 直接持有跟踪文件的目录（提及目录只连到该目录下的直接文件，不递归）。
  const dirFiles = new Map();
  for (const f of files) {
    const d = posix.dirname(f);
    if (d === ".") continue;
    dirFiles.set(d, (dirFiles.get(d) ?? []).concat(f));
  }
  const nameCount = new Map();
  for (const f of files) nameCount.set(basename(f), (nameCount.get(basename(f)) ?? 0) + 1);

  const edges = []; // [from, to, type]——每对文件只留最强类型
  const isCodeLike = (f) => /\.(m?js|cjs|ps1|cmd|json)$/i.test(f);
  for (const [a, t] of text) {
    const out = new Map();
    const add = (b, type) => {
      if (b === a || !fileSet.has(b)) return;
      const prev = out.get(b);
      if (!prev || rank(type) > rank(prev)) out.set(b, type);
    };
    const aDir = posix.dirname(a) === "." ? "" : posix.dirname(a);
    for (const b of files) {
      if (b === a) continue;
      if (t.includes(b) || t.includes(b.replaceAll("/", "\\"))) { add(b, "path"); continue; }
      const rel = posix.relative(aDir || ".", b);
      if (rel && rel !== b) {
        for (const q of [`(${rel})`, `(${rel}#`, `(./${rel}`, `"${rel}"`, `'${rel}'`, `\`${rel}\``, `"./${rel}"`, `'./${rel}'`]) {
          if (t.includes(q)) { add(b, "link"); break; }
        }
      }
    }
    if (/\.(m?js|cjs)$/.test(a)) {
      for (const m of t.matchAll(/(?:from\s+|import\(\s*|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
        let p = posix.normalize(posix.join(aDir || ".", m[1]));
        if (!fileSet.has(p) && fileSet.has(`${p}.js`)) p = `${p}.js`;
        add(p, "import");
      }
    }
    for (const m of t.matchAll(/(?:决定|决策|decisions?|ADR)[\s\-#:：]*((?:\d{4})(?:\s*(?:[、,，/]|和|与|及|and)\s*\d{4})*)/gi)) {
      for (const n of m[1].match(/\d{4}/g)) { const d = decisionByNumber.get(n); if (d) add(d, "decision"); }
    }
    if (a === ".wao/decisions/map.md") {
      for (const m of t.matchAll(/^(\d{4})\s*\|/gm)) { const d = decisionByNumber.get(m[1]); if (d) add(d, "decision"); }
    }
    if (a === "test/manifest.json") {
      for (const m of t.matchAll(/"([^"\s]+\.(?:js|mjs|cjs))"/g)) add(posix.join("test", m[1]), "manifest");
    }
    for (const [d, list] of dirFiles) {
      if (d === aDir) continue;
      const segs = d.split("/");
      if (segs.length < 2) continue;
      const relD = posix.relative(aDir || ".", d);
      // 代码只有把目录拼进字符串字面量才算加载；注释里提到目录名不算。
      const code = isCodeLike(a);
      const hit = (!code && (t.includes(`${d}/`) || t.includes(`${d}\``) || t.includes(`${d})`)))
        || (code && (t.includes(`"${d}"`) || t.includes(`"${d}/`) || t.includes(`'${d}'`) || t.includes(`'${d}/`) || t.includes(`\`${d}/`)))
        || (code && new RegExp(segs.map((s) => `["']${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).join("\\s*,\\s*")).test(t))
        || (/\.(m?js|cjs)$/.test(a) && (t.includes(`"${relD}/"`) || t.includes(`"${relD}"`) || t.includes(`'${relD}/'`) || t.includes(`'${relD}'`)
          || t.includes(`"./${relD}/"`) || t.includes(`'./${relD}/'`)));
      if (hit) for (const b of list) add(b, code ? "codedir" : "docdir");
    }
    for (const b of files) {
      const n = basename(b);
      if (n.length >= 10 && nameCount.get(n) === 1 && !out.has(b) && t.includes(n)) add(b, "name");
    }
    for (const [b, type] of out) edges.push([a, b, type]);
  }
  edges.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));

  const outAdj = new Map();
  for (const [a, b, type] of edges) outAdj.set(a, (outAdj.get(a) ?? []).concat([[b, type]]));
  const bfs = (allowed) => {
    const info = new Map();
    const q = [];
    for (const e of ENTRY_FILES) if (fileSet.has(e)) { info.set(e, { depth: 0, parent: null, type: "entry" }); q.push(e); }
    while (q.length > 0) {
      const a = q.shift();
      for (const [b, type] of outAdj.get(a) ?? []) {
        if (!allowed(type) || info.has(b)) continue;
        info.set(b, { depth: info.get(a).depth + 1, parent: a, type });
        q.push(b);
      }
    }
    return info;
  };
  const reachStrong = bfs((t) => STRONG.has(t));
  const reachLoaded = bfs((t) => STRONG.has(t) || MEDIUM.has(t));
  const reachAll = bfs(() => true);

  const nodes = files.map((f) => {
    const reach = reachStrong.get(f) ?? reachLoaded.get(f) ?? reachAll.get(f) ?? null;
    const tier = CONVENTION.has(f) ? "convention"
      : reachStrong.has(f) ? "strong"
      : reachLoaded.has(f) ? "medium-only"
      : reachAll.has(f) ? "weak-only"
      : "unreachable";
    return { path: f, convention: CONVENTION.has(f), tier, via: reach?.parent ?? null, viaType: reach?.type ?? null };
  });

  const edgeCounts = {};
  for (const type of [...new Set(edges.map((e) => e[2]))].sort()) {
    edgeCounts[type] = edges.filter((e) => e[2] === type).length;
  }
  return { files, edges, edgeCounts, nodes };
}
