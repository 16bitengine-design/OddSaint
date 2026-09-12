-- ---------------------------------------------------------------------------
-- Odd Saint — database schema (single source of truth)
--
-- Run this once in Supabase: Project → SQL Editor → New query → paste → Run.
-- FULLY IDEMPOTENT — every statement uses `if not exists` / `or replace` /
-- `drop policy if exists` then `create`, so this file is always safe to
-- re-run in full, on a brand-new project or an existing one. Nothing here
-- ever drops a table, column, or row of data.
--
-- This replaces the old schema.sql + migrations/002/003/004 split. Going
-- forward, schema changes get added directly into this file rather than as
-- new migration files — the "migrations/" folder can be deleted once this
-- file has been applied. If you're on an existing database that already
-- ran the old migrations, re-running this file is harmless (every
-- statement below matches what those migrations already applied).
--
-- Design: the daily ticket-generation and grading jobs (GitHub Actions,
-- using the SERVICE ROLE key — never exposed to the browser) write into
-- these tables. The live site reads them with the public ANON key, which
-- is restricted to read-only via the RLS policies below. The anon key can
-- never insert, update, or delete a row here, even though it's public.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Fixtures — one row per real football fixture pulled in as a pick.
-- `result_status` starts 'pending' and is updated by the grading job once
-- the match finishes.
-- ---------------------------------------------------------------------------
create table if not exists fixtures (
  id bigint primary key,                 -- external API-Football fixture ID
  ticket_date date not null,
  league text not null,
  home_team text not null,
  away_team text not null,
  kickoff timestamptz not null,
  market text not null,                  -- e.g. "Home Win", "Over 2.5 Goals"
  odds numeric not null,
  confidence int not null check (confidence between 0 and 100),
  final_home_score int,
  final_away_score int,
  result_status text not null default 'pending'
    check (result_status in ('pending', 'green', 'red')),
  created_at timestamptz not null default now()
);

create index if not exists fixtures_date_idx on fixtures (ticket_date);
create index if not exists fixtures_pending_idx on fixtures (result_status) where result_status = 'pending';

-- ---------------------------------------------------------------------------
-- 2. Tickets — one row per generated ticket (e.g. "2026-08-10-bronze-0").
-- release_slot / available_at support the staggered-release model: slot 0
-- is a tier's first release of the day, slot 1 its second (mega/bronze/
-- silver/gold/platinum/diamond), while weekly-cadence tiers (weekly_lite,
-- weekly_titan, weekend) always write slot 0 and simply don't produce a
-- new row again for ~7 days — see scripts/generate-tickets.mjs.
-- ---------------------------------------------------------------------------
create table if not exists tickets (
  id text primary key,
  ticket_date date not null,
  tier text not null,
  slip_label text,                       -- e.g. "2 of 4", null for single-slip tiers
  match_count int not null,
  odds_range text not null,
  total_odds numeric not null,
  is_free boolean not null default false,
  release_slot int not null default 0,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists tickets_date_idx on tickets (ticket_date);
create index if not exists tickets_release_idx on tickets (ticket_date, tier, release_slot);

-- ---------------------------------------------------------------------------
-- 3. ticket_matches — join table: which fixtures belong to which ticket,
-- and in what order.
-- ---------------------------------------------------------------------------
create table if not exists ticket_matches (
  ticket_id text not null references tickets(id) on delete cascade,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  sort_order int not null default 0,
  primary key (ticket_id, fixture_id)
);

-- ---------------------------------------------------------------------------
-- RLS + grants for fixtures / tickets / ticket_matches
-- Public can READ. Writes only ever happen via the service_role key in the
-- GitHub Actions jobs (bypasses RLS), EXCEPT for the admin match-editor
-- path below, which lets an authenticated admin insert/update/delete
-- directly from the browser — gated by the `admins` table membership
-- check, not by anything client-side.
-- ---------------------------------------------------------------------------
alter table fixtures enable row level security;
alter table tickets enable row level security;
alter table ticket_matches enable row level security;

drop policy if exists "public read fixtures" on fixtures;
create policy "public read fixtures" on fixtures for select using (true);

drop policy if exists "public read tickets" on tickets;
create policy "public read tickets" on tickets for select using (true);

drop policy if exists "public read ticket_matches" on ticket_matches;
create policy "public read ticket_matches" on ticket_matches for select using (true);

grant usage on schema public to anon, authenticated, service_role;

grant select on public.fixtures, public.tickets, public.ticket_matches to anon, authenticated;
grant select, insert, update, delete on public.fixtures, public.tickets, public.ticket_matches to service_role;

-- Admin match editor — an admin (see `admins` table below) can attach/
-- detach an individual fixture on a specific ticket, e.g. pull a match
-- they judge too risky, or add one they consider a stronger pick.
grant insert, update, delete on ticket_matches to authenticated;

drop policy if exists "admins manage ticket_matches" on ticket_matches;
create policy "admins manage ticket_matches" on ticket_matches for all to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

grant update on tickets to authenticated;

drop policy if exists "admins update tickets" on tickets;
create policy "admins update tickets" on tickets for update to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. team_match_history — built entirely from data already in `fixtures`.
-- Every graded fixture already has final_home_score/final_away_score, so
-- this view just "unpivots" each fixture into one row per team (home
-- perspective + away perspective), giving a clean per-team result ledger
-- with zero new writes needed in the pipeline.
--
-- HONEST SCOPE NOTE: this only covers teams/matches that were actually
-- PICKED for a ticket at some point — not a comprehensive record of every
-- match either team has ever played. It's real history, just partial
-- coverage, since `fixtures` only stores fixtures the pipeline selected.
-- ---------------------------------------------------------------------------
-- DROP + CREATE rather than CREATE OR REPLACE: Postgres rejects
-- CREATE OR REPLACE VIEW (error 42P16) whenever the new column list
-- doesn't exactly match whatever is currently stored for this view name —
-- including cases where the live definition drifted from what's in this
-- file (a different column order from an earlier hand-edit, etc.). Drop
-- first sidesteps that unconditionally. Safe here because nothing else in
-- this schema references team_match_history, so there's nothing to CASCADE.
drop view if exists team_match_history;

create view team_match_history as
  select
    home_team as team,
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
    away_team as team,
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
  where final_home_score is not null and final_away_score is not null;

grant select on team_match_history to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. admins — lists who is allowed to change settings, moderate feedback,
-- edit tickets, and grant comped access. Add a row here yourself via
-- Supabase's Table Editor after you sign in once (there's no self-service
-- "become admin" flow; for a single-operator app, adding your own user_id
-- by hand once is simpler and safer than building account role-management
-- for one person). Find your user_id under Authentication → Users.
-- ---------------------------------------------------------------------------
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

grant select on admins to authenticated;
alter table admins enable row level security;
drop policy if exists "authenticated can read admins" on admins;
create policy "authenticated can read admins" on admins for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 6. app_settings — single row (id fixed at 1) holding every admin-
-- editable brand/content setting. The live site reads this on every page
-- load with the public anon key (read-only); only a user listed in
-- `admins` can update it, enforced at the database level via RLS below —
-- that's the real security boundary, not whatever the frontend chooses to
-- show or hide.
-- ---------------------------------------------------------------------------
create table if not exists app_settings (
  id int primary key default 1 check (id = 1),
  primary_color text not null default '#0b8a4f',
  accent_color text not null default '#0b8a4f',
  background_color text not null default '#f4f6f5',
  font_choice text not null default 'inter',
  hero_headline text not null default 'Curated tickets, graded in the open.',
  hero_subtext text not null default 'Odd Saint offers football predictions only — not a betting operator, not financial advice. Every pick is AI-assisted analysis, never a guarantee.',
  show_performance_history boolean not null default true,
  show_team_search boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into app_settings (id) values (1) on conflict (id) do nothing;

alter table app_settings enable row level security;

drop policy if exists "public read app_settings" on app_settings;
create policy "public read app_settings" on app_settings for select using (true);

drop policy if exists "admins update app_settings" on app_settings;
create policy "admins update app_settings" on app_settings for update
  using (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

grant select on app_settings to anon, authenticated;
grant update on app_settings to authenticated;

-- ---------------------------------------------------------------------------
-- 7. subscribers — manually admin-managed until a payment webhook upserts
-- here instead (see src/lib/grantAccess.ts, which now does exactly that).
-- ---------------------------------------------------------------------------
create table if not exists subscribers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  active boolean not null default true,
  expires_at timestamptz, -- null = no expiry set
  created_at timestamptz not null default now()
);

grant select on subscribers to authenticated;
alter table subscribers enable row level security;
drop policy if exists "user can read own subscription" on subscribers;
create policy "user can read own subscription" on subscribers for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 8. app_stats — app-wide stats (currently just the active subscriber
-- count). Public can read the count (it's just a number, not individual
-- identities) so the frontend can check the 50,000-subscriber milestone
-- and tighten the trial accordingly. Kept accurate via a trigger.
-- ---------------------------------------------------------------------------
create table if not exists app_stats (
  id int primary key default 1 check (id = 1),
  subscriber_count int not null default 0
);

insert into app_stats (id) values (1) on conflict (id) do nothing;

grant select on app_stats to anon, authenticated;
alter table app_stats enable row level security;
drop policy if exists "public read app_stats" on app_stats;
create policy "public read app_stats" on app_stats for select using (true);

create or replace function sync_subscriber_count() returns trigger as $$
begin
  update app_stats
  set subscriber_count = (select count(*) from subscribers where active = true)
  where id = 1;
  return null;
end;
$$ language plpgsql security definer;

drop trigger if exists subscribers_count_sync on subscribers;
create trigger subscribers_count_sync
  after insert or update or delete on subscribers
  for each statement
  execute function sync_subscriber_count();

-- ---------------------------------------------------------------------------
-- 9. saints_lock_access — deliberately separate from `subscribers`.
-- Saint's Lock is a distinct product (single-match, ultra-high-confidence
-- picks) with its own pricing ($1.50/day, $7/week, $27/month) and its own
-- rule: sign-up is required and no free trial ever applies here.
-- ---------------------------------------------------------------------------
create table if not exists saints_lock_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  active boolean not null default true,
  expires_at timestamptz not null, -- always required — no indefinite/trial access
  created_at timestamptz not null default now()
);

grant select on saints_lock_access to authenticated;
alter table saints_lock_access enable row level security;
drop policy if exists "user can read own saints_lock_access" on saints_lock_access;
create policy "user can read own saints_lock_access" on saints_lock_access for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 10. pending_transactions — connects provider transaction IDs (PawaPay
-- depositId or Pesapal order_tracking_id) with user/product/plan, since
-- neither provider reliably echoes back arbitrary app metadata. Only ever
-- written/read server-side via the service role key — never exposed to
-- the browser, so no RLS policies are needed (RLS stays disabled/default).
-- ---------------------------------------------------------------------------
create table if not exists pending_transactions (
  id text primary key, -- PawaPay depositId or Pesapal order_tracking_id
  provider text not null check (provider in ('pawapay', 'pesapal')),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  product text not null check (product in ('subscription', 'saints_lock')),
  plan text not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 11. feedback — customer support / moderated feedback. Anyone (including
-- anonymous visitors) can submit; nothing is ever shown publicly without
-- an admin moving it to 'approved' first — enforced at the database level.
-- ---------------------------------------------------------------------------
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  email text,
  category text not null default 'general'
    check (category in ('usability', 'performance', 'bug', 'support_request', 'general')),
  message text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  flagged_reason text,
  created_at timestamptz not null default now()
);

create index if not exists feedback_status_idx on feedback (status, created_at);

alter table feedback enable row level security;

grant insert on feedback to anon, authenticated;
grant select, update on feedback to authenticated;

drop policy if exists "anyone can submit feedback" on feedback;
create policy "anyone can submit feedback" on feedback for insert
  with check (true);

drop policy if exists "user can read own feedback" on feedback;
create policy "user can read own feedback" on feedback for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "admins can read all feedback" on feedback;
create policy "admins can read all feedback" on feedback for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));

drop policy if exists "admins can moderate feedback" on feedback;
create policy "admins can moderate feedback" on feedback for update to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 12. lookup_user_id_by_email — resolves an email to a user_id for the
-- admin "grant access by email" flow. auth.users isn't exposed through the
-- normal PostgREST API, so this SECURITY DEFINER function is the
-- sanctioned way to resolve it server-side. EXECUTE is granted ONLY to
-- service_role — unreachable from any client-side call, including an
-- admin's own browser session. Only src/app/api/admin/grant-access/route.ts
-- (authenticating with the service-role key) can call it.
-- ---------------------------------------------------------------------------
create or replace function lookup_user_id_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = auth, public
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;

revoke all on function lookup_user_id_by_email(text) from public, anon, authenticated;
grant execute on function lookup_user_id_by_email(text) to service_role;

-- ---------------------------------------------------------------------------
-- 13. admin_grants — audit trail of every admin-comped access grant
-- ("help someone subscribe through my admin account", no real payment
-- involved). Only ever written by the service-role key, right after a
-- successful grant via grantAccessForPayment() — the same function real
-- PawaPay/Pesapal payments call, so there's one single code path for
-- "what happens when access is granted."
-- ---------------------------------------------------------------------------
create table if not exists admin_grants (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references auth.users(id) on delete set null,
  admin_email text,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  target_email text,
  product text not null check (product in ('subscription', 'saints_lock')),
  plan text not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_grants_target_idx on admin_grants (target_user_id, created_at);

alter table admin_grants enable row level security;

grant select on admin_grants to authenticated;

drop policy if exists "admins can read admin_grants" on admin_grants;
create policy "admins can read admin_grants" on admin_grants for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 14. user_profiles — per-user timezone capture for lifecycle emails.
-- auth.users doesn't store timezone, so this is populated client-side
-- (see syncUserTimezone in src/lib/lifecycleEmail.ts) immediately after sign-in, using the
-- browser's own Intl timezone — scheduling is based on where the person
-- actually is, not a guess from payment country. email is duplicated here
-- (not just looked up via auth.users) so the email-sending scripts never
-- need auth-schema access, same pattern as subscribers/saints_lock_access.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 15. notification_log — idempotent lifecycle-email send ledger. Every
-- sender inserts BEFORE sending, and only sends if the insert succeeds —
-- a unique-constraint violation means "already sent," which is safer than
-- check-then-send (no race window across overlapping workflow runs).
-- reference_id's meaning depends on event_type:
--   welcome_subscription / welcome_saints_lock  -> 'lifetime' (once ever)
--   daily_subscription_nudge / daily_saints_lock_nudge -> the user's LOCAL
--     calendar date ('YYYY-MM-DD'), so it naturally resets once per day
--   saints_lock_ready / weekly_ticket_ready -> the ticket's id, so a
--     retried/rerun generation job can never re-notify for the same ticket
-- Only ever queried server-side via the service-role key — no RLS needed,
-- same pattern as pending_transactions.
-- ---------------------------------------------------------------------------
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
