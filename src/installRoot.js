// src/installRoot.js
//
// M12-8F: the single named resolver/normalizer for WAO-owned shared-state paths.
//
// Problem this closes: the global `wao` bin (one-time `npm link`) opens the
// dashboard from any directory, but src/cli.js loadConfig() + runDashboardWeb
// resolved config/default.json, config.runDir and config.registry from
// process.cwd(). Launched from a non-repo Home, the dashboard silently backed
// itself with <Home>/runs + <Home>/config — an empty, wrong dashboard — instead
// of the linked WAO checkout's real shared run/registry state.
//
// Fix: the global bin derives a TRUSTED installation root from its own location
// (import.meta.url) and passes it to the CLI child as a child-only env value
// (WAO_INSTALL_ROOT) — never argv, never a shell string. Only that opt-in env
// redirects resolution; the legacy `npm run cli -- ...` path (no env) keeps
// process.cwd() resolution byte-for-byte. The caller cwd is STILL the default
// observed target project for `wao dashboard`; --cwd is still only the workspace
// authority; explicit --run-dir is still an explicit override that is never
// rebased.
//
// This module is intentionally pure (no process.env / process.cwd reads except
// the explicit `env` arg default) and adds NO dependency.

import { resolve, isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Child-only env name carrying the trusted installation root (bin → CLI). */
export const INSTALL_ROOT_ENV = "WAO_INSTALL_ROOT";

/**
 * WAO-owned shared-state keys whose RELATIVE default/config paths must anchor at
 * the trusted installation root when the global bin opts in. Per-project state
 * (stateDir ".wao") is intentionally NOT here — it belongs to the observed
 * target project, not the WAO install.
 */
const WAO_OWNED_STATE_KEYS = Object.freeze(["runDir", "registry"]);

/**
 * PRODUCER (bin/wao.js): derive the trusted installation root from the global
 * bin's own location. bin/wao.js lives directly under the package root, so one
 * level up is the install root. Pure function of a URL — testable with a
 * synthetic file:// URL, independent of the caller's cwd.
 *
 * @param {string} metaUrl — import.meta.url of the global bin
 * @returns {string} absolute, normalized installation root
 */
export function computeInstallRoot(metaUrl) {
  const here = dirname(fileURLToPath(metaUrl)); // .../<install root>/bin
  return resolve(here, ".."); // .../<install root>
}

/**
 * CONSUMER (cli.js): read + trust-validate the installation root from env.
 * Only an absolute path is accepted; a relative/empty/non-string value is
 * rejected (fail closed) so a malformed or injected value can never redirect
 * shared-state resolution to an attacker-chosen directory.
 *
 * @param {Record<string, string|undefined>} [env] — env source (default process.env)
 * @returns {string|null} trusted absolute root, or null (legacy resolution)
 */
export function readInstallRoot(env = process.env) {
  const raw = env[INSTALL_ROOT_ENV];
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (!isAbsolute(raw)) return null;
  return raw;
}

/**
 * Resolve a single config/state path. With a trusted install root, relative
 * paths anchor there; without it (legacy `npm run cli`), they anchor at the
 * caller cwd exactly as before. Absolute paths are never rebased.
 *
 * @param {string} relPath — relative or absolute path
 * @param {string|null} installRoot — trusted root, or null for legacy
 * @returns {string} resolved absolute path
 */
export function resolveConfigPath(relPath, installRoot) {
  if (installRoot && !isAbsolute(relPath)) return resolve(join(installRoot, relPath));
  return resolve(relPath);
}

/**
 * The single named normalizer: rebase the WAO-owned shared-state keys of a
 * config object against the trusted install root. Returns a NEW config (never
 * mutates the input). Keys that are absent or already absolute pass through
 * unchanged; an absent install root is a complete no-op (returns the same
 * reference) so legacy resolution is preserved byte-for-byte.
 *
 * This is applied once at config-load time, so every consumer of config.runDir /
 * config.registry (the dashboard at minimum, plus any other command run via the
 * global bin) reads shared state from the install root, while explicit overrides
 * (--run-dir / --registry) bypass config.* and are therefore never rebased.
 *
 * @param {object} config — merged config (hardcodedDefaults ← config/default.json)
 * @param {string|null} installRoot — trusted root, or null for legacy
 * @returns {object} config with WAO-owned relative paths rebased (new object)
 */
export function rebaseConfigPaths(config, installRoot) {
  if (!installRoot) return config;
  const rebased = { ...config };
  for (const key of WAO_OWNED_STATE_KEYS) {
    const value = rebased[key];
    if (typeof value === "string" && value.length > 0 && !isAbsolute(value)) {
      rebased[key] = resolve(join(installRoot, value));
    }
  }
  return rebased;
}
