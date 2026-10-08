// test/process/runtimeIdentityCli.test.js
//
// runtime-identity-cli 薄入口回归（2026-10-02 前置盘点 round 2 F1 落地）。
// 子进程用例全部走免 spawn 路径（未知名无描述符 / opencode-serve 描述符 null），
// 保持确定性；真实 spawn 语义已由 runtimeIdentity.test.js（注入 spawnFn）与
// zcode.test.js（resolveInvocationPrefix）覆盖，此处只钉 CLI 接线。

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, main } from "../../scripts/reliability/runtime-identity-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "..", "scripts", "reliability", "runtime-identity-cli.mjs");

function runCli(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
    return { code: 0, stdout };
  } catch (error) {
    if (!expectFail) throw error;
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("cli: 未知 backend 名 → honest unknown JSON + exit 0（unknown 是合法结果，零 spawn）", () => {
  const { code, stdout } = runCli(["--backend", "bogus-runtime"]);
  assert.equal(code, 0);
  const id = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(id.distribution, null);
  assert.match(id.reason, /no harness probe descriptor/);
  assert.equal(id.verified, false);
});

test("cli: opencode-serve → 描述符 null 的 honest unknown + exit 0（零 spawn）", () => {
  const { code, stdout } = runCli(["--backend", "opencode-serve"]);
  assert.equal(code, 0);
  const id = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(id.distribution, "opencode-serve");
  assert.equal(id.verified, false);
  assert.match(id.reason, /no local harness binary/);
});

test("cli: --registry 显式路径的读取路径（opencode-serve 席位在场仍 honest unknown）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rtid-cli-"));
  try {
    const regPath = join(dir, "agents.json");
    writeFileSync(regPath, JSON.stringify({
      agents: { mm: { id: "mm", backend: "opencode-serve", serveUrl: "http://127.0.0.1:1", model: { providerID: "x", id: "m" } } },
    }));
    const { code, stdout } = runCli(["--backend", "opencode-serve", "--registry", regPath]);
    assert.equal(code, 0);
    const id = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(id.verified, false);
    assert.match(id.reason, /no local harness binary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: --registry 找到 anchor 席位时消费其 binary（假路径 ENOENT 也是确定性证据）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rtid-cli-"));
  try {
    const regPath = join(dir, "agents.json");
    writeFileSync(regPath, JSON.stringify({
      agents: {
        zc: { id: "zc", backend: "zcode", binary: "C:/definitely/not/here/zcode.cjs", model: { id: "p/m" } },
      },
    }));
    const { code, stdout } = runCli(["--backend", "zcode", "--registry", regPath]);
    assert.equal(code, 0);
    const id = JSON.parse(stdout.trim().split("\n").at(-1));
    // 席位被找到且 resolveInvocationPrefix 被消费：探测目标是 node 入口
    // （binaryPath=execPath）而非裸名 fallback（2026-10-02 实测曾因 readRegistry
    // 句柄形状误用而永远落裸名 "zcode"）。假 .cjs 路径使 spawn 必失败 → verified:false。
    assert.equal(id.binaryPath, process.execPath);
    assert.equal(id.verified, false);
    assert.equal(id.anchorAgentId, "zc", "输出携带实际锚定席位（单目标边界机器可见）");
    assert.match(id.reason, /did not yield a version|spawn failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: 缺 --backend / 未知 flag / --registry 空值 → exit 1 + 用法到 stderr，零探测", () => {
  const missing = runCli([], { expectFail: true });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--backend is required/);

  const unknown = runCli(["--backend", "codex", "--wat"], { expectFail: true });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown flag: --wat/);

  const emptyRegistry = runCli(["--backend", "codex", "--registry"], { expectFail: true });
  assert.equal(emptyRegistry.code, 1);
  assert.match(emptyRegistry.stderr, /--registry requires/);
});

test("cli: --help → 用法到 stdout + exit 0", () => {
  const { code, stdout } = runCli(["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /--backend/);
  assert.match(stdout, /--registry/);
});

test("parseArgs 纯形状：help 优先、裸 flag 缺值抛错（不静默降级）、未知 flag 抛错", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--backend"]), /--backend requires a value/);
  assert.throws(() => parseArgs(["--backend", "zcode", "--registry"]), /--registry requires a value/);
  assert.throws(() => parseArgs(["--nope"]), /unknown flag: --nope/);
  assert.deepEqual(parseArgs(["--backend", "zcode", "--registry", "x.json"]),
    { backend: "zcode", registry: "x.json" });
});

test("main: --help 与缺 backend 的 exit code（进程内注入 stdout/stderr，零子进程）", async () => {
  const out = [];
  const err = [];
  const stdout = { write: (s) => out.push(s) };
  const stderr = { write: (s) => err.push(s) };
  assert.equal(await main(["--help"], { stdout, stderr }), 0);
  assert.match(out.join(""), /--backend/);
  assert.equal(await main([], { stdout, stderr }), 1);
  assert.match(err.join(""), /--backend is required/);
});

// 2026-10-05 巡检摩擦①回归钉：where.exe 未命中的本地码页提示（GBK）曾经
// execFileSync 的 stderr 默认继承直通控制台，污染 JSON 输出的机读性——修复后
// 探测失败必须零 stderr（stdout 仍是单行 JSON honest unknown）。
// 注册表用临时夹具而非相对路径 config/agents.json——后者是私有未跟踪文件，
// 隔离 worktree（交付验证语境）里不存在，ENOENT 会劫持本钉的真实断言面
// （TD-239 批验收实测）；探测对象是 PATH 上的裸名二进制，与注册表内容无关。
test("cli: 探测未命中（deepseek-harness 裸名）→ stderr 零字节（where 噪声不外泄）", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-rtid-miss-"));
  try {
    const regPath = join(dir, "agents.json");
    writeFileSync(regPath, JSON.stringify({ agents: {} }));
    const r = runCli(["--backend", "deepseek-harness", "--registry", regPath]);
    assert.ok(!r.stderr || r.stderr.length === 0, "探测未命中的 stderr 必须为空（where.exe 码页提示不外泄）");
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.verified, false, "stdout 仍是 honest unknown JSON");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
