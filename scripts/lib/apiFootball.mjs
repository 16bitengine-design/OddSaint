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

// ---------------------------------------------------------------------------
// API-Football sometimes reports a problem via HTTP 200 with a populated
// `errors` object rather than a non-2xx status — a plain `res.ok` check
// doesn't catch this. Most of these are query-shaped (a single bad
// parameter, a date outside the free plan's window — see
// WEEKLY_LOOKAHEAD_DAYS in generate-tickets.mjs) and are safe to log and
// move past, since they only affect that one request.
//
// An ACCOUNT-LEVEL error (suspended, expired subscription, revoked token)
// is categorically different: it means every subsequent call this run —
// and every run after it, until someone notices — will return the same
// empty response. Previously this was only ever logged with
// console.warn(), so the script finished normally, wrote zero tickets, and
// GitHub Actions still showed a green checkmark. That's exactly what
// happened from 2026-09-04 to 2026-09-08: four days of "successful" runs
// producing nothing, caught only when someone happened to check the
// Supabase table directly.
//
// ApiFootballFatalError marks this class of error so callers can choose to
// propagate it (failing the whole script, turning the Actions run red)
// instead of silently continuing — see the try/catch sites in
// generate-tickets.mjs (odds lookup loop) and resolve-leagues.mjs
// (per-country loop), which specifically re-throw this type rather than
// swallowing it like an ordinary per-request failure.
// ---------------------------------------------------------------------------
export class ApiFootballFatalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApiFootballFatalError';
  }
}

// Error object *keys* API-Football uses for account/credential-level
// problems, as opposed to a per-query complaint (e.g. a bad date or
// unsupported parameter, which come back under other keys and are safe to
// treat as non-fatal).
const FATAL_ERROR_KEYS = new Set(['access', 'auth', 'authentication', 'token', 'subscription', 'plan']);

// Backstop in case API-Football ever nests an account-status message under
// a key not listed above — matches on the wording itself rather than
// relying solely on the key name.
const FATAL_MESSAGE_PATTERN = /suspend|deactivat|expired|inactive|not\s+active|revoked|blocked/i;

/** Returns a short "key: message" string if `errors` contains an account-level problem, else null. */
function findFatalApiError(errors) {
  if (!errors || typeof errors !== 'object') return null;
  for (const [key, value] of Object.entries(errors)) {
    const message = String(value);
    const keyLooksFatal = FATAL_ERROR_KEYS.has(key.toLowerCase());
    const messageLooksFatal = FATAL_MESSAGE_PATTERN.test(message);
    if (keyLooksFatal || messageLooksFatal) {
      return `${key}: ${message}`;
    }
  }
  return null;
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
    const fatal = findFatalApiError(json.errors);
    if (fatal) {
      // Deliberately thrown, not just logged — see ApiFootballFatalError
      // above for why this specific class of error must not be treated
      // like an ordinary per-request warning.
      throw new ApiFootballFatalError(
        `API-Football account/credential error (this will keep failing on every subsequent call until resolved on the API-Football dashboard): ${fatal}`
      );
    }
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
