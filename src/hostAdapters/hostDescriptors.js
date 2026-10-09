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
//   zcode       — 真机验证（2026-10-03）：官方通路 `zcode plugins marketplace add
//                 <本地名录>`（source kind=directory）+ `plugins install wao@wao-local`
//                 装入；新会话实测加载全部 23 个工具（前缀 mcp__plugin_wao_wao__），
//                 initialize 握手返回 wao-mcp 0.2.0。名录与插件包源在
//                 ~/.zcode/wao-local-marketplace/（机器级资产，不进仓库）。

/** host-neutral stdio entry → 该宿主形态的注册片段（纯映射，零 I/O）。 */
function mcpServersShape(entry) {
  return { configShape: "mcpServers", mcpServers: { wao: entry } };
}

// zcode 对单个 MCP 工具调用的默认超时是 30000ms（zcode-guide diagnosing-mcp；
// .mcp.json stdio 条目可选 timeoutMs 字段覆盖）。WAO 等待族全部超过该默认
// （run_wait 180000..600000、run_await_result ≤270000、run_consult waitMs
// ≤600000）——不带此字段时每个 >30s 的等待调用都会被宿主掐成"假失败"
// （2026-10-04 跨项目会话实测：run_consult/run_await_result 双双 30s 死亡）。
// 660000 = 最大阻塞预算 600s + 60s 响应余量。插件通道透传+执行已实证：
// 3000ms 负探针精确掐断（"Tool execution timed out after 3000ms"）、660000
// 下 50.6s 阻塞正常返回（dogfood，run_20261004104811798qoo25y）。
const ZCODE_PLUGIN_TIMEOUT_MS = 660_000;

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
        wao: { command: entry.command, args: entry.args, timeoutMs: ZCODE_PLUGIN_TIMEOUT_MS },
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
    hostVerified: true, // 2026-10-03 真机验证（官方插件通路，23 工具实测加载）
    stability: "stable",
    renderSnippet: zcodePluginShape,
    example: () =>
      "zcode plugins marketplace add <本地名录目录> && zcode plugins install wao@wao-local —— 名录与插件包内容见 mcp bind --host zcode 的 emit（接入步骤见 AGENT_ONBOARDING）",
  },
];

/** 描述符 id 闭集（SUPPORTED_HOSTS 的派生源；勿在此之外手写第二份清单）。 */
export const HOST_DESCRIPTOR_IDS = HOST_DESCRIPTORS.map((d) => d.id);

/** @returns {object|null} 描述符或 null（未知宿主） */
export function findHostDescriptor(id) {
  return HOST_DESCRIPTORS.find((d) => d.id === id) ?? null;
}
