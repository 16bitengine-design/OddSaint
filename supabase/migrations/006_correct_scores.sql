-- ---------------------------------------------------------------------------
-- Odd Saint — migration 006: correct-score predictions
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive and safe to re-run. Touches no existing table.
--
-- Written + graded ONLY by scripts/generate-correct-scores.mjs (service
-- role). Read by the browser via fetchCorrectScores()/fetchCorrectScoreStats()
-- in src/lib/dataFetcher.ts with the public anon key — read-only.
-- ---------------------------------------------------------------------------

create table if not exists correct_score_predictions (
  fixture_id bigint primary key,            -- API-Football fixture ID; one prediction per fixture, immutable
  prediction_date date not null,            -- UTC day the prediction was generated for
  league text not null,
  country text not null default 'Unknown',
  home_team text not null,
  away_team text not null,
  kickoff timestamptz not null,
  top_scores jsonb not null,                -- [{home, away, probability}, ...] best first, up to 3
  home_xg numeric,
  away_xg numeric,
  home_sample int,
  away_sample int,
  result_status text not null default 'pending'
    check (result_status in ('pending', 'hit', 'miss')),
  top3_hit boolean,                         -- null until graded
  final_home_score int,                     -- 90-minute score once graded
  final_away_score int,
  created_at timestamptz not null default now()
);

create index if not exists correct_score_predictions_date_idx on correct_score_predictions (prediction_date);
create index if not exists correct_score_predictions_pending_idx
  on correct_score_predictions (kickoff) where result_status = 'pending';

alter table correct_score_predictions enable row level security;

drop policy if exists "public read correct_score_predictions" on correct_score_predictions;
create policy "public read correct_score_predictions" on correct_score_predictions for select using (true);

-- Explicit table privileges (RLS alone doesn't grant these — see the 42501
-- note in migration 004_lifecycle_email_grants.sql).
grant usage on schema public to anon, authenticated, service_role;
grant select on public.correct_score_predictions to anon, authenticated;
grant select, insert, update, delete on public.correct_score_predictions to service_role;
