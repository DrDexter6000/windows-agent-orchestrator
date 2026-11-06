#!/usr/bin/env node
// scripts/gen-surface-cli.mjs
//
// 薄入口（TD-185，2026-09-27）——docs/surface/ 下 gen-surface 生成文件
// （mcp-tools.md、cli.md、transcript-events.md）的唯一进程入口，照
// gen-certification-cli.mjs 的同款拆分；2026-11 起同一入口还重写 docs/usage.md
// 里一对标记之间的页表区域（决定 0115：区域从各页 frontmatter 生成，其余正文
// 手写、原样保留）。渲染逻辑全部在纯库
// scripts/gen-surface.mjs（generate()/render()/generateUsageMap()，导入零副作用、零入口探测）；本
// 文件只做参数分发与文件 IO，不判断自身身份（无 import.meta.main / argv[1] 比对
// / realpath-ino 判定——被删除的旧 fail-open 正是 `import.meta.main` 在
// Node 22.x < 22.18 上为 undefined 所致）。
//
// 参数合同（恰好三种形状，其他一切非零退出且不写入不检查）：
//   无参数            = 生成：先完整跑 generate()，成功后才写出全部 surface 文件
//                       （渲染/派生失败 ⇒ 未写任何字节即非零退出，旧文件原样；
//                       注意文件是顺序写出——中途写失败时先写的可能已更新）
//   恰好 `--check`    = 只读比对：对每份文件逐一做换行归一化（CRLF/LF 视为相同）
//                       后与重渲染比对；任一缺失/过期 ⇒ 非零退出，绝不修复、绝不
//                       创建（文件原始字节不变）
//   其他任何参数      = 非零退出，不生成、不写入、不检查（如 --wat、--check --check）
//
// Usage: npm run gen:surface               （写出全部生成文件）
//        npm run gen:surface -- --check    （只读比对）
//
// 回归：test/process/genSurfaceEntry.test.js（真实子进程钉住全部场景，含直接
// 运行纯库/-e 伪装 argv 的零动作反例）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generate, generateUsageMap, USAGE_MD } from "./gen-surface.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.length === 0) {
  // 生成分支：先完整派生两份内容（generate() 抛错 ⇒ 未写任何字节即非零退出，
  // 旧文件原样），全部成功后才落盘。
  const files = await generate();
  for (const [rel, content] of Object.entries(files)) {
    const target = join(REPO_ROOT, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    console.log(`[gen-surface] wrote ${rel} (${Buffer.byteLength(content, "utf8")} bytes)`);
  }
  // docs/usage.md 不是整文件生成：只重写一对标记之间的页表区域（其余正文手写，
  // 原样保留；决定 0115）。内容未变就不落盘（字节与 mtime 都不动）。
  const usageTarget = join(REPO_ROOT, USAGE_MD);
  const usageNext = generateUsageMap(REPO_ROOT);
  if (usageNext !== readFileSync(usageTarget, "utf8")) {
    writeFileSync(usageTarget, usageNext, "utf8");
    console.log(`[gen-surface] rewrote ${USAGE_MD} page table (generated from page frontmatter)`);
  } else {
    console.log(`[gen-surface] ${USAGE_MD} page table is up to date`);
  }
} else if (args.length === 1 && args[0] === "--check") {
  // 只读比对分支：两份逐一检查（都检查完才退出，让一次运行报出全部漂移）；
  // CRLF/LF 归一化后须逐字相同——`.gitattributes` 已钉 docs/surface/*.md eol=lf。
  const files = await generate();
  let failed = false;
  for (const [rel, content] of Object.entries(files)) {
    const target = join(REPO_ROOT, rel);
    let onDisk;
    try {
      onDisk = readFileSync(target, "utf8");
    } catch {
      console.error(`[gen-surface] ${rel} does not exist — run npm run gen:surface and commit the output`);
      failed = true;
      continue;
    }
    if (onDisk.replace(/\r\n/g, "\n") !== content) {
      console.error(`[gen-surface] ${rel} is stale — run npm run gen:surface and commit the output`);
      failed = true;
      continue;
    }
    console.log(`[gen-surface] ${rel} is up to date (${Buffer.byteLength(content, "utf8")} bytes)`);
  }
  // docs/usage.md 页表区域同样有新鲜度契约（区域生成、正文手写）。
  const usageTarget = join(REPO_ROOT, USAGE_MD);
  let usageOnDisk;
  try {
    usageOnDisk = readFileSync(usageTarget, "utf8");
  } catch {
    console.error(`[gen-surface] ${USAGE_MD} does not exist — run npm run gen:surface and commit the output`);
    failed = true;
  }
  if (usageOnDisk !== undefined) {
    const usageNext = generateUsageMap(REPO_ROOT).replace(/\r\n/g, "\n");
    if (usageOnDisk.replace(/\r\n/g, "\n") !== usageNext) {
      console.error(`[gen-surface] ${USAGE_MD} page table is stale — run npm run gen:surface and commit the output`);
      failed = true;
    } else {
      console.log(`[gen-surface] ${USAGE_MD} page table is up to date`);
    }
  }
  if (failed) process.exit(1);
} else {
  console.error(`[gen-surface] unexpected arguments (${args.join(" ")}) — usage: npm run gen:surface [-- --check]`);
  process.exit(1);
}
