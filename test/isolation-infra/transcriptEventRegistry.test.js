// test/isolation-infra/transcriptEventRegistry.test.js
//
// 转录事件登记守卫（登记表 = src/transcriptEvents.js）。
//
// 被钉合同（主守卫是 src/transcript.js 里所有写出口共用的序列化入口，
// 每次写出前查登记表；本测试钉它的行为与登记表自身的形状）：
//   - 严格模式（WAO_TRANSCRIPT_EVENT_STRICT=1，canonical runner 与 test-one
//     经 buildCanonicalChildEnv 对全部套件子进程显式设置）：写出未登记类型
//     立即抛错（事件不落盘），并记进本进程违规清单；退出钩子在清单非空时
//     把违规类型打到 stderr 并置非零退出码——被 .catch(() => {}) 吞掉的
//     写出（观察截止、上游会话释放等）靠这一步让该测试文件红。
//   - 非 strict（生产默认）：绝不丢弃/拒绝/推迟事件，照常写盘，每种类型
//     至多警告一次。
//   - 夹具豁免：构造 JsonlTranscript 时经 syntheticEventTypes 点名的合成
//     类型（仅该实例）放行；不是目录级/全局宽松开关。
//   - 第二道检查（补充，非主守卫）：静态读 src/**，把字面量 append("…")、
//     type: "…" 与已知事件常量的值逐个对照登记表。run.message 不是落盘
//     事件（scorecard 临时形状），显式排除——它不能被当成漏登。
//
// process 组：严格/非严格行为经真实子进程验证（spawnSync node，临时脚本与
// 转录文件都在 os.tmpdir() 下，显式绝对路径，用后即删）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TRANSCRIPT_EVENT_REGISTRY, TRANSCRIPT_EVENT_TYPES, isRegisteredTranscriptEventType } from "../../src/transcriptEvents.js";
import { PROCESS_MISSING_CONFIRMED_TYPE } from "../../src/transcript.js";
import { ACCEPTANCE_EVENT_TYPE } from "../../src/application/acceptanceRecord.js";
import {
  LEAD_COMMIT_CHECK_STARTED_TYPE,
  LEAD_COMMIT_CHECK_OUTCOME_TYPE,
} from "../../src/application/runVerifyCommit.js";
import { PROVIDER_SESSION_BOUND_EVENT } from "../../src/application/sessionReuse.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TRANSCRIPT_JS_URL = pathToFileURL(join(REPO_ROOT, "src", "transcript.js")).href;
const SPAWN_OPTS = { encoding: "utf8", timeout: 120_000, windowsHide: true };

/**
 * 在 os.tmpdir() 下生成一个真实子进程场景：写一段 import src/transcript.js
 * 的 ESM 脚本，spawn node 执行，返回 { status, stdout, stderr, onDisk }。
 * onDisk 是子进程退出后转录文件的原始字节（已不存在也要能断言——目录在
 * 返回前清理）。strict 参数显式决定子进程环境里 WAO_TRANSCRIPT_EVENT_STRICT
 * 的有无——测试本身可能已在 strict 环境下运行，非 strict 子进程必须先剔除
 * 继承值。
 */
function runChild(label, body, { strict }) {
  const dir = mkdtempSync(join(tmpdir(), `wao-evt-registry-${label}-`));
  const scriptPath = join(dir, "child.mjs");
  const transcriptFile = join(dir, "run.jsonl");
  const script = [
    `import { JsonlTranscript } from ${JSON.stringify(TRANSCRIPT_JS_URL)};`,
    `const FILE = ${JSON.stringify(transcriptFile)};`,
    body,
    "",
  ].join("\n");
  writeFileSync(scriptPath, script, "utf8");
  const env = { ...process.env };
  delete env.WAO_TRANSCRIPT_EVENT_STRICT;
  if (strict) env.WAO_TRANSCRIPT_EVENT_STRICT = "1";
  try {
    const r = spawnSync(process.execPath, [scriptPath], { env, cwd: dir, ...SPAWN_OPTS });
    assert.ok(!r.error, `${label}: spawn error = ${r.error}`);
    assert.equal(r.signal, null, `${label}: signal 应为 null`);
    let onDisk = null;
    try {
      onDisk = readFileSync(transcriptFile, "utf8");
    } catch { /* 子进程可能从未写出转录文件 */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, onDisk };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 登记表形状（纯） ─────────────────────────────────────────────────────────

test("registry-1: 登记表形状——冻结、无重复、说明非空、legacy 恰一、无通配、run.message 不登记", () => {
  assert.ok(Object.isFrozen(TRANSCRIPT_EVENT_REGISTRY), "登记表数组已冻结");
  const types = TRANSCRIPT_EVENT_REGISTRY.map((entry) => entry.type);
  assert.equal(new Set(types).size, types.length, "事件类型不得重复登记");
  for (const entry of TRANSCRIPT_EVENT_REGISTRY) {
    assert.ok(Object.isFrozen(entry), `${entry.type} 条目已冻结`);
    assert.match(entry.type, /^[a-z]+\.[a-z0-9_.]+$/, `${entry.type} 必须是具体事件名（不得通配）`);
    assert.equal(typeof entry.description, "string", `${entry.type} 必须有说明`);
    assert.ok(entry.description.length > 0, `${entry.type} 说明非空`);
    assert.ok(!entry.description.includes("\n"), `${entry.type} 说明单行`);
    assert.equal(typeof entry.legacy, "boolean", `${entry.type} legacy 是布尔`);
  }
  // 集合视图与登记表一一对应（查询入口与表体不漂移）。
  assert.equal(TRANSCRIPT_EVENT_TYPES.length, types.length);
  for (const type of types) assert.ok(TRANSCRIPT_EVENT_TYPES.includes(type));
  // 导出的名单改不动，也影响不到校验：校验用的集合是模块私有的。
  assert.ok(Object.isFrozen(TRANSCRIPT_EVENT_TYPES));
  assert.throws(() => TRANSCRIPT_EVENT_TYPES.push("run.registry_bypass_probe"), TypeError);
  assert.equal(isRegisteredTranscriptEventType("run.registry_bypass_probe"), false);
  // legacy：run.timed_out（无现行生产写出点，仅旧转录读取兼容）+ 四个 workflow.*
  // （决定 0094 退役 workflow 层后不再有写入方，读侧仍识别旧 wf_* 转录）。
  const legacy = TRANSCRIPT_EVENT_REGISTRY.filter((entry) => entry.legacy);
  assert.deepEqual(
    [...legacy.map((entry) => entry.type)].sort(),
    ["run.timed_out", "workflow.completed", "workflow.node.completed", "workflow.node.started", "workflow.started"],
  );
  // run.message 不是落盘事件类型（scorecard 临时形状），不登记——不是漏登。
  assert.ok(!TRANSCRIPT_EVENT_TYPES.includes("run.message"));
  // workflow 登记四个具体名字（全部 legacy），不登记通配。
  const workflow = types.filter((t) => t.startsWith("workflow."));
  assert.deepEqual(
    [...workflow].sort(),
    ["workflow.completed", "workflow.node.completed", "workflow.node.started", "workflow.started"],
  );
  for (const entry of workflow) {
    assert.equal(TRANSCRIPT_EVENT_REGISTRY.find((e) => e.type === entry).legacy, true,
      `${entry} 必须标 legacy（决定 0094 后无写入方）`);
  }
});

// ── 严格模式行为（真实子进程） ───────────────────────────────────────────────

test("registry-2: strict 下未登记类型立即抛错、不落盘；被 catch 后进程仍非零退出并点名", () => {
  const r = runChild("strict-throw", [
    "const t = new JsonlTranscript(FILE, { runId: 'r', agentId: 'a' });",
    "await t.append('run.started', {});",
    "try {",
    "  await t.append('run.probe_unregistered', { x: 1 });",
    "  console.log('NO-THROW');",
    "} catch (e) {",
    "  console.log('CAUGHT: ' + e.message.split('\\n')[0]);",
    "}",
    "console.log('DONE');",
  ].join("\n"), { strict: true });
  // 抛错发生在序列化（appendFile 之前）：合法事件照常在盘，违规事件不在盘。
  assert.equal(r.status, 1, `strict 子进程必须非零退出（stdout: ${r.stdout}）`);
  assert.match(r.stdout, /CAUGHT: unregistered transcript event type: "run\.probe_unregistered"/);
  assert.match(r.stdout, /DONE/, "catch 后脚本继续执行完毕");
  assert.match(r.stderr, /unregistered transcript event type\(s\) written under WAO_TRANSCRIPT_EVENT_STRICT=1: run\.probe_unregistered x1/);
  const onDisk = (r.onDisk ?? "").trim().split("\n").filter(Boolean);
  assert.equal(onDisk.length, 1, "只有合法事件落盘");
  assert.equal(JSON.parse(onDisk[0]).type, "run.started");
});

test("registry-3: strict 下被 .catch(() => {}) 吞掉的写出仍让进程非零退出（退出钩子路径）", () => {
  // 复刻生产里吞异常的写出形状（如观察截止的追加）：违规没有任何 await/
  // catch 观察，唯一红信号是退出码与 stderr。
  const r = runChild("strict-swallowed", [
    "const t = new JsonlTranscript(FILE, { runId: 'r', agentId: 'a' });",
    "t.append('run.probe_swallowed', {}).catch(() => {});",
    "await new Promise((res) => setTimeout(res, 50));",
    "console.log('CLEAN-EXIT-REACHED');",
  ].join("\n"), { strict: true });
  assert.equal(r.status, 1, `吞掉的写出必须让子进程非零退出（stdout: ${r.stdout}）`);
  assert.match(r.stdout, /CLEAN-EXIT-REACHED/, "脚本本身没有任何未捕获异常");
  assert.match(r.stderr, /run\.probe_swallowed x1/, "stderr 点名违规类型");
});

test("registry-4: 非 strict（生产默认）——照常写盘、退出码 0、每种类型只警告一次", () => {
  const r = runChild("nonstrict", [
    "const t = new JsonlTranscript(FILE, { runId: 'r', agentId: 'a' });",
    "await t.append('run.probe_unregistered', { kept: true });",
    "await t.append('run.probe_unregistered', { again: true });",
    "console.log('WROTE');",
  ].join("\n"), { strict: false });
  assert.equal(r.status, 0, `生产路径不得改变退出码（stderr: ${r.stderr}）`);
  assert.match(r.stdout, /WROTE/);
  const warns = r.stderr.match(/unregistered transcript event type written: run\.probe_unregistered/g) ?? [];
  assert.equal(warns.length, 1, `每种类型只警告一次（实际 ${warns.length} 次）`);
  const onDisk = (r.onDisk ?? "").trim().split("\n").filter(Boolean);
  assert.equal(onDisk.length, 2, "两条未登记事件都照常落盘（绝不丢弃）");
  assert.equal(JSON.parse(onDisk[0]).type, "run.probe_unregistered");
});

test("registry-5: syntheticEventTypes 点名豁免——仅该实例放行；未点名的兄弟实例仍拒", () => {
  const r = runChild("synthetic", [
    "const allowed = new JsonlTranscript(FILE, { runId: 'r', agentId: 'a', syntheticEventTypes: ['run.probe_synthetic'] });",
    "await allowed.append('run.probe_synthetic', { ok: 1 });",
    "console.log('SYNTHETIC-OK');",
    "const denied = new JsonlTranscript(FILE, { runId: 'r2', agentId: 'a' });",
    "try {",
    "  await denied.append('run.probe_synthetic', { ok: 1 });",
    "  console.log('DENIED-NO-THROW');",
    "} catch (e) {",
    "  console.log('DENIED-THREW');",
    "}",
  ].join("\n"), { strict: true });
  assert.match(r.stdout, /SYNTHETIC-OK/, "点名豁免的实例可写");
  assert.match(r.stdout, /DENIED-THREW/, "未点名的兄弟实例仍拒（不是全局开关）");
  // 点名实例写的合法；兄弟实例拒了 —— 但 DENIED 违规仍记进清单，进程非零。
  assert.equal(r.status, 1, "兄弟实例的违规仍使进程非零");
  assert.match(r.stderr, /run\.probe_synthetic x1/);
});

test("registry-6: syntheticEventTypes 形状拒绝——非字符串成员在构造期抛错", () => {
  const r = runChild("synthetic-shape", [
    "try {",
    "  new JsonlTranscript(FILE, { runId: 'r', agentId: 'a', syntheticEventTypes: ['ok', 42] });",
    "  console.log('NO-THROW');",
    "} catch (e) {",
    "  console.log('THREW');",
    "}",
  ].join("\n"), { strict: false });
  assert.match(r.stdout, /THREW/, "豁免名单的非法成员必须在构造期 fail-closed");
  assert.equal(r.status, 0, "构造期拒绝是普通错误，不涉违规清单");
});

// ── 第二道检查（补充）：src 字面量与已知常量都已登记 ────────────────────────

/** 递归收集 src/**.js（排除 owner-dashboard 资产桶——无 Node 代码语义）。 */
function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkJs(p, out);
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("registry-7: 第二道检查——src 字面量 append(…) / type: … 与已知事件常量全部已登记", () => {
  // 静态扫描只是补充（主守卫是运行时序列化）：抓的是"字面量可见"的写出面。
  const appendRe = /\.append\(\s*"([A-Za-z][A-Za-z0-9_.]*)"/g;
  const typeRe = /type:\s*"((?:run|session|prompt|scorecard|messages|acceptance|workflow)\.[A-Za-z0-9_.]+)"/g;
  // run.message 不是落盘事件类型（scorecard 临时形状）——显式排除，不算漏登。
  const EXCLUDED = new Set(["run.message"]);
  const found = new Map(); // type -> [file:line 证据]
  const record = (type, where) => {
    if (EXCLUDED.has(type)) return;
    if (!found.has(type)) found.set(type, []);
    found.get(type).push(where);
  };
  for (const abs of walkJs(join(REPO_ROOT, "src"))) {
    if (abs.includes(join("src", "owner-dashboard"))) continue;
    const rel = abs.slice(REPO_ROOT.length + 1).replaceAll("\\", "/");
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const m of line.matchAll(appendRe)) record(m[1], `${rel}:${index + 1}`);
      for (const m of line.matchAll(typeRe)) record(m[1], `${rel}:${index + 1}`);
    });
  }
  assert.ok(found.size >= 40, `夹具自检：扫描应覆盖 src 的写出面（实际 ${found.size} 种）`);
  const unregistered = [...found.keys()].filter((type) => !TRANSCRIPT_EVENT_TYPES.includes(type));
  assert.deepEqual(
    unregistered.map((type) => `${type} (${found.get(type)[0]})`),
    [],
    "src 字面量写出的事件必须全部登记进 src/transcriptEvents.js",
  );
  // 已知事件常量（字面量扫描看不见的写出面）逐个对照。
  const constants = {
    PROCESS_MISSING_CONFIRMED_TYPE,
    ACCEPTANCE_EVENT_TYPE,
    LEAD_COMMIT_CHECK_STARTED_TYPE,
    LEAD_COMMIT_CHECK_OUTCOME_TYPE,
    PROVIDER_SESSION_BOUND_EVENT,
  };
  for (const [name, value] of Object.entries(constants)) {
    assert.ok(
      TRANSCRIPT_EVENT_TYPES.includes(value),
      `常量 ${name} 的值 ${value} 必须已登记`,
    );
  }
});

// 静态扫描自检：本测试文件所在目录树不进扫描面（只扫 src/**），夹具里的
// probe 类型不会误报。
test("registry-8: 生成清单行集与登记表一致（新鲜度由 docsSurface-1 字节钉兜底）", async () => {
  const md = readFileSync(join(REPO_ROOT, "docs", "surface", "transcript-events.md"), "utf8");
  const rows = [...md.matchAll(/^\| `([a-z][a-z0-9_.]+)`(?: \*\(legacy\)\*)? \|/gm)].map((m) => m[1]);
  assert.deepEqual(
    rows,
    TRANSCRIPT_EVENT_REGISTRY.map((entry) => entry.type),
    "生成清单的行集与行序等于登记表（字节钉在 docsSurface-1）",
  );
  assert.ok(statSync(join(REPO_ROOT, "docs", "surface", "transcript-events.md")).size > 0);
});
