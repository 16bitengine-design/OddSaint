// ---------------------------------------------------------------------------
// Odd Saint — team history backfill (run manually / periodically, NOT part
// of the daily generation pipeline)
//
// Proactively pulls each known team's recent finished-match history from
// API-Football (last N fixtures per team, via /fixtures?team={id}&last={n})
// and stores it in team_results_history — independent of whether that team
// has ever appeared in a generated ticket. This is what actually builds a
// real per-team performance database: without this, scripts/lib/teamModel.mjs
// only ever sees history for teams that happened to get picked before,
// which is a small, biased slice. This pulls directly from the same
// licensed data source (API-Football) the rest of the pipeline already
// pays for — no other website is touched.
//
// BUDGET WARNING: depends on scripts/lib/teams.json (run the "Resolve Team
// IDs" workflow first). Costs one /fixtures request PER TEAM processed. A
// single top-flight league is already ~18-20 teams; across every league in
// teams.json that's easily hundreds — far more than one run should spend
// against a free-tier daily API cap. MAX_TEAMS_PER_RUN below caps each run
// to a small batch, always prioritizing whichever teams have never been
// backfilled (or were backfilled longest ago), tracked in
// scripts/lib/backfillProgress.json (committed back to the repo by the
// workflow — same pattern as leagues.json/teams.json). Run this repeatedly
// (the weekly schedule in backfill-team-history.yml, or manual triggers to
// speed things up) to gradually cycle through the whole team pool across
// several runs rather than exhausting the daily budget in one.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getFixturesForTeam } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEAMS_PATH = join(__dirname, 'lib', 'teams.json');
const PROGRESS_PATH = join(__dirname, 'lib', 'backfillProgress.json');

// How many teams get a fresh history pull in a single run. Tune this down
// if you're bumping into API-Football's daily request cap alongside the
// generate/grade jobs, tune it up if you have headroom — see the BUDGET
// WARNING above before raising it. Kept as an experiment-tagged constant,
// not a guarantee, same spirit as MIN_CONFIDENCE in generate-tickets.mjs.
const MAX_TEAMS_PER_RUN = 15;

// How many of each team's most recent finished fixtures to pull. Matches
// TEAM_LOOKBACK_MATCHES in lib/teamModel.mjs — no point pulling more than
// the model will ever actually look at.
const FIXTURES_PER_TEAM = 20;

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']); // same set grade-tickets.mjs treats as final

function loadTeams() {
  if (!existsSync(TEAMS_PATH)) {
    throw new Error(
      'scripts/lib/teams.json not found — run the "Resolve Team IDs" workflow first; this script depends on it.'
    );
  }
  return JSON.parse(readFileSync(TEAMS_PATH, 'utf8'));
}

function loadProgress() {
  if (!existsSync(PROGRESS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'));
  } catch {
    return {}; // corrupted/empty progress file — safer to start fresh than crash the run
  }
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2) + '\n');
}

/** Never-backfilled teams first, then oldest-backfilled-first — so repeated runs naturally cycle through the whole pool instead of re-processing the same teams every time. */
function selectBatch(teams, progress, batchSize) {
  const ranked = [...teams].sort((a, b) => {
    const lastA = progress[a.id] ?? null;
    const lastB = progress[b.id] ?? null;
    if (lastA === null && lastB === null) return 0;
    if (lastA === null) return -1;
    if (lastB === null) return 1;
    return new Date(lastA).getTime() - new Date(lastB).getTime();
  });
  return ranked.slice(0, batchSize);
}

/** Turns one API-Football fixture into a team_results_history row from `teamId`'s own perspective, or null if unusable (not finished, missing scores, or teamId genuinely wasn't in this fixture). */
function toHistoryRow(fixture, teamId, teamName) {
  const shortStatus = fixture.fixture?.status?.short;
  if (!FINISHED_STATUSES.has(shortStatus)) return null;

  const homeId = fixture.teams?.home?.id;
  const awayId = fixture.teams?.away?.id;
  const homeGoals = fixture.goals?.home;
  const awayGoals = fixture.goals?.away;
  if (homeGoals === null || awayGoals === null || homeGoals === undefined || awayGoals === undefined) return null;

  let venue, goalsFor, goalsAgainst, opponentId, opponentName;
  if (homeId === teamId) {
    venue = 'home';
    goalsFor = homeGoals;
    goalsAgainst = awayGoals;
    opponentId = awayId ?? null;
    opponentName = fixture.teams?.away?.name ?? 'Unknown';
  } else if (awayId === teamId) {
    venue = 'away';
    goalsFor = awayGoals;
    goalsAgainst = homeGoals;
    opponentId = homeId ?? null;
    opponentName = fixture.teams?.home?.name ?? 'Unknown';
  } else {
    return null; // shouldn't happen given we queried by this team, but don't trust blindly
  }

  return {
    fixture_id: fixture.fixture.id,
    team_id: teamId,
    team_name: teamName,
    opponent_id: opponentId,
    opponent_name: opponentName,
    venue,
    goals_for: goalsFor,
    goals_against: goalsAgainst,
    league: fixture.league?.name ?? 'Unknown League',
    kickoff: fixture.fixture?.date,
  };
}

async function main() {
  const teams = loadTeams();
  const progress = loadProgress();
  const batch = selectBatch(teams, progress, MAX_TEAMS_PER_RUN);

  if (batch.length === 0) {
    console.log('No teams available to backfill — scripts/lib/teams.json is empty. Run "Resolve Team IDs" first.');
    return;
  }

  console.log(`Backfilling history for ${batch.length} team(s) this run (of ${teams.length} known team(s)).`);

  const supabase = getSupabaseAdmin();
  const nowIso = new Date().toISOString();
  let totalRowsWritten = 0;

  for (const team of batch) {
    let fixtures;
    try {
      fixtures = await getFixturesForTeam(team.id, FIXTURES_PER_TEAM);
    } catch (err) {
      console.warn(`Failed to fetch history for ${team.name} (team ${team.id}):`, err.message);
      continue; // don't advance progress for this team — retry it next run
    }

    const rows = (fixtures ?? []).map((f) => toHistoryRow(f, team.id, team.name)).filter((r) => r !== null);

    if (rows.length > 0) {
      const { error } = await supabase
        .from('team_results_history')
        .upsert(rows, { onConflict: 'fixture_id,team_id' });
      if (error) {
        console.warn(`Failed to write history rows for ${team.name}:`, error.message);
        continue; // don't advance progress — retry next run
      }
      totalRowsWritten += rows.length;
    }

    progress[team.id] = nowIso;
    console.log(`${team.name}: wrote ${rows.length} finished result(s).`);
  }

  saveProgress(progress);
  console.log(`\nBackfilled ${totalRowsWritten} result row(s) across ${batch.length} team(s) this run. Progress saved.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
