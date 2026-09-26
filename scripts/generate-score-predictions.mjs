// ---------------------------------------------------------------------------
// Odd Saint — daily exact-score predictions
//
// Produces ONE predicted final scoreline per eligible fixture, for EVERY
// eligible fixture today — not just fixtures picked for a ticket (see
// scripts/generate-tickets.mjs, which is deliberately narrower: it only
// prices/tickets the safest subset). Broader coverage was the explicit
// product ask for this feature, so unlike generate-tickets.mjs this script
// does NOT skip "big clash" fixtures (see BIG_CLUBS there) — an exact-score
// guess is expected to be hard and low hit-rate on those games; that's
// normal for this kind of feature, not a bug to route around.
//
// PREDICTION SOURCE: scripts/lib/teamModel.mjs's own Poisson expected-goals
// model — previously wired in ONLY as a silent cross-check
// (scripts/lib/modelCrossCheck.mjs), never surfaced to users. This script
// is the first consumer that surfaces the model's own full scoreline grid
// directly, via the new topScoreline field on getOwnModelForFixture's
// result. Same honesty rule as the rest of the pipeline: if the model
// doesn't have enough graded history for either team yet
// (MIN_SAMPLE_MATCHES in teamModel.mjs), that fixture is skipped entirely
// rather than guessing — coverage is expected to be PARTIAL early on and
// grow as scripts/backfill-team-history.mjs accumulates more history.
//
// NEEDS NO BOOKMAKER ODDS AT ALL — the model works from `team_match_history`
// alone, so this script costs API-Football requests only for the day's
// /fixtures list (one call), not per-fixture like generate-tickets.mjs's
// /odds lookups. Cheap enough to run once daily, well ahead of the 6am EAT
// (03:00 UTC) access deadline for this feature — scheduled at 02:30 UTC
// (05:30 EAT) for a 30-minute safety margin; see the matching workflow,
// .github/workflows/generate-score-predictions.yml. This is deliberately a
// SINGLE daily run, not staggered like generate-tickets.mjs's two-slot
// release — that staggering exists for tier-ticket product reasons that
// don't apply here.
//
// LEAGUE FILTERING mirrors generate-tickets.mjs's own filters (league
// allowlist from leagues.json, amateur/youth exclusion, the EXCLUDED_TEAMS
// integrity list) so the same fixture is never treated as "eligible" in
// one place and "ineligible" in the other. Deliberately duplicated here
// rather than imported from generate-tickets.mjs — matches the existing
// project pattern of small, intentionally-separate copies for scripts with
// different purposes (see e.g. scripts/lib/supabaseAdmin.mjs vs
// src/lib/supabaseAdmin.ts, or sendBrevoEmail duplicated between
// scripts/lib/lifecycleEmail.mjs and src/lib/lifecycleEmail.ts). If the
// allowlist or exclusion rules ever change, update both this file and
// generate-tickets.mjs.
//
// ADDITIONALLY applies isWomensCompetition (scripts/lib/womensLeagueFilter.mjs)
// — that filter module already exists in the repo per the stated
// men's-only product decision, but generate-tickets.mjs does NOT currently
// import/apply it (only isAmateurOrYouthLeague is wired in there). That
// looks like a pre-existing gap in generate-tickets.mjs, not something
// fixed here — flagging it rather than silently patching an unrelated,
// already-working file. This script applies it since it's a clean, small
// addition and matches the stated product intent.
// ---------------------------------------------------------------------------
import { getFixturesForDate } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { isAmateurOrYouthLeague } from './lib/leagueQuality.mjs';
import { isWomensCompetition } from './lib/womensLeagueFilter.mjs';
import { getOwnModelForFixture } from './lib/teamModel.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEAGUES_JSON_PATH = join(__dirname, 'lib', 'leagues.json');

// Mirrors DEFAULT_LEAGUE_ALLOWLIST in generate-tickets.mjs — see the file
// header note above on why this is duplicated rather than shared.
const DEFAULT_LEAGUE_ALLOWLIST = new Set([
  39,  // Premier League
  140, // La Liga
  135, // Serie A
  78,  // Bundesliga
  61,  // Ligue 1
  2,   // UEFA Champions League
  3,   // UEFA Europa League
  88,  // Eredivisie
]);

function loadLeagueAllowlist() {
  try {
    const raw = readFileSync(LEAGUES_JSON_PATH, 'utf8');
    const leagues = JSON.parse(raw);
    if (Array.isArray(leagues) && leagues.length > 0) {
      console.log(`Loaded ${leagues.length} resolved league(s) from leagues.json.`);
      return new Set(leagues.map((l) => l.id));
    }
  } catch {
    // leagues.json doesn't exist yet (or is invalid) — fall back below.
  }
  console.log(
    'leagues.json not found — using the small built-in default league set. ' +
      'Run the "Resolve League IDs" workflow for full regional coverage.'
  );
  return DEFAULT_LEAGUE_ALLOWLIST;
}

const LEAGUE_ALLOWLIST = loadLeagueAllowlist();

// Mirrors EXCLUDED_TEAMS in generate-tickets.mjs — same integrity-driven
// business decision (see the note there), applied here too since it should
// hold everywhere the pipeline touches these clubs, not just in ticket
// selection. Keep both lists in sync if this is ever populated for real.
const EXCLUDED_TEAMS = new Set([
  // 'Example FC',
]);
function isExcluded(homeTeam, awayTeam) {
  return EXCLUDED_TEAMS.has(homeTeam) || EXCLUDED_TEAMS.has(awayTeam);
}

// Deliberately much shorter than generate-tickets.mjs's MIN_HOURS_TO_KICKOFF
// (2h) — that rule exists to protect a betting-style confidence pick from
// late team-news changes before someone acts on it financially. A score
// guess carries no such claim, so the only real requirement here is "the
// match hasn't already kicked off."
const MIN_MINUTES_TO_KICKOFF = 15;

function hasMinimumLeadTime(kickoffISO, now) {
  if (!kickoffISO) return false;
  return new Date(kickoffISO).getTime() - now.getTime() >= MIN_MINUTES_TO_KICKOFF * 60 * 1000;
}

// Safety cap — each fixture costs the team model up to 3 Supabase queries
// (home profile, away profile, league baseline). Bounds one run's total
// query volume; if this is ever hit, the excess fixtures simply don't get
// a prediction that day rather than the run growing unbounded.
const MAX_FIXTURES_PER_RUN = 400;

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const now = new Date();
  const today = dateStr(now);

  console.log(`Fetching fixtures for ${today}...`);
  const fixtures = await getFixturesForDate(today);

  const eligible = fixtures.filter(
    (f) =>
      LEAGUE_ALLOWLIST.has(f.league?.id) &&
      !isAmateurOrYouthLeague(f.league?.name) &&
      !isWomensCompetition(f.league?.name) &&
      !isExcluded(f.teams?.home?.name, f.teams?.away?.name) &&
      hasMinimumLeadTime(f.fixture?.date, now)
  );

  console.log(`${eligible.length} eligible fixture(s) today (of ${fixtures.length} total returned by API-Football).`);

  const toProcess = eligible.slice(0, MAX_FIXTURES_PER_RUN);
  if (eligible.length > MAX_FIXTURES_PER_RUN) {
    console.warn(
      `Eligible fixtures (${eligible.length}) exceed MAX_FIXTURES_PER_RUN (${MAX_FIXTURES_PER_RUN}) — ` +
        `the remaining ${eligible.length - MAX_FIXTURES_PER_RUN} won't get a prediction today.`
    );
  }

  const supabase = getSupabaseAdmin();
  const rows = [];
  let skippedNoModel = 0;

  for (const f of toProcess) {
    const homeTeamId = f.teams?.home?.id;
    const awayTeamId = f.teams?.away?.id;
    const homeTeamName = f.teams?.home?.name ?? 'Home';
    const awayTeamName = f.teams?.away?.name ?? 'Away';
    const league = f.league?.name ?? 'Unknown League';

    let model;
    try {
      model = await getOwnModelForFixture(supabase, {
        league,
        homeTeamId,
        awayTeamId,
        homeTeamName,
        awayTeamName,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`Model lookup failed for ${homeTeamName} vs ${awayTeamName}:`, err.message);
      continue;
    }

    if (!model.available || !model.topScoreline) {
      skippedNoModel++;
      continue; // insufficient history for one or both teams — never fabricate a guess
    }

    rows.push({
      id: f.fixture.id,
      ticket_date: today,
      league,
      country: f.league?.country ?? 'Unknown',
      home_team: homeTeamName,
      away_team: awayTeamName,
      kickoff: f.fixture?.date,
      predicted_home_score: model.topScoreline.home,
      predicted_away_score: model.topScoreline.away,
      probability: model.topScoreline.probability,
    });
  }

  console.log(
    `Model had enough history for ${rows.length} of ${toProcess.length} processed fixture(s) ` +
      `(${skippedNoModel} skipped — insufficient team history, no guess fabricated).`
  );

  if (rows.length === 0) {
    console.log('Nothing to write today.');
    return;
  }

  const { error } = await supabase.from('score_predictions').upsert(rows, { onConflict: 'id' });
  if (error) throw error;

  console.log(`Wrote ${rows.length} score prediction(s) for ${today}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
