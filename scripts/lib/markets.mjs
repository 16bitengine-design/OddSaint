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
//
// NOTE ON BANDS AFTER THE CONSENSUS-PRICING UPDATE BELOW: oddsMin/oddsMax
// were originally calibrated against a single raw bookmaker price. Vig-
// corrected consensus odds (see collectConsensusOutcomes) run somewhat
// longer/more generous than any one bookmaker's quoted price, since the
// bookmaker's margin has been removed — so these bands may now filter
// slightly differently than before. This is a "watch the data, don't
// guess" situation: scripts/self-tune.mjs and scripts/propose-
// improvements.mjs already backtest against real graded results, so let
// evidence decide if these need retuning rather than adjusting them
// blindly here.
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
 * Given one bookmaker's `bets` array from an API-Football /odds response,
 * returns every outcome that's both offered and within its sane odds
 * band, priced at that ONE bookmaker's raw quote.
 *
 * SUPERSEDED for real selection by collectConsensusOutcomes() below,
 * which averages across every bookmaker and removes the vig — kept here
 * (unused by generate-tickets.mjs as of this update) only in case
 * something else in the repo still depends on the single-bookmaker
 * behavior. Safe to remove once confirmed nothing else calls it.
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

// ---------------------------------------------------------------------------
// Multi-bookmaker, vig-corrected consensus pricing
//
// A single bookmaker's quoted odds bake in that bookmaker's own margin
// (the "vig") and can be noisy on lower-liquidity regional leagues. This
// removes the vig from EACH bookmaker's own odds set independently
// (proportional devigging: normalize that bookmaker's implied
// probabilities so they sum to 1 — i.e. remove exactly its margin, no
// more), then averages the resulting fair probabilities across every
// bookmaker that priced the fixture. The result is a real consensus
// probability estimate, not one bookmaker's marked-up price.
// ---------------------------------------------------------------------------

// Outcomes backed by fewer than this many bookmakers are still returned
// (discarding a whole fixture on a thin-liquidity league would undo the
// point of doing this at all) but the caller gets bookmakerCount so it's
// visible downstream, including in the fixtures table for later analysis.
export const MIN_BOOKMAKERS_FOR_CONSENSUS = 2;

/**
 * Removes the vig from ONE bookmaker's odds for a single bet (e.g. every
 * price in "Match Winner": Home/Draw/Away) via proportional devigging —
 * each outcome's fair probability is its own implied probability (1/odds)
 * divided by the sum of ALL implied probabilities in that bet. Outcomes
 * this catalog doesn't track (e.g. Draw, which isn't a selectable market
 * here) still have to be included in the sum, since they're still part of
 * that bookmaker's overround and skipping them would under-correct the
 * vig for the outcomes that ARE tracked.
 *
 * Returns null if the bet's odds are malformed (can't produce a sane
 * positive total) — that bookmaker is simply skipped for this bet rather
 * than polluting the average with garbage.
 */
function devigBetValues(betValues) {
  const impliedProbs = (betValues ?? [])
    .map((v) => ({ value: v.value, odd: parseFloat(v.odd) }))
    .filter((v) => Number.isFinite(v.odd) && v.odd > 0)
    .map((v) => ({ value: v.value, implied: 1 / v.odd }));

  const total = impliedProbs.reduce((acc, v) => acc + v.implied, 0);
  if (!Number.isFinite(total) || total <= 0) return null;

  return impliedProbs.map((v) => ({ value: v.value, fairProb: v.implied / total }));
}

/**
 * Given the FULL `bookmakers` array from one fixture's API-Football
 * /odds response (i.e. `oddsResponse[0].bookmakers`, not a single
 * bookmaker's `.bets`), returns every catalog outcome offered by at
 * least one bookmaker, priced as a vig-corrected CONSENSUS:
 *
 *   - fairProb        — average of that outcome's devigged fair
 *                        probability across every bookmaker that priced
 *                        its market
 *   - odds             — 1 / fairProb, the consensus's own fair price
 *                        (always somewhat longer than any individual
 *                        bookmaker's raw quote, since margin is removed)
 *   - bookmakerCount   — how many bookmakers contributed to the average
 *
 * Still filtered against each outcome's oddsMin/oddsMax band (see the
 * file header note on why these bands may now behave slightly
 * differently than before).
 */
export function collectConsensusOutcomes(bookmakers) {
  if (!Array.isArray(bookmakers) || bookmakers.length === 0) return [];

  // marketLabel -> { probSum, count }
  const accum = new Map();

  for (const bookmaker of bookmakers) {
    for (const betDef of MARKET_CATALOG) {
      const bet = bookmaker.bets?.find((b) => b.name === betDef.betName);
      if (!bet || !Array.isArray(bet.values) || bet.values.length === 0) continue;

      const devigged = devigBetValues(bet.values);
      if (!devigged) continue;

      for (const outcome of betDef.outcomes) {
        const match = devigged.find((v) => v.value === outcome.apiValue);
        if (!match) continue;

        const entry = accum.get(outcome.marketLabel) ?? { probSum: 0, count: 0 };
        entry.probSum += match.fairProb;
        entry.count += 1;
        accum.set(outcome.marketLabel, entry);
      }
    }
  }

  const consensus = [];
  for (const betDef of MARKET_CATALOG) {
    for (const outcome of betDef.outcomes) {
      const entry = accum.get(outcome.marketLabel);
      if (!entry || entry.count === 0) continue;

      const fairProb = entry.probSum / entry.count;
      if (!Number.isFinite(fairProb) || fairProb <= 0 || fairProb >= 1) continue;

      const odds = Math.round((1 / fairProb) * 100) / 100;
      if (odds < outcome.oddsMin || odds > outcome.oddsMax) continue;

      consensus.push({
        market: outcome.marketLabel,
        odds,
        bookmakerCount: entry.count,
      });
    }
  }

  return consensus;
}
