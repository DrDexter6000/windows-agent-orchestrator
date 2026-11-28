// src/resumeFailureFact.js
//
// b158a 修复二：后台 resume 失败的持久事实（runner 与 daemon 共用同一实现）。
//
// 两个约束：
//   1. 追加到**原运行**转录的 run.error 必须沿用该运行已绑定的席位 identity——
//      旧实现用 agentId: "resume-runner" 追加，extractCanonicalAgentId 从原席位
//      变成 "unknown"，状态/收取/续修的身份面随之漂移。
//   2. 失败原因只写闭集原因码，不回显异常原文（可能带车道 id、键名、本机路径或
//      换行）——run.error 是给 Lead 看的持久事实，不是调试日志。
import { readTranscript, extractCanonicalAgentId, JsonlTranscript } from "./transcript.js";
import { resolveTranscriptPath } from "./projectBuckets.js";

// 闭集原因码：从固定形状的错误消息里取；域外值一律归 resume_exception。
const RESUME_FAILURE_CODES = Object.freeze([
  "lanes_merge_unavailable",
  "reasoning_not_recorded",
  "worker_configuration_changed",
  "resume_refused",
  "resume_exception",
]);

/**
 * 把 resume 失败消息投影成闭集原因码（不保留原文）。
 * @param {unknown} message
 * @returns {string}
 */
export function durableResumeFailureCode(message) {
  const text = typeof message === "string" ? message : "";
  if (text.includes("lanes_merge_unavailable")) return "lanes_merge_unavailable";
  if (text.includes("resume_refused (reasoning_not_recorded)")) return "reasoning_not_recorded";
  if (text.includes("resume_refused (worker_configuration_changed)")) return "worker_configuration_changed";
  if (text.includes("resume_refused")) return "resume_refused";
  return "resume_exception";
}

/**
 * 往 run 转录追加一条持久 run.error（phase="resume"）。agentId 取该运行已绑定的
 * 原席位（extractCanonicalAgentId）；读不到时保持 "unknown"（不伪造身份）。
 * best-effort：写失败不改变调用方退出路径。
 *
 * @param {string} runId
 * @param {string} runDir
 * @param {string} reasonText 固定形状的失败描述（应只含闭集原因码）
 */
export async function appendDurableResumeFailure(runId, runDir, reasonText) {
  try {
    const filePath = resolveTranscriptPath(runDir, runId);
    let agentId = "unknown";
    try {
      agentId = extractCanonicalAgentId(await readTranscript(filePath), runId);
    } catch {
      agentId = "unknown";
    }
    const t = new JsonlTranscript(filePath, { runId, agentId });
    await t.append("run.error", { phase: "resume", error: reasonText });
  } catch (e) {
    process.stderr.write(`backgroundRunner: durable resume-failure fact unwritable: ${e.message}
`);
  }
}

export { RESUME_FAILURE_CODES };
