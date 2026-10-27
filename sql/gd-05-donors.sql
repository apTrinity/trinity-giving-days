-- Giving Days project (main Supabase) - donors for personalized links.
-- One row per person (spouses are separate rows). Filled by the RE import; the server uses
-- the service role only. Safe to run more than once.
--
-- token         random 6-character code used in the personalized link (lowercase, no look-alikes)
-- import_tags   tags set by the RE import (new_family, alumna, ...); rewritten on every re-import
-- tags_added    tags an admin added by hand;   tags_removed  tags an admin removed by hand
-- Effective tags = (import_tags + tags_added) - tags_removed, so a re-import never undoes admin edits.

create table if not exists public.gd_donors (
  id           uuid primary key default gen_random_uuid(),
  token        text not null unique check (token ~ '^[a-hj-km-np-z2-9]{6}$'),
  re_id        text not null unique,
  first_name   text,
  last_name    text,
  email        text,
  class_year   int check (class_year is null or class_year between 1900 and 2100),
  grades       text[] not null default '{}',
  import_tags  text[] not null default '{}',
  tags_added   text[] not null default '{}',
  tags_removed text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists gd_donors_email_idx on public.gd_donors (lower(email));

alter table public.gd_donors enable row level security;
revoke all on public.gd_donors from anon, authenticated;
grant select, insert, update, delete on public.gd_donors to service_role;
