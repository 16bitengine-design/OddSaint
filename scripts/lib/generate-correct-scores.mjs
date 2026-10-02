// ---------------------------------------------------------------------------
// Odd Saint — correct-score predictions (generate + grade)
//
// Standalone from the ticket pipeline: nothing here reads or writes
// tickets/ticket_matches/fixtures. Each run:
//   1. GRADES pending predictions whose match has finished.
//   2. GENERATES predictions for today's fixtures that don't have one yet.
//
// Source of truth for probabilities is the Poisson model in
// scripts/lib/teamModel.mjs. A fixture only gets a prediction if that model
// is `available` (both teams have MIN_SAMPLE_MATCHES of home/away history in
// team_match_history, looked up by API-Football team ID). No model → no
// prediction; nothing is fabricated or guessed from odds.
//
// Predictions are inserted with ignoreDuplicates, so a prediction is written
// once and never changes — re-runs cannot rewrite history.
//
// Cost: 1 /fixtures request per run for generation + 1 for grading.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getFixturesForDate, getFixturesByIds } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { getOwnModelForFixture } from './lib/teamModel.mjs';
import { topScorelines } from './lib/scorelines.mjs';
import { isAmateurOrYouthLeague } from './lib/leagueQuality.mjs';
import { isWomensCompetition } from './lib/womensLeagueFilter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEAGUES_JSON_PATH = join(__dirname, 'lib', 'leagues.json');

const MIN_HOURS_TO_KICKOFF = 2; // same lead-time rule as ticket generation
const MIN_HOURS_SINCE_KICKOFF = 2.5; // same grading delay as grade-tickets.mjs
const MAX_GRADE_PER_RUN = 60;
const SCORES_PER_FIXTURE = 3;
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);
// API-Football's /fixtures?ids= accepts at most 20 IDs per request — a larger
// list is rejected, which would leave every pending prediction ungraded.
const FIXTURE_IDS_PER_REQUEST = 20;

function loadAllowlist() {
  try {
    const leagues = JSON.parse(readFileSync(LEAGUES_JSON_PATH, 'utf8'));
    if (Array.isArray(leagues) && leagues.length > 0) return new Set(leagues.map((l) => l.id));
  } catch {
    // fall through
  }
  throw new Error('scripts/lib/leagues.json missing or empty — run the "Resolve League IDs" workflow first.');
}

// ---------------------------------------------------------------------------
// 1. Grade
// ---------------------------------------------------------------------------
async function gradePending(supabase) {
  const cutoff = new Date(Date.now() - MIN_HOURS_SINCE_KICKOFF * 3_600_000).toISOString();
  const { data: pending, error } = await supabase
    .from('correct_score_predictions')
    .select('fixture_id, top_scores')
    .eq('result_status', 'pending')
    .lt('kickoff', cutoff)
    .limit(MAX_GRADE_PER_RUN);
  if (error) throw error;
  if (!pending || pending.length === 0) {
    console.log('No pending correct-score predictions to grade.');
    return;
  }

  const byId = new Map(pending.map((p) => [p.fixture_id, p]));
  const ids = pending.map((p) => p.fixture_id);
  const results = [];
  for (let i = 0; i < ids.length; i += FIXTURE_IDS_PER_REQUEST) {
    try {
      results.push(...(await getFixturesByIds(ids.slice(i, i + FIXTURE_IDS_PER_REQUEST))));
    } catch (err) {
      // One failed batch must not stop the others from being graded.
      console.warn(`Grading batch starting at ${i} failed:`, err.message);
    }
  }

  let graded = 0;
  for (const r of results) {
    if (!FINISHED_STATUSES.has(r.fixture?.status?.short)) continue;

    // Correct score is settled on the 90-minute score. `goals` includes
    // extra time for AET/PEN, so prefer score.fulltime when present.
    const home = r.score?.fulltime?.home ?? r.goals?.home;
    const away = r.score?.fulltime?.away ?? r.goals?.away;
    if (home === null || home === undefined || away === null || away === undefined) continue;

    const prediction = byId.get(r.fixture.id);
    if (!prediction) continue;

    const scores = prediction.top_scores ?? [];
    const top = scores[0];
    const topHit = !!top && top.home === home && top.away === away;
    const anyHit = scores.some((s) => s.home === home && s.away === away);

    const { error: updateErr } = await supabase
      .from('correct_score_predictions')
      .update({
        final_home_score: home,
        final_away_score: away,
        result_status: topHit ? 'hit' : 'miss',
        top3_hit: anyHit,
      })
      .eq('fixture_id', r.fixture.id);
    if (updateErr) {
      console.error(`Failed to grade fixture ${r.fixture.id}:`, updateErr.message);
      continue;
    }
    graded++;
  }
  console.log(`Graded ${graded} correct-score prediction(s).`);
}

// ---------------------------------------------------------------------------
// 2. Generate
// ---------------------------------------------------------------------------
async function generateForToday(supabase, now) {
  const allowlist = loadAllowlist();
  const today = now.toISOString().slice(0, 10);

  const fixtures = await getFixturesForDate(today);
  const eligible = fixtures.filter((f) => {
    const kickoffMs = new Date(f.fixture?.date).getTime();
    return (
      allowlist.has(f.league?.id) &&
      !isAmateurOrYouthLeague(f.league?.name) &&
      !isWomensCompetition(f.league?.name) &&
      f.fixture?.status?.short === 'NS' &&
      kickoffMs - now.getTime() >= MIN_HOURS_TO_KICKOFF * 3_600_000
    );
  });
  console.log(`${eligible.length} eligible fixture(s) today out of ${fixtures.length}.`);
  if (eligible.length === 0) return;

  // Skip fixtures that already have a prediction (they're immutable anyway).
  const { data: existing, error: existingErr } = await supabase
    .from('correct_score_predictions')
    .select('fixture_id')
    .in('fixture_id', eligible.map((f) => f.fixture.id));
  if (existingErr) throw existingErr;
  const already = new Set((existing ?? []).map((r) => r.fixture_id));

  const rows = [];
  let noModel = 0;
  for (const f of eligible) {
    if (already.has(f.fixture.id)) continue;

    const model = await getOwnModelForFixture(supabase, {
      league: f.league?.name,
      homeTeamId: f.teams?.home?.id,
      awayTeamId: f.teams?.away?.id,
      homeTeamName: f.teams?.home?.name,
      awayTeamName: f.teams?.away?.name,
    });
    if (!model.available) {
      noModel++;
      continue;
    }

    rows.push({
      fixture_id: f.fixture.id,
      prediction_date: today,
      league: f.league?.name ?? 'Unknown League',
      country: f.league?.country ?? 'Unknown',
      home_team: f.teams?.home?.name ?? 'Home',
      away_team: f.teams?.away?.name ?? 'Away',
      kickoff: f.fixture.date,
      top_scores: topScorelines(model.homeXG, model.awayXG, SCORES_PER_FIXTURE),
      home_xg: model.homeXG,
      away_xg: model.awayXG,
      home_sample: model.sampleInfo?.homeTeamMatches ?? null,
      away_sample: model.sampleInfo?.awayTeamMatches ?? null,
    });
  }

  console.log(`${rows.length} new prediction(s); ${noModel} fixture(s) skipped for insufficient team history.`);
  if (rows.length === 0) return;

  const { error } = await supabase
    .from('correct_score_predictions')
    .upsert(rows, { onConflict: 'fixture_id', ignoreDuplicates: true });
  if (error) throw error;
  console.log(`Wrote ${rows.length} correct-score prediction(s).`);
}

async function main() {
  const supabase = getSupabaseAdmin();
  await gradePending(supabase);
  await generateForToday(supabase, new Date());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
