-- Giving Days project (main Supabase) - tracking where gifts come from (QR codes, emails, posts).
-- Safe to run more than once. Run this BEFORE you hand out any link with ?src=... in it.
--
-- A link like  https://giving.trinityschoolnyc.org/preview?src=qr-flyer  carries its tag "qr-flyer"
-- through to the gift. gd_gifts.source remembers it; gd_visits counts how many times the page was opened
-- from each tag, so the admin can show visits, gifts and conversion per tag.

alter table public.gd_gifts add column if not exists source text;
create index if not exists gd_gifts_source_idx on public.gd_gifts (source) where source is not null;

create table if not exists public.gd_visits (
  id         bigint generated always as identity primary key,
  source     text not null,
  created_at timestamptz not null default now()
);
create index if not exists gd_visits_source_idx on public.gd_visits (source, created_at desc);

alter table public.gd_visits enable row level security;
revoke all on public.gd_visits from anon, authenticated;
grant select, insert, update, delete on public.gd_visits to service_role;
