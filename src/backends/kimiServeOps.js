// src/backends/kimiServeOps.js
//
// TD-250（决定 0056，2026-10-10）：kimi serve 级运维原语（Lead 侧维护命令的
// backend 层）。API 事实全部来自 2026-10-10 live 探针（依据记录：
// .wao/decisions/0056 + src/backends/kimiWeb.js 文件头 TD-250 节）：
//   - GET  /api/v1/sessions（Bearer；信封 {code,msg,data}；page_size 可传）
//   - GET  /api/v1/sessions/{id}（detail：workspace_id，外加会话活性——2.6 的
//     busy/main_turn_active；2.7.2 改为 activity 闭集 idle|turn|background，
//     2026-11-20 实测，夹具 test/fixtures/kimi-2.7.2/。读取边界统一经
//     projectSessionActivity 投影回 2.6 这一对）
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

// 2.7.2（2026-11-20 实测，test/fixtures/kimi-2.7.2/）会话对象（详情 data 与列表条目）
// 用 activity 闭集取代 2.6 的 busy/main_turn_active。对应关系依据 2.6.3 在后台任务
// 运行、轮已结束时报 busy:true, main_turn_active:false
//（test/fixtures/kimi-2.6.3/background-task-session-detail.json）。
const SESSION_ACTIVITY_FIELDS = Object.freeze({
  idle: Object.freeze({ busy: false, main_turn_active: false }),
  turn: Object.freeze({ busy: true, main_turn_active: true }),
  background: Object.freeze({ busy: true, main_turn_active: false }),
});

/**
 * 读取边界的活性投影：把会话对象（详情 data 或列表条目）统一成 2.6 的
 * busy/main_turn_active 形状——其后的代码照旧读那一对字段。
 *   - 有 activity 字段（2.7）：值是闭集内的**字符串** → 返回补上双字段的副本；
 *     闭集外或非字符串（数组/数字/对象/null——属性键会被 ToPropertyKey 折叠，
 *     例如 ["idle"] → "idle"，必须先卡类型）→ null（形状不认识，调用方 fail-closed）。
 *   - 没有 activity 字段（2.6）：原样返回，2.6 判定逻辑一字不改。
 * 非对象入参同样返回 null（详情/列表探针的在场门本来就会拒）。
 */
export function projectSessionActivity(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) return null;
  if (!Object.prototype.hasOwnProperty.call(session, "activity")) return session;
  if (typeof session.activity !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(SESSION_ACTIVITY_FIELDS, session.activity)) return null;
  const mapped = SESSION_ACTIVITY_FIELDS[session.activity];
  return { ...session, busy: mapped.busy, main_turn_active: mapped.main_turn_active };
}

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
    // TD-261（0063）：连接拒绝单列——"主动拒绝"是唯一可证"此端点无监听"的传输
    // 信号（DNS 失败/超时/其它一律归 http_error 不可证死）。undici 的 OS 错误在
    // error.cause；多地址族失败可能包成 AggregateError（cause.errors[*].code——
    // 全员 ECONNREFUSED 才算，混有其它即不可证死——sol 会审条款）。
    if (isConnectionRefused(error)) return { connectionRefused: true };
    return { transportError: true };
  } finally {
    clearTimeout(timer);
  }
}

// 连接拒绝判定（闭集提取，绝不回显错误文本）：
//   · error.code === "ECONNREFUSED"（直抛形状）
//   · error.cause.code === "ECONNREFUSED"（undici 包装形状）
//   · error.cause 是 AggregateError 且 errors[*].code 全员 ECONNREFUSED
//     （happy-eyeballs 多地址形状——localhost 常见）
function isConnectionRefused(error) {
  const codes = [error?.code, error?.cause?.code];
  if (error?.cause && Array.isArray(error.cause.errors) && error.cause.errors.length > 0) {
    codes.push(...error.cause.errors.map((e) => e?.code));
    // AggregateError 混有非 ECONNREFUSED 子错误 → 整体不可证死。
    if (error.cause.errors.some((e) => e?.code !== "ECONNREFUSED")) return false;
  }
  return codes.some((c) => c === "ECONNREFUSED");
}

/**
 * 会话快照（recycle 门与 status 用）：GET /api/v1/sessions 全量翻页。
 * live 实测（2026-10-11）：page_size 服务端帽=100（>100 → 40001 "Too big"）；
 * 列表 newest-first，`before_id=<上一页末条 id>` 向后翻页，has_more=false 即尽。
 * fail-closed：单页请求非 0 码/形状不符 → upstream_rejected；翻页超帽
 * （20 页=2000 会话，远超本机规模）→ page_overflow 拒绝——不能证明集合完整
 * 就不回收（soak 集合比对的前提是全量视图）。
 * TD-252①（TD-256 批）：archivedOnly=true 走同一端点的归档视图——0057 W2
 * 实测 `sessions:archive` 归档的会话默认列表隐藏、archived_only=true 可见
 * （归档≠不可运行），recycle soak 快照必须两面都拉。
 * 2.7.2 条目用 activity 取代双忙碌字段：逐条在读取边界投影，闭集外 → shape_unknown。
 */
export async function listServeSessions({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs, pageSize = 100, maxPages = 20, archivedOnly = false }) {
  const size = Math.min(Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 100, 100);
  const items = [];
  const seen = new Set();
  let beforeId = undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const r = await serveRequest({
      baseUrl, token, method: "GET",
      path: `/api/v1/sessions?page_size=${size}${beforeId !== undefined ? `&before_id=${encodeURIComponent(beforeId)}` : ""}${archivedOnly ? "&archived_only=true" : ""}`,
      fetchImpl, timeoutMs,
    });
    if (r.aborted) return { ok: false, reason: "timeout" };
    if (r.connectionRefused) return { ok: false, reason: "connection_refused" };
    if (r.transportError) return { ok: false, reason: "http_error" };
    if (r.code !== 0 || !Array.isArray(r.data?.items)) {
      return { ok: false, reason: "upstream_rejected", ...(Number.isInteger(r.code) ? { code: r.code } : {}) };
    }
    // TD-256 验收（sol#3/opus V2-2，注入响应复现）：列表层三种"未知→已知"折叠
    // 全部改为拒判——has_more 非 boolean（不能证明分页完整）、条目缺 id（静默
    // 跳过=集合可能不全）、双忙碌字段全缺（活性不可证≠空闲）。soak/认领门
    // 的前提是全量视图与可证活性，"查不到"不得变成"没问题"。
    if (typeof r.data.has_more !== "boolean") return { ok: false, reason: "shape_unknown" };
    let advanced = false;
    for (const rawItem of r.data.items) {
      // 2.7 条目：activity 在读取边界投影成 busy/main_turn_active；闭集外 → null。
      const it = projectSessionActivity(rawItem);
      if (!it || typeof it?.id !== "string" || it.id.length === 0) return { ok: false, reason: "shape_unknown" };
      if (typeof it?.busy !== "boolean" && typeof it?.main_turn_active !== "boolean") return { ok: false, reason: "shape_unknown" };
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
 * 40401 → {ok:true, gone:true}；busy 投影返回**双字段原值**（TD-251 批 sol 会审
 * 修正：只留 busy===true 会遗漏 main_turn_active 且把字段缺席折叠成 false——
 * 冷会话跨实例可能仍在别的实例跑，双字段任一真即视为忙）。
 * TD-256 批（sol 会审，注入响应实证）：code 0 但双字段**全部缺席**时旧实现仍
 * 折叠成 busy:false——"未知"不得变成"空闲"（sweep 会据此删会话）。修法：
 * 双字段无一为 boolean → shape_unknown 拒判（落 probeFailed=retained 方向）。
 * 2.7.2：detail 的 activity 在读取边界投影成双字段，闭集外 → shape_unknown。
 * 另：投影后还要求 detail 的 id 是非空字符串——缺身份的对象不能证成"这个会话"的
 * 存活/归属（否则 {activity:"idle"} 这类残件会让 sweep 拿到 busy:false）。
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
  const data = projectSessionActivity(r.data);
  if (!data || typeof data.id !== "string" || data.id.length === 0
    || (typeof data.busy !== "boolean" && typeof data.main_turn_active !== "boolean")) {
    return { ok: false, reason: "shape_unknown" };
  }
  return {
    ok: true,
    gone: false,
    workspaceId: typeof data.workspace_id === "string" ? data.workspace_id : null,
    busy: data.busy === true || data.main_turn_active === true,
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
export function readServeInstances({ kimiHome = null, io } = {}) {
  // TD-253：显式 null（调用侧缺省透传）与 undefined 同义——默认家。
  const home = typeof kimiHome === "string" && kimiHome.length > 0 ? kimiHome : join(homedir(), ".kimi-code");
  const dir = join(home, "server", "instances");
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
