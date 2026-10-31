import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorktree, removeWorktree, listWorktrees,
  createReadOnlyClone, probeReadOnlyClone, removeReadOnlyClone,
} from "../../src/isolation.js";

/** 创建一个真实临时 git 仓库（含至少 1 个 commit，worktree 需要） */
async function makeTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), "wao-iso-repo-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore" });
  await writeFile(join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  return dir;
}

test("createWorktree 创建独立工作树", async () => {
  const repo = await makeTempRepo();
  try {
    const wt = await createWorktree(repo, "wt-test-1");
    assert.ok(existsSync(wt.path), "worktree path should exist");
    assert.ok(wt.branch, "should have branch name");
    // worktree 里有 README（继承自 HEAD）
    assert.ok(existsSync(join(wt.path, "README.md")));
    // git worktree list 应列出它（路径分隔符可能不同，normalize 比较）
    const norm = (p) => p.replace(/\\/g, "/");
    const list = await listWorktrees(repo);
    assert.ok(list.some((w) => norm(w.path) === norm(wt.path)));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("removeWorktree 删除工作树", async () => {
  const repo = await makeTempRepo();
  try {
    const wt = await createWorktree(repo, "wt-test-2");
    assert.ok(existsSync(wt.path));
    await removeWorktree(wt.path);
    assert.ok(!existsSync(wt.path), "worktree path should be gone");
    const norm = (p) => p.replace(/\\/g, "/");
    const list = await listWorktrees(repo);
    assert.ok(!list.some((w) => norm(w.path) === norm(wt.path)));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("createWorktree 不同 name 创建不同分支", async () => {
  const repo = await makeTempRepo();
  try {
    const wt1 = await createWorktree(repo, "wt-a");
    const wt2 = await createWorktree(repo, "wt-b");
    assert.notEqual(wt1.path, wt2.path);
    assert.notEqual(wt1.branch, wt2.branch);
    const list = await listWorktrees(repo);
    assert.equal(list.length, 3); // main + 2 worktrees
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("createWorktree 在非 git 仓库抛错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-notgit-"));
  try {
    // createWorktree is async (M11-1B: runs the exclude transaction under a
    // cross-process lock). A non-git repo rejects via promise rejection.
    await assert.rejects(
      () => createWorktree(dir, "wt-fail"),
      /not a git repository|fatal|git/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listWorktrees 解析 porcelain 输出", async () => {
  const repo = await makeTempRepo();
  try {
    await createWorktree(repo, "wt-list");
    const list = await listWorktrees(repo);
    // 每个条目有 path 字段
    for (const w of list) {
      assert.ok(typeof w.path === "string" && w.path.length > 0);
    }
    assert.ok(list.length >= 2); // main + worktree
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("TD-21: removeWorktree 幂等 + 容错（重试不抛，删不存在的路径安全）", async () => {
  // TD-21 加固：removeWorktree 现有重试循环（3 次 + 退避）。
  // 验证幂等性（删两次不抛）+ 容错性（删不存在的路径不抛）。
  // 真实 Permission-denied 竞态无法按需触发，故测幂等/容错作为重试路径的安全网。
  const repo = await makeTempRepo();
  try {
    const wt = await createWorktree(repo, "wt-retry");
    assert.ok(existsSync(wt.path));
    // 第一次删
    await removeWorktree(wt.path);
    assert.ok(!existsSync(wt.path), "首次删除应成功");
    // 第二次删（幂等：路径已不存在，不抛）
    await removeWorktree(wt.path);
    // 删完全不存在的路径（容错：不抛）
    await removeWorktree(join(tmpdir(), "wao-nonexistent-wt-" + Date.now()));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// M12-6 (P1-A): createWorktree accepts an optional commitish to pin the worktree
// HEAD to an exact commit. This is the structural defense against a frozen-base
// TOCTOU micro-race: even if the source HEAD moves between revalidation and
// `git worktree add`, the worktree lands on the pinned commit, not the raced
// HEAD.
test("M12-6 P1-A: createWorktree pins the worktree HEAD to an exact commitish", async () => {
  const repo = await makeTempRepo(); // HEAD = C1
  try {
    const c1 = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    // Advance the source to a second commit so current HEAD (C2) != the pinned base.
    await writeFile(join(repo, "second.md"), "# 2\n");
    execSync("git add second.md", { cwd: repo, stdio: "ignore" });
    execSync('git commit -m second', { cwd: repo, stdio: "ignore" });
    const c2 = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    assert.notEqual(c1, c2, "setup: two distinct commits");

    // Pin the worktree to C1 even though the source HEAD is now C2.
    const wt = await createWorktree(repo, "wt-pin-m126", { commitish: c1 });
    const wtHead = execSync("git rev-parse HEAD", { cwd: wt.path, encoding: "utf8" }).trim();
    assert.equal(wtHead, c1, "worktree HEAD is the pinned commit, not the moved source HEAD");
    assert.notEqual(wtHead, c2, "worktree did not silently follow the source HEAD race");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ===== 决定 0102：ephemeral 只读运行的私有克隆原语 ==========================

/** 在 dir（可含空格/中文）下初始化一个真实 git 仓，返回首个提交的完整 SHA。 */
async function initRepoAt(dir) {
  await mkdir(dir, { recursive: true });
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@test"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "test"', { cwd: dir, stdio: "ignore" });
  await writeFile(join(dir, "README.md"), "# test\n", "utf8");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -qm "init"', { cwd: dir, stdio: "ignore" });
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
}

const gitOut = (args, cwd) => execSync(`git ${args.join(" ")}`, { cwd, encoding: "utf8" }).trim();

test("0102: createReadOnlyClone——空格+中文源路径、冻结基点、克隆形状、源仓无登记", async () => {
  const base = await mkdtemp(join(tmpdir(), "wao-iso-clone-"));
  try {
    const repo = join(base, "源 仓 repo");
    const c1 = await initRepoAt(repo);
    // 源仓 HEAD 前进到 C2，克隆必须落在冻结基点 C1
    await writeFile(join(repo, "second.md"), "# 2\n", "utf8");
    execSync("git add second.md", { cwd: repo, stdio: "ignore" });
    execSync('git commit -qm "c2"', { cwd: repo, stdio: "ignore" });
    const c2 = gitOut(["rev-parse", "HEAD"], repo);
    assert.notEqual(c1, c2, "setup: two distinct commits");

    const clone = await createReadOnlyClone(repo, "run_iso_pc1", { commitish: c1 });
    assert.deepEqual(
      { form: clone.form, branch: clone.branch, baseCommit: clone.baseCommit },
      { form: "private_clone", branch: "wao/run_iso_pc1", baseCommit: c1 },
    );
    assert.ok(existsSync(clone.path), "克隆目录在源仓 .wao-worktrees 下");
    assert.ok(existsSync(join(clone.path, "README.md")), "基点 C1 内容已检出");
    assert.ok(!existsSync(join(clone.path, "second.md")), "C2 之后的内容不在（冻结基点）");
    // 克隆形状：自己的 .git 目录（非登记树的 .git 文件）+ wao 分支 + 不可用 pushurl
    assert.ok(statSync(join(clone.path, ".git")).isDirectory(), ".git 是目录（私有克隆，非链接树）");
    assert.equal(gitOut(["rev-parse", "--abbrev-ref", "HEAD"], clone.path), "wao/run_iso_pc1");
    assert.ok(gitOut(["config", "remote.origin.pushurl"], clone.path).includes("wao.invalid"));
    // 源仓没有克隆的登记，也没有克隆的分支
    assert.ok(!gitOut(["worktree", "list", "--porcelain"], repo).includes("run_iso_pc1"),
      "源仓 worktree list 不含克隆");
    let srcBranchMissing = false;
    try { execSync("git rev-parse --verify refs/heads/wao/run_iso_pc1", { cwd: repo, stdio: "pipe" }); }
    catch { srcBranchMissing = true; }
    assert.ok(srcBranchMissing, "源仓没有 wao/<runId> 分支（分支活在克隆里）");
    assert.deepEqual(probeReadOnlyClone(clone.path, { branch: clone.branch, baseCommit: c1, sourceCwd: repo }), { outcome: "clean" },
      "源仓分支上基点之后的 C2（克隆的本地 main 可达）在远程跟踪分支上，不算席位提交");
    await removeReadOnlyClone(clone.path);
    assert.ok(!existsSync(clone.path), "克隆可删（removeReadOnlyClone）");

    // 源仓本身是一棵链接工作树时也能建（对象库经 common dir 共享）
    const linkedSrc = join(base, "linked-src");
    execSync(`git worktree add "${linkedSrc}" -b dev`, { cwd: repo, stdio: "ignore" });
    const clone2 = await createReadOnlyClone(linkedSrc, "run_iso_pc2");
    assert.equal(clone2.baseCommit, c2, "无冻结基点取链接源仓 HEAD");
    const alternates = readFileSync(join(clone2.path, ".git", "objects", "info", "alternates"), "utf8");
    const commonObjectsReal = realpathSync(resolve(linkedSrc,
      gitOut(["rev-parse", "--git-common-dir"], linkedSrc), "objects"));
    const hit = alternates.split(/\r?\n/).some((l) => l.trim().length > 0
      && realpathSync(resolve(clone2.path, l.trim())) === commonObjectsReal);
    assert.ok(hit, "alternates 指向链接源仓的 common dir 对象库");
    await removeReadOnlyClone(clone2.path);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("0102: 基点不在任何 ref 上仍能建；基点不存在抛错且不留目录", async () => {
  const repo = await makeTempRepo(); // HEAD = C1
  try {
    const c1 = gitOut(["rev-parse", "HEAD"], repo);
    await writeFile(join(repo, "second.md"), "# 2\n", "utf8");
    execSync("git add second.md", { cwd: repo, stdio: "ignore" });
    execSync('git commit -qm "c2"', { cwd: repo, stdio: "ignore" });
    const c2 = gitOut(["rev-parse", "HEAD"], repo);
    execSync(`git reset --hard ${c1}`, { cwd: repo, stdio: "ignore" }); // C2 只剩 reflog
    await writeFile(join(repo, "third.md"), "# 3\n", "utf8");
    execSync("git add third.md", { cwd: repo, stdio: "ignore" });
    execSync('git commit -qm "c3"', { cwd: repo, stdio: "ignore" });
    // C2 不在任何 ref 上但对象仍在仓里（reflog 可达不算 ref）
    const orphan = c2;
    assert.notEqual(orphan, c1);
    const clone = await createReadOnlyClone(repo, "run_iso_orphan", { commitish: orphan });
    assert.equal(gitOut(["rev-parse", "HEAD"], clone.path), orphan, "无 ref 基点仍能检出");
    await removeReadOnlyClone(clone.path);

    // 基点不存在 → 抛错且不留半建目录
    const bad = "1".repeat(40);
    await assert.rejects(() => createReadOnlyClone(repo, "run_iso_badbase", { commitish: bad }));
    assert.ok(!existsSync(join(repo, ".wao-worktrees", "run_iso_badbase")), "失败不留目录");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("0102: 克隆内写仓库的 git 命令不落源仓（TD-310 复演）+ push origin 失败", async () => {
  const repo = await makeTempRepo();
  try {
    const clone = await createReadOnlyClone(repo, "run_iso_td310");
    // 席位形态复演：在克隆里的一个"非仓库子目录"跑 git（查找向上命中克隆）
    const sub = join(clone.path, "not-a-repo-sub");
    await mkdir(sub, { recursive: true });
    const beforeConfig = readFileSync(join(repo, ".git", "config"), "utf8");
    const beforeRefs = gitOut(["for-each-ref"], repo);
    const beforeWts = gitOut(["worktree", "list", "--porcelain"], repo);
    execSync("git config user.name x", { cwd: sub, stdio: "ignore" });
    execSync("git branch y", { cwd: sub, stdio: "ignore" });
    execSync(`git worktree add "${join(clone.path, "nested-wt")}" -b nw`, { cwd: sub, stdio: "ignore" });
    // 源仓的 config 文本、refs、登记完全不变；写入落在克隆自己的 .git 里
    assert.equal(readFileSync(join(repo, ".git", "config"), "utf8"), beforeConfig, "源仓 config 不变");
    assert.equal(gitOut(["for-each-ref"], repo), beforeRefs, "源仓 refs 不变");
    assert.equal(gitOut(["worktree", "list", "--porcelain"], repo), beforeWts, "源仓 worktree list 不变");
    assert.equal(gitOut(["config", "user.name"], clone.path), "x", "config 写进克隆");
    assert.ok(gitOut(["for-each-ref"], clone.path).includes("refs/heads/y"), "分支建在克隆里");
    assert.ok(gitOut(["worktree", "list", "--porcelain"], clone.path).includes("nested-wt"),
      "嵌套树登记在克隆里");
    // 误用 origin 的推送被 pushurl 挡下，源仓 refs 不变
    let pushFailed = false;
    try { execSync("git push origin HEAD:refs/heads/z", { cwd: clone.path, stdio: "pipe" }); }
    catch { pushFailed = true; }
    assert.ok(pushFailed, "git push origin 被不可用 pushurl 拒绝");
    assert.ok(!gitOut(["for-each-ref"], repo).includes("refs/heads/z"), "源仓没有 z 分支");
    await removeReadOnlyClone(clone.path);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("0102: probeReadOnlyClone 闭集——clean/unique/tag/detached/head_drift/nested/probe_failed", async () => {
  const repo = await makeTempRepo();
  try {
    const c1 = gitOut(["rev-parse", "HEAD"], repo);
    // 干净克隆 → clean
    const clean = await createReadOnlyClone(repo, "run_pb_clean");
    assert.deepEqual(probeReadOnlyClone(clean.path, { branch: clean.branch, baseCommit: c1, sourceCwd: repo }), { outcome: "clean" });

    // wao 分支上新提交 → keep 带数
    const uniq = await createReadOnlyClone(repo, "run_pb_uniq");
    await writeFile(join(uniq.path, "u.txt"), "u\n", "utf8");
    execSync("git add .", { cwd: uniq.path, stdio: "ignore" });
    execSync('git commit -qm "worker"', { cwd: uniq.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(uniq.path, { branch: uniq.branch, baseCommit: c1, sourceCwd: repo }),
      { outcome: "keep", uniqueCommits: 1 });

    // 另一分支上新提交 → keep 带数（计数门先于 head_drift——HEAD 已换分支）
    const other = await createReadOnlyClone(repo, "run_pb_other");
    execSync("git checkout -q -b other", { cwd: other.path, stdio: "ignore" });
    await writeFile(join(other.path, "o.txt"), "o\n", "utf8");
    execSync("git add .", { cwd: other.path, stdio: "ignore" });
    execSync('git commit -qm "other"', { cwd: other.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(other.path, { branch: other.branch, baseCommit: c1, sourceCwd: repo }),
      { outcome: "keep", uniqueCommits: 1 });
    // 切回 wao 分支后，新提交只剩旁支可达 → 照算
    execSync(`git checkout -q ${other.branch}`, { cwd: other.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(other.path, { branch: other.branch, baseCommit: c1, sourceCwd: repo }),
      { outcome: "keep", uniqueCommits: 1 }, "HEAD 回到基点，旁支上的新提交仍算");

    // 新提交上打 tag → keep 带数
    const tagged = await createReadOnlyClone(repo, "run_pb_tag");
    await writeFile(join(tagged.path, "t.txt"), "t\n", "utf8");
    execSync("git add .", { cwd: tagged.path, stdio: "ignore" });
    execSync('git commit -qm "tagged"', { cwd: tagged.path, stdio: "ignore" });
    execSync("git tag v9", { cwd: tagged.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(tagged.path, { branch: tagged.branch, baseCommit: c1, sourceCwd: repo }),
      { outcome: "keep", uniqueCommits: 1 });

    // detached 到新提交 → keep 带数
    const detached = await createReadOnlyClone(repo, "run_pb_det");
    await writeFile(join(detached.path, "d.txt"), "d\n", "utf8");
    execSync("git add .", { cwd: detached.path, stdio: "ignore" });
    execSync('git commit -qm "det"', { cwd: detached.path, stdio: "ignore" });
    execSync("git checkout -q --detach", { cwd: detached.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(detached.path, { branch: detached.branch, baseCommit: c1, sourceCwd: repo }),
      { outcome: "keep", uniqueCommits: 1 });

    // HEAD 换到别的分支（零新提交）→ head_drift；detached 在基点同型
    const drift = await createReadOnlyClone(repo, "run_pb_drift");
    execSync("git checkout -q -b stray", { cwd: drift.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(drift.path, { branch: drift.branch, baseCommit: c1, sourceCwd: repo }),
      { outcome: "keep", reason: "head_drift" });
    execSync("git checkout -q --detach", { cwd: drift.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(drift.path, { branch: drift.branch, baseCommit: c1, sourceCwd: repo }),
      { outcome: "keep", reason: "head_drift" }, "detached 在基点也按 head_drift 保留");

    // 克隆里登记了别的工作树 → nested_worktree
    const nested = await createReadOnlyClone(repo, "run_pb_nested");
    execSync(`git worktree add "${join(nested.path, "nested-wt")}" -b nwb`, { cwd: nested.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(nested.path, { branch: nested.branch, baseCommit: c1, sourceCwd: repo }),
      { outcome: "keep", reason: "nested_worktree" });

    // 不是私有克隆（链接工作树的 .git 是文件）→ probe_failed，不当克隆删
    const linked = join(repo, ".wao-worktrees", "run_pb_linked");
    execSync(`git worktree add "${linked}" -b wao/run_pb_linked`, { cwd: repo, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(linked, { branch: "wao/run_pb_linked", baseCommit: c1, sourceCwd: repo }),
      { outcome: "keep", reason: "probe_failed" });

    // 基点写错 / 绑定残缺 → probe_failed（fail-closed）
    const pf = await createReadOnlyClone(repo, "run_pb_fail");
    assert.deepEqual(probeReadOnlyClone(pf.path, { branch: pf.branch, baseCommit: "ab".repeat(20), sourceCwd: repo }),
      { outcome: "keep", reason: "probe_failed" });
    assert.deepEqual(probeReadOnlyClone(pf.path, {}), { outcome: "keep", reason: "probe_failed" },
      "缺 branch/baseCommit 按保留处理");
    assert.deepEqual(probeReadOnlyClone(pf.path, { branch: pf.branch, baseCommit: c1 }),
      { outcome: "keep", reason: "probe_failed" }, "缺 sourceCwd 按保留处理");
    assert.deepEqual(probeReadOnlyClone(pf.path, { branch: pf.branch, baseCommit: c1, sourceCwd: repo },
      { execFn: () => { throw new Error("git down"); } }),
      { outcome: "keep", reason: "probe_failed" }, "git 失败按保留处理（注入缝）");
    await removeReadOnlyClone(pf.path);
    // 删不存在的路径不抛（幂等）
    removeReadOnlyClone(join(repo, ".wao-worktrees", "run_pb_nothere"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("0102: 克隆带来的源仓标签不算席位提交（分支外标签、附注标签、嵌套名）；席位自建标签上的提交照算", async () => {
  const repo = await makeTempRepo();
  try {
    const c1 = gitOut(["rev-parse", "HEAD"], repo);
    // 源仓：一个没有任何分支可达的提交，挂轻量标签与嵌套名附注标签
    execSync("git checkout -q -b side", { cwd: repo, stdio: "ignore" });
    await writeFile(join(repo, "side.md"), "# side\n", "utf8");
    execSync("git add side.md", { cwd: repo, stdio: "ignore" });
    execSync('git commit -qm "side"', { cwd: repo, stdio: "ignore" });
    execSync("git tag offbranch", { cwd: repo, stdio: "ignore" });
    execSync('git tag -a release/2.0 -m "nested annotated"', { cwd: repo, stdio: "ignore" });
    execSync("git checkout -q -", { cwd: repo, stdio: "ignore" });
    execSync("git branch -q -D side", { cwd: repo, stdio: "ignore" });
    assert.equal(gitOut(["rev-list", "--count", "--tags", "--not", "--branches"], repo), "1",
      "setup: 源仓有一个只有标签可达的提交");

    const clone = await createReadOnlyClone(repo, "run_pb_srctags", { commitish: c1 });
    assert.deepEqual(probeReadOnlyClone(clone.path, { branch: clone.branch, baseCommit: c1, sourceCwd: repo }), { outcome: "clean" },
      "克隆带来的分支外标签不算席位提交（对象在源仓）");

    // 席位提交后打标签再把分支退回基点：提交只剩席位自建的标签可达 → 照算
    await writeFile(join(clone.path, "seat.md"), "# seat\n", "utf8");
    execSync("git add seat.md", { cwd: clone.path, stdio: "ignore" });
    execSync('git commit -qm "seat"', { cwd: clone.path, stdio: "ignore" });
    execSync("git tag seat-tag", { cwd: clone.path, stdio: "ignore" });
    execSync(`git reset -q --hard ${c1}`, { cwd: clone.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(clone.path, { branch: clone.branch, baseCommit: c1, sourceCwd: repo }),
      { outcome: "keep", uniqueCommits: 1 });
    await removeReadOnlyClone(clone.path);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("0102: 只认对象在不在源仓——挂在远程跟踪引用下的新提交照算；源仓运行中删掉的分支与 stash 不算", async () => {
  const repo = await makeTempRepo();
  try {
    const c1 = gitOut(["rev-parse", "HEAD"], repo);
    // 源仓有一条在基点之后的分支
    execSync("git checkout -q -b feature", { cwd: repo, stdio: "ignore" });
    await writeFile(join(repo, "f.md"), "# f\n", "utf8");
    execSync("git add f.md", { cwd: repo, stdio: "ignore" });
    execSync('git commit -qm "feature"', { cwd: repo, stdio: "ignore" });
    execSync("git checkout -q -", { cwd: repo, stdio: "ignore" });
    const clone = await createReadOnlyClone(repo, "run_pb_objects", { commitish: c1 });
    const bound = { branch: clone.branch, baseCommit: c1, sourceCwd: repo };

    // 源仓在运行期间删掉这条分支：对象仍在源仓 → 不算
    execSync("git branch -q -D feature", { cwd: repo, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(clone.path, bound), { outcome: "clean" }, "源仓删掉的分支不误算");

    // 源仓答复不是 `<oid> missing` / `<oid> commit <size>` 两种形状 → probe_failed
    const garbled = (cmd, args, opts) => (args[0] === "cat-file"
      ? `${String(opts.input).split("\n")[0]} garbage\n`
      : execFileSync(cmd, args, opts));
    assert.deepEqual(probeReadOnlyClone(clone.path, bound, { execFn: garbled }),
      { outcome: "keep", reason: "probe_failed" }, "读不懂的答复按保留处理");

    // stash 与未提交改动同等对待 → 不算
    await writeFile(join(clone.path, "README.md"), "# changed\n", "utf8");
    execSync("git stash -q", { cwd: clone.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(clone.path, bound), { outcome: "clean" }, "stash 不算新提交");

    // 新提交只挂在远程跟踪引用下（克隆里的引用席位能改）→ 照算
    await writeFile(join(clone.path, "seat.md"), "# seat\n", "utf8");
    execSync("git add seat.md", { cwd: clone.path, stdio: "ignore" });
    execSync('git commit -qm "seat"', { cwd: clone.path, stdio: "ignore" });
    execSync("git update-ref refs/remotes/local/seat HEAD", { cwd: clone.path, stdio: "ignore" });
    execSync(`git reset -q --hard ${c1}`, { cwd: clone.path, stdio: "ignore" });
    assert.deepEqual(probeReadOnlyClone(clone.path, bound), { outcome: "keep", uniqueCommits: 1 },
      "藏在 refs/remotes 下的新提交仍算");
    await removeReadOnlyClone(clone.path);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("0102: 克隆已建出而检出失败 → 抛错且删掉半建目录", async () => {
  const repo = await makeTempRepo();
  try {
    // 树里放一个 Git for Windows 拒绝检出的路径（core.protectNTFS）：clone 成功、checkout 失败。
    const blob = execSync("git hash-object -w --stdin", { cwd: repo, input: "x\n", encoding: "utf8" }).trim();
    const tree = execSync("git mktree", { cwd: repo, input: `100644 blob ${blob}\tcon\n`, encoding: "utf8" }).trim();
    const bad = execSync(`git commit-tree ${tree} -p HEAD -m bad`, { cwd: repo, encoding: "utf8" }).trim();
    await assert.rejects(() => createReadOnlyClone(repo, "run_iso_cofail", { commitish: bad }));
    assert.ok(!existsSync(join(repo, ".wao-worktrees", "run_iso_cofail")), "半建目录已删");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("0102: 目标目录已存在且非空 → clone 被拒、失败清理不删别人的目录", async () => {
  const repo = await makeTempRepo();
  try {
    const target = join(repo, ".wao-worktrees", "run_iso_exists");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "not ours\n", "utf8");
    await assert.rejects(() => createReadOnlyClone(repo, "run_iso_exists"), /already exists/);
    assert.ok(existsSync(join(target, "keep.txt")), "已有目录原样保留");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
