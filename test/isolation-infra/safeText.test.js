// test/isolation-infra/safeText.test.js
//
// TD-318: src/safeText.js 纯函数单元（safeJsonParse / escapeControlChars）。
//
// 解析面：坏 JSON 的错误 message 绝不含源文本（哨兵证伪——V8 报错自带
// "...<原文>..." 片段）、含标签与行列号、不带 cause；V8 两种位置写法都覆盖
// ——"(line X column Y)" 直取、"position N" 按原文换算（当前 V8 不再产
// position-only 写法，换算分支用 monkey-patch JSON.parse 构造旧式 message
// 直测）；两者都没有（未知 token 的片段式报错）不写位置。
// TD-318 会审修：位置只认 message **末尾**的规范子句——源文本里写的
// position/(line column)（真实 V8 片段式报错嵌入）不被采信；position 超出
// 原文长度不写位置；换算按 CRLF/单独 CR/单独 LF 各一个行终止符（CRLF 只算
// 一个）。
// TD-318 复核修：两种子句共用同一偏移有效性检查——新式子句的 position 越界、
// line/column 非正整数同样不写位置；偏移落在 CRLF 中间算终止符所在的那一行
//（不再出现"第 0 列"）。
// 转义面：\n \r \t 名字写法；ESC/DEL/C1/U+2028/U+2029 的 \uXXXX 写法；普通
// 中英文原样；伪造行载荷整体可见化。
// TD-319 输出口面：linesError（保留错误类/code/message，lines 冻结副本）与
// renderErrorText（带 lines 的错误逐行转义、普通错误整体转义、字符串数组、
// 非字符串值、U+2028/U+2029）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { safeJsonParse, escapeControlChars, errorLines, linesError, renderErrorText } from "../../src/safeText.js";

const SENTINEL = "TD318_LEAK_SENTINEL";

// —— safeJsonParse ——

test("safeJsonParse: 合法 JSON 原样返回", () => {
  const value = { agents: { a: { backend: "claude-code" } }, list: [1, 2] };
  assert.deepEqual(safeJsonParse(JSON.stringify(value), "registry 文件"), value);
  assert.equal(safeJsonParse("42", "x"), 42);
  assert.equal(safeJsonParse("null", "x"), null, "null 也是合法 JSON");
});

test("safeJsonParse: 带 position 的坏 JSON——错误不含源文本哨兵，含标签与行列号，不带 cause", () => {
  // 尾逗号形状的 V8 报错带 "at position N (line 1 column N+1)"（位置在场）。
  const raw = `{"${SENTINEL}":1,}`;
  assert.throws(
    () => safeJsonParse(raw, "registry 文件"),
    (e) => {
      assert.ok(!e.message.includes(SENTINEL), `错误 message 不得含源文本哨兵: ${e.message}`);
      assert.ok(e.message.startsWith("registry 文件不是合法的 JSON"), `固定文案 + 标签: ${e.message}`);
      assert.match(e.message, /（第 \d+ 行第 \d+ 列）$/, "含行列号");
      assert.equal(e.cause, undefined, "V8 原始错误不得挂成 cause");
      return true;
    },
  );
});

test("safeJsonParse: 片段式报错（无位置）——固定文案、不写位置、零源文本", () => {
  // 未知 token 的 V8 报错自带源文本片段且无位置——解析函数必须整个吞掉。
  const raw = `{"${SENTINEL}": undefined}`;
  assert.throws(
    () => safeJsonParse(raw, "registry 文件"),
    (e) => {
      assert.ok(!e.message.includes(SENTINEL), "不得含源文本哨兵");
      assert.ok(!e.message.includes("Unexpected token"), "不得拼 V8 原始 message");
      assert.ok(!e.message.includes("（第"), "无位置可取就不写位置");
      assert.equal(e.message, "registry 文件不是合法的 JSON");
      return true;
    },
  );
});

test("safeJsonParse: (line X column Y) 写法直取，不按原文重算", () => {
  const original = JSON.parse;
  // 原文与 message 里的行列故意不一致：必须直取 message 的 (line 5 column 9)。
  JSON.parse = () => {
    throw new SyntaxError("Expected ':' after property name in JSON at position 3 (line 5 column 9)");
  };
  try {
    assert.throws(
      () => safeJsonParse('{"a" 1}', "测试文件"),
      /测试文件不是合法的 JSON（第 5 行第 9 列）/,
    );
  } finally {
    JSON.parse = original;
  }
});

test("safeJsonParse: (line X column Y) 的数字超出安全整数（长串数字会变成 Infinity）——不写位置", () => {
  const original = JSON.parse;
  for (const huge of ["9".repeat(400), "99999999999999999999"]) {
    JSON.parse = () => {
      throw new SyntaxError(`Expected ':' after property name in JSON at position 3 (line ${huge} column 5)`);
    };
    try {
      assert.throws(
        () => safeJsonParse('{"a" 1}', "测试文件"),
        (err) => err.message === "测试文件不是合法的 JSON",
      );
    } finally {
      JSON.parse = original;
    }
  }
});

test("safeJsonParse: position N 写法按原文换算——多行原文", () => {
  const original = JSON.parse;
  JSON.parse = () => {
    throw new SyntaxError("Unexpected token } in JSON at position 11");
  };
  try {
    // raw: '{\n  "a": 1\n}' —— offset 11 是第三行的 '}'（换行在 1 与 10）→ 第 3 行第 1 列。
    assert.throws(
      () => safeJsonParse('{\n  "a": 1\n}', "registry 文件"),
      /registry 文件不是合法的 JSON（第 3 行第 1 列）/,
    );
  } finally {
    JSON.parse = original;
  }
});

test("safeJsonParse: position N 写法按原文换算——单行原文", () => {
  const original = JSON.parse;
  JSON.parse = () => {
    throw new SyntaxError("Unexpected token } in JSON at position 7");
  };
  try {
    // '{"a":1,}' offset 7 无换行 → 第 1 行第 8 列（与 V8 "(line 1 column 8)" 同判）。
    assert.throws(
      () => safeJsonParse('{"a":1,}', "registry 文件"),
      /registry 文件不是合法的 JSON（第 1 行第 8 列）/,
    );
  } finally {
    JSON.parse = original;
  }
});

// ── TD-318 会审修：位置只认 message 末尾的规范子句 ──────────────────────────

test("safeJsonParse: 片段式报错的源文本含 position 99（真实 V8）——不写位置、零源文本回显", () => {
  // 真实 V8 对该形状的报错把源文本嵌进引号：Unexpected token 'p', "{"a":
  // position 99}" is not valid JSON——旧实现在整条 message 上跑正则，会把
  // 引号里的源文本 position 99 当位置（18 字节原文输出"第 1 行第 100 列"）。
  // 新契约只认末尾子句；该 message 以 "is not valid JSON" 结尾 → 无位置。
  const raw = '{"a": position 99}';
  assert.throws(
    () => safeJsonParse(raw, "registry 文件"),
    (e) => {
      assert.equal(e.message, "registry 文件不是合法的 JSON", "片段式报错不写位置，只有固定文案");
      assert.ok(!e.message.includes("position 99"), "源文本里的 position 不进输出");
      return true;
    },
  );
});

test("safeJsonParse: 片段式报错的源文本含 (line 7 column 9)（真实 V8）——不被采信", () => {
  // 真实 V8 报错：Unexpected token '(', "(line 7 column 9){" is not valid JSON
  // ——源文本的行列诱饵在引号里、不在末尾。旧实现的 line/column 正则任意位置
  // 匹配会直接采信 7/9；新契约不认非末尾子句 → 无位置。
  const raw = "(line 7 column 9){";
  assert.throws(
    () => safeJsonParse(raw, "registry 文件"),
    (e) => {
      assert.equal(e.message, "registry 文件不是合法的 JSON", "源文本里的行列不被采信，不写位置");
      assert.ok(!e.message.includes("line 7"), "源文本里的行列不进输出");
      return true;
    },
  );
});

test("safeJsonParse: position 超出原文长度——不写位置", () => {
  const original = JSON.parse;
  JSON.parse = () => {
    throw new SyntaxError("Unexpected token } in JSON at position 999");
  };
  try {
    // raw 长度 8，position 999 越界（换算无意义）→ 只有固定文案。
    assert.throws(
      () => safeJsonParse('{"a":1,}', "registry 文件"),
      (e) => {
        assert.equal(e.message, "registry 文件不是合法的 JSON", "越界 position 不写位置");
        return true;
      },
    );
  } finally {
    JSON.parse = original;
  }
});

test("safeJsonParse: position N 换算认 CRLF/单独 CR/单独 LF——CRLF 只算一个行终止符", () => {
  const original = JSON.parse;
  const throwsAt = (message) => () => { throw new SyntaxError(message); };
  try {
    // 三个最小原文，position 都指向第二行首字符 'b'：
    //   'a\rb'   offset 2（单独 CR 一个终止符）→ 第 2 行第 1 列
    //   'a\r\nb' offset 3（CRLF 一个终止符，不是两个）→ 第 2 行第 1 列
    //   'a\nb'   offset 2（单独 LF）→ 第 2 行第 1 列
    JSON.parse = throwsAt("Unexpected token 'b' in JSON at position 2");
    assert.throws(() => safeJsonParse("a\rb", "测试文件"), /（第 2 行第 1 列）/);
    assert.throws(() => safeJsonParse("a\nb", "测试文件"), /（第 2 行第 1 列）/);
    JSON.parse = throwsAt("Unexpected token 'b' in JSON at position 3");
    assert.throws(() => safeJsonParse("a\r\nb", "测试文件"), /（第 2 行第 1 列）/);
  } finally {
    JSON.parse = original;
  }
});

test("safeJsonParse: 真实 V8 末尾子句照常取位置——(line X column Y) 直取", () => {
  // '{"a":1,}' 的真实 V8 报错：Expected double-quoted property name in JSON
  // at position 7 (line 1 column 8)——末尾规范子句在场，位置照常写。
  assert.throws(
    () => safeJsonParse('{"a":1,}', "registry 文件"),
    (e) => {
      assert.equal(e.message, "registry 文件不是合法的 JSON（第 1 行第 8 列）");
      return true;
    },
  );
});

// ── TD-318 复核修：位置换算边界 ──────────────────────────────────────────────

test("safeJsonParse: (line X column Y) 写法共用偏移检查——position 越界 / 行列非正整数不写位置", () => {
  const original = JSON.parse;
  const throwsAt = (message) => () => { throw new SyntaxError(message); };
  try {
    // 原文 "{}" 长 2：末尾子句的 position 999 越界——直取前先过与旧式子句同一
    // 的有效性检查，不写位置。
    JSON.parse = throwsAt("Unexpected token } in JSON at position 999 (line 1 column 1000)");
    assert.throws(
      () => safeJsonParse("{}", "测试文件"),
      (e) => {
        assert.equal(e.message, "测试文件不是合法的 JSON", "新式子句 position 越界同样不写位置");
        return true;
      },
    );
    // X、Y 必须是正整数（正则 \\d+ 允许 0——防御伪造的 message）。
    JSON.parse = throwsAt("Unexpected token } in JSON at position 1 (line 0 column 1)");
    assert.throws(
      () => safeJsonParse("{}", "测试文件"),
      (e) => {
        assert.equal(e.message, "测试文件不是合法的 JSON", "line 0 不写位置");
        return true;
      },
    );
    JSON.parse = throwsAt("Unexpected token } in JSON at position 1 (line 1 column 0)");
    assert.throws(
      () => safeJsonParse("{}", "测试文件"),
      (e) => {
        assert.equal(e.message, "测试文件不是合法的 JSON", "column 0 不写位置");
        return true;
      },
    );
  } finally {
    JSON.parse = original;
  }
});

test("safeJsonParse: 偏移落在 CRLF 中间——算终止符所在的那一行，不出现第 0 列", () => {
  const original = JSON.parse;
  const throwsAt = (message) => () => { throw new SyntaxError(message); };
  try {
    // 'a\r\nb'（长 4）offset 2 = CRLF 的 LF：算第 1 行（终止符所在行）第 3 列
    //——旧换算在此得"第 2 行第 0 列"。
    JSON.parse = throwsAt("Unexpected token in JSON at position 2");
    assert.throws(() => safeJsonParse("a\r\nb", "测试文件"), /（第 1 行第 3 列）/);
    // 对照：越过整对 CRLF 的偏移照常进第 2 行第 1 列。
    JSON.parse = throwsAt("Unexpected token in JSON at position 3");
    assert.throws(() => safeJsonParse("a\r\nb", "测试文件"), /（第 2 行第 1 列）/);
  } finally {
    JSON.parse = original;
  }
});

// —— escapeControlChars ——

test("escapeControlChars: \\n \\r \\t 用名字写法转义", () => {
  assert.equal(escapeControlChars("a\nb"), "a\\nb");
  assert.equal(escapeControlChars("c\rd"), "c\\rd");
  assert.equal(escapeControlChars("e\tf"), "e\\tf");
});

test("escapeControlChars: ESC/DEL/C1/行分隔符/空字符用 \\uXXXX 写法转义", () => {
  assert.equal(escapeControlChars("\u001b"), "\\u001b");
  assert.equal(escapeControlChars("\u007f"), "\\u007f");
  assert.equal(escapeControlChars("\u0085"), "\\u0085");
  assert.equal(escapeControlChars("\u2028"), "\\u2028");
  assert.equal(escapeControlChars("\u2029"), "\\u2029");
  assert.equal(escapeControlChars("a\u0000b"), "a\\u0000b");
});

test("escapeControlChars: 普通中英文与常规标点原样（恒等变换）", () => {
  const plain = "registry 文件 not valid JSON，第 3 行；café — ok";
  assert.equal(escapeControlChars(plain), plain);
  assert.equal(escapeControlChars(""), "");
});

test("escapeControlChars: 伪造行载荷整体可见化——输出不再含真实换行", () => {
  const escaped = escapeControlChars("evil\n[FAIL] forged");
  assert.ok(!escaped.includes("\n"), "输出不得再含真实换行");
  assert.equal(escaped, "evil\\n[FAIL] forged");
});

// —— linesError / renderErrorText（TD-319 输出口） ——

test("linesError: message === lines.join，lines 是冻结副本，makeError 保留错误类与 code", () => {
  class RefusalError extends Error {
    constructor(message) {
      super(message);
      this.name = "RefusalError";
      this.code = "E_TD319";
    }
  }
  const err = linesError(["第一行：拒绝原因", "第二行：修正指引"], (message) => new RefusalError(message));
  assert.ok(err instanceof RefusalError, "调用方的错误类保留");
  assert.equal(err.name, "RefusalError");
  assert.equal(err.code, "E_TD319", "调用方的 code 保留");
  assert.equal(err.message, "第一行：拒绝原因\n第二行：修正指引", "message 与 join 逐字一致（照旧读 .message 的代码不受影响）");
  assert.deepEqual(err.lines, ["第一行：拒绝原因", "第二行：修正指引"]);
  assert.ok(Object.isFrozen(err.lines), "lines 冻结");
  // 入参数组被复制：构造后改原数组不影响 error.lines
  const src = ["a", "b"];
  const copied = linesError(src);
  src[0] = "mutated";
  assert.equal(copied.lines[0], "a", "lines 是副本，不是原数组引用");
  assert.equal(copied.message, "a\nb", "缺省 makeError 用 Error");
});

test("renderErrorText: 带 lines 的错误——行内注入换行仍只输出原定行数", () => {
  const err = linesError(["prefix evil\n[FORGED] suffix", "second line"]);
  const text = renderErrorText(err);
  const rows = text.split("\n");
  assert.equal(rows.length, 2, `行数不变（注入的换行成为可见写法，不增殖行）: ${JSON.stringify(text)}`);
  assert.equal(rows[0], "prefix evil\\n[FORGED] suffix");
  assert.equal(rows[1], "second line");
});

test("renderErrorText: 普通错误的换行变成可见写法（不伪造行）", () => {
  const err = new Error("serve auth env is absent: set EVIL\n[FAIL] forged-name (value is never echoed)");
  const text = renderErrorText(err);
  assert.ok(!text.includes("\n"), "输出不得含真实换行");
  assert.equal(text, "serve auth env is absent: set EVIL\\n[FAIL] forged-name (value is never echoed)");
});

test("renderErrorText: 字符串数组逐行转义后连接（MCP isError 行数组形态）", () => {
  assert.equal(renderErrorText(["dispatch refused: unknown_lane. 收到 lane=\"x\"", "known lanes (2): a, b"]), "dispatch refused: unknown_lane. 收到 lane=\"x\"\nknown lanes (2): a, b");
  assert.equal(renderErrorText(["a\nb", "c"]), "a\\nb\nc", "行内换行转义，行间换行保留");
});

test("renderErrorText: 字符串整体转义——其中的换行显示为可见写法", () => {
  assert.equal(renderErrorText("x\ny"), "x\\ny");
  assert.equal(renderErrorText("plain"), "plain");
});

test("renderErrorText: 非字符串值经 String() 归一后转义", () => {
  assert.equal(renderErrorText(42), "42");
  assert.equal(renderErrorText(null), "null");
  assert.equal(renderErrorText(undefined), "undefined");
});

test("renderErrorText: U+2028/U+2029 在行数组与字符串分支里都转义", () => {
  const err = linesError(["a", "b\u2028c"]);
  const text = renderErrorText(err);
  assert.ok(!text.includes("\u2028"), "带 lines 错误的行内行分隔符不再原样输出");
  assert.equal(text, "a\nb\\u2028c");
  assert.equal(renderErrorText(["x\u2028y"]), "x\\u2028y", "字符串数组的行内行分隔符转义");
  assert.equal(renderErrorText("p\u2029q"), "p\\u2029q", "字符串整体转义");
});

test("errorLines: 只认自有属性 lines；继承来的 lines 不算，回落到 message 一行", () => {
  const own = linesError(["a", "b"]);
  assert.deepEqual(errorLines(own), ["a", "b"]);
  const proto = { lines: ["forged-1", "forged-2"] };
  const inherited = Object.create(Object.assign(Object.create(Error.prototype), proto));
  inherited.message = "real message";
  assert.ok(inherited instanceof Error);
  assert.deepEqual(errorLines(inherited), ["real message"], "原型上的 lines 不采信");
  assert.equal(renderErrorText(inherited), "real message", "渲染同样只认自有属性");
  assert.deepEqual(errorLines(new Error("x\ny")), ["x\ny"], "普通错误的 message 原样算一行（换行由渲染转义）");
  assert.deepEqual(errorLines("plain"), ["plain"], "非 Error 取 String(value)");
  const copy = errorLines(own);
  copy.push("extra");
  assert.deepEqual(own.lines, ["a", "b"], "返回副本，不改原错误的行");
});

test("renderErrorText / escapeControlChars: String() 会抛的值落成固定占位，不抛错", () => {
  const bare = Object.create(null);
  const hostile = { toString() { throw new Error("boom"); } };
  assert.equal(renderErrorText(bare), "[unprintable value]");
  assert.equal(renderErrorText(hostile), "[unprintable value]");
  assert.equal(escapeControlChars(bare), "[unprintable value]");
  const err = new Error("x");
  err.message = bare;
  assert.equal(renderErrorText(err), "[unprintable value]", "message 本身不可打印也不抛");
});

test("renderErrorText: 读 message 的 getter 自己抛错时也只落成固定占位", () => {
  const err = new Error("x");
  Object.defineProperty(err, "message", { get() { throw new Error("boom"); } });
  assert.equal(renderErrorText(err), "[unprintable value]");
  assert.deepEqual(errorLines(err), ["[unprintable value]"]);
});
