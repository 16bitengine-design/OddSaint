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

/**
 * Market labels considered an outright "full win" pick (Home Win / Away
 * Win) — shared with generate-tickets.mjs so it can guarantee a ticket
 * includes one where the day's pool allows it, without duplicating the
 * label strings in two places.
 */
export const FULL_WIN_MARKETS = new Set(['Home Win', 'Away Win']);

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
