// test/migration-0045/identityProjection.test.js
//
// 0045 §1.5 读取侧单元测试：自描述派生 / 冻结 legacy 闭集 / 投影三态 / 指纹。
// 真实案卷全量验证走 scripts/migration/validate-identity-projection.mjs（本文件
// 只钉纯函数契约）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LEGACY_AGENT_NAMES,
  IDENTITY_PROJECTION_STATES,
  deriveStartedIdentity,
  laneFingerprint,
  projectAgentIdentity,
} from "../../src/application/identityProjection.js";

const SRC_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "application", "identityProjection.js");

// ── 冻结闭集钉 ──────────────────────────────────────────────────────────────

test("0045 §1.5：legacy 名单冻结钉（12 历史扫描名 + 0046 §5 步② 重键扩编 6 车道旧键 = 18 名；扩集=蓄意事件须改本钉）", () => {
  assert.deepEqual([...LEGACY_AGENT_NAMES].sort(), [
    "auditor", "auditor_claude", "claude-opus", "coder", "coder_hq", "coder_low",
    "coder_low_dsh", "coder_mm", "coder_temp", "ds-acp", "glm_worker",
    "gpt-astra", "gpt-sol-56", "gpt-sol-61", "kimi-k3", "parallel-verify",
    "researcher", "tester",
  ], "legacy 名单与 12 历史扫描名 + 6 个 0046 重键退役车道旧键不符——扩集是蓄意事件，"
    + "须同步更新本钉与名单头注（0045 §1.5 / 0046 §5 步②）");
  assert.ok(Object.isFrozen(LEGACY_AGENT_NAMES), "名单 Object.frozen");
});

test("0045 §1.5：投影三态闭集钉（normal/legacy/unknown，合同原文用词）", () => {
  assert.deepEqual([...IDENTITY_PROJECTION_STATES], ["normal", "legacy", "unknown"]);
});

// ── 自描述派生 ──────────────────────────────────────────────────────────────

test("派生：全字段 run.started（真实形状，runs/reliability/run_20261002001608853n0uuc1 实测）", () => {
  const identity = deriveStartedIdentity({
    backend: "zcode", model: { id: "bigmodel-api/GLM-5.3-Flash" },
    reasoning: { effort: "high" }, providerKey: "pk-abc",
  });
  assert.deepEqual(identity, {
    backend: "zcode", modelId: "bigmodel-api/GLM-5.3-Flash",
    providerID: null, providerKey: "pk-abc", reasoningEffort: "high",
  });
});

test("派生：providerKey=null（580 在场/159 字符串的真实分布）→ 如实 null，不补写", () => {
  const identity = deriveStartedIdentity({ backend: "zcode", model: { id: "m" }, providerKey: null });
  assert.equal(identity.providerKey, null);
});

test("派生：缺 model 但有 backend → 可派生（与 matchedCertRecord 比较轴一致）；modelId=null 如实", () => {
  const identity = deriveStartedIdentity({ backend: "codex" });
  assert.equal(identity.backend, "codex");
  assert.equal(identity.modelId, null);
});

test("派生：backend 与 model 全缺 / started 缺失 / 非对象 → null（不伪造）", () => {
  assert.equal(deriveStartedIdentity({}), null);
  assert.equal(deriveStartedIdentity(null), null);
  assert.equal(deriveStartedIdentity(undefined), null);
  assert.equal(deriveStartedIdentity("run.started"), null);
});

// ── 指纹 ────────────────────────────────────────────────────────────────────

test("指纹：同四元组稳定；四轴各变即变；effort 不进指纹（§1.1 车道参数非身份）", () => {
  const base = { backend: "zcode", modelId: "m", providerID: null, providerKey: "pk" };
  const f1 = laneFingerprint(base);
  assert.equal(f1, laneFingerprint({ ...base }), "同输入同指纹");
  assert.match(f1, /^lane:[0-9a-f]{16}$/);
  assert.notEqual(f1, laneFingerprint({ ...base, backend: "codex" }), "backend 变→指纹变");
  assert.notEqual(f1, laneFingerprint({ ...base, modelId: "m2" }), "model 变→指纹变");
  assert.notEqual(f1, laneFingerprint({ ...base, providerID: "p" }), "providerID 变→指纹变");
  assert.notEqual(f1, laneFingerprint({ ...base, providerKey: "pk2" }), "providerKey 变→指纹变");
  // effort 是派生字段但非指纹轴：手工构造同四元组不同 effort 的 identity 两次
  const a = { backend: "zcode", modelId: "m", providerID: null, providerKey: "pk" };
  assert.equal(laneFingerprint(a), f1);
});

test("指纹：null/undefined 归一（指纹关心取值不关心在场性）", () => {
  assert.equal(
    laneFingerprint({ backend: "z", modelId: null, providerID: null, providerKey: null }),
    laneFingerprint({ backend: "z", modelId: undefined, providerID: undefined, providerKey: undefined }),
  );
});

// ── 投影三态 ────────────────────────────────────────────────────────────────

test("投影：normal（在册显原名）× legacy（离册在名单显史实名）× unknown（折叠）", () => {
  const known = ["coder_hq", "tester"];
  assert.equal(projectAgentIdentity({ agentId: "coder_hq", knownAgentIds: known }).state, "normal");
  const legacy = projectAgentIdentity({ agentId: "parallel-verify", knownAgentIds: known });
  assert.equal(legacy.state, "legacy");
  assert.equal(legacy.displayName, "parallel-verify");
  const unknown = projectAgentIdentity({ agentId: "ghost_seat", knownAgentIds: known });
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.displayName, null);
});

test("投影：名字在册≠当时车道=今天车道——identity/指纹对 normal 也派生且随事实变（coder_hq 陷阱钉）", () => {
  const known = ["coder_hq"];
  const claudeEra = projectAgentIdentity({
    agentId: "coder_hq", knownAgentIds: known,
    started: { backend: "claude-code", model: { id: "glm-5.3[1m]" }, providerKey: "pk-c" },
  });
  const zcodeEra = projectAgentIdentity({
    agentId: "coder_hq", knownAgentIds: known,
    started: { backend: "zcode", model: { id: "bigmodel-api/GLM-5.3" }, providerKey: "pk-z" },
  });
  assert.equal(claudeEra.state, "normal");
  assert.equal(claudeEra.identity.backend, "claude-code");
  assert.notEqual(claudeEra.fingerprint, zcodeEra.fingerprint,
    "同名两时代的指纹必须不同——这正是静态名→车道映射表会归错 81% 历史的机理（R2 会审）");
});

test("投影：缺 started 的 legacy 名（5 份真实无 started 档案）→ state=legacy、identity=null 如实", () => {
  const r = projectAgentIdentity({ agentId: "researcher", started: undefined, knownAgentIds: [] });
  assert.equal(r.state, "legacy");
  assert.equal(r.identity, null);
  assert.equal(r.fingerprint, null);
});

test("投影：非字符串/缺失 agentId → unknown（不炸、不猜）", () => {
  assert.equal(projectAgentIdentity({ agentId: null, knownAgentIds: [] }).state, "unknown");
  assert.equal(projectAgentIdentity({ knownAgentIds: [] }).state, "unknown");
  assert.equal(projectAgentIdentity({ agentId: 42, knownAgentIds: [] }).state, "unknown");
});

// ── 依赖方向守卫（0045 §1.5 "不从当前注册表倒推"的代码级钉）────────────────

test("守卫：identityProjection 源码零注册表回填（不 import registry、不读盘——纯函数合同）", () => {
  const src = readFileSync(SRC_PATH, "utf8");
  assert.ok(!/from\s+"(\.\.\/)+registry(\.js)?"/.test(src), "不得 import src/registry.js（历史身份不从注册表倒推）");
  assert.ok(!/readRegistry|readFileSync|writeFileSync/.test(src), "零 I/O（验证走 scripts/migration/*）");
});
