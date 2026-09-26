// ---------------------------------------------------------------------------
// Odd Saint — grading
// Finds fixtures still marked 'pending' whose kickoff was a while ago, pulls
// the final score from API-Football (the app's sole football data provider
// — see scripts/lib/apiFootball.mjs), and settles them 'green' or 'red'
// based on whether the picked market actually hit. Runs a few times a day
// via .github/workflows/grade-tickets.yml.
//
// AS OF THE EXACT-SCORE-PREDICTIONS FEATURE, this script ALSO grades
// `score_predictions` (see supabase/migrations/005_score_predictions.sql
// and scripts/generate-score-predictions.mjs) in the same run, sharing ONE
// batched getFixturesByIds() call with the existing `fixtures` grading
// below — the two tables use the same API-Football fixture ID space, so a
// fixture that was both ticketed AND predicted only ever gets fetched
// once. Grading `score_predictions` is a much stricter, lower-hit-rate
// check than `fixtures` (exact scoreline match, not just "did the picked
// market hit") — that's expected for this feature, never treat it as a
// bug or round it to look more accurate than it is.
//
// PRE-EXISTING BUG FIXED IN PASSING: this file previously imported and
// called `detectApiPlan` from scripts/lib/apiFootball.mjs, but that module
// does not export any such function (only getFixturesForDate,
// getOddsForFixture, getFixturesByIds, getLeaguesByCountry). That call
// would have thrown on every run. Removed here since this file had to be
// touched anyway for the score_predictions change above — unrelated to
// this feature, flagging it explicitly per project rule #30/#33 rather
// than silently folding it in. If API-plan detection/throttling was
// actually wanted here, that needs its own real implementation in
// apiFootball.mjs, not a call to a function that was never defined.
// ---------------------------------------------------------------------------
import { getFixturesByIds } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { settleMarket } from './lib/markets.mjs';

// Only check fixtures whose kickoff was at least this many hours ago —
// gives the match (plus stoppage time) room to actually finish before we
// bother querying it. Shared by both `fixtures` and `score_predictions`
// grading below — a match is either finished or it isn't, regardless of
// which table is tracking it.
const MIN_HOURS_SINCE_KICKOFF = 2.5;

// Caps how many `fixtures` rows we re-check per run, to stay within
// API-Football's daily request budget alongside the generation script.
const MAX_FIXTURES_PER_RUN = 40;

// score_predictions needs no per-fixture odds lookups anywhere in its own
// pipeline, and grading it costs nothing extra here beyond what the shared
// getFixturesByIds() call already fetches for `fixtures` — so a much
// higher per-run cap is safe. The real constraint is just Supabase row
// volume and the size of one getFixturesByIds() call, not API budget.
const MAX_SCORE_PREDICTIONS_PER_RUN = 200;

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']); // API-Football short status codes

async function main() {
  const supabase = getSupabaseAdmin();

  const cutoff = new Date(Date.now() - MIN_HOURS_SINCE_KICKOFF * 60 * 60 * 1000).toISOString();

  const { data: pendingFixturesData, error: fixturesErr } = await supabase
    .from('fixtures')
    .select('id, market')
    .eq('result_status', 'pending')
    .lt('kickoff', cutoff)
    .limit(MAX_FIXTURES_PER_RUN);
  if (fixturesErr) throw fixturesErr;

  const { data: pendingPredictionsData, error: predictionsErr } = await supabase
    .from('score_predictions')
    .select('id, predicted_home_score, predicted_away_score')
    .eq('result_status', 'pending')
    .lt('kickoff', cutoff)
    .limit(MAX_SCORE_PREDICTIONS_PER_RUN);
  if (predictionsErr) throw predictionsErr;

  const pendingFixtures = pendingFixturesData ?? [];
  const pendingPredictions = pendingPredictionsData ?? [];

  if (pendingFixtures.length === 0 && pendingPredictions.length === 0) {
    console.log('No pending fixtures or score predictions old enough to grade yet.');
    return;
  }

  // One shared batched lookup for BOTH tables — they share the same
  // API-Football fixture ID space, so a fixture that's both a ticket leg
  // AND a score prediction is only ever fetched once.
  const idSet = new Set([...pendingFixtures.map((f) => f.id), ...pendingPredictions.map((p) => p.id)]);
  console.log(
    `Checking ${idSet.size} pending fixture(s) this run ` +
      `(${pendingFixtures.length} ticket-graded, ${pendingPredictions.length} score-predicted, overlap not double-counted)...`
  );

  const results = await getFixturesByIds(Array.from(idSet));
  const resultById = new Map(results.map((r) => [r.fixture.id, r]));

  /** Returns { homeScore, awayScore } if this fixture is finished with a real final score, else null. */
  function finalScoreFor(fixtureId) {
    const r = resultById.get(fixtureId);
    if (!r) return null;
    const shortStatus = r.fixture.status?.short;
    if (!FINISHED_STATUSES.has(shortStatus)) return null; // still in progress or postponed
    const homeScore = r.goals?.home;
    const awayScore = r.goals?.away;
    if (homeScore === null || awayScore === null || homeScore === undefined || awayScore === undefined) {
      return null; // no final score yet
    }
    return { homeScore, awayScore };
  }

  // -------------------------------------------------------------------
  // Grade `fixtures` (ticket legs) — same logic as before this change.
  // -------------------------------------------------------------------
  let gradedFixtures = 0;
  for (const f of pendingFixtures) {
    const final = finalScoreFor(f.id);
    if (!final) continue;

    const won = settleMarket(f.market, final.homeScore, final.awayScore);
    if (won === null) continue; // unrecognized market, leave pending for manual review

    const { error: updateErr } = await supabase
      .from('fixtures')
      .update({
        final_home_score: final.homeScore,
        final_away_score: final.awayScore,
        result_status: won ? 'green' : 'red',
      })
      .eq('id', f.id);

    if (updateErr) {
      console.error(`Failed to update fixture ${f.id}:`, updateErr.message);
      continue;
    }
    gradedFixtures++;
  }
  console.log(`Graded ${gradedFixtures} fixture(s).`);

  // -------------------------------------------------------------------
  // Grade `score_predictions` — exact-scoreline check. 'correct' only on
  // an EXACT match of both scores — a much stricter, lower hit-rate bar
  // than the market-based green/red grading above. Never falsify this to
  // make the feature look more accurate than the model actually is.
  // -------------------------------------------------------------------
  let gradedPredictions = 0;
  for (const p of pendingPredictions) {
    const final = finalScoreFor(p.id);
    if (!final) continue;

    const correct = final.homeScore === p.predicted_home_score && final.awayScore === p.predicted_away_score;

    const { error: updateErr } = await supabase
      .from('score_predictions')
      .update({
        actual_home_score: final.homeScore,
        actual_away_score: final.awayScore,
        result_status: correct ? 'correct' : 'incorrect',
      })
      .eq('id', p.id);

    if (updateErr) {
      console.error(`Failed to update score prediction ${p.id}:`, updateErr.message);
      continue;
    }
    gradedPredictions++;
  }
  console.log(`Graded ${gradedPredictions} score prediction(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
