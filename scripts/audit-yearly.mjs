// ---------------------------------------------------------------------------
// Odd Saint — Yearly Audit Report
// Manual-trigger + scheduled (see .github/workflows/audit-yearly.yml).
// REPORT ONLY — same bounded principle as audit-weekly.mjs /
// audit-quarterly.mjs. Window-level totals only.
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
  formatAppStatusNote,
} from './lib/auditReport.mjs';

const LOOKBACK_DAYS = 365;

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

  console.log(`Building yearly audit report: ${startDateStr} → ${endDateStr}`);

  const [growth, engagement, pagePerf, satisfaction, feedback, perfSnapshot, ga4] = await Promise.all([
    getSubscriberGrowth(supabase, sinceISO),
    getTicketEngagement(supabase, sinceISO, 20),
    getPagePerformance(supabase, sinceISO),
    getSatisfactionSummary(supabase, sinceISO, 10),
    getFeedbackSummary(supabase, sinceISO),
    getPerformanceSnapshot(supabase, startDateStr),
    gatherGa4Section(startDateStr, endDateStr),
  ]);

  let summary = formatHeader('Odd Saint — Yearly Audit Report', startDateStr, endDateStr);
  summary += formatGa4Section(ga4);
  summary += formatSubscriberSection(growth);
  summary += formatEngagementSection(engagement, 20);
  summary += formatPerformanceSection(perfSnapshot);
  summary += formatPerfSection(pagePerf);
  summary += formatSatisfactionSection(satisfaction, feedback);
  summary += formatAppStatusNote();
  summary +=
    '_This is the highest-level snapshot of the three audit cadences — use it for year-over-year product ' +
    'direction decisions, not day-to-day operations. Cross-reference with the quarterly reports in the ' +
    'workflow run history for trend direction within the year._\n';

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
