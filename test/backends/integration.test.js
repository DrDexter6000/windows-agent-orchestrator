import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { readTranscript } from "../../src/transcript.js";

test("process backend 完整生命周期：spawn → events → done(completed) 经 RunManager", async () => {
  const { RunManager } = await import("../../src/runManager.js");
  const { ClaudeCodeBackend } = await import("../../src/backends/claudeCode.js");
  const runDir = await mkdtemp(join(tmpdir(), "wao-integ-proc-"));
  try {
    // mock 子进程：输出 claude 风格 JSONL 后退出
    const claudeLines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Mock claude reply"}]}}',
      '{"type":"result","subtype":"success","is_error":false}',
    ];
    const payload = Buffer.from(claudeLines.join("\n")).toString("base64");
    const script = `process.stdout.write(Buffer.from("${payload}","base64").toString("utf8")+"\\n");`;

    // 用 node 作为 mock binary，buildArgs 注入脚本
    const backend = new ClaudeCodeBackend({
      buildArgs: () => ["-e", script],
    });
    // 覆盖 defaultBinary 用 node 而非 claude
    backend.defaultBinary = () => process.execPath;

    const readRegistry = async () => ({
      getAgent(id, overrides = {}) {
        return {
          id,
          backend: "claude-code",
          cwd: runDir,
          ...overrides,
        };
      },
      listAgents() { return []; },
    });
    const config = { registry: "x", runDir, pollInterval: 10, waitTimeout: 5000, timeout: 5000, retries: 0 };
    const manager = new RunManager({
      config,
      readRegistry,
      backendFor: () => backend,
    });

    const run = await manager.start("claude_worker", { prompt: "hi" });
    const waitResult = await run.waitForCompletion({ waitTimeout: 5000 });

    assert.equal(waitResult.completed, true);
    assert.equal(run.state, "completed");
    // 验证 transcript 有完整状态链
    const events = await readTranscript(run.transcript.filePath);
    const stateChanges = events.filter((e) => e.type === "run.state_change");
    const transitions = stateChanges.map((e) => `${e.from}→${e.to}`);
    assert.deepEqual(transitions, [
      "null→pending",
      "pending→submitted",
      "submitted→running",
      "running→completed",
    ]);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
