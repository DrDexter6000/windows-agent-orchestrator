// scripts/reliability/laneReviewStats.mjs
//
// Per-lane review-seat facts from consult records: the input for the lane-profile review at the
// close of the harness inspection (docs/certification-runbook.md; decision 0089). Pure
// aggregation plus a read-only collector; the CLI entry is scripts/lane-review-stats-cli.mjs.
//
// A seat's verdict is the declared Q1 value that WAO's consult field parser (attributeReply +
// compareFields) finds in the seat's final reply, the same reading as `wao consult show`. A seat
// without a parseable Q1 counts as not answered. Merge reviews are consults whose declared Q1
// values include FIX_FIRST; within one, every ordered pair of answered seats is compared by
// FIX_FIRST > PASS_WITH_NOTES > PASS.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { attributeReply, compareFields, observeSeatRun } from "../../src/application/consultService.js";

export const VERDICT_RANK = Object.freeze({ FIX_FIRST: 2, PASS_WITH_NOTES: 1, PASS: 0 });

/**
 * Per-lane counts from collected consults (pure).
 * @param {Array<{mergeReview: boolean, seats: Array<{lane: string, q1: string|null}>}>} consults
 * @returns {Record<string, {seats: number, answered: number, verdicts: Record<string, number>,
 *   stricterThan: Record<string, number>, lenientThan: Record<string, number>, sameAs: Record<string, number>}>}
 */
export function aggregateSeatVerdicts(consults) {
  const per = {};
  const lane = (id) => (per[id] ??= { seats: 0, answered: 0, verdicts: {}, stricterThan: {}, lenientThan: {}, sameAs: {} });
  for (const c of consults) {
    for (const s of c.seats) {
      const L = lane(s.lane);
      L.seats += 1;
      if (typeof s.q1 === "string") {
        L.answered += 1;
        L.verdicts[s.q1] = (L.verdicts[s.q1] ?? 0) + 1;
      }
    }
    if (!c.mergeReview) continue;
    const rated = c.seats.filter((s) => typeof s.q1 === "string" && Object.hasOwn(VERDICT_RANK, s.q1));
    for (const a of rated) {
      for (const b of rated) {
        if (a === b) continue;
        const diff = VERDICT_RANK[a.q1] - VERDICT_RANK[b.q1];
        const L = lane(a.lane);
        const bucket = diff > 0 ? L.stricterThan : diff < 0 ? L.lenientThan : L.sameAs;
        bucket[b.lane] = (bucket[b.lane] ?? 0) + 1;
      }
    }
  }
  return per;
}

/** Consult record directories of a WAO checkout: its own, each dev worktree's, and the archive. */
export function defaultConsultDirs(root) {
  const dirs = [join(root, ".wao", "runs", "consults")];
  const worktrees = join(root, ".dev", "wt");
  if (existsSync(worktrees)) {
    for (const name of readdirSync(worktrees)) dirs.push(join(worktrees, name, ".wao", "runs", "consults"));
  }
  const archive = join(root, "runs-archive");
  if (existsSync(archive)) {
    for (const month of readdirSync(archive)) {
      const base = join(archive, month, "consult-records-dev-worktrees");
      if (existsSync(base)) for (const batch of readdirSync(base)) dirs.push(join(base, batch));
    }
  }
  return dirs.filter((d) => existsSync(d));
}

/**
 * Read consult records (deduplicated by consultId, createdAt in [since, until)) and each seat's
 * Q1 from its run transcript. Read-only; an unreadable record is skipped, an unreadable seat run
 * counts as not answered.
 */
export async function collectConsults({ dirs, runDir, since = null, until = null, observeFn = observeSeatRun }) {
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((n) => /^consult_.*\.json$/.test(n)).sort()) {
      let rec;
      try { rec = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
      const createdAt = typeof rec?.createdAt === "string" ? rec.createdAt : "";
      if (typeof rec?.consultId !== "string" || seen.has(rec.consultId)) continue;
      if ((since && createdAt < since) || (until && createdAt >= until)) continue;
      seen.add(rec.consultId);
      const q1Values = Array.isArray(rec.declaredFields?.Q1) ? rec.declaredFields.Q1 : [];
      const seats = [];
      for (const s of Array.isArray(rec.seats) ? rec.seats : []) {
        let q1 = null;
        try {
          const observed = await observeFn({ runId: s.runId, runDir });
          const { fieldValues } = compareFields({ [s.agentId]: attributeReply(observed?.finalText ?? "") }, { Q1: q1Values });
          q1 = fieldValues.Q1?.[s.agentId] ?? null;
        } catch {
          q1 = null;
        }
        seats.push({ lane: s.agentId, q1 });
      }
      out.push({ consultId: rec.consultId, createdAt, mergeReview: q1Values.includes("FIX_FIRST"), seats });
    }
  }
  return out;
}

/** Plain-text report: one header line, then two lines per lane (pure). */
export function renderLaneReviewStats({ consults, lanes }) {
  const list = (counts) => {
    const parts = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k} ${v}`);
    return parts.length > 0 ? parts.join(", ") : "-";
  };
  const lines = [`consults ${consults.length}, merge reviews ${consults.filter((c) => c.mergeReview).length}`];
  for (const [id, L] of Object.entries(lanes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    lines.push(`${id}: seats ${L.seats}, answered ${L.answered} (${list(L.verdicts)})`);
    lines.push(`  in merge reviews: stricter than ${list(L.stricterThan)}; more lenient than ${list(L.lenientThan)}; same as ${list(L.sameAs)}`);
  }
  return lines.join("\n");
}
