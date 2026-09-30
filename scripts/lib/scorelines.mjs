// ---------------------------------------------------------------------------
// Odd Saint — scoreline probabilities
//
// Turns the two expected-goals figures from scripts/lib/teamModel.mjs
// (homeXG / awayXG) into the most likely exact scorelines, using the same
// independent-Poisson grid teamModel.mjs already sums for Over/Under and
// BTTS — it just keeps the individual cells instead of collapsing them.
//
// Kept as its own file (poissonPMF is duplicated from teamModel.mjs, 6
// lines) so teamModel.mjs needs no edit and can't be broken by this feature.
//
// HONEST LIMITATION: independent Poisson slightly under-rates low-scoring
// draws (0-0, 1-1) versus real football. Treat the ranking as indicative,
// not exact.
// ---------------------------------------------------------------------------

const MAX_GOALS_MODELED = 8;

function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial;
}

/** Returns the `n` most likely scorelines as [{ home, away, probability }], most likely first. */
export function topScorelines(homeXG, awayXG, n = 3) {
  const cells = [];
  for (let h = 0; h <= MAX_GOALS_MODELED; h++) {
    for (let a = 0; a <= MAX_GOALS_MODELED; a++) {
      cells.push({ home: h, away: a, probability: poissonPMF(h, homeXG) * poissonPMF(a, awayXG) });
    }
  }
  cells.sort((x, y) => y.probability - x.probability);
  return cells.slice(0, n).map((c) => ({
    home: c.home,
    away: c.away,
    probability: Math.round(c.probability * 1000) / 1000,
  }));
}
