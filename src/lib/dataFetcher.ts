// ---------------------------------------------------------------------------
// Odd Saint — data layer
// Reads real tickets from Supabase (populated by the GitHub Actions
// pipeline in scripts/generate-tickets.mjs + scripts/grade-tickets.mjs).
// If no real data exists yet for a given day — e.g. before the pipeline's
// first run, or a day it couldn't assemble enough fixtures — this falls
// back to a lightweight, DETERMINISTIC mock generator so the UI never
// breaks. Every mock ticket is seeded from its calendar date + tier + slip
// number, so calling the same day twice always returns identical results.
//
// IMPORTANT: the mock generator's outcome probabilities are PLACEHOLDER
// constants for demo/fallback purposes only — not a real track record.
// Real tickets, once the pipeline is running, use real fixtures, real
// bookmaker-odds-derived confidence, and real graded results instead.
// ---------------------------------------------------------------------------
import { supabase } from './supabaseClient';

export type MatchStatus = 'pending' | 'green' | 'red';


export type TicketTier =
  | 'mega'
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'platinum'
  | 'diamond'
  | 'weekly_lite'
  | 'weekly_titan'
  | 'saints_lock';

export interface Match {
  id: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  market: string; // e.g. "Over 1.5 Goals", "Home Win"
  odds: number;
  kickoff: string; // ISO date string
  status: MatchStatus;
  confidence: number; // AI Data Confidence Index, 0-100 (not a guarantee)
  finalHomeScore?: number; // set once the match has concluded
  finalAwayScore?: number;
}

export interface Ticket {
  id: string;
  tier: TicketTier;
  label: string;
  /** e.g. "2 of 4" when a tier generates multiple slips per day, else undefined */
  slipLabel?: string;
  matchCount: number;
  oddsRange: string;
  totalOdds: number;
  isFree: boolean; // true if permanently free (Mega Day Ticket)
  matches: Match[];
  /** 0 = today's 1st release for this tier, 1 = today's 2nd — see RELEASE_SLOT_HOURS_UTC */
  releaseSlot?: number;
  /** ISO timestamp of when this specific slip was actually released */
  availableAt?: string;
}

export interface TierConfig {
  tier: TicketTier;
  label: string;
  matchCount: number;
  oddsRange: string;
  alwaysFree: boolean;
}

// Tier definitions per the product spec.
//
// Platinum/Diamond/Weekly Lite/Weekly Titan match counts are each ONE
// FEWER than their "standard" size (10/15/20/30) — a deliberate reduction
// to raise real-world win probability by cutting one compounding leg of
// bookmaker margin per ticket. MUST stay in sync with TIER_CONFIG in
// scripts/generate-tickets.mjs — the two representations had drifted out
// of sync before this fix (dataFetcher.ts still showed the old 10/15/20/30
// figures while the real pipeline had already moved to 9/14/19/29).
export const TIER_CONFIG: TierConfig[] = [
  { tier: 'mega', label: 'Mega Day Ticket', matchCount: 4, oddsRange: '1.5-3', alwaysFree: true },
  { tier: 'bronze', label: 'Bronze', matchCount: 3, oddsRange: '2-3', alwaysFree: false },
  { tier: 'silver', label: 'Silver', matchCount: 5, oddsRange: '3-5', alwaysFree: false },
  { tier: 'gold', label: 'Gold', matchCount: 7, oddsRange: '5-10', alwaysFree: false },
  { tier: 'platinum', label: 'Platinum', matchCount: 9, oddsRange: '25-300', alwaysFree: false },
  { tier: 'diamond', label: 'Diamond', matchCount: 14, oddsRange: '300+', alwaysFree: false },
  { tier: 'weekly_lite', label: 'Weekly Lite', matchCount: 19, oddsRange: 'Mixed', alwaysFree: false },
  { tier: 'weekly_titan', label: 'Weekly Titan', matchCount: 29, oddsRange: 'Mixed', alwaysFree: false },
  { tier: 'saints_lock', label: "Saint's Lock", matchCount: 1, oddsRange: '1.5-2', alwaysFree: false },
];

// ---------------------------------------------------------------------------
// Daily slip volume + staggered release
// ---------------------------------------------------------------------------
// Every category caps at 2 tickets/day (down from 3) — mirrors
// MAX_TICKETS_PER_CATEGORY in scripts/generate-tickets.mjs. The two daily
// slots release at different times (see RELEASE_SLOT_HOURS_UTC, matching
// the two cron triggers in generate-tickets.yml) rather than simultaneously
// — a tier's 2nd slip is a genuinely fresh batch released later in the day,
// not an alternative shown alongside the 1st, so there's no "which of
// these do I pick right now" moment for users to be confused by. Whatever
// batch is currently on Supabase simply stays on screen until the next
// scheduled slot writes a new row — nothing here ever deletes a previous
// slip, so "previous batch stays visible until the next one lands" falls
// out of the read path for free.
const MAX_TICKETS_PER_CATEGORY = 2;

/** UTC hours the two daily release slots fire at — must match the cron schedule in .github/workflows/generate-tickets.yml. */
export const RELEASE_SLOT_HOURS_UTC = [6, 14];

function getDailySlipCount(tier: TicketTier, day: string, date: Date): number {
  if (tier === 'saints_lock') return Math.min(MAX_TICKETS_PER_CATEGORY, 2); // min 1/max 2 guaranteed by the real pipeline; see SAINTS_LOCK_MIN_CONFIDENCE
  if (tier === 'platinum' || tier === 'diamond' || tier === 'weekly_lite' || tier === 'weekly_titan') {
    return 1; // large accumulators — one curated slip a day
  }
  // mega / bronze / silver / gold: scale with a deterministic "busyness"
  // factor, capped at MAX_TICKETS_PER_CATEGORY.
  const busyness = hashSeed(`${day}-busyness`) / 233280; // deterministic 0..1
  return Math.min(MAX_TICKETS_PER_CATEGORY, 1 + Math.round(busyness * (MAX_TICKETS_PER_CATEGORY - 1)));
}

/**
 * Given "today" in the visitor's local view, returns a human label for
 * when the tier's NEXT release slot lands — used by the frontend so users
 * know when to check back rather than risk missing a batch. Purely a
 * display helper; it does not affect what data gets fetched.
 */
export function getNextReleaseLabel(now: Date = new Date()): { label: string; hasReleasedToday: boolean } {
  const nowUTCHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  const upcoming = RELEASE_SLOT_HOURS_UTC.find((h) => h > nowUTCHours);
  const nextHourUTC = upcoming ?? RELEASE_SLOT_HOURS_UTC[0];
  const rollsToTomorrow = upcoming === undefined;

  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), nextHourUTC, 0));
  if (rollsToTomorrow) next.setUTCDate(next.getUTCDate() + 1);

  const label = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(next);
  const hasReleasedToday = nowUTCHours >= RELEASE_SLOT_HOURS_UTC[0];
  return { label, hasReleasedToday };
}


// Teams grouped by their actual real-world domestic league — matches are
// only ever generated within the same league, so a mock fixture never
// mislabels which competition a real club actually plays in.
const LEAGUE_TEAMS: Record<string, string[]> = {
  EPL: ['Arsenal', 'Chelsea', 'Man City', 'Liverpool'],
  'La Liga': ['Real Madrid', 'Barcelona', 'Atletico Madrid'],
  Bundesliga: ['Bayern Munich', 'Dortmund', 'Leipzig'],
  'Serie A': ['AC Milan', 'Inter Milan', 'Juventus', 'Napoli'],
  'Ligue 1': ['PSG', 'Marseille'],
};

// Marquee clubs — picks avoid pairing two of these against each other
// within the same league, since those fixtures are inherently harder to
// call with real confidence. Every league above has at least one
// non-marquee club to fall back to when this triggers.
const BIG_TEAMS = ['Real Madrid', 'Barcelona', 'Bayern Munich', 'Man City', 'Liverpool', 'PSG', 'Juventus', 'Chelsea'];
const BIG_TEAM_SET = new Set(BIG_TEAMS);

// "Draw No Bet" and plain "Draw" are deliberately excluded — see the
// generate-tickets.mjs market catalog for the same rule applied to real
// picks. Both are considered too low-confidence to build a product around.
const MARKETS = ['Over 1.5 Goals', 'Home Win', 'Away Win', 'BTTS', 'Over 2.5 Goals'];

// ---------------------------------------------------------------------------
// Mock outcome probabilities (PLACEHOLDER — see file header note)
// Decided at the ticket level first, then matches are generated consistent
// with that outcome, so the aggregate win rate stays predictable regardless
// of how many legs a ticket has (a 30-leg accumulator isn't punished just
// for having more matches — this is mock data, not a real settlement engine).
// ---------------------------------------------------------------------------
const OUTCOME_PROBS = { green: 0.74, red: 0.11, pending: 0.15 } as const;

// How long after kickoff a match is treated as "played" — mirrors the real
// grading job's buffer (see scripts/grade-tickets.mjs). Before this point,
// a match's status always displays as pending, REGARDLESS of its eventual
// decided outcome — a match that hasn't been played yet can't have a result.
const GRADE_BUFFER_MS = 2.5 * 60 * 60 * 1000;

function seededRandom(seed: number) {
  // Deterministic pseudo-random generator — same seed always produces the
  // same sequence, which is what makes a given day's tickets stable.
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

/** Simple string hash so any date+tier+slip combination maps to a stable numeric seed. */
function hashSeed(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h % 233280;
}

/** Local calendar date as 'YYYY-MM-DD', used as the root of every day's seed. */
export function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Spreads mock kickoffs across a realistic matchday window (12:00–20:30 UTC)
 * on the ticket's actual calendar date, rather than relative to "whenever
 * this function happened to run" — that's what makes the played/not-played
 * check below meaningful instead of arbitrary.
 */
function getMockKickoff(day: Date, rand: () => number): Date {
  const hour = 12 + Math.floor(rand() * 9); // 12–20
  const minute = rand() < 0.5 ? 0 : 30;
  return new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute));
}

function pickTeams(rand: () => number): { home: string; away: string; league: string } {
  const leagueNames = Object.keys(LEAGUE_TEAMS);
  const league = leagueNames[Math.floor(rand() * leagueNames.length)];
  const clubs = LEAGUE_TEAMS[league];

  const home = clubs[Math.floor(rand() * clubs.length)];
  let away = clubs[Math.floor(rand() * clubs.length)];
  if (away === home) away = clubs[(clubs.indexOf(away) + 1) % clubs.length];

  // Two marquee clubs facing each other — reroll the away side to a
  // non-marquee club within the SAME league, so the fixture stays both
  // gradable with real confidence and correctly labeled for that league.
  if (BIG_TEAM_SET.has(home) && BIG_TEAM_SET.has(away)) {
    const regularInLeague = clubs.filter((c) => !BIG_TEAM_SET.has(c));
    if (regularInLeague.length > 0) {
      away = regularInLeague[Math.floor(rand() * regularInLeague.length)];
    }
  }

  return { home, away, league };
}

// Tiers with fewer than 7 matches favor safer, more heavily-favored picks —
// same rule as the real pipeline (scripts/generate-tickets.mjs).
const SMALL_TICKET_MAX_ODDS = 1.77;

/**
 * Generates a plausible final score consistent with a market and whether
 * the pick won or lost — the inverse of scripts/lib/markets.mjs's
 * settleMarket, which judges a score against a market. Only called once a
 * match has actually "been played" (see hasBeenPlayed below), so mock data
 * never shows a score before its status would allow one.
 */
function generateScoreForOutcome(
  market: string,
  won: boolean,
  rand: () => number
): { home: number; away: number } {
  const lowGoal = () => Math.floor(rand() * 2); // 0-1
  const highGoal = () => 2 + Math.floor(rand() * 3); // 2-4

  switch (market) {
    case 'Home Win':
      return won ? { home: highGoal(), away: lowGoal() } : { home: lowGoal(), away: lowGoal() + (rand() < 0.5 ? 0 : 1) };
    case 'Away Win':
      return won ? { home: lowGoal(), away: highGoal() } : { home: lowGoal() + (rand() < 0.5 ? 0 : 1), away: lowGoal() };
    case 'Over 1.5 Goals':
      return won ? { home: 1 + Math.floor(rand() * 2), away: 1 + Math.floor(rand() * 2) } : { home: 0, away: rand() < 0.5 ? 0 : 1 };
    case 'Under 1.5 Goals':
      return won ? { home: 0, away: rand() < 0.5 ? 0 : 1 } : { home: 1 + Math.floor(rand() * 2), away: 1 + Math.floor(rand() * 2) };
    case 'Over 2.5 Goals':
      return won ? { home: highGoal(), away: 1 + Math.floor(rand() * 2) } : { home: 1, away: 1 };
    case 'Under 2.5 Goals':
      return won ? { home: 1, away: 1 } : { home: highGoal(), away: 1 + Math.floor(rand() * 2) };
    case 'Over 3.5 Goals':
      return won ? { home: highGoal(), away: highGoal() } : { home: 1, away: 1 };
    case 'BTTS':
    case 'BTTS - Yes':
      return won ? { home: 1 + Math.floor(rand() * 2), away: 1 + Math.floor(rand() * 2) } : { home: 0, away: 1 + Math.floor(rand() * 2) };
    case 'BTTS - No':
      return won ? { home: 0, away: 1 + Math.floor(rand() * 2) } : { home: 1 + Math.floor(rand() * 2), away: 1 + Math.floor(rand() * 2) };
    default:
      return won ? { home: highGoal(), away: lowGoal() } : { home: lowGoal(), away: lowGoal() };
  }
}

function buildMatch(
  rand: () => number,
  index: number,
  seedOffset: number,
  forcedStatus: MatchStatus,
  day: Date,
  maxOdds: number
): Match {
  const { home, away, league } = pickTeams(rand);
  const market = MARKETS[Math.floor(rand() * MARKETS.length)];
  const oddsRange = Math.min(maxOdds, 3.8) - 1.3;
  const odds = Math.round((1.3 + rand() * oddsRange) * 100) / 100;
  const confidence = Math.round(60 + rand() * 38);

  const kickoff = getMockKickoff(day, rand);
  const hasBeenPlayed = Date.now() > kickoff.getTime() + GRADE_BUFFER_MS;
  // A match can't show a result before it's actually been played — the
  // "intended" outcome only applies once real time has caught up to it.
  const status: MatchStatus = hasBeenPlayed ? forcedStatus : 'pending';

  let finalHomeScore: number | undefined;
  let finalAwayScore: number | undefined;
  if (status === 'green' || status === 'red') {
    const score = generateScoreForOutcome(market, status === 'green', rand);
    finalHomeScore = score.home;
    finalAwayScore = score.away;
  }

  return {
    id: `m-${seedOffset}-${index}`,
    league,
    homeTeam: home,
    awayTeam: away,
    market,
    odds,
    kickoff: kickoff.toISOString(),
    status,
    confidence,
    finalHomeScore,
    finalAwayScore,
  };
}

// Numeric cumulative-odds targets matching each tier's oddsRange label.
// Mirrors TIER_ODDS_TARGET in scripts/generate-tickets.mjs — mock data
// should behave the same way real data does. Weekly Lite/Titan
// intentionally left unset ("Mixed" by design, no fixed target).
const TIER_ODDS_TARGET: Partial<Record<TicketTier, [number, number]>> = {
  mega: [1.5, 3],
  bronze: [2, 3],
  silver: [3, 5],
  gold: [5, 10],
  platinum: [25, 300],
  diamond: [300, Infinity],
};

/**
 * Scales every leg's odds toward the tier's target cumulative range,
 * clamped within [minLegOdds, maxLegOdds] per leg. Mock data has no fixed
 * "pool" to swap picks in and out of like the real pipeline does, so this
 * solves directly for the multiplicative factor needed instead.
 */
function adjustOddsToTarget(matches: Match[], targetRange: [number, number] | undefined, minLegOdds: number, maxLegOdds: number) {
  if (!targetRange) return;
  const [minTotal, maxTotal] = targetRange;

  for (let pass = 0; pass < 6; pass++) {
    const total = matches.reduce((acc, m) => acc * m.odds, 1);
    if (total >= minTotal && total <= maxTotal) return;

    const target = total < minTotal ? minTotal : maxTotal;
    if (!Number.isFinite(target)) return; // diamond's upper bound is Infinity — nothing to scale toward
    const factorPerLeg = Math.pow(target / total, 1 / matches.length);

    matches.forEach((m) => {
      const scaled = m.odds * factorPerLeg;
      m.odds = Math.round(Math.min(maxLegOdds, Math.max(minLegOdds, scaled)) * 100) / 100;
    });
  }
}

/** Decide the overall ticket outcome first, then build per-match statuses consistent with it. */
function buildTicket(config: TierConfig, seed: number, day: Date, releaseSlot: number): Ticket {
  const rand = seededRandom(seed);
  const n = config.matchCount;
  const maxOdds = n < 7 ? SMALL_TICKET_MAX_ODDS : 3.8;

  const outcomeRoll = rand();
  const overall: MatchStatus =
    outcomeRoll < OUTCOME_PROBS.green ? 'green' : outcomeRoll < OUTCOME_PROBS.green + OUTCOME_PROBS.red ? 'red' : 'pending';

  const statuses: MatchStatus[] = new Array(n).fill('green');
  if (overall === 'red') {
    // Exactly one losing leg — the classic "one bad selection" accumulator failure.
    const badIndex = Math.floor(rand() * n);
    statuses[badIndex] = 'red';
  } else if (overall === 'pending') {
    // A handful of legs still in play, none failed yet.
    const pendingFraction = 0.3 + rand() * 0.4;
    let anyPending = false;
    for (let i = 0; i < n; i++) {
      if (rand() < pendingFraction) {
        statuses[i] = 'pending';
        anyPending = true;
      }
    }
    if (!anyPending) statuses[0] = 'pending';
  }
  // overall === 'green' → statuses stays all-green (subject to the
  // played/not-played gate applied per match inside buildMatch).

  const matches = Array.from({ length: n }, (_, i) => buildMatch(rand, i, seed, statuses[i], day, maxOdds));
  adjustOddsToTarget(matches, TIER_ODDS_TARGET[config.tier], 1.3, maxOdds);
  const totalOdds = Math.round(matches.reduce((acc, m) => acc * m.odds, 1) * 100) / 100;

  // Deterministic mock "available_at": anchor to the release slot's clock
  // hour on this ticket's calendar day, so mock data mirrors the real
  // pipeline's staggered-release timestamps instead of always looking
  // "just released."
  const slotHour = RELEASE_SLOT_HOURS_UTC[releaseSlot] ?? RELEASE_SLOT_HOURS_UTC[0];
  const availableAt = new Date(
    Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), slotHour, 0)
  ).toISOString();

  return {
    id: `t-${config.tier}-${seed}`,
    tier: config.tier,
    label: config.label,
    slipLabel: undefined, // both daily slips are full tickets released at different times, not "1 of 2" alternatives
    matchCount: n,
    oddsRange: config.oddsRange,
    totalOdds,
    isFree: config.alwaysFree,
    matches,
    releaseSlot,
    availableAt,
  };
}

/**
 * Returns the overall grading status for a ticket container.
 * - 'red'     if ANY match inside has failed (red)
 * - 'green'   if ALL matches are green (ticket fully won)
 * - 'pending' otherwise (still in play)
 */
export function getTicketStatus(ticket: Ticket): MatchStatus {
  if (ticket.matches.some((m) => m.status === 'red')) return 'red';
  if (ticket.matches.every((m) => m.status === 'green')) return 'green';
  return 'pending';
}

/**
 * Generates every ticket for a given calendar day — deterministically, so
 * the same date always regenerates identical tickets and outcomes.
 *
 * Replace this with a real Supabase query once tickets are graded and
 * stored server-side, e.g.:
 *
 *   const { data } = await supabase
 *     .from('tickets')
 *     .select('*, matches(*)')
 *     .eq('ticket_date', dateKey(date));
 */
export function getTicketsForDate(date: Date): Ticket[] {
  const day = dateKey(date);
  const tickets: Ticket[] = [];

  TIER_CONFIG.forEach((config) => {
    const count = getDailySlipCount(config.tier, day, date);
    for (let i = 0; i < count; i++) {
      const seed = hashSeed(`${day}-${config.tier}-${i}`);
      tickets.push(buildTicket(config, seed, date, i));
    }
  });

  return tickets;
}

/**
 * Reads real, pipeline-generated tickets from Supabase for a given day.
 * Returns null (rather than an empty array) when there's nothing real to
 * show yet, so the caller can fall back to mock data instead of rendering
 * an empty feed.
 */
async function fetchRealTicketsForDate(date: Date): Promise<Ticket[] | null> {
  const day = dateKey(date);

  let data;
  try {
    const result = await supabase
      .from('tickets')
      .select(
        `id, tier, slip_label, match_count, odds_range, total_odds, is_free, release_slot, available_at,
         ticket_matches ( sort_order, fixtures ( id, league, home_team, away_team, kickoff, market, odds, confidence, result_status, final_home_score, final_away_score ) )`
      )
      .eq('ticket_date', day);

    if (result.error) {
      // eslint-disable-next-line no-console
      console.warn('[Odd Saint] Supabase ticket query failed, using mock data:', result.error.message);
      return null;
    }
    data = result.data;
  } catch (err) {
    // A thrown exception (network failure, misconfigured client, etc.) is
    // different from a clean query error above — catch it here too so any
    // failure mode falls back to mock data instead of leaving the ticket
    // feed silently empty.
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] Supabase ticket query threw, using mock data:', err);
    return null;
  }

  if (!data || data.length === 0) return null;

  const tierOrder = TIER_CONFIG.map((c) => c.tier);
  const tierLabel = (tier: TicketTier) => TIER_CONFIG.find((c) => c.tier === tier)?.label ?? tier;

  const tickets: Ticket[] = data.map((row: any) => {
    const links = [...(row.ticket_matches ?? [])].sort(
      (a: any, b: any) => a.sort_order - b.sort_order
    );
    const matches: Match[] = links.map((link: any) => {
      const f = link.fixtures;
      return {
        id: String(f.id),
        league: f.league,
        homeTeam: f.home_team,
        awayTeam: f.away_team,
        market: f.market,
        odds: f.odds,
        kickoff: f.kickoff,
        status: f.result_status as MatchStatus,
        confidence: f.confidence,
        finalHomeScore: f.final_home_score ?? undefined,
        finalAwayScore: f.final_away_score ?? undefined,
      };
    });

    return {
      id: row.id,
      tier: row.tier as TicketTier,
      label: tierLabel(row.tier),
      slipLabel: row.slip_label ?? undefined,
      matchCount: row.match_count,
      oddsRange: row.odds_range,
      totalOdds: row.total_odds,
      isFree: row.is_free,
      matches,
      releaseSlot: row.release_slot ?? 0,
      availableAt: row.available_at ?? undefined,
    };
  });

  // Previous batches stay visible alongside the newest one — sort order
  // just needs to be stable and tier-grouped; nothing here filters out an
  // earlier release_slot, so both of a tier's slips for the day (if both
  // exist yet) show up until superseded tomorrow.
  tickets.sort(
    (a, b) =>
      tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier) ||
      (a.releaseSlot ?? 0) - (b.releaseSlot ?? 0) ||
      a.id.localeCompare(b.id)
  );

  return tickets;
}

/**
 * Fetch all of today's tickets — real pipeline data if available, mock data
 * otherwise (e.g. before the daily generation job has run for this date).
 */
export async function fetchTickets(date: Date = new Date()): Promise<Ticket[]> {
  try {
    const real = await fetchRealTicketsForDate(date);
    return real ?? getTicketsForDate(date);
  } catch (err) {
    // Last-resort safety net — no matter what goes wrong upstream, the
    // ticket feed should never end up silently empty.
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] fetchTickets failed unexpectedly, using mock data:', err);
    return getTicketsForDate(date);
  }
}

/**
 * Fetch every slip for one tier on a given day (e.g. all of today's Gold slips).
 */
export async function fetchTicketsByTier(tier: TicketTier, date: Date = new Date()): Promise<Ticket[]> {
  const all = await fetchTickets(date);
  return all.filter((t) => t.tier === tier);
}

// ---------------------------------------------------------------------------
// Admin match editor
// ---------------------------------------------------------------------------
// Lets an admin attach/detach an individual fixture on a specific ticket —
// e.g. pull a match they judge too risky, or add one they consider a
// stronger pick. The real security boundary is Supabase RLS (see
// supabase/migrations/002_batch_updates.sql: only a user listed in
// `admins` can write to ticket_matches/tickets) — these helpers will
// simply fail silently for a non-admin caller, same pattern as
// updateAppSettings below.

export interface AvailableFixture {
  id: number;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  market: string;
  odds: number;
  confidence: number;
}

/** Fixtures already priced for a given ticket_date — the admin's "add a match" picker pulls from here, not from scratch. */
export async function fetchFixturesForDate(date: Date): Promise<AvailableFixture[]> {
  try {
    const { data, error } = await supabase
      .from('fixtures')
      .select('id, league, home_team, away_team, kickoff, market, odds, confidence')
      .eq('ticket_date', dateKey(date))
      .order('kickoff', { ascending: true });
    if (error || !data) return [];
    return data.map((f: any) => ({
      id: f.id,
      league: f.league,
      homeTeam: f.home_team,
      awayTeam: f.away_team,
      kickoff: f.kickoff,
      market: f.market,
      odds: f.odds,
      confidence: f.confidence,
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] fetchFixturesForDate failed:', err);
    return [];
  }
}

async function recomputeTicketTotals(ticketId: string): Promise<{ success: boolean; error?: string }> {
  const { data: links, error } = await supabase
    .from('ticket_matches')
    .select('fixtures(odds)')
    .eq('ticket_id', ticketId);
  if (error) return { success: false, error: error.message };

  const oddsList = (links ?? [])
    .map((l: any) => (Array.isArray(l.fixtures) ? l.fixtures[0]?.odds : l.fixtures?.odds))
    .filter((o: unknown): o is number => typeof o === 'number');
  const totalOdds = Math.round(oddsList.reduce((acc: number, o: number) => acc * o, 1) * 100) / 100;

  const { error: updateErr } = await supabase
    .from('tickets')
    .update({ match_count: oddsList.length, total_odds: totalOdds })
    .eq('id', ticketId);
  if (updateErr) return { success: false, error: updateErr.message };
  return { success: true };
}

/** Admin action: attach an already-priced fixture to a ticket, then recompute the ticket's match count / total odds. */
export async function adminAddFixtureToTicket(
  ticketId: string,
  fixtureId: number
): Promise<{ success: boolean; error?: string }> {
  const { data: links } = await supabase.from('ticket_matches').select('fixture_id').eq('ticket_id', ticketId);
  if (links?.some((l: any) => l.fixture_id === fixtureId)) {
    return { success: false, error: 'That fixture is already on this ticket.' };
  }

  const sortOrder = links?.length ?? 0;
  const { error: linkErr } = await supabase
    .from('ticket_matches')
    .insert({ ticket_id: ticketId, fixture_id: fixtureId, sort_order: sortOrder });
  if (linkErr) return { success: false, error: linkErr.message };

  return recomputeTicketTotals(ticketId);
}

/** Admin action: detach a fixture from a ticket, then recompute the ticket's match count / total odds. */
export async function adminRemoveFixtureFromTicket(
  ticketId: string,
  fixtureId: number
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase
    .from('ticket_matches')
    .delete()
    .eq('ticket_id', ticketId)
    .eq('fixture_id', fixtureId);
  if (error) return { success: false, error: error.message };
  return recomputeTicketTotals(ticketId);
}

// ---------------------------------------------------------------------------
// Saint's Lock access
// ---------------------------------------------------------------------------
// Mirrors the pattern already used by getArchiveAccess below — reads the
// current signed-in user's OWN row only (RLS restricts saints_lock_access
// selects to `user_id = auth.uid()`), so this can't be used to enumerate
// anyone else's access. Sign-up is mandatory and no free trial ever
// applies to Saint's Lock — a null/expired row simply means no access.

export interface SaintsLockAccess {
  active: boolean;
  expiresAt: string | null;
}

export async function getSaintsLockAccess(userId: string | null): Promise<SaintsLockAccess> {
  if (!userId) return { active: false, expiresAt: null };
  try {
    const { data, error } = await supabase
      .from('saints_lock_access')
      .select('active, expires_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) return { active: false, expiresAt: null };

    const active = !!data.active && new Date(data.expires_at).getTime() > Date.now();
    return { active, expiresAt: data.expires_at ?? null };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] Saint\'s Lock access check failed, defaulting to no access:', err);
    return { active: false, expiresAt: null };
  }
}

/**
 * Trial length in days for anonymous (not signed in) visitors.
 * Signing up grants a separate, fresh SIGNED_UP_TRIAL_DAYS window on top —
 * up to ANONYMOUS_TRIAL_DAYS + SIGNED_UP_TRIAL_DAYS = 44 total free days if
 * someone signs up on day 1 of browsing.
 *
 * These are the DEFAULT values, used while the app is still growing. Once
 * SUBSCRIBER_MILESTONE active subscribers is reached, getTrialPolicy()
 * below switches new visitors to a tighter policy instead — see there.
 *
 * NOTE: Saint's Lock is explicitly excluded from ALL trial logic on this
 * page — see getSaintsLockAccess above and the frontend gating in
 * src/app/page.tsx. Nothing here ever grants Saint's Lock access via trial.
 */
export const ANONYMOUS_TRIAL_DAYS = 14;
export const SIGNED_UP_TRIAL_DAYS = 30;

const SUBSCRIBER_MILESTONE = 50_000;
// After the milestone: a much shorter free look, and no signed-up bonus —
// continued access past the 7 days requires actually subscribing rather
// than just creating an account.
const POST_MILESTONE_ANONYMOUS_TRIAL_DAYS = 7;
const POST_MILESTONE_SIGNED_UP_TRIAL_DAYS = 0;

export interface TrialPolicy {
  anonymousDays: number;
  signedUpDays: number;
  milestoneReached: boolean;
}

/**
 * Reads the live active-subscriber count (see app_stats in
 * supabase/schema.sql, kept accurate by a database trigger) and returns
 * which trial policy currently applies. Falls back to the pre-milestone
 * defaults on any failure — never lets a Supabase hiccup accidentally
 * shorten everyone's trial.
 */
export async function getTrialPolicy(): Promise<TrialPolicy> {
  const defaults: TrialPolicy = {
    anonymousDays: ANONYMOUS_TRIAL_DAYS,
    signedUpDays: SIGNED_UP_TRIAL_DAYS,
    milestoneReached: false,
  };

  try {
    const { data, error } = await supabase.from('app_stats').select('subscriber_count').eq('id', 1).single();
    if (error || !data) return defaults;

    const count: number = data.subscriber_count ?? 0;
    if (count >= SUBSCRIBER_MILESTONE) {
      return {
        anonymousDays: POST_MILESTONE_ANONYMOUS_TRIAL_DAYS,
        signedUpDays: POST_MILESTONE_SIGNED_UP_TRIAL_DAYS,
        milestoneReached: true,
      };
    }
    return defaults;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] Trial policy check failed, using defaults:', err);
    return defaults;
  }
}

/**
 * Trial helper: given a start date (ISO string) and the trial length in
 * days for that context, returns how many days remain (never negative).
 */
export function getTrialDaysRemaining(startISO: string | null, totalDays: number): number {
  if (!startISO) return totalDays;
  const start = new Date(startISO).getTime();
  const elapsedDays = Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24));
  return Math.max(0, totalDays - elapsedDays);
}

export function isWithinFreeTrial(startISO: string | null, totalDays: number): boolean {
  return getTrialDaysRemaining(startISO, totalDays) > 0;
}

// ---------------------------------------------------------------------------
// Anonymous trial tracking
// ---------------------------------------------------------------------------
// Visitors get the full 30-day free trial WITHOUT creating an account. The
// trial clock starts the first time a browser hits the app and is stored in
// localStorage on that device. Signing in later (magic link) is optional —
// it's only needed once the trial ends, to unlock ads/payment/subscription
// paths, or if the person wants their trial tied to an account instead of a
// single device.
const ANON_TRIAL_KEY = 'odd_saint_anon_trial_start';

export function getAnonymousTrialStart(): string {
  const fallback = new Date().toISOString();
  if (typeof window === 'undefined') return fallback;
  try {
    const existing = window.localStorage.getItem(ANON_TRIAL_KEY);
    if (existing) return existing;
    window.localStorage.setItem(ANON_TRIAL_KEY, fallback);
    return fallback;
  } catch {
    // localStorage unavailable (e.g. private browsing) — fall back to a
    // fresh trial each visit rather than blocking access.
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Performance history
// ---------------------------------------------------------------------------
// A rolling record of how many tickets ran each day and how they graded out.
// Because ticket generation is fully deterministic by date, this "history"
// doesn't need a database yet — every past day can be re-derived on demand
// and will always produce the same result. Once matches are graded by a
// real backend job, swap this to read a `daily_performance` table instead
// of recomputing it client-side — see the file header note.

export interface TierStats {
  ticketsGenerated: number;
  won: number;
  failed: number;
  pending: number;
  /** Win rate among decided tickets (won / (won + failed)), 0-100. Null if none decided yet. */
  winRatePct: number | null;
}

export interface DayPerformance {
  date: string; // 'YYYY-MM-DD'
  overall: TierStats;
  byTier: Partial<Record<TicketTier, TierStats>>;
}

function computeStats(statusesPerTicket: MatchStatus[][]): TierStats {
  let won = 0;
  let failed = 0;
  let pending = 0;

  statusesPerTicket.forEach((statuses) => {
    if (statuses.length === 0) return;
    if (statuses.includes('red')) failed++;
    else if (statuses.every((s) => s === 'green')) won++;
    else pending++;
  });

  const decided = won + failed;
  return {
    ticketsGenerated: statusesPerTicket.length,
    won,
    failed,
    pending,
    winRatePct: decided > 0 ? Math.round((won / decided) * 100) : null,
  };
}

export function getDayPerformance(date: Date): DayPerformance {
  const tickets = getTicketsForDate(date);
  const statusesOf = (t: Ticket) => t.matches.map((m) => m.status);

  const byTier: Partial<Record<TicketTier, TierStats>> = {};
  TIER_CONFIG.forEach((config) => {
    const tierTickets = tickets.filter((t) => t.tier === config.tier);
    if (tierTickets.length > 0) {
      byTier[config.tier] = computeStats(tierTickets.map(statusesOf));
    }
  });

  return {
    date: dateKey(date),
    overall: computeStats(tickets.map(statusesOf)),
    byTier,
  };
}

/**
 * One query covering the whole window, grouped by day and by tier — real
 * graded results if present for that day, otherwise the day is simply
 * absent from the returned map (caller falls back to mock for it).
 */
async function fetchRealHistoryRange(days: number): Promise<Map<string, DayPerformance>> {
  const map = new Map<string, DayPerformance>();
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));

  let data;
  try {
    const result = await supabase
      .from('tickets')
      .select('id, ticket_date, tier, ticket_matches ( fixtures ( result_status ) )')
      .gte('ticket_date', dateKey(start))
      .lte('ticket_date', dateKey(today));

    if (result.error) return map;
    data = result.data;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] Supabase history query threw, using mock data:', err);
    return map;
  }

  if (!data) return map;

  const byDate = new Map<string, any[]>();
  data.forEach((row: any) => {
    const key = row.ticket_date;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(row);
  });

  const statusesOfRow = (row: any): MatchStatus[] =>
    (row.ticket_matches ?? []).map((tm: any) => tm.fixtures?.result_status).filter(Boolean);

  byDate.forEach((rows, day) => {
    const byTier: Partial<Record<TicketTier, TierStats>> = {};
    TIER_CONFIG.forEach((config) => {
      const tierRows = rows.filter((r: any) => r.tier === config.tier);
      if (tierRows.length > 0) {
        byTier[config.tier] = computeStats(tierRows.map(statusesOfRow));
      }
    });

    map.set(day, {
      date: day,
      overall: computeStats(rows.map(statusesOfRow)),
      byTier,
    });
  });

  return map;
}

/**
 * Returns performance for the last `days` calendar days, most recent first
 * (today is index 0). Uses real graded results wherever the pipeline has
 * already produced them, and mock data for any day it hasn't reached yet.
 * Each day includes both the overall total and a per-tier breakdown.
 */
export async function fetchPerformanceHistory(days: number = 14): Promise<DayPerformance[]> {
  const realByDay = await fetchRealHistoryRange(days);
  const history: DayPerformance[] = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    history.push(realByDay.get(dateKey(d)) ?? getDayPerformance(d));
  }
  return history;
}

/**
 * Aggregate win rate across the last `days` days — a single headline number
 * for the landing hero (e.g. "78% win rate over the last 14 days"). Pass a
 * tier to get that tier's aggregate instead of the overall total.
 */
export function summarizeHistory(
  history: DayPerformance[],
  tier?: TicketTier
): {
  totalWon: number;
  totalFailed: number;
  winRatePct: number | null;
} {
  const statsOf = (d: DayPerformance) => (tier ? d.byTier[tier] : d.overall);
  const totalWon = history.reduce((acc, d) => acc + (statsOf(d)?.won ?? 0), 0);
  const totalFailed = history.reduce((acc, d) => acc + (statsOf(d)?.failed ?? 0), 0);
  const decided = totalWon + totalFailed;
  return {
    totalWon,
    totalFailed,
    winRatePct: decided > 0 ? Math.round((totalWon / decided) * 100) : null,
  };
}

// ---------------------------------------------------------------------------
// Team history
// ---------------------------------------------------------------------------
// Reads from the `team_match_history` view (see supabase/schema.sql), which
// is derived entirely from graded fixtures already in the database — no
// separate write path needed. Coverage is necessarily partial: only teams
// that have actually appeared in a generated ticket at some point will show
// up here, not a comprehensive record of every match a team has ever played.

export interface TeamMatchResult {
  opponent: string;
  venue: 'home' | 'away';
  goalsFor: number;
  goalsAgainst: number;
  result: 'W' | 'D' | 'L';
  league: string;
  kickoff: string;
}

export interface TeamFormSummary {
  team: string;
  matchesFound: number;
  wins: number;
  draws: number;
  losses: number;
  recentResults: TeamMatchResult[]; // most recent first
}

/**
 * Looks up a team's known match history (most recent first, up to `limit`).
 * Returns null on any failure (including "no data yet") rather than
 * throwing, so callers can show a clean "no history yet" state instead of
 * crashing — matches the same defensive pattern used elsewhere in this file.
 */
export async function fetchTeamHistory(teamName: string, limit: number = 10): Promise<TeamFormSummary | null> {
  try {
    const { data, error } = await supabase
      .from('team_match_history')
      .select('opponent, venue, goals_for, goals_against, result, league, kickoff')
      .eq('team', teamName)
      .order('kickoff', { ascending: false })
      .limit(limit);

    if (error || !data || data.length === 0) return null;

    const recentResults: TeamMatchResult[] = data.map((row: any) => ({
      opponent: row.opponent,
      venue: row.venue,
      goalsFor: row.goals_for,
      goalsAgainst: row.goals_against,
      result: row.result,
      league: row.league,
      kickoff: row.kickoff,
    }));

    return {
      team: teamName,
      matchesFound: recentResults.length,
      wins: recentResults.filter((r) => r.result === 'W').length,
      draws: recentResults.filter((r) => r.result === 'D').length,
      losses: recentResults.filter((r) => r.result === 'L').length,
      recentResults,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] Team history query failed:', err);
    return null;
  }
}

/** A plain web-search URL for a team — the "external search" fallback, since a live news API needs a backend to hold its key safely (this app has none). */
export function webSearchUrlForTeam(teamName: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(`${teamName} football news`)}`;
}

// ---------------------------------------------------------------------------
// Admin-editable app settings
// ---------------------------------------------------------------------------
// Reads/writes the single-row `app_settings` table (see supabase/schema.sql).
// Anyone can read it (the live site needs to, to render the current theme);
// only a user listed in the `admins` table can successfully update it — that
// restriction is enforced by Postgres RLS, not by anything in this file, so
// it holds even if the frontend code were bypassed entirely.

export interface AppSettings {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  fontChoice: string;
  heroHeadline: string;
  heroSubtext: string;
  showPerformanceHistory: boolean;
  showTeamSearch: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  primaryColor: '#0b8a4f',
  accentColor: '#0b8a4f',
  backgroundColor: '#f4f6f5',
  fontChoice: 'inter',
  heroHeadline: 'Curated tickets, graded in the open.',
  heroSubtext:
    'Odd Saint offers football predictions only — not a betting operator, not financial advice. Every pick is AI-assisted analysis, never a guarantee.',
  showPerformanceHistory: true,
  showTeamSearch: true,
};

/** Reads the live app settings, falling back to defaults on any failure (including before the table has ever been edited). */
export async function fetchAppSettings(): Promise<AppSettings> {
  try {
    const { data, error } = await supabase.from('app_settings').select('*').eq('id', 1).single();
    if (error || !data) return DEFAULT_APP_SETTINGS;

    return {
      primaryColor: data.primary_color ?? DEFAULT_APP_SETTINGS.primaryColor,
      accentColor: data.accent_color ?? DEFAULT_APP_SETTINGS.accentColor,
      backgroundColor: data.background_color ?? DEFAULT_APP_SETTINGS.backgroundColor,
      fontChoice: data.font_choice ?? DEFAULT_APP_SETTINGS.fontChoice,
      heroHeadline: data.hero_headline ?? DEFAULT_APP_SETTINGS.heroHeadline,
      heroSubtext: data.hero_subtext ?? DEFAULT_APP_SETTINGS.heroSubtext,
      showPerformanceHistory: data.show_performance_history ?? DEFAULT_APP_SETTINGS.showPerformanceHistory,
      showTeamSearch: data.show_team_search ?? DEFAULT_APP_SETTINGS.showTeamSearch,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] App settings query failed, using defaults:', err);
    return DEFAULT_APP_SETTINGS;
  }
}

/**
 * Updates one or more settings. Will silently fail to change anything (RLS
 * blocks the write) if the current user isn't in the `admins` table — the
 * `success: false` return is for UI feedback, not the actual security
 * mechanism, which lives in the database.
 */
export async function updateAppSettings(
  settings: Partial<AppSettings>
): Promise<{ success: boolean; error?: string }> {
  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (settings.primaryColor !== undefined) payload.primary_color = settings.primaryColor;
  if (settings.accentColor !== undefined) payload.accent_color = settings.accentColor;
  if (settings.backgroundColor !== undefined) payload.background_color = settings.backgroundColor;
  if (settings.fontChoice !== undefined) payload.font_choice = settings.fontChoice;
  if (settings.heroHeadline !== undefined) payload.hero_headline = settings.heroHeadline;
  if (settings.heroSubtext !== undefined) payload.hero_subtext = settings.heroSubtext;
  if (settings.showPerformanceHistory !== undefined) payload.show_performance_history = settings.showPerformanceHistory;
  if (settings.showTeamSearch !== undefined) payload.show_team_search = settings.showTeamSearch;

  try {
    const { error } = await supabase.from('app_settings').update(payload).eq('id', 1);
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ---------------------------------------------------------------------------
// Archive access level
// ---------------------------------------------------------------------------
// The ticket archive (browsing past days' tickets) isn't open to everyone:
// - Admins (see `admins` table): unrestricted, any past date.
// - Subscribers (see `subscribers` table): up to the last 5 days.
// - Everyone else: no access at all.
// Both checks query the current signed-in user's own row — RLS on both
// tables only allows a user to read their own membership, so this can't be
// used to enumerate who else is an admin/subscriber.

export type ArchiveAccess = { level: 'admin' } | { level: 'subscriber'; maxDaysBack: number } | { level: 'none' };

const SUBSCRIBER_ARCHIVE_DAYS = 5;

export async function getArchiveAccess(userId: string | null): Promise<ArchiveAccess> {
  if (!userId) return { level: 'none' };

  try {
    const { data: adminRow } = await supabase.from('admins').select('user_id').eq('user_id', userId).maybeSingle();
    if (adminRow) return { level: 'admin' };

    const { data: subRow } = await supabase
      .from('subscribers')
      .select('user_id, active, expires_at')
      .eq('user_id', userId)
      .maybeSingle();

    const isActiveSubscriber =
      subRow?.active && (!subRow.expires_at || new Date(subRow.expires_at).getTime() > Date.now());

    if (isActiveSubscriber) return { level: 'subscriber', maxDaysBack: SUBSCRIBER_ARCHIVE_DAYS };

    return { level: 'none' };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] Archive access check failed, defaulting to no access:', err);
    return { level: 'none' };
  }
}
