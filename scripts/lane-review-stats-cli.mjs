#!/usr/bin/env node
// scripts/lane-review-stats-cli.mjs
//
// Thin entry for scripts/reliability/laneReviewStats.mjs: per-lane review-seat
// statistics for the lane-profile review at the harness inspection close.
//
// Usage: npm run lane-review-stats -- [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//          [--run-dir DIR] [--json] [consultDir ...]
// Run it from the checkout whose runs/ holds the seats' transcripts (the main
// checkout). Without consultDir it reads that checkout's consult record
// directories (defaultConsultDirs), discovers other projects' consult
// directories from the runs/ project buckets, and collects standalone review
// runs (roleId auditor/reviewer with a read-only declaration). With consultDir
// it reads only those directories — no discovery, no standalone collection.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateSeatVerdicts,
  collectConsults,
  collectStandaloneReviews,
  consultSeatRunIds,
  dedupeDirs,
  defaultConsultDirs,
  discoverProjectConsultDirs,
  ratedSeatCount,
  renderLaneReviewStats,
} from "./reliability/laneReviewStats.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const args = process.argv.slice(2);
let since = null;
let until = null;
let runDir = join(ROOT, "runs");
let json = false;
const dirs = [];
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--since" || a === "--until") {
    const value = args[i + 1];
    if (!DATE_RE.test(value ?? "")) {
      console.error(`${a} needs a date YYYY-MM-DD`);
      process.exit(2);
    }
    if (a === "--since") since = value; else until = value;
    i += 1;
  } else if (a === "--run-dir") {
    if (!args[i + 1]) {
      console.error("--run-dir needs a directory");
      process.exit(2);
    }
    runDir = resolve(args[i + 1]);
    i += 1;
  } else if (a === "--json") {
    json = true;
  } else if (a.startsWith("--")) {
    console.error(`unknown option ${a}`);
    process.exit(2);
  } else {
    if (!existsSync(a)) {
      console.error(`consult directory not found: ${a}`);
      process.exit(2);
    }
    dirs.push(resolve(a));
  }
}

const explicitDirs = dirs.length > 0;
const consultDirs = explicitDirs ? dirs : dedupeDirs([...defaultConsultDirs(ROOT), ...discoverProjectConsultDirs(runDir)]);
const consults = await collectConsults({ dirs: consultDirs, runDir, since, until });
// 独立会审的排除面 = 全部会审记录的席位（不限时间窗）：窗外会审的席位也不当独立会审。
const standaloneReviews = explicitDirs
  ? []
  : await collectStandaloneReviews({ runDir, since, until, excludeRunIds: consultSeatRunIds({ dirs: consultDirs }) });
const lanes = aggregateSeatVerdicts(consults, standaloneReviews);
if (json) {
  console.log(JSON.stringify({
    consults: consults.length,
    withTwoPlusRatedSeats: consults.filter((c) => ratedSeatCount(c) >= 2).length,
    standaloneReviews: standaloneReviews.length,
    lanes,
  }, null, 2));
} else {
  console.log(renderLaneReviewStats({ consults, standaloneReviews, lanes }));
}
