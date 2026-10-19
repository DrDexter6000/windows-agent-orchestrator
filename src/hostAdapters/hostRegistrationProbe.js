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
//   · 覆盖关系按宿主自己的语义取**生效条目**：整条覆盖的宿主（Claude Code）
//     里高优先级来源有 wao 条目（含被禁用的）即定论，高优先级来源读不了 →
//     unknown；按键合并的宿主（opencode）取各来源合并后的条目，任一来源读不了
//     → unknown。不做"任一来源命中即 registered"的合并。
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
    if (afterComment !== -1) {
      // 注释换成一个空白：`tr/*x*/ue`、`1/*x*/2` 不得被拼成合法 token（复审 sol 席）。
      out += " ";
      i = afterComment;
      continue;
    }
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

function detailOf(...parts) {
  const text = parts.filter(Boolean).join("; ");
  return text ? { detail: text } : {};
}

/** 配置值按键深合并：对象逐键合并，标量与数组由高优先级整体替换。 */
function mergeConfigValue(low, high) {
  if (high === undefined) return low;
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(low) || !isObject(high)) return high;
  const out = { ...low };
  for (const [k, v] of Object.entries(high)) out[k] = mergeConfigValue(low[k], v);
  return out;
}

// ── dsh：Cordis profile patch 的最小 YAML 行扫描 ──────────────────────────────
// dsh 的注册面是 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（及 profile 根
// 清单 cordis.yml）里的 `- insert: [row…]`，row 形如
//   - id: mcp-wao
//     name: '@deepseek-ai/dsh-mcp-client'
//     config: { serverName: wao, transport: stdio, command: node, args: [...] }
// 仓库不引 YAML 依赖（生产依赖纪律），这里只认两种实见形态：块序列 args 与 flow
// 序列 args。认不出的（flow 映射 config、锚点/别名、include）→ unknown，绝不折算
// 成 not_registered（读数纪律同本文件头）。bundle 层与 --patch 叠加不在探测范围。
const DSH_MCP_CLIENT_NAME = "@deepseek-ai/dsh-mcp-client";

/** 去掉 YAML 行尾注释（引号内的 # 不算；# 前必须是空白或行首）。 */
function stripYamlLineComment(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (quote === '"' && ch === "\\" && i + 1 < line.length) {
        out += line[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && line[i + 1] === "'") {
          out += line[i + 1];
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += ch;
  }
  return out;
}

function yamlIndent(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

/** 列表项行：`- x` 或裸 `-`（空条目也是合法 YAML）。 */
function isYamlListItem(text) {
  return /^-(?:\s|$)/.test(text);
}

/** 解析单个 YAML 标量；认不出（嵌套结构、未闭合引号）返回 null。 */
function parseYamlScalar(text) {
  const s = text.trim();
  if (s.length === 0) return null;
  if (s.startsWith('"')) {
    let out = "";
    for (let i = 1; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === "\\") {
        const next = s[i + 1];
        if (next === undefined) return null;
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        i += 1;
        continue;
      }
      if (ch === '"') return s.slice(i + 1).trim() === "" ? out : null;
      out += ch;
    }
    return null;
  }
  if (s.startsWith("'")) {
    let out = "";
    for (let i = 1; i < s.length; i += 1) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 1;
          continue;
        }
        return s.slice(i + 1).trim() === "" ? out : null;
      }
      out += s[i];
    }
    return null;
  }
  if (/[[\]{}]/.test(s)) return null;
  return s;
}

/** 解析 `[a, b]` flow 序列；认不出返回 null（空序列返回 []）。 */
function parseYamlFlowSequence(text) {
  const s = text.trim();
  if (!s.startsWith("[") || !s.endsWith("]")) return null;
  const body = s.slice(1, -1);
  if (body.trim() === "") return [];
  const parts = [];
  let cur = "";
  let quote = null;
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === "\\" && i + 1 < body.length) {
        cur += body[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && body[i + 1] === "'") {
          cur += body[i + 1];
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{") { depth += 1; cur += ch; continue; }
    if (ch === "]" || ch === "}") { depth -= 1; cur += ch; continue; }
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) return null;
  parts.push(cur);
  const out = [];
  for (const part of parts) {
    const value = parseYamlScalar(part);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

/**
 * 扫描成行记录：去注释、跳过块标量（`|` / `>`）的正文、保留缩进与正文。
 * 块标量里的 `- name: …` 是文本，不是条目——不跳过就会把文档示例读成注册。
 */
function scanYamlLines(text) {
  const raw = text.split(/\r?\n/).map(stripYamlLineComment);
  const out = [];
  let blockIndent = -1;
  for (const line of raw) {
    if (line.trim() === "") continue;
    const indent = yamlIndent(line);
    if (blockIndent >= 0) {
      if (indent > blockIndent) continue;
      blockIndent = -1;
    }
    // 块标量头：`|`、`>` 后允许缩进指示符与 chomping 指示符的两种顺序（`|2-`、`|-2`）。
    if (/:\s*[|>](?:[+-]?\d+|\d+[+-]?|[+-])?\s*$/.test(line)) blockIndent = indent;
    out.push({ indent, text: line.slice(indent) });
  }
  return out;
}

/** `key: value` 切分（键可带引号）；不像键值行的返回 null。 */
function splitYamlKeyValue(text) {
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z0-9_.-]+):\s*(.*)$/.exec(text);
  if (!m) return null;
  const key = m[1].startsWith('"') || m[1].startsWith("'") ? parseYamlScalar(m[1]) : m[1];
  if (key === null) return null;
  return { key, valueText: m[2].trim() };
}

/** 一段行区间里同级键的最小缩进（跳过列表项——那些是子结构，不是同级键）。 */
function minFieldIndent(lines, from, to) {
  let min = Number.POSITIVE_INFINITY;
  for (let i = from; i < to; i += 1) {
    const line = lines[i];
    if (/^[}\]]/.test(line.text)) continue; // flow 结构的收尾行不是同级键
    if (isYamlListItem(line.text)) {
      // 跳过整个子列表项块：它的字段属于它自己，不是外层的同级键。
      const itemIndent = line.indent;
      let j = i + 1;
      while (j < to && lines[j].indent > itemIndent) j += 1;
      i = j - 1;
      continue;
    }
    min = Math.min(min, line.indent);
  }
  return Number.isFinite(min) ? min : -1;
}

/** 解析某缩进层的键值；同一键出现两次 → duplicate（YAML 非法，读不出定论）。 */
function parseYamlFields(lines, from, to, indent) {
  const fields = new Map();
  let duplicate = false;
  if (indent < 0) return { fields, duplicate };
  for (let i = from; i < to; i += 1) {
    const line = lines[i];
    if (line.indent !== indent || isYamlListItem(line.text)) continue;
    const kv = splitYamlKeyValue(line.text);
    if (!kv) continue;
    if (fields.has(kv.key)) duplicate = true;
    fields.set(kv.key, { valueText: kv.valueText, index: i });
  }
  return { fields, duplicate };
}

/** 一行（列表项）连同它的字段层。 */
function collectYamlRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isYamlListItem(lines[i].text)) continue;
    const rowIndent = lines[i].indent;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].indent <= rowIndent) { end = j; break; }
    }
    const siblingIndent = minFieldIndent(lines, i + 1, end);
    const first = splitYamlKeyValue(lines[i].text.replace(/^-[ \t]*/, "").trim());
    const parsed = parseYamlFields(lines, i + 1, end, siblingIndent);
    rows.push({
      start: i,
      end,
      rowIndent,
      siblingIndent,
      rawText: lines[i].text,
      firstKey: first?.key ?? null,
      firstValue: first?.valueText ?? null,
      fields: parsed.fields,
      duplicate: parsed.duplicate,
      insideInsert: false,
    });
  }
  // 行是否位于某个 insert 块内：insert 行与它的子行是"注册"；insert 之外的
  // 带 id 行是覆盖（patch 语义：按 id 替换字段，config 整体替换）。
  for (let k = 0; k < rows.length; k += 1) {
    const row = rows[k];
    for (let p = k - 1; p >= 0; p -= 1) {
      const ancestor = rows[p];
      if (ancestor.rowIndent >= row.rowIndent || ancestor.end <= row.start) continue;
      row.insideInsert = ancestor.firstKey === "insert";
      break;
    }
  }
  return rows;
}

/** 该行上的一个字段（列表项首行或同级键）。 */
function rowField(row, key) {
  if (row.firstKey === key) return { valueText: row.firstValue ?? "", index: row.start };
  return row.fields.get(key) ?? null;
}

/**
 * `args` 字段 → 字符串数组。认不出/空 → `{ok:false}`（空 args 在 YAML 里是 null，
 * 不是空列表：不能当成"指向别处"，只能记 unknown）。
 */
function parseArgsField(lines, field, row) {
  const text = field.valueText;
  if (text.length > 0) {
    if (!text.startsWith("[")) return { ok: false };
    const seq = parseYamlFlowSequence(text);
    return seq === null ? { ok: false } : { ok: true, args: seq };
  }
  const argsIndent = lines[field.index].indent;
  const items = [];
  for (let i = field.index + 1; i < row.end; i += 1) {
    const line = lines[i];
    if (line.indent < argsIndent) break;
    const item = isYamlListItem(line.text) ? /^-[ \t]*(.*)$/.exec(line.text) : null;
    // 与 args: 同列的 - 也是合法块序列（PyYAML 默认输出）；同列非列表=下一个键。
    if (!item) {
      if (line.indent === argsIndent) break;
      return { ok: false };
    }
    const value = parseYamlScalar(item[1]);
    if (value === null) return { ok: false };
    items.push(value);
  }
  if (items.length === 0) return { ok: false };
  return { ok: true, args: items };
}

/**
 * `disabled` 的取值语义（dsh loader 按布尔取用）：字面 true 与非空字符串为禁用；
 * false / null / 空值为启用；`!!js` 表达式读不出 → unknown。
 */
function classifyDisabledField(field) {
  const text = field.valueText.trim();
  if (text === "") return "enabled"; // 空值 = null
  if (text === "true") return "disabled";
  if (text === "false" || text === "null" || text === "~") return "enabled";
  if (text.startsWith("!!js")) return "unknown";
  if (/^["']/.test(text)) {
    const value = parseYamlScalar(text);
    if (value === null) return "unknown";
    return value.length > 0 ? "disabled" : "enabled";
  }
  if (/^-?\d+$/.test(text)) return Number(text) === 0 ? "enabled" : "disabled";
  return "unknown";
}

/** 该字段是否有块结构值：更深的结构，或与键同缩进的块序列（`disabled:\n- x`）。 */
function fieldHasBlockValue(lines, field, end) {
  const indent = lines[field.index].indent;
  for (let i = field.index + 1; i < end; i += 1) {
    if (lines[i].indent < indent) return false;
    if (lines[i].indent === indent) return isYamlListItem(lines[i].text);
    return true;
  }
  return false;
}

/**
 * 一条 dsh-mcp-client 行 → {kind, args}。
 * kind: wao / other（serverName 不是 wao）/ disabled / unreadable。
 */
function parseClientConfig(lines, row) {
  const configField = rowField(row, "config");
  if (!configField || configField.valueText.length > 0) return { kind: "unreadable" };
  const configIndent = lines[configField.index].indent;
  // config 块在同级键（缩进 ≤ config:）处结束——后面的 disabled 等不能再算进来。
  let configEnd = row.end;
  for (let i = configField.index + 1; i < row.end; i += 1) {
    if (lines[i].indent <= configIndent) { configEnd = i; break; }
  }
  const childIndent = minFieldIndent(lines, configField.index + 1, configEnd);
  if (childIndent < 0) return { kind: "unreadable" };
  const config = parseYamlFields(lines, configField.index + 1, configEnd, childIndent);
  if (config.duplicate) return { kind: "unreadable" };
  const server = config.fields.get("serverName");
  if (!server) return { kind: "unreadable" };
  const serverName = parseYamlScalar(server.valueText);
  if (serverName === null) return { kind: "unreadable" };
  if (serverName !== "wao") return { kind: "other" };
  const disabledField = rowField(row, "disabled");
  if (disabledField) {
    // `disabled:` 后接块结构 = 非 null 的对象，读不出布尔值 → unknown。
    if (disabledField.valueText === "" && fieldHasBlockValue(lines, disabledField, row.end)) {
      return { kind: "unreadable" };
    }
    const disabled = classifyDisabledField(disabledField);
    if (disabled === "unknown") return { kind: "unreadable" };
    if (disabled === "disabled") return { kind: "disabled" };
  }
  const argsField = config.fields.get("args");
  if (!argsField) return { kind: "unreadable" };
  const parsedArgs = parseArgsField(lines, argsField, row);
  if (!parsedArgs.ok) return { kind: "unreadable" };
  return { kind: "wao", args: parsedArgs.args };
}

/**
 * 解析一份 dsh profile YAML 文本。
 * @returns {{sawClient: boolean, clients: Array<{id: string|null, kind: string, args?: string[]}>, overrideIds: string[], unparsedHit: boolean}}
 *   sawClient = 文本里出现客户端包名（解析不出条目时调用方据此记 unknown）；
 *   overrideIds = 按 id 覆盖（无 insert 的 patch）行——命中客户端行 id 时定论不可得；
 *   unparsedHit = 有读不出的行提到客户端包名或客户端行 id（flow mapping 等）。
 */
function parseDshProfileText(text) {
  const lines = scanYamlLines(text);
  const sawClient = lines.some((line) => line.text.includes(DSH_MCP_CLIENT_NAME));
  const rows = collectYamlRows(lines);
  const clients = [];
  const overrideIds = [];
  const indeterminate = [];
  for (const row of rows) {
    const nameField = rowField(row, "name");
    // name 写成下一行或块结构（`name:` 后换行）：认不出这行是不是客户端条目。
    if (nameField && nameField.valueText === "" && fieldHasBlockValue(lines, nameField, row.end)) {
      indeterminate.push(row);
      continue;
    }
    const name = nameField ? parseYamlScalar(nameField.valueText) : null;
    if (name === DSH_MCP_CLIENT_NAME && row.insideInsert) {
      const idField = rowField(row, "id");
      const id = idField ? parseYamlScalar(idField.valueText) : null;
      clients.push({ id, ...parseClientConfig(lines, row) });
      continue;
    }
    if (name === DSH_MCP_CLIENT_NAME) {
      // 带 name 断言但不带 insert 的行是覆盖（按 id 替换 config），不是注册。
      const idField = rowField(row, "id");
      const id = idField ? parseYamlScalar(idField.valueText) : null;
      if (id) overrideIds.push(id);
      continue;
    }
    if (rowField(row, "insert") !== null) continue;
    const idField = rowField(row, "id");
    const id = idField ? parseYamlScalar(idField.valueText) : null;
    if (id) overrideIds.push(id);
  }
  // 读不出的行（flow row、flow 形式的 insert/config 等）的**整块原文**；调用方
  // 还要结合同 profile 其它文件里的客户端行 id 判断它们是否可能改变定论。
  // 用整块而不是首行+同级字段：多行 flow 允许各字段缩进不同，按最小缩进取字段会漏。
  const unparsedTexts = [...rows.filter((row) => row.firstKey === null
    || (row.firstValue ?? "").startsWith("[")
    || (row.firstValue ?? "").startsWith("{")), ...indeterminate]
    .map((row) => lines.slice(row.start, row.end).map((line) => line.text).join("\n"));
  return { sawClient, clients, overrideIds, unparsedTexts };
}

/** 单个 dsh 文件 → 注册状态（overrideHit 由调用方按同 profile 跨文件算好）。 */
function classifyDshFile(parsed, { want, platform, overrideHit, unparsedHit }) {
  if (unparsedHit) {
    // 有读不出的行提到客户端包名或客户端行 id（flow mapping 等）：其它可读条目
    // 不能证明这一行是什么。
    return { state: "unknown", entryPresent: true, detail: "an unparsed row mentions the dsh-mcp-client or its row id" };
  }
  if (!parsed.sawClient) return { state: "not_registered", entryPresent: false };
  if (parsed.clients.length === 0) {
    // 文本提到客户端包名，却一条行都解析不出（flow 行、锚点等）→ 不能断言没注册。
    return {
      state: "unknown",
      entryPresent: true,
      detail: "dsh-mcp-client mentioned but no client row could be parsed",
    };
  }
  if (overrideHit) {
    return { state: "unknown", entryPresent: true, detail: "a patch row overrides the client row by id" };
  }
  const wao = parsed.clients.filter((client) => client.kind !== "other");
  if (wao.length === 0) return { state: "not_registered", entryPresent: false };
  if (wao.length > 1) {
    return { state: "unknown", entryPresent: true, detail: "multiple dsh-mcp-client rows in one file" };
  }
  const client = wao[0];
  if (client.kind === "unreadable") {
    return { state: "unknown", entryPresent: true, detail: "dsh-mcp-client row not in a readable form" };
  }
  if (client.kind === "disabled") {
    return { state: "not_registered", entryPresent: true, detail: "wao entry present but disabled" };
  }
  return {
    state: client.args.some((arg) => normalizePath(arg, platform) === want) ? "registered" : "registered_other_target",
    entryPresent: true,
  };
}

// 每个 probe 返回的 sources **按该宿主的优先级从高到低排列**。返回数组的宿主是
// "高优先级整条覆盖"语义，由 resolveEffectiveRegistration 取生效来源；返回
// {state, sources} 的宿主（opencode、dsh）自己按其合并语义算好了结果。
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
  // opencode：多个配置来源**按键深合并**，后加载的覆盖先加载的同名字段、其余字段
  // 保留（官方配置文档；加载顺序：全局 → OPENCODE_CONFIG 指定文件 → 项目
  // opencode.json → OPENCODE_CONFIG_CONTENT 内联）。所以生效的 wao 条目是各来源
  // 条目合并后的结果——高优先级来源只写 {enabled:true} 时，命令仍来自低优先级
  // 来源（复审 sol 席：整条替换的判法会把它误报成 other_target）。任何一个来源
  // 读不了都可能改变合并结果 → unknown。本机实读核实过的只有全局文件的形状
  // （{type:"local", command:[...]}）；其余来源按官方文档纳入。不探测的部分：
  // `.opencode/` 目录、远程配置、以及项目配置的向上查找（官方会从当前目录一路
  // 找到最近的 Git 目录，这里只看派发目录一层——注册在父目录的会被报成没有）。
  // 同目录 .jsonc 与 .json 并存时先取 .jsonc，官方未记载两者的先后。
  opencode: (io, ctx) => {
    const pick = (j) => j?.mcp?.wao;
    const names = (dir) => [join(dir, "opencode.jsonc"), join(dir, "opencode.json")];
    const items = []; // 按优先级从高到低
    const fromValue = (scope, path, value) => {
      let entry;
      try { entry = pick(value); } catch { entry = undefined; }
      const present = Boolean(entry) && typeof entry === "object";
      items.push({ scope, path, present, entry: present ? entry : undefined });
    };
    const unreadable = (scope, path, reason) => items.push({ scope, path, present: false, unknown: true, detail: reason });
    const fromFiles = (scope, paths) => {
      let read;
      let used;
      for (const p of paths) {
        used = p;
        read = readJsonFile(io, p);
        if (read.ok || read.reason !== "absent") break;
      }
      if (read.ok) fromValue(scope, used, read.value);
      else if (read.reason === "absent") items.push({ scope, path: used, present: false, detail: "absent" });
      else unreadable(scope, used, read.reason);
    };
    if (typeof ctx.env.OPENCODE_CONFIG_CONTENT === "string" && ctx.env.OPENCODE_CONFIG_CONTENT.length > 0) {
      const parsed = parseJsonLoose(ctx.env.OPENCODE_CONFIG_CONTENT);
      if (parsed.ok) fromValue("inline", "env:OPENCODE_CONFIG_CONTENT", parsed.value);
      else unreadable("inline", "env:OPENCODE_CONFIG_CONTENT", parsed.reason);
    }
    if (ctx.cwd) fromFiles("project", names(ctx.cwd));
    if (typeof ctx.env.OPENCODE_CONFIG === "string" && ctx.env.OPENCODE_CONFIG.length > 0) {
      fromFiles("custom", [ctx.env.OPENCODE_CONFIG]);
    }
    fromFiles("user", names(join(ctx.home, ".config", "opencode")));

    const anyUnknown = items.some((it) => it.unknown);
    let merged;
    for (const it of [...items].reverse()) {
      if (it.present) merged = mergeConfigValue(merged, it.entry);
    }
    const effectiveEntry = describeStdioEntry(merged, ctx.expectedStdio, ctx.platform);
    const state = anyUnknown ? "unknown" : effectiveEntry.state;
    const contributors = items.filter((it) => it.present).length;
    return {
      state,
      sources: items.map((it) => ({
        scope: it.scope,
        path: it.path,
        // 单个来源的状态：读不了=unknown；没有条目=not_registered；有条目的来源
        // 共同构成合并结果，标合并后的状态（单看某一个来源的片段没有意义）。
        state: it.unknown ? "unknown" : it.present ? effectiveEntry.state : "not_registered",
        entryPresent: it.present,
        effective: anyUnknown ? Boolean(it.unknown) : it.present,
        ...(it.detail ? { detail: it.detail }
          : it.present ? detailOf(contributors > 1 ? "merged by key with the other sources" : null, effectiveEntry.detail)
            : {}),
      })),
    };
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
  // dsh：$DSH_HOME/profiles/<profile>/ 下的 cordis.patch.yml 与 cordis.yml（Cordis
  // YAML 组成层）。一个 profile 内两个文件是同一棵组合树的不同层，patch 层可按
  // id 覆盖（`- id: …` 且无 insert 的行），所以**同一 profile 内任何不确定都记
  // unknown**；profile 之间是独立组合，任一 profile 注册即 registered。bundle
  // 层、--patch 叠加与 cordis:include 不在探测范围。sources 不排优先级：dsh 的
  // 各 profile 不是覆盖关系，`effective` 恒 false。
  dsh: (io, ctx) => {
    const dshHome = typeof ctx.env.DSH_HOME === "string" && ctx.env.DSH_HOME.length > 0
      ? ctx.env.DSH_HOME
      : join(ctx.home, ".dsh");
    const profilesDir = join(dshHome, "profiles");
    let names;
    try {
      names = io.readdirSync(profilesDir).map(String).sort();
    } catch (err) {
      const absent = err?.code === "ENOENT" || err?.code === "ENOTDIR";
      return {
        state: absent ? "not_registered" : "unknown",
        sources: [{
          scope: "user",
          path: profilesDir,
          state: absent ? "not_registered" : "unknown",
          entryPresent: false,
          effective: false,
          detail: absent ? "absent" : "unreadable",
        }],
      };
    }
    const want = normalizePath(ctx.expectedStdio, ctx.platform);
    const sources = [];
    const profileStates = [];
    for (const name of names) {
      const files = [];
      for (const fileName of ["cordis.patch.yml", "cordis.yml"]) {
        const path = join(profilesDir, name, fileName);
        let raw;
        try {
          raw = io.readFileSync(path, "utf8");
        } catch (err) {
          if (err?.code === "ENOENT" || err?.code === "ENOTDIR") continue;
          files.push({ path, parsed: null });
          continue;
        }
        files.push({ path, parsed: parseDshProfileText(raw) });
      }
      if (files.length === 0) continue;
      // 跨文件：patch 层可以覆盖任意文件的同 id 行 → 定论不可得。
      const clientIds = new Set();
      const overrideIds = new Set();
      for (const file of files) {
        if (!file.parsed) continue;
        for (const client of file.parsed.clients) if (client.id && client.kind !== "other") clientIds.add(client.id);
        for (const id of file.parsed.overrideIds) overrideIds.add(id);
      }
      const overrideHit = [...clientIds].some((id) => overrideIds.has(id));
      // 未解析行是否可能改变定论：要看**整个 profile** 的客户端 id（跨文件覆盖）。
      const clientIdList = [...clientIds];
      const mentionsUnparsed = (parsed) => parsed.unparsedTexts.some((text) =>
        text.includes(DSH_MCP_CLIENT_NAME) || clientIdList.some((id) => text.includes(id)));
      const fileStates = [];
      for (const file of files) {
        if (!file.parsed) {
          fileStates.push("unknown");
          sources.push({ scope: `profile:${name}`, path: file.path, state: "unknown", entryPresent: false, detail: "unreadable" });
          continue;
        }
        const classified = classifyDshFile(file.parsed, {
          want,
          platform: ctx.platform,
          overrideHit,
          unparsedHit: mentionsUnparsed(file.parsed),
        });
        fileStates.push(classified.state);
        sources.push({
          scope: `profile:${name}`,
          path: file.path,
          state: classified.state,
          entryPresent: classified.entryPresent,
          ...(classified.detail ? { detail: classified.detail } : {}),
        });
      }
      // 同一 profile 内：任何不确定压过 registered（覆盖/禁用/多条目都可能改变定论）。
      if (fileStates.includes("unknown")) profileStates.push("unknown");
      else if (fileStates.includes("registered")) profileStates.push("registered");
      else if (fileStates.includes("registered_other_target")) profileStates.push("registered_other_target");
      else profileStates.push("not_registered");
    }
    if (sources.length === 0) {
      return {
        state: "not_registered",
        sources: [{
          scope: "user",
          path: profilesDir,
          state: "not_registered",
          entryPresent: false,
          effective: false,
          detail: "no profile config files",
        }],
      };
    }
    const overall = profileStates.includes("registered") ? "registered"
      : profileStates.includes("unknown") ? "unknown"
        : profileStates.includes("registered_other_target") ? "registered_other_target"
          : "not_registered";
    return {
      state: overall,
      // dsh 的 sources 没有优先级：各 profile 独立组合，不做"生效来源"标记。
      sources: sources.map((source) => ({ ...source, effective: false })),
    };
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
  let probed;
  try {
    probed = probe(fsIo, { expectedStdio, cwd, env, home, platform });
  } catch (err) {
    probed = [{ scope: "user", path: null, state: "unknown", entryPresent: false, detail: String(err?.message ?? err) }];
  }
  if (!Array.isArray(probed)) return { host: hostId, state: probed.state, sources: probed.sources };
  const { state, effectiveIndex } = resolveEffectiveRegistration(probed);
  return { host: hostId, state, sources: probed.map((s, i) => ({ ...s, effective: i === effectiveIndex })) };
}
