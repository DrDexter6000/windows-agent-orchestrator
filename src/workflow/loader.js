import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { defineWorkflow } from "./schema.js";

/**
 * 从 .mjs 文件加载 workflow 定义（M5-2）。
 *
 * 支持两种 export 形式：
 *   - export default defineWorkflow({...})  （推荐，有校验）
 *   - export default {...}                   （裸对象，loader 内部调 defineWorkflow 校验）
 *
 * 不支持 .yaml/.json（决策：JS/ESM 格式）。
 *
 * 参数式 DAG（M6+）：加载后可调 applyTemplate 注入变量。
 */
export async function loadWorkflow(filePath) {
  const absolute = resolve(filePath);
  const url = pathToFileURL(absolute).href;
  const mod = await import(url);
  const raw = mod.default;

  if (raw == null) {
    throw new Error(`loadWorkflow: ${filePath} has no default export`);
  }

  if (typeof raw === "function") {
    throw new Error(`loadWorkflow: invalid workflow export (got function, expected object)`);
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`loadWorkflow: invalid workflow export (expected object, got ${typeof raw})`);
  }

  return defineWorkflow(raw);
}

/**
 * 参数式 DAG 模板替换（M6+）。
 *
 * 把 workflow 定义里的 {{key}} 占位符替换为 vars 里的值。
 * 递归遍历所有字符串字段（agentId、prompt、requiredClaims、scorecard.rules 等）。
 *
 * 设计决策：
 *   - 未提供的占位符保持原样（不崩，让后续校验报错或当作字面量）
 *   - 返回新对象，不修改原始 workflow（不可变）
 *   - 只替换字符串值（number/boolean/function 不动）
 *
 * @param {object} workflowDef defineWorkflow 的输出
 * @param {Object<string, string>} vars 变量映射
 * @returns {object} 替换后的新 workflow 定义
 */
export function applyTemplate(workflowDef, vars = {}) {
  return substitute(workflowDef, vars);
}

/**
 * 递归替换对象里的 {{key}} 占位符。
 */
function substitute(value, vars) {
  if (typeof value === "string") {
    return replacePlaceholders(value, vars);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitute(item, vars));
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substitute(val, vars);
    }
    return result;
  }
  // number / boolean / function / undefined / null 原样返回
  return value;
}

/**
 * 替换字符串里的所有 {{key}} 占位符。
 * 未找到的占位符保持原样。
 */
function replacePlaceholders(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key]);
    }
    return match; // 未提供，保持原样
  });
}
