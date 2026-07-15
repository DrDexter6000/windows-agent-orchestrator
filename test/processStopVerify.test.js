// test/processStopVerify.test.js
//
// M10-pre Batch B: process timeout cleanup evidence — TDD tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyProcessExit } from "../src/application/processStopVerify.js";

test("M10pre-B01: process already dead → quiet=true on round 1", async () => {
  let calls = 0;
  const r = await verifyProcessExit({ isAlive: () => { calls++; return false; }, sleep: async () => {} });
  assert.equal(r.quiet, true);
  assert.equal(r.roundsUsed, 1);
  assert.equal(calls, 1);
});

test("M10pre-B02: process dies after 2 rounds → quiet=true on round 2", async () => {
  let alive = true;
  let sleepCalls = 0;
  const r = await verifyProcessExit({
    isAlive: () => alive,
    sleep: async () => { sleepCalls++; if (sleepCalls >= 1) alive = false; },
    rounds: 3, intervalMs: 10,
  });
  assert.equal(r.quiet, true);
  assert.equal(r.roundsUsed, 2);
});

test("M10pre-B03: process never dies → quiet=false after all rounds", async () => {
  const r = await verifyProcessExit({
    isAlive: () => true,
    sleep: async () => {},
    rounds: 3, intervalMs: 10,
  });
  assert.equal(r.quiet, false);
  assert.equal(r.roundsUsed, 3);
});

test("M10pre-B04: uses default rounds and interval when not specified", async () => {
  let calls = 0;
  const r = await verifyProcessExit({ isAlive: () => { calls++; return false; } });
  assert.equal(r.quiet, true);
  assert.equal(r.roundsUsed, 1);
});

test("M10pre-B05: missing isAlive throws", async () => {
  await assert.rejects(() => verifyProcessExit({}));
});

test("M10pre-B06: no raw command/path/PID/stderr in result", async () => {
  const r = await verifyProcessExit({ isAlive: () => false, sleep: async () => {} });
  const dumped = JSON.stringify(r);
  assert.ok(!dumped.includes("command"), "no command field");
  assert.ok(!dumped.includes("path"), "no path field");
  assert.ok(!dumped.includes("pid"), "no pid field");
  assert.ok(!dumped.includes("stderr"), "no stderr field");
});
