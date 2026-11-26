// src/owner-dashboard/v2/activityview.js
//
// Draws the Activity tab (activity.js's view model) into the side panel. DOM code, same text-safety rule
// as every v2 view: plain text nodes only. Rows, seq numbers, paths, commands and outputs are drawn as
// the server sent them (already redacted, folded and bounded there); nothing here parses markup.
//
// The tab lives in stable slots: the filter, the notes, the list, the "older" note and the stream status
// are separate nodes. The list is updated row by row by its key — a new row is appended, a row whose
// content changed is replaced, everything else keeps its DOM node, so a poll that only changes the count
// (or adds one event at the bottom) never destroys a text selection or the scroll position.
//
// The rows are drawn in four columns — #seq / time / type code / summary — aligned like the design; a
// state change is the same four cells on a rule across the whole row; a gap / an unloaded hole is a line
// of its own. Only rows that are new since the previous draw carry the 120 ms fade (`act-in`).

import { chevron, h, mount } from "./views.js";
import { formatClock, formatClockSeconds, t, tn } from "./i18n.js";
import { msOf } from "./model.js";
import { ACTIVITY_FILTERS, activityRangeLabel, activityRef, activitySeqLabel } from "./activity.js";

const RT_WORDS = new Set(["initialized", "streaming", "provider_retry", "process_active", "files_changed", "serve_active"]);
const rtWord = (status, lang) => t(lang, RT_WORDS.has(status) ? `sb.a.rt.${status}` : "sb.a.rt.unknown");

/** The stable pieces of one Activity host: created once, updated independently afterwards. */
const frames = new WeakMap();
/** The signature of a row's rendered content, and the list's rows, so unchanged rows are kept. */
const rowSignatures = new WeakMap();

const timeText = (iso) => formatClockSeconds(msOf(iso));

const classOf = (node, name) => typeof node.className === "string" && node.className.split(" ").includes(name);
const removeClass = (node, name) => {
  if (!classOf(node, name)) return;
  node.className = node.className.split(" ").filter((cls) => cls !== "" && cls !== name).join(" ");
};

/** The seq range a row covers, for the anchor fallback and the "is this really new?" fade rule. */
const validRange = (seq) => Number.isInteger(seq) && seq > 0;
const rangeOf = (row) => {
  if (row.row === "event") return validRange(row.seq) ? { from: row.seq, to: row.seq } : null;
  return validRange(row.fromSeq) && validRange(row.toSeq) ? { from: row.fromSeq, to: row.toSeq } : null;
};
const rangeAttrs = (row) => {
  const range = rangeOf(row);
  return range === null ? {} : { "data-range-from": range.from, "data-range-to": range.to };
};

/** Does a row's range overlap anything that was already on screen before this draw? */
const overlapsPrevious = (row, ranges) => {
  const range = rangeOf(row);
  if (range === null) return false;
  return ranges.some((old) => old.from <= range.to && range.from <= old.to);
};

/** The first descendant carrying this focus key (the same search works in a real DOM and a fake one). */
function findByFocusKey(node, key) {
  if (typeof node.getAttribute === "function" && node.getAttribute("data-fk") === key) return node;
  for (const child of node.children ?? []) {
    if (child instanceof Object && child.nodeType === 1) {
      const found = findByFocusKey(child, key);
      if (found !== null) return found;
    }
  }
  return null;
}

// ===== cells =====

function seqCell(row, runId, actions) {
  if (row.row === "fold" || row.row === "gap" || row.row === "unloaded") {
    return h("span", { class: "act-seq mono", text: activityRangeLabel(row.fromSeq, row.toSeq) ?? "#?" });
  }
  if (row.seqState !== "ok" || !Number.isInteger(row.seq)) {
    return h("span", { class: "act-seq mono", text: row.seq === null ? "#?" : activitySeqLabel(row.seq) });
  }
  const ref = activityRef(runId, row.seq);
  return h("button", {
    type: "button",
    class: "act-seq act-seq-btn mono",
    title: ref,
    "data-fk": `act-seq:${row.key}`,
    on: { click: () => actions.copyEventCode(runId, row.seq, row.key) },
    text: activitySeqLabel(row.seq),
  });
}

const tagNodes = (row, lang) => [
  row.seqState === "missing" ? h("span", { class: "tag", text: t(lang, "at.noSeq") }) : null,
  row.seqState === "conflict" ? h("span", { class: "tag tag-amber", text: t(lang, "sb.a.seqConflict") }) : null,
];

/** A message: its first lines (the server's own excerpt) or the full text once it has been asked for. */
function messageBody(row, lang, actions) {
  if (row.full !== null) return fullBlock(row, lang, actions);
  const lines = Array.isArray(row.body?.head) ? row.body.head : [];
  const total = Number.isInteger(row.body?.totalLines) ? row.body.totalLines : lines.length;
  return h(
    "div",
    { class: "act-msg" },
    lines.map((line) => h("div", { class: "act-line", text: line })),
    row.truncated || total > lines.length
      ? h(
        "button",
        { type: "button", class: "act-more", "data-fk": `act-full:${row.key}`, on: { click: () => actions.openActivityFull(row.key) }, text: t(lang, "sb.a.more") },
      )
      : null,
  );
}

/** An output / error output: a line count folded, head + tail + total when open. */
function outputBody(row, lang, actions) {
  if (row.full !== null) return fullBlock(row, lang, actions);
  const body = row.body ?? {};
  const total = Number.isInteger(body.totalLines) ? body.totalLines : 0;
  if (!row.expanded) {
    return h(
      "button",
      { type: "button", class: "act-fold-btn", "aria-expanded": "false", "data-fk": `act-open:${row.key}`, on: { click: () => actions.toggleActivityRow(row.key) } },
      chevron(false),
      h("span", { text: tn(lang, "sb.a.lines", total) }),
    );
  }
  const head = Array.isArray(body.head) ? body.head : [];
  const tail = Array.isArray(body.tail) ? body.tail : [];
  return h(
    "div",
    { class: "act-out" },
    h(
      "button",
      { type: "button", class: "act-fold-btn", "aria-expanded": "true", "data-fk": `act-open:${row.key}`, on: { click: () => actions.toggleActivityRow(row.key) } },
      chevron(true),
      h("span", { text: tn(lang, "sb.a.lines", total) }),
    ),
    head.map((line) => h("div", { class: "act-line", text: line })),
    body.omittedLines === null
      ? h("p", { class: "act-omitted muted", text: t(lang, "sb.a.omittedUnknown") })
      : body.omittedLines > 0
        ? h("p", { class: "act-omitted muted", text: t(lang, "sb.a.omitted", { n: body.omittedLines }) })
        : null,
    tail.length > 0 ? h("div", { class: "act-tail" }, tail.map((line) => h("div", { class: "act-line", text: line }))) : null,
    row.truncated
      ? h("button", { type: "button", class: "act-more", "data-fk": `act-full:${row.key}`, on: { click: () => actions.openActivityFull(row.key) }, text: t(lang, "sb.a.openFull") })
      : null,
  );
}

/** Errors are always open (the server's error line and its full text); there is no collapse control. */
function errorBody(row, isolation, lang, actions) {
  if (row.full !== null) return fullBlock(row, lang, actions);
  return h(
    "div",
    { class: "act-err" },
    h("div", { class: "act-line", text: row.summary }),
    row.phase === null ? null : h("p", { class: "act-omitted muted" }, h("span", { text: `${t(lang, "sb.a.phase")} ` }), h("span", { class: "mono", text: row.phase })),
    row.text === undefined || row.text === "" || row.text === row.summary ? null : h("pre", { class: "act-pre mono", text: row.text }),
    row.truncated ? h("button", { type: "button", class: "act-more", "data-fk": `act-full:${row.key}`, on: { click: () => actions.openActivityFull(row.key) }, text: t(lang, "sb.a.openFull") }) : null,
    isolation,
  );
}

/** The isolation fields of an error (the same closed projection the detail's diagnosis uses). */
function isolationNode(fields, lang) {
  if (fields === null || typeof fields !== "object") return null;
  const rows = [];
  for (const [key, label] of [["reason", "sb.iso.reason"], ["destination", "sb.iso.destination"], ["reportedPath", "sb.iso.reported"], ["resolvedPath", "sb.iso.resolved"], ["escapedAt", "sb.iso.escapedAt"]]) {
    if (typeof fields[key] === "string" && fields[key] !== "") {
      rows.push(h("div", { class: "detail-row" }, h("dt", { text: t(lang, label) }), h("dd", { class: "mono", text: fields[key] })));
    }
  }
  return rows.length === 0 ? null : h("dl", { class: "detail-list act-isolation" }, rows);
}

/** The close / paging controls of an opened full text (always present, even for one page or a failure). */
function fullPager(row, lang, actions) {
  const full = row.full;
  const ready = full.state === "ready";
  const busy = full.state === "loading";
  const total = Number.isInteger(full.totalPages) ? full.totalPages : null;
  // While a page is loading the buttons stay focusable (no disabled): replacing the row must be able to
  // put the keyboard focus back on the same data-fk control. The feed ignores a second click while busy.
  const prevDisabled = busy ? null : (ready ? full.page <= 1 : true);
  const nextDisabled = busy ? null : (ready ? (total === null || full.page >= total) : true);
  return h(
    "div",
    { class: "act-pager", "aria-busy": busy ? "true" : null },
    h("button", {
      type: "button",
      class: "act-page-btn",
      disabled: prevDisabled ? true : null,
      "data-fk": `act-prev:${row.key}`,
      on: { click: () => actions.activityFullPage(row.key, -1) },
      text: t(lang, "sb.a.prev"),
    }),
    h("span", { class: "act-page mono", text: Number.isInteger(full.page) && (ready || total !== null) ? t(lang, "sb.a.page", { n: full.page, total: total ?? "?" }) : "" }),
    h("button", {
      type: "button",
      class: "act-page-btn",
      disabled: nextDisabled ? true : null,
      "data-fk": `act-next:${row.key}`,
      on: { click: () => actions.activityFullPage(row.key, 1) },
      text: t(lang, "sb.a.next"),
    }),
    h("button", {
      type: "button",
      class: "act-page-btn",
      "data-fk": `act-close-full:${row.key}`,
      on: { click: () => actions.closeActivityFull(row.key) },
      text: t(lang, "sb.a.closeFull"),
    }),
  );
}

/** An opened full text (one page at a time; the route's own page count). It REPLACES the row's summary. */
function fullBlock(row, lang, actions) {
  const full = row.full;
  if (full.state === "loading") {
    return h("div", { class: "act-full-block" }, h("p", { class: "muted", text: t(lang, "sb.a.fullLoading") }), fullPager(row, lang, actions));
  }
  if (full.state === "failed") {
    return h("div", { class: "act-full-block" }, h("p", { class: "tone-amber", text: t(lang, "sb.a.fullFailed") }), fullPager(row, lang, actions));
  }
  return h(
    "div",
    { class: "act-full-block" },
    h("pre", { class: "act-pre mono act-full-text", text: full.text }),
    fullPager(row, lang, actions),
  );
}

function eventBody(row, lang, actions) {
  if (row.code === "MSG") return messageBody(row, lang, actions);
  if (row.code === "OUT") return outputBody(row, lang, actions);
  if (row.code === "ERR") return errorBody(row, isolationNode(row.isolation, lang), lang, actions);
  if (row.code === "WRITE") {
    const stats = Number.isInteger(row.added) && Number.isInteger(row.deleted) ? `+${row.added} −${row.deleted}` : t(lang, "sb.a.writeUnknown");
    return h("div", { class: "act-summary" }, h("span", { class: "act-path mono", text: row.path ?? "" }), h("span", { class: "act-stats mono", text: ` · ${stats}` }));
  }
  if (row.code === "CMD") {
    // Once the full command has been fetched it replaces the one-line summary (not shown beside it).
    if (row.full !== null) return fullBlock(row, lang, actions);
    return h(
      "div",
      { class: "act-summary" },
      h("span", { class: "mono", text: row.summary }),
      Number.isInteger(row.exitCode) ? h("span", { class: "mono act-exit", text: ` · ${t(lang, "sb.d.exit", { n: row.exitCode })}` }) : null,
      row.truncated
        ? h("button", { type: "button", class: "act-more", "data-fk": `act-full:${row.key}`, on: { click: () => actions.openActivityFull(row.key) }, text: t(lang, "sb.a.openFull") })
        : null,
    );
  }
  return h("div", { class: "act-summary" }, h("span", { text: row.code === "TOOL" ? row.summary : "" }));
}

// ===== rows =====

function rowSignature(row, lang) {
  return JSON.stringify([row, lang]);
}

function eventRow(row, runId, lang, actions, fresh) {
  return h(
    "li",
    { class: `act-row${fresh ? " act-in" : ""}`, "data-act-key": row.key, ...rangeAttrs(row) },
    h("div", { class: "act-c act-c1" }, seqCell(row, runId, actions)),
    h("div", { class: "act-c act-c2 mono", text: timeText(row.ts) }),
    h("div", { class: "act-c act-c3" }, h("span", { class: "act-code mono", text: row.code })),
    h("div", { class: "act-c act-c4" }, tagNodes(row, lang), eventBody(row, lang, actions)),
  );
}

function stateRow(row, runId, lang, actions, fresh) {
  const label = row.from === null ? row.to : `${row.from} → ${row.to}`;
  return h(
    "li",
    { class: `act-row act-state${fresh ? " act-in" : ""}`, "data-act-key": row.key, ...rangeAttrs(row) },
    h("div", { class: "act-c act-c1" }, seqCell(row, runId, actions)),
    h("div", { class: "act-c act-c2 mono", text: timeText(row.ts) }),
    h("div", { class: "act-c act-c3" }, h("span", { class: "act-code mono", text: row.code })),
    h("div", { class: "act-c act-c4" }, h("span", { text: label }), row.reason === null ? null : h("span", { class: "muted", text: ` · ${row.reason}` }), tagNodes(row, lang)),
  );
}

function foldRow(row, lang, fresh) {
  return h(
    "li",
    { class: `act-row act-fold${fresh ? " act-in" : ""}`, "data-act-key": row.key, ...rangeAttrs(row) },
    h("div", { class: "act-c act-c1" }, h("span", { class: "act-seq mono", text: activityRangeLabel(row.fromSeq, row.toSeq) ?? "#?" })),
    h("div", { class: "act-c act-c2 mono", text: timeText(row.fromTs) }),
    h("div", { class: "act-c act-c3" }, h("span", { class: "act-code mono", text: row.code })),
    h(
      "div",
      { class: "act-c act-c4" },
      h("span", { class: "act-fold-sum mono", text: `▸ ${tn(lang, "sb.a.rtEvents", row.count)}` }),
      h("span", { class: "muted", text: ` · ${rtWord(row.status, lang)}` }),
      tagNodes(row, lang),
    ),
  );
}

function gapRow(row, lang, fresh) {
  return h(
    "li",
    { class: `act-gap${fresh ? " act-in" : ""}`, "data-act-key": row.key, ...rangeAttrs(row) },
    h("span", { class: "act-gap-text mono" }, h("span", { text: activityRangeLabel(row.fromSeq, row.toSeq) ?? "" }), h("span", { text: ` ${t(lang, "sb.a.missing")}` })),
  );
}

/** A hole the catch-up did not reach: it says which range is missing and offers a fresh reload. */
function unloadedRow(row, lang, actions, fresh) {
  return h(
    "li",
    { class: `act-unloaded${fresh ? " act-in" : ""}`, "data-act-key": row.key, ...rangeAttrs(row) },
    h(
      "span",
      { class: "act-unloaded-text mono" },
      h("span", { text: t(lang, "sb.a.unloadedPrefix") }),
      h("span", { text: activityRangeLabel(row.fromSeq, row.toSeq) ?? "" }),
      h("span", { text: ` ${t(lang, "sb.a.unloaded")}` }),
    ),
    h("button", {
      type: "button",
      class: "act-reload-btn",
      "data-fk": `act-reload:${row.key}`,
      on: { click: () => actions.reloadActivity() },
      text: t(lang, "sb.a.reload"),
    }),
  );
}

function rowNode(row, runId, lang, actions, fresh) {
  if (row.row === "gap") return gapRow(row, lang, fresh);
  if (row.row === "unloaded") return unloadedRow(row, lang, actions, fresh);
  if (row.row === "fold") return foldRow(row, lang, fresh);
  if (row.code === "STATE") return stateRow(row, runId, lang, actions, fresh);
  return eventRow(row, runId, lang, actions, fresh);
}

// ===== the tab's stable slots =====

function ensureFrame(host) {
  const current = frames.get(host);
  if (current !== undefined && host.children.length === 1 && host.children[0] === current.root) return current;
  const filter = h("div", { class: "act-filter-slot" });
  const hidden = h("div", { class: "act-hidden-slot" });
  const problem = h("div", { class: "act-problem-slot" });
  const empty = h("div", { class: "act-empty-slot" });
  const list = h("ol", { class: "act-list", "data-act-list": "" });
  const older = h("div", { class: "act-older-slot" });
  const stream = h("div", { class: "act-stream-slot" });
  const root = h("div", { class: "act" }, filter, hidden, problem, h("div", { class: "act-scroll" }, empty, list, older), stream);
  host.replaceChildren(root);
  const frame = { root, filter, hidden, problem, empty, list, older, stream, nodes: new Map(), keys: new Set(), ranges: [], runId: null };
  frames.set(host, frame);
  return frame;
}

/**
 * Update only the rows that changed, by key:
 *   - an unchanged row keeps its node (a text selection inside it survives);
 *   - a changed row is replaced, and if the keyboard focus was inside it the same `data-fk` control is
 *     focused again in the new row;
 *   - a new row is inserted (and gets the 120 ms fade only when its seq range is really new — a row
 *     that was merely merged, extended or given a new key does not replay it);
 *   - rows after a replacement are not re-inserted.
 */
function syncRows(frame, vm, lang, actions) {
  if (frame.runId !== vm.runId) {
    frame.nodes = new Map();
    frame.keys = new Set();
    frame.ranges = [];
    frame.runId = vm.runId;
    frame.list.replaceChildren();
  }
  const previousKeys = frame.keys;
  const previousRanges = frame.ranges;
  const nextNodes = new Map();
  let changed = false;
  const desired = vm.rows.map((row) => {
    const signature = rowSignature(row, lang);
    const existing = frame.nodes.get(row.key);
    if (existing !== undefined && rowSignatures.get(existing) === signature) {
      removeClass(existing, "act-in"); // the fade belongs to the draw that added it, not to a later poll
      nextNodes.set(row.key, existing);
      return existing;
    }
    const fresh = !previousKeys.has(row.key) && !overlapsPrevious(row, previousRanges);
    const node = rowNode(row, vm.runId, lang, actions, fresh);
    rowSignatures.set(node, signature);
    nextNodes.set(row.key, node);
    changed = true;
    return node;
  });
  // Capture the keyboard focus before removing a replaced row, then find the same control in the new row.
  const focusToRestore = [];
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (active !== null && active !== undefined && typeof active.getAttribute === "function") {
    for (const [key, oldNode] of frame.nodes) {
      if (nextNodes.get(key) === oldNode) continue;
      if (typeof oldNode.contains === "function" && oldNode.contains(active)) {
        const focusKey = active.getAttribute("data-fk");
        if (focusKey !== null) focusToRestore.push([key, focusKey]);
      }
    }
  }
  // Remove the nodes that are gone or replaced; the rows after them are not touched.
  for (const [key, oldNode] of frame.nodes) {
    if (nextNodes.get(key) !== oldNode && oldNode.parentNode === frame.list) {
      frame.list.removeChild(oldNode);
      changed = true;
    }
  }
  // Place the desired nodes. A node already at its position is not moved or re-inserted.
  for (let index = 0; index < desired.length; index += 1) {
    const node = desired[index];
    if (frame.list.children[index] === node) continue;
    frame.list.insertBefore(node, frame.list.children[index] ?? null);
    changed = true;
  }
  while (frame.list.children.length > desired.length) {
    frame.list.removeChild(frame.list.children[desired.length]);
    changed = true;
  }
  for (const [key, focusKey] of focusToRestore) {
    const node = nextNodes.get(key);
    const target = node === undefined ? null : findByFocusKey(node, focusKey);
    if (target !== null) target.focus({ preventScroll: true });
  }
  frame.nodes = nextNodes;
  frame.keys = new Set(vm.rows.map((row) => row.key));
  frame.ranges = vm.rows.map(rangeOf).filter((range) => range !== null);
  return changed;
}

function filterRow(vm, lang, actions) {
  const buttons = [];
  for (const filter of ACTIVITY_FILTERS) {
    if (buttons.length > 0) buttons.push(h("span", { class: "act-dot", "aria-hidden": "true", text: " · " }));
    buttons.push(h("button", {
      type: "button",
      class: "act-filter-btn",
      "aria-pressed": vm.filter === filter ? "true" : "false",
      "data-fk": `act-filter:${filter}`,
      on: { click: () => actions.setActivityFilter(filter) },
      text: t(lang, `sb.a.filter.${filter}`),
    }));
  }
  return h("div", { class: "act-filter", role: "group", "aria-label": t(lang, "sb.a.filters") }, buttons);
}

function streamNode(vm, lang, sui, actions) {
  const copy = sui.eventCopy ?? null;
  const showWaiting = !vm.following && (vm.newCount > 0 || vm.newCountExact === false);
  return h(
    "div",
    { class: "act-stream" },
    h("span", { class: `act-follow${vm.following ? "" : " act-paused"}` }, h("span", { "aria-hidden": "true", text: vm.following ? "● " : "❚❚ " }), h("span", { text: t(lang, vm.following ? "sb.a.following" : "sb.a.paused") })),
    showWaiting
      ? h("button", {
        type: "button",
        class: "act-new-btn",
        "data-fk": "act-resume",
        on: { click: () => actions.resumeActivity() },
        text: t(lang, vm.newCountExact === false ? "sb.a.newEventsPlus" : "sb.a.newEvents", { n: vm.newCount }),
      })
      : null,
    vm.newCountExact === false && !vm.following
      ? h("span", { class: "muted act-new-note", text: t(lang, "sb.a.newEventsHole") })
      : null,
    h("span", { class: `act-status mono act-status-${vm.freshness.kind}`, role: "status", text: statusText(vm, lang) }),
    copy === null
      ? null
      : copy.result === "ok"
        ? h("span", { class: "copy-status", role: "status", text: t(lang, "at.copied") })
        // The clipboard refused: the full reference is shown (and selected by the app) so Ctrl+C works.
        : h(
          "span",
          { class: "copy-status" },
          h("span", { text: `${t(lang, "at.copyFailed")} ` }),
          h("code", { class: "ref mono", "data-ref": `event-copy:${copy.key}`, text: copy.ref }),
        ),
  );
}

function statusText(vm, lang) {
  if (vm.freshness.kind === "ended") return t(lang, "sb.a.ended", { n: vm.total });
  if (vm.freshness.kind === "stale") return vm.freshness.sinceMs === null ? t(lang, "fresh.staleNoTime") : t(lang, "fresh.stale", { time: formatClock(vm.freshness.sinceMs) });
  if (vm.freshness.kind === "polling") return t(lang, "fresh.polling");
  return t(lang, vm.problem === "unauthorized" ? "state.unauthorized" : "fresh.loading");
}

function olderNote(vm, lang) {
  if (vm.older === null || vm.older.available === true || vm.older.reason === null) return null;
  const key = vm.older.reason === "unnumbered" ? "sb.a.olderUnnumbered" : vm.older.reason === "capped" ? "sb.a.olderCapped" : null;
  return key === null ? null : h("p", { class: "muted act-older", text: t(lang, key) });
}

function problemNode(vm, lang) {
  if (vm.phase !== "error") return null;
  return h("p", { class: "message", role: "status", text: t(lang, vm.problem === "notFound" ? "sb.notFound" : vm.problem === "unauthorized" ? "state.unauthorized" : vm.problem === "network" ? "state.network" : "state.server") });
}

/**
 * Draw / update the Activity tab inside `host`. The filter, notes, list and stream are separate slots:
 * only the slot whose content changed is redrawn, and the list keeps every unchanged row's DOM node.
 *
 * @returns {boolean} true when something visible changed
 */
export function renderActivity(host, vm, lang, sui, actions) {
  const frame = ensureFrame(host);
  let changed = false;
  changed = mount(frame.filter, JSON.stringify(["filter", vm.filter, lang]), () => [filterRow(vm, lang, actions)]) || changed;
  const hidden = vm.filter !== "all" && vm.hiddenFiltered > 0
    ? h("p", { class: "muted act-hidden", text: t(lang, "sb.a.filtered", { n: vm.hiddenFiltered }) })
    : null;
  changed = mount(frame.hidden, JSON.stringify(["hidden", vm.filter, vm.hiddenFiltered, lang]), () => (hidden === null ? [] : [hidden])) || changed;
  const problem = problemNode(vm, lang);
  changed = mount(frame.problem, JSON.stringify(["problem", vm.phase, vm.problem, lang]), () => (problem === null ? [] : [problem])) || changed;
  const empty = vm.phase === "ready" && vm.rows.length === 0 ? h("p", { class: "empty", text: t(lang, "sb.a.empty") }) : null;
  changed = mount(frame.empty, JSON.stringify(["empty", vm.phase, vm.rows.length, lang]), () => (empty === null ? [] : [empty])) || changed;
  changed = syncRows(frame, vm, lang, actions) || changed;
  const older = olderNote(vm, lang);
  changed = mount(frame.older, JSON.stringify(["older", vm.older, lang]), () => (older === null ? [] : [older])) || changed;
  changed = mount(
    frame.stream,
    JSON.stringify(["stream", vm.following, vm.pausedBy, vm.newCount, vm.freshness, vm.total, sui.eventCopy, lang]),
    () => [streamNode(vm, lang, sui, actions)],
  ) || changed;
  return changed;
}
