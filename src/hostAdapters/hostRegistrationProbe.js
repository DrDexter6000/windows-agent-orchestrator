// src/hostAdapters/hostRegistrationProbe.js
//
// 决定 0066（2026-10-12）：宿主注册状态的只读探测——如实回答"这个 harness 上
// WAO 的 MCP 注册了没有"。0043 第 3 条对 snippet-only 宿主一律返回
// not_applicable（"注册状态在宿主自己的配置里，WAO 查不了"）——实测后果是 Lead
// 无从得知自己所在的 harness 有没有 WAO 工具，整日退回命令行（2026-10-12
// Carloha 反馈）。本模块只读各宿主自己的配置文件，从不写。
//
// 纪律：
//   · 只读：仅 existsSync/readFileSync；不 spawn、不写、不建目录。
//   · 不猜：只探测真机核实过位置与形状的配置（见各 probe 注释的出处）；读不到、
//     解析不了、平台未核实 → "unknown"，绝不折算成 not_registered。
//   · registered ≠ loaded：配置里有条目只说明注册了；宿主是否已加载要开新会话
//     由宿主侧确认（与 codex "configured ≠ loaded" 同一诚实边界）。
//   · 共享叶子：不 import application/commands/mcp/SDK/zod；codex 用户级注册走
//     codex CLI（WAO 不解析 TOML），由 application 层另行探测，不在此处。
//
// 目标比对：条目的 argv 里出现本安装的 stdio 入口路径 → registered；有 wao 条目
// 但指向别处（另一份检出/快照）→ registered_other_target（如实报出，不算未注册）。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const REGISTRATION_STATES = ["registered", "registered_other_target", "not_registered", "unknown"];

function normalizePath(p, platform) {
  const s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? s.toLowerCase() : s;
}

/** JSONC（opencode 官方允许注释）→ JSON 文本：字符串感知地剥离注释与尾逗号。 */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += text[i + 1] ?? ""; i += 1; } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i += 1; out += "\n"; continue; }
    if (ch === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2); if (i === -1) break; i += 1; continue; }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** @returns {{ok: true, value: any} | {ok: false, reason: "absent"|"unreadable"|"unparseable"}} */
function readJsonFile(io, path) {
  if (!io.existsSync(path)) return { ok: false, reason: "absent" };
  let raw;
  try { raw = io.readFileSync(path, "utf8"); } catch { return { ok: false, reason: "unreadable" }; }
  raw = raw.replace(/^﻿/, "");
  try { return { ok: true, value: JSON.parse(raw) }; } catch { /* JSONC 回退 */ }
  try { return { ok: true, value: JSON.parse(stripJsonComments(raw)) }; } catch { return { ok: false, reason: "unparseable" }; }
}

/** 条目 argv（command 可为字符串或数组，args 可缺）里是否出现期望的 stdio 入口。 */
export function classifyStdioEntry(entry, expectedStdio, platform = process.platform) {
  if (!entry || typeof entry !== "object") return "not_registered";
  const argv = [
    ...(Array.isArray(entry.command) ? entry.command : [entry.command]),
    ...(Array.isArray(entry.args) ? entry.args : []),
  ].filter((a) => typeof a === "string");
  const want = normalizePath(expectedStdio, platform);
  return argv.some((a) => normalizePath(a, platform) === want) ? "registered" : "registered_other_target";
}

/** 单个配置文件来源 → {scope, path, state}；pick 从已解析 JSON 里取 wao 条目。 */
function fileSource(io, ctx, scope, path, pick) {
  const read = readJsonFile(io, path);
  if (!read.ok) {
    return { scope, path, state: read.reason === "absent" ? "not_registered" : "unknown", detail: read.reason };
  }
  let entry;
  try { entry = pick(read.value); } catch { entry = undefined; }
  return { scope, path, state: classifyStdioEntry(entry, ctx.expectedStdio, ctx.platform) };
}

const PROBES = {
  // ~/.claude.json：user 级 mcpServers、local 级 projects[<cwd>].mcpServers；项目级
  // <cwd>/.mcp.json（2026-10-12 本机实读：local 级键是正斜杠绝对路径）。
  "claude-code": (io, ctx) => {
    const globalPath = join(ctx.env.CLAUDE_CONFIG_DIR ?? ctx.home, ".claude.json");
    const sources = [fileSource(io, ctx, "user", globalPath, (j) => j?.mcpServers?.wao)];
    if (ctx.cwd) {
      const want = normalizePath(ctx.cwd, ctx.platform);
      sources.push(fileSource(io, ctx, "local", globalPath, (j) => {
        const key = Object.keys(j?.projects ?? {}).find((k) => normalizePath(k, ctx.platform) === want);
        return key ? j.projects[key]?.mcpServers?.wao : undefined;
      }));
      sources.push(fileSource(io, ctx, "project", join(ctx.cwd, ".mcp.json"), (j) => j?.mcpServers?.wao));
    }
    return sources;
  },
  // ~/.kimi-code/mcp.json 的 mcpServers（2026-10-12 本机实读，2026-09-07 的既有 wao 条目）。
  "kimi-code": (io, ctx) => [
    fileSource(io, ctx, "user", join(ctx.home, ".kimi-code", "mcp.json"), (j) => j?.mcpServers?.wao),
  ],
  // ~/.config/opencode/opencode.json(c) 的 mcp 段 + 项目根 opencode.json(c)
  // （2026-10-12 本机实读：既有条目形状 {type:"local", command:[...]}）。
  opencode: (io, ctx) => {
    const firstExisting = (dir) => {
      const jsonc = join(dir, "opencode.jsonc");
      return io.existsSync(jsonc) ? jsonc : join(dir, "opencode.json");
    };
    const sources = [fileSource(io, ctx, "user", firstExisting(join(ctx.home, ".config", "opencode")), (j) => j?.mcp?.wao)];
    if (ctx.cwd) sources.push(fileSource(io, ctx, "project", firstExisting(ctx.cwd), (j) => j?.mcp?.wao));
    return sources;
  },
  // 插件通路（2026-10-03 真机验证的形态）：~/.zcode/cli/config.json 的
  // plugins.enabledPlugins["wao@<名录>"] === true 即启用；目标比对读已安装副本
  // ~/.zcode/cli/plugins/cache/<名录>/wao/<版本>/.mcp.json（扁平 {wao:{command,args}}）。
  zcode: (io, ctx) => {
    const cliDir = join(ctx.home, ".zcode", "cli");
    const configPath = join(cliDir, "config.json");
    const read = readJsonFile(io, configPath);
    if (!read.ok) {
      return [{ scope: "user", path: configPath, state: read.reason === "absent" ? "not_registered" : "unknown", detail: read.reason }];
    }
    const enabled = read.value?.plugins?.enabledPlugins ?? {};
    const key = Object.keys(enabled).find((k) => k.startsWith("wao@") && enabled[k] === true);
    if (!key) return [{ scope: "user", path: configPath, state: "not_registered" }];
    const cacheDir = join(cliDir, "plugins", "cache", key.slice("wao@".length), "wao");
    let versions = [];
    try { versions = io.readdirSync(cacheDir); } catch { /* 缓存缺失 → 目标不可证 */ }
    const states = versions.map((v) => fileSource(io, ctx, "user", join(cacheDir, v, ".mcp.json"), (j) => j?.wao).state);
    if (states.includes("registered")) return [{ scope: "user", path: configPath, state: "registered", detail: key }];
    if (states.includes("registered_other_target")) return [{ scope: "user", path: configPath, state: "registered_other_target", detail: key }];
    return [{ scope: "user", path: configPath, state: "unknown", detail: `${key} enabled but installed plugin copy unreadable` }];
  },
  // %APPDATA%\Claude\claude_desktop_config.json 的 mcpServers（2026-10-12 本机实读；
  // 仅 win32 位置核实过——其余平台不猜）。
  "claude-desktop": (io, ctx) => {
    if (ctx.platform !== "win32" || !ctx.env.APPDATA) {
      return [{ scope: "user", path: null, state: "unknown", detail: "config location verified on win32 only" }];
    }
    return [fileSource(io, ctx, "user", join(ctx.env.APPDATA, "Claude", "claude_desktop_config.json"), (j) => j?.mcpServers?.wao)];
  },
};

/** 有文件式探测的宿主 id（codex 走 CLI，不在此列）。 */
export const FILE_PROBED_HOST_IDS = Object.keys(PROBES);

/** 多来源合并：任一 registered 即 registered；否则按 other_target > unknown > not_registered。 */
export function mergeRegistrationStates(states) {
  for (const s of ["registered", "registered_other_target", "unknown"]) {
    if (states.includes(s)) return s;
  }
  return "not_registered";
}

/**
 * 只读探测某宿主上 WAO MCP 的注册状态。
 *
 * @param {string} hostId — 描述符 id
 * @param {{expectedStdio: string, cwd?: string, io?: object, env?: object, home?: string, platform?: string}} input
 *   expectedStdio = 本安装 src/mcp/stdio.js 的绝对路径；cwd 仅用于项目/local 级来源。
 * @returns {{host: string, state: string, sources: Array<{scope: string, path: string|null, state: string, detail?: string}>}|null}
 *   null = 该宿主没有文件式探测（调用方自行处理，如 codex）。
 */
export function probeHostRegistration(hostId, { expectedStdio, cwd, io = {}, env = process.env, home = homedir(), platform = process.platform }) {
  const probe = PROBES[hostId];
  if (!probe) return null;
  const fsIo = {
    existsSync: io.existsSync ?? existsSync,
    readFileSync: io.readFileSync ?? readFileSync,
    readdirSync: io.readdirSync ?? readdirSync,
  };
  let sources;
  try {
    sources = probe(fsIo, { expectedStdio, cwd, env, home, platform });
  } catch (err) {
    sources = [{ scope: "user", path: null, state: "unknown", detail: String(err?.message ?? err) }];
  }
  return { host: hostId, state: mergeRegistrationStates(sources.map((s) => s.state)), sources };
}
