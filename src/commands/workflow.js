// src/commands/workflow.js
//
// TD-98 阶段 2c：workflow command family 从 cli.js 拆出（行为不变，纯搬迁）。
//
// 命令族：workflow run <name|file.mjs> / workflow list
//
// 依赖：
//   - 外部模块：../workflow/loader.js（loadWorkflow/applyTemplate）、../workflow/engine.js
//     （WorkflowEngine）、../transcript.js（JsonlTranscript）
//   - 共享工具：./shared.js（parseOptions/resolveIsolateFlag/newRunManager）
//   - node built-in：fs/promises（readdir/readFile/mkdir）、fs（existsSync）、
//     path（join/resolve/dirname）、url（fileURLToPath）
//
// 本模块内部 helper：parseTemplateVars（workflow run 的 --vars 解析）。

import { readdir, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonlTranscript } from "../transcript.js";
import { loadWorkflow, applyTemplate } from "../workflow/loader.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { parseOptions, resolveIsolateFlag, newRunManager } from "./shared.js";

async function workflowCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "run") {
    await workflowRunCommand(tail, config);
    return;
  }
  if (sub === "list") {
    await workflowListCommand(config);
    return;
  }
  throw new Error(`Unknown workflow subcommand: ${sub ?? "(none)"}. Try: workflow run <name|file.mjs> | workflow list`);
}

/**
 * workflow list：列出可用模板（TD-88 模板库）。
 * 扫描 workflows/templates/ 目录，列出 .mjs 模板名 + 用法提示。
 */
async function workflowListCommand(config) {
  const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "templates");
  let files = [];
  try {
    files = (await readdir(templatesDir)).filter((f) => f.endsWith(".mjs"));
  } catch {
    // templates 目录不存在 = 无模板
  }
  if (files.length === 0) {
    console.log("No workflow templates found. 用 workflow run <file.mjs> 跑自定义 workflow。");
    return;
  }
  console.log("可用模板（workflow run <名字> --vars ...）：");
  for (const f of files) {
    const name = f.replace(/\.mjs$/, "");
    // 读文件头注释找用法（前 8 行的"用法"或"模板"字样）
    let usage = "";
    try {
      const content = await readFile(join(templatesDir, f), "utf8");
      const lines = content.split("\n").slice(0, 8);
      const usageLine = lines.find((l) => l.includes("用法") || l.includes("workflow run"));
      if (usageLine) usage = usageLine.replace(/^\/\/\s*/, "").trim();
    } catch {}
    console.log(`  ${name}${usage ? `\t${usage}` : ""}`);
  }
  console.log("");
  console.log("用法：workflow run <名字> --vars key=value [--vars ...]");
  console.log("也可传完整路径：workflow run workflows/templates/<名字>.mjs");
}

// workflow run 专用：解析可多次出现的 --vars key=value。
function parseTemplateVars(args) {
  const vars = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--vars" && i + 1 < args.length) {
      const pair = args[i + 1];
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        throw new Error(`--vars requires key=value format, got: ${pair}`);
      }
      const key = pair.slice(0, eqIdx);
      const value = pair.slice(eqIdx + 1);
      vars[key] = value;
      i += 1;
    }
  }
  return vars;
}

async function workflowRunCommand(args, config) {
  const [filePath, ...tail] = args;
  if (!filePath) {
    throw new Error("workflow run requires <name|file.mjs>. 用 workflow list 看可用模板。");
  }
  const options = parseOptions(tail);

  // TD-88 模板库：名字解析。若 filePath 不像路径（无分隔符 / 不是已存在文件），
  // 查 workflows/templates/<名字>.mjs。找到用它；找不到 fallback 到原路径逻辑。
  let absolutePath = resolve(filePath);
  const looksLikePath = /[\\/]/.test(filePath) || existsSync(absolutePath);
  if (!looksLikePath) {
    const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "templates");
    const templatePath = join(templatesDir, `${filePath}.mjs`);
    if (existsSync(templatePath)) {
      absolutePath = templatePath;
    }
  }

  // 加载 workflow
  const wfDef = await loadWorkflow(absolutePath);

  // 参数式 DAG：--vars key=value 注入模板变量（可多次）
  const templateVars = parseTemplateVars(tail);
  const effectiveDef = Object.keys(templateVars).length > 0
    ? applyTemplate(wfDef, templateVars)
    : wfDef;

  // workflow 级 transcript
  const runDir = resolve(options.runDir ?? config.runDir);
  await mkdir(runDir, { recursive: true });
  const workflowRunId = `wf_${new Date().toISOString().replace(/[-:.TZ]/g, "")}`;
  const transcript = new JsonlTranscript(join(runDir, `${workflowRunId}.jsonl`), {
    runId: workflowRunId,
    agentId: effectiveDef.id,
  });

  // 执行
  const manager = newRunManager(config);
  const engine = new WorkflowEngine({ runManager: manager, transcript });
  const result = await engine.execute(effectiveDef, {
    input: options.input,
    isolate: resolveIsolateFlag(options),
    ...(options.registry ? { registry: options.registry } : {}),
    runDir,
    ...(options.waitTimeout ? { waitTimeout: Number(options.waitTimeout) } : {}),
  });

  // TD-102: nodes 含所有定义节点——执行的有结果，skipped 的标 {completed:false, skipped:true}。
  const skippedSet = new Set(result.skipped ?? []);
  const nodeEntries = Object.entries(result.nodeResults).map(([id, r]) => [id, {
    completed: r.completed,
    runId: r.runId,
  }]);
  for (const nodeId of skippedSet) {
    if (!nodeEntries.some(([id]) => id === nodeId)) {
      nodeEntries.push([nodeId, { completed: false, skipped: true }]);
    }
  }

  console.log(JSON.stringify({
    workflowRunId,
    workflowId: wfDef.id,
    completed: result.completed,
    nodes: Object.fromEntries(nodeEntries),
  }, null, 2));
}

export { workflowCommand };
