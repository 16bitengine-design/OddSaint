'use client';

// ---------------------------------------------------------------------------
// Odd Saint — satisfaction rating widget
// Deliberately a small, standalone component (not folded into page.tsx)
// per the "no unnecessary rewrites" rule — page.tsx only needs one import
// and one render line to wire this in (see the integration notes that
// shipped alongside this file). Submits to satisfaction_ratings via
// src/lib/telemetry.ts; feeds the weekly/quarterly/yearly audit reports.
// ---------------------------------------------------------------------------
import { useState } from 'react';
import { submitSatisfactionRating } from '@/lib/telemetry';

const COLORS = {
  surface: '#ffffff',
  border: '#d7dedb',
  hairline: '#c3ccc7',
  emerald: '#0b8a4f',
  textPrimary: '#12241c',
  textMuted: '#5c6b63',
};
const FONT_BODY = 'var(--font-body), system-ui, -apple-system, sans-serif';

const DISMISS_KEY = 'odd_saint_satisfaction_dismissed_date';

function wasDismissedToday(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DISMISS_KEY) === new Date().toDateString();
  } catch {
    return false;
  }
}

function markDismissedToday(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DISMISS_KEY, new Date().toDateString());
  } catch {
    // localStorage unavailable — dismissal just won't persist, not worth failing over.
  }
}

export function SatisfactionWidget({ userId }: { userId: string | null }) {
  const [dismissed, setDismissed] = useState(wasDismissedToday);
  const [score, setScore] = useState<number | null>(null);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');

  if (dismissed || status === 'sent') return null;

  async function handleScore(value: number) {
    setScore(value);
    setStatus('sending');
    await submitSatisfactionRating({ score: value, userId, context: 'general' });
    setStatus('sent');
    markDismissedToday();
  }

  function dismiss() {
    markDismissedToday();
    setDismissed(true);
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        background: COLORS.surface,
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 14,
      }}
    >
      <div style={{ fontSize: 11.5, color: COLORS.textPrimary, fontWeight: 600 }}>
        How's Odd Saint working for you today?
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => handleScore(n)}
            disabled={status === 'sending'}
            aria-label={`Rate ${n} out of 5`}
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              border: `1px solid ${score === n ? COLORS.emerald : COLORS.border}`,
              background: score === n ? COLORS.emerald : 'transparent',
              color: score === n ? '#ffffff' : COLORS.textMuted,
              fontFamily: FONT_BODY,
              fontSize: 11,
              fontWeight: 700,
              cursor: status === 'sending' ? 'not-allowed' : 'pointer',
            }}
          >
            {n}
          </button>
        ))}
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          style={{ background: 'none', border: 'none', color: COLORS.textMuted, cursor: 'pointer', fontSize: 13, marginLeft: 4 }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
