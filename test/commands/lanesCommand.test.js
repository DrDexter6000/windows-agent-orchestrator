// test/commands/lanesCommand.test.js
//
// 0064：`wao lanes` 命令适配层钉（夹具面——非默认 registry 与显式车道表成对）：
//   - 防跨绑成对规则：单独 --registry 拒绝；--registry+--lanes-file 放行+注记；
//   - --json 白名单投影：不泄漏 cwd/sessionReuse/missingCredentialEnvNames；
//   - 车道表权威失败：exitCode 1 + 不渲染正常车道面；
//   - 未知选项 fail-fast。
// readyState 断言只验闭集成员（真探测随机器环境变化——不断言具体值）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lanesCommand } from "../../src/commands/lanes.js";
import { displayWidth } from "../../src/application/onboarding.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const READY_STATES = new Set([
  "ready", "missing_cli", "missing_key", "missing_both", "login_based",
  "key_only_present", "key_only_missing", "unknown",
]);

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "wao-lanescmd-"));
  mkdirSync(join(dir, "runs"), { recursive: true });
  // 夹具车道表：两条车道（l1 与 registry 四轴一致；l2 漂移）。
  writeFileSync(join(dir, "lanes.json"), JSON.stringify({
    schema: 2,
    lanes: [
      { id: "l1", backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "max" }, aliases: {} },
      { id: "l2", backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, aliases: {} },
    ],
  }), "utf8");
  // 夹具 registry：l1 接线一致；l2 的 model 漂移（G4 判定=drift）。
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    agents: {
      l1: { backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "max" }, binary: "C:/wao-test-zcode/zcode.cjs", cwd: dir, seatRole: "adversarial" },
      l2: { backend: "codex", model: { id: "gpt-6-astra" }, reasoning: { effort: "high" }, cwd: dir },
    },
  }), "utf8");
  // 夹具台账：l1 匹配记录（certified）；l2 记录身份与 registry 不匹配（→null）。
  writeFileSync(join(dir, "runs", "reliability-summary.json"), JSON.stringify({
    ledgerKeySpace: "lane-v1",
    workers: {
      "lane:deadbeef": {
        status: "certified", backend: "zcode", modelId: "bigmodel-api/GLM-5.3",
        lastHealthyRunAt: "2026-10-06T00:00:00.000Z",
      },
    },
  }), "utf8");
  return dir;
}

test("wao lanes：成对面渲染——drift 判定/cert null 语义/readyState 闭集（0065：seatRole 列退役）", async () => {
  const dir = makeEnv();
  try {
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await lanesCommand(
        ["--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs") },
      );
    } finally { console.log = origLog; }
    const text = lines.join("\n");
    assert.ok(text.includes("显式拼接面"), "成对放行有横幅注记");
    assert.ok(text.includes("lane l1"), "l1 在场");
    assert.match(text, /^lane l1 — .+ · 推断族系 \S+$/m, "车道行带推断族系（决定 0090）");
    assert.ok(/接线: 漂移——explicit 派发将拒绝/.test(text), "l2 drift 判定与拒绝语义");
    assert.ok(!text.includes("seatRole:"), "seatRole 列已退役（0065）");
    assert.ok(text.includes("certification: certified"), "台账匹配记录显示");
    assert.ok(text.includes("未取得匹配认证"), "l2 身份不匹配→null 语义文案");
    assert.equal(process.exitCode, undefined, "正常面不改退出码");
  } finally { cleanupDir(dir); }
});

test("wao lanes --json：白名单投影——不泄漏 cwd/sessionReuse/missingCredentialEnvNames", async () => {
  const dir = makeEnv();
  try {
    let payload = null;
    const origLog = console.log;
    console.log = (s) => { payload = JSON.parse(s); };
    try {
      await lanesCommand(
        ["--json", "--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs") },
      );
    } finally { console.log = origLog; }
    const l1 = payload.lanes.find((r) => r.id === "l1");
    assert.equal(l1.wiring, "wired");
    assert.equal(l1.certification, "certified");
    assert.ok(READY_STATES.has(l1.readyState), `readyState 闭集成员（got ${l1.readyState}）`);
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("sessionReuse"), "不泄漏 sessionReuse");
    assert.ok(!serialized.includes("missingCredentialEnvNames"), "不泄漏凭据名");
    assert.ok(!serialized.includes("credentialAvailability"), "不泄漏凭据可用性");
    assert.ok(!/"cwd"/.test(serialized), "不泄漏 cwd");
    assert.ok(payload.registryPath.endsWith("agents.json"));
  } finally { cleanupDir(dir); }
});

test("wao lanes：防跨绑——单独非默认 --registry 拒绝；未知选项 fail-fast", async () => {
  const dir = makeEnv();
  try {
    await assert.rejects(
      lanesCommand(["--registry", join(dir, "agents.json")], { registry: "config/agents.json", runDir: join(dir, "runs") }),
      /防跨绑/,
      "单独 --registry（无 --lanes-file）拒绝",
    );
    await assert.rejects(
      lanesCommand(["--bogus"], { registry: "config/agents.json", runDir: join(dir, "runs") }),
      /unknown option/,
      "未知选项 fail-fast",
    );
  } finally { cleanupDir(dir); }
});

// ── 0097 §5：开头对照表 + 成本档/Owner 规则段（夹具画像经 config.readLaneTraitsFn
//    注入——不读真实画像，改数据不红这里）──────────────────────────────────

const SCALE = { "5": "最强", "4": "强", "3": "堪用", "2": "弱", "1": "不适合" };
const unrated = () => ({ stars: null, basis: null });
const baseEntry = (over = {}) => ({
  ratings: {
    research: unrated(), code: unrated(), review: unrated(), design: unrated(),
    longHorizon: unrated(), writing: unrated(), visual: unrated(),
  },
  ratedAgainst: null,
  cost: "按量计费",
  costTier: null,
  caveats: [],
  contextWindow: { tokens: 1000000, source: "official（测试）" },
  multimodal: { image: true, video: false, source: "official" },
  ...over,
});

/** 夹具车道表：声明序 t1(实测三格带 score)、t2(全未评)、t3(带 dispatchHold)、
 *  t4(无画像)、t5(写了 reviewPending)。t1 与 registry 四轴一致（current）；
 *  t2 全未评（unrated→未评，不是待复核）；t5 待复核（review）。 */
function makeTableEnv() {
  const dir = mkdtempSync(join(tmpdir(), "wao-lanescmd-tbl-"));
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(join(dir, "lanes.json"), JSON.stringify({
    schema: 2,
    lanes: [
      { id: "t1", backend: "zcode", model: { id: "p1/m1" }, reasoning: { effort: "max" }, aliases: {} },
      { id: "t2", backend: "zcode", model: { id: "p1/m2" }, reasoning: { effort: "max" }, aliases: {} },
      { id: "t3", backend: "codex", model: { id: "m3" }, reasoning: { effort: "high" }, aliases: {}, dispatchHold: "夹具：暂停" },
      { id: "t4", backend: "codex", model: { id: "m4" }, reasoning: { effort: "high" }, aliases: {} },
      { id: "t5", backend: "codex", model: { id: "m5" }, reasoning: { effort: "high" }, aliases: {} },
    ],
  }), "utf8");
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    agents: {
      t1: { backend: "zcode", model: { id: "p1/m1" }, reasoning: { effort: "max" }, binary: "C:/wao-test-zcode/zcode.cjs", cwd: dir },
      t2: { backend: "zcode", model: { id: "p1/m2" }, reasoning: { effort: "max" }, binary: "C:/wao-test-zcode/zcode.cjs", cwd: dir },
      t3: { backend: "codex", model: { id: "m3" }, reasoning: { effort: "high" }, cwd: dir },
      t4: { backend: "codex", model: { id: "m4" }, reasoning: { effort: "high" }, cwd: dir },
      t5: { backend: "codex", model: { id: "m5" }, reasoning: { effort: "high" }, cwd: dir },
    },
  }), "utf8");
  const traitsResult = {
    state: "ok", path: join(dir, "traits.json"), sha256: "b".repeat(64), scale: SCALE,
    costTierScale: "成本档：Owner 给的相对档位，0.5–5，数越小越便宜；不是价格倍数",
    ownerRules: ["规则一（先）", "规则二（后）"],
    observations: [],
    traits: {
      t1: baseEntry({
        costTier: 0.5,
        ratings: {
          research: { stars: 3, basis: "measured", n: 99, evidence: "e", score: { hits: 68, total: 99, label: "与终裁一致" } },
          code: { stars: 3, basis: "measured", n: 2, evidence: "e", score: { hits: 27, total: 28, label: "隐藏测试通过" } },
          review: { stars: 3, basis: "measured", n: 19, evidence: "e" }, // 实测无分数
          design: { stars: 4, basis: "owner", note: "advisor" },
          longHorizon: unrated(), writing: unrated(), visual: unrated(),
        },
        ratedAgainst: { backend: "zcode", modelId: "p1/m1", providerID: null, effort: "max" },
      }),
      t2: baseEntry({}),
      t3: baseEntry({
        costTier: 4,
        ratings: {
          code: { stars: 5, basis: "owner", note: "后端强" },
          research: unrated(), review: unrated(), design: unrated(),
          longHorizon: unrated(), writing: unrated(), visual: unrated(),
        },
        ratedAgainst: { backend: "codex", modelId: "m3", providerID: null, effort: "high" },
      }),
      t5: baseEntry({ reviewPending: "夹具：换代待复核" }),
    },
    invalidIds: [], issues: [],
  };
  return { dir, traitsResult };
}

async function runLanesCapture(dir, traitsResult, args = []) {
  const chunks = [];
  const origLog = console.log;
  console.log = (...a) => { chunks.push(a.join(" ")); };
  try {
    await lanesCommand(
      ["--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs"), ...args],
      { registry: "config/agents.json", runDir: join(dir, "runs"), readLaneTraitsFn: () => traitsResult },
    );
  } finally { console.log = origLog; }
  // 人读面是单次 console.log(join("\n"))——按换行拆回逐行。
  return chunks.join("\n").split("\n");
}

test("0097 wao lanes：对照表在最前、声明序、四种格写法、暂停/待复核/未评/无画像、宽度 ≤120", async () => {
  const { dir, traitsResult } = makeTableEnv();
  try {
    const lines = await runLanesCapture(dir, traitsResult);
    const text = lines.join("\n");
    // 表在细节之前：第一条含 lane 细节的行（"lane t1 —"）晚于表头行。
    const headerIdx = lines.findIndex((l) => l.includes("车道对照表"));
    assert.ok(headerIdx > 0, "对照表在场");
    assert.ok(headerIdx < lines.findIndex((l) => /^lane t1 — /.test(l)), "对照表在细节之前");
    assert.ok(lines[headerIdx].includes("只列三个实测维度"), "表头注明只列三个实测维度");
    // 表头七列。
    assert.match(lines[headerIdx + 1], /车道\s+族系\s+写代码\s+把关\s+调研\s+成本档\s+状态/);
    // 声明序：t1 行在 t2 行之前，以此类推。
    const rowIdx = (id) => lines.findIndex((l) => new RegExp(`^\\s*${id}\\s`).test(l));
    assert.ok(rowIdx("t1") < rowIdx("t2") && rowIdx("t2") < rowIdx("t3") && rowIdx("t3") < rowIdx("t4"),
      "表行序=声明序");
    // 四种格写法：实测有分数（3★ 96% n=2；27/28=96%）、实测无分数（3★ n=19）、
    // Owner 评（5★ 主观）、未评（—）。
    const t1Row = lines[rowIdx("t1")];
    assert.match(t1Row, /3★ 96% n=2/, "实测有分数：写代码 27/28 → 96%");
    assert.match(t1Row, /3★ 69% n=99/, "调研 68/99 → 69%");
    assert.match(t1Row, /3★ n=19/, "实测无分数只带 n");
    const t3Row = lines[rowIdx("t3")];
    assert.match(t3Row, /5★ 主观/, "Owner 评写主观");
    assert.match(t3Row, /—/, "未评格写 —");
    // 成本档列。
    assert.match(t1Row, /0\.5/, "t1 成本档 0.5");
    assert.match(t3Row, / 4\s/, "t3 成本档 4");
    // 状态列：t3 暂停（dispatchHold）、t2 未评（unrated 不写成待复核）、t4 无画像、
    // t5 待复核（reviewPending）、t1 空。
    assert.match(t3Row, /暂停/, "dispatchHold → 暂停");
    assert.match(lines[rowIdx("t2")], /未评$/, "ratingsState unrated → 未评");
    assert.ok(!lines[rowIdx("t2")].includes("待复核"), "没评过不写成待复核");
    assert.match(lines[rowIdx("t4")], /无画像$/, "画像文件无该车道键 → 无画像");
    assert.match(lines[rowIdx("t5")], /待复核$/, "ratingsState review → 待复核");
    for (const word of ["暂停", "待复核", "未评", "无画像"]) {
      assert.ok(!lines[rowIdx("t1")].includes(word), `current 且无暂停 → 状态空（不含 ${word}）`);
    }
    // 表尾图例：百分比的分母不一定是 n。
    const legendIdx = rowIdx("t5") + 1;
    assert.match(lines[legendIdx], /^\s+格：星级、实测分数百分比（计数单位见下方细节，不一定是 n）/, "表尾图例");
    // 宽度：对照表块内每行（含图例）≤120 显示列（中文字符按 2 列计）。
    for (let i = headerIdx; i <= legendIdx; i++) {
      assert.ok(displayWidth(lines[i]) <= 120, `对照表行宽 ≤120（超宽行：${lines[i].slice(0, 30)}…）`);
    }
    // 成本档说明与 Owner 规则段在表后、细节前；说明串自带"成本档："前缀，不再加第二个标签。
    assert.ok(text.includes("成本档：Owner 给的相对档位"), "costTierScale 说明串在场");
    assert.ok(!text.includes("成本档: 成本档："), "不重复标签");
    const rulesIdx = lines.findIndex((l) => l.includes("Owner 规则（排在前面的优先）"));
    assert.ok(rulesIdx > headerIdx, "Owner 规则段在表后");
    assert.ok(lines.some((l) => l.includes("- 规则一（先）")), "规则按序列出");
    assert.ok(lines.some((l) => l.includes("- 规则二（后）")), "第二条规则");
    // 细节里的评分格显示 score（68/99 与 label）。
    assert.ok(text.includes("调研整理: 3 星（measured，n=99，68/99 与终裁一致）"), "细节格带 score");
  } finally { cleanupDir(dir); }
});

test("0097 wao lanes --json：带 costTierScale/ownerRules/costTier/score，不另造表格字符串", async () => {
  const { dir, traitsResult } = makeTableEnv();
  try {
    let payload = null;
    const origLog = console.log;
    console.log = (s) => { payload = JSON.parse(s); };
    try {
      await lanesCommand(
        ["--json", "--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs"), readLaneTraitsFn: () => traitsResult },
      );
    } finally { console.log = origLog; }
    assert.equal(payload.costTierScale, traitsResult.costTierScale);
    assert.deepEqual(payload.ownerRules, ["规则一（先）", "规则二（后）"]);
    const t1 = payload.lanes.find((r) => r.id === "t1");
    assert.equal(t1.traits.costTier, 0.5);
    assert.deepEqual(t1.traits.ratings.code.score, { hits: 27, total: 28, label: "隐藏测试通过" });
    assert.ok(!("score" in t1.traits.ratings.review), "无 score 的格不带键");
    assert.equal(payload.lanes.find((r) => r.id === "t4").traitsState, "absent");
    // 不另造表格字符串：--json 不含对照表的渲染行。
    assert.ok(!JSON.stringify(payload).includes("车道对照表"), "--json 不带表格字符串");
  } finally { cleanupDir(dir); }
});

test("wao lanes：车道表权威失败（结构非法）→ exitCode 1 + 不渲染车道面", async () => {
  const dir = makeEnv();
  try {
    // 结构非法反例：未知顶层键（TOP_KEYS 白名单违规 → ok:false）。
    // 注：lanes 非数组会被 loadLanesConfig 静默归 []（合法空表面）——不是结构
    // 非法形状；结构非法走白名单违规。
    writeFileSync(join(dir, "lanes.json"), JSON.stringify({ schema: 2, lanes: [], bogusKey: 1 }), "utf8");
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    const prevExit = process.exitCode;
    try {
      await lanesCommand(
        ["--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs") },
      );
    } finally { console.log = origLog; }
    const text = lines.join("\n");
    assert.ok(text.includes("车道表不可用"), "失败面标题");
    assert.ok(!text.includes("lane l1"), "不渲染正常车道面");
    assert.equal(process.exitCode, 1, "exitCode 1");
    process.exitCode = prevExit;
  } finally { cleanupDir(dir); }
});

// TD-318（二）：JSON.parse 的 V8 报错自带源文本片段——坏 JSON 的 lanes.json
// 原文不得进 wao lanes 的文本或 JSON 输出（JSON.stringify 转义换行，但旧实现
// 的 issue 文案本身携带原文片段）。
test("TD-318（二）：wao lanes 遇坏 JSON 车道表——文本与 JSON 输出都不带源文本", async () => {
  const dir = makeEnv();
  try {
    writeFileSync(join(dir, "lanes.json"), '{"lanes": [{"LEAK_SENTINEL_LANES": undefined}]}', "utf8");
    const runLanes = async (asJson) => {
      const lines = [];
      const origLog = console.log;
      console.log = (...a) => { lines.push(a.join(" ")); };
      const prevExit = process.exitCode;
      try {
        await lanesCommand(
          [
            ...(asJson ? ["--json"] : []),
            "--registry", join(dir, "agents.json"),
            "--lanes-file", join(dir, "lanes.json"),
            "--run-dir", join(dir, "runs"),
          ],
          { registry: "config/agents.json", runDir: join(dir, "runs") },
        );
      } finally {
        console.log = origLog;
        process.exitCode = prevExit;
      }
      return asJson ? JSON.parse(lines.join("\n")) : lines.join("\n");
    };
    const text = await runLanes(false);
    assert.ok(text.includes("车道表不可用"), "失败面标题照常");
    assert.ok(!text.includes("LEAK_SENTINEL_LANES"), `文本输出不含源文本哨兵（实际：${text.slice(0, 400)}）`);
    const payload = await runLanes(true);
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("LEAK_SENTINEL_LANES"), "JSON 输出不含源文本哨兵");
    assert.ok(
      (payload.issues ?? []).some((i) => /lanes\.json不是合法的 JSON/.test(i)),
      `issue 是固定文案（实际：${JSON.stringify(payload.issues ?? [])}）`,
    );
  } finally { cleanupDir(dir); }
});

// 决定 0074（车道就绪事实如实呈现）：声明 kimiHome 的 kimi-web 车道，就绪按
// <kimiHome>/server.token 文件推导（key_only_present/key_only_missing——复用
// 现有八态闭集，不新增状态），不探 tokenEnv（那个变量不会被派发读到）；人读
// 输出点名文件路径。
test("wao lanes：kimiHome 车道就绪按 token 文件推导（不探 tokenEnv）；人读面点名文件路径", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lanescmd-kimi-"));
  try {
    mkdirSync(join(dir, "runs"), { recursive: true });
    mkdirSync(join(dir, "home"), { recursive: true });
    const home = join(dir, "home");
    writeFileSync(join(dir, "lanes.json"), JSON.stringify({
      schema: 2,
      lanes: [{ id: "kimi_lane", backend: "kimi-web", model: { id: "kimi-code/k3-256k" }, reasoning: { effort: "high" }, aliases: {} }],
    }), "utf8");
    writeFileSync(join(dir, "agents.json"), JSON.stringify({
      agents: {
        kimi_lane: {
          backend: "kimi-web",
          serveUrl: "http://127.0.0.1:58628",
          model: { id: "kimi-code/k3-256k" },
          reasoning: { effort: "high" },
          tokenEnv: "TEST_LANES_KIMI_TOKEN",
          cwd: dir,
          kimiHome: home,
        },
      },
    }), "utf8");
    const runLanes = async (asJson) => {
      const lines = [];
      const origLog = console.log;
      console.log = (...a) => { lines.push(a.join(" ")); };
      try {
        await lanesCommand(
          [
            ...(asJson ? ["--json"] : []),
            "--registry", join(dir, "agents.json"),
            "--lanes-file", join(dir, "lanes.json"),
            "--run-dir", join(dir, "runs"),
          ],
          { registry: "config/agents.json", runDir: join(dir, "runs") },
        );
      } finally { console.log = origLog; }
      return asJson ? JSON.parse(lines.join("\n")) : lines.join("\n");
    };
    // tokenEnv 已设置在环境里——若引擎仍探它，缺失文件也会得出 key_only_present；
    // 断言 key_only_missing 即钉住"不探 tokenEnv，按文件推导"。
    process.env.TEST_LANES_KIMI_TOKEN = "test-key-lanes-kimi";
    try {
      const tokenFile = join(home, "server.token");

      let payload = await runLanes(true);
      let row = payload.lanes.find((r) => r.id === "kimi_lane");
      assert.equal(row.wiring, "wired", "四轴一致（就绪轴在场）");
      assert.equal(row.readyState, "key_only_missing", "文件缺失 → key_only_missing（tokenEnv 在场也不探）");
      assert.ok(String(row.readyTokenFile).endsWith("server.token"), "行携带 token 文件路径（--json 同源）");

      writeFileSync(tokenFile, "   \n", "utf8");
      payload = await runLanes(true);
      row = payload.lanes.find((r) => r.id === "kimi_lane");
      assert.equal(row.readyState, "key_only_missing", "文件为空（纯空白） → key_only_missing");

      writeFileSync(tokenFile, "  tok-lanes-live  ", "utf8");
      payload = await runLanes(true);
      row = payload.lanes.find((r) => r.id === "kimi_lane");
      assert.equal(row.readyState, "key_only_present", "文件在且非空 → key_only_present（key_only 纪律：不声称令牌有效）");

      const text = await runLanes(false);
      assert.ok(text.includes("readyState: key_only_present"), "人读面 readyState 在场");
      assert.ok(
        text.includes(`credential: token 文件 ${join(home, "server.token")}`),
        "人读面点名 token 文件路径（操作员知道去哪看）",
      );
    } finally {
      delete process.env.TEST_LANES_KIMI_TOKEN;
      cleanupDir(dir);
    }
  } finally { cleanupDir(dir); }
});

// ── TD-283：wao lanes 显示车道的 Owner 暂停派发说明 ──────────────────────────

test("wao lanes：车道带 dispatchHold → 人读行与 --json 都显示；无说明不出现该行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lanescmd-hold-"));
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(join(dir, "lanes.json"), JSON.stringify({
    schema: 2,
    lanes: [
      { id: "h1", backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "max" }, dispatchHold: "夹具：暂停说明", aliases: {} },
      { id: "h2", backend: "codex", model: { id: "gpt-6-astra" }, reasoning: { effort: "high" }, aliases: {} },
    ],
  }), "utf8");
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    agents: {
      h1: { backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "max" }, binary: "C:/wao-test-zcode/zcode.cjs", cwd: dir },
      h2: { backend: "codex", model: { id: "gpt-6-astra" }, reasoning: { effort: "high" }, cwd: dir },
    },
  }), "utf8");
  try {
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await lanesCommand(
        ["--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs") },
      );
      await lanesCommand(
        ["--json", "--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs") },
      );
    } finally { console.log = origLog; }
    const text = lines.join("\n");
    assert.ok(text.includes('dispatchHold: 夹具：暂停说明'), "人读面显示 Owner 原话");
    assert.ok(/dispatchHold[^\n]*不拦截/.test(text), "人读行明示只告知不拦截");
    assert.ok(!/lane h2[\s\S]*?dispatchHold:/.test(text.split("lane h2")[1]?.split("lane ")[0] ?? ""), "无说明车道不带该行");
    const jsonStart = lines.findIndex((l) => l.trim().startsWith("{"));
    const payload = JSON.parse(lines.slice(jsonStart).join("\n"));
    const h1 = payload.lanes.find((r) => r.id === "h1");
    const h2 = payload.lanes.find((r) => r.id === "h2");
    assert.equal(h1.dispatchHold, "夹具：暂停说明");
    assert.equal(h2.dispatchHold, null);
    assert.ok(payload.sourceNotes.dispatchHold, "--json 同源带来源注记");
  } finally { cleanupDir(dir); }
});

// ── TD-318（三）：文本输出的行伪造防线 ────────────────────────────────────────

// 车道表 model.id 是无内容校验的自由文本（dispatchHold 已被 TD-283 结构校验拒绝
// 控制字符，modelId 是仍能流到文本面的注入缝）。值里的换行必须在 join 前可见化
// ——不能在终端伪造一行检查结果。
test("TD-318（三）：wao lanes 文本模式——modelId 含换行不伪造行；正常车道行照常", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lanescmd-forge-"));
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(join(dir, "lanes.json"), JSON.stringify({
    schema: 2,
    lanes: [
      { id: "f1", backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "max" }, aliases: {} },
      { id: "f2", backend: "codex", model: { id: "x\n[FAIL] forged" }, reasoning: { effort: "high" }, aliases: {} },
    ],
  }), "utf8");
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    agents: {
      f1: { backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "max" }, binary: "C:/wao-test-zcode/zcode.cjs", cwd: dir },
    },
  }), "utf8");
  try {
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await lanesCommand(
        ["--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs") },
      );
    } finally { console.log = origLog; }
    const text = lines.join("\n");
    assert.ok(
      !text.split("\n").some((l) => l.startsWith("[FAIL] forged")),
      "值内换行不得伪造一行",
    );
    assert.ok(text.includes("lane f1 —"), "正常车道行照常在场");
    assert.ok(text.includes("lane f2 —"), "带载荷车道照常渲染");
    assert.ok(text.includes("x\\n[FAIL] forged"), "载荷以可见转义留在原行内");
  } finally { cleanupDir(dir); }
});
