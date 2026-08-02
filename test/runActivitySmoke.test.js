// test/runActivitySmoke.test.js
//
// M12-8 Package A — ONE end-to-end smoke over a real transcript file.
//
// Drives the real readRunActivity reader + projectRunActivity projector over a
// mixed-category transcript on disk and proves, causally:
//   - activity ordering by seq,
//   - redaction before excerpt/truncation,
//   - cursor replay reconstructs the full ordered safe timeline,
//   - ZERO transcript append (file bytes + line count unchanged) across reads.
//
// This is the integration complement to the pure projection, reader, and MCP
// unit tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { readRunActivity } from "../src/application/runActivity.js";
import { projectRunActivity } from "../src/application/runActivityProjection.js";
import { rmrfRetry } from "./_rmrfHelper.mjs";

function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

function makeGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "R.md"), "x\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: dir });
}

function jl(obj) { return JSON.stringify(obj) + "\n"; }

test("SMOKE: real mixed transcript — ordering, redaction, cursor replay, zero append", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-actsmoke-"));
  const runDir = mkdtempSync(join(tmpdir(), "wao-actsmoke-rd-"));
  try {
    makeGitRepo(dir);
    const secret = "test-secret-smoke-m128";
    const id = "run_smoke", a = "coder_low";
    const lines = [
      jl({ type: "run.submitted", agentId: a, ts: "2026-08-02T00:00:00.000Z", runId: id }),
      jl({ type: "session.created", backend: "process", backendSessionId: "proc_smoke", runId: id, agentId: a }),
      jl({ type: "run.background_submitted", background: true, cwd: dir, runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "running", reason: "first_event", ts: "2026-08-02T00:00:02.000Z", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: "starting work" }], ts: "2026-08-02T00:00:10.000Z", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "command", command: `leak ${secret}`, exitCode: 0, runId: id, agentId: a }),
      jl({ type: "run.event", kind: "tool_use", tool: "Bash", input: { cmd: secret }, runId: id, agentId: a }),
      jl({ type: "run.event", kind: "tool_result", tool: "Bash", output: `out ${secret}`, isError: false, runId: id, agentId: a }),
      jl({ type: "run.event", kind: "file_written", path: "C:\\secrets\\key.pem", runId: id, agentId: a }),
      jl({ type: "run.event", kind: "message", role: "assistant", parts: [{ type: "text", text: `done with ${secret} value` }], ts: "2026-08-02T00:00:20.000Z", runId: id, agentId: a }),
      jl({ type: "run.completed", ts: "2026-08-02T00:10:00.000Z", runId: id, agentId: a }),
      jl({ type: "run.state_change", to: "completed", reason: "done", ts: "2026-08-02T00:10:01.000Z", runId: id, agentId: a }),
    ];
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, `${id}.jsonl`), lines.join(""), "utf8");
    const tp = join(runDir, `${id}.jsonl`);
    const bytesBefore = readFileSync(tp);
    const linesBefore = bytesBefore.toString("utf8").trim().split("\n").length;

    // Read once + project with a small page to force a cursor.
    const snap = await readRunActivity({ runId: id, runDir, authorizedWorkspaceRoot: dir });
    assert.equal(snap.agentId, "coder_low");
    assert.equal(snap.terminal, true);

    const collected = [];
    let cursor = null;
    let guard = 0;
    const env = { SMOKE_TOKEN: secret };
    while (true) {
      const page = projectRunActivity(snap, { runId: id, cursor, pageSize: 3, env });
      collected.push(...page.entries);
      cursor = page.nextCursor;
      if (!cursor) break;
      guard += 1;
      if (guard > 10) throw new Error("runaway pagination");
    }

    // Ordering: categories appear in transcript seq order.
    assert.deepEqual(
      collected.map((e) => e.category),
      ["message", "command", "tool_use", "tool_result", "file_written", "message", "state"],
    );

    // Redaction: the secret never appears anywhere in the projected output.
    const dump = JSON.stringify(collected);
    assert.ok(!dump.includes(secret), "secret never appears in projected activity");
    assert.ok(dump.includes("[REDACTED"), "redaction marker present");
    // The second assistant message text was redacted before truncation.
    const lastMsg = collected.filter((e) => e.category === "message").at(-1);
    assert.ok(lastMsg.text.includes("[REDACTED"), "secret in assistant text redacted");

    // No raw payloads crossed.
    assert.ok(!dump.includes("leak "), "no raw command argv");
    assert.ok(!dump.toLowerCase().includes("c:\\\\secrets"), "no absolute path");
    assert.ok(!dump.includes("proc_smoke"), "no backend session id");

    // Zero append: bytes + line count unchanged after read + full replay.
    assert.equal(readFileSync(tp).equals(bytesBefore), true, "transcript bytes unchanged");
    assert.equal(readFileSync(tp, "utf8").trim().split("\n").length, linesBefore, "line count unchanged");
  } finally { cleanupDir(dir); rmrfRetry(runDir); }
});
