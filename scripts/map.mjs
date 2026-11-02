#!/usr/bin/env node
// scripts/map.mjs
//
// 薄入口（照 gen-surface-cli.mjs 的同款拆分）——`npm run map` 的唯一进程入口。
// 扫描与分档逻辑全部在纯库 scripts/map-lib.mjs；本文件只做参数分发与文件 IO，
// 不判断自身身份。
//
// 参数合同（恰好两种形状，其他一切非零退出且不写任何文件）：
//   无参数          = 人读报告：跟踪文件数、各类边数、各档计数，以及"完全不可达
//                     / 只经弱边可达 / 只经中边可达"三张清单（每行路径与上一跳）
//   恰好 `--json`   = 完整的边与档位 JSON（stdout，不写文件）
//   其他任何参数    = 非零退出
//
// Usage: npm run map            （人读报告）
//        npm run --silent map -- --json  （完整边与档位；--silent 去掉 npm 的命令回显，stdout 才是纯 JSON）
//
// 回归：test/isolation-infra/workflowReachability.test.js（守卫硬层 + 库的逐类边检查）。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWorkflowGraph, CONVENTION_FILES, ENTRY_FILES, isTextFile } from "./map-lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (!(args.length === 0 || (args.length === 1 && args[0] === "--json"))) {
  console.error(`[map] unexpected arguments (${args.join(" ")}) — usage: npm run map [-- --json]`);
  process.exit(1);
}

const tracked = execFileSync("git", ["-c", "core.quotepath=off", "ls-files"], {
  cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1 << 28,
}).split("\n").filter(Boolean);
const { edges, edgeCounts, nodes } = buildWorkflowGraph({
  files: tracked,
  readFile: (f) => {
    if (!isTextFile(f)) return null;
    try {
      return readFileSync(join(REPO_ROOT, f), "utf8");
    } catch {
      return null; // 工作树里已删除、尚未提交删除的跟踪文件
    }
  },
});

if (args[0] === "--json") {
  console.log(JSON.stringify({
    entries: ENTRY_FILES,
    conventions: CONVENTION_FILES,
    tracked: nodes.length,
    edgeCounts,
    edges,
    nodes,
  }, null, 1));
} else {
  const count = (tier) => nodes.filter((n) => n.tier === tier).length;
  const list = (tier) => nodes.filter((n) => n.tier === tier);
  console.log(
    `tracked ${nodes.length}; edges ${edges.length} ${JSON.stringify(edgeCounts)}; `
    + `strong ${count("strong")}, medium-only ${count("medium-only")}, weak-only ${count("weak-only")}, `
    + `unreachable ${count("unreachable")}, convention ${count("convention")} (exempt)`,
  );
  const sections = [
    ["## 完全不可达（从任何入口都没有路径）", list("unreachable")],
    ["## 只经弱边可达（只有文档提到它的目录）", list("weak-only")],
    ["## 只经中边可达（只有代码按目录加载或裸文件名引用）", list("medium-only")],
  ];
  for (const [header, tierNodes] of sections) {
    console.log(`\n${header}`);
    if (tierNodes.length === 0) console.log("  (none)");
    for (const n of tierNodes) {
      console.log(n.via === null ? `  ${n.path}` : `  ${n.path}  <- ${n.via} (${n.viaType})`);
    }
  }
}
