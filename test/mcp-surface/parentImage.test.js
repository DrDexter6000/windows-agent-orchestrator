// B 审计臂（kimi 诊断批 2026-10-10，Owner 批准）：MCP 父进程镜像留痕。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTasklistCsvImage,
  armMcpParentImage,
  MCP_PARENT_IMAGE_ENV,
} from "../../src/mcp/parentImage.js";

test("B 臂: parseTasklistCsvImage——CSV 首列镜像名解析与形状拒绝", () => {
  assert.equal(parseTasklistCsvImage('"kimi.exe","8540","Console","1","123,456 K"\r\n'), "kimi.exe");
  assert.equal(parseTasklistCsvImage('"ZCode.exe","1","N/A"\n'), "ZCode.exe");
  assert.equal(parseTasklistCsvImage("kimi.exe,8540,plain,csv\n"), "kimi.exe", "非引号 CSV 兜底取首列");
  assert.equal(parseTasklistCsvImage(""), null, "空输出缺席");
  assert.equal(parseTasklistCsvImage("INFO: No tasks are running"), null, "tasklist 无命中提示=缺席");
  assert.equal(parseTasklistCsvImage('"not an exe!","1"\n'), null, "非镜像形状拒绝");
  assert.equal(parseTasklistCsvImage('"x".exe lol","1"\n'), null, "畸形拒绝");
  assert.equal(parseTasklistCsvImage(null), null, "非字符串缺席");
});

test("B 臂: armMcpParentImage——解析成功置 env；失败/异常静默缺席", () => {
  const env = {};
  const ok = armMcpParentImage({ ppid: 4242, spawnFn: () => ({ stdout: '"kimi.exe","4242","x"\n' }), env });
  assert.equal(ok, "kimi.exe");
  assert.equal(env[MCP_PARENT_IMAGE_ENV], "kimi.exe");

  const env2 = {};
  assert.equal(armMcpParentImage({ ppid: 4242, spawnFn: () => ({ error: new Error("x") }), env: env2 }), null);
  assert.equal(MCP_PARENT_IMAGE_ENV in env2, false, "失败不置 env");
  assert.equal(armMcpParentImage({ ppid: 0, spawnFn: () => { throw new Error("unreachable"); }, env: env2 }), null, "非法 ppid 短路");
  assert.equal(armMcpParentImage({ ppid: 1, spawnFn: () => { throw new Error("boom"); }, env: env2 }), null, "异常吞掉=缺席");
});
