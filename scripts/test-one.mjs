#!/usr/bin/env node
// scripts/test-one.mjs
//
// F-②（2026-10-10 摩擦处置批，Owner 批准；P1 会审 opus 意见已吸收）：定向测试
// 入口 `npm run test:one -- <file>`。修掉的"三件套"坑（friction-log F-②，本批
// 3 次假红归因成本）：
//   1. PATH v22 —— npm script 链上的 wao-node.cjs 选定（本脚本运行在 v22 下）。
//   2. env 中和 + TEMP 隔离 + 超时常量 + worker 横幅 —— 全部从 canonical 套件
//      【同一来源】import（canonical-test.mjs；该模块有直调守卫，import 不触发
//      main）。红线（会审修订）：本入口【不新增拷贝】——cert 钉值在
//      buildCanonicalChildEnv 与 prepareAttemptEnv 已各有一份，此处不做第三份。
//   3. 文件名形式 —— node --test 目录形式必败（2026-10-07 实证），强校验：
//      目录/缺失文件 → 响亮报错 + 用法一行。
//
// gateHeld 恒 false：单文件定向跑属于 R23 既定的 fail-open/advisory 层（不持
// 机器租约、不谎报闸持有）。
//
// glob 说明：node --test 对 glob 模式有原生展开（v22.23.1 实测），但【零匹配
// 时 exit 0 + tests 0 = 静默绿】（实测）——拼错路径会伪装成成功。故本入口自带
// 展开（验证与执行同一套语义），零匹配明确失败，不直通原生展开。

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalChildEnv,
  isolateSuiteTemp,
  TEST_TIMEOUT_MS,
  workerBannerLine,
} from "./canonical-test.mjs";

const USAGE = "用法：npm run test:one -- <测试文件路径>（文件形式，可多个；glob 仅支持 test/ 树，如 test/delivery/*.test.js）";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`[test:one] ${message}\n${USAGE}\n`);
  process.exit(2);
}

// 极简 glob → RegExp：`**` 跨目录（.*）、`*` 段内（[^/]*）、`?` 单字符。
// 路径分隔符统一 POSIX 形态后匹配。只服务 test/ 树下的 *.test.js 类模式。
function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function walkTestTree() {
  const out = [];
  const stack = ["test"];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
    } catch {
      continue; // 无权限/缺目录的子树跳过；匹配为空会在上层响亮报错
    }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) stack.push(rel);
      else if (e.isFile()) out.push(rel);
    }
  }
  return out;
}

function expandGlob(pattern) {
  const normalized = pattern.replace(/\\/g, "/");
  if (!normalized.startsWith("test/")) {
    fail(`glob 模式必须以 test/ 开头（收到：${pattern}）`);
  }
  const re = globToRegExp(normalized);
  const matched = walkTestTree().filter((f) => re.test(f));
  if (matched.length === 0) {
    fail(`glob 模式零匹配（模式：${pattern}）——node --test 原生展开对零匹配是 exit 0 静默绿（实测），此处必须明确失败`);
  }
  return matched.map((f) => join(repoRoot, f));
}

function resolveFileArg(arg) {
  const abs = resolve(arg);
  let st;
  try {
    st = statSync(abs);
  } catch {
    fail(`文件不存在：${arg}`);
  }
  if (st.isDirectory()) {
    fail(`收到目录（${arg}）——node --test 的目录形式在本仓必败（F-② 实证），请给具体测试文件路径`);
  }
  return abs;
}

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) fail("缺测试文件参数");

const files = [];
for (const arg of rawArgs) {
  if (/[*?]/.test(arg)) files.push(...expandGlob(arg));
  else files.push(resolveFileArg(arg));
}

// TEMP 隔离必须先于 childEnv 派生（TD-223——见 isolateSuiteTemp 头注）。
isolateSuiteTemp();

// worker 上下文提示与全量套件同一来源、同一措辞（决策 0047 self-awareness）。
const banner = workerBannerLine();
if (banner) console.error(banner);

// 单一来源 env 纪律：与 canonical 全量套件的子进程同一份。若未来
// buildCanonicalChildEnv 变化，本入口零改动跟进。
const childEnv = buildCanonicalChildEnv(process.env, { gateHeld: false });

// 本入口语义=新开一场定向测试。v22 测试运行器给测试文件子进程注入
// NODE_TEST_CONTEXT=child-v8（2026-10-10 实测）——若外层是 node:test 环境
// （如本入口的行为钉自己就跑在运行器里），内层 node --test 继承该标记会把
// 报告写向不存在的通道：零输出+假 0 退出。剥掉外层运行器标记=场景隔离，
// 不属于 env 中和清单（清单仍单一来源于 buildCanonicalChildEnv）。
const { NODE_TEST_CONTEXT: _enclosingRunnerMarker, ...freshRunEnv } = childEnv;

// --test-timeout 与全量同一常量（单一来源 import）：单文件挂死也会被收割。
const r = spawnSync(process.execPath, ["--test", `--test-timeout=${TEST_TIMEOUT_MS}`, ...files], {
  stdio: "inherit",
  env: freshRunEnv,
});
if (r.error) {
  fail(`无法启动 node --test：${r.error.message}`);
}
process.exit(r.status ?? (r.signal ? 124 : 1));
