// scripts/reliability/args.mjs
//
// reliability 入口参数解析的纯函数内核（2026-09-17 friction 批次 1，f1）。
//
// 背景：run-reliability.mjs 旧 getArg 是纯查表，未知 flag 被静默忽略——
// 实证事故：传 `--help` 查用法被当"无参数"直接跑全量认证矩阵，白烧真实
// token。本内核是确定性判定（零 I/O、零副作用），供 run-reliability.mjs
// 消费；dry 测试钉住行为（test/registry-roles/reliabilityArgs.test.js，
// adversarialEscape.mjs ↔ reliabilityDelta.test.js 同款先例）。
//
// 契约：
//   - `--help`/`-h` → { help: true }，调用方须在任何 registry 加载/派发/
//     认证结果更新之前打印 usage 并 exit 0。
//   - 未知 flag / 缺值 / 值长得像 flag / 重复参数 → { error: "..." }，
//     调用方须在任何 token 消耗之前打印错误 + usage 并 exit 2。
//   - 合法调用 → { help:false, error:null, values:{...} }，values 全部
//     为字符串（数值校验归调用方使用处，这里只做结构层判定）。

// 已知参数白名单（值参数）。新增参数须同步 USAGE 文案与本表。
const KNOWN_VALUE_ARGS = Object.freeze([
  "serve-url",
  "registry",
  "agent",
  "wait-timeout",
  "poll-interval",
  "profile",
]);

export const USAGE = `WAO Reliability Suite（真实 runtime 认证；消耗 token）

用法: npm run reliability -- [--agent <agentId>] [--profile <strict|delta>]
                [--registry <file>] [--serve-url <url>]
                [--wait-timeout <ms>] [--poll-interval <ms>]

  --agent <id>        只认证该 agent（增量刷新常用形态）
  --profile <name>    覆盖矩阵 profile（如 delta = sentinel+scorecard+越界写对抗）
  --registry <file>   注册表路径（默认 config/agents.json）
  其余参数见 docs/usage.md 认证节。

不传 --agent/--profile 时按矩阵全量跑（贵）。未知参数一律拒绝（exit 2）。`;

function looksLikeFlag(value) {
  return typeof value === "string" && value.startsWith("--");
}

/**
 * 解析 reliability CLI 参数。纯函数：输入字符串数组，输出判定对象。
 * @param {string[]} argv
 * @returns {{help:boolean, error:string|null, values:Record<string,string>}}
 */
export function parseReliabilityArgs(argv) {
  const values = {};
  const seen = new Set();
  if (!Array.isArray(argv)) {
    return { help: false, error: "argv must be an array of strings", values };
  }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string") {
      return { help: false, error: "argv must be an array of strings", values };
    }
    if (token === "--help" || token === "-h") {
      return { help: true, error: null, values };
    }
    if (!token.startsWith("--")) {
      return { help: false, error: `unexpected positional argument: ${token}`, values };
    }
    const name = token.slice(2);
    if (!KNOWN_VALUE_ARGS.includes(name)) {
      return { help: false, error: `unknown option: ${token} (see --help)`, values };
    }
    if (seen.has(name)) {
      return { help: false, error: `duplicate option: ${token}`, values };
    }
    const value = argv[i + 1];
    if (value === undefined || looksLikeFlag(value)) {
      return { help: false, error: `${token} requires a value`, values };
    }
    seen.add(name);
    values[name] = value;
    i += 1;
  }
  return { help: false, error: null, values };
}
