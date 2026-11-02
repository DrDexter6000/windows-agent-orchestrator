// test/commands/skillLink.test.js
//
// 决定 0107：skill link / skill unlink 的行为钉（应用服务 + CLI 适配 + doctor
// 逐槽位报告 + install.ps1 卸载接入的源级断言）。
//
// 契约（决定 0107 + 本批任务边界）：
//   - 预览零写入：不带 --apply 时不创建任何目录/链接。
//   - link --apply 只在 absent 态创建 junction；linked-current 无操作；其余状态
//     （linked-other / not-a-link 含物理拷贝 / broken-link / unknown）拒绝，无 --force。
//   - 宿主主目录（homeProof）不存在时拒绝（宿主没装）；它在而 skills 子目录不在
//     时可以建这个子目录。
//   - 链接目标资格：链接工作树（--git-dir ≠ --git-common-dir）或非 git 顶层拒绝
//     ——不猜、无覆盖参数。
//   - unlink --apply 只删 linked-current，删完确认链接没了、目标检出文件还在；
//     其余状态不动、如实报告；--all 按槽位路径去重。
//   - doctor 按宿主表逐槽位报告、恒 INFO（机器态不影响 verdict）、按槽位路径
//     去重、写明"链接在不等于宿主已加载"。
//   - 未知宿主固定文案拒绝并列出宿主；无 skillSlot 的宿主零写入打印手工指引。
//
// 隔离：一律用临时目录充当用户主目录与检出根（绝不碰真实用户主目录）；git 拓扑
// 经 gitProbe 注入缝假造，不依赖运行位置。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  SKILL_SLOT_STATES,
  deriveCheckoutRoot,
  linkSkill,
  probeCheckoutEligibility,
  slotState,
  skillSlotInventory,
  unlinkSkill,
} from "../../src/application/skillLink.js";
import { waoDoctorCommand } from "../../src/commands/doctor.js";

// ── 夹具 ────────────────────────────────────────────────────────────────────

const GIT_CLEAN_MAIN = (root) => ({ eligible: true, reason: null, detail: null });
const GIT_LINKED_WORKTREE = (root) => ({
  eligible: false,
  reason: "linked-worktree",
  detail: `--git-dir=${root}/.git/worktrees/x ≠ --git-common-dir=${root}/.git`,
});
const GIT_NOT_TOP_LEVEL = (root) => ({
  eligible: false,
  reason: "not-top-level",
  detail: `--show-toplevel=${root}/elsewhere ≠ ${root}`,
});
const GIT_NOT_GIT = () => ({ eligible: false, reason: "not-git", detail: "fatal: not a git repository" });

/** 一份假检出根：SKILL.md + package.json（unlink 后校验"目标里的文件还在"用）。 */
function makeFixtureCheckout() {
  const root = mkdtempSync(join(tmpdir(), "wao-skill-checkout-"));
  writeFileSync(join(root, "SKILL.md"), "# fake wao skill\n", "utf8");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8");
  return root;
}

/** 临时目录充当用户主目录；segments 里的宿主主目录按需预建（缺省 = 宿主未装）。 */
function makeHome(...segments) {
  const home = mkdtempSync(join(tmpdir(), "wao-skill-home-"));
  for (const segment of segments) mkdirSync(join(home, segment), { recursive: true });
  return home;
}

async function expectRefusal(promise, fragment) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, fragment);
    return true;
  });
}

// junction 的等价断言：槽位状态是 linked-current 且穿过槽位能读到目标检出的文件。
function assertLinkedCurrent(slotPath, checkoutRoot) {
  assert.equal(slotState(slotPath, checkoutRoot), "linked-current", `槽位应为 linked-current：${slotPath}`);
  assert.ok(existsSync(join(slotPath, "SKILL.md")), "穿过槽位应能读到目标检出的 SKILL.md");
}

// ── 状态闭集 ────────────────────────────────────────────────────────────────

test("决定0107: 状态闭集六态冻结（唯一权威 SKILL_SLOT_STATES）", () => {
  assert.deepEqual([...SKILL_SLOT_STATES], [
    "absent", "linked-current", "linked-other", "not-a-link", "broken-link", "unknown",
  ]);
});

test("决定0107: slotState 判 absent / not-a-link / linked-current / linked-other / broken-link", () => {
  const checkout = makeFixtureCheckout();
  const other = mkdtempSync(join(tmpdir(), "wao-skill-other-"));
  writeFileSync(join(other, "SKILL.md"), "", "utf8");
  const home = makeHome(".claude");
  const slot = join(home, ".claude", "skills", "wao-orchestrator");
  try {
    assert.equal(slotState(slot, checkout), "absent");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    writeFileSync(slot, "not a link", "utf8");
    assert.equal(slotState(slot, checkout), "not-a-link");
    rmSync(slot);
    symlinkSync(checkout, slot, "junction");
    assert.equal(slotState(slot, checkout), "linked-current");
    rmSync(slot);
    symlinkSync(other, slot, "junction");
    assert.equal(slotState(slot, checkout), "linked-other");
    rmSync(slot);
    symlinkSync(join(home, "no-such-target"), slot, "junction");
    assert.equal(slotState(slot, checkout), "broken-link");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

// ── link ────────────────────────────────────────────────────────────────────

test("决定0107: link 预览零写入（连宿主主目录都不建）", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome(); // .claude 不存在
  try {
    const result = await linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN });
    assert.equal(result.mode, "preview");
    assert.equal(result.state, "absent");
    assert.ok(result.action.includes("--apply"));
    assert.ok(!existsSync(join(home, ".claude")), "预览不得创建宿主主目录");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: link --apply 在 absent 态创建 junction（skills 子目录缺位时一并补建）", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome(".claude"); // 宿主已装，但 skills 子目录不在
  const slot = join(home, ".claude", "skills", "wao-orchestrator");
  try {
    const result = await linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true });
    assert.equal(result.mode, "linked");
    assertLinkedCurrent(slot, checkout);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: link --apply 重复执行无操作（linked-current → noop，链接不动）", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome(".claude");
  const slot = join(home, ".claude", "skills", "wao-orchestrator");
  try {
    await linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true });
    const again = await linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true });
    assert.equal(again.mode, "noop");
    assert.equal(again.state, "linked-current");
    assertLinkedCurrent(slot, checkout);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: link --apply 拒绝普通目录/文件与物理拷贝（not-a-link，无 --force）", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome(".claude");
  const slotDir = join(home, ".claude", "skills");
  const slot = join(slotDir, "wao-orchestrator");
  try {
    mkdirSync(slotDir, { recursive: true });
    // 物理拷贝形态：槽位是含 SKILL.md 的普通目录。
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, "SKILL.md"), "stale copy", "utf8");
    await expectRefusal(
      linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true }),
      /not-a-link/,
    );
    assert.equal(existsSync(join(slot, "SKILL.md")), true, "拒后普通目录必须原样保留");
    // 普通文件形态同样拒。
    rmSync(slot, { recursive: true });
    writeFileSync(slot, "stray file", "utf8");
    await expectRefusal(
      linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true }),
      /not-a-link/,
    );
    assert.equal(existsSync(slot), true, "拒后散文件必须原样保留");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: link --apply 拒绝指向别处的链接（linked-other）且不碰那个目标", async () => {
  const checkout = makeFixtureCheckout();
  const other = mkdtempSync(join(tmpdir(), "wao-skill-other-"));
  const home = makeHome(".claude");
  const slot = join(home, ".claude", "skills", "wao-orchestrator");
  try {
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(other, slot, "junction");
    await expectRefusal(
      linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true }),
      /linked-other/,
    );
    assert.equal(slotState(slot, other), "linked-current", "指向别处的链接必须原样保留");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: link --apply 拒绝断链（broken-link）", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome(".claude");
  const slot = join(home, ".claude", "skills", "wao-orchestrator");
  try {
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(home, "gone-target"), slot, "junction");
    assert.equal(slotState(slot, checkout), "broken-link");
    await expectRefusal(
      linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true }),
      /broken-link/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: link --apply 在宿主主目录不存在时拒绝（宿主没装，不建主目录）", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome();
  try {
    await expectRefusal(
      linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true }),
      /不存在——宿主 claude-code 未安装/,
    );
    assert.ok(!existsSync(join(home, ".claude")), "拒绝时不得创建宿主主目录");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: 共享槽位 homeProof 用宿主自身主目录（codex 用 .codex，不是 .agents）", async () => {
  const checkout = makeFixtureCheckout();
  // .codex 在、共享目录 .agents 不在：应当成功（安装证据是 .codex）。
  const home = makeHome(".codex");
  const slot = join(home, ".agents", "skills", "wao-orchestrator");
  try {
    const result = await linkSkill({ host: "codex", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true });
    assert.equal(result.mode, "linked");
    assertLinkedCurrent(slot, checkout);
    // 反向：.agents 在而 .codex 不在 = codex 没装 → 拒绝。
    const home2 = makeHome(".agents");
    await expectRefusal(
      linkSkill({ host: "codex", homeDir: home2, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true }),
      /未安装/,
    );
    rmSync(home2, { recursive: true, force: true });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: 链接工作树与非 git 顶层拒绝（不猜、无覆盖参数）", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome(".claude");
  try {
    await expectRefusal(
      linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_LINKED_WORKTREE, apply: true }),
      /链接工作树.*不提供覆盖参数/,
    );
    await expectRefusal(
      linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_NOT_TOP_LEVEL, apply: true }),
      /不是 git 顶层/,
    );
    await expectRefusal(
      linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_NOT_GIT, apply: true }),
      /不是 git 检出/,
    );
    assert.ok(!existsSync(join(home, ".claude", "skills")), "拒绝路径不得建槽位目录");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: 未知宿主固定文案拒绝并列出宿主闭集；无 skillSlot 宿主零写入手工指引", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome();
  try {
    await expectRefusal(
      linkSkill({ host: "no-such-host", homeDir: home, checkoutRoot: checkout }),
      /未知宿主：no-such-host.*claude-code, codex, zcode, kimi-code, opencode, claude-desktop, dsh/,
    );
    const manual = await linkSkill({ host: "zcode", homeDir: home, checkoutRoot: checkout });
    assert.equal(manual.mode, "manual");
    assert.match(manual.note, /按该宿主的文档安装/);
    assert.ok(!existsSync(join(home, ".zcode")), "无槽位宿主零写入");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

// ── unlink ──────────────────────────────────────────────────────────────────

test("决定0107: unlink --apply 只删链接本身，目标检出文件原样还在", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome(".claude");
  const slot = join(home, ".claude", "skills", "wao-orchestrator");
  try {
    await linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true });
    const result = await unlinkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, apply: true });
    assert.equal(result.mode, "applied");
    assert.equal(result.removed, 1);
    assert.equal(slotState(slot, checkout), "absent", "删后链接必须消失");
    assert.equal(existsSync(join(checkout, "SKILL.md")), true, "目标检出的 SKILL.md 必须还在");
    assert.equal(existsSync(join(checkout, "package.json")), true, "目标检出的 package.json 必须还在");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: unlink --apply 对非 linked-current 状态不动、如实报告", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome(".claude");
  const slot = join(home, ".claude", "skills", "wao-orchestrator");
  try {
    mkdirSync(slot, { recursive: true }); // 物理拷贝形态
    writeFileSync(join(slot, "SKILL.md"), "keep me", "utf8");
    const result = await unlinkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, apply: true });
    assert.equal(result.removed, 0);
    assert.equal(result.slots[0].state, "not-a-link");
    assert.match(result.slots[0].action, /跳过.*not-a-link/);
    assert.equal(existsSync(join(slot, "SKILL.md")), true, "非 linked-current 状态必须原样保留");
    // 预览（不带 --apply）也不删。
    rmSync(slot, { recursive: true });
    symlinkSync(checkout, slot, "junction");
    const preview = await unlinkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, apply: false });
    assert.equal(preview.mode, "preview");
    assert.equal(preview.removed, 0);
    assert.equal(slotState(slot, checkout), "linked-current", "预览不得删链接");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: unlink --all 按槽位路径去重（共享槽位一条），只删指向本检出的", async () => {
  const checkout = makeFixtureCheckout();
  const otherCheckout = makeFixtureCheckout();
  const home = makeHome(".claude", ".codex");
  const claudeSlot = join(home, ".claude", "skills", "wao-orchestrator");
  const agentsSlot = join(home, ".agents", "skills", "wao-orchestrator");
  try {
    await linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true });
    await linkSkill({ host: "codex", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true });
    // 别处的链接（指向另一份检出）：必须原样保留。
    mkdirSync(join(home, ".codex", "skills"), { recursive: true });
    symlinkSync(otherCheckout, join(home, ".codex", "skills", "wao-orchestrator"), "junction");

    const inventory = skillSlotInventory({ homeDir: home, checkoutRoot: checkout });
    const agents = inventory.find((s) => s.dir === ".agents/skills");
    assert.deepEqual(agents.hosts.sort(), ["codex", "kimi-code"], "共享槽位必须列出全部读它的宿主");

    const result = await unlinkSkill({ all: true, homeDir: home, checkoutRoot: checkout, apply: true });
    assert.equal(result.removed, 2, "只删两条指向本检出的链接");
    assert.equal(slotState(claudeSlot, checkout), "absent");
    assert.equal(slotState(agentsSlot, checkout), "absent");
    assert.equal(slotState(join(home, ".codex", "skills", "wao-orchestrator"), otherCheckout), "linked-current", "指向别处的链接必须保留");
    assert.equal(existsSync(join(checkout, "SKILL.md")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
    rmSync(otherCheckout, { recursive: true, force: true });
  }
});

test("决定0107: unlink 未知宿主拒绝；无 skillSlot 宿主无可删链接（manual）", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome();
  try {
    await expectRefusal(
      unlinkSkill({ host: "wat", homeDir: home, checkoutRoot: checkout }),
      /未知宿主：wat/,
    );
    const manual = await unlinkSkill({ host: "dsh", homeDir: home, checkoutRoot: checkout, apply: true });
    assert.equal(manual.mode, "manual");
    assert.match(manual.note, /没有 WAO 建的链接可删/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

// ── doctor 逐槽位报告 ───────────────────────────────────────────────────────

function captureDoctorChecks(config) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  const savedExitCode = process.exitCode;
  return waoDoctorCommand(["--format", "json", "--cwd", config.cwd, "--registry", join(config.cwd, "agents.json")], {
    stateDir: ".wao",
    runDir: join(config.cwd, "runs"), // 绝对路径：相对 "runs" 在 npm test 下会落到仓库根
    homeDir: config.cwd, // 主目录也给临时目录：doctor 的 installer 根探测不读真实主目录
    ...config,
  }).finally(() => {
    console.log = original;
    process.exitCode = savedExitCode;
  }).then(() => {
    const jsonLine = lines.find((l) => l.trimStart().startsWith("{"));
    assert.ok(jsonLine, "doctor json 输出在场");
    return JSON.parse(jsonLine);
  });
}

test("决定0107: doctor 按宿主表逐槽位报告（去重/状态/恒 INFO/链接≠已加载），verdict 不受槽位态影响", async () => {
  const checkout = makeFixtureCheckout();
  // 完整 .wao/ 六槽位 + 空 registry 的 cwd：把非槽位面的检查压成全绿，
  // verdict 断言才只反映槽位检查的分级纪律（恒 INFO）。
  const cwd = mkdtempSync(join(tmpdir(), "wao-skill-doctor-cwd-"));
  try {
    mkdirSync(join(cwd, ".wao"), { recursive: true });
    writeFileSync(join(cwd, ".wao", "project.md"), "", "utf8");
    for (const slot of ["decisions", "pipeline", "handoff", "runs", "migration"]) {
      mkdirSync(join(cwd, ".wao", slot), { recursive: true });
    }
    writeFileSync(join(cwd, "agents.json"), JSON.stringify({ agents: {} }), "utf8");
    // 注入的主目录（= cwd，见 captureDoctorChecks）下放一个 installer 根：doctor 若改回读真实主目录，下面的版本断言就红。
    mkdirSync(join(cwd, "wao"), { recursive: true });
    writeFileSync(join(cwd, "wao", "package.json"), JSON.stringify({ version: "7.7.7" }), "utf8");
    const slots = [
      { dir: ".claude/skills", slotPath: join(checkout, "fixture-claude-slot"), hosts: ["claude-code"], state: "linked-current", target: checkout },
      { dir: ".agents/skills", slotPath: join(checkout, "fixture-agents-slot"), hosts: ["codex", "kimi-code"], state: "linked-other", target: "D:\\somewhere\\else" },
      { dir: ".zcode/skills", slotPath: join(checkout, "fixture-zcode-slot"), hosts: ["zcode"], state: "absent", target: null },
      { dir: ".codex/skills", slotPath: join(checkout, "fixture-copy-slot"), hosts: ["codex"], state: "not-a-link", target: null },
      { dir: ".kimi-code/skills", slotPath: join(checkout, "fixture-broken-slot"), hosts: ["kimi-code"], state: "broken-link", target: null },
      { dir: ".opencode/skills", slotPath: join(checkout, "fixture-unknown-slot"), hosts: ["opencode"], state: "unknown", target: null },
      { dir: ".shared/skills", slotPath: join(checkout, "fixture-shared-absent"), hosts: ["codex", "kimi-code"], state: "absent", target: null },
    ];
    const parsed = await captureDoctorChecks({ cwd, skillSlotInventory: () => slots });
    const byName = (name) => parsed.checks.find((c) => c.name === name);
    const claude = byName("skill_slot_claude-skills");
    const agents = byName("skill_slot_agents-skills");
    const zcode = byName("skill_slot_zcode-skills");
    const copy = byName("skill_slot_codex-skills");
    const broken = byName("skill_slot_kimi-code-skills");
    const unknownState = byName("skill_slot_opencode-skills");
    assert.ok(claude && agents && zcode && copy && broken && unknownState, "六个槽位态各出一条检查");
    for (const c of [claude, agents, zcode, copy, broken, unknownState]) {
      assert.equal(c.level, "info", `槽位检查恒 INFO（机器态不影响 verdict）：${c.name}`);
      assert.equal(c.pass, true);
    }
    assert.match(claude.detail, /claude-code/, "列出读该槽位的宿主");
    assert.match(claude.detail, /链接在不等于宿主已加载/, "写明链接≠已加载");
    assert.match(agents.detail, /codex、kimi-code/, "共享槽位列出全部宿主");
    assert.match(agents.detail, /指向别处/, "linked-other 如实报告");
    assert.match(zcode.detail, /缺位/, "缺槽位如实报告");
    assert.match(zcode.fix ?? "", /skill link --host zcode --apply/);
    assert.match(copy.detail, /物理拷贝/, "not-a-link（物理拷贝）如实报告");
    assert.match(broken.detail, /目标不可达/, "broken-link 如实报告");
    assert.match(unknownState.detail, /unknown/, "unknown 如实报告（不猜）");
    // 每种状态的提示都能照着做（consult_20261102090049803worow7）。
    assert.doesNotMatch(claude.detail, /skill link 建/, "linked-current 不声称链接是谁建的");
    assert.match(copy.detail, /不是链接，按普通文件或目录删/, "not-a-link 不让人对文件或非空拷贝 rmdir");
    assert.match(unknownState.detail, /查明之前不要删/, "unknown 先查原因，不让人删");
    assert.match(broken.detail, /非递归 rmdir 摘掉这个断链/);
    assert.match(agents.fix ?? "", /skill link --host <宿主>.*选你装了的/, "共享槽位非缺位态的后续命令不写死某个宿主，让用户选装了的");
    const invocation = byName("invocation_method");
    assert.match(invocation?.detail ?? "", /installer 根在场[^\n]*7\.7\.7/, "installer 根读的是注入的主目录");
    const shared = byName("skill_slot_shared-skills");
    assert.ok(shared, "共享缺位槽位也出一条检查");
    assert.match(shared.detail, /选你装了的/, "共享槽位缺位：列出全部宿主，让用户选装了的");
    assert.match(shared.fix ?? "", /skill link --host codex --apply.*也可用 --host kimi-code/, "只装了 kimi-code 也有可行命令");
    assert.equal(parsed.verdict, "HEALTHY（advisory，非门禁）", "恒 INFO → verdict 不受槽位态影响");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── CLI 适配层 ──────────────────────────────────────────────────────────────

test("决定0107: cli.js 顶层 skill 命令——预览与未知宿主（子进程冒烟）", async () => {
  const { spawnSync } = await import("node:child_process");
  const repoRoot = deriveCheckoutRoot(import.meta.url);
  const node = process.execPath;
  // 子进程的主目录指向临时目录：冒烟测试绝不读写真实用户主目录。
  const fakeHome = mkdtempSync(join(tmpdir(), "wao-skill-cli-home-"));
  const run = (argv) => spawnSync(node, [join(repoRoot, "src", "cli.js"), ...argv], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, WAO_SKIP_VERSION_GUARD: "1", USERPROFILE: fakeHome, HOME: fakeHome },
  });
  // 无槽位宿主：手工指引，零写入语义（--apply 也不该建任何东西）。
  const manual = run(["skill", "link", "--host", "opencode", "--apply"]);
  assert.equal(manual.status, 0);
  assert.match(manual.stdout, /按该宿主的文档安装/);
  // 未知宿主：非零退出 + 固定文案。
  const unknown = run(["skill", "link", "--host", "nope"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /未知宿主：nope/);
  // 预览：本工作树就是链接工作树——preview 零写入且如实报资格。
  const preview = run(["skill", "link", "--host", "claude-code"]);
  assert.equal(preview.status, 0);
  assert.match(preview.stdout, /"mode": "preview"/);
});

// ── install.ps1 卸载接入（源级断言）─────────────────────────────────────────

test("决定0107: install.ps1 -Uninstall 在删仓前跑 skill unlink --all --apply，失败即中止", () => {
  const src = readFileSync(join(deriveCheckoutRoot(import.meta.url), "install.ps1"), "utf8");
  assert.match(src, /skill unlink --all --apply/, "卸载步骤必须调用 skill unlink --all --apply");
  const unlinkAt = src.indexOf("skill unlink --all --apply（只摘目标");
  const removeAt = src.indexOf("删除仓库目录");
  assert.ok(unlinkAt > -1 && removeAt > -1 && unlinkAt < removeAt, "摘链接必须发生在删仓之前");
  assert.match(src, /skill unlink --all 失败.*已中止卸载/, "unlink 失败必须中止卸载");
  assert.match(src, /WaoFail "\$Dest 缺 package\.json，跑不了 skill unlink --all/, "检出缺 package.json 时以 WaoFail 中止卸载，而不是跳过摘链接");
  // 头注释的"不写仓外文件"例外行同步写准。
  assert.match(src, /只删链接本身，目标检出由后续删仓步骤处理/);
  // 纪律：卸载路径绝不出现递归删链接（rmSync 递归是 JS 侧概念，PS 侧对链接
  // 只允许经 CLI 的 unlink；Remove-Item 只用于删仓与备份）。
  assert.ok(!/Remove-Item[^\r\n]*skills/i.test(src), "PS 侧不得直接删技能槽位");
});

// ── 第二轮会审修正（sol / kimi，consult_20261102090049803worow7）────────────────

function gitInit(dir) {
  const r = spawnSync("git", ["init", "-q", dir], { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 0, `git init 失败：${r.stderr}`);
}

test("决定0107: 资格探测不受 GIT_DIR / GIT_WORK_TREE 影响（非 git 目录照样拒绝）", () => {
  const repo = mkdtempSync(join(tmpdir(), "wao-skill-gitrepo-"));
  const plain = mkdtempSync(join(tmpdir(), "wao-skill-plain-"));
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    gitInit(repo);
    process.env.GIT_DIR = join(repo, ".git");
    process.env.GIT_WORK_TREE = plain;
    const r = probeCheckoutEligibility(plain);
    assert.equal(r.eligible, false, "GIT_DIR / GIT_WORK_TREE 不得让一个普通目录通过资格");
    assert.ok(["not-git", "not-top-level"].includes(r.reason), `拒绝原因：${r.reason}`);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test("决定0107: 经 junction 到达的 git 顶层照样通过资格探测", () => {
  const repo = mkdtempSync(join(tmpdir(), "wao-skill-gitrepo-"));
  const aliasParent = mkdtempSync(join(tmpdir(), "wao-skill-alias-"));
  const alias = join(aliasParent, "via-link");
  try {
    gitInit(repo);
    symlinkSync(repo, alias, "junction");
    const r = probeCheckoutEligibility(alias);
    assert.equal(r.eligible, true, `经链接到达的 git 顶层应合格（${r.reason}：${r.detail}）`);
  } finally {
    try { rmdirSync(alias); } catch { /* 链接没建成 */ }
    rmSync(aliasParent, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("决定0107: 预览与 --apply 判定次序一致（资格先于状态；宿主未装时预览也说拒绝）", async () => {
  const checkout = makeFixtureCheckout();
  const home = makeHome();
  const slot = join(home, ".claude", "skills", "wao-orchestrator");
  try {
    const notInstalled = await linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN });
    assert.equal(notInstalled.hostInstalled, false);
    assert.match(notInstalled.action, /宿主未安装/, "宿主主目录不在时预览不承诺创建");
    mkdirSync(join(home, ".claude"), { recursive: true });
    await linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_CLEAN_MAIN, apply: true });
    const ineligible = await linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_LINKED_WORKTREE });
    assert.equal(ineligible.state, "linked-current");
    assert.match(ineligible.action, /将拒绝（本检出不能当链接目标：linked-worktree）/, "资格不合格时预览与 apply 同样拒绝");
    await expectRefusal(
      linkSkill({ host: "claude-code", homeDir: home, checkoutRoot: checkout, gitProbe: GIT_LINKED_WORKTREE, apply: true }),
      /链接工作树/,
    );
  } finally {
    try { rmdirSync(slot); } catch { /* 链接没建成 */ }
    rmSync(home, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("决定0107: unlink --apply 遇到读不了的槽位（unknown）就整体拒绝，什么都不删", async () => {
  const checkout = makeFixtureCheckout();
  try {
    // 主目录路径含 NUL：lstat 报参数错误（不是 ENOENT），每个槽位都读成 unknown。
    const unreadableHome = join(tmpdir(), "wao-skill-bad\u0000home");
    const preview = await unlinkSkill({ all: true, homeDir: unreadableHome, checkoutRoot: checkout });
    assert.ok(preview.slots.length > 0 && preview.slots.every((s) => s.state === "unknown"), "预览如实报 unknown");
    await expectRefusal(
      unlinkSkill({ all: true, apply: true, homeDir: unreadableHome, checkoutRoot: checkout }),
      /读不了（unknown）/,
    );
    assert.ok(existsSync(join(checkout, "SKILL.md")), "目标检出原样");
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
