import test from "node:test";
import assert from "node:assert/strict";
import { PortAllocator } from "../src/portAllocator.js";

test("allocate 返回范围内的端口", () => {
  const pa = new PortAllocator({ range: [30000, 30010] });
  const port = pa.allocate();
  assert.ok(port >= 30000 && port <= 30010, `port ${port} out of range`);
});

test("连续 allocate 不重复", () => {
  const pa = new PortAllocator({ range: [30000, 30005] });
  const ports = new Set();
  for (let i = 0; i < 6; i++) {
    ports.add(pa.allocate());
  }
  assert.equal(ports.size, 6);
});

test("release 后端口可重新分配", () => {
  const pa = new PortAllocator({ range: [30000, 30002] });
  const p1 = pa.allocate();
  const p2 = pa.allocate();
  const p3 = pa.allocate();
  pa.release(p2);
  const p4 = pa.allocate();
  // p4 应该是刚 release 的 p2（复用）
  assert.equal(p4, p2);
});

test("范围耗尽抛错", () => {
  const pa = new PortAllocator({ range: [30000, 30001] });
  pa.allocate();
  pa.allocate();
  assert.throws(() => pa.allocate(), /no available port|exhausted/i);
});

test("release 未分配的端口是 no-op", () => {
  const pa = new PortAllocator({ range: [30000, 30001] });
  pa.release(99999); // 不抛错
  const port = pa.allocate();
  assert.ok(port >= 30000);
});

test("checkInUse 回调跳过被占用端口", () => {
  // 模拟 30000 被占用
  const pa = new PortAllocator({
    range: [30000, 30002],
    checkInUse: (port) => port === 30000,
  });
  const port = pa.allocate();
  assert.notEqual(port, 30000, "should skip in-use port");
  assert.ok(port === 30001 || port === 30002);
});
