// panelReadiness.test.js
//
// R9（决策 0023）：三席会审就绪分级的单一实现（src/application/panelReadiness.js）
// 契约测试。Owner 需求 2（三席/两席/无分级 + 六态映射 + 单 worker 注脚 + 同族
// 提示）与需求 5（未知族系不参与同族判定）在这里钉死；onboarding（模板面）与
// doctor（已配置面）只是输入包装，两处的行为断言分别在各自测试文件。
//
// R9-C C-1 返工后分级语义：按**席位候选**计数——对抗席候选（auditor 专职 +
// coder_mm 替补）与实现席候选（coder 系）之外的角色（researcher/tester 等
// 调研/工具角色）不进席位计数与建议。可用 = readyState === "ready" 的席位候选；
// ≥2 → three_seat、恰 1 → two_seat、0 → none。login_based/unknown 不计入可用
// （如实展示；serve 注入型单列 injectedAuth——C-5）。≥2 席位候选但 0 对抗席 →
// 仍 three_seat 但 missingAdversarial=true（展示面必附补配提示，doctor 不静默）。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessPanelReadiness,
  deriveReadyState,
  seatRoleOf,
  PANEL_STAGES,
} from "../../src/application/panelReadiness.js";
import { PANEL_SKIP_REASONS, PANEL_STAGES as WAO_STAGE_PANEL_STAGES } from "../../src/waoStage.js";
// R10-B: SEAT_ROLES 的权威家在 registry.js（core）——panelReadiness.js 下向 import；
// normalizeAgent 是 registry 的单一校验器，seatRole 校验在它那里落地。
import { SEAT_ROLES, normalizeAgent } from "../../src/registry.js";

function row(id, familyHints, readyState) {
  return { id, backend: familyHints.backend ?? null, model: familyHints.model ?? null, readyState };
}

test("R9-C C-1: seatRoleOf 席位分类——对抗席/实现席/非席位（0019/0023 分配语义）", () => {
  assert.equal(seatRoleOf("auditor"), "adversarial", "auditor 是对抗席专职");
  assert.equal(seatRoleOf("coder_mm"), "adversarial", "coder_mm 是对抗席替补（先于 coder_ 前缀）");
  assert.equal(seatRoleOf("coder_hq"), "implementation");
  assert.equal(seatRoleOf("coder_low"), "implementation");
  assert.equal(seatRoleOf("coder_opencode_fallback"), "implementation");
  assert.equal(seatRoleOf("researcher"), "non_seat", "researcher 是调研角色，非席位");
  assert.equal(seatRoleOf("tester"), "non_seat", "tester 是工具角色，非席位");
  assert.equal(seatRoleOf(undefined), "non_seat", "缺失 id 防御归非席位");
});

test("R9-C C-1: 分级三档按席位候选计数——≥2 → three_seat；恰 1 → two_seat；0 → none", () => {
  const three = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_mm", { model: "kimi-code/k3" }, "ready"),
    row("researcher", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.equal(three.tier, "three_seat");
  assert.deepEqual(three.available.map((e) => e.id), ["coder_hq", "coder_mm"],
    "researcher（ready 但非席位）不进 available/席位计数");

  const two = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("auditor", { model: "claude-opus-5" }, "login_based"),
  ]);
  assert.equal(two.tier, "two_seat");

  const none = assessPanelReadiness([
    row("auditor", { model: "claude-opus-5" }, "login_based"),
    row("coder_mm", { model: "kimi-code/k3" }, "missing_cli"),
  ]);
  assert.equal(none.tier, "none");
});

test("R9-C C-1（auditor 实跑病灶）: 非席位角色永不进计数与建议——researcher+coder_hq 不是三席", () => {
  // auditor 实跑失败场景：onboarding 曾建议 researcher + coder_hq（调研角色进
  // 建议 + 双实现席零对抗席）。修复后 researcher 不进任何席位面。
  const a = assessPanelReadiness([
    row("researcher", { model: "deepseek-v4-pro" }, "ready"),
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
  ]);
  assert.equal(a.tier, "two_seat", "仅 coder_hq 一名席位候选 → 两席（不是三席）");
  assert.deepEqual(a.available.map((e) => e.id), ["coder_hq"]);
  assert.equal(a.seats, null, "不足两名席位候选 → 无建议组合");
  // 全非席位（researcher/tester 都 ready）→ none。
  const b = assessPanelReadiness([
    row("researcher", { model: "deepseek-v4-pro" }, "ready"),
    row("tester", { backend: "codex" }, "ready"),
  ]);
  assert.equal(b.tier, "none");
  assert.equal(b.seats, null);
});

test("R9-C C-1: missingAdversarial——≥2 席位候选但 0 对抗席仍 three_seat + 必附提示标记", () => {
  const zeroAdv = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_low", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.equal(zeroAdv.tier, "three_seat", "双实现席物理可配三席");
  assert.equal(zeroAdv.missingAdversarial, true, "零对抗席 → 提示标记在场（展示层必附补配行）");
  const withAdv = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_mm", { model: "kimi-code/k3" }, "ready"),
  ]);
  assert.equal(withAdv.missingAdversarial, false);
  // 不足两席位候选时无对抗席不触发提示（那是 two_seat 的常规文案，不是缺配）。
  const oneSeat = assessPanelReadiness([row("coder_hq", { model: "glm-5.3[1m]" }, "ready")]);
  assert.equal(oneSeat.missingAdversarial, false);
});

test("R9 需求 2: 六态逐态映射——login_based/unknown 不计入可用但如实列出；missing_* 不计可用", () => {
  const a = assessPanelReadiness([
    row("coder_a", { model: "glm-5.3[1m]" }, "ready"),
    row("auditor", { backend: "codex" }, "login_based"),
    row("coder_b", { backend: "mystery" }, "unknown"),
    row("coder_c", { model: "deepseek-v4-pro" }, "missing_cli"),
    row("coder_d", { model: "deepseek-v4-pro" }, "missing_key"),
    row("coder_e", { model: "deepseek-v4-pro" }, "missing_both"),
  ]);
  assert.deepEqual(a.available.map((e) => e.id), ["coder_a"], "六态中仅 ready 计入可用");
  assert.deepEqual(a.loginUnverified, ["auditor"], "login_based 如实展示为登录态未验证");
  assert.deepEqual(a.probeUnknown, ["coder_b"], "unknown 如实展示为探测未知");
});

test("R9-C C-5: serve 注入型席位从 loginUnverified 分离 → injectedAuth 单列", () => {
  const a = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("auditor", { model: "claude-opus-5" }, "login_based"),
    row("coder_opencode_fallback", { backend: "opencode-serve", model: "glm-5.2" }, "login_based"),
  ]);
  assert.deepEqual(a.loginUnverified, ["auditor"], "登录态型照常进登录态未验证");
  assert.deepEqual(a.injectedAuth, ["coder_opencode_fallback"],
    "serve 注入型单列 injectedAuth——不是登录态型认证（展示归类修正，引擎值不动）");
  const a2 = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_mm", { model: "kimi-code/k3" }, "ready"),
    row("coder_opencode_fallback", { backend: "opencode-serve", model: "glm-5.2" }, "missing_cli"),
  ]);
  assert.deepEqual(a2.injectedAuth, [],
    "serve 注入型但 readyState ≠ login_based（如缺 CLI）不进 injectedAuth 清单");
});

test("R9 需求 2: 同族提示（C-6 更名 insufficientFamilyDiversity）——≥2 可用且已知族系单一 → true", () => {
  const same = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_g2", { model: "glm-5.2" }, "ready"),
  ]);
  assert.equal(same.insufficientFamilyDiversity, true, "双 GLM → 族系不足提示在场");
  assert.ok(!("sameFamily" in same), "旧字段名 sameFamily 已改名（零消费者，C-6）");

  const cross = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_low", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.equal(cross.insufficientFamilyDiversity, false, "GLM + DeepSeek → 跨族系，无提示");
});

test("R9 需求 5: 未知族系 ≠ 同族——不参与多样性判定（含'一已知+一未知'与'全未知'）", () => {
  const mixed = assessPanelReadiness([
    row("coder_g", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_u", { backend: "some-future-backend" }, "ready"),
  ]);
  assert.equal(mixed.insufficientFamilyDiversity, true,
    "一已知 + 一未知：无法确认跨族系 → 提示照常（未知不抵充多样性）");
  const bothUnknown = assessPanelReadiness([
    row("coder_u1", { backend: "mystery-a" }, "ready"),
    row("coder_u2", { backend: "mystery-b" }, "ready"),
  ]);
  assert.equal(bothUnknown.insufficientFamilyDiversity, true, "全未知：同样无法确认跨族系");
  // 反向钉：未知不把"确证的同族"误判成跨族——两个同 id 模型仍是同族。
  const knownSame = assessPanelReadiness([
    row("coder_a", { model: "deepseek-v4-flash" }, "ready"),
    row("coder_b", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.equal(knownSame.insufficientFamilyDiversity, true);
});

test("R9 需求 2: 单 worker 注脚——唯一 worker 即被审产出作者，两席建议事实空转", () => {
  const single = assessPanelReadiness([row("coder_hq", { model: "glm-5.3[1m]" }, "ready")]);
  assert.equal(single.singleWorkerVacuous, true);
  assert.equal(single.tier, "two_seat", "单可用副审按两席分级（文案层负责明说空转）");
  const multi = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_low", { model: "deepseek-v4-pro" }, "missing_key"),
  ]);
  assert.equal(multi.singleWorkerVacuous, false, "多 worker 时注脚不出现");
});

test("R9-C C-1: 建议席位组合——对抗席优先 + 实现席，避同族优先；单一类席位退化跨族系对", () => {
  // 对抗席优先：有对抗席时组合必含一名对抗席（两席分配语义），另一席避同族。
  const advFirst = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_low", { model: "deepseek-v4-pro" }, "ready"),
    row("coder_mm", { model: "kimi-code/k3" }, "ready"),
  ]);
  assert.deepEqual(advFirst.seats.map((e) => e.id), ["coder_mm", "coder_hq"],
    "对抗席（coder_mm）排首位 + 跨族系实现席（coder_hq）");
  // 避同族优先：对抗席 claude 族时优先非 claude 族的实现席。
  const avoidSame = assessPanelReadiness([
    row("auditor", { model: "claude-opus-5" }, "ready"),
    row("coder_cl", { backend: "claude-code" }, "ready"),
    row("coder_low", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.deepEqual(avoidSame.seats.map((e) => e.id), ["auditor", "coder_low"],
    "auditor(Claude) 优先配 DeepSeek 实现席，跳过同族的 coder_cl");
  // 全实现席（零对抗席，missingAdversarial 另行提示）：优先跨已知族系对。
  const allImpl = assessPanelReadiness([
    row("coder_g", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_g2", { model: "glm-5.2" }, "ready"),
    row("coder_ds", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.deepEqual(allImpl.seats.map((e) => e.id), ["coder_g", "coder_ds"],
    "贪心跳过同族的第二名，取跨族系成员");
  const sameOnly = assessPanelReadiness([
    row("coder_g", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_g2", { model: "glm-5.2" }, "ready"),
  ]);
  assert.deepEqual(sameOnly.seats.map((e) => e.id), ["coder_g", "coder_g2"], "全同族退化为前两名");
  assert.equal(assessPanelReadiness([row("coder_solo", { model: "glm-5.3[1m]" }, "ready")]).seats, null,
    "不足两名可用席位候选 → 无建议组合");
});

test("R9: deriveReadyState 六态象限（onboarding/doctor 共用的单一映射实现）", () => {
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: "X", cli: true, key: "process_env" }),
    "unknown", "backend 无 CLI 映射 → 无法验证");
  assert.equal(deriveReadyState({ requiresCli: "claude", requiresKeyEnv: null, cli: true }), "login_based");
  assert.equal(deriveReadyState({ requiresCli: "claude", requiresKeyEnv: null, cli: false }), "missing_cli");
  assert.equal(deriveReadyState({ requiresCli: "claude", requiresKeyEnv: null, cli: undefined }), "unknown");
  assert.equal(deriveReadyState({ requiresCli: "claude", requiresKeyEnv: "Z", cli: true, key: "user_env" }),
    "ready", "User 作用域 key 计入可用（新开终端可继承）");
  assert.equal(deriveReadyState({ requiresCli: "claude", requiresKeyEnv: "Z", cli: false, key: "process_env" }),
    "missing_cli");
  assert.equal(deriveReadyState({ requiresCli: "claude", requiresKeyEnv: "Z", cli: true, key: "missing" }),
    "missing_key");
  assert.equal(deriveReadyState({ requiresCli: "claude", requiresKeyEnv: "Z", cli: false, key: "missing" }),
    "missing_both");
  assert.equal(deriveReadyState({ requiresCli: "claude", requiresKeyEnv: "Z", cli: "unknown", key: "process_env" }),
    "unknown", "CLI 探测失败 → unknown（不误标缺失）");
  assert.equal(deriveReadyState({ requiresCli: "claude", requiresKeyEnv: "Z", cli: true, key: "unknown" }),
    "unknown", "key 探测失败 → unknown");
});

test("R9 守卫: PANEL_STAGES 与 waoStage SSOT 一致（C-14：panelReadiness 是 re-export，非值副本）；skip 闭集四码形状", () => {
  // 分级模块的"两节点"引用与 waoStage 的门控闭集是同一语义——双向对账
  // （C-14 后 panelReadiness.PANEL_STAGES 是从 waoStage re-export 的同一绑定）。
  assert.deepEqual(PANEL_STAGES, WAO_STAGE_PANEL_STAGES,
    "panelReadiness.PANEL_STAGES 与 waoStage.PANEL_STAGES 全等（两节点限定单一语义）");
  assert.equal(PANEL_SKIP_REASONS.length, 4, "skip 闭集恰四码（0023 契约）");
  for (const code of PANEL_SKIP_REASONS) {
    assert.match(code, /^[a-z_]+$/, `skip 码形状（snake_case）：${code}`);
  }
});

// ── 18e. R10-B B-1：seatRole 显式席位声明（决策 0023 席位词汇表单一化）───────

test("R10-B B-1: SEAT_ROLES 闭集恰三值；seatRoleOf declared 优先于命名惯例", () => {
  assert.deepEqual(SEAT_ROLES, ["adversarial", "implementation", "non_seat"],
    "闭集恰三值（schema/引擎/展示同一词表——registry.js 是唯一家）");
  // declared 在闭集内 → 优先（覆盖 id 命名惯例，包括会被 /^coder_/ 误分的 worker）。
  assert.equal(seatRoleOf("my_reviewer", "adversarial"), "adversarial",
    "自定义 id + declared 对抗席 → 对抗席");
  assert.equal(seatRoleOf("coder_opencode_fallback", "non_seat"), "non_seat",
    "declared 覆盖 /^coder_/ 前缀惯例（该 worker 实为非席位）");
  assert.equal(seatRoleOf("auditor", "implementation"), "implementation",
    "declared 覆盖 auditor 惯例");
  // absent → 回退命名惯例（老 registry 零迁移；既有行为钉不动，见本文件开头既有钉）。
  assert.equal(seatRoleOf("my_reviewer"), "non_seat", "自定义 id 未声明 → 非席位");
  assert.equal(seatRoleOf("coder_hq"), "implementation", "coder_ 前缀惯例照旧");
  // declared 非字符串/闭集外 → 视为未声明（引擎按契约再守一道；坏值不生效也不抛）。
  assert.equal(seatRoleOf("my_reviewer", "hero"), "non_seat", "闭集外 declared 视为未声明");
  assert.equal(seatRoleOf("my_reviewer", 42), "non_seat", "非字符串 declared 视为未声明");
});

test("R10-B B-1: normalizeAgent 校验 seatRole——3 合法值通过；absent 合法；present 非字符串/闭集外固定安全拒绝", () => {
  const base = { backend: "claude-code", cwd: "." };
  for (const role of SEAT_ROLES) {
    const r = normalizeAgent("w_legal", { ...base, seatRole: role });
    assert.equal(r.seatRole, role, `闭集值 ${role} 合法且原样携带`);
  }
  // absent 合法（own-property 纪律，同 systemPrompt）：回退发生在引擎层（seatRoleOf）。
  const absent = normalizeAgent("w_absent", base);
  assert.ok(!Object.prototype.hasOwnProperty.call(absent, "seatRole"),
    "absent 合法——不得注入默认值（回退发生在引擎层）");
  // present 非字符串 / 闭集外 / own property 但 undefined → 拒绝（fixed-safe，不回显坏值）。
  for (const bad of [42, true, null, undefined, ["adversarial"], { role: "x" }, "hero", "", "ADVERSARIAL"]) {
    assert.throws(() => normalizeAgent("w_bad", { ...base, seatRole: bad }),
      /seatRole must be one of the supported seat roles/,
      `坏值 ${JSON.stringify(bad)} 必须被固定安全拒绝`);
  }
});

test("R10-B B-1: 引擎按 declared 计数席位——my_reviewer+adversarial 进对抗席候选；未声明同 id 不进", () => {
  const declaredAdv = assessPanelReadiness([
    { ...row("my_reviewer", { model: "deepseek-v4-pro" }, "ready"), seatRole: "adversarial" },
    { ...row("coder_hq", { model: "glm-5.3[1m]" }, "ready"), seatRole: "implementation" },
  ]);
  assert.equal(declaredAdv.tier, "three_seat", "declared 对抗席 + 实现席 → 三席");
  assert.deepEqual(declaredAdv.available.map((e) => e.id), ["my_reviewer", "coder_hq"],
    "declared 席位都计入可用");
  assert.equal(declaredAdv.missingAdversarial, false, "declared 对抗席满足对抗视角");
  assert.deepEqual(declaredAdv.seats.map((e) => e.id), ["my_reviewer", "coder_hq"],
    "建议组合含 declared 对抗席（对抗席优先）");
  // 同 id 未声明 → 回退非席位：只剩 coder_hq → 两席，且不进席位建议。
  const undeclared = assessPanelReadiness([
    row("my_reviewer", { model: "deepseek-v4-pro" }, "ready"),
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
  ]);
  assert.equal(undeclared.tier, "two_seat", "未声明的自定义 id 回退非席位（既有行为）");
  assert.deepEqual(undeclared.available.map((e) => e.id), ["coder_hq"]);
  assert.equal(undeclared.seats, null);
});
