// scripts/run-component-check.mjs
//
// ADR-0032 §6：组件层验证入口（backend / llm 单独验证）。
//
// 用法（经 scripts/wao-node.cjs 转发，与既有入口同款）：
//   npm run component-check -- --subject backend            # 全部 backend 组件
//   npm run component-check -- --subject llm                # 全部 llm 组件
//   npm run component-check -- --subject claude-code        # 单个 backend
//   npm run component-check -- --subject zhipuai-coding-plan/glm-5.2   # 单个 llm
//   其余参数见 COMPONENT_CHECK_USAGE（--help）。
//
// 消耗真实 API token（drill 派发真实 run）。不进 npm test；手动触发。
//
// 纪律（ADR-0032）：
//   - §7 前置根修：零目标 / 未知被测 / 无效参数在【创建临时文件、派发、更新
//     台账之前】拒绝，exit 2——绝不空转后报 ALL PASS。
//   - §4 夹具资格：新鲜组合认证记录（--composition-summary）或 Owner 显式
//     指定的参照装配（registry 的 certification.fixtures），二者任一；夹具
//     不可用 → 被测记 blocked（入台账），exit 1。不要求"必须先有已认证 LLM"。
//   - §5 分文件：组件台账写 runs/component-checks.json（componentLedger SSOT），
//     绝不写 workers / 组合 status / lastFullHealthyRunAt；旧台账不可解析 →
//     显式报错 exit 2，绝不静默清史。
//   - §4/入口边界：绝不复用组合的 certifyCase() 给组件盖章——组件判定唯一实
//     现是 componentDrills.componentResultFromChecks。
//   - 夹具绿不得被读成被测绿：台账只按被测组件键落账，夹具只进 record.fixture。
//
// 本文件是薄壳：全部逻辑在 scripts/reliability/componentDrills.mjs（纯函数 +
// 工厂注入 glue），dry 测试直接钉模块（test/registry-roles/componentCheck.test.js）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 参数解析独立在 componentArgs.mjs（ADR-0032 §6 + 2026-09-20 拒收复盘：
// reliability 共享的 args.mjs 保持拒收前版本逐字节不动——零共享面）。
import { parseComponentCheckArgs, COMPONENT_CHECK_USAGE } from "./reliability/componentArgs.mjs";
import {
  planComponentChecks,
  executeComponentChecks,
  createComponentDrills,
  drillsForKind,
  resolveSubjects,
} from "./reliability/componentDrills.mjs";
import {
  DEFAULT_FIXTURE_MAX_AGE_DAYS,
  componentLedgerPathFor,
  annotateRuntimeDrift,
  mergeComponentRecords,
  pruneComponentRecords,
  readComponentLedgerFile,
  recordComponentCheck,
  summarizeComponentLedger,
  writeComponentLedgerFile,
} from "./reliability/componentLedger.mjs";
// 运行时身份入账（2026-09-21）：被测 harness 的 --version 一次 spawn 探测。
import { probeRuntimeIdentity } from "./reliability/runtimeIdentity.mjs";
// ADR-0032 §8：检查五态（打印面按状态出图标，N/A 不再显示为红叉）。
import { checkStateOf } from "./reliability/checkStates.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
// component-check spawn 的 CLI 子进程也必须走 v22（npm run component-check 经
// wao-node.cjs 转发，process.execPath 已是 shim 选定的 v22——与 run-reliability
// 同款注入纪律，避免以 "node" 字面量派发落回 PATH 里的 v24 被 versionGuard 拒）。
const NODE_BIN = process.execPath;

const _argResult = parseComponentCheckArgs(process.argv.slice(2));
if (_argResult.help) {
  console.log(COMPONENT_CHECK_USAGE);
  process.exit(0);
}
if (_argResult.error) {
  console.error(`[component-check] ${_argResult.error}`);
  console.error(COMPONENT_CHECK_USAGE);
  process.exit(2);
}
const getArg = (name) => _argResult.values[name];
const SUBJECT = getArg("subject");
const REGISTRY_PATH = resolve(getArg("registry") || join(ROOT, "config", "agents.json"));
const COMPOSITION_SUMMARY_PATH = resolve(
  getArg("composition-summary") || join(ROOT, "runs", "reliability-summary.json"),
);
const LEDGER_PATH = resolve(getArg("ledger") || join(ROOT, "runs", "component-checks.json"));
const WAIT_TIMEOUT = getArg("wait-timeout") || "300000";
const POLL_INTERVAL = getArg("poll-interval") || "2000";
const FIXTURE_MAX_AGE_DAYS = Number(getArg("fixture-max-age-days") || String(DEFAULT_FIXTURE_MAX_AGE_DAYS));
if (!Number.isFinite(FIXTURE_MAX_AGE_DAYS) || FIXTURE_MAX_AGE_DAYS <= 0) {
  console.error(`[component-check] --fixture-max-age-days must be a positive number, got ${JSON.stringify(getArg("fixture-max-age-days"))}`);
  process.exit(2);
}
// 运行时临时区（本 worktree 内；默认 <root>/.wao/runs/，gitignored）。
const WORK_DIR = resolve(
  getArg("work-dir") || join(ROOT, ".wao", "runs", `component-check-${Date.now().toString(36)}`),
);

// codeRef = 验证时 WAO repo 的 git HEAD（backend 组件键的组成部分，ADR-0032 §5）。
// 只读 git 查询（rev-parse），绝无任何 git 变更。
function resolveCodeRef() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`cannot resolve WAO repo git HEAD (codeRef is required for backend component keys): ${error?.message ?? error}`);
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

const codeRef = resolveCodeRef();

// 1) 载入 registry（缺失/不可解析 = 显式失败，零临时文件零派发）。
if (!existsSync(REGISTRY_PATH)) {
  console.error(`[component-check] registry not found: ${REGISTRY_PATH}`);
  process.exit(2);
}
let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
} catch (error) {
  console.error(`[component-check] registry unparseable (${REGISTRY_PATH}): ${error?.message ?? error}`);
  process.exit(2);
}

// 2) 载入组合层台账（夹具资格路径 1 的证据源）。缺失 = 无组合认证记录（正常：
//    夹具走 owner-declared 或 blocked）；存在但不可解析 = 显式失败（证据源损坏
//    不得静默当不存在，ADR-0032 §5 unparseable 纪律）。
let compositionSummary = null;
if (existsSync(COMPOSITION_SUMMARY_PATH)) {
  try {
    compositionSummary = JSON.parse(readFileSync(COMPOSITION_SUMMARY_PATH, "utf8"));
  } catch (error) {
    console.error(`[component-check] composition summary unparseable (${COMPOSITION_SUMMARY_PATH}): ${error?.message ?? error} — fix or remove the file; a corrupt fixture-evidence source must not be silently treated as absent`);
    process.exit(2);
  }
}

const NOW = new Date().toISOString();

// 2b) 运行时身份探测（2026-09-21，ADR-0032 §5/§8 批次）：对解析范围内的每个
//     backend 被测恰一次 `<binary> --version` spawn（零新依赖）。指纹进组件键
//     （backend:<name>@<codeRef>#<fp>）；探测不可知 → honest unknown（指纹每次
//     唯一，两个 unknown 不当作同一运行时）。只做 advisory/stale 可见性：
//     版本漂移的历史记录降 runtime-drifted advisory「建议重跑」，不删、不进
//     认证门。llm 被测无 harness 探测面（身份是 provider/model 四元组）。
const preResolved = resolveSubjects({ registry, subjectArg: SUBJECT, codeRef });
const backendSubjectNames = [...new Set(preResolved.subjects.filter((s) => s.kind === "backend").map((s) => s.name))];
const runtimeIdentities = {};
for (const name of backendSubjectNames) {
  const anchor = registry.agents?.[preResolved.subjects.find((s) => s.name === name)?.anchorAgentId] ?? null;
  runtimeIdentities[name] = probeRuntimeIdentity({ backendName: name, agent: anchor });
}
const runtimeFingerprints = Object.fromEntries(
  Object.entries(runtimeIdentities).map(([name, identity]) => [name, identity.fingerprint]),
);

// 3) 计划（纯函数）：被测解析 + 夹具资格 + 装配。错误（未知被测/歧义/坏 fixtures
//    声明）在创建临时文件、派发、更新台账之前 exit 2（ADR-0032 §7）。
let plan;
try {
  plan = planComponentChecks({
    registry,
    subjectArg: SUBJECT,
    codeRef,
    compositionSummary,
    now: NOW,
    fixtureMaxAgeDays: FIXTURE_MAX_AGE_DAYS,
    runtimeFingerprints,
  });
} catch (error) {
  console.error(`[component-check] ${error?.message ?? error}`);
  process.exit(2);
}
if (plan.error) {
  console.error(`[component-check] ERROR: ${plan.error}`);
  console.error("[component-check] 零目标/未知被测必须显式失败（ADR-0032 §7）——本入口不做无目标的\"通过\"。");
  process.exit(2);
}

// §7 零目标纪律：解析出 0 个被测（或被测 kind 无有效 drill 词汇）→ exit 2。
const totalDrills = plan.subjects.reduce((sum, s) => sum + drillsForKind(s.subject.kind).length, 0);
if (plan.subjects.length === 0 || totalDrills === 0) {
  console.error(`[component-check] ERROR: --subject ${JSON.stringify(SUBJECT)} 解析出 ${plan.subjects.length} 个被测 / ${totalDrills} 个 drill——拒绝运行。`);
  console.error("[component-check] 空转后报通过是假绿（TD-169 同族，ADR-0032 §7）；零目标必须显式失败。");
  process.exit(2);
}

// 4) 生成临时装配 registry（只含夹具装配；不动主 registry 的 certification.matrix）。
mkdirSync(WORK_DIR, { recursive: true });
const tempRegistryPath = join(WORK_DIR, "fixture-registry.json");
writeFileSync(tempRegistryPath, JSON.stringify(plan.tempRegistry, null, 2));

// 5) 执行（生产 drills = createComponentDrills 工厂注入本入口环境）。
const componentDrills = createComponentDrills({
  nodeBin: NODE_BIN,
  root: ROOT,
  tmpDir: WORK_DIR,
  waitTimeout: WAIT_TIMEOUT,
  pollInterval: POLL_INTERVAL,
  registry: tempRegistryPath,
});

console.log("=== WAO Component Check ===");
console.log(`subject: ${SUBJECT} (${plan.subjects.length} component(s))`);
console.log(`registry: ${REGISTRY_PATH}`);
console.log(`composition summary: ${existsSync(COMPOSITION_SUMMARY_PATH) ? COMPOSITION_SUMMARY_PATH : "(absent — owner-declared fixtures only)"}`);
console.log(`ledger: ${LEDGER_PATH}`);
console.log(`work dir: ${WORK_DIR}`);
console.log(`codeRef: ${codeRef}`);
for (const [name, identity] of Object.entries(runtimeIdentities)) {
  const identityNote = identity.version
    ? `${identity.distribution} ${identity.version} (${identity.binaryPath})`
    : `unknown — ${identity.reason ?? "probe did not yield a version"} (fingerprint ${identity.fingerprint}; two unknowns are never treated as the same runtime)`;
  console.log(`runtime: ${name} → ${identityNote}`);
}
console.log("");

const recordInputs = executeComponentChecks({
  plan,
  drills: componentDrills,
  codeRef,
  now: NOW,
  environmentInfo: { platform: process.platform, node: process.version },
  runtimeIdentities,
});

// 逐被测输出（被测与夹具分账可见；五态打印——N/A 用 ○，不是红叉）。
for (const input of recordInputs) {
  const fixtureNote = input.fixture
    ? `fixture: ${input.fixture.kind} ${input.fixture.identity.backend ?? `${input.fixture.identity.providerID}/${input.fixture.identity.modelId}`} (qualifiedBy ${input.fixture.qualifiedBy}${input.fixture.runId ? `, runId ${input.fixture.runId}` : ""})`
    : "fixture: none";
  console.log(`[${input.result.toUpperCase()}] ${input.key}`);
  console.log(`  ${fixtureNote}`);
  for (const c of (input.checks ?? [])) {
    const state = checkStateOf(c);
    const icon = state === "pass" ? "✔" : state === "not-applicable" ? "○" : "✖";
    console.log(`  ${icon}${c.informational === true ? " (informational)" : ""} ${c.name} [${c.category}]: ${c.detail}`);
  }
  if (input.reason) console.log(`  reason: ${input.reason}`);
  console.log("");
}

// 6) 台账（ADR-0032 §5 分文件 + 增量合并 + 键级修剪；unparseable 旧账 → 显式失败）。
const priorFileState = readComponentLedgerFile(LEDGER_PATH);
if (priorFileState.state === "unparseable") {
  console.error(`[component-check] component ledger unparseable (${LEDGER_PATH}): ${priorFileState.error} — surface explicitly, never skip silently (ADR-0032 §5)`);
  process.exit(2);
}
const priorRecords = priorFileState.state === "loaded" ? (priorFileState.ledger.records ?? []) : [];
const freshRecords = recordInputs.map((input) => recordComponentCheck(input));
// 运行时漂移（2026-09-21）：同 (backend, codeRef) 但指纹不同的历史记录降
// runtime-drifted advisory（不删，建议重跑）——先标注再并入，保证漂移记录在
// 键级修剪后仍以 advisory 形态留存（annotateRuntimeDrift 与 fixture-decayed
// 同款"不删"硬语义；legacy 无指纹记录无法证明同运行时，如实标漂移）。
const driftedAnnotated = annotateRuntimeDrift(priorRecords, { freshBackendRecords: freshRecords, at: NOW });
const driftCount = driftedAnnotated.filter((r, i) => r !== priorRecords[i]).length;
if (driftCount > 0) {
  console.log(`runtime drift: ${driftCount} historical record(s) demoted to runtime-drifted advisory (rerun recommended — advisory only, never a gate)`);
}
// 修剪 scope：本轮管理的键 = 本次刷新的全部被测键（pruneComponentRecords 的
// kind 守卫保证未覆盖 kind 的历史记录不动——单跑 backend 不连坐 llm 旧账）。
const currentKeys = freshRecords.map((r) => r.key);
const merged = mergeComponentRecords(
  pruneComponentRecords(priorRecords, currentKeys),
  [...driftedAnnotated, ...freshRecords],
);
const summary = summarizeComponentLedger(merged);
writeComponentLedgerFile(LEDGER_PATH, summary);

// 7) 计数与退出码（§7：本轮 selected/executed/passed/failed/blocked 另列历史台账；
//    只有 blocked（零执行）的运行不得报 ALL PASS——exit 1）。
const selected = freshRecords.length;
const executed = freshRecords.filter((r) => r.result !== "blocked").length;
const counts = { pass: 0, fail: 0, blocked: 0 };
for (const r of freshRecords) counts[r.result] += 1;
const historical = priorFileState.state === "loaded"
  ? (priorFileState.ledger.counts ?? null)
  : null;
console.log(`Ledger written to ${LEDGER_PATH}`);
console.log(`This run: selected=${selected} executed=${executed} passed=${counts.pass} failed=${counts.fail} blocked=${counts.blocked}`);
if (historical) {
  console.log(`Prior ledger (pre-merge history): ${JSON.stringify(historical)}`);
}
const allPassed = executed > 0 && counts.fail === 0 && counts.blocked === 0 && freshRecords.every((r) => r.result === "pass");
console.log(`\n=== ${allPassed ? "ALL PASS" : "SOME FAILED OR BLOCKED"} ===`);
process.exit(allPassed ? 0 : 1);
