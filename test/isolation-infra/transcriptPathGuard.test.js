// test/isolation-infra/transcriptPathGuard.test.js
//
// TD-190 D0 守卫（gitChildEnvGuard 同款扫源纪律）：所有按 runId 定位
// `<runDir>/<runId>.jsonl` 转录文件的代码必须经 src/transcript.js 的
// transcriptPathFor 唯一入口——扫源断言，模块内重新出现
// `join(<dir>, \`<runId>.jsonl\`)` 惯用法即红（含内联 resolve 形）。
// 项目分桶布局（TD-190 Owner 裁定形态）落地时只改 transcript.js 一处。
//
// 不在模式面的形状（合法保留）：
//  - join(runDir, SUBDIR, `${runId}.jsonl`) 三参子目录形（cert drill 转录
//    子目录是独立布局，非根转录路径）；
//  - 非转录 jsonl（ALERTS.log 伴生、consult 组记录等按其它文件名构造）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { transcriptPathFor } from "../../src/transcript.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(REPO_ROOT, "src");

// 与 codemod（.dev/codemod-transcript-path.mjs）同款两形状：标识符 / 内联 resolve。
const BYPASS_RE = /join\((?:resolve\([A-Za-z0-9_.$[\]]+\)|[A-Za-z0-9_.$[\]]+), `\$\{[A-Za-z0-9_.$[\]]+}\.jsonl`\)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("TD-190 D0 守卫: 根转录路径构造必须经 transcriptPathFor（扫源零旁路）", () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
    if (rel === "src/transcript.js") continue; // 唯一入口自身的实现
    const src = readFileSync(file, "utf8");
    // 逐行归因，跳过纯注释行
    for (const [idx, line] of src.split("\n").entries()) {
      if (BYPASS_RE.test(line) && !line.trim().startsWith("//")) {
        offenders.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `根转录路径不得绕过 transcriptPathFor 构造：\n${offenders.join("\n")}`);
});

test("TD-190 D0: transcriptPathFor 形状钉（与既有惯用法字节兼容）", () => {
  assert.equal(transcriptPathFor("D:/x/runs", "run_abc"), "D:\\x\\runs\\run_abc.jsonl");
  assert.equal(
    transcriptPathFor("runs", "run_1"),
    join("runs", "run_1.jsonl"),
    "行为与被替换的 join(dir, `${runId}.jsonl`) 惯用法一致（D0 行为零变化承诺）",
  );
});
