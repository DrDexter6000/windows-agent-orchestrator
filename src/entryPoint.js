// src/entryPoint.js
//
// 判断一个模块是不是本进程的入口脚本（`node <文件>` 启动的那个）。两边都取真实路径
// 再比（经 junction 或符号链接启动也认得出），Windows 上不分大小写。路径解析不了
// 时退回逐字的 URL 比较。仍判断不出来（没有入口脚本，例如 `node --eval`）时返回
// 调用方给的 ifUnknown：CLI 给 true（宁可执行，不静默失效）；后台子进程与 MCP stdio
// 服务给 false（没有入口脚本时绝不跑 main）。

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * @param {string} moduleUrl 调用方的 import.meta.url
 * @param {{ ifUnknown: boolean, entryPath?: string }} options
 * @returns {boolean}
 */
export function isEntryModule(moduleUrl, { ifUnknown, entryPath = process.argv[1] }) {
  if (typeof ifUnknown !== "boolean") throw new TypeError("isEntryModule: ifUnknown must be a boolean");
  if (typeof entryPath !== "string" || entryPath.length === 0) return ifUnknown;
  try {
    const canonical = (p) => {
      const real = realpathSync.native(resolve(p));
      return process.platform === "win32" ? real.toLowerCase() : real;
    };
    return canonical(entryPath) === canonical(fileURLToPath(moduleUrl));
  } catch {
    try {
      if (pathToFileURL(resolve(entryPath)).href === moduleUrl) return true;
    } catch { /* 连 URL 都构造不出来 */ }
    return ifUnknown;
  }
}
