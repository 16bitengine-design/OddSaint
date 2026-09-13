// ---------------------------------------------------------------------------
// Odd Saint — audit report formatting
// Pure functions: take already-fetched data, return a markdown string.
// No Supabase/GA4 calls happen in this file — see auditMetrics.mjs and
// ga4.mjs for the data-fetching side. Kept separate so the three report
// scripts (audit-weekly/quarterly/yearly.mjs) can share exactly one
// definition of what each section looks like.
// ---------------------------------------------------------------------------

export function formatHeader(label, startDateStr, endDateStr) {
  return (
    `## ${label}\n\n` +
    `Window: **${startDateStr} → ${endDateStr}**. This report reads real data from Supabase and, where configured, ` +
    `the GA4 Data API — it changes nothing automatically, same as the other audit/digest workflows in this repo.\n\n`
  );
}

export function formatSubscriberSection(growth) {
  let md = `### Subscribers\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| New subscribers this window | ${growth.newSubscribers} |\n`;
  md += `| New Saint's Lock signups this window | ${growth.newSaintsLockSignups} |\n`;
  md += `| Total active subscribers (current, all-time) | ${growth.totalActiveSubscribers ?? '—'} |\n\n`;
  return md;
}

export function formatEngagementSection(engagement, topN = 10) {
  let md = `### Ticket engagement\n`;
  if (engagement.totalViews === 0) {
    md += '_No ticket_views rows in this window — either telemetry isn\'t wired into the frontend yet, or genuinely no traffic._\n\n';
    return md;
  }

  md += `Total ticket-open events: **${engagement.totalViews}**\n\n`;

  md += `**Most viewed tickets (top ${topN})**\n\n`;
  md += `| Ticket | Tier | Views |\n|---|---|---|\n`;
  engagement.mostViewed.forEach((t) => {
    md += `| ${t.ticketId} | ${t.tier} | ${t.views} |\n`;
  });
  md += '\n';

  md += `**Views by tier**\n\n`;
  md += `| Tier | Views |\n|---|---|\n`;
  engagement.viewsByTier.forEach((t) => {
    md += `| ${t.tier} | ${t.views} |\n`;
  });
  md += '\n';

  md += `**High-velocity periods (UTC)** — peak hour: ${
    engagement.peakHourUTC !== null ? `${String(engagement.peakHourUTC).padStart(2, '0')}:00` : '—'
  }, peak day: ${engagement.peakDayOfWeek ?? '—'}\n\n`;

  return md;
}

export function formatPerfSection(pagePerf) {
  let md = `### Page load performance (client-measured LCP)\n`;
  if (pagePerf.sampleSize === 0) {
    md += '_No page_perf rows in this window — telemetry may not be wired into the frontend yet._\n\n';
    return md;
  }
  md += `Sample size: ${pagePerf.sampleSize}\n\n`;
  md += `| Route | Samples | Avg (ms) | p75 (ms) | p95 (ms) |\n|---|---|---|---|---|\n`;
  pagePerf.byRoute.forEach((r) => {
    md += `| ${r.route} | ${r.sampleSize} | ${r.avgMs} | ${r.p75Ms} | ${r.p95Ms} |\n`;
  });
  md += '\n';
  return md;
}

export function formatSatisfactionSection(satisfaction, feedback) {
  let md = `### Satisfaction & feedback\n`;
  if (satisfaction.sampleSize === 0) {
    md += '_No satisfaction_ratings rows in this window._\n\n';
  } else {
    md += `Average score: **${satisfaction.avgScore} / 5** (${satisfaction.sampleSize} rating${satisfaction.sampleSize === 1 ? '' : 's'})\n\n`;
    md += `| Score | Count |\n|---|---|\n`;
    satisfaction.distribution.forEach((d) => {
      md += `| ${d.score} | ${d.count} |\n`;
    });
    md += '\n';
    if (satisfaction.recentComments.length > 0) {
      md += `**Recent comments**\n\n`;
      satisfaction.recentComments.forEach((c) => {
        md += `- (${c.score}/5) ${c.comment}\n`;
      });
      md += '\n';
    }
  }

  md += `Support/feedback submissions this window: **${feedback.total}** ` +
    `(pending ${feedback.byStatus.pending}, approved ${feedback.byStatus.approved}, rejected ${feedback.byStatus.rejected})\n\n`;

  return md;
}

export function formatPerformanceSection(perf) {
  let md = `### Ticket performance (headline)\n`;
  if (perf.gradedFixtures === 0) {
    md += '_No graded fixtures in this window yet._\n\n';
    return md;
  }
  md += `${perf.green} green / ${perf.red} red — win rate **${perf.winRatePct}%** ` +
    `across ${perf.gradedFixtures} graded fixture(s). ` +
    `Run the "Odd Saint — Performance Digest" workflow for market/tier/confidence-band breakdowns.\n\n`;
  return md;
}

export function formatGa4Section(ga4) {
  let md = `### Traffic (GA4)\n`;
  if (!ga4) {
    md += '_GA4_PROPERTY_ID / GA4_SERVICE_ACCOUNT_KEY not configured (or the GA4 Data API call failed) — skipping this section. See scripts/lib/ga4.mjs for setup steps._\n\n';
    return md;
  }

  const { overview, sources, geo, age, topPages } = ga4;

  if (overview) {
    md += `| Metric | Value |\n|---|---|\n`;
    md += `| Active users | ${overview.activeUsers} |\n`;
    md += `| New users | ${overview.newUsers} |\n`;
    md += `| Sessions | ${overview.sessions} |\n`;
    md += `| Engaged sessions | ${overview.engagedSessions} |\n`;
    md += `| Avg. engagement time | ${Math.round(overview.avgSessionDurationSec)}s |\n\n`;
  } else {
    md += '_No overview data returned by GA4 for this window._\n\n';
  }

  if (sources.length > 0) {
    md += `**Traffic sources (origin)**\n\n| Channel | Sessions |\n|---|---|\n`;
    sources.forEach((s) => (md += `| ${s.channel} | ${s.sessions} |\n`));
    md += '\n';
  }

  if (geo.length > 0) {
    md += `**Top locations**\n\n| Country | Active users |\n|---|---|\n`;
    geo.forEach((g) => (md += `| ${g.country} | ${g.activeUsers} |\n`));
    md += '\n';
  }

  if (age.length > 0) {
    md += `**Age breakdown**\n\n| Age bracket | Active users |\n|---|---|\n`;
    age.forEach((a) => (md += `| ${a.ageBracket} | ${a.activeUsers} |\n`));
    md += '\n';
  } else {
    md += '_Age breakdown unavailable — requires Google Signals / demographics reporting enabled on the GA4 property, and enough traffic to report on._\n\n';
  }

  if (topPages.length > 0) {
    md += `**Most viewed pages**\n\n| Page | Views |\n|---|---|\n`;
    topPages.forEach((p) => (md += `| ${p.pagePath} | ${p.screenPageViews} |\n`));
    md += '\n';
  }

  return md;
}

export function formatDailyBreakdownSection(dailyRows) {
  let md = `### Day-by-day (this week)\n\n`;
  md += `| Date | Ticket views | New subscribers | Graded fixtures (W/L) | Win rate |\n|---|---|---|---|---|\n`;
  dailyRows.forEach((d) => {
    md += `| ${d.date} | ${d.views} | ${d.newSubscribers} | ${d.green}/${d.red} | ${d.winRatePct !== null ? `${d.winRatePct}%` : '—'} |\n`;
  });
  md += '\n';
  return md;
}

export function formatAppStatusNote() {
  return (
    `### App status\n\n` +
    `_Not tracked yet — this repo has no uptime/error-rate monitoring wired in (e.g. a status-check ` +
    `GitHub Action, Vercel's own analytics, or a third-party monitor). Until that exists, treat "app status" ` +
    `as "the generate-tickets / grade-tickets workflows are running green" — check the Actions tab directly.\n\n`
  );
}
