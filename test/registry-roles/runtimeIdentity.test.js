// test/registry-roles/runtimeIdentity.test.js
//
// ADR-0032 批次（2026-09-21）：被测 harness 运行时身份探测
// （scripts/reliability/runtimeIdentity.mjs）——零 token、零真实 spawn（spawnFn
// 注入缝），证伪优先。
//
// 覆盖面：
//   1. 探测形状：一次 spawn、argv 恰 ["--version"]、known → v1-<hash16> 指纹
//      稳定（同输入同指纹——身份可比对）；
//   2. 两个 unknown 恒不相等（探测失败/无描述符/HTTP 服务——绝不当作同一运行时）；
//   3. opencode-serve（HTTP 服务 backend）→ honest unknown + 原因；
//   4. 未知 backend 名 → unknown（无描述符，不猜）；
//   5. HARNESS_VERSION_PROBES 是身份元数据表（六 backend 全覆盖或显式 null）；
//   6. 版本解析：stdout 首个非空行、超长截断、多行 banner 取首行。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  HARNESS_VERSION_PROBES,
  probeRuntimeIdentity,
} from "../../scripts/reliability/runtimeIdentity.mjs";

function fakeSpawn({ stdout = "", status = 0, error = null } = {}) {
  const calls = [];
  const fn = (binary, args, opts) => {
    calls.push({ binary, args, opts });
    return { stdout, stderr: "", status, error };
  };
  fn.calls = calls;
  return fn;
}

test("probe: known 形状——恰一次 spawn、argv 恰 --version、指纹 v1-<hash16> 且稳定", () => {
  // 绝对 .exe 路径跨平台确定性（裸名在 win32 经 where.exe→.cmd→ComSpec 包裹，
  // argv 形状平台相关——该包裹行为由编译 kernel 自身的测试承载）。
  const agent = { binary: "C:/probe/dsh.exe" };
  const spawn = fakeSpawn({ stdout: "0.1.5-rc.2\n" });
  const a = probeRuntimeIdentity({ backendName: "deepseek-acp", agent, spawnFn: spawn });
  assert.equal(spawn.calls.length, 1, "每个被测 backend 恰一次 spawn");
  assert.deepEqual(spawn.calls[0].args, ["--version"], "探测 argv 恰为 --version");
  assert.equal(a.distribution, "dsh");
  assert.equal(a.version, "0.1.5-rc.2");
  assert.equal(a.binaryPath, "C:/probe/dsh.exe");
  assert.match(a.fingerprint, /^v1-[0-9a-f]{16}$/);
  // 指纹稳定性：同 (distribution, version, binaryPath) → 同指纹（身份可比对）。
  const b = probeRuntimeIdentity({ backendName: "deepseek-acp", agent, spawnFn: fakeSpawn({ stdout: "0.1.5-rc.2\n" }) });
  assert.equal(a.fingerprint, b.fingerprint);
  // 版本不同 → 指纹不同（漂移检测的前提）。
  const c = probeRuntimeIdentity({ backendName: "deepseek-acp", agent, spawnFn: fakeSpawn({ stdout: "0.2.0\n" }) });
  assert.notEqual(a.fingerprint, c.fingerprint);
  // binaryPath 参与指纹（换安装路径 = 换运行时身份）。
  const d = probeRuntimeIdentity({
    backendName: "deepseek-acp",
    agent: { binary: "C:/other/dsh.exe" },
    spawnFn: fakeSpawn({ stdout: "0.1.5-rc.2\n" }),
  });
  assert.notEqual(a.fingerprint, d.fingerprint);
});

test("probe【证伪】: 探测失败/无输出/非零退出 → honest unknown；两个 unknown 恒不相等", () => {
  const failing = probeRuntimeIdentity({ backendName: "codex", spawnFn: fakeSpawn({ status: 1, error: new Error("ENOENT") }) });
  assert.equal(failing.version, null);
  assert.match(failing.fingerprint, /^unknown-/);
  assert.match(failing.reason, /did not yield a version/);
  const empty = probeRuntimeIdentity({ backendName: "codex", spawnFn: fakeSpawn({ stdout: "\n  \n" }) });
  const failing2 = probeRuntimeIdentity({ backendName: "codex", spawnFn: fakeSpawn({ status: 1, error: new Error("ENOENT") }) });
  assert.notEqual(failing.fingerprint, failing2.fingerprint, "两个 unknown 不得当作同一运行时");
  assert.notEqual(failing.fingerprint, empty.fingerprint);
  // spawn 抛错（非零退出之外的异常）→ 同样 honest unknown。
  const throwing = probeRuntimeIdentity({
    backendName: "codex",
    spawnFn: () => { throw new Error("spawn blew up"); },
  });
  assert.match(throwing.reason, /spawn failed/);
});

test("probe: opencode-serve（HTTP 服务 backend）→ honest unknown + 原因（无 --version 可探）", () => {
  const spawn = fakeSpawn({ stdout: "1.19.0\n" });
  const id = probeRuntimeIdentity({ backendName: "opencode-serve", spawnFn: spawn });
  assert.equal(spawn.calls.length, 0, "无本地二进制——零 spawn");
  assert.equal(id.version, null);
  assert.match(id.fingerprint, /^unknown-/);
  assert.match(id.reason, /HTTP service backend/);
});

test("probe【证伪】: 未知 backend 名 → unknown（无描述符，不猜）", () => {
  const id = probeRuntimeIdentity({ backendName: "bogus-runtime", spawnFn: fakeSpawn() });
  assert.equal(id.distribution, null);
  assert.match(id.reason, /no harness probe descriptor/);
});

test("HARNESS_VERSION_PROBES: 六 backend 全覆盖（显式描述符或显式 null），dsh 家族读 agent.binary 覆盖", () => {
  const knownBackends = ["claude-code", "codex", "kimi-code", "deepseek-acp", "deepseek-harness", "opencode-serve"];
  assert.deepEqual([...Object.keys(HARNESS_VERSION_PROBES)].sort(), [...knownBackends].sort());
  assert.equal(HARNESS_VERSION_PROBES["opencode-serve"], null, "HTTP 服务显式 null（不静默缺省）");
  assert.equal(HARNESS_VERSION_PROBES["deepseek-acp"].binary({}), "dsh");
  assert.equal(HARNESS_VERSION_PROBES["deepseek-acp"].binary({ binary: "C:/custom/dsh.exe" }), "C:/custom/dsh.exe");
  assert.equal(HARNESS_VERSION_PROBES["claude-code"].binary({ binary: "ignored" }), "claude", "非 dsh 家族发行版名固定（agent.binary 不影响发行版身份）");
});

test("probe: 版本解析——首个非空行；多行 banner 取首行；超长截断到 120", () => {
  const multiLine = probeRuntimeIdentity({ backendName: "codex", spawnFn: fakeSpawn({ stdout: "\n  \n0.9.2 (Codex CLI)\nsome banner line\n" }) });
  assert.equal(multiLine.version, "0.9.2 (Codex CLI)");
  const long = probeRuntimeIdentity({ backendName: "codex", spawnFn: fakeSpawn({ stdout: `${"x".repeat(200)}\n` }) });
  assert.equal(long.version.length, 120, "版本串有界（120）");
});

test("probe: 指纹 = sha256(distribution|version|binaryPath) 前 16 hex（形状钉，防指纹算法漂移）", () => {
  const spawn = fakeSpawn({ stdout: "1.0.0\n" });
  const id = probeRuntimeIdentity({ backendName: "deepseek-acp", agent: { binary: "C:/probe/dsh.exe" }, spawnFn: spawn });
  const expected = `v1-${createHash("sha256").update(`dsh\n1.0.0\nC:/probe/dsh.exe`).digest("hex").slice(0, 16)}`;
  assert.equal(id.fingerprint, expected);
});
