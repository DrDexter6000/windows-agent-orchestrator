// Shared classification for commandsPassed evidence. A backend capability
// declaration may explain unavailable evidence, but cannot erase an observed
// non-zero command exit, nor a required command that never ran (decision 0073:
// "the command ran and its exit code is unknown" is the capability gap; "the
// command was not executed" is a failure on any backend).

export function scorecardCommandFailureIsCredible(scorecardCheck) {
  if (scorecardCheck?.passed !== false) return false;
  if (Number.isInteger(scorecardCheck.exitCode) && scorecardCheck.exitCode !== 0) return true;
  const text = [scorecardCheck.detail, scorecardCheck.evidence]
    .filter((value) => typeof value === "string")
    .join(" ");
  const numericExitCodes = [...text.matchAll(/exitCode\s*=\s*(-?\d+)/gi)]
    .map((match) => Number(match[1]));
  if (numericExitCodes.some((code) => Number.isInteger(code) && code !== 0)) return true;
  // checkCommandsPassed (src/scorecard.js) reports a required command with no
  // command evidence at all as "not executed: <command>".
  if (/\bnot executed:/i.test(text)) return true;
  return /\b(?:observed|recorded|credible)\s+(?:a\s+)?non[- ]?zero\s+exit\b/i.test(text);
}
