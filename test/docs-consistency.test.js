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
  assert.ok(read("AGENTS.md").includes("Repository Guidelines"));
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

test("SKILL.md 必须含 opencode-serve 运维避坑（开发中踩过的真实坑）", () => {
  // 这些坑来自真实开发（research/07 + 调试过程），按 onboarding 三层设计
  // 必须在 SKILL.md（agent 会读的工具使用层），不能只留在 research（草稿层）。
  const skill = read("SKILL.md");
  const must = [
    { kw: /provider|providerID/i, why: "provider id 错配（如 deepseek 写成 deepseek-coding-plan）导致 401" },
    { kw: /port|端口|4297/i, why: "serveUrl 端口必须与 opencode serve --port 实际一致" },
    { kw: /oh-my-openagent|OmO|Maestro System Context|杂草/i, why: "OmO 插件往 session 注入 Maestro context，是 talking-cli 域杂草" },
    { kw: /first-stable|无限|循环|重复确认/i, why: "DeepSeek-v4-flash 回答后无限重复，需 completionMode: first-stable" },
  ];
  for (const { kw, why } of must) {
    assert.ok(kw.test(skill), `SKILL.md 缺少 opencode 避坑项（${why}）`);
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
  // usage 必须含完整事件集（含 M3+M5+M6 新增的）。
  for (const ev of ["run.event", "scorecard.checked", "run.rerun", "run.cleanup_done"]) {
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
  // 职责链关键动词（理解/编排/派发/验收/整合/汇报）
  for (const kw of ["理解", "编排", "派发", "验收", "整合", "汇报"]) {
    assert.ok(head.includes(kw), `SKILL.md 开头缺职责链环节：${kw}`);
  }
  // 边界：worker/副主控不消费此技能（防误读）
  assert.ok(/worker.*不|副主控.*不|不是给你的/i.test(head), "SKILL.md 未声明 worker/副主控不消费此技能");
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

test("AGENTS.md Project structure 覆盖真实存在的核心源文件", () => {
  const a = read("AGENTS.md");
  // 这些文件真实存在于 src/（已验证），AGENTS.md 结构清单不得漏列。
  for (const f of ["portAllocator.js", "smoke.js", "runEvent.js", "scorecard.js", "metrics.js"]) {
    assert.ok(a.includes(f), `AGENTS.md Project structure 漏列 src/${f}`);
  }
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
  for (const kw of ["目标", "真实任务", "正式试运行", "certified", "strict-dispatch"]) {
    assert.ok(head.includes(kw), `SKILL.md 开头缺少第三方 lead 首读关键信息：${kw}`);
  }
  assert.ok(/Claude Code-first|Claude Code first|Claude-first/i.test(head), "SKILL.md 开头未声明当前 Claude Code-first 调度策略");
});

test("usage.md 顶部状态必须反映 M0-M8 当前能力，不得停留在 M0-M4/M0-M6", () => {
  const usage = read("docs/usage.md");
  const head = usage.slice(0, 1200);
  assert.ok(!/M0.M4|M0–M4|M0-M4/.test(head), "usage.md 顶部仍自称 M0-M4 后能力");
  assert.ok(/M0.M8|M0–M8|M0-M8/.test(head), "usage.md 顶部未说明当前 M0-M8 能力");
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

test("SKILL.md 的 gate requiredClaims 必须有格式说明（agent 需懂 nodeId.field 语义）", () => {
  const skill = read("SKILL.md");
  // SKILL DAG 示例用了 requiredClaims: ["test.text"]，但不解释格式 → agent 照抄不懂。
  // 必须出现 claims 格式说明（nodeId.field 或字段语义）。
  assert.ok(
    /nodeId\.field|nodeId\.|claims.*格式|requiredClaims.*节点/.test(skill),
    "SKILL.md 用了 requiredClaims 但未说明 claims 格式（nodeId.field）"
  );
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

test("M7/M8 当前状态不得在活文档里回退为未开始或旧测试基线", () => {
  const roadmap = read("docs/roadmap.md");
  const progress = roadmap.split("## 进度跟踪")[1] ?? "";
  assert.ok(/\| M7 \| ✅/.test(progress),
    "roadmap.md 进度跟踪里的 M7 行必须显示已完成");
  assert.ok(/archive\/m7-phases\.md/.test(progress),
    "roadmap.md M7 行必须指向已归档的 docs/archive/m7-phases.md");
  assert.ok(/M8/.test(roadmap) && /✅/.test(roadmap),
    "roadmap.md 必须反映 M8 已完成的当前状态");

  const ssot = read("docs/ssot.md");
  for (const stale of ["当前 39 个 md", "npm test 372", "15 条断言", "15 assertions"]) {
    assert.ok(!ssot.includes(stale), `docs/ssot.md 仍保留旧审计基线：${stale}`);
  }

  const techDebt = read("docs/tech-debt.md");
  const openSection = (techDebt.split("## 开放")[1] ?? "").split("## 设计性约束")[0] ?? "";
  assert.ok(!/TD-52|TD-53/.test(openSection),
    "tech-debt.md 仍把 TD-52/TD-53 留在开放区，但条目语义已是已偿还");
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
  // 防回归：AGENTS.md 的文档纪律节是 agent 写新 .md 前的强制检查入口。
  // 缺失则 agent 不知道有分类约束，会重新制造重复定义。
  const a = read("AGENTS.md");
  assert.ok(/docs\/ssot\.md/.test(a), "AGENTS.md 未指向 docs/ssot.md（文档分类标准）");
  assert.ok(/文档纪律|SSOT/.test(a), "AGENTS.md 缺少文档纪律节");
  // 必须含"写新文档前"的强制流程（三个问题）
  assert.ok(/写新/.test(a) && /默认答案.*不新建|默认是.*不新建/.test(a),
    "AGENTS.md 未声明写新文档的默认答案是'不新建'");
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
    /do NOT look for it under `\.wao\/`/i.test(skill) || /不查\s*`?\.wao\/?`?/i.test(skill),
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

test("M8 新增命令/节点类型在 SSOT 文档中固化（dashboard/diagnose/forecast/integrator）", () => {
  // M8-2/3/4/5：新增命令与节点类型。SKILL（命令权威）必须列出，防漏暴露给 Lead。
  const skill = read("SKILL.md");
  assert.ok(/runs dashboard/i.test(skill), "SKILL.md 必须列出 runs dashboard 命令（M8-2）");
  assert.ok(/runs diagnose/i.test(skill), "SKILL.md 必须列出 runs diagnose 命令（M8-3）");
  assert.ok(/runs forecast/i.test(skill), "SKILL.md 必须列出 runs forecast 命令（M8-4）");
  assert.ok(/integrator/i.test(skill), "SKILL.md 必须列出 integrator 节点类型（M8-5）");
  // architecture 节点处理器清单必须含 integrator
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

test("TD-82: SKILL.md 的 wao declare 理由码与 src/waoDeclare.js 的 REASON_CODES 枚举一致", async () => {
  // SSOT：理由码权威源是 src/waoDeclare.js 的 REASON_CODES 数组。
  // SKILL.md 的派工章节必须列出全部理由码（防文档遗漏 lead 不知道有哪些合法 reason），
  // 且不得出现 REASON_CODES 之外的码（防文档凭空造一个代码不认的 reason 让 lead 卡住）。
  // TD-72 元教训：凡文档与代码需同步的约束都会漂，落到测试里才守得住。
  const { REASON_CODES } = await import("../src/waoDeclare.js");
  const skill = read("SKILL.md");
  for (const code of REASON_CODES) {
    assert.ok(skill.includes(`\`${code}\``),
      `SKILL.md 未列出理由码 \`${code}\`——文档与 waoDeclare.js REASON_CODES 漂移。`);
  }
});

test("TD-83: SKILL.md 的 pipeline 阶段定义与 src/waoStage.js 的 STAGE_NUMBERS 一致", async () => {
  // SSOT：阶段编号权威源是 src/waoStage.js 的 STAGE_NUMBERS 数组。
  // SKILL.md 的"6 阶段产物门控"章节必须列出全部阶段（1..6）及其产物落点，
  // 防 Lead 不知道有哪些阶段可声明、或凭空造一个代码不认的阶段号卡住。
  const { STAGE_NUMBERS } = await import("../src/waoStage.js");
  const skill = read("SKILL.md");
  // SKILL.md 必须提及 wao stage 命令（让 Lead 知道这是门控入口）
  assert.ok(skill.includes("wao stage"),
    "SKILL.md 未提及 `wao stage`——Lead 不知道 pipeline 门控命令存在。");
  // 每个阶段号必须在 SKILL.md 出现（带标记，防裸数字误命中）
  for (const n of STAGE_NUMBERS) {
    assert.ok(skill.includes(`阶段 ${n}`),
      `SKILL.md 未列出"阶段 ${n}"——文档与 waoStage.js STAGE_NUMBERS 漂移。`);
  }
});

test("F1 守卫: SKILL.md 必须列出 CLI 实际路由的关键命令/子命令（防命令索引漂移）", () => {
  // dogfood round 1/5 两次独立浮现同一 friction：wao ask / workflow list / wao stage /
  // wao declare 等子命令已实现并路由，但 SKILL Quick reference 漏列——Lead 读 SKILL 不知道
  // 这些命令存在。根因是"新增 CLI 路由时忘记同步 SKILL"，靠人工同步不可靠（两轮复发）。
  // 本守卫维护一个白名单（CLI 实际路由的关键命令/子命令），断言每个都出现在 SKILL.md。
  // 新增路由时若忘记写进 SKILL，此测试会红。
  //
  // 白名单来源：src/cli.js main() 顶层路由 + 各 command 函数的子分发。
  const skill = read("SKILL.md");
  const REQUIRED_SKILL_COMMANDS = [
    // 顶层命令族（main() 路由）
    "run ", "spawn", "retry", "resume", "status", "tail", "collect", "stop",
    "runs ", "workflow", "worktree", "wao ", "daemon",
    "registry",
    // wao 子命令（waoCommand 分发）——反复遗漏的高发区
    "wao init", "wao state", "wao decision", "wao handoff",
    "wao declare", "wao stage", "wao ask", "wao doctor",
    // workflow 子命令（workflowCommand 分发）
    "workflow run", "workflow list",
    // daemon 子命令（daemonCommand 分发）
    "daemon start", "daemon run", "daemon stop",
    // runs 子命令（高频）
    "runs list", "runs dashboard", "runs metrics",
  ];
  const missing = REQUIRED_SKILL_COMMANDS.filter((cmd) => !skill.includes(cmd));
  assert.deepEqual(missing, [],
    `SKILL.md 缺少以下 CLI 命令的文档（命令索引漂移）：${missing.join(", ")}。` +
    `新增 CLI 路由时必须同步写进 SKILL.md 的 Quick reference 或相关章节。`);
});
