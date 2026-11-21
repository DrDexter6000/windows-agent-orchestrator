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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FINAL_EMPTY_MARKER = "[final: no assistant message]";
// D1-D3 收口（Bug#3 尾巴）：旧文案 "use collect --format json" 对带着 --final
// 照抄的用户仍是死路（--final 接管输出，永远拿不到 JSON）。新文案指明去掉
// --final 的完整命令形状（<runId> 是占位描述，绝不插值真实 runId）。
const FINAL_TOO_LARGE_MARKER =
  "final message exceeds bounded projection; write it to a file: collect <runId> --final --out FILE - or re-run without --final: collect <runId> --format json (slices of one message concatenate - an entry with truncated:false ends a message; follow nextCursor across pages)";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** 转录文本里的 messages.collected 审计条数。 */
function countCollected(text) {
  return text.split(/\r?\n/).filter((l) => l.includes('"type":"messages.collected"')).length;
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

// ===== --out：把最终 assistant 消息完整写进文件（长短都写，零截断） =====

test("TD-112 --out（too_large 正文跨多页）: 文件=完整文本（零截断），stdout 一行含字符数与路径，恰追加一条 messages.collected", () => {
  const dir = makeTempDir("wao-final-out-big-");
  const outDir = makeTempDir("wao-final-out-big-out-");
  try {
    const text = "零截断长文。".repeat(5000); // 30000 字符，远超 4000，跨多页
    assert.ok(text.length > 4000, "测试前提：正文远超 4000 字符");
    writeTranscript(dir, "run_final_out_big", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "prompt.sent", prompt: "say hi" },
      { type: "run.submitted" },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text }] },
      { type: "run.completed" },
    ]);

    const outFile = join(outDir, "final.txt");
    const r = runCollectFinal(dir, "run_final_out_big", ["--out", outFile]);
    assert.equal(r.status, 0, `--out 是正常结果，exit 0（stderr: ${r.stderr}）`);
    assert.equal(readFileSync(outFile, "utf8"), text, "文件内容 = 完整文本（逐页取回拼齐，零截断）");
    assert.match(
      r.stdout.trim(),
      new RegExp(`^final message: ${text.length} chars written to .+$`),
      "stdout 恰一行：字符数 + 文件路径",
    );
    assert.ok(r.stdout.trim().includes(outFile), "stdout 带文件路径");
    // 一次成功调用仍然只追加一条 messages.collected（逐页取回不追加审计）。
    const after = readFileSync(join(dir, "run_final_out_big.jsonl"), "utf8");
    const collected = after.split(/\r?\n/).filter((l) => l.includes('"type":"messages.collected"'));
    assert.equal(collected.length, 1, "恰一条 messages.collected");
  } finally {
    cleanupDir(dir);
    cleanupDir(outDir);
  }
});

test("TD-112 --out（available 短文本）: 文件 = 该文本（长短都写）", () => {
  const dir = makeTempDir("wao-final-out-short-");
  const outDir = makeTempDir("wao-final-out-short-out-");
  try {
    writeTranscript(dir, "run_final_out_short", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "prompt.sent", prompt: "say hi" },
      { type: "run.submitted" },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "简短最终答复" }] },
      { type: "run.completed" },
    ]);

    const outFile = join(outDir, "final.txt");
    const r = runCollectFinal(dir, "run_final_out_short", ["--out", outFile]);
    assert.equal(r.status, 0, `exit 0（stderr: ${r.stderr}）`);
    assert.equal(readFileSync(outFile, "utf8"), "简短最终答复", "短文本原样写文件");
    assert.match(r.stdout.trim(), /^final message: 6 chars written to .+$/, "stdout 报字符数");
  } finally {
    cleanupDir(dir);
    cleanupDir(outDir);
  }
});

test("TD-112 --out（empty，无 assistant 文本）: 写出空文件并打印空标记", () => {
  const dir = makeTempDir("wao-final-out-empty-");
  const outDir = makeTempDir("wao-final-out-empty-out-");
  try {
    writeTranscript(dir, "run_final_out_empty", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "run.submitted" },
      { type: "run.event", kind: "tool_use", tool: "Read", input: { file_path: "a.txt" } },
      { type: "run.completed" },
    ]);

    const outFile = join(outDir, "final.txt");
    const r = runCollectFinal(dir, "run_final_out_empty", ["--out", outFile]);
    assert.equal(r.status, 0, "empty 是合法结果，exit 0");
    assert.equal(readFileSync(outFile, "utf8"), "", "空文件");
    assert.equal(
      r.stdout.trim(),
      `${FINAL_EMPTY_MARKER} (empty file written to ${outFile})`,
      "打印空标记 + 文件路径",
    );
  } finally {
    cleanupDir(dir);
    cleanupDir(outDir);
  }
});

test("TD-112 守卫: 只给 --out 不给 --final 抛错（非零退出，点名两旗标）", () => {
  const dir = makeTempDir("wao-final-outonly-");
  try {
    writeTranscript(dir, "run_final_outonly", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "run.submitted" },
      { type: "run.completed" },
    ]);

    const r = spawnSync(process.execPath, [
      "src/cli.js", "collect", "run_final_outonly", "--run-dir", dir, "--out", join(dir, "no.txt"),
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
      timeout: 60_000,
    });
    assert.notEqual(r.status, 0, "--out 必须与 --final 同现，非零退出");
    assert.match(r.stderr, /--out goes with --final/, "拒绝信息说明 --out 伴随 --final");
  } finally {
    cleanupDir(dir);
  }
});

// ===== 第 130 批必改④：--out 单快照取全文（不再逐页翻读，无长度上限） =====

test("--out：早先叙述 2,000,000 字、最终回答 4,004 字——写出的文件恰为回答（游标寻址不到也不挡）", () => {
  const dir = makeTempDir("wao-final-out-narr-");
  const outDir = makeTempDir("wao-final-out-narr-out-");
  try {
    const narration = "叙".repeat(2_000_000);
    const answer = "答".repeat(4004);
    writeTranscript(dir, "run_final_out_narr", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "prompt.sent", prompt: "say hi" },
      { type: "run.submitted" },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: narration }] },
      { type: "run.event", kind: "tool_use", tool: "Bash", input: { command: "echo done" } },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: answer }] },
      { type: "run.completed" },
    ]);
    const outFile = join(outDir, "final.txt");
    const r = runCollectFinal(dir, "run_final_out_narr", ["--out", outFile]);
    assert.equal(r.status, 0, `早先的 200 万字叙述不再挡住 --final --out（stderr: ${r.stderr}）`);
    assert.equal(readFileSync(outFile, "utf8"), answer, "文件 = 最终回答（不是叙述、不是半截）");
    assert.match(r.stdout.trim(), new RegExp(`^final message: ${answer.length} chars written to .+$`), "stdout 报最终回答的字符数");
    const after = readFileSync(join(dir, "run_final_out_narr.jsonl"), "utf8");
    assert.equal(after.split(/\r?\n/).filter((l) => l.includes('"type":"messages.collected"')).length, 1,
      "成功调用恰一条审计");
  } finally {
    cleanupDir(dir);
    cleanupDir(outDir);
  }
});

test("--out：最终回答本身超过一百万字——照样完整写出（单快照读无长度上限）", () => {
  const dir = makeTempDir("wao-final-out-over-");
  const outDir = makeTempDir("wao-final-out-over-out-");
  try {
    const answer = "终".repeat(1_200_000);
    writeTranscript(dir, "run_final_out_over", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "prompt.sent", prompt: "say hi" },
      { type: "run.submitted" },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: answer }] },
      { type: "run.completed" },
    ]);
    const outFile = join(outDir, "final.txt");
    const r = runCollectFinal(dir, "run_final_out_over", ["--out", outFile]);
    assert.equal(r.status, 0, `超百万的最终回答完整写出（stderr: ${r.stderr}）`);
    assert.equal(readFileSync(outFile, "utf8").length, answer.length, "零截断");
    assert.match(r.stdout.trim(), new RegExp(`^final message: ${answer.length} chars written to .+$`));
  } finally {
    cleanupDir(dir);
    cleanupDir(outDir);
  }
});

test("--out：写出的文本与 --format json 分页读到的同一条消息拼接结果逐字相同，脱敏一致", () => {
  const dir = makeTempDir("wao-final-out-parity-");
  const outDir = makeTempDir("wao-final-out-parity-out-");
  try {
    // 正文带环境密钥与控制字符：两条路径共用同一 extractAssistantTexts + redactor +
    // 控制字符清理，逐字一致必须连脱敏与消毒结果也一致。
    const SECRET = "wao-collect-test-secret-value-0123";
    const body = `开头 ${SECRET} 中段\u0001` + "尾".repeat(9000) + " 收尾";
    writeTranscript(dir, "run_final_out_parity", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "prompt.sent", prompt: "say hi" },
      { type: "run.submitted" },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "早先的一段叙述" }] },
      { type: "run.event", kind: "tool_use", tool: "Bash", input: { command: "echo done" } },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: body }] },
      { type: "run.completed" },
    ]);
    const outFile = join(outDir, "final.txt");
    const env = { ...process.env, WAO_COLLECT_TEST_SECRET: SECRET };
    const r = spawnSync(process.execPath, [
      "src/cli.js", "collect", "run_final_out_parity", "--run-dir", dir, "--final", "--out", outFile,
    ], { cwd: ROOT, encoding: "utf8", env: { ...env, WAO_SKIP_VERSION_GUARD: "1" }, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const fileText = readFileSync(outFile, "utf8");

    // 分页读同一条消息：跟着 nextCursor 翻完，取最后一条消息（truncated:false 结尾）
    // 的全部切片拼接。
    const entries = [];
    let cursor = undefined;
    for (let page = 0; page < 20; page += 1) {
      const args = ["src/cli.js", "collect", "run_final_out_parity", "--run-dir", dir, "--format", "json"];
      if (cursor !== undefined) args.push("--cursor", cursor);
      const p = spawnSync(process.execPath, args,
        { cwd: ROOT, encoding: "utf8", env: { ...env, WAO_SKIP_VERSION_GUARD: "1" }, timeout: 60_000 });
      assert.equal(p.status, 0, p.stderr);
      const payload = JSON.parse(p.stdout);
      entries.push(...payload.messages);
      if (!payload.nextCursor) break;
      cursor = payload.nextCursor;
    }
    // 按消息边界重拼：切片累积，`truncated:false` 收一条消息；最后收完的就是最终消息
    //（文档规则：同一条消息的切片首尾相接，`truncated:false` 的切片是这条消息的末尾）。
    let pagedText = "";
    let current = "";
    for (const e of entries) {
      current += e.text;
      if (e.truncated !== true) { pagedText = current; current = ""; }
    }

    assert.equal(fileText, pagedText, "文件与分页拼接逐字相同（含脱敏与控制字符清理）");
    assert.ok(!fileText.includes(SECRET), "密钥两条路径同样被脱敏");
    assert.ok(fileText.includes("\uFFFD"), "控制字符两条路径同样被替换为 U+FFFD");
  } finally {
    cleanupDir(dir);
    cleanupDir(outDir);
  }
});

test("--out：文件写不进去时非零退出、零审计追加；与 --format json 同用时不再提示 stdout 是四态文本", () => {
  const dir = makeTempDir("wao-final-out-write-");
  const outDir = makeTempDir("wao-final-out-write-out-");
  try {
    writeTranscript(dir, "run_final_out_write", [
      { type: "run.started", backend: "claude-code" },
      { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
      { type: "prompt.sent", prompt: "say hi" },
      { type: "run.submitted" },
      { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "短答案" }] },
      { type: "run.completed" },
    ]);
    const collected = () => readFileSync(join(dir, "run_final_out_write.jsonl"), "utf8")
      .split(/\r?\n/).filter((l) => l.includes('"type":"messages.collected"')).length;
    const bad = runCollectFinal(dir, "run_final_out_write", ["--out", join(outDir, "no-such-dir", "final.txt")]);
    assert.notEqual(bad.status, 0, "目标目录不存在，写不进去");
    assert.equal(collected(), 0, "写文件失败的调用零审计追加");

    const good = runCollectFinal(dir, "run_final_out_write", ["--out", join(outDir, "final.txt"), "--format", "json"]);
    assert.equal(good.status, 0, good.stderr);
    assert.doesNotMatch(good.stderr, /four-state text/, "答案进了文件，不再提示 stdout 是四态文本");
    assert.equal(collected(), 1);
  } finally {
    cleanupDir(dir);
    cleanupDir(outDir);
  }
});

// ===== TD-365（第 132 批）：--out 不得写进运行存储目录 =====
//
// 转录是运行状态的唯一来源：--out 指向本运行（或任何运行）的 .jsonl 时，旧实现
// 先用回答覆盖转录、随后的审计追加才报错——覆盖了的转录找不回来。现在写文件之前
// 按真实路径判断：落在本次运行存储目录里的任何路径（不只本运行的转录）都固定
// 文案拒绝，零写入、零审计追加；junction/符号链接以真实路径为准。

const TD365_EVENTS = [
  { type: "run.started", backend: "claude-code" },
  { type: "session.created", backend: "process", backendSessionId: "proc_12345" },
  { type: "prompt.sent", prompt: "say hi" },
  { type: "run.submitted" },
  { type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "最终答复" }] },
  { type: "run.completed" },
];

test("TD-365: --out 指向本运行的转录——固定文案拒绝，转录逐字节不变，零审计追加", () => {
  const dir = makeTempDir("wao-td365-self-");
  try {
    writeTranscript(dir, "run_td365_self", TD365_EVENTS);
    const transcriptPath = join(dir, "run_td365_self.jsonl");
    const before = readFileSync(transcriptPath, "utf8");
    const r = runCollectFinal(dir, "run_td365_self", ["--out", transcriptPath]);
    assert.notEqual(r.status, 0, "指向本运行转录必须非零退出");
    assert.match(r.stderr, /collect --out: .+ is inside the run store \(.+\); write the answer somewhere else/);
    const after = readFileSync(transcriptPath, "utf8");
    assert.equal(after, before, "转录逐字节不变");
    assert.equal(countCollected(after), 0, "零审计追加");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-365: --out 指向运行存储里另一个运行的转录——同样拒绝", () => {
  const dir = makeTempDir("wao-td365-other-");
  try {
    writeTranscript(dir, "run_td365_a", TD365_EVENTS);
    writeTranscript(dir, "run_td365_b", TD365_EVENTS);
    const otherPath = join(dir, "run_td365_b.jsonl");
    const beforeOther = readFileSync(otherPath, "utf8");
    const beforeOwn = readFileSync(join(dir, "run_td365_a.jsonl"), "utf8");
    const r = runCollectFinal(dir, "run_td365_a", ["--out", otherPath]);
    assert.notEqual(r.status, 0, "指向别的运行的转录同样拒绝");
    assert.match(r.stderr, /is inside the run store/);
    assert.equal(readFileSync(otherPath, "utf8"), beforeOther, "被指名的转录逐字节不变");
    assert.equal(readFileSync(join(dir, "run_td365_a.jsonl"), "utf8"), beforeOwn, "本运行转录逐字节不变");
    assert.equal(countCollected(readFileSync(join(dir, "run_td365_a.jsonl"), "utf8")), 0, "本运行零审计追加");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-365: --out 指向运行存储根下尚不存在的新文件——拒绝范围是目录里的任何路径", () => {
  const dir = makeTempDir("wao-td365-new-");
  try {
    writeTranscript(dir, "run_td365_new", TD365_EVENTS);
    const r = runCollectFinal(dir, "run_td365_new", ["--out", join(dir, "answer.txt")]);
    assert.notEqual(r.status, 0, "存储目录里的新文件路径同样拒绝（不只已存在的转录）");
    assert.match(r.stderr, /is inside the run store/);
    assert.ok(!existsSync(join(dir, "answer.txt")), "零写入");
    assert.equal(countCollected(readFileSync(join(dir, "run_td365_new.jsonl"), "utf8")), 0, "零审计追加");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-365: --out 经 junction 指进运行存储——以真实路径拒绝（仅 Windows；建不了 junction 就跳过）", (t) => {
  if (process.platform !== "win32") {
    t.skip("非 Windows——junction 检查不适用");
    return;
  }
  const dir = makeTempDir("wao-td365-junc-");
  const linkDir = makeTempDir("wao-td365-junc-link-");
  try {
    writeTranscript(dir, "run_td365_junc", TD365_EVENTS);
    const junction = join(linkDir, "into-store");
    try {
      symlinkSync(dir, junction, "junction");
    } catch (error) {
      t.skip(`本机建不了 junction：${error?.message ?? error}`);
      return;
    }
    const r = runCollectFinal(dir, "run_td365_junc", ["--out", join(junction, "final.txt")]);
    assert.notEqual(r.status, 0, "junction 进来的路径以真实路径判断");
    assert.match(r.stderr, /is inside the run store/);
    assert.ok(!existsSync(join(dir, "final.txt")), "存储里零写入");
    assert.equal(countCollected(readFileSync(join(dir, "run_td365_junc.jsonl"), "utf8")), 0, "零审计追加");
  } finally {
    cleanupDir(linkDir);
    cleanupDir(dir);
  }
});

test("TD-365: --out 是一个失效的符号链接（原先指进运行存储）——拒绝，存储里零写入（建不了符号链接就跳过）", (t) => {
  const dir = makeTempDir("wao-td365-dangling-");
  const linkDir = makeTempDir("wao-td365-dangling-link-");
  try {
    writeTranscript(dir, "run_td365_dangling", TD365_EVENTS);
    const gone = join(dir, "gone.txt");
    const link = join(linkDir, "answer.txt");
    try {
      symlinkSync(gone, link, "file");
    } catch (error) {
      t.skip(`本机建不了符号链接：${error?.message ?? error}`);
      return;
    }
    const r = runCollectFinal(dir, "run_td365_dangling", ["--out", link]);
    assert.notEqual(r.status, 0, "解析不出的链接不跟着写");
    assert.match(r.stderr, /is a link whose target cannot be resolved/);
    assert.ok(!existsSync(gone), "存储里零写入");
    assert.equal(countCollected(readFileSync(join(dir, "run_td365_dangling.jsonl"), "utf8")), 0, "零审计追加");
  } finally {
    cleanupDir(linkDir);
    cleanupDir(dir);
  }
});

test("TD-365: 运行存储之外的普通路径照常写出（含审计）", () => {
  const dir = makeTempDir("wao-td365-ok-");
  const outDir = makeTempDir("wao-td365-ok-out-");
  try {
    writeTranscript(dir, "run_td365_ok", TD365_EVENTS);
    const outFile = join(outDir, "final.txt");
    const r = runCollectFinal(dir, "run_td365_ok", ["--out", outFile]);
    assert.equal(r.status, 0, `存储外的目标照常写出（stderr: ${r.stderr}）`);
    assert.equal(readFileSync(outFile, "utf8"), "最终答复", "文件内容正确");
    assert.equal(countCollected(readFileSync(join(dir, "run_td365_ok.jsonl"), "utf8")), 1, "恰一条审计");
  } finally {
    cleanupDir(dir);
    cleanupDir(outDir);
  }
});
