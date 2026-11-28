// test/commands/lanesCommand.test.js
//
// 0064：`wao lanes` 命令适配层钉（夹具面——registry 与车道表）：
//   - 防跨绑成对规则：单独 --registry 拒绝；--registry+--lanes-file 放行+注记；
//   - b158a 修复二：--lanes-file 只作本次展示输入，是否合并仍走共享判定
//     （外来注册表+--lanes-file 停用合并、条目不标"已不生效"）；
//     默认判定用 sameRegistryFile（win32 大小写不敏感）；
//   - 车道表不可用：先报告表不可用（不对原始条目 listAgents() 抛缺 backend）；
//   - --json 白名单投影：不泄漏 cwd/sessionReuse/missingCredentialEnvNames；
//   - 车道表权威失败：exitCode 1 + 不渲染正常车道面；
//   - 未知选项 fail-fast。
// readyState 断言只验闭集成员（真探测随机器环境变化——不断言具体值）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
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
  // 夹具 registry：l1 接线一致；l2 的 model 漂移（私有残留观察=drift）。
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

/** 把夹具 lanes.json 读成 loadLanesConfig 形状（配置缝注入；不读真实仓库表）。 */
function lanesDocOf(dir) {
  const parsed = JSON.parse(readFileSync(join(dir, "lanes.json"), "utf8"));
  return {
    ok: true, path: join(dir, "lanes.json"), sha256: "a".repeat(64),
    lanes: parsed.lanes, issues: [], rolesHint: [],
  };
}

test("wao lanes：合并启用渲染——drift 判定/cert null 语义/readyState 闭集（0065：seatRole 列退役）", async () => {
  const dir = makeEnv();
  try {
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await lanesCommand(
        ["--registry", join(dir, "agents.json"), "--run-dir", join(dir, "runs")],
        {
          registry: join(dir, "agents.json"),
          runDir: join(dir, "runs"),
          loadLanesConfigFn: () => lanesDocOf(dir),
        },
      );
    } finally { console.log = origLog; }
    const text = lines.join("\n");
    assert.ok(text.includes("lane l1"), "l1 在场");
    assert.match(text, /^lane l1 — .+ · 推断族系 \S+$/m, "车道行带推断族系（决定 0090）");
    assert.ok(/私有残留四轴（已不生效，可删/.test(text), "l2 drift 判定（b158a：残留观察，非拒绝语义；长行可折行）");
    assert.ok(!text.includes("explicit 派发将拒绝"), "不再断言拒绝语义");
    assert.ok(!text.includes("seatRole:"), "seatRole 列已退役（0065）");
    // 153 批：认证与就绪合一行；null 语义收成「无匹配记录」（原因未区分的解释
    // 移到表头 sourceNotes.certification）——原断言测旧的逐行英文标签与解释句。
    assert.match(text, /认证: certified（lastHealthy 2026-10-06T00:00:00\.000Z）；就绪: \S+/,
      "台账匹配记录并入认证/就绪一行");
    assert.ok(text.includes("认证: 无匹配记录"), "l2 身份不匹配→null 的收敛文案");
    assert.equal(process.exitCode, undefined, "正常面不改退出码");
  } finally { cleanupDir(dir); }
});

test("wao lanes b158a 修复一：drift 只比在场轴——干净条目无残留、部分残留只列该轴、全残留列四轴", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lanescmd-drift-"));
  mkdirSync(join(dir, "runs"), { recursive: true });
  try {
    writeFileSync(join(dir, "lanes.json"), JSON.stringify({
      schema: 2,
      lanes: [
        { id: "clean", backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, reasoning: { effort: "max" }, aliases: {} },
        { id: "partial", backend: "codex", model: { id: "gpt-6.1-sol" }, reasoning: { effort: "high" }, aliases: {} },
        { id: "full", backend: "claude-code", model: { id: "claude-opus-5", providerID: "anthropic" }, reasoning: { effort: "xhigh" }, aliases: {} },
      ],
    }), "utf8");
    writeFileSync(join(dir, "agents.json"), JSON.stringify({
      agents: {
        // 干净：四轴全缺席（只剩本机接线）——合并后生效，不判残留。
        clean: { cwd: dir, binary: "C:/wao-test-zcode/zcode.cjs" },
        // 部分残留：backend 与车道表一致，只有 effort 不同（缺 model 不算残留）。
        partial: { cwd: dir, backend: "codex", reasoning: { effort: "low" } },
        // 全残留：四轴都在场且都与车道表不同。
        full: { cwd: dir, backend: "codex", model: { id: "old-model", providerID: "old-provider" }, reasoning: { effort: "low" } },
      },
    }), "utf8");
    const lanesDoc = lanesDocOf(dir);
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await lanesCommand(
        ["--registry", join(dir, "agents.json"), "--run-dir", join(dir, "runs")],
        {
          registry: join(dir, "agents.json"),
          runDir: join(dir, "runs"),
          loadLanesConfigFn: () => lanesDoc,
        },
      );
    } finally { console.log = origLog; }
    // 渲染可能折行：按车道块切段（"lane <id> — " 起行）。
    const blocks = lines.join("\n").split(/\n(?=lane )/);
    const blockOf = (id) => blocks.find((b) => b.startsWith(`lane ${id} — `)) ?? "";
    const cleanBlock = blockOf("clean");
    assert.ok(cleanBlock, "clean 车道行在场");
    assert.ok(!cleanBlock.includes("私有残留四轴"), "四轴全缺席=干净：不报残留/不标已不生效");
    const partialBlock = blockOf("partial");
    assert.ok(partialBlock.includes("私有残留四轴（已不生效，可删"), "部分残留=有残留事实");
    assert.ok(partialBlock.includes("差异轴：effort"), "只列在场且不同的轴（effort）");
    assert.ok(!partialBlock.includes("差异轴：backend"), "缺键的 backend 不算残留");
    const fullBlock = blockOf("full");
    assert.ok(fullBlock.includes("差异轴：backend/modelId/providerID/effort"), "全残留=四轴逐一列出");
  } finally { cleanupDir(dir); }
});

test("wao lanes b158a 修复二：外来 --registry + --lanes-file → 展示文件只作展示，合并停用（条目不标已不生效）", async () => {
  const dir = makeEnv();
  try {
    // 默认注册表在 default-agents.json；本次实际用的是 agents.json（外来）。
    writeFileSync(join(dir, "default-agents.json"), JSON.stringify({ agents: {} }), "utf8");
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await lanesCommand(
        ["--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: join(dir, "default-agents.json"), runDir: join(dir, "runs") },
      );
    } finally { console.log = origLog; }
    const text = lines.join("\n");
    assert.ok(text.includes("显式拼接面"), "外来+显式车道表仍是成对放行（横幅注记）");
    assert.ok(text.includes("lane l1") && text.includes("lane l2"), "展示用表仍然渲染");
    assert.ok(!text.includes("私有残留四轴"), "合并停用：条目自带四轴即生效值，不标已不生效");
    assert.ok(!text.includes("差异轴："), "合并停用：不出残留轴差");
  } finally { cleanupDir(dir); }
});

test("wao lanes b158a 修复二：默认注册表路径只差大小写 → sameRegistryFile 判默认（不再要求 --lanes-file）", { skip: process.platform !== "win32" }, async () => {
  const dir = makeEnv();
  try {
    const lanesDoc = lanesDocOf(dir);
    const upper = join(dir, "agents.json").toUpperCase();
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      // 只给大小写不同的 --registry（不给 --lanes-file）：旧实现字符串直比 → 误拒。
      await lanesCommand(
        ["--registry", upper, "--run-dir", join(dir, "runs")],
        {
          registry: join(dir, "agents.json"),
          runDir: join(dir, "runs"),
          loadLanesConfigFn: () => lanesDoc,
        },
      );
    } finally { console.log = origLog; }
    assert.ok(lines.join("\n").includes("lane l1"), "路径大小写异拼写按同一文件处理（正常渲染）");
  } finally { cleanupDir(dir); }
});

test("wao lanes b158a 修复二：车道表不可用 → 先报表不可用，不被原始条目缺 backend 盖住", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lanescmd-badtable-"));
  mkdirSync(join(dir, "runs"), { recursive: true });
  try {
    // 原始条目去掉四轴（只剩 cwd）；共享表非法（缺 lanes 数组）。
    writeFileSync(join(dir, "agents.json"), JSON.stringify({ agents: { l1: { cwd: dir } } }), "utf8");
    const badDoc = {
      ok: false, path: "<fixture>", sha256: null, issues: ["lanes 数组缺席（空表须显式 lanes: []）"],
      lanes: [], rolesHint: [],
    };
    const lines = [];
    const origLog = console.log;
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...a) => { lines.push(a.join(" ")); };
    try {
      await lanesCommand(
        ["--run-dir", join(dir, "runs")],
        { registry: join(dir, "agents.json"), runDir: join(dir, "runs"), loadLanesConfigFn: () => badDoc },
      );
    } finally {
      console.log = origLog;
      process.exitCode = savedExitCode;
    }
    const text = lines.join("\n");
    assert.ok(text.includes("车道表不可用"), "先报告车道表不可用");
    assert.ok(text.includes("lanes 数组缺席"), "带表的结构原因");
    assert.ok(!/missing backend/.test(text), "不再先抛私有条目缺 backend");
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

/** 夹具车道表：声明序 t1(实测三格带 score，声明了 peak)、t2(全未评)、
 *  t3(带 dispatchHold)、t4(无画像)、t5(打分身份不一致——159 批起待复核的唯一
 *  来源)。t1 与 registry 四轴一致（current）；t2 全未评（unrated→未评，不是
 *  待复核）；t5 待复核（review）。quotaPools（153 批）：lane id → quotaPool，
 *  给了才带该键。 */
function makeTableEnv(quotaPools = {}) {
  const pool = (id) => (quotaPools[id] !== undefined ? { quotaPool: quotaPools[id] } : {});
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
        ...pool("t1"),
        costTier: 0.5,
        peak: { days: "weekdays", hours: ["14:00-18:00"], effect: "非高峰消耗减半" },
        ratings: {
          research: { stars: 3, basis: "measured", n: 99, evidence: "e", score: { hits: 68, total: 99, label: "与终裁一致" } },
          code: { stars: 3, basis: "measured", n: 2, evidence: "e", score: { hits: 27, total: 28, label: "隐藏测试通过" } },
          review: { stars: 3, basis: "measured", n: 19, evidence: "e" }, // 实测无分数
          design: { stars: 4, basis: "owner", note: "advisor" },
          longHorizon: unrated(), writing: unrated(), visual: unrated(),
        },
        ratedAgainst: { backend: "zcode", modelId: "p1/m1", providerID: null, effort: "max" },
      }),
      t2: baseEntry({ ...pool("t2") }),
      t3: baseEntry({
        ...pool("t3"),
        costTier: 4,
        ratings: {
          code: { stars: 5, basis: "owner", note: "后端强" },
          research: unrated(), review: unrated(), design: unrated(),
          longHorizon: unrated(), writing: unrated(), visual: unrated(),
        },
        ratedAgainst: { backend: "codex", modelId: "m3", providerID: null, effort: "high" },
      }),
      // 159 批：t5 的待复核来自身份不一致（打分时 m5-old，车道表现为 m5）——
      // 手写 reviewPending 已撤，夹具改用唯一合法来源。
      t5: baseEntry({
        ...pool("t5"),
        ratings: {
          code: { stars: 3, basis: "owner", note: "换代前旧档" },
          research: unrated(), review: unrated(), design: unrated(),
          longHorizon: unrated(), writing: unrated(), visual: unrated(),
        },
        ratedAgainst: { backend: "codex", modelId: "m5-old", providerID: null, effort: "high" },
      }),
    },
    invalidIds: [], issues: [],
  };
  return { dir, traitsResult };
}

// 152 批：对照表"此刻"的时钟缝注入（生产缺省 Date.now）。夹具钉在
// 2026-11-26（周四）12:30 北京时间——GLM 高峰外、DeepSeek 两段之间。
const TBL_NOW = (Date.UTC(2026, 10, 26, 12, 30) - 8 * 60 * 60 * 1000);

async function runLanesCapture(dir, traitsResult, args = [], over = {}) {
  const chunks = [];
  const origLog = console.log;
  console.log = (...a) => { chunks.push(a.join(" ")); };
  try {
    await lanesCommand(
      ["--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs"), ...args],
      {
        registry: "config/agents.json", runDir: join(dir, "runs"),
        readLaneTraitsFn: () => traitsResult,
        nowMsFn: () => TBL_NOW,
        ...over,
      },
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
    // 表头上方的"此刻"行（152 批，注入时钟=周四 12:30）。
    assert.match(lines[headerIdx + 1], /^  此刻：北京时间 周四 12:30（法定节假日不识别，按工作日算）$/,
      "表头上方的此刻行（北京时间 + 节假日口径）");
    // 表头八列（152 批起含"此刻"）。
    assert.match(lines[headerIdx + 2], /车道\s+族系\s+写代码\s+把关\s+调研\s+成本档\s+此刻\s+状态/);
    // 声明序：t1 行在 t2 行之前，以此类推。
    const rowIdx = (id) => lines.findIndex((l) => new RegExp(`^\\s*${id}\\s`).test(l));
    assert.ok(rowIdx("t1") < rowIdx("t2") && rowIdx("t2") < rowIdx("t3") && rowIdx("t3") < rowIdx("t4"),
      "表行序=声明序");
    // 格写法（152 批起不折算百分比）：实测（3★ n=…）、Owner 评（5★ 主观）、未评（—）。
    const t1Row = lines[rowIdx("t1")];
    assert.match(t1Row, /3★ n=2/, "实测格只带星级与 n（27/28 不折算百分比）");
    assert.match(t1Row, /3★ n=99/, "调研格只带 n");
    assert.match(t1Row, /3★ n=19/, "实测无分数只带 n");
    assert.ok(!/\d+%/.test(lines.slice(headerIdx, rowIdx("t5") + 1).join("\n")),
      "对照表块内不再出现百分比");
    const t3Row = lines[rowIdx("t3")];
    assert.match(t3Row, /5★ 主观/, "Owner 评写主观");
    assert.match(t3Row, /—/, "未评格写 —");
    // 成本档列。
    assert.match(t1Row, /0\.5/, "t1 成本档 0.5");
    assert.match(t3Row, / 4\s/, "t3 成本档 4");
    // "此刻"列（152 批）：t1 声明了 peak（周四 12:30 → 高峰外，至 14:00）；
    // 其余车道未声明 → —（整表恰一格带"高峰/非高峰，至"字样）。
    assert.match(t1Row, /非高峰，至 14:00/, "t1 此刻=非高峰，至 14:00（同一天不带星期）");
    assert.equal(
      lines.slice(headerIdx, rowIdx("t5") + 1).filter((l) => /(高峰|非高峰)，至/.test(l)).length,
      1, "只有声明了 peak 的车道带此刻状态格，其余都是 —",
    );
    // 状态列：t3 暂停（dispatchHold）、t2 未评（unrated 不写成待复核）、t4 无画像、
    // t5 待复核（打分身份不一致）、t1 空。
    assert.match(t3Row, /暂停/, "dispatchHold → 暂停");
    assert.match(lines[rowIdx("t2")], /未评$/, "ratingsState unrated → 未评");
    assert.ok(!lines[rowIdx("t2")].includes("待复核"), "没评过不写成待复核");
    assert.match(lines[rowIdx("t4")], /无画像$/, "画像文件无该车道键 → 无画像");
    assert.match(lines[rowIdx("t5")], /待复核$/, "ratingsState review → 待复核");
    for (const word of ["暂停", "待复核", "未评", "无画像"]) {
      assert.ok(!lines[rowIdx("t1")].includes(word), `current 且无暂停 → 状态空（不含 ${word}）`);
    }
    // 表尾图例（152 批：无百分比句；此刻列 — 注明=未声明高峰）。
    const legendIdx = rowIdx("t5") + 1;
    assert.match(lines[legendIdx], /^\s+格：星级、n=样本量；主观=Owner 评；—=无评分（未评或画像不可用）；此刻列 —=车道未声明高峰时段$/, "表尾图例");
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

test("152 wao lanes：此刻列——高峰内写「高峰，至 HH:MM」；周五晚写到下周一（跨天带星期）", async () => {
  const { dir, traitsResult } = makeTableEnv();
  try {
    // 周四 15:00：t1 在声明高峰内。
    const inPeak = await runLanesCapture(dir, traitsResult, [], {
      nowMsFn: () => (Date.UTC(2026, 10, 26, 15, 0) - 8 * 60 * 60 * 1000),
    });
    const rowIdxIn = inPeak.findIndex((l) => /^\s*t1\s/.test(l));
    assert.match(inPeak[rowIdxIn], /高峰，至 18:00/, "高峰内：至当日结束钟点");
    assert.ok(inPeak.some((l) => l.includes("此刻：北京时间 周四 15:00（法定节假日不识别，按工作日算）")));

    // 周五 20:00（高峰已过，下一边界=周一 14:00，跨天带星期）。
    const friday = await runLanesCapture(dir, traitsResult, [], {
      nowMsFn: () => (Date.UTC(2026, 10, 27, 20, 0) - 8 * 60 * 60 * 1000),
    });
    const rowIdxFri = friday.findIndex((l) => /^\s*t1\s/.test(l));
    assert.match(friday[rowIdxFri], /非高峰，至 周一 14:00/, "跨天带星期");
    assert.ok(friday.some((l) => l.includes("此刻：北京时间 周五 20:00（法定节假日不识别，按工作日算）")));
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
      // 153 批：认证与就绪合一行——原断言测旧的「readyState: …」独立行标签。
      assert.ok(text.includes("就绪: key_only_present"), "人读面就绪值在场（认证/就绪合行）");
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
    // 153 批：行只写 Owner 原话——原断言测行尾的「（Owner 暂停说明，仅提示不
    // 拦截…）」后缀；该层意思改由 sourceNotes.dispatchHold 说一次（--json 里断言）。
    const holdLine = text.split("\n").find((l) => l.includes("dispatchHold: 夹具：暂停说明"));
    assert.equal(holdLine.trim(), "dispatchHold: 夹具：暂停说明", "行内只有 Owner 原话，无后缀解释");
    assert.ok(!text.includes("仅提示不拦截——派发决定权在 Lead）"), "旧后缀不复现");
    assert.ok(!/lane h2[\s\S]*?dispatchHold:/.test(text.split("lane h2")[1]?.split("lane ")[0] ?? ""), "无说明车道不带该行");
    const jsonStart = lines.findIndex((l) => l.trim().startsWith("{"));
    const payload = JSON.parse(lines.slice(jsonStart).join("\n"));
    const h1 = payload.lanes.find((r) => r.id === "h1");
    const h2 = payload.lanes.find((r) => r.id === "h2");
    assert.equal(h1.dispatchHold, "夹具：暂停说明");
    assert.equal(h2.dispatchHold, null);
    assert.ok(payload.sourceNotes.dispatchHold, "--json 同源带来源注记");
    assert.ok(payload.sourceNotes.dispatchHold.includes("不拦截"), "「只告知不拦截」由注记说一次");
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

// ── 153 批：默认一屏只报例外 + --evidence 出处档 + 额度池结构化 ──────────────

test("153 wao lanes：默认输出不印出处（evidence/source/sha256），常态行不占行，「非推荐」只一次", async () => {
  const { dir, traitsResult } = makeTableEnv();
  try {
    const lines = await runLanesCapture(dir, traitsResult);
    const text = lines.join("\n");
    for (const banned of ["evidence:", "[source:", "sha256=", "接线: 一致", "注意事项: 无", "评分状态: 当前"]) {
      assert.ok(!text.includes(banned), `默认输出不印「${banned}」`);
    }
    // 夹具 t1–t5 全部接线一致 → 连「接线:」都不出现；车道行照常在场。
    assert.ok(!text.includes("接线:"), "接线一致的常态行不占行");
    assert.ok(text.includes("lane t1"), "车道行照常在场");
    // 认证与就绪合一行（夹具无台账 → 无匹配记录；原因解释只在表头注记）。
    assert.ok(text.includes("认证: 无匹配记录；就绪: "), "认证与就绪合一行");
    // 修正一（会审补盖）：null 的原因解释句有测试守卫——删掉 lanesView 里那句即红。
    // 注记按 120 列硬折行，展平空白后再断言整句。
    const flat = text.replace(/\s+/g, "");
    assert.ok(flat.includes("无匹配记录的原因未区分：无记录/身份不匹配/台账缺失或不可读"),
      "sourceNotes.certification 含「原因未区分」解释（默认面可见一次）");
    assert.equal(lines.filter((l) => l.includes("非推荐")).length, 1, "「非推荐」只在标题行出现一次");
    assert.equal(lines.filter((l) => l.includes("行序")).length, 1, "行序只由对照表标题说一次（sourceNotes.order 已删）");
  } finally { cleanupDir(dir); }
});

test("153 wao lanes：没评的维度合成一行；七格全没评只留评分状态行；部分已评+待复核两条事实都在（修正一）", async () => {
  const { dir, traitsResult } = makeTableEnv();
  try {
    const lines = await runLanesCapture(dir, traitsResult);
    const text = lines.join("\n");
    assert.ok(text.includes("  未评: 长程自主、文案、视觉设计"), "t1 未评合成一行（维度原序、顿号）");
    assert.ok(text.includes("  未评: 调研整理、抓 bug/把关、方案设计、长程自主、文案、视觉设计"),
      "t3 只评了一格，其余六格合一行");
    assert.ok(!lines.some((l) => /^\s+\S+: 未评$/.test(l)), "不再每格一行「X: 未评」");
    // t2 七格全没评、无待复核：无评分块、无未评行，只有评分状态行（唯一例外）。
    const t2Block = text.split("lane t2")[1].split("lane t3")[0];
    assert.ok(!t2Block.includes("评分（刻度见表头）"), "七格全没评不铺评分块");
    assert.ok(!t2Block.includes("未评:"), "全没评（评分状态=未评）不再列维度行");
    assert.ok(t2Block.includes("评分状态: 未评（七格全未评——未评不折算成任何星数）"), "只有评分状态行");
    // 例外照旧：t1 评分当前不占行。
    const t1Block = text.split("lane t1")[1].split("lane t2")[0];
    assert.ok(!t1Block.includes("评分状态"), "评分状态「当前」不占行");
    // 修正一（会审 FIX_FIRST）：t5 一格已评 + 身份不一致待复核（159 批起这是
    // 待复核的唯一来源）——待复核原因与「未评: 六项」两条事实都要显示，不能
    // 只剩待复核。
    const t5Block = text.split("lane t5")[1];
    assert.ok(t5Block.includes("评分状态: 待复核——"), "待复核照旧写");
    assert.ok(t5Block.includes("modelId：打分时 m5-old，现为 m5"), "待复核原因=身份不一致串");
    assert.ok(t5Block.includes("未评: 调研整理、抓 bug/把关、方案设计、长程自主、文案、视觉设计"),
      "部分已评+待复核时未评一行也在场（六项按原顺序）");
  } finally { cleanupDir(dir); }
});

test("153 wao lanes --evidence：evidence 行、[source:]、sha256 行在场；细节例外口径两档一致", async () => {
  const { dir, traitsResult } = makeTableEnv();
  try {
    const lines = await runLanesCapture(dir, traitsResult, ["--evidence"]);
    const text = lines.join("\n");
    assert.ok(text.includes("evidence: e"), "实测格 evidence 行照旧在场");
    assert.match(text, /上下文: 1000000 tokens \[source: official（测试）\] · 图片 是 · 视频 否 \[source: official\]/,
      "context/multimodal 合行，--evidence 时 source 跟在各自后面");
    assert.match(text, /lanes\.json sha256=[0-9a-f]{64}；画像文件 .*traits\.json sha256=b{64}/, "尾部出处行照旧在场");
    for (const stillBanned of ["接线: 一致", "注意事项: 无", "评分状态: 当前"]) {
      assert.ok(!text.includes(stillBanned), `--evidence 也不复活常态行（${stillBanned}）`);
    }
    // 修正一：--evidence 档同样要双事实并存（t5 一格已评 + 身份不一致待复核）。
    const t5Evidence = text.split("lane t5")[1];
    assert.ok(t5Evidence.includes("评分状态: 待复核——"), "待复核在场");
    assert.ok(t5Evidence.includes("未评: 调研整理、抓 bug/把关、方案设计、长程自主、文案、视觉设计"),
      "未评一行在 --evidence 档同样在场");
  } finally { cleanupDir(dir); }
});

test("153 wao lanes：共用额度一行——只列两条及以上的池（池序/池内序=声明序）；成本行带池名；--json 行带 quotaPool", async () => {
  const { dir, traitsResult } = makeTableEnv({ t1: "池甲", t2: "池甲", t3: "池乙", t5: "池乙" });
  try {
    const lines = await runLanesCapture(dir, traitsResult);
    const text = lines.join("\n");
    const poolsIdx = lines.findIndex((l) => l.trim() === "共用额度:");
    const scaleIdx = lines.findIndex((l) => l.includes("成本档：Owner 给的相对档位"));
    const rulesIdx = lines.findIndex((l) => l.includes("Owner 规则（排在前面的优先）"));
    assert.ok(poolsIdx > -1, "共用额度块标题在场");
    assert.ok(poolsIdx > scaleIdx && poolsIdx < rulesIdx, "位置=成本档说明之后、Owner 规则之前");
    // 修正一（会审）：一池一行，不再整行硬折把车道名劈开。
    assert.equal(lines[poolsIdx], "  共用额度:", "标题行独占");
    assert.equal(lines[poolsIdx + 1], "    池甲：t1、t2", "第一池一行（池内=声明序）");
    assert.equal(lines[poolsIdx + 2], "    池乙：t3、t5", "第二池一行");
    assert.ok(text.includes("成本（池甲）: 按量计费"), "成本行带池名");
    // --json 车道行同样带 quotaPool（traits 原样投影）。
    let payload = null;
    const origLog = console.log;
    console.log = (s) => { payload = JSON.parse(s); };
    try {
      await lanesCommand(
        ["--json", "--registry", join(dir, "agents.json"), "--lanes-file", join(dir, "lanes.json"), "--run-dir", join(dir, "runs")],
        { registry: "config/agents.json", runDir: join(dir, "runs"), readLaneTraitsFn: () => traitsResult },
      );
    } finally { console.log = origLog; }
    assert.equal(payload.lanes.find((r) => r.id === "t1").traits.quotaPool, "池甲");
    assert.equal(payload.lanes.find((r) => r.id === "t4").traits, undefined, "无画像车道无 traits（quotaPool 也在其中）");
  } finally { cleanupDir(dir); }
});

test("153 wao lanes：只有单车道池（或全部没给 quotaPool）时不写共用额度行；成本行照旧不带池名", async () => {
  // 三个池各只一条车道 → 没有共用池。
  const solo = makeTableEnv({ t1: "独池甲", t3: "独池乙", t5: "独池丙" });
  try {
    const lines = await runLanesCapture(solo.dir, solo.traitsResult);
    const text = lines.join("\n");
    assert.ok(!text.includes("共用额度"), "单车道池不列共用额度行");
    assert.ok(text.includes("成本（独池甲）: 按量计费"), "成本行仍带单车道池名");
  } finally { cleanupDir(solo.dir); }
  // 全部没给 quotaPool → 成本行照旧「成本: …」。
  const bare = makeTableEnv();
  try {
    const lines = await runLanesCapture(bare.dir, bare.traitsResult);
    const text = lines.join("\n");
    assert.ok(!text.includes("共用额度"), "没有共用池不写这一行");
    assert.ok(!text.includes("成本（"), "无池名后缀");
    assert.ok(text.includes("成本: 按量计费"), "成本行照旧");
  } finally { cleanupDir(bare.dir); }
});

// 153 修正一（deepseek-flash 会审 §4 补盖）：未接线与画像无效两条命令级渲染
// 分支此前无测试——误删不红。夹具：v1 接线一致、u1 不在 registry（未接线）、
// iv 在 registry 但画像形状错误（经 issues 注入降级）。
test("153 修正一 wao lanes：未接线车道与画像无效车道照常渲染例外行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lanescmd-x-"));
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(join(dir, "lanes.json"), JSON.stringify({
    schema: 2,
    lanes: [
      { id: "v1", backend: "zcode", model: { id: "p1/m1" }, reasoning: { effort: "max" }, aliases: {} },
      { id: "u1", backend: "codex", model: { id: "m9" }, reasoning: { effort: "high" }, aliases: {} },
      { id: "iv", backend: "codex", model: { id: "m8" }, reasoning: { effort: "high" }, aliases: {} },
    ],
  }), "utf8");
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    agents: {
      v1: { backend: "zcode", model: { id: "p1/m1" }, reasoning: { effort: "max" }, binary: "C:/wao-test-zcode/zcode.cjs", cwd: dir },
      iv: { backend: "codex", model: { id: "m8" }, reasoning: { effort: "high" }, cwd: dir },
    },
  }), "utf8");
  const traitsResult = {
    state: "ok", path: join(dir, "traits.json"), sha256: "b".repeat(64), scale: SCALE,
    costTierScale: "成本档：Owner 给的相对档位，0.5–5，数越小越便宜；不是价格倍数",
    ownerRules: [], observations: [],
    traits: { v1: baseEntry() },
    invalidIds: ["iv"],
    issues: ["车道 iv 画像形状错误（cost）"],
  };
  try {
    const lines = await runLanesCapture(dir, traitsResult);
    const text = lines.join("\n");
    const u1Block = text.split("lane u1")[1].split("lane iv")[0];
    const ivBlock = text.split("lane iv")[1];
    assert.ok(
      u1Block.includes("接线: 未接线（registry 无键 u1——认证/就绪跳过）"),
      "未接线车道渲染例外行",
    );
    assert.ok(!u1Block.includes("认证:"), "未接线车道无认证/就绪行（探测跳过）");
    assert.ok(u1Block.includes("画像: 未提供（画像文件无该车道键）"), "未接线车道画像缺席照常报告");
    assert.ok(ivBlock.includes("画像: 形状错误（见尾部 issues）"), "画像无效车道渲染例外行");
    assert.ok(text.includes("车道 iv 画像形状错误（cost）"), "尾部 issues 点名字段");
    // 接线一致的 v1 仍不占接线行（只报例外口径不被这两条破坏）。
    const v1Block = text.split("lane v1")[1].split("lane u1")[0];
    assert.ok(!v1Block.includes("接线:"), "接线一致不占行");
  } finally { cleanupDir(dir); }
});
