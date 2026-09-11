-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of schema.sql + migrations 002/003 — no columns or
-- tables dropped or renamed, safe to apply to the existing production
-- database. Existing rows in `fixtures` simply get NULL home_team_id /
-- away_team_id until the next time they're touched by the pipeline — no
-- backfill of historical picks is attempted or needed.
--
-- WHY: team NAME matching ("Manchester United" vs "Man United" vs "Man
-- Utd") is fragile and can silently under-count a team's real history.
-- API-Football already assigns every team a stable numeric ID — this
-- migration captures and uses that ID instead of inventing a new one, and
-- adds a dedicated table (team_results_history) for a real, proactively-
-- built per-team performance database, independent of which fixtures ever
-- became a ticket pick.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Team IDs on the existing ticket-fixtures table
-- ---------------------------------------------------------------------------
alter table fixtures add column if not exists home_team_id bigint;
alter table fixtures add column if not exists away_team_id bigint;

create index if not exists fixtures_home_team_id_idx on fixtures (home_team_id);
create index if not exists fixtures_away_team_id_idx on fixtures (away_team_id);

-- ---------------------------------------------------------------------------
-- 2. Proactively-backfilled per-team result history
-- ---------------------------------------------------------------------------
-- One row per (fixture, team) perspective — same "each match produces two
-- rows, one per team's own view" pattern as the original team_match_history
-- view, just populated by scripts/backfill-team-history.mjs directly from
-- API-Football's /fixtures?team={id}&last={n} rather than only from
-- fixtures that happened to get ticketed. This is what actually builds a
-- real performance database per team rather than a biased sample of
-- whichever teams the pipeline picked before.
create table if not exists team_results_history (
  fixture_id bigint not null,      -- API-Football fixture ID
  team_id bigint not null,         -- API-Football team ID — the "unique ID" this migration is about
  team_name text not null,
  opponent_id bigint,
  opponent_name text not null,
  venue text not null check (venue in ('home', 'away')),
  goals_for int not null,
  goals_against int not null,
  league text not null,
  kickoff timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (fixture_id, team_id)
);

create index if not exists team_results_history_team_idx on team_results_history (team_id, kickoff desc);

alter table team_results_history enable row level security;

grant select on team_results_history to anon, authenticated;
grant select, insert, update, delete on team_results_history to service_role;

drop policy if exists "public read team_results_history" on team_results_history;
create policy "public read team_results_history" on team_results_history for select using (true);

-- ---------------------------------------------------------------------------
-- 3. team_match_history — now a union of BOTH sources, keyed by team_id
-- ---------------------------------------------------------------------------
-- Still exposes the same `team` (text) column the frontend's team-search
-- feature (src/lib/dataFetcher.ts: fetchTeamHistory) already queries by —
-- that keeps working unchanged. The new team_id/opponent_id columns are
-- additive, so nothing that does `select` with an explicit column list
-- breaks. scripts/lib/teamModel.mjs is updated separately to query this
-- view by team_id instead of by name.
create or replace view team_match_history as
  select
    home_team_id as team_id,
    home_team as team,
    away_team_id as opponent_id,
    away_team as opponent,
    'home' as venue,
    final_home_score as goals_for,
    final_away_score as goals_against,
    case
      when final_home_score > final_away_score then 'W'
      when final_home_score < final_away_score then 'L'
      else 'D'
    end as result,
    league,
    kickoff,
    ticket_date
  from fixtures
  where final_home_score is not null and final_away_score is not null
  union all
  select
    away_team_id as team_id,
    away_team as team,
    home_team_id as opponent_id,
    home_team as opponent,
    'away' as venue,
    final_away_score as goals_for,
    final_home_score as goals_against,
    case
      when final_away_score > final_home_score then 'W'
      when final_away_score < final_home_score then 'L'
      else 'D'
    end as result,
    league,
    kickoff,
    ticket_date
  from fixtures
  where final_home_score is not null and final_away_score is not null
  union all
  select
    team_id,
    team_name as team,
    opponent_id,
    opponent_name as opponent,
    venue,
    goals_for,
    goals_against,
    case
      when goals_for > goals_against then 'W'
      when goals_for < goals_against then 'L'
      else 'D'
    end as result,
    league,
    kickoff,
    kickoff::date as ticket_date -- backfilled rows were never tied to a real ticket date; kickoff's own date is a harmless placeholder, unused by anything that cares about real ticket_date semantics
  from team_results_history;

grant select on team_match_history to anon, authenticated;
