// scripts/migration/validate-identity-projection.mjs
//
// 0045 §6 第 2 步读取侧批的真实案卷验证器：在 runs/ 全部转录上跑身份投影，
// 证明三态划分 + 自描述派生在真实数据上成立。验证断言（任一失败=非零退出）：
//   V1 每份转录的档案 agentId 都落入三态之一；
//   V2 没有任何 agentId 落在 (在册 ∪ 冻结 legacy) 之外——出现即说明 legacy
//      名单需要蓄意扩集（0045 §1.5 扩集=蓄意事件）；
//   V3 派生覆盖数与案卷实测基线一致（run.started 总数/带 backend/带 model）；
//   V4 同名跨时代记录派生出不同指纹（coder_hq 陷阱的反向证明：真实数据里
//      至少存在一个名字对应 ≥2 个指纹）。
// 只读；不打印提示词/凭据内容，只输出计数与名字。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_AGENT_NAMES,
  projectAgentIdentity,
} from "../../src/application/identityProjection.js";

const EXPECTED_BASELINE = { files: 590, startedTotal: 585, startedWithBackend: 585, startedWithModel: 578 };

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// 在册名单：从私有注册表读键名（只取键，不碰 env/args 值）
const agentsDoc = readJsonSafe("config/agents.json");
const knownAgentIds = agentsDoc?.agents ? Object.keys(agentsDoc.agents) : [];

let files = 0;
const stateCounts = { normal: 0, legacy: 0, unknown: 0 };
const nameToFingerprints = new Map();
const identityNullFiles = [];
const unexpectedNames = new Set();
let startedTotal = 0, startedWithBackend = 0, startedWithModel = 0;

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && p.endsWith(".jsonl")) {
      files++;
      let archiveAgentId = null;
      let archiveStarted = null;
      const nameCounts = new Map();
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (typeof o.agentId === "string") {
          nameCounts.set(o.agentId, (nameCounts.get(o.agentId) ?? 0) + 1);
        }
        if (o.type === "run.started") {
          startedTotal++;
          if (typeof o.backend === "string") startedWithBackend++;
          if (o.model && typeof o.model.id === "string") startedWithModel++;
          if (!archiveStarted) archiveStarted = o; // 首个 run.started 为档案身份锚
        }
      }
      archiveAgentId = [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const proj = projectAgentIdentity({
        agentId: archiveAgentId, started: archiveStarted, knownAgentIds,
      });
      stateCounts[proj.state]++;
      if (proj.state === "unknown" && archiveAgentId !== null) unexpectedNames.add(archiveAgentId);
      if (proj.identity === null) identityNullFiles.push(p);
      if (archiveAgentId !== null && proj.fingerprint !== null) {
        if (!nameToFingerprints.has(archiveAgentId)) nameToFingerprints.set(archiveAgentId, new Set());
        nameToFingerprints.get(archiveAgentId).add(proj.fingerprint);
      }
    }
  }
}
walk("runs");

const multiFingerprints = [...nameToFingerprints.entries()]
  .filter(([, fps]) => fps.size >= 2)
  .map(([name, fps]) => ({ name, fingerprints: fps.size }));

const failures = [];
if (files !== EXPECTED_BASELINE.files) failures.push(`V3 文件数 ${files} ≠ 基线 ${EXPECTED_BASELINE.files}`);
if (startedTotal !== EXPECTED_BASELINE.startedTotal) failures.push(`V3 started ${startedTotal} ≠ ${EXPECTED_BASELINE.startedTotal}`);
if (startedWithBackend !== EXPECTED_BASELINE.startedWithBackend) failures.push(`V3 backend ${startedWithBackend} ≠ ${EXPECTED_BASELINE.startedWithBackend}`);
if (startedWithModel !== EXPECTED_BASELINE.startedWithModel) failures.push(`V3 model ${startedWithModel} ≠ ${EXPECTED_BASELINE.startedWithModel}`);
if (unexpectedNames.size > 0) failures.push(`V2 档案名落在闭集之外：${[...unexpectedNames].join(", ")}`);
if (multiFingerprints.length === 0) failures.push("V4 未发现任何一名多指纹记录（与 R2 会审实测矛盾——检查派生）");

console.log(JSON.stringify({
  files,
  knownAgentIds,
  legacySetSize: LEGACY_AGENT_NAMES.length,
  stateCounts,
  identityNullFiles: identityNullFiles.length,
  identityNullList: identityNullFiles.slice(0, 8),
  namesWithMultipleFingerprints: multiFingerprints,
  startedCoverage: { startedTotal, startedWithBackend, startedWithModel },
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  failures,
}, null, 2));
process.exitCode = failures.length === 0 ? 0 : 1;
