// test/registry-roles/knownBackendsSsot.test.js
//
// TD-161 钉住测试：backend 闭集 SSOT 常量 + unknown-backend 报错文案。
//
// 三根钉：
//   1. 常量内容钉：KNOWN_BACKENDS 恰为六成员且冻结（成员增补只能经 Owner
//      决定进入，且进入时本文件与文案钉会一起被审视——第六成员 deepseek-acp
//      即按此流程于 ADR-0031 落地）。
//   2. 报错文案钉：unknown-backend 错误逐名列出闭集全部成员 + "Owner decision"
//      + "ADR-0028"（分叉指路：换模型走既有 backend 的 model/provider 字段；
//      新 backend 是 Owner 决定——不诱导把模型通道当 runtime 替代解）。
//   3. SSOT 钉：src/commands/registry.js 不再含本地闭集数组字面量，且
//      KNOWN_BACKENDS import 自 ../registry.js（commands → core 下向边）。
// 既有 /unknown backend/ 松正则测试（registry.test.js）不受影响，继续绿。

import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAgent, KNOWN_BACKENDS } from "../../src/registry.js";

const COMMANDS_REGISTRY_URL = new URL("../../src/commands/registry.js", import.meta.url);

test("TD-161: KNOWN_BACKENDS SSOT 恰为六成员且冻结", () => {
  assert.deepEqual(KNOWN_BACKENDS, [
    "opencode-serve", "claude-code", "codex", "kimi-code", "deepseek-harness",
    // 第六成员（ADR-0031，2026-09-19 Owner 授权）：DSH ACP 集成面。
    "deepseek-acp",
  ]);
  assert.ok(Object.isFrozen(KNOWN_BACKENDS), "闭集必须冻结（防运行期漂移）");
});

test("TD-161: unknown-backend 报错逐名列出闭集全部成员 + Owner decision + ADR-0028", () => {
  let err;
  try {
    normalizeAgent("bad", { backend: "zcode", cwd: "D:/proj" });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error, "unknown backend 必须被拒绝");
  for (const b of KNOWN_BACKENDS) {
    assert.ok(err.message.includes(b), `报错必须逐名列出闭集成员：${b}`);
  }
  assert.ok(err.message.includes("Owner decision"), "必须含 Owner decision 指路");
  assert.ok(err.message.includes("ADR-0028"), "必须指向 ADR-0028");
  // 坏值回显是既有行为（fixed-safe 纪律允许）。
  assert.ok(err.message.includes("zcode"), "坏值本身回显（既有行为）");
});

test("TD-161 SSOT 钉: commands/registry.js 无本地闭集字面量且 import 自 core", async () => {
  const src = await readFile(COMMANDS_REGISTRY_URL, "utf8");
  // 只钉"数组字面量形态"（相邻成员 "opencode-serve", "claude-code"）——单独的
  // "opencode-serve" 字符串比较（check/validate 的分支判断）是合法存在的。
  assert.doesNotMatch(
    src,
    /"opencode-serve"\s*,\s*"claude-code"/,
    "commands 层不得再持有闭集数组字面量（SSOT 在 src/registry.js）",
  );
  assert.match(
    src,
    /import\s*\{[^}]*\bKNOWN_BACKENDS\b[^}]*\}\s*from\s*"\.\.\/registry\.js"/,
    "KNOWN_BACKENDS 必须 import 自 ../registry.js（commands → core 下向边）",
  );
});
