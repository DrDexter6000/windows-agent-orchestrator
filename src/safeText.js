// src/safeText.js
//
// TD-318: 配置内容不经报错与文本输出原样漏出的两条底线（单一实现，
// 零依赖的顶层叶子模块：registry.js/core 与 commands/* 都能下向
// import，无反向依赖）。registry 文件与条目值是磁盘上的不可信数据：
//   1. JSON.parse 的 V8 报错自带源文本片段（Unexpected token 'u',
//      ...{"LEAK":undefined}"... is not valid JSON）——报错原样上抛，registry
//      原文就进 CLI/MCP 输出。safeJsonParse 把解析失败折叠成固定文案 + 行列号，
//      绝不携带源文本；V8 原始 message 既不拼进新错误、也不挂成 cause
//      （那等于换汤不换药）。
//   2. 文本输出里拼进配置来源值的行，值里的换行/控制字符能在终端伪造一行检查
//      结果。escapeControlChars 把 C0/DEL/C1 与 U+2028/U+2029 换成可见转义写法，
//      其余原样。多数消费方在文本渲染边界调用，JSON 输出面不加这一层
//      （JSON.stringify 自带转义，原值仍可机读）；两处在**生成内容时**转义——
//      src/registry.js 的 unknownBackendGuidance 与 doctor 的 invocation_method
//      明细——这两个 JSON 字段里因此也是转义写法，不是原值。
//
// 消费方：解析——src/registry.js（readRegistry）、src/dispatchResolution.js
// （roles.json、lanes.json）、src/application/laneProfile.js（车道画像文件）、
// scripts/run-component-check.mjs 与 scripts/run-reliability.mjs（读 registry）；
// 文本转义——src/commands/registry.js、doctor.js、lanes.js、onboarding.js 与
// src/registry.js 的未知 backend 报错。零相对出边。

// V8 报错的规范位置子句只认 message **末尾**：以 ` at position N (line X column Y)`
// 结尾（新式，V8 自己算好的行列，直取），或以 ` at position N` 结尾（旧式，按
// 原文换算）。不在末尾的一律不认——片段式报错（Unexpected token 'p',
// "{"a": position 99}"... is not valid JSON）本身没有位置，引号里的源文本是
// 磁盘上的不可信数据，写在源文本里的 position/(line column) 不能采信。
// 两种子句共用同一偏移有效性检查：N 必须是不超过原文长度的整数（越界不写
// 位置——真实 V8 恒满足，这是对伪造 message 的防御）；新式子句的 X、Y 还必须
// 是正整数（0 不行），否则同样不写位置。
// 换算：position 是 0 起字符偏移；行 = 前文行终止符数 + 1（CRLF、单独 CR、
// 单独 LF 各算一个，CRLF 只算一个），列 = 偏移 - 行首下标 + 1（无换行时即
// position + 1，与 V8 的 "at position 7 (line 1 column 8)" 同判）。偏移恰好
// 落在 CRLF 的 LF 上时算作该行终止符所在的那一行（"a\r\nb" 的 position 2 →
// 第 1 行第 3 列）——只有越过整对 CRLF 的偏移才推进到下一行，第 0 列不可能
// 出现。末尾没有规范子句（或检查不过）返回 null——调用方不写位置。
function jsonErrorPosition(errorMessage, raw) {
  const text = typeof errorMessage === "string" ? errorMessage : "";
  const lineCol = /\bat position (\d+) \(line (\d+) column (\d+)\)$/.exec(text);
  if (lineCol) {
    if (Number(lineCol[1]) > raw.length) return null;
    const line = Number(lineCol[2]);
    const column = Number(lineCol[3]);
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) return null;
    return { line, column };
  }
  const atPosition = /\bat position (\d+)$/.exec(text);
  if (atPosition) {
    const offset = Number(atPosition[1]);
    if (offset > raw.length) return null;
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < offset && i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === "\r") {
        if (raw[i + 1] === "\n") {
          // CRLF 是一个行终止符；偏移落在 LF 上（CRLF 中间）时仍算终止符所在的
          // 那一行，只有越过整对 CRLF 的偏移才推进到下一行。
          if (i + 1 < offset) {
            line += 1;
            lineStart = i + 2;
          }
          i += 1;
        } else {
          line += 1;
          lineStart = i + 1;
        }
      } else if (ch === "\n") {
        line += 1;
        lineStart = i + 1;
      }
    }
    return { line, column: offset - lineStart + 1 };
  }
  return null;
}

/**
 * 安全 JSON 解析：成功原样返回解析结果；失败抛出的 Error 只含固定文案、
 * 标签与行列号（如 "registry 文件不是合法的 JSON（第 3 行第 7 列）"），取不到
 * 位置时不写位置。绝不携带源文本，也不携带 V8 原始 message（拼接与 cause 都
 * 不允许）。
 *
 * @param {string} raw - 原文
 * @param {string} label - 说明它是什么的标签（进错误文案，必须是受控文案，不是用户数据）
 * @returns {unknown} JSON.parse 的解析结果
 */
export function safeJsonParse(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    const pos = jsonErrorPosition(e.message, raw);
    const at = pos ? `（第 ${pos.line} 行第 ${pos.column} 列）` : "";
    throw new Error(`${label}不是合法的 JSON${at}`);
  }
}

// 可见转义的名字写法（JSON 的五个命名转义）；其余控制字符走 \uXXXX。
const NAMED_ESCAPES = new Map([
  ["\b", "\\b"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\f", "\\f"],
  ["\r", "\\r"],
]);

/**
 * 把 C0 控制字符（U+0000–U+001F）、DEL（U+007F）、C1 控制字符（U+0080–U+009F）
 * 与 U+2028/U+2029 换成可见的转义写法（\n、\u001b），其余字符原样保留。
 * 文本输出专用：值里藏的换行不再能伪造一行。对干净文本是恒等变换。
 *
 * @param {unknown} text - 任意值（非字符串按 String() 归一，与模板拼接同语义）
 * @returns {string}
 */
export function escapeControlChars(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (ch) => (
    NAMED_ESCAPES.get(ch) ?? `\\u${ch.codePointAt(0).toString(16).padStart(4, "0")}`
  ));
}
