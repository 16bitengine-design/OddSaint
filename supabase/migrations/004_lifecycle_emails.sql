-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of schema.sql + migrations 002/003.
--
-- Supports: per-user timezone-aware lifecycle emails (welcome, daily
-- subscription/Saint's Lock nudges, "ticket ready" notifications) via
-- Brevo, with idempotent send tracking so a rerun/retry of any workflow
-- can never double-send the same email to the same person.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. user_profiles — timezone capture
-- ---------------------------------------------------------------------------
-- auth.users isn't exposed through PostgREST, and doesn't store timezone
-- anyway — this table is populated client-side (see src/lib/timezoneSync.ts)
-- immediately after sign-in, using the browser's own Intl timezone, so
-- scheduling is based on where the person actually is, not a guess from
-- their payment country. email is duplicated here (not just looked up via
-- auth.users) so the email-sending scripts never need auth-schema access —
-- same pattern already used by subscribers/saints_lock_access, which also
-- keep their own email column for this reason.
create table if not exists user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  timezone text not null default 'UTC', -- IANA name, e.g. 'Africa/Nairobi'
  updated_at timestamptz not null default now()
);

alter table user_profiles enable row level security;

grant select, insert, update on user_profiles to authenticated;

drop policy if exists "user can manage own profile" on user_profiles;
create policy "user can manage own profile" on user_profiles for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Read access for the service role (GitHub Actions sender script) is
-- implicit — service_role bypasses RLS entirely, same as every other
-- table in this schema.

-- ---------------------------------------------------------------------------
-- 2. notification_log — idempotent send ledger
-- ---------------------------------------------------------------------------
-- The unique constraint below is the actual dedupe mechanism: every sender
-- inserts BEFORE sending, and only sends if the insert succeeds. A unique
-- violation means "already sent" — this is safer than a
-- check-then-send pattern, which has a race window if two runs overlap.
-- reference_id's meaning depends on event_type:
--   welcome_subscription / welcome_saints_lock  -> 'lifetime' (once ever)
--   daily_subscription_nudge / daily_saints_lock_nudge -> the user's LOCAL
--     calendar date ('YYYY-MM-DD'), so it naturally resets once per day
--   saints_lock_ready / weekly_ticket_ready -> the ticket's id, so a
--     retried/rerun generation job can never re-notify for the same ticket
create table if not exists notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text,
  event_type text not null check (event_type in (
    'welcome_subscription',
    'welcome_saints_lock',
    'daily_subscription_nudge',
    'daily_saints_lock_nudge',
    'saints_lock_ready',
    'weekly_ticket_ready'
  )),
  reference_id text not null,
  sent_at timestamptz not null default now(),
  unique (user_id, event_type, reference_id)
);

create index if not exists notification_log_sent_at_idx on notification_log (sent_at);

-- No RLS policies needed — this table is never queried with the
-- anon/authenticated client, only server-side (Vercel API routes and
-- GitHub Actions scripts) via the service-role key, which bypasses RLS
-- anyway. Same pattern as pending_transactions.
