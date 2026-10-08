// test/delivery/td235ResolveBranch.test.js
//
// TD-235（2026-10-08，会审 consult_20261008164029600fyqngp astra/opus）+
// TD-236 升级（grafts 防线）：resolveDeliveryCommit 内核的真实 Git 打标钉。
//
// 打标契约：resolveDeliveryCommit 抛出的每个错误带不可枚举 resolveBranch
// 标记——依据【入口那一刻 HEAD 是否等于 base】：
//   - "package"：入口 HEAD==base 的打包失败（回退后仍在 base）；
//   - "recover"：两个 recover 入口（入口即漂移 / 打包竞态败给并发胜者后的
//     回退恢复）的失败——后者不得因外层进过 package 而误标 "package"。
//   - 标记不可枚举：不改 identity/name，不被 JSON 序列化带出。
//
// TD-236 grafts 防线：GIT_NO_REPLACE_OBJECTS 管不到 .git/info/grafts（等价
// graft 伪造父链；git 2.50 实测：grafts 生效且不受该 env 影响）。common git
// dir 下 grafts 文件在场 → fail-closed typed 拒绝（grafts_present）。
//
// 守卫层（runDeliveryRepackage 的 artifact_mismatch→worktree_unusable 桥）对
// 标记的消费钉见 runDeliveryRepackage.test.js 的 TD-235 节。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { resolveDeliveryCommit, DeliveryError } from "../../src/delivery.js";

const RUN_ID = "run_td235_tag";
const realExecFileSync = childProcess.execFileSync;

function git(args, cwd, env) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    ...(env ? { env } : {}),
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  }).trim();
}

// WAO 交付身份 env（recover 的身份全验只认这一套）。
function waoIdentityEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "WAO Delivery",
    GIT_AUTHOR_EMAIL: "wao-delivery@local",
    GIT_COMMITTER_NAME: "WAO Delivery",
    GIT_COMMITTER_EMAIL: "wao-delivery@local",
  };
}

async function cleanupDir(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 5) return;
      await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}

/** repo（src/a.js 一个初始提交）+ 挂在 wao/<RUN_ID> 的持久 linked worktree。 */
async function makeScenario() {
  const repo = await mkdtemp(join(tmpdir(), "td235-repo-"));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "test@test"], repo);
  git(["config", "user.name", "test"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "a.js"), "const a = 1;\n");
  git(["add", "."], repo);
  git(["commit", "-m", "init"], repo);
  const baseCommit = git(["rev-parse", "HEAD"], repo);
  const worktreePath = join(repo, ".wao-worktrees", RUN_ID);
  git(["worktree", "add", worktreePath, "-b", `wao/${RUN_ID}`], repo);
  const ctx = {
    runId: RUN_ID,
    worktreePath,
    baseCommit,
    isolation: { type: "worktree", strategy: "persistent" },
    allowedPaths: ["src"],
    verificationCommands: ["npm test"],
  };
  return { repo, worktreePath, baseCommit, ctx };
}

/** 标记断言：值正确 + 不可枚举 + 不进 JSON + identity 不变。 */
function assertBranchTag(err, branch) {
  assert.equal(err.resolveBranch, branch, `resolveBranch === ${JSON.stringify(branch)}`);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(err, "resolveBranch"), false,
    "resolveBranch 必须是不可枚举属性",
  );
  assert.equal(Object.keys(err).includes("resolveBranch"), false, "Object.keys 不含 resolveBranch");
  assert.equal(JSON.stringify(err).includes("resolveBranch"), false, "JSON 序列化不带出 resolveBranch");
  assert.ok(err instanceof DeliveryError, "identity 保持 DeliveryError");
  assert.equal(err.name, "DeliveryError");
}

test("TD-235 打标：入口 HEAD==base 的打包失败标 package（非枚举、identity 不变）", async () => {
  const s = await makeScenario();
  try {
    // 干净 worktree 停在 base → packageDelivery 在 inspect 阶段 empty_diff 失败，
    // 回退后 HEAD 仍在 base → package 分支。
    assert.throws(
      () => resolveDeliveryCommit(s.ctx),
      (err) => {
        assert.equal(err.deliveryCode, "empty_diff");
        assertBranchTag(err, "package");
        return true;
      },
    );
  } finally { await cleanupDir(s.repo); }
});

test("TD-235 打标：入口即漂移的 recover 失败标 recover（外来消息不被收编）", async () => {
  const s = await makeScenario();
  try {
    // 入口前 HEAD 已离开 base（外来提交，改动在允许面内但消息不对）→ 直接进
    // recover 入口，全验在消息层失败。
    await writeFile(join(s.worktreePath, "src", "a.js"), "const a = 2;\n");
    git(["add", "src/a.js"], s.worktreePath);
    git(["commit", "-m", "foreign commit"], s.worktreePath);
    assert.throws(
      () => resolveDeliveryCommit(s.ctx),
      (err) => {
        assert.equal(err.deliveryCode, "artifact_mismatch");
        assert.match(err.message, /message mismatch/);
        assertBranchTag(err, "recover");
        return true;
      },
    );
  } finally { await cleanupDir(s.repo); }
});

test("TD-235 打标：打包竞态败给并发胜者后的回退恢复失败标 recover（不误标 package）", async (t) => {
  const s = await makeScenario();
  let intercepted = 0;
  let tagged = null;
  try {
    // 确定性模拟并发竞态（不打真竞态）：拦截 packageDelivery 的 CAS
    // update-ref（refs/heads/wao/<runId> 的四参形态），在它执行前用真 git 把
    // 分支移到一个外来胜者提交（commit-tree plumbing，不碰工作区）→ 本方 CAS
    // 必败 → package 分支抛错 → resolve 的 catch 见 HEAD≠base → 回退到
    // recoverDeliveryCommit 全验外来提交 → 失败。该失败必须标 "recover"，
    // 不得因外层进过 package 分支而误标 "package"（astra 警告同向）。
    const mocked = t.mock.method(childProcess, "execFileSync", (bin, args, opts) => {
      if (
        bin === "git" && args[0] === "update-ref" && args[1] === `refs/heads/wao/${RUN_ID}`
        && args.length === 4 && intercepted === 0
      ) {
        intercepted += 1;
        const tree = realExecFileSync(
          "git", ["rev-parse", `${s.baseCommit}^{tree}`],
          { cwd: s.worktreePath, encoding: "utf8" },
        ).trim();
        const winner = realExecFileSync(
          "git", ["commit-tree", tree, "-p", s.baseCommit],
          {
            cwd: s.worktreePath, encoding: "utf8",
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: "attacker", GIT_AUTHOR_EMAIL: "attacker@evil",
              GIT_COMMITTER_NAME: "attacker", GIT_COMMITTER_EMAIL: "attacker@evil",
            },
            input: "concurrent foreign winner\n",
          },
        ).trim();
        realExecFileSync(
          "git", ["update-ref", `refs/heads/wao/${RUN_ID}`, winner, s.baseCommit],
          { cwd: s.worktreePath, encoding: "utf8" },
        );
      }
      return realExecFileSync(bin, args, opts);
    });
    syncBuiltinESMExports();
    try {
      // worktree 带一个允许面改动（package 路径需要可打包内容）。
      await writeFile(join(s.worktreePath, "src", "a.js"), "const a = 3;\n");
      assert.throws(
        () => resolveDeliveryCommit(s.ctx),
        (err) => { tagged = err; return err instanceof DeliveryError; },
      );
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.ok(intercepted >= 1, "CAS 拦截点必须命中（否则本测试静默失明）");
    assert.equal(tagged.deliveryCode, "artifact_mismatch");
    assertBranchTag(tagged, "recover");
  } finally { await cleanupDir(s.repo); }
});

test("TD-236 grafts：伪造单父的 graft 文件在场 → fail-closed 拒绝（grafts_present）", async () => {
  const s = await makeScenario();
  try {
    // 造出双父合并 X 与单父替身 single（同 TD-236 --graft 钉的形态）。
    await writeFile(join(s.worktreePath, "src", "a.js"), "const a = 4;\n");
    git(["add", "src/a.js"], s.worktreePath);
    git(["commit", "-m", `wao-delivery: ${RUN_ID}`], s.worktreePath, waoIdentityEnv());
    const single = git(["rev-parse", "HEAD"], s.worktreePath);
    git(["checkout", "-q", "-b", "side", s.baseCommit], s.worktreePath);
    await writeFile(join(s.worktreePath, "src", "side.txt"), "side\n");
    git(["add", "src/side.txt"], s.worktreePath);
    git(["commit", "-m", "side"], s.worktreePath);
    const side = git(["rev-parse", "HEAD"], s.worktreePath);
    git(["checkout", "-q", `wao/${RUN_ID}`], s.worktreePath);
    git(["merge", "--no-ff", "-m", "merge smuggle", side], s.worktreePath);
    const X = git(["rev-parse", "HEAD"], s.worktreePath);
    const realParents = git(["rev-list", "--parents", "-n", "1", X], s.worktreePath).split(/\s+/);
    assert.equal(realParents.length, 3, "夹具自检：X 是双父合并提交");

    // 前置对照：grafts 不在场时，漂移 HEAD 走 recover 失败（非 grafts_present）。
    git(["checkout", "-q", X], s.worktreePath);
    assert.throws(
      () => resolveDeliveryCommit(s.ctx),
      (err) => err.deliveryCode !== "grafts_present" && err.resolveBranch === "recover",
      "grafts 不在场时不得以 grafts_present 拒绝",
    );

    // 攻击前提实测：grafts 把 X 的父链伪造成 [single]，且 GIT_NO_REPLACE_OBJECTS=1
    // 管不到它（这正是需要独立防线的原因）。
    writeFileSync(join(s.repo, ".git", "info", "grafts"), `${X} ${single}\n`, "utf8");
    const noReplaceEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
    const grafted = git(["rev-list", "--parents", "-n", "1", X], s.worktreePath, noReplaceEnv).split(/\s+/);
    assert.deepEqual(grafted, [X, single],
      "攻击前提：GIT_NO_REPLACE_OBJECTS=1 下 grafts 仍把双父伪造成单父");

    // fail-closed：grafts 文件在场即拒绝交付判定（typed 闭集码）。
    assert.throws(
      () => resolveDeliveryCommit(s.ctx),
      (err) => err instanceof DeliveryError
        && err.deliveryCode === "grafts_present"
        && err.message === "grafts 文件在场不支持交付判定",
    );
  } finally { await cleanupDir(s.repo); }
});

test("TD-236 grafts：文件缺席时正常路径不受影响（正例）", async () => {
  const s = await makeScenario();
  try {
    await writeFile(join(s.worktreePath, "src", "a.js"), "const a = 5;\n");
    const resolved = resolveDeliveryCommit(s.ctx);
    assert.equal(resolved.source, "packaged");
    assert.equal(
      git(["rev-parse", "HEAD"], s.worktreePath),
      resolved.ref.deliveryCommit,
    );
  } finally { await cleanupDir(s.repo); }
});
