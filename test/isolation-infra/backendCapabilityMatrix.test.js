// test/isolation-infra/backendCapabilityMatrix.test.js
//
// R7-C (C-7): the preflightInvocation ⇔ local-cwd-spawn partition is a PINNED
// invariant, not an emergent coincidence.
//
// The R7-AB cwd-existence early refusal (BOTH layers — dispatchRun's C-2 gate
// and RunManager.start/resume) and the M12-14 invocation-budget preflight key
// on `typeof backend.preflightInvocation === "function"`. That key is sound
// IFF the partition holds:
//   - every backend that DECLARES preflightInvocation composes a LOCAL OS
//     invocation and spawns with cwd: agent.cwd (Node's classic
//     ENOENT-blames-the-executable trap lives there);
//   - every backend WITHOUT it never spawns a local process — it threads
//     agent.cwd as a REMOTE directory hint (HTTP serve API).
// Today the partition is exact (ProcessBackend family + deepseek-harness on
// one side, opencode-serve on the other), but nothing declared the binding —
// any one-sided drift (a capability added to the HTTP backend, or removed
// from a process backend) would silently break the cwd gate's scoping. This
// matrix walks EVERY backend the shared factory (src/backends/factory.js)
// constructs and fails red on either drift.
//
// Maintenance boundary: a backend type newly added to the factory MUST get a
// case below (the hardcoded expected partitions enumerate the current factory
// branches; `registry.js` normalizeAgent's known-backend set is the same five).
//
// Pure group: object construction + injectable seams only. The process-family
// spawn is recorded through the established `_spawnFn` injection point and
// immediately refused by the stub child (zero real processes — the stub's
// non-null exitCode also keeps _kill's taskkill path a no-op); the HTTP
// family drives an injected fetchImpl (zero network).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { backendFor } from "../../src/backends/factory.js";

/**
 * A stub child whose spawn immediately refuses: `once("error", fn)` fires on
 * the next microtask, so the backend's `await spawned` rejects right after the
 * _spawnFn call — the SPAWN OPTIONS are what the matrix asserts; everything
 * after the spawn attempt (handshake/parsers) is deliberately short-circuited.
 * exitCode is non-null so _kill() returns without touching taskkill.
 */
function makeRefusedChild() {
  const child = {
    pid: 424242,
    exitCode: 1,
    signalCode: null,
    once(event, fn) {
      if (event === "error") {
        queueMicrotask(() => fn(new Error("matrix-stub: spawn refused")));
      }
      /* "spawn" never fires — the refusal is the point */
    },
    on() { /* recorded nowhere; the run dies at the spawn promise */ },
    kill() { /* no-op for the stub */ },
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

/** Minimal valid agent fixtures per factory-supported backend (registry shape). */
function factoryCases(dir) {
  return [
    { key: "claude-code", agent: { backend: "claude-code", cwd: "D:/matrix/claude", binary: "node" } },
    { key: "codex", agent: { backend: "codex", cwd: "D:/matrix/codex", binary: "node" } },
    { key: "kimi-code", agent: { backend: "kimi-code", cwd: "D:/matrix/kimi", binary: "node" } },
    {
      key: "deepseek-harness",
      agent: {
        backend: "deepseek-harness",
        cwd: "D:/matrix/dsh",
        // Absolute binary skips the where.exe probe; the spawn is stubbed anyway.
        binary: "D:/matrix/tools/dsh-stub.exe",
        dshConfigPath: join(dir, "dsh-config.json"),
        credentialEnv: "DSH_MATRIX_KEY",
      },
    },
    {
      key: "opencode-serve",
      agent: {
        backend: "opencode-serve",
        cwd: "D:/matrix/remote-hint",
        serveUrl: "http://127.0.0.1:4299",
        agent: "build",
        model: { providerID: "zhipuai-coding-plan", id: "glm-5.2" },
      },
    },
  ];
}

test("R7-C-7 matrix: preflightInvocation ⇔ LOCAL spawn with cwd: agent.cwd, across EVERY factory backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-capmatrix-"));
  try {
    // deepseek-harness's preflight proves dshConfigPath is readable — a real
    // tmp file (the fixture must satisfy the same SSOT contract production does).
    writeFileSync(join(dir, "dsh-config.json"), "{}", "utf8");

    const localSpawnKeys = [];
    const remoteHintKeys = [];
    for (const { key, agent } of factoryCases(dir)) {
      const fetchCalls = [];
      const backend = backendFor(agent, {
        fetchImpl: async (url) => {
          fetchCalls.push(String(url));
          return { ok: true, status: 200, json: async () => ({ data: { id: "sess-matrix" } }) };
        },
      });
      const hasPreflight = typeof backend.preflightInvocation === "function";
      if (hasPreflight) {
        const spawnCalls = [];
        backend._spawnFn = (binary, args, opts) => {
          spawnCalls.push({ binary, args, opts });
          return makeRefusedChild();
        };
        await assert.rejects(
          () => backend.spawn(agent, { prompt: "matrix" }),
          /matrix-stub/,
          `${key}: the stubbed child's spawn refusal propagates`,
        );
        assert.equal(spawnCalls.length, 1, `${key}: exactly ONE local OS spawn composed`);
        assert.equal(
          spawnCalls[0].opts.cwd,
          agent.cwd,
          `${key}: the local spawn runs with cwd = the predicted agent.cwd (the ENOENT-trap seat)`,
        );
        localSpawnKeys.push(key);
      } else {
        // The HTTP family: no local-spawn seam exists on the class at all, and
        // spawn drives the injected fetch — cwd travels as a REMOTE hint.
        assert.equal(typeof backend._spawnFn, "undefined", `${key}: no process spawn seam on this backend class`);
        const handle = await backend.spawn(agent, { prompt: "matrix" });
        assert.ok(fetchCalls.length >= 1, `${key}: spawn drove HTTP requests, not a local process`);
        assert.equal(handle.cwd, agent.cwd, `${key}: cwd threads through as the remote directory hint`);
        remoteHintKeys.push(key);
      }
    }

    // The declared partition, exactly. ANY one-sided drift — a process backend
    // losing preflightInvocation, or the HTTP backend gaining it without
    // becoming a local spawner — moves a key between these lists and goes red.
    assert.deepEqual(
      [...localSpawnKeys].sort(),
      ["claude-code", "codex", "deepseek-harness", "kimi-code"],
      "the local-spawn family is exactly the preflightInvocation-declaring family",
    );
    assert.deepEqual(
      remoteHintKeys,
      ["opencode-serve"],
      "the remote-hint family declares no preflightInvocation",
    );
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("R7-C-7 guard: the factory rejects an unknown backend (the matrix's five cases are the closed factory surface)", () => {
  assert.throws(
    () => backendFor({ backend: "bogus-runtime", cwd: "D:/matrix/bogus" }),
    /Unsupported backend/,
    "a backend outside the matrix cannot be constructed silently",
  );
});
