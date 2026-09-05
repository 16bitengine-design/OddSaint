-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of schema.sql + migrations 002/003 — no columns
-- or tables dropped or renamed, safe to apply to the existing production
-- database.
--
-- Supports: pay-per-ticket unlocking ("Pay Micro-Fee"). Previously this
-- button was a non-functional frontend stub that unlocked any ticket for
-- free by flipping local React state — no payment was ever taken, and
-- nothing was ever persisted. This migration adds a real, persisted,
-- paid-unlock record, following the exact same pattern already used by
-- `subscribers` and `saints_lock_access`.
-- ---------------------------------------------------------------------------

-- One row per (user, ticket) that's been individually unlocked via a
-- verified one-off payment. Only ever written by the service-role key
-- (see src/lib/grantAccess.ts), after a payment has been confirmed
-- directly with PawaPay or Pesapal — never on the client's say-so.
create table if not exists ticket_unlocks (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticket_id text not null references tickets(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  primary key (user_id, ticket_id)
);

alter table ticket_unlocks enable row level security;

grant select on ticket_unlocks to authenticated;
drop policy if exists "user can read own ticket_unlocks" on ticket_unlocks;
create policy "user can read own ticket_unlocks" on ticket_unlocks for select to authenticated
  using (user_id = auth.uid());

-- Deliberately NO insert/update/delete policy for anon/authenticated —
-- only the service-role key (which bypasses RLS entirely) ever writes
-- here, exactly the same boundary subscribers/saints_lock_access already
-- use. A user can read their own unlock rows but can never grant
-- themselves one directly.

-- ---------------------------------------------------------------------------
-- Extend pending_transactions to support the new 'ticket_unlock' product
-- and to record WHICH ticket a pending payment is for.
-- ---------------------------------------------------------------------------
alter table pending_transactions drop constraint if exists pending_transactions_product_check;
alter table pending_transactions add constraint pending_transactions_product_check
  check (product in ('subscription', 'saints_lock', 'ticket_unlock'));

alter table pending_transactions add column if not exists ticket_id text references tickets(id) on delete set null;
