// ---------------------------------------------------------------------------
// Odd Saint — own first-party prediction model (expected goals / Poisson)
//
// Built entirely from data Odd Saint already owns (graded fixtures +
// backfilled team history in Supabase). Every lookup is keyed by
// API-Football's stable numeric team ID, never by team name text.
//
// METHOD: classic expected-goals modeling via the Poisson distribution — a
// transparent, well-established technique (not a trained/black-box model).
//   1. Each team's recent scoring/conceding rate is read from
//      `team_match_history` by team_id, split by home/away venue.
//   2. The league's own baseline goals-per-game comes from graded fixtures.
//   3. Each team's rate is expressed relative to that baseline.
//   4. Strengths combine into an expected-goals figure for THIS fixture,
//      which the Poisson distribution turns into probabilities for goal
//      lines, BTTS, Home/Draw/Away, and the most likely exact scorelines.
//
// HONEST LIMITATIONS:
//   - History coverage grows over time; small samples are refused (null /
//     unavailable) rather than guessed.
//   - Missing team IDs return unavailable — no name-matching fallback.
//   - No knowledge of injuries, suspensions, lineups or weather.
// ---------------------------------------------------------------------------

// A team needs at least this many graded matches (at the relevant venue)
// before its scoring profile is trusted. Callers may pass their own
// (bounded, tuned) value via the `minSampleMatches` option.
export const DEFAULT_MIN_SAMPLE_MATCHES = 5;

const TEAM_LOOKBACK_MATCHES = 15;
const LEAGUE_BASELINE_LOOKBACK_DAYS = 120;
const MAX_GOALS_MODELED = 8;

function poissonPMF(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial;
}

async function getTeamVenueProfile(supabase, teamId, venue, minSampleMatches) {
  if (!teamId) return null;

  const { data, error } = await supabase
    .from('team_match_history')
    .select('goals_for, goals_against')
    .eq('team_id', teamId)
    .eq('venue', venue)
    .order('kickoff', { ascending: false })
    .limit(TEAM_LOOKBACK_MATCHES);

  if (error || !data || data.length < minSampleMatches) return null;

  const avgFor = data.reduce((sum, r) => sum + r.goals_for, 0) / data.length;
  const avgAgainst = data.reduce((sum, r) => sum + r.goals_against, 0) / data.length;
  return { avgFor, avgAgainst, sampleSize: data.length };
}

async function getLeagueBaseline(supabase, league, minSampleMatches) {
  const cutoffISO = new Date(Date.now() - LEAGUE_BASELINE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('fixtures')
    .select('final_home_score, final_away_score')
    .eq('league', league)
    .not('final_home_score', 'is', null)
    .not('final_away_score', 'is', null)
    .gte('kickoff', cutoffISO);

  const GENERIC_HOME_AVG = 1.45; // long-run approximate averages, used only
  const GENERIC_AWAY_AVG = 1.15; // until a league has its own graded sample

  if (error || !data || data.length < minSampleMatches) {
    return { avgHomeGoals: GENERIC_HOME_AVG, avgAwayGoals: GENERIC_AWAY_AVG, sampleSize: 0, isGeneric: true };
  }

  const avgHomeGoals = data.reduce((sum, r) => sum + r.final_home_score, 0) / data.length;
  const avgAwayGoals = data.reduce((sum, r) => sum + r.final_away_score, 0) / data.length;
  return { avgHomeGoals, avgAwayGoals, sampleSize: data.length, isGeneric: false };
}

function probabilitiesFromExpectedGoals(homeXG, awayXG) {
  const grid = [];
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

/** The `n` most likely exact scorelines from the same Poisson grid, best first: [{ home, away, probability }] (probability 0-1). */
function topScorelinesFromExpectedGoals(homeXG, awayXG, n = 3) {
  const all = [];
  for (let h = 0; h <= MAX_GOALS_MODELED; h++) {
    for (let a = 0; a <= MAX_GOALS_MODELED; a++) {
      all.push({ home: h, away: a, probability: poissonPMF(h, homeXG) * poissonPMF(a, awayXG) });
    }
  }
  return all.sort((x, y) => y.probability - x.probability).slice(0, n);
}

/**
 * Main entry point. Returns either:
 *   { available: true, probabilities, topScorelines, topScoreline, homeXG, awayXG, sampleInfo }
 *   { available: false, reason }
 *
 * `homeTeamId` / `awayTeamId` MUST be API-Football's numeric team IDs.
 * `minSampleMatches` (optional) overrides DEFAULT_MIN_SAMPLE_MATCHES.
 */
export async function getOwnModelForFixture(
  supabase,
  { league, homeTeamId, awayTeamId, homeTeamName, awayTeamName, minSampleMatches = DEFAULT_MIN_SAMPLE_MATCHES }
) {
  if (!homeTeamId || !awayTeamId) {
    return { available: false, reason: 'Missing team ID for one or both sides — cannot look up history reliably.' };
  }

  const [homeProfile, awayProfile, baseline] = await Promise.all([
    getTeamVenueProfile(supabase, homeTeamId, 'home', minSampleMatches),
    getTeamVenueProfile(supabase, awayTeamId, 'away', minSampleMatches),
    getLeagueBaseline(supabase, league, minSampleMatches),
  ]);

  if (!homeProfile) {
    return { available: false, reason: `Insufficient home-venue history for ${homeTeamName ?? `team ${homeTeamId}`}` };
  }
  if (!awayProfile) {
    return { available: false, reason: `Insufficient away-venue history for ${awayTeamName ?? `team ${awayTeamId}`}` };
  }

  const homeAttackStrength = homeProfile.avgFor / baseline.avgHomeGoals;
  const homeDefenseStrength = homeProfile.avgAgainst / baseline.avgAwayGoals;
  const awayAttackStrength = awayProfile.avgFor / baseline.avgAwayGoals;
  const awayDefenseStrength = awayProfile.avgAgainst / baseline.avgHomeGoals;

  const homeXG = homeAttackStrength * awayDefenseStrength * baseline.avgHomeGoals;
  const awayXG = awayAttackStrength * homeDefenseStrength * baseline.avgAwayGoals;

  const probabilities = probabilitiesFromExpectedGoals(homeXG, awayXG);
  const topScorelines = topScorelinesFromExpectedGoals(homeXG, awayXG, 3);

  return {
    available: true,
    probabilities,
    topScorelines,
    topScoreline: topScorelines[0],
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
