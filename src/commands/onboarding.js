// src/commands/onboarding.js
//
// `wao onboarding` — third-party onboarding helper command (parsing/printing only).
//
// A fresh third-party clone generates ONE minimal private worker registry from the
// tracked config/agents.example.json template, without hand-editing the seven-worker
// template. Zero-write by default; --apply writes only the gitignored
// config/agents.json; --endorse-worker writes only the manualOverride:"cleared"
// Owner signal into runs/reliability-summary.json. The command also prints a
// host-neutral MCP stdio snippet for wiring the worker into an MCP host.
//
// This module is THIN: it parses args, wires the real (injectable) filesystem,
// wires the production environment probe (R6-C), calls the pure service
// (src/application/onboarding.js), and prints ONE bounded structured result as
// JSON (--json) or human text. All policy/safety logic lives in the service;
// this layer adds none. It does not import the MCP SDK or the registry/backend
// run path; the R6-C probe uses a lazy child-process import (the doctor whichCli
// pattern plus a per-probe timeout) and the credentialReadiness SSOT.

import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { parseOptions } from "./shared.js";
// R6-C3（P1-2）：displayWidth（东亚宽字符计 2）与引擎共用同一份实现——渲染层
// 不再持第二份宽度表（分层方向 commands → application 合法）。
import { runOnboarding, HOST_EXAMPLES_AUTHORITY, displayWidth } from "../application/onboarding.js";
// R6-C: key probing reuses the credential-readiness SSOT (process env → Windows
// User scope) — no second registry read or env-name policy here.
import { resolveCredentialEnv } from "../application/credentialReadiness.js";

// ── R6-C: production environment probe ───────────────────────────────────────
// One probeEnv per command invocation, passed to the pure recommendation engine.
// Bounded: ≤4 CLI probes (one per distinct required CLI) + ≤N key probes (one
// per distinct declared env name); the engine memoizes per unique name. Every
// probe carries a timeout / graceful failure path and can never block output.
//
// CLI probing reuses the doctor whichCli pattern (`where`/`which`) PLUS a
// per-probe timeout that doctor's version lacks: a timeout/kill/spawn failure
// degrades to "unknown" (displayed truthfully), while a checked non-zero exit
// ("not on PATH") is a definite false.
// Key probing reuses resolveCredentialEnv: its internal Windows User-scope read
// is already 5s-bounded; a reader failure falls back to "missing" by that
// module's contract and never throws.

const CLI_PROBE_TIMEOUT_MS = 5000; // per CLI probe (matches credentialReadiness 5s)

async function probeCliOnPath(name) {
  const { execSync } = await import("node:child_process");
  try {
    execSync(process.platform === "win32" ? `where ${name}` : `which ${name}`, {
      stdio: "ignore",
      windowsHide: true,
      timeout: CLI_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    // `where`/`which` ran and answered "not found" (non-zero exit) → definite
    // missing. Timeout/kill/spawn failure → cannot evaluate → "unknown".
    return typeof err?.status === "number" ? false : "unknown";
  }
}

async function probeKeyEnvSource(name) {
  const r = await resolveCredentialEnv(name);
  return r.source; // "process_env" | "user_env" | "missing"
}

// The trusted WAO installation root = where THIS command lives, three levels up
// (src/commands/onboarding.js → repo root). Independent of the caller cwd, matching
// the installRoot.js philosophy. Injectable via --install-root.
const DEFAULT_INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * `wao onboarding` command.
 *
 * @param {string[]} args
 * @param {object} config — merged CLI config (config.registry / config.runDir are
 *   already rebased to the trusted install root by loadConfig when WAO_INSTALL_ROOT
 *   is set; legacy resolution otherwise).
 */
export async function onboardingCommand(args, config) {
  const options = parseOptions(args);

  const agentId = options.agent; // undefined ⇒ needs-selection
  const apply = options.apply === true;
  const json = options.json === true;
  // --endorse-worker requires an explicit <id>; a bare flag is malformed usage.
  if (options.endorseWorker === true) {
    throw new Error("wao onboarding --endorse-worker requires an <id> (must match --agent)");
  }
  const endorseWorker = options.endorseWorker;

  const installRoot = options.installRoot ?? DEFAULT_INSTALL_ROOT;
  const exampleRegistryPath = options.exampleRegistry
    ?? join(installRoot, "config/agents.example.json");
  // The private registry path authority is config.registry (same path every wao
  // command uses); --registry is an explicit override.
  const targetRegistryPath = options.registry ?? config.registry;
  // The reliability summary lives under the shared runDir; --reliability-summary
  // is an explicit override.
  const reliabilitySummaryPath = options.reliabilitySummary
    ?? join(resolve(config.runDir), "reliability-summary.json");

  const result = await runOnboarding({
    agentId,
    apply,
    endorseWorker,
    installRoot,
    exampleRegistryPath,
    targetRegistryPath,
    reliabilitySummaryPath,
    fs: { readFile, writeFile, rename, existsSync, unlink, mkdir },
    // R6-C: production environment probe (injected; the service stays pure).
    probeEnv: { hasCli: probeCliOnPath, hasKeyEnv: probeKeyEnvSource },
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(renderHuman(result));
  }

  // Soft outcomes (refused/error) are reported truthfully but exit non-zero so
  // scripts/CI can gate on them without parsing JSON.
  if (result.outcome === "refused" || result.outcome === "error") {
    process.exitCode = 1;
  }
}

// Human-readable rendering of the bounded result. Single-sourced from the same
// object that --json emits. Exported so the acceptance guidance shared by human
// output (not just --json) is covered by focused tests.
export function renderHuman(r) {
  const lines = [];
  const tag = r.outcome.toUpperCase();
  lines.push(`wao onboarding: ${tag}`);

  if (r.needsSelection) {
    lines.push("No --agent selected — mutation requires an explicit selection.");
    lines.push("Candidates from the tracked template:");
    for (const c of r.candidates) {
      lines.push(`  - ${c.id}  (backend: ${c.backend ?? "?"}, model: ${c.model ?? "?"})`);
    }
    lines.push("");
    lines.push("Re-run with: wao onboarding --agent <id>            # preview");
    lines.push("            wao onboarding --agent <id> --apply      # write config/agents.json");

    // R6-C: role matrix + current-environment fit (advisory). Rows are derived
    // from the template rows and the injected probe; the engine already sorted
    // them ready-first. The tail line hands the choice back to the user.
    //
    // R6-C3（P1-2 + 席位 B）：表头 + 每个 worker 两行，全部列宽按显示宽（东亚宽
    // 字符计 2）计算——padEnd 按码元计宽曾把中文认证列后面的整列右移几十格。
    // 第一行 id/backend/model/状态 ≤ ~70 显示格；第二行 认证/适合 ≤ ~125 显示格
    // （认证标签整段截到 60、duty 截到 50），120 列终端不再折行错位。
    const rows = Array.isArray(r.recommendations?.rows) ? r.recommendations.rows : [];
    if (rows.length > 0) {
      lines.push("");
      lines.push(`角色矩阵与当前环境适配（${r.recommendations.advisory}）:`);
      lines.push(`  ${padEndDisplay("id", 24)} ${padEndDisplay("backend", 15)} ${padEndDisplay("model", 19)} 状态`);
      for (const row of rows) {
        lines.push(`  ${padEndDisplay(row.id ?? "?", 24)} ${padEndDisplay(row.backend ?? "?", 15)} ${padEndDisplay(row.model ?? "?", 19)} [${recommendationReadyLabel(row)}]`);
        lines.push(`    ${truncateDisplay(recommendationAuthLabel(row), 56)} · 适合: ${truncateDisplay(recommendationDutyDisplay(row.duty), 50)}`);
      }
      // R6-C3（P1-1）+ 复核 R1：替补句从矩阵行派生——只枚举模板里实际存在的 coder_*
      // 通道，零 coder 行时整句不打印（labels are shape-derived）。措辞不定性到
      // "实现席"（ADR 0019 的实现席是 hq/low 取一、对抗席默认 auditor 可换
      // coder_mm——派生集合里的 coder_mm/fallback 不该被定性为实现席备选），
      // 只说"可作会审备选"并把两席规则交给 ADR 0019。拆两行控制显示宽 ≤120。
      // 本矩阵不替 Lead 选择。
      const coderRows = rows.filter((row) => /^coder_/.test(String(row.id ?? "")));
      if (coderRows.length > 0) {
        lines.push("");
        lines.push(`会审备选：本矩阵中的 coder 通道（${coderRows.map((row) => row.id).join("、")}）均可入席；`);
        lines.push("两席分配（实现席避同族取一；对抗席默认 auditor、可换 coder_mm）与选位权见 ADR 0019，由 Lead 自行决定。");
      }
      lines.push("");
      lines.push("按你有的认证选一行重跑 --agent <id> --apply；没有的 key 对应行可忽略。");
    }
  } else if (r.selected) {
    const written = [];
    if (r.writes.registry) written.push("config/agents.json");
    if (r.writes.endorsement) written.push("runs/reliability-summary.json (manualOverride:cleared)");
    lines.push(r.writes.registry || r.writes.endorsement
      ? `Applied. Wrote: ${written.join(", ")}.`
      : "Preview only — no files written. Add --apply to write config/agents.json.");
    if (r.certification?.strictCommand) {
      const endorseTxt = r.certification.endorsed
        ? " (endorsed: manualOverride:cleared written)"
        : " (--endorse-worker <id> writes the manual clearance instead)";
      lines.push(`Strict certification path: \`${r.certification.strictCommand}\`${endorseTxt}`);
    }
  }

  if (r.reason) lines.push(`Reason: ${r.reason}`);

  // Acceptance recipe — bounded, host-neutral, advisory. Single-sourced from
  // r.acceptance (the same object --json emits). Gives a Fresh Lead the three
  // MCP steps, the PASS facts, and the four closed recovery branches without
  // loading the full Skill. Advisory only — no prescription, no auto-mutation.
  if (r.acceptance) {
    const a = r.acceptance;
    lines.push("");
    lines.push("Acceptance recipe (advisory, host-neutral):");
    lines.push(`MCP chain: ${a.chain.map((s) => s.step).join(" → ")} (canary is read-only, no delivery)`);
    lines.push(`PASS requires ALL: ${a.pass.facts.join(" + ")}.`);
    lines.push("run_dispatch accepted (runId returned) is NOT PASS.");
    lines.push("A returned runId binds all later observation.");
    lines.push("Recovery branches:");
    for (const b of a.branches) {
      lines.push(`  ${b.key.padEnd(18)} — ${b.advisory}`);
    }
  }

  // The host-neutral MCP stdio snippet — the practical wiring output.
  lines.push("");
  lines.push("Host-neutral MCP stdio snippet (add to your MCP host config):");
  lines.push("```json");
  lines.push(JSON.stringify(r.mcpSnippet, null, 2));
  lines.push("```");

  // R5-D: per-host one-line registration EXAMPLES — conveniences derived from
  // the snippet above; the snippet + docs/usage.md §MCP stdio stay authoritative.
  if (Array.isArray(r.hostExamples) && r.hostExamples.length > 0) {
    lines.push("");
    lines.push(`One-line registration examples (${HOST_EXAMPLES_AUTHORITY}):`);
    for (const ex of r.hostExamples) {
      const tag = ex.stability === "stable" ? "" : `   [${ex.stability}]`;
      lines.push(`  ${ex.command}${tag}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

// ── R6-C human rendering helpers ─────────────────────────────────────────────
// Derived from the engine rows (single source). No second hand-written role
// table: labels are shape-derived (key env name / CLI login state) and the only
// per-worker auth text comes from the template's _comment_auth (carried as
// row.authNote).

/** 按显示宽右补空格到 width（超宽原样返回，不截断）。 */
function padEndDisplay(str, width) {
  const s = String(str ?? "");
  const w = displayWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/** 按显示宽截断：超过 width 时截到 width-1 并以 marker（默认 …）收尾。 */
function truncateDisplay(str, width, marker = "…") {
  const s = String(str ?? "");
  if (displayWidth(s) <= width) return s;
  const budget = width - displayWidth(marker);
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + marker;
}

/** 认证方式 column: declared key env name, or CLI login state (+ template note). */
function recommendationAuthLabel(row) {
  // R6-C2: 结构化认证标签——登录态行必须写明"具体哪个 CLI"（Owner 反馈），
  // authNote 只作补充（模板 _comment_auth），不再替代结构化基座。
  if (row.requiresKeyEnv) return `认证: key ${row.requiresKeyEnv}`;
  let base;
  // R6-C3（P2-2）："注入"单独出现会被读成无需 key——补明仍需 provider key 且要
  // 先起 serve（scripts/serve.ps1 注入；docs/usage.md §Provider key 是权威）。
  if (row.backend === "opencode-serve") {
    base = "认证: opencode serve 注入（仍需 provider key，先起 scripts/serve.ps1）";
  } else if (row.requiresCli) {
    base = `认证: ${row.requiresCli} CLI 登录态`;
  } else {
    base = "认证: —";
  }
  if (row.authNote) return `${base}（${row.authNote}）`;
  return base;
}

/** duty display: _comment_task rows start with "适合任务: "/"默认适合: " — strip for display. */
function recommendationDutyDisplay(duty) {
  if (typeof duty !== "string" || duty.length === 0) return "?";
  return duty.replace(/^(适合任务|默认适合)\s*[:：]\s*/, "");
}

/** readyState → human bracket label (ready / missing / login / probe-failed). */
function recommendationReadyLabel(row) {
  // R6-C3（P2-2）：opencode-serve 的可用性取决于 serve 进程是否可达，PATH 上有
  // opencode CLI ≠ serve 已注入 key——不再误标 [CLI 登录态]。仅改显示，
  // 引擎 readyState 值不变。
  if (row.backend === "opencode-serve") return "serve 探测未覆盖";
  switch (row.readyState) {
    case "ready": return "ready";
    case "login_based": return "CLI 登录态";
    case "missing_cli": return `缺 ${row.requiresCli} CLI`;
    case "missing_key": return `缺 ${row.requiresKeyEnv}`;
    case "missing_both": return `缺 ${row.requiresCli} CLI + 缺 ${row.requiresKeyEnv}`;
    default: return "探测失败，结果未知";
  }
}
