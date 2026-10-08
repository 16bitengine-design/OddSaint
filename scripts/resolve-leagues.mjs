// ---------------------------------------------------------------------------
// Odd Saint — league resolver (run manually, NOT part of the daily pipeline)
//
// Asks API-Football's /leagues endpoint for the real, current IDs per country
// and writes the ones the league policy allows to scripts/lib/leagues.json.
// (Ticket generation no longer reads leagues.json to choose fixtures — it uses
// scripts/lib/leaguePolicy.mjs — but resolve-teams.mjs and the history backfill
// still walk this list.)
//
// Costs roughly 1 API request per country below. Run occasionally, not daily.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getLeaguesByCountry } from './lib/apiFootball.mjs';
import { classifyLeague } from './lib/leaguePolicy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, 'lib', 'leagues.json');

// Countries covered by the league policy (country spelling as API-Football expects).
const TARGET_COUNTRIES = {
  Europe: [
    'England', 'Spain', 'Italy', 'Germany', 'France', 'Netherlands', 'Portugal',
    'Belgium', 'Scotland', 'Turkey', 'Russia', 'Ukraine', 'Poland', 'Austria',
    'Switzerland', 'Greece', 'Sweden', 'Norway', 'Denmark', 'Croatia', 'Serbia',
    'Czech-Republic', 'Romania', 'Hungary', 'Bulgaria', 'Cyprus', 'Ireland',
    'Wales', 'Iceland', 'Finland', 'Slovakia', 'Slovenia', 'Bosnia',
    'Albania', 'Georgia', 'Azerbaijan', 'Armenia',
  ],
  Asia: ['China', 'Japan', 'South-Korea', 'Thailand'],
  'North America': ['USA', 'Mexico', 'Canada'],
  Africa: ['Morocco', 'Egypt', 'South-Africa', 'Algeria'],
};

/** Keep league competitions (not cups) that the league policy allows for that country. */
function isUsableLeague(entry, country) {
  return entry.league?.type === 'League' && classifyLeague({ name: entry.league?.name, country }).allowed;
}

async function main() {
  const resolved = [];
  const emptyCountries = [];

  for (const [region, countries] of Object.entries(TARGET_COUNTRIES)) {
    for (const country of countries) {
      let leagues;
      try {
        leagues = await getLeaguesByCountry(country);
      } catch (err) {
        console.warn(`Failed to fetch leagues for ${country}:`, err.message);
        continue;
      }

      const usable = leagues.filter((entry) => isUsableLeague(entry, country));
      if (usable.length === 0) {
        emptyCountries.push(country);
        continue;
      }

      usable.forEach((entry) => {
        resolved.push({ id: entry.league.id, name: entry.league.name, country, region });
      });
      console.log(`${country}: resolved ${usable.length} league(s).`);
    }
  }

  if (emptyCountries.length > 0) {
    console.warn(
      '\nThese countries resolved to 0 leagues — a country-name spelling mismatch with API-Football, ' +
        'or no league name matched the policy in scripts/lib/leaguePolicy.mjs:\n' +
        emptyCountries.map((c) => `  - ${c}`).join('\n')
    );
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(resolved, null, 2) + '\n');
  console.log(`\nWrote ${resolved.length} leagues across ${Object.keys(TARGET_COUNTRIES).length} regions to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
