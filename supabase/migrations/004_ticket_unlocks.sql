-- ---------------------------------------------------------------------------
-- Odd Saint — migration 004
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of schema.sql + migrations 002/003 — no columns/
-- tables dropped or renamed, safe to apply to the existing production
-- database.
--
-- Completes the per-ticket "Pay Micro-Fee" unlock product referenced by
-- TICKET_UNLOCK_PRICE_USD in src/lib/plans.ts and the ticket_unlock
-- product branch in src/app/api/checkout/route.ts — those were already
-- shipped assuming this migration existed; it didn't yet, which is why
-- pending_transactions.ticket_id and the 'ticket_unlock' product value
-- would have failed at the database level before this ran.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. pending_transactions — add ticket_id, widen the product check
-- ---------------------------------------------------------------------------
-- Nullable: only 'ticket_unlock' rows populate this; subscription/
-- saints_lock rows leave it null, same as every other product-specific
-- field this table doesn't universally need.
alter table pending_transactions add column if not exists ticket_id text references tickets(id) on delete cascade;

-- Postgres has no "alter check constraint" — drop and recreate under the
-- same name is the standard, safe way to widen an allowed-values list.
alter table pending_transactions drop constraint if exists pending_transactions_product_check;
alter table pending_transactions add constraint pending_transactions_product_check
  check (product in ('subscription', 'saints_lock', 'ticket_unlock'));

create index if not exists pending_transactions_ticket_idx on pending_transactions (ticket_id) where ticket_id is not null;

-- ---------------------------------------------------------------------------
-- 2. ticket_unlocks — one row per (user, ticket) that's been paid for
-- ---------------------------------------------------------------------------
-- Deliberately separate from subscribers/saints_lock_access: this is a
-- one-off, non-expiring unlock of a SPECIFIC ticket, not a dated plan.
-- Only ever written by grantAccessForPayment() via the service-role key
-- (src/lib/grantAccess.ts) — the exact same single-chokepoint pattern
-- subscribers/saints_lock_access already use, so a ticket-unlock payment
-- can only ever be granted through the one function that already handles
-- every other product.
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
