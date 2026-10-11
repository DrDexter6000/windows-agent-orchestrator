// test/run-lifecycle/certGateDoctorCheck.test.js
//
// TD-256（2026-10-11）：wao doctor 的 wao_mcp_cert_gate_visibility advisory 检查
// + 5b 承重 env User 作用域死臂修复的回归钉。
//
// 契约（opus/sol 会审收敛，consult_20261011142751539zdf6mb）：
//   - 恒 INFO：开与关都是 Owner 可合法选择的部署形态（0046 合同），任何状态
//     都不得影响 verdict/退出码（5c/5d 同纪律）。
//   - 报派生语义不报原始值：MCP 判定是 === "1"，"在场≠门开"；原始值绝不出现在
//     输出里。
//   - 三作用域分开（doctor 进程 / User / Machine），读取失败 ≠ 确认未设置。
//   - detail 必须声明"配置面观察，不能代表运行中 MCP 宿主"。
//   - 5b 修复回归：userEnvReader（Promise）预解析进 Map 后同步消费——User 作用
//     域解析命中必须如实报"已解析"，不得退化为"三级解析均缺失"。
//
// 隔离：三作用域读取全部经 config.scopedEnvReader / config.userEnvReader 注入
// stub（真读只在真 doctor 跑）；process.env 显式设/删并恢复；注册表用 fixture。

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { waoDoctorCommand } from "../../src/commands/doctor.js";

const GATE = "WAO_MCP_REQUIRE_CERTIFIED";

async function makeRegistryRoot() {
  const root = mkdtempSync(join(tmpdir(), "wao-td256-doctor-"));
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

async function doctorChecks(root, { userEnvReader, scopedEnvReader } = {}) {
  const [lines, restoreConsole] = captureConsole();
  const savedExitCode = process.exitCode;
  try {
    await waoDoctorCommand(["--format", "json"], {
      registry: join(root, "agents.json"),
      stateDir: join(root, "wao"),
      runDir: join(root, "runs"),
      ...(userEnvReader ? { userEnvReader } : {}),
      ...(scopedEnvReader ? { scopedEnvReader } : {}),
    });
  } finally {
    restoreConsole();
    process.exitCode = savedExitCode;
  }
  const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
  assert.ok(jsonLine, "doctor json 输出在场");
  return JSON.parse(jsonLine).checks;
}

function withoutGate() {
  const prev = Object.getOwnPropertyDescriptor(process.env, GATE);
  delete process.env[GATE];
  return () => {
    if (prev === undefined) delete process.env[GATE];
    else process.env[GATE] = prev.value;
  };
}

function findGateCheck(checks) {
  const check = checks.find((c) => c.name === "wao_mcp_cert_gate_visibility");
  assert.ok(check, "出现 wao_mcp_cert_gate_visibility 条目");
  return check;
}

test("TD-256 doctor：三作用域全缺席 → 恒 INFO，进程=关（默认）、双作用域=未设置，含配置面边界声明", async () => {
  const root = await makeRegistryRoot();
  const restore = withoutGate();
  try {
    const checks = await doctorChecks(root, {
      scopedEnvReader: async () => ({ status: "absent" }),
    });
    const check = findGateCheck(checks);
    assert.equal(check.status, "info", "恒 INFO（缺席不影响 verdict）");
    assert.ok(check.detail.includes("关（默认）"), `进程态报默认关：${check.detail}`);
    assert.ok(check.detail.includes("User 作用域：未设置"), "User=未设置");
    assert.ok(check.detail.includes("Machine 作用域：未设置"), "Machine=未设置");
    assert.ok(check.detail.includes("不能代表"), "配置面边界声明在场");
    assert.ok(check.detail.includes("0046"), "合同指针在场");
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-256 doctor：doctor 进程 =1 → 进程态=开，仍恒 INFO（合法开启不得常态 DEGRADED）", async () => {
  const root = await makeRegistryRoot();
  const prev = process.env[GATE];
  process.env[GATE] = "1";
  try {
    const checks = await doctorChecks(root, {
      scopedEnvReader: async () => ({ status: "absent" }),
    });
    const check = findGateCheck(checks);
    assert.equal(check.status, "info", "开态也恒 INFO");
    assert.ok(check.detail.includes("doctor 进程：开"), `进程态=开：${check.detail}`);
  } finally {
    if (prev === undefined) delete process.env[GATE];
    else process.env[GATE] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-256 doctor：进程值非 1 → 已设置但非开启值；原始值不回显", async () => {
  const root = await makeRegistryRoot();
  const prev = process.env[GATE];
  process.env[GATE] = "td256-secret-raw-value";
  try {
    const checks = await doctorChecks(root, {
      scopedEnvReader: async () => ({ status: "absent" }),
    });
    const check = findGateCheck(checks);
    assert.ok(check.detail.includes("doctor 进程：已设置但非开启值"), `非开启值语义：${check.detail}`);
    assert.ok(!check.detail.includes("td256-secret-raw-value"), "原始值绝不回显");
    assert.ok(!JSON.stringify(checks).includes("td256-secret-raw-value"), "整个输出都不回显");
  } finally {
    if (prev === undefined) delete process.env[GATE];
    else process.env[GATE] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-256 doctor：User 作用域开（=1）/ 非开启值 / 读取失败三态分报，失败≠未设置", async () => {
  const root = await makeRegistryRoot();
  const restore = withoutGate();
  try {
    const on = await doctorChecks(root, { scopedEnvReader: async (_n, scope) => scope === "User" ? { status: "value", isOn: true } : { status: "absent" } });
    assert.ok(on.find((c) => c.name === "wao_mcp_cert_gate_visibility").detail.includes("User 作用域：开"), "User 开");

    const nonOn = await doctorChecks(root, { scopedEnvReader: async (_n, scope) => scope === "User" ? { status: "value", isOn: false } : { status: "absent" } });
    const nc = nonOn.find((c) => c.name === "wao_mcp_cert_gate_visibility");
    assert.ok(nc.detail.includes("User 作用域：已设置但非开启值"), `User 非开启值：${nc.detail}`);
    assert.ok(!nc.detail.includes("User 作用域：开"), "非开启值不得报成开");

    const failed = await doctorChecks(root, { scopedEnvReader: async (_n, scope) => scope === "User" ? { status: "failed" } : { status: "absent" } });
    const fc = failed.find((c) => c.name === "wao_mcp_cert_gate_visibility");
    assert.ok(fc.detail.includes("User 作用域：读取失败（≠确认未设置）"), `读取失败分报：${fc.detail}`);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-256 doctor：Machine 作用域开 → 分报；非 Windows → 不适用", async () => {
  const root = await makeRegistryRoot();
  const restore = withoutGate();
  try {
    const checks = await doctorChecks(root, {
      scopedEnvReader: async (_n, scope) => scope === "Machine" ? { status: "value", isOn: true } : { status: "absent" },
    });
    const check = findGateCheck(checks);
    assert.ok(check.detail.includes("Machine 作用域：开"), `Machine 开：${check.detail}`);
    assert.ok(check.detail.includes("User 作用域：未设置"), "User 仍分报");
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-256 doctor：注册表缺席 → 检查仍出现（控制面检查不依赖 worker 注册表）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td256-noreg-"));
  const restore = withoutGate();
  try {
    const checks = await doctorChecks(root, { scopedEnvReader: async () => ({ status: "absent" }) });
    findGateCheck(checks);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

// 5b 死臂回归（opus 会审必改 C）：readWindowsUserEnv 返回 Promise、同步消费
// 恒 missing。修复后 config.userEnvReader 注入的异步值必须被预解析并命中
// User 作用域臂（zcode 声明表唯一 backend-declared 名，file 类——stub 返回真实
// 存在的临时文件路径）。
test("TD-256 doctor：5b User 作用域臂修复——承重 env 经 userEnvReader（异步）解析命中，不再误报三级缺失", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-td256-5b-"));
  const LB = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";
  const prevVar = Object.getOwnPropertyDescriptor(process.env, LB);
  delete process.env[LB];
  const probeFile = join(root, "lb-probe-config.json");
  writeFileSync(probeFile, "{}", "utf8");
  try {
    writeFileSync(
      join(root, "agents.json"),
      JSON.stringify({ agents: { lb_probe: { backend: "zcode", cwd: root } } }),
      "utf8",
    );
    const checks = await doctorChecks(root, {
      userEnvReader: async (name) => (name === LB ? probeFile : undefined),
      scopedEnvReader: async () => ({ status: "absent" }),
    });
    const check = checks.find((c) => c.name === `env_lb_probe_${LB}`);
    assert.ok(check, `出现 env_lb_probe_${LB} 条目`);
    assert.ok(check.detail.includes("已解析"), `User 作用域命中已解析：${check.detail}`);
    assert.ok(check.detail.includes("user-env"), `来源=user-env：${check.detail}`);
    assert.ok(!check.detail.includes("三级解析均缺失"), "不得再误报三级缺失（死臂回归）");
  } finally {
    if (prevVar === undefined) delete process.env[LB];
    else process.env[LB] = prevVar.value;
    rmSync(root, { recursive: true, force: true });
  }
});
