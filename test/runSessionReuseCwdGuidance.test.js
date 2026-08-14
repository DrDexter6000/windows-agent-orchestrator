// runSessionReuseCwdGuidance.test.js
//
// TD-110（D2 A3）：sessionReuse agent 派发拒绝的 --cwd flag 指引。
//
// 背景：dispatchRun 对 sessionReuse:"lead_workspace" 且无 cwd 的派发抛裸 Error
// （runDispatch.js 原 :290-291）。CLI background 路径（run --background / spawn）
// 顶层 catch 只打印 message，用户看到 "bound workspace (cwd) is required" 却不知道
// 该传哪个 flag。GREEN 方案（Lead 裁决）：typed error 纯加法 + CLI background 派发
// catch 按 error.name 识别，打印原 message + 一行静态指引。
//
// 两条 RED：
//   ① spawn 级 CLI：run <agent> --prompt x --background（无 --cwd）→ 非零退出 +
//      stderr 同时含原闭集原因文案与 `--cwd` 字样（今天 message 只有 "(cwd)"，无 flag 名）。
//   ② 模块级：runDispatch.js 导出 SessionReuseWorkspaceRequiredError 且该路径抛其实例
//      （今天类不存在）。
//
// fixture 后端选择：claude-code（无 provider.apiKeyEnv）→ requiredCredentialNames 为空
// → credential preflight 判 not_required，不会先死于 CredentialMissingError
// （credential preflight 先于 cwd 检查）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** 无凭证要求的 sessionReuse agent registry fixture（claude-code，无 provider）。 */
function writeReuseRegistry(dir) {
  const registryPath = join(dir, "agents.json");
  writeFileSync(registryPath, JSON.stringify({
    agents: {
      researcher: {
        backend: "claude-code",
        binary: "fake-claude",
        cwd: dir,
        model: { id: "glm-5.2" },
        sessionReuse: "lead_workspace",
      },
    },
  }), "utf8");
  return registryPath;
}

test("TD-110: background 派发 sessionReuse agent 无 --cwd → 非零退出 + stderr 含原拒绝文案与 --cwd 指引", () => {
  const dir = makeTempDir("wao-reuse-cwd-cli-");
  try {
    const registryPath = writeReuseRegistry(dir);
    const runDir = join(dir, "runs");
    mkdirSync(runDir, { recursive: true });

    const r = spawnSync(process.execPath, [
      "src/cli.js", "run", "researcher",
      "--prompt", "x",
      "--background",
      "--registry", registryPath,
      "--run-dir", runDir,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1" },
      timeout: 60_000,
    });

    assert.notEqual(r.status, 0, "拒绝必须非零退出");
    assert.match(
      r.stderr,
      /bound workspace \(cwd\) is required for a sessionReuse agent/,
      "stderr 保留原闭集原因文案（不重写）",
    );
    assert.match(r.stderr, /--cwd/, "stderr 附带一行含 --cwd flag 的静态指引");
  } finally {
    cleanupDir(dir);
  }
});

test("TD-110: runDispatch 导出 SessionReuseWorkspaceRequiredError，无 cwd 拒绝抛其实例", async () => {
  const dir = makeTempDir("wao-reuse-cwd-mod-");
  try {
    const registryPath = writeReuseRegistry(dir);
    const runDir = join(dir, "runs");

    const mod = await import("../src/application/runDispatch.js");
    assert.equal(
      typeof mod.SessionReuseWorkspaceRequiredError, "function",
      "typed error 类必须导出（同文件既有 CredentialMissingError/ReuseBusyError 先例）",
    );

    const fakeSpawn = () => ({ unref() {} });
    await assert.rejects(
      () => mod.dispatchRun({
        agentId: "researcher",
        prompt: "q",
        registryPath,
        runDir,
        leadSession: "lead-A", // CLI 每次派发注入的一次性 Lead session（必给）
        // 无 cwd —— 触发目标拒绝
        spawnFn: fakeSpawn,
      }),
      (error) => {
        assert.ok(
          error instanceof mod.SessionReuseWorkspaceRequiredError,
          "抛出的是 SessionReuseWorkspaceRequiredError 实例",
        );
        assert.equal(error.name, "SessionReuseWorkspaceRequiredError");
        assert.match(error.message, /bound workspace \(cwd\) is required for a sessionReuse agent/);
        return true;
      },
      "sessionReuse 无 cwd 的派发必须以 typed error 拒绝（零 transcript、零 fork）",
    );
  } finally {
    cleanupDir(dir);
  }
});
