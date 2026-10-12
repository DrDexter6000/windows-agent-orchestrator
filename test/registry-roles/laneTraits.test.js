// test/registry-roles/laneTraits.test.js
//
// 0046 §1/⑤：车道画像元数据守卫。
//   ① 结构：config/lane-traits.json 可解析，traits 键 ⊆ lanes.json 车道键（不要求
//      全覆盖——新车道可暂无画像），字段形状闭集（profile/suggestedUses/
//      contextWindow/multimodal/effortNote），来源标注必填（official/owner/wire）。
//   ② 隔离铁律（0046 §1.5 "特性字段不进派发/门禁文件"）——0064 读取面落地后的
//      双钉形态：字面引用白名单（仅 src/application/lanesView.js——展示层投影）
//      + 导入边守卫（lanesView 只准被 commands/lanes.js 引用、lanes.js 只准被
//      commands/wao.js 引用；mcp/**、dispatchResolution、runManager 等派发/门禁
//      路径引用即红——白名单字面钉抓不住的间接引入由导入边钉住，会审 P1）。
//      反例经夹具输入完成（绝不往 src/ 写临时文件——manifest 分组并行会互相
//      干扰），会审 P1。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const toPosix = (p) => p.split("\\").join("/");

const doc = JSON.parse(read("config/lane-traits.json"));
const lanes = JSON.parse(read("config/lanes.json"));
const laneIds = new Set(lanes.lanes.map((l) => l.id));
const SOURCE_TOKENS = ["official", "owner", "wire"];

test("0046 ⑤：lane-traits 结构——键⊆车道键、字段闭集、来源标注必填", () => {
  assert.equal(doc.schemaVersion, 1);
  const ids = Object.keys(doc.traits ?? {});
  assert.ok(ids.length >= 8, `应覆盖 ≥8 车道（实际 ${ids.length}）`);
  for (const id of ids) {
    assert.ok(laneIds.has(id), `traits 键 ${id} 不是 lanes.json 车道键`);
    const t = doc.traits[id];
    assert.equal(typeof t.profile, "string", `${id}.profile 必须是字符串`);
    assert.ok(Array.isArray(t.suggestedUses) && t.suggestedUses.length > 0, `${id}.suggestedUses 非空数组`);
    assert.ok(Number.isInteger(t.contextWindow?.tokens) && t.contextWindow?.tokens > 0, `${id}.contextWindow.tokens 正整数`);
    assert.ok(SOURCE_TOKENS.some((k) => (t.contextWindow?.source ?? "").includes(k)), `${id}.contextWindow.source 须含来源标注`);
    for (const k of ["image", "video"]) {
      assert.equal(typeof t.multimodal?.[k], "boolean", `${id}.multimodal.${k} 布尔`);
    }
    assert.ok(SOURCE_TOKENS.some((k) => (t.multimodal?.source ?? "").includes(k)), `${id}.multimodal.source 须含来源标注`);
  }
  // kimi 三态特记（0046 §2 Owner 实测修正）：256K/仅图/effortNote 在场。
  assert.equal(doc.traits.kimi.contextWindow.tokens, 262144, "kimi=262144（Owner 钉正，非 1m）");
  assert.equal(doc.traits.kimi.multimodal.video, false, "kimi 无视频（视频需 kimi-for-coding 另车道）");
  assert.ok(/通道不表达/.test(doc.traits.kimi.effortNote ?? ""), "kimi effortNote=通道不表达");
});

// ── 0064：隔离守卫（纯函数化——walk 逻辑可被夹具反例复用）──────────────────────

/** 收集 (repo 相对 posix 路径, 文件内容) 清单：真实 src/ 或合成夹具树。 */
function collectSourceFiles(dir, rootPrefix) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(name)) {
        files.push({ path: toPosix(p.slice(rootPrefix.length + 1)), content: readFileSync(p, "utf8") });
      }
    }
  };
  walk(dir);
  return files;
}

/** 字面引用扫描（纯函数）：files 中含画像文件名字面量且不在白名单者 = 违规。 */
export function literalOffenders(files) {
  const WHITELIST = new Set(["src/application/lanesView.js"]);
  return files
    .filter((f) => f.content.includes("lane-traits") && !WHITELIST.has(f.path))
    .map((f) => f.path);
}

/** 导入边扫描（纯函数）：解析相对 import 边，违规引用目标 = 违规。
 *  允许边（0064）：lanesView ← commands/lanes.js；lanes ← commands/wao.js。 */
export function importEdgeOffenders(files) {
  const ALLOWED_IMPORTERS = {
    "src/application/lanesView.js": new Set(["src/commands/lanes.js"]),
    "src/commands/lanes.js": new Set(["src/commands/wao.js"]),
  };
  const byPath = new Map(files.map((f) => [f.path, f]));
  const resolveImport = (fromPath, spec) => {
    if (!spec.startsWith(".")) return null; // 裸说明符（node:/包名）不指向仓内
    const base = fromPath.split("/").slice(0, -1).join("/");
    const stack = (base ? base.split("/") : []);
    for (const part of spec.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") stack.pop();
      else stack.push(part);
    }
    let target = stack.join("/");
    for (const suffix of ["", ".js", ".mjs", ".cjs"]) {
      const cand = target + suffix;
      if (byPath.has(cand)) return cand;
    }
    return null; // 指向不存在的文件（如夹具外的模块）——非本守卫标的
  };
  const offenders = [];
  for (const f of files) {
    const re = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(f.content)) !== null) {
      const spec = m[1] ?? m[2];
      const target = resolveImport(f.path, spec);
      if (target && ALLOWED_IMPORTERS[target] && !ALLOWED_IMPORTERS[target].has(f.path)) {
        offenders.push(`${f.path} → ${target}`);
      }
    }
  }
  return offenders;
}

test("0064 隔离钉①：字面引用白名单外零命中（src/ 真实树）", () => {
  const offenders = literalOffenders(collectSourceFiles(join(ROOT, "src"), ROOT));
  assert.deepEqual(offenders, [],
    "src/ 中画像文件名字面引用只准出现在 src/application/lanesView.js（展示层投影）");
});

test("0064 隔离钉②：导入边守卫（真实树）——lanesView/lanes 只准被既定命令面引用", () => {
  const offenders = importEdgeOffenders(collectSourceFiles(join(ROOT, "src"), ROOT));
  assert.deepEqual(offenders, [],
    "lanesView.js←lanes.js、lanes.js←wao.js 之外的导入边违规（防派发/门禁/MCP 间接引入画像）");
});

test("0064 隔离钉反例（夹具合成清单——不触 src/）：白名单外字面/违规导入边必红", () => {
  const fixtures = [
    { path: "src/application/lanesView.js", content: "import { x } from '../dispatchResolution.js'; const p = 'config/lane-traits.json';" },
    { path: "src/commands/lanes.js", content: "import { buildLanesView } from '../application/lanesView.js';" },
    { path: "src/commands/wao.js", content: "import { lanesCommand } from './lanes.js';" },
    // 反例 1：白名单外文件出现字面量。
    { path: "src/runManager.js", content: "// reads config/lane-traits.json\nexport const x = 1;" },
    // 反例 2：派发路径间接引入（无字面量——字面钉抓不住，导入边钉必须红）。
    { path: "src/dispatchResolution.js", content: "import { readLaneTraits } from './application/lanesView.js';" },
    // 反例 3：MCP 面引入 lanes 命令模块。
    { path: "src/mcp/server.js", content: "import { lanesCommand } from '../commands/lanes.js';" },
  ];
  const lit = literalOffenders(fixtures);
  assert.ok(lit.includes("src/runManager.js"), "白名单外字面引用被抓");
  assert.equal(lit.filter((p) => p !== "src/runManager.js").length, 0, "白名单内字面引用不误报");
  const edges = importEdgeOffenders(fixtures);
  assert.ok(edges.includes("src/dispatchResolution.js → src/application/lanesView.js"), "派发路径间接引入被抓");
  assert.ok(edges.includes("src/mcp/server.js → src/commands/lanes.js"), "MCP 面引入命令模块被抓");
  assert.equal(edges.length, 2, "合法边（lanesView←lanes、lanes←wao）不误报");
});
