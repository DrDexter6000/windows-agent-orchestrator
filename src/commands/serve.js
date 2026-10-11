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
// 边界（会审定案）：不挂 daemon、无自动触发；recycle 必须显式
// --workspace-dir（重启 cwd，无隐藏默认——env 由命令组装 WAO_IN_WORKER=1）；
// sweep 默认 dry-run，--apply 才执行。

import { resolve } from "node:path";
import { parseOptions } from "./shared.js";
import { readRegistry } from "../registry.js";
import {
  serveStatusReport,
  planSessionSweep,
  applySessionSweep,
  recycleServe,
  serveMaintenanceDir,
} from "../application/serveMaintenance.js";

/** 解析目标 serve（url/token/agentId）与 kimi 席位集合。固定错误点名缺席面。 */
async function resolveServeTarget(config, urlOverride) {
  const registryPath = resolve(config.registry ?? "config/agents.json");
  const registry = await readRegistry(registryPath);
  const kimiAgents = registry.listAgents().filter((a) => a.backend === "kimi-web");
  if (kimiAgents.length === 0) {
    throw new Error("no kimi-web agent in registry — wao serve requires a kimi-web lane entry (serveUrl/tokenEnv)");
  }
  const target = urlOverride
    ? kimiAgents.find((a) => a.serveUrl === urlOverride) ?? kimiAgents[0]
    : kimiAgents[0];
  const token = process.env[target.tokenEnv];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(`serve auth env is absent: set ${target.tokenEnv} (value is never echoed)`);
  }
  return {
    serveUrl: target.serveUrl,
    token,
    kimiAgentIds: kimiAgents.map((a) => a.id),
  };
}

function printSweepPlan(plan) {
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
  console.log("NOTE: the kimi session store is SHARED across serve instances — this sweep");
  console.log("deletes WAO-claimed sessions via the target serve regardless of which instance ran them.");
}

async function serveCommand(args, config) {
  const [sub, ...tail] = args;
  const options = parseOptions(tail);
  if (sub === "status") {
    const target = await resolveServeTarget(config, options.url);
    const report = await serveStatusReport({
      port: Number(new URL(target.serveUrl).port),
      serveUrl: target.serveUrl,
      token: target.token,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (sub === "sweep") {
    const target = await resolveServeTarget(config, options.url);
    const runDir = resolve(options.runDir ?? config.runDir);
    const plan = await planSessionSweep({ runDir, serveUrl: target.serveUrl, token: target.token });
    if (plan.error) throw new Error(plan.error);
    printSweepPlan(plan);
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
    const target = await resolveServeTarget(config, options.url);
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
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.refused) {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(
    `Unknown serve subcommand: ${sub ?? "(none)"}. Try: serve status | serve sweep [--apply] | serve recycle --workspace-dir <dir>`,
  );
}

export { serveCommand };
