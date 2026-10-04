// ---------------------------------------------------------------------------
// Odd Saint — team ID resolver (run manually / occasionally, NOT part of
// the daily pipeline)
//
// Depends on scripts/lib/leagues.json already existing — run the "Resolve
// League IDs" workflow first if it doesn't.
//
// For each league the pipeline can actually use, asks API-Football's /teams
// endpoint for that league's current-season teams — id AND name together —
// so every team carries the one stable numeric ID API-Football maintains
// (stable across name variants like "Man United" / "Manchester United").
//
// LEAGUE FILTER (new): leagues.json may contain competitions the ticket and
// score pipelines never use — youth, reserve, lower-division/non-league,
// women's, and South American competitions. Resolving their teams only wastes
// API requests and bloats teams.json (and the history backfill that walks
// it). The same filters generate-tickets.mjs applies are applied here, so
// teams.json only covers leagues that can actually be picked.
//
// Costs 1 API request per KEPT league. Manually triggered — see
// .github/workflows/resolve-teams.yml.
// ---------------------------------------------------------------------------
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getTeamsForLeague } from './lib/apiFootball.mjs';
import { isAmateurOrYouthLeague } from './lib/leagueQuality.mjs';
import { isWomensCompetition } from './lib/womensLeagueFilter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEAGUES_PATH = join(__dirname, 'lib', 'leagues.json');
const OUTPUT_PATH = join(__dirname, 'lib', 'teams.json');

/** Season year for a date: football seasons span two calendar years (2025/26 -> season=2025). July cutover; calendar-year leagues may need manual correction. */
function currentSeasonYear(date = new Date()) {
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  return month >= 7 ? year : year - 1;
}

function isUsableLeagueEntry(league) {
  return (
    league.region !== 'South America' &&
    !isAmateurOrYouthLeague(league.name) &&
    !isWomensCompetition(league.name)
  );
}

async function main() {
  let allLeagues;
  try {
    allLeagues = JSON.parse(readFileSync(LEAGUES_PATH, 'utf8'));
  } catch {
    throw new Error(
      'scripts/lib/leagues.json not found — run the "Resolve League IDs" workflow first; this script depends on it.'
    );
  }

  const leagues = allLeagues.filter(isUsableLeagueEntry);
  const season = currentSeasonYear();
  console.log(
    `Resolving teams for season ${season} across ${leagues.length} league(s) ` +
      `(${allLeagues.length - leagues.length} youth/amateur/women's/South American league(s) skipped).`
  );

  const resolved = [];
  const seenTeamLeague = new Set(); // dedupe if a league appears twice
  const emptyLeagues = [];

  for (const league of leagues) {
    let teams;
    try {
      teams = await getTeamsForLeague(league.id, season);
    } catch (err) {
      console.warn(`Failed to fetch teams for ${league.name} (league ${league.id}):`, err.message);
      continue;
    }

    if (!teams || teams.length === 0) {
      emptyLeagues.push(league.name);
      continue;
    }

    teams.forEach((entry) => {
      if (!entry.team?.id || !entry.team?.name) return;
      const key = `${entry.team.id}-${league.id}`;
      if (seenTeamLeague.has(key)) return;
      seenTeamLeague.add(key);
      resolved.push({ id: entry.team.id, name: entry.team.name, league: league.name, leagueId: league.id });
    });

    console.log(`${league.name} (${league.country}): resolved ${teams.length} team(s).`);
  }

  if (emptyLeagues.length > 0) {
    console.warn(
      '\nThese leagues resolved to 0 teams — possibly the wrong season year for that ' +
        "league's calendar, or no current-season roster data yet:\n" +
        emptyLeagues.map((l) => `  - ${l}`).join('\n')
    );
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(resolved, null, 2) + '\n');
  console.log(`\nWrote ${resolved.length} team(s) across ${leagues.length} league(s) to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
