-- ---------------------------------------------------------------------------
-- Odd Saint — migration 002
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of supabase/schema.sql — no columns/tables dropped
-- or renamed, safe to apply to the existing production database.
--
-- Covers:
--   1. Staggered ticket release (release_slot / available_at on `tickets`)
--   2. Admin match editor (write RLS for `ticket_matches` and `tickets`)
--   3. Customer support / moderated feedback (`feedback` table)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Staggered ticket release
-- ---------------------------------------------------------------------------
-- release_slot distinguishes "today's 1st slip" (0) from "today's 2nd slip"
-- (1) for a given tier — matches MAX_TICKETS_PER_CATEGORY = 2 in both
-- scripts/generate-tickets.mjs and src/lib/dataFetcher.ts.
-- available_at records exactly when that slip was written, so the frontend
-- can show "next batch at HH:MM" instead of guessing, and the generation
-- script can enforce a minimum real-world gap between slot 0 and slot 1
-- (see MIN_HOURS_BETWEEN_SLOTS in generate-tickets.mjs) so both slips of a
-- day can never land back-to-back.
alter table tickets add column if not exists release_slot int not null default 0;
alter table tickets add column if not exists available_at timestamptz not null default now();

create index if not exists tickets_release_idx on tickets (ticket_date, tier, release_slot);

-- ---------------------------------------------------------------------------
-- 2. Admin match editor
-- ---------------------------------------------------------------------------
-- Lets an admin (see `admins` table in schema.sql) attach/detach an
-- individual fixture on a specific ticket — e.g. pull a match they judge
-- too risky, or add one they consider a stronger pick. Same pattern
-- already used for `app_settings`: RLS is the actual security boundary,
-- not anything in the frontend.
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
-- 3. Customer support / moderated feedback
-- ---------------------------------------------------------------------------
-- Anyone (including anonymous visitors) can submit feedback. Nothing here
-- is ever shown publicly in-app automatically — every row starts 'pending'
-- and only an admin moving it to 'approved' would make it eligible for any
-- future public-facing surface (there isn't one yet). This is the "filter
-- before it's posted" boundary, enforced at the database level.
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
