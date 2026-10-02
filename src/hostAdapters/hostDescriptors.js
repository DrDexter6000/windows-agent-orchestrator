// src/hostAdapters/hostDescriptors.js
//
// TD-191① / 决定 0043：冻结宿主描述符表——宿主接入能力的唯一权威（闭集）。
//
// 三能力正交（2026-10-02 双席会审裁定，consult_20261002211156585jgebok：
// auditor run_20261002211156587sbtvda + coder_mm run_20261002211158908pls6sd）：
//   snippet      — 能产出该宿主形态的注册片段（格式权威；mcp bind 对这类宿主
//                  emit 片段而非拒绝）
//   autoBind     — mcp bind 能真写该宿主配置（当前仅 codex；hostAdapters 层
//                  保留其适配器实现）
//   hostVerified — 已在真实宿主上验证加载（vs 仅格式核实；决定"实测"声称边界）
//
// 纪律：仅纳入格式已核实的宿主；未知宿主在 bind/onboarding 层显式拒绝
// （fail-closed），不猜测格式。本模块是共享叶子：不 import
// application/commands/mcp/SDK/zod（mcpBind.test.js 冻结的依赖方向）。
//
// 证据锚点：
//   codex       — M9-7B Codex Lead dogfood（run_20260715122607417p5fbue，MCP 闭环）
//   claude-code — M9-7B Claude Code/Fable Lead dogfood（run_20260715124226755a97el2）
//   zcode       — 格式级入表（2026-10-02 实机勘察：本机在册插件 context7 的
//                 .claude-plugin/plugin.json + 根级 .mcp.json 扁平 server 映射
//                 {name:{command,args}}——非 mcpServers 嵌套形）。hostVerified=
//                 false：真实宿主加载（注册机制+重启生效）未验证，走
//                 AGENT_ONBOARDING 的 Owner 入表清单（备份→追加→重启→观察→还原）。

/** host-neutral stdio entry → 该宿主形态的注册片段（纯映射，零 I/O）。 */
function mcpServersShape(entry) {
  return { configShape: "mcpServers", mcpServers: { wao: entry } };
}

/** zcode 插件包形态：plugin 清单 + 根级 .mcp.json 扁平 server 映射。 */
function zcodePluginShape(entry) {
  return {
    configShape: "zcode-local-plugin",
    files: {
      ".claude-plugin/plugin.json": {
        name: "wao",
        description: "WAO control plane MCP server (stdio)",
        author: "WAO",
      },
      ".mcp.json": {
        wao: { command: entry.command, args: entry.args },
      },
    },
  };
}

export const HOST_DESCRIPTORS = [
  {
    id: "claude-code",
    label: "Claude Code",
    snippet: true,
    autoBind: false,
    hostVerified: true,
    stability: "stable",
    renderSnippet: mcpServersShape,
    example: (argv) => `claude mcp add wao --scope user -- ${argv}`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    snippet: true,
    autoBind: true,
    hostVerified: true,
    stability: "experimental", // codex mcp 命令族为 [experimental]——如实随行
    renderSnippet: mcpServersShape,
    example: (argv) => `codex mcp add wao -- ${argv}`,
  },
  {
    id: "zcode",
    label: "ZCode",
    snippet: true,
    autoBind: false,
    hostVerified: false, // 格式已核实（实机插件包勘察）；宿主加载未验证
    stability: "unverified-host-load",
    renderSnippet: zcodePluginShape,
    example: () =>
      "按 AGENT_ONBOARDING 的 zcode 入表清单装为本地插件（.claude-plugin/plugin.json + .mcp.json），重启 ZCode 后观察 wao server——hostVerified 待真机加载验证",
  },
];

/** 描述符 id 闭集（SUPPORTED_HOSTS 的派生源；勿在此之外手写第二份清单）。 */
export const HOST_DESCRIPTOR_IDS = HOST_DESCRIPTORS.map((d) => d.id);

/** @returns {object|null} 描述符或 null（未知宿主） */
export function findHostDescriptor(id) {
  return HOST_DESCRIPTORS.find((d) => d.id === id) ?? null;
}
