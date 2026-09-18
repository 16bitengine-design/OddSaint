// ---------------------------------------------------------------------------
// Minimal API-Football (api-football.com / api-sports.io) client.
// Uses Node's built-in fetch (Node 18+), so no extra dependency is needed.
//
// Sign up at https://www.api-football.com — the Pro plan enforces 300
// requests/minute and a 7,500/day cap. This client self-throttles to stay
// comfortably under the per-minute limit, and retries with backoff if a
// 429 slips through anyway, rather than crashing the whole run.
// ---------------------------------------------------------------------------

const API_BASE = 'https://v3.football.api-sports.io';

// Pro plan allows 300 requests/minute — stay comfortably under that with a
// safety margin, and share this limiter across every call this process
// makes (daily, weekly, and weekender fixture pools in the same run).
const MAX_REQUESTS_PER_WINDOW = 250;
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
