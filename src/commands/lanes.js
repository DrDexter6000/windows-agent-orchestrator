// src/commands/lanes.js
//
// 0064（2026-10-12）：`wao lanes` —— 车道画像只读查询面（Owner 初心四组件的
// "暴露面"落地：接线轴 + Owner 画像 + 认证简表 + 就绪探测一屏，各栏带来源；
// 事实陈列、零排序零推荐——语义判断归 Lead，不变量 4/6）。
// 0065（0045 §1.2 终局）：seatRole 声明列删除（席位角色维退役）。
//
// 会审裁定（consult_202610121021490657ur8lp 双席 P1 全采纳）：
//   - 探测复用 commands/onboarding.js 导出的同一份 probeCliOnPath/probeKeyEnvSource
//     （不复制第二套实现）；就绪口径=buildRecommendations 同引擎（onboarding 面同源）。
//   - registry 单次读取：inventory（认证）/探测输入/接线轴全部同源
//     （readRegistryFn 注入记忆化结果），防两次读取拼出前后不一致的状态。
//   - --registry 防跨绑（同 run 命令规则）：单独非默认 --registry 拒绝（仓库
//     车道表 × 外来 registry 的静默混拼是本规则要防的形状）；与 --lanes-file
//     成对显式给出时放行 + 横幅注记（操作员显式声明两侧权威，测试/嵌入面同用）。
//   - 车道表权威失败（结构非法/不可读）≠ 成功的空面：报告 issue、exitCode 1、
//     不渲染正常车道面。
//   - 本文件不出现画像文件名字面量（隔离守卫白名单只含
//     src/application/laneProfile.js）；画像路径经视图对象的 traitsPath 字段
//     展示。画像加载器经 lanesView.js 的 re-export 取得（0087 守卫边：
//     本文件不准直接引用 laneProfile.js）。

import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { readRegistry } from "../registry.js";
import { loadLanesConfig } from "../dispatchResolution.js";
import { getRegistryInventoryWithIssues } from "../application/registryInventory.js";
import { buildRecommendations, displayWidth, wrapDisplay as wrapLines } from "../application/onboarding.js";
import { buildLanesView, readLaneTraits } from "../application/lanesView.js";
import { probeCliOnPath, probeKeyEnvSource, probeKimiTokenFile } from "./onboarding.js";

function parseOptions(args) {
  const options = { json: false, registry: undefined, lanesFile: undefined, runDir: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") options.json = true;
    else if (a === "--registry") options.registry = args[++i];
    else if (a === "--lanes-file") options.lanesFile = args[++i];
    else if (a === "--run-dir") options.runDir = args[++i];
    else throw new Error(`wao lanes: unknown option "${a}"（支持：--json / --registry FILE / --lanes-file FILE / --run-dir DIR）`);
  }
  return options;
}

const axesLabel = (a) => `${a.backend ?? "?"}/${a.modelId ?? "?"}/${a.providerID ?? "-"}/${a.effort ?? "null"}`;

const RATINGS_STATE_LINES = {
  current: "评分状态: 当前（打分身份与车道表一致，无待复核标记）",
  unrated: "评分状态: 未评（七格全未评——未评不折算成任何星数）",
  unknown: "评分状态: 无法判定（车道侧事实不可得）",
};

function renderLane(row, width, dimensionLabels) {
  const body = width - 4; // 缩进 4 后的可用宽
  const lines = [];
  const emit = (label, value) => {
    const first = `${label}: ${value}`;
    if (displayWidth(first) <= body) {
      lines.push(`  ${first}`);
      return;
    }
    lines.push(`  ${label}:`);
    for (const seg of wrapLines(value, body - 2)) lines.push(`    ${seg}`);
  };
  lines.push(`lane ${row.id} — ${row.backend ?? "?"} · ${row.modelId ?? "?"} · effort ${row.effort ?? "null"} · 推断族系 ${row.family}`);
  // TD-283：Owner 的暂停派发说明（车道表自带，与接线状态无关）——只告知不拦截。
  if (row.dispatchHold) emit("dispatchHold", `${row.dispatchHold}（Owner 暂停说明，仅提示不拦截——派发决定权在 Lead）`);
  if (row.wiring === "wired") lines.push("  接线: 一致（lanes.json 声明与 registry 接线四轴相符）");
  else if (row.wiring === "drift") {
    emit("接线", `漂移——explicit 派发将拒绝：declared(${axesLabel(row.wiringDetail.declared)}) ≠ registry(${axesLabel(row.wiringDetail.registry)})`);
  } else if (row.wiring === "invalid") lines.push("  接线: 条目无效（registry 条目无法解析——认证/就绪跳过；见尾部 issues）");
  else lines.push(`  接线: 未接线（registry 无键 ${row.id}——认证/就绪跳过）`);

  if (row.traitsState === "present") {
    const t = row.traits;
    // 0087：七项分项星级（星数/依据/measured 附 n；note 与 evidence 折行）。
    lines.push("  评分（刻度见表头）:");
    for (const dim of Object.keys(dimensionLabels)) {
      const cell = t.ratings[dim];
      if (cell.stars === null) {
        lines.push(`    ${dimensionLabels[dim]}: 未评`);
        continue;
      }
      lines.push(`    ${dimensionLabels[dim]}: ${cell.stars} 星（${cell.basis}${cell.basis === "measured" ? `，n=${cell.n}` : ""}）`);
      if (cell.note !== undefined) {
        for (const seg of wrapLines(`note: ${cell.note}`, body - 6)) lines.push(`      ${seg}`);
      }
      if (cell.evidence !== undefined) {
        for (const seg of wrapLines(`evidence: ${cell.evidence}`, body - 6)) lines.push(`      ${seg}`);
      }
    }
    if (row.ratingsState === "review") {
      lines.push("  评分状态: 待复核——");
      for (const r of row.reviewReasons) {
        for (const seg of wrapLines(r, body - 4)) lines.push(`    ${seg}`);
      }
    } else {
      lines.push(`  ${RATINGS_STATE_LINES[row.ratingsState] ?? `评分状态: ${row.ratingsState}`}`);
    }
    emit("成本", t.cost ?? "未提供");
    if (t.caveats.length > 0) {
      lines.push("  注意事项:");
      for (const c of t.caveats) {
        for (const seg of wrapLines(`- ${c}`, body - 4)) lines.push(`    ${seg}`);
      }
    } else {
      lines.push("  注意事项: 无");
    }
    emit("context", `${t.contextWindow.tokens} tokens${t.contextWindow.shape ? `（${t.contextWindow.shape}）` : ""} [source: ${t.contextWindow.source}]`);
    emit("multimodal", `image=${t.multimodal.image ? "是" : "否"} video=${t.multimodal.video ? "是" : "否"} [source: ${t.multimodal.source}]`);
    if (t.effortNote) emit("effortNote", t.effortNote);
    if (t.concurrencyNote) emit("concurrency", t.concurrencyNote);
  } else if (row.traitsState === "absent") lines.push("  画像: 未提供（画像文件无该车道键）");
  else if (row.traitsState === "invalid") lines.push("  画像: 形状错误（见尾部 issues）");
  else lines.push("  画像: 文件不可读");

  if (row.wiring === "wired" || row.wiring === "drift") {
    if (row.certification === null) {
      lines.push("  certification: 未取得匹配认证（原因未区分：无记录/身份不匹配/台账缺失或不可读）");
    } else {
      lines.push(`  certification: ${row.certification}${row.certificationLastHealthyAt ? `（lastHealthy ${row.certificationLastHealthyAt}）` : ""}`);
    }
    lines.push(`  readyState: ${row.readyState ?? "—（无探测行）"}`);
    // 决定 0074：kimiHome 车道就绪按 token 文件推导——人读面点名路径（去哪看）。
    if (row.readyTokenFile) {
      lines.push(`  credential: token 文件 ${row.readyTokenFile}（kimiHome 车道凭据=server.token；缺失或为空=未就绪；doctor 同查此文件）`);
    }
  }
  return lines;
}

export async function lanesCommand(args, config) {
  const options = parseOptions(args);

  // 防跨绑成对规则（0064 裁定，语义同 run 命令的 lanesEnabled——单独外来
  // registry 拒绝；与显式车道表成对=操作员声明拼接，放行并注记）。
  const defaultRegistryPath = resolve(config?.registry ?? "config/agents.json");
  const registryPath = options.registry !== undefined ? resolve(options.registry) : defaultRegistryPath;
  const registryIsDefault = registryPath === defaultRegistryPath;
  const explicitPairing = !registryIsDefault && options.lanesFile !== undefined;
  if (!registryIsDefault && options.lanesFile === undefined) {
    throw new Error(
      "wao lanes: 非默认 --registry 需与 --lanes-file 成对显式给出（车道表与接线防跨绑，规则同 run 命令）。",
    );
  }

  // registry 单次读取：inventory / 探测输入 / 接线轴同源。
  const reg = await readRegistry(registryPath);
  const registryAgents = Object.fromEntries(reg.listAgents().map((a) => [a.id, a]));
  const rawAgents = Object.fromEntries(reg.rawEntries());
  const runDir = resolve(options.runDir ?? config?.runDir ?? "runs");
  const inventory = await getRegistryInventoryWithIssues({
    registryPath,
    runDir,
    readRegistryFn: async () => reg,
    readFileFn: (p) => readFile(p, "utf8"),
  });

  const lanesDoc = options.lanesFile !== undefined
    ? loadLanesConfig(resolve(options.lanesFile))
    : loadLanesConfig();
  const traitsResult = readLaneTraits();

  // 就绪轴：探测权威只吃 registry 有效条目 ∩ 车道键（wired+drift 均探测——
  // drift 条目本身合法，就绪事实属于 registry 侧；未接线/无效无行）。
  const laneIdSet = new Set((Array.isArray(lanesDoc.lanes) ? lanesDoc.lanes : [])
    .map((l) => l?.id).filter((id) => typeof id === "string"));
  const candidates = (inventory.agents ?? [])
    .filter((a) => laneIdSet.has(a.id))
    .map((a) => ({ id: a.id, backend: a.backend, model: null }));
  const ready = await buildRecommendations(
    candidates, { agents: rawAgents },
    { hasCli: probeCliOnPath, hasKeyEnv: probeKeyEnvSource, hasKimiTokenFile: probeKimiTokenFile },
    { source: "configured", sortReadyFirst: false },
  );

  const view = buildLanesView({
    lanesDoc, traitsResult, inventory, registryAgents, readyRows: ready.rows,
  });

  if (options.json) {
    const payload = { ...view, registryPath, ...(explicitPairing ? { explicitPairing: true } : {}) };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const width = 120;
    const out = [];
    out.push("wao lanes — 车道一屏参考（只读；事实陈列，非推荐）");
    if (explicitPairing) out.push("  注记: 显式拼接面——非默认 registry 与显式车道表成对给出（防跨绑规则的放行形）");
    for (const [k, v] of Object.entries(view.sourceNotes)) {
      for (const seg of wrapLines(`${k}: ${v}`, width - 2)) out.push(`  ${seg}`);
    }
    out.push(`  lanes.json sha256=${view.lanesSha256 ?? "null"}；画像文件 ${view.traitsPath ?? "(路径未知)"} sha256=${view.traitsSha256 ?? "null"}`);
    // 0087：表头显示一次刻度（各车道的星级都对着它读）。
    if (view.traitsScale) {
      for (const seg of wrapLines(`刻度: ${view.traitsScale}`, width - 2)) out.push(`  ${seg}`);
    }
    if (view.state === "ok" && view.lanes.length === 0) {
      out.push(`  ${view.lanesStateNote}`);
    }
    if (view.state !== "ok") {
      out.push("");
      out.push(`车道表不可用（${view.state === "lanes_invalid" ? "结构非法" : "不可读"}）——不渲染正常车道面：`);
      for (const i of view.issues) out.push(`  - ${i}`);
    } else {
      for (const row of view.lanes) {
        out.push("");
        out.push(...renderLane(row, width, view.dimensionLabels));
      }
      if (view.issues.length > 0) {
        out.push("");
        out.push(`issues（${view.issues.length}）:`);
        for (const i of view.issues) out.push(`  - ${i}`);
      }
    }
    console.log(out.join("\n"));
  }
  if (view.state !== "ok") process.exitCode = 1;
}
