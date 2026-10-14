// panelReadiness.test.js
//
// R9（决策 0023）：三席会审就绪分级的单一实现（src/application/panelReadiness.js）
// 契约测试。Owner 需求 2（三席/两席/无分级 + 六态映射 + 单 worker 注脚 + 同族
// 提示）与需求 5（未知族系不参与同族判定）在这里钉死；onboarding（模板面）与
// doctor（已配置面）只是输入包装，两处的行为断言分别在各自测试文件。
//
// 0065（0045 §1.2 终局）：席位角色维退役——分级改**车道多样性**口径：
//   - 候选=全部行（0045"角色是帽子"——researcher/tester 等老角色名键照常计数，
//     文档写清楚；不再有 non_seat 过滤）。
//   - tier=ready 候选计数（探测口径，不声称已配齐可派发副审）。
//   - missingAdversarial 废止；insufficientFamilyDiversity 升为主提示。
//   - 建议配对=全候选中找已知跨族对（sol P1：旧算法"首席未知吞掉后续跨族对"
//     反例废除——下方专测钉住）。
//   - 同 backend+modelId 多键如实点名（duplicateModelKeys——tier 按行计数的
//     虚高提示，opus P2 轻量版）。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessPanelReadiness,
  deriveReadyState,
  PANEL_STAGES,
} from "../../src/application/panelReadiness.js";
import { PANEL_SKIP_REASONS, PANEL_STAGES as WAO_STAGE_PANEL_STAGES } from "../../src/waoStage.js";
// 0065：seatRole 已退役——normalizeAgent strip 行为在此钉（校验/闭集已删）。
import { normalizeAgent } from "../../src/registry.js";

function row(id, familyHints, readyState) {
  return { id, backend: familyHints.backend ?? null, model: familyHints.model ?? null, readyState };
}

// ── TD-258（2026-10-11 双席会审综合）：key_only_* 两态合同 ─────────────────────
// 无 CLI 探测面（kimi-web=serve 通道）但声明凭据名的车道：key 名可解析且非空=
// key_only_present（**不是就绪**——未验证令牌有效性/serve 可达性）；缺失=
// key_only_missing；探测异常=unknown。无凭据声明的无 CLI 车道（zcode 承重桥）
// 恒 unknown。两态不计可用、不抬 tier、不无声消失（keyOnly 桶）。
test("TD-258: deriveReadyState 无 CLI 面——key_only 两态 + zcode 形状恒 unknown", () => {
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: "KIMI_WEB_TOKEN", key: "process_env" }),
    "key_only_present", "key 名解析（process）= key_only_present");
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: "KIMI_WEB_TOKEN", key: "user_env" }),
    "key_only_present", "key 名解析（user）= key_only_present");
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: "KIMI_WEB_TOKEN", key: "missing" }),
    "key_only_missing");
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: "KIMI_WEB_TOKEN", key: "unknown" }),
    "unknown", "探测异常保持 unknown");
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: "KIMI_WEB_TOKEN", key: undefined }),
    "unknown", "key 未探=unknown");
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: null, key: "process_env" }),
    "unknown", "zcode 形状：无 CLI 无凭据声明——承重桥不是凭据，恒 unknown");
  // CLI 面车道六态不受本批影响（回归钉）。
  assert.equal(deriveReadyState({ requiresCli: "dsh", requiresKeyEnv: "DEEPSEEK_API_KEY", cli: true, key: "missing" }),
    "missing_key");
  assert.equal(deriveReadyState({ requiresCli: "dsh", requiresKeyEnv: "DEEPSEEK_API_KEY", cli: true, key: "user_env" }),
    "ready");
});

test("TD-258: key_only_* 不计可用/不抬 tier，且进 keyOnly 桶不无声消失", () => {
  const p = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    { id: "coder_mm", backend: null, model: "kimi-code/k3", readyState: "key_only_present" },
    { id: "kimi", backend: null, model: "kimi-code/k3-256k", readyState: "key_only_missing" },
    row("glm-pro", { model: "bigmodel-api/GLM-5.3" }, "unknown"),
  ]);
  assert.equal(p.tier, "two_seat", "key_only_present 不当 ready 计——仅 1 名真 ready=two_seat");
  assert.deepEqual(p.available.map((e) => e.id), ["coder_hq"]);
  assert.ok(p.keyOnly.includes("coder_mm") && p.keyOnly.includes("kimi"),
    "key_only 两态都进 keyOnly 桶（叙事里可见）");
  assert.ok(!p.keyOnly.includes("glm-pro"), "unknown 不进 keyOnly 桶（有 probeUnknown 位）");
});

// 决定 0074（车道就绪事实如实呈现）：key 轴 "token_file"（kimiHome 车道的
// server.token 在且非空）与 process_env/user_env 同为"已解析"——复用 key_only_*
// 两态，输出闭集不新增；requiresKeyEnv 传文件路径（映射只看非空性）。
test("决定 0074: deriveReadyState key 轴 token_file——kimiHome 车道复用 key_only_* 闭集", () => {
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: "C:/kimi-home/server.token", key: "token_file" }),
    "key_only_present", "文件在且非空 = key_only_present（key_only 纪律：不声称令牌有效）");
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: "C:/kimi-home/server.token", key: "missing" }),
    "key_only_missing", "文件缺失/为空 = key_only_missing");
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: "C:/kimi-home/server.token", key: undefined }),
    "unknown", "探测失败/缺席 = unknown（如实未知，不猜）");
});

test("R9/0065: 分级三档按 ready 候选计数——≥2 → three_seat；恰 1 → two_seat；0 → none", () => {
  const three = assessPanelReadiness([
    row("glm-pro", { model: "bigmodel-api/GLM-5.3" }, "ready"),
    row("sol", { model: "gpt-6.1-sol" }, "ready"),
    row("researcher", { model: "deepseek-v4-pro" }, "login_based"),
  ]);
  assert.equal(three.tier, "three_seat");
  assert.deepEqual(three.available.map((e) => e.id), ["glm-pro", "sol"],
    "可用=ready 候选（角色维退役——不再按 non_seat 过滤）");

  const two = assessPanelReadiness([
    row("glm-pro", { model: "bigmodel-api/GLM-5.3" }, "ready"),
    row("opus", { model: "claude-opus-5" }, "login_based"),
  ]);
  assert.equal(two.tier, "two_seat");

  const none = assessPanelReadiness([
    row("opus", { model: "claude-opus-5" }, "login_based"),
    row("kimi", { model: "kimi-code/k3" }, "missing_cli"),
  ]);
  assert.equal(none.tier, "none");
});

test("0065: 角色维退役——researcher/tester 等老角色名键照常计数（0045 角色是帽子）", () => {
  // 0065 前语义：researcher=non_seat 不进计数；终局：任何车道键都可能任副审，
  // 帽子=派发时 role。同一输入现在计三席（语义变更钉——防悄悄退回角色过滤）。
  const a = assessPanelReadiness([
    row("researcher", { model: "deepseek-v4-pro" }, "ready"),
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
  ]);
  assert.equal(a.tier, "three_seat", "两名 ready 候选 → 三席（不再有非席位过滤）");
  assert.deepEqual(a.available.map((e) => e.id), ["researcher", "coder_hq"]);
  assert.ok(a.seats !== null, "有建议配对");
  // missingAdversarial 已废止（不再存在于结果形状）。
  assert.ok(!("missingAdversarial" in a), "missingAdversarial 随 seatRole 退役删除");
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

test("R9 需求 2 / 0065 主提示: 同族提示 insufficientFamilyDiversity——≥2 可用且已知族系单一 → true", () => {
  const same = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_g2", { model: "glm-5.2" }, "ready"),
  ]);
  assert.equal(same.insufficientFamilyDiversity, true, "双 GLM → 族系不足提示在场（0065 起主提示）");
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

test("0065 建议配对: 全候选中找已知跨族对——首席未知不得吞掉后续跨族对（sol P1 反例）", () => {
  // 反例形：首席族系未知，第二三名跨族——旧算法从首席出发会推"未知+X"，
  // 新算法全候选扫描必须推跨族对。
  const unknownFirst = assessPanelReadiness([
    row("mystery_seat", { backend: "some-future-backend" }, "ready"),
    row("ds_seat", { model: "deepseek-v4-pro" }, "ready"),
    row("glm_seat", { model: "bigmodel-api/GLM-5.3" }, "ready"),
  ]);
  assert.deepEqual(unknownFirst.seats.map((e) => e.id), ["ds_seat", "glm_seat"],
    "全候选扫描：DeepSeek×GLM 跨族对胜出（不被首席未知吞掉）");
  // 全同族退化为前两名（insufficientFamilyDiversity 提示兜底）。
  const sameOnly = assessPanelReadiness([
    row("coder_g", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_g2", { model: "glm-5.2" }, "ready"),
  ]);
  assert.deepEqual(sameOnly.seats.map((e) => e.id), ["coder_g", "coder_g2"], "全同族退化为前两名");
  assert.equal(assessPanelReadiness([row("coder_solo", { model: "glm-5.3[1m]" }, "ready")]).seats, null,
    "不足两名可用候选 → 无建议配对");
  // 跨族对存在时确定性：候选序扫描，首个跨族对胜。
  const deterministic = assessPanelReadiness([
    row("glm_a", { model: "bigmodel-api/GLM-5.3" }, "ready"),
    row("ds_a", { model: "deepseek-v4-pro" }, "ready"),
    row("ds_b", { model: "deepseek-v4-flash" }, "ready"),
  ]);
  assert.deepEqual(deterministic.seats.map((e) => e.id), ["glm_a", "ds_a"], "首个跨族对（glm_a×ds_a）胜出");
});

test("0065: duplicateModelKeys——同 backend+modelId 多键如实点名（tier 虚高提示）", () => {
  const p = assessPanelReadiness([
    row("lane_a", { model: "bigmodel-api/GLM-5.3" }, "ready"),
    row("lane_a_high_effort", { model: "bigmodel-api/GLM-5.3" }, "ready"),
    row("lane_b", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.equal(p.tier, "three_seat", "按行计数仍三席（如实）");
  assert.equal(p.duplicateModelKeys.length, 1, "同模型双键被点名");
  assert.deepEqual(p.duplicateModelKeys[0].ids, ["lane_a", "lane_a_high_effort"]);
  assert.equal(p.duplicateModelKeys[0].modelId, "bigmodel-api/GLM-5.3");
  const clean = assessPanelReadiness([
    row("lane_a", { model: "bigmodel-api/GLM-5.3" }, "ready"),
    row("lane_b", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.deepEqual(clean.duplicateModelKeys, [], "无多键配置不误报");
});

test("R9: deriveReadyState 六态象限（onboarding/doctor 共用的单一映射实现）", () => {
  // TD-258 修订：无 CLI 映射 + 有凭据声明 → key_only_*（详见上方 TD-258 专测）；
  // 此行保留无凭据声明的无 CLI 形状（zcode）——恒 unknown。
  assert.equal(deriveReadyState({ requiresCli: null, requiresKeyEnv: null, cli: true, key: "process_env" }),
    "unknown", "backend 无 CLI 映射且无凭据声明 → 无法验证");
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

// ── 0065（0045 §1.2 终局）：seatRole 退役的 registry 侧钉 ────────────────────

test("0065: normalizeAgent strip seatRole——归一化结果不携带（零消费面保证）；坏值不再拒载", () => {
  const base = { backend: "claude-code", cwd: "." };
  // 在场（任意值，含旧闭集值与非闭集值）→ 归一化剥离，不再校验拒载。
  for (const legacy of ["adversarial", "implementation", "non_seat", "hero", 42, null]) {
    const r = normalizeAgent("w_legacy", { ...base, seatRole: legacy });
    assert.ok(!Object.prototype.hasOwnProperty.call(r, "seatRole"),
      `seatRole=${JSON.stringify(legacy)} 被剥离（弃用字段——validate 层出 advisory，此处零消费）`);
  }
  // absent 合法照旧。
  const absent = normalizeAgent("w_absent", base);
  assert.ok(!Object.prototype.hasOwnProperty.call(absent, "seatRole"), "absent 合法");
  // 输入对象不被原地修改（raw 供 validate 出 advisory——sol 条款）。
  const raw = { ...base, seatRole: "adversarial" };
  normalizeAgent("w_no_mutate", raw);
  assert.equal(raw.seatRole, "adversarial", "归一化不原地删输入字段");
});
