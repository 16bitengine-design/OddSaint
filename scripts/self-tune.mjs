// ---------------------------------------------------------------------------
// Odd Saint — bounded auto-tuning
//
// This script is allowed to change a small, explicit set of numeric
// parameters automatically — but ONLY in the "safer" direction (raising a
// confidence floor, tightening an odds ceiling), and only within
// hardcoded bounds, with a cooldown between changes and a minimum sample
// size before it will act. It NEVER loosens a threshold automatically —
// that always requires a human to review scripts/propose-improvements.mjs's
// output and decide. This mirrors the existing project principle: only
// raise MIN_CONFIDENCE or tighten selection logic to genuinely improve
// quality, backed by real data — never falsify grading, never guess.
//
// What this touches: the `tuning_state` table only (see migration
// supabase/migrations/004_self_improvement.sql). It never edits any .mjs
// file, never commits to git, never opens a PR — there is nothing here
// that needs `contents: write` permission. Every change is logged to
// `tuning_log` with the evidence that justified it, and reversible at any
// time via Supabase's Table Editor.
//
// Run on a schedule via .github/workflows/self-tune.yml (weekly, after
// grade-tickets.mjs has had a week to settle new results) or manually.
// ---------------------------------------------------------------------------
import { getSupabaseAdmin } from './lib/supabaseAdmin.mjs';

const LOOKBACK_DAYS = 30;

// ---------------------------------------------------------------------------
// TUNING_BOUNDS — the ONLY parameters this script is allowed to touch, and
// exactly how far. Changing what's tunable, or how aggressively, is a
// judgment call that belongs in a code review (a diff to this file), not
// something the script can decide for itself — that asymmetry is
// deliberate.
//
//   step               — how much a single adjustment moves the value
//   safeDirection      — the ONLY direction this script may move the
//                         value automatically ('up' or 'down') — purely
//                         documentation here, the evaluator functions
//                         below each hardcode their one allowed direction
//   min / max          — hard bounds; a move is skipped once already at
//                         the relevant bound
//   cooldownDays       — minimum real-world gap since the last automatic
//                         change to this same parameter
//   minSampleSize      — minimum number of graded fixtures the CANDIDATE
//                         (post-move) threshold must still have cleared
//                         over the lookback window — a move is skipped if
//                         it would starve ticket generation of data
//   improvementMargin  — minimum win-rate improvement (percentage points)
//                         the candidate threshold must show over the
//                         current one before this script will act
// ---------------------------------------------------------------------------
const TUNING_BOUNDS = {
  min_confidence: {
    step: 2,
    safeDirection: 'up',
    min: 60,
    max: 82,
    cooldownDays: 7,
    minSampleSize: 40,
    improvementMargin: 3,
  },
  small_ticket_max_odds: {
    step: 0.05,
    safeDirection: 'down', // safer = tighter = lower max odds for small tiers
    min: 1.4,
    max: 2.0,
    cooldownDays: 14,
    minSampleSize: 30,
    improvementMargin: 3,
  },
  saints_lock_min_confidence: {
    step: 1,
    safeDirection: 'up',
    min: 80,
    max: 92,
    cooldownDays: 14,
    minSampleSize: 10,
    improvementMargin: 2,
  },
};

function pct(wins, total) {
  return total > 0 ? Math.round((wins / total) * 1000) / 10 : null;
}

async function fetchGradedFixtures(supabase, cutoffISO) {
  const { data, error } = await supabase
    .from('fixtures')
    .select('confidence, odds, result_status, kickoff, model_probability, model_available')
    .in('result_status', ['green', 'red'])
    .gte('kickoff', cutoffISO)
    .limit(5000);
  if (error) throw error;
  return data ?? [];
}

async function lastTuneDate(supabase, parameter) {
  const { data, error } = await supabase
    .from('tuning_log')
    .select('created_at')
    .eq('parameter', parameter)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return new Date(data.created_at);
}

async function getTuningState(supabase) {
  const { data, error } = await supabase.from('tuning_state').select('*').eq('id', 1).single();
  if (error || !data) throw new Error('Could not read tuning_state — has migration 004 been applied?');
  return data;
}

async function applyTune(supabase, parameter, oldValue, newValue, winRateBefore, sampleSize, reason) {
  const direction = newValue > oldValue ? 'up' : 'down';

  const { error: updateErr } = await supabase
    .from('tuning_state')
    .update({
      [parameter]: newValue,
      updated_at: new Date().toISOString(),
      last_tuned_reason: reason,
    })
    .eq('id', 1);
  if (updateErr) throw updateErr;

  const { error: logErr } = await supabase.from('tuning_log').insert({
    parameter,
    old_value: oldValue,
    new_value: newValue,
    direction,
    win_rate_before: winRateBefore,
    sample_size: sampleSize,
    reason,
  });
  if (logErr) throw logErr;

  console.log(`✅ Tuned ${parameter}: ${oldValue} → ${newValue}. ${reason}`);
}

// --- Individual parameter evaluators -----------------------------------------

/**
 * MIN_CONFIDENCE: only ever raised. Compares the observed win rate among
 * fixtures that cleared the CURRENT threshold vs. fixtures that would
 * clear a CANDIDATE (one step higher) threshold. Raises only if the
 * candidate threshold shows a real improvement margin AND still has
 * enough sample size to keep tickets flowing.
 */
function evaluateMinConfidence(fixtures, state) {
  const bounds = TUNING_BOUNDS.min_confidence;
  const current = state.min_confidence;
  if (current >= bounds.max) return null;

  const candidate = Math.min(bounds.max, current + bounds.step);

  const atCurrent = fixtures.filter((f) => f.confidence >= current);
  const atCandidate = fixtures.filter((f) => f.confidence >= candidate);

  const winRateCurrent = pct(atCurrent.filter((f) => f.result_status === 'green').length, atCurrent.length);
  const winRateCandidate = pct(atCandidate.filter((f) => f.result_status === 'green').length, atCandidate.length);

  if (winRateCurrent === null || winRateCandidate === null) return null;
  if (atCandidate.length < bounds.minSampleSize) return null;
  if (winRateCandidate - winRateCurrent < bounds.improvementMargin) return null;

  // Model cross-check sanity gate: if the model has an opinion on a
  // meaningful share of the candidate set and its own implied win rate
  // for those same fixtures is dramatically lower than the observed one,
  // that's a sign the observed sample might be a lucky streak rather
  // than a real signal — skip this round rather than lock in a fluke.
  const withModel = atCandidate.filter((f) => f.model_available && f.model_probability !== null);
  if (withModel.length >= 10) {
    const modelAvgProb = withModel.reduce((acc, f) => acc + f.model_probability, 0) / withModel.length;
    const modelImpliedPct = Math.round(modelAvgProb * 1000) / 10;
    if (winRateCandidate - modelImpliedPct > 15) {
      console.log(
        `min_confidence: skipping raise — model cross-check disagrees enough to be cautious ` +
          `(observed ${winRateCandidate}% vs model-implied ${modelImpliedPct}% over ${withModel.length} cross-checked fixtures).`
      );
      return null;
    }
  }

  return {
    parameter: 'min_confidence',
    oldValue: current,
    newValue: candidate,
    winRateBefore: winRateCurrent,
    sampleSize: atCandidate.length,
    reason:
      `Raised from ${current}% to ${candidate}% — fixtures clearing ${candidate}%+ won ${winRateCandidate}% ` +
      `(n=${atCandidate.length}) vs ${winRateCurrent}% at the current ${current}% floor, over the last ${LOOKBACK_DAYS} days.`,
  };
}

/**
 * SMALL_TICKET_MAX_ODDS: only ever lowered (tightened). Compares win rate
 * of legs priced just under the current cap vs. legs priced in the band
 * that a lower cap would exclude. This approximates "small ticket" legs
 * using the same odds ceiling the real pipeline applies (see poolForTier
 * in generate-tickets.mjs), since fixtures rows don't carry a tier label
 * directly.
 */
function evaluateSmallTicketMaxOdds(fixtures, state) {
  const bounds = TUNING_BOUNDS.small_ticket_max_odds;
  const current = state.small_ticket_max_odds;
  if (current <= bounds.min) return null;

  const candidate = Math.max(bounds.min, Math.round((current - bounds.step) * 100) / 100);

  const underCandidate = fixtures.filter((f) => f.odds <= candidate);
  const betweenCandidateAndCurrent = fixtures.filter((f) => f.odds > candidate && f.odds <= current);

  const winRateKept = pct(underCandidate.filter((f) => f.result_status === 'green').length, underCandidate.length);
  const winRateExcluded = pct(
    betweenCandidateAndCurrent.filter((f) => f.result_status === 'green').length,
    betweenCandidateAndCurrent.length
  );

  if (winRateKept === null || winRateExcluded === null) return null;
  if (underCandidate.length < bounds.minSampleSize) return null;
  if (winRateKept - winRateExcluded < bounds.improvementMargin) return null;

  return {
    parameter: 'small_ticket_max_odds',
    oldValue: current,
    newValue: candidate,
    winRateBefore: winRateExcluded,
    sampleSize: underCandidate.length,
    reason:
      `Tightened from ${current} to ${candidate} — legs at/under ${candidate} won ${winRateKept}% ` +
      `(n=${underCandidate.length}) vs ${winRateExcluded}% for legs between ${candidate} and ${current}, ` +
      `over the last ${LOOKBACK_DAYS} days.`,
  };
}

/**
 * SAINTS_LOCK_MIN_CONFIDENCE: only ever raised, same logic as
 * min_confidence but scoped to the Saint's Lock odds band (1.5-2.0) since
 * that's the only band it ever draws from.
 */
function evaluateSaintsLockMinConfidence(fixtures, state) {
  const bounds = TUNING_BOUNDS.saints_lock_min_confidence;
  const current = state.saints_lock_min_confidence;
  if (current >= bounds.max) return null;

  const candidate = Math.min(bounds.max, current + bounds.step);

  const inBand = fixtures.filter((f) => f.odds >= 1.5 && f.odds <= 2.0);
  const atCurrent = inBand.filter((f) => f.confidence >= current);
  const atCandidate = inBand.filter((f) => f.confidence >= candidate);

  const winRateCurrent = pct(atCurrent.filter((f) => f.result_status === 'green').length, atCurrent.length);
  const winRateCandidate = pct(atCandidate.filter((f) => f.result_status === 'green').length, atCandidate.length);

  if (winRateCurrent === null || winRateCandidate === null) return null;
  if (atCandidate.length < bounds.minSampleSize) return null;
  if (winRateCandidate - winRateCurrent < bounds.improvementMargin) return null;

  return {
    parameter: 'saints_lock_min_confidence',
    oldValue: current,
    newValue: candidate,
    winRateBefore: winRateCurrent,
    sampleSize: atCandidate.length,
    reason:
      `Raised from ${current}% to ${candidate}% — Saint's Lock-eligible (1.5-2.0 odds) fixtures clearing ` +
      `${candidate}%+ won ${winRateCandidate}% (n=${atCandidate.length}) vs ${winRateCurrent}% at ${current}%, ` +
      `over the last ${LOOKBACK_DAYS} days.`,
  };
}

// --- Main ---------------------------------------------------------------------

async function main() {
  const supabase = getSupabaseAdmin();
  const cutoffISO = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const state = await getTuningState(supabase);
  const fixtures = await fetchGradedFixtures(supabase, cutoffISO);
  console.log(`Evaluating ${fixtures.length} graded fixture(s) from the last ${LOOKBACK_DAYS} days.`);

  const evaluators = [
    { parameter: 'min_confidence', evaluate: evaluateMinConfidence },
    { parameter: 'small_ticket_max_odds', evaluate: evaluateSmallTicketMaxOdds },
    { parameter: 'saints_lock_min_confidence', evaluate: evaluateSaintsLockMinConfidence },
  ];

  let anyTuned = false;

  for (const { parameter, evaluate } of evaluators) {
    const bounds = TUNING_BOUNDS[parameter];

    const lastTune = await lastTuneDate(supabase, parameter);
    if (lastTune) {
      const daysSince = (Date.now() - lastTune.getTime()) / (24 * 60 * 60 * 1000);
      if (daysSince < bounds.cooldownDays) {
        console.log(
          `${parameter}: last tuned ${daysSince.toFixed(1)} day(s) ago — within the ${bounds.cooldownDays}-day cooldown, skipping.`
        );
        continue;
      }
    }

    const proposal = evaluate(fixtures, state);
    if (!proposal) {
      console.log(`${parameter}: no move this round — evidence didn't clear the bar.`);
      continue;
    }

    await applyTune(
      supabase,
      proposal.parameter,
      proposal.oldValue,
      proposal.newValue,
      proposal.winRateBefore,
      proposal.sampleSize,
      proposal.reason
    );
    anyTuned = true;
  }

  if (!anyTuned) {
    console.log('No parameters tuned this run — everything stayed within safe, evidence-backed bounds as-is.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
