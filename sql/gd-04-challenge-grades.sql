-- Giving Days project (main Supabase) - limit a challenge to parents of certain grades.
-- Safe to run more than once; touches only gd_challenges.
--
-- Extra rule: when grades is not empty, the gift must come from a current parent with a child
-- in at least one of those grades (K, 1 ... 12). An empty list means any grade.

alter table public.gd_challenges
  add column if not exists grades text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gd_challenges_grades_ok') then
    alter table public.gd_challenges
      add constraint gd_challenges_grades_ok check (
        grades <@ array['K','1','2','3','4','5','6','7','8','9','10','11','12']
      );
  end if;
end $$;
