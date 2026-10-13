// src/commands/serve.js
//
// TD-250（决定 0056，2026-10-10）：`wao serve status | sweep | recycle`——kimi-web
// worker serve 的维护命令族（手动触发；Lead/Owner 在跑批间隙调用）。
//
// 这是薄 CLI 适配层：argv/format/console 归这里，门/编排/台账全部在
// ../application/serveMaintenance.js，serve REST/机器事实在
// ../backends/kimiServeOps.js。**回收/清扫跨 serve 生效**（kimi 会话仓实例间
// 共享）——输出明示，避免"只扫 worker 侧"的误读。
//
// 目标 serve 解析：--url 显式 > 注册表里第一个 kimi-web 席位的 serveUrl。
// token 取该席位 tokenEnv 指名的 env（缺席=固定错误点名变量名，值绝不回显）。
//
// 边界（会审定案）：不挂 daemon、无自动触发（决定 0075 只放开了一件——派发时端口上
// 没有监听、也没有活着的 serve 进程，就把 serve 拉起来，在 backends/kimiServeStart.js；
// 关/重启/清扫仍只有这里的手动命令，recycle 在关旧起新的窗口里占着那边的启动锁）；
// recycle 必须显式
// --workspace-dir（重启 cwd，无隐藏默认——env 由命令组装 WAO_IN_WORKER=1）；
// sweep 默认 dry-run，--apply 才执行。

import { resolve } from "node:path";
import { parseOptions } from "./shared.js";
import { readFileSync } from "node:fs";
import { readRegistry } from "../registry.js";
import { kimiServerTokenFile } from "../envPolicy.js";
import {
  serveStatusReport,
  planSessionSweep,
  applySessionSweep,
  recycleServe,
  serveMaintenanceDir,
} from "../application/serveMaintenance.js";

/** 解析目标 serve（url/token/agentId）与 kimi 席位集合。固定错误点名缺席面。
 * TD-253（决定 0058，双席修正）：--registry 显式消费；--url 未命中席位 → **拒绝**
 * （旧静默回落 kimiAgents[0] 会把 58630 的回收打到 58628——opus/sol 同发现）。 */
async function resolveServeTarget(config, urlOverride, kimiHomeOverride) {
  const registryPath = resolve(config.registry ?? "config/agents.json");
  const registry = await readRegistry(registryPath);
  const kimiAgents = registry.listAgents().filter((a) => a.backend === "kimi-web");
  if (kimiAgents.length === 0) {
    throw new Error("no kimi-web agent in registry — wao serve requires a kimi-web lane entry (serveUrl/tokenEnv)");
  }
  let target;
  if (urlOverride) {
    target = kimiAgents.find((a) => a.serveUrl === urlOverride);
    if (!target) {
      throw new Error(
        `--url ${urlOverride} matches no kimi-web agent in ${registryPath} `
        + `(available: ${kimiAgents.map((a) => a.serveUrl).join(", ")}) — refusing instead of silently falling back`,
      );
    }
  } else {
    target = kimiAgents[0];
  }
  // 决定 0074：车道声明了 kimiHome → token 取自该主目录的 server.token，主目录同时是
  // status / sweep / recycle 的缺省 --kimi-home（显式 flag 仍然优先）。
  const tokenFile = kimiServerTokenFile(target);
  // 会审（sol）：token 与实例表必须属于同一个主目录。车道声明了 kimiHome、命令行又
  // 显式给了另一个 --kimi-home → 拒绝（否则会拿这家的 token 去操作那家的实例）。
  const normHome = (p) => String(p).replace(/[\\]/g, "/").replace(/\/+$/, "").toLowerCase();
  if (tokenFile !== null && typeof kimiHomeOverride === "string" && kimiHomeOverride.length > 0
    && normHome(kimiHomeOverride) !== normHome(target.kimiHome)) {
    throw new Error(
      `--kimi-home ${kimiHomeOverride} differs from the lane's kimiHome ${target.kimiHome} — `
      + "refusing to mix two homes (the token and the instance table must belong to the same home)",
    );
  }
  let token;
  if (tokenFile !== null) {
    try { token = readFileSync(tokenFile, "utf8").trim(); } catch { token = ""; }
    if (token.length === 0) {
      throw new Error(`serve auth token file is missing or empty: ${tokenFile} (value is never echoed)`);
    }
  } else {
    token = process.env[target.tokenEnv];
    if (typeof token !== "string" || token.length === 0) {
      throw new Error(`serve auth env is absent: set ${target.tokenEnv} (value is never echoed)`);
    }
  }
  return {
    serveUrl: target.serveUrl,
    token,
    kimiHome: tokenFile !== null ? target.kimiHome : undefined,
    kimiAgentIds: kimiAgents.map((a) => a.id),
  };
}

function printSweepPlan(plan, kimiHomeInUse = false) {
  console.log(`Claims (WAO transcripts, all project buckets): ${plan.claims} kimi-web sessions`);
  console.log(`Workspace table entries: ${plan.workspaces}`);
  console.log(`Deletable (worktree root dead): ${plan.deletable.length}`);
  for (const d of plan.deletable) {
    console.log(`  DEL ${d.sessionId} (claim ${d.runId}) root=${d.workspaceRoot}`);
  }
  const byReason = new Map();
  for (const r of plan.retained) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  console.log(`Retained: ${plan.retained.length}`);
  for (const [reason, n] of [...byReason.entries()].sort()) console.log(`  KEEPREASON ${reason} x${n}`);
  if (plan.probeFailed.length > 0) {
    console.log(`Probe failed (kept, no action): ${plan.probeFailed.length}`);
    for (const p of plan.probeFailed) console.log(`  PROBEFAIL ${p.sessionId} ${p.reason}`);
  }
  // TD-256 验收（sol#5）：冲突/归档面/信封外事件/读取失败全部进操作面——
  // 认领归属不可证的会话永远保留侧，操作员必须能看见为什么。
  if (plan.claimConflicts?.length > 0) {
    console.log(`Claim conflicts (kept as claim_conflict, never deleted): ${plan.claimConflicts.length}`);
    for (const c of plan.claimConflicts) console.log(`  CONFLICT ${c.sessionId}: ${c.runIds.join(" vs ")}`);
  }
  if (plan.archiveScanned !== undefined) {
    console.log(`Archive face scanned: ${plan.archiveScanned} transcripts (skipped: ${plan.archiveSkipped?.length ?? 0}, read failures: ${plan.archiveReadFailures?.length ?? 0})`);
    for (const f of (plan.archiveReadFailures ?? []).slice(0, 5)) console.log(`  ARCHREADFAIL ${f.file} ${f.reason}`);
  }
  if (plan.foreignEnvelopeEvents?.length > 0) {
    console.log(`Foreign-envelope events skipped (claim binding): ${plan.foreignEnvelopeEvents.length}`);
  }
  if (kimiHomeInUse) {
    console.log("NOTE: target serve uses a PRIVATE kimi home (KIMI_CODE_HOME) — the sweep only");
    console.log("sees that home's session store. Claims from other homes are skipped as foreign_home.");
  } else {
    console.log("NOTE: the kimi session store is SHARED across serve instances of the SAME home — this sweep");
    console.log("deletes WAO-claimed sessions via the target serve regardless of which instance ran them.");
  }
}

async function serveCommand(args, config) {
  const [sub, ...tail] = args;
  const options = parseOptions(tail);
  // TD-253（决定 0058）：--registry 显式消费（sol：试点走注册表副本时 serve 也要读同一份）。
  if (typeof options.registry === "string" && options.registry.length > 0) config = { ...config, registry: options.registry };
  if (sub === "status") {
    const target = await resolveServeTarget(config, options.url, options.kimiHome);
    const report = await serveStatusReport({
      port: Number(new URL(target.serveUrl).port),
      serveUrl: target.serveUrl,
      token: target.token,
      kimiHome: options.kimiHome ?? target.kimiHome,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (sub === "sweep") {
    const target = await resolveServeTarget(config, options.url, options.kimiHome);
    const runDir = resolve(options.runDir ?? config.runDir);
    const plan = await planSessionSweep({ runDir, serveUrl: target.serveUrl, token: target.token, kimiHome: options.kimiHome ?? target.kimiHome });
    if (plan.error) throw new Error(plan.error);
    printSweepPlan(plan, typeof (options.kimiHome ?? target.kimiHome) === "string" && (options.kimiHome ?? target.kimiHome).length > 0);
    if (options.apply) {
      const ledger = resolve(serveMaintenanceDir(resolve(runDir, "..")), "sweep-ledger.jsonl");
      const summary = await applySessionSweep({ plan, serveUrl: target.serveUrl, token: target.token, ledgerPath: ledger });
      console.log(`Applied: deleted=${summary.deleted} already_gone=${summary.alreadyGone} failed=${summary.failed}`);
      console.log(`Ledger: ${ledger}`);
    } else {
      console.log("Dry-run (no deletion). Re-run with --apply to delete the DEL lines.");
    }
    return;
  }
  if (sub === "recycle") {
    const target = await resolveServeTarget(config, options.url, options.kimiHome);
    const runDir = resolve(options.runDir ?? config.runDir);
    const soakMs = Number.parseInt(String(options.soakMs ?? ""), 10);
    const result = await recycleServe({
      port: Number(new URL(target.serveUrl).port),
      serveUrl: target.serveUrl,
      token: target.token,
      workspaceDir: options.workspaceDir,
      kimiExe: options.kimiExe ?? "kimi",
      runDir,
      kimiAgentIds: target.kimiAgentIds,
      soakMs: Number.isFinite(soakMs) && soakMs >= 1000 ? soakMs : 12_000,
      lockRootDir: resolve(runDir, ".."),
      kimiHome: options.kimiHome ?? target.kimiHome,
    });
    console.log(JSON.stringify(result, null, 2));
    // TD-261（0063，opus/sol 合订）：结构化失败与"未就绪"都要非零退出——旧实现
    // 只认 refused，spawn 成功但没就绪（端口被抢/exe 起来即退）会以 exit 0 收场
    // =留下死 serve 却不报。restart:failed 额外带手动配方指路。
    if (result.refused || result.restart === "failed" || result.ready === false) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(
    `Unknown serve subcommand: ${sub ?? "(none)"}. Try: serve status | serve sweep [--apply] | serve recycle --workspace-dir <dir>`,
  );
}

export { serveCommand, resolveServeTarget };
