// test:one shim 的靶件（非套件成员——manifest 是唯一枚举源，本文件不注册）。
// 声称：经 shim 启动时，env 中和与 TEMP 隔离都从 canonical 单一来源生效。
import { test } from "node:test";
import assert from "node:assert/strict";

test("target: canonical env discipline applied (cert gate pinned to 0)", () => {
  assert.equal(process.env.WAO_MCP_REQUIRE_CERTIFIED, "0",
    "shim 必须套用 buildCanonicalChildEnv——父进程带 =1 也要被钉成 0");
  assert.equal(process.env.WAO_SKIP_VERSION_GUARD, "1");
});

test("target: one-shot TEMP isolation in effect (TD-223 via isolateSuiteTemp)", () => {
  assert.match(process.env.TMP ?? "", /wao-canonical-temp-/,
    "shim 必须套用 isolateSuiteTemp——防 ClaudeCodeBackend 往真实 %TEMP% 撒凭据副本");
});
