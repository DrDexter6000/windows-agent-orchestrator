// src/application/modelFamily.js
//
// 模型族系推断（R9 / 决策 0023：跨族系三席会审推荐的展示层辅助）。
//
// ⚠ 本表不是契约，展示专用，消费者不得据此门控。
// 唯一用途：onboarding/doctor 的会审就绪提示推断"族系多样性"展示标签
// （经 panelReadiness.js 消费）。dispatch/delivery 路径禁止 import 本模块
// ——族系标签不参与任何派发、验收或交付判定（测试钉住消费面闭集）。
//
// 归一规则：model id 小写 → 剥 [..] 类上下文窗口后缀（如 [1m]）→ 取首段
// （首个 "/" 或 "-" 之前）→ 命中已知族系词表返回族系 token；无 model 块的
// worker（tester/codex 形状）按 backend 名兜底；都未命中 → UNKNOWN_FAMILY。
//
// 未知 ≠ 同族：UNKNOWN_FAMILY 不参与多样性判定（panelReadiness 的跨族系
// 判断只统计已知族系；未知成员既不算同族也不算跨族）。

/** 未识别族系的展示标签（不参与多样性判定）。 */
export const UNKNOWN_FAMILY = "未知族系";

/** 已知族系 token 闭集（首段命中即归属；纯展示词表，非路由契约）。 */
const KNOWN_FAMILIES = Object.freeze([
  "deepseek", "glm", "kimi", "claude", "gpt", "gemini", "qwen", "llama", "mistral", "codex",
]);

/** 无 model 块时的 backend → 族系兜底表（可推断 provider 族系的 backend 才列）。 */
const BACKEND_FAMILY_FALLBACK = Object.freeze({
  "claude-code": "claude",
  "kimi-code": "kimi",
  "deepseek-harness": "deepseek",
  "codex": "codex",
});

/** 族系 token → 展示标签（codex 标注 GPT 血缘，与 claude 系区分）。 */
const FAMILY_LABELS = Object.freeze({
  deepseek: "DeepSeek",
  glm: "GLM",
  kimi: "Kimi",
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
  qwen: "Qwen",
  llama: "Llama",
  mistral: "Mistral",
  codex: "Codex(GPT)",
});

/**
 * 推断一个 worker 的模型族系 token（或 UNKNOWN_FAMILY）。纯函数，无 IO。
 *
 * @param {{modelId?: string|null, backend?: string|null}} input
 * @returns {string} 族系 token（如 "glm"）或 UNKNOWN_FAMILY
 */
export function modelFamilyOf({ modelId, backend } = {}) {
  const token = normalizeModelToken(modelId);
  if (token) {
    const hit = KNOWN_FAMILIES.find((f) => token === f || token.startsWith(f));
    if (hit) return hit;
  }
  return BACKEND_FAMILY_FALLBACK[String(backend ?? "").toLowerCase()] ?? UNKNOWN_FAMILY;
}

/**
 * 族系 token → 展示标签（未知 token 一律 UNKNOWN_FAMILY，不猜）。
 * @param {unknown} family
 * @returns {string}
 */
export function familyLabel(family) {
  const token = String(family ?? "");
  return FAMILY_LABELS[token] ?? UNKNOWN_FAMILY;
}

/** model id 归一：小写、剥 [..] 后缀、取首段（/ 或 - 之前）、剔残余符号。 */
function normalizeModelToken(id) {
  const s = String(id ?? "").trim().toLowerCase();
  if (!s) return "";
  return s
    .replace(/\[[^\]]*\]/g, "")
    .split("/")[0]
    .split("-")[0]
    .replace(/[^a-z0-9]/g, "");
}
