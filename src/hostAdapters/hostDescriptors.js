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
// 纪律：仅纳入格式已核实的宿主（auditor Q2）；未知宿主在 bind/onboarding 层
// 显式拒绝（fail-closed），不猜测格式。本模块是共享叶子：不 import
// application/commands/mcp/SDK/zod（mcpBind.test.js 冻结的依赖方向）。
//
// 证据锚点（hostVerified=true 的依据）：
//   codex       — M9-7B Codex Lead dogfood（run_20260715122607417p5fbue，MCP 闭环）
//   claude-code — M9-7B Claude Code/Fable Lead dogfood（run_20260715124226755a97el2）

export const HOST_DESCRIPTORS = [
  {
    id: "claude-code",
    label: "Claude Code",
    snippet: true,
    autoBind: false,
    hostVerified: true,
    stability: "stable",
    example: (argv) => `claude mcp add wao --scope user -- ${argv}`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    snippet: true,
    autoBind: true,
    hostVerified: true,
    stability: "experimental", // codex mcp 命令族为 [experimental]——如实随行
    example: (argv) => `codex mcp add wao -- ${argv}`,
  },
];

/** 描述符 id 闭集（SUPPORTED_HOSTS 的派生源；勿在此之外手写第二份清单）。 */
export const HOST_DESCRIPTOR_IDS = HOST_DESCRIPTORS.map((d) => d.id);

/** @returns {object|null} 描述符或 null（未知宿主） */
export function findHostDescriptor(id) {
  return HOST_DESCRIPTORS.find((d) => d.id === id) ?? null;
}
