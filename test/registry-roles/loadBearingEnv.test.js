// test/registry-roles/loadBearingEnv.test.js
//
// TD-218 钉：承重运行时 env 声明表 + 解析序 + doctor advisory 面。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOAD_BEARING_ENV_BY_BACKEND, resolveLoadBearingEnv, resolveLoadBearingEnvFull,
} from "../../src/application/loadBearingEnv.js";

test("TD-218 ①: 声明表——zcode 双承重变量（Carlola 案形状）", () => {
  const z = LOAD_BEARING_ENV_BY_BACKEND.get("zcode");
  assert.deepEqual(z?.map((d) => d.name), ["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]);
  assert.ok(z.every((d) => d.kind === "file"));
});

test("TD-218 ②: 解析序 agent-env → process-env → user-env；三级缺失=missing", () => {
  const declared = { name: "X_CFG", kind: "file" };
  assert.equal(resolveLoadBearingEnv({ declared, agentEnv: { X_CFG: "/a" }, processEnv: { X_CFG: "/b" } }).source, "agent-env", "注册表 env 块优先");
  assert.equal(resolveLoadBearingEnv({ declared, agentEnv: {}, processEnv: { X_CFG: "/b" } }).source, "process-env");
  assert.equal(
    resolveLoadBearingEnv({ declared, agentEnv: {}, processEnv: {}, userEnvReader: () => "/c" }).source,
    "user-env",
  );
  assert.equal(resolveLoadBearingEnv({ declared, agentEnv: {}, processEnv: {}, userEnvReader: () => null }).status, "missing");
  // 空串视同缺失（不猜）
  assert.equal(resolveLoadBearingEnv({ declared, agentEnv: { X_CFG: "" }, processEnv: {} }).status, "missing");
});

test("TD-218 ③: file 类存在性——file-missing 独立态；值绝不进返回结构", () => {
  const declared = { name: "X_CFG", kind: "file" };
  const ok = resolveLoadBearingEnvFull({ declared, agentEnv: { X_CFG: "/real" }, processEnv: {}, existsFn: () => true });
  assert.equal(ok.status, "ok");
  const gone = resolveLoadBearingEnvFull({ declared, agentEnv: { X_CFG: "/ghost" }, processEnv: {}, existsFn: () => false });
  assert.equal(gone.status, "file-missing", "声明在但文件不在=独立态（spawn 将失败）");
  assert.equal(gone.fileExists, false);
  assert.ok(!JSON.stringify(gone).includes("/ghost"), "路径值不得泄漏进返回结构");
});

test("TD-218 ④: doctor 5b 源钉——独立 advisory 消费声明表与 env 块（不进 requiredCredentialNames）", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const src = readFileSync(resolve(import.meta.dirname, "../../src/commands/doctor.js"), "utf8");
  assert.match(src, /LOAD_BEARING_ENV_BY_BACKEND/, "doctor 消费声明表");
  assert.match(src, /resolveLoadBearingEnvFull/, "doctor 用完整解析（含文件存在性）");
  assert.match(src, /agent-env-block/, "注册表 env 块变量同样承重");
  const envPolicy = readFileSync(resolve(import.meta.dirname, "../../src/envPolicy.js"), "utf8");
  assert.ok(!envPolicy.includes("LOAD_BEARING"), "声明表不进 envPolicy（不改变派发阻断语义——独立 advisory 面）");
});
