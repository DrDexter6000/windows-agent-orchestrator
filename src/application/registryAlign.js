// src/application/registryAlign.js
//
// 决定 0108：私有注册表跟随车道表——`registry align`。
//
// 升级后模板与 config/lanes.json 换了型号或 effort，私有 config/agents.json 还是
// 旧接线，--lane 派发就以 lane_wiring_mismatch 拒绝。本模块做"逐车道显式采用"
// 的诊断与写侧：**不做通用合并**——没有合并基线，WAO 分不清用户有意的改动和
// 模板的更新，所以默认只读，写入只限用户点名的车道、只改接线四轴与同名认证
// 矩阵行的 modelId。
//
// 分层（layering 冻结）：application(1) 向下 import core(2) —— registry.js
// （normalizeAgent）、dispatchResolution.js（laneAxes/agentAxes/axesEqual——
// 不另写第二份轴比较规则）、safeText.js（解析报错不带源文本）、
// atomicWriteSync.js（原子替换）。
//
// 三类事实（诊断）：
//   1. 配置不合法：该条目过不了现有校验 normalizeAgent（含已退役的 provider 块）。
//   2. 接线与车道表不一致：四轴（backend/model.id/model.providerID/
//      reasoning.effort）逐项列出车道表值与注册表值。认证影响两类——
//      backend/model.id/providerID 变了是换了身份（四元组指纹变，旧认证不再
//      适用）；只差 effort 时身份不变，按 docs/certification-runbook.md
//      「lane 变更同步面」④ delta 重取证。同名认证矩阵行的 modelId 与车道表
//      不同也列出。
//   3. 与车道表不同但合法：车道表有、私有没有（可添加，不自动加）；私有有、
//      车道表没有（车道表已不再提供，默认保留）。
//
// 本地字段（cwd、env、binary、args、kimiHome、serveWorkspaceDir 及其余非接线
// 字段）只读不比，不进"要改"清单；输出也不回显 env 的值。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeAgent } from "../registry.js";
import { laneAxes, agentAxes, axesEqual, loadLanesConfig } from "../dispatchResolution.js";
import { escapeControlChars, safeJsonParse } from "../safeText.js";
import { atomicWriteFileSync } from "../atomicWriteSync.js";

const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// 模板（apply 的第二见证：车道表与模板在同一车道上不一致 = 仓库自身冲突，
// 拒绝采纳）。生产 = WAO 安装根 config/agents.example.json；测试经参数注入。
export const DEFAULT_TEMPLATE_PATH = join(MODULE_ROOT, "config", "agents.example.json");

// 接线四轴的稳定遍历序（渲染与 diff 顺序的事实来源）。
const AXIS_NAMES = Object.freeze(["backend", "modelId", "providerID", "effort"]);

/** 私有注册表原文的 SHA-256（utf8 串哈希，与 loadLanesConfig 的哈希面同法）。 */
export function sha256OfRaw(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * 逐条目单独校验（不抛出——单条坏条目不拖垮整份诊断；readRegistry().rawEntries()
 * 部分投影同纪律）。返回 null = 过校验；否则返回 normalizeAgent 的固定安全文案
 * （含已退役 provider 块的拒绝文案）。
 */
function entryInvalidReason(id, entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return "条目内容不是对象";
  }
  try {
    normalizeAgent(id, entry);
    return null;
  } catch (e) {
    return e?.message ?? "条目校验失败";
  }
}

function matrixRowOf(doc, id) {
  const rows = doc?.certification?.matrix;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row && typeof row === "object" && row.agentId === id) return row;
  }
  return null;
}

/**
 * 诊断：读私有注册表的原始 JSON（语法坏了如实报告、不往下做），逐条目给出
 * 三类事实。纯读——零写入、零派生副作用。
 *
 * @param {object} input
 * @param {string} input.registryPath 私有注册表路径
 * @param {object} input.lanesDoc loadLanesConfig 的产物（或测试注入的同形状）
 * @returns {{ok:false, registryPath, sha256?, syntaxError?:string, readError?:string}
 *          |{ok:true, registryPath, sha256, lanesTablePath, lanesDocIssues,
 *            entries:Array, onlyInTable:string[], onlyInRegistry:string[]}}
 */
export function diagnoseRegistryAlignment({ registryPath, lanesDoc }) {
  let rawBuffer;
  try {
    rawBuffer = readFileSync(registryPath);
  } catch {
    return { ok: false, registryPath, readError: "私有注册表读不到（不存在或无权限）" };
  }
  const raw = rawBuffer.toString("utf8");
  const sha256 = createHash("sha256").update(rawBuffer).digest("hex");
  let doc;
  try {
    // TD-318：解析失败只抛固定文案 + 行列号，不带源文本。
    doc = safeJsonParse(raw, "registry 文件");
  } catch (e) {
    return { ok: false, registryPath, sha256, syntaxError: e.message };
  }
  const agents = doc && typeof doc === "object" && doc.agents !== null && typeof doc.agents === "object"
    ? doc.agents
    : {};

  const lanes = Array.isArray(lanesDoc?.lanes) ? lanesDoc.lanes : [];
  const lanesById = new Map();
  for (const lane of lanes) {
    if (lane && typeof lane.id === "string") lanesById.set(lane.id, lane);
  }

  const entries = [];
  const onlyInRegistry = [];
  const seenIds = new Set();
  const agentKeys = Object.keys(agents);
  for (const [id, entry] of Object.entries(agents)) {
    seenIds.add(id);
    // 1 起序号（agents 对象内的位置）——非法键名条目在渲染层以序号指代不回显。
    const position = agentKeys.indexOf(id) + 1;
    const lane = lanesById.get(id);
    const invalidReason = entryInvalidReason(id, entry);
    if (!lane) {
      // 私有有、车道表没有：车道表已不再提供，默认保留；条目本身照样单独校验。
      if (invalidReason !== null) entries.push({ id, position, state: "invalid", invalidReason, inLaneTable: false });
      else onlyInRegistry.push(id);
      continue;
    }
    if (invalidReason !== null) {
      entries.push({ id, position, state: "invalid", invalidReason, inLaneTable: true });
      continue;
    }
    const la = laneAxes(lane);
    const aa = agentAxes(entry);
    const diffs = [];
    for (const axis of AXIS_NAMES) {
      if (aa[axis] !== la[axis]) diffs.push({ axis, laneValue: la[axis], registryValue: aa[axis] });
    }
    // 同名认证矩阵行的 modelId 与车道表不同也列出（apply 时只改 modelId）。
    // 只看**在场**的行：行不存在=没有可采纳的 modelId（apply 也不添加行），
    // 不是矩阵行漂移；行在场而 modelId 缺失/不同 = 漂移。
    const row = matrixRowOf(doc, id);
    const rowModelId = row && typeof row.modelId === "string" ? row.modelId : null;
    const matrixMismatch = la.modelId !== null && row != null && rowModelId !== la.modelId;
    if (diffs.length > 0) {
      // 认证影响两类：backend/model.id/providerID 变 = 换身份（四元组指纹变，
      // 旧认证不再适用）；只差 effort = 身份不变，delta 重取证（runbook ④）。
      const identityChange = diffs.some((d) => d.axis !== "effort");
      entries.push({
        id,
        position,
        state: "wiring-mismatch",
        laneAxes: la,
        registryAxes: aa,
        diffs,
        certImpact: identityChange ? "identity" : "effort-only",
        matrixMismatch: matrixMismatch ? { rowModelId, laneModelId: la.modelId } : null,
      });
    } else {
      entries.push({
        id,
        position,
        state: "aligned",
        laneAxes: la,
        registryAxes: aa,
        diffs: [],
        certImpact: null,
        matrixMismatch: matrixMismatch ? { rowModelId, laneModelId: la.modelId } : null,
      });
    }
  }
  const onlyInTable = [...lanesById.keys()].filter((id) => !seenIds.has(id));
  return {
    ok: true,
    registryPath,
    sha256,
    lanesTableOk: lanesDoc?.ok === true,
    lanesTablePath: lanesDoc?.path ?? null,
    lanesDocIssues: Array.isArray(lanesDoc?.issues) ? lanesDoc.issues : [],
    entries,
    onlyInTable,
    onlyInRegistry,
  };
}

/**
 * 把一条接线条目的四轴改成车道表值（原处修改——doc 是 freshly parsed 的对象）。
 * 只动四轴对应的键：model/reasoning 块里的其它键（如 contextWindow）保留；
 * 车道表侧为 null 的轴键删除（providerID/effort 不留 null 值——与
 * laneAxes 的 null 归一语义对齐，写出的文件不携带占位 null）。
 */
export function applyAxesToEntry(entry, target) {
  entry.backend = target.backend;
  if (target.modelId === null) {
    // 只删轴键：model 块里的其它键（如 contextWindow）保留；删空了才去掉整块。
    if (entry.model !== null && typeof entry.model === "object") {
      delete entry.model.id;
      delete entry.model.providerID;
      if (Object.keys(entry.model).length === 0) delete entry.model;
    }
  } else {
    if (entry.model === null || typeof entry.model !== "object") entry.model = {};
    entry.model.id = target.modelId;
    if (target.providerID === null) delete entry.model.providerID;
    else entry.model.providerID = target.providerID;
  }
  if (target.effort === null) {
    if (entry.reasoning !== null && typeof entry.reasoning === "object") {
      delete entry.reasoning.effort;
      if (Object.keys(entry.reasoning).length === 0) delete entry.reasoning;
    }
  } else {
    if (entry.reasoning === null || typeof entry.reasoning !== "object") entry.reasoning = {};
    entry.reasoning.effort = target.effort;
  }
}

/**
 * apply 只能整份重写（JSON.stringify），所以先确认重写不改动任何值的写法：原文去掉
 * 字符串外的空白后，必须与解析结果的紧凑序列化逐字相同。数字写法（1.0、1e400、超出
 * 安全整数）、重复键、字符串转义写法不同都会不等——这类文件拒绝改写。
 */
export function rewritesLosslessly(raw, doc) {
  let compact = "";
  let inString = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      compact += ch;
      if (ch === "\\") {
        compact += raw[i + 1] ?? "";
        i += 1;
      } else if (ch === "\"") {
        inString = false;
      }
    } else if (ch === "\"") {
      inString = true;
      compact += ch;
    } else if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      compact += ch;
    }
  }
  return compact === JSON.stringify(doc);
}

/**
 * 写备份：同目录 <注册表文件名>.bak-<UTC 时间戳>；同名已存在就换名。用独占创建（flag "wx"）写，
 * 查重与写入之间冒出同名文件也只会 EEXIST 换下一个名字，绝不覆盖已有备份。返回实际路径。
 */
export function writeBackupExclusive(dir, base, stamp, buffer) {
  for (let n = 0; ; n += 1) {
    const p = join(dir, n === 0 ? `${base}.bak-${stamp}` : `${base}.bak-${stamp}-${n}`);
    if (existsSync(p)) continue;
    try {
      writeFileSync(p, buffer, { flag: "wx" });
      return p;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

/**
 * `--apply`：把点名车道的四轴改成车道表的值，同名矩阵行只改 modelId。
 * 全部拒绝条件在备份与写盘之前逐项核实——任一命中整次拒绝、什么都不写。
 *
 * @param {object} input
 * @param {string[]} input.selectedLaneIds --lane 收集（去重保序后的闭集外值也在此拒）
 * @param {string} input.expectSha256 与当前文件一致的哈希（防预览后文件又变）
 * @param {Function} [input.nowFn] 备份时间戳缝（测试注入；缺省 real clock）
 * @returns {{ok:false, refusal:string}
 *          |{ok:true, wrote:boolean, changes:Array, sha256, backupPath?:string,
 *            newSha256?:string}}
 */
export function applyRegistryAlignment({
  registryPath,
  lanesDoc,
  templatePath = DEFAULT_TEMPLATE_PATH,
  selectedLaneIds,
  expectSha256,
  nowFn = () => new Date(),
}) {
  if (!Array.isArray(selectedLaneIds) || selectedLaneIds.length === 0) {
    return { ok: false, refusal: "--apply 需要至少一个 --lane <id>——没有一键全修；先不带 --apply 看预览" };
  }
  const expect = typeof expectSha256 === "string" ? expectSha256.toLowerCase() : null;
  if (expect === null || !/^[0-9a-f]{64}$/.test(expect)) {
    return { ok: false, refusal: "--apply 必须带 --expect-sha256 <hex>（64 位十六进制；当前文件哈希见不带 --apply 的预览输出）" };
  }
  let rawBuffer;
  try {
    rawBuffer = readFileSync(registryPath);
  } catch {
    return { ok: false, refusal: "私有注册表读不到（不存在或无权限）——什么都不写" };
  }
  const raw = rawBuffer.toString("utf8");
  const sha256 = createHash("sha256").update(rawBuffer).digest("hex");
  if (sha256 !== expect) {
    return { ok: false, refusal: "--expect-sha256 与当前文件不符——预览之后文件又变过；重跑预览拿最新 SHA-256，确认无误再 --apply（什么都不写）" };
  }
  let doc;
  try {
    doc = safeJsonParse(raw, "registry 文件");
  } catch (e) {
    return { ok: false, refusal: `私有注册表 JSON 解析失败——${e.message}；先修语法再 align（什么都不写）` };
  }
  if (!rewritesLosslessly(raw, doc)) {
    return { ok: false, refusal: "私有注册表里有整份重写会改变写法的值（如数字写成 1.0、1e400 或超出安全整数，重复的键，字符串里的转义写法）——align 只能整份重写，拒绝改写；请手工修改（什么都不写）" };
  }
  if (lanesDoc?.ok !== true) {
    const count = Array.isArray(lanesDoc?.issues) ? lanesDoc.issues.length : 0;
    return { ok: false, refusal: `车道表 config/lanes.json 结构校验未过（${count} 项 issue）——先修表再 align（什么都不写）` };
  }
  const agents = doc && typeof doc === "object" && doc.agents !== null && typeof doc.agents === "object"
    ? doc.agents
    : {};
  const lanes = Array.isArray(lanesDoc.lanes) ? lanesDoc.lanes : [];
  // 点名车道去重保序；解析目标车道，逐个过全部拒绝条件。
  const selected = [...new Set(selectedLaneIds)];
  const targets = [];
  for (const id of selected) {
    const lane = lanes.find((l) => l && typeof l === "object" && l.id === id);
    if (!lane) {
      return { ok: false, refusal: `车道 "${escapeControlChars(id)}" 不在车道表 config/lanes.json——align 只把车道表提供的车道对齐，不发明目标（什么都不写）` };
    }
    if (!Object.prototype.hasOwnProperty.call(agents, id)) {
      return { ok: false, refusal: `车道 "${id}" 不在私有注册表——align 不添加新条目（要添加走 wao onboarding 或手工编辑）（什么都不写）` };
    }
    // 第二见证：模板与车道表在同一车道上不一致 = 仓库自身冲突，不猜谁对。
    let templateEntry;
    try {
      const tdoc = safeJsonParse(readFileSync(templatePath, "utf8"), "模板 config/agents.example.json");
      templateEntry = tdoc?.agents?.[id];
    } catch (e) {
      return { ok: false, refusal: `模板 config/agents.example.json 读不了——${e.message}（仓库自身问题；什么都不写）` };
    }
    if (!templateEntry || typeof templateEntry !== "object") {
      return { ok: false, refusal: `车道表与模板不一致：模板没有车道 "${id}" 的接线条目（仓库自身冲突——先修仓库，align 拒绝采纳；什么都不写）` };
    }
    const la = laneAxes(lane);
    if (!axesEqual(la, agentAxes(templateEntry))) {
      return { ok: false, refusal: `车道表与模板在车道 "${id}" 的接线轴不一致（仓库自身冲突：车道表 ${escapeControlChars(la.backend)}/${escapeControlChars(la.modelId)}/${escapeControlChars(la.providerID)}/${escapeControlChars(la.effort)} vs 模板）——先修仓库，align 拒绝采纳（什么都不写）` };
    }
    targets.push({ position: selected.indexOf(id) + 1, id, lane, entry: agents[id] });
  }
  // 原处改四轴 + 同名矩阵行 modelId；label/profile/drills、_comment* 与全部
  // 本地字段不碰（只写 targets[].entry 的轴键与 matrix 行的 modelId）。
  const changes = [];
  for (const { position, id, lane, entry } of targets) {
    const before = agentAxes(entry);
    const target = laneAxes(lane);
    const axisChanged = !axesEqual(before, target);
    if (axisChanged) applyAxesToEntry(entry, target);
    let matrixChanged = false;
    if (target.modelId !== null) {
      const row = matrixRowOf(doc, id);
      if (row && typeof row === "object" && row.modelId !== target.modelId) {
        row.modelId = target.modelId;
        matrixChanged = true;
      }
    }
    changes.push({ position, id, axisChanged, matrixChanged });
  }
  // 改后逐条过现有校验——过不了就整次拒绝（此时 doc 只是内存对象，盘上未动）。
  for (const { id } of targets) {
    const reason = entryInvalidReason(id, agents[id]);
    if (reason !== null) {
      return { ok: false, refusal: `车道 "${escapeControlChars(id)}" 对齐后过不了现有校验——${escapeControlChars(reason)}；align 不写盘（什么都不写）` };
    }
  }
  const anyChange = changes.some((c) => c.axisChanged || c.matrixChanged);
  if (!anyChange) {
    return { ok: true, wrote: false, changes, sha256, message: "所选车道已与车道表一致（四轴与矩阵 modelId 均无差异）——未写盘" };
  }
  // 写前备份：原文件逐字节（Buffer）落到同目录 <注册表文件名>.bak-<UTC 时间戳>；
  // 同名已存在就换名，不覆盖。备份成功才原子替换。
  const stamp = nowFn().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const backupPath = writeBackupExclusive(dirname(registryPath), basename(registryPath), stamp, rawBuffer);
  const newContent = `${JSON.stringify(doc, null, 2)}\n`;
  atomicWriteFileSync(registryPath, newContent);
  return {
    ok: true,
    wrote: true,
    changes,
    sha256,
    backupPath,
    newSha256: sha256OfRaw(newContent),
  };
}

/**
 * lead_preflight 的一行事实（决定 0108）：车道表与私有注册表的接线不一致会让
 * --lane 派发被拒——把这件事压缩成一行观察（facts only）。车道表结构未过时
 * 派发先以 lanes_config_invalid 拒绝，这一行就说它。无接线不一致（或注册表
 * 读不了/语法坏了——那类事实归 registryIssues 面）→ null，不加行。
 *
 * @param {object} input
 * @param {string} input.registryPath
 * @param {object} [input.lanesDoc] 注入缝（缺省读 WAO 安装根的真实车道表）
 * @returns {string|null} ≤512 字符的一行（MCP observations 项上限内）
 */
export function laneWiringMismatchFactLine({ registryPath, lanesDoc } = {}) {
  if (typeof registryPath !== "string" || registryPath.length === 0) return null;
  const doc = lanesDoc ?? loadLanesConfig();
  const diag = diagnoseRegistryAlignment({ registryPath, lanesDoc: doc });
  if (!diag.ok) return null;
  if (!diag.lanesTableOk) {
    return `lane wiring: 车道表 config/lanes.json 结构校验未过（${diag.lanesDocIssues.length} 项）——--lane 派发会以 lanes_config_invalid 拒绝；修好车道表后看 npm run cli -- registry align 预览`;
  }
  const mismatches = diag.entries.filter((e) => e.state === "wiring-mismatch");
  if (mismatches.length === 0) return null;
  const ids = mismatches.map((e) => e.id);
  const shown = ids.slice(0, 3).join("、");
  const more = ids.length > 3 ? ` 等 ${ids.length} 条` : "";
  return `lane wiring: 车道 ${shown}${more} 的接线与私有注册表不一致——--lane 派发会以 lane_wiring_mismatch 拒绝；预览: npm run cli -- registry align --lane <id>`;
}
