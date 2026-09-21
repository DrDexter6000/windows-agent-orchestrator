// Shared classification for commandsPassed evidence. A backend capability
// declaration may explain unavailable evidence, but cannot erase an observed
// non-zero command exit.

export function scorecardCommandFailureIsCredible(scorecardCheck) {
  if (scorecardCheck?.passed !== false) return false;
  if (Number.isInteger(scorecardCheck.exitCode) && scorecardCheck.exitCode !== 0) return true;
  const text = [scorecardCheck.detail, scorecardCheck.evidence]
    .filter((value) => typeof value === "string")
    .join(" ");
  const numericExitCodes = [...text.matchAll(/exitCode\s*=\s*(-?\d+)/gi)]
    .map((match) => Number(match[1]));
  if (numericExitCodes.some((code) => Number.isInteger(code) && code !== 0)) return true;
  return /\b(?:observed|recorded|credible)\s+(?:a\s+)?non[- ]?zero\s+exit\b/i.test(text);
}
