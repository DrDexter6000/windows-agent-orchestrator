// test/isolation-infra/stateChangeReasons.test.js
//
// Round 4 Bundle A（2026-08-16）：`run.state_change` reason 冻结闭集守卫。
//
// 背景：state_change 的 reason 字符串是机器协议——诊断（diagnosis.js）、恢复
// 分类（transcript.js classifyRecoveryCandidate）、失败来源投影
// （runObservationProjection.js）逐字消费它。拼写漂移会让诊断**静默**失真。
// SSOT = src/transcript.js STATE_CHANGE_REASONS（Object.freeze 数组）；写入侧
// 生产者一律引用 STATE_CHANGE_REASON.<member>，读侧不校验（历史/测试值容忍）。
//
// 守卫分层（TD-120 模式，冻结契约钉成员清单为 Owner 2026-08-16 明示批准的
// 豁免款；其余断言为关系型——从代码 SSOT 派生，不硬编码漂移字面量）：
//   1. deepEqual 冻结集（成员 + 顺序逐字钉死；成员变更 = 契约变更，须过评审）。
//   2. STATE_CHANGE_REASON 引用视图与数组严格双射（无多键/无缺键/值恒等）。
//   3. BACKEND_RECOVERY_REASONS ⊆ STATE_CHANGE_REASONS（恢复分类消费面）。
//   4. FAILED_REASON_TO_SOURCE 全部键 ⊆ STATE_CHANGE_REASONS（投影消费面）。
//   5. PROCESS_MISSING_RECOVERY_REASON ∈ STATE_CHANGE_REASONS（M12-19 结算
//      reason，被 runDeliveryRepackage 写入终态转移）。
//   6. diagnosis / smoke 消费成员 ∈ SSOT + 源码绑定（必须经 STATE_CHANGE_REASON
//      引用，不得回退为裸字面量比较）。
//   7. 反回归：生产者文件不得再以裸字符串字面量作为转移 reason（防止散落
//      字面量绕过 SSOT 回潮）。
//
// 失败含义：有人改了 state_change reason 词汇表或绕开了 SSOT 引用——先对齐
// 契约（本文件 + transcript.js + 两张清点表），不是单改测试让红变绿。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  STATE_CHANGE_REASONS,
  STATE_CHANGE_REASON,
  BACKEND_RECOVERY_REASONS,
  PROCESS_MISSING_RECOVERY_REASON,
} from "../../src/transcript.js";
import { FAILED_REASON_TO_SOURCE } from "../../src/application/runObservationProjection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

/** 读取仓库内文件（相对 ROOT 的路径），返回字符串。 */
function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// ── 守卫 1：冻结闭集逐字钉死（TD-120 豁免款：Owner 2026-08-16 批准的冻结契约）──
// 顺序即 transcript.js 中的声明序（非终态生命周期 → completed → timed_out →
// aborted 家族 → failed 家族）。清单与交付报告"入集成员表"一一对应。
const FROZEN_MEMBERS = [
  // 非终态生命周期
  "created",
  "background_spawned",
  "spawned",
  "replay_respawned",
  "first_event",
  "first_message",
  // 终态 completed
  "done",
  // 终态 timed_out
  "timeout",
  // 终态 aborted（abort 家族）
  "stop_requested",
  "external_signal",
  "user",
  "SIGINT",
  "daemon_stop",
  "ipc_stop",
  // 终态 failed
  "spawn_error",
  "startup_error",
  "delivery_parse_error",
  "reuse_worktree_parse_error",
  "certification_gate",
  "fire_forget_guard",
  "workdir_escape",
  "budget_exceeded",
  "scorecard_failed",
  "delivery_failed",
  "backend_error",
  "backend_stream_ended",
  "backend_unknown_reason",
  "process_missing",
];

test("stateChangeReasons: STATE_CHANGE_REASONS 为冻结闭集且成员/顺序逐字钉死", () => {
  assert.ok(Object.isFrozen(STATE_CHANGE_REASONS), "STATE_CHANGE_REASONS 必须 Object.freeze");
  assert.deepEqual(
    STATE_CHANGE_REASONS,
    FROZEN_MEMBERS,
    "冻结闭集成员漂移——词汇表变更 = 机器协议契约变更，须同步 transcript.js SSOT、本清单与两张清点表后过评审",
  );
  // 无重复成员（deepEqual 隐含，但显式断言让失败信息更可读）。
  assert.equal(new Set(STATE_CHANGE_REASONS).size, STATE_CHANGE_REASONS.length, "成员不得重复");
});

test("stateChangeReasons: STATE_CHANGE_REASON 引用视图与冻结数组严格双射", () => {
  assert.ok(Object.isFrozen(STATE_CHANGE_REASON), "引用视图必须冻结");
  const keys = Object.keys(STATE_CHANGE_REASON);
  assert.deepEqual([...keys].sort(), [...STATE_CHANGE_REASONS].sort(), "键集 = 成员集（无多键/无缺键）");
  for (const member of STATE_CHANGE_REASONS) {
    assert.equal(STATE_CHANGE_REASON[member], member, `成员 ${member} 的引用值必须恒等`);
  }
});

// ── 守卫 3/4/5：关系型断言（消费面闭集 ⊆ 写入侧 SSOT）──

test("stateChangeReasons: BACKEND_RECOVERY_REASONS ⊆ STATE_CHANGE_REASONS（恢复分类消费面）", () => {
  assert.ok(BACKEND_RECOVERY_REASONS.size > 0, "恢复原因集非空");
  for (const reason of BACKEND_RECOVERY_REASONS) {
    assert.ok(
      STATE_CHANGE_REASONS.includes(reason),
      `backend 恢复原因 ${reason} 不在冻结闭集内——classifyRecoveryCandidate 将静默失配`,
    );
  }
});

test("stateChangeReasons: FAILED_REASON_TO_SOURCE 全部键 ⊆ STATE_CHANGE_REASONS（失败来源投影消费面）", () => {
  const keys = Object.keys(FAILED_REASON_TO_SOURCE);
  assert.ok(keys.length > 0, "失败原因映射非空");
  for (const key of keys) {
    assert.ok(
      STATE_CHANGE_REASONS.includes(key),
      `FAILED_REASON_TO_SOURCE 键 ${key} 不在冻结闭集内——run_wait/run_await_result 的 source 回退投影将静默退化为 unknown`,
    );
  }
});

test("stateChangeReasons: PROCESS_MISSING_RECOVERY_REASON ∈ STATE_CHANGE_REASONS（M12-19 孤儿结算）", () => {
  assert.ok(
    STATE_CHANGE_REASONS.includes(PROCESS_MISSING_RECOVERY_REASON),
    "process_missing 结算 reason 必须是闭集成员——runDeliveryRepackage 写入的终态转移 reason",
  );
});

// ── 守卫 6：diagnosis / smoke 消费成员 ∈ SSOT + 源码绑定（不得回退裸字面量）──
// 说明：这里的两个字面量是守卫自身的钉子（TD-120 豁免款：把"该消费面存在"
// 钉在测试里），与生产代码经 STATE_CHANGE_REASON 的引用互补。

test("stateChangeReasons: diagnosis 消费 budget_exceeded ∈ SSOT 且源码绑定 SSOT 引用", () => {
  assert.ok(
    STATE_CHANGE_REASONS.includes("budget_exceeded"),
    "diagnosis 的 budget 分类消费 budget_exceeded——若从闭集移除该成员，诊断将静默漏判预算超限",
  );
  const src = read("src/diagnosis.js");
  assert.ok(
    src.includes("STATE_CHANGE_REASON.budget_exceeded"),
    "diagnosis.js 必须经 STATE_CHANGE_REASON.budget_exceeded 比较（SSOT 引用）",
  );
  assert.ok(
    !src.includes('=== "budget_exceeded"'),
    "diagnosis.js 不得回退为裸字面量 === \"budget_exceeded\" 比较",
  );
});

test("stateChangeReasons: smoke 消费 scorecard_failed ∈ SSOT 且源码绑定 SSOT 引用", () => {
  assert.ok(
    STATE_CHANGE_REASONS.includes("scorecard_failed"),
    "smoke 场景 2 断言 scorecard_failed 终态——若从闭集移除该成员，smoke 判据将静默失配",
  );
  const src = read("src/smoke.js");
  assert.ok(
    src.includes("STATE_CHANGE_REASON.scorecard_failed"),
    "smoke.js 必须经 STATE_CHANGE_REASON.scorecard_failed 比较（SSOT 引用）",
  );
  assert.ok(
    !src.includes('=== "scorecard_failed"'),
    "smoke.js 不得回退为裸字面量 === \"scorecard_failed\" 比较",
  );
});

// ── 守卫 7：反回归——生产者不得以裸字符串字面量作为转移 reason ──
// 生产者文件封闭集（= 交付报告"包装缝清单"的文件面）。
const PRODUCER_FILES = [
  "src/runManager.js",
  "src/backgroundRunner.js",
  "src/application/runDispatch.js",
  "src/application/runContinue.js",
  "src/application/runStop.js",
  "src/application/runDeliveryRepackage.js",
  "src/daemon.js",
];

// 形态 A：`<state>", "<非 state 小写下划线串>"` —— reason 位于 to 状态字面量之后
// （transitionState / Run._transition 三参形态与 RunManager._transition 四参形态
// 统一命中；紧随状态字面量的另一个状态字面量（from,to 相邻）被负向前瞻排除）。
const REASON_AFTER_STATE_LITERAL =
  /,\s*"(?:pending|submitted|running|completed|failed|aborted|timed_out)"\s*,\s*"(?!pending|submitted|running|completed|failed|aborted|timed_out)[a-z_]+"/;

// 形态 B：reason 为首参的包装缝（markRunningOnce / _abortInternal / abortAll /
// gracefulShutdown）与 abort 的第二参（manager.abort(runId, reason)）。
const REASON_FIRST_ARG_LITERAL = /\b(?:markRunningOnce|_abortInternal|abortAll|gracefulShutdown)\(\s*["'`][a-z_]+["'`]/;
const ABORT_SECOND_ARG_LITERAL = /\.abort\(\s*[^,()]*,\s*["'`][a-z_]+["'`]/;

// 形态 C：reason 默认参回退为字面量（abort/gracefulShutdown 的默认值）。
const REASON_DEFAULT_LITERAL = /reason\s*=\s*["'`][a-zA-Z_]+["'`]/;

test("stateChangeReasons: 生产者文件不得以裸字符串字面量作为转移 reason（散落字面量反回归）", () => {
  for (const rel of PRODUCER_FILES) {
    const src = read(rel);
    const viaState = src.match(new RegExp(REASON_AFTER_STATE_LITERAL.source, "g")) ?? [];
    for (const hit of viaState) {
      assert.ok(
        false,
        `${rel} 出现裸字面量转移 reason \`${hit}\`——必须改为 STATE_CHANGE_REASON.<member> 引用`,
      );
    }
    assert.ok(
      !REASON_FIRST_ARG_LITERAL.test(src),
      `${rel} 的 reason 包装缝（markRunningOnce/_abortInternal/abortAll/gracefulShutdown）出现裸字面量`,
    );
    assert.ok(
      !ABORT_SECOND_ARG_LITERAL.test(src),
      `${rel} 的 .abort(id, reason) 第二参出现裸字面量 reason`,
    );
    assert.ok(
      !REASON_DEFAULT_LITERAL.test(src),
      `${rel} 的 reason 默认参回退为字面量——默认值必须引用 STATE_CHANGE_REASON`,
    );
  }
});
