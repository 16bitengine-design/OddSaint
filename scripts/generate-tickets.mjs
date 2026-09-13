// ---------------------------------------------------------------------------
// Odd Saint — daily ticket generation
// Pulls real fixtures + bookmaker odds from API-Football, turns them into
// tickets for every tier, and writes them to Supabase. Runs TWICE a day via
// .github/workflows/generate-tickets.yml (06:00 and 14:00 UTC) so each
// tier's daily tickets release in two staggered batches rather than all at
// once — see fetchTodaysSlipState/nextSlotFor below for how a given run
// decides whether it's producing today's 1st or 2nd slip for a tier, or
// skipping that tier entirely because it already has both.
//
// API-FOOTBALL FREE PLAN BUDGET (confirmed): 100 requests/day total, 10/min,
// resetting at 00:00 UTC with no rollover. EVERY endpoint call counts
// against the same 100 — fixtures, odds, leagues, all of it.
//
// TWO LAYERS OF PROTECTION against ever exceeding that:
//   1. PRIMARY — scripts/lib/apiFootball.mjs tracks the real, server-
//      reported remaining count (from the `x-ratelimit-requests-remaining`
//      header on every response) and refuses to make another request once
//      it's nearly exhausted, throwing ApiFootballBudgetExhaustedError.
//      This reacts to the ACTUAL account state — including anything else
//      that hit the same key today — not just this script's own guess.
//   2. BACKSTOP — MAX_NEW_ODDS_LOOKUPS_PER_RUN below is a static ceiling
//      kept low enough that even if the live check somehow failed to fire,
//      the worst-case daily total still stays under 100 (see the budget
//      arithmetic on that constant).
// Every place this file calls into API-Football is wrapped to catch
// ApiFootballBudgetExhaustedError and degrade gracefully — use whatever
// was already fetched/cached, skip the rest of the run, log clearly why —
// rather than crashing or silently pushing past the daily limit.
//
// HONEST SCOPE NOTE (read this before treating the output as a finished
// prediction engine): the "AI Confidence Index" here is a simple, transparent
// heuristic derived from bookmaker consensus odds (implied probability),
// not a trained model. That's a legitimate, defensible basis for a
// confidence figure — real odds reflect real market consensus — but it's
// intentionally simple. Tune the SELECTION STRATEGY section below as your
// picks strategy matures.
// ---------------------------------------------------------------------------
import {
  getFixturesForDate,
  getOddsForFixture,
  getDailyBudgetStatus,
  ApiFootballBudgetExhaustedError,
} from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { collectViableOutcomes } from './lib/markets.mjs';
import { isWomensCompetition } from './lib/womensLeagueFilter.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEAGUES_JSON_PATH = join(__dirname, 'lib', 'leagues.json');

// --- Config -----------------------------------------------------------------

// Small built-in default — used until scripts/resolve-leagues.mjs has been
// run at least once (via the manually-triggered "Resolve League IDs"
// workflow) to generate the full, verified league list at
// scripts/lib/leagues.json. One /fixtures?date= call already returns every
// league for that date regardless of allowlist size — filtering here
// doesn't cost extra API requests either way.
//
// NOTE: resolve-leagues.mjs spends roughly 1 request per country it checks
// (~60 requests for the full list) — it's manual-trigger-only specifically
// so it never collides with the 100/day budget this file depends on. It
// also has its own copy of the same budget circuit breaker, so it will
// stop and save partial progress rather than run the account dry if
// there's not enough headroom left on the day you run it.
const DEFAULT_LEAGUE_ALLOWLIST = new Set([
  39,  // Premier League
  140, // La Liga
  135, // Serie A
  78,  // Bundesliga
  61,  // Ligue 1
  2,   // UEFA Champions League
  3,   // UEFA Europa League
  88,  // Eredivisie
  // Belgium, Denmark, Norway, Scotland, Austria, Switzerland, Turkey are
  // intentionally NOT hardcoded here — their real numeric league IDs
  // aren't something to guess. Run the "Resolve League IDs" workflow
  // (scripts/resolve-leagues.mjs already targets all seven regional
  // leagues) to bring them in via leagues.json with verified IDs instead.
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

// ---------------------------------------------------------------------------
// BUDGET BACKSTOP: this is a static ceiling, kept deliberately conservative
// as a second line of defense behind the live check described in the file
// header. Worst-case daily arithmetic, assuming (hypothetically) the live
// check never fired at all:
//
//   Fixture-list calls   : 2 dates (today + tomorrow) x 2 runs/day  =  4
//   Odds lookups         : MAX_NEW_ODDS_LOOKUPS_PER_RUN x 2 runs/day = 70  (at 35/run)
//   Grading              : <=1 request x 8 runs/day (every 3h)      =  8
//                                                                    ----
//                                                              Total = 82  (18-request margin)
//
// The 70 above is itself a worst case that assumes zero reuse between the
// day's two generate-tickets runs — in practice the second run reuses
// whatever the first run already priced today (see
// fetchAlreadyPricedFixturesToday / buildPricedPool below), so real spend
// should land well under 82. Raising this constant shrinks that margin —
// redo the arithmetic above before changing it, and remember
// resolve-leagues.mjs (manual, ~60 requests) draws from the same 100/day
// pool on whatever day it's triggered.
const MAX_NEW_ODDS_LOOKUPS_PER_RUN = 35;

// Named priority leagues break ties when ASSEMBLING tickets from the priced
// pool (see the final sort at the end of buildPricedPool, and
// poolForTier/pickFixturesForSlip below) — and get first look in each
// round of the odds-lookup rotation (see PER_LEAGUE_LOOKUPS_PER_ROUND).
// They are NOT an exclusive gate on which leagues get priced: on a day
// where these leagues are thin or mostly unpredictable (no clear
// favorites, lots of picks failing MIN_CONFIDENCE), the rotation below
// still gives every other allowlisted league with fixtures today a fair
// shot at the odds-lookup budget instead of it being exhausted here first.
// Belgium, Denmark, and Norway are prioritized here per product direction,
// replacing Portugal's former default-set slot. League *names* are used
// (rather than numeric IDs) since these are confirmed values from
// API-Football's published league list, unlike guessed ID numbers.
const PRIORITY_LEAGUE_NAMES = new Set([
  'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1',
  'UEFA Champions League', 'UEFA Europa League', 'Eredivisie',
  'Scottish Premiership',    // UK regional tier-one
  'Austrian Bundesliga',      // Central Europe
  'Swiss Super League',       // Western Europe
  'Turkish Super Lig',        // Eastern Europe / Asia-Minor bridge
  'Jupiler Pro League',       // Belgium (regional priority)
  'Superligaen',              // Denmark (regional priority)
  'Eliteserien',              // Norway (regional priority)
]);

// How many odds lookups a single league can consume in one rotation pass
// before yielding to the next league in line. This is the actual fix for
// "glued to particular leagues": without a per-round cap, a priority
// league with a full fixture list would consume the entire odds-lookup
// budget before any other league — including other priority leagues
// further down the list — ever got a single odds lookup, even on a day
// where that first league's matches were all unpredictable coin-flips
// that would fail MIN_CONFIDENCE anyway. Kept small (not 1) so a league
// with genuinely strong, easy fixtures can still contribute more than a
// token pick per round.
const PER_LEAGUE_LOOKUPS_PER_ROUND = 3;

// How many extra days ahead to pull fixtures for the two "Weekly" tiers.
// API-Football's FREE plan only allows querying a narrow window around
// today (typically yesterday through tomorrow) — requesting further out
// returns a "Free plans do not have access to this date" error. Set to 1
// to stay within that window; if you upgrade your API plan later, this can
// go back up to pull a genuine week's worth of fixtures (and the budget
// arithmetic above will need revisiting).
const WEEKLY_LOOKAHEAD_DAYS = 1;

// A curated set of marquee clubs across the covered leagues. Fixtures where
// BOTH sides are in this set (e.g. Real Madrid vs Barcelona, a Manchester
// or Milan derby) are skipped entirely — these are inherently the hardest
// matches to call with real confidence, so the platform avoids building
// picks around them rather than pretending otherwise.
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

// Platinum and Diamond were removed from the product lineup — they were
// also the two hardest tiers to reliably assemble (25-300x and 300+x
// cumulative odds need either huge leg counts or extreme long-shot legs),
// so dropping them also frees up odds-lookup budget and fixture-pool
// headroom for the remaining tiers. Existing historical Platinum/Diamond
// rows in Supabase are untouched (no CHECK constraint on tickets.tier) —
// only new generation stops. MUST stay in sync with TIER_CONFIG in
// src/lib/dataFetcher.ts.
const TIER_CONFIG = [
  { tier: 'mega', label: 'Mega Day Ticket', matchCount: 4, oddsRange: '1.5-3', alwaysFree: true },
  { tier: 'bronze', label: 'Bronze', matchCount: 3, oddsRange: '2-3', alwaysFree: false },
  { tier: 'silver', label: 'Silver', matchCount: 5, oddsRange: '3-5', alwaysFree: false },
  { tier: 'gold', label: 'Gold', matchCount: 7, oddsRange: '5-10', alwaysFree: false },
  // Weekly Lite/Titan match counts are each ONE FEWER than the "standard"
  // tier size (20/30) — a deliberate reduction to raise real-world win
  // probability by cutting one compounding leg of bookmaker margin per
  // ticket. Must stay in sync with TIER_CONFIG in src/lib/dataFetcher.ts.
  //
  // HONEST LIMIT: Weekly Titan needs 29 successfully-priced legs. Even
  // with the same-day pricing cache below, a day with genuinely few
  // eligible fixtures (quiet midweek slate, thin leagues) — or a day the
  // budget circuit breaker trips early — may still not reach 29. This is
  // an inherent limit of a free, rate-limited data source, not a bug. If
  // Titan skips more often than you'd like, the levers are: lower
  // matchCount here and in dataFetcher.ts, since that's the only lever
  // that doesn't risk the 100/day ceiling.
  { tier: 'weekly_lite', label: 'Weekly Lite', matchCount: 19, oddsRange: 'Mixed', alwaysFree: false },
  { tier: 'weekly_titan', label: 'Weekly Titan', matchCount: 29, oddsRange: 'Mixed', alwaysFree: false },
  // Single-match, ultra-high-confidence category. Only ever one match —
  // the single most confident pick available that day, and only ever
  // included if it clears SAINTS_LOCK_MIN_CONFIDENCE (see below), well
  // above the standard MIN_CONFIDENCE floor. Sign-up required, no free
  // trial ever applies — see the separate checkout flow in plans.ts.
  { tier: 'saints_lock', label: "Saint's Lock", matchCount: 1, oddsRange: '1.5-2', alwaysFree: false },
];

// Numeric cumulative-odds targets matching each tier's oddsRange label
// above. These are ACTUALLY ENFORCED during slip assembly (see
// pickFixturesForSlip) — previously oddsRange was just a display string
// with nothing checking whether a ticket's real combined odds landed
// inside it. Weekly Lite/Titan are intentionally left unset ("Mixed" by
// design, no fixed target).
const TIER_ODDS_TARGET = {
  mega: [1.5, 3],
  bronze: [2, 3],
  silver: [3, 5],
  gold: [5, 10],
  saints_lock: [1.5, 2],
};

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

// --- Staggered release: figure out which slot (if any) this run should fill ---

// Every category caps at 2 tickets/day (down from 3) — see product
// direction: max 2/category/day, released at staggered times rather than
// all at once, so users never see multiple slips for the same tier appear
// simultaneously (avoids an "illusion of choice" where every option shows
// up at the same moment with no real signal about which is fresher).
const MAX_TICKETS_PER_CATEGORY = 2;

// Minimum real-world gap enforced between a tier's slot-0 and slot-1
// ticket on the same day. Exists so a manual re-run, a delayed cron, or
// GitHub Actions scheduling jitter can never produce both of a tier's
// daily slips back-to-back — the two staggered releases stay meaningfully
// spread out regardless of exactly when this workflow happens to fire.
// Matches the two 06:00/14:00 UTC cron triggers (8h apart) with headroom.
const MIN_HOURS_BETWEEN_SLOTS = 6;

/**
 * Reads how many slips already exist today per tier, and when the most
 * recent one for each tier was released — this is what makes slot
 * placement idempotent and safe to call from either of the day's two
 * scheduled runs (or a manual re-run) without ever overproducing.
 */
async function fetchTodaysSlipState(supabase, today) {
  const { data, error } = await supabase
    .from('tickets')
    .select('tier, release_slot, available_at')
    .eq('ticket_date', today);
  if (error) throw error;

  const byTier = new Map(); // tier -> { count, lastAvailableAt }
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

/**
 * Decides whether THIS run should produce the tier's next slip, and if so
 * which slot index (0 or 1) it fills. Returns null when the tier already
 * has its daily cap, or when the minimum gap since its last slip hasn't
 * elapsed yet — in either case the tier is simply skipped this run, and
 * whatever it already has stays on display untouched (nothing here ever
 * deletes or overwrites a previous slip).
 */
function nextSlotFor(maxSlipsToday, slipState) {
  const state = slipState ?? { count: 0, lastAvailableAt: null };
  if (state.count >= maxSlipsToday) return null; // already at today's cap for this tier
  if (state.count === 0) return 0; // first slip of the day — always fine
  const hoursSinceLast = (Date.now() - new Date(state.lastAvailableAt).getTime()) / 3_600_000;
  if (hoursSinceLast < MIN_HOURS_BETWEEN_SLOTS) return null; // too soon — this run isn't the 2nd slot's time yet
  return state.count; // e.g. 1 for the 2nd slip of the day
}

/**
 * Reads how many times each fixture ID already appears across TODAY's
 * existing ticket_matches (i.e. across BOTH of today's runs combined, not
 * just this one) — seeded into usageCount at the start of buildTickets so
 * MAX_FIXTURE_APPEARANCES_PER_DAY actually holds for the whole day.
 *
 * BUG THIS FIXES: usageCount used to start as an empty Map() every run,
 * so the appearance cap only held WITHIN a single script execution. A
 * fixture already used up to the cap in the 06:00 UTC run could then be
 * picked again in the 14:00 UTC run, silently exceeding the intended
 * per-day limit — which is exactly the "same match keeps showing up"
 * symptom. Seeding from Supabase here closes that gap.
 */
async function fetchTodaysFixtureUsage(supabase, today) {
  const { data, error } = await supabase
    .from('ticket_matches')
    .select('fixture_id, tickets!inner(ticket_date)')
    .eq('tickets.ticket_date', today);
  if (error) throw error;

  const usage = new Map(); // fixtureId -> count of today's tickets it already appears on
  (data ?? []).forEach((row) => {
    usage.set(row.fixture_id, (usage.get(row.fixture_id) ?? 0) + 1);
  });
  return usage;
}

/**
 * Reads every fixture already priced today (from EITHER of today's runs so
 * far) straight from Supabase — no API-Football cost at all, this is our
 * own database. This is what lets the 14:00 UTC run reuse the 06:00 UTC
 * run's pricing work for free instead of re-spending the odds-lookup
 * budget on the same matches twice in one day.
 */
async function fetchAlreadyPricedFixturesToday(supabase, today) {
  const { data, error } = await supabase
    .from('fixtures')
    .select('id, league, home_team, away_team, kickoff, market, odds, confidence')
    .eq('ticket_date', today);
  if (error) throw error;

  const cache = new Map(); // fixtureId -> priced fixture shape (see buildPricedPool)
  (data ?? []).forEach((row) => {
    cache.set(row.id, {
      fixtureId: row.id,
      ticketDate: today,
      league: row.league,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      kickoff: row.kickoff,
      market: row.market,
      odds: row.odds,
      confidence: row.confidence,
    });
  });
  return cache;
}

// --- Fetch + price fixtures ---------------------------------------------------

// Empty by default — add exact team names here (matching API-Football's
// naming) if there are specific clubs or competitions you want the
// pipeline to avoid picking entirely, for any reason (integrity concerns,
// unreliable data, or otherwise). This is a business decision left to you
// rather than a list Claude fills in, since flagging real clubs by name
// for something as serious as match-fixing needs to be based on your own
// verified, current judgment — not baked into the code as an assumption.
const EXCLUDED_TEAMS = new Set([
  // 'Example FC',
]);

function isExcluded(homeTeam, awayTeam) {
  return EXCLUDED_TEAMS.has(homeTeam) || EXCLUDED_TEAMS.has(awayTeam);
}

function isEligibleFixture(f) {
  return (
    LEAGUE_ALLOWLIST.has(f.league?.id) &&
    !isWomensCompetition(f.league?.name) &&
    !isBigClash(f.teams?.home?.name, f.teams?.away?.name) &&
    !isExcluded(f.teams?.home?.name, f.teams?.away?.name)
  );
}

/**
 * Prices fixtures across every date in `fixturesByDate` (a Map of
 * dateStr -> raw fixtures array, already fetched by the caller so each
 * date's /fixtures endpoint is only ever called once per run — see
 * main()). Spends up to `maxNewLookups` FRESH /odds requests total;
 * anything already present in `alreadyPricedCache` (today's earlier run)
 * is reused at zero API cost instead of being re-fetched.
 *
 * BUDGET-SAFE BY DESIGN: if getOddsForFixture ever throws
 * ApiFootballBudgetExhaustedError (the live circuit breaker in
 * apiFootball.mjs tripped), this stops spending immediately and returns
 * whatever's already been priced (cache hits + fresh lookups obtained
 * before running out) — partial data beats no data, and a mid-run
 * exhaustion should never crash the whole job.
 *
 * SINGLE COMBINED POOL: the daily and weekly pools are built from ONE
 * shared pass here (split by kickoff date afterward in main()) rather than
 * two separate calls with separate budgets — a fixture kicking off today
 * is eligible for both pools, so pricing it once and reusing the result
 * avoids paying for it twice in the same run.
 *
 * FLEXIBLE LEAGUE ROTATION (fix for "glued to particular leagues"):
 * fixtures still needing a fresh price are grouped by league, then priced
 * in a round-robin rotation — named priority leagues go first each round,
 * but only PER_LEAGUE_LOOKUPS_PER_ROUND lookups at a time, before the
 * rotation moves on to the next league (priority or not) that still has
 * fixtures queued.
 */
async function buildPricedPool(fixturesByDate, maxNewLookups, alreadyPricedCache) {
  const seen = new Map(); // fixtureId -> priced fixture (cache hits + fresh lookups this run)
  let newLookupsUsed = 0;
  let cacheHits = 0;
  let budgetExhausted = false;
  const leagueBreakdown = new Map(); // league name -> count freshly priced this run (for the run summary log)

  for (const [, fixtures] of fixturesByDate) {
    if (budgetExhausted || newLookupsUsed >= maxNewLookups) break;

    const eligible = fixtures.filter(isEligibleFixture);
    if (eligible.length === 0) continue;

    // Serve anything already priced earlier today straight from the cache,
    // at zero API cost, before doing any rotation/lookup work for it.
    const stillNeedsPricing = [];
    eligible.forEach((f) => {
      const fixtureId = f.fixture.id;
      if (seen.has(fixtureId)) return; // already resolved earlier in this same pass
      const cached = alreadyPricedCache.get(fixtureId);
      if (cached) {
        seen.set(fixtureId, cached);
        cacheHits++;
      } else {
        stillNeedsPricing.push(f);
      }
    });

    if (stillNeedsPricing.length === 0) continue;

    // Group by league so the rotation below gives each league with
    // fixtures today a fair, repeated turn instead of exhausting the
    // budget on whichever league sorts first.
    const byLeague = new Map(); // league name -> fixture queue (FIFO)
    stillNeedsPricing.forEach((f) => {
      const name = f.league?.name ?? 'Unknown League';
      if (!byLeague.has(name)) byLeague.set(name, []);
      byLeague.get(name).push(f);
    });

    // Rotation order: named priority leagues first (so they still get
    // first look each round), then every other league that actually has
    // fixtures today, in the order first encountered in the API response.
    const leagueOrder = [
      ...PRIORITY_LEAGUE_NAMES,
      ...Array.from(byLeague.keys()).filter((name) => !PRIORITY_LEAGUE_NAMES.has(name)),
    ].filter((name) => byLeague.has(name));

    let anyQueueHasFixtures = true;
    while (anyQueueHasFixtures && !budgetExhausted && newLookupsUsed < maxNewLookups) {
      anyQueueHasFixtures = false;

      for (const leagueName of leagueOrder) {
        if (budgetExhausted || newLookupsUsed >= maxNewLookups) break;

        const queue = byLeague.get(leagueName);
        if (!queue || queue.length === 0) continue;

        let takenThisRound = 0;
        while (
          takenThisRound < PER_LEAGUE_LOOKUPS_PER_ROUND &&
          queue.length > 0 &&
          !budgetExhausted &&
          newLookupsUsed < maxNewLookups
        ) {
          const f = queue.shift();
          takenThisRound++;
          if (queue.length > 0) anyQueueHasFixtures = true;

          const fixtureId = f.fixture.id;
          if (seen.has(fixtureId)) continue; // already resolved (cache hit or earlier in this pass)

          newLookupsUsed++;
          let oddsResponse;
          try {
            oddsResponse = await getOddsForFixture(fixtureId);
          } catch (err) {
            if (err instanceof ApiFootballBudgetExhaustedError) {
              // eslint-disable-next-line no-console
              console.warn(
                `${err.message} — stopping fixture pricing here for this run; ` +
                  `using the ${seen.size} fixture(s) already priced (cache + this run).`
              );
              budgetExhausted = true;
              break;
            }
            // eslint-disable-next-line no-console
            console.warn(`Odds lookup failed for fixture ${fixtureId}:`, err.message);
            continue;
          }

          const picked = pickMarketFromOdds(oddsResponse);
          if (!picked) continue; // no usable market for this fixture — skip it

          seen.set(fixtureId, {
            fixtureId,
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
      'Freshly priced fixtures by league this run: ' +
        Array.from(leagueBreakdown.entries())
          .map(([name, count]) => `${name}: ${count}`)
          .join(', ')
    );
  }
  console.log(
    `Fixture pricing: ${cacheHits} reused from earlier today (free), ${newLookupsUsed} fresh /odds request(s) spent this run` +
      (budgetExhausted ? ' (stopped early — daily budget circuit breaker tripped).' : '.')
  );

  // Priority leagues still get first billing once fixtures are being
  // assembled into tickets (equal-confidence tie-break) — but every
  // allowlisted league with fixtures today was actually attempted above,
  // so a non-priority league's picks are never excluded from this pool.
  return Array.from(seen.values()).sort((a, b) => {
    const aPriority = PRIORITY_LEAGUE_NAMES.has(a.league) ? 1 : 0;
    const bPriority = PRIORITY_LEAGUE_NAMES.has(b.league) ? 1 : 0;
    if (aPriority !== bPriority) return bPriority - aPriority;
    return b.confidence - a.confidence;
  });
}

// A fixture is skipped entirely if nothing viable clears this confidence
// floor — better to generate one fewer match, or even skip a slip, than to
// force in a pick the market itself doesn't consider a clear favorite.
const MIN_CONFIDENCE = 68;

// Result-based markets to steer away from when priced this short — an
// extremely tight price on any of these can still be upset (a draw, a cup
// shock, a keeper's bad day). Double Chance in particular is the market
// that actually reaches odds this low (as tight as 1.1) — Home/Away Win
// never goes below 1.3 per the market catalog's own bounds.
const RESULT_BASED_MARKETS = new Set([
  'Home Win', 'Away Win', 'Double Chance 1X', 'Double Chance X2', 'Double Chance 12',
]);
const WIN_MARKET_MIN_ODDS = 1.3;

/**
 * SELECTION STRATEGY (odds → market pick):
 * Checks every market in the shared catalog (Match Winner, Goals
 * Over/Under, Both Teams Score, Double Chance) against this fixture's
 * bookmaker odds, and takes the SAFEST viable outcome — i.e. whichever
 * has the lowest odds / highest implied confidence — rather than picking
 * randomly among them. If that safest outcome is a result-based market
 * (see RESULT_BASED_MARKETS) priced below WIN_MARKET_MIN_ODDS, an Over
 * Goals market is substituted instead when one's available. Skips the
 * fixture entirely if nothing clears MIN_CONFIDENCE, rather than forcing a
 * low-quality pick just to fill a ticket.
 */
function pickMarketFromOdds(oddsResponse) {
  const bookmaker = oddsResponse?.[0]?.bookmakers?.[0];
  if (!bookmaker) return null;

  const viable = collectViableOutcomes(bookmaker.bets);
  if (viable.length === 0) return null;

  const sorted = [...viable].sort((a, b) => a.odds - b.odds);
  let chosen = sorted[0]; // lowest odds = safest, by default

  const isResultMarket = RESULT_BASED_MARKETS.has(chosen.market);
  if (isResultMarket && chosen.odds < WIN_MARKET_MIN_ODDS) {
    const goalsAlt = sorted.find((o) => o.market === 'Over 1.5 Goals' || o.market === 'Over 2.5 Goals');
    if (goalsAlt) {
      chosen = goalsAlt;
    } else {
      // No Goals-market alternative for this fixture — fall back to the
      // next-safest non-result-based option if one exists (e.g. BTTS),
      // rather than the too-short result-based price.
      const nonResult = sorted.find((o) => !RESULT_BASED_MARKETS.has(o.market));
      if (nonResult) chosen = nonResult;
      // If truly nothing else is viable, the short price is accepted
      // rather than dropping the fixture entirely.
    }
  }

  const confidence = impliedConfidence(chosen.odds);
  if (confidence < MIN_CONFIDENCE) return null; // too uncertain even at its safest — skip this fixture

  return { market: chosen.market, odds: chosen.odds, confidence };
}

function impliedConfidence(odds) {
  const raw = Math.round((1 / odds) * 100);
  return Math.min(95, Math.max(55, raw)); // clipped to a sane display range
}

// --- Assemble tickets from the priced-fixture pool ---------------------------

// Tiers with fewer than 7 matches favor safer, more heavily-favored picks:
// their fixture pool is restricted to legs priced at 1.77 or below rather
// than the full odds range used for Gold and up.
const SMALL_TICKET_TIERS = new Set(['mega', 'bronze', 'silver']); // matchCount < 7
const SMALL_TICKET_MAX_ODDS = 1.77;

/** Narrows the pool to safer, lower-odds picks for tiers under 7 matches. */
function poolForTier(pool, tier) {
  if (!SMALL_TICKET_TIERS.has(tier)) return pool;
  return pool.filter((p) => p.odds <= SMALL_TICKET_MAX_ODDS);
}

// No single match can appear in more than this many of the day's tickets,
// across every tier combined AND across both of today's runs (see
// fetchTodaysFixtureUsage, which seeds usageCount at the start of each
// run) — lowered from 3 to 2 per product direction. Without this cap, a
// small fixture pool can end up reused in nearly every ticket — meaning
// one unexpected result takes down a large chunk of the day's slate at
// once instead of just one or two tickets.
const MAX_FIXTURE_APPEARANCES_PER_DAY = 2;

function computeTotalOdds(picks) {
  return Math.round(picks.reduce((acc, p) => acc * p.odds, 1) * 100) / 100;
}

/**
 * Picks fixtures for one slip using the FEWEST legs needed to reach the
 * tier's minimum target odds — starting from the safest available fixtures
 * and adding one at a time, stopping the moment the cumulative total lands
 * in range. `maxMatchCount` is a CEILING now, not a fixed requirement:
 * fewer legs at the same target odds means less compounded bookmaker
 * margin (every leg carries the house edge, and it multiplies) and fewer
 * independent things that can go wrong — so this deliberately favors using
 * as few legs as will actually get the job done, only adding more when
 * the safest legs alone can't reach the target.
 */
function pickFixturesForSlip(pool, maxMatchCount, usageCount, targetRange) {
  const eligible = pool.filter((f) => (usageCount.get(f.fixtureId) ?? 0) < MAX_FIXTURE_APPEARANCES_PER_DAY);
  if (eligible.length === 0) return [];

  const ranked = [...eligible].sort((a, b) => {
    const usedA = usageCount.get(a.fixtureId) ?? 0;
    const usedB = usageCount.get(b.fixtureId) ?? 0;
    if (usedA !== usedB) return usedA - usedB; // least-used first
    return a.odds - b.odds; // then safest first
  });

  if (!targetRange) {
    // No target range to hit (Weekly Lite/Titan, "Mixed") — just take the
    // safest available up to the max, as before.
    if (ranked.length < maxMatchCount) return [];
    return ranked.slice(0, maxMatchCount);
  }

  const [minTotal, maxTotal] = targetRange;

  // Greedily add the safest legs one at a time, stopping as soon as the
  // cumulative total reaches the target range.
  let picks = [];
  let unused = [...ranked];

  for (const fixture of ranked) {
    if (picks.length >= maxMatchCount) break;
    picks.push(fixture);
    unused = unused.filter((f) => f !== fixture);

    const total = computeTotalOdds(picks);
    if (total >= minTotal && total <= maxTotal) {
      return picks; // hit the target with this many legs — stop here
    }
    if (total > maxTotal) {
      // Overshot on the safest-first path (can happen with a wide odds
      // spread) — back this addition out and fall through to the swap
      // logic below instead of just continuing to pile on legs.
      picks.pop();
      unused.unshift(fixture);
      break;
    }
  }

  // Safest legs alone (within the max leg cap) didn't reach minTotal —
  // add more legs if there's still room, then fall back to swapping
  // weaker-for-stronger legs to close the gap.
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
      if (!candidate) break; // nothing left that would raise the total further
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
  const TOLERANCE = 0.3; // 30% slack either side of the target band
  const withinTolerance = finalTotal >= minTotal * (1 - TOLERANCE) && finalTotal <= maxTotal * (1 + TOLERANCE);
  if (!withinTolerance || picks.length === 0) return []; // pool doesn't have enough spread to hit this tier's range today

  return picks;
}

// Saint's Lock demands a far higher confidence bar than any other tier —
// "next to impossible to get wrong" framing means this should almost never
// miss. Well above the standard MIN_CONFIDENCE floor (68) used everywhere
// else. If fewer than 2 fixtures clear this bar on a given day, fewer than
// 2 Saint's Lock tickets get produced — quality over quantity applies here
// most strictly of all.
const SAINTS_LOCK_MIN_CONFIDENCE = 85;

/**
 * Dedicated selection for Saint's Lock — unlike every other tier (which
 * uses pickFixturesForSlip's least-used/safest-first logic), this picks
 * strictly the highest-confidence qualifying fixtures in the whole day's
 * pool, filtered to the 1.5–2.0 odds band and the much higher confidence
 * floor above. Respects the same staggered-release slot logic as every
 * other tier (see nextSlotFor) — at most one new Saint's Lock ticket is
 * produced per run, honoring the min-1/max-2-per-day guarantee across the
 * day's two scheduled runs rather than both at once.
 */
function buildSaintsLockTickets(dailyPool, usageCount, today, slot) {
  const config = TIER_CONFIG.find((c) => c.tier === 'saints_lock');
  const [minOdds, maxOdds] = TIER_ODDS_TARGET.saints_lock;

  const inOddsRange = (p) => {
    const used = usageCount.get(p.fixtureId) ?? 0;
    return used < MAX_FIXTURE_APPEARANCES_PER_DAY && p.odds >= minOdds && p.odds <= maxOdds;
  };

  let qualifying = dailyPool
    .filter((p) => inOddsRange(p) && p.confidence >= SAINTS_LOCK_MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence);

  // Minimum 1/day guarantee: if nothing clears the strict 85% bar, relax
  // to the single best-available fixture in the odds range rather than
  // shipping zero. Applied on EITHER slot now (previously slot 0 only) —
  // a slot-0 miss used to mean the whole day could go without a Saint's
  // Lock ticket if slot 1 also failed to clear 85%, since slot 1 never
  // got the relaxed fallback. This does mean a below-85% "best available"
  // pick can now appear on the second release too, not just the first —
  // a deliberate loosening in favor of reliably generating a ticket, at
  // some cost to the "next to impossible to get wrong" premium framing.
  let usedFallback = false;
  if (qualifying.length === 0) {
    const fallback = dailyPool.filter(inOddsRange).sort((a, b) => b.confidence - a.confidence);
    if (fallback.length > 0) {
      qualifying = [fallback[0]];
      usedFallback = true;
      // eslint-disable-next-line no-console
      console.warn(
        `Saint's Lock: no fixture cleared ${SAINTS_LOCK_MIN_CONFIDENCE}% today (slot ${slot}) — ` +
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
      slip_label: null, // Saint's Lock is marketed as one pick at a time, not "1 of 2" — see frontend countdown banner
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

function buildTickets(dailyPool, weeklyPool, slipState, seededUsage) {
  const now = new Date();
  const today = dateStr(now);
  const nowIso = now.toISOString();
  const tickets = [];
  const ticketMatches = [];
  const fixturesUsed = new Map();
  // Seeded from today's existing ticket_matches (see
  // fetchTodaysFixtureUsage) so MAX_FIXTURE_APPEARANCES_PER_DAY holds
  // across BOTH of today's runs, not just within this single execution.
  const usageCount = new Map(seededUsage);

  // Saint's Lock uses its own dedicated selection (see buildSaintsLockTickets)
  // rather than the generic per-tier loop below — it's held to a much
  // stricter confidence bar than every other category.
  const saintsLockSlot = nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get('saints_lock'));
  if (saintsLockSlot !== null) {
    const saintsLock = buildSaintsLockTickets(dailyPool, usageCount, today, saintsLockSlot);
    tickets.push(...saintsLock.tickets);
    ticketMatches.push(...saintsLock.ticketMatches);
    saintsLock.fixturesUsed.forEach((f) => fixturesUsed.set(f.fixtureId, f));
  } else {
    console.log("Saint's Lock: already at today's cap, or too soon since the last slip — skipping this run.");
  }

  TIER_CONFIG.forEach((config) => {
    if (config.tier === 'saints_lock') return; // handled above

    const slot = nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get(config.tier));
    if (slot === null) {
      console.log(`${config.label}: already at today's cap, or too soon since the last slip — skipping this run.`);
      return;
    }

    const isWeekly = config.tier === 'weekly_lite' || config.tier === 'weekly_titan';
    const basePool = isWeekly ? weeklyPool : dailyPool;
    const pool = poolForTier(basePool, config.tier);
    const targetRange = TIER_ODDS_TARGET[config.tier] ?? null;

    const picks = pickFixturesForSlip(pool, config.matchCount, usageCount, targetRange);
    if (picks.length === 0) {
      console.log(`${config.label}: couldn't assemble a valid combination this run — skipping this slip.`);
      return; // couldn't assemble a valid combination today — skip this slip rather than force it
    }

    picks.forEach((p) => {
      fixturesUsed.set(p.fixtureId, p);
      usageCount.set(p.fixtureId, (usageCount.get(p.fixtureId) ?? 0) + 1);
    });

    const totalOdds = Math.round(picks.reduce((acc, p) => acc * p.odds, 1) * 100) / 100;
    const ticketId = `${today}-${config.tier}-${slot}`;
    // Both of a tier's daily slips are real, equally-curated tickets
    // released at different times — not simultaneous alternatives — so
    // "Slip 1 of 2" phrasing (which implies picking between options
    // available right now) is deliberately dropped in favor of a plain
    // release-time label shown by the frontend instead.
    const slipLabel = null;

    tickets.push({
      id: ticketId,
      ticket_date: today,
      tier: config.tier,
      slip_label: slipLabel,
      match_count: picks.length, // actual legs used — may be fewer than config.matchCount's ceiling
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
  const neededDates = [todayStr];
  for (let i = 1; i <= WEEKLY_LOOKAHEAD_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    neededDates.push(dateStr(d));
  }

  const supabase = getSupabaseAdmin();

  console.log("Checking today's existing slips (staggered-release state)...");
  const slipState = await fetchTodaysSlipState(supabase, todayStr);

  const anySlotAvailable = [...TIER_CONFIG.map((c) => c.tier)].some(
    (tier) => nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get(tier)) !== null
  );
  if (!anySlotAvailable) {
    console.log("Every category is already at today's cap, or within the min-gap window — nothing to do this run.");
    return;
  }

  console.log("Checking today's existing fixture usage (cross-run appearance cap)...");
  const seededUsage = await fetchTodaysFixtureUsage(supabase, todayStr);

  console.log("Checking which fixtures are already priced from earlier today (avoids re-spending API-Football's 100/day quota)...");
  const alreadyPricedCache = await fetchAlreadyPricedFixturesToday(supabase, todayStr);

  // Each needed date's /fixtures list is fetched ONCE here and shared
  // between the daily and weekly pools below. If the account's daily
  // budget is ALREADY exhausted before this run even starts (e.g. a
  // manual re-run or resolve-leagues.mjs used it up earlier today), this
  // throws ApiFootballBudgetExhaustedError — caught below, logged clearly,
  // and this run exits cleanly with nothing written rather than crashing.
  let fixturesByDate;
  try {
    console.log(`Fetching fixture list(s) for: ${neededDates.join(', ')}...`);
    fixturesByDate = new Map();
    for (const d of neededDates) {
      fixturesByDate.set(d, await getFixturesForDate(d));
    }
  } catch (err) {
    if (err instanceof ApiFootballBudgetExhaustedError) {
      console.warn(
        `${err.message} — skipping this entire run. Today's existing tickets (if any) remain visible; ` +
          'the next run (or tomorrow\'s 00:00 UTC reset) will pick back up normally.'
      );
      return;
    }
    throw err; // any other failure (network, credentials, malformed response, etc.) is a real problem
  }

  console.log('Pricing fixtures (reusing anything already priced today; spending fresh /odds requests only where needed)...');
  const combinedPool = await buildPricedPool(fixturesByDate, MAX_NEW_ODDS_LOOKUPS_PER_RUN, alreadyPricedCache);

  // Split the single combined pool by each fixture's actual kickoff date
  // rather than by which fetch it came from — dailyPool is "kicks off
  // today" (used by mega/bronze/silver/gold/saints_lock), weeklyPool is
  // the whole combined pool, today + tomorrow (used by weekly_lite/titan,
  // which need more raw fixture volume than a single day usually offers).
  const dailyPool = combinedPool.filter((p) => p.kickoff && p.kickoff.slice(0, 10) === todayStr);
  const weeklyPool = combinedPool;
  console.log(
    `Daily pool: ${dailyPool.length} fixture(s) kicking off today. Weekly pool: ${weeklyPool.length} fixture(s) across today + tomorrow.`
  );

  const { tickets, ticketMatches, fixturesUsed } = buildTickets(dailyPool, weeklyPool, slipState, seededUsage);

  const budgetStatus = getDailyBudgetStatus();
  if (budgetStatus.remaining !== null) {
    console.log(`API-Football daily budget: ${budgetStatus.remaining} of ${budgetStatus.limit} remaining as of this run's last request.`);
  }

  if (tickets.length === 0) {
    console.warn('No tickets could be assembled this run — not enough priced fixtures, or every eligible category was skipped. Nothing written.');
    return;
  }

  const fixtureRows = fixturesUsed.map((f) => ({
    id: f.fixtureId,
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

  console.log(`Wrote ${tickets.length} new ticket(s), ${fixtureRows.length} fixture(s). Previous slips today are untouched and remain visible.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
