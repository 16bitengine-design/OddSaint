// ---------------------------------------------------------------------------
// Odd Saint — one-off diagnostic (NOT part of the pipeline)
//
// The supabase-js error object coming out of countSentToday() has
// message: '' and code/details/hint all undefined — that's not the shape
// of a normal PostgrestError, which means something is failing before
// postgrest-js gets a parseable JSON error body back. Rather than guess
// again through that abstraction, this hits the PostgREST REST endpoint
// directly with plain fetch() and prints the raw HTTP status + response
// body for the two tables send-lifecycle-emails.mjs depends on.
//
// Run manually (same env vars as the real pipeline scripts):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/diagnose-lifecycle-tables.mjs
//
// Delete this file once the real cause is found — it's a throwaway
// diagnostic, not a permanent part of the pipeline.
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}

console.log(`SUPABASE_URL = "${SUPABASE_URL}"`); // printed in full deliberately — it's not secret, and malformed values (missing scheme, trailing slash, wrong host) are a prime suspect here
console.log(`SUPABASE_SERVICE_ROLE_KEY length = ${SERVICE_ROLE_KEY.length} chars, starts with "${SERVICE_ROLE_KEY.slice(0, 6)}..."`);

async function probe(label, path, { method = 'GET', extraHeaders = {} } = {}) {
  const url = `${SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${path}`;
  console.log(`\n--- ${label} ---`);
  console.log(`${method} ${url}`);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
        ...extraHeaders,
      },
    });

    const bodyText = await res.text();
    console.log(`status: ${res.status} ${res.statusText}`);
    console.log(`content-range: ${res.headers.get('content-range')}`);
    console.log(`content-type: ${res.headers.get('content-type')}`);
    console.log(`body (raw, first 500 chars): ${JSON.stringify(bodyText.slice(0, 500))}`);
  } catch (err) {
    // A genuine network-level failure (DNS, TLS, connection refused) throws
    // here, before any HTTP response exists at all — distinct from the
    // table-not-found / permission-denied cases above, and the most likely
    // explanation for an error object with no HTTP-derived fields at all.
    console.log(`fetch() THREW (no HTTP response received): ${err?.name}: ${err?.message}`);
    if (err?.cause) console.log(`  cause: ${err.cause}`);
  }
}

async function main() {
  // 1. A plain GET, limited to 1 row — simplest possible request, isolates
  //    whether the table/columns/RLS are the issue at all.
  await probe('user_profiles: GET select', 'user_profiles?select=user_id,email,timezone&limit=1');
  await probe('notification_log: GET select', 'notification_log?select=id&limit=1');

  // 2. The EXACT request shape countSentToday() actually makes: HEAD +
  //    Prefer: count=exact, which is what supabase-js sends for
  //    `{ count: 'exact', head: true }`. If GET above works fine but this
  //    fails, the HEAD-request-with-count pattern itself is the problem.
  const startOfDayUTC = new Date();
  startOfDayUTC.setUTCHours(0, 0, 0, 0);
  await probe(
    'notification_log: HEAD count=exact (matches countSentToday)',
    `notification_log?select=id&sent_at=gte.${encodeURIComponent(startOfDayUTC.toISOString())}`,
    { method: 'HEAD', extraHeaders: { Prefer: 'count=exact' } }
  );
}

main();
