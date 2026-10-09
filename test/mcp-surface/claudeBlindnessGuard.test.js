// test/mcp-surface/claudeBlindnessGuard.test.js
//
// TD-241 失明守卫（kimi+opus 裁定会审 consult_20261009081329035swaqvc 建议，
// 2026-10-09 Owner 批准；探针层2证据=.dev/probe 双通道探针）：
//   ① claude-code 模型在 isError 面只见 text——任何带 structuredContent 的
//      isError 回执，其 text 必须是同源 SSOT 生成的自含恢复要点（当前闭集
//      仅 run_activity cursor_rejected 一处，用 RUN_ACTIVITY_CURSOR_REJECTED_TEXT）。
//      新增 isError+structuredContent 面必须显式扩闭集并给 text 同源要点。
//   ② claude-code 模型在成功面只见 structuredContent——pending 回执的指引
//      必须进 structuredContent（闭集 DELIVERY_PENDING_GUIDANCE），不得只放
//      text。当前 pending 发射闭集仅 repackage/reverify 两处。
// 扫源形状（gitChildEnvGuard 同款纪律）：绕过即红。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_SRC = readFileSync(join(REPO_ROOT, "src", "mcp", "server.js"), "utf8");

// isError: true 与 structuredContent 同处一个 return 对象字面量的共现对——
// 每一处都必须引用 C2 同源文本常量。判同对象的方法：以 structuredContent 为
// 锚回看 500 字符窗口内的最近 isError: true，且两者之间不得再隔 "return"
// 关键字（隔了=属于后面另一条语句——前向贪吃两轮实测误报过的形状）。
test("TD-241 守卫①: isError+structuredContent 面的 text 必须自含恢复要点（闭集）", () => {
  const offenders = [];
  let from = 0;
  while (true) {
    const idx = SERVER_SRC.indexOf("structuredContent:", from);
    if (idx < 0) break;
    from = idx + 1;
    const w = SERVER_SRC.slice(Math.max(0, idx - 500), idx);
    const iErr = w.lastIndexOf("isError: true");
    if (iErr < 0) continue;
    if (w.indexOf("return", iErr) >= 0) continue; // 中间隔了新语句 → 非同一对象
    const region = SERVER_SRC.slice(Math.max(0, idx - 500) + iErr, idx + 200);
    if (!region.includes("RUN_ACTIVITY_CURSOR_REJECTED_TEXT")) {
      offenders.push(region.slice(0, 120).replace(/\s+/g, " "));
    }
  }
  assert.ok(offenders.length === 0,
    `isError 面带 structuredContent 时 text 必须用同源 SSOT 恢复要点常量（新增面须扩闭集+补钉）：\n${offenders.join("\n")}`);
  // 闭集非空自证：run_activity cursor_rejected 现场必须在册（防止守卫空转）。
  assert.match(SERVER_SRC, /RUN_ACTIVITY_CURSOR_REJECTED_TEXT[\s\S]{0,40}?structuredContent: RUN_ACTIVITY_RECOVERY\.parse/);
});

test("TD-241 守卫②: pending 回执指引必须进 structuredContent（闭集发射点）", () => {
  // 只认 OUTPUT.parse({ status: "pending" 发射点（注释里的 status:"pending"
  // 文案不计——首轮实现实测误报过）。
  const sites = [...SERVER_SRC.matchAll(/OUTPUT\.parse\(\{\s*\n?\s*status:\s*"pending"/g)];
  assert.ok(sites.length === 2, `应恰好 repackage/reverify 两个 pending 发射点，实测 ${sites.length}`);
  const offenders = [];
  for (const s of sites) {
    const region = SERVER_SRC.slice(s.index, s.index + 400);
    if (!region.includes("guidance: [...DELIVERY_PENDING_GUIDANCE]")) {
      offenders.push(region.slice(0, 120).replace(/\s+/g, " "));
    }
  }
  assert.deepEqual(offenders, [],
    `pending 发射点必须携带 guidance: [...DELIVERY_PENDING_GUIDANCE]（claude 成功面只读 structuredContent）：\n${offenders.join("\n")}`);
  // SSOT 常量本体形状钉：闭集两个成员、语义不得静默变更。
  assert.match(SERVER_SRC, /DELIVERY_PENDING_GUIDANCE = Object\.freeze\(\[\s*"poll_run_delivery_with_waitMs_for_settled_outcome",\s*"do_not_reenter_reentry_reexecutes_verification",\s*\]\)/);
});
