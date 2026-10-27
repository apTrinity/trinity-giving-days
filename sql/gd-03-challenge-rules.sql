-- Giving Days project (main Supabase) - who a challenge counts.
-- Adds the rule to gd_challenges. Safe to run more than once; touches only that table.
--
-- Rule: a gift counts toward a challenge when
--   (tags is empty OR the gift has at least one of the tags)
--   AND (no class-year range OR the donor's class year is inside it).
-- An empty tags list means everyone counts.

alter table public.gd_challenges
  add column if not exists tags           text[] not null default '{}',
  add column if not exists class_year_min int,
  add column if not exists class_year_max int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gd_challenges_class_years_ok') then
    alter table public.gd_challenges
      add constraint gd_challenges_class_years_ok check (
        (class_year_min is null or class_year_min between 1900 and 2100)
        and (class_year_max is null or class_year_max between 1900 and 2100)
        and (class_year_min is null or class_year_max is null or class_year_min <= class_year_max)
      );
  end if;
end $$;

-- Existing grants and RLS on the table already cover the new columns.
