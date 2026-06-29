// src/nodeVersionGuard.js
//
// TD-40：Node 版本校验守卫。在零依赖约束下，靠 engines+启动校验守住 v22 的 OS 级进程隔离。
//
// 背景（决策依据，详见 docs/02-architecture.md §4.3 + ADR 0013）：
//   - Node 自 v18+ 经 libuv 已把 spawn 的子进程绑进 Windows Job Object
//     （JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE）：父进程退出 → OS 自动杀全部子进程。
//   - v22 上这个内置机制正常工作；v24 是该内置机制回归（会杀长进程）。
//   - 行业最佳实践 = taskkill /T/F（WAO 现状，主动 abort）+ 复用内置 Job Object（被动：父死全杀）。
//     自定义 Job Object 违反零依赖（需 N-API/FFI 编译原生模块），且业界无人这样做（内置已够用）。
//
// 故 TD-40 重定义：不实现自定义 Job Object，而是靠 engines+启动校验确保只在 v22（及未来修复版 v24）
// 上跑——让 Node 内置 Job Object 提供 OS 级"进程死即会话死"保证，taskkill /T/F 保留为主动 abort 路径。
//
// 数据驱动：BLOCKED_RANGES / ALLOWED_FIXED_VERSIONS 两个常量，便于官方发修复版后维护。
// 纯函数 checkNodeVersion(versionString, {allowedFixed?}) → {ok, blocked?, reason?}，可单测。

// 被拒绝的版本范围（语义：major 为 key，value 是 reason tag）。
// v24：libuv Job Object 回归（截至 2026-06 无官方修复版）。等修复版发布，把具体已修复版本
//      移入 ALLOWED_FIXED_VERSIONS 即可放行。
// v23：奇数 = 不稳定/非 LTS，本就不是生产 lane。
const BLOCKED_MAJORS = {
  24: "v24 has a libuv Windows Job Object regression (kills long-lived spawned child processes)",
  23: "v23 is an odd/unstable (non-LTS) release — not a production lane",
};

// 未来官方发布的已修复 v24 小版本放行清单（初始为空：截至 2026-06 无修复版）。
// 维护方式：官方发修复版后，在此追加，如 "v24.30.0"。
const ALLOWED_FIXED_VERSIONS = [];

/**
 * 解析 Node 版本字符串（兼容 "v22.13.1" / "22.13.1"）。
 * @returns {{major:number,minor:number,patch:number}|null}
 */
function parseVersion(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/**
 * 校验当前 Node 版本是否允许跑 WAO（TD-40：守住 v22 的内置 Job Object 进程隔离）。
 * @param {string} version - process.version（如 "v22.13.1"）
 * @param {{allowedFixed?: string[]}} [opts] - 额外放行清单（测试用；生产读 ALLOWED_FIXED_VERSIONS）
 * @returns {{ok:true}|{ok:false, blocked:true, reason:string}}
 */
export function checkNodeVersion(version, opts = {}) {
  const allowedFixed = [...ALLOWED_FIXED_VERSIONS, ...(opts.allowedFixed ?? [])];
  const parsed = parseVersion(version);

  if (!parsed) {
    return {
      ok: false,
      blocked: true,
      reason: `无法解析 Node 版本 "${version}"。WAO 需要 Node v22（见 .nvmrc）。`,
    };
  }

  const { major, minor, patch } = parsed;
  const verStr = `v${major}.${minor}.${patch}`;

  // 低于 engines 下限（v22）
  if (major < 22) {
    return {
      ok: false,
      blocked: true,
      reason: `Node ${verStr} 低于最低要求 v22。WAO 依赖 v22+ 的内置 Windows Job Object 进程隔离（进程死即会话死）。请用 v22（见 .nvmrc）。`,
    };
  }

  // 被拒绝的 major（但先看是否在放行清单——官方修复版）
  if (BLOCKED_MAJORS[major] && !allowedFixed.includes(verStr)) {
    const why = BLOCKED_MAJORS[major];
    const futureHint = major === 24
      ? " 等官方发布 v24 修复版后，会加入放行清单（见 src/nodeVersionGuard.js ALLOWED_FIXED_VERSIONS）。"
      : "";
    return {
      ok: false,
      blocked: true,
      reason: `Node ${verStr} 被拒绝：${why}。请用 v22（见 .nvmrc）。${futureHint}`.trim(),
    };
  }

  return { ok: true };
}
