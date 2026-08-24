// src/application/runDispatchContract.js
//
// M12-9 Package B: the OPTIONAL read-only / ADVISORY dispatch-contract precheck
// service behind the `run_dispatch_contract_check` MCP tool.
//
// This is NOT a gate. It folds the mechanical facts a Lead might want BEFORE
// calling run_dispatch — workspace binding, worker registry presence, and the
// delivery contract (inline verification OR a frozen execution profile) — into
// ONE bounded advisory result. warning/unknown/contractValid=false do NOT
// auto-block an independent run_dispatch (the Lead decides; run_dispatch keeps
// its own real structural validation).
//
// Hard contract (B1/B3/B4):
//   - advisory=true always. The result carries no permit/token/passed/allowed
//     field — nothing a caller could mistake for authorization.
//   - registry/workspace/contract sections settle INDEPENDENTLY. A read failure
//     is reported as "unknown" — NEVER faked as empty or pass.
//   - The contract section reuses the SAME shared authority as run_dispatch:
//       resolveDeliveryVerification (executionProfiles.js) — profile vs inline
//         mutual exclusivity, known/unknown/conflict/non-delivery;
//       prepareDeliveryRequest (delivery.js) — the structural SSOT (mode /
//         allowedPaths / verification / absolute-path preflight).
//     So the precheck and run_dispatch cannot drift on what a valid delivery is.
//   - Output is bounded/strict/closed-set/safe: advisory, contractValid, section
//     statuses, issueCodes, observations, selected profile (id + setup/assertion
//     COUNTS only — never command text), and — only when no profile is selected —
//     a bounded availableProfiles list (id + counts + fixed summary, no commands).
//     NO prompt, command text, absolute path, credential, PID/session/provider
//     payload is ever placed in the result.
//   - TD-157 referenced-path probe: when the contract resolved and the workspace
//     is bound, relative-path-looking literals in the RESOLVED verification
//     assertion+setup commands are stat-checked against the bound root; an
//     allowedPaths entry whose base AND parent directory both do not exist is a
//     strong-typo signal too. The probe is FAIL-OPEN and ADVISORY: any fs error
//     or uncertainty is silently skipped, and the emitted code is a
//     section-level advisory label that NEVER affects contractValid. Observation
//     text is fixed — dynamic paths are never echoed.
//   - Zero side effect: reads the registry (read-only), stats candidate paths
//     under the already-resolved bound workspace root (read-only), and consumes
//     an already-resolved workspace binding. It never dispatches, forks, writes
//     a transcript, or mutates any state.
//
// Architectural contract:
//   - Does NOT import src/commands/*, src/mcp/*, MCP SDK, or zod.
//   - Does NOT import runDispatch.js (no dispatch path is reachable).
//   - Depends on executionProfiles.js (resolver), delivery.js
//     (prepareDeliveryRequest), and registry.js (readRegistry).

import { statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  resolveDeliveryVerification,
  listExecutionProfileSummaries,
} from "./executionProfiles.js";
import {
  prepareDeliveryRequest,
  tokenHasAbsolutePathLiteral,
} from "../delivery.js";
import { readRegistry } from "../registry.js";

// The frozen closed set of issue codes the precheck can emit. The MCP output
// schema is built from this single set so the service and the schema cannot
// drift. Codes are stable machine labels — never echo dynamic content.
//
// Contract-level codes (affect contractValid): profile_unknown,
// profile_requires_delivery, profile_inline_conflict, delivery_invalid,
// invalid_verification_path.
// Section-level advisory codes (do NOT affect contractValid): workspace_unbound,
// registry_unreadable, agent_not_found, referenced_path_probe_miss.
export const CONTRACT_CHECK_ISSUE_CODES = Object.freeze([
  "profile_unknown",
  "profile_requires_delivery",
  "profile_inline_conflict",
  "delivery_invalid",
  "invalid_verification_path",
  "workspace_unbound",
  "registry_unreadable",
  "agent_not_found",
  "referenced_path_probe_miss",
]);

// The frozen closed set of advisory sections. Single SSOT: the service inits its
// sections map from this, and the MCP output schema derives its bounded lengths
// (e.g. observations.max) from it — so "what sections exist" is defined once.
export const CONTRACT_CHECK_SECTIONS = Object.freeze(["workspace", "registry", "contract"]);

const CONTRACT_LEVEL_CODES = new Set([
  "profile_unknown",
  "profile_requires_delivery",
  "profile_inline_conflict",
  "delivery_invalid",
  "invalid_verification_path",
]);

// Resolved profile projection: id + COUNTS only. Never the command text.
function projectSelectedProfile(profileId) {
  const summary = listExecutionProfileSummaries().find((s) => s.id === profileId);
  if (!summary) return null;
  return {
    id: summary.id,
    setupCommandCount: summary.setupCommandCount,
    assertionCommandCount: summary.assertionCommandCount,
  };
}

/**
 * Build the effective delivery object (mode + allowedPaths + resolved
 * verification) for the shared structural validator. The resolver already
 * enforced mutual exclusivity; here we assemble the shape
 * prepareDeliveryRequest expects.
 */
function buildEffectiveDelivery(delivery, verification) {
  if (!delivery) return undefined;
  return {
    mode: delivery.mode,
    allowedPaths: delivery.allowedPaths,
    ...(verification.commands.length > 0 ? { verificationCommands: verification.commands } : {}),
    ...(verification.setupCommands.length > 0
      ? { verificationSetupCommands: verification.setupCommands }
      : {}),
    ...(verification.unavailableReason ? { verificationUnavailableReason: verification.unavailableReason } : {}),
    // M12-13: forward the per-command execution timeout to the shared structural
    // validator ONLY when declared, so a direct application-service contract
    // check cannot report contractValid despite an invalid timeout. Absent stays
    // absent (zero drift); a present-but-malformed value is classified by the
    // shared prepareDeliveryRequest SSOT exactly as run_dispatch would.
    ...(delivery.verificationTimeoutMs !== undefined
      ? { verificationTimeoutMs: delivery.verificationTimeoutMs }
      : {}),
  };
}

// ===== TD-157: referenced-path advisory probe (fail-open, read-only) =====
//
// A verification command that references a repo-relative path which does not
// exist under the bound workspace is a cheap-to-catch spec rot signal (moved /
// renamed file, wrong directory). This is deliberately NOT contract-level: the
// probe is lexical and cannot understand shell semantics, so every judgment it
// makes is heuristic — it reports, it never gates.

// Common file-suffix shape: a final dot segment starting with a letter (1-8
// alphanumeric chars). Distinguishes "tsconfig.json" from version text like
// "v1.2" or "1.5" (digit-led suffixes never match).
const RELATIVE_PATH_SUFFIX_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * Yield command literals the same way detectAbsolutePathLiteral scans them:
 * quote-aware, whitespace-delimited. A quoted region is one literal even when
 * it contains spaces. Mirrors the delivery.js scanner shape on purpose.
 */
function* commandLiteralTokens(command) {
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command.charCodeAt(i);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) { i += 1; continue; }
    if (ch === 34 || ch === 39) { // " or '
      const quote = ch;
      i += 1;
      let buf = "";
      while (i < n && command.charCodeAt(i) !== quote) {
        buf += command[i];
        i += 1;
      }
      if (i < n && command.charCodeAt(i) === quote) i += 1;
      yield buf;
      continue;
    }
    let buf = "";
    while (i < n) {
      const c = command.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 34 || c === 39) break;
      buf += command[i];
      i += 1;
    }
    yield buf;
  }
}

/**
 * Extract RELATIVE-path-looking candidate literals from verification command
 * strings — pure lexical filtering, no fs access:
 *   - flags (leading "-") are never collected;
 *   - absolute / drive / UNC / URL-like tokens are skipped via the SAME
 *     tokenHasAbsolutePathLiteral judgment delivery.js uses (zero drift);
 *   - glob metacharacters and ".." segments are skipped (a glob may legally
 *     match nothing as a literal; ".." must never leave the root);
 *   - kept only when the token contains "/" or ends in a common file suffix;
 *   - deduplicated across all commands, first-occurrence order preserved.
 *
 * @param {string[]} commands
 * @returns {string[]}
 */
export function extractReferencedRelativePaths(commands) {
  const found = [];
  const seen = new Set();
  if (!Array.isArray(commands)) return found;
  for (const command of commands) {
    if (typeof command !== "string") continue;
    for (const raw of commandLiteralTokens(command)) {
      if (raw.length === 0) continue;
      // Normalize Windows separators so downstream segment checks are uniform.
      const token = raw.split("\\").join("/");
      if (token.startsWith("-")) continue;
      if (tokenHasAbsolutePathLiteral(raw)) continue;
      if (token.includes("://")) continue;
      if (token.includes("*") || token.includes("?")) continue;
      if (token.split("/").some((segment) => segment === "..")) continue;
      if (!token.includes("/") && !RELATIVE_PATH_SUFFIX_RE.test(token)) continue;
      if (!seen.has(token)) {
        seen.add(token);
        found.push(token);
      }
    }
  }
  return found;
}

/**
 * Default existence predicate: statSync-based, distinguishing a definite miss
 * (ENOENT → false) from an UNKNOWN outcome (any other error → rethrow, so the
 * fail-open wrapper can skip silently instead of mis-reporting).
 */
function defaultWorkspacePathExists(absPath) {
  try {
    statSync(absPath);
    return true;
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Join a repo-relative candidate onto the bound workspace root, refusing any
 * result that escapes the root (belt-and-braces containment — ".." segments
 * were already filtered upstream).
 */
function joinInsideWorkspaceRoot(root, relPath) {
  const rootAbs = resolve(root);
  const abs = resolve(join(rootAbs, relPath));
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  if (abs !== rootAbs && !abs.startsWith(prefix)) {
    throw new Error("referenced path escapes the workspace root");
  }
  return abs;
}

/**
 * Normalize one allowedPaths entry for probing. Entries may be raw (the probe
 * also runs when structural validation already failed), may carry globs
 * (validateAllowedPaths passes "src/**" through opaquely), or may be invalid
 * shapes entirely. Returns the concrete base to probe, or null to skip:
 * absolute / drive / URL / traversal shapes are never probed, and a pure-glob
 * entry has no concrete base.
 */
function normalizeAllowedPathProbeBase(entry) {
  if (typeof entry !== "string") return null;
  let base = entry.split("\\").join("/").trim();
  while (base.length > 1 && base.endsWith("/")) base = base.slice(0, -1);
  if (base.length === 0) return null;
  if (base.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(base)) return null;
  if (base.includes("://")) return null;
  if (base.split("/").some((segment) => segment === "..")) return null;
  let prev;
  do {
    prev = base;
    base = base.replace(/\/\*\*?$/, "");
  } while (base !== prev);
  if (base.length === 0) return null;
  return base;
}

/**
 * Run the whole probe FAIL-OPEN: only a definite, observed miss returns true.
 * Any unexpected error (extraction, joining, or an existence predicate that
 * signals uncertainty by throwing) skips silently — an advisory probe must
 * never turn its own failure into a reported defect.
 */
function probeReferencedPathsForMiss({ root, commands, allowedPaths, pathExists }) {
  try {
    for (const rel of extractReferencedRelativePaths(commands)) {
      const abs = joinInsideWorkspaceRoot(root, rel);
      let missed;
      try {
        missed = !pathExists(abs);
      } catch {
        missed = false; // unknown outcome — never emits
      }
      if (missed) return true;
    }
    const bases = new Set();
    for (const entry of allowedPaths ?? []) {
      const base = normalizeAllowedPathProbeBase(entry);
      if (base) bases.add(base);
    }
    for (const base of bases) {
      const slashAt = base.lastIndexOf("/");
      let missed;
      try {
        missed = !pathExists(joinInsideWorkspaceRoot(root, base))
          // Strong-typo signal requires BOTH the entry and its parent directory
          // missing. A top-level entry's parent IS the workspace root, which the
          // binding guarantees exists — so a top-level miss alone never fires.
          && (slashAt > 0
            ? !pathExists(joinInsideWorkspaceRoot(root, base.slice(0, slashAt)))
            : false);
      } catch {
        missed = false;
      }
      if (missed) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Read-only advisory dispatch-contract precheck. See module header.
 *
 * Scope of `contractValid`: it reflects ONLY the delivery/profile MECHANICAL
 * contract — profile↔inline mutual exclusivity (resolveDeliveryVerification)
 * plus the delivery's structural validity (prepareDeliveryRequest: mode /
 * allowedPaths / verification / absolute-path preflight). It does NOT
 * pre-evaluate expectedGitHead / expectedDirty / expectedWorkspaceRoot, the
 * continuable-lineage or backend/session-reuse eligibility, or worker
 * credential readiness. run_dispatch remains the authoritative check for all of
 * those (it re-proves the workspace, re-reads the registry, and enforces its
 * own real structural validation); this precheck never gates or permits it.
 *
 * @param {object} input
 * @param {string} input.agentId
 * @param {string} input.prompt
 * @param {object} [input.delivery]
 * @param {string} [input.executionProfileId]
 * @param {{bound:boolean, source?:string, root?:string}|null} [input.workspaceBinding]
 *   Already-resolved workspace binding (from the MCP adapter). null when the
 *   resolver itself threw (→ workspace section unknown, NOT faked unbound).
 * @param {string} [input.registryPath]
 * @param {Function} [input.resolveVerificationFn] — injectable (testing)
 * @param {Function} [input.prepareDeliveryRequestFn] — injectable (testing)
 * @param {Function} [input.readRegistryFn] — injectable (testing)
 * @param {Function} [input.pathExistsFn] — injectable absolute-path existence
 *   predicate for the TD-157 referenced-path probe (testing); the default stats
 *   the real fs and rethrows non-ENOENT errors so the probe can fail open.
 * @returns {Promise<object>} bounded advisory result
 */
export async function runDispatchContractCheck({
  agentId,
  prompt,
  delivery,
  executionProfileId,
  workspaceBinding,
  registryPath,
  resolveVerificationFn,
  prepareDeliveryRequestFn,
  readRegistryFn,
  pathExistsFn,
  // Spies accepted solely to prove zero side effect (the service must never
  // call them). They are NOT used for any logic.
  dispatchSpy,
  spawnSpy,
}) {
  // Touch the spies defensively so a linter does not flag them unused, but the
  // service never invokes them — proving no dispatch/spawn path is reachable.
  void dispatchSpy;
  void spawnSpy;

  const resolveVerification = resolveVerificationFn ?? resolveDeliveryVerification;
  const prepare = prepareDeliveryRequestFn ?? prepareDeliveryRequest;
  const readReg = readRegistryFn ?? readRegistry;

  const issueCodes = [];
  const observations = [];
  // Sections init derives from the single CONTRACT_CHECK_SECTIONS SSOT.
  const sections = Object.fromEntries(CONTRACT_CHECK_SECTIONS.map((s) => [s, "unknown"]));
  let selectedProfileId = null;

  // ===== Section 1: workspace (already resolved by the adapter) =====
  // null → resolver threw → UNKNOWN (not faked unbound). bound:false → observed
  // (unbound) + advisory issueCode. bound:true → observed.
  if (workspaceBinding == null) {
    sections.workspace = "unknown";
    observations.push("workspace binding could not be resolved — use workspace_status to check directly");
  } else if (workspaceBinding.bound) {
    sections.workspace = "observed";
  } else {
    sections.workspace = "observed";
    issueCodes.push("workspace_unbound");
    observations.push("workspace is not bound — run_dispatch will refuse until a workspace is selected (reported only; not a contract defect)");
  }

  // ===== Section 2: registry (independent; read-only) =====
  // Production parity: take ONE registry snapshot via listAgents() — the SAME
  // enumeration API registry_list / getRegistryInventory consume — and select
  // the exact canonical id from it. We deliberately do NOT call getAgent(id):
  // in production getAgent THROWS for a missing id (registry.js), so catching
  // that throw would misreport a present-but-id-absent registry as a read
  // failure. Membership is decided by exact-id match against the snapshot —
  // NEVER by parsing exception message text. A genuine read/normalization
  // failure (readRegistry rejects on a missing/corrupt file, or listAgents()
  // throws while normalizing a malformed entry) is the ONLY path to
  // registry_unreadable; a simply-absent id is agent_not_found with the
  // section still observed.
  if (typeof registryPath === "string" && registryPath.length > 0) {
    try {
      const registry = await readReg(registryPath);
      const present = registry.listAgents().some((a) => a.id === agentId);
      sections.registry = "observed";
      if (!present) {
        issueCodes.push("agent_not_found");
        observations.push("agentId is not present in the registry (reported only)");
      }
    } catch {
      sections.registry = "unknown";
      issueCodes.push("registry_unreadable");
      observations.push("registry could not be read — use registry_list to check directly");
    }
  } else {
    // No registry path supplied (direct service use) — cannot confirm.
    sections.registry = "unknown";
  }

  // ===== Section 3: contract (resolver + prepareDeliveryRequest SSOT) =====
  // The resolver is the shared authority with run_dispatch: profile vs inline
  // mutual exclusivity, known/unknown/conflict/non-delivery. It never throws.
  const resolved = resolveVerification({ delivery, executionProfileId });
  if (!resolved.ok) {
    // Resolver rejection (profile_unknown / profile_requires_delivery /
    // profile_inline_conflict). The contract section is still "observed" — we
    // truthfully observed the contract is invalid; we did not fail to read it.
    issueCodes.push(resolved.code);
    sections.contract = "observed";
  } else {
    selectedProfileId = resolved.profileId;
    // Structural validation via the SAME SSOT run_dispatch uses. A DeliveryError
    // here is an observed contract defect (delivery_invalid / invalid path),
    // NOT an unknown — the section stays observed.
    try {
      const effective = buildEffectiveDelivery(delivery, resolved.verification);
      if (effective) {
        prepare(effective);
      }
      sections.contract = "observed";
    } catch (e) {
      sections.contract = "observed";
      if (e && e.name === "DeliveryError" && e.deliveryCode === "invalid_verification_path") {
        issueCodes.push("invalid_verification_path");
      } else {
        issueCodes.push("delivery_invalid");
      }
    }
  }

  // ===== TD-157: referenced-path advisory probe (fail-open; never gates) =====
  // Consumes the RESOLVED effective verification commands — so inline and
  // profile states are covered by the same path naturally. Runs only when the
  // resolver produced a usable contract and the workspace is bound with a real
  // root; unbound/unknown workspaces have nothing to check against and stay
  // silent. The emitted code is deliberately NOT in CONTRACT_LEVEL_CODES: this
  // is an existence heuristic, not the mechanical contract, so contractValid
  // must remain untouched when it fires.
  const probeRoot = workspaceBinding != null
    && workspaceBinding.bound === true
    && typeof workspaceBinding.root === "string"
    && workspaceBinding.root.length > 0
    ? workspaceBinding.root
    : null;
  if (resolved.ok && probeRoot) {
    const missed = probeReferencedPathsForMiss({
      root: probeRoot,
      commands: [
        ...(resolved.verification.commands ?? []),
        ...(resolved.verification.setupCommands ?? []),
      ],
      allowedPaths: Array.isArray(delivery?.allowedPaths) ? delivery.allowedPaths : [],
      pathExists: pathExistsFn ?? defaultWorkspacePathExists,
    });
    if (missed) {
      issueCodes.push("referenced_path_probe_miss");
      observations.push(
        "one or more referenced relative paths were not found under the bound workspace (advisory probe; reported only)",
      );
    }
  }

  // contractValid reflects ONLY contract-level issue codes. workspace/registry
  // advisory codes are separate sections and do not gate the contract verdict.
  const contractValid = sections.contract === "observed"
    && !issueCodes.some((c) => CONTRACT_LEVEL_CODES.has(c));

  const result = {
    advisory: true,
    contractValid,
    sections,
    issueCodes,
    observations,
    profile: selectedProfileId ? projectSelectedProfile(selectedProfileId) : null,
  };

  // availableProfiles ONLY when no profile is selected (the Lead is still
  // choosing). Bounded catalog summary: id + counts + fixed summary — no
  // command text.
  if (!selectedProfileId) {
    result.availableProfiles = listExecutionProfileSummaries();
  }

  return result;
}
