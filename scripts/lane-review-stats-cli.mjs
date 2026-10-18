#!/usr/bin/env node
// scripts/lane-review-stats-cli.mjs
//
// Thin entry for scripts/reliability/laneReviewStats.mjs: per-lane review-seat statistics from
// consult records, for the lane-profile review at the harness inspection close.
//
// Usage: npm run lane-review-stats -- [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--run-dir DIR]
//          [--json] [consultDir ...]
// Run it from the checkout whose runs/ holds the seats' transcripts (the main checkout). Without
// consultDir it reads that checkout's consult record directories (defaultConsultDirs).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateSeatVerdicts,
  collectConsults,
  defaultConsultDirs,
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

const consults = await collectConsults({ dirs: dirs.length > 0 ? dirs : defaultConsultDirs(ROOT), runDir, since, until });
const lanes = aggregateSeatVerdicts(consults);
if (json) {
  console.log(JSON.stringify({ consults: consults.length, mergeReviews: consults.filter((c) => c.mergeReview).length, lanes }, null, 2));
} else {
  console.log(renderLaneReviewStats({ consults, lanes }));
}
