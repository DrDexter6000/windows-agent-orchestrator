// src/commands/dashboard.js
//
// M12-8F: top-level `wao dashboard` — the ergonomic HUMAN Owner launcher for
// the existing loopback read-only Owner dashboard (M12-8C/D).
//
// Contract (differs from the legacy nested `runs dashboard --web` ONLY in the
// launcher layer; the server boundary itself is NOT changed):
//   - target cwd defaults to process.cwd() — intentionally NOT
//     resolveTargetCwd()'s WAO_TARGET_CWD chain: this is a human launcher, not
//     a worker dispatch path
//   - the canonical Git root of the target cwd is resolved STRICTLY; a non-Git
//     cwd fails BEFORE listen with one actionable message (legacy fails soft)
//   - the generated fragment-token URL is opened in the Windows default browser
//     exactly once by default; --no-open performs zero open attempts
//   - browser launch failure is advisory: the URL is already printed, warn and
//     keep the server running
//   - stays foreground until Ctrl-C/SIGTERM (the shared lifecycle)
//
// The opener is shell-free by construction: the URL is passed as ONE structured
// argv element to a real executable (rundll32 url.dll,FileProtocolHandler) —
// no shell builtin, no shell string, no URL interpolation.
//
// Lifecycle risk correction (M12-8F): the opener child is spawned detached and
// unref()ed, and the opener promise resolves on the child's SPAWN event — not
// on exit. A lingering default-handler process can therefore never block the
// dashboard: Ctrl-C resolves the lifecycle and the server closes even while
// the handler is still alive.

import { resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { parseOptions } from "./shared.js";
import { runDashboardWeb } from "./runs.js";
import { canonicalizeWorkspacePath } from "../application/workspaceBinding.js";

/**
 * M12-8F: strict canonical Git root of a directory (nested directories allowed —
 * `git rev-parse --show-toplevel` walks up). Structured argv, no shell string.
 * Throws when the directory is not inside any Git repository (fail closed).
 *
 * The result gets the SAME canonicalization the shared workspace authority
 * (proveWorkspace) applies, so it is comparable against other canonical roots.
 *
 * @param {string} cwd — absolute directory to resolve from
 * @param {{gitBin?: string}} [opts] — git binary override (tests)
 * @returns {string} canonicalized worktree top-level
 */
export function resolveCanonicalGitRoot(cwd, opts = {}) {
  const bin = opts.gitBin ?? "git";
  const toplevel = execFileSync(bin, ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  return canonicalizeWorkspacePath(toplevel);
}

/**
 * Production Windows default-browser opener: `rundll32 url.dll,FileProtocolHandler`
 * with structured argv — NO shell, NO cmd.exe, and the URL is never interpolated
 * into a shell string (it travels as a single argv element).
 *
 * Lifecycle (M12-8F risk correction): the child is spawned detached with ignored
 * stdio and a hidden console; the promise resolves on the child's SPAWN event,
 * NOT on exit. A lingering default-handler process can therefore never hold the
 * dashboard open — after spawn the child is unref()ed so it cannot keep the
 * parent event loop alive, and Ctrl-C closes the server regardless of the
 * handler's lifetime. A pre-spawn failure (ENOENT/EACCES/invalid argv) rejects
 * so the existing advisory warning path in runDashboardWeb runs; raw child
 * errors are never surfaced beyond that concise Owner warning.
 *
 * @param {string} url — the printed fragment-token dashboard URL
 * @param {{spawnFn?: Function}} [opts] — spawn injection seam (tests)
 * @returns {Promise<void>} resolves on spawn success, rejects on pre-spawn failure
 */
export function openInWindowsDefaultBrowser(url, { spawnFn } = {}) {
  return new Promise((resolveOpen, rejectOpen) => {
    const spawnChild = spawnFn ?? spawn;
    let child;
    try {
      child = spawnChild("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,    // run outside the dashboard process group
        stdio: "ignore",   // no pipes — nothing to feed or read
        windowsHide: true, // no console flash
      });
    } catch (error) {
      rejectOpen(error); // synchronous spawn failure (e.g. invalid argv)
      return;
    }
    child.once("spawn", () => {
      child.unref(); // after spawn the child cannot hold the dashboard open
      resolveOpen();
    });
    // Pre-spawn failures (e.g. ENOENT) reject → the advisory warning runs.
    // Errors after spawn are ignored: the promise already settled and the URL
    // was printed.
    child.once("error", (error) => rejectOpen(error));
  });
}

/**
 * Top-level `wao dashboard [--cwd DIR] [--port N] [--run-dir DIR] [--no-open]`.
 *
 * Every external dependency is injectable (git-root resolver, browser opener,
 * plus the runDashboardWeb seams: server factory, registry reader, lifecycle,
 * logger) so tests never bind a socket, run git, launch a browser, or deliver
 * an OS signal.
 *
 * Delegates to runDashboardWeb with a pre-resolved targetCwd + STRICT canonical
 * workspaceRoot and an afterListen open hook. `runs dashboard --web` passes
 * none of those and keeps its byte-identical fail-soft behavior.
 *
 * @param {string[]} args — CLI args after `dashboard`
 * @param {object} config — process config (runDir/registry/stateDir)
 * @param {object} [injections]
 * @param {Function} [injections.gitRootFn] — strict canonical-root resolver
 * @param {Function} [injections.openUrlFn] — default-browser opener
 * @param {Function} [injections.spawnFn] — spawn factory for the production
 *   opener (tests; only used when openUrlFn is absent)
 * @param {Function} [injections.createServerFn] — server factory (passthrough)
 * @param {Function} [injections.readRegistryFn] — registry reader (passthrough)
 * @param {{wait:Function, cancel?:Function}} [injections.lifecycle] — shutdown waitable (passthrough)
 * @param {Function} [injections.log] — stdout sink (passthrough)
 */
export async function dashboardCommand(args, config, injections = {}) {
  const options = parseOptions(args);
  const gitRoot = injections.gitRootFn ?? resolveCanonicalGitRoot;

  // Human launcher: default = process.cwd() (never WAO_TARGET_CWD).
  const targetCwd = options.cwd ? resolve(options.cwd) : process.cwd();

  // Strict Git-root proof: a non-Git target must fail BEFORE the server listens
  // (and therefore before any browser open) with one actionable message.
  let workspaceRoot;
  try {
    workspaceRoot = gitRoot(targetCwd);
  } catch {
    throw new Error(
      `wao dashboard 需要 Git 仓库：${targetCwd} 不在任何 Git 仓库内。\n` +
        `请在一个 Git 项目目录内运行本命令，或用 --cwd 指定一个 Git 项目根目录。`,
    );
  }

  // The production opener takes the spawn seam; a fully injected openUrlFn
  // (tests) bypasses it entirely.
  const openUrl =
    injections.openUrlFn ?? ((url) => openInWindowsDefaultBrowser(url, { spawnFn: injections.spawnFn }));

  await runDashboardWeb(options, config, {
    ...injections,
    targetCwd,
    workspaceRoot,
    // Open the printed fragment-token URL exactly once after listen, unless
    // --no-open (zero open attempts). A failing opener rejects here; the
    // runDashboardWeb afterListen backstop turns that into a warning and keeps
    // the server running — the URL is already printed.
    afterListen: async (url) => {
      if (options.noOpen) return;
      await openUrl(url);
    },
  });
}
