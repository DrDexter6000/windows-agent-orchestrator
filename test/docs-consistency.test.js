// docs-consistency.test.js
//
// SSOT 不变量守卫。本文件防止文档间重新漂移：
//   - 端口号、transcript 事件表、registry 角色、技术债编号 等
//     只允许有一个权威定义，其余位置必须与之一致。
//
// 规则（与 milestone-discipline.md §6.3 一致）：审计要逐文件，
// 这些断言把"逐文件核对"固化为可执行检查，防止回归。
//
// 失败含义：某份文档与权威来源不一致 → 修文档（不是修测试）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/** 读取仓库内文件（相对 ROOT 的路径），返回字符串。 */
function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** 收集所有 opencode-serve serveUrl 端口（形如 :4297）。 */
function collectServePorts(text) {
  const out = [];
  for (const m of text.matchAll(/serveUrl[^:]*:\s*"https?:\/\/[^:]+:(\d+)"/g)) {
    out.push(m[1]);
  }
  return out;
}

test("docs-consistency harness: 能读取文档并断言", () => {
  // 平凡绿：证明载体本身可用。
  assert.ok(read("AGENTS.md").includes("WAO Repository Contract"));
});

test("research/README 不再把 M5/M6 标为未开始（与 roadmap 矛盾）", () => {
  const txt = read("docs/research/README.md");
  // roadmap 已标 M5/M6 完成；research/README 不得保留陈旧的"未开始"。
  assert.ok(!/M5.*未开始|M5.*⬜/.test(txt), "research/README 仍把 M5 标为未开始");
  assert.ok(!/M6.*未开始|M6.*⬜/.test(txt), "research/README 仍把 M6 标为未开始");
  // 必须指向 roadmap 作为进度权威源。
  assert.ok(/roadmap/.test(txt), "research/README 未指向 roadmap.md 作为进度权威源");
});

test("mN-audit 已归档到 docs/archive/，不得再以旧路径 docs/m6-audit.md 出现", () => {
  // A2（归档）：m0~m6-audit 是里程碑历史快照，归入 docs/archive/ 过程类别。
  // 旧路径不得再有同名文件（避免双份并存漂移）。
  assert.ok(!existsSync(join(ROOT, "docs", "m6-audit.md")),
    "docs/m6-audit.md 仍存在于旧路径（应已归档到 docs/archive/）");
  assert.ok(existsSync(join(ROOT, "docs", "archive", "m6-audit.md")),
    "docs/archive/m6-audit.md 不存在（归档未完成）");
});

test("docs/archive/ 必须有 README 标注冻结（过程类别的地图文件）", () => {
  // SSOT §1.4：archive 是过程类别子目录，按"文件夹+地图文件"规范必须有 README。
  // README 必须声明"非现行契约源"并指向当前契约（02-architecture / tech-debt）。
  assert.ok(existsSync(join(ROOT, "docs", "archive", "README.md")),
    "docs/archive/README.md 不存在（过程类别子目录缺地图文件）");
  const readme = read("docs/archive/README.md");
  assert.ok(/冻结|历史快照|非现行契约/.test(readme),
    "docs/archive/README.md 未声明冻结/历史快照性质");
  assert.ok(/02-architecture\.md|tech-debt\.md/.test(readme),
    "docs/archive/README.md 未指向当前契约源");
});

test("归档的 m6-audit 不再把 TD-33 描述为 'parts schema 实测未知'（research/07 已勘测完毕）", () => {
  const txt = read("docs/archive/m6-audit.md");
  // research/07 标题即"TD-33 勘测完毕"——schema 已知。
  // m6-audit 不得以"未知"作为未做理由（理由应是"待实现 parser"）。
  // 归档后此断言仍保留：历史快照的事实错误也需修正（SSOT 铁律 3 允许修正事实错误）。
  assert.ok(
    !/parts schema[^。]*未知/.test(txt) && !/实测未知/.test(txt),
    "m6-audit 仍把 TD-33 schema 描述为未知，与 research/07 矛盾"
  );
});

test("面向用户的文档 serveUrl 端口必须统一为 4297（opencode 默认）", () => {
  // 权威：opencode 默认端口 4297。
  // 例外的 config/agents.json 是 gitignored 本地文件，不纳入断言。
  const FILES = [
    "config/agents.example.json",
    "SKILL.md",
    "docs/usage.md",
    "docs/smoke-guide.md",
    "README.md",
  ];
  for (const f of FILES) {
    const ports = collectServePorts(read(f));
    for (const p of ports) {
      assert.equal(
        p, "4297",
        `${f} 出现非 4297 的 serveUrl 端口（${p}）。面向用户文档统一用 opencode 默认 4297；本机真实端口属配置私事，不进文档。`
      );
    }
  }
});

test("技术债有唯一登记表 docs/tech-debt.md", () => {
  // SSOT 要求：TD-XX 只允许一个权威清单。
  assert.ok(
    read("docs/tech-debt.md").length > 0,
    "缺少 docs/tech-debt.md（统一技术债登记表）"
  );
});

test("面向 agent 的文档命令调用形式必须统一为 `npm run cli --`，不得出现裸 `node .../src/cli.js <真命令>`", () => {
  // SSOT 铁律补维：命令调用形式这一维此前从未被铁律或测试覆盖，
  // 导致权威源自己都漂（fresh-agent 照抄 onboarding 的 `node <WAO>/src/cli.js`
  // 在 v24 默认环境下被 version guard 拒，且文档从未提到正确的 `npm run cli` 入口）。
  // 本断言把"命令形式一致"从 prose 铁律变成机器不变量——凡依赖 agent 自觉遵守
  // prose 的约束都会漂，落到确定性测试里才守得住（WAO 反复验证过的元教训）。
  //
  // 命令形式权威源：`npm run cli -- <command>`（走 v22 shim scripts/wao-node.cjs）。
  // 违规：`node src/cli.js run ...` / `node <WAO>/src/cli.js wao init`（真命令直接调）。
  // 合法保留：(a) `node src/cli.js help`/`--help`（version guard 豁免 help，合法直调）；
  //          (b) 解释性"不要直调"注记（`do not call node src/cli.js` / `不要直接 ...`）。
  const FILES = [
    "AGENT_ONBOARDING.md",
    "SKILL.md",
    "README.md",
    "docs/usage.md",
    "docs/troubleshooting.md",
    "docs/smoke-guide.md",
  ];
  // 真命令 token（任何能真触发 version guard 的子命令）。
  const REAL_CMD = "run|spawn|retry|resume|status|tail|collect|stop|runs|workflow|worktree|wao|daemon|registry";
  // 命中：node [可选路径/]src/cli.js 后紧跟一个真命令（中间允许空格）。
  // 不命中：help/--help（豁免）、以及 `do not call`/`不要直接` 等否定语境。
  const VIOLATION = new RegExp(`node\\b[^\\n]*?src/cli\\.js\\s+(${REAL_CMD})\\b`, "i");

  for (const f of FILES) {
    const txt = read(f);
    const m = txt.match(VIOLATION);
    assert.ok(!m,
      `${f} 出现裸 \`${m?.[0]}\` 直调（${m?.[1]} 是真命令）。` +
      `面向 agent 的文档命令必须统一用 \`npm run cli -- <command>\`（v22 shim）：` +
      `系统默认 node 常是 v24，裸 \`node .../src/cli.js <真命令>\` 会被 version guard 拒。`
    );
  }
});

test("docs/tech-debt.md 覆盖所有仍开放的技术债编号", () => {
  const td = read("docs/tech-debt.md");
  // 这些是从 m0~m6 audit 里 findstr 出的、当前仍开放（未偿还）的编号。
  // 偿还后再登记/标 ✅ 即可；本断言只要求"存在该编号条目"。
  for (const id of ["TD-22", "TD-23", "TD-24", "TD-27", "TD-28", "TD-29", "TD-30", "TD-31", "TD-32", "TD-33"]) {
    assert.ok(td.includes(id), `docs/tech-debt.md 缺少 ${id}`);
  }
});

test("docs/tech-debt.md 记录二次 dogfood 暴露的 TD-54~TD-58", () => {
  const td = read("docs/tech-debt.md");
  for (const id of ["TD-54", "TD-55", "TD-56", "TD-57", "TD-58"]) {
    assert.ok(td.includes(id), `docs/tech-debt.md 缺少 ${id}`);
  }
});

test("README.md 不得保留 M0 时期的陈旧 scope 声明（与现能力矛盾）", () => {
  const txt = read("README.md");
  // 这些是 M0 阶段的 "out of scope" 声明，现均已实现（M2 claude/codex）。
  // 留着会让新读者误判项目能力。
  assert.ok(
    !/Claude\/Codex\/Kimi process backends/i.test(txt) &&
    !/OpenCode serve v2 backend only/i.test(txt),
    "README 仍含 M0 陈旧 scope（仅 opencode / claude·codex out-of-scope），与 M2 后实现矛盾"
  );
});

test("README.md 不得保留已证伪的 opencode endpoint 结论", () => {
  const txt = read("README.md");
  // 历史笔记断言 /prompt 不产出 message —— 现代码用 prompt_async + /message 正常工作。
  assert.ok(
    !/did not produce collectable/i.test(txt),
    "README 仍含 '/prompt 不产出 message' 的过时结论（现用 prompt_async + /message）"
  );
});

test("spec 顶层状态不得再自称草稿/第一稿（M0-M6 已实现，契约层稳定）", () => {
  const spec = read("docs/02-architecture.md");
  // 取文件头部 8 行（状态行区）。M0-M6 全部落地后，spec 契约层稳定，
  // 不应再标"🟡 第一稿 / 草稿"误导读者以为还在设计期。
  const head = spec.split("\n").slice(0, 8).join("\n");
  assert.ok(!/第一稿|🟡.*草稿|草稿.*待实现/.test(head), "spec 顶层仍自称草稿/第一稿，与实现进度不符");
});

test("SKILL.md 按需指向 opencode 运维避坑，正文不复制事故清单", () => {
  const skill = read("SKILL.md");
  const pitfalls = read("references/opencode-pitfalls.md");
  assert.ok(skill.includes("references/opencode-pitfalls.md"), "SKILL.md 缺 opencode 按需指针");
  const must = [
    { kw: /provider|providerID/i, why: "provider id 错配（如 deepseek 写成 deepseek-coding-plan）导致 401" },
    { kw: /port|端口|4297/i, why: "serveUrl 端口必须与 opencode serve --port 实际一致" },
    { kw: /oh-my-openagent|OmO|Maestro System Context|杂草/i, why: "OmO 插件往 session 注入 Maestro context，是 talking-cli 域杂草" },
    { kw: /first-stable|无限|循环|重复确认/i, why: "DeepSeek-v4-flash 回答后无限重复，需 completionMode: first-stable" },
  ];
  for (const { kw, why } of must) {
    assert.ok(kw.test(pitfalls), `opencode-pitfalls.md 缺少运维项（${why}）`);
  }
});

test("spec §7 目录结构不得把未实现的文件当作已存在列出", () => {
  const spec = read("docs/02-architecture.md");
  // scheduler.js 与 workflow/dag.js 从未实现（roadmap 无对应 milestone）。
  // spec 不得把它们当作既有文件列出而不标注未实现。
  // 允许的形态：出现该名但前后合理窗口内含"未实现"/"（规划）"等标注。
  function assertNotPresentedAsExisting(name) {
    let from = 0;
    while (true) {
      const idx = spec.indexOf(name, from);
      if (idx === -1) break;
      // 名字前后各看一段上下文（标注可能在名字前或后）。
      const ctx = spec.slice(Math.max(0, idx - 80), idx + name.length + 80);
      assert.ok(
        /未实现|规划|未建|暂未|无独立|不存在/.test(ctx),
        `spec 把 ${name} 当作既有文件列出却未标注"未实现"`
      );
      from = idx + name.length;
    }
  }
  assertNotPresentedAsExisting("scheduler.js");
  assertNotPresentedAsExisting("workflow/dag.js");
  assertNotPresentedAsExisting("dag.js");
});

test("transcript 事件表单一权威：usage.md 必须是完整权威，SKILL.md 不得维护并行的事件清单", () => {
  // SSOT：transcript 事件类型清单只允许一份完整定义。
  // 权威 = docs/usage.md §三（人读完整表）+ docs/02-architecture.md §3.2（spec 契约）。
  // SKILL.md 若也维护一份完整事件表，必然与 usage 漂移（已经漂移过）。
  // 规则：SKILL.md 的 transcript 段必须指向 usage，不得自己列全量事件表。
  const skill = read("SKILL.md");
  const usage = read("docs/usage.md");
  // usage 必须含完整事件集（含 M3+M5+M6+M10-pre 新增的）。
  for (const ev of ["run.event", "scorecard.checked", "run.rerun", "run.cleanup_done", "run.wait_policy", "run.stop_verified", "run.stop_unverified"]) {
    assert.ok(usage.includes(ev), `usage.md transcript 表缺事件 ${ev}（应是完整权威）`);
  }
  // SKILL 不得再维护并行全量表（不得同时列 run.rerun 与 run.event 等做"完整清单"）。
  // 允许 SKILL 提及个别事件名，但不得做成"事件表"。用一个代理信号：
  // SKILL 若含 usage 不指向，且同时出现 4+ 个 run.* 事件名 → 视为并行表。
  const skillEvents = (skill.match(/run\.[a-z_]+/g) || []);
  const uniqueSkillEvents = [...new Set(skillEvents)];
  // 6 是宽松上限（命令示例里自然会出现 run.completed 等少数）；完整表会到 10+。
  assert.ok(
    uniqueSkillEvents.length < 10 || /usage\.md|详见|see docs\/usage/.test(skill),
    `SKILL.md 维护了 ${uniqueSkillEvents.length} 个 run.* 事件（疑似并行事件表），应指向 usage.md`
  );
});

test("SKILL.md 必须在正文最前显式声明 lead 角色与职责链", () => {
  // 没有角色定义，coding agent 装了技能也会退回单体模式（不编排/不派发/不验收）。
  // 身份声明必须紧跟 frontmatter（agent 加载技能后读到的第一段）。
  const skill = read("SKILL.md");
  const head = skill.slice(0, 2000); // 只看开头，确保是"最先读到"的位置
  // 身份：你是主控/编排者
  assert.ok(/主控|Lead Operator|编排者|operator/i.test(head), "SKILL.md 开头未声明 lead 身份");
  // 职责链关键动词
  for (const kw of ["understanding", "orchestration", "dispatch", "acceptance", "integration", "reporting"]) {
    assert.ok(head.includes(kw), `SKILL.md 开头缺职责链环节：${kw}`);
  }
  // 边界：worker/副主控不消费此技能（防误读）
  assert.ok(/worker.*不|副主控.*不|不是给你的|Workers and auditors do not load this skill/i.test(head), "SKILL.md 未声明 worker/副主控不消费此技能");
});

test("troubleshooting.md 存在且 SKILL.md 指向它（运维诊断层）", () => {
  // troubleshooting.md 是按需读取的诊断层，SKILL pitfalls 末尾必须指向它。
  const ts = read("docs/troubleshooting.md");
  assert.ok(ts.length > 500, "docs/troubleshooting.md 太短或缺失");
  // 必须含症状索引 + 各故障域（provider/cli/cwd/runs）
  assert.ok(/快速索引/.test(ts), "troubleshooting.md 缺快速索引");
  assert.ok(/provider 故障/.test(ts), "troubleshooting.md 缺 provider 章节");
  // SKILL 必须指向 troubleshooting
  const skill = read("SKILL.md");
  assert.ok(/troubleshooting\.md/.test(skill), "SKILL.md 未指向 troubleshooting.md");
});

test("AGENTS.md 保持薄入口，不复制易漂移的文件清单", () => {
  const a = read("AGENTS.md");
  assert.ok(!/## Project structure/.test(a), "AGENTS.md 不应维护 Project structure 副本");
  assert.ok(a.includes("docs/02-architecture.md"), "AGENTS.md 缺 architecture 权威指针");
  assert.ok(a.includes("docs/roadmap.md"), "AGENTS.md 缺 roadmap 权威指针");
});

test("AGENTS.md 不得用旧的 claude_worker/codex_worker 角色名（已角色化）", () => {
  const a = read("AGENTS.md");
  // example registry 已角色化对齐 team-roles.md（researcher/coder_hq/coder_low/coder_mm/tester/auditor）。
  // AGENTS.md 不得再引用旧命名作"角色示例"。
  assert.ok(
    !/claude_worker|codex_worker/.test(a),
    "AGENTS.md 仍引用旧角色名 claude_worker/codex_worker（应为 researcher/coder_hq/...）"
  );
});

test("面向 lead/user 的入口文档不得再使用旧 worker 示例名", () => {
  const files = [
    "README.md",
    "SKILL.md",
    "docs/usage.md",
    "docs/smoke-guide.md",
    "docs/troubleshooting.md",
    "docs/02-architecture.md",
    "AGENT_ONBOARDING.md",
  ];
  for (const file of files) {
    const txt = read(file);
    assert.ok(
      !/claude_worker|codex_worker|glm_worker|coder_deepseek_claude|coder_strict|coder_glm_claude|coder_multimodal/.test(txt),
      `${file} 仍引用旧 worker 示例名；第三方 lead 应看到当前角色化 worker（researcher/coder_hq/coder_low/coder_mm/tester/auditor）`
    );
  }
});

test("AGENT_ONBOARDING.md 最小安装闭环必须使用当前角色和显式 cwd/registry", () => {
  const txt = read("AGENT_ONBOARDING.md");
  assert.ok(!/coder_strict|coder_glm_claude/.test(txt), "onboarding 不得再引用已不存在的 coder_strict/coder_glm_claude");
  assert.ok(txt.includes("runtime 的 skill 目录"), "onboarding 必须明确 skill 安装到 runtime skill 目录");
  assert.ok(txt.includes("coder_low"), "onboarding 最小闭环应使用当前 registry 的 coder_low");
  assert.ok(txt.includes("--cwd <目标项目>"), "onboarding 最小闭环必须显式传 --cwd <目标项目>");
  assert.ok(txt.includes("--registry <WAO目录>/config/agents.json"), "onboarding 最小闭环必须显式传 --registry <WAO目录>/config/agents.json");
  const h2s = [...txt.matchAll(/^## 4\./gm)];
  assert.equal(h2s.length, 1, "onboarding 不应有重复的 ## 4 章节编号");
});

test("SKILL.md 开头必须说明 WAO 的当前目标、上线边界和认证驱动调度", () => {
  const head = read("SKILL.md").slice(0, 3500);
  for (const kw of ["deterministic control plane", "real worker tasks", "supervised production trial", "certified", "strict-dispatch"]) {
    assert.ok(head.includes(kw), `SKILL.md 开头缺少第三方 lead 首读关键信息：${kw}`);
  }
  assert.ok(/Claude Code-first|Claude Code first|Claude-first|Claude Code process workers are the default coding lane/i.test(head), "SKILL.md 开头未声明当前 Claude Code-first 调度策略");
});

test("活文档页首状态必须反映 M0-M10 当前能力（usage + architecture），不得停留在 M0-M9 或更早", () => {
  const usage = read("docs/usage.md");
  const usageHead = usage.slice(0, 1200);
  const arch = read("docs/02-architecture.md");
  const archHead = arch.slice(0, 1200);
  // 两个活文档页首都必须说明当前 M0-M10 能力
  assert.ok(/M0.M10|M0–M10|M0-M10/.test(usageHead), "usage.md 顶部未说明当前 M0-M10 能力");
  assert.ok(/M0.M10|M0–M10|M0-M10/.test(archHead), "02-architecture.md 顶部未说明当前 M0-M10 能力");
  // 两个活文档页首都不得继续把当前能力写成 M0-M9（或更早 M0-M4/M0-M6/M0-M8）
  assert.ok(!/M0.M9|M0–M9|M0-M9/.test(usageHead), "usage.md 顶部仍自称 M0-M9 能力（应为 M0-M10）");
  assert.ok(!/M0.M9|M0–M9|M0-M9/.test(archHead), "02-architecture.md 顶部仍自称 M0-M9 能力（应为 M0-M10）");
  assert.ok(!/M0.M4|M0–M4|M0-M4|M0.M6|M0–M6|M0-M6|M0.M8|M0–M8|M0-M8/.test(usageHead),
    "usage.md 顶部仍停留在 M0-M4/M0-M6/M0-M8");
  assert.ok(!/M5 daemon/.test(usage), "usage.md 仍把 daemon 误写成 M5，roadmap 中 daemon 属 M7");
});

test("PRD 顶部不得再自称第一稿；状态权威必须指向 roadmap", () => {
  const prd = read("docs/01-prd.md");
  const head = prd.slice(0, 1000);
  assert.ok(!/第一稿|待用户 review|待写/.test(head), "PRD 顶部仍是早期第一稿状态");
  assert.ok(/roadmap\.md/.test(head), "PRD 顶部未指向 roadmap.md 作为当前进度权威源");
});

test("历史 dispatch NO-GO 记录必须显式标注已被新认证结果取代", () => {
  const review = read("docs/research/09-dispatch-readiness-review.md");
  const head = review.slice(0, 1200);
  assert.ok(/superseded|已取代|已过期|历史记录/i.test(head), "09-dispatch-readiness-review 未在开头标注 NO-GO 已是历史记录");
  assert.ok(/10-runtime-driver-comparison|roadmap|reliability-summary/.test(head), "09-dispatch-readiness-review 未指向当前认证/状态权威");
});

test("workflow gate requiredClaims 格式由 architecture 单点定义", () => {
  const arch = read("docs/02-architecture.md");
  assert.ok(
    /requiredClaims.*nodeId\.field|nodeId\.field.*requiredClaims/.test(arch),
    "02-architecture.md 缺 gate requiredClaims 的 nodeId.field 契约"
  );
  assert.ok(!read("SKILL.md").includes("requiredClaims"), "SKILL.md 不应复制 workflow 字段契约");
});

test("opencode stop 安全边界不得保留 TD-37/TD-38 修复前的陈旧文案", () => {
  const files = ["README.md", "SKILL.md", "docs/usage.md", "docs/troubleshooting.md"];
  const stale = [
    /backendStopQuiet[^。\n]*(当前未认证|未认证|false\/absent)/i,
    /直到\s*`?backendStopQuiet`?\s*认证通过/i,
    /intentionally fails[^。\n]*backendStopQuietVerified/i,
    /Do not include it[^。\n]*until TD-37 is fixed/i,
    /TD-38[^。\n]*(未 quiet-verified|not quiet-verified)/i,
    /真正后台存活需要 M7 daemon/i,
  ];
  for (const file of files) {
    const txt = read(file);
    for (const pattern of stale) {
      assert.ok(!pattern.test(txt), `${file} 仍保留 TD-37/TD-38 修复前的陈旧 stop 文案：${pattern}`);
    }
  }

  const comparison = read("docs/research/10-runtime-driver-comparison-2026-06-18.md");
  assert.ok(
    !/stop-auditable jobs/i.test(comparison),
    "runtime driver comparison 仍把 opencode 描述为 stop-auditable jobs，和 TD-37 矛盾"
  );
});

test("M7/M8/M9 当前状态不得在活文档里回退为未开始或旧测试基线", () => {
  const roadmap = read("docs/roadmap.md");
  const progress = roadmap.split("## 进度跟踪")[1] ?? "";
  assert.ok(/\| M7 \| ✅/.test(progress),
    "roadmap.md 进度跟踪里的 M7 行必须显示已完成");
  assert.ok(/archive\/m7-phases\.md/.test(progress),
    "roadmap.md M7 行必须指向已归档的 docs/archive/m7-phases.md");
  assert.ok(/M8/.test(roadmap) && /✅/.test(roadmap),
    "roadmap.md 必须反映 M8 已完成的当前状态");
  assert.ok(/\| M9 \| ✅ 完成/.test(progress),
    "roadmap.md M9 行必须显示已完成");

  const ssot = read("docs/ssot.md");
  for (const stale of ["当前 39 个 md", "npm test 372", "15 条断言", "15 assertions"]) {
    assert.ok(!ssot.includes(stale), `docs/ssot.md 仍保留旧审计基线：${stale}`);
  }

  const techDebt = read("docs/tech-debt.md");
  const openSection = (techDebt.split("## 开放")[1] ?? "").split("## 设计性约束")[0] ?? "";
  assert.ok(!/TD-52|TD-53/.test(openSection),
    "tech-debt.md 仍把 TD-52/TD-53 留在开放区，但条目语义已是已偿还");
  // TD-106 must be in open section, not in repaid section.
  const repaidSection = (techDebt.split("## 已偿还")[1] ?? "").split("## 开放")[0] ?? "";
  assert.ok(!/TD-106/.test(repaidSection),
    "tech-debt.md TD-106 must not be in repaid section");
  assert.ok(/TD-106/.test(openSection),
    "tech-debt.md TD-106 must be in open section");
});

test("历史 SSOT 审计和 M7 phase 文档必须归档，不得继续作为 docs 根目录活文档", () => {
  assert.ok(!existsSync(join(ROOT, "docs", "docs-ssot-audit.md")),
    "docs/docs-ssot-audit.md 仍在 docs 根目录；过程审计应归档到 docs/archive/");
  assert.ok(existsSync(join(ROOT, "docs", "archive", "docs-ssot-audit.md")),
    "docs/archive/docs-ssot-audit.md 不存在");

  assert.ok(!existsSync(join(ROOT, "docs", "m7-phases.md")),
    "docs/m7-phases.md 仍在 docs 根目录；M7 已完成，应归档为历史 phase 计划");
  assert.ok(existsSync(join(ROOT, "docs", "archive", "m7-phases.md")),
    "docs/archive/m7-phases.md 不存在");

  const archiveReadme = read("docs/archive/README.md");
  assert.ok(/m7-phases\.md/.test(archiveReadme), "docs/archive/README.md 未列出 m7-phases.md");
  assert.ok(/docs-ssot-audit\.md/.test(archiveReadme), "docs/archive/README.md 未列出 docs-ssot-audit.md");
});

test("agents.example.json 角色对齐 team-roles.md（决策 0005 SSOT）", () => {
  // SSOT 铁律：team-roles.md 是角色权威源，agents.example.json 必须与之对齐。
  // 决策 0005：默认进程式 backend，opencode 降为 fallback。主 worker 必须是进程式。
  const raw = read("config/agents.example.json");
  const parsed = JSON.parse(raw);
  // 5 个角色 worker 必须存在且进程式（coder_hq/coder_low/coder_mm/researcher/tester）
  const ROLE_WORKERS = ["researcher", "coder_hq", "coder_low", "coder_mm", "tester"];
  for (const id of ROLE_WORKERS) {
    const w = parsed.agents?.[id];
    assert.ok(w, `agents.example.json 缺角色 worker: ${id}（team-roles.md 定义的角色必须配置）`);
    assert.notEqual(w.backend, "opencode-serve",
      `${id} 不得用 opencode-serve（决策 0005：主 worker 进程式，opencode 降级 fallback）`);
  }
  // coder_mm 必须是 kimi-code 且不带 --yolo
  const mm = parsed.agents?.coder_mm;
  assert.equal(mm.backend, "kimi-code", "coder_mm 必须是 kimi-code（多模态，进程式）");
  assert.ok(
    !(Array.isArray(mm.args) && mm.args.includes("--yolo")),
    "coder_mm 不得带 --yolo args（kimi -p 模式互斥，会导致 run failed）"
  );
  // opencode worker 必须显式标注为 fallback（不得混在主角色里不标）
  const opencodeWorkers = Object.entries(parsed.agents)
    .filter(([, w]) => w.backend === "opencode-serve")
    .map(([id]) => id);
  for (const id of opencodeWorkers) {
    const w = parsed.agents[id];
    assert.ok(/fallback|FALLBACK/.test(JSON.stringify(w)),
      `opencode worker ${id} 必须在 _comment 标注 fallback（决策 0005，不得无声混入）`);
  }
});

test("SSOT 分类标准存在：docs/ssot.md 是文档体系的权威类别定义", () => {
  // docs/ssot.md 定义五大类别（契约/决策/运维/过程/调研）+ 三条铁律。
  // 它是"写新文档前必读"的入口，缺失等于文档体系无分类约束。
  const ssot = read("docs/ssot.md");
  assert.ok(ssot.length > 0, "缺少 docs/ssot.md（文档 SSOT 分类标准）");
  for (const cat of ["契约", "决策", "运维", "过程", "调研"]) {
    assert.ok(ssot.includes(cat), `docs/ssot.md 缺少类别定义：${cat}`);
  }
  // 三条铁律必须存在
  for (const rule of ["一处定义，处处指针", "类别不可混放", "过程文档只追加"]) {
    assert.ok(ssot.includes(rule), `docs/ssot.md 缺少铁律：${rule}`);
  }
});

test("AGENTS.md 必须在写新文档前指向 SSOT 分类标准", () => {
  // AGENTS.md 只保留入口和默认动作；分类与铁律正文只在 docs/ssot.md 定义。
  const a = read("AGENTS.md");
  assert.ok(/docs\/ssot\.md/.test(a), "AGENTS.md 未指向 docs/ssot.md（文档分类标准）");
  assert.ok(/Before adding or editing documentation/.test(a), "AGENTS.md 缺文档变更入口");
  assert.ok(/update the existing authority by default/.test(a), "AGENTS.md 缺默认更新现有权威源的动作");
  for (const copiedRule of ["一处定义，处处指针", "类别不可混放", "过程文档只追加"]) {
    assert.ok(!a.includes(copiedRule), `AGENTS.md 不应复制 docs/ssot.md 铁律：${copiedRule}`);
  }
});

test("状态机完整状态列表只在 02-architecture.md 权威定义，不外泄到其余契约文件", () => {
  // 铁律 1：一处定义，处处指针。状态机的完整状态链（含 pending→submitted→running 全序列）
  // 全文只允许出现在 02-architecture.md。其余契约文件（PRD/SKILL/AGENTS）只许提"状态机"
  // 概念 + 指针，不许复制完整状态链（这是 06-23 审计发现的核心重复源）。
  // 注：research/ 与 mN-audit.md 是过程/调研类（冻结快照），允许保留历史定义。
  const FULL_STATE_CHAIN = /pending[^}\]]{0,40}submitted[^}\]]{0,40}running/i;
  const CONTRACT_FILES = [
    "docs/01-prd.md",
    "SKILL.md",
    "AGENTS.md",
    "docs/team-roles.md",
  ];
  for (const f of CONTRACT_FILES) {
    const txt = read(f);
    assert.ok(
      !FULL_STATE_CHAIN.test(txt),
      `${f} 包含完整状态机状态链（pending→submitted→running）——应只指针指向 02-architecture.md，不复制正文（SSOT 铁律 1）`
    );
  }
  // 权威源必须确实定义了完整状态链。
  const arch = read("docs/02-architecture.md");
  assert.ok(FULL_STATE_CHAIN.test(arch),
    "docs/02-architecture.md 缺少完整状态机状态链定义（应是唯一权威源）");
});

test("daemon 运行时状态查 CLI（daemon ping/list），不查 .wao/（D-F4 决策固化）", () => {
  // D-F4（research/14）：agent 直觉去 .wao/ 找 daemon 状态会扑空——.wao/ 5 槽位锁死、
  // 不存运行时状态。决策：daemon.json + .owner-<runId> 都在 runDir，agent 经 CLI 查
  // （daemon ping/list/status），不翻 .wao/。SKILL 必须显式固化这个约定，防回归。
  const skill = read("SKILL.md");
  assert.ok(
    /not `\.wao\/`/i.test(skill) || /不查\s*`?\.wao\/?`?/i.test(skill),
    "SKILL.md daemon 段必须显式说明：daemon 状态查 CLI（daemon ping/list），不查 .wao/（D-F4 决策）"
  );
});

test("M8 scorecard 默认 warn 语义固化（SKILL+architecture 不得回退为 opt-in）", () => {
  // M8-1：scorecard 从 opt-in 升级为默认 warn。SKILL + architecture 必须反映此语义，
  // 防文档漂移回 "opt-in hard gate"。
  const skill = read("SKILL.md");
  assert.ok(/default.{0,4}warn|--scorecard-mode/i.test(skill),
    "SKILL.md scorecard 段必须体现 M8-1 默认 warn 语义 + --scorecard-mode 开关");
  const arch = read("docs/02-architecture.md");
  assert.ok(/默认 warn|mode.*warn|scorecard-mode/i.test(arch),
    "02-architecture.md 必须反映 M8-1 scorecard 默认 warn 语义");
});

test("CLI 命令由 help 暴露，workflow 节点由 architecture 定义", () => {
  const skill = read("SKILL.md");
  assert.ok(/npm run cli -- help/.test(skill), "SKILL.md 必须指向动态 CLI help");
  const arch = read("docs/02-architecture.md");
  assert.ok(/integrator/i.test(arch), "02-architecture.md 节点处理器清单必须含 integrator（M8-5）");
});

test("provider-wrapped claude-code worker 必须记录 OAuth 覆盖 provider key 的排查入口", () => {
  const troubleshooting = read("docs/troubleshooting.md");
  assert.ok(/CLAUDE_CONFIG_DIR/.test(troubleshooting),
    "troubleshooting.md 必须说明 provider wrapper 用 CLAUDE_CONFIG_DIR 隔离 Claude OAuth 凭证");
  assert.ok(/claudeAiOauth|OAuth.*provider key|provider key.*OAuth/i.test(troubleshooting),
    "troubleshooting.md 必须记录 claude-code OAuth 登录态会覆盖 provider key 的故障模式");

  const onboarding = read("AGENT_ONBOARDING.md");
  assert.ok(/CLAUDE_CONFIG_DIR|OAuth.*provider/i.test(onboarding),
    "AGENT_ONBOARDING.md 必须提醒首装 agent provider worker 与 Claude OAuth 凭证隔离");
});

test("SKILL.md scorecard 示例必须推荐 --scorecard-rules-file，避免 PowerShell/npm inline JSON", () => {
  const skill = read("SKILL.md");
  assert.ok(/--scorecard-rules-file/.test(skill),
    "SKILL.md scorecard 示例必须出现 --scorecard-rules-file");
  assert.ok(!/MUST escape double quotes|single-quote JSON gets eaten|--scorecard-rules "\\{\\\\"/.test(skill),
    "SKILL.md 不得继续推荐失效的 PowerShell inline JSON 转义示例");
});

test("registry list/check/validate 三命令分工必须在入口文档一致", () => {
  const marker = "registry list = inventory + certification status; registry validate = static schema; registry check = live opencode health";
  for (const file of ["README.md", "SKILL.md", "AGENT_ONBOARDING.md"]) {
    assert.ok(read(file).includes(marker),
      `${file} 缺少 registry 三命令一致分工说明：${marker}`);
  }
});

test("tech-debt.md 已偿还 TD 每条必须填'偿还信息'（TD-81：偿还声明一致性机器守卫）", () => {
  // 元发现（2026-07-02 核实 friction log 时挖出）：TD 表"已偿还"声明 vs 代码事实之间
  // 没有机器守卫。本仓是 snapshot（原始 commit 在私有仓库，无 hash 可溯），某条 TD 标 ✅
  // 但偿还信息空/残缺时，没有测试会红。本断言守住最低底线：凡是进了"## 已偿还"区的
  // 条目，"偿还于"列（第4列）必须非空且含可识别的偿还标记（里程碑/日期/已落地语）。
  //
  // 这是"偿还声明自身一致性"守卫，不是"代码事实"守卫——后者需对每条 TD 手写源文件映射，
  // 成本高且 TD 描述非结构化。本守卫只抓"误标已偿还但忘填偿还信息"类漂移，是有意收窄。
  // 真实代码回退漂移仍需人工核对（见 06-28 friction log 二次核实表的做法）。
  //
  // 偿还标记：里程碑(M\d)、日期(2026-)、或显式偿还语(当场修/修复/落地/已解/清零/偿还)。
  const td = read("docs/tech-debt.md");
  const repaidStart = td.indexOf("## 已偿还");
  const repaidEnd = td.indexOf("\n---", repaidStart);
  assert.ok(repaidStart !== -1, "docs/tech-debt.md 缺少 '## 已偿还' 区块");
  const repaidSection = td.slice(repaidStart, repaidEnd === -1 ? undefined : repaidEnd);

  // 命中：已偿还表的 TD 行。列分隔 = | TD-XX | 登记于 | 内容 | 偿还于 |
  const tdRow = /^\|(TD-\d+)\|([^|]*)\|([^|]*)\|([^|]*)\|/;

  for (const line of repaidSection.split("\n")) {
    const m = line.match(tdRow);
    if (!m) continue;
    const id = m[1].trim();
    const repaidCol = m[4].trim();

    // 偿还列不能为空或仅标点。
    assert.ok(
      repaidCol.length > 2 && /\S/.test(repaidCol),
      `${id} 进了"已偿还"区但"偿还于"列为空——标了已偿还却没填偿还信息。`
    );
    // 偿还列必须含可识别的偿还标记。
    assert.ok(
      /M\d|2026|当场修|修复|落地|已解|清零|偿还|已实现|修正|闭环/.test(repaidCol),
      `${id} 的"偿还于"列缺少可识别的偿还标记（里程碑/日期/偿还语）：\n  "${repaidCol.slice(0, 60)}..."`
    );
  }
});

test("TD-82: SKILL.md 不复制 wao declare 理由码，改由裸命令查询", async () => {
  const skill = read("SKILL.md");
  assert.ok(/bare `wao stage` or `wao declare`/.test(skill), "SKILL.md 未说明裸命令查询枚举");
  const { REASON_CODES } = await import("../src/waoDeclare.js");
  assert.ok(REASON_CODES.length > 0, "waoDeclare.js 必须保有理由码 SSOT");
  assert.ok(REASON_CODES.every((code) => !skill.includes(`\`${code}\``)), "SKILL.md 不应复制理由码枚举");
});

test("TD-83: SKILL.md 不复制 pipeline 阶段号，改由裸命令查询", async () => {
  const { STAGE_NUMBERS } = await import("../src/waoStage.js");
  const skill = read("SKILL.md");
  assert.ok(skill.includes("wao stage"), "SKILL.md 未提及 wao stage 查询入口");
  assert.deepEqual(STAGE_NUMBERS, [1, 2, 3, 4, 5, 6], "waoStage.js 阶段号 SSOT 漂移");
  assert.ok(!/阶段 [1-6]/.test(skill), "SKILL.md 不应复制阶段号枚举");
});

test("F1 守卫: SKILL.md 委托 CLI help，不维护第二份命令索引", () => {
  const skill = read("SKILL.md");
  assert.ok(skill.includes("npm run cli -- help"), "SKILL.md 缺动态命令索引入口");
  assert.ok(!/## Quick reference|## Quick Reference/.test(skill), "SKILL.md 不应维护静态命令全集");
});

test("Prompt surfaces 保持薄入口与 Lead/worker 边界", () => {
  const agents = read("AGENTS.md");
  const skill = read("SKILL.md");
  assert.ok(agents.split("\n").length <= 60, "AGENTS.md 再次膨胀，应把细节移回权威文档");
  assert.ok(skill.split("\n").length <= 160, "Lead SKILL 再次膨胀，应改为按需指针");
  assert.ok(skill.includes("It does not block the current roadmap item: defer it."), "Lead SKILL 缺主线延期闸门");
  assert.ok(skill.includes("One bounded worker task: dispatch, supervise, accept, report."), "Lead SKILL 缺单 worker 最短路径");
  assert.ok(skill.includes("Two or more independent workers"), "Lead SKILL 缺复杂任务触发条件");
  assert.ok(!/每个任务走这 6 步|每个任务都走/.test(skill), "Lead SKILL 不应强迫所有任务走六阶段");
  for (const role of ["researcher", "coder_hq", "coder_low", "coder_mm", "tester", "auditor"]) {
    const prompt = read(`config/roles/${role}.md`);
    assert.ok(!/roadmap|wao stage|wao declare/i.test(prompt), `${role} 不应收到 Lead roadmap/pipeline 规则`);
  }
});

test("M10-pre2: workspace_status tool documented in usage.md and SKILL.md", () => {
  const usage = read("docs/usage.md");
  const skill = read("SKILL.md");
  // usage.md must document the new tool
  assert.ok(usage.includes("workspace_status"), "usage.md must document workspace_status tool");
  assert.ok(usage.includes("--workspace-root"), "usage.md must mention --workspace-root startup flag");
  // SKILL.md must list it in the tool table
  assert.ok(skill.includes("workspace_status"), "SKILL.md tool table must include workspace_status");
  // SKILL.md must reflect the current MCP tool count. History: 10 (M10-pre2/P0-2)
  // + runs_list (M10 P0-3) + run_wait (M10-pre3) = 11; + playbook_list/get (M11-2) = 13.
  assert.ok(/13 MCP tools/.test(skill), "SKILL.md must reflect 13 MCP tools (11 + playbook_list/get, M11-2)");
  // team-roles.md must mention workspace binding (MCP-first)
  const roles = read("docs/team-roles.md");
  assert.ok(/workspace binding|workspace-root|roots\/list/.test(roles),
    "team-roles.md must mention workspace binding for MCP dispatch");
});

// ============================================================
// M10 closeout + product definition calibration guards
// ============================================================

test("M10 closeout: roadmap 中 M10 恰好一个 ✅ 完成", () => {
  const roadmap = read("docs/roadmap.md");
  const lines = roadmap.split("\n");
  // 进度跟踪表里 | M10 | 行必须标 ✅ 完成
  const m10Rows = lines.filter((l) => /^\|\s*M10\b/.test(l));
  assert.ok(m10Rows.length >= 1, "roadmap 必须有 M10 进度行");
  const completedM10 = m10Rows.filter((l) => /✅\s*完成/.test(l));
  assert.equal(completedM10.length, 1, `M10 必须恰好一个 ✅ 完成；实际 ${completedM10.length}`);
});

test("M10 closeout: 活文档不再出现 stale M10 in-progress 文案", () => {
  const roadmap = read("docs/roadmap.md");
  const prd = read("docs/01-prd.md");
  const arch = read("docs/02-architecture.md");
  for (const [name, txt] of [["roadmap", roadmap], ["01-prd", prd], ["02-architecture", arch]]) {
    assert.ok(!/M10 整体未完成/.test(txt), `${name} 不得再写"M10 整体未完成"`);
    assert.ok(!/M10-pre3.*准备中|M10-pre3\s*\|.*🔧/.test(txt), `${name} 不得再把 M10-pre3 标为准备中`);
    assert.ok(!/M10 P0-2.*进行中|M10 P0-3.*进行中/.test(txt), `${name} 不得再把 M10 P0-2/P0-3 标为进行中`);
  }
});

test("M10 closeout: PRD §6 能力表无 '现状' 列、无 ❌/🟡/✅ 进度值（进度只归 roadmap）", () => {
  const prd = read("docs/01-prd.md");
  // 切出 §6 能力清单
  const s6Start = prd.indexOf("## 6. 能力清单");
  const s7Start = prd.indexOf("## 7. 约束");
  assert.ok(s6Start >= 0 && s7Start > s6Start, "PRD 必须有 §6 能力清单 与 §7 约束");
  const s6 = prd.slice(s6Start, s7Start);
  // §6 不得有 "现状" 列头
  assert.ok(!/\|\s*现状\s*\|/.test(s6), "PRD §6 能力表不得保留 '现状' 列");
  // §6 不得出现能力进度值 ❌/🟡（✅ 也属进度标记，进度归 roadmap）
  assert.ok(!/❌|🟡|✅/.test(s6), "PRD §6 能力表不得保留 ❌/🟡/✅ 进度值（进度只归 roadmap）");
  // §6 开头必须明确不维护进度，指向 roadmap/architecture/usage
  assert.ok(/不维护实现进度|不维护.*进度/.test(s6), "PRD §6 开头必须声明不维护实现进度");
  assert.ok(/roadmap/.test(s6), "PRD §6 必须指向 docs/roadmap.md");
});

test("M10 closeout: PRD 不复制当前 11-tool 枚举或 application-service 文件清单（只指向权威文档）", () => {
  const prd = read("docs/01-prd.md");
  // PRD 不得复制完整 11-tool 枚举（registry_list/workspace_status/run_dispatch/...）
  assert.ok(!/11 tools/.test(prd), "PRD 不得复制 11 tools 枚举（inventory 归 architecture/usage）");
  assert.ok(!/registry_list\/workspace_status\/run_dispatch/.test(prd),
    "PRD 不得复制 tool 名枚举清单");
  // PRD 不得复制 application-service 文件清单
  assert.ok(!/registryInventory\/runDispatch\/runStatus/.test(prd),
    "PRD 不得复制 application-service 文件清单");
  // PRD 必须指向 architecture/usage 作为权威
  assert.ok(/02-architecture\.md|architecture/.test(prd), "PRD 必须指向 architecture 作为权威");
});

test("M10 closeout: PRD 不声称 Adaptive Playbooks 当前已经提供（属 M11 规划）", () => {
  const prd = read("docs/01-prd.md");
  // Skill-guided 行必须用"承载或将逐步提供"，不得声称模板已交付
  assert.ok(/将逐步提供|承载.*将|承载.*逐步|承载.*工程纪律|承载.*角色合同/.test(prd),
    "PRD Skill 描述必须用'承载/将逐步提供'，不得声称 Adaptive Playbooks 已交付");
  assert.ok(!/SKILL.*提供.*可选工作流模板.*已|Skill-guided.*提供成熟的工程思维、角色合同与可选工作流模板，告诉/.test(prd),
    "PRD 不得声称 Skill 已提供可选工作流模板（Adaptive Playbooks 属 M11）");
});

test("M10 closeout: TD-106 恰好存在一次且仍在开放区，不进入已偿还区", () => {
  const td = read("docs/tech-debt.md");
  // 切出"已偿还"区与"开放"区
  const repaidIdx = td.indexOf("## 已偿还");
  const openIdx = td.indexOf("## 开放");
  assert.ok(repaidIdx >= 0 && openIdx > repaidIdx, "tech-debt.md 必须有 已偿还 与 开放 两区");
  const repaidSection = td.slice(repaidIdx, openIdx);
  const openSection = td.slice(openIdx);
  // TD-106 不得出现在已偿还区
  assert.ok(!/^\|\s*TD-106\b/m.test(repaidSection), "TD-106 不得进入已偿还区（仍开放）");
  // TD-106 必须在开放区恰好一次
  const openMatches = openSection.match(/^\|\s*TD-106\b/gm) || [];
  assert.equal(openMatches.length, 1, `TD-106 必须在开放区恰好一次；实际 ${openMatches.length}`);
});

test("M10 closeout: roadmap 当前总览/完成定义不再用'无人值守'作为 M7 产品目标", () => {
  const roadmap = read("docs/roadmap.md");
  // 总览行 M7 不得用"无人值守"作为标题
  const m7Overview = roadmap.split("\n").find((l) => /^M7\s/.test(l));
  assert.ok(m7Overview, "roadmap 总览必须有 M7 行");
  assert.ok(!/无人值守/.test(m7Overview), "roadmap M7 总览行不得再用'无人值守'作产品目标标题");
  // 完成定义表 M7 行不得承诺"无人值守工作流跑数小时失败自动处理"
  const m7Def = roadmap.split("\n").filter((l) => /^\|\s*M7\b/.test(l));
  assert.ok(m7Def.length >= 1, "roadmap 完成定义必须有 M7 行");
  for (const l of m7Def) {
    assert.ok(!/无人值守工作流跑数小时|失败自动处理或通知/.test(l),
      "roadmap M7 完成定义不得承诺'无人值守工作流/失败自动处理'");
  }
});

test("M10 closeout: roadmap 不出现 'unattended or multi-tenant release' / credential broker 作为成熟度门", () => {
  const roadmap = read("docs/roadmap.md");
  // 英文成熟度门字面量必须消失（之前中文守卫漏过这个英文短语）
  assert.ok(!/unattended or multi-tenant release/.test(roadmap),
    "roadmap 不得出现 'unattended or multi-tenant release' 成熟度门");
  // roadmap 不得把 credential broker 作为发布/成熟度条件（边界归 tech-debt/decision）
  assert.ok(!/credential broker/.test(roadmap),
    "roadmap 不得把 credential broker 作为成熟度/发布条件（边界归 TD-104/decision 0015/0016）");
  // PRD 非目标区仍须显式排除多租户/goal loop（这部分保留有效）
  const prd = read("docs/01-prd.md");
  assert.ok(/多租户.*强身份隔离.*不是 WAO roadmap|多租户.*强身份隔离.*不是.*目标/.test(prd),
    "PRD 必须声明多租户强隔离不是 roadmap/目标");
  assert.ok(/不为.*goal\/autonomy.*实现 goal loop|不替 Lead 做持续语义推理/.test(prd),
    "PRD 必须声明 WAO 不为缺 goal/autonomy 的 Lead 补 goal loop");
});

test("M11 mainline: roadmap 存在且只存在一个 M11 Lead Experience + Adaptive Playbooks 行，标为进行中或规划中，不得整体完成", () => {
  const roadmap = read("docs/roadmap.md");
  const lines = roadmap.split("\n");
  // 进度跟踪表里 | M11 | 行
  const m11Rows = lines.filter((l) => /^\|\s*M11\b/.test(l));
  assert.equal(m11Rows.length, 1, `roadmap 必须恰好一个 M11 进度行；实际 ${m11Rows.length}`);
  const m11Row = m11Rows[0];
  // 必须是进行中（🔧）或规划中（📋），不得标 ✅ 完成（M11 整体未完成）
  assert.ok(/🔧 进行中|📋 规划中|🔧.*进行中|📋.*规划中/.test(m11Row),
    "M11 必须标为进行中或规划中");
  assert.ok(!/✅\s*完成/.test(m11Row), "M11 不得标为整体完成");
  // 名称必须含两个核心（Lead Experience + Adaptive Playbooks 或同义）
  assert.ok(/Lead Experience/.test(m11Row) && /Adaptive Playbooks|playbook|template/i.test(m11Row),
    "M11 名称必须保留 Lead Experience + Adaptive Playbooks 两个核心");
});

test("M10 closeout: Smash Bros delivery 未被宣称已集成", () => {
  const roadmap = read("docs/roadmap.md");
  const prd = read("docs/01-prd.md");
  // 不得宣称 Smash Bros delivery 已 merge/integrate/集成进目标项目
  for (const [name, txt] of [["roadmap", roadmap], ["01-prd", prd]]) {
    assert.ok(!/Smash Bros.*已 merge|Smash Bros.*已 integrate|Smash Bros.*已集成/.test(txt),
      `${name} 不得宣称 Smash Bros delivery 已 merge/integrate/集成`);
  }
});

// ============================================================
// M11-0A: OpenCode project-local setup docs guards
// ============================================================

test("M11-0A: 活文档不存在错误的 opencode 包名 (opencode 而非 opencode-ai)", () => {
  const usage = read("docs/usage.md");
  const skill = read("SKILL.md");
  for (const [name, txt] of [["usage", usage], ["SKILL", skill]]) {
    assert.ok(!/npm i -g opencode\b(?!-ai)/.test(txt), `${name} 不得出现 'npm i -g opencode'（应为 opencode-ai）`);
    assert.ok(!/npm install -g opencode\b(?!-ai)/.test(txt), `${name} 不得出现 'npm install -g opencode'（应为 opencode-ai）`);
  }
});

test("M11-0A: 活文档存在正确的 opencode-ai 安装命令", () => {
  const usage = read("docs/usage.md");
  assert.ok(/npm install -g opencode-ai/.test(usage), "usage.md 必须含 'npm install -g opencode-ai'");
});

test("M11-0A: 活文档不存在 '无 npm install' stale，且存在 npm ci", () => {
  const usage = read("docs/usage.md");
  assert.ok(!/无 npm install/.test(usage), "usage.md 不得再写 '无 npm install'（WAO 含 MCP SDK/zod 依赖）");
  assert.ok(/npm ci/.test(usage), "usage.md 必须含 'npm ci' 安装步骤");
});

test("M11-0A: usage.md 含 OpenCode 项目级配置 schema 关键字段", () => {
  const usage = read("docs/usage.md");
  for (const needle of ["\$schema", '"mcp"', '"type": "local"', '"enabled": true', '"command": [', "--workspace-root", "--pure"]) {
    assert.ok(usage.includes(needle), `usage.md OpenCode 配置示例缺关键字段: ${needle}`);
  }
});

test("M11-0A: usage.md 说明 --pure 用途、新进程重启边界、command 数组要求", () => {
  const usage = read("docs/usage.md");
  assert.ok(/--pure/.test(usage), "usage.md 必须提到 --pure");
  assert.ok(/禁用.*插件|插件.*干扰/.test(usage), "usage.md 必须说明 --pure 禁用插件以减少冲突");
  assert.ok(/新的 OpenCode 进程|启动新.*进程|重启|新进程/.test(usage), "usage.md 必须说明改配置后需启动新进程");
  assert.ok(/command.*必须是数组|command 必须是数组|数组/.test(usage), "usage.md 必须说明 command 必须是数组");
});

test("M11-0A: usage.md MCP 段不再声称只有 7 tools", () => {
  const usage = read("docs/usage.md");
  assert.ok(!/7 个工具/.test(usage), "usage.md MCP 段不得再声称只有 7 个工具");
  assert.ok(/11 个工具/.test(usage), "usage.md MCP 段必须反映 11 个工具");
});

// ============================================================
// M11-1A: safe delivery changed-path projection docs guards
// ============================================================

test("M11-1A: usage.md 记录 changedPaths/changedPathsTruncated 字段与 64 cap", () => {
  const usage = read("docs/usage.md");
  assert.ok(/changedPaths/.test(usage), "usage.md 必须记录 changedPaths 字段");
  assert.ok(/changedPathsTruncated/.test(usage), "usage.md 必须记录 changedPathsTruncated 字段");
  assert.ok(/64/.test(usage), "usage.md 必须记录 64 cap");
  // 仍明确不返回 raw diff / 文件内容
  assert.ok(/不返回.*raw diff|不是 raw diff|raw diff/.test(usage), "usage.md 必须声明不返回 raw diff");
});

test("M11-1A: SKILL Acceptance 段反映 bounded changed paths 但不替代语义验收", () => {
  const skill = read("SKILL.md");
  assert.ok(/changed paths|changedPaths/.test(skill), "SKILL Acceptance 必须提到 changed paths");
  // 仍强调 Lead 不得仅因 verification=passed 自动接受
  assert.ok(/verificationStatus=passed|verification=passed|blindly accept/.test(skill),
    "SKILL 必须声明 Lead 不得仅因 verification passed 自动接受");
  // 不返回 raw diff / 文件内容
  assert.ok(/raw diff|file content|文件内容/.test(skill), "SKILL 必须声明不返回 raw diff/文件内容");
});

// ============================================================
// M11-1A closeout: OpenCode enabled is optional, not required
// ============================================================

test("M11-1A-closeout: usage.md 不得把 OpenCode 'enabled' 声明为必填或省略必然禁用", () => {
  const usage = read("docs/usage.md");
  // 不得继续写 "enabled 必须" / "省略时不会启用" / "省略时该 server 不会启用" 等错误断言
  assert.ok(!/enabled.*必须存在|enabled.*必须填|enabled:true.*必须|省略时.*不会启用|省略时该 server 不会启用/.test(usage),
    "usage.md 不得把 OpenCode enabled 声明为必填或省略必然禁用（官方 schema 为 optional）");
  // 必须明确 enabled 是 optional
  assert.ok(/enabled.*optional|optional.*enabled/i.test(usage),
    "usage.md 必须明确 enabled 是 OpenCode optional 配置");
});

// ============================================================
// M11-1B: certification clarity + worktree hygiene authority guards
// ============================================================

test("M11-1B: SKILL.md 不再把 certified 与 strict-dispatch 当作两个独立返回字段", () => {
  const skill = read("SKILL.md");
  // 旧文案 "latest certification says `certified` and `strict-dispatch`" 必须消失
  assert.ok(!/certified.*and.*strict-dispatch|certification says .*certified.*and.*strict-dispatch/i.test(skill),
    "SKILL.md 不得再要求 Lead 同时证明 certified 与 strict-dispatch 两个字段");
  // 必须明确 certified 即 strict-dispatch 资格（单一字段）
  assert.ok(/certified.*strict dispatch|certified.*eligible.*strict|certification.*single.*field|certified 意味|certified.*implies/i.test(skill),
    "SKILL.md 必须明确 certified 即 strict-dispatch 资格（单一字段）");
});

test("M11-1B: usage.md 记录 .wao-worktrees/ 仓库本地 exclude hygiene 规则", () => {
  const usage = read("docs/usage.md");
  assert.ok(/\/\.wao-worktrees\//.test(usage), "usage.md 必须记录 /.wao-worktrees/ 根忽略规则");
  // 不编辑 tracked .gitignore
  assert.ok(/不编辑 tracked \.gitignore|不.*\.gitignore/.test(usage),
    "usage.md 必须声明不编辑 tracked .gitignore");
  // 与 host activation marker block 独立
  assert.ok(/marker block|独立|Codex.*bind/i.test(usage),
    "usage.md 必须声明 worktree hygiene 规则与 host activation marker block 独立");
});

// ============================================================
// M11-1B micro-closeout: stable-rule semantics + no add-failure rollback
// ============================================================

test("M11-1B-closeout: usage.md 不得声称 git worktree add 失败会回滚 hygiene 规则", () => {
  const usage = read("docs/usage.md");
  // 不得保留"在 git worktree add 失败时回滚本次调用新增的规则"的旧措辞。
  // 精确匹配旧错误框架（"回滚...新增的规则" / "回滚本次调用"），不误伤
  // 正确的"保留该稳定规则，不回滚"。
  assert.ok(!/worktree add.*失败.*回滚.*新增|worktree add.*失败时回滚本次调用/.test(usage),
    "usage.md 不得声称 git worktree add 失败会回滚 hygiene 规则（stable rule 不回滚）");
  // 必须表达 stable rule + add failure 不回滚
  assert.ok(/稳定.*hygiene|stable.*hygiene/i.test(usage),
    "usage.md 必须声明 /.wao-worktrees/ 是稳定 hygiene 规则");
  assert.ok(/worktree add.*失败.*保留.*不回滚|worktree add.*失败.*不回滚/.test(usage),
    "usage.md 必须明确 git worktree add 失败时保留规则、不回滚");
});

// ============================================================
// M11-2C: Skill + SSOT routing contract + optional playbooks.
// Semantic guards — each pins one contract, no verbatim prose match.
// A fresh Codex Lead silently used native subagents despite an explicit WAO
// request and a loaded Skill; these guards keep the routing boundary and the
// "used WAO" fact standard explicit in the docs.
// ============================================================

test("M11-2C-01: SKILL 明确显式 WAO 请求不得静默替换为 native subagent", () => {
  const skill = read("SKILL.md");
  // 必须存在一条路由契约规则：用户显式要 WAO/外部 worker 时，host-native subagent
  // 不构成等价替代，Lead 不得静默改用。
  assert.ok(/native subagent|host-native|subagent/i.test(skill),
    "SKILL.md 必须提及 native/host subagent 路由边界");
  assert.ok(/静默|silently|不得.*替代|do not.*substitute|not.*equivalent/i.test(skill),
    "SKILL.md 必须禁止静默用 native subagent 替代显式 WAO 请求");
});

test("M11-2C-02: SKILL 明确 run_dispatch 返回 runId 才算 WAO worker dispatch", () => {
  const skill = read("SKILL.md");
  // “真正使用 WAO”的最低事实标准：只有 run_dispatch 成功返回 runId 才能这样表述。
  // 仅加载 Skill 或借用 WAO 纪律不算。
  assert.ok(/run_dispatch.*runId|runId.*run_dispatch|only.*run_dispatch/i.test(skill),
    "SKILL.md 必须把 run_dispatch runId 作为 WAO worker dispatch 的事实标准");
  assert.ok(/Skill.*不算|loading.*Skill.*not|borrow.*discipline.*not|不算.*通过 WAO/i.test(skill),
    "SKILL.md 必须说明仅加载 Skill / 借用纪律不算通过 WAO 派工");
});

test("M11-2C-03: SKILL 含 playbook_list/playbook_get 且说明 optional/adaptable", () => {
  const skill = read("SKILL.md");
  assert.ok(/playbook_list/.test(skill), "SKILL.md 提及 playbook_list");
  assert.ok(/playbook_get/.test(skill), "SKILL.md 提及 playbook_get");
  // 必须说明 optional + Lead 可保留/跳过/修改条件步骤。
  assert.ok(/optional|可选/i.test(skill), "SKILL.md 说明 playbook 为 optional");
  assert.ok(/skip|跳过|adaptable|可修改|保留/i.test(skill),
    "SKILL.md 说明 Lead 可保留/跳过/修改 playbook 条件步骤");
});

test("M11-2C-04: 活文档不得声称存在 playbook_run/start/next/recommend", () => {
  // 扫描活文档（SKILL + docs/*）。executor 工具（playbook_run/start/next/recommend）
  // 不存在；文档可以否定地提及它们（"there is no playbook_run"），但不得用肯定式
  // 动词声称其存在或使用（"call/use/invoke/run playbook_run"）。
  //
  // 本守卫检测的是"肯定式声称"句式（动词 + 工具名），而不是扫所有裸词出现——
  // 因为否定声明（there is no / 不存在 / 没有）是合法且必要的，逐词扫会产生假阳性。
  const live = [
    "SKILL.md",
    "docs/usage.md",
    "docs/01-prd.md",
    "docs/02-architecture.md",
    "docs/roadmap.md",
  ].map(read).join("\n<<<FILE_BOUNDARY>>>\n");
  const stripped = live.replace(/[*`]/g, "");
  // 肯定式声称：英文动词（call/use/invoke/run/execute）或中文动词（调用/使用/执行/运行）
  // 后跟 playbook_run/start/next/recommend。这是"声称工具存在并可用"的真实信号。
  const positiveClaim = /\b(?:call|use|invoke|run|execute)\s+playbook_(run|start|next|recommend)\b|调用\s*playbook_(run|start|next|recommend)|使用\s*playbook_(run|start|next|recommend)|执行\s*playbook_(run|start|next|recommend)|运行\s*playbook_(run|start|next|recommend)/i;
  assert.ok(!positiveClaim.test(stripped),
    "活文档不得用肯定式动词声称 playbook_run/start/next/recommend 存在或可调用（否定声明除外）");
});

test("M11-2C-05: PRD 继续拒绝 automatic decomposition 与 fixed workflow", () => {
  const prd = read("docs/01-prd.md");
  assert.ok(/不自动.*语义.*分解|不自动做语义任务分解|no automatic.*decomposition/i.test(prd),
    "PRD 继续否定自动语义分解");
  assert.ok(/不强制.*workflow|不强制固定.*workflow|no fixed workflow/i.test(prd),
    "PRD 继续否定强制固定 workflow");
});

test("M11-2C-06: architecture 明确 Catalog ≠ WorkflowEngine（分离）", () => {
  const arch = read("docs/02-architecture.md");
  // 必须同时出现 Catalog（只读 Lead Playbook）与 WorkflowEngine（可执行 CLI DAG），
  // 并表达二者分离/不同用途。
  assert.ok(/Playbook Catalog|Lead Playbook|playbookCatalog/i.test(arch),
    "architecture 提及 Playbook Catalog");
  assert.ok(/WorkflowEngine|workflow engine|executable.*template/i.test(arch),
    "architecture 提及 WorkflowEngine/executable template");
  assert.ok(/分离|separate|distinct|不同于|不是.*executor|read-only.*not.*executable/i.test(arch),
    "architecture 明确 Catalog 与 WorkflowEngine 分离");
});

test("M11-2C-07: roadmap 只标 M11-2 complete，不标整个 M11 complete", () => {
  const roadmap = read("docs/roadmap.md");
  // M11-2 必须被标记为完成（或已交付）。
  assert.ok(/M11-2.*完成|M11-2.*complete|M11-2.*✅|M11-2.*已交付|M11-2.*done/i.test(roadmap),
    "roadmap 标记 M11-2 完成");
  // 但 M11 整体行不得是纯完成态（不得把整个 M11 标 ✅ 完成）。
  // 允许 "M11 🔧 进行中" / "M11 整体未完成" 等措辞。
  const m11RowPattern = /\|\s*M11\s*\|[^|]*\|/g;
  const m11Rows = roadmap.match(m11RowPattern) || [];
  const m11Aggregate = m11Rows.join(" ");
  assert.ok(!/M11.*✅\s*完成(?!.*进行中)/.test(m11Aggregate) || /进行中|未完成|in progress/i.test(m11Aggregate),
    "roadmap 不得把整个 M11 标为已完成（M11 整体仍进行中）");
  assert.ok(/M11.*进行中|M11.*未完成|M11.*in progress/i.test(m11Aggregate),
    "roadmap 保持 M11 整体进行中");
});

test("M11-2C-08: usage 含 playbook 的 MCP 与 CLI 两种只读入口", () => {
  const usage = read("docs/usage.md");
  assert.ok(/playbook_list/.test(usage), "usage 提及 playbook_list MCP 工具");
  assert.ok(/playbook_get/.test(usage), "usage 提及 playbook_get MCP 工具");
  assert.ok(/playbook list/.test(usage), "usage 提及 `playbook list` CLI");
  assert.ok(/playbook show/.test(usage), "usage 提及 `playbook show` CLI");
  assert.ok(/--format json/i.test(usage), "usage 提及 playbook --format json");
});

test("M11-2C-09: SKILL/PRD 保持 Advisor/Auditor conditional（非默认流水线）", () => {
  const skill = read("SKILL.md");
  const prd = read("docs/01-prd.md");
  for (const [name, text] of [["SKILL.md", skill], ["PRD", prd]]) {
    assert.ok(/Advisor.*Auditor.*conditional|Advisor.*conditional|Auditor.*conditional|Advisor\/Auditor.*按需|Advisor\/Auditor.*低信心|conditional.*Advisor|可选.*Advisor/i.test(text),
      `${name} 保持 Advisor/Auditor 为 conditional/按需，非默认流水线`);
  }
});

test("M11-2C-10: SKILL/architecture 当前工具事实为 13 tools，不残留 11-tool 当前状态声明", () => {
  const skill = read("SKILL.md");
  const arch = read("docs/02-architecture.md");
  // SKILL 的 "Minimal MCP Loop" 当前状态声明必须反映 13 tools（11 + playbook_list/get）。
  assert.ok(/13 MCP tools|13 tools/i.test(skill),
    "SKILL.md Minimal MCP Loop 当前工具数为 13");
  // architecture 的 server.js 当前 tool 注释必须反映 13（不得仍是 "11 tools"）。
  // 精确匹配 "server.js ... N tools" 的当前状态注释行。
  const serverLine = arch.split("\n").find((l) => /server\.js.*tools/.test(l)) || "";
  assert.ok(!/11 tools/.test(serverLine),
    "architecture server.js 注释不得残留 11 tools（当前为 13）");
  assert.ok(/13 tools/.test(serverLine),
    "architecture server.js 注释当前工具数为 13");
});

// ============================================================
// M11-2C routing-semantics micro-closeout.
// The first M11-2C draft said "Before starting any worker, run ... WAO preflight"
// and "drives the full minimal loop through 13 MCP tools". Both over-reached:
// the former forced native-subagent routes through a WAO preflight (contradicting
// "Lead keeps the routing choice"); the latter implied all 13 tools are a
// mandatory loop (playbook reads are optional and outside the dispatch loop).
// ============================================================

test("M11-2C-11: SKILL 不得要求任何 worker（含 native 路线）都执行 WAO preflight", () => {
  const skill = read("SKILL.md");
  // 禁止全局强制措辞：把 "any worker" / "任何 worker" / "every worker" 与
  // WAO preflight 绑在同一规则句里。正确语义是 preflight 绑定 WAO route /
  // run_dispatch / WAO worker，而非所有 worker。
  const globalPreflight = /before\s+starting\s+(any|every|all)\s+worker[^.]*WAO\s+preflight|任何\s*worker[^。]*WAO\s*preflight|所有\s*worker[^。]*WAO\s*preflight/i;
  assert.ok(!globalPreflight.test(skill),
    "SKILL 不得要求任何/every worker 都执行 WAO preflight（preflight 须绑定 WAO route）");
  // 必须明确 preflight 绑定 WAO route / run_dispatch / WAO worker 之一。
  assert.ok(/preflight[^.]*WAO\s+route|WAO\s+route[^.]*preflight|preflight[^.]*run_dispatch|run_dispatch[^.]*preflight|preflight[^.]*WAO\s+worker|WAO\s+worker[^.]*preflight/i.test(skill),
    "SKILL 必须把 WAO preflight 明确绑定到 WAO route / run_dispatch / WAO worker");
});

test("M11-2C-12: SKILL 13-tool 文案不得声称 minimal loop 必须经过全部 13 tools", () => {
  const skill = read("SKILL.md");
  // 禁止 "full minimal loop through 13 MCP tools" / "minimal loop 必须经过全部 13"
  // 这类暗示全部 13 工具都是 mandatory loop 的措辞。playbook_list/get 是可选、
  // 位于 dispatch loop 外的 catalog reads。
  const mandatoryAll = /full\s+minimal\s+loop\s+through\s+13|minimal\s+loop\s+必须.*全部\s*13|loop\s+must\s+(use|go through|include)\s+all\s+13/i;
  assert.ok(!mandatoryAll.test(skill),
    "SKILL 13-tool 文案不得声称 minimal loop 必须经过全部 13 tools");
  // 必须表达：WAO 暴露 13 tools，但 minimal control loop 只用相关 control tools，
  // playbook reads 是可选且在 dispatch loop 外。
  assert.ok(/13 MCP tools|13 tools/i.test(skill),
    "SKILL 仍声明 WAO 暴露 13 MCP tools（事实不变）");
  assert.ok(/optional|可选/i.test(skill) && /dispatch loop|control loop/i.test(skill),
    "SKILL 必须说明 playbook reads 可选且在 dispatch/control loop 之外");
});
