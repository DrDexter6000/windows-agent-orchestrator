/**
 * .wao/decisions/ 读写（S3-3，阶段 3）。
 *
 * ADR（Architecture Decision Records）风格：每条决策一个自包含文件，
 * map.md 只放索引。append-only（决策不删不改，新决策覆盖旧的话新开一条）。
 *
 * 命令强制（决策2=C）：agent 通过 wao decision add 写入，本模块保证
 * 正文 + map 原子一致（先写正文，后更新 map；map 写完即一致）。
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * 新增一条决策。原子地建正文 + 更新 map 索引。
 * @param {string} waoDir
 * @param {{title: string, body: string, context?: string}} data
 * @returns {Promise<string>} 正文文件路径
 */
export async function addDecision(waoDir, { title, body, context }) {
  const decisionsDir = join(waoDir, "decisions");
  const nextId = await nextDecisionId(decisionsDir);
  const slug = slugify(title);
  const fileName = `${nextId}-${slug}.md`;
  const filePath = join(decisionsDir, fileName);

  // 正文（ADR 格式）
  const content = [
    `# ${nextId}: ${title}`,
    `status: accepted`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `## Context`,
    context ?? "(未提供)",
    ``,
    `## Decision`,
    body,
    ``,
    `## Consequences`,
    "(待补)",
    ``,
  ].join("\n");
  await writeFile(filePath, content, "utf8");

  // map 索引行（正文写完后再写 map，保证一致）。
  // 只放编号 + 标题，不放 body 摘要（body 是正文，进正文文件，不进索引——渐进式披露）。
  await appendMapIndex(join(decisionsDir, "map.md"),
    `${nextId} | ${title}`);

  return filePath;
}

/**
 * 列出所有决策索引（从 map 读，不扫正文——渐进式披露）。
 * @returns {Promise<string[]>} 索引行数组
 */
export async function listDecisions(waoDir) {
  const mapPath = join(waoDir, "decisions", "map.md");
  let map = "";
  try { map = await readFile(mapPath, "utf8"); } catch { return []; }
  return map.split("\n").filter((l) => /^\d{4}\s*\|/.test(l));
}

/**
 * 读单条决策正文。
 * @param {string} waoDir
 * @param {string} id 如 "0001"
 */
export async function readDecision(waoDir, id) {
  const decisionsDir = join(waoDir, "decisions");
  const files = await readdir(decisionsDir);
  const match = files.find((f) => f.startsWith(`${id}-`));
  if (!match) throw new Error(`decision ${id} not found`);
  return readFile(join(decisionsDir, match), "utf8");
}

/** 扫现有正文取最大编号，返回下一个（0001, 0002...） */
async function nextDecisionId(decisionsDir) {
  let files = [];
  try { files = await readdir(decisionsDir); } catch {}
  const nums = files
    .map((f) => parseInt(f.slice(0, 4), 10))
    .filter((n) => !Number.isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return String(max + 1).padStart(4, "0");
}

function slugify(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "decision";
}

async function appendMapIndex(mapPath, line) {
  let existing = "";
  try { existing = await readFile(mapPath, "utf8"); } catch {}
  const addition = existing.endsWith("\n") || existing.length === 0
    ? `${existing}${line}\n`
    : `${existing}\n${line}\n`;
  await writeFile(mapPath, addition, "utf8");
}
