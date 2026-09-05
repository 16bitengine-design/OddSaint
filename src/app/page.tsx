'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  fetchTickets,
  getTicketStatus,
  getTrialDaysRemaining,
  isWithinFreeTrial,
  getAnonymousTrialStart,
  fetchPerformanceHistory,
  summarizeHistory,
  fetchTeamHistory,
  webSearchUrlForTeam,
  getArchiveAccess,
  getSaintsLockAccess,
  getSubscriptionAccess,
  getUnlockedTicketIds,
  getNextReleaseLabel,
  fetchFixturesForDate,
  adminAddFixtureToTicket,
  adminRemoveFixtureFromTicket,
  dateKey,
  ticketDateKey,
  TIER_CONFIG,
  ANONYMOUS_TRIAL_DAYS,
  SIGNED_UP_TRIAL_DAYS,
  getTrialPolicy,
  type Ticket,
  type Match,
  type MatchStatus,
  type DayPerformance,
  type TicketTier,
  type TeamFormSummary,
  type ArchiveAccess,
  type TrialPolicy,
  type SaintsLockAccess,
  type SubscriptionAccess,
  type AvailableFixture,
} from '@/lib/dataFetcher';
import {
  submitFeedback,
  fetchPendingFeedback,
  moderateFeedback,
  type FeedbackCategory,
  type FeedbackRow,
} from '@/lib/feedback';
import { adminGrantAccess, type GrantableProduct } from '@/lib/adminGrant';

// ---------------------------------------------------------------------------
// Color tokens — Odd Saint brand
// A functional, high-contrast palette in the style of mainstream sportsbook
// apps: clean white/grey surfaces, a bold saturated green as the primary
// brand color, and the standard win/loss/live traffic-light convention
// (green = won, red = lost, amber = still live) so ticket status reads at a
// glance without needing to read the label text.
// ---------------------------------------------------------------------------
const COLORS = {
  bg: '#f4f6f5',
  surface: '#ffffff',
  surfaceAlt: '#eef1ef',
  border: '#d7dedb',
  hairline: '#c3ccc7',
  emerald: '#0b8a4f',
  gold: '#b8860b',
  amber: '#e08e00',
  red: '#d3321f',
  textPrimary: '#12241c',
  textMuted: '#5c6b63',
};

const SURFACE_GRADIENT = COLORS.surface; // flat surfaces — bookmaker UIs favor clean flat cards over gradients
const FONT_DISPLAY = 'var(--font-body), system-ui, -apple-system, sans-serif';
const FONT_BODY = 'var(--font-body), system-ui, -apple-system, sans-serif';

type UnlockMap = Record<string, boolean>; // ticketId -> unlocked via ad (session-only)

// ---------------------------------------------------------------------------
// Small shared components
// ---------------------------------------------------------------------------

function Logo({ light = false }: { light?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 7,
          background: light ? '#ffffff' : COLORS.emerald,
          color: light ? COLORS.emerald : '#ffffff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: FONT_DISPLAY,
          fontWeight: 800,
          fontSize: 14,
          letterSpacing: '-0.01em',
        }}
      >
        OS
      </div>
      <span
        style={{
          fontFamily: FONT_DISPLAY,
          fontWeight: 800,
          fontSize: 19,
          letterSpacing: '-0.01em',
          color: light ? '#ffffff' : COLORS.textPrimary,
        }}
      >
        Odd Saint
      </span>
    </div>
  );

}

function IndemnificationNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div
      style={{
        background: COLORS.surfaceAlt,
        border: `1px solid ${COLORS.border}`,
        borderTop: `1px solid ${COLORS.hairline}`,
        borderRadius: 10,
        padding: compact ? '10px 12px' : '14px 16px',
        fontSize: compact ? 11 : 12.5,
        lineHeight: 1.6,
        color: COLORS.textMuted,
      }}
    >
      <strong style={{ fontFamily: FONT_DISPLAY, fontWeight: 600, color: COLORS.textPrimary }}>
        Hold-Harmless Indemnification Agreement.
      </strong>{' '}
      Odd Saint provides AI-assisted statistical opinions on football outcomes — never a
      guarantee of any result. Sports outcomes are
      volatile and unpredictable. By using this platform you acknowledge that all decisions made on
      the basis of this content are your own responsibility, and you release Odd Saint, its
      operators, and affiliates from any and all liability for financial losses, damages, or claims
      arising from reliance on this content.
    </div>
  );
}

function StatusDot({ status }: { status: MatchStatus }) {
  const color = status === 'green' ? COLORS.emerald : status === 'red' ? COLORS.red : '#525252';
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: 999,
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Ad components (Ad Engine wrapper) — swap the inner div for your real
// AdSense <ins> tag or affiliate banner snippet.
// ---------------------------------------------------------------------------

function AdSlot({ variant }: { variant: 'infeed' | 'anchor' }) {
  const isAnchor = variant === 'anchor';
  return (
    <div
      data-ad-slot={variant}
      style={{
        width: '100%',
        height: isAnchor ? 58 : 90,
        background: COLORS.surfaceAlt,
        border: `1px dashed ${COLORS.border}`,
        borderTop: isAnchor ? `1px solid ${COLORS.hairline}` : `1px dashed ${COLORS.border}`,
        borderRadius: isAnchor ? 0 : 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: COLORS.textMuted,
        fontFamily: FONT_BODY,
        fontSize: 10.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      Ad Slot — {isAnchor ? 'Sticky Anchor' : 'In-Feed'}
    </div>
  );
}

function WatchAdOverlay({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [seconds, setSeconds] = useState(5);

  useEffect(() => {
    if (seconds <= 0) {
      onDone();
      return;
    }
    const t = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds, onDone]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.85)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        style={{
          background: SURFACE_GRADIENT,
          border: `1px solid ${COLORS.hairline}`,
          borderRadius: 16,
          padding: 26,
          width: '100%',
          maxWidth: 360,
          textAlign: 'center',
          boxShadow: '0 20px 60px -20px rgba(0,0,0,0.6)',
        }}
      >
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 15,
            fontWeight: 600,
            color: COLORS.textPrimary,
            marginBottom: 10,
          }}
        >
          Simulated video ad
        </div>
        <div
          style={{
            height: 140,
            borderRadius: 12,
            background: '#0d0d0d',
            border: `1px dashed ${COLORS.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: FONT_DISPLAY,
            fontSize: 34,
            fontWeight: 600,
            color: COLORS.emerald,
            marginBottom: 16,
          }}
        >
          {seconds > 0 ? seconds : '✓'}
        </div>
        <div style={{ fontSize: 12.5, color: COLORS.textMuted, marginBottom: 18 }}>
          {seconds > 0
            ? `Selection unlocks in ${seconds}s...`
            : 'Selection unlocked! You can close this now.'}
        </div>
        <button
          onClick={onClose}
          disabled={seconds > 0}
          style={{
            width: '100%',
            padding: '11px 0',
            borderRadius: 9,
            border: 'none',
            fontFamily: FONT_BODY,
            fontWeight: 600,
            fontSize: 13,
            cursor: seconds > 0 ? 'not-allowed' : 'pointer',
            background: seconds > 0 ? COLORS.border : `linear-gradient(135deg, ${COLORS.emerald}, #0d9668)`,
            color: seconds > 0 ? COLORS.textMuted : '#04150f',
            transition: 'background 0.2s ease',
          }}
        >
          {seconds > 0 ? 'Please wait...' : 'Close & Reveal'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ticket card (accordion) with red/green grading engine
// ---------------------------------------------------------------------------

/**
 * Formats a match's kickoff time in whatever timezone the visitor's own
 * device is set to — Intl.DateTimeFormat uses the browser's local timezone
 * automatically when no `timeZone` option is passed, so this needs no
 * manual geo-IP lookup or timezone detection at all. "Today"/"Tomorrow" are
 * relative to the visitor's own local calendar day, not server time —
 * important for Weekly Lite/Titan tickets whose matches span several days.
 */
function formatKickoff(iso: string): string {
  const date = new Date(iso);
  const now = new Date();

  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);

  if (date.toDateString() === now.toDateString()) return `Today ${time}`;

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;

  const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(
    date
  );
  return `${day}, ${time}`;
}

/**
 * Formats a ticket's "available_at" timestamp for the release badge.
 *
 * Normally this is just a local clock time, e.g. "8:00 AM" — but
 * fetchTickets() (see dataFetcher.ts) can carry forward the PREVIOUS UTC
 * day's real tickets when today's haven't been generated yet (the real,
 * expected gap before the 06:00 UTC pipeline run), rather than falling
 * straight to mock data. Without a visual cue, a carried-forward batch
 * would look identical to a freshly-released one. `requestedDateKeyUTC` is
 * the UTC day the feed actually asked for (today, for the main feed; the
 * picked date, for the archive) — when the ticket's own release day
 * doesn't match it, a short date is prefixed so this is never ambiguous.
 */
function formatReleaseLabel(availableAtISO: string, requestedDateKeyUTC: string): string {
  const releaseDate = new Date(availableAtISO);
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(releaseDate);

  const releaseDayUTC = ticketDateKey(releaseDate);
  if (releaseDayUTC === requestedDateKeyUTC) return time;

  const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(releaseDate);
  return `${shortDate} · ${time}`;
}

function MatchRow({
  match,
  blurred,
  onSelect,
}: {
  match: Match;
  blurred: boolean;
  onSelect?: (match: Match) => void;
}) {
  return (
    <div
      onClick={!blurred && onSelect ? () => onSelect(match) : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '11px 0',
        borderBottom: `1px solid ${COLORS.border}`,
        gap: 10,
        filter: blurred ? 'blur(5px)' : 'none',
        userSelect: blurred ? 'none' : 'auto',
        cursor: !blurred && onSelect ? 'pointer' : 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        <StatusDot status={match.status} />
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
            {match.homeTeam} vs {match.awayTeam}
          </div>
          <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 1 }}>
            {match.league} · {match.market}
          </div>
          {match.finalHomeScore !== undefined && match.finalAwayScore !== undefined ? (
            <div
              style={{
                fontSize: 11,
                color: match.status === 'green' ? COLORS.emerald : COLORS.red,
                marginTop: 2,
                fontWeight: 700,
              }}
            >
              FT {match.finalHomeScore}-{match.finalAwayScore}
            </div>
          ) : (
            <div style={{ fontSize: 10.5, color: COLORS.emerald, marginTop: 2, fontWeight: 600 }}>
              {formatKickoff(match.kickoff)}
            </div>
          )}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 14,
            fontWeight: 800,
            color: COLORS.emerald,
            background: 'rgba(11,138,79,0.1)',
            borderRadius: 6,
            padding: '3px 9px',
            display: 'inline-block',
          }}
        >
          {match.odds}
        </div>
      </div>
    </div>
  );
}

function MatchAnalysisModal({ match, onClose }: { match: Match; onClose: () => void }) {
  const statusLabel =
    match.status === 'green' ? 'Won' : match.status === 'red' ? 'Lost' : 'Pending';
  const statusLine =
    match.status === 'green'
      ? 'This leg landed.'
      : match.status === 'red'
      ? "This leg didn't land."
      : 'Not yet decided — check back after kickoff.';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 45,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.surface,
          borderRadius: 14,
          padding: 22,
          width: '100%',
          maxWidth: 380,
          boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: COLORS.textMuted,
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>

        <div style={{ fontSize: 11, color: COLORS.textMuted, fontWeight: 600, marginBottom: 4 }}>
          {match.league}
        </div>
        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 18,
            fontWeight: 800,
            color: COLORS.textPrimary,
            margin: '0 0 6px',
          }}
        >
          {match.homeTeam} vs {match.awayTeam}
        </h2>
        <div style={{ fontSize: 12, color: COLORS.emerald, fontWeight: 700, marginBottom: 16 }}>
          {formatKickoff(match.kickoff)}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 10,
            marginBottom: 16,
          }}
        >
          <div style={{ flex: 1, background: COLORS.surfaceAlt, borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 3 }}>Market</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>{match.market}</div>
          </div>
          <div style={{ flex: 1, background: COLORS.surfaceAlt, borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 3 }}>Odds</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.emerald }}>{match.odds}</div>
          </div>
          {match.finalHomeScore !== undefined && match.finalAwayScore !== undefined && (
            <div style={{ flex: 1, background: COLORS.surfaceAlt, borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: COLORS.textMuted, marginBottom: 3 }}>Final Score</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>
                {match.finalHomeScore}-{match.finalAwayScore}
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: COLORS.surfaceAlt,
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 14,
          }}
        >
          <StatusDot status={match.status} />
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.textPrimary }}>{statusLabel}</div>
            <div style={{ fontSize: 11, color: COLORS.textMuted }}>{statusLine}</div>
          </div>
        </div>

        <p style={{ fontSize: 11.5, color: COLORS.textMuted, lineHeight: 1.6, margin: 0 }}>
          This pick targets the <strong style={{ color: COLORS.textPrimary }}>{match.market}</strong> market,
          priced at <strong style={{ color: COLORS.textPrimary }}>{match.odds}</strong> by bookmakers ahead
          of kickoff. Odds reflect the market's own consensus view — not a guarantee of the outcome.
        </p>
      </div>
    </div>
  );
}

function ResultBadge({ result }: { result: 'W' | 'D' | 'L' }) {
  const color = result === 'W' ? COLORS.emerald : result === 'L' ? COLORS.red : COLORS.amber;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        borderRadius: 5,
        background: color,
        color: '#ffffff',
        fontFamily: FONT_BODY,
        fontSize: 10.5,
        fontWeight: 800,
        flexShrink: 0,
      }}
    >
      {result}
    </span>
  );
}

function TeamSearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [searchedTeam, setSearchedTeam] = useState<string | null>(null);
  const [result, setResult] = useState<TeamFormSummary | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    setLoading(true);
    setSearchedTeam(trimmed);
    const history = await fetchTeamHistory(trimmed);
    setResult(history);
    setLoading(false);
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 45,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 20,
        paddingTop: '10vh',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.surface,
          borderRadius: 14,
          padding: 22,
          width: '100%',
          maxWidth: 420,
          maxHeight: '75vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: COLORS.textMuted,
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>

        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 17,
            fontWeight: 800,
            color: COLORS.textPrimary,
            margin: '0 0 14px',
          }}
        >
          Search a team
        </h2>

        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Arsenal"
            style={{
              flex: 1,
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.surfaceAlt,
              color: COLORS.textPrimary,
              fontFamily: FONT_BODY,
              fontSize: 13,
              boxSizing: 'border-box',
            }}
          />
          <button
            type="submit"
            style={{
              padding: '10px 16px',
              borderRadius: 8,
              border: 'none',
              background: COLORS.emerald,
              color: '#ffffff',
              fontFamily: FONT_BODY,
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Search
          </button>
        </form>

        {searchedTeam && (
          <>
            {/* External search — opens a real web search in a new tab. This
                app has no backend to safely hold a live news-API key, so
                this is the honest, zero-cost way to surface outside
                information rather than faking it inline. */}
            <a
              href={webSearchUrlForTeam(searchedTeam)}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'block',
                fontSize: 12,
                color: COLORS.emerald,
                fontWeight: 700,
                marginBottom: 16,
                textDecoration: 'underline',
                textUnderlineOffset: 3,
              }}
            >
              Search the web for {searchedTeam} news →
            </a>

            <div
              style={{
                fontFamily: FONT_BODY,
                fontSize: 11,
                fontWeight: 700,
                color: COLORS.textMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 8,
              }}
            >
              Match history in our data
            </div>

            {loading && (
              <div style={{ fontSize: 12.5, color: COLORS.textMuted }}>Searching…</div>
            )}

            {!loading && !result && (
              <div style={{ fontSize: 12.5, color: COLORS.textMuted, lineHeight: 1.5 }}>
                No history found for "{searchedTeam}" yet — we only have data for teams that have
                appeared in a generated ticket so far. Try the web search link above for outside
                information.
              </div>
            )}

            {!loading && result && (
              <div>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    marginBottom: 12,
                    fontSize: 12,
                    color: COLORS.textMuted,
                  }}
                >
                  <span>
                    <strong style={{ color: COLORS.emerald }}>{result.wins}W</strong>
                  </span>
                  <span>
                    <strong style={{ color: COLORS.amber }}>{result.draws}D</strong>
                  </span>
                  <span>
                    <strong style={{ color: COLORS.red }}>{result.losses}L</strong>
                  </span>
                  <span>— last {result.matchesFound} in our data</span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {result.recentResults.map((r, idx) => (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 0',
                        borderBottom: `1px solid ${COLORS.border}`,
                      }}
                    >
                      <ResultBadge result={r.result} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, color: COLORS.textPrimary, fontWeight: 600 }}>
                          {r.venue === 'home' ? 'vs' : '@'} {r.opponent}
                        </div>
                        <div style={{ fontSize: 10.5, color: COLORS.textMuted }}>
                          {r.league} · {formatKickoff(r.kickoff)}
                        </div>
                      </div>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.textPrimary, flexShrink: 0 }}>
                        {r.goalsFor}-{r.goalsAgainst}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin match editor — add/remove an individual fixture on a ticket
// ---------------------------------------------------------------------------
// Operates on fixtures the pipeline already priced for that ticket's date
// (the `fixtures` table) — an admin curates from real, already-generated
// data rather than hand-inventing a brand-new fixture from scratch. The
// real security boundary is Supabase RLS (see
// supabase/migrations/002_batch_updates.sql): these calls simply fail for
// a non-admin, this modal is only ever rendered for archiveAccess.level
// === 'admin' in the first place.

function AdminMatchEditorModal({
  ticket,
  onClose,
  onChanged,
}: {
  ticket: Ticket;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [available, setAvailable] = useState<AvailableFixture[]>([]);
  const [loadingAvailable, setLoadingAvailable] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const anchor = ticket.matches[0]?.kickoff ? new Date(ticket.matches[0].kickoff) : new Date();
    fetchFixturesForDate(anchor)
      .then(setAvailable)
      .finally(() => setLoadingAvailable(false));
  }, [ticket]);

  const attachedIds = new Set(ticket.matches.map((m) => m.id));
  const addable = available.filter((f) => !attachedIds.has(String(f.id)));

  async function handleRemove(fixtureId: string) {
    setError(null);
    setBusyId(fixtureId);
    const res = await adminRemoveFixtureFromTicket(ticket.id, Number(fixtureId));
    setBusyId(null);
    if (!res.success) setError(res.error ?? 'Could not remove that fixture.');
    else onChanged();
  }

  async function handleAdd(fixture: AvailableFixture) {
    setError(null);
    setBusyId(String(fixture.id));
    const res = await adminAddFixtureToTicket(ticket.id, fixture.id);
    setBusyId(null);
    if (!res.success) setError(res.error ?? 'Could not add that fixture.');
    else onChanged();
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 47,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 20,
        paddingTop: '6vh',
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.surface,
          borderRadius: 14,
          padding: 20,
          width: '100%',
          maxWidth: 460,
          boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: COLORS.textMuted,
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>

        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 16,
            fontWeight: 800,
            color: COLORS.textPrimary,
            margin: '0 0 4px',
          }}
        >
          Edit matches — {ticket.label}
        </h2>
        <p style={{ fontSize: 11, color: COLORS.textMuted, margin: '0 0 14px' }}>
          Admin only. Pull a match you judge too risky, or add a stronger one from today's priced pool.
        </p>

        {error && (
          <div style={{ fontSize: 11.5, color: COLORS.red, marginBottom: 10 }}>{error}</div>
        )}

        <div
          style={{
            fontFamily: FONT_BODY,
            fontSize: 10.5,
            fontWeight: 700,
            color: COLORS.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 6,
          }}
        >
          On this ticket ({ticket.matches.length})
        </div>
        <div style={{ marginBottom: 16 }}>
          {ticket.matches.map((m) => (
            <div
              key={m.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '8px 0',
                borderBottom: `1px solid ${COLORS.border}`,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.textPrimary }}>
                  {m.homeTeam} vs {m.awayTeam}
                </div>
                <div style={{ fontSize: 10.5, color: COLORS.textMuted }}>
                  {m.market} · {m.odds} · {formatKickoff(m.kickoff)}
                </div>
              </div>
              <button
                onClick={() => handleRemove(m.id)}
                disabled={busyId === m.id}
                style={{
                  flexShrink: 0,
                  padding: '6px 10px',
                  borderRadius: 7,
                  border: `1px solid ${COLORS.red}`,
                  background: 'transparent',
                  color: COLORS.red,
                  fontFamily: FONT_BODY,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: busyId === m.id ? 'not-allowed' : 'pointer',
                }}
              >
                {busyId === m.id ? '...' : 'Remove'}
              </button>
            </div>
          ))}
          {ticket.matches.length === 0 && (
            <div style={{ fontSize: 12, color: COLORS.textMuted, padding: '6px 0' }}>No matches left on this ticket.</div>
          )}
        </div>

        <div
          style={{
            fontFamily: FONT_BODY,
            fontSize: 10.5,
            fontWeight: 700,
            color: COLORS.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            marginBottom: 6,
          }}
        >
          Available today
        </div>
        {loadingAvailable && <div style={{ fontSize: 12, color: COLORS.textMuted }}>Loading priced fixtures…</div>}
        {!loadingAvailable && addable.length === 0 && (
          <div style={{ fontSize: 12, color: COLORS.textMuted }}>
            No other priced fixtures available for this date yet.
          </div>
        )}
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {addable.map((f) => (
            <div
              key={f.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '8px 0',
                borderBottom: `1px solid ${COLORS.border}`,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.textPrimary }}>
                  {f.homeTeam} vs {f.awayTeam}
                </div>
                <div style={{ fontSize: 10.5, color: COLORS.textMuted }}>
                  {f.league} · {f.market} · {f.odds} · conf {f.confidence}%
                </div>
                <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: '2px' }}>
                  🕐 {formatKickoff(f.kickoff)}
                </div>
              </div>
              <button
                onClick={() => handleAdd(f)}
                disabled={busyId === String(f.id)}
                style={{
                  flexShrink: 0,
                  padding: '6px 10px',
                  borderRadius: 7,
                  border: 'none',
                  background: COLORS.emerald,
                  color: '#ffffff',
                  fontFamily: FONT_BODY,
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: busyId === String(f.id) ? 'not-allowed' : 'pointer',
                }}
              >
                {busyId === String(f.id) ? '...' : 'Add'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TicketCard({
  ticket,
  unlocked,
  trialActive,
  isSignedIn,
  isAdmin,
  hasSaintsLockAccess,
  hasSubscriptionAccess,
  requestedDateKey,
  onWatchAd,
  onSubscribe,
  onPayPerTicket,
  onSelectMatch,
  onEditAsAdmin,
}: {
  ticket: Ticket;
  unlocked: boolean;
  trialActive: boolean;
  isSignedIn: boolean;
  isAdmin: boolean;
  hasSaintsLockAccess: boolean;
  hasSubscriptionAccess: boolean;
  /** UTC day (see ticketDateKey) this feed actually asked for — lets the release badge tell a carried-forward batch apart from a fresh one. */
  requestedDateKey: string;
  onWatchAd: (ticketId: string) => void;
  onSubscribe: () => void;
  onPayPerTicket: (ticketId: string) => void;
  onSelectMatch: (match: Match) => void;
  onEditAsAdmin: (ticket: Ticket) => void;
}) {
  const [open, setOpen] = useState(false);
  const overallStatus = getTicketStatus(ticket);
  const isSaintsLock = ticket.tier === 'saints_lock';
  // Weekly Titan is free forever once someone signs up — the signup
  // incentive, separate from the time-limited trial.
  const isWeeklyTitanUnlockedForever = ticket.tier === 'weekly_titan' && isSignedIn;
  // Admins see every ticket unlocked, every tier, including Saint's Lock —
  // "administrator can access all tickets without payment." This check
  // comes FIRST and short-circuits everything else below it; nothing else
  // in this function needs to special-case admin once this line is right.
  //
  // hasSubscriptionAccess is the fix for a real bug: a successful
  // subscription payment previously wrote to the `subscribers` table (via
  // grantAccessForPayment) but nothing on the frontend ever checked that
  // table for TODAY's feed — `unlocked` was only ever local, session-only
  // React state set by watching an ad or paying per-ticket. A paying
  // subscriber's tickets stayed locked exactly as before. See
  // getSubscriptionAccess() in dataFetcher.ts.
  const isLocked = isAdmin
    ? false
    : isSaintsLock
    ? !hasSaintsLockAccess
    : !ticket.isFree && !isWeeklyTitanUnlockedForever && !trialActive && !unlocked && !hasSubscriptionAccess;

  const borderColor =
    overallStatus === 'green' ? COLORS.emerald : overallStatus === 'red' ? COLORS.red : COLORS.amber;

  const statusLabel =
    overallStatus === 'green' ? 'WON' : overallStatus === 'red' ? 'FAILED' : 'IN PLAY';

  return (
    <div
      style={{
        position: 'relative',
        background: SURFACE_GRADIENT,
        border: `1px solid ${borderColor}`,
        borderRadius: 14,
        padding: '17px 16px 16px',
        marginBottom: 14,
        overflow: 'hidden',
        boxShadow: `0 0 0 1px ${borderColor}33`,
      }}
    >
      {/* Status indicator bar — solid color, no decorative animation, so
          win/loss/live reads instantly at a glance. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: borderColor,
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{
            flex: 1,
            minWidth: 0,
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
          <div style={{ textAlign: 'left', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16.5, fontWeight: 600, color: COLORS.textPrimary }}>
                {ticket.label}
              </div>
              {isAdmin && (
                <span
                  style={{
                    fontFamily: FONT_BODY,
                    fontSize: 10,
                    fontWeight: 700,
                    color: COLORS.emerald,
                    background: 'rgba(11,138,79,0.1)',
                    borderRadius: 999,
                    padding: '1px 7px',
                  }}
                >
                  Admin — unlocked
                </span>
              )}
              {ticket.availableAt && (
                <span
                  style={{
                    fontFamily: FONT_BODY,
                    fontSize: 10,
                    fontWeight: 700,
                    color: COLORS.textMuted,
                    background: COLORS.surfaceAlt,
                    borderRadius: 999,
                    padding: '1px 7px',
                  }}
                >
                  Released {formatReleaseLabel(ticket.availableAt, requestedDateKey)}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: COLORS.textMuted, marginTop: 3 }}>
              {ticket.matchCount} matches · odds {ticket.oddsRange} · total{' '}
              <span style={{ color: COLORS.emerald, fontWeight: 700 }}>{ticket.totalOdds}x</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <span
              className={overallStatus === 'pending' ? 'live-pulse' : undefined}
              style={{
                fontFamily: FONT_BODY,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                padding: '4px 10px',
                borderRadius: 999,
                color: overallStatus === 'green' ? '#04150f' : overallStatus === 'red' ? '#2a0808' : '#3d2900',
                background: borderColor,
              }}
            >
              {statusLabel}
            </span>
            <span style={{ color: COLORS.textMuted, fontSize: 12 }}>{open ? '▲' : '▼'}</span>
          </div>
        </button>
      </div>

      {isAdmin && (
        <button
          onClick={() => onEditAsAdmin(ticket)}
          style={{
            marginTop: 10,
            background: 'none',
            border: `1px dashed ${COLORS.hairline}`,
            borderRadius: 7,
            padding: '4px 9px',
            color: COLORS.textMuted,
            fontFamily: FONT_BODY,
            fontSize: 10.5,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          ✎ Edit matches (admin)
        </button>
      )}

      {open && (
        <div style={{ marginTop: 14 }}>
          {isLocked ? (
            <div
              style={{
                position: 'relative',
                border: `1px dashed ${COLORS.border}`,
                borderRadius: 10,
                padding: 16,
              }}
            >
              <div style={{ filter: 'blur(4px)', pointerEvents: 'none' }}>
                {ticket.matches.slice(0, 2).map((m) => (
                  <MatchRow key={m.id} match={m} blurred />
                ))}
              </div>
              <div
                style={{
                  marginTop: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    fontFamily: FONT_DISPLAY,
                    fontSize: 12.5,
                    color: COLORS.textMuted,
                    textAlign: 'center',
                  }}
                >
                  {isSaintsLock
                    ? isSignedIn
                      ? "Saint's Lock requires a paid pass — no free trial applies here."
                      : "Saint's Lock requires a free account, then a paid pass — sign in to continue."
                    : 'Your free trial has ended. Unlock this ticket:'}
                </div>
                {!isSaintsLock && (
                  <button
                    onClick={() => onWatchAd(ticket.id)}
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
                    ▶ Watch Ad to Reveal Selection
                  </button>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  {!isSaintsLock && (
                    <button
                      onClick={() => onPayPerTicket(ticket.id)}
                      style={{
                        flex: 1,
                        padding: '9px 0',
                        borderRadius: 8,
                        border: `1px solid ${COLORS.hairline}`,
                        fontFamily: FONT_BODY,
                        fontWeight: 600,
                        fontSize: 12,
                        background: 'transparent',
                        color: COLORS.textPrimary,
                        cursor: 'pointer',
                      }}
                    >
                      Pay Micro-Fee
                    </button>
                  )}
                  <button
                    onClick={onSubscribe}
                    style={{
                      flex: 1,
                      padding: '9px 0',
                      borderRadius: 8,
                      border: `1px solid ${COLORS.hairline}`,
                      fontFamily: FONT_BODY,
                      fontWeight: 600,
                      fontSize: 12,
                      background: 'transparent',
                      color: COLORS.textPrimary,
                      cursor: 'pointer',
                    }}
                  >
                    {isSaintsLock ? "Get Saint's Lock Pass" : 'Subscribe Monthly'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div>
              {ticket.matches.map((m) => (
                <MatchRow key={m.id} match={m} blurred={false} onSelect={onSelectMatch} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saint's Lock — daily marketing countdown
// ---------------------------------------------------------------------------
// Rendered as a standalone strip ABOVE the accordion (not just inside it),
// per the "market it daily, give a time reminder before kickoff" spec —
// this is meant to be seen whether or not someone opens the ticket.

function SaintsLockCountdown({ ticket }: { ticket: Ticket }) {
  const kickoffISO = ticket.matches[0]?.kickoff;
  const [msLeft, setMsLeft] = useState(() => (kickoffISO ? new Date(kickoffISO).getTime() - Date.now() : null));

  useEffect(() => {
    if (!kickoffISO) return;
    const t = setInterval(() => setMsLeft(new Date(kickoffISO).getTime() - Date.now()), 1000);
    return () => clearInterval(t);
  }, [kickoffISO]);

  if (!kickoffISO || msLeft === null) return null;

  const label =
    msLeft <= 0
      ? 'Kicking off now'
      : (() => {
          const h = Math.floor(msLeft / 3_600_000);
          const m = Math.floor((msLeft % 3_600_000) / 60_000);
          return `Kicks off in ${h}h ${m}m`;
        })();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        background: '#12241c',
        borderRadius: 10,
        padding: '10px 14px',
        marginBottom: 8,
      }}
    >
      <div style={{ fontSize: 11.5, color: '#ffffff', fontWeight: 700 }}>
        🔒 Today's Saint's Lock — {ticket.matches[0].homeTeam} vs {ticket.matches[0].awayTeam}
      </div>
      <div
        className={msLeft > 0 ? 'live-pulse' : undefined}
        style={{ fontSize: 11, color: COLORS.gold, fontWeight: 800, flexShrink: 0 }}
      >
        {label}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customer support / feedback widget
// ---------------------------------------------------------------------------
// Submissions go through prefilterFeedback (obvious-spam check) then land
// as `status: 'pending'` in the `feedback` table — nothing here is ever
// shown publicly without an admin moderating it first. See
// src/lib/feedback.ts and supabase/migrations/002_batch_updates.sql.

function SupportModal({
  onClose,
  userId,
  userEmail,
}: {
  onClose: () => void;
  userId: string | null;
  userEmail: string | null;
}) {
  const categories: { id: FeedbackCategory; label: string }[] = [
    { id: 'usability', label: 'Usability' },
    { id: 'performance', label: 'Performance / results' },
    { id: 'bug', label: 'Something broken' },
    { id: 'support_request', label: 'General support' },
  ];

  const [category, setCategory] = useState<FeedbackCategory>('support_request');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus('sending');
    const res = await submitFeedback({ userId, email: userEmail, category, message });
    if (!res.success) {
      setError(res.error ?? 'Could not submit — please try again.');
      setStatus('error');
      return;
    }
    setStatus('sent');
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 46,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.surface,
          borderRadius: 14,
          padding: 22,
          width: '100%',
          maxWidth: 400,
          boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: COLORS.textMuted,
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>

        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 17,
            fontWeight: 800,
            color: COLORS.textPrimary,
            margin: '0 0 4px',
          }}
        >
          Support & feedback
        </h2>

        {status === 'sent' ? (
          <p style={{ fontSize: 12.5, color: COLORS.emerald, lineHeight: 1.6, marginTop: 14 }}>
            Thanks — your message has been received and will be reviewed by our team.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 11.5, color: COLORS.textMuted, margin: '0 0 16px' }}>
              Every message is reviewed before it informs any change we make — tell us what's working or not.
            </p>

            <form onSubmit={handleSubmit}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {categories.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    onClick={() => setCategory(c.id)}
                    style={{
                      fontFamily: FONT_BODY,
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '5px 11px',
                      borderRadius: 999,
                      border: category === c.id ? 'none' : `1px solid ${COLORS.border}`,
                      background: category === c.id ? COLORS.emerald : 'transparent',
                      color: category === c.id ? '#ffffff' : COLORS.textMuted,
                      cursor: 'pointer',
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <textarea
                required
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What's on your mind?"
                rows={5}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: `1px solid ${COLORS.border}`,
                  background: COLORS.surfaceAlt,
                  color: COLORS.textPrimary,
                  fontFamily: FONT_BODY,
                  fontSize: 13,
                  marginBottom: 12,
                  resize: 'vertical',
                  boxSizing: 'border-box',
                }}
              />

              {error && <div style={{ fontSize: 11.5, color: COLORS.red, marginBottom: 10 }}>{error}</div>}

              <button
                type="submit"
                disabled={status === 'sending' || !message.trim()}
                style={{
                  width: '100%',
                  padding: '11px 0',
                  borderRadius: 9,
                  border: 'none',
                  fontFamily: FONT_BODY,
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: status === 'sending' || !message.trim() ? 'not-allowed' : 'pointer',
                  background:
                    status === 'sending' || !message.trim()
                      ? COLORS.border
                      : `linear-gradient(135deg, ${COLORS.emerald}, #0d9668)`,
                  color: status === 'sending' || !message.trim() ? COLORS.textMuted : '#04150f',
                }}
              >
                {status === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function SupportButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Support and feedback"
      style={{
        position: 'fixed',
        right: 14,
        bottom: 74,
        zIndex: 25,
        width: 46,
        height: 46,
        borderRadius: 999,
        border: 'none',
        background: COLORS.emerald,
        color: '#ffffff',
        fontFamily: FONT_DISPLAY,
        fontSize: 19,
        cursor: 'pointer',
        boxShadow: '0 10px 24px -8px rgba(11,138,79,0.6)',
      }}
    >
      ?
    </button>
  );
}

// ---------------------------------------------------------------------------
// Admin feedback moderation
// ---------------------------------------------------------------------------
// Admin-only. Lists PENDING feedback (not yet shown anywhere, not yet fed
// into the self-improvement digest) so an admin can approve or reject each
// item. Only 'approved' items are ever read by scripts/analyze-feedback.mjs
// — nothing here changes app behavior on its own, an admin's decision is
// the actual gate. Same access pattern as AdminMatchEditorModal: rendered
// only when isAdmin is true, but the real enforcement is Supabase RLS.

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  usability: 'Usability',
  performance: 'Performance / results',
  bug: 'Bug',
  support_request: 'Support request',
  general: 'General',
};

function AdminFeedbackModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    fetchPendingFeedback()
      .then(setItems)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDecision(id: string, decision: 'approved' | 'rejected') {
    setError(null);
    setBusyId(id);
    const res = await moderateFeedback(id, decision);
    setBusyId(null);
    if (!res.success) {
      setError(res.error ?? 'Could not update that item.');
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 47,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 20,
        paddingTop: '6vh',
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.surface,
          borderRadius: 14,
          padding: 20,
          width: '100%',
          maxWidth: 480,
          boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: COLORS.textMuted,
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>

        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 16,
            fontWeight: 800,
            color: COLORS.textPrimary,
            margin: '0 0 4px',
          }}
        >
          Moderate feedback
        </h2>
        <p style={{ fontSize: 11, color: COLORS.textMuted, margin: '0 0 14px' }}>
          Admin only. Approved items feed the feedback digest (Actions → "Odd Saint — Feedback Digest") —
          weigh each against usability, performance quality, and SEO/discoverability before approving.
        </p>

        {error && <div style={{ fontSize: 11.5, color: COLORS.red, marginBottom: 10 }}>{error}</div>}

        {loading && <div style={{ fontSize: 12, color: COLORS.textMuted }}>Loading pending feedback…</div>}

        {!loading && items.length === 0 && (
          <div style={{ fontSize: 12, color: COLORS.textMuted }}>Nothing pending — you're caught up.</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((item) => (
            <div
              key={item.id}
              style={{
                border: `1px solid ${COLORS.border}`,
                borderRadius: 10,
                padding: '10px 12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: COLORS.emerald,
                    background: 'rgba(11,138,79,0.1)',
                    borderRadius: 999,
                    padding: '2px 8px',
                  }}
                >
                  {CATEGORY_LABELS[item.category]}
                </span>
                <span style={{ fontSize: 10, color: COLORS.textMuted }}>
                  {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
                    new Date(item.createdAt)
                  )}
                </span>
              </div>
              <p style={{ fontSize: 12.5, color: COLORS.textPrimary, lineHeight: 1.5, margin: '0 0 8px' }}>
                {item.message}
              </p>
              {item.email && (
                <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginBottom: 8 }}>From: {item.email}</div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => handleDecision(item.id, 'approved')}
                  disabled={busyId === item.id}
                  style={{
                    flex: 1,
                    padding: '7px 0',
                    borderRadius: 7,
                    border: 'none',
                    background: COLORS.emerald,
                    color: '#ffffff',
                    fontFamily: FONT_BODY,
                    fontSize: 11.5,
                    fontWeight: 700,
                    cursor: busyId === item.id ? 'not-allowed' : 'pointer',
                  }}
                >
                  {busyId === item.id ? '...' : 'Approve'}
                </button>
                <button
                  onClick={() => handleDecision(item.id, 'rejected')}
                  disabled={busyId === item.id}
                  style={{
                    flex: 1,
                    padding: '7px 0',
                    borderRadius: 7,
                    border: `1px solid ${COLORS.hairline}`,
                    background: 'transparent',
                    color: COLORS.textMuted,
                    fontFamily: FONT_BODY,
                    fontSize: 11.5,
                    fontWeight: 700,
                    cursor: busyId === item.id ? 'not-allowed' : 'pointer',
                  }}
                >
                  {busyId === item.id ? '...' : 'Reject'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin grant access — comp a subscription or Saint's Lock pass for someone
// ---------------------------------------------------------------------------
// "help any other person subscribe through my administrator account."
// Admin-only, same access pattern as the other admin modals: rendered only
// when isAdmin is true, but the real enforcement lives server-side in
// /api/admin/grant-access (verifies the caller against the `admins` table
// using the service-role key) — this UI gate is convenience, not security.
// The target person must have signed in at least once already (their
// auth.users row has to exist to resolve their email to a user_id).

function AdminGrantAccessModal({ onClose }: { onClose: () => void }) {
  const [targetEmail, setTargetEmail] = useState('');
  const [product, setProduct] = useState<GrantableProduct>('subscription');
  const [plan, setPlan] = useState('monthly');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const subscriptionPlans = [
    { id: 'weekly', label: 'Weekly (7 days)' },
    { id: 'monthly', label: 'Monthly (30 days)' },
    { id: 'yearly', label: 'Yearly (365 days)' },
  ];
  const saintsLockPlans = [
    { id: 'daily', label: 'Daily (1 day)' },
    { id: 'weekly', label: 'Weekly (7 days)' },
    { id: 'monthly', label: 'Monthly (30 days)' },
  ];
  const planOptions = product === 'saints_lock' ? saintsLockPlans : subscriptionPlans;

  function handleProductChange(next: GrantableProduct) {
    setProduct(next);
    setPlan(next === 'saints_lock' ? 'weekly' : 'monthly');
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = targetEmail.trim();
    if (!trimmed) return;
    setError(null);
    setStatus('sending');
    const res = await adminGrantAccess({ targetEmail: trimmed, product, plan });
    if (!res.success) {
      setError(res.error ?? 'Could not grant access.');
      setStatus('error');
      return;
    }
    setStatus('sent');
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 47,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 20,
        paddingTop: '6vh',
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.surface,
          borderRadius: 14,
          padding: 20,
          width: '100%',
          maxWidth: 420,
          boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: COLORS.textMuted,
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>

        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 16,
            fontWeight: 800,
            color: COLORS.textPrimary,
            margin: '0 0 4px',
          }}
        >
          Grant access to someone
        </h2>
        <p style={{ fontSize: 11, color: COLORS.textMuted, margin: '0 0 16px', lineHeight: 1.5 }}>
          Admin only. Comps subscription or Saint's Lock access for another user — no payment involved.
          They need to have signed in with the magic link at least once already.
        </p>

        {status === 'sent' ? (
          <div>
            <p style={{ fontSize: 12.5, color: COLORS.emerald, lineHeight: 1.6, marginBottom: 14 }}>
              Access granted to {targetEmail.trim()}.
            </p>
            <button
              onClick={() => {
                setStatus('idle');
                setTargetEmail('');
              }}
              style={{
                padding: '9px 14px',
                borderRadius: 8,
                border: `1px solid ${COLORS.hairline}`,
                background: 'transparent',
                color: COLORS.textPrimary,
                fontFamily: FONT_BODY,
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Grant another
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: COLORS.textMuted, marginBottom: 5 }}>
              Their email (must have signed in before)
            </label>
            <input
              type="email"
              required
              value={targetEmail}
              onChange={(e) => setTargetEmail(e.target.value)}
              placeholder="person@example.com"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                background: COLORS.surfaceAlt,
                color: COLORS.textPrimary,
                fontFamily: FONT_BODY,
                fontSize: 13,
                marginBottom: 14,
                boxSizing: 'border-box',
              }}
            />

            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: COLORS.textMuted, marginBottom: 5 }}>
              Product
            </label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
              {(['subscription', 'saints_lock'] as GrantableProduct[]).map((p) => (
                <button
                  type="button"
                  key={p}
                  onClick={() => handleProductChange(p)}
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: 8,
                    border: product === p ? 'none' : `1px solid ${COLORS.border}`,
                    background: product === p ? COLORS.emerald : 'transparent',
                    color: product === p ? '#ffffff' : COLORS.textMuted,
                    fontFamily: FONT_BODY,
                    fontWeight: 700,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  {p === 'subscription' ? 'Subscription' : "Saint's Lock"}
                </button>
              ))}
            </div>

            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: COLORS.textMuted, marginBottom: 5 }}>
              Plan / duration
            </label>
            <select
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              style={{
                width: '100%',
                padding: '9px 10px',
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                background: COLORS.surfaceAlt,
                color: COLORS.textPrimary,
                fontFamily: FONT_BODY,
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              {planOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>

            {error && <div style={{ fontSize: 11.5, color: COLORS.red, marginBottom: 10 }}>{error}</div>}

            <button
              type="submit"
              disabled={status === 'sending' || !targetEmail.trim()}
              style={{
                width: '100%',
                padding: '11px 0',
                borderRadius: 9,
                border: 'none',
                fontFamily: FONT_BODY,
                fontWeight: 600,
                fontSize: 13,
                cursor: status === 'sending' || !targetEmail.trim() ? 'not-allowed' : 'pointer',
                background:
                  status === 'sending' || !targetEmail.trim()
                    ? COLORS.border
                    : `linear-gradient(135deg, ${COLORS.emerald}, #0d9668)`,
                color: status === 'sending' || !targetEmail.trim() ? COLORS.textMuted : '#04150f',
              }}
            >
              {status === 'sending' ? 'Granting…' : 'Grant access'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

function LoginModal({ onSent, onClose }: { onSent: (email: string) => void; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    if (!agreed || !email) return;
    setStatus('sending');
    // marketing_opt_in is stored in the user's auth metadata — set here at
    // signup time so there's a real, explicit opt-in on record before
    // anyone's added to a marketing list, rather than assuming consent.
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { data: { marketing_opt_in: marketingOptIn } },
    });
    if (error) {
      setStatus('error');
      return;
    }
    setStatus('sent');
    onSent(email);
  }

  async function handleOAuth(provider: 'google' | 'facebook') {
    await supabase.auth.signInWithOAuth({ provider });
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.8)',
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <Logo />
        </div>
        <form
          onSubmit={handleLogin}
          style={{
            width: '100%',
            background: SURFACE_GRADIENT,
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: 14,
            padding: 22,
            position: 'relative',
            boxShadow: '0 20px 60px -20px rgba(0,0,0,0.6)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              background: 'none',
              border: 'none',
              color: COLORS.textMuted,
              fontSize: 16,
              cursor: 'pointer',
            }}
          >
            ✕
          </button>

          <div style={{ fontSize: 13, color: COLORS.textMuted, marginBottom: 14, paddingRight: 20, lineHeight: 1.5 }}>
            Sign in with a magic link to sync your trial and unlocks across devices.
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <button
              type="button"
              onClick={() => handleOAuth('google')}
              style={{
                flex: 1,
                padding: '9px 0',
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                background: '#ffffff',
                color: COLORS.textPrimary,
                fontFamily: FONT_BODY,
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Google
            </button>
            <button
              type="button"
              onClick={() => handleOAuth('facebook')}
              style={{
                flex: 1,
                padding: '9px 0',
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                background: '#ffffff',
                color: COLORS.textPrimary,
                fontFamily: FONT_BODY,
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Facebook
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 14px' }}>
            <div style={{ flex: 1, height: 1, background: COLORS.border }} />
            <span style={{ fontSize: 10.5, color: COLORS.textMuted }}>or use email</span>
            <div style={{ flex: 1, height: 1, background: COLORS.border }} />
          </div>

          <input
            type="email"
            required
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              width: '100%',
              padding: '11px 12px',
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.surfaceAlt,
              color: COLORS.textPrimary,
              fontFamily: FONT_BODY,
              fontSize: 13,
              marginBottom: 12,
              boxSizing: 'border-box',
            }}
          />

          <div style={{ marginBottom: 14 }}>
            <IndemnificationNotice compact />
          </div>

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 12,
              color: COLORS.textMuted,
              marginBottom: 14,
              cursor: 'pointer',
              lineHeight: 1.4,
            }}
          >
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            I have read and accept the Hold-Harmless Indemnification Agreement.
          </label>

          {/* Marketing consent — deliberately a separate, optional checkbox,
              unchecked by default. Bundling this with the required legal
              agreement above would make consent meaningless. */}
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              fontSize: 12,
              color: COLORS.textMuted,
              marginBottom: 14,
              cursor: 'pointer',
              lineHeight: 1.4,
            }}
          >
            <input
              type="checkbox"
              checked={marketingOptIn}
              onChange={(e) => setMarketingOptIn(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            Send me occasional emails about new ticket drops and offers (optional).
          </label>

          <button
            type="submit"
            disabled={!agreed || !email || status === 'sending'}
            style={{
              width: '100%',
              padding: '11px 0',
              borderRadius: 9,
              border: 'none',
              fontFamily: FONT_BODY,
              fontWeight: 600,
              fontSize: 13,
              cursor: !agreed || !email ? 'not-allowed' : 'pointer',
              background:
                !agreed || !email ? COLORS.border : `linear-gradient(135deg, ${COLORS.emerald}, #0d9668)`,
              color: !agreed || !email ? COLORS.textMuted : '#04150f',
            }}
          >
            {status === 'sending' ? 'Sending link...' : 'Send Magic Link'}
          </button>

          {status === 'sent' && (
            <div style={{ marginTop: 10, fontSize: 12, color: COLORS.emerald, textAlign: 'center' }}>
              Check your inbox for the sign-in link.
            </div>
          )}
          {status === 'error' && (
            <div style={{ marginTop: 10, fontSize: 12, color: COLORS.red, textAlign: 'center' }}>
              Something went wrong. Please try again.
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

/**
 * The daily ticket-generation job releases two staggered batches per tier
 * (see RELEASE_SLOT_HOURS_UTC / .github/workflows/generate-tickets.yml).
 * This converts the first of those fixed UTC anchors into whatever
 * timezone the visitor's own device is set to — same technique as
 * formatKickoff — so every user sees the correct local time for when the
 * first batch of the day drops, regardless of where they are.
 */
function getDailyRefreshInfo(): { timeLabel: string; hasRefreshedToday: boolean } {
  const now = new Date();
  const refreshUTC = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0)
  );
  // Plain local clock time — no "GMT+3" style suffix, since most people
  // read "8:00 AM" instantly but have to stop and think about a raw UTC
  // offset abbreviation.
  const timeLabel = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(refreshUTC);

  return { timeLabel, hasRefreshedToday: now.getTime() >= refreshUTC.getTime() };
}

function Hero({
  bronzeCount,
  goldCount,
  winRatePct,
  onViewHistory,
}: {
  bronzeCount: number;
  goldCount: number;
  winRatePct: number | null;
  onViewHistory: () => void;
}) {
  const { timeLabel, hasRefreshedToday } = getDailyRefreshInfo();
  const nextRelease = getNextReleaseLabel();

  return (
    <div
      style={{
        borderRadius: 12,
        background: COLORS.emerald,
        padding: '20px 18px 18px',
        marginBottom: 18,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          fontFamily: FONT_BODY,
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.75)',
          marginBottom: 6,
        }}
      >
        Today's Slate
      </div>
      <h1
        style={{
          fontFamily: FONT_DISPLAY,
          fontWeight: 800,
          fontSize: 23,
          lineHeight: 1.2,
          color: '#ffffff',
          margin: '0 0 8px',
        }}
      >
        Curated tickets, graded in the open.
      </h1>
      <p
        style={{
          fontFamily: FONT_BODY,
          fontSize: 12.5,
          color: 'rgba(255,255,255,0.85)',
          maxWidth: 360,
          margin: '0 auto 14px',
          lineHeight: 1.5,
        }}
      >
        Odd Saint offers football predictions only — not a betting operator,
        not financial advice. Every pick is AI-assisted analysis,
        never a guarantee.
      </p>

      {/* Refresh-schedule indicator — always visible, converted to the
          visitor's own local time, so nobody has to guess when to check
          back for a fresh batch. Each tier releases up to 2 staggered
          batches a day — the currently-visible batch stays up until the
          next one lands, so this is purely informational, not a
          "your tickets are about to disappear" warning. */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(255,255,255,0.14)',
          borderRadius: 999,
          padding: '5px 12px',
          marginBottom: 6,
          fontFamily: FONT_BODY,
          fontSize: 11,
          fontWeight: 600,
          color: '#ffffff',
        }}
      >
        <span
          className={hasRefreshedToday ? undefined : 'live-pulse'}
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: '#ffffff',
            display: 'inline-block',
          }}
        />
        {hasRefreshedToday
          ? `Today's tickets are live · next batch at ${nextRelease.label}`
          : `New tickets drop today at ${timeLabel}`}
      </div>
      <div
        style={{
          fontFamily: FONT_BODY,
          fontSize: 10,
          color: 'rgba(255,255,255,0.7)',
          marginBottom: 10,
        }}
      >
        Today's current tickets stay up until the next batch releases — nothing disappears early.
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 4,
        }}
      >
        {[
          { label: 'Bronze slips today', value: String(bronzeCount) },
          { label: 'Gold slips today', value: String(goldCount) },
          {
            label: '14-day win rate',
            value: winRatePct !== null ? `${winRatePct}%` : '—',
          },
        ].map((stat) => (
          <div
            key={stat.label}
            style={{
              background: 'rgba(255,255,255,0.14)',
              borderRadius: 8,
              padding: '8px 14px',
              minWidth: 96,
            }}
          >
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 800, color: '#ffffff' }}>
              {stat.value}
            </div>
            <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.75)', marginTop: 2, lineHeight: 1.3 }}>
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={onViewHistory}
        style={{
          marginTop: 10,
          background: 'none',
          border: 'none',
          color: '#ffffff',
          fontFamily: FONT_BODY,
          fontSize: 11.5,
          fontWeight: 700,
          cursor: 'pointer',
          textDecoration: 'underline',
          textUnderlineOffset: 3,
        }}
      >
        View performance history →
      </button>
    </div>
  );
}

function PerformanceHistory({ history }: { history: DayPerformance[] }) {
  const [selectedTier, setSelectedTier] = useState<TicketTier | 'all'>('all');

  if (history.length === 0) return null;

  const tabs: Array<{ key: TicketTier | 'all'; label: string }> = [
    { key: 'all', label: 'All' },
    ...TIER_CONFIG.map((c) => ({ key: c.tier, label: c.label })),
  ];

  const statsFor = (day: DayPerformance) =>
    selectedTier === 'all' ? day.overall : day.byTier[selectedTier];

  return (
    <div
      style={{
        background: COLORS.surfaceAlt,
        border: `1px solid ${COLORS.border}`,
        borderTop: `1px solid ${COLORS.hairline}`,
        borderRadius: 12,
        padding: 14,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontSize: 14,
          fontWeight: 700,
          color: COLORS.textPrimary,
          marginBottom: 10,
        }}
      >
        Last {history.length} days
      </div>

      {/* Tier filter tabs — horizontally scrollable so all 9 fit on mobile */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          overflowX: 'auto',
          paddingBottom: 10,
          marginBottom: 8,
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {tabs.map((tab) => {
          const active = tab.key === selectedTier;
          return (
            <button
              key={tab.key}
              onClick={() => setSelectedTier(tab.key)}
              style={{
                flexShrink: 0,
                fontFamily: FONT_BODY,
                fontSize: 11,
                fontWeight: 700,
                padding: '5px 11px',
                borderRadius: 999,
                border: active ? 'none' : `1px solid ${COLORS.border}`,
                background: active ? COLORS.emerald : 'transparent',
                color: active ? '#ffffff' : COLORS.textMuted,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {history.map((day) => {
          const stats = statsFor(day);
          const decided = stats ? stats.won + stats.failed : 0;
          const wonPct = decided > 0 ? (stats!.won / decided) * 100 : 0;
          return (
            <div key={day.date} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 74, fontSize: 11, color: COLORS.textMuted, flexShrink: 0 }}>
                {day.date.slice(5)}
              </div>
              <div
                style={{
                  flex: 1,
                  height: 8,
                  borderRadius: 999,
                  background: 'rgba(18,36,28,0.06)',
                  overflow: 'hidden',
                  display: 'flex',
                }}
              >
                {decided > 0 && (
                  <div
                    style={{
                      width: `${wonPct}%`,
                      background: COLORS.emerald,
                    }}
                  />
                )}
              </div>
              <div style={{ width: 78, fontSize: 10.5, color: COLORS.textMuted, textAlign: 'right', flexShrink: 0 }}>
                {!stats
                  ? '—'
                  : stats.winRatePct !== null
                  ? `${stats.winRatePct}% · ${stats.ticketsGenerated}`
                  : `${stats.ticketsGenerated} live`}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 10, lineHeight: 1.5 }}>
        Win rate = won ÷ (won + failed) among that day's tickets. Ticket count shown after the dot.
      </div>
    </div>
  );
}

function TicketArchiveModal({
  access,
  onClose,
  isAdmin,
  onEditAsAdmin,
}: {
  access: ArchiveAccess;
  onClose: () => void;
  isAdmin: boolean;
  onEditAsAdmin: (ticket: Ticket) => void;
}) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = dateKey(yesterday);

  const minDateStr = useMemo(() => {
    if (access.level !== 'subscriber') return undefined;
    const oldest = new Date();
    oldest.setDate(oldest.getDate() - access.maxDaysBack);
    return dateKey(oldest);
  }, [access]);

  const [selectedDateStr, setSelectedDateStr] = useState(yesterdayStr);
  const [loadedDateStr, setLoadedDateStr] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [archiveSelectedMatch, setArchiveSelectedMatch] = useState<Match | null>(null);

  async function loadDate(value: string) {
    setLoading(true);
    setLoaded(false);
    // Anchor at noon to avoid a date-input string landing on the wrong
    // calendar day when parsed near a timezone boundary.
    const picked = new Date(`${value}T12:00:00`);
    const result = await fetchTickets(picked);
    setTickets(result);
    // Tracked separately from selectedDateStr — the picker's value can
    // change before the user hits Load, but the release badge's
    // "which day did we actually ask for" comparison must stay pinned to
    // whatever date `tickets` actually corresponds to.
    setLoadedDateStr(value);
    setLoading(false);
    setLoaded(true);
  }

  // fetchTickets() never carries a different day forward for an explicit
  // archive date (see the isTodayUTC check in dataFetcher.ts) — real data
  // for exactly this day, or mock, never a substitute day. Still passed
  // through so the badge logic has a consistent UTC key to compare against.
  const requestedDateKeyForLoadedTickets = loadedDateStr
    ? ticketDateKey(new Date(`${loadedDateStr}T12:00:00`))
    : ticketDateKey(new Date());

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 40,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 20,
        paddingTop: '6vh',
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.surface,
          borderRadius: 14,
          padding: 20,
          width: '100%',
          maxWidth: 480,
          boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: COLORS.textMuted,
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>

        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 17,
            fontWeight: 800,
            color: COLORS.textPrimary,
            margin: '0 0 4px',
          }}
        >
          Ticket archive
        </h2>
        <p style={{ fontSize: 11.5, color: COLORS.textMuted, margin: '0 0 14px' }}>
          {access.level === 'admin'
            ? 'Admin access — any past day, unrestricted.'
            : `Subscriber access — up to the last ${access.level === 'subscriber' ? access.maxDaysBack : 5} days.`}
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            type="date"
            value={selectedDateStr}
            max={yesterdayStr}
            min={minDateStr}
            onChange={(e) => setSelectedDateStr(e.target.value)}
            style={{
              flex: 1,
              padding: '9px 10px',
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.surfaceAlt,
              color: COLORS.textPrimary,
              fontFamily: FONT_BODY,
              fontSize: 13,
            }}
          />
          <button
            onClick={() => loadDate(selectedDateStr)}
            disabled={loading}
            style={{
              padding: '9px 16px',
              borderRadius: 8,
              border: 'none',
              background: COLORS.emerald,
              color: '#ffffff',
              fontFamily: FONT_BODY,
              fontWeight: 700,
              fontSize: 12.5,
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? '...' : 'Load'}
          </button>
        </div>

        {loading && <div style={{ fontSize: 12, color: COLORS.textMuted }}>Loading {selectedDateStr}...</div>}

        {loaded && !loading && tickets.length === 0 && (
          <div style={{ fontSize: 12, color: COLORS.textMuted }}>No tickets found for {selectedDateStr}.</div>
        )}

        {!loading &&
          tickets.map((t) => (
            <TicketCard
              key={t.id}
              ticket={t}
              trialActive={true}
              unlocked={true}
              isSignedIn={true}
              isAdmin={isAdmin}
              hasSaintsLockAccess={true}
              hasSubscriptionAccess={true}
              requestedDateKey={requestedDateKeyForLoadedTickets}
              onWatchAd={() => {}}
              onSubscribe={() => {}}
              onPayPerTicket={() => {}}
              onSelectMatch={setArchiveSelectedMatch}
              onEditAsAdmin={onEditAsAdmin}
            />
          ))}

        {archiveSelectedMatch && (
          <MatchAnalysisModal match={archiveSelectedMatch} onClose={() => setArchiveSelectedMatch(null)} />
        )}
      </div>
    </div>
  );
}

function PricingModal({
  onClose,
  userId,
  userEmail,
  product = 'subscription',
  ticketId = null,
}: {
  onClose: () => void;
  userId: string | null;
  userEmail: string | null;
  /**
   * 'saints_lock' shows Saint's Lock's own $1.50/day-$7/week-$27/month
   * plans instead of the standard subscription tiers (see src/lib/plans.ts).
   * 'ticket_unlock' shows a single flat one-off price for the specific
   * ticket in `ticketId`, instead of a multi-plan picker.
   */
  product?: 'subscription' | 'saints_lock' | 'ticket_unlock';
  /** Required when product === 'ticket_unlock' — which ticket is being paid for. */
  ticketId?: string | null;
}) {
  const subscriptionPlans = [
    { id: 'weekly' as const, label: 'Weekly', price: '$2.49', period: '/week' },
    { id: 'monthly' as const, label: 'Monthly', price: '$7.99', period: '/month', highlight: true },
    { id: 'yearly' as const, label: 'Yearly', price: '$67', period: '/year', badge: 'Best value' },
  ];
  const saintsLockPlans = [
    { id: 'daily' as const, label: 'Daily', price: '$1.50', period: '/day' },
    { id: 'weekly' as const, label: 'Weekly', price: '$7', period: '/week', highlight: true },
    { id: 'monthly' as const, label: 'Monthly', price: '$27', period: '/month', badge: 'Best value' },
  ];
  // ticket_unlock has no plan picker — see the flat price line rendered below instead.
  const plans = product === 'saints_lock' ? saintsLockPlans : product === 'subscription' ? subscriptionPlans : [];

  // Countries PawaPay's direct mobile-money flow covers — kept in sync
  // with COUNTRY_CORRESPONDENTS in src/lib/pawapay.ts. This list only
  // matters when the visitor explicitly opts into mobile money below;
  // everyone else goes through Pesapal regardless of country.
  const PAWAPAY_COUNTRIES = new Set(['ZM', 'KE', 'UG', 'GH', 'RW', 'TZ', 'MW']);
  const countries = [
    { code: 'OTHER', label: 'Card / other (Pesapal)' },
    { code: 'ZM', label: 'Zambia' },
    { code: 'KE', label: 'Kenya' },
    { code: 'UG', label: 'Uganda' },
    { code: 'GH', label: 'Ghana' },
    { code: 'RW', label: 'Rwanda' },
    { code: 'TZ', label: 'Tanzania' },
    { code: 'MW', label: 'Malawi' },
  ];

  const [selectedPlan, setSelectedPlan] = useState<string>(
    product === 'saints_lock' ? 'weekly' : product === 'subscription' ? 'monthly' : 'single'
  );
  // Pesapal is the PRIMARY/DEFAULT checkout provider — country defaults to
  // the card/Pesapal option, and mobile money is an explicit opt-in below,
  // never auto-selected just because a country supports it.
  const [countryCode, setCountryCode] = useState('OTHER');
  const [useMobileMoney, setUseMobileMoney] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [status, setStatus] = useState<'idle' | 'starting' | 'awaiting_approval' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pollDepositId, setPollDepositId] = useState<string | null>(null);

  const needsPhone = useMobileMoney && PAWAPAY_COUNTRIES.has(countryCode);

  // Poll PawaPay deposit status once a phone-push payment has been
  // initiated — there's no redirect to bounce back to, so the UI has to
  // actively check whether the customer approved on their phone yet.
  useEffect(() => {
    if (!pollDepositId) return;
    let attempts = 0;
    const maxAttempts = 24; // ~2 minutes at 5s intervals
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(
          `/api/checkout/status?provider=pawapay&depositId=${encodeURIComponent(pollDepositId)}`
        );
        const data = await res.json();
        if (data.status === 'COMPLETED') {
          clearInterval(interval);
          window.location.reload(); // simplest way to refresh access state everywhere
        } else if (data.status === 'FAILED' || data.status === 'REJECTED') {
          clearInterval(interval);
          setError('Payment was not approved. Please try again.');
          setStatus('error');
          setPollDepositId(null);
        } else if (attempts >= maxAttempts) {
          clearInterval(interval);
          setError('Still waiting on approval — check your phone, or try again.');
          setStatus('error');
          setPollDepositId(null);
        }
      } catch {
        // transient network hiccup — let the next poll attempt retry
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [pollDepositId]);

  async function startCheckout() {
    if (!userId || !userEmail) {
      setError('Please sign in first, then come back to subscribe.');
      return;
    }
    if (product === 'ticket_unlock' && !ticketId) {
      setError('Missing ticket — please close this and try again.');
      return;
    }
    if (needsPhone && !phoneNumber.trim()) {
      setError('Phone number is required for mobile money.');
      return;
    }
    setError(null);
    setStatus('starting');

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product,
          plan: product === 'ticket_unlock' ? undefined : selectedPlan,
          ticketId: product === 'ticket_unlock' ? ticketId : undefined,
          userId,
          email: userEmail,
          countryCode: countryCode === 'OTHER' ? 'XX' : countryCode,
          phoneNumber: needsPhone ? phoneNumber.trim() : undefined,
          preferMobileMoney: useMobileMoney,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start checkout');

      if (data.provider === 'pesapal' && data.url) {
        window.location.href = data.url;
      } else if (data.provider === 'pawapay' && data.depositId) {
        setStatus('awaiting_approval');
        setPollDepositId(data.depositId);
      } else {
        throw new Error('Unexpected response from checkout');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setStatus('error');
    }
  }

  const modalTitle =
    product === 'saints_lock'
      ? "Get Saint's Lock access"
      : product === 'ticket_unlock'
      ? 'Unlock this ticket'
      : 'Choose your plan';

  const modalSubtitle =
    product === 'saints_lock'
      ? 'One ultra-high-confidence pick a day. No free trial applies — pay easily with card or mobile money.'
      : product === 'ticket_unlock'
      ? 'A one-time payment unlocks just this ticket — no subscription required.'
      : 'Unlock every tier, every day — pay easily with card or mobile money.';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 46,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: COLORS.surface,
          borderRadius: 14,
          padding: 22,
          width: '100%',
          maxWidth: 420,
          maxHeight: '85vh',
          overflowY: 'auto',
          boxShadow: '0 20px 60px -20px rgba(0,0,0,0.35)',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            background: 'none',
            border: 'none',
            color: COLORS.textMuted,
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>

        <h2
          style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 18,
            fontWeight: 800,
            color: COLORS.textPrimary,
            margin: '0 0 4px',
          }}
        >
          {modalTitle}
        </h2>
        <p style={{ fontSize: 11.5, color: COLORS.textMuted, margin: '0 0 16px' }}>{modalSubtitle}</p>

        {!userId && (
          <div
            style={{
              fontSize: 11.5,
              color: COLORS.textMuted,
              background: COLORS.surfaceAlt,
              borderRadius: 8,
              padding: '8px 10px',
              marginBottom: 14,
            }}
          >
            Sign in first — close this, tap Sign in, then come back.
          </div>
        )}

        {status === 'awaiting_approval' ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>📱</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary, marginBottom: 6 }}>
              Check your phone
            </div>
            <div style={{ fontSize: 11.5, color: COLORS.textMuted }}>
              Approve the payment prompt sent to {phoneNumber} to finish.
            </div>
          </div>
        ) : (
          <>
            {/* Plan picker — skipped entirely for ticket_unlock, which has
                exactly one flat price. */}
            {product === 'ticket_unlock' ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  border: `1.5px solid ${COLORS.emerald}`,
                  background: 'rgba(11,138,79,0.06)',
                  borderRadius: 10,
                  padding: '12px 14px',
                  marginBottom: 16,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>
                  Single ticket unlock
                  <div style={{ fontSize: 10.5, color: COLORS.textMuted, fontWeight: 400, marginTop: 2 }}>
                    One-time payment, this ticket only
                  </div>
                </div>
                <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 800, color: COLORS.emerald }}>
                  $0.99
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {plans.map((plan) => (
                  <button
                    key={plan.id}
                    onClick={() => setSelectedPlan(plan.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      width: '100%',
                      textAlign: 'left',
                      border: `1.5px solid ${selectedPlan === plan.id ? COLORS.emerald : COLORS.border}`,
                      background: selectedPlan === plan.id ? 'rgba(11,138,79,0.06)' : 'transparent',
                      borderRadius: 10,
                      padding: '10px 14px',
                      cursor: 'pointer',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.textPrimary }}>
                        {plan.label}
                        {'badge' in plan && plan.badge && (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 9.5,
                              fontWeight: 700,
                              color: COLORS.emerald,
                              background: 'rgba(11,138,79,0.1)',
                              borderRadius: 999,
                              padding: '2px 6px',
                            }}
                          >
                            {plan.badge}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10.5, color: COLORS.textMuted }}>Billed {plan.label.toLowerCase()}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 15, fontWeight: 800, color: COLORS.emerald }}>
                        {plan.price}
                      </div>
                      <div style={{ fontSize: 9.5, color: COLORS.textMuted }}>{plan.period}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Unified checkout form — Pesapal (card/other) is the default;
                mobile money is an explicit opt-in toggle, never auto-picked
                by country. */}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: COLORS.textPrimary,
                marginBottom: 10,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={useMobileMoney}
                onChange={(e) => {
                  setUseMobileMoney(e.target.checked);
                  if (e.target.checked && countryCode === 'OTHER') setCountryCode('KE');
                  if (!e.target.checked) setCountryCode('OTHER');
                }}
              />
              Pay with mobile money instead of card
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              {useMobileMoney && (
                <select
                  value={countryCode}
                  onChange={(e) => setCountryCode(e.target.value)}
                  style={{
                    padding: '9px 10px',
                    borderRadius: 8,
                    border: `1px solid ${COLORS.border}`,
                    background: COLORS.surfaceAlt,
                    color: COLORS.textPrimary,
                    fontFamily: FONT_BODY,
                    fontSize: 13,
                  }}
                >
                  {countries.filter((c) => c.code !== 'OTHER').map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}

              {needsPhone && (
                <input
                  type="tel"
                  placeholder="Mobile money phone number"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  style={{
                    padding: '9px 10px',
                    borderRadius: 8,
                    border: `1px solid ${COLORS.border}`,
                    background: COLORS.surfaceAlt,
                    color: COLORS.textPrimary,
                    fontFamily: FONT_BODY,
                    fontSize: 13,
                  }}
                />
              )}
            </div>

            <button
              onClick={startCheckout}
              disabled={status === 'starting' || !userId}
              style={{
                width: '100%',
                padding: '11px 0',
                borderRadius: 8,
                border: 'none',
                background: COLORS.emerald,
                color: '#ffffff',
                fontFamily: FONT_BODY,
                fontWeight: 700,
                fontSize: 13,
                cursor: status === 'starting' || !userId ? 'not-allowed' : 'pointer',
              }}
            >
              {status === 'starting' ? '...' : needsPhone ? '📱 Pay with Mobile Money' : 'Continue to Payment'}
            </button>
          </>
        )}

        {error && (
          <div style={{ marginTop: 12, fontSize: 11.5, color: COLORS.red, textAlign: 'center' }}>{error}</div>
        )}

        <div
          style={{
            marginTop: 16,
            fontSize: 10.5,
            color: COLORS.textMuted,
            textAlign: 'center',
            lineHeight: 1.5,
          }}
        >
          Card and other regions via Pesapal (default) · mobile money via PawaPay when selected above.
        </div>
      </div>
    </div>
  );
}

const REMINDER_DISMISS_KEY = 'odd_saint_reminder_dismissed_date';

function wasDismissedToday(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(REMINDER_DISMISS_KEY) === new Date().toDateString();
  } catch {
    return false;
  }
}

function markDismissedToday(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(REMINDER_DISMISS_KEY, new Date().toDateString());
  } catch {
    // localStorage unavailable — dismissal just won't persist, not worth failing over.
  }
}

function TrialReminderBanner({
  userEmail,
  daysLeft,
  signedUpDaysElapsed,
  signedUpTotalDays,
  onSignUpClick,
  onUpgradeClick,
}: {
  userEmail: string | null;
  daysLeft: number;
  signedUpDaysElapsed: number;
  signedUpTotalDays: number;
  onSignUpClick: () => void;
  onUpgradeClick: () => void;
}) {
  const [dismissed, setDismissed] = useState(wasDismissedToday);
  if (dismissed) return null;

  function dismiss() {
    markDismissedToday();
    setDismissed(true);
  }

  // Anonymous visitor, still within the trial window → nudge to sign up.
  const showSignUpNudge = !userEmail && daysLeft > 0;
  // Signed-up user, past the halfway point of their window → nudge to
  // upgrade. Scales with the actual policy rather than a hardcoded "15" —
  // that matters once the 50k-subscriber milestone sets signedUpTotalDays
  // to 0, where the nudge correctly starts immediately instead of a fixed
  // day count that would never be reached.
  const upgradeThreshold = Math.ceil(signedUpTotalDays / 2);
  const showUpgradeNudge = !!userEmail && signedUpDaysElapsed >= upgradeThreshold && daysLeft > 0;

  if (!showSignUpNudge && !showUpgradeNudge) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        background: COLORS.surfaceAlt,
        border: `1px solid ${COLORS.hairline}`,
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 14,
      }}
    >
      <div style={{ fontSize: 11.5, color: COLORS.textPrimary, lineHeight: 1.4 }}>
        {showSignUpNudge
          ? signedUpTotalDays > 0
            ? `Sign up free and get ${signedUpTotalDays} more day${signedUpTotalDays === 1 ? '' : 's'} — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left on your trial.`
            : `Sign up before your trial ends to keep access — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left.`
          : `Loving Odd Saint? Plans start at $2.49/week — ${daysLeft} free day${daysLeft === 1 ? '' : 's'} left.`}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <button
          onClick={showSignUpNudge ? onSignUpClick : onUpgradeClick}
          style={{
            padding: '6px 12px',
            borderRadius: 7,
            border: 'none',
            background: COLORS.emerald,
            color: '#ffffff',
            fontFamily: FONT_BODY,
            fontWeight: 700,
            fontSize: 11,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {showSignUpNudge ? 'Sign up' : 'See plans'}
        </button>
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          style={{ background: 'none', border: 'none', color: COLORS.textMuted, cursor: 'pointer', fontSize: 13 }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}


function Footer() {
  const [showLegal, setShowLegal] = useState(false);

  return (
    <div style={{ marginTop: 28, paddingTop: 18, borderTop: `1px solid ${COLORS.border}` }}>
      <button
        onClick={() => setShowLegal((s) => !s)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: COLORS.textMuted,
          fontFamily: FONT_BODY,
          fontSize: 11.5,
          cursor: 'pointer',
          textDecoration: 'underline',
          textUnderlineOffset: 3,
        }}
      >
        Legal & disclosures {showLegal ? '▲' : '▼'}
      </button>

      {showLegal && (
        <div style={{ marginTop: 12 }}>
          <IndemnificationNotice compact />
        </div>
      )}

      <div style={{ fontSize: 10.5, color: COLORS.textMuted, marginTop: 14, lineHeight: 1.5 }}>
        © {new Date().getFullYear()} Odd Saint.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Page() {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [registeredAt, setRegisteredAt] = useState<string | null>(null);
  const [anonTrialStart, setAnonTrialStart] = useState<string | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [selectedMatch, setSelectedMatch] = useState<Match | null>(null);
  const [showTeamSearch, setShowTeamSearch] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [archiveAccess, setArchiveAccess] = useState<ArchiveAccess>({ level: 'none' });
  const [saintsLockAccess, setSaintsLockAccess] = useState<SaintsLockAccess>({ active: false, expiresAt: null });
  const [subscriptionAccess, setSubscriptionAccess] = useState<SubscriptionAccess>({
    active: false,
    expiresAt: null,
  });
  const [paidUnlockedTicketIds, setPaidUnlockedTicketIds] = useState<Set<string>>(new Set());
  const [trialPolicy, setTrialPolicy] = useState<TrialPolicy>({
    anonymousDays: ANONYMOUS_TRIAL_DAYS,
    signedUpDays: SIGNED_UP_TRIAL_DAYS,
    milestoneReached: false,
  });
  const [showPricing, setShowPricing] = useState(false);
  const [pricingProduct, setPricingProduct] = useState<'subscription' | 'saints_lock' | 'ticket_unlock'>(
    'subscription'
  );
  const [unlockTicketId, setUnlockTicketId] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [history, setHistory] = useState<DayPerformance[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [unlocks, setUnlocks] = useState<UnlockMap>({});
  const [adTicketId, setAdTicketId] = useState<string | null>(null);
  const [adReady, setAdReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showSupport, setShowSupport] = useState(false);
  const [editingTicket, setEditingTicket] = useState<Ticket | null>(null);
  const [showFeedbackAdmin, setShowFeedbackAdmin] = useState(false);
  const [showGrantAccess, setShowGrantAccess] = useState(false);

  const isAdmin = archiveAccess.level === 'admin';

  // Every visitor gets the trial immediately — no account required. The
  // clock starts on first visit and is stored locally on their device.
  useEffect(() => {
    setAnonTrialStart(getAnonymousTrialStart());
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const user = data.session?.user ?? null;
      setUserEmail(user?.email ?? null);
      setUserId(user?.id ?? null);
      setRegisteredAt(user?.created_at ?? null);
      setLoading(false);
      getArchiveAccess(user?.id ?? null).then((a) => mounted && setArchiveAccess(a));
      getSaintsLockAccess(user?.id ?? null).then((a) => mounted && setSaintsLockAccess(a));
      getSubscriptionAccess(user?.id ?? null).then((a) => mounted && setSubscriptionAccess(a));
      getUnlockedTicketIds(user?.id ?? null).then((s) => mounted && setPaidUnlockedTicketIds(s));
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      setUserEmail(user?.email ?? null);
      setUserId(user?.id ?? null);
      setRegisteredAt(user?.created_at ?? null);
      getArchiveAccess(user?.id ?? null).then((a) => mounted && setArchiveAccess(a));
      getSaintsLockAccess(user?.id ?? null).then((a) => mounted && setSaintsLockAccess(a));
      getSubscriptionAccess(user?.id ?? null).then((a) => mounted && setSubscriptionAccess(a));
      getUnlockedTicketIds(user?.id ?? null).then((s) => mounted && setPaidUnlockedTicketIds(s));
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  function reloadTickets() {
    fetchTickets()
      .then(setTickets)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[Odd Saint] Failed to load tickets:', err);
      });
  }

  useEffect(() => {
    reloadTickets();
    fetchPerformanceHistory(14)
      .then(setHistory)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[Odd Saint] Failed to load performance history:', err);
      });
    getTrialPolicy()
      .then(setTrialPolicy)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[Odd Saint] Failed to load trial policy, using defaults:', err);
      });
  }, []);

  // Pesapal is the PRIMARY checkout provider, but unlike PawaPay it
  // normally confirms via server-to-server IPN, not a client-visible poll —
  // so a dropped/misconfigured IPN could otherwise strand a paying
  // customer with no feedback. Pesapal appends OrderTrackingId to the
  // callback URL on redirect (see callbackUrl in /api/checkout/route.ts),
  // so this checks for it once on mount and polls the same generalized
  // status endpoint PawaPay already used, as an independent safety net
  // alongside the IPN webhook.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const orderTrackingId = params.get('OrderTrackingId');
    if (!orderTrackingId) return;

    let attempts = 0;
    const maxAttempts = 24; // ~2 minutes at 5s intervals
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(
          `/api/checkout/status?provider=pesapal&orderTrackingId=${encodeURIComponent(orderTrackingId)}`
        );
        const data = await res.json();
        if (data.status === 'COMPLETED') {
          clearInterval(interval);
          window.location.href = window.location.pathname; // drop the query params, then reload fresh state
        } else if (data.status === 'FAILED' || data.status === 'REVERSED' || data.status === 'INVALID') {
          clearInterval(interval);
        } else if (attempts >= maxAttempts) {
          clearInterval(interval);
        }
      } catch {
        // transient network hiccup — let the next poll attempt retry
      }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Signed-up users get a fresh trial window from their account creation
  // date; anonymous visitors get one from first visit. These lengths are
  // dynamic — see getTrialPolicy(), which tightens both once the app
  // crosses the 50,000-active-subscriber milestone.
  const trialActive = useMemo(
    () =>
      userEmail
        ? isWithinFreeTrial(registeredAt, trialPolicy.signedUpDays)
        : isWithinFreeTrial(anonTrialStart, trialPolicy.anonymousDays),
    [userEmail, registeredAt, anonTrialStart, trialPolicy]
  );
  const daysLeft = useMemo(
    () =>
      userEmail
        ? getTrialDaysRemaining(registeredAt, trialPolicy.signedUpDays)
        : getTrialDaysRemaining(anonTrialStart, trialPolicy.anonymousDays),
    [userEmail, registeredAt, anonTrialStart, trialPolicy]
  );
  // How many days into the signed-up trial someone is — used to trigger
  // the day-15+ upgrade-to-paid reminder.
  const signedUpDaysElapsed = useMemo(() => {
    if (!userEmail || !registeredAt) return 0;
    return trialPolicy.signedUpDays - getTrialDaysRemaining(registeredAt, trialPolicy.signedUpDays);
  }, [userEmail, registeredAt, trialPolicy]);

  function handleWatchAd(ticketId: string) {
    setAdTicketId(ticketId);
    setAdReady(false);
  }

  function closeAdOverlay() {
    if (adTicketId) {
      setUnlocks((prev) => ({ ...prev, [adTicketId]: true }));
    }
    setAdTicketId(null);
    setAdReady(false);
  }

  // Real pay-per-ticket unlock: opens the pricing modal in 'ticket_unlock'
  // mode for this specific ticket. Previously this just set local React
  // state directly and unlocked the ticket for free — see
  // src/lib/plans.ts (TICKET_UNLOCK_PRICE_USD), src/lib/grantAccess.ts
  // (the 'ticket_unlock' branch), and supabase/migrations/004_ticket_unlocks.sql
  // for the real, persisted, paid version.
  function handlePayPerTicket(ticketId: string) {
    setUnlockTicketId(ticketId);
    setPricingProduct('ticket_unlock');
    setShowPricing(true);
  }

  function handleSubscribe(ticket?: Ticket) {
    setUnlockTicketId(null);
    setPricingProduct(ticket?.tier === 'saints_lock' ? 'saints_lock' : 'subscription');
    setShowPricing(true);
  }

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: COLORS.bg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: COLORS.textMuted,
          fontFamily: FONT_DISPLAY,
          fontSize: 14,
          letterSpacing: '0.02em',
        }}
      >
        Loading Odd Saint…
      </div>
    );
  }

  // Interleave a single in-feed ad slot right after the Bronze slips end
  // and before Gold begins.
  const feedItems: Array<{ kind: 'ticket'; ticket: Ticket } | { kind: 'ad' }> = [];
  const lastBronzeIndex = tickets.map((t) => t.tier).lastIndexOf('bronze');
  tickets.forEach((t, idx) => {
    feedItems.push({ kind: 'ticket', ticket: t });
    if (idx === lastBronzeIndex && lastBronzeIndex !== -1) feedItems.push({ kind: 'ad' });
  });

  const historySummary = summarizeHistory(history);
  const bronzeCountToday = tickets.filter((t) => t.tier === 'bronze').length;
  const goldCountToday = tickets.filter((t) => t.tier === 'gold').length;
  const saintsLockTickets = tickets.filter((t) => t.tier === 'saints_lock');
  // The main feed always requests "today" (UTC) — see fetchTickets()'s
  // default param in dataFetcher.ts. Computed once per render so the
  // release badge's carried-forward comparison stays consistent across
  // every ticket rendered in this pass.
  const todayKeyUTC = ticketDateKey(new Date());

  return (
    <div style={{ minHeight: '100vh', background: COLORS.bg, color: COLORS.textPrimary, paddingBottom: 76 }}>
      {/* Header */}
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
        <Logo light />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setShowTeamSearch(true)}
            aria-label="Search a team"
            style={{
              background: 'rgba(255,255,255,0.12)',
              border: '1px solid rgba(255,255,255,0.4)',
              borderRadius: 7,
              padding: '6px 10px',
              color: '#ffffff',
              fontFamily: FONT_BODY,
              fontSize: 13,
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            🔍
          </button>
          {archiveAccess.level !== 'none' && (
            <button
              onClick={() => setShowArchive(true)}
              aria-label="Ticket archive"
              style={{
                background: 'rgba(255,255,255,0.12)',
                border: '1px solid rgba(255,255,255,0.4)',
                borderRadius: 7,
                padding: '6px 10px',
                color: '#ffffff',
                fontFamily: FONT_BODY,
                fontSize: 13,
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              🕐
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setShowFeedbackAdmin(true)}
              aria-label="Moderate feedback"
              style={{
                background: 'rgba(255,255,255,0.12)',
                border: '1px solid rgba(255,255,255,0.4)',
                borderRadius: 7,
                padding: '6px 10px',
                color: '#ffffff',
                fontFamily: FONT_BODY,
                fontSize: 13,
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              💬
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setShowGrantAccess(true)}
              aria-label="Grant access to someone"
              style={{
                background: 'rgba(255,255,255,0.12)',
                border: '1px solid rgba(255,255,255,0.4)',
                borderRadius: 7,
                padding: '6px 10px',
                color: '#ffffff',
                fontFamily: FONT_BODY,
                fontSize: 13,
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              🎁
            </button>
          )}
          {userEmail ? (
            <button
              onClick={() => supabase.auth.signOut()}
              style={{
                background: 'rgba(255,255,255,0.12)',
                border: '1px solid rgba(255,255,255,0.4)',
                borderRadius: 7,
                padding: '6px 12px',
                color: '#ffffff',
                fontFamily: FONT_BODY,
                fontSize: 11.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Sign out
            </button>
          ) : (
            <button
              onClick={() => setShowLoginModal(true)}
              style={{
                background: '#ffffff',
                border: 'none',
                borderRadius: 7,
                padding: '6px 12px',
                color: COLORS.emerald,
                fontFamily: FONT_BODY,
                fontSize: 11.5,
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              Sign in
            </button>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: '16px' }}>
        <Hero
          bronzeCount={bronzeCountToday}
          goldCount={goldCountToday}
          winRatePct={historySummary.winRatePct}
          onViewHistory={() => setShowHistory((s) => !s)}
        />

        {showHistory && <PerformanceHistory history={history} />}

        {/* Trial banner */}
        <div
          style={{
            position: 'relative',
            background: trialActive ? 'rgba(16,185,129,0.08)' : COLORS.surfaceAlt,
            border: `1px solid ${trialActive ? COLORS.emerald + '40' : COLORS.border}`,
            borderRadius: 10,
            padding: '11px 14px',
            fontFamily: FONT_BODY,
            fontSize: 12.5,
            lineHeight: 1.5,
            marginBottom: 14,
            color: trialActive ? COLORS.emerald : COLORS.textMuted,
          }}
        >
          {isAdmin
            ? 'Admin account — every ticket, every tier, including Saint\'s Lock, is unlocked for you automatically.'
            : subscriptionAccess.active
            ? 'Your subscription is active — every tier is unlocked.'
            : trialActive
            ? userEmail
              ? `Free trial active — ${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining. Weekly Titan stays free forever now that you're signed in.`
              : `Free trial active — ${daysLeft} day${daysLeft === 1 ? '' : 's'} remaining. Every ticket is unlocked, no account needed.`
            : 'Your free trial has ended. The Mega Day Ticket stays free forever — unlock premium tiers with an ad, a per-ticket unlock, or a subscription.'}
        </div>

        {!isAdmin && (
          <TrialReminderBanner
            userEmail={userEmail}
            daysLeft={daysLeft}
            signedUpDaysElapsed={signedUpDaysElapsed}
            signedUpTotalDays={trialPolicy.signedUpDays}
            onSignUpClick={() => setShowLoginModal(true)}
            onUpgradeClick={() => handleSubscribe()}
          />
        )}

        {/* Saint's Lock — daily marketing countdown strip. Shown above the
            accordion feed so it's visible whether or not the ticket is
            opened. Sign-up required, no trial ever applies (see
            TicketCard's isLocked logic for saints_lock) — admins are the
            one exception, handled inside TicketCard itself. */}
        {saintsLockTickets.map((t) => (
          <SaintsLockCountdown key={`countdown-${t.id}`} ticket={t} />
        ))}
        {saintsLockTickets.length > 0 && !userEmail && (
          <div
            style={{
              background: COLORS.surfaceAlt,
              border: `1px solid ${COLORS.hairline}`,
              borderRadius: 10,
              padding: '10px 14px',
              marginBottom: 14,
              fontSize: 11.5,
              color: COLORS.textMuted,
            }}
          >
            Saint's Lock requires a free account to access — sign in to continue.
          </div>
        )}

        {/* Ticket feed with in-feed ad injection */}
        {feedItems.map((item, idx) =>
          item.kind === 'ad' ? (
            <div key={`ad-${idx}`} style={{ marginBottom: 14 }}>
              <AdSlot variant="infeed" />
            </div>
          ) : (
            <TicketCard
              key={item.ticket.id}
              ticket={item.ticket}
              trialActive={trialActive}
              unlocked={!!unlocks[item.ticket.id] || paidUnlockedTicketIds.has(item.ticket.id)}
              isSignedIn={!!userEmail}
              isAdmin={isAdmin}
              hasSaintsLockAccess={saintsLockAccess.active}
              hasSubscriptionAccess={subscriptionAccess.active}
              requestedDateKey={todayKeyUTC}
              onWatchAd={handleWatchAd}
              onSubscribe={() => handleSubscribe(item.ticket)}
              onPayPerTicket={handlePayPerTicket}
              onSelectMatch={setSelectedMatch}
              onEditAsAdmin={setEditingTicket}
            />
          )
        )}

        <Footer />
      </div>

      {/* Sticky anchor ad banner */}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30 }}>
        <AdSlot variant="anchor" />
      </div>

      {/* Support / feedback entry point — always available */}
      <SupportButton onClick={() => setShowSupport(true)} />

      {/* Watch-ad-to-unlock overlay */}
      {adTicketId && (
        <WatchAdOverlay onDone={() => setAdReady(true)} onClose={closeAdOverlay} />
      )}

      {/* Optional sign-in modal — never blocks browsing, only opened by choice */}
      {showLoginModal && (
        <LoginModal
          onSent={(email) => {
            setUserEmail(email);
          }}
          onClose={() => setShowLoginModal(false)}
        />
      )}

      {/* Tap-to-analyze modal — reads only data already in memory, no extra API calls */}
      {selectedMatch && (
        <MatchAnalysisModal match={selectedMatch} onClose={() => setSelectedMatch(null)} />
      )}

      {/* Team history search — queries the team_match_history view directly */}
      {showTeamSearch && <TeamSearchModal onClose={() => setShowTeamSearch(false)} />}

      {/* Ticket archive — trigger only renders for admin/subscriber, but the
          real security boundary is Supabase RLS on the admins/subscribers
          tables, not this UI gate. */}
      {showArchive && archiveAccess.level !== 'none' && (
        <TicketArchiveModal
          access={archiveAccess}
          onClose={() => setShowArchive(false)}
          isAdmin={isAdmin}
          onEditAsAdmin={setEditingTicket}
        />
      )}

      {showPricing && (
        <PricingModal
          onClose={() => setShowPricing(false)}
          userId={userId}
          userEmail={userEmail}
          product={pricingProduct}
          ticketId={unlockTicketId}
        />
      )}

      {showSupport && (
        <SupportModal onClose={() => setShowSupport(false)} userId={userId} userEmail={userEmail} />
      )}

      {/* Admin feedback moderation — rendered only for admins (isAdmin gates
          the header button that opens this); RLS is still the real
          enforcement boundary underneath. */}
      {showFeedbackAdmin && isAdmin && (
        <AdminFeedbackModal onClose={() => setShowFeedbackAdmin(false)} />
      )}

      {/* Admin grant-access — rendered only for admins (isAdmin gates the
          header button that opens this); the real enforcement boundary is
          server-side in /api/admin/grant-access, checked against the
          `admins` table with the service-role key. */}
      {showGrantAccess && isAdmin && (
        <AdminGrantAccessModal onClose={() => setShowGrantAccess(false)} />
      )}

      {/* Admin match editor — rendered only for admins (isAdmin gates the
          "Edit matches" button that opens this); RLS is still the real
          enforcement boundary underneath. */}
      {editingTicket && (
        <AdminMatchEditorModal
          ticket={editingTicket}
          onClose={() => setEditingTicket(null)}
          onChanged={() => {
            reloadTickets();
            setEditingTicket(null);
          }}
        />
      )}
    </div>
  );
}
