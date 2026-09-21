-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004 (self-improvement system)
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of schema.sql + earlier migrations — no columns
-- or tables dropped/renamed, safe to apply to the existing production
-- database.
--
-- ROOT CAUSE of "Could not read tuning_state — has migration 004 been
-- applied?": this migration is referenced by name in CLAUDE.md — OddSaint
-- Self-Improvement.md and relied on by scripts/self-tune.mjs and
-- scripts/lib/modelCrossCheck.mjs (via fixtures.model_probability /
-- fixtures.model_available), but the file itself was never actually
-- present in the repo — every other 004_*.sql migration exists
-- (004_fixture_country.sql, 004_audit_instrumentation.sql,
-- 004_lifecycle_email_grants.sql, 004_ticket_unlocks.sql), this one
-- didn't. self-tune.mjs's error message is reporting that accurately, not
-- a bug in self-tune.mjs itself. Run this once to fix it.
--
-- Adds:
--   1. fixtures.model_probability / fixtures.model_available — Layer 1
--      (model cross-check) columns, read/written by
--      scripts/lib/modelCrossCheck.mjs and read by scripts/self-tune.mjs's
--      model-cross-check sanity gate in evaluateMinConfidence().
--   2. tuning_state — single row (id=1), the live value of the
--      auto-tunable parameters. Admin-readable; written only by
--      self-tune.mjs via the service-role key (bypasses RLS, same pattern
--      as every other automation-pipeline table in this repo).
--   3. tuning_log — append-only audit trail of every automatic tune.
--      Admin-readable; written only by self-tune.mjs.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Model cross-check columns on fixtures
-- ---------------------------------------------------------------------------
alter table fixtures add column if not exists model_probability numeric;
alter table fixtures add column if not exists model_available boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2. tuning_state — single row, live auto-tuned parameter values
-- ---------------------------------------------------------------------------
-- small_ticket_max_odds is seeded and KEPT here for backward compatibility
-- even though scripts/self-tune.mjs no longer reads or writes it — it was
-- retired from auto-tuning when the old single shared small-tier odds
-- ceiling (SMALL_TICKET_TIERS/SMALL_TICKET_MAX_ODDS in
-- generate-tickets.mjs) was replaced by five independent per-tier
-- LEG_ODDS_BAND ranges. Left in the schema rather than dropped, since
-- removing a column is a separate, deliberate decision — see CLAUDE.md's
-- Layer 2 note and the project's own "never casually drop columns" rule.
create table if not exists tuning_state (
  id int primary key default 1 check (id = 1),
  min_confidence int not null default 68,
  small_ticket_max_odds numeric not null default 1.77, -- unused by self-tune.mjs as of this batch; kept for compatibility
  -- 62, not 85: see scripts/generate-tickets.mjs's SAINTS_LOCK_MIN_CONFIDENCE
  -- comment — 85 is mathematically unreachable within Saint's Lock's own
  -- [1.5, 2.0] target odds band (tops out around 67% implied confidence),
  -- so the original seed silently made buildSaintsLockTickets fall back
  -- to its emergency path on every single run. If you already applied
  -- this migration with the old seed, run
  -- supabase/migrations/004b_fix_saints_lock_seed.sql to correct the
  -- already-seeded live row (INSERT ... ON CONFLICT DO NOTHING below
  -- won't touch an existing row).
  saints_lock_min_confidence int not null default 62,
  last_tuned_reason text,
  updated_at timestamptz not null default now()
);

-- Seed values match generate-tickets.mjs's hardcoded constants
-- (MIN_CONFIDENCE = 68, SAINTS_LOCK_MIN_CONFIDENCE = 85) as of this batch.
-- NOTE (see CLAUDE.md's "known verification items"): generate-tickets.mjs
-- does NOT currently read this table at runtime — it still uses its own
-- hardcoded constants. self-tune.mjs writing here only updates the
-- tracked/tunable value; wiring generation to actually READ from
-- tuning_state is a separate follow-up, not part of this migration.
insert into tuning_state (id) values (1) on conflict (id) do nothing;

alter table tuning_state enable row level security;

drop policy if exists "admins can read tuning_state" on tuning_state;
create policy "admins can read tuning_state" on tuning_state for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. tuning_log — append-only audit trail of every automatic change
-- ---------------------------------------------------------------------------
create table if not exists tuning_log (
  id bigint generated always as identity primary key,
  parameter text not null,
  old_value numeric not null,
  new_value numeric not null,
  direction text not null check (direction in ('up', 'down')),
  win_rate_before numeric,
  sample_size int,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists tuning_log_parameter_idx on tuning_log (parameter, created_at);

alter table tuning_log enable row level security;

drop policy if exists "admins can read tuning_log" on tuning_log;
create policy "admins can read tuning_log" on tuning_log for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Explicit privilege grants — RLS policies above control WHICH ROWS a role
-- can see; they don't replace the underlying Postgres table privilege that
-- says whether a role can attempt SELECT/INSERT/UPDATE at all. Without
-- these, service_role (which bypasses RLS but still needs the table-level
-- grant) would hit "permission denied for table X" (Postgres 42501) —
-- same gap already documented and fixed once before for user_profiles/
-- notification_log in 004_lifecycle_email_grants.sql. Safe to re-run —
-- GRANT is idempotent.
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated, service_role;

grant select on public.tuning_state, public.tuning_log to authenticated;
grant select, insert, update, delete on public.tuning_state, public.tuning_log to service_role;
