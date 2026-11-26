// src/owner-dashboard/v2/sidebarview.js
//
// Draws the worker side panel (detail.js's view model). DOM code, same text-safety rule as every v2 view:
// plain text nodes only. A brief, an answer, a path or a command is drawn as the text the server sent
// (already redacted, folded and bounded there); the panel is read-only — its buttons only open another
// worker, pick a tab, fold a list, or copy a reference.

import { chevron, h, mount, symbol } from "./views.js";
import { formatAgo, formatDuration, t, tn } from "./i18n.js";
import { TABS, activeTab } from "./detail.js";

const MARK_GLYPHS = { done: "✓", current: "●", future: "○", unknown: "?", bad: "▲", ended: "■" };

// ===== axes =====

function stepNode(step, lang, label) {
  return h(
    "li",
    { class: `step step-${step.mark}` },
    h("span", { class: "step-glyph", "aria-hidden": "true", text: MARK_GLYPHS[step.mark] }),
    h("span", { class: "step-label", text: label }),
    h("span", { class: "sr-only", text: ` (${t(lang, `sb.mark.${step.mark}`)})` }),
  );
}

function axisRow(name, steps, lang, notes) {
  return h(
    "div",
    { class: "axis" },
    h("span", { class: "axis-name", text: name }),
    h("ol", { class: "steps" }, steps),
    notes.length > 0 ? h("div", { class: "axis-notes" }, notes) : null,
  );
}

function runAxisNode(axis, lang) {
  const notes = [];
  if (axis.stageUnknown) notes.push(h("span", { class: "tone-amber", text: t(lang, "sb.stageUnknown") }));
  if (axis.startingAgeMs !== null) {
    notes.push(h("span", { class: axis.startingSlow ? "tone-amber" : "muted", text: t(lang, "sb.startingFor", { d: formatDuration(lang, axis.startingAgeMs) }) }));
  }
  return axisRow(t(lang, "sb.axis.run"), axis.steps.map((step) => stepNode(step, lang, t(lang, `sb.step.${step.id}`))), lang, notes);
}

function previousDecisionWord(decision, lang) {
  return t(lang, `sb.prev.${decision === "accepted" || decision === "rejected" || decision === "superseded" ? decision : "pending"}`);
}

function deliveryAxisNode(axis, lang, actions) {
  const steps = axis.steps.map((step) => {
    const label = t(lang, `sb.step.${step.id}`);
    const detail = step.id === "verify" && step.detail !== null && step.detail !== undefined ? ` · ${t(lang, `sb.d.vstatus.${step.detail}`)}` : "";
    return stepNode(step, lang, `${label}${detail}`);
  });
  const notes = [];
  if (axis.problem !== null) notes.push(h("span", { class: "tone-amber", text: t(lang, `sb.delivery.problem.${axis.problem}`) }));
  if (axis.reverify !== null) notes.push(h("span", { class: "muted", text: `${t(lang, "sb.reverify")}: ${axis.reverify}` }));
  return [
    axisRow(t(lang, "sb.axis.delivery"), steps, lang, notes),
    axis.round === null
      ? null
      : h(
        "p",
        { class: "axis-round" },
        h("span", { text: t(lang, axis.round.complete ? "sb.round" : "sb.roundAtLeast", { n: axis.round.number }) }),
        axis.round.continues === null
          ? null
          : [
            h("span", { text: ` · ${t(lang, "sb.continues")} ` }),
            h("button", { type: "button", class: "link-btn mono", "data-fk": "prev-round", on: { click: () => actions.openWorker(axis.round.continues) }, text: axis.round.continues }),
            axis.round.continuesDecision === null ? null : h("span", { text: ` (${previousDecisionWord(axis.round.continuesDecision, lang)})` }),
          ],
      ),
  ];
}

function consultAxisNode(axis, lang, actions) {
  const state = axis.seatState === null ? t(lang, "at.runState.unknown") : t(lang, `at.runState.${["running", "pending", "submitted", "completed", "failed", "aborted", "timed_out"].includes(axis.seatState) ? axis.seatState : "unknown"}`);
  return h(
    "div",
    { class: "axis axis-review" },
    h("span", { class: "axis-name", text: t(lang, "sb.axis.review") }),
    h(
      "div",
      { class: "axis-notes" },
      h("span", { text: t(lang, "sb.review.thisSeat", { state }) }),
      axis.replied === null ? null : h("span", { text: ` · ${t(lang, axis.replied ? "sb.review.replied" : "sb.review.noReply")}` }),
      h("span", { class: "mono", text: ` · ${t(lang, "ov.seats", { in: axis.seatsIn, total: axis.seatsTotal })}` }),
      h("span", { class: axis.complete ? "muted" : "tone-amber", text: ` · ${t(lang, axis.complete ? "sb.review.complete" : "sb.review.incomplete")}` }),
      axis.reviewedRunId === null
        ? null
        : [
          h("span", { text: ` · ${t(lang, "sb.review.reviewed")} ` }),
          h("button", { type: "button", class: "link-btn mono", "data-fk": "reviewed-run", on: { click: () => actions.openWorker(axis.reviewedRunId) }, text: axis.reviewedRunId }),
        ],
    ),
  );
}

// ===== header =====

function failureNode(failure, lang) {
  const rows = [];
  const reason = [failure.category, failure.code].filter((part) => part !== null).join(" · ");
  if (reason !== "") rows.push(h("div", { class: "detail-row" }, h("dt", { text: t(lang, "sb.diag") }), h("dd", { class: "mono", text: reason })));
  const iso = failure.isolation;
  if (iso !== null) {
    for (const [key, value] of [["reason", iso.reason], ["destination", iso.destination], ["reported", iso.reportedPath], ["resolved", iso.resolvedPath], ["escapedAt", iso.escapedAt]]) {
      if (value !== null) rows.push(h("div", { class: "detail-row" }, h("dt", { text: t(lang, `sb.iso.${key}`) }), h("dd", { class: "mono", text: value })));
    }
  }
  for (const entry of failure.evidence) {
    rows.push(h("div", { class: "detail-row" }, h("dt", { class: "mono", text: entry.eventType ?? "" }), h("dd", { class: "evidence-fact", text: entry.fact ?? "" })));
  }
  return rows.length === 0 ? null : h("dl", { class: "detail-list sb-failure" }, rows);
}

function healthWord(health, lang) {
  return health.terminal ? t(lang, `sb.state.${health.word}`) : t(lang, `health.${health.word}`);
}

function headerNodes(vm, lang, actions) {
  const sub = [t(lang, `type.${vm.type}`), vm.lane, vm.projectName].filter((part) => part !== null && part !== "").join(" · ");
  const health = vm.health;
  const healthParts = [healthWord(health, lang)];
  if (health.progressAgoMs !== null) healthParts.push(t(lang, "sb.lastProgress", { ago: formatAgo(lang, health.progressAgoMs) }));
  if (health.heartbeatAgoMs !== null) healthParts.push(t(lang, "sb.lastHeartbeat", { ago: formatAgo(lang, health.heartbeatAgoMs) }));
  return [
    h(
      "div",
      { class: "sb-title-row" },
      h("h2", { class: "sb-title" }, h("span", { text: vm.title }), vm.subtitle === null ? null : h("span", { class: "sb-subtitle", text: vm.subtitle })),
      h("span", { class: "sb-run mono", text: vm.runId }),
      h("button", { type: "button", class: "sb-close", "aria-label": t(lang, "sb.close"), "data-fk": "sb-close", on: { click: () => actions.closeWorker() }, text: "✕" }),
    ),
    h(
      "p",
      { class: "sb-sub" },
      h("span", { text: sub }),
      vm.elapsedMs === null ? null : h("span", { class: "sb-elapsed mono", text: t(lang, health.terminal ? "sb.ranFor" : "sb.runningFor", { d: formatDuration(lang, vm.elapsedMs) }) }),
    ),
    h("p", { class: `sb-health tone-${health.tone}` }, symbol(health.glyph), h("span", { text: healthParts.join(" · ") })),
    health.failure === null ? null : failureNode(health.failure, lang),
    vm.note === null ? null : h("p", { class: "sb-note", role: "status", text: t(lang, `sb.note.${vm.note}`) }),
    vm.stale ? h("p", { class: "sb-note tone-amber", role: "status", text: t(lang, "sb.stale") }) : null,
  ];
}

// ===== tabs =====

function tabsNode(tab, lang, actions) {
  return h(
    "nav",
    { class: "sb-tabs", "aria-label": t(lang, "sb.tabs") },
    TABS.map((id) => h("button", {
      type: "button",
      class: "sb-tab",
      "aria-pressed": tab === id ? "true" : "false",
      "data-fk": `tab:${id}`,
      on: { click: () => actions.setTab(id) },
      text: t(lang, `sb.tab.${id}`),
    })),
  );
}

// ===== Deliverable =====

const sourceWord = (source, lang) => t(lang, source === "system_observed" || source === "worker_reported" ? `sb.d.source.${source}` : "sb.d.source.unknown");

function sectionHead(label, ...extra) {
  return h("h3", { class: "sb-h" }, h("span", { text: label }), extra);
}

function fileRow(file, lang) {
  const stats = file.binary
    ? t(lang, "sb.d.binary")
    : file.added === null || file.deleted === null ? t(lang, "sb.d.noStats") : `+${file.added} −${file.deleted}`;
  return h("li", { class: "file-row" }, h("span", { class: "file-path mono", text: file.path }), h("span", { class: "file-stats mono", text: stats }));
}

function filesNode(files, lang, sui, actions) {
  if (files === null) return null;
  const total = tn(lang, "sb.d.files", files.total);
  const sums = files.added === null ? null : `+${files.added} −${files.deleted}`;
  const open = !files.collapsed || sui.filesOpen === true;
  const list = open ? h("ul", { class: "files" }, files.items.map((file) => fileRow(file, lang))) : null;
  const cut = files.truncated ? h("p", { class: "muted", text: t(lang, "sb.d.filesTruncated", { n: files.items.length, total: files.total }) }) : null;
  if (!files.collapsed) {
    return h("div", { class: "sb-files" }, h("p", { class: "sb-line" }, h("span", { text: total }), sums === null ? null : h("span", { class: "mono", text: ` · ${sums}` })), list, cut);
  }
  return h(
    "div",
    { class: "sb-files" },
    h(
      "button",
      { type: "button", class: "disclosure", "aria-expanded": open ? "true" : "false", "data-fk": "files", on: { click: () => actions.toggleFiles() } },
      chevron(open),
      h("span", { text: total }),
      sums === null ? null : h("span", { class: "mono", text: sums }),
    ),
    list,
    open ? cut : null,
  );
}

function commandRow(command, lang) {
  let result = t(lang, "sb.d.noResult");
  if (command.ran) {
    result = command.timedOut ? t(lang, "sb.d.timedOut") : command.exitCode === null ? t(lang, "sb.d.noResult") : t(lang, "sb.d.exit", { n: command.exitCode });
    if (command.durationMs !== null) result += ` · ${formatDuration(lang, command.durationMs)}`;
  }
  return h("li", { class: "cmd-row" }, h("span", { class: "mono cmd", text: command.command ?? "" }), h("span", { class: "mono cmd-result", text: result }));
}

function verificationNode(verification, lang) {
  if (verification === null) return null;
  const status = verification.status === null ? t(lang, "sb.d.vstatus.none") : t(lang, `sb.d.vstatus.${verification.status}`);
  const tone = verification.status === "failed" || verification.status === "unavailable" ? "tone-amber" : "";
  return h(
    "div",
    { class: "sb-verify" },
    sectionHead(t(lang, "sb.d.verification")),
    h(
      "p",
      { class: "sb-line" },
      h("strong", { class: tone, text: status }),
      verification.boundCommit === null ? null : h("span", { class: "mono", text: ` · ${verification.boundCommit}` }),
    ),
    // Whose word it is, bound to which commit.
    h("p", { class: "muted", text: sourceWord(verification.source, lang) }),
    verification.unavailableReason === null ? null : h("p", { class: "sb-line", text: verification.unavailableReason }),
    verification.failure === null
      ? null
      : h("p", { class: "sb-line tone-amber" }, h("span", { text: `${t(lang, "sb.d.failure")}: ` }), h("span", { class: "mono", text: [verification.failure.code, verification.failure.phase, verification.failure.commandIndex === null ? null : String(verification.failure.commandIndex + 1)].filter((part) => part !== null).join(" · ") })),
    verification.setupCommands.length > 0 ? [h("p", { class: "muted", text: t(lang, "sb.d.setup") }), h("ul", { class: "cmds" }, verification.setupCommands.map((command) => commandRow(command, lang)))] : null,
    verification.commands.length > 0 ? [h("p", { class: "muted", text: t(lang, "sb.d.commands") }), h("ul", { class: "cmds" }, verification.commands.map((command) => commandRow(command, lang)))] : null,
  );
}

function seatRow(seat, scope, lang, actions) {
  const verdict = seat.q1 === null ? t(lang, "sb.d.noVerdict") : seat.q1;
  const state = t(lang, `at.runState.${["running", "pending", "submitted", "completed", "failed", "aborted", "timed_out"].includes(seat.runState) ? seat.runState : "unknown"}`);
  const body = [
    h("span", { class: "seat-lane mono", text: seat.lane ?? "" }),
    h("span", { class: `seat-q1 mono ${seat.q1 === "FIX_FIRST" ? "tone-red" : ""}`.trim(), text: verdict }),
    h("span", { class: "seat-state muted", text: seat.replied === null ? state : `${state} · ${t(lang, seat.replied ? "sb.review.replied" : "sb.review.noReply")}` }),
  ];
  if (seat.runId === null || seat.current) {
    return h("li", { class: "seat-row seat-current" }, body, seat.current ? h("span", { class: "tag", text: t(lang, "sb.d.thisSeat") }) : null);
  }
  return h("li", { class: "seat-row" }, h("button", { type: "button", class: "seat-btn", "data-fk": `seat:${scope}:${seat.runId}`, on: { click: () => actions.openWorker(seat.runId) } }, body));
}

function verdictNotes(group, lang) {
  if (!group.q1Declared) return [h("span", { class: "muted", text: t(lang, "sb.d.noVerdicts") })];
  const notes = [];
  if (group.verdictsDiffer === true) notes.push(h("span", { class: "tag tag-amber", text: t(lang, "sb.d.split") }));
  if (group.anyFixFirst === true) notes.push(h("span", { class: "tag tag-red", text: t(lang, "sb.d.fixFirst") }));
  return notes;
}

function reviewsNode(reviews, lang, actions) {
  if (reviews.length === 0) return null;
  return h(
    "div",
    { class: "sb-reviews" },
    reviews.map((review, index) => h(
      "div",
      { class: "sb-review" },
      sectionHead(t(lang, "sb.d.reviews"), review.consultId === null ? null : h("span", { class: "mono", text: ` ${review.consultId}` })),
      h("p", { class: "sb-line" }, verdictNotes(review, lang), review.afterCurrentDelivery === false ? h("span", { class: "tag", text: t(lang, "sb.d.review.early") }) : null),
      h("ul", { class: "seats" }, review.seats.map((seat) => seatRow(seat, `r${index}`, lang, actions))),
      review.rowsTruncated ? h("p", { class: "muted", text: t(lang, "sb.d.seatsCut") }) : null,
    )),
  );
}

function decisionNode(decision, lang, actions) {
  if (decision === null || decision.result === null) return null;
  const text = t(lang, `sb.d.decision.${decision.result}`);
  return h(
    "p",
    { class: `sb-line sb-decision ${decision.result === "awaiting" ? "tone-red" : ""}`.trim() },
    symbol(decision.result === "awaiting" ? "●" : "✓"),
    h("strong", { text }),
    decision.awaitingForMs === null ? null : h("span", { class: "mono", text: ` · ${formatDuration(lang, decision.awaitingForMs)}` }),
    decision.supersededBy === null ? null : [h("span", { text: " " }), h("button", { type: "button", class: "link-btn mono", "data-fk": "superseded-by", on: { click: () => actions.openWorker(decision.supersededBy) }, text: decision.supersededBy })],
  );
}

function imageNode(image, spec, views, sui, lang, actions) {
  const view = views[spec.id];
  const open = sui.imageOpen === spec.id;
  let body;
  if (view === undefined || view.state === "loading") body = h("span", { class: "muted", text: t(lang, "sb.d.imageLoading") });
  else if (view.state === "failed" || view.url === null) body = h("span", { class: "tone-amber", text: t(lang, "sb.d.imageFailed") });
  else {
    body = h(
      "button",
      { type: "button", class: open ? "thumb-btn thumb-open" : "thumb-btn", "aria-pressed": open ? "true" : "false", "aria-label": t(lang, open ? "sb.d.imageSmaller" : "sb.d.imageBigger"), "data-fk": `thumb:${spec.index}`, on: { click: () => actions.toggleImage(spec.id) } },
      h("img", { class: "thumb", src: view.url, alt: image.path }),
    );
  }
  return h("li", { class: "image-row" }, body, h("span", { class: "file-path mono", text: image.path }));
}

function imagesNode(d, wanted, views, sui, lang, actions) {
  const byIndex = new Map(wanted.map((spec) => [spec.fileIndex, spec]));
  const rows = d.images.filter((image) => image.index !== null && byIndex.has(image.index)).map((image) => imageNode(image, { ...byIndex.get(image.index), index: image.index }, views, sui, lang, actions));
  return h(
    "div",
    { class: "sb-images" },
    sectionHead(t(lang, "sb.d.images")),
    rows.length > 0 ? h("ul", { class: "images" }, rows) : h("p", { class: "muted", text: t(lang, "sb.d.noImages") }),
  );
}

function deliverableNodes(vm, lang, sui, wanted, views, actions) {
  const d = vm.deliverable;
  if (d.kind === "none") return [h("p", { class: "empty", text: t(lang, "sb.d.none") })];
  if (d.kind === "research") {
    return [
      sectionHead(t(lang, "sb.d.answer")),
      h("p", { class: "muted", text: sourceWord(d.answer.source, lang) }),
      h("pre", { class: "sb-text" }, d.answer.text),
      d.answer.truncated ? h("p", { class: "muted", text: t(lang, "sb.d.answerCut", { n: d.answer.keptChars, total: d.answer.totalChars }) }) : null,
    ];
  }
  if (d.kind === "consult") {
    return [
      sectionHead(t(lang, "sb.d.consult"), d.consultId === null ? null : h("span", { class: "mono", text: ` ${d.consultId}` })),
      h("p", { class: "sb-line" }, verdictNotes(d, lang), h("span", { class: "muted", text: ` ${sourceWord("worker_reported", lang)}` })),
      d.reviewedRunId === null
        ? null
        : h("p", { class: "sb-line" }, h("span", { text: `${t(lang, "sb.d.reviewed")}: ` }), h("button", { type: "button", class: "link-btn mono", "data-fk": "reviewed", on: { click: () => actions.openWorker(d.reviewedRunId) }, text: d.reviewedRunId })),
      h("ul", { class: "seats" }, d.seats.map((seat) => seatRow(seat, "c", lang, actions))),
      d.rowsTruncated ? h("p", { class: "muted", text: t(lang, "sb.d.seatsCut") }) : null,
    ];
  }
  // code | image: a git delivery, bound to its commit — Commit, then Verification, then the Lead's decision
  // (and the review beside it), as in the design. An unavailable delivery always says why; with no commit at
  // all (the facts contradict each other) that is ALL there is: it is not "no deliverable".
  const reason = t(lang, `sb.d.unavailable.${["delivery_facts_conflict", "repository_unknown", "git_read_failed"].includes(d.reason) ? d.reason : "other"}`);
  return [
    d.state === "unavailable" ? h("p", { class: "sb-line tone-amber" }, t(lang, d.commit === null ? "sb.d.unavailableNoFacts" : "sb.d.unavailableNote")) : null,
    d.state === "unavailable" ? h("p", { class: "sb-line tone-amber" }, reason) : null,
    d.commit === null ? null : sectionHead(t(lang, "sb.d.commit"), d.commit.short === null ? null : h("span", { class: "mono sb-hash", text: ` ${d.commit.short}` })),
    d.commit === null ? null : h("p", { class: "muted", text: sourceWord(d.commit.source, lang) }),
    filesNode(d.files, lang, sui, actions),
    d.kind === "image" && d.state === "bound" ? imagesNode(d, wanted, views, sui, lang, actions) : null,
    verificationNode(d.verification, lang),
    decisionNode(d.decision, lang, actions),
    reviewsNode(d.reviews, lang, actions),
  ];
}

// ===== the panel =====

function briefNodes(vm, lang) {
  if (!vm.brief.present) return [h("p", { class: "empty", text: t(lang, "sb.brief.missing") })];
  return [
    h("pre", { class: "sb-text" }, vm.brief.text),
    vm.brief.truncated ? h("p", { class: "muted", text: t(lang, "sb.brief.cut", { n: vm.brief.keptChars, total: vm.brief.totalChars }) }) : null,
  ];
}

function footerNode(vm, lang, sui, actions) {
  const copy = sui.copy !== null && sui.copy !== undefined ? sui.copy : null;
  return h(
    "footer",
    { class: "sb-foot" },
    h("code", { class: "ref mono", "data-ref": `worker:${vm.runId}`, text: vm.ref }),
    h("button", { type: "button", class: "btn", "data-fk": "sb-copy", on: { click: () => actions.copyWorkerRef(vm) }, text: t(lang, copy === "ok" ? "at.copied" : "at.copy") }),
    copy === "fail" ? h("span", { class: "copy-status", role: "status", text: t(lang, "at.copyFailed") }) : null,
  );
}

function messageNodes(vm, lang, actions) {
  let key = "sb.error";
  if (vm.message === "loading") key = "sb.loading";
  else if (vm.message === "notFound" || vm.message === "unavailable") key = `sb.${vm.message}`;
  else if (vm.problem === "unauthorized") key = "state.unauthorized";
  return [
    h(
      "div",
      { class: "sb-title-row" },
      h("h2", { class: "sb-title", text: vm.runId }),
      h("button", { type: "button", class: "sb-close", "aria-label": t(lang, "sb.close"), "data-fk": "sb-close", on: { click: () => actions.closeWorker() }, text: "✕" }),
    ),
    vm.note === null ? null : h("p", { class: "sb-note", role: "status", text: t(lang, `sb.note.${vm.note}`) }),
    h("p", { class: "message", role: "status", text: t(lang, key) }),
  ];
}

function detailNodes(vm, lang, sui, wanted, views, actions) {
  const tab = activeTab(sui.tab, vm.defaultTab);
  const axes = [
    runAxisNode(vm.axes.run, lang),
    vm.axes.delivery === null ? null : deliveryAxisNode(vm.axes.delivery, lang, actions),
    vm.axes.consult === null ? null : consultAxisNode(vm.axes.consult, lang, actions),
  ];
  return [
    h("div", { class: "sb-head" }, headerNodes(vm, lang, actions)),
    h("div", { class: "sb-axes" }, axes),
    tabsNode(tab, lang, actions),
    h(
      "div",
      { class: "sb-panel" },
      tab === "activity" ? h("p", { class: "empty", text: t(lang, "sb.activity.soon") }) : null,
      tab === "deliverable" ? deliverableNodes(vm, lang, sui, wanted, views, actions) : null,
      tab === "brief" ? briefNodes(vm, lang) : null,
    ),
    footerNode(vm, lang, sui, actions),
  ];
}

/**
 * Draw the side panel into `root` (an <aside>): hidden and empty while no worker is open. `sui` is
 * { tab, filesOpen, imageOpen, copy }; `wanted` the images the Deliverable needs (detail.imagesWanted) and
 * `views` the image store's view (id -> { state, url }). All of them take part in the signature, so a toggle
 * redraws and a quiet poll does not.
 */
export function renderSidebar(root, vm, lang, sui, wanted, views, actions) {
  if (vm === null) {
    root.setAttribute("hidden", "");
    return mount(root, "closed", () => []);
  }
  root.removeAttribute("hidden");
  root.setAttribute("aria-label", t(lang, "sb.label"));
  return mount(root, JSON.stringify([vm, lang, sui, views]), () => (vm.kind === "detail" ? detailNodes(vm, lang, sui, wanted, views, actions) : messageNodes(vm, lang, actions)));
}
