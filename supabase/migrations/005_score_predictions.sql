-- ---------------------------------------------------------------------------
-- Odd Saint — migration 005
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive — new table only, safe to apply to the existing
-- production database. NOTE: the repo already has several migration files
-- numbered "004_*" (fixture_country, audit_instrumentation, ticket_unlocks,
-- lifecycle_email_grants, and — per project history — self_improvement).
-- This is named 005 on the assumption those are all already applied;
-- renumber if that's not the case in your actual Supabase project.
--
-- Backs the new "predicted exact score" feature: a daily, broader-than-
-- tickets list of every eligible fixture the team model (see
-- scripts/lib/teamModel.mjs) has enough history to score, each with its
-- single most likely final scoreline. Deliberately a SEPARATE table from
-- `fixtures` rather than a new column there, because coverage differs —
-- `fixtures` only ever contains fixtures actually picked for a ticket;
-- this table is meant to cover every eligible fixture that day, whether
-- or not it was picked for any ticket. Written by
-- scripts/generate-score-predictions.mjs once daily; graded by
-- scripts/grade-tickets.mjs (extended, see that file) using the same
-- API-Football fixture ID space as `fixtures.id`.
-- ---------------------------------------------------------------------------

create table if not exists score_predictions (
  id bigint primary key,                 -- API-Football fixture ID — same ID space as fixtures.id
  ticket_date date not null,
  league text not null,
  country text not null default 'Unknown',
  home_team text not null,
  away_team text not null,
  kickoff timestamptz not null,
  predicted_home_score int not null check (predicted_home_score >= 0),
  predicted_away_score int not null check (predicted_away_score >= 0),
  probability numeric,                   -- model's own probability for this exact scoreline (0-1), informational only
  actual_home_score int,
  actual_away_score int,
  result_status text not null default 'pending'
    check (result_status in ('pending', 'correct', 'incorrect')),
  created_at timestamptz not null default now()
);

create index if not exists score_predictions_date_idx on score_predictions (ticket_date);
create index if not exists score_predictions_pending_idx on score_predictions (result_status) where result_status = 'pending';

alter table score_predictions enable row level security;

-- Same "public read, service-role-only write" pattern as fixtures/tickets
-- in schema.sql — anon/authenticated can read (the live site needs to);
-- the trial/sign-up GATING for this feature is a frontend/UX decision
-- (see ScorePredictionsSection in src/app/ScorePredictions.tsx), not an
-- RLS one — same as how `fixtures`/`tickets` are technically
-- public-readable but the UI blurs locked content client-side.
drop policy if exists "public read score_predictions" on score_predictions;
create policy "public read score_predictions" on score_predictions for select using (true);

grant usage on schema public to anon, authenticated, service_role;
grant select on public.score_predictions to anon, authenticated;
grant select, insert, update, delete on public.score_predictions to service_role;
