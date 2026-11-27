// test/application/dashboardCodes.test.js
//
// 第 145b 批（决定 0131 第 2 条）：一次性启动码的签发、兑换、过期与清理。
//
//   - 签发：codes\<sha256(码)> 空文件，码是 64 位小写十六进制；
//   - 兑换：一次请求只查一个文件；存在、未过期（60s）且删除成功才算数——
//     只能兑换一次，并发兑换只有一个赢家；
//   - 形状不对的码在碰文件系统之前就拒绝（false 且零 fs 调用——io 计数证明）；
//   - 过期码留给低频清理（有条数上限），不在兑换请求里遍历目录。
//
// 真实临时目录 + 注入 io/时钟：无网络、无子进程。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  CODE_HEX_RE,
  issueStartCode,
  redeemStartCode,
  sweepExpiredStartCodes,
  purgeAllStartCodes,
} from "../../src/application/dashboardCodes.js";

const shaOf = (code) => createHash("sha256").update(code).digest("hex");

test("issue: writes codes/<sha256(code)> and returns a 64-lowercase-hex code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  try {
    const { code, file } = issueStartCode(dir);
    assert.match(code, CODE_HEX_RE);
    assert.equal(file, join(dir, shaOf(code)));
    assert.equal(readdirSync(dir).filter((n) => n === shaOf(code)).length, 1, "exactly the digest file");
    assert.equal(statSync(file).size, 0, "the code file carries no content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redeem: a fresh code redeems exactly once; a second attempt fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  try {
    let now = 10_000_000;
    const clock = () => now;
    const { code } = issueStartCode(dir, { now: clock });
    assert.equal(await redeemStartCode(dir, code, { now: clock }), true, "first redemption wins");
    assert.equal(await redeemStartCode(dir, code, { now: clock }), false, "the code file is gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redeem: an expired code is refused (and left for the sweeper); a boundary code is fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  try {
    let now = 0;
    const clock = () => now;
    const { code } = issueStartCode(dir, { now: clock });
    now = 60_000;
    assert.equal(await redeemStartCode(dir, code, { now: clock }), false, "TTL boundary is expired (>= ttl)");
    assert.equal(readdirSync(dir).length, 1, "the expired file is NOT deleted by the redemption");
    now = 59_999;
    const fresh = issueStartCode(dir, { now: clock });
    assert.equal(await redeemStartCode(dir, fresh.code, { now: clock }), true, "just inside the TTL is fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redeem: concurrent redemption has exactly one winner (atomic unlink)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  try {
    const now = () => 123456;
    const { code } = issueStartCode(dir, { now });
    const results = await Promise.all(Array.from({ length: 8 }, () => redeemStartCode(dir, code, { now })));
    assert.equal(results.filter(Boolean).length, 1, "exactly one winner");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redeem: a malformed code never touches the file system (io call count stays zero)", async () => {
  let calls = 0;
  const io = {
    stat: async (...a) => { calls += 1; return null; },
    unlink: async (...a) => { calls += 1; },
  };
  assert.equal(await redeemStartCode("C:/whatever", "NOT-A-CODE", { io }), false);
  assert.equal(await redeemStartCode("C:/whatever", "ZZ".repeat(32), { io }), false);
  assert.equal(await redeemStartCode("C:/whatever", null, { io }), false);
  assert.equal(calls, 0, "no file system call for a malformed code");
});

test("redeem: stat-first (145b-fix) — the code file is probed first; only a winner touches the claim; the loser stats then loses the claim race", async () => {
  const probed = [];
  const io = {
    open: async (file, flag) => { assert.equal(flag, "wx"); probed.push(file); return { close: async () => {} }; },
    stat: async (file) => { probed.push(file); const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    unlink: async () => {},
  };
  const code = "ab".repeat(32);
  assert.equal(await redeemStartCode("C:/s", code, { io }), false);
  assert.deepEqual(probed, [join("C:/s", shaOf(code))], "an absent code file is probed exactly once and nothing is written");
  // 码文件在：赢家序 = stat 码文件 → 抢 claim → 再核码文件 → 删。
  const seq = [];
  const winIo = {
    stat: async (file) => { seq.push("stat"); return { mtimeMs: 1000 }; },
    open: async (file) => { seq.push("claim"); return { close: async () => {} }; },
    unlink: async (file) => { seq.push("unlink"); },
  };
  assert.equal(await redeemStartCode("C:/s", code, { io: winIo, now: () => 1100 }), true);
  assert.equal(seq.filter((s) => s === "stat").length, 2, "the winner re-verifies the code file after claiming");
  assert.equal(seq.filter((s) => s === "claim").length, 1, "exactly one claim");
  assert.equal(seq[0], "stat", "the code file is checked BEFORE any write");
  // 输家：码文件在，但 claim 被占。
  const loserSeq = [];
  const loserIo = {
    stat: async () => { loserSeq.push("stat"); return { mtimeMs: Date.now() }; },
    open: async () => { loserSeq.push("claim"); const e = new Error("EEXIST"); e.code = "EEXIST"; throw e; },
    unlink: async () => {},
  };
  assert.equal(await redeemStartCode("C:/s", code, { io: loserIo }), false);
  assert.deepEqual(loserSeq, ["stat", "claim"], "the loser stats the code file, then loses the claim race");
});
test("redeem (145b-fix): an UNKNOWN code touches nothing — no claim file is created before the code file is proven to exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  try {
    let writes = 0;
    const io = {
      open: async (file, flag) => { writes += 1; return { close: async () => {} }; },
      unlink: async () => {},
    };
    assert.equal(await redeemStartCode(dir, "ab".repeat(32), { io, now: () => 5_000_000 }), false);
    assert.equal(writes, 0, "no claim was created for a code that does not exist");
    assert.equal(readdirSync(dir).length, 0, "the codes dir stays empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redeem (145b-fix): when the code file cannot be deleted the claim STAYS and the code is dead for good", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  try {
    const now = () => 5_000_000;
    const { code } = issueStartCode(dir, { now });
    const sha = shaOf(code);
    // 注入的 unlink：只对码文件失败（claim 的清理照常成功也不该发生）。
    const io = {
      stat: async (file) => statSync(file),
      open: async (file, flag) => (await import("node:fs/promises")).open(file, flag),
      unlink: async (file) => {
        if (file === join(dir, sha)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    };
    assert.equal(await redeemStartCode(dir, code, { io, now }), false, "first attempt fails (the code file is undeletable)");
    assert.ok(existsSync(join(dir, sha)), "the code file is still there");
    assert.ok(existsSync(join(dir, `${sha}.claim`)), "the claim STAYS: this code is dead, the sweeper will collect it");
    // 第二次兑换也失败（claim 还在，抢不到赢家）。
    assert.equal(await redeemStartCode(dir, code, { io, now }), false, "second attempt fails too — one code can never buy two sessions");
    // 换回真实 io：仍失败（claim 挡着），码文件由低频清理收走。
    assert.equal(await redeemStartCode(dir, code, { now }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("issue (145b-fix): mtime keeps MILLISECOND precision — the window is the full 60 s, not truncated to the second", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  try {
    const issuedAt = 1_234_567_890_999; // 毫秒尾数 .999
    const { code, file } = issueStartCode(dir, { now: () => issuedAt });
    // 取整到秒的实现会把 mtime 落在 ...000，兑换在 +59.5s 处就会 >= 60s 而过期。
    assert.equal(await redeemStartCode(dir, code, { now: () => issuedAt + 59_500 }), true, "59.5 s after issue is still fresh (ms precision)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweep (145b-fix): names like <64hex>Xclaim or <64hex>Yjunk are NOT code files and are never removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  try {
    const junk = ["a".repeat(64) + "Xclaim", "b".repeat(64) + "-claim", "c".repeat(64) + ".claimX", "not-a-digest"];
    for (const name of junk) writeFileSync(join(dir, name), "");
    writeFileSync(join(dir, "d".repeat(64) + ".claim"), ""); // 真正的 claim 残留（过期后清）
    utimesSync(join(dir, "d".repeat(64) + ".claim"), 1, 1);
    assert.equal(await sweepExpiredStartCodes(dir, { now: () => 10_000_000 }), 1, "only the well-shaped .claim went");
    for (const name of junk) assert.ok(existsSync(join(dir, name)), name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("purge (145b-fix): a new generation empties codes completely, bounded by maxCount", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  try {
    for (let i = 0; i < 3; i += 1) issueStartCode(dir, { now: () => 1_000 + i });
    writeFileSync(join(dir, "e".repeat(64) + ".claim"), "");
    const purged = await purgeAllStartCodes(dir, { maxCount: 64 });
    assert.equal(purged.ok, true);
    assert.equal(purged.purged, 4, "codes AND claims");
    assert.equal(readdirSync(dir).length, 0);
    // 超过条数上限：失败并如实报剩余。
    for (let i = 0; i < 5; i += 1) issueStartCode(dir, { now: () => 2_000 + i });
    const refused = await purgeAllStartCodes(dir, { maxCount: 2 });
    assert.equal(refused.ok, false, "over the cap the purge reports failure");
    assert.equal(refused.remaining, 3);
    assert.equal(readdirSync(dir).length, 3, "nothing beyond the cap was touched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweep: removes only expired codes, bounded by maxCount, returns the count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  try {
    let now = 0;
    const clock = () => now;
    const stale = [issueStartCode(dir, { now: clock }), issueStartCode(dir, { now: clock }), issueStartCode(dir, { now: clock })];
    now = 120_000; // everything above is expired
    const keep = issueStartCode(dir, { now: clock });
    assert.equal(await sweepExpiredStartCodes(dir, { now: clock, maxCount: 2 }), 2, "bounded to maxCount");
    const names = readdirSync(dir);
    assert.equal(names.length, 2, "one expired remains plus the fresh one");
    assert.ok(names.includes(shaOf(keep.code)), "the fresh code survives");
    assert.equal(await sweepExpiredStartCodes(dir, { now: clock, maxCount: 64 }), 1, "the rest goes next round");
    assert.equal(readdirSync(dir).length, 1, "only the fresh code is left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
