// test/run-lifecycle/continuableAuto.test.js
//
// 第 154 批（决定 0133）：带交付的后台派发 continuable 三态。
//   true  = 显式开（行为不变，做不到按具名错误拒绝）
//   false = 显式关（不建谱系）
//   缺省  = 自动：带交付 + 有 cwd + 后端 supportsSessionReuse + 环境能建立复用
//           + 无 model/reasoning 覆盖，全部满足才开；任一不满足静默关闭、派发照常。
// 本文件钉：服务层判定矩阵、静默关闭与显式拒绝的对照、结果回显、后端能力查询
// （claude-code 令牌条件）、CLI 后台三态穿线与前台回显。用例名一律标明"自动"或"显式"。
// 全程假 spawn / 假后端 / 注入凭据，不调用付费运行时。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { open } from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  dispatchRun,
  CONTINUABLE_OFF_REASONS,
  CONTINUABLE_OFF_FOREGROUND,
} from "../../src/application/runDispatch.js";
import { resolveTranscriptPath } from "../../src/projectBuckets.js";
import { readTranscript, findLatest } from "../../src/transcript.js";
import { backendFor as factoryBackendFor } from "../../src/backends/factory.js";
import { ClaudeCodeBackend } from "../../src/backends/claudeCode.js";
import { CodexBackend } from "../../src/backends/codex.js";
import { createLineageStore, deriveLineageOpaqueUuid, deriveLineageReuseKeyHash } from "../../src/application/sessionReuse.js";
import { laneFingerprint as laneFingerprintOf } from "../../src/application/identityProjection.js";
import { proveWorkspaceRoot } from "../../src/application/workspaceBinding.js";
import { composeDeliveryRoleContract, composeRoleContractWithIdentity, loadRoleContract } from "../../src/application/roleContract.js";

const DELIVERY = { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] };
const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const CAPABLE = () => ({ supportsSessionReuse: true });
const INCAPABLE = () => ({ supportsSessionReuse: false });
// 声明复用但当前环境建立不了——通用机制（不认运行时名）。
const NOT_READY = () => ({ supportsSessionReuse: true, sessionReuseUnavailableReason: () => "token_required" });

function makeFakeSpawn() {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; };
  return { fakeSpawn, calls };
}
function argVal(calls, flag) {
  const a = calls[0].args;
  const i = a.indexOf(flag);
  return i >= 0 ? a[i + 1] : undefined;
}
// .lineage-reuse 下的槽条目（*.json；.locks 目录与临时文件不算）。
function slotEntries(dir) {
  const slotDir = join(dir, ".lineage-reuse");
  return existsSync(slotDir) ? readdirSync(slotDir).filter((n) => n.endsWith(".json")) : [];
}
function jsonlFiles(dir) {
  return readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
}

// 谱系 workspace 要过与 run_continue 同一个 Git 顶层证明（proveWorkspaceRoot），
// 所以绑定的工作区是一个真 Git 仓；整份文件共用一个（每场景只换 registry/runDir）。
let sharedRepo = null;
function repoDir() {
  if (sharedRepo === null) {
    sharedRepo = mkdtempSync(join(tmpdir(), "wao-b154-repo-"));
    makeGitRepo(sharedRepo);
  }
  return sharedRepo;
}
test.after(() => {
  if (sharedRepo !== null) rmSync(sharedRepo, { recursive: true, force: true });
});

// 一次性场景：临时目录 dir 充当 registry/runDir；绑定的工作区是共用的 Git 仓 repo；
// 回调拿到 dispatch 与 fake spawn 记录。
async function scenario(agentSpec, fn) {
  const dir = mkdtempSync(join(tmpdir(), "wao-b154-auto-"));
  const repo = repoDir();
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { seat: { backend: "claude-code", cwd: repo, ...agentSpec } } }), "utf8");
    const dispatch = (extra = {}) => dispatchRun({
      agentId: "seat",
      prompt: "do the work",
      registryPath,
      runDir: dir,
      cwd: repo,
      leadSession: "lead-b154",
      skipCredentialCheck: true,
      spawnFn: fakeSpawn,
      ...extra,
    });
    return await fn({ dispatch, calls, dir, repo });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function eventsOf(dir, r) {
  return readTranscript(resolveTranscriptPath(dir, r.runId));
}
function assertRooted(r, calls, events) {
  assert.equal(r.accepted, true);
  assert.equal(r.continuable, true);
  assert.equal("continuableOff" in r, false, "开了就不带原因");
  const routing = JSON.parse(argVal(calls, "--session-reuse-json"));
  assert.equal(routing.mode, "run_lineage");
  assert.equal(routing.turn, "first");
  const evt = findLatest(events, "run.session_reuse");
  assert.equal(evt.mode, "run_lineage");
  assert.equal(evt.rootRunId, r.runId);
}
function assertOrdinary(r, calls, events) {
  assert.equal(r.accepted, true, "静默关闭，派发照常受理");
  assert.equal(r.continuable, false);
  assert.equal(argVal(calls, "--session-reuse-json"), undefined, "无谱系路由");
  assert.equal(argVal(calls, "--reuse-material-json"), undefined, "无冻结材料");
  assert.equal(findLatest(events, "run.session_reuse"), undefined, "无 session_reuse 事实");
}

// ── 自动：开 ──────────────────────────────────────────────────────────────

test("自动：带交付 + 能续的后端 + 有 cwd → 开谱系首轮，回显 continuable:true、不带 continuableOff", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE });
    assertRooted(r, calls, await eventsOf(dir, r));
    assert.equal(r.providerSessionRouting, "first_turn_requested");
  });
});

test("自动：非 claude 后端（真实工厂解析器，无环境条件）→ 开", async () => {
  await scenario({ backend: "kimi-web", serveUrl: "http://127.0.0.1:1", tokenEnv: "WAO_TEST_TOKEN_B154", model: { id: "kimi-code/k3" } }, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: factoryBackendFor });
    assertRooted(r, calls, await eventsOf(dir, r));
  });
});

test("自动：非交付派发 → continuable:false，且不带 continuableOff（非交付派发不带这个键）", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ backendFor: CAPABLE });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal("continuableOff" in r, false);
  });
});

// ── 自动：静默关闭 ────────────────────────────────────────────────────────

test("自动：后端 supportsSessionReuse 为假 → 静默关闭、派发成功、continuableOff=backend_unsupported", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: INCAPABLE });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "backend_unsupported");
  });
});

test("自动：未注入能力解析器 → 回落共享工厂的真实后端判定，不再取决于调用方传没传解析器", async () => {
  // codex 席位（无环境条件）：回落工厂 → 声明可续 → 开。
  await scenario({ backend: "codex", model: { id: "fixture-model" } }, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY });
    assertRooted(r, calls, await eventsOf(dir, r));
  });
  // claude-code 席位：回落工厂 → 令牌条件照样生效（空串令牌 → 关，原因 session_reuse_unavailable）。
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, resolvedCredentials: { [TOKEN_ENV]: "" } });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "session_reuse_unavailable");
  });
});

test("自动：后端声明复用但当前环境建立不了（sessionReuseUnavailableReason 非 null）→ 静默关闭，continuableOff=session_reuse_unavailable", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: NOT_READY });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "session_reuse_unavailable");
  });
});

test("自动：claude-code（真实工厂后端）无令牌 → 静默关闭、派发成功；有令牌 → 开", async () => {
  // 空串令牌 = 解析结果里"令牌被清空"（压过进程环境），不依赖运行机器上有没有令牌。
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: factoryBackendFor, resolvedCredentials: { [TOKEN_ENV]: "" } });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "session_reuse_unavailable");
  });
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: factoryBackendFor, resolvedCredentials: { [TOKEN_ENV]: "fixture-oauth-value" } });
    assertRooted(r, calls, await eventsOf(dir, r));
  });
});

test("自动：model 覆盖 / reasoning 覆盖 → 静默关闭、派发成功、continuableOff=override（原本能派的不会变成派不出去）", async () => {
  for (const override of [{ modelOverride: "fixture-model" }, { reasoningOverride: "high" }]) {
    await scenario({}, async ({ dispatch, calls, dir }) => {
      const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE, ...override });
      assertOrdinary(r, calls, await eventsOf(dir, r));
      assert.equal(r.continuableOff, "override");
      assert.ok(r.effectiveModel || r.effectiveReasoning, "覆盖本身照常生效");
    });
  }
});

test("自动：无绑定 cwd → 静默关闭、派发成功、continuableOff=no_workspace", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE, cwd: undefined });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "no_workspace");
  });
});

test("自动：只读派发（非交付）→ 静默关闭、派发成功；只读 + 交付仍按既有错误拒绝", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ readOnly: true, backendFor: CAPABLE });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal("continuableOff" in r, false, "非交付派发不带原因");
    assert.ok(calls[0].args.includes("--read-only"));
  });
  await scenario({}, async ({ dispatch, calls, dir }) => {
    await assert.rejects(
      () => dispatch({ readOnly: true, delivery: DELIVERY, backendFor: CAPABLE }),
      (e) => e.name === "ReadOnlyDeliveryConflictError",
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(jsonlFiles(dir), []);
  });
});

test("自动：lead_workspace 席位 × 交付 → 仍是谱系根（交付恒不走专家复用）；× 非交付 → 走专家复用，continuable:false", async () => {
  await scenario({ sessionReuse: "lead_workspace" }, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE });
    assertRooted(r, calls, await eventsOf(dir, r));
  });
  await scenario({ sessionReuse: "lead_workspace" }, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ backendFor: CAPABLE });
    assert.equal(r.accepted, true);
    assert.equal(r.continuable, false, "专家复用不是续修谱系");
    assert.equal(JSON.parse(argVal(calls, "--session-reuse-json")).mode, "lead_workspace");
    assert.equal("continuableOff" in r, false);
    void dir;
  });
});

test("自动：关闭时的 runner 参数与显式 false 逐字节相同（只差目录名）", async () => {
  async function argvFor(extra) {
    return scenario({}, async ({ dispatch, calls, dir }) => {
      await dispatch({ delivery: DELIVERY, runId: "run_b154_bytes", backendFor: INCAPABLE, ...extra });
      return calls[0].args.map((a) => String(a).split(dir).join("<DIR>").split(basename(dir)).join("<BASE>"));
    });
  }
  const autoOff = await argvFor({});
  const explicitOff = await argvFor({ continuable: false });
  assert.deepEqual(autoOff, explicitOff);
});

test("自动：被拒的派发（终态转录，没 fork）→ continuable:false", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const runId = "run_b154_preexist_terminal";
    const { JsonlTranscript } = await import("../../src/transcript.js");
    const t = new JsonlTranscript(resolveTranscriptPath(dir, runId), { runId, agentId: "seat" });
    await t.transitionState(null, "pending", "seed");
    await t.transitionState("pending", "failed", "seed_terminal");
    const r = await dispatch({ delivery: DELIVERY, runId, backendFor: CAPABLE });
    assert.equal(r.accepted, false);
    assert.equal(r.continuable, false);
    assert.equal(calls.length, 0);
    assert.deepEqual(slotEntries(dir), [], "仲裁被拒、没 fork：自动模式写下的槽已撤回，不留槽记录");
  });
});

// ── 显式 false ────────────────────────────────────────────────────────────

test("显式 false：能续的后端也不建谱系，continuable:false 且不带 continuableOff", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE, continuable: false });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal("continuableOff" in r, false, "只有自动模式没开成才带原因");
  });
});

// ── 显式 true：同样的情形仍按现有错误拒绝 ──────────────────────────────────

test("显式 true：model / reasoning 覆盖仍按 typed 冲突错误拒绝（零转录零 fork）", async () => {
  for (const [override, name] of [
    [{ modelOverride: "fixture-model" }, "ModelOverrideConflictError"],
    [{ reasoningOverride: "high" }, "ReasoningOverrideConflictError"],
  ]) {
    await scenario({}, async ({ dispatch, calls, dir }) => {
      await assert.rejects(
        () => dispatch({ delivery: DELIVERY, backendFor: CAPABLE, continuable: true, ...override }),
        (e) => e.name === name,
      );
      assert.equal(calls.length, 0);
      assert.deepEqual(jsonlFiles(dir), []);
    });
  }
});

test("显式 true：未注入解析器 → 回落共享工厂，能续的后端照常建谱系（不再是 Unsupported）", async () => {
  await scenario({ backend: "codex", model: { id: "fixture-model" } }, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, continuable: true });
    assertRooted(r, calls, await eventsOf(dir, r));
  });
});

test("显式 true：后端不支持 → ContinuableBackendUnsupportedError；非交付与只读 → ContinuableDeliveryOnlyError；无 cwd → 具名错误", async () => {
  const cases = [
    [{ delivery: DELIVERY, backendFor: INCAPABLE }, (e) => e.name === "ContinuableBackendUnsupportedError"],
    [{ delivery: DELIVERY, backendFor: () => null }, (e) => e.name === "ContinuableBackendUnsupportedError"],
    [{ backendFor: CAPABLE }, (e) => e.name === "ContinuableDeliveryOnlyError"],
    [{ readOnly: true, backendFor: CAPABLE }, (e) => e.name === "ContinuableDeliveryOnlyError"],
    [{ delivery: DELIVERY, backendFor: CAPABLE, cwd: undefined }, (e) => /bound workspace \(cwd\) is required/.test(e.message)],
  ];
  for (const [extra, check] of cases) {
    await scenario({}, async ({ dispatch, calls, dir }) => {
      await assert.rejects(() => dispatch({ continuable: true, ...extra }), check);
      assert.equal(calls.length, 0, "零 fork");
      assert.deepEqual(jsonlFiles(dir), [], "零转录");
    });
  }
});

test("显式 true：无令牌的 claude-code 仍受理并建谱系（令牌条件只在 spawn 时失败，与改前一致——只有自动模式预判）", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({
      delivery: DELIVERY, backendFor: factoryBackendFor, continuable: true, resolvedCredentials: { [TOKEN_ENV]: "" },
    });
    assertRooted(r, calls, await eventsOf(dir, r));
  });
});

// ── 判定矩阵（独立 oracle，与实现各算各的）────────────────────────────────

test("自动：判定矩阵——交付 × cwd × 后端能力 × 覆盖，仅全满足才开；原因取闭集", async () => {
  let combos = 0;
  for (const withDelivery of [true, false]) {
    for (const withCwd of [true, false]) {
      for (const capable of [true, false]) {
        for (const withOverride of [true, false]) {
          combos += 1;
          await scenario({}, async ({ dispatch, calls, dir }) => {
            const r = await dispatch({
              ...(withDelivery ? { delivery: DELIVERY } : {}),
              ...(withCwd ? {} : { cwd: undefined }),
              ...(withOverride ? { modelOverride: "fixture-model" } : {}),
              backendFor: capable ? CAPABLE : INCAPABLE,
            });
            const expectedOn = withDelivery && withCwd && capable && !withOverride;
            assert.equal(r.accepted, true);
            assert.equal(r.continuable, expectedOn, JSON.stringify({ withDelivery, withCwd, capable, withOverride }));
            assert.equal((argVal(calls, "--session-reuse-json") !== undefined), expectedOn);
            if (withDelivery && !expectedOn) {
              assert.ok(CONTINUABLE_OFF_REASONS.includes(r.continuableOff), `原因在闭集内：${r.continuableOff}`);
            } else {
              assert.equal("continuableOff" in r, false);
            }
            void dir;
          });
        }
      }
    }
  }
  assert.equal(combos, 16);
});

test("continuableOff 闭集：服务可产出的原因（顺序即判定先后）+ CLI 前台的 foreground", () => {
  assert.deepEqual([...CONTINUABLE_OFF_REASONS], [
    "no_workspace", "override", "backend_unsupported", "session_reuse_unavailable", "argv_budget", "lineage_slot_unavailable",
  ]);
  assert.equal(CONTINUABLE_OFF_FOREGROUND, "foreground");
});

// ── 后端能力查询 ──────────────────────────────────────────────────────────

test("claude-code 能力查询：令牌在解析结果里 → null；令牌被清空 → token_required（压过进程环境）", () => {
  const b = new ClaudeCodeBackend({ waoCliPath: "wao-cli-fixture" });
  assert.equal(b.sessionReuseUnavailableReason({ resolvedCredentials: { [TOKEN_ENV]: "fixture-oauth-value" } }), null);
  assert.equal(b.sessionReuseUnavailableReason({ resolvedCredentials: { [TOKEN_ENV.toLowerCase()]: "fixture-oauth-value" } }), null, "大小写不敏感，与 spawn 同一判定");
  const saved = process.env[TOKEN_ENV];
  try {
    process.env[TOKEN_ENV] = "fixture-env-value";
    assert.equal(b.sessionReuseUnavailableReason({ resolvedCredentials: { [TOKEN_ENV]: "" } }), "token_required");
  } finally {
    if (saved === undefined) delete process.env[TOKEN_ENV]; else process.env[TOKEN_ENV] = saved;
  }
});

test("claude-code 能力查询：解析结果里没有令牌时读进程环境——有 → null，无 → token_required", () => {
  const b = new ClaudeCodeBackend({ waoCliPath: "wao-cli-fixture" });
  const saved = process.env[TOKEN_ENV];
  try {
    process.env[TOKEN_ENV] = "fixture-env-value";
    assert.equal(b.sessionReuseUnavailableReason({ resolvedCredentials: {} }), null);
    assert.equal(b.sessionReuseUnavailableReason({}), null);
    delete process.env[TOKEN_ENV];
    assert.equal(b.sessionReuseUnavailableReason({ resolvedCredentials: {} }), "token_required");
    assert.equal(b.sessionReuseUnavailableReason(undefined), "token_required");
  } finally {
    if (saved === undefined) delete process.env[TOKEN_ENV]; else process.env[TOKEN_ENV] = saved;
  }
});

test("后端能力查询：进程式基类缺省 null（codex）；与 spawn 的令牌失败同一判定函数（claude-code 无令牌时 spawn 以 SESSION_REUSE_REQUIRES_TOKEN_ERROR 失败）", async () => {
  assert.equal(new CodexBackend({ waoCliPath: "wao-cli-fixture" }).sessionReuseUnavailableReason({}), null);
  const { SESSION_REUSE_REQUIRES_TOKEN_ERROR } = await import("../../src/backends/claudeCode.js");
  const b = new ClaudeCodeBackend({ waoCliPath: "wao-cli-fixture" });
  const task = { sessionReuse: { opaqueUuid: "00000000-0000-4000-8000-000000000000" }, resolvedCredentials: { [TOKEN_ENV]: "" } };
  assert.equal(b.sessionReuseUnavailableReason(task), "token_required");
  await assert.rejects(() => b.spawn({ id: "seat", cwd: tmpdir() }, task), (e) => e.message === SESSION_REUSE_REQUIRES_TOKEN_ERROR);
});

// ── 命令行预算（决定 0133 修正二·1）──────────────────────────────────────────
// 自动开启会给 runner 参数加谱系路由 + 身份材料参数，贴着 24000 上限的交付不能因此
// 被拒；claude-code 的 worker 启动预检也不能因 --session-id 超限而在 runner 起来后失败。

const ARGV_MAX = 24000;
const argvLen = (args) => args.reduce((sum, a) => sum + String(a).length + 1, 0);
const normArgs = (args, dir, runId) => args.map((a) => String(a)
  .split(dir).join("<DIR>").split(basename(dir)).join("<BASE>").split(runId).join("<RUN>"));
const PAD_RUN_A = "run_b154_pad_aaaa"; // 同长 runId：参数总长可比
const PAD_RUN_B = "run_b154_pad_bbbb";

// 用 --tag 填充把"显式 false 的 runner 参数总长"标定到 target（目录名长度恒定，可跨场景复用）。
async function padTagsFor(target) {
  return scenario({}, async ({ dispatch, calls }) => {
    await dispatch({ delivery: DELIVERY, continuable: false, backendFor: CAPABLE, runId: PAD_RUN_A, tags: ["pad=x"] });
    const base = argvLen(calls[0].args);
    return [`pad=${"x".repeat(1 + (target - base))}`];
  });
}
// 谱系参数（--session-reuse-json + --reuse-material-json）给 runner 参数多加的字符数：
// 同样的请求，显式 true 的总长减显式 false 的总长。
async function lineageExtrasLength() {
  const tags = ["pad=x"];
  const off = await scenario({}, async ({ dispatch, calls }) => {
    await dispatch({ delivery: DELIVERY, continuable: false, backendFor: CAPABLE, runId: PAD_RUN_A, tags });
    return argvLen(calls[0].args);
  });
  const on = await scenario({}, async ({ dispatch, calls }) => {
    await dispatch({ delivery: DELIVERY, continuable: true, backendFor: CAPABLE, runId: PAD_RUN_A, tags });
    return argvLen(calls[0].args);
  });
  return on - off;
}

test("自动·命令行预算 1（runner 参数）：显式 false 放得下、加上谱系参数放不下 → 静默关闭 argv_budget，参数与显式 false 逐字节相同，且没留谱系槽", async () => {
  // 余量 30 个字符小于谱系参数的长度：真实总长超限；但不算转录目录参数的话预估会偏小
  // 而放行——所以这条同时钉"预判必须把转录目录参数算进去"（算漏了就会先建槽，下面的
  // "没有槽目录"断言变红）。
  const extras = await lineageExtrasLength();
  assert.ok(extras > 30, `夹具：谱系参数长度 ${extras}`);
  const tags = await padTagsFor(ARGV_MAX - extras + 30);
  let explicitOffArgs;
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, continuable: false, backendFor: CAPABLE, runId: PAD_RUN_B, tags });
    assert.equal(r.accepted, true, "显式关闭放得下（原本能受理的派发）");
    assert.ok(argvLen(calls[0].args) <= ARGV_MAX, "显式关放得下");
    assert.ok(argvLen(calls[0].args) + extras > ARGV_MAX, "加上谱系参数就放不下（夹具成立）");
    explicitOffArgs = normArgs(calls[0].args, dir, PAD_RUN_B);
  });
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE, runId: PAD_RUN_B, tags });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "argv_budget");
    assert.equal(existsSync(join(dir, ".lineage-reuse")), false, "预算预判在任何谱系槽写入之前：没有槽目录、没有槽记录");
    assert.deepEqual(normArgs(calls[0].args, dir, PAD_RUN_B), explicitOffArgs, "关闭后的参数与显式 false 逐字节相同");
  });
  await scenario({}, async ({ dispatch, calls }) => {
    await assert.rejects(
      () => dispatch({ delivery: DELIVERY, backendFor: CAPABLE, runId: PAD_RUN_B, tags, continuable: true }),
      /runner argv too long/,
    );
    assert.equal(calls.length, 0, "显式 true 超限照旧按现有错误拒绝");
  });
});

test("自动·命令行预算 1：余量足够 → 照常开谱系（预判不误关）", async () => {
  const tags = await padTagsFor(ARGV_MAX - 1500);
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE, runId: PAD_RUN_B, tags });
    assertRooted(r, calls, await eventsOf(dir, r));
    assert.ok(argvLen(calls[0].args) <= ARGV_MAX);
  });
});

test("自动·命令行预算 2（worker 启动）：后端预检在带会话复用参数时超限、不带时能过 → 静默关闭 argv_budget，没留槽；本来就过不了的与谱系无关，不归在这里", async () => {
  const seen = [];
  const BUDGET_BACKEND = () => ({
    supportsSessionReuse: true,
    supportsRoleContract: true,
    async preflightInvocation(_agent, task) {
      seen.push(task);
      if (task.sessionReuse) throw new Error("fixture: over launch budget with session-reuse args");
    },
  });
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: BUDGET_BACKEND });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "argv_budget");
    assert.equal(existsSync(join(dir, ".lineage-reuse")), false, "没留谱系槽");
  });
  assert.equal(seen.length, 2, "先带复用参数试一次，超限后不带再试一次做归因");
  assert.equal(seen[0].sessionReuse.mode, "run_lineage");
  assert.equal(seen[0].sessionReuse.turn, "first");
  assert.equal(seen[1].sessionReuse, undefined);
  // 不带谱系也过不了（与谱系无关）→ 不归 argv_budget，仍开（派发在 runner 里照常失败，与关闭时一样）。
  const DOOMED = () => ({ supportsSessionReuse: true, async preflightInvocation() { throw new Error("fixture: cannot launch at all"); } });
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: DOOMED });
    assertRooted(r, calls, await eventsOf(dir, r));
  });
  // 预检通过 → 开，且只预检一次。
  const ok = [];
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: () => ({ supportsSessionReuse: true, async preflightInvocation(_a, task) { ok.push(task); } }) });
    assertRooted(r, calls, await eventsOf(dir, r));
  });
  assert.equal(ok.length, 1);
});

test("自动·命令行预算 2：交给后端预检的角色合同与 runner 同一拼法（身份头 + 角色正文 + 交付合同）", async () => {
  const seen = [];
  const PREFLIGHT = () => ({
    supportsSessionReuse: true,
    supportsRoleContract: true,
    deliveryContractSupplement: ["- fixture supplement clause."],
    async preflightInvocation(_agent, task) { seen.push(task.roleContract); },
  });
  const role = loadRoleContract("config/roles/coder.md");
  // 无车道的席位角色：无身份头。
  await scenario({ systemPrompt: "config/roles/coder.md" }, async ({ dispatch }) => {
    await dispatch({ delivery: DELIVERY, backendFor: PREFLIGHT });
  });
  assert.equal(seen[0], composeDeliveryRoleContract({
    roleContract: composeRoleContractWithIdentity({ roleContract: role, agentId: "seat" }),
    allowedPaths: ["src"],
    backendSupplement: ["- fixture supplement clause."],
  }));
  // 显式车道 + 角色：身份头用结构化 lane/role，角色取角色库文件。
  seen.length = 0;
  const researcher = loadRoleContract("config/roles/researcher.md");
  await scenario({}, async ({ dispatch }) => {
    await dispatch({ delivery: DELIVERY, backendFor: PREFLIGHT, resolvedLane: "opus", resolvedRole: "researcher" });
  });
  assert.equal(seen[0], composeDeliveryRoleContract({
    roleContract: composeRoleContractWithIdentity({ roleContract: researcher, agentId: "seat", identity: { laneId: "opus", roleId: "researcher" } }),
    allowedPaths: ["src"],
    backendSupplement: ["- fixture supplement clause."],
  }));
  // 无角色：只有交付合同。
  seen.length = 0;
  await scenario({}, async ({ dispatch }) => {
    await dispatch({ delivery: DELIVERY, backendFor: PREFLIGHT });
  });
  assert.equal(seen[0], composeDeliveryRoleContract({
    roleContract: undefined, allowedPaths: ["src"], backendSupplement: ["- fixture supplement clause."],
  }));
});

test("自动·命令行预算 2（真实 claude-code 后端，Windows .cmd 预算）：带 --session-id 超限、不带能过 → 静默关闭 argv_budget；余量足够 → 开", { skip: process.platform !== "win32" }, async () => {
  const { composeDeliveryExecutionContract } = await import("../../src/application/roleContract.js");
  const backend = new ClaudeCodeBackend({ waoCliPath: "wao-cli-fixture" });
  const agent = { id: "seat", backend: "claude-code", binary: "fixture-claude.cmd", cwd: tmpdir() };
  const routing = { mode: "run_lineage", opaqueUuid: "00000000-0000-4000-8000-000000000000", turn: "first" };
  // 一个长度逐字符可调的路径：边界扫描的粒度是 1 个字符（比会话复用参数的字数细），找得到。
  const pathsOf = (k) => ["src", `docs/${"p".repeat(k)}`];
  const passes = async (k, withRouting) => {
    try {
      await backend.preflightInvocation(agent, {
        prompt: "do the work",
        roleContract: composeDeliveryExecutionContract({ allowedPaths: pathsOf(k) }),
        ...(withRouting ? { sessionReuse: routing } : {}),
      });
      return true;
    } catch { return false; }
  };
  // 二分找边界：最大的 k 使"不带复用参数"能过；再 +0..N 找到"不带能过、带复用参数过不了"的 k。
  let lo = 0; let hi = 12000;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (await passes(mid, false)) lo = mid; else hi = mid - 1; }
  let boundary = -1;
  for (let k = lo; k >= Math.max(0, lo - 3); k--) {
    if (await passes(k, false) && !(await passes(k, true))) { boundary = k; break; }
  }
  assert.ok(boundary >= 0, "找到只被会话复用参数顶过线的授权路径条数");
  const dispatchWith = (k, extra) => scenario({ binary: "fixture-claude.cmd" }, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({
      delivery: { ...DELIVERY, allowedPaths: pathsOf(k) }, backendFor: factoryBackendFor,
      resolvedCredentials: { [TOKEN_ENV]: "fixture-oauth-value" }, ...extra,
    });
    return { r, calls, dir, events: await eventsOf(dir, r), slotDirExists: existsSync(join(dir, ".lineage-reuse")) };
  });
  const over = await dispatchWith(boundary);
  assertOrdinary(over.r, over.calls, over.events);
  assert.equal(over.r.continuableOff, "argv_budget");
  assert.equal(over.slotDirExists, false, "没留谱系槽");
  const roomy = await dispatchWith(Math.max(0, boundary - 100));
  assertRooted(roomy.r, roomy.calls, roomy.events);
});

test("命令行预算预判的转录目录估计：不小于真实新建桶目录的长度（项目桶、保留名项目桶 0- 前缀、沙箱/草稿/未归属桶）", async () => {
  const { maxNewTranscriptDirLength, resolveRunDirForWrite } = await import("../../src/projectBuckets.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-b154-bound-"));
  try {
    // 临时目录下 identifyProjectFromCwd 只会给 scratch 桶，所以项目身份直接构造：
    // 走 resolveRunDirForWrite 的项目桶分支（displayName + 哈希，保留名加 "0-"）。
    const identities = [
      { kind: "project", key: "d:/work/b154-project", displayName: "b154-project" },
      { kind: "project", key: "d:/work/aux", displayName: "aux" },
      { kind: "project", key: `d:/work/${"n".repeat(40)}`, displayName: "n".repeat(40) },
      { kind: "sandbox" }, { kind: "scratch" }, { kind: "unattributed" },
    ];
    for (const identity of identities) {
      const runDir = join(dir, `runs-${identity.kind}-${identity.displayName ?? "x"}`);
      const real = resolveRunDirForWrite(runDir, identity);
      assert.ok(
        maxNewTranscriptDirLength(runDir, identity) >= real.transcriptDir.length,
        `${identity.kind}/${identity.displayName ?? "-"}：估计 ≥ 真实长度`,
      );
      if (identity.kind === "project") {
        assert.equal(real.bucket.startsWith("0-"), identity.displayName === "aux", "保留名才加 0- 前缀");
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 真实检查为准：转录目录估不准时自动谱系撤回自己的槽（决定 0133 修正三·1）──────

// os.tmpdir() 指向别处：临时目录下的 cwd 才会被判成"项目桶"（默认被判 scratch 桶）。
async function asProjectBucketHost(fn) {
  const elsewhere = mkdtempSync(join(tmpdir(), "wao-b154-faketmp-"));
  const names = ["TEMP", "TMP", "TMPDIR"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) process.env[n] = elsewhere;
  try {
    return await fn();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
    }
    rmSync(elsewhere, { recursive: true, force: true });
  }
}

test("自动·真实检查为准：同一项目已有的长桶让预估偏小——槽写入后真实超限，撤回自己的槽、不带谱系照常派发（argv_budget），参数与显式 false 逐字节相同", async () => {
  const { identifyProjectFromCwd, productionProjectIo, PROJECT_IDENTITY_RULES_VERSION } = await import("../../src/projectIdentity.js");
  const { PROJECT_RECORD_NAME } = await import("../../src/projectBuckets.js");
  const extras = await lineageExtrasLength();
  const prepareLongBucket = (dir, repo) => {
    const identity = asProjectIdentityOf(repo);
    // 同一项目更早建出的长桶（比新桶规则的最长形状还长）：新 run 会复用它。
    const slug = `${identity.displayName}-${"x".repeat(100)}-0123abcd`;
    const bucketDir = join(dir, "projects", slug);
    mkdirSync(bucketDir, { recursive: true });
    writeFileSync(join(bucketDir, PROJECT_RECORD_NAME), JSON.stringify({
      key: identity.key, slug, displayName: identity.displayName,
      rulesVersion: PROJECT_IDENTITY_RULES_VERSION, createdAt: new Date().toISOString(), aliases: [],
    }), "utf8");
    return bucketDir;
  };
  function asProjectIdentityOf(repo) {
    const identity = identifyProjectFromCwd(repo, productionProjectIo());
    assert.equal(identity.kind, "project", "夹具：cwd 被判成项目桶");
    return identity;
  }
  await asProjectBucketHost(async () => {
    // 先在同样的长桶里量显式 false 的总长，再标定余量：真实总长刚好超限 1 个字符，
    // 而预估（按新桶最长形状）比真实短，预判放行。
    const baseline = await scenario({}, async ({ dispatch, calls, dir, repo }) => {
      prepareLongBucket(dir, repo);
      await dispatch({ delivery: DELIVERY, continuable: false, backendFor: CAPABLE, runId: PAD_RUN_A, tags: ["pad=x"] });
      return argvLen(calls[0].args);
    });
    const tags = [`pad=${"x".repeat(1 + (ARGV_MAX + 1 - extras - baseline))}`];
    let explicitOffArgs;
    await scenario({}, async ({ dispatch, calls, dir, repo }) => {
      prepareLongBucket(dir, repo);
      const r = await dispatch({ delivery: DELIVERY, continuable: false, backendFor: CAPABLE, runId: PAD_RUN_B, tags });
      assert.equal(r.accepted, true, "同一请求显式关能受理");
      assert.ok(argvLen(calls[0].args) + extras > ARGV_MAX, "夹具：加上谱系参数后真实总长超限");
      explicitOffArgs = normArgs(calls[0].args, dir, PAD_RUN_B);
    });
    await scenario({}, async ({ dispatch, calls, dir, repo }) => {
      prepareLongBucket(dir, repo);
      const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE, runId: PAD_RUN_B, tags });
      assertOrdinary(r, calls, await eventsOf(dir, r));
      assert.equal(r.continuableOff, "argv_budget");
      assert.deepEqual(slotEntries(dir), [], "写过又撤回：没有槽残留");
      assert.deepEqual(normArgs(calls[0].args, dir, PAD_RUN_B), explicitOffArgs, "回退后的参数与显式 false 逐字节相同");
      assert.ok(argvLen(calls[0].args) <= ARGV_MAX);
    });
    await scenario({}, async ({ dispatch, calls, dir, repo }) => {
      prepareLongBucket(dir, repo);
      await assert.rejects(
        () => dispatch({ delivery: DELIVERY, backendFor: CAPABLE, runId: PAD_RUN_B, tags, continuable: true }),
        /runner argv too long after transcript-dir/,
      );
      assert.equal(calls.length, 0, "显式 true 超限照旧按现有错误拒绝");
    });
  });
});

test("自动·撤槽只动自己的那一条：撤回前槽已被别人接手（续修子运行）→ 不动对方的记录", async () => {
  const { releaseLineageFirstTurn, resolveLineageFirstTurn } = await import("../../src/application/sessionReuse.js");
  await scenario({}, async ({ dir, repo }) => {
    const material = {
      laneFingerprint: laneFingerprintOf({ backend: "claude-code", modelId: null, providerID: null, providerKey: null }),
      roleSha256: "none",
    };
    const base = { runDir: dir, workspace: proveWorkspaceRoot(repo).root, agentId: "seat", rootRunId: "run_b154_release_root", ...material };
    const first = await resolveLineageFirstTurn({ ...base, runId: "run_b154_release_root" });
    assert.equal(first.kind, "first");
    assert.deepEqual(first.claim.previousEntry, null);
    const keyHash = deriveLineageReuseKeyHash(base);
    const file = join(dir, ".lineage-reuse", `${keyHash}.json`);
    // 别人（续修子运行）接手了槽：撤回必须按内容核对、不动它。
    writeFileSync(file, JSON.stringify({ runId: "run_b154_release_child", updatedAt: Date.now() }), "utf8");
    assert.equal(await releaseLineageFirstTurn({ runDir: dir, claim: first.claim }), false);
    assert.match(readFileSync(file, "utf8"), /run_b154_release_child/);
    // 槽还是自己的：撤回成功（没有前任条目 = 删除）；再撤一次 = 无操作。
    writeFileSync(file, JSON.stringify({ runId: "run_b154_release_root", updatedAt: Date.now() }), "utf8");
    assert.equal(await releaseLineageFirstTurn({ runDir: dir, claim: first.claim }), true);
    assert.deepEqual(slotEntries(dir), []);
    assert.equal(await releaseLineageFirstTurn({ runDir: dir, claim: first.claim }), false);
  });
});

// ── worker 启动预检带上 correctable（决定 0133 修正三·2）────────────────────────

test("自动 + correctable：后端预检在带 correctable + 会话复用参数时超限、只带 correctable 能过 → 静默关闭 argv_budget；预检入参都带 correctable", async () => {
  const seen = [];
  const CORRECTABLE_BACKEND = () => ({
    supportsSessionReuse: true,
    supportsInFlightCorrection: true,
    supportsRoleContract: true,
    async preflightInvocation(_agent, task) {
      seen.push({ correctable: task.correctable === true, reuse: Boolean(task.sessionReuse) });
      if (task.correctable === true && task.sessionReuse) throw new Error("fixture: correctable + lineage args over budget");
    },
  });
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: CORRECTABLE_BACKEND, correctable: true });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "argv_budget");
    assert.equal(existsSync(join(dir, ".lineage-reuse")), false, "没留谱系槽");
  });
  assert.deepEqual(seen, [{ correctable: true, reuse: true }, { correctable: true, reuse: false }]);
  // 不可纠偏的派发：预检入参不带 correctable（与真实 spawn 一致）。
  seen.length = 0;
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({ delivery: DELIVERY, backendFor: CORRECTABLE_BACKEND });
    assertRooted(r, calls, await eventsOf(dir, r));
  });
  assert.deepEqual(seen, [{ correctable: false, reuse: true }]);
});

test("自动 + correctable（真实 claude-code 后端，Windows .cmd 预算）：可纠偏启动能过、带谱系的可纠偏启动超限 → 静默关闭 argv_budget", { skip: process.platform !== "win32" }, async () => {
  const { composeDeliveryExecutionContract } = await import("../../src/application/roleContract.js");
  const backend = new ClaudeCodeBackend({ waoCliPath: "wao-cli-fixture" });
  const agent = { id: "seat", backend: "claude-code", binary: "fixture-claude.cmd", cwd: tmpdir() };
  const routing = { mode: "run_lineage", opaqueUuid: "00000000-0000-4000-8000-000000000000", turn: "first" };
  // 一个长度逐字符可调的路径：边界扫描的粒度是 1 个字符（比会话复用参数的字数细），找得到。
  const pathsOf = (k) => ["src", `docs/${"p".repeat(k)}`];
  const passes = async (k, withRouting) => {
    try {
      await backend.preflightInvocation(agent, {
        prompt: "do the work",
        roleContract: composeDeliveryExecutionContract({ allowedPaths: pathsOf(k) }),
        correctable: true,
        ...(withRouting ? { sessionReuse: routing } : {}),
      });
      return true;
    } catch { return false; }
  };
  let lo = 0; let hi = 12000;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (await passes(mid, false)) lo = mid; else hi = mid - 1; }
  let boundary = -1;
  for (let k = lo; k >= Math.max(0, lo - 3); k--) {
    if (await passes(k, false) && !(await passes(k, true))) { boundary = k; break; }
  }
  assert.ok(boundary >= 0, "找到只被会话复用参数顶过线的授权路径条数（可纠偏形状）");
  // 不带 correctable 时，同样的条数能过（说明这条是 correctable 参数把它推到边上的）。
  await backend.preflightInvocation(agent, {
    prompt: "do the work",
    roleContract: composeDeliveryExecutionContract({ allowedPaths: pathsOf(boundary) }),
    sessionReuse: routing,
  });
  await scenario({ binary: "fixture-claude.cmd" }, async ({ dispatch, calls, dir }) => {
    const r = await dispatch({
      delivery: { ...DELIVERY, allowedPaths: pathsOf(boundary) }, backendFor: factoryBackendFor,
      resolvedCredentials: { [TOKEN_ENV]: "fixture-oauth-value" }, correctable: true,
    });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "argv_budget");
    assert.equal(existsSync(join(dir, ".lineage-reuse")), false);
  });
});

test("RunManager.start 的启动预检带上 correctable（与真实 spawn 一致）；不可纠偏运行不带", async () => {
  const { RunManager } = await import("../../src/runManager.js");
  const { readRegistry } = await import("../../src/registry.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-b154-rmcorr-"));
  try {
    const registryPath = join(dir, "agents.json");
    const repo = repoDir();
    writeFileSync(registryPath, JSON.stringify({ agents: { seat: { backend: "claude-code", cwd: repo } } }), "utf8");
    const preflights = [];
    const spawns = [];
    const fakeBackend = {
      supportsRoleContract: true,
      supportsInFlightCorrection: true,
      sessionOutlivesProcess: false,
      async preflightInvocation(_agent, task) { preflights.push(task); },
      async spawn(_agent, task) {
        spawns.push(task);
        return {
          backend: "claude-code", backendSessionId: "s1", messageId: "m1", admittedSeq: 5,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
          sendCorrection: async () => ({ delivered: true }),
        };
      },
      defaultBinary() { return "node"; },
      credentialEnvNames: () => [],
    };
    const manager = new RunManager({
      config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
      readRegistry: async () => readRegistry(registryPath),
      transcriptDir: join(dir, "runs"),
      backendFor: () => fakeBackend,
      userEnvReader: async () => ({}),
    });
    for (const correctable of [true, false]) {
      const run = await manager.start("seat", {
        prompt: "task", runDir: join(dir, "runs"), registry: registryPath, cwd: repo, correctable,
      });
      try { await run.waitForCompletion({ pollInterval: 1 }); } catch { /* 假后端立即完成；等待出错不影响本断言 */ }
    }
    assert.equal(preflights.length, 2);
    assert.equal(preflights[0].correctable, true);
    assert.equal(preflights[1].correctable, undefined);
    assert.equal(spawns[0].correctable, true, "真实 spawn 带 correctable——预检与它一致");
    assert.equal(spawns[1].correctable, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 派发预判的角色合同 = runner 实际交给后端的入参（决定 0133 修正三·5）──────────

test("自动·命令行预算 2：派发预判算出的角色合同，与 RunManager.start 实际交给后端预检/spawn 的入参逐字节相同（席位角色、显式车道+角色、无角色）", async () => {
  const { RunManager } = await import("../../src/runManager.js");
  const { readRegistry } = await import("../../src/registry.js");
  const SUPPLEMENT = ["- fixture supplement clause."];
  const shapes = [
    { name: "席位角色", agent: { systemPrompt: "config/roles/coder.md" }, dispatch: {}, target: undefined },
    {
      name: "显式车道+角色", agent: {}, dispatch: { resolvedLane: "opus", resolvedRole: "researcher" },
      target: { kind: "resolved", source: "explicit", agentId: "seat", laneId: "opus", roleId: "researcher", lanesSha256: "ab".repeat(32) },
    },
    { name: "无角色", agent: {}, dispatch: {}, target: undefined },
  ];
  for (const shape of shapes) {
    const dispatchSide = { preflight: [], spawn: [] };
    const startSide = { preflight: [], spawn: [] };
    const makeBackend = (sink) => ({
      supportsSessionReuse: true,
      supportsRoleContract: true,
      sessionOutlivesProcess: false,
      deliveryContractSupplement: SUPPLEMENT,
      async preflightInvocation(_agent, task) { sink.preflight.push(task.roleContract); },
      async spawn(_agent, task) {
        sink.spawn.push(task.roleContract);
        return {
          backend: "claude-code", backendSessionId: "s1", messageId: "m1", admittedSeq: 5,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
        };
      },
      defaultBinary() { return "node"; },
      credentialEnvNames: () => [],
    });
    await scenario(shape.agent, async ({ dispatch, dir, repo }) => {
      // 派发侧：预判里交给后端预检的合同（第一次调用，带谱系参数）。
      await dispatch({ delivery: DELIVERY, backendFor: () => makeBackend(dispatchSide), ...shape.dispatch });
      // runner 侧：RunManager.start 用同一份 registry / 交付 / 车道+角色。
      const registryPath = join(dir, "agents.json");
      const manager = new RunManager({
        config: { registry: registryPath, runDir: join(dir, "runs"), defaultIsolation: "none" },
        readRegistry: async () => readRegistry(registryPath),
        transcriptDir: join(dir, "runs"),
        backendFor: () => makeBackend(startSide),
        userEnvReader: async () => ({}),
      });
      const run = await manager.start("seat", {
        prompt: "do the work", runDir: join(dir, "runs"), registry: registryPath, cwd: repo, isolate: true,
        delivery: { ...DELIVERY },
        ...(shape.target ? { resolvedTarget: shape.target } : {}),
      });
      try { await run.waitForCompletion({ pollInterval: 1 }); } catch { /* 假后端立即完成 */ }
    });
    assert.ok(dispatchSide.preflight.length >= 1 && typeof dispatchSide.preflight[0] === "string", `${shape.name}：派发侧拿到合同`);
    assert.equal(startSide.preflight.length, 1);
    assert.equal(dispatchSide.preflight[0], startSide.preflight[0], `${shape.name}：派发预判与 runner 预检入参逐字节相同`);
    assert.equal(startSide.spawn[0], startSide.preflight[0], `${shape.name}：预检与真实 spawn 入参相同`);
  }
});

// ── 谱系槽忙或存储故障（决定 0133 修正二·2）────────────────────────────────

function seedActiveChildSlot(dir, repo, rootRunId) {
  const keyHash = deriveLineageReuseKeyHash({
    workspace: proveWorkspaceRoot(repo).root,
    agentId: "seat",
    rootRunId,
    laneFingerprint: laneFingerprintOf({ backend: "claude-code", modelId: null, providerID: null, providerKey: null }),
    roleSha256: "none",
  });
  const slotDir = join(dir, ".lineage-reuse");
  mkdirSync(slotDir, { recursive: true });
  const file = join(slotDir, `${keyHash}.json`);
  writeFileSync(file, JSON.stringify({ runId: "run_b154_active_child", updatedAt: Date.now() }), "utf8");
  return file;
}

test("自动：谱系槽忙（同一根 runId、同一谱系键已有活跃子运行）→ 静默关闭 lineage_slot_unavailable、派发成功、不动别人的槽；显式 true 照旧 ReuseBusyError", async () => {
  const RUN = "run_b154_slot_busy_a";
  await scenario({}, async ({ dispatch, calls, dir, repo }) => {
    const file = seedActiveChildSlot(dir, repo, RUN);
    const before = readFileSync(file, "utf8");
    const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE, runId: RUN });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "lineage_slot_unavailable");
    assert.equal(readFileSync(file, "utf8"), before, "别人的槽记录原样保留");
    assert.equal(existsSync(join(dir, ".lineage-reuse", ".locks")), false, "槽忙时不留空的 .locks 目录");
  });
  await scenario({}, async ({ dispatch, calls, dir, repo }) => {
    seedActiveChildSlot(dir, repo, RUN);
    await assert.rejects(
      () => dispatch({ delivery: DELIVERY, backendFor: CAPABLE, runId: RUN, continuable: true }),
      (e) => e.name === "ReuseBusyError",
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(jsonlFiles(dir), []);
  });
});

test("自动：谱系槽存储故障（.lineage-reuse 路径被文件占住，ENOTDIR）→ 静默关闭 lineage_slot_unavailable、派发成功；显式 true 照旧拒绝", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    writeFileSync(join(dir, ".lineage-reuse"), "not a directory", "utf8");
    const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE });
    assertOrdinary(r, calls, await eventsOf(dir, r));
    assert.equal(r.continuableOff, "lineage_slot_unavailable");
  });
  await scenario({}, async ({ dispatch, calls, dir }) => {
    writeFileSync(join(dir, ".lineage-reuse"), "not a directory", "utf8");
    await assert.rejects(() => dispatch({ delivery: DELIVERY, backendFor: CAPABLE, continuable: true }));
    assert.equal(calls.length, 0);
    assert.deepEqual(jsonlFiles(dir), []);
  });
});

test("自动：槽写入的最后一步 rename 出 EACCES / 写锁内容失败 → 静默关闭 lineage_slot_unavailable、派发成功、槽目录下没有任何残留（.tmp-*、锁文件、.locks）；显式 true 照旧拒绝", async () => {
  const eacces = () => Object.assign(new Error("EACCES: fixture rename failure"), { code: "EACCES", syscall: "rename" });
  const noSpace = () => Object.assign(new Error("ENOSPC: fixture lock write failure"), { code: "ENOSPC", syscall: "write" });
  const injections = [
    ["rename EACCES", { rename: async () => { throw eacces(); } }],
    ["写锁内容失败", {
      open: async (path, flags) => {
        const handle = await open(path, flags);
        return { writeFile: async () => { throw noSpace(); }, close: () => handle.close() };
      },
    }],
  ];
  for (const [label, io] of injections) {
    await scenario({}, async ({ dispatch, calls, dir }) => {
      const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE, lineageStore: createLineageStore(dir, io) });
      assertOrdinary(r, calls, await eventsOf(dir, r));
      assert.equal(r.continuableOff, "lineage_slot_unavailable", label);
      assert.equal(existsSync(join(dir, ".lineage-reuse")), false, `${label}：槽目录是这次建的，失败后整条链回收`);
    });
    await scenario({}, async ({ dispatch, calls, dir }) => {
      await assert.rejects(
        () => dispatch({ delivery: DELIVERY, backendFor: CAPABLE, continuable: true, lineageStore: createLineageStore(dir, io) }),
        (e) => e.name === "LineageSlotStorageError",
      );
      assert.equal(calls.length, 0);
      assert.deepEqual(jsonlFiles(dir), []);
      assert.equal(existsSync(join(dir, ".lineage-reuse")), false, `${label}：显式 true 拒绝也不留残留`);
    });
  }
});

test("自动：只接住槽忙与槽存储错误——槽实现里的编程错误（TypeError）照常抛出，零转录零 fork", async () => {
  await scenario({}, async ({ dispatch, calls, dir }) => {
    const store = createLineageStore(dir);
    store.readEntry = async () => { throw new TypeError("fixture programming error"); };
    await assert.rejects(
      () => dispatch({ delivery: DELIVERY, backendFor: CAPABLE, lineageStore: store }),
      (e) => e instanceof TypeError && /fixture programming error/.test(e.message),
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(jsonlFiles(dir), []);
  });
});

test("自动：关闭原因的判定顺序——no_workspace > override > backend_unsupported > session_reuse_unavailable > argv_budget > lineage_slot_unavailable（复合条件钉每个确切值）", async () => {
  const tags = await padTagsFor(ARGV_MAX - 10);
  const INCAPABLE_WITH_REASON = () => ({ supportsSessionReuse: false, sessionReuseUnavailableReason: () => "token_required" });
  const RUN = PAD_RUN_B;
  const cases = [
    ["no_workspace", { cwd: undefined, modelOverride: "m", backendFor: INCAPABLE_WITH_REASON }],
    ["override", { modelOverride: "m", backendFor: INCAPABLE_WITH_REASON }],
    ["override", { reasoningOverride: "high", backendFor: NOT_READY }],
    ["backend_unsupported", { backendFor: INCAPABLE_WITH_REASON, tags, busySlot: true }],
    ["session_reuse_unavailable", { backendFor: NOT_READY, tags, busySlot: true }],
    ["argv_budget", { backendFor: CAPABLE, tags, busySlot: true }],
    ["lineage_slot_unavailable", { backendFor: CAPABLE, busySlot: true }],
  ];
  for (const [expected, { busySlot, ...extra }] of cases) {
    await scenario({}, async ({ dispatch, calls, dir, repo }) => {
      const slotFile = busySlot ? seedActiveChildSlot(dir, repo, RUN) : null;
      const r = await dispatch({ delivery: DELIVERY, runId: RUN, ...extra });
      assert.equal(r.accepted, true, `${expected}：派发成功`);
      assert.equal(r.continuable, false);
      assert.equal(r.continuableOff, expected, JSON.stringify(Object.keys(extra)));
      assert.equal(argVal(calls, "--session-reuse-json"), undefined);
      if (slotFile) assert.match(readFileSync(slotFile, "utf8"), /run_b154_active_child/, "任何关闭路径都不改别人的槽");
    });
  }
});

// ── 谱系身份：相对 --cwd（决定 0133 修正二·4）──────────────────────────────

// 续修侧（`runs continue` / MCP run_continue）的工作区：对授权路径做 proveWorkspaceRoot
// 取 .root，再按谱系材料推 uuid。首轮必须与它同源，不能是 path.resolve 的结果。
function continueSideUuid(pathVariant, runId, material) {
  return deriveLineageOpaqueUuid({
    workspace: proveWorkspaceRoot(pathVariant).root, agentId: "seat", rootRunId: runId, ...material,
  });
}
async function dispatchAndReadLineage(dispatch, calls, dir, extra) {
  const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE, ...extra });
  assertRooted(r, calls, await eventsOf(dir, r));
  return {
    r,
    routing: JSON.parse(argVal(calls, "--session-reuse-json")),
    material: JSON.parse(argVal(calls, "--reuse-material-json")),
  };
}

test("自动 + 显式：相对 --cwd 派发，谱系 opaque uuid 与续修侧（proveWorkspaceRoot 的根）重算的一致", async () => {
  for (const mode of [{}, { continuable: true }]) {
    await scenario({}, async ({ dispatch, calls, dir, repo }) => {
      const prev = process.cwd();
      process.chdir(repo);
      try {
        const { r, routing, material } = await dispatchAndReadLineage(dispatch, calls, dir, { cwd: ".", ...mode });
        assert.equal(argVal(calls, "--cwd"), ".", "runner 参数仍是原样 --cwd（HTTP 后端把它当远端提示）");
        assert.equal(routing.opaqueUuid, continueSideUuid(process.cwd(), r.runId, material), `${JSON.stringify(mode)}：与续修侧同源`);
        assert.notEqual(
          routing.opaqueUuid,
          deriveLineageOpaqueUuid({ workspace: ".", agentId: "seat", rootRunId: r.runId, ...material }),
          "没有退回原样的相对路径",
        );
      } finally {
        process.chdir(prev);
      }
    });
  }
});

test("自动 + 显式：经 junction 路径派发，谱系 opaque uuid 与续修侧（proveWorkspaceRoot 解析 junction 后的根）重算的一致", async () => {
  for (const mode of [{}, { continuable: true }]) {
    await scenario({}, async ({ dispatch, calls, dir, repo }) => {
      const link = join(dir, "repo-link");
      symlinkSync(repo, link, "junction");
      const { r, routing, material } = await dispatchAndReadLineage(dispatch, calls, dir, { cwd: link, ...mode });
      assert.equal(routing.opaqueUuid, continueSideUuid(link, r.runId, material), `${JSON.stringify(mode)}：与续修侧同源`);
      assert.equal(routing.opaqueUuid, continueSideUuid(repo, r.runId, material), "从 junction 和从真实路径续修是同一个会话");
      assert.notEqual(
        routing.opaqueUuid,
        deriveLineageOpaqueUuid({ workspace: link, agentId: "seat", rootRunId: r.runId, ...material }),
        "没有退回 path.resolve 的 junction 路径",
      );
    });
  }
});

test("自动 + 显式：目录名大小写与盘上不同的路径派发（Windows），谱系 opaque uuid 与续修侧重算的一致", { skip: process.platform !== "win32" }, async () => {
  for (const mode of [{}, { continuable: true }]) {
    await scenario({}, async ({ dispatch, calls, dir, repo }) => {
      const variant = join(dirname(repo), basename(repo).toUpperCase());
      assert.notEqual(variant, repo, "夹具：变体拼写确实与盘上不同");
      const { r, routing, material } = await dispatchAndReadLineage(dispatch, calls, dir, { cwd: variant, ...mode });
      assert.equal(routing.opaqueUuid, continueSideUuid(variant, r.runId, material), `${JSON.stringify(mode)}：与续修侧同源`);
      assert.equal(routing.opaqueUuid, continueSideUuid(repo, r.runId, material), "大小写拼写不同也是同一个会话");
    });
  }
});

test("自动：绑定的 cwd 过不了 Git 顶层证明（非 Git 目录、Git 仓的子目录）→ 静默关闭、派发成功，continuableOff=no_workspace；显式 true 用现有的需要工作区错误拒绝", async () => {
  await scenario({}, async ({ dispatch, calls, dir, repo }) => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });
    for (const cwd of [plain, sub]) {
      const r = await dispatch({ delivery: DELIVERY, backendFor: CAPABLE, cwd, runId: `run_b154_nows_${basename(cwd)}` });
      assert.equal(r.accepted, true);
      assert.equal(r.continuable, false);
      assert.equal(r.continuableOff, "no_workspace", cwd);
    }
    assert.equal(existsSync(join(dir, ".lineage-reuse")), false);
    for (const cwd of [plain, sub]) {
      const before = calls.length;
      await assert.rejects(
        () => dispatch({ delivery: DELIVERY, backendFor: CAPABLE, cwd, continuable: true, runId: `run_b154_nows2_${basename(cwd)}` }),
        /bound workspace \(cwd\) is required for a continuable delivery/,
      );
      assert.equal(calls.length, before, "显式 true 拒绝：零 fork");
    }
  });
});

// ── 令牌只在 Windows 用户环境（决定 0133 修正二·6）────────────────────────

test("自动：令牌只在用户环境（resolvedCredentials 为空）→ 经凭据预检解析进 finalCredentials，仍然开；用户环境也没有 → 关", async () => {
  const saved = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  try {
    await scenario({}, async ({ dispatch, calls, dir }) => {
      const r = await dispatch({
        delivery: DELIVERY, backendFor: factoryBackendFor, skipCredentialCheck: false,
        userEnvReader: async (name) => (name === TOKEN_ENV ? "fixture-oauth-value" : undefined),
      });
      assertRooted(r, calls, await eventsOf(dir, r));
    });
    await scenario({}, async ({ dispatch, calls, dir }) => {
      const r = await dispatch({
        delivery: DELIVERY, backendFor: factoryBackendFor, skipCredentialCheck: false,
        userEnvReader: async () => undefined,
      });
      assertOrdinary(r, calls, await eventsOf(dir, r));
      assert.equal(r.continuableOff, "session_reuse_unavailable");
    });
  } finally {
    if (saved === undefined) delete process.env[TOKEN_ENV]; else process.env[TOKEN_ENV] = saved;
  }
});

// ── 角色合同冻结的位置（决定 0133 修正二·6）────────────────────────────────

test("自动 + correctable：角色合同加载出错不盖掉 correctable 资格拒绝码（冻结放在 correctable 检查之后）", async () => {
  await scenario({ systemPrompt: "config/roles/b154-does-not-exist.md" }, async ({ dispatch, calls, dir }) => {
    await assert.rejects(
      () => dispatch({ delivery: DELIVERY, backendFor: CAPABLE, correctable: true }),
      (e) => e.name === "CorrectableBackendUnsupportedError",
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(jsonlFiles(dir), []);
    assert.equal(existsSync(join(dir, ".lineage-reuse")), false);
  });
  // correctable 资格满足时，坏角色文件仍是硬失败（runner 同路径也会失败），零转录零 fork。
  await scenario({ systemPrompt: "config/roles/b154-does-not-exist.md" }, async ({ dispatch, calls, dir }) => {
    await assert.rejects(
      () => dispatch({ delivery: DELIVERY, backendFor: () => ({ supportsSessionReuse: true, supportsInFlightCorrection: true }), correctable: true }),
      /role contract file is missing or unreadable/,
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(jsonlFiles(dir), []);
  });
});

// ── CLI ───────────────────────────────────────────────────────────────────

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m i", { cwd: dir, stdio: "pipe" });
}

async function runCli(args, config) {
  const { runCommand } = await import("../../src/commands/run.js");
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = () => {};
  try {
    await runCommand(args, config);
    return { threw: null, logs };
  } catch (e) {
    return { threw: e.message, logs };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function cliScenario(spec, serviceResult, fn) {
  const dir = mkdtempSync(join(tmpdir(), "wao-b154-cli-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    makeGitRepo(repo);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { seat: { backend: "claude-code", cwd: repo } } }), "utf8");
    const specPath = join(dir, "delivery.json");
    writeFileSync(specPath, JSON.stringify({ allowedPaths: ["src"], verificationCommands: ["node --test"], ...spec }), "utf8");
    const captured = [];
    const config = {
      registry: registryPath,
      runDir: join(dir, "runs"),
      waitTimeout: 1000,
      pollInterval: 10,
      dispatchRunFn: async (args) => {
        captured.push(args);
        return { accepted: true, runId: "run_b154_cli_fake", agentId: args.agentId, transcriptPath: join(dir, "t.jsonl"), ...serviceResult };
      },
    };
    const bg = ["seat", "--background", "--isolate", "--cwd", repo, "--delivery-spec-file", specPath, "--prompt", "do it"];
    return await fn({ config, captured, bg, dir, repo, registryPath, specPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI 后台·自动：规格缺省 continuable → 不给服务传 continuable（交给自动判定），传能力解析器；输出回显 continuable / continuableOff", async () => {
  await cliScenario({}, { continuable: false, continuableOff: "backend_unsupported" }, async ({ config, captured, bg }) => {
    const { threw, logs } = await runCli(bg, config);
    assert.equal(threw, null);
    assert.equal(captured.length, 1);
    assert.equal("continuable" in captured[0], false, "缺省 = 自动：键不传");
    assert.equal(typeof captured[0].backendFor, "function", "自动判定靠能力解析器，恒透传");
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.continuable, false);
    assert.equal(out.continuableOff, "backend_unsupported");
  });
  await cliScenario({}, { continuable: true }, async ({ config, bg }) => {
    const { logs } = await runCli(bg, config);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.continuable, true);
    assert.equal("continuableOff" in out, false);
  });
});

test("CLI 后台·显式：规格 true / false 原样穿给服务", async () => {
  await cliScenario({ continuable: true }, {}, async ({ config, captured, bg }) => {
    await runCli(bg, config);
    assert.equal(captured[0].continuable, true);
  });
  await cliScenario({ continuable: false }, { continuable: false }, async ({ config, captured, bg }) => {
    const { threw, logs } = await runCli(bg, config);
    assert.equal(threw, null);
    assert.equal(captured[0].continuable, false, "显式关闭穿给服务，不会被当成缺省");
    assert.equal(JSON.parse(logs.join("\n")).continuable, false);
  });
});

test("CLI 后台·显式关闭：规格里 continuable 出现但不是布尔值（\"false\"、null、0、\"true\"……）→ 按显式关闭，派发成功，不整份被拒、也不变成自动开", async () => {
  for (const bad of ["false", "true", 0, 1, null, [], {}]) {
    await cliScenario({ continuable: bad }, { continuable: false }, async ({ config, captured, bg }) => {
      const { threw, logs } = await runCli(bg, config);
      assert.equal(threw, null, `非布尔值 ${JSON.stringify(bad)} 不能让整份规格被拒`);
      assert.equal(captured.length, 1, "派发成功");
      assert.equal(captured[0].continuable, false, `非布尔值 ${JSON.stringify(bad)} 按显式关闭穿给服务`);
      const out = JSON.parse(logs.join("\n"));
      assert.equal(out.continuable, false);
      assert.equal("continuableOff" in out, false, "显式关闭不带原因");
    });
  }
});

test("CLI 前台·显式关闭：规格里 continuable 是非布尔值 → 同样按显式关闭（前台只回显 continuable:false，不带 continuableOff）", async () => {
  const r = await foregroundJson({ continuable: "false" });
  assert.equal(r.threw, null);
  assert.equal(r.out.continuable, false);
  assert.equal("continuableOff" in r.out, false);
});

test("`runs continue --delivery-spec-file` 共用的解析器：非布尔 continuable 不让规格被拒（该字段对续修入口无意义，被忽略）", async () => {
  const { loadDeliverySpec } = await import("../../src/commands/run.js");
  const dir = mkdtempSync(join(tmpdir(), "wao-b154-spec-"));
  try {
    for (const bad of ["false", null, 0, "true"]) {
      const specPath = join(dir, "spec.json");
      writeFileSync(specPath, JSON.stringify({ allowedPaths: ["src"], verificationCommands: ["node --test"], continuable: bad }), "utf8");
      const spec = await loadDeliverySpec({ deliverySpecFile: specPath });
      assert.deepEqual(spec.allowedPaths, ["src"], `非布尔值 ${JSON.stringify(bad)} 照常解析`);
      assert.equal(spec.continuable, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 后台：服务回显缺失（旧形状）→ continuable 读成 false，不虚报谱系", async () => {
  await cliScenario({}, {}, async ({ config, bg }) => {
    const { logs } = await runCli(bg, config);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.continuable, false);
    assert.equal("continuableOff" in out, false);
  });
});

test("CLI 前台·显式 true 仍具名拒绝（不带 --background）", async () => {
  await cliScenario({ continuable: true }, {}, async ({ config, captured, repo, specPath }) => {
    const { threw } = await runCli(["seat", "--isolate", "--cwd", repo, "--delivery-spec-file", specPath, "--prompt", "do it"], config);
    assert.match(threw, /continuable requires --background/);
    assert.equal(captured.length, 0);
  });
});

// 前台带交付的 JSON 回显：假后端立刻完成；交付验证声明不可用，不跑任何命令。
async function foregroundJson(spec) {
  const dir = mkdtempSync(join(tmpdir(), "wao-b154-fg-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    makeGitRepo(repo);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: { seat: { backend: "claude-code", cwd: repo } } }), "utf8");
    const specPath = join(dir, "delivery.json");
    writeFileSync(specPath, JSON.stringify({ allowedPaths: ["src"], verificationUnavailableReason: "test fixture", ...spec }), "utf8");
    const fakeBackend = {
      supportsRoleContract: true,
      sessionOutlivesProcess: false,
      async spawn() {
        return {
          backend: "claude-code", backendSessionId: "s1", messageId: "m1", admittedSeq: 5,
          async *events() { yield { kind: "done", reason: "completed" }; },
          abort: async () => {},
        };
      },
      defaultBinary() { return "node"; },
      credentialEnvNames: () => [],
    };
    const config = {
      registry: registryPath, runDir: join(dir, "runs"), waitTimeout: 5000, pollInterval: 10,
      backendFor: () => fakeBackend, userEnvReader: async () => ({}),
    };
    const { threw, logs } = await runCli(
      ["seat", "--isolate", "--cwd", repo, "--delivery-spec-file", specPath, "--prompt", "do it", "--format", "json"],
      config,
    );
    return { threw, out: threw ? null : JSON.parse(logs.join("\n")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("CLI 前台·自动：规格缺省 → JSON 回显 continuable:false + continuableOff:foreground；显式 false → 只回显 continuable:false", async () => {
  const auto = await foregroundJson({});
  assert.equal(auto.threw, null);
  assert.equal(auto.out.continuable, false);
  assert.equal(auto.out.continuableOff, "foreground");
  const explicitOff = await foregroundJson({ continuable: false });
  assert.equal(explicitOff.threw, null);
  assert.equal(explicitOff.out.continuable, false);
  assert.equal("continuableOff" in explicitOff.out, false);
});
