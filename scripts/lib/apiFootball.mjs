// ---------------------------------------------------------------------------
// Minimal API-Football (api-football.com / api-sports.io) client.
// Uses Node's built-in fetch (Node 18+), so no extra dependency is needed.
//
// Sign up at https://www.api-football.com — the free plan enforces a
// CONFIRMED hard cap of 100 requests/day (resetting at 00:00 UTC, no
// rollover) and a rate limit of 10 requests/minute.
//
// DAILY BUDGET PROTECTION: API-Football appends real, server-reported
// rate-limit headers to every single response — see
// https://www.api-football.com/news/post/how-ratelimit-works:
//   x-ratelimit-requests-limit      — requests allocated per day
//   x-ratelimit-requests-remaining  — requests left today, right now
// This is the authoritative source of truth for the daily budget, since it
// reflects the WHOLE account's usage — including anything else that hit
// this same key today (a manual workflow run, resolve-leagues.mjs, etc.),
// not just what this one process has spent. This client tracks that
// number after every response and REFUSES to make another request once it
// drops to DAILY_SAFETY_MARGIN or below, throwing
// ApiFootballBudgetExhaustedError instead. Every caller in this codebase
// catches that specific error and degrades gracefully (uses whatever was
// already fetched, skips the rest of the run) rather than crashing or
// risking a 429 / account block.
//
// The one unavoidable gap: this process can't know the account's remaining
// count before it has made at least one request of its own — the very
// first call of a run always fires "blind". Every call after that is
// protected.
// ---------------------------------------------------------------------------

const API_BASE = 'https://v3.football.api-sports.io';

// Free plan allows 10 requests/minute — stay comfortably under that with a
// safety margin, and share this limiter across every call this process
// makes (both the daily and weekly fixture pools in the same run).
const MAX_REQUESTS_PER_WINDOW = 8;
const WINDOW_MS = 60_000;
const requestTimestamps = [];

// Once the server's own reported daily-remaining count drops to this level
// or below, no further requests are attempted THIS PROCESS. Reserves a
// small cushion for: (a) the inherent one-request lag — we only learn the
// count AFTER a request completes, never before it — and (b) any other
// same-day activity on this key we don't have visibility into yet.
const DAILY_SAFETY_MARGIN = 5;

// Populated from the x-ratelimit-requests-* headers after the FIRST
// request this process makes. Both fields stay null until then.
const dailyBudget = { remaining: null, limit: null };

export class ApiFootballBudgetExhaustedError extends Error {
  constructor(remaining, limit) {
    super(
      `API-Football daily request budget is exhausted or nearly exhausted: ` +
        `${remaining ?? '?'} of ${limit ?? '?'} remaining today (safety margin: ${DAILY_SAFETY_MARGIN}). ` +
        `Resets at 00:00 UTC.`
    );
    this.name = 'ApiFootballBudgetExhaustedError';
    this.remaining = remaining;
    this.limit = limit;
  }
}

/**
 * Current known daily budget state, as of the last response this process
 * received. Both fields are null until at least one request has been made
 * — there is no way to know the count in advance of any call.
 */
export function getDailyBudgetStatus() {
  return { ...dailyBudget };
}

function updateDailyBudgetFromHeaders(res) {
  const remaining = res.headers.get('x-ratelimit-requests-remaining');
  const limit = res.headers.get('x-ratelimit-requests-limit');
  if (remaining !== null && remaining !== '') dailyBudget.remaining = Number(remaining);
  if (limit !== null && limit !== '') dailyBudget.limit = Number(limit);
}

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
  // Refuse to spend another request once we already know (from an earlier
  // response THIS run) that the account is at or below the safety margin.
  // Checked before the per-minute wait too, so a near-exhausted daily
  // budget fails fast instead of waiting a minute just to be rejected.
  if (dailyBudget.remaining !== null && dailyBudget.remaining <= DAILY_SAFETY_MARGIN) {
    throw new ApiFootballBudgetExhaustedError(dailyBudget.remaining, dailyBudget.limit);
  }

  const key = requireApiKey();
  const url = new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  await waitForRateLimit();

  const res = await fetch(url, {
    headers: { 'x-apisports-key': key },
  });

  // Capture the real daily-remaining count regardless of status code —
  // even a 429 response carries these headers, and we want the freshest
  // known value either way.
  updateDailyBudgetFromHeaders(res);

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
