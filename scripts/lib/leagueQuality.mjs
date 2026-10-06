// ---------------------------------------------------------------------------
// Odd Saint — shared league-quality filter
//
// Used by scripts/resolve-leagues.mjs, scripts/resolve-teams.mjs and
// scripts/generate-tickets.mjs so they can't drift apart on what counts as
// "amateur". Excludes youth / reserve / development competitions and the
// named third-division-or-lower leagues. Non-league competitions (e.g. the
// Isthmian and Northern Premier leagues) are deliberately NOT excluded by name:
// whether a match is eligible is decided by whether the target-location
// bookmakers actually offer it (see TARGET_BOOKMAKER_IDS in generate-tickets.mjs).
//
// HONEST SCOPE NOTE: API-Football exposes no explicit division-tier field, so
// this is a NAME-PATTERN heuristic. It can miss a competition whose name does
// not signal its level in English, and could in principle over-match.
// Review AMATEUR_LEAGUE_PATTERNS against the league names in your logs.
// ---------------------------------------------------------------------------

const AMATEUR_LEAGUE_PATTERNS = [
  // Youth / age-group / development competitions
  /\bu[-\s]?1[0-9]\b/i,        // U10–U19
  /\bu[-\s]?2[0-3]\b/i,        // U20–U23
  /\byouth\b/i,
  /\bjunior(s)?\b/i,
  /\bacademy\b/i,
  /\bprimavera\b/i,
  /\bdevelopment league\b/i,   // England's "Professional Development League" (U21 sides)
  /\bpremier league 2\b/i,     // England's U21 "Premier League 2"

  // Reserve / B teams
  /\breserves?\b/i,
  // NOTE: the old "trailing II / 2" pattern was removed — it was meant to catch
  // reserve sides but, applied to LEAGUE names, it wrongly excluded real
  // second divisions such as "Ligue 2". Reserve sides are caught by TEAM name
  // below instead (isYouthOrReserveTeam).
  /\bb[-\s]?team\b/i,

  // Explicit "amateur" / regional / non-league
  /\bamateur\b/i,
  /\bregionalliga\b/i,
  /\bregional\b/i,
  /\bnational league\b/i,
  /\bconference\b/i,

  // Named third-division-or-lower competitions
  /\b(third|fourth|fifth|sixth)\s*division\b/i,
  /\bdivision\s*[3-9]\b/i,
  /\btier\s*[3-9]\b/i,
  /\bserie\s*[cd]\b/i,
  /\bsegunda\s*b\b/i,
  /\btercera\b/i,
  /\b3\.?\s*liga\b/i,
  /\bliga\s*3\b/i,
  /\bleague\s*one\b/i,
  /\bleague\s*two\b/i,
  /\bnational\s*ii\b/i,
];

/** True if a league's name matches a youth/reserve/lower-division/non-league pattern. */
export function isAmateurOrYouthLeague(leagueName) {
  if (!leagueName) return false;
  return AMATEUR_LEAGUE_PATTERNS.some((pattern) => pattern.test(leagueName));
}

// Some youth/reserve sides play inside competitions whose NAME looks normal;
// their TEAM names give them away ("Colchester United U21", "Reserves", "Mallorca B", "Bayern Munich II").
const YOUTH_TEAM_PATTERN = /\bu[-\s]?(1[0-9]|2[0-3])\b|\byouth\b|\breserves?\b|\bacademy\b/i;
const RESERVE_SUFFIX_PATTERN = /\s(II|B)$/; // case-sensitive: "Mallorca B", "Bayern Munich II"

/** True if either team name marks a youth/reserve side. */
export function isYouthOrReserveTeam(homeTeam, awayTeam) {
  const check = (name) => YOUTH_TEAM_PATTERN.test(name ?? '') || RESERVE_SUFFIX_PATTERN.test(name ?? '');
  return check(homeTeam) || check(awayTeam);
}
