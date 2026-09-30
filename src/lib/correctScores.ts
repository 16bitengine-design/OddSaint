// ---------------------------------------------------------------------------
// Odd Saint — correct-score predictions (read side)
// Reads correct_score_predictions (see supabase/migrations/006_correct_scores.sql),
// populated by scripts/generate-correct-scores.mjs. Public read via RLS.
// No mock data: an empty result means nothing has been predicted yet.
// ---------------------------------------------------------------------------
import { supabase } from './supabaseClient';

export interface ScoreLine {
  home: number;
  away: number;
  probability: number; // 0-1, from the Poisson model
}

export interface CorrectScorePrediction {
  fixtureId: number;
  league: string;
  country: string;
  homeTeam: string;
  awayTeam: string;
  kickoff: string;
  topScores: ScoreLine[]; // most likely first
  homeXG: number;
  awayXG: number;
  finalHomeScore: number | null;
  finalAwayScore: number | null;
  status: 'pending' | 'hit' | 'miss';
  top3Hit: boolean | null;
}

const LOOKBACK_DAYS = 14;

export async function fetchCorrectScorePredictions(): Promise<CorrectScorePrediction[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabase
      .from('correct_score_predictions')
      .select(
        'fixture_id, league, country, home_team, away_team, kickoff, top_scores, home_xg, away_xg, final_home_score, final_away_score, result_status, top3_hit'
      )
      .gte('kickoff', since)
      .order('kickoff', { ascending: true })
      .limit(400);
    if (error || !data) return [];

    return data.map((r: any) => ({
      fixtureId: r.fixture_id,
      league: r.league,
      country: r.country,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      kickoff: r.kickoff,
      topScores: (r.top_scores ?? []) as ScoreLine[],
      homeXG: Number(r.home_xg),
      awayXG: Number(r.away_xg),
      finalHomeScore: r.final_home_score,
      finalAwayScore: r.final_away_score,
      status: r.result_status,
      top3Hit: r.top3_hit,
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[Odd Saint] fetchCorrectScorePredictions failed:', err);
    return [];
  }
}

export interface CorrectScoreRecord {
  graded: number;
  topHits: number;
  top3Hits: number;
}

/** Track record over graded predictions only — pending ones never count. */
export function summarizeRecord(predictions: CorrectScorePrediction[]): CorrectScoreRecord {
  const graded = predictions.filter((p) => p.status !== 'pending');
  return {
    graded: graded.length,
    topHits: graded.filter((p) => p.status === 'hit').length,
    top3Hits: graded.filter((p) => p.top3Hit).length,
  };
}
