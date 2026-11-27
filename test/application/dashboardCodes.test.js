// test/application/dashboardCodes.test.js
//
// 第 145b 批（决定 0131 第 2 条；修正二第 7 条改定）：一次性启动码的签发、兑换、过期与清理。
//
//   - 签发：codes\<sha256(码)> 文件，内容是签发时核对过的实例代际（16 位十六进制），
//     码是 64 位小写十六进制；
//   - 兑换：只兑换内容是自己代际的码（别代 = 未知码：不留 claim、不消耗）；一次请求
//     只查一个文件；存在、未过期（60s）且删除成功才算数——只能兑换一次，并发兑换只有
//     一个赢家；
//   - 形状不对的码（或没有合法代际）在碰文件系统之前就拒绝（false 且零 fs 调用）；
//   - 过期码留给低频清理（有条数上限），不在兑换请求里遍历目录；没有"启动时清空 codes\"。
//
// 真实临时目录 + 注入 io/时钟：无网络、无子进程。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  CODE_HEX_RE,
  issueStartCode,
  redeemStartCode,
  sweepExpiredStartCodes,
} from "../../src/application/dashboardCodes.js";

const shaOf = (code) => createHash("sha256").update(code).digest("hex");
const GEN = "0123456789abcdef";
const GEN2 = "fedcba9876543210";

const freshDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "wao-dash-codes-"));
  return [dir, () => rmSync(dir, { recursive: true, force: true })];
};

test("issue: writes codes/<sha256(code)> whose CONTENT is the instance generation, and returns a 64-lowercase-hex code", async () => {
  const [dir, done] = freshDir();
  try {
    const { code, file } = issueStartCode(dir, GEN);
    assert.match(code, CODE_HEX_RE);
    assert.equal(file, join(dir, shaOf(code)));
    assert.equal(readdirSync(dir).filter((n) => n === shaOf(code)).length, 1, "exactly the digest file");
    assert.equal(readFileSync(file, "utf8"), GEN, "the file records the generation the code was issued against");
    assert.equal(statSync(file).size, 16, "nothing but the generation: the code itself never reaches the disk");
    for (const bad of [undefined, null, "", "xyz", "0123456789ABCDEF", GEN + "0", 7]) {
      assert.throws(() => issueStartCode(dir, bad), TypeError, `invalid generation ${String(bad)} refuses to issue`);
    }
  } finally {
    done();
  }
});

test("redeem: a fresh code redeems exactly once; a second attempt fails", async () => {
  const [dir, done] = freshDir();
  try {
    const clock = () => 10_000_000;
    const { code } = issueStartCode(dir, GEN, { now: clock });
    assert.equal(await redeemStartCode(dir, code, { generation: GEN, now: clock }), true, "first redemption wins");
    assert.equal(await redeemStartCode(dir, code, { generation: GEN, now: clock }), false, "the code file is gone");
  } finally {
    done();
  }
});

test("redeem (145b-fix2): a code issued for ANOTHER generation is an unknown code — refused, NO claim left, and the code is not consumed", async () => {
  const [dir, done] = freshDir();
  try {
    const clock = () => 10_000_000;
    const { code } = issueStartCode(dir, GEN, { now: clock }); // 上一代签发的
    const before = readdirSync(dir).sort();
    assert.equal(await redeemStartCode(dir, code, { generation: GEN2, now: clock }), false, "the new generation refuses the old generation's code");
    assert.deepEqual(readdirSync(dir).sort(), before, "no claim file, nothing consumed — treated exactly like an unknown code");
    assert.equal(await redeemStartCode(dir, code, { generation: GEN, now: clock }), true, "the issuing generation can still redeem it");
  } finally {
    done();
  }
});

test("redeem (145b-fix2): a code file with unreadable / old-format (empty) / foreign content is refused without a claim", async () => {
  const [dir, done] = freshDir();
  try {
    const clock = () => 10_000_000;
    for (const content of ["", "garbage", GEN2, `${GEN}\n`, GEN.toUpperCase()]) {
      const { code, file } = issueStartCode(dir, GEN, { now: clock });
      writeFileSync(file, content);
      utimesSync(file, new Date(clock()), new Date(clock()));
      assert.equal(await redeemStartCode(dir, code, { generation: GEN, now: clock }), false, `content ${JSON.stringify(content)} is not this generation`);
      assert.equal(existsSync(`${file}.claim`), false, "and no claim was written");
    }
  } finally {
    done();
  }
});

test("redeem: without a valid generation option nothing is ever redeemed (fail closed, zero fs calls)", async () => {
  let calls = 0;
  const count = async () => { calls += 1; return {}; };
  const io = { stat: count, readFile: count, open: count, unlink: count };
  const code = "ab".repeat(32);
  for (const generation of [undefined, null, "", "xyz", 5]) {
    assert.equal(await redeemStartCode("C:/s", code, { generation, io }), false);
  }
  assert.equal(calls, 0);
});

test("redeem: an expired code is refused (and left for the sweeper); a boundary code is fresh", async () => {
  const [dir, done] = freshDir();
  try {
    let now = 0;
    const clock = () => now;
    const { code } = issueStartCode(dir, GEN, { now: clock });
    now = 60_000;
    assert.equal(await redeemStartCode(dir, code, { generation: GEN, now: clock }), false, "TTL boundary is expired (>= ttl)");
    assert.equal(readdirSync(dir).length, 1, "the expired file is NOT deleted by the redemption");
    now = 59_999;
    const fresh = issueStartCode(dir, GEN, { now: clock });
    assert.equal(await redeemStartCode(dir, fresh.code, { generation: GEN, now: clock }), true, "just inside the TTL is fresh");
  } finally {
    done();
  }
});

test("redeem: concurrent redemption has exactly one winner (atomic claim)", async () => {
  const [dir, done] = freshDir();
  try {
    const now = () => 123456;
    const { code } = issueStartCode(dir, GEN, { now });
    const results = await Promise.all(Array.from({ length: 8 }, () => redeemStartCode(dir, code, { generation: GEN, now })));
    assert.equal(results.filter(Boolean).length, 1, "exactly one winner");
  } finally {
    done();
  }
});

test("redeem: a malformed code never touches the file system (io call count stays zero)", async () => {
  let calls = 0;
  const io = {
    stat: async () => { calls += 1; return null; },
    readFile: async () => { calls += 1; return GEN; },
    unlink: async () => { calls += 1; },
  };
  assert.equal(await redeemStartCode("C:/whatever", "NOT-A-CODE", { generation: GEN, io }), false);
  assert.equal(await redeemStartCode("C:/whatever", "ZZ".repeat(32), { generation: GEN, io }), false);
  assert.equal(await redeemStartCode("C:/whatever", null, { generation: GEN, io }), false);
  assert.equal(calls, 0, "no file system call for a malformed code");
});

test("redeem: order — stat the code file, read its generation, THEN claim, re-verify, delete; a loser stops at the claim", async () => {
  const absent = [];
  const absentIo = {
    open: async (file) => { absent.push(`claim:${file}`); return { close: async () => {} }; },
    stat: async (file) => { absent.push(`stat:${file}`); const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    readFile: async (file) => { absent.push(`read:${file}`); return GEN; },
    unlink: async () => {},
  };
  const code = "ab".repeat(32);
  assert.equal(await redeemStartCode("C:/s", code, { generation: GEN, io: absentIo }), false);
  assert.deepEqual(absent, [`stat:${join("C:/s", shaOf(code))}`], "an absent code file is probed exactly once and nothing is written");

  const seq = [];
  const winIo = {
    stat: async () => { seq.push("stat"); return { mtimeMs: 1000 }; },
    readFile: async () => { seq.push("read"); return GEN; },
    open: async () => { seq.push("claim"); return { close: async () => {} }; },
    unlink: async () => { seq.push("unlink"); },
  };
  assert.equal(await redeemStartCode("C:/s", code, { generation: GEN, io: winIo, now: () => 1100 }), true);
  assert.deepEqual(seq, ["stat", "read", "claim", "stat", "unlink", "unlink"], "check before any write; claim is cleaned only after the code file is gone");

  const loserSeq = [];
  const loserIo = {
    stat: async () => { loserSeq.push("stat"); return { mtimeMs: Date.now() }; },
    readFile: async () => { loserSeq.push("read"); return GEN; },
    open: async () => { loserSeq.push("claim"); const e = new Error("EEXIST"); e.code = "EEXIST"; throw e; },
    unlink: async () => {},
  };
  assert.equal(await redeemStartCode("C:/s", code, { generation: GEN, io: loserIo }), false);
  assert.deepEqual(loserSeq, ["stat", "read", "claim"], "the loser reads the code file, then loses the claim race");

  const foreignSeq = [];
  const foreignIo = {
    stat: async () => { foreignSeq.push("stat"); return { mtimeMs: Date.now() }; },
    readFile: async () => { foreignSeq.push("read"); return GEN2; },
    open: async () => { foreignSeq.push("claim"); return { close: async () => {} }; },
    unlink: async () => { foreignSeq.push("unlink"); },
  };
  assert.equal(await redeemStartCode("C:/s", code, { generation: GEN, io: foreignIo }), false);
  assert.deepEqual(foreignSeq, ["stat", "read"], "another generation's code stops before the claim: no write, no delete");
});

test("redeem (145b-fix): an UNKNOWN code touches nothing — no claim file is created before the code file is proven to exist", async () => {
  const [dir, done] = freshDir();
  try {
    let writes = 0;
    const io = {
      open: async () => { writes += 1; return { close: async () => {} }; },
      unlink: async () => {},
    };
    assert.equal(await redeemStartCode(dir, "ab".repeat(32), { generation: GEN, io, now: () => 5_000_000 }), false);
    assert.equal(writes, 0, "no claim was created for a code that does not exist");
    assert.equal(readdirSync(dir).length, 0, "the codes dir stays empty");
  } finally {
    done();
  }
});

test("redeem (145b-fix): when the code file cannot be deleted the claim STAYS and the code is dead for good", async () => {
  const [dir, done] = freshDir();
  try {
    const now = () => 5_000_000;
    const { code } = issueStartCode(dir, GEN, { now });
    const sha = shaOf(code);
    // 注入的 unlink：只对码文件失败（claim 的清理照常成功也不该发生）。
    const io = {
      unlink: async (file) => {
        if (file === join(dir, sha)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    };
    assert.equal(await redeemStartCode(dir, code, { generation: GEN, io, now }), false, "first attempt fails (the code file is undeletable)");
    assert.ok(existsSync(join(dir, sha)), "the code file is still there");
    assert.ok(existsSync(join(dir, `${sha}.claim`)), "the claim STAYS: this code is dead, the sweeper will collect it");
    assert.equal(await redeemStartCode(dir, code, { generation: GEN, io, now }), false, "second attempt fails too — one code can never buy two sessions");
    assert.equal(await redeemStartCode(dir, code, { generation: GEN, now }), false, "even with the real io the claim blocks it");
  } finally {
    done();
  }
});

test("issue (145b-fix): mtime keeps MILLISECOND precision — the window is the full 60 s, not truncated to the second", async () => {
  const [dir, done] = freshDir();
  try {
    const issuedAt = 1_234_567_890_999; // 毫秒尾数 .999
    const { code } = issueStartCode(dir, GEN, { now: () => issuedAt });
    // 取整到秒的实现会把 mtime 落在 ...000，兑换在 +59.5s 处就会 >= 60s 而过期。
    assert.equal(await redeemStartCode(dir, code, { generation: GEN, now: () => issuedAt + 59_500 }), true, "59.5 s after issue is still fresh (ms precision)");
  } finally {
    done();
  }
});

test("sweep (145b-fix): names like <64hex>Xclaim or <64hex>Yjunk are NOT code files and are never removed", async () => {
  const [dir, done] = freshDir();
  try {
    const junk = ["a".repeat(64) + "Xclaim", "b".repeat(64) + "-claim", "c".repeat(64) + ".claimX", "not-a-digest"];
    for (const name of junk) writeFileSync(join(dir, name), "");
    writeFileSync(join(dir, "d".repeat(64) + ".claim"), ""); // 真正的 claim 残留（过期后清）
    utimesSync(join(dir, "d".repeat(64) + ".claim"), 1, 1);
    assert.equal(await sweepExpiredStartCodes(dir, { now: () => 10_000_000 }), 1, "only the well-shaped .claim went");
    for (const name of junk) assert.ok(existsSync(join(dir, name)), name);
  } finally {
    done();
  }
});

test("sweep: removes only expired codes (of ANY generation), bounded by maxCount, returns the count; fresh codes survive whichever generation they belong to", async () => {
  const [dir, done] = freshDir();
  try {
    let now = 0;
    const clock = () => now;
    issueStartCode(dir, GEN, { now: clock });
    issueStartCode(dir, GEN2, { now: clock });
    issueStartCode(dir, GEN, { now: clock });
    now = 120_000; // everything above is expired
    const keepOwn = issueStartCode(dir, GEN, { now: clock });
    const keepOther = issueStartCode(dir, GEN2, { now: clock }); // 别代刚签发的：清理不能抢走（它可能是新一代刚发给用户的）
    assert.equal(await sweepExpiredStartCodes(dir, { now: clock, maxCount: 2 }), 2, "bounded to maxCount");
    const names = readdirSync(dir);
    assert.equal(names.length, 3, "one expired remains plus the two fresh ones");
    assert.ok(names.includes(shaOf(keepOwn.code)) && names.includes(shaOf(keepOther.code)), "fresh codes survive");
    assert.equal(await sweepExpiredStartCodes(dir, { now: clock, maxCount: 64 }), 1, "the rest goes next round");
    assert.equal(readdirSync(dir).length, 2, "only the fresh codes are left");
  } finally {
    done();
  }
});
