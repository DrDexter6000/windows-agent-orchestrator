// test/registry-roles/reliabilityArgs.test.js
//
// 2026-09-17 friction 批次 1（f1）dry 钉：reliability 入口参数解析纯函数。
// 事故背景：旧 getArg 纯查表，传 --help 被静默当"无参数"直接跑全量认证
// 矩阵（真实 token 损耗）。本文件钉住：帮助路径、未知/缺值/重复/裸位置
// 参数全部拒绝、合法调用逐字段解析——不跑真实 provider（纯函数 dry 测试，
// adversarialEscape.mjs ↔ reliabilityDelta.test.js 同款先例）。

import test from "node:test";
import assert from "node:assert/strict";
import { parseReliabilityArgs, USAGE } from "../../scripts/reliability/args.mjs";

test("f1: --help / -h → help 路径，零消耗退出", () => {
  assert.equal(parseReliabilityArgs(["--help"]).help, true);
  assert.equal(parseReliabilityArgs(["-h"]).help, true);
  assert.equal(parseReliabilityArgs(["--agent", "auditor", "--help"]).help, true);
});

test("f1: 未知 flag 拒绝（事故复现：--help 旧版被静默吞掉跑全量）", () => {
  for (const bad of ["--agents", "--help-me", "--verbose"]) {
    const r = parseReliabilityArgs([bad]);
    assert.equal(r.help, false);
    assert.match(r.error, /unknown option/);
  }
});

test("f1: 缺值 / 值像 flag / 重复 / 裸位置参数全部拒绝", () => {
  assert.match(parseReliabilityArgs(["--agent"]).error, /requires a value/);
  assert.match(parseReliabilityArgs(["--agent", "--profile"]).error, /requires a value/);
  assert.match(parseReliabilityArgs(["--agent", "a", "--agent", "b"]).error, /duplicate/);
  assert.match(parseReliabilityArgs(["auditor"]).error, /positional/);
  assert.match(parseReliabilityArgs([42]).error, /positional|argv/);
});

test("f1: 合法调用逐字段解析（增量形态）", () => {
  const r = parseReliabilityArgs(["--agent", "auditor", "--profile", "delta", "--wait-timeout", "300000"]);
  assert.equal(r.help, false);
  assert.equal(r.error, null);
  assert.deepEqual(r.values, {
    agent: "auditor",
    profile: "delta",
    "wait-timeout": "300000",
  });
});

test("f1: 空参数=全量意图合法（调用方负责提示成本），USAGE 含关键用法", () => {
  const r = parseReliabilityArgs([]);
  assert.equal(r.help, false);
  assert.equal(r.error, null);
  assert.deepEqual(r.values, {});
  assert.ok(USAGE.includes("--agent") && USAGE.includes("--profile") && USAGE.includes("消耗 token"));
});
