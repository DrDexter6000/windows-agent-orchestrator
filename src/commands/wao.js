// src/commands/wao.js
//
// TD-98 阶段 2d：wao command family 从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：wao init | state | decision | handoff | declare | stage | ask | doctor | onboarding
//
// 依赖：
//   - 外部模块：../waoDir.js、../waoState.js、../waoDecisions.js、../waoDeclare.js、
//     ../waoStage.js、../waoHandoff.js
//   - 共享工具：./shared.js（parseOptions/resolveTargetCwd）
//   - doctor 子命令：./doctor.js（waoDoctorCommand）
//   - node built-in：fs/promises（readFile）、path（resolve/join）
//
// 注意：wao.js 不持有也不直接调用 runCommand（runCommand 由 commands/run.js 持有）。
// wao ask 子命令通过依赖注入接收 askHandler：cli.js 把 waoAskCommand 作为 deps.askHandler
// 注入 waoCommand，waoAskCommand 留在 cli.js 内部调用 commands/run.js 导出的 runCommand。
// DI 的目的：避免 wao.js 反向 import ../cli.js，保持依赖方向 cli.js -> wao.js。
//
// 本模块内部 helper：resolveArtifactPath（wao stage 的 run 路径解析，随 stage 搬迁）。

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { initWaoDir, getWaoDir } from "../waoDir.js";
import { writeStateSnapshot, readCurrentState } from "../waoState.js";
import { addDecision, listDecisions, readDecision } from "../waoDecisions.js";
import { addDeclare, listDeclares, summarizeDeclares, REASON_CODES } from "../waoDeclare.js";
import { addStage, summarizeStages, STAGE_NUMBERS, PANEL_SKIP_REASONS, PANEL_STAGES } from "../waoStage.js";
import { writeHandoff, readHandoff } from "../waoHandoff.js";
import { parseOptions, resolveTargetCwd } from "./shared.js";
import { waoDoctorCommand } from "./doctor.js";
import { onboardingCommand } from "./onboarding.js";

/**
 * TD-95 #7：解析 stage artifact 路径（随 wao stage 搬迁）。
 *
 * run 路径（runs/run_xxx.jsonl）的物理位置在 WAO repo 的 runDir，不在 --cwd 目标项目。
 * 裸相对路径从目标项目不可解析——解析为绝对路径让审计者能找到。
 */
export function resolveArtifactPath(artifact, waoRunDir) {
  // 已是绝对路径（含盘符或以 / 开头）→ 不动
  if (/^[A-Za-z]:[\\/]/.test(artifact) || artifact.startsWith("/")) {
    return artifact;
  }
  // run transcript 路径 → 相对 WAO runDir（transcript 物理位置）
  if (artifact.startsWith("runs/")) {
    return resolve(waoRunDir, "..", artifact);
  }
  // 其他（docs/ 等）→ 保持原样（相对目标项目，addStage 只存字符串不解析）
  return artifact;
}

async function waoInitCommand(args, config) {
  const options = parseOptions(args);
  const cwd = resolveTargetCwd(options);
  const override = options.stateDir ?? config.stateDir;
  await initWaoDir(cwd, override);
  const waoDir = getWaoDir(cwd, override);
  console.log(JSON.stringify({
    initialized: true,
    waoDir,
    slots: ["project.md", "state/", "decisions/", "pipeline/", "handoff/", "runs/"],
  }, null, 2));
}

async function waoHandoffCommand(args, config) {
  const [sub, ...tail] = args;
  const options = parseOptions(tail);
  const cwd = resolveTargetCwd(options);
  const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);

  if (sub === "write") {
    if (!options.from || !options.to) throw new Error("wao handoff write requires --from and --to");
    if (!options.summary) throw new Error("wao handoff write requires --summary");
    const path = await writeHandoff(waoDir, {
      from: options.from,
      to: options.to,
      summary: options.summary,
      artifacts: options.artifacts ? options.artifacts.split(",") : [],
      claims: [],
    });
    console.log(JSON.stringify({ written: true, path }, null, 2));
    return;
  }
  if (sub === "read") {
    const role = tail[0];
    if (!role) throw new Error("wao handoff read requires <role>");
    const body = await readHandoff(waoDir, role);
    if (!body) { console.log(JSON.stringify({ found: false }, null, 2)); return; }
    // TD-86（D2 A1）：--format json 输出 {found:true, role, body}（found:false 分支既有 JSON 不变）。
    if (options.format === "json") {
      console.log(JSON.stringify({ found: true, role, body }, null, 2));
      return;
    }
    console.log(body);
    return;
  }
  throw new Error(`Unknown wao handoff subcommand: ${sub ?? "(none)"}. Try: write | read`);
}

async function waoDecisionCommand(args, config) {
  const [sub, ...tail] = args;
  const options = parseOptions(tail);
  const cwd = resolveTargetCwd(options);
  const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);

  if (sub === "add") {
    if (!options.title) throw new Error("wao decision add requires --title");
    let body = options.body ?? "";
    if (options.bodyFile) body = await readFile(resolve(options.bodyFile), "utf8");
    const path = await addDecision(waoDir, {
      title: options.title,
      body,
      context: options.context,
    });
    console.log(JSON.stringify({ added: true, id: path.split(/[\\/]/).pop().slice(0, 4), path }, null, 2));
    return;
  }
  if (sub === "list") {
    const list = await listDecisions(waoDir);
    // TD-86（D2 A1）：--format json 包装 {decisions: string[]}——map 索引行原样，
    // 不发明 id/title 解析。
    if (options.format === "json") {
      console.log(JSON.stringify({ decisions: list }, null, 2));
      return;
    }
    for (const line of list) console.log(line);
    return;
  }
  if (sub === "show") {
    const id = tail[0];
    if (!id) throw new Error("wao decision show requires <id> (e.g. 0001)");
    const body = await readDecision(waoDir, id);
    console.log(body);
    return;
  }
  throw new Error(`Unknown wao decision subcommand: ${sub ?? "(none)"}. Try: add | list | show`);
}

/**
 * wao declare：Lead 自做声明（TD-82）。
 * Lead 自己完成一个本可派发的任务时，用此命令声明理由，让自做行为对用户/dashboard 可见。
 * 强制力 = 曝光（可见），不是拦截。Lead 仍全权可自做。
 * reason 必须是枚举值（REASON_CODES），防"声明"退化成自由文本失去约束力。
 */
async function waoDeclareCommand(args, config) {
  const options = parseOptions(args);
  const cwd = resolveTargetCwd(options);
  const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);

  if (options.task) {
    // add：写一条声明。--task 必填，--reason 必填且需在枚举内。
    if (!options.reason) {
      throw new Error(`wao declare requires --reason <code>。合法值：[${REASON_CODES.join(", ")}]`);
    }
    const path = await addDeclare(waoDir, {
      task: options.task,
      reason: options.reason,
      note: options.note,
    });
    console.log(JSON.stringify({ declared: true, path, reason: options.reason }, null, 2));
    return;
  }
  // 无 --task → 默认列出现有声明（裸 "wao declare" = 自省视图）。
  const summary = await summarizeDeclares(waoDir);
  const declares = await listDeclares(waoDir);
  console.log(JSON.stringify({ ...summary, declares }, null, 2));
}

/**
 * wao stage：Lead 阶段声明（TD-83）。
 * Lead 走完 pipeline 的一个阶段时，用此命令声明产物，让 pipeline 进度对用户/dashboard 可见。
 * 强制力 = 曝光（可见），不是拦截。Lead 仍全权可跳过任意阶段，但跳过会在 dashboard 留缺口。
 * stage 必须是枚举值（STAGE_NUMBERS = 1..6），防跳号或自造阶段逃避门控。
 *
 * R9（决策 0023，三席会审产品化）：stage 2（方案）/4（交付物验收）可携带
 * --panel-seats <id[,id]>（自报副审席位，registry 存在性校验）或
 * --panel-skip-reason <code>（跳过理由闭集码），两者互斥。其余阶段带 panel
 * 参数 fail-fast。Advisory 非门禁：无 panel 字段照常落盘（exit 0），输出
 * 加性 panelAdvisory 提示；stage 4 成功输出固定复述红线句。
 *
 * 用法：
 *   wao stage 1 --task "起草 auth 契约" --artifacts docs/01-prd.md
 *   wao stage 3 --task "派发实现" --artifacts runs/run_xxx.jsonl,runs/run_yyy.jsonl
 *   wao stage 2 --task "方案定稿" --panel-seats coder_hq,auditor --artifacts docs/plan.md
 *   wao stage 4 --task "验收" --panel-skip-reason low_risk_small_task
 *   wao stage              # 裸跑：列出已声明阶段 + 缺口 + panel/skip 分布（自省视图）
 */
async function waoStageCommand(args, config) {
  // 阶段号是位置参数（纯数字），不能用"第一个非 -- 开头"——那会误匹配 --cwd <path> 的路径值。
  // 用正则匹配首个纯数字 token，防 parseOptions 的值（如 /tmp/x、docs/y.md）被当成阶段号。
  const stageArg = args.find((a) => /^\d+$/.test(a));
  const options = parseOptions(args);
  const cwd = resolveTargetCwd(options);
  const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);

  if (stageArg !== undefined) {
    const stage = Number(stageArg);
    if (!options.task) {
      throw new Error(`wao stage requires --task <描述>。阶段 ${stageArg} 的产物描述是可见性的核心。`);
    }
    // R9：panel 参数解析 + fail-fast 校验（互斥 / 两节点限定 / 闭集 / registry 存在性）。
    const panel = await parsePanelOptions(stage, options, config);
    const rawArtifacts = options.artifacts
      ? options.artifacts.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    // TD-95 #7：run 路径 artifact 解析为绝对路径（跨项目时可解析）。
    // transcript 物理在 WAO repo 的 runDir，不在 --cwd 目标项目。裸 runs/run_xxx.jsonl
    // 从目标项目不可解析——解析为绝对路径让审计者能找到。panel 的评审旁证同走此路径。
    const waoRunDir = resolve(options.runDir ?? config.runDir);
    const artifacts = rawArtifacts?.map((a) => resolveArtifactPath(a, waoRunDir));
    const path = await addStage(waoDir, {
      stage,
      task: options.task,
      artifacts,
      note: options.note,
      panel,
    });
    // 纯 JSON 输出契约：新增提示只作加性字段（panelAdvisory / acceptanceRedLine /
    // panel），exit 0 不变——非门禁。
    const out = { staged: true, stage, path };
    if (panel) {
      out.panel = panel.seats
        ? { seats: panel.seats, note: "自报、未验证（registry 存在性已校验；不校验 ready 态/族系；评审旁证走 --artifacts 的 runs/<runId>.jsonl）" }
        : { skipReason: panel.skipReason };
    } else if (PANEL_STAGES.includes(stage)) {
      out.panelAdvisory =
        "未记录会审——三席会审是推荐标准（决策 0023）；有意跳过请用 --panel-skip-reason 登记理由";
    }
    if (stage === 4) {
      out.acceptanceRedLine = "评审意见是证据不是验收；run_delivery_decide 只由 Lead 调用";
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  // 无阶段号 → 默认列出已声明阶段 + 缺口（裸 "wao stage" = pipeline 自省视图）。
  const summary = await summarizeStages(waoDir);
  const progress = STAGE_NUMBERS.map((n) => `[${n}]${summary.declared.has(n) ? "✓" : "—"}`).join(" ");
  // 注意：declared 是 Set，JSON.stringify(Set) → {}。转数组输出，便于人读 + pipeline 解析。
  // R9：panel 分布（席位记录数 + skip 理由分布，仿 declare byReason）为加性字段。
  console.log(JSON.stringify({
    declared: [...summary.declared].sort((a, b) => a - b),
    count: summary.count,
    stages: summary.stages,
    progress,
    panel: summary.panel,
  }, null, 2));
}

/**
 * R9：解析并校验 --panel-seats / --panel-skip-reason。
 * 两 flag 互斥；只在 stage 2/4 接受；skip 码必须在 PANEL_SKIP_REASONS 闭集；
 * seats 逐个对 registry（--registry ?? config.registry）做存在性校验——席位是
 * 自报记录，但必须是已配置 worker（输出文案标注"自报、未验证"）。
 * @returns {Promise<{seats: string[]}|{skipReason: string}|undefined>}
 */
async function parsePanelOptions(stage, options, config) {
  const seatsRaw = typeof options.panelSeats === "string" ? options.panelSeats : undefined;
  const skipRaw = typeof options.panelSkipReason === "string" ? options.panelSkipReason : undefined;
  if (!seatsRaw && !skipRaw) return undefined;
  if (seatsRaw && skipRaw) {
    throw new Error("--panel-seats 与 --panel-skip-reason 互斥——登记了会审席位就不是跳过（决策 0023）。");
  }
  if (!PANEL_STAGES.includes(stage)) {
    throw new Error(
      `panel 字段只在方案（2）/交付物验收（4）登记，got stage ${stage}。` +
      `（决策 0023 两节点限定；同一阶段允许多条记录，返工/窄复核照常再登记。）`
    );
  }
  if (skipRaw) {
    if (!PANEL_SKIP_REASONS.includes(skipRaw)) {
      throw new Error(
        `--panel-skip-reason 必须是闭集值之一 [${PANEL_SKIP_REASONS.join(", ")}]，got "${skipRaw}"。` +
        `理由码用枚举防"登记"退化成自由文本；细节差异（如 provider 临时不可用）进 --note。`
      );
    }
    return { skipReason: skipRaw };
  }
  const seats = seatsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (seats.length === 0) {
    throw new Error("--panel-seats 需要至少一个 worker id（逗号分隔，如 --panel-seats coder_hq,auditor）。");
  }
  await assertSeatsInRegistry(seats, options, config);
  return { seats };
}

/** seats 的 registry 存在性校验（读 --registry ?? config.registry；缺位/坏档/未知 id 都 fail-fast）。 */
async function assertSeatsInRegistry(seats, options, config) {
  const registryPath = resolve(options.registry ?? config.registry);
  let raw;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch {
    throw new Error(
      `--panel-seats 需要 registry 存在性校验，但读取失败: ${registryPath}。` +
      `先跑 npm run cli -- wao onboarding --agent <id> --apply 生成，或用 --registry 指向有效 registry。`
    );
  }
  let agents;
  try {
    agents = JSON.parse(raw)?.agents;
  } catch {
    throw new Error(
      `--panel-seats 的 registry 解析失败（${registryPath}）——先用 registry validate 定位修复。`
    );
  }
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    throw new Error(`--panel-seats 的 registry 缺少可用 agents 表（${registryPath}）。`);
  }
  const unknown = seats.filter((s) => !Object.prototype.hasOwnProperty.call(agents, s));
  if (unknown.length > 0) {
    throw new Error(
      `--panel-seats 引用了 registry 里不存在的 worker: ${unknown.join(", ")}（registry: ${registryPath}）。` +
      `席位是自报记录，但必须是已配置的 worker id。`
    );
  }
}

async function waoStateCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "read") {
    const options = parseOptions(tail);
    const cwd = resolveTargetCwd(options);
    const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);
    const state = await readCurrentState(waoDir);
    if (!state) {
      console.log(JSON.stringify({ initialized: false, message: ".wao/ not initialized or no current state" }, null, 2));
      return;
    }
    if (options.format === "text" || !options.format) {
      console.log(`workflow: ${state.workflowId}`);
      console.log(`updated: ${state.updated}`);
      console.log(`status: ${state.status}`);
      console.log("steps:");
      for (const s of state.steps) {
        console.log(`  ${s.node}\t${s.status}\t${s.runId}`);
      }
    } else {
      console.log(JSON.stringify(state, null, 2));
    }
    return;
  }
  if (sub === "snapshot") {
    const options = parseOptions(tail);
    const cwd = resolveTargetCwd(options);
    const waoDir = getWaoDir(cwd, options.stateDir ?? config.stateDir);
    // 手动快照：需 workflowId（必填），其余可选
    if (!options.workflowId) throw new Error("wao state snapshot requires --workflow-id");
    await writeStateSnapshot(waoDir, {
      workflowId: options.workflowId,
      executed: [],
      skipped: [],
      completedResults: new Map(),
      allNodes: [],
      predecessors: {},
    });
    console.log(JSON.stringify({ snapshot: true, waoDir }, null, 2));
    return;
  }
  throw new Error(`Unknown wao state subcommand: ${sub ?? "(none)"}. Try: wao state read | wao state snapshot`);
}

/**
 * wao 命令族派遣器。
 *
 * @param {string[]} args
 * @param {object} config
 * @param {{ askHandler?: (args: string[], config: object) => Promise<void> }} [deps]
 *   ask 子命令依赖注入——cli.js 注入 waoAskCommand（它内部调 commands/run.js 的 runCommand）。
 *   wao.js 不 import ../cli.js，故 askHandler 由 cli.js 注入，保持依赖方向。
 */
export async function waoCommand(args, config, deps = {}) {
  const [sub, ...tail] = args;
  if (sub === "init") {
    await waoInitCommand(tail, config);
    return;
  }
  if (sub === "state") {
    await waoStateCommand(tail, config);
    return;
  }
  if (sub === "decision") {
    await waoDecisionCommand(tail, config);
    return;
  }
  if (sub === "handoff") {
    await waoHandoffCommand(tail, config);
    return;
  }
  if (sub === "declare") {
    await waoDeclareCommand(tail, config);
    return;
  }
  if (sub === "stage") {
    await waoStageCommand(tail, config);
    return;
  }
  if (sub === "ask") {
    // ask 通过依赖注入调 waoAskCommand（cli.js 注入），waoAskCommand 内部调 commands/run.js 的 runCommand。
    // wao.js 不直接持有 runCommand，避免反向 import cli.js。
    if (!deps.askHandler) throw new Error("wao ask requires runCommand (deps.askHandler not injected)");
    await deps.askHandler(args.slice(1), config);
    return;
  }
  if (sub === "doctor") {
    await waoDoctorCommand(tail, config);
    return;
  }
  if (sub === "onboarding") {
    await onboardingCommand(tail, config);
    return;
  }
  throw new Error(`Unknown wao subcommand: ${sub ?? "(none)"}. Try: wao init | wao state | wao decision | wao handoff | wao declare | wao stage | wao ask | wao doctor | wao onboarding`);
}
