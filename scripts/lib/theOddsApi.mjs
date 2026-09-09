// ---------------------------------------------------------------------------
// Odd Saint — The Odds API client (odds for the majors pool)
//
// Supplies odds for the same 12 competitions football-data.org supplies
// fixtures for (see scripts/lib/footballDataOrg.mjs). This is the odds
// source for Mega/Bronze/Silver/Gold/Saint's Lock ONLY — Platinum, Diamond,
// Weekly Lite, and Weekly Titan still get both fixtures and odds from
// scripts/lib/apiFootball.mjs.
//
// Auth: apiKey as a QUERY PARAMETER (not a header) — confirmed from
// The Odds API's own docs/examples.
//
// IMPORTANT — sport-key mapping is best-effort. SPORT_KEY_FALLBACK below is
// built from The Odds API's documented naming convention, but — same
// principle as scripts/resolve-leagues.mjs for API-Football — it has NOT
// been live-verified against a real account. Run resolveSportKeys() once
// against a real API key (a free call, doesn't consume odds quota) and
// compare the result to SPORT_KEY_FALLBACK before trusting this in
// production; log a warning for anything that doesn't match so a silent
// wrong-key mistake doesn't just silently return zero fixtures forever.
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.the-odds-api.com/v4';

// fdoCode (see footballDataOrg.mjs COMPETITION_CODES) -> best-effort
// The Odds API sport key + a plain-text title fragment used by
// resolveSportKeys() to cross-check against the live /v4/sports response.
export const SPORT_KEY_FALLBACK = {
  PL: { key: 'soccer_epl', titleMatch: 'Premier League' },
  PD: { key: 'soccer_spain_la_liga', titleMatch: 'La Liga' },
  BL1: { key: 'soccer_germany_bundesliga', titleMatch: 'Bundesliga' },
  SA: { key: 'soccer_italy_serie_a', titleMatch: 'Serie A' },
  FL1: { key: 'soccer_france_ligue_one', titleMatch: 'Ligue 1' },
  DED: { key: 'soccer_netherlands_eredivisie', titleMatch: 'Eredivisie' },
  PPL: { key: 'soccer_portugal_primeira_liga', titleMatch: 'Primeira Liga' },
  ELC: { key: 'soccer_efl_champ', titleMatch: 'Championship' },
  BSA: { key: 'soccer_brazil_campeonato', titleMatch: 'Brazil' },
  CL: { key: 'soccer_uefa_champs_league', titleMatch: 'Champions League' },
  WC: { key: 'soccer_fifa_world_cup', titleMatch: 'World Cup' },
  EC: { key: 'soccer_uefa_european_championship', titleMatch: 'European Championship' },
};

function requireApiKey() {
  const key = process.env.ODDS_API_KEY;
  if (!key) {
    throw new Error(
      'Missing ODDS_API_KEY environment variable. Add it as a GitHub Actions secret ' +
        '(sign up at https://the-odds-api.com/).'
    );
  }
  return key;
}

async function oddsApiGet(path, params = {}) {
  const key = requireApiKey();
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set('apiKey', key);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  const res = await fetch(url);

  if (res.status === 429) {
    throw new Error(`The Odds API monthly quota exhausted (429): ${path}`);
  }
  if (!res.ok) {
    throw new Error(`The Odds API request failed (${res.status}): ${url} — ${await res.text()}`);
  }

  // The Odds API returns remaining-quota info in response headers, not the
  // body — surface it so a run that's about to exhaust the free tier is
  // visible in the GitHub Actions log rather than failing silently later.
  const remaining = res.headers.get('x-requests-remaining');
  if (remaining !== null && Number(remaining) < 20) {
    // eslint-disable-next-line no-console
    console.warn(`The Odds API: only ${remaining} requests remaining this billing period.`);
  }

  return res.json();
}

/**
 * Fetches the live sports catalog (free call, no quota cost) and checks it
 * against SPORT_KEY_FALLBACK's titleMatch fragments. Returns
 * { verified: Map<fdoCode, sportKey>, mismatches: string[] } — mismatches
 * lists fdoCodes where nothing in the live catalog matched, meaning
 * SPORT_KEY_FALLBACK's guess for that league needs manual correction.
 * Intended to be run once (manually) before relying on this integration,
 * the same way resolve-leagues.mjs is run manually for API-Football.
 */
export async function resolveSportKeys() {
  const sports = await oddsApiGet('/sports', {});
  const verified = new Map();
  const mismatches = [];

  for (const [fdoCode, guess] of Object.entries(SPORT_KEY_FALLBACK)) {
    const match = sports.find(
      (s) => s.key === guess.key || (s.title && s.title.includes(guess.titleMatch))
    );
    if (match) {
      verified.set(fdoCode, match.key);
    } else {
      mismatches.push(fdoCode);
    }
  }

  return { verified, mismatches };
}

/**
 * Odds for one sport key. markets defaults to the three market types the
 * majors pool actually uses (see toApiFootballOddsShape below) — requesting
 * only what's needed keeps the quota cost (markets × regions) down.
 */
export async function getOddsForSport(sportKey, { regions = 'uk,eu', markets = 'h2h,totals,btts' } = {}) {
  return oddsApiGet(`/sports/${sportKey}/odds`, {
    regions,
    markets,
    oddsFormat: 'decimal',
  });
}

/**
 * Reshapes one The Odds API event into the SAME shape
 * scripts/lib/apiFootball.mjs's /odds response has: an array of
 * { bookmakers: [{ bets: [{ name, values: [{ value, odd }] }] }] } — so
 * scripts/lib/markets.mjs's collectViableOutcomes (and generate-tickets.mjs's
 * pickMarketFromOdds, unchanged) can be reused for BOTH providers without
 * duplicating market-selection logic, per the project's shared-market-
 * catalog rule.
 *
 * Only the FIRST bookmaker in the event's list is used — same "use
 * bookmakers[0]" convention the API-Football path already follows.
 *
 * Deliberately NOT mapped: The Odds API's 'draw' outcome (Draw/Draw No Bet
 * markets are excluded from all selections per product rules) and its
 * 'double_chance' market (outcome naming wasn't confirmed against live
 * data at integration time — omitting it means those fixtures simply fall
 * back to whatever other market clears MIN_CONFIDENCE, never a fabricated
 * mapping).
 */
export function toApiFootballOddsShape(event) {
  if (!event?.bookmakers?.length) return [];
  const bookmaker = event.bookmakers[0];
  const bets = [];

  const h2h = bookmaker.markets?.find((m) => m.key === 'h2h');
  if (h2h) {
    const values = [];
    h2h.outcomes?.forEach((o) => {
      if (o.name === event.home_team) values.push({ value: 'Home', odd: String(o.price) });
      else if (o.name === event.away_team) values.push({ value: 'Away', odd: String(o.price) });
      // 'Draw' outcome intentionally dropped.
    });
    if (values.length > 0) bets.push({ name: 'Match Winner', values });
  }

  // Each distinct total (point) is a separate outcome pair in The Odds
  // API's response — flatten them all into one 'Goals Over/Under' bet with
  // values named exactly like MARKET_CATALOG's apiValue strings
  // ("Over 1.5", "Under 2.5", ...) so collectViableOutcomes matches them
  // with zero special-casing.
  const totalsValues = [];
  bookmaker.markets
    ?.filter((m) => m.key === 'totals')
    .forEach((m) => {
      m.outcomes?.forEach((o) => {
        if (typeof o.point !== 'number') return;
        totalsValues.push({ value: `${o.name} ${o.point}`, odd: String(o.price) });
      });
    });
  if (totalsValues.length > 0) bets.push({ name: 'Goals Over/Under', values: totalsValues });

  const btts = bookmaker.markets?.find((m) => m.key === 'btts');
  if (btts) {
    const values = (btts.outcomes ?? []).map((o) => ({ value: o.name, odd: String(o.price) }));
    if (values.length > 0) bets.push({ name: 'Both Teams Score', values });
  }

  return [{ bookmakers: [{ name: bookmaker.title, bets }] }];
}
