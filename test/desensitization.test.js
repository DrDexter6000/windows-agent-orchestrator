// 脱敏门控（desensitization gate）—— 把 "Do not commit secrets"（AGENTS.md:112）从
// prose 铁律提升为机器不变量。
//
// 设计依据：TD-72 元教训——"凡依赖 agent 自觉遵守 prose 的约束都会漂，落到确定性测试
// 里才守得住"（docs/tech-debt.md:78）。AGENTS.md 的 "Do not commit ... secrets" 是纯
// prose，按 TD-72 教训必然漂；这里把它固化成 test/ 断言，与 docs-consistency.test.js
// 同款 idiom（file-list + regex-scan + assert.ok(!match)），进 npm test。
//
// 三域规则：脱敏扫描是 🟢 工具域（确定性、单正解）→ 全自动，Lead 不介入。门控失败 =
// 修文件（泄露了就脱敏），不是修测试。同 docs-consistency 哲学。
//
// 三类硬泄露扫描（不扫内部项目名等软信号——误报多，且已手动脱敏）：
//   1. API key/token 明文（最高价值——真泄露就完了）
//   2. 本机绝对路径（C:\Users\、D:\projects\<非WAO项目> 等路径结构泄露）
//   3. 敏感文件被误跟踪（agents.json/.env/runs 等本该 gitignore 却被 git add -f）
//
// 关键：扫 `git ls-files`（会进仓库的文件），不扫磁盘全文件——.wao/state/、.dev/、
// runs/ 都含本机路径但都 gitignore，扫磁盘会海量误报。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
// 扫描器定义文件自身——天然豁免：它内含正则字面量和"硬泄露形态"示例文本
// （如注释里的 `D:\Loster`），这些是规则定义不是真实泄露，不该被自己扫到。
// 用 import.meta.url 动态解析，不硬编码文件名，改名/复制不受影响。
const SELF = "test/" + basename(fileURLToPath(import.meta.url));

/** 拿 git 跟踪的文件清单（只这些会进仓库）。失败说明不在 git 仓内，跳过本门控。 */
function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return []; // 非 git 仓（罕见），门控无法运行，静默跳过。
  }
}

/** 读 git 跟踪的文件内容。 */
function readTracked(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

// ──────────────────────────────────────────────────────────────────────────
// 扫描器 1：API key / token 明文
// ──────────────────────────────────────────────────────────────────────────
test("脱敏门控: git 跟踪文件不得含真实 API key/token 明文", () => {
  // 真实凭证前缀（Anthropic/OpenRouter/OpenAI/GitHub/Google）。
  // 要求前缀后紧跟足够长的字符（≥15），排除占位符如 sk-test、sk-placeholder。
  const TOKEN_PREFIX = "sk-ant-[A-Za-z0-9_-]{15,}|sk-or-[A-Za-z0-9_-]{15,}|sk-[A-Za-z0-9_-]{30,}|gho_[A-Za-z0-9]{36}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|AIza[A-Za-z0-9_-]{35}";
  // 另一类：形如 XXX_API_KEY="..." 带长值（≥20 字符）的引号赋值，排除 <占位符>/${ENV}/空值。
  const KEY_ASSIGN = '(?:API_KEY|TOKEN|SECRET)["\']?\\s*[:=]\\s*["\']([A-Za-z0-9_+/=-]{20,})["\']';

  const VIOLATION = new RegExp(`(?:${TOKEN_PREFIX})|${KEY_ASSIGN}`, "i");
  // 豁免：测试 fixture 里合法的假密钥字面量（非真凭证）。
  const ALLOW = /test-secret|test-key|fake-key|placeholder|example|oauth-token|must-not-be-used|dummy/i;

  for (const f of trackedFiles()) {
    if (f === SELF) continue; // 扫描器定义文件豁免（含 token 前缀正则字面量）
    let txt;
    try { txt = readTracked(f); } catch { continue; } // 子模块/特殊文件跳过
    const matches = [...txt.matchAll(new RegExp(VIOLATION, "gi"))];
    const real = matches.filter((m) => {
      const hit = m[0];
      return !ALLOW.test(hit); // 滤掉 test-secret 等合法 fixture
    });
    assert.equal(real.length, 0,
      `${f} 含疑似真实凭证明文：${real.map((m) => m[0].slice(0, 20) + "...").join(", ")}。` +
      `真实 API key 绝不能进仓库——脱敏（改用 env 引用 ${'${ENV_VAR}'}）或从 git 移除。`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 扫描器 2：本机绝对路径
// ──────────────────────────────────────────────────────────────────────────
test("脱敏门控: git 跟踪文件不得含本机绝对路径（真实 Windows 用户名/真实项目路径）", () => {
  // 只扫"硬泄露"——真实 Windows 用户目录或带空格/真实命名的项目路径。
  // 不扫 D:/projects/my-app 这类文档示例占位符（用户决策：不扫项目名，my-app 是泛化占位符非真实项目）。
  //
  // 硬泄露形态：
  //   1. C:\Users\<真实用户名>（暴露 Windows 账户名——但 C:\Users\<you> 占位符合法）
  //   2. D:\Loster（带空格/真实命名的个人路径结构）
  //   3. 其它盘符下的真实个人路径（如 D:\个人、D:\work\xxx 带中文/真实名）
  const ABS_PATH = /(?:[CD]:[\\/])(?:Users[\\/][a-zA-Z0-9][^<>/?*"|]{2,}(?![<])|Loster|个人|我的)/i;
  // 豁免：C:\Users\<占位符>（<you>/<user> 等，非真实用户名）。
  const ALLOW_PATH = /<[a-z]+>/i;

  for (const f of trackedFiles()) {
    if (f === SELF) continue; // 扫描器定义文件豁免（含正则字面量 + 硬泄露示例文本）
    let txt;
    try { txt = readTracked(f); } catch { continue; }
    const matches = [...txt.matchAll(new RegExp(ABS_PATH, "gi"))];
    const real = matches.filter((m) => {
      const after = txt.slice(m.index, m.index + 40);
      return !ALLOW_PATH.test(after); // 滤掉 <占位符>
    });
    assert.equal(real.length, 0,
      `${f} 含本机绝对路径 \`${real[0]?.[0]}\`（疑似真实用户名/个人路径）。` +
      `改用 <WAO目录>/<目标项目> 或 C:\\Users\\<you> 占位符。`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 扫描器 3：敏感文件被误跟踪（git add -f 绕过 gitignore）
// ──────────────────────────────────────────────────────────────────────────
test("脱敏门控: 敏感文件（agents.json/.env/runs 等）绝不被 git 跟踪", () => {
  // 这些都该 gitignore，但 git add -f 能强制跟踪。门控守"它们绝不该进仓库"。
  const FORBIDDEN = /^(config\/agents\.json$|\.env(\.|$)|runs\/|\.wao-worker-claude-config\/|config\/.*\/agents\.local\.json$)/;

  const tracked = trackedFiles();
  const leaked = tracked.filter((f) => FORBIDDEN.test(f));
  assert.equal(leaked.length, 0,
    `敏感文件被 git 跟踪（应 gitignore）：${leaked.join(", ")}。` +
    `用 git rm --cached <file> 移除跟踪（保留本地文件），它们含本机路径/凭证/run transcript。`);
});
