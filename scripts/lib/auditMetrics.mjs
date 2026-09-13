// ---------------------------------------------------------------------------
// Odd Saint — shared audit metrics
// Used by scripts/audit-weekly.mjs, audit-quarterly.mjs, and
// audit-yearly.mjs, so the three reports can never define "new
// subscriber", "most viewed ticket", etc. differently from one another —
// same "one shared definition, multiple callers" principle already used by
// scripts/lib/markets.mjs for generation/grading.
//
// Every function here reads via the service-role Supabase client (bypasses
// RLS, same as every other GitHub Actions script) and degrades gracefully:
// a query failure logs a warning and returns an empty/zeroed result rather
// than throwing, so one missing table or a transient Supabase hiccup
// doesn't take down the whole report.
// ---------------------------------------------------------------------------

const MAX_ROWS_FETCHED = 20_000; // generous cap so a busy period never blows up a report run

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : null; // one decimal place
}

function percentile(sortedNumbers, p) {
  if (sortedNumbers.length === 0) return null;
  const idx = Math.min(sortedNumbers.length - 1, Math.floor((p / 100) * sortedNumbers.length));
  return sortedNumbers[idx];
}

// ---------------------------------------------------------------------------
// Subscriber growth
// ---------------------------------------------------------------------------
export async function getSubscriberGrowth(supabase, sinceISO) {
  const result = {
    newSubscribers: 0,
    newSaintsLockSignups: 0,
    totalActiveSubscribers: null,
  };

  try {
    const { count: newSubs, error: newSubsErr } = await supabase
      .from('subscribers')
      .select('user_id', { count: 'exact', head: true })
      .gte('created_at', sinceISO);
    if (newSubsErr) throw newSubsErr;
    result.newSubscribers = newSubs ?? 0;

    const { count: newLock, error: newLockErr } = await supabase
      .from('saints_lock_access')
      .select('user_id', { count: 'exact', head: true })
      .gte('created_at', sinceISO);
    if (newLockErr) throw newLockErr;
    result.newSaintsLockSignups = newLock ?? 0;

    const { data: statsRow, error: statsErr } = await supabase
      .from('app_stats')
      .select('subscriber_count')
      .eq('id', 1)
      .maybeSingle();
    if (statsErr) throw statsErr;
    result.totalActiveSubscribers = statsRow?.subscriber_count ?? null;
  } catch (err) {
    console.warn('[audit] getSubscriberGrowth failed, returning partial/zeroed result:', err.message);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Ticket engagement (most-viewed tickets, views by tier, high-velocity
// hours/days) — all derived from one fetch of ticket_views.
// ---------------------------------------------------------------------------
async function fetchTicketViews(supabase, sinceISO) {
  try {
    const { data, error } = await supabase
      .from('ticket_views')
      .select('ticket_id, tier, viewed_at')
      .gte('viewed_at', sinceISO)
      .limit(MAX_ROWS_FETCHED);
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    console.warn('[audit] fetchTicketViews failed, treating as zero views:', err.message);
    return [];
  }
}

export async function getTicketEngagement(supabase, sinceISO, topN = 10) {
  const rows = await fetchTicketViews(supabase, sinceISO);

  const byTicket = new Map(); // ticket_id -> { count, tier }
  const byTier = new Map(); // tier -> count
  const byHourUTC = new Array(24).fill(0);
  const byDayOfWeek = new Array(7).fill(0); // 0 = Sunday, matches Date#getUTCDay()

  rows.forEach((r) => {
    const ticketEntry = byTicket.get(r.ticket_id) ?? { count: 0, tier: r.tier };
    ticketEntry.count += 1;
    byTicket.set(r.ticket_id, ticketEntry);

    byTier.set(r.tier, (byTier.get(r.tier) ?? 0) + 1);

    const d = new Date(r.viewed_at);
    byHourUTC[d.getUTCHours()] += 1;
    byDayOfWeek[d.getUTCDay()] += 1;
  });

  const mostViewed = Array.from(byTicket.entries())
    .map(([ticketId, { count, tier }]) => ({ ticketId, tier, views: count }))
    .sort((a, b) => b.views - a.views)
    .slice(0, topN);

  const viewsByTier = Array.from(byTier.entries())
    .map(([tier, views]) => ({ tier, views }))
    .sort((a, b) => b.views - a.views);

  const peakHourUTC = byHourUTC.indexOf(Math.max(...byHourUTC));
  const peakDayIndex = byDayOfWeek.indexOf(Math.max(...byDayOfWeek));
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return {
    totalViews: rows.length,
    mostViewed,
    viewsByTier,
    viewsByHourUTC: byHourUTC,
    viewsByDayOfWeek: byDayOfWeek.map((count, i) => ({ day: DAY_NAMES[i], views: count })),
    peakHourUTC: rows.length > 0 ? peakHourUTC : null,
    peakDayOfWeek: rows.length > 0 ? DAY_NAMES[peakDayIndex] : null,
  };
}

// ---------------------------------------------------------------------------
// Page load performance
// ---------------------------------------------------------------------------
export async function getPagePerformance(supabase, sinceISO) {
  try {
    const { data, error } = await supabase
      .from('page_perf')
      .select('route, load_ms')
      .gte('recorded_at', sinceISO)
      .limit(MAX_ROWS_FETCHED);
    if (error) throw error;

    const rows = data ?? [];
    if (rows.length === 0) return { sampleSize: 0, byRoute: [] };

    const byRoute = new Map(); // route -> number[]
    rows.forEach((r) => {
      if (!byRoute.has(r.route)) byRoute.set(r.route, []);
      byRoute.get(r.route).push(r.load_ms);
    });

    const summary = Array.from(byRoute.entries()).map(([route, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const avg = Math.round(sorted.reduce((acc, v) => acc + v, 0) / sorted.length);
      return {
        route,
        sampleSize: sorted.length,
        avgMs: avg,
        p75Ms: percentile(sorted, 75),
        p95Ms: percentile(sorted, 95),
      };
    });

    summary.sort((a, b) => b.sampleSize - a.sampleSize);
    return { sampleSize: rows.length, byRoute: summary };
  } catch (err) {
    console.warn('[audit] getPagePerformance failed, returning empty result:', err.message);
    return { sampleSize: 0, byRoute: [] };
  }
}

// ---------------------------------------------------------------------------
// Satisfaction
// ---------------------------------------------------------------------------
export async function getSatisfactionSummary(supabase, sinceISO, maxCommentsShown = 5) {
  try {
    const { data, error } = await supabase
      .from('satisfaction_ratings')
      .select('score, comment, created_at')
      .gte('created_at', sinceISO)
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS_FETCHED);
    if (error) throw error;

    const rows = data ?? [];
    if (rows.length === 0) return { sampleSize: 0, avgScore: null, distribution: [], recentComments: [] };

    const distribution = [1, 2, 3, 4, 5].map((score) => ({
      score,
      count: rows.filter((r) => r.score === score).length,
    }));
    const avgScore = Math.round((rows.reduce((acc, r) => acc + r.score, 0) / rows.length) * 100) / 100;
    const recentComments = rows
      .filter((r) => r.comment && r.comment.trim().length > 0)
      .slice(0, maxCommentsShown)
      .map((r) => ({ score: r.score, comment: r.comment }));

    return { sampleSize: rows.length, avgScore, distribution, recentComments };
  } catch (err) {
    console.warn('[audit] getSatisfactionSummary failed, returning empty result:', err.message);
    return { sampleSize: 0, avgScore: null, distribution: [], recentComments: [] };
  }
}

// ---------------------------------------------------------------------------
// Feedback volume (scoped by date — a windowed version of what
// analyze-feedback.mjs reports on-demand for approved items only; this
// covers all statuses so the audit report shows moderation backlog too).
// ---------------------------------------------------------------------------
export async function getFeedbackSummary(supabase, sinceISO) {
  try {
    const { data, error } = await supabase
      .from('feedback')
      .select('category, status')
      .gte('created_at', sinceISO)
      .limit(MAX_ROWS_FETCHED);
    if (error) throw error;

    const rows = data ?? [];
    const byStatus = { pending: 0, approved: 0, rejected: 0 };
    rows.forEach((r) => {
      if (byStatus[r.status] !== undefined) byStatus[r.status] += 1;
    });

    return { total: rows.length, byStatus };
  } catch (err) {
    console.warn('[audit] getFeedbackSummary failed, returning zeroed result:', err.message);
    return { total: 0, byStatus: { pending: 0, approved: 0, rejected: 0 } };
  }
}

// ---------------------------------------------------------------------------
// Headline win-rate snapshot (lighter-weight than analyze-performance.mjs's
// full threshold backtest — just the top-line numbers for the audit
// report; run the dedicated performance digest for the deeper analysis).
// ---------------------------------------------------------------------------
export async function getPerformanceSnapshot(supabase, sinceISODate) {
  try {
    const { data, error } = await supabase
      .from('fixtures')
      .select('result_status')
      .in('result_status', ['green', 'red'])
      .gte('kickoff', sinceISODate)
      .limit(MAX_ROWS_FETCHED);
    if (error) throw error;

    const rows = data ?? [];
    const green = rows.filter((r) => r.result_status === 'green').length;
    const red = rows.filter((r) => r.result_status === 'red').length;

    return { gradedFixtures: rows.length, green, red, winRatePct: pct(green, green + red) };
  } catch (err) {
    console.warn('[audit] getPerformanceSnapshot failed, returning zeroed result:', err.message);
    return { gradedFixtures: 0, green: 0, red: 0, winRatePct: null };
  }
}

// ---------------------------------------------------------------------------
// Daily breakdown — ONLY used by audit-weekly.mjs ("a weekly report based
// on daily performance"). Quarterly/yearly reports intentionally stay at
// window-level totals; a 91 or 365-row daily table would bury the signal
// rather than reveal it.
// ---------------------------------------------------------------------------
export async function getDailyBreakdown(supabase, sinceISO) {
  const dateKeyUTC = (iso) => new Date(iso).toISOString().slice(0, 10);

  const byDate = new Map(); // 'YYYY-MM-DD' -> { views, green, red, newSubscribers }
  function ensure(day) {
    if (!byDate.has(day)) byDate.set(day, { views: 0, green: 0, red: 0, newSubscribers: 0 });
    return byDate.get(day);
  }

  try {
    const [viewsRes, fixturesRes, subsRes] = await Promise.all([
      supabase.from('ticket_views').select('viewed_at').gte('viewed_at', sinceISO).limit(MAX_ROWS_FETCHED),
      supabase
        .from('fixtures')
        .select('kickoff, result_status')
        .in('result_status', ['green', 'red'])
        .gte('kickoff', sinceISO)
        .limit(MAX_ROWS_FETCHED),
      supabase.from('subscribers').select('created_at').gte('created_at', sinceISO).limit(MAX_ROWS_FETCHED),
    ]);

    (viewsRes.data ?? []).forEach((r) => {
      ensure(dateKeyUTC(r.viewed_at)).views += 1;
    });
    (fixturesRes.data ?? []).forEach((r) => {
      const bucket = ensure(dateKeyUTC(r.kickoff));
      if (r.result_status === 'green') bucket.green += 1;
      else bucket.red += 1;
    });
    (subsRes.data ?? []).forEach((r) => {
      ensure(dateKeyUTC(r.created_at)).newSubscribers += 1;
    });
  } catch (err) {
    console.warn('[audit] getDailyBreakdown failed, returning whatever was gathered so far:', err.message);
  }

  // Fill every day in the window, even ones with zero activity, so the
  // report shows genuine gaps rather than silently skipping them.
  const start = new Date(sinceISO);
  const today = new Date();
  const days = [];
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const bucket = byDate.get(key) ?? { views: 0, green: 0, red: 0, newSubscribers: 0 };
    days.push({
      date: key,
      views: bucket.views,
      green: bucket.green,
      red: bucket.red,
      winRatePct: pct(bucket.green, bucket.green + bucket.red),
      newSubscribers: bucket.newSubscribers,
    });
  }
  return days;
}

// ---------------------------------------------------------------------------
// Small date helpers shared by the three report scripts
// ---------------------------------------------------------------------------
export function isoDaysAgo(days, from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

export function dateStrDaysAgo(days, from = new Date()) {
  return isoDaysAgo(days, from).slice(0, 10);
}

export { pct, percentile };
