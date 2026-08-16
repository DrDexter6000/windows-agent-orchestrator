// src/commands/doctor.js
//
// TD-98 阶段 2d：doctor 命令族从 cli.js 拆出（行为不变，纯搬迁）。
// Round 5 Bundle R5-B：doctor 升级——scoped 检查（按 registry 保留 worker 收窄）、
// 分级 verdict（HEALTHY/DEGRADED/BROKEN）、每条 FAIL/WARN 附 run: 修复提示（只打印
// 永不执行）、JSON 加性强化（schemaVersion/advisory/status/severity/fix）、
// --warn-as-error（CI opt-in，独立于 --strict）。
//
// 命令族：wao doctor [--strict] [--warn-as-error] [--format json] [--registry FILE] [--cwd DIR]
//
// advisory 定位铁律：doctor 永远只是建议性报告，不是任何使用门禁——本模块改的是
// 呈现与信噪比，不是把它变成闸门。verdict 行自带"（advisory，非门禁）"标注。
//
// 依赖：
//   - 外部模块：../waoDir.js（validateWaoDir）
//   - 共享工具：./shared.js（parseOptions/resolveTargetCwd）
//   - 凭据读取（M11-7 复用，禁止第二份注册表读取）：../application/credentialReadiness.js
//     （resolveCredentialEnv——process.env → Windows User 作用域回退 + requiredCredentialNames）
//   - node built-in：fs（existsSync/readdirSync/statSync）、fs/promises（readFile）、
//     path（resolve/join/dirname）、url（fileURLToPath）、child_process（spawnSync/execSync）
//
// 本模块内部 helper：_doctorParseSmoke、isProviderWrappedClaudeCodeWorker、
// hasClaudeOauthCredentials、whichCli（均为 doctor 专用，随 doctor 族搬迁）。

import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { validateWaoDir } from "../waoDir.js";
import { parseOptions, resolveTargetCwd } from "./shared.js";
// M11-7：Windows User 作用域 env 读取复用 credentialReadiness（HKCU\Environment 精确
// 名单、注入式 reader、5s 超时）——本文件不写第二份注册表读取。
// requiredCredentialNames 是"worker 声明了哪些必需 key env 名"的 SSOT（envPolicy.js）。
import { resolveCredentialEnv, requiredCredentialNames } from "../application/credentialReadiness.js";

// TD-95 #11 --strict：JS parse smoke（防注释崩溃漏到运行时，复盘 #3 教训）。
// 对 src/*.js 跑 node --check。doctor --strict 时调用。
function _doctorParseSmoke() {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  if (!existsSync(srcDir)) return { pass: true, detail: "src/ 不存在（跳过 parse smoke）" };
  const failures = [];
  const collectJs = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) collectJs(full);
      else if (entry.endsWith(".js")) {
        const result = spawnSync(process.execPath, ["--check", full], { encoding: "utf8", timeout: 10_000 });
        if (result.status !== 0) failures.push(full.replace(srcDir + sep, ""));
      }
    }
  };
  collectJs(srcDir);
  if (failures.length === 0) return { pass: true, detail: `src/ 所有 .js 解析通过` };
  return { pass: false, detail: `${failures.length} 个文件解析失败: ${failures.join(", ")}` };
}

function isProviderWrappedClaudeCodeWorker(agent) {
  if (agent?.backend !== "claude-code") return false;
  if (agent.provider?.baseUrl && agent.provider?.apiKeyEnv) return true;
  const prependArgs = Array.isArray(agent.prependArgs) ? agent.prependArgs : [];
  return prependArgs.includes("--base-url") && prependArgs.includes("--api-key-env");
}

async function hasClaudeOauthCredentials(env = process.env) {
  const base = env.USERPROFILE || env.HOME;
  if (!base) return false;
  const credentialsPath = join(base, ".claude", ".credentials.json");
  try {
    const raw = await readFile(credentialsPath, "utf8");
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.claudeAiOauth);
  } catch {
    return false;
  }
}

/** 检查 CLI 是否在 PATH（where/which）。*/
async function whichCli(name) {
  const { execSync } = await import("node:child_process");
  try {
    execSync(process.platform === "win32" ? `where ${name}` : `which ${name}`, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// backend → CLI 探测映射（scoped 检查的权威表）。无法映射的 backend 由调用方 WARN（不静默）。
const BACKEND_CLI = {
  "claude-code": "claude",
  codex: "codex",
  "kimi-code": "kimi",
  "opencode-serve": "opencode",
};

// 各 CLI 的官方安装方式（run: 修复提示用，只打印永不执行）。
const CLI_INSTALL_HINT = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  kimi: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
  opencode: "npm install -g opencode-ai",
};

// 固定的四个 CLI 探测名（scoped：无 worker 需要时 INFO 跳过，不再无条件探测）。
const KNOWN_CLIS = ["claude", "codex", "kimi", "opencode"];

/**
 * 构造一条 doctor 检查项。既有字段（name/pass/detail/level）兼容保留；
 * 加性字段：status（ok|warn|info|fail，fail 仅当 pass=false）、severity（与 status 同值，
 * 排序含义 fail>warn>info>ok）、fix（FAIL/WARN 项的修复命令或指引）。
 */
function pushCheck(checks, { name, pass = true, level, detail, fix }) {
  const status = pass === false ? "fail" : (level ?? "ok");
  const check = { name, pass, level, status, severity: status, detail };
  if (status === "fail" || status === "warn") {
    if (fix) check.fix = fix;
  }
  checks.push(check);
}

/**
 * wao doctor：部署前/定期体检（advisory，非门禁）。按 registry 保留的 worker 收窄检查：
 * 只探测保留 worker 需要的 CLI、只查保留 worker 声明的 provider key env 名。
 * verdict 三值：HEALTHY（exit 0）/ DEGRADED(N warn)（exit 0，--warn-as-error 时 exit 1）/
 * BROKEN(N fail[, M warn])（exit 1）。
 */
export async function waoDoctorCommand(args, config) {
  const options = parseOptions(args);
  const cwd = resolveTargetCwd(options);
  const checks = [];

  // 1. Node 版本（WAO 需 22+）
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  pushCheck(checks, {
    name: "node_version",
    pass: nodeMajor >= 22,
    detail: `Node ${process.versions.node} (需要 >=22)`,
    fix: nodeMajor >= 22 ? undefined : "安装/使用 Node v22（npm run cli 走 scripts/wao-node.cjs 的 v22 shim）",
  });

  // 2. registry 读取三态：ok（有 agents 表）/ missing / parse。missing/parse 走回退
  //    （不退回全量 FAIL）：CLI/key 全部 INFO 跳过，只保留 node_version/.wao/invocation_method。
  const registryPath = resolve(options.registry ?? config.registry);
  let registryOk = false;
  let registryAgents = {};
  if (existsSync(registryPath)) {
    try {
      const raw = await readFile(registryPath, "utf8");
      const reg = JSON.parse(raw);
      registryAgents = reg.agents ?? {};
      registryOk = true;
    } catch (error) {
      // R5 审计 P0-1：文件存在但解析失败 ≠ onboarding 前的正常初态——那是"坏了"，
      // 不得与健康态同列 INFO 让 verdict 说 HEALTHY（假绿灯）。至少 WARN（→ DEGRADED）。
      // registry_loads 恒在场（P2-1：所有路径都有该检查项，消费者形状稳定）。
      pushCheck(checks, {
        name: "registry_loads",
        pass: true,
        level: "warn",
        detail: `agents.json 存在但解析失败——${error.message}（CLI/key 检查跳过）`,
        fix: "npm run cli -- registry validate --registry config/agents.json 定位后修复",
      });
    }
  } else {
    pushCheck(checks, {
      name: "registry",
      pass: true,
      level: "info",
      detail: "config/agents.json 不存在——先跑 npm run cli -- wao onboarding --agent <id> --apply",
    });
    // P2-1：missing 路径同样保持 registry_loads 在场（INFO），形状与 parse-ok 路径一致。
    pushCheck(checks, {
      name: "registry_loads",
      pass: true,
      level: "info",
      detail: "agents.json 不存在（onboarding 前正常初态）",
    });
  }

  // 3. scoped 计算：保留 worker 需要哪些 CLI、声明哪些 key env 名。
  const neededClis = new Set();
  const keyNames = new Set();
  const unmappableBackends = [];
  let hasKimiWorker = false;
  let providerWorkerCount = 0;
  if (registryOk) {
    for (const [id, agent] of Object.entries(registryAgents)) {
      const backend = agent?.backend;
      const cli = BACKEND_CLI[backend];
      if (cli) {
        neededClis.add(cli);
      } else {
        // 无法映射的 backend → WARN（不静默）：该 worker 的 CLI/key 检查无法覆盖。
        unmappableBackends.push({ id, backend });
      }
      if (backend === "kimi-code") hasKimiWorker = true;
      const names = requiredCredentialNames(agent);
      if (names.length > 0) providerWorkerCount += 1;
      for (const name of names) keyNames.add(name);
    }
  }

  // 4. 各 CLI 在 PATH（scoped：只在保留 worker 需要时探测；否则 INFO 跳过）。
  for (const cli of KNOWN_CLIS) {
    if (!registryOk || !neededClis.has(cli)) {
      pushCheck(checks, {
        name: `cli_${cli}`,
        pass: true,
        level: "info",
        detail: "未配置（跳过）",
      });
      continue;
    }
    const found = await whichCli(cli);
    pushCheck(checks, {
      name: `cli_${cli}`,
      pass: found,
      detail: found ? "在 PATH" : "未找到（该 backend 不可用）",
      fix: found ? undefined : CLI_INSTALL_HINT[cli],
    });
  }

  // 5. provider key（scoped + 作用域扩展）：只查保留 worker 声明的 env 名（不写死三连）。
  //    进程 env 命中 → OK；未命中 → credentialReadiness 的 User 作用域再查：
  //    命中 → WARN（新开终端可用）；仍无 → FAIL。kimi-code 靠 CLI 登录态，不查任何 kimi key。
  if (!registryOk) {
    pushCheck(checks, { name: "keys", pass: true, level: "info", detail: "未配置（跳过）" });
  } else if (providerWorkerCount === 0 && !hasKimiWorker) {
    pushCheck(checks, {
      name: "keys",
      pass: true,
      level: "info",
      detail: "registry 无需要 provider key 的 worker（key 检查全部跳过）",
    });
  } else {
    if (hasKimiWorker && !keyNames.has("KIMI_API_KEY")) {
      // 说明项仅在"没有任何 worker 声明 KIMI_API_KEY"时出现——若 claude-code wrapper
      // 声明了它（真实需要），下方存在性检查在场，说明项冗余且会同名重复。
      pushCheck(checks, {
        name: "key_KIMI_API_KEY",
        pass: true,
        level: "info",
        detail: "kimi-code 使用 CLI 登录态，不查 API key",
      });
    }
    for (const name of [...keyNames].sort()) {
      // R5 审计 P1-2：不做 kimi 跨 worker 抑制——kimi-code worker 经 envPolicy 本就
      // 声明零 key（登录态认证）；而 claude-code wrapper + Kimi 端点的 worker 声明的
      // KIMI_API_KEY 是它真正需要的 env，必须照常检查（registry 级布尔会吞掉它）。
      const r = await resolveCredentialEnv(name);
      if (r.source === "process_env") {
        pushCheck(checks, { name: `key_${name}`, pass: true, detail: "已设置" });
      } else if (r.source === "user_env") {
        pushCheck(checks, {
          name: `key_${name}`,
          pass: true,
          level: "warn",
          detail: `User 作用域已设置，当前进程未继承（新开终端可用）；run: 重启当前终端即可继承`,
          fix: "重启当前终端（新进程继承 Windows User 作用域变量，无需重设 key）",
        });
      } else {
        pushCheck(checks, {
          name: `key_${name}`,
          pass: false,
          detail: `未设置（对应 provider 会 401）；run: setx ${name} "<key>"（Windows User 作用域，新开终端生效）`,
          fix: `setx ${name} "<key>"（Windows User 作用域，新开终端生效）`,
        });
      }
    }
  }

  // 6. registry 完整性：opencode worker 必须配 tokenBudget；OAuth + provider worker 组合 WARN。
  if (registryOk) {
    const agents = Object.entries(registryAgents);
    for (const { id, backend } of unmappableBackends) {
      pushCheck(checks, {
        name: `backend_map_${id}`,
        pass: true,
        level: "warn",
        detail: `worker ${id} 的 backend "${backend}" 无 CLI/key 映射——该 worker 的 CLI/key 检查无法覆盖（不静默）；run: 人工确认该 backend 的 CLI 与认证就绪`,
        fix: "人工确认该 backend 的 CLI/认证就绪（doctor 映射表无此 backend）",
      });
    }
    const providerClaudeWorkers = agents
      .filter(([, agent]) => isProviderWrappedClaudeCodeWorker(agent))
      .map(([id]) => id);
    if (providerClaudeWorkers.length > 0 && await hasClaudeOauthCredentials()) {
      pushCheck(checks, {
        name: "claude_oauth_provider_workers",
        pass: true,
        level: "warn",
        detail: `claude-code OAuth 登录态存在；provider worker (${providerClaudeWorkers.join(",")}) 必须通过 wrapper 的 CLAUDE_CONFIG_DIR 隔离，避免 OAuth token 覆盖 provider key；run: 对使用官方 OAuth 的用户是预期行为，provider worker 走 wrapper 隔离，无需处理`,
        fix: "对使用官方 OAuth 的用户是预期行为，provider worker 走 wrapper 隔离，无需处理",
      });
    }
    for (const [id, agent] of agents) {
      if (agent.backend === "opencode-serve" && !agent.tokenBudget) {
        pushCheck(checks, {
          name: `budget_${id}`,
          pass: false,
          detail: `opencode worker ${id} 未配 tokenBudget（06-18 事故风险，必须配）；run: 在 config/agents.json 给 ${id} 补 tokenBudget 数字字段`,
          fix: `在 config/agents.json 给 ${id} 补 tokenBudget 数字字段`,
        });
      }
    }
    pushCheck(checks, { name: "registry_loads", pass: true, detail: `${agents.length} agents` });
  }

  // 7. .wao/ 四态：已初始化(OK) / fresh-clone 缺槽位无多余(WARN，正常初态)
  //      / 结构混乱有多余(FAIL，给迁移建议) / 未初始化(WARN，preflight 正常初态)。
  // doctor 是 onboarding §4d 的 preflight 第一道——"还没 init"或"fresh clone 缺槽位"
  // 都是 run wao init 之前的预期状态，不应与 401/key 缺/CLI 缺同列让 exit=1。
  const waoCheck = validateWaoDir(cwd, options.stateDir ?? config.stateDir);
  if (waoCheck.ok) {
    pushCheck(checks, { name: "wao_init", pass: true, detail: ".wao/ 已初始化" });
  } else if (waoCheck.initialized && waoCheck.unexpected.length === 0 && waoCheck.missing.length > 0) {
    // fresh clone 实际命中态：.wao/ 只含 git 跟踪的 decisions/（缺其余槽位且无多余）。
    pushCheck(checks, {
      name: "wao_init",
      pass: true,
      level: "warn",
      detail: `.wao/ 缺少槽位 [${waoCheck.missing.join(",")}]——fresh clone 的正常初态；如需项目记录：run: npm run cli -- wao init --cwd ${cwd}`,
      fix: `npm run cli -- wao init --cwd ${cwd}`,
    });
  } else if (waoCheck.initialized) {
    // TD-95 #1：多余目录时给迁移建议（不只报异常），帮 Lead 知道怎么处理
    let detail = `.wao/ 结构异常: 缺[${waoCheck.missing.join(",")}] / 多余[${waoCheck.unexpected.join(",")}]`;
    if (waoCheck.unexpected.length > 0) {
      detail += ` — 多余目录可能是旧版遗留，建议迁移到 .dev/wao-legacy/<日期>/ 后删除`;
    }
    detail += `；run: 清理多余目录或补齐缺槽位后重跑 wao doctor`;
    pushCheck(checks, {
      name: "wao_init",
      pass: false,
      detail,
      fix: "把多余目录迁移到 .dev/wao-legacy/<日期>/ 后删除；缺槽位用 wao init 补齐",
    });
  } else {
    pushCheck(checks, {
      name: "wao_init",
      pass: true,
      level: "warn",
      detail: `.wao/ 未初始化——preflight 的正常初态，不计入 FAIL；如需项目记录：run: npm run cli -- wao init --cwd ${cwd}`,
      fix: `npm run cli -- wao init --cwd ${cwd}`,
    });
  }

  // 8. invocation_method（TD-72 延伸，info 级，永不计入 verdict 判定）：
  // fresh agent 易把"PATH 里没有 wao"误读成安装缺失——但 WAO 故意不进 PATH
  // （v22 约束：链进 PATH 会被系统默认 v24 node 拉起被 version guard 拒）。
  // doctor 主动告知正确调用方式，堵住认知 friction。
  checks.push({
    name: "invocation_method",
    pass: true,
    level: "info",
    status: "info",
    severity: "info",
    detail: "WAO 是本地仓内工具，故意不进 PATH——用 `npm run cli -- <command>` 调（走 v22 shim）。PATH 里没有 wao 命令是正常的，不是安装缺失。",
  });

  // 9. TD-95 #11 --strict：JS parse smoke（防注释崩溃漏到运行时，复盘 #3 教训）。
  //    对 src/*.js 跑 node --check。非 strict 模式跳过（保持 doctor 快速）。
  if (options.strict) {
    const parseResult = _doctorParseSmoke();
    pushCheck(checks, {
      name: "parse_smoke",
      pass: parseResult.pass,
      detail: parseResult.detail,
      fix: parseResult.pass ? undefined : "修复解析失败的 .js 文件后重跑 wao doctor --strict",
    });
  }

  // 10. 分级 verdict（advisory 定位：verdict 行自带非门禁标注）。
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  let verdict;
  if (fails.length > 0) {
    verdict = `BROKEN（${fails.length} fail${warns.length > 0 ? `, ${warns.length} warn` : ""}）`;
  } else if (warns.length > 0) {
    verdict = `DEGRADED（${warns.length} warn）`;
  } else {
    verdict = "HEALTHY";
  }
  verdict += "（advisory，非门禁）";
  if (options.warnAsError && warns.length > 0) {
    verdict += "（--warn-as-error）";
  }

  if (options.format === "json") {
    // 加性强化：顶层 schemaVersion/advisory 为新增字段；每个 check 增加 status/severity/fix；
    // name/pass/detail/level 兼容保留（既有消费者不受影响）。
    console.log(JSON.stringify({ schemaVersion: 1, advisory: true, verdict, checks }, null, 2));
  } else {
    console.log(`WAO Doctor: ${verdict}`);
    for (const c of checks) {
      const label = c.level === "warn" ? "WARN" : (c.level === "info" ? "INFO" : (c.pass ? "OK" : "FAIL"));
      console.log(`  [${label}] ${c.name}: ${c.detail}`);
    }
  }
  if (fails.length > 0 || (options.warnAsError && warns.length > 0)) process.exitCode = 1;
}
