-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of schema.sql + migrations 002/003 — no columns/
-- tables dropped or renamed, safe to apply to the existing production
-- database.
--
-- Supports the two-provider fixture split introduced in
-- scripts/generate-tickets.mjs:
--   - Mega/Bronze/Silver/Gold/Saint's Lock: football-data.org + The Odds API
--   - Platinum/Diamond/Weekly Lite/Weekly Titan: API-Football (unchanged)
--
-- WHY THIS MIGRATION IS NEEDED: scripts/grade-tickets.mjs has to know which
-- provider originally supplied a given `fixtures` row so it can re-query
-- the RIGHT provider to check the final score — API-Football and
-- football-data.org don't share fixture IDs or an endpoint. Without this
-- column, grading would have no way to distinguish them.
--
-- NOTE ON ID COLLISION: `fixtures.id` stays a single bigint primary key
-- (no composite-key change) — football-data.org's native match IDs are
-- offset by MAJORS_ID_OFFSET (10,000,000,000, defined in both
-- generate-tickets.mjs and grade-tickets.mjs — see the comment there for
-- why it's duplicated rather than imported) before being written here, so
-- they can never collide with an API-Football native ID in the same
-- column. This was a deliberate simpler alternative to migrating
-- ticket_matches' foreign key to a composite (source, fixture_id) — see
-- the project's "no unnecessary rewrites" rule. Revisit if a future change
-- needs to store the true native ID unmodified.
-- ---------------------------------------------------------------------------

alter table fixtures add column if not exists source text not null default 'api_football'
  check (source in ('api_football', 'football_data_org'));

create index if not exists fixtures_source_idx on fixtures (source);

-- Existing rows (all written before this migration) are correctly
-- backfilled by the column default — every row already in the table came
-- from API-Football, so 'api_football' is accurate for all of them with no
-- manual UPDATE needed.
