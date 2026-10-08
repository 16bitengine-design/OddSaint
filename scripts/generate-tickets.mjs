// ---------------------------------------------------------------------------
// Odd Saint — daily ticket generation (Mega Day, Duo, Saint's Lock ONLY)
//
// Pulls real fixtures + bookmaker odds from API-Football, builds the three
// remaining tiers, and writes them to Supabase. Runs twice a day via
// .github/workflows/generate-tickets.yml (03:00 and 09:00 UTC) so each tier
// releases in up to two staggered slots — see nextSlotFor.
//
// EVERY RUN: each category (Mega, Duo, Saint's Lock) must get a ticket. Rules
// below are applied through a relaxation ladder (see RELAXATION_LEVELS) — the
// strictest level that can build a valid ticket wins.
//
// PRODUCT RULES ENFORCED HERE
//   Tiers: mega, duo, saints_lock. Everything else is eliminated.
//   Leagues (see scripts/lib/leaguePolicy.mjs): division caps per country (none
//            beyond the 5th; England 5 + the U21 league; Sweden/Denmark/Finland/
//            Norway 4; Russia/France/Germany/Italy/Spain/Scotland 3; rest of
//            Europe, North America, Africa and Asia 2), ALL continental and
//            regional competitions, no women's / youth / friendlies, no South
//            American domestic leagues.
//   Direct win (Home/Away Win), any ticket: the BACKED team must sit at
//            least minRankGap places above its opponent in the league table
//            AND have >= minWins wins in its last 5 league matches (strict
//            level: 6 places, 3 wins). The opponent having <= 2 wins is
//            PREFERRED, not required (see opponentPenalty).
//   Over 2.5 Goals, any ticket: BOTH teams must average >= minAvgGoals goals
//            scored over their last 5 finished matches (strict: 2.0).
//   Double Chance (Mega/Duo only): allowed only when its odds are <= 1.3
//            (this cap is never relaxed).
//   Both teams to score (BTTS Yes/No), Mega/Duo only: AVOIDED where possible; when
//            used, only if both teams' last-5 matches support it (BTTS - Yes:
//            both sides scored in >= 4 of each team's last 5; BTTS - No: in
//            <= 1 of each team's last 5). Never relaxed.
//   Any other market (Mega/Duo only): no rank/form requirement.
//   Mega Day: any market, EXACTLY 3 matches, cumulative odds in [1.97, 3]
//            (range and floor never relax).
//   Duo: any market, exactly 2 legs, cumulative odds in [2, 4] (never relaxed).
//   Saint's Lock: ONE match; market must be a direct win or Over 2.5 Goals
//            (never Double Chance); odds 1.5-2.17. These two are NEVER relaxed.
//
// HONEST SCOPE NOTE: "confidence" is a simple function of bookmaker odds
// (implied probability), not a trained model.
// ---------------------------------------------------------------------------
import { getFixturesForDate, getOddsForFixture, getStandings, getFixturesForTeam } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { collectViableOutcomes, FULL_WIN_MARKETS } from './lib/markets.mjs';
import { isYouthOrReserveTeam } from './lib/leagueQuality.mjs';
import { classifyLeague } from './lib/leaguePolicy.mjs';
import { fileURLToPath } from 'node:url';

// --- Config -----------------------------------------------------------------

// Which competitions are eligible is decided by scripts/lib/leaguePolicy.mjs
// (division caps per country, all continental/regional competitions, no
// women's / youth / friendlies, no South American domestic leagues). It works
// from the league's own name + country on each fixture, so scripts/lib/
// leagues.json is no longer needed to pick fixtures.

const MAX_ODDS_LOOKUPS_PER_RUN = 200;
const PER_LEAGUE_LOOKUPS_PER_ROUND = 3;

const PRIORITY_LEAGUE_NAMES = new Set([
  'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1',
  'UEFA Champions League', 'UEFA Europa League', 'Eredivisie',
  'Scottish Premiership', 'Austrian Bundesliga', 'Swiss Super League', 'Turkish Super Lig',
  'Jupiler Pro League', 'Superligaen', 'Eliteserien',
]);

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

const EXCLUDED_TEAMS = new Set([
  // 'Example FC',
]);

function isExcluded(homeTeam, awayTeam) {
  return EXCLUDED_TEAMS.has(homeTeam) || EXCLUDED_TEAMS.has(awayTeam);
}

// Must stay in sync with TIER_CONFIG in src/lib/dataFetcher.ts.
const TIER_CONFIG = [
  { tier: 'mega', label: 'Mega Day Ticket', matchCount: 3, oddsRange: '1.97-3', alwaysFree: true },
  { tier: 'duo', label: 'Duo', matchCount: 2, oddsRange: '2-4', alwaysFree: false },
  { tier: 'saints_lock', label: "Saint's Lock", matchCount: 1, oddsRange: '1.5-2.17', alwaysFree: false },
];

// (Cumulative-odds ranges, odds floors and confidence floors now live on each
// relaxation level — see BASE_LEVEL / RELAXATION_LEVELS below.)

// Saint's Lock
const SAINTS_LOCK_ODDS_MIN = 1.5;
const SAINTS_LOCK_ODDS_MAX = 2.17;
const SAINTS_LOCK_MARKETS = new Set(['Home Win', 'Away Win', 'Over 2.5 Goals']);

// Strength rules — applied through a RELAXATION LADDER. Every scheduled run
// must produce a ticket for each category, so each category first tries the
// strict rules (level 0) and, only if nothing valid can be built, steps down
// one level at a time until it can. The level used is logged per ticket.
// Per level:
//   minRankGap / minWins — direct win: backed team this many places above its
//                          opponent, and this many wins in its last 5
//   minAvgGoals          — Over 2.5: BOTH teams' average goals over last 5
//   dcMaxOdds            — Double Chance price cap (null = no cap)
//   minConf              — per-tier confidence floor (confidence = 100/odds)
//   oddsRange / oddsFloor— per-tier cumulative-odds range and hard floor
//   requireStandings     — false = no standings/goals data needed; a win is
//                          then allowed on the bookmaker's favourite
// The ladder stops at relaxed-3. NEVER relaxed: Saint's Lock markets (direct
// win / Over 2.5 only) and odds band, the Double Chance cap (1.3), the Mega /
// Duo cumulative-odds ranges and 1.97 floor, the per-tier confidence floors,
// tier sizes (Mega 3, Duo 2), and the requirement that a win backs the
// better-placed side. Only the rank gap, win count and goal average loosen.
// (dcMaxOdds, minConf, oddsRange, oddsFloor and requireStandings are kept as
// per-level fields so a looser level can be added later without code changes.)
const BASE_LEVEL = {
  dcMaxOdds: 1.3,
  minConf: { mega: 68, duo: 58 },
  oddsRange: { mega: [1.97, 3], duo: [2, 4] },
  oddsFloor: { mega: 1.97, duo: 1.97 },
  requireStandings: true,
};
const RELAXATION_LEVELS = [
  { ...BASE_LEVEL, name: 'strict', minRankGap: 6, minWins: 3, minAvgGoals: 2.0 },
  { ...BASE_LEVEL, name: 'relaxed-1', minRankGap: 5, minWins: 3, minAvgGoals: 1.75 },
  { ...BASE_LEVEL, name: 'relaxed-2', minRankGap: 4, minWins: 3, minAvgGoals: 1.5 },
  { ...BASE_LEVEL, name: 'relaxed-3', minRankGap: 4, minWins: 2, minAvgGoals: 1.5 },
];
const MIN_GAMES_PLAYED = 5; // early-season tables are meaningless
const OPPONENT_MAX_WINS_LAST_5 = 2; // opponent (preference only)

const SMALL_TICKET_TIERS = new Set(['mega']);
const SMALL_TICKET_MAX_ODDS = 1.77;
const MAX_FIXTURE_APPEARANCES_PER_DAY = 3;

const MAX_TICKETS_PER_CATEGORY = 2;
const MIN_HOURS_BETWEEN_SLOTS = 5; // runs are 6h apart (03:00 and 09:00 UTC); 5 leaves room for GitHub start-up jitter
// Batches become visible at FIXED clock times, not "generation + 1h": slot 0 at
// 04:00 UTC (07:00 EAT), slot 1 at 10:00 UTC (13:00 EAT). Generation runs at
// 03:00 / 09:00 UTC; if a run starts late (GitHub jitter) and has already
// passed its release time, the batch is available immediately instead of later.
// MUST match RELEASE_SLOT_HOURS_UTC in src/lib/dataFetcher.ts.
const RELEASE_SLOT_HOURS_UTC = [4, 10];

function releaseTimeFor(slot, now) {
  const hour = RELEASE_SLOT_HOURS_UTC[Math.min(slot, RELEASE_SLOT_HOURS_UTC.length - 1)];
  const scheduled = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0);
  return new Date(Math.max(scheduled, now.getTime())).toISOString();
}
const MIN_HOURS_TO_KICKOFF = 2;

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

// --- Staggered release --------------------------------------------------------

async function fetchTodaysSlipState(supabase, today) {
  const { data, error } = await supabase
    .from('tickets')
    .select('tier, release_slot, available_at, created_at')
    .eq('ticket_date', today);
  if (error) throw error;

  const byTier = new Map();
  (data ?? []).forEach((row) => {
    const existing = byTier.get(row.tier) ?? { count: 0, lastCreatedAt: null };
    existing.count += 1;
    if (!existing.lastCreatedAt || row.created_at > existing.lastCreatedAt) {
      existing.lastCreatedAt = row.created_at;
    }
    byTier.set(row.tier, existing);
  });
  return byTier;
}

function nextSlotFor(maxSlipsToday, slipState) {
  const state = slipState ?? { count: 0, lastCreatedAt: null };
  if (state.count >= maxSlipsToday) return null;
  if (state.count === 0) return 0;
  // created_at is the real generation time (available_at is a fixed release time now).
  const hoursSinceLast = (Date.now() - new Date(state.lastCreatedAt).getTime()) / 3_600_000;
  if (hoursSinceLast < MIN_HOURS_BETWEEN_SLOTS) return null;
  return state.count;
}

/** Fixture IDs already used by today's Saint's Lock tickets — slot 1 must never repeat slot 0's match. */
async function fetchTodaysSaintsLockFixtureIds(supabase, today) {
  const { data: tix, error } = await supabase
    .from('tickets')
    .select('id')
    .eq('ticket_date', today)
    .eq('tier', 'saints_lock');
  if (error) throw error;
  const ids = (tix ?? []).map((t) => t.id);
  if (ids.length === 0) return new Set();
  const { data: links, error: linksErr } = await supabase
    .from('ticket_matches')
    .select('fixture_id')
    .in('ticket_id', ids);
  if (linksErr) throw linksErr;
  return new Set((links ?? []).map((l) => l.fixture_id));
}

/** fixture id -> market already stored for it. The fixtures table holds ONE market per fixture, so a later run must not overwrite it with a different market (that would mis-grade the earlier ticket). */
async function fetchExistingMarkets(supabase, fixtureIds) {
  const map = new Map();
  for (let i = 0; i < fixtureIds.length; i += 200) {
    const chunk = fixtureIds.slice(i, i + 200);
    const { data, error } = await supabase.from('fixtures').select('id, market').in('id', chunk);
    if (error) throw error;
    (data ?? []).forEach((r) => map.set(r.id, r.market));
  }
  return map;
}

// --- Strength data: standings, form, goals -----------------------------------

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);
const standingsCache = new Map(); // `${leagueId}-${season}` -> Map(teamId -> { rank, played, form }) | null
const statsCache = new Map(); // teamId -> { avgGoals, bttsCount } over its last 5 finished matches, or null

/** League table for one league+season, cached for the run. Null if unavailable or multi-group (cups, conferences). */
async function loadStandings(leagueId, season) {
  const key = `${leagueId}-${season}`;
  if (standingsCache.has(key)) return standingsCache.get(key);
  let table = null;
  try {
    const res = await getStandings(leagueId, season);
    const groups = res?.[0]?.league?.standings ?? [];
    if (groups.length === 1) {
      table = new Map(
        groups[0].map((r) => [r.team.id, { rank: r.rank, played: r.all?.played ?? 0, form: r.form ?? '' }])
      );
    }
  } catch (err) {
    console.warn(`Standings unavailable for league ${leagueId}:`, err.message);
  }
  standingsCache.set(key, table);
  return table;
}

function winsInLast5(form) {
  const last5 = (form ?? '').slice(-5);
  if (last5.length < 5) return null;
  return [...last5].filter((c) => c === 'W').length;
}

/**
 * Raw direct-win metrics for a fixture (NOT a pass/fail — thresholds come from
 * the relaxation level, see winPasses). The backed team is always the
 * better-placed side. Returns null if no usable table / data.
 */
async function winMetrics(f) {
  const table = await loadStandings(f.league?.id, f.league?.season);
  if (!table) return null;
  const home = table.get(f.teams?.home?.id);
  const away = table.get(f.teams?.away?.id);
  if (!home || !away) return null;
  if (home.played < MIN_GAMES_PLAYED || away.played < MIN_GAMES_PLAYED) return null;

  const favoured = home.rank < away.rank ? 'home' : 'away';
  const backed = favoured === 'home' ? home : away;
  const opponent = favoured === 'home' ? away : home;
  return {
    favoured,
    gap: Math.abs(home.rank - away.rank),
    backedWins: winsInLast5(backed.form),
    opponentWins: winsInLast5(opponent.form),
  };
}

/**
 * A team's last 5 finished matches (any competition): average goals scored,
 * and in how many of them BOTH sides scored. Null if fewer than 5 are available.
 */
async function last5Stats(teamId) {
  if (statsCache.has(teamId)) return statsCache.get(teamId);
  let stats = null;
  try {
    const fixtures = await getFixturesForTeam(teamId, 5);
    const rows = [];
    for (const m of fixtures ?? []) {
      if (!FINISHED_STATUSES.has(m.fixture?.status?.short)) continue;
      const hg = m.goals?.home;
      const ag = m.goals?.away;
      if (hg == null || ag == null) continue;
      const isHome = m.teams?.home?.id === teamId;
      rows.push({ own: isHome ? hg : ag, opp: isHome ? ag : hg });
    }
    if (rows.length === 5) {
      stats = {
        avgGoals: rows.reduce((n, r) => n + r.own, 0) / 5,
        bttsCount: rows.filter((r) => r.own > 0 && r.opp > 0).length,
      };
    }
  } catch (err) {
    console.warn(`Last-5 stats unavailable for team ${teamId}:`, err.message);
  }
  statsCache.set(teamId, stats);
  return stats;
}

/** Raw goal metrics for Over 2.5 and both-teams-to-score decisions (null fields if a team's last 5 are unavailable). */
async function goalMetrics(f) {
  const [h, a] = await Promise.all([last5Stats(f.teams?.home?.id), last5Stats(f.teams?.away?.id)]);
  return {
    home: h?.avgGoals ?? null,
    away: a?.avgGoals ?? null,
    homeBtts: h?.bttsCount ?? null,
    awayBtts: a?.bttsCount ?? null,
  };
}

/** Direct-win rules at a given relaxation level. */
function winPasses(win, level) {
  return !!win && win.gap >= level.minRankGap && win.backedWins !== null && win.backedWins >= level.minWins;
}

/** Over 2.5 rule at a given level: BOTH teams must average at least level.minAvgGoals. */
function over25Passes(goals, level) {
  return !!goals && goals.home !== null && goals.away !== null && goals.home >= level.minAvgGoals && goals.away >= level.minAvgGoals;
}

// BOTH-TEAMS-TO-SCORE is a tricky market, so it is AVOIDED WHERE POSSIBLE (see
// AVOIDED_MARKETS) and, when it is used, only under these conditions — over each
// team's last 5 finished matches (any competition), never relaxed:
//   BTTS - Yes: BOTH teams have been in a match where both sides scored in at
//               least BTTS_YES_MIN_COUNT of their last 5.
//   BTTS - No : BOTH teams have been in such a match in at most BTTS_NO_MAX_COUNT
//               of their last 5 (the riskier call, so the stricter test).
// Missing data = not allowed.
const BTTS_YES_MIN_COUNT = 4;
const BTTS_NO_MAX_COUNT = 1;

function bttsYesPasses(goals) {
  return !!goals && goals.homeBtts !== null && goals.awayBtts !== null && goals.homeBtts >= BTTS_YES_MIN_COUNT && goals.awayBtts >= BTTS_YES_MIN_COUNT;
}
function bttsNoPasses(goals) {
  return !!goals && goals.homeBtts !== null && goals.awayBtts !== null && goals.homeBtts <= BTTS_NO_MAX_COUNT && goals.awayBtts <= BTTS_NO_MAX_COUNT;
}

/** Last-resort only: is this the bookmaker's favourite (the lower-priced) of the fixture's win outcomes? */
function isMarketFavourite(outcome, p) {
  const wins = (p.viable ?? []).filter((o) => FULL_WIN_MARKETS.has(o.market));
  return wins.every((o) => outcome.odds <= o.odds);
}

/**
 * Is this outcome allowed for this fixture at this level? Wins need winPasses
 * AND must back the better-placed side (or, at last resort, the bookmaker's
 * favourite). Over 2.5 needs over25Passes (or no data requirement at last
 * resort). Double Chance only at odds <= level.dcMaxOdds when a cap exists
 * (never on Saint's Lock). Both-teams-to-score only under the BTTS conditions
 * above (never on Saint's Lock). Other markets are unrestricted on Mega/Duo
 * and forbidden for Saint's Lock.
 */
function marketAllowedAt(outcome, p, level, saintsLockOnly) {
  if (outcome.market === 'Over 2.5 Goals') return over25Passes(p.goals, level) || !level.requireStandings;
  if (outcome.market === 'Home Win' || outcome.market === 'Away Win') {
    const side = outcome.market === 'Home Win' ? 'home' : 'away';
    if (winPasses(p.win, level) && p.win.favoured === side) return true;
    return !level.requireStandings && isMarketFavourite(outcome, p);
  }
  if (outcome.market.startsWith('Double Chance')) {
    return !saintsLockOnly && (level.dcMaxOdds === null || outcome.odds <= level.dcMaxOdds);
  }
  if (outcome.market === 'BTTS - Yes') return !saintsLockOnly && bttsYesPasses(p.goals);
  if (outcome.market === 'BTTS - No') return !saintsLockOnly && bttsNoPasses(p.goals);
  return !saintsLockOnly;
}

function allowedOutcomesAt(p, level, saintsLockOnly) {
  return (p.viable ?? []).filter((o) => marketAllowedAt(o, p, level, saintsLockOnly));
}

// --- Fetch + price fixtures ---------------------------------------------------

// A match is eligible when the bookmakers in the TARGET LOCATION offer it —
// not because of its league's name. Set TARGET_BOOKMAKER_IDS (comma-separated
// API-Football bookmaker IDs, in priority order — run the "List Bookmakers"
// workflow to find them). When set, odds come ONLY from those bookmakers and
// a fixture none of them price is skipped. When empty, behaviour is unchanged
// (the first bookmaker in the response is used and nothing is skipped).
const TARGET_BOOKMAKER_IDS = (process.env.TARGET_BOOKMAKER_IDS ?? '')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
let skippedNotOffered = 0;

/** The bookmaker whose odds to use for a fixture, or null if none of the target bookmakers offer it. */
function chooseBookmaker(oddsResponse) {
  const bookmakers = oddsResponse?.[0]?.bookmakers ?? [];
  if (TARGET_BOOKMAKER_IDS.length === 0) return bookmakers[0] ?? null;
  for (const id of TARGET_BOOKMAKER_IDS) {
    const match = bookmakers.find((b) => b.id === id);
    if (match) return match;
  }
  return null;
}

function hasMinimumLeadTime(kickoffISO, now) {
  if (!kickoffISO) return false;
  return new Date(kickoffISO).getTime() - now.getTime() >= MIN_HOURS_TO_KICKOFF * 60 * 60 * 1000;
}

function impliedConfidence(odds) {
  const raw = Math.round((1 / odds) * 100);
  return Math.min(95, Math.max(55, raw));
}

/**
 * Reads a fixture's bookmaker odds and gathers EVERYTHING the ladder needs
 * once, so relaxing a rule later costs no extra API requests: every viable
 * outcome, plus the raw win / goal metrics (only fetched when an outcome
 * that needs them is actually on offer). Returns null if no outcome exists.
 */
async function priceFixture(oddsResponse, f) {
  const bookmaker = chooseBookmaker(oddsResponse);
  if (!bookmaker) {
    if (TARGET_BOOKMAKER_IDS.length > 0 && (oddsResponse?.[0]?.bookmakers?.length ?? 0) > 0) skippedNotOffered++;
    return null;
  }

  const viable = collectViableOutcomes(bookmaker.bets).map((o) => ({ market: o.market, odds: o.odds }));
  if (viable.length === 0) return null;

  const win = viable.some((o) => FULL_WIN_MARKETS.has(o.market)) ? await winMetrics(f) : null;
  const goals = viable.some((o) => o.market === 'Over 2.5 Goals' || o.market.startsWith('BTTS')) ? await goalMetrics(f) : null;
  return { viable, win, goals };
}

/**
 * Fetches and prices today's fixtures, spending up to `maxOddsLookups` /odds
 * requests, rotating fairly across leagues (see PER_LEAGUE_LOOKUPS_PER_ROUND).
 * Standings and last-5 goals requests are extra, cached, and only made for
 * fixtures whose odds contain a market that needs them.
 */
async function fetchPricedFixtures(dates, maxOddsLookups, now) {
  const seen = new Map();
  let oddsLookupsUsed = 0;
  const leagueBreakdown = new Map();

  for (const d of dates) {
    let fixtures;
    try {
      fixtures = await getFixturesForDate(d);
    } catch (err) {
      console.warn(`Could not fetch fixtures for ${d}, skipping that date:`, err.message);
      continue;
    }
    const notClassified = new Map(); // "country | league" -> count, for the run log
    const eligible = fixtures.filter((f) => {
      const verdict = classifyLeague(f.league);
      if (!verdict.allowed) {
        if (verdict.reason.startsWith('unclassified') || verdict.reason.startsWith('country not covered')) {
          const key = `${f.league?.country} | ${f.league?.name}`;
          notClassified.set(key, (notClassified.get(key) ?? 0) + 1);
        }
        return false;
      }
      return (
        // U21 / reserve / B sides are excluded everywhere EXCEPT England's U21 league.
        (verdict.allowYouthTeams || !isYouthOrReserveTeam(f.teams?.home?.name, f.teams?.away?.name)) &&
        !isBigClash(f.teams?.home?.name, f.teams?.away?.name) &&
        !isExcluded(f.teams?.home?.name, f.teams?.away?.name) &&
        hasMinimumLeadTime(f.fixture?.date, now)
      );
    });
    if (notClassified.size > 0) {
      console.log(
        `Not eligible under the league policy (unclassified): ` +
          Array.from(notClassified.entries()).slice(0, 15).map(([k, c]) => `${k} (${c})`).join('; ') +
          (notClassified.size > 15 ? `; +${notClassified.size - 15} more` : '')
      );
    }
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
        while (takenThisRound < PER_LEAGUE_LOOKUPS_PER_ROUND && queue.length > 0 && oddsLookupsUsed < maxOddsLookups) {
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
            console.warn(`Odds lookup failed for fixture ${fixtureId}:`, err.message);
            continue;
          }

          const priced = await priceFixture(oddsResponse, f);
          if (!priced) continue;

          seen.set(fixtureId, {
            fixtureId,
            ticketDate: dateStr(new Date()),
            league: f.league?.name ?? 'Unknown League',
            country: f.league?.country ?? 'Unknown',
            homeTeam: f.teams?.home?.name ?? 'Home',
            awayTeam: f.teams?.away?.name ?? 'Away',
            kickoff: f.fixture?.date,
            viable: priced.viable,
            win: priced.win,
            goals: priced.goals,
          });
          leagueBreakdown.set(leagueName, (leagueBreakdown.get(leagueName) ?? 0) + 1);
        }
      }
    }
  }

  if (TARGET_BOOKMAKER_IDS.length > 0) {
    console.log(`Target bookmakers: ${TARGET_BOOKMAKER_IDS.join(', ')} — ${skippedNotOffered} fixture(s) skipped because none of them offer it.`);
  }
  if (leagueBreakdown.size > 0) {
    console.log(
      'Priced fixtures by league this run: ' +
        Array.from(leagueBreakdown.entries()).map(([n, c]) => `${n}: ${c}`).join(', ')
    );
  }

  return Array.from(seen.values()).sort((a, b) => {
    const aP = PRIORITY_LEAGUE_NAMES.has(a.league) ? 1 : 0;
    const bP = PRIORITY_LEAGUE_NAMES.has(b.league) ? 1 : 0;
    if (aP !== bP) return bP - aP;
    return Math.min(...a.viable.map((o) => o.odds)) - Math.min(...b.viable.map((o) => o.odds));
  });
}

// --- Assemble tickets ---------------------------------------------------------

function computeRawOdds(picks) {
  return picks.reduce((acc, p) => acc * p.odds, 1);
}
function computeTotalOdds(picks) {
  return Math.round(computeRawOdds(picks) * 100) / 100;
}
const penaltyOf = (f) => f.opponentPenalty ?? 0;

// AVOID WHERE POSSIBLE (a preference, not an exclusion): both teams to score.
// A combination without a BTTS leg always beats one with a BTTS leg; BTTS is
// used only when the ticket cannot be built without it AND the conditions
// above are met.
const AVOIDED_MARKETS = new Set(['BTTS - Yes', 'BTTS - No']);
const avoidedOf = (f) => (AVOIDED_MARKETS.has(f.market) ? 1 : 0);


/** Weak-opponent PREFERENCE at a level: 1 when the backed team's opponent has more than 2 wins in its last 5 (only meaningful when the win rule passes). */
function opponentPenaltyAt(p, level) {
  return winPasses(p.win, level) && p.win.opponentWins !== null && p.win.opponentWins > OPPONENT_MAX_WINS_LAST_5 ? 1 : 0;
}

/** The fixtures table stores ONE market per fixture: a market is usable only if it matches what is already stored / already chosen this run. */
function compatibleMarket(fixtureId, market, existingMarkets, chosenMarket) {
  const stored = existingMarkets.get(fixtureId);
  const chosen = chosenMarket.get(fixtureId);
  return (stored === undefined || stored === market) && (chosen === undefined || chosen === market);
}

/**
 * Candidate legs for Mega / Duo at one relaxation level. Mega offers each
 * fixture's safest allowed market; Duo offers EVERY allowed market (a pair
 * needs a product >= 2, which the safest markets alone rarely reach).
 */
function poolAtLevel(dailyPool, tier, level, existingMarkets, chosenMarket) {
  const minConf = level.minConf[tier] ?? 0;
  const out = [];
  for (const p of dailyPool) {
    const allowed = allowedOutcomesAt(p, level, false).filter((o) =>
      compatibleMarket(p.fixtureId, o.market, existingMarkets, chosenMarket)
    );
    if (allowed.length === 0) continue;
    const penalty = opponentPenaltyAt(p, level);
    const make = (o) => ({ ...p, market: o.market, odds: o.odds, confidence: impliedConfidence(o.odds), opponentPenalty: penalty });

    if (tier === 'duo') {
      allowed.forEach((o) => {
        const c = make(o);
        if (c.confidence >= minConf) out.push(c);
      });
    } else {
      const preferred = allowed.filter((o) => !AVOIDED_MARKETS.has(o.market));
      const basePool = preferred.length > 0 ? preferred : allowed; // BTTS only if nothing else is allowed
      const base = make([...basePool].sort((a, b) => a.odds - b.odds)[0]); // the safest of those
      if (base.confidence >= minConf && (!SMALL_TICKET_TIERS.has(tier) || base.odds <= SMALL_TICKET_MAX_ODDS)) out.push(base);
    }
  }
  return out;
}

/**
 * Picks EXACTLY `k` different fixtures whose cumulative odds land inside
 * targetRange (lower bound is a hard floor, upper bound a hard cap). Used for
 * Mega Day (k = 3) and Duo (k = 2). Among valid combinations, prefers:
 *   (1) fewer both-teams-to-score legs (avoided where possible),
 *   (2) fewer weak-opponent warnings (opponentPenalty, a preference only),
 *   (3) less-reused fixtures,
 *   (4) for Mega, a combination that includes an outright win leg, where one exists,
 *   (5) the lowest total odds (the safest valid combination).
 * Candidates are capped to MAX_COMBO_CANDIDATES so the search stays small.
 */
const MAX_COMBO_CANDIDATES = 80;

function pickCombo(pool, k, usageCount, targetRange, preferFullWin = false) {
  const [minTotal, maxTotal] = targetRange;
  const usage = (f) => usageCount.get(f.fixtureId) ?? 0;

  const candidates = pool
    .filter((f) => usage(f) < MAX_FIXTURE_APPEARANCES_PER_DAY)
    .sort((a, b) => avoidedOf(a) - avoidedOf(b) || usage(a) - usage(b) || penaltyOf(a) - penaltyOf(b) || a.odds - b.odds)
    .slice(0, MAX_COMBO_CANDIDATES);

  let best = null;
  const chosen = [];

  function search(startIdx, product) {
    if (chosen.length === k) {
      if (product < minTotal || product > maxTotal) return;
      const score = [
        chosen.reduce((n, f) => n + avoidedOf(f), 0), // fewest both-teams-to-score legs first
        chosen.reduce((n, f) => n + penaltyOf(f), 0),
        chosen.reduce((n, f) => n + usage(f), 0),
        preferFullWin && chosen.some((f) => FULL_WIN_MARKETS.has(f.market)) ? 0 : preferFullWin ? 1 : 0,
        product,
      ];
      const better =
        !best ||
        score.some((v, i) => {
          for (let j = 0; j < i; j++) if (score[j] !== best.score[j]) return false;
          return v < best.score[i];
        });
      if (better) best = { picks: [...chosen], score };
      return;
    }
    for (let i = startIdx; i < candidates.length; i++) {
      const f = candidates[i];
      if (chosen.some((c) => c.fixtureId === f.fixtureId)) continue; // different matches only
      const next = product * f.odds;
      if (next > maxTotal) continue; // odds >= 1, so the product only grows
      chosen.push(f);
      search(i + 1, next);
      chosen.pop();
    }
  }

  search(0, 1);
  return best ? best.picks : [];
}

/** Saint's Lock candidates at one level: allowed win / Over 2.5 outcomes inside the 1.5-2.17 band (never Double Chance). Weak-opponent preference first, then the lowest odds. */
function saintsLockCandidates(dailyPool, level, usageCount, excludeFixtureIds, existingMarkets) {
  return dailyPool
    .filter((p) => (usageCount.get(p.fixtureId) ?? 0) < MAX_FIXTURE_APPEARANCES_PER_DAY && !excludeFixtureIds.has(p.fixtureId))
    .flatMap((p) => {
      const penalty = opponentPenaltyAt(p, level);
      return allowedOutcomesAt(p, level, true)
        .filter(
          (o) =>
            SAINTS_LOCK_MARKETS.has(o.market) &&
            o.odds >= SAINTS_LOCK_ODDS_MIN &&
            o.odds <= SAINTS_LOCK_ODDS_MAX &&
            (!existingMarkets.has(p.fixtureId) || existingMarkets.get(p.fixtureId) === o.market)
        )
        .map((o) => ({ ...p, market: o.market, odds: o.odds, confidence: impliedConfidence(o.odds), opponentPenalty: penalty }));
    })
    .sort((a, b) => penaltyOf(a) - penaltyOf(b) || a.odds - b.odds);
}

/**
 * Saint's Lock: ONE match, tried from the strictest relaxation level down
 * until a candidate exists. The chosen fixture is made EXCLUSIVE to this
 * ticket so no other ticket reuses it with a different market (the fixtures
 * table stores one market per fixture).
 */
function buildSaintsLockTickets(dailyPool, usageCount, today, slot, now, excludeFixtureIds, existingMarkets) {
  const config = TIER_CONFIG.find((c) => c.tier === 'saints_lock');

  for (const level of RELAXATION_LEVELS) {
    const candidates = saintsLockCandidates(dailyPool, level, usageCount, excludeFixtureIds, existingMarkets);
    if (candidates.length === 0) continue;

    const pick = candidates[0];
    usageCount.set(pick.fixtureId, MAX_FIXTURE_APPEARANCES_PER_DAY);
    console.log(`Saint's Lock: built at rule level "${level.name}" — ${pick.homeTeam} vs ${pick.awayTeam}, ${pick.market} @ ${pick.odds}.`);

    const ticketId = `${today}-saints_lock-${slot}`;
    return {
      tickets: [
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
          available_at: releaseTimeFor(slot, now),
        },
      ],
      ticketMatches: [{ ticket_id: ticketId, fixture_id: pick.fixtureId, sort_order: 0 }],
      fixturesUsed: [pick],
    };
  }
  return { tickets: [], ticketMatches: [], fixturesUsed: [] };
}

/**
 * Builds one ticket per category for this run. Each category walks the
 * relaxation ladder from the strictest rules down and stops at the first
 * level that yields a valid ticket — so every category gets a ticket
 * whenever ANY qualifying combination exists, and never a looser ticket than
 * it had to settle for.
 */
function buildTickets(dailyPool, slipState, now, excludeFromSaintsLock = new Set(), existingMarkets = new Map()) {
  const today = dateStr(now);
  const tickets = [];
  const ticketMatches = [];
  const fixturesUsed = new Map();
  const usageCount = new Map();
  const chosenMarket = new Map(); // fixtureId -> market already used by a ticket built this run

  const saintsLockSlot = nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get('saints_lock'));
  if (saintsLockSlot !== null) {
    const sl = buildSaintsLockTickets(dailyPool, usageCount, today, saintsLockSlot, now, excludeFromSaintsLock, existingMarkets);
    if (sl.tickets.length === 0) console.warn("Saint's Lock: no fixture qualified even at the most relaxed rule level — no ticket this run.");
    tickets.push(...sl.tickets);
    ticketMatches.push(...sl.ticketMatches);
    sl.fixturesUsed.forEach((f) => {
      fixturesUsed.set(f.fixtureId, f);
      chosenMarket.set(f.fixtureId, f.market);
    });
  } else {
    console.log("Saint's Lock: already at today's cap, or too soon since the last slip — skipping this run.");
  }

  // Duo is built BEFORE Mega: Duo is the more constrained ticket (two legs must
  // multiply to >= 2, which needs the richer, higher-priced markets), whereas
  // Mega can reach 1.97 from three short-priced legs. Building Mega first used
  // up the fixtures (and locked their markets to the shortest price) and
  // starved Duo on small days.
  const BUILD_ORDER = ['duo', 'mega'];
  for (const tierName of BUILD_ORDER) {
    const config = TIER_CONFIG.find((c) => c.tier === tierName);

    const slot = nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get(config.tier));
    if (slot === null) {
      console.log(`${config.label}: already at today's cap, or too soon since the last slip — skipping this run.`);
      continue;
    }

    let built = false;

    for (const level of RELAXATION_LEVELS) {
      const targetRange = level.oddsRange[config.tier];
      const floor = level.oddsFloor[config.tier];
      const pool = poolAtLevel(dailyPool, config.tier, level, existingMarkets, chosenMarket);
      // Mega Day = exactly 3 matches, Duo = exactly 2 (config.matchCount).
      const picks = pickCombo(pool, config.matchCount, usageCount, targetRange, config.tier === 'mega');
      if (picks.length === 0) continue;

      // Hard floor on cumulative odds, on the UNROUNDED product, BEFORE the
      // picks are registered as used.
      const rawTotal = computeRawOdds(picks);
      if (floor !== undefined && rawTotal < floor) continue;

      picks.forEach((p) => {
        fixturesUsed.set(p.fixtureId, p);
        usageCount.set(p.fixtureId, (usageCount.get(p.fixtureId) ?? 0) + 1);
        chosenMarket.set(p.fixtureId, p.market);
      });

      const ticketId = `${today}-${config.tier}-${slot}`;
      tickets.push({
        id: ticketId,
        ticket_date: today,
        tier: config.tier,
        slip_label: null,
        match_count: picks.length,
        odds_range: config.oddsRange,
        total_odds: computeTotalOdds(picks),
        is_free: config.alwaysFree,
        release_slot: slot,
        available_at: releaseTimeFor(slot, now),
      });
      picks.forEach((p, idx) => ticketMatches.push({ ticket_id: ticketId, fixture_id: p.fixtureId, sort_order: idx }));
      console.log(`${config.label}: built at rule level "${level.name}" — total odds ${computeTotalOdds(picks)}.`);
      built = true;
      break;
    }

    if (!built) {
      console.warn(`${config.label}: no valid combination even at the most relaxed rule level — no ticket this run.`);
    }
  }

  return { tickets, ticketMatches, fixturesUsed: Array.from(fixturesUsed.values()) };
}

// --- Main ---------------------------------------------------------------------

async function main() {
  const today = new Date();
  const todayStr = dateStr(today);
  const supabase = getSupabaseAdmin();

  console.log("Checking today's existing slips (staggered-release state)...");
  const slipState = await fetchTodaysSlipState(supabase, todayStr);

  const anySlotAvailable = TIER_CONFIG.some((c) => nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get(c.tier)) !== null);
  if (!anySlotAvailable) {
    console.log("Every category is already at today's cap, or within the min-gap window — nothing to do this run.");
    return;
  }

  console.log('Fetching daily fixture pool...');
  const dailyPool = await fetchPricedFixtures([todayStr], MAX_ODDS_LOOKUPS_PER_RUN, today);
  console.log(`Priced ${dailyPool.length} qualifying fixtures for today.`);

  const existingMarkets = await fetchExistingMarkets(supabase, dailyPool.map((p) => p.fixtureId));

  const excludeFromSaintsLock = await fetchTodaysSaintsLockFixtureIds(supabase, todayStr);

  const { tickets, ticketMatches, fixturesUsed } = buildTickets(dailyPool, slipState, today, excludeFromSaintsLock, existingMarkets);

  if (tickets.length === 0) {
    console.warn('No tickets could be assembled this run — nothing written.');
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
  const { error: linksErr } = await supabase.from('ticket_matches').upsert(ticketMatches, { onConflict: 'ticket_id,fixture_id' });
  if (linksErr) throw linksErr;

  console.log(`Wrote ${tickets.length} new ticket(s), ${fixtureRows.length} fixture(s). Previous slips today are untouched.`);
}

export { buildTickets, pickCombo, marketAllowedAt, chooseBookmaker, fetchPricedFixtures, RELAXATION_LEVELS };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
