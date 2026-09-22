#!/usr/bin/env node
// scripts/gen-certification-cli.mjs
//
// 薄入口（2026-09-22 收束包拆分）——docs/surface/certification.md 的唯一进程入口。
// 渲染逻辑全部在纯库 scripts/gen-certification.mjs（renderCertification()，导入
// 零副作用、零入口探测）；本文件只做参数分发与文件 IO，不判断自身身份（无
// import.meta.main / argv[1] 比对 / realpath-ino 判定——那些是本包删除的对象）。
//
// 参数合同（恰好三种形状，其他一切非零退出且不写入不检查）：
//   无参数            = 生成：写出 docs/surface/certification.md（渲染失败 ⇒ 非零退出、旧文件原样）
//   恰好 `--check`    = 只读比对：换行归一化（CRLF/LF 视为相同）后与重渲染一致 ⇒ exit 0；
//                       缺失/过期 ⇒ 非零退出，绝不修复、绝不创建（文件原始字节不变）
//   其他任何参数      = 非零退出，不写入、不检查（如 --wat、--check --check、-- --check）
//
// Usage: npm run gen:certification            （写出文件）
//        npm run gen:certification -- --check （只读比对）
//
// 回归：test/process/genCertificationEntry.test.js（真实子进程钉住全部场景，含
// import/-e 伪装 argv 的零动作反例）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderCertification } from "./gen-certification.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CERTIFICATION_MD = "docs/surface/certification.md";
const target = join(REPO_ROOT, CERTIFICATION_MD);

const args = process.argv.slice(2);

if (args.length === 0) {
  // 生成分支：渲染先行（渲染抛错 ⇒ 未写任何字节即非零退出，旧文件原样）。
  const rendered = renderCertification();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rendered, "utf8");
  console.log(`[gen-certification] wrote ${CERTIFICATION_MD} (${Buffer.byteLength(rendered, "utf8")} bytes)`);
} else if (args.length === 1 && args[0] === "--check") {
  // 只读比对分支：与磁盘比较前先重渲染（同旧库行为）；CRLF/LF 归一化后须逐字相同。
  const rendered = renderCertification();
  let onDisk;
  try {
    onDisk = readFileSync(target, "utf8");
  } catch {
    console.error(`[gen-certification] ${CERTIFICATION_MD} does not exist — run npm run gen:certification and commit the output`);
    process.exit(1);
  }
  if (onDisk.replace(/\r\n/g, "\n") !== rendered) {
    console.error(`[gen-certification] ${CERTIFICATION_MD} is stale — run npm run gen:certification and commit the output`);
    process.exit(1);
  }
  console.log(`[gen-certification] ${CERTIFICATION_MD} is up to date (${Buffer.byteLength(rendered, "utf8")} bytes)`);
} else {
  console.error(`[gen-certification] unexpected arguments (${args.join(" ")}) — usage: npm run gen:certification [-- --check]`);
  process.exit(1);
}
