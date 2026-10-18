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

import { parseOptions, lanesDocForCall } from "./shared.js";
import { dispatchHoldsByLane } from "../dispatchResolution.js";
// R6-C3（P1-2）：displayWidth（东亚宽字符计 2）与引擎共用同一份实现——渲染层
// 不再持第二份宽度表（分层方向 commands → application 合法）。
import { runOnboarding, HOST_EXAMPLES_AUTHORITY, displayWidth, wrapDisplay, MAX_CANDIDATES } from "../application/onboarding.js";
// TD-191② / 决定 0043：--host 指引消费 hostDescriptors 唯一权威（同一张表）。
import * as hostDescriptors from "../hostAdapters/hostDescriptors.js";
// R6-C: key probing reuses the credential-readiness SSOT (process env → Windows
// User scope) — no second registry read or env-name policy here.
// 决定 0074：kimiHome 车道的 token 文件探测同样复用 credentialReadiness 的单一
// 判定（registry_list 取值 / doctor 体检 / 派发侧拒绝同源）。
import { resolveCredentialEnv, kimiHomeTokenFileState } from "../application/credentialReadiness.js";
// R9（决策 0023）：会审就绪分级块的族系展示标签（推断，非契约）。
import { familyLabel } from "../application/modelFamily.js";

// ── R6-C: production environment probe ───────────────────────────────────────
// One probeEnv per command invocation, passed to the pure recommendation engine.
// Bounded per buildRecommendations call: ≤4 CLI probes (one per distinct
// required CLI) + ≤N key probes (one per distinct declared env name); the
// engine memoizes per unique name. R10-B 会为已配置面（私有 registry 存在且
// 可读 / --apply 写入后）加一次同形调用——总界 ≤8 CLI + ≤2N key 探针，仍是
// 常数界。Every probe carries a timeout / graceful failure path and can never
// block output.
//
// CLI probing reuses the doctor whichCli pattern (`where`/`which`) PLUS a
// per-probe timeout that doctor's version lacks: a timeout/kill/spawn failure
// degrades to "unknown" (displayed truthfully), while a checked non-zero exit
// ("not on PATH") is a definite false.
// Key probing reuses resolveCredentialEnv: its internal Windows User-scope read
// is already 5s-bounded; a reader failure falls back to "missing" by that
// module's contract and never throws.

const CLI_PROBE_TIMEOUT_MS = 5000; // per CLI probe (matches credentialReadiness 5s)

// 0064：探测实现共享导出——wao lanes 复用同一份探测（会审 P1：不得复制出
// 第二套实现）。仅新增 export，函数本体零改动。
export async function probeCliOnPath(name) {
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

export async function probeKeyEnvSource(name) {
  const r = await resolveCredentialEnv(name);
  return r.source; // "process_env" | "user_env" | "missing"
}

// 0064/决定 0074：kimiHome 车道的 token 文件探测（wao lanes 复用同一份——探测
// 实现共享导出，不复制第二套）。判定单一实现 credentialReadiness.kimiHomeTokenFileState；
// 只报 present/missing，绝不回显文件内容。
export async function probeKimiTokenFile(tokenFile) {
  return kimiHomeTokenFileState(tokenFile);
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
  // TD-191②：--host <id> —— 第三方宿主一站式注册指引。决定 0066：表外宿主不再
  // 报错退出——给通用 stdio 指引（不猜测该宿主的配置语法；入表路径见
  // AGENT_ONBOARDING.md Owner 清单），且指引块排在第一屏、先于 worker 选择。
  if (options.host !== undefined) {
    validateHostGuideOption(options.host);
  }
  const guideHostId = options.host;
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
    // R10-B：readiness 块的已配置面输入（只读）——与 --apply 的目标同一路径：
    // 私有 registry 已存在且可读时，会审就绪块按它的真实行探测展示。
    privateRegistryPath: targetRegistryPath,
    fs: { readFile, writeFile, rename, existsSync, unlink, mkdir },
    // R6-C: production environment probe (injected; the service stays pure).
    // 决定 0074：kimiHome 车道就绪按 token 文件推导（同一探测实现）。
    probeEnv: { hasCli: probeCliOnPath, hasKeyEnv: probeKeyEnvSource, hasKimiTokenFile: probeKimiTokenFile },
    // 决定 0090：会审就绪块不把车道表里暂停派发的车道算作候选。非默认 --registry
    // 时车道表停用（防跨绑，lanesDocForCall），没有暂停说明。
    dispatchHolds: dispatchHoldsByLane(lanesDocForCall(options, config, config?.loadLanesConfigFn)),
  });

  if (json) {
    if (guideHostId) console.log(JSON.stringify({ ...result, hostGuide: buildHostGuide(guideHostId, result) }, null, 2));
    else console.log(JSON.stringify(result, null, 2));
  } else {
    // 决定 0066：--host 是在问"这个宿主怎么注册"——答案放第一屏（2026-10-12 反馈：
    // 原先排在 worker 选择矩阵之后，Lead 看到的第一屏是 NEEDS-SELECTION）。
    const human = guideHostId
      ? renderHostGuideBlock(guideHostId, result).replace(/^\n/, "") + "\n" + renderHuman(result)
      : renderHuman(result);
    process.stdout.write(human);
  }

  // Soft outcomes (refused/error) are reported truthfully but exit non-zero so
  // scripts/CI can gate on them without parsing JSON.
  if (result.outcome === "refused" || result.outcome === "error") {
    process.exitCode = 1;
  }
}

// ── TD-191②：--host 宿主一站式注册指引（决定 0043）─────────────────────────────

/** --host 必须带 id；表内表外都接受（表外走通用指引，决定 0066）。 */
function validateHostGuideOption(host) {
  if (typeof host !== "string" || host.length === 0) {
    throw new Error(`wao onboarding --host requires a host id (known hosts: ${hostDescriptors.HOST_DESCRIPTOR_IDS.join(", ")})`);
  }
}

/** 组装宿主指引对象（--json 的 hostGuide 字段）。表外宿主 = 通用指引（known:false）。 */
export function buildHostGuide(hostId, result) {
  const d = hostDescriptors.findHostDescriptor(hostId);
  if (!d) {
    return {
      host: hostId,
      known: false,
      knownHosts: hostDescriptors.HOST_DESCRIPTOR_IDS,
      capabilities: { snippet: false, autoBind: false, hostVerified: false },
      example: null,
      bindCommand: null,
    };
  }
  const example = (result.hostExamples ?? []).find((e) => e.host === hostId) ?? null;
  return {
    host: d.id,
    label: d.label,
    capabilities: { snippet: d.snippet, autoBind: d.autoBind, hostVerified: d.hostVerified },
    example,
    bindCommand: d.autoBind ? `mcp bind --host ${d.id} --cwd <git-root>` : null,
    ...(d.configHint ? { configFile: d.configHint } : {}),
  };
}

/** 人读宿主指引块（决定 0066 起排在 renderHuman 之前——第一屏）。 */
export function renderHostGuideBlock(hostId, result) {
  const d = hostDescriptors.findHostDescriptor(hostId);
  if (!d) {
    return [
      "",
      `── Host registration (host: ${hostId} — not in the verified host table) ──`,
      `Known hosts: ${hostDescriptors.HOST_DESCRIPTOR_IDS.join(", ")}.`,
      `${hostId} gets the generic route — WAO has not verified its config syntax or that it loads WAO:`,
      `  1. Register a stdio MCP server named "wao" using the host-neutral snippet below (or: npm run cli -- mcp bind --host ${hostId}).`,
      `  2. Start a new ${hostId} session and confirm the WAO tools are listed.`,
      `  3. WAO cannot probe ${hostId}; to add it to the table follow the real-host admission checklist in AGENT_ONBOARDING.md.`,
      "",
    ].join("\n");
  }
  const guide = buildHostGuide(hostId, result);
  const lines = [
    "",
    `── Host-specific registration (host: ${d.id} / ${d.label}) ──`,
    `Capabilities (decision 0043): snippet=${d.snippet} · autoBind=${d.autoBind} · hostVerified=${d.hostVerified}`,
  ];
  if (d.autoBind) {
    lines.push(`One command, WAO writes ${d.id} project config:`);
    lines.push(`  npm run cli -- mcp bind --host ${d.id} --cwd <git-root>`);
    lines.push(`(then restart ${d.id} / open a new ${d.label} task in that project)`);
  } else {
    lines.push(`${d.id} is a snippet-only host — WAO never writes its config:`);
    if (d.configHint) {
      // 文件式注册的宿主：片段必须是该宿主自己的配置形态（如 opencode 的顶层 mcp
      // 段），不是下方的 host-neutral mcpServers JSON——会审 sol 席指出的格式矛盾。
      lines.push(`  1. Print the entry in ${d.id}'s own config shape: npm run cli -- mcp bind --host ${d.id}`);
      lines.push(`  2. Merge that entry into ${d.configHint} (${d.id} has no registration command; do not paste the host-neutral snippet below — its shape may differ).`);
      lines.push(`  3. Restart ${d.id}.`);
    } else {
      lines.push(`  1. Register via the host's own route (exact command/snippet: npm run cli -- mcp bind --host ${d.id}):`);
      if (guide.example) lines.push(`     ${guide.example.command}${guide.example.stability === "stable" ? "" : `   [${guide.example.stability}]`}`);
      lines.push(`  2. Restart ${d.id}.`);
    }
  }
  lines.push(`Is it registered? npm run cli -- mcp status --host ${d.id}   (read-only probe of ${d.id}'s own config)`);
  lines.push(`hostVerified=${d.hostVerified} — ${d.hostVerified ? "load verified on the real host (evidence in hostDescriptors.js)" : "format-level admission only; real-host load NOT yet verified (admission checklist: AGENT_ONBOARDING.md)"}.`);
  lines.push("");
  return lines.join("\n");
}

// Human-readable rendering of the bounded result. Single-sourced from the same
// object that --json emits. Exported so the acceptance guidance shared by human
// output (not just --json) is covered by focused tests.
export function renderHuman(r) {
  const lines = [];
  const tag = r.outcome.toUpperCase();
  lines.push(`wao onboarding: ${tag}`);

  if (r.needsSelection) {
    // TD-260（0062 B10①）：needs-selection 是正常交互出口（exit 0、零写入——
    // 0023 双出口设计），人读首行不得像报错；--json 的 outcome 枚举不动。
    lines.push("No --agent selected — this is a normal preview exit (no error, nothing written).");
    lines.push("Mutation requires an explicit selection.");
    lines.push("Candidates from the tracked template:");
    for (const c of r.candidates) {
      lines.push(`  - ${c.id}  (backend: ${c.backend ?? "?"}, model: ${c.model ?? "?"})`);
    }
    lines.push("");
    // TD-260（0062 B8 记法）：规范形统一 npm run cli --，第三行给全局 wao 的写法。
    lines.push("Re-run with: npm run cli -- wao onboarding --agent <id>          # preview");
    lines.push("            npm run cli -- wao onboarding --agent <id> --apply    # write config/agents.json");
    lines.push("            (global form: wao onboarding --agent <id>)");

    // R6-C: lane matrix + current-environment fit (advisory). Rows are derived
    // from the template rows and the injected probe; the engine already sorted
    // them ready-first. The tail line hands the choice back to the user.
    //
    // R6-C3（P1-2 + 席位 B）：表头 + 每个 worker 两行，全部列宽按显示宽（东亚宽
    // 字符计 2）计算——padEnd 按码元计宽曾把中文认证列后面的整列右移几十格。
    // 第一行 id/backend/model/状态 ≤ ~70 显示格；第二行认证标签整段截到 56 显示格，
    // 120 列终端不再折行错位。
    //
    // R11-2（决策 0024）：双源矩阵——私有 registry 在场且可读时，矩阵 =
    // 已配置行（真实状态，私有 registry 顺序稳定，不打来源标）+ 模板未配置候选
    // （ready-first，行尾 ·模板候选）。混合判定来自 recommendations 携带的
    // configuredCount 事实（不按行内容推导：0 有效行的 registry 仍是已配置面）。
    // 表头混合句、行尾标、drift 明细与截断尾注全是同一 recommendations 对象的
    // 投影（渲染层不写第二事实源）。
    const rows = Array.isArray(r.recommendations?.rows) ? r.recommendations.rows : [];
    if (rows.length > 0) {
      const mixed = typeof r.recommendations?.configuredCount === "number";
      lines.push("");
      lines.push(`车道矩阵与当前环境适配（${r.recommendations.advisory}）:`);
      if (mixed) {
        // 0024(1)：表头一句交代混合（N = 私有有效行总数，M = 模板未配置候选总数）。
        lines.push(`  矩阵 = 你的 config/agents.json（${r.recommendations.configuredCount} 名）+ 模板未配置候选（${r.recommendations.templateCandidateCount} 名）`);
      }
      lines.push(`  ${padEndDisplay("id", 24)} ${padEndDisplay("backend", 15)} ${padEndDisplay("model", 19)} 状态`);
      for (const row of rows) {
        // 行 1 尾紧凑旗标（source 字段的投影）：模板候选 ·模板候选；drift 行 ·drift。
        const mark = !mixed ? "" : row.source === "configured"
          ? (row.drift ? " ·drift" : "")
          : " ·模板候选";
        lines.push(`  ${padEndDisplay(row.id ?? "?", 24)} ${padEndDisplay(row.backend ?? "?", 15)} ${padEndDisplay(row.model ?? "?", 19)} [${recommendationReadyLabel(row)}]${mark}`);
        lines.push(`    ${truncateDisplay(recommendationAuthLabel(row), 56)}`);
      }
      if (mixed) {
        // 0024(4)：drift 有界明细（≤3 条 + "另有 K 条"尾注）——值全从行字段投影。
        const drifts = rows.filter((row) => row.drift);
        for (const row of drifts.slice(0, 3)) {
          // d′（决定 0044）：effort 维（模板侧值展示，私有侧语义=不相等）与
          // 认证矩阵行 modelId 维各占一段——10-05 两起漏面的对应可见面。
          const eff = row.drift.templateEffort !== undefined ? `/effort=${row.drift.templateEffort}` : "";
          lines.push(`  drift: ${row.id} 私有 model=${row.model ?? "?"}/backend=${row.backend ?? "?"} ≠ 模板 ${row.drift.templateModel ?? "?"}/${row.drift.templateBackend ?? "?"}${eff}`);
          if (row.drift.matrix) {
            lines.push(`  drift(矩阵): ${row.id} 认证矩阵 modelId=${row.drift.matrix.liveModelId} ≠ 模板矩阵 ${row.drift.matrix.templateModelId}`);
          }
        }
        if (drifts.length > 3) {
          lines.push(`  另有 ${drifts.length - 3} 条 drift 明细未显示`);
        }
        // 0024(6)：截断尾注——私有超帽 / 私有独占上限（模板显 0 + 指向模板文件）/
        // 模板溢出。帽不可被"私有全显"架空。
        if (r.recommendations.privateOmitted > 0) {
          lines.push(`  私有 registry 另有 ${r.recommendations.privateOmitted} 名有效 worker 超出 ${MAX_CANDIDATES} 行显示上限`);
        }
        if (r.recommendations.templateOmitted > 0) {
          const templateShownCount = rows.filter((row) => row.source === "template").length;
          if (templateShownCount === 0) {
            lines.push(`  模板候选未显示（私有行已占满 ${MAX_CANDIDATES} 行上限）——完整模板见 config/agents.example.json`);
          } else {
            lines.push(`  另有 ${r.recommendations.templateOmitted} 名模板候选未显示`);
          }
        }
      }
      // 决定 0090：车道用途与限制只写在车道画像；矩阵只管接线与认证就绪。
      lines.push("  各车道擅长什么、有什么限制：npm run cli -- wao lanes");
      // R9（决策 0023）：既有"会审备选"句升级为分级块（三席/两席/无 + 同族 +
      // 单 worker 注脚 + 登录态未验证），标签仍从模板行生、不动矩阵列宽。
      lines.push("");
      lines.push(...panelReadinessLines(r));
      lines.push("");
      // 0024(2)：表尾句扩词——防误选语义全部由这一句承担（不做逐行双标，列宽纪律）。
      lines.push(mixed
        ? "按你有的认证选一行重跑 --agent <id> --apply（--apply 仅适用模板候选行）；没有的 key 对应行可忽略。"
        : "按你有的认证选一行重跑 --agent <id> --apply；没有的 key 对应行可忽略。");
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
    // R9（决策 0023）：selected/--apply 分支同样打印分级块（与 --json 同源的
    // result.panelReadiness；R10-B 起面标签与输入行按 panelFace 切换，--apply
    // 写入后即已配置面）。输入行空（rowCount 0）时整块不打印。
    const panelLines = panelReadinessLines(r);
    if (panelLines.length > 0) {
      lines.push("");
      lines.push(...panelLines);
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
  // the snippet above; the snippet + docs/usage/host.md stay authoritative.
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

// ── R9 三席会审就绪分级块（决策 0023）────────────────────────────────────────
// 从 result.panelReadiness / panelFace（与 --json 同一对象派生，application 层
// 单一推导）渲染。数据源按面（R10-B）：模板面 = 入库模板行 + 环境探测；已配置面
// = 私有 config/agents.json 的行 + 同一探测实现（私有 registry 存在且可读 /
// --apply 写入后）。advisory：只提示不替 Lead 选位；每行显示宽 ≤120
// （displayWidth 纪律与矩阵块一致）。输入行空（rowCount 0）时整块不打印
// （R10-C C-2 例外：已配置面存在被剔除的无效条目时仍打印，让提示行在场）。
function panelReadinessLines(r) {
  const p = r.panelReadiness;
  // R10-C C-2：已配置面存在被剔除的无效条目时，即使有效行为 0 也渲染本块——
  // 否则"rows 空整块不打印"会把全无效 registry 静默成无信号（提示行必须在场）。
  const droppedEntries = r.panelFace === "configured" && Number(r.panelInvalidEntryCount) > 0;
  if (!p || (!p.rowCount && !droppedEntries)) return [];
  // R10-B：面标签（已配置面/模板面）——两个面的引擎与探测实现同一份。
  const faceLabel = r.panelFace === "configured" ? "已配置面" : "模板面";
  // C-9：族系标签带"推断"字样——推断族系非契约，用户面不把标签讲成事实。
  const seat = (e) => `${e.id}（推断族系：${familyLabel(e.family)}）`;
  const lines = [];
  if (p.tier === "three_seat") {
    lines.push(`会审就绪（${faceLabel}·按当前环境探测，决策 0023）: 三席可配——探测候选 ≥2（推荐标准：Lead 主审 + 两名副审；候选计数是探测口径，不声称已配齐可派发副审）`);
    lines.push(`  建议配对（族系最大化展示，选位权在 Lead）: ${seat(p.seats[0])} + ${seat(p.seats[1])}`);
    if (p.insufficientFamilyDiversity) {
      lines.push("  跨族系提示：可用候选的已知族系不足两族——副审建议来自不同族系（未知族系不参与判定）");
    }
  } else if (p.tier === "two_seat") {
    lines.push(`会审就绪（${faceLabel}·按当前环境探测，决策 0023）: 两席可配——探测候选恰 1（次之推荐：Lead 主审 + 一名副审）`);
    lines.push(`  可用候选: ${p.available.map(seat).join("、")}——补齐第二个候选（建议不同族系）可升级三席`);
    if (p.singleWorkerVacuous) {
      // R10-B：单 worker 注脚面感知——已配置面讲"registry 仅一名 worker"，
      // 模板面维持既有措辞。
      const subject = r.panelFace === "configured" ? "registry 仅一名 worker" : "模板仅一名 worker";
      lines.push(`  注：${subject}，它通常即被审产出的作者（0019 §3 作者回避）——两席建议事实空转`);
    }
  } else {
    lines.push(`会审就绪（${faceLabel}·按当前环境探测，决策 0023）: 当前零可用候选（探测口径）`);
    lines.push("  有意跳过会审时，在 wao stage 2/4 用 --panel-skip-reason 登记显式理由（强烈推荐但非强制）");
  }
  if (p.loginUnverified?.length > 0) {
    lines.push(`  登录态未验证（如实展示，不计入可用）: ${p.loginUnverified.join("、")}`);
  }
  // C-5：serve 注入型（opencode-serve）不是登录态型认证——单独措辞归类，
  // 不进"登录态未验证"行（引擎 readyState 原值不动，只改展示归类）。
  if (p.injectedAuth?.length > 0) {
    lines.push(`  注入式认证（serve 探测不覆盖，不计入可用）: ${p.injectedAuth.join("、")}`);
  }
  // C-12：探测未知如实展示一行（docblock 承诺的"如实展示"在此兑现）。
  if (p.probeUnknown?.length > 0) {
    lines.push(`  探测未知（如实展示，不计入可用）: ${p.probeUnknown.join("、")}`);
  }
  // TD-258：无 CLI 探测面的凭据声明车道（key_only_*）——不计入可用、不抬 tier，
  // 但绝不无声消失（key 检查细节见 wao doctor）。
  if (p.keyOnly?.length > 0) {
    lines.push(`  key 名已解析但无 CLI 探测面（未验证令牌/serve 可达性，不计入可用）: ${p.keyOnly.join("、")}`);
  }
  // 决定 0090：车道表带暂停说明的车道不算候选——每条一行、Owner 原话不截断
  // （超宽折行，每行 ≤120 显示格；只告知不拦截）。
  if (p.held?.length > 0) {
    lines.push("  暂停派发（车道表 dispatchHold，不计入候选）:");
    for (const h of p.held) {
      const [first, ...rest] = wrapDisplay(`${h.id}：${h.dispatchHold}`, 114);
      lines.push(`    ${first}`);
      for (const seg of rest) lines.push(`      ${seg}`);
    }
  }
  // 0065（0045 §1.2 终局）：0019 §3 席位惯例句（实现席/对抗席清单）随席位
  // 角色维退役删除——车道均可任副审（角色=派发时帽子），回避/组合由 Lead 按派生
  // 事实判断（wao stage 2/4 --reviewed-run 的作者车道派生）。
  // 同模型多键如实点名（tier 按行计数的虚高提示——opus P2 轻量版）。
  if (p.duplicateModelKeys?.length > 0) {
    const dup = p.duplicateModelKeys
      .map((g) => `${g.ids.join("+")}（同 ${g.backend ?? "?"}/${g.modelId ?? "?"}）`)
      .join("；");
    lines.push(`  注：同模型多键配置——${dup}——tier 按行计数时此类键会虚高候选数`);
  }
  // R10-B：私有 registry 存在但不可读 → 降级模板面 + 来源标注（不阻塞主流程）。
  if (r.panelSourceUnreadable) {
    lines.push("  注：私有 registry 读取失败——本块按模板面展示（已配置 worker 的真实状态请见 wao doctor）");
  }
  // R10-B：已配置面指针行——"真实状态以它为准"，完整体检指向 wao doctor。
  if (r.panelFace === "configured" && r.panelConfiguredCount !== null) {
    lines.push(`  已配置 ${r.panelConfiguredCount} 名 worker（真实状态以它为准）——完整体检见 \`wao doctor\``);
  }
  // R10-C C-2：无效条目剔除的有界提示——只给条数，不指名条目（坏值本身可能
  // 敏感/带注入载荷），修复出口指向共享校验权威面（registry validate）。
  if (droppedEntries) {
    lines.push(`  注：私有 registry 有 ${r.panelInvalidEntryCount} 条无效条目已剔除——run: npm run cli -- registry validate`);
  }
  return lines;
}

// ── R6-C human rendering helpers ─────────────────────────────────────────────
// Derived from the engine rows (single source). No second hand-written lane
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
  // 先起 serve（scripts/serve.ps1 注入；docs/usage/install.md 的 Provider key 一节是权威）。
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

/** readyState → human bracket label (ready / missing / login / probe-failed). */
function recommendationReadyLabel(row) {
  // R6-C3（P2-2）：opencode-serve 的可用性取决于 serve 进程是否可达，PATH 上有
  // opencode CLI ≠ serve 已注入 key——不再误标 [CLI 登录态]。仅改显示，
  // 引擎 readyState 值不变。
  if (row.backend === "opencode-serve") return "serve 探测未覆盖";
  // TD-258（opus 显示修正）：zcode 无 CLI 探测面（binary 绝对路径直连）——
  // "探测失败"对从未探测的车道是错标；kimi-web 探测异常时同理。
  if (row.backend === "zcode") return "无 CLI 探测面（binary 直连）";
  if (row.backend === "kimi-web" && row.readyState === "unknown") return "serve 探测未覆盖";
  switch (row.readyState) {
    case "ready": return "ready";
    case "login_based": return "CLI 登录态";
    case "key_only_present": return "key 名已解析（无 CLI 探测面，未验 serve/令牌）";
    case "key_only_missing": return `缺 ${row.requiresKeyEnv}（无 CLI 探测面）`;
    case "missing_cli": return `缺 ${row.requiresCli} CLI`;
    case "missing_key": return `缺 ${row.requiresKeyEnv}`;
    case "missing_both": return `缺 ${row.requiresCli} CLI + 缺 ${row.requiresKeyEnv}`;
    default: return "探测失败，结果未知";
  }
}
