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
// After running, spot-check scripts/lib/leagues.json — any country that
// resolved to 0 leagues likely means API-Football expects a different
// spelling for that country name than what's listed below; the script
// logs a warning for each of those so they're easy to find and fix.
//
// ---------------------------------------------------------------------------
// DIVISION DEPTH — READ BEFORE TRUSTING THE OUTPUT
// ---------------------------------------------------------------------------
// Product direction: the confirmed top-20 European leagues go up to the
// 4th division deep per country; every other nation is capped at the 2nd
// division.
//
// IMPORTANT LIMITATION: API-Football's /leagues endpoint does NOT return an
// explicit numeric division/tier field. There's no reliable "this is
// division 3" flag to filter on. What this script does instead is cap the
// COUNT of leagues kept per country (4 for TOP20_COUNTRIES, 2 for everyone
// else), taking them in the order API-Football's own response returns
// them — which in practice tends to list the top flight first, but this is
// NOT a documented guarantee.
//
// This means the output is a reasonable starting point, not a verified
// division-accurate list. ALWAYS spot-check the resulting leagues.json
// (the console output below prints every kept league with its index and
// name specifically so this is easy) — if a country's 3rd or 4th entry is
// clearly not a real lower-division league (e.g. a regional cup that
// slipped through, or the leagues are out of division order), prune or
// reorder that country's entries in leagues.json by hand. Treat this the
// same way the rest of this script already treats league IDs: verified
// data with mandatory manual review, not blind trust.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getLeaguesByCountry } from './lib/apiFootball.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, 'lib', 'leagues.json');

// The confirmed top-20 European leagues (product direction — see
// CLAUDE.md). Country names here must match what TARGET_COUNTRIES below
// uses for the API-Football country param.
const TOP20_COUNTRIES = new Set([
  'England', 'Spain', 'Italy', 'Germany', 'France', 'Netherlands', 'Portugal',
  'Belgium', 'Turkey', 'Scotland', 'Austria', 'Switzerland', 'Russia',
  'Ukraine', 'Czech-Republic', 'Croatia', 'Denmark', 'Norway', 'Greece',
  'Poland',
]);

// How many leagues (by API response order, per country) to keep.
const MAX_LEAGUES_TOP20 = 4; // up to 4th division for the confirmed top-20
const MAX_LEAGUES_OTHER = 2; // up to 2nd division for every other nation

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
 * this product's accumulator-style tickets).
 *
 * KNOWN GAP: this also excludes UEFA Champions League / UEFA Europa League,
 * since API-Football tags those as type 'Cup', not 'League' — even though
 * PRIORITY_LEAGUE_NAMES in generate-tickets.mjs references them. That's a
 * pre-existing inconsistency, not something introduced by the division-cap
 * change below — flagging it here rather than silently leaving it hidden.
 */
function isUsableLeague(entry) {
  return entry.league?.type === 'League';
}

async function main() {
  const resolved = []; // { id, name, country, region, priorityNation }
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

      const usable = leagues.filter(isUsableLeague);
      if (usable.length === 0) {
        emptyCountries.push(country);
        continue;
      }

      const isPriority = TOP20_COUNTRIES.has(country);
      const cap = isPriority ? MAX_LEAGUES_TOP20 : MAX_LEAGUES_OTHER;
      const kept = usable.slice(0, cap);

      kept.forEach((entry, idx) => {
        resolved.push({
          id: entry.league.id,
          name: entry.league.name,
          country,
          region,
          priorityNation: isPriority,
        });
      });

      console.log(
        `${country}: kept ${kept.length}/${usable.length} league(s) ` +
          `(cap ${cap}${isPriority ? ', top-20 nation' : ''}) — ` +
          kept.map((e, i) => `[${i}] ${e.league.name}`).join(', ')
      );
      if (usable.length > cap) {
        console.log(
          `  ↳ ${usable.length - cap} league(s) dropped by the cap for ${country}: ` +
            usable.slice(cap).map((e) => e.league.name).join(', ')
        );
      }
    }
  }

  if (emptyCountries.length > 0) {
    console.warn(
      '\nThese countries resolved to 0 leagues — likely a country-name spelling ' +
        'mismatch with what API-Football expects. Check and fix TARGET_COUNTRIES:\n' +
        emptyCountries.map((c) => `  - ${c}`).join('\n')
    );
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(resolved, null, 2) + '\n');
  console.log(
    `\nWrote ${resolved.length} leagues across ${Object.keys(TARGET_COUNTRIES).length} regions to ${OUTPUT_PATH}`
  );
  console.log(
    '\nReminder: API-Football does not return an explicit division-tier field. ' +
      'The counts above are capped by response ORDER, not verified division depth. ' +
      'Spot-check leagues.json — especially any country\'s 3rd/4th entries — before ' +
      'trusting this as accurate for the top-20/other-nations split.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
