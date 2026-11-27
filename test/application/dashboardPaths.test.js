// test/application/dashboardPaths.test.js
//
// 第 145b 批（决定 0131 第 2 条）：常驻看板的运行目录身份与状态目录定位。
//
//   - normalizeRunDir：绝对化 + realpath（解开 junction）+ 分隔符统一 + 去尾分隔符
//     + Windows 大小写统一——同一目录的四种写法必须折成同一个身份串；
//     不存在的目录固定报错（不猜、不创建）。
//   - stateDirFor：身份串 sha256 前 16 位的十六进制目录名，同一身份稳定、不同身份不同。
//   - defaultDashboardStateRoot：LOCALAPPDATA 缺失/非绝对时固定报错（fail-closed）。
//
// 纯确定性：真实临时目录（mkdir/junction），无网络、无子进程、无注册表。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  DASHBOARD_PROTOCOL_VERSION,
  DASHBOARD_CODE_TTL_MS,
  DASHBOARD_SESSION_TTL_MS,
  DASHBOARD_SESSION_MAX,
  DASHBOARD_LAUNCH_DEADLINE_MS,
  DASHBOARD_STOP_BUDGET_MS,
  DASHBOARD_STOP_WAIT_MS,
  DASHBOARD_INSTANCE_LOG_MAX_BYTES,
  DASHBOARD_LOCK_FUTURE_TOLERANCE_MS,
  normalizeRunDir,
  stateDirFor,
  defaultDashboardStateRoot,
} from "../../src/application/dashboardPaths.js";

const IS_WIN = process.platform === "win32";

test("constants: the batch-145b protocol and lifetime values are pinned", () => {
  assert.equal(DASHBOARD_PROTOCOL_VERSION, 1);
  assert.equal(DASHBOARD_CODE_TTL_MS, 60_000);
  assert.equal(DASHBOARD_SESSION_TTL_MS, 24 * 60 * 60_000);
  assert.equal(DASHBOARD_SESSION_MAX, 32);
  assert.equal(DASHBOARD_LAUNCH_DEADLINE_MS, 20_000);
  assert.equal(DASHBOARD_STOP_BUDGET_MS, 5_000);
  assert.equal(DASHBOARD_STOP_WAIT_MS, 10_000);
  assert.equal(DASHBOARD_INSTANCE_LOG_MAX_BYTES, 256 * 1024);
  assert.equal(DASHBOARD_LOCK_FUTURE_TOLERANCE_MS, 1_000);
});

test("normalizeRunDir: the same directory under four spellings folds to one identity", () => {
  const base = mkdtempSync(join(tmpdir(), "wao-dash-id-"));
  try {
    const dir = join(base, "Runs");
    mkdirSync(dir);
    const a = normalizeRunDir(dir);
    // 尾分隔符（两种写法）不影响身份。
    assert.equal(normalizeRunDir(`${dir}/`), a);
    assert.equal(normalizeRunDir(`${dir}\\`), a);
    // 相对形式先绝对化（按进程 cwd）再比较：绝对化结果与直接给绝对路径一致。
    assert.equal(normalizeRunDir(join(base, ".", "Runs")), a);
    // 分隔符统一为 /。
    assert.ok(!a.includes("\\"), "separators are forward slashes");
    assert.ok(!a.endsWith("/"), "no trailing separator");
    if (IS_WIN) {
      // Windows 大小写统一：只有大小写不同的写法是同一身份。
      assert.equal(normalizeRunDir(join(base, "runs")), a);
      assert.equal(normalizeRunDir(join(base, "RUNS")), a);
      assert.ok(a === a.toLowerCase(), "identity is case-folded on Windows");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("normalizeRunDir: a junction is resolved to its target's identity (realpath)", () => {
  if (!IS_WIN) return; // junction 是 Windows 概念；posix 走 symlink 的同一 realpath 语义
  const base = mkdtempSync(join(tmpdir(), "wao-dash-junc-"));
  try {
    const target = join(base, "real", "runs");
    mkdirSync(target, { recursive: true });
    const link = join(base, "link");
    if (IS_WIN) {
      symlinkSync(target, link, "junction");
    } else {
      symlinkSync(target, link, "dir");
    }
    assert.equal(normalizeRunDir(link), normalizeRunDir(target), "the junction alias IS the target");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("normalizeRunDir (145b-fix): a plain FILE is not a run directory — the same fixed error as a missing one", () => {
    const base = mkdtempSync(join(tmpdir(), "wao-dash-file-"));
    try {
      const file = join(base, "not-a-dir");
      writeFileSync(file, "data");
      assert.throws(() => normalizeRunDir(file), /运行目录/, "a file fails the same way as a missing dir");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

test("normalizeRunDir: a missing directory is a fixed error, never a guess", () => {
  const missing = join(tmpdir(), "wao-dash-no-such-" + Date.now());
  assert.throws(() => normalizeRunDir(missing), /运行目录/, "fixed Chinese error text");
});

test("stateDirFor: sha256-first-16 directory name, stable per identity and distinct across identities", () => {
  const root = "C:/wao-state";
  const idA = "d:/proj/runs";
  const idB = "d:/other/runs";
  const expected = createHash("sha256").update(idA).digest("hex").slice(0, 16);
  assert.equal(stateDirFor(idA, root), `${root}/${expected}`);
  assert.equal(stateDirFor(idA, root), stateDirFor(idA, root), "stable");
  assert.notEqual(stateDirFor(idA, root), stateDirFor(idB, root), "distinct identities map apart");
  assert.match(stateDirFor(idB, root), /^[A-Za-z]:\/[^/]+\/[0-9a-f]{16}$/, "16 lowercase hex components only");
});

test("defaultDashboardStateRoot: LOCALAPPDATA anchor, fail-closed when absent or relative", () => {
  assert.equal(defaultDashboardStateRoot({ LOCALAPPDATA: "C:/Users/u/AppData/Local" }), join("C:/Users/u/AppData/Local", "wao", "dashboard"));
  assert.throws(() => defaultDashboardStateRoot({}), /LOCALAPPDATA/, "missing anchor fails closed");
  assert.throws(() => defaultDashboardStateRoot({ LOCALAPPDATA: "relative/path" }), /LOCALAPPDATA/, "relative anchor fails closed");
});
