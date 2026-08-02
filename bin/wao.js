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
//
// M12-8F trusted install root: this wrapper derives the WAO installation root
// from its OWN location (import.meta.url) and passes it to the CLI child as a
// CHILD-ONLY env value (WAO_INSTALL_ROOT) — never argv, never a shell string,
// and it OVERWRITES any caller-supplied value so resolution cannot be
// redirected. Only this opt-in env makes src/cli.js loadConfig() + the
// dashboard anchor config/default.json, runDir and registry at the install root
// instead of the caller cwd. The caller cwd is STILL the default observed
// target project for `wao dashboard`; --cwd is still only the workspace
// authority; explicit --run-dir is still never rebased.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeInstallRoot, INSTALL_ROOT_ENV } from "../src/installRoot.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "scripts", "wao-node.cjs");
const CLI_ENTRY = join(HERE, "..", "src", "cli.js");
// Trusted, caller-independent installation root (one level up from bin/).
const INSTALL_ROOT = computeInstallRoot(import.meta.url);

// wao-node.cjs forwards argv verbatim to the node it selects: it receives the
// CLI entry + the user's arguments, and the v22 guard still applies. The trusted
// install root travels via the child env only (no shell, no argv interpolation).
const child = spawn(process.execPath, [SHIM, CLI_ENTRY, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, [INSTALL_ROOT_ENV]: INSTALL_ROOT },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
