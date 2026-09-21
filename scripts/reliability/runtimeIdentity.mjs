// scripts/reliability/runtimeIdentity.mjs
//
// ADR-0032 批次（2026-09-21）：组件层认证入口的【被测 harness 运行时身份】探测。
//
// 纪律：
//   - 一次 spawn：每个被测 backend 恰好一次 `<binary> --version`（零新依赖，
//     node: 内置 child_process）。
//   - 探测实际执行前缀：agent.binary 优先，agent.prependArgs 作为版本命令的
//     argv 前缀；与 ProcessBackend._resolveAndBuildArgs 的配置优先级一致。
//   - 本表是 harness 身份元数据（哪个 CLI 二进制实现该 backend），【不是】能力
//     判定——"不按 runtime 名字分支"的纪律约束能力语义判定源
//     （backendCapabilitySnapshot SSOT），不约束身份探针的寻址。
//   - 只做 advisory/stale 可见性：指纹进组件键
//     （backend:<name>@<codeRef>#<runtimeFingerprint>），版本漂移 → 历史记录降
//     runtime-drifted advisory「建议重跑」；不进认证门、不加 registry schema
//     字段、不新增依赖（ADR-0032 Consequences）。
//   - 身份不可验证时明确 verified:false；指纹按探测目标稳定派生，避免每次运行
//     制造新键。稳定键只表示“同一未验证目标”，绝不表示运行时已经验证。
//   - opencode-serve 是 HTTP 服务 backend：无本地 harness 二进制可探 → honest
//     unknown（runtime 身份是 serve 部署，不经 --version 可知）。

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
// 复用 backend 家族的 Windows 命令脚本包裹纪律（.cmd/.bat 必须 ComSpec /d /s /c
// verbatim 包裹——直接 spawn .cmd 在 Node 上 EINVAL）。compileInvocation 是
// processBackend 导出的纯 kernel。
import { compileInvocation } from "../../src/backends/processBackend.js";

// 被测 harness 的版本探针描述（键 = WAO backend 名 → 值 = 发行版 CLI 寻址）。
const configuredBinary = (fallback) => (agent) => agent?.binary ?? fallback;

// 所有 process backend 都遵守 agent.binary 优先级；prependArgs 由探测函数
// 保留，确保 node/wrapper 形态探测实际 CLI 产物而不是 PATH 同名命令。
export const HARNESS_VERSION_PROBES = Object.freeze({
  "claude-code": Object.freeze({ distribution: "claude", binary: configuredBinary("claude") }),
  "codex": Object.freeze({ distribution: "codex", binary: configuredBinary("codex") }),
  "kimi-code": Object.freeze({ distribution: "kimi", binary: configuredBinary("kimi") }),
  "deepseek-acp": Object.freeze({ distribution: "dsh", binary: configuredBinary("dsh") }),
  "deepseek-harness": Object.freeze({ distribution: "dsh-jsonrpc-agent", binary: configuredBinary("dsh-jsonrpc-agent") }),
  // opencode-serve：HTTP 服务——无本地二进制；探测恒 honest unknown。
  "opencode-serve": null,
});

const UNKNOWN_REASON_BY_BACKEND = Object.freeze({
  "opencode-serve": "HTTP service backend — no local harness binary to probe; the runtime identity is the serve deployment, not discoverable via --version",
});

function identityHash(parts) {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

function unknownIdentity(distribution, reason, targetParts, binaryPath = null) {
  return {
    distribution,
    version: null,
    binaryPath,
    fingerprint: `unverified-v1-${identityHash(targetParts)}`,
    verified: false,
    reason,
  };
}

// Windows 裸名解析：where.exe（exe > cmd > bat > 首行——ProcessBackend.resolveBinary
// 同款排序纪律）；非 win32 / 解析失败原样返回裸名（spawn ENOENT 由探测结果承载）。
function resolveBareBinary(name, platform) {
  if (platform !== "win32") return name;
  if (/[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) return name;
  try {
    const output = execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
    const paths = output.split(/\r?\n/).filter(Boolean);
    const ranked = paths.find((value) => value.toLowerCase().endsWith(".exe"))
      ?? paths.find((value) => value.toLowerCase().endsWith(".cmd"))
      ?? paths.find((value) => value.toLowerCase().endsWith(".bat"))
      ?? paths[0];
    return ranked || name;
  } catch {
    return name;
  }
}

/**
 * 探测一个被测 backend 的 harness 运行时身份（一次 spawn）。
 *
 * @param {object} input
 * @param {string} input.backendName — WAO backend 名（HARNESS_VERSION_PROBES 键）
 * @param {object|null} [input.agent] — 被测 anchor 的 registry 条目（读取
 *   agent.binary 与 agent.prependArgs，和实际 process invocation 同优先级）
 * @param {{binary:string,args:string[]}|null} [input.resolvedInvocation] — backend
 *   解析出的真实 executable + argv prefix；提供时优先于描述符 fallback
 * @param {Function} [input.spawnFn] — spawn 注入缝（测试确定性；缺省 spawnSync）
 * @returns {{distribution: string|null, version: string|null, binaryPath: string|null,
 *   fingerprint: string, verified: boolean, reason?: string}} fingerprint 恒非空
 */
export function probeRuntimeIdentity({ backendName, agent = null, resolvedInvocation = null, spawnFn = spawnSync } = {}) {
  const probe = HARNESS_VERSION_PROBES[backendName];
  if (probe === undefined) {
    return unknownIdentity(null, `no harness probe descriptor for backend ${JSON.stringify(backendName)} — runtime identity unprobed`, ["backend", String(backendName)]);
  }
  if (probe === null) {
    return unknownIdentity(backendName, UNKNOWN_REASON_BY_BACKEND[backendName] ?? "no local harness binary for this backend", ["backend", String(backendName)]);
  }
  const bare = resolvedInvocation?.binary ?? probe.binary(agent);
  const binaryPath = resolveBareBinary(bare, process.platform);
  const rawPrependArgs = Array.isArray(resolvedInvocation?.args)
    ? resolvedInvocation.args
    : agent?.prependArgs;
  const prependArgs = Array.isArray(rawPrependArgs) ? rawPrependArgs.map(String) : [];
  const versionArgs = [...prependArgs, "--version"];
  const targetParts = [probe.distribution, binaryPath, JSON.stringify(prependArgs)];
  // .cmd/.bat 走 ComSpec verbatim 包裹（compileInvocation 纯 kernel）；其余直发。
  const compiled = compileInvocation({ binary: binaryPath, builtArgs: versionArgs, platform: process.platform });
  let r;
  try {
    r = spawnFn(compiled.binary, compiled.args, {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      windowsVerbatimArguments: compiled.windowsVerbatimArguments,
    });
  } catch (error) {
    return unknownIdentity(probe.distribution, `version probe spawn failed for ${binaryPath}: ${error?.message ?? error}`, targetParts, binaryPath);
  }
  const firstLine = String(r?.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
  if (r?.error || r?.status !== 0 || firstLine === null) {
    return unknownIdentity(
      probe.distribution,
      `version probe did not yield a version (exit=${r?.status ?? "?"}, error=${r?.error?.message ?? "none"}, stdout empty=${firstLine === null}) for ${binaryPath}`,
      targetParts,
      binaryPath,
    );
  }
  const version = firstLine.slice(0, 120);
  const fingerprintParts = [probe.distribution, version, binaryPath];
  if (prependArgs.length > 0) fingerprintParts.push(JSON.stringify(prependArgs));
  const fingerprint = `v1-${identityHash(fingerprintParts)}`;
  return { distribution: probe.distribution, version, binaryPath, fingerprint, verified: true, reason: null };
}
