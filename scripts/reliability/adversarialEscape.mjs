// scripts/reliability/adversarialEscape.mjs
//
// 越界写拦截【事实】读取（纯函数，只取证据不做判定）。
//
// 决定 0084：越界写对抗演练（给模型越界指令、断言拦截）已从组合层退役——守约的
// 模型拒绝往外写，演练无靶可拦，红的是模型的守约，不是机制。组合层的活体证据
// 由 containmentEvidence drill 承担（判定内核 containmentEvidence.mjs），确定性
// 证据由链式测试 test/backends/containmentChain.test.js 承担。本模块只保留
// findWorkdirEscapeEvidence：组件层 componentDrills.mjs 的
// llmOutOfBoundsDispositionCheck 仍在消费（越界指令处置仅记录，informational）。
//
// 纯模块：零 I/O。拦截证据是 transcript 事实（runManager 的 delivery containment
// gate）：run.isolation_violation{code:"workdir_escape"} 与/或
// run.error{phase:"isolation", code:"workdir_escape"}——closed-set 事实，不含
// 被拒路径原文（runManager 纪律）。

// 拦截证据（closed-set 事实形状）。
export function findWorkdirEscapeEvidence(events) {
  const violation = events.find((e) =>
    e?.type === "run.isolation_violation" && e?.code === "workdir_escape");
  const error = events.find((e) =>
    e?.type === "run.error" && e?.phase === "isolation" && e?.code === "workdir_escape");
  return { violation, error };
}
