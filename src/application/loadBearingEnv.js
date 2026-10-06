// src/application/loadBearingEnv.js
//
// TD-218（2026-10-06 三方会审裁定）：承重运行时 env 的 backend 声明表 + doctor
// 独立 advisory。Carlola 案根因面：zcode 车道的两个 provider 配置 env 变量缺失
// 时 spawn 期即死（"无法定位 CLI ZCode Built-in Provider Config"），而 doctor 只
// 遍历 requiredCredentialNames（凭据面）——承重变量两头不沾，结构性失明。
//
// 设计边界（会审 2:1 收窄）：
//   - 独立 advisory 项，不进 requiredCredentialNames/不改变 dispatch 阻断语义
//     （envPolicy 设计意图保留：可选继承名缺失不阻断）。
//   - 名字在场、值不回显（envPolicy 纪律）；file 类只查路径存在性，不读内容。
//   - 解析顺序与 spawn 一致：agent.env（注册表声明）→ 进程 env → User 作用域。
//
// 声明表：backend → 承重变量（name + kind）。zcode 两个变量来自 envPolicy.js:41-44
// 的在册事实（缺 BUILTIN 则 app-server 启动即退；PERSONAL 同族）。

/** @type {Map<string, Array<{name: string, kind: "file"|"plain"}>>} */
export const LOAD_BEARING_ENV_BY_BACKEND = new Map([
  ["zcode", [
    { name: "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", kind: "file" },
    { name: "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", kind: "file" },
  ]],
]);

/**
 * 判定单个承重变量在给定解析源下的状态（纯函数，测试友好）。
 * @returns {{status: "ok"|"missing"|"file-missing", source: "agent-env"|"process-env"|"user-env"|null, fileExists?: boolean}}
 */
export function resolveLoadBearingEnv({ declared, agentEnv = {}, processEnv = {}, userEnvReader = null }) {
  if (typeof agentEnv?.[declared.name] === "string" && agentEnv[declared.name].length > 0) {
    return checkFile({ declared, value: agentEnv[declared.name], source: "agent-env" });
  }
  if (typeof processEnv?.[declared.name] === "string" && processEnv[declared.name].length > 0) {
    return checkFile({ declared, value: processEnv[declared.name], source: "process-env" });
  }
  if (typeof userEnvReader === "function") {
    try {
      const v = userEnvReader(declared.name);
      if (typeof v === "string" && v.length > 0) {
        return checkFile({ declared, value: v, source: "user-env" });
      }
    } catch { /* reader 失败按缺失处理（不猜） */ }
  }
  return { status: "missing", source: null };
}

function checkFile({ declared, value, source }) {
  if (declared.kind !== "file") return { status: "ok", source };
  // 文件存在性由 Full 变体闭环（existsFn 注入）；基础变体只报"已解析"。
  return { status: "ok", source, _value: value };
}

/**
 * 带文件存在性的完整解析（doctor 消费面；existsFn 注入测试）。
 * 值绝不进入返回结构（_value 仅供内部 file 检查后丢弃）。
 */
export function resolveLoadBearingEnvFull({ declared, agentEnv, processEnv, userEnvReader, existsFn }) {
  const r = resolveLoadBearingEnv({ declared, agentEnv, processEnv, userEnvReader });
  if (r.status !== "ok") return r;
  if (declared.kind !== "file") return { status: "ok", source: r.source };
  const value = r._value;
  const exists = typeof existsFn === "function" ? existsFn(value) : null;
  return { status: exists === false ? "file-missing" : "ok", source: r.source, fileExists: exists };
}
