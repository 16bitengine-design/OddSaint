-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive (GRANT only) — does not create, alter, or drop any
-- table/column, and is safe to re-run (GRANT is idempotent).
--
-- FIXES: send-lifecycle-emails.mjs failing with
--   { code: '42501', message: 'permission denied for table user_profiles' }
--   { code: '42501', message: 'permission denied for table notification_log' }
--
-- ROOT CAUSE: whatever migration originally created user_profiles and
-- notification_log never ran the explicit GRANT statements every other
-- table in supabase/schema.sql gets in its "Explicit privilege grants"
-- section. RLS policies control WHICH ROWS a role can see — they don't
-- replace the underlying Postgres table privilege that says whether a
-- role can attempt SELECT/INSERT/etc at all. service_role normally
-- bypasses RLS, but it still needs this table-level grant, exactly as
-- schema.sql's own comment on this already explains for fixtures/tickets/
-- ticket_matches.
--
-- SCOPE NOTE: this grants service_role the same full CRUD access schema.sql
-- already gives it on every other pipeline-managed table (fixtures,
-- tickets, ticket_matches, admin_grants, etc.) — service_role is the
-- automation pipeline's own role and bypasses RLS entirely, so table-level
-- grants are the only real gate for it.
--
-- OUT OF SCOPE — VERIFY SEPARATELY: if any CLIENT-SIDE code (e.g. a
-- syncUserTimezone-style call from src/lib/lifecycleEmail.ts, referenced
-- but not reviewed here) writes to user_profiles using the anon/
-- authenticated key rather than service_role, that path needs its own
-- grant + RLS policy (mirroring the `subscribers`/`saints_lock_access`
-- pattern of "user can read/write own row" in schema.sql) — this
-- migration deliberately does NOT add anon/authenticated grants, since
-- the actual CREATE TABLE definitions and intended RLS shape for these
-- two tables weren't available to check against.
-- ---------------------------------------------------------------------------

grant usage on schema public to service_role;

grant select, insert, update, delete on public.user_profiles to service_role;
grant select, insert, update, delete on public.notification_log to service_role;
