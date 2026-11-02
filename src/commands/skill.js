// src/commands/skill.js
//
// 决定 0107：skill link / skill unlink 命令族（CLI 适配层）。
//
// Routes:
//   skill link --host <host> [--apply]
//   skill unlink --host <host> [--apply]
//   skill unlink --all --apply        # 卸载流程（install.ps1 -Uninstall）专用
//
// 默认只预览（槽位、链接目标、当前状态、--apply 会做什么）；--apply 才创建/
// 删除。数据逻辑全部在 ../application/skillLink.js（决定 0107 的窄口子实现）；
// 本文件只做 argv 解析 + 呈现。
//
// Architectural contract:
//   - Imports src/application/skillLink.js（application 服务，唯一改动面）。
//   - Imports ./shared.js for parseOptions。
//   - Does NOT import cli.js（依赖方向：cli.js -> skill.js）。
//   - 不写宿主配置文件；没有 skillSlot 的宿主零写入，只打印手工指引。

import { parseOptions } from "./shared.js";
import { linkSkill, unlinkSkill } from "../application/skillLink.js";
import { HOST_DESCRIPTOR_IDS } from "../hostAdapters/hostDescriptors.js";

const SHARED_SLOT_NOTE =
  "该目录被这个宿主在本用户下的所有会话共用——Claude Code 会在会话中途加载新技能，" +
  "链接建好后不需要重启会话；链接在不等于宿主已加载，加载以 hostDescriptors 的核实证据为准。";

async function skillCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "link") {
    await skillLinkCommand(tail, config);
    return;
  }
  if (sub === "unlink") {
    await skillUnlinkCommand(tail, config);
    return;
  }
  throw new Error(`Unknown skill subcommand: ${sub ?? "(none)"} (expected: link | unlink)`);
}

async function skillLinkCommand(args) {
  const options = parseOptions(args);
  if (!options.host) {
    throw new Error(`skill link requires --host (known hosts: ${HOST_DESCRIPTOR_IDS.join(", ")})`);
  }
  const result = await linkSkill({ host: options.host, apply: options.apply === true });
  const shown = result.mode === "preview" || result.mode === "linked" ? { ...result, note: SHARED_SLOT_NOTE } : result;
  console.log(JSON.stringify(shown, null, 2));
}

async function skillUnlinkCommand(args) {
  const options = parseOptions(args);
  const all = options.all === true;
  const host = options.host ?? null;
  if (!all && !host) {
    throw new Error(`skill unlink requires --host <host id>（卸载流程用 --all --apply）`);
  }
  const result = await unlinkSkill({ host, all, apply: options.apply === true });
  console.log(JSON.stringify(result, null, 2));
}

export { skillCommand };
