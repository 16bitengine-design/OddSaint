-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of schema.sql + migrations 002/003 — no columns/
-- tables dropped or renamed, safe to apply to the existing production
-- database.
--
-- Supports the self-improvement system:
--   1. Model cross-check columns on `fixtures` (Poisson model probability,
--      recorded alongside the bookmaker-derived pick — NEVER used to
--      grade or select a pick, purely a second opinion for later
--      analysis).
--   2. `tuning_state` — the CURRENT live value of a small, pre-approved
--      set of numeric parameters that scripts/self-tune.mjs is allowed
--      to adjust automatically, within hardcoded bounds (see
--      TUNING_BOUNDS in that script). generate-tickets.mjs reads this
--      table at the start of every run instead of using a hardcoded
--      constant, falling back to a safe default if the row is missing
--      or the read fails.
--   3. `tuning_log` — append-only audit trail of every automatic
--      adjustment self-tune.mjs makes, with the evidence that justified
--      it. Nothing here is ever silently changed — every row explains
--      itself.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Model cross-check columns
-- ---------------------------------------------------------------------------
-- model_probability: what scripts/lib/teamModel.mjs's Poisson model would
-- have assigned to the SAME market/outcome the bookmaker-odds pipeline
-- actually picked (not the model's own favorite outcome — the one being
-- compared is always the one that was actually selected, so agreement/
-- disagreement is measured on a like-for-like basis).
-- model_available: false whenever the model didn't have enough graded
-- history for one/both teams (see MIN_SAMPLE_MATCHES in teamModel.mjs) —
-- distinguishes "model disagreed" from "model had no opinion."
-- Both are purely informational. Grading (result_status) is settled
-- ONLY from the real final score via scripts/lib/markets.mjs — the model
-- is never involved in determining green/red, honoring the "never
-- falsify grading" principle.
alter table fixtures add column if not exists model_probability numeric;
alter table fixtures add column if not exists model_available boolean not null default false;

create index if not exists fixtures_model_available_idx on fixtures (model_available) where model_available = true;

-- ---------------------------------------------------------------------------
-- 2. Tuning state — the live value of auto-tunable parameters
-- ---------------------------------------------------------------------------
-- Single row (id fixed at 1), same pattern as app_settings. Read by
-- generate-tickets.mjs at the start of every run (service-role key,
-- bypasses RLS) and written only by scripts/self-tune.mjs. Admins can
-- read it through the app for transparency; nobody else can read or
-- write it directly.
--
-- SEED VALUES: defaulted here to match generate-tickets.mjs's previous
-- hardcoded constants (68 / 1.77 / 85). NOTE — scripts/analyze-
-- performance.mjs separately documents CURRENT_LIVE_MIN_CONFIDENCE as 74,
-- which doesn't match the 68 hardcoded in generate-tickets.mjs. That's an
-- existing drift in the repo, not something introduced here — confirm
-- which value is actually live and UPDATE this row accordingly (via
-- Supabase Table Editor, or a one-off `update tuning_state set
-- min_confidence = 74 where id = 1;`) before relying on self-tune.mjs's
-- before/after comparisons.
create table if not exists tuning_state (
  id int primary key default 1 check (id = 1),
  min_confidence int not null default 68,
  small_ticket_max_odds numeric not null default 1.77,
  saints_lock_min_confidence int not null default 85,
  updated_at timestamptz not null default now(),
  last_tuned_reason text
);

insert into tuning_state (id) values (1) on conflict (id) do nothing;

alter table tuning_state enable row level security;

grant select on tuning_state to authenticated;
drop policy if exists "admins can read tuning_state" on tuning_state;
create policy "admins can read tuning_state" on tuning_state for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Tuning log — audit trail
-- ---------------------------------------------------------------------------
create table if not exists tuning_log (
  id uuid primary key default gen_random_uuid(),
  parameter text not null,
  old_value numeric not null,
  new_value numeric not null,
  direction text not null check (direction in ('up', 'down')),
  win_rate_before numeric,
  sample_size int,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists tuning_log_created_idx on tuning_log (created_at desc);
create index if not exists tuning_log_parameter_idx on tuning_log (parameter, created_at desc);

alter table tuning_log enable row level security;

grant select on tuning_log to authenticated;
drop policy if exists "admins can read tuning_log" on tuning_log;
create policy "admins can read tuning_log" on tuning_log for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));
