# CLAUDE.md — Additions and Changes

Add these sections to the existing CLAUDE.md to document the batch of updates applied after the initial launch.

---

## NEW — 7. TICKET RELEASE SCHEDULING (Staggered)

Tickets are released in two staggered batches per day rather than all at once, to signal curation intent and prevent an "illusion of choice."

**Generation times** (when the pipeline actually runs and prices fixtures):
- **Slot 0**: 03:00 UTC / 06:00 East Africa Time (EAT, UTC+3, no DST)
- **Slot 1**: 10:00 UTC / 13:00 East Africa Time

**Availability times** (when a slip actually becomes visible/usable — see section 31 below):
- **Slot 0**: 04:00 UTC / 07:00 EAT — one hour after generation
- **Slot 1**: 11:00 UTC / 14:00 EAT — one hour after generation

Each tier caps at **MAX_TICKETS_PER_CATEGORY = 2** per day — matching values in both `src/lib/dataFetcher.ts` and `scripts/generate-tickets.mjs`. The second slot only fills if at least **MIN_HOURS_BETWEEN_SLOTS = 6** have elapsed since slot 0's *generation* time for that tier (the two 03:00/10:00 UTC triggers are 7h apart, so this always clears) — `nextSlotFor()` recovers the generation time from the stored `available_at` by subtracting `AVAILABILITY_DELAY_MS`, since `available_at` itself is stamped 1 hour later than generation.

**Previous batches remain visible until the next one lands** — Supabase rows are never deleted or overwritten, only new rows added, so the current feed stays stable until the next scheduled release. The frontend's `getNextReleaseLabel()` shows users the clock time of the next slot in their local timezone, and `getDailyRefreshInfo()` in `src/app/page.tsx` reads the first slot's hour from the shared `RELEASE_SLOT_HOURS_UTC` constant (exported from `dataFetcher.ts`, and representing AVAILABILITY hours, not generation hours) rather than a separately hardcoded value, so the displayed time can never drift from the actual cron schedule.

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
weekender   35        ← NEW — spans Sat+Sun, own dedicated fixture pool
saints_lock 1
```

The `platinum`, `diamond`, `weekly_lite`, `weekly_titan` reductions were intentional to lower win probability by cutting one compounding bookmaker-margin leg. **These two files had drifted out of sync before this batch** — `dataFetcher.ts` still showed the old 10/15/20/30 figures. Fixed in this update. Always sync them when the counts change.

---

## NEW — 28. WEEKENDER TIER

A 35-match accumulator spanning both Saturday and Sunday — distinct from Weekly Lite/Titan, which use the current-day/current-week fixture pools.

**Product rules:**
- Match count: 35 (ceiling, same "fewest legs to reach target" logic as other tiers — Weekender has no fixed odds target, so it just takes the safest available up to the ceiling, same as Weekly Lite/Titan).
- One slip a day (`getDailySlipCount` returns 1, same bucket as `platinum`/`diamond`/`weekly_lite`/`weekly_titan`).
- Odds range: "Mixed" — no `TIER_ODDS_TARGET` entry, same as the two weekly tiers.

**Dedicated fixture pool:**
- `upcomingWeekendDates(now)` in `scripts/generate-tickets.mjs` returns the next Saturday+Sunday date pair from any day of the week (today itself if today already is Sat/Sun) — mirrors the `WEEKLY_LOOKAHEAD_DAYS` lookahead pattern.
- Fetched via its own `fetchPricedFixtures(weekendDates, MAX_ODDS_LOOKUPS_PER_RUN)` call in `main()`, kept separate from the daily and weekly pools.
- Runs on every generation run (both daily slots), not gated to weekend-only runs — this only became viable after moving off the API-Football Free plan (see below), since Free's narrow date-range window meant fetching a few days ahead of a Tuesday run risked a hard failure.
- `fetchPricedFixtures` now catches a per-date fetch failure and skips just that date (with a console warning) instead of crashing the whole script — a safety net in case a date still turns out to be outside whatever range the current plan allows.

**Frontend/mock:**
- `TicketTier` and `TIER_CONFIG` in `src/lib/dataFetcher.ts` include `weekender` alongside the other large-accumulator tiers.
- Mock data generates a Weekender slip every day (no day-of-week restriction), mirroring the real pipeline's "always attempt" behavior.

---

## NEW — 29. API-FOOTBALL PLAN: FREE → PRO

The account moved from API-Football's Free plan (10 req/min, 100 req/day) to **Pro** (300 req/min, 7,500 req/day).

**Changed as a result:**
- `scripts/lib/apiFootball.mjs`: `MAX_REQUESTS_PER_WINDOW` raised from 8 to 250 (comfortable margin under the 300/min cap).
- `scripts/generate-tickets.mjs`: `MAX_ODDS_LOOKUPS_PER_RUN` raised from 25 to 200. Worst case is 3 pools (daily/weekly/weekender) × 2 runs/day × 200 = 1,200 odds lookups/day, leaving well over 6,000/day of headroom for grading (every 3h) and manual/one-off script runs.
- The Weekender tier's "always attempt, any day" fetch pattern (see above) — not viable on Free's narrow date-range window.

**Known gap — flagged for verification, not yet directly confirmed:** whether Pro actually widens the specific future-date range that produced the Free-plan `"Free plans do not have access to this date"` error, and by how many days. The code is defensive either way (`fetchPricedFixtures` skips an out-of-range date instead of crashing), but this is worth confirming from the first few real Action run logs rather than assumed.

---

## NEW — 30. LEAGUE QUALITY FILTER + FULL-WIN GUARANTEE

Two accuracy-focused changes to selection, both defense-in-depth rather than single-point fixes.

**League quality filter (`scripts/lib/leagueQuality.mjs`, NEW, shared):**
- Excludes youth (U10–U23), reserve/B-team, amateur/regional/non-league, and named third-division-or-lower competitions (Serie C/D, Segunda B, 3. Liga, League One/Two, etc.) by name pattern.
- Applied in TWO places so a stale `leagues.json` can't reintroduce them: `scripts/resolve-leagues.mjs`'s `isUsableLeague()` (keeps them out of `leagues.json` at the source) and `scripts/generate-tickets.mjs`'s fixture-eligibility filter (defense-in-depth).
- HONEST SCOPE NOTE: API-Football exposes no explicit division-tier field, so this is a name-pattern heuristic, not a verified lookup — see the file header in `leagueQuality.mjs`. Review `AMATEUR_LEAGUE_PATTERNS` periodically against real league names in the Actions logs.

**Full-win guarantee (`ensureFullWinLeg()` in `scripts/generate-tickets.mjs`, plus `FULL_WIN_MARKETS` exported from `scripts/lib/markets.mjs`):**
- Home Win / Away Win markets were already never substituted away for being "too tight" — their own odds band in `MARKET_CATALOG` starts at 1.3, so the old tight-price guard (`WIN_MARKET_MIN_ODDS`) could only ever fire for Double Chance sub-markets. This is now documented explicitly in code rather than being an implicit side effect.
- NEW: every generic-tier ticket (mega/bronze/silver/gold/platinum/diamond/weekly_lite/weekly_titan/weekender) now tries to guarantee at least one outright Home/Away Win leg via `ensureFullWinLeg()`, called at both return points of `pickFixturesForSlip()`. It swaps in the safest available full-win fixture from the pool, preferring the least-disruptive swap (trying each leg position, highest-odds first) and only keeping a swap that lands the ticket's total back within the existing 30% tolerance band. Best-effort: if no full-win fixture is available in the pool, or no swap keeps the total in range, the ticket is left as assembled rather than forced.
- Saint's Lock (`buildSaintsLockTickets()`) is deliberately EXCLUDED from this guarantee — it's a single-leg, confidence-first pick with no "ticket completeness" concept, and swapping in a lower-confidence full-win fixture just to satisfy a market-type preference would contradict its own design principle (see the note in code).

---

## NEW — 31. MINIMUM KICKOFF LEAD TIME + ONE-HOUR AVAILABILITY DELAY

Two accuracy/product-quality rules, both in `scripts/generate-tickets.mjs`.

**Minimum 2 hours to kickoff (`MIN_HOURS_TO_KICKOFF` / `hasMinimumLeadTime()`):**
- Applied inside `fetchPricedFixtures()`'s fixture-eligibility filter, alongside the league-quality and big-clash checks — so it covers every pool (daily, weekly, weekender) automatically, with no separate enforcement needed per tier.
- A fixture is only eligible if its kickoff is at least 2 hours after the moment the run started (`now`, threaded through from `main()` into every `fetchPricedFixtures()` call so the whole run judges fixtures against one consistent instant, not wall-clock time creeping as the run executes).
- Rationale: protects against picks generated too close to kickoff, where there's less time for team news, a lineup change, or a postponement to surface before someone acts on the pick.

**One-hour availability delay (`AVAILABILITY_DELAY_MS`):**
- A ticket row is written to Supabase immediately at generation time, but its `available_at` is stamped as generation time + 1 hour, not the write time itself.
- Enforced on the READ side: `fetchRealTicketsForDate()` in `src/lib/dataFetcher.ts` filters out any row whose `available_at` hasn't passed yet. If nothing for today is accessible yet, it falls back to mock data (same fallback path as "no real data yet").
- Once a batch's `available_at` passes, it stays visible/accessible all day, same as before — nothing about "throughout the day" changed; only the exact moment things first become visible moved.
- Side effect requiring a fix: `nextSlotFor()`'s staggered-release gap check reads `available_at` from previous rows to measure time since the last slip. Since `available_at` is now 1 hour later than the actual generation time, the gap check subtracts `AVAILABILITY_DELAY_MS` back out before comparing against `MIN_HOURS_BETWEEN_SLOTS` — otherwise the measured gap would be skewed exactly 1 hour short, which at this schedule's 7-hour generation gap would land right on the 6-hour minimum boundary instead of safely clearing it.

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
- **Weekender's Pro-plan date-range assumption is unverified** — see section 29 above. Watch the first few real Action run logs.

---

## SUMMARY OF FILES CHANGED IN THIS BATCH

- `supabase/migrations/002_batch_updates.sql` — new: schema changes (release slots, feedback table, admin RLS)
- `.github/workflows/generate-tickets.yml` — updated: two daily cron slots, now 03:00/10:00 UTC generation (06:00/13:00 EAT)
- `.github/workflows/analyze-feedback.yml` — new: manual-trigger feedback digest
- `scripts/generate-tickets.mjs` — updated: staggered slot logic, tier counts, Saint's Lock selection, Weekender tier + dedicated weekend pool, Pro-plan `MAX_ODDS_LOOKUPS_PER_RUN`, per-date fetch resilience, amateur/youth league filter, full-win-leg guarantee (`ensureFullWinLeg`), minimum 2h kickoff lead time, 1h availability delay (`AVAILABILITY_DELAY_MS`), `nextSlotFor()` gap-math fix for that delay
- `scripts/lib/apiFootball.mjs` — updated: Pro-plan rate-limit constants
- `scripts/lib/leagueQuality.mjs` — new: shared youth/reserve/lower-division league name filter, used by both `resolve-leagues.mjs` and `generate-tickets.mjs`
- `scripts/lib/markets.mjs` — updated: exports `FULL_WIN_MARKETS`
- `scripts/resolve-leagues.mjs` — updated: applies the league quality filter before writing `leagues.json`
- `scripts/analyze-feedback.mjs` — new: feedback digest reporter
- `src/lib/dataFetcher.ts` — updated: tier count sync fix, release-slot fields (now 04:00/11:00 UTC availability, 1h after 03:00/10:00 UTC generation), Weekender tier, `fetchRealTicketsForDate()` now filters out rows not yet accessible, Saint's Lock access, admin match-editor helpers
- `src/lib/feedback.ts` — new: pre-filter, submit, admin moderation functions
- `src/app/page.tsx` — updated: Saint's Lock fixes (crash + countdown + gating), admin match editor modal, support widget, release time display (now reads `RELEASE_SLOT_HOURS_UTC[0]` instead of a hardcoded hour), admin feedback modal support
