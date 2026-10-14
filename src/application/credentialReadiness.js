// src/application/credentialReadiness.js
//
// M11-7 (CTO closeout): Worker credential availability + Windows user-env bridge.
//
// Assesses whether a worker's REQUIRED credentials (registry-declared via
// provider.apiKeyEnv / legacy --api-key-env) are available in the launching
// environment, and bridges values from the Windows Current-User scope into the
// worker child process when they are absent from process.env.
//
// 决定 0074 补充：kimi-web 车道声明 kimiHome 时，凭据面是 <kimiHome>/server.token
// 文件而非环境变量——kimiHomeTokenFileState 是"文件在且非空"的单一判定，
// alignReadinessToKimiTokenFile 把展示面取值对齐到它（详见两函数 docblock）。
//
// Env-name policy (which names are required vs optional-inherited) is the
// runtime-neutral SSOT in src/envPolicy.js — this module delegates to it. There
// is no mirrored algorithm here or in src/backends/*.
//
// Credential resolution precedence:
//   1. process.env (the WAO process environment).
//   2. Windows Current-User environment (HKCU\Environment).
//   3. missing.
//
// No permanent cache: each operation de-duplicates by name within itself, but
// the NEXT registry_list/dispatch re-observes current state — so setting or
// rotating a credential takes effect without restarting the Host.
//
// Security contract:
//   - Only the EXACT declared names are read from the user scope. No bulk
//     import of the user environment.
//   - No credential VALUE enters argv, logs, errors, transcript, or MCP output.
//     Values flow only into the worker child env + the secret redactor.
//   - Structured argv (base64-encoded PowerShell command); injectable reader.
//
// Honesty: this module only proves a CREDENTIAL blocker, not that the runtime
// is executable/logged-in/provider-healthy. The field is named
// credentialAvailability, not "runtime readiness".
//
// Architectural contract: no src/mcp/*, src/commands/*, MCP SDK, or zod imports.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { requiredCredentialNames, inheritedEnvNames, kimiServerTokenFile } from "../envPolicy.js";

/**
 * Re-export the env-name policy SSOT for convenience/compat.
 * requiredCredentialNames: registry-declared REQUIRED names (gate participants).
 * inheritedEnvNames: all names a backend MAY inherit (required + optional).
 */
export { requiredCredentialNames, inheritedEnvNames };

/**
 * 多凭据名探测源聚合为单一 key 态（TD-258：doctor 与 onboarding 共用的唯一
 * 实现——claude-code 的 provider.apiKeyEnv 加 --api-key-env prependArgs 可能
 * 出现多名，聚合语义不得在两个消费面各写一份）。
 *
 * @param {Array<"process_env"|"user_env"|"missing"|"unknown">} sources — 非空数组
 * @returns {"process_env"|"user_env"|"missing"|"unknown"} 全 process_env=process_env；
 *   任一 missing=missing；其余 process/user 混合=user_env；否则 unknown。
 */
export function aggregateCredentialSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return "unknown";
  if (sources.every((s) => s === "process_env")) return "process_env";
  if (sources.includes("missing")) return "missing";
  if (sources.every((s) => s === "process_env" || s === "user_env")) return "user_env";
  return "unknown";
}

/**
 * TD-256（2026-10-11）：三态、分作用域的 Windows env 读器（registry env 读取的
 * 单一实现——doctor 门禁可见性检查用）。
 *
 * 与 readWindowsUserEnv 的契约差异（为什么需要第二个形态）：旧读器把"读取失败"
 * 与"确认缺席"都折叠成 undefined——对凭据面这是刻意的 fail-safe（不回显、不放大），
 * 但可见性检查必须区分三态（在值/确认缺席/读取失败），否则"查不到"会被误读成
 * "没设置"。scope 参数复用 PowerShell 同一原语：'User'（HKCU\Environment）或
 * 'Machine'（HKLM Session Manager\Environment）。
 *
 * 值纪律不变：返回形状只带 status 与派生语义（isOn：值==="1"——与 MCP 门禁
 * 判定同款），绝不含原始值。
 * @param {string} name
 * @param {"User"|"Machine"} scope
 * @returns {Promise<{status:"value",isOn:boolean}|{status:"absent"}|{status:"failed"}|{status:"unsupported"}>}
 */
export function readWindowsEnvScoped(name, scope = "User") {
  if (process.platform !== "win32") return Promise.resolve({ status: "unsupported" });
  if (typeof name !== "string" || name.length === 0) return Promise.resolve({ status: "failed" });
  if (scope !== "User" && scope !== "Machine") return Promise.resolve({ status: "failed" });
  return new Promise((resolve) => {
    const safeName = name.replace(/'/g, "''");
    const script = `[System.Environment]::GetEnvironmentVariable('${safeName}', '${scope}')`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve({ status: "failed" });
        const value = (stdout ?? "").replace(/\r?\n$/, "");
        if (value.length === 0) return resolve({ status: "absent" });
        resolve({ status: "value", isOn: value === "1" });
      },
    );
  });
}

/**
 * Default Windows user-env reader. Reads ONE exact name from the Current-User
 * scope via PowerShell `[System.Environment]::GetEnvironmentVariable`. Structured
 * argv (no shell string). On non-Windows or any failure → undefined.
 *
 * NOT permanently cached: a fresh value is read on every call so credential
 * rotation / addition takes effect without a Host restart. Callers de-duplicate
 * within a single operation (assessWorkerReadiness) to avoid re-reading the same
 * name twice in one assessment.
 * @param {string} name
 * @returns {Promise<string|undefined>}
 */
export function readWindowsUserEnv(name) {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  if (typeof name !== "string" || name.length === 0) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const script = `[System.Environment]::GetEnvironmentVariable('${name.replace(/'/g, "''")}', 'User')`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(undefined);
        const value = (stdout ?? "").replace(/\r?\n$/, "");
        resolve(value.length > 0 ? value : undefined);
      },
    );
  });
}

/**
 * Resolve a single env var: process.env first, then Windows user env.
 * @param {string} name
 * @param {{ userEnvReader?: (name: string) => Promise<string|undefined> }} [opts]
 * @returns {Promise<{ name: string, source: "process_env"|"user_env"|"missing", value: string|undefined }>}
 */
export async function resolveCredentialEnv(name, opts = {}) {
  const procValue = process.env[name];
  if (typeof procValue === "string" && procValue.length > 0) {
    return { name, source: "process_env", value: procValue };
  }
  const reader = opts.userEnvReader ?? readWindowsUserEnv;
  try {
    const userValue = await reader(name);
    if (typeof userValue === "string" && userValue.length > 0) {
      return { name, source: "user_env", value: userValue };
    }
  } catch {
    // reader failure → treat as missing (never surface the value or error).
  }
  return { name, source: "missing", value: undefined };
}

/**
 * A sentinel value used in tests to prove a credential value never appears in
 * any projection. Not a real credential.
 */
export const CREDENTIAL_SENTINEL = "M117_CREDENTIAL_SENTINEL_VALUE";

/**
 * An operation-scoped env resolver. Created once per inventory/dispatch/start/
 * resume operation. Caches each resolved name (including "missing") for the
 * lifetime of the operation, so two workers sharing an env name read it at most
 * ONCE per operation. Discarded when the operation ends (no cross-operation
 * cache) — credential rotation/addition takes effect on the next operation
 * without a Host restart.
 *
 * Create via createEnvResolver(); do not construct directly.
 */
export class EnvResolver {
  constructor(userEnvReader) {
    this._reader = userEnvReader ?? readWindowsUserEnv;
    this._cache = new Map();
    this.readerCallCount = 0;
    this.readerCallsByName = {};
  }

  /**
   * Resolve one env name through this operation's cache.
   * @param {string} name
   * @returns {Promise<{ name: string, source: "process_env"|"user_env"|"missing", value: string|undefined }>}
   */
  async resolve(name) {
    if (this._cache.has(name)) return this._cache.get(name);
    const r = await resolveCredentialEnv(name, { userEnvReader: this._reader });
    this.readerCallCount += 1;
    this.readerCallsByName[name] = (this.readerCallsByName[name] ?? 0) + 1;
    this._cache.set(name, r);
    return r;
  }
}

/**
 * Create a fresh operation-scoped env resolver. Each call returns an independent
 * resolver with its own cache — so the next registry_list/dispatch/start/resume
 * re-observes current state.
 * @param {(name: string) => Promise<string|undefined>} [userEnvReader]
 * @returns {EnvResolver}
 */
export function createEnvResolver(userEnvReader) {
  return new EnvResolver(userEnvReader);
}

/**
 * Assess a single worker's CREDENTIAL availability (not full runtime health).
 * - "available": all REQUIRED declared credentials resolve (process.env or user env).
 * - "missing":  at least one REQUIRED credential is absent.
 * - "not_required": the worker declares no required credential (no gate applies).
 *
 * @param {object} input
 * @param {object} input.agent — normalized agent from registry
 * @param {EnvResolver} [input.resolver] — operation-scoped resolver (shared across
 *   workers in one inventory/dispatch). If omitted, a single-use resolver is
 *   created (no cross-worker de-dupe, but still no permanent cache).
 * @param {string[]} [input.names] — which env names to resolve. Defaults to the
 *   REQUIRED names only (for registry_list). Pass inheritedEnvNames(agent) to
 *   also bridge optional inherited env (for dispatch/start/resume).
 * @returns {Promise<{ credentialAvailability: "available"|"missing"|"not_required", missingCredentialEnvNames: string[], resolvedEnv: Record<string,string> }>}
 *   resolvedEnv carries the resolved VALUES for names that resolved. It MUST NOT
 *   be logged/serialized.
 */
export async function assessWorkerReadiness({ agent, resolver, names }) {
  const required = requiredCredentialNames(agent);
  // Default: resolve only required names (registry_list path — cheap). Callers
  // that need to bridge optional inherited env pass names explicitly.
  const toResolve = names ?? required;
  const envResolver = resolver ?? createEnvResolver();
  const resolvedEnv = {};
  const missing = [];
  for (const name of toResolve) {
    const r = await envResolver.resolve(name);
    if (typeof r.value === "string") resolvedEnv[name] = r.value;
    if (required.includes(name) && r.source === "missing") missing.push(name);
  }
  const credentialAvailability = required.length === 0
    ? "not_required"
    : (missing.length > 0 ? "missing" : "available");
  return { credentialAvailability, missingCredentialEnvNames: missing, resolvedEnv };
}

/**
 * 决定 0074（车道就绪事实如实呈现）："token 文件在且去首尾空白后非空"的单一
 * 判定。声明了 kimiHome 的 kimi-web 车道，凭据是 <kimiHome>/server.token 文件
 * 而非环境变量——registry_list 的 credentialAvailability 取值、wao lanes /
 * onboarding 的就绪探测、wao doctor 的体检都经本函数；派发侧
 * kimiWeb.resolveBearerToken 同款语义（读失败按缺失处理——fail-closed，缺失或
 * 为空在建会话之前拒绝派发）。只报状态，绝不回显文件内容。
 *
 * @param {string} tokenFile — kimiServerTokenFile(agent) 的返回值（非 null）
 * @param {(p: string) => Promise<string>} [readFileFn] — 注入式读取器（测试用）
 * @returns {Promise<"present"|"missing">}
 */
export async function kimiHomeTokenFileState(tokenFile, readFileFn) {
  const read = readFileFn ?? ((p) => readFile(p, "utf8"));
  let raw;
  try {
    raw = await read(tokenFile);
  } catch {
    return "missing";
  }
  return typeof raw === "string" && raw.trim().length > 0 ? "present" : "missing";
}

/**
 * 把 assessWorkerReadiness 的结果对齐到决定 0074 的 token 文件事实（取值面专用）：
 * 车道声明了 kimiHome 时，credentialAvailability 改由 token 文件是否在且非空决定
 * （present→"available"，missing→"missing"）；missingCredentialEnvNames 保持空表
 * （无环境变量涉及），resolvedEnv 原样保留。非 kimiHome 车道结果原样返回。
 * 派发门不经此函数——派发侧由 kimiWeb backend 建会话前以同款判定拒绝。
 *
 * @param {object} agent — normalized/raw agent（backend+kimiHome 可判即可）
 * @param {{ credentialAvailability: string, missingCredentialEnvNames: string[], resolvedEnv: object }} readiness
 * @param {(p: string) => Promise<string>} [readFileFn]
 * @returns {Promise<typeof readiness>}
 */
export async function alignReadinessToKimiTokenFile(agent, readiness, readFileFn) {
  const tokenFile = kimiServerTokenFile(agent);
  if (tokenFile === null) return readiness;
  const state = await kimiHomeTokenFileState(tokenFile, readFileFn);
  return { ...readiness, credentialAvailability: state === "present" ? "available" : "missing" };
}
