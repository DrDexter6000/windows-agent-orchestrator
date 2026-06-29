import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createWorktree, removeWorktree, listWorktrees } from "../src/isolation.js";

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
    assert.throws(
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
