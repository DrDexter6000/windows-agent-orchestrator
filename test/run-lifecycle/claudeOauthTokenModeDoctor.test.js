// test/run-lifecycle/claudeOauthTokenModeDoctor.test.js
//
// TD-229（2026-10-07）：wao doctor 的 claude_oauth_token_mode advisory 检查。
//
// 契约：注册表含 native claude-code worker（无 provider）才出现条目；恒 INFO
// （机器 env 状态不得影响 verdict/退出码，同 5c 纪律）；token 可解析 → "长期令牌
// 模式"（含来源：进程环境/Windows 用户环境），缺席 → "凭据拷贝模式" + setup-token
// 迁移 fix。名字在场、值不回显。
//
// 隔离：env 读取两路均可控——process.env 显式设/删；User 作用域经 config.
// userEnvReader 注入 stub（真读只在真 doctor 跑）。注册表用 fixture
// （native claude worker），不读机器真实 config/agents.json。

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { waoDoctorCommand } from "../../src/commands/doctor.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../../src/envPolicy.js";

async function makeRegistryRoot() {
  const root = mkdtempSync(join(tmpdir(), "wao-td229-doctor-"));
  writeFileSync(
    join(root, "agents.json"),
    JSON.stringify({ agents: { native_claude: { backend: "claude-code", cwd: root } } }),
    "utf8",
  );
  return root;
}

function captureConsole() {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  return [lines, () => { console.log = original; }];
}

async function doctorChecks(root, { userEnvReader } = {}) {
  const [lines, restoreConsole] = captureConsole();
  // doctor 有 FAIL 检查时会设 process.exitCode=1（doctor.js:787）——在【测试进程
  // 里】跑 doctor 必须恢复退出码，否则 node --test 判文件级红（管道陷阱复盘：
  // 之前 "| tail" 吃掉退出码的 exit=0 是假绿）。
  const savedExitCode = process.exitCode;
  try {
    await waoDoctorCommand(["--format", "json"], {
      registry: join(root, "agents.json"),
      stateDir: join(root, "wao"),
      runDir: join(root, "runs"),
      ...(userEnvReader ? { userEnvReader } : {}),
    });
  } finally {
    restoreConsole();
    process.exitCode = savedExitCode;
  }
  const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
  assert.ok(jsonLine, "doctor json 输出在场");
  return JSON.parse(jsonLine).checks;
}

function withoutProcessToken() {
  const prev = Object.getOwnPropertyDescriptor(process.env, CLAUDE_OAUTH_TOKEN_ENV);
  delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
  return () => {
    if (prev === undefined) delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
    else process.env[CLAUDE_OAUTH_TOKEN_ENV] = prev.value;
  };
}

test("TD-229 doctor：进程环境令牌已解析 → INFO 长期令牌模式（来源=进程环境），无 fix", async () => {
  const root = await makeRegistryRoot();
  const prev = process.env[CLAUDE_OAUTH_TOKEN_ENV];
  process.env[CLAUDE_OAUTH_TOKEN_ENV] = "td229-doctor-dummy-token";
  try {
    const checks = await doctorChecks(root);
    const check = checks.find((c) => c.name === "claude_oauth_token_mode");
    assert.ok(check, "出现 claude_oauth_token_mode 条目");
    assert.equal(check.status, "info", "恒 INFO（env 状态不影响 verdict/退出码）");
    assert.ok(check.detail.includes("长期令牌模式"), `模式报对：${check.detail}`);
    assert.ok(check.detail.includes("进程环境"), "来源=进程环境");
    assert.equal(check.fix, undefined, "已迁移无 fix");
    assert.ok(!JSON.stringify(checks).includes("td229-doctor-dummy-token"), "令牌值不回显");
  } finally {
    if (prev === undefined) delete process.env[CLAUDE_OAUTH_TOKEN_ENV];
    else process.env[CLAUDE_OAUTH_TOKEN_ENV] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-229 doctor：User 作用域令牌（注入 reader）→ 来源=Windows 用户环境", async () => {
  const root = await makeRegistryRoot();
  const restore = withoutProcessToken();
  try {
    const checks = await doctorChecks(root, {
      userEnvReader: async (name) => (name === CLAUDE_OAUTH_TOKEN_ENV ? "user-scope-dummy" : undefined),
    });
    const check = checks.find((c) => c.name === "claude_oauth_token_mode");
    assert.ok(check, "有条目");
    assert.ok(check.detail.includes("Windows 用户环境"), `来源=用户环境：${check.detail}`);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-229 doctor：令牌缺席（env 删值 + reader 返回空）→ INFO 凭据拷贝模式 + setup-token fix", async () => {
  const root = await makeRegistryRoot();
  const restore = withoutProcessToken();
  try {
    const checks = await doctorChecks(root, { userEnvReader: async () => undefined });
    const check = checks.find((c) => c.name === "claude_oauth_token_mode");
    assert.ok(check, "有条目");
    assert.equal(check.status, "info", "缺席也恒 INFO");
    assert.ok(check.detail.includes("凭据拷贝模式"), `模式报对：${check.detail}`);
    assert.ok(check.detail.includes("TD-229"), "指向 TD-229（轮换缺陷可追溯）");
    assert.ok(check.fix && check.fix.includes("claude setup-token"), `fix 给出迁移命令：${check.fix}`);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-229 doctor：注册表无 native claude worker（缺席 registry）→ 不产生条目", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td229-none-"));
  try {
    const checks = await doctorChecks(root); // agents.json 缺席 → registryOk=false
    assert.ok(
      !checks.some((c) => c.name === "claude_oauth_token_mode"),
      "无 native claude worker 时不出现该检查条目",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// glm-pro 验收 P2-3（2026-10-07）：registry 在场但只有 provider wrapper claude
// worker（无 native）→ 同样不出条目（5d 的筛选边界是 backend==="claude-code"
// && !provider）。
test("TD-229 doctor：registry 在场但只有 provider claude worker → 不产生条目", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td229-provonly-"));
  // 必需 provider 键在测试进程内给值：缺失会产生 FAIL 检查（doctor 设
  // process.exitCode=1）——本测试钉的是 5d 筛选边界，不是键缺失面。
  const prevKey = process.env.TD229_PROVIDER_KEY;
  process.env.TD229_PROVIDER_KEY = "td229-doctor-dummy";
  try {
    writeFileSync(
      join(root, "agents.json"),
      JSON.stringify({
        agents: {
          provider_claude: {
            backend: "claude-code",
            cwd: root,
            model: { id: "glm-5.2" },
            provider: { protocol: "anthropic-compatible", baseUrl: "https://provider.example/api", apiKeyEnv: "TD229_PROVIDER_KEY" },
          },
        },
      }),
      "utf8",
    );
    const checks = await doctorChecks(root);
    assert.ok(
      !checks.some((c) => c.name === "claude_oauth_token_mode"),
      "仅 provider worker 时不出现该检查条目（token 模式只关乎 native 通道）",
    );
  } finally {
    if (prevKey === undefined) delete process.env.TD229_PROVIDER_KEY;
    else process.env.TD229_PROVIDER_KEY = prevKey;
    rmSync(root, { recursive: true, force: true });
  }
});
