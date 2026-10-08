#!/usr/bin/env node
// scripts/reliability/session-reuse-drill.mjs
//
// TD-184：codex / kimi-code 会话复用关联面 —— 真实 WAO 派发 drill。
// 形状对齐 ADR-0031 §3.6 Phase 6 先例 scripts/reliability/dsh-acp/wao-reuse-drill.mjs
//（deepseek-acp），并按 2026-10-09 astra+opus 方案会审四项修正升级：
//   ① 进程式后端每个复用 run 有两条 session.created（spawn 占位 proc_<pid> +
//      终态前 late-bind native id，读取侧 LAST-bound 胜出）——证据行一律取
//      LAST-bound 且断言非 proc_ 占位（本脚本 nativeSessionId()）。
//   ② N-D 新会话差分对照：同 workspace 同车道、独立 leadSession（无前任可续）
//      发同样的复述 prompt——必须答不出暗号。加上 run1 转录零工具调用断言，
//      排除"暗号经 workspace 文件/上游跨会话记忆泄漏"的假阳性。
//   ③ 链深 ≥2：run3 续 run2——证明路由条目推进到 run2 且其 native id 可再取回
//      （TD-188 生产事故形状：若 run2 未再广告 native id，run3 会被 fail-closed
//      拒绝，本 drill 直接暴露）。
//   ④ N-C 重定义为"无 native id"：CLI 进程会先成功 spawn（占位事实会写）再死于
//      上游拒绝——证明无静默回退的事实是"从未观察到非占位 native id 且无
//      run.provider_session_bound"。上游在会话查找阶段拒绝（模型调用前），
//      本轮无 usage 事实，不宣称"零 token"。
//
// 复现（消耗真实 token，保持最小；每个后端各跑一次）：
//   node scripts/wao-node.cjs scripts/reliability/session-reuse-drill.mjs --backend codex
//   node scripts/wao-node.cjs scripts/reliability/session-reuse-drill.mjs --backend kimi-code
// 前置：
//   - codex 在 PATH 且已登录；kimi 在 PATH（~/.kimi-code/bin）且已登录；
//   - 主仓 config/agents.json 可读（只读复制，不改任何既有条目——scratch 车道
//     由脚本自建注入，不依赖外层注册表已有专用车道）。
//
// 证据覆盖边界（如实）：non-delivery 的 lead_workspace 车道。delivery 复用 run
// 走另一条写侧（run.provider_session_bound，TD188）不在本 drill 范围。

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcUrl = (rel) => pathToFileURL(join(ROOT, rel)).href;
const { dispatchRun } = await import(srcUrl("src/application/runDispatch.js"));
const { readTranscript, findState, TERMINAL_STATES } = await import(srcUrl("src/transcript.js"));
const { probeRuntimeIdentity } = await import(srcUrl("scripts/reliability/runtimeIdentity.mjs"));

// 每后端的 drill 配置：scratch 车道（注入复制件，不碰外层注册表）、证据路径、
// 负对照 C 的伪造 id 与上游拒绝文本形状（09-21 直跑实测锚点）。
const DRILL_BACKENDS = Object.freeze({
  codex: Object.freeze({
    identityBackend: "codex",
    agentId: "codex_reuse_probe",
    lane: Object.freeze({ backend: "codex", cwd: ".", model: { id: "gpt-6-astra" }, reasoning: { effort: "low" }, sessionReuse: "lead_workspace" }),
    evidenceRel: join("scripts", "reliability", "codex", "evidence", "phase6-session-reuse.json"),
    negativeCFakeId: "11111111-2222-4333-8444-555555555555",
    negativeCError: /no rollout found/i,
  }),
  "kimi-code": Object.freeze({
    identityBackend: "kimi-code",
    agentId: "kimi_code_reuse_probe",
    lane: Object.freeze({ backend: "kimi-code", cwd: ".", model: { id: "kimi-code/k3" }, sessionReuse: "lead_workspace" }),
    evidenceRel: join("scripts", "reliability", "kimi-code", "evidence", "phase6-session-reuse.json"),
    negativeCFakeId: "11111111-2222-4333-8444-555555555555",
    negativeCError: /Session .* not found/i,
  }),
});

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const backendName = argValue("--backend");
const cfg = DRILL_BACKENDS[backendName];
if (!cfg) {
  console.error(`usage: session-reuse-drill.mjs --backend <${Object.keys(DRILL_BACKENDS).join("|")}>`);
  process.exit(2);
}
// registry 来源：主仓优先（本 drill 在主仓跑），worktree 形态回退外层主仓。
const registrySource = argValue("--registry-source")
  ?? (existsSync(join(ROOT, "config", "agents.json"))
    ? join(ROOT, "config", "agents.json")
    : resolve(ROOT, "..", "..", "config", "agents.json"));

const AGENT_ID = cfg.agentId;
const LEAD = `phase6-drill-lead-${Date.now().toString(36)}`;
// N-D 差分对照用的独立 lead 身份：同 workspace 同车道但无前任可续 → 路由必为
// first（fresh provider 会话）。它不能复用 LEAD 的任何历史。
const LEAD_FRESH = `phase6-drill-lead-fresh-${Date.now().toString(36)}`;
const MARKER = `WAO_REUSE_P6_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const WAIT_MS = 300_000;
const POLL_MS = 2_000;

// 夹具：复制 registry 到 <repo>/.wao/runs/（cwd 内；不改外层文件），注入 scratch 车道。
const scratchDir = join(ROOT, ".wao", "runs");
const drillRegistry = join(scratchDir, `drill-agents-${backendName.replace(/-/g, "_")}.json`);
const runDir = join(scratchDir, `phase6-reuse-runs-${backendName.replace(/-/g, "_")}`);
mkdirSync(scratchDir, { recursive: true });
const registryRaw = readFileSync(registrySource, "utf8");
const registryJson = JSON.parse(registryRaw);
if (registryJson.agents?.[AGENT_ID]) {
  console.error(`registry source already has a ${AGENT_ID} lane — refusing to shadow a non-drill lane`);
  process.exit(2);
}
registryJson.agents = { ...(registryJson.agents ?? {}), [AGENT_ID]: cfg.lane };
writeFileSync(drillRegistry, JSON.stringify(registryJson, null, 2), "utf8");
rmSync(runDir, { recursive: true, force: true });
mkdirSync(runDir, { recursive: true });

const runtimeIdentity = probeRuntimeIdentity({ backendName: cfg.identityBackend, agent: cfg.lane });
if (runtimeIdentity.verified !== true) {
  console.error(`${backendName} runtime identity could not be verified: ${runtimeIdentity.reason ?? "unknown reason"}`);
  process.exit(2);
}

const evidencePath = join(ROOT, cfg.evidenceRel);
mkdirSync(dirname(evidencePath), { recursive: true });
const evidence = {
  drill: `TD-184 phase6 session-reuse association (real dispatch, ${backendName})`,
  format: "phase6-session-reuse-self-contained-v1",
  date: new Date().toISOString(),
  node: process.version,
  backend: backendName,
  runtimeIdentity,
  agentId: AGENT_ID,
  leadSession: "<fixed drill lead (simulates the MCP server's stable injection)>",
  marker: MARKER,
  entry: "dispatchRun (the shared background dispatch service used by CLI run --background and MCP run_dispatch); the detached runner / RunManager / backend / CLI / model chain is real",
  registrySource,
  scratchLane: { agentId: AGENT_ID, ...cfg.lane },
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

// 会审修①：native id 判定 = 该 run 的 LAST-bound session.created 且非 proc_ 占位
//（fact() 从尾部找 = LAST-bound；读取侧同语义）。
const PROC_PLACEHOLDER = /^proc_/;
function nativeSessionId(events, runId) {
  const sid = fact(events, "session.created", runId)?.backendSessionId;
  return typeof sid === "string" && sid.length > 0 && !PROC_PLACEHOLDER.test(sid) ? sid : null;
}

// 会审修②：run1 零工具断言的辅助——统计 tool_use/tool_result/command 事件数。
function toolEventCount(events, runId) {
  return events.filter((e) => e?.type === "run.event" && e.runId === runId
    && (e.kind === "tool_use" || e.kind === "tool_result" || e.kind === "command")).length;
}

async function dispatch(prompt, label, lead = LEAD) {
  const r = await dispatchRun({
    agentId: AGENT_ID,
    prompt,
    registryPath: drillRegistry,
    runDir,
    cwd: ROOT,
    leadSession: lead,
    waitTimeout: WAIT_MS,
  });
  evidence.steps[label] = { runId: r.runId, accepted: r.accepted, providerSessionRouting: r.providerSessionRouting };
  return r;
}

// ── 正向 run 1：建立可辨识上下文事实（禁工具禁写文件——差分对照的前提）──
const run1Prompt = `Remember this marker string for later: ${MARKER}\n`
  + "Do not use any tools. Do not read or write any files. Do not run any commands.\n"
  + "Reply with exactly one line: MARKER_STORED";
const r1 = await dispatch(run1Prompt, "run1");
if (!r1.accepted) fail("run1 not accepted");
if (r1.providerSessionRouting !== "first_turn_requested") fail(`run1 routing=${r1.providerSessionRouting}`);
const t1 = await waitForTerminal(r1.runId);
const sid1 = nativeSessionId(t1.events, r1.runId);
const run1ToolEvents = toolEventCount(t1.events, r1.runId);
evidence.steps.run1 = {
  ...evidence.steps.run1,
  state: t1.state,
  backendSessionId: sid1,
  runSessionReuseTurn: fact(t1.events, "run.session_reuse", r1.runId)?.turn,
  assistantEcho: assistantText(t1.events).slice(0, 200),
  toolEventCount: run1ToolEvents,
  evidenceRefs: {
    sessionCreated: "run1-session-created",
    sessionReuse: "run1-session-reuse",
    assistant: "run1-assistant",
    terminal: "run1-terminal",
  },
};
if (t1.state !== "completed") fail(`run1 state=${t1.state}`);
if (sid1 === null) fail("run1 has no late-bound native session.created.backendSessionId (proc_ placeholder only)");
if (evidence.steps.run1.runSessionReuseTurn !== "first") fail("run1 run.session_reuse.turn !== first");
if (run1ToolEvents !== 0) fail(`run1 used ${run1ToolEvents} tool/command events — marker may have leaked outside the conversation (differential control invalid)`);

// ── 正向 run 2：同 lane 同身份再派发 → resume 且复述 marker ──
const run2Prompt = "Reply with exactly the marker string you were asked to remember earlier, and nothing else.";
if (run2Prompt.includes(MARKER)) fail("internal: run2 prompt leaked the marker");
const r2 = await dispatch(run2Prompt, "run2");
if (!r2.accepted) fail("run2 not accepted");
if (r2.providerSessionRouting !== "resume_requested") fail(`run2 routing=${r2.providerSessionRouting}`);
const t2 = await waitForTerminal(r2.runId);
const sid2 = nativeSessionId(t2.events, r2.runId);
const echo2 = assistantText(t2.events);
evidence.steps.run2 = {
  ...evidence.steps.run2,
  state: t2.state,
  backendSessionId: sid2,
  runSessionReuseTurn: fact(t2.events, "run.session_reuse", r2.runId)?.turn,
  assistantEcho: echo2.slice(0, 200),
  evidenceRefs: {
    sessionCreated: "run2-session-created",
    sessionReuse: "run2-session-reuse",
    assistant: "run2-assistant",
    terminal: "run2-terminal",
  },
};
if (t2.state !== "completed") fail(`run2 state=${t2.state}`);
if (evidence.steps.run2.runSessionReuseTurn !== "resume") fail("run2 run.session_reuse.turn !== resume");
if (sid2 === null) fail("run2 has no late-bound native session id — a run3 would be fail-closed refused (TD-188 shape)");
if (!echo2.includes(MARKER)) fail("run2 did not echo the marker (context not carried)");

// ── 正向 run 3（会审修③，链深 ≥2）：路由条目应已推进到 run2，run3 续 run2 ──
const r3 = await dispatch(run2Prompt, "run3");
if (!r3.accepted) fail("run3 not accepted");
if (r3.providerSessionRouting !== "resume_requested") fail(`run3 routing=${r3.providerSessionRouting}`);
const t3 = await waitForTerminal(r3.runId);
const sid3 = nativeSessionId(t3.events, r3.runId);
const echo3 = assistantText(t3.events);
evidence.steps.run3 = {
  ...evidence.steps.run3,
  state: t3.state,
  backendSessionId: sid3,
  runSessionReuseTurn: fact(t3.events, "run.session_reuse", r3.runId)?.turn,
  assistantEcho: echo3.slice(0, 200),
  evidenceRefs: {
    sessionCreated: "run3-session-created",
    sessionReuse: "run3-session-reuse",
    assistant: "run3-assistant",
    terminal: "run3-terminal",
  },
};
if (t3.state !== "completed") fail(`run3 state=${t3.state}`);
if (evidence.steps.run3.runSessionReuseTurn !== "resume") fail("run3 run.session_reuse.turn !== resume");
if (sid3 === null) fail("run3 has no late-bound native session id — chain cannot continue");
if (!echo3.includes(MARKER)) fail("run3 did not echo the marker (chain context lost)");

// 上游 id 同一性作观测事实（不作门——暗号回显 + N-D 差分 + N-C 拒绝共同构成
// resume 证明；上游若在 resume 时铸造新 thread id，能力主张"跨 run 上下文携带"
// 仍成立，如实记录）。见文件头②与验证器形状表。
const sameProviderSessionObserved = sid2 === sid1 && sid3 === sid2;
const positivePass = t1.state === "completed" && t2.state === "completed" && t3.state === "completed"
  && evidence.steps.run2.runSessionReuseTurn === "resume"
  && evidence.steps.run3.runSessionReuseTurn === "resume"
  && sid1 !== null && sid2 !== null && sid3 !== null
  && echo2.includes(MARKER) && echo3.includes(MARKER);
evidence.positive = {
  pass: positivePass,
  sameProviderSessionObserved,
  claims: {
    resumeTurnRouted: evidence.steps.run2.runSessionReuseTurn === "resume"
      && evidence.steps.run3.runSessionReuseTurn === "resume",
    nativeSessionObservedAllRuns: sid1 !== null && sid2 !== null && sid3 !== null,
    sameProviderSessionAcrossRuns: sameProviderSessionObserved,
    contextCarried: echo2.includes(MARKER) && echo3.includes(MARKER),
    chainDepthTwoResumes: true,
    terminalState: t3.state,
  },
};
if (!positivePass) fail(`positive drill failed: ${JSON.stringify(evidence.positive.claims)}`);

// ── N-D 新会话差分对照（会审修②）：独立 lead → fresh 会话必须答不出暗号 ──
const r4 = await dispatch(run2Prompt, "negD_fresh_control", LEAD_FRESH);
if (!r4.accepted) fail("N-D fresh control not accepted");
if (r4.providerSessionRouting !== "first_turn_requested") fail(`N-D routing=${r4.providerSessionRouting} (expected fresh first turn)`);
const t4 = await waitForTerminal(r4.runId);
const echo4 = assistantText(t4.events);
evidence.negativeD = {
  evidenceRef: "negativeD",
  runId: r4.runId,
  control: "distinct leadSession, same lane/workspace/prompt as run2 — fresh provider conversation must NOT be able to echo the marker",
  state: t4.state,
  runSessionReuseTurn: fact(t4.events, "run.session_reuse", r4.runId)?.turn,
  markerEchoed: echo4.includes(MARKER),
  assistantEcho: echo4.slice(0, 200),
  evidenceRefs: {
    sessionReuse: "negd-session-reuse",
    assistant: "negd-assistant",
    terminal: "negd-terminal",
  },
};
if (t4.state !== "completed") fail(`N-D fresh control state=${t4.state} (must complete to be a valid control)`);
if (evidence.negativeD.runSessionReuseTurn !== "first") fail("N-D fresh control was not routed as a first turn");
if (echo4.includes(MARKER)) fail("N-D fresh conversation echoed the marker — context leaked outside the resumed conversation (workspace file or cross-session memory); positive evidence invalidated");
evidence.negativeD.pass = true;

// ── 负向 A（共享核心，后端无关）：前任转录（=最新 run3）session.created.backendSessionId
//    全部改空 → 派发拒绝（不是静默 first/fresh）。快照 runs 目录对比——拒绝的
//    派发不得留下任何新转录（A5 教训）。──
const priorPath = join(runDir, `${r3.runId}.jsonl`);
function rewritePrior(events, mutate) {
  writeFileSync(priorPath, events.map((e) => JSON.stringify(mutate(e))).join("\n") + "\n", "utf8");
}
rewritePrior(t3.events, (e) => (e?.type === "session.created" && e.runId === r3.runId
  ? { ...e, backendSessionId: "" }
  : e));
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
  evidenceRef: "negativeA",
  tamper: "prior transcript session.created.backendSessionId (all bound lines incl. the LAST-bound native line) -> empty string",
  ...negA,
  addedTranscripts,
  noTranscriptForRefusedDispatch: addedTranscripts.length === 0,
  pass: Boolean(negA.refused
    && /no addressable provider session id/.test(negA.message ?? "")
    && addedTranscripts.length === 0),
};
rewritePrior(t3.events, (e) => e);
if (!evidence.negativeA.pass) fail(`negative A failed: ${JSON.stringify(negA)}`);

// ── 负向 B（共享核心，后端无关）：路由条目损坏 → 派发拒绝（不是静默 first）。──
// 会审后修（2026-10-09 实跑）：路由键哈希包含派发时刻冻结的车道/角色指纹材料
//（0045 §1.6 键材料升维——dsh 先例的重算哈希法已随之失效），drill 侧 recomputation
// 会漂。改为按内容发现：run3 完成后 LEAD 键的条目必为 {runId: run3.runId}。
const reuseDir = join(runDir, ".session-reuse");
let entryPath = null;
for (const name of readdirSync(reuseDir)) {
  if (!name.endsWith(".json")) continue;
  try {
    const parsed = JSON.parse(readFileSync(join(reuseDir, name), "utf8"));
    if (parsed?.runId === r3.runId) { entryPath = join(reuseDir, name); break; }
  } catch { /* 损坏条目不参与发现（若恰为目标，下一轮 readdir 会如实暴露） */ }
}
if (entryPath === null) fail("routing entry for the LEAD identity (must point at run3 after the chain) not found — cannot run negative B");
const entryBackup = readFileSync(entryPath, "utf8");
writeFileSync(entryPath, "{damaged-not-json", "utf8");
let negB = { refused: false };
try {
  await dispatch("should be refused", "negB_dispatch");
} catch (error) {
  negB = { refused: true, message: error.message };
}
evidence.negativeB = {
  evidenceRef: "negativeB",
  tamper: "routing entry file -> unparseable bytes",
  ...negB,
  pass: Boolean(negB.refused && /routing entry.*damaged/.test(negB.message ?? "")),
};
writeFileSync(entryPath, entryBackup, "utf8");
if (!evidence.negativeB.pass) fail(`negative B failed: ${JSON.stringify(negB)}`);

// ── 负向 C（会审修④）：关联指向不存在的会话 → 上游在会话查找阶段拒绝 →
//    run failed，绝不静默新会话。CLI 形状断言：(a) run 以 failed 终态且
//    run.error 文本命中该后端实测的上游拒绝形状；(b) 本 run 从未观察到非占位
//    native id，也无 run.provider_session_bound——若上游静默回退新会话，run 会
//    completed 且 late-bind 出新 id，两条都不会成立。真实进程；上游在模型调用
//    前拒绝（本轮无 usage 事实，不宣称零 token）。──
const fakeSid = cfg.negativeCFakeId;
rewritePrior(t3.events, (e) => (e?.type === "session.created" && e.runId === r3.runId
  ? { ...e, backendSessionId: fakeSid }
  : e));
const r5 = await dispatch("resume attempt against a nonexistent session", "negC_dispatch");
if (!r5.accepted || r5.providerSessionRouting !== "resume_requested") {
  fail(`negative C dispatch shape unexpected: ${JSON.stringify(r5)}`);
}
const t5 = await waitForTerminal(r5.runId);
const err5 = fact(t5.events, "run.error", r5.runId);
const nativeObserved = nativeSessionId(t5.events, r5.runId) !== null;
const providerSessionBoundEvents = t5.events.filter((e) => e?.type === "run.provider_session_bound" && e.runId === r5.runId).length;
evidence.negativeC = {
  evidenceRef: "negativeC",
  tamper: `prior transcript session.created.backendSessionId -> well-formed nonexistent id (${fakeSid})`,
  state: t5.state,
  spawnError: err5?.error ?? null,
  nativeSessionIdObserved: nativeObserved,
  providerSessionBoundEvents,
  pass: t5.state === "failed"
    && typeof err5?.error === "string"
    && cfg.negativeCError.test(err5.error)
    && nativeObserved === false
    && providerSessionBoundEvents === 0,
};
rewritePrior(t3.events, (e) => e);
if (!evidence.negativeC.pass) fail(`negative C failed: ${JSON.stringify(evidence.negativeC)}`);

// ── 收尾：写自足证据（G5 纪律：只内嵌判定所需白名单事实，不复制 prompt 以外
//    的模型文本、路径、环境或凭据；native id 是上游历史会话标识，非凭据）。──
evidence.embeddedEvidence = {
  format: "phase6-session-reuse-self-contained-v1",
  backend: backendName,
  marker: MARKER,
  positiveInputs: {
    run1: { runId: r1.runId, providerSessionRouting: r1.providerSessionRouting, prompt: run1Prompt },
    run2: { runId: r2.runId, providerSessionRouting: r2.providerSessionRouting, prompt: run2Prompt },
    run3: { runId: r3.runId, providerSessionRouting: r3.providerSessionRouting, prompt: run2Prompt },
    freshControl: { runId: r4.runId, providerSessionRouting: r4.providerSessionRouting, prompt: run2Prompt },
  },
  evidenceLines: [
    { id: "run1-session-created", source: "run transcript excerpt", runId: r1.runId, type: "session.created", backendSessionId: sid1 },
    { id: "run1-session-reuse", source: "run transcript excerpt", runId: r1.runId, type: "run.session_reuse", turn: evidence.steps.run1.runSessionReuseTurn },
    { id: "run1-assistant", source: "run transcript excerpt", runId: r1.runId, type: "run.event", kind: "message", role: "assistant", text: evidence.steps.run1.assistantEcho },
    { id: "run1-terminal", source: "run transcript excerpt", runId: r1.runId, type: "run.completed", state: t1.state },
    { id: "run2-session-created", source: "run transcript excerpt", runId: r2.runId, type: "session.created", backendSessionId: sid2 },
    { id: "run2-session-reuse", source: "run transcript excerpt", runId: r2.runId, type: "run.session_reuse", turn: evidence.steps.run2.runSessionReuseTurn },
    { id: "run2-assistant", source: "run transcript excerpt", runId: r2.runId, type: "run.event", kind: "message", role: "assistant", text: evidence.steps.run2.assistantEcho },
    { id: "run2-terminal", source: "run transcript excerpt", runId: r2.runId, type: "run.completed", state: t2.state },
    { id: "run3-session-created", source: "run transcript excerpt", runId: r3.runId, type: "session.created", backendSessionId: sid3 },
    { id: "run3-session-reuse", source: "run transcript excerpt", runId: r3.runId, type: "run.session_reuse", turn: evidence.steps.run3.runSessionReuseTurn },
    { id: "run3-assistant", source: "run transcript excerpt", runId: r3.runId, type: "run.event", kind: "message", role: "assistant", text: evidence.steps.run3.assistantEcho },
    { id: "run3-terminal", source: "run transcript excerpt", runId: r3.runId, type: "run.completed", state: t3.state },
    { id: "negd-session-reuse", source: "run transcript excerpt", runId: r4.runId, type: "run.session_reuse", turn: evidence.negativeD.runSessionReuseTurn },
    { id: "negd-assistant", source: "run transcript excerpt", runId: r4.runId, type: "run.event", kind: "message", role: "assistant", text: evidence.negativeD.assistantEcho },
    { id: "negd-terminal", source: "run transcript excerpt", runId: r4.runId, type: "run.completed", state: t4.state },
  ],
  negativeControls: [
    {
      id: "negativeA",
      input: { kind: "prior-transcript-session-id", runId: r3.runId, backendSessionId: "" },
      refusal: {
        kind: "dispatch_refused",
        accepted: false,
        refused: negA.refused,
        message: negA.message ?? null,
        noTranscriptCreated: addedTranscripts.length === 0,
      },
    },
    {
      id: "negativeB",
      input: { kind: "routing-entry-bytes", rawBytes: "{damaged-not-json" },
      refusal: {
        kind: "dispatch_refused",
        accepted: false,
        refused: negB.refused,
        message: negB.message ?? null,
      },
    },
    {
      id: "negativeC",
      input: { kind: "prior-transcript-session-id", runId: r3.runId, backendSessionId: fakeSid },
      refusal: {
        kind: "resume_rejected",
        runId: r5.runId,
        dispatchAccepted: r5.accepted,
        providerSessionRouting: r5.providerSessionRouting,
        terminalState: t5.state,
        errorMessage: err5?.error ?? null,
        nativeSessionIdObserved: nativeObserved,
        providerSessionBoundEvents,
      },
    },
    {
      id: "negativeD",
      input: { kind: "fresh-lead-differential", runId: r4.runId, leadSession: "distinct-fresh-lead", prompt: run2Prompt },
      control: {
        kind: "fresh_session_control",
        dispatchAccepted: r4.accepted,
        providerSessionRouting: r4.providerSessionRouting,
        turn: evidence.negativeD.runSessionReuseTurn,
        terminalState: t4.state,
        markerEchoed: evidence.negativeD.markerEchoed,
      },
    },
  ],
};
evidence.pass = true;
evidence.repro = [
  `node scripts/wao-node.cjs scripts/reliability/session-reuse-drill.mjs --backend ${backendName}`,
  "consumes real tokens (run1/run2/run3/fresh-control are small model turns; negC is rejected upstream at session lookup, before the model — no usage fact observed this turn)",
  `prereq: ${backendName} CLI on PATH and logged in; registry source ${registrySource} (read-only copy, scratch lane injected)`,
];
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
console.log("DRILL PASSED");
console.log(JSON.stringify({
  backend: backendName,
  run1: { state: evidence.steps.run1.state, backendSessionId: sid1, toolEventCount: run1ToolEvents },
  run2: { state: evidence.steps.run2.state, backendSessionId: sid2 },
  run3: { state: evidence.steps.run3.state, backendSessionId: sid3 },
  sameProviderSessionObserved,
  negativeD: { pass: evidence.negativeD.pass, markerEchoed: evidence.negativeD.markerEchoed },
  negativeA: { pass: evidence.negativeA.pass },
  negativeB: { pass: evidence.negativeB.pass },
  negativeC: { pass: evidence.negativeC.pass, state: evidence.negativeC.state },
  evidence: cfg.evidenceRel.split(/[\\/]/).join("/"),
}, null, 2));
