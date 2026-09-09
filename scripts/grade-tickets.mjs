// ---------------------------------------------------------------------------
// Odd Saint — grading
//
// Finds fixtures still marked 'pending' whose kickoff was a while ago, pulls
// the final score from whichever provider originally supplied that fixture,
// and settles them 'green' or 'red' via the shared market catalog.
//
// AS OF THIS UPDATE: fixtures come from TWO providers (see
// scripts/generate-tickets.mjs for the full rationale) — the `source`
// column (added in supabase/migrations/004_multi_source_fixtures.sql) says
// which one, and this script branches accordingly:
//   - source = 'api_football'      -> re-check via scripts/lib/apiFootball.mjs,
//                                      using the fixture's own `id` directly.
//   - source = 'football_data_org' -> re-check via scripts/lib/footballDataOrg.mjs,
//                                      after subtracting MAJORS_ID_OFFSET to
//                                      recover football-data.org's native ID
//                                      (see generate-tickets.mjs for why the
//                                      offset exists).
//
// Runs a few times a day via .github/workflows/grade-tickets.yml.
// ---------------------------------------------------------------------------
import { getFixturesByIds } from './lib/apiFootball.mjs';
import { getMatchesByIds, FDO_FINISHED_STATUSES } from './lib/footballDataOrg.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { settleMarket } from './lib/markets.mjs';

const MIN_HOURS_SINCE_KICKOFF = 2.5;
const MAX_FIXTURES_PER_RUN = 40;

// Must match MIN_CONFIDENCE... no — must match MAJORS_ID_OFFSET in
// scripts/generate-tickets.mjs. Kept as a separate constant here (rather
// than importing it) because generate-tickets.mjs calls main() at module
// load time — importing anything from it as a library would re-run the
// entire generation pipeline as a side effect of grading. Same
// duplicate-with-a-comment pattern already used by
// scripts/analyze-performance.mjs's CURRENT_LIVE_MIN_CONFIDENCE. If you
// change the offset in generate-tickets.mjs, update this line too.
const MAJORS_ID_OFFSET = 10_000_000_000;

const API_FOOTBALL_FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);

async function gradeApiFootballFixtures(supabase, fixtures) {
  if (fixtures.length === 0) return 0;

  const marketById = new Map(fixtures.map((f) => [f.id, f.market]));
  const results = await getFixturesByIds(fixtures.map((f) => f.id));

  let graded = 0;
  for (const r of results) {
    const fixtureId = r.fixture.id;
    const shortStatus = r.fixture.status?.short;
    if (!API_FOOTBALL_FINISHED_STATUSES.has(shortStatus)) continue;

    const homeScore = r.goals?.home;
    const awayScore = r.goals?.away;
    if (homeScore === null || awayScore === null || homeScore === undefined || awayScore === undefined) {
      continue;
    }

    const market = marketById.get(fixtureId);
    const won = settleMarket(market, homeScore, awayScore);
    if (won === null) continue;

    const { error: updateErr } = await supabase
      .from('fixtures')
      .update({
        final_home_score: homeScore,
        final_away_score: awayScore,
        result_status: won ? 'green' : 'red',
      })
      .eq('id', fixtureId)
      .eq('source', 'api_football');

    if (updateErr) {
      console.error(`Failed to update API-Football fixture ${fixtureId}:`, updateErr.message);
      continue;
    }
    graded++;
  }
  return graded;
}

async function gradeFootballDataOrgFixtures(supabase, fixtures) {
  if (fixtures.length === 0) return 0;

  // Recover football-data.org's own native IDs — the `fixtures.id` column
  // stores id + MAJORS_ID_OFFSET (see generate-tickets.mjs) to avoid
  // colliding with API-Football's native IDs in the same shared column.
  const nativeIdToStoredId = new Map();
  const marketByStoredId = new Map();
  fixtures.forEach((f) => {
    const nativeId = f.id - MAJORS_ID_OFFSET;
    nativeIdToStoredId.set(nativeId, f.id);
    marketByStoredId.set(f.id, f.market);
  });

  const results = await getMatchesByIds(Array.from(nativeIdToStoredId.keys()));

  let graded = 0;
  for (const match of results) {
    if (!FDO_FINISHED_STATUSES.has(match.status)) continue;

    const homeScore = match.score?.fullTime?.home;
    const awayScore = match.score?.fullTime?.away;
    if (homeScore === null || awayScore === null || homeScore === undefined || awayScore === undefined) {
      continue;
    }

    const storedId = nativeIdToStoredId.get(match.id);
    if (storedId === undefined) continue;

    const market = marketByStoredId.get(storedId);
    const won = settleMarket(market, homeScore, awayScore);
    if (won === null) continue;

    const { error: updateErr } = await supabase
      .from('fixtures')
      .update({
        final_home_score: homeScore,
        final_away_score: awayScore,
        result_status: won ? 'green' : 'red',
      })
      .eq('id', storedId)
      .eq('source', 'football_data_org');

    if (updateErr) {
      console.error(`Failed to update football-data.org fixture ${storedId}:`, updateErr.message);
      continue;
    }
    graded++;
  }
  return graded;
}

async function main() {
  const supabase = getSupabaseAdmin();

  const cutoff = new Date(Date.now() - MIN_HOURS_SINCE_KICKOFF * 60 * 60 * 1000).toISOString();

  const { data: pendingFixtures, error } = await supabase
    .from('fixtures')
    .select('id, market, source')
    .eq('result_status', 'pending')
    .lt('kickoff', cutoff)
    .limit(MAX_FIXTURES_PER_RUN);

  if (error) throw error;

  if (!pendingFixtures || pendingFixtures.length === 0) {
    console.log('No pending fixtures old enough to grade yet.');
    return;
  }

  // `source` defaults to 'api_football' at the database level (see the
  // migration) so rows written before this split still route correctly.
  const apiFootballFixtures = pendingFixtures.filter((f) => (f.source ?? 'api_football') === 'api_football');
  const footballDataOrgFixtures = pendingFixtures.filter((f) => f.source === 'football_data_org');

  console.log(
    `Checking ${pendingFixtures.length} pending fixture(s): ` +
      `${apiFootballFixtures.length} api_football, ${footballDataOrgFixtures.length} football_data_org.`
  );

  let totalGraded = 0;
  try {
    totalGraded += await gradeApiFootballFixtures(supabase, apiFootballFixtures);
  } catch (err) {
    console.error('Grading API-Football fixtures failed:', err.message);
  }

  try {
    totalGraded += await gradeFootballDataOrgFixtures(supabase, footballDataOrgFixtures);
  } catch (err) {
    console.error('Grading football-data.org fixtures failed:', err.message);
  }

  console.log(`Graded ${totalGraded} fixture(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
