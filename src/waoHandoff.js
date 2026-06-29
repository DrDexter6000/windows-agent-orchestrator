/**
 * .wao/handoff/ 读写（S3-4，阶段 3）。
 *
 * 多 agent 交接卡：每个 agent 完成时写一张，下游读最新的接手。
 * 传引用不传内容（artifacts 是路径引用，不是 messages 全文）——照架构 spec §5.2。
 *
 * 文件名：<from>-<date>.md（同 role 多次交接按日期区分）
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * 写一张交接卡。
 * @param {string} waoDir
 * @param {{from: string, to: string, summary: string, artifacts?: string[], claims?: Array}} data
 * @returns {Promise<string>} 交接卡路径
 */
export async function writeHandoff(waoDir, { from, to, summary, artifacts = [], claims = [] }) {
  const handoffDir = join(waoDir, "handoff");
  const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15); // 20260623T143000
  const fileName = `${from}-${ts}.md`;
  const filePath = join(handoffDir, fileName);

  const lines = [
    `# Handoff: ${from} → ${to} (${ts})`,
    ``,
    `## Summary`,
    summary,
    ``,
    `## Artifacts (传引用不传内容)`,
    ...(artifacts.length > 0 ? artifacts.map((a) => `- ${a}`) : ["(none)"]),
    ``,
    `## Claims (结构化，供 gate 校验)`,
    ...(claims.length > 0
      ? claims.map((c) => `- field: ${c.field}, value: ${c.value}`)
      : ["(none)"]),
    ``,
  ];
  await writeFile(filePath, lines.join("\n"), "utf8");

  // map 索引（写完正文后更新）
  await appendMapIndex(join(handoffDir, "map.md"),
    `${from}-${ts} | ${from}→${to} | ${summary.slice(0, 60)}`);

  return filePath;
}

/**
 * 读发给某 role 的最新交接卡（按 heading 时间戳降序取第一个）。
 * @param {string} waoDir
 * @param {string} role 如 "lead"
 * @returns {Promise<string|null>} 交接卡正文，无则 null
 */
export async function readHandoff(waoDir, role) {
  const handoffDir = join(waoDir, "handoff");
  let files = [];
  try { files = await readdir(handoffDir); } catch { return null; }
  const cards = [];
  for (const file of files.filter((f) => f.endsWith(".md") && f !== "map.md")) {
    const body = await readFile(join(handoffDir, file), "utf8");
    const parsed = parseHandoffHeading(body);
    if (parsed?.to === role) {
      cards.push({ ...parsed, file, body });
    }
  }
  cards.sort((a, b) => {
    const byTs = b.ts.localeCompare(a.ts);
    return byTs !== 0 ? byTs : b.file.localeCompare(a.file);
  });
  return cards[0]?.body ?? null;
}

function parseHandoffHeading(body) {
  const match = body.match(/^# Handoff:\s*(.*?)\s*→\s*(.*?)\s*\(([^)]+)\)/m);
  if (!match) return null;
  return {
    from: match[1].trim(),
    to: match[2].trim(),
    ts: match[3].trim(),
  };
}

async function appendMapIndex(mapPath, line) {
  let existing = "";
  try { existing = await readFile(mapPath, "utf8"); } catch {}
  const addition = existing.endsWith("\n") || existing.length === 0
    ? `${existing}${line}\n`
    : `${existing}\n${line}\n`;
  await writeFile(mapPath, addition, "utf8");
}
