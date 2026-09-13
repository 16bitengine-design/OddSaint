-- ---------------------------------------------------------------------------
-- Odd Saint — database schema
-- Run this once in Supabase: Project → SQL Editor → New query → paste → Run.
--
-- Design: the daily ticket-generation and grading jobs (GitHub Actions,
-- using the SERVICE ROLE key — never exposed to the browser) write into
-- these tables. The live site reads them with the public ANON key, which
-- is restricted to read-only via the RLS policies below. The anon key can
-- never insert, update, or delete a row here, even though it's public.
-- ---------------------------------------------------------------------------

-- One row per real football fixture that's been pulled in and used as a
-- pick. `result_status` starts 'pending' and is updated by the grading job
-- once the match finishes.
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

-- One row per generated ticket (e.g. "2026-08-10-bronze-2").
create table if not exists tickets (
  id text primary key,
  ticket_date date not null,
  tier text not null,
  slip_label text,                       -- e.g. "2 of 4", null for single-slip tiers
  match_count int not null,
  odds_range text not null,
  total_odds numeric not null,
  is_free boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists tickets_date_idx on tickets (ticket_date);

-- Join table: which fixtures belong to which ticket, and in what order.
create table if not exists ticket_matches (
  ticket_id text not null references tickets(id) on delete cascade,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  sort_order int not null default 0,
  primary key (ticket_id, fixture_id)
);

-- ---------------------------------------------------------------------------
-- Row Level Security — public can READ, nobody public can WRITE.
-- Writes only ever happen via the service_role key in the GitHub Actions
-- jobs, which bypasses RLS entirely, so no write policy is needed for it.
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

-- ---------------------------------------------------------------------------
-- Explicit privilege grants.
-- RLS policies (above) control WHICH ROWS a role can see — they don't
-- replace the underlying Postgres table privilege that says whether a role
-- can attempt SELECT/INSERT/UPDATE at all. If these grants are missing,
-- you'll see "permission denied for table X" (Postgres error 42501) even
-- though service_role is normally expected to bypass RLS. Safe to re-run —
-- GRANT is idempotent.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

grant select on public.fixtures, public.tickets, public.ticket_matches to anon, authenticated;
grant select, insert, update, delete on public.fixtures, public.tickets, public.ticket_matches to service_role;

-- ---------------------------------------------------------------------------
-- Team match history — built entirely from data already in `fixtures`.
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
create or replace view team_match_history as
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
-- Admin-editable app settings
-- ---------------------------------------------------------------------------
-- `admins` lists who is allowed to change settings — add a row here
-- yourself via Supabase's Table Editor after you sign in once (there's no
-- self-service "become admin" flow; for a single-operator app, adding your
-- own user_id by hand once is simpler and safer than building account
-- role-management for one person). Find your user_id under
-- Authentication → Users after signing in via the app's magic link.
create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

grant select on admins to authenticated;
alter table admins enable row level security;
drop policy if exists "authenticated can read admins" on admins;
create policy "authenticated can read admins" on admins for select to authenticated using (true);

-- `app_settings` is a single row (id is fixed at 1) holding every
-- admin-editable brand/content setting. The live site reads this on every
-- page load with the public anon key (read-only); only a user listed in
-- `admins` can update it, enforced at the database level via RLS below —
-- that's the real security boundary, not whatever the frontend chooses to
-- show or hide.
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
-- Subscribers
-- ---------------------------------------------------------------------------
-- Manually admin-managed for now, same pattern as `admins` — payment
-- integration isn't wired up yet, so there's currently no automated way for
-- someone to become a subscriber other than an admin adding a row here via
-- Supabase's Table Editor. Once Stripe/Paystack (or similar) is added, that
-- webhook should upsert rows here instead of requiring manual action —
-- nothing else in the app needs to change when that happens, since
-- everything already reads from this table.
create table if not exists subscribers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  active boolean not null default true,
  expires_at timestamptz, -- null = no expiry set (until real billing manages this)
  created_at timestamptz not null default now()
);

grant select on subscribers to authenticated;
alter table subscribers enable row level security;
drop policy if exists "user can read own subscription" on subscribers;
create policy "user can read own subscription" on subscribers for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- App-wide stats (currently just the active subscriber count)
-- ---------------------------------------------------------------------------
-- Public can read the count (it's just a number, not individual identities)
-- so the frontend can check the 50,000-subscriber milestone and tighten the
-- trial accordingly. Kept accurate via a trigger rather than incremented
-- from webhook code — that way it stays correct regardless of whether a
-- subscriber row came from a payment webhook or was added manually by an
-- admin via Supabase's Table Editor.
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
-- Saint's Lock access
-- ---------------------------------------------------------------------------
-- Deliberately separate from `subscribers` — Saint's Lock is a distinct
-- product (single-match, ultra-high-confidence picks) with its own pricing
-- ($1.50/day, $7/week, $27/month) and its own rule: sign-up is required and
-- no free trial ever applies here, unlike the rest of the app.
create table if not exists saints_lock_access (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  active boolean not null default true,
  expires_at timestamptz not null, -- always required here — no indefinite/trial access
  created_at timestamptz not null default now()
);

grant select on saints_lock_access to authenticated;
alter table saints_lock_access enable row level security;
drop policy if exists "user can read own saints_lock_access" on saints_lock_access;
create policy "user can read own saints_lock_access" on saints_lock_access for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Pending transactions
-- ---------------------------------------------------------------------------
-- PawaPay and Pesapal don't reliably echo back arbitrary metadata the way
-- Stripe/Flutterwave's `metadata` fields did — this table is written at
-- checkout-initiation time (before redirecting/pushing to the customer's
-- phone), keyed by that provider's own transaction ID, so the webhook or
-- status-check can look up who's paying for what once payment completes.
-- Only ever written/read by server code using the service role key — never
-- exposed to the browser.
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

-- No RLS policies needed here at all — this table is never queried with the
-- anon/authenticated client, only server-side via the service role key,
-- which bypasses RLS anyway. Leaving RLS disabled (default) rather than
-- adding policies that would never be exercised.

-- ---------------------------------------------------------------------------
-- User profiles (timezone-aware lifecycle emails)
-- ---------------------------------------------------------------------------
-- Captured at sign-in so the hourly lifecycle-email job (see
-- scripts/send-lifecycle-emails.mjs and scripts/lib/lifecycleEmail.mjs) can
-- work out each user's real local hour instead of sending everything on a
-- single fixed UTC schedule. `timezone` must be a valid IANA name (e.g.
-- "Africa/Nairobi", "Europe/London") — defaults to 'UTC' until the app's
-- sign-in flow actually writes a real value here.
create table if not exists user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);

grant select on user_profiles to authenticated;
alter table user_profiles enable row level security;
drop policy if exists "user can read own profile" on user_profiles;
create policy "user can read own profile" on user_profiles for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Notification log (lifecycle email idempotency ledger)
-- ---------------------------------------------------------------------------
-- tryClaimNotification() in scripts/lib/lifecycleEmail.mjs INSERTS a row
-- here FIRST, and only sends the actual email if the insert succeeds. The
-- unique constraint below is what makes that safe: if two workflow runs
-- ever overlap and both try to claim the same user+event+reference
-- combination, the second insert hits a unique-constraint violation
-- (Postgres error 23505), which the code treats as "already sent" rather
-- than an error. This is insert-then-send, not check-then-send — it closes
-- the race window a simple SELECT-first check would leave open.
--
-- Only ever written/read by server code using the service role key (the
-- hourly GitHub Actions job and the ticket-generation job) — never exposed
-- to the browser, so no RLS policies are needed.
create table if not exists notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  event_type text not null,
  reference_id text not null,
  sent_at timestamptz not null default now(),
  unique (user_id, event_type, reference_id)
);
