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
  // 第 140b 批修正轮：Owner 读模型的只读分支枚举与 leadOpenItems 的默认执行缝——
  // 两者同样只问那个目录自己的仓库，继承的 GIT_DIR 会让它们答错。
  "src/application/runBranches.js",
  "src/application/leadOpenItems.js",
];

// gitProbeEnv（delivery.js）是 gitChildEnv 去掉 git 的定位变量，注入照旧在场；
// 它建在 gitChildEnv 之上这一点由下面的定义钉守住。
// 也接受"在 gitProbeEnv() 之上追加显式变量"的形态（runBranches 用它设
// GIT_CEILING_DIRECTORIES：env: { ...gitProbeEnv(), … }）——但 helper 之后只许显式键，
// 不许再有 ... 展开（...process.env 在后必须红）。
const HELPER_CALL = "(?:gitChildEnv|gitProbeEnv)";
const VIA_HELPER_CALL = new RegExp(`env:\\s*${HELPER_CALL}\\s*\\(`);
const VIA_HELPER_SPREAD = new RegExp(`env:\\s*\\{\\s*\\.\\.\\.\\s*${HELPER_CALL}\\s*\\(\\s*\\)\\s*([\\s\\S]*?)\\}`);

// 等价 force-last 兜底：gitChildEnv 之外的合法形态（内联 spread 后覆写）。
// 新代码一律用 gitChildEnv；此兜底只为不让等价旧形态误红。
const FORCE_LAST = /env:\s*\{\s*\.\.\.[^{}]*GIT_NO_REPLACE_OBJECTS:\s*"1"/;

// 只问"那个目录自己的仓库"的模块必须用 gitProbeEnv（去定位变量），不许只用
// gitChildEnv（保留 GIT_DIR 等，会回答别处仓库）。
const PROBE_ONLY_FILES = ["src/application/runBranches.js", "src/application/leadOpenItems.js"];

/** env 是否经 SSOT 构造、且展开 helper 之后没有第二个 ... 展开。 */
function envViaHelper(site) {
  if (VIA_HELPER_CALL.test(site)) return true;
  const spread = VIA_HELPER_SPREAD.exec(site);
  if (spread === null) return false;
  return !/\.\.\./.test(spread[1]);
}

/** PROBE_ONLY_FILES 的 env 构造规则：必须用 gitProbeEnv，且不得直接调 gitChildEnv。 */
function probeOnlyViolation(src) {
  if (!/gitProbeEnv\s*\(/.test(src)) return "no_gitProbeEnv";
  if (/\bgitChildEnv\s*\(/.test(src)) return "uses_gitChildEnv";
  return null;
}

/**
 * 找出源文本内所有 git 子进程调用点（exec 系与 spawn 系、首参为字面量 "git"
 * 或 'git'，或 workspaceBinding 的注入型 bin 变量等价形态），返回每处的调用文本
 * 切片（到该调用的选项对象闭合为止）。切片不越过下一个调用点的起点：异步
 * execFile(…, { … }, (error, stdout) => { … }) 形态下，回调体里的下一条调用的
 * 合规 env 不能被算给当前调用。
 */
function gitCallSites(src) {
  const starts = [
    // 首参字面量 "git" / 'git' 都算（双引号、单引号；反引号不必须）。
    ...src.matchAll(/\b(?:execFileSync|execFile|spawnSync|execSync|exec|spawn)\s*\(\s*["']git["']/g),
    ...src.matchAll(/\bexecFileSync\s*\(\s*bin\s*,/g),
  ].map((m) => m.index).sort((a, b) => a - b);
  return starts.map((start, index) => {
    // 调用以 `})` 收束（选项对象是末参；`.trim()` 等后缀在其后），取到首个
    // 行首缩进的 `})` 为止的切片作为该调用的判定窗口；最迟到下一个调用点之前。
    const nextStart = index + 1 < starts.length ? starts[index + 1] : src.length;
    const rest = src.slice(start, nextStart);
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
        envViaHelper(site) || FORCE_LAST.test(site),
        `${rel}: git 子进程调用的 env 必须经 gitChildEnv（或等价 force-last 注入）构造，绕过即红。调用切片：\n${site}`,
      );
    }
  }
});

test("TD-236 静态守卫：gitProbeEnv 从 gitChildEnv 起步，只删定位变量", () => {
  const src = read("src/delivery.js");
  const body = src.slice(src.indexOf("export function gitProbeEnv("));
  const fn = body.slice(0, body.indexOf("\n}\n") + 2);
  assert.match(fn, /const env = gitChildEnv\(callerEnv\);/, "gitProbeEnv 须从 gitChildEnv(callerEnv) 起步");
  assert.doesNotMatch(src.slice(src.indexOf("const GIT_LOCATION_ENV"), src.indexOf("export function gitProbeEnv(")), /GIT_NO_REPLACE_OBJECTS/,
    "定位变量清单不得包含 GIT_NO_REPLACE_OBJECTS");
});

test("TD-236 静态守卫：消费模块 import gitChildEnv（或建在它之上的 gitProbeEnv），不得复制第二份注入实现", () => {
  for (const rel of GUARD_SCOPE.slice(1)) {
    const src = read(rel);
    // gitProbeEnv 只删定位变量、不复制注入（上面的定义钉守住）；两者都算经 SSOT。
    assert.match(src, /gitChildEnv|gitProbeEnv/, `${rel}: 必须引用 gitChildEnv / gitProbeEnv`);
    assert.match(src, /from\s+"\.\.\/delivery\.js"|from\s+"\.\/delivery\.js"/,
      `${rel}: 必须从 delivery.js import（SSOT 单源）`);
    assert.equal(
      (src.match(/GIT_NO_REPLACE_OBJECTS:\s*"1"/g) ?? []).length, 0,
      `${rel}: 不得内联第二份 GIT_NO_REPLACE_OBJECTS 注入字面量`,
    );
  }
});

test("TD-236 静态守卫：只问 key 自己仓库的模块必须用 gitProbeEnv（去定位变量），不许只用 gitChildEnv", () => {
  for (const rel of PROBE_ONLY_FILES) {
    assert.equal(probeOnlyViolation(read(rel)), null, `${rel}: env 必须经 gitProbeEnv 构造`);
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
  assert.equal(envViaHelper(sites[0]) || FORCE_LAST.test(sites[0]), false, "绕过形态（env: process.env）不得通过守卫");

  // ① 展开 helper 之后再展开 ...process.env：不是"只追加显式键"，必须红。
  const spreadAfter = [
    'execFile("git", ["for-each-ref"], {',
    '  cwd,',
    '  env: { ...gitProbeEnv(), ...process.env },',
    '});',
  ].join("\n");
  const spreadSites = gitCallSites(spreadAfter);
  assert.equal(spreadSites.length, 1);
  assert.equal(envViaHelper(spreadSites[0]), false, "gitProbeEnv() 之后的 ...process.env 必须判红");
  // 对照：只追加显式键是合规的。
  const explicit = [
    'execFile("git", ["for-each-ref"], {',
    '  cwd,',
    '  env: { ...gitProbeEnv(), GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)) },',
    '});',
  ].join("\n");
  assert.equal(envViaHelper(gitCallSites(explicit)[0]), true, "gitProbeEnv() 之后只追加显式键合规");

  // ② 这两个文件里只用 gitChildEnv（不用 gitProbeEnv）必须红。
  const childOnly = 'execFileSync("git", ["for-each-ref"], { cwd, env: gitChildEnv() });';
  assert.equal(probeOnlyViolation(childOnly), "no_gitProbeEnv", "只用 gitChildEnv 必须判红");
  assert.equal(probeOnlyViolation(childOnly.replace("gitChildEnv", "gitProbeEnv")), null, "改用 gitProbeEnv 合规");

  // ③ 异步回调形态：违规调用的切片不能吞掉紧跟其后的合规调用。
  const callbackPair = [
    'execFile("git", ["a"], { cwd, env: process.env }, (error, stdout) => {',
    '  return stdout;',
    '});',
    'execFile("git", ["b"], { cwd, env: gitProbeEnv() }, (error, stdout) => {',
    '  return stdout;',
    '});',
  ].join("\n");
  const pairSites = gitCallSites(callbackPair);
  assert.equal(pairSites.length, 2, "两条调用各一个切片");
  assert.equal(envViaHelper(pairSites[0]) || FORCE_LAST.test(pairSites[0]), false,
    "回调形态的违规调用不得借下一条调用的合规 env 通过");
  assert.equal(envViaHelper(pairSites[1]), true, "第二条合规调用照常通过");

  // ④ 单引号首参：已有合规调用后面跟一条单引号、无 env 的调用 → 必须扫到并判红。
  const singleQuoted = [
    'execFile("git", ["a"], { cwd, env: gitProbeEnv() }, (error, stdout) => {',
    '  return stdout;',
    '});',
    "execFile('git', ['b'], { cwd }, (error, stdout) => {",
    '  return stdout;',
    '});',
  ].join("\n");
  const singleQuotedSites = gitCallSites(singleQuoted);
  assert.equal(singleQuotedSites.length, 2, "单引号调用也要被扫描到（不能漏计）");
  assert.equal(envViaHelper(singleQuotedSites[1]) || FORCE_LAST.test(singleQuotedSites[1]), false,
    "单引号、无 env 的调用必须判红");
});
