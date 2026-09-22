-- ---------------------------------------------------------------------------
-- Odd Saint — database schema (consolidated)
-- Run this once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Safe to re-run in full — every statement uses IF NOT EXISTS / OR REPLACE /
-- DROP POLICY IF EXISTS conventions.
--
-- CONSOLIDATION NOTE: this file folds in what were previously four separate
-- "004_*.sql" migrations (a naming collision — four different migrations
-- all numbered 004), now merged directly into the tables/grants they
-- touched, matching this project's existing "collapse migrations into one
-- schema.sql" pattern:
--   - 004_fixture_country.sql       → fixtures.country column (below)
--   - 004_audit_instrumentation.sql → ticket_views / satisfaction_ratings /
--                                      page_perf (section 9)
--   - 004_lifecycle_email_grants.sql → service_role grants on
--                                      user_profiles / notification_log
--                                      (folded into sections 10 & 11)
--   - 004_ticket_unlocks.sql         → pending_transactions.ticket_id +
--                                      widened product check, and the
--                                      ticket_unlocks table (section 12)
-- If this is being applied to a database that already ran those four
-- migrations individually, every statement here is idempotent and safe to
-- re-run — nothing drops existing data.
--
-- Design: the daily ticket-generation and grading jobs (GitHub Actions,
-- using the SERVICE ROLE key — never exposed to the browser) write into
-- these tables. The live site reads them with the public ANON key, which
-- is restricted to read-only via the RLS policies below. The anon key can
-- never insert, update, or delete a row here, even though it's public.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Fixtures
-- ---------------------------------------------------------------------------
-- One row per real football fixture that's been pulled in and used as a
-- pick. `result_status` starts 'pending' and is updated by the grading job
-- once the match finishes. `country` (from API-Football's league.country
-- field) lets tickets show which nation a league is from, e.g. "Premier
-- League (England)" — defaults to 'Unknown' for any row written before
-- this field existed, since their real country wasn't captured at the time.
create table if not exists fixtures (
  id bigint primary key,                 -- external API-Football fixture ID
  ticket_date date not null,
  league text not null,
  country text not null default 'Unknown',
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

-- Covers a fixtures table created before the country column existed.
alter table fixtures add column if not exists country text not null default 'Unknown';

create index if not exists fixtures_date_idx on fixtures (ticket_date);
create index if not exists fixtures_pending_idx on fixtures (result_status) where result_status = 'pending';

-- ---------------------------------------------------------------------------
-- 2. Tickets
-- ---------------------------------------------------------------------------
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
  release_slot int not null default 0,   -- 0 = today's 1st release for this tier, 1 = 2nd
  available_at timestamptz,              -- when this slip actually becomes accessible (generation + 1h delay)
  created_at timestamptz not null default now()
);

-- Covers a tickets table created before staggered release existed.
alter table tickets add column if not exists release_slot int not null default 0;
alter table tickets add column if not exists available_at timestamptz;

create index if not exists tickets_date_idx on tickets (ticket_date);

-- ---------------------------------------------------------------------------
-- 3. Ticket matches (join table)
-- ---------------------------------------------------------------------------
-- Which fixtures belong to which ticket, and in what order.
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
-- GRANT is idempotent. This was the exact root cause behind the former
-- 004_lifecycle_email_grants.sql migration (section 10/11 below fold that
-- fix in directly rather than leaving it as a bolt-on migration).
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

grant select on public.fixtures, public.tickets, public.ticket_matches to anon, authenticated;
grant select, insert, update, delete on public.fixtures, public.tickets, public.ticket_matches to service_role;

-- ---------------------------------------------------------------------------
-- 4. Team match history (view)
-- ---------------------------------------------------------------------------
-- Built entirely from data already in `fixtures`. Every graded fixture
-- already has final_home_score/final_away_score, so this view just
-- "unpivots" each fixture into one row per team (home perspective + away
-- perspective), giving a clean per-team result ledger with zero new writes
-- needed in the pipeline.
--
-- HONEST SCOPE NOTE: this only covers teams/matches that were actually
-- PICKED for a ticket at some point — not a comprehensive record of every
-- match either team has ever played. It's real history, just partial
-- coverage, since `fixtures` only stores fixtures the pipeline selected.
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
-- 5. Admins
-- ---------------------------------------------------------------------------
-- Lists who is allowed to change settings — add a row here yourself via
-- Supabase's Table Editor after you sign in once (there's no self-service
-- "become admin" flow; for a single-operator app, adding your own user_id
-- by hand once is simpler and safer than building account role-management
-- for one person). Find your user_id under Authentication → Users after
-- signing in via the app's magic link.
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
-- 6. App settings
-- ---------------------------------------------------------------------------
-- A single row (id is fixed at 1) holding every admin-editable brand/
-- content setting. The live site reads this on every page load with the
-- public anon key (read-only); only a user listed in `admins` can update
-- it, enforced at the database level via RLS below — that's the real
-- security boundary, not whatever the frontend chooses to show or hide.
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
-- 7. Subscribers
-- ---------------------------------------------------------------------------
-- Manually admin-managed for now, same pattern as `admins` — payment
-- integration isn't wired up yet, so there's currently no automated way for
-- someone to become a subscriber other than an admin adding a row here via
-- Supabase's Table Editor, or via the admin comp route
-- (src/app/api/admin/grant-access/route.ts), which writes through the same
-- grantAccessForPayment() function real payments call.
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
-- 8. App-wide stats (currently just the active subscriber count)
-- ---------------------------------------------------------------------------
-- Public can read the count (it's just a number, not individual identities)
-- so the frontend can check the 50,000-subscriber milestone and tighten the
-- trial accordingly. Kept accurate via a trigger rather than incremented
-- from webhook code — that way it stays correct regardless of whether a
-- subscriber row came from a payment webhook or was added manually by an
-- admin.
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
-- 9. Saint's Lock access
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
-- 10. Admin grants audit log
-- ---------------------------------------------------------------------------
-- Records every time an admin comps subscription/Saint's Lock access for
-- another user via /api/admin/grant-access — accountability trail, not a
-- security boundary (the real boundary is the `admins` check in that
-- route). Also backs lookup_user_id_by_email(), used to resolve a target
-- user's id from their email without ever exposing that lookup to a
-- client-side session.
create table if not exists admin_grants (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  admin_email text,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  target_email text,
  product text not null check (product in ('subscription', 'saints_lock')),
  plan text not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_grants_created_idx on admin_grants (created_at);

alter table admin_grants enable row level security;

grant select, insert on admin_grants to authenticated;
grant select, insert, update, delete on admin_grants to service_role;

drop policy if exists "admins can read admin_grants" on admin_grants;
create policy "admins can read admin_grants" on admin_grants for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));

create or replace function lookup_user_id_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = auth, public
as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;

-- Only callable with the service-role key (revoked from anon/authenticated
-- so it can never be invoked from a client-side session, even an admin's
-- own) — see the grant-access route's own comment on why this matters.
revoke all on function lookup_user_id_by_email(text) from public, anon, authenticated;
grant execute on function lookup_user_id_by_email(text) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Pending transactions
-- ---------------------------------------------------------------------------
-- PawaPay and Pesapal don't reliably echo back arbitrary metadata the way
-- Stripe/Flutterwave's `metadata` fields did — this table is written at
-- checkout-initiation time (before redirecting/pushing to the customer's
-- phone), keyed by that provider's own transaction ID, so the webhook or
-- status-check can look up who's paying for what once payment completes.
-- Only ever written/read by server code using the service role key — never
-- exposed to the browser.
--
-- `ticket_id` and the 'ticket_unlock' product value (originally a separate
-- migration) are included directly below — a one-off, non-expiring unlock
-- of a SPECIFIC ticket, distinct from the dated subscription/saints_lock
-- plans.
create table if not exists pending_transactions (
  id text primary key, -- PawaPay depositId or Pesapal order_tracking_id
  provider text not null check (provider in ('pawapay', 'pesapal')),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  product text not null check (product in ('subscription', 'saints_lock', 'ticket_unlock')),
  plan text not null,
  ticket_id text references tickets(id) on delete cascade, -- only set for 'ticket_unlock' rows
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  created_at timestamptz not null default now()
);

-- Covers a pending_transactions table created before ticket_unlock existed.
alter table pending_transactions add column if not exists ticket_id text references tickets(id) on delete cascade;
alter table pending_transactions drop constraint if exists pending_transactions_product_check;
alter table pending_transactions add constraint pending_transactions_product_check
  check (product in ('subscription', 'saints_lock', 'ticket_unlock'));

create index if not exists pending_transactions_ticket_idx on pending_transactions (ticket_id) where ticket_id is not null;

-- No RLS policies needed here at all — this table is never queried with the
-- anon/authenticated client, only server-side via the service role key,
-- which bypasses RLS anyway. Leaving RLS disabled (default) rather than
-- adding policies that would never be exercised.

-- ---------------------------------------------------------------------------
-- 12. Ticket unlocks
-- ---------------------------------------------------------------------------
-- One row per (user, ticket) that's been paid for via the per-ticket
-- "Pay Micro-Fee" product (TICKET_UNLOCK_PRICE_USD in src/lib/plans.ts).
-- Deliberately separate from subscribers/saints_lock_access: a one-off,
-- non-expiring unlock of a SPECIFIC ticket, not a dated plan. Only ever
-- written by grantAccessForPayment() via the service-role key — same
-- single-chokepoint pattern subscribers/saints_lock_access already use.
create table if not exists ticket_unlocks (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticket_id text not null references tickets(id) on delete cascade,
  email text,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, ticket_id)
);

create index if not exists ticket_unlocks_user_idx on ticket_unlocks (user_id);

alter table ticket_unlocks enable row level security;

grant select on ticket_unlocks to authenticated;

drop policy if exists "user can read own ticket_unlocks" on ticket_unlocks;
create policy "user can read own ticket_unlocks" on ticket_unlocks for select to authenticated
  using (user_id = auth.uid());

-- No insert/update/delete policy for anon/authenticated — writes only ever
-- happen server-side via the service-role key in grantAccessForPayment(),
-- which bypasses RLS entirely, same as every other access-grant table.

-- ---------------------------------------------------------------------------
-- 13. User profiles (timezone-aware lifecycle emails)
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

-- service_role grant folded in directly (previously a standalone
-- "004_lifecycle_email_grants.sql" migration fixing a 42501 permission
-- error — see section header note above for the root cause).
grant select, insert, update, delete on public.user_profiles to service_role;

alter table user_profiles enable row level security;
drop policy if exists "user can read own profile" on user_profiles;
create policy "user can read own profile" on user_profiles for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 14. Notification log (lifecycle email idempotency ledger)
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

-- service_role grant folded in directly (see section 13's note — same
-- former migration fixed both tables in one file).
grant select, insert, update, delete on public.notification_log to service_role;

-- ---------------------------------------------------------------------------
-- 15. Audit instrumentation — ticket views, satisfaction, page performance
-- ---------------------------------------------------------------------------
-- Powers the weekly/quarterly/yearly audit reports (scripts/audit-weekly.mjs,
-- audit-quarterly.mjs, audit-yearly.mjs). Visitor counts, traffic source,
-- location, and age-band data are NOT stored here — those already live in
-- GA4 and are pulled directly from the GA4 Data API at report time (see
-- scripts/lib/ga4.mjs), so there's no reason to duplicate them in Supabase.
--
-- All three tables here are insert-only from the browser (anon +
-- authenticated) — same "anyone can submit, only admins can read" pattern
-- already used for `feedback`. The audit scripts themselves read via the
-- service-role key, which bypasses RLS entirely, same as every other
-- GitHub Actions script in this repo.

-- 15a. Ticket views — powers "most viewed tickets" and "high velocity time
-- periods" in the audit reports. tier/label captured at insert time
-- (denormalized) rather than joined from `tickets` at report time — a
-- ticket row can in principle be edited/removed by the admin match editor
-- afterward, and a view event should still reflect what was actually shown
-- to the visitor at that moment, not whatever the ticket looks like today.
create table if not exists ticket_views (
  id bigint generated always as identity primary key,
  ticket_id text not null,
  tier text not null,
  session_id text, -- client-generated anon id (see src/lib/telemetry.ts), NOT a user identifier
  viewed_at timestamptz not null default now()
);

create index if not exists ticket_views_viewed_at_idx on ticket_views (viewed_at);
create index if not exists ticket_views_ticket_idx on ticket_views (ticket_id, viewed_at);
create index if not exists ticket_views_tier_idx on ticket_views (tier, viewed_at);

alter table ticket_views enable row level security;

grant insert on ticket_views to anon, authenticated;
grant select on ticket_views to authenticated;

drop policy if exists "anyone can log a ticket view" on ticket_views;
create policy "anyone can log a ticket view" on ticket_views for insert
  with check (true);

drop policy if exists "admins can read ticket_views" on ticket_views;
create policy "admins can read ticket_views" on ticket_views for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));

-- 15b. Satisfaction ratings — a simple 1–5 score, separate from the
-- free-text `feedback` table (section 16). `feedback` captures *what's
-- wrong*; this captures *a trackable number over time* for the audit
-- reports. Intentionally never merged with `feedback`.
create table if not exists satisfaction_ratings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null, -- null for anonymous raters
  score int not null check (score between 1 and 5),
  comment text,
  context text not null default 'general', -- e.g. 'general', 'ticket', 'checkout'
  created_at timestamptz not null default now()
);

create index if not exists satisfaction_ratings_created_idx on satisfaction_ratings (created_at);

alter table satisfaction_ratings enable row level security;

grant insert on satisfaction_ratings to anon, authenticated;
grant select on satisfaction_ratings to authenticated;

drop policy if exists "anyone can submit a satisfaction rating" on satisfaction_ratings;
create policy "anyone can submit a satisfaction rating" on satisfaction_ratings for insert
  with check (true);

drop policy if exists "admins can read satisfaction_ratings" on satisfaction_ratings;
create policy "admins can read satisfaction_ratings" on satisfaction_ratings for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));

-- 15c. Page load timing — client-measured, one row per page-load metric.
-- Real Vercel/GA4 infra-level uptime is NOT tracked here — "app status"
-- currently means checking the Actions tab for green generate-tickets /
-- grade-tickets runs directly (see the audit report's own status-note
-- section, scripts/lib/auditReport.mjs's formatAppStatusNote()).
create table if not exists page_perf (
  id bigint generated always as identity primary key,
  route text not null, -- e.g. '/'
  metric text not null default 'LCP', -- 'LCP' (Largest Contentful Paint) by default; room for others later
  load_ms int not null check (load_ms >= 0),
  session_id text,
  recorded_at timestamptz not null default now()
);

create index if not exists page_perf_recorded_idx on page_perf (recorded_at);
create index if not exists page_perf_route_idx on page_perf (route, recorded_at);

alter table page_perf enable row level security;

grant insert on page_perf to anon, authenticated;
grant select on page_perf to authenticated;

drop policy if exists "anyone can log page perf" on page_perf;
create policy "anyone can log page perf" on page_perf for insert
  with check (true);

drop policy if exists "admins can read page_perf" on page_perf;
create policy "admins can read page_perf" on page_perf for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 16. Feedback
-- ---------------------------------------------------------------------------
-- Customer support / feedback submissions, pre-filtered client-side
-- (src/lib/feedback.ts's prefilterFeedback — obvious spam only, not a
-- trained classifier) before landing here as 'pending'. Nothing is ever
-- shown publicly, or fed into the feedback digest
-- (scripts/analyze-feedback.mjs), without an admin moderating it to
-- 'approved' first.
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  email text,
  category text not null check (category in ('usability', 'performance', 'bug', 'support_request', 'general')),
  message text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  flagged_reason text,
  created_at timestamptz not null default now()
);

create index if not exists feedback_status_idx on feedback (status, created_at);

alter table feedback enable row level security;

grant insert on feedback to anon, authenticated;
grant select, update on feedback to authenticated;
grant select, insert, update, delete on feedback to service_role;

drop policy if exists "anyone can submit feedback" on feedback;
create policy "anyone can submit feedback" on feedback for insert
  with check (true);

drop policy if exists "user can read own feedback" on feedback;
create policy "user can read own feedback" on feedback for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from admins where user_id = auth.uid()));

drop policy if exists "admins can moderate feedback" on feedback;
create policy "admins can moderate feedback" on feedback for update to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()))
  with check (exists (select 1 from admins where user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 17. Self-improvement (bounded auto-tuning + model cross-check)
-- ---------------------------------------------------------------------------
-- Backs scripts/self-tune.mjs (writes), scripts/propose-improvements.mjs
-- (reads tuning_log/tuning_state), and the model-cross-check columns on
-- fixtures (written by scripts/lib/modelCrossCheck.mjs, read by
-- self-tune.mjs's sanity gate). Only ever written server-side via the
-- service-role key — no anon/authenticated policy needed.

alter table fixtures add column if not exists model_probability numeric;
alter table fixtures add column if not exists model_available boolean not null default false;
alter table fixtures add column if not exists bookmaker_count int;

-- Single row (id=1) holding the live value of every auto-tunable
-- parameter. Admin-readable so the UI/reports can show what's currently
-- live; written only by self-tune.mjs.
create table if not exists tuning_state (
  id int primary key default 1 check (id = 1),
  min_confidence int not null default 68,
  small_ticket_max_odds numeric not null default 1.77,
  saints_lock_min_confidence int not null default 85,
  last_tuned_reason text,
  updated_at timestamptz not null default now()
);

insert into tuning_state (id) values (1) on conflict (id) do nothing;

grant select on tuning_state to authenticated;
grant select, insert, update, delete on tuning_state to service_role;
alter table tuning_state enable row level security;
drop policy if exists "admins can read tuning_state" on tuning_state;
create policy "admins can read tuning_state" on tuning_state for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));

-- Append-only audit trail of every automatic change self-tune.mjs makes.
create table if not exists tuning_log (
  id bigint generated always as identity primary key,
  parameter text not null,
  old_value numeric not null,
  new_value numeric not null,
  direction text not null check (direction in ('up', 'down')),
  win_rate_before numeric,
  sample_size int,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists tuning_log_parameter_idx on tuning_log (parameter, created_at);

grant select on tuning_log to authenticated;
grant select, insert, update, delete on tuning_log to service_role;
alter table tuning_log enable row level security;
drop policy if exists "admins can read tuning_log" on tuning_log;
create policy "admins can read tuning_log" on tuning_log for select to authenticated
  using (exists (select 1 from admins where user_id = auth.uid()));
