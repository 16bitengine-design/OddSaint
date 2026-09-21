-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004b (corrective, run only if you already applied
-- 004_self_improvement.sql before this fix)
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
--
-- WHY THIS EXISTS: 004_self_improvement.sql originally seeded
-- tuning_state.saints_lock_min_confidence at 85. That value is
-- mathematically unreachable within Saint's Lock's own TIER_ODDS_TARGET
-- odds band ([1.5, 2.0] in scripts/generate-tickets.mjs) — implied
-- confidence in that band tops out around 67%, so buildSaintsLockTickets
-- could never satisfy the "qualifying" filter and was silently falling
-- back to its emergency best-available path on every single generation
-- run, not just rare bad days. See SAINTS_LOCK_MIN_CONFIDENCE's comment
-- in generate-tickets.mjs for the full explanation.
--
-- 004_self_improvement.sql has since been corrected to seed 62 instead of
-- 85 — but its INSERT uses ON CONFLICT (id) DO NOTHING, so re-running the
-- fixed file will NOT update a tuning_state row that already exists from
-- an earlier apply. This migration is that update, isolated so it's safe
-- to run regardless of which version of 004_self_improvement.sql you
-- applied first.
--
-- Safe to run even if your row is already at 62 (or was never seeded at
-- 85 in the first place) — this only changes rows currently at 85.
-- ---------------------------------------------------------------------------

update tuning_state
set saints_lock_min_confidence = 62,
    updated_at = now()
where id = 1
  and saints_lock_min_confidence = 85;
