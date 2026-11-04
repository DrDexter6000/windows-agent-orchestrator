// test/isolation-infra/waoStateMainWorktree.test.js
//
// 决定 0111：链接工作树的 .wao 本地状态落到主工作树（decisions/ 留在工作树）。
// 真实 git 冒烟（os.tmpdir() 下 mkdtemp 建仓、`git worktree add` 出链接工作树，
// 同 projectIdentityLinkedWorktreeGit.test.js 的夹具纪律）：
//   - 不带 --state-dir、只有配置默认值：consult 组记录目录、wao stage/declare/
//     handoff 落主工作树 .wao/；wao decision add 落工作树 .wao/decisions/；
//     runs dashboard 读主工作树 pipeline/。
//   - 显式 --state-dir .wao 留在工作树。
//   - wao init 报两个路径（决定目录 + 状态目录），槽位各归其位。
//   - consult show / consult wait 的旧记录回退（ENOENT 才回退；回显真实路径；
//     配置了非默认 stateDir 名字时回退到按那个名字算出的旧目录）。
//   - doctor 提示工作树里留下的本地状态（只提示，不判失败）。
// 解析单元面（mainWorktreeRoot / getWaoStateDir 的形状矩阵）在
// projectIdentityLinkedWorktree(Git).test.js 与 waoDir.test.js。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { waoCommand } from "../../src/commands/wao.js";
import { waoDoctorCommand } from "../../src/commands/doctor.js";
import { runsDashboardCommand } from "../../src/commands/runs.js";
import { consultCommand } from "../../src/commands/consult.js";
import { validateWaoDir } from "../../src/waoDir.js";

function gitOf(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2005-04-07T22:13:13", GIT_COMMITTER_DATE: "2005-04-07T22:13:13" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

/** 主检出仓（main 分支，一次提交）+ 一个链接工作树 <root>/wt。 */
function makeRepoWithWorktree(root) {
  const main = join(root, "proj");
  mkdirSync(main, { recursive: true });
  gitOf(root, ["init", "-b", "main", main]);
  gitOf(main, ["config", "user.email", "t@t.c"]);
  gitOf(main, ["config", "user.name", "T"]);
  writeFileSync(join(main, "README.md"), "# base\n", "utf8");
  gitOf(main, ["add", "README.md"]);
  gitOf(main, ["commit", "-m", "base"]);
  const wt = join(root, "proj-wt");
  gitOf(root, ["-C", main, "worktree", "add", wt]);
  return { main, wt };
}

/** 捕获 console.log 行（CLI JSON 输出的读取面）。 */
async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

const CONFIG = (root) => ({
  stateDir: ".wao",
  registry: join(root, "agents.json"),
  runDir: join(root, "runs"),
});

function writeRegistry(root) {
  writeFileSync(join(root, "agents.json"), JSON.stringify({
    agents: { la: { backend: "codex", cwd: root, model: { id: "gpt-x" } } },
  }), "utf8");
}

test("0111 CLI: 只有配置默认值——consult 组记录目录接到主工作树（consult 不新增 --state-dir）", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0111c-"));
  try {
    const { main, wt } = makeRepoWithWorktree(root);
    let captured = null;
    const lines = await captureLog(() => consultCommand(
      ["run", "brief.md", "--seats", "seat_a", "--cwd", wt, "--format", "json"],
      {},
      {
        runConsult: async (input) => {
          captured = input;
          return {
            consultId: "consult_20261104000000000stub000",
            recordPath: join(input.consultsDir, "consult_20261104000000000stub000.json"),
            questions: [], seats: [], brief: null, budgetMs: 0, elapsedMs: 0,
            fieldDiff: [], fieldValues: {}, bricks: {},
          };
        },
      },
    ));
    assert.ok(captured, "runConsult 被调用");
    assert.equal(captured.consultsDir, join(main, ".wao", "runs", "consults"),
      "组记录目录 = 主工作树 .wao/runs/consults（不落在链接工作树里）");
    assert.ok(lines.length > 0, "json 输出在场");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0111 CLI: wao stage/declare/handoff 落主工作树 .wao/；wao decision add 落工作树 .wao/decisions/", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0111w-"));
  try {
    const { main, wt } = makeRepoWithWorktree(root);
    writeRegistry(root);
    mkdirSync(join(root, "runs"), { recursive: true });
    const config = CONFIG(root);
    // decision add 需要决定目录已有骨架（decisions/ + map.md）——先 init。
    await captureLog(() => waoCommand(["init", "--cwd", wt], config));

    await captureLog(() => waoCommand(["stage", "1", "--task", "起草", "--cwd", wt], config));
    assert.ok(readdirSync(join(main, ".wao", "pipeline")).some((f) => f.startsWith("STAGE-1-")),
      "STAGE 落主工作树 pipeline/");
    assert.ok(!existsSync(join(wt, ".wao", "pipeline")), "链接工作树不建 pipeline/");

    await captureLog(() => waoCommand(["declare", "--task", "小事", "--reason", "too-small", "--cwd", wt], config));
    assert.ok(readdirSync(join(main, ".wao", "pipeline")).some((f) => f.startsWith("DECL-")),
      "DECL 落主工作树 pipeline/");

    await captureLog(() => waoCommand(["handoff", "write", "--from", "a", "--to", "b", "--summary", "s", "--cwd", wt], config));
    assert.ok(readdirSync(join(main, ".wao", "handoff")).length > 1, "交接卡落主工作树 handoff/");

    await captureLog(() => waoCommand(["decision", "add", "--title", "保持决定留树上", "--body", "b", "--cwd", wt], config));
    assert.ok(readdirSync(join(wt, ".wao", "decisions")).some((f) => /^\d{4}-/.test(f)),
      "decision add 落工作树 .wao/decisions/（随分支提交）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0111 CLI: 显式 --state-dir .wao 留在工作树", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0111e-"));
  try {
    const { main, wt } = makeRepoWithWorktree(root);
    writeRegistry(root);
    mkdirSync(join(root, "runs"), { recursive: true });
    // addStage 不建目录（先 init 是既有前提）；显式 --state-dir 的 init 整体落在工作树。
    await captureLog(() => waoCommand(["init", "--state-dir", ".wao", "--cwd", wt], CONFIG(root)));
    await captureLog(() => waoCommand(
      ["stage", "1", "--task", "留在树里", "--state-dir", ".wao", "--cwd", wt],
      CONFIG(root),
    ));
    assert.ok(readdirSync(join(wt, ".wao", "pipeline")).some((f) => f.startsWith("STAGE-1-")),
      "显式 --state-dir 时 STAGE 留在工作树");
    assert.ok(!existsSync(join(main, ".wao", "pipeline")), "主工作树不被写入");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0111 CLI: wao init 在链接工作树里报两个路径，槽位各归其位，.gitignore 写在工作树", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0111i-"));
  try {
    const { main, wt } = makeRepoWithWorktree(root);
    const lines = await captureLog(() => waoCommand(["init", "--cwd", wt], CONFIG(root)));
    const parsed = JSON.parse(lines.join("\n"));
    assert.equal(parsed.waoDir, join(wt, ".wao"), "waoDir 字段=决定目录（工作树）");
    assert.equal(parsed.stateDir, join(main, ".wao"), "stateDir 字段=状态目录（主工作树）");
    assert.ok(existsSync(join(wt, ".wao", "decisions", "map.md")), "decisions/ 建在工作树");
    for (const slot of ["project.md", "pipeline", "handoff", "runs", "migration"]) {
      assert.ok(existsSync(join(main, ".wao", slot)), `状态槽位 ${slot} 建在主工作树`);
    }
    assert.ok(existsSync(join(wt, ".gitignore")), ".gitignore 照旧写在 cwd（工作树）");
    const check = validateWaoDir(join(wt, ".wao"), join(main, ".wao"));
    assert.ok(check.ok, `分离目录齐备应 ok（missing=${check.missing} unexpected=${check.unexpected}）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- consult show / wait 的旧记录回退 ----

function legacyRecord(consultId) {
  return {
    consultId,
    createdAt: "2026-11-04T00:00:00.000Z",
    brief: { path: null, sha256: "ab".repeat(32) },
    budgetMs: 600000,
    elapsedMs: 100,
    questions: [{ q: 1, heading: "## Q1 可行吗" }],
    seats: [{ agentId: "seat_a", runId: null, runState: "dispatch_failed", formatState: "empty" }],
    fieldDiff: [],
  };
}

test("0111 CLI: consult show——状态目录没有旧记录时回退工作树落点，回显真实路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0111s-"));
  try {
    const { main, wt } = makeRepoWithWorktree(root);
    const consultId = "consult_20261104000000000abc123";
    // 改动前的落点（工作树）有记录；主工作树状态目录没有。
    mkdirSync(join(wt, ".wao", "runs", "consults"), { recursive: true });
    writeFileSync(join(wt, ".wao", "runs", "consults", `${consultId}.json`),
      JSON.stringify(legacyRecord(consultId)), "utf8");

    const lines = await captureLog(() => consultCommand(
      ["show", consultId, "--cwd", wt, "--format", "json"],
      {},
    ));
    const parsed = JSON.parse(lines.join("\n"));
    assert.equal(parsed.recordPath, join(wt, ".wao", "runs", "consults", `${consultId}.json`),
      "回显实际读到的位置（工作树落点）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0111 CLI: consult wait（含 --until-settled）同样回退并回显真实路径；状态目录直接有记录时不回退", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0111t-"));
  try {
    const { main, wt } = makeRepoWithWorktree(root);
    mkdirSync(join(root, "runs"), { recursive: true });

    const legacyId = "consult_20261104000000000abc123";
    const settledId = "consult_20261104000000000abc124";
    mkdirSync(join(wt, ".wao", "runs", "consults"), { recursive: true });
    writeFileSync(join(wt, ".wao", "runs", "consults", `${legacyId}.json`),
      JSON.stringify(legacyRecord(legacyId)), "utf8");
    writeFileSync(join(wt, ".wao", "runs", "consults", `${settledId}.json`),
      JSON.stringify(legacyRecord(settledId)), "utf8");

    const origErr = console.error;
    console.error = () => {};
    try {
      const waitLines = await captureLog(() => consultCommand(
        ["wait", legacyId, "--cwd", wt, "--format", "json"],
        {},
      ));
      const waited = JSON.parse(waitLines.join("\n"));
      assert.equal(waited.recordPath, join(wt, ".wao", "runs", "consults", `${legacyId}.json`),
        "consult wait 回退后回显真实路径");

      const settled = await captureLog(() => consultCommand(
        ["wait", settledId, "--until-settled", "--cwd", wt, "--format", "json"],
        {},
        { readTranscript: async () => [] },
      ));
      const parsed = JSON.parse(settled.join("\n"));
      assert.equal(parsed.recordPath, join(wt, ".wao", "runs", "consults", `${settledId}.json`),
        "--until-settled 回退后回显真实路径");
    } finally {
      console.error = origErr;
    }

    // 状态目录（主工作树）直接有记录 → 不回退，读主工作树那份。
    const stateId = "consult_20261104000000000abc125";
    mkdirSync(join(main, ".wao", "runs", "consults"), { recursive: true });
    writeFileSync(join(main, ".wao", "runs", "consults", `${stateId}.json`),
      JSON.stringify(legacyRecord(stateId)), "utf8");
    const direct = await captureLog(() => consultCommand(
      ["show", stateId, "--cwd", wt, "--format", "json"],
      {},
    ));
    assert.equal(JSON.parse(direct.join("\n")).recordPath,
      join(main, ".wao", "runs", "consults", `${stateId}.json`),
      "状态目录有记录时读它（工作树同名旧记录不存在，无回退歧义）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0111 CLI: 只有 ENOENT 触发回退——状态目录里这份记录是坏 JSON 时照旧报错", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0111b-"));
  try {
    const { main, wt } = makeRepoWithWorktree(root);
    const consultId = "consult_20261104000000000abc123";
    mkdirSync(join(main, ".wao", "runs", "consults"), { recursive: true });
    writeFileSync(join(main, ".wao", "runs", "consults", `${consultId}.json`), "{ not json", "utf8");
    mkdirSync(join(wt, ".wao", "runs", "consults"), { recursive: true });
    writeFileSync(join(wt, ".wao", "runs", "consults", `${consultId}.json`),
      JSON.stringify(legacyRecord(consultId)), "utf8");
    await assert.rejects(
      () => consultCommand(["show", consultId, "--cwd", wt], {}),
      /consult record unreadable after 5 attempts/,
      "坏 JSON 不被旧目录好记录顶掉——读取者要看到真实状态",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0111 CLI: 配置了非默认 stateDir 名字时，回退到按那个名字算出的旧目录", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0111n-"));
  try {
    const { main, wt } = makeRepoWithWorktree(root);
    const consultId = "consult_20261104000000000abc123";
    mkdirSync(join(wt, ".custom-wao", "runs", "consults"), { recursive: true });
    writeFileSync(join(wt, ".custom-wao", "runs", "consults", `${consultId}.json`),
      JSON.stringify(legacyRecord(consultId)), "utf8");
    const lines = await captureLog(() => consultCommand(
      ["show", consultId, "--cwd", wt, "--format", "json"],
      { stateDir: ".custom-wao" },
    ));
    const parsed = JSON.parse(lines.join("\n"));
    assert.equal(parsed.recordPath, join(wt, ".custom-wao", "runs", "consults", `${consultId}.json`),
      "按配置的名字算旧目录（主工作树 .custom-wao 没有 → 回退工作树 .custom-wao）");
    assert.ok(!existsSync(join(main, ".custom-wao")), "主工作树按配置名建目录不是本测试的副作用（show 只读）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0111 CLI: doctor 提示工作树里留下的本地状态（info，不判失败）；主检出/无遗留不提示", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0111d-"));
  try {
    const { main, wt } = makeRepoWithWorktree(root);
    writeRegistry(root);
    // 工作树 .wao/ 有 decisions/（正常）+ 遗留的 pipeline/handoff/runs。
    for (const slot of ["decisions", "pipeline", "handoff", "runs"]) {
      mkdirSync(join(wt, ".wao", slot), { recursive: true });
    }
    writeFileSync(join(wt, ".wao", "pipeline", "DECL-20261104-legacy.md"), "legacy", "utf8");
    const doctorJson = async (cwd) => {
      const lines = [];
      const orig = console.log;
      console.log = (...a) => lines.push(a.map(String).join(" "));
      const savedExit = process.exitCode;
      try {
        await waoDoctorCommand(["--format", "json", "--cwd", cwd], {
          ...CONFIG(root),
          userEnvReader: async () => undefined,
          scopedEnvReader: async () => ({ status: "absent" }),
        });
      } finally {
        console.log = orig;
        process.exitCode = savedExit;
      }
      const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
      assert.ok(jsonLine, "doctor json 输出在场");
      return JSON.parse(jsonLine);
    };
    const inWorktree = await doctorJson(wt);
    const hint = inWorktree.checks.find((c) => c.name === "wao_worktree_local_state");
    assert.ok(hint, "工作树有遗留本地状态 → 提示在场");
    assert.equal(hint.status, "info", "只提示（info），不判失败");
    assert.ok(hint.detail.includes("pipeline"), "点名遗留条目");
    assert.ok(hint.detail.includes(join(main, ".wao")), "说明合并目标（主工作树状态目录）");
    assert.ok(!hint.detail.includes("decisions"), "decisions/ 是正常落点，不算遗留");
    assert.ok(!inWorktree.checks.some((c) => c.name === "wao_worktree_local_state" && c.status === "fail"),
      "没有失败判级");

    // 主检出：不提示。
    const inMain = await doctorJson(main);
    assert.ok(!inMain.checks.some((c) => c.name === "wao_worktree_local_state"), "主检出不提示");

    // 工作树 .wao/ 只有 decisions/（正常形状）：不提示。
    rmSync(join(wt, ".wao", "pipeline"), { recursive: true, force: true });
    rmSync(join(wt, ".wao", "handoff"), { recursive: true, force: true });
    rmSync(join(wt, ".wao", "runs"), { recursive: true, force: true });
    const clean = await doctorJson(wt);
    assert.ok(!clean.checks.some((c) => c.name === "wao_worktree_local_state"), "无遗留不提示");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0111 CLI: runs dashboard 在链接工作树里读主工作树的 pipeline 进度", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-0111p-"));
  try {
    const { main, wt } = makeRepoWithWorktree(root);
    writeRegistry(root);
    mkdirSync(join(root, "runs"), { recursive: true });
    await captureLog(() => waoCommand(["init", "--cwd", wt], CONFIG(root)));
    await captureLog(() => waoCommand(["stage", "3", "--task", "派发实现", "--cwd", wt], CONFIG(root)));
    const lines = await captureLog(() => runsDashboardCommand(
      ["--run-dir", join(root, "runs"), "--cwd", wt, "--format", "json"],
      { runDir: join(root, "runs"), stateDir: ".wao" },
    ));
    const parsed = JSON.parse(lines.join("\n"));
    assert.deepEqual(parsed.summary.stageProgress.declared, [3],
      "dashboard 的 pipeline 进度来自主工作树 .wao/pipeline/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
