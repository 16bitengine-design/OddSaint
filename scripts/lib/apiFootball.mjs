// ---------------------------------------------------------------------------
// Minimal API-Football (api-football.com / api-sports.io) client.
// Uses Node's built-in fetch (Node 18+), so no extra dependency is needed.
//
// Sign up at https://www.api-football.com — the free plan enforces a hard
// rate limit of 10 requests/minute (in addition to a daily cap). This
// client self-throttles to stay under that, and retries with backoff if a
// 429 slips through anyway, rather than crashing the whole run.
// ---------------------------------------------------------------------------

const API_BASE = 'https://v3.football.api-sports.io';

// Free plan allows 10 requests/minute — stay comfortably under that with a
// safety margin, and share this limiter across every call this process
// makes (both the daily and weekly fixture pools in the same run).
const MAX_REQUESTS_PER_WINDOW = 8;
const WINDOW_MS = 60_000;
const requestTimestamps = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimit() {
  const now = Date.now();
  // Drop timestamps outside the current rolling window.
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldest = requestTimestamps[0];
    const waitMs = WINDOW_MS - (now - oldest) + 250; // small buffer past the window edge
    // eslint-disable-next-line no-console
    console.log(`Rate limit guard: waiting ${Math.ceil(waitMs / 1000)}s before next API-Football request...`);
    await sleep(waitMs);
    return waitForRateLimit(); // re-check after waiting, in case more time needs to pass
  }
  requestTimestamps.push(Date.now());
}

function requireApiKey() {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    throw new Error(
      'Missing API_FOOTBALL_KEY environment variable. Add it as a GitHub Actions secret.'
    );
  }
  return key;
}

async function apiFootballGet(path, params = {}, attempt = 1) {
  const key = requireApiKey();
  const url = new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  await waitForRateLimit();

  const res = await fetch(url, {
    headers: { 'x-apisports-key': key },
  });

  if (res.status === 429) {
    const MAX_ATTEMPTS = 4;
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`API-Football rate limit exceeded after ${attempt} attempts: ${url}`);
    }
    const retryAfterHeader = res.headers.get('retry-after');
    const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : WINDOW_MS;
    // eslint-disable-next-line no-console
    console.warn(`429 from API-Football (attempt ${attempt}), waiting ${Math.ceil(waitMs / 1000)}s and retrying...`);
    await sleep(waitMs);
    return apiFootballGet(path, params, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`API-Football request failed (${res.status}): ${url}`);
  }

  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length > 0) {
    // eslint-disable-next-line no-console
    console.warn('API-Football returned errors:', json.errors);
  }
  return json.response ?? [];
}

/** Fixtures scheduled on a given YYYY-MM-DD date. */
export async function getFixturesForDate(dateStr) {
  return apiFootballGet('/fixtures', { date: dateStr });
}

/** Bookmaker odds for a single fixture ID (may be empty on the free plan for some leagues/fixtures). */
export async function getOddsForFixture(fixtureId) {
  return apiFootballGet('/odds', { fixture: fixtureId });
}

/** Re-fetch specific fixtures by ID — used to check final scores for grading. */
export async function getFixturesByIds(ids) {
  if (ids.length === 0) return [];
  return apiFootballGet('/fixtures', { ids: ids.join('-') });
}

/** All leagues/cups API-Football has for a given country name. */
export async function getLeaguesByCountry(country) {
  return apiFootballGet('/leagues', { country });
}

/**
 * All teams API-Football has for a given league + season — used by
 * scripts/resolve-teams.mjs to discover each team's stable numeric ID
 * (entry.team.id) alongside its current name (entry.team.name). Verified
 * against current API-Football v3 docs: GET /teams accepts `league` +
 * `season`.
 */
export async function getTeamsForLeague(leagueId, season) {
  return apiFootballGet('/teams', { league: leagueId, season });
}

/**
 * A specific team's most recent finished fixtures — used by
 * scripts/backfill-team-history.mjs to build a real per-team result
 * history independent of whether that team was ever picked for a ticket.
 * Verified against current API-Football v3 docs: GET /fixtures accepts
 * `team` (the team's numeric ID) + `last` (how many past fixtures, max 2
 * digits).
 */
export async function getFixturesForTeam(teamId, last = 20) {
  return apiFootballGet('/fixtures', { team: teamId, last });
}
