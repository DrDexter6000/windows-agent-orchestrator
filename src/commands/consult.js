// src/commands/consult.js
//
// M13-r1（决定 0039）：`wao consult` 命令族——多席只读会审的 CLI 适配层。
//
// 命令形状：
//   consult run <briefFile> --seats a,b [--perspective <agentId>=<file>]...
//            [--fields Q1=A,B]... [--reviewed-run <runId>] [--wait-timeout MS]
//            [--format json|text] [--cwd DIR] [--registry FILE] [--run-dir DIR]
//   consult show <consultId> [--format json|text] [--cwd DIR] [--run-dir DIR]
//
// 纯 CLI 适配：argv 解析、视角片段文件读取、console 渲染；数据逻辑全部委托
// ../application/consultService.js。文本渲染 = council-diff 并列呈现（按 brief
// 问题原序、每问下各席原文整段并列、未归类区整段、三块砖事实表、runId 回链
// 清单）——只呈现事实，不下语义结论（0039 §2.2）。
//
// 渲染零截断：text 视图逐行缩进展示每席全部归组文本；--format json 输出
// 结构化全量（含每席完整原文）。

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseOptions, resolveTargetCwd } from "./shared.js";
import {
  runConsult,
  loadConsultRecord,
  rerenderConsultFromRecord,
} from "../application/consultService.js";

// 可重复旗标收集（--perspective/--fields 可出现多次；parseOptions 只留末值，
// 重复值在这里显式收集）。
function collectRepeatable(args, flag) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      values.push(args[i + 1]);
      i += 1;
    }
  }
  return values;
}

function parseSeats(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("consult run requires --seats <agentId,agentId,...>");
  }
  const seats = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (seats.length === 0) throw new Error("consult run requires at least one seat in --seats");
  if (new Set(seats).size !== seats.length) throw new Error("--seats agentIds must be unique");
  return seats;
}

async function parsePerspectives(rawValues, seatIds) {
  const map = new Map();
  for (const raw of rawValues) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--perspective expects <agentId>=<file>, got: ${raw}`);
    }
    const agentId = raw.slice(0, eq);
    const file = raw.slice(eq + 1);
    if (!seatIds.includes(agentId)) {
      throw new Error(`--perspective seat "${agentId}" is not in --seats`);
    }
    map.set(agentId, await readFile(file, "utf8"));
  }
  return map;
}

function parseFields(rawValues) {
  const declared = {};
  for (const raw of rawValues) {
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--fields expects <Qn>=<v1,v2,...>, got: ${raw}`);
    }
    const key = raw.slice(0, eq).trim();
    if (!/^Q\d+$/.test(key)) {
      throw new Error(`--fields key must look like Q1/Q2..., got: ${key}`);
    }
    const values = raw.slice(eq + 1).split(",").map((v) => v.trim()).filter(Boolean);
    if (values.length === 0) {
      throw new Error(`--fields ${key} requires at least one declared value`);
    }
    declared[key] = values;
  }
  return declared;
}

function resolveConsultsDir(options, config) {
  return join(resolveTargetCwd(options), config?.stateDir ?? ".wao", "runs", "consults");
}

// ===== council-diff 文本渲染（只呈现事实；每席归组文本逐行缩进、零截断）=====

function indentBlock(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function seatEntryText(entries) {
  // 同一 Qn 多条目按文档序拼接（条目本身整段保留；仅条目间加空行分隔展示）。
  return entries.map((e) => e.text).join("\n");
}

function stateLine(seat) {
  const runId = seat.runId ?? "（无 run——派发未成立）";
  return `── ${seat.agentId}（${runId} · ${seat.runState}/${seat.formatState}${seat.budgetExpired ? " · 预算到期" : ""}）`;
}

/**
 * council-diff 文本视图。结构：头部（预算/耗时/brief）→ 按问题原序各席并列
 * → 开场区/未归类区（整段）→ 独立性三块砖事实表 → runId 回链清单。
 * fieldDiff 仅渲染 `字段值不同(Qn)` 行内标记 + 各席事实值——无结论词。
 * @param {object} result runConsult 结果（或 show 重渲染的同形对象）
 * @returns {string}
 */
export function renderCouncilDiffText(result) {
  const lines = [];
  const seatCount = result.seats.length;
  lines.push(`council-diff ${result.consultId}`);
  lines.push(
    `席位 ${seatCount} · 预算 ${result.budgetMs}ms · 耗时 ${result.elapsedMs}ms`
    + ` · brief: ${result.brief?.path ?? "（注入原文）"}（sha256 ${String(result.brief?.sha256 ?? "").slice(0, 12)}…）`,
  );
  for (const q of result.questions) {
    lines.push("");
    lines.push(`Q${q.q} ${q.heading.replace(/^#{1,3}\s*Q\d+\s*/, "").replace(/^Q\d+\s*[.::：]\s*/, "")}`);
    for (const seat of result.seats) {
      lines.push(stateLine(seat));
      const entries = (seat.attribution?.ordered ?? []).filter((e) => e.q === q.q);
      lines.push(entries.length > 0 ? indentBlock(seatEntryText(entries)) : "  （未覆盖此问——见未归类区/席状态）");
    }
    if (result.fieldDiff?.includes(`Q${q.q}`)) {
      const valueParts = result.seats.map((seat) => {
        const v = result.fieldValues?.[`Q${q.q}`]?.[seat.agentId];
        return `${seat.agentId}=${v ?? "未填"}`;
      });
      lines.push(`⚑ 字段值不同(Q${q.q})：${valueParts.join(" · ")}`);
    }
  }
  const openSeats = result.seats.filter((s) => (s.attribution?.preamble ?? "").trim().length > 0);
  if (openSeats.length > 0) {
    lines.push("");
    lines.push("—— 开场（首锚点之前，整段）——");
    for (const seat of openSeats) {
      lines.push(stateLine(seat));
      lines.push(indentBlock(seat.attribution.preamble));
    }
  }
  const unclassifiedSeats = result.seats.filter((s) => (s.attribution?.unclassified ?? "").trim().length > 0);
  if (unclassifiedSeats.length > 0) {
    lines.push("");
    lines.push("—— 未归类（整段原文，未做句子级切分）——");
    for (const seat of unclassifiedSeats) {
      lines.push(stateLine(seat));
      lines.push(indentBlock(seat.attribution.unclassified));
    }
  }
  lines.push("");
  lines.push("—— 独立性事实（advisory，非结论）——");
  // R9（决定 0023）：厂族砖直读 registry 原始字段（backend + provider 标识），
  // 不做族系归类——modelFamily 是展示闭集模块，控制面路径不得消费。
  const runtimeParts = result.seats.map((s) => `${s.agentId}=${s.backend ?? "?"} @ ${s.provider ?? "无 provider 标识"}`);
  lines.push(`厂族：${runtimeParts.join(" · ")}（registry 原始字段直读，不归类——判断权在 Lead）`);
  // 0045 R4 独立性三枚举（措辞不对称：相等=断言同源；不等=只说未检出，永不出现"独立"）。
  const groups = new Map();
  for (const seat of result.seats ?? []) {
    if (typeof seat.laneGroup === "number") {
      if (!groups.has(seat.laneGroup)) groups.set(seat.laneGroup, []);
      groups.get(seat.laneGroup).push(seat.agentId);
    }
  }
  for (const [group, members] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (members.length >= 2) {
      lines.push(`黄牌·同源席位：${members.join("、")} 同车道（等价类 ${group}）——这几份意见只算一个来源，不互为印证`);
    }
  }
  if (result.bricks?.reviewedRunId) {
    if (result.bricks.authorLaneInSeats === true) {
      const sameLaneSeat = (result.seats ?? []).find((x) => x.authorRelation === "same_lane");
      lines.push(`黄牌·作者同源：被审 run 与 ${sameLaneSeat?.agentId ?? "某席位"} 同车道——该席不算对作者的独立复核`);
    } else if (result.bricks.authorLaneInSeats === false) {
      lines.push("车道关联：未检出与被审 run 同车道的席位（不等于已证明独立）");
    } else {
      lines.push("车道关联：无法判定（缺 run.started 身份事实——不按独立计）");
    }
  }
  const noFact = (result.seats ?? []).filter((x) => x.laneGroup === null || x.laneGroup === undefined);
  if (noFact.length > 0) {
    lines.push(`车道身份未知：${noFact.map((x) => x.agentId).join("、")} 无 run.started 事实——不按独立计`);
  }
  if (result.bricks?.reviewedRunId) {
    const author = result.bricks.reviewedAgentId ?? "unknown";
    if (result.bricks.authorInSeats === true) {
      lines.push(`被审作者：run ${result.bricks.reviewedRunId} 的 agentId=${author} ∈ 席位清单（黄牌：被审产出作者在席位中——advisory，不拦截）`);
    } else if (result.bricks.authorInSeats === false) {
      lines.push(`被审作者：run ${result.bricks.reviewedRunId} 的 agentId=${author} ∉ 席位清单`);
    } else {
      lines.push(`被审作者：run ${result.bricks.reviewedRunId} transcript 不可读——无法判定（不猜）`);
    }
  } else {
    lines.push("被审作者：未提供 --reviewed-run（跳过非作者核查）");
  }
  lines.push(`会话独立性：${result.bricks?.sessionIndependence ?? "未提供"}（provider 会话号不在现有投影面）`);
  lines.push("");
  lines.push("—— runId 回链（意见-决策回链锚点，供 decisions/declare 引用）——");
  for (const seat of result.seats) {
    lines.push(`${seat.agentId}: ${seat.runId ?? "（无 run——派发未成立）"}`);
  }
  lines.push(`组记录：${result.recordPath ?? "（show 重渲染——见原记录）"}`);
  return lines.join("\n");
}

// ===== 子命令 =====

async function consultRunCommand(args, config, deps = {}) {
  const briefFile = args.find((a) => !a.startsWith("--"));
  if (!briefFile) {
    throw new Error("consult run requires <briefFile>（编号问题 Q1..Qn + 输出格式契约）");
  }
  const options = parseOptions(args);
  const seatIds = parseSeats(options.seats);
  const perspectives = await parsePerspectives(collectRepeatable(args, "--perspective"), seatIds);
  const declaredFields = parseFields(collectRepeatable(args, "--fields"));
  const format = options.format ?? "text";
  if (format !== "text" && format !== "json") {
    throw new Error("--format must be json or text");
  }
  const run = deps.runConsult ?? runConsult;
  const result = await run({
    briefPath: briefFile,
    seats: seatIds.map((agentId) => ({
      agentId,
      ...(perspectives.has(agentId) ? { perspectiveText: perspectives.get(agentId) } : {}),
    })),
    ...(Object.keys(declaredFields).length > 0 ? { declaredFields } : {}),
    ...(options.reviewedRun ? { reviewedRunId: options.reviewedRun } : {}),
    ...(options.waitTimeout !== undefined ? { budgetMs: Number(options.waitTimeout) } : {}),
    registryPath: options.registry ?? config?.registry ?? "config/agents.json",
    runDir: options.runDir ?? config?.runDir ?? "runs",
    consultsDir: resolveConsultsDir(options, config),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: process.env,
  });
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderCouncilDiffText(result));
}

async function consultShowCommand(args, config, deps = {}) {
  const consultId = args.find((a) => !a.startsWith("--"));
  if (!consultId) {
    throw new Error("consult show requires <consultId>");
  }
  const options = parseOptions(args);
  const format = options.format ?? "text";
  if (format !== "text" && format !== "json") {
    throw new Error("--format must be json or text");
  }
  const consultsDir = resolveConsultsDir(options, config);
  const runDir = options.runDir ?? config?.runDir ?? "runs";
  const record = await (deps.loadConsultRecord ?? loadConsultRecord)({ consultId, consultsDir });

  // 只读重渲染委派 service 层（M13-r2 提炼：CLI consult show 与 MCP run_consult
  // 读取模式共用同一实现；本层只做 console 渲染）。runState/formatState 按当前
  // transcript 真值重导出（show 是当下观察）；组记录中的历史观察值保留在 json
  // 输出的 record 字段里。
  const result = await rerenderConsultFromRecord({
    record,
    runDir,
    consultsDir,
    ...(deps.readTranscript ? { readTranscriptFn: deps.readTranscript } : {}),
    env: process.env,
  });
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderCouncilDiffText(result));
}

/**
 * `wao consult` 派遣器。deps 参数仅供测试注入（runConsult/loadConsultRecord/
 * readTranscript），生产调用（cli.js）不传。
 */
export async function consultCommand(args, config, deps = {}) {
  const [sub, ...rest] = args;
  if (sub === "run") {
    await consultRunCommand(rest, config, deps);
    return;
  }
  if (sub === "show") {
    await consultShowCommand(rest, config, deps);
    return;
  }
  throw new Error("consult requires a subcommand: run | show");
}
