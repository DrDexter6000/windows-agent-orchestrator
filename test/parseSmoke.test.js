// parseSmoke.test.js
//
// JS 语法/解析冒烟守卫（dogfood 真实任务复盘 P0，2026-07-08）。
//
// 背景：frictionLog.js 块注释里出现字面量 `*/`（`dogfood-*/日期`）导致整文件
// 解析失败，阻断所有派工（declare/run 全挂）。`node --check` 能抓这类错误，
// 但 WAO 没有跑它——测试只跑 import（绕过 guardBypass），不覆盖裸 parse。
//
// 本守卫：对 src/ 下所有 .js 跑 `node --check`，防注释/语法错误漏到运行时。
// 这是 🟢 工具域——机械检查，单一正确答案（要么 parse 要么不 parse）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/** 递归收集 src/ 下所有 .js 文件（不含 node_modules）。 */
function collectJsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectJsFiles(full, acc);
    } else if (entry.endsWith(".js")) {
      acc.push(full);
    }
  }
  return acc;
}

test("parse smoke: src/ 下所有 .js 文件能被 node --check 解析（防注释/语法错误阻断派工）", () => {
  const files = collectJsFiles(join(ROOT, "src"));
  assert.ok(files.length > 0, "src/ 下应至少有 1 个 .js 文件");

  const failures = [];
  for (const file of files) {
    // node --check 只做语法解析不执行，快且安全。
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) {
      failures.push({
        file: file.replace(ROOT + "\\", "").replace(/\\/g, "/"),
        error: (result.stderr || "").split("\n")[0], // 首行错误信息
      });
    }
  }

  if (failures.length > 0) {
    const detail = failures.map((f) => `  ${f.file}: ${f.error}`).join("\n");
    assert.fail(
      `${failures.length} 个 src/ 文件解析失败（会导致运行时阻断）：\n${detail}\n` +
      `常见原因：块注释里出现字面量 */ 提前闭合注释（如 'dogfood-*/日期'）。`
    );
  }
});
