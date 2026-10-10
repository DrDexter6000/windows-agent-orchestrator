// src/mcp/parentImage.js
//
// B 审计臂（kimi 诊断批 2026-10-10，Owner 批准）：MCP stdio 实例启动时解析
// 父进程镜像名（如 kimi.exe / ZCode.exe / codex.exe）——本实例派发的每个 run
// 在 run.background_submitted 上留 mcpParentImage 溯源事实（只记录不拦截；
// 经 buildChildEnv 白名单不进 worker env）。解析失败=缺席（best-effort，
// 永不阻塞启动）。
import { spawnSync } from "node:child_process";

export const MCP_PARENT_IMAGE_ENV = "WAO_MCP_PARENT_IMAGE";

/** tasklist CSV 输出解析（纯函数，测试钉）。行形如 "kimi.exe","1234",... */
export function parseTasklistCsvImage(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) return null;
  const firstLine = stdout.split(/\r?\n/, 1)[0].trim();
  if (firstLine.length === 0) return null;
  const match = /^"([^"]+)",/.exec(firstLine);
  const image = match ? match[1] : firstLine.split(",", 1)[0].trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}\.exe$/i.test(image)) return null;
  return image;
}

/** 解析并置入本进程 env（best-effort：任何失败静默缺席）。 */
export function armMcpParentImage({ ppid = process.ppid, spawnFn = spawnSync, env = process.env } = {}) {
  try {
    if (!Number.isInteger(ppid) || ppid <= 0) return null;
    const r = spawnFn("tasklist", ["/FI", `PID eq ${ppid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (!r || r.error || typeof r.stdout !== "string") return null;
    const image = parseTasklistCsvImage(r.stdout);
    if (image === null) return null;
    env[MCP_PARENT_IMAGE_ENV] = image;
    return image;
  } catch {
    return null;
  }
}
