import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCertificationMatrix,
  defaultDrillsForProfile,
} from "../scripts/reliability/matrix.mjs";

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
    completionMode: "first-stable",
  });
  assert.equal(matrix[1].backend, "claude-code");
  assert.equal(matrix[1].providerID, "deepseek");
  assert.equal(matrix[1].modelId, "deepseek-v4-flash");
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
