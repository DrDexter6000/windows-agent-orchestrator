// test/isolation-infra/cliHelpCoverage.test.js
//
// 第 67a 批：CLI 帮助「已实现 ⊆ 帮助」守卫——子命令与旗标两层。
//
// 顶层命令名早有双向守卫（cli-runs.test.js 的 COMMAND_NAMES ↔ HELP_TEXT 锚定）；
// 本测试把同一纪律压到子命令与旗标层：
//   1. 子命令（双向）：对每个有子命令的命令，从 src/commands/*.js 的分发器源码里
//      扫出 `sub === "<字面量>"`（变量名以源码为准，如 runs delivery 是 args[0]），
//      与 HELP_TEXT 里 `  <命令> ` 起始行的首个子命令词双向相等。
//   2. 旗标（已实现 ⊆ 帮助）：扫 src/cli.js 与 src/commands/*.js 读取的
//      options.<key>（赋值不算读），换 --kebab-case 后必须出现在该模块所服务
//      命令的帮助行、该模块的补充用法面（run 的 RUN_USAGE_TEXT、consult 的
//      CONSULT_USAGE_LINES）、或 HELP_TEXT Notes 的内部旗标一行里。
//      程序内部设置、不来自命令行的键进显式排除表（各附一句理由）。
// 守卫只比对子命令词与旗标名，不钉说明文字。注释也照扫（不做词法分析就没法安全地
// 去掉注释，漏扫比误红更糟）：注释里写得像分发比较或 options 读取，守卫红了就改写注释。
//
// 看不到的面（如实记下，不假装覆盖）：手写解析器（runs wait/gate/delivery
// review/reverify/verify-commit、wao lanes 读 flags.<key> 或字面量集合）；把 options
// 传进 src/application/ 等别处再读的键；switch/表驱动的分发。旗标按模块所服务命令的
// 帮助行取并集，不证明某个子命令真的支持该旗标，也不查必填、取值与互斥。
//
// 纯静态：readFile 读源码 + import 无副作用的 src/cliHelp.js；零子进程、零 git、
// 零网络（manifest pure 波次）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { COMMAND_NAMES, HELP_TEXT, RUN_USAGE_TEXT } from "../../src/cliHelp.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

/** 读仓库文件并归一 CRLF → LF（检出换行符无关）。 */
async function readSource(rel) {
  return (await readFile(resolve(REPO_ROOT, rel), "utf8")).replace(/\r\n/g, "\n");
}

// ── 帮助侧解析 ─────────────────────────────────────────────────────────────

/** 命令（如 "runs delivery"）在 HELP_TEXT 的全部行：两空格缩进 + 命令词边界。 */
function helpLinesFor(command) {
  return HELP_TEXT.split("\n").filter(
    (line) => line === `  ${command}` || line.startsWith(`  ${command} `),
  );
}

/** 行的语法段：截掉 ` # ` 起的说明（说明里提到的旗标不算语法面）。 */
function syntaxPart(line) {
  return line.split(" # ")[0];
}

/** 帮助行语法段里出现的全部旗标名（`--isolate|--no-isolate` 拆两个）。 */
function flagsInHelpLines(lines) {
  const flags = new Set();
  for (const line of lines) {
    for (const m of syntaxPart(line).matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) {
      flags.add(m[1]);
    }
  }
  return flags;
}

/**
 * 帮助里某命令的子命令词集：其每个帮助行首个子命令词（`a|b` 拆开）；
 * `<…>` 占位符与 `--`/`[` 旗标首词跳过（如 `runs settle --run-id …` 的首词是
 * settle 本身——本函数只对行的"命令词之后第一个词"取值）。
 */
function helpSubwordsFor(command) {
  const words = new Set();
  for (const line of helpLinesFor(command)) {
    const rest = syntaxPart(line).slice(`  ${command}`.length).trim();
    const first = rest.split(/\s+/)[0] ?? "";
    if (first === "" || first.startsWith("<") || first.startsWith("-") || first.startsWith("[")) {
      continue;
    }
    for (const part of first.split("|")) words.add(part);
  }
  return words;
}

// ── 检查 1：子命令双向相等 ─────────────────────────────────────────────────
//
// 表：命令 → 分发器所在模块 + 分发器函数名 + 分发比较的变量名（以源码为准）。
// 扫描窗口 = 分发器函数体（从 `function <名>(` 到下一个顶层函数声明），
// 字面量模式 `<变量> === "<小写词>"`。扫不出任何字面量 = 红（防静默通过）。
//
// 显式例外（每条附理由，都是有意不在帮助里的分发字面量或无字面量的等价成员）：
//   - excluded：扫出的字面量不是真子命令（墓碑分支 / 用法页触发词）。
//   - fallthrough：分发器没有字面量、其余输入一律落到的默认子命令（帮助必须列）。

const SUBCOMMAND_SPECS = [
  {
    command: "consult",
    module: "src/commands/consult.js",
    dispatcher: "consultCommand",
    excluded: {
      help: "用法页触发词（与 --help/-h 同义，不是子命令；HELP_TEXT 顶层同样无 help 行）",
    },
  },
  { command: "serve", module: "src/commands/serve.js", dispatcher: "serveCommand" },
  {
    command: "registry",
    module: "src/commands/registry.js",
    dispatcher: "registryCommand",
    fallthrough: {
      list: "registryCommand 只显式分支 validate，其余一切输入落到 list（registry.js fallthrough，无 list 字面量）",
    },
  },
  {
    command: "runs",
    module: "src/commands/runs.js",
    dispatcher: "runsCommand",
    excluded: {
      forecast: "已退役命令的墓碑分支（runs.js 固定报错指路，永不执行，帮助不列）",
    },
  },
  { command: "runs delivery", module: "src/commands/runs.js", dispatcher: "runsDeliveryCommand", scanVar: "args[0]" },
  { command: "playbook", module: "src/commands/playbook.js", dispatcher: "playbookCommand" },
  { command: "feedback", module: "src/commands/feedback.js", dispatcher: "feedbackCommand" },
  { command: "worktree", module: "src/commands/worktree.js", dispatcher: "worktreeCommand" },
  { command: "daemon", module: "src/commands/daemon.js", dispatcher: "daemonCommand" },
  { command: "daemon supervisor", module: "src/commands/daemon.js", dispatcher: "daemonSupervisorCommand" },
  { command: "mcp", module: "src/commands/mcp.js", dispatcher: "mcpCommand" },
  { command: "skill", module: "src/commands/skill.js", dispatcher: "skillCommand" },
  { command: "wao", module: "src/commands/wao.js", dispatcher: "waoCommand" },
  { command: "wao decision", module: "src/commands/wao.js", dispatcher: "waoDecisionCommand" },
  { command: "wao handoff", module: "src/commands/wao.js", dispatcher: "waoHandoffCommand" },
];

/**
 * 取模块源码里某顶层函数的源码窗口：从声明到它自己的收尾 `}`（行首、无缩进——仓库
 * 两空格缩进，函数体内的行都有缩进）。
 */
function functionWindow(moduleSource, fnName, moduleRel) {
  const start = moduleSource.indexOf(`function ${fnName}(`);
  assert.notEqual(start, -1, `${moduleRel} 必须含顶层函数 ${fnName}（分发器改名请同步本守卫的表）`);
  const end = moduleSource.indexOf("\n}", start);
  assert.notEqual(end, -1, `${moduleRel} 的 ${fnName} 找不到行首的收尾 }`);
  return moduleSource.slice(start, end + 2);
}

/** 扫分发器窗口里的子命令比较字面量（scanVar 默认 "sub"；单双引号都认）。 */
function scanSubcommandLiterals(window, scanVar = "sub") {
  const name = scanVar.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  const pattern = new RegExp(`\\b${name}\\s*===\\s*(["'])([a-z][a-z0-9-]*)\\1`, "g");
  const found = new Set();
  for (const m of window.matchAll(pattern)) found.add(m[2]);
  return found;
}

test("67a-子命令：帮助里带子命令的顶层命令都在表里（新命令族不漏扫）", () => {
  const registered = new Set(SUBCOMMAND_SPECS.map((s) => s.command));
  const unregistered = COMMAND_NAMES.filter((c) => helpSubwordsFor(c).size > 0 && !registered.has(c)).sort();
  assert.deepEqual(unregistered, [], "这些顶层命令在帮助里有子命令行，但不在 SUBCOMMAND_SPECS");
});

test("67a-子命令：分发器字面量 ↔ 帮助行首词双向相等", async () => {
  const moduleCache = new Map();
  const moduleSource = async (rel) => {
    if (!moduleCache.has(rel)) moduleCache.set(rel, await readSource(rel));
    return moduleCache.get(rel);
  };

  for (const spec of SUBCOMMAND_SPECS) {
    const src = await moduleSource(spec.module);
    const scanned = scanSubcommandLiterals(
      functionWindow(src, spec.dispatcher, spec.module),
      spec.scanVar,
    );
    // 扫不出东西 = 守卫失明，直接红。
    assert.ok(scanned.size > 0, `${spec.module} 的 ${spec.dispatcher} 一个子命令字面量都没扫到（守卫失明）`);

    const implemented = new Set(scanned);
    for (const word of Object.keys(spec.excluded ?? {})) {
      assert.ok(implemented.delete(word), `${spec.command} 的排除项 "${word}" 不在扫描结果里——排除表过期`);
    }
    for (const word of Object.keys(spec.fallthrough ?? {})) implemented.add(word);

    const inHelp = helpSubwordsFor(spec.command);
    assert.ok(inHelp.size > 0, `HELP_TEXT 没有任何 "  ${spec.command} " 起始的子命令行`);

    const missingInHelp = [...implemented].filter((w) => !inHelp.has(w)).sort();
    const phantomInHelp = [...inHelp].filter((w) => !implemented.has(w)).sort();
    assert.deepEqual(
      missingInHelp,
      [],
      `${spec.command}：实现了但帮助没列（missingFromHelp）`,
    );
    assert.deepEqual(
      phantomInHelp,
      [],
      `${spec.command}：帮助列了但分发器没有（phantomInHelp）`,
    );
  }
});

// ── 检查 2：旗标「已实现 ⊆ 帮助」 ──────────────────────────────────────────

/** HELP_TEXT Notes 的内部旗标一行（第 67a 批：内部穿线/高级覆盖旗标收在一处）。 */
const INTERNAL_FLAGS = [
  "--run-id",
  "--state-dir",
  "--install-root",
  "--example-registry",
  "--reliability-summary",
];

function internalFlagsLine() {
  return HELP_TEXT.split("\n").find((line) => line.startsWith("  - 内部旗标")) ?? null;
}

// 模块 → 它服务的命令（帮助行旗标的合法出现面）。表是模块归属的事实来源：
// 该模块读取的 options.<key> 只要出现在其中任一命令的帮助行（或下方补充面/
// 内部旗标行）即算覆盖。新命令族拆进 src/commands/ 时在此登记。
const FLAG_MODULE_COMMANDS = {
  "src/cli.js": ["wao ask"], // waoAskCommand（askHandler 注入 wao.js）
  "src/commands/consult.js": ["consult run", "consult show", "consult wait"],
  "src/commands/daemon.js": [
    "daemon start", "daemon run", "daemon stop", "daemon status",
    "daemon list", "daemon ping", "daemon supervise", "daemon supervisor", "daemon health",
  ],
  "src/commands/dashboard.js": ["dashboard"],
  "src/commands/doctor.js": ["wao doctor"],
  "src/commands/feedback.js": ["feedback submit", "feedback list", "feedback show", "feedback close"],
  "src/commands/lanes.js": ["wao lanes"],
  "src/commands/lifecycle.js": ["retry", "resume"],
  "src/commands/mcp.js": ["mcp status", "mcp bind", "mcp unbind"],
  "src/commands/observe.js": ["status", "tail", "collect"],
  "src/commands/onboarding.js": ["wao onboarding"],
  "src/commands/playbook.js": ["playbook list", "playbook show"],
  "src/commands/registry.js": ["registry list", "registry validate", "registry align"],
  "src/commands/run.js": ["run", "spawn"],
  "src/commands/runs.js": [
    "runs list", "runs summary", "runs prune", "runs migrate-projects", "runs grep",
    "runs lineage-close", "runs settle", "runs metrics", "runs scorecard",
    "runs dashboard", "runs diagnose", "runs delivery", "runs delivery review",
    "runs delivery reverify", "runs wait", "runs gate", "runs verify-commit",
    "dashboard", // runDashboardWeb 同时服务顶层 dashboard 启动器（--port/--run-dir）
  ],
  "src/commands/serve.js": ["serve status", "serve sweep", "serve recycle"],
  // shared.js 的解析 helper 被 run/spawn/retry/resume/status/tail/collect/stop/
  // consult run/registry list/mcp/wao doctor/onboarding/runs dashboard 的处理器调用。
  "src/commands/shared.js": [
    "run", "spawn", "retry", "resume", "status", "tail", "collect", "stop",
    "consult run", "registry list", "mcp status", "mcp bind", "mcp unbind",
    "wao doctor", "wao onboarding", "runs dashboard",
  ],
  "src/commands/skill.js": ["skill link", "skill unlink"],
  "src/commands/stop.js": ["stop"],
  "src/commands/worktree.js": ["worktree list", "worktree remove", "worktree reclaim"],
  "src/commands/wao.js": [
    "wao init", "wao decision add", "wao decision list", "wao decision show",
    "wao declare", "wao stage", "wao ask", "wao handoff write", "wao handoff read",
    "wao doctor", "wao onboarding", "wao accept", "wao sweep-claude-config", "wao lanes",
  ],
};

// 补充用法面：模块旗标除 HELP_TEXT 命令行外的另一个合法出现处。
const FLAG_MODULE_EXTRA_SOURCES = {
  "src/commands/run.js": [RUN_USAGE_TEXT], // run --help 用法页（SSOT 在 cliHelp.js）
};

// 程序内部设置、不来自命令行的 options 键（读取点在代码里，但不是 CLI 旗标）。
// 每项一句理由；新增同类键必须在此登记，否则守卫红。
const PROGRAMMATIC_OPTION_KEYS = {
  "src/commands/run.js": {
    scorecardRulesSource: "loadScorecardRules 写入的来源注记（--scorecard-rules-file/--scorecard-rules 二选一标记），非命令行旗标",
    resolvedRoleId: "runCommand 解析 alias 派发后写回 options 的角色 id（传给后台 runner），非命令行旗标",
    onObservationDeadline: "runAndWait 注入 waitForCompletion 的进程内回调，非命令行旗标",
  },
};

/** camelCase → --kebab-case（runId → --run-id）。 */
function kebabFlag(key) {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** 扫模块源码里读取的 options.<key>（`options.x = …` 赋值不算读取）。 */
function scanOptionReads(moduleSource) {
  const reads = new Set();
  // (?![A-Za-z0-9]) 先钉死标识符整词边界——没有它，贪婪组会回吐末字符绕过
  // 赋值排除（"options.json = true" 被匹配成读取了 "jso"）。
  for (const m of moduleSource.matchAll(/\boptions\.([A-Za-z][A-Za-z0-9]*)(?![A-Za-z0-9])(?!\s*=[^=])/g)) {
    reads.add(m[1]);
  }
  return reads;
}

test("67a-旗标：模块读取的 options.<key> ⊆ 帮助行 ∨ 补充面 ∨ 内部旗标行", async () => {
  const internalLine = internalFlagsLine();
  assert.ok(internalLine !== null, "HELP_TEXT Notes 缺内部旗标行（以「- 内部旗标」开头的那一行）");
  const moduleFiles = (await readdir(resolve(REPO_ROOT, "src/commands")))
    .filter((f) => f.endsWith(".js"))
    .map((f) => `src/commands/${f}`);
  assert.deepEqual(
    moduleFiles.filter((f) => !(f in FLAG_MODULE_COMMANDS)).sort(),
    [],
    "src/commands/ 下有模块不在旗标表里（新模块要登记它服务的命令）",
  );
  for (const flag of INTERNAL_FLAGS) {
    assert.ok(
      internalLine.includes(flag),
      `内部旗标行必须列全 ${flag}（一行收齐，防漂移）`,
    );
  }

  for (const [moduleRel, commands] of Object.entries(FLAG_MODULE_COMMANDS)) {
    const src = await readSource(moduleRel);
    const reads = scanOptionReads(src);
    assert.ok(reads.size > 0, `${moduleRel} 一个 options.<key> 都没扫到（守卫失明）`);

    const programmatic = PROGRAMMATIC_OPTION_KEYS[moduleRel] ?? {};
    const allowed = new Set(INTERNAL_FLAGS);
    for (const command of commands) {
      const lines = helpLinesFor(command);
      assert.ok(lines.length > 0, `HELP_TEXT 没有 "  ${command} " 命令行（${moduleRel} 的表项指向不存在的命令）`);
      for (const flag of flagsInHelpLines(lines)) allowed.add(flag);
    }
    for (const extra of FLAG_MODULE_EXTRA_SOURCES[moduleRel] ?? []) {
      for (const m of extra.matchAll(/(--[a-z][a-z0-9-]*)/g)) allowed.add(m[1]);
    }

    const missing = [...reads]
      .filter((key) => !(key in programmatic))
      .map(kebabFlag)
      .filter((flag) => !allowed.has(flag))
      .sort();
    assert.deepEqual(
      missing,
      [],
      `${moduleRel} 读取了旗标但帮助/内部旗标行没列（missingFromHelp）`,
    );

    // 排除表防过期：登记的程序内键必须真的出现在该模块源码里。
    for (const key of Object.keys(programmatic)) {
      assert.ok(
        reads.has(key),
        `${moduleRel} 的排除项 "${key}" 已不在源码读取面——排除表过期，请删`,
      );
    }
  }
});

// consult 的用法页数组（CONSULT_USAGE_LINES，SSOT 在 consult.js）也是旗标合法面：
// migration-0045/explicitDispatch.test.js 钉 CONSULT_USAGE = join；这里只提取数组
// 文本进上面的允许集——旗标层不依赖 import 副作用。
test("67a-旗标：consult 用法页数组文本进允许集", async () => {
  const src = await readSource("src/commands/consult.js");
  const start = src.indexOf("export const CONSULT_USAGE_LINES = [");
  const end = src.indexOf("];", start);
  assert.ok(start !== -1 && end !== -1, "consult.js 缺 CONSULT_USAGE_LINES 数组（守卫失明）");
  const usageText = src.slice(start, end);
  const usageFlags = new Set([...usageText.matchAll(/(--[a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  const helpFlags = flagsInHelpLines([
    ...helpLinesFor("consult run"),
    ...helpLinesFor("consult show"),
    ...helpLinesFor("consult wait"),
  ]);
  // 帮助行与用法页是同一面的两份投影：旗标集必须一致（防两处漂移）。
  assert.deepEqual(
    [...usageFlags].filter((f) => !helpFlags.has(f)).sort(),
    [],
    "CONSULT_USAGE_LINES 有旗标但 HELP_TEXT consult 行没有（两面漂移）",
  );
  assert.deepEqual(
    [...helpFlags].filter((f) => !usageFlags.has(f)).sort(),
    [],
    "HELP_TEXT consult 行有旗标但 CONSULT_USAGE_LINES 没有（两面漂移）",
  );
});
