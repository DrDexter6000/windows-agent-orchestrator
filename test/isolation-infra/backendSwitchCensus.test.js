// test/isolation-infra/backendSwitchCensus.test.js
//
// 2026-10-04 防再生守卫（consult_202610042037269516qqzn9，auditor 阻断项全采纳）：
// continuable 解析器漂移能存活 7 天，是因为"后端闭集"纪律只钉在常量
// （knownBackendsSsot）和工厂（backendCapabilityMatrix）上，而**消费后端身份的
// 分叉点**没有任何机器普查——影子名单既不会被同步也不会红。本 census 把
// "扩员同步面"机器化：src/ 中每一处后端身份字符串（字面比较/冻结集合/查表，
// 不做通用分析器）都登记在案，实际普查必须与登记表逐文件逐名字逐次数相等。
//
// 轴向纪律（auditor）：
//   - full-set-SSOT：必须全知闭集（factory 构造 / registry normalize），由
//     本文件 + capabilityMatrix + knownBackendsSsot 三面交叉钉；
//   - partial-axis：合法子集（每条登记一句"为什么子集是完整的"）；
//   - 另类分类轴（如 stop.js 的 "process" 进程族）不属 KNOWN_BACKENDS，不在
//     本普查的身份串集内。
//
// 普查即抓获：本守卫落地的当天即发现两个同病实例（modelFamily 缺 kimi-web 的
// 展示退化 + registryInventory:108 的硬编码五后端列表——后者现值恰好正确，以
// 注释+census 登记钉住其真实轴向"model 可选后端"）。新后端入列（Owner 决定，
// ADR-0028）时：factory 与 registry 的 full-set 钉在本文件立即红（除非同步），
// 任何新出现的身份串消费点也红——要么登记轴向意图，要么改走 SSOT。
//
// 同步清单权威：docs/certification-runbook.md §扩员同步面。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { KNOWN_BACKENDS } from "../../src/registry.js";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../src");

function dirname(p) {
  return p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
}

/** 纯函数核心：从 {path: content} 提取每文件的身份串多重集（供负证夹具复用）。 */
export function extractIdentityCensus(contentsByName, names) {
  const pattern = new RegExp(`"(${names.join("|")})"`, "g");
  const census = {};
  for (const [file, content] of Object.entries(contentsByName)) {
    const matches = String(content).match(pattern);
    if (!matches) continue;
    const per = {};
    for (const m of matches) {
      const n = m.slice(1, -1);
      per[n] = (per[n] || 0) + 1;
    }
    census[file] = per;
  }
  return census;
}

function walkJs(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
}

// ── 登记表（唯一权威快照；任何 src/ 身份串消费点变动都必须有意识地更新这里） ──
//
// 轴向标注（文件 → 为什么这些名字出现在这里）：
//   backends/<name>.js        — 各自的自身标识（错误前缀/自述），单名。
//   backends/factory.js       — full-set-SSOT：构造闭集（capabilityMatrix 交叉钉）
//                               + SELF_REPORTED_TRANSCRIPT_BACKENDS 冻结集合
//                               （transcript 自报来源轴，现单成员）。
//   registry.js               — full-set-SSOT：normalize 必填字段校验
//                               （knownBackendsSsot 交叉钉；else 臂兜其余成员）。
//   application/backendCliMap.js — CLI 探测映射轴：harness 自管进程的 backend
//                               显式 null（注释在册）；kimi-web（HTTP attach）
//                               与 zcode（registry 提供绝对 binary）不走 PATH
//                               CLI 探测，缺席=缺省 null，合法。
//   application/modelFamily.js  — 族系回退轴：modelId 不可解析时的展示缺省。
//                               kimi-web→kimi（同 kimi-code 族）；zcode 有意
//                               不加（多 provider 宿主，缺省 UNKNOWN 是诚实）。
//   application/registryInventory.js — 模型展示回退轴："(default)" 列表=normalize
//                               不强制 model.id 的后端（恰为五老进程族后端；
//                               kimi-web/zcode 在 normalize 强制 model.id，
//                               故不在列表——见 registryInventory.js:106 注释）。
//   application/runStop.js     — opencode-serve 专属停止语义轴（serve 无进程树）。
//   application/panelReadiness.js / consultService / runCollect / runAwaitResult —
//                               各自的单点能力/投影轴（缺席=缺省臂，合法）。
//   commands/registry.js       — TD-161 已消灭本地闭集数组（import KNOWN_BACKENDS）；
//                               残余字面=按后端差异化展示/校验轴。
//   commands/doctor.js         — doctor 探测映射轴（kimi-web/zcode 无 CLI/key
//                               就绪映射=如实 WARN，在册备忘）。
//   commands/onboarding.js     — opencode-serve 差异化指引轴。
//   envPolicy.js               — env 允许清单轴（各后端凭据/环境变量策略）。
//   hostAdapters/codexMcpConfig.js — codex 宿主适配轴。
//   hostAdapters/hostDescriptors.js — 宿主描述符示例命令轴（claude-code/codex/
//                               zcode 三宿主，非后端全集）。
//   smoke.js                   — 刻意最小探测面（factory.js 头注先例：无 kimi-
//                               code 等亦然，kimi-web/zcode 不入最小面）。
//   owner-dashboard/*          — （当前零身份串；如未来出现按登记）。
const REGISTERED_CENSUS = {
  "application/backendCliMap.js": { "claude-code": 1, codex: 1, "kimi-code": 1, "opencode-serve": 1, "deepseek-harness": 1, "deepseek-acp": 1 },
  "application/modelFamily.js": { codex: 3, "claude-code": 1, "kimi-code": 1, "deepseek-harness": 1, "deepseek-acp": 1, "kimi-web": 1 },
  "application/panelReadiness.js": { "opencode-serve": 1 },
  "application/registryInventory.js": { "claude-code": 1, codex: 1, "kimi-code": 1, "deepseek-harness": 1, "deepseek-acp": 1 },
  "application/runStop.js": { "opencode-serve": 3 },
  // TD-190 R7（2026-10-09）：外国 harness 沙箱闭表条目的 harness 标签——轴向=
  // 沙箱身份标注（桶归属 fact），不选 backend、不分叉运行时行为。
  "projectIdentity.js": { codex: 1 },
  "backends/deepSeekAcp.js": { "deepseek-acp": 1 },
  "backends/deepSeekHarness.js": { "deepseek-harness": 1 },
  "backends/kimiWeb.js": { "kimi-web": 1 },
  "backends/opencodeServe.js": { "opencode-serve": 1 },
  "backends/zcode.js": { zcode: 1 },
  // TD-218 承重 env 声明表（2026-10-06 批漏登，2026-10-07 全量 census 补登）：
  // zcode 车道 file 类承重变量声明的键——轴向=backend 承重配置面。
  "application/loadBearingEnv.js": { zcode: 1 },
  // TD-220 验收修（2026-10-07）：EXIT_CODE_INFERENCE_PROVEN_BACKENDS 闭集成员
  // （数据来源可靠性声明，ADR-0032 §8；runActivityProjection 经它门控推断）。
  "scorecard.js": { "claude-code": 1 },
  // TD-229（2026-10-07）：doctor 5d 认证模式检查按 backend==="claude-code" &&
  // !provider 筛 native worker（轴向=native OAuth 通道识别，非全后端分叉）。
  "commands/doctor.js": { "claude-code": 2, "deepseek-harness": 1, codex: 1, "kimi-code": 1, "opencode-serve": 1 },
  "commands/onboarding.js": { "opencode-serve": 2 },
  "commands/registry.js": { "opencode-serve": 2, "claude-code": 1 },
  // TD-229（2026-10-07）：inheritedEnvNames 对 native 通道（backend==="claude-code"
  // && !provider）追加长期令牌继承名——通道条件派生，非新分叉轴。
  "envPolicy.js": { "claude-code": 4, "kimi-code": 1, "deepseek-harness": 2, "deepseek-acp": 2, zcode: 1, "opencode-serve": 1, "kimi-web": 1 },
  "hostAdapters/codexMcpConfig.js": { codex: 3 },
  "hostAdapters/hostDescriptors.js": { "claude-code": 1, codex: 1, zcode: 1 },
  "smoke.js": { "opencode-serve": 4, "claude-code": 4, codex: 6, "deepseek-harness": 1 },
};

test("census 正身：src/ 后端身份串普查逐文件逐名字逐次数等于登记表（full-set 两文件豁免抄件）", () => {
  const files = [];
  walkJs(SRC_ROOT, files);
  const rel = {};
  const prefixLen = SRC_ROOT.length + 1;
  for (const f of files) rel[f.slice(prefixLen).replace(/\\/g, "/")] = readFileSync(f, "utf8");
  const actual = extractIdentityCensus(rel, [...KNOWN_BACKENDS]);
  // 精化（coder_mm 会审 consult_20261004204955653fko0i0）：full-set-SSOT 两文件
  // （backends/factory.js、registry.js）不进登记表抓名单副本——登记表若嵌入它们
  // 的名字副本，本身就是"第二份手抄真值"病；其成员覆盖由下方 full-set 钉从
  // 真实文件内容派生并与 KNOWN_BACKENDS 机械比对（名单唯一出处仍是
  // src/registry.js）。
  const FULL_SET_FILES = ["backends/factory.js", "registry.js"];
  const expectedKeys = [...Object.keys(REGISTERED_CENSUS), ...FULL_SET_FILES].sort();
  assert.deepEqual(Object.keys(actual).sort(), expectedKeys,
    "普查文件集 = 登记表 ∪ full-set 两文件——新消费点必须登记轴向意图（或改走 SSOT），"
      + "扩员必须同步 factory/registry 的 full-set 面。见本文件头注与 "
      + "docs/certification-runbook.md §扩员同步面。");
  for (const [file, per] of Object.entries(actual)) {
    if (FULL_SET_FILES.includes(file)) continue;
    assert.deepEqual(per, REGISTERED_CENSUS[file], `${file} 的身份串多重集与登记表不符`);
  }
});

test("census full-set 钉：factory 与 registry 的身份串必须覆盖每个 KNOWN_BACKENDS 成员（扩员即红；派生不抄名单）", () => {
  // 从真实 src 文件内容派生（不读登记表——名单唯一出处 = KNOWN_BACKENDS）。
  for (const file of ["backends/factory.js", "registry.js"]) {
    const content = readFileSync(join(SRC_ROOT, file), "utf8");
    const per = extractIdentityCensus({ [file]: content }, [...KNOWN_BACKENDS])[file] ?? {};
    for (const name of KNOWN_BACKENDS) {
      assert.ok((per[name] ?? 0) >= 1,
        `${file} 缺 "${name}" —— full-set-SSOT 消费点必须全知闭集（扩员时同步，否则本钉即红）`);
    }
  }
});

// ── 负证三条（auditor 最低反证）──────────────────────────────────────────────

test("census 负证①：未登记的新消费点 → 红（fixture）", () => {
  const fixture = { "src/some/newSite.js": 'if (agent.backend === "codex") { go(); }' };
  const got = extractIdentityCensus(fixture, ["codex", "kimi-web"]);
  assert.deepEqual(got, { "src/some/newSite.js": { codex: 1 } },
    "新消费点会出现在普查里而登记表没有 → 正身测试红");
});

test("census 负证②：同文件删一处名字、增另一处名字（总数不变）→ 多重集仍变 → 红（fixture）", () => {
  const before = extractIdentityCensus({ "a.js": '"codex" "codex"' }, ["codex", "kimi-web"]);
  const after = extractIdentityCensus({ "a.js": '"codex" "kimi-web"' }, ["codex", "kimi-web"]);
  assert.deepEqual(before, { "a.js": { codex: 2 } });
  assert.deepEqual(after, { "a.js": { codex: 1, "kimi-web": 1 } });
  assert.notDeepEqual(before, after, "换名不逃普查——多重集（名字×次数）而非总数");
});

test("census 负证③：KNOWN_BACKENDS 扩员、full-set 消费点未同步 → 红（fixture）", () => {
  const expanded = [...KNOWN_BACKENDS, "backend-nine"];
  const staleFactory = { "backends/factory.js": '"codex" "kimi-web"' };
  const per = extractIdentityCensus(staleFactory, expanded)["backends/factory.js"];
  const missing = expanded.filter((n) => (per?.[n] ?? 0) < 1);
  assert.ok(missing.length > 0, "扩员后旧消费点缺新成员 → full-set 钉红");
});
