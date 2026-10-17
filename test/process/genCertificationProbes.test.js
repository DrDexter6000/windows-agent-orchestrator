// test/process/genCertificationProbes.test.js
//
// gen-certification 探针内核（底稿＋单项派生法）的单元回归。
// 纯进程内：只 import scripts/gen-certification.mjs 的具名导出（checkProbeBase /
// probeExpressivity），用**假 backend**（只有 validateAgentPolicy 的对象）钉死判定法
// ——不构造真实 backend、不 spawn、不读磁盘。真实 backend × POLICY_PROBE_BASES 的
// 校验由生成器自身在渲染期执行，磁盘副本由 docs-consistency.test.js 的字节钉守卫
// （renderCertification() == docs/surface/certification.md）覆盖，此处不重复。
//
// 被钉的合同（对应本批修掉的两个缺陷）：
//   - 缺陷 1（拒绝归因）：每个探针＝底稿深拷贝＋只改/只加一项——某项被别的必填
//     字段挡住时，结论必须来自底稿补齐后的单项探针（kimi-web/zcode 旧表曾把
//     "缺 serveUrl / 裸 id 无斜杠"的拒绝错记成"不支持"）。
//   - 缺陷 2 面上的渲染：model 栏渲染 必填/可选＋最小可接受写法；底稿必须合法
//     （过 validateAgentPolicy）且最小（去掉任一顶层键或 model 子字段即被拒）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkProbeBase, probeExpressivity } from "../../scripts/gen-certification.mjs";

const K3 = "fake-k3";

// ===== 假 backend 工厂：每只只实现 validateAgentPolicy =====

/** 全接受（底稿校验的最小基线：空底稿对它是合法且最小的）。 */
function acceptAllBackend() {
  return { validateAgentPolicy() {} };
}

/** kimi-web 形：model.id/serveUrl/tokenEnv 必填；providerID/variant/reasoning/contextWindow/provider 一律拒。 */
function kimiWebLikeBackend() {
  return {
    validateAgentPolicy(agent) {
      if (typeof agent?.model?.id !== "string" || agent.model.id.trim().length === 0) throw new Error("requires model.id");
      if (agent?.model?.providerID !== undefined || agent?.model?.variant !== undefined) throw new Error("cannot express providerID/variant");
      if (agent?.reasoning !== undefined) throw new Error("cannot express reasoning");
      if (agent?.model?.contextWindow !== undefined) throw new Error("cannot express contextWindow");
      if (agent?.provider) throw new Error("cannot express provider");
      if (typeof agent?.serveUrl !== "string" || !agent.serveUrl) throw new Error("requires serveUrl");
      if (typeof agent?.tokenEnv !== "string" || !agent.tokenEnv) throw new Error("requires tokenEnv");
    },
  };
}

/** zcode 形：model.id 必须是恰好一个斜杠的 ref；providerID/variant/contextWindow/provider 拒。 */
function refOnlyBackend() {
  return {
    validateAgentPolicy(agent) {
      const id = agent?.model?.id;
      if (typeof id !== "string" || id.split("/").length !== 2 || id.startsWith("/") || id.endsWith("/")) {
        throw new Error("model.id must be <provider>/<model>");
      }
      if (agent?.model?.providerID !== undefined || agent?.model?.variant !== undefined) throw new Error("cannot express providerID/variant");
      if (agent?.model?.contextWindow !== undefined) throw new Error("cannot express contextWindow");
      if (agent?.provider) throw new Error("cannot express provider");
    },
  };
}

/** opencode/deepseek-acp 形：model 必须带 providerID+id，其他 model 子字段拒。 */
function pairOnlyBackend() {
  return {
    validateAgentPolicy(agent) {
      if (agent?.model !== undefined && agent?.model !== null) {
        const m = agent.model;
        if (typeof m.id !== "string" || !m.id || typeof m.providerID !== "string" || !m.providerID) {
          throw new Error("model requires {id, providerID}");
        }
        if (Object.keys(m).some((k) => k !== "id" && k !== "providerID")) throw new Error("no extra model subfields");
      }
      if (agent?.provider) throw new Error("cannot express provider");
      if (agent?.reasoning?.effort !== undefined && !["low", "high", "max"].includes(agent.reasoning.effort)) {
        throw new Error("effort must be low/high/max");
      }
    },
  };
}

/** kimi-code 形：reasoning 仅在 model.id === K3 且 effort ∈ {low, high} 时接受。 */
function k3GatedBackend() {
  return {
    validateAgentPolicy(agent) {
      const effort = agent?.reasoning?.effort;
      if (effort !== undefined && (agent?.model?.id !== K3 || !["low", "high"].includes(effort))) {
        throw new Error("effort requires K3 model and low/high");
      }
    },
  };
}

/** reasoning 需要 serveUrl 在场（钉"接受不被别的必填字段挡住"——缺陷 1 的正向反例）。 */
function reasoningNeedsServeUrlBackend() {
  return {
    validateAgentPolicy(agent) {
      if (typeof agent?.serveUrl !== "string" || !agent.serveUrl) throw new Error("requires serveUrl");
      if (agent?.reasoning !== undefined && agent?.reasoning?.effort !== "low") throw new Error("effort must be low");
    },
  };
}

// ===== checkProbeBase：底稿合法性 / 最小性 =====

test("probe-base: 底稿不合法（过不了 validateAgentPolicy）→ 抛错并点名 backend", () => {
  const backend = kimiWebLikeBackend();
  assert.throws(
    () => checkProbeBase(backend, "fake-kimiweb", {}),
    /POLICY_PROBE_BASES\["fake-kimiweb"\] must pass validateAgentPolicy/,
  );
});

test("probe-base: 底稿不最小（去掉某顶层键仍通过）→ 抛错并写明哪个字段不是必填", () => {
  // backend 只要求 model.id；底稿多带了 serveUrl —— 去掉 serveUrl 仍通过，必须红。
  const backend = {
    validateAgentPolicy(agent) {
      if (typeof agent?.model?.id !== "string" || !agent.model.id) throw new Error("requires model.id");
    },
  };
  assert.throws(
    () => checkProbeBase(backend, "fake-nonminimal", { model: { id: "x" }, serveUrl: "http://127.0.0.1:9" }),
    /底稿字段 serveUrl 不是必填/,
  );
});

test("probe-base: model 子字段不最小（去掉 model 的某个子字段仍通过）→ 抛错并写明 model.<字段>", () => {
  // backend 只要求 model.id；底稿的 model 多带了 region —— 去掉 region 仍通过，必须红。
  const backend = {
    validateAgentPolicy(agent) {
      if (typeof agent?.model?.id !== "string" || !agent.model.id) throw new Error("requires model.id");
    },
  };
  assert.throws(
    () => checkProbeBase(backend, "fake-nonminimal-model", { model: { id: "x", region: "r" } }),
    /底稿字段 model\.region 不是必填/,
  );
});

test("probe-base: 合法且最小的底稿通过（空底稿；多键底稿逐键去掉都被拒）", () => {
  assert.doesNotThrow(() => checkProbeBase(acceptAllBackend(), "fake-accept-all", {}));
  const backend = kimiWebLikeBackend();
  const base = { model: { id: "x" }, serveUrl: "http://127.0.0.1:9", tokenEnv: "T" };
  assert.doesNotThrow(() => checkProbeBase(backend, "fake-kimiweb", base));
});

// ===== probeExpressivity：model 栏（必填/可选 × 最小可接受写法） =====

test("probe-model: 底稿含 model 且去掉即被拒 → 必填＋最小可接受写法", () => {
  const r = probeExpressivity(kimiWebLikeBackend(), {
    k3ModelId: K3,
    base: { model: { id: "x" }, serveUrl: "http://127.0.0.1:9", tokenEnv: "T" },
  });
  assert.equal(r.model.verdict, "必填");
  assert.equal(r.model.condition, "裸 `{id}`");
});

test("probe-model: 底稿不含 model → 可选；形状按 裸→引用→二元组 的次序取首个通过者", () => {
  const bare = probeExpressivity(acceptAllBackend(), { k3ModelId: K3, base: {} });
  assert.equal(bare.model.verdict, "可选");
  assert.equal(bare.model.condition, "裸 `{id}`", "裸 id 先通过即取裸（引用形状也会通过，但不是最小写法）");

  const refOnly = probeExpressivity(refOnlyBackend(), {
    k3ModelId: K3,
    base: { model: { id: "p/m" } },
  });
  assert.equal(refOnly.model.verdict, "必填");
  assert.equal(refOnly.model.condition, "`<provider>/<model>` 引用");

  const pairOnly = probeExpressivity(pairOnlyBackend(), { k3ModelId: K3, base: {} });
  assert.equal(pairOnly.model.verdict, "可选");
  assert.equal(pairOnly.model.condition, "`{providerID, id}`");
});

test("probe-model: 底稿不带 model、三种形状全被拒 → 抛错：探针分不清「表达不了」与「要求了预设形状之外的东西」", () => {
  const noModelAtAll = {
    validateAgentPolicy(agent) {
      if (agent?.model !== undefined) throw new Error("no model at all");
    },
  };
  assert.throws(
    () => probeExpressivity(noModelAtAll, { k3ModelId: K3, base: {}, backendKey: "fake-no-model" }),
    /none of the model probe shapes .* is accepted by "fake-no-model" .* probe coverage is insufficient/,
  );
  // model 可选、但一旦配了就要求 model.region：预设形状都不带 region。
  const optionalModelNeedsRegion = {
    validateAgentPolicy(agent) {
      if (agent?.model !== undefined && typeof agent.model.region !== "string") throw new Error("model requires region");
    },
  };
  assert.throws(
    () => probeExpressivity(optionalModelNeedsRegion, { k3ModelId: K3, base: {}, backendKey: "fake-optional-region" }),
    /none of the model probe shapes .* is accepted by "fake-optional-region"/,
  );
});

test("probe-model: 底稿的 model 合法、三种预设形状却全被拒（必填 model 子字段）→ 抛错：探针覆盖不足，不渲染不支持", () => {
  // backend 要求 model.id 与 model.region 同时在场：预设形状都不带 region，全被拒。
  const backend = {
    validateAgentPolicy(agent) {
      if (typeof agent?.model?.id !== "string" || typeof agent?.model?.region !== "string") {
        throw new Error("requires model.id and model.region");
      }
    },
  };
  assert.throws(
    () => probeExpressivity(backend, {
      k3ModelId: K3,
      base: { model: { id: "x", region: "r" } },
      backendKey: "fake-region",
    }),
    /none of the model probe shapes .* is accepted by "fake-region" on top of its POLICY_PROBE_BASES entry .* probe coverage is insufficient/,
  );
});

// ===== probeExpressivity：contextWindow 栏（在已证合法的 model 上只加一项） =====

test("probe-contextWindow: 底稿带 model 时只在底稿的 model 上加 contextWindow（保留底稿 model 原值）", () => {
  // backend 接受任何 model.id，但 contextWindow 只在 model.id 为底稿那个值时接受：
  // 若探针改用预设形状的 model，就会把可表达的 contextWindow 误判为"不支持"。
  const backend = {
    validateAgentPolicy(agent) {
      if (typeof agent?.model?.id !== "string" || !agent.model.id) throw new Error("requires model.id");
      if (agent.model.contextWindow !== undefined && agent.model.id !== "special/model") {
        throw new Error("contextWindow only for special/model");
      }
    },
  };
  const r = probeExpressivity(backend, { k3ModelId: K3, base: { model: { id: "special/model" } } });
  assert.equal(r.model.verdict, "必填");
  assert.equal(r.contextWindow.verdict, "支持");
});

// ===== probeExpressivity：reasoning 栏（K3 伴随条件） =====

test("probe-reasoning: 底稿＋effort 被拒、model 换成 K3 后通过 → 条件＋须绑定 K3", () => {
  const r = probeExpressivity(k3GatedBackend(), { k3ModelId: K3, base: {} });
  assert.equal(r.reasoning.verdict, "条件");
  assert.equal(r.reasoning.condition, `effort ∈ {low, high}，须绑定 ${K3}`);
});

test("probe-reasoning: 六档都只在 K3 下通过 → 条件：须绑定 K3（档位全过也不丢绑定条件）", () => {
  const backend = {
    validateAgentPolicy(agent) {
      if (agent?.reasoning?.effort !== undefined && agent?.model?.id !== K3) {
        throw new Error("effort requires K3 model");
      }
    },
  };
  const r = probeExpressivity(backend, { k3ModelId: K3, base: {} });
  assert.equal(r.reasoning.verdict, "条件");
  assert.equal(r.reasoning.condition, `须绑定 ${K3}`);
});

test("probe-reasoning: effort 只要求带任意 model（不限 K3）→ 抛错，不误写成「须绑定 K3」", () => {
  const backend = {
    validateAgentPolicy(agent) {
      if (agent?.reasoning?.effort !== undefined && typeof agent?.model?.id !== "string") {
        throw new Error("effort requires some model.id");
      }
    },
  };
  assert.throws(
    () => probeExpressivity(backend, { k3ModelId: K3, base: {}, backendKey: "fake-any-model" }),
    /"fake-any-model" accepts reasoning efforts under model conditions the table cannot render .*=anyModel/,
  );
});

test("probe-reasoning: effort 只在带 providerID 的 model 下通过（裸 id 也是合法 model）→ 抛错，不渲染不支持", () => {
  // 最小可接受写法是裸 id，但 effort 要的是二元组形状：anyModel 必须把每个被接受
  // 的预设形状都试一遍，否则会把可表达的 reasoning 悄悄判成"不支持"。
  const backend = {
    validateAgentPolicy(agent) {
      if (agent?.reasoning?.effort !== undefined && typeof agent?.model?.providerID !== "string") {
        throw new Error("effort requires model.providerID");
      }
    },
  };
  assert.throws(
    () => probeExpressivity(backend, { k3ModelId: K3, base: {}, backendKey: "fake-pair-effort" }),
    /"fake-pair-effort" accepts reasoning efforts under model conditions the table cannot render .*=anyModel/,
  );
});

test("probe-reasoning: effort 要求 K3 且带 providerID（裸 id 是最小写法）→ 条件：须绑定 K3（k3 探针同样试遍合法 model）", () => {
  const backend = {
    validateAgentPolicy(agent) {
      if (agent?.reasoning?.effort !== undefined
        && (agent?.model?.id !== K3 || typeof agent?.model?.providerID !== "string")) {
        throw new Error("effort requires K3 with providerID");
      }
    },
  };
  const r = probeExpressivity(backend, { k3ModelId: K3, base: {} });
  assert.equal(r.reasoning.verdict, "条件");
  assert.equal(r.reasoning.condition, `须绑定 ${K3}`);
});

test("probe-reasoning: 部分档位不带 K3 也过、部分必须 K3 → 抛错，不把绑定扩到全部档位", () => {
  const backend = {
    validateAgentPolicy(agent) {
      const effort = agent?.reasoning?.effort;
      if (effort === undefined || effort === "high") return;
      if (effort !== "max" || agent?.model?.id !== K3) throw new Error("max requires K3; others refused");
    },
  };
  assert.throws(
    () => probeExpressivity(backend, { k3ModelId: K3, base: {}, backendKey: "fake-mixed" }),
    /"fake-mixed" accepts reasoning efforts under model conditions the table cannot render .*high=plain, max=k3/,
  );
});

test("probe-reasoning: 底稿＋effort 全过 → 支持，不渲染 K3 伴随（即使 K3 伴随也能过）", () => {
  const backend = {
    validateAgentPolicy() {},
  };
  const r = probeExpressivity(backend, { k3ModelId: K3, base: {} });
  assert.equal(r.reasoning.verdict, "支持");
  assert.equal(r.reasoning.condition, null);
});

test("probe-reasoning: 部分档位过且不需模型伴随 → 条件不带“须绑定”", () => {
  const r = probeExpressivity(pairOnlyBackend(), { k3ModelId: K3, base: {} });
  assert.equal(r.reasoning.verdict, "条件");
  assert.equal(r.reasoning.condition, "effort ∈ {low, high, max}");
});

// ===== 缺陷 1 回归：拒绝/接受必须归因到被测项本身 =====

test("probe-attribution: 被测项本身被接受时不因别的必填字段缺席而误判（kimi-web 形回归）", () => {
  // 旧探针法给 kimi-web 形 backend 的 reasoning/contextWindow/provider 全渲染
  // “不支持”，理由是缺 model.id——结论碰巧对、归因错。底稿法下这些格的判定
  // 来自底稿（连接字段已在）＋单项：reasoningNeedsServeUrl 接受 reasoning
  // （只要求底稿带 serveUrl），必须渲染为通过而不是“不支持”。
  const r = probeExpressivity(reasoningNeedsServeUrlBackend(), {
    k3ModelId: K3,
    base: { serveUrl: "http://127.0.0.1:9" },
  });
  // 该 backend 只接受 low：六值闭集部分通过 → 条件，而不是“不支持”。
  assert.equal(r.reasoning.verdict, "条件");
  assert.equal(r.reasoning.condition, "effort ∈ {low}");
});

test("probe-attribution: “不支持”只在被测项本身被拒时出现（底稿在场的单项拒绝）", () => {
  const base = { model: { id: "x" }, serveUrl: "http://127.0.0.1:9", tokenEnv: "T" };
  const r = probeExpressivity(kimiWebLikeBackend(), { k3ModelId: K3, base });
  assert.equal(r.reasoning.verdict, "不支持");
  assert.equal(r.contextWindow.verdict, "不支持");
  assert.equal(r.provider.verdict, "不支持");
  assert.notEqual(r.model.verdict, "不支持", "model 本身可表达（必填：裸）——同格其余“不支持”不可能再来自缺 model.id");
});

// ===== 探针不改底稿本身（深拷贝纪律） =====

test("probe-discipline: 探针是底稿的深拷贝——跑完探针后底稿逐字节不变", () => {
  const base = Object.freeze({
    model: Object.freeze({ id: "x" }),
    serveUrl: "http://127.0.0.1:9",
    tokenEnv: "T",
  });
  const snapshot = JSON.stringify(base);
  probeExpressivity(kimiWebLikeBackend(), { k3ModelId: K3, base });
  assert.equal(JSON.stringify(base), snapshot, "探针不得改动底稿（含嵌套对象）");
});
