// 一次性重键脚本（0045 W4d）：agents.json 私有注册表 席位键 → 车道键（laneId）。
// 数据源=config/lanes.json 的 id↔wiringAgent 映射（重键前快照，脚本内联冻结）。
// 动作：agents 键改 laneId；条目去 systemPrompt（角色来自派发解析：别名→aliases.role，
// 显式→role 参数；researcher 的复用策略已在 config/roles.json 归角色）；certification.matrix
// 行 agentId 同步换 laneId（label=caseId 键保持逐字节不动——历史 case 连续性）。
// 幂等：已重键（存在 glm-flash 键）=无操作。备份在 .bak-（gitignore 已覆盖）。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";

const PATH = "config/agents.json";
const SEAT_TO_LANE = {
  researcher: "glm-flash", coder_low: "glm-flash",
  coder_hq: "glm-pro",
  coder_mm: "kimi-k3",
  tester: "gpt-sol-56",
  auditor: "gpt-astra",
  coder_temp: "gpt-sol-61",
  coder_low_dsh: "ds-acp",
  auditor_claude: "claude-opus",
};

const doc = JSON.parse(readFileSync(PATH, "utf8"));
if (Object.keys(doc.agents).includes("glm-flash")) {
  console.log(JSON.stringify({ verdict: "already-rekeyed" }));
  process.exit(0);
}
const backup = PATH + ".bak-20261005-preW4d";
if (!existsSync(backup)) copyFileSync(PATH, backup);

const out = { ...doc, agents: {} };
for (const [seat, entry] of Object.entries(doc.agents)) {
  const laneId = SEAT_TO_LANE[seat];
  if (!laneId) throw new Error(`未知席位 ${seat}——映射表不认识，中止`);
  // W4b 已裁"复用策略归角色"：席位 sessionReuse 丢弃，但必须先验证其政策已迁
  // config/roles.json（该席位的角色在册）——防策略静默丢失。
  if (entry.sessionReuse !== undefined && entry.systemPrompt) {
    const roleStem = entry.systemPrompt.split("/").pop().replace(/\.md$/, "");
    const rolePolicies = JSON.parse(readFileSync("config/roles.json", "utf8")).roles ?? {};
    if (rolePolicies[roleStem]?.sessionReuse !== entry.sessionReuse) {
      throw new Error(`席位 ${seat} 的 sessionReuse=${entry.sessionReuse} 未迁移到 roles.json[${roleStem}]——先迁政策再重键`);
    }
  }
  if (!out.agents[laneId]) {
    const { systemPrompt: _dropped, sessionReuse: _droppedPolicy, ...wiring } = entry; // 角色/策略都不再挂接线
    out.agents[laneId] = wiring; // 双车道首到落位；全字段一致性由下方比对把关
  }
}
// 同车道双席位（researcher+coder_low）：合并=保 coder_low 接线（同为 zcode/GLM-5.3-Flash
// 且无额外策略差异；researcher 特有字段若有则报出人工裁决）
for (const [seat, entry] of Object.entries(doc.agents)) {
  const laneId = SEAT_TO_LANE[seat];
  if (out.agents[laneId] && out.agents[laneId] !== entry) {
    const keys = new Set([...Object.keys(out.agents[laneId]), ...Object.keys(entry)]);
    for (const k of keys) {
      if (k === "systemPrompt" || k === "sessionReuse") continue;
      const a = JSON.stringify(out.agents[laneId][k] ?? null);
      const b = JSON.stringify(entry[k] ?? null);
      if (a !== b) throw new Error(`车道 ${laneId} 双席位字段 ${k} 不一致（${a} vs ${b}）——人工裁决后重跑`);
    }
  }
}
// matrix 行 agentId 换键（label 逐字节保留）
if (Array.isArray(out.certification?.matrix)) {
  out.certification.matrix = out.certification.matrix.map((row) => ({
    ...row,
    agentId: SEAT_TO_LANE[row.agentId] ?? row.agentId,
  }));
}
writeFileSync(PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ verdict: "REKEYED", lanes: Object.keys(out.agents).length, matrixRows: out.certification?.matrix?.length ?? 0, backup }));
