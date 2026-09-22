// test/reliability/run-reliability.mjs
//
// WAO reliability 套件：用 sentinel + scorecard drill 认证 runtime × model 矩阵。
//
// 这是"比 smoke 更狠"的验证层——不只验证"跑通"，还验证：
//   1. agent 真读了文件（sentinel 内容出现在输出里，防背诵用隐藏 sentinel）
//   2. completed 时有 assistant text（防伪完成）
//   3. metrics 来自 session endpoint（防 message-level 偏小值）
//   4. silentTimeout 对静默失败有效、对正常响应不误杀
//   5. strict profile 下 command/file evidence 能被 scorecard 验收
//   6. adversarialEscape（TD-116/ADR-0025）：越界写指令被 delivery containment
//      gate 拦截（workdir_escape transcript 事实），逃逸未被拦即红
//
// 消耗真实 API token。不进 npm test。用 `npm run reliability` 手动触发。
//
// 用法：
//   npm run reliability                      # 全矩阵（需 serve 带 key 运行）
//   npm run reliability -- --agent coder     # 只跑指定 agent（增量合并，不覆盖其他 worker）
//   npm run reliability -- --serve-url http://127.0.0.1:4298
//   npm run reliability -- --profile strict  # 额外跑 command/file scorecard drill
//   npm run reliability -- --profile delta   # delta 子集（sentinel+scorecard+越界写对抗，ADR-0025）
//   npm run reliability -- --wait-timeout 300000  # 覆盖单 worker 超时（默认 300000）

import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { certifyCase, summarizeCertification, mergeCaseResults, pruneStaleCases } from "./reliability/certification.mjs";
import { buildCertificationMatrix } from "./reliability/matrix.mjs";
// TD-186：认证证据绑定执行画像——运行时身份探测复用组件层既有探针（一次 spawn /
// backend，零新指纹平台），探不到如实 verified:false，绝不猜。
import { probeRuntimeIdentity } from "./reliability/runtimeIdentity.mjs";
// R23-C：providerKey（认证身份第 4 维）归一化单一实现——src 宿主下向 import。
import { providerKeyFor } from "../src/providerFingerprint.js";
import { metricsNonZeroCheck } from "./reliability/metricsCheck.mjs";
// reportsCommandExitCode 条件化的判定源（backendCapabilitySnapshot SSOT）。
import { backendCapabilitySnapshot } from "../src/backends/factory.js";
// ADR-0032 §8：检查结果五态（N/A 构造 + 状态派生）。
import { naCheck, checkStateOf } from "./reliability/checkStates.mjs";
import { scorecardCommandFailureIsCredible } from "./reliability/scorecardEvidence.mjs";
// ADR-0032 §6：drill glue（runCli + 各 drill + 纯助手）抽至 ./reliability/drills.mjs，
// 组合入口（本文件）与将来的组件入口（component-check）共用——防双轨漂移。
// 纯判定内核仍在 adversarialEscape.mjs / metricsCheck.mjs，drills.mjs 只 import 消费。
import { extractJson, check, hasSentinel, createDrills } from "./reliability/drills.mjs";
// TD-186 复核 FAIL-B：drillRunIds 取证闭环（守卫/悬空 prior id 置 null）。
// 2026-09-22 审计收口（交错发布误删证据）：发布路径零删除——prune 类清理从本
// 入口移除，删除唯一入口 = 显式维护步骤 scripts/reliability/prune-drill-transcripts.mjs
// （sweepStaleDrillTranscripts：删除前重读磁盘 summary + 年龄阈值）。
import {
  drillTranscriptsDir,
  collectReferencedDrillRunIds,
  missingDrillTranscripts,
  nullUnresolvableDrillRunIds,
} from "./reliability/drillEvidence.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RUNS_DIR = resolve(ROOT, "runs");
// TD-186 复核 FAIL-B：sentinel/scorecard 转录的持久化回查位置（runs/reliability/）。
// 旧版落 TMP_DIR/runs/（cwd 相对解析）随后被 rmSync(TMP_DIR) 连带删除——
// drillRunIds 指向已删除证据（硬禁例）。runs/ 已 gitignore；runs 归档清扫只处理
// 顶层 *.jsonl，子目录语料不在清扫面内（smoke/、verify/ 同款先例）。
const DRILL_TRANSCRIPTS_DIR = drillTranscriptsDir(RUNS_DIR);
const TMP_DIR = resolve(__dirname, "reliability-tmp");

// reliability spawn 的 CLI 子进程也必须走 v22（与 npm run reliability 入口一致）。
// process.execPath 已是 shim 选定的 v22（因 npm run reliability 经 wao-node.cjs 转发），
// 直接复用并注入 drills.mjs 的 runCli，避免以 "node" 字面量派发落回 PATH 里的 v24 被 versionGuard 拒。
const NODE_BIN = process.execPath;

// --- 参数解析（2026-09-17 f1 修复：纯函数内核 + 未知 flag 拒绝 + 真 --help）---
// 旧 getArg 纯查表：未知 flag 静默忽略——传 --help 查用法曾直接跑全量矩阵
// 烧 token。现解析经 scripts/reliability/args.mjs 纯函数（dry 测试钉住），
// help/错误路径在任何 registry 加载、派发、认证结果更新之前退出。
import { parseReliabilityArgs, USAGE } from "./reliability/args.mjs";

const _argResult = parseReliabilityArgs(process.argv.slice(2));
if (_argResult.help) {
  console.log(USAGE);
  process.exit(0);
}
if (_argResult.error) {
  console.error(`[reliability] ${_argResult.error}`);
  console.error(USAGE);
  process.exit(2);
}
const getArg = (name) => _argResult.values[name];
const SERVE_URL = getArg("serve-url") || "http://127.0.0.1:4298";
const REGISTRY = getArg("registry") || resolve(ROOT, "config/agents.json");
const ONLY_AGENT = getArg("agent");
// 默认 300000（5min/worker）：strict profile 含 scorecard+isolation+workflow 多 drill，
// 120s 易在重 worker 上卡边界（codex/claude-code strict 单 worker 实测 30-60s，留余量）。
// 全量批跑时每个 worker 独立 runCli，此值是单 worker 上限，非全量总时长。
const WAIT_TIMEOUT = getArg("wait-timeout") || "300000";
const POLL_INTERVAL = getArg("poll-interval") || "2000";
const PROFILE_OVERRIDE = getArg("profile");

// --- drill glue 装配（ADR-0032 §6）---
// 环境常量（NODE_BIN/ROOT/TMP_DIR/WAIT_TIMEOUT/POLL_INTERVAL/REGISTRY）是本入口的
// 单一定义处，经 createDrills 显式注入共享 glue——drills.mjs 不复制这些定义。
const {
  runCli,
  runStrictScorecardDrill,
  runIsolationDrill,
  runAdversarialEscapeDrill,
  runWorkflowRunDirDrill,
  runStopDrill,
} = createDrills({
  nodeBin: NODE_BIN,
  root: ROOT,
  tmpDir: TMP_DIR,
  waitTimeout: WAIT_TIMEOUT,
  pollInterval: POLL_INTERVAL,
  registry: REGISTRY,
  // TD-186 复核 FAIL-B：scorecard 转录落可回查位置（drillRunIds 闭环的前半）。
  transcriptDir: DRILL_TRANSCRIPTS_DIR,
});

// --- sentinel 生成 ---
const SENTINEL_A = `ALPHA_${Date.now().toString(36).toUpperCase()}`;
const SENTINEL_B = `OMEGA_${Date.now().toString(36).toUpperCase()}`;

// --- 测试矩阵定义 ---
// 每个 case：agent + completionMode + 期望行为
// 读 config/agents.json 确定哪些 agent 可用
function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY, "utf8"));
}

const registry = loadRegistry();
const MATRIX = buildCertificationMatrix({
  registry,
  onlyAgent: ONLY_AGENT,
  profileOverride: PROFILE_OVERRIDE,
});

// 前置根修（ADR-0032 §7；TD-169(b)）：**零目标必须显式失败**，绝不空转后报 ALL PASS。
// 旧行为：目标 lane 无矩阵行 → buildCertificationMatrix 的 .filter 静默丢弃 → 空循环 →
// "=== ALL PASS ===" + exit 0（实证：coder_low_dsh 无 case 却"认证通过"，且无任何台账记录）。
{
  const declared = Array.isArray(registry?.certification?.matrix)
    && registry.certification.matrix.length > 0
    ? registry.certification.matrix
    : null;
  const dropped = declared
    ? [...new Set(declared
      .filter((tc) => !registry.agents?.[tc.agentId])
      .map((tc) => tc.agentId))]
    : [];
  if (dropped.length > 0) {
    // 警告而非失败：裁剪私人 registry（agents.example.json 明文支持的用法）不得被误伤。
    console.warn(`[reliability] WARN: 矩阵行指向不在册 lane，已跳过: ${dropped.join(", ")}`);
  }
  if (MATRIX.length === 0) {
    console.error(
      `[reliability] ERROR: ${ONLY_AGENT ? `--agent ${ONLY_AGENT}` : "当前 registry"} 解析出 0 个认证 case——拒绝运行。`,
    );
    console.error(
      "[reliability] 空转后报 ALL PASS 是假绿（见 TD-169）；本入口不做无目标的\"全绿\"。",
    );
    if (ONLY_AGENT && registry.agents?.[ONLY_AGENT]) {
      console.error(
        `[reliability] lane ${ONLY_AGENT} 在册但无 certification.matrix 行；请补一行，或改用组件层 component-check（ADR-0032）。`,
      );
    } else if (ONLY_AGENT) {
      console.error(`[reliability] registry 中不存在 lane ${ONLY_AGENT}。`);
    }
    process.exit(2);
  }
}

// --- 工具函数 ---
// （runCli / extractJson / check / hasSentinel 等 drill glue 已抽至
//   ./reliability/drills.mjs——见上方 createDrills 装配；此处只留组合入口专属逻辑。）

function countAssistantText(result) {
  if (!result?.messages) return 0;
  return result.messages.filter(
    (m) => m.info?.role === "assistant" &&
           m.parts?.some((p) => p.type === "text" && p.text),
  ).length;
}

function agentInfo(agentId) {
  const agent = registry.agents?.[agentId] ?? {};
  return {
    backend: agent.backend ?? null,
    providerID: agent.model?.providerID ?? null,
    modelId: agent.model?.id ?? null,
    // R23-C：providerKey（规范化 baseUrl + apiKeyEnv 变量名指纹）——与
    // matrix.normalizeCase 同一 SSOT 派生（src/providerFingerprint.js），无第二套归一化。
    providerKey: providerKeyFor(agent.provider),
    // TD-186：执行画像第 4 值——effort 取自该 lane 实际生效的 agent 配置
    // （registry.agents[agentId].reasoning.effort；null = 未配置，runtime 默认），
    // 不从矩阵行/别处复制。旧记录不补猜（由 summarize 层留 undefined）。
    effort: agent.reasoning?.effort ?? null,
    completionMode: agent.completionMode ?? "snapshot-stable",
  };
}

// --- TD-186：执行画像取证（只读，一次运行内每 backend 至多探一次）---
// git HEAD 只读获取（rev-parse；探不到 → null = unknown，不猜）。
const GIT_HEAD = (() => {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT, encoding: "utf8", windowsHide: true,
    });
    const sha = out.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
})();

const runtimeIdentityByBackend = new Map();
function runtimeIdentityFor(agent) {
  if (!agent?.backend) return null;
  if (!runtimeIdentityByBackend.has(agent.backend)) {
    runtimeIdentityByBackend.set(
      agent.backend,
      probeRuntimeIdentity({ backendName: agent.backend, agent }),
    );
  }
  return runtimeIdentityByBackend.get(agent.backend);
}

// ADR-0032 §8（2026-09-21 修复）+ reportsCommandExitCode 诚实声明：
//   - 缺 scorecard checks → 红（绝不用 completed 顶替证据检查——旧 fallback 是
//     点名的坏模式：完成主张不是命令/文件/证据事实）。
//   - declared reportsCommandExitCode === false 的 backend：commandsPassed 记
//     not-applicable + 原因（不置绿、不算失败——WAO 今天无法为该 harness 产出
//     命令退出码证据；证据见 scripts/reliability/dsh-acp/evidence/phase7-exit-code-wire.json）。
//     其余 scorecard 检查照常判定。
function scorecardChecksFromResult(result, { reportsCommandExitCode = null } = {}) {
  const scorecardChecks = Array.isArray(result?.scorecard?.checks) && result.scorecard.checks.length > 0
    ? result.scorecard.checks
    : null;
  const mapCheck = (c) =>
    check(c.name, c.passed, strictCategoryForScorecardCheck(c.name), c.detail ?? c.evidence, {
      capability: capabilityForScorecardCheck(c.name),
    });
  if (reportsCommandExitCode === false) {
    const observedCommandsCheck = scorecardChecks?.find((c) => c.name === "commandsPassed") ?? null;
    const rest = scorecardChecks
      ? scorecardChecks.filter((c) => c.name !== "commandsPassed").map(mapCheck)
      : [
        check("filesExist", false, "strict", "no scorecard checks in run result — completed-substitution is forbidden (ADR-0032 §8)", { capability: "fileEvidence" }),
        check("hasEvidence", false, "strict", "no scorecard checks in run result — completed-substitution is forbidden (ADR-0032 §8)", { capability: "toolEvidence" }),
      ];
    return [
      scorecardCommandFailureIsCredible(observedCommandsCheck)
        ? mapCheck(observedCommandsCheck)
        : naCheck(
          "commandsPassed",
          "backend declares reportsCommandExitCode=false — WAO cannot produce command exit-code evidence for this harness today (ACP exit codes live only in the client terminal API; tool_call_update carries free-form text only — evidence: scripts/reliability/dsh-acp/evidence/phase7-exit-code-wire.json)",
          "strict",
          { capability: "commandEvidence" },
        ),
      ...rest,
    ];
  }
  if (scorecardChecks) {
    return scorecardChecks.map(mapCheck);
  }
  return [
    check("commandsPassed", false, "strict", "no scorecard checks in run result — completed-substitution is forbidden (ADR-0032 §8)", { capability: "commandEvidence" }),
    check("filesExist", false, "strict", "no scorecard checks in run result — completed-substitution is forbidden (ADR-0032 §8)", { capability: "fileEvidence" }),
    check("hasEvidence", false, "strict", "no scorecard checks in run result — completed-substitution is forbidden (ADR-0032 §8)", { capability: "toolEvidence" }),
  ];
}

function strictCategoryForScorecardCheck(name) {
  if (name === "hasAssistantText" || name === "hasDoneEvent") return "core";
  return "strict";
}

function capabilityForScorecardCheck(name) {
  const map = {
    commandsPassed: "commandEvidence",
    filesExist: "fileEvidence",
    hasEvidence: "toolEvidence",
    hasAssistantText: "assistantText",
    hasDoneEvent: "complete",
  };
  return map[name];
}

function unsupportedDrillChecks(tc, handledDrills) {
  return tc.drills
    .filter((drill) => !handledDrills.has(drill))
    .map((drill) =>
      check(`unsupportedDrill:${drill}`, false, "operational", "drill is not implemented by run-reliability", { capability: drill })
    );
}

// --- 执行矩阵 ---
console.log("=== WAO Reliability Suite ===");
console.log(`serve: ${SERVE_URL}, registry: ${REGISTRY}`);
console.log(`profile: ${PROFILE_OVERRIDE ?? "from matrix/default"}`);
console.log(`sentinels: A=${SENTINEL_A}, B=${SENTINEL_B}`);
console.log("");

// 准备 sentinel 文件
mkdirSync(TMP_DIR, { recursive: true });
writeFileSync(join(TMP_DIR, "sent_a.txt"), SENTINEL_A);
writeFileSync(join(TMP_DIR, "sent_b.txt"), SENTINEL_B);
// TD-186 复核 FAIL-B：drill 转录目录（sentinel/scorecard 派发 --run-dir 到此）。
mkdirSync(DRILL_TRANSCRIPTS_DIR, { recursive: true });

const results = [];
let allPass = true;

for (const tc of MATRIX) {
  console.log(`[RUN] ${tc.label} (${tc.agentId})...`);
  const info = agentInfo(tc.agentId);
  const caseResult = {
    caseId: tc.label,
    agentId: tc.agentId,
    ...info,
    backend: tc.backend ?? info.backend,
    providerID: tc.providerID ?? info.providerID,
    modelId: tc.modelId ?? info.modelId,
    // R23-C：case 声明的认证身份含 providerKey（matrix 行从 registry 派生，与
    // agentInfo 同源；null = 已观察无接入方，undefined 只留给 legacy 旧记录）。
    providerKey: tc.providerKey ?? info.providerKey,
    // TD-186（2026-09-22）：证据绑定执行画像——值全部来自本次运行实际派发的
    // agent 配置（agentInfo 读 registry.agents[agentId]，与派发同源；matrix
    // normalizeCase 已保证行值不覆盖 agent 值）。drillRunIds 在各 drill 跑完后
    // 回填（见 checks 汇总处）。旧 case 不补猜：merge 保留原样（无该字段）。
    executionProfile: {
      modelId: tc.modelId ?? info.modelId,
      providerID: tc.providerID ?? info.providerID,
      providerKey: tc.providerKey ?? info.providerKey,
      effort: info.effort,
      runtime: runtimeIdentityFor(registry.agents?.[tc.agentId]),
      codeRef: GIT_HEAD,
      capturedAt: new Date().toISOString(),
      drillRunIds: {},
    },
    completionMode: tc.completionMode ?? info.completionMode,
    requiredCategories: tc.requiredCategories,
    profile: tc.profile,
    drills: tc.drills,
    runId: "unknown",
    completed: false,
    failed: false,
    timedOut: false,
    assistantTextCount: 0,
    sentinelA: false,
    sentinelB: false,
    metricsInput: null,
    error: null,
  };

  // 断言
  const checks = [];
  const handledDrills = new Set();

  if (tc.drills.includes("sentinel")) {
    handledDrills.add("sentinel");
    const prompt = `Read sent_a.txt and sent_b.txt in this directory, then reply with one line of JSON: {"a":"<sent_a.txt content>","b":"<sent_b.txt content>"}`;
    const { ok, stdout, error } = runCli([
      "run", tc.agentId,
      "--prompt", prompt,
      "--wait-timeout", WAIT_TIMEOUT,
      "--poll-interval", POLL_INTERVAL,
      "--registry", REGISTRY,
      "--cwd", TMP_DIR,
      // TD-186 复核 FAIL-B：sentinel 的 runId 会进 executionProfile.drillRunIds，
      // 转录必须落在可回查位置（TMP_DIR 收尾会被整体删除）。
      "--run-dir", DRILL_TRANSCRIPTS_DIR,
      "--format", "json",
    ]);

    const result = extractJson(stdout || "");
    caseResult.runId = result?.runId ?? "unknown";
    caseResult.completed = result?.completed ?? false;
    caseResult.failed = result?.failed ?? false;
    caseResult.timedOut = result?.timedOut ?? false;
    caseResult.assistantTextCount = result ? countAssistantText(result) : 0;
    caseResult.sentinelA = result ? hasSentinel(result, SENTINEL_A) : false;
    caseResult.sentinelB = result ? hasSentinel(result, SENTINEL_B) : false;
    caseResult.metricsInput = result?.metrics?.tokens?.input ?? null;
    caseResult.error = result?.error ?? (ok ? null : error);

    if (tc.expectComplete) {
      checks.push(check("completed", caseResult.completed, "core", `completed=${caseResult.completed}`, { capability: "complete" }));
    }
    if (tc.expectText) {
      checks.push(check("hasAssistantText", caseResult.assistantTextCount > 0, "core", `assistantTextCount=${caseResult.assistantTextCount}`, { capability: "assistantText" }));
    }
    checks.push(check("sentinelA", caseResult.sentinelA, "core", SENTINEL_A, { capability: "readFiles" }));
    checks.push(check("sentinelB", caseResult.sentinelB, "core", SENTINEL_B, { capability: "readFiles" }));
    // metrics 非零（session endpoint 提取）。TD-87 认证面症状解除（2026-08-20，
    // Owner 批准）：检查自起按 backend 能力声明条件适用——判定源是 ADR-0025
    // 批次 2 的 backendCapabilitySnapshot SSOT（scripts/reliability/metricsCheck.mjs
    // 消费，无第二套判定；取代旧的 providerID 名字分支）。声明不上报 usage 的
    // lane（如 kimi-code）按"通过 + detail 明示不适用"落账——测的是已声明的
    // backend 静态属性，不是组合质量；声明上报的 lane 断言不变（parser 回归
    // 金丝雀：流格式变化致 metrics 投影断裂时第一时间红）。
    checks.push(metricsNonZeroCheck({
      agent: registry.agents?.[tc.agentId],
      metricsInput: caseResult.metricsInput,
    }));
  }

  if (tc.drills.includes("scorecard")) {
    handledDrills.add("scorecard");
    console.log(`    [DRILL] scorecard command/file evidence...`);
    const drill = runStrictScorecardDrill(tc);
    caseResult.scorecardRunId = drill.result?.runId ?? "unknown";
    caseResult.scorecardError = drill.error;
    caseResult.scorecardFile = drill.fileName;
    // reportsCommandExitCode 条件化（ADR-0032 §8 + 诚实声明）：声明 false 的
    // backend，commandsPassed 记 N/A——判定源是 backendCapabilitySnapshot SSOT。
    const capabilitySnapshot = backendCapabilitySnapshot(registry.agents?.[tc.agentId]);
    checks.push(...scorecardChecksFromResult(drill.result, {
      reportsCommandExitCode: capabilitySnapshot?.reportsCommandExitCode ?? null,
    }));
    // ADR-0032 §8：文件证据 = 存在 + 内容承载 sentinel（旧实现只查存在）。
    checks.push(check(
      "fileMaterialized",
      drill.fileExists === true && drill.fileContentMatches === true,
      "strict",
      drill.fileExists === true && drill.fileContentMatches === true
        ? `${drill.fileName} exists and carries ${drill.fileSentinel}`
        : `fileExists=${drill.fileExists}, contentCarriesSentinel=${drill.fileContentMatches} (${drill.fileName}) — existence alone is not file evidence (ADR-0032 §8)`,
      { capability: "fileMaterialized" },
    ));
  }

  if (tc.drills.includes("isolation")) {
    handledDrills.add("isolation");
    console.log(`    [DRILL] isolate worktree...`);
    checks.push(...runIsolationDrill(tc));
  }

  if (tc.drills.includes("adversarialEscape")) {
    handledDrills.add("adversarialEscape");
    console.log(`    [DRILL] adversarial escape interception...`);
    checks.push(...runAdversarialEscapeDrill(tc));
  }

  if (tc.drills.includes("workflowRunDir")) {
    handledDrills.add("workflowRunDir");
    console.log(`    [DRILL] workflow run-dir colocation...`);
    checks.push(...runWorkflowRunDirDrill(tc));
  }

  if (tc.drills.includes("stop")) {
    handledDrills.add("stop");
    console.log(`    [DRILL] stop/abort audit...`);
    checks.push(...runStopDrill(tc));
  }

  checks.push(...unsupportedDrillChecks(tc, handledDrills));

  // TD-186：该 case 各 drill 的 runId——runner 直接可观察的 drill（sentinel/scorecard）
  // 记实际 runId；drills.mjs 只回 checks、不上抛内部 runId 的 drill（isolation/
  // adversarialEscape/workflowRunDir/stop）如实记 null。派发失败/无 runId 时的
  // "unknown" 占位也如实归 null——它不是可回查 id，入账即悬空指针（复核 FAIL-B
  // 硬禁令：不得记录指向不存在证据的 id）。
  const resolvableRunId = (value) =>
    typeof value === "string" && value.length > 0 && value !== "unknown" ? value : null;
  caseResult.executionProfile.drillRunIds = Object.fromEntries(
    tc.drills.map((drill) => [
      drill,
      drill === "sentinel"
        ? resolvableRunId(caseResult.runId)
        : drill === "scorecard"
          ? resolvableRunId(caseResult.scorecardRunId)
          : null,
    ]),
  );

  // ADR-0032 §8 五态判定：
  //   caseFailed = 存在 fail / blocked / inconclusive 检查（真失败/真阻塞——拉倒 allPass）。
  //   pass（全绿时间戳基准）= 无上述状态 且 至少一条 pass（全 N/A 的 case 不得
  //   记全绿——N/A 不贡献绿，只有 skip 的运行不得报 ALL PASS，ADR-0032 §7）。
  const caseFailed = checks.some((c) => ["fail", "blocked", "inconclusive"].includes(checkStateOf(c)));
  const pass = !caseFailed && checks.some((c) => checkStateOf(c) === "pass");
  if (caseFailed) allPass = false;
  caseResult.checks = checks;
  caseResult.pass = pass;
  // TD-111: case 全绿 → 本次运行的 ISO 时间；非全绿 → null（新鲜度由 summarizeWorkers
  // 聚合成 per-worker lastHealthyRunAt；merge 时 fresh 覆盖同 caseId，重认证失败会刷新旧时间）。
  caseResult.lastHealthyRunAt = pass ? new Date().toISOString() : null;
  caseResult.certification = certifyCase(caseResult);
  results.push(caseResult);

  const status = caseFailed ? "FAIL" : (pass ? "PASS" : "NO-POSITIVE-EVIDENCE");
  console.log(`  [${status}] ${tc.label} -> ${caseResult.certification.status} (${caseResult.certification.recommendedUse})`);
  for (const c of checks) {
    const icon = checkStateOf(c) === "pass" ? "✔" : checkStateOf(c) === "not-applicable" ? "○" : "✖";
    console.log(`    ${icon} ${c.name} [${c.category}]: ${c.detail}`);
  }
  if (caseResult.certification.reason) console.log(`    certification: ${caseResult.certification.reason}`);
  if (caseResult.error) console.log(`    error: ${caseResult.error}`);
  if (caseResult.scorecardError) console.log(`    scorecard error: ${caseResult.scorecardError}`);
  console.log("");
}

// silentTimeout 验证（用 bad-provider 配置）。
// 注：此探针依赖 opencode-serve（已降级为 fallback，决策 0005）。主力 lane 全是进程式 backend，
// silent-timeout 机制已在进程式 backend 实现（TD-43，2026-06-25）；此探针对 opencode-serve（fallback lane）仍有效。
// ADR-0032 §8（2026-09-21 修复）：serve 不可达时不再写"通过"（旧坏模式：silentPass=true
// 顶绿）——检查如实记 not-applicable + 原因（fallback lane down）；不置绿、不算失败，
// allPass/退出码只受真失败影响。
console.log("[RUN] silentTimeout early-fail test...");
let serveReachable = false;
try {
  const probeRes = await fetch(`${SERVE_URL}/`, { method: "GET", signal: AbortSignal.timeout(3000) });
  serveReachable = probeRes.ok || probeRes.status < 500;
} catch {
  serveReachable = false;
}

let silentState = "fail";
let silentElapsed = 0;
let silentResult = null;
let silentCheck;
if (!serveReachable) {
  console.log(`  [N/A] silentTimeout: opencode-serve not reachable at ${SERVE_URL} (fallback lane down; process-based silent-timeout covered by TD-43 unit tests)`);
  silentState = "not-applicable";
  silentCheck = naCheck(
    "silentTimeout",
    `opencode-serve not reachable at ${SERVE_URL} — the fallback-lane silent-timeout probe has no surface in this run (process-based silent-timeout is covered by TD-43 unit tests); recorded not-applicable, never as a pass (ADR-0032 §8)`,
    "operational",
    { capability: "silentTimeout" },
  );
} else {
  const badConfig = {
    agents: {
      _silent_test: {
        backend: "opencode-serve", serveUrl: SERVE_URL, agent: "build",
        cwd: TMP_DIR, completionMode: "first-stable",
        model: { providerID: "zhipuai-coding-plan", id: "nonexistent-model-test" },
      },
    },
  };
  const badConfigPath = join(TMP_DIR, "bad-agents.json");
  writeFileSync(badConfigPath, JSON.stringify(badConfig));
  const silentStart = Date.now();
  const { stdout: silentOut } = runCli([
    "run", "_silent_test", "--prompt", "test",
    "--wait-timeout", "60000", "--poll-interval", "2000",
    "--silent-timeout", "12000",
    "--registry", badConfigPath, "--format", "json",
  ]);
  silentElapsed = Date.now() - silentStart;
  silentResult = extractJson(silentOut || "");
  const silentPass = silentResult?.failed === true &&
               /silent timeout/i.test(silentResult?.error ?? "") &&
               silentElapsed < 25000;
  silentState = silentPass ? "pass" : "fail";
  silentCheck = check("silentTimeout", silentPass, "operational", `failed=${silentResult?.failed}, elapsed=${silentElapsed}ms`, { capability: "silentTimeout" });
  console.log(`  [${silentPass ? "PASS" : "FAIL"}] silentTimeout: failed=${silentResult?.failed}, elapsed=${silentElapsed}ms`);
}
if (silentState === "fail") allPass = false;
// suite case 的全绿基准：N/A 不置绿（pass=false → lastHealthyRunAt=null），但也不算失败。
const silentCasePass = silentState === "pass";
results.push({
  caseId: "silentTimeout",
  requiredCategories: ["operational"],
  recommendedUse: "suite-operational-check",
  checks: [silentCheck],
  certification: certifyCase({
    caseId: "silentTimeout",
    requiredCategories: ["operational"],
    recommendedUse: "suite-operational-check",
    checks: [silentCheck],
    error: silentResult?.error,
  }),
  pass: silentCasePass,
  // TD-111: suite-level case 同样记录全绿时间（无 agentId，不进 worker 聚合，仅保 case 级一致）。
  lastHealthyRunAt: silentCasePass ? new Date().toISOString() : null,
  failed: silentResult?.failed,
  elapsedMs: silentElapsed,
  error: serveReachable ? silentResult?.error : `not-applicable (opencode-serve not reachable at ${SERVE_URL})`,
});

// 清理（Windows 下可能有文件锁，try/catch 不阻断结果输出）
try {
  rmSync(TMP_DIR, { recursive: true, force: true });
} catch {
  console.log(`(cleanup skipped: ${TMP_DIR} locked, remove manually)`);
}

// 输出 summary
const summaryPath = resolve(ROOT, "runs", "reliability-summary.json");
try { mkdirSync(RUNS_DIR, { recursive: true }); } catch {}
// 增量合并：读磁盘旧 summary 的 cases，与本次 results 合并。
// 本次 case 覆盖同 caseId（重认证刷新），未重跑的旧 case 保留（不丢失其他 worker）。
// 解决"单跑 --agent X 覆盖掉全量 summary"的数据完整性缺口。
let priorCases = [];
try {
  const prior = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (Array.isArray(prior?.cases)) priorCases = prior.cases;
} catch {
  priorCases = []; // 无旧 summary 或解析失败 = 全新认证
}
// TD-87 清算（2026-08-20）：merge 前修剪已退出矩阵的僵尸 caseId——旧 label 的
// 陈年 case 不再拖累 worker 级最差聚合。注意 scope：MATRIX 是（可能经 --agent
// 过滤后的）当前矩阵行，pruneStaleCases 对不在矩阵 agentIds 里的 prior 不动。
const mergedCases = mergeCaseResults(pruneStaleCases(priorCases, MATRIX), results);
// TD-186 复核 FAIL-B 守卫（先于任何写盘）：本次运行记录的每个 drillRunId 必须有
// 转录在场（runs/reliability/<runId>.jsonl）。任一缺失 = 取证接线断裂——拒绝写
// 新 summary 并非零退出。宁可丢本次运行结果，绝不记录悬空 id（硬禁令：记录一个
// 指向随后被删除/不存在的证据的 id）。
const freshRunIds = collectReferencedDrillRunIds({ cases: results });
const missingFresh = missingDrillTranscripts(freshRunIds, DRILL_TRANSCRIPTS_DIR);
if (missingFresh.length > 0) {
  console.error(
    `[reliability] ERROR: ${missingFresh.length} 个本次运行的 drillRunIds 无对应转录（runs/reliability/<runId>.jsonl 不在场）——拒绝写入 summary（硬禁令：不得记录不可回查的 id）。这属于取证接线 bug，请上报。`,
  );
  process.exit(3);
}
// 旧版取证遗留的悬空 prior id（转录当时写在已被清理的临时目录）：写盘前如实置
// null（不可回查就不记 id）+ 逐条告警——写出的 summary 不含死指针；checks/status
// 等判定字段一字不动。
const { cases: closedCases, nulled: nulledPriorIds } = nullUnresolvableDrillRunIds(mergedCases, {
  transcriptsDir: DRILL_TRANSCRIPTS_DIR,
});
for (const n of nulledPriorIds.slice(0, 16)) {
  console.warn(`[reliability] WARN: case ${n.caseId} 的 drill ${n.drill} runId 转录不可回查（旧版取证遗留），已如实置 null`);
}
if (nulledPriorIds.length > 16) {
  console.warn(`[reliability] WARN: 另有 ${nulledPriorIds.length - 16} 条同类悬空 id 已置 null`);
}
const summary = summarizeCertification(closedCases);
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
// 2026-09-22 审计收口（交错发布误删证据）：发布路径到此为止，零删除。
// 旧版在此按【进程内】summary 的引用集清理 runs/reliability/——与其他发布者
// 不协调：A 写 summary→B 写 summary 并清理→A 恢复清理 ⇒ 最终 summary 引用的
// 转录不存在（B 写完中断、A 再收尾亦复现）。删除唯一入口 = 显式维护步骤
// （删除前重读磁盘 summary，只删「未被引用 且 超龄」的转录）。
console.log("Drill transcripts (runs/reliability/): publish path never deletes (audit fix 2026-09-22) — unreferenced transcripts are pruned only by the explicit maintenance step:");
console.log("  node scripts/wao-node.cjs scripts/reliability/prune-drill-transcripts.mjs [--max-age-days <n>] [--dry-run]");
console.log(`\nSummary written to ${summaryPath}`);
console.log(`Certification counts: ${JSON.stringify(summary.counts)}`);
console.log(`\n=== ${allPass ? "ALL PASS" : "SOME FAILED"} ===`);
process.exit(allPass ? 0 : 1);
