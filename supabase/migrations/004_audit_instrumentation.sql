-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of schema.sql + migrations 002/003 — no columns or
-- tables dropped or renamed, safe to apply to the existing production
-- database.
--
-- Adds the instrumentation needed for the weekly/quarterly/yearly audit
-- reports (see scripts/audit-weekly.mjs, audit-quarterly.mjs,
-- audit-yearly.mjs): ticket view events, a lightweight satisfaction
-- rating, and client-measured page load timing. Visitor counts, traffic
-- source, location, and age-band data are NOT stored here — those already
-- live in GA4 (see the GA4_MEASUREMENT_ID wiring in src/app/layout.tsx) and
-- are pulled directly from the GA4 Data API by scripts/lib/ga4.mjs at
-- report time, so there's no reason to duplicate them in Supabase.
--
-- All three tables here are insert-only from the browser (anon +
-- authenticated) — same "anyone can submit, only admins can read" pattern
-- already used for `feedback` in migration 002. The audit scripts
-- themselves read via the service-role key, which bypasses RLS entirely,
-- same as every other GitHub Actions script in this repo.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Ticket views — powers "most viewed tickets" and "high velocity time
--    periods" in the audit reports.
-- ---------------------------------------------------------------------------
-- tier and label are captured at insert time (denormalized) rather than
-- joined from `tickets` at report time — a ticket row can in principle be
-- edited/removed by the admin match editor afterward, and a view event
-- should still reflect what was actually shown to the visitor at that
-- moment, not whatever the ticket looks like today.
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

-- ---------------------------------------------------------------------------
-- 2. Satisfaction ratings — a simple 1–5 score, separate from the
--    free-text `feedback` table. `feedback` captures *what's wrong*;
--    this captures *a trackable number over time* for the audit reports.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 3. Page load timing — client-measured, one row per page-load metric.
--    Real Vercel/GA4 infra-level uptime is NOT tracked here (see the
--    "app status" gap noted in the audit scripts' honest-scope comments).
-- ---------------------------------------------------------------------------
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
