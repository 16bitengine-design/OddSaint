// ---------------------------------------------------------------------------
// Odd Saint — football-data.org fixtures client
//
// Powers the MAJORS pool only: Mega Day, Bronze, Silver, Gold, and Saint's
// Lock. This is a deliberate split introduced after the API-Football account
// suspension (see project history) — these tiers no longer depend on
// API-Football at all, so if that account goes down again, only the
// lengthy-ticket tiers (Platinum/Diamond/Weekly Lite/Weekly Titan, still
// sourced from scripts/lib/apiFootball.mjs) are affected.
//
// football-data.org's FREE tier covers exactly 12 competitions (see
// COMPETITION_CODES below) — this is a real, permanent scope limitation
// compared to API-Football's 1,236 leagues, accepted as a tradeoff for a
// provider that doesn't require payment. It has NO ODDS endpoint at all —
// odds for these same fixtures come from scripts/lib/theOddsApi.mjs and are
// joined by scripts/lib/fixtureMatcher.mjs.
//
// Auth: X-Auth-Token header (NOT a query param, NOT Bearer — this is the
// one detail football-data.org does differently from most REST APIs).
// Rate limit: 10 requests/minute on the free tier — self-throttled below,
// same pattern as scripts/lib/apiFootball.mjs.
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.football-data.org/v4';

// The 12 competitions available on football-data.org's free tier, confirmed
// against their own documentation (docs.football-data.org) as of this
// integration. If football-data.org changes what's free, this list is the
// one place to update it — nothing else in the pipeline hardcodes these
// codes elsewhere.
export const COMPETITION_CODES = [
  'PL',  // Premier League (England)
  'PD',  // La Liga (Spain) — football-data.org's code is "PD" (Primera Division), not "LL"
  'BL1', // Bundesliga (Germany)
  'SA',  // Serie A (Italy)
  'FL1', // Ligue 1 (France)
  'DED', // Eredivisie (Netherlands)
  'PPL', // Primeira Liga (Portugal)
  'ELC', // Championship (England, 2nd tier)
  'BSA', // Brasileirão (Brazil)
  'CL',  // UEFA Champions League
  'WC',  // FIFA World Cup
  'EC',  // UEFA European Championship
];

// Self-throttle to stay under the free tier's 10 requests/minute — mirrors
// the rate-limit guard in scripts/lib/apiFootball.mjs so both providers
// behave consistently under the same GitHub Actions run.
const MAX_REQUESTS_PER_WINDOW = 8;
const WINDOW_MS = 60_000;
const requestTimestamps = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimit() {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldest = requestTimestamps[0];
    const waitMs = WINDOW_MS - (now - oldest) + 250;
    // eslint-disable-next-line no-console
    console.log(`football-data.org rate limit guard: waiting ${Math.ceil(waitMs / 1000)}s...`);
    await sleep(waitMs);
    return waitForRateLimit();
  }
  requestTimestamps.push(Date.now());
}

function requireToken() {
  const token = process.env.FOOTBALL_DATA_ORG_TOKEN;
  if (!token) {
    throw new Error(
      'Missing FOOTBALL_DATA_ORG_TOKEN environment variable. Add it as a GitHub Actions secret ' +
        '(register a free account at https://www.football-data.org/client/register).'
    );
  }
  return token;
}

async function fdoGet(path, params = {}, attempt = 1) {
  const token = requireToken();
  const url = new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  await waitForRateLimit();

  const res = await fetch(url, {
    headers: { 'X-Auth-Token': token },
  });

  if (res.status === 429) {
    const MAX_ATTEMPTS = 4;
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`football-data.org rate limit exceeded after ${attempt} attempts: ${url}`);
    }
    const retryAfterHeader = res.headers.get('retry-after') || res.headers.get('X-RequestCounter-Reset');
    const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : WINDOW_MS;
    // eslint-disable-next-line no-console
    console.warn(`429 from football-data.org (attempt ${attempt}), waiting ${Math.ceil(waitMs / 1000)}s and retrying...`);
    await sleep(waitMs);
    return fdoGet(path, params, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`football-data.org request failed (${res.status}): ${url} — ${await res.text()}`);
  }

  return res.json();
}

/**
 * Matches for all 12 free competitions within a date range (inclusive).
 * dateFromStr/dateToStr are 'YYYY-MM-DD'. No status filter is applied —
 * same convention as apiFootball.mjs's getFixturesForDate, which also
 * returns fixtures regardless of status and lets odds availability
 * naturally exclude already-started/finished matches from selection.
 */
export async function getMatchesForDateRange(dateFromStr, dateToStr) {
  const data = await fdoGet('/matches', {
    competitions: COMPETITION_CODES.join(','),
    dateFrom: dateFromStr,
    dateTo: dateToStr,
  });
  return data.matches ?? [];
}

/**
 * Re-fetch specific matches by football-data.org's OWN (un-offset) numeric
 * ID — used by scripts/grade-tickets.mjs to check final scores. Callers
 * must pass native football-data.org IDs, not the offset IDs stored in the
 * `fixtures` table — see MAJORS_ID_OFFSET in generate-tickets.mjs and
 * strip it before calling this.
 */
export async function getMatchesByIds(nativeIds) {
  if (nativeIds.length === 0) return [];
  const data = await fdoGet('/matches', { ids: nativeIds.join(',') });
  return data.matches ?? [];
}

/** football-data.org status values that mean "match is over, final score is authoritative". */
export const FDO_FINISHED_STATUSES = new Set(['FINISHED']);
