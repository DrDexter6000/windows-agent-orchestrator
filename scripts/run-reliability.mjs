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
//
// 消耗真实 API token。不进 npm test。用 `npm run reliability` 手动触发。
//
// 用法：
//   npm run reliability                      # 全矩阵（需 serve 带 key 运行）
//   npm run reliability -- --agent coder     # 只跑指定 agent（增量合并，不覆盖其他 worker）
//   npm run reliability -- --serve-url http://127.0.0.1:4298
//   npm run reliability -- --profile strict  # 额外跑 command/file scorecard drill
//   npm run reliability -- --wait-timeout 300000  # 覆盖单 worker 超时（默认 300000）

import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { certifyCase, summarizeCertification, mergeCaseResults } from "./reliability/certification.mjs";
import { buildCertificationMatrix } from "./reliability/matrix.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RUNS_DIR = resolve(ROOT, "runs");
const TMP_DIR = resolve(__dirname, "reliability-tmp");

// reliability spawn 的 CLI 子进程也必须走 v22（与 npm run reliability 入口一致）。
// process.execPath 已是 shim 选定的 v22（因 npm run reliability 经 wao-node.cjs 转发），
// 直接复用，避免 execFileSync("node") 落回 PATH 里的 v24 被 versionGuard 拒。
const NODE_BIN = process.execPath;

// --- 参数解析 ---
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const SERVE_URL = getArg("serve-url") || "http://127.0.0.1:4298";
const REGISTRY = getArg("registry") || resolve(ROOT, "config", "agents.json");
const ONLY_AGENT = getArg("agent");
// 默认 300000（5min/worker）：strict profile 含 scorecard+isolation+workflow 多 drill，
// 120s 易在重 worker 上卡边界（codex/claude-code strict 单 worker 实测 30-60s，留余量）。
// 全量批跑时每个 worker 独立 runCli，此值是单 worker 上限，非全量总时长。
const WAIT_TIMEOUT = getArg("wait-timeout") || "300000";
const POLL_INTERVAL = getArg("poll-interval") || "2000";
const PROFILE_OVERRIDE = getArg("profile");

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

// --- 工具函数 ---
function runCli(cmdArgs, options = {}) {
  // 用 spawnSync 而非 execFileSync：execFileSync 在 Windows 上退出时会清理整个进程树，
  // 连 detached background runner（spawn 命令路径）都被回收，stop drill 拿不到 transcript。
  // spawnSync 直接 spawn 不带进程树清理，detached runner 能真脱离存活（TD-51 解）。
  const r = spawnSync(NODE_BIN, [resolve(ROOT, "src", "cli.js"), ...cmdArgs], {
    encoding: "utf8",
    timeout: Number(WAIT_TIMEOUT) + 30000,
    cwd: options.cwd ?? TMP_DIR,
  });
  if (r.error || r.status !== 0) {
    return { ok: false, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message ?? `exit ${r.status}` };
  }
  return { ok: true, stdout: r.stdout ?? "" };
}

function extractJson(stdout) {
  // CLI --format json 输出整块 JSON；failed 时可能是 stderr 的 JSON
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    // 尝试找第一个 { 到最后一个 }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
    return null;
  }
}

function countAssistantText(result) {
  if (!result?.messages) return 0;
  return result.messages.filter(
    (m) => m.info?.role === "assistant" &&
           m.parts?.some((p) => p.type === "text" && p.text),
  ).length;
}

function hasSentinel(result, sentinel) {
  if (!result?.messages) return false;
  return result.messages.some((m) =>
    JSON.stringify(m).includes(sentinel),
  );
}

function agentInfo(agentId) {
  const agent = registry.agents?.[agentId] ?? {};
  return {
    backend: agent.backend ?? null,
    providerID: agent.model?.providerID ?? null,
    modelId: agent.model?.id ?? null,
    completionMode: agent.completionMode ?? "snapshot-stable",
  };
}

function check(name, pass, category, detail, extra = {}) {
  return { name, pass: Boolean(pass), category, detail, ...extra };
}

function scorecardChecksFromResult(result) {
  if (result?.scorecard?.checks?.length) {
    return result.scorecard.checks.map((c) =>
      check(c.name, c.passed, strictCategoryForScorecardCheck(c.name), c.detail ?? c.evidence, {
        capability: capabilityForScorecardCheck(c.name),
      })
    );
  }
  const completed = result?.completed === true;
  return [
    check("commandsPassed", completed, "strict", `completed=${completed}`, { capability: "commandEvidence" }),
    check("filesExist", completed, "strict", `completed=${completed}`, { capability: "fileEvidence" }),
    check("hasEvidence", completed, "strict", `completed=${completed}`, { capability: "toolEvidence" }),
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

function runStrictScorecardDrill(tc) {
  const safeAgent = tc.agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `wao_cert_${safeAgent}_${Date.now().toString(36)}.txt`;
  const fileSentinel = `FILE_${Date.now().toString(36).toUpperCase()}_${safeAgent}`;
  const prompt = [
    `Create a file named ${fileName} in this directory containing exactly: ${fileSentinel}`,
    "Run this command: node --version",
    `Then reply with one line of JSON: {"file":"${fileName}","done":true}`,
  ].join("\n");
  const scorecardRules = {
    requireCommands: ["node --version"],
    requireFiles: [fileName],
    requireEvidence: true,
    requireAssistantText: true,
  };

  const { ok, stdout, error } = runCli([
    "run", tc.agentId,
    "--prompt", prompt,
    "--wait-timeout", WAIT_TIMEOUT,
    "--poll-interval", POLL_INTERVAL,
    "--registry", REGISTRY,
    "--cwd", TMP_DIR,
    "--scorecard-rules", JSON.stringify(scorecardRules),
    "--format", "json",
  ]);

  const result = extractJson(stdout || "");
  return {
    ok,
    result,
    error: result?.error ?? (ok ? null : error),
    fileName,
    fileSentinel,
    fileExists: existsSync(join(TMP_DIR, fileName)),
  };
}

function runIsolationDrill(tc) {
  const safeAgent = tc.agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `wao_isolate_${safeAgent}_${Date.now().toString(36)}.txt`;
  try {
    ensureTmpGitRepo();
    const result = runFileScorecardTask(tc, fileName, {
      promptPrefix: "Create this file in the current working directory only.",
      extraArgs: ["--isolate"],
    });
    const events = result.result?.runId ? readRunEvents(result.result.runId) : [];
    const started = events.find((e) => e.type === "run.started");
    const worktreePath = started?.worktreePath;
    return [
      check("isolationWorktreeCreated", Boolean(worktreePath), "operational", worktreePath ?? "missing worktreePath", { capability: "isolation" }),
      check("isolationFileInWorktree", Boolean(worktreePath && existsSync(join(worktreePath, fileName))), "operational", fileName, { capability: "isolation" }),
      check("isolationFileNotInSource", !existsSync(join(TMP_DIR, fileName)), "operational", fileName, { capability: "isolation" }),
    ];
  } catch (error) {
    return [
      check("isolation", false, "operational", error.message ?? String(error), { capability: "isolation" }),
    ];
  }
}

function runWorkflowRunDirDrill(tc) {
  const workflowRunDir = join(TMP_DIR, "workflow-runs");
  const workflowFile = join(TMP_DIR, `workflow-cert-${tc.agentId}.mjs`);
  const workflowId = `cert-${tc.agentId}`;
  writeFileSync(workflowFile, [
    "export default {",
    `  id: ${JSON.stringify(workflowId)},`,
    "  nodes: [",
    `    { id: "agent", type: "agent", agentId: ${JSON.stringify(tc.agentId)}, prompt: "Reply with exactly WAO_WORKFLOW_RUN_DIR_OK" },`,
    "  ],",
    "  edges: [],",
    "};",
    "",
  ].join("\n"));

  const { ok, stdout, error } = runCli([
    "workflow", "run", workflowFile,
    "--run-dir", workflowRunDir,
    "--wait-timeout", WAIT_TIMEOUT,
    "--registry", REGISTRY,
  ], { cwd: ROOT });
  const result = extractJson(stdout || "");
  const childRunId = result?.nodes?.agent?.runId;
  return [
    check("workflowCompleted", result?.completed === true, "operational", `completed=${result?.completed}`, { capability: "workflowRunDir" }),
    check("workflowTranscriptInRunDir", Boolean(result?.workflowRunId && existsSync(join(workflowRunDir, `${result.workflowRunId}.jsonl`))), "operational", result?.workflowRunId ?? "missing workflowRunId", { capability: "workflowRunDir" }),
    check("workflowChildTranscriptInRunDir", Boolean(childRunId && existsSync(join(workflowRunDir, `${childRunId}.jsonl`))), "operational", childRunId ?? "missing child runId", { capability: "workflowRunDir" }),
    ...(ok ? [] : [check("workflowRunDirError", false, "operational", error, { capability: "workflowRunDir" })]),
  ];
}

function runStopDrill(tc) {
  if (tc.backend !== "opencode-serve") {
    return [
      check("stopSupported", false, "operational", `stop drill currently supports opencode-serve, got ${tc.backend}`, { capability: "backendStopQuiet" }),
    ];
  }
  // stop drill 用独立 runDir（与 workflowRunDirDrill 同款：显式传 --run-dir 与 readRunEvents 对齐，
  // 避免 spawn/stop 写到默认 runDir（项目根 runs/）而 readRunEvents 读 TMP_DIR/runs 的错位 ENOENT）。
  const stopRunDir = join(TMP_DIR, "stop-runs");
  mkdirSync(stopRunDir, { recursive: true }); // detached runner 不自动建 runDir，须预创建
  // detached runner 继承 CLI 的 cwd：cwd=TMP_DIR 时 runner 找不到 registry/config 秒退
  // （detached 进程 cwd 不能是临时目录）。stop drill 的 spawn 必须用 cwd=项目根。
  const { ok, stdout, error } = runCli([
    "spawn", tc.agentId,
    "--prompt", "Begin this task and wait quietly until stopped.",
    "--registry", REGISTRY,
    "--run-dir", stopRunDir,
  ], { cwd: ROOT });
  const spawned = extractJson(stdout || "");
  if (!ok || !spawned?.runId) {
    return [
      check("stopSpawned", false, "operational", error ?? "missing runId", { capability: "localStopLedger" }),
    ];
  }
  // detached runner 异步起：spawn 返回 runId 时 transcript 可能还没写第一个事件。
  // 等 transcript 文件出现（轮询，有限次），再 stop——否则 stop/readRunEvents 读空 ENOENT。
  waitForTranscript(stopRunDir, spawned.runId, 15000);
  const stopped = runCli(["stop", spawned.runId, "--run-dir", stopRunDir, "--registry", REGISTRY], { cwd: ROOT });
  const stopResult = extractJson(stopped.stdout || "");
  const events = readRunEvents(spawned.runId, stopRunDir);
  // TD-37 尾巴收口：读产品路径产出的验证事件（cli.js stop → executeStopWithVerification）。
  //   - run.stop_verified  → serve 端 token/message 轮询确认真停 → check pass
  //   - run.stop_unverified → abort 后后台仍增长（06-18 事故复现路径）→ check fail + 附 delta/metric
  //   - 都没有 → 产品路径未跑到验证（异常），判 fail
  const stopVerified = events.find((e) => e.type === "run.stop_verified");
  const stopUnverified = events.find((e) => e.type === "run.stop_unverified");
  const quietCheck = stopVerified
    ? check("backendStopQuietVerified", true, "operational", "verified: serve session token/message stable across rounds", { capability: "backendStopQuiet" })
    : stopUnverified
      ? check("backendStopQuietVerified", false, "operational", `not verified: backend still active (metric=${stopUnverified.metric ?? "?"}, taskkill=${stopUnverified.taskkillCalled})`, { capability: "backendStopQuiet", delta: stopUnverified.delta })
      : check("backendStopQuietVerified", false, "operational", "not verified: no run.stop_verified/run.stop_unverified event (product verify path did not run)", { capability: "backendStopQuiet" });
  return [
    check("localStopRequested", stopResult?.stopped === true, "operational", `stopped=${stopResult?.stopped}`, { capability: "localStopLedger" }),
    check("localStopStateAborted", inferState(events) === "aborted", "operational", `state=${inferState(events)}`, { capability: "localStopLedger" }),
    check("stopSeqMonotonic", hasMonotonicSeq(events), "operational", "transcript seq monotonic", { capability: "transcriptSeq" }),
    quietCheck,
  ];
}

function runFileScorecardTask(tc, fileName, options = {}) {
  const fileSentinel = `FILE_${Date.now().toString(36).toUpperCase()}_${tc.agentId}`;
  const prompt = [
    options.promptPrefix ?? "Create this file in the current working directory.",
    `File name: ${fileName}`,
    `File content exactly: ${fileSentinel}`,
    "Run this command: node --version",
    `Then reply with one line of JSON: {"file":"${fileName}","done":true}`,
  ].join("\n");
  const scorecardRules = {
    requireCommands: ["node --version"],
    requireFiles: [fileName],
    requireEvidence: true,
    requireAssistantText: true,
  };
  const { ok, stdout, error } = runCli([
    "run", tc.agentId,
    "--prompt", prompt,
    "--wait-timeout", WAIT_TIMEOUT,
    "--poll-interval", POLL_INTERVAL,
    "--registry", REGISTRY,
    "--cwd", TMP_DIR,
    "--scorecard-rules", JSON.stringify(scorecardRules),
    "--format", "json",
    ...(options.extraArgs ?? []),
  ]);
  const result = extractJson(stdout || "");
  return { ok, result, error: result?.error ?? (ok ? null : error), fileName, fileSentinel };
}

function unsupportedDrillChecks(tc, handledDrills) {
  return tc.drills
    .filter((drill) => !handledDrills.has(drill))
    .map((drill) =>
      check(`unsupportedDrill:${drill}`, false, "operational", "drill is not implemented by run-reliability", { capability: drill })
    );
}

function ensureTmpGitRepo() {
  if (existsSync(join(TMP_DIR, ".git"))) return;
  execFileSync("git", ["init", "-b", "main"], { cwd: TMP_DIR, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "wao-cert@example.invalid"], { cwd: TMP_DIR, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "WAO Cert"], { cwd: TMP_DIR, stdio: "ignore" });
  writeFileSync(join(TMP_DIR, ".wao-cert-root.txt"), "wao certification root\n");
  execFileSync("git", ["add", ".wao-cert-root.txt"], { cwd: TMP_DIR, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "wao certification root"], { cwd: TMP_DIR, stdio: "ignore" });
}

function readRunEvents(runId, runDir = join(TMP_DIR, "runs")) {
  const file = join(runDir, `${runId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// 同步等待 detached runner 写出 transcript 文件（spawn 是 fire-and-forget，文件异步出现）。
// 用 Atomics.wait 做同步 sleep（node 原生，不 spawn 子进程）。超时即返回（后续 stop 会如实报错）。
function waitForTranscript(runDir, runId, timeoutMs = 15000, intervalMs = 500) {
  const file = join(runDir, `${runId}.jsonl`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
  return existsSync(file);
}

function inferState(events) {
  const stateChange = [...events].reverse().find((e) => e.type === "run.state_change");
  if (stateChange?.to) return stateChange.to;
  if (events.some((e) => e.type === "run.aborted" || e.type === "run.stop_requested")) return "aborted";
  if (events.some((e) => e.type === "run.completed")) return "completed";
  if (events.some((e) => e.type === "run.timed_out")) return "timed_out";
  if (events.some((e) => e.type === "run.error")) return "failed";
  return "pending";
}

function hasMonotonicSeq(events) {
  let previous = 0;
  for (const event of events) {
    if (typeof event.seq !== "number") continue;
    if (event.seq <= previous) return false;
    previous = event.seq;
  }
  return true;
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
    // metrics 非零（session endpoint 提取）—— Kimi 可能 0，标 optional
    if (tc.providerID !== "kimi-for-coding") {
      checks.push(check("metricsNonZero", (caseResult.metricsInput ?? 0) > 0, "observability", `input=${caseResult.metricsInput}`, { capability: "metrics" }));
    }
  }

  if (tc.drills.includes("scorecard")) {
    handledDrills.add("scorecard");
    console.log(`    [DRILL] scorecard command/file evidence...`);
    const drill = runStrictScorecardDrill(tc);
    caseResult.scorecardRunId = drill.result?.runId ?? "unknown";
    caseResult.scorecardError = drill.error;
    caseResult.scorecardFile = drill.fileName;
    checks.push(...scorecardChecksFromResult(drill.result));
    checks.push(check("fileMaterialized", drill.fileExists, "strict", drill.fileName, { capability: "fileMaterialized" }));
  }

  if (tc.drills.includes("isolation")) {
    handledDrills.add("isolation");
    console.log(`    [DRILL] isolate worktree...`);
    checks.push(...runIsolationDrill(tc));
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

  const pass = checks.every((c) => c.pass);
  if (!pass) allPass = false;
  caseResult.checks = checks;
  caseResult.pass = pass;
  caseResult.certification = certifyCase(caseResult);
  results.push(caseResult);

  const status = pass ? "PASS" : "FAIL";
  console.log(`  [${status}] ${tc.label} -> ${caseResult.certification.status} (${caseResult.certification.recommendedUse})`);
  for (const c of checks) {
    console.log(`    ${c.pass ? "✔" : "✖"} ${c.name} [${c.category}]: ${c.detail}`);
  }
  if (caseResult.certification.reason) console.log(`    certification: ${caseResult.certification.reason}`);
  if (caseResult.error) console.log(`    error: ${caseResult.error}`);
  if (caseResult.scorecardError) console.log(`    scorecard error: ${caseResult.scorecardError}`);
  console.log("");
}

// silentTimeout 验证（用 bad-provider 配置）。
// 注：此探针依赖 opencode-serve（已降级为 fallback，决策 0005）。主力 lane 全是进程式 backend，
// silent-timeout 机制已在进程式 backend 实现（TD-43，2026-06-25）；此探针对 opencode-serve（fallback lane）仍有效。
// 故 serve 不在时自动 skip，不污染 allPass/counts。
console.log("[RUN] silentTimeout early-fail test...");
let serveReachable = false;
try {
  const probeRes = await fetch(`${SERVE_URL}/`, { method: "GET", signal: AbortSignal.timeout(3000) });
  serveReachable = probeRes.ok || probeRes.status < 500;
} catch {
  serveReachable = false;
}

let silentPass = false;
let silentElapsed = 0;
let silentResult = null;
if (!serveReachable) {
  console.log(`  [SKIP] silentTimeout: opencode-serve not reachable at ${SERVE_URL} (fallback lane down; process-based silent-timeout covered by TD-43 unit tests)`);
  silentPass = true; // 不计为失败：探针对当前架构无意义
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
  silentPass = silentResult?.failed === true &&
               /silent timeout/i.test(silentResult?.error ?? "") &&
               silentElapsed < 25000;
  console.log(`  [${silentPass ? "PASS" : "FAIL"}] silentTimeout: failed=${silentResult?.failed}, elapsed=${silentElapsed}ms`);
}
if (!silentPass) allPass = false;
results.push({
  caseId: "silentTimeout",
  requiredCategories: ["operational"],
  recommendedUse: "suite-operational-check",
  checks: [
    check("silentTimeout", silentPass, "operational", serveReachable ? `failed=${silentResult?.failed}, elapsed=${silentElapsed}ms` : `skipped: opencode-serve not reachable at ${SERVE_URL}`, { capability: "silentTimeout" }),
  ],
  certification: certifyCase({
    caseId: "silentTimeout",
    requiredCategories: ["operational"],
    recommendedUse: "suite-operational-check",
    checks: [
      check("silentTimeout", silentPass, "operational", serveReachable ? `failed=${silentResult?.failed}, elapsed=${silentElapsed}ms` : `skipped: opencode-serve not reachable at ${SERVE_URL}`, { capability: "silentTimeout" }),
    ],
    error: silentResult?.error,
  }),
  pass: silentPass,
  failed: silentResult?.failed,
  elapsedMs: silentElapsed,
  error: serveReachable ? silentResult?.error : `skipped (opencode-serve not reachable at ${SERVE_URL})`,
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
const mergedCases = mergeCaseResults(priorCases, results);
const summary = summarizeCertification(mergedCases);
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(`\nSummary written to ${summaryPath}`);
console.log(`Certification counts: ${JSON.stringify(summary.counts)}`);
console.log(`\n=== ${allPass ? "ALL PASS" : "SOME FAILED"} ===`);
process.exit(allPass ? 0 : 1);
