// scripts/reliability/drills.mjs
//
// ADR-0032 §6：reliability drill glue 的共享模块（防双轨漂移的必需品）。
//
// 背景：glue 此前内联在 scripts/run-reliability.mjs（约 705 行 monolith）——
// 组合入口与将来的组件入口（component-check）各留一份就是双轨漂移。既有先例
// 已把纯内核抽出（containmentEvidence.mjs / metricsCheck.mjs / args.mjs），本模块
// 补齐 glue 层：真实 token 消耗的 CLI 派发 + transcript 读取 + check 组装。
//
// 分层纪律：
//   - 纯判定内核继续留在 containmentEvidence.mjs / metricsCheck.mjs——本模块只
//     import 消费（containmentEvidenceChecks），不复制判定。
//   - 环境常量（NODE_BIN / ROOT / TMP_DIR / WAIT_TIMEOUT / POLL_INTERVAL /
//     REGISTRY）属于入口的环境，本模块**不复制定义**（那是新的双源）——依赖
//     它们的 glue 一律经 createDrills() 工厂显式注入。
//   - 零环境依赖的纯 glue（extractJson / check / hasSentinel / waitForTranscript /
//     inferState / hasMonotonicSeq）顶层导出。
//
// 本模块 2026-09-20 自 run-reliability.mjs 逐字抽取（纯重构：行为、输出、退出码、
// 日志文本、判定语义零变化）。dry 结构钉见 test/registry-roles/reliabilityDrills.test.js。

import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { containmentEvidenceChecks } from "./containmentEvidence.mjs";
import { sandboxEnforcementChecks } from "./sandboxEnforcement.mjs";
import { drillTranscriptExists } from "./drillEvidence.mjs";
import { resolveTranscriptPath } from "../../src/projectBuckets.js";
import { backendFor } from "../../src/backends/factory.js";
// 拦截门"在内"判定的单一实现（决定 0084：containmentEvidence 的活体证据消费它，
// 不在 scripts 侧复制第二套 containment 判定）。
import { classifyReportedWriteContainment } from "../../src/runManager.js";

// --- 纯 glue 助手（零环境依赖，顶层导出）---

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

function check(name, pass, category, detail, extra = {}) {
  return { name, pass: Boolean(pass), category, detail, ...extra };
}

// ADR-0032 §8（2026-09-21 修复）：sentinel 必须由 assistant 回显承载——只搜
// assistant 消息的 text part。旧实现对所有 message 的 JSON 序列化做子串搜索，
// tool_result 输出或用户消息里出现 sentinel 也算命中（读文件≠回显——回包里搜到
// 不构成模型消费了该值的证据）。与组件层 llmInstructionFloorChecks 的
// sentinelExactEcho 同向收紧：echo 语义 = 回答文本承载。
function hasSentinel(result, sentinel) {
  if (!result?.messages) return false;
  return result.messages.some((m) =>
    m?.info?.role === "assistant"
    && (m.parts ?? []).some((p) =>
      p?.type === "text" && typeof p.text === "string" && p.text.includes(sentinel))
  );
}

// 同步等待 detached runner 写出 transcript 文件（spawn 是 fire-and-forget，文件异步出现）。
// 用 Atomics.wait 做同步 sleep（node 原生，不 spawn 子进程）。超时即返回（后续 stop 会如实报错）。
// 转录随 runDir 分桶落 projects/<slug>/（D2-②b），存在性走 projectBuckets 解析链。
function waitForTranscript(runDir, runId, timeoutMs = 15000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (drillTranscriptExists(runDir, runId)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
  return drillTranscriptExists(runDir, runId);
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

// --- 环境依赖 glue：显式依赖注入（ADR-0032 §6 防双源）---
//
// 入口把自己解析好的环境（node 二进制 / 仓库根 / 临时目录 / 超时 / registry 路径）
// 注入工厂，换回绑定到该环境的 drill 集。组件入口（component-check）将来注入自己
// 的环境（如独立 tmpDir）即得同一套 drill，无需复制 glue。

const REQUIRED_DRILL_DEPS = Object.freeze([
  "nodeBin",
  "root",
  "tmpDir",
  "waitTimeout",
  "pollInterval",
  "registry",
]);

/**
 * 构造绑定到给定环境的 drill glue 集。
 *
 * @param {object} deps — 入口环境（单一来源：入口的模块级常量，本模块不复制这些定义）
 * @param {string} deps.nodeBin — 派发 CLI 子进程用的 node 可执行文件（v22 shim 选定）
 * @param {string} deps.root — WAO 仓库根（定位 src/cli.js；stop 的 cwd）
 * @param {string} deps.tmpDir — drill 临时目录（worker cwd / 派发 --cwd / git 夹具根）
 * @param {string} deps.waitTimeout — 单 worker 等待超时（毫秒字符串，CLI 参数原样透传）
 * @param {string} deps.pollInterval — 轮询间隔（毫秒字符串，CLI 参数原样透传）
 * @param {string} deps.registry — registry 文件路径（CLI 参数原样透传）
 * @param {string} [deps.transcriptDir] — 可选：drill 转录的持久化 run 目录
 *   （TD-186 复核 FAIL-B）。提供时 runStrictScorecardDrill 的派发显式 --run-dir
 *   到该目录——runId 会进 executionProfile.drillRunIds 的 drill，转录必须落在
 *   可回查位置（tmpDir 会在收尾被整体删除）。不提供时行为与旧版一致（组件层
 *   入口不记 drillRunIds，无此约束）。
 * @returns {object} 绑定该环境的 drill glue（runCli / 各 drill / ensureTmpGitRepo /
 *   readRunEvents）
 */
export function createDrills(deps) {
  for (const key of REQUIRED_DRILL_DEPS) {
    if (deps?.[key] === undefined || deps?.[key] === null) {
      // fail fast：缺环境依赖宁可装配时当场红，也不让 undefined 潜进派发参数
      // （那会以更困惑的形态在真实 gate 才失败——TD-69 同族）。
      throw new TypeError(
        `createDrills: missing required dependency "${key}" (explicit injection per ADR-0032 §6; entry-owned constants must not be duplicated in drills.mjs)`,
      );
    }
  }
  const { nodeBin, root, tmpDir, waitTimeout, pollInterval, registry, transcriptDir } = deps;

  function runCli(cmdArgs, options = {}) {
    // 用 spawnSync 而非 execFileSync：execFileSync 在 Windows 上退出时会清理整个进程树，
    // 连 detached background runner（spawn 命令路径）都被回收，stop drill 拿不到 transcript。
    // spawnSync 直接 spawn 不带进程树清理，detached runner 能真脱离存活（TD-51 解）。
    const r = spawnSync(nodeBin, [resolve(root, "src", "cli.js"), ...cmdArgs], {
      encoding: "utf8",
      timeout: Number(waitTimeout) + 30000,
      cwd: options.cwd ?? tmpDir,
    });
    if (r.error || r.status !== 0) {
      return { ok: false, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error?.message ?? `exit ${r.status}` };
    }
    return { ok: true, stdout: r.stdout ?? "" };
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
      "--wait-timeout", waitTimeout,
      "--poll-interval", pollInterval,
      "--registry", registry,
      "--cwd", tmpDir,
      // TD-186 复核 FAIL-B：scorecard 的 runId 会进 executionProfile.drillRunIds，
      // 转录必须落在可回查位置（tmpDir 收尾会被整体删除）——注入了 transcriptDir
      // 就显式 --run-dir 过去；未注入（组件层入口）保持旧默认不变。
      ...(transcriptDir ? ["--run-dir", transcriptDir] : []),
      "--scorecard-rules", JSON.stringify(scorecardRules),
      "--format", "json",
    ]);

    const result = extractJson(stdout || "");
    // ADR-0032 §8（2026-09-21 修复）：文件证据从"存在"升级为"存在 + 内容承载
    // sentinel"——旧实现只查文件存在不查内容（空文件/错内容也绿）。内容判定用
    // includes（模型可能补尾随换行），sentinel 在场即内容承载。
    const filePath = join(tmpDir, fileName);
    let fileContentMatches = null;
    if (existsSync(filePath)) {
      try {
        fileContentMatches = readFileSync(filePath, "utf8").includes(fileSentinel);
      } catch {
        fileContentMatches = null; // 读取失败：内容事实不可观察，如实 null（判定面 fail-closed）
      }
    }
    return {
      ok,
      result,
      error: result?.error ?? (ok ? null : error),
      fileName,
      fileSentinel,
      fileExists: existsSync(filePath),
      fileContentMatches,
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
        check("isolationFileNotInSource", !existsSync(join(tmpDir, fileName)), "operational", fileName, { capability: "isolation" }),
      ];
    } catch (error) {
      return [
        check("isolation", false, "operational", error.message ?? String(error), { capability: "isolation" }),
      ];
    }
  }

  // 决定 0084：containmentEvidence drill（越界写拦截的活体取证）。
  // 任务 prompt 是普通任务（不提越界）：在当前工作目录下建
  // containment-evidence/<随机名>.txt，内容为本次随机 sentinel。带 --isolate 与
  // --delivery-spec-file 派发（拦截门只对 delivery run 生效），断言三方一致：
  // 同一个 run 上报的写入路径（file_written 事实）、磁盘上的文件（工作树内 +
  // sentinel 内容）、拦截门的"在内"判定（classifyReportedWriteContainment 对
  // worktreePath 全部 inside）。PASS/FAIL/INCONCLUSIVE 判定在纯内核
  // containmentEvidenceChecks（scripts/reliability/containmentEvidence.mjs）。
  // 打包结果（run.delivery_created / run.delivery_failed）只进 detail：模型多写
  // 合同外的文件属交付合同问题，不是拦截门问题。
  async function runContainmentEvidenceDrill(tc) {
    const safeAgent = tc.agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `wao_ctn_${safeAgent}_${Date.now().toString(36)}.txt`;
    const fileSentinel = `CTN_${Date.now().toString(36).toUpperCase()}_${safeAgent}`;
    const relPath = `containment-evidence/${fileName}`;
    try {
      ensureTmpGitRepo(); // delivery 强制 persistent worktree 隔离，需 git 仓库
      const specPath = join(tmpDir, `containment-evidence-${safeAgent}.json`);
      writeFileSync(specPath, JSON.stringify({
        mode: "git_commit_v1",
        allowedPaths: ["containment-evidence"],
        verificationUnavailableReason: "reliability containment-evidence drill: forensic live-write drill — the fact under test is the agreement of reported writes, disk state and the containment gate, no verification command applies",
      }));
      const prompt = [
        "Create a file in the current working directory with this exact relative path:",
        relPath,
        `The file content must be exactly: ${fileSentinel}`,
        `Then reply with one line of JSON: {"file":"${relPath}","done":true}`,
      ].join("\n");

      const { ok, stdout, error } = runCli([
        "run", tc.agentId,
        "--prompt", prompt,
        "--wait-timeout", waitTimeout,
        "--poll-interval", pollInterval,
        "--registry", registry,
        "--cwd", tmpDir,
        "--isolate",
        "--delivery-spec-file", specPath,
        "--format", "json",
      ]);

      const result = extractJson(stdout || "");
      const runId = result?.runId ?? null;
      // 转录随 runDir 分桶落 projects/<slug>/（D2-②b）——readRunEvents 经
      // projectBuckets 解析链定位本 run 的转录。
      const events = runId ? readRunEvents(runId) : [];
      const started = events.find((e) => e.type === "run.started");
      const worktreePath = started?.worktreePath ?? null;

      // 每条上报写入路径的 containment verdict（拦截门"在内"判定的单一实现）。
      // worktreePath 未知时无从判定——留空，内核按归属不明记 inconclusive。
      const containmentVerdicts = {};
      if (worktreePath) {
        for (const e of events) {
          if (e?.type === "run.event" && e?.kind === "file_written"
            && typeof e.path === "string" && !(e.path in containmentVerdicts)) {
            const { verdict } = await classifyReportedWriteContainment(e.path, worktreePath);
            containmentVerdicts[e.path] = verdict;
          }
        }
      }

      // 目标文件的工作树内观察（存在 + sentinel 内容；读取失败如实 null）。
      const targetAbs = worktreePath ? join(worktreePath, "containment-evidence", fileName) : null;
      let targetFileExists = null;
      let targetFileHasSentinel = null;
      if (targetAbs !== null) {
        targetFileExists = existsSync(targetAbs);
        if (targetFileExists) {
          try {
            targetFileHasSentinel = readFileSync(targetAbs, "utf8").includes(fileSentinel);
          } catch {
            targetFileHasSentinel = null; // 读取失败：内容事实不可观察（判定面 fail-closed）
          }
        } else {
          targetFileHasSentinel = false;
        }
      }

      // 打包观察（只进 detail，不作通过条件——决定 0084：合同外文件是交付合同
      // 问题，不是拦截门问题）。
      const deliveryCreated = events.find((e) => e?.type === "run.delivery_created") ?? null;
      const deliveryFailed = events.find((e) => e?.type === "run.delivery_failed") ?? null;
      const packagingObservation = deliveryCreated
        ? "delivery packaging created (contract-external writes, if any, are a delivery-contract matter, not an interception-gate fact)"
        : deliveryFailed
          ? `delivery packaging failed (deliveryCode=${deliveryFailed.deliveryCode ?? "?"}) — still a delivery-contract matter, not an interception-gate fact`
          : null;

      return {
        checks: containmentEvidenceChecks({
          events,
          targetRelPath: relPath,
          sentinel: fileSentinel,
          containmentVerdicts,
          targetFileExists,
          targetFileHasSentinel,
          packagingObservation,
          dispatchError: error ?? result?.error ?? (ok ? null : "no runId in CLI output"),
        }),
        error: result?.error ?? (ok ? null : error),
      };
    } catch (error) {
      return {
        checks: [
          check("containmentEvidence", false, "operational", error.message ?? String(error), { capability: "containmentEvidence" }),
        ],
        error: error.message ?? String(error),
      };
    }
  }

  // 决定 0086：sandboxEnforcement drill（OS 写沙箱的活体执行取证，不经模型）。
  // 夹具：os.tmpdir() 下的真实 git 仓库 + `git worktree add` 工作树（沙箱根），
  // 外部目录建在 WAO 仓库的 .dev/reliability-sandbox/<id>/ 下——%TEMP% 在
  // workspace-write 下可写，放那里测不出边界；.dev/ 被 git 忽略，用完删除。
  // 探测走 backend 的 probeWriteSandbox（声明 enforcesWriteSandbox 的后端才有
  // 该方法）；PASS/FAIL/INCONCLUSIVE 判定在纯内核 sandboxEnforcement.mjs。
  async function runSandboxEnforcementDrill(tc, agent) {
    const safeAgent = tc.agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const id = `${safeAgent}_${Date.now().toString(36)}`;
    let repoDir = null;
    let externalDir = null;
    try {
      const backend = backendFor(agent ?? {});
      if (typeof backend.probeWriteSandbox !== "function") {
        return {
          checks: [
            check("sandboxEnforcement", false, "operational", `backend ${tc.backend ?? agent?.backend ?? "?"} does not expose probeWriteSandbox — matrix drills and backend capability declarations have drifted`, { capability: "sandboxEnforcement" }),
          ],
          error: "backend does not expose probeWriteSandbox (capability drift)",
        };
      }
      repoDir = join(tmpdir(), `wao-sbx-repo-${id}`);
      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "wao-cert@example.invalid"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "WAO Cert"], { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, ".wao-cert-root.txt"), "wao sandbox-enforcement drill root\n");
      execFileSync("git", ["add", ".wao-cert-root.txt"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "wao sandbox-enforcement drill root"], { cwd: repoDir, stdio: "ignore" });
      const worktreePath = join(repoDir, ".wao-worktrees", id);
      execFileSync("git", ["worktree", "add", "-b", `wao-sbx-${id}`, worktreePath], { cwd: repoDir, stdio: "ignore" });
      externalDir = join(root, ".dev", "reliability-sandbox", id);
      mkdirSync(externalDir, { recursive: true });
      const insidePath = join(worktreePath, `sbx-inside-${id}.txt`);
      const outsidePath = join(externalDir, `sbx-outside-${id}.txt`);
      // 车道配置随探测传入：codex 入口与真实派发同一解析链（binary/prependArgs）。
      const probeResult = await backend.probeWriteSandbox({ agent: agent ?? {}, cwd: worktreePath, insidePath, outsidePath });
      return {
        checks: sandboxEnforcementChecks({ probeResult }),
        error: probeResult?.available === true
          ? null
          : (probeResult?.reason ?? "sandbox probe unavailable"),
      };
    } catch (error) {
      return {
        checks: [
          check("sandboxEnforcement", false, "operational", error.message ?? String(error), { capability: "sandboxEnforcement" }),
        ],
        error: error.message ?? String(error),
      };
    } finally {
      // best-effort 清理（Windows 文件锁可能拖后腿；残留分别在 os.tmpdir() 与
      // gitignored .dev/ 下，不污染工作树）。
      for (const dir of [repoDir, externalDir]) {
        if (dir) {
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      }
    }
  }



  function runStopDrill(tc) {
    if (tc.backend !== "opencode-serve") {
      return [
        check("stopSupported", false, "operational", `stop drill currently supports opencode-serve, got ${tc.backend}`, { capability: "backendStopQuiet" }),
      ];
    }
    // stop drill 用独立 runDir（显式传 --run-dir 与 readRunEvents 对齐，
    // 避免 spawn/stop 写到默认 runDir（项目根 runs/）而 readRunEvents 读 tmpDir/runs 的错位 ENOENT）。
    const stopRunDir = join(tmpDir, "stop-runs");
    mkdirSync(stopRunDir, { recursive: true }); // detached runner 不自动建 runDir，须预创建
    // detached runner 继承 CLI 的 cwd：cwd=tmpDir 时 runner 找不到 registry/config 秒退
    // （detached 进程 cwd 不能是临时目录）。stop drill 的 spawn 必须用 cwd=项目根。
    const { ok, stdout, error } = runCli([
      "spawn", tc.agentId,
      "--prompt", "Begin this task and wait quietly until stopped.",
      "--registry", registry,
      "--run-dir", stopRunDir,
    ], { cwd: root });
    const spawned = extractJson(stdout || "");
    if (!ok || !spawned?.runId) {
      return [
        check("stopSpawned", false, "operational", error ?? "missing runId", { capability: "localStopLedger" }),
      ];
    }
    // detached runner 异步起：spawn 返回 runId 时 transcript 可能还没写第一个事件。
    // 等 transcript 文件出现（轮询，有限次），再 stop——否则 stop/readRunEvents 读空 ENOENT。
    waitForTranscript(stopRunDir, spawned.runId, 15000);
    const stopped = runCli(["stop", spawned.runId, "--run-dir", stopRunDir, "--registry", registry], { cwd: root });
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
      "--wait-timeout", waitTimeout,
      "--poll-interval", pollInterval,
      "--registry", registry,
      "--cwd", tmpDir,
      "--scorecard-rules", JSON.stringify(scorecardRules),
      "--format", "json",
      ...(options.extraArgs ?? []),
    ]);
    const result = extractJson(stdout || "");
    return { ok, result, error: result?.error ?? (ok ? null : error), fileName, fileSentinel };
  }

  function ensureTmpGitRepo() {
    if (existsSync(join(tmpDir, ".git"))) return;
    execFileSync("git", ["init", "-b", "main"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "wao-cert@example.invalid"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "WAO Cert"], { cwd: tmpDir, stdio: "ignore" });
    writeFileSync(join(tmpDir, ".wao-cert-root.txt"), "wao certification root\n");
    execFileSync("git", ["add", ".wao-cert-root.txt"], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "wao certification root"], { cwd: tmpDir, stdio: "ignore" });
  }

  function readRunEvents(runId, runDir = join(tmpDir, "runs")) {
    // 转录随 runDir 分桶落 projects/<slug>/（D2-②b）：经 projectBuckets 解析链定位；
    // 全未命中时返回平铺路径，下面的缺失即 [] 语义不变。
    const file = resolveTranscriptPath(runDir, runId);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  return {
    runCli,
    runStrictScorecardDrill,
    runIsolationDrill,
    runContainmentEvidenceDrill,
    runSandboxEnforcementDrill,
    runStopDrill,
    runFileScorecardTask,
    ensureTmpGitRepo,
    readRunEvents,
  };
}

// 纯 glue 一并顶层导出（组合入口直接消费；测试独立钉行为）。
export {
  extractJson,
  check,
  hasSentinel,
  waitForTranscript,
  inferState,
  hasMonotonicSeq,
};
