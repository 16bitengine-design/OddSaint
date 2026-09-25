// ---------------------------------------------------------------------------
// Odd Saint — model cross-check adapter
//
// Thin wrapper around scripts/lib/teamModel.mjs's getOwnModelForFixture().
// CROSS-CHECK ONLY: never influences market selection, never changes the
// confidence used for selection, never touches grading. Exists purely so
// self-tune.mjs and propose-improvements.mjs have a second, independent
// signal to compare against.
//
// getOwnModelForFixture() already returns `probabilities` keyed by the same
// market-label strings scripts/lib/markets.mjs uses ('Home Win',
// 'Over 2.5 Goals', 'Double Chance 1X', etc.) — no reconstruction needed,
// just a direct lookup.
//
// FIXES a previous version of this file that imported a
// `computeMatchProbabilities` function which was never actually exported by
// teamModel.mjs (would have thrown at module-load time) and reconstructed
// market probabilities from assumed component fields that don't match
// teamModel.mjs's real return shape.
// ---------------------------------------------------------------------------
import { getOwnModelForFixture } from './teamModel.mjs';

/**
 * Cross-checks a bookmaker-derived pick against the Poisson model.
 *
 * Fails safe: any error, missing team ID, or insufficient sample returns
 * { available: false, probability: null } rather than throwing — a
 * cross-check signal must never be able to break real ticket generation.
 *
 * @param {object} supabase - service-role Supabase client
 * @param {object} params
 * @param {string} params.league
 * @param {number|null} params.homeTeamId - API-Football's own numeric team ID
 * @param {number|null} params.awayTeamId
 * @param {string} [params.homeTeamName]
 * @param {string} [params.awayTeamName]
 * @param {string} params.marketLabel - the market chosen by pickMarketFromOdds, e.g. 'Home Win'
 */
export async function getModelCrossCheck(
  supabase,
  { league, homeTeamId, awayTeamId, homeTeamName, awayTeamName, marketLabel }
) {
  try {
    const result = await getOwnModelForFixture(supabase, {
      league,
      homeTeamId,
      awayTeamId,
      homeTeamName,
      awayTeamName,
    });
    if (!result.available) return { available: false, probability: null };

    const probability = result.probabilities[marketLabel];
    if (probability === undefined || !Number.isFinite(probability)) {
      // Market label the model doesn't speak to (shouldn't normally happen,
      // since probabilitiesFromExpectedGoals covers every label markets.mjs
      // can select) — treat as no cross-check rather than guessing.
      return { available: false, probability: null };
    }
    return { available: true, probability };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `Model cross-check failed for ${homeTeamName ?? homeTeamId} vs ${awayTeamName ?? awayTeamId} (${marketLabel}):`,
      err.message
    );
    return { available: false, probability: null };
  }
}
