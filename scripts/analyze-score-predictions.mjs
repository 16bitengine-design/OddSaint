// ---------------------------------------------------------------------------
// Odd Saint — score-prediction accuracy reconciliation (daily)
//
// Reads yesterday's score_predictions — by the time this runs, they've had
// a full day+ of scripts/grade-tickets.mjs's recurring 3-hourly grading
// passes to settle — computes real hit-rate statistics, writes a
// human-readable report to the GitHub Actions step summary, AND persists
// one row to score_prediction_daily_accuracy (see supabase/migrations/
// 006_score_prediction_tuning.sql) as a visible evidence trail.
//
// REPORT-ONLY for everything except that one append — same bounded
// principle as analyze-performance.mjs / analyze-feedback.mjs. This
// script does NOT change min_sample_matches or any other pipeline
// setting; that's scripts/self-tune-score-model.mjs's separate, narrowly
// -scoped job (which reads the raw score_predictions rows directly for
// its own finer-grained backtest, not this rollup).
//
// Run once daily via .github/workflows/analyze-score-predictions.yml, at
// 01:00 UTC — well after grade-tickets.mjs's 3-hourly cycle has had many
// passes at yesterday's fixtures. Some very late-kickoff fixtures may
// still be genuinely pending at that point (extra time, postponement,
// etc.) — those are reported as "still pending" and honestly excluded
// from the hit-rate denominator, never treated as a miss.
// ---------------------------------------------------------------------------
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : null;
}

async function main() {
  const supabase = getSupabaseAdmin();

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const targetDate = dateStr(yesterday);

  const { data, error } = await supabase
    .from('score_predictions')
    .select(
      'id, league, country, home_team, away_team, predicted_home_score, predicted_away_score, ' +
        'actual_home_score, actual_away_score, probability, result_status, min_sample_matches_used'
    )
    .eq('ticket_date', targetDate);
  if (error) throw error;

  const rows = data ?? [];
  let summary = `## Score prediction accuracy — ${targetDate}\n\n`;

  if (rows.length === 0) {
    summary += `_No score predictions were generated for ${targetDate} — nothing to reconcile._\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const fs = await import('node:fs');
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
    return;
  }

  const correct = rows.filter((r) => r.result_status === 'correct');
  const incorrect = rows.filter((r) => r.result_status === 'incorrect');
  const pending = rows.filter((r) => r.result_status === 'pending');
  const decided = correct.length + incorrect.length;
  const hitRatePct = pct(correct.length, decided);

  summary += `${rows.length} prediction(s) generated · ${decided} decided · ${pending.length} still pending.\n\n`;
  summary += `**Overall exact-score hit rate: ${hitRatePct !== null ? `${hitRatePct}%` : '—'}** (${correct.length} correct / ${decided} decided)\n\n`;
  summary +=
    '_A single-scoreline pick is inherently a low hit-rate bet — this being well under 50% is expected, ' +
    'not a sign of a broken model. Judge this by the TREND over weeks, not any single day._\n\n';

  // --- By league (min sample of 3 to avoid noisy single-fixture "leagues") ---
  const byLeague = new Map();
  rows.forEach((r) => {
    if (r.result_status === 'pending') return;
    const entry = byLeague.get(r.league) ?? { correct: 0, total: 0 };
    entry.total++;
    if (r.result_status === 'correct') entry.correct++;
    byLeague.set(r.league, entry);
  });
  const leagueRows = Array.from(byLeague.entries()).filter(([, e]) => e.total >= 3);
  if (leagueRows.length > 0) {
    summary += `### By league (min 3 decided)\n\n| League | Hit rate | Sample |\n|---|---|---|\n`;
    leagueRows
      .sort((a, b) => b[1].total - a[1].total)
      .forEach(([league, e]) => {
        summary += `| ${league} | ${pct(e.correct, e.total)}% | ${e.total} |\n`;
      });
    summary += '\n';
  }

  // --- By the model's own stated probability band for the picked scoreline —
  // does a higher-confidence pick actually land more often? This is the
  // real sanity check on whether `probability` means anything at all. ---
  const BANDS = [
    [0, 0.05],
    [0.05, 0.1],
    [0.1, 0.15],
    [0.15, 1],
  ];
  summary += `### By model-stated probability band\n\n| Band | Hit rate | Sample |\n|---|---|---|\n`;
  BANDS.forEach(([lo, hi]) => {
    const inBand = rows.filter(
      (r) => r.result_status !== 'pending' && r.probability !== null && r.probability >= lo && r.probability < hi
    );
    const bandCorrect = inBand.filter((r) => r.result_status === 'correct').length;
    summary += `| ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}% | ${pct(bandCorrect, inBand.length)}% | ${inBand.length} |\n`;
  });
  summary += '\n';

  const minSampleUsed = rows.find((r) => r.min_sample_matches_used != null)?.min_sample_matches_used ?? null;

  const { error: upsertErr } = await supabase.from('score_prediction_daily_accuracy').upsert(
    {
      ticket_date: targetDate,
      correct: correct.length,
      incorrect: incorrect.length,
      still_pending: pending.length,
      hit_rate_pct: hitRatePct,
      min_sample_matches_used: minSampleUsed,
    },
    { onConflict: 'ticket_date' }
  );
  if (upsertErr) throw upsertErr;

  summary +=
    '_Logged to `score_prediction_daily_accuracy` for trend tracking — ' +
    'see scripts/self-tune-score-model.mjs, which reads real prediction-level history (not this rollup) ' +
    "before ever adjusting the model's own min_sample_matches threshold._\n";

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
