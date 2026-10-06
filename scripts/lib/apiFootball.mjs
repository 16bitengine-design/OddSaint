// ---------------------------------------------------------------------------
// Minimal API-Football (api-football.com / api-sports.io) client.
// Uses Node's built-in fetch (Node 18+), so no extra dependency is needed.
//
// Self-throttles under the per-minute limit and retries with backoff on a
// 429. Exports EVERY function the pipeline scripts import:
//   getFixturesForDate, getOddsForFixture, getFixturesByIds,
//   getLeaguesByCountry, getTeamsForLeague, getFixturesForTeam,
//   getStandings, getBookmakers, detectApiPlan
// ---------------------------------------------------------------------------

const API_BASE = 'https://v3.football.api-sports.io';

// Pro plan: 300 requests/minute. Stay comfortably under it. detectApiPlan()
// lowers this automatically if the account turns out to be on the Free plan
// (10 requests/minute).
let maxRequestsPerWindow = 250;
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
  if (requestTimestamps.length >= maxRequestsPerWindow) {
    const oldest = requestTimestamps[0];
    const waitMs = WINDOW_MS - (now - oldest) + 250;
    // eslint-disable-next-line no-console
    console.log(`Rate limit guard: waiting ${Math.ceil(waitMs / 1000)}s before next API-Football request...`);
    await sleep(waitMs);
    return waitForRateLimit();
  }
  requestTimestamps.push(Date.now());
}

function requireApiKey() {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    throw new Error('Missing API_FOOTBALL_KEY environment variable. Add it as a GitHub Actions secret.');
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

  const res = await fetch(url, { headers: { 'x-apisports-key': key } });

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

/** Bookmaker odds for a single fixture ID (may be empty for some leagues/fixtures). */
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

/** All teams in a league for a season (used by resolve-teams.mjs). */
export async function getTeamsForLeague(leagueId, season) {
  return apiFootballGet('/teams', { league: leagueId, season });
}

/** A team's most recent `last` fixtures, any competition (used by the history backfill and the Over 2.5 form rule). */
export async function getFixturesForTeam(teamId, last = 5) {
  return apiFootballGet('/fixtures', { team: teamId, last });
}

/** League table for a league + season: rank, games played and the last-5 `form` string per team. */
export async function getStandings(leagueId, season) {
  return apiFootballGet('/standings', { league: leagueId, season });
}

/** Every bookmaker API-Football carries odds for: [{ id, name }]. Used to find the IDs for TARGET_BOOKMAKER_IDS. */
export async function getBookmakers() {
  return apiFootballGet('/odds/bookmakers');
}

/**
 * Reads the account's plan from /status, logs it, and lowers the per-minute
 * request cap if it is the Free plan. Never throws — on any failure the
 * default (Pro-sized) cap stays in place.
 */
export async function detectApiPlan() {
  try {
    const status = await apiFootballGet('/status');
    const plan = String(status?.subscription?.plan ?? 'unknown');
    if (/free/i.test(plan)) maxRequestsPerWindow = 8;
    // eslint-disable-next-line no-console
    console.log(`API-Football plan detected: ${plan} (cap ${maxRequestsPerWindow} requests/minute).`);
    return plan;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Could not detect API-Football plan, keeping the default rate limit:', err.message);
    return 'unknown';
  }
}
