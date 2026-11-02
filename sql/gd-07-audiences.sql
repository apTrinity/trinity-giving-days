-- Giving Days project (main Supabase) - audiences (personalized form text) and last-year gifts.
-- Safe to run more than once. Adds columns to gd_donors and gd_settings, and creates gd_audiences
-- with two starter audiences (draft wording, editable in the admin).
--
-- An audience is a group of donors (same rule as a challenge: affiliations, grades, class years).
-- A donor sees the text of the first published audience, in order, that they match.

alter table public.gd_donors
  add column if not exists ly_gift numeric check (ly_gift is null or ly_gift >= 0);   -- last year's gift, used for the ask

alter table public.gd_settings
  add column if not exists ask_personalize boolean not null default true,              -- show levels near last year's gift only
  add column if not exists ask_steps       int     not null default 2 check (ask_steps between 1 and 5);  -- levels above and below

create table if not exists public.gd_audiences (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) between 1 and 60),
  tags           text[] not null default '{}',
  grades         text[] not null default '{}',
  class_year_min int check (class_year_min is null or class_year_min between 1900 and 2100),
  class_year_max int check (class_year_max is null or class_year_max between 1900 and 2100),
  class_years    int[]  not null default '{}',             -- specific class years (reunion classes); empty = no limit
  heading        text   not null default '' check (char_length(heading) <= 80),
  body           text   not null default '' check (char_length(body) <= 500),
  sort_order     int    not null default 0,
  published      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.gd_audiences enable row level security;
revoke all on public.gd_audiences from anon, authenticated;
grant select, insert, update, delete on public.gd_audiences to service_role;

-- Starter audiences (placeholder wording: edit in the admin)
insert into public.gd_audiences (name, tags, grades, class_years, heading, body, sort_order, published)
select 'Reunion alumni', '{alumni,alumna}', '{}',
       (select array_agg(y order by y) from generate_series(1946, 2021) y where y % 5 = 1),
       'Happy reunion, Class of {{class_year}}',
       '{{first_name}}, this year Trinity celebrates the 10th anniversary of the Reunion Giving Initiative. In honor of reunion and in gratitude for the Trinity experience, your gift today helps ensure that all qualified students, regardless of financial background, have access to a Trinity education.',
       0, true
where not exists (select 1 from public.gd_audiences where name = 'Reunion alumni');

insert into public.gd_audiences (name, tags, grades, class_years, heading, body, sort_order, published)
select 'Senior parents', '{current_parent}', '{12}', '{}',
       'Thank you, senior parents',
       '{{first_name}}, your family is in its final year at Trinity. A gift today supports the students who follow your child, and is part of the senior class parent community''s giving.',
       1, true
where not exists (select 1 from public.gd_audiences where name = 'Senior parents');
