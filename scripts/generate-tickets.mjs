// ---------------------------------------------------------------------------
// Odd Saint — daily ticket generation (Mega Day, Duo, Saint's Lock ONLY)
//
// Pulls real fixtures + bookmaker odds from API-Football, builds the three
// remaining tiers, and writes them to Supabase. Runs twice a day via
// .github/workflows/generate-tickets.yml (03:00 and 09:00 UTC) so each tier
// releases in up to two staggered slots — see nextSlotFor.
//
// PRODUCT RULES ENFORCED HERE
//   Tiers: mega, duo, saints_lock. Everything else is eliminated.
//   Leagues: no South American competitions, no youth/reserve/lower-division,
//            no women's competitions.
//   Direct win (Home/Away Win), any ticket: the BACKED team must sit at
//            least MIN_RANK_GAP places above its opponent in the league
//            table AND have >= MIN_WINS_LAST_5 wins in its last 5 league
//            matches. The opponent having <= 2 wins is PREFERRED, not
//            required (see opponentPenalty).
//   Over 2.5 Goals, any ticket: BOTH teams must average >= 2 goals scored
//            over their last 5 finished matches (all competitions).
//   Any other market (Mega/Duo only): no rank/form requirement.
//   Mega Day: any market, cumulative odds in [1.97, 3], up to 4 legs.
//   Duo: any market, exactly 2 legs, cumulative odds in [2, 4].
//   Saint's Lock: ONE match; market must be a direct win or Over 2.5 Goals
//            (never Double Chance); odds 1.48-2.0.
//
// HONEST SCOPE NOTE: "confidence" is a simple function of bookmaker odds
// (implied probability), not a trained model.
// ---------------------------------------------------------------------------
import { getFixturesForDate, getOddsForFixture, getStandings, getFixturesForTeam } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { collectViableOutcomes, FULL_WIN_MARKETS } from './lib/markets.mjs';
import { isAmateurOrYouthLeague } from './lib/leagueQuality.mjs';
import { isWomensCompetition } from './lib/womensLeagueFilter.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEAGUES_JSON_PATH = join(__dirname, 'lib', 'leagues.json');

// --- Config -----------------------------------------------------------------

const DEFAULT_LEAGUE_ALLOWLIST = new Set([39, 140, 135, 78, 61, 2, 3, 88]);

// South American competitions are excluded everywhere. leagues.json carries a
// `region`, but API-Football's continental cups (Libertadores etc.) come back
// with country "World", so the fixture-level check below also matches names.
const SOUTH_AMERICAN_COUNTRIES = new Set([
  'Brazil', 'Argentina', 'Uruguay', 'Chile', 'Colombia', 'Peru', 'Ecuador', 'Paraguay', 'Bolivia', 'Venezuela',
]);
const SOUTH_AMERICAN_NAME_PATTERN = /conmebol|libertadores|sudamericana|copa am[eé]rica/i;

function isSouthAmericanLeague(league) {
  return SOUTH_AMERICAN_COUNTRIES.has(league?.country) || SOUTH_AMERICAN_NAME_PATTERN.test(league?.name ?? '');
}

function loadLeagueAllowlist() {
  try {
    const leagues = JSON.parse(readFileSync(LEAGUES_JSON_PATH, 'utf8'));
    if (Array.isArray(leagues) && leagues.length > 0) {
      const usable = leagues.filter((l) => l.region !== 'South America');
      console.log(`Loaded ${usable.length} league(s) from leagues.json (South America excluded).`);
      return new Set(usable.map((l) => l.id));
    }
  } catch {
    // leagues.json missing/invalid — fall back below.
  }
  console.log('leagues.json not found — using the small built-in default league set.');
  return DEFAULT_LEAGUE_ALLOWLIST;
}

const LEAGUE_ALLOWLIST = loadLeagueAllowlist();

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
  { tier: 'mega', label: 'Mega Day Ticket', matchCount: 4, oddsRange: '1.97-3', alwaysFree: true },
  { tier: 'duo', label: 'Duo', matchCount: 2, oddsRange: '2-4', alwaysFree: false },
  { tier: 'saints_lock', label: "Saint's Lock", matchCount: 1, oddsRange: '1.48-2', alwaysFree: false },
];

// Cumulative-odds targets, ENFORCED in slip assembly. The lower bound of each
// is a HARD floor (no tolerance below it); only the upper side has slack.
const TIER_ODDS_TARGET = {
  mega: [1.97, 3],
  duo: [2, 4],
};
const MIN_CUMULATIVE_ODDS = { mega: 1.97, duo: 1.97 };
const UPPER_TOLERANCE = 0.3;

// Per-tier confidence floor (confidence = 100/odds, clipped to 55-95, so 68
// means odds of about 1.48 or shorter). Duo needs two legs whose product is
// at least 2 (average leg >= ~1.41), which a 68 floor makes almost impossible —
// so Duo has its own, lower floor (58 = legs up to about 1.72).
const TIER_MIN_CONFIDENCE = { mega: 68, duo: 58 };

// Saint's Lock
const SAINTS_LOCK_ODDS_MIN = 1.48;
const SAINTS_LOCK_ODDS_MAX = 2.0;
const SAINTS_LOCK_MARKETS = new Set(['Home Win', 'Away Win', 'Over 2.5 Goals']);

// Strength rules
const MIN_RANK_GAP = 4;
const MIN_GAMES_PLAYED = 5; // early-season tables are meaningless
const MIN_WINS_LAST_5 = 3; // backed team (hard)
const OPPONENT_MAX_WINS_LAST_5 = 2; // opponent (preference only)
const MIN_AVG_GOALS_FOR_OVER_25 = 2; // each team, last 5 matches

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

// --- Strength rules: standings, form, goals ----------------------------------

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);
const standingsCache = new Map(); // `${leagueId}-${season}` -> Map(teamId -> { rank, played, form }) | null
const goalsCache = new Map(); // teamId -> average goals scored over last 5, or null

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
 * Direct-win eligibility. Backed team = the better-placed side. Hard rules:
 * rank gap >= MIN_RANK_GAP, >= MIN_WINS_LAST_5 wins in its last 5 (league
 * form string). opponentPenalty is 0 when the opponent has <= 2 wins in its
 * last 5, else 1 — a PREFERENCE used only to order selection.
 */
async function winAssessment(f) {
  const none = { eligible: false, favoured: null, opponentPenalty: 0 };
  const table = await loadStandings(f.league?.id, f.league?.season);
  if (!table) return none;
  const home = table.get(f.teams?.home?.id);
  const away = table.get(f.teams?.away?.id);
  if (!home || !away) return none;
  if (home.played < MIN_GAMES_PLAYED || away.played < MIN_GAMES_PLAYED) return none;
  if (Math.abs(home.rank - away.rank) < MIN_RANK_GAP) return none;

  const favoured = home.rank < away.rank ? 'home' : 'away';
  const backed = favoured === 'home' ? home : away;
  const opponent = favoured === 'home' ? away : home;

  const backedWins = winsInLast5(backed.form);
  if (backedWins === null || backedWins < MIN_WINS_LAST_5) return none;

  const oppWins = winsInLast5(opponent.form);
  const opponentPenalty = oppWins !== null && oppWins <= OPPONENT_MAX_WINS_LAST_5 ? 0 : 1;
  return { eligible: true, favoured, opponentPenalty };
}

async function avgGoalsLast5(teamId) {
  if (goalsCache.has(teamId)) return goalsCache.get(teamId);
  let avg = null;
  try {
    const fixtures = await getFixturesForTeam(teamId, 5);
    const goals = [];
    for (const m of fixtures ?? []) {
      if (!FINISHED_STATUSES.has(m.fixture?.status?.short)) continue;
      const hg = m.goals?.home;
      const ag = m.goals?.away;
      if (hg == null || ag == null) continue;
      goals.push(m.teams?.home?.id === teamId ? hg : ag);
    }
    if (goals.length === 5) avg = goals.reduce((s, g) => s + g, 0) / 5;
  } catch (err) {
    console.warn(`Last-5 goals unavailable for team ${teamId}:`, err.message);
  }
  goalsCache.set(teamId, avg);
  return avg;
}

/** True only if BOTH teams averaged >= 2 goals scored over their last 5 finished matches. */
async function over25Eligible(f) {
  const [h, a] = await Promise.all([avgGoalsLast5(f.teams?.home?.id), avgGoalsLast5(f.teams?.away?.id)]);
  return h !== null && a !== null && h >= MIN_AVG_GOALS_FOR_OVER_25 && a >= MIN_AVG_GOALS_FOR_OVER_25;
}

/**
 * Is this outcome allowed for this fixture? Wins need the win assessment
 * AND must back the better-placed side. Over 2.5 needs the goals rule.
 * Other markets are unrestricted on Mega/Duo and forbidden for Saint's Lock.
 */
function marketAllowed(outcome, win, canOver25, saintsLockOnly) {
  if (outcome.market === 'Over 2.5 Goals') return canOver25;
  if (outcome.market === 'Home Win') return !!win?.eligible && win.favoured === 'home';
  if (outcome.market === 'Away Win') return !!win?.eligible && win.favoured === 'away';
  return !saintsLockOnly;
}

// --- Fetch + price fixtures ---------------------------------------------------

function hasMinimumLeadTime(kickoffISO, now) {
  if (!kickoffISO) return false;
  return new Date(kickoffISO).getTime() - now.getTime() >= MIN_HOURS_TO_KICKOFF * 60 * 60 * 1000;
}

const RESULT_BASED_MARKETS = new Set([
  'Home Win', 'Away Win', 'Double Chance 1X', 'Double Chance X2', 'Double Chance 12',
]);
const WIN_MARKET_MIN_ODDS = 1.3;

function impliedConfidence(odds) {
  const raw = Math.round((1 / odds) * 100);
  return Math.min(95, Math.max(55, raw));
}

/**
 * Applies the market rules above to a fixture's bookmaker odds. Returns:
 *   base — the safest ALLOWED market (used by Mega/Duo), and
 *   saintsLockAlternatives — allowed win / Over 2.5 outcomes inside the
 *   Saint's Lock odds band (Saint's Lock picks its own market from these).
 * Returns null if nothing is allowed. Confidence is NOT filtered here — each
 * tier applies its own floor later, so a 1.9-odds Saint's Lock candidate is
 * not discarded by the Mega/Duo confidence floor.
 */
async function pickMarketFromOdds(oddsResponse, f) {
  const bookmaker = oddsResponse?.[0]?.bookmakers?.[0];
  if (!bookmaker) return null;

  const all = collectViableOutcomes(bookmaker.bets);
  if (all.length === 0) return null;

  // Only fetch standings / last-5 goals when an outcome actually needs them.
  const win = all.some((o) => FULL_WIN_MARKETS.has(o.market)) ? await winAssessment(f) : null;
  const canOver25 = all.some((o) => o.market === 'Over 2.5 Goals') ? await over25Eligible(f) : false;

  const allowed = all.filter((o) => marketAllowed(o, win, canOver25, false));
  if (allowed.length === 0) return null;

  const sorted = [...allowed].sort((a, b) => a.odds - b.odds);
  let chosen = sorted[0];
  if (RESULT_BASED_MARKETS.has(chosen.market) && chosen.odds < WIN_MARKET_MIN_ODDS) {
    const goalsAlt = sorted.find((o) => o.market === 'Over 1.5 Goals' || o.market === 'Over 2.5 Goals');
    if (goalsAlt) chosen = goalsAlt;
    else {
      const nonResult = sorted.find((o) => !RESULT_BASED_MARKETS.has(o.market));
      if (nonResult) chosen = nonResult;
    }
  }

  const saintsLockAlternatives = all
    .filter(
      (o) =>
        SAINTS_LOCK_MARKETS.has(o.market) &&
        marketAllowed(o, win, canOver25, true) &&
        o.odds >= SAINTS_LOCK_ODDS_MIN &&
        o.odds <= SAINTS_LOCK_ODDS_MAX
    )
    .map((o) => ({ market: o.market, odds: o.odds }));

  return {
    market: chosen.market,
    odds: chosen.odds,
    confidence: impliedConfidence(chosen.odds),
    allowedOutcomes: allowed.map((o) => ({ market: o.market, odds: o.odds })),
    saintsLockAlternatives,
    opponentPenalty: win?.opponentPenalty ?? 0,
  };
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
    const eligible = fixtures.filter(
      (f) =>
        LEAGUE_ALLOWLIST.has(f.league?.id) &&
        !isSouthAmericanLeague(f.league) &&
        !isAmateurOrYouthLeague(f.league?.name) &&
        !isWomensCompetition(f.league?.name) &&
        !isBigClash(f.teams?.home?.name, f.teams?.away?.name) &&
        !isExcluded(f.teams?.home?.name, f.teams?.away?.name) &&
        hasMinimumLeadTime(f.fixture?.date, now)
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

          const picked = await pickMarketFromOdds(oddsResponse, f);
          if (!picked) continue;

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
            allowedOutcomes: picked.allowedOutcomes,
            saintsLockAlternatives: picked.saintsLockAlternatives,
            opponentPenalty: picked.opponentPenalty,
            baseUsable: true,
          });
          leagueBreakdown.set(leagueName, (leagueBreakdown.get(leagueName) ?? 0) + 1);
        }
      }
    }
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
    return b.confidence - a.confidence;
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

/** Narrows the pool for a tier: its confidence floor, plus the short-price cap for small tickets. */
function poolForTier(pool, tier) {
  const minConf = TIER_MIN_CONFIDENCE[tier] ?? 0;
  return pool.filter(
    (p) => p.baseUsable && p.confidence >= minConf && (!SMALL_TICKET_TIERS.has(tier) || p.odds <= SMALL_TICKET_MAX_ODDS)
  );
}

/** Keeps at least one outright win leg where the pool allows, without breaking the odds range. Best effort. */
function ensureFullWinLeg(picks, pool, usageCount, targetRange) {
  if (picks.length === 0 || picks.some((p) => FULL_WIN_MARKETS.has(p.market))) return picks;

  const alreadyIn = new Set(picks.map((p) => p.fixtureId));
  const candidates = pool
    .filter(
      (f) =>
        FULL_WIN_MARKETS.has(f.market) &&
        !alreadyIn.has(f.fixtureId) &&
        (usageCount.get(f.fixtureId) ?? 0) < MAX_FIXTURE_APPEARANCES_PER_DAY
    )
    .sort((a, b) => penaltyOf(a) - penaltyOf(b) || a.odds - b.odds);
  if (candidates.length === 0) return picks;

  const candidate = candidates[0];
  const [minTotal, maxTotal] = targetRange;
  const order = [...picks.keys()].sort((a, b) => picks[b].odds - picks[a].odds);
  for (const idx of order) {
    const next = [...picks];
    next[idx] = candidate;
    const total = computeRawOdds(next);
    if (total >= minTotal && total <= maxTotal * (1 + UPPER_TOLERANCE)) return next;
  }
  return picks;
}

/**
 * Mega Day: the FEWEST legs (up to maxMatchCount) whose cumulative odds land
 * in targetRange. The lower bound is a hard floor; opponentPenalty orders
 * legs so fixtures with a weaker opponent are preferred where possible.
 */
function pickFixturesForSlip(pool, maxMatchCount, usageCount, targetRange) {
  const eligible = pool.filter((f) => (usageCount.get(f.fixtureId) ?? 0) < MAX_FIXTURE_APPEARANCES_PER_DAY);
  if (eligible.length === 0) return [];

  const ranked = [...eligible].sort((a, b) => {
    const usedA = usageCount.get(a.fixtureId) ?? 0;
    const usedB = usageCount.get(b.fixtureId) ?? 0;
    if (usedA !== usedB) return usedA - usedB;
    if (penaltyOf(a) !== penaltyOf(b)) return penaltyOf(a) - penaltyOf(b);
    return a.odds - b.odds;
  });

  const [minTotal, maxTotal] = targetRange;
  let picks = [];
  let unused = [...ranked];

  for (const fixture of ranked) {
    if (picks.length >= maxMatchCount) break;
    picks.push(fixture);
    unused = unused.filter((f) => f !== fixture);

    const total = computeRawOdds(picks);
    if (total >= minTotal && total <= maxTotal) return ensureFullWinLeg(picks, pool, usageCount, targetRange);
    if (total > maxTotal) {
      picks.pop();
      unused.unshift(fixture);
      break;
    }
  }

  const MAX_SWAP_ATTEMPTS = 8;
  for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS; attempt++) {
    const total = computeRawOdds(picks);
    if (total >= minTotal && total <= maxTotal) break;

    if (total < minTotal) {
      if (picks.length < maxMatchCount && unused.length > 0) {
        const next = [...unused].sort((a, b) => a.odds - b.odds)[0];
        picks.push(next);
        unused = unused.filter((f) => f !== next);
        continue;
      }
      if (picks.length === 0) break;
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

  const finalTotal = computeRawOdds(picks);
  const ok = picks.length > 0 && finalTotal >= minTotal && finalTotal <= maxTotal * (1 + UPPER_TOLERANCE);
  if (!ok) return [];
  return ensureFullWinLeg(picks, pool, usageCount, targetRange);
}

/**
 * Duo: EXACTLY two different fixtures whose product is inside targetRange.
 * Among valid pairs prefer (1) fewer weak-opponent warnings, (2) less-reused
 * fixtures, (3) the lowest total odds (the safest pair).
 */
function pickDuo(pool, usageCount, targetRange) {
  const [minTotal, maxTotal] = targetRange;
  const eligible = pool.filter((f) => (usageCount.get(f.fixtureId) ?? 0) < MAX_FIXTURE_APPEARANCES_PER_DAY);

  let best = null;
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];
      if (a.fixtureId === b.fixtureId) continue; // two different matches
      const total = a.odds * b.odds;
      if (total < minTotal || total > maxTotal) continue;
      const score = [
        penaltyOf(a) + penaltyOf(b),
        (usageCount.get(a.fixtureId) ?? 0) + (usageCount.get(b.fixtureId) ?? 0),
        total,
      ];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) {
        best = { picks: [a, b], score };
      }
    }
  }
  return best ? best.picks : [];
}

/**
 * Saint's Lock: ONE match. Market is chosen from the fixture's allowed win /
 * Over 2.5 outcomes inside the 1.48-2.0 band (never Double Chance). Order:
 * weak-opponent preference first, then the lowest odds (highest implied
 * confidence). The chosen fixture is made EXCLUSIVE to this ticket so no
 * other ticket reuses it with a different market (the fixtures table stores
 * one market per fixture).
 */
function buildSaintsLockTickets(dailyPool, usageCount, today, slot, now, excludeFixtureIds, existingMarkets) {
  const config = TIER_CONFIG.find((c) => c.tier === 'saints_lock');

  const candidates = dailyPool
    .filter((p) => (usageCount.get(p.fixtureId) ?? 0) < MAX_FIXTURE_APPEARANCES_PER_DAY && !excludeFixtureIds.has(p.fixtureId))
    .flatMap((p) =>
      (p.saintsLockAlternatives ?? [])
        .filter((o) => !existingMarkets.has(p.fixtureId) || existingMarkets.get(p.fixtureId) === o.market)
        .map((o) => ({ ...p, market: o.market, odds: o.odds, confidence: impliedConfidence(o.odds) }))
    )
    .sort((a, b) => penaltyOf(a) - penaltyOf(b) || a.odds - b.odds);

  if (candidates.length === 0) return { tickets: [], ticketMatches: [], fixturesUsed: [] };

  const pick = candidates[0];
  usageCount.set(pick.fixtureId, MAX_FIXTURE_APPEARANCES_PER_DAY); // exclusive to Saint's Lock

  const ticketId = `${today}-saints_lock-${slot}`;
  const availableAtIso = releaseTimeFor(slot, now);

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
        available_at: availableAtIso,
      },
    ],
    ticketMatches: [{ ticket_id: ticketId, fixture_id: pick.fixtureId, sort_order: 0 }],
    fixturesUsed: [pick],
  };
}

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
    if (sl.tickets.length === 0) console.log("Saint's Lock: no fixture met the rules this run — skipping.");
    tickets.push(...sl.tickets);
    ticketMatches.push(...sl.ticketMatches);
    sl.fixturesUsed.forEach((f) => fixturesUsed.set(f.fixtureId, f));
  } else {
    console.log("Saint's Lock: already at today's cap, or too soon since the last slip — skipping this run.");
  }

  for (const config of TIER_CONFIG) {
    if (config.tier === 'saints_lock') continue;

    const slot = nextSlotFor(MAX_TICKETS_PER_CATEGORY, slipState.get(config.tier));
    if (slot === null) {
      console.log(`${config.label}: already at today's cap, or too soon since the last slip — skipping this run.`);
      continue;
    }

    let pool;
    if (config.tier === 'duo') {
      // A Duo needs two legs totalling >= 2, but each fixture's SAFEST market is
      // often ~1.2, so the pair could never reach it. Offer every allowed
      // outcome per fixture instead (the fixtures table holds ONE market per
      // fixture, so skip any that conflict with a market already stored or
      // already chosen for that fixture by a ticket built earlier this run).
      const minConf = TIER_MIN_CONFIDENCE.duo;
      pool = dailyPool.flatMap((p) =>
        (p.allowedOutcomes ?? [])
          .filter((o) => {
            const stored = existingMarkets.get(p.fixtureId);
            const chosen = chosenMarket.get(p.fixtureId);
            return (stored === undefined || stored === o.market) && (chosen === undefined || chosen === o.market);
          })
          .map((o) => ({ ...p, market: o.market, odds: o.odds, confidence: impliedConfidence(o.odds) }))
          .filter((c) => c.confidence >= minConf)
      );
    } else {
      pool = poolForTier(dailyPool, config.tier);
    }
    const targetRange = TIER_ODDS_TARGET[config.tier];
    const picks =
      config.tier === 'duo'
        ? pickDuo(pool, usageCount, targetRange)
        : pickFixturesForSlip(pool, config.matchCount, usageCount, targetRange);

    if (picks.length === 0) {
      console.log(`${config.label}: couldn't assemble a valid combination this run — skipping this slip.`);
      continue;
    }

    // Hard floor on cumulative odds — checked on the UNROUNDED product, and
    // BEFORE the picks are registered as used, so a rejected slip doesn't
    // consume fixtures other tickets could use.
    const rawTotal = computeRawOdds(picks);
    const floor = MIN_CUMULATIVE_ODDS[config.tier];
    if (floor !== undefined && rawTotal < floor) {
      console.log(`${config.label}: best combination was ${rawTotal.toFixed(3)}, below the ${floor} minimum — skipping this slip.`);
      continue;
    }

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
  let dailyPool = await fetchPricedFixtures([todayStr], MAX_ODDS_LOOKUPS_PER_RUN, today);
  console.log(`Priced ${dailyPool.length} qualifying fixtures for today.`);

  const existingMarkets = await fetchExistingMarkets(supabase, dailyPool.map((p) => p.fixtureId));
  dailyPool = dailyPool.map((p) => ({
    ...p,
    baseUsable: !existingMarkets.has(p.fixtureId) || existingMarkets.get(p.fixtureId) === p.market,
  }));

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

export { buildTickets, pickDuo, pickFixturesForSlip, marketAllowed };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
