// src/entryPoint.js
//
// 判断一个模块是不是本进程的入口脚本（`node <文件>` 启动的那个）；被别的模块
// import 时不是。两边都取真实路径再比（经 junction、符号链接或 8.3 短路径启动都
// 认得出），Windows 上不分大小写。判断不出来时（没有入口脚本，或路径解析失败）
// 返回调用方给的 ifUnknown：CLI 给 true（宁可执行，不静默失效）；后台子进程给
// false（被 import 时绝不跑 main）。

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} moduleUrl 调用方的 import.meta.url
 * @param {{ ifUnknown: boolean, entryPath?: string }} options
 * @returns {boolean}
 */
export function isEntryModule(moduleUrl, { ifUnknown, entryPath = process.argv[1] }) {
  if (typeof entryPath !== "string" || entryPath.length === 0) return ifUnknown;
  try {
    const canonical = (p) => {
      const real = realpathSync.native(resolve(p));
      return process.platform === "win32" ? real.toLowerCase() : real;
    };
    return canonical(entryPath) === canonical(fileURLToPath(moduleUrl));
  } catch {
    return ifUnknown;
  }
}
