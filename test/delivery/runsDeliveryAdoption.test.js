// test/delivery/runsDeliveryAdoption.test.js
//
// 决定 0098：`runs delivery` 读面的 adoption 行与 --cwd。
//
//   - 文本三种写法：found（Adopted in: <sha…> (WAO-Adopted-From on <branch>)）、
//     not_found（No WAO-Adopted-From trailer on <branch>）、unchecked
//     (Adoption not checked (<reason>))。
//   - acceptance 为 accepted 且 not_found 时不打 not_found 行。
//   - --cwd 指定仓库根；--format json 带 adoption；--wait-ms 路径同样。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlTranscript } from "../../src/transcript.js";

function cleanupDir(dir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; }
    catch { /* retry */ }
  }
}

function gitOf(cwd, args) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
  }).trim();
}

/** 临时仓：base 提交 + 交付提交（供转录引用真实 sha）。 */
function makeRepoWithDelivery(dir) {
  mkdirSync(dir, { recursive: true });
  gitOf(dir, ["init", "-b", "main"]);
  gitOf(dir, ["config", "user.email", "t@t.c"]);
  gitOf(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, "README.md"), "# base\n", "utf8");
  gitOf(dir, ["add", "README.md"]);
  gitOf(dir, ["commit", "-m", "base"]);
  const baseCommit = gitOf(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "src.txt"), "change\n", "utf8");
  gitOf(dir, ["add", "src.txt"]);
  gitOf(dir, ["commit", "-m", "delivery"]);
  const deliveryCommit = gitOf(dir, ["rev-parse", "HEAD"]);
  return { baseCommit, deliveryCommit };
}

/** 落 trailer 采纳提交（主分支），返回 sha。 */
function adoptCommit(cwd, runId) {
  gitOf(cwd, ["commit", "--allow-empty", "-m", "land after fix", "-m", `WAO-Adopted-From: ${runId}`]);
  return gitOf(cwd, ["rev-parse", "HEAD"]);
}

async function writeDeliveryTranscript(dir, runId, repo, { accept = false } = {}) {
  const ref = {
    schemaVersion: 1,
    kind: "git_commit",
    runId,
    baseCommit: repo.baseCommit,
    deliveryCommit: repo.deliveryCommit,
    branch: `wao/${runId}`,
    worktreePath: "/fake/wt",
    changedFiles: ["src/a.js"],
    verification: {
      status: "passed",
      commands: ["echo ok"],
      verifiedCommit: repo.deliveryCommit,
      results: [],
    },
    acceptance: { status: "pending", reviewerType: "lead_agent" },
    integration: { status: "pending", targetCommit: null },
  };
  const transcript = new JsonlTranscript(join(dir, `${runId}.jsonl`), { runId, agentId: "test" });
  await transcript.append("run.started", {
    delivery: {
      mode: "git_commit_v1",
      baseCommit: repo.baseCommit,
      allowedPaths: ["src"],
      verificationCommands: ["echo ok"],
    },
    worktreePath: "/fake/wt",
    worktreeBranch: `wao/${runId}`,
  });
  await transcript.append("run.delivery_created", { delivery: ref });
  await transcript.append("run.delivery_verification_passed", { delivery: ref });
  if (accept) {
    await transcript.append("run.delivery_accepted", {
      delivery: { ...ref, acceptance: { status: "accepted", reviewerType: "lead_agent" } },
      reason: "ok",
    });
  }
  await transcript.append("run.state_change", { from: "running", to: "completed", reason: "done" });
}

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); }
  finally { console.log = orig; }
  return lines.join("\n");
}

test("CLI：found——文本行带 sha 与分支；--format json 带 adoption", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "wao-cli-adopt-found-"));
  try {
    const repo = makeRepoWithDelivery(join(scratch, "repo"));
    const adoptedSha = adoptCommit(join(scratch, "repo"), "run_cli_adopt_1");
    const runDir = join(scratch, "runs");
    mkdirSync(runDir, { recursive: true });
    await writeDeliveryTranscript(runDir, "run_cli_adopt_1", repo);

    const { runsDeliveryCommand } = await import("../../src/commands/runs.js");
    const text = await captureLog(async () => {
      await runsDeliveryCommand(
        ["run_cli_adopt_1", "--run-dir", runDir, "--cwd", join(scratch, "repo")],
        {},
      );
    });
    assert.match(text, /Acceptance: pending/);
    assert.match(
      text,
      new RegExp(`^Adopted in: ${adoptedSha} \\(WAO-Adopted-From on main\\)$`, "m"),
      "found 行 = 提交 sha + 分支名",
    );

    const json = await captureLog(async () => {
      await runsDeliveryCommand(
        ["run_cli_adopt_1", "--run-dir", runDir, "--cwd", join(scratch, "repo"), "--format", "json"],
        {},
      );
    });
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed.adoption, {
      status: "found", commits: [adoptedSha], truncated: false, uncheckedReason: null, branch: "main",
    });
  } finally { cleanupDir(scratch); }
});

test("CLI：not_found——acceptance pending 时打行；accepted 时不打", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "wao-cli-adopt-nf-"));
  try {
    const repo = makeRepoWithDelivery(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    mkdirSync(runDir, { recursive: true });
    await writeDeliveryTranscript(runDir, "run_cli_adopt_2", repo);
    await writeDeliveryTranscript(runDir, "run_cli_adopt_3", repo, { accept: true });

    const { runsDeliveryCommand } = await import("../../src/commands/runs.js");
    const pendingText = await captureLog(async () => {
      await runsDeliveryCommand(["run_cli_adopt_2", "--run-dir", runDir, "--cwd", join(scratch, "repo")], {});
    });
    assert.match(pendingText, /^No WAO-Adopted-From trailer on main$/m, "pending + not_found 打行");

    const acceptedText = await captureLog(async () => {
      await runsDeliveryCommand(["run_cli_adopt_3", "--run-dir", runDir, "--cwd", join(scratch, "repo")], {});
    });
    assert.equal(/WAO-Adopted-From/.test(acceptedText), false, "accepted 且 not_found 不打 adoption 行");
  } finally { cleanupDir(scratch); }
});

test("CLI：没请求交付的运行只在 found 时打 adoption 行", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "wao-cli-adopt-nd-"));
  try {
    makeRepoWithDelivery(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    mkdirSync(runDir, { recursive: true });
    const t = new JsonlTranscript(join(runDir, "run_cli_adopt_nd.jsonl"), { runId: "run_cli_adopt_nd", agentId: "a" });
    await t.append("run.started", { backend: "claude-code", cwd: join(scratch, "repo") });
    await t.transitionState(null, "pending", "created");
    await t.transitionState("pending", "running", "first_event");
    await t.append("run.completed", {});
    await t.transitionState("running", "completed", "done");
    const { runsDeliveryCommand } = await import("../../src/commands/runs.js");
    const text = await captureLog(async () => {
      await runsDeliveryCommand(["run_cli_adopt_nd", "--run-dir", runDir, "--cwd", join(scratch, "repo")], {});
    });
    assert.match(text, /Delivery: \(not requested\)/);
    assert.equal(/WAO-Adopted-From|Adoption not checked/.test(text), false, "没请求交付且没找到：不打 adoption 行");

    // 同一类运行，主分支上有提交声明采纳了它：照常打 found 行。
    gitOf(join(scratch, "repo"), ["commit", "--allow-empty", "-m", "land\n\nWAO-Adopted-From: run_cli_adopt_nd"]);
    const sha = gitOf(join(scratch, "repo"), ["rev-parse", "HEAD"]);
    const foundText = await captureLog(async () => {
      await runsDeliveryCommand(["run_cli_adopt_nd", "--run-dir", runDir, "--cwd", join(scratch, "repo")], {});
    });
    assert.ok(foundText.includes(`Adopted in: ${sha} (WAO-Adopted-From on main)`), "没请求交付但找到了：打 found 行");
  } finally { cleanupDir(scratch); }
});

test("CLI：unchecked——--cwd 指向非 git 目录 → Adoption not checked (git_error)", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "wao-cli-adopt-unc-"));
  try {
    const notGit = join(scratch, "notgit");
    mkdirSync(notGit, { recursive: true });
    const repo = makeRepoWithDelivery(join(scratch, "repo"));
    const runDir = join(scratch, "runs");
    mkdirSync(runDir, { recursive: true });
    await writeDeliveryTranscript(runDir, "run_cli_adopt_4", repo);

    const { runsDeliveryCommand } = await import("../../src/commands/runs.js");
    const text = await captureLog(async () => {
      await runsDeliveryCommand(["run_cli_adopt_4", "--run-dir", runDir, "--cwd", notGit], {});
    });
    assert.match(text, /^Adoption not checked \(git_error\)$/m);
  } finally { cleanupDir(scratch); }
});

test("CLI：--wait-ms 路径同样带 adoption（文本行 + json 字段）", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "wao-cli-adopt-wait-"));
  try {
    const runDir = join(scratch, "runs");
    mkdirSync(runDir, { recursive: true });
    const fakeAdoption = {
      status: "found",
      commits: ["a".repeat(40)],
      truncated: false,
      uncheckedReason: null,
      branch: "main",
    };
    const readiness = async () => ({
      runId: "run_cli_adopt_5",
      readiness: "waiting_for_packaging",
      waitReturnedEarly: false,
      terminalState: "running",
      deliveryAvailable: false,
      deliveryRequested: true,
      deliveryFailure: null,
      adoption: fakeAdoption,
    });
    const { runsDeliveryCommand } = await import("../../src/commands/runs.js");
    const text = await captureLog(async () => {
      await runsDeliveryCommand(
        ["run_cli_adopt_5", "--wait-ms", "1000", "--run-dir", runDir],
        {},
        { getRunDeliveryReadinessFn: readiness },
      );
    });
    assert.match(text, new RegExp(`^Adopted in: ${"a".repeat(40)} \\(WAO-Adopted-From on main\\)$`, "m"));

    const json = await captureLog(async () => {
      await runsDeliveryCommand(
        ["run_cli_adopt_5", "--wait-ms", "1000", "--run-dir", runDir, "--format", "json"],
        {},
        { getRunDeliveryReadinessFn: readiness },
      );
    });
    assert.deepEqual(JSON.parse(json).adoption, fakeAdoption);
  } finally { cleanupDir(scratch); }
});
