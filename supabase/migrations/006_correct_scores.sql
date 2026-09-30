-- ---------------------------------------------------------------------------
-- Odd Saint — migration 006: correct-score predictions
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive — one new table, nothing existing is touched.
--
-- One row per fixture. top_scores holds the model's three most likely
-- scorelines as [{ "home": 1, "away": 0, "probability": 0.121 }, ...],
-- most likely first. Rows are written once (the generator inserts with
-- ignoreDuplicates), so a prediction can never be rewritten after the fact.
-- ---------------------------------------------------------------------------

create table if not exists correct_score_predictions (
  fixture_id bigint primary key,           -- API-Football fixture ID
  prediction_date date not null,
  league text not null,
  country text not null default 'Unknown',
  home_team text not null,
  away_team text not null,
  kickoff timestamptz not null,
  top_scores jsonb not null,
  home_xg numeric not null,
  away_xg numeric not null,
  home_sample int,                         -- home-venue matches the model used
  away_sample int,                         -- away-venue matches the model used
  final_home_score int,                    -- 90-minute score
  final_away_score int,
  result_status text not null default 'pending'
    check (result_status in ('pending', 'hit', 'miss')),  -- hit = top pick was exact
  top3_hit boolean,                        -- true if ANY of the three listed scores was exact
  created_at timestamptz not null default now()
);

create index if not exists correct_score_kickoff_idx on correct_score_predictions (kickoff);
create index if not exists correct_score_pending_idx
  on correct_score_predictions (result_status) where result_status = 'pending';

alter table correct_score_predictions enable row level security;

drop policy if exists "public read correct_score_predictions" on correct_score_predictions;
create policy "public read correct_score_predictions" on correct_score_predictions
  for select using (true);

grant usage on schema public to anon, authenticated, service_role;
grant select on public.correct_score_predictions to anon, authenticated;
grant select, insert, update, delete on public.correct_score_predictions to service_role;
