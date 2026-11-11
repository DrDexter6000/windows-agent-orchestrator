// cliEntryGuard.test.js
//
// 入口判断（src/entryPoint.js）：src/cli.js 与四个后台子进程模块只在被当作入口运行时
// 执行 main。cli.js 从前 import 即执行：无参 main 在若干事件轮次后打印帮助，帮助落进
// 别的测试的 console 捕获窗口时，那条测试就 JSON 解析失败（TD-194 的一种首轮红）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isEntryModule } from "../../src/entryPoint.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "src", "cli.js");
const SEMVER = /^\d+\.\d+\.\d+/;

test("isEntryModule: 本文件为真（Windows 上大小写不同也认），别的文件为假；判断不出来时返回调用方给的 ifUnknown", () => {
  const cliUrl = pathToFileURL(CLI).href;
  for (const ifUnknown of [true, false]) {
    assert.equal(isEntryModule(cliUrl, { ifUnknown, entryPath: CLI }), true);
    assert.equal(isEntryModule(cliUrl, { ifUnknown, entryPath: fileURLToPath(import.meta.url) }), false);
    assert.equal(isEntryModule(cliUrl, { ifUnknown, entryPath: "" }), ifUnknown, "没有入口脚本（真实的 node --eval 见下一条）");
    assert.equal(isEntryModule(cliUrl, { ifUnknown, entryPath: join(ROOT, "src", "no-such-entry.js") }), ifUnknown, "路径解析不了");
    if (process.platform === "win32") assert.equal(isEntryModule(cliUrl, { ifUnknown, entryPath: CLI.toUpperCase() }), true);
  }
});

// 四个后台子进程模块被当作入口才跑 main；被 import 时（含 node --eval 这种没有入口
// 脚本的场合）不跑 main、不抛错。
const BACKGROUND_MODULES = [
  join(ROOT, "src", "backgroundRunner.js"),
  join(ROOT, "src", "daemon.js"),
  join(ROOT, "src", "daemonSupervisor.js"),
  join(ROOT, "src", "backends", "kimiServeIdleWatch.js"),
];

test("四个后台子进程模块在没有入口脚本时（node --eval）可以被 import，不跑 main、不抛错", () => {
  for (const file of BACKGROUND_MODULES) {
    const code = `await import(${JSON.stringify(pathToFileURL(file).href)}); console.log("IMPORTED");`;
    const r = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "IMPORTED", file);
    assert.doesNotMatch(r.stderr, /error/i, file);
  }
});

test("src 里的入口判断都经 isEntryModule：不再有拿 argv[1] 直接拼 URL 比较的写法", () => {
  const r = spawnSync("git", ["grep", "-n", "-F", "pathToFileURL(process.argv[1])", "--", "src"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "", r.stdout);
  for (const file of [CLI, ...BACKGROUND_MODULES]) {
    assert.match(readFileSync(file, "utf8"), /isEntryModule\(import\.meta\.url, \{ ifUnknown: (true|false) \}\)/, file);
  }
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
