// src/machineGatePaths.js
//
// R23-F/A (TD-130): machine-level SSOT for the paths WAO's suite-gate machinery
// writes OUTSIDE every repo checkout — the advisory canonical-suite inflight
// marker today, the verification lease in Round B.
//
// Problem this closes: the inflight marker lived at os.tmpdir()/
// "wao-canonical-test.inflight". os.tmpdir() resolves through TMP/TEMP/TMPDIR,
// and the delivery harness injects a FRESH per-attempt temp dir into exactly
// those variables of every verification subprocess (src/deliveryVerification.js
// _prepareAttemptEnv). Two channels that both derived "the" marker path from
// os.tmpdir() therefore resolved two different files and could never see each
// other — the advisory WARNING was structurally blind precisely in the harness
// context it exists for. These paths must instead derive from machine-global
// state that no attempt injects: %LOCALAPPDATA%\wao on Windows, with
// ~/.wao-machine as the fallback when LOCALAPPDATA is unset (and as the
// convention on non-Windows hosts). Nothing in this module ever reads
// TMP/TEMP/TMPDIR — that env immunity is its reason to exist.
//
// Shape: top-level named functions, zero relative out-edges (node:path /
// node:os / node:fs only). Env is read at CALL time (nothing cached at import)
// so overrides are observed live. Directory creation is on-demand, recursive
// (= idempotent) and BEST-EFFORT: an unwritable machine-state dir must not add
// a new failure surface — callers already degrade gracefully under the marker's
// advisory discipline (never block, never fail the suite; a failed marker
// create surfaces as "unavailable", never as an error).

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Marker filename under the machine state dir. Single-sourced here;
 * scripts/canonical-test.mjs re-exports this constant so its pinned public
 * surface stays byte-stable.
 */
export const INFLIGHT_MARKER_FILENAME = "wao-canonical-test.inflight";

/**
 * Verification-lease filename under the same dir. Defined this round so the
 * directory contract is complete; its consumer (the Round B gate) lands later.
 */
export const VERIFICATION_LEASE_FILENAME = "verification.lease";

/**
 * Machine-global WAO state directory: win32 → join(process.env.LOCALAPPDATA,
 * "wao") with join(homedir(), ".wao-machine") as the LOCALAPPDATA-missing
 * fallback; elsewhere → join(homedir(), ".wao-machine"). Deliberately NEVER
 * derived from TMP/TEMP/TMPDIR. Creates the directory on demand
 * (mkdirSync recursive is idempotent — safe to call on every invocation);
 * creation failures are swallowed on purpose: an unwritable state dir must
 * degrade downstream (marker "unavailable") rather than throw from a path
 * resolver.
 *
 * @returns {string} absolute directory path
 */
export function waoMachineStateDir() {
  const dir =
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "wao")
      : join(homedir(), ".wao-machine");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Advisory discipline (see header): degrade downstream, never throw here.
  }
  return dir;
}

/**
 * Full path of the advisory canonical-suite inflight marker — machine-global,
 * outside every repo checkout (a repo-local marker would be entangled with
 * runs-guard / gitignore state; see the R22 W1 note in canonical-test.mjs).
 *
 * @returns {string} absolute marker file path
 */
export function inflightMarkerPath() {
  return join(waoMachineStateDir(), INFLIGHT_MARKER_FILENAME);
}

/**
 * Full path of the Round B verification lease (same machine-state base).
 * No consumer this round — defined to pin the layout.
 *
 * @returns {string} absolute lease file path
 */
export function verificationLeasePath() {
  return join(waoMachineStateDir(), VERIFICATION_LEASE_FILENAME);
}
