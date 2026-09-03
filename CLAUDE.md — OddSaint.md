# CLAUDE.md — Additions and Changes

Add these sections to the existing CLAUDE.md to document the batch of updates applied after the initial launch.

---

## NEW — 7. TICKET RELEASE SCHEDULING (Staggered)

Tickets are released in two staggered batches per day rather than all at once, to signal curation intent and prevent an "illusion of choice."

**Release times (UTC, two daily):**
- **Slot 0**: 06:00 UTC (morning batch)
- **Slot 1**: 14:00 UTC (afternoon batch)

Each tier caps at **MAX_TICKETS_PER_CATEGORY = 2** per day — matching values in both `src/lib/dataFetcher.ts` and `scripts/generate-tickets.mjs`. The second slot only fills if at least **MIN_HOURS_BETWEEN_SLOTS = 6** have elapsed since slot 0 for that tier, enforced in code, so the two releases stay meaningfully spread regardless of cron scheduling jitter.

**Previous batches remain visible until the next one lands** — Supabase rows are never deleted or overwritten, only new rows added, so the current feed stays stable until the next scheduled release. The frontend's `getNextReleaseLabel()` shows users the clock time of the next slot in their local timezone.

**Implementation:**
- Database: `release_slot` (0 or 1) and `available_at` (ISO timestamp) columns on `tickets` table.
- Generation: `fetchTodaysSlipState()` and `nextSlotFor()` in `scripts/generate-tickets.mjs` query what already exists today and decide whether *this* run fills slot 0, slot 1, or skips the tier.
- Frontend: `TicketCard` displays the release timestamp via `formatReleaseTime()` so users know when each slip actually landed.

---

## UPDATED — 7. TIER CONFIG SYNC (Bug Fix)

**Tier match counts must be identical in both files or the UI will misrepresent how many legs a ticket has:**
- `src/lib/dataFetcher.ts` — used by frontend mock fallback and display labels
- `scripts/generate-tickets.mjs` — used by the real generation pipeline

**Current counts (as of this batch of updates):**
```
tier        matchCount
mega        4
bronze      3
silver      5
gold        7
platinum    9         ← reduced by 1 from 10 (compounded margin reduction)
diamond     14        ← reduced by 1 from 15
weekly_lite 19        ← reduced by 1 from 20
weekly_titan 29       ← reduced by 1 from 30
saints_lock 1
```

The `platinum`, `diamond`, `weekly_lite`, `weekly_titan` reductions were intentional to lower win probability by cutting one compounding bookmaker-margin leg. **These two files had drifted out of sync before this batch** — `dataFetcher.ts` still showed the old 10/15/20/30 figures. Fixed in this update. Always sync them when the counts change.

---

## NEW — 8. SAINT'S LOCK PRODUCT RULES (Hard Enforcement)

Saint's Lock is a single-match, ultra-high-confidence category with distinct access control, separate from all other tiers:

**Product rules (coded, not advisory):**
- **Min 1, max 2 per day** — guaranteed at least one pick per day (falls back to best-available if confidence floor isn't met on day 1), capped at 2 via staggered slots.
- **Confidence floor: 85%** — drastically higher than standard MIN_CONFIDENCE = 68. Matches below this floor are simply not included.
- **Sign-up mandatory** — no anonymous trial access ever applies to Saint's Lock, coded via `hasSaintsLockAccess` check in `TicketCard`.
- **No free trial** — separate paid product, distinct from trial/subscription tiers.
- **Pricing:** $1.50/day, $7/week, $27/month (separate from standard subscription tiers).
- **Odds range:** 1.5–2.0 — safest, most-favored picks only.

**Database:**
- `saints_lock_access` table gates who can see/unlock Saint's Lock tickets.
- RLS enforces user can only read their own row.

**Frontend marketing:**
- `SaintsLockCountdown` strip renders above the accordion feed (always visible), showing next kickoff time with daily reminder to create urgency.
- Gated behind sign-up check: `!userEmail && <div>Sign in to access</div>`

**Implementation references:**
- `buildSaintsLockTickets()` in `scripts/generate-tickets.mjs` — custom selection logic, not generic per-tier fallback
- `getSaintsLockAccess()` in `src/lib/dataFetcher.ts` — access check
- `SaintsLockCountdown` in `src/app/page.tsx` — daily marketing display
- Pricing tiers in `src/lib/plans.ts`

---

## NEW — 11. ADMIN MATCH EDITOR

Admins can add or remove individual fixtures on a specific ticket post-generation — to pull a match they judge too risky, or add one they consider a stronger pick.

**Scope:**
- Only operates on fixtures the pipeline has already priced for that ticket's date (`fixtures` table) — not inventing new matches from scratch.
- Real security boundary is Supabase RLS (see `supabase/migrations/002_batch_updates.sql`): only a user in `admins` can write to `ticket_matches` or `tickets`.
- Frontend UI gate is admin-only, but RLS is the actual enforcement.

**UI:**
- `AdminMatchEditorModal` in `src/app/page.tsx` — shows "On this ticket" (with Remove buttons) and "Available today" (with Add buttons).
- Triggered from `TicketCard` by "✎ Edit matches (admin)" button, only rendered for `isAdmin` users.
- Calls `adminAddFixtureToTicket()` / `adminRemoveFixtureFromTicket()` in `src/lib/dataFetcher.ts`.

**Behavior:**
- Adding a fixture appends it to the ticket with a new sort order.
- Removing a fixture deletes the link and recomputes the ticket's `match_count` and `total_odds`.

---

## NEW — 14. DATABASE — FEEDBACK TABLE

Added `feedback` table to support customer support and bounded self-improvement:

**Structure:**
```sql
feedback (
  id uuid primary key,
  user_id uuid references auth.users(id),
  email text,
  category text check (in 'usability','performance','bug','support_request','general'),
  message text,
  status text check (in 'pending','approved','rejected'),
  flagged_reason text,
  created_at timestamptz
)
```

**RLS:**
- Anonymous and authenticated users can insert (anyone can submit feedback).
- Authenticated users can only read their own rows.
- Admins (see `admins` table) can read all rows and update status.

**Workflow:**
- User submits → `status: 'pending'` in `feedback` table via `submitFeedback()` in `src/lib/feedback.ts`.
- Pre-filter (pattern-based, not ML) catches obvious spam before insert.
- Admin moderates via `moderateFeedback()` (also in `src/lib/feedback.ts`) → moves to `'approved'` or `'rejected'`.
- Weekly digest (see **Self-Improvement Workflow** below) reads `status = 'approved'` rows only.
- Nothing is ever shown publicly in-app without going through this gate — "filter customer reactions before they're posted" is enforced at the DB level.

---

## NEW — 27. SELF-IMPROVEMENT WORKFLOW (Bounded)

Automated weekly maintenance, deliberately limited to produce a human-reviewable report rather than autonomous code changes.

**Workflow:** `scripts/analyze-feedback.mjs` + `.github/workflows/analyze-feedback.yml`

**Manual trigger only** — never scheduled, so it stays a deliberate check-in rather than an autonomous loop.

**What it does:**
1. Reads approved feedback from the `feedback` table (status = 'approved').
2. Groups by category (usability, performance, bug, support_request, general).
3. Produces a plain-language digest written to the GitHub Actions step summary.
4. Explicitly documents the three evaluation criteria a human should weigh it against before acting:
   - Usability — is the app easy to use?
   - Performance quality — does it produce genuinely positive results?
   - Discoverability — is it SEO-responsive and searchable?

**What it does NOT do:**
- Change any code or configuration automatically.
- Deploy anything.
- Modify the ticket-generation algorithm.

This is "self-improvement" in the sense of a structured review process, not autonomous changes. If autonomous evolution ever becomes desired, that's a separate, much bigger decision requiring explicit approval and different safety scaffolding.

---

## NEW — ADMIN FEEDBACK MODERATION UI

Added `AdminFeedbackModal` to the frontend for admins to review and approve/reject pending feedback without touching the Supabase Table Editor directly.

**Location:** `src/app/page.tsx`, wired into Page component with:
```tsx
const [showFeedbackModeration, setShowFeedbackModeration] = useState(false);
// ...
{isAdmin && (
  <button onClick={() => setShowFeedbackModeration(true)}>
    Moderate feedback
  </button>
)}
{showFeedbackModeration && (
  <AdminFeedbackModal onClose={() => setShowFeedbackModeration(false)} />
)}
```

**UI:**
- Lists pending feedback (oldest first), with category, timestamp, email, and message preview.
- Approve/Reject buttons per item.
- Approved feedback feeds into the weekly digest; rejected feedback is archived.

---

## UPDATED — 20. IMPORTANT NOTES — LEAGUE CONFIGURATION

**Belgium (Jupiler Pro League), Denmark (Superligaen), and Norway (Eliteserien)** are now the regional tier-one leagues prioritized by the generation pipeline, replacing Portugal. This is a product direction choice.

Implementation: `PRIORITY_LEAGUE_NAMES` in `scripts/generate-tickets.mjs` includes all three by their published league names.

---

## UPDATED — 8. KNOWN GAPS (Still True)

- **Admin match-editor only adds already-priced fixtures** — doesn't invent new matches from scratch. This is intentional: an admin curates from what the pipeline has already scored, not hand-entering odds.
- **Feedback pre-filter is pattern-based** — detects obvious spam (too short, link-spam, repeated characters) but is not a trained ML classifier. Real moderation judgment stays with the admin review queue.
- **Mock Saint's Lock** in the fallback data always shows 2 slips rather than respecting the min-1 logic. Cosmetic — only affects local dev before real Supabase data exists.

---

## SUMMARY OF FILES CHANGED IN THIS BATCH

- `supabase/migrations/002_batch_updates.sql` — new: schema changes (release slots, feedback table, admin RLS)
- `.github/workflows/generate-tickets.yml` — updated: two daily cron slots
- `.github/workflows/analyze-feedback.yml` — new: manual-trigger feedback digest
- `scripts/generate-tickets.mjs` — updated: staggered slot logic, tier counts, Saint's Lock selection
- `scripts/analyze-feedback.mjs` — new: feedback digest reporter
- `src/lib/dataFetcher.ts` — updated: tier count sync fix, release-slot fields, Saint's Lock access, admin match-editor helpers
- `src/lib/feedback.ts` — new: pre-filter, submit, admin moderation functions
- `src/app/page.tsx` — updated: Saint's Lock fixes (crash + countdown + gating), admin match editor modal, support widget, release time display, admin feedback modal support
