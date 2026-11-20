const BLOCKED_PATH_SEGMENTS = new Set([
  "casino", "casinos", "sportsbook", "sportsbooks", "poker",
  "gambling", "wager", "wagers", "bet", "bets", "betting"
]);

export function isRestrictedDestination(url) {
  const segments = `${url.hostname}${url.pathname}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (segments.some(segment => BLOCKED_PATH_SEGMENTS.has(segment))) return true;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const pair = segments[index] + segments[index + 1];
    if (pair === "binaryoptions" || pair === "predictionmarket" || pair === "predictionmarkets") {
      return true;
    }
  }
  return false;
}
