'use client';

import { useEffect, useState } from 'react';
import {
  fetchCorrectScorePredictions,
  summarizeRecord,
  type CorrectScorePrediction,
} from '@/lib/correctScores';

// Same palette/typography as src/app/page.tsx so this reads as part of the app.
const COLORS = {
  bg: '#f4f6f5',
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
  return `${Math.round(p * 1000) / 10}%`;
}

function PredictionCard({ p }: { p: CorrectScorePrediction }) {
  const graded = p.status !== 'pending';
  const accent = p.status === 'hit' ? COLORS.emerald : p.status === 'miss' ? (p.top3Hit ? COLORS.amber : COLORS.red) : COLORS.border;

  return (
    <div
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: 12,
        padding: '14px 14px 12px',
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.textPrimary }}>
        {p.homeTeam} vs {p.awayTeam}
      </div>
      <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: 2 }}>
        {p.league} ({p.country}) · {formatKickoff(p.kickoff)}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {p.topScores.map((s, i) => {
          const isExact = graded && s.home === p.finalHomeScore && s.away === p.finalAwayScore;
          return (
            <div
              key={`${s.home}-${s.away}`}
              style={{
                flex: 1,
                textAlign: 'center',
                borderRadius: 9,
                padding: '9px 4px',
                border: `1px solid ${isExact ? COLORS.emerald : COLORS.border}`,
                background: isExact ? COLORS.emerald : i === 0 ? 'rgba(11,138,79,0.08)' : COLORS.surfaceAlt,
                color: isExact ? '#ffffff' : COLORS.textPrimary,
              }}
            >
              <div style={{ fontSize: i === 0 ? 20 : 17, fontWeight: 800, lineHeight: 1.1 }}>
                {s.home}-{s.away}
              </div>
              <div style={{ fontSize: 10.5, marginTop: 3, color: isExact ? '#ffffff' : COLORS.textMuted }}>
                {pct(s.probability)}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 11, color: COLORS.textMuted }}>
        <span>
          Expected goals {p.homeXG.toFixed(2)} – {p.awayXG.toFixed(2)}
        </span>
        {graded && (
          <span style={{ fontWeight: 700, color: accent }}>
            FT {p.finalHomeScore}-{p.finalAwayScore}
            {p.status === 'hit' ? ' · top pick landed' : p.top3Hit ? ' · landed, not top pick' : ' · missed'}
          </span>
        )}
      </div>
    </div>
  );
}

export default function CorrectScoresPage() {
  const [predictions, setPredictions] = useState<CorrectScorePrediction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchCorrectScorePredictions()
      .then(setPredictions)
      .finally(() => setLoading(false));
  }, []);

  const upcoming = predictions.filter((p) => p.status === 'pending');
  const settled = predictions.filter((p) => p.status !== 'pending').reverse(); // newest first
  const record = summarizeRecord(predictions);

  return (
    <div style={{ minHeight: '100vh', background: COLORS.bg, color: COLORS.textPrimary, fontFamily: FONT, paddingBottom: 40 }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          background: COLORS.emerald,
          padding: '14px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ color: '#ffffff', fontWeight: 800, fontSize: 17 }}>Correct scores</span>
        <a href="/" style={{ color: '#ffffff', fontSize: 12, fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: 3 }}>
          Back to tickets
        </a>
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: 16 }}>
        <p style={{ fontSize: 13, lineHeight: 1.6, color: COLORS.textMuted, margin: '0 0 14px' }}>
          The three most likely exact scores for each match, from a goals model built on each team's recent home and
          away results. Even the top score usually has only a 10–15% chance, so treat these as probabilities, not
          predictions you can rely on.
        </p>

        <div
          style={{
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 12,
            padding: '12px 14px',
            marginBottom: 18,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Track record, last 14 days</div>
          {record.graded === 0 ? (
            <div style={{ fontSize: 12, color: COLORS.textMuted }}>No graded matches yet.</div>
          ) : (
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: COLORS.emerald }}>
                  {Math.round((record.topHits / record.graded) * 100)}%
                </div>
                <div style={{ fontSize: 11, color: COLORS.textMuted }}>
                  top pick exact ({record.topHits} of {record.graded})
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: COLORS.emerald }}>
                  {Math.round((record.top3Hits / record.graded) * 100)}%
                </div>
                <div style={{ fontSize: 11, color: COLORS.textMuted }}>
                  any of the three ({record.top3Hits} of {record.graded})
                </div>
              </div>
            </div>
          )}
        </div>

        {loading && <div style={{ fontSize: 13, color: COLORS.textMuted }}>Loading predictions…</div>}

        {!loading && predictions.length === 0 && (
          <div style={{ fontSize: 13, lineHeight: 1.6, color: COLORS.textMuted, textAlign: 'center', padding: '30px 8px' }}>
            No correct-score predictions yet. A match only appears once both teams have enough recent home and away
            results on record.
          </div>
        )}

        {upcoming.length > 0 && (
          <>
            <h2 style={{ fontSize: 15, fontWeight: 800, margin: '0 0 10px' }}>Upcoming</h2>
            {upcoming.map((p) => (
              <PredictionCard key={p.fixtureId} p={p} />
            ))}
          </>
        )}

        {settled.length > 0 && (
          <>
            <h2 style={{ fontSize: 15, fontWeight: 800, margin: '18px 0 10px' }}>Settled</h2>
            {settled.map((p) => (
              <PredictionCard key={p.fixtureId} p={p} />
            ))}
          </>
        )}

        <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginTop: 20, lineHeight: 1.6 }}>
          Odd Saint provides statistical analysis, never a guarantee of any result. Scores are settled on the
          90-minute result.
        </div>
      </div>
    </div>
  );
}
