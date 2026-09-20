// scripts/reliability/componentArgs.mjs
//
// component-check 入口参数解析的纯函数内核（ADR-0032 §6）。
//
// 隔离决策（2026-09-20，run_20260920143049316b9leob 拒收复盘）：本模块曾以
// 「抽取共享内核 parseKnownValueArgs」的方式改写 scripts/reliability/args.mjs
// （reliability 入口共享）。行为等价已实证（旧/新 parseReliabilityArgs 在
// 1891 个组合输入上零差异；reliabilityArgs.test.js 全绿），但 reliability 入口
// 是共享热路径——组件层新参数没有必要触碰它。现 args.mjs 已恢复到逐字节
// 等于拒收前版本（f28e638），component-check 的参数纪律独立成模块：
//   - 与 reliability 同款纪律（未知 flag / 缺值 / 值长得像 flag / 重复 /
//     裸位置参数一律拒绝），判定内核逐字同源；
//   - 两内核的零漂移不靠共享代码，而靠测试钉：componentCheck.test.js 的
//     「纪律等价钉」直接对比两解析器在同形输入下的错误消息逐字一致。
//
// 契约（与 parseReliabilityArgs 同款，见 args.mjs 头注释）：
//   - `--help`/`-h` → { help: true }，调用方须在任何 registry 加载/派发/
//     台账更新之前打印 usage 并 exit 0。
//   - 未知 flag / 缺值 / 值长得像 flag / 重复参数 / 裸位置参数 → { error }，
//     调用方须在任何 token 消耗之前打印错误 + usage 并 exit 2。
//   - 合法调用 → { help:false, error:null, values:{...} }，values 全部为
//     字符串（数值校验归调用方使用处）。
//   - 本入口必填 --subject：缺失 → error（零 token 前拒绝，ADR-0032 §7）。

// 已知参数白名单（值参数）。新增参数须同步 COMPONENT_CHECK_USAGE 文案与本表。
const KNOWN_COMPONENT_CHECK_ARGS = Object.freeze([
  "subject", // 必填：backend | llm | <backend-name> | <providerID>/<modelId> | <modelId>
  "registry",
  "composition-summary", // 组合层台账（夹具资格路径 1 的证据源）
  "ledger",              // 组件台账输出（runs/component-checks.json）
  "work-dir",            // 运行时临时区（临时装配 registry / drill cwd）
  "wait-timeout",
  "poll-interval",
  "fixture-max-age-days", // 夹具组合认证新鲜期（默认 30，componentLedger SSOT）
]);

export const COMPONENT_CHECK_USAGE = `WAO Component Check（组件层验证：backend / llm 单独验证；消耗 token）

用法: npm run component-check -- --subject <backend|llm|<kind>>
                [--registry <file>] [--composition-summary <file>]
                [--ledger <file>] [--work-dir <dir>]
                [--wait-timeout <ms>] [--poll-interval <ms>]
                [--fixture-max-age-days <n>]

  --subject <target>  被测对象：backend（全部 backend）| llm（全部 llm）|
                      <backend-name> | <providerID>/<modelId> | <modelId>
  --registry <file>   注册表路径（默认 config/agents.json）
  夹具资格（ADR-0032 §4）：新鲜组合认证记录（--composition-summary，默认
  runs/reliability-summary.json）或 registry 的 certification.fixtures 声明块，
  二者任一。夹具不可用 → 被测记 blocked（exit 1）。
  零目标（解析出 0 个被测）→ exit 2，绝不空转报通过（ADR-0032 §7）。`;

function looksLikeFlag(value) {
  return typeof value === "string" && value.startsWith("--");
}

// 参数判定内核（与 args.mjs 的 parseReliabilityArgs 内核逐字同源——纪律同款，
// 零漂移由 componentCheck.test.js 的纪律等价钉保证，不共享可变状态）。
function parseKnownValueArgs(argv, knownArgs) {
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
    if (!knownArgs.includes(name)) {
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

/**
 * 解析 component-check CLI 参数。纯函数：输入字符串数组，输出判定对象。
 * @param {string[]} argv
 * @returns {{help:boolean, error:string|null, values:Record<string,string>}}
 */
export function parseComponentCheckArgs(argv) {
  const parsed = parseKnownValueArgs(argv, KNOWN_COMPONENT_CHECK_ARGS);
  if (parsed.help || parsed.error) return parsed;
  if (typeof parsed.values.subject !== "string" || parsed.values.subject.length === 0) {
    return { help: false, error: "--subject is required (backend | llm | <backend-name> | <providerID>/<modelId> | <modelId>)", values: parsed.values };
  }
  return parsed;
}
