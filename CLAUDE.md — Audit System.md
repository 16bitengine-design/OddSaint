# CLAUDE.md — Audit System Additions

Add this section to CLAUDE.md. Documents the weekly/quarterly/yearly audit
reporting system added after the initial launch + payment/feedback batches.

---

## NEW — AUDIT REPORTING (Weekly / Quarterly / Yearly)

Three report-only workflows, same bounded principle as
`analyze-performance.mjs` / `analyze-feedback.mjs`: read real data, write a
markdown report to the GitHub Actions step summary, change nothing
automatically.

**Cadence:**
- **Weekly** (`audit-weekly.mjs`) — Mondays 05:00 UTC. The only one with a
  day-by-day breakdown table ("a weekly report based on daily
  performance"); quarterly/yearly stay at window totals on purpose.
- **Quarterly** (`audit-quarterly.mjs`) — 1st of Jan/Apr/Jul/Oct, 06:00 UTC.
- **Yearly** (`audit-yearly.mjs`) — Jan 2nd, 07:00 UTC.

All three are also manually dispatchable from the Actions tab.

**What's covered, and where the data actually comes from:**

| Metric | Source |
|---|---|
| New / total subscribers | `subscribers`, `saints_lock_access`, `app_stats` (Supabase) |
| Most viewed tickets, views by tier, high-velocity hours/days | new `ticket_views` table |
| Page load time (LCP) | new `page_perf` table |
| Satisfaction score | new `satisfaction_ratings` table |
| Support/feedback volume | existing `feedback` table, windowed by date |
| Win rate | existing `fixtures`/`tickets` (headline only — run the Performance Digest workflow for the full threshold backtest) |
| New visitors, traffic source/origin, location, age group, top pages | **GA4 Data API**, pulled live at report time — NOT duplicated into Supabase |
| App status (uptime/error rate) | **not tracked** — see Known Gap below |

**Implementation:**
- `scripts/lib/auditMetrics.mjs` — all Supabase aggregation, shared by all three scripts (one definition of "new subscriber", "most viewed ticket", etc., same principle as `markets.mjs` being shared by generation/grading).
- `scripts/lib/ga4.mjs` — GA4 Data API client. Zero extra npm dependencies — hand-rolled service-account JWT + OAuth2 flow using `node:crypto`, same "just use fetch" philosophy as `apiFootball.mjs`. Requires the `GA4_PROPERTY_ID` and `GA4_SERVICE_ACCOUNT_KEY` GitHub Actions secrets (see setup steps in the file header); every audit script still produces a full report from Supabase data alone if these aren't configured.
- `scripts/lib/auditReport.mjs` — pure markdown-formatting functions, kept separate from data-fetching.
- `src/lib/telemetry.ts` — client-side: `trackTicketView()`, `trackPageLoad()`, `submitSatisfactionRating()`. Deliberately separate from GA4 (which `layout.tsx` already fires) — this only covers what GA4 doesn't give cleanly. Every call is fire-and-forget and fails silently; telemetry must never break the product.
- `src/app/SatisfactionWidget.tsx` — standalone 1–5 rating widget, not folded into `page.tsx`.

**Database:** `supabase/migrations/004_audit_instrumentation.sql` adds `ticket_views`, `satisfaction_ratings`, `page_perf` — insert-only from anon/authenticated (same pattern as `feedback`), admin-only select via RLS, service-role bypasses for the report scripts.

**Frontend wiring required (not yet done automatically — see integration notes):**
- Call `trackPageLoad(window.location.pathname)` once in `Page`'s mount effect.
- Call `trackTicketView(ticket.id, ticket.tier)` in `TicketCard`'s open-toggle handler, only on the transition to open (not every render).
- Render `<SatisfactionWidget userId={userId} />` somewhere in `Page` (e.g. near the trial banner).

**Known gaps (honest scope):**
- **App status / uptime is not tracked.** No status-check workflow, no Vercel/third-party monitor wired in. Until that exists, "is the app healthy" means checking the Actions tab for green `generate-tickets`/`grade-tickets` runs directly.
- **Age/gender breakdown depends on GA4 Google Signals** being enabled and on sufficient traffic — `getAgeBreakdown()` legitimately returns empty in many valid configurations, not just broken ones.
- **No period-over-period deltas.** Each report shows one window's totals; comparing against the prior period means opening the previous run's step summary by hand.
- **`satisfaction_ratings` and `feedback` are intentionally separate.** The former is a trackable number over time; the latter is free-text a human moderates. Don't merge them.
