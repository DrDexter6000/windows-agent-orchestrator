// test/run-lifecycle/kimiTokenFileDoctorCheck.test.js
//
// 决定 0074（车道就绪事实如实呈现）：wao doctor 对声明 kimiHome 的 kimi-web
// 车道做 token 文件体检——<kimiHome>/server.token 缺失或为空 = FAIL（派发必失败，
// 与 budget_* 的"承重文件缺失即 FAIL"同口径；detail 点名文件路径与生成方式）；
// 存在时不产生条目（零 OK 噪音）。检查只针对 kimiHome 车道：无 kimiHome 的
// kimi-web 车道不在本检查面（仍走 env/key 检查）。
//
// 隔离：fixture 全部在 os.tmpdir() 临时目录（结束清理）；不改环境变量；
// User/Machine 作用域读取经 config 注入 stub（同 certGateDoctorCheck 的隔离
// 纪律——真读只在真 doctor 跑）。

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { waoDoctorCommand } from "../../src/commands/doctor.js";

async function makeEnv({ withKimiHome = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "wao-kimi-token-doctor-"));
  mkdirSync(join(root, "home"), { recursive: true });
  const agent = {
    backend: "kimi-web",
    serveUrl: "http://127.0.0.1:58628",
    model: { id: "kimi-code/k3-256k" },
    tokenEnv: "TEST_DOCTOR_KIMI_TOKEN",
    cwd: root,
  };
  if (withKimiHome) agent.kimiHome = join(root, "home");
  writeFileSync(
    join(root, "agents.json"),
    JSON.stringify({ agents: { kim: agent } }),
    "utf8",
  );
  return root;
}

async function doctorRun(root) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  const savedExitCode = process.exitCode;
  try {
    await waoDoctorCommand(["--format", "json"], {
      registry: join(root, "agents.json"),
      stateDir: join(root, "wao"),
      runDir: join(root, "runs"),
      userEnvReader: async () => undefined,
      scopedEnvReader: async () => ({ status: "absent" }),
    });
  } finally {
    console.log = original;
    process.exitCode = savedExitCode;
  }
  const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
  assert.ok(jsonLine, "doctor json 输出在场");
  return JSON.parse(jsonLine);
}

const tokenCheckOf = (report) => report.checks.find((c) => c.name.startsWith("kimi_token_file_"));

test("决定 0074: token 文件缺失 → FAIL（点名路径与生成方式）", async () => {
  const root = await makeEnv();
  try {
    const report = await doctorRun(root);
    const check = tokenCheckOf(report);
    assert.ok(check, "kimi_token_file_kim 条目在场");
    assert.equal(check.status, "fail", "缺失=FAIL（派发必失败口径）");
    assert.ok(check.detail.includes(join(root, "home", "server.token")), "detail 点名 token 文件路径");
    assert.match(check.detail, /server\.token/, "文件名在场");
    assert.ok(check.fix && check.fix.includes("docs/usage/lanes.md"), "fix 指路生成方式文档");
    assert.match(report.verdict, /BROKEN/, "FAIL 计入 verdict");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("决定 0074: token 文件为空（纯空白） → FAIL", async () => {
  const root = await makeEnv();
  try {
    writeFileSync(join(root, "home", "server.token"), "   \n", "utf8");
    const report = await doctorRun(root);
    const check = tokenCheckOf(report);
    assert.ok(check, "空文件同样点名");
    assert.equal(check.status, "fail", "为空=FAIL");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("决定 0074: token 文件存在且非空 → 不报（零 OK 噪音）；退出码不受影响", async () => {
  const root = await makeEnv();
  try {
    writeFileSync(join(root, "home", "server.token"), "tok-doctor-live", "utf8");
    const report = await doctorRun(root);
    assert.equal(tokenCheckOf(report), undefined, "存在时不产生条目");
    assert.doesNotMatch(report.verdict, /BROKEN/, "不因 token 文件 BROKEN");
    // panel 行与 wao lanes 同闭集：文件在=kimi_token_file 车道不再落"探测未知"。
    const panel = report.checks.find((c) => c.name === "panel_readiness");
    if (panel) {
      assert.ok(!panel.detail.includes("探测未知（不计入可用）：kim"), "kimiHome 车道就绪按文件推导，不再'探测未知'");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("决定 0074: 无 kimiHome 的 kimi-web 车道不在本检查面", async () => {
  const root = await makeEnv({ withKimiHome: false });
  try {
    writeFileSync(join(root, "server.token"), "tok-stray", "utf8"); // 同目录无关文件——不应被认领
    const report = await doctorRun(root);
    assert.equal(tokenCheckOf(report), undefined, "无 kimiHome 声明 → 无 token 文件检查条目");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
