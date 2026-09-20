// ---------------------------------------------------------------------------
// Odd Saint — daily ticket generation
// Pulls real fixtures + bookmaker odds from API-Football, turns them into
// tickets for every tier, and writes them to Supabase. Runs TWICE a day via
// .github/workflows/generate-tickets.yml (03:00 and 10:00 UTC — 06:00 and
// 13:00 East Africa Time) so each tier's daily tickets release in two
// staggered batches rather than all at once — see
// fetchTodaysSlipState/nextSlotFor below for how a given run decides
// whether it's producing today's 1st or 2nd slip for a tier, or skipping
// that tier entirely because it already has both.
//
// HONEST SCOPE NOTE (read this before treating the output as a finished
// prediction engine): the "AI Confidence Index" here is a simple, transparent
// heuristic derived from bookmaker consensus odds (implied probability),
// not a trained model. That's a legitimate, defensible basis for a
// confidence figure — real odds reflect real market consensus — but it's
// intentionally simple. Tune the SELECTION STRATEGY section below as your
// picks strategy matures.
//
// CHANGE LOG (this batch — see CLAUDE.md — OddSaint Self-Improvement.md
// and the project's own conversation history for full rationale):
//   1. pickMarketFromOdds() now selects the HIGHEST-odds outcome on a
//      fixture that still clears MIN_CONFIDENCE, not the lowest-odds
//      ("safest") one. Goal: hit each tier's cumulative odds target in as
//      FEW legs as possible, per pickFixturesForSlip's own "fewest legs"
//      design intent. The old RESULT_BASED_MARKETS/WIN_MARKET_MIN_ODDS
//      guard existed only to steer away from an overly tight Double
//      Chance price under the old "pick smallest odds" rule — it's
//      removed as dead code under the new rule (an overly tight price
//      simply won't be the highest-odds qualifying outcome anymore).
//   2. TIER_CONFIG leg counts and TIER_ODDS_TARGET reworked across
//      mega → weekender per the 7-category portfolio framework mapping
//      (see 16BITENGINE strategy doc). weekly_lite/weekly_titan/weekender
//      now have real odds targets instead of "Mixed"/no target.
//   3. New LEG_ODDS_BAND — a per-tier average-leg-odds band — replaces
//      the old single shared SMALL_TICKET_TIERS/SMALL_TICKET_MAX_ODDS
//      ceiling. poolForTier now filters by this band per tier.
//   4. MAX_FIXTURE_APPEARANCES_PER_DAY lowered from 3 to 1 — "zero
//      cross-contamination": a fixture used in one tier's ticket can no
//      longer appear in any other tier's ticket the same day.
//   5. Fixture eligibility now requires a resolvable league.country —
//      "a match must come from a known country" — instead of silently
//      defaulting unknown countries to the string 'Unknown' and still
//      including them.
// ---------------------------------------------------------------------------
import { getFixturesForDate, getOddsForFixture } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { collectViableOutcomes, FULL_WIN_MARKETS } from './lib/markets.mjs';
import { isAmateurOrYouthLeague } from './lib/leagueQuality.mjs';
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

// Caps how many /odds requests we make per pool (daily, weekly, weekender
// — so a full run uses at most ~3x this many, plus a couple of /fixtures
// calls). Raised from the old Free-plan-era value of 25 now that the
// account is on Pro (300 req/min, 7,500 req/day): worst case is 3 pools x
// 2 runs/day x this value = 6 x 200 = 1,200 odds lookups/day, leaving
// >6,000/day of headroom for grading (every 3h) and manual runs. Revisit
// if the Actions logs show the daily cap getting tight.
const MAX_ODDS_LOOKUPS_PER_RUN = 200;

// Named priority leagues break ties when ASSEMBLING tickets from the priced
// pool (see the final sort at the end of fetchPricedFixtures, and
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
// league with a full fixture list would consume the entire
// MAX_ODDS_LOOKUPS_PER_RUN budget before any other league — including
// other priority leagues further down the list — ever got a single odds
// lookup, even on a day where that first league's matches were all
// unpredictable coin-flips that would fail MIN_CONFIDENCE anyway. Kept
// small (not 1) so a league with genuinely strong, easy fixtures can still
// contribute more than a token pick per round.
const PER_LEAGUE_LOOKUPS_PER_ROUND = 3;

// How many extra days ahead to pull fixtures for the two "Weekly" tiers.
// API-Football's FREE plan only allows querying a narrow window around
// today (typically yesterday through tomorrow) — requesting further out
// returns a "Free plans do not have access to this date" error. Set to 1
// to stay within that window; if you upgrade your API plan later, this can
// go back up to pull a genuine week's worth of fixtures.
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

// ---------------------------------------------------------------------------
// TIER_CONFIG — leg-count ceilings per tier. Reworked this batch to map
// the 7-category portfolio framework onto Odd Saint's real tier names, in
// product order: Mega Day Ticket, Bronze, Silver, Gold, Weekly Lite,
// Weekly Titan, Weekender. matchCount is the CEILING pickFixturesForSlip
// aims to reach the target odds within, not a fixed requirement — see
// that function's own doc comment.
//
// Platinum and Diamond are left unchanged from their pre-existing values;
// they were not part of the 7-category mapping this batch worked from —
// flagged for a follow-up decision on whether to fold them in or retire
// them, not silently guessed here.
// ---------------------------------------------------------------------------
const TIER_CONFIG = [
  { tier: 'mega', label: 'Mega Day Ticket', matchCount: 3, oddsRange: '2-2.5', alwaysFree: true },
  { tier: 'bronze', label: 'Bronze', matchCount: 4, oddsRange: '4-6', alwaysFree: false },
  { tier: 'silver', label: 'Silver', matchCount: 8, oddsRange: '15-30', alwaysFree: false },
  { tier: 'gold', label: 'Gold', matchCount: 12, oddsRange: '100-300', alwaysFree: false },
  { tier: 'platinum', label: 'Platinum', matchCount: 9, oddsRange: '25-300', alwaysFree: false },
  { tier: 'diamond', label: 'Diamond', matchCount: 14, oddsRange: '300+', alwaysFree: false },
  // Weekly Lite/Titan/Weekender now have real leg ceilings and real odds
  // targets (see TIER_ODDS_TARGET below) instead of an unbounded "Mixed"
  // ticket that just took the safest available legs up to the old,
  // larger ceiling.
  { tier: 'weekly_lite', label: 'Weekly Lite', matchCount: 16, oddsRange: '300-800', alwaysFree: false },
  { tier: 'weekly_titan', label: 'Weekly Titan', matchCount: 19, oddsRange: '1000-3000', alwaysFree: false },
  { tier: 'weekender', label: 'Weekender', matchCount: 22, oddsRange: '10000+', alwaysFree: false },
  // Single-match, ultra-high-confidence category. Only ever one match —
  // the single most confident pick available that day, and only ever
  // included if it clears SAINTS_LOCK_MIN_CONFIDENCE (see below), well
  // above the standard MIN_CONFIDENCE floor. Sign-up required, no free
  // trial ever applies — see the separate checkout flow in plans.ts.
  { tier: 'saints_lock', label: "Saint's Lock", matchCount: 1, oddsRange: '1.5-2', alwaysFree: false },
];

// Numeric cumulative-odds targets matching each tier's oddsRange label
// above. ACTUALLY ENFORCED during slip assembly (see pickFixturesForSlip).
// Every generic tier now has a real target — weekly_lite/weekly_titan/
// weekender are no longer "Mixed"/untargeted.
const TIER_ODDS_TARGET = {
  mega: [2, 2.5],
  bronze: [4, 6],
  silver: [15, 30],
  gold: [100, 300],
  platinum: [25, 300],
  diamond: [300, Infinity],
  weekly_lite: [300, 800],
  weekly_titan: [1000, 3000],
  weekender: [10000, Infinity],
  saints_lock: [1.5, 2],
};

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Returns [saturdayStr, sundayStr] for the NEXT upcoming Saturday+Sunday
 * from `now` (today itself if today already is Sat/Sun) — same lookahead
 * pattern as WEEKLY_LOOKAHEAD_DAYS. Runs on ANY day of the week, relying
 * on the Pro plan's wider date-range window to fetch a few days ahead
 * (unlike the old Free-plan-only-weekend-runs restriction). The exact
 * Pro-plan date-range limit hasn't been directly re-verified — if a date
 * turns out to still be out of range, fetchPricedFixtures below catches
 * that per-date and skips it rather than crashing the whole script.
 */
function upcomingWeekendDates(now) {
  const dow = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const daysUntilSaturday = (6 - dow + 7) % 7;
  const sat = new Date(now);
  sat.setUTCDate(sat.getUTCDate() + daysUntilSaturday);
  const sun = new Date(sat);
  sun.setUTCDate(sun.getUTCDate() + 1);
  return [dateStr(sat), dateStr(sun)];
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
// Matches the two 03:00/10:00 UTC cron triggers (7h apart) with headroom.
const MIN_HOURS_BETWEEN_SLOTS = 6;

// Tickets become ACCESSIBLE this long after the moment they're generated
// — not the instant the row is written. Gives a clean, predictable "ready
// at" cutoff instead of a batch appearing mid-write, and matches
// RELEASE_SLOT_HOURS_UTC in src/lib/dataFetcher.ts (generation at
// 03:00/10:00 UTC + this delay = 04:00/11:00 UTC availability). Enforced
// on the read side by fetchRealTicketsForDate in dataFetcher.ts, which
// filters out any row whose available_at is still in the future — this
// file's only job is stamping the correct future timestamp when writing.
const AVAILABILITY_DELAY_MS = 60 * 60 * 1000; // 1 hour

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
  // available_at is stamped as GENERATION time + AVAILABILITY_DELAY_MS
  // (see buildTickets/buildSaintsLockTickets), so recover the actual
  // generation time before measuring the gap — otherwise every comparison
  // would be skewed by that same fixed delay, which at this schedule's 7h
  // gap would put the measured value right at the MIN_HOURS_BETWEEN_SLOTS
  // boundary instead of safely above it.
  const lastGeneratedAtMs = new Date(state.lastAvailableAt).getTime() - AVAILABILITY_DELAY_MS;
  const hoursSinceLast = (Date.now() - lastGeneratedAtMs) / 3_600_000;
  if (hoursSinceLast < MIN_HOURS_BETWEEN_SLOTS) return null; // too soon — this run isn't the 2nd slot's time yet
  return state.count; // e.g. 1 for the 2nd slip of the day
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

// Product rule: a fixture must be at least this many hours from kickoff,
// measured from the moment THIS run started (not wall-clock time when the
// fixture happens to be evaluated mid-loop), to be eligible for a ticket.
// Protects against picks generated too close to kickoff, where there's
// less time for team news, a lineup change, or a postponement to surface
// before someone acts on the pick.
const MIN_HOURS_TO_KICKOFF = 2;

function hasMinimumLeadTime(kickoffISO, now) {
  if (!kickoffISO) return false;
  const kickoffMs = new Date(kickoffISO).getTime();
  return kickoffMs - now.getTime() >= MIN_HOURS_TO_KICKOFF * 60 * 60 * 1000;
}

/**
 * Fetches and prices fixtures for the given dates, spending up to
 * `maxOddsLookups` /odds requests total. `now` anchors both the kickoff
 * lead-time filter above and is passed through unchanged for the whole
 * call — every fixture in one run is judged against the same moment,
 * rather than drifting as the run progresses.
 *
 * FLEXIBLE LEAGUE ROTATION (this is the fix for "glued to particular
 * leagues"): fixtures are grouped by league, then priced in a round-robin
 * rotation — named priority leagues go first each round, but only
 * PER_LEAGUE_LOOKUPS_PER_ROUND lookups at a time, before the rotation
 * moves on to the next league (priority or not) that still has fixtures
 * queued. The rotation repeats until either the budget runs out or every
 * league's queue is empty.
 *
 * The old behavior sorted ALL priority-league fixtures ahead of ALL other
 * fixtures, so a single busy priority league could consume the entire
 * day's odds-lookup budget before any other league was even attempted —
 * including on days where that league's matches were mostly unpredictable
 * coin-flips that would go on to fail MIN_CONFIDENCE anyway. The rotation
 * below means every allowlisted league with fixtures today gets looked at,
 * not just the named priority set — "priority" now only breaks ties once
 * fixtures are being assembled into tickets (see the final sort below).
 */
async function fetchPricedFixtures(dates, maxOddsLookups, now) {
  const seen = new Map(); // fixtureId -> priced fixture
  let oddsLookupsUsed = 0;
  const leagueBreakdown = new Map(); // league name -> count actually priced (for the run summary log)

  for (const d of dates) {
    let fixtures;
    try {
      fixtures = await getFixturesForDate(d);
    } catch (err) {
      // Safety net for date-range limits we haven't fully re-verified
      // since moving from Free to Pro — skip just this date instead of
      // failing the whole run (matters most for the Weekender pool, which
      // now reaches a few days ahead via upcomingWeekendDates()).
      console.warn(`Could not fetch fixtures for ${d}, skipping that date:`, err.message);
      continue;
    }
    const eligible = fixtures.filter(
      (f) =>
        LEAGUE_ALLOWLIST.has(f.league?.id) &&
        // "A match must come from a known country" — drop fixtures whose
        // league carries no resolvable country rather than silently
        // defaulting to 'Unknown' and still including them (that
        // fallback still happens further below purely for the DISPLAY
        // value on fixtures that pass this filter with a real country —
        // this check is the actual eligibility gate).
        !!f.league?.country &&
        // Defense-in-depth: excludes youth/reserve/third-division-or-lower
        // competitions by name pattern even if leagues.json (built by
        // resolve-leagues.mjs, which applies the same filter) is stale or
        // predates this filter — see scripts/lib/leagueQuality.mjs.
        !isAmateurOrYouthLeague(f.league?.name) &&
        !isBigClash(f.teams?.home?.name, f.teams?.away?.name) &&
        !isExcluded(f.teams?.home?.name, f.teams?.away?.name) &&
        hasMinimumLeadTime(f.fixture?.date, now)
    );

    if (eligible.length === 0) continue;

    // Group today's eligible fixtures by league so the rotation below can
    // give each league with fixtures today a fair, repeated turn instead
    // of exhausting the budget on whichever league sorts first.
    const byLeague = new Map(); // league name -> fixture queue (FIFO)
    eligible.forEach((f) => {
      const name = f.league?.name ?? 'Unknown League';
      if (!byLeague.has(name)) byLeague.set(name, []);
      byLeague.get(name).push(f);
    });

    // Rotation order: named priority leagues first (so they still get
    // first look each round), then every other league that actually has
    // fixtures today, in the order first encountered in the API response.
    // This is a per-round ordering, not an allowlist — a non-priority
    // league with fixtures today is never excluded from pricing, only
    // queued behind the priority set within a given round.
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
          if (seen.has(fixtureId)) continue; // already priced (e.g. weekly pool overlapping today's date)

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
          if (!picked) continue; // no usable market for this fixture — skip it

          seen.set(fixtureId, {
            fixtureId,
            ticketDate: dateStr(new Date()),
            league: f.league?.name ?? 'Unknown League',
            country: f.league?.country ?? 'Unknown',
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
      'Priced fixtures by league this run: ' +
        Array.from(leagueBreakdown.entries())
          .map(([name, count]) => `${name}: ${count}`)
          .join(', ')
    );
  }

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

/**
 * SELECTION STRATEGY (odds → market pick):
 *
 * Checks every market in the shared catalog (Match Winner, Goals
 * Over/Under, Both Teams Score, Double Chance) against this fixture's
 * bookmaker odds, and takes the HIGHEST-odds outcome that still clears
 * MIN_CONFIDENCE — not the lowest-odds/"safest" one.
 *
 * Rationale: the product goal is to hit each tier's cumulative odds
 * target using as FEW legs as possible (see pickFixturesForSlip's own
 * doc comment). A Double Chance price (1X/X2/12) covers two of three
 * possible results, so it's almost always priced lower than an outright
 * Home/Away Win on the same fixture — under a "lowest odds first" rule,
 * Double Chance gets picked on nearly every fixture, which then needs
 * MORE legs to reach any given cumulative target. Picking the highest
 * qualifying odds instead means outright Win markets (and other
 * higher-priced-but-still-confident outcomes) get chosen naturally,
 * without needing to special-case any one market type.
 *
 * The old RESULT_BASED_MARKETS/WIN_MARKET_MIN_ODDS guard (which used to
 * substitute away an overly tight Double Chance price for a Goals
 * market) is removed as dead code under this rule: an overly tight price
 * will essentially never be the HIGHEST qualifying outcome on a fixture,
 * so the situation that guard existed for no longer arises in practice.
 *
 * Skips the fixture entirely if nothing clears MIN_CONFIDENCE, rather
 * than forcing a low-quality pick just to fill a ticket.
 */
function pickMarketFromOdds(oddsResponse) {
  const bookmaker = oddsResponse?.[0]?.bookmakers?.[0];
  if (!bookmaker) return null;

  const viable = collectViableOutcomes(bookmaker.bets);
  if (viable.length === 0) return null;

  const qualifying = viable.filter((o) => impliedConfidence(o.odds) >= MIN_CONFIDENCE);
  if (qualifying.length === 0) return null; // nothing on this fixture clears the floor

  const chosen = [...qualifying].sort((a, b) => b.odds - a.odds)[0]; // highest odds that still qualifies

  return { market: chosen.market, odds: chosen.odds, confidence: impliedConfidence(chosen.odds) };
}

function impliedConfidence(odds) {
  const raw = Math.round((1 / odds) * 100);
  return Math.min(95, Math.max(55, raw)); // clipped to a sane display range
}

// --- Assemble tickets from the priced-fixture pool ---------------------------

// Per-tier average-leg-odds band — replaces the old single shared
// SMALL_TICKET_TIERS/SMALL_TICKET_MAX_ODDS ceiling (which only applied to
// mega/bronze/silver, capped at 1.77). Every generic tier now has its own
// explicit band, mapped from the 7-category portfolio framework. Tiers
// with no band defined here (platinum, diamond, saints_lock) are left
// unfiltered by poolForTier, same as tiers outside SMALL_TICKET_TIERS were
// before this change.
const LEG_ODDS_BAND = {
  mega: [1.25, 1.35],
  bronze: [1.40, 1.65],
  silver: [1.70, 2.00],
  gold: [1.80, 2.10],
  weekly_lite: [1.90, 2.20],
  weekly_titan: [1.80, 2.00],
  weekender: [1.80, 2.10],
};

/** Narrows the pool to the tier's own average-leg-odds band, where one is defined. */
function poolForTier(pool, tier) {
  const band = LEG_ODDS_BAND[tier];
  if (!band) return pool;
  return pool.filter((p) => p.odds >= band[0] && p.odds <= band[1]);
}

// No single match can appear in more than this many of the day's tickets,
// across every tier combined. "Zero cross-contamination": a fixture used
// in one tier's ticket must never appear in another tier's ticket the
// same day, so that if that one fixture fails, it ruins only the single
// ticket it's on — not multiple tickets across the portfolio at once.
// Lowered from 3 to 1 this batch; the previous value of 3 deliberately
// allowed reuse so a thin fixture pool wouldn't starve every tier — that
// tradeoff is now made the other way on purpose. Expect more skipped
// slips on days with a thin fixture pool as a direct consequence.
const MAX_FIXTURE_APPEARANCES_PER_DAY = 1;

function computeTotalOdds(picks) {
  return Math.round(picks.reduce((acc, p) => acc * p.odds, 1) * 100) / 100;
}

/**
 * "Always incorporate a full win where necessary": if `picks` doesn't
 * already contain an outright Home/Away Win leg, try swapping one in from
 * the pool. Tries every leg position (safest-to-disrupt first — i.e. the
 * current highest-odds leg) and keeps the first swap that lands the total
 * back within the same tolerance band pickFixturesForSlip itself allows.
 * If no full-win fixture is available in today's pool, or no swap keeps
 * the ticket within its odds range, returns `picks` unchanged — this is a
 * best-effort guarantee, not a mandate to force a bad combination.
 */
function ensureFullWinLeg(picks, pool, usageCount, targetRange) {
  if (picks.length === 0) return picks;
  if (picks.some((p) => FULL_WIN_MARKETS.has(p.market))) return picks; // already has one

  const alreadyIn = new Set(picks.map((p) => p.fixtureId));
  const candidates = pool
    .filter(
      (f) =>
        FULL_WIN_MARKETS.has(f.market) &&
        !alreadyIn.has(f.fixtureId) &&
        (usageCount.get(f.fixtureId) ?? 0) < MAX_FIXTURE_APPEARANCES_PER_DAY
    )
    .sort((a, b) => a.odds - b.odds); // safest full-win pick first

  if (candidates.length === 0) return picks; // nothing full-win available today

  const candidate = candidates[0];

  if (!targetRange) {
    // No odds band to protect — swap out the current highest-odds leg for
    // the full-win candidate.
    const highestIdx = picks.reduce((hi, p, i) => (p.odds > picks[hi].odds ? i : hi), 0);
    const next = [...picks];
    next[highestIdx] = candidate;
    return next;
  }

  const [minTotal, maxTotal] = targetRange;
  const TOLERANCE = 0.3; // same slack pickFixturesForSlip itself allows
  const order = [...picks.keys()].sort((a, b) => picks[b].odds - picks[a].odds); // highest-odds leg first
  for (const idx of order) {
    const next = [...picks];
    next[idx] = candidate;
    const total = computeTotalOdds(next);
    const within = total >= minTotal * (1 - TOLERANCE) && total <= maxTotal * (1 + TOLERANCE);
    if (within) return next;
  }

  return picks; // no swap kept the total within range — leave the ticket as assembled
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
    // No target range to hit — just take the safest available up to the
    // max, as before.
    if (ranked.length < maxMatchCount) return [];
    return ensureFullWinLeg(ranked.slice(0, maxMatchCount), pool, usageCount, null);
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

  return ensureFullWinLeg(picks, pool, usageCount, targetRange);
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
 *
 * NOTE: the "always incorporate a full win where necessary" guarantee
 * (see ensureFullWinLeg, used by the generic per-tier loop below)
 * deliberately does NOT apply here. Saint's Lock is a single-leg pick with
 * no "ticket completeness" to satisfy, and its whole design principle is
 * confidence-first, quality-over-quantity — swapping in a lower-confidence
 * outright-win fixture just to satisfy a market-type preference would
 * directly contradict that.
 */
function buildSaintsLockTickets(dailyPool, usageCount, today, slot, now) {
  const config = TIER_CONFIG.find((c) => c.tier === 'saints_lock');
  const [minOdds, maxOdds] = TIER_ODDS_TARGET.saints_lock;

  const inOddsRange = (p) => {
    const used = usageCount.get(p.fixtureId) ?? 0;
    return used < MAX_FIXTURE_APPEARANCES_PER_DAY && p.odds >= minOdds && p.odds <= maxOdds;
  };

  let qualifying = dailyPool
    .filter((p) => inOddsRange(p) && p.confidence >= SAINTS_LOCK_MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence);

  // Minimum 1/day guarantee: if nothing clears the strict 85% bar on the
  // FIRST slip of the day, relax to the single best-available fixture in
  // the odds range rather than shipping zero. Still quality-first — this
  // only ever applies to slot 0, since a second slot at reduced confidence
  // would defeat the "next to impossible" positioning.
  let usedFallback = false;
  if (qualifying.length === 0 && slot === 0) {
    const fallback = dailyPool.filter(inOddsRange).sort((a, b) => b.confidence - a.confidence);
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
  const availableAtIso = new Date(now.getTime() + AVAILABILITY_DELAY_MS).toISOString();

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
      available_at: availableAtIso,
    },
  ];
  const ticketMatches = [{ ticket_id: ticketId, fixture_id: pick.fixtureId, sort_order: 0 }];

  return { tickets, ticketMatches, fixturesUsed: [pick], usedFallback };
}

function buildTickets(dailyPool, weeklyPool, weekenderPool, slipState, now) {
  const today = dateStr(now);
  const availableAtIso = new Date(now.getTime() + AVAILABILITY_DELAY_MS).toISOString();
  const tickets = [];
  const ticketMatches = [];
  const fixturesUsed = new Map();
  const usageCount = new Map(); // shared across every tier/slip for the day

  // Saint's Lock uses its own dedicated selection (see buildSaintsLockTickets)
  // rather than the generic per-tier loop below — it's held to a much
  // stricter confidence bar than every other category.
  const saintsLockSlot = nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get('saints_lock'));
  if (saintsLockSlot !== null) {
    const saintsLock = buildSaintsLockTickets(dailyPool, usageCount, today, saintsLockSlot, now);
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
    const isWeekender = config.tier === 'weekender';
    const basePool = isWeekender ? weekenderPool : isWeekly ? weeklyPool : dailyPool;
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
      available_at: availableAtIso,
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

  console.log('Fetching daily fixture pool...');
  const dailyPool = await fetchPricedFixtures(dailyDates, MAX_ODDS_LOOKUPS_PER_RUN, today);
  console.log(`Priced ${dailyPool.length} fixtures for today.`);

  console.log('Fetching weekly fixture pool (for Weekly Lite / Weekly Titan)...');
  const weeklyPool = await fetchPricedFixtures(weeklyDates, MAX_ODDS_LOOKUPS_PER_RUN, today);
  console.log(`Priced ${weeklyPool.length} fixtures for the week ahead.`);

  console.log('Fetching Weekender pool (upcoming Sat+Sun)...');
  const weekendDates = upcomingWeekendDates(today);
  const weekenderPool = await fetchPricedFixtures(weekendDates, MAX_ODDS_LOOKUPS_PER_RUN, today);
  console.log(`Priced ${weekenderPool.length} fixtures for the weekend (${weekendDates.join(', ')}).`);

  const { tickets, ticketMatches, fixturesUsed } = buildTickets(dailyPool, weeklyPool, weekenderPool, slipState, today);

  if (tickets.length === 0) {
    console.warn('No tickets could be assembled this run — not enough priced fixtures, or every eligible category was skipped. Nothing written.');
    return;
  }

  const fixtureRows = fixturesUsed.map((f) => ({
    id: f.fixtureId,
    ticket_date: f.ticketDate,
    league: f.league,
    country: f.country,
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
