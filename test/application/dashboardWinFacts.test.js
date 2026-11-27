// test/application/dashboardWinFacts.test.js
//
// 第 145b 批：复用检查的三个 Windows 事实（真 PowerShell、真进程、真端口）。
//   - readProcessCreatedAt：同一活进程两次读取严格相等（复用检查按严格相等比对）；
//   - listenerPidsOfPort：真实监听里的端口归属；空端口给空集；失败给 null；
//   - probeProcessIdentity：same / gone（pid 不在或创建时间对不上）/ unknown（读不出）。
// 真 PowerShell 子进程（进程组）；注入缝另测纯逻辑分支。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFile } from "node:child_process";

import {
  readProcessCreatedAt,
  listenerPidsOfPort,
  probeProcessIdentity,
} from "../../src/application/dashboardWinFacts.js";

test("readProcessCreatedAt: two reads of THIS live process are strictly equal and plausible", async () => {
  const a = await readProcessCreatedAt(process.pid);
  const b = await readProcessCreatedAt(process.pid);
  assert.notEqual(a, null, "the read succeeds for a live process");
  assert.equal(a, b, "stable across reads (the reuse check compares with ===)");
  const age = Date.now() - a;
  assert.ok(age >= 0 && age < 15 * 60_000, `plausible creation time (${age} ms ago)`);
});

test("readProcessCreatedAt: a dead pid reads as null", async () => {
  // 找一个几乎必然不存在的 pid：大数。Get-CimInstance 查无 → null。
  assert.equal(await readProcessCreatedAt(999999998), null);
});

test("listenerPidsOfPort: a port this test listens on is owned by this pid; a free port is empty", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const owners = await listenerPidsOfPort(port);
    assert.notEqual(owners, null, "the probe itself succeeded");
    assert.ok(owners.includes(process.pid), `this process owns ${port} (got ${owners})`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  // 关闭后稍等内核收回，再查一个几乎必然没人监听的端口。
  const free = await listenerPidsOfPort(1); // 端口 1 通常无监听（tcpmux 不是监听服务）
  assert.notEqual(free, null, "probe succeeded");
  assert.equal(free.length, 0, "no listener on port 1");
});

test("listenerPidsOfPort (145b-fix): a failed PROBE is null; only a truly empty listen table is []", async () => {
    // 注入输出：查询报错（如 0x80041003 / 权限）→ null；ObjectNotFound（查无结果）→ []。
    const errProbe = (cb) => async (cmd, args, opts, done) => done(null, "wao-port-error:1" + String.fromCharCode(10));
    assert.equal(await listenerPidsOfPort(8080, { execFileFn: errProbe() }), null, "a probe error is unknown, never 'nobody listening'");
    const emptyProbe = async (cmd, args, opts, done) => done(null, "wao-port:" + String.fromCharCode(10));
    assert.deepEqual(await listenerPidsOfPort(8080, { execFileFn: emptyProbe }), [], "ObjectNotFound is a real empty table");
    const realProbe = async (cmd, args, opts, done) => done(null, "wao-port:123 456" + String.fromCharCode(10));
    assert.deepEqual(await listenerPidsOfPort(8080, { execFileFn: realProbe }), [123, 456]);
  });

  test("every powershell child drops PSModulePath from its inherited environment (pwsh-7 parent must not break Get-Acl/CIM)", async () => {
    const seen = [];
    const execFileFn = (cmd, args, opts, done) => {
      seen.push(opts?.env ?? null);
      done(null, "wao-port:" + String.fromCharCode(10));
    };
    process.env.PSModulePath = "C:akepwsh7modules;" + (process.env.PSModulePath ?? "");
    try {
      await listenerPidsOfPort(8081, { execFileFn });
    } finally {
      delete process.env.PSModulePath;
    }
    assert.ok(seen.length >= 1);
    for (const env of seen) {
      assert.ok(env !== null, "the child env is constructed explicitly");
      assert.equal("PSModulePath" in env, false, "PSModulePath is dropped so Windows PowerShell uses its own defaults");
    }
  });

test("listenerPidsOfPort: an invalid port reads as null without spawning", async () => {
  let spawns = 0;
  const execFileFn = (...args) => { spawns += 1; return execFile(...args); };
  assert.equal(await listenerPidsOfPort(70000, { execFileFn }), null);
  assert.equal(spawns, 0, "validation happens before any subprocess");
});

test("probeProcessIdentity: same / gone / unknown closed set", async () => {
  const createdAt = await readProcessCreatedAt(process.pid);
  assert.notEqual(createdAt, null);
  assert.equal(await probeProcessIdentity(process.pid, createdAt), "same", "exact match -> same");
  assert.equal(await probeProcessIdentity(process.pid, createdAt - 60_000), "gone", "a different creation time is a reused pid -> gone");
  assert.equal(await probeProcessIdentity(999999998, createdAt), "gone", "a dead pid is gone");
  assert.equal(await probeProcessIdentity(process.pid, Number.NaN), "unknown", "an unreadable anchor is unknown, never a guess");
  assert.equal(await probeProcessIdentity(-1, createdAt), "unknown", "a malformed pid is unknown");
  // 注入缝：活着但读不出创建时间 -> unknown。
  assert.equal(
    await probeProcessIdentity(process.pid, createdAt, { readCreatedAtFn: async () => null }),
    "unknown",
    "alive but creation time unreadable -> unknown (refuse to reuse, refuse to conclude)",
  );
  // 注入缝：probe 抛错 -> unknown。
  assert.equal(
    await probeProcessIdentity(process.pid, createdAt, { isAliveFn: () => { throw new Error("probe failed"); } }),
    "unknown",
  );
});
