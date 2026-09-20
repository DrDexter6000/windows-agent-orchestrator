import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCertificationMatrix,
  defaultDrillsForProfile,
} from "../../scripts/reliability/matrix.mjs";

const registry = {
  agents: {
    researcher: {
      backend: "opencode-serve",
      serveUrl: "http://127.0.0.1:4297",
      agent: "build",
      cwd: "D:/repo",
      model: { providerID: "deepseek", id: "deepseek-v4-flash" },
      completionMode: "first-stable",
    },
    coder_strict: {
      backend: "claude-code",
      binary: "C:/Users/me/.local/bin/claude-deepseek.bat",
      cwd: "D:/repo",
    },
  },
  certification: {
    matrix: [
      {
        agentId: "researcher",
        label: "DeepSeek via opencode",
        profile: "strict",
        drills: ["sentinel", "scorecard", "isolation"],
        requiredCategories: ["core", "strict", "observability"],
      },
      {
        agentId: "coder_strict",
        label: "DeepSeek via claude wrapper",
        profile: "strict",
        providerID: "deepseek",
        modelId: "deepseek-v4-flash",
        drills: ["sentinel", "scorecard"],
      },
    ],
  },
};

test("buildCertificationMatrix: reads top-level certification.matrix and enriches from agents", () => {
  const matrix = buildCertificationMatrix({ registry });

  assert.equal(matrix.length, 2);
  assert.deepEqual(matrix[0], {
    agentId: "researcher",
    label: "DeepSeek via opencode",
    profile: "strict",
    drills: ["sentinel", "scorecard", "isolation"],
    requiredCategories: ["core", "strict", "observability", "operational"],
    optional: false,
    expectComplete: true,
    expectText: true,
    backend: "opencode-serve",
    providerID: "deepseek",
    modelId: "deepseek-v4-flash",
    // R23-C：归一化 case 新增认证身份第 4 维 providerKey（无条件写）。researcher
    // fixture 无 agent.provider 块 → 显式 null（已观察确认无接入方；契约详见
    // test/run-lifecycle/certGateIdentityFreshness.test.js T6）。
    providerKey: null,
    completionMode: "first-stable",
  });
  assert.equal(matrix[1].backend, "claude-code");
  // ADR-0032 §6 账实一致：coder_strict fixture **无 agent.model 块** →
  // 归一化身份为 null，与 :providerKey 同款语义（无配置面 → 显式 null，绝不记一个
  // 未实际派发的身份）。旧断言取矩阵行值 "deepseek"，正是"账上身份 ≠ 实际派发配置"的路径。
  assert.equal(matrix[1].providerID, null);
  assert.equal(matrix[1].modelId, null);
});

test("buildCertificationMatrix: explicit requiredCategories are merged with drill-implied categories", () => {
  const matrix = buildCertificationMatrix({ registry });

  assert.deepEqual(matrix[0].requiredCategories, ["core", "strict", "observability", "operational"]);
});

test("buildCertificationMatrix: --agent filters configured cases", () => {
  const matrix = buildCertificationMatrix({ registry, onlyAgent: "coder_strict" });

  assert.deepEqual(matrix.map((c) => c.agentId), ["coder_strict"]);
});

test("buildCertificationMatrix: CLI profile overrides configured profile and strict adds scorecard", () => {
  const matrix = buildCertificationMatrix({
    registry,
    profileOverride: "basic",
  });

  assert.equal(matrix[0].profile, "basic");
  assert.deepEqual(matrix[0].drills, ["sentinel", "scorecard", "isolation"]);

  const strictMatrix = buildCertificationMatrix({
    registry: {
      agents: registry.agents,
      certification: { matrix: [{ agentId: "researcher", drills: ["sentinel"] }] },
    },
    profileOverride: "strict",
  });
  assert.deepEqual(strictMatrix[0].drills, ["sentinel", "scorecard"]);
});

test("buildCertificationMatrix: falls back to legacy cases when no certification config exists", () => {
  const matrix = buildCertificationMatrix({
    registry: {
      agents: {
        coder: {
          backend: "opencode-serve",
          model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" },
        },
        researcher: registry.agents.researcher,
      },
    },
  });

  assert.deepEqual(matrix.map((c) => c.agentId), ["coder", "researcher"]);
  assert.equal(matrix[0].label, "GLM snapshot-stable");
  assert.equal(matrix[1].completionMode, "first-stable");
});

test("defaultDrillsForProfile: basic is sentinel-only, strict includes scorecard", () => {
  assert.deepEqual(defaultDrillsForProfile("basic"), ["sentinel"]);
  assert.deepEqual(defaultDrillsForProfile("strict"), ["sentinel", "scorecard"]);
});

test("buildCertificationMatrix: operational drills require operational certification category", () => {
  const matrix = buildCertificationMatrix({
    registry: {
      agents: registry.agents,
      certification: {
        matrix: [
          {
            agentId: "researcher",
            drills: ["sentinel", "scorecard", "isolation", "workflowRunDir", "stop"],
          },
        ],
      },
    },
  });

  assert.deepEqual(matrix[0].requiredCategories, ["core", "strict", "operational", "observability"]);
});

test("buildCertificationMatrix: isolation and workflowRunDir are operational checks even without stop", () => {
  const matrix = buildCertificationMatrix({
    registry: {
      agents: registry.agents,
      certification: {
        matrix: [
          {
            agentId: "researcher",
            drills: ["sentinel", "scorecard", "isolation", "workflowRunDir"],
          },
        ],
      },
    },
  });

  assert.deepEqual(matrix[0].requiredCategories, ["core", "strict", "operational", "observability"]);
});

// ===== ADR-0032 §6 账实一致 =====
// runner 按 agentId 用 **agent 配置** 派发，因此台账身份必须同源。旧行为允许矩阵行覆盖
// providerID/modelId，制造"账上身份 ≠ 实际派发配置"的路径（TD-169 同族；:providerKey 已有同款先例）。
test("台账身份从 agent 派生：矩阵行不得覆盖 providerID / modelId", () => {
  const [tc] = buildCertificationMatrix({
    registry: {
      agents: { lane_x: { backend: "codex", model: { providerID: "agent-provider", id: "agent-model" } } },
      certification: { matrix: [{ agentId: "lane_x", providerID: "row-provider", modelId: "row-model" }] },
    },
    onlyAgent: "lane_x",
  });
  assert.equal(tc.providerID, "agent-provider", "providerID 必须取 agent 配置");
  assert.equal(tc.modelId, "agent-model", "modelId 必须取 agent 配置");
});

test("矩阵行与 agent 一致时不改变结果", () => {
  const [tc] = buildCertificationMatrix({
    registry: {
      agents: { lane_x: { backend: "codex", model: { providerID: "agent-provider", id: "agent-model" } } },
      certification: { matrix: [{ agentId: "lane_x", providerID: "agent-provider", modelId: "agent-model" }] },
    },
    onlyAgent: "lane_x",
  });
  assert.equal(tc.providerID, "agent-provider");
  assert.equal(tc.modelId, "agent-model");
});

