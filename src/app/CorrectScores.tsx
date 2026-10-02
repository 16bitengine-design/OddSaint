'use client';

// ---------------------------------------------------------------------------
// Odd Saint — correct-score predictions section
// Standalone display shell (same "not folded into page.tsx" pattern as
// SatisfactionWidget.tsx). Data comes from fetchCorrectScores /
// fetchCorrectScoreStats in src/lib/dataFetcher.ts; `unlocked` is computed
// by the caller using the same rule as a standard ticket (admin / signed-in
// / trial active).
// ---------------------------------------------------------------------------
import { useState } from 'react';
import type { CorrectScorePrediction, CorrectScoreStats } from '@/lib/dataFetcher';

const COLORS = {
  surface: '#ffffff',
  surfaceAlt: '#eef1ef',
  border: '#d7dedb',
  hairline: '#c3ccc7',
  emerald: '#0b8a4f',
  amber: '#e08e00',
  red: '#d3321f',
  textPrimary: '#12241c',
  textMuted: '#5c6b63',
};
const FONT = 'var(--font-body), system-ui, -apple-system, sans-serif';
const COLLAPSED_COUNT = 12;
const LOCKED_PREVIEW_COUNT = 2;

function formatKickoff(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
  if (date.toDateString() === now.toDateString()) return `Today ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
  return `${day}, ${time}`;
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function PredictionRow({ prediction, blurred }: { prediction: CorrectScorePrediction; blurred: boolean }) {
  const [top, ...others] = prediction.topScores;
  const graded = prediction.status !== 'pending';
  const hit = prediction.status === 'hit';
  const inTop3 = prediction.status === 'miss' && prediction.top3Hit === true;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '11px 0',
        borderBottom: `1px solid ${COLORS.border}`,
        filter: blurred ? 'blur(5px)' : 'none',
        userSelect: blurred ? 'none' : 'auto',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 13,
            fontWeight: 500,
            color: COLORS.textPrimary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {prediction.homeTeam} vs {prediction.awayTeam}
        </div>
        <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 1 }}>
          {prediction.league} ({prediction.country})
        </div>
        {graded && prediction.finalHomeScore !== undefined && prediction.finalAwayScore !== undefined ? (
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              marginTop: 2,
              color: hit ? COLORS.emerald : inTop3 ? COLORS.amber : COLORS.red,
            }}
          >
            FT {prediction.finalHomeScore}-{prediction.finalAwayScore} ·{' '}
            {hit ? 'Exact ✓' : inTop3 ? 'Missed top pick, in top 3' : 'Missed'}
          </div>
        ) : (
          <div style={{ fontSize: 10.5, color: COLORS.emerald, marginTop: 2, fontWeight: 600 }}>
            {formatKickoff(prediction.kickoff)}
          </div>
        )}
      </div>

      {top && (
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div
            style={{
              fontFamily: FONT,
              fontSize: 15,
              fontWeight: 800,
              color: COLORS.emerald,
              background: 'rgba(11,138,79,0.1)',
              borderRadius: 6,
              padding: '3px 10px',
              display: 'inline-block',
            }}
          >
            {top.home}-{top.away}
          </div>
          <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 3 }}>
            {pct(top.probability)}
            {others.length > 0 && ' · also '}
            {others.map((s) => `${s.home}-${s.away}`).join(', ')}
          </div>
        </div>
      )}
    </div>
  );
}

export function CorrectScoresSection({
  predictions,
  stats,
  unlocked,
  loading,
  onSignUp,
}: {
  predictions: CorrectScorePrediction[];
  stats: CorrectScoreStats | null;
  unlocked: boolean;
  loading: boolean;
  onSignUp: () => void;
}) {
  const [showAll, setShowAll] = useState(false);

  if (loading) return null;
  if (predictions.length === 0 && (!stats || stats.graded === 0)) return null;

  const visible = unlocked
    ? showAll
      ? predictions
      : predictions.slice(0, COLLAPSED_COUNT)
    : predictions.slice(0, LOCKED_PREVIEW_COUNT);

  return (
    <div
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 14,
        padding: '17px 16px 14px',
        marginTop: 6,
        marginBottom: 14,
      }}
    >
      <div style={{ fontFamily: FONT, fontSize: 16.5, fontWeight: 600, color: COLORS.textPrimary }}>
        Correct scores
      </div>
      <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: 3, lineHeight: 1.5 }}>
        The model's three most likely exact scorelines per match. Exact scores are rare — even the top pick
        usually carries a probability near 10–15%.
      </div>

      {stats && stats.graded > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            margin: '12px 0 4px',
          }}
        >
          <div style={{ background: COLORS.surfaceAlt, borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontFamily: FONT, fontSize: 16, fontWeight: 800, color: COLORS.textPrimary }}>
              {stats.topHitRatePct}%
            </div>
            <div style={{ fontSize: 9.5, color: COLORS.textMuted }}>top pick exact · last {stats.windowDays}d</div>
          </div>
          <div style={{ background: COLORS.surfaceAlt, borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontFamily: FONT, fontSize: 16, fontWeight: 800, color: COLORS.textPrimary }}>
              {stats.top3HitRatePct}%
            </div>
            <div style={{ fontSize: 9.5, color: COLORS.textMuted }}>any of top 3 exact</div>
          </div>
          <div style={{ background: COLORS.surfaceAlt, borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontFamily: FONT, fontSize: 16, fontWeight: 800, color: COLORS.textPrimary }}>
              {stats.graded}
            </div>
            <div style={{ fontSize: 9.5, color: COLORS.textMuted }}>graded predictions</div>
          </div>
        </div>
      )}

      {predictions.length === 0 ? (
        <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '12px 0 4px' }}>
          No correct-score predictions for today yet — check back after the next update.
        </div>
      ) : (
        <div style={{ marginTop: 6 }}>
          {visible.map((p) => (
            <PredictionRow key={p.fixtureId} prediction={p} blurred={!unlocked} />
          ))}

          {!unlocked && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12.5, color: COLORS.textMuted, textAlign: 'center', marginBottom: 8 }}>
                Your free trial has ended.
              </div>
              <button
                onClick={onSignUp}
                style={{
                  width: '100%',
                  padding: '11px 0',
                  borderRadius: 9,
                  border: 'none',
                  fontFamily: FONT,
                  fontWeight: 600,
                  fontSize: 13,
                  background: COLORS.emerald,
                  color: '#ffffff',
                  cursor: 'pointer',
                }}
              >
                Sign up free to unlock
              </button>
            </div>
          )}

          {unlocked && predictions.length > COLLAPSED_COUNT && (
            <button
              onClick={() => setShowAll((s) => !s)}
              style={{
                marginTop: 10,
                background: 'none',
                border: 'none',
                padding: 0,
                color: COLORS.emerald,
                fontFamily: FONT,
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: 3,
              }}
            >
              {showAll ? 'Show fewer' : `Show all ${predictions.length} matches`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
