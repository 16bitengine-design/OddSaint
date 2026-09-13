// ---------------------------------------------------------------------------
// Odd Saint — audit telemetry
// Feeds supabase/migrations/004_audit_instrumentation.sql's three tables
// (ticket_views, satisfaction_ratings, page_perf), which the weekly/
// quarterly/yearly audit scripts read (see scripts/audit-weekly.mjs etc).
//
// DELIBERATELY SEPARATE FROM GA4: layout.tsx already fires GA4 for
// visitor/session/traffic-source/location/age-band data — this file is
// only for the things GA4 doesn't give us cleanly: which specific tickets
// get viewed, how long pages actually take to render for real visitors,
// and an explicit satisfaction score. No PII is ever sent — session_id
// below is a random client-generated id, not tied to any account unless
// the visitor is signed in and a rating explicitly includes their userId.
//
// EVERY function here is fire-and-forget and fails silently. Telemetry
// must never be able to break the actual product — a network hiccup here
// should never surface as a user-facing error or block rendering.
// ---------------------------------------------------------------------------
import { supabase } from './supabaseClient';

const SESSION_ID_KEY = 'odd_saint_telemetry_session_id';

/** A random, non-identifying id — persisted per-browser so a report can tell "10 views from 3 sessions" apart from "10 views from 10 sessions", nothing more. */
function getSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const existing = window.localStorage.getItem(SESSION_ID_KEY);
    if (existing) return existing;
    const fresh =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(SESSION_ID_KEY, fresh);
    return fresh;
  } catch {
    return null; // localStorage unavailable (e.g. private browsing) — just skip session grouping
  }
}

/**
 * Logs that a ticket was opened/viewed. Call this once per ticket expand —
 * e.g. from TicketCard's onClick handler that flips `open` to true — not on
 * every render. Deliberately denormalizes `tier` at insert time (see the
 * migration's comment) so a later ticket edit/removal doesn't retroactively
 * change what a past view event says was shown.
 */
export function trackTicketView(ticketId: string, tier: string): void {
  if (typeof window === 'undefined') return;
  supabase
    .from('ticket_views')
    .insert({ ticket_id: ticketId, tier, session_id: getSessionId() })
    .then(({ error }) => {
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[Odd Saint] trackTicketView failed (non-fatal):', error.message);
      }
    });
}

// Only send one page-load timing sample per page load — LCP can in theory
// fire more than once as more content streams in; the LAST value before the
// user interacts/backgrounds the tab is the meaningful one, but capping to
// one write per load keeps this cheap and simple rather than trying to
// track "final" LCP precisely.
let pageLoadSent = false;

/**
 * Measures Largest Contentful Paint via PerformanceObserver and logs it
 * once. Call this once, high up in the root page component's mount effect
 * (e.g. `useEffect(() => { trackPageLoad(window.location.pathname); }, [])`).
 * No-ops in any environment without PerformanceObserver/LCP support rather
 * than throwing — this is a nice-to-have metric, not a critical path.
 */
export function trackPageLoad(route: string): void {
  if (typeof window === 'undefined' || pageLoadSent) return;
  if (typeof PerformanceObserver === 'undefined') return;

  try {
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1] as PerformanceEntry & { renderTime?: number; loadTime?: number };
      if (!last || pageLoadSent) return;

      const loadMs = Math.round(last.renderTime || last.loadTime || last.startTime);
      if (!Number.isFinite(loadMs) || loadMs < 0) return;

      pageLoadSent = true;
      observer.disconnect();

      supabase
        .from('page_perf')
        .insert({ route, metric: 'LCP', load_ms: loadMs, session_id: getSessionId() })
        .then(({ error }) => {
          if (error) {
            // eslint-disable-next-line no-console
            console.warn('[Odd Saint] trackPageLoad failed (non-fatal):', error.message);
          }
        });
    });
    observer.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    // Some browsers don't support the 'largest-contentful-paint' entry type
    // at all — skip silently rather than throwing.
  }
}

/**
 * Submits a 1-5 satisfaction score, optionally with a comment. Separate
 * from src/lib/feedback.ts's free-text submissions — this is the number
 * the audit reports track over time; feedback is what a human reviews for
 * specific issues. `context` distinguishes where the rating was collected
 * (e.g. 'general', 'ticket', 'checkout') in case that's worth breaking out
 * later.
 */
export async function submitSatisfactionRating(params: {
  score: number;
  comment?: string;
  userId?: string | null;
  context?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { score, comment, userId, context } = params;
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return { success: false, error: 'Score must be an integer from 1 to 5.' };
  }

  const { error } = await supabase.from('satisfaction_ratings').insert({
    score,
    comment: comment?.trim() || null,
    user_id: userId ?? null,
    context: context ?? 'general',
  });

  if (error) return { success: false, error: error.message };
  return { success: true };
}
