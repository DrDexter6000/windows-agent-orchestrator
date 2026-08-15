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
const ROOT = join(__dirname, "..", "..");

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

test("SKILL.md 开头必须说明 WAO 的当前目标、上线边界和认证作为 advisory evidence", () => {
  const head = read("SKILL.md").slice(0, 3500);
  for (const kw of ["deterministic control plane", "real worker tasks", "supervised production trial", "certified", "advisory"]) {
    assert.ok(head.includes(kw), `SKILL.md 开头缺少第三方 lead 首读关键信息：${kw}`);
  }
});

// M12-10b (Lead review): WAO and its Lead Host contract are Host/runtime-neutral.
// A specific Host (Claude Code / Codex / Kimi / OpenCode) may be a worker backend
// or a default dispatch lane, but it must never be named as the WAO product
// identity or as a correctness dependency. Scoped to the positioning/head region
// so legitimate backend-specific operational references (worker routing, dispatch
// lanes, `backend:` values) further down the doc are not affected.
test("M12-10b: SKILL/产品定位必须 Host-neutral，不得把具体 Host/runtime 作为产品身份或正确性依赖", () => {
  const head = read("SKILL.md").slice(0, 3500);
  // 产品定位不得声称某个具体 Host/runtime 是产品身份（X-first）。
  for (const bad of [
    "Claude Code-first", "Claude Code first", "Claude-first",
    "Codex-first", "Codex first",
    "Kimi-first", "Kimi first",
    "OpenCode-first", "OpenCode first", "opencode-first",
  ]) {
    assert.ok(!head.includes(bad), `SKILL.md 产品定位不得以具体 Host/runtime 为身份：${bad}`);
  }
  // 定位仍必须用 Host-neutral 栈表达（MCP-first + Skill/CLI），证明替换是中性的而非空洞。
  assert.ok(/MCP-first/i.test(head), "SKILL.md 产品定位必须以 MCP-first 为 Host-neutral 基座");
  assert.ok(/Skill-guided|CLI-backed/i.test(head), "SKILL.md 产品定位必须保留 Host-neutral 的 Skill/CLI 表述");
});

// M12-10c (Lead-authorized correction): the playbook catalog moved from TOOLS to
// MCP RESOURCES (wao://playbooks). The fixed fail-closed error vocabulary must be
// resource-oriented (summary/detail), never the removed-tool names. This guard
// binds docs/usage.md to the runtime constants in src/mcp/server.js so the
// vocabulary cannot drift: it reads the constant values from the server source
// (the SSOT) and asserts the doc documents exactly those strings, and that the
// removed-tool vocabulary survives in neither doc nor runtime.
test("M12-10c: usage.md playbook resource fixed-error vocabulary is bound to server.js runtime constants (no drift)", () => {
  const server = read("src/mcp/server.js");
  const usage = read("docs/usage.md");
  // Extract the runtime constant values (the SSOT) from server.js source.
  const summaryErr = server.match(/PLAYBOOK_SUMMARY_ERROR_TEXT\s*=\s*"([^"]*)"/)?.[1];
  const detailErr = server.match(/PLAYBOOK_DETAIL_ERROR_TEXT\s*=\s*"([^"]*)"/)?.[1];
  assert.ok(summaryErr, "src/mcp/server.js must define PLAYBOOK_SUMMARY_ERROR_TEXT");
  assert.ok(detailErr, "src/mcp/server.js must define PLAYBOOK_DETAIL_ERROR_TEXT");
  // Documented vocabulary must equal the runtime constants exactly (no drift).
  assert.ok(usage.includes(summaryErr),
    `docs/usage.md must document the summary resource fixed error "${summaryErr}"`);
  assert.ok(usage.includes(detailErr),
    `docs/usage.md must document the detail resource fixed error "${detailErr}"`);
  // The removed tool-named vocabulary must not survive in doc or runtime.
  assert.ok(!/playbook_list failed|playbook_get failed/.test(server),
    "server.js must not emit removed-tool error names (playbook_list/playbook_get failed)");
  assert.ok(!/playbook_list failed|playbook_get failed/.test(usage),
    "docs/usage.md must not document removed-tool error names (playbook_list/playbook_get failed)");
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
  // TD-106 is an Owner-declared WAO non-goal: it belongs in design constraints,
  // not in the repaid or open debt sections.
  const repaidSection = (techDebt.split("## 已偿还")[1] ?? "").split("## 开放")[0] ?? "";
  const designSection = techDebt.split("## 设计性约束")[1] ?? "";
  assert.ok(!/TD-106/.test(repaidSection),
    "tech-debt.md TD-106 must not be in repaid section (no WAO code debt was repaid)");
  assert.ok(!/TD-106/.test(openSection),
    "tech-debt.md TD-106 must not remain open after Owner declared it a Codex product concern");
  assert.ok(/TD-106/.test(designSection),
    "tech-debt.md TD-106 must be recorded exactly as a WAO non-goal/design constraint");
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
  const { REASON_CODES } = await import("../../src/waoDeclare.js");
  assert.ok(REASON_CODES.length > 0, "waoDeclare.js 必须保有理由码 SSOT");
  assert.ok(REASON_CODES.every((code) => !skill.includes(`\`${code}\``)), "SKILL.md 不应复制理由码枚举");
});

test("TD-83: SKILL.md 不复制 pipeline 阶段号，改由裸命令查询", async () => {
  const { STAGE_NUMBERS } = await import("../../src/waoStage.js");
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
  // M11-6: workspace_select documented + listed
  assert.ok(usage.includes("workspace_select"), "usage.md must document workspace_select tool (M11-6)");
  assert.ok(skill.includes("workspace_select"), "SKILL.md tool table must include workspace_select (M11-6)");
  // SKILL.md must reflect the current MCP tool count. History: 10 (M10-pre2/P0-2)
  // + runs_list (M10 P0-3) + run_wait (M10-pre3) = 11; + playbook_list/get (M11-2) = 13;
  // + run_delivery_review (M11-3) = 14; + workspace_select (M11-6) = 15; + lead_preflight
  // (M11-8A) = 16; + run_delivery_repackage (M12-1S2) = 17; + run_await_result
  // (M12-3A) = 18; + run_delivery_review_bundle (M12-3B) = 19; + run_delivery_reverify
  // (M12-6 Package 3B) = 20; + run_continue (M12-7) = 21; + run_activity (M12-8A) = 22;
  // + run_dispatch_contract_check (M12-9) = 23.
  // M12-10 progressive-disclosure correction: the playbook catalog moved OFF the
  // tool surface to MCP resources, so the surface dropped playbook_list +
  // playbook_get → 23 - 2 = 21 always-registered tools (no profile, no restart).
  // M12-16 added run_correct (queued in-flight correction) → 21 + 1 = 22.
  assert.ok(/22 MCP tools/.test(skill), "SKILL.md must reflect 22 MCP tools (M12-10 playbook-to-resources move; M12-16 added run_correct)");
  assert.ok(skill.includes("run_delivery_reverify"), "SKILL.md tool table must include run_delivery_reverify");
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

test("post-M12 closeout: TD-106 恰好存在一次且归档为 WAO 非目标", () => {
  const td = read("docs/tech-debt.md");
  // 切出"已偿还"、"开放"与"设计性约束"三区。
  const repaidIdx = td.indexOf("## 已偿还");
  const openIdx = td.indexOf("## 开放");
  const designIdx = td.indexOf("## 设计性约束");
  assert.ok(repaidIdx >= 0 && openIdx > repaidIdx && designIdx > openIdx,
    "tech-debt.md 必须有 已偿还、开放与设计性约束三区");
  const repaidSection = td.slice(repaidIdx, openIdx);
  const openSection = td.slice(openIdx, designIdx);
  const designSection = td.slice(designIdx);
  // TD-106 不得出现在已偿还区
  assert.ok(!/^\|\s*TD-106\b/m.test(repaidSection), "TD-106 不得进入已偿还区");
  assert.ok(!/^\|\s*TD-106\b/m.test(openSection), "TD-106 不得继续留在开放区");
  const designMatches = designSection.match(/^\|\s*TD-106\b/gm) || [];
  assert.equal(designMatches.length, 1,
    `TD-106 必须在设计性约束区恰好一次；实际 ${designMatches.length}`);
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

test("M11 mainline: roadmap 存在且只存在一个 M11 Lead Experience + Adaptive Playbooks 行，标为已完成（M12-0 关闭 M11）", () => {
  const roadmap = read("docs/roadmap.md");
  const lines = roadmap.split("\n");
  // 进度跟踪表里 | M11 | 行
  const m11Rows = lines.filter((l) => /^\|\s*M11\b/.test(l));
  assert.equal(m11Rows.length, 1, `roadmap 必须恰好一个 M11 进度行；实际 ${m11Rows.length}`);
  const m11Row = m11Rows[0];
  // M12-0 关闭 M11：必须标为 ✅ 完成，不得仍停在 🔧 进行中
  assert.ok(/✅\s*完成/.test(m11Row), "M11 必须标为 ✅ 完成（M12-0 已退役 Tester token efficiency 并关闭 M11）");
  assert.ok(!/🔧\s*进行中/.test(m11Row), "M11 不得仍标为 🔧 进行中（M12-0 已关闭 M11）");
  // 名称必须含两个核心（Lead Experience + Adaptive Playbooks 或同义）
  assert.ok(/Lead Experience/.test(m11Row) && /Adaptive Playbooks|playbook|template/i.test(m11Row),
    "M11 名称必须保留 Lead Experience + Adaptive Playbooks 两个核心");
});

test("M11-10 closeout: roadmap records the fresh Lead delivery-readiness canary (M11 now closed complete by M12-0)", () => {
  const roadmap = read("docs/roadmap.md");
  const m11Row = roadmap.split("\n").find((line) => /^\| M11 \|/.test(line));
  assert.ok(m11Row, "roadmap has an M11 row");
  assert.match(m11Row, /M11-10 Delivery Readiness Handshake 已交付并通过 fresh Lead canary/);
  assert.match(m11Row, /run_20260726093455485nl8l84/);
  assert.match(m11Row, /delivery `df8bf65`/);
  assert.match(m11Row, /唯一一次 `run_delivery\(waitMs\)` 返回 `reviewable` \+ verification passed，acceptance accepted/);
  assert.match(m11Row, /\| M11 \| ✅ 完成 \|/);
});

test("M11-11A-RED-03: Lead identity states the full human-owned operating contract", () => {
  const skill = read("SKILL.md");
  const roles = read("docs/team-roles.md");
  const leadHead = skill.split("\n").slice(0, 20).join("\n");
  const leadContract = `${leadHead}\n${roles}`;

  assert.match(leadContract, /understand(?:ing)? user needs|理解(?:和消化)?用户需求/i);
  assert.match(leadContract, /define task goals|明确任务目标/i);
  assert.match(leadContract, /decompos|拆解.*任务/i);
  assert.match(leadContract, /parallel.*serial|并行.*串行/i);
  assert.match(leadContract, /dispatch.*(?:suitable|appropriate).*worker|派发.*合适.*worker/i);
  assert.match(leadContract, /accept.*reject|放行.*打回|验收.*(?:放行|打回)/i);
  assert.match(leadContract, /aggregate.*integrat|汇总.*集成/i);
  assert.match(leadContract, /execution.*report|执行总结报告|总结.*报告/i);
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

test("M12-8A/M12-9/M12-10/M12-16: usage.md MCP 段反映当前 22 tools", () => {
  const usage = read("docs/usage.md");
  // 精确禁止"只有 7 个工具"的陈旧文案。
  assert.ok(!/(?<!\d)7 个工具/.test(usage), "usage.md MCP 段不得再声称只有 7 个工具");
  // M12-10: playbook catalog moved to resources → 23 - 2 = 21; M12-16 added run_correct → 22.
  assert.ok(/22 个工具/.test(usage), "usage.md MCP 段必须反映 22 个工具（M12-10 playbook 转 resources；M12-16 加 run_correct）");
  // The stale 23-tool claim must be gone.
  assert.ok(!/23 个工具/.test(usage), "usage.md 不得再声称 23 个工具");
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

test("M11-1B/M12-0: SKILL.md 把 certification 定位为 advisory evidence（非 permission hard gate）", () => {
  const skill = read("SKILL.md");
  // 旧文案 "latest certification says `certified` and `strict-dispatch`" 必须消失
  assert.ok(!/certified.*and.*strict-dispatch|certification says .*certified.*and.*strict-dispatch/i.test(skill),
    "SKILL.md 不得再要求 Lead 同时证明 certified 与 strict-dispatch 两个字段");
  // M12-0 重置：certification 是 advisory evidence，不是 permission gate
  assert.ok(/advisory evidence|advisory.*not.*(?:a )?gate|not a permission gate|不是 permission gate|advisory.*非.*门/i.test(skill),
    "SKILL.md 必须把 certification 定位为 advisory evidence，非 permission gate");
  // 硬门措辞必须消失（M12-0 重置取代 M11-1B 的 strict-dispatch 资格框架）
  assert.ok(!/strict-dispatch|strict dispatch/i.test(skill),
    "SKILL.md 不得再使用 strict-dispatch 硬门框架（M12-0 改为 advisory）");
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

test("M11-2C-03: SKILL 把 playbook catalog 呈现为 resources（非工具），且说明 optional/adaptable", () => {
  const skill = read("SKILL.md");
  // M12-10: the playbook catalog moved OFF the tool surface. SKILL must present
  // it as MCP resources (wao://playbooks summary + wao://playbooks/{id} detail),
  // NOT as playbook_list / playbook_get tools.
  assert.ok(/wao:\/\/playbooks/.test(skill), "SKILL.md 把 playbook catalog 呈现为 wao://playbooks resources");
  assert.ok(!/\bplaybook_list\b/.test(skill), "SKILL.md 不得再把 playbook_list 当作工具呈现");
  assert.ok(!/\bplaybook_get\b/.test(skill), "SKILL.md 不得再把 playbook_get 当作工具呈现");
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

test("M11-2C-07/M12 closeout: roadmap 标 M11-2 complete，M11/M12 均已关闭", () => {
  const roadmap = read("docs/roadmap.md");
  // M11-2 必须被标记为完成（或已交付）。
  assert.ok(/M11-2.*完成|M11-2.*complete|M11-2.*✅|M11-2.*已交付|M11-2.*done/i.test(roadmap),
    "roadmap 标记 M11-2 完成");
  // M12-0 关闭 M11：M11 整体行已标 ✅ 完成（不再要求进行中）。
  const m11RowPattern = /\|\s*M11\s*\|[^|]*\|/g;
  const m11Rows = roadmap.match(m11RowPattern) || [];
  const m11Aggregate = m11Rows.join(" ");
  assert.ok(/M11.*✅\s*完成/.test(m11Aggregate),
    "roadmap M11 整体行已标 ✅ 完成（M12-0 关闭 M11）");
  // M12 进度行必须存在且已关闭；不要误取完成定义表中的 M12 行。
  const m12Row = roadmap.split("\n").find((l) =>
    /^\|\s*M12\s*\|/.test(l) && /Lead Token Efficiency/.test(l)) || "";
  assert.ok(m12Row, "roadmap 必须有 M12 行（M12-0 产品合同重置）");
  assert.ok(/✅.*完成/.test(m12Row), "roadmap M12 行必须标为 ✅ 完成");
});

test("M12-1 S1/S2: roadmap and README record implemented inventory + model-free repackage truth", () => {
  const roadmap = read("docs/roadmap.md");
  const readme = read("README.md");
  for (const [name, text] of [["roadmap", roadmap], ["README", readme]]) {
    assert.ok(/candidateInventory/.test(text), `${name} 必须记录 candidateInventory 已实现`);
    assert.ok(/run_delivery_repackage/.test(text), `${name} 必须记录 model-free repackage 已实现`);
    assert.ok(/不重调模型|model-free/i.test(text), `${name} 必须说明不重新调用 worker model`);
  }
  const m12Row = roadmap.split("\n").find((line) =>
    /^\|\s*M12\s*\|/.test(line) && /Lead Token Efficiency/.test(line)) || "";
  assert.ok(/M12-1 S1\/S2 已实现/.test(m12Row), "roadmap M12 行必须标记 S1/S2 已实现");
  assert.ok(!/planned\/unimplemented slices only/.test(m12Row),
    "roadmap 不得再把全部 M12 slice 描述为未实现");
});

test("M11-2C-08: usage 含 playbook 的 MCP resources 与 CLI 两种只读入口", () => {
  const usage = read("docs/usage.md");
  // M12-10: the MCP entry is now RESOURCES (wao://playbooks), not tools.
  assert.ok(/wao:\/\/playbooks/.test(usage), "usage 把 MCP playbook 入口记为 wao://playbooks resources");
  assert.ok(!/\bplaybook_list\b/.test(usage), "usage 不得再把 playbook_list 当作 MCP 工具");
  assert.ok(!/\bplaybook_get\b/.test(usage), "usage 不得再把 playbook_get 当作 MCP 工具");
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

test("Advisor/Auditor failure remains Lead-governed and may fall back to coder_mm", () => {
  const skill = read("SKILL.md");
  assert.match(skill, /不可用、超时或无 verdict 时可换 `coder_mm`/);
  assert.match(skill, /不阻断 dispatch/);
  assert.match(skill, /项目权威明令必审时停为 governance block，不得称 WAO control-plane failure/);
});

test("M12 worker routing: SKILL keeps semantic routing and Lead authority", () => {
  const skill = read("SKILL.md");
  assert.ok(/语义耦合|semantic coupling/i.test(skill),
    "SKILL must route coding work by semantic coupling");
  assert.ok(/不.*(?:Low|HQ|名称).*(?:机械|自动).*路由|not.*route.*(?:Low|HQ|name)/i.test(skill),
    "SKILL must not route mechanically by worker name");
  assert.ok(/不.*(?:文件数|prompt.*长度|耗时).*(?:自动|单独).*转派|file count.*not.*routing|prompt length.*not.*routing/i.test(skill),
    "SKILL must not use package surface size as an automatic reassignment rule");
  assert.ok(/拆分.*转派.*Lead|Lead.*(?:拆分|转派).*决定/i.test(skill),
    "Lead must own package split and reassignment decisions");
  assert.ok(/coder_low.*bounded implementation lane/i.test(skill),
    "SKILL must identify coder_low as the bounded implementation lane");
  assert.ok(/Owner 劝诫.*优先 `coder_hq`|多数实现任务优先 `coder_hq`/i.test(skill),
    "SKILL must carry the Owner advisory (2026-08-15) preferring coder_hq for most implementation tasks");
  assert.ok(/coder_hq.*高耦合|高耦合.*coder_hq|coder_hq.*长程连贯/i.test(skill),
    "SKILL must reserve coder_hq for highly coupled or long-horizon work");
});

test("M12 role naming: stable auditor id represents one advisory/audit expert", () => {
  const skill = read("SKILL.md");
  const roles = read("docs/team-roles.md");
  for (const [name, text] of [["SKILL.md", skill], ["team-roles.md", roles]]) {
    assert.ok(/agentId.*auditor|canonical.*auditor/i.test(text),
      `${name} must preserve the canonical auditor agentId`);
    assert.ok(/Advisor.*Auditor|顾问.*审计/i.test(text),
      `${name} must describe the same expert's advisory and audit modes`);
  }
});

test("M12 coder_low example uses current DeepSeek V4 Flash policy", () => {
  const parsed = JSON.parse(read("config/agents.example.json"));
  const low = parsed.agents?.coder_low;
  assert.equal(low?.model?.id, "deepseek-v4-flash");
  assert.equal(low?.reasoning?.effort, "max");
  assert.equal(low?.model?.contextWindow, 1000000);
});

test("M12-8A/M12-9/M12-10/M12-16: SKILL/architecture 当前工具事实为 22 tools", () => {
  const skill = read("SKILL.md");
  const arch = read("docs/02-architecture.md");
  assert.ok(/22 MCP tools|22 tools/i.test(skill),
    "SKILL.md Minimal MCP Loop 当前工具数为 22（M12-10 playbook 转 resources：23 - 2；M12-16 加 run_correct）");
  // The stale 23-tool claim must be gone from SKILL.
  assert.ok(!/23 MCP tools|23 tools/i.test(skill),
    "SKILL.md 不得再声称 23 tools（playbook catalog 已转为 resources）");
  // 精确匹配 "server.js ... N tools" 的当前状态注释行。
  const serverLine = arch.split("\n").find((l) => /server\.js.*tools/.test(l)) || "";
  assert.ok(/22 tools/.test(serverLine),
    "architecture server.js 注释当前工具数为 22");
});

test("M12-9 docs: executionProfileId is a TOP-LEVEL run_dispatch input; inline verification is delivery.verificationCommands etc.; contract check is schema-not-Zod and contractValid is mechanical-only", () => {
  const skill = read("SKILL.md");
  const usage = read("docs/usage.md");
  const roadmap = read("docs/roadmap.md");
  for (const [name, text] of [["SKILL.md", skill], ["docs/usage.md", usage], ["docs/roadmap.md", roadmap]]) {
    // The NONEXISTENT nested shape (delivery.verification.executionProfileId) must
    // never be documented — it does not exist in the run_dispatch input schema.
    assert.ok(!/verification\.executionProfileId/i.test(text),
      `${name} 不得记录不存在的 delivery.verification.executionProfileId 形状`);
    // executionProfileId is a top-level run_dispatch input, sibling of delivery.
    assert.ok(/top-level|顶层|同级/i.test(text),
      `${name} 必须把 executionProfileId 记为顶层（与 delivery 同级）`);
    // Inline verification uses the real delivery-level field names.
    assert.ok(/verificationCommands/.test(text), `${name} 必须记录 delivery.verificationCommands`);
  }
  // contractValid scope (SKILL + usage carry the full scope sentence): mechanical
  // contract only; it must NOT pre-evaluate the run_dispatch expectations.
  for (const [name, text] of [["SKILL.md", skill], ["docs/usage.md", usage]]) {
    assert.ok(/contractValid/.test(text), `${name} 必须记录 contractValid`);
    assert.ok(/expectedGitHead|expectedDirty|expectedWorkspaceRoot/.test(text),
      `${name} 必须列出 contractValid 不预评的 expectedGitHead/expectedDirty/expectedWorkspaceRoot`);
  }
  // The contract check shares the INPUT SCHEMA (not "Zod"), and the service does
  // not import a validation library. Regression guard for the stale "共享输入 Zod"
  // wording that wrongly attributed a Zod import to the service.
  for (const [name, text] of [["SKILL.md", skill], ["docs/usage.md", usage], ["docs/roadmap.md", roadmap]]) {
    assert.ok(!/共享输入 Zod/.test(text), `${name} 不得再用过时的"共享输入 Zod"措辞`);
  }
});

test("M12-9 roadmap records durable decisions, exact-artifact truth, and Fresh Host release acceptance", () => {
  const roadmap = read("docs/roadmap.md");
  assert.ok(!/M12-9 已实现（本地，待 Lead 验收）/.test(roadmap),
    "roadmap 不得保留已经过时的待 Lead 验收状态");
  assert.ok(/run_20260802214029613xyobfm/.test(roadmap)
    && /run_20260802221931019rlzegp/.test(roadmap)
    && /run_20260802230308130x7tuh1/.test(roadmap),
    "roadmap 必须绑定最终 M12-9 root/child/reviewer runId");
  assert.ok(/a58aa73376044a167d2776a4f3bc33b44b4ed75a/.test(roadmap)
    && /durable accepted/.test(roadmap)
    && /durable rejected/.test(roadmap),
    "roadmap 必须记录最终 child delivery 与 Lead 的 accepted/rejected 决策");
  // Old attempts are historical implementation inputs, not the final acceptance
  // truth. The roadmap must pin both original and effective verification facts:
  // the 300-second timeout remains visible, and the unchanged artifact's audited
  // tooling-invalid reverify is the effective passed outcome.
  assert.ok(!/BLOCKED_CANONICAL_GATE/.test(roadmap)
    && !/175 pass/.test(roadmap)
    && !/17\/17/.test(roadmap),
    "roadmap 不得保留旧的非绿 canonical 尝试作为当前验收事实");
  assert.ok(!/本地隔离候选|发布门待修复|隔离集成为|主 checkout 的并发修改/.test(roadmap),
    "roadmap 不得保留旧候选/base 隔离或'发布门待修复'作为当前事实（已按 Lead 修正重集成到当前 main）");
  assert.ok(/originalVerificationStatus:failed/.test(roadmap)
    && /effectiveVerificationStatus:passed/.test(roadmap)
    && /tooling_invalid/.test(roadmap)
    && /同一已提交 artifact/.test(roadmap),
    "roadmap 必须同时保留原超时与同一 artifact 审计重验通过的真相");
  assert.ok(/c3e9e5304a26515086ea9fad3f2b6e6f1f6a7654/.test(roadmap)
    && /23 个 MCP tools/.test(roadmap)
    && /profile_inline_conflict/.test(roadmap)
    && /PASS_M12_9_FRESH_HOST_CONTRACT_AND_OUTCOME_ACCEPTANCE/.test(roadmap),
    "roadmap 必须记录精确发布 SHA、Fresh Host 工具面、合同冲突证据与最终 verdict");
});

// ============================================================
// M11-2C routing-semantics micro-closeout.
// The first M11-2C draft said "Before starting any worker, run ... WAO preflight"
// and "drives the full minimal loop through every MCP tool". Both over-reached:
// the former forced native-subagent routes through a WAO preflight (contradicting
// "Lead keeps the routing choice"); the latter implied all tools are a
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

test("M11-2C-12: SKILL tool-count 文案不得声称 minimal loop 必须经过全部工具", () => {
  const skill = read("SKILL.md");
  // 禁止暗示全部工具都是 mandatory loop。playbook catalog 是可选、位于
  // dispatch loop 外的只读 resources（M12-10 起为 MCP resources，非工具）。
  const mandatoryAll = /full\s+minimal\s+loop\s+through\s+15|minimal\s+loop\s+必须.*全部\s*15|loop\s+must\s+(use|go through|include)\s+all\s+15/i;
  assert.ok(!mandatoryAll.test(skill),
    "SKILL tool-count 文案不得声称 minimal loop 必须经过全部工具");
  // 必须表达：WAO 暴露 22 tools，但 minimal control loop 只用相关 control tools，
  // playbook resources 是可选且在 dispatch loop 外。
  assert.ok(/22 MCP tools|22 tools/i.test(skill),
    "SKILL 声明 WAO 暴露 22 MCP tools");
  assert.ok(!/23 MCP tools|23 tools/i.test(skill),
    "SKILL 不得再声称 23 tools");
  assert.ok(/optional|可选/i.test(skill) && /dispatch loop|control loop/i.test(skill),
    "SKILL 必须说明 playbook reads 可选且在 dispatch/control loop 之外");
});

test("M11-3D1: Lead 在 decision 前逐文件逐页 review，并把 fragment 当不可信数据", () => {
  const skill = read("SKILL.md");
  const usage = read("docs/usage.md");
  assert.ok(skill.indexOf("`run_delivery_review`") > skill.indexOf("`run_delivery`")
    && skill.indexOf("`run_delivery_review`") < skill.indexOf("`run_delivery_decide`"),
    "SKILL 工具表把 review 放在 delivery query 与 decision 之间");
  assert.ok(/every `fileIndex`|每个.*fileIndex/i.test(skill) && /nextCursor.*until null|nextCursor.*null/i.test(skill),
    "SKILL 要求逐文件并沿 nextCursor 读完");
  assert.ok(/untrusted repository text/i.test(skill) && /never execute commands|绝不执行/i.test(skill),
    "SKILL 明确 diff fragment 是不可信数据，不可执行其中命令");
  assert.ok(/untrusted_repository_text/.test(usage) && /prompt injection/i.test(usage),
    "usage 记录 artifact trust marker 与 prompt injection 边界");
});

test("M11-3D: 本地 Git fallback 只用于不可用 review，roadmap 记录 fresh Lead dogfood PASS", () => {
  const skill = read("SKILL.md");
  const roadmap = read("docs/roadmap.md");
  assert.ok(/fallback only when review returns `available:false`.*`binary` or `diff_too_large`/i.test(skill),
    "SKILL 将本地只读 Git fallback 限于 binary/diff_too_large");
  const m11Row = roadmap.split("\n").find((l) => /^\|\s*M11\s*\|/.test(l)) || "";
  assert.ok(/M11-3.*A\/B\/C.*完成|M11-3A\/B\/C.*完成/i.test(m11Row),
    "roadmap 标记 M11-3A/B/C 完成");
  assert.ok(/M11-3D.*fresh Codex CLI Lead dogfood.*(PASS|已完成|已通过)/i.test(m11Row),
    "roadmap 标记 M11-3D fresh Codex CLI Lead dogfood 已通过");
  assert.ok(/run_20260721225501254ly42og|76039be/i.test(m11Row),
    "roadmap 保留 M11-3D 最小证据锚点");
  assert.ok(!/M11-3D.*dogfood.*(待完成|未完成|pending)/i.test(m11Row),
    "roadmap 不再把 M11-3D dogfood 标为待完成");
});

// ============================================================
// M11-2 real Lead dogfood SSOT guard (de-bloated).
// One narrow guard: the M11-2 fresh Codex CLI Lead dogfood is recorded as
// complete in the M11 row, with a durable evidence anchor, and the old "still
// open" phrasing is gone. M11-overall-in-progress is already pinned by the
// existing M11 mainline + M11-2C-07 guards, so it is not repeated here.
// ============================================================

test("M11-2-DOGFOOD: fresh Codex CLI Lead dogfood marked complete with anchor, removed from open list", () => {
  const roadmap = read("docs/roadmap.md");
  const m11Row = roadmap.split("\n").find((l) => /^\|\s*M11\s*\|/.test(l)) || "";
  assert.ok(m11Row, "roadmap 含 M11 行");
  // (1) dogfood 标记为完成/PASS，并说明是 fresh Codex CLI Lead。
  assert.ok(/dogfood.*(完成|PASS|通过).*fresh Codex CLI|fresh Codex CLI.*dogfood.*(完成|PASS|通过)/i.test(m11Row),
    "roadmap 标记 fresh Codex CLI Lead dogfood 已完成/PASS");
  // (2) 含一个最小证据锚点（runId 或短 delivery commit）。
  assert.ok(/run_202607192128556114jk5v4|cc4bfda/i.test(m11Row),
    "roadmap 含 runId 或短 delivery commit 作为证据锚点");
  // (3) 旧开放项短语已从"仍开放"清单消失。
  const openMatch = m11Row.match(/仍开放[^。]*。/);
  const openList = openMatch ? openMatch[0] : "";
  assert.ok(!/M11-2.*真实.*Lead.*dogfood|真实.*Lead.*dogfood/i.test(openList),
    "roadmap '仍开放' 清单不再含旧短语 'M11-2 真实 Lead dogfood'");
});

// ============================================================
// M11-4 run_collect continuation guards.
// Long-term contract guards (not one-off report parsers):
//   1. usage.md documents the cursor input + nextCursor output + safety.
//   2. SKILL.md tells the Lead to follow nextCursor to null.
//   3. architecture.md lists runCollectProjection.js as shared ownership.
//   4. roadmap records M11-4 fresh Lead dogfood completed (this package's fact).
// M11-overall-in-progress + TD-106 open/unique are pinned by existing
// M11 mainline and M10 closeout guards — not repeated here.
// ============================================================

test("M11-4-DOC-01: usage.md documents run_collect cursor input + nextCursor + zero-append-on-invalid", () => {
  const usage = read("docs/usage.md");
  // Input accepts optional opaque cursor.
  assert.ok(/run_collect/.test(usage), "usage covers run_collect");
  assert.ok(/"cursor"/.test(usage) && /opaque continuation token/i.test(usage),
    "usage documents the optional opaque cursor input");
  // Output carries nextCursor (null or token).
  assert.ok(/"nextCursor"/.test(usage), "usage documents nextCursor output field");
  // Continuation semantics: page-by-page until null, exact-once, frozen snapshot.
  assert.ok(/续读|continuation/i.test(usage), "usage documents continuation flow");
  assert.ok(/无漏项.*无重复|no loss.*no dup/i.test(usage) || /完整.*按序.*无漏项.*无重复/.test(usage),
    "usage states no-loss/no-duplication reconstruction");
  assert.ok(/snapshot.*冻结|frozen.*snapshot|frozen.*prefix/i.test(usage),
    "usage documents frozen-snapshot stability");
  // Security: cursor never carries raw sensitive values.
  assert.ok(/cursor.*不含.*raw|cursor.*绝不.*raw|绝不.*raw runId/i.test(usage),
    "usage states cursor carries no raw runId/session/path/prompt/secret");
  // Invalid cursor → zero audit append.
  assert.ok(/invalid cursor|无效 cursor/i.test(usage) && /零追加|zero.*append/i.test(usage),
    "usage states invalid cursor → zero audit append");
});

test("M11-4-DOC-02: SKILL.md tells Lead to follow nextCursor to null via run_collect", () => {
  const skill = read("SKILL.md");
  assert.ok(/nextCursor.*null.*run_collect|run_collect.*nextCursor.*null/i.test(skill),
    "SKILL instructs Lead to call run_collect with nextCursor until null");
  assert.ok(/不.*读.*runs\/\*\.jsonl|do not read.*runs\/\*\.jsonl|never.*read.*transcript/i.test(skill),
    "SKILL tells Lead not to read raw transcript — safe continuation exists");
});

test("M11-4-DOC-03: architecture.md lists runCollectProjection.js shared ownership", () => {
  const arch = read("docs/02-architecture.md");
  assert.ok(/runCollectProjection\.js/.test(arch),
    "architecture lists runCollectProjection.js as a shared application service");
  assert.ok(/runCollectProjection\.js.*M11-4|M11-4.*runCollectProjection\.js/.test(arch),
    "architecture ties runCollectProjection.js to M11-4");
});

test("M11-4-DOC-04: roadmap records M11-4 fresh Lead dogfood completed", () => {
  const roadmap = read("docs/roadmap.md");
  const m11Row = roadmap.split("\n").find((l) => /^\|\s*M11\s*\|/.test(l)) || "";
  assert.ok(m11Row, "roadmap 含 M11 行");
  // M11-4 fresh Lead dogfood is recorded as complete.
  assert.ok(/M11-4.*fresh.*Lead.*dogfood.*(完成|PASS|通过)|fresh.*Codex.*CLI.*Lead.*M11-4.*dogfood.*(完成|PASS|通过)/i.test(m11Row)
    || /M11-4.*dogfood.*(PASS_WITH_HOST_FRICTION|完成|已通过)/i.test(m11Row),
    "roadmap marks M11-4 fresh Lead dogfood complete");
  // Verdict is PASS_WITH_HOST_FRICTION (not plain PASS — friction preserved).
  assert.ok(/PASS_WITH_HOST_FRICTION/.test(m11Row),
    "roadmap records M11-4 verdict as PASS_WITH_HOST_FRICTION (friction preserved)");
  // Durable evidence anchor (runId).
  assert.ok(/run_m114_fresh_lead_20260722/.test(m11Row),
    "roadmap carries the M11-4 dogfood runId anchor");
  // No stale "pending" / "待授权" / "待执行" phrasing for M11-4 dogfood.
  assert.ok(!/M11-4.*dogfood.*待|M11-4.*fresh Lead dogfood.*待(授权|执行|验收)|fresh Lead dogfood.*待.*M11-4/i.test(m11Row),
    "roadmap no longer marks M11-4 dogfood as pending");
  // M11-overall-in-progress is pinned by the existing M11 mainline guard —
  // not repeated here.
});

test("M11-4-DOC-05: TD-106 records M11-3/M11-4 capabilities as resolved, old open gaps gone", () => {
  const td = read("docs/tech-debt.md");
  const td106Row = td.split("\n").find((l) => /^\|\s*TD-106\s*\|/.test(l)) || "";
  assert.ok(td106Row, "TD-106 row present");
  // M11-3 safe delivery diff review recorded as resolved.
  assert.ok(/run_delivery_review.*M11-3|M11-3.*run_delivery_review|安全.*delivery.*diff.*review.*M11-3|M11-3.*安全.*delivery.*diff.*review/i.test(td106Row),
    "TD-106 records M11-3 safe delivery diff review as resolved");
  // M11-4 run_collect continuation recorded as resolved.
  assert.ok(/run_collect.*continuation.*M11-4|M11-4.*run_collect.*continuation|cursor.*continuation.*M11-4/i.test(td106Row),
    "TD-106 records M11-4 run_collect cursor continuation as resolved");
  // The old open-gap phrasings must NOT remain as unresolved capability gaps.
  assert.ok(!/raw artifact\/diff review 仍开放/.test(td106Row),
    "TD-106 no longer lists raw artifact/diff review as open (M11-3 resolved it)");
  assert.ok(!/run_collect.*截断时.*可能回退|run_collect.*截断时.*Lead 可能/.test(td106Row),
    "TD-106 no longer declares run_collect truncation raw-transcript fallback as an open gap (M11-4 resolved it)");
  // TD-106 uniqueness + design-constraint placement are pinned by the post-M12
  // closeout guards — not repeated here.
});

test("post-M12 runtime reliability closeout: TD-48/71/80 resolved, TD-106 non-goal, roadmap facts pinned", () => {
  const td = read("docs/tech-debt.md");
  const roadmap = read("docs/roadmap.md");
  const repaidSection = (td.split("## 已偿还")[1] ?? "").split("## 开放")[0] ?? "";
  const openSection = (td.split("## 开放")[1] ?? "").split("## 设计性约束")[0] ?? "";
  const designSection = td.split("## 设计性约束")[1] ?? "";

  for (const id of ["TD-48", "TD-71", "TD-80"]) {
    assert.match(repaidSection, new RegExp(`^\\|\\s*${id}\\b`, "m"), `${id} must be in repaid section`);
    assert.doesNotMatch(openSection, new RegExp(`^\\|\\s*${id}\\b`, "m"), `${id} must not remain open`);
  }
  assert.match(designSection, /^\|\s*TD-106\b/m, "TD-106 must be a WAO non-goal/design constraint");
  assert.match(td, /TD-48[^\n]*(diagnose[^\n]*single|single[^\n]*diagnose|单[^\n]*run)[^\n]*(dashboard|1\.8)/i,
    "TD-48 must record current CLI diagnose/dashboard measurement truth");
  assert.match(td, /TD-71[^\n]*EPERM[^\n]*EBUSY[^\n]*(bounded|有界)/i,
    "TD-71 must record bounded Windows append-lock retry");
  assert.match(td, /TD-80[^\n]*legacy[^\n]*evidence_passed_backend_failed/i,
    "TD-80 must record the legacy transcript projection fix");

  assert.match(roadmap, /M12-23[^\n]*runtime reliability truth/i,
    "roadmap must record the post-M12 runtime reliability package");
  assert.match(roadmap, /run_20260813121845752xjmrki[^\n]*run_20260813121903407dgqn1a/,
    "roadmap must pin the Auditor fresh/resume canary runIds");
  assert.match(roadmap, /run_20260702142549160dfqmrt[^\n]*evidence_passed_backend_failed/,
    "roadmap must pin the real legacy transcript replay result");
  assert.match(roadmap, /run_20260813123526210jd19dv[^\n]*(rejected|拒绝)[^\n]*run_20260813130405682nt4f6t/,
    "roadmap must preserve the rejected root delivery and continuation correction lineage");
});

// ===== M11-5 Package C: documentation truthfulness guards =====
// Narrow guards (string presence/absence, not free-text parsers) that pin the
// truthful claims established in Package C. Failure → fix the doc, not the test.

// C-DOC-1: docs must NOT claim the role body "never" / "绝不" enters the
// transcript as an absolute. The truthful claim is that WAO does not persist
// the role contract as prompt.sent/control-plane input; worker OUTPUT may
// echo or summarize the role. The absolute "绝不保存角色正文/zero-leak" wording
// is untruthful and must be gone from architecture/usage/tech-debt.
test("M11-5-C-DOC-1: docs do not claim role body absolutely never in transcript", () => {
  for (const rel of ["docs/02-architecture.md", "docs/usage.md", "docs/tech-debt.md"]) {
    const text = read(rel);
    assert.ok(!/绝不保存角色正文|角色正文零泄漏|never persists role (body|content)/i.test(text),
      `${rel}: must not claim role body absolutely never in transcript (worker output may echo role)`);
  }
});

// C-DOC-2: architecture/usage document the path authority (relative
// systemPrompt resolves against the WAO install root, not cwd) so cross-project
// use is a documented fact, not an implementation accident.
test("M11-5-C-DOC-2: docs document path authority (WAO install root, not cwd)", () => {
  const arch = read("docs/02-architecture.md");
  const usage = read("docs/usage.md");
  assert.ok(/相对 WAO 安装根|install root|not.*cwd|不依赖.*cwd|不依赖调用者 cwd/i.test(arch),
    "architecture documents install-root path authority");
  assert.ok(/相对 WAO 安装根|install root|not.*cwd|不依赖.*cwd|不依赖调用者 cwd/i.test(usage),
    "usage documents install-root path authority");
});

// C-DOC-3: docs document the strict capability judgment (=== true, not truthy).
test("M11-5-C-DOC-3: docs document strict capability judgment (=== true)", () => {
  const arch = read("docs/02-architecture.md");
  assert.ok(/supportsRoleContract === true|严格相等|strict/i.test(arch),
    "architecture documents strict (=== true) capability judgment");
});

// C-DOC-4: docs document the load timing truthfully — start loads BEFORE
// transcript creation; resume loads AFTER reading the existing transcript but
// before any append/spawn (not "before reading transcript").
test("M11-5-C-DOC-4: docs document truthful load timing (start pre-transcript; resume post-read pre-spawn)", () => {
  const arch = read("docs/02-architecture.md");
  assert.ok(/start.*创建 transcript.*前|start.*before.*transcript/i.test(arch),
    "architecture: start loads before transcript creation");
  assert.ok(/resume.*读取.*transcript.*后|resume.*after read/i.test(arch),
    "architecture: resume loads after reading transcript");
});

// ===== M11-11D: Lead friction closeout guards =====

test("M11-11D-DOC-01: terminal run_wait proceeds to collect without redundant status", () => {
  const skill = read("SKILL.md");
  const usage = read("docs/usage.md");
  assert.ok(/run_wait.*terminal:true.*run_collect.*不.*run_status|terminal:true.*run_collect.*redundant.*run_status/is.test(skill),
    "SKILL sends terminal run_wait directly to collect");
  assert.ok(/terminal:true.*run_collect.*不需要.*run_status/is.test(usage),
    "usage documents no redundant status call after terminal wait");
});

test("M11-11D-DOC-02: ordinary non-delivery query is structured truth", () => {
  const usage = read("docs/usage.md");
  assert.ok(/deliveryRequested.*普通非 delivery run.*deliveryAvailable:false.*deliveryRequested:false.*deliveryFailure:null/is.test(usage),
    "usage distinguishes a normal non-delivery run from packaging failure");
});

test("M11-11D-DOC-03: stop_verified means runtime quiet, not necessarily explicit stop", () => {
  const usage = read("docs/usage.md");
  assert.ok(/run\.stop_verified.*runtime.*静默/is.test(usage),
    "usage gives stop_verified a runtime-quiet meaning");
  assert.ok(/run\.stop_verified.*不表示 Lead 一定调用过 stop/is.test(usage),
    "usage does not infer an explicit Lead stop");
});

test("M11-11D-DOC-04: token forecast is retired from current product surfaces", () => {
  const readme = read("README.md");
  assert.ok(!existsSync(join(ROOT, "src", "costForecast.js")),
    "retired costForecast module stays removed");
  assert.ok(!/cost forecasting/i.test(readme),
    "README no longer lists token forecasting as a current capability");
});

test("M11-12C-DOC-01: every delivery run queries delivery truth after terminal", () => {
  const skill = read("SKILL.md");
  assert.ok(/every run dispatched with a delivery block.*run_delivery.*terminal.*failed/is.test(skill),
    "SKILL queries run_delivery after every delivery run, including failed terminal runs");
  assert.ok(/deliveryAvailable=false.*deliveryFailure\.code.*do not call `?run_delivery_review`?.*`?run_delivery_decide`?/is.test(skill),
    "SKILL routes packaging failure through its structured code without review or decision");
  assert.ok(/run_diagnose.*does not replace.*run_delivery/is.test(skill),
    "SKILL keeps general diagnosis supplementary to delivery truth");
});

// ============================================================
// M12-0: Lead Token Efficiency + Assisted Orchestration product contract reset.
// These guards lock the reset authority boundary across the five authority docs
// + ADR-0018. The reset makes explicit that WAO's value is routing worker token
// spend onto external provider quota, and that WAO is an assisted execution
// control plane — not a gate or a second semantic supervisor. Failure → fix the
// doc, not the test.
// ============================================================

const M12_AUTHORITY_DOCS = [
  "docs/01-prd.md",
  "docs/02-architecture.md",
  "docs/roadmap.md",
  "README.md",
  "SKILL.md",
];
const M12_ADR = ".wao/decisions/0018-wao-mechanical-containment-no-auto-supervision.md";
const M12_CN = "WAO 自动监测，不自动监督；自动封装，不自动验收；自动呈现，不自动决策。";
const M12_EN = "WAO monitors, never supervises; packages, never accepts; presents, never decides.";

// M12-0-01: every authority doc + ADR-0018 carries the exact mechanical-containment
// sentence in both Chinese and English. This is the single canonical statement of
// the reset; paraphrases drift, so the exact strings are pinned.
test("M12-0-01: 五份 authority docs + ADR-0018 携带精确机械 containment 句（中+英逐字）", () => {
  for (const rel of [...M12_AUTHORITY_DOCS, M12_ADR]) {
    const text = read(rel);
    assert.ok(text.includes(M12_CN), `${rel} 缺精确中文 containment 句`);
    assert.ok(text.includes(M12_EN), `${rel} 缺精确英文 containment 句`);
  }
});

// M12-0-02: forbid the old supervision alternative phrasings that blur the line
// between process-liveness observation/containment (WAO-owned) and supervision
// (Lead-owned). "不自动监督" (the exact sentence) is allowed; the alternatives
// "自动监督过程" / "不做语义监督" must be gone.
test("M12-0-02: authority docs + ADR 禁止旧监督替代表述（自动监督过程 / 不做语义监督）", () => {
  for (const rel of [...M12_AUTHORITY_DOCS, M12_ADR]) {
    const text = read(rel);
    assert.ok(!/自动监督过程/.test(text), `${rel} 不得使用替代表述"自动监督过程"`);
    assert.ok(!/不做语义监督/.test(text), `${rel} 不得使用替代表述"不做语义监督"`);
  }
});

// M12-0-03: PRD must not retain the retracted LLM-router / auto-semantic-workflow
// product directions. The Lead defines/selects/modifies the deterministic plan;
// the already-shipped WorkflowEngine is only a Lead-authored expert mechanical
// executor. The "LLM orchestrator as a first-class pluggable strategy" and "use
// an LLM to decide routing" directions are gone.
test("M12-0-03: PRD 删除 LLM router / 自动语义 workflow 产品方向", () => {
  const prd = read("docs/01-prd.md");
  assert.ok(!/LLM 编排器.*一等公民|一等公民.*LLM 编排器/.test(prd),
    "PRD 不得保留'LLM 编排器（一等公民）'产品方向");
  assert.ok(!/用 LLM 决定分流/.test(prd),
    "PRD 不得保留'用 LLM 决定分流到哪个 agent'产品方向");
  assert.ok(/Lead.*定义.*选择.*修改.*deterministic|Lead.*defines.*selects.*modifies.*deterministic|定义\/选择\/修改.*deterministic/i.test(prd),
    "PRD 必须说明 Lead 定义/选择/修改 deterministic execution plan");
  assert.ok(/Lead-authored.*mechanical|mechanical executor|专家级.*机械.*执行|Lead-authored expert mechanical/i.test(prd),
    "PRD 必须把已实现 WorkflowEngine 定位为 Lead-authored expert mechanical executor");
});

// M12-0-04: architecture downgrades router/gate to mechanical. router is a
// Lead-authored deterministic function; gate is a Lead-specified mechanical
// condition. No WAO/LLM auto semantic routing or semantic acceptance. run_wait
// is liveness observation; supervision belongs to the Lead.
test("M12-0-04: architecture router=Lead-authored deterministic，gate=mechanical condition；run_wait 是 liveness observation", () => {
  const arch = read("docs/02-architecture.md");
  assert.ok(!/可由 LLM 驱动/.test(arch),
    "architecture 不得把 router 描述为'可由 LLM 驱动'");
  assert.ok(!/可插拔策略的一等公民/.test(arch),
    "architecture 不得保留 LLM 编排器'可插拔策略的一等公民'方向");
  assert.ok(/Lead-authored deterministic|router.*deterministic.*function|router 是.*Lead.*deterministic|Lead.*定义.*router.*deterministic/i.test(arch),
    "architecture 必须把 router 定义为 Lead-authored deterministic function");
  assert.ok(/mechanical condition|机械条件|Lead.*specified.*mechanical|Lead-specified mechanical/i.test(arch),
    "architecture 必须把 gate 定义为 Lead-specified mechanical condition（非语义验收）");
  assert.ok(/run_wait.*liveness|liveness observation|观察.*监督.*Lead|supervision.*Lead|监督.*属于 Lead|supervision belongs to the Lead/i.test(arch),
    "architecture 必须说明 run_wait 是 liveness observation，supervision 属于 Lead");
});

// M12-0-05: certification/readiness is advisory evidence, not a permission gate.
// The Lead may choose any configured worker subject to project governance. The
// hard-gate phrasings ("require a certified worker for real changes", "Use only
// workers whose certification is certified") must be gone from SKILL.
test("M12-0-05: SKILL 把 certification 定位为 advisory evidence，删除 permission hard gate 措辞", () => {
  const skill = read("SKILL.md");
  assert.ok(/advisory evidence|advisory.*not.*(?:a )?gate|not a permission gate|certification.*advisory/i.test(skill),
    "SKILL 必须把 certification 定位为 advisory evidence，非 permission gate");
  assert.ok(!/require a `?certified`? worker for real changes/i.test(skill),
    "SKILL 不得再硬性 require a certified worker for real changes");
  assert.ok(!/Use only workers whose.*certification is `?certified`?/i.test(skill),
    "SKILL 不得再要求 Use only workers whose certification is certified");
  assert.ok(!/strict-dispatch|strict dispatch/i.test(skill),
    "SKILL 不得再使用 strict-dispatch 硬门框架");
});

// M12 closeout: M11 stays closed complete (Tester token efficiency retired/deferred
// out of M11); M12's implemented slices remain recorded while unvalidated broader
// cross-run aggregation is an explicit non-blocking candidate, not a completion gate.
test("M12 closeout: roadmap 标 M11/M12 ✅ 完成；已实现 slices 保留且跨 run 聚合非阻塞", () => {
  const roadmap = read("docs/roadmap.md");
  const m11Row = roadmap.split("\n").find((l) => /^\|\s*M11\s*\|/.test(l)) || "";
  assert.ok(m11Row, "roadmap 含 M11 行");
  assert.ok(/✅\s*完成/.test(m11Row), "M11 行必须标为 ✅ 完成");
  assert.ok(/Tester.*(?:token|context).*efficiency.*(退役|retire|defer|延后)/i.test(m11Row)
    || /Tester.*efficiency.*(退役|retire|defer|延后)/i.test(m11Row),
    "M11 行必须记录 Tester token efficiency retire/defer");
  const m12Row = roadmap.split("\n").find((l) =>
    /^\|\s*M12\s*\|/.test(l) && /Lead Token Efficiency/.test(l)) || "";
  assert.ok(m12Row, "roadmap 必须有 M12 行");
  assert.ok(/✅.*完成/.test(m12Row), "M12 行必须标为 ✅ 完成");
  assert.ok(/M12-1 S1\/S2 已实现/.test(m12Row), "M12-1 S1/S2 必须标为已实现");
  assert.ok(/candidateInventory/.test(m12Row), "M12-1 S1 candidateInventory 必须记录");
  assert.ok(/run_delivery_repackage/.test(m12Row), "M12-1 S2 run_delivery_repackage 必须记录");
  assert.ok(/M12-2A 已实现/.test(m12Row) && /run_collect/.test(m12Row),
    "M12-2A compact run_collect 必须标为已实现");
  assert.ok(/M12-3A\/B 已实现/.test(m12Row)
    && /run_await_result/.test(m12Row)
    && /run_delivery_review_bundle/.test(m12Row),
  "M12-3A/B 两个组合工具必须标为已实现");
  assert.ok(/M12-4A 已实现/.test(m12Row)
    && /backend_failed/.test(m12Row)
    && /run_delivery_repackage/.test(m12Row),
  "M12-4A backend failure retained-candidate recovery 必须标为已实现");
  // The deferred candidate is NARROWED (M12-9 closeout): bounded actionable
  // failure facts (run_diagnose) and factual readiness projection (run_delivery)
  // were already delivered, and M12-9 closes the single-snapshot bounded terminal
  // outcome/handoff projection. Only the broader cross-run / historical
  // evidence/handoff aggregation remains outside the completion definition. The
  // stale wording that listed readiness/history projection as unimplemented must
  // NOT reappear.
  assert.ok(/evidence\/handoff aggregation/i.test(m12Row),
    "M12 非阻塞候选：仅更广的 evidence/handoff aggregation");
  assert.ok(/run_diagnose/.test(m12Row) && /bounded actionable failure facts/i.test(m12Row),
    "M12 必须把 bounded actionable failure facts 归于已交付（run_diagnose）");
  assert.ok(/run_delivery/.test(m12Row) && /readiness\s*投影|readiness\s*projection/i.test(m12Row),
    "M12 必须把 factual readiness 投影归于已交付（run_delivery）");
  assert.ok(/bounded terminal outcome\/handoff\s*投影|terminal outcome\/handoff\s*projection/i.test(m12Row),
    "M12-9 收口单快照 bounded terminal outcome/handoff 投影");
  assert.ok(/移出 M12 完成定义|非阻塞候选/.test(m12Row),
    "M12 必须明确跨 run 聚合不是完成门槛");
});

test("M12-4A docs: backend recovery is model-free and preserves Lead scope/decision authority", () => {
  const skill = read("SKILL.md");
  const usage = read("docs/usage.md");
  const arch = read("docs/02-architecture.md");
  const troubleshooting = read("docs/troubleshooting.md");
  for (const [name, text] of Object.entries({ skill, usage, arch, troubleshooting })) {
    assert.ok(/backend_failed/.test(text), `${name} 必须记录 backend_failed candidate kind`);
  }
  assert.ok(/不调用 model|no model/i.test(usage), "usage 必须明确恢复不调用模型");
  assert.ok(/Lead.*allowedPaths|allowedPaths.*Lead/i.test(usage), "usage 必须保留 Lead scope 权威");
  assert.ok(/不自动.*decision|不作 decision|不自动 accept\/reject/i.test(arch),
    "architecture 必须保留 Lead decision 权威");
});

test("M12-3B docs: review bundle is mechanical, one-page, and preserves Lead decisions + atomic tools", () => {
  const skill = read("SKILL.md");
  const usage = read("docs/usage.md");
  const arch = read("docs/02-architecture.md");
  for (const [name, text] of [["SKILL.md", skill], ["docs/usage.md", usage], ["docs/02-architecture.md", arch]]) {
    assert.ok(text.includes("run_delivery_review_bundle"), `${name} documents the bundle`);
  }
  assert.match(usage, /一个.*文件页|one.*page/i);
  assert.match(usage, /不选择.*fileIndex|never.*select/i);
  assert.match(usage, /不遍历文件|never.*travers/i);
  assert.match(usage, /Lead.*run_delivery_decide|Lead.*accept|Lead.*reject/i);
  assert.match(usage, /原子.*保留|atomic.*保留|atomic.*remain/i);
  assert.match(usage, /review:null.*非.*reviewable|非.*reviewable.*review:null/i);
});

// M12-0-07: ADR-0018 exists at the exact filename, is accepted/dated 2026-07-27,
// docs-only, does not claim runtime features implemented, partial-supersedes 0010
// product direction, and retains 0017 MCP-first. The decisions map lists 0018.
test("M12-0-07: ADR-0018 精确路径 + accepted/date + docs-only + partial supersedes 0010 + retains 0017 + map 一致", () => {
  assert.ok(existsSync(join(ROOT, M12_ADR)),
    "ADR-0018 必须存在于精确路径 .wao/decisions/0018-wao-mechanical-containment-no-auto-supervision.md");
  const adr = read(M12_ADR);
  assert.ok(/^status:\s*accepted/im.test(adr), "ADR-0018 status 必须为 accepted");
  assert.ok(/date:\s*2026-07-27/im.test(adr), "ADR-0018 date 必须为 2026-07-27");
  assert.ok(/partial.*supersedes.*0010|supersedes.*0010.*product direction|partial.*取代.*0010/i.test(adr),
    "ADR-0018 必须 partial supersedes 0010 product direction");
  assert.ok(/retain.*0017|retains.*0017|保留.*0017/i.test(adr),
    "ADR-0018 必须 retain 0017 MCP-first");
  assert.ok(/docs-only|docs only|仅文档/i.test(adr), "ADR-0018 必须声明 docs-only");
  assert.ok(!/runtime feature.*implemented|已实现.*runtime feature/i.test(adr),
    "ADR-0018 不得声称 runtime feature implemented");
  const map = read(".wao/decisions/map.md");
  assert.ok(/0018.*wao-mechanical-containment-no-auto-supervision|0018 \| .*mechanical containment/i.test(map),
    "decisions map 必须列出 0018 且与文件名一致");
});

// M12-6 Package 3A (FR-05/FR-06): docs guard for the verifier environment contract.
// Contract #8 + RED coverage "文档守卫说明依赖不继承". The exact-artifact verifier
// runs in an isolated, per-attempt temp env. Ignored/untracked deps from the
// worker (or selected) worktree — node_modules, build artifacts, etc. — must NOT
// auto-appear there; Lead declares verificationSetupCommands to prepare them.
// This guard pins the doc invariant so it cannot silently drift.
test("M12-6 docs: exact verifier env does NOT inherit worker node_modules — Lead setup commands required", () => {
  const usage = read("docs/usage.md");
  const arch = read("docs/02-architecture.md");
  // (1) The verifier runs in an isolated per-attempt temp env, not the worktree.
  assert.ok(/isolat.*verifier|verifier.*isolat|独立.*临时|per-attempt.*temp|每次.*attempt.*temp/i.test(usage),
    "usage 必须说明 exact verifier 运行在独立的 per-attempt 临时环境");
  // (2) Ignored/untracked deps (node_modules) are NOT inherited into that env.
  assert.ok(/node_modules|ignored.*dependenc|untracked.*dependenc|依赖.*不继承|不继承.*依赖/i.test(usage),
    "usage 必须说明 node_modules 等 ignored 依赖不会自动进入 exact verifier 环境");
  // (3) Lead declares verificationSetupCommands to make such deps available.
  assert.ok(/verificationSetupCommands/.test(usage),
    "usage 必须记录 verificationSetupCommands 作为 Lead 声明的环境准备入口");
  // (4) Architecture carries the same invariant (single-source consistency).
  assert.ok(/node_modules|ignored.*dependenc|依赖.*不继承|不继承.*依赖/i.test(arch),
    "architecture 必须说明 ignored 依赖不进入 verifier 环境");
});

// ============================================================
// M12-6 FR-07 (Package 3B closeout): audited unchanged-artifact reverify docs.
// The MCP tool already exists; this closeout pins the docs contract for the CLI
// fallback + the Lead guidance. Failure → fix the doc, not the test.
// ============================================================

test("M12-6 FR-07 docs: SKILL 把 reverify 放在 run_delivery 与 decide 之间并限定使用条件", async () => {
  const skill = read("SKILL.md");
  const { REVERIFY_REASONS } = await import("../../src/application/runDeliveryReverify.js");
  // (1) Tool-table order: run_delivery_reverify sits between run_delivery and
  // run_delivery_decide (same discipline as the review tools).
  assert.ok(skill.indexOf("`run_delivery_reverify`") > skill.indexOf("`run_delivery`")
    && skill.indexOf("`run_delivery_reverify`") < skill.indexOf("`run_delivery_decide`"),
    "SKILL 工具表把 reverify 放在 run_delivery 与 run_delivery_decide 之间");
  // (2) Use only when the ORIGINAL verification FAILED and the Lead has judged a
  // closed-set environment cause.
  assert.ok(/original verification.*failed|原.*verification.*failed|原始终态.*failed|original.*失败/i.test(skill),
    "SKILL 必须说明仅当 original verification failed 时使用 reverify");
  assert.ok(REVERIFY_REASONS.length > 0 && /tooling_invalid|environment_contaminated|dependency_setup_missing/.test(skill),
    "SKILL 必须携带闭集环境原因（tooling_invalid/environment_contaminated/dependency_setup_missing）");
  // (3) The delivery commit is UNCHANGED; new setup may be APPENDED, the ORIGINAL
  // assertions can never be modified.
  assert.ok(/unchanged|不变|同一.*commit|same.*commit/i.test(skill),
    "SKILL 必须说明 reverify 针对 unchanged 同一 delivery commit");
  assert.ok(/append|追加|新增.*setup|setup.*新增/.test(skill)
    && /原.*assertions.*不可改|assertions?.*(?:不可改|不变|immutable|never be modified|cannot be modified|can never be modified)|不.*替换.*assertion/i.test(skill),
    "SKILL 必须说明新 setup 可追加、原 assertions 不可改");
  // (4) The result NEVER auto-decides.
  assert.ok(/不.*自动.*decision|不.*自动.*accept|never auto.*decide|不自动 accept\/reject/i.test(skill),
    "SKILL 必须说明 reverify 结果不自动决定");
});

test("M12-6 FR-07 docs: usage 记录 reverify 的 MCP/CLI 输入输出、eligible failure、幂等与原\/有效 verification", () => {
  const usage = read("docs/usage.md");
  // (1) Both surfaces documented: the MCP tool and the CLI fallback.
  assert.ok(/run_delivery_reverify/.test(usage), "usage 必须记录 MCP run_delivery_reverify");
  assert.ok(/runs delivery reverify/.test(usage), "usage 必须记录 CLI runs delivery reverify");
  assert.ok(/--setup-commands-file/.test(usage) && /--timeout-ms/.test(usage) && /--reason/.test(usage),
    "usage 必须记录 CLI 的 --reason / --setup-commands-file / --timeout-ms");
  // (2) Input/output: closed-set reason enum + setupCommands/timeoutMs + safe fields.
  assert.ok(/"reason"/.test(usage) && /"setupCommands"/.test(usage) && /"timeoutMs"/.test(usage),
    "usage 必须记录 MCP 输入字段 reason/setupCommands/timeoutMs");
  assert.ok(/"state"/.test(usage) && /"verificationStatus"/.test(usage) && /"failureCode"/.test(usage),
    "usage 必须记录安全输出字段 state/verificationStatus/failureCode");
  // (3) Eligible failure: the ORIGINAL verification failed with an
  // environment/tooling-invalid code (never content-integrity codes).
  assert.ok(/original.*verification.*failed|原.*verification.*failed|original.*失败/i.test(usage)
    && /command_failed|command_timeout|execution_error|setup_failed|setup_timeout|setup_environment_error/.test(usage),
    "usage 必须说明 eligible failure 是 original verification failed + 环境/工具闭集 code");
  // (4) Idempotency / concurrency: reentrant, converges on the first caller's
  // setup, at most one outcome.
  assert.ok(/reentrant|幂等|idempotent|并发|concurren/i.test(usage) && /first.*caller|首个.*调用|先.*声明.*setup|converge/i.test(usage),
    "usage 必须记录 reverify 的幂等/并发收敛语义");
  // (5) Original vs effective verification: the original outcome is preserved;
  // the effective status is the reverify outcome.
  assert.ok(/original.*verification|原.*verification.*保留|原始终态.*不改写/.test(usage)
    && /effective|有效 verification|reverify.*outcome|reverify 结果/i.test(usage),
    "usage 必须区分原 verification 与 effective（reverify）verification");
  // (6) Lead still owns full review + decide.
  assert.ok(/Lead.*仍|仍由 Lead|Lead 仍须|run_delivery_decide.*仍|不自动.*decide/i.test(usage),
    "usage 必须说明 Lead 仍须完整 review + decide，reverify 不自动决定");
});

test("M12-6 FR-07 docs: usage 的 run_delivery_decide 区分 expected policy rejection 与固定 tool error", () => {
  const usage = read("docs/usage.md");
  // Expected policy rejection (e.g. already_decided) is a NORMAL structured
  // outcome decisionAccepted:false + closed-set rejectionReason — NOT the fixed
  // tool error. Only unexpected/internal errors are the fixed error.
  assert.ok(/decisionAccepted:\s*false/.test(usage) && /"rejectionReason"|rejectionReason/.test(usage),
    "usage 必须记录 decisionAccepted:false + rejectionReason 结构化结果");
  assert.ok(/expected|预期|正常|policy rejection|策略拒绝|already_decided/.test(usage),
    "usage 必须说明 expected policy rejection 是正常结构化结果");
  assert.ok(/unexpected|internal|意外|内部.*错误|只有.*unexpected/.test(usage),
    "usage 必须说明固定 tool error 只留给 unexpected/internal 错误");
});

test("M12-6 FR-07 docs: architecture 记录 reverify 共享 service 与当前 tool 事实", () => {
  const arch = read("docs/02-architecture.md");
  // Shared application service fact (M12-6) — no full usage contract copy.
  assert.ok(/runDeliveryReverify\.js/.test(arch),
    "architecture 必须记录 runDeliveryReverify.js 共享 application service");
  assert.ok(/M12-6/.test(arch),
    "architecture 必须把 reverify service 绑定到 M12-6");
  // Current tool fact on the server.js comment line (exact count is pinned by
  // the M12-8A guard — here only the full list must include the tool).
  assert.ok(/run_delivery_reverify/.test(arch),
    "architecture server.js 工具清单必须包含 run_delivery_reverify");
});

// ============================================================
// M12-10 progressive-disclosure correction guards
//
// The startup-fixed tool-profile model (full/lead + --tool-profile +
// restart-to-recover) is REVERSED: WAO now exposes exactly 22 always-registered
// tools with no profile and no restart, and the built-in playbook catalog is
// presented as MCP resources (wao://playbooks), not tools. These guards lock
// that truth across the live docs and the SKILL entrypoint size cap.
// ============================================================

test("M12-10: SKILL.md stays a slim entrypoint (≤ 15000 bytes)", () => {
  const skill = read("SKILL.md");
  const bytes = Buffer.byteLength(skill, "utf8");
  assert.ok(bytes <= 15000,
    `SKILL.md must stay a slim entrypoint ≤ 15000 bytes (got ${bytes}); move detail to authority docs`);
});

test("M12-10: live docs carry NO tool-profile / restart-to-recover wording", () => {
  // The full/lead profile model, the --tool-profile flag, and the deleted
  // toolProfiles.js module must be gone from the entrypoint + MCP docs.
  for (const [name, text] of [
    ["SKILL.md", read("SKILL.md")],
    ["docs/usage.md", read("docs/usage.md")],
    ["docs/02-architecture.md", read("docs/02-architecture.md")],
    ["README.md", read("README.md")],
  ]) {
    assert.ok(!/--tool-profile/.test(text), `${name}: no --tool-profile flag`);
    assert.ok(!/tool-profile/i.test(text), `${name}: no tool-profile wording`);
    assert.ok(!/toolProfile\b/.test(text), `${name}: no toolProfile identifier`);
    assert.ok(!/toolProfiles\.js/.test(text), `${name}: no reference to deleted toolProfiles.js`);
    // The closed profile pair (full/lead) and their counts must be gone.
    assert.ok(!/full profile|lead profile|full\/lead/i.test(text),
      `${name}: no full/lead profile model`);
    assert.ok(!/`lead` profile|lead` profile/i.test(text), `${name}: no lead profile opt-in`);
  }
});

test("M12-10: live docs present the playbook catalog as MCP resources", () => {
  for (const [name, text] of [
    ["SKILL.md", read("SKILL.md")],
    ["docs/usage.md", read("docs/usage.md")],
    ["docs/02-architecture.md", read("docs/02-architecture.md")],
  ]) {
    assert.ok(/wao:\/\/playbooks/.test(text),
      `${name}: presents the playbook catalog as wao://playbooks resources`);
    // The former playbook tools must not be presented as tools anywhere.
    assert.ok(!/playbook_list tool|playbook_get tool/i.test(text),
      `${name}: no playbook_list/playbook_get tool wording`);
  }
});

test("M12-10: architecture records toolSurface.js as the frozen tool-surface SSOT", () => {
  const arch = read("docs/02-architecture.md");
  assert.ok(/toolSurface\.js/.test(arch),
    "architecture records src/mcp/toolSurface.js as the 21-tool SSOT");
  // The deleted profile module must not be named as an SSOT.
  assert.ok(!/toolProfiles\.js/.test(arch),
    "architecture must not reference the deleted toolProfiles.js");
});

test("M12-10: the 22 always-registered tools are listed in architecture", () => {
  const arch = read("docs/02-architecture.md");
  // The server.js tool-list comment line must carry the 22-tool truth and must
  // NOT list the removed playbook tools.
  const serverLine = arch.split("\n").find((l) => /server\.js.*tools/.test(l)) || "";
  assert.ok(/22 tools/.test(serverLine), "architecture server.js line says 22 tools");
  assert.ok(!/playbook_list/.test(serverLine), "architecture tool list omits playbook_list");
  assert.ok(!/playbook_get/.test(serverLine), "architecture tool list omits playbook_get");
  // workspace_select / run_dispatch_contract_check / run_wait (formerly hidden
  // under lead) must remain in the always-registered list.
  assert.ok(/workspace_select/.test(serverLine), "architecture tool list includes workspace_select");
  assert.ok(/run_dispatch_contract_check/.test(serverLine), "architecture tool list includes run_dispatch_contract_check");
  assert.ok(/\brun_wait\b/.test(serverLine), "architecture tool list includes run_wait");
});

test("M12-10: SKILL documents response-driven progressive disclosure (availableDrilldowns)", () => {
  const skill = read("SKILL.md");
  // availableDrilldowns is response-driven: tool results may advertise deeper
  // SAFE reads, but never auto-call or advertise mutating actions.
  assert.ok(/availableDrilldowns/.test(skill),
    "SKILL documents availableDrilldowns as response-driven progressive disclosure");
  assert.ok(/progressive disclosure/i.test(skill) || /渐进式披露|按需披露/.test(skill),
    "SKILL frames availableDrilldowns as progressive disclosure");
  assert.ok(/never auto-call|does not auto-call|不自动调用|不自动 call/i.test(skill),
    "SKILL states drilldowns never auto-call");
});

test("M12-10 closeout: roadmap records the released 21-tool Fresh Host truth", () => {
  const roadmap = read("docs/roadmap.md");
  const m12Row = roadmap.split("\n").find((line) =>
    line.startsWith("| M12 |") && /Lead Token Efficiency/.test(line)) ?? "";
  assert.match(m12Row, /M12-10.*Fresh Host.*21/s,
    "M12 row must include the M12-10 Fresh Host release and current 21-tool truth");
  assert.doesNotMatch(m12Row, /当前 MCP 工具数升至 23/,
    "M12 row must not retain the pre-M12-10 current tool-count claim");
  assert.match(roadmap, /PASS_M12_10_FRESH_HOST_PROGRESSIVE_DISCLOSURE/,
    "roadmap must record the M12-10 Fresh Host verdict");
});

test("M12-11 closeout: roadmap records local unified wait and termination truth", () => {
  const roadmap = read("docs/roadmap.md");
  assert.match(roadmap, /PASS_M12_11_LOCAL_UNIFIED_WAIT_TERMINATION_SEMANTICS/,
    "roadmap must record the M12-11 local-candidate verdict");
  assert.match(roadmap, /PASS_M12_11_12_FRESH_HOST_SELF_DESCRIBING_WAIT_RESULTS/,
    "roadmap must record the superseding M12-11/12 Fresh Host verdict");
  assert.match(roadmap, /run_20260803180538526wqiofq/,
    "roadmap records the M12-11 root run");
  assert.match(roadmap, /run_20260803191330702am48mx/,
    "roadmap records the accepted correction run");
  assert.match(roadmap, /canonical `181\/181`/,
    "roadmap records the frozen-candidate canonical result");
  assert.match(roadmap, /durable `run\.timed_out`[^;；]*才投影 `execution_deadline`/,
    "roadmap binds execution_deadline to a durable same-run timeout event");
});

test("M12-12 closeout: roadmap records local self-describing result truth", () => {
  const roadmap = read("docs/roadmap.md");
  assert.match(roadmap, /PASS_M12_12_LOCAL_SELF_DESCRIBING_RESULTS/,
    "roadmap must record the M12-12 local-candidate verdict");
  assert.match(roadmap, /`run_wait`、`run_await_result`、`run_delivery`、`run_diagnose`[\s\S]*`semanticNotes`/,
    "roadmap records the four self-describing result surfaces");
  assert.match(roadmap, /工具面仍为 \*\*21\*\*[\s\S]*69031 bytes[\s\S]*71495 bytes[\s\S]*75492 bytes/,
    "roadmap records the honest wire-size comparison without changing the tool count");
  assert.match(roadmap, /run_20260803200250648hhmiex[\s\S]*durable rejected[\s\S]*run_20260803205951066j3txpq[\s\S]*durable accepted/,
    "roadmap records the rejected root and accepted same-session correction");
  assert.match(roadmap, /本段只记录本地候选，尚未发布或完成 Fresh Host 验收/,
    "roadmap retains the frozen local-candidate evidence as history");
  assert.match(roadmap, /main@dc981ca3e4088ad2bbc1e00040d37ad61fa0f95f[\s\S]*精确 \*\*21 个 MCP tools\*\*[\s\S]*wao:\/\/semantics\/delivery\.verification_passed/,
    "roadmap records the released SHA, Fresh Host tool count, and semantic detail resource proof");
  assert.match(roadmap, /canonical `182\/182` files、0 fail/,
    "roadmap records the frozen-candidate canonical result");
});

test("M12 closeout: roadmap marks the milestone complete and records the current Fresh Host truth", () => {
  const roadmap = read("docs/roadmap.md");
  const overviewRows = roadmap.split("\n").filter((line) => /^M12 Lead Token Efficiency/.test(line));
  const progressRows = roadmap.split("\n").filter((line) =>
    /^\| M12 \|/.test(line) && /Lead Token Efficiency/.test(line));

  assert.equal(overviewRows.length, 1, "roadmap has exactly one M12 overview row");
  assert.match(overviewRows[0], /✅ complete/, "M12 overview is complete");
  assert.equal(progressRows.length, 1, "roadmap has exactly one M12 progress row");
  assert.match(progressRows[0], /^\| M12 \| ✅ 完成 \|/, "M12 progress row is complete");
  assert.doesNotMatch(progressRows[0], /🔧 进行中|planned\/unimplemented slices only/,
    "M12 progress row has no stale in-progress wording");
  assert.match(progressRows[0], /跨 run \/ 历史 evidence\/handoff aggregation.*移出 M12 完成定义/,
    "unvalidated cross-run aggregation remains a non-blocking candidate");
  assert.match(roadmap, /main@8a4f5335479cabdc77f046f86971a6b75ebed956/,
    "roadmap records the current published Fresh Host SHA");
  assert.match(roadmap, /PASS_M12_COMPLETE/, "roadmap records the M12 closeout verdict");
});

// ============================================================
// M12 closeout: documentation-truth + third-party onboarding closeout
// (README → AGENT_ONBOARDING one-worker path → registry validate/list →
// MCP host → read-only canary). Failure → fix the doc, not the test.
// ============================================================

test("onboarding closeout: README 是新读者入口——22-tool / M12 complete / 突出链接 AGENT_ONBOARDING.md", () => {
  const readme = read("README.md");
  // Current tool truth (22); stale counts (18/16) gone.
  assert.ok(/22 MCP tools|22 tools/.test(readme),
    "README 必须声明当前 22 MCP tools");
  assert.ok(!/18 MCP tools|16-tool|16 MCP/.test(readme),
    "README 不得再声称 18/16-tool（当前 22 always-registered MCP tools）");
  // M12 complete, not in progress.
  assert.ok(!/M12[^\n]*\s*in progress/.test(readme),
    "README 不得再把 M12 标为 in progress（M12 已 complete）");
  assert.ok(/M0.M12 complete/.test(readme),
    "README 必须说明 M0–M12 complete");
  // Newcomer entrypoint: prominent AGENT_ONBOARDING.md link + one-worker path.
  assert.ok(/AGENT_ONBOARDING\.md/.test(readme),
    "README 必须链接 AGENT_ONBOARDING.md（新读者入口）");
  assert.ok(/config\/agents\.example\.json/.test(readme),
    "README 快速开始必须复制 agents.example.json 模板");
  assert.ok(/registry validate/.test(readme) && /registry list/.test(readme),
    "README 快速开始必须包含 registry validate/list");
  assert.ok(/registry check[^\n]*(?:opencode|只对)/.test(readme),
    "README 必须说明 registry check 只对 opencode-serve backend");
  assert.ok(/MCP host|MCP Host/.test(readme),
    "README 必须指向 MCP Host 配置路径");
  // Correction review (Lead): npm ci canonical (package-lock tracked);
  // generic <agentId> canary; npm-link bounded to top-level wao; MCP stdio
  // command executes from the WAO install root.
  assert.ok(/npm ci/.test(readme),
    "README 必须以 npm ci 为克隆/安装规范命令（package-lock 已入库）");
  assert.ok(/run <agentId>/.test(readme),
    "README 首次只读 canary 必须用通用 <agentId> 占位（从 registry list 挑）");
  assert.ok(!/run (coder_low|coder_hq|researcher|auditor|tester|coder_mm)/.test(readme),
    "README 不得把 canary/命令示例硬编码到具体 worker（首个 canary 对任意保留 worker 可用）");
  assert.ok(/wao dashboard/.test(readme),
    "README npm link 说明必须落在顶层 wao 命令（如 wao dashboard）");
  assert.ok(/install root/.test(readme),
    "README MCP 步骤必须说明 stdio 命令在 WAO 安装根目录执行");
});

test("onboarding closeout: AGENT_ONBOARDING.md 自包含单 worker 安装路径（复制模板/一个 runtime 就够/选择表/registry validate/list）", () => {
  const ob = read("AGENT_ONBOARDING.md");
  // Explicit template copy: agents.example.json → agents.json.
  assert.ok(/config\/agents\.example\.json config\/agents\.json/.test(ob),
    "onboarding 必须显式给出 agents.example.json → agents.json 复制命令");
  // One runtime/auth path is enough.
  assert.ok(/一个就够|一个.*(?:runtime|运行时).*就够|装一个就能用|one runtime/.test(ob),
    "onboarding 必须说明只配一个 runtime/认证路径就够");
  // Keep/delete workers as desired.
  assert.ok(/删到只剩|删掉|删除|prune/.test(ob),
    "onboarding 必须说明可按需保留/删除 worker");
  // Compact choice table: native Claude OAuth / DeepSeek / GLM / Codex login / Kimi Code.
  for (const kw of ["claude login", "DEEPSEEK_API_KEY", "ZHIPU_API_KEY", "codex login", "Kimi"]) {
    assert.ok(ob.includes(kw), `onboarding 选择表必须覆盖：${kw}`);
  }
  // Registry validate/list shown.
  assert.ok(/registry validate/.test(ob) && /registry list/.test(ob),
    "onboarding 必须展示 registry validate/list");
  // Correction review (Lead): generic <agentId> canary (works for ANY retained
  // worker, codex included as a process worker); tracked template vs copied
  // gitignored registry as separate scopes.
  const canary = ob.slice(ob.indexOf("### 4f"), ob.indexOf("## 5"));
  assert.ok(/run <agentId>/.test(canary) && !/run coder_/.test(canary),
    "4f 首次只读 canary 必须用 <agentId> 占位（从 registry list 挑），不得硬编码具体 worker");
  assert.ok(/claude-code \/ codex \/ kimi-code/.test(canary),
    "canary 的进程式 worker 必须并列 claude-code / codex / kimi-code");
  assert.ok(/入库/.test(ob) && /一一对应/.test(ob) && /gitignored/.test(ob),
    "onboarding 必须区分入库模板（与 team-roles 一一对应）与 gitignored 私人 agents.json 副本");
});

test("onboarding closeout: 陈旧 claims 已纠正（零依赖 / 禁 npm link / doctor HEALTHY 硬门 / CLI --cwd vs MCP workspace）", () => {
  const ob = read("AGENT_ONBOARDING.md");
  // WAO is not zero-dependency.
  assert.ok(!/零 npm 依赖|零依赖/.test(ob),
    "onboarding 不得再声称零 npm 依赖（WAO 有 @modelcontextprotocol/sdk + zod）");
  assert.ok(/npm install|npm ci/.test(ob),
    "onboarding 必须包含依赖安装步骤");
  // Top-level `wao` via the documented one-time npm link.
  assert.ok(!/别 `?npm link`?|不要 `?npm link`?/.test(ob),
    "onboarding 不得再禁止 npm link（M12-8F 已文档化一次性 npm link 暴露顶层 wao）");
  assert.ok(/npm link/.test(ob),
    "onboarding 必须说明一次性 npm link 暴露顶层 wao 的路径");
  // Doctor is advisory, not a HEALTHY hard gate.
  assert.ok(!/doctor 必须报 HEALTHY 才能开始用/.test(ob),
    "onboarding 不得再把 doctor 写成 HEALTHY 硬门");
  assert.ok(/advisory|建议性|参考/.test(ob),
    "onboarding 必须把 doctor/preflight 定位为 advisory 事实");
  // CLI --cwd vs MCP session workspace binding distinguished.
  assert.ok(/--cwd/.test(ob) && /workspace/.test(ob),
    "onboarding 必须同时出现 CLI --cwd 与 workspace binding");
  assert.ok(/--workspace-root|roots\/list|workspace_select/.test(ob),
    "onboarding 必须指向 MCP workspace binding 来源");
  // Correction review (Lead): npm ci canonical; npm-link wording bounded to
  // top-level `wao` (not a blanket replacement for `npm run cli --` nested
  // families, doctor invocation preserved); .wao init optional — not a
  // MCP-workspace-binding / run_dispatch prerequisite.
  assert.ok(/npm ci/.test(ob),
    "onboarding 必须以 npm ci 为规范安装命令（package-lock 已入库）");
  assert.ok(/wao dashboard/.test(ob),
    "npm link 说明必须落在顶层 wao 命令（如 wao dashboard）");
  assert.ok(/不是[^。]{0,80}拼写替代/.test(ob),
    "npm link 必须被限定为顶层命令，不得声称整体替代 npm run cli -- 嵌套命令族");
  assert.ok(/npm run cli -- wao doctor/.test(ob),
    "必须保留现行 doctor 调用形式 npm run cli -- wao doctor");
  assert.ok(/可选[\s\S]{0,60}wao init/.test(ob) && /wao init[^。]{0,120}不是[^。]{0,80}前提/.test(ob),
    "wao init 必须标注为可选且不是 MCP workspace 绑定 / run_dispatch 的前提");
});

test("onboarding closeout: usage.md claude-code registry 示例为当前结构化 schema + DeepSeek V4 Flash policy", () => {
  const usage = read("docs/usage.md");
  const start = usage.indexOf("// ── claude-code");
  const end = usage.indexOf("// ── codex");
  assert.ok(start !== -1 && end > start, "usage.md 必须保留 claude-code 配置示例块");
  const ex = usage.slice(start, end);
  // provider carries protocol/baseUrl/apiKeyEnv; model/effort are SIBLINGS.
  assert.ok(/\"protocol\": "anthropic-compatible"/.test(ex)
    && /\"baseUrl\"/.test(ex) && /\"apiKeyEnv\"/.test(ex),
    "usage claude-code 示例的 provider 必须含 protocol/baseUrl/apiKeyEnv");
  assert.ok(/\"model\"[\s\S]{0,300}\"contextWindow\"/.test(ex),
    "usage claude-code 示例必须有 sibling model {id, contextWindow}（不在 provider 内）");
  assert.ok(/\"reasoning\"[\s\S]{0,300}\"effort\"/.test(ex),
    "usage claude-code 示例必须有 sibling reasoning {effort}（不在 provider 内）");
  // Stale inlined shape gone; current coder_low policy.
  assert.ok(!/glm-5-turbo/.test(ex),
    "usage claude-code 示例不得再出现旧 provider.model=glm-5-turbo 内联形状");
  assert.ok(/deepseek-v4-flash/.test(ex) && /DEEPSEEK_API_KEY/.test(ex),
    "usage claude-code 示例必须是当前 coder_low DeepSeek V4 Flash policy");
});

test("onboarding closeout: agents.example.json 移除 managed-flag 向后兼容声明、coder_hq 标为 max、标注可裁剪示例", () => {
  // No legacy managed-flag compatibility claim in any editable doc.
  for (const rel of ["config/agents.example.json", "README.md", "AGENT_ONBOARDING.md", "docs/usage.md"]) {
    assert.ok(!/prependArgs[^。\n]*向后兼容|手拼 prependArgs[^。\n]*兼容/.test(read(rel)),
      `${rel} 不得再声称手拼 managed model/effort flags（args/prependArgs）向后兼容（provider 一等字段编译）`);
  }
  // coder_hq certification label: max, not high.
  const parsed = JSON.parse(read("config/agents.example.json"));
  const hqCert = parsed.certification.matrix.find((m) => m.agentId === "coder_hq");
  assert.equal(hqCert?.label, "GLM-5.3[1m] max via claude-code wrapper",
    "agents.example.json 的 coder_hq 认证 label 必须为 max（不是 high），且与实际配置 glm-5.3[1m] 对齐（2026-08-15 漂移修正）");
  // File labeled a complete example prunable to one worker.
  const raw = read("config/agents.example.json");
  assert.ok(/完整示例|complete example/.test(raw),
    "agents.example.json 必须标注为完整示例/推荐配置");
  assert.ok(/一个 worker|one worker|删到只剩/.test(raw),
    "agents.example.json 必须说明可删减到只剩一个 worker");
  // Correction review (Lead): tracked template stays aligned one-to-one with
  // the canonical team roles; pruning happens on the gitignored private copy
  // (agents.json), never on the tracked template itself.
  assert.ok(/入库/.test(raw) && /一一对应/.test(raw) && /team-roles/.test(raw),
    "agents.example.json 必须自述为入库模板且与 team-roles.md 角色一一对应");
  assert.ok(/config\/agents\.json（gitignored|复制为 config\/agents\.json/.test(raw),
    "裁剪作用域必须指向 gitignored 的私人 agents.json 副本，而非模板本身");
  assert.ok(!/本文件[^。]{0,40}(?:按可用认证|删减|编辑|修改)/.test(raw),
    "入库模板不得声称按认证删减/编辑它本身（删减只发生在私人副本）");
});

// ============================================================
// Third-party onboarding helper docs.
// The approved contract forbids a new durable onboarding document, so the
// authority lives in the EXISTING AGENT_ONBOARDING.md (§9). These guards bind
// that section to the implemented contract: the MCP-native acceptance chain,
// PASS criterion, dispatch≠PASS, CLI canary as diagnostic-only, the four
// diagnosis branches, and the transport/window-expiry ≠ worker-stopped
// distinction. They also anti-regress: docs/onboarding.md must NOT exist, and
// no live doc may dangle a pointer at it. Failure → fix the doc, not the test.
// ============================================================

test("onboarding docs: no durable docs/onboarding.md (contract forbids it) and no dangling pointers", () => {
  // Anti-regression: the contract forbids a new durable onboarding document.
  assert.ok(!existsSync(join(ROOT, "docs", "onboarding.md")),
    "docs/onboarding.md must not exist (authority lives in AGENT_ONBOARDING.md §9)");
  // No live doc may dangle a pointer at the removed file.
  for (const f of ["AGENT_ONBOARDING.md", "docs/usage.md"]) {
    assert.ok(!read(f).includes("docs/onboarding.md"),
      `${f} must not reference the removed docs/onboarding.md (dangling pointer)`);
  }
});

test("onboarding docs: AGENT_ONBOARDING.md documents the wao onboarding command + host-neutral snippet summary", () => {
  const ob = read("AGENT_ONBOARDING.md");
  // The command and its key flags.
  assert.ok(/wao onboarding/.test(ob), "AGENT_ONBOARDING.md must document the `wao onboarding` command");
  assert.ok(/--agent/.test(ob) && /--apply/.test(ob) && /--endorse-worker/.test(ob),
    "AGENT_ONBOARDING.md must document --agent / --apply / --endorse-worker");
  // The host-neutral MCP stdio snippet summary (generic mcpServers.wao, Node v22 shim).
  assert.ok(/mcpServers/.test(ob) && /wao-node\.cjs/.test(ob),
    "AGENT_ONBOARDING.md must reference the host-neutral MCP stdio snippet (mcpServers.wao via the v22 shim); full snippet authority is docs/usage.md");
});

test("onboarding docs: formal acceptance chain is MCP-native (lead_preflight → run_dispatch no-delivery canary → run_await_result)", () => {
  const ob = read("AGENT_ONBOARDING.md");
  // The three MCP tools of the chain.
  assert.ok(/lead_preflight/.test(ob), "AGENT_ONBOARDING.md must name lead_preflight");
  assert.ok(/run_dispatch/.test(ob), "AGENT_ONBOARDING.md must name run_dispatch");
  assert.ok(/run_await_result/.test(ob), "AGENT_ONBOARDING.md must name run_await_result");
  // The canary is read-only and no-delivery (no commit packaging).
  assert.ok(/no-delivery|no delivery|read-only|只读/.test(ob),
    "AGENT_ONBOARDING.md must describe the canary as read-only / no-delivery");
  // Formal acceptance is MCP-native, not the CLI.
  assert.ok(/MCP-native|MCP native/i.test(ob),
    "AGENT_ONBOARDING.md must state the formal acceptance chain is MCP-native");
});

test("onboarding docs: PASS = clean terminal + completed + non-empty assistant text; run_dispatch accepted ≠ PASS", () => {
  const ob = read("AGENT_ONBOARDING.md");
  // PASS requires all three signals together.
  assert.ok(/clean terminal/i.test(ob), "AGENT_ONBOARDING.md PASS must require a clean terminal");
  assert.ok(/completed/.test(ob), "AGENT_ONBOARDING.md PASS must require terminal state completed");
  assert.ok(/non-empty assistant|非空 assistant|assistant 文本|assistant text/i.test(ob),
    "AGENT_ONBOARDING.md PASS must require non-empty assistant text");
  // run_dispatch accepted (runId returned) is NOT a PASS.
  assert.ok(/accepted[^\n]*≠[^\n]*PASS|accepted is not PASS|runId.*does not mean|runId.*只表示/i.test(ob),
    "AGENT_ONBOARDING.md must state run_dispatch accepted ≠ PASS");
});

test("onboarding docs: CLI canary is diagnostic-only (not formal acceptance)", () => {
  const ob = read("AGENT_ONBOARDING.md");
  assert.ok(/CLI[^\n]{0,12}canary|CLI 只读 canary|CLI one-shot canary/.test(ob),
    "AGENT_ONBOARDING.md must reference the CLI canary");
  assert.ok(/诊断工具|diagnostic|不是正式验收|not.*formal acceptance/i.test(ob),
    "AGENT_ONBOARDING.md must state the CLI canary is diagnostic-only, not formal acceptance");
});

// Fresh Host acceptance contract: the wao onboarding result emits a bounded,
// host-neutral, advisory `acceptance` projection (shared by JSON and human
// output) naming the three MCP steps, the PASS facts, and the four closed
// recovery branches. This guard CAUSALLY LOCKS the doc to the implementation
// SSOT (buildAcceptance) — not generic keywords — so the doc and code cannot
// drift apart: it derives the four branch keys from buildAcceptance, pins them
// as a closed set, asserts the doc names each, and locks the critical linked
// semantics (host-not-invoked ⇒ not a WAO run; transport-unknown ⇒ unknown +
// runs_list/point-in-time inspection + NO blind redispatch; provider/runtime ⇒
// post-run only). Failure → fix the doc, not the test.
test("onboarding docs: AGENT_ONBOARDING.md causally locks the four host-neutral acceptance branches + transport-unknown no-blind-redispatch to buildAcceptance", async () => {
  const { buildAcceptance } = await import("../../src/application/onboarding.js");
  const a = buildAcceptance();
  const ob = read("AGENT_ONBOARDING.md");

  // The projection is documented as advisory + host-neutral.
  assert.ok(/acceptance/i.test(ob), "AGENT_ONBOARDING.md must mention the bounded acceptance projection");
  assert.ok(/advisory|建议性/i.test(ob), "the acceptance projection must be stated advisory");
  assert.ok(/host-neutral|host neutral|Host-neutral|Host 中立/i.test(ob),
    "the acceptance projection must be stated host-neutral");

  // Causal lock #1 — the four branch keys are a CLOSED SET sourced from
  // buildAcceptance (the SSOT). If the implementation changes the set, this
  // deepEqual fails; the closed set is part of the contract, not free prose.
  const branchKeys = a.branches.map((b) => b.key);
  assert.deepEqual(branchKeys,
    ["host-not-invoked", "transport-unknown", "workspace/preflight", "provider/runtime"],
    "buildAcceptance must expose exactly the four closed recovery branches");

  // Causal lock #2 — the doc must name every branch the implementation exposes.
  for (const key of branchKeys) {
    assert.ok(ob.includes(key),
      `AGENT_ONBOARDING.md must name the acceptance recovery branch ${key} (bound to buildAcceptance)`);
  }

  // Causal lock #3 — critical SEMANTICS (not keywords). Each branch's meaning
  // is locked so the doc cannot silently drop the safety-critical facts.

  // host-not-invoked: a Host cancellation proven before invocation is NOT a
  // WAO run (WAO never received the dispatch).
  assert.ok(/不是一次 WAO run|not a WAO run|did not receive/i.test(ob),
    "host-not-invoked must state a proven-before-invocation cancellation is not a WAO run");

  // transport-unknown: the outcome is UNKNOWN (not proof a worker did not
  // start), redispatch is gated on prior runs_list/point-in-time inspection,
  // and there is NO blind/automatic redispatch. All three linked facts required.
  assert.ok(/unknown/i.test(ob),
    "transport-unknown outcome must be stated as unknown, not proof");
  assert.ok(/runs_list|point-in-time/i.test(ob),
    "transport-unknown recovery must direct to runs_list / point-in-time inspection before any retry");
  assert.ok(/无自动重试|不盲目重新派发|no blind redispatch|no automatic retry/i.test(ob),
    "transport-unknown must forbid blind/automatic redispatch (unknown ⇒ no blind redispatch)");

  // provider/runtime: a POST-RUN branch only — diagnosed after a runId-bound
  // WAO run exists (never before dispatch).
  assert.ok(/post-run|runId 绑定|only after/i.test(ob),
    "provider/runtime must be a post-run branch (only after a runId-bound run exists)");
});

test("onboarding docs: four canary diagnosis branches, including transport/window expiry ≠ worker stopped", () => {
  const ob = read("AGENT_ONBOARDING.md");
  // The four branches are enumerated.
  assert.ok(/四个诊断分支|four diagnosis branches|four branches|4 branches/i.test(ob),
    "AGENT_ONBOARDING.md must enumerate four diagnosis branches");
  // Branch: provider/auth.
  assert.ok(/provider_auth/.test(ob),
    "AGENT_ONBOARDING.md must document the provider/auth diagnosis branch");
  // Branch: worker stopped empty (crash / no_effect / provider_disconnect).
  assert.ok(/crash|no_effect|provider_disconnect/.test(ob),
    "AGENT_ONBOARDING.md must document the worker-stopped-empty branch (crash/no_effect/provider_disconnect)");
  // Branch: timeout / transport-window expiry.
  assert.ok(/timeout|传输窗口|transport/.test(ob),
    "AGENT_ONBOARDING.md must document the timeout / transport-window branch");
  // The critical distinction: transport/window expiry is NOT the worker stopping.
  assert.ok(/传输.*≠.*worker|窗口.*≠.*worker|transport.*not.*worker|window.*not.*worker|not the worker stopping/i.test(ob),
    "AGENT_ONBOARDING.md must state transport/window expiry ≠ worker stopped");
});

test("onboarding docs: two readiness paths (strict reliability OR manual endorsement), no fabrication, bounded write set", () => {
  const ob = read("AGENT_ONBOARDING.md");
  // Path A: reliability certification (strict) — the helper instructs, never runs.
  assert.ok(/npm run reliability/.test(ob), "AGENT_ONBOARDING.md must point at the strict reliability path");
  // Path B: manual endorsement via manualOverride:cleared.
  assert.ok(/manualOverride/.test(ob),
    "AGENT_ONBOARDING.md must document the manual endorsement path (manualOverride:cleared)");
  // The helper never fabricates readiness status.
  assert.ok(/不捏造|never fabricat|does not fabricat|不产生就绪/i.test(ob),
    "AGENT_ONBOARDING.md must state the helper never fabricates readiness");
  // The safety boundary: the bounded write set is named.
  assert.ok(/config\/agents\.example\.json/.test(ob) && /config\/agents\.json/.test(ob) && /reliability-summary\.json/.test(ob),
    "AGENT_ONBOARDING.md must name the exact read/write surface (template, agents.json, reliability-summary.json)");
});

test("onboarding docs: docs/usage.md points at the existing authority AGENT_ONBOARDING.md", () => {
  // SSOT: usage.md carries only a pointer to the existing onboarding authority.
  const usage = read("docs/usage.md");
  assert.ok(/wao onboarding/.test(usage), "docs/usage.md must mention the wao onboarding command");
  assert.ok(/AGENT_ONBOARDING\.md/.test(usage),
    "docs/usage.md must point at AGENT_ONBOARDING.md (the existing onboarding authority), not a new doc");
});
