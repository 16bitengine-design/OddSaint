-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004b
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Run this AFTER 004_self_improvement.sql (depends on tuning_state existing).
--
-- Fixes the originally-seeded saints_lock_min_confidence = 85 in
-- tuning_state, which is mathematically unreachable within Saint's Lock's
-- own [1.5, 2.0] odds band (tops out at 67% implied confidence — see
-- impliedConfidence() in scripts/generate-tickets.mjs: round(1/1.5*100) = 67,
-- clipped range is [55, 95]). Corrected value is 62, matching
-- 004_self_improvement.sql's corrected inline comment.
--
-- Guarded by `where saints_lock_min_confidence = 85` so this is a no-op if
-- self-tune.mjs has already moved the value away from the broken seed for
-- some other reason (self-tune.mjs never lowers this parameter, so in
-- practice 85 could only ever have been raised further, at which point this
-- statement will correctly do nothing — the WHERE guard protects against
-- overwriting any such value that isn't the known-broken original seed).
-- ---------------------------------------------------------------------------
update tuning_state
set saints_lock_min_confidence = 62, updated_at = now()
where id = 1 and saints_lock_min_confidence = 85;

-- Verify after running:
--   select id, min_confidence, saints_lock_min_confidence, updated_at from tuning_state;
-- saints_lock_min_confidence should now read 62.
