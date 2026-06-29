/**
 * .wao/ 目录管理（S3-1，阶段 3）。
 *
 * 定位：项目状态外化的物理基础。每个被 WAO 管理的项目有一个 .wao/ 目录，
 * 结构锁死为 5 个槽位（project/state/decisions/handoff/runs）。
 * agent 不直接建文件，通过 wao 命令读写，本模块提供底层目录操作。
 *
 * 三条铁律的物理保障：
 *   1. 只有 5 个顶层槽位（validateWaoDir 负向断言多余文件）
 *   2. map.md 只放索引（waoDecisions/waoState 的写入命令保证）
 *   3. .wao/ 进 .gitignore（过程性，不进版本控制）
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// 锁死的 5 个顶层槽位。新增槽位是架构变更，需同步改 waoLayout.test.js 守卫。
export const WAO_TOP_LEVEL_SLOTS = ["project.md", "state", "decisions", "handoff", "runs"];

// state/decisions/handoff 有 map.md（索引），project.md 是单文件，runs 无 map。
const SLOTS_WITH_MAP = ["state", "decisions", "handoff"];

/**
 * 解析 .wao/ 路径。
 * @param {string} cwd 项目根
 * @param {string} [override] --state-dir 覆盖值（默认 ".wao"）
 */
export function getWaoDir(cwd, override) {
  return resolve(cwd, override ?? ".wao");
}

/**
 * 初始化 .wao/ 骨架。幂等：重复 init 不破坏已有内容。
 * 创建 5 槽位 + 各 map.md 空文件 + project.md 骨架 + 追加 .wao/ 到 .gitignore。
 */
export async function initWaoDir(cwd, override) {
  const waoDir = getWaoDir(cwd, override);
  await mkdir(waoDir, { recursive: true });

  // 各目录槽位
  for (const slot of WAO_TOP_LEVEL_SLOTS) {
    if (slot === "project.md") {
      const pPath = join(waoDir, "project.md");
      if (!existsSync(pPath)) {
        await writeFile(pPath, PROJECT_TEMPLATE, "utf8");
      }
    } else {
      const slotDir = join(waoDir, slot);
      await mkdir(slotDir, { recursive: true });
      // state 多一个 history 子目录
      if (slot === "state") {
        await mkdir(join(slotDir, "history"), { recursive: true });
      }
      // 当前 current.md（state 专属）
      if (slot === "state") {
        const cur = join(slotDir, "current.md");
        if (!existsSync(cur)) await writeFile(cur, "", "utf8");
      }
      // map.md（有索引的槽位）
      if (SLOTS_WITH_MAP.includes(slot)) {
        const mapPath = join(slotDir, "map.md");
        if (!existsSync(mapPath)) {
          await writeFile(mapPath, MAP_HEADER[slot], "utf8");
        }
      }
    }
  }

  // .gitignore 追加 .wao/（幂等，不重复）
  await ensureGitignore(cwd);
}

/**
 * 校验 .wao/ 结构完整性。
 * @returns {{ok: boolean, initialized: boolean, missing: string[], unexpected: string[]}}
 *   - 未 init：{ok:false, initialized:false}
 *   - init 但结构坏：{ok:false, initialized:true, missing/unexpected 非空}
 *   - 合法：{ok:true, initialized:true, missing/unexpected 空}
 */
export function validateWaoDir(cwd, override) {
  const waoDir = getWaoDir(cwd, override);
  if (!existsSync(waoDir)) {
    return { ok: false, initialized: false, missing: [], unexpected: [] };
  }
  const missing = [];
  const unexpected = [];
  let actual = [];
  try {
    actual = readdirSync(waoDir);
  } catch {
    return { ok: false, initialized: true, missing: WAO_TOP_LEVEL_SLOTS, unexpected: [] };
  }
  const allowed = new Set(WAO_TOP_LEVEL_SLOTS);
  for (const entry of actual) {
    if (!allowed.has(entry)) unexpected.push(entry);
  }
  for (const slot of WAO_TOP_LEVEL_SLOTS) {
    if (!actual.includes(slot)) missing.push(slot);
  }
  const ok = missing.length === 0 && unexpected.length === 0;
  return { ok, initialized: true, missing, unexpected };
}

const PROJECT_TEMPLATE = `# Project

<!-- 项目背景：目标、边界、技术栈。稳定的，很少改。 -->
<!-- 这个文件是 agent 了解项目全貌的入口。 -->

## Goal
<!-- 这个项目要做什么 -->

## Boundaries
<!-- 做什么 / 不做什么 -->

## Tech Stack
<!-- 关键技术选型 -->
`;

const MAP_HEADER = {
  state: `# State Map

<!-- 索引：历史进度快照。一行一条，不放正文。 -->
<!-- 格式：<date>-<slug> | <workflowId> | <一句话> -->
`,
  decisions: `# Decisions Map

<!-- 索引：所有决策。一行一条，不放正文。渐进式披露。 -->
<!-- 格式：<编号> | <标题> | <一句话> -->
`,
  handoff: `# Handoff Map

<!-- 索引：所有交接卡。一行一条，不放正文。 -->
<!-- 格式：<role>-<date> | from→to | <一句话> -->
`,
};

/** 追加 .wao/ 到 .gitignore（幂等）。 */
async function ensureGitignore(cwd) {
  const giPath = join(cwd, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(giPath, "utf8");
  } catch {
    // 不存在，新建
  }
  if (!existing.includes(".wao/")) {
    const addition = existing.length > 0 && !existing.endsWith("\n")
      ? `\n.wao/\n`
      : `${existing}.wao/\n`;
    await writeFile(giPath, addition, "utf8");
  }
}
