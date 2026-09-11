// ---------------------------------------------------------------------------
// Odd Saint — model cross-check adapter
//
// ⚠️ VERIFY BEFORE RELYING ON THIS: I don't have the actual contents of
// scripts/lib/teamModel.mjs in front of me — only your own description of
// it (Poisson/expected-goals model, reads the `team_match_history` view,
// returns `available: false` under MIN_SAMPLE_MATCHES = 5 graded
// matches). This adapter ASSUMES teamModel.mjs exports something along
// these lines:
//
//   export async function computeMatchProbabilities(homeTeam, awayTeam) {
//     // returns:
//     // {
//     //   available: boolean,
//     //   homeWinProb: number,   // 0..1
//     //   awayWinProb: number,
//     //   drawProb: number,
//     //   over15Prob: number,
//     //   over25Prob: number,
//     //   over35Prob: number,
//     //   bttsYesProb: number,
//     // }
//   }
//
// If the real export name or shape differs, THIS is the only file that
// needs to change — fix the import below and probabilityForMarket()'s
// field lookups, and nothing in generate-tickets.mjs or self-tune.mjs
// needs to know the difference. Paste teamModel.mjs's real exports back
// and this file gets corrected in one pass instead of guessing further.
// ---------------------------------------------------------------------------
import { computeMatchProbabilities } from './teamModel.mjs';

// Maps a chosen market label (from scripts/lib/markets.mjs) to the
// matching probability field on whatever computeMatchProbabilities()
// returns. Double Chance markets are derived by summing components,
// since the model likely doesn't compute them directly — adjust if
// teamModel.mjs already exposes them natively.
function probabilityForMarket(modelOutput, marketLabel) {
  const {
    homeWinProb = null,
    awayWinProb = null,
    drawProb = null,
    over15Prob = null,
    over25Prob = null,
    over35Prob = null,
    bttsYesProb = null,
  } = modelOutput ?? {};

  switch (marketLabel) {
    case 'Home Win':
      return homeWinProb;
    case 'Away Win':
      return awayWinProb;
    case 'Over 1.5 Goals':
      return over15Prob;
    case 'Under 1.5 Goals':
      return over15Prob !== null ? 1 - over15Prob : null;
    case 'Over 2.5 Goals':
      return over25Prob;
    case 'Under 2.5 Goals':
      return over25Prob !== null ? 1 - over25Prob : null;
    case 'Over 3.5 Goals':
      return over35Prob;
    case 'BTTS - Yes':
      return bttsYesProb;
    case 'BTTS - No':
      return bttsYesProb !== null ? 1 - bttsYesProb : null;
    case 'Double Chance 1X':
      return homeWinProb !== null && drawProb !== null ? homeWinProb + drawProb : null;
    case 'Double Chance X2':
      return awayWinProb !== null && drawProb !== null ? awayWinProb + drawProb : null;
    case 'Double Chance 12':
      return homeWinProb !== null && awayWinProb !== null ? homeWinProb + awayWinProb : null;
    default:
      return null; // unrecognized market — no cross-check possible
  }
}

/**
 * Cross-checks a bookmaker-derived pick against the Poisson model —
 * CROSS-CHECK ONLY. This never influences which market gets picked,
 * never changes the confidence used for selection, and never touches
 * grading. It exists purely so scripts/self-tune.mjs and scripts/
 * propose-improvements.mjs have a second, independent signal to look for
 * systematic disagreement in later analysis.
 *
 * Fails safe: any error (model not ready, team not found, malformed
 * response, etc.) returns { available: false, probability: null } rather
 * than throwing — a cross-check signal must never be able to break real
 * ticket generation.
 */
export async function getModelCrossCheck(homeTeam, awayTeam, marketLabel) {
  try {
    const modelOutput = await computeMatchProbabilities(homeTeam, awayTeam);
    if (!modelOutput?.available) return { available: false, probability: null };

    const probability = probabilityForMarket(modelOutput, marketLabel);
    if (probability === null || !Number.isFinite(probability)) {
      return { available: false, probability: null };
    }
    return { available: true, probability };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`Model cross-check failed for ${homeTeam} vs ${awayTeam} (${marketLabel}):`, err.message);
    return { available: false, probability: null };
  }
}
