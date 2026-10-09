-- ---------------------------------------------------------------------------
-- Odd Saint — migration 006: email/password account signup
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Idempotent.
--
-- Adds username + country to user_profiles, a public username-availability
-- check, and a trigger that copies the signup metadata (username, country)
-- from auth.users into user_profiles. The trigger runs server-side, so it
-- works even when email confirmation means the browser has no session yet.
-- ---------------------------------------------------------------------------

alter table public.user_profiles add column if not exists username text;
alter table public.user_profiles add column if not exists country text; -- ISO 3166-1 alpha-2

-- Backstop uniqueness (case-insensitive). The UI pre-checks via
-- username_available() for a friendly error.
create unique index if not exists user_profiles_username_lower_idx
  on public.user_profiles (lower(username))
  where username is not null;

-- Callable by anon so the signup form can check before submitting. Returns
-- only a boolean — it cannot be used to read anyone's profile.
create or replace function public.username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1 from public.user_profiles where lower(username) = lower(p_username)
  );
$$;

revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- Copy signup metadata into user_profiles. Never blocks account creation:
-- on any failure it logs a warning and lets the signup through.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (user_id, email, username, country)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data->>'username', ''),
    nullif(upper(new.raw_user_meta_data->>'country'), '')
  )
  on conflict (user_id) do update
    set email    = coalesce(excluded.email, public.user_profiles.email),
        username = coalesce(excluded.username, public.user_profiles.username),
        country  = coalesce(excluded.country, public.user_profiles.country);
  return new;
exception when others then
  raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

grant select, insert, update, delete on public.user_profiles to service_role;
