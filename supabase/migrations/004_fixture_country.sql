-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of schema.sql + migrations 002/003 — no columns
-- dropped or renamed, safe to apply to the existing production database.
--
-- Adds the fixture's nation/country (from API-Football's league.country
-- field) so tickets can display which country each match's league is
-- from, not just the league name — e.g. "Premier League (England)"
-- rather than just "Premier League". Populated going forward by
-- scripts/generate-tickets.mjs; existing rows get the placeholder
-- default below since their real country wasn't captured at the time.
-- ---------------------------------------------------------------------------

alter table fixtures add column if not exists country text not null default 'Unknown';

-- No index needed — country is a display field only, never filtered or
-- joined on anywhere in the current app.
