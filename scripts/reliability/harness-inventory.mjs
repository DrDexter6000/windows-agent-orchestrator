// scripts/reliability/harness-inventory.mjs
//
// harness 版本盘点一条命令（2026-11-23 第 138 批）：认证 runbook「harness 版本巡检」
// 前置盘点的发现入口——此前一轮盘点要手打十多条命令（逐 backend 探针 + 逐包
// npm dist-tag + 翻更新器日志），本命令一次跑完。
//
// 读什么（环境读取面纪律，docs/milestone-discipline.md §7）：本地侧读
// --registry 指定的注册表文件，【缺省 config/agents.json】——这是 Lead 的盘点
// 命令，缺省就读 live 注册表；测试与模板试跑一律显式 --registry 注入，绝不裸用
// 默认。官方最新侧：npm 发行的四个 backend 各一次对 npm 公共注册表 dist-tags
// 端点的 GET（Node 内置 fetch，不经 npm 进程——`npm view` 会读用户 .npmrc（可能
// 指向私有源并带凭据）、写 npm 缓存与日志，违背本命令"不读凭据、不写文件"的
// 只读边界）；zcode 不查网络，读本机 ZCode 更新器日志的最近一条结论。
//
// 只读边界：不升级、不写任何文件、不读凭据、不打印环境变量。本命令自建的
// 子进程（powershell 版本资源读取、版本探针）环境经 src/backends/processBackend.js
// 的共用内核 buildChildEnv([], {}, {}) 剥离——只继承 SAFE_INHERITED_ENV，
// 凭据类变量不进子进程；版本探针走共用 runtimeIdentity.mjs（其 spawn 语义
// 与真实派发同源，本命令不另写探测）。
//
// 用法：
//   npm run harness-inventory [-- --registry <file>] [-- --format text|json]
//
// 输出：一张表（backend、目标、本地版本、官方最新、结论、备注）；结论三档
// latest / behind / unknown（照 runbook 汇总口径：latest 不可探、身份未确认的
// 行不计入 latest，unknown 是合法结论）。--format json 给同样的事实。
// 注册表无席位的闭集 backend 也出一行（unknown，注明无配置席位——盘点覆盖面
// 不静默缩水）。
//
// 退出码：盘点完成 → 0（有 behind/unknown 也是 0）；用法错误 → 1；
// registry 文件不存在或读不出 → stderr 一行说明 + 1。

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

import { probeRuntimeIdentity, HARNESS_VERSION_PROBES } from "./runtimeIdentity.mjs";
import { backendFor } from "../../src/backends/factory.js";
import { buildChildEnv } from "../../src/backends/processBackend.js";
import { KNOWN_BACKENDS, readRegistry } from "../../src/registry.js";

// npm 发行的四个 backend 的官方包名（kimi 系官方包名以官方 docs 记载为准，
// repo 名 ≠ npm 包名——runbook「证据纪律·未发现≠未安装」条在册教训）。
const NPM_LATEST_SOURCES = Object.freeze({
  "claude-code": "@anthropic-ai/claude-code",
  "codex": "@openai/codex",
  "deepseek-acp": "@deepseek-ai/dsh",
  "kimi-web": "@moonshot-ai/kimi-code",
});

// 本地安装渠道声明（按 backend 闭集；新 backend 入册时补）。"npm" = 本地安装就是
// npm 发行（codex、deepseek-acp）——与官方 latest 同渠道，锚 latest 直接对照；
// "native" = 本地是 native 安装（claude-code 的 ~/.local/bin/claude.exe、kimi-web 的
// ~/.kimi-code/bin/kimi.exe）——npm 只是参照渠道，可比性见下一张映射。
const LOCAL_INSTALL_CHANNELS = Object.freeze({
  "claude-code": "native",
  "codex": "npm",
  "deepseek-acp": "npm",
  "kimi-web": "native",
});

// 已确认可比的跨渠道对照映射（runbook「证据纪律·参照渠道」条）：同一产品、同一
// 版本序列、安装渠道跟随该 npm tag——本仓库巡检记录一直这样对照（2026-11-22 巡检：
// claude-code 2.1.330、kimi 2.7.2 均按 npm latest 判 latest）。映射内的组合结论照常
// 给 latest/behind，备注标注可比已确认；不在映射里的跨渠道组合一律结论 unknown 并
// 写"参照渠道发布了 X，是否落后待确认"（不虚构可比性）。
const CROSS_CHANNEL_COMPARABLE = Object.freeze({
  "claude-code": Object.freeze({ source: "@anthropic-ai/claude-code", followTag: "latest" }),
  "kimi-web": Object.freeze({ source: "@moonshot-ai/kimi-code", followTag: "latest" }),
});

/**
 * 跨渠道判定（纯函数，可注入替换）：npm 渠道本地安装锚 latest 直接对照；
 * native 本地安装看已确认可比映射；映射外给 followTag:null + conclusive:false
 * （调用方在拿到最新版 X 后补"参照渠道发布了 X"注记并落 unknown）。
 */
export function crossChannelVerdict(backend) {
  const localChannel = LOCAL_INSTALL_CHANNELS[backend];
  const comparable = CROSS_CHANNEL_COMPARABLE[backend];
  if (localChannel === "npm") {
    return { followTag: "latest", note: null, conclusive: true };
  }
  if (comparable) {
    return {
      followTag: comparable.followTag,
      note: `本地 native 安装，官方最新取参照渠道 npm（${comparable.source}）——可比已确认（同产品、同版本序列、跟随 ${comparable.followTag}）`,
      conclusive: true,
    };
  }
  return { followTag: null, note: null, conclusive: false };
}

const ZCODE_UPDATER_LOGS_DIR = resolve(homedir(), ".zcode", "v2", "logs");
const ZCODE_PRODUCT_EXE_RELATIVE = ["..", "..", "ZCode.exe"]; // <ZCode>/resources/glm/zcode.cjs → <ZCode>/ZCode.exe
const UPDATER_LOG_FILES_TO_SCAN = 30;

function usage(stream) {
  stream.write(
    "Usage: npm run harness-inventory [-- --registry <agents.json>] [-- --format text|json]\n"
    + "  --registry  注册表路径；缺省读 live 注册表 config/agents.json（Lead 盘点命令）。\n"
    + "              测试与模板试跑必须显式注入（如 config/agents.example.json）。\n"
    + "  --format    text（缺省，人读表）或 json（同样的事实，机读）。\n"
    + "只读命令：本地按实际目标（backend × binary）去重探版本，官方最新查 npm\n"
    + "dist-tag latest（zcode 读本机更新器日志，不查网络）。结论三档 latest/behind/unknown。\n",
  );
}

export function parseArgs(argv) {
  const out = { registry: "config/agents.json", format: "text" };
  const valueOf = (flag, index) => {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...out, help: true };
    if (arg === "--registry") {
      out.registry = valueOf(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--format") {
      const value = valueOf(arg, i);
      if (value !== "text" && value !== "json") throw new Error(`--format must be text or json, got ${JSON.stringify(value)}`);
      out.format = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown flag: ${arg}`);
  }
  return out;
}

// ---- 版本比较（runbook：exe 四段式按前三段对照；dist-tag latest 可能本身是 rc）----

function parseVersionAt(text, start) {
  let i = start;
  const read = (re) => {
    const m = re.exec(text.slice(i));
    if (m === null) return null;
    i += m[0].length;
    return m;
  };
  const core = [];
  const first = read(/^\d+/);
  if (first === null) return null;
  core.push(Number(first[0]));
  while (i < text.length && text[i] === ".") {
    const seg = /^\d+/.exec(text.slice(i + 1));
    if (seg === null) break;
    core.push(Number(seg[0]));
    i += 1 + seg[0].length;
  }
  if (text[i] === "-") {
    i += 1;
    const pre = read(/^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*/);
    if (pre === null) return null;
    return { core, pre: pre[0].split(".") };
  }
  return { core, pre: null };
}

/** 从任意探针输出行里取第一个版本样 token（如 "2.1.330 (Claude Code)" → 2.1.330）。 */
export function extractVersion(text) {
  if (typeof text !== "string") return null;
  for (let i = 0; i < text.length; i += 1) {
    if (!/\d/.test(text[i])) continue;
    const parsed = parseVersionAt(text, i);
    if (parsed !== null && parsed.core.length >= 2) {
      return { core: parsed.core, pre: parsed.pre };
    }
  }
  return null;
}

function cmpIdentifiers(a, b) {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1; // semver：数字标识 < 字母标识
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 前三段核心比较（缺段补 0）+ 预发布序。exe 四段式与 changelog/更新器三段式按前三段对照
 * （runbook 在册口径：4.0.0.10870 对 4.0.0 判等；第四段起的差异不进结论）。 */
export function compareParsedVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1; // 无预发布 > 有预发布
  if (b.pre === null) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const d = cmpIdentifiers(a.pre[i], b.pre[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/**
 * 结论三档：两侧都可解析且相等 → latest；都可解析但不等 → behind（本地 ≠
 * 官方头 tag，即 runbook「非 latest」档）；任一侧缺失/不可解析 → unknown。
 */
export function classifyConclusion(local, latest) {
  const a = local == null ? null : extractVersion(local);
  const b = latest == null ? null : extractVersion(latest);
  if (a === null || b === null) return "unknown";
  return compareParsedVersions(a, b) === 0 ? "latest" : "behind";
}

// ---- npm dist-tag 取值（纯逻辑）----

/**
 * dist-tag 取值（纯逻辑）。多 tag 规则（runbook「证据纪律·参照渠道」条）：
 * 调用方声明了 followTag（安装渠道实际跟随的 tag，如已确认可比映射里的 latest）
 * 时只比该 tag；否则锚 latest，stable/next 仅在与本地不同时附注（并列记录）。
 * latest/跟随 tag 缺失或本身是预发布（如 dsh）时给注记。
 */
export function selectDistTags(tags, localVersion, { followTag = null } = {}) {
  const notes = [];
  if (tags == null || typeof tags !== "object") {
    return { latest: null, notes: ["dist-tags 无 latest tag"] };
  }
  if (followTag !== null) {
    const value = tags[followTag];
    if (typeof value !== "string" || value.length === 0) {
      return { latest: null, notes: [`dist-tags 无 ${followTag} tag`] };
    }
    if (extractVersion(value)?.pre != null) {
      notes.push(`dist-tag ${followTag} 本身是预发布版本（${value}），照实记录`);
    }
    return { latest: value, notes };
  }
  if (typeof tags.latest !== "string" || tags.latest.length === 0) {
    return { latest: null, notes: ["dist-tags 无 latest tag"] };
  }
  const latest = tags.latest;
  if (extractVersion(latest)?.pre != null) {
    notes.push(`dist-tag latest 本身是预发布版本（${latest}），照实记录`);
  }
  const localParsed = localVersion == null ? null : extractVersion(localVersion);
  for (const tag of ["stable", "next"]) {
    const value = tags[tag];
    if (typeof value !== "string" || value.length === 0) continue;
    if (value === latest) continue;
    if (localParsed !== null && extractVersion(value) !== null && compareParsedVersions(localParsed, extractVersion(value)) === 0) continue;
    notes.push(`存在其他 tag ${tag}=${value}（与本地不同）`);
  }
  return { latest, notes };
}

// ---- ZCode 更新器日志解析（纯逻辑）----

/**
 * 识别两类更新结论行，返回 { kind, version, timestamp }；非结论行返回 null。
 * 形状（实测 2026-11-23）：
 *   [ts] [info] [pid:N] [main] Found version X (url: …)
 *   [ts] [info] [pid:N] [main] [auto-update] already up to date (local=L, remote=R)
 */
export function parseUpdaterLine(line) {
  if (typeof line !== "string") return null;
  const ts = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d+)?\]/);
  const timestamp = ts ? ts[1] : null;
  const found = line.match(/Found version (\S+)/);
  if (found) return { kind: "found", version: found[1], timestamp };
  const uptodate = line.match(/already up to date \(local=([^,)]+), remote=([^)]+)\)/);
  if (uptodate) return { kind: "up_to_date", version: uptodate[2].trim(), timestamp, local: uptodate[1].trim() };
  return null;
}

/** files = [{ name, content }]，按新→旧排序；取最新一份里最后一条结论（最近一条结论）。 */
export function selectUpdaterConclusion(files) {
  for (const file of files) {
    const lines = String(file.content ?? "").split(/\r?\n/);
    let last = null;
    for (const line of lines) {
      const parsed = parseUpdaterLine(line);
      if (parsed !== null) last = parsed;
    }
    if (last !== null) return { ...last, logFile: file.name };
  }
  return null;
}

// ---- ZCode 更新器日志读取（真实 IO，可注入替换）----

export function readZcodeUpdaterConclusion(logsDir = ZCODE_UPDATER_LOGS_DIR) {
  if (!existsSync(logsDir)) return { conclusion: null, reason: `更新器日志目录不存在: ${logsDir}` };
  let names;
  try {
    names = readdirSync(logsDir).filter((n) => n.endsWith(".log")).sort().reverse();
  } catch (error) {
    return { conclusion: null, reason: `更新器日志目录不可读: ${error?.message ?? error}` };
  }
  for (const name of names.slice(0, UPDATER_LOG_FILES_TO_SCAN)) {
    let content;
    try {
      content = readFileSync(resolve(logsDir, name), "utf8");
    } catch (error) {
      return { conclusion: null, reason: `日志 ${name} 不可读: ${error?.message ?? error}` };
    }
    const conclusion = selectUpdaterConclusion([{ name, content }]);
    if (conclusion !== null) return { conclusion, reason: null };
  }
  return { conclusion: null, reason: `最近 ${Math.min(names.length, UPDATER_LOG_FILES_TO_SCAN)} 份日志无更新检查记录` };
}

// ---- 本命令自建子进程的剥离环境（共用内核；凭据类变量不进子进程）----

function strippedEnv() {
  return buildChildEnv([], {}, {});
}

// 探针 spawn 包装：保持 probeRuntimeIdentity 的 spawn 语义，只替换 env 为剥离面。
function probeSpawnFn(binary, args, opts = {}) {
  return spawnSync(binary, args, { ...opts, env: strippedEnv() });
}

/**
 * npm 公共注册表 dist-tags 查询：Node 内置 fetch 直接 GET
 * `https://registry.npmjs.org/-/package/<包名>/dist-tags`（包名里的 `/` 按 URL
 * 编码），15s 超时。【不经 npm 进程】——`npm view` 会读用户 .npmrc（可能指向私有
 * 源并带凭据）、写 npm 缓存与日志，违背本命令只读边界。失败/离线是事实记录
 * （unknown + 原因），不是命令失败。
 */
export async function npmDistTags(pkg, { fetchFn = fetch } = {}) {
  const url = `https://registry.npmjs.org/-/package/${pkg.replace(/\//g, "%2F")}/dist-tags`;
  let response;
  try {
    response = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return { tags: null, reason: `npm 注册表查询失败: ${error?.message ?? error}` };
  }
  if (!response?.ok) {
    return { tags: null, reason: `npm 注册表查询 HTTP ${response?.status ?? "?"}` };
  }
  try {
    return { tags: await response.json(), reason: null };
  } catch {
    return { tags: null, reason: "dist-tags 响应不是合法 JSON" };
  }
}

/** Windows exe 的 VS VersionInfo.ProductVersion（zcode 产品版本锚，runbook：以主 exe 为准）。 */
export function readExeProductVersion(exePath, { spawnFn = spawnSync } = {}) {
  if (typeof exePath !== "string" || exePath.length === 0 || !existsSync(exePath)) {
    return { version: null, reason: `主程序不存在: ${exePath ?? "(未解析)"}` };
  }
  const command = `(Get-Item -LiteralPath '${exePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`;
  const r = spawnFn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
    env: strippedEnv(),
  });
  if (r?.error || r?.status !== 0) {
    return { version: null, reason: `VersionInfo 读取失败（exit=${r?.status ?? "?"}）` };
  }
  const line = String(r?.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? null;
  if (line === null || extractVersion(line) === null) {
    return { version: null, reason: "VersionInfo 无可解析版本" };
  }
  return { version: line, reason: null };
}

export function sha256First12(filePath) {
  try {
    return { hash: createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 12), reason: null };
  } catch (error) {
    return { hash: null, reason: `sha256 读取失败: ${error?.message ?? error}` };
  }
}

// ---- 盘点编排（探针/查询/日志/版本资源全部可注入，测试不触真实网络与 binary）----

// Windows 裸名解析：where.exe 单名解析（exe > cmd > bat > 首行）。与
// scripts/reliability/runtimeIdentity.mjs 的 resolveBareBinary 同款纪律——该文件
// 未导出此函数，此处按同款规则实现，两处同步维护；带分隔符/盘符的原样返回，
// 非 win32 原样返回。
function resolveBareName(name, { execFileFn = execFileSync } = {}) {
  if (process.platform !== "win32") return name;
  if (typeof name !== "string" || name.length === 0 || /[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) return name;
  try {
    const output = execFileFn("where.exe", [name], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const paths = String(output ?? "").split(/\r?\n/).filter(Boolean);
    const ranked = paths.find((p) => p.toLowerCase().endsWith(".exe"))
      ?? paths.find((p) => p.toLowerCase().endsWith(".cmd"))
      ?? paths.find((p) => p.toLowerCase().endsWith(".bat"))
      ?? paths[0];
    return ranked || name;
  } catch {
    return name; // 未命中落裸名（ENOENT 由探针结果如实承载）
  }
}

// 分组键的路径规范化：Windows 路径大小写不敏感、分隔符两形同指——统一小写 + 正斜杠，
// 裸名解析出的绝对路径与配置里手写的同一路径才落同一键。
function normalizeTargetKey(p) {
  const s = String(p ?? "");
  return process.platform === "win32" ? s.replace(/\\/g, "/").toLowerCase() : s;
}

async function defaultResolveInvocation(config) {
  try {
    const impl = backendFor(config);
    if (typeof impl?.resolveInvocationPrefix === "function") {
      return await impl.resolveInvocationPrefix(config);
    }
  } catch {
    // honest unknown 兜底（与 runtime-identity-cli 同款）：解析失败落描述符 fallback。
  }
  return null;
}

/**
 * 把 registry 席位按【解析后的实际目标】去重分组（runbook 硬规则：证据单位是
 * 实际安装，不是配置写法）——每组键 = backend × (解析后的 binary 绝对路径规范化
 * + argv 前缀)。裸名与绝对路径指向同一 binary 时合并为一行，每组只探一次。
 */
export async function dedupeTargets(seatEntries, { resolveInvocationFn, resolveBareFn } = {}) {
  const resolveInvocation = resolveInvocationFn ?? defaultResolveInvocation;
  const resolveBare = resolveBareFn ?? resolveBareName;
  const groups = [];
  const byKey = new Map();
  for (const [id, config] of seatEntries) {
    const backend = config?.backend;
    if (typeof backend !== "string" || backend.length === 0) continue;
    const resolvedInvocation = await resolveInvocation(config);
    const prefixArgs = Array.isArray(resolvedInvocation?.args)
      ? resolvedInvocation.args
      : (Array.isArray(config?.prependArgs) ? config.prependArgs : []);
    const bare = resolvedInvocation?.binary
      ?? config?.binary
      ?? HARNESS_VERSION_PROBES[backend]?.binary(config)
      ?? "";
    const key = `${backend}\u0000${normalizeTargetKey(resolveBare(bare))}\u0000${prefixArgs.join("\u0000")}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = { backend, seats: [], members: [], anchor: { id, config, resolvedInvocation } };
      byKey.set(key, group);
      groups.push(group);
    }
    group.seats.push(id);
    group.members.push([id, config]);
  }
  return groups;
}

export async function collectRows({
  registryPath,
  readRegistryFn = readRegistry,
  probeFn = probeRuntimeIdentity,
  npmViewFn = npmDistTags,
  readUpdaterFn = readZcodeUpdaterConclusion,
  productVersionFn = readExeProductVersion,
  hashFn = sha256First12,
  crossChannelFn = crossChannelVerdict,
  resolveInvocationFn,
  resolveBareFn,
}) {
  const handle = await readRegistryFn(registryPath);
  const entries = handle.rawEntries();

  const rows = [];
  const seenBackends = new Set();

  // 有席位的 backend：按解析后的实际目标去重，每组恰一次探针。
  for (const group of await dedupeTargets(entries, { resolveInvocationFn, resolveBareFn })) {
    seenBackends.add(group.backend);
    rows.push(await buildRow({
      backend: group.backend,
      agent: group.anchor.config,
      resolvedInvocation: group.anchor.resolvedInvocation,
      anchorAgentId: group.anchor.id,
      seats: group.seats,
      members: group.members,
      probeFn, npmViewFn, readUpdaterFn, productVersionFn, hashFn, crossChannelFn,
    }));
  }

  // 闭集里无席位的 backend：出一行 unknown（覆盖面不静默缩水；无探测——PATH 级
  // 探测不代表配置对象，runbook「证据纪律·证据单位」条在册规则）。
  for (const backend of KNOWN_BACKENDS) {
    if (seenBackends.has(backend)) continue;
    rows.push({
      backend,
      target: "(无配置席位)",
      seats: [],
      localVersion: null,
      localVerified: false,
      latestVersion: null,
      latestSource: null,
      conclusion: "unknown",
      notes: ["注册表无该 backend 席位——无配置对象可探，PATH 级探测不代表配置对象，故不探"],
    });
  }
  return rows;
}

/**
 * ZCODE_BUILTIN_PROVIDER_CONFIG_FILE lives in a folder named after the ZCode
 * version that wrote it (`…/<version>/endpoint-<hash>/zcode-builtin.json`).
 * Old folders stay on disk and keep working, but their model list stops at
 * that version (GLM-5.4 was absent from 3.15.1), so a seat left on an older
 * folder silently cannot see newer models. One note per such seat.
 *
 * @param {Array<[string, object]>} members — [seatId, registry config] pairs
 * @param {string} productVersion — installed ZCode exe version
 * @returns {string[]}
 */
export function builtinConfigDriftNotes(members, productVersion) {
  const installed = extractVersion(productVersion);
  const notes = [];
  for (const [id, config] of members) {
    const file = config?.env?.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    if (typeof file !== "string") continue;
    const parts = file.split(/[\\/]/);
    const at = parts.findIndex((s) => s.startsWith("endpoint-"));
    if (at < 1) continue;
    const folder = parts[at - 1];
    const parsed = extractVersion(folder);
    if (installed !== null && parsed !== null && compareParsedVersions(parsed, installed) === 0) continue;
    notes.push(`${id}: ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向 ${folder} 文件夹，已装 ZCode 是 ${productVersion}——该文件的模型清单停在 ${folder}，改指已装版本的文件夹`);
  }
  return notes;
}

async function buildRow({ backend, agent, resolvedInvocation, anchorAgentId, seats, members = [], probeFn, npmViewFn, readUpdaterFn, productVersionFn, hashFn, crossChannelFn }) {
  const notes = [`席位: ${seats.join(", ")}`];

  // 版本探针也不需要凭据：借 probeRuntimeIdentity 既有的 spawnFn 注入缝把剥离
  // 环境传进去（不改共用 runtimeIdentity.mjs；与 runtime-identity-cli 的差异仅在
  // 子进程 env 面——探测目标同为只读 --version）。
  const identity = await probeFn({ backendName: backend, agent, resolvedInvocation, spawnFn: probeSpawnFn });
  // 目标 = 实际探针目标（binary + argv 前缀）。zcode/codex 这类 node 包装形态若只显示
  // node.exe 无法区分不同 bundle/CLI 落点——带上前缀参数才是可分辨的实际目标。
  const prefixArgs = Array.isArray(resolvedInvocation?.args) ? resolvedInvocation.args : [];
  const targetBinary = identity.binaryPath
    ?? resolvedInvocation?.binary
    ?? agent?.binary
    ?? HARNESS_VERSION_PROBES[backend]?.binary(agent)
    ?? "(未解析)";
  const target = [targetBinary, ...prefixArgs].join(" ").trim();
  if (identity.verified === false && identity.reason) notes.push(`本地探针未确认: ${identity.reason}`);

  const row = {
    backend,
    target,
    seats,
    anchorAgentId,
    localVersion: identity.verified ? identity.version : null,
    localVerified: identity.verified === true,
    latestVersion: null,
    latestSource: null,
    conclusion: "unknown",
    notes,
  };

  // 官方最新（zcode 不查网络：读本机更新器日志的最近一条结论）。
  let latestNotes = [];
  let updater = null;
  let crossChannelUnconfirmed = false;
  if (backend === "zcode") {
    updater = readUpdaterFn();
    if (updater.conclusion) {
      row.latestVersion = updater.conclusion.version;
      row.latestSource = `ZCode 更新器日志 ${updater.conclusion.logFile} @ ${updater.conclusion.timestamp ?? "?"}`;
    } else {
      notes.push(`官方最新不可探: ${updater.reason ?? "日志缺失"}`);
    }
  } else {
    const pkg = NPM_LATEST_SOURCES[backend];
    if (pkg === undefined) {
      notes.push("backend 不在 KNOWN_BACKENDS 闭集——无官方渠道映射");
    } else {
      const { tags, reason } = await npmViewFn(pkg);
      if (tags === null) {
        notes.push(`官方最新不可探: ${reason ?? "npm 注册表查询失败"}`);
      } else {
        // 跨渠道判定先行（决定跟随哪个 tag 与备注形状）；映射外组合拿到 X 后补
        // "参照渠道发布了 X，是否落后待确认"注记，结论落 unknown（不虚构可比性）。
        const verdict = crossChannelFn(backend);
        const selected = selectDistTags(tags, row.localVersion, { followTag: verdict.followTag });
        row.latestVersion = selected.latest;
        row.latestSource = `npm dist-tag ${verdict.followTag ?? "latest"} (${pkg})`;
        if (verdict.note) notes.push(verdict.note);
        if (verdict.conclusive === false) {
          notes.push(`本地安装与 npm 官方渠道不同源、可比未确认——参照渠道发布了 ${selected.latest ?? "?"}，本安装是否落后待确认`);
          crossChannelUnconfirmed = true;
        }
        latestNotes = selected.notes;
      }
    }
  }
  notes.push(...latestNotes);

  // zcode 附加身份：产品版本（主 exe VersionInfo，runbook 行版本锚）+ zcode.cjs sha256 前 12 位。
  // 本地版本列显示产品版本并作为对照锚（exe 四段式与更新器/changelog 三段式按前三段对照）；
  // bundle 自报版本是内部序列，只在备注出现一次。产品版本缺席时不拿 bundle 序列参比（结论 unknown）。
  if (backend === "zcode") {
    const bundlePath = typeof agent?.binary === "string" ? agent.binary : null;
    const extras = { bundleSha256: null, productVersion: null };
    if (bundlePath) {
      const hashed = hashFn(bundlePath);
      extras.bundleSha256 = hashed.hash;
      if (hashed.reason) notes.push(`zcode.cjs sha256: ${hashed.reason}`);
      const exePath = resolve(dirname(bundlePath), ...ZCODE_PRODUCT_EXE_RELATIVE);
      const product = productVersionFn(exePath);
      extras.productVersion = product.version;
      if (product.reason) notes.push(`产品版本: ${product.reason}`);
      if (product.version) {
        notes.push(`bundle 自报 ${row.localVersion ?? "?"} 为内部序列；本地对照锚产品版本 ${product.version}（主 exe VersionInfo）`);
        row.localVersion = product.version;
        const updaterLocal = updater?.conclusion?.local == null ? null : extractVersion(updater.conclusion.local);
        if (updaterLocal !== null && compareParsedVersions(updaterLocal, extractVersion(product.version)) !== 0) {
          notes.push(`更新器自报 local=${updater.conclusion.local} 与主 exe VersionInfo=${product.version} 不一致（以 exe 为准）`);
        }
        notes.push(...builtinConfigDriftNotes(members, product.version));
      }
    } else {
      notes.push("产品版本与 bundle sha256 不可取: 席位未配置 binary");
    }
    row.extras = extras;
    if (extras.productVersion == null) row.localVersion = null;
  }

  // 服务型 backend：本机 CLI 与服务部署分开记（runbook 在册硬规则）。
  if (backend === "kimi-web") {
    notes.push("宿主探针与 serveUrl 服务无身份关联——服务身份未确认（CLI 版本差不推服务面）");
  }

  row.conclusion = classifyConclusion(row.localVersion, row.latestVersion);
  if (crossChannelUnconfirmed) row.conclusion = "unknown"; // 可比未确认的跨渠道对照不落 latest/behind
  return row;
}

// ---- 渲染 ----

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? "")) width += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return width;
}

function pad(text, width) {
  const value = String(text ?? "");
  return value + " ".repeat(Math.max(0, width - displayWidth(value)));
}

export function renderText(rows, { registry }) {
  const header = ["backend", "目标", "本地版本", "官方最新", "结论", "备注"];
  const cells = rows.map((r) => [
    r.backend,
    r.target,
    r.localVersion ?? "(不可探)",
    r.latestVersion ?? "(不可探)",
    r.conclusion,
    r.notes.join("；"),
  ]);
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...cells.map((c) => displayWidth(c[i]))));
  const line = (cols) => cols.map((c, i) => pad(c, widths[i])).join(" | ");
  const divider = widths.map((w) => "-".repeat(w)).join("-|-");
  return [
    `# harness 版本盘点（registry: ${registry}）`,
    "",
    line(header),
    divider,
    ...cells.map(line),
    "",
  ].join("\n");
}

export function renderJson(rows, { registry }) {
  return JSON.stringify({ registry, generatedAt: new Date().toISOString(), rows }, null, 2) + "\n";
}

// ---- 入口 ----

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, ...deps } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    usage(stderr);
    return 1;
  }
  if (args.help) {
    usage(stdout);
    return 0;
  }
  let handle;
  try {
    handle = await readRegistry(args.registry);
  } catch (error) {
    stderr.write(`registry 不可读: ${args.registry} — ${error?.message ?? error}\n`);
    return 1;
  }
  const rows = await collectRows({
    registryPath: args.registry,
    // main 已读出句柄；collectRows 内部再读一次会翻倍 IO——把句柄包成一次性
    // readRegistryFn 复用（readRegistry 语义是"读文件返回句柄"，注入点只认它）。
    readRegistryFn: async () => handle,
    ...deps,
  });
  stdout.write(args.format === "json" ? renderJson(rows, { registry: args.registry }) : renderText(rows, { registry: args.registry }));
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("harness-inventory.mjs")) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
