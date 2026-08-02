#!/usr/bin/env node
// bin/wao.js — global `wao` command entry (M12-8F).
//
// package.json `bin` target. A one-time `npm link` from the WAO development
// repository creates a global `wao` command that ALWAYS executes the linked
// current checkout: every path below is derived from this file's own location
// (import.meta.url), never from the caller's cwd — this closes the
// `npm run cli` "Missing script" friction (npm resolves scripts from the
// caller's cwd; a global command must not).
//
// Node-v22 selection is NOT repeated here: this wrapper only forwards to
// scripts/wao-node.cjs — the single shim that owns the Node-v22 lookup and the
// version guard. No shell string, no URL anywhere.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "scripts", "wao-node.cjs");
const CLI_ENTRY = join(HERE, "..", "src", "cli.js");

// wao-node.cjs forwards argv verbatim to the node it selects: it receives the
// CLI entry + the user's arguments, and the v22 guard still applies.
const child = spawn(process.execPath, [SHIM, CLI_ENTRY, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
