// test/run-lifecycle/nestedDispatchGuard.test.js
//
// 0047 L1 防向下派发门钉：动机=当日 kimi 会审席在任务内经 wao CLI 自组内层
// 会审（worker 向下派发真实发生）。三层断言：
//   ① 判定纯函数（env 标记 / worktree cwd / 豁免 / 放行）；
//   ② RunManager.start 咽喉门（worker 上下文=零副作用拒绝）；
//   ③ 注入面（processBackend/deepSeekAcp 子进程 env 带 WAO_IN_WORKER=1）+
//      角色合同 WQ-03 条款在场。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nestedDispatchContext, assertNotNestedDispatchContext, NESTED_DISPATCH_ENV_MARKER,
} from "../../src/application/nestedDispatchGuard.js";

test("0047 ①: 判定纯函数——env 标记/worktree cwd/豁免/放行", () => {
  assert.equal(nestedDispatchContext({}, "/D:/proj/repo"), null, "Lead 主检出=放行");
  assert.deepEqual(nestedDispatchContext({ [NESTED_DISPATCH_ENV_MARKER]: "1" }, "/anywhere"), {
    reason: "env-marker",
    detail: "WAO_IN_WORKER=1 in process env (WAO-spawned worker lineage)",
  });
  const hit = nestedDispatchContext({}, "D:\\proj\\.wao-worktrees\\run_x\\src");
  assert.equal(hit?.reason, "worktree-cwd", "worktree cwd 命中（Windows 分隔符）");
  assert.equal(nestedDispatchContext({}, "/d/proj/.wao-worktrees/run_x")?.reason, "worktree-cwd", "worktree cwd 命中（POSIX 分隔符）");
  assert.equal(nestedDispatchContext({ [NESTED_DISPATCH_ENV_MARKER]: "1", WAO_ALLOW_NESTED_DISPATCH: "1" }, "/any"), null, "豁免优先");
});

test("0047 ②: assertNotNestedDispatchContext——worker 上下文抛固定文案，Lead 放行", () => {
  assert.throws(
    () => assertNotNestedDispatchContext({ [NESTED_DISPATCH_ENV_MARKER]: "1" }, "/any"),
    /nested dispatch refused \(decision 0047\)/,
  );
  assert.throws(
    () => assertNotNestedDispatchContext({ [NESTED_DISPATCH_ENV_MARKER]: "1" }, "/any"),
    /orchestration belongs to the Lead/,
  );
  assert.doesNotThrow(() => assertNotNestedDispatchContext({}, "/d/lead/repo"));
});

test("0047 ② b: RunManager.start 咽喉门——env 标记进程内即拒（真实 cwd，零副作用）", async () => {
  const prev = process.env[NESTED_DISPATCH_ENV_MARKER];
  try {
    process.env[NESTED_DISPATCH_ENV_MARKER] = "1";
    const mod = await import("../../src/runManager.js");
    const RunManagerCtor = mod.RunManager ?? mod.default;
    assert.ok(typeof RunManagerCtor === "function", `RunManager ctor shape: ${Object.keys(mod).slice(0, 6)}`);
    const mgr = new RunManagerCtor({});
    await assert.rejects(
      () => mgr.start("whatever_lane", { prompt: "x" }),
      (e) => {
        assert.match(e.message, /nested dispatch refused \(decision 0047\)/);
        assert.match(e.message, /env-marker/);
        return true;
      },
      "start() 在任何转录/fork 之前拒绝",
    );
  } finally {
    if (prev === undefined) delete process.env[NESTED_DISPATCH_ENV_MARKER];
    else process.env[NESTED_DISPATCH_ENV_MARKER] = prev;
  }
});

test("0047 ③ a: 注入点源钉——processBackend/deepSeekAcp 的 waoEnv 面含 WAO_IN_WORKER=1", async () => {
  // 源扫描钉（staticRunsGuard 同族）：两个 backend 的 buildChildEnv 调用必须带
  // WAO_IN_WORKER:"1"（构造 ProcessBackend 需要 parserClass 等全套夹具，源钉覆盖
  // 同一事实且零夹具成本；合并序由 buildChildEnv 纯函数断言佐证——waoEnv 覆盖
  // inherited，标记必然到达子进程）。
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const ROOT = resolve(import.meta.dirname, "../..");
  for (const rel of ["src/backends/processBackend.js", "src/backends/deepSeekAcp.js"]) {
    const src = readFileSync(join2(ROOT, rel), "utf8");
    assert.match(src, /WAO_IN_WORKER: "1"/, `${rel} 必须注入 worker 血统标记`);
  }
  const { buildChildEnv } = await import("../../src/backends/processBackend.js");
  const merged = buildChildEnv([], {}, { WAO_IN_WORKER: "1", WAO_TARGET_CWD: "/x" }, {});
  assert.equal(merged.WAO_IN_WORKER, "1");
  assert.equal(merged.WAO_TARGET_CWD, "/x");
});

// join 别名（避免与文件顶部已 import 的 join 语义混淆——顶部未 import，此处定义）
import { join as join2 } from "node:path";

test("0047 ③ b: 角色合同 WQ-03 条款在场（合成面统一附加）", async () => {
  const { WORKER_EVIDENCE_DISCIPLINE, composeRoleContractWithIdentity } = await import("../../src/application/roleContract.js");
  assert.match(WORKER_EVIDENCE_DISCIPLINE, /WQ-03 NO-NESTED-DISPATCH/);
  assert.match(WORKER_EVIDENCE_DISCIPLINE, /no wao CLI, no WAO MCP tools/);
  const composed = composeRoleContractWithIdentity({
    roleContract: "# Role: coder\n内容", agentId: "glm-pro", identity: { laneId: "glm-pro", roleId: "coder" },
  });
  assert.match(composed, /WQ-03 NO-NESTED-DISPATCH/, "显式派发的合成合同携带禁令");
  const composedLegacy = composeRoleContractWithIdentity({ roleContract: "# r\nx", agentId: "glm-pro" });
  assert.match(composedLegacy, /WQ-03 NO-NESTED-DISPATCH/, "legacy 头路径同样携带");
});

test("0047 ① c: worktree cwd 判定（临时目录真实构造）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-ng-"));
  try {
    const wt = join(dir, ".wao-worktrees", "run_probe", "src").replace(/\\/g, "/");
    assert.equal(nestedDispatchContext({}, wt)?.reason, "worktree-cwd");
    assert.equal(nestedDispatchContext({}, dir)?.reason ?? null, null, "普通临时目录不误伤");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
