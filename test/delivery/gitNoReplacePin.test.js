// test/delivery/gitNoReplacePin.test.js
//
// TD-236（2026-10-09，会审 consult_20261008164029600fyqngp astra/opus）：
// 交付完整性面的 git 子进程必须禁用 replace objects——refs/replace 可整体
// 替换提交对象（消息/身份/树全来自替身）或 --graft 伪造父链，洗白走私改动。
// 本文件是源钉（nestedDispatchGuard ③ 同款纪律）：六个收口点的 env 构造必须
// 以 force-last 形式注入 GIT_NO_REPLACE_OBJECTS=1——展开在调用方 env 之后，
// 调用方无法反盖。行为级反例见 runDeliveryRepackage.test.js 的 TD-236 钉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = resolveRoot();
function resolveRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..");
}

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// 六个收口点：文件 → 该文件内 force-last 注入的最少出现次数。
const SITES = [
  ["src/delivery.js", 1],
  ["src/application/runDeliveryReview.js", 1],
  ["src/application/workspaceBinding.js", 1],
  ["src/isolation.js", 2],
  ["src/runManager.js", 1],
];

test("TD-236 源钉：六个交付完整性 git 收口点 force-last 注入 GIT_NO_REPLACE_OBJECTS", () => {
  for (const [rel, min] of SITES) {
    const src = read(rel);
    // force-last 形态：env 对象里 GIT_NO_REPLACE_OBJECTS 出现在任何 spread 之后。
    const hits = src.match(/env:\s*\{\s*\.\.\.[^}]*GIT_NO_REPLACE_OBJECTS:\s*"1"/g) ?? [];
    assert.ok(hits.length >= min,
      `${rel}: force-last GIT_NO_REPLACE_OBJECTS 注入 ≥${min} 处，实测 ${hits.length}`);
  }
});

test("TD-236 源钉：交付 kernel 的注入不可被调用方 env 反盖（spread 在前、字面量在后）", () => {
  const src = read("src/delivery.js");
  assert.match(src,
    /env:\s*\{\s*\.\.\.\(opts\.env\s*\?\?\s*process\.env\),\s*GIT_NO_REPLACE_OBJECTS:\s*"1",?\s*\}/,
    "delivery.js git() 必须 spread 调用方 env 后再覆写 GIT_NO_REPLACE_OBJECTS");
});
