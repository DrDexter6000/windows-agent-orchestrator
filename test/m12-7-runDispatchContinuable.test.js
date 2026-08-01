// test/m12-7-runDispatchContinuable.test.js
//
// M12-7: run_dispatch `continuable` opt-in (Task #5 wiring).
//
// continuable:true (delivery-only) marks a delivery as the ROOT of a continuable
// lineage: dispatch establishes the lineage provider session (turn:first) so a
// future Lead-authorized run_continue can resume the SAME provider conversation
// in the retained worktree. These tests pin:
//   - the first-turn routing envelope on the runner argv (run_lineage / turn:first
//     / the deterministic opaque uuid) + the bounded run.session_reuse audit fact;
//   - continuable omitted/false = byte-compatible ordinary delivery dispatch
//     (NO lineage routing, NO session_reuse event);
//   - continuable is delivery-only (throws before any transcript/fork without one);
//   - a busy lineage slot refuses before any transcript/fork.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchRun } from "../src/application/runDispatch.js";
import { readTranscript, findLatest, findState } from "../src/transcript.js";
import { deriveLineageOpaqueUuid } from "../src/application/sessionReuse.js";

function git(args, cwd) {
  return String(execSync("git " + args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).trim();
}
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "wao-m127-dct-repo-"));
  git("init -b main", repo);
  git("config user.email t@t.com", repo);
  git("config user.name T", repo);
  writeFileSync(join(repo, "README.md"), "# base\n", "utf8");
  git("add -A", repo);
  git("commit -m base", repo);
  return repo;
}
function makeRegistry(dir, agents) {
  const p = join(dir, "agents.json");
  writeFileSync(p, JSON.stringify({ agents }), "utf8");
  return p;
}
function makeFakeSpawn() {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; };
  return { fakeSpawn, calls };
}
function argVal(calls, flag) {
  const a = calls[0].args;
  const i = a.indexOf(flag);
  return i >= 0 ? a[i + 1] : undefined;
}
const DELIVERY = { mode: "git_commit_v1", allowedPaths: ["src"], verificationCommands: ["node --test"] };

test("M12-7-DCT-01: continuable:true establishes the lineage first turn (argv envelope + audit fact)", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-dct01-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const r = await dispatchRun({
      agentId: "coder_hq",
      prompt: "do the work",
      registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      runDir: dir,
      cwd: repo,
      delivery: DELIVERY,
      continuable: true,
      leadSession: "lead-session-dct",
      backendFor: () => ({ supportsSessionReuse: true }),
      spawnFn: fakeSpawn,
    });
    assert.equal(r.accepted, true);
    assert.ok(r.runId && r.runId.startsWith("run_"), "runId generated");

    // Runner argv carries the lineage first-turn routing envelope.
    const routing = JSON.parse(argVal(calls, "--session-reuse-json"));
    assert.equal(routing.mode, "run_lineage");
    assert.equal(routing.turn, "first");
    assert.match(routing.opaqueUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // The opaque uuid is the deterministic lineage key (Lead session + workspace +
    // agent + ROOT runId) — verifiable from public inputs alone.
    assert.equal(
      routing.opaqueUuid,
      deriveLineageOpaqueUuid({ leadSession: "lead-session-dct", workspace: repo, agentId: "coder_hq", rootRunId: r.runId }),
      "opaque uuid is the deterministic lineage key",
    );
    // Delivery-only lineage root: argv ships the delivery + isolates.
    assert.ok(calls[0].args.includes("--isolate"));
    assert.ok(argVal(calls, "--delivery-json"));

    // Bounded audit fact: run_lineage / turn:first / rootRunId (WAO runId only —
    // never the opaque uuid, Lead id, or workspace).
    const events = await readTranscript(join(dir, `${r.runId}.jsonl`));
    const reuseEvt = findLatest(events, "run.session_reuse");
    assert.equal(reuseEvt.mode, "run_lineage");
    assert.equal(reuseEvt.turn, "first");
    assert.equal(reuseEvt.rootRunId, r.runId);
    assert.equal(findState(events), "pending");
    // The opaque uuid must NOT be persisted in the transcript (routing-only).
    assert.ok(!JSON.stringify(events).includes(routing.opaqueUuid), "opaque uuid never persisted in transcript");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-DCT-02: continuable omitted = ordinary delivery dispatch (no lineage routing, no session_reuse event)", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-dct02-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    const r = await dispatchRun({
      agentId: "coder_hq",
      prompt: "do the work",
      registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      runDir: dir,
      cwd: repo,
      delivery: DELIVERY,
      // continuable intentionally omitted (default false).
      spawnFn: fakeSpawn,
    });
    assert.equal(r.accepted, true);
    // No lineage routing on the runner argv (ordinary delivery dispatch).
    assert.equal(argVal(calls, "--session-reuse-json"), undefined, "no session-reuse routing for ordinary dispatch");
    // No run.session_reuse audit fact.
    const events = await readTranscript(join(dir, `${r.runId}.jsonl`));
    assert.equal(findLatest(events, "run.session_reuse"), undefined);
    // Delivery dispatch still isolates + ships the delivery.
    assert.ok(calls[0].args.includes("--isolate"));
    assert.ok(argVal(calls, "--delivery-json"));
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-DCT-03: continuable without delivery is refused before any transcript/fork (delivery-only)", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-dct03-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    await assert.rejects(
      () => dispatchRun({
        agentId: "coder_hq",
        prompt: "do the work",
        registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
        runDir: dir,
        cwd: repo,
        // NO delivery — continuable is delivery-only.
        continuable: true,
        leadSession: "lead-session-dct",
        backendFor: () => ({ supportsSessionReuse: true }),
        spawnFn: fakeSpawn,
      }),
      /delivery-only/i,
    );
    // Fail-closed: zero fork, zero transcript.
    assert.equal(calls.length, 0, "no spawn on continuable-without-delivery");
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".jsonl")), [], "no transcript written");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});

test("M12-7-DCT-04: continuable root refuses an unsupported backend before transcript/fork", async () => {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "wao-m127-dct04-"));
  const { fakeSpawn, calls } = makeFakeSpawn();
  try {
    await assert.rejects(() => dispatchRun({
      agentId: "coder_hq",
      prompt: "do the work",
      registryPath: makeRegistry(dir, { coder_hq: { backend: "claude-code", cwd: repo } }),
      runDir: dir,
      cwd: repo,
      delivery: DELIVERY,
      continuable: true,
      leadSession: "lead-session-dct",
      backendFor: () => ({ supportsSessionReuse: false }),
      spawnFn: fakeSpawn,
    }), /supports provider session reuse/);
    assert.equal(calls.length, 0);
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".jsonl")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
});
