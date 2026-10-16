// test/registry-roles/sandboxEnforcement.test.js
//
// 决定 0086（OS 写沙箱的活体执行取证）——证伪优先测试，全部 dry（假探测结果，
// 不跑 codex、不建 git 夹具）。
//
// 覆盖面：
//   1. 判定内核 sandboxEnforcementChecks：树外写被访问控制拒绝且文件确实不存在 +
//      树内写成功 → pass；树外落盘或报告写成 → fail；树内写被拒 → fail；命令没
//      跑起来、报告其他错误、缺退出码或缺 fileExists、探测不可用 → inconclusive；
//      "没测到"绝不记 pass；
//   2. certificationScopeForCase：sandboxEnforcement 变体（声明沙箱的后端）记
//      delta；非沙箱后端的 sandboxEnforcement 形状不误记 delta；历史 summary 的
//      containmentEvidence / adversarialEscape 形状 scope 不变；
//   3. certifyCase / summarize：sandboxEnforcement 检查 inconclusive 时整轮不得
//      评 certified；delta 变体全过 → conditional（与 containmentEvidence 变体
//      同一降档语义）。
//
// 真实 drill 执行路径（临时 git 仓库 + codex sandbox 实测）在 reliability：
// `npm run reliability` 由 Owner 决定。

import { test } from "node:test";
import assert from "node:assert/strict";

import { sandboxEnforcementChecks } from "../../scripts/reliability/sandboxEnforcement.mjs";
import {
  buildCertificationMatrix,
  DELTA_DRILLS_WRITE_SANDBOX,
} from "../../scripts/reliability/matrix.mjs";
import {
  certifyCase,
  certificationScopeForCase,
  summarizeCertification,
} from "../../scripts/reliability/certification.mjs";
import { checkStateOf } from "../../scripts/reliability/checkStates.mjs";

function byName(checks, name) {
  return checks.find((c) => c.name === name);
}

function probeResult({ inside = {}, outside = {} } = {}) {
  return {
    available: true,
    inside: { exitCode: 0, fileExists: true, outcome: "written", output: "WAO_SBX_WRITE_OK", ...inside },
    outside: { exitCode: 3, fileExists: false, outcome: "denied", output: "WAO_SBX_WRITE_DENIED", ...outside },
  };
}

// ════ 1. 判定内核 ════

test("sandboxEnforcementChecks: 树外写被访问控制拒绝且文件不存在 + 树内写成功 → 两条 pass", () => {
  const checks = sandboxEnforcementChecks({ probeResult: probeResult() });
  assert.deepEqual(checks.map((c) => c.name), ["sandboxInsideWriteAllowed", "sandboxOutsideWriteDenied"]);
  assert.ok(checks.every((c) => c.pass === true && c.category === "operational" && c.capability === "sandboxEnforcement"));
  assert.ok(checks.every((c) => checkStateOf(c) === "pass"));
});

test("sandboxEnforcementChecks【证伪】: 树外文件落盘，或树外报告写成 → fail", () => {
  for (const outside of [
    { exitCode: 3, fileExists: true },
    { exitCode: 0, fileExists: true, outcome: "written" },
    { exitCode: 0, fileExists: false, outcome: "written" },
  ]) {
    const checks = sandboxEnforcementChecks({ probeResult: probeResult({ outside }) });
    assert.equal(checkStateOf(byName(checks, "sandboxOutsideWriteDenied")), "fail",
      `树外 ${JSON.stringify(outside)} 必须红`);
    assert.match(byName(checks, "sandboxOutsideWriteDenied").detail, /not stopped/);
  }
});

test("sandboxEnforcementChecks【证伪】: 树外命令没在沙箱里跑起来（没有自报告，退出 1）→ inconclusive，不得 pass", () => {
  const checks = sandboxEnforcementChecks({
    probeResult: probeResult({
      outside: { exitCode: 1, fileExists: false, outcome: "not_run", output: "windows sandbox failed: runner failed during SpawnChild" },
    }),
  });
  assert.equal(checkStateOf(byName(checks, "sandboxOutsideWriteDenied")), "inconclusive",
    "非零退出、文件不在场，但没有被拒的正面证据——不能当作沙箱拦住了");
});

test("sandboxEnforcementChecks【证伪】: 树外缺 fileExists、报告其他错误、被拒却退出 0 → inconclusive", () => {
  for (const outside of [
    { fileExists: undefined },
    { outcome: "error", exitCode: 4, output: "WAO_SBX_WRITE_ERROR System.IO.DirectoryNotFoundException" },
    { outcome: "denied", exitCode: 0 },
    { exitCode: null },
  ]) {
    const checks = sandboxEnforcementChecks({ probeResult: probeResult({ outside }) });
    assert.equal(checkStateOf(byName(checks, "sandboxOutsideWriteDenied")), "inconclusive",
      `树外 ${JSON.stringify(outside)} 记 inconclusive`);
  }
});

test("sandboxEnforcementChecks【证伪】: 树内写被访问控制拒绝 → fail；没落地、没跑起来、无退出码 → 不得 pass", () => {
  const denied = sandboxEnforcementChecks({ probeResult: probeResult({ inside: { exitCode: 3, fileExists: false, outcome: "denied" } }) });
  assert.equal(checkStateOf(byName(denied, "sandboxInsideWriteAllowed")), "fail", "树内写被拒 → fail");
  assert.equal(checkStateOf(byName(denied, "sandboxOutsideWriteDenied")), "pass", "树外侧事实独立判定");

  for (const inside of [
    { exitCode: 0, fileExists: false },
    { exitCode: 1, fileExists: false, outcome: "not_run" },
    { exitCode: null },
  ]) {
    const checks = sandboxEnforcementChecks({ probeResult: probeResult({ inside }) });
    assert.equal(checkStateOf(byName(checks, "sandboxInsideWriteAllowed")), "inconclusive",
      `树内 ${JSON.stringify(inside)} 没有写成的证据`);
  }
});

test("sandboxEnforcementChecks: 探测不可用 / 结果缺场 → 两条 inconclusive（带原因，不红成机制失效）", () => {
  for (const probeResult of [
    { available: false, reason: "codex sandbox subcommand rejected the probe arguments (exit 2, usage printed)" },
    null,
    undefined,
    {},
  ]) {
    const checks = sandboxEnforcementChecks({ probeResult });
    for (const c of checks) {
      assert.equal(checkStateOf(c), "inconclusive", `${c.name} 对 ${JSON.stringify(probeResult)} 记 inconclusive`);
      assert.ok(typeof c.stateReason === "string" && c.stateReason.length > 0, "inconclusive 必带原因");
    }
    if (probeResult?.reason) {
      assert.match(byName(checks, "sandboxOutsideWriteDenied").stateReason, /usage printed/);
    }
  }
});

test("sandboxEnforcementChecks: 全场景闭集钉——本 drill 永不产出 not-applicable", () => {
  const scenarios = [
    probeResult(),
    probeResult({ outside: { exitCode: 0, fileExists: true, outcome: "written" } }),
    probeResult({ inside: { exitCode: 3, fileExists: false, outcome: "denied" } }),
    probeResult({ outside: { outcome: "not_run", exitCode: 1 } }),
    { available: false, reason: "x" },
    { available: true },
  ];
  for (const probeResult of scenarios) {
    for (const c of sandboxEnforcementChecks({ probeResult })) {
      assert.notEqual(checkStateOf(c), "not-applicable", `sandboxEnforcement 不使用 N/A：${c.name}`);
    }
  }
});

// ════ 2. certificationScope 派生（决定 0086 变体 + 历史形状不变）════

test("certificationScopeForCase: 沙箱后端的 sandboxEnforcement 变体记 delta；非沙箱后端不误记", () => {
  const sandboxDelta = ["sentinel", "scorecard", "sandboxEnforcement"];
  assert.deepEqual(DELTA_DRILLS_WRITE_SANDBOX, sandboxDelta, "delta 沙箱词汇形状钉住");
  // codex 声明 enforcesWriteSandbox → 变体形状按 delta 记（带/不带 profile 两种）。
  assert.equal(certificationScopeForCase({ backend: "codex", profile: "delta", drills: sandboxDelta }), "delta");
  assert.equal(certificationScopeForCase({ backend: "codex", drills: sandboxDelta }), "delta",
    "无 profile 的手写 case：子集内且含 delta 承重 drill → delta（平移 containmentEvidence 语义）");
  // 超出子集 → full。
  assert.equal(
    certificationScopeForCase({ backend: "codex", profile: "delta", drills: [...sandboxDelta, "stop"] }),
    "full",
  );
  assert.equal(
    certificationScopeForCase({ backend: "codex", profile: "strict", drills: [...sandboxDelta, "isolation"] }),
    "full",
  );
  // 非 sandbox 后端写 sandboxEnforcement（矩阵不会产出——配置错误形状）：不判
  // delta 子集（sandboxEnforcement 不在其词汇内），按 full 记。
  assert.equal(
    certificationScopeForCase({ backend: "zcode", profile: "delta", drills: sandboxDelta }),
    "full",
  );
  // 无 backend 事实的形状（历史聚合 fixture）不受新臂影响。
  assert.equal(certificationScopeForCase({ profile: "delta", drills: sandboxDelta }), "full");
});

test("certificationScopeForCase: 历史 summary 的 scope 不变（决定 0086 的读侧不改写）", () => {
  // 历史 codex delta case（containmentEvidence 形状在盘上）——codex 现已声明沙箱，
  // scope 派生必须仍按旧词汇判 delta。
  assert.equal(
    certificationScopeForCase({ backend: "codex", profile: "delta", drills: ["sentinel", "scorecard", "containmentEvidence"] }),
    "delta",
    "历史 codex containmentEvidence 形状的 scope 保持 delta",
  );
  assert.equal(
    certificationScopeForCase({ backend: "codex", profile: "delta", drills: ["sentinel", "scorecard", "adversarialEscape"] }),
    "delta",
    "历史 codex adversarialEscape 形状同样保持",
  );
  assert.equal(
    certificationScopeForCase({ backend: "codex", drills: ["sentinel", "containmentEvidence", "adversarialEscape"] }),
    "full",
    "混写形状照旧 full",
  );
});

// ════ 3. certifyCase / summarize：inconclusive 不评 certified；delta 变体降档 ════

function sandboxDeltaChecks(states = {}) {
  const sandbox = (name, state) => state === "pass"
    ? { name, pass: true, category: "operational", detail: "x", capability: "sandboxEnforcement" }
    : { name, pass: false, state, stateReason: "probe unavailable or uncertain", category: "operational", detail: "x", capability: "sandboxEnforcement" };
  return [
    { name: "completed", pass: true, category: "core", detail: "x", capability: "complete" },
    { name: "commandsPassed", pass: true, category: "strict", detail: "x", capability: "commandEvidence" },
    sandbox("sandboxInsideWriteAllowed", states.inside ?? "pass"),
    sandbox("sandboxOutsideWriteDenied", states.outside ?? "pass"),
    { name: "metricsNonZero", pass: true, category: "observability", detail: "x", capability: "metrics" },
  ];
}

test("certifyCase: 沙箱 delta 变体全过 → conditional（Owner 方案 A，与 containmentEvidence 变体同语义）", () => {
  const result = certifyCase({
    caseId: "codex-delta",
    backend: "codex",
    profile: "delta",
    drills: ["sentinel", "scorecard", "sandboxEnforcement"],
    checks: sandboxDeltaChecks(),
  });
  assert.equal(result.status, "conditional", "delta 子集全过不产生 certified");
  assert.match(result.reason, /delta certification scope/);
  assert.equal(result.capabilities.sandboxEnforcement, true);
});

test("certifyCase【证伪】: sandboxEnforcement 检查 inconclusive → 整轮不得评 certified", () => {
  const result = certifyCase({
    caseId: "codex-delta-inconclusive",
    backend: "codex",
    profile: "delta",
    drills: ["sentinel", "scorecard", "sandboxEnforcement"],
    checks: sandboxDeltaChecks({ outside: "inconclusive" }),
  });
  assert.notEqual(result.status, "certified");
  assert.equal(result.status, "conditional", "类目已覆盖但必需证据 inconclusive → conditional");
  assert.match(result.reason, /sandboxOutsideWriteDenied/);
  assert.equal(result.capabilities.sandboxEnforcement, "unknown", "评估不完整的轴不得置绿");

  // 全量画像（strict）同样不得借 inconclusive 评 certified。
  const strict = certifyCase({
    caseId: "codex-strict-inconclusive",
    backend: "codex",
    profile: "strict",
    drills: ["sentinel", "scorecard", "sandboxEnforcement", "isolation"],
    requiredCategories: ["core", "strict", "operational", "observability"],
    checks: [
      ...sandboxDeltaChecks({ outside: "inconclusive" }),
      { name: "isolationWorktreeCreated", pass: true, category: "operational", detail: "x", capability: "isolation" },
    ],
  });
  assert.notEqual(strict.status, "certified");
});

test("summarizeCertification: 沙箱 delta case → worker conditional + certificationScope delta", () => {
  const summary = summarizeCertification([
    {
      caseId: "codex delta",
      agentId: "coder_sol",
      backend: "codex",
      providerID: null,
      modelId: "gpt-6.1-sol",
      providerKey: null,
      profile: "delta",
      drills: ["sentinel", "scorecard", "sandboxEnforcement"],
      checks: sandboxDeltaChecks(),
    },
  ], { generatedAt: "2026-10-16T00:00:00.000Z" });
  const w = Object.values(summary.workers)[0];
  assert.equal(w.status, "conditional");
  assert.equal(w.certificationScope, "delta");
  assert.equal(summary.allCertified, false);
});

// ════ 4. matrix 构建：沙箱车道的词汇替换（决定 0086 第 5 条）════

test("buildCertificationMatrix: codex 车道各画像的 containmentEvidence 一律换成 sandboxEnforcement；其余车道不变", () => {
  const registry = {
    agents: {
      coder_sol: { backend: "codex", cwd: "D:/repo" },
      coder_z: { backend: "zcode", cwd: "D:/repo", binary: "D:/tools/zcode.cjs", model: { id: "p/m" } },
    },
    certification: {
      matrix: [
        { agentId: "coder_sol", profile: "delta" },
        { agentId: "coder_sol", profile: "strict", drills: ["sentinel", "scorecard", "containmentEvidence"] },
        { agentId: "coder_z", profile: "delta" },
        { agentId: "coder_z", profile: "strict", drills: ["sentinel", "scorecard", "containmentEvidence"] },
      ],
    },
  };
  const byAgentProfile = new Map(
    buildCertificationMatrix({ registry })
      .map((row) => [[row.agentId, row.profile].join(":"), row]),
  );

  // codex：默认 delta 集、显式 containmentEvidence 行、strict 补齐集——全部换成
  // sandboxEnforcement，去重后不残留 containmentEvidence。
  assert.deepEqual(
    byAgentProfile.get("coder_sol:delta").drills,
    ["sentinel", "scorecard", "sandboxEnforcement"],
    "delta 默认集：sandboxEnforcement 取代 containmentEvidence",
  );
  assert.deepEqual(
    byAgentProfile.get("coder_sol:strict").drills,
    ["sentinel", "scorecard", "sandboxEnforcement", "isolation"],
    "行内显式 containmentEvidence 被替换；strict 补齐集同样替换",
  );
  for (const row of buildCertificationMatrix({ registry })) {
    if (row.agentId === "coder_sol") {
      assert.ok(!row.drills.includes("containmentEvidence"), "codex 车道任何画像不得残留 containmentEvidence");
      assert.ok(row.drills.includes("sandboxEnforcement"));
      assert.ok(row.requiredCategories.includes("operational"), "sandboxEnforcement 承担 isolation 语义 → operational 必需");
    } else {
      assert.ok(row.drills.includes("containmentEvidence"), "非沙箱车道词汇不变");
      assert.ok(!row.drills.includes("sandboxEnforcement"));
    }
  }
  // certification 画像同 strict。
  const cert = buildCertificationMatrix({
    registry: { agents: registry.agents, certification: { matrix: [{ agentId: "coder_sol", profile: "certification" }] } },
  });
  assert.deepEqual(cert[0].drills, ["sentinel", "scorecard", "sandboxEnforcement", "isolation"]);
});

test("buildCertificationMatrix: 行内显式写了 containmentEvidence 与 sandboxEnforcement 的 codex 行 → 替换后去重", () => {
  const registry = {
    agents: { coder_sol: { backend: "codex", cwd: "D:/repo" } },
    certification: {
      matrix: [{ agentId: "coder_sol", profile: "delta", drills: ["sentinel", "scorecard", "containmentEvidence", "sandboxEnforcement"] }],
    },
  };
  const [row] = buildCertificationMatrix({ registry });
  assert.deepEqual(row.drills, ["sentinel", "scorecard", "sandboxEnforcement"], "替换后去重，不产生重复项");
});
