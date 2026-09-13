// ---------------------------------------------------------------------------
// Odd Saint — grading
// Finds fixtures still marked 'pending' whose kickoff was a while ago, pulls
// the final score from API-Football, and settles them 'green' or 'red'
// based on whether the picked market actually hit. Runs a few times a day
// via .github/workflows/grade-tickets.yml.
//
// BUDGET SAFETY: shares the same 100-requests/day account as
// generate-tickets.mjs (see the budget comment there for the full daily
// arithmetic). This file's own spend is already minimal — one batched
// /fixtures?ids= call per run, only when there's actually something
// pending — but it still respects the live daily-budget circuit breaker in
// scripts/lib/apiFootball.mjs: if the account is already at/near its daily
// limit (e.g. from a manual generate-tickets re-run or resolve-leagues.mjs
// earlier today), this skips grading for the run rather than risking a 429
// or crashing. Nothing is lost — pending fixtures stay pending and get
// picked up on a later run.
// ---------------------------------------------------------------------------
import { getFixturesByIds, ApiFootballBudgetExhaustedError } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { settleMarket } from './lib/markets.mjs';

// Only check fixtures whose kickoff was at least this many hours ago —
// gives the match (plus stoppage time) room to actually finish before we
// bother querying it.
const MIN_HOURS_SINCE_KICKOFF = 2.5;

// Caps how many fixtures we re-check per run, to stay within API-Football's
// free-plan daily request budget alongside the generation script.
const MAX_FIXTURES_PER_RUN = 40;

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']); // API-Football short status codes

async function main() {
  const supabase = getSupabaseAdmin();

  const cutoff = new Date(Date.now() - MIN_HOURS_SINCE_KICKOFF * 60 * 60 * 1000).toISOString();

  const { data: pendingFixtures, error } = await supabase
    .from('fixtures')
    .select('id, market')
    .eq('result_status', 'pending')
    .lt('kickoff', cutoff)
    .limit(MAX_FIXTURES_PER_RUN);

  if (error) throw error;

  if (!pendingFixtures || pendingFixtures.length === 0) {
    console.log('No pending fixtures old enough to grade yet.');
    return;
  }

  console.log(`Checking ${pendingFixtures.length} pending fixture(s)...`);

  const marketById = new Map(pendingFixtures.map((f) => [f.id, f.market]));

  let results;
  try {
    results = await getFixturesByIds(pendingFixtures.map((f) => f.id));
  } catch (err) {
    if (err instanceof ApiFootballBudgetExhaustedError) {
      console.warn(
        `${err.message} — skipping grading this run. These ${pendingFixtures.length} fixture(s) remain pending ` +
          'and will be retried on a later run.'
      );
      return;
    }
    throw err; // any other failure (network, credentials, etc.) is a real problem
  }

  let graded = 0;
  for (const r of results) {
    const fixtureId = r.fixture.id;
    const shortStatus = r.fixture.status?.short;
    if (!FINISHED_STATUSES.has(shortStatus)) continue; // still in progress or postponed

    const homeScore = r.goals?.home;
    const awayScore = r.goals?.away;
    if (homeScore === null || awayScore === null || homeScore === undefined || awayScore === undefined) {
      continue; // no final score yet, skip
    }

    const market = marketById.get(fixtureId);
    const won = settleMarket(market, homeScore, awayScore);
    if (won === null) continue; // unrecognized market, leave pending for manual review

    const { error: updateErr } = await supabase
      .from('fixtures')
      .update({
        final_home_score: homeScore,
        final_away_score: awayScore,
        result_status: won ? 'green' : 'red',
      })
      .eq('id', fixtureId);

    if (updateErr) {
      console.error(`Failed to update fixture ${fixtureId}:`, updateErr.message);
      continue;
    }
    graded++;
  }

  console.log(`Graded ${graded} fixture(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
