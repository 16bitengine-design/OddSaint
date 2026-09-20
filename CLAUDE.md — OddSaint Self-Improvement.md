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

## UPDATED — MARKET SELECTION STRATEGY (Highest Qualifying Odds, Not Lowest)

`pickMarketFromOdds()` in `scripts/generate-tickets.mjs` no longer selects
the LOWEST-odds ("safest") viable outcome on a fixture. It now selects the
HIGHEST-odds outcome that still clears `MIN_CONFIDENCE`.

**Why this changed:** the product goal is to hit each tier's cumulative
odds target using as FEW legs as possible (see `pickFixturesForSlip`'s own
doc comment — it already favored fewer legs at the assembly stage, but the
per-fixture market pick was working against that goal). A Double Chance
price (1X/X2/12) covers two of three possible results, so it is almost
always priced lower than an outright Home/Away Win on the same fixture —
under the old "lowest odds first" rule, Double Chance was picked on nearly
every fixture, which then required MORE legs to reach any given
cumulative target. Picking the highest QUALIFYING odds instead means
outright Win markets (and other higher-priced-but-still-confident
outcomes) get chosen naturally, without needing to special-case any one
market type.

**Removed as dead code under the new rule:** `RESULT_BASED_MARKETS` and
`WIN_MARKET_MIN_ODDS`. These existed only to substitute away an overly
tight Double Chance price under the old "lowest odds first" rule — under
"highest qualifying odds first," an overly tight price will essentially
never be the highest-odds qualifying outcome on a fixture, so the
situation that guard existed for no longer arises in practice.

**Trade-off, not a free upgrade:** each individual leg now sits closer to
the `MIN_CONFIDENCE` floor (68%) than before, since "closest to the floor
while still qualifying" is exactly what "highest odds that clears the
floor" selects for. Check `scripts/analyze-performance.mjs`'s
confidence-band breakdown after a couple weeks live to confirm the
fewer-legs approach isn't quietly trading away real win rate.

---

## UPDATED — TIER LEG COUNTS AND ODDS TARGETS (7-Category Portfolio Mapping)

`TIER_CONFIG` and `TIER_ODDS_TARGET` in both `scripts/generate-tickets.mjs`
and `src/lib/dataFetcher.ts` (kept in sync per the tier-count-sync rule)
were reworked to map a 7-category risk-portfolio framework onto Odd
Saint's real tier names, in product order:

| Tier | Target Cum. Odds | Legs (matchCount ceiling) | Avg. Leg Odds Band |
|---|---|---|---|
| Mega Day Ticket | 2.00 – 2.50 | 3 | 1.25 – 1.35 |
| Bronze | 4.00 – 6.00 | 4 | 1.40 – 1.65 |
| Silver | 15.00 – 30.00 | 8 | 1.70 – 2.00 |
| Gold | 100.00 – 300.00 | 12 | 1.80 – 2.10 |
| Weekly Lite | 300.00 – 800.00 | 16 | 1.90 – 2.20 |
| Weekly Titan | 1,000 – 3,000 | 19 | 1.80 – 2.00 |
| Weekender | 10,000.00+ | 22 | 1.80 – 2.10 |

Weekly Lite/Weekly Titan/Weekender previously had NO odds target
("Mixed") and simply took the safest available legs up to a much larger
leg ceiling (19/29/35). They now behave like every other generic tier —
real `TIER_ODDS_TARGET` entries, assembled via `pickFixturesForSlip`'s
fewest-legs-to-target logic, same as bronze/silver/gold always have.

**Platinum and Diamond are unchanged** — they were not part of the
7-category mapping this batch worked from. Open question, not yet
decided: whether to fold them into the same framework or retire them.

**New `LEG_ODDS_BAND`** (in `generate-tickets.mjs` only — a generation-time
filter, not part of the tier config the frontend reads) replaces the old
single shared `SMALL_TICKET_TIERS`/`SMALL_TICKET_MAX_ODDS = 1.77` ceiling
(which only applied to mega/bronze/silver). Every generic tier now has its
own explicit average-leg-odds band; `poolForTier()` filters the fixture
pool to it before assembly. Tiers with no band defined (platinum, diamond,
saints_lock) are left unfiltered, same as before.

**Trade-off:** narrowing each tier's pool to a tight odds band, combined
with the leg-count increases above, means `pickFixturesForSlip` will fail
to assemble a valid combination (and skip the slip) more often on days
with a thin fixture pool. This is expected, not a bug — the function
already returns `[]` and logs a skip rather than forcing a bad
combination; this change just makes that path more frequent.

---

## NEW — ZERO CROSS-CONTAMINATION RULE

`MAX_FIXTURE_APPEARANCES_PER_DAY` in `generate-tickets.mjs` lowered from
`3` to `1`. A fixture used in one tier's ticket can no longer appear in
any other tier's ticket the same day — if that one fixture fails, it ruins
only the single ticket it's on, not multiple tickets across the portfolio
at once.

The previous value of `3` deliberately allowed reuse specifically so a
thin fixture pool wouldn't starve every tier. That tradeoff is now made
the other way on purpose, and combined with the larger leg counts above,
meaningfully raises the number of DISTINCT fixtures a single day's run
needs to fully populate every tier (roughly 3+4+8+12+16+19+22 ≈ 84 across
mega→weekender alone, before platinum/diamond/saints_lock). Expect more
skipped slips on thin-fixture days as a direct, known consequence — watch
the Actions logs after this ships.

---

## NEW — KNOWN-COUNTRY ELIGIBILITY REQUIREMENT

`fetchPricedFixtures()`'s eligibility filter in `generate-tickets.mjs` now
requires `!!f.league?.country` — a fixture whose league has no resolvable
country is excluded from the pool entirely, rather than being included
with `country` silently defaulted to the string `'Unknown'`. The
`'Unknown'` fallback still exists in the code, but now only applies to the
DISPLAY value on fixtures that already passed this eligibility check with
a real country — it's no longer possible for a genuinely country-less
fixture to reach a ticket.

---

## UPDATED — SELF-IMPROVEMENT SYSTEM (Bounded, Three-Layer)

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

Reads the last 30 days of graded fixtures and is allowed to adjust **two**
numeric parameters — `min_confidence` and `saints_lock_min_confidence` —
but **only in the safer direction: both can only be raised.**

**`small_ticket_max_odds` was retired from auto-tuning this batch.** It
was built against the old single shared small-tier odds ceiling
(`SMALL_TICKET_TIERS`/`SMALL_TICKET_MAX_ODDS` in `generate-tickets.mjs`,
one ceiling covering mega/bronze/silver). That concept no longer exists —
it's been replaced by five independent per-tier `LEG_ODDS_BAND` ranges
(see above), so a single tunable `small_ticket_max_odds` value has no tier
left to apply to; tuning it up or down would silently do nothing, since
nothing in `generate-tickets.mjs` reads it anymore. `evaluateSmallTicketMaxOdds()`
and its `TUNING_BOUNDS` entry were removed from `self-tune.mjs`
accordingly. The `tuning_state.small_ticket_max_odds` column still exists
in Supabase but is no longer read or written by this script — left in
place rather than dropped, since removing a column is a separate,
deliberate schema decision, not something to fold into a parameter-tuning
change.

If per-tier auto-tuning of the new `LEG_ODDS_BAND` ranges is wanted later,
that's a materially bigger change than what shipped here: it would need
`self-tune.mjs`'s evaluator generalized to loop over five tiers
independently, plus new `tuning_state` columns (a min/max pair per tier)
via a fresh migration — flagged as a future option, not implemented.

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

`scripts/generate-tickets.mjs` does NOT currently read `min_confidence` or
`saints_lock_min_confidence` from `tuning_state` at runtime — both remain
hardcoded constants (`MIN_CONFIDENCE = 68`, `SAINTS_LOCK_MIN_CONFIDENCE =
85`) in the version of the file covered by this batch of changes. Wiring
`self-tune.mjs`'s output back into live generation (via a
`fetchTuningState()` call at the start of `main()`, as an earlier version
of this document described) is a separate follow-up, not yet done in the
current file.

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

No changes to Layer 3 in this batch — `propose-improvements.mjs` reads
`tier`/`league`/`market` values live from the `fixtures`/`tuning_log`
tables rather than hardcoding leg counts or odds targets, so it required
no edits for the tier-config rework above.

### Database changes

Migration: `supabase/migrations/004_self_improvement.sql` (unchanged by
this batch).

- `fixtures.model_probability` (numeric, nullable), `fixtures.model_available`
  (boolean) — Layer 1's cross-check data.
- `tuning_state` — single row (id=1), the live value of the auto-tunable
  parameters, admin-readable. Written only by `self-tune.mjs`. Still
  carries a `small_ticket_max_odds` column (dead, unused — see Layer 2
  above) alongside the two still-active columns.
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
   tickets.mjs` hardcodes `MIN_CONFIDENCE = 68`, but
   `analyze-performance.mjs` documents `CURRENT_LIVE_MIN_CONFIDENCE = 74`
   as the actually-live value referenced in its own backtest constant.
   Confirm which is correct and update accordingly before treating
   `self-tune.mjs`'s before/after comparisons as measured against the
   right baseline. Also confirm whether `generate-tickets.mjs` should be
   wired to actually read `tuning_state.min_confidence` /
   `saints_lock_min_confidence` at runtime (see Layer 2 note above — it
   currently does not).
3. Run `node scripts/self-tune.mjs` and `node scripts/propose-improvements.mjs`
   manually at least once before trusting the schedules, to confirm both
   read/write correctly against your actual Supabase project.
4. **New this batch:** run a manual `workflow_dispatch` of
   `generate-tickets.yml` after deploying the `TIER_CONFIG`/`LEG_ODDS_BAND`/
   `MAX_FIXTURE_APPEARANCES_PER_DAY` changes, and check the Actions log for
   how many slips get skipped for "couldn't assemble a valid combination"
   — the fixture-pool-exhaustion risk flagged above is real and worth
   seeing directly before relying on the schedule.
