// collectFinal.test.js
//
// TD-112（D2 A4）：`collect <runId> --final` —— 最终 assistant 答复的一屏文本出口。
//
// 背景：裸 `collect <id> --final` 今天走 raw 路径静默忽略 flag；若进 projection 模式
// 又会被未知 flag 检查拒绝。GREEN 方案（Lead 四项裁决）：--final 是布尔 flag，加入
// COLLECT_PROJECTION_KNOWN_FLAGS 与投影触发条件，复用 collectCommand 既有重建/投影
// 路径（compact 投影），四态输出到 stdout，继承 messages.collected 审计 append，
// --cursor 组合沿用 compact 既有互斥拒绝。
//
// 四态：
//   available（最后一条 assistant 文本 ≤4000 字符）→ stdout 恰为消毒后
//     （secret redaction + C0/C1/DEL 清洗）的最终 assistant 文本；
//   empty（无 assistant 文本）→ 固定标记 + exit 0；
//   too_large（最后一条 >4000 字符）→ 固定指引标记 + exit 0。
//
// 三条 RED（available / empty / too_large）：今天全部因未知 flag 处理而红——
// `--final` 在 raw 路径被静默忽略（stdout 是 raw ops JSON，不是四态输出）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FINAL_EMPTY_MARKER = "[final: no assistant message]";
// D1-D3 收口（Bug#3 尾巴）：旧文案 "use collect --format json" 对带着 --final
// 照抄的用户仍是死路（--final 接管输出，永远拿不到 JSON）。新文案指明去掉
// --final 的完整命令形状（<runId> 是占位描述，绝不插值真实 runId）。
const FINAL_TOO_LARGE_MARKER =
  "final message exceeds bounded projection; re-run without --final: collect <runId> --format json (slices of one message concatenate - an entry with truncated:false ends a message; follow nextCursor across pages)";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** 进程式 run transcript fixture（collect 服务需要 session.created 带 backendSessionId）。 */
function writeTranscript(dir, runId, events) {
  const lines = events.map((e) => JSON.stringify({ runId, agentId: "test", ...e }));
  writeFileSync(join(dir, `${runId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

function runCollectFinal(dir, runId, extraArgs = []) {
  return spawnSync(process.execPath, [
    "src/cli.js", "collect", runId, "--run-dir", dir, "--final", ...extraArgs,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
    timeout: 60_000,
  });
}

test("TD-112: collect --final（available）stdout 恰为最终 assistant 文本，且继承 messages.collected 审计", () => {
  const dir = makeTempDir("wao-final-ok-");
  try {
    writeTranscript(dir, "run_final_ok", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "prompt.sent", prompt: "say hi" },
      { type: "run.submitted" },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "中间轮说明" }] },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "最终答复文本" }] },
      { type: "run.completed" },
    ]);

    const r = runCollectFinal(dir, "run_final_ok");
    assert.equal(r.status, 0, "available 是正常结果，exit 0");
    assert.equal(r.stdout.trim(), "最终答复文本",
      "stdout 恰为（消毒后的）最后一条 assistant 文本——不是 raw ops JSON、不是投影 JSON");

    // 裁决 3：--final 不豁免审计——collect 本就非只读，成功调用追加 messages.collected。
    const after = readFileSync(join(dir, "run_final_ok.jsonl"), "utf8");
    assert.ok(after.split(/\r?\n/).some((l) => l.includes('"type":"messages.collected"')),
      "成功调用追加一条 messages.collected 审计事件");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-112: collect --final（empty，无 assistant 文本）固定标记 + exit 0", () => {
  const dir = makeTempDir("wao-final-empty-");
  try {
    writeTranscript(dir, "run_final_empty", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "run.submitted" },
      { type: "run.event", kind: "tool_use", tool: "Read", input: { file_path: "a.txt" } },
      { type: "run.completed" },
    ]);

    const r = runCollectFinal(dir, "run_final_empty");
    assert.equal(r.status, 0, "empty 是合法结果，exit 0");
    assert.equal(r.stdout.trim(), FINAL_EMPTY_MARKER, "固定标记，不输出 raw ops JSON");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-112: collect --final（too_large，最后一条 assistant >4000 字符）固定指引标记 + exit 0", () => {
  const dir = makeTempDir("wao-final-big-");
  try {
    writeTranscript(dir, "run_final_big", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "run.submitted" },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "A".repeat(4001) }] },
      { type: "run.completed" },
    ]);

    const r = runCollectFinal(dir, "run_final_big");
    assert.equal(r.status, 0, "too_large 是有界投影的正常结果，exit 0");
    assert.equal(r.stdout.trim(), FINAL_TOO_LARGE_MARKER,
      "固定指引标记：不给部分文本、不给 cursor，指引去掉 --final 重跑拿 JSON 全量");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-112 守卫: collect --final --cursor 组合沿用 compact 既有互斥拒绝（非零退出）", () => {
  const dir = makeTempDir("wao-final-cursor-");
  try {
    writeTranscript(dir, "run_final_cur", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "run.submitted" },
      { type: "run.completed" },
    ]);

    const r = runCollectFinal(dir, "run_final_cur", ["--cursor", "YWJj"]);
    assert.notEqual(r.status, 0, "--final 与 --cursor 互斥，非零退出");
    assert.match(r.stderr, /--final/, "拒绝信息点名 --final");
    assert.match(r.stderr, /--cursor/, "拒绝信息点名 --cursor");
  } finally {
    cleanupDir(dir);
  }
});
