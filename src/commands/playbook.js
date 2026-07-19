// src/commands/playbook.js
//
// M11-2B: Lead Playbook Catalog CLI adapter.
//
// Command family: playbook list | playbook show <id>
//
// This is a thin CLI adapter. It owns ONLY argv handling, output formatting,
// and console output. All data logic (catalog read, validation, fail-closed
// semantics) lives in the shared application service
// (../application/playbookCatalog.js). The same service backs the MCP adapter,
// so CLI and MCP produce semantically identical output.
//
// Architectural contract:
//   - Depends on ./shared.js (parseOptions, pure) and the application service.
//   - Does NOT import src/mcp/*, the MCP SDK, zod, or third-party libs.
//   - Does NOT shell out, read transcripts, touch the registry, or write files.
//   - Read-only: a catalog read creates no run/transcript/filesystem mutation.
//
// Output formats:
//   list  --format json  → { "playbooks": [{id,version,title,summary,lanePattern}] }
//   list  (text)          → id<TAB>lanePattern<TAB>title<TAB>summary  (one line per built-in)
//   show <id> --format json → { "playbook": <full PlaybookV1> }
//   show <id> (text)        → full PlaybookV1 as pretty JSON (no second summary algorithm)
//
// Unknown/malformed ids propagate the M11-2A fixed typed error
// (PlaybookNotFoundError / PlaybookValidationError); no raw catalog/path
// content is surfaced.

import { parseOptions } from "./shared.js";
import { listLeadPlaybooks, getLeadPlaybook } from "../application/playbookCatalog.js";

async function playbookCommand(args, config) {
  const [sub, ...tail] = args;
  if (sub === "list") {
    await playbookListCommand(tail, config);
    return;
  }
  if (sub === "show") {
    await playbookShowCommand(tail, config);
    return;
  }
  throw new Error(
    `Unknown playbook subcommand: ${sub ?? "(none)"}. Try: playbook list | playbook show <id>`,
  );
}

/**
 * playbook list: emit the four built-in Lead playbook summaries.
 * Text format is a stable simple shape: id<TAB>lanePattern<TAB>title<TAB>summary.
 * JSON format wraps the service array as { playbooks: [...] } to match the MCP
 * structuredContent shape exactly.
 */
async function playbookListCommand(args, config) {
  const options = parseOptions(args);
  const playbooks = listLeadPlaybooks();
  if (options.format === "json") {
    console.log(JSON.stringify({ playbooks }, null, 2));
    return;
  }
  for (const p of playbooks) {
    console.log([p.id, p.lanePattern, p.title, p.summary].join("\t"));
  }
}

/**
 * Extract the first positional argument from an args array, skipping --flag
 * and --flag <value> pairs. Used by `show` to find <id> regardless of where
 * --format appears.
 */
function firstPositional(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        i += 1;
      }
      continue;
    }
    return a;
  }
  return undefined;
}

/**
 * playbook show <id>: emit one full PlaybookV1.
 * JSON format wraps as { playbook: {...} } to match MCP structuredContent.
 * Text format is the full playbook as pretty JSON — one serialization algorithm,
 * no second summary/abbreviated shape to drift out of parity.
 *
 * The service throws PlaybookNotFoundError / PlaybookValidationError for
 * unknown/malformed ids; these propagate as typed errors (the CLI does not
 * catch and re-message them, so the fixed M11-2A messages are preserved).
 */
async function playbookShowCommand(args, config) {
  const options = parseOptions(args);
  const id = firstPositional(args);
  if (!id) {
    throw new Error('playbook show requires <id>. 用 playbook list 看可用 playbook。');
  }
  const playbook = getLeadPlaybook({ id });
  if (options.format === "json") {
    console.log(JSON.stringify({ playbook }, null, 2));
    return;
  }
  console.log(JSON.stringify(playbook, null, 2));
}

export { playbookCommand };
