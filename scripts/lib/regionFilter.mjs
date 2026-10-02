// ---------------------------------------------------------------------------
// Odd Saint — South American competition filter
//
// Product decision: no ticket may include a fixture from a South American
// league. One shared definition so every script that builds tickets or
// predictions can apply the same rule (same pattern as leagueQuality.mjs).
//
// HONEST SCOPE NOTE: API-Football exposes the league's country, not the
// continent of each club, so this matches on (1) the league's country and
// (2) CONMEBOL competition names. A South American club playing in a
// non-South-American competition (e.g. the Club World Cup) is NOT caught.
// ---------------------------------------------------------------------------

const SOUTH_AMERICAN_COUNTRIES = new Set([
  'argentina', 'bolivia', 'brazil', 'chile', 'colombia', 'ecuador',
  'guyana', 'paraguay', 'peru', 'suriname', 'uruguay', 'venezuela',
]);

const SOUTH_AMERICAN_COMPETITION_PATTERN = /conmebol|libertadores|sudamericana|copa am[eé]rica/i;

/** True if the league (by country or CONMEBOL competition name) is South American. */
export function isSouthAmericanLeague(leagueCountry, leagueName) {
  if (leagueCountry && SOUTH_AMERICAN_COUNTRIES.has(String(leagueCountry).trim().toLowerCase())) return true;
  if (leagueName && SOUTH_AMERICAN_COMPETITION_PATTERN.test(leagueName)) return true;
  return false;
}

/** Country names (as stored in fixtures.country) — handy for one-off SQL cleanups. */
export const SOUTH_AMERICAN_COUNTRY_NAMES = [
  'Argentina', 'Bolivia', 'Brazil', 'Chile', 'Colombia', 'Ecuador',
  'Guyana', 'Paraguay', 'Peru', 'Suriname', 'Uruguay', 'Venezuela',
];
