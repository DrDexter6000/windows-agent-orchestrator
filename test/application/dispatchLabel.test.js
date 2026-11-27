// test/application/dispatchLabel.test.js
//
// 第 156 批（TD-384）：派发/会审结果带 label（`[<车道>] <任务名>`）的钉：
//   - 形状：车道=本次实际派发键；任务名取法与 Owner 看板同源（deriveOwnerTitle，
//     不另写一套）——同一输入两边逐字相同；
//   - 整个 label ≤80 字符，超出截断加省略号；取不到标题退回 `[<车道>] <runId>`；
//   - 会审的席位列表写法 `[席位A+席位B] <任务书标题>`；
//   - 标题里的控制字符与凭据形状被清掉（同一安全链）；
//   - nextStep 末尾的宿主无关短提示（（后台任务可命名 <label>））：放不下不加。
process.env.WAO_ALLOW_NESTED_DISPATCH = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDispatchLabel,
  buildConsultLabel,
  appendLabelHint,
  isUsableLabel,
  DISPATCH_LABEL_MAX_CHARS,
} from "../../src/application/dispatchLabel.js";
import { deriveOwnerTitle } from "../../src/application/ownerReadModel.js";
import { createSecretRedactor } from "../../src/secretRedaction.js";

// ── 形状与同源 ───────────────────────────────────────────────────────────────

test("label 形状：[<车道>] <任务名>；标题取法与 Owner 看板同源（同一输入逐字相同）", () => {
  const cases = [
    { prompt: "# 修登录超时\n\n正文……", lane: "fixture-lane" },
    { prompt: "第一行就是标题\n\n正文", lane: "a" },
    { prompt: "```\n围栏里的第一行不算\n```\n# 围栏后的标题", lane: "b" },
    { prompt: "---\n## 分隔线后的小节标题\n正文", lane: "c" },
    { prompt: "# 用 ghp_abcdefghijklmnopqrstuvwxyz 部署", lane: "d" },
    { prompt: "# curl -u admin:hunter22 https://x", lane: "e" },
    { prompt: "# 标题带控制\u0007字符", lane: "f" },
    { prompt: "   \n\n  \n# 跳过空行后的标题", lane: "g" },
  ];
  for (const { prompt, lane } of cases) {
    const label = buildDispatchLabel({ lane, prompt, fallbackId: "run_x" });
    const title = deriveOwnerTitle(prompt);
    assert.ok(typeof label === "string" && label.length > 0, `有 label：${JSON.stringify(prompt).slice(0, 30)}`);
    assert.ok(label.startsWith(`[${lane}] `), "车道段在前");
    // 同源钉：label 去掉车道段后与 Owner 看板的标题逐字相同（同一实现）。
    assert.equal(label.slice(`[${lane}] `.length), title, "任务名与 deriveOwnerTitle 同一输入逐字相同");
  }
  // 具体形状各钉一眼（脱敏/清控制字符经同一安全链）。
  assert.equal(buildDispatchLabel({ lane: "d", prompt: "# 用 ghp_abcdefghijklmnopqrstuvwxyz 部署", fallbackId: "r" }),
    "[d] 用 [REDACTED] 部署", "凭据形状被清掉");
  assert.equal(buildDispatchLabel({ lane: "f", prompt: "# 标题带控制\u0007字符", fallbackId: "r" }),
    "[f] 标题带控制\uFFFD字符", "控制字符按看板同一链清洗（U+FFFD）");
  assert.equal(buildDispatchLabel({ lane: "a", prompt: "# 修登录超时\n\n正文……", fallbackId: "r" }),
    "[a] 修登录超时", "ATX 标题去 # 记号");
});

test("label 上限：整个 label ≤80 字符，超出截断加省略号", () => {
  const longTitle = "长".repeat(200);
  const label = buildDispatchLabel({ lane: "fixture-lane", prompt: longTitle, fallbackId: "r" });
  assert.ok(label.length <= DISPATCH_LABEL_MAX_CHARS, `≤${DISPATCH_LABEL_MAX_CHARS}（实测 ${label.length}）`);
  assert.ok(label.endsWith("…"), "截断以省略号收尾");
  assert.ok(label.startsWith("[fixture-lane] "), "车道段保留");
  assert.equal(DISPATCH_LABEL_MAX_CHARS, 80, "上限常量=80");
});

test("修正一：截断按完整字符切——emoji 恰好跨边界时不留落单代理项", () => {
  // 车道段 `[x] `=4 码元 + 标题前缀 74 个 c = 78；第 79/80 位是代理对（😀）。
  const prompt = "c".repeat(74) + "😀" + "d";
  const label = buildDispatchLabel({ lane: "x", prompt, fallbackId: "r" });
  assert.ok(label.length <= DISPATCH_LABEL_MAX_CHARS);
  assert.ok(label.endsWith("…"), "超长仍以省略号收尾");
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(label), "无落单高位代理");
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(label), "无落单低位代理");
  const lastKept = label.charCodeAt(label.length - 2);
  assert.ok(!(lastKept >= 0xd800 && lastKept <= 0xdbff), "省略号前的字符不是半个代理对");
});

test("修正一：label 走 Owner 看板同一条脱敏链——无令牌形状的环境秘密原值也遮住，且与看板逐字相同", () => {
  const env = { WAO_TEST_API_KEY: "plain-secret-15" };
  const redactString = createSecretRedactor(env).redactString;
  const prompt = `# 修 ${env.WAO_TEST_API_KEY} 的部署`;
  const label = buildDispatchLabel({ lane: "x", prompt, fallbackId: "r", redactString });
  const boardTitle = deriveOwnerTitle(prompt, redactString);
  assert.equal(label, `[x] ${boardTitle}`, "与看板对同一输入逐字相同");
  assert.ok(!label.includes(env.WAO_TEST_API_KEY), "秘密原值不出现");
  assert.ok(label.includes("[REDACTED:WAO_TEST_API_KEY]"), "精确脱敏标记（与看板同一链）");
  // 会审同一个 redactor（同一函数对象，不另造链）。
  const consult = buildConsultLabel({ seats: ["a", "b"], brief: prompt, fallbackId: "c", redactString });
  assert.equal(consult, `[a+b] ${boardTitle}`, "会审 label 同一条脱敏链");
});

test("修正一：出口纪律 isUsableLabel——非空且 ≤80 才可用（坏记录/越界值按缺省）", () => {
  assert.equal(isUsableLabel("[x] 任务"), true);
  assert.equal(isUsableLabel(""), false);
  assert.equal(isUsableLabel(null), false);
  assert.equal(isUsableLabel(123), false);
  assert.equal(isUsableLabel("a".repeat(DISPATCH_LABEL_MAX_CHARS)), true, "恰好上限可用");
  assert.equal(isUsableLabel("a".repeat(DISPATCH_LABEL_MAX_CHARS + 1)), false, "超上限不可用");
});

test("取不到标题：退回 `[<车道>] <runId>`；无车道键 → null", () => {
  assert.equal(buildDispatchLabel({ lane: "x", prompt: "", fallbackId: "run_20261127_aaaa" }),
    "[x] run_20261127_aaaa", "空 prompt 退回 runId");
  assert.equal(buildDispatchLabel({ lane: "x", prompt: "---\n***\n___", fallbackId: "run_b" }),
    "[x] run_b", "只有分隔线（无可取行）退回 runId");
  assert.equal(buildDispatchLabel({ lane: "x", prompt: "" , fallbackId: null }), null,
    "标题与 fallbackId 都没有 → null（键缺省）");
  assert.equal(buildDispatchLabel({ lane: "", prompt: "# t", fallbackId: "r" }), null, "无车道键 → null");
});

// ── 会审 label ───────────────────────────────────────────────────────────────

test("会审 label：席位列表 `席位A+席位B`；标题同源；空席位 → null", () => {
  const label = buildConsultLabel({ seats: ["seat-sol", "seat-dsf"], brief: "# 第 156 批方案会审\n\nQ1……", fallbackId: "consult_x" });
  assert.equal(label, "[seat-sol+seat-dsf] 第 156 批方案会审");
  const fallback = buildConsultLabel({ seats: ["seat-sol"], brief: "", fallbackId: "consult_20261127_aaaa" });
  assert.equal(fallback, "[seat-sol] consult_20261127_aaaa", "无标题退回 consultId");
  assert.equal(buildConsultLabel({ seats: [], brief: "# t", fallbackId: "c" }), null, "空席位 → null");
  const long = buildConsultLabel({ seats: ["s1", "s2", "s3", "s4", "s5"], brief: "长".repeat(300), fallbackId: "c" });
  assert.ok(long.length <= DISPATCH_LABEL_MAX_CHARS && long.endsWith("…"), "会审 label 同一上限");
});

// ── nextStep 末尾的命名短提示 ─────────────────────────────────────────────────

test("appendLabelHint：末尾加宿主无关短提示；放不下只丢提示；无 label 原样", () => {
  const base = "Background run accepted. … call run_await_result repeatedly.";
  const withHint = appendLabelHint(base, "[x] 修登录超时");
  assert.equal(withHint, `${base} （后台任务可命名 [x] 修登录超时）`, "短提示形制");
  assert.ok(!/codex|claude|cursor|zcode/i.test(withHint), "不写宿主名");
  // 放不下（超上限）→ 只丢提示，原句不动。
  assert.equal(appendLabelHint(base, "[x] 修登录超时", base.length + 5), base, "超限只丢提示");
  assert.equal(appendLabelHint(base, null), base, "无 label 原样");
  assert.equal(appendLabelHint(base, ""), base, "空 label 原样");
});
