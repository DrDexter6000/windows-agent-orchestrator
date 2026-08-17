/**
 * .wao/decisions/ 下的 Lead 阶段声明（stage）读写。
 *
 * 背景（TD-83）：dogfood 反复观察到 Lead 倾向"敷衍"——只派一次 worker（通常是
 * researcher）然后自己把剩下全干完，跳过 spec/plan/汇总/总结等编排产物。根因是
 * SKILL.md 的"职责链"是散文建议，阶段 1/2/5/6 没有任何产物 gate，跳过 = 隐形。
 *
 * stage 把散文职责链升级为"6 阶段产物门控 pipeline"。强制力 = 曝光（可见），不是拦截。
 * Lead 仍全权可跳过任意阶段，但每走完一个阶段必须 `wao stage <n>` 声明，让 pipeline
 * 进度对用户/dashboard 可见。跳过阶段会在 dashboard 留缺口（[1]spec — 而非 ✓）。
 *
 * 与 declare 的关系：declare 管"派工 vs 自做"，stage 管"走了 pipeline 哪几步"。
 * 两者正交——stage 声明的产物本身就是 Lead 的编排工作（spec/plan/summary），
 * 属合法自做，不需要 declare；stage 不替代 declare 管 leaf 活的自做。
 *
 * 产物正文不进 .wao/（违反 SSOT：spec 是契约要进版本控制，.wao/ 在 gitignore）。
 * stage 声明只存元数据 + artifacts 路径指针，指向 docs/ 或 runs/<runId>.jsonl。
 * 声明存进 .wao/pipeline/ 槽位（TD-91：与 decisions/ 的 ADR 分离——STAGE 是运行时声明，
 * decisions 是冻结决策）。用 STAGE- 前缀与 DECL- 区分。
 *
 * STAGE_NUMBERS 是阶段编号的权威枚举（SSOT），SKILL.md 和 docs-consistency 守卫指向它。
 * 改这个数组 = 同步改 SKILL 文档 + 守卫测试。
 *
 * R9（决策 0023，三席会审产品化）：stage 2/4 可携带 panel 记录（--panel-seats
 * 自报副审 / --panel-skip-reason 跳过理由闭集码）。Advisory 非门禁：无 panel
 * 照常落盘，命令层输出 panelAdvisory 提示；PANEL_SKIP_REASONS 是理由码 SSOT。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 阶段定义（SSOT）。SKILL.md 的职责链章节必须与此一致
 * （test/docs-consistency.test.js 守卫）。
 *
 * 每个 stage = pipeline 的一步，顺序固定（理解→编排→派发→验收→汇总→总结）。
 * 编号是枚举不用自由文本，防 Lead 跳号或自造阶段逃避门控。
 */
export const STAGE_NUMBERS = [1, 2, 3, 4, 5, 6];

/** STAGE_NUMBERS 的中文描述（正文渲染 + dashboard 用，不参与枚举校验）。 */
export const STAGE_DESC = {
  1: "任务理解（spec/PRD）",
  2: "任务编排（TDD plan + worker 分工）",
  3: "任务派发（执行 + 监督）",
  4: "交付验收（放行 / 打回）",
  5: "交付物汇总",
  6: "自审自检 + 总结报告",
};

/** STAGE- 文件名前缀（与 ADR 的 NNNN- 和 DECL- 区分）。 */
const STAGE_PREFIX = "STAGE-";

/**
 * 三席会审跳过理由码的权威闭集（SSOT，R9/决策 0023）。SKILL/docs/cliHelp 的
 * 表述与 docs-consistency 守卫都 import 本数组对账，不复制值指纹（TD-120）。
 * 细节差异（如 provider 临时不可用）进 --note，不扩闭集。
 */
export const PANEL_SKIP_REASONS = Object.freeze([
  "no_reviewer_available", // 环境里配不齐副审（onboarding/doctor 的 panel 提示可佐证）
  "low_risk_small_task",   // 小任务/低风险（0023 允许的显式豁免）
  "time_critical",         // 时延敏感，会审成本不可接受
  "owner_direct",          // Owner 明示跳过
]);

/**
 * 可登记 panel 字段的阶段闭集：方案（2）与交付物验收（4）——0023 的两节点限定。
 * 措辞注意：panel 字段只在这两个阶段登记 ≠ 会审只能发生一次/不可多轮；
 * 同一 stage 允许多条 panel 记录（返工/窄复核的真实形状）。
 */
export const PANEL_STAGES = Object.freeze([2, 4]);

/**
 * 新增一条阶段声明。原子地建正文 + 更新 map 索引。
 *
 * R9（决策 0023）：stage 2/4 可携带 panel 记录（会审席位自报或跳过理由）——
 * 强烈推荐但非门禁：无 panel 字段照常落盘（命令层给 panelAdvisory 提示）。
 * 同一 stage 多次声明即多条记录（无唯一性校验）。
 *
 * @param {string} waoDir
 * @param {{stage: number, task: string, artifacts?: string[], note?: string,
 *          panel?: {seats?: string[], skipReason?: string}}} data
 *   panel.seats：一名或多名自报席位（命令层已做 registry 存在性校验；自报
 *     语义，本层不加 ≥2 张数校验——R9-C C-13 措辞修正）；
 *   panel.skipReason：跳过理由，必须在 PANEL_SKIP_REASONS 闭集内。两者互斥。
 * @returns {Promise<string>} 正文文件路径
 * @throws {Error} stage 不在 STAGE_NUMBERS 枚举内、task 为空、panel 带非法
 *   形状（闭集外 skip 码 / 非 2|4 阶段 / seats 与 skipReason 同给）
 */
export async function addStage(waoDir, { stage, task, artifacts, note, panel }) {
  if (!STAGE_NUMBERS.includes(stage)) {
    throw new Error(
      `stage 必须是 [${STAGE_NUMBERS.join(", ")}] 之一，got "${stage}"。` +
      `阶段编号用枚举不用自由文本，防 Lead 跳号或自造阶段逃避 pipeline 门控。`
    );
  }
  if (!task || !task.trim()) {
    throw new Error("stage --task 不能为空——声明要让 pipeline 进度可见，task 是可见性的核心。");
  }
  assertPanelShape(stage, panel);

  const pipelineDir = join(waoDir, "pipeline");
  const ts = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15); // YYYYMMDDTHHMM
  const slug = slugify(task);
  const fileName = `${STAGE_PREFIX}${stage}-${ts}-${slug}.md`;
  const filePath = join(pipelineDir, fileName);

  // 正文（带结构化 frontmatter，便于 dashboard 聚合解析）
  const artifactList = Array.isArray(artifacts) ? artifacts : [];
  const content = [
    `---`,
    `type: stage`,
    `stage: ${stage}`,
    `task: ${JSON.stringify(task)}`,
    panel?.seats ? `panel_seats: ${JSON.stringify(panel.seats)}` : "",
    panel?.skipReason ? `panel_skip_reason: ${panel.skipReason}` : "",
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `---`,
    ``,
    `# 阶段 ${stage} 声明: ${task}`,
    ``,
    `**阶段**: ${stage} — ${STAGE_DESC[stage]}`,
    ``,
    artifactList.length > 0
      ? `## Artifacts（产物路径指针，传引用不传内容）\n${artifactList.map((a) => `- ${a}`).join("\n")}`
      : `_（本阶段无外部产物文件——派发/验收阶段的证据在 runs/<runId>.jsonl）_`,
    ``,
    panel?.seats
      ? `## Panel（三席会审记录，决策 0023）\n副审席位（自报、未验证）: ${panel.seats.join(" + ")}。` +
        `评审旁证（transcript 路径）走上方 Artifacts；席位记录是证据不是验收。`
      : "",
    panel?.skipReason
      ? `## Panel（会审跳过登记，决策 0023）\nskip 理由码: \`${panel.skipReason}\`（闭集值）。`
      : "",
    // R9-C C-8：stage 4 红线句落盘（此前只在 stdout 瞬时输出——评审意见是证据
    // 不是验收的持久化补齐；panel 与无 panel 两种 stage 4 正文都固定写入）。
    stage === 4
      ? `## 红线（0019 §5 / 0023）\n评审意见是证据不是验收；run_delivery_decide 只由 Lead 调用。`
      : "",
    note ? `## Note\n${note}\n` : "",
  ].filter((l) => l !== "").join("\n");
  await writeFile(filePath, (content.endsWith("\n") ? content : content + "\n"), "utf8");

  // map 索引行（pipeline/map.md，与 ADR/DECL 索引行视觉区分：STAGE 前缀 + 阶段号）。
  // panel 摘要为加性第 5 列；无 panel 的旧行照常 4 列解析（向后兼容）。
  const artifactsSummary = artifactList.length > 0 ? artifactList[0].slice(0, 40) : "(无产物)";
  const panelSummary = panel?.seats
    ? ` | panel=seats:${panel.seats.join("+")}`
    : panel?.skipReason ? ` | panel=skip:${panel.skipReason}` : "";
  await appendMapIndex(join(pipelineDir, "map.md"),
    `STAGE | ${stage} | ${task.slice(0, 50)} | ${artifactsSummary}${panelSummary}`);

  return filePath;
}

/** panel 形状校验（两节点限定优先 + 闭集 + 互斥；addStage 服务层契约）。 */
function assertPanelShape(stage, panel) {
  if (!panel) return;
  const hasSeats = Array.isArray(panel.seats) && panel.seats.length > 0;
  const hasSkip = typeof panel.skipReason === "string" && panel.skipReason.length > 0;
  // 两节点限定先于其余校验——错阶段带 panel 时文案必须是本句（R9 契约）。
  if ((hasSeats || hasSkip) && !PANEL_STAGES.includes(stage)) {
    throw new Error(
      `panel 字段只在方案（2）/交付物验收（4）登记，got stage ${stage}。` +
      `（0023 两节点限定；同一阶段允许多条记录，返工/窄复核照常再登记。）`
    );
  }
  if (hasSeats && hasSkip) {
    throw new Error("--panel-seats 与 --panel-skip-reason 互斥——登记了会审席位就不是跳过。");
  }
  if (!hasSeats && !hasSkip) {
    throw new Error('panel 形状非法：需要 {seats:[...]} 或 {skipReason:"..."} 之一。');
  }
  if (hasSkip && !PANEL_SKIP_REASONS.includes(panel.skipReason)) {
    throw new Error(
      `--panel-skip-reason 必须是闭集值之一 [${PANEL_SKIP_REASONS.join(", ")}]，got "${panel.skipReason}"。` +
      `理由码用枚举防"登记"退化成自由文本；细节差异（如 provider 临时不可用）进 --note。`
    );
  }
  if (hasSeats) {
    for (const seat of panel.seats) {
      if (typeof seat !== "string" || !seat.trim()) {
        throw new Error("--panel-seats 的每个席位必须是 registry 里的 worker id（非空字符串）。");
      }
    }
  }
}

/** map 索引行第 5 列 panel 摘要 → 结构化对象（旧行无该列 → null）。 */
function parsePanelSummary(text) {
  const s = String(text ?? "").trim();
  if (s.startsWith("panel=seats:")) {
    return { seats: s.slice("panel=seats:".length).split("+").map((x) => x.trim()).filter(Boolean) };
  }
  if (s.startsWith("panel=skip:")) {
    return { skipReason: s.slice("panel=skip:".length).trim() };
  }
  return null;
}

/**
 * 列出所有阶段声明（从 pipeline/map.md 读 STAGE 行）。
 * @returns {Promise<Array<{stage: number, task: string, artifact: string,
 *   panel: {seats: string[]}|{skipReason: string}|null}>>}
 */
export async function listStages(waoDir) {
  const mapPath = join(waoDir, "pipeline", "map.md");
  let map = "";
  try { map = await readFile(mapPath, "utf8"); } catch { return []; }
  const lines = map.split("\n").filter((l) => /^STAGE\s*\|/.test(l));
  return lines.map((l) => {
    const parts = l.split("|").map((s) => s.trim());
    return {
      stage: Number(parts[1]) || 0,
      task: parts[2] ?? "",
      artifact: parts[3] ?? "",
      panel: parsePanelSummary(parts[4]),
    };
  });
}

/**
 * 统计阶段声明（供 dashboard 聚合——让 pipeline 进度可见）。
 * 返回每个阶段是否已声明 + 已声明阶段数 + panel 分布（R9：席位记录数与
 * skip 理由分布，仿 declare 的 byReason）。
 * @returns {Promise<{declared: Set<number>, stages: Array<object>, count: number,
 *   panel: {records: number, seatsRecords: number, bySkipReason: Object<string, number>}}>}
 */
export async function summarizeStages(waoDir) {
  const stages = await listStages(waoDir);
  const declared = new Set(stages.map((s) => s.stage));
  const seatsRecords = stages.filter((s) => s.panel?.seats).length;
  const bySkipReason = {};
  for (const s of stages) {
    if (s.panel?.skipReason) {
      bySkipReason[s.panel.skipReason] = (bySkipReason[s.panel.skipReason] ?? 0) + 1;
    }
  }
  return {
    declared,
    stages,
    count: stages.length,
    panel: {
      records: stages.filter((s) => s.panel).length,
      seatsRecords,
      bySkipReason,
    },
  };
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "task";
}

async function appendMapIndex(mapPath, line) {
  let existing = "";
  try { existing = await readFile(mapPath, "utf8"); } catch {}
  const addition = existing.endsWith("\n") || existing.length === 0
    ? `${existing}${line}\n`
    : `${existing}\n${line}\n`;
  await writeFile(mapPath, addition, "utf8");
}
