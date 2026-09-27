// test/m12-7-sessionReuseLineage.test.js
//
// M12-7: provider-native conversation reuse scoped to an explicit run LINEAGE
// (Lead-authorized correction continuation), NOT project-wide coder reuse.
//
// These tests pin the lineage-scoped session routing contract that lives in
// src/application/sessionReuse.js alongside the existing lead_workspace policy:
//   - the opaque provider UUID is derived from (Lead session + canonical
//     workspace + canonical agentId + ROOT runId), so it is stable across one
//     lineage and isolated across lineages;
//   - the routing envelope {mode:"run_lineage", opaqueUuid, turn} validates
//     through the SAME closed-shape authority as lead_workspace;
//   - the per-key lock/busy logic is REUSED: first turn claims, continuation
//     resumes with the SAME opaque id, a non-terminal lineage owner is busy,
//     and two concurrent continuations of the same parent cannot both proceed.
//
// Security: the opaque uuid / raw Lead id / workspace are never persisted by
// these functions — only bounded routing facts ({runId, updatedAt}).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveOpaqueUuid,
  deriveReuseKeyHash,
  validateSessionReuseRouting,
  SESSION_REUSE_MODES,
  deriveLineageOpaqueUuid,
  deriveLineageReuseKeyHash,
  resolveLineageFirstTurn,
  resolveLineageContinuationTurn,
} from "../../src/application/sessionReuse.js";
import { JsonlTranscript } from "../../src/transcript.js";

const LEAD = "lead-session-uuid-1";
const WS = "D:/repos/example";
const AGENT = "coder_hq";
const ROOT = "run_root_20260801";

function tmpRunDir() {
  return mkdtempSync(join(tmpdir(), "wao-m127-lineage-"));
}

// An in-memory, injectable lineage store for deterministic concurrency tests.
function memStore() {
  const entries = new Map();
  let lockedBy = null;
  return {
    lockDir: "/dev/null/mem-lock",
    async readEntry(key) { return entries.get(key) ?? null; },
    async writeEntry(key, entry) { entries.set(key, entry); },
    _entries: entries,
    _lockedBy: () => lockedBy,
  };
}

test("M12-7-LIN-01: lineage opaque uuid is deterministic and root-scoped", () => {
  const a = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  const a2 = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  // RFC 4122 v4 shaped.
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, a2, "same lineage inputs -> same opaque uuid");

  // Different root -> different uuid (lineage isolation).
  const b = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: "run_root_other" });
  assert.notEqual(a, b, "different rootRunId -> different opaque uuid");
});

test("M12-7-LIN-02: lineage uuid never collides with lead_workspace uuid for the same triple", () => {
  const lineage = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  const policy = deriveOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT });
  assert.notEqual(lineage, policy, "lineage and lead_workspace reuse must be distinct keyspaces");
});

test("M12-7-LIN-03: lineage reuse key hash is sha256 of the opaque uuid (no uuid on disk path)", () => {
  const opaque = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  const key = deriveLineageReuseKeyHash({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes(opaque), "key hash must not contain the opaque uuid verbatim");
  // Distinct from the lead_workspace key for the same triple.
  const policyKey = deriveReuseKeyHash({ leadSession: LEAD, workspace: WS, agentId: AGENT });
  assert.notEqual(key, policyKey);
});

test("M12-7-LIN-04: validateSessionReuseRouting accepts run_lineage envelope (closed shape)", () => {
  const opaque = deriveLineageOpaqueUuid({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
  // §3.6/R2：resume 轮携带 priorRunId（前任 WAO runId）；first 轮禁止。
  const ok = validateSessionReuseRouting({ mode: "run_lineage", opaqueUuid: opaque, turn: "resume", priorRunId: ROOT });
  assert.equal(ok.mode, "run_lineage");
  assert.equal(ok.turn, "resume");
  assert.equal(ok.priorRunId, ROOT);
  assert.ok(validateSessionReuseRouting({ mode: "run_lineage", opaqueUuid: opaque, turn: "first" }));
  // Still rejects malformed envelopes (fail closed -> never a silent fresh chat).
  assert.throws(() => validateSessionReuseRouting({ mode: "run_lineage", opaqueUuid: opaque }), /invalid internal routing envelope/);
  assert.throws(() => validateSessionReuseRouting({ mode: "bogus", opaqueUuid: opaque, turn: "first" }), /invalid internal routing envelope/);
  assert.throws(() => validateSessionReuseRouting({ mode: "run_lineage", opaqueUuid: "not-a-uuid", turn: "first" }), /invalid internal routing envelope/);
  // resume 无 priorRunId → 拒（§3.6）。
  assert.throws(() => validateSessionReuseRouting({ mode: "run_lineage", opaqueUuid: opaque, turn: "resume" }), /invalid internal routing envelope/);
  // first 带 priorRunId → 拒（形状不放宽成"任意额外键"）。
  assert.throws(() => validateSessionReuseRouting({ mode: "run_lineage", opaqueUuid: opaque, turn: "first", priorRunId: ROOT }), /invalid internal routing envelope/);
});

test("M12-7-LIN-05: lead_workspace policy set is unchanged (run_lineage is routing-only, not an agent policy)", () => {
  // run_lineage must NOT become an agent-declarable sessionReuse policy.
  assert.deepEqual([...SESSION_REUSE_MODES], ["lead_workspace"]);
});

test("M12-7-LIN-06: first turn claims the lineage slot and reports turn:first", async () => {
  const runDir = tmpRunDir();
  try {
    const store = memStore();
    const r = await resolveLineageFirstTurn({
      runDir, runId: ROOT, leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT, reuseStore: store, now: 1000,
    });
    assert.equal(r.kind, "first");
    assert.equal(r.routing.mode, "run_lineage");
    assert.equal(r.routing.turn, "first");
    assert.match(r.routing.opaqueUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Slot claimed for the root run.
    const key = deriveLineageReuseKeyHash({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
    assert.equal(store._entries.get(key).runId, ROOT);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("M12-7-LIN-07: continuation resumes with the SAME opaque id as the first turn", async () => {
  const runDir = tmpRunDir();
  try {
    const store = memStore();
    const first = await resolveLineageFirstTurn({
      runDir, runId: ROOT, leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT, reuseStore: store, now: 1000,
    });
    // Parent (root) is terminal with a session.created -> eligible to resume.
    await seedTerminalTranscript(runDir, ROOT, AGENT);
    const cont = await resolveLineageContinuationTurn({
      runDir, runId: "run_child_1", parentRunId: ROOT, rootRunId: ROOT,
      leadSession: LEAD, workspace: WS, agentId: AGENT, reuseStore: store, now: 2000,
    });
    assert.equal(cont.kind, "resume");
    assert.equal(cont.routing.turn, "resume");
    assert.equal(cont.routing.opaqueUuid, first.routing.opaqueUuid, "continuation reuses the SAME opaque provider id");
    // §3.6/R2：resume 信封携带前任 runId（lineage 槽位前一 owner = root）。
    assert.equal(cont.routing.priorRunId, ROOT);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("M12-7-LIN-08: a non-terminal lineage owner is busy (no concurrent driving)", async () => {
  const runDir = tmpRunDir();
  try {
    const store = memStore();
    await resolveLineageFirstTurn({
      runDir, runId: ROOT, leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT, reuseStore: store, now: 1000,
    });
    // Root still non-terminal (running) -> continuation must be busy.
    await seedNonTerminalTranscript(runDir, ROOT, AGENT);
    const cont = await resolveLineageContinuationTurn({
      runDir, runId: "run_child_1", parentRunId: ROOT, rootRunId: ROOT,
      leadSession: LEAD, workspace: WS, agentId: AGENT, reuseStore: store, now: 2000,
    });
    assert.equal(cont.kind, "busy");
    assert.equal(cont.activeRunId, ROOT);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("M12-7-LIN-09: concurrent duplicate continuation of the same parent -> loser is busy", async () => {
  const runDir = tmpRunDir();
  try {
    const store = memStore();
    await resolveLineageFirstTurn({
      runDir, runId: ROOT, leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT, reuseStore: store, now: 1000,
    });
    await seedTerminalTranscript(runDir, ROOT, AGENT);
    // First continuation claims the slot as a non-terminal child.
    const c1 = await resolveLineageContinuationTurn({
      runDir, runId: "run_child_1", parentRunId: ROOT, rootRunId: ROOT,
      leadSession: LEAD, workspace: WS, agentId: AGENT, reuseStore: store, now: 2000,
    });
    assert.equal(c1.kind, "resume");
    // The child it spawned is non-terminal (no transcript yet / running) -> a
    // second concurrent continuation must observe it as busy, not fork a rival.
    const c2 = await resolveLineageContinuationTurn({
      runDir, runId: "run_child_2", parentRunId: ROOT, rootRunId: ROOT,
      leadSession: LEAD, workspace: WS, agentId: AGENT, reuseStore: store, now: 3000,
    });
    assert.equal(c2.kind, "busy");
    assert.equal(c2.activeRunId, "run_child_1");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("M12-7-LIN-10: 损坏的 lineage 条目时间戳（未来/负/非数）⇒ 拒绝，绝不回收或续接槽位（窄复核第 3 轮 [高]）", async () => {
  const runDir = tmpRunDir();
  try {
    const key = deriveLineageReuseKeyHash({ leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT });
    for (const badTs of [1000 + 60_000, -1, "broken", NaN]) {
      // (a) first-turn: 条目指向别的 owner，转录缺失 —— 修复前会判 first 并覆写槽位
      const s1 = memStore();
      s1._entries.set(key, { runId: "run_owner", updatedAt: badTs });
      await assert.rejects(
        () => resolveLineageFirstTurn({
          runDir, runId: ROOT, leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT, reuseStore: s1, now: 1000,
        }),
        /routing entry.*damaged/s,
        `lineage first turn, updatedAt=${String(badTs)} must refuse`,
      );
      // (b) self-runId 变体：条目 owner 就是本次 runId —— 同样不得绕过
      const s2 = memStore();
      s2._entries.set(key, { runId: ROOT, updatedAt: badTs });
      await assert.rejects(
        () => resolveLineageFirstTurn({
          runDir, runId: ROOT, leadSession: LEAD, workspace: WS, agentId: AGENT, rootRunId: ROOT, reuseStore: s2, now: 1000,
        }),
        /routing entry.*damaged/s,
        `lineage self-runId, updatedAt=${String(badTs)} must refuse`,
      );
      // (c) continuation: 修复前会对损坏条目判 resume 并覆写槽位
      const s3 = memStore();
      s3._entries.set(key, { runId: "run_owner", updatedAt: badTs });
      await assert.rejects(
        () => resolveLineageContinuationTurn({
          runDir, runId: "run_child_1", parentRunId: "run_owner", rootRunId: ROOT,
          leadSession: LEAD, workspace: WS, agentId: AGENT, reuseStore: s3, now: 1000,
        }),
        /routing entry.*damaged/s,
        `lineage continuation, updatedAt=${String(badTs)} must refuse`,
      );
    }
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ===== TD188（2026-09-27）：run.provider_session_bound 绑定事实读取器 =====
//
// delivery + sessionReuse run 的 spawn 时刻 session.created 保持唯一进程身份
//（proc_<pid>，M12-19 process_missing 恢复依赖）；运行期 wire 观察到的 native
// provider id 以独立有界事实 run.provider_session_bound {backend, backendSessionId
// (原 spawn 身份), providerSessionId(native id)} 关联落盘。共享读取器优先采信并
// 严格校验该事实（runId 信封 / 唯一性 / native 非空且非占位 / 与原 spawn 身份
// 一致）；坏/重复/冲突事实 = 损坏 → 拒绝，绝不回落旧 session.created 值遮蔽。
// 无新事实时保持既有 native session.created 兼容读取（claude opaque / ACP native
// lane 不受影响）。

const KIMI_NATIVE = "session_014e3fb4-1dbd-435e-a883-a63245876ea0";

// 绑定事实 + 原始 spawn 身份（delivery 进程式 run 的真实形状）。
function seedBoundTranscript(runDir, runId, agentId, {
  backend = "process",
  spawnSessionId = "proc_43244",
  binding = { backend: "process", backendSessionId: "proc_43244", providerSessionId: KIMI_NATIVE },
} = {}) {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  return (async () => {
    await t.append("run.started", { backend });
    await t.transitionState(null, "pending", "created");
    await t.append("session.created", { backend, backendSessionId: spawnSessionId, serveUrl: null });
    if (binding) await t.append("run.provider_session_bound", binding);
    await t.transitionState("pending", "completed", "done");
    return t;
  })();
}

test("TD188-LIN-01: 绑定事实优先且通过全部校验 → 取回 native id；session.created 保持唯一 proc 身份", async () => {
  const runDir = tmpRunDir();
  try {
    const runId = "run_td188_pos";
    await seedBoundTranscript(runDir, runId, AGENT);
    const { resolvePriorProviderSessionId, resolvePriorProviderSessionIdFromEvents, PROVIDER_SESSION_BOUND_EVENT } =
      await import("../../src/application/sessionReuse.js");
    // 异步文件读取器（spawn 权威 / continueRun 预检共用同一 SSOT）。
    assert.equal(await resolvePriorProviderSessionId({ runDir, priorRunId: runId }), KIMI_NATIVE);
    // 纯事件读取器：同一判定。
    const { readTranscript } = await import("../../src/transcript.js");
    const events = await readTranscript(join(runDir, `${runId}.jsonl`));
    assert.equal(resolvePriorProviderSessionIdFromEvents(events, runId), KIMI_NATIVE);
    const bound = events.filter((e) => e.type === PROVIDER_SESSION_BOUND_EVENT);
    assert.equal(bound.length, 1, "恰一条绑定事实");
    const created = events.filter((e) => e.type === "session.created");
    assert.equal(created.length, 1, "delivery run 不补第二条 session.created（M12-19 唯一 proc 身份）");
    assert.equal(created[0].backendSessionId, "proc_43244");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("TD188-LIN-02: 无绑定事实 → 兼容既有 native session.created 读取（claude opaque / ACP native lane 不变）", async () => {
  const runDir = tmpRunDir();
  try {
    // claude-code 交付父：session.created 记 proc 身份，无绑定事实（parser 不广告 id）。
    await seedBoundTranscript(runDir, "run_td188_claude", AGENT, { binding: null });
    // ACP 父：session.created 本身就是 native id。
    await seedBoundTranscript(runDir, "run_td188_acp", AGENT, {
      backend: "deepseek-acp", spawnSessionId: "acp-uuid-1", binding: null,
    });
    const { resolvePriorProviderSessionId } = await import("../../src/application/sessionReuse.js");
    assert.equal(await resolvePriorProviderSessionId({ runDir, priorRunId: "run_td188_claude" }), "proc_43244",
      "claude lane：取回 proc 值但仍可续接（backend 钩子放行 opaque 路径，见 providerSessionReuse.test.js）");
    assert.equal(await resolvePriorProviderSessionId({ runDir, priorRunId: "run_td188_acp" }), "acp-uuid-1",
      "ACP lane：原 native session.created 不退化");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("TD188-LIN-03: 坏绑定事实全拒（不回落旧值遮蔽）——空/非串/占位/等于原身份/关联不一致/无 session.created", async () => {
  const { resolvePriorProviderSessionIdFromEvents, PROVIDER_SESSION_BOUND_EVENT } =
    await import("../../src/application/sessionReuse.js");
  const base = { backend: "process", backendSessionId: "proc_43244" };
  const badBindings = [
    { ...base, providerSessionId: "" },
    { ...base, providerSessionId: null },
    { ...base, providerSessionId: 42 },
    { ...base, providerSessionId: "proc_43244" },
    { ...base, providerSessionId: "proc_99" },
    { backend: "process", backendSessionId: "proc_999", providerSessionId: KIMI_NATIVE }, // 关联的 spawn 身份与 session.created 不一致
    { backend: "kimi-code", backendSessionId: "proc_43244", providerSessionId: KIMI_NATIVE }, // backend 身份不一致
  ];
  for (const binding of badBindings) {
    const events = [
      { type: "session.created", runId: "run_x", backendSessionId: "proc_43244", backend: "process" },
      { type: PROVIDER_SESSION_BOUND_EVENT, runId: "run_x", ...binding },
    ];
    assert.throws(
      () => resolvePriorProviderSessionIdFromEvents(events, "run_x"),
      /provider session binding fact that is damaged.*refusing resume instead of silently starting a fresh provider conversation/s,
      `坏绑定事实（providerSessionId=${JSON.stringify(binding.providerSessionId)}, backendSessionId=${binding.backendSessionId}）必须拒绝而非回落 proc 值`,
    );
  }
  // 有绑定事实但 transcript 无 session.created（关联不可能成立）→ 拒。
  assert.throws(
    () => resolvePriorProviderSessionIdFromEvents(
      [{ type: PROVIDER_SESSION_BOUND_EVENT, runId: "run_x", ...base, providerSessionId: KIMI_NATIVE }],
      "run_x",
    ),
    /provider session binding fact that is damaged|no addressable provider session id/s,
  );
});

test("TD188-LIN-04: 重复绑定事实（相同值/冲突值，均绑定本 run）⇒ 损坏拒绝", async () => {
  const { resolvePriorProviderSessionIdFromEvents, PROVIDER_SESSION_BOUND_EVENT } =
    await import("../../src/application/sessionReuse.js");
  const CREATED = { type: "session.created", runId: "run_x", backend: "process", backendSessionId: "proc_43244" };
  const mk = (native) => ({
    type: PROVIDER_SESSION_BOUND_EVENT, runId: "run_x",
    backend: "process", backendSessionId: "proc_43244", providerSessionId: native,
  });
  // 重复且值相同 → 损坏拒绝。
  assert.throws(
    () => resolvePriorProviderSessionIdFromEvents([CREATED, mk(KIMI_NATIVE), mk(KIMI_NATIVE)], "run_x"),
    /provider session binding fact that is damaged/s,
  );
  // 重复且值冲突 → 损坏拒绝（不猜取哪条）。
  assert.throws(
    () => resolvePriorProviderSessionIdFromEvents([CREATED, mk(KIMI_NATIVE), mk("session_other_native_1")], "run_x"),
    /provider session binding fact that is damaged/s,
  );
});

// TD188 返工 R2：新绑定分支对"原 spawn 身份"的校验收口——旧实现取 LAST
// session.created（尾条重复可替身顶替原身份），且双侧 backend 缺失时
// undefined === undefined 放行。收口后：新绑定分支要求【严格唯一】原始
// session.created，双侧 backend 均为非空 string 且匹配；无新绑定的 legacy
// 分支保持 LAST-bound 读取不动。
test("TD188-R2-LIN-05: 新绑定分支要求唯一原始 session.created + 双侧非空 backend 匹配；legacy 分支保持 LAST-bound", async () => {
  const { resolvePriorProviderSessionIdFromEvents, PROVIDER_SESSION_BOUND_EVENT } =
    await import("../../src/application/sessionReuse.js");
  const CREATED = { type: "session.created", runId: "run_x", backend: "process", backendSessionId: "proc_43244" };
  const BINDING = {
    type: PROVIDER_SESSION_BOUND_EVENT, runId: "run_x",
    backend: "process", backendSessionId: "proc_43244", providerSessionId: KIMI_NATIVE,
  };
  // 正对照：恰一条原始 session.created + 双侧 backend 非空匹配 → 取回 native。
  assert.equal(resolvePriorProviderSessionIdFromEvents([CREATED, BINDING], "run_x"), KIMI_NATIVE);
  // 重复原始 session.created（相同值）→ 原身份歧义 → 拒绝。
  assert.throws(
    () => resolvePriorProviderSessionIdFromEvents([CREATED, { ...CREATED }, BINDING], "run_x"),
    /provider session binding fact that is damaged/s,
    "两条相同 session.created 也是歧义（不靠 LAST 猜原身份）",
  );
  // 重复原始 session.created（冲突值：首条 proc_43244 + 尾条 proc_999，绑定指向尾条）
  // → 旧 LAST-bound 读法放行 → 拒绝。
  assert.throws(
    () => resolvePriorProviderSessionIdFromEvents(
      [CREATED,
        { type: "session.created", runId: "run_x", backend: "process", backendSessionId: "proc_999" },
        { ...BINDING, backendSessionId: "proc_999" }],
      "run_x",
    ),
    /provider session binding fact that is damaged/s,
    "尾条重复不得顶替原 spawn 身份为绑定事实背书",
  );
  // 双侧 backend 均缺失（undefined === undefined）→ 旧实现放行 → 拒绝。
  assert.throws(
    () => resolvePriorProviderSessionIdFromEvents(
      [{ type: "session.created", runId: "run_x", backendSessionId: "proc_43244" },
        { type: PROVIDER_SESSION_BOUND_EVENT, runId: "run_x", backendSessionId: "proc_43244", providerSessionId: KIMI_NATIVE }],
      "run_x",
    ),
    /provider session binding fact that is damaged/s,
    "backend 缺失不是匹配（undefined === undefined 不得放行）",
  );
  // 绑定侧 backend 空串 → 拒绝。
  assert.throws(
    () => resolvePriorProviderSessionIdFromEvents([CREATED, { ...BINDING, backend: "" }], "run_x"),
    /provider session binding fact that is damaged/s,
  );
  // 原始侧 backend 缺失 → 拒绝。
  assert.throws(
    () => resolvePriorProviderSessionIdFromEvents(
      [{ type: "session.created", runId: "run_x", backendSessionId: "proc_43244" }, BINDING],
      "run_x",
    ),
    /provider session binding fact that is damaged/s,
  );
  // legacy 分支（无任何绑定类型事实）保持 LAST-bound 不变。
  assert.equal(
    resolvePriorProviderSessionIdFromEvents(
      [{ type: "session.created", runId: "run_x", backendSessionId: "a1" },
        { type: "session.created", runId: "run_x", backendSessionId: "a2" }],
      "run_x",
    ),
    "a2",
  );
});

// TD188 返工 R3：绑定类型事实先按信封核查——错 run / 缺 runId 信封的
// run.provider_session_bound 行是**损坏**（该事件类型自 TD188 起才存在、且只能经
// 信封落盘的 transcript append 写出，本文件出现无法归属的实例即损坏），不得当
// "不存在"回落 legacy 值（回落会遮蔽损坏并以 proc 占位/旧值放行——RunManager
// 直读侧的漏拒面）。纯读取器与文件读侧（RunManager.start 直读路径）同结论。
test("TD188-R3-LIN-06: 错 run/缺信封绑定事实 = 损坏 ⇒ 拒绝（不得回落 legacy）；纯读取器与文件读侧同结论", async () => {
  const { resolvePriorProviderSessionIdFromEvents, resolvePriorProviderSessionId, PROVIDER_SESSION_BOUND_EVENT } =
    await import("../../src/application/sessionReuse.js");
  const CREATED = { type: "session.created", runId: "run_x", backend: "process", backendSessionId: "proc_43244" };
  const FOREIGN = {
    type: PROVIDER_SESSION_BOUND_EVENT, runId: "run_other",
    backend: "process", backendSessionId: "proc_43244", providerSessionId: KIMI_NATIVE,
  };
  const NO_ENVELOPE = {
    type: PROVIDER_SESSION_BOUND_EVENT,
    backend: "process", backendSessionId: "proc_43244", providerSessionId: KIMI_NATIVE,
  };
  // 纯读取器：外 run 信封 → 拒绝（返工前当不存在、回落 proc_43244）。
  assert.throws(
    () => resolvePriorProviderSessionIdFromEvents([CREATED, FOREIGN], "run_x"),
    /provider session binding fact that is damaged.*refusing resume instead of silently starting a fresh provider conversation/s,
    "外 run 绑定事实必须拒绝而非当不存在回落",
  );
  // 纯读取器：缺 runId 信封 → 拒绝。
  assert.throws(
    () => resolvePriorProviderSessionIdFromEvents([CREATED, NO_ENVELOPE], "run_x"),
    /provider session binding fact that is damaged/s,
    "缺信封绑定事实必须拒绝",
  );
  // 文件读侧（resolvePriorProviderSessionId——RunManager.start 直读路径）同结论。
  const runDir = tmpRunDir();
  try {
    const t = new JsonlTranscript(join(runDir, "run_x.jsonl"), { runId: "run_x", agentId: AGENT });
    await t.append("session.created", { backend: "process", backendSessionId: "proc_43244", serveUrl: null });
    appendFileSync(join(runDir, "run_x.jsonl"), `${JSON.stringify(FOREIGN)}\n`, "utf8");
    await assert.rejects(
      () => resolvePriorProviderSessionId({ runDir, priorRunId: "run_x" }),
      /provider session binding fact that is damaged/s,
      "文件读侧不得以外 run 绑定事实回落 legacy 值",
    );
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

// ---- helpers: write minimal transcripts that findState() treats as terminal / non-terminal ----

async function seedTerminalTranscript(runDir, runId, agentId) {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.started", { backend: "claude-code" });
  await t.transitionState(null, "pending", "created");
  await t.append("session.created", { backend: "claude-code", backendSessionId: "abc", serveUrl: null });
  await t.transitionState("pending", "completed", "done");
}

async function seedNonTerminalTranscript(runDir, runId, agentId) {
  const t = new JsonlTranscript(join(runDir, `${runId}.jsonl`), { runId, agentId });
  await t.append("run.started", { backend: "claude-code" });
  await t.transitionState(null, "pending", "created");
  await t.append("session.created", { backend: "claude-code", backendSessionId: "abc", serveUrl: null });
  await t.transitionState("pending", "submitted", "spawned");
}
