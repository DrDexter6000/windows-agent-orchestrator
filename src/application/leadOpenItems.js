// src/application/leadOpenItems.js
//
// 决定 0113：lead_preflight 的待 Lead 收口事项收集器（应用层只读服务）。
// 回答"哪些事还欠 Lead 一步"，两路来源、各自独立结算：
//
//   A. 运行分支——候选集是绑定工作区所属仓库的 refs/heads/wao/run_* 分支
//      （不按时间窗扫转录：交付运行一定有自己的分支，未裁定的交付不会被
//      回收，回收会删分支，所以候选集随 Lead 收口变小、不随历史增长）。
//      按提交时间新到旧至多查看 50 条，逐条读转录、核对归属，先看收口判定
//      （determineRunSettlement SSOT）再看裁定（只认绑定本 runId 的
//      run.delivery_accepted / run.delivery_rejected）：
//        - 收口且原因 delivery_settled、未裁定 → 等 Lead 裁定（其中 0112 的
//          deliveryContinuableHint 为 true 的另计数）；
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
//      裁定工具按**会话绑定**核对归属（run_delivery_review_bundle /
//      run_delivery 不收 expectedWorkspaceRoot，wao runs wait 不收 --cwd），
//      所以"等裁定/终态未收口/无法判定收口"三行在**该行列出的运行里至少有
//      一个派发自与绑定根不同的工作树**时，提示先用 workspace_select 选那棵
//      工作树（或在那棵工作树里跑 CLI）再查；行内不出现绝对路径。
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
//     ——枚举失败省略整段，单条转录读不出只计数，收件箱读不出省略该行。
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

import { isValidRunId } from "../delivery.js";
import { resolveTranscriptPathDetailed } from "../projectBuckets.js";
import {
  identifyProjectFromCwd,
  identityOfFirstEvent,
  productionProjectIo,
} from "../projectIdentity.js";
import { readTranscript } from "../transcript.js";
import { determineRunSettlement } from "./runSettlement.js";
import { deliveryContinuableHint } from "./runContinue.js";
import { findRunWorkspaceOwnership } from "./runWorkspaceOwnership.js";
import { parseWorktreePorcelain, RECENT_BOUND_EVENT_MS } from "./worktreeReclaim.js";
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
/** A 分支候选查看帽（决定 0113 第 2 条：按提交时间新到旧至多查看 50 条）。 */
export const OPEN_ITEM_BRANCH_CAP = 50;
/** 每行至多点名的 runId 个数（决定 0113：个数 + 至多 5 个 runId）。 */
export const OPEN_ITEM_RUNIDS_CAP = 5;

// 只读 git：结构化 argv、--no-optional-locks、不经 shell（serverBuildFacts 写法）。
function defaultExecGit(args, cwd) {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
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

// ── A. 运行分支 ──────────────────────────────────────────────────────────────

/**
 * 枚举绑定仓库的 wao/run_* 分支并按收口/裁定归类，返回 0–5 行。
 * 枚举失败 → 空数组（整段 A 省略，决定 0113 第 4 条）。
 */
async function collectRunBranchOpenItems({
  authorizedWorkspaceRoot,
  runDir,
  execGitFn = defaultExecGit,
  resolveTranscriptFn,
  readTranscriptFn = readTranscript,
  projectIo = productionProjectIo(),
  parseWorktreePorcelainFn = parseWorktreePorcelain,
}) {
  if (typeof authorizedWorkspaceRoot !== "string" || authorizedWorkspaceRoot.length === 0) return [];
  const resolvedRunDir = resolve(runDir);

  // 1) 枚举（新到旧；只认 wao/run_ 前缀且 runId 合法的）。
  let refs;
  try {
    const out = execGitFn(
      ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/wao/"],
      authorizedWorkspaceRoot,
    );
    refs = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // 枚举失败 → 整个 A 省略
  }
  const runIds = [];
  for (const ref of refs) {
    if (!ref.startsWith("wao/run_")) continue;
    const runId = ref.slice("wao/".length);
    if (isValidRunId(runId)) runIds.push(runId);
  }
  const total = runIds.length;
  const examined = runIds.slice(0, OPEN_ITEM_BRANCH_CAP);
  const truncated = total > examined.length;
  // 超出查看帽时每行计数写明"已查看部分"并给出总条数（决定 0113 第 2 条）。
  const truncSuffix = truncated
    ? `; counts cover the ${examined.length} newest of ${total} wao/run_* branch(es)`
    : "";

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

  const awaitingDecision = [];
  const terminalUnsettled = [];
  const undeterminable = [];
  // 跨工作树提示按行跟踪：该行列出的运行里至少有一个派发自与绑定根不同的
  // 工作树时，那行才加提示（审查/裁定工具按会话绑定核对归属）。
  const crossTree = { awaiting: false, unsettled: false, undeterminable: false };
  let reclaimBranches = 0;
  let missingTranscripts = 0;
  let continuable = 0;

  for (const runId of examined) {
    // 3a) 解析：found 才读；conflict/unreadable/未找到/解析抛错都不分类，
    //     与单条读失败一起计入"找不到或有冲突副本"。
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
    let events;
    try {
      events = await readTranscriptFn(d.path);
      if (!Array.isArray(events)) throw new Error("transcript not an event array");
    } catch {
      missingTranscripts += 1;
      continue;
    }
    // 3b) 归属（记录的项目身份，0113 修订）：首事件在档的 project 事实优先
    //     （identityOfFirstEvent，与 `runs list --project` 同语义——派发时算
    //     好落档，开发树删了也认得出），没有记录的旧运行由它退回按 cwd 推导
    //     （不另写第二份回退）。factError 非空 = 在档事实损坏 → 不分类，计入
    //     "找不到或冲突"行；任一侧不是 kind:"project" 或 key 不同 → 跳过不计。
    const { identity, factError } = identityOfFirstEvent(events[0], projectIo);
    if (factError != null) {
      missingTranscripts += 1;
      continue;
    }
    if (boundKey == null || identity?.kind !== "project" || identity.key !== boundKey) continue;
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
    if (!settlement.facts.terminal) continue; // 未终态 → 活跃运行一节管，不报
    if (settlement.status === "settled") {
      if (settlement.reason === "delivery_settled") {
        const decided = events.some(
          (e) => e && e.runId === runId
            && (e.type === "run.delivery_accepted" || e.type === "run.delivery_rejected"),
        );
        if (decided) {
          reclaimBranches += 1; // 已裁定 → 留待回收
        } else {
          awaitingDecision.push(runId);
          if (fromAnotherWorktree) crossTree.awaiting = true;
          try {
            if (await deliveryContinuableHint({ events, runId, runDir: resolvedRunDir, readTranscriptFn })) {
              continuable += 1;
            }
          } catch {
            // 可续判定读不出当不可续（提示性计数，不猜）。
          }
        }
      } else {
        // no_delivery_requested / packaging_failed / isolation_failed → 留待回收
        reclaimBranches += 1;
      }
    } else if (settlement.status === "unsettled") {
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
    } else {
      // undeterminable：交付事实判不出收口——与"还没结果"分开（#2），单独
      // 一行指向诊断。
      undeterminable.push(runId);
      if (fromAnotherWorktree) crossTree.undeterminable = true;
    }
  }

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

  // 跨工作树提示（#2）：审查/裁定工具（run_delivery_review_bundle /
  // run_delivery / wao runs wait）按会话绑定核对归属，不收 expectedWorkspaceRoot
  // / --cwd——查别的工作树里的运行，先 workspace_select 那棵树（或在那里跑
  // CLI）。只在对应行确实列出这样的运行时出现；行内无绝对路径。
  const CROSS_TREE_HINT = "some runs were dispatched from another worktree: workspace_select it (or run the CLI there) first";

  const lines = [];
  if (awaitingDecision.length > 0) {
    const ids = joinRunIdsBounded(awaitingDecision, 150, OPEN_ITEM_RUNIDS_CAP);
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${awaitingDecision.length} settled delivery run(s) await a Lead decision `
      + `(run_delivery_review_bundle): ${ids.text}`
      + `${ids.rest > 0 ? ` (+${ids.rest} more)` : ""}`
      + `${continuable > 0 ? `; ${continuable} continuable (run_continue hint)` : ""}`
      + `${crossTree.awaiting ? `; ${CROSS_TREE_HINT}` : ""}${truncSuffix}`,
    ));
  }
  if (terminalUnsettled.length > 0) {
    const ids = joinRunIdsBounded(terminalUnsettled, 120, OPEN_ITEM_RUNIDS_CAP);
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${terminalUnsettled.length} terminal run(s) not settled `
      + `(verification/reverify without a result; run_delivery or \`wao runs wait <runId> --until-settled\`): `
      + `${ids.text}${ids.rest > 0 ? ` (+${ids.rest} more)` : ""}`
      + `${crossTree.unsettled ? `; ${CROSS_TREE_HINT}` : ""}${truncSuffix}`,
    ));
  }
  if (undeterminable.length > 0) {
    const ids = joinRunIdsBounded(undeterminable, 170, OPEN_ITEM_RUNIDS_CAP);
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${undeterminable.length} run(s) with undeterminable settlement facts `
      + `(wao runs diagnose <runId>): ${ids.text}${ids.rest > 0 ? ` (+${ids.rest} more)` : ""}`
      + `${crossTree.undeterminable ? `; ${CROSS_TREE_HINT}` : ""}${truncSuffix}`,
    ));
  }
  if (reclaimBranches > 0 || (worktreeCount ?? 0) > 0) {
    // 运行树数只在读出且 >0 时写出（0 不写——分支计数仍如实保留）。
    const wt = worktreeCount != null && worktreeCount > 0
      ? ` + ${worktreeCount} run worktree(s) under .wao-worktrees/`
      : "";
    // b78：写明"能否回收以回收计划为准"——计划保留最近 RECENT_BOUND_EVENT_MS
    // 内有事件的运行，Lead 做出空计划不是出错；分钟数由常量派生，不另写数字。
    const keptRecentMinutes = Math.round(RECENT_BOUND_EVENT_MS / 60_000);
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${reclaimBranches} decided/no-delivery wao/run_* branch(es)${wt} `
      + `left for reclaim (\`wao worktree reclaim --out <plan.json>\` plans it; read-only; `
      + `the plan decides what is reclaimable — an empty plan can be normal, `
      + `runs with an event in the last ${keptRecentMinutes} minutes are kept)${truncSuffix}`,
    ));
  }
  if (missingTranscripts > 0) {
    // 缺失口径含未找到、冲突/不可读副本与在档项目事实损坏（0113 修订——转录
    // 读得出但事实坏了同样没法归类）；reclaim CLI 只打印可回收项，这些分支在
    // --out 计划文件的条目里。
    lines.push(boundedLine(
      `${OPEN_ITEM_PREFIX}${missingTranscripts} wao/run_* branch(es) without a usable transcript fact `
      + `(not found, unreadable, conflicting copies, or a broken recorded project fact; `
      + `read-only \`wao worktree reclaim --out <plan.json>\` plan lists the branches)${truncSuffix}`,
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
 * @param {Function} [input.readTranscriptFn] — (path) => Promise<events[]>
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
