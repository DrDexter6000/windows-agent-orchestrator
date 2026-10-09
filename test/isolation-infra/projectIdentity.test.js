// test/isolation-infra/projectIdentity.test.js
//
// TD-190 D1（选择无关部分）单测：cwd 规范化 + 项目键 + 桶 slug。
// 用例锚定 opus 方案会审对最近 300 条转录首事件的实测分布：
//   D:\… 153 条 vs D:/… 18 条（同仓两种写法）；"." 12 条；缺失 9 条；
//   %TEMP%\wao-mcp-probe 10 条（一次性探针）；.wao-worktrees/<runId> 形状。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  identifyProjectFromCwd,
  deriveProjectBucketSlug,
  isReservedBucketSlug,
  projectFactFromCwd,
  PROJECT_IDENTITY_RULES_VERSION,
} from "../../src/projectIdentity.js";

const identity = (raw, io = {}) => identifyProjectFromCwd(raw, {
  // 缺省注入恒等 realpath（不解析）+ 明确 tmpdir，让用例只测目标规则
  realpath: (p) => p,
  tmpdir: "C:/PROBE-TMP",
  platform: "win32",
  ...io,
});

test("TD-190 D1 R1+R2: 同仓两种分隔符写法归一到同一项目键（实测 153:18 拆桶风险）", () => {
  const a = identity("D:\\projects\\windows-agent-orchestrator-poc");
  const b = identity("D:/projects/windows-agent-orchestrator-poc");
  assert.equal(a.kind, "project");
  assert.equal(b.kind, "project");
  assert.equal(a.key, b.key, "backslash vs slash vs case must not split one project into two buckets");
  assert.equal(a.key, "d:/projects/windows-agent-orchestrator-poc");
  // 大小写折叠只作用于键；displayName 保留原 basename
  const c = identity("D:/Projects/Windows-Agent-Orchestrator-POC");
  assert.equal(c.key, a.key, "case-fold is win32 key semantics");
});

test("TD-190 D1 R6: '.' 与缺失是身份缺失（unattributed），不是 scratch——两类事实分开", () => {
  assert.equal(identity(".").kind, "unattributed");
  assert.equal(identity("").kind, "unattributed");
  assert.equal(identity(null).kind, "unattributed");
  assert.equal(identity(undefined).kind, "unattributed");
  const reason = identity(".").reason;
  assert.match(reason, /bare relative/i);
});

test("TD-190 D1 R5: 系统临时目录 → scratch 桶（一次性探针目录不占项目桶）", () => {
  const s = identity("C:\\PROBE-TMP\\wao-mcp-probe");
  assert.equal(s.kind, "scratch");
  assert.equal(s.key, "_scratch");
  // 大小写与分隔符不影响 tmp 判定
  assert.equal(identity("c:/probe-tmp/x").kind, "scratch");
});

test("TD-190 D1 R5 边界: 未传 tmpdir 时不启用 scratch 判定（宁缺勿错）", () => {
  const r = identity("C:/PROBE-TMP/x", { tmpdir: undefined });
  assert.equal(r.kind, "project", "unknown tmpdir must NOT misclassify user paths as scratch");
});

test("TD-190 D1 R4: .wao-worktrees/<runId> 回溯到所属仓根（隔离工作树不是项目）", () => {
  const r = identity("D:\\projects\\windows-agent-orchestrator-poc\\.wao-worktrees\\run_20261008_x");
  assert.equal(r.kind, "project");
  assert.equal(r.key, "d:/projects/windows-agent-orchestrator-poc");
  // worktree 段可含子路径
  const r2 = identity("D:/projects/wao/.wao-worktrees/run_x/sub/dir");
  assert.equal(r2.key, "d:/projects/wao");
  // 真实存量冒烟（dry-run 实跑抓到的形状）：裸相对 .wao-worktrees 路径剥不出
  // 仓根——unattributed，不猜。
  const bare = identity(".wao-worktrees/run_20260920143049316b9leob");
  assert.equal(bare.kind, "unattributed");
  assert.match(bare.reason, /bare relative \.wao-worktrees/);
});

test("TD-190 D1 R3: junction 经 realpath 解析（解析失败=unattributed 不静默用未解析键）", () => {
  const r = identity("C:/probe-links/wao-skill", {
    realpath: (p) => (p.includes("wao-skill") ? "D:\\projects\\windows-agent-orchestrator-poc" : p),
  });
  assert.equal(r.kind, "project");
  assert.equal(r.key, "d:/projects/windows-agent-orchestrator-poc", "junction resolves to the real repo root");
  const dead = identity("D:/projects/renamed-away", {
    realpath: () => { throw new Error("ENOENT"); },
  });
  assert.equal(dead.kind, "unattributed");
  assert.match(dead.reason, /realpath failed/);
});

test("TD-190 D1 R1 尾斜杠: 尾斜杠归一（纯盘符根保留）", () => {
  assert.equal(
    identity("D:/projects/x/").key,
    identity("D:/projects/x").key,
  );
  assert.equal(identity("D:/").key, "d:/");
});

// 终审 M4（opus 探针反例）：非 "." 的相对路径不得经 realpath 按进程 cwd 归属
//（"src" 曾得本仓 key+"src-8629bc9a" 桶——归属随进程漂移）。
test("TD-190 终审 M4: 相对路径（非 '.'）→ unattributed，不猜进程 cwd", () => {
  for (const rel of ["src", "some/relative/path", "./nested"]) {
    const r = identity(rel);
    assert.equal(r.kind, "unattributed", rel);
    assert.match(r.reason, /relative path/);
  }
  // 特例序：裸相对 worktree 判定先于通相对门（更具体的事实先行）
  const wt = identity(".wao-worktrees/run_x");
  assert.match(wt.reason, /bare relative \.wao-worktrees/);
});

// 终审 M5：同 key 必须同 slug——displayName 取 resolved basename，不随原始
// 写法大小写漂移（opus 探针曾分出两个桶）。
test("TD-190 终审 M5: 同 key 同 slug（displayName 与 key 同源）", () => {
  // 模拟 native realpath 的盘上规范大小写（本例=目录在盘上为小写）
  const io = {
    realpath: (p) => p.toLowerCase().replace(/^([a-z]):/, (m0, d) => d.toUpperCase() + ":"),
    tmpdir: "C:/PROBE-TMP",
    platform: "win32",
  };
  const a = identifyProjectFromCwd("D:/projects/windows-agent-orchestrator-poc", io);
  const b = identifyProjectFromCwd("D:\\Projects\\Windows-Agent-Orchestrator-POC", io);
  assert.equal(a.key, b.key);
  assert.equal(deriveProjectBucketSlug(a), deriveProjectBucketSlug(b), "同 key 不同写法不得分桶");
});

test("TD-190 D1 slug: displayName 净化 + 哈希绑定完整键", () => {
  const a = identity("D:/projects/windows-agent-orchestrator-poc");
  const slug = deriveProjectBucketSlug(a);
  assert.match(slug, /^windows-agent-orchestrator-poc-[0-9a-f]{8}$/);
  // 同键同 slug；不同键不同 slug（哈希区分同名项目）
  const b = identity("E:/work/windows-agent-orchestrator-poc");
  assert.notEqual(deriveProjectBucketSlug(b), slug);
  // displayName 净化：非法字符折叠、超长截断、空兜底
  const weird = identity("D:/projects/my weird 项目!! name");
  assert.match(deriveProjectBucketSlug(weird), /^[a-z0-9._-]+-[0-9a-f]{8}$/i);
  const long = identity("D:/projects/" + "a".repeat(60));
  assert.ok(deriveProjectBucketSlug(long).split("-")[0].length <= 40);
  // 非 project 身份不得派生 slug
  assert.throws(() => deriveProjectBucketSlug(identity(".")), /kind=project/);
});

test("TD-190 D1 slug 保留名防御: runs 保留目录与 Windows 设备名不得成为桶名", () => {
  for (const reserved of ["reliability", "verify", "smoke", "projects", "_scratch", "_sandbox"]) {
    assert.equal(isReservedBucketSlug(reserved), true, reserved);
  }
  // 正常 slug（带哈希后缀）不误伤
  const slug = deriveProjectBucketSlug(identity("D:/projects/verify-tooling"));
  assert.equal(isReservedBucketSlug(slug), false);
  assert.equal(slug.startsWith("verify-tooling-"), true);
  // Windows 设备名裸形拒绝
  assert.equal(isReservedBucketSlug("con"), true);
  assert.equal(isReservedBucketSlug("aux-1a2b3c4d"), true, "con/aux 等设备名即使带后缀也拒绝（防御性）");
});

// R7（2026-10-09 opus+sol 会审 consult_20261009101128557nyuuys）：外国 harness
// 沙箱闭表。确定性锚点：沙箱树已被 harness 回收（本机实测两例）——词法判定
// 不得依赖 realpath 成败。
test("TD-190 D1 R7: codex 沙箱 → _sandbox（词法、先于 realpath、死树恒定）", () => {
  const dead = identity("C:\\Users\\probe-user\\.codex\\worktrees\\filesystem-eight\\windows-agent-orchestrator-poc", {
    realpath: () => { throw new Error("ENOENT — sandbox reclaimed by harness"); },
  });
  assert.equal(dead.kind, "sandbox");
  assert.equal(dead.key, "_sandbox");
  assert.equal(dead.harness, "codex");
  assert.equal(dead.worktreeName, "filesystem-eight");
  assert.equal(dead.repoHint, "windows-agent-orchestrator-poc", "repoHint=词法第二段，是 hint 不是归属");
  // 仓内更深 cwd 同样命中（两段之后任意深度）
  const deep = identity("C:/probe-wt/.codex/worktrees/623d/my-repo/src/x", { realpath: () => { throw new Error("dead"); } });
  assert.equal(deep.kind, "sandbox");
  assert.equal(deep.repoHint, "my-repo");
  // 段锚定不锚 homedir（覆盖 .codex 父目录搬迁；CODEX_HOME 整体重定向不含 .codex 段不命中——补齐待生产 io 锚点）+ 大小写不敏感
  const redirected = identity("E:/alt-home/.codex/Worktrees/x/Some-Repo");
  assert.equal(redirected.kind, "sandbox");
  // 只有一段（无 repo）也可判，repoHint=null
  const noRepo = identity("E:/alt-home/.codex/worktrees/only-name");
  assert.equal(noRepo.kind, "sandbox");
  assert.equal(noRepo.repoHint, null);
  // 沙箱内嵌 WAO 工作树：先剥 .wao-worktrees 再判 R7（opus 顺序）
  const nested = identity("C:/probe-wt/.codex/worktrees/wt1/repo/.wao-worktrees/run_x", { realpath: () => { throw new Error("dead"); } });
  assert.equal(nested.kind, "sandbox");
  assert.equal(nested.repoHint, "repo");
  // 非沙箱路径不受影响（普通项目/死路径仍走 R3 语义）
  const normal = identity("D:/projects/windows-agent-orchestrator-poc");
  assert.equal(normal.kind, "project");
});

// D2-②a（2026-10-09 断点续接项②前半）：首事件归属事实的四 kind 有界形状。
test("TD-190 D2-②a: projectFactFromCwd 四 kind 形状钉（rulesVersion 随档）", () => {
  const fact = projectFactFromCwd("D:/projects/windows-agent-orchestrator-poc");
  assert.equal(fact.kind, "project");
  assert.equal(fact.rulesVersion, PROJECT_IDENTITY_RULES_VERSION);
  assert.equal(fact.key, "d:/projects/windows-agent-orchestrator-poc");
  assert.match(fact.bucket, /^windows-agent-orchestrator-poc-[0-9a-f]{8}$/);

  const sandbox = projectFactFromCwd("C:/probe-wt/.codex/worktrees/w1/repo");
  assert.equal(sandbox.kind, "sandbox");
  assert.equal(sandbox.key, "_sandbox");
  assert.equal(sandbox.harness, "codex");
  assert.equal(sandbox.worktreeName, "w1");

  const scratch = projectFactFromCwd("C:/PROBE-TMP/x", { realpath: (p) => p, tmpdir: "C:/PROBE-TMP" });
  assert.deepEqual(Object.keys(scratch).sort(), ["key", "kind", "rulesVersion"]);
  assert.equal(scratch.key, "_scratch");

  const unattr = projectFactFromCwd(".");
  assert.equal(unattr.kind, "unattributed");
  assert.match(unattr.reason, /bare relative/i);
});
