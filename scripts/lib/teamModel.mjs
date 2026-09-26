// ---------------------------------------------------------------------------
// Odd Saint — own first-party prediction model (expected goals / Poisson)
//
// WHY THIS EXISTS: social/public sentiment (X, Reddit) turned out not to be
// feasible on free-tier infrastructure — X's free tier is write-only, and
// Reddit's free tier is explicitly non-commercial-use-only, which rules it
// out for a paid product regardless of rate limits. This module is the
// honest alternative: a real statistical signal built entirely from data
// Odd Saint already owns (graded fixtures + backfilled team history in
// Supabase — see supabase/migrations/004_team_identity.sql and
// scripts/backfill-team-history.mjs), costing nothing, answerable to
// nobody's pricing page, and growing more reliable every day the pipeline
// runs.
//
// TEAM IDENTITY: every lookup here is keyed by API-Football's own stable
// numeric team ID (see migration 004), not by team name text. Name
// matching is fragile — "Manchester United" vs "Man United" vs "Man
// Utd" would silently under-count a team's real history — while the ID is
// the same one API-Football uses across fixtures, odds, and team
// endpoints, so it's the honest "unique identifier that works across any
// site/page" this module needs.
//
// METHOD: classic expected-goals (xG) modeling via the Poisson distribution
// — a transparent, well-established technique (not a trained/black-box
// model), consistent with the rest of this pipeline's "simple, explainable
// heuristic" positioning (see the HONEST SCOPE NOTE in generate-tickets.mjs).
//
//   1. Each team's recent goal-scoring/conceding rate is read from
//      `team_match_history` by team_id (already split by home/away venue).
//   2. The league's own baseline goals-per-game is computed from graded
//      fixtures in that league.
//   3. Each team's rate is expressed relative to that baseline (its
//      "attack strength" / "defense strength").
//   4. The two teams' strengths combine into an expected-goals figure for
//      THIS fixture, which the Poisson distribution turns into real
//      probabilities for Over/Under lines, BTTS, Home/Draw/Away — AND,
//      as of the exact-score-prediction feature, a ranked list of full
//      scorelines (e.g. "2-1 is the single most likely final score").
//
// SELF-IMPROVEMENT: the ONE knob this model exposes for bounded auto-
// tuning (see scripts/self-tune-score-model.mjs) is minSampleMatches —
// how many graded home/away matches a team needs before its profile is
// trusted at all. DEFAULT_MIN_SAMPLE_MATCHES below is this module's own
// hardcoded default, still used as-is by scripts/lib/modelCrossCheck.mjs
// (ticket-generation cross-check, if/when that's actually wired in) and
// by any other caller that doesn't pass an override. scripts/generate-
// score-predictions.mjs instead reads a LIVE, separately-tuned value from
// score_model_tuning_state and passes it in explicitly — so tuning
// score-prediction accuracy can never silently change ticket-selection
// behavior, even though both features share this one file.
//
// HONEST LIMITATIONS (read before wiring this into generation):
//   - `team_match_history` combines two sources: fixtures the pipeline has
//      actually ticketed and graded, plus proactively backfilled results
//      from scripts/backfill-team-history.mjs. Coverage still grows over
//      time rather than being complete from day one — see
//      backfill-team-history.mjs's BUDGET WARNING for why the backfill is
//      deliberately gradual, not instant.
//   - Small samples produce unstable estimates. This module refuses to
//      return a confident model for either team below the effective
//      minSampleMatches — it returns `null` rather than fabricating a
//      number from 2-3 games.
//   - If a fixture's team_id is missing (e.g. an older, pre-migration row,
//      or a data source that didn't supply one), this module returns
//      unavailable rather than falling back to name matching — the whole
//      point of the ID-based approach is not reintroducing that fragility.
//   - This model has NO knowledge of injuries, suspensions, lineup news,
//      weather, or anything a bookmaker's live market pricing already
//      accounts for. It should supplement bookmaker consensus, not
//      override it — see the integration notes at the bottom of this file.
//   - The exact-scoreline ranking is the SAME grid the market
//      probabilities are already derived from — it is not a separate,
//      more-precise model. A single scoreline pick is inherently a much
//      lower-probability, lower-hit-rate claim than a market like
//      "Over 1.5 Goals" (which sums many grid cells together). That's
//      expected for an exact-score feature, not a bug — never inflate or
//      round this to look more confident than the math actually is.
// ---------------------------------------------------------------------------

// Default minimum graded matches (at the relevant venue) a team needs
// before its scoring profile is trusted at all. Exported so callers that
// want to reason about or display the default (e.g. a report script) can
// reference it instead of hardcoding "5" a second time. See the
// SELF-IMPROVEMENT note above for how this differs from a per-call
// override.
export const DEFAULT_MIN_SAMPLE_MATCHES = 5;

// How far back to look for both the team's own profile and the league
// baseline — recent form matters more than a full season, and this keeps
// query size bounded as history accumulates over time.
const TEAM_LOOKBACK_MATCHES = 15;
const LEAGUE_BASELINE_LOOKBACK_DAYS = 120;

// Goal grid used for the Poisson summation — 0 to this many goals per side
// covers effectively all realistic football scorelines (P(10+ goals) for
// one side is vanishingly small even for a very strong attack).
const MAX_GOALS_MODELED = 8;

// How many ranked scorelines getOwnModelForFixture returns (topScorelines).
// topScoreline is always just the first of these. 3 is enough for a caller
// that wants to show "or maybe 2-0 / 1-1" alternates without hauling the
// full 81-cell grid around.
const TOP_SCORELINES_RETURNED = 3;

function poissonPMF(k, lambda) {
  // P(exactly k goals) given expected goals lambda.
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial;
}

/**
 * Reads a team's goal-scoring profile at a specific venue from the
 * `team_match_history` view (see supabase/migrations/004_team_identity.sql)
 * — most recent TEAM_LOOKBACK_MATCHES games at that venue only, since home
 * and away scoring rates are genuinely different and shouldn't be blended.
 * Queried by team_id, NOT team name — see the TEAM IDENTITY note above.
 *
 * `minSampleMatches` lets a caller apply a stricter (or looser) trust
 * threshold than DEFAULT_MIN_SAMPLE_MATCHES without changing this
 * module's own default for every other caller — see the SELF-IMPROVEMENT
 * note at the top of this file.
 *
 * Returns null if teamId is missing, or fewer than minSampleMatches are
 * on record — the caller must treat that as "no model available for this
 * fixture," not as zero goals.
 */
async function getTeamVenueProfile(supabase, teamId, venue, minSampleMatches = DEFAULT_MIN_SAMPLE_MATCHES) {
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

/**
 * Computes this league's own average home/away goals-per-game from graded
 * fixtures — the normalizing baseline every team's individual rate gets
 * compared against. Falls back to sane generic football averages
 * (roughly the real-world long-run figures) if the league doesn't yet
 * have enough graded history of its own — a brand-new regional league
 * added via resolve-leagues.mjs won't have this yet, and guessing a
 * plausible generic baseline is safer than returning nothing.
 *
 * Reuses the same `minSampleMatches` threshold as getTeamVenueProfile —
 * same "how much history do we trust" semantic, kept as one shared
 * concept rather than a second, separately-tuned constant.
 */
async function getLeagueBaseline(supabase, league, minSampleMatches = DEFAULT_MIN_SAMPLE_MATCHES) {
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

  if (error || !data || data.length < minSampleMatches) {
    return { avgHomeGoals: GENERIC_HOME_AVG, avgAwayGoals: GENERIC_AWAY_AVG, sampleSize: 0, isGeneric: true };
  }

  const avgHomeGoals = data.reduce((sum, r) => sum + r.final_home_score, 0) / data.length;
  const avgAwayGoals = data.reduce((sum, r) => sum + r.final_away_score, 0) / data.length;
  return { avgHomeGoals, avgAwayGoals, sampleSize: data.length, isGeneric: false };
}

/**
 * Builds the full home-goals × away-goals probability grid for a pair of
 * expected-goals figures. Extracted as its own step so BOTH the
 * market-probability aggregation AND the exact-scoreline ranking below can
 * be derived from the SAME grid instead of computing it twice per fixture.
 */
function buildGoalGrid(homeXG, awayXG) {
  const grid = [];
  for (let h = 0; h <= MAX_GOALS_MODELED; h++) {
    grid.push([]);
    for (let a = 0; a <= MAX_GOALS_MODELED; a++) {
      grid[h].push(poissonPMF(h, homeXG) * poissonPMF(a, awayXG));
    }
  }
  return grid;
}

/**
 * Sums the full home-goals × away-goals probability grid into every market
 * this model can speak to. Sums the full grid rather than any shortcut
 * formula, so results stay exact for whatever MAX_GOALS_MODELED is set to.
 */
function marketProbabilitiesFromGrid(grid) {
  let homeWin = 0, awayWin = 0, draw = 0, bttsYes = 0;
  const overThreshold = { 1.5: 0, 2.5: 0, 3.5: 0 };

  for (let h = 0; h < grid.length; h++) {
    for (let a = 0; a < grid[h].length; a++) {
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
 * Turns a pair of expected-goals figures into real probabilities for every
 * market this model can speak to. Kept as a public wrapper around
 * buildGoalGrid + marketProbabilitiesFromGrid for backward compatibility
 * with any existing caller that only wants market probabilities (not the
 * scoreline ranking) from a raw (homeXG, awayXG) pair.
 */
function probabilitiesFromExpectedGoals(homeXG, awayXG) {
  return marketProbabilitiesFromGrid(buildGoalGrid(homeXG, awayXG));
}

/**
 * Ranks every cell in a goal grid by probability, highest first, and
 * returns the top `limit` as exact scorelines — e.g.
 * [{ home: 1, away: 0, probability: 0.14 }, ...]. This is the "predicted
 * exact score" feature's own selection: the single highest-probability
 * cell in the grid, not a market-level aggregate like Over/Under or Home
 * Win (which each sum many cells together and are therefore much more
 * likely to actually hit).
 */
function topScorelinesFromGrid(grid, limit = TOP_SCORELINES_RETURNED) {
  const cells = [];
  for (let h = 0; h < grid.length; h++) {
    for (let a = 0; a < grid[h].length; a++) {
      cells.push({ home: h, away: a, probability: grid[h][a] });
    }
  }
  cells.sort((x, y) => y.probability - x.probability);
  return cells.slice(0, limit);
}

/**
 * Main entry point. Returns either:
 *   { available: true, probabilities: {...}, topScoreline: {...}, topScorelines: [...], homeXG, awayXG, sampleInfo }
 *   { available: false, reason: '...' }
 *
 * `available: false` is the expected, normal outcome for most fixtures
 * early on — most teams simply won't have enough graded home/away history
 * yet, and the backfill (scripts/backfill-team-history.mjs) is
 * deliberately gradual. Callers MUST treat that as "no second opinion for
 * this fixture" (or, for scripts/generate-score-predictions.mjs, "no
 * exact-score prediction for this fixture today") — never fabricate a
 * fallback guess. The bookmaker consensus in lib/markets.mjs remains fully
 * sufficient on its own for ticket generation regardless.
 *
 * `homeTeamId`/`awayTeamId` MUST be API-Football's own numeric team IDs
 * (see f.teams.home.id / f.teams.away.id in a /fixtures response) — not
 * team names. If either is missing, this returns unavailable rather than
 * falling back to name matching.
 *
 * `minSampleMatches` (optional): overrides DEFAULT_MIN_SAMPLE_MATCHES for
 * this call only — see the SELF-IMPROVEMENT note at the top of this file.
 * `sampleInfo.homeTeamMatches`/`awayTeamMatches` in the returned object is
 * always the REAL count the model found (regardless of which threshold
 * was used to decide availability), so callers like scripts/generate-
 * score-predictions.mjs can persist it for later, genuine backtesting of
 * "what would a different threshold have done" — see
 * scripts/self-tune-score-model.mjs.
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

  const grid = buildGoalGrid(homeXG, awayXG);
  const probabilities = marketProbabilitiesFromGrid(grid);
  const topScorelines = topScorelinesFromGrid(grid);
  const topScoreline = topScorelines[0] ?? null;

  return {
    available: true,
    probabilities,
    topScoreline,
    topScorelines,
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
// INTEGRATION NOTES:
//
// 1. Cross-check (scripts/lib/modelCrossCheck.mjs), intended as a
//    ticket-selection safety net (Option A: the own model can only flag a
//    bookmaker-chosen pick as too uncertain, never add confidence on its
//    own) — see the KNOWN VERIFICATION ITEM below.
//
// 2. Exact-score predictions (scripts/generate-score-predictions.mjs), the
//    first caller to surface topScoreline/topScorelines directly to users
//    rather than using this module purely as an internal cross-check.
//    Deliberately broader coverage than ticket generation — every eligible
//    fixture the model has enough history for, not just fixtures picked
//    for a ticket — and deliberately skips fixtures where `available` is
//    false rather than ever fabricating a scoreline guess. Its own
//    minSampleMatches is read live from score_model_tuning_state and
//    bounded-auto-tuned weekly by scripts/self-tune-score-model.mjs,
//    completely independent of this file's DEFAULT_MIN_SAMPLE_MATCHES.
//
// KNOWN VERIFICATION ITEM (pre-existing, not touched by the exact-score
// feature above): scripts/lib/modelCrossCheck.mjs imports a
// `computeMatchProbabilities` export from this file, but this file only
// ever exports `getOwnModelForFixture` and `DEFAULT_MIN_SAMPLE_MATCHES` —
// no such export exists. modelCrossCheck.mjs's own header already flags
// this as an unverified assumption. As written, anything that actually
// imports modelCrossCheck.mjs would throw at load time. Left as-is here
// since fixing it means deciding modelCrossCheck.mjs's real intended
// shape, which is outside this feature's scope — flagging again so it
// doesn't get lost.
// ---------------------------------------------------------------------------
