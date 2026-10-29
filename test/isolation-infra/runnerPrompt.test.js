// 后台 runner 的提示词经标准输入交接：写入方关闭后读完；多字节字符跨块不损坏；
// runner 先退出（写入报错）时写入方照常返回；读到的内容与 argv 里的摘要对不上
// （派发方写到一半退出）时 runner 不启动 worker。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROMPT_STDIN_FLAG, promptDigest, promptStdinArgs, readRunnerPrompt, writeRunnerPrompt,
} from "../../src/runnerPrompt.js";
import { runMain } from "../../src/backgroundRunner.js";
import { JsonlTranscript, readTranscript, findState } from "../../src/transcript.js";

test("readRunnerPrompt：按 UTF-8 读完整个流，多字节字符被切在两块之间也原样还原", async () => {
  const bytes = Buffer.from("评审这个提交：--不是参数 ✅", "utf8");
  const cut = 2; // 切在"评"的三个字节中间
  const stream = Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]);
  assert.equal(await readRunnerPrompt(stream), "评审这个提交：--不是参数 ✅");
  assert.equal(await readRunnerPrompt(Readable.from([])), "", "空输入是空串");
});

test("writeRunnerPrompt：写入后关闭 stdin；写入报错（runner 已退出）也返回；没有 stdin 的假子进程直接返回", async () => {
  let written = null;
  const stdin = new EventEmitter();
  stdin.end = (text, cb) => { written = text; cb(); };
  assert.equal(await writeRunnerPrompt({ stdin }, "任务书"), "written");
  assert.equal(written, "任务书");

  const broken = new EventEmitter();
  broken.end = () => { setImmediate(() => broken.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }))); };
  assert.equal(await writeRunnerPrompt({ stdin: broken }, "x"), "runner_exited");

  assert.equal(await writeRunnerPrompt({}, "x"), "written");
  assert.equal(PROMPT_STDIN_FLAG, "--prompt-stdin");
});

test("writeRunnerPrompt：runner 活着却一直不读（写入不结束）→ 到时限返回 timeout，不无限等待", async () => {
  const stuck = new EventEmitter();
  stuck.end = () => { /* 管道写满，回调一直不来 */ };
  const started = Date.now();
  assert.equal(await writeRunnerPrompt({ stdin: stuck }, "x".repeat(1024), { timeoutMs: 30 }), "timeout");
  assert.ok(Date.now() - started < 5000);
});

test("promptStdinArgs：标志后面跟提示词 UTF-8 字节的 sha256", () => {
  const prompt = "评审 --这一段";
  assert.equal(promptDigest(prompt), createHash("sha256").update(Buffer.from(prompt, "utf8")).digest("hex"));
  assert.deepEqual(promptStdinArgs(prompt), [PROMPT_STDIN_FLAG, promptDigest(prompt)]);
});

test("runMain：stdin 与摘要对不上（派发方写到一半退出）→ run.error + failed，不启动 worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-prompt-handoff-"));
  try {
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });
    const transcriptDir = join(runDir, "projects", "demo-0a1b2c3d");
    mkdirSync(transcriptDir, { recursive: true });
    const runId = "run_20261029120000000handoff";
    const transcriptPath = join(transcriptDir, `${runId}.jsonl`);
    const seed = new JsonlTranscript(transcriptPath, { runId, agentId: "coder" });
    await seed.transitionState(null, "pending", "background_spawned");

    const full = "完整任务书：最后一条限制是不许改 config/。";
    const truncated = Buffer.from(full, "utf8").subarray(0, 20); // 切在多字节字符中间
    const out = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    try {
      await runMain(
        ["coder", ...promptStdinArgs(full), "--run-dir", runDir, "--run-id", runId,
          "--transcript-dir", transcriptDir, "--registry", join(dir, "missing-agents.json")],
        { stdin: Readable.from([truncated]) },
      );
    } finally { process.stdout.write = write; }

    const result = JSON.parse(out.join(""));
    assert.equal(result.failed, true);
    assert.match(result.error, /prompt handoff incomplete/);
    const events = await readTranscript(transcriptPath);
    const err = events.find((e) => e.type === "run.error");
    assert.equal(err?.phase, "prompt_handoff");
    assert.equal(findState(events), "failed");
    const failedAt = events.find((e) => e.type === "run.state_change" && e.to === "failed");
    assert.equal(failedAt.reason, "startup_error");
    assert.equal(events.some((e) => e.type === "run.submitted" || e.type === "run.started"), false, "worker 没有启动");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runMain：读 stdin 中途出错（如 ECONNRESET）→ 同样落 run.error(prompt_handoff) + failed，不留 pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-prompt-handoff-err-"));
  try {
    const runDir = join(dir, "runs");
    const transcriptDir = join(runDir, "projects", "demo-0a1b2c3d");
    mkdirSync(transcriptDir, { recursive: true });
    const runId = "run_20261029120000000handerr";
    const transcriptPath = join(transcriptDir, `${runId}.jsonl`);
    const seed = new JsonlTranscript(transcriptPath, { runId, agentId: "coder" });
    await seed.transitionState(null, "pending", "background_spawned");

    const failing = new Readable({ read() {} });
    failing.push(Buffer.from("前半段任务书", "utf8"));
    setImmediate(() => failing.destroy(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })));
    const out = [];
    const write = process.stdout.write;
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    try {
      await runMain(
        ["coder", ...promptStdinArgs("前半段任务书和后半段"), "--run-dir", runDir, "--run-id", runId,
          "--transcript-dir", transcriptDir, "--registry", join(dir, "missing-agents.json")],
        { stdin: failing },
      );
    } finally { process.stdout.write = write; }

    assert.match(JSON.parse(out.join("")).error, /reading stdin failed/);
    const events = await readTranscript(transcriptPath);
    assert.equal(events.find((e) => e.type === "run.error")?.phase, "prompt_handoff");
    assert.equal(findState(events), "failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
