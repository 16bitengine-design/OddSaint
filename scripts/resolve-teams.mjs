// ---------------------------------------------------------------------------
// Odd Saint — team ID resolver (run manually / occasionally, NOT part of
// the daily pipeline)
//
// Depends on scripts/lib/leagues.json already existing — run the "Resolve
// League IDs" workflow first if it doesn't.
//
// For each resolved league, asks API-Football's own /teams endpoint for
// that league's current-season teams — id AND name together, straight from
// API-Football, so every team gets the one stable numeric identifier
// API-Football itself already maintains. That's what "assign a unique ID
// to each team" means in practice: not a new numbering scheme invented
// here, but capturing the ID that already uniquely identifies that club
// across every API-Football endpoint (fixtures, odds, stats), and stays
// correct across name variants ("Man United" vs "Manchester United") that
// would otherwise quietly break plain text matching.
//
// Costs 1 API request per resolved league — cheap, safe to run
// occasionally. Manually triggered — see .github/workflows/resolve-teams.yml.
// ---------------------------------------------------------------------------
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getTeamsForLeague } from './lib/apiFootball.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEAGUES_PATH = join(__dirname, 'lib', 'leagues.json');
const OUTPUT_PATH = join(__dirname, 'lib', 'teams.json');

/**
 * Football seasons typically span two calendar years (e.g. the 2025/26
 * Premier League season is queried via season=2025). This is an
 * APPROXIMATION based on a July cutover — accurate for the
 * European-calendar leagues this pipeline mainly targets, but
 * calendar-year leagues (common in parts of South America) may resolve
 * incorrectly and need manual correction in the output file. Flagging this
 * assumption rather than silently guessing.
 */
function currentSeasonYear(date = new Date()) {
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  return month >= 7 ? year : year - 1;
}

async function main() {
  let leagues;
  try {
    leagues = JSON.parse(readFileSync(LEAGUES_PATH, 'utf8'));
  } catch {
    throw new Error(
      'scripts/lib/leagues.json not found — run the "Resolve League IDs" workflow first; this script depends on it.'
    );
  }

  const season = currentSeasonYear();
  console.log(`Resolving teams for season ${season} across ${leagues.length} league(s)...`);

  const resolved = []; // { id, name, league, leagueId }
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
      if (!entry.team?.id || !entry.team?.name) return; // malformed entry — skip rather than write a broken row
      resolved.push({
        id: entry.team.id,
        name: entry.team.name,
        league: league.name,
        leagueId: league.id,
      });
    });

    console.log(`${league.name}: resolved ${teams.length} team(s).`);
  }

  if (emptyLeagues.length > 0) {
    console.warn(
      '\nThese leagues resolved to 0 teams — possibly the wrong season year for that ' +
        "league's calendar (see currentSeasonYear's approximation note above), or no " +
        'current-season roster data yet:\n' +
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
