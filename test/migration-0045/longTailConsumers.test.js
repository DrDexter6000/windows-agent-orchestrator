// test/migration-0045/longTailConsumers.test.js
//
// 0045 W4c（R5 点名三处旁路）：
//   WF-1 workflow agentHandler 经解析层（alias → resolvedTarget 注记入 start）。
//   CR-2 会审厂族砖：注册表解析失败如实标注（渲染区分"席位不在册"与"确无 provider"）。
//   PR-3 seatRoleOf 按角色事实分类（名字模式降为 legacy 回退）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { seatRoleOf } from "../../src/application/panelReadiness.js";
import { renderCouncilDiffText } from "../../src/commands/consult.js";

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m i", { cwd: dir, stdio: "pipe" });
}
function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

test("WF-1: workflow agentHandler 经解析层——alias 派发带身份注记；legacy 直穿零变化", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-wf1-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      "glm-flash": { backend: "zcode", model: { id: "bigmodel-api/GLM-5.3-Flash" }, reasoning: { effort: "max" }, binary: "C:/fake/zcode.cjs", cwd: dir },
      legacy_seat: { backend: "claude-code", cwd: dir },
    } }), "utf8");
    const { readRegistry } = await import("../../src/registry.js");
    const registry = await readRegistry(registryPath);
    const starts = [];
    const ctx = {
      runManager: {
        readRegistry: async () => registry,
        async start(agentId, options) {
          starts.push({ agentId, options });
          return {
            runId: `run_wf_${starts.length}`, transcript: { context: { runId: `run_wf_${starts.length}` }, filePath: join(dir, "runs", "x.jsonl") },
            waitForCompletion: async () => ({ state: "completed" }),
          };
        },
      },
      options: {},
    };
    const { default: handlers } = await import("../../src/workflow/handlers.js");
    const agentHandler = handlers?.agentHandler
      ?? (await import("../../src/workflow/handlers.js")).agentHandler;
    // 0046 步⑥：别名表已清空——agentId 形（含车道键）一律 legacy 直查零注解；
    // 身份注记只经显式 lane+role 组合（commands/run.js 解析块）。
    await agentHandler.execute({ agentId: "glm-flash", prompt: "t" }, ctx);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].options.resolvedTarget, undefined, "车道键 agentId=legacy 直穿零变化（0046）");
    // legacy：未入车道表席位 → 无注记零变化
    await agentHandler.execute({ agentId: "legacy_seat", prompt: "t" }, ctx);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].options.resolvedTarget, undefined, "legacy 席位直穿零变化");
  } finally { cleanupDir(dir); }
});

test("CR-2: 厂族砖渲染——解析失败/注册表不可读如实标注（不混入'确无 provider'）", () => {
  const text = renderCouncilDiffText({
    consultId: "consult_test_cr2",
    record: { consultId: "consult_test_cr2", brief: { path: null, sha256: "x" }, seats: [] },
    seats: [
      { agentId: "alive", runId: "r1", runState: "completed", formatState: "unstructured", backend: "codex", provider: null, registryResolution: "ok", attribution: { ordered: [], unclassified: "x", preamble: "" } },
      { agentId: "gone_seat", runId: "r2", runState: "completed", formatState: "unstructured", backend: null, provider: null, registryResolution: "failed", attribution: { ordered: [], unclassified: "y", preamble: "" } },
      { agentId: "noreg", runId: "r3", runState: "completed", formatState: "unstructured", backend: null, provider: null, registryResolution: "registry-unreadable", attribution: { ordered: [], unclassified: "z", preamble: "" } },
    ],
    fieldDiff: [], questions: [],
    bricks: {},
  });
  assert.match(text, /alive=codex @ 无 provider 标识/);
  assert.match(text, /gone_seat=注册表解析失败（席位已不在注册表？不按独立计）/);
  assert.match(text, /noreg=注册表不可读（不按独立计）/);
});

test("PR-3: seatRoleOf 按角色事实——auditor 族角色=对抗（含 auditor_claude 名字盲区）；名字模式降为回退", () => {
  // 事实优先
  assert.equal(seatRoleOf("auditor_claude", undefined, { roleStem: "auditor" }), "adversarial",
    "auditor_claude 名字旧模式判 non_seat（精确等值才对抗）——角色事实修正");
  assert.equal(seatRoleOf("anything", undefined, { roleStem: "coder_low" }), "implementation");
  assert.equal(seatRoleOf("anything", undefined, { roleStem: "researcher" }), "non_seat", "非对抗/实现角色=non_seat");
  // declared 显式最优先（闭集内）
  assert.equal(seatRoleOf("x", "adversarial", { roleStem: "coder_low" }), "adversarial");
  // 无 facts：legacy 名字回退不回归
  assert.equal(seatRoleOf("auditor", undefined), "adversarial");
  assert.equal(seatRoleOf("coder_hq", undefined), "implementation");
  assert.equal(seatRoleOf("auditor_claude", undefined), "non_seat", "legacy 回退保持旧形状（该盲区正是事实修复对象）");
});
