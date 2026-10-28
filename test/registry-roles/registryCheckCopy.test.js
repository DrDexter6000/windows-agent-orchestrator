// test/registry-roles/registryCheckCopy.test.js
//
// registry check 只探 opencode-serve 的健康。非 opencode-serve 车道的 skip 行
// 原因是本命令的探测范围（不是 WAO 不认识该 backend）——固定文案指路
// wao lanes（车道就绪）与 wao doctor（环境），text 与 JSON 同值；字段名不变
//（JSON 仍是 error）；skip 不改退出码（allOk 语义不变）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registryCheckCommand } from "../../src/commands/registry.js";

const SKIP_COPY = "registry check probes opencode-serve health only; for lane readiness see 'wao lanes', for environment see 'wao doctor'";

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "wao-regcheck-copy-"));
  // kimi-web 车道（合法条目，非 opencode-serve → skip 路径；不做任何网络请求）。
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    agents: {
      kim: {
        backend: "kimi-web",
        serveUrl: "http://127.0.0.1:58628",
        model: { id: "kimi-code/k3-256k" },
        tokenEnv: "TEST_REGCHECK_TOKEN",
        cwd: ".",
      },
    },
  }), "utf8");
  return dir;
}

async function runCheck(dir, asJson) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  const savedExitCode = process.exitCode;
  try {
    await registryCheckCommand(
      [...(asJson ? ["--format", "json"] : []), "--registry", join(dir, "agents.json")],
      { registry: join(dir, "agents.json") },
    );
  } finally {
    console.log = original;
    process.exitCode = savedExitCode;
  }
  return lines.join("\n");
}

test("registry check：非 opencode-serve 车道 text 模式 SKIP 固定文案（不再'unknown backend'）", async () => {
  const dir = makeEnv();
  try {
    const text = await runCheck(dir, false);
    assert.ok(text.includes(`kim\tSKIP\t${SKIP_COPY}`), "SKIP 行=固定指路文案");
    assert.ok(!text.includes("unknown backend"), "旧的'unknown backend'说法已退役");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("registry check：JSON 模式 skip 行 error=同一固定文案；字段名/退出码语义不变", async () => {
  const dir = makeEnv();
  try {
    const payload = JSON.parse(await runCheck(dir, true));
    assert.equal(payload.allOk, true, "skip 不算 fail（allOk 语义不变）");
    assert.equal(payload.agents.length, 1);
    const row = payload.agents[0];
    assert.equal(row.id, "kim");
    assert.equal(row.status, "skip");
    assert.equal(row.error, SKIP_COPY, "error 字段名不变、值=固定文案");
    assert.equal("detail" in row, false, "未借机改字段名/加字段");
    assert.equal(process.exitCode, undefined, "skip 路径不设退出码");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// TD-318（二）：serveUrl 是配置自由值——文本 FAIL 行先过控制字符转义，值里的
// 换行不能伪造一行（探测定向 127.0.0.1:1，连接拒绝即刻失败，无真实服务依赖）。
test("TD-318（二）：registry check 文本行——serveUrl 含换行先转义，FAIL 行不伪造", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-regcheck-esc-"));
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    agents: {
      evil_serve: {
        backend: "opencode-serve",
        serveUrl: "http://127.0.0.1:1\n[FAIL] forged",
        agent: "build",
        model: { providerID: "p", id: "m" },
        cwd: ".",
      },
    },
  }), "utf8");
  try {
    const lines = [];
    const original = console.log;
    console.log = (...args) => { lines.push(args.map(String).join(" ")); };
    const savedExitCode = process.exitCode;
    try {
      await registryCheckCommand(
        ["--registry", join(dir, "agents.json")],
        { registry: join(dir, "agents.json") },
      );
    } finally {
      console.log = original;
      process.exitCode = savedExitCode;
    }
    assert.equal(lines.find((l) => l.startsWith("[FAIL] forged")), undefined, "没有任何一行以 [FAIL] forged 开头");
    const failLine = lines.find((l) => l.startsWith("evil_serve\tFAIL\t"));
    assert.ok(failLine !== undefined, "FAIL 行在场（探测失败是事实，不得静默）");
    assert.ok(failLine.includes("http://127.0.0.1:1\\n[FAIL] forged"), `serveUrl 以可见转义在场（实际行：${JSON.stringify(failLine)}）`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
