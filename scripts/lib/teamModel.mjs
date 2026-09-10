// ---------------------------------------------------------------------------
// Odd Saint — own first-party prediction model (expected goals / Poisson)
//
// WHY THIS EXISTS: social/public sentiment (X, Reddit) turned out not to be
// feasible on free-tier infrastructure — X's free tier is write-only, and
// Reddit's free tier is explicitly non-commercial-use-only, which rules it
// out for a paid product regardless of rate limits. This module is the
// honest alternative: a real statistical signal built entirely from data
// Odd Saint already owns (graded fixtures in Supabase), costing nothing,
// answerable to nobody's pricing page, and growing more reliable every day
// the pipeline runs.
//
// METHOD: classic expected-goals (xG) modeling via the Poisson distribution
// — a transparent, well-established technique (not a trained/black-box
// model), consistent with the rest of this pipeline's "simple, explainable
// heuristic" positioning (see the HONEST SCOPE NOTE in generate-tickets.mjs).
//
//   1. Each team's recent goal-scoring/conceding rate is read from
//      `team_match_history` (already split by home/away venue).
//   2. The league's own baseline goals-per-game is computed from graded
//      fixtures in that league.
//   3. Each team's rate is expressed relative to that baseline (its
//      "attack strength" / "defense strength").
//   4. The two teams' strengths combine into an expected-goals figure for
//      THIS fixture, which the Poisson distribution turns into real
//      probabilities for Over/Under lines, BTTS, and Home/Draw/Away.
//
// HONEST LIMITATIONS (read before wiring this into generation):
//   - `team_match_history` only covers teams that have actually appeared in
//      a generated ticket before — coverage is partial, especially early
//      in the product's life or for newly-added regional leagues.
//   - Small samples produce unstable estimates. This module refuses to
//      return a confident model for either team below MIN_SAMPLE_MATCHES —
//      it returns `null` rather than fabricating a number from 2-3 games.
//   - This model has NO knowledge of injuries, suspensions, lineup news,
//      weather, or anything a bookmaker's live market pricing already
//      accounts for. It should supplement bookmaker consensus, not
//      override it — see the integration note at the bottom of this file
//      before wiring it into generate-tickets.mjs.
// ---------------------------------------------------------------------------

// A team needs at least this many graded matches (at the relevant venue —
// home matches for home-team stats, away matches for away-team stats)
// before its scoring profile is trusted at all. Below this, the model
// returns insufficient-data rather than guessing.
const MIN_SAMPLE_MATCHES = 5;

// How far back to look for both the team's own profile and the league
// baseline — recent form matters more than a full season, and this keeps
// query size bounded as fixtures accumulate over time.
const TEAM_LOOKBACK_MATCHES = 15;
const LEAGUE_BASELINE_LOOKBACK_DAYS = 120;

// Goal grid used for the Poisson summation — 0 to this many goals per side
// covers effectively all realistic football scorelines (P(10+ goals) for
// one side is vanishingly small even for a very strong attack).
const MAX_GOALS_MODELED = 8;

function poissonPMF(k, lambda) {
  // P(exactly k goals) given expected goals lambda.
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial;
}

/**
 * Reads a team's goal-scoring profile at a specific venue from the
 * `team_match_history` view (see supabase/schema.sql) — most recent
 * TEAM_LOOKBACK_MATCHES games at that venue only, since home and away
 * scoring rates are genuinely different and shouldn't be blended.
 *
 * Returns null if fewer than MIN_SAMPLE_MATCHES are on record — the
 * caller must treat that as "no model available for this fixture," not
 * as zero goals.
 */
async function getTeamVenueProfile(supabase, teamName, venue) {
  const { data, error } = await supabase
    .from('team_match_history')
    .select('goals_for, goals_against')
    .eq('team', teamName)
    .eq('venue', venue)
    .order('kickoff', { ascending: false })
    .limit(TEAM_LOOKBACK_MATCHES);

  if (error || !data || data.length < MIN_SAMPLE_MATCHES) return null;

  const avgFor = data.reduce((sum, r) => sum + r.goals_for, 0) / data.length;
  const avgAgainst = data.reduce((sum, r) => sum + r.goals_against, 0) / data.length;
  return { avgFor, avgAgainst, sampleSize: data.length };
}

/**
 * Computes this league's own average home/away goals-per-game from graded
 * fixtures — the normalizing baseline every team's individual rate gets
 * compared against. Falls back to sane generic football averages
 * (roughly the real-world long-run figures) if the league doesn't yet
 * have enough graded history of its own — a brand-new regional league
 * added via resolve-leagues.mjs won't have this yet, and guessing a
 * plausible generic baseline is safer than returning nothing.
 */
async function getLeagueBaseline(supabase, league) {
  const cutoffISO = new Date(Date.now() - LEAGUE_BASELINE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('fixtures')
    .select('final_home_score, final_away_score')
    .eq('league', league)
    .not('final_home_score', 'is', null)
    .not('final_away_score', 'is', null)
    .gte('kickoff', cutoffISO);

  const GENERIC_HOME_AVG = 1.45; // long-run real-world approximate averages —
  const GENERIC_AWAY_AVG = 1.15; // used only until a league has its own graded sample

  if (error || !data || data.length < MIN_SAMPLE_MATCHES) {
    return { avgHomeGoals: GENERIC_HOME_AVG, avgAwayGoals: GENERIC_AWAY_AVG, sampleSize: 0, isGeneric: true };
  }

  const avgHomeGoals = data.reduce((sum, r) => sum + r.final_home_score, 0) / data.length;
  const avgAwayGoals = data.reduce((sum, r) => sum + r.final_away_score, 0) / data.length;
  return { avgHomeGoals, avgAwayGoals, sampleSize: data.length, isGeneric: false };
}

/**
 * Turns a pair of expected-goals figures into real probabilities for every
 * market this model can speak to. Sums the full home-goals × away-goals
 * probability grid rather than any shortcut formula, so results stay exact
 * for whatever MAX_GOALS_MODELED is set to.
 */
function probabilitiesFromExpectedGoals(homeXG, awayXG) {
  const grid = []; // grid[h][a] = P(home scores h AND away scores a)
  for (let h = 0; h <= MAX_GOALS_MODELED; h++) {
    grid.push([]);
    for (let a = 0; a <= MAX_GOALS_MODELED; a++) {
      grid[h].push(poissonPMF(h, homeXG) * poissonPMF(a, awayXG));
    }
  }

  let homeWin = 0, awayWin = 0, draw = 0, bttsYes = 0;
  const overThreshold = { 1.5: 0, 2.5: 0, 3.5: 0 };

  for (let h = 0; h <= MAX_GOALS_MODELED; h++) {
    for (let a = 0; a <= MAX_GOALS_MODELED; a++) {
      const p = grid[h][a];
      if (h > a) homeWin += p;
      else if (a > h) awayWin += p;
      else draw += p;
      if (h > 0 && a > 0) bttsYes += p;
      const total = h + a;
      if (total > 1.5) overThreshold[1.5] += p;
      if (total > 2.5) overThreshold[2.5] += p;
      if (total > 3.5) overThreshold[3.5] += p;
    }
  }

  return {
    'Home Win': homeWin,
    'Away Win': awayWin,
    'Double Chance 1X': homeWin + draw,
    'Double Chance X2': awayWin + draw,
    'Double Chance 12': homeWin + awayWin,
    'BTTS - Yes': bttsYes,
    'BTTS - No': 1 - bttsYes,
    'Over 1.5 Goals': overThreshold[1.5],
    'Under 1.5 Goals': 1 - overThreshold[1.5],
    'Over 2.5 Goals': overThreshold[2.5],
    'Under 2.5 Goals': 1 - overThreshold[2.5],
    'Over 3.5 Goals': overThreshold[3.5],
  };
}

/**
 * Main entry point. Returns either:
 *   { available: true, probabilities: {...}, homeXG, awayXG, sampleInfo }
 *   { available: false, reason: '...' }
 *
 * `available: false` is the expected, normal outcome for most fixtures
 * early on — most teams simply won't have MIN_SAMPLE_MATCHES of graded
 * home/away history yet. Callers MUST treat that as "no second opinion for
 * this fixture," not as a signal to skip the fixture — the bookmaker
 * consensus in lib/markets.mjs remains fully sufficient on its own.
 */
export async function getOwnModelForFixture(supabase, { league, homeTeam, awayTeam }) {
  const [homeProfile, awayProfile, baseline] = await Promise.all([
    getTeamVenueProfile(supabase, homeTeam, 'home'),
    getTeamVenueProfile(supabase, awayTeam, 'away'),
    getLeagueBaseline(supabase, league),
  ]);

  if (!homeProfile) return { available: false, reason: `Insufficient home-venue history for ${homeTeam}` };
  if (!awayProfile) return { available: false, reason: `Insufficient away-venue history for ${awayTeam}` };

  // Attack/defense strength relative to the league's own baseline — e.g. a
  // home team that scores 30% more than the league's home-scoring average
  // has an attack strength of 1.3.
  const homeAttackStrength = homeProfile.avgFor / baseline.avgHomeGoals;
  const homeDefenseStrength = homeProfile.avgAgainst / baseline.avgAwayGoals;
  const awayAttackStrength = awayProfile.avgFor / baseline.avgAwayGoals;
  const awayDefenseStrength = awayProfile.avgAgainst / baseline.avgHomeGoals;

  // Standard combined expected-goals formula: this team's own scoring rate,
  // adjusted by how leaky the opponent's defense has actually been,
  // scaled back onto the league's baseline.
  const homeXG = homeAttackStrength * awayDefenseStrength * baseline.avgHomeGoals;
  const awayXG = awayAttackStrength * homeDefenseStrength * baseline.avgAwayGoals;

  const probabilities = probabilitiesFromExpectedGoals(homeXG, awayXG);

  return {
    available: true,
    probabilities,
    homeXG: Math.round(homeXG * 100) / 100,
    awayXG: Math.round(awayXG * 100) / 100,
    sampleInfo: {
      homeTeamMatches: homeProfile.sampleSize,
      awayTeamMatches: awayProfile.sampleSize,
      leagueBaselineMatches: baseline.sampleSize,
      leagueBaselineIsGeneric: baseline.isGeneric,
    },
  };
}

// ---------------------------------------------------------------------------
// INTEGRATION NOTE — not wired into generate-tickets.mjs yet, deliberately.
//
// This changes what paying subscribers see as "confident" picks, so it
// needs your sign-off on the blend approach before it goes live, not just
// a silent drop-in. Two reasonable ways to use it once you're ready:
//
//   A) CROSS-CHECK ONLY (safer): after pickMarketFromOdds chooses a market
//      from bookmaker consensus, call getOwnModelForFixture and compare its
//      probability for that SAME market against the bookmaker figure. If
//      they're wildly apart (e.g. the model says 40% but the bookmaker
//      consensus implies 75%), treat that as a red flag and either skip the
//      fixture or log it for review — the model never adds confidence on
//      its own, it only ever subtracts it. Lowest risk, easiest to reason
//      about, doesn't change the current confidence math when the model
//      isn't available.
//
//   B) BLENDED CONFIDENCE: average the bookmaker's de-vigged probability
//      with the model's probability (e.g. 75% bookmaker weight / 25% model
//      weight) when both are available for the chosen market, and fall
//      back to pure bookmaker consensus when the model returns
//      `available: false`. More like a genuine "second opinion" but a
//      bigger behavior change — worth backtesting against
//      scripts/analyze-performance.mjs before trusting it live, the same
//      way you'd backtest a MIN_CONFIDENCE change.
//
// Recommend starting with (A) for a few weeks, then deciding on (B) once
// there's real graded-outcome data to check whether the model's flags
// actually correlated with real misses.
// ---------------------------------------------------------------------------
