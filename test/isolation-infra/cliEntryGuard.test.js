// cliEntryGuard.test.js
//
// src/cli.js 只在被当作入口运行时执行 main。从前 import 即执行：无参 main 在若干
// 事件轮次后打印帮助，帮助落进别的测试的 console 捕获窗口时，那条测试就 JSON
// 解析失败（TD-194 的一种首轮红）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { invokedAsEntry } from "../../src/cli.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "cli.js");
const SEMVER = /^\d+\.\d+\.\d+/;

test("invokedAsEntry: 本文件为真（Windows 上大小写不同也认），别的文件为假；缺入口或路径解析不了时照旧执行", () => {
  assert.equal(invokedAsEntry(CLI, CLI), true);
  assert.equal(invokedAsEntry(fileURLToPath(import.meta.url), CLI), false);
  assert.equal(invokedAsEntry("", CLI), true);
  assert.equal(invokedAsEntry(join(ROOT, "src", "no-such-entry.js"), CLI), true);
  if (process.platform === "win32") assert.equal(invokedAsEntry(CLI.toUpperCase(), CLI), true);
});

test("import src/cli.js 不执行 main：子进程只输出自己的标记，不打印帮助", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-cli-import-"));
  try {
    const script = join(dir, "importer.mjs");
    writeFileSync(script, `await import(${JSON.stringify(pathToFileURL(CLI).href)});\nconsole.log("IMPORTED");\n`);
    const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "IMPORTED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("直接运行 src/cli.js 照常执行 main：相对路径与经 junction 的路径都打印版本", () => {
  const rel = spawnSync(process.execPath, ["src/cli.js", "--version"], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  assert.equal(rel.status, 0, rel.stderr);
  assert.match(rel.stdout.trim(), SEMVER);

  const dir = mkdtempSync(join(tmpdir(), "wao-cli-link-"));
  const link = join(dir, "src-link");
  try {
    symlinkSync(join(ROOT, "src"), link, "junction");
    const viaLink = spawnSync(process.execPath, [join(link, "cli.js"), "--version"], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.match(viaLink.stdout.trim(), SEMVER);
  } finally {
    // 先拆链接本身，确认拆掉了才删临时目录，绝不经链接递归删到仓库的 src。
    try { unlinkSync(link); } catch { /* 链接没建成 */ }
    if (!existsSync(link)) rmSync(dir, { recursive: true, force: true });
  }
});
