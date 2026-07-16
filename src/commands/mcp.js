// src/commands/mcp.js
//
// M10 P0-1: CLI command for project-scoped workspace activation.
//
// Routes: mcp bind/status/unbind --host codex --cwd <git-root>
//
// This is a Human Owner ops command, not an MCP tool. It generates, reads, and
// removes a WAO-managed block in the target project's .codex/config.toml.
//
// Architectural contract:
//   - Imports src/application/mcpWorkspaceActivation.js (the service layer).
//   - Imports ./shared.js for parseOptions/resolveTargetCwd.
//   - Does NOT import cli.js (dependency direction: cli.js -> mcp.js).
//   - CLI only does argv parsing + output formatting.

import { parseOptions, resolveTargetCwd } from "./shared.js";
import { bindWorkspace, statusWorkspace, unbindWorkspace, SUPPORTED_HOSTS } from "../application/mcpWorkspaceActivation.js";

/**
 * mcp command dispatcher.
 *
 * Usage:
 *   mcp bind --host codex --cwd <git-root>
 *   mcp status --host codex --cwd <git-root>
 *   mcp unbind --host codex --cwd <git-root>
 *
 * @param {string[]} args — args after "mcp"
 * @param {object} config — loaded config (unused, matches command signature)
 */
async function mcpCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "bind") {
    await mcpBindCommand(tail, config);
    return;
  }
  if (sub === "status") {
    await mcpStatusCommand(tail, config);
    return;
  }
  if (sub === "unbind") {
    await mcpUnbindCommand(tail, config);
    return;
  }
  throw new Error(
    `Unknown mcp subcommand: ${sub ?? "(none)"} (expected: bind | status | unbind)`,
  );
}

/**
 * mcp bind: Activate WAO workspace for a project.
 *
 * Proves the workspace, generates a WAO-managed block in .codex/config.toml,
 * and adds a precise .git/info/exclude rule. The block configures the WAO MCP
 * stdio server with --workspace-root bound to the project's canonical Git root.
 *
 * After bind, the Human Owner must restart or open a new Codex task in the
 * project for the configuration to take effect (Codex only loads project config
 * for trusted projects).
 */
async function mcpBindCommand(args, config) {
  const options = parseOptions(args);
  const host = options.host;
  if (!host) {
    throw new Error(
      `mcp bind requires --host (supported: ${SUPPORTED_HOSTS.join(", ")})`,
    );
  }
  const cwd = resolveTargetCwd(options);
  const result = await bindWorkspace({ host, cwd });
  console.log(JSON.stringify(result, null, 2));
  console.log("");
  console.log(
    `WAO workspace configured for ${host}. ` +
      `Restart or open a new Codex task in this project for the configuration to take effect.`,
  );
  console.log(
    `The project must be trusted by Codex (open in Codex Desktop once to establish trust).`,
  );
}

/**
 * mcp status: Query WAO workspace binding status.
 *
 * Returns the binding state. Note: "configured" means the config file is correctly
 * written; it does NOT guarantee Codex has actually loaded it (that requires trust +
 * restart/new task, which only the Human Owner can verify via Codex Desktop).
 */
async function mcpStatusCommand(args, config) {
  const options = parseOptions(args);
  const host = options.host;
  if (!host) {
    throw new Error(
      `mcp status requires --host (supported: ${SUPPORTED_HOSTS.join(", ")})`,
    );
  }
  const cwd = resolveTargetCwd(options);
  const result = await statusWorkspace({ host, cwd });
  console.log(JSON.stringify(result, null, 2));
}

/**
 * mcp unbind: Remove WAO workspace binding from a project.
 *
 * Removes the WAO-managed block from .codex/config.toml and the exclude rule.
 * Preserves all user configuration. Fails closed if the managed block was
 * externally modified.
 */
async function mcpUnbindCommand(args, config) {
  const options = parseOptions(args);
  const host = options.host;
  if (!host) {
    throw new Error(
      `mcp unbind requires --host (supported: ${SUPPORTED_HOSTS.join(", ")})`,
    );
  }
  const cwd = resolveTargetCwd(options);
  const result = await unbindWorkspace({ host, cwd });
  console.log(JSON.stringify(result, null, 2));
}

export { mcpCommand };
