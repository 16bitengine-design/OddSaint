# CLAUDE.md — Batch & Range Revision

Add this section to CLAUDE.md. Documents a product revision applied after
the initial launch + payment/feedback/self-improvement/audit batches.
**This section supersedes the match-count figures in the original §7
("TIER CONFIG SYNC") and the "min 1, max 2/day" Saint's Lock guarantee
language in the original §8 — those sections' underlying database schema
and file locations are still accurate, only the specific numbers/policy
described in them have changed. Do not follow the old figures. Note also
that the Saint's Lock guarantee below was itself revised once further
within this same document (see the "HARD GUARANTEE" heading) — follow
that version, not an earlier draft of this same addendum.**

---

## UPDATED — 7. TIER CONFIG: REAL MIN–MAX MATCH-COUNT RANGE + TIGHTENED ODDS TARGETS

**Product decision, not a bug fix**: every tier's `matchCount` is no longer
a bare ceiling with "fewest legs needed" as the only real constraint.
Every tier now carries an explicit `minMatchCount` alongside its ceiling,
enforced by a min-leg top-up pass in `pickFixturesForSlip()`
(`scripts/generate-tickets.mjs`) that runs even when a slip's odds target
was already reached with fewer legs than the minimum.

**Current ranges (supersedes all earlier match-count figures in this
document, including the original §7 table and the "35" figure quoted for
Weekender in §28):**

```
tier          min–max match count   odds target
mega          2–3                   1.5–3
bronze        3–5                   3–7
silver        5–7                   7–12
gold          7–9                   20–30
platinum      9–11                  70–300
diamond       11–13                 300–2500
weekly_lite   13–15                 2500–10000
weekly_titan  15–17                 10000+
weekender     17–25                 12000+
saints_lock   1 (fixed)             1.5–2.4
```

**Weekly Lite / Weekly Titan / Weekender now have real odds targets** —
previously these three were "Mixed" (no `TIER_ODDS_TARGET` entry at all)
and were assembled by `pickFixturesForSlip()`'s `!targetRange` branch
(safest-available-up-to-ceiling, no target-hitting logic). They now run
through the same greedy-then-swap target-range assembly path every other
tier uses. The `!targetRange` branch in both `pickFixturesForSlip()` and
`ensureFullWinLeg()` is kept only for forward-compatibility — it is not
normally reached by any currently configured tier.

**As always: `src/lib/dataFetcher.ts`'s `TIER_CONFIG` must stay in sync**
with `scripts/generate-tickets.mjs`'s `TIER_CONFIG` — both were updated
together in this revision. The frontend copy shows each tier's ceiling
for display; a given real ticket's actual leg count (`match_count` on the
DB row) can be anywhere in the tier's real min–max range and is read
per-ticket from Supabase, not derived from the frontend constant.

---

## UPDATED — TOLERANCE: 30% → 8%

`pickFixturesForSlip()`'s `TOLERANCE` constant (the slack allowed either
side of a tier's odds-target band before a slip is accepted or discarded)
was **30%** — loose enough that a ticket labeled e.g. "20–30" could ship
with real combined odds anywhere from 14 to 39 and still be written to
Supabase. This is now **8%** (same "20–30" ticket now lands between
~18.4 and ~32.4), applied identically in both `pickFixturesForSlip()` and
`ensureFullWinLeg()`'s own tolerance check (the latter governs whether a
full-win-leg swap is kept or discarded).

**Trade-off, worth watching in the Actions logs:** a tighter tolerance
means a thin fixture pool on a given day is more likely to fail to
assemble a valid combination for a tier — per the existing "skip rather
than force" principle, that tier's slip is simply skipped that run rather
than shipping an out-of-range ticket. Silver (5–7 legs, 7–12x target) and
Weekender (17–25 legs, 12000+x target, drawn from a weekend-only pool) are
the tiers most likely to show increased skip rates under the new 8%
tolerance — monitor before loosening further.

---

## UPDATED — 8. SAINT'S LOCK: HARD GUARANTEE, ONE TICKET PER BATCH, NO EXCEPTIONS

**This supersedes the "Min 1, max 2 per day" guarantee described in the
original §8, and also supersedes the first revision of this section
(the "per-batch, but can still ship zero if the odds band is empty"
version).** `buildSaintsLockTickets()`'s fallback-to-best-available logic
went through two changes in this revision:

1. First fix: the fallback's `slot === 0` gate was removed, so a batch no
   longer needed to be the FIRST of the day to get a relaxed-confidence
   fallback pick.
2. Second fix (this one): a batch could still ship **zero** Saint's Lock
   tickets if the 1.5–2.4 odds band had no usable fixture at all that run
   — not just none above 85% confidence, literally none in that price
   range. Product requirement is now stronger: **every released batch has
   a Saint's Lock ticket, full stop**, so a second fallback tier was added.

**Current behavior — two fallback tiers, applied in order:**

1. **Best available within the 1.5–2.4 odds band**, any confidence, if
   nothing clears the 85% bar (`SAINTS_LOCK_MIN_CONFIDENCE`).
2. **Best available ANYWHERE in the day's priced pool**, regardless of
   odds band, if the band itself has nothing usable that run. When this
   tier fires, the written ticket's `odds_range` field is set to the
   pick's own actual odds (e.g. `"4.2"`) rather than the tier's normal
   `"1.5-2.4"` label — showing that label next to a price outside the
   band would be a real display inconsistency, the same class of issue
   already fixed for the tolerance/odds-range work elsewhere in this
   revision.

A batch now ships zero Saint's Lock tickets **only** if the entire day's
priced fixture pool has nothing usable left at all (every fixture already
at `MAX_FIXTURE_APPEARANCES_PER_DAY`, or nothing was priced that run) — in
which case every other tier also fails to assemble a slip that run; this
is no longer a Saint's Lock-specific gap.

**Known trade-off, deliberately accepted, not fixed:** this is a real,
and now stronger, reversal of Saint's Lock's original "next to impossible
to get wrong, quality over quantity most strictly of all" design
principle. A Saint's Lock ticket can now carry odds meaningfully outside
its normal 1.5–2.4 range and/or confidence well below 85%, under the same
"ultra-high-confidence" branding as a normal pick. No confidence floor
was added to the second fallback tier — it takes the single best-available
fixture however low its confidence actually is, since "every batch has a
ticket, no exceptions" was the explicit requirement.

**Operational signal to watch:** both fallback tiers log a `console.warn`
in the GitHub Actions run output; tier 2 specifically flags itself as
worth reviewing if it recurs often. Frequent tier-2 warnings are a signal
that the 1.5–2.4 odds band itself may be too narrow for the actual daily
fixture pool — check `scripts/analyze-performance.mjs`'s output rather
than just accepting the fallback as permanent behavior.

If a middle-ground floor (e.g. never fall below 60% confidence even in
tier 2, skip the batch instead of going lower) is wanted later, that's a
follow-up change to the fallback conditions in `buildSaintsLockTickets()`,
not implemented here.

---

## NEW — RELEASE-BATCH TABS (Frontend)

`src/app/page.tsx`'s ticket feed no longer merges every accessible batch
(release_slot) into one continuous tier-grouped list for the day. Tickets
are now grouped by `release_slot` into separate tabs — each batch (e.g.
the morning release vs. the afternoon release) is its own selectable view,
not interleaved with the others.

**Implementation:**
- `batches` — `tickets` grouped into a `Map<releaseSlot, Ticket[]>`, sorted
  by slot ascending. Computed via `useMemo`.
- `activeBatchSlot` — the currently selected tab; defaults to the most
  recently released batch (highest slot number) rather than always slot 0,
  so a first-time visitor sees the freshest tickets. Falls back safely if
  the previously selected slot no longer exists in the day's data (e.g.
  after a midnight rollover).
- `activeBatchTickets` — the tickets belonging to the active tab.
- A tab bar renders above the ticket feed **only when more than one batch
  exists** (a single-batch day shows no tab bar, since one tab adds
  nothing). Each tab's label uses that batch's release time via the
  existing `formatReleaseTime()` helper — same formatting already used on
  each `TicketCard`'s "Released HH:MM" badge, so the tab label and the
  per-card badge always agree and both render in the visitor's own local
  timezone (no server-side EAT/UTC label is shown anywhere in the UI).

**Deliberately scoped to the ticket feed only** — `saintsLockTickets`
(the always-visible countdown strip) and the Hero's `bronzeCountToday`/
`goldCountToday`/win-rate stats still derive from the full `tickets` array
across all of today's batches, not just the active tab. Saint's Lock is
still "one pick at a time, not simultaneous alternatives" per its existing
design note, and the Hero stats are day-level totals by design. If these
should instead scope to the active tab, that's a separate follow-up change.

**Hook-ordering note for future edits to this file:** `batches`,
`activeBatchSlot`, and `activeBatchTickets` are declared as `useMemo`
hooks *before* the `if (loading) return (...)` early exit in the `Page`
component (immediately after the existing `trialActive`/`daysLeft`
hooks) — not after it. Declaring them after the early return would
violate the Rules of Hooks (a different hook count between the loading
render and the loaded render). The plain (non-hook) `feedItems`
array-building logic that consumes `activeBatchTickets` remains after the
early return, where it belongs.

---

## SUMMARY OF FILES CHANGED IN THIS REVISION

- `scripts/generate-tickets.mjs` — `TIER_CONFIG` (min+max match count per
  tier), `TIER_ODDS_TARGET` (real targets added for weekly_lite/
  weekly_titan/weekender), `TOLERANCE` (30% → 8%, both call sites),
  `pickFixturesForSlip()` (new `minMatchCount` param + min-leg top-up
  pass), `buildTickets()` (passes `config.minMatchCount` through),
  `buildSaintsLockTickets()` — patched twice in this revision: first to
  remove the slot-0-only gate on the confidence-relaxed fallback, then to
  add a second, odds-band-widening fallback tier so a batch's Saint's
  Lock ticket is guaranteed even when the 1.5–2.4 band is completely
  empty that run (see the updated §8 above for both tiers' exact
  behavior)
- `src/lib/dataFetcher.ts` — `TIER_CONFIG` synced to match (ceiling
  values + odds-range display strings)
- `src/app/page.tsx` — release-batch tabs (`batches`/`activeBatchSlot`/
  `activeBatchTickets` state and UI), ad-injection and Bronze-index logic
  now scoped to the active batch only
