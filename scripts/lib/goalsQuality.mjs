// ---------------------------------------------------------------------------
// Odd Saint — total-goals (Over) market quality gate
//
// WHY: "Over 2.5 Goals" priced at a fair 55-60% is only a good pick when the
// MATCH itself is one where goals are structurally likely. Bookmaker odds
// alone can't tell a free-scoring fixture from an average one that happens
// to carry the same price. This module adds fixture-level evidence on top of
// the market price, so only fixtures that look like genuine goal matches can
// ever carry an Over pick.
//
// SCOPE: Over 1.5 and Over 2.5 only. Over 3.5 (true probability too low to
// ever beat the tickets' hit-rate goals) and every Under market are rejected
// outright — per product direction, tickets focus on direct-win and Over
// markets.
//
// A fixture must pass ALL of the following for its market:
//   1. Market probability (approx. devigged from the bookmaker's price) >= floor
//   2. Poisson model, when it has an opinion, must agree: P(market) >= floor AND
//      expected total goals (homeXG + awayXG) >= floor. No opinion = not a veto.
//   3. Each team's last 5 matches (any venue):
//        - average total goals in its matches >= floor
//        - at least N of 5 matches went over the line
//        - team scored in at least N of 5 (no "one-sided 1-0 team")
//        - at most N of 5 matches had <= 1 total goals (no low-scoring habit)
//        - average goals SCORED >= floor (Over 2.5 only — existing product rule)
//   4. Defensive leakiness at the relevant venue: home team's last home
//      matches and away team's last away matches must each concede at least
//      X goals on average — a lockdown defence kills Overs even when both
//      attacks look good.
//   5. Both teams need a full 5-match sample; thin history = rejected, never
//      guessed.
//
// LEVELS: 'strict' | 'relaxed-1' | 'relaxed-2' | 'relaxed-3' — same ladder as
// the rest of the pipeline. Relaxing loosens the numeric thresholds only.
// It NEVER re-enables Over 3.5 / Under markets, never removes the 5-match
// sample requirement, and never skips the bookmaker-quality gates upstream.
//
// All thresholds below are product-tuning experiments, NOT validated
// constants. Re-check them against graded results with
// scripts/analyze-performance.mjs before tightening or loosening further.
//
// DATA: PURE FUNCTION — no database or network access. The caller supplies each
// team's recent matches (newest first, rows of { goalsFor, goalsAgainst, venue })
// and, optionally, the Poisson model's opinion. generate-tickets.mjs builds the
// history from the same API-Football last-N request it already makes, so the gate
// adds no extra API calls. Teams without a full 5-match history are rejected.
//
// The Poisson model (teamModel.mjs) needs graded venue history that most teams
// don't have yet, so it is OPTIONAL: when it has an opinion it can veto a pick
// (probability / expected-goals floors below); when it has none the pick is
// judged on market price + form alone.
// ---------------------------------------------------------------------------

export const GOALS_QUALITY_LEVELS = ['strict', 'relaxed-1', 'relaxed-2', 'relaxed-3'];

// Each array is indexed by level: [strict, relaxed-1, relaxed-2, relaxed-3].
const RULES = {
  'Over 2.5 Goals': {
    line: 2.5,
    minFairProb: [0.56, 0.54, 0.52, 0.5],
    minModelProb: [0.6, 0.58, 0.55, 0.52],
    minModelXgTotal: [2.9, 2.8, 2.7, 2.6],
    minTeamAvgTotal: [3.0, 2.8, 2.7, 2.6],
    minTeamOverCount: [3, 3, 3, 2], // of last 5, matches with total > 2.5
    minTeamScoredIn: [4, 4, 3, 3], // of last 5, matches where the team scored
    maxTeamLowGames: [1, 1, 2, 2], // of last 5, matches with total <= 1
    minTeamAvgGoalsFor: [2.0, 2.0, 1.8, 1.6], // product rule: each team averages ~2 goals scored
    minVenueConcededAvg: [1.0, 1.0, 0.9, 0.8],
    modelRequired: [false, false, false, false],
  },
  'Over 1.5 Goals': {
    line: 1.5,
    minFairProb: [0.8, 0.78, 0.76, 0.74],
    minModelProb: [0.82, 0.8, 0.78, 0.75],
    minModelXgTotal: [2.6, 2.5, 2.4, 2.3],
    minTeamAvgTotal: [2.8, 2.6, 2.5, 2.4],
    minTeamOverCount: [4, 4, 3, 3], // of last 5, matches with total > 1.5
    minTeamScoredIn: [4, 3, 3, 3],
    maxTeamLowGames: [0, 1, 1, 1],
    minTeamAvgGoalsFor: [0, 0, 0, 0], // not enforced for Over 1.5
    minVenueConcededAvg: [0.9, 0.8, 0.8, 0.7],
    modelRequired: [false, false, false, false],
  },
};

const SAMPLE_SIZE = 5; // matches required per team — never relaxed
const MIN_VENUE_SAMPLE = 3; // venue-specific matches needed to judge defensive leakiness

/** Markets this module can judge. Everything else returns { ok: false } with a clear reason. */
export function isSupportedGoalsMarket(market) {
  return Object.prototype.hasOwnProperty.call(RULES, market);
}

/** True for any total-goals market (Over/Under), supported or not — callers use this to decide whether to route a pick through the gate. */
export function isGoalsMarket(market) {
  return /^(Over|Under)\s\d(\.\d)?\sGoals$/.test(market ?? '');
}

function levelIndex(level) {
  const idx = GOALS_QUALITY_LEVELS.indexOf(level);
  return idx === -1 ? 0 : idx; // unknown level => strictest, never looser by accident
}

// --- Team history summary -------------------------------------------------------

function mean(values) {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Summarises a team's last SAMPLE_SIZE matches (any venue) plus its recent matches at one venue. */
function summarise(matches, venue, line) {
  const last = matches.slice(0, SAMPLE_SIZE);
  const totals = last.map((m) => m.goalsFor + m.goalsAgainst);
  const atVenue = matches.filter((m) => m.venue === venue).slice(0, SAMPLE_SIZE);

  return {
    sample: last.length,
    avgTotal: mean(totals),
    avgFor: mean(last.map((m) => m.goalsFor)),
    overCount: totals.filter((t) => t > line).length,
    scoredIn: last.filter((m) => m.goalsFor > 0).length,
    lowGames: totals.filter((t) => t <= 1).length,
    venueSample: atVenue.length,
    venueConcededAvg: mean(atVenue.map((m) => m.goalsAgainst)),
  };
}

// --- Main entry point ---------------------------------------------------------------

/**
 * Judges one (fixture, goals-market) pair.
 *
 * @param {object}   args
 * @param {object}   args.fixture     { homeTeam, awayTeam } (names, for log reasons)
 * @param {string}   args.market      market label, e.g. 'Over 2.5 Goals'
 * @param {number}   args.fairProb    devigged consensus probability, 0-1
 * @param {object|null} args.model    result of getOwnModelForFixture() for this
 *                                    fixture (needs .available, .probabilities,
 *                                    .homeXG, .awayXG), or null/unavailable
 * @param {string}   [args.level]     'strict' | 'relaxed-1' | 'relaxed-2' | 'relaxed-3'
 * @param {{home: object[], away: object[]}} args.history  each team's recent matches, NEWEST FIRST:
 *                                    [{ goalsFor, goalsAgainst, venue: 'home'|'away' }]
 * @returns {{ ok: boolean, reasons: string[], qualityScore: number|null }}
 *   reasons lists every failed check (empty when ok) — log it so rejected
 *   fixtures are explainable. qualityScore (0-1) ranks passing candidates.
 */
export function evaluateGoalsMarket({ fixture, market, fairProb, model, history, level = 'strict' }) {
  if (!isSupportedGoalsMarket(market)) {
    return {
      ok: false,
      reasons: [`${market}: only Over 1.5 / Over 2.5 are allowed for total goals`],
      qualityScore: null,
    };
  }

  const i = levelIndex(level);
  const rule = RULES[market];
  const reasons = [];

  // 1. Market price
  if (fairProb < rule.minFairProb[i]) {
    reasons.push(`fair probability ${(fairProb * 100).toFixed(0)}% < ${(rule.minFairProb[i] * 100).toFixed(0)}%`);
  }

  // 2. Poisson model agreement
  const modelAvailable = !!model?.available;
  const modelProb = modelAvailable ? model.probabilities?.[market] : undefined;
  const xgTotal = modelAvailable ? (model.homeXG ?? 0) + (model.awayXG ?? 0) : null;

  if (!modelAvailable || typeof modelProb !== 'number') {
    if (rule.modelRequired[i]) reasons.push('no Poisson model opinion (required at this level)');
  } else {
    if (modelProb < rule.minModelProb[i]) {
      reasons.push(`model probability ${(modelProb * 100).toFixed(0)}% < ${(rule.minModelProb[i] * 100).toFixed(0)}%`);
    }
    if (xgTotal < rule.minModelXgTotal[i]) {
      reasons.push(`model expected goals ${xgTotal.toFixed(2)} < ${rule.minModelXgTotal[i]}`);
    }
  }

  // 3 + 4. Recent form of both teams
  const homeMatches = history?.home ?? [];
  const awayMatches = history?.away ?? [];

  const home = summarise(homeMatches, 'home', rule.line);
  const away = summarise(awayMatches, 'away', rule.line);

  if (home.sample < SAMPLE_SIZE) reasons.push(`${fixture.homeTeam}: only ${home.sample}/${SAMPLE_SIZE} matches of history`);
  if (away.sample < SAMPLE_SIZE) reasons.push(`${fixture.awayTeam}: only ${away.sample}/${SAMPLE_SIZE} matches of history`);

  if (home.sample >= SAMPLE_SIZE && away.sample >= SAMPLE_SIZE) {
    for (const [name, s] of [[fixture.homeTeam, home], [fixture.awayTeam, away]]) {
      if (s.avgTotal < rule.minTeamAvgTotal[i]) {
        reasons.push(`${name}: avg total goals ${s.avgTotal.toFixed(2)} < ${rule.minTeamAvgTotal[i]}`);
      }
      if (s.overCount < rule.minTeamOverCount[i]) {
        reasons.push(`${name}: only ${s.overCount}/5 matches over ${rule.line} (need ${rule.minTeamOverCount[i]})`);
      }
      if (s.scoredIn < rule.minTeamScoredIn[i]) {
        reasons.push(`${name}: scored in only ${s.scoredIn}/5 (need ${rule.minTeamScoredIn[i]})`);
      }
      if (s.lowGames > rule.maxTeamLowGames[i]) {
        reasons.push(`${name}: ${s.lowGames}/5 matches with <=1 goal (max ${rule.maxTeamLowGames[i]})`);
      }
      if (rule.minTeamAvgGoalsFor[i] > 0 && s.avgFor < rule.minTeamAvgGoalsFor[i]) {
        reasons.push(`${name}: scores ${s.avgFor.toFixed(2)}/game < ${rule.minTeamAvgGoalsFor[i]}`);
      }
    }

    // Defensive leakiness at the relevant venue — judged only with a usable sample.
    if (home.venueSample >= MIN_VENUE_SAMPLE && home.venueConcededAvg < rule.minVenueConcededAvg[i]) {
      reasons.push(`${fixture.homeTeam}: concedes ${home.venueConcededAvg.toFixed(2)} at home < ${rule.minVenueConcededAvg[i]}`);
    }
    if (away.venueSample >= MIN_VENUE_SAMPLE && away.venueConcededAvg < rule.minVenueConcededAvg[i]) {
      reasons.push(`${fixture.awayTeam}: concedes ${away.venueConcededAvg.toFixed(2)} away < ${rule.minVenueConcededAvg[i]}`);
    }
  }

  if (reasons.length > 0) return { ok: false, reasons, qualityScore: null };

  // Passing candidates are ranked: market + model probability dominate, form-based goal volume breaks ties.
  const volume = Math.min(1, ((home.avgTotal + away.avgTotal) / 2) / 4);
  const qualityScore = 0.4 * fairProb + 0.4 * (typeof modelProb === 'number' ? modelProb : fairProb) + 0.2 * volume;
  return { ok: true, reasons: [], qualityScore };
}
