// ---------------------------------------------------------------------------
// Odd Saint — men's-only competition filter
//
// Product decision: OddSaint currently covers men's football only. Applied
// in TWO places for redundancy:
//   1. resolve-leagues.mjs — keeps women's competitions out of leagues.json
//      in the first place.
//   2. generate-tickets.mjs — a second check at fixture-eligibility time, so
//      a stale leagues.json entry (generated before this filter existed)
//      can never sneak a women's fixture into a ticket.
//
// HONEST SCOPE NOTE: API-Football doesn't expose an explicit gender field
// on a league — this matches on the league NAME instead. Most competitions
// are unambiguous ("Women Super League", "NWSL", "Frauen-Bundesliga"), but
// a handful of real competitions carry no obvious keyword (Spain's
// "Liga F", Sweden's "Damallsvenskan", Norway's "Toppserien") — those are
// listed by exact name below. If a new women's competition without an
// obvious keyword slips through, add it to
// KNOWN_WOMENS_LEAGUES_WITHOUT_KEYWORD.
// ---------------------------------------------------------------------------

const WOMENS_KEYWORDS = [
  'women', "women's", 'ladies', 'female', 'feminine', 'femenina', 'féminine',
  'feminin', 'femminile', 'frauen', 'dames', 'kvinner', 'kvinnor', 'naiset',
  'wsl', 'nwsl',
];

const KNOWN_WOMENS_LEAGUES_WITHOUT_KEYWORD = new Set([
  'Liga F',             // Spain
  'Damallsvenskan',     // Sweden
  'Elitettan',          // Sweden, 2nd tier
  'Toppserien',         // Norway
  'Kansallinen Liiga',  // Finland
]);

export function isWomensCompetition(leagueName) {
  if (!leagueName) return false;
  if (KNOWN_WOMENS_LEAGUES_WITHOUT_KEYWORD.has(leagueName)) return true;
  const lower = leagueName.toLowerCase();
  return WOMENS_KEYWORDS.some((kw) => lower.includes(kw));
}
