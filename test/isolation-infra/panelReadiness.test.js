// panelReadiness.test.js
//
// R9（决策 0023）：三席会审就绪分级的单一实现（src/application/panelReadiness.js）
// 契约测试。Owner 需求 2（三席/两席/无分级 + 六态映射 + 单 worker 注脚 + 同族
// 提示）与需求 5（未知族系不参与同族判定）在这里钉死；onboarding（模板面）与
// doctor（已配置面）只是输入包装，两处的行为断言分别在各自测试文件。
//
// 分级语义：可用副审 = readyState === "ready" 的 worker；≥2 → three_seat、
// 恰 1 → two_seat、0 → none。login_based/unknown 不计入可用（如实展示）。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessPanelReadiness,
  deriveReadyState,
  PANEL_STAGES,
} from "../../src/application/panelReadiness.js";
import { PANEL_SKIP_REASONS, PANEL_STAGES as WAO_STAGE_PANEL_STAGES } from "../../src/waoStage.js";

function row(id, familyHints, readyState) {
  return { id, backend: familyHints.backend ?? null, model: familyHints.model ?? null, readyState };
}

test("R9: 分级三档——≥2 可用 → three_seat；恰 1 → two_seat；0 → none", () => {
  const three = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_low", { model: "deepseek-v4-pro" }, "ready"),
    row("auditor", { model: "claude-opus-5" }, "login_based"),
  ]);
  assert.equal(three.tier, "three_seat");
  assert.deepEqual(three.available.map((e) => e.id), ["coder_hq", "coder_low"]);

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

test("R9 需求 2: 六态逐态映射——login_based/unknown 不计入可用但如实列出；missing_* 不计可用", () => {
  const a = assessPanelReadiness([
    row("w_ready", { model: "glm-5.3[1m]" }, "ready"),
    row("w_login", { backend: "codex" }, "login_based"),
    row("w_unknown", { backend: "mystery" }, "unknown"),
    row("w_mcli", { model: "deepseek-v4-pro" }, "missing_cli"),
    row("w_mkey", { model: "deepseek-v4-pro" }, "missing_key"),
    row("w_mboth", { model: "deepseek-v4-pro" }, "missing_both"),
  ]);
  assert.deepEqual(a.available.map((e) => e.id), ["w_ready"], "六态中仅 ready 计入可用");
  assert.deepEqual(a.loginUnverified, ["w_login"], "login_based 如实展示为登录态未验证");
  assert.deepEqual(a.probeUnknown, ["w_unknown"], "unknown 如实展示为探测未知");
});

test("R9 需求 2: 同族提示——≥2 可用且已知族系单一 → sameFamily；跨族系 → false", () => {
  const same = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("w_glm2", { model: "glm-5.2" }, "ready"),
  ]);
  assert.equal(same.sameFamily, true, "双 GLM → 同族提示在场");

  const cross = assessPanelReadiness([
    row("coder_hq", { model: "glm-5.3[1m]" }, "ready"),
    row("coder_low", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.equal(cross.sameFamily, false, "GLM + DeepSeek → 跨族系，无同族提示");
});

test("R9 需求 5: 未知族系 ≠ 同族——不参与多样性判定（含'一已知+一未知'与'全未知'）", () => {
  const mixed = assessPanelReadiness([
    row("w_glm", { model: "glm-5.3[1m]" }, "ready"),
    row("w_unk", { backend: "some-future-backend" }, "ready"),
  ]);
  assert.equal(mixed.sameFamily, true,
    "一已知 + 一未知：无法确认跨族系 → 同族提示照常（未知不抵充多样性）");
  const bothUnknown = assessPanelReadiness([
    row("w_u1", { backend: "mystery-a" }, "ready"),
    row("w_u2", { backend: "mystery-b" }, "ready"),
  ]);
  assert.equal(bothUnknown.sameFamily, true, "全未知：同样无法确认跨族系");
  // 反向钉：未知不把"确证的同族"误判成跨族——两个同 id 模型仍是同族。
  const knownSame = assessPanelReadiness([
    row("a", { model: "deepseek-v4-flash" }, "ready"),
    row("b", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.equal(knownSame.sameFamily, true);
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

test("R9: 建议席位组合优先跨已知族系；找不到跨族系对时退化为前两名", () => {
  const cross = assessPanelReadiness([
    row("w_glm", { model: "glm-5.3[1m]" }, "ready"),
    row("w_glm2", { model: "glm-5.2" }, "ready"),
    row("w_ds", { model: "deepseek-v4-pro" }, "ready"),
  ]);
  assert.deepEqual(cross.seats.map((e) => e.id), ["w_glm", "w_ds"],
    "贪心跳过同族的第二名，取跨族系成员");
  const sameOnly = assessPanelReadiness([
    row("w_glm", { model: "glm-5.3[1m]" }, "ready"),
    row("w_glm2", { model: "glm-5.2" }, "ready"),
  ]);
  assert.deepEqual(sameOnly.seats.map((e) => e.id), ["w_glm", "w_glm2"], "全同族退化为前两名");
  assert.equal(assessPanelReadiness([row("solo", { model: "glm-5.3[1m]" }, "ready")]).seats, null,
    "不足两名可用 → 无建议组合");
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

test("R9 守卫: PANEL_STAGES 与 waoStage SSOT 一致；skip 闭集四码形状（关系型，禁值指纹）", () => {
  // 分级模块的"两节点"引用与 waoStage 的门控闭集是同一语义——双向对账。
  assert.deepEqual(PANEL_STAGES, WAO_STAGE_PANEL_STAGES,
    "panelReadiness.PANEL_STAGES 与 waoStage.PANEL_STAGES 全等（两节点限定单一语义）");
  assert.equal(PANEL_SKIP_REASONS.length, 4, "skip 闭集恰四码（0023 契约）");
  for (const code of PANEL_SKIP_REASONS) {
    assert.match(code, /^[a-z_]+$/, `skip 码形状（snake_case）：${code}`);
  }
});
