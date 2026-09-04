-- ---------------------------------------------------------------------------
-- Odd Saint — migration 003
-- Run once in Supabase: Project → SQL Editor → New query → paste → Run.
-- Purely additive on top of schema.sql + migration 002 — no columns/tables
-- dropped or renamed, safe to apply to the existing production database.
--
-- Supports: an admin granting subscription or Saint's Lock access to
-- ANOTHER user without a real payment ("help someone subscribe through my
-- admin account"), plus an audit trail of who granted what to whom.
--
-- IMPORTANT — SECURITY BOUNDARY: this migration does NOT let any client,
-- including an admin's own authenticated browser session, write directly
-- to subscribers/saints_lock_access. Those tables still only ever get
-- written by the service-role key (see src/lib/grantAccess.ts) — exactly
-- the same boundary real payments already use. The new
-- /api/admin/grant-access route verifies the admin check server-side with
-- the service-role key, then calls the SAME grantAccessForPayment()
-- function real payments call — one single code path ever grants product
-- access, whether triggered by a payment webhook or an admin.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Email → user_id lookup, for the admin "grant access by email" flow.
-- ---------------------------------------------------------------------------
-- auth.users isn't exposed through the normal PostgREST API (Supabase
-- intentionally hides the auth schema from the public API) — this
-- SECURITY DEFINER function is the sanctioned way to resolve an email to a
-- user_id server-side. EXECUTE is granted ONLY to service_role — never to
-- anon or authenticated — so this is unreachable from any client-side
-- Supabase call, including an admin's own browser session. Only the
-- server-side API route (which authenticates using the service-role key)
-- can call it.
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
-- 2. Audit trail — every admin-granted access event, for accountability.
-- ---------------------------------------------------------------------------
-- Comping access is a real financial/security-relevant action even though
-- no money moves — this table exists purely so it's never invisible who
-- granted what to whom and when. Only ever written by the service-role
-- key (from the API route, right after a successful grant) — never
-- directly from any client.
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
