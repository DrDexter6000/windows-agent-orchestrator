// scripts/reliability/runtime-identity-cli.mjs
//
// 薄 CLI 入口（TD-185 gen-*-cli 同款范式）：单 backend 只读版本探针，供前置盘点
// 一条命令复现（2026-10-02 前置盘点 round 2 F1——此前无独立入口，执行者只能手工
// 拼等价命令）。零 token：恰一次 `<binary> --version` spawn（或 honest unknown）。
//
// 用法：
//   node scripts/wao-node.cjs scripts/reliability/runtime-identity-cli.mjs --backend <name> [--registry <file>]
//
// 语义：
//   - 结果恒 JSON 打到 stdout；unknown 是合法结果，exit 0（与组件层 honest unknown
//     同纪律——探测失败是要记录的事实，不是命令失败）。
//   - 不读默认 registry（环境读取面纪律 R23-D：读 live 配置必须显式 --registry）。
//     无 --registry 时 agent=null，走描述符 fallback（PATH 级身份）。
//   - --registry 时取该 backend 的首个席位作 anchor，并消费 backend 的
//     resolveInvocationPrefix（与 component-check 同源——探测与真实 run 同入口）。
//   - 用法错误（缺 --backend / 未知 flag）→ stderr 用法 + exit 1，零探测。
//   - --help → stdout 用法，exit 0。

import { probeRuntimeIdentity } from "./runtimeIdentity.mjs";
import { backendFor } from "../../src/backends/factory.js";
import { readRegistry } from "../../src/registry.js";

function usage(stream) {
  stream.write(
    "Usage: node scripts/wao-node.cjs scripts/reliability/runtime-identity-cli.mjs "
    + "--backend <name> [--registry <agents.json>]\n"
    + "  --backend   WAO backend 名（KNOWN_BACKENDS 闭集成员或任意名——未知名得 honest unknown）\n"
    + "  --registry  显式 registry 路径；提供时以该 backend 首个席位为 anchor 并消费\n"
    + "              backend resolveInvocationPrefix（缺省不读任何 registry，PATH 级探测）\n",
  );
}

export function parseArgs(argv) {
  const out = { backend: null, registry: null };
  const valueOf = (flag, index) => {
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      // 裸 flag 不得静默降级（--registry 缺值被当"无 registry"= 无声行为变化）。
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { ...out, help: true };
    if (arg === "--backend") {
      out.backend = valueOf(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--registry") {
      out.registry = valueOf(arg, i);
      i += 1;
      continue;
    }
    throw new Error(`unknown flag: ${arg}`);
  }
  return out;
}

export async function probeFor({ backend, registry }) {
  let agent = null;
  let resolvedInvocation = null;
  if (registry) {
    // readRegistry 返回句柄（listAgents/getAgent/rawEntries）——rawEntries 容忍
    // 单条坏配置（M12-25）：探别的 backend 不该被无关坏条目打死。
    const handle = await readRegistry(registry);
    const entry = handle.rawEntries().find(([, config]) => config?.backend === backend);
    agent = entry ? { id: entry[0], ...entry[1] } : null;
    if (agent) {
      try {
        const impl = backendFor(agent);
        if (typeof impl?.resolveInvocationPrefix === "function") {
          resolvedInvocation = await impl.resolveInvocationPrefix(agent);
        }
      } catch {
        // honest unknown 兜底：解析失败时探针的 fallback 目标失败会成为
        // verified:false——这正是要记录的事实，不中断。
      }
    }
  }
  const identity = await probeRuntimeIdentity({ backendName: backend, agent, resolvedInvocation });
  // anchorAgentId：本次探测实际锚定的席位（多部署时逐目标各调一次——单次调用
  // 只代表一个 anchor，勿以其代表该 backend 全部目标）。
  return { identity, anchorAgentId: agent?.id ?? null };
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n`);
    usage(stderr);
    return 1;
  }
  if (args.help) {
    usage(stdout);
    return 0;
  }
  if (typeof args.backend !== "string" || args.backend.length === 0) {
    stderr.write("--backend is required\n");
    usage(stderr);
    return 1;
  }
  if (args.registry === null) {
    // 无 registry：agent=null，PATH 级探测。
  } else if (typeof args.registry !== "string" || args.registry.length === 0) {
    stderr.write("--registry requires a path\n");
    usage(stderr);
    return 1;
  }
  const { identity, anchorAgentId } = await probeFor({ backend: args.backend, registry: args.registry });
  stdout.write(`${JSON.stringify({ ...identity, anchorAgentId })}\n`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("runtime-identity-cli.mjs")) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
