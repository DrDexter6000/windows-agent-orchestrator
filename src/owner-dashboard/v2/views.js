// src/owner-dashboard/v2/views.js
//
// Draws the v2 view models (model.js) into the page. This is the only module with
// DOM code besides app.js.
//
// TEXT SAFETY: nodes are built with createElement + textContent / createTextNode
// and listeners are attached with addEventListener. Nothing here parses markup,
// and nothing here reaches into worker text: whatever the server sent is shown
// as plain text, verbatim.
//
// Re-drawing: each region (top bar, page body) remembers a signature of what it
// drew (view model + language + UI state). When a poll brings nothing new the
// DOM is left alone, so a text selection, a scroll position or a focused button
// survives. When it does change, the focused button is found again by its
// data-fk key and focused again.

import { PAGES } from "./model.js";
import { formatAgo, formatClock, formatDuration, t, tn } from "./i18n.js";

// ===== DOM helpers =====

/**
 * Build one element. props: class, text, on ({event: handler}); null / undefined /
 * false props are skipped; everything else is set as an attribute.
 */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name === "on") {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    } else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export const symbol = (glyph, tone = null) => h("span", { class: tone === null ? "sym" : `sym sym-${tone}`, "aria-hidden": "true", text: glyph });
export const chevron = (open) => h("span", { class: open ? "chev chev-open" : "chev", "aria-hidden": "true" });

/** Add one class name to a node (the fake DOMs of the tests have plain className strings, as do real nodes). */
function addClass(node, name) {
  const classes = new Set(String(node.className ?? "").split(/\s+/).filter(Boolean));
  classes.add(name);
  node.className = [...classes].join(" ");
}

/**
 * The 300 ms "content appeared" fade: applied once, to the children a region drew when it stopped showing
 * its first-load skeleton. A quiet poll does not call it (mount leaves the DOM alone).
 */
export function addContentIn(root) {
  for (const child of root.children ?? []) {
    if (child !== null && typeof child === "object" && child.nodeType === 1) addClass(child, "content-in");
  }
}

const signatures = new WeakMap();

/**
 * Forget a region's last signature. The caller replaced the region's children outside mount() (the
 * Activity tab has its own stable frame); the next mount() must redraw instead of trusting the old value.
 */
export function invalidateRegion(root) {
  signatures.delete(root);
}

function focusedKey(root) {
  const active = document.activeElement;
  if (active === null || active === undefined || !root.contains(active)) return null;
  return active.getAttribute("data-fk");
}

function restoreFocus(root, key) {
  if (key === null) return;
  for (const node of root.querySelectorAll("[data-fk]")) {
    if (node.getAttribute("data-fk") === key) {
      node.focus({ preventScroll: true });
      return;
    }
  }
}

/**
 * The id of the reference text (the code element carrying data-ref) the Owner has selected
 * inside `root` — what the Copy ref fallback leaves selected — else null.
 */
function selectedRefId(root) {
  const selection = typeof window !== "undefined" && typeof window.getSelection === "function" ? window.getSelection() : null;
  if (selection === null || selection === undefined || selection.rangeCount === 0 || selection.isCollapsed) return null;
  if (!root.contains(selection.anchorNode)) return null;
  for (let node = selection.anchorNode; node !== null && node !== undefined && node !== root; node = node.parentNode) {
    const id = typeof node.getAttribute === "function" ? node.getAttribute("data-ref") : null;
    if (id !== null) return id;
  }
  return null;
}

/**
 * Replace the region's content unless it already shows exactly this. Returns true
 * when it redrew. `build` may return nested arrays and empty slots (null / false):
 * they are flattened away here, so the DOM only ever receives real nodes. A redraw keeps
 * the focused button (by its data-fk key) and a selected reference text (by its data-ref id).
 */
export function mount(root, signature, build) {
  if (signatures.get(root) === signature) return false;
  const key = focusedKey(root);
  const selectedRef = selectedRefId(root);
  root.replaceChildren(...build().flat(Infinity).filter((node) => node !== null && node !== undefined && node !== false));
  signatures.set(root, signature);
  restoreFocus(root, key);
  if (selectedRef !== null) selectRefText(root, selectedRef);
  return true;
}

// ===== top bar =====

function freshnessLabel(freshness, lang) {
  if (freshness.kind === "polling") return t(lang, "fresh.polling");
  if (freshness.kind === "loading") return t(lang, "fresh.loading");
  if (freshness.kind === "stale") {
    return freshness.sinceMs === null ? t(lang, "fresh.staleNoTime") : t(lang, "fresh.stale", { time: formatClock(freshness.sinceMs) });
  }
  return "";
}

function badge(kind, count, tone, lang, actions, anim = null) {
  const needs = kind === "needsYou";
  const classes = ["badge", `badge-${kind}`, `badge-${tone}`];
  if (anim !== null) classes.push(`badge-${anim}`);
  return h(
    "button",
    {
      type: "button",
      class: classes.join(" "),
      "data-fk": `top:${kind}`,
      on: { click: () => actions.navigate("attention", null, needs ? "decide" : "anomalies") },
    },
    symbol(needs ? "●" : "▲"),
    h("span", { class: "badge-label", text: t(lang, needs ? "top.needsYou" : "top.alerts") }),
    h("span", { class: "badge-n mono", text: count === null ? "—" : String(count) }),
  );
}

function langButton(code, label, lang, actions) {
  return h("button", {
    type: "button",
    class: "lang-btn",
    "aria-pressed": lang === code ? "true" : "false",
    "data-fk": `lang:${code}`,
    on: { click: () => actions.setLang(code) },
    text: label,
  });
}

const separator = () => h("span", { class: "sep", "aria-hidden": "true", text: "|" });

function topbarNodes(vm, lang, actions, anim) {
  const nav = h(
    "nav",
    { class: "nav", "aria-label": t(lang, "nav.label") },
    PAGES.map((page) => h("button", {
      type: "button",
      class: "nav-btn",
      "aria-current": vm.page === page ? "page" : null,
      "data-fk": `nav:${page}`,
      on: { click: () => actions.navigate(page, null) },
      text: t(lang, `nav.${page}`),
    })),
  );
  const fresh = h("span", { class: `fresh fresh-${vm.freshness.kind} mono`, role: "status", text: freshnessLabel(vm.freshness, lang) });
  const side = h(
    "div",
    { class: "topbar-side" },
    badge("needsYou", vm.counts === null ? null : vm.counts.needsYou, vm.tones.needsYou, lang, actions, anim.needsYou),
    separator(),
    badge("alerts", vm.counts === null ? null : vm.counts.alerts, vm.tones.alerts, lang, actions, anim.alerts),
    separator(),
    fresh,
    separator(),
    h(
      "div",
      { class: "lang", role: "group", "aria-label": t(lang, "lang.label") },
      langButton("en", "EN", lang, actions),
      separator(),
      langButton("zh", "中", lang, actions),
    ),
  );
  return [h("div", { class: "topbar-inner" }, h("span", { class: "brand", text: "WAO" }), nav, side)];
}

/** The count of the last draw, per bar: a +1 bumps (300 ms), a clear recedes (250 ms), the first 200 ms. */
const lastCounts = new WeakMap();

export function renderTopbar(root, vm, lang, actions) {
  const previous = lastCounts.get(root);
  const animFor = (kind, count) => {
    if (count === null || count === undefined) return null;
    if (previous === undefined) return "first";
    const before = previous[kind];
    if (before === null || before === undefined) return "first";
    if (count > before) return "bump";
    if (count === 0 && before > 0) return "clear";
    return null;
  };
  const anim = {
    needsYou: animFor("needsYou", vm.counts === null ? null : vm.counts.needsYou),
    alerts: animFor("alerts", vm.counts === null ? null : vm.counts.alerts),
  };
  const redrew = mount(root, JSON.stringify([vm, lang]), () => topbarNodes(vm, lang, actions, anim));
  if (redrew) {
    lastCounts.set(root, {
      needsYou: vm.counts === null ? null : vm.counts.needsYou,
      alerts: vm.counts === null ? null : vm.counts.alerts,
    });
  }
  return redrew;
}

// ===== shared pieces =====

function filterBar(project, projectName, lang, actions) {
  if (project === null) return null;
  return h(
    "div",
    { class: "filter-bar" },
    h(
      "span",
      { class: "chip" },
      h("span", { text: t(lang, "filter.project", { name: projectName }) }),
      h("button", {
        type: "button",
        class: "chip-x",
        "aria-label": t(lang, "filter.clear"),
        "data-fk": "chip-clear",
        on: { click: () => actions.clearFilter() },
        text: "✕",
      }),
    ),
  );
}

const pageTitle = (lang, page) => h("h1", { class: "sr-only", text: t(lang, `nav.${page}`) });

// ===== Overview =====

/** A count, written "≥ N" when the Workers list was cut (the true number may be higher). */
const countText = (value, lowerBound) => (lowerBound ? `≥ ${value}` : value);

function sinceLine(since, lang) {
  const counts = [
    t(lang, "count.finished", { n: countText(since.finished, since.lowerBound) }),
    t(lang, "count.failed", { n: countText(since.failed, since.lowerBound) }),
  ];
  if (since.stopped > 0) counts.push(t(lang, "count.stopped", { n: countText(since.stopped, since.lowerBound) }));
  const key = since.kind === "first" ? "since.first" : since.truncated ? "since.visitTruncated" : "since.visit";
  return t(lang, key, { ago: formatAgo(lang, since.agoMs), counts: counts.join(" · ") });
}

function marker(tone, glyph, label, focusKey, onClick) {
  return h(
    "button",
    { type: "button", class: `marker marker-${tone}`, "data-fk": focusKey, on: { click: onClick } },
    symbol(glyph),
    h("span", { text: label }),
  );
}

function healthText(entry, lang) {
  const word = t(lang, `health.${entry.health}`);
  return entry.ageMs === null ? word : `${word} ${formatDuration(lang, entry.ageMs)}`;
}

function typeRowNode(row, lang, actions) {
  return h(
    "li",
    { class: "type-row" },
    h("span", { class: "c-type", text: t(lang, `type.${row.type}`) }),
    h("span", { class: "c-count mono", text: String(row.count) }),
    h("span", { class: "c-lanes mono", text: row.lanes.join(", ") }),
    h("span", { class: "c-longest mono", text: row.longestMs === null ? "" : t(lang, "ov.longest", { d: formatDuration(lang, row.longestMs) }) }),
    h(
      "span",
      { class: "c-flags" },
      row.unhealthy.map((entry) => h(
        "span",
        { class: "flag flag-amber" },
        symbol("▲"),
        // The named run opens straight in the Workers side panel.
        h("button", {
          type: "button",
          class: "link-btn mono",
          "data-fk": `run:${entry.runId}`,
          on: { click: () => actions.openWorker(entry.runId) },
          text: entry.runId,
        }),
        h("span", { text: healthText(entry, lang) }),
      )),
      row.seats === null ? null : h("span", { class: "flag flag-muted", text: t(lang, "ov.seats", { in: row.seats.in, total: row.seats.total }) }),
      row.starting > 0 ? h("span", { class: "flag flag-muted", text: t(lang, "ov.startingRow", { n: row.starting }) }) : null,
    ),
  );
}

function projectNode(block, truncated, lang, actions) {
  const name = h(
    "h2",
    { class: "project-name" },
    h("button", {
      type: "button",
      class: "link-btn",
      "data-fk": `proj:${block.slug}`,
      on: { click: () => actions.navigate("workers", block.slug) },
      text: block.name,
    }),
  );
  const markers = h(
    "div",
    { class: "markers" },
    block.decide > 0
      ? marker("red", "●", tn(lang, "ov.needYou", block.decide), `mk:decide:${block.slug}`, () => actions.navigate("attention", block.slug, "decide"))
      : null,
    block.anomalies > 0
      ? marker("amber", "▲", tn(lang, "ov.alert", block.anomalies), `mk:anomalies:${block.slug}`, () => actions.navigate("attention", block.slug, "anomalies"))
      : null,
  );
  if (block.idle) {
    const note = block.lastFinishedAgoMs !== null
      ? t(lang, "ov.idleLast", { ago: formatAgo(lang, block.lastFinishedAgoMs) })
      : t(lang, truncated ? "ov.idle" : "ov.idleNone");
    return h("section", { class: "project project-idle" }, h("div", { class: "project-head" }, name, h("span", { class: "idle-note", text: note }), markers));
  }
  return h(
    "section",
    { class: "project" },
    h("div", { class: "project-head" }, name, markers),
    block.typeRows.length > 0
      ? h("ul", { class: "type-rows" }, block.typeRows.map((row) => typeRowNode(row, lang, actions)))
      : h("p", { class: "idle-note", text: t(lang, "ov.runningNoDetail", { n: block.runningCount }) }),
  );
}

function laneNode(lanes, lang) {
  return h(
    "section",
    { class: "lanes" },
    h("h2", { class: "lanes-title", text: t(lang, "ov.lanes") }),
    h("span", { class: "lanes-use", text: tn(lang, "ov.lanesInUse", lanes.inUse) }),
    lanes.throttled.map((lane) => h(
      "span",
      { class: "flag flag-amber" },
      symbol("▲"),
      h("span", { text: t(lang, lane.quota ? "ov.laneQuota" : "ov.laneThrottled", { lane: lane.laneKey, time: formatClock(lane.observedAtMs) }) }),
    )),
  );
}

function overviewNodes(vm, lang, actions) {
  const parts = [tn(lang, "ov.projects", vm.headline.projects), tn(lang, "ov.running", vm.headline.running)];
  if (vm.headline.starting > 0) parts.push(t(lang, "ov.starting", { n: vm.headline.starting }));
  return [
    pageTitle(lang, "overview"),
    h(
      "section",
      { class: "summary" },
      h("p", { class: "headline", text: parts.join(" · ") }),
      h("p", { class: "since", text: sinceLine(vm.since, lang) }),
      vm.truncated ? h("p", { class: "note", text: t(lang, "ov.truncated") }) : null,
    ),
    vm.blocks.length === 0 ? h("p", { class: "empty", text: t(lang, "ov.empty") }) : null,
    vm.blocks.map((block) => projectNode(block, vm.truncated, lang, actions)),
    vm.lanes === null ? null : laneNode(vm.lanes, lang),
  ];
}

// ===== Attention =====

const KIND_KEYS = new Set([
  "consult_split", "verification_failed", "verification_unavailable", "delivery_ambiguous", "awaiting_decision",
  "quota_exhausted", "failed", "silent", "process_only", "rate_limited",
]);

const kindLabel = (kind, lang) => t(lang, KIND_KEYS.has(kind) ? `kind.${kind}` : "kind.other");

function detailRow(label, ...value) {
  return h("div", { class: "detail-row" }, h("dt", { text: label }), h("dd", {}, ...value));
}

/** The involved worker's run number opens its side panel; the title and lane stay text. */
function workerLine(worker, actions) {
  return h(
    "div",
    { class: "worker-line" },
    h("button", {
      type: "button",
      class: "link-btn mono",
      "data-fk": `open:${worker.runId}`,
      on: { click: () => actions.openWorker(worker.runId) },
      text: worker.runId,
    }),
    worker.title === null ? null : h("span", { text: ` · ${worker.title}` }),
    worker.lane === null ? null : h("span", { class: "mono", text: ` · ${worker.lane}` }),
  );
}

function evidenceLine(entry, lang) {
  return h(
    "div",
    { class: "evidence-line" },
    h("span", { class: "mono", text: entry.code }),
    entry.atMs === null ? null : h("span", { class: "mono", text: ` · ${formatClock(entry.atMs)}` }),
    entry.hasSeq ? null : h("span", { class: "muted", text: ` · ${t(lang, "at.noSeq")}` }),
  );
}

function detailNode(item, detailId, lang, ui, actions) {
  const copy = ui.copy !== null && ui.copy.id === item.id ? ui.copy.result : null;
  const rows = [];
  if (item.projects.length > 0) rows.push(detailRow(t(lang, "at.d.project"), item.projects.map((project) => project.name).join(", ")));
  if (item.commit !== undefined) {
    // Delivery items only: the short commit as the transcript bound it; "unknown" when it cannot be told uniquely.
    rows.push(detailRow(t(lang, "at.d.commit"), item.commit === null ? t(lang, "at.unknown") : h("span", { class: "mono", text: item.commit })));
  }
  if (item.workers.length > 0) {
    rows.push(detailRow(
      t(lang, "at.d.workers"),
      item.workers.map((worker) => workerLine(worker, actions)),
      item.moreWorkers > 0 ? h("div", { class: "muted", text: t(lang, "at.more", { n: item.moreWorkers }) }) : null,
    ));
  }
  if (item.laneKey !== null) {
    rows.push(detailRow(t(lang, "at.d.lane"), h("span", { class: "mono", text: item.capacityCode === null ? item.laneKey : `${item.laneKey} · ${item.capacityCode}` })));
  }
  if (item.failure !== null && (item.failure.category !== null || item.failure.code !== null)) {
    rows.push(detailRow(t(lang, "at.d.reason"), h("span", { class: "mono", text: [item.failure.category, item.failure.code].filter((part) => part !== null).join(" · ") })));
  }
  if (item.followUp !== null) {
    rows.push(detailRow(
      t(lang, "at.d.followUp"),
      followUpText(item, lang),
      item.followUpRuns.map((entry) => h("div", { class: "worker-line" }, h("span", { class: "mono", text: entry.runId }), h("span", { text: ` · ${runStateText(entry.state, lang)}` }))),
    ));
  }
  if (item.sinceMs !== null) {
    rows.push(detailRow(t(lang, "at.d.since"), h("span", { class: "mono", text: formatClock(item.sinceMs) })));
  }
  if (item.durationMs !== null) rows.push(detailRow(t(lang, "at.d.duration"), formatDuration(lang, item.durationMs)));
  rows.push(detailRow(t(lang, "at.d.involved"), String(item.involved)));
  if (item.evidence.length > 0) {
    rows.push(detailRow(t(lang, "at.d.evidence"), item.evidence.map((entry) => evidenceLine(entry, lang))));
  }
  if (item.section === "resolved" && item.resolvedAgoMs !== null) {
    rows.push(detailRow(t(lang, "at.d.resolved"), formatAgo(lang, item.resolvedAgoMs)));
  }
  rows.push(detailRow(t(lang, "at.d.ref"), h("code", { class: "ref mono", "data-ref": item.id, text: item.ref })));
  return h(
    "div",
    { class: "row-detail", id: detailId },
    h("dl", { class: "detail-list" }, rows),
    h(
      "div",
      { class: "detail-actions" },
      h("button", {
        type: "button",
        class: "btn",
        "data-fk": `copy:${item.id}`,
        on: { click: () => actions.copyRef(item) },
        text: t(lang, copy === "ok" ? "at.copied" : "at.copy"),
      }),
      copy === "fail" ? h("span", { class: "copy-status", role: "status", text: t(lang, "at.copyFailed") }) : null,
    ),
  );
}

const LANE_KIND_SET = new Set(["quota_exhausted", "rate_limited"]);
const RUN_STATE_KEYS = new Set(["running", "pending", "submitted", "completed", "failed", "aborted", "timed_out"]);

const runStateText = (state, lang) => t(lang, RUN_STATE_KEYS.has(state) ? `at.runState.${state}` : "at.runState.unknown");

/** "no follow-up" / "follow-up unknown" / "follow-up: failed" (the state of the latest follow-up run). */
function followUpText(item, lang) {
  if (item.followUp === null) return null;
  if (item.followUp === "exists") return t(lang, "at.followUp.exists", { state: runStateText(item.followUpRuns.at(-1)?.state ?? null, lang) });
  return t(lang, `at.followUp.${item.followUp}`);
}

/**
 * The right-hand line of a collapsed row.
 *   resolved  how it ended · how long ago
 *   alerts    projects · lane · run · follow-up (only where the server states one) · duration
 *             — a lane item (quota / throttled) is about the lane, not one run: its title already
 *             names the lane, so it shows projects · affected workers · duration instead
 *   needs you projects · workers involved (if several) · duration
 * Nothing is made up: a kind without a follow-up fact shows none.
 */
function itemMeta(item, lang) {
  const names = item.projects.map((project) => project.name).join(", ");
  const duration = item.durationMs === null ? null : formatDuration(lang, item.durationMs);
  if (item.section === "resolved") {
    const how = item.resolution === null ? null : t(lang, `at.res.${item.resolution}`);
    return [how, item.resolvedAgoMs === null ? null : formatAgo(lang, item.resolvedAgoMs)].filter((part) => part !== null).join(" · ");
  }
  const several = item.involved > 1 ? tn(lang, "at.involved", item.involved) : null;
  if (item.section === "anomalies" && !LANE_KIND_SET.has(item.kind)) {
    const worker = item.workers[0];
    return [
      names,
      worker?.lane ?? null,
      worker === undefined ? null : worker.runId,
      followUpText(item, lang),
      duration,
    ].filter((part) => part !== null && part !== "").join(" · ");
  }
  return [names, several, duration].filter((part) => part !== null && part !== "").join(" · ");
}
function itemRow(item, index, lang, ui, actions, isNew = false) {
  const selected = ui.selected === item.id;
  const detailId = `detail-${item.section}-${index}`;
  const [tone, glyph] = item.section === "decide" ? ["red", "●"] : item.section === "anomalies" ? ["amber", "▲"] : ["gray", "✓"];
  const title = item.headline === null ? kindLabel(item.kind, lang) : `${kindLabel(item.kind, lang)} · ${item.headline}`;
  const classes = ["item"];
  if (selected) classes.push("item-selected");
  // Mask reveal (650 ms) only for a row that appeared after the previous draw.
  if (isNew) classes.push("item-new");
  return h(
    "li",
    { class: classes.join(" ") },
    h(
      "button",
      {
        type: "button",
        class: "item-btn",
        "aria-expanded": selected ? "true" : "false",
        "aria-controls": selected ? detailId : null,
        "data-fk": `item:${item.id}`,
        on: { click: () => actions.select(item.id) },
      },
      h("span", { class: `sym sym-${tone}`, "aria-hidden": "true", text: glyph }),
      h(
        "span",
        { class: "item-title" },
        h("span", { text: title }),
        item.state === "unknown" ? h("span", { class: "tag", text: t(lang, "at.unconfirmed") }) : null,
      ),
      h("span", { class: "item-meta mono", text: itemMeta(item, lang) }),
      chevron(selected),
    ),
    selected ? detailNode(item, detailId, lang, ui, actions) : null,
  );
}

function disclosure(label, open, focusKey, onClick) {
  return h(
    "button",
    { type: "button", class: "disclosure", "aria-expanded": open ? "true" : "false", "data-fk": focusKey, on: { click: onClick } },
    chevron(open),
    h("span", { text: label }),
  );
}

function sectionNode(kind, section, lang, ui, actions, fresh) {
  const decide = kind === "decide";
  const tone = section.total === 0 ? "gray" : decide ? "red" : "amber";
  const open = ui.legacyOpen[kind] === true;
  const isNew = (item) => fresh.has(`${item.section}:${item.id}`);
  const list = [];
  section.items.forEach((item, index) => list.push(itemRow(item, index, lang, ui, actions, isNew(item))));
  if (section.legacy.length > 0) {
    list.push(h(
      "li",
      { class: "legacy" },
      disclosure(t(lang, "at.legacy", { n: section.legacy.length }), open, `legacy:${kind}`, () => actions.toggleLegacy(kind)),
      open ? h("ul", { class: "rows rows-nested" }, section.legacy.map((item, index) => itemRow(item, section.items.length + index, lang, ui, actions, isNew(item)))) : null,
    ));
  }
  return h(
    "section",
    { class: `section section-${decide ? "red" : "amber"}`, "data-section": kind },
    h(
      "div",
      { class: "section-head" },
      h(
        "h2",
        // tabindex -1: focusable by code only (focusSection), never a tab stop.
        { class: "section-title", tabindex: "-1", "data-section-title": kind },
        h("span", { text: t(lang, decide ? "at.needsYou" : "at.alerts") }),
        h("span", { class: `section-count tone-${tone}` }, symbol(decide ? "●" : "▲"), h("span", { class: "mono", text: String(section.total) })),
      ),
      h("span", { class: "sort-hint", text: t(lang, decide ? "at.sort.decide" : "at.sort.anomalies") }),
    ),
    list.length > 0 ? h("ul", { class: "rows" }, list) : h("p", { class: "empty", text: t(lang, decide ? "at.empty.decide" : "at.empty.anomalies") }),
  );
}

function attentionNodes(vm, lang, ui, actions, fresh) {
  return [
    pageTitle(lang, "attention"),
    filterBar(vm.project, vm.projectName, lang, actions),
    sectionNode("decide", vm.decide, lang, ui, actions, fresh),
    sectionNode("anomalies", vm.anomalies, lang, ui, actions, fresh),
    h(
      "section",
      { class: "section section-resolved" },
      disclosure(t(lang, "at.resolved", { n: vm.resolved.length }), ui.resolvedOpen, "resolved", () => actions.toggleResolved()),
      ui.resolvedOpen ? h("ul", { class: "rows" }, vm.resolved.map((item, index) => itemRow(item, index, lang, ui, actions, fresh.has(`${item.section}:${item.id}`)))) : null,
    ),
  ];
}

// ===== page body =====

function messageNodes(vm, lang) {
  return [
    // The first load shows same-shaped placeholder blocks (150 ms in, a 160 px band sweeping every 900 ms)
    // under the status text; the data itself replaces them and fades in over 300 ms (addContentIn).
    vm.kind === "loading" ? skeletonNodes() : null,
    h("p", { class: "message", role: "status", text: t(lang, `state.${vm.kind}`) }),
  ];
}

/** Same-shaped grey blocks for the first load; the sweeping band is CSS only. */
export function skeletonNodes() {
  return h(
    "div",
    { class: "sk-set", "aria-hidden": "true" },
    h("div", { class: "sk sk-title" }),
    h("div", { class: "sk sk-line" }),
    h("div", { class: "sk sk-line sk-short" }),
    h("div", { class: "sk sk-block" }),
    h("div", { class: "sk sk-line" }),
    h("div", { class: "sk sk-line sk-short" }),
  );
}

/** The Attention rows the last draw put on screen (only a row that was not there animates). */
const attentionSeen = new WeakMap();

function attentionKeys(vm) {
  const keys = new Set();
  for (const section of ["decide", "anomalies"]) {
    for (const item of [...vm[section].items, ...vm[section].legacy]) keys.add(`${item.section}:${item.id}`);
  }
  for (const item of vm.resolved) keys.add(`${item.section}:${item.id}`);
  return keys;
}

/**
 * Draw the page body of Overview, Attention or a message (the Workers page is workersview.js's
 * renderWorkersPage: it keeps its search box alive between draws). `ui` is
 * { selected, legacyOpen: {decide, anomalies}, resolvedOpen, copy }; it takes part in the signature,
 * so a toggle redraws and a quiet poll does not.
 */
export function renderMain(root, vm, lang, ui, actions) {
  if (vm.page === "attention") {
    const previous = attentionSeen.get(root);
    const keys = attentionKeys(vm);
    const fresh = new Set();
    if (previous !== undefined) for (const key of keys) if (!previous.has(key)) fresh.add(key);
    const redrew = mount(root, JSON.stringify([vm, lang, ui]), () => attentionNodes(vm, lang, ui, actions, fresh));
    if (redrew) attentionSeen.set(root, keys);
    return redrew;
  }
  return mount(root, JSON.stringify([vm, lang, ui]), () => {
    if (vm.page === "overview") return overviewNodes(vm, lang, actions);
    return messageNodes(vm, lang);
  });
}

/**
 * Mark `root` as holding something other than a drawn page (the Workers page builds its own children), so
 * the next renderMain of a page it had drawn before cannot mistake the stale DOM for its own.
 */
export function claim(root, marker) {
  signatures.set(root, marker);
}

/** Put the focus on a worker card (the browser scrolls it into view); false when it is not drawn. */
export function focusCard(root, runId) {
  for (const node of root.querySelectorAll("[data-fk]")) {
    if (node.getAttribute("data-fk") === `card:${runId}`) {
      node.focus();
      return true;
    }
  }
  return false;
}

/**
 * Land on one part of the Attention page (decide = Needs you, anomalies = Alerts): focus its
 * heading, which also scrolls it into view. Returns false when that part is not drawn.
 */
export function focusSection(root, section) {
  for (const node of root.querySelectorAll("[data-section-title]")) {
    if (node.getAttribute("data-section-title") === section) {
      node.focus();
      return true;
    }
  }
  return false;
}

/** Select the copied-reference text of an item (the fallback when the clipboard refuses). */
export function selectRefText(root, itemId) {
  for (const node of root.querySelectorAll("[data-ref]")) {
    if (node.getAttribute("data-ref") !== itemId) continue;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  return false;
}
