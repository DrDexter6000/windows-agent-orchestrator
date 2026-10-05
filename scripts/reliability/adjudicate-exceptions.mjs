// 0045 清账批 CB-2：例外裁定机械恢复（入库版，取代 scripts/reliability-tmp/ 两份
// 一次性脚本——原脚本 gitignored，R2 会审裁定"入库或消除"）。
//
// 纪律（与被取代脚本逐字同源）：全量 reliability 重跑按 runbook 机械规则
// （"拒绝越界写 = 红，需人工分辨"）把下列席位覆盖为 draft-only。人工分辨已完成
// 且结论在案（decisions accepted）；本脚本只恢复裁决状态字段
// （status/recommendedUse），实跑事实字段（capabilities、身份、scope、case 明细）
// 一律保留不动，不发明新字段。非预期形状即中止（不写）。
//
// 覆盖的在册裁定（Owner 已批，本脚本不新增任何裁定）：
//   - 0036 coder_mm kimi-web 例外（含 2026-10-04 k3-256k 延展）
//   - 0037 coder_hq / coder_low zcode×GLM 例外
//   - 0041 researcher zcode/GLM-5.3-Flash adversarialEscape 例外（scope=delta）
//
// 退役条款（决定 0045 §4.3）：迁移批把例外按"车道×用途边界"重签为 git 跟踪
// 记录后，本脚本整体退役（届时全量 reliability 不再机械降级例外席）。
import { readFileSync, writeFileSync } from "node:fs";

const TARGETS = {
  coder_mm: "0036（含 2026-10-04 k3-256k 延展）",
  coder_hq: "0037",
  coder_low: "0037",
  researcher: "0041（scope=delta）",
};
const EXPECTED_PRE_STATUS = "draft-only";

const p = process.argv[2] ?? "./runs/reliability-summary.json";
const s = JSON.parse(readFileSync(p, "utf8"));
for (const [id, ruling] of Object.entries(TARGETS)) {
  const w = s.workers[id];
  if (!w) throw new Error(`worker ${id} 缺失，中止（不写）`);
  if (w.status === "certified" || w.status === "rejected" || w.status === "conditional") {
    throw new Error(`worker ${id} 当前 status=${w.status}，非 ${EXPECTED_PRE_STATUS} 形状，中止（不写）——若已裁定请勿重跑`);
  }
  w.status = "conditional";
  w.recommendedUse = "supervised-dispatch";
  // 裁定回链不写成台账字段（"不发明新字段"纪律）——回链即本文件 TARGETS 表。
}
const counts = { certified: 0, conditional: 0, "draft-only": 0, blocked: 0, rejected: 0 };
for (const w of Object.values(s.workers)) {
  if (w.status in counts) counts[w.status] += 1;
}
s.counts = counts;
s.allCertified = counts.rejected === 0 && counts["draft-only"] === 0 && counts.blocked === 0;
writeFileSync(p, JSON.stringify(s, null, 2) + "\n", "utf8");
console.log("counts:", JSON.stringify(counts));
