// test/isolation-infra/controlBytes.test.js
//
// 被跟踪的文本文件里不得混进控制字节。它们在编辑器和 diff 里不可见，只有按字节扫才
// 发现：2026-10-30 第 49 批，worker 写的测试正则里 `\b` 落成了退格字节（0x08），那条
// 断言永远不会失败而全量照绿；同日普查又在 src/application/identityProjection.js 里找到
// 两个字面 NUL（本应写成 \u0000 转义）。
//
// 规则：`git ls-files` 列出的文件（二进制扩展名除外）必须是合法 UTF-8，且不含 TAB、LF、
// CR 以外的 C0 控制字符、DEL、C1 控制字符（U+0080..U+009F）。要表达这些字符，源码里写
// 转义。BOM（U+FEFF）不是控制字符，不在检查面。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// 二进制文件不按文本扫。仓库目前没有这类文件；加入时把扩展名登记在这里。
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf", ".zip", ".gz", ".woff", ".woff2"]);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

test("被跟踪的文本文件是合法 UTF-8，且不含控制字节（TAB/LF/CR 以外的 C0、DEL、C1）", (t) => {
  // 只有不在 git 检出里（例如解开的发布包）才跳过；git 本身出错时让测试失败，不当跳过。
  if (!existsSync(join(ROOT, ".git"))) {
    t.skip("not a git checkout");
    return;
  }
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(files.length > 0, "git ls-files 没有列出任何文件");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hits = [];
  for (const rel of files) {
    if (BINARY_EXTENSIONS.has(extname(rel).toLowerCase())) continue;
    let bytes;
    try {
      bytes = readFileSync(join(ROOT, rel));
    } catch (e) {
      if (e?.code === "ENOENT") continue; // 工作树里已删除、尚未提交删除的跟踪文件
      hits.push(`${rel} unreadable (${e?.code ?? "error"})`);
      continue;
    }
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      hits.push(`${rel} not valid UTF-8`);
      continue;
    }
    text.split("\n").forEach((line, i) => {
      const codes = [...new Set([...line.matchAll(CONTROL)]
        .map((m) => `U+${m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`))];
      if (codes.length > 0) hits.push(`${rel}:${i + 1} ${codes.join(",")}`);
    });
  }
  assert.deepEqual(hits, [], `这些位置混进了控制字节或不是 UTF-8，源码里请写转义（如 \\b、\\u0000）：\n${hits.join("\n")}`);
});
