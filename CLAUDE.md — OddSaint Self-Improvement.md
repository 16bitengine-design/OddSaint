# CLAUDE.md — Self-Improvement System Addendum

Add this section to the existing CLAUDE.md / OddSaint project instructions.

---

## NEW — MULTI-BOOKMAKER, VIG-CORRECTED CONSENSUS PRICING

Previously, `pickMarketFromOdds()` in `scripts/generate-tickets.mjs` priced
every fixture from a single bookmaker's raw quote
(`oddsResponse[0].bookmakers[0]`). A single bookmaker's odds bake in that
bookmaker's own margin ("vig") and are noisier on lower-liquidity regional
leagues.

`scripts/lib/markets.mjs` now exports `collectConsensusOutcomes(bookmakers)`,
which:

1. Takes the FULL `bookmakers` array from a fixture's `/odds` response, not
   just the first one.
2. Devigs each bookmaker's own odds independently (proportional devigging —
   normalizes that bookmaker's implied probabilities to sum to 1, including
   outcomes this catalog doesn't track like Draw, since they're still part
   of that bookmaker's overround).
3. Averages the resulting fair probabilities for each outcome across every
   bookmaker that priced it.
4. Returns consensus odds (`1 / averageFairProbability`) plus
   `bookmakerCount` — how many bookmakers contributed.

`pickMarketFromOdds()` in `generate-tickets.mjs` now calls this instead of
the old single-bookmaker `collectViableOutcomes()` (still exported from
`markets.mjs`, unused, kept only in case something else depends on it —
safe to delete once confirmed nothing does). `MIN_BOOKMAKERS_FOR_CONSENSUS
= 2` is the *preferred* minimum, but a fixture is never discarded just for
having only one bookmaker — that would undo the point of doing this on
exactly the thin-liquidity leagues it's meant to help. `bookmakerCount` is
recorded on every fixture (`fixtures.bookmaker_count`, migration 005) so
thin coverage stays visible instead of silently degrading pick quality.

**Grading is unaffected.** `settleMarket()` in `markets.mjs` only ever
compares a market label against the real final score — it has no
dependency on how that market's odds were priced, so this change can't
retroactively affect any already-graded result.

⚠️ **oddsMin/oddsMax bands may need retuning.** These bands (in
`MARKET_CATALOG`) were calibrated against single raw bookmaker prices.
Vig-corrected consensus odds run somewhat longer/more generous than any
one bookmaker's quote, so the same bands may now filter fixtures slightly
differently. Per the project's "never guess, only change with real data"
principle, these are left as-is rather than blindly adjusted — watch
`scripts/analyze-performance.mjs` and `scripts/propose-improvements.mjs`
output over the next few weeks of graded results and retune only if the
evidence supports it.

### Database changes

New migration: `supabase/migrations/005_multibookmaker_consensus.sql`.

- `fixtures.bookmaker_count` (int, nullable) — how many bookmakers
  contributed to the fixture's consensus price. Informational only.

---

## NEW — SELF-IMPROVEMENT SYSTEM (Bounded, Three-Layer)

Odd Saint's ticket-selection algorithm can now critique itself and adjust
over time, but strictly within a bounded, evidence-gated, human-supervised
design. There is no layer in this system that is allowed to silently
change what the platform tells subscribers, falsify grading, or edit the
generation pipeline's code without a human merging a PR.

### Layer 1 — Model cross-check (always on, purely observational)

`scripts/lib/modelCrossCheck.mjs` wires the previously-unused Poisson
model (`scripts/lib/teamModel.mjs`) in as a second opinion. For every
fixture the real pipeline prices, it also asks the model what probability
it would assign to the SAME market/outcome the bookmaker-odds pipeline
picked — and records both `model_probability` and `model_available` on
the `fixtures` row.

**This never influences selection.** It doesn't change which market gets
picked, doesn't change the confidence used to decide whether a fixture
clears `MIN_CONFIDENCE`, and never touches grading (`result_status` is
still settled purely from the real final score via
`scripts/lib/markets.mjs`). It exists only so Layers 2 and 3 have real
data to evaluate against.

⚠️ The exact shape of `teamModel.mjs`'s exports was assumed when building
the adapter (see the header comment in `modelCrossCheck.mjs`) — verify it
matches and correct the adapter if not, before trusting cross-check data.

### Layer 2 — Bounded auto-tuning (`scripts/self-tune.mjs`, weekly)

Reads the last 30 days of graded fixtures and is allowed to adjust three
numeric parameters — `min_confidence`, `small_ticket_max_odds`,
`saints_lock_min_confidence` — but **only in the safer direction**:

- `min_confidence` and `saints_lock_min_confidence` can only be **raised**.
- `small_ticket_max_odds` can only be **lowered** (tightened).

A move only happens if the candidate threshold shows a real win-rate
improvement margin over the current one, with enough sample size that
ticket generation won't be starved, and isn't within a cooldown window
since the last change to that same parameter. There's also a model
cross-check sanity gate: if the Poisson model's implied win rate
disagrees sharply with the observed win rate for the candidate set, the
move is skipped rather than risk locking in a lucky streak.

This script only writes to Supabase (`tuning_state` for the live value,
`tuning_log` for the audit trail) — it never edits a `.mjs` file, never
commits to git, never opens a PR, and needs no elevated GitHub Actions
permissions. Every change is fully reversible via Supabase's Table
Editor.

`scripts/generate-tickets.mjs` now reads `min_confidence`,
`small_ticket_max_odds`, and `saints_lock_min_confidence` from
`tuning_state` at the start of every run (via `fetchTuningState()`),
falling back to the previous hardcoded values on any read failure.

### Layer 3 — Self-improvement proposals (`scripts/propose-improvements.mjs`, monthly)

Everything Layer 2 is deliberately NOT allowed to do automatically —
loosening a threshold, demoting a weak league, or considering a
structural change like blending the model into confidence scoring —
gets surfaced here as an evidence-backed markdown report
(`PROPOSALS.md`), committed to a branch, and opened as a PR. The PR diff
IS the proposal. Nothing here edits `generate-tickets.mjs` or any other
pipeline file; a human reads it and decides whether to act, exactly like
the existing weekly dependency-update PRs from `ai-self-evolution.yml`.

Covers:
1. A summary of everything Layer 2 has done automatically in the window.
2. Candidate loosening moves for `min_confidence`, with evidence.
3. League/market win-rate health flags (candidates for
   `PRIORITY_LEAGUE_NAMES` demotion or `EXCLUDED_TEAMS` review).
4. Model cross-check coverage and agreement by market — and, once there's
   enough cross-check sample size, a note that it may be worth evaluating
   the bookmaker/model blend `teamModel.mjs`'s own integration note
   describes, **without ever making that change itself**.

### Database changes

New migration: `supabase/migrations/004_self_improvement.sql`.

- `fixtures.model_probability` (numeric, nullable), `fixtures.model_available`
  (boolean) — Layer 1's cross-check data.
- `tuning_state` — single row (id=1), the live value of the three
  auto-tunable parameters, admin-readable. Written only by `self-tune.mjs`.
- `tuning_log` — append-only audit trail of every automatic change, with
  its evidence. Admin-readable.

### New GitHub Actions workflows

- `.github/workflows/self-tune.yml` — weekly (Sunday 05:00 UTC) + manual
  dispatch. No `contents: write` permission (Supabase-only writes).
- `.github/workflows/propose-improvements.yml` — monthly (1st, 04:00 UTC)
  + manual dispatch. `contents: write` + `pull-requests: write`, opens a
  PR via `peter-evans/create-pull-request@v6` with the same
  `persist-credentials: false` + extraheader-unset fix already used in
  `ai-self-evolution.yml`.

### Known verification items before trusting this in production

1. **`teamModel.mjs`'s real export shape** — the adapter in
   `modelCrossCheck.mjs` assumes a `computeMatchProbabilities(homeTeam,
   awayTeam)` function returning per-market probabilities. Confirm or
   correct this against the actual file.
2. **`tuning_state` seed values vs. existing drift** — `generate-
   tickets.mjs` previously hardcoded `MIN_CONFIDENCE = 68`, but
   `analyze-performance.mjs` documents `CURRENT_LIVE_MIN_CONFIDENCE = 74`
   as the actually-live value. The migration seeds `tuning_state` at 68 to
   match the code default; confirm which is correct and update the row if
   needed before the first `self-tune.mjs` run, or its before/after
   comparisons will be measured against the wrong baseline.
3. Run `node scripts/self-tune.mjs` and `node scripts/propose-improvements.mjs`
   manually at least once before trusting the schedules, to confirm both
   read/write correctly against your actual Supabase project.
