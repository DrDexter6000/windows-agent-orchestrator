#!/usr/bin/env node
/**
 * Smoke 脚本（M2 验收第 5 条）。
 *
 * 自动化真实 CLI smoke：探测可用 backend → 生成临时 registry → 跑极简 prompt → 验证状态链。
 *
 * 不进 npm test（依赖真实 API/登录/网络，会产生费用）。
 * 显式调用：npm run smoke 或 npm run smoke -- codex
 *
 * 解决的手动痛点：
 *   - 不用手 cd（脚本用 process.cwd()）
 *   - 不用手改 config 的 cwd（自动用真实目录）
 *   - 不用手查 transcript（自动验证状态链）
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readRegistry } from "./registry.js";
import { RunManager } from "./runManager.js";
import { ClaudeCodeBackend } from "./backends/claudeCode.js";
import { CodexBackend } from "./backends/codex.js";
import { OpenCodeServeBackend } from "./backends/opencodeServe.js";
import { readTranscript } from "./transcript.js";

const SMOKE_PROMPT = "Reply with exactly: smoke ok";

function cliAvailable(name) {
  try {
    execSync(`where ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 探测 opencode serve 端口（扫描 4297-4299）*/
async function probeOpenCodeServe() {
  for (const port of [4297, 4298, 4299]) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/session`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return port;
    } catch {
      // 端口未开，继续
    }
  }
  return null;
}

function backendFor(agent) {
  if (agent.backend === "opencode-serve") return new OpenCodeServeBackend();
  if (agent.backend === "claude-code") return new ClaudeCodeBackend();
  if (agent.backend === "codex") return new CodexBackend();
  throw new Error(`unknown backend ${agent.backend}`);
}

async function smokeOne(backendType, cwd, runDir) {
  const agentId = `smoke_${backendType}`;
  const registryPath = join(runDir, "agents.json");
  const ocPort = process.env.WAO_OPENCODE_PORT || "4297";
  const registryContent = {
    agents: {
      [agentId]:
        backendType === "opencode-serve"
          ? { backend: "opencode-serve", serveUrl: `http://127.0.0.1:${ocPort}`, agent: "build", cwd, model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" } }
          : { backend: backendType, cwd },
    },
  };
  await writeFile(registryPath, JSON.stringify(registryContent, null, 2));

  const config = { registry: registryPath, runDir, pollInterval: 1000, waitTimeout: 120000, timeout: 30000, retries: 0 };
  const manager = new RunManager({ config, readRegistry, backendFor });
  const run = await manager.start(agentId, {
    prompt: SMOKE_PROMPT, registry: registryPath, runDir,
    isolate: process.argv.includes("--isolate") ? true : undefined,
  });
  const waitResult = await run.waitForCompletion({ waitTimeout: 120000 });

  const events = await readTranscript(run.transcript.filePath);
  const stateChanges = events.filter((e) => e.type === "run.state_change").map((e) => e.to);
  const started = events.find((e) => e.type === "run.started");
  const messages = waitResult.messages ?? [];
  const assistantText = messages
    .filter((m) => m.info?.role === "assistant")
    .flatMap((m) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text))
    .join(" ");

  return {
    runId: run.runId,
    state: run.state,
    completed: waitResult.completed,
    stateChain: stateChanges,
    assistantText,
    transcript: run.transcript.filePath,
    worktreePath: started?.worktreePath ?? null,
  };
}

function report(name, result) {
  const ok = result.completed && result.state === "completed"
    && result.stateChain.includes("running")
    && result.stateChain.includes("completed");
  const tag = ok ? "✅ PASS" : "❌ FAIL";
  console.log(`\n${tag}  ${name}`);
  console.log(`  runId:     ${result.runId}`);
  console.log(`  state:     ${result.state}`);
  console.log(`  chain:     ${result.stateChain.join(" → ")}`);
  console.log(`  reply:     ${result.assistantText.slice(0, 100) || "(empty)"}`);
  if (result.worktreePath) console.log(`  worktree:  ${result.worktreePath}`);
  console.log(`  transcript:${result.transcript}`);
  return ok;
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const cwd = process.cwd();
  const runDir = await mkdtemp(join(tmpdir(), "wao-smoke-"));

  console.log(`smoke 工作目录: ${cwd}`);
  console.log(`transcript 目录: ${runDir}`);
  console.log(`prompt: "${SMOKE_PROMPT}"`);
  console.log(`⚠️  此脚本消耗真实 API token，调用真实 CLI`);

  // scorecard 专项 smoke（M6-7b）
  if (requested.includes("scorecard")) {
    const ok = await smokeScorecard(cwd, runDir);
    console.log(`\n保留 transcript 供检查: ${runDir}`);
    process.exit(ok ? 0 : 1);
  }

  // 探测可用 backend
  const candidates = [];
  if (cliAvailable("claude")) candidates.push("claude-code");
  if (cliAvailable("codex")) candidates.push("codex");
  // opencode 需要起 serve，默认不 smoke，除非显式要求
  if (requested.includes("opencode") || requested.includes("glm")) {
    const ocPort = await probeOpenCodeServe();
    if (ocPort) {
      console.log(`探测到 opencode serve: 127.0.0.1:${ocPort}`);
      candidates.push("opencode-serve");
      process.env.WAO_OPENCODE_PORT = String(ocPort);
    } else {
      console.log("⚠️  未探测到 opencode serve（扫描 4297-4299），跳过 opencode smoke");
    }
  }

  let filtered = requested.filter((r) => !["opencode", "glm"].includes(r));
  const targets = filtered.length > 0
    ? filtered.map((r) => (r === "claude" ? "claude-code" : r === "codex" ? "codex" : r)).filter((c) => candidates.includes(c))
    : candidates;

  if (targets.length === 0) {
    console.log("\n⚠️  没有可 smoke 的 backend。检查 claude/codex 是否在 PATH。");
    console.log("    claude:", cliAvailable("claude"));
    console.log("    codex:", cliAvailable("codex"));
    await rm(runDir, { recursive: true, force: true });
    process.exit(1);
  }

  console.log(`将 smoke: ${targets.join(", ")}`);

  let allOk = true;
  for (const t of targets) {
    try {
      const r = await smokeOne(t, cwd, runDir);
      if (!report(t, r)) allOk = false;
    } catch (error) {
      console.log(`\n❌ FAIL  ${t}`);
      console.log(`  error: ${error.message}`);
      allOk = false;
    }
  }

  console.log(`\n保留 transcript 供检查: ${runDir}`);
  process.exit(allOk ? 0 : 1);
}

/**
 * scorecard 专项 smoke（M6-7b）。
 * 两个场景：
 *   1. 满足：让 claude 创建一个文件，配 requireFiles → completed + scorecard passed:true
 *   2. 不满足：配一个不存在的 requireCommands → failed + scorecard passed:false
 *
 * 只用 claude-code（证据提取 M6-3 已实现）。
 */
async function smokeScorecard(cwd, runDir) {
  if (!cliAvailable("claude")) {
    console.log("\n⚠️  scorecard smoke 需要 claude CLI，未找到，跳过。");
    return false;
  }

  const registryPath = join(runDir, "agents.json");
  const agentId = "smoke_scorecard";
  const registryContent = {
    agents: {
      [agentId]: {
        backend: "claude-code", cwd,
        // 自动化场景需绕过 claude 权限检查，否则 Write/Bash 工具不真正执行
        args: ["--dangerously-skip-permissions"],
      },
    },
  };
  await writeFile(registryPath, JSON.stringify(registryContent, null, 2));
  const config = { registry: registryPath, runDir, pollInterval: 1000, waitTimeout: 180000, timeout: 30000, retries: 0 };

  let allOk = true;

  // 场景 1：满足。让 claude 用 Write 工具创建一个文件。
  const targetFile = "smoke_scorecard_output.txt";
  console.log("\n--- scorecard smoke 场景 1：证据满足（requireFiles）---");
  try {
    const manager = new RunManager({ config, readRegistry, backendFor });
    const run = await manager.start(agentId, {
      prompt: `Create a file named ${targetFile} in the current directory using the Write tool. Put the text "scorecard ok" inside it. Do not run any other commands.`,
      registry: registryPath, runDir,
      scorecard: { rules: { requireFiles: [targetFile], requireEvidence: true } },
    });
    const waitResult = await run.waitForCompletion({ waitTimeout: 180000 });

    const events = await readTranscript(run.transcript.filePath);
    const scEvent = events.find((e) => e.type === "scorecard.checked");
    const runEvents = events.filter((e) => e.type === "run.event");

    console.log(`  runId:        ${run.runId}`);
    console.log(`  state:        ${run.state}`);
    console.log(`  completed:    ${waitResult.completed}`);
    console.log(`  evidence:     ${runEvents.length} event(s) [${runEvents.map((e) => e.kind).join(", ")}]`);
    if (scEvent) {
      console.log(`  scorecard:    passed=${scEvent.passed}`);
      for (const c of scEvent.checks ?? []) {
        console.log(`    ${c.passed ? "✔" : "✖"} ${c.name}: ${c.evidence}${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }

    const ok = waitResult.completed && run.state === "completed" && scEvent?.passed === true;
    console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}  场景 1`);
    if (!ok) allOk = false;
  } catch (error) {
    console.log(`  ❌ FAIL  场景 1: ${error.message}`);
    allOk = false;
  }

  // 场景 2：不满足。配一个 claude 不会跑的命令。
  console.log("\n--- scorecard smoke 场景 2：证据不满足（requireCommands 缺失）---");
  try {
    const manager = new RunManager({ config, readRegistry, backendFor });
    const run = await manager.start(agentId, {
      prompt: "Reply with exactly: hello",
      registry: registryPath, runDir,
      scorecard: { rules: { requireCommands: ["this-command-does-not-exist-xyz"] } },
    });
    const waitResult = await run.waitForCompletion({ waitTimeout: 180000 });

    const events = await readTranscript(run.transcript.filePath);
    const scEvent = events.find((e) => e.type === "scorecard.checked");
    const lastChange = events.filter((e) => e.type === "run.state_change").at(-1);

    console.log(`  runId:        ${run.runId}`);
    console.log(`  state:        ${run.state}`);
    console.log(`  completed:    ${waitResult.completed}`);
    if (scEvent) {
      console.log(`  scorecard:    passed=${scEvent.passed}`);
      for (const c of scEvent.checks ?? []) {
        console.log(`    ${c.passed ? "✔" : "✖"} ${c.name}: ${c.evidence}${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }
    console.log(`  lastTransition: ${lastChange?.from}→${lastChange?.to}(${lastChange?.reason})`);

    const ok = !waitResult.completed && run.state === "failed"
      && scEvent?.passed === false && lastChange?.reason === "scorecard_failed";
    console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}  场景 2`);
    if (!ok) allOk = false;
  } catch (error) {
    console.log(`  ❌ FAIL  场景 2: ${error.message}`);
    allOk = false;
  }

  return allOk;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
