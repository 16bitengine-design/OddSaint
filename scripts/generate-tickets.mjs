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
// SAINT'S LOCK FIX (2026-09-29): Saint's Lock used to require
// confidence >= 85 AND odds 1.5-2.0, which can never both hold
// (confidence = round(100/odds) is only 50-67% at those odds), and its
// candidates were also filtered by MIN_CONFIDENCE 68 upstream, so its pool
// was always empty. It now has its own candidate pick per fixture
// (pickSaintsLockMarket) and always takes the best available one in EVERY
// release slot. Regular tiers are unaffected.
// ---------------------------------------------------------------------------
import { getFixturesForDate, getOddsForFixture } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { collectViableOutcomes, FULL_WIN_MARKETS } from './lib/markets.mjs';
import { isAmateurOrYouthLeague } from './lib/leagueQuality.mjs';
import { isSouthAmericanLeague } from './lib/regionFilter.mjs';
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
      // South American leagues are excluded from every ticket by product decision.
      return new Set(
        leagues
          .filter((l) => l.region !== 'South America' && !isSouthAmericanLeague(l.country, l.name))
          .map((l) => l.id)
      );
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

// Caps how many /odds requests a run makes for the daily pool (Pro plan:
// 300 req/min, 7,500 req/day). Worst case is 2 runs/day x this value = 400
// odds lookups/day, leaving ample headroom for grading and manual runs.
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

const TIER_CONFIG = [
  { tier: 'mega', label: 'Mega Day Ticket', matchCount: 4, oddsRange: '1.5-3', alwaysFree: true },
  // Exactly two legs, cumulative odds between 2 and 4 (inclusive). Held to
  // a strict band — see STRICT_RANGE_TIERS below. Must stay in sync with
  // TIER_CONFIG in src/lib/dataFetcher.ts.
  { tier: 'duo', label: 'Duo', matchCount: 2, oddsRange: '2-4', alwaysFree: false },
  // Single-match category. Only ever one match per slip — the safest
  // Home Win / Away Win / Over 2.5 pick available in the 1.5-2.0 odds
  // band. Produced in EVERY release slot (see buildSaintsLockTickets).
  // Sign-up required, no free trial ever applies — see the separate
  // checkout flow in plans.ts.
  { tier: 'saints_lock', label: "Saint's Lock", matchCount: 1, oddsRange: '1.5-2', alwaysFree: false },
];

// Numeric cumulative-odds targets matching each tier's oddsRange label
// above. These are ACTUALLY ENFORCED during slip assembly (see
// pickFixturesForSlip) — previously oddsRange was just a display string
// with nothing checking whether a ticket's real combined odds landed
// inside it. Tiers without an entry here are intentionally left unset
// ("Mixed" by design, no fixed target).
const TIER_ODDS_TARGET = {
  mega: [1.5, 3],
  duo: [2, 4],
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
 *
 * SAINT'S LOCK: each priced fixture may carry TWO independent picks —
 * `market/odds/confidence` (the regular pick, must clear MIN_CONFIDENCE)
 * and `lockPick` (the Saint's Lock candidate, see pickSaintsLockMarket).
 * A fixture that has ONLY a lockPick is flagged `lockOnly` and is kept out
 * of every regular tier by poolForTier.
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
      // failing the whole run (date-range limits can differ by API plan).
      console.warn(`Could not fetch fixtures for ${d}, skipping that date:`, err.message);
      continue;
    }
    const eligible = fixtures.filter(
      (f) =>
        LEAGUE_ALLOWLIST.has(f.league?.id) &&
        // Defense-in-depth: excludes youth/reserve/third-division-or-lower
        // competitions by name pattern even if leagues.json (built by
        // resolve-leagues.mjs, which applies the same filter) is stale or
        // predates this filter — see scripts/lib/leagueQuality.mjs.
        !isAmateurOrYouthLeague(f.league?.name) &&
        // Product rule: no South American fixtures on any ticket (defense-in-
        // depth on top of the allowlist filter — see scripts/lib/regionFilter.mjs).
        !isSouthAmericanLeague(f.league?.country, f.league?.name) &&
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
          if (seen.has(fixtureId)) continue; // already priced

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
          const lockPick = pickSaintsLockMarket(oddsResponse);
          if (!picked && !lockPick) continue; // no usable market for this fixture — skip it
          const base = picked ?? lockPick;

          seen.set(fixtureId, {
            fixtureId,
            ticketDate: dateStr(new Date()),
            league: f.league?.name ?? 'Unknown League',
            country: f.league?.country ?? 'Unknown',
            homeTeam: f.teams?.home?.name ?? 'Home',
            awayTeam: f.teams?.away?.name ?? 'Away',
            kickoff: f.fixture?.date,
            market: base.market,
            odds: base.odds,
            confidence: base.confidence,
            lockPick, // Saint's Lock candidate (or null)
            lockOnly: !picked, // true = must NOT be used by any regular tier
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

// Result-based markets to steer away from when priced this short — an
// extremely tight price on any of these can still be upset (a draw, a cup
// shock, a keeper's bad day). Double Chance is the only one of these that
// actually reaches odds this low (as tight as 1.1) — Home Win / Away Win
// can NEVER trigger this guard, since their own odds band in
// MARKET_CATALOG (markets.mjs) starts at 1.3: an outright win pick is
// never substituted away for being "too safe." This guard exists purely
// to catch an overly tight Double Chance price, not to steer away from
// full wins — see FULL_WIN_MARKETS / ensureFullWinLeg below for the
// separate "always incorporate a full win where necessary" logic.
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

// Saint's Lock candidate markets — straight Home Win / Away Win / Over 2.5
// Goals only, priced inside the tier's 1.5-2.0 odds band. Deliberately
// SEPARATE from pickMarketFromOdds: at 1.5-2.0 odds the implied confidence
// is only ~50-67%, so these picks can never clear MIN_CONFIDENCE (68) and
// would otherwise never enter the pool at all — which is exactly why
// Saint's Lock used to come out empty every run. Lowest odds in band =
// the market's own most-favored option.
const SAINTS_LOCK_MARKETS = new Set(['Home Win', 'Away Win', 'Over 2.5 Goals']);

function pickSaintsLockMarket(oddsResponse) {
  const bookmaker = oddsResponse?.[0]?.bookmakers?.[0];
  if (!bookmaker) return null;

  const [minOdds, maxOdds] = TIER_ODDS_TARGET.saints_lock;
  const best = collectViableOutcomes(bookmaker.bets)
    .filter((o) => SAINTS_LOCK_MARKETS.has(o.market) && o.odds >= minOdds && o.odds <= maxOdds)
    .sort((a, b) => a.odds - b.odds)[0];
  if (!best) return null;

  return { market: best.market, odds: best.odds, confidence: impliedConfidence(best.odds) };
}

// --- Assemble tickets from the priced-fixture pool ---------------------------

// Tiers with fewer than 7 matches favor safer, more heavily-favored picks:
// their fixture pool is restricted to legs priced at 1.77 or below rather
// than the full odds range used for Gold and up.
const SMALL_TICKET_TIERS = new Set(['mega', 'duo']); // matchCount < 7
// Tiers whose odds band is a hard requirement: zero tolerance slack, and
// the slip must use exactly the configured number of legs or it is skipped.
const STRICT_RANGE_TIERS = new Set(['duo']);
const DEFAULT_RANGE_TOLERANCE = 0.3;
const SMALL_TICKET_MAX_ODDS = 1.77;

/**
 * Narrows the pool for a regular tier. Always drops lock-only fixtures
 * (they exist purely as Saint's Lock candidates and never cleared
 * MIN_CONFIDENCE), then narrows to safer, lower-odds picks for tiers
 * under 7 matches.
 */
function poolForTier(pool, tier) {
  const regular = pool.filter((p) => !p.lockOnly);
  if (!SMALL_TICKET_TIERS.has(tier)) return regular;
  return regular.filter((p) => p.odds <= SMALL_TICKET_MAX_ODDS);
}

// No single match can appear in more than this many of the day's tickets,
// across every tier combined. Without this cap, a small fixture pool can
// end up reused in nearly every ticket — meaning one unexpected result
// takes down the whole day's slate at once instead of just a few tickets.
const MAX_FIXTURE_APPEARANCES_PER_DAY = 3;

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
function ensureFullWinLeg(picks, pool, usageCount, targetRange, tolerance = DEFAULT_RANGE_TOLERANCE) {
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
    // No odds band to protect — swap out
    // the current highest-odds leg for the full-win candidate.
    const highestIdx = picks.reduce((hi, p, i) => (p.odds > picks[hi].odds ? i : hi), 0);
    const next = [...picks];
    next[highestIdx] = candidate;
    return next;
  }

  const [minTotal, maxTotal] = targetRange;
  const TOLERANCE = tolerance;
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
function pickFixturesForSlip(pool, maxMatchCount, usageCount, targetRange, tolerance = DEFAULT_RANGE_TOLERANCE) {
  const eligible = pool.filter((f) => (usageCount.get(f.fixtureId) ?? 0) < MAX_FIXTURE_APPEARANCES_PER_DAY);
  if (eligible.length === 0) return [];

  const ranked = [...eligible].sort((a, b) => {
    const usedA = usageCount.get(a.fixtureId) ?? 0;
    const usedB = usageCount.get(b.fixtureId) ?? 0;
    if (usedA !== usedB) return usedA - usedB; // least-used first
    return a.odds - b.odds; // then safest first
  });

  if (!targetRange) {
    // No target range to hit —
    // just take the safest available up to the max, as before.
    if (ranked.length < maxMatchCount) return [];
    return ensureFullWinLeg(ranked.slice(0, maxMatchCount), pool, usageCount, null, tolerance);
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
  const TOLERANCE = tolerance;
  const withinTolerance = finalTotal >= minTotal * (1 - TOLERANCE) && finalTotal <= maxTotal * (1 + TOLERANCE);
  if (!withinTolerance || picks.length === 0) return []; // pool doesn't have enough spread to hit this tier's range today

  return ensureFullWinLeg(picks, pool, usageCount, targetRange, tolerance);
}

/**
 * Saint's Lock — GUARANTEED once per release slot whenever ANY fixture in
 * today's pool has a qualifying Saint's Lock market (Home Win / Away Win /
 * Over 2.5 at 1.5-2.0 odds, see pickSaintsLockMarket).
 *
 * The old 85% confidence floor is gone: at 1.5-2.0 odds the implied
 * confidence is only ~50-67%, so that floor could never be met and the
 * tier came out empty every run. Selection is now simply "the most
 * favored qualifying pick available" (lowest odds in band = highest
 * implied confidence), in BOTH daily slots.
 *
 * The chosen fixture row is written with the Saint's Lock market (so
 * grading settles the right market), and its usageCount is maxed out so no
 * other tier in this run can reuse the same fixture with a different
 * market. main() also freezes fixtures already used by today's earlier
 * Saint's Lock slip so a later run can't re-price and overwrite them.
 */
function buildSaintsLockTickets(dailyPool, usageCount, today, slot, now) {
  const config = TIER_CONFIG.find((c) => c.tier === 'saints_lock');

  const candidates = dailyPool
    .filter((p) => p.lockPick && (usageCount.get(p.fixtureId) ?? 0) < MAX_FIXTURE_APPEARANCES_PER_DAY)
    .sort((a, b) => b.lockPick.confidence - a.lockPick.confidence);

  if (candidates.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `Saint's Lock slot ${slot}: NO fixture today has a Home Win / Away Win / Over 2.5 market ` +
        `priced ${TIER_ODDS_TARGET.saints_lock[0]}-${TIER_ODDS_TARGET.saints_lock[1]} — nothing produced for this slot.`
    );
    return { tickets: [], ticketMatches: [], fixturesUsed: [] };
  }

  const base = candidates[0];
  const pick = { ...base, ...base.lockPick }; // fixture row gets the Saint's Lock market/odds/confidence
  usageCount.set(pick.fixtureId, MAX_FIXTURE_APPEARANCES_PER_DAY); // keep it out of every other tier

  const ticketId = `${today}-saints_lock-${slot}`;
  const availableAtIso = new Date(now.getTime() + AVAILABILITY_DELAY_MS).toISOString();

  const tickets = [
    {
      id: ticketId,
      ticket_date: today,
      tier: 'saints_lock',
      slip_label: null, // marketed as one pick at a time, not "1 of 2"
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
}

function buildTickets(dailyPool, slipState, now) {
  const today = dateStr(now);
  const availableAtIso = new Date(now.getTime() + AVAILABILITY_DELAY_MS).toISOString();
  const tickets = [];
  const ticketMatches = [];
  const fixturesUsed = new Map();
  const usageCount = new Map(); // shared across every tier/slip for the day

  // Saint's Lock is built FIRST with its own dedicated selection (see
  // buildSaintsLockTickets) so it always gets first claim on a fixture
  // before any regular tier can use it.
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

    const pool = poolForTier(dailyPool, config.tier);
    const targetRange = TIER_ODDS_TARGET[config.tier] ?? null;
    const strict = STRICT_RANGE_TIERS.has(config.tier);

    const picks = pickFixturesForSlip(
      pool,
      config.matchCount,
      usageCount,
      targetRange,
      strict ? 0 : DEFAULT_RANGE_TOLERANCE
    );
    if (picks.length === 0 || (strict && picks.length !== config.matchCount)) {
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

  // Freeze fixtures already used by today's earlier Saint's Lock slip(s).
  // Their fixture rows carry the Saint's Lock market; re-pricing one in
  // this run (possibly with a different regular market) and upserting it
  // would overwrite that market and corrupt grading. Also stops slot 1
  // from re-picking slot 0's fixture.
  const { data: lockRows, error: lockErr } = await supabase
    .from('ticket_matches')
    .select('fixture_id, tickets!inner(tier, ticket_date)')
    .eq('tickets.tier', 'saints_lock')
    .eq('tickets.ticket_date', todayStr);
  if (lockErr) {
    console.warn("Could not read today's existing Saint's Lock fixtures:", lockErr.message);
  }
  const frozen = new Set((lockRows ?? []).map((r) => r.fixture_id));
  const dropFrozen = (pool) => pool.filter((f) => !frozen.has(f.fixtureId));

  const { tickets, ticketMatches, fixturesUsed } = buildTickets(
    dropFrozen(dailyPool),
    slipState,
    today
  );

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
