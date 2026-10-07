// test/backends/oauthDirSweep.test.js
//
// TD-223（2026-10-07）：sweepClaudeOauthDirs 单元测试。
//
// 判定规则闭集（application/oauthDirSweep.js）：
//   - 前缀条目非目录 → skip "not-a-dir"
//   - .wao-owner.json 可解析 + pid 存活 → skip "owner-alive"；pid 死 → 可删
//   - 无标记/标记不可解析（含 pid 非正整数）→ mtime 距 now > 24h 才可删，
//     否则 skip "legacy-young"
//   - apply=false：可删目录 → skip "dry-run"（计数即"将删数"），一律不真删
//   - apply=true：rmSync；单目录失败 → skip "error"，继续其余，永不抛
//
// fixture 全部建在测试自建临时根（mkdtemp 于 os.tmpdir()——Windows 纪律：显式
// 绝对路径）；isPidAlive 注入假判定，绝不探测真实进程；不触碰真实凭据。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  sweepClaudeOauthDirs,
  defaultIsPidAlive,
  OAUTH_DIR_PREFIX,
  OWNER_MARKER_FILE,
  SWEEP_LEGACY_AGE_MS,
} from "../../src/application/oauthDirSweep.js";

const HOUR = 60 * 60 * 1000;

async function makeRoot() {
  return mkdtempSync(join(tmpdir(), "wao-sweep-test-"));
}

/**
 * 建一个 wao-claude-oauth-* fixture 目录。
 * marker=null → 不写标记（遗留形态）；marker="garbage" → 写坏 JSON；
 * marker={pid} → 写合法标记。ageMs 控制 mtime（相对 nowRef，默认当场；边界
 * 测试显式传同一 nowRef + sweep 注入同一 now，消除两次 Date.now() 的时序差）。
 */
function makeOauthDir(root, name, { marker = { pid: 424242 }, ageMs = 0, credentials = true, nowRef = Date.now() } = {}) {
  const dir = join(root, name);
  mkdirSync(dir);
  if (marker === "garbage") {
    writeFileSync(join(dir, OWNER_MARKER_FILE), "{not-json", "utf8");
  } else if (marker && typeof marker === "object") {
    writeFileSync(join(dir, OWNER_MARKER_FILE), JSON.stringify(marker), "utf8");
  }
  if (credentials) writeFileSync(join(dir, ".credentials.json"), "{}", "utf8");
  utimesSync(dir, new Date(nowRef - ageMs), new Date(nowRef - ageMs));
  return dir;
}

test("TD-223 sweep: owner 标记 pid 存活 → skip owner-alive（dry-run 与 apply 都不删）", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-sweep-alive-"));
  try {
    const dir = makeOauthDir(root, `${OAUTH_DIR_PREFIX}alive`);
    const dry = sweepClaudeOauthDirs({ baseDir: root, isPidAlive: () => true, apply: false });
    assert.equal(dry.scanned, 1);
    assert.equal(dry.deleted, 0);
    assert.equal(dry.byReason["owner-alive"], 1);
    assert.ok(existsSync(dir), "dry-run 后目录仍在");
    const applied = sweepClaudeOauthDirs({ baseDir: root, isPidAlive: () => true, apply: true });
    assert.equal(applied.deleted, 0, "owner 存活时 apply 也不删");
    assert.equal(applied.byReason["owner-alive"], 1);
    assert.ok(existsSync(dir), "apply 后目录仍在");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 sweep: owner 标记 pid 已死 → dry-run 计入将删不真删；apply 删除", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-sweep-dead-"));
  try {
    const dir = makeOauthDir(root, `${OAUTH_DIR_PREFIX}dead`);
    const dry = sweepClaudeOauthDirs({ baseDir: root, isPidAlive: () => false, apply: false });
    assert.equal(dry.scanned, 1);
    assert.equal(dry.deleted, 0, "dry-run 零删除");
    assert.equal(dry.byReason["dry-run"], 1, "可删目录在 dry-run 下按 dry-run 计数");
    assert.ok(existsSync(dir), "dry-run 后目录仍在（不真删）");

    const applied = sweepClaudeOauthDirs({ baseDir: root, isPidAlive: () => false, apply: true });
    assert.equal(applied.deleted, 1);
    assert.equal(applied.skipped.length, 0);
    assert.ok(!existsSync(dir), "apply 后目录被删");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 sweep: 遗留目录（无标记）>24h 可删；≤24h 与恰 24h 边界 skip legacy-young", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-sweep-legacy-"));
  const now = Date.now(); // fixture 与 sweep 共用同一 now，边界判定确定性成立
  try {
    const old = makeOauthDir(root, `${OAUTH_DIR_PREFIX}old`, { marker: null, ageMs: SWEEP_LEGACY_AGE_MS + HOUR, nowRef: now });
    const young = makeOauthDir(root, `${OAUTH_DIR_PREFIX}young`, { marker: null, ageMs: HOUR, nowRef: now });
    const edge = makeOauthDir(root, `${OAUTH_DIR_PREFIX}edge`, { marker: null, ageMs: SWEEP_LEGACY_AGE_MS, nowRef: now });
    const res = sweepClaudeOauthDirs({ baseDir: root, now, isPidAlive: () => false, apply: true });
    assert.equal(res.scanned, 3);
    assert.equal(res.deleted, 1, "只有超 24h 的遗留目录被删");
    assert.ok(!existsSync(old), "超龄遗留目录被删");
    assert.equal(res.byReason["legacy-young"], 2, "未满 24h 与恰在 24h 边界（≤ 判定）都跳过");
    assert.ok(existsSync(young) && existsSync(edge), "年轻/边界目录保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 sweep: 标记解析失败（坏 JSON）与 pid 非法（0/负数/非整数）都走遗留规则", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-sweep-badmarker-"));
  try {
    makeOauthDir(root, `${OAUTH_DIR_PREFIX}garbage`, { marker: "garbage", ageMs: SWEEP_LEGACY_AGE_MS + HOUR });
    makeOauthDir(root, `${OAUTH_DIR_PREFIX}pid0`, { marker: { pid: 0 }, ageMs: SWEEP_LEGACY_AGE_MS + HOUR });
    makeOauthDir(root, `${OAUTH_DIR_PREFIX}pidneg`, { marker: { pid: -5 }, ageMs: SWEEP_LEGACY_AGE_MS + HOUR });
    makeOauthDir(root, `${OAUTH_DIR_PREFIX}pidstr`, { marker: { pid: "123" }, ageMs: SWEEP_LEGACY_AGE_MS + HOUR });
    // isPidAlive 恒 true：若任何坏标记被当成合法 owner，会 skip owner-alive 而非删除。
    const res = sweepClaudeOauthDirs({ baseDir: root, isPidAlive: () => true, apply: true });
    assert.equal(res.deleted, 4, "坏标记一律按遗留规则（超龄可删），不读 pid 探测");
    assert.equal(res.byReason["owner-alive"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 sweep: 非目录条目 skip not-a-dir；非前缀条目不计入 scanned 不受影响", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-sweep-notdir-"));
  try {
    writeFileSync(join(root, `${OAUTH_DIR_PREFIX}plainfile`), "x", "utf8");
    const untouched = join(root, "unrelated-dir");
    mkdirSync(untouched);
    const res = sweepClaudeOauthDirs({ baseDir: root, isPidAlive: () => false, apply: true });
    assert.equal(res.scanned, 1, "只有前缀条目计入");
    assert.equal(res.byReason["not-a-dir"], 1);
    assert.equal(res.deleted, 0);
    assert.ok(existsSync(untouched), "无前缀目录不被扫描/删除");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 sweep: 单目录删除失败（被占为子进程 CWD）→ skip error 继续其余，永不抛", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wao-sweep-resilience-"));
  // Windows 实测（2026-10-07）：目录作为子进程 CWD 时 rmSync 确定性 EPERM——
  // open 句柄/只读属性都会被 libuv force 重试绕过，唯 CWD 占用拦得住。
  let child;
  try {
    const held = makeOauthDir(root, `${OAUTH_DIR_PREFIX}held`, { marker: { pid: 999999 }, ageMs: 0 });
    const deletable = makeOauthDir(root, `${OAUTH_DIR_PREFIX}free`, { marker: { pid: 999998 }, ageMs: 0 });
    child = spawn(
      process.execPath,
      ["--eval", "process.chdir(process.argv[1]); process.stdout.write('READY'); setInterval(()=>{},1000);", held],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (c) => { buf += c; if (buf.includes("READY")) resolve(); });
      child.once("error", reject);
      setTimeout(resolve, 10_000);
    });
    assert.ok(existsSync(held), "前置：held 目录存在");

    const res = sweepClaudeOauthDirs({ baseDir: root, isPidAlive: () => false, apply: true });
    assert.equal(res.scanned, 2);
    assert.equal(res.deleted, 1, "可删目录照常删除");
    assert.equal(res.byReason["error"], 1, "删除失败目录按 error 计数");
    assert.ok(existsSync(held), "held 目录因占用保留");
    assert.ok(!existsSync(deletable), "另一目录已删（失败不中断扫描）");
  } finally {
    if (child) { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }
    await new Promise((r) => setTimeout(r, 200)); // Windows 释放 CWD 占用需要一瞬间
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 sweep: dry-run 混合场景零删除 + byReason 全景；baseDir 缺席返回空报告不抛", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-sweep-mixed-"));
  try {
    const dirs = {
      alive: makeOauthDir(root, `${OAUTH_DIR_PREFIX}a`, { marker: { pid: 111 } }),
      dead: makeOauthDir(root, `${OAUTH_DIR_PREFIX}b`, { marker: { pid: 222 } }),
      young: makeOauthDir(root, `${OAUTH_DIR_PREFIX}c`, { marker: null }),
      old: makeOauthDir(root, `${OAUTH_DIR_PREFIX}d`, { marker: null, ageMs: SWEEP_LEGACY_AGE_MS * 2 }),
    };
    const res = sweepClaudeOauthDirs({
      baseDir: root,
      isPidAlive: (pid) => pid === 111,
      apply: false,
    });
    assert.equal(res.scanned, 4);
    assert.equal(res.deleted, 0);
    assert.deepEqual(
      { ...res.byReason },
      { "owner-alive": 1, "legacy-young": 1, "dry-run": 2 },
      "将删 2（pid 死 + 超龄遗留）；dry-run 计数即清单",
    );
    for (const d of Object.values(dirs)) assert.ok(existsSync(d), "dry-run 不删任何目录");
    assert.ok(res.skipped.every((s) => typeof s.dir === "string" && typeof s.reason === "string"),
      "skipped 含每目录 reason");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const missing = sweepClaudeOauthDirs({ baseDir: join(root, "no-such-base"), apply: true });
  assert.equal(missing.scanned, 0);
  assert.equal(missing.deleted, 0);
  assert.deepEqual(missing.skipped, []);
  assert.deepEqual({ ...missing.byReason }, {}, "baseDir 缺席：空报告不抛");
});

test("TD-223 sweep: 默认 isPidAlive——EPERM 视为存活（保守），本进程 pid 视为存活", () => {
  const root = mkdtempSync(join(tmpdir(), "wao-sweep-defaultpid-"));
  try {
    makeOauthDir(root, `${OAUTH_DIR_PREFIX}self`, { marker: { pid: process.pid } });
    const res = sweepClaudeOauthDirs({ baseDir: root, apply: true });
    assert.equal(res.byReason["owner-alive"], 1, "默认探测器对本进程 pid 报存活 → 不删");
    assert.equal(res.deleted, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD-223 验收修: defaultIsPidAlive 判死仅认 ESRCH——EPERM/未知探测错误一律按存活", () => {
  // sol 会审 Q1：原实现只认 EPERM 判活，未知探测错误全被当死（方向反了）。
  // 判死唯一依据 = ESRCH；其余（EPERM/EACCES/任何未知）保守判活。
  const real = process.kill;
  const cases = [
    { code: "ESRCH", expected: false },
    { code: "EPERM", expected: true },
    { code: "EACCES", expected: true }, // 未知家族错误 → 存活
    { code: undefined, expected: true }, // 无 code 的意外异常 → 存活
  ];
  try {
    assert.equal(defaultIsPidAlive(process.pid), true, "自身进程存活");
    for (const { code, expected } of cases) {
      process.kill = () => { const e = new Error("probe"); e.code = code; throw e; };
      assert.equal(defaultIsPidAlive(4242), expected, `probe error code=${String(code)} → alive=${expected}`);
    }
  } finally {
    process.kill = real; // 恢复全局，防泄漏到后续测试
  }
});
