// test/delivery/gitNoReplacePin.test.js
//
// TD-236（2026-10-09，会审 consult_20261008164029600fyqngp astra/opus）+
// TD-236 升级（同会审）：交付完整性面的 git 子进程必须禁用 replace objects
// ——refs/replace 可整体替换提交对象（消息/身份/树全来自替身）或 --graft
// 伪造父链，洗白走私改动。升级后注入的 SSOT 是 delivery.js 导出的
// gitChildEnv（force-last：spread 调用方 env 后覆写，调用方无法反盖）。
// 本文件是源钉（nestedDispatchGuard ③ 同款纪律）：六个收口点必须经
// gitChildEnv 构造 env。行为级反例见 runDeliveryRepackage.test.js 的 TD-236
// 钉；扫源守卫（新模式绕过即红）见 gitChildEnvGuard.test.js。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { gitChildEnv } from "../../src/delivery.js";

const ROOT = resolveRoot();
function resolveRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..");
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// 六个收口点：文件 → 该文件内 `env: gitChildEnv(` 注入的最少出现次数。
// （isolation.js 两处：创建 + 清理；其余各一处——delivery 的 git() 封装、
// review 的 gitReadBounded、workspaceBinding 的 git() 封装、runManager 的
// frozen-head rev-parse。）
const SITES = [
  ["src/delivery.js", 1],
  ["src/application/runDeliveryReview.js", 1],
  ["src/application/workspaceBinding.js", 1],
  ["src/isolation.js", 2],
  ["src/runManager.js", 1],
];

test("TD-236 源钉：六个交付完整性 git 收口点经 gitChildEnv 注入 env", () => {
  for (const [rel, min] of SITES) {
    const src = read(rel);
    const hits = src.match(/env:\s*gitChildEnv\(/g) ?? [];
    assert.ok(hits.length >= min,
      `${rel}: env: gitChildEnv( 注入 ≥${min} 处，实测 ${hits.length}`);
  }
});

test("TD-236 源钉：gitChildEnv 是 delivery.js 导出的唯一注入实现（force-last 形态）", () => {
  const src = read("src/delivery.js");
  // 实现形态钉：spread 调用方 env（保序，不覆盖 commitEnv 身份）后 force-last 覆写。
  assert.match(src,
    /export function gitChildEnv\(callerEnv\) \{\s*return \{ \.\.\.\(callerEnv \?\? process\.env\), GIT_NO_REPLACE_OBJECTS: "1" \};?\s*\}/,
    "delivery.js 必须以 force-last 形态导出 gitChildEnv");
  // 代码级字面量唯一源：除 gitChildEnv 定义行外，src/ 内不得再有
  // GIT_NO_REPLACE_OBJECTS:"1" 字面量（注释不算，由 gitChildEnvGuard 另行扫）。
  const literalHits = [...src.matchAll(/GIT_NO_REPLACE_OBJECTS:\s*"1"/g)];
  assert.equal(literalHits.length, 1, "delivery.js 内注入字面量只出现在 gitChildEnv 定义内");
});

test("TD-236 行为钉：gitChildEnv force-last 不可被调用方反盖，身份 env 原样透传", () => {
  // 反盖尝试：调用方显式置 0 也必须被覆写成 1。
  const defended = gitChildEnv({ GIT_NO_REPLACE_OBJECTS: "0", KNOWN_KEY: "v" });
  assert.equal(defended.GIT_NO_REPLACE_OBJECTS, "1", "调用方显式反盖值被 force-last 覆写");
  assert.equal(defended.KNOWN_KEY, "v", "调用方其余 env 原样透传");
  // 缺省 = process.env 展开。
  const fromProcess = gitChildEnv();
  assert.equal(fromProcess.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(fromProcess.PATH, process.env.PATH, "缺省时展开 process.env");
  // commitEnv 身份透传（packageDelivery 的 commit-tree 场景）：身份键保持调用方值。
  const commitEnv = gitChildEnv({
    ...process.env,
    GIT_AUTHOR_NAME: "WAO Delivery",
    GIT_AUTHOR_EMAIL: "wao-delivery@local",
  });
  assert.equal(commitEnv.GIT_AUTHOR_NAME, "WAO Delivery");
  assert.equal(commitEnv.GIT_AUTHOR_EMAIL, "wao-delivery@local");
  assert.equal(commitEnv.GIT_NO_REPLACE_OBJECTS, "1");
  // 不修改调用方 env 对象。
  const caller = { GIT_NO_REPLACE_OBJECTS: "0" };
  gitChildEnv(caller);
  assert.equal(caller.GIT_NO_REPLACE_OBJECTS, "0", "不原地修改 callerEnv");
});
