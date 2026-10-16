// src/commands/worktree.js
//
// worktree command family：
//   worktree list [--cwd DIR]
//   worktree remove <path> [--cwd DIR]
//   worktree reclaim [--cwd DIR] [--include <runId>]... --out <plan.json> [--run-dir DIR]
//   worktree reclaim --apply <plan.json> --expect-sha256 <hex> [--run-dir DIR]
//
// reclaim 的数据逻辑在 ../application/worktreeReclaim.js（计划=只读普查分类；
// apply=只执行 sha256 绑定的已批准计划）。本文件只做 CLI 适配。
//
// 依赖：
//   - 外部模块：../isolation.js（listWorktrees/removeWorktree）
//   - 应用服务：../application/worktreeReclaim.js（planWorktreeReclaim/applyWorktreeReclaim）
//   - 共享工具：./shared.js（parseOptions，纯函数）
//   - node built-in：path（resolve）

import { resolve } from "node:path";

import { listWorktrees, removeWorktree } from "../isolation.js";
import { planWorktreeReclaim, applyWorktreeReclaim, RECLAIM_REFUSAL_CODES } from "../application/worktreeReclaim.js";
import { readInstallRoot, resolveConfigPath } from "../installRoot.js";
import { parseOptions } from "./shared.js";

/** --include 可重复给出：手收全部值（parseOptions 只对 --tag 做重复收集）。
 * `--include <id>` 与 `--include=<id>` 两种写法都收；等号写法静默忽略会让
 * Owner 以为点了名。 */
function collectRepeat(rest, flag) {
  const values = [];
  const eq = `${flag}=`;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === flag && i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
      values.push(rest[i + 1]);
      i += 1;
    } else if (rest[i].startsWith(eq)) {
      values.push(rest[i].slice(eq.length));
    }
  }
  return values;
}

async function worktreeReclaimCommand(rest, config) {
  const options = parseOptions(rest);
  const repoCwd = resolve(options.cwd ?? config.cwd ?? process.cwd());
  // 运行目录：缺省（与相对的 config.runDir）锚在 WAO 安装根（照 cli.js 全局
  // bin 对 config.runDir 的处理），不锚在进程当前目录——--cwd 指向的是被清退
  // 仓库，从别的检出里跑命令时，cwd 下的 runs/ 不是转录库。显式 --run-dir 是
  // 显式覆盖，按进程当前目录解析、从不重锚（installRoot.js 的契约）。
  const runDir = options.runDir
    ? resolve(options.runDir)
    : resolveConfigPath(config.runDir ?? "runs", readInstallRoot());
  if (options.apply) {
    if (!options.expectSha256) {
      throw new Error("worktree reclaim --apply requires --expect-sha256 <hex>（Owner 批准的计划 sha256）");
    }
    const result = await applyWorktreeReclaim({
      planPath: resolve(options.apply),
      expectSha256: String(options.expectSha256),
      runDir,
    });
    if (result.refused) {
      if (!RECLAIM_REFUSAL_CODES.includes(result.refused)) {
        throw new Error(`worktree reclaim --apply 拒绝码越闭集：${result.refused}`);
      }
      console.error(`[worktree reclaim] 整体拒绝（零删除）：${result.refused}${result.detail ? `（${result.detail}）` : ""}`);
      process.exitCode = 1;
      return;
    }
    for (const r of result.results) {
      const why = r.reason ? `（${r.reason}${r.detail ? `：${r.detail}` : ""}）` : "";
      console.log(`  ${r.action} ${r.runId}${r.branch ? ` ${r.branch}` : ""} -> ${r.outcome}${why}`);
    }
    if (result.countsAfter) {
      console.log(`  worktrees ${result.countsBefore.worktrees} -> ${result.countsAfter.worktrees}；wao/* 分支 ${result.countsBefore.waoBranches} -> ${result.countsAfter.waoBranches}`);
    }
    const cats = Object.entries(result.byCategory ?? {}).filter(([, v]) => v > 0).map(([c, v]) => `${c}=${v}`).join(" ");
    if (cats) console.log(`  分类计数（按 runId，沿用计划，含无独立条目的共享成员）：${cats}`);
    const exec = Object.entries(result.executionCounts ?? {}).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(" ");
    if (exec) console.log(`  执行结果（按条目计，一个 runId 的树/分支条目各计一次）：${exec}`);
    if (result.bundlePath) console.log(`  bundle：${result.bundlePath}（sha256 ${result.bundleSha256}）`);
    // 有异常面（stale 登记 / 删分支阶段实时登记读不出 / 中途异常 / 记录写失败）
    // 时不打印"完成"，以非零退出码结束；已删除的部分已在上面照实列出。
    if (result.recordsWriteFailed) {
      console.error(`[worktree reclaim] 记录写入失败（保全目录 ${result.preserveDir ?? "未建立"}）——删除已执行但无审计记录，人工核查后处置`);
      process.exitCode = 1;
      return;
    }
    if (result.aborted) {
      console.error(`[worktree reclaim] 中途异常中止：${result.aborted.message}——已执行部分已在上面如实列出`);
      console.log(`  记录：${result.preserveDir ?? "（未建立）"}`);
      process.exitCode = 1;
      return;
    }
    if (result.liveRegistrationUnreadable) {
      // 删分支阶段实时登记读不出：无法证明没有 worktree 检出待删分支，
      // update-ref -d 又不提供检出保护——全部分支已按 live_registration_unreadable
      // 跳过，分支原样保留。
      console.error("[worktree reclaim] 删分支阶段的实时登记读取失败——全部分支跳过（live_registration_unreadable），未删除任何分支；树与空壳的结果见上面的逐项；重试或排查 git 状态后重出计划");
      console.log(`  记录：${result.preserveDir}`);
      process.exitCode = 1;
      return;
    }
    if (result.staleRegistrations?.length) {
      // 本命令不做仓库级 prune：stale 登记不清、持有它的分支保守跳过，提示走
      // 通用清扫后重出计划。
      console.error(`[worktree reclaim] 目录缺失的在册登记 ${result.staleRegistrations.length} 条（未清理）：${result.staleRegistrations.join("；")}——走 serve 维护 / runs verify-commit 的通用清扫后重出计划`);
      console.log(`  记录：${result.preserveDir}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[worktree reclaim] 完成。记录：${result.preserveDir}`);
    return;
  }
  if (!options.out) {
    throw new Error("worktree reclaim 需要 --out <plan.json>（只读计划模式）或 --apply <plan.json>（执行模式）");
  }
  const { plan, planSha256, warning } = await planWorktreeReclaim({
    repoCwd,
    runDir,
    includeRunIds: collectRepeat(rest, "--include"),
    outPath: resolve(options.out),
  });
  if (warning) console.error(`[worktree reclaim] 提示：${warning}`);
  const byCategory = plan.counts.byCategory;
  const kept = Object.entries(byCategory).filter(([c]) => c !== "reclaim").reduce((n, [, v]) => n + v, 0);
  console.log(`[worktree reclaim] 计划写出：${resolve(options.out)}（只读，未动任何树/分支/转录）`);
  console.log(`  计划 sha256：${planSha256}（Owner 按此批准；--apply 须带同一值，且 --run-dir 须与生成时一致）`);
  console.log(`  普查：worktrees ${plan.counts.worktrees}，wao/* 分支 ${plan.counts.waoBranches}；保留 ${kept}，回收 ${byCategory.reclaim ?? 0}`);
  const summary = Object.entries(byCategory).filter(([, v]) => v > 0).map(([c, v]) => `${c}=${v}`).join(" ");
  console.log(`  分类计数（按 runId，含无独立条目的共享成员）：${summary}`);
  // 逐条打印回收项——Owner 按 sha256 批准时要看的审批事实（同一 runId 的树/
  // 分支条目只打一行；已并入与 cherry 数沿用条目 info 字段）。
  const reclaimRuns = new Map();
  for (const item of plan.items) {
    if (item.category !== "reclaim") continue;
    if (!reclaimRuns.has(item.runId)) reclaimRuns.set(item.runId, { runId: item.runId, facts: item.facts ?? {} });
    const entry = reclaimRuns.get(item.runId);
    if (item.action === "remove_tree" && (item.notes ?? []).some((n) => n.includes("脏树"))) entry.dirty = true;
    // 嵌套项（父树是关联工作树）：Owner 批准时要看得见删的是哪棵、挂在谁下面。
    if ((item.action === "remove_tree" || item.action === "rmdir_husk") && typeof item.scopeRoot === "string") {
      entry.nestedTarget = item.treePath;
      entry.nestedParent = item.scopeRoot;
    }
    if (item.info) {
      entry.mergedIntoMain = item.info.mergedIntoMain;
      entry.cherryPlus = item.info.cherryPlus;
    }
  }
  for (const r of [...reclaimRuns.values()].sort((a, b) => (a.runId < b.runId ? -1 : 1))) {
    // lastDecision / terminalState 只在转录可读且无孪生时在场：三处都没有转录与读不出是两回事。
    const absent = r.facts.transcriptLocations?.length ? "（转录不可读或有孪生）" : "（无转录）";
    const decision = "lastDecision" in r.facts ? r.facts.lastDecision : absent;
    const terminal = "terminalState" in r.facts ? (r.facts.terminalState ?? "（无状态事件）") : absent;
    const locations = r.facts.transcriptLocations?.length ? r.facts.transcriptLocations.join("+") : "无";
    const parts = [
      `  回收 ${r.runId}`,
      `决定=${decision}`,
      `终态=${terminal}`,
      `转录=${locations}`,
    ];
    if (r.nestedParent) parts.push(`目标=${r.nestedTarget}`, `父树=${r.nestedParent}`);
    if (r.mergedIntoMain !== undefined) {
      parts.push(`已并入=${r.mergedIntoMain ? "是" : "否"}`, `cherry+=${r.cherryPlus ?? "?"}`);
    }
    if (r.dirty) parts.push("脏树：删除即丢弃未提交内容");
    console.log(parts.join("  "));
  }
}

/**
 * worktree 命令：列出/删除/清退 worktree。
 * 能力层（listWorktrees/removeWorktree）早已实现，本命令只是 CLI 暴露。
 */
async function worktreeCommand(args, config) {
  const [sub, ...rest] = args;
  const options = parseOptions(rest);
  const cwd = resolve(options.cwd ?? config.cwd ?? process.cwd());
  if (sub === "list") {
    const wts = await listWorktrees(cwd);
    console.log(JSON.stringify(wts, null, 2));
    return;
  }
  if (sub === "remove") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) throw new Error("worktree remove requires <path>");
    await removeWorktree(resolve(target));
    console.log(JSON.stringify({ removed: resolve(target) }));
    return;
  }
  if (sub === "reclaim") {
    await worktreeReclaimCommand(rest, config);
    return;
  }
  throw new Error(`Unknown worktree subcommand: ${sub ?? "(none)"} (expected: list | remove | reclaim)`);
}

export { worktreeCommand };
