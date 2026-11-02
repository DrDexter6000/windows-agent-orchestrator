// src/application/skillLink.js
//
// 决定 0107（2026-11-02 Owner 批准的窄口子）：技能链接命令的应用服务——唯一被
// 允许在核实过的技能槽位里创建/删除名为 wao-orchestrator、指向唯一 WAO 检出的
// junction 的代码路径。宿主的配置文件照旧一律不写（0043/0091 边界不变）。
//
// 链接目标 = 正在运行的这份检出的根（照 bin/wao.js 的做法从本模块位置推出）。
// 它必须是 git 顶层且不是链接工作树（git rev-parse --git-dir 与 --git-common-dir
// 相同）；否则拒绝——不猜，也不提供覆盖参数。
//
// 状态闭集（SKILL_SLOT_STATES；link / unlink / doctor 共用同一份实现）：
//   absent        槽位路径不存在
//   linked-current junction 且规范化后的目标等于检出根（Windows 上大小写不敏感）
//   linked-other  junction 但目标不是本检出
//   not-a-link    普通目录或文件（含物理拷贝）
//   broken-link   链接存在但目标不可达
//   unknown       读不了（权限等）——不猜
//
// 纪律：
//   - link --apply 只在 absent 态创建 junction；linked-current 无操作；其余状态
//     拒绝并如实报状态——没有 --force。
//   - 宿主自己的主目录（homeProof，如 ~/.claude）不存在时拒绝（宿主没装）；
//     它在而 skills 子目录不在时可以建这个子目录。
//   - unlink --apply 只删 linked-current，用非递归 fs.rmdirSync 删链接本身，
//     删完确认链接没了、目标检出里的文件还在；绝不用 rmSync({ recursive })。
//   - link 在不等于宿主已加载：宿主是否真读该目录以 hostDescriptors 的
//     skillSlot 核实证据为准，本模块不声称加载。
//
// 依赖方向：application → hostAdapters（shared 叶子，下向）。不 import
// commands/mcp/SDK/zod。测试经 homeDir / checkoutRoot / gitProbe 注入缝隔离，
// 绝不碰真实用户主目录。

import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmdirSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gitProbeEnv } from "../delivery.js";
import { HOST_DESCRIPTORS, findHostDescriptor } from "../hostAdapters/hostDescriptors.js";

/** 槽位里的链接名（唯一允许本模块建/删的名字）。 */
export const SKILL_LINK_NAME = "wao-orchestrator";

/** 状态闭集（唯一权威；doctor 与测试从这里派生，不另抄字面量）。 */
export const SKILL_SLOT_STATES = Object.freeze([
  "absent",
  "linked-current",
  "linked-other",
  "not-a-link",
  "broken-link",
  "unknown",
]);

// ── 路径与拓扑 ───────────────────────────────────────────────────────────────

/** src/application/ → ../.. = 检出根（computeInstallRoot 同款算法）。 */
export function deriveCheckoutRoot(metaUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(metaUrl)), "..", "..");
}

// Windows 上路径比较大小写不敏感、分隔符可混用（git 还会输出正斜杠）——
// 统一 resolve 后在 win32 折小写再比。
function comparablePath(p) {
  const r = resolve(String(p));
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function samePath(a, b) {
  return comparablePath(a) === comparablePath(b);
}

// 检出根本身可能经链接到达：与 realpath 后的槽位目标比之前先解析它（读不了就用原值）。
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(String(p));
  }
}

/**
 * 检出根的链接资格（照 `git rev-parse` 三问，一次子进程）：
 *   - git 失败           → not-git
 *   - --show-toplevel ≠ 根 → not-top-level
 *   - --git-dir ≠ --git-common-dir → linked-worktree（隔离工作树不能当链接目标：
 *     它会被 worktree reclaim 收走，链接会变成断链）
 * 不猜、不提供覆盖参数。gitProbe 注入缝供测试假造拓扑。
 */
export function probeCheckoutEligibility(root, gitProbe = defaultGitProbe) {
  return gitProbe(resolve(root));
}

function defaultGitProbe(root) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: gitProbeEnv(),
  });
  if (r.status !== 0 || r.error) {
    return { eligible: false, reason: "not-git", detail: (r.stderr ?? "").trim() || `git exit ${r.status}` };
  }
  const [toplevel, gitDir, commonDir] = (r.stdout ?? "").split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => l.trim());
  if (!toplevel || !samePath(realOrResolved(toplevel), realOrResolved(root))) {
    return { eligible: false, reason: "not-top-level", detail: `--show-toplevel=${toplevel ?? "(空)"} ≠ ${root}` };
  }
  // git-dir 可能是相对输出（.git）——按 root 解析后再比。
  if (!gitDir || !commonDir || !samePath(realOrResolved(resolve(root, gitDir)), realOrResolved(resolve(root, commonDir)))) {
    return { eligible: false, reason: "linked-worktree", detail: `--git-dir=${gitDir ?? "(空)"} ≠ --git-common-dir=${commonDir ?? "(空)"}` };
  }
  return { eligible: true, reason: null, detail: null };
}

// ── 槽位状态 ────────────────────────────────────────────────────────────────

/**
 * 单个槽位路径的状态（闭集）。junction/symlink 经 realpath 解析后与检出根比
 * （大小写不敏感）；lstat 报 ENOENT → absent；链接不可达（realpath ENOENT）→
 * broken-link；其余读不了 → unknown。普通目录/文件（含物理拷贝）→ not-a-link。
 */
export function slotState(slotPath, checkoutRoot) {
  let st;
  try {
    st = lstatSync(slotPath);
  } catch (error) {
    return error?.code === "ENOENT" ? "absent" : "unknown";
  }
  if (!st.isSymbolicLink()) return "not-a-link";
  let real;
  try {
    real = realpathSync(slotPath);
  } catch (error) {
    return error?.code === "ENOENT" ? "broken-link" : "unknown";
  }
  return samePath(real, realOrResolved(checkoutRoot)) ? "linked-current" : "linked-other";
}

/** 槽位链接目标（展示用原值；不是链接或读不了返回 null）。 */
export function slotTarget(slotPath) {
  try {
    if (!lstatSync(slotPath).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  try {
    return readlinkSync(slotPath) || null;
  } catch {
    return null;
  }
}

function slotPathFor(descriptor, homeDir) {
  return join(homeDir, descriptor.skillSlot.dir, SKILL_LINK_NAME);
}

// skillSlot.homeProof 缺省 = dir 首段（~/.claude/skills → ~/.claude）；
// 共享槽位在表里显式给出宿主自身主目录。
function homeProofDir(descriptor, homeDir) {
  const proof = descriptor.skillSlot.homeProof ?? descriptor.skillSlot.dir.split("/")[0];
  return join(homeDir, proof);
}

/**
 * 全宿主技能槽位盘点（doctor 与 unlink --all 共用）：按槽位路径去重，
 * 同一槽位路径列出读它的全部宿主。零写入。
 */
export function skillSlotInventory({ homeDir = homedir(), checkoutRoot = deriveCheckoutRoot() } = {}) {
  const bySlot = new Map();
  for (const descriptor of HOST_DESCRIPTORS) {
    if (!descriptor.skillSlot) continue;
    const slotPath = slotPathFor(descriptor, homeDir);
    if (!bySlot.has(slotPath)) {
      bySlot.set(slotPath, {
        dir: descriptor.skillSlot.dir,
        slotPath,
        hosts: [descriptor.id],
        state: slotState(slotPath, checkoutRoot),
        target: slotTarget(slotPath),
      });
      continue;
    }
    bySlot.get(slotPath).hosts.push(descriptor.id);
  }
  return [...bySlot.values()];
}

// ── link ────────────────────────────────────────────────────────────────────

/**
 * skill link --host <id> [--apply]。默认只预览（零写入）；--apply 才动。
 * 返回结构化结果（CLI 只做呈现）；失败抛 Error（固定文案）。
 */
export async function linkSkill({
  host,
  apply = false,
  homeDir = homedir(),
  checkoutRoot = deriveCheckoutRoot(),
  gitProbe = defaultGitProbe,
} = {}) {
  if (!host) throw new Error('skill link requires --host <host id>');
  const descriptor = findHostDescriptor(host);
  if (!descriptor) throw new Error(unknownHostError(host, "skill link"));
  if (!descriptor.skillSlot) {
    return { mode: "manual", host, note: "没有核实的技能槽位——按该宿主的文档安装（WAO 不写宿主配置文件）" };
  }

  const slotPath = slotPathFor(descriptor, homeDir);
  const slotDir = join(homeDir, descriptor.skillSlot.dir);
  const target = resolve(checkoutRoot);
  const eligibility = probeCheckoutEligibility(target, gitProbe);
  const state = slotState(slotPath, target);
  const hostHome = homeProofDir(descriptor, homeDir);
  const hostInstalled = existsSync(hostHome);

  if (!apply) {
    return {
      mode: "preview",
      host,
      slot: slotPath,
      target,
      state,
      eligibility,
      hostInstalled,
      action: applyActionFor(state, eligibility, hostInstalled),
    };
  }

  if (!eligibility.eligible) {
    throw new Error(eligibilityRefusal(eligibility, target));
  }
  if (state === "linked-current") {
    return { mode: "noop", host, slot: slotPath, target, state, note: "已是本检出的链接——无操作" };
  }
  if (state !== "absent") {
    throw new Error(
      `拒绝创建链接：槽位 ${slotPath} 的当前状态是 ${state}（只允许在 absent 态创建；` +
      `linked-current 无操作；其余状态不提供 --force，请人工确认后处理）`,
    );
  }
  // 宿主主目录在 = 宿主已装的证据；不在就拒绝（不替宿主建主目录）。
  if (!hostInstalled) {
    throw new Error(`拒绝创建链接：${hostHome} 不存在——宿主 ${host} 未安装（不创建宿主主目录）`);
  }
  // skills 子目录不在时可以建（hostHome 在场，recursive mkdir 只会补出这段）。
  mkdirSync(slotDir, { recursive: true });
  symlinkSync(target, slotPath, "junction");
  const after = slotState(slotPath, target);
  if (after !== "linked-current") {
    throw new Error(`链接已创建但状态读回是 ${after}（预期 linked-current）——请人工检查 ${slotPath}`);
  }
  return { mode: "linked", host, slot: slotPath, target, state: after };
}

// ── unlink ──────────────────────────────────────────────────────────────────

/**
 * skill unlink --host <id> | --all [--apply]。默认只预览；--apply 才删。
 * 只删 linked-current；用非递归 rmdirSync 删链接本身，删完确认链接没了、
 * 目标检出里的文件还在。其余状态不动、如实报告。
 */
export async function unlinkSkill({
  host = null,
  all = false,
  apply = false,
  homeDir = homedir(),
  checkoutRoot = deriveCheckoutRoot(),
} = {}) {
  if (!all && !host) throw new Error("skill unlink requires --host <host id>（或 --all 配合卸载流程）");
  const target = resolve(checkoutRoot);

  let slots;
  if (all) {
    slots = skillSlotInventory({ homeDir, checkoutRoot: target }).map((s) => ({ ...s, host: null }));
  } else {
    const descriptor = findHostDescriptor(host);
    if (!descriptor) throw new Error(unknownHostError(host, "skill unlink"));
    if (!descriptor.skillSlot) {
      return { mode: "manual", host, slots: [], note: "没有核实的技能槽位——没有 WAO 建的链接可删（WAO 不写宿主配置文件）" };
    }
    const slotPath = slotPathFor(descriptor, homeDir);
    slots = [{
      dir: descriptor.skillSlot.dir,
      slotPath,
      hosts: [descriptor.id],
      state: slotState(slotPath, target),
      target: slotTarget(slotPath),
      host: descriptor.id,
    }];
  }

  // 读不了的槽位无法证明它不指向本检出：--apply 时整体拒绝，什么都不删。
  if (apply) {
    const unreadable = slots.filter((s) => s.state === "unknown");
    if (unreadable.length > 0) {
      throw new Error(
        `拒绝删除：${unreadable.map((s) => s.slotPath).join("、")} 的状态读不了（unknown），无法证明它不指向本检出；` +
        "查清原因（如权限）后重跑。什么都没删。",
      );
    }
  }

  const results = [];
  let removed = 0;
  for (const slot of slots) {
    if (!apply || slot.state !== "linked-current") {
      results.push({
        slot: slot.slotPath,
        dir: slot.dir,
        hosts: slot.hosts,
        state: slot.state,
        action: apply ? `跳过（状态 ${slot.state}，只删 linked-current）` : `--apply 将${slot.state === "linked-current" ? "删除链接本身（非递归 rmdir）" : "跳过（状态 " + slot.state + "）"}`,
      });
      continue;
    }
    // 非递归删链接本身：junction 是目录项，rmdir 只摘链接不碰目标。
    try {
      rmdirSync(slot.slotPath);
    } catch (error) {
      throw new Error(`摘链接失败（${slot.slotPath}：${error?.code ?? error?.message}）——已摘掉 ${removed} 个链接，其余未动；请人工检查`);
    }
    // 删完确认两件事：链接没了；目标检出里的文件还在。
    const gone = slotState(slot.slotPath, target) === "absent";
    const targetIntact = existsSync(join(target, "SKILL.md"));
    if (!gone || !targetIntact) {
      throw new Error(
        `删除后校验失败（slot=${slot.slotPath}，链接消失=${gone}，目标 SKILL.md 在=${targetIntact}）——已摘掉 ${removed} 个链接；请人工检查`,
      );
    }
    removed += 1;
    results.push({ slot: slot.slotPath, dir: slot.dir, hosts: slot.hosts, state: "absent", action: "已删除链接本身（目标检出未动）" });
  }
  return { mode: apply ? "applied" : "preview", host, all, slots: results, removed };
}

// ── 固定文案 ────────────────────────────────────────────────────────────────

function unknownHostError(host, command) {
  return `未知宿主：${host}。${command} 只接受宿主表（hostDescriptors）里的 id：` +
    `${HOST_DESCRIPTORS.map((d) => d.id).join(", ")}`;
}

// 与 --apply 的判定次序一致：先检出资格，再槽位状态，最后宿主是否已装。
function applyActionFor(state, eligibility, hostInstalled) {
  if (!eligibility.eligible) return `--apply 将拒绝（本检出不能当链接目标：${eligibility.reason}）`;
  if (state === "linked-current") return "--apply 无操作（已是本检出的链接）";
  if (state !== "absent") return `--apply 将拒绝（当前状态 ${state}，无 --force）`;
  if (!hostInstalled) return "--apply 将拒绝（宿主主目录不存在：宿主未安装）";
  return "--apply 将创建 junction（fs.symlinkSync junction 类型）";
}

function eligibilityRefusal(eligibility, root) {
  if (eligibility.reason === "linked-worktree") {
    return `拒绝创建链接：${root} 是链接工作树（git rev-parse --git-dir 与 --git-common-dir 不同）——` +
      "隔离工作树会被收走，不能当技能链接目标；在正式检出的根里运行本命令。不提供覆盖参数。";
  }
  if (eligibility.reason === "not-top-level") {
    return `拒绝创建链接：${root} 不是 git 顶层（--show-toplevel 不一致）——不猜链接目标，不提供覆盖参数。`;
  }
  return `拒绝创建链接：${root} 不是 git 检出（${eligibility.detail ?? "git rev-parse 失败"}）——不提供覆盖参数。`;
}
