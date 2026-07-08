/**
 * .wao/decisions/ 下的 Lead 自做声明（declare）读写。
 *
 * 背景（TD-82）：dogfood 反复观察到 Lead 倾向"自己包揽"而非派工——不是不信
 * worker，而是 WAO 控制平面看不见 Lead 的非 WAO 工具调用（Edit/Write/Bash 不产
 * transcript），所以"自做"零摩擦、"派发"高摩擦，默认行为永远选摩擦最小的路。
 *
 * declare 的强制力 = 曝光（可见），不是拦截。Lead 仍全权可自做，但自做一个本可
 * 派发的任务时必须声明，让自做行为对用户和 dashboard 可见。声明存进 .wao/pipeline/
 * 槽位（TD-91：与 decisions/ 的 ADR 分离——DECL 是运行时声明，decisions 是冻结决策）。
 *
 * REASON_CODES 是理由码的权威枚举（SSOT），SKILL.md 和 docs-consistency 守卫指向它。
 * 改这个数组 = 同步改 SKILL 文档 + 守卫测试。
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * 理由码权威枚举（SSOT）。SKILL.md 的派工章节必须与此一致
 * （test/docs-consistency.test.js 守卫）。
 *
 * 每个 code = Lead 把可派任务留给自己做的合法理由。
 * 选择是克制的：覆盖真实场景，但不开放自由文本（防逃避——自由文本让"声明"
 * 退化成"写句话"，失去枚举的约束力）。
 */
export const REASON_CODES = [
  "too-coupled",            // 与其他改动强耦合，拆开会返工
  "too-small",              // 派工开销 > 任务本身
  "high-constitutional-risk", // 触及项目宪法/公共契约，逐行审边界成本不低于自做
  "verification-cheaper",   // 验收比派工还省
  "needs-global-context",   // 需要只有 Lead 有的全局上下文
  "user-assigned",          // 用户明确指派 Lead 自做（非 Lead 自主偏离派工默认）
];

/** DECL- 文件名前缀（与 ADR 的 NNNN- 区分）。 */
const DECL_PREFIX = "DECL-";

/**
 * 新增一条 Lead 自做声明。原子地建正文 + 更新 map 索引。
 * @param {string} waoDir
 * @param {{task: string, reason: string, note?: string}} data
 * @returns {Promise<string>} 正文文件路径
 * @throws {Error} reason 不在 REASON_CODES 枚举内
 */
export async function addDeclare(waoDir, { task, reason, note }) {
  if (!REASON_CODES.includes(reason)) {
    throw new Error(
      `declare reason 必须是枚举值之一 [${REASON_CODES.join(", ")}]，got "${reason}"。` +
      `理由码用枚举不用自由文本，防"声明"退化成"写句话"失去约束力。`
    );
  }
  if (!task || !task.trim()) {
    throw new Error("declare --task 不能为空——声明要让自做行为可见，task 是可见性的核心。");
  }

  const pipelineDir = join(waoDir, "pipeline");
  const ts = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15); // YYYYMMDDTHHMM
  const slug = slugify(task);
  const fileName = `${DECL_PREFIX}${ts}-${slug}.md`;
  const filePath = join(pipelineDir, fileName);

  // 正文（带结构化 frontmatter，便于 dashboard 聚合解析）
  const content = [
    `---`,
    `type: declare`,
    `task: ${JSON.stringify(task)}`,
    `reason: ${reason}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `---`,
    ``,
    `# Lead 自做声明: ${task}`,
    ``,
    `**理由**: \`${reason}\` — ${REASON_DESC[reason]}`,
    ``,
    note ? `## Note` : "",
    note ? note : "",
    note ? "" : "",
  ].filter((l) => l !== "").join("\n");
  await writeFile(filePath, (content.endsWith("\n") ? content : content + "\n"), "utf8");

  // map 索引行（pipeline/map.md，与 ADR/STAGE 索引行视觉区分：DECL 前缀）
  await appendMapIndex(join(pipelineDir, "map.md"),
    `DECL | ${task.slice(0, 50)} | ${reason}`);

  return filePath;
}

/**
 * 列出所有 declare 声明（从 pipeline/map.md 读 DECL 行）。
 * @returns {Promise<Array<{task: string, reason: string}>>}
 */
export async function listDeclares(waoDir) {
  const mapPath = join(waoDir, "pipeline", "map.md");
  let map = "";
  try { map = await readFile(mapPath, "utf8"); } catch { return []; }
  const lines = map.split("\n").filter((l) => /^DECL\s*\|/.test(l));
  return lines.map((l) => {
    const parts = l.split("|").map((s) => s.trim());
    return { task: parts[1] ?? "", reason: parts[2] ?? "" };
  });
}

/**
 * 统计 declare 声明（供 dashboard 聚合）。
 * @returns {Promise<{count: number, byReason: Object<string,number>}>}
 */
export async function summarizeDeclares(waoDir) {
  const declares = await listDeclares(waoDir);
  const byReason = {};
  for (const d of declares) {
    byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
  }
  return { count: declares.length, byReason };
}

/** REASON_CODES 的中文描述（正文渲染用，不参与枚举校验）。 */
const REASON_DESC = {
  "too-coupled": "与其他改动强耦合，拆开会返工",
  "too-small": "派工开销 > 任务本身",
  "high-constitutional-risk": "触及项目宪法/公共契约",
  "verification-cheaper": "验收比派工还省",
  "needs-global-context": "需要只有 Lead 有的全局上下文",
  "user-assigned": "用户明确指派 Lead 自做（非自主偏离派工）",
};

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
