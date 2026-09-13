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
 * returns both league competitions (what we want) and domestic cup
 * competitions (knockout tournaments — excluded here since their format
 * doesn't suit this product's accumulator-style tickets).
 *
 * Continental club competitions (Champions League, Europa League, etc.)
 * are also tagged type 'Cup' by API-Football, but they're resolved
 * SEPARATELY below via resolveContinentalCompetitions() — they don't
 * belong to any of the per-country TARGET_COUNTRIES queries at all (API-
 * Football files them under country "World"), so this per-country filter
 * was never going to reach them regardless of type.
 */
function isUsableLeague(entry) {
  return entry.league?.type === 'League';
}

// ---------------------------------------------------------------------------
// Continental club competitions
// ---------------------------------------------------------------------------
// Product direction: all continental competitions must be included in the
// pool. API-Football lists these under country "World", tagged type 'Cup'
// (not 'League') — so the per-country loop above never sees them.
//
// Rather than hardcode competition IDs (this project's own rule — verify,
// don't guess), this matches by NAME KEYWORD against whatever API-Football
// actually returns for country "World". That bucket also contains things
// that are NOT club competitions this product wants — the World Cup,
// Nations League, youth internationals, qualifiers, friendlies — so both
// an include-keyword list and an exclude-keyword list are applied.
//
// MANDATORY REVIEW: the script prints every "World"-country entry it saw,
// whether matched or not, specifically so you can catch a real continental
// competition using different wording than expected below, or a false
// positive that slipped through the include list.
const CONTINENTAL_INCLUDE_KEYWORDS = [
  'Champions League',       // UEFA, CAF, AFC, CONCACAF, CONMEBOL Libertadores-equivalent naming varies
  'Europa League',
  'Europa Conference League',
  'Libertadores',
  'Sudamericana',
  'Confederation Cup',      // CAF Confederation Cup
  'Champions Cup',          // CONCACAF Champions Cup (current naming, post-2023 rebrand)
];
const CONTINENTAL_EXCLUDE_KEYWORDS = [
  'World Cup',
  'Nations League',
  'Qualification',
  'Qualifiers',
  'Friendlies',
  'U15', 'U16', 'U17', 'U18', 'U19', 'U20', 'U21', 'U22', 'U23',
  'Women', // remove this line if women's competitions should also be included
];

function matchesAnyKeyword(name, keywords) {
  const lower = name.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

async function resolveContinentalCompetitions() {
  let entries;
  try {
    entries = await getLeaguesByCountry('World');
  } catch (err) {
    console.warn('Failed to fetch continental ("World") competitions:', err.message);
    return [];
  }

  const matched = [];
  const unmatched = [];

  entries.forEach((entry) => {
    const name = entry.league?.name ?? '';
    const isExcluded = matchesAnyKeyword(name, CONTINENTAL_EXCLUDE_KEYWORDS);
    const isIncluded = !isExcluded && matchesAnyKeyword(name, CONTINENTAL_INCLUDE_KEYWORDS);
    if (isIncluded) {
      matched.push(entry);
    } else {
      unmatched.push({ name, type: entry.league?.type });
    }
  });

  console.log(
    `\nContinental ("World") competitions: matched ${matched.length}/${entries.length} — ` +
      matched.map((e) => e.league.name).join(', ')
  );
  console.log(
    'Everything else seen under "World" (review this — a real continental competition ' +
      'using different wording than CONTINENTAL_INCLUDE_KEYWORDS would show up here instead):\n  ' +
      unmatched.map((e) => `${e.name} [${e.type}]`).join('\n  ')
  );

  // Continental competitions have no domestic "division" concept, so no
  // count cap applies here — every matched competition is kept. Flagged
  // priorityNation: true, consistent with how Champions League/Europa
  // League were already treated in the DEFAULT_LEAGUE_ALLOWLIST fallback.
  return matched.map((entry) => ({
    id: entry.league.id,
    name: entry.league.name,
    country: 'World',
    region: 'Continental',
    priorityNation: true,
  }));
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

  // Continental club competitions (Champions League, Europa League, CAF/
  // AFC/CONCACAF/CONMEBOL equivalents) — resolved separately since
  // API-Football files these under country "World", not any of the
  // per-country queries above. See resolveContinentalCompetitions() for
  // why keyword-matching is used instead of hardcoded IDs.
  const continental = await resolveContinentalCompetitions();
  const countryLeagueCount = resolved.length;
  resolved.push(...continental);

  writeFileSync(OUTPUT_PATH, JSON.stringify(resolved, null, 2) + '\n');
  console.log(
    `\nWrote ${resolved.length} leagues to ${OUTPUT_PATH} ` +
      `(${countryLeagueCount} domestic across ${Object.keys(TARGET_COUNTRIES).length} regions, ` +
      `${continental.length} continental).`
  );
  console.log(
    '\nReminder: API-Football does not return an explicit division-tier field. ' +
      'The counts above are capped by response ORDER, not verified division depth. ' +
      'Spot-check leagues.json — especially any country\'s 3rd/4th entries, and the ' +
      'continental "unmatched" list above — before trusting this as final.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
