// test/delivery/gitChildEnvGuard.test.js
//
// TD-236 升级（会审 consult_20261008164029600fyqngp，opus，scorecard 字面量
// 闭集测试先例）：交付完整性模块内所有 git 子进程调用（execFileSync/
// spawnSync 首参 "git"，含经变量转发等价形态）必须经 gitChildEnv（或等价
// force-last 注入）构造 env——扫源断言，新模式绕过即红。
//
// 范围（会审裁定四模块）：src/delivery.js、src/application/runDeliveryReview.js、
// src/application/workspaceBinding.js、src/isolation.js。
// 注：isolation.js 的 `execSync("git worktree prune")` 是 shell 字符串形态的
// 尽力清理（失败吞掉、输出弃用），不属于本守卫的模式面（首参结构化 "git"），
// 也非交付完整性读取。
//
// 纪律约束（"不得复制第二份"）：三个消费模块必须 import gitChildEnv，模块内
// 不得出现注入字面量的第二实现。
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

const GUARD_SCOPE = [
  "src/delivery.js",
  "src/application/runDeliveryReview.js",
  "src/application/workspaceBinding.js",
  "src/isolation.js",
];

// 等价 force-last 兜底：gitChildEnv 之外的合法形态（内联 spread 后覆写）。
// 新代码一律用 gitChildEnv；此兜底只为不让等价旧形态误红。
const FORCE_LAST = /env:\s*\{\s*\.\.\.[^{}]*GIT_NO_REPLACE_OBJECTS:\s*"1"/;

/**
 * 找出源文本内所有 git 子进程调用点（exec 系与 spawn 系、首参为字面量 "git"，
 * 或 workspaceBinding 的注入型 bin 变量等价形态），返回每处的调用文本切片
 * （到该调用的选项对象闭合为止）。
 */
function gitCallSites(src) {
  const starts = [
    ...src.matchAll(/\b(?:execFileSync|spawnSync|execSync|exec|spawn)\s*\(\s*"git"/g),
    ...src.matchAll(/\bexecFileSync\s*\(\s*bin\s*,/g),
  ].map((m) => m.index);
  return starts.map((start) => {
    // 调用以 `})` 收束（选项对象是末参；`.trim()` 等后缀在其后），取到首个
    // 行首缩进的 `})` 为止的切片作为该调用的判定窗口。
    const rest = src.slice(start);
    const close = rest.search(/\n\s*\}\)/);
    return close === -1 ? rest.slice(0, 700) : rest.slice(0, close + 1);
  });
}

test("TD-236 静态守卫：交付完整性模块所有 git 子进程调用经 gitChildEnv 构造 env", () => {
  for (const rel of GUARD_SCOPE) {
    const src = read(rel);
    const sites = gitCallSites(src);
    assert.ok(sites.length > 0, `${rel}: 扫描须找到至少一个 git 子进程调用（扫描器失效即红）`);
    for (const site of sites) {
      assert.ok(
        /env:\s*gitChildEnv\s*\(/.test(site) || FORCE_LAST.test(site),
        `${rel}: git 子进程调用的 env 必须经 gitChildEnv（或等价 force-last 注入）构造，绕过即红。调用切片：\n${site}`,
      );
    }
  }
});

test("TD-236 静态守卫：消费模块 import gitChildEnv，不得复制第二份注入实现", () => {
  for (const rel of GUARD_SCOPE.slice(1)) {
    const src = read(rel);
    assert.match(src, /gitChildEnv/, `${rel}: 必须引用 gitChildEnv`);
    assert.match(src, /from\s+"\.\.\/delivery\.js"|from\s+"\.\/delivery\.js"/,
      `${rel}: 必须从 delivery.js import（SSOT 单源）`);
    assert.equal(
      (src.match(/GIT_NO_REPLACE_OBJECTS:\s*"1"/g) ?? []).length, 0,
      `${rel}: 不得内联第二份 GIT_NO_REPLACE_OBJECTS 注入字面量`,
    );
  }
});

test("TD-236 静态守卫（红方自证）：绕过形态会被扫描器捕获", () => {
  // 守卫自身的反例钉：一个未经 gitChildEnv 的 git 调用必须被判定为违规，
  // 防止扫描器静默失明（找不到调用点时上面的 assert.ok(length>0) 也会红）。
  const bypass = [
    'execFileSync("git", ["status"], {',
    '  cwd,',
    '  env: process.env,',
    '});',
  ].join("\n");
  const sites = gitCallSites(bypass);
  assert.equal(sites.length, 1, "扫描器捕获新增 git 调用点");
  assert.equal(
    /env:\s*gitChildEnv\s*\(/.test(sites[0]) || FORCE_LAST.test(sites[0]), false,
    "绕过形态（env: process.env）不得通过守卫",
  );
});
