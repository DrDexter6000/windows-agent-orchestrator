/**
 * .wao/ 目录管理（S3-1，阶段 3）。
 *
 * 定位：项目状态外化的物理基础。每个被 WAO 管理的项目有一个 .wao/ 目录，
 * 必需槽位 6 个（project.md/decisions/pipeline/handoff/runs/migration），
 * 另有可选槽位 inbox 与 state（决定 0094：state 随 workflow 层退役，历史布局放行）。
 * agent 不直接建文件，通过 wao 命令读写，本模块提供底层目录操作。
 *
 * 布局的三条保证：
 *   1. 顶层槽位封闭：6 必需 + 可选 inbox/state（validateWaoDir 负向断言多余文件）
 *   2. map.md 只放索引（waoDecisions 的写入命令保证）
 *   3. 除 decisions/ 外都在 .gitignore 里（过程性，不进版本控制）
 *
 * 决定 0111：`.wao/` 拆成两个目录视角——决定目录（decisions/，getWaoDir，
 * 随分支提交留在检出）与状态目录（其余槽位，getWaoStateDir；链接工作树里
 * 重定向到主工作树）。主检出上两者是同一个目录，行为不变。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { mainWorktreeRoot, productionProjectIo } from "./projectIdentity.js";

// 锁死的 6 个顶层槽位。新增槽位是架构变更，需同步改 waoLayout.test.js 守卫。
// TD-91：pipeline/ 槽位——STAGE-/DECL- 运行时声明专用，与 decisions/（ADR 冻结决策）分离。
// 原先 STAGE/DECL 写进 decisions/（被 git 跟踪），实验声明和真实 ADR 混在一起污染版本库。
// 0045 §4.2：migration=台账迁移证据包槽（.wao/migration/0045-ledger/，证据文件入库）。
export const WAO_TOP_LEVEL_SLOTS = ["project.md", "decisions", "pipeline", "handoff", "runs", "migration"];

// 可选顶层槽位：inbox 是机器本地报缺陷收件箱，由 `feedback submit` 按需创建；
// state 是 workflow 层的旧布局（决定 0094 退役）。两者都不在 `wao init` 预建
// （init 后仍只有上面 6 个槽位），validateWaoDir 对它们放行但不要求存在
// （missing 只查必需槽位）。
export const WAO_OPTIONAL_TOP_LEVEL_SLOTS = ["inbox", "state"];

// decisions/pipeline/handoff 有 map.md（索引），project.md 是单文件，runs 无 map。
const SLOTS_WITH_MAP = ["decisions", "pipeline", "handoff"];

// 决定 0111：状态目录槽位（decisions 随分支提交留在决定目录，其余落状态目录）。
const STATE_SLOTS = ["project.md", "pipeline", "handoff", "runs", "migration"];

/**
 * 解析 .wao/ 路径。
 * @param {string} cwd 项目根
 * @param {string} [override] --state-dir 覆盖值（默认 ".wao"）
 */
export function getWaoDir(cwd, override) {
  return resolve(cwd, override ?? ".wao");
}

/**
 * 解析 .wao 本地状态目录（决定 0111）：链接工作树里除 decisions/ 外的本地
 * 状态落到主工作树（决定目录仍取 getWaoDir——decisions 随分支提交留在工作树）。
 * @param {string} cwd 项目根
 * @param {{explicit?: string, configured?: string}} [opts]
 *   explicit：命令行显式给的 --state-dir（非空时按 cwd 解析，不重定向）；
 *   configured：配置里的 stateDir（src/cli.js 默认 ".wao"）——只提供名字，
 *   不算显式覆盖（默认值重定向、显式值不重定向）。
 * @param {object} [io] mainWorktreeRoot 的 io（缺省生产读函数）
 */
export function getWaoStateDir(cwd, { explicit, configured } = {}, io = productionProjectIo()) {
  if (typeof explicit === "string" && explicit.length > 0) {
    return resolve(cwd, explicit);
  }
  return resolve(mainWorktreeRoot(resolve(cwd), io), configured ?? ".wao");
}

/**
 * 初始化 .wao/ 骨架。幂等：重复 init 不破坏已有内容。
 * 创建 6 个必需槽位 + 各 map.md 空文件 + project.md 骨架 + 追加 .wao/ 到 .gitignore。
 * 可选槽位（inbox/state）不预建。
 *
 * 决定 0111：收两个显式目录——decisions/ 建、查在决定目录（随分支提交），
 * 其余槽位在状态目录（链接工作树里=主工作树）；两者相同时（主检出/显式
 * --state-dir）行为与拆分前完全一样。.gitignore 照旧写在 cwd。
 * @param {string} cwd 项目根（.gitignore 落点）
 * @param {string} decisionsDir 决定目录（getWaoDir 的结果）
 * @param {string} stateDir 状态目录（getWaoStateDir 的结果）
 */
export async function initWaoDir(cwd, decisionsDir, stateDir) {
  await mkdir(decisionsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  // decisions/ 槽位在决定目录。
  {
    const slotDir = join(decisionsDir, "decisions");
    await mkdir(slotDir, { recursive: true });
    const mapPath = join(slotDir, "map.md");
    if (!existsSync(mapPath)) {
      await writeFile(mapPath, MAP_HEADER.decisions, "utf8");
    }
  }
  // 其余槽位在状态目录。
  for (const slot of STATE_SLOTS) {
    if (slot === "project.md") {
      const pPath = join(stateDir, "project.md");
      if (!existsSync(pPath)) {
        await writeFile(pPath, PROJECT_TEMPLATE, "utf8");
      }
    } else {
      const slotDir = join(stateDir, slot);
      await mkdir(slotDir, { recursive: true });
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
 * 扫一个目录的槽位形状：missing=必需槽位缺哪些，unexpected=允许集之外的条目
 * （可选槽位 inbox/state 放行）。目录读不了=全部必需槽位缺失（与拆分前语义
 * 一致：读失败不猜、按缺报）。
 */
function scanSlots(dir, required) {
  let actual = [];
  try {
    actual = readdirSync(dir);
  } catch {
    return { missing: [...required], unexpected: [] };
  }
  const allowed = new Set([...WAO_TOP_LEVEL_SLOTS, ...WAO_OPTIONAL_TOP_LEVEL_SLOTS]);
  const unexpected = actual.filter((entry) => !allowed.has(entry));
  const missing = required.filter((slot) => !actual.includes(slot));
  return { missing, unexpected };
}

/**
 * 校验 .wao/ 结构完整性（决定 0111：决定目录与状态目录两个显式目录）。
 * 两者相同（主检出/显式 --state-dir）→ 单目录全槽位校验，与拆分前逐字节同义；
 * 两者不同（链接工作树重定向）→ decisions/ 在决定目录查，其余必需槽位在
 * 状态目录查，missing/unexpected 合并上报。
 * @param {string} decisionsDir 决定目录（getWaoDir 的结果）
 * @param {string} stateDir 状态目录（getWaoStateDir 的结果）
 * @returns {{ok: boolean, initialized: boolean, missing: string[], unexpected: string[]}}
 *   - 未 init：{ok:false, initialized:false}
 *   - init 但结构坏：{ok:false, initialized:true, missing/unexpected 非空}
 *   - 合法：{ok:true, initialized:true, missing/unexpected 空}
 */
export function validateWaoDir(decisionsDir, stateDir) {
  if (decisionsDir === stateDir) {
    if (!existsSync(decisionsDir)) {
      return { ok: false, initialized: false, missing: [], unexpected: [] };
    }
    const { missing, unexpected } = scanSlots(decisionsDir, WAO_TOP_LEVEL_SLOTS);
    const ok = missing.length === 0 && unexpected.length === 0;
    return { ok, initialized: true, missing, unexpected };
  }
  const decisionsExists = existsSync(decisionsDir);
  const stateExists = existsSync(stateDir);
  if (!decisionsExists && !stateExists) {
    return { ok: false, initialized: false, missing: [], unexpected: [] };
  }
  const decisions = decisionsExists
    ? scanSlots(decisionsDir, ["decisions"])
    : { missing: ["decisions"], unexpected: [] };
  const state = stateExists
    ? scanSlots(stateDir, STATE_SLOTS)
    : { missing: [...STATE_SLOTS], unexpected: [] };
  const missing = [...decisions.missing, ...state.missing];
  const unexpected = [...decisions.unexpected, ...state.unexpected];
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
  decisions: `# Decisions Map

<!-- 索引：ADR 冻结决策（NNNN-*.md）。一行一条，不放正文。随代码版本化。 -->
<!-- 格式：<编号> | <标题> | <一句话> -->
<!-- TD-91：STAGE/DECL 运行时声明已挪到 pipeline/，本目录只留 ADR。 -->
`,
  pipeline: `# Pipeline Map

<!-- 索引：STAGE/DECL 运行时声明。一行一条，不放正文。gitignore（每轮临时）。 -->
<!-- 格式：STAGE | <n> | <task> | <artifact> [| panel=seats:<ids> 或 panel=skip:<code>]  或  DECL | <task> | <reason> -->
<!-- panel 第 5 列（决策 0023，R9 加性）：三席会审席位/跳过理由摘要；无 panel 的旧行 4 列照常解析。 -->
`,
  handoff: `# Handoff Map

<!-- 索引：所有交接卡。一行一条，不放正文。 -->
<!-- 格式：<role>-<date> | from→to | <一句话> -->
`,
};

/**
 * 追加 .wao/ gitignore 规则到目标项目（幂等）。
 *
 * TD-94（复盘 #2）：写三行规则——.wao/* 忽略全部 + !.wao/decisions/ 例外入库。
 * 不能只写裸 .wao/（会连 decisions/ ADR 一起忽略，违背 SKILL "decisions/ 随代码版本化" 契约）。
 * 幂等检查：检测 !.wao/decisions/（精确规则），而非 .wao/ 子串（裸 .wao/ 和 .wao/* 都含它）。
 */
async function ensureGitignore(cwd) {
  const giPath = join(cwd, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(giPath, "utf8");
  } catch {
    // 不存在，新建
  }
  // 幂等：已含精确规则就不追加（检测 !.wao/decisions/，不检测 .wao/ 子串）
  if (existing.includes("!.wao/decisions/")) return;

  const rules = ".wao/*\n!.wao/decisions/\n";
  const addition = existing.length > 0 && !existing.endsWith("\n")
    ? `\n${rules}`
    : `${existing}${rules}`;
  await writeFile(giPath, addition, "utf8");
}
