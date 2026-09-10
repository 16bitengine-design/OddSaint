// ---------------------------------------------------------------------------
// Shared market catalog — used by BOTH generate-tickets.mjs (to pick a
// market from bookmaker odds) and grade-tickets.mjs (to settle it against
// the final score). Keeping this in one place means a market can never be
// pickable without also being gradable, or vice versa — the two scripts
// can't drift out of sync with each other.
//
// Each outcome has its own sane odds band (oddsMin/oddsMax). A "Double
// Chance" pick and a "Home Win" pick have very different natural odds
// ranges, so a single global range doesn't fit every market well.
// ---------------------------------------------------------------------------

export const MARKET_CATALOG = [
  {
    betName: 'Match Winner',
    outcomes: [
      { apiValue: 'Home', marketLabel: 'Home Win', oddsMin: 1.3, oddsMax: 3.5, settle: (h, a) => h > a },
      { apiValue: 'Away', marketLabel: 'Away Win', oddsMin: 1.3, oddsMax: 3.5, settle: (h, a) => a > h },
    ],
  },
  {
    betName: 'Goals Over/Under',
    outcomes: [
      { apiValue: 'Over 1.5', marketLabel: 'Over 1.5 Goals', oddsMin: 1.15, oddsMax: 1.6, settle: (h, a) => h + a > 1.5 },
      { apiValue: 'Under 1.5', marketLabel: 'Under 1.5 Goals', oddsMin: 2.2, oddsMax: 4.0, settle: (h, a) => h + a < 1.5 },
      { apiValue: 'Over 2.5', marketLabel: 'Over 2.5 Goals', oddsMin: 1.5, oddsMax: 2.3, settle: (h, a) => h + a > 2.5 },
      { apiValue: 'Under 2.5', marketLabel: 'Under 2.5 Goals', oddsMin: 1.5, oddsMax: 2.3, settle: (h, a) => h + a < 2.5 },
      { apiValue: 'Over 3.5', marketLabel: 'Over 3.5 Goals', oddsMin: 2.0, oddsMax: 4.0, settle: (h, a) => h + a > 3.5 },
    ],
  },
  {
    betName: 'Both Teams Score',
    outcomes: [
      { apiValue: 'Yes', marketLabel: 'BTTS - Yes', oddsMin: 1.5, oddsMax: 2.3, settle: (h, a) => h > 0 && a > 0 },
      { apiValue: 'No', marketLabel: 'BTTS - No', oddsMin: 1.5, oddsMax: 2.3, settle: (h, a) => h === 0 || a === 0 },
    ],
  },
  {
    betName: 'Double Chance',
    outcomes: [
      { apiValue: 'Home/Draw', marketLabel: 'Double Chance 1X', oddsMin: 1.1, oddsMax: 1.6, settle: (h, a) => h >= a },
      { apiValue: 'Draw/Away', marketLabel: 'Double Chance X2', oddsMin: 1.15, oddsMax: 1.7, settle: (h, a) => a >= h },
      { apiValue: 'Home/Away', marketLabel: 'Double Chance 12', oddsMin: 1.1, oddsMax: 1.5, settle: (h, a) => h !== a },
    ],
  },
];

/** Flat lookup used by the grading script: marketLabel -> settle(homeScore, awayScore). */
const SETTLERS = Object.fromEntries(
  MARKET_CATALOG.flatMap((bet) => bet.outcomes.map((o) => [o.marketLabel, o.settle]))
);

/** Returns true/false for a graded outcome, or null if the market isn't recognized (left pending for manual review). */
export function settleMarket(marketLabel, homeScore, awayScore) {
  const settle = SETTLERS[marketLabel];
  if (!settle) return null;
  return settle(homeScore, awayScore);
}

/**
 * LEGACY — single-bookmaker viable-outcome collector. Superseded by
 * collectConsensusOutcomes below (which aggregates across every bookmaker
 * in the response instead of trusting whichever one happens to be first),
 * but left here in case anything still needs a raw single-bookmaker read.
 * generate-tickets.mjs no longer calls this.
 *
 * Given one bookmaker's `bets` array from an API-Football /odds response,
 * returns every outcome that's both offered and within its sane odds band.
 */
export function collectViableOutcomes(bookmakerBets) {
  const viable = [];
  for (const betDef of MARKET_CATALOG) {
    const bet = bookmakerBets?.find((b) => b.name === betDef.betName);
    if (!bet) continue;

    for (const outcome of betDef.outcomes) {
      const value = bet.values?.find((v) => v.value === outcome.apiValue);
      if (!value) continue;

      const odds = parseFloat(value.odd);
      if (Number.isFinite(odds) && odds >= outcome.oddsMin && odds <= outcome.oddsMax) {
        viable.push({ market: outcome.marketLabel, odds });
      }
    }
  }
  return viable;
}

/**
 * Multi-bookmaker consensus, with vig (bookmaker margin) removed before
 * averaging.
 *
 * WHY THIS EXISTS: a single bookmaker's odds always imply slightly more
 * than 100% total probability across a bet's outcomes — that extra
 * percentage is the house's built-in margin ("the vig"), not a real signal
 * about the match. Reading only one bookmaker (the previous behavior —
 * `oddsResponse[0].bookmakers[0]`) bakes that margin straight into the
 * displayed confidence figure, and the distortion is worse for thinner,
 * lower-liquidity regional-league books where margins run wider.
 *
 * This function instead:
 *   1. For each bookmaker, computes that bookmaker's own overround (the
 *      sum of 1/odds across all outcomes of a given bet type) and divides
 *      it back out — so each bookmaker's own probabilities now genuinely
 *      sum to 100% before anything is combined across bookmakers.
 *   2. Averages the de-vigged probability for each outcome across every
 *      bookmaker that offers it.
 *   3. Converts the averaged probability back into a "fair odds" figure.
 *
 * The result is the closest honest reading available of "what does the
 * combined betting market actually believe," independent of any single
 * bookmaker's margin — the nearest real proxy this pipeline has for
 * aggregated public sentiment, since bookmaker lines move in response to
 * where real money (i.e. real people) is being placed.
 *
 * Returns: [{ market, odds, bookmakerCount }] — bookmakerCount is how many
 * independent bookmakers actually priced that outcome, which the caller
 * uses as a market-vetting floor (an outcome only one thin bookmaker
 * offers isn't "worthy" just because its number looks safe).
 */
export function collectConsensusOutcomes(bookmakers) {
  const agg = new Map(); // marketLabel -> { probSum, count }

  for (const bookmaker of bookmakers ?? []) {
    for (const betDef of MARKET_CATALOG) {
      const bet = bookmaker.bets?.find((b) => b.name === betDef.betName);
      if (!bet) continue;

      // Raw implied probabilities across the FULL bet type (not just the
      // outcomes inside our odds bands) — the overround has to be computed
      // from everything this bookmaker offers on this bet, or the
      // de-vig math is wrong.
      const rawProbs = [];
      for (const outcome of betDef.outcomes) {
        const value = bet.values?.find((v) => v.value === outcome.apiValue);
        const odds = value ? parseFloat(value.odd) : NaN;
        if (Number.isFinite(odds) && odds > 0) {
          rawProbs.push({ outcome, prob: 1 / odds });
        }
      }
      if (rawProbs.length === 0) continue;

      const overround = rawProbs.reduce((sum, r) => sum + r.prob, 0);
      if (overround <= 0) continue;

      rawProbs.forEach(({ outcome, prob }) => {
        const deviggedProb = prob / overround; // this bookmaker's own outcomes now sum to 1.0
        const impliedFairOdds = 1 / deviggedProb;
        if (impliedFairOdds < outcome.oddsMin || impliedFairOdds > outcome.oddsMax) return;

        const key = outcome.marketLabel;
        const entry = agg.get(key) ?? { probSum: 0, count: 0 };
        entry.probSum += deviggedProb;
        entry.count += 1;
        agg.set(key, entry);
      });
    }
  }

  return Array.from(agg.entries()).map(([market, { probSum, count }]) => {
    const avgProb = probSum / count;
    return {
      market,
      odds: Math.round((1 / avgProb) * 100) / 100, // de-vigged consensus "fair odds"
      bookmakerCount: count,
    };
  });
}
