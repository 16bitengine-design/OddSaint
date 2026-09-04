// ---------------------------------------------------------------------------
// Odd Saint — performance & threshold-backtest digest
//
// Reads REAL graded results from Supabase (fixtures with result_status IN
// ('green','red'), plus the tickets/ticket_matches that link them to
// tiers) and produces a plain-language breakdown by market, by confidence
// band, and by tier — plus a threshold backtest that shows, for a range of
// candidate MIN_CONFIDENCE values, what the win rate and sample size
// WOULD have been historically if that threshold had been in effect.
//
// This is deliberately a REPORT ONLY. It does not change MIN_CONFIDENCE,
// SMALL_TICKET_MAX_ODDS, or any other generation-pipeline setting — same
// bounded/reviewable principle as .github/workflows/analyze-feedback.yml
// and ai-self-evolution.yml. A human reads this and decides what to
// adjust in scripts/generate-tickets.mjs; nothing here does that
// automatically.
//
// Run manually via .github/workflows/analyze-performance.yml, not on a
// schedule — there's no reason to regenerate this daily, and a human
// should decide when enough new graded results have accumulated to make
// re-checking worthwhile.
// ---------------------------------------------------------------------------
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';

// How far back to pull graded fixtures/tickets from. 30 days gives enough
// sample size to be meaningful without the query growing unbounded as the
// app accumulates history.
const LOOKBACK_DAYS = 30;
const MAX_FIXTURES_FETCHED = 5000;
const MAX_TICKETS_FETCHED = 3000;

// Candidate MIN_CONFIDENCE values to backtest against real graded history.
// The current live value (set in scripts/generate-tickets.mjs) is called
// out separately below so it's easy to see where "today" sits on this
// curve.
const CANDIDATE_THRESHOLDS = [60, 65, 68, 70, 72, 74, 76, 78, 80, 82, 85];

// Must match MIN_CONFIDENCE in scripts/generate-tickets.mjs — kept as a
// separate constant here (rather than importing it) so this script never
// accidentally changes generation behavior just by being run; if you tune
// MIN_CONFIDENCE in generate-tickets.mjs, update this line too so the
// digest correctly marks which threshold is "live" today.
const CURRENT_LIVE_MIN_CONFIDENCE = 74;

const CONFIDENCE_BANDS = [
  [55, 59], [60, 64], [65, 69], [70, 74], [75, 79], [80, 84], [85, 89], [90, 95],
];

function pct(wins, total) {
  return total > 0 ? Math.round((wins / total) * 1000) / 10 : null; // one decimal place
}

async function main() {
  const supabase = getSupabaseAdmin();
  const cutoffISO = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // -------------------------------------------------------------------
  // Fixture-level data — used for market breakdown, confidence bands,
  // and the threshold backtest. One row per graded fixture, regardless
  // of how many tickets/tiers it was reused across.
  // -------------------------------------------------------------------
  const { data: fixtureRows, error: fixtureErr } = await supabase
    .from('fixtures')
    .select('market, confidence, odds, result_status, kickoff')
    .in('result_status', ['green', 'red'])
    .gte('kickoff', cutoffISO)
    .order('kickoff', { ascending: false })
    .limit(MAX_FIXTURES_FETCHED);
  if (fixtureErr) throw fixtureErr;

  const fixtures = fixtureRows ?? [];

  // -------------------------------------------------------------------
  // Ticket-level data — used for the tier breakdown. Mirrors the exact
  // win/loss definition used in src/lib/dataFetcher.ts's computeStats()
  // (a ticket is 'red' if ANY leg is red, 'green' only if ALL legs are
  // green) so these numbers match what's shown in the app's own
  // Performance History screen — this is the "did the ticket someone
  // actually paid for win" number, not just an average of individual legs.
  // -------------------------------------------------------------------
  const { data: ticketRows, error: ticketErr } = await supabase
    .from('tickets')
    .select('id, tier, ticket_date, ticket_matches ( fixtures ( result_status ) )')
    .gte('ticket_date', cutoffISO.slice(0, 10))
    .order('ticket_date', { ascending: false })
    .limit(MAX_TICKETS_FETCHED);
  if (ticketErr) throw ticketErr;

  const tickets = ticketRows ?? [];

  let summary = `## Performance digest — last ${LOOKBACK_DAYS} days\n\n`;
  summary += `Based on ${fixtures.length} graded fixture(s) and ${tickets.length} ticket(s) with a ticket_date in this window. `;
  summary += 'This is a REPORT ONLY — it changes nothing in the generation pipeline automatically.\n\n';

  if (fixtures.length === 0 && tickets.length === 0) {
    summary += '_No graded results in this window yet — nothing to analyze._\n';
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const fs = await import('node:fs');
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
    return;
  }

  // ---------------------------------------------------------------------
  // 1. Overall fixture-level win rate
  // ---------------------------------------------------------------------
  const totalGreen = fixtures.filter((f) => f.result_status === 'green').length;
  const totalRed = fixtures.filter((f) => f.result_status === 'red').length;
  summary += `### Overall (fixture-level)\n`;
  summary += `${totalGreen} green / ${totalRed} red — win rate ${pct(totalGreen, totalGreen + totalRed)}%\n\n`;

  // ---------------------------------------------------------------------
  // 2. Breakdown by market
  // ---------------------------------------------------------------------
  const byMarket = new Map(); // market -> { green, red }
  fixtures.forEach((f) => {
    const entry = byMarket.get(f.market) ?? { green: 0, red: 0 };
    if (f.result_status === 'green') entry.green++;
    else entry.red++;
    byMarket.set(f.market, entry);
  });

  summary += `### By market\n`;
  summary += `| Market | Win rate | Sample |\n|---|---|---|\n`;
  Array.from(byMarket.entries())
    .sort((a, b) => b[1].green + b[1].red - (a[1].green + a[1].red))
    .forEach(([market, { green, red }]) => {
      summary += `| ${market} | ${pct(green, green + red)}% | ${green + red} |\n`;
    });
  summary += '\n';

  // ---------------------------------------------------------------------
  // 3. Breakdown by confidence band
  // ---------------------------------------------------------------------
  summary += `### By confidence band (AI Confidence Index at pick time)\n`;
  summary += `| Band | Win rate | Sample |\n|---|---|---|\n`;
  CONFIDENCE_BANDS.forEach(([lo, hi]) => {
    const inBand = fixtures.filter((f) => f.confidence >= lo && f.confidence <= hi);
    const green = inBand.filter((f) => f.result_status === 'green').length;
    summary += `| ${lo}–${hi}% | ${pct(green, inBand.length)}% | ${inBand.length} |\n`;
  });
  summary += '\n';

  // ---------------------------------------------------------------------
  // 4. Threshold backtest — "if MIN_CONFIDENCE had been X, what would
  //    the win rate and sample size have looked like?"
  // ---------------------------------------------------------------------
  summary += `### MIN_CONFIDENCE threshold backtest\n`;
  summary += `Win rate and sample size among fixtures that would have cleared each threshold. `;
  summary += `Currently live in scripts/generate-tickets.mjs: **${CURRENT_LIVE_MIN_CONFIDENCE}%**.\n\n`;
  summary += `| Threshold | Win rate | Sample | |\n|---|---|---|---|\n`;
  CANDIDATE_THRESHOLDS.forEach((threshold) => {
    const cleared = fixtures.filter((f) => f.confidence >= threshold);
    const green = cleared.filter((f) => f.result_status === 'green').length;
    const marker = threshold === CURRENT_LIVE_MIN_CONFIDENCE ? ' ← live' : '';
    summary += `| ${threshold}%+ | ${pct(green, cleared.length)}% | ${cleared.length}${marker} | |\n`;
  });
  summary += '\n';
  summary +=
    '_Read this as a trade-off curve, not a single answer: higher thresholds should raise win rate but ' +
    'shrink sample size (fewer fixtures clear the bar, so some slips may not assemble some days). ' +
    'Compare against how often tickets have been skipped for lack of a valid combination in the ' +
    'generate-tickets workflow logs before pushing the threshold higher.\n\n';

  // ---------------------------------------------------------------------
  // 5. Tier breakdown — real accumulator (all-legs-must-win) win rate
  // ---------------------------------------------------------------------
  const byTier = new Map(); // tier -> { won, failed, pending }
  tickets.forEach((t) => {
    const statuses = (t.ticket_matches ?? [])
      .map((tm) => tm.fixtures?.result_status)
      .filter(Boolean);
    if (statuses.length === 0) return;

    const entry = byTier.get(t.tier) ?? { won: 0, failed: 0, pending: 0 };
    if (statuses.includes('red')) entry.failed++;
    else if (statuses.every((s) => s === 'green')) entry.won++;
    else entry.pending++;
    byTier.set(t.tier, entry);
  });

  summary += `### By tier (ticket-level — ALL legs must win)\n`;
  summary += `This is the number that matters to a subscriber: did the whole ticket clear, not just one leg.\n\n`;
  summary += `| Tier | Win rate | Won | Failed | Pending |\n|---|---|---|---|---|\n`;
  Array.from(byTier.entries())
    .sort((a, b) => b[1].won + b[1].failed + b[1].pending - (a[1].won + a[1].failed + a[1].pending))
    .forEach(([tier, { won, failed, pending }]) => {
      summary += `| ${tier} | ${pct(won, won + failed)}% | ${won} | ${failed} | ${pending} |\n`;
    });
  summary += '\n';

  summary +=
    '---\n\n' +
    '**This digest changes nothing automatically.** Use it to decide, as a human, whether to adjust ' +
    'MIN_CONFIDENCE or tier-specific odds caps in scripts/generate-tickets.mjs (and keep ' +
    'src/lib/dataFetcher.ts in sync per the tier-config-sync rule) — then re-run this report after a ' +
    'couple weeks of new graded results to see whether the change actually moved the real number.\n';

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
