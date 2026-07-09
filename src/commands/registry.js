// src/commands/registry.js
//
// TD-98 阶段 1：registry 命令族从 cli.js 拆出（行为不变，纯搬迁）。
//
// 依赖：
//   - 外部模块：../registry.js（readRegistry/normalizeAgent）、../backends/opencodeServe.js
//   - 共享工具：./shared.js（parseOptions/displayModel，纯函数）
//   - node built-in：fs/promises（readFile）、path（join/resolve）

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readRegistry, normalizeAgent } from "../registry.js";
import { OpenCodeServeBackend } from "../backends/opencodeServe.js";
// TD-98 阶段 2a：parseOptions/displayModel 从 cli.js 抽到 ./shared.js，消除 ESM 循环 import。
import { parseOptions, displayModel } from "./shared.js";

async function registryCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "check") {
    await registryCheckCommand(tail, config);
    return;
  }
  if (sub === "validate") {
    await registryValidateCommand(tail, config);
    return;
  }
  const options = parseOptions(args);
  const registry = await readRegistry(resolve(options.registry ?? config.registry));
  // N1 修复：合并认证状态列。读 runDir/reliability-summary.json.workers[id].status，
  // 让 lead 一眼看清 worker 列表 + 认证状态（原要跑两命令脑内 join）。summary 缺则显示 -。
  const runDir = resolve(options.runDir ?? config.runDir);
  let certMap = {};
  try {
    const summary = JSON.parse(await readFile(join(runDir, "reliability-summary.json"), "utf8"));
    for (const [id, w] of Object.entries(summary?.workers ?? {})) {
      certMap[id] = w.status ?? "-";
    }
  } catch {
    // 无 summary 或解析失败 = 未认证，全显示 -
  }
  // F5: model 列，让 lead 选型时有模型信息。
  // F17: --format json 输出机器可读 JSON（dogfood round 4 实证：原接受参数但静默忽略）。
  const agents = registry.listAgents().map((agent) => ({
    id: agent.id,
    backend: agent.backend,
    model: displayModel(agent),
    certification: certMap[agent.id] ?? null,
    cwd: agent.cwd,
  }));
  if (options.format === "json") {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }
  for (const agent of agents) {
    console.log(`${agent.id}\t${agent.backend}\t${agent.model}\t${agent.certification ?? "-"}\t${agent.cwd}`);
  }
}

async function registryCheckCommand(args, config) {
  const options = parseOptions(args);
  const registry = await readRegistry(resolve(options.registry ?? config.registry));
  const agents = registry.listAgents();
  if (agents.length === 0) {
    console.log("No agents in registry.");
    return;
  }
  let allOk = true;
  for (const agent of agents) {
    if (agent.backend === "opencode-serve") {
      const backend = new OpenCodeServeBackend({ timeout: 5000, retries: 0 });
      const result = await backend.healthCheck(agent.serveUrl);
      if (result.ok) {
        console.log(`${agent.id}\tok\t${agent.serveUrl}`);
      } else {
        console.log(`${agent.id}\tFAIL\t${agent.serveUrl}\t${result.error ?? `HTTP ${result.status}`}`);
        allOk = false;
      }
    } else {
      console.log(`${agent.id}\tSKIP\tunknown backend: ${agent.backend}`);
    }
  }
  if (!allOk) {
    process.exitCode = 1;
  }
}

/**
 * registry validate（M6 worker 配置）：
 * 配置完整性检查（不连服务，纯静态校验）。
 *
 * 检查三层：
 *   1. JSON 可解析
 *   2. 每个 agent 字段齐全（复用 normalizeAgent）
 *   3. scorecard rules 形状正确（如有配置）
 */
async function registryValidateCommand(args, config) {
  const options = parseOptions(args);
  const registryPath = resolve(options.registry ?? config.registry);
  const raw = await readFile(registryPath, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.log(`✖ JSON parse error: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const agents = parsed.agents ?? {};
  const ids = Object.keys(agents);
  if (ids.length === 0) {
    console.log("⚠  No agents in registry.");
    return;
  }

  const KNOWN_BACKENDS = ["opencode-serve", "claude-code", "codex", "kimi-code"];
  let allOk = true;
  let checked = 0;

  for (const id of ids) {
    const agent = agents[id];
    const issues = [];

    // 1. backend 必填且合法
    if (!agent.backend) {
      issues.push("missing backend");
    } else if (!KNOWN_BACKENDS.includes(agent.backend)) {
      issues.push(`unknown backend "${agent.backend}" (known: ${KNOWN_BACKENDS.join("/")})`);
    }

    // 2. cwd 必填
    if (!agent.cwd) {
      issues.push("missing cwd");
    }

    // 3. opencode-serve 专属字段
    if (agent.backend === "opencode-serve") {
      if (!agent.serveUrl) issues.push("missing serveUrl");
      if (!agent.agent) issues.push('missing agent (e.g. "build")');
      if (!agent.model) {
        issues.push("missing model");
      } else {
        if (!agent.model.providerID) issues.push("missing model.providerID");
        if (!agent.model.id) issues.push("missing model.id");
      }
      // C3（审计 P0）：opencode worker 必须配 tokenBudget（06-18 事故防线，硬门）。
      // 未配 → registry validate 报错，阻止派发（stop 虚假成功 + 无预算上限 = 06-18 复现）。
      if (typeof agent.tokenBudget !== "number") {
        issues.push("missing tokenBudget (opencode worker 必须配，06-18 事故防线；进程式 worker 可不配)");
      }
    }

    // 4. scorecard rules 形状（如有）
    if (agent.scorecard) {
      const rules = agent.scorecard.rules ?? {};
      if (rules.requireCommands !== undefined && !Array.isArray(rules.requireCommands)) {
        issues.push("scorecard.rules.requireCommands must be an array");
      }
      if (rules.requireFiles !== undefined && !Array.isArray(rules.requireFiles)) {
        issues.push("scorecard.rules.requireFiles must be an array");
      }
      if (rules.requireEvidence !== undefined && typeof rules.requireEvidence !== "boolean") {
        issues.push("scorecard.rules.requireEvidence must be boolean");
      }
    }

    // 5. args 形状（如有）
    if (agent.args !== undefined && !Array.isArray(agent.args)) {
      issues.push("args must be an array");
    }

    if (agent.prependArgs !== undefined && !Array.isArray(agent.prependArgs)) {
      issues.push("prependArgs must be an array");
    }

    // TD-79：env 字段形状校验（worker 声明的子进程 env 注入，如 PIP_REQUIRE_VIRTUALENV）。
    // 必须是 {string:string} 对象——key/value 都得是 string（spawn env 契约）。
    if (agent.env !== undefined) {
      if (typeof agent.env !== "object" || agent.env === null || Array.isArray(agent.env)) {
        issues.push("env must be an object");
      } else {
        for (const [k, v] of Object.entries(agent.env)) {
          if (typeof v !== "string") {
            issues.push(`env.${k} value must be a string`);
          }
        }
      }
    }

    // 6. 跑一遍 normalizeAgent 做最终校验（它会 throw 如果有硬错误）
    try {
      normalizeAgent(id, agent);
    } catch (e) {
      issues.push(e.message);
    }

    checked += 1;
    if (issues.length === 0) {
      const model = agent.model ? `${agent.model.id}` : (agent.backend === "claude-code" ? "claude" : "default");
      console.log(`✔ ${id}\t${agent.backend}\t${model}`);
      // TD-87（kimi tokenBudget 静默无效陷阱）：kimi stream-json 无 usage 字段，
      // 配 tokenBudget 不报错但不生效。warn 提示用户别误以为有保护（dogfood round 2 发现）。
      if (agent.backend === "kimi-code" && typeof agent.tokenBudget === "number") {
        console.log(`  ⚠ ${id}: kimi-code 配了 tokenBudget 但不生效（stream-json 无 usage 字段）—— kimi 靠自带 max_steps/timeout 兜底，不靠 WAO tokenBudget`);
      }
      // TD-89（systemPrompt 静默失效）：agent.systemPrompt 只有 claude-code backend 消费
      // （claudeCode.js:35-40 用 --append-system-prompt-file 注入）。kimi-code/codex 的
      // buildArgs 完全不引用该字段——写了角色契约路径但被忽略，角色边界（身份/纪律）不进 worker。
      // dogfood round 5 发现：6 agent 全声明 systemPrompt，但 coder_mm(tester)/tester(codex) 死配。
      if (agent.systemPrompt && agent.backend !== "claude-code") {
        console.log(`  ⚠ ${id}: ${agent.backend} 不消费 systemPrompt（只有 claude-code 用 --append-system-prompt-file 注入）—— 角色契约 ${agent.systemPrompt} 未生效，角色边界需在 task prompt 里手写兜底`);
      }
    } else {
      console.log(`✖ ${id}\t${issues.join("; ")}`);
      allOk = false;
    }
  }

  console.log(`\n${checked} agent(s) checked, ${allOk ? "all valid" : "has errors"}`);
  if (!allOk) process.exitCode = 1;
}

export { registryCommand, registryCheckCommand, registryValidateCommand };
