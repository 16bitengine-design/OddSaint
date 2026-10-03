// ---------------------------------------------------------------------------
// Odd Saint — ticket generation (Mega Day, Duo, Saint's Lock ONLY)
//
// Runs twice a day via .github/workflows/generate-tickets.yml (03:00 and
// 10:00 UTC). Each tier can release up to 2 tickets per day, at least
// MIN_HOURS_BETWEEN_SLOTS apart, each becoming visible AVAILABILITY_DELAY_MS
// after generation.
//
// WHAT CHANGED vs the previous version (accuracy work):
//   1. CONFIDENCE IS NOW A REAL PROBABILITY. Previously confidence was
//      100/odds from ONE bookmaker, which still contains that bookmaker's
//      margin (a "75%" pick was really ~70%). Now every bookmaker's prices
//      are devigged separately (proportional method) and the fair
//      probabilities are averaged across bookmakers. Displayed odds are the
//      MEDIAN QUOTED odds (what a user could actually get), not fair odds.
//   2. THIN / DISAGREEING MARKETS ARE SKIPPED: fewer than MIN_BOOKMAKERS
//      pricing an outcome, or bookmakers disagreeing by more than
//      MAX_BOOKMAKER_SPREAD, means the fixture/outcome is not used.
//   3. THE POISSON MODEL CAN VETO A PICK. If scripts/lib/teamModel.mjs has an
//      opinion and it is more than MODEL_MAX_DISAGREEMENT below the market's
//      fair probability, the outcome is dropped. No model opinion (thin
//      history) never blocks a pick — it just isn't a second opinion.
//   4. TICKETS ARE CHOSEN BY BEST JOINT PROBABILITY, not "greedy safest
//      first": every valid leg combination inside the tier's odds band is
//      scored by the product of its legs' fair probabilities.
//   5. A FIXTURE APPEARS IN AT MOST ONE TICKET PER DAY (across all tiers and
//      both slots), so a single upset can't sink several tickets at once.
//      This also guarantees a fixture's stored market is never overwritten
//      by a later run.
//   6. NO SOUTH AMERICAN LEAGUES, NO WOMEN'S COMPETITIONS, no youth/reserve/
//      lower-division leagues (shared filters), min 2h to kickoff.
//
// HONEST SCOPE NOTE: this is still bookmaker-consensus selection plus a
// Poisson veto — NOT a trained model. Inside Saint's Lock's 1.48-2.00 odds
// band the true win chance of ANY pick is roughly 50-67%; no filter can make
// it "almost certain". Never describe it as such.
//
// confidence stored in `fixtures.confidence` is now round(fairProb * 100),
// which runs lower than the old 100/odds figure. scripts/analyze-performance
// .mjs bands and self-tune.mjs thresholds (built for the old scale) will need
// re-baselining once new graded results accumulate.
// ---------------------------------------------------------------------------
import { getFixturesForDate, getOddsForFixture } from './lib/apiFootball.mjs';
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { MARKET_CATALOG } from './lib/markets.mjs';
import { isAmateurOrYouthLeague } from './lib/leagueQuality.mjs';
import { isWomensCompetition } from './lib/womensLeagueFilter.mjs';
import { getOwnModelForFixture } from './lib/teamModel.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEAGUES_JSON_PATH = join(__dirname, 'lib', 'leagues.json');

// --- Config -----------------------------------------------------------------

const TIER_CONFIG = {
  mega: { tier: 'mega', label: 'Mega Day Ticket', maxLegs: 4, oddsRange: '1.5-3', alwaysFree: true },
  duo: { tier: 'duo', label: 'Duo', maxLegs: 2, oddsRange: '2-4', alwaysFree: false },
  saints_lock: { tier: 'saints_lock', label: "Saint's Lock", maxLegs: 1, oddsRange: '1.48-2', alwaysFree: false },
};
const TIERS = Object.keys(TIER_CONFIG);

// --- Odds bands (cumulative ticket odds, built from QUOTED median odds) -----
const MEGA_ODDS_RANGE = [1.5, 3];
const DUO_ODDS_RANGE = [2, 4];
// Product rule: Saint's Lock odds stay between 1.48 and 2.0.
const SAINTS_LOCK_MIN_ODDS = 1.48;
const SAINTS_LOCK_MAX_ODDS = 2.0;

// --- Probability floors (devigged consensus fair probability, 0-1) ----------
// Within Saint's Lock's odds band the fair probability can only be about
// 0.48-0.66, so a floor above ~0.66 would make it impossible to ever publish.
// 0.60 keeps it to the shorter end of the band (roughly odds <= ~1.57).
const GLOBAL_MIN_FAIR_PROB = 0.45; // anything below this is never a candidate
const SAINTS_LOCK_MIN_FAIR_PROB = 0.6;
const MEGA_MIN_LEG_FAIR_PROB = 0.72;
const DUO_MIN_LEG_FAIR_PROB = 0.55;

// Product rule says "minimum 1 Saint's Lock a day". If nothing clears
// SAINTS_LOCK_MIN_FAIR_PROB on the first slot, true would relax to the best
// fixture inside the odds band. Default false: skipping a day beats shipping
// a pick we don't believe in. Flip to true to restore the old guarantee.
const ALLOW_SAINTS_LOCK_FALLBACK = false;

// Mega: fewer legs = less compounded margin and fewer ways to lose. 3 keeps
// it recognisably a "Mega"; set to 2 for the highest hit rate.
const MEGA_MIN_LEGS = 3;
const MEGA_MAX_LEGS = 4;

// --- Market-quality gates ----------------------------------------------------
const MIN_BOOKMAKERS = 3; // bookmakers that must price an outcome
const MAX_BOOKMAKER_SPREAD = 0.08; // max-min fair probability across bookmakers
const MODEL_MAX_DISAGREEMENT = 0.12; // model may sit at most this far below the market
const COMBO_POOL_SIZE_MEGA = 16;
const COMBO_POOL_SIZE_DUO = 30;

// --- Pipeline limits ---------------------------------------------------------
const MAX_ODDS_LOOKUPS_PER_RUN = 200;
const PER_LEAGUE_LOOKUPS_PER_ROUND = 3;
const MAX_TICKETS_PER_CATEGORY = 2;
const MIN_HOURS_BETWEEN_SLOTS = 6;
const AVAILABILITY_DELAY_MS = 60 * 60 * 1000; // 1 hour; matches RELEASE_SLOT_HOURS_UTC in dataFetcher.ts
const MIN_HOURS_TO_KICKOFF = 2;
const MODEL_CHECK_CONCURRENCY = 10;

// --- Leagues -----------------------------------------------------------------

const DEFAULT_LEAGUE_ALLOWLIST = new Set([39, 140, 135, 78, 61, 2, 3, 88]);

function loadLeagueAllowlist() {
  try {
    const leagues = JSON.parse(readFileSync(LEAGUES_JSON_PATH, 'utf8'));
    if (Array.isArray(leagues) && leagues.length > 0) {
      console.log(`Loaded ${leagues.length} resolved league(s) from leagues.json.`);
      return new Set(leagues.map((l) => l.id));
    }
  } catch {
    // fall through to default
  }
  console.log('leagues.json not found — using the small built-in default league set.');
  return DEFAULT_LEAGUE_ALLOWLIST;
}

const LEAGUE_ALLOWLIST = loadLeagueAllowlist();

const PRIORITY_LEAGUE_NAMES = new Set([
  'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1',
  'UEFA Champions League', 'UEFA Europa League', 'Eredivisie',
  'Scottish Premiership', 'Austrian Bundesliga', 'Swiss Super League',
  'Turkish Super Lig', 'Jupiler Pro League', 'Superligaen', 'Eliteserien',
]);

// Product rule: no ticket may include a fixture from any South American league.
const SOUTH_AMERICAN_COUNTRIES = new Set([
  'Brazil', 'Argentina', 'Uruguay', 'Chile', 'Colombia', 'Peru', 'Ecuador',
  'Paraguay', 'Bolivia', 'Venezuela', 'Guyana', 'Suriname',
]);
const SOUTH_AMERICAN_COMPETITION_PATTERN = /libertadores|sudamericana|sul-?americana|conmebol/i;

function isSouthAmericanFixture(f) {
  return (
    SOUTH_AMERICAN_COUNTRIES.has(f.league?.country) ||
    SOUTH_AMERICAN_COMPETITION_PATTERN.test(f.league?.name ?? '')
  );
}

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

function hasMinimumLeadTime(kickoffISO, now) {
  if (!kickoffISO) return false;
  return new Date(kickoffISO).getTime() - now.getTime() >= MIN_HOURS_TO_KICKOFF * 60 * 60 * 1000;
}

// --- Small helpers -------------------------------------------------------------

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function product(values) {
  return values.reduce((a, b) => a * b, 1);
}

function* combinations(items, k, start = 0, prefix = []) {
  if (prefix.length === k) {
    yield prefix;
    return;
  }
  for (let i = start; i < items.length; i++) {
    yield* combinations(items, k, i + 1, [...prefix, items[i]]);
  }
}

// --- Consensus, vig-corrected pricing -----------------------------------------

const OUTCOME_BANDS = new Map(); // marketLabel -> { oddsMin, oddsMax }
MARKET_CATALOG.forEach((bet) =>
  bet.outcomes.forEach((o) => OUTCOME_BANDS.set(o.marketLabel, { oddsMin: o.oddsMin, oddsMax: o.oddsMax }))
);

function parseOdd(entry) {
  const n = parseFloat(entry?.odd);
  return Number.isFinite(n) && n > 1 ? n : null;
}

/**
 * Devigs ONE bookmaker's prices. Returns Map<marketLabel, { fairProb, odds }>
 * for every catalog outcome whose full market group that bookmaker priced
 * (an incomplete group can't be devigged, so it's skipped, never guessed).
 */
function bookmakerFairProbs(bets) {
  const out = new Map();
  const getBet = (name) => bets?.find((b) => b.name === name);
  const val = (bet, apiValue) => parseOdd(bet?.values?.find((v) => v.value === apiValue));
  const add = (label, fairProb, odds) => {
    if (OUTCOME_BANDS.has(label)) out.set(label, { fairProb, odds });
  };

  const mw = getBet('Match Winner');
  if (mw) {
    const h = val(mw, 'Home');
    const d = val(mw, 'Draw');
    const a = val(mw, 'Away');
    if (h && d && a) {
      const sum = 1 / h + 1 / d + 1 / a;
      add('Home Win', 1 / h / sum, h);
      add('Away Win', 1 / a / sum, a);
    }
  }

  const ou = getBet('Goals Over/Under');
  if (ou) {
    for (const line of ['1.5', '2.5', '3.5']) {
      const over = val(ou, `Over ${line}`);
      const under = val(ou, `Under ${line}`);
      if (!over || !under) continue;
      const sum = 1 / over + 1 / under;
      add(`Over ${line} Goals`, 1 / over / sum, over);
      add(`Under ${line} Goals`, 1 / under / sum, under);
    }
  }

  const btts = getBet('Both Teams Score');
  if (btts) {
    const yes = val(btts, 'Yes');
    const no = val(btts, 'No');
    if (yes && no) {
      const sum = 1 / yes + 1 / no;
      add('BTTS - Yes', 1 / yes / sum, yes);
      add('BTTS - No', 1 / no / sum, no);
    }
  }

  const dc = getBet('Double Chance');
  if (dc) {
    const x1 = val(dc, 'Home/Draw');
    const x2 = val(dc, 'Draw/Away');
    const x12 = val(dc, 'Home/Away');
    if (x1 && x2 && x12) {
      // The three double-chance outcomes cover every result twice, so their
      // fair probabilities sum to 2, not 1.
      const sum = 1 / x1 + 1 / x2 + 1 / x12;
      add('Double Chance 1X', ((1 / x1) / sum) * 2, x1);
      add('Double Chance X2', ((1 / x2) / sum) * 2, x2);
      add('Double Chance 12', ((1 / x12) / sum) * 2, x12);
    }
  }

  return out;
}

/**
 * Averages every bookmaker's devigged fair probability per outcome. Drops
 * outcomes priced by too few bookmakers, where bookmakers disagree too much,
 * or whose median quoted odds fall outside the catalog's own odds band.
 */
function consensusOutcomes(bookmakers) {
  const acc = new Map(); // label -> { probs: [], odds: [] }
  for (const bm of bookmakers ?? []) {
    for (const [label, { fairProb, odds }] of bookmakerFairProbs(bm.bets)) {
      const entry = acc.get(label) ?? { probs: [], odds: [] };
      entry.probs.push(fairProb);
      entry.odds.push(odds);
      acc.set(label, entry);
    }
  }

  const results = [];
  for (const [label, { probs, odds }] of acc) {
    if (probs.length < MIN_BOOKMAKERS) continue;
    if (Math.max(...probs) - Math.min(...probs) > MAX_BOOKMAKER_SPREAD) continue;

    const band = OUTCOME_BANDS.get(label);
    const quoted = median(odds);
    if (quoted < band.oddsMin || quoted > band.oddsMax) continue;

    results.push({
      market: label,
      odds: round2(quoted),
      fairProb: mean(probs),
      bookmakerCount: probs.length,
      modelProbability: null,
      modelAvailable: false,
    });
  }
  return results;
}

// --- Fetch + price fixtures ----------------------------------------------------

async function fetchPricedFixtures(dates, maxOddsLookups, now, usedFixtureIds) {
  const seen = new Map(); // fixtureId -> priced fixture
  let oddsLookupsUsed = 0;
  const stats = { lookups: 0, noOdds: 0, noViableOutcome: 0, priced: 0 };
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
        f.fixture?.status?.short === 'NS' && // not started
        !usedFixtureIds.has(f.fixture?.id) &&
        LEAGUE_ALLOWLIST.has(f.league?.id) &&
        !isAmateurOrYouthLeague(f.league?.name) &&
        !isWomensCompetition(f.league?.name) &&
        !isSouthAmericanFixture(f) &&
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

    // Round-robin odds lookups so one busy league can't eat the whole budget.
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
          stats.lookups++;
          let oddsResponse;
          try {
            oddsResponse = await getOddsForFixture(fixtureId);
          } catch (err) {
            console.warn(`Odds lookup failed for fixture ${fixtureId}:`, err.message);
            continue;
          }

          const bookmakers = oddsResponse?.[0]?.bookmakers;
          if (!bookmakers || bookmakers.length === 0) {
            stats.noOdds++;
            continue;
          }

          const outcomes = consensusOutcomes(bookmakers).filter((o) => o.fairProb >= GLOBAL_MIN_FAIR_PROB);
          if (outcomes.length === 0) {
            stats.noViableOutcome++;
            continue;
          }

          seen.set(fixtureId, {
            fixtureId,
            ticketDate: dateStr(now),
            league: f.league?.name ?? 'Unknown League',
            country: f.league?.country ?? 'Unknown',
            homeTeam: f.teams?.home?.name ?? 'Home',
            awayTeam: f.teams?.away?.name ?? 'Away',
            homeTeamId: f.teams?.home?.id ?? null,
            awayTeamId: f.teams?.away?.id ?? null,
            kickoff: f.fixture?.date,
            outcomes,
          });
          stats.priced++;
          leagueBreakdown.set(leagueName, (leagueBreakdown.get(leagueName) ?? 0) + 1);
        }
      }
    }
  }

  console.log(
    `Odds lookups: ${stats.lookups} | no odds: ${stats.noOdds} | no outcome cleared the market-quality gates: ` +
      `${stats.noViableOutcome} | priced: ${stats.priced}`
  );
  if (leagueBreakdown.size > 0) {
    console.log(
      'Priced fixtures by league: ' +
        Array.from(leagueBreakdown.entries()).map(([n, c]) => `${n}: ${c}`).join(', ')
    );
  }

  return Array.from(seen.values());
}

// --- Poisson model veto -----------------------------------------------------------

/**
 * Drops any outcome the first-party Poisson model rates clearly lower than
 * the bookmaker consensus. Fixtures without enough team history keep all
 * their outcomes (modelAvailable = false) — absence of a model opinion is
 * never treated as disagreement.
 */
async function applyModelVeto(supabase, pool) {
  let vetoed = 0;
  let withModel = 0;

  for (let i = 0; i < pool.length; i += MODEL_CHECK_CONCURRENCY) {
    const chunk = pool.slice(i, i + MODEL_CHECK_CONCURRENCY);
    await Promise.all(
      chunk.map(async (fx) => {
        let model;
        try {
          model = await getOwnModelForFixture(supabase, {
            league: fx.league,
            homeTeamId: fx.homeTeamId,
            awayTeamId: fx.awayTeamId,
            homeTeamName: fx.homeTeam,
            awayTeamName: fx.awayTeam,
          });
        } catch (err) {
          model = { available: false };
        }

        if (model?.available) withModel++;

        fx.outcomes = fx.outcomes.flatMap((o) => {
          const mp = model?.available ? model.probabilities?.[o.market] : undefined;
          if (typeof mp !== 'number' || !Number.isFinite(mp)) return [o];
          if (mp < o.fairProb - MODEL_MAX_DISAGREEMENT) {
            vetoed++;
            return [];
          }
          return [{ ...o, modelProbability: mp, modelAvailable: true }];
        });
      })
    );
  }

  console.log(`Model check: opinion available for ${withModel}/${pool.length} fixture(s); vetoed ${vetoed} outcome(s).`);
  return pool.filter((fx) => fx.outcomes.length > 0);
}

// --- Selection ----------------------------------------------------------------------

function bestOutcomeFor(fx, predicate) {
  const ok = fx.outcomes.filter(predicate);
  if (ok.length === 0) return null;
  return ok.sort((a, b) => b.fairProb - a.fairProb)[0];
}

function bestCombo(candidates, sizes, [minTotal, maxTotal], requireDistinctFixtures) {
  let best = null;
  for (const k of sizes) {
    if (candidates.length < k) continue;
    for (const combo of combinations(candidates, k)) {
      if (requireDistinctFixtures && new Set(combo.map((c) => c.fx.fixtureId)).size !== k) continue;
      const total = product(combo.map((c) => c.o.odds));
      if (total < minTotal || total > maxTotal) continue;
      const prob = product(combo.map((c) => c.o.fairProb));
      if (!best || prob > best.prob) best = { combo, total: round2(total), prob };
    }
  }
  return best;
}

/** Saint's Lock: single highest-fair-probability outcome with quoted odds in [1.48, 2.0]. */
function pickSaintsLock(pool, usedFixtureIds, slot) {
  const inBand = [];
  for (const fx of pool) {
    if (usedFixtureIds.has(fx.fixtureId)) continue;
    for (const o of fx.outcomes) {
      if (o.odds >= SAINTS_LOCK_MIN_ODDS && o.odds <= SAINTS_LOCK_MAX_ODDS) inBand.push({ fx, o });
    }
  }
  inBand.sort((a, b) => b.o.fairProb - a.o.fairProb);

  const strict = inBand.find((c) => c.o.fairProb >= SAINTS_LOCK_MIN_FAIR_PROB);
  if (strict) return strict;

  if (ALLOW_SAINTS_LOCK_FALLBACK && slot === 0 && inBand.length > 0) {
    console.warn(
      `Saint's Lock: nothing cleared ${SAINTS_LOCK_MIN_FAIR_PROB * 100}% fair probability — using best in-band ` +
        `(${Math.round(inBand[0].o.fairProb * 100)}%) per ALLOW_SAINTS_LOCK_FALLBACK.`
    );
    return inBand[0];
  }
  return null;
}

/** Mega: best joint-probability set of MEGA_MIN_LEGS..MEGA_MAX_LEGS legs, one outcome per fixture, total odds in range. */
function pickMega(pool, usedFixtureIds) {
  const candidates = [];
  for (const fx of pool) {
    if (usedFixtureIds.has(fx.fixtureId)) continue;
    const o = bestOutcomeFor(fx, (x) => x.fairProb >= MEGA_MIN_LEG_FAIR_PROB);
    if (o) candidates.push({ fx, o });
  }
  candidates.sort((a, b) => b.o.fairProb - a.o.fairProb);
  const top = candidates.slice(0, COMBO_POOL_SIZE_MEGA);

  const sizes = [];
  for (let k = MEGA_MIN_LEGS; k <= MEGA_MAX_LEGS; k++) sizes.push(k);
  return bestCombo(top, sizes, MEGA_ODDS_RANGE, true);
}

/** Duo: best joint-probability pair from two different fixtures, total odds in range. */
function pickDuo(pool, usedFixtureIds) {
  const candidates = [];
  for (const fx of pool) {
    if (usedFixtureIds.has(fx.fixtureId)) continue;
    fx.outcomes
      .filter((o) => o.fairProb >= DUO_MIN_LEG_FAIR_PROB)
      .sort((a, b) => b.fairProb - a.fairProb)
      .slice(0, 2)
      .forEach((o) => candidates.push({ fx, o }));
  }
  candidates.sort((a, b) => b.o.fairProb - a.o.fairProb);
  const top = candidates.slice(0, COMBO_POOL_SIZE_DUO);
  return bestCombo(top, [2], DUO_ODDS_RANGE, true);
}

// --- Staggered release state ----------------------------------------------------------

async function fetchTodaysState(supabase, today) {
  const { data: ticketRows, error: ticketErr } = await supabase
    .from('tickets')
    .select('id, tier, available_at, ticket_matches ( fixture_id )')
    .eq('ticket_date', today);
  if (ticketErr) throw ticketErr;

  const { data: fixtureRows, error: fixtureErr } = await supabase.from('fixtures').select('id').eq('ticket_date', today);
  if (fixtureErr) throw fixtureErr;

  const byTier = new Map(); // tier -> { count, lastAvailableAt }
  const usedFixtureIds = new Set((fixtureRows ?? []).map((r) => r.id));

  (ticketRows ?? []).forEach((row) => {
    const existing = byTier.get(row.tier) ?? { count: 0, lastAvailableAt: null };
    existing.count += 1;
    if (!existing.lastAvailableAt || row.available_at > existing.lastAvailableAt) {
      existing.lastAvailableAt = row.available_at;
    }
    byTier.set(row.tier, existing);
    (row.ticket_matches ?? []).forEach((tm) => usedFixtureIds.add(tm.fixture_id));
  });

  return { byTier, usedFixtureIds };
}

function nextSlotFor(slipState) {
  const state = slipState ?? { count: 0, lastAvailableAt: null };
  if (state.count >= MAX_TICKETS_PER_CATEGORY) return null;
  if (state.count === 0) return 0;
  // available_at = generation time + AVAILABILITY_DELAY_MS — recover the real generation time first.
  const lastGeneratedAtMs = new Date(state.lastAvailableAt).getTime() - AVAILABILITY_DELAY_MS;
  const hoursSinceLast = (Date.now() - lastGeneratedAtMs) / 3_600_000;
  if (hoursSinceLast < MIN_HOURS_BETWEEN_SLOTS) return null;
  return state.count;
}

// --- Ticket assembly ---------------------------------------------------------------------

function buildTicketRecords({ tier, slot, today, availableAtIso, legs, totalOdds }) {
  const config = TIER_CONFIG[tier];
  const ticketId = `${today}-${tier}-${slot}`;

  return {
    ticket: {
      id: ticketId,
      ticket_date: today,
      tier,
      slip_label: null,
      match_count: legs.length,
      odds_range: config.oddsRange,
      total_odds: totalOdds,
      is_free: config.alwaysFree,
      release_slot: slot,
      available_at: availableAtIso,
    },
    links: legs.map((leg, idx) => ({ ticket_id: ticketId, fixture_id: leg.fx.fixtureId, sort_order: idx })),
    fixtureRows: legs.map(({ fx, o }) => {
      const base = {
        id: fx.fixtureId,
        ticket_date: fx.ticketDate,
        league: fx.league,
        country: fx.country,
        home_team: fx.homeTeam,
        away_team: fx.awayTeam,
        kickoff: fx.kickoff,
        market: o.market,
        odds: o.odds,
        confidence: Math.min(100, Math.max(0, Math.round(o.fairProb * 100))),
      };
      return {
        base,
        extended: {
          ...base,
          model_probability: o.modelProbability,
          model_available: o.modelAvailable,
          bookmaker_count: o.bookmakerCount,
        },
      };
    }),
  };
}

function isMissingColumnError(error) {
  return error?.code === 'PGRST204' || error?.code === '42703' || /column/i.test(error?.message ?? '');
}

async function upsertFixtures(supabase, rows) {
  const { error } = await supabase.from('fixtures').upsert(rows.map((r) => r.extended), { onConflict: 'id' });
  if (!error) return;

  if (isMissingColumnError(error)) {
    console.warn(
      'fixtures upsert failed on an optional column (model_probability / model_available / bookmaker_count) — ' +
        `retrying with base columns only. Apply the self-improvement/consensus migrations to keep that data. (${error.message})`
    );
    const { error: retryErr } = await supabase.from('fixtures').upsert(rows.map((r) => r.base), { onConflict: 'id' });
    if (retryErr) throw retryErr;
    return;
  }
  throw error;
}

// --- Main ------------------------------------------------------------------------------------

async function main() {
  const now = new Date();
  const today = dateStr(now);
  const availableAtIso = new Date(now.getTime() + AVAILABILITY_DELAY_MS).toISOString();
  const supabase = getSupabaseAdmin();

  console.log("Checking today's existing tickets (staggered-release state)...");
  const { byTier, usedFixtureIds } = await fetchTodaysState(supabase, today);

  const slots = Object.fromEntries(TIERS.map((tier) => [tier, nextSlotFor(byTier.get(tier))]));
  TIERS.forEach((tier) => {
    if (slots[tier] === null) {
      console.log(`${TIER_CONFIG[tier].label}: already at today's cap, or too soon since the last slip — skipping this run.`);
    }
  });
  if (TIERS.every((tier) => slots[tier] === null)) {
    console.log("Every tier is already at today's cap or within the min-gap window — nothing to do this run.");
    return;
  }

  console.log('Fetching and pricing today\'s fixtures...');
  let pool = await fetchPricedFixtures([today], MAX_ODDS_LOOKUPS_PER_RUN, now, usedFixtureIds);
  console.log(`${pool.length} fixture(s) cleared the consensus-pricing gates.`);

  pool = await applyModelVeto(supabase, pool);
  console.log(`${pool.length} fixture(s) remain after the model check.`);

  const claimed = new Set(usedFixtureIds); // grows as tickets claim fixtures this run
  const allTickets = [];
  const allLinks = [];
  const allFixtureRows = [];

  const claim = (records, legs) => {
    legs.forEach((l) => claimed.add(l.fx.fixtureId));
    allTickets.push(records.ticket);
    allLinks.push(...records.links);
    allFixtureRows.push(...records.fixtureRows);
  };

  // Order matters: Saint's Lock gets first claim on fixtures, then Mega, then Duo.
  if (slots.saints_lock !== null) {
    const pick = pickSaintsLock(pool, claimed, slots.saints_lock);
    if (pick) {
      const legs = [pick];
      claim(
        buildTicketRecords({ tier: 'saints_lock', slot: slots.saints_lock, today, availableAtIso, legs, totalOdds: pick.o.odds }),
        legs
      );
      console.log(
        `Saint's Lock: ${pick.fx.homeTeam} vs ${pick.fx.awayTeam} — ${pick.o.market} @ ${pick.o.odds} ` +
          `(fair ${Math.round(pick.o.fairProb * 100)}%, ${pick.o.bookmakerCount} bookmakers).`
      );
    } else {
      console.log("Saint's Lock: nothing cleared the bar this run — skipping rather than forcing a pick.");
    }
  }

  if (slots.mega !== null) {
    const result = pickMega(pool, claimed);
    if (result) {
      claim(
        buildTicketRecords({ tier: 'mega', slot: slots.mega, today, availableAtIso, legs: result.combo, totalOdds: result.total }),
        result.combo
      );
      console.log(`Mega Day: ${result.combo.length} legs, total ${result.total}x, joint fair probability ${Math.round(result.prob * 100)}%.`);
    } else {
      console.log("Mega Day: couldn't assemble a valid combination this run — skipping.");
    }
  }

  if (slots.duo !== null) {
    const result = pickDuo(pool, claimed);
    if (result) {
      claim(
        buildTicketRecords({ tier: 'duo', slot: slots.duo, today, availableAtIso, legs: result.combo, totalOdds: result.total }),
        result.combo
      );
      console.log(`Duo: 2 legs, total ${result.total}x, joint fair probability ${Math.round(result.prob * 100)}%.`);
    } else {
      console.log("Duo: couldn't assemble a valid pair this run — skipping.");
    }
  }

  if (allTickets.length === 0) {
    console.warn('No tickets could be assembled this run. Nothing written.');
    return;
  }

  await upsertFixtures(supabase, allFixtureRows);

  const { error: ticketsErr } = await supabase.from('tickets').upsert(allTickets, { onConflict: 'id' });
  if (ticketsErr) throw ticketsErr;

  const { error: linksErr } = await supabase.from('ticket_matches').upsert(allLinks, { onConflict: 'ticket_id,fixture_id' });
  if (linksErr) throw linksErr;

  console.log(
    `Wrote ${allTickets.length} new ticket(s) and ${allFixtureRows.length} fixture(s). ` +
      'Earlier slips today are untouched and remain visible.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
