// test/application/lanesView.test.js
//
// 0064：wao lanes 读取面的纯投影钉（会审 consult_202610121021490657ur8lp
// 双席 P1 全采纳的可证伪面）：
//   - 行序恒=lanes.json 声明序（零排序零推荐——不按 readyState 重排）；
//   - seatRole 只透传 registry 显式声明（未声明=null，绝不 seatRoleOf 推导）；
//   - certification=null 语义="未取得匹配认证（原因未区分）"，状态原样透传；
//   - 接线四态：wired/drift（axesEqual 同 explicit 派发 G4 判定）/unwired
//     （键不存在）/invalid（键在、条目无法解析）严格分开；
//   - 画像三态：present/absent/invalid（该车道形状错误）/unreadable（整文件）；
//   - 车道表权威失败（ok:false / sha256=null）≠ 成功的空面；合法空表≠失败。
//   - 交叉报告：孤儿画像键/registry 额外键不静默丢弃。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaneTraits, validateTraitEntry, buildLanesView } from "../../src/application/lanesView.js";

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const validTrait = {
  profile: "测试画像",
  suggestedUses: ["用途A", "用途B"],
  contextWindow: { tokens: 1000000, source: "official（测试）" },
  multimodal: { image: true, video: false, source: "official" },
};

test("validateTraitEntry：合法/形状错误字段点名/非对象", () => {
  assert.deepEqual(validateTraitEntry("x", validTrait).entry.suggestedUses, ["用途A", "用途B"]);
  const bad = validateTraitEntry("x", { ...validTrait, profile: 123, suggestedUses: [] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.fields.sort(), ["profile", "suggestedUses"].sort());
  assert.equal(validateTraitEntry("x", "字符串").ok, false);
});

test("readLaneTraits：可读/不可解析/顶层形状坏/单车道形状错误三态分开", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-lv-1-"));
  try {
    const p = join(dir, "t.json");
    writeFileSync(p, JSON.stringify({ schemaVersion: 1, traits: { a: validTrait } }), "utf8");
    const ok = readLaneTraits(p);
    assert.equal(ok.state, "ok");
    assert.ok(ok.sha256);
    assert.ok(ok.traits.a);

    writeFileSync(p, "{ not json", "utf8");
    assert.equal(readLaneTraits(p).state, "unreadable");

    writeFileSync(p, JSON.stringify({ traits: [] }), "utf8");
    assert.equal(readLaneTraits(p).state, "invalid");

    // 单车道形状错误：文件级 ok、该车道降级 + issue（不用默认值冒充事实）。
    writeFileSync(p, JSON.stringify({ traits: { a: validTrait, b: { profile: 1 } } }), "utf8");
    const mixed = readLaneTraits(p);
    assert.equal(mixed.state, "ok");
    assert.equal(mixed.traits.a.profile, "测试画像");
    assert.ok(mixed.issues.some((s) => s.includes("车道 b 画像形状错误")));
  } finally { cleanupDir(dir); }
});

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
    traitsResult: { state: "ok", path: "t.json", sha256: "b".repeat(64), traits: { l1: validTrait }, issues: [] },
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
  assert.equal(unwiredView.lanes[2].seatRole, null);
});

test("buildLanesView：seatRole 只透传显式声明（未声明=null——不经 seatRoleOf 补 non_seat）", () => {
  const input = baseInputs();
  input.registryAgents.l1.seatRole = "adversarial";
  // l2 无声明——若经 seatRoleOf 命名惯例会得到 "non_seat"（推导值），必须保持 null。
  const view = buildLanesView(input);
  assert.equal(view.lanes[0].seatRole, "adversarial");
  assert.equal(view.lanes[1].seatRole, null, "未声明=null（原始事实），绝不显示推导的 non_seat");
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

test("buildLanesView：画像三态 + 孤儿键/registry 额外键交叉报告不静默丢弃", () => {
  const input = baseInputs();
  input.traitsResult = {
    state: "ok", path: "t.json", sha256: "b".repeat(64),
    traits: { l1: validTrait, ghost: validTrait },
    issues: ["车道 l2 画像形状错误（profile）"],
  };
  const view = viewWithInvalidL3(input);
  assert.equal(view.lanes[0].traitsState, "present");
  assert.equal(view.lanes[0].traits.profile, "测试画像");
  assert.equal(view.lanes[1].traitsState, "invalid", "形状错误=invalid");
  assert.equal(view.lanes[2].traitsState, "absent", "无键=absent");
  assert.ok(view.issues.some((s) => s.includes("画像孤儿键：ghost")), "孤儿画像键上报");
  assert.ok(view.issues.some((s) => s.includes("registry 额外键")), "registry 额外键上报");

  const unreadableView = buildLanesView({ ...baseInputs(), traitsResult: { state: "unreadable", path: "t.json", sha256: null, traits: {}, issues: [] } });
  assert.equal(unreadableView.lanes[0].traitsState, "unreadable", "整文件不可读传染所有车道");
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
