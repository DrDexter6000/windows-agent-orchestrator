// src/commands/doctor.js
//
// TD-98 阶段 2d：doctor 命令族从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：wao doctor [--strict] [--format json] [--registry FILE] [--cwd DIR]
//
// 依赖：
//   - 外部模块：../waoDir.js（validateWaoDir）
//   - 共享工具：./shared.js（parseOptions/resolveTargetCwd）
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

/**
 * wao doctor：部署前/定期体检。检查环境是否满足安全派发条件。
 * 主控装上 WAO skill 后应先跑一次 doctor，确认环境齐 + 安全配置到位。
 */
export async function waoDoctorCommand(args, config) {
  const options = parseOptions(args);
  const cwd = resolveTargetCwd(options);
  const checks = [];

  // 1. Node 版本（WAO 需 22+）
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  checks.push({
    name: "node_version",
    pass: nodeMajor >= 22,
    detail: `Node ${process.versions.node} (需要 >=22)`,
  });

  // 2. 各 CLI 在 PATH（claude/codex/kimi/opencode）
  for (const cli of ["claude", "codex", "kimi", "opencode"]) {
    const found = await whichCli(cli);
    checks.push({ name: `cli_${cli}`, pass: found, detail: found ? "在 PATH" : "未找到（该 backend 不可用）" });
  }

  // 3. provider key 在 env
  for (const key of ["ZHIPU_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY"]) {
    const present = Boolean(process.env[key]);
    checks.push({ name: `key_${key}`, pass: present, detail: present ? "已设置" : "未设置（对应 provider 会 401）" });
  }

  // 4. agents.json 完整性：opencode worker 是否都配了 tokenBudget
  const registryPath = resolve(options.registry ?? config.registry);
  if (existsSync(registryPath)) {
    try {
      const raw = await readFile(registryPath, "utf8");
      const reg = JSON.parse(raw);
      const agents = reg.agents ?? {};
      const providerClaudeWorkers = Object.entries(agents)
        .filter(([, agent]) => isProviderWrappedClaudeCodeWorker(agent))
        .map(([id]) => id);
      if (providerClaudeWorkers.length > 0 && await hasClaudeOauthCredentials()) {
        checks.push({
          name: "claude_oauth_provider_workers",
          pass: true,
          level: "warn",
          detail: `claude-code OAuth 登录态存在；provider worker (${providerClaudeWorkers.join(",")}) 必须通过 wrapper 的 CLAUDE_CONFIG_DIR 隔离，避免 OAuth token 覆盖 provider key`,
        });
      }
      for (const [id, agent] of Object.entries(agents)) {
        if (agent.backend === "opencode-serve" && !agent.tokenBudget) {
          checks.push({
            name: `budget_${id}`,
            pass: false,
            detail: `opencode worker ${id} 未配 tokenBudget（06-18 事故风险，必须配）`,
          });
        }
      }
      checks.push({ name: "registry_loads", pass: true, detail: `${Object.keys(agents).length} agents` });
    } catch (error) {
      checks.push({ name: "registry_loads", pass: false, detail: `agents.json 解析失败: ${error.message}` });
    }
  } else {
    checks.push({ name: "registry_loads", pass: false, detail: `agents.json 不存在: ${registryPath}` });
  }

  // 5. .wao/ 是否 init
  // 三态：已初始化(OK) / 未初始化(WARN，fresh-agent preflight 第一步的"正常初态"，不该判失败)
  //      / 结构异常(FAIL，缺槽位或多余文件才是真不健康)。
  // doctor 是 onboarding §4d 的 preflight 第一道——"还没 init"是 run wao init 之前的预期状态，
  // 不应与 401/key 缺/CLI 缺同列让 exit=1，否则 fresh agent 在第一步就误判环境坏了。
  const waoCheck = validateWaoDir(cwd, options.stateDir ?? config.stateDir);
  if (waoCheck.ok) {
    checks.push({ name: "wao_init", pass: true, detail: ".wao/ 已初始化" });
  } else if (waoCheck.initialized) {
    // TD-95 #1：多余目录时给迁移建议（不只报异常），帮 Lead 知道怎么处理
    let detail = `.wao/ 结构异常: 缺[${waoCheck.missing.join(",")}] / 多余[${waoCheck.unexpected.join(",")}]`;
    if (waoCheck.unexpected.length > 0) {
      detail += ` — 多余目录可能是旧版遗留，建议迁移到 .dev/wao-legacy/<日期>/ 后删除`;
    }
    checks.push({ name: "wao_init", pass: false, detail });
  } else {
    checks.push({
      name: "wao_init",
      pass: true,
      level: "warn",
      detail: ".wao/ 未初始化（run wao init；这是 preflight 的正常初态，不计入 HEALTHY 判定）",
    });
  }

  // 6. invocation_method（TD-72 延伸，info 级，永不计入 HEALTHY 判定）：
  // fresh agent 易把"PATH 里没有 wao"误读成安装缺失——但 WAO 故意不进 PATH
  // （v22 约束：链进 PATH 会被系统默认 v24 node 拉起被 version guard 拒）。
  // doctor 主动告知正确调用方式，堵住认知 friction。
  checks.push({
    name: "invocation_method",
    pass: true,
    level: "info",
    detail: "WAO 是本地仓内工具，故意不进 PATH——用 `npm run cli -- <command>` 调（走 v22 shim）。PATH 里没有 wao 命令是正常的，不是安装缺失。",
  });

  // 7. TD-95 #11 --strict：JS parse smoke（防注释崩溃漏到运行时，复盘 #3 教训）。
  //    对 src/*.js 跑 node --check。非 strict 模式跳过（保持 doctor 快速）。
  if (options.strict) {
    const parseResult = _doctorParseSmoke();
    checks.push({
      name: "parse_smoke",
      pass: parseResult.pass,
      detail: parseResult.detail,
    });
  }

  const failed = checks.filter((c) => !c.pass);
  const verdict = failed.length === 0 ? "HEALTHY" : `${failed.length} ISSUE(S)`;

  if (options.format === "json") {
    console.log(JSON.stringify({ verdict, checks }, null, 2));
  } else {
    console.log(`WAO Doctor: ${verdict}`);
    for (const c of checks) {
      const label = c.level === "warn" ? "WARN" : (c.level === "info" ? "INFO" : (c.pass ? "OK" : "FAIL"));
      console.log(`  [${label}] ${c.name}: ${c.detail}`);
    }
  }
  if (failed.length > 0) process.exitCode = 1;
}
