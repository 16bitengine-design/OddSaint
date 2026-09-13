// ---------------------------------------------------------------------------
// Odd Saint — GA4 Data API client (audit reports only)
//
// Visitor counts, traffic source, geography, and age-band data already
// live in Google Analytics — layout.tsx fires GA4 on every page load — so
// there's no reason to duplicate that collection in Supabase. This file
// pulls it back OUT of GA4 at report time via the GA4 Data API
// (analyticsdata.googleapis.com), using a Google service account.
//
// ZERO EXTRA DEPENDENCIES, on purpose (same principle as
// scripts/lib/apiFootball.mjs): the service-account OAuth2 flow is just a
// signed JWT exchanged for a bearer token, which Node's built-in
// node:crypto + fetch can do without pulling in `googleapis`.
//
// SETUP (one-time, not done by this file):
//   1. In Google Cloud Console, create a service account, enable the
//      "Google Analytics Data API", and download its JSON key.
//   2. In GA4 Admin → Property Access Management, add that service
//      account's email as a Viewer on the property.
//   3. Store the entire downloaded JSON as the GA4_SERVICE_ACCOUNT_KEY
//      GitHub Actions secret (paste the whole file contents).
//   4. Store the numeric GA4 property ID (Admin → Property Settings) as
//      GA4_PROPERTY_ID.
//
// HONEST SCOPE NOTE: age-band and gender data require Google Signals /
// demographics reporting to be enabled on the property, which depends on
// consent settings and traffic volume — getAgeBreakdown() below may
// legitimately return an empty array even when everything is configured
// correctly. Every function in this file degrades to an empty/null result
// rather than throwing, so a missing or not-yet-populated GA4 property
// never breaks the audit report — it just shows "no data" for that section.
// ---------------------------------------------------------------------------
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATA_API_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

let cachedToken = null; // { token, expiresAt }

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Reads and parses the two required env vars. Returns null (rather than
 * throwing) if either is missing — GA4 reporting is treated as optional:
 * every audit script should still produce a useful report from Supabase
 * data alone if GA4 isn't configured yet.
 */
export function getGa4Config() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const rawKey = process.env.GA4_SERVICE_ACCOUNT_KEY;
  if (!propertyId || !rawKey) return null;

  let key;
  try {
    key = JSON.parse(rawKey);
  } catch {
    console.warn('[GA4] GA4_SERVICE_ACCOUNT_KEY is not valid JSON — skipping GA4 sections of this report.');
    return null;
  }
  if (!key.client_email || !key.private_key) {
    console.warn('[GA4] GA4_SERVICE_ACCOUNT_KEY is missing client_email/private_key — skipping GA4 sections.');
    return null;
  }
  return { propertyId, clientEmail: key.client_email, privateKey: key.private_key };
}

function buildAssertionJwt(clientEmail, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${unsigned}.${signature}`;
}

async function getAccessToken(config) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token;

  const assertion = buildAssertionJwt(config.clientEmail, config.privateKey);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    throw new Error(`GA4 OAuth token exchange failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3500) * 1000 };
  return cachedToken.token;
}

/** Low-level runReport call. Returns the raw GA4 Data API response, or null on any failure. */
async function runReport(config, body) {
  try {
    const token = await getAccessToken(config);
    const res = await fetch(`${DATA_API_BASE}/properties/${config.propertyId}:runReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[GA4] runReport failed (${res.status}): ${await res.text()}`);
      return null;
    }
    return res.json();
  } catch (err) {
    console.warn('[GA4] runReport threw:', err.message);
    return null;
  }
}

/** Converts a GA4 report response into an array of plain objects keyed by dimension/metric name. */
function parseRows(response, dimensionNames, metricNames) {
  if (!response?.rows) return [];
  return response.rows.map((row) => {
    const out = {};
    dimensionNames.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value ?? null;
    });
    metricNames.forEach((name, i) => {
      const raw = row.metricValues?.[i]?.value;
      out[name] = raw !== undefined ? Number(raw) : null;
    });
    return out;
  });
}

/** Headline totals for the window: active/new users, sessions, engaged sessions, average engagement time. */
export async function getTrafficOverview(config, startDate, endDate) {
  const response = await runReport(config, {
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: 'activeUsers' },
      { name: 'newUsers' },
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'averageSessionDuration' },
    ],
  });
  if (!response?.rows?.[0]) return null;

  const [activeUsers, newUsers, sessions, engagedSessions, avgSessionDurationSec] = response.rows[0].metricValues.map(
    (m) => Number(m.value)
  );
  return { activeUsers, newUsers, sessions, engagedSessions, avgSessionDurationSec };
}

/** Sessions by default channel grouping (Organic Search, Direct, Referral, Paid Social, etc). */
export async function getTrafficSources(config, startDate, endDate, limit = 10) {
  const response = await runReport(config, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit,
  });
  return parseRows(response, ['channel'], ['sessions']);
}

/** Active users by country. */
export async function getGeoBreakdown(config, startDate, endDate, limit = 10) {
  const response = await runReport(config, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'country' }],
    metrics: [{ name: 'activeUsers' }],
    orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
    limit,
  });
  return parseRows(response, ['country'], ['activeUsers']);
}

/**
 * Active users by age bracket. Requires Google Signals / demographics
 * reporting to be enabled on the property — returns an empty array (not an
 * error) if that data isn't available, which is a legitimate, expected
 * state, not a failure.
 */
export async function getAgeBreakdown(config, startDate, endDate) {
  const response = await runReport(config, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'userAgeBracket' }],
    metrics: [{ name: 'activeUsers' }],
    orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
  });
  return parseRows(response, ['ageBracket'], ['activeUsers']);
}

/** Most-viewed pages by path. */
export async function getTopPages(config, startDate, endDate, limit = 10) {
  const response = await runReport(config, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit,
  });
  return parseRows(response, ['pagePath'], ['screenPageViews']);
}
