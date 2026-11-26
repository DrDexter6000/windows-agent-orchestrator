// src/owner-dashboard/v2/i18n.js
//
// The v2 string table (English and Chinese) and the formatting that needs it.
// No DOM, no globals: importable from Node.
//
// Only interface text lives here. Project names, task titles, worker output,
// event codes, commit hashes, run numbers and the references copied for the Lead
// are data: they never pass through this table, so they read identically in both
// languages. Templates therefore carry no placeholder for any of them.
//
// Lookup: unknown language -> English; a key missing from the chosen language ->
// the English text; a key missing everywhere -> the key itself (a visible
// marker, never a crash). English decides the widths of the grid; Chinese sits
// left-aligned in the same grid (see styles.css).

export const LANGS = Object.freeze(["en", "zh"]);
export const DEFAULT_LANG = "en";
export const LANG_STORAGE_KEY = "wao_v2_lang";

const EN = {
  "nav.label": "Main navigation",
  "nav.overview": "Overview",
  "nav.workers": "Workers",
  "nav.attention": "Attention",
  "top.needsYou": "Needs you",
  "top.alerts": "Alerts",
  "fresh.loading": "Loading…",
  "fresh.polling": "Polling 5s",
  "fresh.stale": "Stale since {time}",
  "fresh.staleNoTime": "Stale",
  "lang.label": "Language",

  "state.loading": "Loading…",
  "state.unavailable": "No data yet: the server has not been able to read the run directory.",
  "state.noToken": "Open this page from the dashboard link; the link carries the access token.",
  "state.unauthorized": "The access token was rejected. Open the dashboard link again.",
  "state.network": "Cannot reach the dashboard server.",
  "state.server": "The dashboard server returned an unusable answer.",

  "ov.projects.one": "{n} project",
  "ov.projects.other": "{n} projects",
  "ov.running.one": "{n} worker running",
  "ov.running.other": "{n} workers running",
  "ov.starting": "{n} starting",
  "ov.truncated": "Only the most recent workers were returned; the rows below may be incomplete.",
  "ov.empty": "No projects yet.",
  "since.visit": "Since your last visit ({ago}): {counts}",
  "since.visitTruncated": "Since your last visit ({ago}; only the last 24h are counted): {counts}",
  "since.first": "No earlier visit on record · last 24h: {counts}",
  "count.finished": "{n} finished",
  "count.failed": "{n} failed",
  "count.stopped": "{n} stopped",
  "ov.needYou.one": "{n} needs you",
  "ov.needYou.other": "{n} need you",
  "ov.alert.one": "{n} alert",
  "ov.alert.other": "{n} alerts",
  "ov.longest": "longest {d}",
  "ov.startingRow": "{n} starting",
  "ov.seats": "{in} of {total} seats in",
  "ov.runningNoDetail": "{n} running",
  "ov.idle": "idle",
  "ov.idleLast": "idle · last run finished {ago}",
  "ov.idleNone": "idle · no run finished in the last 24h",
  "health.silent": "silent",
  "health.process_only": "process only",
  "ov.lanes": "Lanes",
  "ov.lanesInUse.one": "{n} in use",
  "ov.lanesInUse.other": "{n} in use",
  "ov.laneThrottled": "{lane} throttled, last seen {time}",
  "ov.laneQuota": "{lane} quota exhausted, last seen {time}",
  "type.research": "Research",
  "type.code": "Coding",
  "type.test": "Testing",
  "type.plan_review": "Plan review",
  "type.delivery_review": "Delivery review",
  "type.image": "Image",
  "type.untyped": "Untyped",

  "workers.soon": "Coming in the next batch.",
  "filter.project": "Project: {name}",
  "filter.clear": "Clear filter",

  "at.needsYou": "Needs you",
  "at.alerts": "Alerts",
  "at.sort.decide": "involved workers › duration",
  "at.sort.anomalies": "no follow-up running › severity › duration",
  "at.empty.decide": "Nothing needs your decision.",
  "at.empty.anomalies": "No alerts.",
  "at.legacy": "Older than 7 days ({n})",
  "at.resolved": "Resolved in last 24h ({n})",
  "at.involved.one": "{n} worker",
  "at.involved.other": "{n} workers",
  "at.d.project": "Project",
  "at.d.workers": "Workers",
  "at.d.since": "Since",
  "at.d.duration": "Lasting",
  "at.d.involved": "Involved workers",
  "at.d.evidence": "Observed from",
  "at.d.reason": "Reason",
  "at.d.lane": "Lane",
  "at.d.followUp": "Follow-up",
  "at.d.resolved": "Resolved",
  "at.d.ref": "Reference",
  "at.d.commit": "Delivery version",
  "at.unknown": "unknown",
  "at.noSeq": "no event number",
  "at.more": "+{n} more",
  "at.followUp.exists": "follow-up: {state}",
  "at.followUp.none": "no follow-up",
  "at.followUp.unknown": "follow-up unknown",
  "at.runState.running": "running",
  "at.runState.pending": "starting",
  "at.runState.submitted": "starting",
  "at.runState.completed": "completed",
  "at.runState.failed": "failed",
  "at.runState.aborted": "stopped",
  "at.runState.timed_out": "timed out",
  "at.runState.unknown": "state unknown",
  "at.unconfirmed": "unconfirmed",
  "at.res.decided": "decided by the Lead",
  "at.res.superseded": "superseded",
  "at.res.reverify_passed": "re-verification passed",
  "at.res.later_success": "a later run succeeded",
  "at.copy": "Copy ref",
  "at.copied": "Copied",
  "at.copyFailed": "Copy failed. The reference is selected: press Ctrl+C.",

  "kind.consult_split": "Delivery review split",
  "kind.verification_failed": "Verification failed",
  "kind.verification_unavailable": "Verification unavailable",
  "kind.delivery_ambiguous": "Delivery unclear",
  "kind.awaiting_decision": "Awaiting Lead decision",
  "kind.quota_exhausted": "Lane quota exhausted",
  "kind.failed": "Failed",
  "kind.silent": "Silent",
  "kind.process_only": "Process only",
  "kind.rate_limited": "Lane throttled",
  "kind.other": "Other",

  "dur.lt1m": "<1m",
  "dur.m": "{m}m",
  "dur.h": "{h}h",
  "dur.hm": "{h}h {m}m",
  "dur.d": "{d}d",
  "dur.dh": "{d}d {h}h",
  "ago": "{d} ago",
  "ago.now": "just now",
};

const ZH = {
  "nav.label": "主导航",
  "nav.overview": "总览",
  "nav.workers": "工作列表",
  "nav.attention": "需要关注",
  "top.needsYou": "需要你",
  "top.alerts": "异常",
  "fresh.loading": "载入中…",
  "fresh.polling": "轮询 5 秒",
  "fresh.stale": "过期自 {time}",
  "fresh.staleNoTime": "数据过期",
  "lang.label": "语言",

  "state.loading": "载入中…",
  "state.unavailable": "暂时没有数据：服务端还没能读到运行目录。",
  "state.noToken": "请从看板给出的链接打开本页；链接里带着访问令牌。",
  "state.unauthorized": "访问令牌被拒绝，请重新打开看板链接。",
  "state.network": "连不上看板服务。",
  "state.server": "看板服务返回了无法使用的内容。",

  "ov.projects.one": "{n} 个项目",
  "ov.projects.other": "{n} 个项目",
  "ov.running.one": "{n} 个 worker 运行中",
  "ov.running.other": "{n} 个 worker 运行中",
  "ov.starting": "{n} 个启动中",
  "ov.truncated": "只返回了最近的一部分 worker，下面各行可能不完整。",
  "ov.empty": "还没有项目。",
  "since.visit": "上次来访（{ago}）后：{counts}",
  "since.visitTruncated": "上次来访（{ago}；只统计最近 24 小时）后：{counts}",
  "since.first": "没有更早的来访记录 · 最近 24 小时：{counts}",
  "count.finished": "完成 {n} 项",
  "count.failed": "失败 {n} 项",
  "count.stopped": "停止 {n} 项",
  "ov.needYou.one": "{n} 项需要你",
  "ov.needYou.other": "{n} 项需要你",
  "ov.alert.one": "{n} 项异常",
  "ov.alert.other": "{n} 项异常",
  "ov.longest": "最长 {d}",
  "ov.startingRow": "{n} 个启动中",
  "ov.seats": "已到 {in} / {total} 席",
  "ov.runningNoDetail": "{n} 个运行中",
  "ov.idle": "空闲",
  "ov.idleLast": "空闲 · 上次运行结束于 {ago}",
  "ov.idleNone": "空闲 · 最近 24 小时没有运行结束",
  "health.silent": "静默",
  "health.process_only": "仅进程在动",
  "ov.lanes": "车道",
  "ov.lanesInUse.one": "{n} 条在用",
  "ov.lanesInUse.other": "{n} 条在用",
  "ov.laneThrottled": "{lane} 限流，最近观测于 {time}",
  "ov.laneQuota": "{lane} 额度用尽，最近观测于 {time}",
  "type.research": "调研",
  "type.code": "写代码",
  "type.test": "测试",
  "type.plan_review": "方案会审",
  "type.delivery_review": "交付会审",
  "type.image": "生图",
  "type.untyped": "未分类",

  "workers.soon": "下一批提供。",
  "filter.project": "项目：{name}",
  "filter.clear": "清除筛选",

  "at.needsYou": "需要你",
  "at.alerts": "异常",
  "at.sort.decide": "牵涉 worker 数 › 持续时长",
  "at.sort.anomalies": "没有在跑的后续 › 严重度 › 持续时长",
  "at.empty.decide": "没有需要你拿主意的事项。",
  "at.empty.anomalies": "没有异常。",
  "at.legacy": "超过 7 天的遗留事项（{n}）",
  "at.resolved": "近 24 小时已了结（{n}）",
  "at.involved.one": "{n} 个 worker",
  "at.involved.other": "{n} 个 worker",
  "at.d.project": "项目",
  "at.d.workers": "关联 worker",
  "at.d.since": "起于",
  "at.d.duration": "已持续",
  "at.d.involved": "牵涉 worker",
  "at.d.evidence": "观测依据",
  "at.d.reason": "原因",
  "at.d.lane": "车道",
  "at.d.followUp": "后续",
  "at.d.resolved": "了结",
  "at.d.ref": "引用",
  "at.d.commit": "交付版本",
  "at.unknown": "未知",
  "at.noSeq": "缺事件号",
  "at.more": "另有 {n} 个",
  "at.followUp.exists": "后续：{state}",
  "at.followUp.none": "无后续",
  "at.followUp.unknown": "后续未知",
  "at.runState.running": "运行中",
  "at.runState.pending": "启动中",
  "at.runState.submitted": "启动中",
  "at.runState.completed": "已完成",
  "at.runState.failed": "失败",
  "at.runState.aborted": "已停止",
  "at.runState.timed_out": "超时",
  "at.runState.unknown": "状态未知",
  "at.unconfirmed": "未确认",
  "at.res.decided": "Lead 已裁决",
  "at.res.superseded": "已被取代",
  "at.res.reverify_passed": "复验通过",
  "at.res.later_success": "后来有运行成功",
  "at.copy": "复制引用",
  "at.copied": "已复制",
  "at.copyFailed": "复制失败，引用已选中，请按 Ctrl+C。",

  "kind.consult_split": "交付会审结论分裂",
  "kind.verification_failed": "验证失败",
  "kind.verification_unavailable": "无法验证",
  "kind.delivery_ambiguous": "交付状态不明",
  "kind.awaiting_decision": "等待 Lead 裁决",
  "kind.quota_exhausted": "车道额度用尽",
  "kind.failed": "失败",
  "kind.silent": "静默",
  "kind.process_only": "仅进程在动",
  "kind.rate_limited": "车道限流",
  "kind.other": "其他",

  "dur.lt1m": "不到 1 分钟",
  "dur.m": "{m} 分钟",
  "dur.h": "{h} 小时",
  "dur.hm": "{h} 小时 {m} 分钟",
  "dur.d": "{d} 天",
  "dur.dh": "{d} 天 {h} 小时",
  "ago": "{d}前",
  "ago.now": "刚刚",
};

export const STRINGS = Object.freeze({ en: Object.freeze(EN), zh: Object.freeze(ZH) });

export const isLang = (value) => LANGS.includes(value);
export const resolveLang = (value) => (isLang(value) ? value : DEFAULT_LANG);

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

/** Fill {name} placeholders; a placeholder without a value stays as written. */
function fill(template, params) {
  if (params === undefined || params === null) return template;
  return template.replace(PLACEHOLDER_RE, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

/** The text for a key in a language (with the fallbacks described at the top). */
export function t(lang, key, params) {
  const table = STRINGS[resolveLang(lang)];
  let template = key;
  if (Object.hasOwn(table, key)) template = table[key];
  else if (Object.hasOwn(STRINGS.en, key)) template = STRINGS.en[key];
  return fill(template, params);
}

/** A counted text: key.one for exactly 1, key.other for everything else; {n} is filled. */
export function tn(lang, base, n, params) {
  return t(lang, n === 1 ? `${base}.one` : `${base}.other`, { n, ...params });
}

/** A span of time in whole minutes ("38m", "2h 5m", "3d"); an unreadable span is a dash. */
export function formatDuration(lang, ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return t(lang, "dur.lt1m");
  if (minutes < 60) return t(lang, "dur.m", { m: minutes });
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? t(lang, "dur.h", { h: hours }) : t(lang, "dur.hm", { h: hours, m: restMinutes });
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? t(lang, "dur.d", { d: days }) : t(lang, "dur.dh", { d: days, h: restHours });
}

/** "3h ago" / "3 小时前"; under a minute reads "just now". An unreadable span is a dash. */
export function formatAgo(lang, ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 60000) return t(lang, "ago.now");
  return t(lang, "ago", { d: formatDuration(lang, ms) });
}

/** Local wall-clock HH:MM of an epoch-ms value; unreadable -> "--:--". Same in both languages. */
export function formatClock(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "--:--";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "--:--";
  const two = (n) => String(n).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}
