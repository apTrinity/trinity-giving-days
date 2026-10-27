-- Giving Days project (main Supabase) - gifts, and the switches that decide which gifts count.
-- Safe to run more than once; touches only gd_settings (adds columns) and the new gd_gifts table.
--
-- A gift counts toward progress when:
--   it is not excluded, AND
--   it was made inside the counting window (gifts_count_from, or the campaign start, up to the campaign end), AND
--   it is a real gift, or test gifts are switched on (test_gifts_count).
-- Gifts that do not count are still recorded.

alter table public.gd_settings
  add column if not exists test_gifts_count boolean     not null default false,
  add column if not exists gifts_count_from timestamptz;            -- null = the campaign start (set it earlier for an early-bird period)

create table if not exists public.gd_gifts (
  id             uuid primary key default gen_random_uuid(),
  transaction_id text not null unique,                              -- BBMS transaction; also stops a gift being saved twice
  amount         numeric not null check (amount > 0),
  first_name     text,
  last_name      text,
  email          text,
  anonymous      boolean not null default false,
  is_test        boolean not null default false,                    -- made in test mode
  donor_id       uuid references public.gd_donors(id) on delete set null,  -- set when the gift came from a personal link or the email matches
  declared_tags  text[] not null default '{}',                      -- affiliations the donor ticked on the form
  grades         text[] not null default '{}',                      -- grades the donor ticked
  class_year     int check (class_year is null or class_year between 1900 and 2100),
  tags_added     text[] not null default '{}',                      -- admin edits for this gift
  tags_removed   text[] not null default '{}',
  excluded       boolean not null default false,                    -- admin switch: recorded but never counted
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists gd_gifts_created_idx on public.gd_gifts (created_at desc);
create index if not exists gd_gifts_email_idx   on public.gd_gifts (lower(email));

alter table public.gd_gifts enable row level security;
revoke all on public.gd_gifts from anon, authenticated;
grant select, insert, update, delete on public.gd_gifts to service_role;
