// src/owner-dashboard/v2/workersview.js
//
// Draws the Workers page (workers.js's view model) into the page. DOM code: nodes are built with
// createElement + textContent / createTextNode through views.js's h(); nothing here parses markup or reaches
// into worker text — titles, lanes, run numbers and hashes are drawn as plain text, verbatim.
//
// The page is three parts with their own redraw rules, so typing in the search box never rebuilds the box
// itself (a rebuilt input would lose its caret and break an input method mid-word):
//   .wk-filters  the filter controls / labels   — redrawn when they change
//   .wk-search   the search box                 — built once; only its value and words are synced
//   .wk-list     the two groups of worker cards — redrawn when they change

import { claim, chevron, h, mount, symbol } from "./views.js";
import { formatAgo, formatDuration, t, tn } from "./i18n.js";
import { FILTER_ORDER, hasFilters } from "./workers.js";

const WORKERS_MARKER = "workers-page";
const STAGE_WORDS = new Set(["active", "starting", "stage_unknown"]);

// ===== filters =====

/** The word of a filter value: a data name (project name, lane) as sent, else the interface word. */
function valueWord(chip, lang) {
  if (chip.name !== null) return chip.name;
  return t(lang, chip.key === "health" ? `health.${chip.value}` : chip.key === "type" ? `type.${chip.value}` : `wk.status.${chip.value}`);
}

function optionWord(key, option, lang) {
  if (option.name !== null) return option.name;
  return t(lang, key === "health" ? `health.${option.value}` : key === "type" ? `type.${option.value}` : `wk.status.${option.value}`);
}

function chipNode(chip, lang, actions) {
  const label = t(lang, `wk.filter.${chip.key}`);
  return h(
    "span",
    { class: "chip" },
    h("span", { text: t(lang, chip.key === "project" ? "filter.project" : `wk.chip.${chip.key}`, { name: valueWord(chip, lang) }) }),
    h("button", {
      type: "button",
      class: "chip-x",
      "aria-label": `${t(lang, "wk.clear")} (${label})`,
      "data-fk": `chip-clear:${chip.key}`,
      on: { click: () => actions.setFilter(chip.key, null) },
      text: "✕",
    }),
  );
}

function selectNode(key, options, lang, actions) {
  const label = t(lang, `wk.filter.${key}`);
  return h(
    "select",
    {
      class: "wk-select",
      "aria-label": label,
      "data-fk": `sel:${key}`,
      on: { change: (event) => actions.setFilter(key, event.target.value === "" ? null : event.target.value) },
    },
    h("option", { value: "", text: label }),
    options.map((option) => h("option", { value: option.value, text: optionWord(key, option, lang) })),
  );
}

function filterNodes(vm, lang, actions) {
  const chipped = new Map(vm.chips.map((chip) => [chip.key, chip]));
  return FILTER_ORDER.map((key) => (chipped.has(key)
    ? chipNode(chipped.get(key), lang, actions)
    : (vm.options[key].length > 0 ? selectNode(key, vm.options[key], lang, actions) : null)));
}

/** The words of the filter row: the chips and the controls, never the search text (it has its own box). */
const filterSignature = (vm, lang) => JSON.stringify([vm.chips, vm.options, lang]);

// ===== cards =====

function roundText(round, lang) {
  return t(lang, round.complete ? "wk.round" : "wk.roundAtLeast", { n: round.number });
}

/** Line two of a card (words only; the mono parts are marked so they keep their face). */
function lineTwo(card, lang) {
  const parts = [];
  if (card.outcome === null) {
    // "Running 38m" / "Starting 20s" only for a stage the server bound; a run with no bound stage says so
    // and gives no duration (the time since its start would read as the time in a stage nobody observed).
    const stageWord = t(lang, STAGE_WORDS.has(card.stage) ? `wk.stage.${card.stage}` : "wk.stage.other");
    const timed = (card.stage === "active" || card.stage === "starting") && card.runningMs !== null;
    parts.push({ text: timed ? `${stageWord} ${formatDuration(lang, card.runningMs)}` : stageWord });
    parts.push({ text: card.progressAgoMs === null ? t(lang, "wk.noProgress") : t(lang, "wk.lastProgress", { ago: formatAgo(lang, card.progressAgoMs) }) });
    if (card.health === "silent" || card.health === "process_only") parts.push({ text: t(lang, `health.${card.health}`), tone: "amber" });
    return parts;
  }
  const word = t(lang, `wk.out.${card.outcome === "completed" ? "completed" : card.outcome === "stopped" ? "stopped" : "failed"}`);
  parts.push({ text: card.endedAgoMs === null ? word : `${word} ${formatAgo(lang, card.endedAgoMs)}` });
  if (card.failure !== null) parts.push({ text: card.failure, mono: true });
  // A review seat that has answered: its own verdict.
  if (card.q1 !== null) parts.push({ text: card.q1, mono: true, tone: card.q1 === "FIX_FIRST" ? "red" : null });
  const delivery = card.delivery;
  if (delivery !== null) {
    if (delivery.commit !== null) parts.push({ text: delivery.commit, mono: true });
    // The count is the transcript's CLAIM about the delivery (the Git check is the detail's job), so the
    // card says where it comes from; the verification result stays a separate fact beside it.
    if (delivery.changedCount !== null) parts.push({ text: tn(lang, "wk.filesDeclared", delivery.changedCount) });
    if (delivery.verification !== null) parts.push({ text: t(lang, `wk.verify.${delivery.verification}`) });
    if (delivery.problem !== null) parts.push({ text: t(lang, `wk.problem.${delivery.problem}`) });
    if (delivery.decision !== null) parts.push({ text: t(lang, `wk.decision.${delivery.decision}`), tone: delivery.decision === "awaiting" ? "red" : null });
  }
  return parts;
}

function partsNode(parts) {
  const nodes = [];
  parts.forEach((part, index) => {
    if (index > 0) nodes.push(h("span", { class: "dot", "aria-hidden": "true", text: " · " }));
    nodes.push(h("span", { class: [part.mono ? "mono" : "", part.tone ? `tone-${part.tone}` : ""].filter(Boolean).join(" ") || null, text: part.text }));
  });
  return nodes;
}

function cardNode(card, open, lang, actions) {
  const selected = open !== null && open.runId === card.runId;
  return h(
    "li",
    { class: selected ? "wcard wcard-selected" : "wcard" },
    h(
      "button",
      {
        type: "button",
        class: "wcard-btn",
        "aria-pressed": selected ? "true" : "false",
        "data-fk": `card:${card.runId}`,
        on: { click: () => actions.openWorker(card.runId) },
      },
      h(
        "span",
        { class: "wcard-l1" },
        symbol(card.glyph, card.tone === "quiet" ? null : card.tone),
        h(
          "span",
          { class: "wcard-head" },
          h("span", { class: "wcard-title", title: card.title, text: card.title }),
          card.round === null ? null : h("span", { class: "tag", text: roundText(card.round, lang) }),
        ),
        // Type, lane and run number each own a column whose width is set by the English words, so the run
        // number does not move when the language is switched.
        h("span", { class: "wcard-type", text: t(lang, `type.${card.type}`) }),
        h("span", { class: "wcard-lane", title: card.lane, text: card.lane ?? "" }),
        h("span", { class: "wcard-run mono", text: card.runId }),
      ),
      h("span", { class: "wcard-l2" }, partsNode(lineTwo(card, lang))),
    ),
  );
}

function groupNode(entry, open, lang, actions) {
  return h(
    "li",
    { class: "wgroup" },
    h(
      "div",
      { class: "wgroup-head" },
      h("span", { class: "wgroup-title", text: `${t(lang, `type.${entry.type}`)} · ${entry.title}` }),
      h("span", { class: "wgroup-seats mono", text: t(lang, "ov.seats", { in: entry.seatsIn, total: entry.seatsTotal }) }),
    ),
    h("ul", { class: "wgroup-cards" }, entry.cards.map((card) => cardNode(card, open, lang, actions))),
  );
}

function entryNode(entry, open, lang, actions) {
  return entry.kind === "group" ? groupNode(entry, open, lang, actions) : cardNode(entry.card, open, lang, actions);
}

// ===== the list =====

function sectionNode(key, group, hint, extra, open, lang, actions) {
  const list = group.entries.map((entry) => entryNode(entry, open, lang, actions));
  return h(
    "section",
    { class: "section", "data-section": key },
    h(
      "div",
      { class: "section-head" },
      h(
        "h2",
        { class: "section-title" },
        h("span", { text: t(lang, `wk.${key}`) }),
        h("span", { class: "section-count tone-gray" }, h("span", { class: "mono", text: String(group.count) })),
      ),
      h("span", { class: "sort-hint", text: hint }),
    ),
    list.length > 0 ? h("ul", { class: "rows wrows" }, list) : null,
    extra,
    list.length === 0 && extra === null ? h("p", { class: "empty", text: t(lang, key === "running" ? "wk.noneRunning" : "wk.noneFinished") }) : null,
  );
}

function startingNode(starting, open, lang, actions) {
  if (starting.count === 0) return null;
  const expanded = starting.open;
  return h(
    "div",
    { class: "wstarting" },
    h(
      "button",
      { type: "button", class: "disclosure", "aria-expanded": expanded ? "true" : "false", "data-fk": "starting", on: { click: () => actions.toggleStarting() } },
      chevron(expanded),
      h("span", { text: tn(lang, "wk.starting", starting.count) }),
    ),
    expanded ? h("ul", { class: "rows wrows" }, starting.cards.map((card) => cardNode(card, open, lang, actions))) : null,
  );
}

function listNodes(vm, lang, actions) {
  const open = vm.open;
  if (vm.empty === "none") return [h("p", { class: "empty", text: t(lang, "wk.empty.none") }), vm.truncated ? h("p", { class: "note", text: t(lang, "ov.truncated") }) : null];
  return [
    vm.truncated ? h("p", { class: "note", text: t(lang, "ov.truncated") }) : null,
    hasFilters(vm.view) ? h("p", { class: "note wk-matched", text: t(lang, "wk.matched", { n: vm.matched, total: vm.total }) }) : null,
    vm.empty === "filtered" ? h("p", { class: "empty", text: t(lang, "wk.empty.filtered") }) : null,
    vm.empty === "filtered" ? null : sectionNode("running", vm.running, t(lang, "wk.sort.running"), startingNode(vm.starting, open, lang, actions), open, lang, actions),
    vm.empty === "filtered" ? null : sectionNode("finished", vm.finished, t(lang, "wk.sort.finished"), null, open, lang, actions),
  ];
}

// ===== the page =====

function ensureFrame(root, lang, actions) {
  const frame = root.children[0];
  if (root.children.length === 1 && frame?.className === "wk-page") return frame;
  const filters = h("div", { class: "wk-filters", role: "group", "data-keep": true });
  const search = h("input", {
    type: "search",
    class: "wk-search",
    maxlength: "64",
    autocomplete: "off",
    spellcheck: "false",
    "data-fk": "search",
    "data-keep": true,
    on: { input: (event) => actions.setQuery(event.target.value) },
  });
  const list = h("div", { class: "wk-list" });
  const fresh = h(
    "div",
    { class: "wk-page" },
    h("h1", { class: "sr-only", text: t(lang, "nav.workers") }),
    h("div", { class: "wk-top" }, filters, search),
    list,
  );
  root.replaceChildren(fresh);
  claim(root, WORKERS_MARKER);
  return fresh;
}

/** The search box keeps its own text while it is being typed in; it follows the state only when it is not. */
function syncSearch(input, q, lang) {
  input.setAttribute("placeholder", t(lang, "wk.search"));
  input.setAttribute("aria-label", t(lang, "wk.search"));
  if (input.value !== q && document.activeElement !== input) input.value = q;
}

/**
 * Draw the Workers page into `root`. Everything it shows is in the view model: the filters, the search and the
 * open run (they live in the URL fragment) and whether the Starting line is open.
 */
export function renderWorkersPage(root, vm, lang, actions) {
  const frame = ensureFrame(root, lang, actions);
  const [, top, list] = frame.children;
  const [filters, search] = top.children;
  filters.setAttribute("aria-label", t(lang, "wk.filters"));
  filters.className = vm.chips.length > 0 ? "wk-filters wk-filters-chips" : "wk-filters";
  mount(filters, filterSignature(vm, lang), () => filterNodes(vm, lang, actions));
  syncSearch(search, vm.q, lang);
  mount(list, JSON.stringify([vm, lang]), () => listNodes(vm, lang, actions));
}
