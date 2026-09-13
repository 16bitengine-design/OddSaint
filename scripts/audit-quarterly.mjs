// ---------------------------------------------------------------------------
// Odd Saint — Quarterly Audit Report
// Manual-trigger + scheduled (see .github/workflows/audit-quarterly.yml).
// REPORT ONLY — same bounded principle as audit-weekly.mjs. Window-level
// totals only; no day-by-day table (91 rows would bury the signal).
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

const LOOKBACK_DAYS = 91; // ~one quarter

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

  console.log(`Building quarterly audit report: ${startDateStr} → ${endDateStr}`);

  const [growth, engagement, pagePerf, satisfaction, feedback, perfSnapshot, ga4] = await Promise.all([
    getSubscriberGrowth(supabase, sinceISO),
    getTicketEngagement(supabase, sinceISO, 15),
    getPagePerformance(supabase, sinceISO),
    getSatisfactionSummary(supabase, sinceISO, 10),
    getFeedbackSummary(supabase, sinceISO),
    getPerformanceSnapshot(supabase, startDateStr),
    gatherGa4Section(startDateStr, endDateStr),
  ]);

  let summary = formatHeader('Odd Saint — Quarterly Audit Report', startDateStr, endDateStr);
  summary += formatGa4Section(ga4);
  summary += formatSubscriberSection(growth);
  summary += formatEngagementSection(engagement, 15);
  summary += formatPerformanceSection(perfSnapshot);
  summary += formatPerfSection(pagePerf);
  summary += formatSatisfactionSection(satisfaction, feedback);
  summary += formatAppStatusNote();
  summary +=
    "_Compare this against the previous quarter's report (see workflow run history) to spot trend direction — " +
    'this script only reports the current window; it does not compute period-over-period deltas._\n';

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
