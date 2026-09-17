// test/registry-roles/knownBackendsF3.test.js
//
// TD-161 auditor F3 回归钉（2026-09-17 复核修复）：组合错误路径下支持集
// 提示不得消失——坏 backend + 缺 cwd 时 normalizeAgent 先抛 cwd 错，完整
// 指路必须由 commands 层 issue（unknownBackendGuidance 同源）携带；
// 纯坏 backend 时闭集在同一 validate 输出只出现一次（双打印消解）。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { registryValidateCommand } from "../../src/commands/registry.js";
import { unknownBackendGuidance } from "../../src/registry.js";

async function validateIssuesWith(agents) {
  const dir = mkdtempSync(join(tmpdir(), "wao-f3-"));
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({ agents }, null, 2));
  const lines = [];
  const origLog = console.log;
  const prevExitCode = process.exitCode;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await registryValidateCommand(
      ["--registry", registryPath, "--format", "json"],
      { registry: registryPath },
    );
  } finally {
    console.log = origLog;
    process.exitCode = prevExitCode; // validate 会置 exitCode=1（invalid），不得泄漏到测试进程
  }
  rmSync(dir, { recursive: true, force: true });
  const parsed = JSON.parse(lines.join("\n"));
  const entry = (parsed.agents || []).find((x) => x.id === "bad") || {};
  return entry.issues || [];
}

test("TD-161 F3: 组合错误（坏 backend + 缺 cwd）下支持集与 ADR 指路仍在", async () => {
  const issues = await validateIssuesWith({ bad: { backend: "zcode" } });
  const joined = issues.join("\n");
  for (const b of ["opencode-serve", "claude-code", "codex", "kimi-code", "deepseek-harness"]) {
    assert.ok(joined.includes(b), `组合错误 issues 必须仍含支持集成员：${b}`);
  }
  assert.ok(joined.includes("ADR-0028"), "组合错误 issues 必须仍含 ADR-0028 指路");
});

test("TD-161 双打印消解: 纯坏 backend 时闭集恰好罗列一次", async () => {
  const issues = await validateIssuesWith({ bad: { backend: "zcode", cwd: "D:/proj" } });
  const occurrences = issues.join("\n").split("supported: opencode-serve/claude-code").length - 1;
  assert.equal(occurrences, 1, `闭集应恰好罗列一次，实际 ${occurrences} 次（issues: ${JSON.stringify(issues)}）`);
});

test("TD-161 N1 回归钉: 坏值回显含 'has unknown backend' 的其他错误不得被去重吞掉", async () => {
  // auditor N1 实证反例：waitTimeout 坏值恰为 "has unknown backend"——
  // 错误原文回显该值，子串去重曾把真实错误吞成 valid:true 假通过。
  const issues = await validateIssuesWith({
    bad: { backend: "codex", cwd: "D:/proj", waitTimeout: "has unknown backend" },
  });
  const joined = issues.join("\n");
  assert.ok(joined.includes("waitTimeout"), `waitTimeout 硬错误必须透传（issues: ${JSON.stringify(issues)}）`);
  assert.ok(joined.length > 0, "issues 不得为空（否则为假通过）");
});

test("TD-161 F3 单元钉: unknownBackendGuidance 含五成员 + Owner decision + ADR-0028", () => {
  const g = unknownBackendGuidance("zcode");
  for (const b of ["opencode-serve", "claude-code", "codex", "kimi-code", "deepseek-harness"]) {
    assert.ok(g.includes(b));
  }
  assert.ok(g.includes("Owner decision"));
  assert.ok(g.includes("ADR-0028"));
  assert.ok(g.includes("zcode"), "坏值回显（既有行为）");
});
