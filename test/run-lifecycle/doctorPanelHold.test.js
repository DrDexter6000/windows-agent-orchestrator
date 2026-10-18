// test/run-lifecycle/doctorPanelHold.test.js
//
// 决定 0090：wao doctor 的 panel_readiness 不把车道表里暂停派发（dispatchHold）的
// 车道算作会审候选，并在提示里带上 Owner 的暂停说明；调用给了非默认 --registry
// 时车道表停用（防跨绑，与 run / registry list 同一规则），提示里没有暂停说明。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { waoDoctorCommand } from "../../src/commands/doctor.js";

const HOLD = "调试中，暂勿派发";

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "wao-doctor-panel-hold-"));
  writeFileSync(join(root, "agents.json"), JSON.stringify({
    agents: {
      la: { backend: "codex", cwd: root, model: { id: "gpt-x" } },
      lb: { backend: "claude-code", cwd: root, model: { id: "claude-x" } },
    },
  }), "utf8");
  return root;
}

const lanesDoc = {
  ok: true,
  sha256: "f".repeat(64),
  issues: [],
  lanes: [{ id: "la", backend: "codex", model: { id: "gpt-x" }, reasoning: { effort: null }, dispatchHold: HOLD, aliases: {} }],
};

async function doctorPanel(root, args) {
  const lines = [];
  const original = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  const savedExitCode = process.exitCode;
  try {
    await waoDoctorCommand([...args, "--format", "json"], {
      registry: join(root, "agents.json"),
      stateDir: join(root, "wao"),
      runDir: join(root, "runs"),
      userEnvReader: async () => undefined,
      scopedEnvReader: async () => ({ status: "absent" }),
      loadLanesConfigFn: () => lanesDoc,
    });
  } finally {
    console.log = original;
    process.exitCode = savedExitCode;
  }
  const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
  assert.ok(jsonLine, "doctor json 输出在场");
  return JSON.parse(jsonLine).checks.find((c) => c.name === "panel_readiness");
}

test("决定 0090: doctor panel_readiness 把暂停派发的车道单列、不算候选", async () => {
  const root = makeRoot();
  try {
    const panel = await doctorPanel(root, []);
    assert.ok(panel, "暂停一条后最多剩一个候选 → panel_readiness 必须打印");
    assert.match(panel.detail, new RegExp(`暂停派发（车道表 dispatchHold，不计入候选）：la（${HOLD}）`));
    assert.doesNotMatch(panel.detail, /可用（[^）]*\bla\b/, "暂停的车道不进可用候选清单");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// CLI 探测沿既有套件假设（claude CLI 在 PATH——与 cli.test.js 的 doctor panel 测试一致）。
test("决定 0090: 会审本可配（两名跨族系候选）时，doctor 仍打印暂停说明", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-doctor-panel-hold-staffed-"));
  const names = ["PANELHOLD_TEST_KEY_A", "PANELHOLD_TEST_KEY_B"];
  const saved = names.map((n) => process.env[n]);
  for (const n of names) process.env[n] = "dummy";
  try {
    const provider = (baseUrl, apiKeyEnv) => ({ protocol: "anthropic-compatible", baseUrl, apiKeyEnv });
    writeFileSync(join(root, "agents.json"), JSON.stringify({
      agents: {
        la: { backend: "codex", cwd: root, model: { id: "gpt-x" } },
        lg: { backend: "claude-code", provider: provider("https://open.bigmodel.cn/api/anthropic", names[0]), model: { id: "glm-5.2" }, cwd: root },
        lk: { backend: "claude-code", provider: provider("https://api.moonshot.cn/anthropic", names[1]), model: { id: "kimi-k3" }, cwd: root },
      },
    }), "utf8");
    const panel = await doctorPanel(root, []);
    assert.ok(panel, "有暂停说明 → 即使会审可配也打印 panel_readiness");
    assert.match(panel.detail, /会审探测候选 ≥2 且来自不同族系（lg、lk）/);
    assert.match(panel.detail, new RegExp(`暂停派发（车道表 dispatchHold，不计入候选）：la（${HOLD}）`));
  } finally {
    names.forEach((n, i) => { if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i]; });
    rmSync(root, { recursive: true, force: true });
  }
});

test("决定 0090: 非默认 --registry 时车道表停用，doctor 不带暂停说明", async () => {
  const root = makeRoot();
  const other = mkdtempSync(join(tmpdir(), "wao-doctor-panel-hold-other-"));
  try {
    writeFileSync(join(other, "agents.json"), JSON.stringify({
      agents: { la: { backend: "codex", cwd: other, model: { id: "gpt-x" } } },
    }), "utf8");
    const panel = await doctorPanel(root, ["--registry", join(other, "agents.json")]);
    assert.ok(panel, "单 worker → panel_readiness 打印");
    assert.ok(!panel.detail.includes("暂停派发"), "车道表停用时没有暂停说明");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
