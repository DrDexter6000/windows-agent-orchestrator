// test/isolation-infra/projectIdentityLinkedWorktree.test.js
//
// 决定 0099（R8）：同一仓库的链接工作树算同一个项目——运行进主工作树的项目桶。
// 单测分两层：
//   - 内存 io（确定性）：gitdir/commondir 的形状矩阵——绝对/相对、分隔符、
//     大小写、CRLF、junction、坏形状、读失败 → 与不加 R8 逐字段相同；
//   - 临时目录盘上夹具：写侧/读侧/迁移计划器/执行器对同一链接工作树 cwd 的
//     key 一致（决定第 4 条），runs list --project 的选择器语义（已知边界）。
// 真实 `git worktree` 夹具见 projectIdentityLinkedWorktreeGit.test.js。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identifyProjectFromCwd,
  identityOfFirstEvent,
  projectFactFromCwd,
  deriveProjectBucketSlug,
  productionProjectIo,
  readGitFileBounded,
  GIT_META_FILE_MAX_BYTES,
  PROJECT_IDENTITY_RULES_VERSION,
} from "../../src/projectIdentity.js";
import { resolveRunDirForWrite, resolveTranscriptPath } from "../../src/projectBuckets.js";
import { planProjectsMigration, applyProjectsMigration } from "../../src/application/runsMigrateProjects.js";
import { listRuns } from "../../src/application/runList.js";

// ── 内存夹具：Map<path, content> 当"盘上文件"；抛错=读失败 ──────────────────────

const norm = (p) => String(p).replace(/\\/g, "/");

/** 内存 io：files 键用 / 分隔的固定大小写路径；junctions 是 realpath 改写表。 */
function memIo(files, { junctions = {} } = {}) {
  return {
    platform: "win32",
    realpath: (p) => junctions[norm(p)] ?? p,
    tmpdir: "C:/PROBE-TMP",
    readGitFile: (p) => {
      const c = files[norm(p)];
      if (c === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return c;
    },
  };
}

/** 标准形状：主仓 MAIN（.git 目录在内存里不存在=读失败照旧），链接工作树 WT。 */
const MAIN = "D:/projects/proj";
const WT = "D:/wt/proj-wt";
const ADMIN = "D:/projects/proj/.git/worktrees/wt1";

function stdFiles({ dotGit = `gitdir: ${ADMIN}\n`, commondir = "../..\n" } = {}) {
  return {
    [`${WT}/.git`]: dotGit,
    [`${ADMIN}/commondir`]: commondir,
  };
}

const MAIN_KEY = "d:/projects/proj";
const WT_KEY = "d:/wt/proj-wt";

// ── 1. 绝对 gitdir 的三种写法 ─────────────────────────────────────────────────

test("0099 R8: 绝对 gitdir 三种写法（正斜杠/反斜杠/小写盘符）→ 主项目 key 与 displayName", () => {
  for (const [label, dotGit] of [
    ["forward", `gitdir: ${ADMIN}\n`],
    ["backslash", `gitdir: ${ADMIN.replace(/\//g, "\\")}\n`],
    ["lower-drive", `gitdir: ${ADMIN.replace(/^D:/, "d:")}\n`],
  ]) {
    // 小写盘符变体：commondir 文件按 realpath 后（小写）gitdir 查
    const files = stdFiles({ dotGit });
    if (label === "lower-drive") files[`${ADMIN.replace(/^D:/, "d:")}/commondir`] = "../..\n";
    const io = memIo(files);
    const id = identifyProjectFromCwd(WT, io);
    assert.equal(id.kind, "project", label);
    assert.equal(id.key, MAIN_KEY, label);
    assert.equal(id.displayName, "proj", label);
    // 与主工作树自身 cwd 同 key 同 bucket 同 displayName
    const mainId = identifyProjectFromCwd(MAIN, io);
    assert.equal(id.key, mainId.key, label);
    assert.equal(deriveProjectBucketSlug(id), deriveProjectBucketSlug(mainId), label);
    const factWt = projectFactFromCwd(WT, io);
    const factMain = projectFactFromCwd(MAIN, io);
    assert.deepEqual(factWt, factMain, label);
    assert.equal(factWt.rulesVersion, "td190-r3", label);
  }
});

// ── 2. 相对 gitdir；相对与绝对 commondir ──────────────────────────────────────

test("0099 R8: 相对 gitdir（以工作树根为基准）+ 相对/绝对 commondir（以 gitdir realpath 为基准）", () => {
  // gitdir 相对工作树根；commondir 相对 ../..（git 默认写法）
  const rel = identifyProjectFromCwd("D:/wt2/proj-wt", memIo({
    "D:/wt2/proj-wt/.git": "gitdir: ../proj/.git/worktrees/wt1\n",
    "D:/wt2/proj/.git/worktrees/wt1/commondir": "../..\n",
  }));
  assert.equal(rel.kind, "project");
  assert.equal(rel.key, "d:/wt2/proj");
  // commondir 绝对写法
  const absCommon = identifyProjectFromCwd("D:/wt2/proj-wt2", memIo({
    "D:/wt2/proj-wt2/.git": "gitdir: ../proj/.git/worktrees/wt2\n",
    "D:/wt2/proj/.git/worktrees/wt2/commondir": "D:/wt2/proj/.git\n",
  }));
  assert.equal(absCommon.key, "d:/wt2/proj");
});

// ── 3. junction 改写 gitdir；相对 commondir 从真实 gitdir 算起 ─────────────────

test("0099 R8: gitdir 经 junction（注入 realpath 改写）后，相对 commondir 以真实 gitdir 为基准", () => {
  const io = memIo({
    "D:/links/wt/.git": "gitdir: D:/links/admin-alias\n",
    // commondir 只在**真实** gitdir 路径下可见（junction 别名目录下没有）
    [`${ADMIN}/commondir`]: "../..\n",
  }, { junctions: { "D:/links/admin-alias": ADMIN.replace(/\//g, "\\") } });
  const id = identifyProjectFromCwd("D:/links/wt", io);
  assert.equal(id.kind, "project");
  assert.equal(id.key, MAIN_KEY, "commondir 解析基准=gitdir 的 realpath（若按别名算会得 d:/ 而非主项目）");
});

// ── 4. CRLF/LF；坏形状与读失败 → 与不加 R8 逐字段相同 ──────────────────────────

test("0099 R8: .git 内容 CRLF 与 LF 都识别；坏形状/读失败 → 与不加 R8 的结果逐字段相同", () => {
  // CRLF/LF（正向）
  for (const [label, dotGit] of [["crlf", `gitdir: ${ADMIN}\r\n`], ["lf", `gitdir: ${ADMIN}\n`], ["no-eol", `gitdir: ${ADMIN}`]]) {
    const id = identifyProjectFromCwd(WT, memIo(stdFiles({ dotGit })));
    assert.equal(id.key, MAIN_KEY, label);
  }
  // 坏形状 → 照旧（期望值=同一输入、不注入 readGitFile 的结果）
  const noR8 = (files) => identifyProjectFromCwd(WT, { ...memIo(files), readGitFile: undefined });
  for (const [label, files] of [
    ["no-prefix", { ...stdFiles(), [`${WT}/.git`]: "not a gitdir line\n" }],
    ["empty", { ...stdFiles(), [`${WT}/.git`]: "" }],
    ["prefix-only", { ...stdFiles(), [`${WT}/.git`]: "gitdir: \n" }],
    ["no-git-file", { [`${ADMIN}/commondir`]: "../..\n" }],
    ["commondir-missing", { [`${WT}/.git`]: `gitdir: ${ADMIN}\n` }],
    ["commondir-empty", { [`${WT}/.git`]: `gitdir: ${ADMIN}\n`, [`${ADMIN}/commondir`]: "" }],
    // 盘符相对形（跨盘时按进程在该盘的当前目录解析）一律照旧；夹具摆成"不拒绝
    // 就会命中主项目"的样子，证明是拒绝在起作用
    ["drive-relative-gitdir", { [`${WT}/.git`]: "gitdir: D:admin\n", [`${WT}/admin/commondir`]: `${MAIN}/.git\n` }],
    ["drive-relative-commondir", { [`${WT}/.git`]: `gitdir: ${ADMIN}\n`, [`${ADMIN}/commondir`]: "D:..\\..\n" }],
  ]) {
    assert.deepEqual(
      identifyProjectFromCwd(WT, memIo(files)),
      noR8(files),
      `${label} 必须与不加 R8 逐字段相同`,
    );
    assert.equal(noR8(files).kind, "project", `${label} 照旧是 project（不是 unattributed）`);
    assert.equal(noR8(files).key, WT_KEY, label);
  }
  // 读函数本身抛错（目录 EISDIR/不存在 ENOENT/超限——readGitFileBounded 的三种
  // 抛错语义）：任何抛错都吞掉=照旧
  for (const err of [["EISDIR", "is a directory"], ["ENOENT", "no such file"], ["over-limit", "file over 4096 bytes"]]) {
    const throwing = { platform: "win32", realpath: (p) => p, tmpdir: "C:/PROBE-TMP", readGitFile: () => { throw new Error(`simulated ${err[1]}`); } };
    assert.deepEqual(
      identifyProjectFromCwd(WT, throwing),
      identifyProjectFromCwd(WT, { ...throwing, readGitFile: undefined }),
      `readGitFile 抛错（${err[0]}）必须照旧`,
    );
  }
});

// ── 5. realpath 失败 → 照旧 ──────────────────────────────────────────────────

test("0099 R8: gitdir/commondir 的 realpath 失败 → 照旧（不是 unattributed）", () => {
  // gitdir 的 realpath 失败（admin 目录被挪走后 junction 死链形状）
  const deadGitdir = identifyProjectFromCwd(WT, memIo(stdFiles(), {
    junctions: { [ADMIN]: "D:/gone/nowhere" },
  }));
  // 注意：realpath 改写后 commondir 读的是 D:/gone/nowhere/commondir → ENOENT → 照旧
  assert.equal(deadGitdir.kind, "project");
  assert.equal(deadGitdir.key, WT_KEY);
  // commondir 的 realpath 失败（注入 realpath 对该路径抛错）
  const io = memIo(stdFiles());
  const origRealpath = io.realpath;
  io.realpath = (p) => (norm(p).endsWith("/.git") && norm(p) !== `${WT}/.git`
    ? (() => { throw new Error("ENOENT"); })()
    : origRealpath(p));
  const deadCommon = identifyProjectFromCwd(WT, io);
  assert.equal(deadCommon.kind, "project");
  assert.equal(deadCommon.key, WT_KEY);
});

// ── 6. 共同目录 basename 不是 .git；名叫 .git 的裸仓库 ────────────────────────

test("0099 R8: 共同目录 basename 不是 .git（x.git / modules 子目录 / .GIT）→ 照旧；裸仓库 proj/.git → proj", () => {
  for (const [label, commonPath] of [
    ["bare x.git", "D:/stores/proj.git"],
    ["submodule gitdir", "D:/projects/proj/.git/modules/sub"],
    ["case .GIT", "D:/projects/proj/.GIT"],
  ]) {
    const id = identifyProjectFromCwd(WT, memIo({
      [`${WT}/.git`]: `gitdir: ${commonPath}/worktrees/wt1\n`,
      [`${commonPath}/worktrees/wt1/commondir`]: "../..\n",
    }));
    assert.equal(id.kind, "project", label);
    assert.equal(id.key, WT_KEY, `${label} → 照旧归工作树自身`);
  }
  // 名叫 .git 的裸仓库：git clone --bare → proj/.git 后加工作树 → 主工作树=proj
  const bare = identifyProjectFromCwd("D:/wt/bare-wt", memIo({
    "D:/wt/bare-wt/.git": "gitdir: D:/stores/proj/.git/worktrees/wt1\n",
    "D:/stores/proj/.git/worktrees/wt1/commondir": "../..\n",
  }));
  assert.equal(bare.key, "d:/stores/proj", "basename 恰为 .git（区分大小写）→ 主工作树=父目录");
  assert.equal(bare.displayName, "proj");
});

// ── 7. 只看工作树根；R4→R8 复合；R7/R5 不受影响 ────────────────────────────────

test("0099 R8: 子目录 cwd 不往上找；.wao-worktrees/<run>/… 先 R4 再 R8；沙箱/tmpdir 判定不受影响", () => {
  const io = memIo(stdFiles());
  // 子目录：读 <subdir>/.git 失败 → 照旧归子目录自身（不往上找）
  const sub = identifyProjectFromCwd(`${WT}/sub`, io);
  assert.equal(sub.kind, "project");
  assert.equal(sub.key, "d:/wt/proj-wt/sub");
  // 工作树内 WAO 隔离树：R4 剥段回到工作树根，再 R8 → 主项目
  const nested = identifyProjectFromCwd(`${WT}/.wao-worktrees/run_x/sub`, io);
  assert.equal(nested.key, MAIN_KEY, "R4 之后 R8 接力");
  // R7 沙箱先判（闭表词法，不受 R8 影响）
  const sandbox = identifyProjectFromCwd("C:/x/.codex/worktrees/w1/repo", {
    ...io,
    realpath: () => { throw new Error("dead"); },
  });
  assert.equal(sandbox.kind, "sandbox");
  // tmpdir 下的链接工作树：R5 先判 → scratch（即便 .git 文件形状齐全）
  const tmpWt = identifyProjectFromCwd("C:/PROBE-TMP/wt/proj-wt", memIo({
    "C:/PROBE-TMP/wt/proj-wt/.git": `gitdir: ${ADMIN}\n`,
    [`${ADMIN}/commondir`]: "../..\n",
  }));
  assert.equal(tmpWt.kind, "scratch");
});

// ── 8. 未注入 readGitFile → R8 不生效 ────────────────────────────────────────

test("0099 R8: 不注入 readGitFile → R8 不生效（身份判定保持纯函数合同）", () => {
  const io = memIo(stdFiles());
  const inert = identifyProjectFromCwd(WT, { ...io, readGitFile: undefined });
  assert.equal(inert.kind, "project");
  assert.equal(inert.key, WT_KEY);
});

// ── 9. identityOfFirstEvent：在档事实优先（读函数零调用）；legacy 按 R8 推导 ────

test("0099 R8: identityOfFirstEvent——带事实首事件原样返回（读函数 0 次调用）；legacy 无事实按 R8 推导", () => {
  let reads = 0;
  const base = memIo(stdFiles());
  const io = { ...base, readGitFile: (p) => { reads += 1; return base.readGitFile(p); } };
  const fact = {
    kind: "project", rulesVersion: "td190-r2",
    key: "d:/old/worktree-key", bucket: "old-name-abcd1234",
  };
  const r = identityOfFirstEvent({ cwd: WT, project: fact }, io);
  assert.equal(r.factError, null);
  assert.deepEqual(r.identity, fact, "在档事实原样返回");
  assert.equal(reads, 0, "事实在档时读函数一次都不调");
  const legacy = identityOfFirstEvent({ cwd: WT }, io);
  assert.equal(legacy.factError, null);
  assert.equal(legacy.identity.kind, "project");
  assert.equal(legacy.identity.key, MAIN_KEY, "legacy 无事实 → R8 推导主项目");
  assert.ok(reads > 0);
});

// ── 10. projectFactFromCwd 记 td190-r3（含 R8 命中路径）────────────────────────

test("0099 R8: projectFactFromCwd 记 rulesVersion=td190-r3（PROJECT_IDENTITY_RULES_VERSION）", () => {
  assert.equal(PROJECT_IDENTITY_RULES_VERSION, "td190-r3");
  const fact = projectFactFromCwd(WT, memIo(stdFiles()));
  assert.equal(fact.rulesVersion, "td190-r3");
  assert.equal(fact.key, MAIN_KEY);
});

// ── 10b. 生产读函数：只读普通小文件 ──────────────────────────────────────────────

test("0099 R8: readGitFileBounded 读普通小文件；目录、超限、不存在都抛错", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8-read-"));
  try {
    const small = join(root, "commondir");
    writeFileSync(small, "../..\n", "utf8");
    assert.equal(readGitFileBounded(small), "../..\n");
    const exact = join(root, "exact");
    writeFileSync(exact, "x".repeat(GIT_META_FILE_MAX_BYTES), "utf8");
    assert.equal(readGitFileBounded(exact).length, GIT_META_FILE_MAX_BYTES, "恰好等于上限照读");
    const big = join(root, "big");
    writeFileSync(big, "x".repeat(GIT_META_FILE_MAX_BYTES + 1), "utf8");
    assert.throws(() => readGitFileBounded(big), /over 4096 bytes/);
    assert.throws(() => readGitFileBounded(root), /not a regular file/);
    assert.throws(() => readGitFileBounded(join(root, "missing")), { code: "ENOENT" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 11. 调用点一致（盘上夹具）：写/读/计划器/执行器同一 key；桶不翻倍 ───────────

test("0099 R8 调用点一致: 写侧/读侧 cwdHint/迁移计划器/执行器同一 key；resolveRunDirForWrite 命中既有主桶", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8-cons-"));
  try {
    // 手工摆出链接工作树形状（真实 git worktree 生成的东西长这样；进程级真跑见
    // projectIdentityLinkedWorktreeGit.test.js）
    const mainRepo = join(root, "projects", "proj");
    const wt = join(root, "wt", "proj-wt");
    const admin = join(mainRepo, ".git", "worktrees", "wt1");
    mkdirSync(admin, { recursive: true });
    mkdirSync(wt, { recursive: true });
    const fwd = (p) => p.replace(/\\/g, "/");
    writeFileSync(join(wt, ".git"), `gitdir: ${fwd(admin)}\n`, "utf8");
    writeFileSync(join(admin, "commondir"), "../..\n", "utf8");

    const io = { ...productionProjectIo(), tmpdir: "" }; // 绕开 R5（夹具在 os.tmpdir 下）
    const runDir = join(root, "runs");
    mkdirSync(runDir);

    // 写侧：链接工作树 cwd → 主项目事实 + 主桶
    const fact = projectFactFromCwd(fwd(wt), io);
    const mainFact = projectFactFromCwd(fwd(mainRepo), io);
    const identity = identifyProjectFromCwd(fwd(wt), io);
    assert.equal(fact.key, mainFact.key, "链接工作树 key=主仓 key");
    const w = resolveRunDirForWrite(runDir, identity, { io });
    assert.equal(w.bucket, fact.bucket);
    // 在主桶写一条带事实的转录
    writeFileSync(join(w.transcriptDir, "run_new.jsonl"), [
      JSON.stringify({ type: "run.started", runId: "run_new", agentId: "t", cwd: fwd(wt), ts: new Date().toISOString(), seq: 0, project: fact }),
      JSON.stringify({ type: "run.state_change", runId: "run_new", to: "completed", reason: "completion", ts: new Date().toISOString(), seq: 1 }),
    ].join("\n") + "\n", "utf8");

    // 读侧：cwdHint=链接工作树路径 → 经索引命中主桶
    const resolved = resolveTranscriptPath(runDir, "run_new", { cwdHint: fwd(wt), io });
    assert.ok(resolved.includes(join("projects", fact.bucket)), `cwdHint 应命中主桶：${resolved}`);

    // 计划器：legacy 平铺运行（cwd=链接工作树）→ 同一 key/slug
    writeFileSync(join(runDir, "run_old.jsonl"), [
      JSON.stringify({ type: "run.started", runId: "run_old", agentId: "t", cwd: fwd(wt), ts: new Date().toISOString(), seq: 0 }),
      JSON.stringify({ type: "run.state_change", runId: "run_old", to: "completed", reason: "completion", ts: new Date().toISOString(), seq: 1 }),
    ].join("\n") + "\n", "utf8");
    const plan = planProjectsMigration({ runDir, io });
    assert.equal(plan.rulesVersion, "td190-r3");
    const bucket = plan.buckets.find((b) => b.projectKey === fact.key);
    assert.ok(bucket, "计划器把链接工作树 legacy 运行归主项目");
    assert.equal(bucket.slug, fact.bucket);

    // 执行器：迁进同一主桶，projects/ 下项目桶数=1（不新建桶）
    const applied = applyProjectsMigration({ runDir, manifestDir: join(root, ".wao", "migration", "td190-d3"), io, stamp: "r8" });
    const migrated = applied.items.find((it) => it.runId === "run_old");
    assert.equal(migrated.status, "migrated");
    assert.equal(migrated.slug, fact.bucket, "执行器归宿=既有主桶");
    const buckets = readdirSync(join(runDir, "projects")).filter((n) => !n.startsWith("."));
    assert.equal(buckets.length, 1, `只允许一个项目桶：${buckets.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 11b. 带 cwdHint 的读路径用模块缺省 io 经 R8 命中主桶 ─────────────────────────

test("0099 R8: cwdHint 读路径用 projectBuckets 的缺省 io（只注入 tmpdir）经 R8 命中主桶；同内容孪生时 hint 桶优先于字典序", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8-hint-"));
  try {
    const mainRepo = join(root, "projects", "proj");
    const wt = join(root, "wt", "proj-wt");
    const admin = join(mainRepo, ".git", "worktrees", "wt1");
    mkdirSync(admin, { recursive: true });
    mkdirSync(wt, { recursive: true });
    const fwd = (p) => p.replace(/\\/g, "/");
    writeFileSync(join(wt, ".git"), `gitdir: ${fwd(admin)}\n`, "utf8");
    writeFileSync(join(admin, "commondir"), "../..\n", "utf8");

    const runDir = join(root, "runs");
    mkdirSync(runDir);
    const io = { ...productionProjectIo(), tmpdir: "" }; // 绕开 R5（夹具在 os.tmpdir 下）
    const w = resolveRunDirForWrite(runDir, identifyProjectFromCwd(fwd(wt), io), { io });
    const body = `${JSON.stringify({ type: "run.started", runId: "run_twin", agentId: "t", cwd: fwd(wt), ts: "2026-10-30T00:00:00.000Z", seq: 0 })}\n`;
    const mainCopy = join(w.transcriptDir, "run_twin.jsonl");
    writeFileSync(mainCopy, body, "utf8");
    // 字典序更小的另一个桶里放同内容副本：不带 hint 时按字典序选它
    const decoyCopy = join(runDir, "projects", "aaa-00000000", "run_twin.jsonl");
    mkdirSync(join(runDir, "projects", "aaa-00000000"));
    writeFileSync(decoyCopy, body, "utf8");
    assert.equal(resolveTranscriptPath(runDir, "run_twin"), decoyCopy, "不带 hint：字典序最小的桶");
    // 只注入 tmpdir：realpath 与 readGitFile 用 projectBuckets 的缺省
    const hinted = () => resolveTranscriptPath(runDir, "run_twin", { cwdHint: fwd(wt), io: { tmpdir: "" } });
    assert.equal(hinted(), mainCopy, "带 hint：经 R8 命中主桶");
    if (process.platform === "win32") {
      // commondir 写成绝对路径、末段大小写与盘上不同（.GIT）：缺省 realpath 与写侧
      // 同为 .native，返回盘上的 .git，读写两侧仍是同一个 key
      writeFileSync(join(admin, "commondir"), `${fwd(mainRepo)}/.GIT\n`, "utf8");
      assert.equal(projectFactFromCwd(fwd(wt), io).key, projectFactFromCwd(fwd(mainRepo), io).key, "写侧仍归主项目");
      assert.equal(hinted(), mainCopy, "读侧缺省 realpath 与写侧一致");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 12. runs list --project 的选择器语义（决定已知边界）─────────────────────────

test("0099 R8: runs list --project <链接工作树路径> 选主项目；记工作树自身 key 的旧运行用裸名/slug 选、路径选不到", async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-r8-list-"));
  try {
    const mainRepo = join(root, "projects", "proj");
    const wt = join(root, "wt", "proj-wt");
    const admin = join(mainRepo, ".git", "worktrees", "wt1");
    mkdirSync(admin, { recursive: true });
    mkdirSync(wt, { recursive: true });
    const fwd = (p) => p.replace(/\\/g, "/");
    writeFileSync(join(wt, ".git"), `gitdir: ${fwd(admin)}\n`, "utf8");
    writeFileSync(join(admin, "commondir"), "../..\n", "utf8");

    const runDir = join(root, "runs");
    mkdirSync(runDir);
    const ioWith = { realpath: (p) => p, tmpdir: join(root, "scratch-tmp"), readGitFile: productionProjectIo().readGitFile };
    const ioWithout = { ...ioWith, readGitFile: undefined };

    const seed = (runId, cwd, fact) => writeFileSync(join(runDir, `${runId}.jsonl`), [
      JSON.stringify({ type: "run.started", runId, agentId: "t", cwd, ts: new Date().toISOString(), seq: 0, ...(fact ? { project: fact } : {}) }),
      JSON.stringify({ type: "run.state_change", runId, to: "completed", reason: "completion", ts: new Date().toISOString(), seq: 1 }),
    ].join("\n") + "\n", "utf8");

    // R8 之后派出的运行（事实=主项目）；R8 之前的旧运行（事实=工作树自身 key）；
    // legacy（无事实，分类时按 R8 推导）
    const mainFact = projectFactFromCwd(fwd(wt), ioWith);
    const wtFact = projectFactFromCwd(fwd(wt), ioWithout);
    assert.notEqual(mainFact.key, wtFact.key);
    seed("run_after", fwd(wt), mainFact);
    seed("run_before", fwd(wt), wtFact);
    seed("run_legacy", fwd(wt), null);

    const opts = { runDir, knownAgentIds: [], projectIo: ioWith };
    // 路径选主项目：R8 后 + legacy；R8 前旧运行选不到
    assert.deepEqual(
      (await listRuns({ ...opts, projectFilter: fwd(wt) })).runs.map((r) => r.runId).sort(),
      ["run_after", "run_legacy"],
    );
    // 旧运行用裸名（工作树目录名）或 slug 能选到
    assert.deepEqual((await listRuns({ ...opts, projectFilter: "proj-wt" })).runs.map((r) => r.runId), ["run_before"]);
    assert.deepEqual((await listRuns({ ...opts, projectFilter: wtFact.bucket })).runs.map((r) => r.runId), ["run_before"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
