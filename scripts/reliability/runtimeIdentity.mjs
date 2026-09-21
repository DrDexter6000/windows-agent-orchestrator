// scripts/reliability/runtimeIdentity.mjs
//
// ADR-0032 批次（2026-09-21）：组件层认证入口的【被测 harness 运行时身份】探测。
//
// 纪律：
//   - 一次 spawn：每个被测 backend 恰好一次 `<binary> --version`（零新依赖，
//     node: 内置 child_process）。
//   - 探测的是【harness 发行版】（claude / codex / kimi / dsh / dsh-jsonrpc-agent
//     的已安装版本），不是 agent 级包装调用（wrapper/node 垫片不改发行版身份）。
//   - 本表是 harness 身份元数据（哪个 CLI 二进制实现该 backend），【不是】能力
//     判定——"不按 runtime 名字分支"的纪律约束能力语义判定源
//     （backendCapabilitySnapshot SSOT），不约束身份探针的寻址。
//   - 只做 advisory/stale 可见性：指纹进组件键
//     （backend:<name>@<codeRef>#<runtimeFingerprint>），版本漂移 → 历史记录降
//     runtime-drifted advisory「建议重跑」；不进认证门、不加 registry schema
//     字段、不新增依赖（ADR-0032 Consequences）。
//   - 两个 unknown 不得当作同一运行时：探测失败的指纹是每次唯一的
//     unknown-<random>——两次失败永不相等，绝不合并/互相刷新。
//   - opencode-serve 是 HTTP 服务 backend：无本地 harness 二进制可探 → honest
//     unknown（runtime 身份是 serve 部署，不经 --version 可知）。

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
// 复用 backend 家族的 Windows 命令脚本包裹纪律（.cmd/.bat 必须 ComSpec /d /s /c
// verbatim 包裹——直接 spawn .cmd 在 Node 上 EINVAL）。compileInvocation 是
// processBackend 导出的纯 kernel。
import { compileInvocation } from "../../src/backends/processBackend.js";

// 被测 harness 的版本探针描述（键 = WAO backend 名 → 值 = 发行版 CLI 寻址）。
// agent.binary 覆盖只对 dsh 家族生效（与 deepSeekAcp/deepSeekHarness 的
// _compileInvocation 同一优先级）；其余家族的发行版名固定。
export const HARNESS_VERSION_PROBES = Object.freeze({
  "claude-code": Object.freeze({ distribution: "claude", binary: () => "claude" }),
  "codex": Object.freeze({ distribution: "codex", binary: () => "codex" }),
  "kimi-code": Object.freeze({ distribution: "kimi", binary: () => "kimi" }),
  "deepseek-acp": Object.freeze({ distribution: "dsh", binary: (agent) => agent?.binary ?? "dsh" }),
  "deepseek-harness": Object.freeze({ distribution: "dsh-jsonrpc-agent", binary: (agent) => agent?.binary ?? "dsh-jsonrpc-agent" }),
  // opencode-serve：HTTP 服务——无本地二进制；探测恒 honest unknown。
  "opencode-serve": null,
});

const UNKNOWN_REASON_BY_BACKEND = Object.freeze({
  "opencode-serve": "HTTP service backend — no local harness binary to probe; the runtime identity is the serve deployment, not discoverable via --version",
});

function unknownIdentity(distribution, reason, randomFn) {
  return {
    distribution,
    version: null,
    binaryPath: null,
    // 每次唯一的 unknown 指纹：两个 unknown 永不相等（不当作同一运行时）。
    fingerprint: `unknown-${randomFn()}`,
    reason,
  };
}

// Windows 裸名解析：where.exe（exe > cmd > bat > 首行——ProcessBackend.resolveBinary
// 同款排序纪律）；非 win32 / 解析失败原样返回裸名（spawn ENOENT 由探测结果承载）。
function resolveBareBinary(name, platform) {
  if (platform !== "win32") return name;
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
 * @param {object|null} [input.agent] — 被测 anchor 的 registry 条目（dsh 家族读
 *   agent.binary 覆盖）
 * @param {Function} [input.spawnFn] — spawn 注入缝（测试确定性；缺省 spawnSync）
 * @param {Function} [input.randomFn] — unknown 指纹随机源注入缝（缺省 8 字节 hex）
 * @returns {{distribution: string|null, version: string|null, binaryPath: string|null,
 *   fingerprint: string, reason?: string}} fingerprint 恒非空（known = v1-<hash12>，
 *   unknown = unknown-<random>）
 */
export function probeRuntimeIdentity({ backendName, agent = null, spawnFn = spawnSync, randomFn = () => randomBytes(8).toString("hex") } = {}) {
  const probe = HARNESS_VERSION_PROBES[backendName];
  if (probe === undefined) {
    return unknownIdentity(null, `no harness probe descriptor for backend ${JSON.stringify(backendName)} — runtime identity unprobed`, randomFn);
  }
  if (probe === null) {
    return unknownIdentity(backendName, UNKNOWN_REASON_BY_BACKEND[backendName] ?? "no local harness binary for this backend", randomFn);
  }
  const bare = probe.binary(agent);
  const binaryPath = resolveBareBinary(bare, process.platform);
  // .cmd/.bat 走 ComSpec verbatim 包裹（compileInvocation 纯 kernel）；其余直发。
  const compiled = compileInvocation({ binary: binaryPath, builtArgs: ["--version"], platform: process.platform });
  let r;
  try {
    r = spawnFn(compiled.binary, compiled.args, {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      windowsVerbatimArguments: compiled.windowsVerbatimArguments,
    });
  } catch (error) {
    return unknownIdentity(probe.distribution, `version probe spawn failed for ${binaryPath}: ${error?.message ?? error}`, randomFn);
  }
  const firstLine = String(r?.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
  if (r?.error || r?.status !== 0 || firstLine === null) {
    return unknownIdentity(
      probe.distribution,
      `version probe did not yield a version (exit=${r?.status ?? "?"}, error=${r?.error?.message ?? "none"}, stdout empty=${firstLine === null}) for ${binaryPath}`,
      randomFn,
    );
  }
  const version = firstLine.slice(0, 120);
  const fingerprint = `v1-${createHash("sha256")
    .update(`${probe.distribution}\n${version}\n${binaryPath}`)
    .digest("hex")
    .slice(0, 16)}`;
  return { distribution: probe.distribution, version, binaryPath, fingerprint };
}
