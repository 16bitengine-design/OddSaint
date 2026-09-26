// ---------------------------------------------------------------------------
// Odd Saint — bounded auto-tuning for the score-prediction model
//
// Mirrors scripts/self-tune.mjs's philosophy exactly, for a completely
// separate parameter space: the ONE tunable knob here is
// min_sample_matches (see DEFAULT_MIN_SAMPLE_MATCHES in
// scripts/lib/teamModel.mjs) — how much graded home/away history a team
// needs before the model will use it for a score prediction at all. Only
// ever moved in the SAFER direction (raised — stricter, fewer but more
// reliable predictions), within hard bounds, with a cooldown and a real
// evidence-backed improvement margin required before acting. Never
// loosened automatically — that always needs a human decision.
//
// Writes ONLY to score_model_tuning_state / score_model_tuning_log (see
// supabase/migrations/006_score_prediction_tuning.sql) — never edits a
// .mjs file, never commits to git, never opens a PR. Every change is
// logged with the evidence that justified it and reversible at any time
// via Supabase's Table Editor. scripts/generate-score-predictions.mjs
// reads whatever this script last wrote at the start of every run.
//
// BACKTEST METHOD: score_predictions rows store home_team_sample_size /
// away_team_sample_size — the ACTUAL graded-match counts the model found
// for each side that day (see scripts/generate-score-predictions.mjs),
// not just the threshold that happened to be live. This lets this script
// simulate "what would the hit rate have looked like at a HIGHER
// threshold" by filtering already-graded rows to
// min(home_sample, away_sample) >= candidate, rather than crudely
// comparing whole days that ran under different thresholds (which would
// be confounded by which leagues/fixtures happened to occur on which day)
// — same rigor scripts/self-tune.mjs already applies to ticket confidence.
//
// Run weekly via .github/workflows/self-tune-score-model.yml, or
// manually. Needs real weeks of graded predictions to have any real
// chance of clearing minSampleSize below — early on this will mostly log
// "no move this round," which is correct and expected, not a bug.
// ---------------------------------------------------------------------------
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';

const LOOKBACK_DAYS = 30;

// ---------------------------------------------------------------------------
// BOUNDS — the only parameter this script may touch, and exactly how far.
//   step               — how much a single adjustment raises the value
//   min / max          — hard bounds; a move is skipped once already at max.
//                         `min` matches DEFAULT_MIN_SAMPLE_MATCHES in
//                         teamModel.mjs — this script never needs to go
//                         below the model's own baseline floor.
//   cooldownDays       — minimum real-world gap since the last automatic
//                         change to this parameter.
//   minSampleSize      — minimum DECIDED (correct+incorrect) predictions
//                         the CANDIDATE (post-move) threshold must still
//                         clear over the lookback window — a move is
//                         skipped if it would leave too little evidence.
//   improvementMarginPct — minimum hit-rate improvement (percentage
//                         points) the candidate must show over the
//                         current threshold before this script will act.
// ---------------------------------------------------------------------------
const BOUNDS = {
  step: 1,
  min: 5,
  max: 12,
  cooldownDays: 14,
  minSampleSize: 150,
  improvementMarginPct: 2,
};

function pct(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : null;
}

async function lastTuneDate(supabase) {
  const { data, error } = await supabase
    .from('score_model_tuning_log')
    .select('created_at')
    .eq('parameter', 'min_sample_matches')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return new Date(data.created_at);
}

async function main() {
  const supabase = getSupabaseAdmin();

  const { data: state, error: stateErr } = await supabase
    .from('score_model_tuning_state')
    .select('*')
    .eq('id', 1)
    .single();
  if (stateErr || !state) {
    throw new Error('Could not read score_model_tuning_state — has migration 006 been applied?');
  }

  const current = state.min_sample_matches;
  if (current >= BOUNDS.max) {
    console.log(`min_sample_matches is already at its max (${BOUNDS.max}) — nothing to do.`);
    return;
  }

  const lastTune = await lastTuneDate(supabase);
  if (lastTune) {
    const daysSince = (Date.now() - lastTune.getTime()) / (24 * 60 * 60 * 1000);
    if (daysSince < BOUNDS.cooldownDays) {
      console.log(
        `Last tuned ${daysSince.toFixed(1)} day(s) ago — within the ${BOUNDS.cooldownDays}-day cooldown, skipping.`
      );
      return;
    }
  }

  const cutoffISO = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: rowsData, error: rowsErr } = await supabase
    .from('score_predictions')
    .select('result_status, home_team_sample_size, away_team_sample_size')
    .in('result_status', ['correct', 'incorrect'])
    .gte('kickoff', cutoffISO)
    .not('home_team_sample_size', 'is', null)
    .not('away_team_sample_size', 'is', null)
    .limit(5000);
  if (rowsErr) throw rowsErr;

  const rows = rowsData ?? [];
  console.log(`Evaluating ${rows.length} decided score prediction(s) from the last ${LOOKBACK_DAYS} days.`);

  const candidate = Math.min(BOUNDS.max, current + BOUNDS.step);

  const atCurrent = rows.filter((r) => Math.min(r.home_team_sample_size, r.away_team_sample_size) >= current);
  const atCandidate = rows.filter((r) => Math.min(r.home_team_sample_size, r.away_team_sample_size) >= candidate);

  const hitRateCurrent = pct(atCurrent.filter((r) => r.result_status === 'correct').length, atCurrent.length);
  const hitRateCandidate = pct(atCandidate.filter((r) => r.result_status === 'correct').length, atCandidate.length);

  if (hitRateCurrent === null || hitRateCandidate === null) {
    console.log('Not enough decided predictions at either threshold yet — no move this round.');
    return;
  }
  if (atCandidate.length < BOUNDS.minSampleSize) {
    console.log(
      `Candidate threshold (${candidate}) only has ${atCandidate.length} decided prediction(s) — ` +
        `below the ${BOUNDS.minSampleSize} minimum, no move this round.`
    );
    return;
  }
  if (hitRateCandidate - hitRateCurrent < BOUNDS.improvementMarginPct) {
    console.log(
      `Candidate threshold (${candidate}) hit rate ${hitRateCandidate}% doesn't beat current (${current}) ` +
        `hit rate ${hitRateCurrent}% by the required ${BOUNDS.improvementMarginPct}pp margin — no move this round.`
    );
    return;
  }

  const reason =
    `Raised min_sample_matches from ${current} to ${candidate} — predictions where both teams had ` +
    `${candidate}+ graded matches hit ${hitRateCandidate}% (n=${atCandidate.length}) vs ${hitRateCurrent}% ` +
    `at the current ${current}+ floor (n=${atCurrent.length}), over the last ${LOOKBACK_DAYS} days.`;

  const { error: updateErr } = await supabase
    .from('score_model_tuning_state')
    .update({ min_sample_matches: candidate, updated_at: new Date().toISOString(), last_tuned_reason: reason })
    .eq('id', 1);
  if (updateErr) throw updateErr;

  const { error: logErr } = await supabase.from('score_model_tuning_log').insert({
    parameter: 'min_sample_matches',
    old_value: current,
    new_value: candidate,
    direction: 'up',
    hit_rate_before: hitRateCurrent,
    sample_size: atCandidate.length,
    reason,
  });
  if (logErr) throw logErr;

  console.log(`✅ Tuned min_sample_matches: ${current} → ${candidate}. ${reason}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
