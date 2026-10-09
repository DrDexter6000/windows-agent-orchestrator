// test/run-lifecycle/agentArgsFingerprint.test.js
//
// TD-221 Owner 裁定 B+小修（2026-10-07）：注册表级 agent.args 是 --add-dir
// 逃生门的合法形态（配最窄目录纪律），留痕小修把派发时刻的 args 摘要记进
// run.started——count + 规范化数组 sha256 指纹 + addDirs 路径（暴露面事实）。
// args 可含其他任意旗标/敏感值，故只记指纹不记原值；无 args 派发字段缺席
// （字节兼容）。本文件钉：纯函数形状 + run.started 落点（有 args/无 args 双路）。

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { resolveTranscriptPath } from "../../src/projectBuckets.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import { RunManager, summarizeAgentArgs } from "../../src/runManager.js";

const sha = (v) => createHash("sha256").update(v).digest("hex");

test("TD-221 小修: summarizeAgentArgs——双形态 --add-dir 解析、无暴露面时缺 addDirs、指纹确定", () => {
  const pair = summarizeAgentArgs(["--add-dir", "C:\\Users\\<you>\\.claude\\skills"]);
  assert.equal(pair.count, 2);
  assert.deepEqual(pair.addDirs, ["C:\\Users\\<you>\\.claude\\skills"]);
  assert.equal(pair.sha256, sha(JSON.stringify(["--add-dir", "C:\\Users\\<you>\\.claude\\skills"])));

  const eqForm = summarizeAgentArgs(["--strict-mcp-config", "--add-dir=/d/skills", "--effort", "high"]);
  assert.equal(eqForm.count, 4);
  assert.deepEqual(eqForm.addDirs, ["/d/skills"], "= 连写形态同样解析");

  const none = summarizeAgentArgs(["--dangerously-skip-permissions"]);
  assert.equal(none.count, 1);
  assert.ok(!("addDirs" in none), "无 --add-dir 时 addDirs 键精确缺席（非空数组才算暴露面）");

  // 指纹确定性 + 不同输入不同指纹（同一数组两次一致；换序不同）。
  assert.equal(summarizeAgentArgs(["a", "b"]).sha256, summarizeAgentArgs(["a", "b"]).sha256);
  assert.notEqual(summarizeAgentArgs(["a", "b"]).sha256, summarizeAgentArgs(["b", "a"]).sha256);
});

async function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "wao-td221-args-"));
}

function makeManager(dir, agentOverrides = {}) {
  const backend = {
    replayByRespawn: true,
    async spawn() {
      return {
        backend: "fake",
        backendSessionId: "ses_args",
        events: async function* () {
          yield { kind: "message", role: "assistant", parts: [{ type: "text", text: "ok" }] };
          yield { kind: "done", reason: "completed" };
        },
        abort: async () => {},
        isAlive: () => false,
      };
    },
    async dispose() {},
  };
  const config = {
    registry: "config/agents.json",
    runDir: dir,
    pollInterval: 10,
    waitTimeout: 2000,
    timeout: 5000,
    retries: 0,
  };
  const readRegistry = async () => ({
    getAgent: (id, overrides = {}) => ({ id, backend: "fake", cwd: dir, ...agentOverrides, ...overrides }),
    listAgents: () => [],
  });
  return new RunManager({ config, readRegistry, transcriptDir: dir, backendFor: () => backend });
}

function readStarted(dir, runId) {
  // D2-②b：经解析链定位（前台 manager 自决写桶后转录在 projects/<slug>/）。
  const lines = readFileSync(resolveTranscriptPath(dir, runId), "utf8").trim().split("\n");
  const started = lines.map((l) => JSON.parse(l)).find((e) => e.type === "run.started" && e.runId === runId);
  assert.ok(started, "run.started 在转录中");
  return started;
}

test("TD-221 小修: run.started 落点——有 args 时带 agentArgs（指纹+addDirs），无 args 缺席", async () => {
  const dir = await makeTempDir();
  try {
    const args = ["--add-dir", "C:\\Users\\<you>\\.claude\\skills"];
    const withArgs = makeManager(dir, { args });
    const run1 = await withArgs.start("w", { prompt: "do", runId: "run_td221_args" });
    await run1.waitForCompletion({});
    const started1 = readStarted(dir, "run_td221_args");
    assert.deepEqual(
      started1.agentArgs,
      { count: 2, sha256: sha(JSON.stringify(args)), addDirs: ["C:\\Users\\<you>\\.claude\\skills"] },
      "agentArgs 摘要与纯函数一致（指纹+暴露面路径）",
    );

    const bare = makeManager(dir, {});
    const run2 = await bare.start("w", { prompt: "do", runId: "run_td221_noargs" });
    await run2.waitForCompletion({});
    const started2 = readStarted(dir, "run_td221_noargs");
    assert.ok(!("agentArgs" in started2), "无 args 派发 agentArgs 键精确缺席（字节兼容）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
