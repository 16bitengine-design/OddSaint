'use client';

// ---------------------------------------------------------------------------
// Odd Saint — daily exact-score predictions
// Standalone section (same "small, not folded into page.tsx" pattern as
// SatisfactionWidget.tsx) showing every eligible fixture's predicted final
// scoreline for the day — see scripts/generate-score-predictions.mjs and
// scripts/lib/teamModel.mjs. Deliberately BROADER than the tier tickets:
// covers every fixture the team model had enough history for, not just
// fixtures picked for a ticket.
//
// ACCESS: same gating as a standard ticket (admin / signed-in / trial
// active) — NOT always-free like Mega Day, and NOT sign-up-mandatory like
// Saint's Lock. `unlocked` is computed by the caller (src/app/page.tsx)
// using the same rule TicketCard already uses, so this component stays a
// pure display + blur/prompt shell rather than re-deriving access logic.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import type { ScorePrediction } from '@/lib/dataFetcher';

const COLORS = {
  surface: '#ffffff',
  surfaceAlt: '#eef1ef',
  border: '#d7dedb',
  hairline: '#c3ccc7',
  emerald: '#0b8a4f',
  red: '#d3321f',
  textPrimary: '#12241c',
  textMuted: '#5c6b63',
};
const FONT_DISPLAY = 'var(--font-body), system-ui, -apple-system, sans-serif';
const FONT_BODY = 'var(--font-body), system-ui, -apple-system, sans-serif';

/** Same relative-day formatting as formatKickoff in page.tsx — kept local since page.tsx doesn't export it. */
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

function StatusPill({ status }: { status: ScorePrediction['status'] }) {
  if (status === 'pending') return null;
  const correct = status === 'correct';
  return (
    <span
      style={{
        fontFamily: FONT_BODY,
        fontSize: 9.5,
        fontWeight: 800,
        padding: '2px 7px',
        borderRadius: 999,
        color: '#ffffff',
        background: correct ? COLORS.emerald : COLORS.red,
        flexShrink: 0,
      }}
    >
      {correct ? 'EXACT ✓' : 'MISS'}
    </span>
  );
}

function PredictionRow({ prediction }: { prediction: ScorePrediction }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        padding: '11px 0',
        borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontFamily: FONT_BODY,
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
        <div style={{ fontSize: 10.5, color: COLORS.emerald, marginTop: 2, fontWeight: 600 }}>
          {formatKickoff(prediction.kickoff)}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <StatusPill status={prediction.status} />
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 15,
            fontWeight: 800,
            color: COLORS.textPrimary,
            background: COLORS.surfaceAlt,
            borderRadius: 7,
            padding: '5px 11px',
          }}
        >
          {prediction.predictedHomeScore}-{prediction.predictedAwayScore}
        </div>
      </div>
    </div>
  );
}

export function ScorePredictionsSection({
  predictions,
  unlocked,
  onSignUp,
}: {
  predictions: ScorePrediction[];
  unlocked: boolean;
  onSignUp: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (predictions.length === 0) return null;

  return (
    <div
      style={{
        background: COLORS.surface,
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: 14,
        padding: '17px 16px 16px',
        marginBottom: 14,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          background: 'none',
          border: 'none',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          color: 'inherit',
        }}
      >
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16.5, fontWeight: 600, color: COLORS.textPrimary }}>
            Today's Exact Score Predictions
          </div>
          <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: 3 }}>
            {predictions.length} match{predictions.length === 1 ? '' : 'es'} — model's single most likely final score
          </div>
        </div>
        <span style={{ color: COLORS.textMuted, fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 14 }}>
          {unlocked ? (
            <div>
              {predictions.map((p) => (
                <PredictionRow key={p.fixtureId} prediction={p} />
              ))}
            </div>
          ) : (
            <div
              style={{
                position: 'relative',
                border: `1px dashed ${COLORS.border}`,
                borderRadius: 10,
                padding: 16,
              }}
            >
              <div style={{ filter: 'blur(5px)', pointerEvents: 'none' }}>
                {predictions.slice(0, 3).map((p) => (
                  <PredictionRow key={p.fixtureId} prediction={p} />
                ))}
              </div>
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontFamily: FONT_DISPLAY, fontSize: 12.5, color: COLORS.textMuted, textAlign: 'center' }}>
                  Your free trial has ended.
                </div>
                <button
                  onClick={onSignUp}
                  style={{
                    padding: '11px 0',
                    borderRadius: 9,
                    border: 'none',
                    fontFamily: FONT_BODY,
                    fontWeight: 600,
                    fontSize: 13,
                    background: `linear-gradient(135deg, ${COLORS.emerald}, #0d9668)`,
                    color: '#04150f',
                    cursor: 'pointer',
                  }}
                >
                  Sign up free to unlock
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 12, lineHeight: 1.5 }}>
        Model's own most-likely scoreline per match — a statistical opinion, not a guarantee. Exact-score
        predictions are inherently low-probability; treat these as analysis, not a promise.
      </div>
    </div>
  );
}
