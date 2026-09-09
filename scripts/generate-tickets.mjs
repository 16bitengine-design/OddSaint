// ---------------------------------------------------------------------------
// Odd Saint — daily ticket generation
//
// TWO INDEPENDENT DATA SOURCES as of this update (see CLAUDE.md / project
// instructions for the full rationale — this replaced a single-provider
// design after the original API-Football account was suspended):
//
//   MAJORS POOL  — Mega Day, Bronze, Silver, Gold, Saint's Lock
//     Fixtures: football-data.org (12 free competitions, see
//       scripts/lib/footballDataOrg.mjs)
//     Odds: The Odds API (see scripts/lib/theOddsApi.mjs)
//     Joined by team name + kickoff time (scripts/lib/fixtureMatcher.mjs),
//     since the two providers share no fixture ID.
//
//   LENGTHY POOL — Platinum, Diamond, Weekly Lite, Weekly Titan
//     Fixtures + odds: API-Football (scripts/lib/apiFootball.mjs), same as
//     before, but its league allowlist no longer includes the 12 majors —
//     those moved to the majors pool, freeing API-Football's limited daily
//     request budget for the regional/lower leagues the lengthy tiers need
//     to fill 9–29 legs.
//
// This split is deliberate resilience, not just a data-source swap: if
// API-Football is suspended or down again, only the lengthy tiers are
// affected — Mega/Bronze/Silver/Gold/Saint's Lock keep running on
// football-data.org + The Odds API independently. Each pool's fetch is
// wrapped separately in main() so one provider's failure doesn't take out
// the other's tiers.
//
// Runs TWICE a day via .github/workflows/generate-tickets.yml (06:00 and
// 14:00 UTC) so each tier's daily tickets release in two staggered
// batches — see fetchTodaysSlipState/nextSlotFor below.
//
// HONEST SCOPE NOTE: the "AI Confidence Index" here is a simple, transparent
// heuristic derived from bookmaker consensus odds (implied probability),
// not a trained model, for BOTH pools.
// ---------------------------------------------------------------------------
import { getFixturesForDate, getOddsForFixture } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { collectViableOutcomes } from './lib/markets.mjs';
import {
  COMPETITION_CODES as FDO_COMPETITION_CODES,
  getMatchesForDateRange as getFdoMatchesForDateRange,
} from './lib/footballDataOrg.mjs';
import { SPORT_KEY_FALLBACK, getOddsForSport, toApiFootballOddsShape } from './lib/theOddsApi.mjs';
import { matchFixtures } from './lib/fixtureMatcher.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEAGUES_JSON_PATH = join(__dirname, 'lib', 'leagues.json');

// --- Config -----------------------------------------------------------------

// LENGTHY POOL (API-Football) league allowlist. The 12 football-data.org
// majors (Premier League, La Liga, Bundesliga, Serie A, Ligue 1,
// Eredivisie, Primeira Liga, Championship, Brasileirão, Champions League,
// World Cup, Euros) are deliberately NOT here anymore — they're sourced
// from the majors pool instead. UEFA Europa League stays here since
// football-data.org's free tier doesn't include it.
const DEFAULT_LEAGUE_ALLOWLIST = new Set([
  3,   // UEFA Europa League
  88,  // Eredivisie — kept as a fallback ID only until leagues.json resolves
       // the regional set; harmless overlap with the majors pool if a
       // fixture appears in both (see MAJORS_ID_OFFSET note below).
  // Belgium, Denmark, Norway, Scotland, Austria, Switzerland, Turkey are
  // NOT hardcoded here — run the "Resolve League IDs" workflow
  // (scripts/resolve-leagues.mjs) to bring them in via leagues.json.
]);

function loadLeagueAllowlist() {
  try {
    const raw = readFileSync(LEAGUES_JSON_PATH, 'utf8');
    const leagues = JSON.parse(raw);
    if (Array.isArray(leagues) && leagues.length > 0) {
      console.log(`Loaded ${leagues.length} resolved league(s) from leagues.json.`);
      return new Set(leagues.map((l) => l.id));
    }
  } catch {
    // leagues.json doesn't exist yet (or is invalid) — fall back below.
  }
  console.log(
    'leagues.json not found — using the small built-in default league set. ' +
      'Run the "Resolve League IDs" workflow for full regional coverage.'
  );
  return DEFAULT_LEAGUE_ALLOWLIST;
}

const LEAGUE_ALLOWLIST = loadLeagueAllowlist();

// Caps how many /odds requests the LENGTHY pool makes per run (API-Football
// only — the majors pool's odds cost is governed separately by The Odds
// API's own quota, see MAJORS_MAX_ODDS_LOOKUPS_PER_RUN below). Kept modest
// because the free plan enforces both a 10-requests/minute throttle
// (handled in apiFootball.mjs) AND a daily request cap.
const MAX_ODDS_LOOKUPS_PER_RUN = 25;

// Caps how many The Odds API odds-lookups (one per competition, since
// getOddsForSport returns ALL of that competition's upcoming fixtures in
// one call) the majors pool makes per run. This is intentionally tiny:
// The Odds API's free tier is a MONTHLY credit budget (not a daily one),
// and each of the 12 competitions costs `markets × regions` credits per
// call (3 markets × 2 regions = 6 credits here) regardless of how many
// fixtures it returns — so 12 competitions × 2 runs/day × 6 credits =
// up to 144 credits/day, ~4,300/month, which is already over a typical
// free-tier monthly allowance. Cut this down (fewer competitions per run,
// alternating which ones refresh) if actual usage runs over budget —
// tune with the real quota headers The Odds API returns (see
// getOddsForSport's x-requests-remaining warning in theOddsApi.mjs).
const MAJORS_MAX_COMPETITIONS_PER_RUN = 6;

// Numeric offset applied to football-data.org's native match IDs before
// they're written to the shared `fixtures.id` bigint column. football-data.org
// and API-Football both hand out small positive integers, so writing native
// IDs from both into the same column risks a real (if rare) collision
// between two completely unrelated matches. Offsetting by 10 billion — far
// above any realistic native ID from either provider — avoids that without
// requiring a composite-primary-key migration. See supabase/migrations/
// 004_multi_source_fixtures.sql for the accompanying `source` column, which
// is what scripts/grade-tickets.mjs actually uses to know which provider to
// re-query; the offset is purely collision-avoidance, not the routing
// mechanism.
export const MAJORS_ID_OFFSET = 10_000_000_000;

// Named priority leagues break ties when ASSEMBLING lengthy-tier tickets
// from the priced pool — see the final sort at the end of
// fetchPricedFixtures. Scoped to the LENGTHY pool only now; the majors pool
// has no equivalent tie-break since all 12 of its competitions are already
// "priority" by construction.
const PRIORITY_LEAGUE_NAMES = new Set([
  'UEFA Europa League',
  'Scottish Premiership',
  'Austrian Bundesliga',
  'Swiss Super League',
  'Turkish Super Lig',
  'Jupiler Pro League',  // Belgium
  'Superligaen',         // Denmark
  'Eliteserien',         // Norway
]);

const PER_LEAGUE_LOOKUPS_PER_ROUND = 3;
const WEEKLY_LOOKAHEAD_DAYS = 1;

const BIG_CLUBS = new Set([
  'Manchester City', 'Manchester United', 'Liverpool', 'Arsenal', 'Chelsea', 'Tottenham',
  'Real Madrid', 'Barcelona', 'Atletico Madrid',
  'Bayern Munich', 'Borussia Dortmund',
  'Juventus', 'Inter', 'AC Milan', 'Napoli',
  'Paris Saint Germain', 'PSG',
  'Ajax', 'Benfica', 'Porto',
]);

function isBigClash(homeTeam, awayTeam) {
  return BIG_CLUBS.has(homeTeam) && BIG_CLUBS.has(awayTeam);
}

const TIER_CONFIG = [
  { tier: 'mega', label: 'Mega Day Ticket', matchCount: 4, oddsRange: '1.5-3', alwaysFree: true, pool: 'majors' },
  { tier: 'bronze', label: 'Bronze', matchCount: 3, oddsRange: '2-3', alwaysFree: false, pool: 'majors' },
  { tier: 'silver', label: 'Silver', matchCount: 5, oddsRange: '3-5', alwaysFree: false, pool: 'majors' },
  { tier: 'gold', label: 'Gold', matchCount: 7, oddsRange: '5-10', alwaysFree: false, pool: 'majors' },
  { tier: 'platinum', label: 'Platinum', matchCount: 9, oddsRange: '25-300', alwaysFree: false, pool: 'lengthy_daily' },
  { tier: 'diamond', label: 'Diamond', matchCount: 14, oddsRange: '300+', alwaysFree: false, pool: 'lengthy_daily' },
  { tier: 'weekly_lite', label: 'Weekly Lite', matchCount: 19, oddsRange: 'Mixed', alwaysFree: false, pool: 'lengthy_weekly' },
  { tier: 'weekly_titan', label: 'Weekly Titan', matchCount: 29, oddsRange: 'Mixed', alwaysFree: false, pool: 'lengthy_weekly' },
  { tier: 'saints_lock', label: "Saint's Lock", matchCount: 1, oddsRange: '1.5-2', alwaysFree: false, pool: 'majors' },
];

const TIER_ODDS_TARGET = {
  mega: [1.5, 3],
  bronze: [2, 3],
  silver: [3, 5],
  gold: [5, 10],
  platinum: [25, 300],
  diamond: [300, Infinity],
  saints_lock: [1.5, 2],
};

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

// --- Staggered release: figure out which slot (if any) this run should fill ---

const MAX_TICKETS_PER_CATEGORY = 2;
const MIN_HOURS_BETWEEN_SLOTS = 6;

async function fetchTodaysSlipState(supabase, today) {
  const { data, error } = await supabase
    .from('tickets')
    .select('tier, release_slot, available_at')
    .eq('ticket_date', today);
  if (error) throw error;

  const byTier = new Map();
  (data ?? []).forEach((row) => {
    const existing = byTier.get(row.tier) ?? { count: 0, lastAvailableAt: null };
    existing.count += 1;
    if (!existing.lastAvailableAt || row.available_at > existing.lastAvailableAt) {
      existing.lastAvailableAt = row.available_at;
    }
    byTier.set(row.tier, existing);
  });
  return byTier;
}

function nextSlotFor(maxSlipsToday, slipState) {
  const state = slipState ?? { count: 0, lastAvailableAt: null };
  if (state.count >= maxSlipsToday) return null;
  if (state.count === 0) return 0;
  const hoursSinceLast = (Date.now() - new Date(state.lastAvailableAt).getTime()) / 3_600_000;
  if (hoursSinceLast < MIN_HOURS_BETWEEN_SLOTS) return null;
  return state.count;
}

// --- Shared exclusions -------------------------------------------------------

const EXCLUDED_TEAMS = new Set([
  // 'Example FC',
]);

function isExcluded(homeTeam, awayTeam) {
  return EXCLUDED_TEAMS.has(homeTeam) || EXCLUDED_TEAMS.has(awayTeam);
}

const MIN_CONFIDENCE = 68;
const RESULT_BASED_MARKETS = new Set([
  'Home Win', 'Away Win', 'Double Chance 1X', 'Double Chance X2', 'Double Chance 12',
]);
const WIN_MARKET_MIN_ODDS = 1.3;

/**
 * SELECTION STRATEGY (odds -> market pick) — SHARED by both pools. Takes an
 * API-Football-shaped odds response (real for the lengthy pool, adapted via
 * theOddsApi.mjs's toApiFootballOddsShape for the majors pool) and picks the
 * safest viable outcome, substituting an Over Goals market when the safest
 * pick is a too-short result-based market. See scripts/lib/markets.mjs for
 * the shared catalog this all depends on.
 */
function pickMarketFromOdds(oddsResponse) {
  const bookmaker = oddsResponse?.[0]?.bookmakers?.[0];
  if (!bookmaker) return null;

  const viable = collectViableOutcomes(bookmaker.bets);
  if (viable.length === 0) return null;

  const sorted = [...viable].sort((a, b) => a.odds - b.odds);
  let chosen = sorted[0];

  const isResultMarket = RESULT_BASED_MARKETS.has(chosen.market);
  if (isResultMarket && chosen.odds < WIN_MARKET_MIN_ODDS) {
    const goalsAlt = sorted.find((o) => o.market === 'Over 1.5 Goals' || o.market === 'Over 2.5 Goals');
    if (goalsAlt) {
      chosen = goalsAlt;
    } else {
      const nonResult = sorted.find((o) => !RESULT_BASED_MARKETS.has(o.market));
      if (nonResult) chosen = nonResult;
    }
  }

  const confidence = impliedConfidence(chosen.odds);
  if (confidence < MIN_CONFIDENCE) return null;

  return { market: chosen.market, odds: chosen.odds, confidence };
}

function impliedConfidence(odds) {
  const raw = Math.round((1 / odds) * 100);
  return Math.min(95, Math.max(55, raw));
}

// --- LENGTHY POOL: API-Football fixtures + odds (Platinum/Diamond/Weekly*) --

async function fetchPricedFixtures(dates, maxOddsLookups) {
  const seen = new Map();
  let oddsLookupsUsed = 0;
  const leagueBreakdown = new Map();

  for (const d of dates) {
    const fixtures = await getFixturesForDate(d);
    // eslint-disable-next-line no-console
    console.log(`API-Football returned ${fixtures.length} raw fixture(s) for ${d} (before league-allowlist filtering, currently ${LEAGUE_ALLOWLIST.size} league(s) in the allowlist).`);
    const eligible = fixtures.filter(
      (f) =>
        LEAGUE_ALLOWLIST.has(f.league?.id) &&
        !isBigClash(f.teams?.home?.name, f.teams?.away?.name) &&
        !isExcluded(f.teams?.home?.name, f.teams?.away?.name)
    );

    if (eligible.length === 0) continue;

    const byLeague = new Map();
    eligible.forEach((f) => {
      const name = f.league?.name ?? 'Unknown League';
      if (!byLeague.has(name)) byLeague.set(name, []);
      byLeague.get(name).push(f);
    });

    const leagueOrder = [
      ...PRIORITY_LEAGUE_NAMES,
      ...Array.from(byLeague.keys()).filter((name) => !PRIORITY_LEAGUE_NAMES.has(name)),
    ].filter((name) => byLeague.has(name));

    let anyQueueHasFixtures = true;
    while (anyQueueHasFixtures && oddsLookupsUsed < maxOddsLookups) {
      anyQueueHasFixtures = false;

      for (const leagueName of leagueOrder) {
        if (oddsLookupsUsed >= maxOddsLookups) break;

        const queue = byLeague.get(leagueName);
        if (!queue || queue.length === 0) continue;

        let takenThisRound = 0;
        while (
          takenThisRound < PER_LEAGUE_LOOKUPS_PER_ROUND &&
          queue.length > 0 &&
          oddsLookupsUsed < maxOddsLookups
        ) {
          const f = queue.shift();
          takenThisRound++;
          if (queue.length > 0) anyQueueHasFixtures = true;

          const fixtureId = f.fixture.id;
          if (seen.has(fixtureId)) continue;

          oddsLookupsUsed++;
          let oddsResponse;
          try {
            oddsResponse = await getOddsForFixture(fixtureId);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`Odds lookup failed for fixture ${fixtureId}:`, err.message);
            continue;
          }

          const picked = pickMarketFromOdds(oddsResponse);
          if (!picked) continue;

          seen.set(fixtureId, {
            fixtureId,
            source: 'api_football',
            ticketDate: dateStr(new Date()),
            league: f.league?.name ?? 'Unknown League',
            homeTeam: f.teams?.home?.name ?? 'Home',
            awayTeam: f.teams?.away?.name ?? 'Away',
            kickoff: f.fixture?.date,
            market: picked.market,
            odds: picked.odds,
            confidence: picked.confidence,
          });
          leagueBreakdown.set(leagueName, (leagueBreakdown.get(leagueName) ?? 0) + 1);
        }
      }
    }
  }

  if (leagueBreakdown.size > 0) {
    // eslint-disable-next-line no-console
    console.log(
      'Priced fixtures by league this run (lengthy pool): ' +
        Array.from(leagueBreakdown.entries())
          .map(([name, count]) => `${name}: ${count}`)
          .join(', ')
    );
  }

  return Array.from(seen.values()).sort((a, b) => {
    const aPriority = PRIORITY_LEAGUE_NAMES.has(a.league) ? 1 : 0;
    const bPriority = PRIORITY_LEAGUE_NAMES.has(b.league) ? 1 : 0;
    if (aPriority !== bPriority) return bPriority - aPriority;
    return b.confidence - a.confidence;
  });
}

// --- MAJORS POOL: football-data.org fixtures + The Odds API odds -----------
// (Mega/Bronze/Silver/Gold/Saint's Lock)

/**
 * Fetches football-data.org fixtures for today, The Odds API odds for the
 * same competitions, joins them by team+kickoff (fixtureMatcher.mjs), and
 * prices each matched fixture using the SAME pickMarketFromOdds used by the
 * lengthy pool. Competitions with no odds returned, or whose fixtures don't
 * match anything from The Odds API, simply contribute nothing to the pool —
 * never a fabricated price.
 */
async function fetchPricedFixturesFromMajors(todayStr) {
  const priced = [];
  const unmatchedTotal = [];
  let competitionsQueried = 0;

  let fdoMatches;
  try {
    fdoMatches = await getFdoMatchesForDateRange(todayStr, todayStr);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('football-data.org fixture fetch failed — majors pool will be empty this run:', err.message);
    return [];
  }

  // eslint-disable-next-line no-console
  console.log(`football-data.org returned ${fdoMatches.length} raw match(es) for ${todayStr} across all 12 competitions.`);

  const fdoByCompetition = new Map(); // fdoCode -> matches[]
  fdoMatches.forEach((m) => {
    const code = m.competition?.code;
    if (!code || !FDO_COMPETITION_CODES.includes(code)) return;
    if (isBigClash(m.homeTeam?.name, m.awayTeam?.name)) return;
    if (isExcluded(m.homeTeam?.name, m.awayTeam?.name)) return;
    if (!fdoByCompetition.has(code)) fdoByCompetition.set(code, []);
    fdoByCompetition.get(code).push(m);
  });

  for (const [fdoCode, matches] of fdoByCompetition.entries()) {
    if (competitionsQueried >= MAJORS_MAX_COMPETITIONS_PER_RUN) {
      // eslint-disable-next-line no-console
      console.log(`Majors pool: hit MAJORS_MAX_COMPETITIONS_PER_RUN, skipping remaining competitions this run.`);
      break;
    }

    const sportKeyInfo = SPORT_KEY_FALLBACK[fdoCode];
    if (!sportKeyInfo) continue; // shouldn't happen — every FDO_COMPETITION_CODES entry has a fallback

    competitionsQueried++;
    let oddsEvents;
    try {
      oddsEvents = await getOddsForSport(sportKeyInfo.key);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`The Odds API fetch failed for ${fdoCode} (${sportKeyInfo.key}):`, err.message);
      continue;
    }

    const { matched, unmatchedFdoMatches } = matchFixtures(matches, oddsEvents);
    unmatchedTotal.push(...unmatchedFdoMatches);

    matched.forEach(({ fdoMatch, oddsEvent }) => {
      const oddsShape = toApiFootballOddsShape(oddsEvent);
      const picked = pickMarketFromOdds(oddsShape);
      if (!picked) return;

      priced.push({
        fixtureId: MAJORS_ID_OFFSET + fdoMatch.id,
        source: 'football_data_org',
        ticketDate: todayStr,
        league: fdoMatch.competition?.name ?? sportKeyInfo.titleMatch,
        homeTeam: fdoMatch.homeTeam?.name ?? 'Home',
        awayTeam: fdoMatch.awayTeam?.name ?? 'Away',
        kickoff: fdoMatch.utcDate,
        market: picked.market,
        odds: picked.odds,
        confidence: picked.confidence,
      });
    });
  }

  if (unmatchedTotal.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `Majors pool: ${unmatchedTotal.length} football-data.org fixture(s) had no matching The Odds API ` +
        'event within tolerance — excluded from the pool, not priced with a guess.'
    );
  }

  // eslint-disable-next-line no-console
  console.log(`Majors pool: priced ${priced.length} fixture(s) across ${competitionsQueried} competition(s).`);

  return priced.sort((a, b) => b.confidence - a.confidence);
}

// --- Assemble tickets from a priced-fixture pool ----------------------------

const SMALL_TICKET_TIERS = new Set(['mega', 'bronze', 'silver']);
const SMALL_TICKET_MAX_ODDS = 1.77;

function poolForTier(pool, tier) {
  if (!SMALL_TICKET_TIERS.has(tier)) return pool;
  return pool.filter((p) => p.odds <= SMALL_TICKET_MAX_ODDS);
}

const MAX_FIXTURE_APPEARANCES_PER_DAY = 3;

function computeTotalOdds(picks) {
  return Math.round(picks.reduce((acc, p) => acc * p.odds, 1) * 100) / 100;
}

function pickFixturesForSlip(pool, maxMatchCount, usageCount, targetRange) {
  const eligible = pool.filter((f) => (usageCount.get(f.fixtureId) ?? 0) < MAX_FIXTURE_APPEARANCES_PER_DAY);
  if (eligible.length === 0) return [];

  const ranked = [...eligible].sort((a, b) => {
    const usedA = usageCount.get(a.fixtureId) ?? 0;
    const usedB = usageCount.get(b.fixtureId) ?? 0;
    if (usedA !== usedB) return usedA - usedB;
    return a.odds - b.odds;
  });

  if (!targetRange) {
    if (ranked.length < maxMatchCount) return [];
    return ranked.slice(0, maxMatchCount);
  }

  const [minTotal, maxTotal] = targetRange;

  let picks = [];
  let unused = [...ranked];

  for (const fixture of ranked) {
    if (picks.length >= maxMatchCount) break;
    picks.push(fixture);
    unused = unused.filter((f) => f !== fixture);

    const total = computeTotalOdds(picks);
    if (total >= minTotal && total <= maxTotal) {
      return picks;
    }
    if (total > maxTotal) {
      picks.pop();
      unused.unshift(fixture);
      break;
    }
  }

  const MAX_SWAP_ATTEMPTS = 8;
  for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS; attempt++) {
    const total = computeTotalOdds(picks);
    if (total >= minTotal && total <= maxTotal) break;

    if (total < minTotal) {
      if (picks.length < maxMatchCount && unused.length > 0) {
        const next = [...unused].sort((a, b) => a.odds - b.odds)[0];
        picks.push(next);
        unused = unused.filter((f) => f !== next);
        continue;
      }
      const lowestIdx = picks.reduce((li, p, i) => (p.odds < picks[li].odds ? i : li), 0);
      const candidate = unused.find((f) => f.odds > picks[lowestIdx].odds);
      if (!candidate) break;
      picks[lowestIdx] = candidate;
      unused = unused.filter((f) => f !== candidate);
    } else {
      const highestIdx = picks.reduce((hi, p, i) => (p.odds > picks[hi].odds ? i : hi), 0);
      const candidate = [...unused].sort((a, b) => a.odds - b.odds).find((f) => f.odds < picks[highestIdx].odds);
      if (!candidate) break;
      picks[highestIdx] = candidate;
      unused = unused.filter((f) => f !== candidate);
    }
  }

  const finalTotal = computeTotalOdds(picks);
  const TOLERANCE = 0.3;
  const withinTolerance = finalTotal >= minTotal * (1 - TOLERANCE) && finalTotal <= maxTotal * (1 + TOLERANCE);
  if (!withinTolerance || picks.length === 0) return [];

  return picks;
}

const SAINTS_LOCK_MIN_CONFIDENCE = 85;

function buildSaintsLockTickets(majorsPool, usageCount, today, slot) {
  const config = TIER_CONFIG.find((c) => c.tier === 'saints_lock');
  const [minOdds, maxOdds] = TIER_ODDS_TARGET.saints_lock;

  const inOddsRange = (p) => {
    const used = usageCount.get(p.fixtureId) ?? 0;
    return used < MAX_FIXTURE_APPEARANCES_PER_DAY && p.odds >= minOdds && p.odds <= maxOdds;
  };

  let qualifying = majorsPool
    .filter((p) => inOddsRange(p) && p.confidence >= SAINTS_LOCK_MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence);

  let usedFallback = false;
  if (qualifying.length === 0 && slot === 0) {
    const fallback = majorsPool.filter(inOddsRange).sort((a, b) => b.confidence - a.confidence);
    if (fallback.length > 0) {
      qualifying = [fallback[0]];
      usedFallback = true;
      // eslint-disable-next-line no-console
      console.warn(
        `Saint's Lock: no fixture cleared ${SAINTS_LOCK_MIN_CONFIDENCE}% today — ` +
          `using best available (${fallback[0].confidence}%) to meet the minimum-1-per-day guarantee.`
      );
    }
  }

  if (qualifying.length === 0) return { tickets: [], ticketMatches: [], fixturesUsed: [] };

  const pick = qualifying[0];
  usageCount.set(pick.fixtureId, (usageCount.get(pick.fixtureId) ?? 0) + 1);

  const ticketId = `${today}-saints_lock-${slot}`;
  const nowIso = new Date().toISOString();

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
      available_at: nowIso,
    },
  ];
  const ticketMatches = [{ ticket_id: ticketId, fixture_id: pick.fixtureId, sort_order: 0 }];

  return { tickets, ticketMatches, fixturesUsed: [pick], usedFallback };
}

function buildTickets(majorsPool, lengthyDailyPool, lengthyWeeklyPool, slipState) {
  const now = new Date();
  const today = dateStr(now);
  const nowIso = now.toISOString();
  const tickets = [];
  const ticketMatches = [];
  const fixturesUsed = new Map();
  // Deliberately ONE shared usage-count map across every tier/pool for the
  // day — a majors-pool fixture and a lengthy-pool fixture never collide
  // (different fixtureId ranges, see MAJORS_ID_OFFSET), so sharing the map
  // is harmless and keeps the "no fixture over-appears" logic in one place.
  const usageCount = new Map();

  const saintsLockSlot = nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get('saints_lock'));
  if (saintsLockSlot !== null) {
    const saintsLock = buildSaintsLockTickets(majorsPool, usageCount, today, saintsLockSlot);
    tickets.push(...saintsLock.tickets);
    ticketMatches.push(...saintsLock.ticketMatches);
    saintsLock.fixturesUsed.forEach((f) => fixturesUsed.set(f.fixtureId, f));
  } else {
    console.log("Saint's Lock: already at today's cap, or too soon since the last slip — skipping this run.");
  }

  const poolForConfig = (config) => {
    if (config.pool === 'majors') return majorsPool;
    if (config.pool === 'lengthy_weekly') return lengthyWeeklyPool;
    return lengthyDailyPool;
  };

  TIER_CONFIG.forEach((config) => {
    if (config.tier === 'saints_lock') return;

    const slot = nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get(config.tier));
    if (slot === null) {
      console.log(`${config.label}: already at today's cap, or too soon since the last slip — skipping this run.`);
      return;
    }

    const basePool = poolForConfig(config);
    const pool = poolForTier(basePool, config.tier);
    const targetRange = TIER_ODDS_TARGET[config.tier] ?? null;

    const picks = pickFixturesForSlip(pool, config.matchCount, usageCount, targetRange);
    if (picks.length === 0) {
      console.log(`${config.label}: couldn't assemble a valid combination this run — skipping this slip.`);
      return;
    }

    picks.forEach((p) => {
      fixturesUsed.set(p.fixtureId, p);
      usageCount.set(p.fixtureId, (usageCount.get(p.fixtureId) ?? 0) + 1);
    });

    const totalOdds = Math.round(picks.reduce((acc, p) => acc * p.odds, 1) * 100) / 100;
    const ticketId = `${today}-${config.tier}-${slot}`;
    const slipLabel = null;

    tickets.push({
      id: ticketId,
      ticket_date: today,
      tier: config.tier,
      slip_label: slipLabel,
      match_count: picks.length,
      odds_range: config.oddsRange,
      total_odds: totalOdds,
      is_free: config.alwaysFree,
      release_slot: slot,
      available_at: nowIso,
    });

    picks.forEach((p, idx) => {
      ticketMatches.push({ ticket_id: ticketId, fixture_id: p.fixtureId, sort_order: idx });
    });
  });

  return { tickets, ticketMatches, fixturesUsed: Array.from(fixturesUsed.values()) };
}

// --- Main ---------------------------------------------------------------------

async function main() {
  const today = new Date();
  const todayStr = dateStr(today);
  const dailyDates = [todayStr];
  const weeklyDates = [todayStr];
  for (let i = 1; i <= WEEKLY_LOOKAHEAD_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    weeklyDates.push(dateStr(d));
  }

  const supabase = getSupabaseAdmin();

  console.log('Checking today\'s existing slips (staggered-release state)...');
  const slipState = await fetchTodaysSlipState(supabase, todayStr);

  const anySlotAvailable = [...TIER_CONFIG.map((c) => c.tier)].some(
    (tier) => nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get(tier)) !== null
  );
  if (!anySlotAvailable) {
    console.log('Every category is already at today\'s cap, or within the min-gap window — nothing to do this run.');
    return;
  }

  // Each pool is fetched independently and defensively — a failure in one
  // provider must not prevent the other pool's tiers from generating.
  console.log('Fetching majors pool (football-data.org + The Odds API)...');
  let majorsPool = [];
  try {
    majorsPool = await fetchPricedFixturesFromMajors(todayStr);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Majors pool fetch failed entirely — Mega/Bronze/Silver/Gold/Saint\'s Lock skipped this run:', err.message);
  }

  console.log('Fetching lengthy daily pool (API-Football)...');
  let lengthyDailyPool = [];
  try {
    lengthyDailyPool = await fetchPricedFixtures(dailyDates, MAX_ODDS_LOOKUPS_PER_RUN);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Lengthy daily pool fetch failed — Platinum/Diamond skipped this run:', err.message);
  }
  console.log(`Priced ${lengthyDailyPool.length} fixtures for today (lengthy daily).`);

  console.log('Fetching lengthy weekly pool (API-Football, for Weekly Lite / Weekly Titan)...');
  let lengthyWeeklyPool = [];
  try {
    lengthyWeeklyPool = await fetchPricedFixtures(weeklyDates, MAX_ODDS_LOOKUPS_PER_RUN);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Lengthy weekly pool fetch failed — Weekly Lite/Titan skipped this run:', err.message);
  }
  console.log(`Priced ${lengthyWeeklyPool.length} fixtures for the week ahead (lengthy weekly).`);

  const { tickets, ticketMatches, fixturesUsed } = buildTickets(majorsPool, lengthyDailyPool, lengthyWeeklyPool, slipState);

  if (tickets.length === 0) {
    console.warn('No tickets could be assembled this run — not enough priced fixtures in either pool, or every eligible category was skipped. Nothing written.');
    return;
  }

  const fixtureRows = fixturesUsed.map((f) => ({
    id: f.fixtureId,
    source: f.source,
    ticket_date: f.ticketDate,
    league: f.league,
    home_team: f.homeTeam,
    away_team: f.awayTeam,
    kickoff: f.kickoff,
    market: f.market,
    odds: f.odds,
    confidence: f.confidence,
  }));

  const { error: fixturesErr } = await supabase.from('fixtures').upsert(fixtureRows, { onConflict: 'id' });
  if (fixturesErr) throw fixturesErr;

  const { error: ticketsErr } = await supabase.from('tickets').upsert(tickets, { onConflict: 'id' });
  if (ticketsErr) throw ticketsErr;

  const { error: linksErr } = await supabase
    .from('ticket_matches')
    .upsert(ticketMatches, { onConflict: 'ticket_id,fixture_id' });
  if (linksErr) throw linksErr;

  console.log(
    `Wrote ${tickets.length} new ticket(s), ${fixtureRows.length} fixture(s) ` +
      `(${fixtureRows.filter((f) => f.source === 'football_data_org').length} majors, ` +
      `${fixtureRows.filter((f) => f.source === 'api_football').length} lengthy). ` +
      'Previous slips today are untouched and remain visible.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
