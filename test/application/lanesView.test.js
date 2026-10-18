// test/application/lanesView.test.js
//
// 0064：wao lanes 读取面的纯投影钉（会审 consult_202610121021490657ur8lp
// 双席 P1 全采纳的可证伪面）：
//   - 行序恒=lanes.json 声明序（零排序零推荐——不按 readyState 重排）；
//   - 0065（0045 §1.2 终局）：seatRole 声明列已删除（席位角色维退役——对抗性
//     改派生事实；registry 归一化 strip 该字段）；行不再携带 seatRole 键。
//   - certification=null 语义="未取得匹配认证（原因未区分）"，状态原样透传；
//   - 接线四态：wired/drift（axesEqual 同 explicit 派发 G4 判定）/unwired
//     （键不存在）/invalid（键在、条目无法解析）严格分开；
//   - 画像三态：present/absent/invalid（该车道形状错误）/unreadable（整文件）；
//     present 时行带 v2 画像与 ratingsState/reviewReasons（0087），表头带
//     刻度行与维度中文名；
//   - 车道表权威失败（ok:false / sha256=null）≠ 成功的空面；合法空表≠失败。
//   - 交叉报告：孤儿画像键/registry 额外键不静默丢弃。
// （画像文件加载与 v2 形状校验的钉在 test/application/laneProfile.test.js。）
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLanesView } from "../../src/application/lanesView.js";
import { DIMENSION_LABELS } from "../../src/application/laneProfile.js";

const unrated = () => ({ stars: null, basis: null });
const noRatings = () => ({
  research: unrated(), code: unrated(), review: unrated(), design: unrated(),
  longHorizon: unrated(), writing: unrated(), visual: unrated(),
});

const validTrait = {
  ratings: noRatings(),
  ratedAgainst: null,
  cost: "按量计费",
  caveats: [],
  contextWindow: { tokens: 1000000, source: "official（测试）" },
  multimodal: { image: true, video: false, source: "official" },
};

const scale = { "5": "最强", "4": "强", "3": "堪用", "2": "弱", "1": "不适合" };

// ── buildLanesView 夹具 ───────────────────────────────────────────────────────

const laneDoc = (lanesArr, opts = {}) => ({
  ok: opts.ok ?? true,
  // 显式 null 必须保真（sha256=null=文件缺失判据）——?? 会把 null 吞成默认值。
  sha256: "sha256" in opts ? opts.sha256 : "a".repeat(64),
  lanes: lanesArr,
  issues: opts.issues ?? [],
});
const L1 = { id: "l1", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" } };
const L2 = { id: "l2", backend: "codex", model: { id: "m2" }, reasoning: { effort: null } };
const L3 = { id: "l3", backend: "codex", model: { id: "m3" }, reasoning: { effort: null } };

const agent = (over = {}) => ({
  id: "x", backend: "zcode", model: { id: "m1" }, reasoning: { effort: "max" }, ...over,
});

function baseInputs() {
  return {
    lanesDoc: laneDoc([L1, L2, L3]),
    traitsResult: { state: "ok", path: "t.json", sha256: "b".repeat(64), scale, traits: { l1: validTrait }, invalidIds: [], issues: [] },
    inventory: {
      agents: [
        { id: "l1", certification: "certified", certificationLastHealthyAt: "2026-10-06T00:00:00.000Z" },
        { id: "l2", certification: null, certificationLastHealthyAt: null },
      ],
      issues: [],
    },
    registryAgents: {
      l1: agent(),
      l2: agent({ id: "l2", backend: "codex", model: { id: "m2" }, reasoning: { effort: null } }),
      // l3 键存在但条目无效（inventory.issues 记 invalid_configuration）。
      l3: agent({ id: "l3", backend: "codex", model: { id: "m3" } }),
      // 额外键：registry 有、lanes.json 无——不进行面，但必须上报。
      extra_seat: agent({ id: "extra_seat", backend: "codex", model: { id: "m9" } }),
    },
    readyRows: [
      { id: "l1", readyState: "ready" },
      { id: "l2", readyState: "missing_key" },
    ],
  };
}
const viewWithInvalidL3 = (input) => buildLanesView({
  ...input,
  inventory: { ...input.inventory, issues: [{ code: "invalid_configuration", agentId: "l3" }] },
});

test("buildLanesView：四接线态 + 行序钉（lanes.json 声明序，不按 readyState 重排）", () => {
  const input = baseInputs();
  const view = viewWithInvalidL3(input);
  assert.equal(view.state, "ok");
  assert.deepEqual(view.lanes.map((r) => r.id), ["l1", "l2", "l3"], "行序=声明序");
  assert.equal(view.lanes[0].wiring, "wired");
  assert.equal(view.lanes[2].wiring, "invalid", "键在+条目无效=invalid（≠unwired）");

  // drift：registry effort 与声明不一致（G4 同判定）。
  const driftInput = baseInputs();
  driftInput.registryAgents.l1 = agent({ reasoning: { effort: "low" } });
  const driftView = buildLanesView(driftInput);
  assert.equal(driftView.lanes[0].wiring, "drift");
  assert.equal(driftView.lanes[0].wiringDetail.declared.effort, "max");
  assert.equal(driftView.lanes[0].wiringDetail.registry.effort, "low");

  // unwired：registry 无 l3 键。
  const unwiredInput = baseInputs();
  delete unwiredInput.registryAgents.l3;
  const unwiredView = buildLanesView(unwiredInput);
  assert.equal(unwiredView.lanes[2].wiring, "unwired");
  assert.equal(unwiredView.lanes[2].readyState, null, "未接线=跳过探测");
  assert.equal(unwiredView.lanes[2].certification, null);
});

test("buildLanesView：每行带推断族系（决定 0090），与 lead_preflight 同一推断", () => {
  const view = viewWithInvalidL3(baseInputs());
  assert.deepEqual(view.lanes.map((r) => r.family), ["未知族系", "GPT", "GPT"],
    "zcode 认不出型号即未知；codex 车道归 GPT——接线状态（含 invalid）不影响族系");
});

test("buildLanesView：行不再携带 seatRole 键（0065 列退役钉——恢复即红）", () => {
  const input = baseInputs();
  // registry 侧带旧声明（迁移期形状）——归一化已 strip，视图行也不得再出现该键。
  input.registryAgents.l1.seatRole = "adversarial";
  const view = buildLanesView(input);
  for (const row of view.lanes) {
    assert.ok(!("seatRole" in row), `行 ${row.id} 不得携带 seatRole（0065 退役）`);
  }
});

test("buildLanesView：certification null 语义收窄 + 状态原样透传", () => {
  const view = buildLanesView(baseInputs());
  assert.equal(view.lanes[0].certification, "certified");
  assert.equal(view.lanes[0].certificationLastHealthyAt, "2026-10-06T00:00:00.000Z");
  assert.equal(view.lanes[1].certification, null);
  assert.equal(view.lanes[1].certificationNote, "unmatched_reason_unspecified",
    "null=未取得匹配认证（原因未区分：无记录/身份不匹配/台账缺失或不可读）");
  // 非 certified/conditional 的台账状态原样透传（不折叠不映射）。
  const input = baseInputs();
  input.inventory.agents[0].certification = "draft-only";
  assert.equal(buildLanesView(input).lanes[0].certification, "draft-only");
});

test("buildLanesView：画像三态 + v2 行形状（ratingsState/reviewReasons/刻度行）", () => {
  const input = baseInputs();
  // l1：全未评（ratedAgainst null）。
  // l2：已评且 ratedAgainst 与声明一致 → current；不一致 → review。
  const ratedTrait = {
    ...validTrait,
    ratings: { ...noRatings(), review: { stars: 4, basis: "measured", n: 8, evidence: "提交 aaa1111", note: "稳" } },
    ratedAgainst: { backend: "codex", modelId: "m2", providerID: null, effort: null },
  };
  input.traitsResult = {
    state: "ok", path: "t.json", sha256: "b".repeat(64), scale,
    traits: { l1: validTrait, l2: ratedTrait, ghost: validTrait },
    invalidIds: [],
    issues: ["车道 l3 画像形状错误（cost）"],
  };
  const view = viewWithInvalidL3(input);
  assert.equal(view.lanes[0].traitsState, "present");
  assert.equal(view.lanes[0].traits.cost, "按量计费");
  assert.equal(view.lanes[0].ratingsState, "unrated", "七格全未评");
  assert.deepEqual(view.lanes[0].reviewReasons, []);
  assert.equal(view.lanes[1].traitsState, "present");
  assert.equal(view.lanes[1].ratingsState, "current", "打分身份与声明一致");
  // 身份漂移（registry 侧改轴不进画像比对——ratedAgainst 比的是 lanes.json 声明；
  // 这里直接给 lanes.json 另一个 modelId 构造不一致）。
  const driftTraitInput = baseInputs();
  driftTraitInput.lanesDoc = laneDoc([L1, { ...L2, model: { id: "m2x" } }, L3]);
  driftTraitInput.traitsResult = {
    state: "ok", path: "t.json", sha256: "b".repeat(64), scale,
    traits: { l2: ratedTrait }, invalidIds: [], issues: [],
  };
  const driftTraitsView = buildLanesView(driftTraitInput);
  assert.equal(driftTraitsView.lanes[1].ratingsState, "review", "ratedAgainst 与声明不一致=待复核");
  assert.deepEqual(driftTraitsView.lanes[1].reviewReasons, ["modelId：打分时 m2，现为 m2x"]);
  // reviewPending 原文并入。
  const pendingInput = baseInputs();
  pendingInput.traitsResult = {
    state: "ok", path: "t.json", sha256: "b".repeat(64), scale,
    traits: { l1: { ...validTrait, reviewPending: "换代待重测" } }, invalidIds: [], issues: [],
  };
  // 全未评 + reviewPending：只免身份比对，照样待复核。
  assert.equal(buildLanesView(pendingInput).lanes[0].ratingsState, "review");

  assert.equal(view.lanes[2].traitsState, "invalid", "形状错误=invalid");
  assert.ok(view.issues.some((s) => s.includes("画像孤儿键：ghost")), "孤儿画像键上报");
  assert.ok(view.issues.some((s) => s.includes("registry 额外键")), "registry 额外键上报");

  // 表头：刻度行一次 + 七个维度中文名 + sourceNotes.profile 现状文案。
  assert.equal(view.traitsScale, "5 最强；4 强；3 堪用；2 弱；1 不适合；null 未评");
  assert.deepEqual(Object.keys(view.dimensionLabels),
    ["research", "code", "review", "design", "longHorizon", "writing", "visual"]);
  assert.deepEqual(view.dimensionLabels, DIMENSION_LABELS, "维度名从 laneProfile 的唯一归宿投影");
  assert.ok(typeof view.sourceNotes.profile === "string" && view.sourceNotes.profile.length > 0, "画像来源说明在场");

  const unreadableView = buildLanesView({ ...baseInputs(), traitsResult: { state: "unreadable", path: "t.json", sha256: null, scale: null, traits: {}, invalidIds: [], issues: [] } });
  assert.equal(unreadableView.lanes[0].traitsState, "unreadable", "整文件不可读传染所有车道");
  assert.equal(unreadableView.traitsScale, null, "不可读时无刻度行");
});

test("buildLanesView：车道表权威失败≠成功的空面；合法空表≠失败", () => {
  const bad = buildLanesView({ ...baseInputs(), lanesDoc: laneDoc([], { ok: false, issues: ["结构坏"] }) });
  assert.equal(bad.state, "lanes_invalid");
  assert.equal(bad.lanes.length, 0);
  assert.ok(bad.issues.some((s) => s.includes("结构非法")));

  const unreadable = buildLanesView({ ...baseInputs(), lanesDoc: laneDoc([], { sha256: null }) });
  assert.equal(unreadable.state, "lanes_unreadable", "ok:true+sha256:null=文件缺失/不可读");

  const empty = buildLanesView({ ...baseInputs(), lanesDoc: laneDoc([]) });
  assert.equal(empty.state, "ok");
  assert.equal(empty.lanesStateNote, "车道表为空（lanes.json 合法但零车道）", "合法空表=正常面+注记");
});

// ── TD-283：dispatchHold 行投影 ──────────────────────────────────────────────

test("buildLanesView：dispatchHold=车道表事实（与接线状态无关）；坏形状/无说明 → null", () => {
  const input = baseInputs();
  input.lanesDoc = laneDoc([
    { ...L1, dispatchHold: "夹具：暂停说明" },
    L2,
    { ...L3, dispatchHold: "  " },
  ]);
  const view = viewWithInvalidL3(input);
  assert.equal(view.lanes[0].dispatchHold, "夹具：暂停说明", "有说明车道原文透出");
  assert.equal(view.lanes[1].dispatchHold, null, "无说明车道 → null");
  // l3 接线态=invalid，但 dispatchHold 是车道表事实，读取不因接线状态折叠——
  // 本例值本身形状不合法 → null（fail-to-null，不猜）。
  assert.equal(view.lanes[2].dispatchHold, null, "形状不合法 → null");

  // invalid 接线 + 合法说明：仍透出（车道表事实与 registry 接线状态无关）。
  const input2 = baseInputs();
  input2.lanesDoc = laneDoc([{ ...L1, dispatchHold: "暂停" }, L2, { ...L3, dispatchHold: "也暂停" }]);
  const view2 = viewWithInvalidL3(input2);
  assert.equal(view2.lanes[2].dispatchHold, "也暂停", "接线 invalid 的车道照样带车道表说明");

  const plain = buildLanesView(baseInputs());
  assert.equal(plain.lanes[0].dispatchHold, null, "无说明 → null");
  assert.ok(plain.sourceNotes.dispatchHold, "头部来源注记在场");
  assert.ok(plain.sourceNotes.dispatchHold.includes("不拦截"), "注记明示只告知不拦截");
});
