// ---------------------------------------------------------------------------
// Odd Saint — league eligibility policy (which competitions tickets may use)
//
// RULES (product decision):
//   - Nothing beyond the 5th division, for any country.
//   - England: up to the 5th division, PLUS the Under-21 league as a 6th level
//     (Premier League 2 / Professional Development League).
//   - Sweden, Denmark, Finland, Norway: up to the 4th division.
//   - Russia, France, Germany, Italy, Spain, Scotland: up to the 3rd division.
//   - The rest of Europe: up to the 2nd division.
//   - North America, Africa, Asia: up to the 2nd division per country.
//   - ALL continental and regional competitions are included (UEFA, CAF, AFC,
//     CONCACAF, CONMEBOL, World Cup, Nations Leagues, regional cups ...), but
//     never women's or youth versions.
//   - DOMESTIC CUPS (FA Cup, League Cup / Carabao, Community Shield, Copa del
//     Rey, Coppa Italia, DFB Pokal, Coupe de France, KNVB Beker, Taca de
//     Portugal ...) are included for the TOP_EUROPEAN_COUNTRIES below.
//   - FRIENDLIES (national-team "Friendlies" and "Friendlies Clubs") are
//     included but flagged `friendly: true` — the generator uses them only
//     where necessary (it prefers every other match).
//   - South American DOMESTIC leagues stay excluded (earlier product rule).
//   - Women's competitions are excluded everywhere.
//
// HOW IT WORKS: API-Football has no division-tier field, so each country has an
// explicit list of the league NAMES that fall inside its allowed divisions
// (names as API-Football returns them; accents are ignored). A league that is
// not listed is NOT eligible — "unclassified" is reported by classifyLeague() so
// a missing league can be added here deliberately rather than slipping in.
// To admit another country, add it to COUNTRY_POLICY below.
// ---------------------------------------------------------------------------
import { isWomensCompetition } from './womensLeagueFilter.mjs';

const stripAccents = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function countryKey(country) {
  const k = stripAccents(country).toLowerCase().replace(/[^a-z]/g, '');
  if (k.startsWith('bosnia')) return 'bosnia';
  if (k === 'unitedstates' || k === 'unitedstatesofamerica') return 'usa';
  if (k === 'korearepublic') return 'southkorea';
  if (k === 'czechia') return 'czechrepublic';
  return k;
}

// d = division number; youth = an under-21 level that is allowed (England only).
const L = (d, re, youth = false) => ({ d, re, youth });

const COUNTRY_POLICY = {
  // --- England: up to division 5, U21 league as level 6 ----------------------
  england: [
    L(1, /^Premier League$/i), L(2, /^Championship$/i), L(3, /^League One$/i), L(4, /^League Two$/i),
    L(5, /^National League( - Play-offs)?$/i),
    L(6, /^Premier League 2/i, true), L(6, /^Professional Development League$/i, true),
  ],

  // --- Up to division 4 -------------------------------------------------------
  sweden: [
    L(1, /^Allsvenskan$/i), L(2, /^Superettan$/i), L(3, /^Ettan\b/i), L(4, /^Division 2\b/i),
  ],
  denmark: [
    L(1, /^Superliga$/i), L(2, /^1\. Division$/i), L(3, /^2\. Division$/i), L(3, /^2nd Division/i), L(4, /^3\. Division$/i),
  ],
  finland: [
    L(1, /^Veikkausliiga$/i), L(2, /^Ykkosliiga$/i), L(3, /^Ykkonen$/i), L(4, /^Kakkonen\b/i),
  ],
  norway: [
    L(1, /^Eliteserien$/i), L(2, /^1\. Division$/i), L(3, /^2\. Division\b/i), L(4, /^3\. Division\b/i),
  ],

  // --- Up to division 3 -------------------------------------------------------
  spain: [L(1, /^La Liga$/i), L(2, /^Segunda Division$/i), L(3, /^Primera Division RFEF/i)],
  italy: [L(1, /^Serie A$/i), L(2, /^Serie B$/i), L(3, /^Serie C - (Girone [ABC]|Promotion - Play-offs|Relegation - Play-offs)$/i)],
  germany: [L(1, /^Bundesliga$/i), L(2, /^2\. Bundesliga$/i), L(3, /^3\. Liga$/i)],
  france: [L(1, /^Ligue 1$/i), L(2, /^Ligue 2$/i), L(3, /^Ligue 3$/i)],
  scotland: [L(1, /^Premiership$/i), L(2, /^Championship$/i), L(3, /^League One$/i)],
  russia: [L(1, /^Premier League$/i), L(2, /^First League$/i), L(3, /^Second League/i)],

  // --- Rest of Europe: up to division 2 ----------------------------------------
  netherlands: [L(1, /^Eredivisie$/i), L(2, /^Eerste Divisie$/i)],
  portugal: [L(1, /^Primeira Liga$/i), L(2, /^Segunda Liga$/i)],
  belgium: [L(1, /^Jupiler Pro League$/i), L(2, /^Challenger Pro League$/i)],
  turkey: [L(1, /^Super Lig$/i), L(2, /^1\. Lig$/i)],
  ukraine: [L(1, /^Premier League$/i), L(2, /^Persha Liga$/i)],
  poland: [L(1, /^Ekstraklasa$/i), L(2, /^I Liga$/i)],
  austria: [L(1, /^Bundesliga$/i), L(2, /^2\. Liga$/i)],
  switzerland: [L(1, /^Super League$/i), L(2, /^Challenge League$/i)],
  greece: [L(1, /^Super League 1$/i), L(2, /^Super League 2$/i), L(2, /^Football League$/i)],
  croatia: [L(1, /^HNL$/i), L(2, /^First NL$/i)],
  serbia: [L(1, /^Super Liga$/i), L(2, /^Prva Liga$/i)],
  czechrepublic: [L(1, /^Czech Liga$/i), L(2, /^FNL$/i)],
  romania: [L(1, /^Liga I$/i), L(2, /^Liga II$/i)],
  hungary: [L(1, /^NB I$/i), L(2, /^NB II$/i)],
  bulgaria: [L(1, /^First League$/i), L(2, /^Second League$/i)],
  cyprus: [L(1, /^1\. Division$/i), L(2, /^2\. Division$/i)],
  ireland: [L(1, /^Premier Division$/i), L(2, /^First Division$/i)],
  wales: [L(1, /^Premier League$/i), L(2, /^FAW Championship$/i)],
  iceland: [L(1, /^Urvalsdeild$/i), L(2, /^1\. Deild$/i)],
  slovakia: [L(1, /^Super Liga$/i), L(2, /^2\. liga$/i)],
  slovenia: [L(1, /^1\. SNL$/i), L(2, /^2\. SNL$/i)],
  bosnia: [L(1, /^Premijer Liga$/i), L(2, /^1st League/i)],
  albania: [L(1, /^Superliga$/i), L(2, /^1st Division$/i)],
  georgia: [L(1, /^Erovnuli Liga$/i), L(2, /^Erovnuli Liga 2$/i)],
  azerbaijan: [L(1, /^Premyer Liqa$/i), L(2, /^Birinci Dasta$/i)],
  armenia: [L(1, /^Premier League$/i), L(2, /^First League$/i)],

  // --- North America: up to division 2 ------------------------------------------
  usa: [L(1, /^Major League Soccer$/i), L(2, /^USL Championship$/i)],
  mexico: [L(1, /^Liga MX$/i), L(2, /^Liga de Expansion MX$/i)],
  canada: [L(1, /^Canadian Premier League$/i)],

  // --- Africa: up to division 2 ---------------------------------------------------
  morocco: [L(1, /^Botola Pro$/i), L(2, /^Botola 2$/i)],
  egypt: [L(1, /^Premier League$/i), L(2, /^Second League/i)],
  southafrica: [L(1, /^Premier Soccer League$/i), L(2, /^1st Division$/i)],
  algeria: [L(1, /^Ligue 1$/i), L(2, /^Ligue 2$/i)],

  // --- Asia: up to division 2 -----------------------------------------------------
  china: [L(1, /^Super League$/i), L(2, /^League One$/i)],
  japan: [L(1, /^J1 League$/i), L(2, /^J2 League$/i)],
  southkorea: [L(1, /^K League 1$/i), L(2, /^K League 2$/i)],
  thailand: [L(1, /^Thai League 1$/i), L(2, /^Thai League 2$/i)],
};

// The 20 European countries whose domestic CUPS are eligible (edit to change).
// Chosen from the countries this policy already covers, roughly by UEFA ranking.
export const TOP_EUROPEAN_COUNTRIES = new Set([
  'england', 'spain', 'italy', 'germany', 'france', 'netherlands', 'portugal', 'belgium', 'turkey',
  'scotland', 'austria', 'switzerland', 'greece', 'czechrepublic', 'norway', 'denmark', 'poland',
  'cyprus', 'croatia', 'sweden',
]);

// A competition NAME that is a domestic cup / super cup (accents already stripped)...
const CUP_NAME = /\b(cup|cupen|copa|coppa|pokal|pokalen|taca|coupe|beker|puchar|kupa|cupa|shield|schaal|trophee|supercup|supercopa|supercoppa|supertaca)\b/i;
// ...unless it is a youth / women's / amateur / lower-league or "trophy" competition.
const CUP_EXCLUDE = /youth|junior|reserve|women|femin|\bu[-\s]?\d{2}\b|under[-\s]?\d{2}|amateur|regional|county|vase|trophy|isthmian|non league|qualif/i;
const FRIENDLY = /friendl/i;

// South American DOMESTIC leagues stay excluded (earlier product rule).
const SOUTH_AMERICAN_DOMESTIC = new Set([
  'brazil', 'argentina', 'uruguay', 'chile', 'colombia', 'peru', 'ecuador', 'paraguay', 'bolivia', 'venezuela',
]);

// Continental / regional / world competitions come back from API-Football with a
// non-country "country". ALL of them are included, except the kinds below.
const CONTINENTAL_SCOPES = new Set(['world', 'europe', 'asia', 'africa', 'northamerica', 'southamerica', 'oceania']);
const CONTINENTAL_EXCLUDE = /youth|women|femin|\bu[-\s]?\d{2}\b|under[-\s]?\d{2}|olympic|futsal|beach/i;

/**
 * Classifies a league as eligible or not. Input: { name, country } (an
 * API-Football `league` object or a leagues.json entry).
 * Returns { allowed, kind, division, allowYouthTeams, reason }.
 */
export function classifyLeague(league) {
  const name = stripAccents(league?.name).trim();
  const key = countryKey(league?.country);
  const no = (reason) => ({ allowed: false, kind: 'excluded', division: null, allowYouthTeams: false, friendly: false, reason });

  if (!name) return no('no league name');
  if (isWomensCompetition(league?.name)) return no('women\'s competition');

  if (CONTINENTAL_SCOPES.has(key)) {
    if (CONTINENTAL_EXCLUDE.test(name)) return no('continental but women\'s / youth / olympic');
    const friendly = FRIENDLY.test(name);
    return {
      allowed: true,
      kind: friendly ? 'friendly' : 'continental',
      division: null,
      allowYouthTeams: false,
      friendly,
      reason: friendly ? 'friendly (only where necessary)' : 'continental / regional competition',
    };
  }

  if (SOUTH_AMERICAN_DOMESTIC.has(key)) return no('South American domestic league');

  // Domestic cups for the top European countries.
  if (TOP_EUROPEAN_COUNTRIES.has(key) && CUP_NAME.test(name) && !CUP_EXCLUDE.test(name)) {
    return { allowed: true, kind: 'cup', division: null, allowYouthTeams: false, friendly: false, reason: 'domestic cup' };
  }

  const entries = COUNTRY_POLICY[key];
  if (!entries) return no('country not covered by the league policy');

  const hit = entries.find((e) => e.re.test(name));
  if (!hit) return no('unclassified — not within the allowed divisions for this country');
  return {
    allowed: true,
    kind: 'domestic',
    division: hit.d,
    allowYouthTeams: hit.youth, // England's U21 league is made of U21 sides
    friendly: false,
    reason: `division ${hit.d}`,
  };
}

export const isLeagueAllowed = (league) => classifyLeague(league).allowed;
