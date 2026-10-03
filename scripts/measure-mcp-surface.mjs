#!/usr/bin/env node
// scripts/measure-mcp-surface.mjs
//
// Post-M12 candidate 测量轮（roadmap「MCP Host-visible 上下文测量与渐进披露审计」，
// 2026-10-03 Owner 批准激活）：对生产 stdio server 做**无损测量**，产出三类预算的
// 确定性基线数据——零面变更、零依赖新增（AGENTS 不变式 5）。
//
// 测量口径（与冻结预案一致）：
//   fullWire        —— JSON-RPC tools/list 响应的原始字节（服务端真实发出的 wire）
//   hostVisible     —— {name, description, inputSchema} 三字段字节（M12-16 实测的
//                      Codex Host 投影形状；三宿主活探针为后续步骤）
//   perTool         —— 每工具四段拆分（name/description/inputSchema/outputSchema）
//   enumDuplication —— 跨 schema 重复枚举数组的字节量（候选 3 的靶子）
//
// token 估算方法声明：repo 历史冻结基线 75,965 bytes ≈ 18,372 o200k tokens
// （roadmap M12-16 轮），隐含比率 ≈ 4.14 bytes/token——本脚本沿用同一比率外推，
// 估算值仅供排序参考；真实分词器计数留给宿主活探针轮。
//
// 用法：node scripts/wao-node.cjs scripts/measure-mcp-surface.mjs [--json]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BYTES_PER_TOKEN = 75965 / 18372; // 历史冻结比率，方法声明见上

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

const runDir = mkdtempSync(join(tmpdir(), "wao-surface-measure-"));
const child = spawn(process.execPath, [
  join(REPO_ROOT, "scripts", "wao-node.cjs"),
  join(REPO_ROOT, "src", "mcp", "stdio.js"),
  "--registry", join(REPO_ROOT, "config", "agents.example.json"),
  "--run-dir", runDir,
], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

let buf = "";
const responses = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, line);
    } catch { /* 非 JSON 行忽略（banner 等） */ }
  }
});
let stderrTail = "";
child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString()).slice(-500); });

function awaitResponse(id, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (responses.has(id)) { clearInterval(timer); res(responses.get(id)); }
      else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        rej(new Error(`tools/list 超时；stderr 尾部：${stderrTail}`));
      }
    }, 25);
  });
}

const bytes = (s) => Buffer.byteLength(s, "utf8");
const estTokens = (b) => Math.round(b / BYTES_PER_TOKEN);

try {
  child.stdin.write(rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "wao-surface-measure", version: "0.0.1" },
  }));
  await awaitResponse(1);
  child.stdin.write(rpc(2, "notifications/initialized", {}));
  child.stdin.write(rpc(3, "tools/list", {}));
  const wireLine = await awaitResponse(3);
  const parsed = JSON.parse(wireLine);
  const tools = parsed.result?.tools;
  if (!Array.isArray(tools)) throw new Error("tools/list 响应缺少 tools 数组");

  const perTool = tools.map((t) => {
    const name = bytes(t.name);
    const description = bytes(t.description ?? "");
    const inputSchema = bytes(JSON.stringify(t.inputSchema ?? {}));
    const outputSchema = t.outputSchema ? bytes(JSON.stringify(t.outputSchema)) : 0;
    const annotations = t.annotations ? bytes(JSON.stringify(t.annotations)) : 0;
    const hostVisible = name + description + inputSchema;
    return {
      name: t.name, nameB: name, descriptionB: description,
      inputSchemaB: inputSchema, outputSchemaB: outputSchema, annotationsB: annotations,
      hostVisibleB: hostVisible,
    };
  });

  // 跨 inputSchema 的重复枚举数组：以规范化 JSON 串为键统计出现 ≥2 次的枚举集合
  const enumKeys = new Map();
  for (const t of tools) {
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.enum) && node.enum.length > 0) {
        const key = JSON.stringify(node.enum);
        enumKeys.set(key, (enumKeys.get(key) ?? 0) + 1);
      }
      for (const v of Object.values(node)) walk(v);
    };
    walk(t.inputSchema);
  }
  let dupEnumBytes = 0;
  let dupEnumCount = 0;
  for (const [key, n] of enumKeys) {
    if (n >= 2) { dupEnumBytes += bytes(key) * (n - 1); dupEnumCount += 1; }
  }

  const sum = (f) => perTool.reduce((a, p) => a + f(p), 0);
  const result = {
    measuredAt: new Date().toISOString(),
    toolCount: tools.length,
    fullWireB: bytes(wireLine),
    fullWireTokensEst: estTokens(bytes(wireLine)),
    hostVisibleB: sum((p) => p.hostVisibleB),
    hostVisibleTokensEst: estTokens(sum((p) => p.hostVisibleB)),
    descriptionTotalB: sum((p) => p.descriptionB),
    inputSchemaTotalB: sum((p) => p.inputSchemaB),
    outputSchemaTotalB: sum((p) => p.outputSchemaB),
    annotationsTotalB: sum((p) => p.annotationsB),
    enumDuplication: { distinctDuplicatedEnums: dupEnumCount, redundantBytes: dupEnumBytes },
    methodNote: `token 为估算：沿用 repo 冻结基线比率 ${BYTES_PER_TOKEN.toFixed(2)} bytes/token（75,965B≈18,372 o200k tokens）；真实分词计数待三宿主活探针`,
    perTool: [...perTool].sort((a, b) => b.hostVisibleB - a.hostVisibleB),
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`tools=${result.toolCount} fullWire=${result.fullWireB}B(~${result.fullWireTokensEst} tok est) hostVisible=${result.hostVisibleB}B(~${result.hostVisibleTokensEst} tok est)`);
    console.log(`split: description=${result.descriptionTotalB}B inputSchema=${result.inputSchemaTotalB}B outputSchema=${result.outputSchemaTotalB}B annotations=${result.annotationsTotalB}B`);
    console.log(`enum duplication: ${result.enumDuplication.distinctDuplicatedEnums} 组重复枚举，冗余 ${result.enumDuplication.redundantBytes}B`);
    console.log("host-visible Top8:");
    for (const p of result.perTool.slice(0, 8)) {
      console.log(`  ${p.name}: ${p.hostVisibleB}B (desc ${p.descriptionB} / in ${p.inputSchemaB})`);
    }
  }
  child.kill();
} finally {
  rmSync(runDir, { recursive: true, force: true });
}
