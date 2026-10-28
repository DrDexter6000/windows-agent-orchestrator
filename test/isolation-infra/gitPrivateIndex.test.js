// test/isolation-infra/gitPrivateIndex.test.js
//
// src/gitPrivateIndex.js 的纯函数面：只用系统临时目录里的普通文件（不起 git
// 子进程）。行为面（真实索引不被工作树 diff 写回）由 test/delivery/delivery.test.js
// 与 test/application/worktreeReclaim.test.js 的行为测试覆盖。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPrivateIndexCopy } from "../../src/gitPrivateIndex.js";

test("私有索引副本：内容逐字节一致、mtime 早于原索引、落在系统临时目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gpi-copy-"));
  try {
    const src = join(dir, "index");
    // 含非 UTF-8 安全字节：索引是二进制，副本必须逐字节复制而非按文本读改写。
    const payload = Buffer.from([0x44, 0x49, 0x52, 0x43, 0x00, 0x00, 0x00, 0x02, 0xff, 0xfe, 0x80, 0x0a]);
    writeFileSync(src, payload);
    const origStat = statSync(src);
    const priv = createPrivateIndexCopy(src);
    assert.ok(priv, "存在真实索引文件 → 应返回私有副本句柄");
    try {
      assert.ok(typeof priv.env.GIT_INDEX_FILE === "string" && priv.env.GIT_INDEX_FILE.length > 0);
      assert.ok(
        priv.env.GIT_INDEX_FILE.startsWith(tmpdir()),
        "副本必须落在系统临时目录（Windows 纪律：显式绝对临时路径）",
      );
      assert.deepEqual(readFileSync(priv.env.GIT_INDEX_FILE), payload, "副本内容逐字节一致");
      const copyStat = statSync(priv.env.GIT_INDEX_FILE);
      assert.ok(
        copyStat.mtimeMs < origStat.mtimeMs,
        "副本 mtime 必须早于原索引（racy-git 防漏报：更晚会让 git 信任过期 stat）",
      );
    } finally {
      priv.dispose();
    }
    // 复制过程不碰原文件
    assert.deepEqual(readFileSync(src), payload, "原索引字节不变");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("私有索引副本：索引文件不存在（全新仓库）→ null", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gpi-absent-"));
  try {
    assert.equal(createPrivateIndexCopy(join(dir, "no-such-index")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispose：删净整个临时目录（含 git 可能留下的 index.lock），可重复调用不抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gpi-dispose-"));
  try {
    const src = join(dir, "real-index");
    writeFileSync(src, "x");
    const priv = createPrivateIndexCopy(src);
    assert.ok(priv);
    const copyDir = dirname(priv.env.GIT_INDEX_FILE);
    // 模拟 git 在副本目录里留下的锁文件：dispose 必须连目录一起删掉
    writeFileSync(join(copyDir, "index.lock"), "");
    priv.dispose();
    assert.ok(!existsSync(copyDir), "临时目录应整个删除（含 index.lock）");
    priv.dispose(); // 可重复
    priv.dispose();
    assert.ok(!existsSync(copyDir), "重复 dispose 后仍干净且不抛错");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("私有索引副本：env 关掉 core.splitIndex，追加在调用方已有的 GIT_CONFIG_PARAMETERS 末尾", () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-gpi-env-"));
  try {
    const src = join(dir, "index");
    writeFileSync(src, "x");
    const fresh = createPrivateIndexCopy(src, {});
    try {
      assert.equal(fresh.env.GIT_CONFIG_PARAMETERS, "'core.splitIndex=false'");
    } finally {
      fresh.dispose();
    }
    // 继承来的条目（含把 split-index 打开的）原样保留，关掉它的那条排在最后才生效
    const stacked = createPrivateIndexCopy(src, { GIT_CONFIG_PARAMETERS: "'core.splitIndex=true' 'x.y=1'" });
    try {
      assert.equal(stacked.env.GIT_CONFIG_PARAMETERS, "'core.splitIndex=true' 'x.y=1' 'core.splitIndex=false'");
    } finally {
      stacked.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
