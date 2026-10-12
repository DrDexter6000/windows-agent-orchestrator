// src/hostAdapters/hostRegistrationProbe.js
//
// 决定 0066（2026-10-12）：宿主注册状态的只读探测——如实回答"这个 harness 上
// WAO 的 MCP 注册了没有"。0043 第 3 条对 snippet-only 宿主一律返回
// not_applicable（"注册状态在宿主自己的配置里，WAO 查不了"）——实测后果是 Lead
// 无从得知自己所在的 harness 有没有 WAO 工具，整日退回命令行（2026-10-12
// Carloha 反馈）。本模块只读各宿主自己的配置，从不写。
//
// 纪律（会审 consult_202610121557386770ygr68 sol 席七条必改已并入）：
//   · 只读：仅 readFileSync/readdirSync；不 spawn、不写、不建目录。
//   · 读不到 ≠ 没有：只有 ENOENT/ENOTDIR 才算"文件不存在"；权限错误等一切
//     其他读取失败、解析失败、未闭合注释/字符串 → "unknown"，绝不折算成
//     not_registered（不用 existsSync——它把访问错误也报成 false）。
//   · 覆盖关系按宿主自己的优先级取**生效条目**：高优先级来源里有 wao 条目
//     （含被禁用的）即定论；高优先级来源读不了 → unknown（无从知道它是否
//     覆盖了低优先级来源）。不做"任一来源命中即 registered"的合并。
//   · registered ≠ loaded：配置里有生效条目只说明注册了；宿主是否已加载要开
//     新会话由宿主侧确认（与 codex "configured ≠ loaded" 同一诚实边界）。
//   · 共享叶子：不 import application/commands/mcp/SDK/zod；codex 用户级注册走
//     codex CLI（WAO 不解析 TOML），由 application 层另行探测，不在此处。
//
// 目标比对：条目 argv 里出现本安装的 stdio 入口路径 → registered；有 wao 条目
// 但指向别处（另一份检出/快照）→ registered_other_target。路径只做词法归一
// （斜杠、`.`/`..`、win32 大小写）；junction/符号链接别名不解析——同一安装的
// 链接别名会被报成 other_target（已知局限，不为此做额外文件系统访问）。

import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { homedir } from "node:os";

export const REGISTRATION_STATES = ["registered", "registered_other_target", "not_registered", "unknown"];

function normalizePath(p, platform) {
  const s = posix.normalize(String(p).replace(/\\/g, "/")).replace(/\/+$/, "");
  return platform === "win32" ? s.toLowerCase() : s;
}

/**
 * JSONC → JSON 文本：字符串感知地剥离注释与尾逗号。字符串内容原样保留（含
 * 其中的逗号、斜杠）；未闭合的字符串或块注释直接抛错（调用方记 unparseable）。
 */
function stripJsonc(text) {
  const n = text.length;
  const skipComment = (j) => {
    if (text[j] === "/" && text[j + 1] === "/") {
      while (j < n && text[j] !== "\n") j += 1;
      return j;
    }
    if (text[j] === "/" && text[j + 1] === "*") {
      const end = text.indexOf("*/", j + 2);
      if (end === -1) throw new Error("unterminated block comment");
      return end + 2;
    }
    return -1;
  };
  let out = "";
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= n) throw new Error("unterminated string");
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const afterComment = skipComment(i);
    if (afterComment !== -1) { i = afterComment; continue; }
    if (ch === ",") {
      // 尾逗号：其后（越过空白与注释）第一个有效字符是 } 或 ] → 丢弃该逗号。
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j])) j += 1;
        const next = skipComment(j);
        if (next === -1) break;
        j = next;
      }
      if (text[j] === "}" || text[j] === "]") { i += 1; continue; }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function parseJsonLoose(raw) {
  const text = raw.replace(/^﻿/, "");
  try { return { ok: true, value: JSON.parse(text) }; } catch { /* JSONC 回退 */ }
  try { return { ok: true, value: JSON.parse(stripJsonc(text)) }; } catch { return { ok: false, reason: "unparseable" }; }
}

/** @returns {{ok: true, value: any} | {ok: false, reason: "absent"|"unreadable"|"unparseable"}} */
function readJsonFile(io, path) {
  let raw;
  try {
    raw = io.readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, reason: err?.code === "ENOENT" || err?.code === "ENOTDIR" ? "absent" : "unreadable" };
  }
  return parseJsonLoose(raw);
}

/**
 * 单个 wao 条目 → {state, detail?}。被禁用的条目（enabled:false / disabled:true）
 * 记 not_registered + detail：条目在，但该宿主不会加载它。
 */
export function describeStdioEntry(entry, expectedStdio, platform = process.platform) {
  if (!entry || typeof entry !== "object") return { state: "not_registered" };
  if (entry.enabled === false || entry.disabled === true) {
    return { state: "not_registered", detail: "wao entry present but disabled" };
  }
  const argv = [
    ...(Array.isArray(entry.command) ? entry.command : [entry.command]),
    ...(Array.isArray(entry.args) ? entry.args : []),
  ].filter((a) => typeof a === "string");
  const want = normalizePath(expectedStdio, platform);
  return { state: argv.some((a) => normalizePath(a, platform) === want) ? "registered" : "registered_other_target" };
}

/** 条目 argv 里是否出现期望的 stdio 入口（只回状态；禁用同 describeStdioEntry）。 */
export function classifyStdioEntry(entry, expectedStdio, platform = process.platform) {
  return describeStdioEntry(entry, expectedStdio, platform).state;
}

/** 已解析的配置对象 → 来源记录；pick 取 wao 条目。entryPresent=该来源里有 wao 条目（含禁用）。 */
function sourceFromValue(ctx, scope, path, value, pick) {
  let entry;
  try { entry = pick(value); } catch { entry = undefined; }
  const entryPresent = Boolean(entry) && typeof entry === "object";
  const { state, detail } = describeStdioEntry(entry, ctx.expectedStdio, ctx.platform);
  return { scope, path, state, entryPresent, ...(detail ? { detail } : {}) };
}

/** 单个配置文件来源。文件不存在 = 该来源无条目；读不了/解析不了 = unknown。 */
function fileSource(io, ctx, scope, path, pick) {
  const read = readJsonFile(io, path);
  if (!read.ok) {
    return read.reason === "absent"
      ? { scope, path, state: "not_registered", entryPresent: false, detail: "absent" }
      : { scope, path, state: "unknown", entryPresent: false, detail: read.reason };
  }
  return sourceFromValue(ctx, scope, path, read.value, pick);
}

/** 同一来源的候选文件名（如 .jsonc 优先于 .json）：取第一个存在的。 */
function firstExistingFileSource(io, ctx, scope, paths, pick) {
  let last;
  for (const p of paths) {
    last = fileSource(io, ctx, scope, p, pick);
    if (last.detail !== "absent") return last;
  }
  return last;
}

// 每个 probe 返回的 sources **按该宿主的优先级从高到低排列**。
const PROBES = {
  // Claude Code：local > project > user（官方 scope 优先级）。~/.claude.json 的
  // user 级 mcpServers 与 local 级 projects[<cwd>].mcpServers（2026-10-12 本机
  // 实读：local 级键是正斜杠绝对路径）；项目级 <cwd>/.mcp.json。
  "claude-code": (io, ctx) => {
    const globalPath = join(ctx.env.CLAUDE_CONFIG_DIR ?? ctx.home, ".claude.json");
    const user = fileSource(io, ctx, "user", globalPath, (j) => j?.mcpServers?.wao);
    if (!ctx.cwd) return [user];
    const want = normalizePath(ctx.cwd, ctx.platform);
    const local = fileSource(io, ctx, "local", globalPath, (j) => {
      const key = Object.keys(j?.projects ?? {}).find((k) => normalizePath(k, ctx.platform) === want);
      return key ? j.projects[key]?.mcpServers?.wao : undefined;
    });
    const project = fileSource(io, ctx, "project", join(ctx.cwd, ".mcp.json"), (j) => j?.mcpServers?.wao);
    return [local, project, user];
  },
  // ~/.kimi-code/mcp.json 的 mcpServers（2026-10-12 本机实读，2026-09-07 的既有 wao 条目）。
  "kimi-code": (io, ctx) => [
    fileSource(io, ctx, "user", join(ctx.home, ".kimi-code", "mcp.json"), (j) => j?.mcpServers?.wao),
  ],
  // opencode：后加载的来源覆盖先加载的（官方配置文档的顺序：全局 → OPENCODE_CONFIG
  // 指定文件 → 项目 opencode.json → OPENCODE_CONFIG_CONTENT 内联）。本机实读核实过
  // 的只有全局文件的形状（{type:"local", command:[...]}）；其余三个来源按官方文档
  // 纳入——不纳入会把"注册在别处"误报成未注册。`.opencode/` 目录与远程配置不探测。
  opencode: (io, ctx) => {
    const pick = (j) => j?.mcp?.wao;
    const names = (dir) => [join(dir, "opencode.jsonc"), join(dir, "opencode.json")];
    const sources = [];
    if (typeof ctx.env.OPENCODE_CONFIG_CONTENT === "string" && ctx.env.OPENCODE_CONFIG_CONTENT.length > 0) {
      const parsed = parseJsonLoose(ctx.env.OPENCODE_CONFIG_CONTENT);
      sources.push(parsed.ok
        ? sourceFromValue(ctx, "inline", "env:OPENCODE_CONFIG_CONTENT", parsed.value, pick)
        : { scope: "inline", path: "env:OPENCODE_CONFIG_CONTENT", state: "unknown", entryPresent: false, detail: parsed.reason });
    }
    if (ctx.cwd) sources.push(firstExistingFileSource(io, ctx, "project", names(ctx.cwd), pick));
    if (typeof ctx.env.OPENCODE_CONFIG === "string" && ctx.env.OPENCODE_CONFIG.length > 0) {
      sources.push(fileSource(io, ctx, "custom", ctx.env.OPENCODE_CONFIG, pick));
    }
    sources.push(firstExistingFileSource(io, ctx, "user", names(join(ctx.home, ".config", "opencode")), pick));
    return sources;
  },
  // 插件通路（2026-10-03 真机验证的形态）：~/.zcode/cli/config.json 的
  // plugins.enabledPlugins["wao@<名录>"] === true 即启用；目标比对读已安装副本
  // ~/.zcode/cli/plugins/cache/<名录>/wao/<版本>/.mcp.json（扁平 {wao:{command,args}}）。
  // 缓存里可并存多个版本而无从得知宿主当前选用哪一个：全部指向本安装才报
  // registered，全部指向别处报 other_target，不一致或有读不了的 → unknown。
  zcode: (io, ctx) => {
    const cliDir = join(ctx.home, ".zcode", "cli");
    const configPath = join(cliDir, "config.json");
    const read = readJsonFile(io, configPath);
    if (!read.ok) {
      return [read.reason === "absent"
        ? { scope: "user", path: configPath, state: "not_registered", entryPresent: false, detail: "absent" }
        : { scope: "user", path: configPath, state: "unknown", entryPresent: false, detail: read.reason }];
    }
    const enabled = read.value?.plugins?.enabledPlugins ?? {};
    const keys = Object.keys(enabled).filter((k) => k.startsWith("wao@"));
    const key = keys.find((k) => enabled[k] === true);
    if (!key) {
      return [{
        scope: "user", path: configPath, state: "not_registered", entryPresent: keys.length > 0,
        ...(keys.length > 0 ? { detail: "wao plugin present but disabled" } : {}),
      }];
    }
    const cacheDir = join(cliDir, "plugins", "cache", key.slice("wao@".length), "wao");
    let versions = [];
    try { versions = io.readdirSync(cacheDir).map(String).sort(); } catch { /* 缓存缺失 → 目标不可证 */ }
    const copies = versions.map((v) => ({ version: v, ...fileSource(io, ctx, "user", join(cacheDir, v, ".mcp.json"), (j) => j?.wao) }));
    const states = [...new Set(copies.map((c) => c.state))];
    const state = states.length === 1 && (states[0] === "registered" || states[0] === "registered_other_target")
      ? states[0]
      : "unknown";
    return [{
      scope: "user",
      path: configPath,
      state,
      entryPresent: true,
      detail: copies.length === 0
        ? `${key} enabled but no installed plugin copy readable under ${cacheDir}`
        : `${key} enabled; installed copies: ${copies.map((c) => `${c.version}=${c.state}`).join(", ")}`,
    }];
  },
  // %APPDATA%\Claude\claude_desktop_config.json 的 mcpServers（2026-10-12 本机实读；
  // 仅 win32 位置核实过——其余平台不猜）。
  "claude-desktop": (io, ctx) => {
    if (ctx.platform !== "win32" || !ctx.env.APPDATA) {
      return [{ scope: "user", path: null, state: "unknown", entryPresent: false, detail: "config location verified on win32 only" }];
    }
    return [fileSource(io, ctx, "user", join(ctx.env.APPDATA, "Claude", "claude_desktop_config.json"), (j) => j?.mcpServers?.wao)];
  },
};

/** 有文件式探测的宿主 id（codex 走 CLI，不在此列）。 */
export const FILE_PROBED_HOST_IDS = Object.keys(PROBES);

/**
 * 按优先级（高 → 低）取生效来源：第一个"有 wao 条目"的来源定论（其状态即结果，
 * 含被禁用 → not_registered）；在此之前遇到读不了的来源 → unknown（它可能覆盖
 * 后面的来源）；都没有条目 → not_registered。
 * @returns {{state: string, effectiveIndex: number}} effectiveIndex=-1 表示无定论来源
 */
export function resolveEffectiveRegistration(sources) {
  for (let i = 0; i < sources.length; i += 1) {
    const s = sources[i];
    if (s.state === "unknown") return { state: "unknown", effectiveIndex: i };
    if (s.entryPresent) return { state: s.state, effectiveIndex: i };
  }
  return { state: "not_registered", effectiveIndex: -1 };
}

/**
 * 只读探测某宿主上 WAO MCP 的注册状态。
 *
 * @param {string} hostId — 描述符 id
 * @param {{expectedStdio: string, cwd?: string, io?: object, env?: object, home?: string, platform?: string}} input
 *   expectedStdio = 本安装 src/mcp/stdio.js 的绝对路径；cwd 仅用于项目/local 级来源。
 * @returns {{host: string, state: string, sources: Array<{scope: string, path: string|null, state: string, entryPresent: boolean, effective: boolean, detail?: string}>}|null}
 *   sources 按该宿主的优先级从高到低；effective=true 的那一条决定了 state。
 *   null = 该宿主没有文件式探测（调用方自行处理，如 codex）。
 */
export function probeHostRegistration(hostId, { expectedStdio, cwd, io = {}, env = process.env, home = homedir(), platform = process.platform }) {
  const probe = PROBES[hostId];
  if (!probe) return null;
  const fsIo = {
    readFileSync: io.readFileSync ?? readFileSync,
    readdirSync: io.readdirSync ?? readdirSync,
  };
  let sources;
  try {
    sources = probe(fsIo, { expectedStdio, cwd, env, home, platform });
  } catch (err) {
    sources = [{ scope: "user", path: null, state: "unknown", entryPresent: false, detail: String(err?.message ?? err) }];
  }
  const { state, effectiveIndex } = resolveEffectiveRegistration(sources);
  return { host: hostId, state, sources: sources.map((s, i) => ({ ...s, effective: i === effectiveIndex })) };
}
