// src/commands/lanes.js
//
// 0064（2026-10-12）：`wao lanes` —— 车道画像只读查询面（Owner 初心四组件的
// "暴露面"落地：接线轴 + Owner 画像 + 认证简表 + 就绪探测一屏，各栏带来源；
// 事实陈列、零排序零推荐——语义判断归 Lead，不变量 4/6）。
// 0065（0045 §1.2 终局）：seatRole 声明列删除（席位角色维退役）。
// 153 批：默认一屏只报例外（接线一致/评分当前/无注意事项/常态行不占行），
// 审计出处（evidence/source/sha256）收进 --evidence；额度池结构化（quotaPool
// ——共用额度一行、成本行带池名）；"只陈列、不推荐"只在标题行说一次。
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
import { buildLanesView, readLaneTraits, peakNowAt, beijingNowLabel, HOLIDAYS_NOTE } from "../application/lanesView.js";
import { probeCliOnPath, probeKeyEnvSource, probeKimiTokenFile } from "./onboarding.js";
// TD-318（三）：车道表/画像/registry/台账值是磁盘上的不可信文本——join 前逐行
// 转义，值里的换行不能再伪造一行（core 顶层叶子，commands 下向 import）。
import { escapeControlChars } from "../safeText.js";

function parseOptions(args) {
  const options = { json: false, evidence: false, registry: undefined, lanesFile: undefined, runDir: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") options.json = true;
    else if (a === "--evidence") options.evidence = true;
    else if (a === "--registry") options.registry = args[++i];
    else if (a === "--lanes-file") options.lanesFile = args[++i];
    else if (a === "--run-dir") options.runDir = args[++i];
    else throw new Error(`wao lanes: unknown option "${a}"（支持：--json / --evidence / --registry FILE / --lanes-file FILE / --run-dir DIR）`);
  }
  return options;
}

const axesLabel = (a) => `${a.backend ?? "?"}/${a.modelId ?? "?"}/${a.providerID ?? "-"}/${a.effort ?? "null"}`;

// ── 0097 §5：开头对照表（声明序，不排序）────────────────────────────────────
// 只列三个实测维度（research/code/review）；格写法：实测 `3★ n=8`（152 批起
// 不再折算百分比——计数单位不同不能并排，具体分数见下方逐车道细节）、Owner 评
// `4★ 主观`、未评/无画像 `—`。状态列：暂停（dispatchHold）优先，其次画像缺失
// 或无效，再按 ratingsState 写待复核/未评/无法判定，current 为空。"此刻"列
// （152 批）：只报"世界现在是什么样"（此刻是否在该车道声明的高峰内、到几点，
// 北京时间），不排序不推荐——判断归 Lead（不变量 4/6）。

/** 单格写法（输入视图行里已归一的画像格；无画像给 null → "—"）。 */
function summaryCell(cell) {
  if (cell == null || cell.stars == null) return "—";
  if (cell.basis === "measured") return `${cell.stars}★ n=${cell.n ?? "?"}`;
  if (cell.basis === "owner") return `${cell.stars}★ 主观`;
  return `${cell.stars}★ official`;
}

/** "此刻"列的一格（152 批）：有声明 peak 的写状态与下一边界（显示规则共用
 *  peakNowAt 的 untilLocal：同一天不带星期、跨天带星期），没声明的写 —。 */
function peakCell(traits, nowMs) {
  if (!traits || traits.peak === undefined) return "—";
  const now = peakNowAt(traits.peak, nowMs);
  if (now == null) return "—";
  return `${now.state === "peak" ? "高峰" : "非高峰"}，至 ${now.untilLocal}`;
}

/** 状态列的一词事实：画像状态（traitsState 不是 present）与评分状态
 *  （ratingsState）各一张闭集表；"没评过"不写成"待复核"。 */
const SUMMARY_TRAITS_STATUS = { absent: "无画像", invalid: "画像无效", unreadable: "画像不可读" };
const SUMMARY_RATINGS_STATUS = { review: "待复核", unrated: "未评", unknown: "无法判定" };

/** 状态列：暂停（dispatchHold）优先，其次画像状态，再次评分状态。 */
function summaryStatus(row) {
  if (row.dispatchHold) return "暂停";
  if (row.traitsState !== "present") return SUMMARY_TRAITS_STATUS[row.traitsState] ?? "";
  return SUMMARY_RATINGS_STATUS[row.ratingsState] ?? "";
}

/** 显示宽感知的右补空格（中文字符占 2 列，用 displayWidth 对齐）。 */
function padDisplayEnd(text, width) {
  const w = displayWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

/** 对照表（含表头）：每行 = 车道 | 族系 | 写代码 | 把关 | 调研 | 成本档 | 此刻 | 状态。 */
function renderSummaryTable(rows, nowMs) {
  const header = ["车道", "族系", "写代码", "把关", "调研", "成本档", "此刻", "状态"];
  const table = rows.map((row) => {
    const t = row.traits;
    return [
      row.id,
      row.family ?? "—",
      summaryCell(t ? t.ratings.code : null),
      summaryCell(t ? t.ratings.review : null),
      summaryCell(t ? t.ratings.research : null),
      t && t.costTier != null ? String(t.costTier) : "—",
      peakCell(t, nowMs),
      summaryStatus(row),
    ];
  });
  const widths = header.map((h, i) => Math.max(
    displayWidth(h),
    ...table.map((cells) => displayWidth(cells[i])),
  ));
  const fmt = (cells) => "  " + cells.map((c, i) => padDisplayEnd(c, widths[i])).join("  ").trimEnd();
  return [
    "车道对照表（只列三个实测维度，其余见下方；行序=声明序）:",
    // 152 批：表头上方的"此刻"行——读表用的当前北京时间（法定节假日不识别）。
    // 156 批修正一：节假日口径引用 laneProfile.HOLIDAYS_NOTE（与 laneRules 同一常量）。
    `  此刻：北京时间 ${beijingNowLabel(nowMs)}（${HOLIDAYS_NOTE}）`,
    fmt(header),
    ...table.map(fmt),
    "  格：星级、n=样本量；主观=Owner 评；—=无评分（未评或画像不可用）；此刻列 —=车道未声明高峰时段",
  ];
}

const RATINGS_STATE_LINES = {
  current: "评分状态: 当前（打分身份与车道表一致，无待复核标记）",
  unrated: "评分状态: 未评（七格全未评——未评不折算成任何星数）",
  unknown: "评分状态: 无法判定（车道侧事实不可得）",
};

/** 153 修正一：共用额度块——一池一行（不按 120 列硬折，车道名不再被劈开）。
 *  只列两条及以上车道共用的池；池序=池内第一条车道的声明序，池内车道按声明
 *  序。没有共用池返回 null（整块不写）。 */
function sharedQuotaPoolsBlock(rows) {
  const poolOrder = [];
  const byPool = new Map();
  for (const row of rows) {
    const pool = row.traits?.quotaPool;
    if (typeof pool !== "string") continue;
    if (!byPool.has(pool)) {
      byPool.set(pool, []);
      poolOrder.push(pool);
    }
    byPool.get(pool).push(row.id);
  }
  const shared = poolOrder.filter((p) => byPool.get(p).length >= 2);
  if (shared.length === 0) return null;
  return [
    "共用额度:",
    ...shared.map((p) => `${p}：${byPool.get(p).join("、")}`),
  ];
}

// 153 批：细节只列例外（常态不占行）；evidence/source/sha256 是审计出处，
// 收进 --evidence。行序与各行内容不变，只少掉"人人一样"的行。
function renderLane(row, width, dimensionLabels, evidence) {
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
  // TD-283：Owner 的暂停派发说明（车道表自带，与接线状态无关）——只写原话；
  // "只告知不拦截"这层意思由 sourceNotes.dispatchHold 说一次（153 批）。
  if (row.dispatchHold) emit("dispatchHold", row.dispatchHold);
  // 153 批：接线一致是常态不占行；漂移、条目无效、未接线照旧写。
  if (row.wiring === "drift") {
    emit("接线", `漂移——explicit 派发将拒绝：declared(${axesLabel(row.wiringDetail.declared)}) ≠ registry(${axesLabel(row.wiringDetail.registry)})`);
  } else if (row.wiring === "invalid") lines.push("  接线: 条目无效（registry 条目无法解析——认证/就绪跳过；见尾部 issues）");
  else if (row.wiring === "unwired") lines.push(`  接线: 未接线（registry 无键 ${row.id}——认证/就绪跳过）`);

  if (row.traitsState === "present") {
    const t = row.traits;
    // 153 批：没评的维度不各占一行，合成一行"未评: …"；七格全没评时不铺评分
    // 块（评分状态行已说"未评"）。已评维度照原格式按维度序列出。
    const rated = [];
    const unratedDims = [];
    for (const dim of Object.keys(dimensionLabels)) {
      (t.ratings[dim].stars === null ? unratedDims : rated).push(dim);
    }
    if (rated.length > 0) {
      // 0087：七项分项星级（星数/依据/measured 附 n；note 折行）。
      lines.push("  评分（刻度见表头）:");
      for (const dim of rated) {
        const cell = t.ratings[dim];
        lines.push(`    ${dimensionLabels[dim]}: ${cell.stars} 星（${cell.basis}${cell.basis === "measured" ? `，n=${cell.n}` : ""}${cell.score ? `，${cell.score.hits}/${cell.score.total} ${cell.score.label}` : ""}）`);
        if (cell.note !== undefined) {
          for (const seg of wrapLines(`note: ${cell.note}`, body - 6)) lines.push(`      ${seg}`);
        }
        // 153 批：evidence 是审计出处——默认一屏不印，--evidence 时照旧。
        if (evidence && cell.evidence !== undefined) {
          for (const seg of wrapLines(`evidence: ${cell.evidence}`, body - 6)) lines.push(`      ${seg}`);
        }
      }
    }
    // 153 修正一（会审 FIX_FIRST）：只要有没评的维度就写一行"未评: …"——唯一
    // 例外是评分状态本身就是"未评"（那一行已写明七格全未评）。七格全没评且写了
    // reviewPending 时，待复核与全未评两条事实都要在场，不能只剩待复核。
    if (unratedDims.length > 0 && row.ratingsState !== "unrated") {
      emit("未评", unratedDims.map((d) => dimensionLabels[d]).join("、"));
    }
    // 153 批：评分状态"当前"是常态不占行；待复核、未评、无法判定照旧写。
    if (row.ratingsState === "review") {
      lines.push("  评分状态: 待复核——");
      for (const r of row.reviewReasons) {
        for (const seg of wrapLines(r, body - 4)) lines.push(`    ${seg}`);
      }
    } else if (row.ratingsState !== "current") {
      lines.push(`  ${RATINGS_STATE_LINES[row.ratingsState] ?? `评分状态: ${row.ratingsState}`}`);
    }
    // 153 批：成本行带额度池名（同池车道共用一份额度）。
    emit(t.quotaPool !== undefined ? `成本（${t.quotaPool}）` : "成本", t.cost ?? "未提供");
    // 153 批：没有注意事项不写"注意事项: 无"（只报例外）。
    if (t.caveats.length > 0) {
      lines.push("  注意事项:");
      for (const c of t.caveats) {
        for (const seg of wrapLines(`- ${c}`, body - 4)) lines.push(`    ${seg}`);
      }
    }
    // 153 批：context 与 multimodal 合一行；--evidence 时 source 跟在各自后面。
    emit("上下文", `${t.contextWindow.tokens} tokens${t.contextWindow.shape ? `（${t.contextWindow.shape}）` : ""}${evidence ? ` [source: ${t.contextWindow.source}]` : ""}`
      + ` · 图片 ${t.multimodal.image ? "是" : "否"} · 视频 ${t.multimodal.video ? "是" : "否"}${evidence ? ` [source: ${t.multimodal.source}]` : ""}`);
    if (t.effortNote) emit("effortNote", t.effortNote);
    if (t.concurrencyNote) emit("concurrency", t.concurrencyNote);
  } else if (row.traitsState === "absent") lines.push("  画像: 未提供（画像文件无该车道键）");
  else if (row.traitsState === "invalid") lines.push("  画像: 形状错误（见尾部 issues）");
  else lines.push("  画像: 文件不可读");

  if (row.wiring === "wired" || row.wiring === "drift") {
    // 153 批：认证与就绪合一行；null 的文案收成"无匹配记录"，原因未区分的
    // 解释只在表头 sourceNotes.certification 里说一次。
    const certValue = row.certification === null
      ? "无匹配记录"
      : `${row.certification}${row.certificationLastHealthyAt ? `（lastHealthy ${row.certificationLastHealthyAt}）` : ""}`;
    emit("认证", `${certValue}；就绪: ${row.readyState ?? "—（无探测行）"}`);
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
  // readLaneTraitsFn：测试缝（夹具画像注入；生产路径缺省真实画像）。与
  // loadLanesConfigFn/readRegistry 同一注入纪律。nowMsFn（152 批）：对照表
  // "此刻"的时钟缝；生产缺省 Date.now()。
  const traitsResult = (config?.readLaneTraitsFn ?? readLaneTraits)();
  const nowMs = (config?.nowMsFn ?? Date.now)();

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
    // 153 批：标题行说一次"只陈列、非推荐"与细节口径（细节只列例外、出处收进
    // --evidence）——表头各注记不再重复这层意思。
    out.push("wao lanes — 车道一屏参考（只读；事实陈列，非推荐；细节只列例外，出处加 --evidence）");
    if (explicitPairing) out.push("  注记: 显式拼接面——非默认 registry 与显式车道表成对给出（防跨绑规则的放行形）");
    // 0097 §5：开头先打一屏对照表（声明序，不排序），表后列成本档说明、共用
    // 额度与 Owner 规则，再接原有细节。车道表不可用时不渲染（对照无从对照）。
    if (view.state === "ok") {
      out.push("");
      out.push(...renderSummaryTable(view.lanes, nowMs));
      if (view.costTierScale) {
        // 说明串自带"成本档：…"前缀——直接列出，不加第二个标签。
        for (const seg of wrapLines(view.costTierScale, width - 2)) out.push(`  ${seg}`);
      }
      // 153 批：额度池结构化——共用额度块（一池一行，只列两条及以上的池），
      // 在成本档说明之后、Owner 规则之前；没有共用池时整块不写。
      const poolsBlock = sharedQuotaPoolsBlock(view.lanes);
      if (poolsBlock) {
        out.push(`  ${poolsBlock[0]}`);
        for (const line of poolsBlock.slice(1)) out.push(`    ${line}`);
      }
      if (Array.isArray(view.ownerRules)) {
        out.push("  Owner 规则（排在前面的优先）:");
        if (view.ownerRules.length === 0) out.push("    无");
        for (const rule of view.ownerRules) {
          for (const seg of wrapLines(`- ${rule}`, width - 4)) out.push(`    ${seg}`);
        }
      }
      out.push("");
    }
    for (const [k, v] of Object.entries(view.sourceNotes)) {
      for (const seg of wrapLines(`${k}: ${v}`, width - 2)) out.push(`  ${seg}`);
    }
    // 153 批：出处（sha256 与画像路径）收进 --evidence，默认一屏不印。
    if (options.evidence) {
      out.push(`  lanes.json sha256=${view.lanesSha256 ?? "null"}；画像文件 ${view.traitsPath ?? "(路径未知)"} sha256=${view.traitsSha256 ?? "null"}`);
    }
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
        out.push(...renderLane(row, width, view.dimensionLabels, options.evidence));
      }
      if (view.issues.length > 0) {
        out.push("");
        out.push(`issues（${view.issues.length}）:`);
        for (const i of view.issues) out.push(`  - ${i}`);
      }
    }
    // TD-318（三）：每行元素在 join 前转义——程序自身的换行只来自 join，元素
    // 内部（配置来源值）的控制字符一律可见化。--json 不经此路径。
    console.log(out.map(escapeControlChars).join("\n"));
  }
  if (view.state !== "ok") process.exitCode = 1;
}
