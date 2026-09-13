// ---------------------------------------------------------------------------
// Odd Saint — Weekly Audit Report
// Manual-trigger + scheduled (see .github/workflows/audit-weekly.yml).
// REPORT ONLY — reads Supabase + GA4, writes to the GitHub Step Summary,
// changes nothing automatically. Same bounded/reviewable principle as
// analyze-performance.mjs and analyze-feedback.mjs.
//
// This is the one report that breaks activity down day-by-day ("a weekly
// report based on daily performance") — quarterly/yearly stay at
// window-level totals on purpose (see auditMetrics.mjs's getDailyBreakdown
// comment).
// ---------------------------------------------------------------------------
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';
import { getGa4Config, getTrafficOverview, getTrafficSources, getGeoBreakdown, getAgeBreakdown, getTopPages } from './lib/ga4.mjs';
import {
  getSubscriberGrowth,
  getTicketEngagement,
  getPagePerformance,
  getSatisfactionSummary,
  getFeedbackSummary,
  getPerformanceSnapshot,
  getDailyBreakdown,
  isoDaysAgo,
  dateStrDaysAgo,
} from './lib/auditMetrics.mjs';
import {
  formatHeader,
  formatSubscriberSection,
  formatEngagementSection,
  formatPerfSection,
  formatSatisfactionSection,
  formatPerformanceSection,
  formatGa4Section,
  formatDailyBreakdownSection,
  formatAppStatusNote,
} from './lib/auditReport.mjs';

const LOOKBACK_DAYS = 7;

async function gatherGa4Section(startDate, endDate) {
  const config = getGa4Config();
  if (!config) return null;

  const [overview, sources, geo, age, topPages] = await Promise.all([
    getTrafficOverview(config, startDate, endDate),
    getTrafficSources(config, startDate, endDate),
    getGeoBreakdown(config, startDate, endDate),
    getAgeBreakdown(config, startDate, endDate),
    getTopPages(config, startDate, endDate),
  ]);
  return { overview, sources, geo, age, topPages };
}

async function main() {
  const supabase = getSupabaseAdmin();
  const sinceISO = isoDaysAgo(LOOKBACK_DAYS);
  const startDateStr = dateStrDaysAgo(LOOKBACK_DAYS);
  const endDateStr = new Date().toISOString().slice(0, 10);

  console.log(`Building weekly audit report: ${startDateStr} → ${endDateStr}`);

  const [growth, engagement, pagePerf, satisfaction, feedback, perfSnapshot, daily, ga4] = await Promise.all([
    getSubscriberGrowth(supabase, sinceISO),
    getTicketEngagement(supabase, sinceISO),
    getPagePerformance(supabase, sinceISO),
    getSatisfactionSummary(supabase, sinceISO),
    getFeedbackSummary(supabase, sinceISO),
    getPerformanceSnapshot(supabase, startDateStr),
    getDailyBreakdown(supabase, sinceISO),
    gatherGa4Section(startDateStr, endDateStr),
  ]);

  let summary = formatHeader('Odd Saint — Weekly Audit Report', startDateStr, endDateStr);
  summary += formatDailyBreakdownSection(daily);
  summary += formatGa4Section(ga4);
  summary += formatSubscriberSection(growth);
  summary += formatEngagementSection(engagement);
  summary += formatPerformanceSection(perfSnapshot);
  summary += formatPerfSection(pagePerf);
  summary += formatSatisfactionSection(satisfaction, feedback);
  summary += formatAppStatusNote();

  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import('node:fs');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
