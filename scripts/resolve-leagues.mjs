// ---------------------------------------------------------------------------
// Odd Saint — league resolver (run manually, NOT part of the daily pipeline)
//
// Hardcoding hundreds of league ID numbers from memory is risky — a wrong
// ID doesn't error, it just silently returns zero fixtures for that league
// forever. This script instead asks API-Football's own /leagues endpoint
// for the real, current IDs per country, and writes a verified league list
// to scripts/lib/leagues.json for generate-tickets.mjs to read.
//
// Costs roughly 1 API request per country below (~60 requests for the full
// list) — trivial as a ONE-TIME or occasional run, but NOT something to run
// daily, which is why this has its own manually-triggered workflow
// (.github/workflows/resolve-leagues.yml) separate from the daily jobs.
//
// BUDGET SAFETY: this draws from the SAME 100-requests/day account as
// generate-tickets.mjs and grade-tickets.mjs (see the budget comment in
// generate-tickets.mjs for the full daily arithmetic) — running this on a
// day those have already spent heavily can matter. This script respects
// the same live daily-budget circuit breaker (scripts/lib/apiFootball.mjs):
// if the account runs low partway through the country list, it stops,
// WRITES whatever it has already resolved so far (never throws the partial
// progress away), and tells you to re-run it after the next 00:00 UTC
// reset to pick up the remaining countries.
//
// After running, spot-check scripts/lib/leagues.json — any country that
// resolved to 0 leagues likely means API-Football expects a different
// spelling for that country name than what's listed below; the script
// logs a warning for each of those so they're easy to find and fix.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getLeaguesByCountry, ApiFootballBudgetExhaustedError } from './lib/apiFootball.mjs';
import { isWomensCompetition } from './lib/womensLeagueFilter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, 'lib', 'leagues.json');

// Countries to resolve, grouped for readability. Country name spelling
// must match what API-Football itself expects — if a country below
// resolves to 0 leagues, try the alternate spelling commonly used by
// API-Football (check their /leagues?country= docs or the countries
// endpoint) and adjust here.
const TARGET_COUNTRIES = {
  Europe: [
    'England', 'Spain', 'Italy', 'Germany', 'France', 'Netherlands', 'Portugal',
    'Belgium', 'Scotland', 'Turkey', 'Russia', 'Ukraine', 'Poland', 'Austria',
    'Switzerland', 'Greece', 'Sweden', 'Norway', 'Denmark', 'Croatia', 'Serbia',
    'Czech-Republic', 'Romania', 'Hungary', 'Bulgaria', 'Cyprus', 'Ireland',
    'Wales', 'Iceland', 'Finland', 'Slovakia', 'Slovenia', 'Bosnia',
    'Albania', 'North-Macedonia', 'Georgia', 'Azerbaijan', 'Armenia',
  ],
  Asia: ['China', 'Japan', 'South-Korea', 'Thailand'],
  'South America': [
    'Brazil', 'Argentina', 'Uruguay', 'Chile', 'Colombia', 'Peru',
    'Ecuador', 'Paraguay', 'Bolivia', 'Venezuela',
  ],
  'North America': ['USA', 'Mexico', 'Canada'],
  Africa: ['Morocco', 'Egypt', 'South-Africa', 'Algeria'],
};

/**
 * Which league "types" to keep from each country's response. API-Football
 * returns both league competitions (what we want) and cup competitions
 * (knockout tournaments — excluded here since their format doesn't suit
 * this product's accumulator-style tickets). Women's competitions are also
 * excluded — see scripts/lib/womensLeagueFilter.mjs — OddSaint currently
 * covers men's football only, a deliberate product decision.
 */
function isUsableLeague(entry) {
  return entry.league?.type === 'League' && !isWomensCompetition(entry.league?.name);
}

async function main() {
  const resolved = []; // { id, name, country, region }
  const emptyCountries = [];
  let womensExcludedCount = 0;
  let stoppedEarly = false;

  outer: for (const [region, countries] of Object.entries(TARGET_COUNTRIES)) {
    for (const country of countries) {
      let leagues;
      try {
        leagues = await getLeaguesByCountry(country);
      } catch (err) {
        if (err instanceof ApiFootballBudgetExhaustedError) {
          console.warn(
            `${err.message} — stopping league resolution here (reached "${country}"). ` +
              `Writing the ${resolved.length} league(s) resolved so far; re-run this workflow ` +
              'after the next 00:00 UTC reset to pick up the remaining countries.'
          );
          stoppedEarly = true;
          break outer;
        }
        console.warn(`Failed to fetch leagues for ${country}:`, err.message);
        continue;
      }

      womensExcludedCount += leagues.filter(
        (entry) => entry.league?.type === 'League' && isWomensCompetition(entry.league?.name)
      ).length;

      const usable = leagues.filter(isUsableLeague);
      if (usable.length === 0) {
        emptyCountries.push(country);
        continue;
      }

      usable.forEach((entry) => {
        resolved.push({
          id: entry.league.id,
          name: entry.league.name,
          country,
          region,
        });
      });

      console.log(`${country}: resolved ${usable.length} league(s).`);
    }
  }

  if (womensExcludedCount > 0) {
    console.log(`Excluded ${womensExcludedCount} women's competition(s) — men's-only coverage per product decision.`);
  }

  if (emptyCountries.length > 0) {
    console.warn(
      '\nThese countries resolved to 0 leagues — likely a country-name spelling ' +
        'mismatch with what API-Football expects. Check and fix TARGET_COUNTRIES:\n' +
        emptyCountries.map((c) => `  - ${c}`).join('\n')
    );
  }

  // Written even on an early budget-triggered stop — partial, verified
  // results are strictly better than throwing away everything resolved so
  // far just because the run didn't finish every country.
  writeFileSync(OUTPUT_PATH, JSON.stringify(resolved, null, 2) + '\n');
  console.log(
    `\nWrote ${resolved.length} leagues across ${Object.keys(TARGET_COUNTRIES).length} regions to ${OUTPUT_PATH}` +
      (stoppedEarly ? ' (INCOMPLETE — stopped early on daily budget, see warning above).' : '.')
  );

  if (stoppedEarly) process.exitCode = 1; // surface as a non-clean run without discarding the partial write
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
