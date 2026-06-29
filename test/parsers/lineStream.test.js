import test from "node:test";
import assert from "node:assert/strict";
import { LineStreamParser } from "../../src/backends/parsers/lineStream.js";

// 用于测试的简单子类：把每行 JSON 的 type 字段作为事件 emit
class TypeCollector extends LineStreamParser {
  constructor() {
    super();
    this.events = [];
  }
  handleLine(obj) {
    this.events.push(obj.type);
    return [];
  }
}

test("feed 多行 JSON，按行切分调用 handleLine", () => {
  const p = new TypeCollector();
  p.feed(JSON.stringify({ type: "a" }) + "\n" + JSON.stringify({ type: "b" }) + "\n");
  assert.deepEqual(p.events, ["a", "b"]);
});

test("非 JSON 行被静默跳过，不抛错", () => {
  const p = new TypeCollector();
  const chunk = [
    JSON.stringify({ type: "good" }),
    "ERROR codex_core::exec: something failed",
    "not json at all",
    JSON.stringify({ type: "also_good" }),
  ].join("\n");
  p.feed(chunk + "\n");
  assert.deepEqual(p.events, ["good", "also_good"]);
});

test("跨 chunk 的不完整行被缓冲，不提前 emit", () => {
  const p = new TypeCollector();
  // 第一个 chunk 只含半行
  p.feed('{"type":"par');
  assert.deepEqual(p.events, []);
  // 第二个 chunk 补全
  p.feed('tial"}\n');
  assert.deepEqual(p.events, ["partial"]);
});

test("最后一个 chunk 无换行尾时，flush 交付残留行", () => {
  const p = new TypeCollector();
  p.feed('{"type":"noNewline"}'); // 无尾部换行
  assert.deepEqual(p.events, []);
  p.flush();
  assert.deepEqual(p.events, ["noNewline"]);
});

test("flush 对空缓冲区是 no-op", () => {
  const p = new TypeCollector();
  p.flush(); // 不应抛错
  assert.deepEqual(p.events, []);
});

test("接受 Buffer 输入（child.stdout 默认给 Buffer）", () => {
  const p = new TypeCollector();
  p.feed(Buffer.from(JSON.stringify({ type: "buf" }) + "\n", "utf8"));
  assert.deepEqual(p.events, ["buf"]);
});

test("CRLF 换行也正确处理（Windows 子进程可能输出 \\r\\n）", () => {
  const p = new TypeCollector();
  p.feed(JSON.stringify({ type: "crlf" }) + "\r\n");
  assert.deepEqual(p.events, ["crlf"]);
});
