// test/application/dashboardSession.test.js
//
// 第 145b 批（决定 0131 第 2 条）：常驻看板的内存会话存储。
//
//   - 绝对寿命（24h 缺省）：到期即无效；
//   - 条数上限（32 缺省）：超出按签发先后淘汰（FIFO）；
//   - 令牌形状 64 位小写十六进制；比较走 timingSafeEqual 语义（val() 只收串）；
//   - 参数校验 fail-closed（非正整数拒绝）。
//
// 纯内存：注入 now 与随机源，零文件、零网络。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createSessionStore } from "../../src/application/dashboardSession.js";

/** 确定性随机源：依次吐出可预测的字节（每 32 字节一个令牌）。 */
function seqRandom() {
  let n = 0;
  return (size) => {
    const buf = Buffer.alloc(size);
    buf.writeUInt32LE(n++, 0);
    return buf;
  };
}
/** 第 n 个确定性令牌（与 seqRandom 的第 n 次输出一致）。 */
const hashOf = (n) => {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(n, 0);
  return buf.toString("hex");
};

test("session: issued tokens are 64 lowercase hex and carry an absolute expiry", () => {
  let now = 1_000_000;
  const store = createSessionStore({ now: () => now, randomBytesFn: seqRandom() });
  const s = store.issue();
  assert.match(s.token, /^[0-9a-f]{64}$/);
  assert.equal(s.expiresAt, now + 24 * 60 * 60_000, "absolute TTL from issue time");
  assert.equal(store.valid(s.token), true);
  assert.equal(store.valid(hashOf(999)), false, "an unknown token is not valid");
});

test("session: expiry is absolute — a token dies exactly at its own deadline, others survive", () => {
  let now = 5_000_000;
  const store = createSessionStore({ now: () => now, randomBytesFn: seqRandom(), ttlMs: 1000 });
  const first = store.issue();
  now += 999;
  assert.equal(store.valid(first.token), true, "still valid just before the deadline");
  now += 1;
  assert.equal(store.valid(first.token), false, "expired at the deadline");
  const second = store.issue();
  assert.equal(store.valid(second.token), true, "a later session is unaffected");
  assert.equal(store.size(), 1, "the expired one no longer counts");
});

test("session: the cap evicts in issuance order (FIFO) and never exceeds the cap", () => {
  let now = 0;
  const store = createSessionStore({ now: () => now, randomBytesFn: seqRandom(), max: 3, ttlMs: 10_000 });
  const issued = [store.issue(), store.issue(), store.issue(), store.issue()];
  assert.equal(store.size(), 3, "cap enforced");
  assert.equal(store.valid(issued[0].token), false, "the OLDEST was evicted");
  assert.equal(store.valid(issued[1].token), true);
  assert.equal(store.valid(issued[2].token), true);
  assert.equal(store.valid(issued[3].token), true, "the newest is live");
});

test("session: non-string and malformed inputs are simply invalid (never throw)", () => {
  const store = createSessionStore({ now: () => 0, randomBytesFn: seqRandom() });
  assert.equal(store.valid(null), false);
  assert.equal(store.valid(undefined), false);
  assert.equal(store.valid(12345), false);
  assert.equal(store.valid(""), false);
  assert.equal(store.valid("ZZ".repeat(32)), false, "non-hex is not a token");
});

test("session (145b-fix): a fixed random source issues ONCE, then throws instead of looping forever", () => {
  const store = createSessionStore({ now: () => 0, randomBytesFn: () => Buffer.alloc(32, 0x01) });
  const first = store.issue();
  assert.equal(first.token, "01".repeat(32));
  assert.throws(() => store.issue(), /随机|entropy|invalid/i, "the second issue must throw, not spin");
});

test("session: constructor validates its knobs fail-closed", () => {
  assert.throws(() => createSessionStore({ ttlMs: 0 }), /ttlMs/);
  assert.throws(() => createSessionStore({ ttlMs: 1.5 }), /ttlMs/);
  assert.throws(() => createSessionStore({ max: 0 }), /max/);
});
