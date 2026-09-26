-- ---------------------------------------------------------------------------
-- Odd Saint — migration 006
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of migration 005 (score_predictions) — no columns
-- dropped or renamed, safe to apply to the existing production database.
--
-- Backs the daily accuracy reconciliation + bounded self-tuning loop for
-- the exact-score-prediction feature (see scripts/analyze-score-
-- predictions.mjs and scripts/self-tune-score-model.mjs). Deliberately
-- SEPARATE tables from `tuning_state`/`tuning_log` (which already exist
-- for the ticket-generation confidence/odds thresholds) so the two tuning
-- systems can never cross-talk, even though both follow the same bounded/
-- reviewable/reversible pattern.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 0. Two extra columns on score_predictions — the ACTUAL graded-match
--    count the model found for each side that day (not just the
--    threshold that happened to be live). Without these, a later backtest
--    of "would a stricter threshold have done better" would have to
--    compare whole days against each other, which is confounded by which
--    leagues/fixtures happened to occur on which day. With these, it can
--    filter real historical rows by min(home_sample, away_sample) >=
--    candidate — a genuine simulation, not a guess. Populated by
--    scripts/generate-score-predictions.mjs from the model's own
--    sampleInfo (see scripts/lib/teamModel.mjs).
-- ---------------------------------------------------------------------------
alter table score_predictions add column if not exists home_team_sample_size int;
alter table score_predictions add column if not exists away_team_sample_size int;
alter table score_predictions add column if not exists min_sample_matches_used int; -- the threshold that was live when this row was generated

-- ---------------------------------------------------------------------------
-- 1. Daily accuracy rollup — one row per ticket_date, written by
--    scripts/analyze-score-predictions.mjs once that date's predictions
--    have had a full day+ to be graded by scripts/grade-tickets.mjs's
--    recurring 3-hourly runs. This is the human-readable evidence trail;
--    self-tune-score-model.mjs itself reads the raw score_predictions
--    rows directly (for the finer-grained backtest above), not this
--    rollup — this table is for visibility/reporting over time.
-- ---------------------------------------------------------------------------
create table if not exists score_prediction_daily_accuracy (
  ticket_date date primary key,
  correct int not null default 0,
  incorrect int not null default 0,
  still_pending int not null default 0,
  hit_rate_pct numeric, -- correct / (correct + incorrect) * 100, null if nothing decided yet
  min_sample_matches_used int,
  created_at timestamptz not null default now()
);

grant select on score_prediction_daily_accuracy to authenticated;
alter table score_prediction_daily_accuracy enable row level security;
drop policy if exists "authenticated can read score_prediction_daily_accuracy" on score_prediction_daily_accuracy;
create policy "authenticated can read score_prediction_daily_accuracy" on score_prediction_daily_accuracy for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 2. Tuning state — single row (id=1), the live value of the ONE
--    auto-tunable parameter for the score-prediction model: how many
--    graded home/away matches a team needs before the model will use it
--    at all (see DEFAULT_MIN_SAMPLE_MATCHES in scripts/lib/teamModel.mjs).
--    Read by scripts/generate-score-predictions.mjs at the start of every
--    run via an explicit override parameter — this does NOT change
--    teamModel.mjs's own hardcoded default, which
--    scripts/lib/modelCrossCheck.mjs (ticket-generation cross-check)
--    still uses unaffected if/when that module is ever actually wired in.
--    Keeping these separate means tuning score-prediction accuracy can
--    never silently change ticket-selection behavior.
-- ---------------------------------------------------------------------------
create table if not exists score_model_tuning_state (
  id int primary key default 1 check (id = 1),
  min_sample_matches int not null default 5,
  updated_at timestamptz not null default now(),
  last_tuned_reason text
);

insert into score_model_tuning_state (id) values (1) on conflict (id) do nothing;

grant select on score_model_tuning_state to authenticated;
alter table score_model_tuning_state enable row level security;
drop policy if exists "authenticated can read score_model_tuning_state" on score_model_tuning_state;
create policy "authenticated can read score_model_tuning_state" on score_model_tuning_state for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. Tuning log — append-only audit trail of every automatic change, with
--    the evidence that justified it. Mirrors `tuning_log`'s shape for
--    consistency, just for this separate parameter space.
-- ---------------------------------------------------------------------------
create table if not exists score_model_tuning_log (
  id bigint generated always as identity primary key,
  parameter text not null,
  old_value numeric not null,
  new_value numeric not null,
  direction text not null check (direction in ('up', 'down')),
  hit_rate_before numeric,
  sample_size int,
  reason text not null,
  created_at timestamptz not null default now()
);

grant select on score_model_tuning_log to authenticated;
alter table score_model_tuning_log enable row level security;
drop policy if exists "authenticated can read score_model_tuning_log" on score_model_tuning_log;
create policy "authenticated can read score_model_tuning_log" on score_model_tuning_log for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Explicit privilege grants for service_role — RLS controls WHICH ROWS,
-- not whether the role can attempt the query at all; service_role
-- bypasses RLS but still needs the table-level grant (this exact gotcha
-- was already hit once for user_profiles/notification_log — see
-- supabase/migrations/004_lifecycle_email_grants.sql).
-- ---------------------------------------------------------------------------
grant usage on schema public to service_role;
grant select, insert, update, delete on public.score_prediction_daily_accuracy to service_role;
grant select, insert, update, delete on public.score_model_tuning_state to service_role;
grant select, insert, update, delete on public.score_model_tuning_log to service_role;
