# CLAUDE.md — Odd Saint Project Instructions

CONSOLIDATION NOTE: this file merges what were previously four separate
documents — the base `CLAUDE.md` plus three standalone addenda
(`CLAUDE.md — OddSaint.md`, `CLAUDE.md — Audit System.md`,
`CLAUDE.md — OddSaint Self-Improvement.md`) that were never actually
folded in. Sections 1–40 are the original base instructions, unchanged.
Sections 41+ absorb the three addenda, de-duplicated and reorganized so
each topic lives in exactly one place. Where an addendum updated a rule
stated earlier (e.g. tier counts, access model), the later section is
the current, authoritative one — noted inline.

---

# PART 1 — CORE PROJECT INSTRUCTIONS

## 1. PROJECT IDENTITY

OddSaint is a football analytics and prediction-ticket web application.

The application presents football prediction tickets built from real football fixtures and bookmaker odds, tracks fixture outcomes, grades completed selections, provides historical performance information, and provides paid access to premium products.

OddSaint is not a betting operator.

The application presents AI-assisted/statistical football analysis and must not represent predictions as guarantees.

The current GitHub repository is the authoritative source of truth for the implementation.

Do not assume that historical descriptions of OddSaint, 16BITENGINE, or previous versions of the project still match the current code.

## 2. SOURCE OF TRUTH

Use the following priority when determining how the system works:

1. Current repository source code
2. Current Supabase schema
3. Current GitHub Actions workflows
4. Current package/configuration files
5. Current README/documentation
6. Current CLAUDE.md instructions
7. Historical conversation context

If historical information conflicts with the repository, the repository wins.

Never invent functionality that is not present in the repository.

Never describe planned functionality as implemented functionality.

If something is mocked, stubbed, incomplete, or security-sensitive, explicitly identify it as such.

## 3. CURRENT TECHNOLOGY STACK

* Next.js 14.2.35, App Router
* React 18.3.1
* TypeScript 5.5.4
* Supabase JS 2.45.4
* Supabase, GitHub, GitHub Actions, Vercel
* Node.js 24.x

Do not replace these technologies unnecessarily. Do not introduce a new framework or backend platform without a strong architectural reason.

## 4. REPOSITORY STRUCTURE (current, high-level)

```text
OddSaint/
├── .github/workflows/          # ~20 workflows — see §26/§48 for the full current list
├── scripts/
│   ├── lib/                    # apiFootball, theOddsApi, footballDataOrg, markets,
│   │                           # leagueQuality, womensLeagueFilter, fixtureMatcher,
│   │                           # teamModel, modelCrossCheck, ga4, auditMetrics,
│   │                           # auditReport, lifecycleEmail.mjs, supabaseAdmin.mjs,
│   │                           # leagues.json, teams.json, backfillProgress.json
│   ├── generate-tickets.mjs
│   ├── grade-tickets.mjs
│   ├── resolve-leagues.mjs / resolve-teams.mjs
│   ├── backfill-team-history.mjs
│   ├── self-tune.mjs / propose-improvements.mjs
│   ├── analyze-feedback.mjs / analyze-performance.mjs
│   ├── audit-weekly.mjs / audit-quarterly.mjs / audit-yearly.mjs
│   ├── send-lifecycle-emails.mjs
│   └── register-pesapal-ipn.mjs
├── src/
│   ├── app/
│   │   ├── api/{checkout,webhooks,admin}/...
│   │   ├── privacy/, terms/, sitemap.ts
│   │   ├── layout.tsx, page.tsx, SatisfactionWidget.tsx
│   └── lib/                    # dataFetcher, grantAccess, pawapay, pesapal, plans,
│                                # supabaseClient, supabaseAdmin.ts, feedback,
│                                # lifecycleEmail.ts, telemetry, adminGrant
├── supabase/schema.sql          # consolidated — see §14
├── README.md, package.json, next.config.js, tsconfig.json
```

The structure evolves; update this section rather than forcing new code into an obsolete layout.

## 5. FRONTEND

The main application UI lives in `src/app/page.tsx` — a client component containing branding, ticket display, match display/status, performance history, team search, trial/access behavior, subscription UI, ad slots, checkout interaction, and disclaimers.

Do not casually convert the page into a different architecture. Understand existing state/data dependencies before extracting components. Avoid unnecessary rewrites of `page.tsx`.

## 6. DATA LAYER

Primary data layer: `src/lib/dataFetcher.ts`. Reads real ticket data from Supabase, populated by the GitHub Actions pipeline.

**Current state (post §54 "mock removal"): there is no deterministic mock/fallback generator anymore.** `fetchLatestTickets()` walks backward up to 30 days for the most recent real accessible batch; `fetchTickets(date)` and `fetchPerformanceHistory()` return honest empty/no-data results rather than fabricated placeholders. Never reintroduce fabricated tickets or fabricated performance stats without an explicit product decision to do so.

## 7. TICKET TIERS

Current tiers and match counts (`src/lib/dataFetcher.ts` `TIER_CONFIG` and `scripts/generate-tickets.mjs` `TIER_CONFIG` — **must stay in sync between these two files**):

| tier | matchCount | odds range | notes |
|---|---|---|---|
| mega | 4 | 1.5–3 | always free |
| bronze | 3 | 2–3 | |
| silver | 5 | 3–5 | |
| gold | 7 | 5–10 | |
| platinum | 9 | 25–300 | −1 from "standard" 10, deliberate margin reduction |
| diamond | 14 | 300+ | −1 from 15 |
| weekly_lite | 19 | Mixed | −1 from 20 |
| weekly_titan | 29 | Mixed | −1 from 30 |
| weekender | 35 | Mixed | spans Sat+Sun, own dedicated fixture pool — see §44 |
| saints_lock | 1 | 1.5–2 | see §49 for hard product rules |

These numeric targets are enforced during slip assembly (`TIER_ODDS_TARGET` in `generate-tickets.mjs`), not just display labels. If tier definitions change, update both files and any dependent DB/UI logic together — never one in isolation (this exact drift was a real bug, fixed once already).

## 8. IMPORTANT TICKET-ENGINE DISTINCTION

The "AI Confidence Index" is a transparent heuristic derived from bookmaker consensus/implied probability (now vig-corrected multi-bookmaker consensus — see §56), **not** a trained ML model. Do not describe it as a trained AI model unless the repo actually contains one (see §41 for what that would require).

## 9. REAL TICKET GENERATION

Main script: `scripts/generate-tickets.mjs`. Runs twice daily (staggered release — see §42), workflow: `.github/workflows/generate-tickets.yml`.

Pipeline: fetch fixtures → apply league/amateur/women's/big-clash/excluded-team/kickoff-lead-time filters (§45, §46) → fetch consensus odds (§56) → select viable market per fixture → build tiers, enforcing odds targets and the full-win guarantee (§45) → write to Supabase.

Do not change the generation script without considering API-Football/Odds API/football-data.org request limits (§29, §43) and GitHub Actions execution constraints.

## 10. API-FOOTBALL

`scripts/lib/apiFootball.mjs`. Now on the **Pro plan** (300 req/min, 7,500/day) — see §43 for what changed as a result. Also see §56: majors-pool fixtures now come from football-data.org + The Odds API instead, with API-Football reserved for Platinum/Diamond/Weekly Lite/Weekly Titan.

Treat every external football data provider as unreliable by default: rate limits, unavailable dates, missing odds/fixtures, postponed fixtures, malformed responses. Never silently fabricate real football data.

## 11. MARKET CATALOG

`scripts/lib/markets.mjs` — shared by generation and grading. Principle: **a market must not be selectable unless it's also gradable.** Adding a market means updating the outcome definition, odds range, settlement function, and confirming both generation and grading paths, in one place — never duplicate settlement logic elsewhere. `FULL_WIN_MARKETS` (Home Win / Away Win) is exported here specifically for the full-win guarantee in `generate-tickets.mjs` (§45).

## 12. TICKET GRADING

`scripts/grade-tickets.mjs`, runs every 3 hours (`grade-tickets.yml`). Only checks fixtures whose kickoff was ≥2.5h ago; confirms a real finished status before settling. Never mark a fixture settled merely because kickoff has passed.

## 13. LEAGUE RESOLUTION

`scripts/resolve-leagues.mjs` writes `scripts/lib/leagues.json` from API-Football's own `/leagues` endpoint rather than hardcoded guesses — now also applies the league-quality filter (§45) and the women's-league filter (§46) before writing. Workflow (`resolve-leagues.yml`) is manual-trigger only. `scripts/resolve-teams.mjs` / `resolve-teams.yml` do the equivalent for team IDs (`teams.json`), depended on by `scripts/backfill-team-history.mjs` (§47).

## 14. DATABASE

Authoritative definition: `supabase/schema.sql` — **now a single consolidated file** covering every table, including what were previously four separately-numbered "004_*.sql" migrations (fixture country, audit instrumentation, lifecycle email grants, ticket unlocks) plus the self-improvement tables (`tuning_state`, `tuning_log`, model cross-check columns) and `admin_grants`. Every statement is idempotent (`if not exists` / `drop policy if exists` / `or replace`) and safe to re-run against a database that already has some of these objects.

Current tables/views: `fixtures`, `tickets`, `ticket_matches`, `team_match_history` (view), `admins`, `app_settings`, `subscribers`, `app_stats`, `saints_lock_access`, `admin_grants`, `pending_transactions`, `ticket_unlocks`, `user_profiles`, `notification_log`, `ticket_views`, `satisfaction_ratings`, `page_perf`, `feedback`, `tuning_state`, `tuning_log`.

Before changing database behavior: read the schema, identify affected tables/RLS/app/Action dependencies, consider existing production data. Never casually drop or rename tables/columns. **Going forward, add new tables/columns directly into `schema.sql` — do not create a new standalone numbered migration file** (this is exactly the sprawl this consolidation pass was meant to stop).

## 15. DATABASE SECURITY

Public reads vs. privileged writes stay separated. The automation pipeline uses the Supabase service-role key, which must never reach the browser. `pending_transactions` is server-side only. RLS policies control row visibility; explicit `GRANT`s (§28 learning) control whether a role can attempt the operation at all — both are required, and a missing grant is a real, previously-hit failure mode (42501 errors), not a hypothetical. Preserve these boundaries.

## 16. AUTHENTICATION AND USER ACCESS

Supabase Auth backs subscription/Saint's Lock/ticket-unlock access via `auth.users` relationships and RLS restricting users to their own records. Never weaken RLS boundaries to make frontend queries easier.

## 17. PLANS

`src/lib/plans.ts`:
- Subscription: Weekly $2.49/7d, Monthly $7.99/30d, Yearly $67/365d
- Saint's Lock (separate product): Daily $1.50/1d, Weekly $7/7d, Monthly $27/30d
- Ticket unlock (one-off, non-expiring, single ticket): `TICKET_UNLOCK_PRICE_USD` — currently a **placeholder** ($0.99), confirm before relying on it in production

Never hard-code prices independently elsewhere. The server derives amount from the validated plan ID; never trust a client-submitted price.

## 18. ACCESS GRANTING

Centralized in `src/lib/grantAccess.ts` — `grantAccessForPayment()` is the single chokepoint for subscription, Saint's Lock, and ticket-unlock grants, called by both payment webhooks, the status-poll route, and the admin comp route (§48). Never duplicate entitlement-granting logic elsewhere. **Note:** per §51, the access model is currently pivoted to free-after-signup — this function and the products it grants still exist and work, they're just not the primary unlock path right now (see §51 for what's live).

## 19. PAYMENT ARCHITECTURE

`src/app/api/checkout/route.ts` chooses the provider server-side:

```text
User → /api/checkout → country/network supported by PawaPay AND preferMobileMoney=true?
  YES → PawaPay direct mobile-money deposit → pending_transactions → webhook/poll
  NO  → Pesapal hosted checkout (default/primary) → pending_transactions → IPN
```

Also handles `product: 'ticket_unlock'`, validating the ticket exists server-side before charging. Never move provider selection entirely to the client.

## 20. PAWAPAY

`src/lib/pawapay.ts`, `src/app/api/webhooks/pawapay/route.ts`, `src/app/api/checkout/status/route.ts`. Opt-in only (`preferMobileMoney: true`), never the default. `PAWAPAY_ENV` / `PAWAPAY_API_TOKEN` — never exposed client-side. Correspondent codes are best-effort from public docs, not live-verified — see file header note; verify against the PawaPay dashboard before treating as production-ready.

**Status update:** the webhook now re-verifies status directly with PawaPay's own API (`checkDepositStatus`) rather than trusting the callback payload — the cryptographic-signature gap flagged in the base instructions is mitigated by this verify-with-provider pattern, but true callback signature authentication (if PawaPay's API supports it) has not been separately confirmed. Don't describe the webhook as fully production-secure without checking current PawaPay docs for a signature/HMAC option.

## 21. PESAPAL

`src/lib/pesapal.ts`, `src/app/api/webhooks/pesapal/route.ts`, `scripts/register-pesapal-ipn.mjs`, `.github/workflows/register-pesapal-ipn.yml`. **Pesapal is the primary/default checkout provider** (§19). Hosted redirect; `PESAPAL_IPN_ID` must be registered once (manual workflow) before submitting orders. Never re-register on every checkout. Credentials stay server-side.

## 22. PENDING TRANSACTIONS

`pending_transactions` maps provider transaction IDs to user/email/product/plan/provider/status, now including `ticket_id` for the ticket-unlock product (§14). Payment processing must use this mapping, never trust arbitrary client-provided state.

## 23. PAYMENT IDEMPOTENCY

Webhook + status-polling can both observe the same successful payment. Access-granting uses upserts and pending-transaction status checks to stay idempotent — `notification_log`'s insert-first pattern (§13/§53) is the same principle applied to lifecycle emails. Never remove these protections; explicitly test duplicate-callback scenarios when touching payment code.

## 24. ADVERTISING

`AdSlot` (`data-ad-slot="infeed"|"anchor"`) is a placeholder abstraction, not a live ad network integration. **Note:** the "Watch Ad to Reveal" flow described in earlier versions of this doc was removed entirely in the access-model pivot (§51) — don't assume it still exists. When integrating a real provider: preserve the separation, keep it replaceable, protect UX, never let ads interfere with payment/auth, never misrepresent simulated ads as real.

## 25. LEGAL/PRODUCT POSITIONING

UI presents Odd Saint as AI-assisted/statistical analysis, never a guarantee. Every lifecycle-email template (`scripts/lib/lifecycleEmail.mjs`, `src/lib/lifecycleEmail.ts`) deliberately avoids "guaranteed"/"risk-free"/"certain outcome" language — do not loosen this wording without deliberate product/legal review. This positioning is also load-bearing in `src/app/terms/page.tsx` and `src/app/privacy/page.tsx` — treat those pages as a legal artifact, not just copy.

## 26. GITHUB ACTIONS

Treat each workflow and the script it runs as one coupled system — inspect both before changing either. Current workflow count is much larger than the original five listed in early project docs; see §4/§48 for the fuller current list. Consider: secrets, permissions, schedules, Node version, generated files, git commits, failure behavior.

## 27. SELF-EVOLUTION WORKFLOW

`.github/workflows/ai-self-evolution.yml` — weekly dependency-update sweep with `contents: write` + `pull-requests: write`, opens a PR, never auto-merges. Do not expand autonomous write capability casually. Automated evolution must stay reviewable, bounded, reversible, testable — this principle also governs the newer self-improvement system in §55; never build an autonomous path that silently ships unreviewed changes to production.

## 28. ENVIRONMENT VARIABLES AND SECRETS

Never expose real secrets, never request them in chat, use variable names only.

```text
Supabase:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
Football:  API_FOOTBALL_KEY, ODDS_API_KEY, FOOTBALL_DATA_ORG_TOKEN
PawaPay:   PAWAPAY_API_TOKEN, PAWAPAY_ENV
Pesapal:   PESAPAL_CONSUMER_KEY, PESAPAL_CONSUMER_SECRET, PESAPAL_ENV, PESAPAL_IPN_ID
Email:     BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME
Analytics: NEXT_PUBLIC_GA_MEASUREMENT_ID, GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_KEY
Site:      NEXT_PUBLIC_SITE_URL
```

Never hard-code credentials or commit `.env` files with real values.

## 29. VERCEL

Deployment platform. Keep Next.js compatible: serverless execution, request timeouts, env vars, server/client boundaries, build behavior. Don't move GitHub-Actions-appropriate scheduled work into a normal Vercel request.

## 30. KNOWN REPOSITORY INCONSISTENCIES (verify before trusting)

- **`src/lib/supabaseAdmin.ts`** — this file now exists in the current repo (service-role client, `getSupabaseAdmin()`, cached singleton) and is imported correctly by `grantAccess.ts` and the API routes. The original "file appears missing" flag in early project docs is resolved — but if this discrepancy resurfaces after a refactor, re-verify via build/type-check rather than assuming either way.
- **Stale comments** referencing Stripe/Flutterwave may still exist in older code — architecture is PawaPay/Pesapal. Code wins over comments; update misleading comments when you touch that code.
- **`teamModel.mjs`'s real export shape** was assumed when `modelCrossCheck.mjs` was built (§55) — verify `computeMatchProbabilities()` actually matches before trusting cross-check data.
- **`tuning_state` seed vs. live drift** — the self-improvement migration seeds `min_confidence` at 68 (`generate-tickets.mjs`'s own constant), while `analyze-performance.mjs` documents 74 as a previously-live value in a different context. Confirm which is actually correct for the current live pipeline before trusting `self-tune.mjs`'s first before/after comparison.
- **Weekender's Pro-plan date-range assumption is unverified** — see §43.
- **Mock Saint's Lock in old fallback data always showed 2 slips** — moot now that the mock generator is removed (§6), noted here only in case it resurfaces in a revert.

## 31. MOCK DATA

**Superseded by §6/§54: there is currently no mock/fallback generator in `dataFetcher.ts`.** This section is kept only as a historical flag — if a mock path is ever reintroduced, it must never be presented as real historical performance, and the UI must distinguish "genuinely nothing generated yet" (honest empty state) from a database failure.

## 32. DEVELOPMENT WORKFLOW

1. **INSPECT** — read the relevant implementation.
2. **TRACE** — determine dependencies and execution flow.
3. **PLAN** — identify the smallest safe change.
4. **IMPLEMENT** — modify only what is necessary.
5. **VERIFY** — run appropriate tests/build/lint checks.
6. **REPORT** — files changed, behavior changed, tests performed, known limitations, remaining risks.

## 33. NEVER GUESS

Inspect the repo for: database columns, API behavior, environment variables, provider behavior, route names, component names, workflow schedules, payment status semantics, deployment configuration. Verify current official provider docs before implementing external-API-dependent behavior.

## 34. SECURITY-FIRST DEVELOPMENT

For every change consider: authentication, authorization, RLS, input validation, API abuse, secret exposure, payment manipulation, webhook authenticity, privilege escalation, data leakage, duplicate transactions. Security-sensitive changes require more scrutiny than ordinary UI changes.

## 35. NO UNNECESSARY REWRITES

Prefer targeted changes. Don't rewrite a large file for a small feature, replace working architecture for aesthetics, or introduce duplicate systems. For a genuinely necessary major refactor: explain the problem, the risk, the proposed architecture, affected files — and separate the refactor from unrelated feature work.

## 36. TESTING

At minimum: TypeScript, lint, production build, API routes, DB queries, auth/authz, payment flows, webhook behavior, GitHub Actions, external API failure handling. For payment changes specifically: valid/rejected/failed payment, duplicate callback, repeated polling, missing transaction, invalid plan/product/country/network.

## 37. DOCUMENTATION

Important architectural decisions get documented in the repo (README, technical docs, this file) — not left to live only in chat history.

## 38. FUTURE AI/PREDICTION ENGINE

If/when the prediction system evolves beyond bookmaker-odds heuristics into a genuine trained model: separate it clearly from the heuristic system, document data source/training/evaluation methodology, track model versioning, avoid data leakage, avoid unearned accuracy claims, preserve reproducibility. Never call a heuristic an AI model for marketing purposes. (Note: §56's "own first-party Poisson model" is a real statistical model but explicitly not a trained ML model, and explicitly cross-check-only, not selection-influencing — it does not yet satisfy this section's bar for a genuine prediction-engine evolution.)

## 39. PRODUCT EVOLUTION

Aim toward: reliable data, stronger methodology, transparent performance measurement, scalable generation, robust payments, secure access, meaningful analytics, advertiser readiness, strong UX, maintainable architecture — without adding complexity absent a concrete justification.

## 40. FINAL RULE / GOLDEN RULE

OddSaint is one interconnected production system: Frontend → Data layer → API → Business logic → Supabase → External providers, and separately GitHub Actions → External football data → Ticket generation → Supabase → Frontend → Grading → Performance history. Before any change, locate it in these flows and identify what depends on it.

**Inspect → Understand → Plan → Implement → Test → Document.**
Never: Guess → Rewrite → Assume → Deploy.

---

# PART 2 — SCHEDULING, TIERS & SELECTION (absorbs former "CLAUDE.md — OddSaint.md")

## 41. TICKET RELEASE SCHEDULING (staggered)

Two generation runs/day: **03:00 UTC / 06:00 EAT** (slot 0) and **10:00 UTC / 13:00 EAT** (slot 1). Availability (when a slip actually becomes visible) is generation time **+1 hour**: 04:00/11:00 UTC — see §42.

Each tier caps at `MAX_TICKETS_PER_CATEGORY = 2`/day (both `dataFetcher.ts` and `generate-tickets.mjs`). Slot 1 only fills if `MIN_HOURS_BETWEEN_SLOTS = 6` have elapsed since slot 0's *generation* time (recovered from `available_at` minus `AVAILABILITY_DELAY_MS`, per §42). Previous batches stay visible — rows are never deleted/overwritten. `getNextReleaseLabel()` / `getDailyRefreshInfo()` in the frontend read from the shared `RELEASE_SLOT_HOURS_UTC` constant, never a separately hardcoded hour.

Implementation: `release_slot` / `available_at` columns on `tickets`; `fetchTodaysSlipState()` / `nextSlotFor()` in `generate-tickets.mjs` decide slot 0 / slot 1 / skip per tier per run.

## 42. MINIMUM KICKOFF LEAD TIME + AVAILABILITY DELAY

**`MIN_HOURS_TO_KICKOFF = 2`** — `hasMinimumLeadTime()` filters out any fixture within the fixture-eligibility filter, applied uniformly across daily/weekly/weekender pools via one `now` anchor per run (threaded through `main()`), so the whole run judges against one consistent instant.

**`AVAILABILITY_DELAY_MS = 1 hour`** — a ticket row is written at generation time but `available_at` is stamped generation+1h; enforced on the read side by `fetchRealTicketsForDate()` filtering out not-yet-accessible rows. `nextSlotFor()`'s gap check subtracts this delay back out before comparing against `MIN_HOURS_BETWEEN_SLOTS` (§41) to avoid a skewed measurement.

## 43. API-FOOTBALL PLAN: FREE → PRO

Moved to **Pro** (300 req/min, 7,500/day) from Free (10/min, 100/day).

- `apiFootball.mjs`: `MAX_REQUESTS_PER_WINDOW` 8 → 250.
- `generate-tickets.mjs`: `MAX_ODDS_LOOKUPS_PER_RUN` 25 → 200. Worst case: 3 pools × 2 runs/day × 200 = 1,200/day, leaving >6,000/day headroom for grading + manual runs.
- Enabled the Weekender tier's "always attempt, any day" fetch pattern (not viable on Free's narrow date window).

**Unverified, flag for confirmation:** whether Pro actually widens the specific future-date range that produced Free's `"Free plans do not have access to this date"` error, and by how many days. Code is defensive either way (`fetchPricedFixtures` skips an out-of-range date rather than crashing) — confirm from real Action run logs rather than assuming.

## 44. WEEKENDER TIER

35-match accumulator spanning Sat+Sun, own dedicated pool — distinct from Weekly Lite/Titan's current-day/current-week pools.

- One slip/day (`getDailySlipCount` → 1, same bucket as platinum/diamond/weekly_lite/weekly_titan).
- No fixed odds target — "Mixed," safest-available-up-to-ceiling, same as the two weekly tiers.
- `upcomingWeekendDates(now)` returns the next Sat+Sun pair (today itself if today already is Sat/Sun) — mirrors `WEEKLY_LOOKAHEAD_DAYS`.
- Fetched via its own `fetchPricedFixtures(weekendDates, MAX_ODDS_LOOKUPS_PER_RUN)` call, kept separate from daily/weekly pools; runs every generation run, not gated to weekends — only viable after the Pro-plan move (§43).
- `fetchPricedFixtures` catches a per-date fetch failure and skips just that date rather than crashing the whole run.

## 45. LEAGUE QUALITY FILTER + FULL-WIN GUARANTEE

**League quality filter** (`scripts/lib/leagueQuality.mjs`, shared): excludes youth (U10–U23), reserve/B-team, amateur/regional/non-league, and named third-division-or-lower competitions by name pattern. Applied in `resolve-leagues.mjs`'s `isUsableLeague()` (source) and `generate-tickets.mjs`'s fixture filter (defense-in-depth against a stale `leagues.json`). Name-pattern heuristic — API-Football exposes no explicit division-tier field; review `AMATEUR_LEAGUE_PATTERNS` periodically against real league names in the logs.

**Full-win guarantee** (`ensureFullWinLeg()` + `FULL_WIN_MARKETS` from `markets.mjs`): Home/Away Win markets were already never substituted away for being "too tight" (their odds band starts at 1.3 — the tight-price guard can only ever fire on Double Chance sub-markets). Every generic-tier ticket now tries to guarantee at least one outright Home/Away Win leg, swapping in the safest available full-win fixture and keeping only a swap that lands the total back within the existing 30% tolerance band. Best-effort — leaves the ticket as assembled if no qualifying swap exists. **Saint's Lock is deliberately excluded** — see §49, this would contradict its confidence-first design.

## 46. WOMEN'S-COMPETITION FILTER

`scripts/lib/womensLeagueFilter.mjs` — product decision: men's football only, currently. Matches by league-name keyword (`women`, `ladies`, `frauen`, `wsl`, etc.) plus a hardcoded list for leagues without an obvious keyword (`Liga F`, `Damallsvenskan`, `Toppserien`, etc.). Applied in both `resolve-leagues.mjs` and `generate-tickets.mjs`, same redundant-defense pattern as §45. Name-only heuristic — extend `KNOWN_WOMENS_LEAGUES_WITHOUT_KEYWORD` if a new one slips through.

## 47. TEAM HISTORY BACKFILL

`scripts/backfill-team-history.mjs` (weekly, `backfill-team-history.yml`) proactively pulls each known team's last 20 finished fixtures from API-Football into `team_results_history` — independent of whether that team was ever picked for a ticket, unlike the `fixtures`-table-derived `team_match_history` view. Feeds `teamModel.mjs`'s Poisson model (§56). **Budget-capped**: `MAX_TEAMS_PER_RUN = 15` per run, cycling never-backfilled-first via `backfillProgress.json` (committed back to the repo by the workflow) — never raise this without checking headroom against the twice-daily generation + every-3h grading jobs sharing the same API-Football budget.

## 48. ADMIN TOOLING

- **Admin match editor** (`AdminMatchEditorModal` in `page.tsx`) — add/remove fixtures already priced for that date (`fixtures` table), never invents new matches. Real boundary is RLS on `ticket_matches`/`tickets` (only `admins` can write); UI gate is convenience only.
- **Admin grant-access** (`AdminGrantAccessModal`, `/api/admin/grant-access`, `src/lib/adminGrant.ts`) — an admin comps subscription/Saint's Lock access for another (already-signed-in) user, via the same `grantAccessForPayment()` every real payment calls. Real boundary: server verifies the caller's own session token, then checks `admins` with the service-role key — nothing before that point trusts the caller's own claim of admin status. Every grant is logged to `admin_grants` (§14).
- **Admin feedback moderation** (`AdminFeedbackModal`) — approve/reject pending `feedback` rows; only `approved` items feed the weekly digest (§53).

## 49. SAINT'S LOCK — HARD PRODUCT RULES (coded, not advisory)

- Min 1, max 2/day — falls back to best-available if the 85% floor isn't cleared on slot 0 only; slot 1 is never relaxed (would defeat the "next to impossible" positioning).
- **`SAINTS_LOCK_MIN_CONFIDENCE = 85`** — well above the standard `MIN_CONFIDENCE = 68` (or the tuned value from `tuning_state`, §55).
- Sign-up mandatory, **no anonymous trial ever applies** — this specific rule survived the access-model pivot (§51) unchanged even though every other tier's trial behavior changed.
- Odds range 1.5–2.0 only.
- Pricing: $1.50/day, $7/week, $27/month (separate from `PLANS`).
- Dedicated selection logic (`buildSaintsLockTickets()`), not the generic per-tier loop — highest-confidence-first in the odds band, not least-used/safest-first like every other tier.
- Deliberately excluded from the full-win guarantee (§45) and from the multi-bookmaker consensus's oddsMin/oddsMax retuning caveat (§56) — same "quality-first, no market-type preference override" principle throughout.

## 50. COUNTRY FIELD

Every fixture carries its league's nation (`league.country` from API-Football, captured in `fetchPricedFixtures()`), shown as e.g. "Premier League (England)" in match rows, the analysis modal, and the admin fixture picker. Column: `fixtures.country`, defaults `'Unknown'` for pre-existing rows (§14). Grading and `team_match_history` were deliberately left untouched — country isn't needed to settle a market or build the team-history view.

## 51. ACCESS MODEL — CURRENT STATE: FREE-AFTER-SIGNUP (growth phase)

**This supersedes any trial/paywall description elsewhere in this file where they conflict.** Strategic pivot: grow the signed-up list first, monetize later.

```ts
// TicketCard unlock formula, src/app/page.tsx
const isUnlocked = isAdmin || isSignedIn || ticket.isFree || (!isSaintsLock && trialActive);
```

- **Anonymous visitor:** `ANONYMOUS_TRIAL_DAYS = 7` full access, except Saint's Lock (never trialed, §49).
- **Any signed-up user** (free signup, no payment): permanent, unconditional access to everything, including Saint's Lock. No expiry, no day counter.
- **Admin:** always unlocked.
- **Mega Day Ticket:** always free regardless of trial state.

**Removed entirely, not just hidden:** the "Watch Ad to Reveal" flow, "Pay Micro-Fee"/`handlePayPerTicket`, Saint's Lock's separate paid-pass fetch/state, `TrialReminderBanner`'s upgrade-to-paid variant.

**Kept fully intact and dormant, for future paid re-introduction:** `PricingModal`, `handleSubscribe()`, `plans.ts`, the checkout API routes, `pawapay.ts`/`pesapal.ts`/`grantAccess.ts`, and the `subscribers`/`saints_lock_access`/`pending_transactions` tables. Re-adding a paid tier is wiring a button back to `handleSubscribe()`, not rebuilding payment infra. `SIGNED_UP_TRIAL_DAYS` and the `SUBSCRIBER_MILESTONE` tightening mechanism are likewise still computed by `getTrialPolicy()` but unused for gating.

**Known, accepted gap:** the ticket **archive** (`getArchiveAccess()`) still gates on real `subscribers` rows, which nothing currently grants automatically — in practice archive access is admin-only unless an admin manually comps a `subscribers` row via §48. This was out of scope for the pivot ("access to all tickets," not archive browsing) — revisit if archive access should also open to any signed-up user.

## 52. LEAGUE CONFIGURATION — CURRENT PRIORITY SET

**Belgium (Jupiler Pro League), Denmark (Superligaen), Norway (Eliteserien)** replaced Portugal as the prioritized regional tier-one leagues (product decision) — `PRIORITY_LEAGUE_NAMES` in `generate-tickets.mjs`, matched by league name (confirmed API-Football values), not guessed numeric IDs. Priority only affects tie-breaking during odds-lookup rotation and final assembly sort (§56 covers the rotation fairness fix) — it is not an exclusive gate; any other allowlisted league with fixtures today still gets a fair shot at the lookup budget.

---

# PART 3 — AUDIT REPORTING (absorbs former "CLAUDE.md — Audit System.md")

## 53. AUDIT REPORTING (weekly / quarterly / yearly)

Three report-only workflows, same bounded principle as `analyze-performance.mjs`/`analyze-feedback.mjs`: read real data, write markdown to the GitHub Actions step summary, change nothing automatically.

**Cadence:** Weekly (`audit-weekly.mjs`, Mondays 05:00 UTC — the only one with a day-by-day breakdown; quarterly/yearly stay at window totals on purpose), Quarterly (1st of Jan/Apr/Jul/Oct, 06:00 UTC), Yearly (Jan 2, 07:00 UTC). All three also manually dispatchable.

| Metric | Source |
|---|---|
| New/total subscribers | `subscribers`, `saints_lock_access`, `app_stats` |
| Most-viewed tickets, views by tier, high-velocity hours/days | `ticket_views` |
| Page load time (LCP) | `page_perf` |
| Satisfaction score | `satisfaction_ratings` |
| Support/feedback volume | `feedback`, windowed |
| Win rate (headline) | `fixtures`/`tickets` — run the Performance Digest (§55-adjacent, `analyze-performance.mjs`) for the full threshold backtest |
| Traffic, source, location, age, top pages | **GA4 Data API**, pulled live, not duplicated into Supabase |
| App status (uptime/errors) | **not tracked** — known gap, see below |

**Implementation:** `scripts/lib/auditMetrics.mjs` (shared Supabase aggregation — one definition of "new subscriber" etc. across all three scripts), `scripts/lib/ga4.mjs` (hand-rolled service-account JWT + OAuth2 via `node:crypto`, zero extra deps — requires `GA4_PROPERTY_ID`/`GA4_SERVICE_ACCOUNT_KEY`, degrades gracefully to Supabase-only reports if unset), `scripts/lib/auditReport.mjs` (pure markdown formatting, no data-fetching). `src/lib/telemetry.ts` — `trackTicketView()`, `trackPageLoad()`, `submitSatisfactionRating()`, deliberately separate from GA4, fire-and-forget, fails silently (telemetry must never break the product). `src/app/SatisfactionWidget.tsx` — standalone 1–5 rating widget.

**Known gaps (honest scope, don't paper over these):**
- **App status/uptime is not tracked** — no status-check workflow, no monitor wired in. "Is the app healthy" currently means checking the Actions tab for green `generate-tickets`/`grade-tickets` runs directly.
- **Age/gender breakdown** depends on GA4 Google Signals being enabled and sufficient traffic — legitimately empty in many valid configurations.
- **No period-over-period deltas** — each report is one window's totals; comparing against the prior period means opening the previous run's step summary by hand.
- **`satisfaction_ratings` and `feedback` are intentionally separate** and must not be merged — the former is a trackable number over time, the latter is free-text a human moderates.

---

# PART 4 — SELF-IMPROVEMENT SYSTEM (absorbs former "CLAUDE.md — OddSaint Self-Improvement.md")

## 54. MULTI-BOOKMAKER, VIG-CORRECTED CONSENSUS PRICING

`pickMarketFromOdds()` in `generate-tickets.mjs` previously priced every fixture off a single bookmaker's raw quote. `scripts/lib/markets.mjs` now also exports `collectConsensusOutcomes(bookmakers)`, which:

1. Takes the full `bookmakers` array (not just index 0).
2. Devigs each bookmaker's own odds independently (proportional devigging, normalizing that bookmaker's implied probabilities to sum to 1, including outcomes outside this catalog like Draw).
3. Averages resulting fair probabilities per outcome across contributing bookmakers.
4. Returns consensus odds (`1 / averageFairProbability`) plus `bookmakerCount`.

`pickMarketFromOdds()` calls this instead of the old single-bookmaker `collectViableOutcomes()` (still exported, unused, kept only in case something else depends on it — safe to delete once confirmed nothing does). `MIN_BOOKMAKERS_FOR_CONSENSUS = 2` is a *preference*, not a hard gate — a fixture with only one bookmaker is never discarded for that alone, since that would undo the point on exactly the thin-liquidity leagues this is meant to help. `bookmaker_count` is recorded on every fixture row (§14) so thin coverage stays visible rather than silently degrading pick quality.

**Grading is unaffected** — `settleMarket()` only compares a market label to the real final score, with no dependency on how the odds were priced.

**Flagged, not yet acted on:** `oddsMin`/`oddsMax` bands in `MARKET_CATALOG` were calibrated against single-bookmaker prices; vig-corrected consensus odds run somewhat longer. Per the "never guess, only change with real data" principle, these are left as-is — watch `analyze-performance.mjs`/`propose-improvements.mjs` output over time and retune only if evidence supports it.

## 55. SELF-IMPROVEMENT SYSTEM — bounded, three-layer, human-supervised

No layer here can silently change what subscribers see, falsify grading, or edit the generation pipeline's code without a human merging a PR.

**Layer 1 — Model cross-check (`scripts/lib/modelCrossCheck.mjs`, always on, purely observational).** Wires `teamModel.mjs`'s Poisson model (§56) in as a second opinion: for every fixture the real pipeline prices, also asks the model's probability for the *same* market/outcome the bookmaker pipeline already picked, recording `model_probability`/`model_available` on `fixtures`. **Never influences selection** — doesn't change the pick, doesn't change confidence, doesn't touch grading. Exists purely so Layers 2/3 have real data to evaluate against. ⚠️ The exact shape of `teamModel.mjs`'s exports was assumed building this adapter (see §30) — verify before trusting cross-check data.

**Layer 2 — Bounded auto-tuning (`scripts/self-tune.mjs`, weekly, `self-tune.yml`).** Reads the last 30 days of graded fixtures; may adjust three numeric parameters in `tuning_state` — `min_confidence` (up only), `small_ticket_max_odds` (down/tighter only), `saints_lock_min_confidence` (up only) — each gated by a real win-rate improvement margin, a minimum post-move sample size, a cooldown since the last change to that parameter, and a model cross-check sanity gate (skips the move if the Poisson model's implied win rate disagrees sharply with the observed rate, to avoid locking in a lucky streak). Only ever writes `tuning_state`/`tuning_log` — never edits a `.mjs` file, never commits, never opens a PR, needs no elevated Actions permissions. Fully reversible via Supabase's Table Editor. `generate-tickets.mjs` reads these three values from `tuning_state` at the start of every run (`fetchTuningState()`), falling back to hardcoded defaults on any read failure.

**Layer 3 — Self-improvement proposals (`scripts/propose-improvements.mjs`, monthly, `propose-improvements.yml`).** Everything Layer 2 deliberately can't do automatically — loosening a threshold, demoting a weak league, considering a structural change like blending the Poisson model into confidence scoring — surfaces here as an evidence-backed `PROPOSALS.md`, committed to a branch, opened as a PR. The PR diff *is* the proposal; nothing here edits pipeline files directly, same bounded pattern as §27's dependency-update PRs. Covers: (1) a summary of everything Layer 2 did automatically this window, (2) candidate loosening moves for `min_confidence` with evidence, (3) league/market win-rate health flags (candidates for `PRIORITY_LEAGUE_NAMES` demotion or `EXCLUDED_TEAMS` review), (4) model cross-check coverage/agreement by market, and — once `MIN_CROSS_CHECK_SAMPLE_FOR_BLEND_CONSIDERATION = 150` cross-checked fixtures exist — a note that the bookmaker/model blend described in §56's integration note may be worth evaluating, **without ever making that change itself**.

Database: `fixtures.model_probability`/`model_available` (Layer 1), `tuning_state`/`tuning_log` (Layer 2) — all consolidated into `schema.sql` §14/§17.

Workflows: `self-tune.yml` (no `contents: write` — Supabase-only), `propose-improvements.yml` (`contents: write` + `pull-requests: write`, same `persist-credentials: false` + extraheader-unset fix as §27).

**Verification items before trusting this in production** (see also §30): confirm `teamModel.mjs`'s real export shape against the adapter's assumptions; confirm `tuning_state`'s seed value for `min_confidence` (68, matching the code default) is actually the intended baseline versus any other value referenced elsewhere in the reporting scripts; run `self-tune.mjs` and `propose-improvements.mjs` manually at least once before trusting the schedules.

## 56. OWN FIRST-PARTY PREDICTION MODEL (`scripts/lib/teamModel.mjs`)

Built because social-sentiment signals (X, Reddit) turned out infeasible on free-tier infra (X's free tier is write-only; Reddit's is non-commercial-use-only). Instead: a real statistical signal from data Odd Saint already owns — graded fixtures + backfilled team history (§47) — costing nothing, answerable to no external pricing page.

**Team identity:** every lookup is keyed by API-Football's own stable numeric team ID, never by name-text matching (name variants like "Man United" vs "Manchester United" would silently under-count history).

**Method:** classic expected-goals/Poisson modeling — transparent, not a trained/black-box model, consistent with the rest of the pipeline's "simple, explainable heuristic" positioning (§8). Team venue-specific scoring rate vs. league baseline → attack/defense strength → combined expected goals → Poisson-derived probabilities for Over/Under, BTTS, Home/Draw/Away.

**Honest limitations:** refuses to return a model for either team below `MIN_SAMPLE_MATCHES = 5` graded matches at that venue (returns `null`/unavailable rather than fabricating from 2–3 games) — this is the expected, normal state for most fixtures early on, not a signal to skip the fixture. No knowledge of injuries, suspensions, lineup news, or weather; supplements bookmaker consensus, never overrides it (enforced by Layer 1's cross-check-only design, §55). Missing `team_id` on a fixture returns unavailable rather than falling back to fragile name matching.

**Integration note:** already wired in as Layer 1's cross-check (Option A: can only flag a bookmaker pick as uncertain, never add confidence on its own). Once enough graded cross-check history accumulates, `analyze-performance.mjs` is the place to check whether flagged fixtures actually correlated with real misses, before ever considering the blended-confidence approach (Option B, 75% bookmaker/25% model) that Layer 3 (§55) can surface as a proposal but never apply automatically.
