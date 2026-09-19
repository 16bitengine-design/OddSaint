// ---------------------------------------------------------------------------
// Odd Saint — data layer
// Reads real tickets from Supabase (populated by the GitHub Actions
// pipeline in scripts/generate-tickets.mjs + scripts/grade-tickets.mjs).
//
// NO MOCK DATA: the live homepage feed (fetchLatestTickets) shows either
// today's accessible tickets, or — if nothing for today is accessible yet
// (e.g. before the pipeline's first run of the day, or within the 1-hour
// availability delay) — the most recent earlier day's tickets, i.e. the
// results of the last generation. If nothing has ever been generated
// within the lookback window, the feed is simply empty; nothing here ever
// fabricates placeholder tickets. fetchTickets(date) is for browsing one
// SPECIFIC date (the ticket archive) and never looks at any other day —
// an empty result there means honestly "nothing was generated that day."
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
  | 'weekender'
  | 'saints_lock';

export interface Match {
  id: string;
  league: string;
  /** Nation/country the league is from (e.g. "England" for the Premier League) — from API-Football's league.country field. */
  country: string;
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
  /** ISO timestamp of when this specific slip actually becomes accessible */
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
  { tier: 'weekender', label: 'Weekender', matchCount: 35, oddsRange: 'Mixed', alwaysFree: false },
  { tier: 'saints_lock', label: "Saint's Lock", matchCount: 1, oddsRange: '1.5-2', alwaysFree: false },
];

/**
 * Availability hours (UTC) — when each day's release slot actually
 * becomes ACCESSIBLE to users, not when the pipeline runs. Generation
 * itself runs at 03:00 and 10:00 UTC (06:00 and 13:00 EAT — see
 * .github/workflows/generate-tickets.yml); tickets are then held back for
 * AVAILABILITY_DELAY_MS (1 hour, see scripts/generate-tickets.mjs) before
 * being shown, which is why these hours are 04:00 and 11:00, not 03:00
 * and 10:00. fetchRealTicketsForDate below enforces this by filtering out
 * any row whose available_at hasn't passed yet.
 */
export const RELEASE_SLOT_HOURS_UTC = [4, 11];

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

/** Local calendar date as 'YYYY-MM-DD' — used to key ticket_date queries, archive date pickers, and performance-history lookups. */
export function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
 * Reads real, pipeline-generated tickets from Supabase for a given day.
 * Returns null (rather than an empty array) when there's nothing
 * accessible yet for that day, so callers can distinguish "nothing here"
 * from "haven't checked yet" and decide what to do next (e.g.
 * fetchLatestTickets below falls back to an earlier day; fetchTickets
 * does not).
 */
async function fetchRealTicketsForDate(date: Date): Promise<Ticket[] | null> {
  const day = dateKey(date);

  let data;
  try {
    const result = await supabase
      .from('tickets')
      .select(
        `id, tier, slip_label, match_count, odds_range, total_odds, is_free, release_slot, available_at,
         ticket_matches ( sort_order, fixtures ( id, league, country, home_team, away_team, kickoff, market, odds, confidence, result_status, final_home_score, final_away_score ) )`
      )
      .eq('ticket_date', day);

    if (result.error) {
      // eslint-disable-next-line no-console
      console.warn('[Odd Saint] Supabase ticket query failed:', result.error.message);
      return null;
    }
    data = result.data;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] Supabase ticket query threw:', err);
    return null;
  }

  if (!data || data.length === 0) return null;

  // "Ready for use one hour after generation": a row can exist in
  // Supabase before it's meant to be shown — available_at is stamped as
  // generation time + AVAILABILITY_DELAY_MS by the pipeline (see
  // scripts/generate-tickets.mjs). Filter out anything not accessible yet
  // rather than showing a batch the instant it's written.
  const nowMs = Date.now();
  const accessible = data.filter((row: any) => {
    if (!row.available_at) return true; // defensive: no timestamp means don't block it
    return new Date(row.available_at).getTime() <= nowMs;
  });
  if (accessible.length === 0) return null;

  const tierOrder = TIER_CONFIG.map((c) => c.tier);
  const tierLabel = (tier: TicketTier) => TIER_CONFIG.find((c) => c.tier === tier)?.label ?? tier;

  const tickets: Ticket[] = accessible.map((row: any) => {
    const links = [...(row.ticket_matches ?? [])].sort(
      (a: any, b: any) => a.sort_order - b.sort_order
    );
    const matches: Match[] = links.map((link: any) => {
      const f = link.fixtures;
      return {
        id: String(f.id),
        league: f.league,
        country: f.country,
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
 * Fetch tickets for one SPECIFIC calendar day — used by the ticket
 * archive, where browsing a past date should show exactly what was
 * generated that day, honestly, including an empty result if nothing
 * was. Never looks at any other day and never fabricates data.
 */
export async function fetchTickets(date: Date = new Date()): Promise<Ticket[]> {
  try {
    const real = await fetchRealTicketsForDate(date);
    return real ?? [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] fetchTickets failed unexpectedly:', err);
    return [];
  }
}

// How many days back the live homepage feed will search for the most
// recent generation if today's isn't accessible yet. A generous cap so a
// multi-day outage doesn't just go blank, while still bounded so a
// brand-new deployment with nothing ever generated doesn't loop forever.
const LATEST_TICKETS_LOOKBACK_DAYS = 30;

/**
 * The live homepage's ticket feed: today's accessible tickets if any
 * exist yet, otherwise the most recent earlier day's accessible tickets —
 * "the results of the last generation." Never falls back to fabricated
 * data; if nothing is found within the lookback window (e.g. a brand-new
 * deployment before the pipeline has ever run), returns an empty array
 * and the UI shows an honest "nothing yet" state.
 */
export async function fetchLatestTickets(): Promise<Ticket[]> {
  const today = new Date();
  for (let i = 0; i < LATEST_TICKETS_LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    try {
      const real = await fetchRealTicketsForDate(d);
      if (real) return real;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[Odd Saint] fetchLatestTickets: query failed for ${dateKey(d)}, trying the day before:`, err);
      // keep walking backward rather than giving up on the whole feed
    }
  }
  return []; // nothing accessible within the lookback window
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
  /** Nation/country the league is from (e.g. "England" for the Premier League). */
  country: string;
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
      .select('id, league, country, home_team, away_team, kickoff, market, odds, confidence')
      .eq('ticket_date', dateKey(date))
      .order('kickoff', { ascending: true });
    if (error || !data) return [];
    return data.map((f: any) => ({
      id: f.id,
      league: f.league,
      country: f.country,
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
 * Trial length in days for anonymous (not signed in) visitors — the only
 * access window left in the current model. Signing up now grants
 * permanent free access to every ticket, every tier, including Saint's
 * Lock (see the "Access model" note on TicketCard in src/app/page.tsx),
 * rather than a second time-limited window — so SIGNED_UP_TRIAL_DAYS and
 * POST_MILESTONE_SIGNED_UP_TRIAL_DAYS below are DORMANT: kept, and still
 * returned by getTrialPolicy(), only so a future paid tier can reuse this
 * same plumbing without rebuilding it — nothing currently reads them for
 * gating.
 *
 * ANONYMOUS_TRIAL_DAYS is the DEFAULT value, used while the app is still
 * growing. Once SUBSCRIBER_MILESTONE active subscribers is reached,
 * getTrialPolicy() below switches new anonymous visitors to
 * POST_MILESTONE_ANONYMOUS_TRIAL_DAYS instead — see there. The two
 * currently happen to be equal (7), so the milestone doesn't yet change
 * anonymous behavior; lower POST_MILESTONE_ANONYMOUS_TRIAL_DAYS if a
 * tighter post-milestone anonymous window is wanted later.
 *
 * NOTE: Saint's Lock is explicitly excluded from the anonymous trial
 * specifically — see getSaintsLockAccess above and the frontend gating in
 * src/app/page.tsx. It has never had a trial and still requires signing
 * up regardless of where someone is in the anonymous window; once signed
 * up, though, it's free like everything else.
 */
export const ANONYMOUS_TRIAL_DAYS = 7;
export const SIGNED_UP_TRIAL_DAYS = 30; // dormant — see note above

const SUBSCRIBER_MILESTONE = 50_000;
// Dormant lever for tightening the anonymous trial further once the app
// hits scale — currently equal to ANONYMOUS_TRIAL_DAYS, so it changes
// nothing yet. POST_MILESTONE_SIGNED_UP_TRIAL_DAYS is dormant along with
// SIGNED_UP_TRIAL_DAYS above (signing up is unconditional free access
// now, not a second countdown).
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
// A rolling record of how many tickets ran each day and how they graded
// out. NO MOCK DATA: any day without real graded results simply shows as
// "no data" (ticketsGenerated: 0, winRatePct: null) rather than a
// fabricated placeholder — see PerformanceHistory in src/app/page.tsx,
// which already renders a "—" for a day with no stats.

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

const EMPTY_TIER_STATS: TierStats = { ticketsGenerated: 0, won: 0, failed: 0, pending: 0, winRatePct: null };

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

/**
 * One query covering the whole window, grouped by day and by tier — real
 * graded results if present for that day, otherwise the day is simply
 * absent from the returned map (caller fills the gap with EMPTY_TIER_STATS
 * rather than mock data).
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
    console.warn('[Odd Saint] Supabase history query threw:', err);
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
 * produced them; any day with nothing real yet shows as "no data" rather
 * than mock. Each day includes both the overall total and a per-tier
 * breakdown.
 */
export async function fetchPerformanceHistory(days: number = 14): Promise<DayPerformance[]> {
  const realByDay = await fetchRealHistoryRange(days);
  const history: DayPerformance[] = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    history.push(realByDay.get(dateKey(d)) ?? { date: dateKey(d), overall: EMPTY_TIER_STATS, byTier: {} });
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
