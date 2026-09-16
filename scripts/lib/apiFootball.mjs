// ---------------------------------------------------------------------------
// Minimal API-Football (api-football.com / api-sports.io) client.
// Uses Node's built-in fetch (Node 18+), so no extra dependency is needed.
//
// Odd Saint's ONLY football data provider — every fixture, odds, and league
// lookup in this app goes through this file.
//
// PLAN-AWARE THROTTLING: API-Football's request limits (per-minute and
// per-day) depend on your account's subscription plan. Instead of
// hardcoding one plan's numbers, detectApiPlan() below calls the account's
// own /status endpoint once per process run, reads back the REAL current
// plan + daily usage, and self-throttles from that — conservative
// Free-tier defaults until a paid plan is actually detected, not a guess.
// ---------------------------------------------------------------------------

const API_BASE = 'https://v3.football.api-sports.io';

// API-Football's Free plan is documented at 10 requests/minute — this
// client self-throttles to 8/minute (a safety margin) whenever the
// account isn't detected as a paid plan (including when detection hasn't
// run yet, or failed).
const FREE_PLAN_REQUESTS_PER_MINUTE = 8;

// API-Football's Free plan is documented at 100 requests/day. Used only as
// a signal (requests.limit_day > this) to recognize "some paid plan is
// active" from /status — NOT an exact match against any specific paid
// tier's real limit, which isn't guessed here.
const FREE_PLAN_DAILY_REQUEST_CEILING = 100;

// Self-throttle to use once a paid plan is detected. Deliberately NOT set
// to whatever your actual paid plan's per-minute cap is — that number
// isn't verified from this codebase and shouldn't be guessed here. This is
// a conservative bump over the Free-tier limit; override with
// API_FOOTBALL_PRO_RPM once you've checked your real plan's per-minute cap
// (Account → Subscription on the api-football.com dashboard, or their
// current pricing/docs page).
const DEFAULT_PRO_PLAN_REQUESTS_PER_MINUTE = 30;

const WINDOW_MS = 60_000;
const requestTimestamps = [];

// Set once per process by detectApiPlan(). Every script that wants
// plan-aware behavior (wider weekly lookahead, larger odds-lookup budget,
// etc.) should call detectApiPlan() once at startup and read
// getApiPlanInfo() afterward — nothing here re-detects mid-run, and
// nothing auto-detects on its own without that call being made.
let planInfo = null; // { plan, isPro, requestsLimitDay, requestsUsedToday, requestsPerMinute }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentRequestsPerMinute() {
  return planInfo?.requestsPerMinute ?? FREE_PLAN_REQUESTS_PER_MINUTE;
}

async function waitForRateLimit() {
  const now = Date.now();
  const limit = currentRequestsPerMinute();
  // Drop timestamps outside the current rolling window.
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= limit) {
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

// ---------------------------------------------------------------------------
// Plan detection
// ---------------------------------------------------------------------------
// Calls API-Football's own /status endpoint — the account's real, current
// subscription info, not an assumption. Response shape (api-sports.io v3):
//   { response: { subscription: { plan, active }, requests: { current, limit_day } } }
//
// Detected as "pro" (i.e. not Free) if EITHER the plan name isn't "Free"
// (case-insensitive) OR the account's documented daily request ceiling is
// above FREE_PLAN_DAILY_REQUEST_CEILING — the second check is a fallback in
// case the plan-name string format ever changes on API-Football's side.
//
// Safe to call multiple times / from multiple scripts in the same
// process — only the first call actually hits the network, the rest read
// the cached result. If it's never called at all, every apiFootballGet()
// call above just uses the conservative Free-tier throttle by default.
export async function detectApiPlan() {
  if (planInfo) return planInfo; // already detected this process run

  const key = requireApiKey();
  const url = new URL(`${API_BASE}/status`);

  try {
    await waitForRateLimit();
    const res = await fetch(url, { headers: { 'x-apisports-key': key } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    const sub = json?.response?.subscription;
    const requests = json?.response?.requests;

    const planName = typeof sub?.plan === 'string' ? sub.plan : 'Unknown';
    const requestsLimitDay = typeof requests?.limit_day === 'number' ? requests.limit_day : null;
    const requestsUsedToday = typeof requests?.current === 'number' ? requests.current : null;

    const isPro =
      planName.toLowerCase() !== 'free' ||
      (requestsLimitDay !== null && requestsLimitDay > FREE_PLAN_DAILY_REQUEST_CEILING);

    const requestsPerMinute = isPro
      ? Number(process.env.API_FOOTBALL_PRO_RPM) || DEFAULT_PRO_PLAN_REQUESTS_PER_MINUTE
      : FREE_PLAN_REQUESTS_PER_MINUTE;

    planInfo = { plan: planName, isPro, requestsLimitDay, requestsUsedToday, requestsPerMinute };

    // eslint-disable-next-line no-console
    console.log(
      `API-Football plan detected: ${planName} (${isPro ? 'pro-tier' : 'free-tier'} throttling, ` +
        `${requestsPerMinute}/min)` +
        (requestsLimitDay !== null ? ` — ${requestsUsedToday ?? '?'}/${requestsLimitDay} requests used today.` : '.')
    );
  } catch (err) {
    // Detection failing (network hiccup, unexpected response shape, etc.)
    // must never crash the run — fall back to the same conservative
    // Free-tier behavior that was already the default before this feature
    // existed.
    // eslint-disable-next-line no-console
    console.warn(
      `API-Football plan detection failed (${err.message}) — assuming Free plan and using conservative defaults.`
    );
    planInfo = {
      plan: 'Unknown (detection failed)',
      isPro: false,
      requestsLimitDay: null,
      requestsUsedToday: null,
      requestsPerMinute: FREE_PLAN_REQUESTS_PER_MINUTE,
    };
  }

  return planInfo;
}

/** Returns the plan info detected by detectApiPlan(), or null if detectApiPlan() hasn't been called yet this process run. */
export function getApiPlanInfo() {
  return planInfo;
}
