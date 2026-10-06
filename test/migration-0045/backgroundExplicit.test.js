// test/migration-0045/backgroundExplicit.test.js
//
// 0045 W2b：显式车道+角色派发的后台穿线。
//   BG-1 dispatchRun 把 --lane/--role 放进 runner argv（spawnFn 注入捕获）。
//   BG-2 runBackground 侧经 dispatchResolution 重解析：explicit 生效（角色库帽 +
//      注记落 run.started）；失败=具名 fail-closed（run.error + failed 终态，
//      不留 pending、不 spawn）。
//   BG-3 无 lane/role 的后台派发字节不变（argv 无新旗标）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

function makeGitRepo(dir) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email t@t.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name T", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# t\n", "utf8");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m i", { cwd: dir, stdio: "pipe" });
}
function cleanupDir(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

test("BG-1: dispatchRun 把 --lane/--role 穿进 runner argv（--model 对先例）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bg1-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      auditor_claude: { backend: "claude-code", model: { id: "claude-opus-5-5" }, reasoning: { effort: "xhigh" }, cwd: dir },
    } }), "utf8");
    const { dispatchRun } = await import("../../src/application/runDispatch.js");
    let captured = null;
    const fakeSpawn = (...spawnArgs) => {
      captured = spawnArgs;
      return { pid: 4321, unref() {}, on() {} };
    };
    await dispatchRun({
      agentId: "auditor_claude", prompt: "t",
      registryPath, runDir: join(dir, "runs"), runId: "run_0045_bg1",
      resolvedLane: "claude-opus", resolvedRole: "tester",
      spawnFn: fakeSpawn, runnerPath: join(dir, "fake-runner.mjs"),
    });
    assert.ok(captured, "spawn 被调用（注入捕获）");
    const argv = captured[1];
    const flat = Array.isArray(argv) ? argv : [];
    const laneIdx = flat.indexOf("--lane");
    const roleIdx = flat.indexOf("--role");
    assert.ok(laneIdx >= 0 && flat[laneIdx + 1] === "claude-opus", "--lane 对在场");
    assert.ok(roleIdx >= 0 && flat[roleIdx + 1] === "tester", "--role 对在场");
  } finally { cleanupDir(dir); }
});

test("BG-3: 无 lane/role 的 dispatchRun argv 无新旗标（字节兼容）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bg3-"));
  try {
    makeGitRepo(dir);
    const registryPath = join(dir, "agents.json");
    writeFileSync(registryPath, JSON.stringify({ agents: {
      auditor_claude: { backend: "claude-code", model: { id: "claude-opus-5-5" }, cwd: dir },
    } }), "utf8");
    const { dispatchRun } = await import("../../src/application/runDispatch.js");
    let captured = null;
    await dispatchRun({
      agentId: "auditor_claude", prompt: "t",
      registryPath, runDir: join(dir, "runs"), runId: "run_0045_bg3",
      spawnFn: (...a) => { captured = a; return { pid: 1, unref() {}, on() {} }; },
      runnerPath: join(dir, "fake-runner.mjs"),
    });
    const flat = captured[1];
    assert.ok(!flat.includes("--lane") && !flat.includes("--role"), "无新旗标（字节兼容）");
  } finally { cleanupDir(dir); }
});

test("BG-2: runBackground 重解析 explicit——角色库帽生效+注记落档；解析失败=具名 fail-closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-bg2-"));
  const ROLES = join(REPO_ROOT, "config", "roles");
  writeFileSync(join(ROLES, "w2b-hat.md"), "# w2b hat\nMARKER_W2B_HAT\n", "utf8");
  try {
    makeGitRepo(dir);
    const runDir = join(dir, "runs");
    // W4d：注册表键=车道键（claude-opus）——explicit 解析直取接线条目。
    const registry = { agents: {
      "claude-opus": { backend: "claude-code", model: { id: "claude-opus-5-5" }, reasoning: { effort: "xhigh" }, cwd: dir },
    } };
    const { mkdirSync } = await import("node:fs");
    mkdirSync(runDir, { recursive: true });
    const { runBackground } = await import("../../src/backgroundRunner.js");
    let spawnHappened = false;
    const result = await runBackground({
      agentId: "claude-opus", prompt: "t", runDir, runId: "run_0045_bg2_ok",
      registry, lane: "claude-opus", role: "w2b-hat",
      backendFor: () => ({
        supportsRoleContract: true, sessionOutlivesProcess: false,
        async spawn() {
          spawnHappened = true;
          return {
            backend: "claude-code", backendSessionId: "s1", messageId: "m1", admittedSeq: 5,
            async *events() { yield { kind: "done", reason: "completed" }; },
            abort: async () => {},
          };
        },
        defaultBinary() { return "node"; }, credentialEnvNames: () => [], validateAgentPolicy() {},
      }),
    });
    assert.ok(spawnHappened, "explicit 后台派发真实 spawn");
    const started = (() => {
      for (const line of readFileSync(join(runDir, "run_0045_bg2_ok.jsonl"), "utf8").split("\n")) {
        try { const o = JSON.parse(line); if (o.type === "run.started") return o; } catch { /* skip */ }
      }
      return null;
    })();
    assert.equal(started.resolvedFrom, "explicit");
    assert.equal(started.roleId, "w2b-hat");
    assert.equal(started.rolePin.systemPrompt, "config/roles/w2b-hat.md", "角色库帽经钉住机制生效");

    // 解析失败（未知 lane）：具名 fail-closed——run.error + failed 终态，零 spawn。
    // 忠实预写 dispatchRun 的管道事实（background_submitted + pending），真后台
    // 流里这两条先于 runner 存在，fail-closed 的 pending→failed 依赖它。
    const { JsonlTranscript, STATE_CHANGE_REASON: SCR } = await import("../../src/transcript.js");
    const pre = new JsonlTranscript(join(runDir, "run_0045_bg2_bad.jsonl"), { runId: "run_0045_bg2_bad", agentId: "auditor_claude" });
    await pre.append("run.background_submitted", { background: true });
    await pre.transitionState(null, "pending", SCR.background_spawned);
    let failSpawnHappened = false;
    const failResult = await runBackground({
      agentId: "claude-opus", prompt: "t", runDir, runId: "run_0045_bg2_bad",
      registry, lane: "no-such-lane", role: "w2b-hat",
      backendFor: () => ({
        supportsRoleContract: true, sessionOutlivesProcess: false,
        async spawn() { failSpawnHappened = true; return null; },
        defaultBinary() { return "node"; }, credentialEnvNames: () => [], validateAgentPolicy() {},
      }),
    });
    assert.equal(failResult.failed, true, "返回 failed 结果");
    assert.match(failResult.error, /unknown_lane/, "具名闭集码");
    assert.equal(failSpawnHappened, false, "零 spawn");
    const badLines = readFileSync(join(runDir, "run_0045_bg2_bad.jsonl"), "utf8").split("\n")
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    assert.ok(badLines.some((o) => o.type === "run.error" && o.phase === "dispatch_resolution"), "run.error 落档");
    assert.ok(badLines.some((o) => o.type === "run.state_change" && o.to === "failed" && o.reason === "dispatch_resolution_failed"),
      "failed 终态 + 闭集原因");
  } finally {
    cleanupDir(dir);
    rmSync(join(ROLES, "w2b-hat.md"), { force: true });
  }
});
