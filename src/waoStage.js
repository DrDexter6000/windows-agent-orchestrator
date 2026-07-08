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
 * 新增一条阶段声明。原子地建正文 + 更新 map 索引。
 * @param {string} waoDir
 * @param {{stage: number, task: string, artifacts?: string[], note?: string}} data
 * @returns {Promise<string>} 正文文件路径
 * @throws {Error} stage 不在 STAGE_NUMBERS 枚举内，或 task 为空
 */
export async function addStage(waoDir, { stage, task, artifacts, note }) {
  if (!STAGE_NUMBERS.includes(stage)) {
    throw new Error(
      `stage 必须是 [${STAGE_NUMBERS.join(", ")}] 之一，got "${stage}"。` +
      `阶段编号用枚举不用自由文本，防 Lead 跳号或自造阶段逃避 pipeline 门控。`
    );
  }
  if (!task || !task.trim()) {
    throw new Error("stage --task 不能为空——声明要让 pipeline 进度可见，task 是可见性的核心。");
  }

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
    note ? `## Note\n${note}\n` : "",
  ].filter((l) => l !== "").join("\n");
  await writeFile(filePath, (content.endsWith("\n") ? content : content + "\n"), "utf8");

  // map 索引行（pipeline/map.md，与 ADR/DECL 索引行视觉区分：STAGE 前缀 + 阶段号）
  const artifactsSummary = artifactList.length > 0 ? artifactList[0].slice(0, 40) : "(无产物)";
  await appendMapIndex(join(pipelineDir, "map.md"),
    `STAGE | ${stage} | ${task.slice(0, 50)} | ${artifactsSummary}`);

  return filePath;
}

/**
 * 列出所有阶段声明（从 pipeline/map.md 读 STAGE 行）。
 * @returns {Promise<Array<{stage: number, task: string, artifact: string}>>}
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
    };
  });
}

/**
 * 统计阶段声明（供 dashboard 聚合——让 pipeline 进度可见）。
 * 返回每个阶段是否已声明 + 已声明阶段数。
 * @returns {Promise<{declared: Set<number>, stages: Array<{stage, task, artifact}>, count: number}>}
 */
export async function summarizeStages(waoDir) {
  const stages = await listStages(waoDir);
  const declared = new Set(stages.map((s) => s.stage));
  return { declared, stages, count: stages.length };
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
