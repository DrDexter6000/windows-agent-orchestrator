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
//   kimi-code   — 真机验证（2026-10-12，kimi 2.1.1）：中立仓库里 `kimi -p` 无头会话
//                 列出全部 23 个工具并调用 workspace_status 成功返回（该宿主不
//                 提供 MCP roots，返回 bound=false——Lead 需 workspace_select）。
//   opencode    — 真机验证（2026-10-12）：`opencode mcp list` 报 wao connected；
//                 中立仓库里 `opencode run` 无头会话列出 23 个工具（前缀 wao_）
//                 并调用 workspace_status 返回 bound=true。
//   claude-desktop — 真机验证（2026-10-12，Owner 重启桌面端后）：宿主自己的 MCP
//                 日志（%LOCALAPPDATA%\Claude\Logs\mcp-server-wao.log）记录 server
//                 启动、initialize 握手、tools/list 与 resources/list 均收到返回。
//                 日志不含消息体——工具个数未从宿主侧读到，对话内调用未演练。
//   dsh         — 真机验证（2026-10-18，dsh 0.2.1-rc.2）：web profile 的
//                 cordis.patch.yml 加一条 dsh-mcp-client 的 insert 行后由
//                 patchReload live 生效；宿主内 initialize 握手成功、tools/list
//                 23 个工具（前缀 mcp__wao__），并在真实会话里调用 lead_preflight
//                 返回完整结果（server build 行确认加载本检出 HEAD）。片段见
//                 docs/usage/host.md。
//   （2026-10-12 同批复验：claude-code 用户级注册后中立仓库无头会话 23 工具；
//   codex 0.159.2 `codex exec` 调用 wao.workspace_status completed。详见决定 0066。）
//
// 决定 0066 附加轴（不属三能力矩阵，纯事实字段）：
//   configHint — 无注册子命令的宿主（文件式注册）要并入片段的配置文件位置；
//   detectEnv  — "本 CLI 进程正运行在该宿主会话里"的环境变量标记，仅收录真机
//                核实过的（派发 advisory 用；未核实的宿主不猜，留空）。
//   sessionEnv — 该宿主会话内取值稳定、跨会话不同的环境变量（advisory 按它
//                "每会话只判一次"；缺席时退化为按日）。同样只收录实见过的。

/** host-neutral stdio entry → 该宿主形态的注册片段（纯映射，零 I/O）。 */
function mcpServersShape(entry) {
  return { configShape: "mcpServers", mcpServers: { wao: entry } };
}

/** opencode 形态：顶层 mcp 段，本地 server 的 command 是 argv 数组。 */
function opencodeShape(entry) {
  return {
    configShape: "opencode-mcp",
    mcp: { wao: { type: "local", command: [entry.command, ...entry.args], enabled: true } },
  };
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

// dsh 的 MCP 客户端插件（@deepseek-ai/dsh-mcp-client）给单次 tools/call 的默认
// 超时是 60000ms；WAO 等待族最长 600s。660000 = 600s 最大阻塞预算 + 60s 余量
// （与 zcode 同一算法、同一理由：不设时 run_wait / run_await_result / run_consult
// 会被宿主掐成"假失败"）。
const DSH_MCP_TOOL_TIMEOUT_MS = 660_000;

/** YAML 双引号标量：路径与命令行值不需要多行/转义花样，只转义反斜杠与引号。 */
function yamlDoubleQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * dsh 形态：Cordis profile patch 层的 `insert` 行（YAML），不是 mcpServers JSON。
 * 注册位置是 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`；profile 声明
 * patchReload: live 时改完即生效，否则下次启动 dsh 才加载。
 * `yaml` 是给 Owner 直接粘贴的成品；`insert` 是同一行的结构化投影（同源生成）。
 */
function dshCordisPatchShape(entry) {
  const insert = {
    id: "mcp-wao",
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName: "wao",
      transport: "stdio",
      command: entry.command,
      args: entry.args,
      toolCallTimeoutMs: DSH_MCP_TOOL_TIMEOUT_MS,
    },
  };
  const lines = [
    "- insert:",
    `    - id: ${yamlDoubleQuote(insert.id)}`,
    `      name: ${yamlDoubleQuote(insert.name)}`,
    "      config:",
    `        serverName: ${yamlDoubleQuote(insert.config.serverName)}`,
    `        transport: ${yamlDoubleQuote(insert.config.transport)}`,
    `        command: ${yamlDoubleQuote(insert.config.command)}`,
    "        args:",
    ...insert.config.args.map((arg) => `          - ${yamlDoubleQuote(arg)}`),
    `        toolCallTimeoutMs: ${DSH_MCP_TOOL_TIMEOUT_MS}`,
  ];
  return {
    configShape: "dsh-cordis-profile-patch",
    insert,
    yaml: lines.join("\n"),
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
    detectEnv: ["CLAUDECODE"],
    sessionEnv: ["CLAUDE_CODE_SESSION_ID"], // 桌面端内置 Claude Code 的 shell 环境实见（独立 CLI 未核，缺席则按日）
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
    detectEnv: ["CODEX_THREAD_ID"], // codex exec 0.159.2 的 shell 环境实见
    sessionEnv: ["CODEX_THREAD_ID"],
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
  {
    id: "kimi-code",
    label: "Kimi Code",
    snippet: true,
    autoBind: false,
    hostVerified: true, // 2026-10-12 真机验证（见文件头证据锚点）
    stability: "stable",
    renderSnippet: mcpServersShape,
    configHint: "~/.kimi-code/mcp.json",
    example: () =>
      "把 mcp bind --host kimi-code emit 的 mcpServers.wao 条目并入 ~/.kimi-code/mcp.json（kimi 无 mcp 注册子命令），开新会话后用 mcp status --host kimi-code 核对",
  },
  {
    id: "opencode",
    label: "opencode",
    snippet: true,
    autoBind: false,
    hostVerified: true, // 2026-10-12 真机验证（见文件头证据锚点）
    stability: "stable",
    renderSnippet: opencodeShape,
    configHint: "~/.config/opencode/opencode.json",
    detectEnv: ["OPENCODE"], // opencode run 的 shell 环境实见
    sessionEnv: ["OPENCODE_PID"], // 同上实见
    example: () =>
      "把 mcp bind --host opencode emit 的 mcp.wao 条目并入 ~/.config/opencode/opencode.json 的 mcp 段（opencode mcp add 是交互式向导），再跑 opencode mcp list 核对",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop (chat app)",
    snippet: true,
    autoBind: false,
    hostVerified: true, // 2026-10-12 真机验证（见文件头证据锚点）
    stability: "stable",
    renderSnippet: mcpServersShape,
    configHint: "%APPDATA%\\Claude\\claude_desktop_config.json",
    example: () =>
      "把 mcp bind --host claude-desktop emit 的 mcpServers.wao 条目并入 %APPDATA%\\Claude\\claude_desktop_config.json，完全退出并重启 Claude 桌面端",
  },
  {
    id: "dsh",
    label: "DeepSeek Harness",
    snippet: true,
    autoBind: false, // dsh 的 profile patch 由 Owner 手改；WAO 不写用户家目录配置
    hostVerified: true, // 2026-10-18 真机验证（见文件头证据锚点）
    stability: "experimental", // dsh 0.2.1-rc.2：profile patch 格式随预发布版本演进
    renderSnippet: dshCordisPatchShape,
    configHint: "~/.dsh/profiles/<profile>/cordis.patch.yml",
    // DSH 会把 DSH_* 从 MCP stdio 子进程里脱敏，但 CLI 子进程（wao 命令）仍有
    // DSH_SESSION_ID——advisory 跑在后者的进程里，所以这两轴照样可用。
    detectEnv: ["DSH_SESSION_ID"],
    sessionEnv: ["DSH_SESSION_ID"],
    example: () =>
      "把 mcp bind --host dsh emit 的 insert 行并入 ~/.dsh/profiles/<profile>/cordis.patch.yml（profile 设了 patchReload: live 时立即生效，否则重启 dsh），开新会话后用 mcp status --host dsh 核对",
  },
];

/** 描述符 id 闭集（SUPPORTED_HOSTS 的派生源；勿在此之外手写第二份清单）。 */
export const HOST_DESCRIPTOR_IDS = HOST_DESCRIPTORS.map((d) => d.id);

/** @returns {object|null} 描述符或 null（未知宿主） */
export function findHostDescriptor(id) {
  return HOST_DESCRIPTORS.find((d) => d.id === id) ?? null;
}
