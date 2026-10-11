// src/backends/kimiServeOps.js
//
// TD-250（决定 0056，2026-10-10）：kimi serve 级运维原语（Lead 侧维护命令的
// backend 层）。API 事实全部来自 2026-10-10 live 探针（依据记录：
// .wao/decisions/0056 + src/backends/kimiWeb.js 文件头 TD-250 节）：
//   - GET  /api/v1/sessions（Bearer；信封 {code,msg,data}；page_size 可传）
//   - GET  /api/v1/sessions/{id}（detail：busy/main_turn_active/workspace_id）
//   - POST /api/v1/sessions/{id}:delete（code 0=deleted；40401=不存在）
//   - GET  /api/v1/workspaces（items[{id, root}]）
//   - POST /api/v1/shutdown（code 0 —— **全量拆荚原语**：serve+每会话助手进程组
//     +实例元数据全清，零孤儿；重启 ~2s 重绑、token 不变、会话仓/转录内容保留）
//
// 纪律：与 kimiWeb.releaseSession 同款闭集结果——载荷绝不含 token/上游回显
// msg；永不重试（维护路径由 Lead 显式重跑）；超时经 AbortController 有界。
// 本模块不含编排语义（门/soak/台账在 application/serveMaintenance.js）。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 会话级 40401 = "session … does not exist"（HTTP 200 信封码，非路由 404）。
export const SERVE_SESSION_GONE_CODE = 40401;

/**
 * 单枪 serve REST 请求。返回形状闭集：
 *   { httpStatus, code?, data? }   —— 送达（code 缺席=路由层非信封答复）
 *   { aborted: true }              —— 超时
 *   { transportError: true }       —— fetch 抛错（连接拒绝/网络）
 * 绝不回显正文文本（只取 code/data 字段——脱敏面最小化）。
 */
export async function serveRequest({ baseUrl, token, method, path, body, fetchImpl, timeoutMs = 8000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { httpStatus: response.status, code: parsed?.code, data: parsed?.data };
  } catch (error) {
    if (error?.name === "AbortError") return { aborted: true };
    return { transportError: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 会话快照（recycle 门与 status 用）：GET /api/v1/sessions 全量翻页。
 * live 实测（2026-10-11）：page_size 服务端帽=100（>100 → 40001 "Too big"）；
 * 列表 newest-first，`before_id=<上一页末条 id>` 向后翻页，has_more=false 即尽。
 * fail-closed：单页请求非 0 码/形状不符 → upstream_rejected；翻页超帽
 * （20 页=2000 会话，远超本机规模）→ page_overflow 拒绝——不能证明集合完整
 * 就不回收（soak 集合比对的前提是全量视图）。
 */
export async function listServeSessions({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs, pageSize = 100, maxPages = 20 }) {
  const size = Math.min(Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 100, 100);
  const items = [];
  const seen = new Set();
  let beforeId = undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const r = await serveRequest({
      baseUrl, token, method: "GET",
      path: `/api/v1/sessions?page_size=${size}${beforeId !== undefined ? `&before_id=${encodeURIComponent(beforeId)}` : ""}`,
      fetchImpl, timeoutMs,
    });
    if (r.aborted) return { ok: false, reason: "timeout" };
    if (r.transportError) return { ok: false, reason: "http_error" };
    if (r.code !== 0 || !Array.isArray(r.data?.items)) {
      return { ok: false, reason: "upstream_rejected", ...(Number.isInteger(r.code) ? { code: r.code } : {}) };
    }
    let advanced = false;
    for (const it of r.data.items) {
      if (typeof it?.id !== "string" || it.id.length === 0) continue;
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      advanced = true;
      items.push({
        id: it.id,
        workspaceId: typeof it?.workspace_id === "string" ? it.workspace_id : null,
        busy: it?.busy === true,
        mainTurnActive: it?.main_turn_active === true,
      });
    }
    if (r.data.has_more !== true) return { ok: true, items };
    const lastId = r.data.items.length > 0 ? r.data.items[r.data.items.length - 1]?.id : undefined;
    if (!advanced || typeof lastId !== "string" || lastId === beforeId) {
      return { ok: false, reason: "page_overflow" }; // 翻页无进展=游标失灵，拒绝
    }
    beforeId = lastId;
  }
  return { ok: false, reason: "page_overflow" };
}

/**
 * 单会话 detail 探针（sweep 对每个认领会话的存活/归属判定）。
 * 40401 → {ok:true, gone:true}；busy 折叠只作只读事实返回（清扫不删忙会话由
 * 调用方门控；这里不替调用方做删除决策）。
 */
export async function probeServeSession({ baseUrl, token, sessionId, fetchImpl = globalThis.fetch, timeoutMs }) {
  const r = await serveRequest({
    baseUrl, token, method: "GET",
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
    fetchImpl, timeoutMs,
  });
  if (r.aborted) return { ok: false, reason: "timeout" };
  if (r.transportError) return { ok: false, reason: "http_error" };
  if (r.code === SERVE_SESSION_GONE_CODE) return { ok: true, gone: true };
  if (r.code !== 0 || !r.data || typeof r.data !== "object") {
    return { ok: false, reason: "upstream_rejected", ...(Number.isInteger(r.code) ? { code: r.code } : {}) };
  }
  return {
    ok: true,
    gone: false,
    workspaceId: typeof r.data.workspace_id === "string" ? r.data.workspace_id : null,
    busy: r.data.busy === true,
  };
}

/**
 * 删除单个会话（sweep --apply 执行原语）。闭集结果与 kimiWeb.releaseSession
 * 的 POST 腿一致（deleted/already_gone/failed{reason[,code]}）。
 */
export async function deleteServeSession({ baseUrl, token, sessionId, fetchImpl = globalThis.fetch, timeoutMs }) {
  const r = await serveRequest({
    baseUrl, token, method: "POST",
    path: `/api/v1/sessions/${encodeURIComponent(sessionId)}:delete`,
    body: {},
    fetchImpl, timeoutMs,
  });
  if (r.aborted) return { outcome: "failed", reason: "timeout" };
  if (r.transportError) return { outcome: "failed", reason: "http_error" };
  if (r.code === SERVE_SESSION_GONE_CODE) return { outcome: "already_gone" };
  if (r.code === 0) return { outcome: "deleted" };
  return { outcome: "failed", reason: "upstream_rejected", ...(Number.isInteger(r.code) ? { code: r.code } : {}) };
}

/** 工作区表（sweep 的 root 判定输入）：id → root 映射。 */
export async function listServeWorkspaces({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs }) {
  const r = await serveRequest({
    baseUrl, token, method: "GET", path: "/api/v1/workspaces", fetchImpl, timeoutMs,
  });
  if (r.aborted) return { ok: false, reason: "timeout" };
  if (r.transportError) return { ok: false, reason: "http_error" };
  if (r.code !== 0 || !Array.isArray(r.data?.items)) {
    return { ok: false, reason: "upstream_rejected", ...(Number.isInteger(r.code) ? { code: r.code } : {}) };
  }
  const items = r.data.items
    .filter((it) => typeof it?.id === "string" && typeof it?.root === "string")
    .map((it) => ({ id: it.id, root: it.root }));
  return { ok: true, items };
}

/**
 * 优雅关停（recycle 的全量拆荚原语）。闭集：{outcome:"requested"}（code 0——
 * 是否完成由调用方轮询端口/进程验证，不靠返回值声称）/ failed{reason}。
 */
export async function shutdownServe({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs }) {
  const r = await serveRequest({
    baseUrl, token, method: "POST", path: "/api/v1/shutdown", body: {}, fetchImpl, timeoutMs,
  });
  if (r.aborted) return { outcome: "failed", reason: "timeout" };
  if (r.transportError) return { outcome: "failed", reason: "http_error" };
  if (r.code === 0) return { outcome: "requested" };
  return { outcome: "failed", reason: "upstream_rejected", ...(Number.isInteger(r.code) ? { code: r.code } : {}) };
}

/**
 * 实例元数据（~/.kimi-code/server/instances/*.json——serve 优雅退出时自清）。
 * 返回 [{serverId, pid, port, startedAt, heartbeatAt}]；目录缺席=空数组。
 */
export function readServeInstances({ kimiHome = join(homedir(), ".kimi-code"), io } = {}) {
  const dir = join(kimiHome, "server", "instances");
  const out = [];
  if (io ? !io.existsSync(dir) : !existsSync(dir)) return out;
  const names = io ? io.readdirSync(dir) : readdirSync(dir);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = io ? io.readFileSync(join(dir, name), "utf8") : readFileSync(join(dir, name), "utf8");
      const parsed = JSON.parse(raw);
      if (Number.isInteger(parsed?.pid) && Number.isInteger(parsed?.port)) {
        out.push({
          serverId: typeof parsed.server_id === "string" ? parsed.server_id : name,
          pid: parsed.pid,
          port: parsed.port,
          startedAt: Number.isInteger(parsed.started_at) ? parsed.started_at : null,
          heartbeatAt: Number.isInteger(parsed.heartbeat_at) ? parsed.heartbeat_at : null,
        });
      }
    } catch {
      // 单个损坏实例文件跳过（fail-open 只对本文件——实例表是运维面非控制面事实）。
    }
  }
  return out;
}

/**
 * serve 名下直接子进程计数（荚规模观察——status/recycle 后验证）。tasklist CSV
 * 无 PPID 列，走 PowerShell CIM 查询；失败返回 -1（观察面不 fail-closed）。
 */
export async function countServeChildren({ pid, execFileFn, timeoutMs = 10000 }) {
  const exec = execFileFn ?? (await import("node:child_process")).execFile;
  return new Promise((resolve) => {
    exec(
      "powershell",
      ["-NoProfile", "-Command",
        `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(pid)}').Count`],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) resolve(-1);
        else {
          const n = Number.parseInt(String(stdout).trim(), 10);
          resolve(Number.isFinite(n) ? n : -1);
        }
      },
    );
  });
}
