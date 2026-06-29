import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWaoDir, getWaoDir } from "../src/waoDir.js";
import { writeStateSnapshot, readCurrentState } from "../src/waoState.js";

async function makeInitWao() {
  const dir = await mkdtemp(join(tmpdir(), "wao-state-"));
  await initWaoDir(dir);
  return dir;
}

// 模拟 engine 的 completedResults（Map<nodeId, NodeResult>）
function mockCompletedResults() {
  return new Map([
    ["analyze", { runId: "run_aaa", transcriptPath: "runs/run_aaa.jsonl", completed: true, output: { text: "done" } }],
    ["implement", { runId: "run_bbb", transcriptPath: "runs/run_bbb.jsonl", completed: false, output: { text: "partial" } }],
  ]);
}

test("S3-2: writeStateSnapshot 写 current.md 含步骤进度表 + run 引用", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await writeStateSnapshot(waoDir, {
      workflowId: "wf_test",
      executed: ["analyze"],
      skipped: [],
      completedResults: mockCompletedResults(),
      allNodes: ["analyze", "implement", "test"],
      predecessors: { implement: ["analyze"], test: ["implement"] },
    });
    const current = await readFile(join(waoDir, "state", "current.md"), "utf8");
    assert.match(current, /wf_test/, "含 workflowId");
    assert.match(current, /analyze/, "含已完成节点");
    assert.match(current, /run_aaa/, "含 run 引用");
    assert.match(current, /implement/, "含进行中节点");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-2: writeStateSnapshot 旧 current 归档到 history + 更新 map", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    // 第一次快照
    await writeStateSnapshot(waoDir, {
      workflowId: "wf_v1", executed: ["analyze"], skipped: [],
      completedResults: new Map([["analyze", { runId: "r1", completed: true }]]),
      allNodes: ["analyze"], predecessors: {},
    });
    // 第二次快照（不同进度，应归档第一次）
    await writeStateSnapshot(waoDir, {
      workflowId: "wf_v2", executed: ["analyze", "implement"], skipped: [],
      completedResults: new Map([
        ["analyze", { runId: "r1", completed: true }],
        ["implement", { runId: "r2", completed: true }],
      ]),
      allNodes: ["analyze", "implement"], predecessors: { implement: ["analyze"] },
    });
    // history 应有归档文件
    const { readdir } = await import("node:fs/promises");
    const history = await readdir(join(waoDir, "state", "history"));
    assert.ok(history.length >= 1, "旧 current 应归档到 history");
    // map 应有索引行
    const map = await readFile(join(waoDir, "state", "map.md"), "utf8");
    assert.match(map, /wf_v1|wf_v2/, "map 应含快照索引");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-2: readCurrentState 解析 current.md 成结构化对象", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await writeStateSnapshot(waoDir, {
      workflowId: "wf_parse", executed: ["analyze"], skipped: ["test"],
      completedResults: mockCompletedResults(),
      allNodes: ["analyze", "implement", "test"], predecessors: {},
    });
    const state = await readCurrentState(waoDir);
    assert.equal(state.workflowId, "wf_parse");
    assert.ok(Array.isArray(state.steps));
    assert.ok(state.steps.length > 0);
    assert.ok(state.updated, "应有 updated 时间戳");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-2: map.md 只含索引行（一行一条，无正文）", async () => {
  const dir = await makeInitWao();
  try {
    const waoDir = getWaoDir(dir);
    await writeStateSnapshot(waoDir, {
      workflowId: "wf_map", executed: [], skipped: [],
      completedResults: new Map(), allNodes: [], predecessors: {},
    });
    const map = await readFile(join(waoDir, "state", "map.md"), "utf8");
    const lines = map.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("<!--"));
    // 每行应是短索引（< 120 字符），不含 markdown 正文段
    for (const line of lines) {
      assert.ok(line.length < 120, `map 索引行应短（<120字符），got ${line.length}: ${line}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3-2: readCurrentState 对未 init 的 waoDir 返回 null（不崩）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wao-noinit-"));
  try {
    const waoDir = getWaoDir(dir); // 未 init
    const state = await readCurrentState(waoDir);
    assert.equal(state, null, "未 init 应返回 null 不崩");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
