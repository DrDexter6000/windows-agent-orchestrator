// modelFamily.test.js
//
// R9（决策 0023）：模型族系推断（src/application/modelFamily.js）契约测试。
//
// 定位铁律：本表不是契约、展示专用、消费者不得据此门控——测试钉住
// (a) 归一语义（剥 [1m] 后缀/取首段）、(b) backend 兜底、(c) 未识别 → 未知族系、
// (d) 真实入库模板七 worker 的族系事实、(e) 消费面闭集（dispatch/delivery 路径
// 不得 import 本模块——静态扫描 src 的 import 边）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { modelFamilyOf, familyLabel, UNKNOWN_FAMILY } from "../../src/application/modelFamily.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

test("R9: model id 归一——剥 [..] 类后缀、取首段（/ 或 - 之前）命中族系", () => {
  assert.equal(modelFamilyOf({ modelId: "glm-5.3[1m]", backend: "claude-code" }), "glm",
    "glm-5.3[1m] → glm（[1m] 是上下文窗口后缀，不是族系差异）");
  assert.equal(modelFamilyOf({ modelId: "deepseek-v4-flash" }), "deepseek");
  assert.equal(modelFamilyOf({ modelId: "deepseek-v4-pro" }), "deepseek",
    "同族不同档（flash/pro）归同族系");
  assert.equal(modelFamilyOf({ modelId: "kimi-code/k3" }), "kimi", "kimi-code/k3 → kimi（取 / 前首段再取 - 前首段）");
  assert.equal(modelFamilyOf({ modelId: "claude-opus-5" }), "claude");
  assert.equal(modelFamilyOf({ modelId: "GLM-5.2" }), "glm", "大小写归一");
  assert.equal(modelFamilyOf({ modelId: "  kimi-code/k3  " }), "kimi", "首尾空白容忍");
});

test("R9: 无 model 块的 worker 按 backend 名兜底（tester/codex 形状）", () => {
  assert.equal(modelFamilyOf({ backend: "codex" }), "codex",
    "tester 无 model 块——codex backend 兜底为 codex 族（GPT 血缘）");
  assert.equal(modelFamilyOf({ backend: "claude-code" }), "claude");
  assert.equal(modelFamilyOf({ backend: "kimi-code" }), "kimi");
  assert.equal(modelFamilyOf({ backend: "deepseek-harness" }), "deepseek");
});

test("R9: 未识别 → 未知族系（不猜）；model 优先于 backend 兜底", () => {
  assert.equal(modelFamilyOf({}), UNKNOWN_FAMILY, "无 model 无 backend → 未知");
  assert.equal(modelFamilyOf({ modelId: "totally-unknown-v9", backend: "mystery" }), UNKNOWN_FAMILY);
  assert.equal(modelFamilyOf({ backend: "some-future-backend" }), UNKNOWN_FAMILY,
    "backend 兜底表未列的后端 → 未知（不猜）");
  assert.equal(modelFamilyOf({ modelId: "glm-5.3[1m]", backend: "codex" }), "glm",
    "model id 命中时优先于 backend 兜底");
});

test("R9: familyLabel 展示标签闭集；未知 token 一律未知族系", () => {
  assert.equal(familyLabel("glm"), "GLM");
  assert.equal(familyLabel("deepseek"), "DeepSeek");
  assert.equal(familyLabel("codex"), "Codex(GPT)", "codex 标注 GPT 血缘与 claude 系区分");
  assert.equal(familyLabel("no-such-family"), UNKNOWN_FAMILY);
  assert.equal(familyLabel(undefined), UNKNOWN_FAMILY);
});

test("R9: 真实入库模板七 worker 的族系事实（doc↔config 对账锚）", () => {
  const parsed = JSON.parse(readFileSync(join(ROOT, "config", "agents.example.json"), "utf8"));
  const expect = {
    researcher: "deepseek",
    coder_hq: "glm",
    coder_low: "deepseek",
    coder_mm: "kimi",
    tester: "codex", // 无 model 块 → backend 兜底
    auditor: "claude",
    coder_opencode_fallback: "glm",
  };
  for (const [id, family] of Object.entries(expect)) {
    const agent = parsed.agents?.[id];
    assert.ok(agent, `模板缺 worker ${id}`);
    assert.equal(modelFamilyOf({ modelId: agent.model?.id, backend: agent.backend }), family,
      `${id}（model=${agent.model?.id ?? "无"}, backend=${agent.backend}）应推断为 ${family}`);
  }
});

test("R9 守卫: 消费面闭集——dispatch/delivery 路径不得 import modelFamily（非门控铁律）", () => {
  // 递归收集 src/**/*.js，抽取静态 import；modelFamily 的消费面必须是展示面闭集。
  const consumers = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".js")) {
        const text = readFileSync(full, "utf8");
        if (/from\s+["']\.\.?\/(?:application\/)?modelFamily\.js["']/.test(text)) {
          consumers.push(full.replace(/\\/g, "/").split("/src/")[1]);
        }
      }
    }
  };
  walk(join(ROOT, "src"));
  // 展示面闭集：panelReadiness（共享推导）、onboarding 命令层（族系展示标签）。
  // dispatch/delivery/runManager 等控制面路径出现即红（决策 0023 定位红线）。
  assert.deepEqual(consumers.sort(), ["application/panelReadiness.js", "commands/onboarding.js"],
    `modelFamily 消费面必须是展示闭集，实际：${consumers.join(", ")}`);
});

test("R9 守卫: 模块头声明展示专用非契约（防未来被当门控引用）", () => {
  const text = readFileSync(join(ROOT, "src", "application", "modelFamily.js"), "utf8");
  assert.ok(text.includes("本表不是契约，展示专用"), "模块头必须声明展示专用非契约");
  assert.ok(text.includes("不得据此门控"), "模块头必须禁止据此门控");
});
