// src/commands/consult.js
//
// M13-r1（决定 0039）：`wao consult` 命令族——多席只读会审的 CLI 适配层。
//
// 命令形状：
//   consult run <briefFile> --seats a,b [--perspective <agentId>=<file>]...
//            [--fields Q1=A,B]... [--reviewed-run <runId>] [--wait-timeout MS]
//            [--format json|text] [--cwd DIR] [--registry FILE] [--run-dir DIR]
//   consult show <consultId> [--seat <agentId> [--out FILE] | --out-dir DIR] [--format json|text] [--cwd DIR] [--run-dir DIR]
//   consult wait <consultId> [--wait-ms MS | --until-settled] [--format json|text] [--cwd DIR] [--run-dir DIR]
//
// 纯 CLI 适配：argv 解析、视角片段文件读取、console 渲染；数据逻辑全部委托
// ../application/consultService.js。文本渲染 = council-diff 并列呈现（按 brief
// 问题原序、每问下各席原文整段并列、未归类区整段、三块砖事实表、runId 回链
// 清单）——只呈现事实，不下语义结论（0039 §2.2）。
//
// 渲染零截断：text 视图逐行缩进展示每席全部归组文本；--format json 输出
// 结构化全量（含每席完整原文）。

import { writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parseOptions, resolveTargetCwd, lanesDocForCall } from "./shared.js";
import { getWaoStateDir } from "../waoDir.js";
// 决定 0095：`consult wait --until-settled` 逐席调用与 `runs wait
// --until-settled` 共用的收口等待器（轮询循环原样上移到家模块，不复制算法）；
// 不可信轮上限也取自同一模块（"Untrusted: N consecutive rounds" 文案同源）。
import {
  waitRunSettlement,
  SETTLEMENT_MAX_UNTRUSTED_ROUNDS,
} from "../application/runSettlementWait.js";
// 决定 0096：验证者缺席证明的 daemon 握手 SSOT 在 adapters 层（daemon.js），
// 命令层注入给等待器（application 层不得上向导入）——与 runs wait 同款接线。
import { readHandshakeDetailed, isDaemonAlive } from "../daemon.js";
import {
  runConsult,
  loadConsultRecordWithFallback,
  rerenderConsultFromRecord,
  waitForConsult,
  selectNonTerminalSeats,
} from "../application/consultService.js";
// 决定 0096：有未终态席位时，consult 的三条命令在输出末尾附 CLI 面 nextStep
//（模板与长度上限的家在 runNextStep.js）。
import { buildNextStep } from "../application/runNextStep.js";
import { TERMINAL_STATES } from "../transcript.js";
// TD-319：未知子命令的"报错 + 用法"两行有意分行——linesError 构造（.message
// 与改前逐字一致），CLI 输出口按行转义。
import { linesError } from "../safeText.js";

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

// 决定 0111：组记录是 .wao 本地状态——经 getWaoStateDir 解析（链接工作树里
// 重定向到主工作树）；consult 没有 --state-dir，配置里的 stateDir 只给名字。
function resolveConsultsDir(options, config) {
  return join(getWaoStateDir(resolveTargetCwd(options), { configured: config?.stateDir }), "runs", "consults");
}

// 决定 0111：按 id 读记录的回退目录——改动前的落点，与改动前的拼法逐字相同
// （join、只看配置）。只有状态目录里没有这份记录（ENOENT）且两边不同时才读它。
function legacyConsultsDir(options, config) {
  return join(resolveTargetCwd(options), config?.stateDir ?? ".wao", "runs", "consults");
}

/**
 * 决定 0096：还有未终态席位时给 CLI 面 nextStep（未终态席位的判定与 MCP 回执
 * 共用 selectNonTerminalSeats）；全部终态返回 null（输出不带该行/字段）。
 * `json` 只影响超过 480 字符时不列 runId 的回退说法。
 * @param {object} result — runConsult / rerenderConsultFromRecord 的结果
 * @param {{json: boolean}} options
 * @returns {string|null}
 */
function consultNextStep(result, { json }) {
  const running = selectNonTerminalSeats(result?.seats);
  if (running.length === 0) return null;
  return buildNextStep({
    surface: "cli",
    situation: "consult_seats_running",
    seatRunIds: running.map((seat) => seat.runId),
    consultId: result.consultId,
    cliJson: json,
  });
}

/** 决定 0096：文本模式在 stdout 末尾补 nextStep 行（没有就什么都不加）。 */
function printConsultNextStep(nextStep) {
  if (nextStep !== null) console.log(`Next step: ${nextStep}`);
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
  const runtimeParts = result.seats.map((s) => {
    // 0045 W4c：注册表解析失败如实标注（区别于"确无 provider 标识"）。
    if (s.registryResolution === "failed") return `${s.agentId}=注册表解析失败（席位已不在注册表？不按独立计）`;
    if (s.registryResolution === "registry-unreadable") return `${s.agentId}=注册表不可读（不按独立计）`;
    return `${s.agentId}=${s.backend ?? "?"} @ ${s.provider ?? "无 provider 标识"}`;
  });
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
    // TD-283：席位目标车道带 Owner 暂停说明 → 每席一行 stderr advisory（只提示
    // 不拦截，派发照常进行）。
    advisorySink: (line) => console.error(line),
    // 车道表：非默认 --registry 时停用（防跨绑，规则同 run 命令），席位解析与
    // 暂停提示都不读它；config.lanesDocFn 是测试缝。
    lanesDocFn: () => lanesDocForCall(options, config, config?.lanesDocFn),
    // 扇出一完成就在 stderr 报出 consultId（stdout 留给最终结果）：等待预算到期
    // 之前就能另起命令 `consult show` / `consult wait`。
    onFanOut: ({ consultId, seats }) => {
      // 提示里带上本次用到的 --cwd / --run-dir：照抄到另一个终端也能找到同一份记录。
      const where = [
        options.cwd ? ` --cwd ${JSON.stringify(options.cwd)}` : "",
        options.runDir ? ` --run-dir ${JSON.stringify(options.runDir)}` : "",
      ].join("");
      console.error(`[consult] ${consultId} started — seats: ${seats.map((s) => `${s.agentId}=${s.runId ?? "dispatch_failed"}`).join(" ")}`);
      console.error(`[consult] read now: consult show ${consultId}${where} · keep waiting after the budget: consult wait ${consultId}${where}`);
    },
  });
  const nextStep = consultNextStep(result, { json: format === "json" });
  if (format === "json") {
    console.log(JSON.stringify(nextStep === null ? result : { ...result, nextStep }, null, 2));
    return;
  }
  console.log(renderCouncilDiffText(result));
  printConsultNextStep(nextStep);
}

function writeSeatText(result, options, deps) {
  const seat = result.seats.find((s) => s.agentId === options.seat);
  if (!seat) {
    throw new Error(`consult show: seat "${options.seat}" is not in this consult (seats: ${result.seats.map((s) => s.agentId).join(", ")})`);
  }
  const text = typeof seat.finalText === "string" ? seat.finalText : "";
  if (typeof options.out === "string") {
    (deps.writeFileSync ?? writeFileSync)(resolve(options.out), text, "utf8");
    console.log(`${seat.agentId} (${seat.runId ?? "no run"} · ${seat.runState}): ${text.length} chars written to ${resolve(options.out)}`);
    return;
  }
  console.log(text);
}

/**
 * `consult show <consultId> --out-dir DIR`：把每个席位的完整终稿写到
 * DIR/<agentId>.md（目录不存在就建），每席打印一行（格式同 --seat --out 那一行）。
 * 无 finalText 的席位（缺席/未到终态/派发未成立）写空文件并照常报行——如实，
 * 不跳过。agentId 直接进文件名，先过一道文件名安全门（不含路径分隔符、不是
 * 点段），防席位名把写出点带离 DIR。
 */
function writeAllSeatTexts(result, options, deps) {
  const outDir = resolve(options.outDir);
  (deps.mkdirFn ?? mkdirSync)(outDir, { recursive: true });
  for (const seat of result.seats) {
    const agentId = seat.agentId;
    if (typeof agentId !== "string" || agentId.length === 0
      || /[\\/]/.test(agentId) || agentId === "." || agentId === "..") {
      throw new Error(`consult show: --out-dir needs a file-safe agentId, seat "${agentId}" is not`);
    }
    const text = typeof seat.finalText === "string" ? seat.finalText : "";
    const path = join(outDir, `${agentId}.md`);
    (deps.writeFileSync ?? writeFileSync)(path, text, "utf8");
    console.log(`${agentId} (${seat.runId ?? "no run"} · ${seat.runState}): ${text.length} chars written to ${path}`);
  }
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
  // 决定 0111：先在状态目录读，ENOENT 才回退改动前的落点；回显真实位置。
  const { record, consultsDir: recordDir } = await loadConsultRecordWithFallback({
    consultId,
    consultsDir,
    fallbackConsultsDir: legacyConsultsDir(options, config),
    ...(deps.loadConsultRecord ? { loadFn: deps.loadConsultRecord } : {}),
  });

  // 只读重渲染委派 service 层（M13-r2 提炼：CLI consult show 与 MCP run_consult
  // 读取模式共用同一实现；本层只做 console 渲染）。runState/formatState 按当前
  // transcript 真值重导出（show 是当下观察）；组记录中的历史观察值保留在 json
  // 输出的 record 字段里。consultsDir 用实际读到记录的目录（recordPath 如实）。
  const result = await rerenderConsultFromRecord({
    record,
    runDir,
    consultsDir: recordDir,
    ...(deps.readTranscript ? { readTranscriptFn: deps.readTranscript } : {}),
    env: process.env,
  });
  if (options.seat !== undefined) {
    if (typeof options.seat !== "string") throw new Error("consult show: --seat requires an agentId");
    if (options.out === true) throw new Error("consult show: --out requires a file path");
    if (options.outDir !== undefined) throw new Error("consult show: --out-dir cannot be combined with --seat (it writes every seat)");
    writeSeatText(result, options, deps);
    return;
  }
  if (options.outDir !== undefined) {
    if (typeof options.outDir !== "string") throw new Error("consult show: --out-dir requires a directory path");
    if (options.out !== undefined) throw new Error("consult show: --out-dir cannot be combined with --out (per-seat --out writes one file)");
    writeAllSeatTexts(result, options, deps);
    return;
  }
  if (options.out !== undefined) {
    throw new Error("consult show: --out goes with --seat <agentId> (one seat's complete final text)");
  }
  const nextStep = consultNextStep(result, { json: format === "json" });
  if (format === "json") {
    console.log(JSON.stringify(nextStep === null ? result : { ...result, nextStep }, null, 2));
    return;
  }
  console.log(renderCouncilDiffText(result));
  printConsultNextStep(nextStep);
}

/**
 * consult wait（有界与 --until-settled 两路共用）的返回输出：stderr 摘要行 +
 * 正常渲染 / --format json（决定 0096：有未终态席位时 stdout 末尾补 nextStep）。
 * stderr 只陈列这一次看到的事实。有 runId 的席位：等待或重渲染任一次看到它们
 * 全部终态，就说全部终态（等待结束到重渲染之间可能刚到终态；等待已看到终态、
 * 重渲染时转录暂时读不到，也不是"窗口到期"）；否则说窗口到期，会输出
 * `Next step:` 行才说"see the next step below"。再按数补上转录读不到的席位与
 * 派发未成立（没有 runId）的席位；一个都没派发出去就直说。有这几类时指向
 * `consult show`。allTerminal 取等待侧的观察（--until-settled 全收口即 true；
 * windowMs 传 null 表示无界等待）。
 */
function emitConsultWaitResult({ consultId, result, format, allTerminal, waitedMs, windowMs }) {
  const nextStep = consultNextStep(result, { json: format === "json" });
  const seats = result.seats ?? [];
  const dispatchedSeats = seats.filter((seat) => typeof seat.runId === "string" && seat.runId.length > 0);
  const undispatched = seats.length - dispatchedSeats.length;
  const unreadable = dispatchedSeats.filter((seat) => seat.runState === "missing").length;
  const parts = [];
  if (dispatchedSeats.length === 0) {
    parts.push("no seat was dispatched");
  } else if (allTerminal || dispatchedSeats.every((seat) => TERMINAL_STATES.includes(seat.runState))) {
    parts.push("every dispatched seat reached a terminal state");
  } else {
    parts.push(nextStep !== null
      ? "the window expired with seats still running — see the next step below"
      : "the window expired before every dispatched seat was observed terminal");
  }
  if (unreadable > 0) parts.push(`${unreadable} seat transcript(s) could not be read`);
  if (undispatched > 0 && dispatchedSeats.length > 0) parts.push(`${undispatched} seat(s) were never dispatched`);
  const pointToShow = dispatchedSeats.length === 0 || unreadable > 0 || undispatched > 0;
  console.error(`[consult] ${consultId}: ${parts.join("; ")}${pointToShow
    ? ` — see their state with: consult show ${consultId}`
    : ""} after ${Math.round(waitedMs / 1000)}s`);
  if (format === "json") {
    console.log(JSON.stringify({
      ...result,
      ...(nextStep === null ? {} : { nextStep }),
      wait: { allTerminal, waitedMs, windowMs },
    }, null, 2));
    return;
  }
  console.log(renderCouncilDiffText(result));
  printConsultNextStep(nextStep);
}

async function consultWaitCommand(args, config, deps = {}) {
  const consultId = args.find((a) => !a.startsWith("--"));
  if (!consultId) {
    throw new Error("consult wait requires <consultId>");
  }
  const options = parseOptions(args);
  const format = options.format ?? "text";
  if (format !== "text" && format !== "json") {
    throw new Error("--format must be json or text");
  }
  // 决定 0095：--until-settled 是布尔旗标（不带值），与 --wait-ms 互斥。
  // parseOptions 会把"旗标后跟非 -- token"读成字符串值（包括旗标写在 consultId
  // 之前把位置参数吞成值的形状）——布尔旗标带值按用法错误拒绝，不猜。
  if (options.untilSettled !== undefined && options.untilSettled !== true) {
    throw new Error("consult wait: --until-settled is a boolean flag and takes no value (write: consult wait <consultId> --until-settled; the bounded window is --wait-ms)");
  }
  if (options.untilSettled !== undefined && options.waitMs !== undefined) {
    throw new Error("consult wait: --until-settled and --wait-ms are mutually exclusive");
  }
  const consultsDir = resolveConsultsDir(options, config);
  const runDir = options.runDir ?? config?.runDir ?? "runs";
  if (options.untilSettled !== undefined) {
    await consultWaitUntilSettledCommand({
      consultId, asJson: format === "json", consultsDir, fallbackConsultsDir: legacyConsultsDir(options, config), runDir,
    }, deps);
    return;
  }
  // 决定 0111：等待也经回退读取找记录；实际读到的目录一路传给重渲染。
  const waited = await (deps.waitForConsult ?? waitForConsult)({
    consultId,
    consultsDir,
    fallbackConsultsDir: legacyConsultsDir(options, config),
    runDir,
    ...(options.waitMs !== undefined ? { waitMs: Number(options.waitMs) } : {}),
    ...(deps.readTranscript ? { readTranscriptFn: deps.readTranscript } : {}),
  });
  const result = await rerenderConsultFromRecord({
    record: waited.record,
    runDir,
    consultsDir: waited.consultsDir ?? consultsDir,
    ...(deps.readTranscript ? { readTranscriptFn: deps.readTranscript } : {}),
    env: process.env,
  });
  emitConsultWaitResult({
    consultId,
    result,
    format,
    allTerminal: waited.allTerminal,
    waitedMs: waited.waitedMs,
    windowMs: waited.windowMs,
  });
}

/**
 * 决定 0095：`consult wait <consultId> --until-settled`——一直等到这场会审每个
 * 已派发席位的 run 都收口才返回。逐席调用与 `runs wait <runId> --until-settled`
 * 共用的等待器（runSettlementWait.js：轮询 + 不可信轮 + 决定 0096 验证者缺席
 * 证明——不复制算法）；按组记录顺序逐席等，前一席收口才轮到下一席。
 *
 * 退出码与 runs wait --until-settled 同义：0 全部收口；3 一席不可信轮连续 4 次
 *（含无法收口的交付事实）或验证者已证明不在（verifier_gone）；4 一席转录冲突
 *（多副本内容不同）；130 SIGINT（单一出口：置位后只输出一份中断结果，绝不出
 * 第二份）。未收口即停在那一席并在 stderr 点名（<agentId> (<runId>)）与给出
 * 与 runs wait 同义的处置行；没有 runId 的席位（派发未成立）不等。
 *
 * 返回（全部收口）时的输出与有界 consult wait 一致：stderr 摘要行 + 正常渲染 /
 * --format json（wait 块 { allTerminal: true, waitedMs, windowMs: null }——
 * 无界等待没有窗口）。
 *
 * deps 注入缝（测试确定性）：loadConsultRecord / waitRunSettlement /
 * readTranscript（同时作等待器与重渲染的转录读器）/ pollIntervalMs /
 * resolveDetailedFn / sleepFn / nowFn / verifierGoneFn / verifierProofDeps /
 * writeFileSync / mkdirFn。
 */
async function consultWaitUntilSettledCommand({ consultId, asJson, consultsDir, fallbackConsultsDir, runDir }, deps = {}) {
  // 决定 0111：先在状态目录读，ENOENT 才回退改动前的落点；实际读到的目录传给重渲染。
  const { record, consultsDir: recordDir } = await loadConsultRecordWithFallback({
    consultId,
    consultsDir,
    fallbackConsultsDir,
    ...(deps.loadConsultRecord ? { loadFn: deps.loadConsultRecord } : {}),
  });
  const dispatched = (record.seats ?? []).filter((seat) => typeof seat.runId === "string" && seat.runId.length > 0);
  const waitFn = deps.waitRunSettlement ?? waitRunSettlement;
  const startedAt = Date.now();
  // SIGINT 单一出口：只置位；等待器感知后在这里统一输出中断结果并退出 130。
  let interrupted = false;
  const onSigint = () => { interrupted = true; };
  process.on("SIGINT", onSigint);
  // 等待器的读器缝：daemon 握手 SSOT 在 adapters 层，与 runs wait 同款注入。
  const seatDeps = {
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    ...(deps.resolveDetailedFn ? { resolveDetailedFn: deps.resolveDetailedFn } : {}),
    ...(deps.readTranscript ? { readTranscriptFn: deps.readTranscript } : {}),
    ...(deps.nowFn ? { nowFn: deps.nowFn } : {}),
    ...(deps.sleepFn ? { sleepFn: deps.sleepFn } : {}),
    ...(deps.verifierGoneFn ? { verifierGoneFn: deps.verifierGoneFn } : {}),
    verifierProofDeps: {
      nowFn: deps.nowFn ?? Date.now,
      handshakeReader: readHandshakeDetailed,
      daemonAliveFn: isDaemonAlive,
      ...(deps.verifierProofDeps ?? {}),
    },
  };
  const seatName = (seat) => `${seat.agentId} (${seat.runId})`;
  const failExit = (seat, outcome) => {
    process.exitCode = outcome.kind === "conflict" ? 4 : 3;
    const lines = [`[consult] ${consultId}: seat ${seatName(seat)} will not settle:`];
    if (outcome.kind === "conflict") {
      lines.push(`Conflict: ${seat.runId} has multiple distinct transcript copies — refusing to pick one.`);
      lines.push(`Diagnostics: wao runs diagnose ${seat.runId}`);
    } else if (outcome.kind === "verifier_gone") {
      lines.push(`Stuck: the verification of ${seat.runId} has no outcome and no WAO process that could finish it remains (${outcome.basis}); waiting will not change this.`);
      lines.push(`Next step: ${buildNextStep({
        surface: "cli",
        situation: "verifier_gone",
        runId: seat.runId,
        acceptanceStatus: outcome.settlement.facts.acceptanceStatus,
      })}`);
    } else if (outcome.reason.startsWith("undeterminable:")) {
      lines.push(`Undeterminable: the delivery facts cannot settle (${outcome.reason.slice("undeterminable:".length)}); waiting will not change them.`);
      lines.push(`Diagnostics: wao runs diagnose ${seat.runId}; delivery facts: wao runs delivery ${seat.runId}`);
    } else {
      lines.push(`Untrusted: ${SETTLEMENT_MAX_UNTRUSTED_ROUNDS} consecutive rounds could not be trusted (last: ${outcome.reason}).`);
      lines.push(`Diagnostics: wao runs diagnose ${seat.runId}`);
    }
    for (const line of lines) console.error(line);
    if (asJson) {
      console.log(JSON.stringify({
        consultId,
        settled: false,
        seat: { agentId: seat.agentId, runId: seat.runId },
        ...(outcome.kind === "conflict" ? { conflict: true } : {}),
        ...(outcome.kind === "verifier_gone" ? { reason: "verifier_gone", basis: outcome.basis } : {}),
        ...(outcome.kind === "untrusted" && outcome.reason.startsWith("undeterminable:")
          ? { reason: outcome.reason, state: outcome.settlement.facts.state }
          : {}),
        ...(outcome.kind === "untrusted" && !outcome.reason.startsWith("undeterminable:")
          ? { reason: outcome.reason, untrustedRounds: outcome.rounds }
          : {}),
      }, null, 2));
    }
  };
  const interruptedExit = (seat) => {
    process.exitCode = 130;
    console.error(`[consult] ${consultId}: interrupted before seat ${seatName(seat)} settled`);
    if (asJson) {
      console.log(JSON.stringify({
        consultId, settled: false, interrupted: true, seat: { agentId: seat.agentId, runId: seat.runId },
      }, null, 2));
    }
  };
  try {
    for (const seat of dispatched) {
      if (interrupted) {
        interruptedExit(seat);
        return;
      }
      const outcome = await waitFn({
        runId: seat.runId,
        runDir,
        label: "consult wait",
        progress: (line) => {
          // 与 runs wait 同一出血面：文本模式进度写 stdout；JSON 模式进度写
          // stderr，stdout 只留最终 JSON。
          if (asJson) console.error(line);
          else console.log(line);
        },
        isInterrupted: () => interrupted,
        deps: seatDeps,
      });
      // 与 runs wait 同纪律：置位后只输出一份中断结果，中断压过同轮的冲突等出口。
      if (outcome.kind === "interrupted" || interrupted) {
        interruptedExit(seat);
        return;
      }
      if (outcome.kind !== "settled") {
        failExit(seat, outcome);
        return;
      }
    }
    if (interrupted) {
      // 全部收口之后、返回渲染之前被置位：与 runs wait 同纪律——只输出中断结果。
      interruptedExit(dispatched[dispatched.length - 1] ?? { agentId: "?", runId: "?" });
      return;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
  const result = await rerenderConsultFromRecord({
    record,
    runDir,
    consultsDir: recordDir,
    ...(deps.readTranscript ? { readTranscriptFn: deps.readTranscript } : {}),
    env: process.env,
  });
  emitConsultWaitResult({
    consultId,
    result,
    format: asJson ? "json" : "text",
    allTerminal: true,
    waitedMs: Date.now() - startedAt,
    windowMs: null,
  });
}

// TD-319：用法页的行数组是单一事实源——CONSULT_USAGE（join 形，help 打印用）
// 与未知子命令报错（linesError 显式带出各行，用法页的多行不被当一行转义）同源。
export const CONSULT_USAGE_LINES = [
  "consult run <briefFile> --seats a,b [--perspective <agentId>=<file>]... [--fields Q1=A,B]... [--reviewed-run <runId>] [--wait-timeout MS] [--format json|text] [--cwd DIR] [--registry FILE] [--run-dir DIR]",
  "consult show <consultId> [--seat <agentId> [--out FILE] | --out-dir DIR] [--format json|text] [--cwd DIR] [--run-dir DIR]",
  "consult wait <consultId> [--wait-ms MS | --until-settled] [--format json|text] [--cwd DIR] [--run-dir DIR]",
  "",
  "  --fields        key is Q<n>, the question number in the brief; a declared value matches only as a whole token",
  "                  (letters, digits and _ are word characters; at the same position the longest declared value wins).",
  "                  CJK text has no word boundaries: do not declare a value that is part of another word a seat may write.",
  "  --wait-timeout  how long `run` waits for the seats, 180000-600000 ms (default 600000). When it expires the seats",
  "                  keep running. The consult id is printed on stderr as soon as the seats are dispatched:",
  "                  `consult wait <id>` waits again (--wait-ms 180000-600000, default 270000, repeatable),",
  "                  `consult show <id>` reads the current state.",
  "  --until-settled wait until every dispatched seat's run settles (mutually exclusive with --wait-ms, takes no value).",
  "                  Exit 0 when every seat settles; 3 when a seat cannot settle (untrusted reads, undeterminable",
  "                  delivery facts, or its verifier is gone); 4 on a transcript conflict. Seats whose dispatch",
  "                  produced no run are not waited for. The failing seat is named on stderr.",
  "  --seat --out    write one seat's complete final text to a file (without --out: print it)",
  "  --out-dir DIR   write every seat's complete final text to DIR/<agentId>.md (directory created if missing), one",
  "                  line per seat; mutually exclusive with --seat/--out",
];
export const CONSULT_USAGE = CONSULT_USAGE_LINES.join("\n");

/**
 * `wao consult` 派遣器。deps 参数仅供测试注入（runConsult/loadConsultRecord/
 * waitForConsult/readTranscript/writeFileSync），生产调用（cli.js）不传。
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
  if (sub === "wait") {
    await consultWaitCommand(rest, config, deps);
    return;
  }
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(CONSULT_USAGE);
    return;
  }
  throw linesError([`consult: unknown subcommand "${sub}"`, ...CONSULT_USAGE_LINES]);
}
