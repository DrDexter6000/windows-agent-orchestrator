// test:one shim 的靶件（非套件成员）：故意红，验证退出码透传。
import { test } from "node:test";
import assert from "node:assert/strict";

test("target: intentional failure for exit-code passthrough", () => {
  assert.ok(false, "intentional-fail-marker");
});
