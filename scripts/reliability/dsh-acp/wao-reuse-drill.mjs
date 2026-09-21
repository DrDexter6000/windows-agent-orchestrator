#!/usr/bin/env node
// scripts/reliability/dsh-acp/wao-reuse-drill.mjs
//
// ADR-0031 §3.6 Phase 6：deepseek-acp 会话复用关联面 —— 真实 WAO 派发 drill
//（正向跨 run 恢复 + 三条负向 fail-closed）。
//
// 复现（消耗真实 token，保持最小）：
//   node scripts/wao-node.cjs scripts/reliability/dsh-acp/wao-reuse-drill.mjs
// 前置：
//   - dsh（0.1.5-rc.x）在 PATH；
//   - ~/.wao/runtimes/dsh-acp/wao-contain.patch.yml 已由操作员安装（内容 =
//     scripts/reliability/dsh-acp/wao-contain-safe.patch.yml）；
//   - Windows 用户环境有 DEEPSEEK_API_KEY（WAO 的 user-env bridge 会取）。
//
// 入口边界（如实）：派发经 dispatchRun —— CLI `run --background` 与 MCP
// `run_dispatch` 共享的后台派发服务。CLI 每次派发注入一次性 leadSession（设计如此，
// docs/02-architecture.md §4.10），同身份复现需要稳定 leadSession，故本 drill 以固定
// 值模拟 MCP server 的稳定注入（MCP 注入面由 m11-11c MCP-1/MCP-2 单测钉住）。
// dispatchRun fork 出的 detached runner → RunManager.start → deepSeekAcp backend →
// 真实 dsh --profile acp → 真实 DeepSeek API 全链路真实。
//
// registry：默认只读外层主仓 config/agents.json（本 drill 所在 worktree 无该
// gitignored 文件），复制到 <repo>/.wao/runs/drill-agents.json（lane =
// coder_low_dsh_reuse：backend deepseek-acp + sessionReuse lead_workspace；
// 不改任何既有条目）。--registry-source <path> 可覆盖来源。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const srcUrl = (rel) => pathToFileURL(join(ROOT, rel)).href;
const { dispatchRun } = await import(srcUrl("src/application/runDispatch.js"));
const { readTranscript, findState, TERMINAL_STATES } = await import(srcUrl("src/transcript.js"));
const { deriveReuseKeyHash } = await import(srcUrl("src/application/sessionReuse.js"));

const AGENT_ID = "coder_low_dsh_reuse";
const LEAD = `phase6-drill-lead-${Date.now().toString(36)}`;
const MARKER = `WAO_REUSE_P6_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const WAIT_MS = 240_000;
const POLL_MS = 2_000;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const registrySource = argValue("--registry-source") ?? resolve(ROOT, "..", "..", "config", "agents.json");

// 夹具：复制 registry 到 <repo>/.wao/runs/（cwd 内；不改外层文件）。
const scratchDir = join(ROOT, ".wao", "runs");
const drillRegistry = join(scratchDir, "drill-agents.json");
const runDir = join(scratchDir, "phase6-reuse-runs");
mkdirSync(scratchDir, { recursive: true });
const registryRaw = readFileSync(registrySource, "utf8");
const registryJson = JSON.parse(registryRaw);
const lane = registryJson.agents?.[AGENT_ID];
if (!lane || lane.sessionReuse !== "lead_workspace" || lane.backend !== "deepseek-acp") {
  console.error(`registry source has no ${AGENT_ID} deepseek-acp/lead_workspace lane: ${JSON.stringify(lane)}`);
  process.exit(2);
}
writeFileSync(drillRegistry, registryRaw, "utf8");
rmSync(runDir, { recursive: true, force: true });
mkdirSync(runDir, { recursive: true });

const evidencePath = join(ROOT, "scripts", "reliability", "dsh-acp", "evidence", "phase6-session-reuse.json");
const evidence = {
  drill: "ADR-0031 §3.6 phase6 session-reuse association (real dispatch)",
  date: new Date().toISOString(),
  node: process.version,
  dsh: String(spawnSync("dsh", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  }).stdout ?? "").trim(),
  agentId: AGENT_ID,
  leadSession: "<fixed drill lead (simulates the MCP server's stable injection)>",
  marker: MARKER,
  entry: "dispatchRun (the shared background dispatch service used by CLI run --background and MCP run_dispatch); the detached runner / RunManager / deepSeekAcp / dsh / model chain is real",
  registrySource,
  runDir,
  steps: {},
};

function fail(note) {
  evidence.fatal = note;
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
  console.error("DRILL FAILED: " + note);
  process.exit(1);
}

async function eventsOf(runId) {
  try { return await readTranscript(join(runDir, `${runId}.jsonl`)); } catch { return []; }
}

async function waitForTerminal(runId) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const events = await eventsOf(runId);
    const state = findState(events.filter((e) => e && e.runId === runId));
    if (TERMINAL_STATES.includes(state)) return { state, events };
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return { state: "timeout", events: await eventsOf(runId) };
}

function assistantText(events) {
  return events
    .filter((e) => e?.type === "run.event" && e?.kind === "message" && e?.role === "assistant")
    .flatMap((e) => (e.parts ?? []).map((p) => p?.text ?? ""))
    .join("");
}

function fact(events, type, runId) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === type && events[i].runId === runId) return events[i];
  }
  return undefined;
}

async function dispatch(prompt, label) {
  const r = await dispatchRun({
    agentId: AGENT_ID,
    prompt,
    registryPath: drillRegistry,
    runDir,
    cwd: ROOT,
    leadSession: LEAD,
    waitTimeout: WAIT_MS,
  });
  evidence.steps[label] = { runId: r.runId, accepted: r.accepted, providerSessionRouting: r.providerSessionRouting };
  return r;
}

// ── 正向 run 1：建立可辨识上下文事实 ──
const r1 = await dispatch(
  `Remember this marker string for later: ${MARKER}\nReply with exactly one line: MARKER_STORED`,
  "run1",
);
if (!r1.accepted) fail("run1 not accepted");
if (r1.providerSessionRouting !== "first_turn_requested") fail(`run1 routing=${r1.providerSessionRouting}`);
const t1 = await waitForTerminal(r1.runId);
const sid1 = fact(t1.events, "session.created", r1.runId)?.backendSessionId;
evidence.steps.run1 = {
  ...evidence.steps.run1,
  state: t1.state,
  backendSessionId: sid1,
  runSessionReuseTurn: fact(t1.events, "run.session_reuse", r1.runId)?.turn,
  assistantEcho: assistantText(t1.events).slice(0, 200),
};
if (t1.state !== "completed") fail(`run1 state=${t1.state}`);
if (typeof sid1 !== "string" || sid1.length === 0) fail("run1 has no session.created.backendSessionId");
if (evidence.steps.run1.runSessionReuseTurn !== "first") fail("run1 run.session_reuse.turn !== first");

// ── 正向 run 2：同 lane 同身份再派发 → resume 且复述 marker ──
const r2 = await dispatch(
  "Reply with exactly the marker string you were asked to remember earlier, and nothing else.",
  "run2",
);
if (!r2.accepted) fail("run2 not accepted");
if (r2.providerSessionRouting !== "resume_requested") fail(`run2 routing=${r2.providerSessionRouting}`);
const t2 = await waitForTerminal(r2.runId);
const sid2 = fact(t2.events, "session.created", r2.runId)?.backendSessionId;
const echo2 = assistantText(t2.events);
evidence.steps.run2 = {
  ...evidence.steps.run2,
  state: t2.state,
  backendSessionId: sid2,
  runSessionReuseTurn: fact(t2.events, "run.session_reuse", r2.runId)?.turn,
  assistantEcho: echo2.slice(0, 200),
  resumeSystemFact: t2.events.some((e) => e?.type === "run.event" && e?.kind === "message" && e?.role === "system"
    && /session\/resume/.test(JSON.stringify(e.parts ?? []))),
};
const positivePass = t2.state === "completed"
  && evidence.steps.run2.runSessionReuseTurn === "resume"
  && sid2 === sid1
  && echo2.includes(MARKER)
  && evidence.steps.run2.resumeSystemFact === true;
evidence.positive = {
  pass: positivePass,
  claims: {
    sameAcpSessionAcrossRuns: sid2 === sid1,
    resumeTurnRouted: evidence.steps.run2.runSessionReuseTurn === "resume",
    contextCarried: echo2.includes(MARKER),
    resumeTranscriptFact: evidence.steps.run2.resumeSystemFact,
    terminalState: t2.state,
  },
};
if (!positivePass) fail(`positive drill failed: ${JSON.stringify(evidence.positive.claims)}`);

// ── 负向 A（R3 行 2）：前任转录 session.created.backendSessionId 改空 → 派发拒绝 ──
const priorPath = join(runDir, `${r2.runId}.jsonl`);
function rewritePrior(events, mutate) {
  writeFileSync(priorPath, events.map((e) => JSON.stringify(mutate(e))).join("\n") + "\n", "utf8");
}
rewritePrior(t2.events, (e) => (e?.type === "session.created" && e.runId === r2.runId
  ? { ...e, backendSessionId: "" }
  : e));
// Audit finding A5 [中] (2026-09-21): the original form inferred "no transcript
// was written" from the ABSENCE of a runId, so a dispatch that wrote a
// transcript and *then* threw would still record a green field. Snapshot the
// runs dir and compare — that is the actual claim.
const jsonlBefore = new Set(readdirSync(runDir).filter((n) => n.endsWith(".jsonl")));
let negA = { refused: false };
try {
  await dispatch("should be refused", "negA_dispatch");
} catch (error) {
  negA = { refused: true, message: error.message };
}
const addedTranscripts = readdirSync(runDir)
  .filter((n) => n.endsWith(".jsonl") && !jsonlBefore.has(n));
evidence.negativeA = {
  tamper: "prior transcript session.created.backendSessionId -> empty string",
  ...negA,
  addedTranscripts,
  noTranscriptForRefusedDispatch: addedTranscripts.length === 0,
  pass: Boolean(negA.refused
    && /no addressable provider session id/.test(negA.message ?? "")
    && addedTranscripts.length === 0),
};
rewritePrior(t2.events, (e) => e);
if (!evidence.negativeA.pass) fail(`negative A failed: ${JSON.stringify(negA)}`);

// ── 负向 B（R3 行 4）：路由条目损坏 → 派发拒绝（不是静默 first）──
const keyHash = deriveReuseKeyHash({ leadSession: LEAD, workspace: ROOT, agentId: AGENT_ID });
const entryPath = join(runDir, ".session-reuse", `${keyHash}.json`);
const entryBackup = readFileSync(entryPath, "utf8");
writeFileSync(entryPath, "{damaged-not-json", "utf8");
let negB = { refused: false };
try {
  await dispatch("should be refused", "negB_dispatch");
} catch (error) {
  negB = { refused: true, message: error.message };
}
evidence.negativeB = {
  tamper: "routing entry file -> unparseable bytes",
  ...negB,
  pass: Boolean(negB.refused && /routing entry.*damaged/.test(negB.message ?? "")),
};
writeFileSync(entryPath, entryBackup, "utf8");
if (!evidence.negativeB.pass) fail(`negative B failed: ${JSON.stringify(negB)}`);

// ── 负向 C（R3 行 3）：关联指向不存在的会话 → 上游 session/resume 拒绝 → run failed，
//    绝不静默 session/new（若回退，run 会以新会话 completed）。真实进程，零模型 token。──
const fakeSid = "11111111-2222-4333-8444-555555555555";
rewritePrior(t2.events, (e) => (e?.type === "session.created" && e.runId === r2.runId
  ? { ...e, backendSessionId: fakeSid }
  : e));
const r5 = await dispatch("resume attempt against a nonexistent session", "negC_dispatch");
if (!r5.accepted || r5.providerSessionRouting !== "resume_requested") {
  fail(`negative C dispatch shape unexpected: ${JSON.stringify(r5)}`);
}
const t5 = await waitForTerminal(r5.runId);
const err5 = fact(t5.events, "run.error", r5.runId);
// Audit finding A5 [中] (2026-09-21): the original predicate accepted ANY
// non-empty error text, so a credential/launch failure would also have passed.
// Require (a) the run failed at spawn with the upstream refusal shape AND
// (b) NO session.created for this run — the latter is what actually proves
// there was no silent fallback to session/new.
const noSessionCreated = !t5.events.some((e) => e && e.runId === r5.runId && e.type === "session.created");
evidence.negativeC = {
  tamper: `prior transcript session.created.backendSessionId -> well-formed nonexistent uuid (${fakeSid})`,
  state: t5.state,
  spawnError: err5?.error ?? null,
  noSessionCreatedForResumeAttempt: noSessionCreated,
  // Re-check finding R3 [中] (2026-09-21): the previous predicate was
  // `/-32602|not resumable/`, which also matches an unrelated `-32602 unknown
  // reasoning effort`. Require BOTH the code and the resume-specific message —
  // a session-config error must not be able to satisfy the resume-refusal claim.
  pass: t5.state === "failed"
    && typeof err5?.error === "string"
    && /-32602/.test(err5.error)
    && /not resumable/.test(err5.error)
    && noSessionCreated,
};
rewritePrior(t2.events, (e) => e);
if (!evidence.negativeC.pass) fail(`negative C failed: ${JSON.stringify(evidence.negativeC)}`);

// ── 收尾：写证据 ──
evidence.pass = true;
evidence.repro = [
  "node scripts/wao-node.cjs scripts/reliability/dsh-acp/wao-reuse-drill.mjs",
  "consumes real tokens (run1+run2 are small model turns; negC fails before the model)",
  "prereq: dsh on PATH; operator-installed ~/.wao/runtimes/dsh-acp/wao-contain.patch.yml; DEEPSEEK_API_KEY in Windows user env",
];
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
console.log("DRILL PASSED");
console.log(JSON.stringify({
  run1: evidence.steps.run1,
  run2: evidence.steps.run2,
  negativeA: { pass: evidence.negativeA.pass },
  negativeB: { pass: evidence.negativeB.pass },
  negativeC: { pass: evidence.negativeC.pass, state: evidence.negativeC.state },
  evidence: "scripts/reliability/dsh-acp/evidence/phase6-session-reuse.json",
}, null, 2));
