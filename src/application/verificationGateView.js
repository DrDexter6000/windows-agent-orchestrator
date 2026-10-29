// 交付验证停在 pending 时并入的验证闸租约快照。CLI `runs delivery` 与 MCP
// `run_delivery` 共用这一份（TD-267）。
import { createVerificationGate } from "../verificationGate.js";

/**
 * 2026-10-12 消费者侧反馈：交付验证停在 pending 时，runs delivery 只显示 pending——
 * Lead 要另跑 runs gate 才知道闸被谁占着（当日一条运行等了约 11 分钟）。pending
 * 且尚未裁决时并入验证闸**租约事实**的只读快照：与 runs gate 同一个 status()
 * 查询，绝不认领、绝不释放；查询失败则整段省略（显示面附加信息，fail-open）。
 *
 * 只报租约事实，不推断执行状态（会审 sol 席）：租约可能陈旧（附心跳年龄让 Lead
 * 自己判断）；"别人持有"不能证明本 run 正在排队（验证也可能已中断，或 fail-open
 * 无闸运行）；"无租约"不能证明验证尚未开始。措辞因此只说持有情况。
 * @param {object} view — getRunDelivery / getRunDeliveryReadiness 的结果
 * @param {string} runId
 * @param {{createGate?: () => {status: () => Promise<object>}}} [deps] — 测试注入缝
 * @returns {Promise<{lease: "held_by_this_run"|"held_by_other"|"free"|"corrupt", holder?: object}|null>}
 */
export async function describePendingVerificationGate(view, runId, {
  createGate = () => createVerificationGate({ identity: { owner: "delivery-view" } }),
} = {}) {
  if (!view?.deliveryAvailable || view.verification?.status !== "pending") return null;
  if (view.acceptance?.status === "accepted" || view.acceptance?.status === "rejected") return null;
  try {
    const lease = await createGate().status();
    if (lease.free) return { lease: "free" };
    if (lease.corrupt) return { lease: "corrupt" };
    const h = lease.holder ?? {};
    const holder = {};
    for (const k of ["owner", "runId", "agentId"]) {
      if (typeof h[k] === "string" && h[k].length > 0) holder[k] = h[k];
    }
    if (typeof h.startedAt === "string" || Number.isFinite(h.startedAt)) holder.startedAt = h.startedAt;
    if (Number.isFinite(h.ageMs)) holder.heartbeatAgeMs = h.ageMs;
    return { lease: h.runId === runId ? "held_by_this_run" : "held_by_other", holder };
  } catch {
    return null;
  }
}
