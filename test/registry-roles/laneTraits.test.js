// test/registry-roles/laneTraits.test.js
//
// 0046 §1/⑤ + 0087：车道画像元数据守卫。
//   ① 结构（schemaVersion 2）：config/lane-traits.json 可解析，traits 键 ⊆
//      lanes.json 车道键（不要求全覆盖——新车道可暂无画像）；顶层五档刻度；
//      车道级键闭集；七格评分闭集与各 basis 的 n/evidence 规则；ratedAgainst
//      与评分状态的相容；cost/caveats/定位的长度界；contextWindow/multimodal/
//      effortNote/concurrencyNote 沿用 v1 规则。不钉具体数据值，不钉中文句子。
//   ② 隔离铁律（0087 §5 守卫边）——双钉形态：
//      字面引用白名单（仅 src/application/laneProfile.js——加载器唯一归宿）
//      + 导入边守卫（laneProfile 只准被 lanesView 与 leadPreflight 引用、
//      lanesView 只准被 commands/lanes.js 引用、lanes.js 只准被 commands/wao.js
//      引用、leadPreflight 只准被 src/mcp/server.js 引用——派发/门禁/命令面
//      的间接引入即红，白名单字面钉抓不住的这一跳由导入边钉住，会审 P1）。
//      反例经夹具输入完成（绝不往 src/ 写临时文件——manifest 分组并行会互相
//      干扰），会审 P1。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CAVEATS_CAP, CAVEAT_MAX_CHARS, COST_MAX_CHARS, REVIEW_REASON_MAX_CHARS } from "../../src/application/laneProfile.js";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const toPosix = (p) => p.split("\\").join("/");

const doc = JSON.parse(read("config/lane-traits.json"));
const lanes = JSON.parse(read("config/lanes.json"));
const laneIds = new Set(lanes.lanes.map((l) => l.id));

const DIMENSIONS = ["research", "code", "review", "design", "longHorizon", "writing", "visual"];
const BASES = ["measured", "official", "owner"];
const SOURCE_TOKENS = ["official", "owner", "wire"];
const LANE_KEYS = new Set([
  "ratings", "ratedAgainst", "reviewPending", "cost",
  "caveats", "contextWindow", "multimodal", "concurrencyNote", "effortNote",
]);
const CELL_KEYS = new Set(["stars", "basis", "n", "note", "evidence"]);

const isStr = (v, min, max) => typeof v === "string" && v.length >= min && v.length <= max;

test("0087 ①：lane-traits 结构——schemaVersion 2、键⊆车道键、七格闭集与各 basis 规则", () => {
  assert.equal(doc.schemaVersion, 2);
  // 顶层五档刻度：恰好 "5".."1" 五键、值非空字符串。
  assert.deepEqual(Object.keys(doc.scale).sort(), ["1", "2", "3", "4", "5"]);
  for (const k of ["5", "4", "3", "2", "1"]) {
    assert.ok(typeof doc.scale[k] === "string" && doc.scale[k].length > 0, `scale["${k}"] 非空字符串`);
  }
  const ids = Object.keys(doc.traits ?? {});
  assert.ok(ids.length >= 8, `应覆盖 ≥8 车道（实际 ${ids.length}）`);
  for (const id of ids) {
    assert.ok(laneIds.has(id), `traits 键 ${id} 不是 lanes.json 车道键`);
    const t = doc.traits[id];
    assert.ok(t && typeof t === "object" && !Array.isArray(t), `${id} 必须是对象`);
    for (const k of Object.keys(t)) {
      assert.ok(LANE_KEYS.has(k), `${id} 车道级未知键 "${k}"`);
    }
    // ratings：恰好七个维度键。
    assert.deepEqual(
      Object.keys(t.ratings ?? {}).sort(),
      [...DIMENSIONS].sort(),
      `${id}.ratings 恰好七键`,
    );
    let anyRated = false;
    for (const d of DIMENSIONS) {
      const cell = t.ratings[d];
      assert.ok(cell && typeof cell === "object" && !Array.isArray(cell), `${id}.ratings.${d} 对象`);
      for (const k of Object.keys(cell)) {
        assert.ok(CELL_KEYS.has(k), `${id}.ratings.${d} 未知键 "${k}"`);
      }
      if (cell.stars === null && cell.basis === null) {
        assert.ok(!("n" in cell) && !("note" in cell) && !("evidence" in cell),
          `${id}.ratings.${d} 未评格不许带 n/note/evidence`);
        continue;
      }
      anyRated = true;
      assert.ok(Number.isInteger(cell.stars) && cell.stars >= 1 && cell.stars <= 5, `${id}.ratings.${d}.stars 1–5 整数`);
      assert.ok(BASES.includes(cell.basis), `${id}.ratings.${d}.basis 闭集`);
      assert.ok(cell.note === undefined || isStr(cell.note, 1, 100), `${id}.ratings.${d}.note 1–100`);
      assert.ok(cell.evidence === undefined || isStr(cell.evidence, 1, 200), `${id}.ratings.${d}.evidence 1–200`);
      if (cell.basis === "measured") {
        assert.ok(Number.isInteger(cell.n) && cell.n >= 1, `${id}.ratings.${d} measured 须带正整数 n`);
        assert.ok(typeof cell.evidence === "string", `${id}.ratings.${d} measured 须带 evidence`);
      } else if (cell.basis === "official") {
        assert.ok(!("n" in cell), `${id}.ratings.${d} official 不许带 n`);
        assert.ok(typeof cell.evidence === "string", `${id}.ratings.${d} official 须带 evidence`);
      } else {
        assert.ok(!("n" in cell), `${id}.ratings.${d} owner 不许带 n`);
      }
    }
    // ratedAgainst 与评分状态相容：有已评格必填四键，全未评必须 null。
    if (anyRated) {
      const ra = t.ratedAgainst;
      assert.ok(ra && typeof ra === "object" && !Array.isArray(ra), `${id}.ratedAgainst 必填`);
      assert.deepEqual(Object.keys(ra).sort(), ["backend", "effort", "modelId", "providerID"], `${id}.ratedAgainst 恰好四键`);
      assert.ok(isStr(ra.backend, 1, Infinity), `${id}.ratedAgainst.backend 非空字符串`);
      assert.ok(isStr(ra.modelId, 1, Infinity), `${id}.ratedAgainst.modelId 非空字符串`);
      for (const k of ["providerID", "effort"]) {
        assert.ok(ra[k] === null || typeof ra[k] === "string", `${id}.ratedAgainst.${k} 字符串或 null`);
      }
    } else {
      assert.equal(t.ratedAgainst, null, `${id} 全未评时 ratedAgainst 必须显式为 null`);
    }
    assert.ok(t.reviewPending === undefined || isStr(t.reviewPending, 1, REVIEW_REASON_MAX_CHARS), `${id}.reviewPending 1–${REVIEW_REASON_MAX_CHARS}`);
    assert.ok(t.cost === null || t.cost === undefined || isStr(t.cost, 1, COST_MAX_CHARS), `${id}.cost 1–${COST_MAX_CHARS} 或 null`);
    assert.ok(Array.isArray(t.caveats) && t.caveats.length <= CAVEATS_CAP
      && t.caveats.every((c) => isStr(c, 1, CAVEAT_MAX_CHARS)), `${id}.caveats 0–${CAVEATS_CAP} 条、各 1–${CAVEAT_MAX_CHARS}`);
    // v1 沿用规则。
    assert.ok(Number.isInteger(t.contextWindow?.tokens) && t.contextWindow?.tokens > 0, `${id}.contextWindow.tokens 正整数`);
    assert.ok(SOURCE_TOKENS.some((k) => (t.contextWindow?.source ?? "").includes(k)), `${id}.contextWindow.source 须含来源标注`);
    for (const k of ["image", "video"]) {
      assert.equal(typeof t.multimodal?.[k], "boolean", `${id}.multimodal.${k} 布尔`);
    }
    assert.ok(SOURCE_TOKENS.some((k) => (t.multimodal?.source ?? "").includes(k)), `${id}.multimodal.source 须含来源标注`);
    for (const k of ["effortNote", "concurrencyNote"]) {
      assert.ok(t[k] === undefined || typeof t[k] === "string", `${id}.${k} 可选字符串`);
    }
  }
  // 决定 0074 沿用：并发实测记录在场必须写明实测日期。
  for (const id of ids) {
    const note = doc.traits[id].concurrencyNote;
    if (note === undefined) continue;
    assert.match(note, /measured \d{4}-\d{2}-\d{2}/, `${id}.concurrencyNote 须写明实测日期`);
  }
});

// ── 0087：隔离守卫（纯函数化——walk 逻辑可被夹具反例复用）──────────────────────

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
  const WHITELIST = new Set(["src/application/laneProfile.js"]);
  return files
    .filter((f) => f.content.includes("lane-traits") && !WHITELIST.has(f.path))
    .map((f) => f.path);
}

/** 导入边扫描（纯函数）：解析相对 import 边，违规引用目标 = 违规。
 *  允许边（0087 §5）：laneProfile ← lanesView/leadPreflight；lanesView ←
 *  commands/lanes.js；lanes ← commands/wao.js；leadPreflight ← mcp/server.js
 *  （聚合器这一跳同守）。 */
export function importEdgeOffenders(files) {
  const ALLOWED_IMPORTERS = {
    "src/application/laneProfile.js": new Set(["src/application/lanesView.js", "src/application/leadPreflight.js"]),
    "src/application/lanesView.js": new Set(["src/commands/lanes.js"]),
    "src/commands/lanes.js": new Set(["src/commands/wao.js"]),
    "src/application/leadPreflight.js": new Set(["src/mcp/server.js"]),
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

test("0087 隔离钉①：字面引用白名单外零命中（src/ 真实树）", () => {
  const offenders = literalOffenders(collectSourceFiles(join(ROOT, "src"), ROOT));
  assert.deepEqual(offenders, [],
    "src/ 中画像文件名字面引用只准出现在 src/application/laneProfile.js（加载器唯一归宿）");
});

test("0087 隔离钉②：导入边守卫（真实树）——laneProfile/lanesView/lanes/leadPreflight 只准被既定面引用", () => {
  const offenders = importEdgeOffenders(collectSourceFiles(join(ROOT, "src"), ROOT));
  assert.deepEqual(offenders, [],
    "laneProfile←lanesView+leadPreflight、lanesView←lanes.js、lanes←wao.js、leadPreflight←server.js 之外的导入边违规（防派发/门禁/MCP 间接引入画像）");
});

test("0087 隔离钉反例（夹具合成清单——不触 src/）：白名单外字面/违规导入边必红", () => {
  const fixtures = [
    // 合法边全套（真实守卫边的合成镜像）——必须零误报。
    { path: "src/application/laneProfile.js", content: "const p = 'config/lane-traits.json';" },
    { path: "src/application/lanesView.js", content: "import { readLaneTraits } from './laneProfile.js';" },
    { path: "src/application/leadPreflight.js", content: "import { projectLaneProfiles } from './laneProfile.js';" },
    { path: "src/commands/lanes.js", content: "import { buildLanesView } from '../application/lanesView.js';" },
    { path: "src/commands/wao.js", content: "import { lanesCommand } from './lanes.js';" },
    { path: "src/mcp/server.js", content: "import { aggregateLeadPreflight } from '../application/leadPreflight.js';" },
    // 反例 1：白名单外文件出现画像文件名字面量。
    { path: "src/runManager.js", content: "// reads config/lane-traits.json\nexport const x = 1;" },
    // 反例 2：派发解析面引用画像加载模块（无字面量——字面钉抓不住，导入边钉必须红）。
    { path: "src/dispatchResolution.js", content: "import { readLaneTraits } from './application/laneProfile.js';" },
    // 反例 3：应用服务（非 server）引用 preflight 聚合器——聚合器这一跳同守。
    { path: "src/application/runDispatch.js", content: "import { aggregateLeadPreflight } from './leadPreflight.js';" },
  ];
  const lit = literalOffenders(fixtures);
  assert.ok(lit.includes("src/runManager.js"), "白名单外字面引用被抓");
  assert.equal(lit.filter((p) => p !== "src/runManager.js").length, 0, "白名单内字面引用不误报");
  const edges = importEdgeOffenders(fixtures);
  assert.ok(edges.includes("src/dispatchResolution.js → src/application/laneProfile.js"), "派发路径间接引入被抓");
  assert.ok(edges.includes("src/application/runDispatch.js → src/application/leadPreflight.js"), "聚合器被 server 之外引用被抓");
  assert.equal(edges.length, 2, "六条合法边（含聚合器←server）零误报");
});
