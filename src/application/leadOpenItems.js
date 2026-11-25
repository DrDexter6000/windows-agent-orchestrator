// src/application/leadOpenItems.js
//
// 决定 0113：lead_preflight 的待 Lead 收口事项收集器（应用层只读服务）。
// 回答"哪些事还欠 Lead 一步"，两路来源、各自独立结算：
//
//   A. 运行分支——候选集是绑定工作区所属仓库的 refs/heads/wao/run_* 分支
//      （不按时间窗扫转录：交付运行一定有自己的分支）。回收会删分支，但宿主
//      项目不一定会按期回收（2026-11-25 取证：两个宿主仓库积了三百多条，
//      最旧的未裁定运行早在查看帽之外），所以**全部**分支都参与归类、各行计数
//      是全量——旧的"只看最新若干条"会让最旧的未裁定运行永远看不见。输出仍有
//      界：每行至多点名 OPEN_ITEM_RUNIDS_CAP 个 runId；"等裁决"一行按 runId 内
//      的创建时刻从旧到新排列，并写明最老一条已等几天（从该运行绑定的终态事件
//      时间算，用 transcript 的 findStateEvidence，不另写判法；runId 的创建时刻
//      与 Owner 读模型共用 runBranches.runCreatedAtMs——越界字段/数字 ts 都按
//      "取不到"处理，不猜）。
//      解析逐条、读取有界并发，**读出一条就归类一条**：只有还会走到谱系派生的
//      "收口未裁决且有谱系引用"运行才把转录留到预筛之后，其余归类完即丢（第 147
//      批修正一：300 份 × 4MB 不再同时留在堆里）。
//      分支帽只对**全部 wao/run_* 分支名**计数（与 dispatchResourceAdvisory 同口径，
//      形状不合法的也占帽）；超帽单独一行写总数与上限，不依赖"留待回收"行。
//      逐条核对归属，先看收口判定
//      （determineRunSettlement SSOT）再看裁定（只认绑定本 runId 的
//      run.delivery_accepted / run.delivery_rejected）：
//        - 收口且原因 delivery_settled、未裁定 → 等 Lead 裁定（其中 0112 的
//          deliveryContinuableHint 为 true 的另计数）；第 120 批例外：谱系已
//          显式关闭（根转录有 run.lineage_closed）或已有被采纳的后代
//          （lineageSupersession 的派生事实 supersededByRunId）→ 不再催裁决，
//          计入留待回收（派生事实不写事件、不计入可续计数）；
//        - 终态但验证/reverify 还没结果、未裁定 → 终态未收口（已裁定的除外，
//          按已裁定走留待回收）；
//        - 终态但交付事实判不出收口（undeterminable）→ 单独一行，与"还没
//          结果"分开（事实是"无法判定"，不是"仍在等"）；
//        - 未终态 → 不报（lead_preflight 的活跃运行一节管）；
//        - 已裁定，或收口原因是没有交付/打包失败/隔离失败 → 留待回收。
//      归属口径是**记录的项目身份**（2026-11-05 修订）：转录首事件在档的
//      project 事实优先（identityOfFirstEvent，与 `runs list --project` 同一
//      语义——派发时算好落档，开发树 .dev/wt/<批> 合入后删掉也认得出），
//      没有记录的旧运行由它退回按 cwd 推导；与绑定工作区的身份
//      （identifyProjectFromCwd）比稳定键，两侧都是 kind:"project" 且 key
//      相同才算本项目，否则跳过不计。在档事实损坏（factError 非空）不计入
//      本项目，与转录读不出一起进"找不到或冲突"行。该口径只用于本节的计数
//      与 runId，不改
//      verifyRunWorkspaceOwnership 本身、不改其它工具的归属授权——审查与
//      裁定工具按**调用目标或缺省绑定**核对归属（run_delivery /
//      run_delivery_review 可带 expectedWorkspaceRoot，缺省随绑定；wao runs
//      wait 不收 --cwd），
//      所以"等裁定/终态未收口/无法判定收口"三行在**该行列出的运行里至少有
//      一个派发自与绑定根不同的工作树**时，提示按调用带那棵工作树的根
//      （expectedWorkspaceRoot）再查（或在那棵工作树里跑 CLI）；行内不出现
//      绝对路径。
//      运行树计数同理数整个仓库：`git worktree list --porcelain` 列的是全仓
//      工作树，数所有路径以 `.wao-worktrees/<合法 runId>` 结尾的条目；回收与
//      否以 `wao worktree reclaim` 的只读计划为准，这里只报数。
//   B. 反馈收件箱——仅当绑定工作区与 MCP 服务所在的 WAO 代码检出同属一个
//      项目时（projectIdentity 的现有判定，链接工作树算同一项目——决定 0099；
//      不比路径字符串），数收件箱 open/ 目录里匹配 FEEDBACK_FILE_RE 的文件名。
//      不调 listFeedback（它会整读已处理的历史），不读条目内容。
//
// 转录解析走**统一入口**（两席复核后 Lead 定案）：每条分支调
// resolveTranscriptPathDetailed（src/projectBuckets.js，不抛具名硬错）——
// 决定 0100 规定按 runId 解析要看全部桶，查重才完整；只看个别目录会在同一
// runId 有内容不同的多份副本时静默择一。found 才读转录并分类；conflict /
// unreadable 不分类，与未找到一起计入"找不到或有冲突副本"那一行。
//
// 架构契约：
//   - 只读：零转录写入、零状态变更、零 spawn git 写命令（转录解析经
//     resolveTranscriptPathDetailed 统一入口，只读）；任何来源读失败都不抛
//     ——分支枚举失败给一行固定文案（分支账读不出，不是"没有旧账"），单条
//     转录读不出只计数，收件箱读不出省略该行。
//   - git 只经注入缝 execGitFn（结构化 argv、不经 shell、--no-optional-locks，
//     写法照 serverBuildFacts.js）；文件系统只经 readDirFn/existsSync。
//   - 不读 config/agents.json，不 import src/commands/**、src/mcp/**、SDK、zod。
//   - 每行以 `open item: ` 开头、≤512 字符（src/mcp/server.js 观察行上限），
//     只陈述事实并写明去哪看，不含绝对路径、不含动态错误文本。
//
// 各来源独立结算（决定 0113 第 4 条）：这里的 collectLeadOpenItems 顶层
// try/catch 只是意外兜底；"哪个失败省略哪一行"的语义在两个子收集器里实现。

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { isValidRunId, gitProbeEnv } from "../delivery.js";
import { resolveTranscriptPathDetailed } from "../projectBuckets.js";
import {
  identifyProjectFromCwd,
  identityOfFirstEvent,
  productionProjectIo,
} from "../projectIdentity.js";
import { readTranscript, findStateEvidence, TERMINAL_STATES } from "../transcript.js";
// 第 147 批：分支帽 SSOT 仍在 dispatchResourceAdvisory.js（不另写 60）。修正一：
// 超帽按"全部 wao/run_* 分支名"判（与派发提示同一口径），并且单独一行。
import { BRANCH_CAP } from "../dispatchResourceAdvisory.js";
import { determineRunSettlement } from "./runSettlement.js";
import { deliveryContinuableHint } from "./runContinue.js";
// 第 120 批：谱系派生事实（显式关闭 / 被取代）与交付读面、回收共用同一份实现。
import { createLineageSupersession, declaredLineageRoot, supersessionCandidateGate } from "./lineageSupersession.js";
import { findRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { parseWorktreePorcelain, RECENT_BOUND_EVENT_MS } from "./worktreeReclaim.js";
import {
  RUN_BRANCH_GIT_TIMEOUT_MS,
  WAO_BRANCH_PREFIX,
  listWaoRunBranches,
  runCreatedAtMs,
} from "./runBranches.js";
import { lineageClosedIn } from "./lineageClose.js";
import {
  FEEDBACK_FILE_RE,
  defaultPackageRoot,
  feedbackOpenDir,
  resolveFeedbackInboxDir,
} from "./feedbackInbox.js";

/** 观察行前缀（决定 0113 第 1 条；SKILL 的批次收尾按它找这些行）。 */
export const OPEN_ITEM_PREFIX = "open item: ";
/** 单行上限 = src/mcp/server.js lead_preflight observations 的 z.string().max(512)。 */
export const OPEN_ITEM_MAX_CHARS = 512;
/** 每行至多点名的 runId 个数（决定 0113：个数 + 至多 5 个 runId）。 */
export const OPEN_ITEM_RUNIDS_CAP = 5;
/** 全量分支下转录读取的有界并发：一次最多读这么多份，不一次起几百个读。 */
const TRANSCRIPT_READ_CONCURRENCY = 8;
/** 分支枚举失败时的固定行（不含路径与错误原文；回收命令写成可直接跑的只读形式）。 */
const BRANCH_LEDGER_UNREADABLE =
  `${OPEN_ITEM_PREFIX}the wao/run_* branch ledger could not be read `
  + "(git enumeration failed; this is not \"no old branches\" — check the bound repository with "
  + "`git branch --list \"wao/run_*\"` and `wao worktree reclaim --out <plan.json>`)";

// 只读 git：结构化 argv、--no-optional-locks、不经 shell（serverBuildFacts 写法）。
// env 走 gitProbeEnv()：去掉继承的 GIT_DIR 等定位变量——本收集器问的是绑定工作区
// 自己的仓库，继承的定位变量会让它回答别处。等待有界（不冻住调用线程）。
function defaultExecGit(args, cwd) {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    env: gitProbeEnv(),
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: RUN_BRANCH_GIT_TIMEOUT_MS,
  }).toString();
}

function defaultIdentifyProject(root) {
  return identifyProjectFromCwd(root, productionProjectIo());
}

function defaultInboxDir() {
  return resolveFeedbackInboxDir();
}

// 有界 runId 名单：先取 cap 条，再逐个追加直到装满剩余预算（isValidRunId
// 不限长，单条超长也不至于把行顶破 512）；没进名单的（含 cap 截掉的）折成
// "+N more" 计数。返回 {text, rest}，rest 相对全量 ids。
function joinRunIdsBounded(ids, budget, cap) {
  const shown = [];
  let used = 0;
  for (const id of ids.slice(0, cap)) {
    const piece = `${shown.length > 0 ? ", " : ""}${id}`;
    if (used + piece.length > budget) break;
    shown.push(id);
    used += piece.length;
  }
  return { text: shown.join(", "), rest: ids.length - shown.length };
}

// 路径归一：分隔符统一 + 尾斜杠剥除 + win32 大小写折叠（projectIdentity R2
// 同款）。sameNormalizedPath 只用于"派发自不同工作树"提示（原始 cwd 对绑定
// 根比形状，不 realpath）——归属本身已改按记录的项目身份（见 3b）。
function normalizedPath(p) {
  let s = p.replace(/\\/g, "/");
  if (!/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

function sameNormalizedPath(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  return normalizedPath(a) === normalizedPath(b);
}

// 运行树条目判定：路径以 .wao-worktrees/<合法 runId> 结尾（WAO 隔离树按 runId
// 命名）。全仓口径——不以绑定根为前缀条件（git worktree list 列的是整个仓库
// 的工作树）。
function isRunWorktreeEntry(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  const segs = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return segs.length >= 2
    && segs[segs.length - 2].toLowerCase() === ".wao-worktrees"
    && isValidRunId(segs[segs.length - 1]);
}

// 硬上限兜底：行构造按 ≤512 设计，这里再切一刀防 MCP zod 整体拒绝（缺尾
// 好过整份 preflight 失败）。
function boundedLine(text) {
  return text.length > OPEN_ITEM_MAX_CHARS ? text.slice(0, OPEN_ITEM_MAX_CHARS) : text;
}

/** Date 能表示的最大 epoch ms（±8.64e15）；超出就不是时刻。 */
const MAX_TIME_MS = 8.64e15;

/**
 * ISO 时间串 → epoch ms；不是字符串或读不出 → null（数字 12 绝不落成某个年份）。
 * 与 Owner 读模型的 tsMs 同一口径：字符串、可解析、在 Date 范围内。
 */
function isoTimeMs(ts) {
  if (typeof ts !== "string") return null;
  const value = new Date(ts).getTime();
  return Number.isFinite(value) && Math.abs(value) <= MAX_TIME_MS ? value : null;
}

/**
 * 该运行绑定的终态事件时刻（epoch ms）。终态事件的挑选用 transcript 的
 * findStateEvidence（与 Owner 读模型的 terminalAt 同一判法，不另写一份）；
 * 状态不是终态或事件 ts 不是可解析的 ISO 字符串 → null（调用方不写年龄）。
 */
function boundTerminalEventMs(events, runId) {
  if (!Array.isArray(events)) return null;
  const bound = events.filter((e) => e && e.runId === runId);
  const evidence = findStateEvidence(bound);
  if (evidence.index < 0 || !TERMINAL_STATES.includes(evidence.state)) return null;
  return isoTimeMs(bound[evidence.index]?.ts);
}

/**
 * 按 runId 内的创建时刻从旧到新（第 147 批修正：创建时刻的解析与 Owner 读模型
 * 共用 runBranches.runCreatedAtMs，形状/越界字段对不上就是"时间序不可比"）。
 * 取不到时刻的排在后面，按枚举顺序（新到旧的原顺序）稳定排列。
 */
function sortAwaitingOldestFirst(entries) {
  return [...entries].sort((a, b) => {
    const aAt = runCreatedAtMs(a.runId);
    const bAt = runCreatedAtMs(b.runId);
    if (aAt != null && bAt != null) return aAt - bAt || a.order - b.order;
    if (aAt != null) return -1;
    if (bAt != null) return 1;
    return a.order - b.order;
  });
}

/** 等待天数（向下取整、不为负）；任一时刻取不到 → null。 */
function waitedDays(nowMs, terminalMs) {
  if (!Number.isFinite(nowMs) || terminalMs == null) return null;
  const days = Math.floor((nowMs - terminalMs) / 86_400_000);
  return Number.isFinite(days) ? Math.max(0, days) : null;
}

/** 按枚举顺序排（并发读取/归类会打乱完成顺序，输出仍稳定）。 */
function byEnumerationOrder(ordering) {
  return (a, b) => (ordering.get(a) ?? Number.MAX_SAFE_INTEGER) - (ordering.get(b) ?? Number.MAX_SAFE_INTEGER);
}

/**
 * 有界并发读：保持输入顺序，最多 limit 个读取同时在途（全量分支下不会一次
 * 起几百个读）。读取失败由 readFn 自己收敛（返回 null 占位）。
 */
async function readItemsBounded(items, readFn) {
  const results = new Array(items.length).fill(null);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await readFn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TRANSCRIPT_READ_CONCURRENCY, items.length) }, () => worker()),
  );
  return results;
}

// ── A. 运行分支 ──────────────────────────────────────────────────────────────

/**
 * 枚举绑定仓库的 wao/run_* 分支并按收口/裁定归类，返回 0–6 行。
 * 全部分支参与归类；枚举失败 → 一行固定文案（"分支账读不出"，不再静默省略）。
 */
async function collectRunBranchOpenItems({
  authorizedWorkspaceRoot,
  runDir,
  execGitFn = defaultExecGit,
  resolveTranscriptFn,
  readTranscriptFn = readTranscript,
  // 第 120 批续修（E4）：字节预筛的读缝（测试注入计数用；缺省 node:fs）。
  readBytesFn,
  projectIo = productionProjectIo(),
  parseWorktreePorcelainFn = parseWorktreePorcelain,
  // 第 147 批：年龄用的当前时刻（测试注入；缺省 Date.now）。
  nowFn = Date.now,
  // 测试缝：数得清"为延迟派生保留了几条转录"（生产不注入，零开销）。
  onBranchEventsRetainedFn,
}) {
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) return [];
  const resolvedRunDir = resolve(runDir);

  // 1) 枚举（新到旧；命令与判法在 runBranches.js，与 Owner 看板/派发提示共用同一份
  //    答案）。第 147 批修正一：超帽按**全部分支名**判（与 dispatchResourceAdvisory
  //    同一计数口径——形状不合法的 wao/run_* 分支也占帽）；待办归类只用合法 runId。
  //    读不出 → 固定一行，不静默当作"没有旧账"。
  let branchNames;
  try {
    branchNames = await listWaoRunBranches(execGitFn, authorizedWorkspaceRoot);
  } catch {
    return [boundedLine(BRANCH_LEDGER_UNREADABLE)];
  }
  const total = branchNames.length;
  const runIds = [];
  for (const branch of branchNames) {
    const runId = branch.slice(WAO_BRANCH_PREFIX.length);
    if (isValidRunId(runId)) runIds.push(runId);
  }

  // 2) 转录解析：统一入口 resolveTranscriptPathDetailed（决定 0100——按
  //    runId 解析看全部桶，查重完整；conflict/unreadable 绝不静默择一）。
  //    可注入：注入时完全替代默认实现（返回 detailed 形状，或路径字符串=
  //    found 的便捷形状）。
  const resolveTranscript = typeof resolveTranscriptFn === "function"
    ? resolveTranscriptFn
    : (dir, runId) => resolveTranscriptPathDetailed(dir, runId);

  // 3) 归属基准（0113 修订）：绑定工作区的项目身份，一次算好（生产 io 含
  //    realpath/tmpdir/R8）。判不出（非项目或异常）→ 全跳过（核不了归属就
  //    不归任何类，宁缺勿错）。
  let boundKey = null;
  try {
    const boundIdentity = identifyProjectFromCwd(authorizedWorkspaceRoot, projectIo);
    if (boundIdentity?.kind === "project") boundKey = boundIdentity.key;
  } catch {
    boundKey = null;
  }

  // 等裁决一行只存 {runId, terminalMs, order}——不在内存里留转录（第 147 批修正一）。
  const awaitingDecision = [];
  const terminalUnsettled = [];
  const undeterminable = [];
  // 第 120 批：一次请求内按根缓存的谱系派生（显式关闭 / 被取代）。只在
  // "收口且未裁决"的运行上求值；非续修谱系成员不会派生（没有已证明的后代），
  // 且只有会走到 forRoot 的运行才被收根做全库预筛（第 120 批续修 E1）。
  const supersession = createLineageSupersession({
    runDir: resolvedRunDir,
    readTranscriptFn,
    ...(typeof readBytesFn === "function" ? { readBytesFn } : {}),
  });
  // 跨工作树提示按行跟踪：该行列出的运行里至少有一个派发自与绑定根不同的
  // 工作树时，那行才加提示（审查/裁定工具按会话绑定核对归属）。
  const crossTree = { awaiting: false, unsettled: false, undeterminable: false };
  let reclaimBranches = 0;
  let missingTranscripts = 0;
  let continuable = 0;
  // 枚举顺序（新到旧）：并发读取/归类会打乱完成顺序，输出按它稳定排序。
  const enumerationOrder = new Map(runIds.map((runId, index) => [runId, index]));
  // 第 147 批修正一（内存）：每条读完就归类；只有确实会走到谱系派生的"收口且
  // 未裁决"运行才保留转录到 prepare 之后（门与 forRun 共用 supersessionCandidateGate
  // 的 lineageRef 判定；无谱系引用时 forRun 的结论只取决于本转录的
  // run.lineage_closed，可当场判完）。其余归类完即丢，300 份 × 4MB 不会攒在堆里。
  const retainedLineage = [];
  const pendingRoots = new Set();

  const recordAwaiting = async (runId, events, fromAnotherWorktree) => {
    let terminalMs = null;
    try {
      terminalMs = boundTerminalEventMs(events, runId);
    } catch {
      terminalMs = null;
    }
    awaitingDecision.push({
      runId,
      terminalMs,
      order: enumerationOrder.get(runId) ?? Number.MAX_SAFE_INTEGER,
    });
    if (fromAnotherWorktree) crossTree.awaiting = true;
    try {
      if (await deliveryContinuableHint({ events, runId, runDir: resolvedRunDir, readTranscriptFn })) {
        continuable += 1;
      }
    } catch {
      // 可续判定读不出当不可续（提示性计数，不猜）。
    }
  };

  // 3a) 归属 + 收口判定 + 归类，一条流水做完（3b/3c 合并；不再先攒全量事件）。
  const classifyRead = async (runId, events) => {
    // 3b) 归属（记录的项目身份，0113 修订）：首事件在档的 project 事实优先
    //     （identityOfFirstEvent，与 `runs list --project` 同语义——派发时算
    //     好落档，开发树删了也认得出），没有记录的旧运行由它退回按 cwd 推导
    //     （不另写第二份回退）。factError 非空 = 在档事实损坏 → 不分类，计入
    //     "找不到或冲突"行；任一侧不是 kind:"project" 或 key 不同 → 跳过不计。
    const { identity, factError } = identityOfFirstEvent(events[0], projectIo);
    if (factError != null) {
      missingTranscripts += 1;
      return;
    }
    if (boundKey == null || identity?.kind !== "project" || identity.key !== boundKey) return;
    // 跨工作树提示口径不变：按运行的 cwd（findRunWorkspaceOwnership 的归属
    // 事实）与绑定根比较；归属事实缺失/读不出 → 当同树、不提示（归属判定
    // 本身已不依赖它）。
    let runCwd = null;
    try {
      runCwd = findRunWorkspaceOwnership(events, runId)?.cwd ?? null;
    } catch {
      runCwd = null;
    }
    const fromAnotherWorktree = typeof runCwd === "string" && runCwd.length > 0
      && !sameNormalizedPath(runCwd, authorizedWorkspaceRoot);
    // 3c) 先收口判定，再裁定。
    const settlement = determineRunSettlement(events, runId);
    if (!settlement.facts.terminal) return; // 未终态 → 活跃运行一节管，不报
    if (settlement.status === "settled") {
      if (settlement.reason === "delivery_settled") {
        const decided = events.some(
          (e) => e && e.runId === runId
            && (e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected"),
        );
        if (decided) {
          reclaimBranches += 1; // 已裁定 → 留待回收
          return;
        }
        // 第 120 批：优先级 自身显式裁决 > 谱系显式关闭 > 派生被取代 > 待裁决。
        // 谱系已显式关闭、或已有被采纳的后代（派生事实）时不再催 Lead 裁决
        //（关闭/被取代都不写事件，也不计入可续计数）。派生读不出时保持待裁决。
        // 第 147 批修正一：有谱系引用的才需要 forRoot/根转录，保留到 prepare 后；
        // 无谱系引用的运行，forRun 的结论就是本转录的 run.lineage_closed。
        if (supersessionCandidateGate(events, runId).lineageRef) {
          const declared = declaredLineageRoot(events, runId);
          if (!declared.conflict && typeof declared.rootRunId === "string") pendingRoots.add(declared.rootRunId);
          retainedLineage.push({ runId, events, fromAnotherWorktree });
          if (typeof onBranchEventsRetainedFn === "function") onBranchEventsRetainedFn(runId);
          return;
        }
        if (lineageClosedIn(events, runId)) {
          reclaimBranches += 1;
          return;
        }
        await recordAwaiting(runId, events, fromAnotherWorktree);
      } else {
        // no_delivery_requested / packaging_failed / isolation_failed → 留待回收
        reclaimBranches += 1;
      }
      return;
    }
    if (settlement.status === "unsettled") {
      // 已有 Lead 决定（第 87 批的 pending 拒收：验证永无结果、拒收已定）→ 按
      // 已裁定留待回收：迟到的验证结果只改显示，Lead 无事可做；收口语义仍归
      // 决定 0095（已拒收也要等结果），不在这里改。
      if (settlement.facts.acceptanceStatus === "accepted"
        || settlement.facts.acceptanceStatus === "rejected") {
        reclaimBranches += 1;
      } else {
        // 验证/reverify 还没结果 → 终态未收口。
        terminalUnsettled.push(runId);
        if (fromAnotherWorktree) crossTree.unsettled = true;
      }
      return;
    }
    // undeterminable：交付事实判不出收口——与"还没结果"分开（#2），单独
    // 一行指向诊断。
    undeterminable.push(runId);
    if (fromAnotherWorktree) crossTree.undeterminable = true;
  };

  // 3a) 解析逐条（保留原逻辑）；读取有界并发，**读出来就地归类**，不留全量。
  const toRead = [];
  for (const runId of runIds) {
    let detail;
    try {
      detail = resolveTranscript(resolvedRunDir, runId);
    } catch {
      missingTranscripts += 1;
      continue;
    }
    const d = typeof detail === "string"
      ? { path: detail, found: true, conflict: false, unreadable: false }
      : detail;
    if (!d || d.found !== true || typeof d.path !== "string" || d.path.length === 0) {
      missingTranscripts += 1;
      continue;
    }
    toRead.push({ runId, path: d.path });
  }
  await readItemsBounded(toRead, async ({ runId, path }) => {
    let events;
    try {
      events = await readTranscriptFn(path);
      if (!Array.isArray(events)) throw new Error("transcript not an event array");
    } catch {
      missingTranscripts += 1;
      return null;
    }
    await classifyRead(runId, events);
    return null; // 归类完即丢：不留转录
  });

  // 一次性预筛：只把**真会走到 forRoot** 的运行声明的根交给读器（第 120 批续修
  // E1）——自身有谱系引用、已打包、自身未裁决、已收口，且属于绑定项目。普通
  // 运行对自己返回自己的 runId，若照收会让每个被查看的分支都触发一次全库字节
  // 扫描（全量分支下更不可接受）。判定函数从派生模块导入，与 forRun 的门共用。
  if (pendingRoots.size > 0) {
    try {
      await supersession.prepare([...pendingRoots]);
    } catch {
      // 预筛失败：各 run 的派生各自兜底为"不推导"（保持待裁决）。
    }
  }
  // 只处理为谱系派生保留的那几条；处理完立即释放。
  for (const { runId, events, fromAnotherWorktree } of retainedLineage) {
    let lineage = null;
    try {
      lineage = await supersession.forRun({ runId, events });
    } catch {
      lineage = null;
    }
    if (lineage?.lineageClosed === true || typeof lineage?.supersededByRunId === "string") {
      reclaimBranches += 1;
    } else {
      await recordAwaiting(runId, events, fromAnotherWorktree);
    }
  }
  retainedLineage.length = 0;

  // 4) 运行树棵数（全仓 .wao-worktrees/<runId> 结尾的条目，#1；读不出 →
  //    null = 该数省略）。
  let worktreeCount = null;
  try {
    const entries = parseWorktreePorcelainFn(
      String(execGitFn(["worktree", "list", "--porcelain"], authorizedWorkspaceRoot)),
    );
    worktreeCount = entries.filter((e) => isRunWorktreeEntry(e?.path)).length;
  } catch {
    worktreeCount = null;
  }

  // 跨工作树提示（#2）：审查工具缺省按默认绑定核对归属（裁定工具缺根即拒）——
  // 查别的工作树里的运行，按调用带那棵树的根（expectedWorkspaceRoot），或在那里跑 CLI。只在对应行确实列出
  // 这样的运行时出现；行内无绝对路径。
  const CROSS_TREE_HINT = "some runs were dispatched from another worktree: pass that worktree's root as expectedWorkspaceRoot (or run the CLI there) first";
  // 第 147 批：等裁决行按 runId 内的创建时刻从旧到新（最旧的先点名），并写明
  // 最老一条已等几天——年龄从它绑定的终态事件时间算；取不到就不写年龄。
  // 修正一：创建时刻与读模型共用 runBranches.runCreatedAtMs（越界字段=取不到）。
  const orderedAwaiting = sortAwaitingOldestFirst(awaitingDecision);
  const orderedAwaitingIds = orderedAwaiting.map((entry) => entry.runId);
  let oldestWaitingDays = null;
  if (orderedAwaiting.length > 0) {
    let nowMs = NaN;
    try {
      nowMs = nowFn();
    } catch {
      nowMs = NaN;
    }
    oldestWaitingDays = waitedDays(nowMs, orderedAwaiting[0].terminalMs);
  }
  terminalUnsettled.sort(byEnumerationOrder(enumerationOrder));
  undeterminable.sort(byEnumerationOrder(enumerationOrder));

  const lines = [];
  if (awaitingDecision.length > 0) {
    const ids = joinRunIdsBounded(orderedAwaitingIds, 150, OPEN_ITEM_RUNIDS_CAP);
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${awaitingDecision.length} settled delivery run(s) await a Lead decision `
      + `(run_delivery / run_delivery_review): ${ids.text}`
      + `${ids.rest > 0 ? ` (+${ids.rest} more)` : ""}`
      + `${oldestWaitingDays != null ? `; oldest waited ${oldestWaitingDays} day(s) since its terminal state` : ""}`
      + `${continuable > 0 ? `; ${continuable} continuable (run_continue hint)` : ""}`
      + `${crossTree.awaiting ? `; ${CROSS_TREE_HINT}` : ""}`,
    ));
  }
  if (terminalUnsettled.length > 0) {
    const ids = joinRunIdsBounded(terminalUnsettled, 120, OPEN_ITEM_RUNIDS_CAP);
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${terminalUnsettled.length} terminal run(s) not settled `
      + `(verification/reverify without a result; run_delivery or \`wao runs wait <runId> --until-settled\`): `
      + `${ids.text}${ids.rest > 0 ? ` (+${ids.rest} more)` : ""}`
      + `${crossTree.unsettled ? `; ${CROSS_TREE_HINT}` : ""}`,
    ));
  }
  if (undeterminable.length > 0) {
    const ids = joinRunIdsBounded(undeterminable, 170, OPEN_ITEM_RUNIDS_CAP);
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${undeterminable.length} run(s) with undeterminable settlement facts `
      + `(wao runs diagnose <runId>): ${ids.text}${ids.rest > 0 ? ` (+${ids.rest} more)` : ""}`
      + `${crossTree.undeterminable ? `; ${CROSS_TREE_HINT}` : ""}`,
    ));
  }
  if (reclaimBranches > 0 || (worktreeCount ?? 0) > 0) {
    // 运行树数只在读出且 >0 时写出（0 不写——分支计数仍如实保留）。
    const wt = worktreeCount != null && worktreeCount > 0
      ? ` + ${worktreeCount} run worktree(s) under .wao-worktrees/`
      : "";
    // b78：写明"能否回收以回收计划为准"——计划保留最近 RECENT_BOUND_EVENT_MS
    // 内有计入活动的运行，Lead 做出空计划不是出错；分钟数由常量派生，不另写
    // 数字。第 133 批：计入活动不含 Lead 的记账事件（裁决、谱系关闭、收集），
    // 文案如实写明。第 120 批：这一行如实覆盖"已裁决、被取代、谱系已关闭、
    // 无交付"四种来源（后两种不写事件，也不再催裁决）。
    const keptRecentMinutes = Math.round(RECENT_BOUND_EVENT_MS / 60_000);
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${reclaimBranches} decided / superseded / lineage-closed / no-delivery wao/run_* branch(es)${wt} `
      + `left for reclaim (\`wao worktree reclaim --out <plan.json>\` plans it; read-only; `
      + `the plan decides what is reclaimable — an empty plan can be normal, `
      + `runs with worker or WAO activity in the last ${keptRecentMinutes} minutes are kept; `
      + `Lead decisions, lineage closes and collect records do not reset the window)`,
    ));
  }
  // 第 147 批修正一：超帽是"仓库里 wao/run_* 分支总数"这一条事实，单独一行——
  // 挂在"留待回收"行上时，没有回收候选（例如全是形状不合法的分支）就不显示。
  // 计数口径与 dispatchResourceAdvisory 一致：全部分支名，不管 runId 形状。
  if (total > BRANCH_CAP) {
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${total} wao/run_* branch(es) in this repository exceed the cap of ${BRANCH_CAP} `
      + `(reclaim: \`wao worktree reclaim --out <plan.json>\`)`,
    ));
  }
  if (missingTranscripts > 0) {
    // 缺失口径含未找到、冲突/不可读副本与在档项目事实损坏（0113 修订——转录
    // 读得出但事实坏了同样没法归类）；reclaim CLI 只打印可回收项，这些分支在
    // --out 计划文件的条目里。
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${missingTranscripts} wao/run_* branch(es) without a usable transcript fact `
      + `(not found, unreadable, conflicting copies, or a broken recorded project fact; `
      + `read-only \`wao worktree reclaim --out <plan.json>\` plan lists the branches)`,
    ));
  }
  return lines;
}

// ── B. 反馈收件箱 ────────────────────────────────────────────────────────────

/**
 * 同项目时数收件箱 open/ 目录的合法条目文件名，返回 0 或 1 行。
 * 不同项目 / 目录不存在（=0）/ 目录读不出 / 无合法条目 → null（省略该行）。
 */
async function collectInboxOpenItem({
  authorizedWorkspaceRoot,
  codeCheckoutRoot = defaultPackageRoot(),
  identifyProjectFn = defaultIdentifyProject,
  inboxDirFn = defaultInboxDir,
  readDirFn = readdirSync,
}) {
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) return null;
  if (typeof codeCheckoutRoot !== "string" || codeCheckoutRoot.length === 0) return null;
  // 项目身份：identifyProjectFromCwd 的现有判定（R8 链接工作树归主工作树，
  // 决定 0099）；比稳定键，不比路径字符串。任一侧不是项目 → 不出。
  let sameProject = false;
  try {
    const a = identifyProjectFn(authorizedWorkspaceRoot);
    const b = identifyProjectFn(codeCheckoutRoot);
    sameProject = a?.kind === "project" && b?.kind === "project" && a.key === b.key;
  } catch {
    sameProject = false;
  }
  if (!sameProject) return null;

  // 只 readdir open/ 子目录、只数文件名（不读内容、不碰 closed/ 与 ids/）。
  let names;
  try {
    names = readDirFn(feedbackOpenDir(inboxDirFn()));
  } catch {
    return null; // 目录不存在（当 0）或读不出（省略）都不出行。
  }
  const count = Array.isArray(names)
    ? names.filter((n) => typeof n === "string" && FEEDBACK_FILE_RE.test(n)).length
    : 0;
  if (count <= 0) return null;
  return boundedLine(
    `${OPEN_ITEM_PREFIX}${count} unprocessed feedback entr${count === 1 ? "y" : "ies"} `
    + `in the WAO inbox (\`wao feedback list\`)`,
  );
}

/**
 * 收集待 Lead 收口事项的观察行（每行 `open item: ` 开头、≤512 字符、
 * facts only）。各来源独立结算：一段读不出只省略自己的行，绝不抛错。
 *
 * @param {object} input
 * @param {string} input.authorizedWorkspaceRoot — 绑定工作区根（canonical Git root）
 * @param {string} input.runDir — runs/ 目录（转录解析与读）
 * @param {Function} [input.execGitFn] — (args, cwd) => string；只读 git 注入缝
 * @param {Function} [input.resolveTranscriptFn] — (runDir, runId) => detailed；
 *   缺省 resolveTranscriptPathDetailed（统一入口：全桶查重，conflict/
 *   unreadable 不静默择一）；注入返回 detailed 形状或路径字符串（=found）
 * @param {Function} [input.readTranscriptFn] — (path) => Promise<events[]>；
 *   读取有界并发（一次最多 8 份）
 * @param {Function} [input.nowFn] — () => epoch ms；等裁决行年龄的当前时刻
 *   （缺省 Date.now；测试注入）
 * @param {Function} [input.onBranchEventsRetainedFn] — 测试缝：为延迟谱系派生
 *   保留一条转录时调用（runId）——生产不注入
 * @param {object} [input.projectIo] — projectIdentity 的 io（realpath/tmpdir/
 *   readGitFile），归属两侧共用：绑定根的 identifyProjectFromCwd 与首事件的
 *   identityOfFirstEvent（0113 修订口径）；缺省 productionProjectIo()
 * @param {Function} [input.parseWorktreePorcelainFn] — porcelain 解析注入缝
 * @param {Function} [input.identifyProjectFn] — (root) => identity 注入缝
 * @param {string} [input.codeCheckoutRoot] — MCP 服务所在的 WAO 代码检出根
 * @param {Function} [input.inboxDirFn] — () => 收件箱根目录 注入缝
 * @param {Function} [input.readDirFn] — readdir 注入缝
 * @returns {Promise<string[]>}
 */
export async function collectLeadOpenItems(input) {
  const lines = [];
  try {
    for (const line of await collectRunBranchOpenItems(input ?? {})) lines.push(line);
  } catch {
    // 意外兜底：A 整段省略（子收集器已按来源结算，这里不该到）。
  }
  try {
    const line = await collectInboxOpenItem(input ?? {});
    if (typeof line === "string" && line.length > 0) lines.push(line);
  } catch {
    // 意外兜底：B 省略。
  }
  return lines;
}
