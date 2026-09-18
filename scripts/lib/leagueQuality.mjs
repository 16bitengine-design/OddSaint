// ---------------------------------------------------------------------------
// Odd Saint — shared league-quality filter
//
// Used by BOTH scripts/resolve-leagues.mjs (so leagues.json never contains
// youth/reserve/lower-division competitions in the first place) and
// scripts/generate-tickets.mjs (as a defense-in-depth check on whatever
// leagues.json or DEFAULT_LEAGUE_ALLOWLIST actually contains, in case
// leagues.json is stale or was generated before this filter existed).
// Keeping this in one place means the two scripts can't drift out of sync
// on what counts as "amateur" — same principle as scripts/lib/markets.mjs.
//
// HONEST SCOPE NOTE: API-Football exposes no explicit division-tier field
// on a league object (see the "manual review of division-tier assignments"
// gap already flagged for resolve-leagues.mjs) — this is a NAME-PATTERN
// heuristic, not a verified tier lookup. It will miss leagues whose name
// doesn't signal their tier/age-group in English, and could in principle
// over-match a professional league whose name happens to contain one of
// these words. Review AMATEUR_LEAGUE_PATTERNS periodically against the
// actual league names appearing in your Actions logs / leagues.json.
// ---------------------------------------------------------------------------

const AMATEUR_LEAGUE_PATTERNS = [
  // Youth / age-group competitions
  /\bu[-\s]?1[0-9]\b/i,        // U10–U19
  /\bu[-\s]?2[0-3]\b/i,        // U20–U23
  /\byouth\b/i,
  /\bjunior(s)?\b/i,
  /\bacademy\b/i,
  /\bprimavera\b/i,
  /\byouth league\b/i,

  // Reserve / B teams
  /\breserves?\b/i,
  /\b(ii|2)\b$/i,               // trailing "II" / "2" — reserve-side naming
  /\bb[-\s]?team\b/i,

  // Explicit "amateur" / regional / non-league
  /\bamateur\b/i,
  /\bregionalliga\b/i,
  /\bregional\b/i,
  /\bnational league\b/i,       // English tier 5 (non-league)
  /\bconference\b/i,

  // Named third-division-or-lower competitions (by common naming)
  /\b(third|fourth|fifth|sixth)\s*division\b/i,
  /\bdivision\s*[3-9]\b/i,
  /\btier\s*[3-9]\b/i,
  /\bserie\s*[cd]\b/i,          // Italy tier 3 (C) / tier 4 (D)
  /\bsegunda\s*b\b/i,           // Spain tier 3 (pre-2021 naming, still seen)
  /\btercera\b/i,               // Spain tier 4/5
  /\b3\.?\s*liga\b/i,           // Germany tier 3
  /\bliga\s*3\b/i,
  /\bleague\s*one\b/i,          // England tier 3
  /\bleague\s*two\b/i,          // England tier 4
  /\bnational\s*ii\b/i,
];

/**
 * Returns true if a league's name matches a known youth/reserve/lower-
 * division/amateur pattern and should be excluded from ticket generation.
 * Name-only heuristic — see the file header note on its limits.
 */
export function isAmateurOrYouthLeague(leagueName) {
  if (!leagueName) return false;
  return AMATEUR_LEAGUE_PATTERNS.some((pattern) => pattern.test(leagueName));
}
