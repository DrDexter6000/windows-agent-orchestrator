// test/isolation-infra/transcriptPathGuard.test.js
//
// TD-190 D0 守卫（gitChildEnvGuard 同款扫源纪律）：所有按 runId 定位
// `<runDir>/<runId>.jsonl` 转录文件的代码必须经 src/transcript.js 的
// transcriptPathFor 唯一入口——扫源断言，模块内重新出现
// join 别名、裸模板拼名、readdir + .jsonl 枚举旁路即红。
// 项目分桶布局（TD-190 Owner 裁定形态）落地时只改 transcript.js 一处。
//
// 不在模式面的形状（合法保留）：
//  - join(runDir, SUBDIR, `${runId}.jsonl`) 三参子目录形（cert drill 转录
//    子目录是独立布局，非根转录路径）；
//  - 非转录 jsonl（ALERTS.log 伴生、consult 组记录等按其它文件名构造）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { transcriptPathFor, listTranscriptFiles } from "../../src/transcript.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(REPO_ROOT, "src");

// 标识符 / 内联 resolve；容忍 join 别名前缀、大小写和换行。
const BYPASS_RE = /\b[A-Za-z0-9_]*join\(\s*(?:resolve\([A-Za-z0-9_.$[\]]+\)|[A-Za-z0-9_.$[\]]+)\s*,\s*`\$\{[^}]+}\.jsonl`\s*\)/gi;
const SUBDIR_RE = /\b[A-Za-z0-9_]*join\(\s*[^,;\n]+,\s*[^,;\n]+,\s*(`(?:\\[\s\S]|[^`\\])*`\s*)\)/gi;
const TEMPLATE_RE = /`(?:\\[\s\S]|[^`\\])*`/g;
// 精确文件 + 模板例外，必须逐条说明理由；当前为空。
const BARE_TEMPLATE_ALLOWLIST = [];

// 保留字符串/模板，去除注释；所有替换保持字符偏移和行号。
const NON_CODE_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g;
function blank(text) {
  return text.replace(/[^\n]/g, " ");
}

function withoutComments(source) {
  return source.replace(NON_CODE_RE, (token) => token.startsWith("/") ? blank(token) : token);
}

function pathBypasses(source, rel) {
  if (rel === "src/transcript.js") return [];
  const code = withoutComments(source);
  const subdirTemplates = new Set();
  for (const match of code.matchAll(SUBDIR_RE)) {
    subdirTemplates.add(match.index + match[0].indexOf(match[1]));
  }
  const offsets = new Set([...code.matchAll(BYPASS_RE)].map((m) => m.index));
  for (const match of code.matchAll(TEMPLATE_RE)) {
    // 诊断文案中提到路径不是拼名：只扫描以 .jsonl 结尾的模板。
    if (!/\$\{[\s\S]+?\}[\s\S]*\.jsonl`$/.test(match[0])) continue;
    if (subdirTemplates.has(match.index)) continue;
    if (BARE_TEMPLATE_ALLOWLIST.some((entry) => entry.file === rel && entry.template === match[0])) continue;
    offsets.add(match.index);
  }
  return [...new Set([...offsets].map((offset) => code.slice(0, offset).split("\n").length))];
}

function enumerationBypasses(source, rel) {
  if (rel === "src/transcript.js") return [];
  const code = withoutComments(source);
  const structure = code.replace(NON_CODE_RE, blank);
  // 具名/匿名 function 与块体箭头函数。按平衡花括号截取函数体，避免把
  // 同文件的 owner 枚举与另一个函数里的 .jsonl 拼在一起；无需 AST 依赖。
  const functions = /\bfunction\b[^{};]*\{|(?:\([^{};]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
  const offenders = [];
  for (const match of structure.matchAll(functions)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < structure.length && depth; end++) {
      if (structure[end] === "{") depth++;
      else if (structure[end] === "}") depth--;
    }
    const body = code.slice(start, end - 1);
    const calls = structure.slice(start, end - 1);
    if (/\breaddir(?:Sync)?\s*\(/.test(calls)
        && /\.jsonl/.test(body)
        && !/\blistTranscriptFiles\s*\(/.test(calls)) {
      offenders.push(code.slice(0, match.index).split("\n").length);
    }
  }
  return [...new Set(offenders)];
}

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
    for (const line of pathBypasses(src, rel)) {
      offenders.push(`${rel}:${line}: ${src.split("\n")[line - 1].trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], `根转录路径不得绕过 transcriptPathFor 构造：\n${offenders.join("\n")}`);
});

test("TD-190 D0 守卫: 转录枚举必须经 listTranscriptFiles（函数体扫源）", () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");
    for (const line of enumerationBypasses(readFileSync(file, "utf8"), rel)) {
      offenders.push(`${rel}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], `转录枚举不得绕过 listTranscriptFiles：\n${offenders.join("\n")}`);
});

test("TD-190 D0 守卫自测: join 别名/裸模板必红，三参子目录/注释合法", () => {
  const rel = "src/example.js";
  for (const source of [
    'const file = _pathJoin(runDir, `${runId}.jsonl`);',
    'const file = JOIN(resolve(runDir), `${runId}.jsonl`);',
    'const file = `${runId}.jsonl`;',
    'const file = `prefix_${run.id}.jsonl`;',
    'const file = _pathJoin(\n runDir,\n `${runId}.jsonl`\n);',
  ]) {
    assert.ok(pathBypasses(source, rel).length > 0, source);
  }
  for (const source of [
    'const file = join(runDir, SUBDIR, `${runId}.jsonl`);',
    'const file = _pathJoin(runDir, SUBDIR, `${runId}.jsonl`);',
    '// const file = `${runId}.jsonl`;',
    '/* const file = _pathJoin(runDir, `${runId}.jsonl`); */',
    'const file = transcriptPathFor(runDir, runId);',
    'throw new Error(`missing: runs/${runId}.jsonl (not found)`);',
  ]) {
    assert.deepEqual(pathBypasses(source, rel), [], source);
  }
  assert.deepEqual(pathBypasses('return join(runDir, `${runId}.jsonl`);', "src/transcript.js"), []);
  assert.deepEqual(BARE_TEMPLATE_ALLOWLIST, []);
});

test("TD-190 D0 守卫自测: 四个漏网枚举形状必红，owner 枚举不误报", () => {
  const rel = "src/example.js";
  const cases = [
    'function scanResumableRuns(runDir) { const files = readdirSync(runDir); for (const file of files) { if (!file.endsWith(".jsonl")) continue; } }',
    'function scanAllRuns(runDir) { const files = readdirSync(runDir); for (const file of files) { if (!file.endsWith(".jsonl")) continue; } }',
    'function scanRunFiles(runDir) { return readdirSync(runDir).filter(f => f.startsWith("run_") && f.endsWith(".jsonl")).sort(); }',
    'async function loadRunFiles(runDir) { const files = await readdir(runDir); return sortRunFileNames(files.filter(f => f.endsWith(".jsonl"))); }',
    'const scan = (runDir) => { return readdirSync(runDir).filter(f => f.endsWith(".jsonl")); };',
  ];
  for (const source of cases) assert.deepEqual(enumerationBypasses(source, rel), [1], source);
  const owner = 'function scanOwnerLeaseCandidates(runDir) { return readdirSync(runDir).filter(f => f.startsWith(".owner-")); }';
  for (const source of [
    owner,
    `${owner}\nfunction scanRunFiles(runDir) { return listTranscriptFiles(runDir).filter(f => f.startsWith("run_")); }`,
    `${owner}\nfunction fileName(file) { return file.endsWith(".jsonl"); }`,
    'function scan(runDir) { /* readdirSync(runDir); .jsonl */ return []; }',
  ]) assert.deepEqual(enumerationBypasses(source, rel), [], source);
  assert.deepEqual(enumerationBypasses(cases[0], "src/transcript.js"), []);
});

test("TD-190 D0: listTranscriptFiles 只过滤 .jsonl 并保持目录原序", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-transcript-files-"));
  try {
    for (const name of ["run_z.jsonl", "wf_a.jsonl", "other.jsonl", ".owner-run_z", "run_a.jsonl", "upper.JSONL", "note.txt"]) {
      writeFileSync(join(dir, name), "");
    }
    assert.deepEqual(listTranscriptFiles(dir), readdirSync(dir).filter((name) => name.endsWith(".jsonl")));
    assert.throws(() => listTranscriptFiles(join(dir, "missing")), { code: "ENOENT" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TD-190 D0: transcriptPathFor 形状钉（与既有惯用法字节兼容）", () => {
  assert.equal(transcriptPathFor("D:/x/runs", "run_abc"), "D:\\x\\runs\\run_abc.jsonl");
  assert.equal(
    transcriptPathFor("runs", "run_1"),
    join("runs", "run_1.jsonl"),
    "行为与被替换的 join(dir, `${runId}.jsonl`) 惯用法一致（D0 行为零变化承诺）",
  );
});
