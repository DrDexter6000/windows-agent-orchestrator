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
} from "../../src/projectIdentity.js";

const identity = (raw, io = {}) => identifyProjectFromCwd(raw, {
  // 缺省注入恒等 realpath（不解析）+ 明确 tmpdir，让用例只测目标规则
  realpath: (p) => p,
  tmpdir: "C:/Users/17865/AppData/Local/Temp",
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
  const s = identity("C:\\Users\\17865\\AppData\\Local\\Temp\\wao-mcp-probe");
  assert.equal(s.kind, "scratch");
  assert.equal(s.key, "_scratch");
  // 大小写与分隔符不影响 tmp 判定
  assert.equal(identity("c:/users/17865/appdata/local/temp/x").kind, "scratch");
});

test("TD-190 D1 R5 边界: 未传 tmpdir 时不启用 scratch 判定（宁缺勿错）", () => {
  const r = identity("C:/Users/17865/AppData/Local/Temp/x", { tmpdir: undefined });
  assert.equal(r.kind, "project", "unknown tmpdir must NOT misclassify user paths as scratch");
});

test("TD-190 D1 R4: .wao-worktrees/<runId> 回溯到所属仓根（隔离工作树不是项目）", () => {
  const r = identity("D:\\projects\\windows-agent-orchestrator-poc\\.wao-worktrees\\run_20261008_x");
  assert.equal(r.kind, "project");
  assert.equal(r.key, "d:/projects/windows-agent-orchestrator-poc");
  // worktree 段可含子路径
  const r2 = identity("D:/projects/wao/.wao-worktrees/run_x/sub/dir");
  assert.equal(r2.key, "d:/projects/wao");
});

test("TD-190 D1 R3: junction 经 realpath 解析（解析失败=unattributed 不静默用未解析键）", () => {
  const r = identity("C:/Users/17865/.agents/skills/wao-orchestrator", {
    realpath: (p) => (p.includes("wao-orchestrator") ? "D:\\projects\\windows-agent-orchestrator-poc" : p),
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
  for (const reserved of ["reliability", "verify", "smoke", "projects", "_scratch"]) {
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
