// ---------------------------------------------------------------------------
// One-off patch: fixes Saint's Lock never being generated.
//
// Run from the repo root:  node scripts/apply-saints-lock-fix.mjs
// Then review with `git diff scripts/generate-tickets.mjs` before committing.
//
// Safe by design: every edit is an exact-match anchor that must occur
// exactly once. If ANY anchor doesn't match (your file differs from the
// version this was written against), nothing is written and the script
// says which anchor failed. Delete this script after applying it.
//
// ROOT CAUSE being fixed: confidence = round(100 / odds), so
//   - MIN_CONFIDENCE 68 caps every pooled fixture's picked odds at ~1.48,
//   - Saint's Lock needs odds 1.5-2.0  -> the pool can never contain one,
//   - and SAINTS_LOCK_MIN_CONFIDENCE 85 would need odds <= ~1.18 anyway.
// Also, each fixture only kept its single lowest-odds market, so Saint's
// Lock could never choose a straight win / Over 2.5 for itself.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'scripts/generate-tickets.mjs';
let src = readFileSync(PATH, 'utf8');

function fail(label, why) {
  console.error('Patch aborted, nothing written. Anchor "' + label + '" ' + why + '.');
  process.exit(1);
}

if (src.includes('pickSaintsLockOutcome')) {
  console.error('Already applied (pickSaintsLockOutcome exists). Nothing to do.');
  process.exit(0);
}

function replaceOnce(find, repl, label) {
  const first = src.indexOf(find);
  if (first === -1) fail(label, 'was not found');
  if (src.indexOf(find, first + 1) !== -1) fail(label, 'matched more than once');
  src = src.slice(0, first) + repl + src.slice(first + find.length);
}

function replaceRegexOnce(re, repl, label) {
  const all = src.match(new RegExp(re.source, 'g'));
  if (!all) fail(label, 'was not found');
  if (all.length > 1) fail(label, 'matched more than once');
  src = src.replace(re, () => repl);
}

function replaceBetween(startMarker, endMarker, repl, label) {
  const start = src.indexOf(startMarker);
  if (start === -1) fail(label, 'start marker not found');
  const end = src.indexOf(endMarker, start);
  if (end === -1) fail(label, 'end marker not found');
  src = src.slice(0, start) + repl + src.slice(end + endMarker.length);
}

// 1. New helper: price every fixture for Saint's Lock independently ------------
replaceOnce(
  'function impliedConfidence(odds) {',
  `// Saint's Lock rule: straight win or Over 2.5 Goals only (double chance and
// Over 1.5 excluded), priced 1.5-2.0. Evaluated separately from
// pickMarketFromOdds, whose lowest-odds-wins logic (capped at ~1.48 by
// MIN_CONFIDENCE) can never land in that band. Lowest odds in the band =
// highest implied probability = the safest qualifying option.
const SAINTS_LOCK_MARKETS = new Set(['Home Win', 'Away Win', 'Over 2.5 Goals']);

function pickSaintsLockOutcome(oddsResponse) {
  const bookmaker = oddsResponse?.[0]?.bookmakers?.[0];
  if (!bookmaker) return null;

  const [minOdds, maxOdds] = TIER_ODDS_TARGET.saints_lock;
  const candidates = collectViableOutcomes(bookmaker.bets)
    .filter((o) => SAINTS_LOCK_MARKETS.has(o.market) && o.odds >= minOdds && o.odds <= maxOdds)
    .sort((a, b) => a.odds - b.odds);
  if (candidates.length === 0) return null;

  const best = candidates[0];
  return { market: best.market, odds: best.odds, confidence: impliedConfidence(best.odds) };
}

function impliedConfidence(odds) {`,
  'impliedConfidence anchor'
);

// 2. Keep fixtures that only qualify for Saint's Lock ---------------------------
replaceRegexOnce(
  /const picked = pickMarketFromOdds\(oddsResponse\);\s*if \(!picked\) continue;[^\n]*/,
  `const picked = pickMarketFromOdds(oddsResponse);
          const lock = pickSaintsLockOutcome(oddsResponse);
          if (!picked && !lock) continue; // nothing usable for any tier — skip it`,
  'picked / continue'
);

replaceRegexOnce(
  /market: picked\.market,\s*odds: picked\.odds,\s*confidence: picked\.confidence,/,
  `// null when the fixture only qualifies for Saint's Lock — regular
            // tiers filter those out (see regularOnly in buildTickets).
            market: picked?.market ?? null,
            odds: picked?.odds ?? null,
            confidence: picked?.confidence ?? null,
            lock,`,
  'seen.set fields'
);

replaceRegexOnce(
  /return b\.confidence - a\.confidence;/,
  'return (b.confidence ?? 0) - (a.confidence ?? 0);',
  'final sort'
);

// 3. Replace the Saint's Lock builder --------------------------------------------
replaceBetween(
  "// Saint's Lock demands a far higher confidence bar than any other tier",
  'return { tickets, ticketMatches, fixturesUsed: [pick], usedFallback };\n}',
  `// Saint's Lock: ONE match per ticket, straight win or Over 2.5 Goals, priced
// 1.5-2.0, produced in EVERY release batch (both daily slots).
//
// The old 85% confidence floor is gone. Confidence here is 100/odds, so 85%
// means odds <= ~1.18 — impossible inside a 1.5-2.0 band. Selection is now:
// among today's fixtures that price 1.5-2.0 on an allowed market, take the
// lowest odds (highest implied probability). Note that means implied
// probability tops out around 67% — see the product-copy note in the
// hand-off; "ultra-high-confidence" wording isn't supportable at these odds.
//
// A fixture used for Saint's Lock is EXCLUSIVE to it: fixtures.market holds
// one market per fixture and grading settles that market, so the same
// fixture can't also sit on a regular ticket under a different market.
// blockedFixtureIds = fixtures already written by earlier runs today (never
// re-price a fixture that's already on a ticket). usageCount is set to the
// daily max so regular tiers skip it for the rest of this run.
function buildSaintsLockTickets(dailyPool, usageCount, today, slot, now, blockedFixtureIds) {
  const config = TIER_CONFIG.find((c) => c.tier === 'saints_lock');

  const candidates = dailyPool
    .filter((p) => p.lock && !blockedFixtureIds.has(p.fixtureId) && (usageCount.get(p.fixtureId) ?? 0) === 0)
    .sort(
      (a, b) =>
        a.lock.odds - b.lock.odds ||
        (PRIORITY_LEAGUE_NAMES.has(b.league) ? 1 : 0) - (PRIORITY_LEAGUE_NAMES.has(a.league) ? 1 : 0)
    );

  if (candidates.length === 0) {
    console.warn(
      "Saint's Lock: no unused fixture today prices 1.5-2.0 on a straight win or Over 2.5 Goals — nothing produced for this slot."
    );
    return { tickets: [], ticketMatches: [], fixturesUsed: [] };
  }

  const chosen = candidates[0];
  // The fixtures row (and therefore grading) must carry the Saint's Lock
  // market, not whatever the regular pick would have been.
  const pick = { ...chosen, market: chosen.lock.market, odds: chosen.lock.odds, confidence: chosen.lock.confidence };
  usageCount.set(pick.fixtureId, MAX_FIXTURE_APPEARANCES_PER_DAY);

  const ticketId = today + '-saints_lock-' + slot;
  const availableAtIso = new Date(now.getTime() + AVAILABILITY_DELAY_MS).toISOString();

  const tickets = [
    {
      id: ticketId,
      ticket_date: today,
      tier: 'saints_lock',
      slip_label: null,
      match_count: 1,
      odds_range: config.oddsRange,
      total_odds: pick.odds,
      is_free: false,
      release_slot: slot,
      available_at: availableAtIso,
    },
  ];
  const ticketMatches = [{ ticket_id: ticketId, fixture_id: pick.fixtureId, sort_order: 0 }];

  return { tickets, ticketMatches, fixturesUsed: [pick] };
}`,
  "buildSaintsLockTickets block"
);

// 4. buildTickets: regular pools + pass blocked ids --------------------------------
replaceOnce(
  'function buildTickets(dailyPool, weeklyPool, weekenderPool, slipState, now) {',
  'function buildTickets(dailyPool, weeklyPool, weekenderPool, slipState, now, fixtureState) {',
  'buildTickets signature'
);

replaceOnce(
  'const usageCount = new Map(); // shared across every tier/slip for the day',
  `const usageCount = new Map(); // shared across every tier/slip for the day

  // Regular tiers only see fixtures that have a normal pick (market != null)
  // and that aren't already a Saint's Lock fixture from an earlier run today.
  const regularOnly = (pool) => pool.filter((f) => f.market && !fixtureState.existingLockIds.has(f.fixtureId));
  const regularDaily = regularOnly(dailyPool);
  const regularWeekly = regularOnly(weeklyPool);
  const regularWeekender = regularOnly(weekenderPool);`,
  'usageCount declaration'
);

replaceOnce(
  'buildSaintsLockTickets(dailyPool, usageCount, today, saintsLockSlot, now);',
  'buildSaintsLockTickets(dailyPool, usageCount, today, saintsLockSlot, now, fixtureState.existingTodayIds);',
  'buildSaintsLockTickets call'
);

replaceOnce(
  'const basePool = isWeekender ? weekenderPool : isWeekly ? weeklyPool : dailyPool;',
  'const basePool = isWeekender ? regularWeekender : isWeekly ? regularWeekly : regularDaily;',
  'basePool'
);

// 5. main(): load today's fixture state ---------------------------------------------
replaceOnce(
  'async function main() {',
  `/**
 * Which fixtures earlier runs today already wrote, and which of those are
 * Saint's Lock fixtures. Lets a later run avoid (a) stealing a fixture that's
 * already on a ticket for Saint's Lock and (b) reusing an existing Saint's
 * Lock fixture on a regular ticket under a different market.
 */
async function fetchTodaysFixtureState(supabase, today) {
  const { data: fixtureRows, error } = await supabase.from('fixtures').select('id').eq('ticket_date', today);
  if (error) throw error;

  const { data: lockTickets, error: lockErr } = await supabase
    .from('tickets')
    .select('ticket_matches ( fixture_id )')
    .eq('ticket_date', today)
    .eq('tier', 'saints_lock');
  if (lockErr) throw lockErr;

  return {
    existingTodayIds: new Set((fixtureRows ?? []).map((r) => r.id)),
    existingLockIds: new Set(
      (lockTickets ?? []).flatMap((t) => (t.ticket_matches ?? []).map((m) => m.fixture_id))
    ),
  };
}

async function main() {`,
  'main anchor'
);

replaceOnce(
  'const slipState = await fetchTodaysSlipState(supabase, todayStr);',
  `const slipState = await fetchTodaysSlipState(supabase, todayStr);
  const fixtureState = await fetchTodaysFixtureState(supabase, todayStr);`,
  'slipState fetch'
);

replaceOnce(
  'buildTickets(dailyPool, weeklyPool, weekenderPool, slipState, today);',
  'buildTickets(dailyPool, weeklyPool, weekenderPool, slipState, today, fixtureState);',
  'buildTickets call'
);

writeFileSync(PATH, src);
console.log('Saint\'s Lock fix applied to ' + PATH + '. Review with: git diff ' + PATH);
