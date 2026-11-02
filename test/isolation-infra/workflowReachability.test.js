// test/isolation-infra/workflowReachability.test.js
//
// 原则 4（docs/ssot.md §2 第 4 条"不留孤儿"）的可达性守卫，扫描器与边规则共用
// scripts/map-lib.mjs（npm run map 的同一实现；边语义与移植来源见该文件头注）。
//
// 硬层（本文件）：真实仓库里除约定文件（LICENSE、.gitignore 等，工具链按惯例名字
// 加载）外，每个跟踪文件都要从入口经强边 + 中边可达：只经弱边（文档只提到它的
// 目录，不算加载）与完全不可达都判红并列出路径。只经中边可达不判红，只在
// npm run map 报告里列出。
//
// 库的单元检查：注入的小文件集逐类验证边规则与分档——八类边各至少一例、没人
// 引用的文件判不可达、只被文档提到目录的文件判只经弱边；外加变异自检（删掉一条
// 引用后硬层必须判红），保证守卫函数真的会红，不是恒真。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildWorkflowGraph, isTextFile } from "../../scripts/map-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 硬层违规 = 除约定文件外，既非强边可达也非强+中边可达的跟踪文件（弱边与完全
// 不可达都算）。守卫与变异自检共用这一个判据。
const hardLayerViolations = (nodes) => nodes
  .filter((n) => !n.convention && n.tier !== "strong" && n.tier !== "medium-only")
  .map((n) => n.path);

// 注入文件集：每类边恰好由一对文件承载，其余文本刻意不提别的文件，避免意外边。
// 可达链：README/package.json（入口）→ path → docs/guide.md → link → docs/usage.md
// → decision → .wao/decisions/0001-format.md；package.json → path → src/main.js
// → import → src/util.js 与 src/core.js（补 .js）；package.json → path →
// src/loader.js → codedir → src/plugs/alpha-plugin.js；README → path → docs/notes.md
// → docdir → docs/research/draft-notes-v1.md（仅弱边）、→ name →
// config/fixture-uniquename.json（仅中边）；README → path → test/manifest.json
// → manifest → test/unit/case.test.js。leftover/orphan-file-v9.md 无人引用。
const FIXTURE = [
  { path: "README.md", content: "See docs/guide.md and docs/notes.md. Tests: test/manifest.json.\n" },
  { path: "AGENT_ONBOARDING.md", content: "Onboarding.\n" },
  { path: "package.json", content: '{"name":"fixture","scripts":{"cli":"node src/main.js","load":"node src/loader.js"}}' },
  { path: "docs/guide.md", content: "Guide. See (usage.md) for usage.\n" },
  { path: "docs/usage.md", content: "Usage. 决定 0001 settled the format.\n" },
  { path: ".wao/decisions/0001-format.md", content: "# 0001 format\n" },
  { path: "src/main.js", content: 'import { u } from "./util.js";\nimport { c } from "./core";\n' },
  { path: "src/util.js", content: "export const u = 1;\n" },
  { path: "src/core.js", content: "export const c = 2;\n" },
  { path: "src/loader.js", content: 'const dir = "src/plugs";\n' },
  { path: "src/plugs/alpha-plugin.js", content: "export default 1;\n" },
  { path: "docs/notes.md", content: "Old drafts live in docs/research/. Alias: fixture-uniquename.json\n" },
  { path: "docs/research/draft-notes-v1.md", content: "draft\n" },
  { path: "config/fixture-uniquename.json", content: "{}" },
  // 清单条目写成 unit/../unit/ 的绕行拼写：JSON 引号里的直写相对路径会被 link 规则
  //（"rel" 形态）以同 rank 先手盖成 link（真实仓库里全部如此），绕行拼写才让
  // manifest 规则单独现形。
  { path: "test/manifest.json", content: '{"groups":{"pure":["unit/../unit/case.test.js"]}}' },
  { path: "test/unit/case.test.js", content: 'import { test } from "node:test";\n' },
  { path: "leftover/orphan-file-v9.md", content: "nobody links me\n" },
  { path: ".gitignore", content: "node_modules/\n" },
];

const graphOf = (fixture) => buildWorkflowGraph({
  files: fixture.map((x) => x.path),
  readFile: (f) => fixture.find((x) => x.path === f)?.content ?? null,
});

test("边规则：注入文件集里八类边各有一例且类型正确", () => {
  const { edges } = graphOf(FIXTURE);
  const has = (from, to, type) => edges.some((e) => e[0] === from && e[1] === to && e[2] === type);
  const cases = [
    ["README.md", "docs/guide.md", "path"],
    ["docs/guide.md", "docs/usage.md", "link"],
    ["src/main.js", "src/util.js", "import"],
    ["src/main.js", "src/core.js", "import"], // 说明符 "./core" 解析后补 .js
    ["docs/usage.md", ".wao/decisions/0001-format.md", "decision"],
    ["test/manifest.json", "test/unit/case.test.js", "manifest"],
    ["src/loader.js", "src/plugs/alpha-plugin.js", "codedir"],
    ["docs/notes.md", "docs/research/draft-notes-v1.md", "docdir"],
    ["docs/notes.md", "config/fixture-uniquename.json", "name"],
  ];
  for (const [from, to, type] of cases) {
    assert.ok(has(from, to, type), `缺少边 ${from} -> ${to} (${type})`);
  }
});

test("档位：入口/强/仅中边/仅弱边/不可达/约定文件各自归位", () => {
  const { nodes } = graphOf(FIXTURE);
  const tier = (p) => nodes.find((n) => n.path === p)?.tier;
  assert.equal(tier("package.json"), "strong", "入口自身应判 strong");
  assert.equal(tier("src/util.js"), "strong", "import 边可达应判 strong");
  assert.equal(tier("src/plugs/alpha-plugin.js"), "medium-only", "只被代码目录加载应判 medium-only");
  assert.equal(tier("config/fixture-uniquename.json"), "medium-only", "只被裸文件名引用应判 medium-only");
  assert.equal(tier("docs/research/draft-notes-v1.md"), "weak-only", "只被文档提到目录应判 weak-only");
  assert.equal(tier("leftover/orphan-file-v9.md"), "unreachable", "无人引用的文件应判 unreachable");
  assert.equal(tier(".gitignore"), "convention", "约定文件应判 convention 而非 unreachable");
});

test("变异自检：注入集删掉一条引用后，硬层必须判红", () => {
  // 完好的注入集本来就带着 weak-only 与 unreachable 两个样例（档位检查要用），所以
  // 判红的对照是"变异前后特定孤儿是否新增"，不是零违规。
  const pristine = hardLayerViolations(graphOf(FIXTURE).nodes);
  assert.ok(!pristine.includes("src/loader.js"), "完好注入集里 loader 不应是硬层违规");
  // 删掉 package.json 对 src/loader.js 的引用：loader 及其目录加载的插件都成孤儿。
  const mutated = graphOf(FIXTURE.map((x) => x.path === "package.json"
    ? { path: x.path, content: '{"name":"fixture","scripts":{"cli":"node src/main.js"}}' }
    : x));
  const violations = hardLayerViolations(mutated.nodes);
  assert.ok(violations.includes("src/loader.js"), `硬层没抓到变异孤儿 src/loader.js（违规：${JSON.stringify(violations)}）`);
  assert.ok(violations.includes("src/plugs/alpha-plugin.js"), "变异应连带暴露只经 codedir 可达的插件");
});

test("硬层守卫：真实仓库里除约定文件外每个跟踪文件都从入口经强边+中边可达", (t) => {
  // 只有不在 git 检出里（例如解开的发布包）才跳过；git 本身出错时让测试失败，不当跳过。
  if (!existsSync(join(ROOT, ".git"))) {
    t.skip("not a git checkout");
    return;
  }
  const files = execFileSync("git", ["-c", "core.quotepath=off", "ls-files"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28,
  }).split("\n").filter(Boolean);
  assert.ok(files.length > 0, "git ls-files 没有列出任何文件");
  const { nodes } = buildWorkflowGraph({
    files,
    readFile: (f) => {
      if (!isTextFile(f)) return null;
      try {
        return readFileSync(join(ROOT, f), "utf8");
      } catch {
        return null; // 工作树里已删除、尚未提交删除的跟踪文件
      }
    },
  });
  const violations = hardLayerViolations(nodes);
  assert.deepEqual(
    violations,
    [],
    `这些跟踪文件从入口只经弱边或完全不可达（原则 4 孤儿；软层清单与上一跳看 npm run map）。`
      + `若某个文件以前只靠裸文件名被引用，新增的同名文件会让那条边失效——把引用写成路径即可：\n${violations.join("\n")}`,
  );
});
